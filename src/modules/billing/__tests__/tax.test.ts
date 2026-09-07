import { getTaxConfig, taxCentsOn, taxCentsOnLines, taxed } from '../tax';
import { priceLicenseChange } from '../license.service';

/**
 * The tax rate is read from the environment on every call, so each test states
 * the configuration it is describing rather than depending on the order the
 * tests happen to run in.
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
      // Per line: 22% of 1005 = 221, of 1005 = 221 -> 442.
      // On the sum: 22% of 2010 = 442.2 -> 442. Here they agree.
      expect(taxCentsOnLines([1005, 1005])).toBe(442);
      // 22% of 23 = 5.06 -> 5, twice = 10; on the sum 22% of 46 = 10.12 -> 10.
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
