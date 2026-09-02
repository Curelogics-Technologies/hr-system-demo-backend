import { pool } from '../../config/database';

export type BillableResource = 'employee' | 'terminal';

/**
 * The two quantities a company is billed on.
 *
 * These definitions are the single source of truth — the checkout, the renewal
 * reconciliation and the ledger must all count the same way, otherwise an
 * invoice can disagree with what the billing page shows.
 *
 *  - employee: any active user of the company that is not a store terminal
 *  - terminal: an active store_terminal user. A terminal takes a license as
 *              soon as it is created, because registration to a device happens
 *              later and must not be a way past the paid allowance.
 */
export const BILLABLE_EMPLOYEE_SQL = `
  SELECT COUNT(*)::int AS count
  FROM users
  WHERE company_id = $1 AND status = 'active' AND role <> 'store_terminal'`;

export const BILLABLE_TERMINAL_SQL = `
  SELECT COUNT(*)::int AS count
  FROM users
  WHERE company_id = $1 AND status = 'active' AND role = 'store_terminal'`;

export interface LiveCounts {
  employeeCount: number;
  deviceCount: number;
}

export async function countBillableResources(
  companyId: number,
  client: { query: Function } = pool
): Promise<LiveCounts> {
  const [emp, dev] = await Promise.all([
    client.query(BILLABLE_EMPLOYEE_SQL, [companyId]),
    client.query(BILLABLE_TERMINAL_SQL, [companyId]),
  ]);
  return {
    employeeCount: emp.rows[0]?.count || 0,
    deviceCount: dev.rows[0]?.count || 0,
  };
}

/**
 * Records one movement in the billable headcount.
 *
 * Deliberately non-throwing: this is an audit trail, and a failure to write it
 * must never abort the employee/terminal operation that triggered it.
 */
export async function recordHeadcountEvent(params: {
  companyId: number;
  resourceType: BillableResource;
  changeType: 'added' | 'removed';
  userId?: number | null;
  userLabel?: string | null;
  occurredAt?: Date;
}): Promise<void> {
  const { companyId, resourceType, changeType } = params;
  try {
    const counts = await countBillableResources(companyId);
    const resultingCount =
      resourceType === 'employee' ? counts.employeeCount : counts.deviceCount;

    await pool.query(
      `INSERT INTO billing_headcount_events (
         company_id, resource_type, change_type, delta,
         resulting_count, user_id, user_label, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))`,
      [
        companyId,
        resourceType,
        changeType,
        changeType === 'added' ? 1 : -1,
        resultingCount,
        params.userId ?? null,
        params.userLabel ?? null,
        params.occurredAt ?? null,
      ]
    );
  } catch (err: any) {
    console.error(
      `[Headcount] Failed to record ${changeType} ${resourceType} for company ${companyId}:`,
      err?.message || err
    );
  }
}

/**
 * Seeds the ledger for a company that existed before the ledger did, so the
 * history view is not empty on day one. Uses each user's created_at as the
 * "added" date. Runs once per company — if any event already exists, it is a
 * no-op.
 */
export async function backfillHeadcountLedger(companyId: number): Promise<number> {
  const existing = await pool.query(
    `SELECT 1 FROM billing_headcount_events WHERE company_id = $1 LIMIT 1`,
    [companyId]
  );
  if (existing.rowCount && existing.rowCount > 0) return 0;

  const rows = await pool.query(
    `SELECT id, name, surname, email, role, created_at,
            CASE WHEN role = 'store_terminal' THEN 'terminal' ELSE 'employee' END AS resource_type
     FROM users
     WHERE company_id = $1 AND status = 'active'
     ORDER BY created_at ASC, id ASC`,
    [companyId]
  );

  let employees = 0;
  let terminals = 0;
  let written = 0;

  for (const r of rows.rows) {
    const isTerminal = r.resource_type === 'terminal';
    if (isTerminal) terminals += 1;
    else employees += 1;

    const label =
      [r.name, r.surname].filter(Boolean).join(' ').trim() || r.email || `#${r.id}`;

    await pool.query(
      `INSERT INTO billing_headcount_events (
         company_id, resource_type, change_type, delta,
         resulting_count, user_id, user_label, occurred_at
       ) VALUES ($1, $2, 'added', 1, $3, $4, $5, $6)`,
      [
        companyId,
        r.resource_type,
        isTerminal ? terminals : employees,
        r.id,
        label,
        r.created_at,
      ]
    );
    written += 1;
  }

  return written;
}

export interface HeadcountHistoryRow {
  id: number;
  resourceType: BillableResource;
  changeType: 'added' | 'removed';
  delta: number;
  resultingCount: number;
  userLabel: string | null;
  /** Employee photo, read live so a changed photo shows everywhere. */
  avatarFilename: string | null;
  /** For a terminal, the logo of the store it belongs to. */
  storeLogoFilename: string | null;
  storeName: string | null;
  billedAt: string | null;
  occurredAt: string;
}

export async function getHeadcountHistory(
  companyId: number,
  limit = 100
): Promise<{ events: HeadcountHistoryRow[]; totals: LiveCounts }> {
  await backfillHeadcountLedger(companyId);

  const res = await pool.query(
    `SELECT e.id, e.resource_type, e.change_type, e.delta, e.resulting_count,
            e.user_label, e.billed_at, e.occurred_at,
            u.avatar_filename,
            s.logo_filename AS store_logo_filename,
            s.name          AS store_name
     FROM billing_headcount_events e
     LEFT JOIN users  u ON u.id = e.user_id
     LEFT JOIN stores s ON s.id = u.store_id
     WHERE e.company_id = $1
     ORDER BY e.occurred_at DESC, e.id DESC
     LIMIT $2`,
    [companyId, limit]
  );

  return {
    events: res.rows.map((r: any) => ({
      id: r.id,
      resourceType: r.resource_type,
      changeType: r.change_type,
      delta: r.delta,
      resultingCount: r.resulting_count,
      userLabel: r.user_label,
      avatarFilename: r.avatar_filename ?? null,
      storeLogoFilename: r.store_logo_filename ?? null,
      storeName: r.store_name ?? null,
      billedAt: r.billed_at,
      occurredAt: r.occurred_at,
    })),
    totals: await countBillableResources(companyId),
  };
}

/** Marks every unbilled movement as covered by the given subscription/invoice. */
export async function markHeadcountBilled(
  companyId: number,
  subscriptionId: number | null,
  client: { query: Function } = pool
): Promise<void> {
  await client.query(
    `UPDATE billing_headcount_events
     SET billed_at = NOW(), subscription_id = COALESCE($2, subscription_id)
     WHERE company_id = $1 AND billed_at IS NULL`,
    [companyId, subscriptionId]
  );
}
