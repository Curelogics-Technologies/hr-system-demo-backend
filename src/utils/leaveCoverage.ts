/**
 * One definition of "this person was on approved leave that day".
 *
 * Before this existed the answer was spelled out separately in the anomaly
 * engine, the store dashboard, the report metrics and the no-show email job —
 * and only the email job got it right. The other three flagged people on
 * approved holiday or sick leave as unjustified absences, which inflated the
 * absence rate and put legitimately-absent staff in "Requires attention".
 *
 * The rule matches the one agreed for the attendance summary
 * (AttendanceLogsPage): approved leave excuses a scheduled day only when the
 * person had no attendance activity that day. Someone who actually clocked in
 * and had leave approved after the fact keeps every one of their anomalies —
 * which falls out naturally here, because the only anomaly this gates is
 * `no_show`, and a no-show by definition has no check-in.
 *
 * A `short_leave` (a few hours' permission) deliberately does NOT excuse a
 * whole missing day: the person was still expected in for the rest of it.
 */
import { query } from '../config/database';

/**
 * Every spelling of "approved" the leave workflow can produce.
 *
 * The chain is company-configurable, so the terminal status differs per
 * company: 'approved' when it ends at admin, 'HR approved' when it ends at HR.
 * Legacy spaced variants predate the snake_case ones and still exist in data.
 */
export const APPROVED_LEAVE_STATUSES = [
  'approved',
  'admin_approved',
  'admin approved',
  'hr_approved',
  'HR approved',
] as const;

/** Reusable predicate for queries that filter leave rows inline. */
export const APPROVED_LEAVE_STATUS_SQL = `status = ANY(ARRAY[${APPROVED_LEAVE_STATUSES.map(s => `'${s}'`).join(',')}]::text[])`;

/** `${userId}:${YYYY-MM-DD}` keys for every day covered by approved leave. */
export type LeaveCoverage = Set<string>;

export function leaveCoverageKey(userId: number, date: string): string {
  return `${userId}:${date}`;
}

/**
 * Load all (user, date) pairs covered by approved full-day leave in a window.
 *
 * One query for the whole range rather than a per-shift lookup: the anomaly
 * engines iterate thousands of shifts and cannot afford a round trip each.
 */
export async function loadApprovedLeaveDays(
  companyIds: number[],
  from: string,
  to: string,
  opts: { userId?: number | null; storeId?: number | null } = {},
): Promise<LeaveCoverage> {
  if (companyIds.length === 0) return new Set();

  const params: (number[] | string | number)[] = [companyIds, from, to];
  let extra = '';
  if (opts.userId != null) {
    params.push(opts.userId);
    extra += ` AND lr.user_id = $${params.length}`;
  }
  if (opts.storeId != null) {
    params.push(opts.storeId);
    // store_id is nullable on company-level requests; those still cover the person.
    extra += ` AND (lr.store_id IS NULL OR lr.store_id = $${params.length})`;
  }

  // generate_series expands each request into its individual days, clipped to
  // the window, so the caller gets a flat lookup set.
  const rows = await query<{ user_id: number; day: string }>(
    `SELECT lr.user_id,
            TO_CHAR(gs.day, 'YYYY-MM-DD') AS day
       FROM leave_requests lr
       CROSS JOIN LATERAL generate_series(
              GREATEST(lr.start_date, $2::date),
              LEAST(lr.end_date, $3::date),
              INTERVAL '1 day') AS gs(day)
      WHERE lr.company_id = ANY($1::int[])
        AND ${APPROVED_LEAVE_STATUS_SQL.replace('status', 'lr.status')}
        AND COALESCE(lr.leave_duration_type, 'full_day') <> 'short_leave'
        AND lr.start_date <= $3::date
        AND lr.end_date   >= $2::date
        ${extra}`,
    params,
  );

  const coverage: LeaveCoverage = new Set();
  for (const r of rows) coverage.add(leaveCoverageKey(r.user_id, r.day));
  return coverage;
}
