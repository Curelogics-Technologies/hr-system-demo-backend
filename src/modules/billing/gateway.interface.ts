export type PaymentProvider = 'stripe' | 'paypal';

export type SubscriptionStatus =
  | 'pending'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete';

export interface CheckoutParams {
  companyId: number;
  companyName: string;
  companyEmail?: string;
  currency: string;
  seatQuantity: number;
  deviceQuantity: number;
  unitPriceEmployee: number;
  unitPriceDevice: number;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}

export interface CheckoutResult {
  checkoutUrl: string;
  sessionId: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
}

export interface UpdateQuantitiesParams {
  providerSubscriptionId: string;
  newSeatQuantity: number;
  newDeviceQuantity: number;
  unitPriceEmployee: number;
  unitPriceDevice: number;
  currency: string;
  immediate: boolean;
  /**
   * The exact amount to charge now, in cents, as quoted to the customer.
   *
   * Providers compute their own proration to the second, which would not match
   * the day-based figure shown in the UI. Passing the agreed amount lets the
   * gateway bill precisely that, so quote, invoice and receipt all agree.
   */
  proratedAmountCents?: number;
  chargeDescription?: string;
  /**
   * Stable key for the charge. Sending the same key twice makes the provider
   * return the original result instead of billing again, so a double click or
   * a retry after a timeout cannot charge the customer twice.
   */
  idempotencyKey?: string;
}

export interface UpdateQuantitiesResult {
  success: boolean;
  approveUrl?: string;
  proratedInvoiceId?: string;
}

export interface ParsedWebhookEvent {
  provider: PaymentProvider;
  eventId: string;
  eventType: string;
  payload: any;
  subscriptionId?: string;
  customerId?: string;
  status?: SubscriptionStatus;
  /** What the provider actually collected. Zero is meaningful. */
  amountCents?: number;
  /**
   * What the invoice was for. When this exceeds amountCents the provider
   * declined to collect — typically because the total is under its minimum
   * charge — and carried the balance to the next invoice.
   */
  invoiceTotalCents?: number;
  currency?: string;
  invoiceUrl?: string;
  providerInvoiceId?: string;
  failureCode?: string;
  failureMessage?: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
}

export interface IPaymentGateway {
  readonly provider: PaymentProvider;

  createCheckoutSession(params: CheckoutParams): Promise<CheckoutResult>;

  updateSubscriptionQuantities(
    params: UpdateQuantitiesParams
  ): Promise<UpdateQuantitiesResult>;

  cancelSubscription(providerSubId: string, atPeriodEnd?: boolean): Promise<void>;

  reactivateSubscription(providerSubId: string): Promise<void>;

  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer | string
  ): Promise<ParsedWebhookEvent>;
}
