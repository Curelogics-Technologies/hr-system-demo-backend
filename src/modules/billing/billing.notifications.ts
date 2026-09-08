import { pool } from '../../config/database';
import { EmailSendResult } from '../../services/email.service';
import {
  getPlatformSmtpConfig,
  sendPlatformEmail,
  PlatformEmailResult,
} from '../../services/platformEmail.service';
import { sendNotification } from '../notifications/notifications.service';

/**
 * What happens when a renewal fails.
 *
 * A failed renewal starts a short grace period and then blocks the company, so
 * the one thing that must not happen is the customer finding out by losing
 * access. Three things leave here:
 *
 *   - an in-app notification to the account owner and every admin, so the
 *     alert is visible even when email is not configured at all;
 *   - an email to the account owner carrying the date the payment has to be
 *     settled by;
 *   - a copy to the platform operator, so they can reach the customer before
 *     the block lands.
 *
 * Every one of them reports its outcome back to the caller, which records it
 * on the failed transaction. "The customer was emailed" is a claim the billing
 * page has to be able to *show*, not one it should be believed on - a company
 * with no SMTP configuration sends nothing at all, and that has to be visible
 * rather than assumed away.
 */

/** How one delivery attempt ended. */
export type NoticeChannelStatus = 'sent' | 'skipped' | 'failed' | 'no_recipient';

export interface NoticeDelivery {
  /** Who the owner warning was addressed to (may include the company mailbox). */
  ownerEmail: string | null;
  ownerStatus: NoticeChannelStatus;
  ownerError: string | null;
  /**
   * Which mailbox carried it: the platform's own, or a fallback through the
   * customer's SMTP server. Only meaningful once both exist, and worth showing
   * because "sent" from the wrong address is its own kind of wrong.
   */
  ownerTransport: 'platform' | 'company' | 'none' | null;
  /** The operator copy. Null status when no operator address is configured. */
  copyTo: string | null;
  copyStatus: NoticeChannelStatus | null;
  /** How many people the in-app notification reached. */
  inAppCount: number;
  sentAt: Date;
}

/**
 * Where the platform operator wants to be copied.
 *
 * Configured in Impostazioni > Email > Piattaforma so it can be changed without
 * a redeploy; `BILLING_ALERT_EMAIL` stays as a fallback for deployments that
 * set it before the settings page existed.
 */
async function operatorRecipients(): Promise<string[]> {
  let configured = '';
  try {
    configured = (await getPlatformSmtpConfig()).billingAlertEmail;
  } catch {
    // The env fallback below is the whole point of not throwing here.
  }
  const raw = configured.trim() || process.env.BILLING_ALERT_EMAIL || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function appBaseUrl(): string {
  const raw =
    process.env.APP_BASE_URL ??
    process.env.FRONTEND_URL ??
    process.env.PUBLIC_APP_URL ??
    process.env.CORS_ORIGIN?.split(',')[0];
  return (raw && raw.trim() !== '' ? raw : 'http://localhost:5173').replace(/\/+$/, '');
}

function formatDateIt(d: Date | null): string {
  if (!d) return '-';
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatMoney(cents: number | null | undefined, currency: string): string {
  const amount = ((cents ?? 0) / 100).toFixed(2);
  return currency === 'EUR' ? `€${amount}` : `${currency} ${amount}`;
}

/** Turns the mailer's result into the status stored on the transaction. */
function statusOf(result: EmailSendResult): NoticeChannelStatus {
  if (result.ok) return 'sent';
  return result.status === 'skipped' ? 'skipped' : 'failed';
}

/**
 * A human sentence for why nothing was sent.
 *
 * "skipped" on its own reads as though the system chose not to bother. The
 * operator needs to know which mailbox is missing, because that is the thing
 * they have to go and fill in.
 */
function explain(result: PlatformEmailResult): string | null {
  if (result.ok) return null;
  if (result.transport === 'none') {
    return 'Platform SMTP is not configured (Impostazioni > Email > Piattaforma).';
  }
  if (result.status === 'skipped') {
    return result.message ?? 'No SMTP configuration available for this company.';
  }
  return result.message ?? 'The mail server refused the message.';
}

export interface FailureRecipients {
  /** The account owner - the person the warning is addressed to. */
  owner: { userId: number; email: string; name: string } | null;
  /** The company's generic mailbox, when it is a different address. */
  companyEmail: string | null;
  /** Everyone who should see the in-app alert: the owner and every admin. */
  inAppUserIds: number[];
}

/**
 * Who to warn, in the order the client asked for: the account owner first.
 *
 * `companies.owner_user_id` is the owner proper. When a company has none
 * recorded - it predates ownership, or the owner's user was removed - the
 * oldest active admin is the closest equivalent and is used instead, because
 * warning the wrong administrator beats warning nobody. The generic company
 * address is only ever a copy, never a replacement.
 *
 * The in-app alert goes wider than the email on purpose: it costs nothing, it
 * cannot bounce, and an admin who logs in is the person most likely to act.
 */
export async function resolveFailureRecipients(companyId: number): Promise<FailureRecipients> {
  const res = await pool.query(
    `SELECT c.company_email,
            o.id      AS owner_id,
            o.email   AS owner_email,
            o.name    AS owner_name,
            o.surname AS owner_surname,
            a.id      AS admin_id,
            a.email   AS admin_email,
            a.name    AS admin_name,
            a.surname AS admin_surname
       FROM companies c
       LEFT JOIN users o ON o.id = c.owner_user_id AND o.status = 'active'
       LEFT JOIN LATERAL (
            SELECT u.id, u.email, u.name, u.surname
              FROM users u
             WHERE u.company_id = c.id
               AND u.role = 'admin'
               AND u.status = 'active'
             ORDER BY u.id
             LIMIT 1
       ) a ON true
      WHERE c.id = $1`,
    [companyId]
  );

  if (!res.rowCount) return { owner: null, companyEmail: null, inAppUserIds: [] };

  const row = res.rows[0];
  const usingOwner = !!row.owner_email;
  const email = row.owner_email || row.admin_email || null;
  const userId = usingOwner ? row.owner_id : row.admin_id;
  const name = usingOwner
    ? [row.owner_name, row.owner_surname].filter(Boolean).join(' ')
    : [row.admin_name, row.admin_surname].filter(Boolean).join(' ');

  const admins = await pool.query(
    `SELECT id FROM users
      WHERE company_id = $1 AND role = 'admin' AND status = 'active'`,
    [companyId]
  );

  const inAppUserIds = Array.from(
    new Set<number>([
      ...(row.owner_id ? [row.owner_id as number] : []),
      ...admins.rows.map((r: any) => r.id as number),
    ])
  );

  return {
    owner: email && userId ? { userId, email, name: name || email } : null,
    companyEmail: row.company_email || null,
    inAppUserIds,
  };
}

export interface PaymentFailedNotice {
  companyId: number;
  companyName: string;
  provider: string;
  amountCents?: number | null;
  currency: string;
  /** The date by which the payment has to be settled. */
  gracePeriodEndsAt: Date;
  graceDays: number;
  failureMessage?: string | null;
  /**
   * A rehearsal: identical recipients, wording and transport, marked as a test
   * so nobody mistakes it for a real dunning notice. Used by the "send a test"
   * button so the whole path can be proved before a live customer depends on it.
   */
  isTest?: boolean;
}

/**
 * Sends the failed-payment alert on every channel and reports what happened.
 *
 * Never throws: a mail server being unreachable must not fail the webhook that
 * recorded the failure, or the provider retries the whole event and the
 * subscription state is written twice.
 */
export async function sendPaymentFailedNotices(
  notice: PaymentFailedNotice
): Promise<NoticeDelivery> {
  const deadline = formatDateIt(notice.gracePeriodEndsAt);
  const billingUrl = `${appBaseUrl()}/impostazioni/fatturazione`;
  const amount = formatMoney(notice.amountCents, notice.currency);
  const amountLine = notice.amountCents ? ` (importo: ${amount})` : '';
  const testTag = notice.isTest ? '[TEST] ' : '';
  const testNoteHtml = notice.isTest
    ? `<p style="padding:8px;background:#fef3c7;border:1px solid #f59e0b">
         <strong>Questo &egrave; un messaggio di prova.</strong> Nessun pagamento &egrave;
         stato rifiutato e nessun accesso sar&agrave; sospeso.
       </p>`
    : '';
  const testNoteText = notice.isTest
    ? "ATTENZIONE: questo e' un messaggio di prova. Nessun pagamento e' stato rifiutato.\n\n"
    : '';

  const delivery: NoticeDelivery = {
    ownerEmail: null,
    ownerStatus: 'no_recipient',
    ownerError: null,
    ownerTransport: null,
    copyTo: null,
    copyStatus: null,
    inAppCount: 0,
    sentAt: new Date(),
  };

  let recipients: FailureRecipients = { owner: null, companyEmail: null, inAppUserIds: [] };
  try {
    recipients = await resolveFailureRecipients(notice.companyId);
  } catch (err: any) {
    delivery.ownerError = `Could not resolve recipients: ${err?.message || err}`;
    console.error(`[Billing] ${delivery.ownerError}`);
    return delivery;
  }

  // ---------------------------------------------------------------------
  // 1. In-app alert. First, because it is the channel that cannot bounce.
  // ---------------------------------------------------------------------
  const inAppTitle = notice.isTest
    ? 'Prova: avviso di pagamento non riuscito'
    : 'Pagamento non riuscito';
  const inAppMessage = notice.isTest
    ? `Messaggio di prova. In un caso reale l'accesso verrebbe sospeso il ${deadline}.`
    : `Il rinnovo dell'abbonamento non è andato a buon fine. Regolarizza il pagamento entro il ${deadline} per non perdere l'accesso.`;

  for (const userId of recipients.inAppUserIds) {
    try {
      await sendNotification({
        companyId: notice.companyId,
        userId,
        type: 'billing.payment_failed',
        title: inAppTitle,
        message: inAppMessage,
        priority: 'urgent',
        // In-app only: the email below is written for this specific purpose and
        // addressed to the owner, so routing it through the generic notification
        // mailer as well would send two different emails about one failure.
        channels: ['in_app'],
        // A company must not be able to switch off the warning that its service
        // is about to stop.
        skipSettingsCheck: true,
        metadata: {
          link: '/impostazioni/fatturazione',
          gracePeriodEndsAt: notice.gracePeriodEndsAt.toISOString(),
          amountCents: notice.amountCents ?? null,
          currency: notice.currency,
          provider: notice.provider,
          isTest: notice.isTest === true,
        },
      });
      delivery.inAppCount++;
    } catch (err: any) {
      // sendNotification already swallows its own errors; this is belt and
      // braces so one bad recipient cannot stop the others being told.
      console.error(
        `[Billing] In-app payment-failure alert failed for user ${userId}:`,
        err?.message || err
      );
    }
  }

  // ---------------------------------------------------------------------
  // 2. The owner's email, with the settle-by date.
  // ---------------------------------------------------------------------
  const { owner, companyEmail } = recipients;

  if (!owner) {
    delivery.ownerError = 'No account owner or active admin with an email address.';
    console.warn(
      `[Billing] Payment failed for company ${notice.companyId} but no owner or admin address could be resolved.`
    );
  } else {
    const html =
      testNoteHtml +
      `<p>Gentile ${owner.name},</p>` +
      `<p>Il rinnovo automatico dell'abbonamento VeylOHR per <strong>${notice.companyName}</strong> ` +
      `non &egrave; andato a buon fine${notice.amountCents ? ` (importo: <strong>${amount}</strong>)` : ''}.</p>` +
      `<p>Per non interrompere il servizio &egrave; necessario regolarizzare il pagamento ` +
      `<strong>entro il ${deadline}</strong>. Dopo tale data l'accesso alla piattaforma sar&agrave; sospeso.</p>` +
      `<p>Puoi aggiornare il metodo di pagamento e completare il pagamento da qui:<br>` +
      `<a href="${billingUrl}">${billingUrl}</a></p>` +
      `<p>Se il pagamento &egrave; gi&agrave; stato effettuato puoi ignorare questo messaggio.</p>` +
      `<p>Cordiali saluti,<br>Team VeylOHR</p>`;

    const text =
      testNoteText +
      `Gentile ${owner.name},\n\n` +
      `Il rinnovo automatico dell'abbonamento VeylOHR per ${notice.companyName} non e' andato a buon fine${amountLine}.\n\n` +
      `Per non interrompere il servizio e' necessario regolarizzare il pagamento entro il ${deadline}. ` +
      `Dopo tale data l'accesso alla piattaforma sara' sospeso.\n\n` +
      `Aggiorna il metodo di pagamento qui: ${billingUrl}\n\n` +
      `Se il pagamento e' gia' stato effettuato puoi ignorare questo messaggio.\n\n` +
      `Cordiali saluti,\nTeam VeylOHR`;

    // The owner is the addressee; the generic company mailbox is copied only
    // when it is a different address, so nobody receives the same mail twice.
    const to =
      companyEmail && companyEmail.toLowerCase() !== owner.email.toLowerCase()
        ? `${owner.email}, ${companyEmail}`
        : owner.email;

    delivery.ownerEmail = to;

    try {
      // Sent as the platform, because that is who is writing. The customer's
      // own SMTP server is accepted as a fallback so a deployment that has not
      // filled in the platform mailbox yet still warns its customers.
      const result = await sendPlatformEmail(
        {
          to,
          subject: `${testTag}Pagamento non riuscito - azione richiesta entro il ${deadline} (${notice.companyName})`,
          html,
          text,
        },
        notice.companyId
      );
      delivery.ownerStatus = statusOf(result);
      delivery.ownerError = explain(result);
      delivery.ownerTransport = result.transport;
      if (!result.ok) {
        console.warn(
          `[Billing] Payment-failure email to ${to} was not sent (${result.status}): ${delivery.ownerError}`
        );
      }
    } catch (err: any) {
      delivery.ownerStatus = 'failed';
      delivery.ownerError = err?.message || String(err);
      console.error('[Billing] Payment-failure email threw:', delivery.ownerError);
    }
  }

  // ---------------------------------------------------------------------
  // 3. The operator copy. Tracked separately: a customer who was warned
  //    successfully must not be shown as unwarned because an internal copy
  //    bounced.
  // ---------------------------------------------------------------------
  const operators = await operatorRecipients();
  if (operators.length === 0) return delivery;

  delivery.copyTo = operators.join(', ');

  try {
    const reasonHtml = notice.failureMessage
      ? `<p>Motivo riportato dal gateway: ${notice.failureMessage}</p>`
      : '';
    const ownerLine = owner
      ? `Il titolare (${owner.email}) &egrave; stato avvisato via email (${delivery.ownerStatus}).`
      : 'ATTENZIONE: nessun indirizzo del titolare trovato, il cliente NON &egrave; stato avvisato via email.';

    // No company fallback here, deliberately. This message names a customer
    // and their failed payment; pushing it through that same customer's mail
    // server would put the platform's own business into their mail logs. When
    // the platform mailbox is not configured the copy is reported as not sent,
    // which is the thing the operator needs to know anyway.
    const result = await sendPlatformEmail({
      to: delivery.copyTo,
      subject: `${testTag}[VeylOHR] Pagamento fallito - ${notice.companyName} (blocco il ${deadline})`,
      html:
        testNoteHtml +
        `<p>Il pagamento ricorrente di <strong>${notice.companyName}</strong> non &egrave; andato a buon fine.</p>` +
        `<ul>` +
        `<li>Provider: ${notice.provider}</li>` +
        `<li>Importo: ${amount}</li>` +
        `<li>Periodo di tolleranza: ${notice.graceDays} giorni</li>` +
        `<li>Accesso sospeso a partire dal: <strong>${deadline}</strong></li>` +
        `<li>Notifiche in-app inviate: ${delivery.inAppCount}</li>` +
        `</ul>` +
        reasonHtml +
        `<p>${ownerLine}</p>`,
      text:
        testNoteText +
        `Il pagamento ricorrente di ${notice.companyName} non e' andato a buon fine.\n` +
        `Provider: ${notice.provider}\n` +
        `Importo: ${amount}\n` +
        `Periodo di tolleranza: ${notice.graceDays} giorni\n` +
        `Accesso sospeso a partire dal: ${deadline}\n` +
        `Notifiche in-app inviate: ${delivery.inAppCount}\n` +
        (notice.failureMessage ? `Motivo: ${notice.failureMessage}\n` : '') +
        `\n${owner ? `Titolare avvisato: ${owner.email} (${delivery.ownerStatus})` : 'ATTENZIONE: titolare NON avvisato via email.'}`,
    }, null);
    delivery.copyStatus = statusOf(result);
  } catch (err: any) {
    delivery.copyStatus = 'failed';
    console.error(
      '[Billing] Could not send the operator copy of a payment failure:',
      err?.message || err
    );
  }

  return delivery;
}

/**
 * Writes the outcome of the warnings onto the failed transaction they belong to.
 *
 * Separate from sending so the send path stays free of storage concerns, and so
 * a test notice - which belongs to no transaction - simply does not call this.
 * Never throws: the warning has already gone out, and losing the audit line is
 * not worth failing a webhook over.
 */
export async function recordNoticeDelivery(
  transactionId: number | undefined,
  delivery: NoticeDelivery
): Promise<void> {
  if (!transactionId) return;
  try {
    await pool.query(
      `UPDATE billing_transactions
          SET notice_email_to     = $1,
              notice_email_status = $2,
              notice_email_error  = $3,
              notice_email_at     = $4,
              notice_copy_to      = $5,
              notice_copy_status  = $6,
              notice_in_app_count = $7,
              notice_email_transport = $8
        WHERE id = $9`,
      [
        delivery.ownerEmail,
        delivery.ownerStatus,
        delivery.ownerError,
        delivery.sentAt,
        delivery.copyTo,
        delivery.copyStatus,
        delivery.inAppCount,
        delivery.ownerTransport,
        transactionId,
      ]
    );
  } catch (err: any) {
    console.error(
      `[Billing] Could not record notice delivery for transaction ${transactionId}:`,
      err?.message || err
    );
  }
}

/**
 * Rehearses the whole alert for a company, without touching its subscription.
 *
 * Every part of the real path runs - the same recipients, the same SMTP
 * configuration, the same in-app notification - so a deployment can be proved
 * before a live customer's renewal depends on it. The deadline is a plausible
 * date in the future rather than a real one, and everything is labelled as a
 * test.
 */
export async function sendPaymentFailedTestNotice(params: {
  companyId: number;
  graceDays?: number;
}): Promise<NoticeDelivery & { companyName: string }> {
  const res = await pool.query(
    `SELECT c.name,
            c.currency,
            COALESCE(c.grace_period_days, 3) AS grace_period_days,
            s.provider,
            s.seat_quantity, s.device_quantity,
            s.unit_price_employee, s.unit_price_device
       FROM companies c
       LEFT JOIN LATERAL (
            SELECT * FROM subscriptions
             WHERE company_id = c.id
             ORDER BY CASE status WHEN 'active' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END, id DESC
             LIMIT 1
       ) s ON true
      WHERE c.id = $1`,
    [params.companyId]
  );

  if (!res.rowCount) throw new Error(`Company not found: ${params.companyId}`);
  const row = res.rows[0];

  const graceDays = params.graceDays ?? row.grace_period_days ?? 3;
  // A realistic amount when there is a subscription, so the test mail reads
  // like the real one rather than showing a placeholder figure.
  const amountCents = row.seat_quantity
    ? Math.round(
        (row.seat_quantity * parseFloat(row.unit_price_employee ?? '0') +
          row.device_quantity * parseFloat(row.unit_price_device ?? '0')) *
          100
      )
    : null;

  const delivery = await sendPaymentFailedNotices({
    companyId: params.companyId,
    companyName: row.name,
    provider: row.provider || 'stripe',
    amountCents,
    currency: row.currency || 'EUR',
    gracePeriodEndsAt: new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000),
    graceDays,
    failureMessage: 'Test notice requested from the billing page',
    isTest: true,
  });

  return { ...delivery, companyName: row.name };
}
