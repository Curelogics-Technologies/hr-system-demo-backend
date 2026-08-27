// Leave Controller - Refined with escalation fixes
import { Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { query, queryOne, pool } from '../../config/database';
import { ok, created, notFound, forbidden, badRequest } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { resolveAllowedCompanyIds } from '../../utils/companyScope';
import { DEFAULT_SHIFT_TIMEZONE } from '../../utils/shiftTimezone';
import { sendNotification } from '../notifications/notifications.service';
import { sendLeaveResultAutomation } from '../automations/leaveNotification';
import { sendLeaveSubmittedAutomation } from '../automations/leaveSubmittedNotification';
import { t } from '../../utils/i18n';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_LEAVE_TYPES = ['vacation', 'sick'] as const;
type LeaveType = typeof VALID_LEAVE_TYPES[number];
type LeaveDurationType = 'full_day' | 'short_leave';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^\d{2}:\d{2}$/;

function formatDateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    const fallback = new Date(date);
    return `${fallback.getFullYear()}-${String(fallback.getMonth() + 1).padStart(2, '0')}-${String(fallback.getDate()).padStart(2, '0')}`;
  }

  return `${year}-${month}-${day}`;
}

function todayInDefaultLeaveTimezone(): string {
  return formatDateInTimezone(new Date(), DEFAULT_SHIFT_TIMEZONE);
}

function currentYearInDefaultLeaveTimezone(): number {
  return parseInt(todayInDefaultLeaveTimezone().slice(0, 4), 10);
}

function yearFromIsoDate(isoDate: string): number {
  const match = (isoDate ?? '').match(/^(\d{4})-/);
  if (!match) return currentYearInDefaultLeaveTimezone();
  const parsed = parseInt(match[1], 10);
  return Number.isInteger(parsed) ? parsed : currentYearInDefaultLeaveTimezone();
}

/**
 * Roles that are completely barred from all leave-management endpoints.
 * store_terminal is a kiosk-only role; system_admin has no company binding.
 */
const LEAVE_BLOCKED_ROLES = new Set(['store_terminal', 'system_admin']);

/**
 * Role hierarchy for visibility and approval logic.
 * Higher value means higher in the hierarchy.
 */
const ROLE_RANKS: Record<string, number> = {
  admin: 100,
  hr: 80,
  area_manager: 60,
  store_manager: 40,
  employee: 20,
};

function getRoleRank(role?: string): number {
  if (!role) return 0;
  const r = role.toLowerCase().replace(/\s+/g, '_');
  return ROLE_RANKS[r] ?? 0;
}

const RANK_SQL_CASE = `
  CASE LOWER(REPLACE($ROLE_VAR::text, ' ', '_'))
    WHEN 'admin' THEN 100
    WHEN 'hr' THEN 80
    WHEN 'area_manager' THEN 60
    WHEN 'store_manager' THEN 40
    WHEN 'employee' THEN 20
    ELSE 0
  END
`;

const TARGET_RANK_SQL = `
  CASE LOWER(REPLACE(u.role::text, ' ', '_'))
    WHEN 'admin' THEN 100
    WHEN 'hr' THEN 80
    WHEN 'area_manager' THEN 60
    WHEN 'store_manager' THEN 40
    WHEN 'employee' THEN 20
    ELSE 0
  END
`;

// ---------------------------------------------------------------------------
// Pure utilities
// ---------------------------------------------------------------------------

function sanitiseCertificateName(raw: string): string {
  const ext = raw.split('.').pop()?.toLowerCase() ?? 'bin';
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe.length > 0 ? safe : `certificato.${ext}`;
}

/**
 * Count working days (Mon–Fri) between two ISO date strings, inclusive.
 *
 * FIX: Parse date parts explicitly with new Date(y, m-1, d) instead of
 * new Date(isoString) to avoid UTC-midnight-vs-local-midnight shift that
 * causes getDay() to return the wrong weekday on non-UTC servers.
 */
function countWorkingDays(startDateIn: string | Date, endDateIn: string | Date): number {
  const parse = (d: string | Date) => {
    if (d instanceof Date) return d;
    const [y, m, day] = d.split('T')[0].split('-').map(Number);
    return new Date(y, m - 1, day);
  };

  const start = parse(startDateIn);
  const end = parse(endDateIn);
  const current = new Date(start);
  let count = 0;
  while (current <= end) {
    const dow = current.getDay();
    if (dow !== 0 && dow !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

function parseTimeToMinutes(raw: string): number | null {
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length < 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function isWeekendIsoDate(isoDate: string): boolean {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay();
  return day === 0 || day === 6;
}

function calculateShortLeaveDurationHours(startTime: string, endTime: string): number | null {
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);
  if (startMinutes == null || endMinutes == null || endMinutes <= startMinutes) {
    return null;
  }
  return Number(((endMinutes - startMinutes) / 60).toFixed(2));
}

function normalizeLeaveDurationInput(
  params: {
    leaveType: LeaveType;
    startDate: string;
    endDate: string;
    leaveDurationType?: string;
    shortStartTime?: string | null;
    shortEndTime?: string | null;
  },
):
  | {
    leaveDurationType: LeaveDurationType;
    shortStartTime: string | null;
    shortEndTime: string | null;
    requestedDays: number;
    durationHours: number | null;
  }
  | { error: string; code: string } {
  const leaveDurationType: LeaveDurationType =
    params.leaveDurationType === 'short_leave' ? 'short_leave' : 'full_day';

  if (leaveDurationType === 'full_day') {
    return {
      leaveDurationType,
      shortStartTime: null,
      shortEndTime: null,
      requestedDays: countWorkingDays(params.startDate, params.endDate),
      durationHours: null,
    };
  }

  if (params.leaveType !== 'vacation') {
    return {
      error: 'Il permesso a ore è disponibile solo per ferie',
      code: 'SHORT_LEAVE_ONLY_FOR_VACATION',
    };
  }

  if (params.startDate !== params.endDate) {
    return {
      error: 'Per il permesso a ore la data di inizio e fine deve coincidere',
      code: 'SHORT_LEAVE_SAME_DAY_REQUIRED',
    };
  }

  if (isWeekendIsoDate(params.startDate)) {
    return {
      error: 'Il permesso a ore è consentito solo nei giorni lavorativi',
      code: 'SHORT_LEAVE_WEEKEND_NOT_ALLOWED',
    };
  }

  const shortStartTime = params.shortStartTime?.trim() ?? '';
  const shortEndTime = params.shortEndTime?.trim() ?? '';
  if (!HHMM_RE.test(shortStartTime) || !HHMM_RE.test(shortEndTime)) {
    return {
      error: 'Formato ora non valido (HH:MM)',
      code: 'INVALID_SHORT_LEAVE_TIME_FORMAT',
    };
  }

  const durationHours = calculateShortLeaveDurationHours(shortStartTime, shortEndTime);
  if (durationHours == null) {
    return {
      error: 'L\'ora di fine deve essere successiva all\'ora di inizio',
      code: 'INVALID_SHORT_LEAVE_TIME_RANGE',
    };
  }

  if (durationHours >= 24) {
    return {
      error: 'Il permesso a ore deve essere inferiore a 24 ore',
      code: 'SHORT_LEAVE_TOO_LONG',
    };
  }

  const requestedDays = Number((durationHours / 8).toFixed(2));
  if (requestedDays <= 0) {
    return {
      error: 'Durata del permesso non valida',
      code: 'SHORT_LEAVE_DURATION_INVALID',
    };
  }

  return {
    leaveDurationType,
    shortStartTime,
    shortEndTime,
    requestedDays,
    durationHours,
  };
}

function computeRequestedLeaveDays(leave: {
  start_date: string;
  end_date: string;
  leave_duration_type?: string | null;
  short_start_time?: string | null;
  short_end_time?: string | null;
}): number {
  if (
    leave.leave_duration_type === 'short_leave' &&
    leave.short_start_time &&
    leave.short_end_time
  ) {
    const durationHours = calculateShortLeaveDurationHours(leave.short_start_time, leave.short_end_time);
    if (durationHours != null && durationHours > 0 && durationHours < 24) {
      return Number((durationHours / 8).toFixed(2));
    }
  }
  return countWorkingDays(leave.start_date, leave.end_date);
}

/**
 * Dynamically calculate the total used leave days for a user in a specific year.
 * This ensures the balance is always accurate based on approved requests.
 */
async function getUserUsedDays(userId: number, year: number, leaveType: string): Promise<number> {
  const requests = await query<{
    start_date: string;
    end_date: string;
    leave_duration_type: string | null;
    short_start_time: string | null;
    short_end_time: string | null;
  }>(
    `SELECT start_date::text as start_date, end_date::text as end_date, 
            leave_duration_type, 
            TO_CHAR(short_start_time, 'HH24:MI') as short_start_time, 
            TO_CHAR(short_end_time, 'HH24:MI') as short_end_time
     FROM leave_requests
     WHERE user_id = $1 AND leave_type = $2 
       AND status IN ('approved', 'admin_approved')
       AND EXTRACT(YEAR FROM start_date) = $3`,
    [userId, leaveType, year]
  );

  let total = 0;
  for (const req of requests) {
    total += computeRequestedLeaveDays({
      start_date: req.start_date,
      end_date: req.end_date,
      leave_duration_type: req.leave_duration_type,
      short_start_time: req.short_start_time,
      short_end_time: req.short_end_time
    });
  }
  return Number(total.toFixed(2));
}


/**
 * Determine the first approver role for a given company/store combination.
 * Skip-stage rule: if no store_manager exists for the store, or they are on leave, escalate to
 * area_manager; if no area_manager exists for the company, or they are on leave, escalate to hr.
 */
/**
 * Default approval chain (used when no company config exists).
 */
const DEFAULT_APPROVAL_CHAIN = ['store_manager', 'area_manager', 'hr', 'admin'];

/**
 * Roles whose decision can never be made by the system.
 *
 * The inactivity job may carry a request past a store or area manager who has
 * not looked at it — that only moves it up the chain, it grants nothing. HR and
 * Admin are different: HR approval is where the leave becomes real and the
 * balance is deducted, so it must always be a person. A request sitting on HR
 * or Admin is chased, never advanced and never approved.
 */
const MANUAL_ONLY_APPROVER_ROLES = new Set(['hr', 'admin']);

/** True when the inactivity job is allowed to carry this stage forward. */
function canAutoAdvance(role: string): boolean {
  return !MANUAL_ONLY_APPROVER_ROLES.has(role);
}

/**
 * Maps each role to the status name produced when that role approves.
 */
const ROLE_STATUS: Record<string, string> = {
  store_manager: 'store manager approved',
  area_manager: 'area manager approved',
  hr: 'HR approved',
  admin: 'approved',
};

function isPgCheckConstraintError(err: unknown): boolean {
  const anyErr = err as { code?: string };
  return anyErr?.code === '23514';
}

/**
 * Load the enabled approval chain for a company from leave_approval_config.
 * Falls back to DEFAULT_APPROVAL_CHAIN if no config rows exist.
 */
async function getApprovalChain(companyId: number): Promise<string[]> {
  const rows = await query<{ role: string }>(
    `SELECT role FROM leave_approval_config
     WHERE company_id = $1 AND enabled = true
     ORDER BY sort_order`,
    [companyId],
  );
  return rows.length > 0 ? rows.map((r) => r.role) : DEFAULT_APPROVAL_CHAIN;
}

/**
 * Build a transition map dynamically from an ordered approval chain.
 * Each role maps to the status it produces and the next approver in line.
 */
function buildTransitions(chain: string[]): Record<string, { nextStatus: string; nextApprover: string | null }> {
  const transitions: Record<string, { nextStatus: string; nextApprover: string | null }> = {};
  for (let i = 0; i < chain.length; i++) {
    transitions[chain[i]] = {
      nextStatus: ROLE_STATUS[chain[i]] ?? `${chain[i]}_approved`,
      nextApprover: i + 1 < chain.length ? chain[i + 1] : null,
    };
  }
  return transitions;
}

/**
 * Helper to check if a specific user is on leave (Approved) during the requested dates
 * OR is currently away TODAY.
 */
async function isUserOnLeave(userId: number, startDate: string, endDate: string) {
  const leave = await queryOne(
    `SELECT id FROM leave_requests 
     WHERE user_id = $1 
       AND status NOT IN ('rejected', 'cancelled', 'store manager rejected', 'area manager rejected', 'HR rejected')
       AND (
         (start_date <= $2::date AND end_date >= $3::date) OR -- Overlaps with requested leave dates
         (start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE)    -- Overlaps with TODAY
       )
     LIMIT 1`,
    [userId, endDate, startDate]
  );
  return !!leave;
}




/**
 * All active users who could act as `role` for this company/store.
 *
 * Shared by the approver search and by the escalation reminder, so the person we
 * route a request to is always the same person we notify about it.
 */
async function usersForApproverRole(
  companyId: number,
  storeId: number | null,
  role: string,
  submitterId: number,
): Promise<{ id: number }[]> {
  if (role === 'store_manager' && storeId) {
    return query(
      `SELECT id FROM users WHERE role = 'store_manager' AND store_id = $1 AND company_id = $2 AND status = 'active'`,
      [storeId, companyId],
    );
  }
  if (role === 'area_manager') {
    // Priority: direct supervisor of the submitter
    const supervisor = await queryOne<{ id: number }>(
      `SELECT id FROM users WHERE id = (SELECT supervisor_id FROM users WHERE id = $1) AND role = 'area_manager' AND status = 'active' LIMIT 1`,
      [submitterId],
    );
    if (supervisor) return [supervisor];
    // The chain is company-specific, so fall back to any area manager in the
    // request's company rather than looking across the group.
    return query(
      `SELECT id FROM users WHERE role = 'area_manager' AND company_id = $1 AND status = 'active'`,
      [companyId],
    );
  }
  if (role === 'hr' || role === 'admin') {
    return query(
      `SELECT id FROM users WHERE role = $2 AND company_id = $1 AND status = 'active'`,
      [companyId, role],
    );
  }
  return [];
}

/**
 * Recursively find the next active approver in the chain, skipping those on leave or unavailable.

 * Updated to correctly handle skips when starting from a mid-chain role and to check multiple potential users.
 */
async function findNextActiveApprover(
  companyId: number,
  storeId: number | null,
  startDate: string,
  endDate: string,
  submitterId: number,
  startRole: string | null,
  chain?: string[]
): Promise<{ approver: string | null, skipped: string[] }> {
  const approvalChain = chain ?? await getApprovalChain(companyId);
  const skipped: string[] = [];
  let startIndex = 0;
  if (startRole) {
    startIndex = approvalChain.indexOf(startRole);
    if (startIndex === -1) {
      const requestedIndexInDefault = DEFAULT_APPROVAL_CHAIN.indexOf(startRole);
      const nextEnabledRole = approvalChain.find(r => DEFAULT_APPROVAL_CHAIN.indexOf(r) > requestedIndexInDefault);
      if (nextEnabledRole) {
        const result = await findNextActiveApprover(companyId, storeId, startDate, endDate, submitterId, nextEnabledRole, approvalChain);
        return { ...result, skipped: [startRole, ...result.skipped] };
      }
      return { approver: 'admin', skipped: [startRole] }; 
    }
  }


  for (let i = startIndex; i < approvalChain.length; i++) {
    const role = approvalChain[i];

    // 1. Get ALL potential active users for this role
    const users = await usersForApproverRole(companyId, storeId, role, submitterId);

    // 2. Filter out users who are either the submitter or on leave
    const availableUsers: { id: number }[] = [];
    for (const u of users) {
      const onLeave = await isUserOnLeave(u.id, startDate, endDate);
      if (u.id !== submitterId && !onLeave) {
        availableUsers.push(u);
      }
    }

    // 3. If no available users found for this role, skip it and continue to the next
    if (availableUsers.length === 0) {
      skipped.push(role);
      continue;
    }

    // 4. We found at least one available user, this is the current approver stage
    return { approver: role, skipped };
  }

  return { approver: null, skipped };
}



/**
 * Determine the first approver role for a given company/store combination.
 * Enforces role-based hierarchy skips.
 */
async function determineFirstApprover(
  companyId: number,
  storeId: number | null,
  startDate: string,
  endDate: string,
  submitterId: number,
  submitterRole: string
): Promise<{ approver: string, skipped: string[], unavailabilitySkips: string[] }> {
  const role = submitterRole?.toLowerCase() || '';
  const chain = await getApprovalChain(companyId);
  
  const disabledRoles = DEFAULT_APPROVAL_CHAIN.filter(r => !chain.includes(r));
  const hierarchySkips: string[] = [];
  let minRole: string | null = null;

  // Use includes to be more flexible with role strings (handles underscores, spaces, etc.)
  if (role.includes('admin')) {
    return { approver: 'admin', skipped: [], unavailabilitySkips: [] };
  } else if (role.includes('hr')) {
    hierarchySkips.push('store_manager', 'area_manager', 'hr');
    minRole = 'admin';
  } else if (role.includes('area_manager') || role.includes('area manager')) {
    hierarchySkips.push('store_manager', 'area_manager');
    minRole = 'hr';
  } else if (role.includes('store_manager') || role.includes('store manager')) {
    hierarchySkips.push('store_manager');
    minRole = 'area_manager';
  } else {
    // Regular employees start at store_manager
    minRole = 'store_manager';
  }

  const { approver, skipped: unavailabilitySkips } = await findNextActiveApprover(
    companyId, storeId, startDate, endDate, submitterId, minRole, chain
  );

  const realUnavailabilitySkips = unavailabilitySkips.filter(r => chain.includes(r));

  const allSkipped = Array.from(new Set([
    ...disabledRoles,
    ...hierarchySkips,
    ...unavailabilitySkips
  ]));

  return { approver: approver || 'admin', skipped: allSkipped, unavailabilitySkips: realUnavailabilitySkips };
}


// ---------------------------------------------------------------------------
// POST /api/leave — submit a leave request
// ---------------------------------------------------------------------------

export const submitLeave = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, userId, storeId, role } = req.user!;

  // FIX 3 & 4: block roles that have no business submitting leave
  if (LEAVE_BLOCKED_ROLES.has(role)) {
    forbidden(res, 'Accesso non consentito per questo ruolo');
    return;
  }
  // system_admin has companyId = null (migration 015); guard explicitly
  if (!companyId) {
    forbidden(res, 'Nessuna azienda associata a questo account');
    return;
  }

  const { leave_type, start_date, end_date, leave_duration_type, short_start_time, short_end_time, notes } = req.body as {
    leave_type: LeaveType;
    start_date: string;
    end_date: string;
    leave_duration_type?: LeaveDurationType;
    short_start_time?: string;
    short_end_time?: string;
    notes?: string;
  };

  // FIX 2: validate leave_type at application level before hitting DB CHECK
  if (!VALID_LEAVE_TYPES.includes(leave_type)) {
    badRequest(res, 'Tipo di permesso non valido (vacation | sick)', 'INVALID_LEAVE_TYPE');
    return;
  }

  if (!ISO_DATE_RE.test(start_date) || !ISO_DATE_RE.test(end_date)) {
    badRequest(res, 'Formato data non valido (YYYY-MM-DD)', 'INVALID_DATE_FORMAT');
    return;
  }

  const today = todayInDefaultLeaveTimezone();
  if (start_date < today) {
    badRequest(res, 'Non è possibile richiedere ferie per date passate', 'PAST_DATE_NOT_ALLOWED');
    return;
  }
  if (start_date > end_date) {
    badRequest(res, 'La data di inizio non può essere successiva alla data di fine', 'INVALID_DATE_RANGE');
    return;
  }

  const normalizedDuration = normalizeLeaveDurationInput({
    leaveType: leave_type,
    startDate: start_date,
    endDate: end_date,
    leaveDurationType: leave_duration_type,
    shortStartTime: short_start_time,
    shortEndTime: short_end_time,
  });
  if ('error' in normalizedDuration) {
    badRequest(res, normalizedDuration.error, normalizedDuration.code);
    return;
  }

  const { leaveDurationType, shortStartTime, shortEndTime, requestedDays } = normalizedDuration;

  // Validate PDF magic bytes if a certificate is uploaded
  const file = (req as any).file as Express.Multer.File | undefined;
  if (file) {
    const magic = file.buffer?.slice(0, 4);
    if (!magic || magic.toString('ascii') !== '%PDF') {
      badRequest(res, 'Il file deve essere un PDF valido', 'INVALID_FILE_TYPE');
      return;
    }
  }

  // Overlap check — ONLY FOR THE SAME USER (user_id = $2).
  // Counts ANY live request (pending, in-progress OR approved), not just approved
  // ones — otherwise a user could submit two overlapping requests while both are
  // still pending and then have both approved, deducting the balance twice.
  // Rejected/cancelled requests are ignored so re-submitting after one is allowed.
  const overlap = await queryOne<{ id: number }>(
    `SELECT id FROM leave_requests
     WHERE company_id = $1 AND user_id = $2
       AND status NOT IN ('rejected', 'cancelled', 'store manager rejected', 'area manager rejected', 'HR rejected')
       AND start_date <= $3 AND end_date >= $4`,
    [companyId, userId, end_date, start_date],
  );
  if (overlap) {
    badRequest(res, 'Hai già una richiesta di permesso che si sovrappone a queste date', 'LEAVE_OVERLAP');
    return;
  }

  // --- Leave Balance Validation ---
  if (requestedDays > 0) {
    const year = yearFromIsoDate(start_date);
    const defaultTotal = leave_type === 'vacation' ? 25 : 10;

    // Dynamically calculate current used days from approved requests
    const currentUsed = await getUserUsedDays(userId, year, leave_type);

    // Fetch total allowed days from balance table, fallback to default if not set
    const balance = await queryOne<{ total_days: number }>(
      `SELECT total_days FROM leave_balances 
       WHERE company_id = $1 AND user_id = $2 AND year = $3 AND leave_type = $4`,
      [companyId, userId, year, leave_type]
    );
    const limit = parseFloat(String(balance?.total_days ?? defaultTotal));

    if (currentUsed + requestedDays > limit) {
      res.status(400).json({
        success: false,
        error: "You have already used all your leaves.",
        code: "LEAVES_FULL"
      });
      return;
    }
  }

  const certificateName = file ? sanitiseCertificateName(file.originalname) : null;
  const certificateData = file?.buffer ?? null;
  const certificateMime = file?.mimetype ?? null;

  let firstApprover = 'hr';
  let skippedApprovers: string[] = [];
  let onLeaveSkippedApprovers: string[] = [];
  let status = 'pending';
  let nextApproverRole: string | null = null;
  const finalRole = role.toLowerCase().replace(/\s+/g, '_');

  const { approver, skipped, unavailabilitySkips } = await determineFirstApprover(
    companyId, storeId ?? null,
    start_date, end_date,
    userId, role
  );
  firstApprover = approver;
  skippedApprovers = skipped;
  onLeaveSkippedApprovers = unavailabilitySkips;
  nextApproverRole = firstApprover;

  // Rule 2a: Admin-created requests are auto-approved
  if (finalRole === 'admin') {
    status = 'approved';
    nextApproverRole = null;
  } 
  // Rule 2b: HR-created requests are auto-approved at HR level, move to Admin
  else if (finalRole === 'hr') {
    status = 'HR approved';
    nextApproverRole = 'admin';
  }

  // An admin submitting for themselves lands on `approved` with no further
  // approver — i.e. the leave is granted here and now. That path used to insert
  // the row and stop, never touching leave_balances, which is the same defect
  // the escalation job had. Granting and deducting must happen together, so the
  // terminal case runs in one transaction.
  const grantsImmediately = nextApproverRole === null;
  const balanceYear = yearFromIsoDate(start_date);

  // Same rule as HR/Admin approval: nothing is granted against an entitlement
  // nobody configured. An admin filing their own leave is a terminal approval,
  // so it is held to the same standard.
  if (grantsImmediately && requestedDays > 0) {
    const configured = await queryOne<{ id: number }>(
      `SELECT id FROM leave_balances
        WHERE company_id = $1 AND user_id = $2 AND year = $3 AND leave_type = $4`,
      [companyId, userId, balanceYear, leave_type],
    );
    if (!configured) {
      res.status(422).json({
        success: false,
        error: `Saldo non configurato (${leave_type === 'vacation' ? 'ferie' : 'malattia'} ${balanceYear}). Configura prima i giorni disponibili.`,
        code: 'BALANCE_NOT_CONFIGURED',
        details: { user_id: userId, year: balanceYear, leave_type },
      });
      return;
    }
  }

  const submitClient = await pool.connect();
  let leaveRequest: any;
  try {
    await submitClient.query('BEGIN');

    const insertResult = await submitClient.query(
      `INSERT INTO leave_requests
        (company_id, user_id, store_id, leave_type, start_date, end_date, leave_duration_type, short_start_time, short_end_time,
         status, current_approver_role, notes,
         medical_certificate_name, medical_certificate_data, medical_certificate_type, skipped_approvers, on_leave_skipped_approvers,
         approved_by, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               CASE WHEN $18::int IS NULL THEN NULL ELSE NOW() END)
       RETURNING id, company_id, user_id, store_id, leave_type, start_date, end_date,
                 leave_duration_type, short_start_time, short_end_time,
                 status, current_approver_role, notes, medical_certificate_name,
                 skipped_approvers, on_leave_skipped_approvers, escalated, is_emergency_override, last_action_at, created_at, updated_at`,
      [
        companyId,
        userId,
        storeId ?? null,
        leave_type,
        start_date,
        end_date,
        leaveDurationType,
        shortStartTime,
        shortEndTime,
        status,
        nextApproverRole,
        notes ?? null,
        certificateName,
        certificateData,
        certificateMime,
        JSON.stringify(skippedApprovers),
        JSON.stringify(onLeaveSkippedApprovers),
        grantsImmediately ? userId : null,
      ],
    );
    leaveRequest = insertResult.rows[0];

    // If auto-approved (Admin or HR), record the approval action
    if (finalRole === 'admin' || finalRole === 'hr') {
      await submitClient.query(
        `INSERT INTO leave_approvals (leave_request_id, approver_id, approver_role, action, notes)
         VALUES ($1,$2,$3,'approved',$4)`,
        [leaveRequest.id, userId, role, 'Auto-approved on creation'],
      );
    }

    if (grantsImmediately && requestedDays > 0) {
      // UPDATE, not upsert: the allocation was verified above, and creating one
      // here would reintroduce the invented-entitlement problem.
      const deducted = await submitClient.query(
        `UPDATE leave_balances
            SET used_days = used_days + $5, updated_at = NOW()
          WHERE company_id = $1 AND user_id = $2 AND year = $3 AND leave_type = $4`,
        [companyId, userId, balanceYear, leave_type, requestedDays],
      );
      if (deducted.rowCount === 0) {
        throw Object.assign(new Error('BALANCE_NOT_CONFIGURED'), { code: '23514' });
      }
    }

    await submitClient.query('COMMIT');
  } catch (err: any) {
    await submitClient.query('ROLLBACK');
    if (err?.code === '23514') {
      res.status(422).json({
        success: false,
        error: 'Saldo insufficiente per approvare automaticamente questa richiesta',
        code: 'INSUFFICIENT_BALANCE',
      });
      return;
    }
    throw err;
  } finally {
    submitClient.release();
  }

  // Send notification for leave submission
  void sendNotification({
    companyId,
    userId,
    type: 'leave.submitted',
    title: 'Richiesta di permesso inviata',
    message: `La tua richiesta di ${leave_type === 'vacation' ? 'ferie' : 'malattia'} dal ${start_date} al ${end_date} è stata inviata con successo.`,
    priority: 'medium',
  }).catch(() => undefined);

  void queryOne<{ name: string; surname: string; email: string | null }>(
    `SELECT name, surname, email
     FROM users
     WHERE id = $1 AND company_id = $2`,
    [userId, companyId],
  ).then((employee) => {
    if (!employee) return;

    return sendLeaveSubmittedAutomation({
      companyId,
      employeeId: userId,
      employeeName: employee.name,
      employeeSurname: employee.surname,
      employeeEmail: employee.email,
      storeId: storeId ?? null,
      leaveType: leave_type,
      startDate: start_date,
      endDate: end_date,
      leaveDurationType,
      shortStartTime,
      shortEndTime,
      requestedDays,
    });
  }).catch((err) => console.error('[AUTOMATION] Leave submitted email error:', err));

  created(res, leaveRequest, 'Richiesta di permesso inviata');
});

// ---------------------------------------------------------------------------
// GET /api/leave — list requests scoped by role
// ---------------------------------------------------------------------------

export const listLeaveRequests = asyncHandler(async (req: Request, res: Response) => {
  const { role, userId, storeId, is_super_admin } = req.user!;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  // FIX 4: block terminal/system_admin
  if (LEAVE_BLOCKED_ROLES.has(role)) {
    forbidden(res, 'Accesso non consentito per questo ruolo');
    return;
  }

  const { status, leave_type, date_from, date_to, user_id, store_id, archived, page: pageStr, limit: limitStr } =
    req.query as Record<string, string>;

  const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(limitStr ?? '20', 10) || 20));
  const offset = (page - 1) * limit;

  const viewerRank = getRoleRank(role);
  const isViewerAdmin = role.toLowerCase().replace(/\s+/g, '_') === 'admin';

  let scopeWhere: string;
  let scopeParams: any[];

  if (is_super_admin) {
    // Super Admin: All leaves of all users across all companies (allowedCompanyIds handles all companies)
    scopeWhere = `lr.company_id = ANY($1)`;
    scopeParams = [allowedCompanyIds];
  } else {
    const buildHierarchyFilter = (uIdIdx: number) => {
      return `(lr.user_id = $${uIdIdx} OR ${isViewerAdmin} OR (${viewerRank} > ${TARGET_RANK_SQL}))`;
    };

    switch (role) {
      case 'employee':
        // Employee: Can view only their own leaves
        scopeWhere = `lr.company_id = ANY($1) AND lr.user_id = $2`;
        scopeParams = [allowedCompanyIds, userId];
        break;
      case 'store_manager':
        // Store Manager: Their own leaves + Leaves of employees assigned to their store
        scopeWhere = `((lr.company_id = ANY($1) AND lr.store_id = $2) OR lr.user_id = $3) AND ${buildHierarchyFilter(3)}`;
        scopeParams = [allowedCompanyIds, storeId, userId];
        break;
      case 'area_manager': {
        // Area Manager: Their own leaves + Leaves of store managers under them + Leaves of employees under those store managers
        // If part of a group and cross-company is ON, they should see all companies in the group.
        
        // Check if the caller has cross-company access (more than one company in allowedCompanyIds)
        const hasCrossCompany = allowedCompanyIds.length > 1;

        if (hasCrossCompany) {
          // If cross-company is ON, Area Manager sees:
          // 1. All leaves across the group companies (but buildHierarchyFilter still restricts to lower ranks)
          scopeWhere = `lr.company_id = ANY($1) AND (${buildHierarchyFilter(2)} OR EXISTS (
            SELECT 1 FROM leave_approvals la_scope
            WHERE la_scope.leave_request_id = lr.id
              AND la_scope.approver_id = $2
              AND la_scope.approver_role = 'area_manager'
          ))`;
          scopeParams = [allowedCompanyIds, userId];
        } else {
          // Standard local-only visibility: find managed stores in their own company
          const amStores = await query<{ store_id: number }>(
            `SELECT DISTINCT store_id FROM users
             WHERE role = 'store_manager' AND supervisor_id = $1
               AND company_id = $2 AND status = 'active' AND store_id IS NOT NULL`,
            [userId, req.user!.companyId],
          );
          const storeIds = amStores.map((s) => s.store_id);
          
          if (storeIds.length === 0) {
            scopeWhere = `lr.company_id = ANY($1) AND (lr.user_id = $2 OR lr.current_approver_role = 'area_manager' OR EXISTS (
              SELECT 1 FROM leave_approvals la_scope
              WHERE la_scope.leave_request_id = lr.id
                AND la_scope.approver_id = $2
                AND la_scope.approver_role = 'area_manager'
            )) AND ${buildHierarchyFilter(2)}`;
            scopeParams = [allowedCompanyIds, userId];
          } else {
            scopeWhere = `((lr.company_id = ANY($1) AND (lr.store_id = ANY($2::int[]) OR lr.current_approver_role = 'area_manager' OR EXISTS (
              SELECT 1 FROM leave_approvals la_scope
              WHERE la_scope.leave_request_id = lr.id
                AND la_scope.approver_id = $3
                AND la_scope.approver_role = 'area_manager'
            ))) OR lr.user_id = $3) AND ${buildHierarchyFilter(3)}`;
            scopeParams = [allowedCompanyIds, storeIds, userId];
          }
        }
        break;
      }
      case 'admin':
        // Admin: All leaves of users within their associated company only
        scopeWhere = `lr.company_id = ANY($1)`;
        scopeParams = [allowedCompanyIds];
        break;
      case 'hr':
      default:
        // HR: Their own leaves + Leaves of area managers, store managers, and employees
        // Updated: use ANY($1) to allow cross-company visibility if toggle is ON
        scopeWhere = `lr.company_id = ANY($1) AND ${buildHierarchyFilter(2)}`;
        scopeParams = [allowedCompanyIds, userId];
        break;
    }
  }

  if (user_id) {
    scopeWhere += ` AND lr.user_id = $${scopeParams.length + 1}`;
    scopeParams.push(parseInt(user_id, 10));
  }

  let extraWhere = '';
  const extraParams: any[] = [];
  let paramIdx = scopeParams.length + 1;

  // Filter archived requests
  const showArchived = archived === 'true';
  extraWhere += ` AND lr.is_archived = $${paramIdx}`;
  extraParams.push(showArchived);
  paramIdx++;

  if (status) {
    extraWhere += ` AND lr.status = $${paramIdx}`; extraParams.push(status); paramIdx++;
  } else if (role !== 'employee') {
    // Managers, HR, and Admin do not see cancelled requests in their dashboard
    extraWhere += ` AND lr.status != 'cancelled'`;
  }
  if (leave_type) {
    extraWhere += ` AND lr.leave_type = $${paramIdx}`; extraParams.push(leave_type); paramIdx++;
  }
  if (date_from) {
    extraWhere += ` AND lr.end_date >= $${paramIdx}`; extraParams.push(date_from); paramIdx++;
  }
  if (date_to) {
    extraWhere += ` AND lr.start_date <= $${paramIdx}`; extraParams.push(date_to); paramIdx++;
  }
  if (store_id) {
    extraWhere += ` AND lr.store_id = $${paramIdx}`; extraParams.push(parseInt(store_id, 10)); paramIdx++;
  }
  const company_id_param = (req.query.company_id || req.query.companyId) as string | undefined;
  if (company_id_param) {
    const cid = parseInt(company_id_param, 10);
    if (!isNaN(cid) && cid > 0) {
      extraWhere += ` AND lr.company_id = $${paramIdx}`; extraParams.push(cid); paramIdx++;
    }
  }

  const allParams = [...scopeParams, ...extraParams];

  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM leave_requests lr
     JOIN users u ON u.id = lr.user_id
     WHERE ${scopeWhere}${extraWhere}`,
    allParams,
  );
  const total = parseInt(countResult?.count ?? '0', 10);

  const requests = await query(
    `SELECT
       lr.id, lr.company_id, lr.user_id, lr.store_id, lr.leave_type,
       lr.start_date, lr.end_date,
       lr.is_archived,
       lr.leave_duration_type,
       TO_CHAR(lr.short_start_time, 'HH24:MI') AS short_start_time,
       TO_CHAR(lr.short_end_time, 'HH24:MI') AS short_end_time,
       lr.status, lr.current_approver_role,
       lr.notes, lr.created_at, lr.updated_at,
       lr.last_action_at,
       lr.medical_certificate_name,
       lr.skipped_approvers, lr.on_leave_skipped_approvers, lr.escalated, lr.is_emergency_override, lr.approved_by, lr.approved_at, lr.last_reminder_at,
       (
         SELECT array_agg(DISTINCT approver_role)
         FROM leave_approvals
         WHERE leave_request_id = lr.id AND action = 'approved'
       ) AS approved_by_roles,
        (
          SELECT json_agg(json_build_object(
            'role', la_inner.approver_role,
            'action', la_inner.action,
            'createdAt', la_inner.created_at,
            'notes', la_inner.notes,
            'approverName', u_inner.name,
            'approverSurname', u_inner.surname
          ) ORDER BY la_inner.created_at ASC)
          FROM leave_approvals la_inner
          LEFT JOIN users u_inner ON u_inner.id = la_inner.approver_id
          WHERE la_inner.leave_request_id = lr.id
        ) AS approvals_history,
       (
         SELECT json_agg(json_build_object(
           'role', la_inner.approver_role,
           'action', la_inner.action,
           'createdAt', la_inner.created_at,
           'notes', la_inner.notes,
           'approverName', u_inner.name,
           'approverSurname', u_inner.surname
         ) ORDER BY la_inner.created_at ASC)
         FROM leave_approvals la_inner
         LEFT JOIN users u_inner ON u_inner.id = la_inner.approver_id
         WHERE la_inner.leave_request_id = lr.id
       ) AS approvals_history,
       la.action AS latest_action,
       la.created_at AS latest_action_at,
       la.approver_name AS latest_action_by_name,
       la.approver_surname AS latest_action_by_surname,
       la.approver_role AS latest_action_by_role,
       u.name AS user_name, u.surname AS user_surname,
       u.role AS user_role,
       u.avatar_filename AS user_avatar_filename,
       s.name AS store_name,
       s.logo_filename AS store_logo_filename,
       c.name AS company_name
     FROM leave_requests lr
     JOIN users u ON u.id = lr.user_id
     LEFT JOIN stores s ON s.id = lr.store_id
     LEFT JOIN companies c ON c.id = lr.company_id
     LEFT JOIN LATERAL (
       SELECT la0.action, la0.created_at, u2.name as approver_name, u2.surname as approver_surname, u2.role as approver_role
       FROM leave_approvals la0
       LEFT JOIN users u2 ON u2.id = la0.approver_id
       WHERE la0.leave_request_id = lr.id
         AND la0.action IN ('approved', 'rejected')
       ORDER BY la0.created_at DESC
       LIMIT 1
     ) la ON TRUE
     WHERE ${scopeWhere}${extraWhere}
     ORDER BY lr.created_at DESC
     LIMIT $${allParams.length + 1} OFFSET $${allParams.length + 2}`,
    [...allParams, limit, offset],
  );

  ok(res, { requests, total, page, limit, pages: Math.ceil(total / limit) });
});

/**
 * Server-side store scoping for approve/reject. Returns an error message when the
 * caller is not allowed to act on a request from the given store, or null when
 * allowed. Store managers are limited to their own store; single-company area
 * managers to the stores they supervise; admin/HR/super-admin are unrestricted.
 */
async function ensureLeaveStoreScope(
  req: Request,
  role: string,
  isSuperAdmin: boolean,
  allowedCompanyIds: number[],
  requestStoreId: number | null,
): Promise<string | null> {
  if (isSuperAdmin || role === 'admin' || role === 'hr') return null;

  if (role === 'store_manager') {
    if (requestStoreId == null || requestStoreId !== req.user!.storeId) {
      return 'Questa richiesta non appartiene al tuo negozio';
    }
    return null;
  }

  if (role === 'area_manager') {
    if (allowedCompanyIds.length > 1) return null;   // group-wide by design
    if (requestStoreId == null) return null;          // company-level request
    const amStores = await query<{ store_id: number }>(
      `SELECT DISTINCT store_id FROM users
       WHERE role = 'store_manager' AND supervisor_id = $1
         AND company_id = $2 AND status = 'active' AND store_id IS NOT NULL`,
      [req.user!.userId, req.user!.companyId],
    );
    if (!amStores.some((s) => s.store_id === requestStoreId)) {
      return 'Questa richiesta non è tra i negozi che gestisci';
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// GET /api/leave/pending — approval queue for caller's role
// ---------------------------------------------------------------------------

export const getPendingApprovals = asyncHandler(async (req: Request, res: Response) => {
  // FIX 7: removed unused `companyId` from destructure
  const { role, storeId, userId } = req.user!;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const isSuperAdmin = req.user!.is_super_admin === true;

  // FIX 4
  if (LEAVE_BLOCKED_ROLES.has(role)) {
    forbidden(res, 'Accesso non consentito per questo ruolo');
    return;
  }

  let scopeWhere: string;
  let scopeParams: any[];

  if (isSuperAdmin) {
    scopeWhere = `lr.company_id = ANY($1) AND lr.status IN ('pending','store manager approved','area manager approved')`;
    scopeParams = [allowedCompanyIds];
  } else {
    switch (role) {
      case 'store_manager':
        scopeWhere = `lr.company_id = ANY($1) AND lr.current_approver_role = 'store_manager' AND lr.store_id = $2`;
        scopeParams = [allowedCompanyIds, storeId];
        break;
      case 'area_manager': {
        const hasCrossCompany = allowedCompanyIds.length > 1;

        if (hasCrossCompany) {
          // Cross-company area manager keeps group-wide visibility by design.
          scopeWhere = `lr.company_id = ANY($1) AND lr.current_approver_role = 'area_manager'`;
          scopeParams = [allowedCompanyIds];
        } else {
          // Single-company area manager: restrict to the stores they supervise
          // (plus company-level requests with no store), matching listLeaveRequests.
          const amStores = await query<{ store_id: number }>(
            `SELECT DISTINCT store_id FROM users
             WHERE role = 'store_manager' AND supervisor_id = $1
               AND company_id = $2 AND status = 'active' AND store_id IS NOT NULL`,
            [userId, req.user!.companyId],
          );
          const supervisedStoreIds = amStores.map((s) => s.store_id);
          if (supervisedStoreIds.length === 0) {
            scopeWhere = `lr.company_id = ANY($1) AND lr.current_approver_role = 'area_manager' AND lr.store_id IS NULL`;
            scopeParams = [allowedCompanyIds];
          } else {
            scopeWhere = `lr.company_id = ANY($1) AND lr.current_approver_role = 'area_manager' AND (lr.store_id = ANY($2::int[]) OR lr.store_id IS NULL)`;
            scopeParams = [allowedCompanyIds, supervisedStoreIds];
          }
        }
        break;
      }
      case 'hr':
      case 'admin':
      default:
        // Updated: allow HR/Admin to see pending requests across all allowed companies in group
        scopeWhere = `lr.company_id = ANY($1) AND lr.current_approver_role = $2`;
        scopeParams = [allowedCompanyIds, role];
        break;
    }
  }

  const requests = await query(
    `SELECT
       lr.id, lr.company_id, lr.user_id, lr.store_id, lr.leave_type,
       lr.start_date, lr.end_date,
       lr.is_archived,
       lr.leave_duration_type,
       TO_CHAR(lr.short_start_time, 'HH24:MI') AS short_start_time,
       TO_CHAR(lr.short_end_time, 'HH24:MI') AS short_end_time,
       lr.status, lr.current_approver_role,
       lr.notes, lr.created_at,
       lr.medical_certificate_name,
       lr.last_action_at,
       lr.skipped_approvers, lr.on_leave_skipped_approvers, lr.escalated, lr.is_emergency_override, lr.approved_by, lr.approved_at, lr.last_reminder_at,
       (
         SELECT array_agg(DISTINCT approver_role)
         FROM leave_approvals
         WHERE leave_request_id = lr.id AND action = 'approved'
       ) AS approved_by_roles,
        (
          SELECT json_agg(json_build_object(
            'role', la_inner.approver_role,
            'action', la_inner.action,
            'createdAt', la_inner.created_at,
            'notes', la_inner.notes,
            'approverName', u_inner.name,
            'approverSurname', u_inner.surname
          ) ORDER BY la_inner.created_at ASC)
          FROM leave_approvals la_inner
          LEFT JOIN users u_inner ON u_inner.id = la_inner.approver_id
          WHERE la_inner.leave_request_id = lr.id
        ) AS approvals_history,
       la.action AS latest_action,
       la.created_at AS latest_action_at,
       la.approver_name AS latest_action_by_name,
       la.approver_surname AS latest_action_by_surname,
       la.approver_role AS latest_action_by_role,
       u.name AS user_name, u.surname AS user_surname,
       u.role AS user_role,
       u.avatar_filename AS user_avatar_filename,
       s.name AS store_name,
       s.logo_filename AS store_logo_filename,
       c.name AS company_name
     FROM leave_requests lr
     JOIN users u ON u.id = lr.user_id
     LEFT JOIN stores s ON s.id = lr.store_id
     LEFT JOIN companies c ON c.id = lr.company_id
     LEFT JOIN LATERAL (
       SELECT la0.action, la0.created_at, u2.name as approver_name, u2.surname as approver_surname, u2.role as approver_role
       FROM leave_approvals la0
       LEFT JOIN users u2 ON u2.id = la0.approver_id
       WHERE la0.leave_request_id = lr.id
         AND la0.action IN ('approved', 'rejected')
       ORDER BY la0.created_at DESC
       LIMIT 1
     ) la ON TRUE
     WHERE ${scopeWhere} AND lr.is_archived = false
     ORDER BY lr.created_at ASC`,
    scopeParams,
  );

  const filteredRequests = [];
  for (const lr of requests) {
    const startStr = lr.start_date instanceof Date ? lr.start_date.toISOString().split('T')[0] : lr.start_date;
    const endStr = lr.end_date instanceof Date ? lr.end_date.toISOString().split('T')[0] : lr.end_date;
    const callerOnLeave = await isUserOnLeave(req.user!.userId, startStr, endStr);
    if (!callerOnLeave) {
      filteredRequests.push(lr);
    }
  }

  ok(res, { requests: filteredRequests, total: filteredRequests.length });
});

// ---------------------------------------------------------------------------
// PUT /api/leave/:id/approve — advance the approval chain
// ---------------------------------------------------------------------------

export const approveLeave = asyncHandler(async (req: Request, res: Response) => {
  const { role, userId } = req.user!;
  const effectiveRole = role;
  const isSuperAdmin = req.user!.is_super_admin === true;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  // FIX 4
  if (LEAVE_BLOCKED_ROLES.has(role)) {
    forbidden(res, 'Accesso non consentito per questo ruolo');
    return;
  }

  const leaveId = parseInt(req.params.id, 10);
  if (isNaN(leaveId)) { notFound(res, 'Richiesta non trovata'); return; }

  const { notes, emergency_override, cancel_shifts } = req.body as { notes?: string, emergency_override?: boolean, cancel_shifts?: boolean };

  const leaveRequest = await queryOne<{
    id: number;
    company_id: number;
    user_id: number;
    status: string;
    current_approver_role: string;
    leave_type: LeaveType;
    start_date: string;
    end_date: string;
    leave_duration_type: LeaveDurationType | null;
    short_start_time: string | null;
    short_end_time: string | null;
    store_id: number | null;
    skipped_approvers: string[] | null;
    on_leave_skipped_approvers: string[] | null;
    /** NULL on a terminal status means nobody actually decided — see below. */
    approved_by: number | null;
  }>(
    `SELECT id, company_id, user_id, status, current_approver_role,
            leave_type, start_date, end_date,
            leave_duration_type,
            TO_CHAR(short_start_time, 'HH24:MI') AS short_start_time,
            TO_CHAR(short_end_time, 'HH24:MI') AS short_end_time,
            store_id, skipped_approvers, on_leave_skipped_approvers,
            approved_by
     FROM leave_requests WHERE id = $1 AND company_id = ANY($2)`,
    [leaveId, allowedCompanyIds],
  );

  if (!leaveRequest) {
    notFound(res, 'Richiesta di permesso non trovata');
    return;
  }

  if (leaveRequest.status === 'rejected' || leaveRequest.status === 'admin_approved') {
    // "Not allowed in the current state" told the approver nothing. The two
    // cases behind it are very different, and one of them is fixable from here.
    const autoApprovedWithNobody =
      leaveRequest.status === 'admin_approved' && leaveRequest.approved_by == null;

    res.status(400).json({
      success: false,
      error: autoApprovedWithNobody
        ? 'Questa richiesta risulta già approvata, ma da nessuna persona: è stata approvata automaticamente per inattività. Non può essere approvata di nuovo. Usa "Riapri" per rimandarla a HR per una decisione reale.'
        : leaveRequest.status === 'rejected'
          ? 'Questa richiesta è già stata rifiutata e non può essere approvata.'
          : 'Questa richiesta è già stata approvata definitivamente.',
      code: autoApprovedWithNobody ? 'NEEDS_REOPEN' : 'INVALID_STATE',
      details: { status: leaveRequest.status, canReopen: autoApprovedWithNobody },
    });
    return;
  }

  const stageRole = leaveRequest.current_approver_role;
  const isOverride = (role === 'admin' || role === 'hr') && (emergency_override === true);

  if (!isSuperAdmin && !isOverride && role !== 'admin' && stageRole !== effectiveRole) {
    // Naming the current approver turns a dead end into something actionable:
    // the reader knows who to chase instead of just being refused.
    res.status(403).json({
      success: false,
      error: `Questa richiesta è in attesa di ${stageRole ?? 'un altro livello'}, non del tuo ruolo (${effectiveRole}). Potrai intervenire quando arriverà al tuo livello.`,
      code: 'LEAVE_NOT_RESPONSIBLE',
      details: { yourRole: effectiveRole, waitingOn: stageRole },
    });
    return;
  }

  // Store scoping (server-side): a store manager may only act on requests from
  // their own store; an area manager only on stores they supervise. Admin/HR and
  // super admins are unrestricted. Requests with no store (company-level) are
  // left to the higher roles.
  const storeScopeError = await ensureLeaveStoreScope(req, role, isSuperAdmin, allowedCompanyIds, leaveRequest.store_id);
  if (storeScopeError) { forbidden(res, storeScopeError, 'LEAVE_WRONG_STORE'); return; }

  // Re-check overlap against ALREADY-APPROVED leaves (excluding this request) so
  // that two overlapping requests cannot both reach approval — which would
  // deduct the balance twice for the same days.
  const approvedOverlap = await queryOne<{ id: number }>(
    `SELECT id FROM leave_requests
     WHERE company_id = $1 AND user_id = $2 AND id <> $3
       AND status IN ('approved', 'admin_approved')
       AND start_date <= $4 AND end_date >= $5`,
    [leaveRequest.company_id, leaveRequest.user_id, leaveRequest.id, leaveRequest.end_date, leaveRequest.start_date],
  );
  if (approvedOverlap) {
    badRequest(res, 'Un altro permesso approvato si sovrappone a queste date', 'LEAVE_OVERLAP');
    return;
  }

  // Load the dynamic approval chain and build transitions for this company
  const approvalChain = await getApprovalChain(leaveRequest.company_id);
  const TRANSITIONS = buildTransitions(approvalChain);

  // Which step of the chain this approval counts as.
  //
  // An admin or super admin used to be forced onto the 'admin' step. Most
  // companies configure the chain as store_manager -> area_manager -> hr, with
  // no admin step at all, so that lookup found nothing and every admin was told
  // "Ruolo non autorizzato ad approvare" — they could not approve anything.
  // An admin stepping in acts AT THE REQUEST'S CURRENT STAGE unless the chain
  // actually has an admin step for them to occupy.
  const adminLike = role === 'admin' || isSuperAdmin;
  let transitionKey: string;
  if (isOverride) {
    transitionKey = (role === 'admin' ? 'admin' : 'hr_override');
  } else if (adminLike) {
    transitionKey = approvalChain.includes('admin') ? 'admin' : stageRole;
  } else {
    transitionKey = effectiveRole;
  }

  /**
   * HR and Admin approvals are always FINAL.
   *
   * HR approval is the point at which leave becomes real and the balance is
   * deducted, so it terminates the chain even when an admin step follows it —
   * an admin step is an optional extra sign-off, not a requirement. An admin
   * (or super admin) approving at any stage short-circuits the rest of the
   * chain for the same reason.
   *
   * Previously both depended on where the role happened to sit in the chain:
   * HR on a `... -> hr -> admin` chain merely handed the request on without
   * deducting anything, and an admin approving early on a chain with no admin
   * step only advanced it one place. Both left leave granted-looking with the
   * balance untouched.
   */
  const finalisesImmediately = adminLike || effectiveRole === 'hr';

  const getTransition = (key: string) => {
    if (key === 'hr_override') return { nextStatus: 'admin_approved', nextApprover: null };
    if (finalisesImmediately) {
      return {
        nextStatus: adminLike ? 'approved' : 'HR approved',
        nextApprover: null,
      };
    }
    return TRANSITIONS[key];
  };

  const transition = getTransition(transitionKey);
  if (!transition) {
    // Say which step is missing and what the chain actually is — "not
    // authorised" alone gave the approver nothing to act on.
    res.status(403).json({
      success: false,
      error: `Il tuo ruolo (${effectiveRole}) non è un passaggio della catena di approvazione di questa azienda (${approvalChain.join(' → ')}). La richiesta è attualmente assegnata a: ${stageRole ?? '—'}.`,
      code: 'ROLE_NOT_IN_CHAIN',
      details: { role: effectiveRole, stage: stageRole, chain: approvalChain },
    });
    return;
  }

  // ── Balance must exist before HR or Admin can approve ─────────────────────
  // Approval used to silently create a 25/10-day allocation from a hardcoded
  // default, so leave was granted against days nobody had actually assigned.
  // HR and Admin are the levels that make the leave real, so they cannot
  // approve until somebody has configured the employee's entitlement. Lower
  // levels are deliberately unaffected: passing a request up the chain does not
  // require the balance to exist yet.
  const approverIsHrOrAdmin =
    MANUAL_ONLY_APPROVER_ROLES.has(effectiveRole) || isSuperAdmin || isOverride;
  if (approverIsHrOrAdmin) {
    const balanceYear = yearFromIsoDate(leaveRequest.start_date);
    const configured = await queryOne<{ id: number }>(
      `SELECT id FROM leave_balances
        WHERE company_id = $1 AND user_id = $2 AND year = $3 AND leave_type = $4`,
      [leaveRequest.company_id, leaveRequest.user_id, balanceYear, leaveRequest.leave_type],
    );
    if (!configured) {
      res.status(422).json({
        success: false,
        error: `Saldo non configurato per questo dipendente (${leaveRequest.leave_type === 'vacation' ? 'ferie' : 'malattia'} ${balanceYear}). Configura prima i giorni disponibili, poi approva la richiesta.`,
        code: 'BALANCE_NOT_CONFIGURED',
        details: { user_id: leaveRequest.user_id, year: balanceYear, leave_type: leaveRequest.leave_type },
      });
      return;
    }
  }

  // Final step: update balance only when fully approved
  if (!transition.nextApprover) {
    const requestedDays = computeRequestedLeaveDays(leaveRequest);
    const year = yearFromIsoDate(leaveRequest.start_date);
    const defaultTotal = leaveRequest.leave_type === 'vacation' ? 25 : 10;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // No silent default allocation any more. Inventing 25/10 days meant leave
      // was granted against an entitlement nobody had set; the guard above
      // requires HR/Admin to configure it first. The lock is taken on the row
      // that must already exist.
      const balanceResult = await client.query(
        `SELECT total_days FROM leave_balances
         WHERE company_id=$1 AND user_id=$2 AND year=$3 AND leave_type=$4
         FOR UPDATE`,
        [leaveRequest.company_id, leaveRequest.user_id, year, leaveRequest.leave_type],
      );
      const balance = balanceResult.rows[0];
      if (!balance) {
        await client.query('ROLLBACK');
        res.status(422).json({
          success: false,
          error: `Saldo non configurato per questo dipendente (${leaveRequest.leave_type === 'vacation' ? 'ferie' : 'malattia'} ${year}). Configura prima i giorni disponibili, poi approva la richiesta.`,
          code: 'BALANCE_NOT_CONFIGURED',
          details: { user_id: leaveRequest.user_id, year, leave_type: leaveRequest.leave_type },
        });
        return;
      }
      const totalDays = parseFloat(balance.total_days);

      // Dynamically calculate used days from already approved requests
      const usedRes = await client.query(
        `SELECT start_date::text as start_date, end_date::text as end_date, 
                leave_duration_type, 
                TO_CHAR(short_start_time, 'HH24:MI') as short_start_time, 
                TO_CHAR(short_end_time, 'HH24:MI') as short_end_time
         FROM leave_requests
         WHERE user_id = $1 AND leave_type = $2 AND status IN ('approved', 'admin_approved')
           AND EXTRACT(YEAR FROM start_date) = $3`,
        [leaveRequest.user_id, leaveRequest.leave_type, year]
      );
      let currentUsed = 0;
      for (const r of usedRes.rows) {
        currentUsed += computeRequestedLeaveDays({
          start_date: r.start_date,
          end_date: r.end_date,
          leave_duration_type: r.leave_duration_type,
          short_start_time: r.short_start_time,
          short_end_time: r.short_end_time
        });
      }

      if (currentUsed + requestedDays > totalDays) {
        await client.query('ROLLBACK');
        res.status(422).json({
          success: false,
          error: `Saldo insufficiente: rimangono ${Number((totalDays - currentUsed).toFixed(2))} giorni, richiesti ${requestedDays}`,
          code: 'INSUFFICIENT_BALANCE',
        });
        return;
      }

      const updated = await client.query(
        `UPDATE leave_requests
         SET status=$1, current_approver_role=$2, updated_at=NOW(), last_action_at=NOW(), is_emergency_override=$3,
             approved_by=$5, approved_at=NOW()
         WHERE id=$4
         RETURNING id, company_id, user_id, store_id, leave_type, start_date, end_date,
                   leave_duration_type,
                   TO_CHAR(short_start_time, 'HH24:MI') AS short_start_time,
                   TO_CHAR(short_end_time, 'HH24:MI') AS short_end_time,
                   status, current_approver_role, notes, created_at, updated_at`,
        [transition.nextStatus, transition.nextApprover, isOverride, leaveId, userId],
      );

      await client.query(
        `INSERT INTO leave_approvals (leave_request_id, approver_id, approver_role, action, notes)
         VALUES ($1,$2,$3,'approved',$4)`,
        [leaveId, userId, isOverride ? role : transitionKey, notes ?? (isOverride ? 'Emergency Override' : null)],
      );

      const balanceUpdate = await client.query(
        `UPDATE leave_balances
         SET used_days = used_days + $1, updated_at = NOW()
         WHERE company_id=$2 AND user_id=$3 AND year=$4 AND leave_type=$5`,
        [requestedDays, leaveRequest.company_id, leaveRequest.user_id, year, leaveRequest.leave_type],
      );
      if (balanceUpdate.rowCount === 0) {
        // The row was locked FOR UPDATE a few statements ago, so zero rows here
        // means it vanished mid-transaction. Creating one with an invented
        // total is exactly what let leave be granted against days nobody
        // allocated, so fail loudly instead.
        await client.query('ROLLBACK');
        res.status(422).json({
          success: false,
          error: 'Saldo non configurato per questo dipendente. Configura prima i giorni disponibili, poi approva la richiesta.',
          code: 'BALANCE_NOT_CONFIGURED',
          details: { user_id: leaveRequest.user_id, year, leave_type: leaveRequest.leave_type },
        });
        return;
      }

      // Cancel shifts if requested
      if (cancel_shifts) {
        await client.query(
          `UPDATE shifts
           SET status = 'cancelled', updated_at = NOW()
           WHERE user_id = $1
             AND date >= $2::DATE
             AND date <= $3::DATE
             AND status IN ('scheduled', 'confirmed')`,
          [leaveRequest.user_id, leaveRequest.start_date, leaveRequest.end_date],
        );
      }

      await client.query('COMMIT');

      // Send notification for leave approval
      void sendNotification({
        companyId: leaveRequest.company_id,
        userId: leaveRequest.user_id,
        type: 'leave.approved',
        title: 'Richiesta di permesso approvata',
        message: `La tua richiesta di ${leaveRequest.leave_type === 'vacation' ? 'ferie' : 'malattia'} dal ${leaveRequest.start_date} al ${leaveRequest.end_date} è stata approvata.`,
        priority: 'high',
      }).catch(() => undefined);

      // Trigger Leave Result Email Automation (Background task)
      sendLeaveResultAutomation(
        leaveRequest.company_id,
        leaveId,
        'approved',
        userId
      ).catch(err => console.error('[AUTOMATION] Background leave approval email error:', err));

      ok(res, updated.rows[0], 'Richiesta approvata');
    } catch (err: any) {
      await client.query('ROLLBACK');
      // FIX 10: convert DB check-constraint violation to a clean 422
      if (err?.code === '23514') {
        res.status(422).json({
          success: false,
          error: 'Aggiornamento del saldo non consentito dal database',
          code: 'BALANCE_CONSTRAINT_VIOLATION',
        });
        return;
      }
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  // Non-final approval
  const { approver: nextActiveRole, skipped: additionalSkipped } = await findNextActiveApprover(
    leaveRequest.company_id,
    leaveRequest.store_id,
    leaveRequest.start_date,
    leaveRequest.end_date,
    leaveRequest.user_id,
    transition.nextApprover,
    approvalChain
  );

  const finalNextRole = nextActiveRole;
  const finalNextStatus = transition.nextStatus;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const currentSkipped = Array.isArray(leaveRequest.skipped_approvers) ? leaveRequest.skipped_approvers : [];
    const updatedSkipped = Array.from(new Set([...currentSkipped, ...additionalSkipped]));

    const currentOnLeaveSkipped = Array.isArray(leaveRequest.on_leave_skipped_approvers) ? leaveRequest.on_leave_skipped_approvers : [];
    const realAdditionalSkipped = additionalSkipped.filter(r => approvalChain.includes(r));
    const updatedOnLeaveSkipped = Array.from(new Set([...currentOnLeaveSkipped, ...realAdditionalSkipped]));

    const updatedResult = await client.query(
      `UPDATE leave_requests
       SET status=$1, current_approver_role=$2, updated_at=NOW(), last_action_at=NOW(),
           skipped_approvers=$3, on_leave_skipped_approvers=$4
       WHERE id=$5
       RETURNING id, company_id, user_id, store_id, leave_type, start_date, end_date,
                 leave_duration_type,
                 TO_CHAR(short_start_time, 'HH24:MI') AS short_start_time,
                 TO_CHAR(short_end_time, 'HH24:MI') AS short_end_time,
                 status, current_approver_role, notes, created_at, updated_at,
                 skipped_approvers, on_leave_skipped_approvers`,
      [finalNextStatus, finalNextRole, JSON.stringify(updatedSkipped), JSON.stringify(updatedOnLeaveSkipped), leaveId],
    );

    await client.query(
      `INSERT INTO leave_approvals (leave_request_id, approver_id, approver_role, action, notes)
       VALUES ($1,$2,$3,'approved',$4)`,
      [leaveId, userId, transitionKey, notes ?? null],
    );

    await client.query('COMMIT');
    ok(res, updatedResult.rows[0], 'Richiesta approvata');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// PUT /api/leave/:id/reject — reject at any approval stage
// ---------------------------------------------------------------------------

export const rejectLeave = asyncHandler(async (req: Request, res: Response) => {
  const { role, userId } = req.user!;
  const effectiveRole = role;
  const isSuperAdmin = req.user!.is_super_admin === true;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  // FIX 4
  if (LEAVE_BLOCKED_ROLES.has(role)) {
    forbidden(res, 'Accesso non consentito per questo ruolo');
    return;
  }

  const leaveId = parseInt(req.params.id, 10);
  if (isNaN(leaveId)) { notFound(res, 'Richiesta non trovata'); return; }

  // FIX 5: notes is optional — a manager may reject without a written reason
  const { notes, emergency_override } = req.body as { notes?: string, emergency_override?: boolean };

  const leaveRequest = await queryOne<{
    id: number;
    company_id: number;
    user_id: number;
    start_date: string;
    end_date: string;
    current_approver_role: string;
    status: string;
    store_id: number | null;
  }>(
    `SELECT id, company_id, user_id, start_date, end_date, current_approver_role, status, store_id
     FROM leave_requests WHERE id = $1 AND company_id = ANY($2)`,
    [leaveId, allowedCompanyIds],
  );

  if (!leaveRequest) {
    notFound(res, 'Richiesta di permesso non trovata');
    return;
  }

  if (leaveRequest.status === 'rejected' || leaveRequest.status === 'admin_approved') {
    badRequest(res, 'Impossibile rifiutare una richiesta già finalizzata', 'INVALID_STATE');
    return;
  }

  const stageRole = leaveRequest.current_approver_role;
  const isOverride = (role === 'admin' || role === 'hr') && (emergency_override === true);
  if (!isSuperAdmin && !isOverride && role !== 'admin' && stageRole !== effectiveRole) {
    // Naming the current approver turns a dead end into something actionable:
    // the reader knows who to chase instead of just being refused.
    res.status(403).json({
      success: false,
      error: `Questa richiesta è in attesa di ${stageRole ?? 'un altro livello'}, non del tuo ruolo (${effectiveRole}). Potrai intervenire quando arriverà al tuo livello.`,
      code: 'LEAVE_NOT_RESPONSIBLE',
      details: { yourRole: effectiveRole, waitingOn: stageRole },
    });
    return;
  }

  // Store scoping (server-side): mirror approveLeave — a store/area manager may
  // only reject requests within their own store / supervised stores.
  const storeScopeError = await ensureLeaveStoreScope(req, role, isSuperAdmin, allowedCompanyIds, leaveRequest.store_id);
  if (storeScopeError) { forbidden(res, storeScopeError, 'LEAVE_WRONG_STORE'); return; }

  // If HR/Admin use emergency override OR are normal Admin, prioritize terminal transition
  let approverRoleForRecord = isSuperAdmin ? stageRole : effectiveRole;
  if (isOverride) {
    approverRoleForRecord = role;
  } else if (role === 'admin') {
    approverRoleForRecord = 'admin';
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updatedResult = await client.query(
      `UPDATE leave_requests
       SET status='rejected', current_approver_role=NULL, updated_at=NOW(), last_action_at=NOW(), is_emergency_override=$1
       WHERE id=$2
       RETURNING id, company_id, user_id, store_id, leave_type, start_date, end_date,
                 leave_duration_type,
                 TO_CHAR(short_start_time, 'HH24:MI') AS short_start_time,
                 TO_CHAR(short_end_time, 'HH24:MI') AS short_end_time,
                 status, current_approver_role, notes, created_at, updated_at`,
      [isOverride, leaveId],
    );

    await client.query(
      `INSERT INTO leave_approvals (leave_request_id, approver_id, approver_role, action, notes)
       VALUES ($1,$2,$3,'rejected',$4)`,
      [leaveId, userId, approverRoleForRecord, notes ?? (isOverride ? 'Emergency Override' : null)],
    );

    await client.query('COMMIT');

    // Send notification for leave rejection
    void sendNotification({
      companyId: leaveRequest.company_id,
      userId: leaveRequest.user_id,
      type: 'leave.rejected',
      title: 'Richiesta di permesso rifiutata',
      message: `La tua richiesta di permesso dal ${leaveRequest.start_date} al ${leaveRequest.end_date} è stata rifiutata.`,
      priority: 'high',
    }).catch(() => undefined);

    // Trigger Leave Result Email Automation (Background task)
    sendLeaveResultAutomation(
      leaveRequest.company_id,
      leaveId,
      'rejected',
      userId
    ).catch(err => console.error('[AUTOMATION] Background leave rejection email error:', err));

    ok(res, updatedResult.rows[0], 'Richiesta rifiutata');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// PUT /api/leave/:id/cancel — employee retracts their own pending request
// ---------------------------------------------------------------------------
// PUT /api/leave/:id/reopen — send an unverified approval back for a real decision
//
// The escalation defect left requests sitting in a terminal approved status
// with approved_by NULL: granted, but by nobody. Those cannot be approved again
// (they are already terminal) and must not simply be re-approved on the spot —
// the point is that a person never decided. This hands the request back to HR,
// which is the level where leave becomes real and the balance is deducted.
//
// The per-request equivalent of scripts/repairLeaveEscalations.ts, for fixing
// them one at a time from the UI.
// ---------------------------------------------------------------------------
export const reopenLeave = asyncHandler(async (req: Request, res: Response) => {
  const { role, userId } = req.user!;
  const isSuperAdmin = req.user!.is_super_admin === true;

  if (!(role === 'admin' || isSuperAdmin)) {
    forbidden(res, 'Solo un amministratore può riaprire una richiesta approvata automaticamente', 'REOPEN_ADMIN_ONLY');
    return;
  }

  const leaveId = parseInt(req.params.id, 10);
  if (isNaN(leaveId)) { notFound(res, 'Richiesta non trovata'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const lr = await queryOne<{
    id: number; company_id: number; user_id: number; status: string;
    current_approver_role: string | null; approved_by: number | null;
    leave_type: LeaveType; start_date: string; end_date: string;
    leave_duration_type: LeaveDurationType | null;
    short_start_time: string | null; short_end_time: string | null;
  }>(
    `SELECT id, company_id, user_id, status, current_approver_role, approved_by,
            leave_type, start_date, end_date, leave_duration_type,
            TO_CHAR(short_start_time, 'HH24:MI') AS short_start_time,
            TO_CHAR(short_end_time,   'HH24:MI') AS short_end_time
       FROM leave_requests WHERE id = $1 AND company_id = ANY($2)`,
    [leaveId, allowedCompanyIds],
  );
  if (!lr) { notFound(res, 'Richiesta di permesso non trovata'); return; }

  if (lr.status === 'rejected' || lr.status === 'cancelled') {
    badRequest(res, 'Una richiesta rifiutata o annullata non può essere riaperta.', 'REOPEN_INVALID_STATE');
    return;
  }

  const chain = await getApprovalChain(lr.company_id);
  // Back to the beginning: the decision is being undone, so the request starts
  // the chain again rather than resuming halfway through it.
  const firstApprover = chain[0] ?? 'hr';

  // Days are only given back when they were actually taken away. A request that
  // was auto-approved with nobody behind it never had its balance deducted, so
  // restoring here would credit days that were never spent.
  const wasDeducted = lr.approved_by !== null;
  const requestedDays = computeRequestedLeaveDays(lr as any);
  const year = yearFromIsoDate(lr.start_date);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (wasDeducted && requestedDays > 0) {
      await client.query(
        `UPDATE leave_balances
            SET used_days = GREATEST(0, used_days - $5), updated_at = NOW()
          WHERE company_id = $1 AND user_id = $2 AND year = $3 AND leave_type = $4`,
        [lr.company_id, lr.user_id, year, lr.leave_type, requestedDays],
      );
    }

    await client.query(
      `UPDATE leave_requests
          SET status = 'pending', current_approver_role = $1,
              approved_by = NULL, approved_at = NULL,
              escalated = FALSE, last_action_at = NOW(), last_reminder_at = NULL,
              updated_at = NOW()
        WHERE id = $2`,
      [firstApprover, leaveId],
    );

    await client.query(
      `INSERT INTO leave_approvals (leave_request_id, approver_id, approver_role, action, notes)
       VALUES ($1, $2, $3, 'escalated', $4)`,
      [
        leaveId, userId, role,
        wasDeducted
          ? `Riaperta da un amministratore: approvazione annullata, ${requestedDays} giorni riaccreditati sul saldo. Torna in attesa di ${firstApprover}.`
          : `Riaperta da un amministratore: era stata approvata automaticamente per inattività, senza alcuna decisione umana e senza scarico del saldo. Torna in attesa di ${firstApprover}.`,
      ],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  ok(
    res,
    { id: leaveId, status: 'pending', current_approver_role: firstApprover, restored_days: wasDeducted ? requestedDays : 0 },
    wasDeducted
      ? `Richiesta riaperta: ${requestedDays} giorni riaccreditati`
      : 'Richiesta riaperta per una decisione umana',
  );
});

// ---------------------------------------------------------------------------

export const cancelLeave = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.user!;
  const leaveId = parseInt(req.params.id, 10);
  if (isNaN(leaveId)) { notFound(res, 'Richiesta non trovata'); return; }

  const leaveRequest = await queryOne<{ id: number; user_id: number; status: string }>(
    `SELECT id, user_id, status FROM leave_requests WHERE id = $1`,
    [leaveId]
  );

  if (!leaveRequest) {
    notFound(res, 'Richiesta non trovata');
    return;
  }

  if (leaveRequest.user_id !== userId) {
    forbidden(res, 'Non puoi cancellare la richiesta di un altro dipendente');
    return;
  }

  if (leaveRequest.status !== 'pending') {
    badRequest(res, 'Puoi cancellare solo le richieste in stato "pending"', 'ONLY_PENDING_CANCELLABLE');
    return;
  }

  const result = await queryOne(
    `UPDATE leave_requests SET status = 'cancelled', current_approver_role = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING id, status, updated_at`,
    [leaveId]
  );

  ok(res, result, 'Richiesta cancellata con successo');
});

// ---------------------------------------------------------------------------
// GET /api/leave/balance — leave balance for a user
// ---------------------------------------------------------------------------

export const getBalance = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, role, userId, is_super_admin } = req.user!;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const { year, user_id } = req.query as Record<string, string>;
  const isSuperAdmin = is_super_admin === true;

  // FIX 4
  if (LEAVE_BLOCKED_ROLES.has(role)) {
    forbidden(res, 'Accesso non consentito per questo ruolo');
    return;
  }

  // Check company setting: employees cannot see balance if disabled
  if (role === 'employee' || role === 'store_manager' || role === 'area_manager') {
    const setting = await queryOne<{ show_leave_balance_to_employee: boolean }>(
      `SELECT show_leave_balance_to_employee FROM companies WHERE id = $1`,
      [companyId],
    );
    if (setting && setting.show_leave_balance_to_employee === false) {
      ok(res, {
        balances: [],
        year: year ? parseInt(year, 10) : currentYearInDefaultLeaveTimezone(),
        user_id: userId,
        balance_visible: false,
      });
      return;
    }
  }

  let targetUserId: number;

  if (role === 'employee' || role === 'store_manager') {
    targetUserId = user_id ? parseInt(user_id, 10) : userId;
    if (user_id && targetUserId !== userId) {
      // Employees/Store Managers can only see their own balance
      forbidden(res, 'Non sei autorizzato a vedere il saldo di altri dipendenti');
      return;
    }
  } else if (role === 'area_manager' && user_id && !isSuperAdmin) {
    const requestedId = parseInt(user_id, 10);
    if (isNaN(requestedId) || requestedId < 1) {
      badRequest(res, 'user_id non valido', 'VALIDATION_ERROR'); return;
    }
    
    const hasCrossCompany = allowedCompanyIds.length > 1;
    let allowed: { id: number } | null;

    if (hasCrossCompany) {
      // If cross-company is ON, check if target is lower in rank across group
      allowed = await queryOne<{ id: number }>(
        `SELECT u.id FROM users u
         WHERE u.id = $1 AND u.company_id = ANY($2)
           AND ${TARGET_RANK_SQL} < ${getRoleRank('area_manager')}`,
        [requestedId, allowedCompanyIds],
      );
    } else {
      allowed = await queryOne<{ id: number }>(
        `SELECT u.id FROM users u
         WHERE u.id = $1 AND u.company_id = ANY($2)
           AND (
             u.store_id IN (
               SELECT DISTINCT store_id FROM users
               WHERE role = 'store_manager' AND supervisor_id = $3
                 AND company_id = ANY($2) AND status = 'active' AND store_id IS NOT NULL
             )
             OR u.supervisor_id = $3 -- Direct subordinates (Store Managers)
           )`,
        [requestedId, allowedCompanyIds, userId],
      );
    }

    if (!allowed) {
      forbidden(res, 'Accesso negato a questo dipendente'); return;
    }
    targetUserId = requestedId;
  } else {
    const requestedId = user_id ? parseInt(user_id, 10) : userId;
    if (user_id && (isNaN(requestedId) || requestedId < 1)) {
      badRequest(res, 'user_id non valido', 'VALIDATION_ERROR'); return;
    }
    targetUserId = requestedId;
  }

  const targetYear = year ? parseInt(year, 10) : currentYearInDefaultLeaveTimezone();

  const effectiveCompanyRow = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM users
     WHERE id = $1 AND status = 'active' AND company_id = ANY($2)`,
    [targetUserId, allowedCompanyIds],
  );
  if (!effectiveCompanyRow) {
    notFound(res, 'Dipendente non trovato');
    return;
  }

  const balances = await query(
    `SELECT lb.id, lb.company_id, lb.user_id, lb.year, lb.leave_type,
            lb.total_days, lb.updated_at
     FROM leave_balances lb
     WHERE lb.company_id = $1 AND lb.user_id = $2 AND lb.year = $3
     ORDER BY lb.leave_type`,
    [effectiveCompanyRow.company_id, targetUserId, targetYear],
  );

  const enrichedBalances = await Promise.all(balances.map(async (b: any) => {
    const usedDays = await getUserUsedDays(b.user_id, b.year, b.leave_type);
    return {
      ...b,
      used_days: usedDays,
      remaining_days: Number((parseFloat(b.total_days) - usedDays).toFixed(2)),
    };
  }));

  ok(res, { balances: enrichedBalances, year: targetYear, user_id: targetUserId, balance_visible: true });
});

// ---------------------------------------------------------------------------
// GET /api/leave/balances — every balance in scope, in one query
//
// The admin leave panel used to call GET /balance once per employee, which is
// why it capped itself at 50 people: 50 parallel HTTP requests was already the
// practical ceiling. Lifting that cap without this endpoint would just turn the
// display bug into a performance one.
// ---------------------------------------------------------------------------
export const listBalances = asyncHandler(async (req: Request, res: Response) => {
  const { role } = req.user!;

  if (LEAVE_BLOCKED_ROLES.has(role)) {
    forbidden(res, 'Accesso non consentito per questo ruolo');
    return;
  }
  if (!['admin', 'hr', 'system_admin'].includes(role) && req.user!.is_super_admin !== true) {
    forbidden(res, 'Solo admin e HR possono consultare i saldi di tutti i dipendenti');
    return;
  }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const { year, company_id, store_id } = req.query as Record<string, string>;

  const targetYear = year ? parseInt(year, 10) : currentYearInDefaultLeaveTimezone();
  if (Number.isNaN(targetYear)) {
    badRequest(res, 'Anno non valido', 'VALIDATION_ERROR');
    return;
  }

  // A company filter narrows the scope; without one a super admin legitimately
  // sees every company they can access.
  let companyIds = allowedCompanyIds;
  if (company_id) {
    const requested = parseInt(company_id, 10);
    if (Number.isNaN(requested) || !allowedCompanyIds.includes(requested)) {
      forbidden(res, 'Non hai accesso a questa azienda');
      return;
    }
    companyIds = [requested];
  }

  const params: (number[] | number | string)[] = [companyIds, targetYear];
  let storeClause = '';
  if (store_id) {
    const requestedStore = parseInt(store_id, 10);
    if (Number.isNaN(requestedStore)) {
      badRequest(res, 'store_id non valido', 'VALIDATION_ERROR');
      return;
    }
    params.push(requestedStore);
    storeClause = ` AND u.store_id = $${params.length}`;
  }

  // One row per (employee, leave_type). used_days is derived from the approved
  // requests themselves — the same rule getUserUsedDays applies per user — so
  // the panel and the single-user endpoint cannot disagree.
  const rows = await query<{
    user_id: number;
    company_id: number;
    leave_type: string;
    total_days: string;
    used_days: string;
    updated_at: string | null;
  }>(
    `SELECT lb.user_id, lb.company_id, lb.leave_type,
            lb.total_days,
            COALESCE(used.days, 0)::numeric AS used_days,
            lb.updated_at
       FROM leave_balances lb
       JOIN users u ON u.id = lb.user_id AND u.status = 'active'
       LEFT JOIN LATERAL (
         SELECT SUM(
                  CASE
                    WHEN lr.leave_duration_type = 'short_leave' THEN 0.5
                    ELSE (lr.end_date - lr.start_date + 1)
                  END
                ) AS days
           FROM leave_requests lr
          WHERE lr.user_id = lb.user_id
            AND lr.leave_type = lb.leave_type
            AND lr.status IN ('approved', 'admin_approved')
            AND EXTRACT(YEAR FROM lr.start_date) = lb.year
       ) used ON TRUE
      WHERE lb.company_id = ANY($1::int[])
        AND lb.year = $2
        ${storeClause}
      ORDER BY lb.user_id, lb.leave_type`,
    params,
  );

  const byUser: Record<number, Array<Record<string, unknown>>> = {};
  for (const r of rows) {
    const total = parseFloat(r.total_days);
    const used = parseFloat(r.used_days);
    (byUser[r.user_id] ||= []).push({
      user_id: r.user_id,
      company_id: r.company_id,
      year: targetYear,
      leave_type: r.leave_type,
      total_days: r.total_days,
      used_days: used,
      remaining_days: Number((total - used).toFixed(2)),
      updated_at: r.updated_at,
    });
  }

  ok(res, { year: targetYear, balances: byUser });
});

// ---------------------------------------------------------------------------
// POST /api/leave/admin — admin/hr creates leave on behalf of an employee
// Auto-approved (hr_approved), balance deducted atomically
// ---------------------------------------------------------------------------

export const createLeaveAdmin = asyncHandler(async (req: Request, res: Response) => {
  const { userId: adminId } = req.user!;
  const { user_id, leave_type, start_date, end_date, leave_duration_type, short_start_time, short_end_time, notes } = req.body as {
    user_id: number;
    leave_type: LeaveType;
    start_date: string;
    end_date: string;
    leave_duration_type?: LeaveDurationType;
    short_start_time?: string;
    short_end_time?: string;
    notes?: string;
  };

  // FIX 2: validate leave_type
  if (!VALID_LEAVE_TYPES.includes(leave_type)) {
    badRequest(res, 'Tipo di permesso non valido (vacation | sick)', 'INVALID_LEAVE_TYPE');
    return;
  }

  if (!ISO_DATE_RE.test(start_date) || !ISO_DATE_RE.test(end_date)) {
    badRequest(res, 'Formato data non valido (YYYY-MM-DD)', 'INVALID_DATE_FORMAT');
    return;
  }
  if (start_date > end_date) {
    badRequest(res, 'La data di inizio non può essere successiva alla data di fine', 'INVALID_DATE_RANGE');
    return;
  }

  const normalizedDuration = normalizeLeaveDurationInput({
    leaveType: leave_type,
    startDate: start_date,
    endDate: end_date,
    leaveDurationType: leave_duration_type,
    shortStartTime: short_start_time,
    shortEndTime: short_end_time,
  });
  if ('error' in normalizedDuration) {
    badRequest(res, normalizedDuration.error, normalizedDuration.code);
    return;
  }

  const { leaveDurationType, shortStartTime, shortEndTime, requestedDays } = normalizedDuration;

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  const targetUser = await queryOne<{ id: number; store_id: number | null; company_id: number }>(
    `SELECT id, store_id, company_id FROM users
     WHERE id = $1 AND status = 'active' AND company_id = ANY($2)`,
    [user_id, allowedCompanyIds],
  );
  if (!targetUser) {
    badRequest(res, 'Dipendente non trovato in questa azienda', 'NOT_FOUND');
    return;
  }

  const effectiveCompanyId = targetUser.company_id;

  // Overlap check — ONLY FOR THE SAME USER (target user_id = $2)
  const overlap = await queryOne<{ id: number }>(
    `SELECT id FROM leave_requests
     WHERE company_id = $1 AND user_id = $2
       AND status IN ('approved', 'admin_approved')
       AND start_date <= $3 AND end_date >= $4`,
    [effectiveCompanyId, user_id, end_date, start_date],
  );
  if (overlap) {
    badRequest(res, 'Il dipendente ha già un permesso approvato che si sovrappone a queste date', 'LEAVE_OVERLAP');
    return;
  }

  const year = yearFromIsoDate(start_date);
  const defaultTotal = leave_type === 'vacation' ? 25 : 10;

  const { role: callerRole, is_super_admin: isSuperAdmin } = req.user!;

  // Explicitly determine if this caller can auto-approve
  const isAdminOrSuper = callerRole === 'admin' || isSuperAdmin === true;

  const initialStatus = isAdminOrSuper ? 'approved' : 'HR approved';
  const nextApprover = isAdminOrSuper ? null : 'admin';

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    await dbClient.query(
      `INSERT INTO leave_balances (company_id, user_id, year, leave_type, total_days, used_days)
       VALUES ($1,$2,$3,$4,$5,0)
       ON CONFLICT (company_id, user_id, year, leave_type) DO NOTHING`,
      [effectiveCompanyId, user_id, year, leave_type, defaultTotal],
    );

    const balRes = await dbClient.query(
      `SELECT total_days FROM leave_balances
       WHERE company_id=$1 AND user_id=$2 AND year=$3 AND leave_type=$4 FOR UPDATE`,
      [effectiveCompanyId, user_id, year, leave_type],
    );
    const bal = balRes.rows[0];

    // Calculate current used days dynamically from approved requests
    const usedRes = await dbClient.query(
      `SELECT start_date::text, end_date::text, leave_duration_type, 
              TO_CHAR(short_start_time, 'HH24:MI') as short_start_time, 
              TO_CHAR(short_end_time, 'HH24:MI') as short_end_time
       FROM leave_requests
       WHERE user_id = $1 AND leave_type = $2 AND status IN ('approved', 'admin_approved')
         AND EXTRACT(YEAR FROM start_date) = $3`,
      [user_id, leave_type, year]
    );
    let currentUsed = 0;
    for (const r of usedRes.rows) {
      currentUsed += computeRequestedLeaveDays(r);
    }

    if (currentUsed + requestedDays > parseFloat(bal.total_days)) {
      await dbClient.query('ROLLBACK');
      res.status(422).json({
        success: false,
        error: `Saldo insufficiente: rimangono ${parseFloat(bal.total_days) - currentUsed} giorni, richiesti ${requestedDays}`,
        code: 'INSUFFICIENT_BALANCE',
      });
      return;
    }

    const inserted = await dbClient.query(
      `INSERT INTO leave_requests
         (company_id, user_id, store_id, leave_type, start_date, end_date, leave_duration_type, short_start_time, short_end_time,
          status, current_approver_role, notes, approved_by, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       RETURNING id, company_id, user_id, store_id, leave_type, start_date, end_date,
                 leave_duration_type,
                 TO_CHAR(short_start_time, 'HH24:MI') AS short_start_time,
                 TO_CHAR(short_end_time, 'HH24:MI') AS short_end_time,
                 status, current_approver_role, notes, created_at`,
      [
        effectiveCompanyId,
        user_id,
        targetUser.store_id,
        leave_type,
        start_date,
        end_date,
        leaveDurationType,
        shortStartTime,
        shortEndTime,
        initialStatus,
        nextApprover,
        notes ?? null,
        // Only the terminal (admin/super-admin) path grants the leave outright;
        // the HR path still needs an admin decision, so it has no approver yet.
        nextApprover === null ? adminId : null,
      ],
    );

    await dbClient.query(
      `INSERT INTO leave_approvals (leave_request_id, approver_id, approver_role, action, notes)
       VALUES ($1,$2,$3,'approved',$4)`,
      [inserted.rows[0].id, adminId, callerRole, notes ?? null],
    );

    const adminBalanceUpdate = await dbClient.query(
      `UPDATE leave_balances SET used_days = used_days + $1, updated_at = NOW()
       WHERE company_id=$2 AND user_id=$3 AND year=$4 AND leave_type=$5`,
      [requestedDays, effectiveCompanyId, user_id, year, leave_type],
    );
    if (adminBalanceUpdate.rowCount === 0) {
      await dbClient.query(
        `INSERT INTO leave_balances (company_id, user_id, year, leave_type, total_days, used_days)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (company_id, user_id, year, leave_type) DO UPDATE
         SET used_days = leave_balances.used_days + EXCLUDED.used_days, updated_at = NOW()`,
        [effectiveCompanyId, user_id, year, leave_type, defaultTotal, requestedDays],
      );
    }

    await dbClient.query('COMMIT');

    // Trigger Leave Result Email Automation for Admin-created leave (Background task)
    if (isAdminOrSuper) {
      sendLeaveResultAutomation(
        effectiveCompanyId,
        inserted.rows[0].id,
        'approved',
        adminId
      ).catch(err => console.error('[AUTOMATION] Background admin-created leave approval email error:', err));
    }

    const msg = isAdminOrSuper ? 'Permesso creato e approvato' : 'Permesso creato (in attesa di approvazione Admin)';
    created(res, inserted.rows[0], msg);
  } catch (err: any) {
    await dbClient.query('ROLLBACK');
    // FIX 10
    if (err?.code === '23514') {
      res.status(422).json({
        success: false,
        error: 'Aggiornamento del saldo non consentito dal database',
        code: 'BALANCE_CONSTRAINT_VIOLATION',
      });
      return;
    }
    throw err;
  } finally {
    dbClient.release();
  }
});

// ---------------------------------------------------------------------------
// PUT /api/leave/balance — upsert leave balance allocation (admin/hr only)
// ---------------------------------------------------------------------------

export const setBalance = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const { user_id, year, leave_type, total_days } = req.body as {
    user_id: number;
    year: number;
    leave_type: LeaveType;
    total_days: number;
  };

  // FIX 6: validate inputs before touching the DB
  if (!VALID_LEAVE_TYPES.includes(leave_type)) {
    badRequest(res, 'Tipo di permesso non valido (vacation | sick)', 'INVALID_LEAVE_TYPE');
    return;
  }
  const currentYear = currentYearInDefaultLeaveTimezone();
  if (!Number.isInteger(year) || year < currentYear - 10 || year > currentYear + 5) {
    badRequest(res, `Anno non valido (${currentYear - 10}–${currentYear + 5})`, 'INVALID_YEAR');
    return;
  }
  // Two distinct inputs, deliberately:
  //   null  -> remove the allocation entirely (back to not-configured)
  //   0     -> a real allocation of zero days, which displays as 0 and blocks
  //            any further leave because nothing remains
  // Conflating them meant an admin could not express "this person is entitled
  // to nothing" separately from "nobody has decided yet".
  const isClearRequest = total_days === null || total_days === undefined;
  if (!isClearRequest && (typeof total_days !== 'number' || total_days < 0 || !Number.isFinite(total_days))) {
    badRequest(res, 'Il totale dei giorni non può essere negativo', 'INVALID_TOTAL_DAYS');
    return;
  }

  const targetUser = await queryOne<{ id: number; company_id: number }>(
    `SELECT id, company_id FROM users
     WHERE id = $1 AND status = 'active' AND company_id = ANY($2)`,
    [user_id, allowedCompanyIds],
  );
  if (!targetUser) {
    notFound(res, 'Dipendente non trovato');
    return;
  }

  const effectiveCompanyId = targetUser.company_id;

  // ── Clearing an allocation ────────────────────────────────────────────────
  // Removing the row is what takes the employee back to "not configured", which
  // in turn blocks HR/Admin approval until someone sets real days. That is a
  // heavier action than editing a number, so it is admin-only, and it is
  // refused outright once leave has been booked against the allocation —
  // deleting then would silently orphan days the employee has already taken.
  if (isClearRequest) {
    const isAdmin = req.user!.role === 'admin' || req.user!.is_super_admin === true;
    if (!isAdmin) {
      forbidden(
        res,
        'Solo un amministratore può azzerare (rimuovere) il saldo di un dipendente',
        'BALANCE_CLEAR_ADMIN_ONLY',
      );
      return;
    }

    const existing = await queryOne<{ used_days: string }>(
      `SELECT used_days FROM leave_balances
        WHERE company_id=$1 AND user_id=$2 AND year=$3 AND leave_type=$4`,
      [effectiveCompanyId, user_id, year, leave_type],
    );

    if (existing && parseFloat(existing.used_days) > 0) {
      res.status(422).json({
        success: false,
        error: `Impossibile rimuovere il saldo: ${parseFloat(existing.used_days)} giorni risultano già utilizzati.`,
        code: 'BALANCE_CLEAR_HAS_USAGE',
      });
      return;
    }

    await query(
      `DELETE FROM leave_balances
        WHERE company_id=$1 AND user_id=$2 AND year=$3 AND leave_type=$4`,
      [effectiveCompanyId, user_id, year, leave_type],
    );

    ok(res, { cleared: true, user_id, year, leave_type }, 'Saldo rimosso');
    return;
  }

  const result = await query<{
    id: number; company_id: number; user_id: number; year: number;
    leave_type: string; total_days: string; used_days: string;
    remaining_days: string; updated_at: string;
  }>(
    `INSERT INTO leave_balances (company_id, user_id, year, leave_type, total_days, used_days)
     VALUES ($1,$2,$3,$4,$5,0)
     ON CONFLICT (company_id, user_id, year, leave_type)
     DO UPDATE SET total_days = EXCLUDED.total_days, updated_at = NOW()
     WHERE leave_balances.used_days <= $5
     RETURNING id, company_id, user_id, year, leave_type, total_days, used_days,
               (total_days - used_days) AS remaining_days, updated_at`,
    [effectiveCompanyId, user_id, year, leave_type, total_days],
  );

  if (result.length === 0) {
    const current = await queryOne<{ used_days: string }>(
      `SELECT used_days FROM leave_balances
       WHERE company_id=$1 AND user_id=$2 AND year=$3 AND leave_type=$4`,
      [effectiveCompanyId, user_id, year, leave_type],
    );
    const usedDays = current ? parseFloat(current.used_days) : 0;
    res.status(422).json({
      success: false,
      error: `Il totale non può essere inferiore ai giorni già utilizzati (${usedDays})`,
      code: 'BALANCE_BELOW_USED',
    });
    return;
  }

  ok(res, result[0], 'Saldo aggiornato con successo');
});

// ---------------------------------------------------------------------------
// PUT /api/leave/:id/archive — archive leave request (admin/hr only)
// ---------------------------------------------------------------------------

export const archiveLeave = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { role } = req.user!;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  const leaveId = parseInt(id, 10);
  if (isNaN(leaveId) || leaveId < 1) {
    badRequest(res, 'ID richiesta non valido', 'VALIDATION_ERROR');
    return;
  }

  // Only Admin or HR can archive
  if (role !== 'admin' && role !== 'hr') {
    forbidden(res, 'Solo Admin o HR possono archiviare le richieste');
    return;
  }

  // Load the request to verify company and status
  const leaveRequest = await queryOne<{ company_id: number; status: string; is_archived: boolean }>(
    `SELECT company_id, status, is_archived FROM leave_requests WHERE id = $1`,
    [leaveId]
  );

  if (!leaveRequest) {
    notFound(res, 'Richiesta non trovata');
    return;
  }

  if (!allowedCompanyIds.includes(leaveRequest.company_id)) {
    forbidden(res, 'Accesso non consentito a questa azienda');
    return;
  }

  // Cannot archive pending requests in the workflow
  const statusNorm = (leaveRequest.status ?? '').toLowerCase().replace(/ /g, '_');
  const isPending = statusNorm === 'pending' || statusNorm === 'store_manager_approved' || statusNorm === 'area_manager_approved' || statusNorm === 'hr_approved';
  if (isPending) {
    badRequest(res, 'Impossibile archiviare una richiesta in attesa di approvazione o in-corso', 'VALIDATION_ERROR');
    return;
  }

  await query(
    `UPDATE leave_requests SET is_archived = true, updated_at = NOW() WHERE id = $1`,
    [leaveId]
  );

  ok(res, { message: 'Richiesta archiviata con successo' });
});

// ---------------------------------------------------------------------------
// DELETE /api/leave/:id — hard delete (admin only, must be archived first)
// ---------------------------------------------------------------------------

export const deleteLeaveRequest = asyncHandler(async (req: Request, res: Response) => {
  const { role, userId } = req.user!;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const leaveId = parseInt(req.params.id, 10);
  if (isNaN(leaveId)) { notFound(res, 'Richiesta non trovata'); return; }

  const existing = await queryOne<{
    id: number; company_id: number; status: string; is_archived: boolean;
    user_id: number; leave_type: string; start_date: string; end_date: string;
    leave_duration_type: LeaveDurationType | null;
    short_start_time: string | null;
    short_end_time: string | null;
  }>(
    `SELECT id, company_id, status, is_archived, user_id, leave_type, start_date, end_date,
            leave_duration_type,
            TO_CHAR(short_start_time, 'HH24:MI') AS short_start_time,
            TO_CHAR(short_end_time, 'HH24:MI') AS short_end_time
     FROM leave_requests WHERE id = $1 AND company_id = ANY($2)`,
    [leaveId, allowedCompanyIds],
  );
  if (!existing) { notFound(res, 'Richiesta non trovata'); return; }

  const isAdminOrSuper = role === 'admin' || req.user!.is_super_admin === true;

  if (isAdminOrSuper) {
    if (!existing.is_archived) {
      forbidden(res, 'È possibile eliminare solo richieste precedentemente archiviate');
      return;
    }
  } else {
    if (existing.user_id !== userId) {
      forbidden(res, 'Non sei autorizzato a eliminare questa richiesta');
      return;
    }
    if (existing.status !== 'cancelled') {
      badRequest(res, 'È possibile eliminare solo richieste annullate');
      return;
    }
    const approvals = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM leave_approvals WHERE leave_request_id = $1 AND action = 'approved'`,
      [leaveId]
    );
    if (parseInt(approvals?.count ?? '0', 10) > 0) {
      badRequest(res, 'Impossibile eliminare una richiesta che ha già ricevuto approvazioni');
      return;
    }
  }

  const deleteClient = await pool.connect();
  try {
    await deleteClient.query('BEGIN');

    // Only hr_approved requests have had balance deducted — reverse those only
    if (existing.status === 'hr_approved') {
      const requestedDays = computeRequestedLeaveDays(existing);
      const year = yearFromIsoDate(existing.start_date);
      await deleteClient.query(
        `UPDATE leave_balances
         SET used_days = GREATEST(0, used_days - $1), updated_at = NOW()
         WHERE company_id=$2 AND user_id=$3 AND year=$4 AND leave_type=$5`,
        [requestedDays, existing.company_id, existing.user_id, year, existing.leave_type],
      );
    }

    await deleteClient.query(`DELETE FROM leave_approvals WHERE leave_request_id = $1`, [leaveId]);
    await deleteClient.query(
      `DELETE FROM leave_requests WHERE id=$1 AND company_id = ANY($2)`,
      [leaveId, allowedCompanyIds],
    );

    await deleteClient.query('COMMIT');
    ok(res, { id: leaveId }, 'Richiesta eliminata');
  } catch (err) {
    await deleteClient.query('ROLLBACK');
    throw err;
  } finally {
    deleteClient.release();
  }
});

// ---------------------------------------------------------------------------
// GET /api/leave/:id/certificate — download medical certificate
// ---------------------------------------------------------------------------

export const downloadCertificate = asyncHandler(async (req: Request, res: Response) => {
  const { userId, role, storeId } = req.user!;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const leaveId = parseInt(req.params.id, 10);
  if (isNaN(leaveId)) { notFound(res, 'Richiesta non trovata'); return; }

  type CertRow = {
    user_id: number;
    company_id: number;
    store_id: number | null;
    medical_certificate_name: string | null;
    medical_certificate_data: Buffer | null;
    medical_certificate_type: string | null;
  };

  const row = await queryOne<CertRow>(
    role === 'store_manager'
      ? `SELECT user_id, company_id, store_id,
                medical_certificate_name, medical_certificate_data, medical_certificate_type
         FROM leave_requests WHERE id=$1 AND company_id = ANY($2) AND store_id=$3`
      : `SELECT user_id, company_id, store_id,
                medical_certificate_name, medical_certificate_data, medical_certificate_type
         FROM leave_requests WHERE id=$1 AND company_id = ANY($2)`,
    role === 'store_manager' ? [leaveId, allowedCompanyIds, storeId] : [leaveId, allowedCompanyIds],
  );

  if (!row) { notFound(res, 'Richiesta non trovata'); return; }

  if (role === 'employee' && row.user_id !== userId) {
    forbidden(res, 'Non sei autorizzato a scaricare questo certificato');
    return;
  }

  if (!row.medical_certificate_data) {
    notFound(res, 'Nessun certificato allegato a questa richiesta');
    return;
  }

  res.setHeader('Content-Type', row.medical_certificate_type ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${row.medical_certificate_name ?? 'certificato-medico'}"`);
  res.send(row.medical_certificate_data);
});

// ---------------------------------------------------------------------------
// GET /api/leave/balance/export
// ---------------------------------------------------------------------------

export const exportLeaveBalances = asyncHandler(async (req: Request, res: Response) => {
  const { year } = req.query as Record<string, string>;
  let targetYear: number;
  if (year !== undefined) {
    const parsed = parseInt(year, 10);
    if (!Number.isInteger(parsed) || parsed < 1900 || parsed > 2100) {
      res.status(400).json({ error: `Anno non valido: "${year}". Deve essere un intero compreso tra 1900 e 2100.` });
      return;
    }
    targetYear = parsed;
  } else {
    targetYear = currentYearInDefaultLeaveTimezone();
  }
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  // 1. Fetch users and their configured total balances
  const userBaselines = await query(`
    SELECT u.id, u.name, u.surname,
           COALESCE(lb_v.total_days, 0) AS vacation_total,
           COALESCE(lb_s.total_days, 0) AS sick_total
    FROM users u
    LEFT JOIN leave_balances lb_v ON lb_v.user_id = u.id AND lb_v.year = $1 AND lb_v.leave_type = 'vacation'
    LEFT JOIN leave_balances lb_s ON lb_s.user_id = u.id AND lb_s.year = $1 AND lb_s.leave_type = 'sick'
    WHERE u.company_id = ANY($2) AND u.status = 'active'
    ORDER BY u.surname, u.name
  `, [targetYear, allowedCompanyIds]);

  // 2. Fetch ALL approved/admin_approved leaves for these companies in the year
  const allApproved = await query(`
    SELECT user_id, leave_type, start_date::text, end_date::text, 
           leave_duration_type, 
           TO_CHAR(short_start_time, 'HH24:MI') as short_start_time, 
           TO_CHAR(short_end_time, 'HH24:MI') as short_end_time
    FROM leave_requests
    WHERE company_id = ANY($1) AND status IN ('approved', 'admin_approved')
      AND EXTRACT(YEAR FROM start_date) = $2
  `, [allowedCompanyIds, targetYear]);

  // 3. Aggregate usage in memory
  const usageMap = new Map<number, { vacation: number; sick: number }>();
  for (const row of allApproved) {
    const days = computeRequestedLeaveDays({
      start_date: row.start_date,
      end_date: row.end_date,
      leave_duration_type: row.leave_duration_type,
      short_start_time: row.short_start_time,
      short_end_time: row.short_end_time
    });
    const counts = usageMap.get(row.user_id) || { vacation: 0, sick: 0 };
    if (row.leave_type === 'vacation') counts.vacation += days;
    else if (row.leave_type === 'sick') counts.sick += days;
    usageMap.set(row.user_id, counts);
  }

  const rows = userBaselines.map(r => {
    const usage = usageMap.get(r.id) || { vacation: 0, sick: 0 };
    return {
      Matricola: r.id,
      Cognome: r.surname,
      Nome: r.name,
      Anno: targetYear,
      'Totale Ferie': parseFloat(r.vacation_total),
      'Ferie Godute': Number(usage.vacation.toFixed(2)),
      'Totale ROL/Permessi': parseFloat(r.sick_total),
      'ROL/Permessi Goduti': Number(usage.sick.toFixed(2))
    };
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Saldi Ferie e Permessi');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="saldi_${targetYear}.xlsx"`);
  res.send(Buffer.from(buf));
});

// ---------------------------------------------------------------------------
// GET /api/leave/balance/import-template
// ---------------------------------------------------------------------------

export const importTemplate = asyncHandler(async (req: Request, res: Response) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['Matricola', 'Nome', 'Cognome', 'Anno', 'Totale Ferie', 'Ferie Godute', 'Totale ROL/Permessi', 'ROL/Permessi Goduti']]);
  XLSX.utils.book_append_sheet(wb, ws, 'Template');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="import_template.xlsx"');
  res.send(Buffer.from(buf));
});

// ---------------------------------------------------------------------------
// POST /api/leave/balance/import
// ---------------------------------------------------------------------------

export const importLeaveBalances = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) { badRequest(res, 'File mancante'); return; }
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (err) {
    badRequest(res, 'Impossibile leggere il file. Assicurati che sia formato correttamente.');
    return;
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<any>(ws);

  let imported = 0, skipped = 0, failed = 0;
  const errors: string[] = [];

  await query('BEGIN');
  try {
    for (const [idx, row] of rows.entries()) {
      const rnum = idx + 2; // header is row 1

      // Fetch case-insensitive columns
      let matricola: any, anno: any, totFerie: any, usedFerie: any, totPermessi: any, usedPermessi: any;
      for (const key of Object.keys(row)) {
        const k = key.toLowerCase().replace(/[\\s_/]/g, '');
        if (k === 'matricola' || k === 'id' || k === 'userid') matricola = row[key];
        if (k === 'anno' || k === 'year') anno = row[key];
        if (k === 'totaleferie' || k === 'vacationtotal') totFerie = row[key];
        if (k === 'feriegodute' || k === 'vacationused') usedFerie = row[key];
        if (k === 'totalerolpermessi' || k === 'totalepermessi' || k === 'sicktotal') totPermessi = row[key];
        if (k === 'rolpermessigoduti' || k === 'permessigoduti' || k === 'sickused') usedPermessi = row[key];
      }

      if (!matricola || !anno) {
        skipped++;
        errors.push(`Riga ${rnum}: Matricola e Anno sono obbligatori.`);
        continue;
      }

      const emp = await queryOne<{ id: number, company_id: number }>(
        `SELECT id, company_id FROM users WHERE id = $1 AND company_id = ANY($2) AND status = 'active'`,
        [matricola, allowedCompanyIds]
      );

      if (!emp) {
        failed++;
        errors.push(`Riga ${rnum}: Dipendente ${matricola} non trovato o inattivo.`);
        continue;
      }

      const year = parseInt(anno, 10);
      if (isNaN(year) || year < 2020 || year > 2100) {
        failed++;
        errors.push(`Riga ${rnum}: Anno ${anno} non valido.`);
        continue;
      }

      let updated = false;

      if (totFerie !== undefined || usedFerie !== undefined) {
        const tot = parseFloat(totFerie) || 0;
        const used = parseFloat(usedFerie) || 0;
        if (used > tot) {
          failed++;
          errors.push(`Riga ${rnum}: I giorni usati di ferie (${used}) non possono superare il totale (${tot}).`);
          continue;
        }
        try {
          await query(`
            INSERT INTO leave_balances (company_id, user_id, year, leave_type, total_days, used_days, updated_at)
            VALUES ($1, $2, $3, 'vacation', $4, $5, NOW())
            ON CONFLICT (company_id, user_id, year, leave_type) DO UPDATE
            SET total_days = EXCLUDED.total_days, used_days = EXCLUDED.used_days, updated_at = NOW()
          `, [emp.company_id, matricola, year, tot, used]);
          updated = true;
        } catch (dbErr: any) {
          if (dbErr?.code === '23514') {
            failed++;
            errors.push(`Riga ${rnum}: Violazione vincolo ferie — i giorni usati non possono superare il totale.`);
            continue;
          }
          throw dbErr;
        }
      }

      if (totPermessi !== undefined || usedPermessi !== undefined) {
        const tot = parseFloat(totPermessi) || 0;
        const used = parseFloat(usedPermessi) || 0;
        if (used > tot) {
          failed++;
          errors.push(`Riga ${rnum}: I giorni usati di malattia (${used}) non possono superare il totale (${tot}).`);
          continue;
        }
        try {
          await query(`
            INSERT INTO leave_balances (company_id, user_id, year, leave_type, total_days, used_days, updated_at)
            VALUES ($1, $2, $3, 'sick', $4, $5, NOW())
            ON CONFLICT (company_id, user_id, year, leave_type) DO UPDATE
            SET total_days = EXCLUDED.total_days, used_days = EXCLUDED.used_days, updated_at = NOW()
          `, [emp.company_id, matricola, year, tot, used]);
          updated = true;
        } catch (dbErr: any) {
          if (dbErr?.code === '23514') {
            failed++;
            errors.push(`Riga ${rnum}: Violazione vincolo malattia — i giorni usati non possono superare il totale.`);
            continue;
          }
          throw dbErr;
        }
      }

      if (updated) {
        imported++;
      } else {
        skipped++;
      }
    }

    await query('COMMIT');
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }

  ok(res, { imported, skipped, failed, errors, total: rows.length }, 'Import completato');
});

// ---------------------------------------------------------------------------
// Auto-Escalation Logic
// ---------------------------------------------------------------------------

/**
 * Tell the people who owe a decision that one is outstanding.
 *
 * The old escalation approved the request instead of chasing anyone, so nothing
 * was ever sent. Both branches of the new job go through here.
 */
async function notifyApproversOfPendingLeave(
  req: { id: number; company_id: number; user_id: number; store_id: number | null },
  approverRole: string,
  kind: 'reassigned' | 'reminder',
): Promise<void> {
  try {
    const approvers = await usersForApproverRole(req.company_id, req.store_id, approverRole, req.user_id);
    if (approvers.length === 0) {
      console.warn(`[leave-escalation] request ${req.id}: no active "${approverRole}" to notify`);
      return;
    }

    const employee = await queryOne<{ name: string; surname: string }>(
      `SELECT name, surname FROM users WHERE id = $1`,
      [req.user_id],
    );
    const who = employee ? `${employee.name} ${employee.surname}`.trim() : `dipendente #${req.user_id}`;

    const title = kind === 'reassigned'
      ? 'Richiesta di permesso riassegnata'
      : 'Sollecito: richiesta di permesso in attesa';
    const message = kind === 'reassigned'
      ? `La richiesta di permesso di ${who} è stata riassegnata a te per inattività del livello precedente. Nessuna approvazione automatica è stata effettuata: attende la tua decisione.`
      : `La richiesta di permesso di ${who} è ferma da più di 2 giorni e attende la tua decisione. Nessuna approvazione automatica verrà effettuata.`;

    await Promise.all(
      approvers.map((a) =>
        sendNotification({
          companyId: req.company_id,
          userId: a.id,
          type: 'leave.escalated',
          title,
          message,
          priority: 'high',
          metadata: { leave_request_id: req.id, kind },
        }).catch(() => undefined),
      ),
    );
  } catch (err) {
    // A failed notification must never stop the job from processing the rest.
    console.error(`[leave-escalation] notification failed for request ${req.id}`, err);
  }
}

export async function processEscalationLogic() {
  const stalled = await query<{
    id: number;
    company_id: number;
    user_id: number;
    store_id: number | null;
    start_date: string;
    end_date: string;
    current_approver_role: string;
    escalated: boolean;
    skipped_approvers: string[] | null;
    on_leave_skipped_approvers: string[] | null;
    reminder_due: boolean;
  }>(
    `SELECT id, company_id, user_id, store_id, start_date, end_date, current_approver_role,
            escalated, skipped_approvers, on_leave_skipped_approvers,
            (last_reminder_at IS NULL OR last_reminder_at < NOW() - INTERVAL '2 days') AS reminder_due
     FROM leave_requests
     WHERE status NOT IN ('admin_approved', 'rejected', 'cancelled')
       AND last_action_at < NOW() - INTERVAL '2 days'
       AND current_approver_role IS NOT NULL`
  );

  let escalatedCount = 0;

  for (const req of stalled) {
    try {
      const chain = await getApprovalChain(req.company_id);
      const transitions = buildTransitions(chain);
      const transition = transitions[req.current_approver_role];
      if (!transition) continue;

      // HR and Admin decisions are never made by the system. A request sitting
      // on either is chased where it is — not advanced, not approved.
      const stageMayAdvance = canAutoAdvance(req.current_approver_role);

      // Only ever look FORWARD. findNextActiveApprover treats a null start role
      // as "scan the whole chain from the top", which at the end of the chain
      // would hand the request back to the first approver — so when there is no
      // next role we must not call it at all.
      let nextActiveRole: string | null = null;
      let additionalSkipped: string[] = [];
      if (stageMayAdvance && transition.nextApprover) {
        const found = await findNextActiveApprover(
          req.company_id,
          req.store_id,
          req.start_date,
          req.end_date,
          req.user_id,
          transition.nextApprover,
          chain,
        );
        nextActiveRole = found.approver;
        additionalSkipped = found.skipped;
      }

      if (nextActiveRole) {
        // ── Auto-advance (below HR only) ────────────────────────────────────
        // Carry the request past a store/area manager who has not looked at it.
        // `status` records that the stage was cleared, but the request only ever
        // moves TOWARDS a human decision: the next role is always a real
        // approver, and approved_by stays NULL, so it can never be mistaken for
        // granted and no balance is deducted here.
        const updatedSkipped = Array.from(new Set([...(req.skipped_approvers || []), ...additionalSkipped]));
        const realAdditionalSkipped = additionalSkipped.filter(r => chain.includes(r));
        const updatedOnLeaveSkipped = Array.from(new Set([...(req.on_leave_skipped_approvers || []), ...realAdditionalSkipped]));

        await query(
          `UPDATE leave_requests
           SET current_approver_role = $1, status = $2, escalated = TRUE,
               last_action_at = NOW(), last_reminder_at = NOW(),
               skipped_approvers = $3, on_leave_skipped_approvers = $4
           WHERE id = $5`,
          [
            nextActiveRole,
            // The status THIS stage produces — not the next role's, which is
            // what made the status run a phase ahead of the approver.
            transition.nextStatus,
            JSON.stringify(updatedSkipped),
            JSON.stringify(updatedOnLeaveSkipped),
            req.id,
          ],
        );

        await query(
          `INSERT INTO leave_approvals (leave_request_id, approver_id, approver_role, action, notes)
           VALUES ($1, NULL, 'system', 'escalated', $2)`,
          [req.id, `Fase ${req.current_approver_role} superata automaticamente per inattività; assegnata a ${nextActiveRole}. Approvazione finale e scarico del saldo riservati a una decisione umana.`],
        );

        await notifyApproversOfPendingLeave(req, nextActiveRole, 'reassigned');
        escalatedCount++;
      } else {
        // ── Solicit ─────────────────────────────────────────────────────────
        // Either the stage belongs to HR/Admin — whose decision is always a
        // person's — or there is nobody further down the chain. Either way the
        // request stays exactly where it is and we chase the current approver.
        // It is never granted by default.
        if (!req.reminder_due) continue;

        // last_action_at is intentionally left alone: the request is still
        // stale and must keep showing up in the "requires attention" report.
        await query(
          `UPDATE leave_requests SET escalated = TRUE, last_reminder_at = NOW() WHERE id = $1`,
          [req.id],
        );

        await query(
          `INSERT INTO leave_approvals (leave_request_id, approver_id, approver_role, action, notes)
           VALUES ($1, NULL, 'system', 'escalated', $2)`,
          [req.id, `Sollecito automatico a ${req.current_approver_role}: richiesta ferma da oltre 2 giorni — ${
            stageMayAdvance
              ? 'nessun approvatore disponibile ai livelli successivi'
              : `l'approvazione ${req.current_approver_role.toUpperCase()} richiede sempre una decisione umana`
          }. Nessuna approvazione automatica.`],
        );

        await notifyApproversOfPendingLeave(req, req.current_approver_role, 'reminder');
        escalatedCount++;
      }
    } catch (err) {
      // Avoid crashing the whole background task because of one broken row/constraint.
      if (isPgCheckConstraintError(err)) {
        console.warn(`[leave-escalation] skipped request ${req.id} due to status check constraint`, err);
        continue;
      }
      console.error(`[leave-escalation] unexpected error on request ${req.id}`, err);
      continue;
    }
  }

  return escalatedCount;
}

export const executeEscalation = asyncHandler(async (req: Request, res: Response) => {
  const count = await processEscalationLogic();
  res.json({ success: true, escalated: count });
});

// ---------------------------------------------------------------------------
// GET /api/leave/approval-config — get approval chain config for a company
// ---------------------------------------------------------------------------
export const getApprovalConfig = asyncHandler(async (req: Request, res: Response) => {
  const { role } = req.user!;
  if (!['admin', 'hr', 'system_admin'].includes(role)) {
    forbidden(res, 'Solo admin e HR possono visualizzare la configurazione approvazioni');
    return;
  }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const companyId = parseInt(req.query.company_id as string, 10) || allowedCompanyIds[0];

  if (!allowedCompanyIds.includes(companyId)) {
    forbidden(res, 'Non hai accesso a questa azienda');
    return;
  }

  let rows = await query<{ id: number; role: string; enabled: boolean; sort_order: number }>(
    `SELECT id, role, enabled, sort_order FROM leave_approval_config
     WHERE company_id = $1 ORDER BY sort_order`,
    [companyId],
  );

  // Auto-seed if no config exists for this company
  if (rows.length === 0) {
    await query(
      `INSERT INTO leave_approval_config (company_id, role, enabled, sort_order)
       VALUES ($1, 'store_manager', true, 1),
              ($1, 'area_manager', true, 2),
              ($1, 'hr', true, 3),
              ($1, 'admin', true, 4)
       ON CONFLICT (company_id, role) DO NOTHING`,
      [companyId],
    );
    rows = await query(
      `SELECT id, role, enabled, sort_order FROM leave_approval_config
       WHERE company_id = $1 ORDER BY sort_order`,
      [companyId],
    );
  }

  ok(res, rows);
});

// ---------------------------------------------------------------------------
// PUT /api/leave/approval-config — update approval chain config
// body: { levels: Array<{ role: string, enabled: boolean, sort_order: number }> }
// ---------------------------------------------------------------------------
export const updateApprovalConfig = asyncHandler(async (req: Request, res: Response) => {
  const { role } = req.user!;
  if (!['admin', 'system_admin'].includes(role)) {
    forbidden(res, 'Solo admin possono modificare la configurazione approvazioni');
    return;
  }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const { company_id, levels } = req.body as {
    company_id: number;
    levels: Array<{ role: string; enabled: boolean; sort_order: number }>;
  };

  if (!allowedCompanyIds.includes(company_id)) {
    forbidden(res, 'Non hai accesso a questa azienda');
    return;
  }

  const validRoles = new Set(['store_manager', 'area_manager', 'hr', 'admin']);
  if (!Array.isArray(levels) || levels.length === 0) {
    badRequest(res, 'Livelli di approvazione richiesti', 'VALIDATION_ERROR');
    return;
  }

  // At least one level must be enabled
  const enabledCount = levels.filter((l) => l.enabled).length;
  if (enabledCount === 0) {
    badRequest(res, 'Almeno un livello di approvazione deve essere attivo', 'VALIDATION_ERROR');
    return;
  }

  for (const level of levels) {
    if (!validRoles.has(level.role)) {
      badRequest(res, `Ruolo non valido: ${level.role}`, 'VALIDATION_ERROR');
      return;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const level of levels) {
      await client.query(
        `INSERT INTO leave_approval_config (company_id, role, enabled, sort_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, role)
         DO UPDATE SET enabled = $3, sort_order = $4, updated_at = NOW()`,
        [company_id, level.role, level.enabled, level.sort_order],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const updated = await query<{ id: number; role: string; enabled: boolean; sort_order: number }>(
    `SELECT id, role, enabled, sort_order FROM leave_approval_config
     WHERE company_id = $1 ORDER BY sort_order`,
    [company_id],
  );

  ok(res, updated, 'Configurazione approvazioni aggiornata');
});

