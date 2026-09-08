import nodemailer from 'nodemailer';
import { pool } from '../config/database';
import { EmailOptions, EmailSendResult, sendEmailForCompany } from './email.service';

/**
 * The platform's own mailbox.
 *
 * Everything else in this system sends mail *as a company*: a leave approval,
 * a shift change, a document reminder. Those belong to the customer and go
 * through the customer's SMTP server, which is correct.
 *
 * Billing mail is different. "Your subscription payment failed, settle it by
 * Friday" is VeylOHR writing to its customer. Sending that through the
 * customer's own mail server has two failure modes that both hurt exactly when
 * it matters:
 *
 *   - the customer has no SMTP configured, so the one warning that their
 *     service is about to stop is the one email that never leaves;
 *   - the operator's copy cannot be sent at all, because that address belongs
 *     to neither the platform nor the customer's mail domain.
 *
 * So the platform gets its own credentials, configured once by the super admin
 * in Impostazioni > Email > Piattaforma.
 *
 * The company transport stays as a fallback. Without it, deploying this change
 * would silently stop billing mail for anyone who has company SMTP working and
 * has not filled the platform form in yet. Which transport actually carried a
 * message is reported back and shown in the UI, so "it was sent" is never
 * ambiguous about who sent it.
 */

export interface PlatformSmtpConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  /** Comma-separated operator addresses copied on every failed payment. */
  billingAlertEmail: string;
  verifiedAt: Date | null;
  lastError: string | null;
  updatedAt: Date | null;
}

/** A send result that also says which mailbox carried it. */
export interface PlatformEmailResult extends EmailSendResult {
  transport: 'platform' | 'company' | 'none';
}

const EMPTY: PlatformSmtpConfig = {
  smtpHost: '',
  smtpPort: 587,
  smtpUser: '',
  smtpPass: '',
  smtpFrom: '',
  billingAlertEmail: '',
  verifiedAt: null,
  lastError: null,
  updatedAt: null,
};

function rowToConfig(row: any): PlatformSmtpConfig {
  return {
    smtpHost: row.smtp_host || '',
    smtpPort: row.smtp_port || 587,
    smtpUser: row.smtp_user || '',
    smtpPass: row.smtp_pass || '',
    smtpFrom: row.smtp_from || '',
    billingAlertEmail: row.billing_alert_email || '',
    verifiedAt: row.verified_at ? new Date(row.verified_at) : null,
    lastError: row.last_error || null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null,
  };
}

/** Reads the single configuration row. Never throws. */
export async function getPlatformSmtpConfig(): Promise<PlatformSmtpConfig> {
  try {
    const res = await pool.query(`SELECT * FROM platform_smtp_config WHERE id = 1 LIMIT 1`);
    if (res.rowCount) return rowToConfig(res.rows[0]);
  } catch (err: any) {
    // A missing table means the migration has not run. The app must still boot
    // and must still fall back to the company transport.
    console.warn('[PlatformEmail] Could not read the platform SMTP config:', err?.message || err);
  }
  return { ...EMPTY };
}

/** Host, user and password are the three that must all be present to send. */
export function isPlatformSmtpConfigured(cfg: PlatformSmtpConfig): boolean {
  return !!(cfg.smtpHost.trim() && cfg.smtpUser.trim() && cfg.smtpPass.trim());
}

export async function savePlatformSmtpConfig(input: {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  billingAlertEmail: string;
}): Promise<PlatformSmtpConfig> {
  const res = await pool.query(
    `UPDATE platform_smtp_config
        SET smtp_host           = $1,
            smtp_port           = $2,
            smtp_user           = $3,
            smtp_pass           = $4,
            smtp_from           = $5,
            billing_alert_email = $6,
            -- Any credential change invalidates the previous proof that they
            -- work, so the page stops claiming "verified" until it is re-run.
            verified_at         = NULL,
            last_error          = NULL,
            updated_at          = NOW()
      WHERE id = 1
      RETURNING *`,
    [
      input.smtpHost.trim(),
      input.smtpPort,
      input.smtpUser.trim(),
      input.smtpPass,
      input.smtpFrom.trim(),
      input.billingAlertEmail.trim(),
    ]
  );

  if (!res.rowCount) {
    // The seed row is created by the migration; recreate it rather than fail.
    const inserted = await pool.query(
      `INSERT INTO platform_smtp_config
         (id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, billing_alert_email)
       VALUES (1, $1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET smtp_host = EXCLUDED.smtp_host
       RETURNING *`,
      [
        input.smtpHost.trim(),
        input.smtpPort,
        input.smtpUser.trim(),
        input.smtpPass,
        input.smtpFrom.trim(),
        input.billingAlertEmail.trim(),
      ]
    );
    return rowToConfig(inserted.rows[0]);
  }

  return rowToConfig(res.rows[0]);
}

function buildTransport(cfg: PlatformSmtpConfig): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    family: 4,
  } as any);
}

/**
 * Proves the stored credentials actually work.
 *
 * Records the outcome on the row so the page can distinguish "credentials are
 * filled in" from "credentials were proved to work", which is the difference
 * between a form that looks complete and a mailbox that sends.
 */
export async function verifyPlatformSmtp(): Promise<{ ok: boolean; error: string | null }> {
  const cfg = await getPlatformSmtpConfig();
  if (!isPlatformSmtpConfigured(cfg)) {
    return { ok: false, error: 'Platform SMTP is not configured (host, user and password are required).' };
  }

  // 465 and 587 are the two ports providers disagree about, and picking the
  // wrong one is the single most common misconfiguration here.
  const ports = Array.from(new Set([cfg.smtpPort, cfg.smtpPort === 587 ? 465 : 587]));
  let lastError = 'Unknown SMTP failure';

  for (const port of ports) {
    try {
      await buildTransport({ ...cfg, smtpPort: port }).verify();
      await pool.query(
        `UPDATE platform_smtp_config
            SET verified_at = NOW(), last_error = NULL, smtp_port = $1, updated_at = NOW()
          WHERE id = 1`,
        [port]
      );
      return { ok: true, error: null };
    } catch (err: any) {
      lastError = err?.message || String(err);
    }
  }

  await pool.query(
    `UPDATE platform_smtp_config SET verified_at = NULL, last_error = $1, updated_at = NOW() WHERE id = 1`,
    [lastError]
  );
  return { ok: false, error: lastError };
}

/**
 * Sends one email as the platform.
 *
 * `companyId` is only the fallback route: when the platform mailbox is not
 * configured, the message still goes out through that company's own SMTP
 * rather than being dropped. Pass null to refuse the fallback - used for the
 * operator copy, which must never be sent from a customer's mail server.
 */
export async function sendPlatformEmail(
  options: EmailOptions,
  fallbackCompanyId: number | null
): Promise<PlatformEmailResult> {
  const cfg = await getPlatformSmtpConfig();

  if (isPlatformSmtpConfigured(cfg)) {
    const ports = Array.from(new Set([cfg.smtpPort, cfg.smtpPort === 587 ? 465 : 587]));
    let lastError = 'Unknown SMTP failure';

    for (const port of ports) {
      try {
        await buildTransport({ ...cfg, smtpPort: port }).sendMail({
          from: cfg.smtpFrom || cfg.smtpUser,
          to: options.to,
          subject: options.subject,
          html: options.html,
          text: options.text,
          attachments: options.attachments,
        });
        console.log(`[PlatformEmail] Sent to ${options.to} via ${cfg.smtpHost}:${port}`);
        return { ok: true, status: 'sent', portTried: port, transport: 'platform' };
      } catch (err: any) {
        lastError = err?.message || String(err);
        console.error(
          `[PlatformEmail] Send to ${options.to} failed via ${cfg.smtpHost}:${port}: ${lastError}`
        );
      }
    }

    // Configured but refusing to send. Falling back to the customer's server
    // here would hide a broken platform mailbox behind an address the customer
    // does not expect, so the failure is reported instead.
    return { ok: false, status: 'failed', message: lastError, transport: 'platform' };
  }

  if (fallbackCompanyId) {
    const result = await sendEmailForCompany(fallbackCompanyId, options);
    return { ...result, transport: 'company' };
  }

  return {
    ok: false,
    status: 'skipped',
    message: 'Platform SMTP is not configured.',
    transport: 'none',
  };
}
