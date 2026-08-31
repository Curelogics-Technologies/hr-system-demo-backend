import { pool } from '../../config/database';
import { countBillableResources } from './headcount.service';

export type LicensedResource = 'employee' | 'terminal';

/**
 * Thrown when an operation would exceed the licenses the company has paid for.
 * Carries the numbers so the UI can say exactly what is full and by how much.
 */
export class LicenseLimitError extends Error {
  public readonly code = 'LICENSE_LIMIT_REACHED';
  public readonly statusCode = 402; // Payment Required

  constructor(
    message: string,
    public readonly details: {
      resource: LicensedResource;
      licensed: number;
      inUse: number;
      requested: number;
    }
  ) {
    super(message);
    this.name = 'LicenseLimitError';
  }
}

export interface LicenseSnapshot {
  /** False for companies grandfathered in before the billing module. */
  billingEnforced: boolean;
  hasSubscription: boolean;
  status: string | null;
  employeesLicensed: number;
  employeesInUse: number;
  employeesRemaining: number;
  terminalsLicensed: number;
  terminalsInUse: number;
  terminalsRemaining: number;
  /** An upgrade awaiting payment confirmation from the provider. */
  pendingUpgrade: {
    employees: number;
    terminals: number;
    amountCents: number | null;
    requestedAt: string | null;
  } | null;
  /** A reduction that takes effect at the next renewal. */
  scheduledReduction: { employees: number | null; terminals: number | null } | null;
}

/**
 * The subscription whose licenses currently apply.
 *
 * A subscription that is active or inside its grace period still entitles the
 * company to the seats it paid for; a pending or canceled one does not.
 */
async function getLicensingSubscription(companyId: number, client: { query: Function } = pool) {
  const res = await client.query(
    `SELECT * FROM subscriptions
     WHERE company_id = $1 AND status IN ('active', 'past_due')
     ORDER BY CASE status WHEN 'active' THEN 1 ELSE 2 END, id DESC
     LIMIT 1`,
    [companyId]
  );
  return res.rowCount ? res.rows[0] : null;
}

/**
 * Whether this company is billed under the license model.
 *
 * Existing customers are grandfathered in as unenforced so that deploying the
 * billing module changes nothing for them; the system administrator enables
 * each company individually once its pricing and fiscal details are ready.
 */
export async function isBillingEnforced(companyId: number): Promise<boolean> {
  try {
    const res = await pool.query(
      `SELECT billing_enforced FROM companies WHERE id = $1`,
      [companyId]
    );
    return res.rows[0]?.billing_enforced === true;
  } catch (err: any) {
    // If the column is missing (migration not applied yet) treat billing as
    // not enforced rather than locking everyone out.
    console.error('[Billing] Could not read billing_enforced:', err?.message || err);
    return false;
  }
}

export async function getLicenseSnapshot(companyId: number): Promise<LicenseSnapshot> {
  const [sub, counts, enforced] = await Promise.all([
    getLicensingSubscription(companyId),
    countBillableResources(companyId),
    isBillingEnforced(companyId),
  ]);

  const employeesLicensed = sub ? sub.seat_quantity : 0;
  const terminalsLicensed = sub ? sub.device_quantity : 0;

  return {
    billingEnforced: enforced,
    hasSubscription: !!sub,
    status: sub ? sub.status : null,
    employeesLicensed,
    employeesInUse: counts.employeeCount,
    employeesRemaining: Math.max(0, employeesLicensed - counts.employeeCount),
    terminalsLicensed,
    terminalsInUse: counts.deviceCount,
    terminalsRemaining: Math.max(0, terminalsLicensed - counts.deviceCount),
    pendingUpgrade:
      sub && (sub.requested_seat_quantity !== null || sub.requested_device_quantity !== null)
        ? {
            employees: sub.requested_seat_quantity ?? sub.seat_quantity,
            terminals: sub.requested_device_quantity ?? sub.device_quantity,
            amountCents: sub.requested_amount_cents ?? null,
            requestedAt: sub.requested_at ?? null,
          }
        : null,
    scheduledReduction:
      sub && (sub.pending_seat_quantity !== null || sub.pending_device_quantity !== null)
        ? {
            employees: sub.pending_seat_quantity,
            terminals: sub.pending_device_quantity,
          }
        : null,
  };
}

/**
 * Gate for creating a billable resource.
 *
 * Refuses when the company would go past the licenses it has paid for. A
 * company with no subscription at all is not gated here — the billing guard
 * already keeps it out of every operational route, and gating twice would
 * produce a confusing "payment required" on a screen it cannot reach anyway.
 */
export async function assertLicenseCapacity(
  companyId: number,
  resource: LicensedResource,
  additional = 1
): Promise<void> {
  // Not on the billing model yet — no allowance to exceed.
  if (!(await isBillingEnforced(companyId))) return;

  const sub = await getLicensingSubscription(companyId);
  if (!sub) return;

  const counts = await countBillableResources(companyId);

  const licensed = resource === 'employee' ? sub.seat_quantity : sub.device_quantity;
  const inUse = resource === 'employee' ? counts.employeeCount : counts.deviceCount;

  if (inUse + additional > licensed) {
    throw new LicenseLimitError(
      resource === 'employee'
        ? `All ${licensed} employee licenses are in use. Increase the licenses from Billing before adding another employee.`
        : `All ${licensed} terminal licenses are in use. Increase the licenses from Billing before adding another terminal.`,
      { resource, licensed, inUse, requested: additional }
    );
  }
}

/**
 * Prices a change in licenses.
 *
 * Increases are charged for the unused remainder of the current period only —
 * licenses already paid for are never charged again. Decreases cost nothing
 * now and are not refunded; they take effect at the next renewal.
 */
export function priceLicenseChange(params: {
  currentEmployees: number;
  currentTerminals: number;
  newEmployees: number;
  newTerminals: number;
  unitPriceEmployee: number;
  unitPriceDevice: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();

  const extraEmployees = Math.max(0, params.newEmployees - params.currentEmployees);
  const extraTerminals = Math.max(0, params.newTerminals - params.currentTerminals);

  const additionalMonthly =
    extraEmployees * params.unitPriceEmployee + extraTerminals * params.unitPriceDevice;

  // Prorate on whole days, not on the exact millisecond.
  //
  // A second-level ratio makes a license bought minutes into a period cost
  // 99.7% of its price — €8.97 instead of €9.00 — which looks like a rounding
  // fault to the customer and is impossible to check by hand. Counting the
  // remaining days (the day the change happens counts as used in full) gives
  // amounts a person can verify: a full period costs the full price, half a
  // period costs half.
  const DAY_MS = 86_400_000;
  let totalDays = 30;
  let daysRemaining = 30;

  if (params.periodStart && params.periodEnd) {
    const start = params.periodStart.getTime();
    const end = params.periodEnd.getTime();
    const span = end - start;
    if (span > 0) {
      totalDays = Math.max(1, Math.round(span / DAY_MS));
      daysRemaining = Math.min(
        totalDays,
        Math.max(0, Math.ceil((end - now.getTime()) / DAY_MS))
      );
    }
  }

  const remainingRatio = totalDays > 0 ? daysRemaining / totalDays : 1;

  // Round to whole cents once, here, so the quote, the invoice and the stored
  // transaction can never disagree by a fraction of a cent.
  const amountDueNowCents = Math.round(additionalMonthly * remainingRatio * 100);
  const amountDueNow = amountDueNowCents / 100;

  const newMonthlyTotal =
    params.newEmployees * params.unitPriceEmployee +
    params.newTerminals * params.unitPriceDevice;

  return {
    extraEmployees,
    extraTerminals,
    isIncrease: extraEmployees > 0 || extraTerminals > 0,
    isDecrease:
      params.newEmployees < params.currentEmployees ||
      params.newTerminals < params.currentTerminals,
    additionalMonthly: round2(additionalMonthly),
    amountDueNow,
    amountDueNowCents,
    newMonthlyTotal: round2(newMonthlyTotal),
    remainingRatio,
    daysRemaining,
    totalDays,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
