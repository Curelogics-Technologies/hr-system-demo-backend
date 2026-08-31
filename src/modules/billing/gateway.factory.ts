import { IPaymentGateway, PaymentProvider } from './gateway.interface';
import { StripeGateway } from './stripe.service';
import { PayPalGateway } from './paypal.service';

const gateways: Partial<Record<PaymentProvider, IPaymentGateway>> = {};

export function getPaymentGateway(provider: PaymentProvider): IPaymentGateway {
  if (!gateways[provider]) {
    if (provider === 'stripe') {
      gateways.stripe = new StripeGateway();
    } else if (provider === 'paypal') {
      gateways.paypal = new PayPalGateway();
    } else {
      throw new Error(`Unsupported payment provider: ${provider}`);
    }
  }
  return gateways[provider]!;
}
