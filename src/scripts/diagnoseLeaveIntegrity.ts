/**
 * Leave / attendance data integrity report — READ ONLY.
 *
 * Written to be pointed at the LIVE server database, which is a different
 * database from the local one. It opens its own connection, runs SELECTs only,
 * and never writes. Nothing here depends on the application being deployed, so
 * it can be run before or after the fix ships.
 *
 *   # against the live server
 *   DATABASE_URL="postgres://...prod..." npx ts-node src/scripts/diagnoseLeaveIntegrity.ts
 *
 *   # machine-readable, for pasting into a ticket
 *   DATABASE_URL="..." npx ts-node src/scripts/diagnoseLeaveIntegrity.ts --json
 *
 * Checks, in the order the defects were reported:
 *   1  leave granted with no human approver          (escalation auto-approval)
 *   1a approved leave whose balance was never deducted
 *   1b status running ahead of the current approver
 *   2  approved leave sitting on top of an active shift (false "absent")
 *   3  shifts booked on days already covered by approved leave
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const asJson = process.argv.includes('--json');

const APPROVED_LEAVE_STATUSES = ['approved', 'admin_approved', 'admin approved', 'hr_approved', 'HR approved'];

/** True when the request has no further approver and was not refused/withdrawn. */
const TERMINAL_APPROVAL_SQL = `
  lr.current_approver_role IS NULL
  AND lr.status NOT IN ('pending','rejected','cancelled',
                        'store manager rejected','area manager rejected','HR rejected')
`;

interface Finding {
  check: string;
  title: string;
  severity: 'critical' | 'high' | 'medium';
  count: number;
  rows: Record<string, unknown>[];
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Point it at the database you want to inspect.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c timezone=UTC' });
  const findings: Finding[] = [];

  try {
    // Confirm out loud which database is being read, so a prod run is never
    // mistaken for a local one.
    const whoRes = await pool.query(
      `SELECT current_database() AS db, inet_server_addr()::text AS host, version() AS version`,
    );
    const who = whoRes.rows[0] as { db: string; host: string | null };
    if (!asJson) {
      console.log(`\nDatabase : ${who.db}`);
      console.log(`Host     : ${who.host ?? 'local socket'}`);
      console.log(`Read-only diagnostic — nothing will be modified.\n`);
    }

    const hasApprovedBy = ((await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'leave_requests' AND column_name = 'approved_by'`,
    )).rowCount ?? 0) > 0;

    // ── 1. Leave granted with nobody behind it ──────────────────────────────
    const autoApproved = await pool.query(
      `SELECT lr.id, lr.company_id, c.name AS company,
              (u.name || ' ' || COALESCE(u.surname,'')) AS employee,
              lr.leave_type, lr.status,
              lr.start_date::text AS start_date, lr.end_date::text AS end_date,
              (lr.end_date - lr.start_date + 1) AS days,
              COUNT(la.id) FILTER (WHERE la.approver_role = 'system') AS system_actions
         FROM leave_requests lr
         JOIN users u ON u.id = lr.user_id
         LEFT JOIN companies c ON c.id = lr.company_id
         LEFT JOIN leave_approvals la ON la.leave_request_id = lr.id
        WHERE ${TERMINAL_APPROVAL_SQL}
        GROUP BY lr.id, c.name, u.name, u.surname
       HAVING COUNT(la.id) FILTER (WHERE la.approver_id IS NOT NULL AND la.action = 'approved') = 0
        ORDER BY lr.start_date`,
    );
    findings.push({
      check: '1',
      title: 'Leave reached an approved status with no human approver (granted by the escalation job)',
      severity: 'critical',
      count: autoApproved.rowCount ?? 0,
      rows: autoApproved.rows,
    });

    // ── 1a. Approved leave that never hit a balance ─────────────────────────
    const noBalance = await pool.query(
      `SELECT lr.id, (u.name || ' ' || COALESCE(u.surname,'')) AS employee,
              lr.leave_type, EXTRACT(YEAR FROM lr.start_date)::int AS year,
              lr.start_date::text AS start_date, lr.end_date::text AS end_date,
              (lr.end_date - lr.start_date + 1) AS days
         FROM leave_requests lr
         JOIN users u ON u.id = lr.user_id
        WHERE ${TERMINAL_APPROVAL_SQL}
          AND NOT EXISTS (
                SELECT 1 FROM leave_balances lb
                 WHERE lb.company_id = lr.company_id
                   AND lb.user_id    = lr.user_id
                   AND lb.year       = EXTRACT(YEAR FROM lr.start_date)::int
                   AND lb.leave_type = lr.leave_type
              )
        ORDER BY lr.start_date`,
    );
    findings.push({
      check: '1a',
      title: 'Approved leave with no leave_balances row at all — those days were never deducted',
      severity: 'critical',
      count: noBalance.rowCount ?? 0,
      rows: noBalance.rows,
    });

    // ── 1b. Status ahead of the approver ────────────────────────────────────
    const statusAhead = await pool.query(
      `SELECT lr.id, (u.name || ' ' || COALESCE(u.surname,'')) AS employee,
              lr.status, lr.current_approver_role,
              lr.start_date::text AS start_date, lr.end_date::text AS end_date
         FROM leave_requests lr
         JOIN users u ON u.id = lr.user_id
        WHERE lr.current_approver_role IS NOT NULL
          AND lr.status <> 'pending'
          AND lr.status NOT LIKE '%rejected%'
        ORDER BY lr.id`,
    );
    findings.push({
      check: '1b',
      title: 'Status claims an approval the current approver has not given (escalation wrote the NEXT role\'s status)',
      severity: 'high',
      count: statusAhead.rowCount ?? 0,
      rows: statusAhead.rows,
    });

    // ── 2. Approved leave colliding with an active shift ────────────────────
    const leaveVsShift = await pool.query(
      `SELECT lr.id AS leave_id, s.id AS shift_id,
              (u.name || ' ' || COALESCE(u.surname,'')) AS employee,
              st.name AS store, lr.leave_type, lr.status AS leave_status,
              s.date::text AS shift_date, s.status AS shift_status,
              s.start_time::text AS start_time, s.end_time::text AS end_time,
              EXISTS (SELECT 1 FROM attendance_events ae
                       WHERE ae.user_id = s.user_id
                         AND ae.event_type = 'checkin'
                         AND ae.event_time::date = s.date) AS checked_in
         FROM leave_requests lr
         JOIN users  u  ON u.id = lr.user_id
         JOIN shifts s  ON s.user_id = lr.user_id
                       AND s.company_id = lr.company_id
                       AND s.date BETWEEN lr.start_date AND lr.end_date
         LEFT JOIN stores st ON st.id = s.store_id
        WHERE lr.status = ANY($1::text[])
          AND s.status <> 'cancelled'
        ORDER BY s.date`,
      [APPROVED_LEAVE_STATUSES],
    );
    findings.push({
      check: '2',
      title: 'Approved leave with a still-active shift — the person is reported as an unjustified absence',
      severity: 'high',
      count: leaveVsShift.rowCount ?? 0,
      rows: leaveVsShift.rows,
    });

    // Of those, the ones that already turned into a false no-show.
    const falseNoShows = leaveVsShift.rows.filter(
      (r: any) => r.checked_in === false && new Date(r.shift_date) <= new Date(),
    );
    findings.push({
      check: '2a',
      title: 'Of the above, past shifts with no check-in — these are ALREADY counted as no_show in reports',
      severity: 'high',
      count: falseNoShows.length,
      rows: falseNoShows,
    });

    // ── 3. Future shifts booked over approved leave ─────────────────────────
    const futureConflicts = leaveVsShift.rows.filter(
      (r: any) => new Date(r.shift_date) > new Date(),
    );
    findings.push({
      check: '3',
      title: 'Future shifts already booked on approved-leave days — they will become false absences',
      severity: 'medium',
      count: futureConflicts.length,
      rows: futureConflicts,
    });

    // ── Output ──────────────────────────────────────────────────────────────
    if (asJson) {
      console.log(JSON.stringify({ database: who.db, guardInstalled: hasApprovedBy, findings }, null, 2));
      return;
    }

    console.log(hasApprovedBy
      ? 'Guard      : migration 135 IS installed on this database.\n'
      : 'Guard      : migration 135 is NOT installed here — the escalation job can still approve requests.\n');

    for (const f of findings) {
      const mark = f.count === 0 ? 'OK  ' : f.severity === 'critical' ? 'CRIT' : f.severity === 'high' ? 'HIGH' : 'WARN';
      console.log(`[${mark}] (${f.check}) ${f.title}`);
      console.log(`        ${f.count} row(s)`);
      for (const row of f.rows.slice(0, 15)) {
        console.log(`        - ${JSON.stringify(row)}`);
      }
      if (f.rows.length > 15) console.log(`        ... and ${f.rows.length - 15} more (use --json for the full list)`);
      console.log('');
    }

    const totalDays = (autoApproved.rows as any[]).reduce((sum, r) => sum + Number(r.days ?? 0), 0);
    console.log('─'.repeat(72));
    console.log(`Leave granted with no human decision: ${autoApproved.rowCount} request(s), ${totalDays} day(s).`);
    console.log('Nothing was modified. Repair with: npx ts-node src/scripts/repairLeaveEscalations.ts --apply');
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
