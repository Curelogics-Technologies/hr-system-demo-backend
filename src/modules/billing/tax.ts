import { pool } from '../../config/database';

/**
 * The one tax rate the platform charges on a subscription.
 *
 * The rate is created once by hand in the Stripe dashboard, and the provider is
 * what computes and collects it - Stripe from the Tax Rate object attached to
 * the subscription, PayPal from the `taxes.percentage` written onto the plan.
 * Nothing in this codebase ever adds tax to a charge.
 *
 * But the app still has to *know* the rate: to show the customer the same
 * subtotal / tax / total they are about to be billed, and to write the right
 * percentage onto the PayPal plan so the two providers stay aligned. Asking
 * Stripe in the middle of rendering a total is not an option, so the rate is
 * mirrored into `billing_tax_settings` and read from there.
 *
 *   Stripe dashboard  ->  billing_tax_settings  ->  every screen, and PayPal
 *      (authority)          (local mirror)              (consumers)
 *
 * The mirror is refreshed at boot, daily, and on demand from the billing page.
 * `syncedAt` travels with the rate everywhere, because "the rate is 22%" and
 * "the rate was 22% when we last managed to ask" are different statements.
 *
 * Configuration:
 *
 *   STRIPE_TAX_RATE_ID=txr_...    which dashboard Tax Rate to mirror
 *   BILLING_TAX_PERCENT=22        fallback only - used before the first
 *                                 successful sync, or if Stripe is unreachable
 *                                 and nothing has ever been stored
 */

export interface TaxConfig {
  /** Percentage points, e.g. 22 for 22% IVA. Zero when tax is not configured. */
  percent: number;
  /** The Stripe Tax Rate object attached to subscriptions and invoice items. */
  stripeTaxRateId: string | null;
  enabled: boolean;
  /** Stripe's own label for the rate, e.g. "IVA". */
  displayName: string | null;
  jurisdiction: string | null;
  /** True when the rate is carved out of the price instead of added on top. */
  inclusive: boolean;
  active: boolean;
  /** 'stripe' once mirrored from the provider, 'env' while still a fallback. */
  source: 'stripe' | 'env';
  syncedAt: Date | null;
  syncError: string | null;
}

/**
 * The rate as last read from storage.
 *
 * Held in memory because pricing is worked out in synchronous code - a quote, a
 * receipt line, a PayPal plan body - and none of those can wait on a query. It
 * is refreshed by `loadTaxConfig` at boot and by every sync; a process that has
 * never loaded it falls back to the environment rather than to zero, so a
 * misconfigured deployment undercharges nobody silently.
 */
let cached: TaxConfig | null = null;

/** The environment-only view, used before anything has been loaded or stored. */
function envTaxConfig(): TaxConfig {
  const raw = process.env.BILLING_TAX_PERCENT;
  const parsed = raw === undefined || raw === '' ? 0 : Number(raw);

  // A malformed value must not silently become "no tax": a deployment that
  // meant to charge 22% and typed "22%" would otherwise undercharge forever.
  const percent =
    Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 0;
  if (percent !== parsed) {
    console.warn(
      `[Billing] BILLING_TAX_PERCENT is not a usable percentage ("${raw}"); no tax will be applied.`
    );
  }

  const id = (process.env.STRIPE_TAX_RATE_ID || '').trim();

  return {
    percent,
    stripeTaxRateId: id && !id.includes('...') ? id : null,
    enabled: percent > 0,
    displayName: null,
    jurisdiction: null,
    inclusive: false,
    active: true,
    source: 'env',
    syncedAt: null,
    syncError: null,
  };
}

/**
 * The rate in force, synchronously.
 *
 * Every pricing path calls this. It never queries: it returns the mirror loaded
 * at boot, or the environment fallback if the mirror has not been loaded yet.
 */
export function getTaxConfig(): TaxConfig {
  return cached ?? envTaxConfig();
}

function rowToConfig(row: any): TaxConfig {
  const percent = parseFloat(row.percent ?? '0') || 0;
  return {
    percent,
    stripeTaxRateId: row.stripe_tax_rate_id || null,
    enabled: percent > 0,
    displayName: row.display_name || null,
    jurisdiction: row.jurisdiction || null,
    inclusive: row.inclusive === true,
    active: row.active !== false,
    source: row.source === 'stripe' ? 'stripe' : 'env',
    syncedAt: row.synced_at ? new Date(row.synced_at) : null,
    syncError: row.sync_error || null,
  };
}

/**
 * Loads the mirror into memory.
 *
 * A stored row that has never been synced carries percent 0, which would mean
 * "bill net" - so before the first successful sync the environment still wins.
 * After a sync the stored rate is authoritative, including a stored zero, which
 * at that point is a real answer from Stripe rather than an empty table.
 */
export async function loadTaxConfig(): Promise<TaxConfig> {
  try {
    const res = await pool.query(
      `SELECT * FROM billing_tax_settings WHERE id = 1 LIMIT 1`
    );
    if (res.rowCount) {
      const stored = rowToConfig(res.rows[0]);
      if (stored.source === 'stripe') {
        cached = stored;
      } else {
        // Not yet synced, so the percentage still comes from configuration -
        // but a rate id chosen in the UI has to survive, or the next sync
        // would go looking for the environment's id instead of the one the
        // operator just picked.
        cached = {
          ...envTaxConfig(),
          stripeTaxRateId: stored.stripeTaxRateId ?? envTaxConfig().stripeTaxRateId,
          syncError: stored.syncError,
        };
      }
      return cached;
    }
  } catch (err: any) {
    // A missing table means the migration has not run yet. The app must still
    // start and still bill correctly from configuration.
    console.warn('[Billing] Could not read the stored tax rate:', err?.message || err);
  }
  cached = envTaxConfig();
  return cached;
}

/** Test seam: drops the in-memory mirror so the next read re-derives it. */
export function resetTaxConfigCache(): void {
  cached = null;
}

/**
 * Points the platform at a different Stripe Tax Rate.
 *
 * The rate itself is still created and owned in the Stripe dashboard - this
 * only records *which* of them this platform charges, which is the one part of
 * the arrangement that is genuinely a local decision. Everything else about
 * the rate is read back from Stripe by the sync that follows.
 *
 * Clearing the id (empty string) turns tax off after the next sync.
 */
export async function setStripeTaxRateId(rateId: string | null): Promise<void> {
  const clean = (rateId || '').trim();
  await pool.query(
    `UPDATE billing_tax_settings
        SET stripe_tax_rate_id = $1,
            -- The stored percentage described the previous rate. Marking the
            -- row unsynced stops it being quoted as though it described the
            -- new one, until Stripe has actually been asked.
            source     = 'env',
            sync_error = NULL,
            synced_at  = NULL,
            updated_at = NOW()
      WHERE id = 1`,
    [clean || null]
  );
  cached = { ...envTaxConfig(), stripeTaxRateId: clean || null };
}

export interface StripeTaxRateDescription {
  percentage: number;
  inclusive: boolean;
  active: boolean;
  displayName: string | null;
  jurisdiction: string | null;
}

/**
 * Refreshes the mirror from Stripe.
 *
 * Reads the Tax Rate named by STRIPE_TAX_RATE_ID and stores what it says. A
 * failure is recorded on the row rather than thrown away, so the billing page
 * can show "last synced three days ago, and the last attempt failed because…"
 * instead of presenting a stale rate as current.
 *
 * The Stripe call is injected so this module stays free of the Stripe SDK and
 * can be tested without it.
 */
export async function syncTaxRateFromStripe(
  describe: (id: string) => Promise<StripeTaxRateDescription | null>
): Promise<TaxConfig> {
  // The id chosen in the UI wins over the environment: it is the more recent,
  // more deliberate statement of which Stripe rate this platform charges.
  const stored = (cached?.stripeTaxRateId || '').trim();
  const fromEnv = (process.env.STRIPE_TAX_RATE_ID || '').trim();
  const rateId = stored || fromEnv;
  const usableId = rateId && !rateId.includes('...') ? rateId : null;

  if (!usableId) {
    const message =
      'STRIPE_TAX_RATE_ID is not set, so there is no rate to mirror from Stripe.';
    await recordSyncFailure(null, message);
    cached = envTaxConfig();
    cached.syncError = message;
    return cached;
  }

  let rate: StripeTaxRateDescription | null;
  try {
    rate = await describe(usableId);
  } catch (err: any) {
    const message = `Stripe could not be reached: ${err?.message || err}`;
    await recordSyncFailure(usableId, message);
    // Keep serving the last known good rate. Falling back to zero here would
    // stop charging tax because of a network blip.
    cached = { ...getTaxConfig(), syncError: message };
    return cached;
  }

  if (!rate) {
    const message = `Stripe has no tax rate ${usableId} on this account.`;
    await recordSyncFailure(usableId, message);
    cached = { ...getTaxConfig(), syncError: message };
    return cached;
  }

  try {
    const res = await pool.query(
      `UPDATE billing_tax_settings
          SET stripe_tax_rate_id = $1,
              percent            = $2,
              display_name       = $3,
              jurisdiction       = $4,
              inclusive          = $5,
              active             = $6,
              source             = 'stripe',
              synced_at          = NOW(),
              sync_error         = NULL,
              updated_at         = NOW()
        WHERE id = 1
        RETURNING *`,
      [
        usableId,
        rate.percentage,
        rate.displayName,
        rate.jurisdiction,
        rate.inclusive,
        rate.active,
      ]
    );
    if (res.rowCount) {
      cached = rowToConfig(res.rows[0]);
      return cached;
    }
  } catch (err: any) {
    console.warn('[Billing] Could not store the synced tax rate:', err?.message || err);
  }

  // Storage failed but Stripe answered: serve what Stripe said for this
  // process rather than an older figure.
  cached = {
    percent: rate.percentage,
    stripeTaxRateId: usableId,
    enabled: rate.percentage > 0,
    displayName: rate.displayName,
    jurisdiction: rate.jurisdiction,
    inclusive: rate.inclusive,
    active: rate.active,
    source: 'stripe',
    syncedAt: new Date(),
    syncError: null,
  };
  return cached;
}

async function recordSyncFailure(rateId: string | null, message: string): Promise<void> {
  console.warn(`[Billing] Tax rate sync failed: ${message}`);
  try {
    await pool.query(
      `UPDATE billing_tax_settings
          SET stripe_tax_rate_id = COALESCE($1, stripe_tax_rate_id),
              sync_error = $2,
              updated_at = NOW()
        WHERE id = 1`,
      [rateId, message]
    );
  } catch {
    // The failure is already logged; a second failure writing it down changes
    // nothing the operator can act on.
  }
}

/**
 * Warnings worth seeing at boot, once the mirror has been refreshed.
 *
 * The three things that silently misbill: an inclusive rate (tax carved out of
 * the price instead of added to it), an archived rate (Stripe will refuse it),
 * and a `BILLING_TAX_PERCENT` that disagrees with what Stripe actually charges.
 */
export function reportTaxConfiguration(cfg: TaxConfig = getTaxConfig()): void {
  if (!cfg.enabled && cfg.source === 'env' && !cfg.stripeTaxRateId) {
    console.log('[Billing] No tax rate configured - subscriptions are billed net.');
    return;
  }

  if (cfg.source !== 'stripe') {
    console.warn(
      `[Billing] Tax rate ${cfg.percent}% is coming from configuration, not from Stripe` +
        (cfg.syncError ? `: ${cfg.syncError}` : '.')
    );
    return;
  }

  if (cfg.inclusive) {
    console.error(
      `[Billing] Stripe tax rate ${cfg.stripeTaxRateId} is INCLUSIVE. The platform bills ` +
        'tax on top of the licence price and expects an exclusive rate.'
    );
  }
  if (!cfg.active) {
    console.error(
      `[Billing] Stripe tax rate ${cfg.stripeTaxRateId} is archived; Stripe will refuse it ` +
        'on new subscriptions.'
    );
  }

  const envPercent = Number(process.env.BILLING_TAX_PERCENT);
  if (Number.isFinite(envPercent) && Math.abs(envPercent - cfg.percent) > 0.001) {
    console.warn(
      `[Billing] BILLING_TAX_PERCENT is ${envPercent} but Stripe charges ${cfg.percent}%. ` +
        'Stripe wins; update the environment variable to match.'
    );
  }

  console.log(
    `✓ Billing tax rate ${cfg.percent}%${cfg.displayName ? ` (${cfg.displayName})` : ''} ` +
      `mirrored from Stripe ${cfg.stripeTaxRateId}`
  );
}

/**
 * The tax due on one amount, in cents.
 *
 * Rounded to whole cents here because that is what the provider charges: a
 * fraction of a cent carried into a later sum would leave our total a cent
 * away from the invoice.
 */
export function taxCentsOn(netCents: number, percent = getTaxConfig().percent): number {
  if (!(percent > 0) || !Number.isFinite(netCents) || netCents === 0) return 0;
  return Math.round((netCents * percent) / 100);
}

/**
 * The tax due on an invoice made of several lines.
 *
 * Both providers tax each line and then add the results up, so tax on the sum
 * is not always tax on the lines - the two can differ by a cent, and the
 * estimate the admin approves has to be the figure that gets charged, not one
 * that is usually the same.
 */
export function taxCentsOnLines(lineNetCents: number[], percent = getTaxConfig().percent): number {
  if (!(percent > 0)) return 0;
  return lineNetCents.reduce((sum, cents) => sum + taxCentsOn(cents, percent), 0);
}

export interface TaxedAmount {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxPercent: number;
}

/** Splits a net amount into the subtotal / tax / total triple shown on screen. */
export function taxed(netCents: number, lines?: number[]): TaxedAmount {
  const { percent } = getTaxConfig();
  const taxCents = lines ? taxCentsOnLines(lines, percent) : taxCentsOn(netCents, percent);
  return {
    subtotalCents: netCents,
    taxCents,
    totalCents: netCents + taxCents,
    taxPercent: percent,
  };
}

/** The shape the API and the UI use to describe the rate. */
export function describeTaxConfig(cfg: TaxConfig = getTaxConfig()) {
  return {
    percent: cfg.percent,
    enabled: cfg.enabled,
    stripeTaxRateId: cfg.stripeTaxRateId,
    displayName: cfg.displayName,
    jurisdiction: cfg.jurisdiction,
    inclusive: cfg.inclusive,
    active: cfg.active,
    source: cfg.source,
    syncedAt: cfg.syncedAt,
    syncError: cfg.syncError,
    /** What is written onto a PayPal plan, so the two providers can be compared. */
    paypalPercent: cfg.percent,
  };
}
