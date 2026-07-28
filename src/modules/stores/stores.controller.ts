import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pool, query, queryOne } from '../../config/database';
import { ok, created, notFound, conflict, forbidden, badRequest } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { resolveAllowedCompanyIds } from '../../utils/companyScope';
import {
  DEFAULT_SHIFT_TIMEZONE,
  normalizeShiftTimezone,
  suggestTimezoneFromCountry,
} from '../../utils/shiftTimezone';

interface StoreRow {
  id: number;
  company_id: number;
  company_name?: string;
  group_name?: string | null;
  company_logo_filename?: string | null;
  logo_filename?: string | null;
  name: string;
  code: string;
  address: string | null;
  cap: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  timezone: string | null;
  max_staff: number;
  is_active: boolean;
  created_at: string;
  updated_at?: string | null;
  created_by_name?: string | null;
  updated_by_name?: string | null;
  employee_count?: number;
}

interface StoreOperatingHourRow {
  id: number;
  store_id: number;
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  peak_start_time: string | null;
  peak_end_time: string | null;
  planned_shift_count: number | null;
  planned_staff_count: number | null;
  shift_plan_notes: string | null;
  is_closed: boolean;
}

function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const [hours, minutes] = value.split(':').map((part) => parseInt(part, 10));
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return (hours * 60) + minutes;
}

// GET /api/stores — scoped by role
// Super Admin: all stores across all companies (optional ?target_company_id=N filter)
// Admin/HR: all stores in their company
// Area Manager: stores where they are supervisor (derived from supervised employees)
// Store Manager: their own store only
export const listStores = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, role, userId, storeId } = req.user!;

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const hasCrossCompanyAccess = allowedCompanyIds.length > 1;

  let stores: StoreRow[];

  const { target_company_id } = req.query as Record<string, string>;
  const targetId = target_company_id ? parseInt(target_company_id, 10) : null;
  if (targetId !== null && !allowedCompanyIds.includes(targetId)) {
    res.status(403).json({ success: false, error: 'Accesso negato: azienda non valida', code: 'COMPANY_MISMATCH' });
    return;
  }

  const companyFilter = targetId !== null ? [targetId] : allowedCompanyIds;

  const isSuperAdmin = req.user!.is_super_admin === true;
  if (role === 'admin' || role === 'hr' || role === 'area_manager' || isSuperAdmin) {
    // Admin/HR/Area Manager can list stores inside the allowed companies scope
    stores = await query<StoreRow>(`
      SELECT s.*,
        c.name AS company_name,
        cg.name AS group_name,
        c.logo_filename AS company_logo_filename,
        (SELECT COUNT(*) FROM users u WHERE u.store_id = s.id AND u.status = 'active' AND u.role != 'store_terminal')::int AS employee_count
      FROM stores s
      JOIN companies c ON c.id = s.company_id
      LEFT JOIN company_groups cg ON cg.id = c.group_id
      WHERE s.company_id = ANY($1)
      ORDER BY s.name
    `, [companyFilter]);
  } else if (role === 'store_manager') {
    stores = await query<StoreRow>(`
      SELECT s.*,
        c.name AS company_name,
        cg.name AS group_name,
        c.logo_filename AS company_logo_filename,
        (SELECT COUNT(*) FROM users u WHERE u.store_id = s.id AND u.status = 'active' AND u.role != 'store_terminal')::int AS employee_count
      FROM stores s
      JOIN companies c ON c.id = s.company_id
      LEFT JOIN company_groups cg ON cg.id = c.group_id
      WHERE s.id = $1 AND s.company_id = $2 AND s.is_active = true
    `, [storeId, companyId]);
  } else {
    stores = [];
  }

  ok(res, stores);
});

// GET /api/stores/:id
export const getStore = asyncHandler(async (req: Request, res: Response) => {
  const { role, storeId: userStoreId } = req.user!;
  const storeId = parseInt(req.params.id, 10);
  if (isNaN(storeId)) { notFound(res, 'Negozio non trovato'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  const store = await queryOne<StoreRow>(
    `SELECT s.*, c.name AS company_name, cg.name AS group_name, c.logo_filename AS company_logo_filename,
            TRIM(CONCAT(cb.name, ' ', cb.surname)) AS created_by_name,
            TRIM(CONCAT(ub.name, ' ', ub.surname)) AS updated_by_name,
            (SELECT COUNT(*) FROM users u WHERE u.store_id = s.id AND u.status = 'active' AND u.role != 'store_terminal')::int AS employee_count
     FROM stores s
     JOIN companies c ON c.id = s.company_id
     LEFT JOIN company_groups cg ON cg.id = c.group_id
     LEFT JOIN users cb ON cb.id = s.created_by
     LEFT JOIN users ub ON ub.id = s.updated_by
     WHERE s.id = $1 AND s.company_id = ANY($2)`,
    [storeId, allowedCompanyIds]
  );
  if (!store) { notFound(res, 'Negozio non trovato'); return; }

  // Store manager can only see their own store
  if (role === 'store_manager' && store.id !== userStoreId) {
    forbidden(res, 'Accesso negato a questo negozio'); return;
  }

  ok(res, store);
});

// GET /api/stores/:id/operating-hours
export const listStoreOperatingHours = asyncHandler(async (req: Request, res: Response) => {
  const { role, storeId: callerStoreId } = req.user!;
  const storeId = parseInt(req.params.id, 10);
  if (isNaN(storeId)) { notFound(res, 'Negozio non trovato'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const store = await queryOne<{ id: number }>(
    `SELECT id FROM stores WHERE id = $1 AND company_id = ANY($2)`,
    [storeId, allowedCompanyIds],
  );
  if (!store) { notFound(res, 'Negozio non trovato'); return; }

  if (role === 'store_manager' && callerStoreId !== storeId) {
    forbidden(res, 'Accesso negato a questo negozio');
    return;
  }

  const hours = await query<StoreOperatingHourRow>(
    `SELECT id,
            store_id,
            day_of_week,
            CASE WHEN open_time IS NOT NULL THEN TO_CHAR(open_time, 'HH24:MI') ELSE NULL END AS open_time,
            CASE WHEN close_time IS NOT NULL THEN TO_CHAR(close_time, 'HH24:MI') ELSE NULL END AS close_time,
            CASE WHEN peak_start_time IS NOT NULL THEN TO_CHAR(peak_start_time, 'HH24:MI') ELSE NULL END AS peak_start_time,
            CASE WHEN peak_end_time IS NOT NULL THEN TO_CHAR(peak_end_time, 'HH24:MI') ELSE NULL END AS peak_end_time,
            planned_shift_count,
            planned_staff_count,
            shift_plan_notes,
            is_closed
     FROM store_operating_hours
     WHERE store_id = $1
     ORDER BY day_of_week`,
    [storeId],
  );

  ok(res, { hours });
});

// PUT /api/stores/:id/operating-hours
export const updateStoreOperatingHours = asyncHandler(async (req: Request, res: Response) => {
  const { role, storeId: callerStoreId } = req.user!;
  const storeId = parseInt(req.params.id, 10);
  if (isNaN(storeId)) { notFound(res, 'Negozio non trovato'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const store = await queryOne<{ id: number }>(
    `SELECT id FROM stores WHERE id = $1 AND company_id = ANY($2)`,
    [storeId, allowedCompanyIds],
  );
  if (!store) { notFound(res, 'Negozio non trovato'); return; }

  if (role === 'store_manager' && callerStoreId !== storeId) {
    forbidden(res, 'Accesso negato a questo negozio');
    return;
  }

  type OperatingHoursInput = {
    day_of_week: number;
    open_time?: string | null;
    close_time?: string | null;
    peak_start_time?: string | null;
    peak_end_time?: string | null;
    planned_shift_count?: number | null;
    planned_staff_count?: number | null;
    shift_plan_notes?: string | null;
    is_closed: boolean;
  };

  const payload = (req.body as { hours?: OperatingHoursInput[] }).hours ?? [];
  const seen = new Set<number>();
  for (const item of payload) {
    if (seen.has(item.day_of_week)) {
      badRequest(res, 'Giorni duplicati negli orari operativi', 'VALIDATION_ERROR');
      return;
    }
    seen.add(item.day_of_week);

    if (!item.is_closed) {
      if (!item.open_time || !item.close_time) {
        badRequest(res, 'Orari apertura/chiusura obbligatori quando il negozio è aperto', 'VALIDATION_ERROR');
        return;
      }
      if (item.close_time <= item.open_time) {
        badRequest(res, 'L\'orario di chiusura deve essere successivo all\'apertura', 'VALIDATION_ERROR');
        return;
      }
    }

    const peakStart = item.is_closed ? null : (item.peak_start_time ?? null);
    const peakEnd = item.is_closed ? null : (item.peak_end_time ?? null);

    if ((peakStart && !peakEnd) || (!peakStart && peakEnd)) {
      badRequest(res, 'Fascia di picco non valida: inizio e fine sono entrambi obbligatori', 'VALIDATION_ERROR');
      return;
    }

    if (peakStart && peakEnd) {
      if (peakEnd <= peakStart) {
        badRequest(res, 'La fine della fascia di picco deve essere successiva all\'inizio', 'VALIDATION_ERROR');
        return;
      }

      const openMinutes = timeToMinutes(item.open_time ?? null);
      const closeMinutes = timeToMinutes(item.close_time ?? null);
      const peakStartMinutes = timeToMinutes(peakStart);
      const peakEndMinutes = timeToMinutes(peakEnd);

      if (
        openMinutes == null ||
        closeMinutes == null ||
        peakStartMinutes == null ||
        peakEndMinutes == null ||
        peakStartMinutes < openMinutes ||
        peakEndMinutes > closeMinutes
      ) {
        badRequest(res, 'La fascia di picco deve rientrare negli orari di apertura del giorno', 'VALIDATION_ERROR');
        return;
      }
    }
  }

  await query(
    `DELETE FROM store_operating_hours WHERE store_id = $1`,
    [storeId],
  );

  for (const item of payload) {
    const shiftPlanNotes = item.is_closed
      ? null
      : (item.shift_plan_notes ? item.shift_plan_notes.trim() : null);

    await query(
      `INSERT INTO store_operating_hours (
         store_id,
         day_of_week,
         open_time,
         close_time,
         peak_start_time,
         peak_end_time,
         planned_shift_count,
         planned_staff_count,
         shift_plan_notes,
         is_closed
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        storeId,
        item.day_of_week,
        item.is_closed ? null : item.open_time,
        item.is_closed ? null : item.close_time,
        item.is_closed ? null : (item.peak_start_time ?? null),
        item.is_closed ? null : (item.peak_end_time ?? null),
        item.is_closed ? null : (item.planned_shift_count ?? null),
        item.is_closed ? null : (item.planned_staff_count ?? null),
        shiftPlanNotes,
        item.is_closed,
      ],
    );
  }

  const hours = await query<StoreOperatingHourRow>(
    `SELECT id,
            store_id,
            day_of_week,
            CASE WHEN open_time IS NOT NULL THEN TO_CHAR(open_time, 'HH24:MI') ELSE NULL END AS open_time,
            CASE WHEN close_time IS NOT NULL THEN TO_CHAR(close_time, 'HH24:MI') ELSE NULL END AS close_time,
            CASE WHEN peak_start_time IS NOT NULL THEN TO_CHAR(peak_start_time, 'HH24:MI') ELSE NULL END AS peak_start_time,
            CASE WHEN peak_end_time IS NOT NULL THEN TO_CHAR(peak_end_time, 'HH24:MI') ELSE NULL END AS peak_end_time,
            planned_shift_count,
            planned_staff_count,
            shift_plan_notes,
            is_closed
     FROM store_operating_hours
     WHERE store_id = $1
     ORDER BY day_of_week`,
    [storeId],
  );

  ok(res, { hours }, 'Orari operativi aggiornati');
});

// POST /api/stores — Admin/HR (within allowed companies)
export const createStore = asyncHandler(async (req: Request, res: Response) => {
  const { companyId: callerCompanyId } = req.user!;
  const { name, code, address, cap, city, state, country, phone, timezone, max_staff, company_id, terminal } = req.body as {
    name: string;
    code: string;
    address?: string | null;
    cap?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    phone?: string | null;
    timezone?: string | null;
    max_staff?: number;
    company_id?: number | null;
    terminal?: { email: string; password?: string };
  };

  const normalizedCode = String(code ?? '').trim().toUpperCase();
  const timezoneFallback = suggestTimezoneFromCountry(country, DEFAULT_SHIFT_TIMEZONE);
  const normalizedTimezone = normalizeShiftTimezone(timezone, timezoneFallback);

  // Cross-company callers (grouped admin/hr) may specify a target company.
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const requestedId = company_id != null ? Number(company_id) : null;
  let targetCompanyId: number;
  if (requestedId !== null && !isNaN(requestedId)) {
    if (!allowedCompanyIds.includes(requestedId)) {
      forbidden(res, 'Accesso negato: azienda non valida'); return;
    }
    targetCompanyId = requestedId;
  } else {
    if (callerCompanyId == null) {
      badRequest(res, "Impossibile creare il negozio: azienda non valida", 'COMPANY_MISMATCH'); return;
    }
    targetCompanyId = callerCompanyId;
  }

  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM stores WHERE company_id = $1 AND code = $2`,
    [targetCompanyId, normalizedCode]
  );
  if (existing) { conflict(res, 'Codice negozio già in uso', 'CODE_CONFLICT'); return; }

  if (terminal?.email) {
    const emailExists = await queryOne<{ id: number }>(
      `SELECT id FROM users WHERE email = $1`,
      [terminal.email]
    );
    if (emailExists) { conflict(res, 'Email del terminale già in uso', 'EMAIL_CONFLICT'); return; }
  }

  // Validate terminal password minimum length
  if (terminal?.password !== undefined && terminal.password.length < 8) {
    badRequest(res, 'La password del terminale deve essere di almeno 8 caratteri', 'PASSWORD_TOO_SHORT');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const storeRes = await client.query(
      `INSERT INTO stores (
         company_id,
         name,
         code,
         address,
         cap,
         city,
         state,
         country,
         phone,
         timezone,
         max_staff,
         created_by,
         updated_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       RETURNING *`,
      [
        targetCompanyId,
        name,
        normalizedCode,
        address || null,
        cap || null,
        city || null,
        state || null,
        country || null,
        phone || null,
        normalizedTimezone,
        max_staff || 0,
        req.user!.userId,
      ]
    );
    const store = storeRes.rows[0];

    // Create terminal account if requested
    if (terminal?.email && terminal?.password) {
      const passwordHash = await bcrypt.hash(terminal.password, 12);
      await client.query(
        `INSERT INTO users (
           company_id, store_id, name, surname, email, password_hash, role, status, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, 'store_terminal', 'active', $7, $7)`,
        [targetCompanyId, store.id, store.name, 'Terminale', terminal.email, passwordHash, req.user!.userId]
      );
    }

    await client.query('COMMIT');
    created(res, store, 'Negozio creato con successo');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// PUT /api/stores/:id — Admin/HR (within allowed companies)
export const updateStore = asyncHandler(async (req: Request, res: Response) => {
  const storeId = parseInt(req.params.id, 10);
  if (isNaN(storeId)) { notFound(res, 'Negozio non trovato'); return; }
  const { name, code, address, cap, city, state, country, phone, timezone, max_staff } = req.body;
  const normalizedCode = String(code ?? '').trim().toUpperCase();

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const storeRow = await queryOne<{ company_id: number; timezone: string | null; country: string | null }>(
    `SELECT company_id, timezone, country FROM stores WHERE id = $1 AND company_id = ANY($2)`,
    [storeId, allowedCompanyIds],
  );
  const targetCompanyId = storeRow?.company_id ?? null;

  if (targetCompanyId == null) {
    notFound(res, 'Negozio non trovato');
    return;
  }

  const timezoneFallback = suggestTimezoneFromCountry(
    country ?? storeRow?.country ?? null,
    storeRow?.timezone ?? DEFAULT_SHIFT_TIMEZONE,
  );
  const normalizedTimezone = normalizeShiftTimezone(timezone, timezoneFallback);

  // Check code uniqueness (excluding current store)
  const codeConflict = await queryOne<{ id: number }>(
    `SELECT id FROM stores WHERE company_id = $1 AND code = $2 AND id != $3`,
    [targetCompanyId, normalizedCode, storeId]
  );
  if (codeConflict) { conflict(res, 'Codice negozio già in uso', 'CODE_CONFLICT'); return; }

  const store = await queryOne<StoreRow>(
    `UPDATE stores
     SET name = $1,
         code = $2,
         address = $3,
         cap = $4,
         city = $5,
         state = $6,
         country = $7,
         phone = $8,
         timezone = $9,
         max_staff = $10,
         updated_at = NOW(),
         updated_by = $13
     WHERE id = $11 AND company_id = $12
     RETURNING *`,
    [
      name,
      normalizedCode,
      address || null,
      cap || null,
      city || null,
      state || null,
      country || null,
      phone || null,
      normalizedTimezone,
      max_staff || 0,
      storeId,
      targetCompanyId,
      req.user!.userId,
    ]
  );
  if (!store) { notFound(res, 'Negozio non trovato'); return; }
  ok(res, store, 'Negozio aggiornato');
});

// DELETE /api/stores/:id — Admin/HR (within allowed companies, soft delete)
export const deactivateStore = asyncHandler(async (req: Request, res: Response) => {
  const storeId = parseInt(req.params.id, 10);
  if (isNaN(storeId)) { notFound(res, 'Negozio non trovato'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const storeRow = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM stores WHERE id = $1 AND company_id = ANY($2)`,
    [storeId, allowedCompanyIds],
  );
  const targetCompanyId = storeRow?.company_id ?? null;

  if (targetCompanyId == null) {
    notFound(res, 'Negozio non trovato');
    return;
  }

  const store = await queryOne<StoreRow>(
    `UPDATE stores SET is_active = false WHERE id = $1 AND company_id = $2 RETURNING *`,
    [storeId, targetCompanyId]
  );
  // Sync terminal status to inactive
  await query(
    `UPDATE users SET status = 'inactive' WHERE store_id = $1 AND company_id = $2 AND role = 'store_terminal'`,
    [storeId, targetCompanyId]
  );

  ok(res, store, 'Negozio disattivato');
});

// DELETE /api/stores/:id/permanent — Admin only, hard delete
// Refuses if any human employee (role != 'store_terminal') is still assigned to this store
export const deleteStorePermanent = asyncHandler(async (req: Request, res: Response) => {
  const storeId = parseInt(req.params.id, 10);
  if (isNaN(storeId)) { notFound(res, 'Negozio non trovato'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const storeRow = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM stores WHERE id = $1 AND company_id = ANY($2)`,
    [storeId, allowedCompanyIds],
  );
  const targetCompanyId = storeRow?.company_id ?? null;

  if (targetCompanyId == null) {
    notFound(res, 'Negozio non trovato');
    return;
  }

  // Refuse if any human employee (role != 'store_terminal') is still assigned to this store
  const humanUserCount = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM users
     WHERE store_id = $1 AND company_id = $2 AND role != 'store_terminal'`,
    [storeId, targetCompanyId]
  );

  if (parseInt(humanUserCount?.count ?? '0', 10) > 0) {
    conflict(res, 'Impossibile eliminare: il negozio ha dipendenti assegnati. Riassegnarli prima di procedere.', 'STORE_HAS_EMPLOYEES');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Identify terminal users linked to this store
    const terminals = await client.query<{ id: number }>(
      `SELECT id FROM users WHERE store_id = $1 AND company_id = $2 AND role = 'store_terminal'`,
      [storeId, targetCompanyId]
    );
    const terminalIds = terminals.rows.map(t => t.id);

    // 2. Clear global references to these terminal users (Audit Logs, Permissions, etc.)
    if (terminalIds.length > 0) {
      // Clear audit log references
      await client.query(
        'UPDATE audit_logs SET user_id = NULL WHERE user_id = ANY($1) AND company_id = $2',
        [terminalIds, targetCompanyId]
      );
      // Clear permission updated_by references
      await client.query(
        'UPDATE role_module_permissions SET updated_by = NULL WHERE updated_by = ANY($1) AND company_id = $2',
        [terminalIds, targetCompanyId]
      );
      // Clear any supervisor references (safety)
      await client.query(
        'UPDATE users SET supervisor_id = NULL WHERE supervisor_id = ANY($1) AND company_id = $2',
        [terminalIds, targetCompanyId]
      );
    }

    // 3. Delete associated store data with foreign key constraints
    
    // 3a. Handle leave management (approvals reference requests)
    await client.query(
      `DELETE FROM leave_approvals WHERE leave_request_id IN (
         SELECT id FROM leave_requests WHERE store_id = $1 AND company_id = $2
       )`,
      [storeId, targetCompanyId]
    );
    await client.query('DELETE FROM leave_requests WHERE store_id = $1 AND company_id = $2', [storeId, targetCompanyId]);

    // 3b. Handle temporary transfers (origin or target)
    await client.query(
      'DELETE FROM temporary_store_assignments WHERE (origin_store_id = $1 OR target_store_id = $1) AND company_id = $2',
      [storeId, targetCompanyId]
    );

    // 3c. Handle attendance, shifts, and other operational data
    await client.query('DELETE FROM attendance_events WHERE store_id = $1 AND company_id = $2', [storeId, targetCompanyId]);
    await client.query('DELETE FROM qr_tokens WHERE store_id = $1 AND company_id = $2', [storeId, targetCompanyId]);
    await client.query('DELETE FROM shifts WHERE store_id = $1 AND company_id = $2', [storeId, targetCompanyId]);
    await client.query('DELETE FROM shift_templates WHERE store_id = $1 AND company_id = $2', [storeId, targetCompanyId]);
    await client.query('DELETE FROM store_affluence WHERE store_id = $1 AND company_id = $2', [storeId, targetCompanyId]);
    await client.query('DELETE FROM store_operating_hours WHERE store_id = $1', [storeId]);

    // 4. Delete terminal accounts linked to this store
    await client.query(
      `DELETE FROM users WHERE store_id = $1 AND company_id = $2 AND role = 'store_terminal'`,
      [storeId, targetCompanyId]
    );

    // 5. Finally delete the store record
    const result = await client.query(
      `DELETE FROM stores WHERE id = $1 AND company_id = $2 RETURNING id`,
      [storeId, targetCompanyId]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      notFound(res, 'Negozio non trovato');
      return;
    }

    await client.query('COMMIT');
    ok(res, { id: storeId }, 'Negozio e dati associati eliminati definitivamente');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// PATCH /api/stores/:id/activate — Admin/HR (within allowed companies)
export const activateStore = asyncHandler(async (req: Request, res: Response) => {
  const storeId = parseInt(req.params.id, 10);
  if (isNaN(storeId)) { notFound(res, 'Negozio non trovato o già attivo'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const storeRow = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM stores WHERE id = $1 AND company_id = ANY($2)`,
    [storeId, allowedCompanyIds],
  );
  const targetCompanyId = storeRow?.company_id ?? null;

  if (targetCompanyId == null) {
    notFound(res, 'Negozio non trovato o già attivo');
    return;
  }

  const store = await queryOne<StoreRow>(
    `UPDATE stores SET is_active = true WHERE id = $1 AND company_id = $2 AND is_active = false RETURNING *`,
    [storeId, targetCompanyId]
  );
  if (!store) { notFound(res, 'Negozio non trovato o già attivo'); return; }

  // Sync terminal status to active
  await query(
    `UPDATE users SET status = 'active' WHERE store_id = $1 AND company_id = $2 AND role = 'store_terminal'`,
    [storeId, targetCompanyId]
  );

  ok(res, store, 'Negozio riattivato');
});
