import { Request, Response } from 'express';
import { pool, query, queryOne } from '../../config/database';
import { ok, created, badRequest, conflict, notFound } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { assertLicenseCapacity } from '../billing/license.service';
import bcrypt from 'bcryptjs';
import { resolveAllowedCompanyIds } from '../../utils/companyScope';

/**
 * Whether the terminal has actually completed device registration.
 *
 * This is distinct from `users.status`, which only says whether the account is
 * enabled for login. A terminal whose credentials were created but which was
 * never registered on a device is `status = 'active'` yet cannot take any
 * attendance — reporting it simply as "Active" is what made GRA-01 look ready
 * when it was not.
 */
const REGISTRATION_STATE_SQL = `
  CASE
    WHEN u.registered_device_token IS NULL AND u.registered_device_identifier IS NULL THEN 'pending'
    WHEN u.device_reset_pending THEN 'reset_pending'
    ELSE 'registered'
  END`;

export const listTerminals = asyncHandler(async (req: Request, res: Response) => {
  const { role, userId, companyId: callerCompanyId } = req.user!;
  const { search, status, registration, company_id, store_id, page = '1', limit = '20' } = req.query as Record<string, string>;

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  
  let where = "u.role = 'store_terminal'";
  const params: any[] = [];

  // Company filtering based on role and query
  if (company_id) {
    const ids = company_id.split(',').map(id => parseInt(id, 10)).filter(Number.isInteger);
    if (ids.length > 0) {
      const filteredIds = ids.filter(id => allowedCompanyIds.includes(id));
      if (filteredIds.length > 0) {
        params.push(filteredIds);
        where += ` AND u.company_id = ANY($${params.length})`;
      } else {
        where += " AND 1=0";
      }
    } else {
      where += " AND 1=0";
    }
  } else {
    params.push(allowedCompanyIds);
    where += ` AND u.company_id = ANY($${params.length})`;
  }

  // Store filtering
  if (store_id) {
    const ids = store_id.split(',').map(id => parseInt(id, 10)).filter(Number.isInteger);
    if (ids.length > 0) {
      params.push(ids);
      where += ` AND u.store_id = ANY($${params.length})`;
    }
  }

  // Status filtering
  if (status) {
    params.push(status);
    where += ` AND u.status = $${params.length}`;
  }

  // Registration filtering ('pending' | 'reset_pending' | 'registered')
  if (registration) {
    const states = registration.split(',').map(s => s.trim()).filter(Boolean);
    if (states.length > 0) {
      params.push(states);
      where += ` AND ${REGISTRATION_STATE_SQL} = ANY($${params.length})`;
    }
  }

  // Search filtering (name or email)
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
  }

  // Count total for pagination
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM users u WHERE ${where}`,
    params
  ).catch(err => {
    console.error('Error in listTerminals count query:', err);
    throw err;
  });
  const total = parseInt(countRow?.count || '0', 10);

  // Fetch data
  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const offset = (pageNum - 1) * limitNum;

  params.push(limitNum, offset);
  const terminals = await query(`
    SELECT 
      u.id, 
      u.name, 
      u.email, 
      u.role, 
      u.status, 
      u.company_id, 
      u.store_id,
      u.plain_password,
      u.device_reset_pending,
      ((u.registered_device_token IS NOT NULL) OR (u.registered_device_identifier IS NOT NULL)) AS device_registered,
      u.registered_device_registered_at AS device_registered_at,
      u.registered_device_metadata AS device_metadata,
      u.last_seen_ip,
      u.last_seen_at,
      ${REGISTRATION_STATE_SQL} AS registration_state,
      u.created_at,
      u.updated_at,
      TRIM(CONCAT(cb.name, ' ', cb.surname)) AS created_by_name,
      TRIM(CONCAT(ub.name, ' ', ub.surname)) AS updated_by_name,
      c.name as company_name,
      s.name as store_name,
      -- The store's clock, shown beside the terminal: the clock-in window this
      -- terminal opens is judged on it, not on the tablet's own setting.
      s.timezone as store_timezone
    FROM users u
    LEFT JOIN companies c ON c.id = u.company_id
    LEFT JOIN stores s ON s.id = u.store_id
    LEFT JOIN users cb ON cb.id = u.created_by
    LEFT JOIN users ub ON ub.id = u.updated_by
    WHERE ${where}
    ORDER BY c.name, s.name, u.name
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params).catch(err => {
    console.error('Error in listTerminals data query:', err);
    throw err;
  });

  ok(res, {
    data: terminals,
    meta: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum)
    }
  });
});

export const listStoresWithTerminalStatus = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  const stores = await query(`
    SELECT 
      s.id, 
      s.name, 
      s.code, 
      s.address, 
      s.cap, 
      s.max_staff, 
      s.company_id,
      -- The clock this store's shifts and clock-ins run on. Shown next to the
      -- terminal so whoever sets it up can see it is not necessarily their own.
      s.timezone,
      c.name as company_name,
      -- Any terminal account at all, regardless of whether it is currently
      -- enabled. Filtering on status here used to let a store with a disabled
      -- terminal look terminal-less, so a duplicate could be created for it.
      EXISTS (
        SELECT 1 FROM users u
        WHERE u.store_id = s.id
        AND u.role = 'store_terminal'
      ) as "hasTerminal"
    FROM stores s
    LEFT JOIN companies c ON c.id = s.company_id
    WHERE s.company_id = ANY($1)
    ORDER BY c.name, s.name
  `, [allowedCompanyIds]);

  ok(res, stores);
});

export const createTerminal = asyncHandler(async (req: Request, res: Response) => {
  const { store_id, email, password } = req.body;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  if (!store_id || !email || !password) {
    return badRequest(res, 'Store ID, email and password are required');
  }

  // Verify store exists and is in scope
  const store = await queryOne<{ id: number; company_id: number; name: string }>(
    'SELECT id, company_id, name FROM stores WHERE id = $1 AND company_id = ANY($2)',
    [store_id, allowedCompanyIds]
  );

  if (!store) {
    return badRequest(res, 'Store not found or access denied');
  }

  // One terminal account per store. Deliberately not filtered by status: a
  // disabled terminal still occupies the store, and ignoring it allowed a second
  // account to be created for the same store.
  const existingTerminal = await queryOne(
    "SELECT id FROM users WHERE store_id = $1 AND role = 'store_terminal'",
    [store_id]
  );

  if (existingTerminal) {
    return conflict(res, 'A terminal already exists for this store');
  }

  // Check if email is available
  const emailExists = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (emailExists) {
    return conflict(res, 'Email already in use');
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // NOTE: `status` stays 'active' because login is gated on it — a terminal
    // created as 'inactive' could never sign in to complete its registration.
    // "Has this terminal actually been registered?" is reported separately, via
    // registration_state, so the list no longer presents an unregistered
    // terminal as ready to use.
    // A terminal takes one paid license. Refuse before creating anything.
    await assertLicenseCapacity(store.company_id, 'terminal', 1);

    const terminalRes = await client.query(
      `INSERT INTO users (
         company_id, store_id, name, surname, email, password_hash, plain_password, role, status, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'store_terminal', 'active', $8, $8) RETURNING id, name, email, created_at`,
      [store.company_id, store.id, store.name, 'Terminale', email, passwordHash, password, req.user!.userId]
    );

    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
       VALUES ($1, $2, 'TERMINAL_CREATE', 'user', $3, $4)`,
      [store.company_id, req.user!.userId, terminalRes.rows[0].id, { store_id: store.id, email }]
    );

    await client.query('COMMIT');
    created(res, { ...terminalRes.rows[0], registration_state: 'pending' }, 'Terminal created successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export const updateTerminal = asyncHandler(async (req: Request, res: Response) => {
  const terminalId = parseInt(req.params.id, 10);
  const { email, password } = req.body;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  if (isNaN(terminalId)) return badRequest(res, 'Invalid terminal ID');

  // Verify terminal exists, is a terminal, and is in scope
  const terminal = await queryOne<{ id: number; company_id: number; email: string; plain_password?: string }>(
    `SELECT u.id, u.company_id, u.email, u.plain_password
     FROM users u 
     WHERE u.id = $1 AND u.role = 'store_terminal' AND u.company_id = ANY($2)`,
    [terminalId, allowedCompanyIds]
  );

  if (!terminal) return notFound(res, 'Terminal not found or access denied');

  const updates: string[] = [];
  const params: any[] = [];

  if (email && email !== terminal.email) {
    // Check if email is available
    const emailExists = await queryOne('SELECT id FROM users WHERE email = $1 AND id <> $2', [email, terminalId]);
    if (emailExists) {
      return conflict(res, 'Email already in use');
    }
    params.push(email);
    updates.push(`email = $${params.length}`);
  }

  if (password && password !== terminal.plain_password) {
    if (password.length < 8) {
      return badRequest(res, 'Password must be at least 8 characters');
    }
    const passwordHash = await bcrypt.hash(password, 12);
    params.push(passwordHash);
    updates.push(`password_hash = $${params.length}`);
    params.push(password);
    updates.push(`plain_password = $${params.length}`);
  }

  if (updates.length === 0) {
    return ok(res, null, 'No updates performed');
  }

  params.push(req.user!.userId);
  updates.push(`updated_by = $${params.length}`);

  params.push(terminalId);
  await query(
    `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
    params
  );

  query(
    `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id)
     VALUES ($1, $2, 'TERMINAL_UPDATE', 'user', $3)`,
    [terminal.company_id, req.user!.userId, terminalId]
  ).catch(() => {});

  ok(res, null, 'Terminal updated successfully');
});

export const deleteTerminal = asyncHandler(async (req: Request, res: Response) => {
  const terminalId = parseInt(req.params.id, 10);
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  if (isNaN(terminalId)) return badRequest(res, 'Invalid terminal ID');

  // Verify terminal exists, is a terminal, and is in scope
  const terminal = await queryOne(
    `SELECT u.id, u.company_id 
     FROM users u 
     WHERE u.id = $1 AND u.role = 'store_terminal' AND u.company_id = ANY($2)`,
    [terminalId, allowedCompanyIds]
  );

  if (!terminal) return notFound(res, 'Terminal not found or access denied');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clean up dependencies
    await client.query('DELETE FROM attendance_events WHERE user_id = $1', [terminalId]);
    await client.query('DELETE FROM audit_logs WHERE user_id = $1', [terminalId]);
    
    // Delete the terminal user
    await client.query('DELETE FROM users WHERE id = $1', [terminalId]);

    await client.query('COMMIT');
    ok(res, null, 'Terminal deleted successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});
