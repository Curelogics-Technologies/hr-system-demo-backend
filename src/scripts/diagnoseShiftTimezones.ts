/**
 * Shift timezone drift report — READ ONLY.
 *
 * A shift's `timezone` must match the timezone of the store it is worked at.
 * When it does not, the clock-in window opens at the wrong hour and employees
 * are locked out of their own shift — the Varese incident of 27 August 2026,
 * where sixteen Italian shifts were stored on an American clock and four people
 * could not start work.
 *
 * Written to be pointed at the LIVE server database. It opens its own
 * connection, runs SELECTs only, and never writes.
 *
 *   # against the live server
 *   DATABASE_URL="postgres://...prod..." npx ts-node src/scripts/diagnoseShiftTimezones.ts
 *
 *   # machine-readable, for pasting into a ticket
 *   DATABASE_URL="..." npx ts-node src/scripts/diagnoseShiftTimezones.ts --json
 *
 * Section 1 is the one that matters operationally: it should return zero rows.
 * Anything it lists is an employee who will be refused at the terminal.
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const asJson = process.argv.includes('--json');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Both sides are coalesced to the same default before comparing. Comparing to
 * '' instead — as the original report's query did — flags every shift whose
 * store simply has no timezone set, which is noise rather than drift.
 */
const EFFECTIVE_SHIFT_TZ = `COALESCE(NULLIF(BTRIM(s.timezone), ''), 'Europe/Rome')`;
const EFFECTIVE_STORE_TZ = `COALESCE(NULLIF(BTRIM(st.timezone), ''), 'Europe/Rome')`;

type DriftRow = {
  id: number;
  company_id: number;
  store_id: number;
  store_name: string | null;
  date: string;
  start_time: string;
  shift_tz: string;
  store_tz: string;
  start_at_utc: string | null;
  gate_opens_store_local: string | null;
};

async function main() {
  const out: Record<string, unknown> = {};

  // -------------------------------------------------------------------------
  // 1. Future shifts whose zone disagrees with their store. These are the ones
  //    that will lock someone out. `gate_opens_store_local` is the hour the
  //    terminal will actually start accepting a clock-in, rendered in the
  //    store's own zone — that is the number an employee experiences.
  // -------------------------------------------------------------------------
  const drift = await pool.query<DriftRow>(
    `SELECT s.id, s.company_id, s.store_id, st.name AS store_name,
            TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
            s.start_time::text AS start_time,
            ${EFFECTIVE_SHIFT_TZ} AS shift_tz,
            ${EFFECTIVE_STORE_TZ} AS store_tz,
            s.start_at_utc,
            TO_CHAR(
              (COALESCE(s.start_at_utc, (s.date::timestamp + s.start_time) AT TIME ZONE ${EFFECTIVE_SHIFT_TZ})
                - INTERVAL '15 minutes') AT TIME ZONE ${EFFECTIVE_STORE_TZ},
              'YYYY-MM-DD HH24:MI'
            ) AS gate_opens_store_local
       FROM shifts s
       JOIN stores st ON st.id = s.store_id
      WHERE s.date >= CURRENT_DATE
        AND s.status <> 'cancelled'
        AND ${EFFECTIVE_SHIFT_TZ} <> ${EFFECTIVE_STORE_TZ}
      ORDER BY s.date, s.store_id, s.id`,
  );
  out.future_drift = drift.rows;

  // -------------------------------------------------------------------------
  // 2. Same check over past shifts. Not urgent — nobody is blocked by a shift
  //    that has already happened — but it tells us whether historical lateness
  //    figures were computed against a wrong hour.
  // -------------------------------------------------------------------------
  const past = await pool.query<{ rows_affected: string; first_date: string | null; last_date: string | null }>(
    `SELECT COUNT(*)::text AS rows_affected,
            TO_CHAR(MIN(s.date), 'YYYY-MM-DD') AS first_date,
            TO_CHAR(MAX(s.date), 'YYYY-MM-DD') AS last_date
       FROM shifts s
       JOIN stores st ON st.id = s.store_id
      WHERE s.date < CURRENT_DATE
        AND ${EFFECTIVE_SHIFT_TZ} <> ${EFFECTIVE_STORE_TZ}`,
  );
  out.past_drift_summary = past.rows[0];

  // -------------------------------------------------------------------------
  // 3. Stores with no timezone configured. Not a fault — the code falls back to
  //    the default — but a store that is genuinely not Italian and has no zone
  //    set is a lockout waiting to happen.
  // -------------------------------------------------------------------------
  const bareStores = await pool.query(
    `SELECT id, company_id, name, code, country
       FROM stores
      WHERE (timezone IS NULL OR BTRIM(timezone) = '')
        AND COALESCE(is_active, true) = true
      ORDER BY company_id, id`,
  );
  out.stores_without_timezone = bareStores.rows;

  // -------------------------------------------------------------------------
  // 4. Every distinct zone in use, so an unexpected one is visible at a glance.
  // -------------------------------------------------------------------------
  const zones = await pool.query(
    `SELECT COALESCE(NULLIF(BTRIM(timezone), ''), '<unset>') AS timezone,
            COUNT(*)::text AS shifts
       FROM shifts
      GROUP BY 1
      ORDER BY COUNT(*) DESC`,
  );
  out.zones_in_use = zones.rows;

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const driftRows = out.future_drift as DriftRow[];
  console.log('');
  console.log('Shift timezone drift report');
  console.log('===========================');
  console.log('');

  if (driftRows.length === 0) {
    console.log('1. Future shifts disagreeing with their store: none. Nothing is blocked.');
  } else {
    console.log(`1. Future shifts disagreeing with their store: ${driftRows.length}`);
    console.log('   Each of these will refuse a clock-in until the hour shown.');
    console.log('');
    console.log('   shift   store                 date         starts  shift zone        store zone        terminal opens at');
    console.log('   ------  --------------------  -----------  ------  ----------------  ----------------  -----------------');
    for (const r of driftRows) {
      console.log(
        `   ${String(r.id).padEnd(6)}  ${String(r.store_name ?? r.store_id).slice(0, 20).padEnd(20)}  ` +
        `${r.date}   ${r.start_time.slice(0, 5)}   ${r.shift_tz.padEnd(16)}  ${r.store_tz.padEnd(16)}  ` +
        `${r.gate_opens_store_local ?? '?'}`,
      );
    }
  }

  const p = out.past_drift_summary as { rows_affected: string; first_date: string | null; last_date: string | null };
  console.log('');
  console.log(`2. Past shifts with the same drift: ${p.rows_affected}` +
    (Number(p.rows_affected) > 0 ? ` (${p.first_date} to ${p.last_date})` : ''));
  console.log('   Lateness for those days was measured against the wrong hour.');
  console.log('   Not repaired by default — see repairShiftTimezones.ts --include-past.');

  const bare = out.stores_without_timezone as Array<Record<string, unknown>>;
  console.log('');
  console.log(`3. Active stores with no timezone set: ${bare.length}`);
  for (const s of bare) {
    console.log(`   store ${s.id} — ${s.name} (${s.code}), country ${s.country ?? 'unset'}`);
  }

  console.log('');
  console.log('4. Timezones in use across all shifts:');
  for (const z of out.zones_in_use as Array<{ timezone: string; shifts: string }>) {
    console.log(`   ${String(z.timezone).padEnd(20)} ${z.shifts}`);
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
