import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool, query, queryOne } from '../../config/database';
import { ok, created, notFound, conflict, forbidden, badRequest } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { resolveAreaManagerStoreIds } from '../../utils/storeScope';
import { UserRole } from '../../config/jwt';
import {
  resolveAllowedCompanyIds,
  resolveCompanyGroupId,
  resolveGroupRoleVisibility,
} from '../../utils/companyScope';
import { emitToCompany } from '../../config/socket';
import { emailService } from '../../services/email.service';
import { sendWelcomeEmailAutomation } from '../automations/welcomeEmail';

// Safe fields for list view (NO sensitive data)
const LIST_FIELDS = `
  u.id, u.company_id, u.store_id, u.supervisor_id,
  u.name, u.surname, u.email, u.role, u.unique_id,
  u.department, u.hire_date, u.contract_end_date,
  u.working_type, u.weekly_hours,
  COALESCE(u.off_days, ARRAY[5,6]::SMALLINT[]) AS off_days,
  u.status,
  u.first_aid_flag, u.marital_status,
  u.termination_date, u.termination_type, u.created_at,
  u.avatar_filename,
  u.device_reset_pending,
  ((u.registered_device_token IS NOT NULL) OR (u.registered_device_identifier IS NOT NULL)) AS device_registered,
  u.registered_device_registered_at AS device_registered_at,
  u.registered_device_metadata AS device_metadata,
  u.last_seen_ip,
  u.last_seen_at,
  s.name AS store_name,
  CONCAT(sup.name, ' ', sup.surname) AS supervisor_name
`;

// Extended list fields including company name (for super admin cross-company view)
const LIST_FIELDS_WITH_COMPANY = `
  ${LIST_FIELDS.trim()},
  c.name AS company_name,
  cg.name AS company_group_name
`;

// Full fields for detail view (includes sensitive)
const DETAIL_FIELDS = `
  ${LIST_FIELDS},
  u.personal_email, u.date_of_birth, u.nationality, u.gender,
  u.iban, u.address, u.cap, u.country, u.state, u.city, u.phone,
  u.contract_type, u.probation_months,
  u.device_reset_pending,
  ((u.registered_device_token IS NOT NULL) OR (u.registered_device_identifier IS NOT NULL)) AS device_registered,
  u.registered_device_registered_at AS device_registered_at,
  u.updated_at,
  TRIM(CONCAT(cb.name, ' ', cb.surname)) AS created_by_name,
  TRIM(CONCAT(ub.name, ' ', ub.surname)) AS updated_by_name
`;

// Extended detail fields including company name (for exporting sensitive data by authorized managers)
const DETAIL_FIELDS_WITH_COMPANY = `
  ${DETAIL_FIELDS.trim()},
  c.name AS company_name,
  cg.name AS company_group_name
`;


// Base joins
const BASE_JOINS = `
  FROM users u
  LEFT JOIN stores s ON s.id = u.store_id
  LEFT JOIN users sup ON sup.id = u.supervisor_id
`;

// Resolves created_by/updated_by to names. Only appended when DETAIL_FIELDS is
// selected — the list and count paths must not pay for joins they never read.
const AUDIT_JOINS = `
  LEFT JOIN users cb ON cb.id = u.created_by
  LEFT JOIN users ub ON ub.id = u.updated_by
`;

// Base joins with company (for super admin cross-company view)
const BASE_JOINS_WITH_COMPANY = `
  FROM users u
  LEFT JOIN stores s ON s.id = u.store_id
  LEFT JOIN users sup ON sup.id = u.supervisor_id
  LEFT JOIN companies c ON c.id = u.company_id
  LEFT JOIN company_groups cg ON cg.id = c.group_id
`;

// Valid supervisor roles
const SUPERVISOR_ROLES: UserRole[] = ['admin', 'hr', 'area_manager', 'store_manager'];
const DEFAULT_OFF_DAYS = [5, 6];

function normalizeOffDays(raw: unknown, fallback: number[] = DEFAULT_OFF_DAYS): number[] {
  if (!Array.isArray(raw)) return [...fallback];
  const normalized = Array.from(new Set(
    raw
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
  )).sort((a, b) => a - b);
  return normalized.length > 0 ? normalized : [...fallback];
}

// M9: Validate that supervisor_id refers to an active user with a supervisory role
// in the same company. Returns an error message string, or null if valid.
async function validateSupervisor(supervisorId: number, companyId: number): Promise<string | null> {
  const sup = await queryOne<{ id: number; status: string; role: UserRole }>(
    `SELECT id, status, role FROM users WHERE id = $1 AND company_id = $2`,
    [supervisorId, companyId],
  );
  if (!sup) {
    return 'Il supervisore specificato non esiste in questa azienda';
  }
  if (sup.status !== 'active') {
    return 'Il supervisore specificato non è attivo';
  }
  if (!(SUPERVISOR_ROLES as string[]).includes(sup.role)) {
    return 'Il supervisore specificato non ha un ruolo valido (richiesto: admin, hr, area_manager o store_manager)';
  }
  return null;
}

// M11: Validate that store_id refers to an active store belonging to the company.
// Returns an error message string, or null if valid.
async function validateStore(storeId: number, companyId: number): Promise<string | null> {
  const store = await queryOne<{ id: number; is_active: boolean }>(
    `SELECT id, is_active FROM stores WHERE id = $1 AND company_id = $2`,
    [storeId, companyId],
  );
  if (!store) {
    return 'Il punto vendita specificato non esiste in questa azienda';
  }
  if (!store.is_active) {
    return 'Il punto vendita specificato non è attivo';
  }
  return null;
}

// Build WHERE clause based on role
function buildScopeWhere(
  role: UserRole,
  companyId: number,
  userId: number,
  storeId: number | null,
): { where: string; params: any[] } {
  const base = `u.company_id = $1`;
  switch (role) {
    case 'admin':
    case 'hr':
    case 'area_manager':
      return { where: base, params: [companyId] };
    case 'store_manager':
      return { where: `${base} AND u.store_id = $2`, params: [companyId, storeId] };
    case 'employee':
      return { where: `${base} AND u.id = $2`, params: [companyId, userId] };
    default:
      return { where: `${base} AND 1=0`, params: [companyId] }; // store_terminal — no access
  }
}

async function resolveScopeCompanyIdsForSubject(
  subjectRole: UserRole,
  subjectCompanyId: number,
): Promise<number[]> {
  const groupId = await resolveCompanyGroupId(subjectCompanyId);
  if (groupId == null) {
    return [subjectCompanyId];
  }

  if (subjectRole === 'admin') {
    const rows = await query<{ id: number }>(
      `SELECT id FROM companies WHERE group_id = $1 AND is_active = true ORDER BY id`,
      [groupId],
    );
    return rows.map((row) => row.id);
  }

  if (subjectRole === 'hr' || subjectRole === 'area_manager') {
    const canCross = await resolveGroupRoleVisibility(groupId, subjectRole);
    if (!canCross) {
      return [subjectCompanyId];
    }
    const rows = await query<{ id: number }>(
      `SELECT id FROM companies WHERE group_id = $1 AND is_active = true ORDER BY id`,
      [groupId],
    );
    return rows.map((row) => row.id);
  }

  return [subjectCompanyId];
}

// GET /api/employees — list with filters, no sensitive fields
export const listEmployees = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, role, userId, storeId } = req.user!;

  if (role === 'store_terminal') {
    forbidden(res, 'Accesso non consentito');
    return;
  }

  const {
    search,
    store_id,
    department,
    status: statusFilter,
    role: roleFilter,
    exclude_admins,
    include_store_terminals,
    target_company_id,
    page = '1',
    limit = '20',
    for_shift_planning,
    include_sensitive,
  } = req.query as Record<string, string>;

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const hasCrossCompanyAccess = allowedCompanyIds.length > 1;

  const targetCompanyId = target_company_id ? parseInt(target_company_id, 10) : null;
  if (targetCompanyId !== null && !allowedCompanyIds.includes(targetCompanyId)) {
    return res.status(403).json({ success: false, error: 'Accesso negato: azienda non valida', code: 'COMPANY_MISMATCH' });
  }

  // Cross-company with no target: query all allowed companies
  const crossCompany = hasCrossCompanyAccess && !targetCompanyId;

  const canSeeSensitive = ['admin', 'hr', 'area_manager'].includes(role);
  const includeSensitive = include_sensitive === 'true' || include_sensitive === '1';

  // H8: cross-company queries allow up to 500 rows; normal queries cap at 100.
  // When authorized manager exports sensitive data, allow up to 10000.
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const maxLimit = (includeSensitive && canSeeSensitive) ? 10000 : (crossCompany ? 500 : 100);
  const limitNum = Math.min(maxLimit, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * limitNum;


  let where: string;
  let params: any[];

  const forShiftPlanning = for_shift_planning === 'true' || for_shift_planning === '1';

  if (forShiftPlanning && role === 'area_manager') {
    const storeIds = await resolveAreaManagerStoreIds(userId, allowedCompanyIds);
    if (storeIds.length === 0) {
      ok(res, { employees: [], total: 0, page: pageNum, limit: limitNum, pages: 0 });
      return;
    }
    if (crossCompany) {
      const ph = storeIds.map((_, i) => `$${2 + i}`).join(', ');
      where = `u.company_id = ANY($1) AND u.store_id IN (${ph}) AND u.status = 'active'`;
      params = [allowedCompanyIds, ...storeIds];
    } else if (hasCrossCompanyAccess && targetCompanyId) {
      const ph = storeIds.map((_, i) => `$${2 + i}`).join(', ');
      where = `u.company_id = $1 AND u.store_id IN (${ph}) AND u.status = 'active'`;
      params = [targetCompanyId, ...storeIds];
    } else {
      const ph = storeIds.map((_, i) => `$${2 + i}`).join(', ');
      where = `u.company_id = $1 AND u.store_id IN (${ph}) AND u.status = 'active'`;
      params = [companyId!, ...storeIds];
    }
  } else if (crossCompany) {
    where = `u.company_id = ANY($1)`;
    params = [allowedCompanyIds];
  } else if (hasCrossCompanyAccess && targetCompanyId) {
    where = `u.company_id = $1`;
    params = [targetCompanyId];
  } else {
    const scope = buildScopeWhere(role, companyId!, userId, storeId);
    where = scope.where;
    params = scope.params;
  }

  // The Employee module excludes store terminals by default, but message pickers can opt in.
  if (include_store_terminals !== 'true' && include_store_terminals !== '1') {
    where += " AND u.role <> 'store_terminal'";
  }

  if (exclude_admins === 'true' || exclude_admins === '1') {
    where += " AND u.role <> 'admin' AND u.is_super_admin = false";
  }

  let extraWhere = '';
  const extraParams: any[] = [];
  let paramIdx = params.length + 1;

  // When loading for shift planning, exclude non-shiftable management roles
  if (forShiftPlanning) {
    extraWhere += ` AND u.role NOT IN ('admin', 'hr', 'area_manager')`;
  }

  if (search) {
    extraWhere += ` AND (LOWER(u.name) LIKE LOWER($${paramIdx}) ESCAPE '\\' OR LOWER(u.surname) LIKE LOWER($${paramIdx}) ESCAPE '\\' OR u.unique_id ILIKE $${paramIdx} ESCAPE '\\')`;
    const escapedSearch = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
    extraParams.push(`%${escapedSearch}%`);
    paramIdx++;
  }
  if (store_id) {
    extraWhere += ` AND u.store_id = $${paramIdx}`;
    extraParams.push(parseInt(store_id, 10));
    paramIdx++;
  }
  if (department) {
    extraWhere += ` AND u.department ILIKE $${paramIdx}`;
    extraParams.push(`%${department}%`);
    paramIdx++;
  }
  if (statusFilter) {
    extraWhere += ` AND u.status = $${paramIdx}`;
    extraParams.push(statusFilter);
    paramIdx++;
  }
  if (roleFilter) {
    extraWhere += ` AND u.role = $${paramIdx}`;
    extraParams.push(roleFilter);
    paramIdx++;
  }

  const allParams = [...params, ...extraParams];
  const wantsDetail = includeSensitive && canSeeSensitive;
  const selectFields = wantsDetail ? DETAIL_FIELDS_WITH_COMPANY : LIST_FIELDS_WITH_COMPANY;
  const joins = BASE_JOINS_WITH_COMPANY;
  const selectJoins = wantsDetail ? `${joins} ${AUDIT_JOINS}` : joins;


  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count ${joins} WHERE ${where}${extraWhere}`,
    allParams,
  );
  const total = parseInt(countResult?.count ?? '0', 10);

  const employees = await query(
    `SELECT ${selectFields} ${selectJoins} WHERE ${where}${extraWhere} ORDER BY u.surname, u.name LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...allParams, limitNum, offset],
  );

  ok(res, { employees, total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) });
});

// GET /api/employees/:id — detail with sensitive fields (role-gated)
export const getEmployee = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, role, userId } = req.user!;
  const empId = parseInt(req.params.id, 10);
  if (isNaN(empId)) { notFound(res, 'Dipendente non trovato'); return; }

  // Cross-company access: super_admin, grouped admin, and grouped HR/area_manager
  // with can_cross_company enabled may view employees across group companies.
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const hasCrossCompanyAccess = allowedCompanyIds.length > 1;

  // H3: canSeeSensitive is ALWAYS evaluated from the caller's actual role.
  // Cross-company access only bypasses the company filter, never the sensitive-field check.
  const canSeeSensitive = role === 'admin' || role === 'hr' || role === 'area_manager' || userId === empId;

  const fields = canSeeSensitive ? DETAIL_FIELDS : LIST_FIELDS;
  const joins = canSeeSensitive ? `${BASE_JOINS} ${AUDIT_JOINS}` : BASE_JOINS;

  // For cross-company callers, fetch the employee and then verify company membership.
  // For single-company callers, scope directly by company_id for efficiency.
  const employee = await queryOne<Record<string, any>>(
    hasCrossCompanyAccess
      ? `SELECT ${fields}, c.name AS company_name ${joins} LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = $1`
      : `SELECT ${fields}, c.name AS company_name ${joins} LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = $1 AND u.company_id = $2`,
    hasCrossCompanyAccess ? [empId] : [empId, companyId],
  );

  if (!employee) {
    notFound(res, 'Dipendente non trovato');
    return;
  }

  // For cross-company callers, verify the employee belongs to an allowed company.
  if (hasCrossCompanyAccess && !allowedCompanyIds.includes(employee.company_id)) {
    forbidden(res, 'Accesso negato'); return;
  }

  // For single-company callers, apply the usual sub-company scope restrictions.
  if (!hasCrossCompanyAccess) {
    if (role === 'employee' && userId !== empId) {
      forbidden(res, 'Accesso negato'); return;
    }
    if (role === 'store_manager' && employee.store_id !== req.user!.storeId) {
      forbidden(res, 'Accesso negato'); return;
    }
  }

  ok(res, employee);
});

interface AssociationSubjectRow {
  id: number;
  company_id: number;
  company_name: string | null;
  store_id: number | null;
  store_name: string | null;
  supervisor_id: number | null;
  name: string;
  surname: string;
  email: string;
  role: UserRole;
  status: 'active' | 'inactive';
  avatar_filename: string | null;
}

interface AssociationCompanyRow {
  id: number;
  name: string;
  slug: string;
  is_active: boolean;
  logo_filename: string | null;
  group_name: string | null;
}

interface AssociationStoreRow {
  id: number;
  company_id: number;
  name: string;
  code: string;
  is_active: boolean;
  logo_filename: string | null;
}

interface AssociationEmployeeRow {
  id: number;
  company_id: number;
  company_name: string;
  store_id: number | null;
  store_name: string | null;
  supervisor_id: number | null;
  name: string;
  surname: string;
  email: string;
  role: UserRole;
  status: 'active' | 'inactive';
  avatar_filename: string | null;
}

interface AssociationEmployeeItem {
  id: number;
  name: string;
  surname: string;
  email: string;
  role: UserRole;
  status: 'active' | 'inactive';
  companyId: number;
  companyName: string;
  storeId: number | null;
  storeName: string | null;
  supervisorId: number | null;
  avatarFilename: string | null;
}

interface AssociationStoreItem {
  id: number;
  name: string;
  code: string;
  isActive: boolean;
  logoFilename: string | null;
  employees: AssociationEmployeeItem[];
}

interface AssociationCompanyItem {
  id: number;
  name: string;
  slug: string;
  isActive: boolean;
  logoFilename: string | null;
  groupName: string | null;
  stores: AssociationStoreItem[];
  unassignedEmployees: AssociationEmployeeItem[];
  employeeCount: number;
}

// GET /api/employees/:id/associations — role-aware hierarchy for employee detail screen
export const getEmployeeAssociations = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, role, userId, storeId } = req.user!;
  const empId = parseInt(req.params.id, 10);
  if (isNaN(empId)) { notFound(res, 'Dipendente non trovato'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const hasCrossCompanyAccess = allowedCompanyIds.length > 1;

  const subject = await queryOne<AssociationSubjectRow>(
    `SELECT
      u.id,
      u.company_id,
      c.name AS company_name,
      u.store_id,
      s.name AS store_name,
      u.supervisor_id,
      u.name,
      u.surname,
      u.email,
      u.role,
      u.status,
      u.avatar_filename
     FROM users u
     LEFT JOIN companies c ON c.id = u.company_id
     LEFT JOIN stores s ON s.id = u.store_id
     WHERE u.id = $1`,
    [empId],
  );

  if (!subject) {
    notFound(res, 'Dipendente non trovato');
    return;
  }

  if (!allowedCompanyIds.includes(subject.company_id)) {
    forbidden(res, 'Accesso negato');
    return;
  }

  if (!hasCrossCompanyAccess) {
    if (role === 'employee' && userId !== empId) {
      forbidden(res, 'Accesso negato'); return;
    }
    if (role === 'store_manager' && subject.store_id !== storeId) {
      forbidden(res, 'Accesso negato'); return;
    }
  }

  const roleScopeCompanyIds = await resolveScopeCompanyIdsForSubject(subject.role, subject.company_id);
  const scopedCompanyIds = roleScopeCompanyIds.filter((id) => allowedCompanyIds.includes(id));

  if (scopedCompanyIds.length === 0) {
    ok(res, {
      subject: {
        id: subject.id,
        role: subject.role,
        companyId: subject.company_id,
        companyName: subject.company_name,
        storeId: subject.store_id,
        storeName: subject.store_name,
      },
      scope: 'none',
      summary: { companyCount: 0, storeCount: 0, employeeCount: 0 },
      companies: [],
    });
    return;
  }

  let scope: 'company' | 'company_group' | 'managed' | 'store' | 'self' = 'company';
  let stores: AssociationStoreRow[] = [];
  let employees: AssociationEmployeeRow[] = [];

  const loadStoreRows = async (storeIds?: number[]): Promise<AssociationStoreRow[]> => {
    if (storeIds && storeIds.length === 0) return [];
    if (storeIds) {
      return query<AssociationStoreRow>(
        `SELECT s.id, s.company_id, s.name, s.code, s.is_active, s.logo_filename
         FROM stores s
         WHERE s.company_id = ANY($1) AND s.id = ANY($2)
         ORDER BY s.name`,
        [scopedCompanyIds, storeIds],
      );
    }
    return query<AssociationStoreRow>(
      `SELECT s.id, s.company_id, s.name, s.code, s.is_active, s.logo_filename
       FROM stores s
       WHERE s.company_id = ANY($1)
       ORDER BY s.name`,
      [scopedCompanyIds],
    );
  };

  switch (subject.role) {
    case 'admin':
    case 'hr': {
      scope = scopedCompanyIds.length > 1 ? 'company_group' : 'company';
      stores = await loadStoreRows();
      employees = await query<AssociationEmployeeRow>(
        `SELECT
          u.id,
          u.company_id,
          c.name AS company_name,
          u.store_id,
          s.name AS store_name,
          u.supervisor_id,
          u.name,
          u.surname,
          u.email,
          u.role,
          u.status,
          u.avatar_filename
         FROM users u
         JOIN companies c ON c.id = u.company_id
         LEFT JOIN stores s ON s.id = u.store_id
         WHERE u.company_id = ANY($1)
           AND u.status = 'active'
           AND u.role <> 'store_terminal'
         ORDER BY c.name, s.name NULLS LAST, u.surname, u.name`,
        [scopedCompanyIds],
      );
      break;
    }
    case 'area_manager': {
      scope = 'managed';
      employees = await query<AssociationEmployeeRow>(
        `SELECT
          u.id,
          u.company_id,
          c.name AS company_name,
          u.store_id,
          s.name AS store_name,
          u.supervisor_id,
          u.name,
          u.surname,
          u.email,
          u.role,
          u.status,
          u.avatar_filename
         FROM users u
         JOIN companies c ON c.id = u.company_id
         LEFT JOIN stores s ON s.id = u.store_id
         WHERE u.company_id = ANY($1)
           AND u.status = 'active'
           AND u.supervisor_id = $2
         ORDER BY c.name, s.name NULLS LAST, u.surname, u.name`,
        [scopedCompanyIds, empId],
      );
      const managedStoreIds = Array.from(new Set(
        employees
          .map((row) => row.store_id)
          .filter((value): value is number => value != null),
      ));
      stores = await loadStoreRows(managedStoreIds);
      break;
    }
    case 'store_manager': {
      scope = 'store';
      const managedStoreIds = subject.store_id != null ? [subject.store_id] : [];
      stores = await loadStoreRows(managedStoreIds);
      employees = await query<AssociationEmployeeRow>(
        `SELECT
          u.id,
          u.company_id,
          c.name AS company_name,
          u.store_id,
          s.name AS store_name,
          u.supervisor_id,
          u.name,
          u.surname,
          u.email,
          u.role,
          u.status,
          u.avatar_filename
         FROM users u
         JOIN companies c ON c.id = u.company_id
         LEFT JOIN stores s ON s.id = u.store_id
         WHERE u.company_id = ANY($1)
           AND u.status = 'active'
           AND u.store_id = $2
         ORDER BY u.surname, u.name`,
        [scopedCompanyIds, subject.store_id ?? -1],
      );
      break;
    }
    case 'employee':
    case 'store_terminal': {
      scope = 'self';
      const selfStoreIds = subject.store_id != null ? [subject.store_id] : [];
      stores = await loadStoreRows(selfStoreIds);
      employees = await query<AssociationEmployeeRow>(
        `SELECT
          u.id,
          u.company_id,
          c.name AS company_name,
          u.store_id,
          s.name AS store_name,
          u.supervisor_id,
          u.name,
          u.surname,
          u.email,
          u.role,
          u.status,
          u.avatar_filename
         FROM users u
         JOIN companies c ON c.id = u.company_id
         LEFT JOIN stores s ON s.id = u.store_id
         WHERE u.company_id = ANY($1)
           AND u.status = 'active'
           AND (
             u.id = $2
             OR u.role IN ('hr', 'area_manager')
             OR (u.role = 'store_manager' AND $3::int IS NOT NULL AND u.store_id = $3)
           )
         ORDER BY
           CASE
             WHEN u.id = $2 THEN 0
             WHEN u.role = 'hr' THEN 1
             WHEN u.role = 'area_manager' THEN 2
             WHEN u.role = 'store_manager' THEN 3
             ELSE 4
           END,
           u.surname,
           u.name`,
        [scopedCompanyIds, empId, subject.store_id],
      );
      break;
    }
    default: {
      stores = [];
      employees = [];
      break;
    }
  }

  const companies = await query<AssociationCompanyRow>(
    `SELECT c.id, c.name, c.slug, c.is_active, c.logo_filename, cg.name AS group_name
     FROM companies c
     LEFT JOIN company_groups cg ON cg.id = c.group_id
     WHERE c.id = ANY($1)
     ORDER BY c.name`,
    [scopedCompanyIds],
  );

  const companyItems: AssociationCompanyItem[] = companies.map((company) => ({
    id: company.id,
    name: company.name,
    slug: company.slug,
    isActive: company.is_active,
    logoFilename: company.logo_filename,
    groupName: company.group_name,
    stores: [],
    unassignedEmployees: [],
    employeeCount: 0,
  }));

  const companyMap = new Map<number, AssociationCompanyItem>(
    companyItems.map((company) => [company.id, company]),
  );

  const storeMap = new Map<number, AssociationStoreItem>();
  for (const store of stores) {
    const parentCompany = companyMap.get(store.company_id);
    if (!parentCompany) continue;
    const storeItem: AssociationStoreItem = {
      id: store.id,
      name: store.name,
      code: store.code,
      isActive: store.is_active,
      logoFilename: store.logo_filename,
      employees: [],
    };
    parentCompany.stores.push(storeItem);
    storeMap.set(store.id, storeItem);
  }

  for (const employee of employees) {
    const parentCompany = companyMap.get(employee.company_id);
    if (!parentCompany) continue;

    const employeeItem: AssociationEmployeeItem = {
      id: employee.id,
      name: employee.name,
      surname: employee.surname,
      email: employee.email,
      role: employee.role,
      status: employee.status,
      companyId: employee.company_id,
      companyName: employee.company_name,
      storeId: employee.store_id,
      storeName: employee.store_name,
      supervisorId: employee.supervisor_id,
      avatarFilename: employee.avatar_filename,
    };

    parentCompany.employeeCount += 1;
    if (employee.store_id != null) {
      const parentStore = storeMap.get(employee.store_id);
      if (parentStore) {
        parentStore.employees.push(employeeItem);
      } else {
        parentCompany.unassignedEmployees.push(employeeItem);
      }
    } else {
      parentCompany.unassignedEmployees.push(employeeItem);
    }
  }

  for (const company of companyItems) {
    company.stores.sort((a, b) => a.name.localeCompare(b.name));
    for (const store of company.stores) {
      store.employees.sort((a, b) => `${a.surname} ${a.name}`.localeCompare(`${b.surname} ${b.name}`));
    }
    company.unassignedEmployees.sort((a, b) => `${a.surname} ${a.name}`.localeCompare(`${b.surname} ${b.name}`));
  }

  const summary = {
    companyCount: companyItems.length,
    storeCount: companyItems.reduce((acc, company) => acc + company.stores.length, 0),
    employeeCount: companyItems.reduce((acc, company) => acc + company.employeeCount, 0),
  };

  ok(res, {
    subject: {
      id: subject.id,
      role: subject.role,
      companyId: subject.company_id,
      companyName: subject.company_name,
      storeId: subject.store_id,
      storeName: subject.store_name,
      supervisorId: subject.supervisor_id,
      name: subject.name,
      surname: subject.surname,
      email: subject.email,
      status: subject.status,
      avatarFilename: subject.avatar_filename,
    },
    scope,
    summary,
    companies: companyItems,
  });
});

// POST /api/employees
export const createEmployee = asyncHandler(async (req: Request, res: Response) => {
  const { companyId: callerCompanyId, role: callerRole } = req.user!;
  const body = req.body as Record<string, any>;
  const offDays = normalizeOffDays(body.off_days);

  // Resolve target company: cross-company callers (grouped admin/hr/area_manager)
  // may specify a company_id in the body to create an employee in a sibling company.
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const requestedCompanyId = body.company_id ? parseInt(String(body.company_id), 10) : null;
  let companyId: number;
  if (requestedCompanyId !== null && !isNaN(requestedCompanyId)) {
    if (!allowedCompanyIds.includes(requestedCompanyId)) {
      forbidden(res, 'Accesso negato: azienda non valida'); return;
    }
    companyId = requestedCompanyId;
  } else {
    if (callerCompanyId == null) {
      badRequest(res, 'Impossibile creare il dipendente: azienda non valida', 'COMPANY_MISMATCH');
      return;
    }
    companyId = callerCompanyId;
  }

  // Privilege escalation guard: only admin may create another admin
  if (body.role === 'admin' && callerRole !== 'admin') {
    forbidden(res, 'Solo un amministratore può creare un utente con ruolo admin');
    return;
  }

  // Area managers may create employees, but cannot create management roles.
  if (callerRole === 'area_manager' && body.role !== 'employee') {
    forbidden(res, 'Un area manager può creare solo utenti con ruolo employee');
    return;
  }

  // Check unique_id uniqueness within company (if provided)
  if (body.unique_id) {
    const existingUniqueId = await queryOne<{ id: number }>(
      `SELECT id FROM users WHERE company_id = $1 AND unique_id = $2`,
      [companyId, body.unique_id],
    );
    if (existingUniqueId) {
      conflict(res, 'ID univoco già in uso in questa azienda', 'UNIQUE_ID_CONFLICT');
      return;
    }
  }

  // Check email uniqueness globally (email is unique across all companies)
  const emailExists = await queryOne<{ id: number }>(
    `SELECT id FROM users WHERE email = $1`,
    [body.email],
  );
  if (emailExists) {
    conflict(res, 'Email già registrata nel sistema', 'EMAIL_CONFLICT');
    return;
  }

  // M11: Validate store_id if provided
  if (body.store_id) {
    const storeIdInt = parseInt(body.store_id, 10);
    const storeError = await validateStore(storeIdInt, companyId!);
    if (storeError) {
      badRequest(res, storeError, 'INVALID_STORE');
      return;
    }

    // Check store capacity limit
    const storeInfo = await queryOne<{ max_staff: number }>(
      `SELECT max_staff FROM stores WHERE id = $1`,
      [storeIdInt]
    );
    if (storeInfo && storeInfo.max_staff > 0) {
      const activeCountRes = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM users WHERE store_id = $1 AND status = 'active' AND role != 'store_terminal'`,
        [storeIdInt]
      );
      const activeCount = activeCountRes ? activeCountRes.count : 0;
      if (activeCount >= storeInfo.max_staff) {
        const lang = (req.headers['x-lang'] || req.headers['accept-language'] || 'it').toString().toLowerCase();
        const isIt = lang.includes('it');
        const errMsg = isIt 
          ? 'La capienza del punto vendita è al completo' 
          : 'Store capacity is full';
        badRequest(res, errMsg, 'STORE_CAPACITY_FULL');
        return;
      }
    }
  }

  // M9: Validate supervisor_id if provided
  if (body.supervisor_id) {
    const supError = await validateSupervisor(parseInt(body.supervisor_id, 10), companyId!);
    if (supError) {
      badRequest(res, supError, 'INVALID_SUPERVISOR');
      return;
    }
  }

  // M10: Generate a cryptographically strong temp password (min 12 chars,
  // with uppercase, lowercase, and digits) when not explicitly supplied.
  // If a password IS supplied in the request body, enforce an 8-char minimum.
  let tempPassword: string;
  if (body.password) {
    if (body.password.length < 8) {
      badRequest(res, 'La password deve essere di almeno 8 caratteri', 'PASSWORD_TOO_SHORT');
      return;
    }
    tempPassword = body.password;
  } else {
    // Build a guaranteed-strong password: 16 base64url chars, then inject one
    // uppercase, one digit, and one lowercase to satisfy any downstream checks.
    const base = crypto.randomBytes(16).toString('base64url').slice(0, 12);
    const upper = String.fromCharCode(65 + (crypto.randomBytes(1)[0] % 26)); // A-Z
    const digit = String((crypto.randomBytes(1)[0] % 10));                   // 0-9
    const lower = String.fromCharCode(97 + (crypto.randomBytes(1)[0] % 26)); // a-z
    const extra = crypto.randomBytes(8).toString('base64url').slice(0, 1);
    tempPassword = upper + digit + lower + base + extra; // 16 chars total
  }
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  const employee = await queryOne(
    `INSERT INTO users (
      company_id, store_id, supervisor_id, name, surname, email, password_hash,
      role, unique_id, department, hire_date, contract_end_date,
      working_type, weekly_hours, off_days, personal_email, date_of_birth, nationality,
      gender, iban, address, cap, first_aid_flag, marital_status, status,
      contract_type, probation_months, termination_type, termination_date, phone,
      country, state, city, created_by, updated_by
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
      $31, $32, $33, $34, $34
    ) RETURNING id, company_id, name, surname, email, role, store_id, supervisor_id, unique_id, department,
        hire_date, contract_end_date, working_type, weekly_hours, off_days, personal_email, date_of_birth,
        nationality, gender, iban, address, cap, first_aid_flag, marital_status, status,
        contract_type, probation_months, termination_type, termination_date, phone,
        country, state, city, created_at`,
    [
      companyId,
      body.store_id ?? null,
      body.supervisor_id ?? null,
      body.name,
      body.surname,
      body.email,
      passwordHash,
      body.role,
      body.unique_id ?? null,
      body.department ?? null,
      body.hire_date ?? null,
      body.contract_end_date ?? null,
      body.working_type ?? null,
      body.weekly_hours ?? null,
      offDays,
      body.personal_email ?? null,
      body.date_of_birth ?? null,
      body.nationality ?? null,
      body.gender ?? null,
      body.iban ?? null,
      body.address ?? null,
      body.cap ?? null,
      body.first_aid_flag ?? false,
      body.marital_status ?? null,
      'active',
      body.contract_type ?? null,
      body.probation_months ?? null,
      body.termination_type ?? null,
      body.termination_date ?? null,
      body.phone ?? null,
      body.country ?? null,
      body.state ?? null,
      body.city ?? null,
      req.user!.userId,
    ],
  );
  // Check Welcome Email Automation (Background task, non-blocking)
  if (body.personal_email && typeof body.personal_email === 'string') {
    sendWelcomeEmailAutomation(
      companyId,
      employee.id,
      body.personal_email,
      { name: body.name, surname: body.surname, email: body.email },
      tempPassword
    ).catch(err => console.error('[AUTOMATION] Background welcome email error:', err));
  }

  created(res, employee, 'Dipendente creato con successo');
});

// PUT /api/employees/:id
export const updateEmployee = asyncHandler(async (req: Request, res: Response) => {
  const { role: callerRole } = req.user!;
  const empId = parseInt(req.params.id, 10);
  if (isNaN(empId)) { notFound(res, 'Dipendente non trovato'); return; }
  const body = req.body as Record<string, any>;

  // Resolve which companies the caller may operate on, then derive the target
  // company from the employee's actual record (scoped to the allowed set).
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const empRow = await queryOne<{ company_id: number; off_days: number[] | null }>(
    `SELECT company_id, COALESCE(off_days, ARRAY[5,6]::SMALLINT[]) AS off_days
     FROM users
     WHERE id = $1 AND company_id = ANY($2)`,
    [empId, allowedCompanyIds],
  );
  if (!empRow) { notFound(res, 'Dipendente non trovato'); return; }
  const currentCompanyId = empRow.company_id;
  const targetCompanyId = body.company_id ? parseInt(body.company_id, 10) : currentCompanyId;

  // H10: Cross-company transfer — verify caller's access to the target company
  if (targetCompanyId !== currentCompanyId && !allowedCompanyIds.includes(targetCompanyId)) {
    forbidden(res, 'Non sei autorizzato a spostare dipendenti in questa azienda');
    return;
  }

  const currentOffDays = normalizeOffDays(empRow.off_days);
  const nextOffDays = normalizeOffDays(body.off_days, currentOffDays);
  const offDaysChanged = Object.prototype.hasOwnProperty.call(body, 'off_days');
  const newlyAddedOffDays = offDaysChanged
    ? nextOffDays.filter((day) => !currentOffDays.includes(day))
    : [];

  // H1: Role escalation prevention — only admin and hr may change the role field
  if ('role' in body) {
    if (callerRole !== 'admin' && callerRole !== 'hr') {
      forbidden(res, 'Non sei autorizzato a modificare il ruolo di un dipendente');
      return;
    }
    // Privilege escalation guard: only admin may assign or keep the admin role
    if (body.role === 'admin' && callerRole !== 'admin') {
      forbidden(res, 'Solo un amministratore può assegnare il ruolo admin');
      return;
    }
  }

  // Check unique_id conflict (if provided and changed)
  if (body.unique_id) {
    const conflictRow = await queryOne<{ id: number }>(
      `SELECT id FROM users WHERE company_id = $1 AND unique_id = $2 AND id != $3`,
      [targetCompanyId, body.unique_id, empId],
    );
    if (conflictRow) {
      conflict(res, 'ID univoco già in uso in questa azienda', 'UNIQUE_ID_CONFLICT');
      return;
    }
  }

  // Check email uniqueness globally when email is being edited.
  if (typeof body.email === 'string' && body.email.trim().length > 0) {
    const nextEmail = body.email.trim();
    const emailConflict = await queryOne<{ id: number }>(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2`,
      [nextEmail, empId],
    );
    if (emailConflict) {
      conflict(res, 'Email già registrata nel sistema', 'EMAIL_CONFLICT');
      return;
    }
  }

  // M11: Validate store_id if provided (against target company)
  // IMPORTANT: Validate against targetCompanyId, not currentCompanyId, to allow cross-company transfers
  if (body.store_id) {
    const parsedStoreId = typeof body.store_id === 'string' ? parseInt(body.store_id, 10) : body.store_id;
    if (isNaN(parsedStoreId)) {
      badRequest(res, 'ID punto vendita non valido', 'INVALID_STORE_ID');
      return;
    }
    const storeError = await validateStore(parsedStoreId, targetCompanyId);
    if (storeError) {
      badRequest(res, storeError, 'INVALID_STORE');
      return;
    }
  }

  // M9: Validate supervisor_id if provided (against target company)
  // IMPORTANT: Validate against targetCompanyId, not currentCompanyId, to allow cross-company transfers
  if (body.supervisor_id) {
    const supError = await validateSupervisor(parseInt(body.supervisor_id, 10), targetCompanyId);
    if (supError) {
      badRequest(res, supError, 'INVALID_SUPERVISOR');
      return;
    }
  }

  let passwordHash: string | null = null;
  if (typeof body.password === 'string' && body.password.length > 0) {
    passwordHash = await bcrypt.hash(body.password, 12);
  }

  // IMPORTANT: The WHERE clause should only check the employee ID, not company_id,
  // because we're allowing cross-company transfers. We've already validated access above.
  const employee = await queryOne(
    `UPDATE users SET
      company_id = $1, store_id = $2, supervisor_id = $3, name = $4, surname = $5,
      email = COALESCE($6, email),
      role = $7, unique_id = $8, department = $9, hire_date = $10,
      contract_end_date = $11, working_type = $12, weekly_hours = $13,
      off_days = $14,
      personal_email = $15, date_of_birth = $16, nationality = $17,
      gender = $18, iban = $19, address = $20, cap = $21,
      country = $22, state = $23, city = $24, phone = $25,
      first_aid_flag = $26, marital_status = $27,
      contract_type = $28, probation_months = $29,
      termination_date = $30, termination_type = $31,
      password_hash = COALESCE($32, password_hash),
      updated_at = NOW(),
      updated_by = $34
    WHERE id = $33
    RETURNING id, company_id, name, surname, email, role, store_id, supervisor_id, unique_id, department,
        hire_date, contract_end_date, working_type, weekly_hours, off_days, personal_email, date_of_birth,
        nationality, gender, iban, address, cap, country, state, city, phone, first_aid_flag, marital_status, status,
        contract_type, probation_months, termination_date, termination_type, created_at, updated_at`,
    [
      targetCompanyId,
      body.store_id ?? null,
      body.supervisor_id ?? null,
      body.name,
      body.surname,
      typeof body.email === 'string' && body.email.trim().length > 0 ? body.email.trim() : null,
      body.role,
      body.unique_id ?? null,
      body.department ?? null,
      body.hire_date ?? null,
      body.contract_end_date ?? null,
      body.working_type ?? null,
      body.weekly_hours ?? null,
      nextOffDays,
      body.personal_email ?? null,
      body.date_of_birth ?? null,
      body.nationality ?? null,
      body.gender ?? null,
      body.iban ?? null,
      body.address ?? null,
      body.cap ?? null,
      body.country ?? null,
      body.state ?? null,
      body.city ?? null,
      body.phone ?? null,
      body.first_aid_flag ?? false,
      body.marital_status ?? null,
      body.contract_type ?? null,
      body.probation_months ?? null,
      body.termination_date ?? null,
      body.termination_type ?? null,
      passwordHash,
      empId,
      req.user!.userId,
    ],
  );

  if (!employee) {
    notFound(res, 'Dipendente non trovato');
    return;
  }

  if (newlyAddedOffDays.length > 0) {
    await query(
      `UPDATE shifts
       SET status = 'cancelled', updated_at = NOW()
       WHERE company_id = $1
         AND user_id = $2
         AND status IN ('scheduled', 'confirmed')
         AND date >= CURRENT_DATE
         AND ((EXTRACT(ISODOW FROM date)::int + 6) % 7) = ANY($3::int[])`,
      [targetCompanyId, empId, newlyAddedOffDays],
    );
  }

  ok(res, employee, 'Dipendente aggiornato');
});

// DELETE /api/employees/:id — soft deactivation only
export const deactivateEmployee = asyncHandler(async (req: Request, res: Response) => {
  const empId = parseInt(req.params.id, 10);
  if (isNaN(empId)) { notFound(res, 'Dipendente non trovato'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  const employee = await queryOne(
    `UPDATE users SET status = 'inactive', termination_date = CURRENT_DATE, updated_at = NOW()
     WHERE id = $1 AND company_id = ANY($2) AND status = 'active'
     RETURNING id, name, surname, email, role, status, termination_date`,
    [empId, allowedCompanyIds],
  );

  if (!employee) {
    notFound(res, 'Dipendente non trovato o già disattivato');
    return;
  }
  ok(res, employee, 'Dipendente disattivato');
});

// DELETE /api/employees/:id/permanent — hard delete (admin only)
export const deleteEmployeePermanently = asyncHandler(async (req: Request, res: Response) => {
  const empId = parseInt(req.params.id, 10);
  if (isNaN(empId)) { notFound(res, 'Dipendente non trovato'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: number; is_super_admin: boolean; avatar_filename: string | null }>(
      `SELECT id, is_super_admin, avatar_filename FROM users WHERE id = $1 AND company_id = ANY($2)`,
      [empId, allowedCompanyIds],
    );
    const target = rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      notFound(res, 'Dipendente non trovato');
      return;
    }
    if (target.is_super_admin) {
      await client.query('ROLLBACK');
      forbidden(res, 'Impossibile eliminare un super admin');
      return;
    }

    // Delete avatar physically if it exists
    if (target.avatar_filename) {
      const uploadDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads', 'avatars');
      const filePath = path.join(uploadDir, target.avatar_filename);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        console.error('Failed to delete physical avatar on permanent employee delete:', err);
      }
    }

    // Detach references that don't cascade
    await client.query(`UPDATE users SET supervisor_id = NULL WHERE supervisor_id = $1`, [empId]);
    await client.query(`UPDATE role_module_permissions SET updated_by = NULL WHERE updated_by = $1`, [empId]);
    await client.query(`UPDATE group_role_visibility SET updated_by = NULL WHERE updated_by = $1`, [empId]);
    await client.query(`UPDATE audit_logs SET user_id = NULL WHERE user_id = $1`, [empId]);
    await client.query(`UPDATE shifts SET created_by = NULL WHERE created_by = $1`, [empId]);
    await client.query(`UPDATE shift_templates SET created_by = NULL WHERE created_by = $1`, [empId]);
    await client.query(`UPDATE temporary_store_assignments SET created_by = NULL WHERE created_by = $1`, [empId]);
    await client.query(`UPDATE temporary_store_assignments SET cancelled_by = NULL WHERE cancelled_by = $1`, [empId]);
    await client.query(`UPDATE external_store_mappings SET created_by = NULL WHERE created_by = $1`, [empId]);
    await client.query(`UPDATE external_store_mappings SET updated_by = NULL WHERE updated_by = $1`, [empId]);
    await client.query(`UPDATE company_external_affluence_settings SET updated_by = NULL WHERE updated_by = $1`, [empId]);
    await client.query(`UPDATE onboarding_templates SET created_by_user_id = NULL WHERE created_by_user_id = $1`, [empId]);
    await client.query(`UPDATE employee_onboarding_tasks SET assigned_by_user_id = NULL WHERE assigned_by_user_id = $1`, [empId]);
    await client.query(`UPDATE companies SET owner_user_id = NULL WHERE owner_user_id = $1`, [empId]);
    await client.query(`UPDATE company_groups SET owner_user_id = NULL WHERE owner_user_id = $1`, [empId]);

    // Delete rows that would block deletion
    await client.query(`DELETE FROM window_display_activities WHERE flagged_by = $1`, [empId]);
    await client.query(`DELETE FROM attendance_events WHERE user_id = $1`, [empId]);
    await client.query(`DELETE FROM shifts WHERE user_id = $1`, [empId]);
    await client.query(`DELETE FROM leave_approvals WHERE approver_id = $1`, [empId]);
    await client.query(`DELETE FROM leave_approvals WHERE leave_request_id IN (SELECT id FROM leave_requests WHERE user_id = $1)`, [empId]);
    await client.query(`DELETE FROM leave_balances WHERE user_id = $1`, [empId]);
    await client.query(`DELETE FROM leave_requests WHERE user_id = $1`, [empId]);
    await client.query(`DELETE FROM documents WHERE uploaded_by = $1`, [empId]);

    const deleted = await client.query<{ id: number }>(
      `DELETE FROM users WHERE id = $1 RETURNING id`,
      [empId],
    );

    if (deleted.rowCount === 0) {
      await client.query('ROLLBACK');
      notFound(res, 'Dipendente non trovato');
      return;
    }

    await client.query('COMMIT');
    ok(res, { id: empId }, 'Dipendente eliminato definitivamente');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// PATCH /api/employees/:id/activate — Admin only
export const activateEmployee = asyncHandler(async (req: Request, res: Response) => {
  const empId = parseInt(req.params.id, 10);
  if (isNaN(empId)) { notFound(res, 'Dipendente non trovato'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  const employee = await queryOne(
    `UPDATE users SET status = 'active', termination_date = NULL, updated_at = NOW()
     WHERE id = $1 AND company_id = ANY($2) AND status = 'inactive'
     RETURNING id, name, surname, email, role, status, termination_date`,
    [empId, allowedCompanyIds],
  );

  if (!employee) {
    notFound(res, 'Dipendente non trovato o già attivo');
    return;
  }
  ok(res, employee, 'Dipendente riattivato');
});

// PATCH /api/employees/:id/device-reset — Admin/HR only
// Clears the stored device binding so the employee becomes "not registered".
export const resetEmployeeDevice = asyncHandler(async (req: Request, res: Response) => {
  const empId = parseInt(req.params.id, 10);
  if (isNaN(empId)) {
    notFound(res, 'Dipendente non trovato');
    return;
  }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  const employee = await queryOne(
    `UPDATE users
     SET device_reset_pending = false,
         registered_device_token = NULL,
         registered_device_identifier = NULL,
         registered_device_metadata = NULL,
         registered_device_registered_at = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND company_id = ANY($2)
       AND role IN ('employee', 'store_terminal', 'store_manager', 'area_manager', 'hr')
       AND status = 'active'
     RETURNING id, company_id, device_reset_pending,
               ((registered_device_token IS NOT NULL) OR (registered_device_identifier IS NOT NULL)) AS device_registered,
               registered_device_registered_at AS device_registered_at`,
     [empId, allowedCompanyIds],
  );

  if (!employee) {
    notFound(res, 'Dipendente non trovato');
    return;
  }

  // Log reset event in device_events
  let ipAddress = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '').split(',')[0].trim();
  if (ipAddress.startsWith('::ffff:')) {
    ipAddress = ipAddress.substring(7);
  }
  const ua = req.headers['user-agent'] || '';
  await query(
    `INSERT INTO device_events (user_id, event_type, ip_address, user_agent)
     VALUES ($1, 'reset', $2, $3)`,
    [empId, ipAddress, ua]
  ).catch(err => {
    console.error('Failed to log device reset event:', err);
  });

  // Real-time update for HR/Admin
  emitToCompany((employee as any).company_id, 'DEVICE_RESET', { userId: employee.id });

  ok(res, employee, 'Reset dispositivo richiesto');
});

// ---------------------------------------------------------------------------
// Employee Import Mapping Templates
// ---------------------------------------------------------------------------

export const getImportTemplates = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  if (!companyId) {
    badRequest(res, 'Azienda non specificata');
    return;
  }

  await query(`
    CREATE TABLE IF NOT EXISTS employee_import_templates (
      id SERIAL PRIMARY KEY,
      company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      mapping_json JSONB NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `).catch(() => {});

  const templates = await query(
    `SELECT id, company_id as "companyId", name, mapping_json as "mappingJson", created_at as "createdAt"
       FROM employee_import_templates
      WHERE company_id = $1
      ORDER BY name ASC`,
    [companyId]
  );

  ok(res, templates);
});

export const saveImportTemplate = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const { name, mappingJson } = req.body;

  if (!companyId) {
    badRequest(res, 'Azienda non specificata');
    return;
  }
  if (!name || !mappingJson) {
    badRequest(res, 'Nome e mappatura obbligatori');
    return;
  }

  await query(`
    CREATE TABLE IF NOT EXISTS employee_import_templates (
      id SERIAL PRIMARY KEY,
      company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      mapping_json JSONB NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `).catch(() => {});

  const template = await queryOne(
    `INSERT INTO employee_import_templates (company_id, name, mapping_json)
     VALUES ($1, $2, $3)
     RETURNING id, company_id as "companyId", name, mapping_json as "mappingJson", created_at as "createdAt"`,
    [companyId, name, JSON.stringify(mappingJson)]
  );

  ok(res, template, 'Template di mappatura salvato con successo');
});

export const deleteImportTemplate = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    badRequest(res, 'ID non valido');
    return;
  }

  const deleted = await queryOne(
    `DELETE FROM employee_import_templates WHERE id = $1 AND company_id = $2 RETURNING id`,
    [id, companyId]
  );

  if (!deleted) {
    notFound(res, 'Template non trovato');
    return;
  }

  ok(res, { id }, 'Template eliminato');
});

