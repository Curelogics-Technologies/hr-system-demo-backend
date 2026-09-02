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

export class PayPalGateway implements IPaymentGateway {
  readonly provider: PaymentProvider = 'paypal';
  private clientId: string;
  private clientSecret: string;
  private isProduction: boolean;
  private baseUrl: string;

  constructor() {
    this.clientId = process.env.PAYPAL_CLIENT_ID || 'mock_paypal_client_id';
    this.clientSecret = process.env.PAYPAL_CLIENT_SECRET || 'mock_paypal_secret';
    // Which PayPal to talk to is its own decision, not a side effect of
    // NODE_ENV: a staging server runs in production mode but must still bill
    // against the sandbox. PAYPAL_ENV decides, and NODE_ENV is only the
    // default for deployments that have not set it.
    const configured = process.env.PAYPAL_ENV?.trim().toLowerCase();
    if (configured && !['sandbox', 'live'].includes(configured)) {
      throw new Error(
        `PAYPAL_ENV must be "sandbox" or "live", received "${process.env.PAYPAL_ENV}"`
      );
    }

    this.isProduction = configured
      ? configured === 'live'
      : process.env.NODE_ENV === 'production';

    this.baseUrl = this.isProduction
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  }

  private async getAccessToken(): Promise<string> {
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`PayPal Auth Error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }

  private cachedProductId?: string;

  private async ensureProduct(token: string): Promise<string> {
    if (this.cachedProductId) {
      return this.cachedProductId;
    }

    const createRes = await fetch(`${this.baseUrl}/v1/catalogs/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: 'VeylOHR Platform Subscription',
        description: 'Monthly company HR platform subscription',
        type: 'SERVICE',
        category: 'SOFTWARE',
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Failed to create PayPal catalog product: ${err}`);
    }

    const data = (await createRes.json()) as { id: string };
    this.cachedProductId = data.id;
    return data.id;
  }

  async createCheckoutSession(params: CheckoutParams): Promise<CheckoutResult> {
    const token = await this.getAccessToken();
    const productId = await this.ensureProduct(token);

    const currency = (params.currency || 'EUR').toUpperCase();
    // Charge the exact agreed formula. Flooring this at 1 would bill a
    // different amount than Stripe does for the same company.
    const monthlyTotal =
      params.seatQuantity * (params.unitPriceEmployee || 0) +
      params.deviceQuantity * (params.unitPriceDevice || 0);

    if (!(monthlyTotal > 0)) {
      throw new Error(
        'Cannot create a PayPal subscription with a zero monthly total'
      );
    }

    // 1. Create a Plan for this company's calculated monthly billing amount
    const planRes = await fetch(`${this.baseUrl}/v1/billing/plans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        product_id: productId,
        name: `VeylOHR Plan - ${params.companyName}`,
        description: `Monthly billing for ${params.seatQuantity} employees and ${params.deviceQuantity} terminals`,
        status: 'ACTIVE',
        billing_cycles: [
          {
            frequency: {
              interval_unit: 'MONTH',
              interval_count: 1,
            },
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: 0, // 0 = indefinite / until cancelled
            pricing_scheme: {
              fixed_price: {
                value: monthlyTotal.toFixed(2),
                currency_code: currency,
              },
            },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          setup_fee_failure_action: 'CONTINUE',
          payment_failure_threshold: 3,
        },
      }),
    });

    if (!planRes.ok) {
      const err = await planRes.text();
      throw new Error(`Failed to create PayPal plan: ${err}`);
    }

    const planData = (await planRes.json()) as { id: string };

    // 2. Create the subscription object
    const subRes = await fetch(`${this.baseUrl}/v1/billing/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        plan_id: planData.id,
        custom_id: String(params.companyId),
        subscriber: params.companyEmail
          ? {
              email_address: params.companyEmail,
            }
          : undefined,
        application_context: {
          brand_name: 'VeylOHR',
          locale: 'it-IT',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'SUBSCRIBE_NOW',
          return_url: params.successUrl,
          cancel_url: params.cancelUrl,
        },
      }),
    });

    if (!subRes.ok) {
      const err = await subRes.text();
      throw new Error(`Failed to create PayPal subscription: ${err}`);
    }

    const subData = (await subRes.json()) as {
      id: string;
      links: { href: string; rel: string; method: string }[];
    };

    const approveLink = subData.links.find((l) => l.rel === 'approve')?.href;
    if (!approveLink) {
      throw new Error('PayPal subscription response did not contain an approve URL');
    }

    return {
      checkoutUrl: approveLink,
      sessionId: subData.id,
      providerSubscriptionId: subData.id,
    };
  }

  async updateSubscriptionQuantities(
    params: UpdateQuantitiesParams
  ): Promise<UpdateQuantitiesResult> {
    const token = await this.getAccessToken();
    const productId = await this.ensureProduct(token);
    const currency = (params.currency || 'EUR').toUpperCase();
    const newMonthlyTotal = Math.max(
      1,
      params.newSeatQuantity * (params.unitPriceEmployee || 0) +
        params.newDeviceQuantity * (params.unitPriceDevice || 0)
    );

    // Create updated plan for the revised amount
    const planRes = await fetch(`${this.baseUrl}/v1/billing/plans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        product_id: productId,
        name: `VeylOHR Plan (Revised) - ${params.providerSubscriptionId}`,
        description: `Revised billing for ${params.newSeatQuantity} employees and ${params.newDeviceQuantity} terminals`,
        status: 'ACTIVE',
        billing_cycles: [
          {
            frequency: {
              interval_unit: 'MONTH',
              interval_count: 1,
            },
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: {
                value: newMonthlyTotal.toFixed(2),
                currency_code: currency,
              },
            },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          payment_failure_threshold: 3,
        },
      }),
    });

    if (!planRes.ok) {
      const err = await planRes.text();
      throw new Error(`Failed to create updated PayPal plan: ${err}`);
    }

    const planData = (await planRes.json()) as { id: string };

    // Revise the subscription to point to the new plan
    const reviseRes = await fetch(
      `${this.baseUrl}/v1/billing/subscriptions/${params.providerSubscriptionId}/revise`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          plan_id: planData.id,
        }),
      }
    );

    if (!reviseRes.ok) {
      const err = await reviseRes.text();
      throw new Error(`Failed to revise PayPal subscription: ${err}`);
    }

    const reviseData = (await reviseRes.json()) as {
      links?: { href: string; rel: string }[];
    };
    const approveUrl = reviseData.links?.find((l) => l.rel === 'approve')?.href;

    return {
      success: true,
      approveUrl,
    };
  }

  /**
   * PayPal exposes the end of the current cycle as next_billing_time, and the
   * start only indirectly as the last payment. Either may be absent on a
   * subscription that has not billed yet, so both are optional.
   */
  async getSubscriptionPeriod(
    providerSubId: string
  ): Promise<{ start?: Date; end?: Date }> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.baseUrl}/v1/billing/subscriptions/${providerSubId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      throw new Error(`PayPal subscription lookup failed: ${res.status}`);
    }
    const body: any = await res.json();
    const at = (v: unknown) => {
      if (typeof v !== 'string') return undefined;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    return {
      start: at(body?.billing_info?.last_payment?.time),
      end: at(body?.billing_info?.next_billing_time),
    };
  }

  async cancelSubscription(
    providerSubId: string,
    _atPeriodEnd?: boolean
  ): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.baseUrl}/v1/billing/subscriptions/${providerSubId}/cancel`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          reason: 'Customer requested cancellation via VeylOHR',
        }),
      }
    );

    if (!res.ok && res.status !== 204) {
      const err = await res.text();
      throw new Error(`Failed to cancel PayPal subscription: ${err}`);
    }
  }

  async reactivateSubscription(providerSubId: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.baseUrl}/v1/billing/subscriptions/${providerSubId}/activate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          reason: 'Reactivating subscription via VeylOHR',
        }),
      }
    );

    if (!res.ok && res.status !== 204) {
      const err = await res.text();
      throw new Error(`Failed to activate PayPal subscription: ${err}`);
    }
  }

  async verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer | string
  ): Promise<ParsedWebhookEvent> {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const payload = JSON.parse(bodyStr);

    // A webhook endpoint is a public URL, so an unverified event is simply a
    // stranger telling us a payment succeeded. Every event must be proven to
    // come from PayPal before it can grant anything, which means refusing to
    // process one we cannot check rather than letting it through.
    const authAlgo = headers['paypal-auth-algo'];
    const certUrl = headers['paypal-cert-url'];
    const transmissionId = headers['paypal-transmission-id'];
    const transmissionSig = headers['paypal-transmission-sig'];
    const transmissionTime = headers['paypal-transmission-time'];

    if (!webhookId) {
      // Without it there is no way to tell a real event from a forged one.
      throw new Error('PAYPAL_WEBHOOK_ID is not configured: refusing to trust PayPal webhooks');
    }

    if (
      typeof authAlgo !== 'string' ||
      typeof certUrl !== 'string' ||
      typeof transmissionId !== 'string' ||
      typeof transmissionSig !== 'string' ||
      typeof transmissionTime !== 'string'
    ) {
      throw new Error('PayPal webhook is missing its signature headers');
    }

    {
      const token = await this.getAccessToken();
      const verifyRes = await fetch(
        `${this.baseUrl}/v1/notifications/verify-webhook-signature`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            auth_algo: authAlgo,
            cert_url: certUrl,
            transmission_id: transmissionId,
            transmission_sig: transmissionSig,
            transmission_time: transmissionTime,
            webhook_id: webhookId,
            webhook_event: payload,
          }),
        }
      );

      // A failed call is not a pass. If PayPal cannot confirm the signature —
      // an outage, a rejected token, a malformed body — the event stays
      // unproven, and unproven means rejected. PayPal retries, so a genuine
      // event survives a temporary failure; a forged one never gets through.
      if (!verifyRes.ok) {
        const detail = await verifyRes.text().catch(() => '');
        throw new Error(
          `PayPal webhook verification call failed (${verifyRes.status}): ${detail.slice(0, 200)}`
        );
      }

      const verifyData = (await verifyRes.json()) as { verification_status?: string };
      if (verifyData.verification_status !== 'SUCCESS') {
        throw new Error('PayPal webhook signature verification failed');
      }
    }

    const eventType = payload.event_type as string;
    const resource = payload.resource || {};

    const parsed: ParsedWebhookEvent = {
      provider: 'paypal',
      eventId: payload.id,
      eventType,
      payload,
    };

    switch (eventType) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
      case 'BILLING.SUBSCRIPTION.CREATED': {
        parsed.subscriptionId = resource.id;
        parsed.status = 'active';
        if (resource.subscriber?.payer_id) {
          parsed.customerId = resource.subscriber.payer_id;
        }
        if (resource.billing_info?.next_billing_time) {
          parsed.currentPeriodEnd = new Date(resource.billing_info.next_billing_time);
        }
        break;
      }

      case 'PAYMENT.SALE.COMPLETED': {
        parsed.subscriptionId = resource.billing_agreement_id;
        parsed.status = 'active';
        if (resource.amount?.total) {
          parsed.amountCents = Math.round(parseFloat(resource.amount.total) * 100);
          parsed.currency = resource.amount.currency;
        }
        break;
      }

      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
        parsed.subscriptionId = resource.id;
        parsed.status = 'past_due';
        parsed.failureCode = 'paypal_payment_failed';
        parsed.failureMessage = 'PayPal recurring payment failed';
        break;
      }

      case 'BILLING.SUBSCRIPTION.CANCELLED': {
        parsed.subscriptionId = resource.id;
        parsed.status = 'canceled';
        break;
      }

      case 'BILLING.SUBSCRIPTION.SUSPENDED': {
        parsed.subscriptionId = resource.id;
        parsed.status = 'past_due';
        break;
      }

      case 'BILLING.SUBSCRIPTION.UPDATED': {
        parsed.subscriptionId = resource.id;
        parsed.status = this.mapPayPalStatus(resource.status);
        if (resource.billing_info?.next_billing_time) {
          parsed.currentPeriodEnd = new Date(resource.billing_info.next_billing_time);
        }
        break;
      }
    }

    return parsed;
  }

  private mapPayPalStatus(status: string): SubscriptionStatus {
    switch (status?.toUpperCase()) {
      case 'ACTIVE':
        return 'active';
      case 'SUSPENDED':
        return 'past_due';
      case 'CANCELLED':
      case 'EXPIRED':
        return 'canceled';
      case 'APPROVAL_PENDING':
        return 'pending';
      default:
        return 'pending';
    }
  }
}
