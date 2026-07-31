import { Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, badRequest, forbidden } from '../../utils/response';
import { pool, query } from '../../config/database';
import { resolveAllowedCompanyIds } from '../../utils/companyScope';

/**
 * Bulk employee import.
 *
 * Created as a dedicated endpoint rather than looping the single-create route
 * from the browser: that loop had no transaction, so a failure on row 30 of 50
 * left 29 employees behind with no way to undo them. Here every valid row is
 * inserted inside one transaction — either all of them land or none do.
 *
 * Rows that cannot be imported are reported back per-row instead of aborting the
 * whole file, so an operator can fix a handful of bad rows without losing the
 * good ones. Warnings (e.g. store over capacity) never block.
 */

/** Roles an import may create. 'admin' is deliberately excluded — see below. */
const IMPORTABLE_ROLES = ['hr', 'area_manager', 'store_manager', 'employee'] as const;
type ImportableRole = (typeof IMPORTABLE_ROLES)[number];

/** Machine-readable reasons, translated client-side so both locales work. */
export type RowErrorCode =
  | 'MISSING_REQUIRED'
  | 'INVALID_EMAIL'
  | 'DUPLICATE_EMAIL_IN_FILE'
  | 'EMAIL_ALREADY_EXISTS'
  | 'COMPANY_NOT_FOUND'
  | 'COMPANY_NOT_ALLOWED'
  | 'STORE_NOT_FOUND'
  | 'STORE_WRONG_COMPANY'
  | 'INVALID_ROLE'
  | 'ADMIN_ROLE_NOT_ALLOWED';

export type RowWarningCode =
  | 'STORE_OVER_CAPACITY'
  | 'SUPERVISOR_NOT_FOUND'
  | 'UNKNOWN_VALUE_IGNORED';

/**
 * Snake_case throughout: the axios client snake-cases every request body, so
 * this is the shape that actually arrives — same convention as createEmployee.
 */
interface IncomingRow {
  row_index: number;
  company_id?: number | null;
  store_id?: number | null;
  supervisor_id?: number | null;
  name?: string;
  surname?: string;
  email?: string;
  personal_email?: string | null;
  role?: string;
  status?: string;
  department?: string | null;
  hire_date?: string | null;
  contract_end_date?: string | null;
  working_type?: string | null;
  weekly_hours?: number | null;
  date_of_birth?: string | null;
  nationality?: string | null;
  gender?: string | null;
  iban?: string | null;
  address?: string | null;
  cap?: string | null;
  phone?: string | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  first_aid_flag?: boolean;
  marital_status?: string | null;
  contract_type?: string | null;
  probation_months?: number | null;
  termination_date?: string | null;
  termination_type?: string | null;
  /** Echoed back in messages so the operator recognises the row. */
  company_name?: string;
  store_name?: string;
}

interface RowFailure {
  rowIndex: number;
  code: RowErrorCode;
  detail?: string;
}

interface RowWarning {
  rowIndex: number;
  code: RowWarningCode;
  detail?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateUniqueId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = 'EMP-';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) id += chars[bytes[i] % chars.length];
  return id;
}

function generateTempPassword(): string {
  const base = crypto.randomBytes(16).toString('base64url').slice(0, 12);
  const upper = String.fromCharCode(65 + (crypto.randomBytes(1)[0] % 26));
  const digit = String(crypto.randomBytes(1)[0] % 10);
  const lower = String.fromCharCode(97 + (crypto.randomBytes(1)[0] % 26));
  const extra = crypto.randomBytes(8).toString('base64url').slice(0, 1);
  return upper + digit + lower + base + extra;
}

export const bulkImportEmployees = asyncHandler(async (req: Request, res: Response) => {
  const rows: IncomingRow[] = Array.isArray(req.body?.rows) ? req.body.rows : [];

  if (rows.length === 0) {
    badRequest(res, 'Nessuna riga da importare', 'NO_ROWS');
    return;
  }
  if (rows.length > 2000) {
    badRequest(res, 'Massimo 2000 righe per importazione', 'TOO_MANY_ROWS');
    return;
  }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) {
    forbidden(res, 'Nessuna azienda valida selezionata');
    return;
  }

  // ── Reference data, fetched once rather than per row ──────────────────────
  const stores = await query<{ id: number; company_id: number; max_staff: number | null }>(
    `SELECT id, company_id, max_staff FROM stores WHERE company_id = ANY($1::int[])`,
    [allowedCompanyIds],
  );
  const storeById = new Map(stores.map((s) => [s.id, s]));

  // Current headcount per store, so capacity warnings account for the whole batch.
  const counts = await query<{ store_id: number; count: number }>(
    `SELECT store_id, COUNT(*)::int AS count
       FROM users
      WHERE store_id = ANY($1::int[]) AND status = 'active' AND role <> 'store_terminal'
      GROUP BY store_id`,
    [stores.map((s) => s.id)],
  );
  const headcount = new Map(counts.map((c) => [c.store_id, c.count]));

  const emails = rows.map((r) => (r.email ?? '').trim().toLowerCase()).filter(Boolean);
  const existing = emails.length
    ? await query<{ email: string }>(
        `SELECT LOWER(email) AS email FROM users WHERE LOWER(email) = ANY($1::text[])`,
        [emails],
      )
    : [];
  const takenEmails = new Set(existing.map((e) => e.email));

  // ── Validation pass: decide every row's fate before touching the database ──
  const failures: RowFailure[] = [];
  const warnings: RowWarning[] = [];
  const valid: Array<IncomingRow & { role: ImportableRole; companyId: number }> = [];
  const seenInFile = new Set<string>();

  for (const row of rows) {
    const email = (row.email ?? '').trim().toLowerCase();
    const fail = (code: RowErrorCode, detail?: string) => {
      failures.push({ rowIndex: row.row_index, code, detail });
    };

    if (!row.name?.trim() || !row.surname?.trim() || !email) {
      fail('MISSING_REQUIRED');
      continue;
    }
    if (!EMAIL_RE.test(email)) {
      fail('INVALID_EMAIL', row.email);
      continue;
    }
    if (seenInFile.has(email)) {
      fail('DUPLICATE_EMAIL_IN_FILE', email);
      continue;
    }
    if (takenEmails.has(email)) {
      fail('EMAIL_ALREADY_EXISTS', email);
      continue;
    }

    const roleRaw = (row.role ?? '').trim().toLowerCase().replace(/\s+/g, '_');

    // An import must never be able to mint an administrator: the file comes from
    // an external HR system and nothing in it is trustworthy enough to grant
    // full tenant access. Admins are created deliberately, by hand.
    if (roleRaw === 'admin' || roleRaw === 'super_admin') {
      fail('ADMIN_ROLE_NOT_ALLOWED', row.role);
      continue;
    }
    if (!IMPORTABLE_ROLES.includes(roleRaw as ImportableRole)) {
      fail('INVALID_ROLE', row.role);
      continue;
    }

    if (!row.company_id) {
      fail('COMPANY_NOT_FOUND', row.company_name);
      continue;
    }
    if (!allowedCompanyIds.includes(row.company_id)) {
      fail('COMPANY_NOT_ALLOWED', row.company_name);
      continue;
    }

    if (row.store_id != null) {
      const store = storeById.get(row.store_id);
      if (!store) {
        fail('STORE_NOT_FOUND', row.store_name);
        continue;
      }
      if (store.company_id !== row.company_id) {
        fail('STORE_WRONG_COMPANY', row.store_name);
        continue;
      }

      // Capacity is a warning, never a block: an over-full store is a staffing
      // decision for HR to resolve, not a reason to reject payroll data.
      if (store.max_staff && store.max_staff > 0) {
        const next = (headcount.get(store.id) ?? 0) + 1;
        headcount.set(store.id, next);
        if (next > store.max_staff) {
          warnings.push({
            rowIndex: row.row_index,
            code: 'STORE_OVER_CAPACITY',
            detail: `${row.store_name ?? store.id}: ${next}/${store.max_staff}`,
          });
        }
      }
    }

    // An unresolved supervisor is reported by the wizard's own validation, which
    // knows whether the file even had that column. Repeating it here would warn
    // on every row of every file that simply omits a supervisor.

    seenInFile.add(email);
    valid.push({ ...row, role: roleRaw as ImportableRole, companyId: row.company_id });
  }

  if (valid.length === 0) {
    ok(res, { created: [], createdCount: 0, failures, warnings });
    return;
  }

  // ── Insert pass: one transaction for the whole batch ──────────────────────
  const client = await pool.connect();
  const created: Array<{ rowIndex: number; id: number; email: string; uniqueId: string }> = [];

  try {
    await client.query('BEGIN');

    for (const row of valid) {
      const passwordHash = await bcrypt.hash(generateTempPassword(), 12);

      // unique_id is generated server-side and retried on the (company_id,
      // unique_id) constraint so two rows can never collide.
      let inserted: { id: number; unique_id: string } | null = null;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        const uniqueId = generateUniqueId();
        try {
          const result = await client.query<{ id: number; unique_id: string }>(
            `INSERT INTO users (
               company_id, store_id, supervisor_id, name, surname, email, password_hash,
               role, unique_id, department, hire_date, contract_end_date,
               working_type, weekly_hours, personal_email, date_of_birth, nationality,
               gender, iban, address, cap, first_aid_flag, marital_status, status,
               contract_type, probation_months, termination_type, termination_date, phone,
               country, state, city, created_by, updated_by
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$33
             ) RETURNING id, unique_id`,
            [
              row.company_id,
              row.store_id ?? null,
              row.supervisor_id ?? null,
              row.name!.trim(),
              row.surname!.trim(),
              row.email!.trim(),
              passwordHash,
              row.role,
              uniqueId,
              row.department ?? null,
              row.hire_date || null,
              row.contract_end_date || null,
              row.working_type ?? null,
              row.weekly_hours ?? null,
              row.personal_email ?? null,
              row.date_of_birth || null,
              row.nationality ?? null,
              row.gender ?? null,
              row.iban ?? null,
              row.address ?? null,
              row.cap ?? null,
              row.first_aid_flag ?? false,
              row.marital_status ?? null,
              row.status === 'inactive' ? 'inactive' : 'active',
              row.contract_type ?? null,
              row.probation_months ?? null,
              row.termination_type ?? null,
              row.termination_date || null,
              row.phone ?? null,
              row.country ?? null,
              row.state ?? null,
              row.city ?? null,
              req.user!.userId,
            ],
          );
          inserted = result.rows[0];
        } catch (err) {
          const pgErr = err as { code?: string; constraint?: string };
          if (pgErr.code === '23505' && pgErr.constraint === 'users_unique_id_company') {
            continue; // regenerate and retry
          }
          throw err;
        }
      }

      if (!inserted) {
        throw new Error(`Could not allocate a unique ID for row ${row.row_index}`);
      }

      created.push({
        rowIndex: row.row_index,
        id: inserted.id,
        email: row.email!.trim(),
        uniqueId: inserted.unique_id,
      });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[bulk-import] transaction rolled back, no employees created:', err);
    badRequest(
      res,
      "Importazione annullata: nessun dipendente è stato creato. Riprova o correggi il file.",
      'BULK_IMPORT_FAILED',
    );
    return;
  } finally {
    client.release();
  }

  // Audit trail: one entry per created employee, matching the single-create path.
  for (const c of created) {
    const row = valid.find((v) => v.row_index === c.rowIndex)!;
    await query(
      `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
       VALUES ($1, $2, 'BULK_IMPORT_CREATE', 'user', $3, $4)`,
      [row.company_id, req.user!.userId, c.id, JSON.stringify({ email: c.email, role: row.role })],
    ).catch(() => undefined);
  }

  ok(res, {
    created,
    createdCount: created.length,
    failures,
    warnings,
  });
});

/**
 * Reference data the import wizard needs to validate a file before uploading it.
 *
 * Returned as one call rather than deriving it from the paginated employee list:
 * that list is capped, so a large tenant would have silently missed duplicate
 * emails and under-reported store headcount.
 */
export const getImportPrecheck = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) {
    forbidden(res, 'Nessuna azienda valida selezionata');
    return;
  }

  // Every work email in scope, so "already exists" is accurate for the tenant.
  const emailRows = await query<{ email: string }>(
    `SELECT LOWER(email) AS email FROM users WHERE company_id = ANY($1::int[])`,
    [allowedCompanyIds],
  );

  const storeRows = await query<{
    id: number;
    name: string;
    company_id: number;
    max_staff: number | null;
    active_count: number;
  }>(
    `SELECT s.id,
            s.name,
            s.company_id,
            s.max_staff,
            COALESCE(u.cnt, 0)::int AS active_count
       FROM stores s
       LEFT JOIN (
         SELECT store_id, COUNT(*)::int AS cnt
           FROM users
          WHERE status = 'active' AND role <> 'store_terminal'
          GROUP BY store_id
       ) u ON u.store_id = s.id
      WHERE s.company_id = ANY($1::int[])
      ORDER BY s.name`,
    [allowedCompanyIds],
  );

  ok(res, {
    emails: emailRows.map((r) => r.email),
    stores: storeRows.map((s) => ({
      id: s.id,
      name: s.name,
      companyId: s.company_id,
      maxStaff: s.max_staff ?? 0,
      activeCount: s.active_count,
    })),
  });
});
