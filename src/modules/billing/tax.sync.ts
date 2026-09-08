import { pool } from '../../config/database';
import { getPaymentGateway } from './gateway.factory';
import { getTaxConfig, loadTaxConfig, reportTaxConfiguration, syncTaxRateFromStripe } from './tax';

/**
 * Brings the local copy of the tax rate back in line with Stripe.
 *
 * Stripe owns the rate; this app only mirrors it so a total can be rendered
 * without a network call. Any mirror goes stale - somebody edits the rate in
 * the dashboard, or the first sync happened while Stripe was unreachable - and
 * a stale rate is visible on every price the customer sees.
 *
 * Cheap to run and safe to repeat: it only reads at Stripe.
 *
 * Lives in its own file so `tax.ts` stays free of the Stripe SDK (it takes the
 * lookup as an argument, which is what makes it testable) and so the HTTP layer
 * does not have to reach into the cron module to trigger a refresh.
 */
export async function syncBillingTaxRate(): Promise<void> {
  await loadTaxConfig();
  const cfg = await syncTaxRateFromStripe(async (id) => {
    const gateway = getPaymentGateway('stripe') as any;
    return gateway.describeTaxRate ? gateway.describeTaxRate(id) : null;
  });
  reportTaxConfiguration(cfg);
}

export interface TaxRealignment {
  /** Stripe subscriptions whose attached rate was corrected. */
  stripeUpdated: number;
  stripeChecked: number;
  /** Subscriptions the provider would not let us correct without approval. */
  paypalStale: number;
  errors: string[];
}

/**
 * Makes live subscriptions charge the rate the platform currently says it
 * charges.
 *
 * Two things make this necessary rather than tidy. A Stripe Tax Rate object is
 * immutable, so changing the percentage means creating a new object - every
 * existing subscription keeps pointing at the old one until told otherwise.
 * And a subscription opened before any rate was configured carries none at
 * all, which is exactly the state of the first customers of a deployment that
 * has just been set up.
 *
 * Stripe can be corrected silently: attaching a default tax rate neither
 * prorates nor needs the customer to approve anything.
 *
 * PayPal cannot. Its tax percentage lives on the plan, and moving a
 * subscription to a different plan changes the amount charged, which PayPal
 * requires the subscriber to approve. So those are counted and reported rather
 * than silently left wrong: they pick the new rate up at their next licence
 * change, which is the next time the subscriber approves a revision anyway.
 */
export async function realignSubscriptionTaxRates(): Promise<TaxRealignment> {
  const result: TaxRealignment = {
    stripeUpdated: 0,
    stripeChecked: 0,
    paypalStale: 0,
    errors: [],
  };

  const cfg = getTaxConfig();

  // Only act on a rate confirmed by Stripe. Realigning to a cold-start
  // fallback could attach a placeholder id, or strip a correct rate off every
  // subscription because this process could not reach Stripe at boot.
  if (cfg.source !== 'stripe') {
    return result;
  }

  let subs;
  try {
    subs = await pool.query(
      `SELECT id, company_id, provider, provider_subscription_id
         FROM subscriptions
        WHERE status IN ('active', 'past_due')
          AND provider_subscription_id IS NOT NULL`
    );
  } catch (err: any) {
    result.errors.push(`Could not list subscriptions: ${err?.message || err}`);
    return result;
  }

  for (const sub of subs.rows) {
    if (sub.provider === 'paypal') {
      // The percentage was written onto the plan when the subscription was
      // created or last revised. There is no way to change it from here
      // without the subscriber approving a new plan.
      result.paypalStale++;
      continue;
    }

    try {
      const gateway = getPaymentGateway('stripe') as any;
      if (!gateway.setSubscriptionTaxRate) continue;
      result.stripeChecked++;
      const changed = await gateway.setSubscriptionTaxRate(
        sub.provider_subscription_id,
        cfg.stripeTaxRateId
      );
      if (changed) {
        result.stripeUpdated++;
        console.log(
          `[BillingJob] Attached tax rate ${cfg.stripeTaxRateId} to subscription ${sub.id} (company ${sub.company_id})`
        );
      }
    } catch (err: any) {
      const message = `subscription ${sub.id}: ${err?.message || err}`;
      result.errors.push(message);
      console.error(`[BillingJob] Tax realignment failed for ${message}`);
    }
  }

  if (result.stripeUpdated > 0 || result.errors.length > 0) {
    console.log(
      `[BillingJob] Tax realignment: ${result.stripeUpdated}/${result.stripeChecked} Stripe subscriptions updated, ` +
        `${result.paypalStale} PayPal subscriptions unchanged, ${result.errors.length} errors`
    );
  }

  return result;
}
