import { pool } from '../../config/database';
import { sendEmailForCompany } from '../../services/email.service';

/**
 * The emails that go out when a renewal fails.
 *
 * A failed renewal starts a short grace period and then blocks the company, so
 * the one thing that must not happen is the customer finding out by losing
 * access. Two messages leave here:
 *
 *   - one to the person who owns the account, carrying the date the payment
 *     has to be settled by;
 *   - one to the platform operator, so they can reach the customer before the
 *     block lands.
 *
 * Both go through the company's own SMTP configuration, which is the only mail
 * transport this system has. A company with no SMTP configured therefore sends
 * nothing, and the in-app banner is what still warns it.
 */

/** Where the platform operator wants to be copied. Comma-separated. */
function operatorRecipients(): string[] {
  return (process.env.BILLING_ALERT_EMAIL || '')
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

interface FailureRecipients {
  /** The account owner - the person the warning is addressed to. */
  owner: { email: string; name: string } | null;
  /** The company's generic mailbox, when it is a different address. */
  companyEmail: string | null;
}

/**
 * Who to warn, in the order the client asked for: the account owner first.
 *
 * `companies.owner_user_id` is the owner proper. When a company has none
 * recorded - it predates ownership, or the owner's user was removed - the
 * oldest active admin is the closest equivalent and is used instead, because
 * warning the wrong administrator beats warning nobody. The generic company
 * address is only ever a copy, never a replacement.
 */
export async function resolveFailureRecipients(companyId: number): Promise<FailureRecipients> {
  const res = await pool.query(
    `SELECT c.company_email,
            o.email   AS owner_email,
            o.name    AS owner_name,
            o.surname AS owner_surname,
            a.email   AS admin_email,
            a.name    AS admin_name,
            a.surname AS admin_surname
       FROM companies c
       LEFT JOIN users o ON o.id = c.owner_user_id AND o.status = 'active'
       LEFT JOIN LATERAL (
            SELECT u.email, u.name, u.surname
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

  if (!res.rowCount) return { owner: null, companyEmail: null };

  const row = res.rows[0];
  const email = row.owner_email || row.admin_email || null;
  const name = row.owner_email
    ? [row.owner_name, row.owner_surname].filter(Boolean).join(' ')
    : [row.admin_name, row.admin_surname].filter(Boolean).join(' ');

  return {
    owner: email ? { email, name: name || email } : null,
    companyEmail: row.company_email || null,
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
}

/**
 * Sends the failed-payment warning to the account owner and the operator copy.
 *
 * Never throws: a mail server being unreachable must not fail the webhook that
 * recorded the failure, or the provider retries the whole event and the
 * subscription state is written twice.
 */
export async function sendPaymentFailedNotices(notice: PaymentFailedNotice): Promise<void> {
  const deadline = formatDateIt(notice.gracePeriodEndsAt);
  const billingUrl = `${appBaseUrl()}/impostazioni/fatturazione`;
  const amount = formatMoney(notice.amountCents, notice.currency);
  const amountLine = notice.amountCents ? ` (importo: ${amount})` : '';

  try {
    const { owner, companyEmail } = await resolveFailureRecipients(notice.companyId);

    if (owner) {
      const html =
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

      await sendEmailForCompany(notice.companyId, {
        to,
        subject: `Pagamento non riuscito - azione richiesta entro il ${deadline} (${notice.companyName})`,
        html,
        text,
      });
    } else {
      console.warn(
        `[Billing] Payment failed for company ${notice.companyId} but no owner or admin address could be resolved.`
      );
    }
  } catch (err: any) {
    console.error(
      `[Billing] Could not send the payment-failure notice for company ${notice.companyId}:`,
      err?.message || err
    );
  }

  const operators = operatorRecipients();
  if (operators.length === 0) return;

  try {
    const reasonHtml = notice.failureMessage
      ? `<p>Motivo riportato dal gateway: ${notice.failureMessage}</p>`
      : '';

    await sendEmailForCompany(notice.companyId, {
      to: operators.join(', '),
      subject: `[VeylOHR] Pagamento fallito - ${notice.companyName} (blocco il ${deadline})`,
      html:
        `<p>Il pagamento ricorrente di <strong>${notice.companyName}</strong> non &egrave; andato a buon fine.</p>` +
        `<ul>` +
        `<li>Provider: ${notice.provider}</li>` +
        `<li>Importo: ${amount}</li>` +
        `<li>Periodo di tolleranza: ${notice.graceDays} giorni</li>` +
        `<li>Accesso sospeso a partire dal: <strong>${deadline}</strong></li>` +
        `</ul>` +
        reasonHtml +
        `<p>Il titolare dell'account &egrave; stato avvisato via email.</p>`,
      text:
        `Il pagamento ricorrente di ${notice.companyName} non e' andato a buon fine.\n` +
        `Provider: ${notice.provider}\n` +
        `Importo: ${amount}\n` +
        `Periodo di tolleranza: ${notice.graceDays} giorni\n` +
        `Accesso sospeso a partire dal: ${deadline}\n` +
        (notice.failureMessage ? `Motivo: ${notice.failureMessage}\n` : '') +
        `\nIl titolare dell'account e' stato avvisato via email.`,
    });
  } catch (err: any) {
    console.error(
      '[Billing] Could not send the operator copy of a payment failure:',
      err?.message || err
    );
  }
}
