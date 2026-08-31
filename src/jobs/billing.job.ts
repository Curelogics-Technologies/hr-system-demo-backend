import cron from 'node-cron';
import { pool } from '../config/database';
import { getPaymentGateway } from '../modules/billing/gateway.factory';
import { sendEmailForCompany } from '../services/email.service';
import { subscriptionService } from '../modules/billing/subscription.service';

/**
 * Applies license reductions the admin scheduled during the period.
 *
 * Licenses are what the company bought, not how many users happen to exist,
 * so nothing is recounted here. Only an explicit reduction parked in
 * pending_* is pushed to the gateway, and only as the new period begins.
 */
export async function processBillingRenewalReconciliations() {
  try {
    const subRes = await pool.query(
      `SELECT s.*, c.name AS company_name
       FROM subscriptions s
       JOIN companies c ON c.id = s.company_id
       WHERE s.status = 'active'
         AND s.current_period_end IS NOT NULL
         AND s.current_period_end <= NOW() + INTERVAL '24 hours'
         AND (s.pending_seat_quantity IS NOT NULL OR s.pending_device_quantity IS NOT NULL)`
    );

    for (const sub of subRes.rows) {
      try {
        const targetSeats =
          sub.pending_seat_quantity !== null ? sub.pending_seat_quantity : sub.seat_quantity;
        const targetDevices =
          sub.pending_device_quantity !== null ? sub.pending_device_quantity : sub.device_quantity;

        console.log(
          `[BillingJob] Applying scheduled license reduction for ${sub.company_name} (seats ${sub.seat_quantity} -> ${targetSeats}, terminals ${sub.device_quantity} -> ${targetDevices})`
        );

        if (sub.provider_subscription_id) {
          const gateway = getPaymentGateway(sub.provider);
          await gateway.updateSubscriptionQuantities({
            providerSubscriptionId: sub.provider_subscription_id,
            newSeatQuantity: targetSeats,
            newDeviceQuantity: targetDevices,
            unitPriceEmployee: parseFloat(sub.unit_price_employee),
            unitPriceDevice: parseFloat(sub.unit_price_device),
            currency: sub.currency,
            immediate: false, // takes effect at renewal, never refunded
          });
        }

        await pool.query(
          `UPDATE subscriptions
           SET seat_quantity = $1,
               device_quantity = $2,
               pending_seat_quantity = NULL,
               pending_device_quantity = NULL,
               updated_at = NOW()
           WHERE id = $3`,
          [targetSeats, targetDevices, sub.id]
        );
      } catch (err: any) {
        console.error(
          `[BillingJob] Error applying reduction for subscription ${sub.id}:`,
          err.message
        );
      }
    }
  } catch (err: any) {
    console.error('[BillingJob] Error in renewal reconciliation:', err);
  }
}

/**
 * Settles license upgrades still waiting on a payment confirmation.
 *
 * The billing page reconciles on load, but a company that never opens it would
 * otherwise keep a hold forever. This closes the loop nightly.
 */
export async function processStuckLicenseUpgrades() {
  try {
    const res = await pool.query(
      `SELECT DISTINCT company_id FROM subscriptions
       WHERE status IN ('active', 'past_due')
         AND (requested_seat_quantity IS NOT NULL OR requested_device_quantity IS NOT NULL)`
    );

    for (const row of res.rows) {
      try {
        const outcome = await subscriptionService.reconcilePendingUpgrade(row.company_id);
        if (outcome.changed) {
          console.log(
            `[BillingJob] Settled pending upgrade for company ${row.company_id}: ${outcome.outcome}`
          );
        }
      } catch (err: any) {
        console.error(
          `[BillingJob] Could not settle upgrade for company ${row.company_id}:`,
          err?.message || err
        );
      }
    }
  } catch (err: any) {
    console.error('[BillingJob] Error sweeping stuck upgrades:', err);
  }
}

export async function processBillingReminders() {
  try {
    // Find active subscriptions where current_period_end is approaching within bill_reminder_days_before days
    const subRes = await pool.query(
      `SELECT s.*, c.name AS company_name, c.company_email, 
              c.price_per_employee, c.price_per_device,
              c.bill_reminder_days_before
       FROM subscriptions s
       JOIN companies c ON c.id = s.company_id
       WHERE s.status = 'active'
         AND s.current_period_end IS NOT NULL
         AND s.current_period_end <= NOW() + (COALESCE(c.bill_reminder_days_before, 3) * INTERVAL '1 day')
         AND s.current_period_end > NOW()
         AND (
           s.reminder_sent_at IS NULL
           OR (s.current_period_start IS NOT NULL AND s.reminder_sent_at < s.current_period_start)
         )`
    );

    for (const sub of subRes.rows) {
      if (sub.company_email) {
        const nextTotal = (
          sub.seat_quantity * parseFloat(sub.unit_price_employee) +
          sub.device_quantity * parseFloat(sub.unit_price_device)
        ).toFixed(2);

        const renewalDate = new Date(sub.current_period_end).toLocaleDateString('it-IT');

        await sendEmailForCompany(sub.company_id, {
          to: sub.company_email,
          subject: `Promemoria rinnovo abbonamento VeylOHR - ${sub.company_name}`,
          html: `<p>Gentile Cliente,</p><p>Ti informiamo che il tuo abbonamento mensile VeylOHR per <strong>${sub.company_name}</strong> si rinnoverà il <strong>${renewalDate}</strong>.</p><p>Importo previsto: <strong>€${nextTotal}</strong> (${sub.seat_quantity} dipendenti attivi, ${sub.device_quantity} terminali).</p><p>Cordiali saluti,<br>Team VeylOHR</p>`,
          text: `Gentile Cliente,\n\nTi informiamo che il tuo abbonamento mensile VeylOHR per ${sub.company_name} si rinnoverà il ${renewalDate}.\n\nImporto previsto: €${nextTotal} (${sub.seat_quantity} dipendenti attivi, ${sub.device_quantity} terminali).\n\nCordiali saluti,\nTeam VeylOHR`,
        })
          .then(async () => {
            // Stamp only on success, so a transient mail failure is retried on
            // the next daily run instead of being silently swallowed.
            await pool.query(
              `UPDATE subscriptions SET reminder_sent_at = NOW() WHERE id = $1`,
              [sub.id]
            );
          })
          .catch((err: any) =>
            console.warn(`[BillingJob] Could not send reminder email to ${sub.company_email}:`, err.message)
          );
      }
    }
  } catch (err: any) {
    console.error('[BillingJob] Error in billing reminders:', err);
  }
}

export async function processBillingGracePeriodExpirations() {
  try {
    // Find past_due subscriptions where grace period has ended
    const expiredRes = await pool.query(
      `UPDATE subscriptions 
       SET status = 'unpaid', updated_at = NOW()
       WHERE status = 'past_due'
         AND grace_period_ends_at IS NOT NULL
         AND grace_period_ends_at < NOW()
       RETURNING id, company_id`
    );

    if (expiredRes.rowCount && expiredRes.rowCount > 0) {
      console.log(
        `[BillingJob] Marked ${expiredRes.rowCount} subscriptions as unpaid due to expired grace periods.`
      );
    }
  } catch (err: any) {
    console.error('[BillingJob] Error checking grace period expirations:', err);
  }
}

/**
 * Registers the cron schedule (Runs daily at 02:00 AM)
 */
export function startBillingCron() {
  cron.schedule('0 2 * * *', async () => {
    console.log('[BillingJob] Running daily billing jobs...');
    await processStuckLicenseUpgrades();
    await processBillingRenewalReconciliations();
    await processBillingReminders();
    await processBillingGracePeriodExpirations();
  });
  console.log('✓ Billing scheduled jobs initialized (daily at 02:00)');
}
