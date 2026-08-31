/**
 * Shift timezone repair.
 *
 * Rewrites shifts whose `timezone` disagrees with their store's, setting the
 * store's zone and recomputing every derived UTC instant from the wall-clock
 * times already on the row. This is the fix for the Varese incident, where
 * sixteen Italian shifts were stored on an American clock and the clock-in
 * window opened five hours late.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply.
 *
 *   # see what would change, write nothing
 *   DATABASE_URL="postgres://...prod..." npx ts-node src/scripts/repairShiftTimezones.ts
 *
 *   # limit to one company
 *   DATABASE_URL="..." npx ts-node src/scripts/repairShiftTimezones.ts --company=3
 *
 *   # actually write, after saving a rollback file
 *   DATABASE_URL="..." npx ts-node src/scripts/repairShiftTimezones.ts --apply
 *
 *   # also correct shifts already in the past (changes historical lateness)
 *   DATABASE_URL="..." npx ts-node src/scripts/repairShiftTimezones.ts --apply --include-past
 *
 * Safety properties, each verified against the schema rather than assumed:
 *   - `shifts` carries no triggers, so the UPDATE has no side effects.
 *   - `attendance_events` stores no copy of the scheduled time, so lateness and
 *     absence are recomputed from these rows and correct themselves.
 *   - Duration is timezone-invariant, so worked hours and payroll do not move.
 *   - Future shifts only unless --include-past, so historical reports stand.
 *   - Every write happens in one transaction; a failure rolls the batch back.
 *   - A rollback file with the exact prior values is written before any change.
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const includePast = argv.includes('--include-past');
const companyArg = argv.find((a) => a.startsWith('--company='));
const companyId = companyArg ? parseInt(companyArg.split('=')[1], 10) : null;

if (companyArg && (companyId === null || Number.isNaN(companyId))) {
  console.error('--company= must be a number, e.g. --company=3');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const EFFECTIVE_SHIFT_TZ = `COALESCE(NULLIF(BTRIM(s.timezone), ''), 'Europe/Rome')`;
const EFFECTIVE_STORE_TZ = `COALESCE(NULLIF(BTRIM(st.timezone), ''), 'Europe/Rome')`;

/**
 * Recomputes one UTC instant from the shift's wall clock in a given zone.
 * A point at or before the start time belongs to the following day, which is
 * how an overnight shift's end and its breaks land correctly. Mirrors the
 * expressions used by create and update so a repaired row is indistinguishable
 * from a freshly written one.
 */
function pointUtc(column: string, tzExpr: string): string {
  return `((s.date::timestamp
            + (CASE WHEN s.${column} < s.start_time THEN INTERVAL '1 day' ELSE INTERVAL '0' END)
            + s.${column}) AT TIME ZONE ${tzExpr})`;
}

function nullablePointUtc(column: string, tzExpr: string): string {
  return `CASE WHEN s.${column} IS NULL THEN NULL ELSE ${pointUtc(column, tzExpr)} END`;
}

type Candidate = {
  id: number;
  company_id: number;
  store_id: number;
  store_name: string | null;
  date: string;
  start_time: string;
  end_time: string;
  shift_tz: string;
  store_tz: string;
  old_start_at_utc: string | null;
  new_start_at_utc: string;
};

async function main() {
  const where: string[] = [
    `s.status <> 'cancelled'`,
    `${EFFECTIVE_SHIFT_TZ} <> ${EFFECTIVE_STORE_TZ}`,
  ];
  const params: unknown[] = [];
  if (!includePast) where.push(`s.date >= CURRENT_DATE`);
  if (companyId !== null) {
    params.push(companyId);
    where.push(`s.company_id = $${params.length}`);
  }
  const whereSql = where.join(' AND ');

  const candidates = await pool.query<Candidate>(
    `SELECT s.id, s.company_id, s.store_id, st.name AS store_name,
            TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
            s.start_time::text AS start_time,
            s.end_time::text AS end_time,
            ${EFFECTIVE_SHIFT_TZ} AS shift_tz,
            ${EFFECTIVE_STORE_TZ} AS store_tz,
            s.start_at_utc AS old_start_at_utc,
            ${pointUtc('start_time', EFFECTIVE_STORE_TZ)} AS new_start_at_utc
       FROM shifts s
       JOIN stores st ON st.id = s.store_id
      WHERE ${whereSql}
      ORDER BY s.date, s.store_id, s.id`,
    params,
  );

  console.log('');
  console.log(`Scope: ${includePast ? 'all dates' : 'today onwards'}` +
    `${companyId !== null ? `, company ${companyId}` : ', all companies'}`);
  console.log(`Shifts needing repair: ${candidates.rowCount}`);
  console.log('');

  if (candidates.rowCount === 0) {
    console.log('Nothing to do.');
    return;
  }

  console.log('  shift   store                 date         clock   from              to                start_at_utc');
  console.log('  ------  --------------------  -----------  ------  ----------------  ----------------  ---------------------------------');
  for (const r of candidates.rows) {
    console.log(
      `  ${String(r.id).padEnd(6)}  ${String(r.store_name ?? r.store_id).slice(0, 20).padEnd(20)}  ` +
      `${r.date}   ${r.start_time.slice(0, 5)}   ${r.shift_tz.padEnd(16)}  ${r.store_tz.padEnd(16)}  ` +
      `${r.old_start_at_utc ? new Date(r.old_start_at_utc).toISOString() : 'null'} -> ${new Date(r.new_start_at_utc).toISOString()}`,
    );
  }
  console.log('');

  if (!apply) {
    console.log('DRY RUN — nothing was written. Re-run with --apply to make these changes.');
    return;
  }

  // Full prior state of every row about to change, so the batch can be undone.
  const ids = candidates.rows.map((r) => r.id);
  const backup = await pool.query(
    `SELECT id, timezone, start_at_utc, end_at_utc, break_start_at_utc, break_end_at_utc,
            split_start2_at_utc, split_end2_at_utc, updated_at
       FROM shifts WHERE id = ANY($1::int[])`,
    [ids],
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.resolve(process.cwd(), `shift-timezone-rollback-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup.rows, null, 2));
  console.log(`Rollback file written: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE shifts s
          SET timezone = st_tz.tz,
              start_at_utc = ${pointUtc('start_time', 'st_tz.tz')},
              end_at_utc = ${pointUtc('end_time', 'st_tz.tz')},
              break_start_at_utc = ${nullablePointUtc('break_start', 'st_tz.tz')},
              break_end_at_utc = ${nullablePointUtc('break_end', 'st_tz.tz')},
              split_start2_at_utc = ${nullablePointUtc('split_start2', 'st_tz.tz')},
              split_end2_at_utc = ${nullablePointUtc('split_end2', 'st_tz.tz')},
              updated_at = NOW()
         FROM (
           SELECT st.id AS store_id, ${EFFECTIVE_STORE_TZ} AS tz FROM stores st
         ) AS st_tz
        WHERE s.store_id = st_tz.store_id
          AND s.id = ANY($1::int[])
        RETURNING s.id`,
      [ids],
    );
    await client.query('COMMIT');
    console.log(`Repaired ${updated.rowCount} shifts.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Nothing was written — the batch rolled back.');
    throw err;
  } finally {
    client.release();
  }

  const remaining = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM shifts s JOIN stores st ON st.id = s.store_id
      WHERE s.date >= CURRENT_DATE AND s.status <> 'cancelled'
        AND ${EFFECTIVE_SHIFT_TZ} <> ${EFFECTIVE_STORE_TZ}`,
  );
  console.log(`Future shifts still drifting: ${remaining.rows[0].n} (expected 0)`);
  console.log('');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
