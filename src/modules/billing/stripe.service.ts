import Stripe from 'stripe';
import {
  CheckoutParams,
  CheckoutResult,
  IPaymentGateway,
  ParsedWebhookEvent,
  PaymentProvider,
  SubscriptionStatus,
  UpdateQuantitiesParams,
  UpdateQuantitiesResult,
} from './gateway.interface';

export class StripeGateway implements IPaymentGateway {
  readonly provider: PaymentProvider = 'stripe';
  private stripe: Stripe;

  constructor() {
    const secretKey = process.env.STRIPE_SECRET_KEY || 'sk_test_mock_key';
    this.stripe = new Stripe(secretKey, {
      apiVersion: '2025-01-27.acacia' as any,
    });
  }

  async createCheckoutSession(params: CheckoutParams): Promise<CheckoutResult> {
    const currency = (params.currency || 'EUR').toLowerCase();
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];

    // 1. Employee line item
    // The billed amount must be exactly (seats x seat price) + (terminals x
    // terminal price). A line with zero quantity or zero unit price is not
    // billed at all — coercing either to 1 would invent a phantom charge.
    const employeeUnitCents = Math.round((params.unitPriceEmployee || 0) * 100);
    if (params.seatQuantity > 0 && employeeUnitCents > 0) {
      const priceEnv = process.env.STRIPE_PRICE_EMPLOYEE_MONTHLY;
      if (priceEnv && !priceEnv.includes('...')) {
        lineItems.push({
          price: priceEnv,
          quantity: params.seatQuantity,
        });
      } else {
        lineItems.push({
          price_data: {
            currency,
            product_data: {
              name: 'Employee Seats (VeylOHR)',
              description: `Active employee license (€${(params.unitPriceEmployee || 0).toFixed(2)}/seat/month)`,
            },
            unit_amount: employeeUnitCents,
            recurring: {
              interval: 'month',
            },
          },
          quantity: params.seatQuantity,
        });
      }
    }

    // 2. Terminal line item
    const deviceUnitCents = Math.round((params.unitPriceDevice || 0) * 100);
    if (params.deviceQuantity > 0 && deviceUnitCents > 0) {
      const priceEnv = process.env.STRIPE_PRICE_DEVICE_MONTHLY;
      if (priceEnv && !priceEnv.includes('...')) {
        lineItems.push({
          price: priceEnv,
          quantity: params.deviceQuantity,
        });
      } else {
        lineItems.push({
          price_data: {
            currency,
            product_data: {
              name: 'Terminal Devices (VeylOHR)',
              description: `Active store terminal license (€${(params.unitPriceDevice || 0).toFixed(2)}/terminal/month)`,
            },
            unit_amount: deviceUnitCents,
            recurring: {
              interval: 'month',
            },
          },
          quantity: params.deviceQuantity,
        });
      }
    }

    // Unreachable via the API — initiateCheckout rejects a zero total before we
    // get here. Fail loudly rather than silently inventing a minimum charge.
    if (lineItems.length === 0) {
      throw new Error(
        'Cannot create a Stripe checkout session with no billable employees or terminals'
      );
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      client_reference_id: String(params.companyId),
      customer_email: params.companyEmail || undefined,
      line_items: lineItems,
      subscription_data: {
        metadata: {
          companyId: String(params.companyId),
          companyName: params.companyName,
          seatQuantity: String(params.seatQuantity),
          deviceQuantity: String(params.deviceQuantity),
          ...(params.metadata || {}),
        },
      },
      metadata: {
        companyId: String(params.companyId),
        ...(params.metadata || {}),
      },
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    });

    if (!session.url) {
      throw new Error('Stripe failed to create checkout session URL');
    }

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
      providerCustomerId: typeof session.customer === 'string' ? session.customer : (session.customer as any)?.id,
      providerSubscriptionId:
        typeof session.subscription === 'string'
          ? session.subscription
          : (session.subscription as any)?.id,
    };
  }

  async updateSubscriptionQuantities(
    params: UpdateQuantitiesParams
  ): Promise<UpdateQuantitiesResult> {
    const sub = await this.stripe.subscriptions.retrieve(
      params.providerSubscriptionId,
      { expand: ['items.data'] }
    );

    const currency = (params.currency || 'EUR').toLowerCase();
    const customerId =
      typeof sub.customer === 'string' ? sub.customer : (sub.customer as any)?.id;

    let proratedInvoiceId: string | undefined;

    // Charge BEFORE changing the recurring quantities.
    //
    // Stripe's own proration is computed to the second and would differ from
    // the day-based amount the customer just approved, so we bill an explicit
    // invoice item for exactly the quoted figure and tell Stripe not to
    // prorate. Charging first also means a declined card leaves the
    // subscription untouched, instead of raising the recurring quantity for
    // seats that were never paid for.
    if (params.immediate && (params.proratedAmountCents ?? 0) > 0) {
      if (!customerId) {
        throw new Error('Cannot charge a license upgrade: subscription has no customer');
      }

      // Same key => Stripe replays the original result instead of creating a
      // second charge. Without this, a retry bills the customer again.
      const key = params.idempotencyKey;

      await this.stripe.invoiceItems.create(
        {
          customer: customerId,
          subscription: params.providerSubscriptionId,
          amount: params.proratedAmountCents,
          currency,
          description:
            params.chargeDescription || 'Additional licenses (prorated to end of period)',
        },
        key ? { idempotencyKey: `${key}:item` } : undefined
      );

      const invoice = await this.stripe.invoices.create(
        {
          customer: customerId,
          subscription: params.providerSubscriptionId,
          collection_method: 'charge_automatically',
          auto_advance: false,
          description:
            params.chargeDescription || 'Additional licenses (prorated to end of period)',
        },
        key ? { idempotencyKey: `${key}:invoice` } : undefined
      );

      const finalized = await this.stripe.invoices.finalizeInvoice(invoice.id as string);
      // Throws on a declined card, which is what we want: the caller reports
      // the failure and no licenses are granted.
      const paid = await this.stripe.invoices.pay(finalized.id as string);
      proratedInvoiceId = paid.id as string;
    }

    // Now align the recurring quantities for future renewals. No proration —
    // the difference for this period has already been settled above.
    const items = sub.items.data;
    const seatItem = items[0];
    const deviceItem = items.length > 1 ? items[1] : null;
    const proration_behavior = 'none' as const;

    const updatePromises: Promise<any>[] = [];

    if (seatItem) {
      updatePromises.push(
        this.stripe.subscriptionItems.update(seatItem.id, {
          quantity: Math.max(1, params.newSeatQuantity),
          proration_behavior,
        })
      );
    }

    if (deviceItem && params.newDeviceQuantity > 0) {
      updatePromises.push(
        this.stripe.subscriptionItems.update(deviceItem.id, {
          quantity: params.newDeviceQuantity,
          proration_behavior,
        })
      );
    } else if (deviceItem && params.newDeviceQuantity === 0) {
      updatePromises.push(
        this.stripe.subscriptionItems.del(deviceItem.id, { proration_behavior })
      );
    } else if (!deviceItem && params.newDeviceQuantity > 0) {
      const deviceUnitCents = Math.round((params.unitPriceDevice || 0) * 100);
      if (deviceUnitCents > 0) {
        const productId = await this.ensureTerminalProduct();
        updatePromises.push(
          (this.stripe.subscriptionItems as any).create({
            subscription: params.providerSubscriptionId,
            price_data: {
              currency,
              product: productId,
              unit_amount: deviceUnitCents,
              recurring: { interval: 'month' },
            },
            quantity: params.newDeviceQuantity,
            proration_behavior,
          })
        );
      }
    }

    await Promise.all(updatePromises);

    return { success: true, proratedInvoiceId };
  }

  /**
   * Hosted page for replacing the card a subscription bills.
   *
   * Uses Checkout in setup mode rather than the Billing Portal so it works
   * without any dashboard configuration. The new card is attached to the same
   * customer; the webhook promotes it to the subscription default.
   */
  async createPaymentMethodUpdateSession(params: {
    providerSubscriptionId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionId: string }> {
    const sub = await this.stripe.subscriptions.retrieve(params.providerSubscriptionId);
    const customerId =
      typeof sub.customer === 'string' ? sub.customer : (sub.customer as any)?.id;
    if (!customerId) {
      throw new Error('Subscription has no customer to attach a payment method to');
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customerId,
      payment_method_types: ['card'],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      setup_intent_data: {
        metadata: {
          subscriptionId: params.providerSubscriptionId,

        },
      },
    });

    return { url: session.url as string, sessionId: session.id };
  }

  /**
   * Attaches the card collected by a setup session to the subscription it was
   * started for, so future invoices bill the new card.
   */
  async applySetupSessionPaymentMethod(session: any): Promise<string | null> {
    const setupIntentId =
      typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
    if (!setupIntentId) return null;

    const intent = await this.stripe.setupIntents.retrieve(setupIntentId);
    const paymentMethodId =
      typeof intent.payment_method === 'string'
        ? intent.payment_method
        : (intent.payment_method as any)?.id;
    const subscriptionId = (intent.metadata as any)?.subscriptionId;

    if (!paymentMethodId || !subscriptionId) return null;

    const customerId =
      typeof session.customer === 'string' ? session.customer : session.customer?.id;

    if (customerId) {
      await this.stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    await this.stripe.subscriptions.update(subscriptionId, {
      default_payment_method: paymentMethodId,
    });

    return subscriptionId;
  }

  /**
   * Whether an invoice has been settled, so a missed webhook can be recovered.
   * 'pending' means it is still collectible and worth waiting for.
   */
  async getInvoiceOutcome(
    invoiceId: string
  ): Promise<{ outcome: 'paid' | 'failed' | 'pending'; hostedUrl?: string; amountCents?: number }> {
    const invoice = await this.stripe.invoices.retrieve(invoiceId);
    const hostedUrl = invoice.hosted_invoice_url || invoice.invoice_pdf || undefined;

    if (invoice.status === 'paid') {
      return { outcome: 'paid', hostedUrl, amountCents: invoice.amount_paid ?? undefined };
    }
    if (invoice.status === 'void' || invoice.status === 'uncollectible') {
      return { outcome: 'failed', hostedUrl };
    }
    return { outcome: 'pending', hostedUrl };
  }

  /** Brand and last four digits of the card a subscription bills, if any. */
  async describeDefaultPaymentMethod(
    providerSubscriptionId: string
  ): Promise<{ brand: string; last4: string; expMonth: number; expYear: number } | null> {
    try {
      const sub = await this.stripe.subscriptions.retrieve(providerSubscriptionId, {
        expand: ['default_payment_method', 'customer'],
      });

      let pm: any = sub.default_payment_method;
      if (!pm) {
        const customer: any = sub.customer;
        pm = customer?.invoice_settings?.default_payment_method;
      }
      if (!pm || typeof pm === 'string' || !pm.card) return null;

      return {
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
      };
    } catch {
      return null;
    }
  }

  /**
   * The reusable Stripe Product for terminal licenses.
   *
   * Subscription items cannot inline a product the way Checkout line items
   * can — they need a product id — so one is created on first use and reused
   * afterwards.
   */
  private terminalProductId: string | null = null;

  private async ensureTerminalProduct(): Promise<string> {
    if (this.terminalProductId) return this.terminalProductId;

    const existing = await this.stripe.products.search({
      query: "metadata['veylohr_kind']:'terminal_license'",
      limit: 1,
    });

    if (existing.data.length > 0) {
      this.terminalProductId = existing.data[0].id;
      return this.terminalProductId;
    }

    const created = await this.stripe.products.create({
      name: 'Terminal Devices (VeylOHR)',
      metadata: { veylohr_kind: 'terminal_license' },
    });
    this.terminalProductId = created.id;
    return created.id;
  }

  async cancelSubscription(
    providerSubId: string,
    atPeriodEnd: boolean = true
  ): Promise<void> {
    if (atPeriodEnd) {
      await this.stripe.subscriptions.update(providerSubId, {
        cancel_at_period_end: true,
      });
    } else {
      await this.stripe.subscriptions.cancel(providerSubId);
    }
  }

  async reactivateSubscription(providerSubId: string): Promise<void> {
    await this.stripe.subscriptions.update(providerSubId, {
      cancel_at_period_end: false,
    });
  }

  /**
   * Finds the subscription an invoice belongs to.
   *
   * Stripe moved this field: older API versions expose invoice.subscription,
   * newer ones put it under invoice.parent.subscription_details.subscription
   * and, for invoices built from invoice items, only on the line's parent.
   * Reading one spelling silently yields undefined on the others — which made
   * every paid invoice look unrelated to any subscription and be dropped.
   * Check every known location.
   */
  private resolveInvoiceSubscriptionId(invoice: any): string | undefined {
    const direct = invoice?.subscription;
    if (typeof direct === 'string') return direct;
    if (direct?.id) return direct.id;

    const fromParent = invoice?.parent?.subscription_details?.subscription;
    if (typeof fromParent === 'string') return fromParent;
    if (fromParent?.id) return fromParent.id;

    for (const line of invoice?.lines?.data ?? []) {
      const onLine = line?.subscription;
      if (typeof onLine === 'string') return onLine;
      if (onLine?.id) return onLine.id;

      const p = line?.parent;
      const candidates = [
        p?.invoice_item_details?.subscription,
        p?.subscription_item_details?.subscription,
      ];
      for (const c of candidates) {
        if (typeof c === 'string') return c;
        if (c?.id) return c.id;
      }
    }

    return undefined;
  }

  /**
   * Billing period covered by an invoice, when it genuinely represents one.
   *
   * Only a subscription cycle invoice describes a period. An invoice assembled
   * from invoice items — which is how a mid-cycle license top-up is charged —
   * reports a line period of a single instant, and taking that at face value
   * collapses the subscription's real cycle to zero length.
   */
  private resolveInvoicePeriod(invoice: any): { start?: Date; end?: Date } {
    const line = invoice?.lines?.data?.[0];
    const period = line?.period ?? invoice?.period;
    if (!period?.start || !period?.end) return {};

    const start = new Date(period.start * 1000);
    const end = new Date(period.end * 1000);

    // A real cycle spans time. Anything instantaneous is a top-up artefact.
    if (end.getTime() - start.getTime() < 60_000) return {};

    return { start, end };
  }

  async verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer | string
  ): Promise<ParsedWebhookEvent> {
    const sig = headers['stripe-signature'];
    if (!sig || typeof sig !== 'string') {
      throw new Error('Missing stripe-signature header');
    }

    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }

    const event = this.stripe.webhooks.constructEvent(rawBody, sig, secret);

    const parsed: ParsedWebhookEvent = {
      provider: 'stripe',
      eventId: event.id,
      eventType: event.type,
      payload: event.data.object,
    };

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as any;

        // Setup mode means the customer was replacing their card, not buying a
        // subscription. Routing it to the activation handler would create a
        // bogus activation, so it is dispatched separately.
        if (session.mode === 'setup') {
          parsed.eventType = 'checkout.session.completed.setup';
          parsed.customerId =
            typeof session.customer === 'string' ? session.customer : session.customer?.id;
          parsed.payload = session;
          break;
        }

        parsed.subscriptionId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
        parsed.customerId =
          typeof session.customer === 'string'
            ? session.customer
            : session.customer?.id;
        parsed.status = 'active';
        parsed.amountCents = session.amount_total ?? undefined;
        parsed.currency = session.currency?.toUpperCase();

        // The checkout session itself carries no receipt link, so fetch the
        // invoice it produced. Without this the first payment shows up in the
        // history with no receipt to open.
        try {
          const invoiceId =
            typeof session.invoice === 'string' ? session.invoice : session.invoice?.id;
          if (invoiceId) {
            const invoice = await this.stripe.invoices.retrieve(invoiceId);
            parsed.invoiceUrl =
              invoice.hosted_invoice_url || invoice.invoice_pdf || undefined;
            parsed.providerInvoiceId = invoice.id;
          } else if (parsed.subscriptionId) {
            const list = await this.stripe.invoices.list({
              subscription: parsed.subscriptionId,
              limit: 1,
            });
            const latest = list.data[0];
            if (latest) {
              parsed.invoiceUrl =
                latest.hosted_invoice_url || latest.invoice_pdf || undefined;
              parsed.providerInvoiceId = latest.id;
            }
          }
        } catch (err: any) {
          console.warn(
            '[Stripe] Could not resolve invoice receipt for checkout session:',
            err?.message || err
          );
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as any;
        parsed.subscriptionId = sub.id;
        parsed.customerId =
          typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
        parsed.status = this.mapStripeStatus(sub.status);
        if (sub.current_period_start) {
          parsed.currentPeriodStart = new Date(sub.current_period_start * 1000);
        }
        if (sub.current_period_end) {
          parsed.currentPeriodEnd = new Date(sub.current_period_end * 1000);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as any;
        parsed.subscriptionId = sub.id;
        parsed.status = 'canceled';
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as any;
        parsed.subscriptionId = this.resolveInvoiceSubscriptionId(invoice);
        parsed.customerId =
          typeof invoice.customer === 'string'
            ? invoice.customer
            : invoice.customer?.id;
        parsed.amountCents = invoice.amount_paid;
        parsed.currency = invoice.currency?.toUpperCase();
        parsed.status = 'active';
        parsed.invoiceUrl = invoice.hosted_invoice_url || invoice.invoice_pdf || undefined;
        parsed.providerInvoiceId = invoice.id;

        const period = this.resolveInvoicePeriod(invoice);
        parsed.currentPeriodStart = period.start;
        parsed.currentPeriodEnd = period.end;

        if (!parsed.subscriptionId) {
          console.warn(
            `[Stripe] Paid invoice ${invoice.id} has no resolvable subscription; ` +
              'it will be matched by invoice id or customer instead.'
          );
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as any;
        parsed.subscriptionId = this.resolveInvoiceSubscriptionId(invoice);
        parsed.providerInvoiceId = invoice.id;
        parsed.customerId =
          typeof invoice.customer === 'string'
            ? invoice.customer
            : invoice.customer?.id;
        // Record what was actually attempted, so the failed row in the payment
        // history shows the real amount instead of 0.
        parsed.amountCents =
          invoice.amount_due ?? invoice.amount_remaining ?? invoice.total ?? undefined;
        parsed.currency = invoice.currency?.toUpperCase();
        parsed.status = 'past_due';
        parsed.failureCode = (invoice.last_finalization_error as any)?.code || 'payment_failed';
        parsed.failureMessage =
          (invoice.last_finalization_error as any)?.message ||
          'Payment attempt failed on card';
        break;
      }
    }

    return parsed;
  }

  private mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
    switch (status) {
      case 'active':
        return 'active';
      case 'past_due':
        return 'past_due';
      case 'canceled':
      case 'unpaid':
        return 'canceled';
      case 'incomplete':
      case 'incomplete_expired':
        return 'incomplete';
      case 'trialing':
        return 'active';
      default:
        return 'pending';
    }
  }
}
