import { Router } from 'express';
import { emailService, verifySmtpConfig } from '../../services/email.service';
import { authenticate, requireRole, requireSuperAdmin } from '../../middleware/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { badRequest, ok, notFound } from '../../utils/response';
import { query, queryOne } from '../../config/database';
import {
  getPlatformSmtpConfig,
  isPlatformSmtpConfigured,
  savePlatformSmtpConfig,
  sendPlatformEmail,
  verifyPlatformSmtp,
} from '../../services/platformEmail.service';

const router = Router();

// ---------------------------------------------------------------------------
// Platform mailbox
//
// Separate from the per-company configuration above, and deliberately so. A
// company's SMTP sends that company's own mail. This one sends the platform's:
// billing warnings to a customer's account owner, and the operator copy. Those
// must not depend on the customer having configured their own mail server -
// the failed-payment warning is exactly the message that must arrive when the
// customer's own setup is missing or broken.
//
// Super admin only, on every route: these are the platform's credentials, not
// any one tenant's.
// ---------------------------------------------------------------------------

/** The password is never returned; the client shows whether one is stored. */
function publicPlatformConfig(cfg: Awaited<ReturnType<typeof getPlatformSmtpConfig>>) {
  return {
    smtpHost: cfg.smtpHost,
    smtpPort: cfg.smtpPort,
    smtpUser: cfg.smtpUser,
    smtpFrom: cfg.smtpFrom,
    billingAlertEmail: cfg.billingAlertEmail,
    hasPassword: cfg.smtpPass !== '',
    configured: isPlatformSmtpConfigured(cfg),
    verifiedAt: cfg.verifiedAt,
    lastError: cfg.lastError,
    updatedAt: cfg.updatedAt,
    /**
     * Whether an operator copy address is set. Shown separately because a
     * perfectly working mailbox with no alert address still means Francesco
     * never hears about a failed payment.
     */
    hasAlertEmail: cfg.billingAlertEmail.trim() !== '',
  };
}

router.get(
  '/platform-config',
  authenticate,
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    ok(res, publicPlatformConfig(await getPlatformSmtpConfig()));
  })
);

router.put(
  '/platform-config',
  authenticate,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body as any;
    const smtpHost = String(body.smtp_host ?? body.smtpHost ?? '').trim();
    const smtpUser = String(body.smtp_user ?? body.smtpUser ?? '').trim();
    const smtpFrom = String(body.smtp_from ?? body.smtpFrom ?? '').trim();
    const billingAlertEmail = String(
      body.billing_alert_email ?? body.billingAlertEmail ?? ''
    ).trim();
    const rawPass = body.smtp_pass ?? body.smtpPass;
    const rawPort = body.smtp_port ?? body.smtpPort;

    if (!smtpHost) {
      badRequest(res, 'smtp_host is required', 'VALIDATION_ERROR');
      return;
    }
    if (!smtpUser) {
      badRequest(res, 'smtp_user is required', 'VALIDATION_ERROR');
      return;
    }

    const port = Number.parseInt(String(rawPort ?? '587'), 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      badRequest(res, 'smtp_port must be a valid port number', 'VALIDATION_ERROR');
      return;
    }

    // An empty password field means "leave the stored one alone", so an admin
    // can correct the From address without retyping a secret they cannot read
    // back. A first save with no password is rejected instead, because that
    // would store a mailbox that cannot send.
    const existing = await getPlatformSmtpConfig();
    const smtpPass =
      typeof rawPass === 'string' && rawPass !== '' ? rawPass : existing.smtpPass;
    if (!smtpPass) {
      badRequest(res, 'smtp_pass is required', 'VALIDATION_ERROR');
      return;
    }

    const saved = await savePlatformSmtpConfig({
      smtpHost,
      smtpPort: port,
      smtpUser,
      smtpPass,
      smtpFrom,
      billingAlertEmail,
    });

    ok(res, publicPlatformConfig(saved), 'Platform SMTP configuration saved');
  })
);

/** Proves the credentials work, and records that it was proved. */
router.post(
  '/platform-verify',
  authenticate,
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    const result = await verifyPlatformSmtp();
    ok(res, { ...result, config: publicPlatformConfig(await getPlatformSmtpConfig()) });
  })
);

/**
 * Sends a real message through the platform mailbox.
 *
 * Verifying only proves the server accepts the credentials; it does not prove
 * a message arrives, which is the thing an operator actually needs to know
 * before a customer's dunning notice depends on it.
 */
router.post(
  '/platform-test',
  authenticate,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const to = String((req.body as any)?.to ?? '').trim();
    if (!to) {
      badRequest(res, 'Campo "to" obbligatorio', 'VALIDATION_ERROR');
      return;
    }

    const result = await sendPlatformEmail(
      {
        to,
        subject: '[TEST] VeylOHR - configurazione email piattaforma',
        html:
          '<p>Questa &egrave; una email di prova inviata dalla casella della piattaforma VeylOHR.</p>' +
          '<p>Se la stai leggendo, la configurazione SMTP della piattaforma funziona e gli avvisi ' +
          'di pagamento non riuscito verranno recapitati.</p>',
        text:
          "Questa e' una email di prova inviata dalla casella della piattaforma VeylOHR.\n\n" +
          "Se la stai leggendo, la configurazione SMTP della piattaforma funziona e gli avvisi " +
          'di pagamento non riuscito verranno recapitati.',
      },
      // No company fallback: this test exists to prove the platform mailbox
      // specifically, and a success delivered by someone else's server would
      // be a false pass.
      null
    );

    ok(res, {
      sent: result.ok,
      status: result.status,
      transport: result.transport,
      error: result.ok ? null : result.message ?? null,
    });
  })
);

// ---------------------------------------------------------------------------
// Health check (legacy — uses .env SMTP)
// ---------------------------------------------------------------------------

router.get('/health', (_req, res) => {
  ok(res, {
    configured: Boolean(process.env.SMTP_HOST),
  });
});

// ---------------------------------------------------------------------------
// Test email (legacy — uses .env SMTP)
// ---------------------------------------------------------------------------

router.post('/test', authenticate, requireSuperAdmin, asyncHandler(async (req, res) => {
  const { to, subject, html } = req.body as { to?: unknown; subject?: unknown; html?: unknown };

  if (typeof to !== 'string' || to.trim() === '') {
    badRequest(res, 'Campo "to" obbligatorio', 'VALIDATION_ERROR');
    return;
  }

  const finalSubject = typeof subject === 'string' && subject.trim() !== ''
    ? subject.trim()
    : 'Test email HR System';

  const finalHtml = typeof html === 'string' && html.trim() !== ''
    ? html
    : '<p>Email di test inviata dal backend HR System.</p>';

  await emailService.send({
    companyId: req.user!.companyId || undefined,
    to: to.trim(),
    subject: finalSubject,
    html: finalHtml,
    text: finalHtml.replace(/<[^>]+>/g, ''),
  });

  ok(res, { sent: true }, 'Email di test inviata');
}));

// ---------------------------------------------------------------------------
// GET /api/email/config
// Returns the SMTP config for the logged-in user's company.
// Super Admins have no company → returns basic flag unless company_id is provided.
// ---------------------------------------------------------------------------

router.get('/config', authenticate, requireRole('admin', 'hr'), asyncHandler(async (req, res) => {
  const user = req.user!;
  const targetCompanyIdStr = req.query.company_id as string | undefined;

  if (user.is_super_admin && !targetCompanyIdStr) {
    ok(res, { superAdmin: true, company: null, config: null });
    return;
  }

  const companyId = user.is_super_admin && targetCompanyIdStr
    ? parseInt(targetCompanyIdStr, 10)
    : user.companyId;

  if (!companyId) {
    notFound(res, 'Company not found');
    return;
  }

  // Also fetch company name for the header
  const company = await queryOne<{ id: number; name: string }>(
    `SELECT id, name FROM companies WHERE id = $1 LIMIT 1`,
    [companyId],
  );

  const cfg = await queryOne<{
    smtp_host: string;
    smtp_port: number;
    smtp_user: string;
    smtp_pass: string;
    smtp_from: string;
  }>(
    `SELECT smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from
     FROM company_smtp_configs
     WHERE company_id = $1
     LIMIT 1`,
    [companyId],
  );

  let returnedConfig = null;
  if (cfg) {
    if (user.is_super_admin) {
      returnedConfig = cfg;
    } else {
      returnedConfig = {
        smtp_host: cfg.smtp_host,
        smtp_port: cfg.smtp_port,
        smtp_from: cfg.smtp_from,
        smtp_user: '',
        smtp_pass: '',
      };
    }
  }

  ok(res, {
    superAdmin: !!user.is_super_admin,
    company: company ? { id: company.id, name: company.name } : null,
    config: returnedConfig,
  });
}));

// ---------------------------------------------------------------------------
// PUT /api/email/config
// Upserts (insert or update) the SMTP config for the caller's company.
// ---------------------------------------------------------------------------

router.put('/config', authenticate, requireSuperAdmin, asyncHandler(async (req, res) => {
  const user = req.user!;
  const body = req.body as any;

  const targetCompanyId = user.is_super_admin
    ? (body.companyId || body.company_id || (req.query.company_id ? parseInt(req.query.company_id as string, 10) : null))
    : user.companyId;

  if (!targetCompanyId) {
    badRequest(res, 'Company ID is required', 'VALIDATION_ERROR');
    return;
  }

  const companyId = typeof targetCompanyId === 'string' ? parseInt(targetCompanyId, 10) : targetCompanyId;


  const smtp_host = (body.smtp_host || body.smtpHost) as string | undefined;
  const smtp_port = body.smtp_port ?? body.smtpPort;
  const smtp_user = (body.smtp_user || body.smtpUser) as string | undefined;
  const smtp_pass = (body.smtp_pass || body.smtpPass) as string | undefined;
  const smtp_from = (body.smtp_from || body.smtpFrom) as string | undefined;

  if (!smtp_host || typeof smtp_host !== 'string' || smtp_host.trim() === '') {
    badRequest(res, 'smtp_host is required', 'VALIDATION_ERROR');
    return;
  }
  if (!smtp_user || typeof smtp_user !== 'string' || smtp_user.trim() === '') {
    badRequest(res, 'smtp_user is required', 'VALIDATION_ERROR');
    return;
  }
  if (!smtp_pass || typeof smtp_pass !== 'string' || smtp_pass.trim() === '') {
    badRequest(res, 'smtp_pass is required', 'VALIDATION_ERROR');
    return;
  }
  if (!smtp_from || typeof smtp_from !== 'string' || smtp_from.trim() === '') {
    badRequest(res, 'smtp_from is required', 'VALIDATION_ERROR');
    return;
  }

  const port = typeof smtp_port === 'number'
    ? smtp_port
    : parseInt(String(smtp_port ?? '587'), 10);

  await query(
    `INSERT INTO company_smtp_configs
       (company_id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (company_id) DO UPDATE
       SET smtp_host  = EXCLUDED.smtp_host,
           smtp_port  = EXCLUDED.smtp_port,
           smtp_user  = EXCLUDED.smtp_user,
           smtp_pass  = EXCLUDED.smtp_pass,
           smtp_from  = EXCLUDED.smtp_from,
           updated_at = NOW()`,
    [companyId, smtp_host.trim(), port, smtp_user.trim(), smtp_pass.trim(), smtp_from.trim()],
  );

  ok(res, { saved: true }, 'SMTP configuration saved');
}));

// ---------------------------------------------------------------------------
// POST /api/email/verify
// Verifies connection and authentication for the saved configuration.
// ---------------------------------------------------------------------------

router.post('/verify', authenticate, requireSuperAdmin, asyncHandler(async (req, res) => {
  const user = req.user!;
  const body = req.body as any;

  const targetCompanyId = user.is_super_admin
    ? (body.companyId || body.company_id || (req.query.company_id ? parseInt(req.query.company_id as string, 10) : null))
    : user.companyId;

  if (!targetCompanyId) {
    badRequest(res, 'Company ID is required', 'VALIDATION_ERROR');
    return;
  }

  const companyId = typeof targetCompanyId === 'string' ? parseInt(targetCompanyId, 10) : targetCompanyId;

  const cfg = await queryOne<{
    smtp_host: string;
    smtp_port: number;
    smtp_user: string;
    smtp_pass: string;
  }>(
    `SELECT smtp_host, smtp_port, smtp_user, smtp_pass
     FROM company_smtp_configs
     WHERE company_id = $1
     LIMIT 1`,
    [companyId],
  );

  if (!cfg) {
    badRequest(res, 'No saved SMTP configuration found for this company', 'VALIDATION_ERROR');
    return;
  }

  const isValid = await verifySmtpConfig({
    smtpHost: cfg.smtp_host,
    smtpPort: cfg.smtp_port,
    smtpUser: cfg.smtp_user,
    smtpPass: cfg.smtp_pass,
  });

  ok(res, { success: isValid });
}));

export default router;
