import { pool } from '../../config/database';

/**
 * What a company is charged per licence, after any discount it holds.
 *
 * The company row is the single source of truth for price. A subscription
 * carries a copy of these figures so the gateway and the stored transactions
 * agree with each other, but that copy is a cache: whenever the admin edits a
 * price or a discount, the copy is refreshed from here rather than left at
 * whatever it was on the day the subscription was created.
 */
export interface CompanyPricing {
  /** Price before discount, exactly as entered on the company. */
  listPriceEmployee: number;
  listPriceDevice: number;
  /** Price actually charged: the list price less an active discount. */
  unitPriceEmployee: number;
  unitPriceDevice: number;
  discountPercent: number;
  /** True when a discount exists and today falls inside its validity window. */
  discountActive: boolean;
  discountValidFrom: Date | null;
  discountValidTo: Date | null;
  currency: string | null;
}

interface PricingQueryable {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * Applies a percentage discount to one unit price.
 *
 * The discount is applied per unit and rounded to whole cents here, so the
 * price shown beside a licence multiplied by the quantity always equals the
 * total shown underneath it. Discounting the total instead would leave the
 * two disagreeing by a cent on prices that do not divide cleanly, and a
 * customer cannot check an invoice they cannot reproduce with a calculator.
 */
function applyDiscount(price: number, percent: number): number {
  if (!(price > 0) || !(percent > 0)) return price > 0 ? price : 0;
  return Math.round(price * (100 - percent)) / 100;
}

/** Whether `now` falls inside a discount's validity window. Nulls are open ends. */
export function isDiscountActive(
  percent: number,
  from: Date | null,
  to: Date | null,
  now: Date = new Date()
): boolean {
  if (!(percent > 0)) return false;
  if (from && now.getTime() < from.getTime()) return false;
  // The closing date is inclusive: a discount valid "to 30 September" covers
  // the whole of that day rather than expiring as it begins.
  if (to && now.getTime() > to.getTime()) return false;
  return true;
}

export async function resolveCompanyPricing(
  companyId: number,
  db: PricingQueryable = pool,
  now: Date = new Date()
): Promise<CompanyPricing> {
  const res = await db.query(
    `SELECT price_per_employee, price_per_device, currency,
            discount_percent, discount_valid_from, discount_valid_to
     FROM companies
     WHERE id = $1`,
    [companyId]
  );

  if (!res.rowCount) {
    throw new Error(`Company not found: ${companyId}`);
  }

  const row = res.rows[0];
  const listPriceEmployee = parseFloat(row.price_per_employee ?? '0') || 0;
  const listPriceDevice = parseFloat(row.price_per_device ?? '0') || 0;
  const discountPercent = parseFloat(row.discount_percent ?? '0') || 0;
  const discountValidFrom = row.discount_valid_from ? new Date(row.discount_valid_from) : null;
  const discountValidTo = row.discount_valid_to ? new Date(row.discount_valid_to) : null;

  const discountActive = isDiscountActive(
    discountPercent,
    discountValidFrom,
    discountValidTo,
    now
  );

  return {
    listPriceEmployee,
    listPriceDevice,
    unitPriceEmployee: discountActive
      ? applyDiscount(listPriceEmployee, discountPercent)
      : listPriceEmployee,
    unitPriceDevice: discountActive
      ? applyDiscount(listPriceDevice, discountPercent)
      : listPriceDevice,
    discountPercent,
    discountActive,
    discountValidFrom,
    discountValidTo,
    currency: row.currency ?? null,
  };
}
