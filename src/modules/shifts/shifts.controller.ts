import { Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { query, queryOne } from '../../config/database';
import { ok, created, notFound, conflict, forbidden, badRequest } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { UserRole } from '../../config/jwt';
import { resolveAllowedCompanyIds } from '../../utils/companyScope';
import { validateShiftCrossFields } from './shifts.routes';
import { coalescedShiftPointUtcSql, DEFAULT_SHIFT_TIMEZONE, normalizeShiftTimezone, resolveStoreTimezone } from '../../utils/shiftTimezone';
import { sendNotification } from '../notifications/notifications.service';
import { sendShiftCreatedAutomation } from '../automations/shiftNotification';
import { t } from '../../utils/i18n';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { APPROVED_LEAVE_STATUS_SQL } from '../../utils/leaveCoverage';

/**
 * Approved leave covering a date the caller is about to schedule.
 *
 * Shift creation checked overlaps with other shifts but never asked whether the
 * person was already on approved holiday or sick leave, so rosters were built
 * against days the employee could not work — and because approval only cancels
 * shifts when the optional `cancel_shifts` box is ticked, those shifts stayed
 * active and turned into false "unjustified absence" records.
 *
 * Reported as a warning the operator can override rather than a hard block:
 * leave can be revoked, and a partial-day permission does not always rule out
 * a shift.
 */
async function findLeaveConflict(
  companyId: number,
  userId: number,
  date: string,
): Promise<{ id: number; leave_type: string; start_date: string; end_date: string; leave_duration_type: string | null } | null> {
  return queryOne(
    `SELECT id, leave_type,
            TO_CHAR(start_date, 'YYYY-MM-DD') AS start_date,
            TO_CHAR(end_date,   'YYYY-MM-DD') AS end_date,
            leave_duration_type
       FROM leave_requests
      WHERE company_id = $1
        AND user_id = $2
        AND ${APPROVED_LEAVE_STATUS_SQL}
        AND start_date <= $3::date
        AND end_date   >= $3::date
      LIMIT 1`,
    [companyId, userId, date],
  );
}

// ---------------------------------------------------------------------------
// Helper: parse a cell value as HH:MM time string (handles Excel fractions, Date, string)
// ---------------------------------------------------------------------------
function parseTimeCell(val: unknown): string | null {
  if (!val && val !== 0) return null;
  if (typeof val === 'string') {
    const s = val.trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
      const parts = s.split(':');
      return `${parts[0].padStart(2, '0')}:${parts[1]}`;
    }
    return null;
  }
  if (typeof val === 'number' && val >= 0 && val < 1) {
    const totalMins = Math.round(val * 24 * 60);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  if (val instanceof Date) {
    return `${String(val.getHours()).padStart(2, '0')}:${String(val.getMinutes()).padStart(2, '0')}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: parse a cell value as YYYY-MM-DD date string
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Helper: ensure date is YYYY-MM-DD
// ---------------------------------------------------------------------------
function normalizeDate(d: string): string {
  if (!d) return '1970-01-01';
  const s = d.trim();
  // Handle MM/DD/YYYY (USA)
  const mUsa = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mUsa) {
    return `${mUsa[3]}-${mUsa[1].padStart(2, '0')}-${mUsa[2].padStart(2, '0')}`;
  }
  // Handle DD-MM-YYYY
  const mEu = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (mEu) {
    return `${mEu[3]}-${mEu[2].padStart(2, '0')}-${mEu[1].padStart(2, '0')}`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Helper: ensure time is HH:MM:00
// ---------------------------------------------------------------------------
function normalizeTime(t: string | null | undefined): string {
  if (!t || typeof t !== 'string' || t.trim() === '') return '00:00:00';
  const s = t.trim();
  const parts = s.split(':');
  const h = parts[0].padStart(2, '0');
  const m = (parts[1] || '00').padStart(2, '0');
  const sec = (parts[2] || '00').padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

function parseDateCell(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'string') {
    const s = val.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return null;
  }
  if (val instanceof Date) {
    const y = val.getFullYear();
    const mo = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  // Excel date serial (integer > 1): days since 1899-12-30
  if (typeof val === 'number' && val > 1) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(val) * 86400000);
    const y = date.getUTCFullYear();
    const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: get a field from a row object, case-insensitively, trying multiple names
// ---------------------------------------------------------------------------
function getField(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const found = Object.keys(row).find(
      rk => rk.toLowerCase().replace(/[\s_]/g, '') === k.toLowerCase().replace(/[\s_]/g, '')
    );
    if (found !== undefined) return row[found];
  }
  return '';
}

// ---------------------------------------------------------------------------
// Helper: parse ISO week string '2026-W11' → '2026-11' for TO_DATE('IYYY-IW')
// ---------------------------------------------------------------------------
function parseIsoWeek(week: string): string {
  return week.replace('-W', '-');
}

// ---------------------------------------------------------------------------
// Helper: compute shift_hours as decimal hours
// (end_time - start_time) - break_duration
// For flexible breaks: use break_minutes/60; for fixed: use break_end - break_start
// ---------------------------------------------------------------------------
function shiftHoursExpr(): string {
  return `
    ROUND(
      GREATEST(0,
        EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 3600.0
        - CASE
            WHEN s.break_type = 'flexible' AND s.break_minutes IS NOT NULL
              THEN s.break_minutes / 60.0
            ELSE COALESCE(
              EXTRACT(EPOCH FROM (s.break_end - s.break_start)) / 3600.0,
              0
            )
          END
        + CASE WHEN s.is_split AND s.split_start2 IS NOT NULL AND s.split_end2 IS NOT NULL
            THEN EXTRACT(EPOCH FROM (s.split_end2 - s.split_start2)) / 3600.0
            ELSE 0
          END
      )::NUMERIC,
      2
    ) AS shift_hours
  `;
}

function parseDateOnly(value: unknown): string | null {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

async function hasExplicitOffDayShift(params: {
  companyId: number;
  userId: number;
  date: string;
  excludeShiftId?: number;
}): Promise<boolean> {
  const hasExclude = typeof params.excludeShiftId === 'number';
  const offDayShift = await queryOne<{ id: number }>(
    hasExclude
      ? `SELECT id
         FROM shifts
         WHERE company_id = $1
           AND user_id = $2
           AND date = $3
           AND COALESCE(is_off_day, false) = true
           AND id <> $4
         LIMIT 1`
      : `SELECT id
         FROM shifts
         WHERE company_id = $1
           AND user_id = $2
           AND date = $3
           AND COALESCE(is_off_day, false) = true
         LIMIT 1`,
    hasExclude
      ? [params.companyId, params.userId, params.date, params.excludeShiftId]
      : [params.companyId, params.userId, params.date],
  );
  return Boolean(offDayShift);
}

async function cancelWorkingShiftsForOffDay(params: {
  companyId: number;
  userId: number;
  date: string;
  excludeShiftId?: number;
}) {
  const hasExclude = typeof params.excludeShiftId === 'number';
  await query(
    hasExclude
      ? `UPDATE shifts
         SET status = 'cancelled', updated_at = NOW()
         WHERE company_id = $1
           AND user_id = $2
           AND date = $3
           AND status != 'cancelled'
           AND id <> $4`
      : `UPDATE shifts
         SET status = 'cancelled', updated_at = NOW()
         WHERE company_id = $1
           AND user_id = $2
           AND date = $3
           AND status != 'cancelled'`,
    hasExclude
      ? [params.companyId, params.userId, params.date, params.excludeShiftId]
      : [params.companyId, params.userId, params.date],
  );
}

const SHIFT_FIELDS = `
  s.id, s.company_id, s.store_id, s.user_id, s.assignment_id,
  TO_CHAR(s.date::date, 'YYYY-MM-DD') AS date,
  s.timezone,
  s.start_time, s.end_time, s.break_start, s.break_end,
  s.start_at_utc, s.end_at_utc,
  s.break_start_at_utc, s.break_end_at_utc,
  s.break_type, s.break_minutes,
  s.is_split, s.split_start2, s.split_end2,
  s.split_start2_at_utc, s.split_end2_at_utc,
  s.is_off_day,
  s.status, s.notes, s.created_by, s.created_at, s.updated_at,
  st.name AS store_name,
  u.name AS user_name, u.surname AS user_surname,
  u.avatar_filename AS user_avatar_filename,
  ${shiftHoursExpr()}
`;

const BASE_JOINS = `
  FROM shifts s
  LEFT JOIN stores st ON st.id = s.store_id
  LEFT JOIN users u   ON u.id  = s.user_id
`;

const SHIFT_START_UTC_SQL = coalescedShiftPointUtcSql('s.start_at_utc', 's.date', 's.start_time', 's.timezone');

async function getShiftById(shiftId: number, companyId: number) {
  return queryOne(
    `SELECT ${SHIFT_FIELDS}
     ${BASE_JOINS}
     WHERE s.id = $1
       AND s.company_id = $2
     LIMIT 1`,
    [shiftId, companyId],
  );
}

async function resolveShiftAssignmentForDate(params: {
  companyId: number;
  userId: number;
  homeStoreId: number | null;
  shiftStoreId: number;
  shiftDate: string;
}): Promise<{ assignmentId: number | null; errorCode?: string; errorMessage?: string }> {
  const activeTransfer = await queryOne<{ id: number; target_store_id: number }>(
    `SELECT id, target_store_id
     FROM temporary_store_assignments
     WHERE company_id = $1
       AND user_id = $2
       AND status = 'active'
       AND start_date::date <= $3::date
       AND end_date::date >= $3::date
     ORDER BY start_date DESC
     LIMIT 1`,
    [params.companyId, params.userId, params.shiftDate],
  );

  if (activeTransfer) {
    if (params.shiftStoreId !== activeTransfer.target_store_id) {
      return {
        assignmentId: null,
        errorCode: 'TRANSFER_STORE_MISMATCH',
        errorMessage: 'Durante un trasferimento attivo il turno deve essere nel negozio di destinazione',
      };
    }
    return { assignmentId: activeTransfer.id };
  }

  if (params.homeStoreId != null && params.shiftStoreId !== params.homeStoreId) {
    return {
      assignmentId: null,
      errorCode: 'TRANSFER_REQUIRED',
      errorMessage: 'Per assegnare il turno a un negozio diverso serve un trasferimento temporaneo attivo',
    };
  }

  return { assignmentId: null };
}

// ---------------------------------------------------------------------------
// Role-based WHERE scope helper
// ---------------------------------------------------------------------------
async function buildShiftScope(
  role: UserRole,
  allowedCompanyIds: number[],
  userId: number,
  storeId: number | null,
): Promise<{ where: string; params: any[] }> {
  const base = `s.company_id = ANY($1)`;
  switch (role) {
    case 'admin':
    case 'hr':
    case 'area_manager':
      return { where: base, params: [allowedCompanyIds] };

    case 'store_manager':
      return {
        where: `${base} AND (
          s.store_id = $2
          OR (
            s.assignment_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM temporary_store_assignments tsa
              WHERE tsa.id = s.assignment_id
                AND (tsa.origin_store_id = $2 OR tsa.target_store_id = $2)
            )
          )
        )`,
        params: [allowedCompanyIds, storeId],
      };

    case 'employee':
    default:
      // Always scope to own user_id — ignore any user_id query param
      return {
        where: `${base} AND s.user_id = $2`,
        params: [allowedCompanyIds, userId],
      };
  }
}

// ---------------------------------------------------------------------------
// GET /api/shifts
// Query params: week=YYYY-WNN | month=YYYY-MM, store_id?, user_id?
// ---------------------------------------------------------------------------
export const listShifts = asyncHandler(async (req: Request, res: Response) => {
  const { role, userId, storeId } = req.user!;
  const { week, month, start_date, end_date, store_id, user_id, company_id, timezone } = req.query as Record<string, string>;
  // `timezone` is still accepted so an older cached bundle keeps working, but it
  // no longer influences which shifts come back — see the date filter below.

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const { where, params } = await buildShiftScope(role, allowedCompanyIds, userId, storeId);
  let extraWhere = '';
  const extra: any[] = [];
  let idx = params.length + 1;

  // Date range filter
  if (week) {
    // Parse ISO week: YYYY-WNN (week must be 1–53)
    const match = week.match(/^(\d{4})-W(\d{1,2})$/);
    if (match) {
      const [, yr, wk] = match;
      const weekNum = parseInt(wk, 10);
      if (weekNum < 1 || weekNum > 53) {
        badRequest(res, 'Settimana non valida: deve essere tra 1 e 53'); return;
      }
      // A shift belongs to the week its DATE falls in — a property of the shift,
      // not of whoever is looking at it. Bounding by instants converted through the
      // viewer's timezone made the answer depend on the viewer: a browser west of
      // the store pushed the boundary forward and dropped early-Monday shifts off
      // the calendar. This matches the start_date/end_date branch below and is
      // correct for a store in any country.
      const weekToken = `${yr}-${wk.padStart(2, '0')}`;
      extraWhere += ` AND s.date >= DATE_TRUNC('week', TO_DATE($${idx}, 'IYYY-IW'))::DATE`;
      extraWhere += ` AND s.date < (DATE_TRUNC('week', TO_DATE($${idx}, 'IYYY-IW'))::DATE + INTERVAL '7 days')`;
      extra.push(weekToken);
      idx += 1;
    }
  } else if (month) {
    const match = month.match(/^(\d{4})-(\d{2})$/);
    if (match) {
      // Same reasoning as the week branch: filter on the shift's own calendar date.
      const monthStart = `${month}-01`;
      extraWhere += ` AND s.date >= $${idx}::DATE`;
      extraWhere += ` AND s.date < (DATE_TRUNC('month', $${idx}::DATE) + INTERVAL '1 month')`;
      extra.push(monthStart);
      idx += 1;
    }
  } else if (start_date && end_date) {
    extraWhere += ` AND s.date >= $${idx}::DATE AND s.date <= $${idx + 1}::DATE`;
    extra.push(start_date, end_date);
    idx += 2;
  }

  // Optional filters (only for non-employee roles)
  if (role !== 'employee') {
    if (company_id) {
      const companyIdNum = parseInt(company_id, 10);
      if (isNaN(companyIdNum)) { badRequest(res, 'company_id non valido'); return; }
      extraWhere += ` AND s.company_id = $${idx}`;
      extra.push(companyIdNum);
      idx++;
    }
    if (store_id) {
      const storeIdNum = parseInt(store_id, 10);
      if (isNaN(storeIdNum)) { badRequest(res, 'store_id non valido'); return; }
      extraWhere += ` AND (
        s.store_id = $${idx}
        OR (
          s.assignment_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM temporary_store_assignments tsa
            WHERE tsa.id = s.assignment_id
              AND (tsa.origin_store_id = $${idx} OR tsa.target_store_id = $${idx})
          )
        )
      )`;
      extra.push(storeIdNum);
      idx++;
    }
    if (user_id) {
      const userIdNum = parseInt(user_id, 10);
      if (isNaN(userIdNum)) { badRequest(res, 'user_id non valido'); return; }
      extraWhere += ` AND s.user_id = $${idx}`;
      extra.push(userIdNum);
      idx++;
    }
  }

  const allParams = [...params, ...extra];
  const shifts = await query(
    `SELECT ${SHIFT_FIELDS} ${BASE_JOINS} WHERE ${where}${extraWhere} ORDER BY ${SHIFT_START_UTC_SQL}`,
    allParams,
  );

  ok(res, { shifts });
});

// ---------------------------------------------------------------------------
// POST /api/shifts
// ---------------------------------------------------------------------------
export const createShift = asyncHandler(async (req: Request, res: Response) => {
  const { userId: callerId, role, storeId: callerStoreId } = req.user!;
  const body = req.body as Record<string, any>;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  // store_manager can only create shifts for their own store
  if (role === 'store_manager' && body.store_id !== callerStoreId) {
    forbidden(res, 'Puoi creare turni solo per il tuo negozio'); return;
  }

  // Resolve target employee (must belong to one of the allowed companies)
  const targetUser = await queryOne<{ id: number; company_id: number; store_id: number | null }>(
    `SELECT id, company_id, store_id
     FROM users
     WHERE id = $1 AND status = 'active' AND company_id = ANY($2)`,
    [body.user_id, allowedCompanyIds]
  );
  if (!targetUser) { notFound(res, 'Dipendente non trovato'); return; }

  const effectiveCompanyId = targetUser.company_id;

  // Validate store belongs to the resolved company and (for area_manager)
  // that they supervise the store_manager for that store.
  const store = await queryOne<{ id: number }>(
    `SELECT id FROM stores WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [body.store_id, effectiveCompanyId]
  );
  if (!store) { notFound(res, 'Negozio non trovato'); return; }

  if (role === 'area_manager') {
    const canManage = await queryOne<{ id: number }>(
      `SELECT id
       FROM users
       WHERE role = 'store_manager'
         AND supervisor_id = $1
         AND company_id = $2
         AND store_id = $3
         AND status = 'active'
       LIMIT 1`,
      [callerId, effectiveCompanyId, body.store_id]
    );
    if (!canManage) {
      forbidden(res, 'Accesso negato'); return;
    }
  }

  const nDate = normalizeDate(body.date);
  const nStartTime = normalizeTime(body.start_time);
  const nEndTime = normalizeTime(body.end_time);

  const assignmentResolution = await resolveShiftAssignmentForDate({
    companyId: effectiveCompanyId,
    userId: body.user_id,
    homeStoreId: targetUser.store_id,
    shiftStoreId: body.store_id,
    shiftDate: nDate,
  });
  if (assignmentResolution.errorCode || assignmentResolution.errorMessage) {
    badRequest(
      res,
      assignmentResolution.errorMessage ?? 'Assegnazione trasferimento non valida',
      assignmentResolution.errorCode ?? 'TRANSFER_REQUIRED',
    );
    return;
  }

  const targetIsOffDay = body.is_off_day === true;

  // Validation: Mandatory fields for working days
  if (!targetIsOffDay) {
    if (!body.start_time || body.start_time.trim() === '' || !body.end_time || body.end_time.trim() === '') {
      badRequest(res, 'Ora inizio e fine obbligatorie per i giorni lavorativi', 'MISSING_TIMES');
      return;
    }
  }

  let insertStatus: string = body.status ?? 'scheduled';
  if (targetIsOffDay) {
    insertStatus = 'cancelled';
  }

  if (role === 'store_manager') {
    if (insertStatus === 'confirmed') {
      forbidden(res, 'Il responsabile di negozio non può confermare i turni');
      return;
    }
    if (insertStatus !== 'scheduled' && insertStatus !== 'cancelled') {
      insertStatus = 'scheduled';
    }
  }

  if (!targetIsOffDay && insertStatus !== 'cancelled') {
    const hasDateOffDay = await hasExplicitOffDayShift({
      companyId: effectiveCompanyId,
      userId: body.user_id,
      date: nDate,
    });
    if (hasDateOffDay) {
      badRequest(
        res,
        'Il dipendente non può ricevere turni nella data marcata come giorno off',
        'OFF_DAY_SHIFT_BLOCKED',
      );
      return;
    }
  }

  if (targetIsOffDay) {
    await cancelWorkingShiftsForOffDay({
      companyId: effectiveCompanyId,
      userId: body.user_id,
      date: nDate,
    });
  }

  if (!targetIsOffDay && insertStatus !== 'cancelled') {
    // Overlap detection: check new main block AND new split block (if any)
    // H6 fix: use <= / >= so identical shifts (same start+end) are also caught
    const overlapMain = await queryOne<{ id: number }>(
      `SELECT id FROM shifts
       WHERE company_id = $1
         AND user_id = $2
         AND date = $3
         AND status != 'cancelled'
         AND (
           (start_time <= $4::TIME AND end_time   >= $5::TIME)
           OR (is_split AND split_start2 IS NOT NULL AND split_end2 IS NOT NULL
               AND split_start2 <= $4::TIME AND split_end2 >= $5::TIME)
         )`,
      [effectiveCompanyId, body.user_id, nDate, nEndTime, nStartTime],
    );

    let overlapSplit = null;
    if (body.is_split && body.split_start2 && body.split_end2) {
      const nSplitStart = normalizeTime(body.split_start2);
      const nSplitEnd = normalizeTime(body.split_end2);
      overlapSplit = await queryOne<{ id: number }>(
        `SELECT id FROM shifts
         WHERE company_id = $1
           AND user_id = $2
           AND date = $3
           AND status != 'cancelled'
           AND (
             (start_time <= $4::TIME AND end_time   >= $5::TIME)
             OR (is_split AND split_start2 IS NOT NULL AND split_end2 IS NOT NULL
                 AND split_start2 <= $4::TIME AND split_end2 >= $5::TIME)
           )`,
        [effectiveCompanyId, body.user_id, nDate, nSplitEnd, nSplitStart],
      );
    }

    if (overlapMain || overlapSplit) {
      conflict(res, 'Turno sovrapposto per questo dipendente in questa data', 'OVERLAP_CONFLICT');
      return;
    }

    // Warn (do not block) when the day is already covered by approved leave.
    // The operator can confirm with confirm_leave_conflict — that acknowledged
    // decision is what stops the shift becoming a false absence later.
    if (body.confirm_leave_conflict !== true) {
      const leaveConflict = await findLeaveConflict(effectiveCompanyId, body.user_id, nDate);
      if (leaveConflict) {
        conflict(
          res,
          'Il dipendente ha un permesso approvato in questa data',
          'LEAVE_CONFLICT',
          {
            leave: leaveConflict,
            hint: 'Conferma per creare comunque il turno, oppure annulla il permesso.',
          },
        );
        return;
      }
    }
  }

  const isFlexible = body.break_type === 'flexible';
  // The zone belongs to the shop the shift is worked at, never to the browser
  // that created it. body.timezone is still accepted so an older cached bundle
  // keeps working, but it no longer decides anything.
  const shiftTimezone = await resolveStoreTimezone(body.store_id, effectiveCompanyId, query);
  const nBreakStart = normalizeTime(body.break_start);
  const nBreakEnd = normalizeTime(body.break_end);
  const nSplitS2 = normalizeTime(body.split_start2);
  const nSplitE2 = normalizeTime(body.split_end2);

  const createdShift = await queryOne<{ id: number }>(
    `INSERT INTO shifts (
       company_id, store_id, user_id, date, timezone, start_time, end_time,
       start_at_utc, end_at_utc,
       assignment_id,
       break_start, break_end, break_start_at_utc, break_end_at_utc,
       break_type, break_minutes,
       is_split, split_start2, split_end2,
       split_start2_at_utc, split_end2_at_utc,
       is_off_day,
       notes, status, created_by
     ) VALUES (
       $1, $2, $3, $4, $5::TEXT, $6, $7,
       (($4::DATE + $6::TIME) AT TIME ZONE $5::TEXT),
       (($4::DATE + (CASE WHEN $7::TIME < $6::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $7::TIME) AT TIME ZONE $5::TEXT),
       $8,
       $9, $10,
       CASE WHEN $9::TIME IS NULL THEN NULL ELSE (($4::DATE + (CASE WHEN $9::TIME < $6::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $9::TIME) AT TIME ZONE $5::TEXT) END,
       CASE WHEN $10::TIME IS NULL THEN NULL ELSE (($4::DATE + (CASE WHEN $10::TIME < $6::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $10::TIME) AT TIME ZONE $5::TEXT) END,
       $11, $12,
       $13, $14, $15,
       CASE WHEN $14::TIME IS NULL THEN NULL ELSE (($4::DATE + (CASE WHEN $14::TIME < $6::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $14::TIME) AT TIME ZONE $5::TEXT) END,
       CASE WHEN $15::TIME IS NULL THEN NULL ELSE (($4::DATE + (CASE WHEN $15::TIME < $6::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $15::TIME) AT TIME ZONE $5::TEXT) END,
       $16,
       $17, $18, $19
     )
     RETURNING id`,
    [
      effectiveCompanyId,
      body.store_id,
      body.user_id,
      nDate,
      shiftTimezone,
      nStartTime,
      nEndTime,
      assignmentResolution.assignmentId,
      isFlexible ? null : (body.break_start ? nBreakStart : null),
      isFlexible ? null : (body.break_end ? nBreakEnd : null),
      body.break_type ?? 'fixed',
      isFlexible ? (body.break_minutes ?? null) : null,
      body.is_split ?? false,
      body.is_split ? nSplitS2 : null,
      body.is_split ? nSplitE2 : null,
      targetIsOffDay,
      body.notes ?? null,
      insertStatus,
      callerId,
    ],
  );

  if (!createdShift) {
    badRequest(res, 'Impossibile creare il turno', 'SHIFT_CREATE_FAILED');
    return;
  }

  const shift = await getShiftById(createdShift.id, effectiveCompanyId);
  if (!shift) {
    badRequest(res, 'Impossibile recuperare il turno creato', 'SHIFT_CREATE_FAILED');
    return;
  }

  const createdLocaleRow = await queryOne<{ locale: string | null }>(
    `SELECT locale FROM users WHERE id = $1 LIMIT 1`,
    [targetUser.id],
  );
  const createdLocale = createdLocaleRow?.locale ?? 'it';

  void sendNotification({
    companyId: effectiveCompanyId,
    userId: targetUser.id,
    type: 'shift.assigned',
    title: t(createdLocale, 'notifications.shift_assigned.title'),
    message: t(createdLocale, 'notifications.shift_assigned.message', {
      date: String(shift.date ?? nDate),
      start: String(shift.start_time ?? '').slice(0, 5),
      end: String(shift.end_time ?? '').slice(0, 5),
      store: String(shift.store_name ?? ''),
    }),
    priority: 'medium',
    locale: createdLocale,
  }).catch(() => undefined);

  // Trigger Shift Created Email Automation (Background task)
  if (shift) {
    sendShiftCreatedAutomation(
      effectiveCompanyId,
      targetUser.id,
      {
        date: String(shift.date ?? nDate),
        start_time: String(shift.start_time ?? ''),
        end_time: String(shift.end_time ?? ''),
        store_name: String(shift.store_name ?? ''),
      }
    ).catch(err => console.error('[AUTOMATION] Background shift email error:', err));
  }

  created(res, shift, 'Turno creato');
});

// ---------------------------------------------------------------------------
// PUT /api/shifts/:id
// ---------------------------------------------------------------------------
export const updateShift = asyncHandler(async (req: Request, res: Response) => {
  const { role, storeId: callerStoreId } = req.user!;
  const shiftId = parseInt(req.params.id, 10);
  if (isNaN(shiftId)) { notFound(res, 'Turno non trovato'); return; }
  const body = req.body as Record<string, any>;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  // Fetch existing shift (include time fields for cross-field validation of partial patches)
  const existing = await queryOne<{
    id: number; company_id: number; store_id: number; user_id: number; assignment_id: number | null; date: string;
    start_time: string; end_time: string;
    break_start: string | null; break_end: string | null;
    break_type: string | null; break_minutes: number | null;
    is_split: boolean; split_start2: string | null; split_end2: string | null;
    timezone: string | null;
    notes: string | null;
    is_off_day: boolean;
    status: 'scheduled' | 'confirmed' | 'cancelled';
  }>(
    `SELECT id, company_id, store_id, user_id, assignment_id, date,
            start_time, end_time, break_start, break_end,
            break_type, break_minutes, is_split, split_start2, split_end2,
            timezone, notes,
            is_off_day,
            status
     FROM shifts WHERE id = $1 AND company_id = ANY($2)`,
    [shiftId, allowedCompanyIds],
  );
  if (!existing) { notFound(res, 'Turno non trovato'); return; }

  // store_manager can only update shifts in their store
  if (role === 'store_manager' && existing.store_id !== callerStoreId) {
    forbidden(res, 'Accesso negato'); return;
  }

  const targetUserId = body.user_id ?? existing.user_id;
  const targetStoreId = body.store_id ?? existing.store_id;
  const targetDate = body.date ?? existing.date;

  if (role === 'store_manager' && targetStoreId !== callerStoreId) {
    forbidden(res, 'Accesso negato');
    return;
  }

  // area_manager can only update shifts in stores they supervise a store_manager for
  if (role === 'area_manager') {
    const canManage = await queryOne<{ id: number }>(
      `SELECT id
       FROM users
       WHERE role = 'store_manager'
         AND supervisor_id = $1
         AND company_id = $2
         AND store_id = $3
         AND status = 'active'
       LIMIT 1`,
      [req.user!.userId, existing.company_id, targetStoreId],
    );
    if (!canManage) {
      forbidden(res, 'Accesso negato'); return;
    }
  }

  const effectiveCompanyId = existing.company_id;

  const targetUser = await queryOne<{ id: number; store_id: number | null }>(
    `SELECT id, store_id
     FROM users
     WHERE id = $1 AND company_id = $2`,
    [targetUserId, effectiveCompanyId],
  );
  if (!targetUser) {
    notFound(res, 'Dipendente non trovato');
    return;
  }

  const targetIsOffDay = body.is_off_day ?? existing.is_off_day;
  const targetStatus = (targetIsOffDay
    ? 'cancelled'
    : (body.status ?? existing.status)) as 'scheduled' | 'confirmed' | 'cancelled';
  // Resolved from the TARGET store, so moving a shift to another shop moves its
  // clock with it — previously the zone stayed behind on the old store.
  const targetShiftTimezone = await resolveStoreTimezone(targetStoreId, effectiveCompanyId, query);

  const targetStart = body.start_time ?? existing.start_time;
  const targetEnd = body.end_time ?? existing.end_time;
  const targetBreakType = (body.break_type ?? existing.break_type ?? 'fixed') as 'fixed' | 'flexible';
  const targetIsFlexible = targetBreakType === 'flexible';
  const targetBreakStart = targetIsFlexible
    ? null
    : (body.break_start !== undefined ? body.break_start : existing.break_start);
  const targetBreakEnd = targetIsFlexible
    ? null
    : (body.break_end !== undefined ? body.break_end : existing.break_end);
  const targetBreakMinutes = targetIsFlexible
    ? (body.break_minutes !== undefined ? body.break_minutes : existing.break_minutes)
    : null;
  const targetIsSplit = body.is_split ?? existing.is_split;
  const targetSplitStart = targetIsSplit
    ? (body.split_start2 !== undefined ? body.split_start2 : existing.split_start2)
    : null;
  const targetSplitEnd = targetIsSplit
    ? (body.split_end2 !== undefined ? body.split_end2 : existing.split_end2)
    : null;
  const targetNotes = body.notes !== undefined ? body.notes : existing.notes;

  // STRICT VALIDATION: Ensure times are present for working days to avoid 500 DB errors
  if (!targetIsOffDay && targetStatus !== 'cancelled') {
    if (!targetStart || targetStart.trim() === '' || !targetEnd || targetEnd.trim() === '') {
      badRequest(res, 'Ora inizio e fine obbligatorie per i giorni lavorativi', 'MISSING_TIMES');
      return;
    }
  }

  if (!targetIsOffDay && targetStatus !== 'cancelled') {
    const hasDateOffDay = await hasExplicitOffDayShift({
      companyId: effectiveCompanyId,
      userId: targetUserId,
      date: targetDate,
      excludeShiftId: shiftId,
    });
    if (hasDateOffDay) {
      badRequest(
        res,
        'Il dipendente non può ricevere turni nella data marcata come giorno off',
        'OFF_DAY_SHIFT_BLOCKED',
      );
      return;
    }
  }

  if (targetIsOffDay) {
    await cancelWorkingShiftsForOffDay({
      companyId: effectiveCompanyId,
      userId: targetUserId,
      date: targetDate,
      excludeShiftId: shiftId,
    });
  }

  const assignmentResolution = await resolveShiftAssignmentForDate({
    companyId: effectiveCompanyId,
    userId: targetUserId,
    homeStoreId: targetUser.store_id,
    shiftStoreId: targetStoreId,
    shiftDate: targetDate,
  });
  if (assignmentResolution.errorCode || assignmentResolution.errorMessage) {
    badRequest(
      res,
      assignmentResolution.errorMessage ?? 'Assegnazione trasferimento non valida',
      assignmentResolution.errorCode ?? 'TRANSFER_REQUIRED',
    );
    return;
  }

  const nTargetDate = normalizeDate(targetDate);
  const nTargetStart = normalizeTime(targetStart);
  const nTargetEnd = normalizeTime(targetEnd);
  const nTargetBreakStart = normalizeTime(targetBreakStart);
  const nTargetBreakEnd = normalizeTime(targetBreakEnd);
  const nTargetSplitStart = normalizeTime(targetSplitStart);
  const nTargetSplitEnd = normalizeTime(targetSplitEnd);

  // H6 fix: use <= / >= so identical shifts (same start+end) are also caught
  if (!targetIsOffDay && targetStatus !== 'cancelled' && targetStart && targetEnd) {
    const overlapMain = await queryOne<{ id: number }>(
      `SELECT id FROM shifts
       WHERE company_id = $1
         AND user_id = $2
         AND date = $3
         AND status != 'cancelled'
         AND id != $4
         AND (
           (start_time <= $5::TIME AND end_time   >= $6::TIME)
           OR (is_split AND split_start2 IS NOT NULL AND split_end2 IS NOT NULL
               AND split_start2 <= $5::TIME AND split_end2 >= $6::TIME)
         )`,
      [effectiveCompanyId, targetUserId, nTargetDate, shiftId, nTargetEnd, nTargetStart],
    );

    let overlapSplit = null;
    if (targetIsSplit && targetSplitStart && targetSplitEnd) {
      overlapSplit = await queryOne<{ id: number }>(
        `SELECT id FROM shifts
         WHERE company_id = $1
           AND user_id = $2
           AND date = $3
           AND status != 'cancelled'
           AND id != $4
           AND (
             (start_time <= $5::TIME AND end_time   >= $6::TIME)
             OR (is_split AND split_start2 IS NOT NULL AND split_end2 IS NOT NULL
                 AND split_start2 <= $5::TIME AND split_end2 >= $6::TIME)
           )`,
        [effectiveCompanyId, targetUserId, nTargetDate, shiftId, nTargetSplitEnd, nTargetSplitStart],
      );
    }

    if (overlapMain || overlapSplit) {
      conflict(res, 'Turno sovrapposto per questo dipendente in questa data', 'OVERLAP_CONFLICT');
      return;
    }

    // Same leave warning as creation: moving a shift onto a leave day is the
    // other way this conflict gets introduced.
    if (body.confirm_leave_conflict !== true) {
      const leaveConflict = await findLeaveConflict(effectiveCompanyId, targetUserId, nTargetDate);
      if (leaveConflict) {
        conflict(
          res,
          'Il dipendente ha un permesso approvato in questa data',
          'LEAVE_CONFLICT',
          {
            leave: leaveConflict,
            hint: 'Conferma per spostare comunque il turno, oppure annulla il permesso.',
          },
        );
        return;
      }
    }
  }

  // Validate cross-field constraints on merged (existing + patched) values
  const mergedForValidation = {
    start_time: nTargetStart,
    end_time: nTargetEnd,
    break_start: targetBreakStart ? nTargetBreakStart : null,
    break_end: targetBreakEnd ? nTargetBreakEnd : null,
    break_type: targetBreakType,
    break_minutes: targetBreakMinutes,
    is_split: targetIsSplit,
    split_start2: targetSplitStart ? nTargetSplitStart : null,
    split_end2: targetSplitEnd ? nTargetSplitEnd : null,
  };
  const crossErrs = validateShiftCrossFields(mergedForValidation);
  if (crossErrs.length > 0) {
    badRequest(res, crossErrs[0], 'VALIDATION_ERROR');
    return;
  }

  const updatedShift = await queryOne<{ id: number }>(
    `UPDATE shifts SET
       store_id      = $1,
       user_id       = $2,
       date          = $3,
       timezone      = $4::TEXT,
       start_time    = $5::TIME,
       end_time      = $6::TIME,
       start_at_utc  = (($3::DATE + $5::TIME) AT TIME ZONE $4::TEXT),
       end_at_utc    = (($3::DATE + (CASE WHEN $6::TIME < $5::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $6::TIME) AT TIME ZONE $4::TEXT),
       break_start   = $7,
       break_end     = $8,
       break_start_at_utc = CASE WHEN $7::TIME IS NULL THEN NULL ELSE (($3::DATE + (CASE WHEN $7::TIME < $5::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $7::TIME) AT TIME ZONE $4::TEXT) END,
       break_end_at_utc   = CASE WHEN $8::TIME IS NULL THEN NULL ELSE (($3::DATE + (CASE WHEN $8::TIME < $5::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $8::TIME) AT TIME ZONE $4::TEXT) END,
       break_type    = $9,
       break_minutes = $10,
       is_split      = $11,
       split_start2  = $12,
       split_end2    = $13,
       split_start2_at_utc = CASE WHEN $12::TIME IS NULL THEN NULL ELSE (($3::DATE + (CASE WHEN $12::TIME < $5::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $12::TIME) AT TIME ZONE $4::TEXT) END,
       split_end2_at_utc   = CASE WHEN $13::TIME IS NULL THEN NULL ELSE (($3::DATE + (CASE WHEN $13::TIME < $5::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $13::TIME) AT TIME ZONE $4::TEXT) END,
       notes         = $14,
       assignment_id = $15,
       is_off_day    = $16,
       status        = $17,
       updated_at    = NOW()
     WHERE id = $18 AND company_id = $19
     RETURNING id`,
    [
      targetStoreId,
      targetUserId,
      nTargetDate,
      targetShiftTimezone,
      nTargetStart,
      nTargetEnd,
      targetBreakStart ? nTargetBreakStart : null,
      targetBreakEnd ? nTargetBreakEnd : null,
      targetBreakType,
      targetBreakMinutes,
      targetIsSplit,
      targetSplitStart ? nTargetSplitStart : null,
      targetSplitEnd ? nTargetSplitEnd : null,
      targetNotes,
      assignmentResolution.assignmentId,
      targetIsOffDay,
      targetStatus,
      shiftId,
      effectiveCompanyId,
    ],
  );

  if (!updatedShift) { notFound(res, 'Turno non trovato'); return; }

  const shift = await getShiftById(updatedShift.id, effectiveCompanyId);
  if (!shift) {
    badRequest(res, 'Impossibile recuperare il turno aggiornato', 'SHIFT_UPDATE_FAILED');
    return;
  }

  const updatedLocaleRow = await queryOne<{ locale: string | null }>(
    `SELECT locale FROM users WHERE id = $1 LIMIT 1`,
    [targetUserId],
  );
  const updatedLocale = updatedLocaleRow?.locale ?? 'it';

  void sendNotification({
    companyId: effectiveCompanyId,
    userId: targetUserId,
    type: 'shift.changed',
    title: t(updatedLocale, 'notifications.shift_changed.title'),
    message: t(updatedLocale, 'notifications.shift_changed.message', {
      date: String(shift.date ?? nTargetDate),
      start: String(shift.start_time ?? '').slice(0, 5),
      end: String(shift.end_time ?? '').slice(0, 5),
      store: String(shift.store_name ?? ''),
    }),
    priority: 'medium',
    locale: updatedLocale,
  }).catch(() => undefined);

  ok(res, shift, 'Turno aggiornato');
});

// ---------------------------------------------------------------------------
// DELETE /api/shifts/:id — hard delete
// ---------------------------------------------------------------------------
export const deleteShift = asyncHandler(async (req: Request, res: Response) => {
  const { role, storeId: callerStoreId } = req.user!;
  const shiftId = parseInt(req.params.id, 10);
  if (isNaN(shiftId)) { notFound(res, 'Turno non trovato'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  const existing = await queryOne<{ id: number; company_id: number; store_id: number }>(
    `SELECT id, company_id, store_id FROM shifts WHERE id = $1 AND company_id = ANY($2)`,
    [shiftId, allowedCompanyIds],
  );
  if (!existing) { notFound(res, 'Turno non trovato'); return; }

  if (role === 'store_manager' && existing.store_id !== callerStoreId) {
    forbidden(res, 'Accesso negato'); return;
  }

  if (role === 'area_manager') {
    const canManage = await queryOne<{ id: number }>(
      `SELECT id
       FROM users
       WHERE role = 'store_manager'
         AND supervisor_id = $1
         AND company_id = $2
         AND store_id = $3
         AND status = 'active'
       LIMIT 1`,
      [req.user!.userId, existing.company_id, existing.store_id],
    );
    if (!canManage) {
      forbidden(res, 'Accesso negato'); return;
    }
  }

  // Ensure legacy FK setups do not block physical deletion.
  await query(
    `UPDATE attendance_events
     SET shift_id = NULL
     WHERE shift_id = $1`,
    [shiftId],
  );

  const deleted = await queryOne<{ id: number }>(
    `DELETE FROM shifts
     WHERE id = $1 AND company_id = $2
     RETURNING id`,
    [shiftId, existing.company_id],
  );

  if (!deleted) {
    notFound(res, 'Turno non trovato');
    return;
  }

  ok(res, { id: deleted.id }, 'Turno eliminato');
});

// ---------------------------------------------------------------------------
// POST /api/shifts/approve-week
// Confirms all scheduled shifts for one employee in an ISO week (HR / Admin / Area Manager).
// Optional store_id limits to shifts in that store (matches calendar filter).
// ---------------------------------------------------------------------------
export const approveWeekForEmployee = asyncHandler(async (req: Request, res: Response) => {
  const { role, userId: callerId } = req.user!;
  if (role === 'store_manager') {
    forbidden(res, 'Accesso negato');
    return;
  }

  const body = req.body as { user_id?: number; week?: string; store_id?: number | null };
  const targetUserId = typeof body.user_id === 'number' ? body.user_id : parseInt(String(body.user_id), 10);
  const weekRaw = body.week ?? '';
  const optionalStoreId = body.store_id != null && !Number.isNaN(Number(body.store_id))
    ? Number(body.store_id)
    : null;

  if (!targetUserId || isNaN(targetUserId)) {
    badRequest(res, 'user_id non valido', 'VALIDATION_ERROR');
    return;
  }
  const match = weekRaw.match(/^(\d{4})-W(\d{1,2})$/);
  if (!match) {
    badRequest(res, 'week non valida (YYYY-WNN)', 'VALIDATION_ERROR');
    return;
  }
  const weekNum = parseInt(match[2], 10);
  if (weekNum < 1 || weekNum > 53) {
    badRequest(res, 'Settimana non valida', 'VALIDATION_ERROR');
    return;
  }
  const weekParam = `${match[1]}-${match[2].padStart(2, '0')}`;

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const targetUser = await queryOne<{ id: number; company_id: number }>(
    `SELECT id, company_id FROM users WHERE id = $1 AND status = 'active' AND company_id = ANY($2)`,
    [targetUserId, allowedCompanyIds],
  );
  if (!targetUser) {
    notFound(res, 'Dipendente non trovato');
    return;
  }
  const companyId = targetUser.company_id;

  const params: any[] = [companyId, targetUserId, weekParam];
  let extraWhere = '';

  if (role === 'area_manager') {
    const managed = await query<{ store_id: number }>(
      `SELECT DISTINCT store_id FROM users
       WHERE role = 'store_manager' AND supervisor_id = $1 AND company_id = $2
         AND status = 'active' AND store_id IS NOT NULL`,
      [callerId, companyId],
    );
    const ids = managed.map((r) => r.store_id);
    if (ids.length === 0) {
      ok(res, { updated: 0 });
      return;
    }
    if (optionalStoreId != null && !Number.isNaN(optionalStoreId)) {
      if (!ids.includes(optionalStoreId)) {
        forbidden(res, 'Accesso negato');
        return;
      }
      extraWhere = ' AND store_id = $4';
      params.push(optionalStoreId);
    } else {
      const ph = ids.map((_, i) => `$${4 + i}`).join(', ');
      extraWhere = ` AND store_id IN (${ph})`;
      params.push(...ids);
    }
  } else {
    if (optionalStoreId != null && !Number.isNaN(optionalStoreId)) {
      extraWhere = ' AND store_id = $4';
      params.push(optionalStoreId);
    }
  }

  const result = await query<{ id: number }>(
    `UPDATE shifts s
     SET status = 'confirmed', updated_at = NOW()
     WHERE s.company_id = $1
       AND s.user_id = $2
       AND s.status = 'scheduled'
       AND COALESCE(s.is_off_day, false) = false
       AND s.date >= DATE_TRUNC('week', TO_DATE($3, 'IYYY-IW'))
       AND s.date <  DATE_TRUNC('week', TO_DATE($3, 'IYYY-IW')) + INTERVAL '7 days'
       ${extraWhere}
     RETURNING s.id`,
    params,
  );

  ok(res, { updated: result.length });
});

// ---------------------------------------------------------------------------
// POST /api/shifts/copy-week
// body: { store_id, source_week: 'YYYY-WNN', target_week: 'YYYY-WNN' }
// ---------------------------------------------------------------------------
export const copyWeek = asyncHandler(async (req: Request, res: Response) => {
  const { userId: callerId, role, storeId: callerStoreId } = req.user!;
  const { store_id, source_week, target_week } = req.body as Record<string, any>;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  // store_manager can only copy their own store
  if (role === 'store_manager' && store_id !== callerStoreId) {
    forbidden(res, 'Puoi operare solo sul tuo negozio'); return;
  }
  // area_manager can only copy stores they supervise (within allowed companies)
  if (role === 'area_manager') {
    const managedStores = await query<{ store_id: number }>(
      `SELECT DISTINCT store_id FROM users
       WHERE role = 'store_manager' AND supervisor_id = $1
         AND company_id = ANY($2)
         AND status = 'active' AND store_id IS NOT NULL`,
      [callerId, allowedCompanyIds],
    );
    if (!managedStores.some((r) => r.store_id === store_id)) {
      forbidden(res, 'Accesso negato'); return;
    }
  }

  // Fetch all non-cancelled shifts from source week
  const sourceShifts = await query<Record<string, any>>(
    `SELECT s.*
     FROM shifts s
     WHERE s.company_id = ANY($1)
       AND s.store_id = $2
       AND s.status != 'cancelled'
       AND s.date >= DATE_TRUNC('week', TO_DATE($3, 'IYYY-IW'))
       AND s.date <  DATE_TRUNC('week', TO_DATE($3, 'IYYY-IW')) + INTERVAL '7 days'`,
    [allowedCompanyIds, store_id, parseIsoWeek(source_week)],
  );

  if (sourceShifts.length === 0) {
    ok(res, { copied: 0, skipped_off_day: 0, shifts: [] }, 'Nessun turno da copiare');
    return;
  }

  // Determine source and target week Monday dates
  const sourceMondayRow = await queryOne<{ source_monday: string }>(
    `SELECT DATE_TRUNC('week', TO_DATE($1, 'IYYY-IW'))::DATE AS source_monday`,
    [parseIsoWeek(source_week)],
  );
  const targetMondayRow = await queryOne<{ target_monday: string }>(
    `SELECT DATE_TRUNC('week', TO_DATE($1, 'IYYY-IW'))::DATE AS target_monday`,
    [parseIsoWeek(target_week)],
  );

  const source_monday = sourceMondayRow!.source_monday;
  const target_monday = targetMondayRow!.target_monday;
  // Copy-week never crosses stores — the same store_id filters the source and is
  // written to the copies — so this is resolved once for the whole batch. Taking
  // it from the source shift instead would clone a bad zone into the new week and
  // lock the same employees out all over again.
  // Scoped by the company that actually owns these shifts, not allowedCompanyIds[0],
  // which is the wrong entry for a caller who spans more than one company.
  const copyTargetTimezone = await resolveStoreTimezone(store_id, sourceShifts[0].company_id, query);
  const sourceMondayDate = new Date(`${source_monday}T12:00:00`);
  const targetMondayDate = new Date(`${target_monday}T12:00:00`);
  let skippedOffDay = 0;
  let skippedLeave = 0;

  const insertedShifts: Record<string, any>[] = [];
  for (const s of sourceShifts) {
    const sourceDate = parseDateOnly(s.date);
    if (!sourceDate) {
      skippedOffDay += 1;
      continue;
    }

    const sourceDateObj = new Date(`${sourceDate}T12:00:00`);
    const dayOffset = Math.round((sourceDateObj.getTime() - sourceMondayDate.getTime()) / 86400000);
    const targetDateObj = new Date(targetMondayDate);
    targetDateObj.setDate(targetDateObj.getDate() + dayOffset);
    const targetDate = parseDateOnly(targetDateObj);

    if (!targetDate) {
      skippedOffDay += 1;
      continue;
    }

    const hasDateOffDay = await hasExplicitOffDayShift({
      companyId: s.company_id,
      userId: s.user_id,
      date: targetDate,
    });
    if (hasDateOffDay) {
      skippedOffDay += 1;
      continue;
    }

    const copiedTimezone = copyTargetTimezone;
    const overlapMain = await queryOne<{ id: number }>(
      `SELECT id FROM shifts
       WHERE company_id = $1
         AND user_id = $2
         AND date = $3
         AND status != 'cancelled'
         AND (
           (start_time <= $4::TIME AND end_time >= $5::TIME)
           OR (is_split AND split_start2 IS NOT NULL AND split_end2 IS NOT NULL
               AND split_start2 <= $4::TIME AND split_end2 >= $5::TIME)
         )`,
      [s.company_id, s.user_id, targetDate, s.end_time, s.start_time],
    );

    let overlapSplit = null;
    if (s.is_split && s.split_start2 && s.split_end2) {
      overlapSplit = await queryOne<{ id: number }>(
        `SELECT id FROM shifts
         WHERE company_id = $1
           AND user_id = $2
           AND date = $3
           AND status != 'cancelled'
           AND (
             (start_time <= $4::TIME AND end_time >= $5::TIME)
             OR (is_split AND split_start2 IS NOT NULL AND split_end2 IS NOT NULL
                 AND split_start2 <= $4::TIME AND split_end2 >= $5::TIME)
           )`,
        [s.company_id, s.user_id, targetDate, s.split_end2, s.split_start2],
      );
    }

    if (overlapMain || overlapSplit) {
      continue;
    }

    // A bulk copy has no operator sitting in front of it to answer a warning,
    // so leave days are skipped and reported back rather than silently booked.
    if (await findLeaveConflict(s.company_id, s.user_id, targetDate)) {
      skippedLeave++;
      continue;
    }

    try {
      const createdShift = await queryOne<Record<string, any>>(
        `INSERT INTO shifts (
           company_id, store_id, user_id, date, timezone, start_time, end_time,
           start_at_utc, end_at_utc,
           break_start, break_end, break_start_at_utc, break_end_at_utc,
           break_type, break_minutes,
           is_split, split_start2, split_end2, split_start2_at_utc, split_end2_at_utc,
           notes, status, created_by
         ) VALUES (
           $1, $2, $3, $4, $5::TEXT, $6, $7,
           (($4::DATE + $6::TIME) AT TIME ZONE $5::TEXT),
           (($4::DATE + (CASE WHEN $7::TIME < $6::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $7::TIME) AT TIME ZONE $5::TEXT),
           $8, $9,
           CASE WHEN $8::TIME IS NULL THEN NULL ELSE (($4::DATE + (CASE WHEN $8::TIME < $6::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $8::TIME) AT TIME ZONE $5::TEXT) END,
           CASE WHEN $9::TIME IS NULL THEN NULL ELSE (($4::DATE + (CASE WHEN $9::TIME < $6::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $9::TIME) AT TIME ZONE $5::TEXT) END,
           $10, $11,
           $12, $13, $14,
           CASE WHEN $13::TIME IS NULL THEN NULL ELSE (($4::DATE + (CASE WHEN $13::TIME < $6::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $13::TIME) AT TIME ZONE $5::TEXT) END,
           CASE WHEN $14::TIME IS NULL THEN NULL ELSE (($4::DATE + (CASE WHEN $14::TIME < $6::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END) + $14::TIME) AT TIME ZONE $5::TEXT) END,
           $15, 'scheduled', $16
         )
         RETURNING *`,
        [
          s.company_id,
          store_id,
          s.user_id,
          targetDate,
          copiedTimezone,
          s.start_time,
          s.end_time,
          s.break_start ?? null,
          s.break_end ?? null,
          s.break_type ?? 'fixed',
          s.break_minutes ?? null,
          s.is_split ?? false,
          s.split_start2 ?? null,
          s.split_end2 ?? null,
          s.notes ?? null,
          callerId,
        ],
      );

      if (createdShift) {
        insertedShifts.push(createdShift);
      }
    } catch (error) {
      console.error('[copyWeek] skipped shift during copy', {
        sourceShiftId: s.id,
        userId: s.user_id,
        sourceDate,
        targetDate,
        error,
      });
    }
  }

  ok(
    res,
    {
      copied: insertedShifts.length,
      skipped_off_day: skippedOffDay,
      skipped_leave: skippedLeave,
      shifts: insertedShifts,
    },
    skippedLeave > 0
      ? `Settimana copiata. ${skippedLeave} turno/i non copiati: permesso approvato in quelle date.`
      : 'Settimana copiata',
  );
});

// ---------------------------------------------------------------------------
// GET /api/shifts/templates
// ---------------------------------------------------------------------------
export const listTemplates = asyncHandler(async (req: Request, res: Response) => {
  const { role, storeId: callerStoreId } = req.user!;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const { store_id } = req.query as Record<string, string>;

  let extraWhere = '';
  const params: any[] = [allowedCompanyIds];
  let idx = 2;

  if (role === 'store_manager') {
    extraWhere += ` AND stpl.store_id = $${idx}`;
    params.push(callerStoreId);
    idx++;
  }

  if (store_id) {
    const requestedStoreId = parseInt(store_id, 10);
    if (Number.isNaN(requestedStoreId)) {
      badRequest(res, 'store_id non valido', 'VALIDATION_ERROR');
      return;
    }

    if (role === 'store_manager' && requestedStoreId !== callerStoreId) {
      forbidden(res, 'Accesso negato');
      return;
    }

    extraWhere += ` AND stpl.store_id = $${idx}`;
    params.push(requestedStoreId);
  }

  const templates = await query(
    `SELECT stpl.*, st.name AS store_name, c.name AS company_name
     FROM shift_templates stpl
     LEFT JOIN stores st ON st.id = stpl.store_id
     LEFT JOIN companies c ON c.id = stpl.company_id
     WHERE stpl.company_id = ANY($1)${extraWhere}
     ORDER BY stpl.name`,
    params,
  );
  ok(res, { templates });
});

// ---------------------------------------------------------------------------
// POST /api/shifts/templates
// ---------------------------------------------------------------------------
export const createTemplate = asyncHandler(async (req: Request, res: Response) => {
  const { userId: callerId, role, storeId: callerStoreId } = req.user!;
  const { store_id, name, template_data } = req.body as Record<string, any>;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  // Resolve effective company from the provided store (must be in allowed scope)
  const store = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM stores WHERE id = $1 AND company_id = ANY($2) AND is_active = true`,
    [store_id, allowedCompanyIds],
  );
  if (!store) { notFound(res, 'Negozio non trovato'); return; }
  const effectiveCompanyId = store.company_id;

  if (role === 'store_manager' && store_id !== callerStoreId) {
    forbidden(res, 'Puoi creare template solo per il tuo negozio'); return;
  }

  const template = await queryOne(
    `INSERT INTO shift_templates (company_id, store_id, name, template_data, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [effectiveCompanyId, store_id, name, JSON.stringify(template_data), callerId],
  );
  created(res, template, 'Template salvato');
});

// ---------------------------------------------------------------------------
// PUT /api/shifts/templates/:id
// ---------------------------------------------------------------------------
export const updateTemplate = asyncHandler(async (req: Request, res: Response) => {
  const { role, storeId: callerStoreId } = req.user!;
  const templateId = parseInt(req.params.id, 10);
  if (isNaN(templateId)) { notFound(res, 'Template non trovato'); return; }

  const { store_id, name, template_data } = req.body as Record<string, any>;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  const existing = await queryOne<{ id: number; store_id: number; company_id: number }>(
    `SELECT id, store_id, company_id
     FROM shift_templates
     WHERE id = $1
       AND company_id = ANY($2)`,
    [templateId, allowedCompanyIds],
  );
  if (!existing) { notFound(res, 'Template non trovato'); return; }

  if (role === 'store_manager' && existing.store_id !== callerStoreId) {
    forbidden(res, 'Puoi modificare template solo per il tuo negozio');
    return;
  }

  const targetStore = await queryOne<{ company_id: number }>(
    `SELECT company_id
     FROM stores
     WHERE id = $1
       AND company_id = ANY($2)
       AND is_active = true`,
    [store_id, allowedCompanyIds],
  );
  if (!targetStore) { notFound(res, 'Negozio non trovato'); return; }

  if (role === 'store_manager' && store_id !== callerStoreId) {
    forbidden(res, 'Puoi modificare template solo per il tuo negozio');
    return;
  }

  const updated = await queryOne(
    `UPDATE shift_templates
     SET store_id = $1,
         name = $2,
         template_data = $3
     WHERE id = $4
       AND company_id = ANY($5)
     RETURNING *`,
    [store_id, name, JSON.stringify(template_data), templateId, allowedCompanyIds],
  );

  if (!updated) { notFound(res, 'Template non trovato'); return; }
  ok(res, updated, 'Template aggiornato');
});

// ---------------------------------------------------------------------------
// DELETE /api/shifts/templates/:id
// H2 fix: store_manager may only delete templates belonging to their own store
// ---------------------------------------------------------------------------
export const deleteTemplate = asyncHandler(async (req: Request, res: Response) => {
  const { role, storeId: callerStoreId } = req.user!;
  const templateId = parseInt(req.params.id, 10);
  if (isNaN(templateId)) { notFound(res, 'Template non trovato'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  let template: { id: number } | null;
  if (role === 'store_manager') {
    // Scope deletion to the caller's store to prevent cross-store deletes
    template = await queryOne(
      `DELETE FROM shift_templates WHERE id = $1 AND company_id = ANY($2) AND store_id = $3 RETURNING id`,
      [templateId, allowedCompanyIds, callerStoreId],
    );
  } else {
    // admin / hr may delete any template in the company
    template = await queryOne(
      `DELETE FROM shift_templates WHERE id = $1 AND company_id = ANY($2) RETURNING id`,
      [templateId, allowedCompanyIds],
    );
  }
  if (!template) { notFound(res, 'Template non trovato'); return; }
  ok(res, template, 'Template eliminato');
});

// ---------------------------------------------------------------------------
// GET /api/shifts/export  ?store_id&week  → CSV download
// ---------------------------------------------------------------------------
export const exportShifts = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const { store_id, week } = req.query as Record<string, string>;

  const params: any[] = [allowedCompanyIds];
  let extraWhere = '';
  let idx = 2;

  if (store_id) {
    extraWhere += ` AND s.store_id = $${idx}`;
    params.push(parseInt(store_id, 10));
    idx++;
  }

  if (week) {
    extraWhere += ` AND s.date >= DATE_TRUNC('week', TO_DATE($${idx}, 'IYYY-IW'))`;
    params.push(parseIsoWeek(week));
    idx++;
    extraWhere += ` AND s.date < DATE_TRUNC('week', TO_DATE($${idx - 1}, 'IYYY-IW')) + INTERVAL '7 days'`;
  }

  // M15: hard cap of 10,000 rows to prevent memory exhaustion
  const EXPORT_ROW_CAP = 10_000;
  const shifts = await query<Record<string, any>>(
    `SELECT TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
            s.start_time, s.end_time, s.break_start, s.break_end,
            s.is_split, s.split_start2, s.split_end2,
            s.status, s.notes, s.is_off_day, s.user_id,
            u.name AS user_name, u.surname AS user_surname, u.unique_id,
            st.name AS store_name, st.code AS store_code,
            ${shiftHoursExpr()}
     FROM shifts s
     LEFT JOIN users u  ON u.id  = s.user_id
     LEFT JOIN stores st ON st.id = s.store_id
     WHERE s.company_id = ANY($1)${extraWhere}
     ORDER BY s.date, s.start_time
     LIMIT ${EXPORT_ROW_CAP + 1}`,
    params,
  );
  const truncated = shifts.length > EXPORT_ROW_CAP;
  if (truncated) shifts.splice(EXPORT_ROW_CAP);

  const format = (req.query.format as string) === 'pdf' ? 'pdf' : (req.query.format as string) === 'xlsx' ? 'xlsx' : 'csv';
  const filename = `turni-${week ?? 'export'}`;

  if (format === 'pdf' && week) {
    // -------------------------------------------------------------------------
    // PDF format: Weekly Calendar Grid layout (reflecting the UI exactly)
    // -------------------------------------------------------------------------
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

    // Get the 7 dates of the week
    const getMondayOfIsoWeek = (weekStr: string): Date => {
      const match = weekStr.match(/^(\d{4})-W(\d{2})$/);
      if (!match) return new Date();
      const year = parseInt(match[1], 10);
      const wk = parseInt(match[2], 10);
      const d = new Date(Date.UTC(year, 0, 4));
      const day = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
      d.setUTCDate(d.getUTCDate() + (wk - 1) * 7);
      return d;
    };

    const formatDateUTC = (d: Date): string => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dateVal = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${dateVal}`;
    };

    const dates: string[] = [];
    const startMonday = getMondayOfIsoWeek(week);
    for (let i = 0; i < 7; i++) {
      const cur = new Date(startMonday);
      cur.setUTCDate(startMonday.getUTCDate() + i);
      dates.push(formatDateUTC(cur));
    }

    // Query leave requests overlapping with this week
    const leaves = await query<Record<string, any>>(
      `SELECT lr.id, lr.user_id, lr.leave_type, lr.status,
              TO_CHAR(lr.start_date, 'YYYY-MM-DD') AS start_date,
              TO_CHAR(lr.end_date, 'YYYY-MM-DD') AS end_date,
              u.name AS user_name, u.surname AS user_surname, u.unique_id
       FROM leave_requests lr
       JOIN users u ON u.id = lr.user_id
       WHERE lr.company_id = ANY($1)
         AND lr.status != 'rejected'
         AND lr.start_date <= (DATE_TRUNC('week', TO_DATE($2, 'IYYY-IW'))::DATE + INTERVAL '6 days')::DATE
         AND lr.end_date >= DATE_TRUNC('week', TO_DATE($2, 'IYYY-IW'))::DATE`,
      [allowedCompanyIds, parseIsoWeek(week)],
    );

    // Query temporary store transfers overlapping with this week
    let transferStoreWhere = '';
    const transferParams: any[] = [allowedCompanyIds, parseIsoWeek(week)];
    if (store_id) {
      transferStoreWhere = ` AND (tsa.origin_store_id = $3 OR tsa.target_store_id = $3)`;
      transferParams.push(parseInt(store_id, 10));
    }
    const transfers = await query<Record<string, any>>(
      `SELECT tsa.id, tsa.user_id, tsa.status,
              TO_CHAR(tsa.start_date, 'YYYY-MM-DD') AS start_date,
              TO_CHAR(tsa.end_date, 'YYYY-MM-DD') AS end_date,
              s_from.name AS origin_store_name,
              s_to.name AS target_store_name,
              u.name AS user_name, u.surname AS user_surname, u.unique_id
       FROM temporary_store_assignments tsa
       JOIN users u ON u.id = tsa.user_id
       JOIN stores s_from ON s_from.id = tsa.origin_store_id
       JOIN stores s_to ON s_to.id = tsa.target_store_id
       WHERE tsa.company_id = ANY($1)
         AND tsa.status != 'cancelled'
         AND tsa.start_date <= (DATE_TRUNC('week', TO_DATE($2, 'IYYY-IW'))::DATE + INTERVAL '6 days')::DATE
         AND tsa.end_date >= DATE_TRUNC('week', TO_DATE($2, 'IYYY-IW'))::DATE${transferStoreWhere}`,
      transferParams,
    );

    // Grouping
    const userMap = new Map<number, {
      id: number;
      name: string;
      surname: string;
      unique_id: string;
      shifts: Map<string, any[]>;
      totalHours: number;
    }>();

    for (const s of shifts) {
      if (!s.user_id) continue;
      if (!userMap.has(s.user_id)) {
        userMap.set(s.user_id, {
          id: s.user_id,
          name: s.user_name,
          surname: s.user_surname,
          unique_id: s.unique_id || '',
          shifts: new Map(),
          totalHours: 0,
        });
      }
      const u = userMap.get(s.user_id)!;
      const list = u.shifts.get(s.date) || [];
      u.shifts.set(s.date, [...list, s]);
      if (s.status !== 'cancelled' && !s.is_off_day) {
        u.totalHours += parseFloat(s.shift_hours || 0);
      }
    }

    const userLeavesMap = new Map<number, any[]>();
    for (const lr of leaves) {
      if (!userMap.has(lr.user_id)) {
        userMap.set(lr.user_id, {
          id: lr.user_id,
          name: lr.user_name,
          surname: lr.user_surname,
          unique_id: lr.unique_id || '',
          shifts: new Map(),
          totalHours: 0,
        });
      }
      const list = userLeavesMap.get(lr.user_id) || [];
      userLeavesMap.set(lr.user_id, [...list, lr]);
    }

    const userTransfersMap = new Map<number, any[]>();
    for (const tr of transfers) {
      if (!userMap.has(tr.user_id)) {
        userMap.set(tr.user_id, {
          id: tr.user_id,
          name: tr.user_name,
          surname: tr.user_surname,
          unique_id: tr.unique_id || '',
          shifts: new Map(),
          totalHours: 0,
        });
      }
      const list = userTransfersMap.get(tr.user_id) || [];
      userTransfersMap.set(tr.user_id, [...list, tr]);
    }

    const sortedUsers = Array.from(userMap.values()).sort((a, b) => {
      const comp = a.surname.localeCompare(b.surname);
      if (comp !== 0) return comp;
      return a.name.localeCompare(b.name);
    });

    const isDateWithinRange = (dateStr: string, startStr: string, endStr: string): boolean => {
      return dateStr >= startStr && dateStr <= endStr;
    };

    const getCellLinesForUserDate = (u: any, dateStr: string): string[] => {
      const dayShifts = u.shifts.get(dateStr) || [];
      const activeShifts = dayShifts.filter((s: any) => s.status !== 'cancelled');

      if (activeShifts.length > 0) {
        const hasOff = activeShifts.some((s: any) => s.is_off_day);
        if (hasOff) {
          return ['Riposo'];
        }

        // Format shift times
        const s = activeShifts[0];
        const tStart = s.start_time ? s.start_time.slice(0, 5) : '';
        const tEnd = s.end_time ? s.end_time.slice(0, 5) : '';

        if (s.is_split) {
          const tStart2 = s.split_start2 ? s.split_start2.slice(0, 5) : '';
          const tEnd2 = s.split_end2 ? s.split_end2.slice(0, 5) : '';
          return [`${tStart}-${tEnd}`, `${tStart2}-${tEnd2}`];
        }

        if (s.break_start && s.break_end) {
          const bStart = s.break_start.slice(0, 5);
          const bEnd = s.break_end.slice(0, 5);
          return [`${tStart}-${tEnd}`, `P: ${bStart}-${bEnd}`];
        }

        return [`${tStart}-${tEnd}`];
      }

      // Check leaves
      const uLeaves = userLeavesMap.get(u.id) || [];
      const activeLeave = uLeaves.find((lr: any) => isDateWithinRange(dateStr, lr.start_date, lr.end_date));
      if (activeLeave) {
        const label = activeLeave.leave_type === 'vacation' ? 'Ferie' : 'Permesso';
        const statusText = activeLeave.status === 'pending' ? '(In attesa)' : '';
        return [label, statusText].filter(Boolean);
      }

      // Check transfers
      const uTransfers = userTransfersMap.get(u.id) || [];
      const activeTransfer = uTransfers.find((tr: any) => isDateWithinRange(dateStr, tr.start_date, tr.end_date));
      if (activeTransfer) {
        const label = 'Trasferito';
        const storeName = activeTransfer.target_store_name || '';
        const displayStore = storeName.length > 12 ? storeName.slice(0, 10) + '..' : storeName;
        return [label, displayStore];
      }

      return [];
    };

    const COL_WIDTHS = [110, 85, 85, 85, 85, 85, 85, 85, 55];
    const DAY_NAMES = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
    const HEADER_HEIGHT = 28;
    const ROW_HEIGHT = 30;

    let page = pdfDoc.addPage([841.89, 595.28]); // A4 Landscape
    const { width, height } = page.getSize();
    const startX = (width - 760) / 2;
    const colX = (colIdx: number) => startX + COL_WIDTHS.slice(0, colIdx).reduce((a, b) => a + b, 0);

    const formatDayDate = (dateStr: string): string => {
      const parts = dateStr.split('-');
      return `${parts[2]}/${parts[1]}`;
    };

    const drawHeaderCellOnPage = (p: any, line1: string, line2: string, x: number, w: number, curY: number) => {
      p.drawRectangle({
        x,
        y: curY - HEADER_HEIGHT,
        width: w,
        height: HEADER_HEIGHT,
        color: rgb(0.08, 0.18, 0.3),
        borderWidth: 0.5,
        borderColor: rgb(0.2, 0.2, 0.2),
      });

      p.drawText(line1, {
        x: x + 6,
        y: curY - 12,
        size: 8,
        font: fontBold,
        color: rgb(1, 1, 1),
      });

      if (line2) {
        p.drawText(line2, {
          x: x + 6,
          y: curY - 22,
          size: 7,
          font,
          color: rgb(0.9, 0.9, 0.9),
        });
      }
    };

    const drawPageHeaderAndTableHeaders = (p: any): number => {
      let curY = height - 40;

      // Header Band
      p.drawRectangle({ x: startX, y: curY - 60, width: 760, height: 60, color: rgb(0.05, 0.13, 0.22) });
      p.drawText('CALENDARIO SETTIMANALE TURNI', { x: startX + 20, y: curY - 25, size: 14, font: fontBold, color: rgb(1, 1, 1) });

      let storeSubtitle = '';
      if (shifts.length > 0 && store_id) {
        storeSubtitle = ` | Negozio: ${shifts[0].store_name}`;
      }
      p.drawText(`Settimana: ${week}${storeSubtitle} | Generato il: ${new Date().toLocaleString('it-IT')}`, { x: startX + 20, y: curY - 45, size: 9, font, color: rgb(0.9, 0.9, 0.9) });

      curY -= 80;

      // Table Headers
      drawHeaderCellOnPage(p, 'Dipendente', '', colX(0), COL_WIDTHS[0], curY);
      for (let i = 0; i < 7; i++) {
        drawHeaderCellOnPage(p, DAY_NAMES[i], formatDayDate(dates[i]), colX(i + 1), COL_WIDTHS[i + 1], curY);
      }
      drawHeaderCellOnPage(p, 'Tot. Ore', '', colX(8), COL_WIDTHS[8], curY);

      return curY - HEADER_HEIGHT;
    };

    let y = drawPageHeaderAndTableHeaders(page);

    const checkPageOverflow = (needed: number) => {
      if (y - needed < 40) {
        page = pdfDoc.addPage([841.89, 595.28]);
        y = drawPageHeaderAndTableHeaders(page);
      }
    };

    for (const user of sortedUsers) {
      checkPageOverflow(ROW_HEIGHT);

      // 1. Draw Cell Backgrounds and Borders
      page.drawRectangle({
        x: colX(0),
        y: y - ROW_HEIGHT,
        width: COL_WIDTHS[0],
        height: ROW_HEIGHT,
        color: rgb(0.96, 0.97, 0.98),
        borderWidth: 0.5,
        borderColor: rgb(0.85, 0.85, 0.85),
      });

      for (let i = 0; i < 7; i++) {
        page.drawRectangle({
          x: colX(i + 1),
          y: y - ROW_HEIGHT,
          width: COL_WIDTHS[i + 1],
          height: ROW_HEIGHT,
          color: rgb(1, 1, 1),
          borderWidth: 0.5,
          borderColor: rgb(0.85, 0.85, 0.85),
        });
      }

      page.drawRectangle({
        x: colX(8),
        y: y - ROW_HEIGHT,
        width: COL_WIDTHS[8],
        height: ROW_HEIGHT,
        color: rgb(0.94, 0.94, 0.94),
        borderWidth: 0.5,
        borderColor: rgb(0.85, 0.85, 0.85),
      });

      // 2. Draw Cell Texts
      const fullName = `${user.name} ${user.surname}`;
      const dispName = fullName.length > 20 ? fullName.slice(0, 18) + '..' : fullName;
      page.drawText(dispName, {
        x: colX(0) + 5,
        y: y - 12,
        size: 7.5,
        font: fontBold,
        color: rgb(0.1, 0.1, 0.1),
      });
      page.drawText(`ID: ${user.unique_id}`, {
        x: colX(0) + 5,
        y: y - 22,
        size: 6.5,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });

      for (let i = 0; i < 7; i++) {
        const dateStr = dates[i];
        const cellX = colX(i + 1);
        const lines = getCellLinesForUserDate(user, dateStr);

        if (lines.length > 0) {
          const line1 = lines[0];
          let color1 = rgb(0.1, 0.1, 0.1);
          let fontStyle1 = font;
          if (line1.includes('Riposo')) {
            color1 = rgb(0.5, 0.5, 0.5);
            fontStyle1 = fontItalic;
          } else if (line1.includes('Ferie') || line1.includes('Permesso')) {
            color1 = rgb(0.1, 0.4, 0.7);
            fontStyle1 = fontBold;
          } else if (line1.includes('Trasferito')) {
            color1 = rgb(0.1, 0.6, 0.3);
            fontStyle1 = fontBold;
          }

          page.drawText(line1, {
            x: cellX + 5,
            y: y - 12,
            size: 7.2,
            font: fontStyle1,
            color: color1,
          });

          if (lines[1]) {
            const line2 = lines[1];
            let color2 = rgb(0.4, 0.4, 0.4);
            if (line1.includes('Ferie') || line1.includes('Permesso')) {
              color2 = rgb(0.1, 0.4, 0.7);
            } else if (line1.includes('Trasferito')) {
              color2 = rgb(0.1, 0.6, 0.3);
            }

            page.drawText(line2, {
              x: cellX + 5,
              y: y - 22,
              size: 6.2,
              font,
              color: color2,
            });
          }
        }
      }

      page.drawText(String(user.totalHours.toFixed(1).replace('.0', '')), {
        x: colX(8) + 15,
        y: y - 18,
        size: 9,
        font: fontBold,
        color: rgb(0.1, 0.1, 0.1),
      });

      y -= ROW_HEIGHT;
    }

    if (truncated) {
      checkPageOverflow(20);
      page.drawText(`... Troncato a ${EXPORT_ROW_CAP} righe ...`, { x: startX, y: y - 15, size: 9, font: fontItalic, color: rgb(0.8, 0, 0) });
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } else if (format === 'pdf') {
    // Fallback PDF layout when week is not defined (simple list table format)
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

    let page = pdfDoc.addPage([841.89, 595.28]); // A4 Landscape
    const { width, height } = page.getSize();
    let y = height - 40;

    const checkPageOverflow = (needed: number) => {
      if (y - needed < 40) {
        page = pdfDoc.addPage([841.89, 595.28]);
        y = height - 40;
      }
    };

    page.drawRectangle({ x: 40, y: y - 60, width: width - 80, height: 60, color: rgb(0.05, 0.13, 0.22) });
    page.drawText('EXPORT TURNI (SHIFTS EXPORT)', { x: 60, y: y - 25, size: 14, font: fontBold, color: rgb(1, 1, 1) });
    page.drawText(`Generato il: ${new Date().toLocaleString('it-IT')}`, { x: 60, y: y - 45, size: 9, font, color: rgb(0.9, 0.9, 0.9) });
    y -= 80;

    const LIST_HEADERS = ['Data','Inizio','Fine','Pausa Inizio','Pausa Fine','Spezzato','Inizio2','Fine2','Ore','Nome','Cognome','ID','Negozio','Stato','Note'];
    const COL_WIDTHS = [70, 45, 45, 65, 65, 55, 45, 45, 35, 70, 70, 60, 80, 55, 100];
    const colX = (colIdx: number) => 40 + COL_WIDTHS.slice(0, colIdx).reduce((a, b) => a + b, 0);

    LIST_HEADERS.forEach((h, i) => {
      page.drawText(h, { x: colX(i), y, size: 8, font: fontBold });
    });
    page.drawLine({ start: { x: 40, y: y - 4 }, end: { x: width - 40, y: y - 4 }, thickness: 1, color: rgb(0.2, 0.2, 0.2) });
    y -= 18;

    for (const s of shifts) {
      checkPageOverflow(15);
      const row = [
        s.date, s.start_time, s.end_time,
        s.break_start ?? '', s.break_end ?? '',
        s.is_split ? 'SI' : 'NO',
        s.split_start2 ?? '', s.split_end2 ?? '',
        s.shift_hours,
        s.user_name, s.user_surname, s.unique_id ?? '',
        s.store_name, s.status, s.notes ?? '',
      ];
      row.forEach((val, i) => {
        const str = String(val);
        const limit = i === 14 ? 20 : i === 12 ? 15 : 12;
        const display = str.length > limit ? str.substring(0, limit - 2) + '..' : str;
        page.drawText(display, { x: colX(i), y, size: 7.5, font });
      });
      y -= 14;
    }

    if (truncated) {
      checkPageOverflow(20);
      page.drawText(`... Troncato a ${EXPORT_ROW_CAP} righe ...`, { x: 40, y, size: 9, font: fontItalic, color: rgb(0.8, 0, 0) });
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } else {
    // -------------------------------------------------------------------------
    // Excel/CSV formats: Align exactly with the import template format
    // -------------------------------------------------------------------------
    const EXPORT_HEADERS = ['data', 'unique_id', 'store_code', 'inizio', 'fine', 'pausa_inizio', 'pausa_fine', 'spezzato', 'inizio2', 'fine2', 'stato', 'note'];
    const rowData = shifts.map((s) => [
      s.date,
      s.unique_id ?? '',
      s.store_code ?? '',
      s.start_time ? s.start_time.slice(0, 5) : '',
      s.end_time ? s.end_time.slice(0, 5) : '',
      s.break_start ? s.break_start.slice(0, 5) : '',
      s.break_end ? s.break_end.slice(0, 5) : '',
      s.is_split ? 'SI' : 'NO',
      s.split_start2 ? s.split_start2.slice(0, 5) : '',
      s.split_end2 ? s.split_end2.slice(0, 5) : '',
      s.status,
      s.notes ?? '',
    ]);

    if (format === 'xlsx') {
      const ws = XLSX.utils.aoa_to_sheet([EXPORT_HEADERS, ...rowData]);
      ws['!cols'] = EXPORT_HEADERS.map((h) => ({ wch: Math.max(h.length + 2, 14) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Turni');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      if (truncated) res.setHeader('X-Export-Truncated', 'true');
      res.send(buf);
    } else {
      const csvQ = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csvRows = rowData.map((r) => r.map(csvQ).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      if (truncated) res.setHeader('X-Export-Truncated', 'true');
      res.send(EXPORT_HEADERS.map(csvQ).join(',') + '\n' + csvRows.join('\n'));
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/shifts/import-template  → download Excel template with reference sheets
// ---------------------------------------------------------------------------
export const importTemplate = asyncHandler(async (req: Request, res: Response) => {
  const { companyId } = req.user!;

  const employees = await query<{ id: number; name: string; surname: string; unique_id: string }>(
    `SELECT id, name, surname, unique_id FROM users
     WHERE company_id = $1 AND status = 'active' ORDER BY surname, name`,
    [companyId],
  );
  const stores = await query<{ id: number; name: string; code: string }>(
    `SELECT id, name, code FROM stores
     WHERE company_id = $1 AND is_active = true ORDER BY name`,
    [companyId],
  );

  const sampleUniqueId = employees[0]?.unique_id ?? 'EMP-XXXXX';
  const sampleStoreCode = stores[0]?.code ?? 'ROM-01';

  const HEADERS = ['data','unique_id','store_code','inizio','fine','pausa_inizio','pausa_fine','spezzato','inizio2','fine2','stato','note'];
  const SAMPLE  = ['2026-03-25', sampleUniqueId, sampleStoreCode, '09:00', '18:00', '13:00', '14:00', 'NO', '', '', 'scheduled', ''];

  const wb = XLSX.utils.book_new();

  // Sheet 1 — Turni (import data)
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, SAMPLE]);
  ws['!cols'] = HEADERS.map(() => ({ wch: 14 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Turni');

  // Sheet 2 — Dipendenti reference
  const empHeaders = ['unique_id', 'nome', 'cognome'];
  const empRows = employees.map((e) => [e.unique_id ?? '', e.name, e.surname]);
  const wsEmp = XLSX.utils.aoa_to_sheet([empHeaders, ...empRows]);
  wsEmp['!cols'] = empHeaders.map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, wsEmp, 'Dipendenti');

  // Sheet 3 — Negozi reference
  const storeHeaders = ['store_code', 'nome_negozio'];
  const storeRows = stores.map((s) => [s.code, s.name]);
  const wsStore = XLSX.utils.aoa_to_sheet([storeHeaders, ...storeRows]);
  wsStore['!cols'] = storeHeaders.map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, wsStore, 'Negozi');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="turni-template.xlsx"');
  res.send(buf);
});

// ---------------------------------------------------------------------------
// POST /api/shifts/import  — multipart: file (xlsx or csv)
// ---------------------------------------------------------------------------
export const importShifts = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, userId: callerId, role, storeId: callerStoreId } = req.user!;
  const file = (req as any).file as Express.Multer.File | undefined;
  // The multipart `timezone` field is still accepted and ignored: each row now
  // takes the zone of the store its store_code resolves to.

  if (!file) {
    badRequest(res, 'Nessun file fornito', 'VALIDATION_ERROR');
    return;
  }

  if (companyId == null) {
    forbidden(res, 'Accesso negato');
    return;
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
  } catch {
    badRequest(res, 'Impossibile leggere il file. Usa .xlsx o .csv', 'VALIDATION_ERROR');
    return;
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });

  if (rows.length === 0) {
    badRequest(res, 'Il file è vuoto', 'VALIDATION_ERROR');
    return;
  }

  let imported = 0, skipped = 0, failed = 0;
  const errors: string[] = [];
  // M5: accumulate validated rows for a single batched INSERT
  const validRows: any[][] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    try {
      const dateVal     = parseDateCell(getField(row, 'data', 'date', 'Data'));
      const uniqueIdVal = String(getField(row, 'unique_id', 'uniqueid', 'UniqueID', 'codice_dipendente')).trim();
      const storeCodeVal = String(getField(row, 'store_code', 'storecode', 'StoreCode', 'codice_negozio')).trim();
      const startTime   = parseTimeCell(getField(row, 'inizio', 'start_time', 'Inizio'));
      const endTime     = parseTimeCell(getField(row, 'fine', 'end_time', 'Fine'));
      const breakStart  = parseTimeCell(getField(row, 'pausa_inizio', 'break_start', 'Pausa Inizio'));
      const breakEnd    = parseTimeCell(getField(row, 'pausa_fine', 'break_end', 'Pausa Fine'));
      const isSplitRaw  = String(getField(row, 'spezzato', 'is_split', 'Spezzato')).trim().toLowerCase();
      const isSplit     = ['si', 'yes', 'true', '1'].includes(isSplitRaw);
      const splitStart2 = parseTimeCell(getField(row, 'inizio2', 'split_start2', 'Inizio2'));
      const splitEnd2   = parseTimeCell(getField(row, 'fine2', 'split_end2', 'Fine2'));
      const statusRaw   = String(getField(row, 'stato', 'status', 'Stato')).trim().toLowerCase();
      let status        = ['scheduled','confirmed','cancelled'].includes(statusRaw) ? statusRaw : 'scheduled';
      if (role === 'store_manager' && status === 'confirmed') {
        status = 'scheduled';
      }
      const notes       = String(getField(row, 'note', 'notes', 'Note')).trim() || null;

      if (!dateVal) {
        errors.push(`Riga ${rowNum}: data non valida`); failed++; continue;
      }
      if (!uniqueIdVal) {
        errors.push(`Riga ${rowNum}: unique_id dipendente obbligatorio`); failed++; continue;
      }
      if (!storeCodeVal) {
        errors.push(`Riga ${rowNum}: store_code negozio obbligatorio`); failed++; continue;
      }
      if (!startTime || !endTime) {
        errors.push(`Riga ${rowNum}: orari obbligatori mancanti`); failed++; continue;
      }

      // M3: run the same cross-field validation used by the HTTP create endpoint
      const breakTypeRaw = String(getField(row, 'break_type', 'tipo_pausa')).trim().toLowerCase();
      const breakType = ['fixed', 'flexible'].includes(breakTypeRaw) ? breakTypeRaw : 'fixed';
      const breakMinsRaw = getField(row, 'break_minutes', 'minuti_pausa');
      const breakMins = breakMinsRaw !== '' && breakMinsRaw != null ? parseInt(String(breakMinsRaw), 10) : null;
      const normalizedBreakMins = Number.isNaN(breakMins as number) ? null : breakMins;
      const crossErrors = validateShiftCrossFields({
        start_time: startTime,
        end_time: endTime,
        break_start: breakStart ?? null,
        break_end: breakEnd ?? null,
        break_type: breakType,
        break_minutes: normalizedBreakMins,
        is_split: isSplit,
        split_start2: splitStart2 ?? null,
        split_end2: splitEnd2 ?? null,
      });
      if (crossErrors.length > 0) {
        errors.push(`Riga ${rowNum}: ${crossErrors.join('; ')}`); failed++; continue;
      }

      // Multi-tenant + store_manager scope check — look up by unique_id and store code
      const targetUser = await queryOne<{ id: number }>(
        `SELECT id
         FROM users
         WHERE unique_id = $1 AND company_id = $2 AND status = 'active'`,
        [uniqueIdVal, companyId],
      );
      if (!targetUser) {
        errors.push(`Riga ${rowNum}: dipendente con ID '${uniqueIdVal}' non trovato`); failed++; continue;
      }
      const userId = targetUser.id;

      const hasDateOffDay = await hasExplicitOffDayShift({
        companyId,
        userId,
        date: dateVal,
      });
      if (hasDateOffDay) {
        skipped++;
        continue;
      }

      const targetStore = await queryOne<{ id: number; timezone: string | null }>(
        `SELECT id, timezone FROM stores WHERE code = $1 AND company_id = $2 AND is_active = true`,
        [storeCodeVal, companyId],
      );
      if (!targetStore) {
        errors.push(`Riga ${rowNum}: negozio con codice '${storeCodeVal}' non trovato`); failed++; continue;
      }
      const storeId = targetStore.id;

      if (role === 'store_manager' && storeId !== callerStoreId) {
        errors.push(`Riga ${rowNum}: non autorizzato per negozio ${storeCodeVal}`); failed++; continue;
      }
      if (role === 'area_manager') {
        const managedStores = await query<{ store_id: number }>(
          `SELECT DISTINCT store_id FROM users
           WHERE role = 'store_manager' AND supervisor_id = $1
             AND status = 'active' AND store_id IS NOT NULL`,
          [callerId],
        );
        if (!managedStores.some((r) => r.store_id === storeId)) {
          errors.push(`Riga ${rowNum}: non autorizzato per negozio ${storeCodeVal}`); failed++; continue;
        }
      }

      // Overlap detection — mirrors createShift: check new main block AND new split block
      // against existing main blocks AND existing split second blocks
      // H6 fix: use <= / >= so identical shifts (same start+end) are also caught
      const overlapMain = await queryOne<{ id: number }>(
        `SELECT id FROM shifts
         WHERE company_id = $1 AND user_id = $2 AND date = $3 AND status != 'cancelled'
           AND (
             (start_time <= $4::TIME AND end_time >= $5::TIME)
             OR (is_split AND split_start2 IS NOT NULL AND split_end2 IS NOT NULL
                 AND split_start2 <= $4::TIME AND split_end2 >= $5::TIME)
           )`,
        [companyId, userId, dateVal, endTime, startTime],
      );
      let overlapSplit = null;
      if (isSplit && splitStart2 && splitEnd2) {
        overlapSplit = await queryOne<{ id: number }>(
          `SELECT id FROM shifts
           WHERE company_id = $1 AND user_id = $2 AND date = $3 AND status != 'cancelled'
             AND (
               (start_time <= $4::TIME AND end_time >= $5::TIME)
               OR (is_split AND split_start2 IS NOT NULL AND split_end2 IS NOT NULL
                   AND split_start2 <= $4::TIME AND split_end2 >= $5::TIME)
             )`,
          [companyId, userId, dateVal, splitEnd2, splitStart2],
        );
      }
      if (overlapMain || overlapSplit) { skipped++; continue; }

      // Import is unattended: report the leave clash as a row error so the
      // operator sees it, instead of quietly creating a future false absence.
      if (await findLeaveConflict(companyId, userId, dateVal)) {
        errors.push(`Riga ${rowNum}: permesso approvato in questa data — turno non importato`);
        skipped++;
        continue;
      }

      // Collect validated rows for batched INSERT (M5)
      validRows.push([
        companyId,
        storeId,
        userId,
        dateVal,
        // Per row: each spreadsheet line names its own store, so each takes that
        // store's zone. A single zone for the whole file would be wrong the moment
        // an import spans two shops in different countries.
        normalizeShiftTimezone(targetStore.timezone, DEFAULT_SHIFT_TIMEZONE),
        startTime,
        endTime,
        breakStart ?? null,
        breakEnd ?? null,
        breakType,
        normalizedBreakMins,
        isSplit,
        splitStart2 ?? null,
        splitEnd2 ?? null,
        notes,
        status,
        callerId,
      ]);
    } catch {
      errors.push(`Riga ${rowNum}: errore imprevisto`);
      failed++;
    }
  }

  // M5: single multi-row INSERT for all validated rows
  if (validRows.length > 0) {
    const COLS = 17;
    const placeholders = validRows.map((_, ri) => {
      const b = ri * COLS + 1;
      // A point at or before the start time belongs to the following day — a
      // 22:00-06:00 shift ends at the 06:00 of tomorrow, not of the shift date.
      // create and update already rolled the date over; the bulk import did not,
      // so an imported overnight shift was stored as ending before it began.
      const rollsOver = (idx: number) =>
        `(CASE WHEN $${idx}::TIME < $${b+5}::TIME THEN INTERVAL '1 day' ELSE INTERVAL '0' END)`;
      const pointUtc = (idx: number) =>
        `(($${b+3}::DATE + ${rollsOver(idx)} + $${idx}::TIME) AT TIME ZONE $${b+4})`;
      const nullablePointUtc = (idx: number) =>
        `CASE WHEN $${idx}::TIME IS NULL THEN NULL ELSE ${pointUtc(idx)} END`;

      return `(
        $${b}, $${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6},
        (($${b+3}::DATE + $${b+5}::TIME) AT TIME ZONE $${b+4}),
        ${pointUtc(b+6)},
        $${b+7}, $${b+8},
        ${nullablePointUtc(b+7)},
        ${nullablePointUtc(b+8)},
        $${b+9}, $${b+10},
        $${b+11}, $${b+12}, $${b+13},
        ${nullablePointUtc(b+12)},
        ${nullablePointUtc(b+13)},
        $${b+14}, $${b+15}, $${b+16}
      )`;
    }).join(',');
    await query(
      `INSERT INTO shifts (
         company_id, store_id, user_id, date, timezone, start_time, end_time,
         start_at_utc, end_at_utc,
         break_start, break_end, break_start_at_utc, break_end_at_utc,
         break_type, break_minutes,
         is_split, split_start2, split_end2, split_start2_at_utc, split_end2_at_utc,
         notes, status, created_by
       )
       VALUES ${placeholders}`,
      validRows.flat(),
    );
    imported = validRows.length;
  }

  ok(res, { imported, skipped, failed, errors: errors.slice(0, 20), total: rows.length });
});

// ---------------------------------------------------------------------------
// GET /api/shifts/affluence  ?store_id&week&day_of_week
// ---------------------------------------------------------------------------
export const getAffluence = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, is_super_admin } = req.user!;
  const { store_id, week, day_of_week, raw } = req.query as Record<string, string>;

  // Super admins can query across companies; regular users are scoped to their own.
  const scopeByCompany = companyId != null && !is_super_admin;
  const params: any[] = scopeByCompany ? [companyId] : [];
  let whereClause = scopeByCompany ? 'WHERE company_id = $1' : 'WHERE 1=1';
  let idx = scopeByCompany ? 2 : 1;
  let weekPlaceholder: number | null = null;

  if (store_id) {
    whereClause += ` AND store_id = $${idx}`;
    params.push(parseInt(store_id, 10));
    idx++;
  }
  if (week) {
    const isoWeek = parseInt(week.replace(/.*W/, ''), 10);
    whereClause += ` AND (iso_week = $${idx} OR iso_week IS NULL)`;
    params.push(isoWeek);
    weekPlaceholder = idx;
    idx++;
  }
  if (day_of_week) {
    whereClause += ` AND day_of_week = $${idx}`;
    params.push(parseInt(day_of_week, 10));
    idx++;
  }

  const affluence = await query(
    `SELECT *
       FROM store_affluence
      ${whereClause}
      ORDER BY day_of_week,
               time_slot,
               ${weekPlaceholder != null ? `CASE WHEN iso_week = $${weekPlaceholder} THEN 0 ELSE 1 END,` : ''}
               id DESC`,
    params,
  );

  // NEW: skip dedup when caller wants raw rows (admin panel)
  if (raw === '1') {
    ok(res, { affluence });
    return;
  }

  // Prefer exact week-specific entries over default (iso_week IS NULL) per day/slot.
  const seen = new Set<string>();
  const merged = affluence.filter((row: any) => {
    const key = `${row.day_of_week}|${row.time_slot}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // When a week is provided, annotate each row with how many staff are actually
  // scheduled for that slot (shifts that overlap the time slot on the matching day).
  if (week && store_id) {
    const parsedWeek = parseIsoWeek(week);
    const schedParams: any[] = [parseInt(store_id, 10), parsedWeek];
    const companyFilter = scopeByCompany ? `AND s.company_id = $3` : '';
    if (scopeByCompany) schedParams.push(companyId);

    const scheduled = await query<{ day_of_week: number; time_slot: string; scheduled_staff: number }>(
      `SELECT
         EXTRACT(ISODOW FROM s.date)::int AS day_of_week,
         ts.time_slot,
         COUNT(DISTINCT s.user_id)::int AS scheduled_staff
       FROM shifts s
       CROSS JOIN (VALUES
         ('09:00-12:00', '09:00'::time, '12:00'::time),
         ('12:00-15:00', '12:00'::time, '15:00'::time),
         ('15:00-18:00', '15:00'::time, '18:00'::time),
         ('18:00-21:00', '18:00'::time, '21:00'::time)
       ) AS ts(time_slot, slot_start, slot_end)
       WHERE s.store_id = $1
         AND s.status != 'cancelled'
         ${companyFilter}
         AND s.date >= DATE_TRUNC('week', TO_DATE($2, 'IYYY-IW'))
         AND s.date <  DATE_TRUNC('week', TO_DATE($2, 'IYYY-IW')) + INTERVAL '7 days'
         AND s.start_time < ts.slot_end
         AND s.end_time   > ts.slot_start
       GROUP BY 1, 2`,
      schedParams,
    );

    const schedMap = new Map<string, number>();
    for (const s of scheduled) {
      schedMap.set(`${s.day_of_week}|${s.time_slot}`, s.scheduled_staff);
    }
    for (const row of merged as any[]) {
      row.scheduled_staff = schedMap.get(`${row.day_of_week}|${row.time_slot}`) ?? 0;
    }
  }

  ok(res, { affluence: merged });
});

// ---------------------------------------------------------------------------
// POST /api/shifts/affluence
// ---------------------------------------------------------------------------
export const createAffluence = asyncHandler(async (req: Request, res: Response) => {
  const { companyId } = req.user!;
  const { store_id, day_of_week, time_slot, level, required_staff, iso_week } = req.body as {
    store_id: number;
    day_of_week: number;
    time_slot: string;
    level: string;
    required_staff: number;
    iso_week?: number | null;
  };

  // Super admins (is_super_admin=true or null companyId) can manage any store.
  // Use IS NOT FALSE so stores with is_active = NULL are also matched.
  const { is_super_admin } = req.user!;
  const scopeByCompany = companyId != null && !is_super_admin;
  const store = await queryOne<{ id: number; company_id: number }>(
    scopeByCompany
      ? `SELECT id, company_id FROM stores WHERE id = $1 AND company_id = $2 AND is_active IS NOT FALSE`
      : `SELECT id, company_id FROM stores WHERE id = $1 AND is_active IS NOT FALSE`,
    scopeByCompany ? [store_id, companyId] : [store_id],
  );
  if (!store) return notFound(res, 'Store not found', 'STORE_NOT_FOUND');

  const effectiveCompanyId = store.company_id;

  // Check for existing row with same slot to prevent duplicates
  const existing = await queryOne(
    `SELECT id FROM store_affluence
      WHERE company_id = $1 AND store_id = $2 AND day_of_week = $3
        AND time_slot = $4 AND (iso_week = $5 OR (iso_week IS NULL AND $5::int IS NULL))`,
    [effectiveCompanyId, store_id, day_of_week, time_slot, iso_week ?? null],
  );
  if (existing) return conflict(res, 'Esiste già una fascia per questa combinazione. Usa PUT per modificarla.');

  const row = await queryOne(
    `INSERT INTO store_affluence (company_id, store_id, day_of_week, time_slot, level, required_staff, iso_week)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [effectiveCompanyId, store_id, day_of_week, time_slot, level, required_staff, iso_week ?? null],
  );

  created(res, { affluence: row });
});

// ---------------------------------------------------------------------------
// PUT /api/shifts/affluence/:id
// ---------------------------------------------------------------------------
export const updateAffluence = asyncHandler(async (req: Request, res: Response) => {
  const { companyId } = req.user!;
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return badRequest(res, 'Invalid ID');
  const { level, required_staff } = req.body as { level: string; required_staff: number };

  const { is_super_admin } = req.user!;
  const scopeByCompany = companyId != null && !is_super_admin;
  const companyFilter = scopeByCompany ? 'AND company_id = $4' : '';
  const params = scopeByCompany ? [level, required_staff, id, companyId] : [level, required_staff, id];
  const row = await queryOne(
    `UPDATE store_affluence
        SET level = $1, required_staff = $2
      WHERE id = $3 ${companyFilter}
      RETURNING *`,
    params,
  );

  if (!row) return notFound(res, 'Fascia affluenza non trovata');
  ok(res, { affluence: row });
});

// ---------------------------------------------------------------------------
// DELETE /api/shifts/affluence/:id
// ---------------------------------------------------------------------------
export const deleteAffluence = asyncHandler(async (req: Request, res: Response) => {
  const { companyId } = req.user!;
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return badRequest(res, 'Invalid ID');

  const { is_super_admin } = req.user!;
  const scopeByCompany = companyId != null && !is_super_admin;
  const companyFilter = scopeByCompany ? 'AND company_id = $2' : '';
  const params = scopeByCompany ? [id, companyId] : [id];
  const row = await queryOne(
    `DELETE FROM store_affluence WHERE id = $1 ${companyFilter} RETURNING id`,
    params,
  );

  if (!row) return notFound(res, 'Fascia affluenza non trovata');
  ok(res, { deleted: id });
});
