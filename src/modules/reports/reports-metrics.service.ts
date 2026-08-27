/**
 * Computes the KPI layer that sits on the front of every report.
 *
 * Three things the original generator never did:
 *  1. Every headline metric is computed for the current window AND the immediately
 *     preceding window of equal length, so we can show a delta.
 *  2. Values are classified against configurable thresholds into RAG statuses,
 *     which drives the "needs attention" page.
 *  3. Everything is scoped: an Admin report covers the whole company, an HR report
 *     covers only that HR user's store.
 *
 * The appendix no longer dumps rows. It aggregates - per store, per person - because
 * "Como Centro completed 78% of its shifts" is a decision and "Rossi checked in at
 * 09:03" is not.
 */

import { query } from '../../config/database';
import { coalescedShiftPointUtcSql } from '../../utils/shiftTimezone';
import {
  ReportThresholds,
  RagStatus,
  ragAscending,
  ragDescending,
  RAG_SEVERITY_RANK,
} from './reports-thresholds';
import { KpiCard, ExceptionItem, TrendRow } from './reports-pdf.kit';
import {
  APPROVED_LEAVE_STATUS_SQL,
  loadApprovedLeaveDays,
  leaveCoverageKey,
} from '../../utils/leaveCoverage';

/**
 * True when shift `s` falls on a day the employee had approved full-day leave.
 * Such a shift was never a real staffing expectation, so it belongs in neither
 * the numerator nor the denominator of the completion/absence KPIs.
 */
const SHIFT_COVERED_BY_LEAVE_SQL = `EXISTS (
  SELECT 1 FROM leave_requests lr
   WHERE lr.company_id = s.company_id
     AND lr.user_id    = s.user_id
     AND ${APPROVED_LEAVE_STATUS_SQL.replace('status', 'lr.status')}
     AND COALESCE(lr.leave_duration_type, 'full_day') <> 'short_leave'
     AND s.date BETWEEN lr.start_date AND lr.end_date
)`;

// shifts.start_time is wall-clock in the store's timezone. Parsing "09:00" in Node
// resolves it against the SERVER's timezone, which silently turns every shift into
// a multi-hour "late arrival" whenever the server is not in the store's zone.
// Resolve the true UTC instant in SQL instead, exactly as the attendance module does.
const SHIFT_START_UTC_SQL = coalescedShiftPointUtcSql('s.start_at_utc', 's.date', 's.start_time', 's.timezone');
const SHIFT_END_UTC_SQL = coalescedShiftPointUtcSql('s.end_at_utc', 's.date', 's.end_time', 's.timezone');

export interface Period {
  start: Date;
  end: Date;
}

/** Company-wide when storeId is null; a single store otherwise. */
export interface ReportScope {
  companyId: number;
  storeId?: number | null;
}

const DAY_MS = 86_400_000;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The window of equal length immediately preceding `period`. */
export function previousPeriod(period: Period): Period {
  const lengthMs = period.end.getTime() - period.start.getTime();
  const end = new Date(period.start.getTime() - DAY_MS);
  const start = new Date(end.getTime() - lengthMs);
  return { start, end };
}

/**
 * Percentage change. Returns null when there is no baseline to compare against,
 * because "up 100% from zero" is noise, not signal.
 */
export function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

async function scalar(sql: string, params: unknown[]): Promise<number> {
  const rows = await query<{ n: string | number }>(sql, params);
  const raw = rows[0]?.n ?? 0;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// Anomalies
// ---------------------------------------------------------------------------

export interface AnomalyRecord {
  userId: number;
  userName: string;
  storeName: string;
  date: string;
  kind: 'no_show' | 'late' | 'early_exit';
  minutes: number;
  severity: RagStatus;
}

interface ShiftRow {
  user_id: number;
  date: string;
  /** True UTC instants, resolved in SQL against the store's timezone. */
  start_utc: string;
  end_utc: string;
  user_name: string;
  user_surname: string;
  store_name: string | null;
}

interface EventRow {
  user_id: number;
  event_type: string;
  event_time: string;
}

/**
 * Threshold-driven reimplementation of the inline anomaly engine, returning
 * structured records instead of drawing straight to the page.
 */
export async function computeAnomalies(
  scope: ReportScope,
  period: Period,
  thresholds: ReportThresholds,
): Promise<AnomalyRecord[]> {
  const params = [scope.companyId, iso(period.start), iso(period.end), scope.storeId ?? null];

  const shifts = await query<ShiftRow>(
    `SELECT s.user_id, TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
            ${SHIFT_START_UTC_SQL} AS start_utc,
            ${SHIFT_END_UTC_SQL} AS end_utc,
            u.name AS user_name, u.surname AS user_surname,
            st.name AS store_name
       FROM shifts s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN stores st ON st.id = s.store_id
      WHERE s.company_id = $1
        AND s.date BETWEEN $2 AND $3
        AND s.status <> 'cancelled'
        AND ($4::int IS NULL OR s.store_id = $4)
      ORDER BY s.date, s.user_id`,
    params,
  );

  const events = await query<EventRow>(
    `SELECT ae.user_id, ae.event_type, ae.event_time
       FROM attendance_events ae
      WHERE ae.company_id = $1
        AND ae.event_time::DATE BETWEEN $2 AND $3
        AND ($4::int IS NULL OR ae.store_id = $4)
      ORDER BY ae.event_time ASC`,
    params,
  );

  const byUserDay = new Map<string, EventRow[]>();
  for (const ev of events) {
    const key = `${ev.user_id}_${new Date(ev.event_time).toISOString().slice(0, 10)}`;
    const bucket = byUserDay.get(key);
    if (bucket) bucket.push(ev);
    else byUserDay.set(key, [ev]);
  }

  // Days already covered by approved leave. Shifts are only cancelled when the
  // approver ticks the optional cancel_shifts box, so an active shift is not
  // evidence that the person was expected in.
  const leaveDays = await loadApprovedLeaveDays(
    [scope.companyId], iso(period.start), iso(period.end), { storeId: scope.storeId ?? null },
  );

  const out: AnomalyRecord[] = [];

  for (const shift of shifts) {
    const dayEvents = byUserDay.get(`${shift.user_id}_${shift.date}`) ?? [];
    const checkins = dayEvents.filter(e => e.event_type === 'checkin');
    const checkouts = dayEvents.filter(e => e.event_type === 'checkout');
    const userName = `${shift.user_surname ?? ''} ${shift.user_name}`.trim();
    // pdf-lib standard fonts are WinAnsi-encoded and throw outside it, so ASCII placeholders.
    const storeName = shift.store_name ?? '-';

    if (checkins.length === 0 && checkouts.length === 0) {
      // Approved leave is a justified absence: it must not count as a no-show,
      // inflate the absence rate, or pull the store's traffic light down.
      if (!leaveDays.has(leaveCoverageKey(shift.user_id, shift.date))) {
        out.push({ userId: shift.user_id, userName, storeName, date: shift.date, kind: 'no_show', minutes: 0, severity: 'red' });
      }
      continue;
    }

    // Both sides are absolute instants now, so the subtraction is timezone-safe.
    if (checkins.length > 0) {
      const scheduled = new Date(shift.start_utc);
      const late = Math.round((new Date(checkins[0].event_time).getTime() - scheduled.getTime()) / 60_000);
      if (late > thresholds.lateArrivalMinutes) {
        out.push({
          userId: shift.user_id, userName, storeName, date: shift.date, kind: 'late', minutes: late,
          severity: late > thresholds.lateArrivalCriticalMinutes ? 'red' : 'amber',
        });
      }
    }

    if (checkouts.length > 0) {
      const scheduled = new Date(shift.end_utc);
      const early = Math.round((scheduled.getTime() - new Date(checkouts[checkouts.length - 1].event_time).getTime()) / 60_000);
      if (early > thresholds.earlyDepartureMinutes) {
        out.push({
          userId: shift.user_id, userName, storeName, date: shift.date, kind: 'early_exit', minutes: early,
          severity: early > thresholds.earlyDepartureCriticalMinutes ? 'red' : 'amber',
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface PeriodSnapshot {
  headcount: number;
  hires: number;
  terminations: number;
  scheduledShifts: number;
  /** A shift with both a check-in and a check-out recorded. */
  completedShifts: number;
  cancelledShifts: number;
  anomalies: number;
  noShows: number;
  lateArrivals: number;
  pendingLeave: number;
  approvedLeave: number;
  attendanceEvents: number;
}

export function completionRate(s: PeriodSnapshot): number {
  return rate(s.completedShifts, s.scheduledShifts);
}

export function absenceRate(s: PeriodSnapshot): number {
  return rate(s.noShows, s.scheduledShifts);
}

export function turnoverRate(s: PeriodSnapshot): number {
  return rate(s.terminations, s.headcount);
}

/** All headline counters for a single window. Called twice per report. */
export async function snapshotPeriod(
  scope: ReportScope,
  period: Period,
  thresholds: ReportThresholds,
): Promise<PeriodSnapshot> {
  const startStr = iso(period.start);
  const endStr = iso(period.end);
  const store = scope.storeId ?? null;
  const co = scope.companyId;

  const [
    headcount, hires, terminations,
    scheduledShifts, completedShifts, cancelledShifts,
    pendingLeave, approvedLeave, attendanceEvents,
  ] = await Promise.all([
    // Headcount as of the END of the window, not "today".
    // super_admin is a boolean flag, not a role enum value; store_terminal is a
    // device account rather than a person, so neither counts toward headcount.
    scalar(
      `SELECT COUNT(*) AS n FROM users
        WHERE company_id = $1
          AND NOT COALESCE(is_super_admin, false)
          AND role <> 'store_terminal'
          AND ($3::int IS NULL OR store_id = $3)
          AND (hire_date IS NULL OR hire_date <= $2)
          AND (termination_date IS NULL OR termination_date > $2)`,
      [co, endStr, store],
    ),
    scalar(
      `SELECT COUNT(*) AS n FROM users
        WHERE company_id = $1 AND role <> 'store_terminal'
          AND ($4::int IS NULL OR store_id = $4)
          AND hire_date BETWEEN $2 AND $3`,
      [co, startStr, endStr, store],
    ),
    scalar(
      `SELECT COUNT(*) AS n FROM users
        WHERE company_id = $1 AND role <> 'store_terminal'
          AND ($4::int IS NULL OR store_id = $4)
          AND termination_date BETWEEN $2 AND $3`,
      [co, startStr, endStr, store],
    ),
    // Shifts the company actually expected someone to work. A shift on a day
    // covered by approved leave was never a real expectation — counting it
    // would depress the completion rate exactly the way a no-show does, so
    // excluding it from the no-show list alone would not fix the KPI.
    scalar(
      `SELECT COUNT(*) AS n FROM shifts s
        WHERE s.company_id = $1 AND s.date BETWEEN $2 AND $3
          AND s.status <> 'cancelled'
          AND ($4::int IS NULL OR s.store_id = $4)
          AND NOT ${SHIFT_COVERED_BY_LEAVE_SQL}`,
      [co, startStr, endStr, store],
    ),
    // A shift counts as completed only when the person both arrived and left.
    scalar(
      `SELECT COUNT(*) AS n FROM shifts s
        WHERE s.company_id = $1 AND s.date BETWEEN $2 AND $3
          AND s.status <> 'cancelled'
          AND ($4::int IS NULL OR s.store_id = $4)
          AND NOT ${SHIFT_COVERED_BY_LEAVE_SQL}
          AND EXISTS (SELECT 1 FROM attendance_events e
                       WHERE e.user_id = s.user_id AND e.event_type = 'checkin'
                         AND e.event_time::DATE = s.date)
          AND EXISTS (SELECT 1 FROM attendance_events e
                       WHERE e.user_id = s.user_id AND e.event_type = 'checkout'
                         AND e.event_time::DATE = s.date)`,
      [co, startStr, endStr, store],
    ),
    scalar(
      `SELECT COUNT(*) AS n FROM shifts
        WHERE company_id = $1 AND date BETWEEN $2 AND $3
          AND status = 'cancelled'
          AND ($4::int IS NULL OR store_id = $4)`,
      [co, startStr, endStr, store],
    ),
    scalar(
      `SELECT COUNT(*) AS n FROM leave_requests
        WHERE company_id = $1 AND status = 'pending'
          AND ($4::int IS NULL OR store_id = $4)
          AND start_date <= $3 AND end_date >= $2`,
      [co, startStr, endStr, store],
    ),
    scalar(
      `SELECT COUNT(*) AS n FROM leave_requests
        WHERE company_id = $1 AND status ILIKE '%approved%'
          AND ($4::int IS NULL OR store_id = $4)
          AND start_date <= $3 AND end_date >= $2`,
      [co, startStr, endStr, store],
    ),
    scalar(
      `SELECT COUNT(*) AS n FROM attendance_events
        WHERE company_id = $1 AND event_time::DATE BETWEEN $2 AND $3
          AND ($4::int IS NULL OR store_id = $4)`,
      [co, startStr, endStr, store],
    ),
  ]);

  const anomalyRecords = await computeAnomalies(scope, period, thresholds);

  return {
    headcount, hires, terminations,
    scheduledShifts, completedShifts, cancelledShifts,
    anomalies: anomalyRecords.length,
    noShows: anomalyRecords.filter(a => a.kind === 'no_show').length,
    lateArrivals: anomalyRecords.filter(a => a.kind === 'late').length,
    pendingLeave, approvedLeave, attendanceEvents,
  };
}

// ---------------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------------

/**
 * The six cards that make up page one. Each answers a question the reader would
 * otherwise have to compute by hand: how much work did we plan, how much of it
 * actually happened, and what got in the way.
 */
export function buildKpiCards(
  current: PeriodSnapshot,
  previous: PeriodSnapshot,
  thresholds: ReportThresholds,
): KpiCard[] {
  const completion = completionRate(current);
  const prevCompletion = completionRate(previous);
  const absence = absenceRate(current);
  const prevAbsence = absenceRate(previous);
  const turnover = turnoverRate(current);
  const prevTurnover = turnoverRate(previous);

  return [
    {
      label: 'Turni pianificati',
      value: String(current.scheduledShifts),
      deltaPct: pctChange(current.scheduledShifts, previous.scheduledShifts),
      higherIsBetter: true,
      status: 'green',
      sublabel: `${current.completedShifts} completati / ${current.cancelledShifts} annullati`,
    },
    {
      label: 'Tasso di completamento',
      value: `${completion.toFixed(1)}%`,
      deltaPct: pctChange(completion, prevCompletion),
      higherIsBetter: true,
      status: ragDescending(completion, thresholds.shiftCoverageAmber, thresholds.shiftCoverageRed),
      sublabel: `${current.scheduledShifts - current.completedShifts} turni non completati`,
    },
    {
      label: 'Anomalie rilevate',
      value: String(current.anomalies),
      deltaPct: pctChange(current.anomalies, previous.anomalies),
      higherIsBetter: false,
      status: ragAscending(current.anomalies, thresholds.storeAnomalyAmber, thresholds.storeAnomalyRed),
      sublabel: `${current.noShows} assenze / ${current.lateArrivals} ritardi`,
    },
    {
      label: 'Tasso di assenza',
      value: `${absence.toFixed(1)}%`,
      deltaPct: pctChange(absence, prevAbsence),
      higherIsBetter: false,
      status: ragAscending(absence, thresholds.absenceRateAmber, thresholds.absenceRateRed),
      sublabel: `${current.noShows} assenze ingiustificate`,
    },
    {
      label: 'Ferie da approvare',
      value: String(current.pendingLeave),
      deltaPct: pctChange(current.pendingLeave, previous.pendingLeave),
      higherIsBetter: false,
      status: ragAscending(current.pendingLeave, thresholds.pendingLeaveAgeAmber, thresholds.pendingLeaveAgeRed),
      sublabel: `${current.approvedLeave} approvate nel periodo`,
    },
    {
      label: 'Organico attivo',
      value: String(current.headcount),
      deltaPct: pctChange(current.headcount, previous.headcount),
      higherIsBetter: true,
      status: ragAscending(turnover, thresholds.turnoverAmber, thresholds.turnoverRed),
      sublabel: `+${current.hires} assunti / -${current.terminations} usciti (turnover ${turnover.toFixed(1)}%)`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Aggregated breakdowns — these replace the old raw row dumps
// ---------------------------------------------------------------------------

export interface StoreBreakdownRow {
  storeName: string;
  scheduled: number;
  completed: number;
  anomalies: number;
  completionPct: number;
  status: RagStatus;
}

/** Per-store performance. The single most actionable table an Admin can read. */
export async function buildStoreBreakdown(
  scope: ReportScope,
  period: Period,
  thresholds: ReportThresholds,
  anomalies: AnomalyRecord[],
): Promise<StoreBreakdownRow[]> {
  const rows = await query<{ store_name: string | null; scheduled: string; completed: string }>(
    `SELECT st.name AS store_name,
            COUNT(*) FILTER (WHERE s.status <> 'cancelled') AS scheduled,
            COUNT(*) FILTER (
              WHERE s.status <> 'cancelled'
                AND EXISTS (SELECT 1 FROM attendance_events e
                             WHERE e.user_id = s.user_id AND e.event_type = 'checkin'
                               AND e.event_time::DATE = s.date)
                AND EXISTS (SELECT 1 FROM attendance_events e
                             WHERE e.user_id = s.user_id AND e.event_type = 'checkout'
                               AND e.event_time::DATE = s.date)
            ) AS completed
       FROM shifts s
       LEFT JOIN stores st ON st.id = s.store_id
      WHERE s.company_id = $1 AND s.date BETWEEN $2 AND $3
        AND ($4::int IS NULL OR s.store_id = $4)
        AND NOT ${SHIFT_COVERED_BY_LEAVE_SQL}
      GROUP BY st.name
      ORDER BY COUNT(*) DESC`,
    [scope.companyId, iso(period.start), iso(period.end), scope.storeId ?? null],
  );

  const anomaliesByStore = new Map<string, number>();
  for (const a of anomalies) anomaliesByStore.set(a.storeName, (anomaliesByStore.get(a.storeName) ?? 0) + 1);

  return rows.map(r => {
    const storeName = r.store_name ?? '-';
    const scheduled = Number(r.scheduled);
    const completed = Number(r.completed);
    const pct = rate(completed, scheduled);
    return {
      storeName,
      scheduled,
      completed,
      anomalies: anomaliesByStore.get(storeName) ?? 0,
      completionPct: pct,
      status: ragDescending(pct, thresholds.shiftCoverageAmber, thresholds.shiftCoverageRed),
    };
  });
}

export interface PersonBreakdownRow {
  userName: string;
  storeName: string;
  noShows: number;
  late: number;
  earlyExit: number;
  total: number;
}

/** Who is driving the anomaly count. Worst first; the reader acts on the top few. */
export function buildPeopleBreakdown(anomalies: AnomalyRecord[]): PersonBreakdownRow[] {
  const byPerson = new Map<number, PersonBreakdownRow>();
  for (const a of anomalies) {
    let row = byPerson.get(a.userId);
    if (!row) {
      row = { userName: a.userName, storeName: a.storeName, noShows: 0, late: 0, earlyExit: 0, total: 0 };
      byPerson.set(a.userId, row);
    }
    if (a.kind === 'no_show') row.noShows++;
    else if (a.kind === 'late') row.late++;
    else row.earlyExit++;
    row.total++;
  }
  return [...byPerson.values()].sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

/**
 * The "needs attention" page. Only threshold breaches appear here; anything green
 * is deliberately omitted. Sorted worst-first.
 */
export async function buildExceptions(
  scope: ReportScope,
  period: Period,
  thresholds: ReportThresholds,
  anomalies: AnomalyRecord[],
  storeBreakdown: StoreBreakdownRow[],
): Promise<ExceptionItem[]> {
  const items: ExceptionItem[] = [];
  const today = iso(period.end);
  const store = scope.storeId ?? null;

  // Stores whose completion rate has dropped below tolerance.
  for (const s of storeBreakdown) {
    if (s.status === 'green' || s.scheduled === 0) continue;
    items.push({
      status: s.status,
      title: `Completamento turni basso: ${s.storeName}`,
      detail: `${s.completionPct.toFixed(0)}% completati (${s.completed}/${s.scheduled}), ${s.anomalies} anomalie`,
      scope: s.storeName,
    });
  }

  // Stores accumulating anomalies.
  const byStore = new Map<string, number>();
  for (const a of anomalies) byStore.set(a.storeName, (byStore.get(a.storeName) ?? 0) + 1);
  for (const [storeName, count] of byStore) {
    const status = ragAscending(count, thresholds.storeAnomalyAmber, thresholds.storeAnomalyRed);
    if (status === 'green') continue;
    items.push({
      status,
      title: `Anomalie concentrate: ${storeName}`,
      detail: `${count} anomalie nel periodo (soglia: ${thresholds.storeAnomalyAmber})`,
      scope: storeName,
    });
  }

  const contracts = await query<{ name: string; surname: string; contract_end_date: string; days_left: number }>(
    `SELECT name, surname, contract_end_date, (contract_end_date - $2::date) AS days_left
       FROM users
      WHERE company_id = $1
        AND ($4::int IS NULL OR store_id = $4)
        AND contract_end_date IS NOT NULL
        AND termination_date IS NULL
        AND contract_end_date >= $2::date
        AND contract_end_date <= $2::date + $3::int
      ORDER BY contract_end_date ASC`,
    [scope.companyId, today, thresholds.contractExpiryAmber, store],
  );
  for (const c of contracts) {
    items.push({
      status: ragDescending(Number(c.days_left), thresholds.contractExpiryAmber, thresholds.contractExpiryRed),
      title: `Contratto in scadenza: ${c.surname ?? ''} ${c.name}`.trim(),
      detail: `Scade tra ${c.days_left} giorni (${new Date(c.contract_end_date).toLocaleDateString('it-IT')})`,
      scope: 'Contratti',
    });
  }

  const staleLeave = await query<{ name: string; surname: string; age_days: number }>(
    `SELECT u.name, u.surname, EXTRACT(DAY FROM (NOW() - lr.created_at))::int AS age_days
       FROM leave_requests lr
       JOIN users u ON u.id = lr.user_id
      WHERE lr.company_id = $1
        AND ($3::int IS NULL OR lr.store_id = $3)
        AND lr.status = 'pending'
        AND lr.created_at <= NOW() - ($2::int * INTERVAL '1 day')
      ORDER BY lr.created_at ASC`,
    [scope.companyId, thresholds.pendingLeaveAgeAmber, store],
  );
  for (const l of staleLeave) {
    items.push({
      status: ragAscending(Number(l.age_days), thresholds.pendingLeaveAgeAmber, thresholds.pendingLeaveAgeRed),
      title: `Richiesta ferie non evasa: ${l.surname ?? ''} ${l.name}`.trim(),
      detail: `In attesa da ${l.age_days} giorni`,
      scope: 'Ferie & permessi',
    });
  }

  const stalled = await query<{ full_name: string; status: string; age_days: number }>(
    `SELECT full_name, status, EXTRACT(DAY FROM (NOW() - last_stage_change))::int AS age_days
       FROM candidates
      WHERE company_id = $1
        AND ($3::int IS NULL OR store_id = $3)
        AND status NOT IN ('hired', 'rejected')
        AND last_stage_change <= NOW() - ($2::int * INTERVAL '1 day')
      ORDER BY last_stage_change ASC`,
    [scope.companyId, thresholds.candidateStallAmber, store],
  );
  for (const c of stalled) {
    items.push({
      status: ragAscending(Number(c.age_days), thresholds.candidateStallAmber, thresholds.candidateStallRed),
      title: `Candidato fermo: ${c.full_name}`,
      detail: `Fermo in stato "${c.status}" da ${c.age_days} giorni`,
      scope: 'Selezione (ATS)',
    });
  }

  items.sort((a, b) => RAG_SEVERITY_RANK[a.status] - RAG_SEVERITY_RANK[b.status]);
  return items;
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

/**
 * Trailing sparkline series. Walks back `buckets` windows of the same length as
 * `period` and re-snapshots each - bounded work, since buckets is small.
 */
export async function buildTrends(
  scope: ReportScope,
  period: Period,
  thresholds: ReportThresholds,
  buckets = 6,
): Promise<TrendRow[]> {
  const lengthMs = period.end.getTime() - period.start.getTime();
  const snapshots: PeriodSnapshot[] = [];

  for (let i = buckets - 1; i >= 0; i--) {
    const end = new Date(period.end.getTime() - i * (lengthMs + DAY_MS));
    const start = new Date(end.getTime() - lengthMs);
    snapshots.push(await snapshotPeriod(scope, { start, end }, thresholds));
  }

  const latest = snapshots[snapshots.length - 1];
  const completionSeries = snapshots.map(completionRate);
  const absenceSeries = snapshots.map(absenceRate);
  const latestCompletion = completionSeries[completionSeries.length - 1];
  const latestAbsence = absenceSeries[absenceSeries.length - 1];

  return [
    {
      label: 'Turni pianificati',
      values: snapshots.map(s => s.scheduledShifts),
      current: String(latest.scheduledShifts),
      status: 'green',
    },
    {
      label: 'Tasso di completamento',
      values: completionSeries,
      current: `${latestCompletion.toFixed(1)}%`,
      status: ragDescending(latestCompletion, thresholds.shiftCoverageAmber, thresholds.shiftCoverageRed),
    },
    {
      label: 'Anomalie per periodo',
      values: snapshots.map(s => s.anomalies),
      current: String(latest.anomalies),
      status: ragAscending(latest.anomalies, thresholds.storeAnomalyAmber, thresholds.storeAnomalyRed),
    },
    {
      label: 'Tasso di assenza',
      values: absenceSeries,
      current: `${latestAbsence.toFixed(1)}%`,
      status: ragAscending(latestAbsence, thresholds.absenceRateAmber, thresholds.absenceRateRed),
    },
  ];
}
