import { Request, Response } from 'express';
import { getPaymentGateway } from './gateway.factory';
import { subscriptionService } from './subscription.service';
import { pool } from '../../config/database';
import { ParsedWebhookEvent, PaymentProvider } from './gateway.interface';

export class WebhookController {
  private async processWebhookEvent(
    provider: PaymentProvider,
    req: Request,
    res: Response
  ) {
    const gateway = getPaymentGateway(provider);
    let parsedEvent: ParsedWebhookEvent;

    try {
      parsedEvent = await gateway.verifyWebhook(req.headers as any, req.body);
    } catch (err: any) {
      console.error(`[Webhook:${provider}] Signature verification failed:`, err.message);
      return res.status(400).send(`Webhook signature verification error: ${err.message}`);
    }

    const { eventId, eventType, payload } = parsedEvent;

    // Idempotency: the unique (provider, event_id) insert is the claim itself.
    // Winning the insert means this request owns the event; losing it means a
    // row already exists and its status decides what happens next. Providers
    // retry aggressively, so two deliveries of the same event can be in flight
    // at once and exactly one of them must do the work.
    const client = await pool.connect();
    let eventRecordId: number | null = null;

    try {
      const claim = await client.query(
        `INSERT INTO webhook_events (
          provider, event_id, event_type, payload, status
        ) VALUES ($1, $2, $3, $4, 'processing')
        ON CONFLICT (provider, event_id) DO NOTHING
        RETURNING id`,
        [provider, eventId, eventType, JSON.stringify(payload)]
      );

      if (claim.rowCount && claim.rowCount > 0) {
        eventRecordId = claim.rows[0].id;
      } else {
        // Someone already owns this event id. Re-claim it only if the previous
        // attempt failed; a 'processing' row means another worker holds it.
        const takeover = await client.query(
          `UPDATE webhook_events
           SET status = 'processing', error_message = NULL
           WHERE provider = $1 AND event_id = $2 AND status = 'failed'
           RETURNING id`,
          [provider, eventId]
        );

        if (takeover.rowCount && takeover.rowCount > 0) {
          eventRecordId = takeover.rows[0].id;
        } else {
          const existing = await client.query(
            `SELECT status FROM webhook_events
             WHERE provider = $1 AND event_id = $2`,
            [provider, eventId]
          );
          const status = existing.rows[0]?.status;
          console.log(
            `[Webhook:${provider}] Skipping duplicate delivery of ${eventId} (status=${status})`
          );
          // 200 keeps the provider from retrying a duplicate. If the worker
          // that owns it dies it will mark the row 'failed', and the provider's
          // next retry is taken over by the branch above.
          return res
            .status(200)
            .json({ received: true, message: `Duplicate delivery (${status})` });
        }
      }
    } finally {
      client.release();
    }

    try {
      console.log(`[Webhook:${provider}] Processing event ${eventType} (${eventId})`);

      switch (eventType) {
        // Checkout completion / Activation
        case 'checkout.session.completed':
        case 'BILLING.SUBSCRIPTION.ACTIVATED':
          await subscriptionService.handleCheckoutCompleted(parsedEvent);
          break;

        // Card replaced through a setup-mode checkout session
        case 'checkout.session.completed.setup':
          await subscriptionService.handlePaymentMethodUpdated(parsedEvent);
          break;

        // Recurring Payment Success
        case 'invoice.payment_succeeded':
        case 'PAYMENT.SALE.COMPLETED':
          await subscriptionService.handlePaymentSucceeded(parsedEvent);
          break;

        // Payment Failed
        case 'invoice.payment_failed':
        case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
        case 'BILLING.SUBSCRIPTION.SUSPENDED':
          await subscriptionService.handlePaymentFailed(parsedEvent);
          break;

        // Subscription State Changes
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'BILLING.SUBSCRIPTION.UPDATED':
          await subscriptionService.handleSubscriptionUpdated(parsedEvent);
          break;

        // Subscription Canceled / Deleted
        case 'customer.subscription.deleted':
        case 'BILLING.SUBSCRIPTION.CANCELLED':
          await subscriptionService.handleSubscriptionCanceled(parsedEvent);
          break;

        default:
          console.log(`[Webhook:${provider}] Unhandled event type: ${eventType}`);
      }

      if (eventRecordId) {
        await pool.query(
          `UPDATE webhook_events 
           SET status = 'processed', processed_at = NOW() 
           WHERE id = $1`,
          [eventRecordId]
        );
      }

      return res.status(200).json({ received: true });
    } catch (err: any) {
      console.error(`[Webhook:${provider}] Error processing ${eventType}:`, err);
      if (eventRecordId) {
        await pool.query(
          `UPDATE webhook_events 
           SET status = 'failed', error_message = $1 
           WHERE id = $2`,
          [err.message, eventRecordId]
        );
      }
      return res.status(500).json({ error: 'Webhook processing error' });
    }
  }

  async handleStripe(req: Request, res: Response) {
    return this.processWebhookEvent('stripe', req, res);
  }

  async handlePayPal(req: Request, res: Response) {
    return this.processWebhookEvent('paypal', req, res);
  }
}

export const webhookController = new WebhookController();
