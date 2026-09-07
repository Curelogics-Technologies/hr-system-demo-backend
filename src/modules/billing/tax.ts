/**
 * The one tax rate the platform charges on a subscription.
 *
 * The rate itself lives at the provider: a Tax Rate object created once in the
 * Stripe dashboard, and the `taxes.percentage` written onto the PayPal plan.
 * The provider is what actually computes and collects the tax, so nothing here
 * ever adds tax to a charge - this module only knows *which* rate is in force,
 * so the app can show the same subtotal / tax / total the customer is about to
 * be charged, and record the split on the receipt afterwards.
 *
 * Configuration (both required for a Stripe deployment):
 *
 *   BILLING_TAX_PERCENT=22        the rate, as a percentage
 *   STRIPE_TAX_RATE_ID=txr_...    the dashboard Tax Rate carrying that rate
 *
 * Leaving BILLING_TAX_PERCENT unset (or 0) turns tax off everywhere, which is
 * the behaviour every deployment had before this existed.
 */

export interface TaxConfig {
  /** Percentage points, e.g. 22 for 22% IVA. Zero when tax is not configured. */
  percent: number;
  /** The Stripe Tax Rate object to attach to subscriptions and invoice items. */
  stripeTaxRateId: string | null;
  enabled: boolean;
}

export function getTaxConfig(): TaxConfig {
  const raw = process.env.BILLING_TAX_PERCENT;
  const parsed = raw === undefined || raw === '' ? 0 : Number(raw);
  // A malformed value must not silently become "no tax": a deployment that
  // meant to charge 22% and typed "22%" would otherwise undercharge forever.
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    console.warn(
      `[Billing] BILLING_TAX_PERCENT is not a usable percentage ("${raw}"); no tax will be applied.`
    );
    return { percent: 0, stripeTaxRateId: null, enabled: false };
  }

  const id = (process.env.STRIPE_TAX_RATE_ID || '').trim();
  const stripeTaxRateId = id && !id.includes('...') ? id : null;

  return {
    percent: parsed,
    stripeTaxRateId,
    enabled: parsed > 0,
  };
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
 * is not always tax on the lines: 22% of €10.01 and of €20.03 rounds to
 * €2.20 + €4.41 = €6.61, while 22% of their sum rounds to €6.61 too - but the
 * pair can differ by a cent, and the estimate the admin approves has to be the
 * figure that gets charged, not one that is usually the same.
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

/**
 * Warns, at boot, when the configured percentage and the Stripe Tax Rate
 * disagree.
 *
 * They are two separate settings describing one rate, and only Stripe's is
 * charged. A mismatch means every screen in the app quotes a total the
 * customer is not billed - silent, and only discoverable by comparing an
 * invoice by hand - so it is worth one API call on startup to catch it.
 */
export async function verifyTaxConfiguration(
  fetchStripeRate: (id: string) => Promise<{ percentage: number; inclusive: boolean } | null>
): Promise<void> {
  const cfg = getTaxConfig();

  if (!cfg.enabled) {
    console.log('[Billing] No tax rate configured (BILLING_TAX_PERCENT unset) - charges are net.');
    return;
  }

  if (!cfg.stripeTaxRateId) {
    console.warn(
      `[Billing] BILLING_TAX_PERCENT=${cfg.percent} but STRIPE_TAX_RATE_ID is not set: ` +
        'Stripe subscriptions will be created without tax.'
    );
    return;
  }

  try {
    const rate = await fetchStripeRate(cfg.stripeTaxRateId);
    if (!rate) {
      console.error(
        `[Billing] STRIPE_TAX_RATE_ID ${cfg.stripeTaxRateId} does not exist on this Stripe account.`
      );
      return;
    }
    if (rate.inclusive) {
      console.error(
        `[Billing] Stripe tax rate ${cfg.stripeTaxRateId} is inclusive; the platform bills tax ` +
          'on top of the licence price and expects an exclusive rate.'
      );
    }
    if (Math.abs(rate.percentage - cfg.percent) > 0.001) {
      console.error(
        `[Billing] Tax rate mismatch: Stripe charges ${rate.percentage}% but ` +
          `BILLING_TAX_PERCENT is ${cfg.percent}. Every quoted total will be wrong ` +
          'until they agree.'
      );
    } else {
      console.log(
        `✓ Billing tax rate ${cfg.percent}% verified against Stripe (${cfg.stripeTaxRateId})`
      );
    }
  } catch (err: any) {
    console.warn('[Billing] Could not verify the Stripe tax rate:', err?.message || err);
  }
}
