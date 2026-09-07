import { getPaymentGateway } from './gateway.factory';
import { loadTaxConfig, reportTaxConfiguration, syncTaxRateFromStripe } from './tax';

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
