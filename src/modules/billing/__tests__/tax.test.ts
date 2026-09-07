import { pool } from '../../../config/database';
import {
  describeTaxConfig,
  getTaxConfig,
  loadTaxConfig,
  resetTaxConfigCache,
  syncTaxRateFromStripe,
  taxCentsOn,
  taxCentsOnLines,
  taxed,
} from '../tax';
import { priceLicenseChange } from '../license.service';

jest.mock('../../../config/database', () => ({
  pool: { query: jest.fn() },
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = pool.query as unknown as jest.Mock;

/**
 * The rate is read from the environment on every call that has no mirror, so
 * each test states the configuration it is describing rather than depending on
 * the order the tests happen to run in.
 */
function withTax<T>(percent: string | undefined, rateId: string | undefined, fn: () => T): T {
  const prevPercent = process.env.BILLING_TAX_PERCENT;
  const prevRate = process.env.STRIPE_TAX_RATE_ID;
  if (percent === undefined) delete process.env.BILLING_TAX_PERCENT;
  else process.env.BILLING_TAX_PERCENT = percent;
  if (rateId === undefined) delete process.env.STRIPE_TAX_RATE_ID;
  else process.env.STRIPE_TAX_RATE_ID = rateId;
  try {
    return fn();
  } finally {
    if (prevPercent === undefined) delete process.env.BILLING_TAX_PERCENT;
    else process.env.BILLING_TAX_PERCENT = prevPercent;
    if (prevRate === undefined) delete process.env.STRIPE_TAX_RATE_ID;
    else process.env.STRIPE_TAX_RATE_ID = prevRate;
  }
}

/**
 * The awaiting sibling of `withTax`.
 *
 * The synchronous version restores the environment the moment its callback
 * returns - which for an async callback is before any of its work has run, so
 * the body would observe the variables already put back.
 */
async function withTaxAsync<T>(
  percent: string | undefined,
  rateId: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const prevPercent = process.env.BILLING_TAX_PERCENT;
  const prevRate = process.env.STRIPE_TAX_RATE_ID;
  if (percent === undefined) delete process.env.BILLING_TAX_PERCENT;
  else process.env.BILLING_TAX_PERCENT = percent;
  if (rateId === undefined) delete process.env.STRIPE_TAX_RATE_ID;
  else process.env.STRIPE_TAX_RATE_ID = rateId;
  try {
    return await fn();
  } finally {
    if (prevPercent === undefined) delete process.env.BILLING_TAX_PERCENT;
    else process.env.BILLING_TAX_PERCENT = prevPercent;
    if (prevRate === undefined) delete process.env.STRIPE_TAX_RATE_ID;
    else process.env.STRIPE_TAX_RATE_ID = prevRate;
  }
}

beforeEach(() => {
  resetTaxConfigCache();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('billing tax configuration', () => {
  it('is off when no percentage is configured', () => {
    withTax(undefined, undefined, () => {
      const cfg = getTaxConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.percent).toBe(0);
      expect(taxCentsOn(10_000)).toBe(0);
    });
  });

  it('refuses a percentage it cannot parse rather than guessing one', () => {
    withTax('22%', undefined, () => {
      expect(getTaxConfig().enabled).toBe(false);
    });
    withTax('-5', undefined, () => {
      expect(getTaxConfig().enabled).toBe(false);
    });
    withTax('120', undefined, () => {
      expect(getTaxConfig().enabled).toBe(false);
    });
  });

  it('ignores a placeholder tax rate id', () => {
    withTax('22', 'txr_your_stripe_tax_rate_id_here...', () => {
      expect(getTaxConfig().stripeTaxRateId).toBeNull();
    });
    withTax('22', 'txr_1RealRateId', () => {
      expect(getTaxConfig().stripeTaxRateId).toBe('txr_1RealRateId');
    });
  });

  it('rounds tax to whole cents', () => {
    withTax('22', undefined, () => {
      // 22% of €10.01 is €2.2022 -> €2.20
      expect(taxCentsOn(1001)).toBe(220);
      // 22% of €10.05 is €2.211 -> €2.21
      expect(taxCentsOn(1005)).toBe(221);
      expect(taxCentsOn(0)).toBe(0);
    });
  });

  it('taxes each invoice line separately, as the providers do', () => {
    withTax('22', undefined, () => {
      expect(taxCentsOnLines([1005, 1005])).toBe(442);
      expect(taxCentsOnLines([23, 23])).toBe(10);
      // A line-by-line total that a single rounding would miss by a cent:
      // 22% of 25 = 5.5 -> 6 (half away from zero), twice = 12,
      // while 22% of 50 = 11.
      expect(taxCentsOnLines([25, 25])).toBe(12);
      expect(taxCentsOn(50)).toBe(11);
    });
  });

  it('splits an amount into subtotal, tax and total', () => {
    withTax('22', undefined, () => {
      expect(taxed(10_000)).toEqual({
        subtotalCents: 10_000,
        taxCents: 2_200,
        totalCents: 12_200,
        taxPercent: 22,
      });
    });
  });
});

describe('mirroring the rate from Stripe', () => {
  const stripeRate = {
    percentage: 22,
    inclusive: false,
    active: true,
    displayName: 'IVA',
    jurisdiction: 'IT',
  };

  it('stores what Stripe says and serves it from then on', async () => {
    await withTaxAsync('10', 'txr_live', async () => {
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            stripe_tax_rate_id: 'txr_live',
            percent: '22.00',
            display_name: 'IVA',
            jurisdiction: 'IT',
            inclusive: false,
            active: true,
            source: 'stripe',
            synced_at: new Date('2026-09-08T09:00:00Z'),
            sync_error: null,
          },
        ],
      });

      const cfg = await syncTaxRateFromStripe(async () => stripeRate);

      // Stripe wins over the environment, which is only ever a cold-start
      // fallback: the provider is what actually charges the customer.
      expect(cfg.percent).toBe(22);
      expect(cfg.source).toBe('stripe');
      expect(getTaxConfig().percent).toBe(22);
      expect(taxCentsOn(10_000)).toBe(2_200);
    });
  });

  it('keeps charging the last known rate when Stripe is unreachable', async () => {
    await withTaxAsync('22', 'txr_live', async () => {
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            stripe_tax_rate_id: 'txr_live',
            percent: '22.00',
            source: 'stripe',
            inclusive: false,
            active: true,
            synced_at: new Date('2026-09-01T09:00:00Z'),
            sync_error: null,
          },
        ],
      });
      await loadTaxConfig();

      const cfg = await syncTaxRateFromStripe(async () => {
        throw new Error('connect ETIMEDOUT');
      });

      // A network blip must not silently stop the platform charging tax.
      expect(cfg.percent).toBe(22);
      expect(cfg.syncError).toMatch(/ETIMEDOUT/);
      expect(taxCentsOn(10_000)).toBe(2_200);
    });
  });

  it('records a rate id that does not exist on the account', async () => {
    await withTaxAsync('22', 'txr_typo', async () => {
      const cfg = await syncTaxRateFromStripe(async () => null);
      expect(cfg.syncError).toMatch(/no tax rate/i);
      // Still charging, still flagged: the operator has to see the error, but
      // the customer's invoice must not silently lose its tax line first.
      expect(cfg.percent).toBe(22);
    });
  });

  it('reports an inclusive or archived rate rather than quietly using it', async () => {
    await withTaxAsync('22', 'txr_live', async () => {
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            stripe_tax_rate_id: 'txr_live',
            percent: '22.00',
            inclusive: true,
            active: false,
            source: 'stripe',
            synced_at: new Date(),
            sync_error: null,
          },
        ],
      });

      const cfg = await syncTaxRateFromStripe(async () => ({
        ...stripeRate,
        inclusive: true,
        active: false,
      }));

      expect(cfg.inclusive).toBe(true);
      expect(cfg.active).toBe(false);
      expect(describeTaxConfig(cfg).inclusive).toBe(true);
    });
  });

  it('falls back to the environment while the stored row is still a placeholder', async () => {
    await withTaxAsync('22', 'txr_live', async () => {
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            stripe_tax_rate_id: null,
            percent: '0.00',
            source: 'env',
            inclusive: false,
            active: true,
            synced_at: null,
            sync_error: null,
          },
        ],
      });

      const cfg = await loadTaxConfig();

      // The seeded row is 0% until the first sync lands. Trusting it would
      // bill every customer net on a fresh deployment.
      expect(cfg.percent).toBe(22);
      expect(cfg.source).toBe('env');
    });
  });

  it('reports the PayPal percentage alongside the Stripe one so they can be compared', () => {
    withTax('22', 'txr_live', () => {
      const described = describeTaxConfig();
      expect(described.paypalPercent).toBe(described.percent);
    });
  });
});

describe('priceLicenseChange with tax', () => {
  const period = {
    periodStart: new Date('2026-09-01T00:00:00Z'),
    periodEnd: new Date('2026-10-01T00:00:00Z'),
    now: new Date('2026-09-01T10:00:00Z'),
  };

  it('quotes the gross the customer will actually be charged', () => {
    withTax('22', undefined, () => {
      const quote = priceLicenseChange({
        currentEmployees: 10,
        currentTerminals: 2,
        newEmployees: 12,
        newTerminals: 2,
        unitPriceEmployee: 5,
        unitPriceDevice: 10,
        ...period,
      });

      // Two extra seats at €5 for the whole 30-day period.
      expect(quote.additionalMonthly).toBe(10);
      expect(quote.amountDueNowCents).toBe(1000);
      expect(quote.taxPercent).toBe(22);
      expect(quote.taxDueNowCents).toBe(220);
      expect(quote.totalDueNowCents).toBe(1220);
      expect(quote.totalDueNow).toBe(12.2);

      // The new recurring price, taxed per line: 12 x €5 = €60 -> €13.20,
      // 2 x €10 = €20 -> €4.40.
      expect(quote.newMonthlyTotal).toBe(80);
      expect(quote.newMonthlyTaxCents).toBe(1760);
      expect(quote.newMonthlyTotalWithTax).toBe(97.6);
    });
  });

  it('leaves the quote net when no rate is configured', () => {
    withTax(undefined, undefined, () => {
      const quote = priceLicenseChange({
        currentEmployees: 10,
        currentTerminals: 0,
        newEmployees: 11,
        newTerminals: 0,
        unitPriceEmployee: 5,
        unitPriceDevice: 10,
        ...period,
      });

      expect(quote.taxPercent).toBe(0);
      expect(quote.taxDueNowCents).toBe(0);
      // With no tax the gross and the net are the same figure, so nothing in
      // the UI changes for a deployment that does not charge tax.
      expect(quote.totalDueNowCents).toBe(quote.amountDueNowCents);
      expect(quote.newMonthlyTotalWithTax).toBe(quote.newMonthlyTotal);
    });
  });
});
