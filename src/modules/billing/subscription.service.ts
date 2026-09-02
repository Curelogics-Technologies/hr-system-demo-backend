import { pool } from '../../config/database';
import { getPaymentGateway } from './gateway.factory';
import {
  ParsedWebhookEvent,
  PaymentProvider,
  SubscriptionStatus,
} from './gateway.interface';
import { markHeadcountBilled, countBillableResources } from './headcount.service';
import { emitToCompany } from '../../config/socket';

/**
 * Tells a company's open pages that its billing state moved.
 *
 * Deliberately carries no data: the client refetches, so there is one source of
 * truth and no risk of a stale payload overwriting fresher state. Never allowed
 * to throw — a socket problem must not fail a webhook we have already accepted.
 */
export function announceBillingChange(companyId: number, reason: string) {
  try {
    emitToCompany(companyId, 'billing:updated', { reason, at: new Date().toISOString() });
  } catch (err: any) {
    console.error('[Billing] Could not announce billing change:', err?.message || err);
  }
}
import { priceLicenseChange, getLicenseSnapshot } from './license.service';
import { resolveIsoCurrency, UnsupportedCurrencyError } from './currency';

/**
 * What an increase actually costs mid-cycle.
 *
 * Only the DIFFERENCE between the already-paid quantities and the current ones
 * is charged, and only for the unused part of the current period. The customer
 * never re-pays for seats already covered by the last invoice. Both gateways
 * are told to prorate, so this mirrors what they will bill.
 */
export function computeProratedDelta(params: {
  billedSeats: number;
  billedDevices: number;
  liveSeats: number;
  liveDevices: number;
  unitPriceEmployee: number;
  unitPriceDevice: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();

  // Increases only — reductions never produce a credit (client rule).
  const extraSeats = Math.max(0, params.liveSeats - params.billedSeats);
  const extraDevices = Math.max(0, params.liveDevices - params.billedDevices);

  const additionalMonthly =
    extraSeats * params.unitPriceEmployee + extraDevices * params.unitPriceDevice;

  let remainingRatio = 1;
  if (params.periodStart && params.periodEnd) {
    const start = params.periodStart.getTime();
    const end = params.periodEnd.getTime();
    const total = end - start;
    if (total > 0) {
      remainingRatio = Math.min(1, Math.max(0, (end - now.getTime()) / total));
    }
  }

  const proratedNow = additionalMonthly * remainingRatio;

  return {
    extraSeats,
    extraDevices,
    // Full monthly value of the added resources, charged from next renewal on
    additionalMonthly: Math.round(additionalMonthly * 100) / 100,
    // What is charged right now for the remainder of the current period
    proratedAmountDue: Math.round(proratedNow * 100) / 100,
    remainingRatio,
    hasIncrease: extraSeats > 0 || extraDevices > 0,
  };
}

/**
 * Domain error carrying a machine-readable code so the API layer can answer
 * with 4xx + a code the UI can translate, instead of a generic 500.
 */
export class BillingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: Record<string, any>
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

/** Company fields that must be filled before any subscription can be started. */
const REQUIRED_COMPANY_FIELDS: Array<{ column: string; label: string }> = [
  { column: 'vat_number', label: 'VAT Number' },
  { column: 'sdi_recipient_code', label: 'SDI Recipient Code' },
  { column: 'pec_email', label: 'PEC Email' },
];

function missingCompanyFields(company: any): string[] {
  return REQUIRED_COMPANY_FIELDS
    .filter((f) => !String(company?.[f.column] ?? '').trim())
    .map((f) => f.column);
}

export class SubscriptionService {
  /**
   * 1. Initiates hosted checkout for Company Admin
   */
  async initiateCheckout(params: {
    companyId: number;
    provider: PaymentProvider;
    appBaseUrl?: string;
    /** Licenses the admin chose to buy. Falls back to current usage. */
    employeeLicenses?: number;
    terminalLicenses?: number;
  }) {
    const { companyId, provider } = params;

    // A. Fetch company pricing and details
    const compRes = await pool.query(
      `SELECT id, name, slug, company_email, currency, 
              price_per_employee, price_per_device, 
              vat_number, sdi_recipient_code, pec_email,
              bill_reminder_days_before, grace_period_days
       FROM companies 
       WHERE id = $1`,
      [companyId]
    );

    if (compRes.rowCount === 0) {
      throw new Error(`Company not found with ID: ${companyId}`);
    }

    const company = compRes.rows[0];

    const unitPriceEmployee = parseFloat(company.price_per_employee || '0');
    const unitPriceDevice = parseFloat(company.price_per_device || '0');

    // The company currency is free text, so it can be a display name like
    // "Euro" or "Pakistani Rupee". Providers only accept the ISO code, and the
    // billing columns store the code, so resolve it here and fail with a clear
    // message rather than letting the database or Stripe reject it obscurely.
    let currency: string;
    try {
      currency = resolveIsoCurrency(company.currency);
    } catch (err) {
      if (err instanceof UnsupportedCurrencyError) {
        throw new BillingError(err.code, err.message, err.statusCode, {
          given: err.given,
          companyId,
        });
      }
      throw err;
    }

    // A2. Preflight: mandatory company billing identity must be complete.
    const missing = missingCompanyFields(company);
    if (missing.length > 0) {
      throw new BillingError(
        'COMPANY_DETAILS_INCOMPLETE',
        'VAT Number, SDI Recipient Code and PEC Email must be filled before activating a subscription',
        400,
        { missingFields: missing }
      );
    }

    // A3. Preflight: Super Admin must have configured the unit prices.
    if (!(unitPriceEmployee > 0) && !(unitPriceDevice > 0)) {
      throw new BillingError(
        'PRICING_NOT_CONFIGURED',
        'Unit prices are not configured for this company. Contact the system administrator.',
        400
      );
    }

    // B. Licenses to buy. The admin chooses these; they are not derived from
    // how many users exist. They may never be fewer than what is already in
    // use, or the company would be over its own allowance the moment it pays.
    const inUse = await countBillableResources(companyId);

    const seatQuantity =
      params.employeeLicenses !== undefined
        ? Math.floor(params.employeeLicenses)
        : inUse.employeeCount;
    const deviceQuantity =
      params.terminalLicenses !== undefined
        ? Math.floor(params.terminalLicenses)
        : inUse.deviceCount;

    if (seatQuantity < 0 || deviceQuantity < 0) {
      throw new BillingError('INVALID_LICENSES', 'License quantities cannot be negative', 400);
    }

    if (seatQuantity < inUse.employeeCount) {
      throw new BillingError(
        'LICENSES_BELOW_USAGE',
        `The company already has ${inUse.employeeCount} active employees. Buy at least that many employee licenses.`,
        400,
        { resource: 'employee', inUse: inUse.employeeCount, requested: seatQuantity }
      );
    }

    if (deviceQuantity < inUse.deviceCount) {
      throw new BillingError(
        'LICENSES_BELOW_USAGE',
        `The company already has ${inUse.deviceCount} registered terminals. Buy at least that many terminal licenses.`,
        400,
        { resource: 'terminal', inUse: inUse.deviceCount, requested: deviceQuantity }
      );
    }

    // B2. Preflight: never send a zero-amount subscription to the gateway.
    const monthlyTotal =
      seatQuantity * unitPriceEmployee + deviceQuantity * unitPriceDevice;
    if (!(monthlyTotal > 0)) {
      throw new BillingError(
        'NOTHING_TO_BILL',
        'There are no billable active employees or terminals for this company yet',
        400,
        { seatQuantity, deviceQuantity }
      );
    }

    // B3. Guard against double subscription. An already-active subscription on
    // the same provider must never be charged twice; switching provider or
    // re-paying a past_due subscription is allowed and supersedes the old row.
    const existingRes = await pool.query(
      `SELECT id, provider, status FROM subscriptions
       WHERE company_id = $1 AND status IN ('active', 'past_due')
       ORDER BY id DESC LIMIT 1`,
      [companyId]
    );
    const existing = existingRes.rowCount ? existingRes.rows[0] : null;

    if (existing && existing.status === 'active' && existing.provider === provider) {
      throw new BillingError(
        'SUBSCRIPTION_ALREADY_ACTIVE',
        'This company already has an active subscription with this payment provider',
        409,
        { provider }
      );
    }

    // C. Check or create Pending Subscription row in DB
    // Clean up any previous incomplete / pending attempts
    await pool.query(
      `DELETE FROM subscriptions 
       WHERE company_id = $1 AND status = 'pending'`,
      [companyId]
    );

    const subInsert = await pool.query(
      `INSERT INTO subscriptions (
        company_id, provider, status,
        seat_quantity, device_quantity,
        unit_price_employee, unit_price_device, currency,
        bill_reminder_days_before, grace_period_days,
        metadata
      ) VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id`,
      [
        companyId,
        provider,
        seatQuantity,
        deviceQuantity,
        unitPriceEmployee,
        unitPriceDevice,
        currency,
        company.bill_reminder_days_before || 3,
        company.grace_period_days || 3,
        JSON.stringify(
          existing ? { supersedesSubscriptionId: existing.id } : {}
        ),
      ]
    );

    const subscriptionId = subInsert.rows[0].id;

    // D. Generate Return and Cancel URLs
    const baseUrl =
      params.appBaseUrl ||
      process.env.CORS_ORIGIN ||
      process.env.APP_BASE_URL ||
      'http://localhost:5173';

    const successUrl = `${baseUrl}/impostazioni/fatturazione/processing?provider=${provider}&attempt_id=${subscriptionId}`;
    const cancelUrl = `${baseUrl}/impostazioni/fatturazione?canceled=true`;

    // E. Create hosted checkout session with Gateway
    const gateway = getPaymentGateway(provider);
    const checkoutResult = await gateway.createCheckoutSession({
      companyId,
      companyName: company.name,
      companyEmail: company.company_email,
      currency,
      seatQuantity,
      deviceQuantity,
      unitPriceEmployee,
      unitPriceDevice,
      successUrl,
      cancelUrl,
      metadata: {
        subscriptionDbId: String(subscriptionId),
      },
    });

    // F. Store checkout session info
    await pool.query(
      `UPDATE subscriptions 
       SET checkout_session_id = $1,
           provider_customer_id = $2,
           provider_subscription_id = COALESCE($3, provider_subscription_id)
       WHERE id = $4`,
      [
        checkoutResult.sessionId,
        checkoutResult.providerCustomerId || null,
        checkoutResult.providerSubscriptionId || null,
        subscriptionId,
      ]
    );

    return {
      checkoutUrl: checkoutResult.checkoutUrl,
      billingAttemptId: subscriptionId,
    };
  }

  /**
   * 2. Webhook: Checkout Completed / Activated
   */
  async handleCheckoutCompleted(event: ParsedWebhookEvent) {
    const client = await pool.connect();
    let supersededAtGateway: Array<{
      id: number;
      provider: PaymentProvider;
      providerSubscriptionId: string;
    }> = [];
    try {
      await client.query('BEGIN');

      // Find subscription by provider_subscription_id, checkout_session_id or metadata
      let subQuery = await client.query(
        `SELECT * FROM subscriptions 
         WHERE (provider_subscription_id = $1 OR checkout_session_id = $1 OR checkout_session_id = $2)
           AND provider = $3
         ORDER BY id DESC LIMIT 1`,
        [event.subscriptionId || event.eventId, event.payload?.id || null, event.provider]
      );

      if (subQuery.rowCount === 0 && event.payload?.client_reference_id) {
        subQuery = await client.query(
          `SELECT * FROM subscriptions 
           WHERE company_id = $1 AND provider = $2
           ORDER BY id DESC LIMIT 1`,
          [parseInt(event.payload.client_reference_id), event.provider]
        );
      }

      if (subQuery.rowCount === 0) {
        console.warn(`[Billing] No subscription matched for checkout completion:`, event);
        await client.query('COMMIT');
        return;
      }

      const sub = subQuery.rows[0];
      const now = new Date();

      // A billing period belongs to the provider; it is never invented here.
      // Some checkout events carry no period at all (a card change completes
      // as a checkout too), and this used to answer that by stamping
      // "today + 30 days" over a live subscription — moving a real 25 Aug
      // renewal to 2 Oct. When the event has no period the stored one is
      // kept, and customer.subscription.created/updated fills it in.
      const storedStart = sub.current_period_start ? new Date(sub.current_period_start) : null;
      const storedEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;

      const periodStart = event.currentPeriodStart ?? storedStart ?? now;
      const periodEnd =
        event.currentPeriodEnd ??
        storedEnd ??
        // Only reached on a first activation whose event carried no period.
        // A month, not 30 days: monthly billing follows the calendar.
        new Date(
          Date.UTC(
            periodStart.getUTCFullYear(),
            periodStart.getUTCMonth() + 1,
            periodStart.getUTCDate(),
            periodStart.getUTCHours(),
            periodStart.getUTCMinutes(),
            periodStart.getUTCSeconds()
          )
        );

      // Activate subscription
      await client.query(
        `UPDATE subscriptions 
         SET status = 'active',
             provider_subscription_id = COALESCE($1, provider_subscription_id),
             provider_customer_id = COALESCE($2, provider_customer_id),
             current_period_start = $3,
             current_period_end = $4,
             grace_period_ends_at = NULL,
             updated_at = NOW()
         WHERE id = $5`,
        [
          event.subscriptionId || sub.provider_subscription_id,
          event.customerId || sub.provider_customer_id,
          periodStart,
          periodEnd,
          sub.id,
        ]
      );

      // Record first transaction if not already recorded for this event
      const totalAmountCents =
      // ?? not ||: a genuine zero is meaningful. When a total falls under
      // the provider's minimum charge it books the amount to the customer's
      // balance rather than taking it, and reports amount_paid as 0.
        event.amountCents ??
        Math.round(
          (sub.seat_quantity * parseFloat(sub.unit_price_employee) +
            sub.device_quantity * parseFloat(sub.unit_price_device)) *
            100
        );

      // Key on the invoice, not the event. The very same first payment also
      // arrives as invoice.payment_succeeded, and that handler keys on the
      // invoice id; deduping on the event id here meant the two handlers
      // could not see each other and recorded one payment as two.
      const activationKey = event.providerInvoiceId || event.eventId;

      const existingTx = await client.query(
        `SELECT id FROM billing_transactions 
         WHERE subscription_id = $1
           AND (provider_invoice_id = $2 OR provider_payment_id = $2)`,
        [sub.id, activationKey]
      );

      if (existingTx.rowCount === 0) {
        await client.query(
          `INSERT INTO billing_transactions (
            company_id, subscription_id, provider,
            provider_payment_id, provider_invoice_id, amount_cents, currency,
            status, kind, description,
            seat_quantity, device_quantity,
            unit_price_employee_cents, unit_price_device_cents,
            invoice_url, paid_at
          ) VALUES ($1, $2, $3, $4, $13, $5, $6, 'paid', 'activation', $7, $8, $9, $10, $11, $12, NOW())`,
          [
            sub.company_id,
            sub.id,
            event.provider,
            event.eventId,
            totalAmountCents,
            event.currency || sub.currency,
            `Initial activation: ${sub.seat_quantity} employees, ${sub.device_quantity} terminals`,
            sub.seat_quantity,
            sub.device_quantity,
            Math.round(parseFloat(sub.unit_price_employee) * 100),
            Math.round(parseFloat(sub.unit_price_device) * 100),
            event.invoiceUrl || null,
            event.providerInvoiceId || null,
          ]
        );
      }

      // Supersede any other still-live subscription for this company. Without
      // this a provider switch or a past_due re-payment would leave two live
      // subscriptions at the gateways and bill the customer twice.
      const staleRes = await client.query(
        `SELECT id, provider, provider_subscription_id
         FROM subscriptions
         WHERE company_id = $1 AND id <> $2 AND status <> 'canceled'`,
        [sub.company_id, sub.id]
      );

      if (staleRes.rowCount && staleRes.rowCount > 0) {
        await client.query(
          `UPDATE subscriptions
           SET status = 'canceled',
               canceled_at = NOW(),
               cancel_at_period_end = false,
               updated_at = NOW()
           WHERE company_id = $1 AND id <> $2 AND status <> 'canceled'`,
          [sub.company_id, sub.id]
        );

        supersededAtGateway = staleRes.rows
          .filter((r: any) => !!r.provider_subscription_id)
          .map((r: any) => ({
            id: r.id,
            provider: r.provider as PaymentProvider,
            providerSubscriptionId: r.provider_subscription_id as string,
          }));
      }

      await client.query('COMMIT');
      announceBillingChange(sub.company_id, 'activated');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Gateway cancellations run outside the transaction: a network failure here
    // must not roll back an activation the provider has already confirmed.
    for (const stale of supersededAtGateway) {
      try {
        await getPaymentGateway(stale.provider).cancelSubscription(
          stale.providerSubscriptionId,
          false
        );
      } catch (err: any) {
        console.error(
          `[Billing] Failed to cancel superseded subscription ${stale.id} (${stale.provider}/${stale.providerSubscriptionId}):`,
          err?.message || err
        );
      }
    }
  }

  /**
   * Webhook: the admin finished replacing their card.
   *
   * Nothing about the subscription's state changes here — only which card the
   * provider will bill from now on.
   */
  async handlePaymentMethodUpdated(event: ParsedWebhookEvent) {
    try {
      const gateway = getPaymentGateway('stripe') as any;
      const subscriptionId = await gateway.applySetupSessionPaymentMethod(event.payload);
      if (subscriptionId) {
        await pool.query(
          `UPDATE subscriptions SET updated_at = NOW()
           WHERE provider_subscription_id = $1 AND provider = 'stripe'`,
          [subscriptionId]
        );
        console.log(`[Billing] Payment method updated for subscription ${subscriptionId}`);
      }
    } catch (err: any) {
      console.error('[Billing] Failed to apply new payment method:', err?.message || err);
      throw err;
    }
  }

  /**
   * 3. Webhook: Payment Succeeded (Renewal or Invoice Paid)
   */
  async handlePaymentSucceeded(event: ParsedWebhookEvent) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Match on the subscription when the provider gave us one; otherwise on
      // the invoice we are waiting for, and finally on the customer. A paid
      // invoice must never be dropped because one identifier is missing — that
      // silently loses money and leaves upgrades stuck forever.
      let subRes: any = { rowCount: 0, rows: [] as any[] };

      if (event.subscriptionId) {
        subRes = await client.query(
          `SELECT * FROM subscriptions
           WHERE provider_subscription_id = $1 AND provider = $2`,
          [event.subscriptionId, event.provider]
        );
      }

      if (subRes.rowCount === 0 && event.providerInvoiceId) {
        subRes = await client.query(
          `SELECT * FROM subscriptions
           WHERE requested_invoice_id = $1 AND provider = $2`,
          [event.providerInvoiceId, event.provider]
        );
      }

      if (subRes.rowCount === 0 && event.customerId) {
        subRes = await client.query(
          `SELECT * FROM subscriptions
           WHERE provider_customer_id = $1 AND provider = $2
             AND status IN ('active', 'past_due')
           ORDER BY id DESC LIMIT 1`,
          [event.customerId, event.provider]
        );
      }

      if (subRes.rowCount === 0) {
        console.error('[Billing] UNMATCHED PAID INVOICE — no subscription found.', {
          subscriptionId: event.subscriptionId,
          invoiceId: event.providerInvoiceId,
          customerId: event.customerId,
          amountCents: event.amountCents,
        });
        await client.query('COMMIT');
        return;
      }

      const sub = subRes.rows[0];

      // A paid invoice while an upgrade is in flight IS that upgrade: grant the
      // licenses now. This is the only place the allowance ever grows, so an
      // unpaid or failed upgrade can never widen it.
      const hasPendingUpgrade =
        sub.requested_seat_quantity !== null || sub.requested_device_quantity !== null;

      if (hasPendingUpgrade) {
        await markHeadcountBilled(sub.company_id, sub.id, client);
      }

      // Licenses are what was bought. They only shrink when the admin asked for
      // a reduction, and only as a new period starts.
      const nextSeatQty = hasPendingUpgrade
        ? (sub.requested_seat_quantity ?? sub.seat_quantity)
        : sub.pending_seat_quantity !== null
          ? sub.pending_seat_quantity
          : sub.seat_quantity;
      const nextDevQty = hasPendingUpgrade
        ? (sub.requested_device_quantity ?? sub.device_quantity)
        : sub.pending_device_quantity !== null
          ? sub.pending_device_quantity
          : sub.device_quantity;

      const now = new Date();
      const periodStart = event.currentPeriodStart || now;
      const periodEnd =
        event.currentPeriodEnd ??
        // A month, not 30 days: monthly billing follows the calendar, so a
        // fixed 30 drifts the renewal earlier every cycle.
        new Date(
          Date.UTC(
            periodStart.getUTCFullYear(),
            periodStart.getUTCMonth() + 1,
            periodStart.getUTCDate(),
            periodStart.getUTCHours(),
            periodStart.getUTCMinutes(),
            periodStart.getUTCSeconds()
          )
        );

      // An upgrade invoice must never move the billing period: once a period
      // has started it runs to its end unchanged. Belt and braces, a period
      // that would end earlier than the one already stored is rejected too —
      // renewals only ever push the end date forward.
      const storedEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
      const incomingEndIsLater =
        periodEnd instanceof Date &&
        (!storedEnd || periodEnd.getTime() > storedEnd.getTime());
      const keepStoredPeriod = hasPendingUpgrade || !incomingEndIsLater;

      const effectivePeriodStart = keepStoredPeriod
        ? sub.current_period_start ?? periodStart
        : periodStart;
      const effectivePeriodEnd = keepStoredPeriod
        ? sub.current_period_end ?? periodEnd
        : periodEnd;

      await client.query(
        `UPDATE subscriptions 
         SET status = 'active',
             seat_quantity = $1,
             device_quantity = $2,
             requested_seat_quantity = NULL,
             requested_device_quantity = NULL,
             requested_at = NULL,
             requested_amount_cents = NULL,
             -- Clear the invoice pointer too, so a later reconcile cannot look
             -- up an upgrade that has already been settled.
             requested_invoice_id = NULL,
             pending_seat_quantity = CASE WHEN $6::boolean THEN pending_seat_quantity ELSE NULL END,
             pending_device_quantity = CASE WHEN $6::boolean THEN pending_device_quantity ELSE NULL END,
             current_period_start = $3,
             current_period_end = $4,
             grace_period_ends_at = NULL,
             updated_at = NOW()
         WHERE id = $5`,
        [nextSeatQty, nextDevQty, effectivePeriodStart, effectivePeriodEnd, sub.id, hasPendingUpgrade]
      );

      // If an existing activation transaction for this subscription is missing invoice_url, update it
      if (event.invoiceUrl) {
        await client.query(
          `UPDATE billing_transactions 
           SET invoice_url = COALESCE(invoice_url, $1) 
           WHERE subscription_id = $2 AND invoice_url IS NULL`,
          [event.invoiceUrl, sub.id]
        );
      }

      // Check if this payment event was already recorded
      // Key on the invoice, not the event: the same invoice can arrive under
      // several event ids (provider retry, replay, reconcile) and each would
      // otherwise insert its own duplicate payment row.
      const paymentKey = event.providerInvoiceId || event.eventId;

      const existingTx = await client.query(
        `SELECT id FROM billing_transactions 
         WHERE subscription_id = $1 AND (provider_invoice_id = $2 OR provider_payment_id = $2)`,
        [sub.id, paymentKey]
      );

      if (existingTx.rowCount === 0) {
        // The provider settled the invoice without taking money: the total was
        // under its minimum charge and has been carried to the next invoice.
        const collectedNothing =
          (event.invoiceTotalCents ?? 0) > 0 && (event.amountCents ?? 0) === 0;

        const totalAmountCents =
          collectedNothing ? (event.invoiceTotalCents ?? 0) : event.amountCents ??
          Math.round(
            (nextSeatQty * parseFloat(sub.unit_price_employee) +
              nextDevQty * parseFloat(sub.unit_price_device)) *
              100
          );

        await client.query(
          `INSERT INTO billing_transactions (
            company_id, subscription_id, provider,
            provider_invoice_id, amount_cents, currency,
            status, kind, description,
            seat_quantity, device_quantity,
            unit_price_employee_cents, unit_price_device_cents,
            invoice_url, paid_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $14, $13, $7, $8, $9, $10, $11, $12, NOW())`,
          [
            sub.company_id,
            sub.id,
            event.provider,
            paymentKey,
            totalAmountCents,
            event.currency || sub.currency,
            hasPendingUpgrade
              ? `Licenze aggiuntive: ${nextSeatQty} dipendenti, ${nextDevQty} terminali`
              : `Rinnovo mensile: ${nextSeatQty} dipendenti, ${nextDevQty} terminali`,
            nextSeatQty,
            nextDevQty,
            Math.round(parseFloat(sub.unit_price_employee) * 100),
            Math.round(parseFloat(sub.unit_price_device) * 100),
            event.invoiceUrl || null,
            collectedNothing ? 'carried_over' : hasPendingUpgrade ? 'license_upgrade' : 'renewal',
            collectedNothing ? 'pending' : 'paid',
          ]
        );
      }

      await client.query('COMMIT');
      announceBillingChange(sub.company_id, 'payment');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 4. Webhook: Payment Failed
   */
  async handlePaymentFailed(event: ParsedWebhookEvent) {
    if (!event.subscriptionId) return;

    const subRes = await pool.query(
      `SELECT * FROM subscriptions 
       WHERE provider_subscription_id = $1 AND provider = $2`,
      [event.subscriptionId, event.provider]
    );

    if (subRes.rowCount === 0) return;

    const sub = subRes.rows[0];
    const graceDays = sub.grace_period_days || 3;
    const graceEnd = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE subscriptions 
       SET status = 'past_due',
           grace_period_ends_at = COALESCE(grace_period_ends_at, $1),
           -- A failed invoice never buys licenses: drop any upgrade that was
           -- awaiting confirmation so the allowance stays where it was.
           requested_seat_quantity = NULL,
           requested_device_quantity = NULL,
           requested_at = NULL,
           requested_amount_cents = NULL,
           updated_at = NOW()
       WHERE id = $2`,
      [graceEnd, sub.id]
    );

    // Record failed transaction
    await pool.query(
      `INSERT INTO billing_transactions (
        company_id, subscription_id, provider,
        amount_cents, currency,
        status, kind, description,
        failure_code, failure_message
      ) VALUES ($1, $2, $3, $4, $5, 'failed', 'failed', $6, $7, $8)`,
      [
        sub.company_id,
        sub.id,
        event.provider,
        event.amountCents ?? 0,
        event.currency || sub.currency,
        `Payment attempt failed`,
        event.failureCode || 'payment_failed',
        event.failureMessage || 'Payment declined by gateway',
      ]
    );
  }

  /**
   * 5. Webhook: Subscription Updated / Canceled
   */
  async handleSubscriptionUpdated(event: ParsedWebhookEvent) {
    if (!event.subscriptionId) return;

    const updates: string[] = ['updated_at = NOW()'];
    const values: any[] = [event.subscriptionId, event.provider];
    let idx = 3;

    if (event.status) {
      updates.push(`status = CASE WHEN status = 'active' AND $${idx}::text IN ('incomplete', 'pending') THEN status ELSE $${idx} END`);
      values.push(event.status);
      idx++;
    }
    if (event.currentPeriodStart) {
      updates.push(`current_period_start = $${idx++}`);
      values.push(event.currentPeriodStart);
    }
    if (event.currentPeriodEnd) {
      updates.push(`current_period_end = $${idx++}`);
      values.push(event.currentPeriodEnd);
    }

    await pool.query(
      `UPDATE subscriptions 
       SET ${updates.join(', ')}
       WHERE provider_subscription_id = $1 AND provider = $2`,
      values
    );
  }

  async handleSubscriptionCanceled(event: ParsedWebhookEvent) {
    if (!event.subscriptionId) return;

    await pool.query(
      `UPDATE subscriptions 
       SET status = 'canceled',
           canceled_at = NOW(),
           updated_at = NOW()
       WHERE provider_subscription_id = $1 AND provider = $2`,
      [event.subscriptionId, event.provider]
    );
  }

  /**
   * 6. Company Admin: Billing Overview
   */
  async getCompanyBillingOverview(companyId: number) {
    // Current company pricing
    const compRes = await pool.query(
      `SELECT id, name, currency, price_per_employee, price_per_device, 
              vat_number, sdi_recipient_code, pec_email,
              bill_reminder_days_before, grace_period_days
       FROM companies 
       WHERE id = $1`,
      [companyId]
    );
    if (compRes.rowCount === 0) {
      throw new Error(`Company not found: ${companyId}`);
    }
    const company = compRes.rows[0];

    // Live counts
    const empRes = await pool.query(
      `SELECT COUNT(*)::int AS count 
       FROM users 
       WHERE company_id = $1 AND status = 'active' AND role != 'store_terminal'`,
      [companyId]
    );
    const liveEmployeeCount = empRes.rows[0]?.count || 0;

    const devRes = await pool.query(
      `SELECT COUNT(*)::int AS count 
       FROM users 
       WHERE company_id = $1 AND status = 'active' AND role = 'store_terminal' 
         AND (registered_device_token IS NOT NULL OR registered_device_identifier IS NOT NULL)`,
      [companyId]
    );
    const liveDeviceCount = devRes.rows[0]?.count || 0;

    // Subscription
    const subRes = await pool.query(
      `SELECT * FROM subscriptions 
       WHERE company_id = $1 
       ORDER BY CASE WHEN status = 'active' THEN 1 WHEN status = 'past_due' THEN 2 ELSE 3 END, id DESC 
       LIMIT 1`,
      [companyId]
    );
    const subscription = subRes.rowCount ? subRes.rows[0] : null;

    // Recent transactions
    const txRes = await pool.query(
      `SELECT * FROM billing_transactions 
       WHERE company_id = $1 
       ORDER BY id DESC LIMIT 10`,
      [companyId]
    );

    const pricePerEmployee = parseFloat(company.price_per_employee || '0');
    const pricePerDevice = parseFloat(company.price_per_device || '0');
    const monthlyTotal =
      liveEmployeeCount * pricePerEmployee + liveDeviceCount * pricePerDevice;

    // Checkout readiness — mirrors the preflight guards in initiateCheckout so
    // the UI can explain why activation is unavailable instead of failing late.
    const missingFields = missingCompanyFields(company);
    const pricingConfigured = pricePerEmployee > 0 || pricePerDevice > 0;
    const hasBillableQuantity = monthlyTotal > 0;
    const activeProvider =
      subscription && subscription.status === 'active'
        ? (subscription.provider as PaymentProvider)
        : null;

    // Settle anything a missed or mistimed webhook left hanging, before
    // reporting state. This is the page an admin lands on, so it is the one
    // place a stuck upgrade must always resolve itself.
    try {
      await this.reconcilePendingUpgrade(companyId);
    } catch (err: any) {
      console.error('[Billing] Overview reconcile failed:', err?.message || err);
    }

    // Licenses: what the company bought versus what it is using.
    const licenses = await getLicenseSnapshot(companyId);

    // The card on file. Best-effort: a provider hiccup must not break the page.
    let paymentMethod: {
      brand: string;
      last4: string;
      expMonth: number;
      expYear: number;
    } | null = null;

    if (
      subscription &&
      subscription.provider === 'stripe' &&
      subscription.provider_subscription_id &&
      ['active', 'past_due'].includes(subscription.status)
    ) {
      try {
        const gateway = getPaymentGateway('stripe') as any;
        paymentMethod = await gateway.describeDefaultPaymentMethod(
          subscription.provider_subscription_id
        );
      } catch {
        paymentMethod = null;
      }
    }

    return {
      company: {
        id: company.id,
        name: company.name,
        currency: company.currency || 'EUR',
        vatNumber: company.vat_number,
        sdiRecipientCode: company.sdi_recipient_code,
        pecEmail: company.pec_email,
        pricePerEmployee,
        pricePerDevice,
      },
      subscription: subscription
        ? {
            id: subscription.id,
            provider: subscription.provider,
            status: subscription.status,
            seatQuantity: subscription.seat_quantity,
            deviceQuantity: subscription.device_quantity,
            pendingSeatQuantity: subscription.pending_seat_quantity,
            pendingDeviceQuantity: subscription.pending_device_quantity,
            unitPriceEmployee: parseFloat(subscription.unit_price_employee),
            unitPriceDevice: parseFloat(subscription.unit_price_device),
            currency: subscription.currency,
            currentPeriodStart: subscription.current_period_start,
            currentPeriodEnd: subscription.current_period_end,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            gracePeriodEndsAt: subscription.grace_period_ends_at,
          }
        : null,
      liveUsage: {
        employeeCount: liveEmployeeCount,
        deviceCount: liveDeviceCount,
        calculatedMonthlyTotal: monthlyTotal,
      },
      readiness: {
        canCheckout:
          missingFields.length === 0 && pricingConfigured && hasBillableQuantity,
        missingFields,
        pricingConfigured,
        hasBillableQuantity,
        activeProvider,
      },
      licenses,
      paymentMethod,
      transactions: txRes.rows.map((tx) => ({
        id: tx.id,
        provider: tx.provider,
        amountCents: tx.amount_cents,
        currency: tx.currency,
        status: tx.status,
        // What the payment was — the UI words it in the reader's language.
        kind: tx.kind,
        description: tx.description,
        seatQuantity: tx.seat_quantity,
        deviceQuantity: tx.device_quantity,
        invoiceUrl: tx.invoice_url,
        failureMessage: tx.failure_message,
        paidAt: tx.paid_at,
        createdAt: tx.created_at,
      })),
    };
  }

  /**
   * 7. License change (pay first, then the allowance grows)
   *
   * An increase is charged immediately, prorated for the unused part of the
   * current period, and the licensed columns are NOT widened here. They are
   * widened only when the provider confirms the invoice was paid, in
   * applyConfirmedLicenseUpgrade(). Until then the company keeps its old
   * allowance, so a failed card can never buy seats.
   *
   * A decrease costs nothing, is never refunded, and is parked in pending_*
   * to be applied at the next renewal.
   */
  async requestLicenseChange(params: {
    companyId: number;
    employeeLicenses: number;
    terminalLicenses: number;
  }) {
    const { companyId } = params;
    const newEmployees = Math.floor(params.employeeLicenses);
    const newTerminals = Math.floor(params.terminalLicenses);

    if (newEmployees < 0 || newTerminals < 0) {
      throw new BillingError('INVALID_LICENSES', 'License quantities cannot be negative', 400);
    }

    const subRes = await pool.query(
      `SELECT * FROM subscriptions
       WHERE company_id = $1 AND status IN ('active', 'past_due')
       ORDER BY CASE status WHEN 'active' THEN 1 ELSE 2 END, id DESC
       LIMIT 1`,
      [companyId]
    );
    if (subRes.rowCount === 0) {
      throw new BillingError(
        'NO_ACTIVE_SUBSCRIPTION',
        'There is no active subscription to change licenses on',
        409
      );
    }
    const sub = subRes.rows[0];

    // Never below what is already in use — that would strand existing users.
    const inUse = await countBillableResources(companyId);
    if (newEmployees < inUse.employeeCount) {
      throw new BillingError(
        'LICENSES_BELOW_USAGE',
        `${inUse.employeeCount} employees are active. Deactivate employees before reducing below that number.`,
        400,
        { resource: 'employee', inUse: inUse.employeeCount, requested: newEmployees }
      );
    }
    if (newTerminals < inUse.deviceCount) {
      throw new BillingError(
        'LICENSES_BELOW_USAGE',
        `${inUse.deviceCount} terminals are registered. Remove terminals before reducing below that number.`,
        400,
        { resource: 'terminal', inUse: inUse.deviceCount, requested: newTerminals }
      );
    }

    if (sub.requested_seat_quantity !== null || sub.requested_device_quantity !== null) {
      throw new BillingError(
        'UPGRADE_IN_PROGRESS',
        'A license upgrade is already awaiting payment confirmation',
        409
      );
    }

    const quote = priceLicenseChange({
      currentEmployees: sub.seat_quantity,
      currentTerminals: sub.device_quantity,
      newEmployees,
      newTerminals,
      unitPriceEmployee: parseFloat(sub.unit_price_employee),
      unitPriceDevice: parseFloat(sub.unit_price_device),
      periodStart: sub.current_period_start ? new Date(sub.current_period_start) : null,
      periodEnd: sub.current_period_end ? new Date(sub.current_period_end) : null,
    });

    // Pure reduction — nothing to charge, applied at renewal.
    if (!quote.isIncrease) {
      await pool.query(
        `UPDATE subscriptions
         SET pending_seat_quantity = $1,
             pending_device_quantity = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [newEmployees, newTerminals, sub.id]
      );
      return {
        status: 'scheduled' as const,
        applied: false,
        amountDueNow: 0,
        currency: sub.currency,
        effectiveAt: sub.current_period_end,
        newEmployees,
        newTerminals,
      };
    }

    // PayPal cannot take a prorated payment mid-cycle: revising a subscription
    // only changes what the NEXT cycle bills, and it emits no payment event for
    // the difference. Charging nothing while granting the licenses would give
    // away the rest of the period, and waiting for a payment that never arrives
    // would leave the upgrade stuck forever. So on PayPal the extra licenses
    // are scheduled for the next renewal instead, and the admin is told so.
    if (sub.provider === 'paypal') {
      if (sub.provider_subscription_id) {
        const gateway = getPaymentGateway(sub.provider);
        await gateway.updateSubscriptionQuantities({
          providerSubscriptionId: sub.provider_subscription_id,
          newSeatQuantity: newEmployees,
          newDeviceQuantity: newTerminals,
          unitPriceEmployee: parseFloat(sub.unit_price_employee),
          unitPriceDevice: parseFloat(sub.unit_price_device),
          currency: sub.currency,
          immediate: false,
        });
      }

      await pool.query(
        `UPDATE subscriptions
         SET pending_seat_quantity = $1,
             pending_device_quantity = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [newEmployees, newTerminals, sub.id]
      );

      return {
        status: 'scheduled' as const,
        applied: false,
        amountDueNow: 0,
        additionalMonthly: quote.additionalMonthly,
        newMonthlyTotal: quote.newMonthlyTotal,
        currency: sub.currency,
        extraEmployees: quote.extraEmployees,
        extraTerminals: quote.extraTerminals,
        newEmployees,
        newTerminals,
        effectiveAt: sub.current_period_end,
        deferredReason: 'PAYPAL_NO_MIDCYCLE_CHARGE' as const,
      };
    }

    // Increase — charge now.
    //
    // The pending flag is written BEFORE the provider is called, not after.
    // Stripe pays the invoice inside that call and fires
    // invoice.payment_succeeded within milliseconds; if the flag were written
    // afterwards the webhook would arrive first, find nothing pending, grant
    // nothing, and the upgrade would sit "awaiting confirmation" forever.
    await pool.query(
      `UPDATE subscriptions
       SET requested_seat_quantity = $1,
           requested_device_quantity = $2,
           requested_at = NOW(),
           requested_amount_cents = $3,
           requested_invoice_id = NULL,
           updated_at = NOW()
       WHERE id = $4`,
      [newEmployees, newTerminals, quote.amountDueNowCents, sub.id]
    );

    let approveUrl: string | undefined;
    let chargedInvoiceId: string | undefined;

    try {
      if (sub.provider_subscription_id) {
        const gateway = getPaymentGateway(sub.provider);
        const result = await gateway.updateSubscriptionQuantities({
          providerSubscriptionId: sub.provider_subscription_id,
          newSeatQuantity: newEmployees,
          newDeviceQuantity: newTerminals,
          unitPriceEmployee: parseFloat(sub.unit_price_employee),
          unitPriceDevice: parseFloat(sub.unit_price_device),
          currency: sub.currency,
          immediate: true,
          // Bill exactly what was quoted, not the provider's own proration.
          proratedAmountCents: quote.amountDueNowCents,
          // Tied to this exact change on this exact period, so pressing the
          // button twice settles once.
          idempotencyKey:
            `lic:${sub.id}:${newEmployees}x${newTerminals}:` +
            `${sub.current_period_end ? new Date(sub.current_period_end).getTime() : 0}`,
          chargeDescription:
            `Licenze aggiuntive: +${quote.extraEmployees} dipendenti, +${quote.extraTerminals} terminali ` +
            `(${quote.daysRemaining}/${quote.totalDays} giorni)`,
        });
        approveUrl = result.approveUrl;
        chargedInvoiceId = result.proratedInvoiceId;
      }
    } catch (err) {
      // The charge failed, so nothing is pending: release the hold instead of
      // leaving the company unable to try again.
      await pool.query(
        `UPDATE subscriptions
         SET requested_seat_quantity = NULL, requested_device_quantity = NULL,
             requested_at = NULL, requested_amount_cents = NULL,
             requested_invoice_id = NULL, updated_at = NOW()
         WHERE id = $1`,
        [sub.id]
      );
      throw err;
    }

    if (chargedInvoiceId) {
      await pool.query(
        `UPDATE subscriptions SET requested_invoice_id = $1, updated_at = NOW() WHERE id = $2`,
        [chargedInvoiceId, sub.id]
      );
    }

    // The invoice was paid synchronously above, so settle it now rather than
    // making the admin wait for a webhook that may already have been and gone.
    // Both paths are idempotent, so whichever lands second does nothing.
    let applied = false;
    try {
      const settled = await this.reconcilePendingUpgrade(companyId);
      applied = settled.outcome === 'paid';
    } catch (err: any) {
      console.error('[Billing] Immediate settle failed:', err?.message || err);
    }

    // The webhook may have won the race and granted the licenses already, in
    // which case reconcile found nothing left to do. Read the row back and
    // judge by the outcome rather than by who got there first — otherwise a
    // completed upgrade is reported to the admin as still pending.
    if (!applied) {
      const after = await pool.query(
        `SELECT seat_quantity, device_quantity,
                requested_seat_quantity, requested_device_quantity
         FROM subscriptions WHERE id = $1`,
        [sub.id]
      );
      const row = after.rows[0];
      if (
        row &&
        row.requested_seat_quantity === null &&
        row.requested_device_quantity === null &&
        row.seat_quantity >= newEmployees &&
        row.device_quantity >= newTerminals
      ) {
        applied = true;
      }
    }

    return {
      // 'applied' means the money is in and the licenses are usable right now.
      status: applied ? ('applied' as const) : ('awaiting_payment' as const),
      applied,
      amountDueNow: quote.amountDueNow,
      additionalMonthly: quote.additionalMonthly,
      newMonthlyTotal: quote.newMonthlyTotal,
      currency: sub.currency,
      extraEmployees: quote.extraEmployees,
      extraTerminals: quote.extraTerminals,
      newEmployees,
      newTerminals,
      approveUrl,
    };
  }

  /**
   * Starts a hosted page where the admin replaces the saved card.
   *
   * This is the "payment options" path for a company that is already paying:
   * the provider buttons on the billing page only appear when something is
   * unpaid, so without this there would be no way to change card at all.
   */
  async startPaymentMethodUpdate(params: { companyId: number; appBaseUrl?: string }) {
    const subRes = await pool.query(
      `SELECT * FROM subscriptions
       WHERE company_id = $1 AND status IN ('active', 'past_due')
       ORDER BY CASE status WHEN 'active' THEN 1 ELSE 2 END, id DESC
       LIMIT 1`,
      [params.companyId]
    );
    if (subRes.rowCount === 0) {
      throw new BillingError(
        'NO_ACTIVE_SUBSCRIPTION',
        'There is no active subscription to change the payment method on',
        409
      );
    }
    const sub = subRes.rows[0];

    if (sub.provider !== 'stripe') {
      throw new BillingError(
        'PROVIDER_NOT_SUPPORTED',
        'Changing the payment method online is available for card subscriptions. For PayPal, cancel and re-activate to choose a different method.',
        400,
        { provider: sub.provider }
      );
    }

    if (!sub.provider_subscription_id) {
      throw new BillingError(
        'SUBSCRIPTION_NOT_LINKED',
        'This subscription is not linked to the payment provider yet',
        409
      );
    }

    const baseUrl =
      params.appBaseUrl ||
      process.env.CORS_ORIGIN ||
      process.env.APP_BASE_URL ||
      'http://localhost:5173';

    const gateway = getPaymentGateway('stripe') as any;
    const session = await gateway.createPaymentMethodUpdateSession({
      providerSubscriptionId: sub.provider_subscription_id,
      successUrl: `${baseUrl}/impostazioni/fatturazione?payment_method=updated`,
      cancelUrl: `${baseUrl}/impostazioni/fatturazione`,
    });

    return { url: session.url };
  }

  /**
   * Settles an upgrade the webhook never confirmed.
   *
   * The paid-invoice webhook is the normal path, but webhooks get missed: the
   * local forwarding tunnel is not running, the provider retries late, the
   * server restarts mid-delivery. Without a fallback the upgrade would sit in
   * "awaiting confirmation" forever and the admin could neither use the
   * licenses nor buy them again.
   *
   * This asks the provider directly what happened to that exact invoice and
   * finishes the job either way. Safe to call repeatedly: it is a no-op when
   * there is nothing pending, and granting is idempotent.
   */
  async reconcilePendingUpgrade(companyId: number): Promise<
    { changed: boolean; outcome: 'paid' | 'failed' | 'pending' | 'none' }
  > {
    const subRes = await pool.query(
      `SELECT * FROM subscriptions
       WHERE company_id = $1
         AND status IN ('active', 'past_due')
         AND (requested_seat_quantity IS NOT NULL OR requested_device_quantity IS NOT NULL)
       ORDER BY id DESC LIMIT 1`,
      [companyId]
    );
    if (subRes.rowCount === 0) return { changed: false, outcome: 'none' };

    const sub = subRes.rows[0];

    // PayPal upgrades are never left pending — they are scheduled instead.
    if (sub.provider !== 'stripe' || !sub.requested_invoice_id) {
      // Nothing to ask the provider about. Release the hold rather than
      // blocking the admin from ever changing licenses again.
      const ageMs = sub.requested_at ? Date.now() - new Date(sub.requested_at).getTime() : 0;
      if (ageMs > 15 * 60 * 1000) {
        await pool.query(
          `UPDATE subscriptions
           SET requested_seat_quantity = NULL, requested_device_quantity = NULL,
               requested_at = NULL, requested_amount_cents = NULL,
               requested_invoice_id = NULL, updated_at = NOW()
           WHERE id = $1`,
          [sub.id]
        );
        console.warn(
          `[Billing] Released an unverifiable pending upgrade on subscription ${sub.id}`
        );
        return { changed: true, outcome: 'failed' };
      }
      return { changed: false, outcome: 'pending' };
    }

    const gateway = getPaymentGateway('stripe') as any;
    let result: { outcome: 'paid' | 'failed' | 'pending'; hostedUrl?: string; amountCents?: number };
    try {
      result = await gateway.getInvoiceOutcome(sub.requested_invoice_id);
    } catch (err: any) {
      console.error('[Billing] Could not read upgrade invoice:', err?.message || err);
      return { changed: false, outcome: 'pending' };
    }

    if (result.outcome === 'pending') return { changed: false, outcome: 'pending' };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (result.outcome === 'paid') {
        await client.query(
          `UPDATE subscriptions
           SET seat_quantity = COALESCE(requested_seat_quantity, seat_quantity),
               device_quantity = COALESCE(requested_device_quantity, device_quantity),
               requested_seat_quantity = NULL, requested_device_quantity = NULL,
               requested_at = NULL, requested_amount_cents = NULL,
               requested_invoice_id = NULL, updated_at = NOW()
           WHERE id = $1`,
          [sub.id]
        );
        await markHeadcountBilled(companyId, sub.id, client);

        // Record the payment if the webhook never did.
        const existing = await client.query(
          `SELECT id FROM billing_transactions
           WHERE subscription_id = $1 AND provider_invoice_id = $2`,
          [sub.id, sub.requested_invoice_id]
        );
        if (existing.rowCount === 0) {
          await client.query(
            `INSERT INTO billing_transactions (
               company_id, subscription_id, provider, provider_invoice_id,
               amount_cents, currency, status, kind, description,
               seat_quantity, device_quantity, invoice_url, paid_at
             ) VALUES ($1,$2,'stripe',$3,$4,$5,'paid','license_upgrade',$6,$7,$8,$9,NOW())`,
            [
              companyId,
              sub.id,
              sub.requested_invoice_id,
              result.amountCents ?? sub.requested_amount_cents ?? 0,
              sub.currency,
              'Licenze aggiuntive (rateo)',
              sub.requested_seat_quantity ?? sub.seat_quantity,
              sub.requested_device_quantity ?? sub.device_quantity,
              result.hostedUrl ?? null,
            ]
          );
        }
      } else {
        await client.query(
          `UPDATE subscriptions
           SET requested_seat_quantity = NULL, requested_device_quantity = NULL,
               requested_at = NULL, requested_amount_cents = NULL,
               requested_invoice_id = NULL, updated_at = NOW()
           WHERE id = $1`,
          [sub.id]
        );
      }

      await client.query('COMMIT');
      announceBillingChange(sub.company_id, 'settled');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { changed: true, outcome: result.outcome };
  }

  /** Quote only — what a license change would cost, without performing it. */
  async quoteLicenseChange(params: {
    companyId: number;
    employeeLicenses: number;
    terminalLicenses: number;
  }) {
    const subRes = await pool.query(
      `SELECT * FROM subscriptions
       WHERE company_id = $1 AND status IN ('active', 'past_due')
       ORDER BY CASE status WHEN 'active' THEN 1 ELSE 2 END, id DESC
       LIMIT 1`,
      [params.companyId]
    );

    const compRes = await pool.query(
      `SELECT price_per_employee, price_per_device, currency FROM companies WHERE id = $1`,
      [params.companyId]
    );
    const company = compRes.rows[0] || {};
    const sub = subRes.rowCount ? subRes.rows[0] : null;

    return priceLicenseChange({
      currentEmployees: sub ? sub.seat_quantity : 0,
      currentTerminals: sub ? sub.device_quantity : 0,
      newEmployees: Math.floor(params.employeeLicenses),
      newTerminals: Math.floor(params.terminalLicenses),
      unitPriceEmployee: parseFloat(
        sub ? sub.unit_price_employee : company.price_per_employee || '0'
      ),
      unitPriceDevice: parseFloat(
        sub ? sub.unit_price_device : company.price_per_device || '0'
      ),
      periodStart: sub?.current_period_start ? new Date(sub.current_period_start) : null,
      periodEnd: sub?.current_period_end ? new Date(sub.current_period_end) : null,
    });
  }

  /**
   * 8. Cancel Subscription
   */
  async cancelSubscription(companyId: number) {
    const subRes = await pool.query(
      `SELECT * FROM subscriptions 
       WHERE company_id = $1 AND status IN ('active', 'past_due')
       ORDER BY id DESC LIMIT 1`,
      [companyId]
    );

    if (subRes.rowCount === 0) {
      throw new Error('No active subscription to cancel');
    }

    const sub = subRes.rows[0];
    if (sub.provider_subscription_id) {
      const gateway = getPaymentGateway(sub.provider);
      await gateway.cancelSubscription(sub.provider_subscription_id, true);
    }

    await pool.query(
      `UPDATE subscriptions 
       SET cancel_at_period_end = true,
           updated_at = NOW()
       WHERE id = $1`,
      [sub.id]
    );

    return { success: true };
  }

  /**
   * 9. Reactivate Subscription
   */
  async reactivateSubscription(companyId: number) {
    const subRes = await pool.query(
      `SELECT * FROM subscriptions 
       WHERE company_id = $1 AND status IN ('active', 'past_due') AND cancel_at_period_end = true
       ORDER BY id DESC LIMIT 1`,
      [companyId]
    );

    if (subRes.rowCount === 0) {
      throw new Error('No canceled subscription available to reactivate');
    }

    const sub = subRes.rows[0];
    if (sub.provider_subscription_id) {
      const gateway = getPaymentGateway(sub.provider);
      await gateway.reactivateSubscription(sub.provider_subscription_id);
    }

    await pool.query(
      `UPDATE subscriptions 
       SET cancel_at_period_end = false,
           updated_at = NOW()
       WHERE id = $1`,
      [sub.id]
    );

    return { success: true };
  }

  /**
   * 10. Check billing access (for billingGuard middleware)
   */
  async checkBillingAccess(companyId: number): Promise<{
    hasAccess: boolean;
    isBlocked: boolean;
    reason?: 'NO_SUBSCRIPTION' | 'GRACE_PERIOD_EXPIRED' | 'PAST_DUE';
    gracePeriodEndsAt?: Date;
  }> {
    // Rank by standing, not by recency: starting a new checkout (which inserts
    // a 'pending' row) must never revoke access from a company whose current
    // subscription is still active or inside its grace period.
    const subRes = await pool.query(
      `SELECT status, grace_period_ends_at, current_period_end 
       FROM subscriptions 
       WHERE company_id = $1
       ORDER BY CASE status
                  WHEN 'active'   THEN 1
                  WHEN 'past_due' THEN 2
                  ELSE 3
                END, id DESC
       LIMIT 1`,
      [companyId]
    );

    if (subRes.rowCount === 0) {
      return {
        hasAccess: false,
        isBlocked: true,
        reason: 'NO_SUBSCRIPTION',
      };
    }

    const sub = subRes.rows[0];
    const now = new Date();

    if (sub.status === 'active') {
      return { hasAccess: true, isBlocked: false };
    }

    // 'unpaid' is what the nightly job flips an expired past_due into — it is
    // the same blocked state, so it must report the same reason.
    if (sub.status === 'unpaid') {
      return { hasAccess: false, isBlocked: true, reason: 'GRACE_PERIOD_EXPIRED' };
    }

    if (sub.status === 'past_due') {
      const graceEnd = sub.grace_period_ends_at
        ? new Date(sub.grace_period_ends_at)
        : null;
      if (graceEnd && now < graceEnd) {
        return {
          hasAccess: true,
          isBlocked: false,
          reason: 'PAST_DUE',
          gracePeriodEndsAt: graceEnd,
        };
      }
      return {
        hasAccess: false,
        isBlocked: true,
        reason: 'GRACE_PERIOD_EXPIRED',
      };
    }

    return {
      hasAccess: false,
      isBlocked: true,
      reason: 'NO_SUBSCRIPTION',
    };
  }

  /**
   * 11. Super Admin Billing Overview Dashboard
   */
  async getSuperAdminBillingOverview() {
    const query = `
      SELECT 
        c.id, c.name, c.slug, c.currency,
        c.price_per_employee, c.price_per_device,
        c.bill_reminder_days_before, c.grace_period_days,
        (SELECT COUNT(*)::int FROM users u WHERE u.company_id = c.id AND u.status = 'active' AND u.role != 'store_terminal') AS employee_count,
        (SELECT COUNT(*)::int FROM users u WHERE u.company_id = c.id AND u.status = 'active' AND u.role = 'store_terminal' AND (u.registered_device_token IS NOT NULL OR u.registered_device_identifier IS NOT NULL)) AS active_devices_count,
        s.id AS subscription_id,
        s.provider,
        s.status AS subscription_status,
        s.seat_quantity,
        s.device_quantity,
        s.current_period_start,
        s.current_period_end,
        s.cancel_at_period_end,
        s.grace_period_ends_at,
        (SELECT MAX(t.paid_at) FROM billing_transactions t WHERE t.company_id = c.id AND t.status = 'paid') AS last_paid_at,
        (SELECT SUM(t.amount_cents)::int FROM billing_transactions t WHERE t.company_id = c.id AND t.status = 'paid') AS total_revenue_cents
      FROM companies c
      LEFT JOIN LATERAL (
        SELECT * FROM subscriptions sub
        WHERE sub.company_id = c.id
        ORDER BY CASE WHEN sub.status = 'active' THEN 1 WHEN sub.status = 'past_due' THEN 2 ELSE 3 END, sub.id DESC
        LIMIT 1
      ) s ON true
      WHERE c.is_active = true
      ORDER BY c.name ASC
    `;

    const res = await pool.query(query);
    return res.rows;
  }
}

export const subscriptionService = new SubscriptionService();
