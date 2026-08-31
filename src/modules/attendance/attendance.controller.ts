import { Request, Response } from 'express';
import crypto from 'crypto';
import * as XLSX from 'xlsx';
import { pool, query, queryOne } from '../../config/database';
import { ok, created, badRequest, conflict, forbidden, notFound } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { signQrToken2, verifyQrToken2 } from '../../config/jwt';
import { resolveAllowedCompanyIds } from '../../utils/companyScope';
import { resolveAreaManagerStoreIds } from '../../utils/storeScope';
import { coalescedShiftPointUtcSql, DEFAULT_SHIFT_TIMEZONE, normalizeShiftTimezone } from '../../utils/shiftTimezone';
import { sendNotification } from '../notifications/notifications.service';
import { t } from '../../utils/i18n';
import { emitToCompany } from '../../config/socket';
import {
  matchesRegisteredDevice,
  resolveDeviceIdentity,
  withDeviceProfileHash,
} from '../../utils/deviceProfile';
import { sendLateArrivalAlertAutomation } from '../automations/lateArrivalAlert';
import {
  APPROVED_LEAVE_STATUSES as SHARED_APPROVED_LEAVE_STATUSES,
  loadApprovedLeaveDays,
  leaveCoverageKey,
} from '../../utils/leaveCoverage';

// ---------------------------------------------------------------------------
// Date helpers used where API contracts expect date-only values.
// ---------------------------------------------------------------------------
function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const DEFAULT_SHIFT_TIMEZONE_SQL = DEFAULT_SHIFT_TIMEZONE.replace(/'/g, "''");
const SHIFT_TIMEZONE_SQL = `COALESCE(NULLIF(BTRIM(s.timezone), ''), '${DEFAULT_SHIFT_TIMEZONE_SQL}')`;
const SHIFT_START_UTC_SQL = coalescedShiftPointUtcSql('s.start_at_utc', 's.date', 's.start_time', 's.timezone');
const SHIFT_END_UTC_SQL = coalescedShiftPointUtcSql('s.end_at_utc', 's.date', 's.end_time', 's.timezone');
// Was a local list that omitted 'HR approved' — the terminal status when a
// company's approval chain ends at HR — so those employees could still clock in
// while on approved leave. Now shared with the anomaly and report engines.
const APPROVED_LEAVE_STATUSES = [...SHARED_APPROVED_LEAVE_STATUSES];

function localDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function pickMetaString(source: any, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function sameMetaText(a: string | null, b: string | null): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function languageBase(value: string | null): string | null {
  return value ? value.split('-')[0]?.toLowerCase() ?? null : null;
}

function sameScreen(a: any, b: any): boolean {
  const aw = Number(a?.width);
  const ah = Number(a?.height);
  const bw = Number(b?.width);
  const bh = Number(b?.height);
  if (!aw || !ah || !bw || !bh) return false;
  return (aw === bw && ah === bh) || (aw === bh && ah === bw);
}

function isSameRegisteredDeviceProfile(registeredMetadata: any, currentMetadata: any): boolean {
  if (!registeredMetadata || !currentMetadata) return false;

  const registeredOsName = pickMetaString(registeredMetadata.os, 'name');
  const currentOsName = pickMetaString(currentMetadata.os, 'name');
  const registeredDevice = registeredMetadata.device ?? {};
  const currentDevice = currentMetadata.device ?? {};

  const osMatches = sameMetaText(registeredOsName, currentOsName);
  const screenMatches = sameScreen(registeredMetadata.screen, currentMetadata.screen);
  const timezoneMatches = sameMetaText(
    pickMetaString(registeredMetadata, 'timezone'),
    pickMetaString(currentMetadata, 'timezone'),
  );
  const languageMatches = languageBase(pickMetaString(registeredMetadata, 'language')) === languageBase(pickMetaString(currentMetadata, 'language'));

  const deviceMatchCount = ['model', 'vendor', 'type'].filter((key) =>
    sameMetaText(pickMetaString(registeredDevice, key), pickMetaString(currentDevice, key)),
  ).length;
  const browserMatches = sameMetaText(
    pickMetaString(registeredMetadata.browser, 'name'),
    pickMetaString(currentMetadata.browser, 'name'),
  );

  const score = Number(osMatches) + Number(screenMatches) + Number(timezoneMatches) + Number(languageMatches) + Number(browserMatches) + deviceMatchCount;
  return (screenMatches && (osMatches || deviceMatchCount > 0) && score >= 3)
    || (osMatches && deviceMatchCount >= 2 && score >= 4);
}


// ---------------------------------------------------------------------------
// GET /api/qr/generate?store_id=N
// Returns a signed JWT (the "QR token") + the nonce stored for replay prevention
// ---------------------------------------------------------------------------
export const generateQr = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const storeId = parseInt(req.query.store_id as string, 10);

  if (!storeId || isNaN(storeId)) {
    return badRequest(res, 'store_id obbligatorio', 'VALIDATION_ERROR');
  }

  // Verify store exists and is in scope
  const store = await queryOne<{ id: number; company_id: number }>(
    `SELECT id, company_id FROM stores WHERE id = $1 AND company_id = ANY($2) AND is_active = true`,
    [storeId, allowedCompanyIds],
  );
  if (!store) {
    return badRequest(res, 'Negozio non trovato', 'NOT_FOUND');
  }

  // store_manager and store_terminal can only generate QR for their own store
  const roleLimitedToStore = req.user!.role === 'store_manager' || req.user!.role === 'store_terminal';
  if (roleLimitedToStore && storeId !== req.user!.storeId) {
    return forbidden(res, 'Puoi generare QR solo per il tuo negozio');
  }

  const nonce = crypto.randomUUID();

  // Store nonce for replay prevention using the store's company context
  const tokenRow = await queryOne<{ id: number }>(
    `INSERT INTO qr_tokens (company_id, store_id, nonce)
     VALUES ($1, $2, $3) RETURNING id`,
    [store.company_id, storeId, nonce],
  );

  // Sign token using the store's company context
  const token = signQrToken2(store.company_id, storeId, nonce);
  const expiresIn = parseInt(process.env.QR_TOKEN_TTL || '60', 10);

  ok(res, {
    token,
    nonce,
    store_id: storeId,
    expires_in: expiresIn,
    token_id: tokenRow!.id,
  });
});

// ---------------------------------------------------------------------------
// POST /api/attendance/checkin
// body: { qr_token, event_type, user_id, notes? }
// ---------------------------------------------------------------------------
export const checkin = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, role, userId: callerId } = req.user!;
  const { qr_token, event_type, notes, device_fingerprint, device_metadata } = req.body as {
    qr_token: string;
    event_type: 'checkin' | 'checkout' | 'break_start' | 'break_end';
    notes?: string;
    device_fingerprint?: string;
    device_metadata?: any;
  };
  // Employees can only check in for themselves — managers/terminals can specify any user
  let user_id: number;
  if (role === 'employee' || (['store_manager', 'hr', 'area_manager'].includes(role) && !req.body.unique_id && !req.body.user_id)) {
    user_id = callerId;
  } else if (req.body.unique_id) {
    // Resolve unique_id → numeric user_id within this company
    const found = await queryOne<{ id: number }>(
      `SELECT id FROM users WHERE LOWER(unique_id) = LOWER($1) AND company_id = $2 AND status = 'active'`,
      [req.body.unique_id as string, companyId],
    );
    if (!found) {
      badRequest(res, 'Dipendente non trovato con questo codice', 'NOT_FOUND');
      return;
    }
    user_id = found.id;
  } else {
    user_id = req.body.user_id as number;
  }

  // 1. Verify JWT signature and expiry
  let payload: { companyId: number; storeId: number; nonce: string };
  try {
    payload = verifyQrToken2(qr_token);
  } catch {
    badRequest(res, 'Token QR non valido o scaduto', 'INVALID_QR_TOKEN');
    return;
  }

  // 2. Multi-tenant check
  if (payload.companyId !== companyId) {
    badRequest(res, 'Token QR non valido per questa azienda', 'INVALID_QR_TOKEN');
    return;
  }

  // 3. Replay prevention: find nonce, ensure it hasn't been used
  const qrToken = await queryOne<{ id: number; used_at: string | null }>(
    `SELECT id, used_at FROM qr_tokens
     WHERE nonce = $1 AND company_id = $2 AND store_id = $3`,
    [payload.nonce, companyId, payload.storeId],
  );

  if (!qrToken) {
    badRequest(res, 'Token QR non riconosciuto', 'INVALID_QR_TOKEN');
    return;
  }

  if (qrToken.used_at) {
    conflict(res, 'Token QR già utilizzato (screenshot non consentito)', 'QR_ALREADY_USED');
    return;
  }

  // Verify user_id belongs to this company
  const targetUser = await queryOne<{
    id: number;
    name: string;
    surname: string;
    email: string | null;
    role: string;
    registered_device_token: string | null;
    registered_device_identifier: string | null;
    registered_device_metadata: any;
    device_reset_pending: boolean;
  }>(
    `SELECT id, name, surname, email, role, registered_device_token, registered_device_identifier, registered_device_metadata, device_reset_pending
     FROM users
     WHERE id = $1 AND company_id = $2 AND status = 'active'`,
    [user_id, companyId],
  );
  if (!targetUser) {
    badRequest(res, 'Dipendente non trovato in questa azienda', 'NOT_FOUND');
    return;
  }

  // Device binding enforcement (employee self-service only)
  if (role === 'employee' || (['store_manager', 'hr', 'area_manager'].includes(role) && user_id === callerId)) {
    if (!device_fingerprint || typeof device_fingerprint !== 'string') {
      forbidden(res, 'Device non registrato. Effettua prima la registrazione del dispositivo.', 'DEVICE_NOT_REGISTERED');
      return;
    }
    const isDeviceRegistered = (targetUser.registered_device_token != null || targetUser.registered_device_identifier != null)
      && targetUser.device_reset_pending === false;
    if (!isDeviceRegistered) {
      forbidden(res, 'Device non registrato. Effettua prima la registrazione del dispositivo.', 'DEVICE_NOT_REGISTERED');
      return;
    }

    const mergedDeviceMetadata = withDeviceProfileHash(device_metadata ?? {});
    const identity = resolveDeviceIdentity(device_fingerprint, mergedDeviceMetadata);
    const match = matchesRegisteredDevice(targetUser, identity);

    if (match.matched) {
      if (match.viaLegacy) {
        // Recognised through the pre-install-id scheme — rewrite the binding onto
        // the stable identity so a future browser update cannot invalidate it.
        await query(
          `UPDATE users
           SET registered_device_token = $1,
               registered_device_identifier = $2,
               updated_at = NOW()
           WHERE id = $3 AND company_id = $4`,
          [identity.token, identity.identifier, user_id, companyId],
        ).catch(() => { /* keep the legacy binding, which still matches */ });
      }
    } else if (isSameRegisteredDeviceProfile(targetUser.registered_device_metadata, device_metadata)) {
      // Same hardware but an identity we do not recognise (storage cleared, or a
      // binding predating the profile hash). Rebind, but only if nobody else in
      // the company holds this device.
      const conflictingBinding = await queryOne<{ id: number }>(
        `SELECT id
         FROM users
         WHERE id <> $1
           AND company_id = $2
           AND device_reset_pending = false
           AND (
             registered_device_token = $3
             OR ($4::text IS NOT NULL AND registered_device_identifier = $4)
           )
         LIMIT 1`,
        [user_id, companyId, identity.token, identity.identifier],
      );

      if (conflictingBinding) {
        forbidden(
          res,
          'Your device is already registered to another account, you will not able to check in, check out, break start, break end',
          'DEVICE_MISMATCH',
        );
        return;
      }

      try {
        await query(
          `UPDATE users
           SET registered_device_token = $1,
               registered_device_identifier = $2,
               registered_device_metadata = COALESCE(registered_device_metadata, '{}'::jsonb) || $3::jsonb,
               updated_at = NOW()
           WHERE id = $4 AND company_id = $5`,
          [identity.token, identity.identifier, JSON.stringify(mergedDeviceMetadata), user_id, companyId],
        );
      } catch {
        forbidden(
          res,
          'Your device is different, you will not able to check in, check out, break start, break end',
          'DEVICE_MISMATCH',
        );
        return;
      }
    } else {
      forbidden(
        res,
        'Your device is different, you will not able to check in, check out, break start, break end',
        'DEVICE_MISMATCH',
      );
      return;
    }
  }

  // 4. Find an active shift window in UTC for this user/store.
  let currentShift;
  if (event_type === 'checkin') {
    currentShift = await queryOne<{
      id: number;
      shift_date: string;
      start_time: string;
      shift_timezone: string;
      start_at_utc: string;
      end_at_utc: string;
    }>(
      `SELECT
         s.id,
         TO_CHAR(s.date, 'YYYY-MM-DD') AS shift_date,
         s.start_time,
         ${SHIFT_TIMEZONE_SQL} AS shift_timezone,
         ${SHIFT_START_UTC_SQL} AS start_at_utc,
         ${SHIFT_END_UTC_SQL} AS end_at_utc
       FROM shifts s
       WHERE s.company_id = $1
         AND s.user_id = $2
         AND s.store_id = $3
         AND s.status != 'cancelled'
         AND NOW() >= ${SHIFT_START_UTC_SQL} - INTERVAL '15 minutes'
         AND NOW() <= ${SHIFT_END_UTC_SQL}
       ORDER BY ${SHIFT_START_UTC_SQL}
       LIMIT 1`,
      [companyId, user_id, payload.storeId],
    );
  } else {
    // For checkout / break events, first resolve the shift from the employee's
    // currently OPEN check-in (a check-in with no checkout yet). This correctly
    // handles shifts that cross midnight, where the checkout happens on a
    // different calendar day than the shift's date — the date-based lookup below
    // would otherwise find nothing and reject a valid checkout.
    currentShift = await queryOne<{
      id: number;
      shift_date: string;
      start_time: string;
      shift_timezone: string;
      start_at_utc: string;
      end_at_utc: string;
    }>(
      `SELECT
         s.id,
         TO_CHAR(s.date, 'YYYY-MM-DD') AS shift_date,
         s.start_time,
         ${SHIFT_TIMEZONE_SQL} AS shift_timezone,
         ${SHIFT_START_UTC_SQL} AS start_at_utc,
         ${SHIFT_END_UTC_SQL} AS end_at_utc
       FROM attendance_events ae
       JOIN shifts s ON s.id = ae.shift_id
       WHERE ae.company_id = $1
         AND ae.user_id = $2
         AND ae.store_id = $3
         AND ae.event_type = 'checkin'
         AND ae.event_time >= NOW() - INTERVAL '24 hours'
         AND s.status != 'cancelled'
         AND NOT EXISTS (
           SELECT 1 FROM attendance_events co
           WHERE co.company_id = ae.company_id
             AND co.user_id = ae.user_id
             AND co.store_id = ae.store_id
             AND co.event_type = 'checkout'
             AND co.event_time >= ae.event_time
         )
       ORDER BY ae.event_time DESC
       LIMIT 1`,
      [companyId, user_id, payload.storeId],
    );

    // Fall back to today's scheduled shift when there is no open check-in
    // (e.g. a same-day shift with no events yet, or legacy events with no link).
    if (!currentShift) {
      currentShift = await queryOne<{
        id: number;
        shift_date: string;
        start_time: string;
        shift_timezone: string;
        start_at_utc: string;
        end_at_utc: string;
      }>(
        `SELECT
           s.id,
           TO_CHAR(s.date, 'YYYY-MM-DD') AS shift_date,
           s.start_time,
           ${SHIFT_TIMEZONE_SQL} AS shift_timezone,
           ${SHIFT_START_UTC_SQL} AS start_at_utc,
           ${SHIFT_END_UTC_SQL} AS end_at_utc
         FROM shifts s
         WHERE s.company_id = $1
           AND s.user_id = $2
           AND s.store_id = $3
           AND s.status != 'cancelled'
           AND s.date = (NOW() AT TIME ZONE ${SHIFT_TIMEZONE_SQL})::DATE
         ORDER BY ${SHIFT_START_UTC_SQL}
         LIMIT 1`,
        [companyId, user_id, payload.storeId],
      );
    }
  }

  // Shift and holiday rules:
  // - no attendance actions when no scheduled shift for today in this store
  // - no actions on approved leave day
  if (!currentShift) {
    // Check if there is a shift scheduled today at a DIFFERENT store for this user
    const otherStoreShift = await queryOne<{ store_name: string; start_time: string }>(
      `SELECT st.name AS store_name, s.start_time
       FROM shifts s
       JOIN stores st ON s.store_id = st.id
       WHERE s.company_id = $1
         AND s.user_id = $2
         AND s.store_id != $3
         AND s.status != 'cancelled'
         AND s.date = (NOW() AT TIME ZONE ${SHIFT_TIMEZONE_SQL})::DATE
       LIMIT 1`,
      [companyId, user_id, payload.storeId],
    );

    if (otherStoreShift) {
      res.status(400).json({
        success: false,
        error: `Hai un turno programmato oggi presso il negozio "${otherStoreShift.store_name}", non in questo negozio.`,
        code: 'SHIFT_STORE_MISMATCH',
        storeName: otherStoreShift.store_name,
      });
      return;
    }

    // Check if there is ANY shift scheduled for this user today at this store in their local timezone date.
    // The gate above admits [start_at_utc - 15min, end_at_utc]; this message must be
    // derived from those same instants, not from wall-clock string arithmetic, or it
    // contradicts the very check that rejected the employee. It also has to say WHICH
    // side of the window they are on: before the fix, arriving after the shift had
    // ended produced 'you can clock in from 08:45, try later' at six in the evening.
    const todayShift = await queryOne<{
      start_time: string;
      shift_timezone: string;
      start_at_utc: string;
      end_at_utc: string;
    }>(
      `SELECT start_time,
              ${SHIFT_TIMEZONE_SQL} AS shift_timezone,
              ${SHIFT_START_UTC_SQL} AS start_at_utc,
              ${SHIFT_END_UTC_SQL} AS end_at_utc
       FROM shifts s
       WHERE s.company_id = $1
         AND s.user_id = $2
         AND s.store_id = $3
         AND s.status != 'cancelled'
         AND s.date = (NOW() AT TIME ZONE ${SHIFT_TIMEZONE_SQL})::DATE
       ORDER BY ${SHIFT_START_UTC_SQL}
       LIMIT 1`,
      [companyId, user_id, payload.storeId],
    );

    if (todayShift && event_type === 'checkin') {
      const tz = normalizeShiftTimezone(todayShift.shift_timezone, DEFAULT_SHIFT_TIMEZONE);
      const startUtc = new Date(todayShift.start_at_utc);
      const endUtc = new Date(todayShift.end_at_utc);
      const opensUtc = new Date(startUtc.getTime() - 15 * 60 * 1000);
      const now = new Date();

      const shiftStart = formatInTimezone(startUtc, tz);
      const shiftEnd = formatInTimezone(endUtc, tz);
      const allowedFrom = formatInTimezone(opensUtc, tz);
      const currentTime = formatInTimezone(now, tz);

      if (now.getTime() > endUtc.getTime()) {
        badRequest(
          res,
          `Il tuo turno di oggi (${shiftStart}-${shiftEnd}, ora di ${tz}) è già terminato. Adesso sono le ${currentTime}. Contatta il responsabile.`,
          'SHIFT_ALREADY_ENDED',
          { shiftStart, shiftEnd, currentTime, storeTimezone: tz },
        );
        return;
      }

      badRequest(
        res,
        `Il tuo turno inizia alle ${shiftStart} (ora di ${tz}) e puoi timbrare dalle ${allowedFrom}. Adesso sono le ${currentTime}.`,
        'SHIFT_TOO_EARLY',
        { shiftStart, shiftEnd, allowedFrom, currentTime, storeTimezone: tz },
      );
      return;
    }

    badRequest(
      res,
      'Il tuo turno per oggi in questo negozio non è confermato. Si prega di contattare il responsabile.',
      'NO_ACTIVE_SHIFT'
    );
    return;
  }

  const approvedLeave = await queryOne<{ id: number }>(
    `SELECT id
     FROM leave_requests
     WHERE company_id = $1
       AND user_id = $2
       AND status = ANY($4::text[])
       AND start_date <= $3::date
       AND end_date >= $3::date
     LIMIT 1`,
    [companyId, user_id, currentShift.shift_date, APPROVED_LEAVE_STATUSES],
  );
  if (approvedLeave) {
    forbidden(res, 'L\'utente è in permesso oggi, quindi non può registrare la presenza.', 'ON_HOLIDAY');
    return;
  }

  // Current day sequence & single-action constraints
  const dayEvents = await query<{ event_type: 'checkin' | 'checkout' | 'break_start' | 'break_end'; event_time: string }>(
    `SELECT event_type, event_time
     FROM attendance_events
     WHERE company_id = $1
       AND user_id = $2
       AND event_time >= (($3::DATE)::timestamp AT TIME ZONE $4)
       AND event_time < ((($3::DATE + INTERVAL '1 day')::timestamp) AT TIME ZONE $4)
     ORDER BY event_time ASC`,
    [companyId, user_id, currentShift.shift_date, currentShift.shift_timezone],
  );

  const has = (type: 'checkin' | 'checkout' | 'break_start' | 'break_end') =>
    dayEvents.some((e) => e.event_type === type);

  if (has(event_type)) {
    conflict(res, 'Azione già registrata oggi', 'EVENT_ALREADY_RECORDED');
    return;
  }

  if (event_type === 'checkin') {
    // First event of the day must be check-in
    if (dayEvents.length > 0) {
      conflict(res, 'Check-in già effettuato oggi', 'CHECKIN_ALREADY_DONE');
      return;
    }
  } else if (event_type === 'break_start') {
    if (!has('checkin')) {
      conflict(res, 'Devi effettuare prima il check-in', 'CHECKIN_REQUIRED');
      return;
    }
  } else if (event_type === 'break_end') {
    if (!has('checkin')) {
      conflict(res, 'Devi effettuare prima il check-in', 'CHECKIN_REQUIRED');
      return;
    }
    if (!has('break_start')) {
      conflict(res, 'Devi avviare la pausa prima di terminarla', 'BREAK_START_REQUIRED');
      return;
    }
  } else if (event_type === 'checkout') {
    if (!has('checkin')) {
      conflict(res, 'Devi effettuare prima il check-in', 'CHECKIN_REQUIRED');
      return;
    }
    if (has('break_start') && !has('break_end')) {
      conflict(res, 'Termina prima la pausa', 'BREAK_END_REQUIRED');
      return;
    }
  }

  // 5 & 6: Use transaction — mark nonce used AND insert event atomically
  const client = await pool.connect();
  let event: any;
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE qr_tokens SET used_at = NOW() WHERE id = $1`,
      [qrToken.id],
    );
    const result = await client.query(
      `INSERT INTO attendance_events
         (company_id, store_id, user_id, event_type, source, qr_token_id, shift_id, notes)
       VALUES ($1, $2, $3, $4, 'qr', $5, $6, $7)
       RETURNING *`,
      [
        companyId,
        payload.storeId,
        user_id,
        event_type,
        qrToken.id,
        currentShift.id,
        notes ?? null,
      ],
    );
    await client.query('COMMIT');
    event = result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Best-effort TTL cleanup: delete expired qr_tokens older than 5 minutes.
  // Fire-and-forget — do not await, do not fail the request if this errors.
  pool.query(
    `DELETE FROM qr_tokens qt
     WHERE qt.issued_at < NOW() - INTERVAL '5 minutes'
       AND NOT EXISTS (
         SELECT 1
         FROM attendance_events ae
         WHERE ae.qr_token_id = qt.id
       )`,
  ).catch((cleanupErr) => {
    console.warn('qr_tokens cleanup failed (non-fatal):', cleanupErr?.message);
  });

  // Emit socket event to notify terminal of successful checkin
  try {
    emitToCompany(companyId, 'TERMINAL_ATTENDANCE_ACTION', {
      userId: user_id,
      name: targetUser.name,
      surname: targetUser.surname,
      eventType: event_type,
      timestamp: event.event_time
    });
  } catch (socketErr) {
    console.warn('Failed to emit TERMINAL_ATTENDANCE_ACTION (non-fatal):', socketErr);
  }

  if (event_type === 'checkin' && targetUser.role === 'employee') {
    const shiftStart = new Date(currentShift.start_at_utc);
    const checkinTime = new Date(event.event_time);
    const lateMinutes = Math.floor((checkinTime.getTime() - shiftStart.getTime()) / 60000);

    if (lateMinutes >= 10) {
      const storeRow = await queryOne<{ name: string }>(
        `SELECT name FROM stores WHERE id = $1 AND company_id = $2`,
        [payload.storeId, companyId],
      );

      await sendLateArrivalAlertAutomation({
        companyId,
        employeeId: targetUser.id,
        employeeName: targetUser.name,
        employeeSurname: targetUser.surname,
        employeeEmail: targetUser.email,
        storeId: payload.storeId,
        storeName: storeRow?.name || null,
        shiftStartTime: currentShift.start_time,
        checkinTime,
        lateMinutes,
      });
    }
  }

  created(res, event, 'Evento registrato');
});

// ---------------------------------------------------------------------------
// POST /api/attendance  — manual entry (admin/hr only)
// body: { userId, storeId, eventType, eventTime, notes? }
// ---------------------------------------------------------------------------
export const createManualEvent = asyncHandler(async (req: Request, res: Response) => {
  const { userId: callerId } = req.user!;
  const { user_id, store_id, event_type, event_time, notes } = req.body as {
    user_id: number;
    store_id: number;
    event_type: 'checkin' | 'checkout' | 'break_start' | 'break_end';
    event_time: string;
    notes?: string;
  };

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  // Resolve the employee and ensure it belongs to an allowed company
  const targetUser = await queryOne<{ id: number; company_id: number }>(
    `SELECT id, company_id
     FROM users
     WHERE id = $1 AND status = 'active' AND company_id = ANY($2)`,
    [user_id, allowedCompanyIds],
  );
  if (!targetUser) {
    badRequest(res, 'Dipendente non trovato in questa azienda', 'NOT_FOUND');
    return;
  }

  // Use the employee's actual company (matters for super admin cross-company)
  const effectiveCompanyId = targetUser.company_id;

  // Verify store belongs to the same company as the employee
  const store = await queryOne<{ id: number }>(
    `SELECT id FROM stores WHERE id = $1 AND company_id = $2`,
    [store_id, effectiveCompanyId],
  );
  if (!store) {
    badRequest(res, 'Negozio non trovato in questa azienda', 'NOT_FOUND');
    return;
  }

  const ts = new Date(event_time);
  if (isNaN(ts.getTime())) {
    badRequest(res, 'Data/ora non valida', 'VALIDATION_ERROR');
    return;
  }

  // Reject timestamps more than 1 hour in the future
  if (ts.getTime() > Date.now() + 60 * 60 * 1000) {
    badRequest(res, 'La data/ora non può essere più di 1 ora nel futuro', 'VALIDATION_ERROR');
    return;
  }

  // Try to link to an existing shift window for that user/store.
  const eventIso = ts.toISOString();
  const linkedShift = await queryOne<{ id: number; shift_date: string }>(
    `SELECT s.id, TO_CHAR(s.date, 'YYYY-MM-DD') AS shift_date
     FROM shifts s
     WHERE s.company_id = $1
       AND s.user_id = $2
       AND s.store_id = $3
       AND s.status != 'cancelled'
       AND ${SHIFT_START_UTC_SQL} <= $4::TIMESTAMPTZ
       AND ${SHIFT_END_UTC_SQL} >= $4::TIMESTAMPTZ
     ORDER BY ${SHIFT_START_UTC_SQL}
     LIMIT 1`,
    [effectiveCompanyId, user_id, store_id, eventIso],
  );

  const leaveDate = linkedShift?.shift_date ?? eventIso.slice(0, 10);
  const approvedLeave = await queryOne<{ id: number }>(
    `SELECT id
     FROM leave_requests
     WHERE company_id = $1
       AND user_id = $2
       AND status = ANY($4::text[])
       AND start_date <= $3::date
       AND end_date >= $3::date
     LIMIT 1`,
    [effectiveCompanyId, user_id, leaveDate, APPROVED_LEAVE_STATUSES],
  );
  if (approvedLeave) {
    forbidden(res, 'L\'utente è in permesso oggi, quindi non può registrare la presenza.', 'ON_HOLIDAY');
    return;
  }

  const event = await queryOne(
    `INSERT INTO attendance_events
       (company_id, store_id, user_id, event_type, event_time, source, shift_id, notes)
     VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7)
     RETURNING *`,
    [effectiveCompanyId, store_id, user_id, event_type, eventIso, linkedShift?.id ?? null, notes ?? null],
  );

  created(res, event, 'Evento creato manualmente');
});

// ---------------------------------------------------------------------------
// GET /api/attendance
// Query params: user_id?, store_id?, date_from?, date_to?, event_type?
// ---------------------------------------------------------------------------
export const listAttendanceEvents = asyncHandler(async (req: Request, res: Response) => {
  const { role, userId, storeId } = req.user!;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const { user_id, store_id, date_from, date_to, event_type, search, timezone } = req.query as Record<string, string>;
  const displayTimezone = normalizeShiftTimezone(timezone, DEFAULT_SHIFT_TIMEZONE);

  // Pagination: logs view requests small pages (100) + "load more"; the summary/
  // analytics views request a complete scoped dataset with a high limit so their
  // aggregates are accurate. Hard ceiling protects the server from runaway pulls.
  const MAX_LIMIT = 20000;
  const limitRaw = parseInt(req.query.limit as string, 10);
  const offsetRaw = parseInt(req.query.offset as string, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : 100;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const VALID_EVENT_TYPES = new Set(['checkin', 'checkout', 'break_start', 'break_end']);

  // Validate date formats
  if (date_from && !DATE_RE.test(date_from)) {
    badRequest(res, 'date_from non valido (YYYY-MM-DD)', 'VALIDATION_ERROR'); return;
  }
  if (date_to && !DATE_RE.test(date_to)) {
    badRequest(res, 'date_to non valido (YYYY-MM-DD)', 'VALIDATION_ERROR'); return;
  }
  if (event_type && !VALID_EVENT_TYPES.has(event_type)) {
    badRequest(res, 'event_type non valido', 'VALIDATION_ERROR'); return;
  }

  const params: any[] = [allowedCompanyIds];
  let extraWhere = '';
  let idx = 2;

  // ── Role-based mandatory scope (applied before caller-provided filters) ───
  if (role === 'store_manager') {
    // store_manager can only see their own store's events
    extraWhere += ` AND ae.store_id = $${idx}`;
    params.push(storeId);
    idx++;
  } else if (role === 'area_manager') {
    const managedIds = await resolveAreaManagerStoreIds(userId, allowedCompanyIds);
    if (managedIds.length === 0) {
      ok(res, { events: [], total: 0, has_more: false });
      return;
    }
    const ph = managedIds.map((_, i) => `$${idx + i}`).join(',');
    extraWhere += ` AND ae.store_id IN (${ph})`;
    params.push(...managedIds);
    idx += managedIds.length;
  }
  // admin / hr: full company scope — no additional mandatory constraint

  // ── Caller-provided filters (scoped to above) ────────────────────────────
  if (user_id) {
    const uid = parseInt(user_id, 10);
    if (isNaN(uid) || uid < 1) { badRequest(res, 'user_id non valido', 'VALIDATION_ERROR'); return; }
    extraWhere += ` AND ae.user_id = $${idx}`;
    params.push(uid);
    idx++;
  }
  const rawCompanyId = (req.query.company_id || req.query.companyId) as string | undefined;
  if (rawCompanyId) {
    const cid = parseInt(rawCompanyId, 10);
    if (!isNaN(cid) && cid > 0) {
      extraWhere += ` AND ae.company_id = $${idx}`;
      params.push(cid);
      idx++;
    }
  }
  // store_manager: ignore caller store_id (already scoped to their store above)
  if (store_id && role !== 'store_manager') {
    const sid = parseInt(store_id, 10);
    if (isNaN(sid) || sid < 1) { badRequest(res, 'store_id non valido', 'VALIDATION_ERROR'); return; }
    extraWhere += ` AND ae.store_id = $${idx}`;
    params.push(sid);
    idx++;
  }
  if (date_from) {
    extraWhere += ` AND ae.event_time >= (($${idx}::DATE)::timestamp AT TIME ZONE $${idx + 1})`;
    params.push(date_from, displayTimezone);
    idx += 2;
  }
  if (date_to) {
    extraWhere += ` AND ae.event_time < ((($${idx}::DATE + INTERVAL '1 day')::timestamp) AT TIME ZONE $${idx + 1})`;
    params.push(date_to, displayTimezone);
    idx += 2;
  }
  if (event_type) {
    extraWhere += ` AND ae.event_type = $${idx}`;
    params.push(event_type);
    idx++;
  }
  if (search) {
    const escapedSearch = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
    extraWhere += ` AND (LOWER(u.name) LIKE LOWER($${idx}) ESCAPE '\\' OR LOWER(u.surname) LIKE LOWER($${idx}) ESCAPE '\\' OR u.unique_id ILIKE $${idx} ESCAPE '\\')`;
    params.push(`%${escapedSearch}%`);
    idx++;
  }

  const format = req.query.format as string | undefined;

  // Export path: capped at 10,000 rows to prevent runaway memory allocation
  const EXPORT_ROW_CAP = 10_000;
  if (format === 'csv' || format === 'xlsx') {
    const exportEvents = await query(
      `SELECT
         ae.id, ae.company_id, ae.store_id, ae.user_id,
         ae.event_type, ae.event_time, ae.source,
         ae.qr_token_id, ae.shift_id, ae.notes, ae.created_at,
         u.name AS user_name, u.surname AS user_surname,
         st.name AS store_name
       FROM attendance_events ae
       LEFT JOIN users u  ON u.id  = ae.user_id
       LEFT JOIN stores st ON st.id = ae.store_id
       WHERE ae.company_id = ANY($1)${extraWhere}
       ORDER BY ae.event_time DESC
       LIMIT ${EXPORT_ROW_CAP + 1}`,
      params,
    );
    const capped = exportEvents.length > EXPORT_ROW_CAP;
    if (capped) exportEvents.splice(EXPORT_ROW_CAP);
    const HEADERS = ['Data/Ora', 'Cognome', 'Nome', 'Negozio', 'Tipo Evento', 'Origine', 'Note'];
    const EVENT_LABELS: Record<string, string> = {
      checkin: 'Entrata', checkout: 'Uscita', break_start: 'Inizio Pausa', break_end: 'Fine Pausa',
    };
    const rowData = exportEvents.map((e: any) => [
      new Date(e.event_time).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      e.user_surname ?? '', e.user_name ?? '',
      e.store_name ?? '',
      EVENT_LABELS[e.event_type] ?? e.event_type,
      e.source ?? '',
      e.notes ?? '',
    ]);

    const filename = `presenze-${date_from ?? 'export'}`;

    if (format === 'xlsx') {
      const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rowData]);
      ws['!cols'] = HEADERS.map(() => ({ wch: 18 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Presenze');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      if (capped) res.setHeader('X-Export-Capped', `true`);
      res.send(buf);
    } else {
      const csvRows = rowData.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      if (capped) res.setHeader('X-Export-Capped', `true`);
      res.send(HEADERS.map(h => `"${h}"`).join(',') + '\n' + csvRows.join('\n'));
    }
    return;
  }

  // Pagination path (normal UI listing)
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM attendance_events ae
     LEFT JOIN users u ON u.id = ae.user_id
     WHERE ae.company_id = ANY($1)${extraWhere}`,
    params,
  );
  const total = parseInt(countResult[0].count, 10);

  const events = await query(
    `SELECT
       ae.id, ae.company_id, ae.store_id, ae.user_id,
       ae.event_type, ae.event_time, ae.source,
       ae.qr_token_id, ae.shift_id, ae.notes, ae.created_at,
       u.name AS user_name, u.surname AS user_surname,
       st.name AS store_name
     FROM attendance_events ae
     LEFT JOIN users u  ON u.id  = ae.user_id
     LEFT JOIN stores st ON st.id = ae.store_id
    WHERE ae.company_id = ANY($1)${extraWhere}
     ORDER BY ae.event_time DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset],
  );

  ok(res, { events, total, has_more: total > offset + events.length });
});

// ---------------------------------------------------------------------------
// POST /api/attendance/sync  — offline batch sync
// body: { events: Array<{ event_type, user_id, event_time, qr_token?, notes?, client_uuid? }> }
// ---------------------------------------------------------------------------
export const syncEvents = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, role, userId: callerId, storeId: callerStoreId } = req.user!;

  const { events } = req.body as {
    events: Array<{
      event_type: 'checkin' | 'checkout' | 'break_start' | 'break_end';
      user_id?: number;
      unique_id?: string;
      event_time: string;
      client_uuid?: string;
      device_fingerprint?: string;
      qr_token?: string;
      notes?: string;
    }>;
  };

  if (!Array.isArray(events) || events.length === 0) {
    badRequest(res, 'Nessun evento da sincronizzare', 'VALIDATION_ERROR');
    return;
  }

  if (companyId == null) {
    badRequest(res, 'Company ID non trovato nel token sessione', 'SESSION_ERROR');
    return;
  }

  const VALID_TYPES = new Set(['checkin', 'checkout', 'break_start', 'break_end']);
  let synced = 0;
  let failed = 0;
  const errors: string[] = [];

  // 1. Resolve users
  const uniqueIdStrings = [...new Set(events.filter((e) => e.unique_id).map((e) => e.unique_id as string))];
  const uniqueIdMap = new Map<string, number>();
  if (uniqueIdStrings.length > 0) {
    const uniqueIdRows = await query<{ id: number; unique_id: string }>(
      `SELECT id, unique_id FROM users
       WHERE LOWER(unique_id) = ANY(ARRAY(SELECT LOWER(x) FROM unnest($1::text[]) x)) 
         AND company_id = $2::int AND status = 'active'`,
      [uniqueIdStrings, companyId],
    );
    for (const row of uniqueIdRows) {
      uniqueIdMap.set(row.unique_id.toLowerCase(), row.id);
    }
  }
  const numericUserIds = [...new Set(events.filter((e) => !e.unique_id && e.user_id != null).map((e) => e.user_id as number))];
  const validUserRows = await query<{ id: number }>(
    numericUserIds.length > 0
      ? `SELECT id FROM users WHERE id = ANY($1::int[]) AND company_id = $2::int AND status = 'active'`
      : `SELECT id FROM users WHERE FALSE AND company_id = $1::int`,
    numericUserIds.length > 0 ? [numericUserIds, companyId] : [companyId],
  );
  const validUserSet = new Set(validUserRows.map((r) => r.id));

  // If the caller doesn't have a storeId in their JWT (e.g. Admin/HR), 
  // we try to resolve it from the user's registry if needed as a last resort.
  let resolvedCallerStoreId = callerStoreId;
  if (!resolvedCallerStoreId) {
    const userRow = await queryOne<{ store_id: number | null }>(
      `SELECT store_id FROM users WHERE id = $1::int`,
      [callerId]
    );
    resolvedCallerStoreId = userRow?.store_id || null;
  }

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const rowNum = i + 1;

    // Security: employees can only sync their own data
    let resolvedUserId: number | undefined;
    if (ev.unique_id) {
      resolvedUserId = uniqueIdMap.get(ev.unique_id.toLowerCase());
    }

    // Fallback to user_id if unique_id didn't resolve or wasn't provided
    if (resolvedUserId == null && ev.user_id != null) {
      resolvedUserId = ev.user_id;
    }

    if (role === 'employee' && resolvedUserId !== callerId) {
      console.warn(`[Sync] Row ${rowNum} REJECTED: User mismatch (Target ${resolvedUserId} vs Caller ${callerId})`);
      errors.push(`Evento ${rowNum}: Non puoi sincronizzare dati per altri utenti`);
      failed++;
      continue;
    }
    if (!VALID_TYPES.has(ev.event_type)) {
      errors.push(`Evento ${rowNum}: tipo non valido '${ev.event_type}'`);
      failed++;
      continue;
    }

    const ts = new Date(ev.event_time);
    if (isNaN(ts.getTime())) {
      errors.push(`Evento ${rowNum}: data/ora non valida`);
      failed++;
      continue;
    }

    // Reject timestamps more than 5 minutes in the future
    const FIVE_MIN_MS = 5 * 60 * 1000;
    if (ts.getTime() > Date.now() + FIVE_MIN_MS) {
      errors.push(`Evento ${rowNum}: data/ora non può essere nel futuro`);
      failed++;
      continue;
    }

    // Resolve user ID within company
    if (ev.unique_id && resolvedUserId == null) {
      errors.push(`Evento ${rowNum}: dipendente '${ev.unique_id}' non trovato o inattivo`);
      failed++;
      continue;
    }

    if (resolvedUserId == null) {
      errors.push(`Evento ${rowNum}: utente non risolto`);
      failed++;
      continue;
    }

    // QR token verification for store resolution when present.
    let storeId = resolvedCallerStoreId || 0;
    let qrTokenId: number | null = null;
    if (ev.qr_token) {
      try {
        const payload = verifyQrToken2(ev.qr_token);
        if (payload.companyId === companyId) {
          storeId = payload.storeId;
          // [FIX] Table name is qr_tokens, not attendance_qr_tokens
          const tokenRow = await queryOne<{ id: number }>(
            `SELECT id FROM qr_tokens WHERE nonce = $1 AND store_id = $2::int`,
            [payload.nonce, storeId]
          );
          if (tokenRow) qrTokenId = tokenRow.id;
        }
      } catch (err) {
        // We log it but proceed with the user's home store if possible
        console.warn(`[Sync] QR token in event ${rowNum} expired or invalid, using fallback store_id`);
      }
    }

    if (!storeId) {
      // Final attempt to find the target user's store
      const targetUser = await queryOne<{ store_id: number | null }>(
        `SELECT store_id FROM users WHERE id = $1::int`,
        [resolvedUserId]
      );
      storeId = targetUser?.store_id || 0;
    }

    if (!storeId) {
      errors.push(`Evento ${rowNum}: store_id non determinabile (nessun store assegnato all'utente)`);
      failed++;
      continue;
    }

    // ── Shift validation (same rule as checkin) ───────────────────────────
    // Find the shift whose window contains this event's timestamp (or the day's shift).
    const eventIso = ts.toISOString();
    const eventDate = eventIso.slice(0, 10); // YYYY-MM-DD

    // For checkout / break events, first resolve the shift from the open
    // check-in (a check-in with no checkout yet) up to this event's time. This
    // correctly handles shifts crossing midnight, where the event's calendar
    // day differs from the shift's date.
    let dayShift: { id: number; shift_date: string; shift_timezone: string } | null = null;

    if (ev.event_type !== 'checkin') {
      dayShift = await queryOne<{
        id: number;
        shift_date: string;
        shift_timezone: string;
      }>(
        `SELECT
           s.id,
           TO_CHAR(s.date, 'YYYY-MM-DD') AS shift_date,
           ${SHIFT_TIMEZONE_SQL} AS shift_timezone
         FROM attendance_events ae
         JOIN shifts s ON s.id = ae.shift_id
         WHERE ae.company_id = $1::int
           AND ae.user_id = $2::int
           AND ae.store_id = $3::int
           AND ae.event_type = 'checkin'
           AND ae.event_time <= $4::timestamptz
           AND ae.event_time >= $4::timestamptz - INTERVAL '24 hours'
           AND s.status != 'cancelled'
           AND NOT EXISTS (
             SELECT 1 FROM attendance_events co
             WHERE co.company_id = ae.company_id
               AND co.user_id = ae.user_id
               AND co.store_id = ae.store_id
               AND co.event_type = 'checkout'
               AND co.event_time >= ae.event_time
               AND co.event_time <= $4::timestamptz
           )
         ORDER BY ae.event_time DESC
         LIMIT 1`,
        [companyId, resolvedUserId, storeId, eventIso],
      );
    }

    // Look for any non-cancelled shift for this user/store on the event's date
    if (!dayShift) {
      dayShift = await queryOne<{
        id: number;
        shift_date: string;
        shift_timezone: string;
      }>(
        `SELECT
           s.id,
           TO_CHAR(s.date, 'YYYY-MM-DD') AS shift_date,
           ${SHIFT_TIMEZONE_SQL} AS shift_timezone
         FROM shifts s
         WHERE s.company_id = $1::int
           AND s.user_id = $2::int
           AND s.store_id = $3::int
           AND s.status != 'cancelled'
           AND s.date = $4::DATE
         ORDER BY ${SHIFT_START_UTC_SQL}
         LIMIT 1`,
        [companyId, resolvedUserId, storeId, eventDate],
      );
    }

    if (!dayShift) {
      errors.push(`Evento ${rowNum}: nessun turno programmato per questo giorno`);
      failed++;
      continue;
    }

    // Sequence/leave validation is keyed off the shift's own date so that a
    // checkout recorded after midnight still matches its check-in.
    const seqDate = dayShift.shift_date;

    // Check for approved leave on that day
    const onLeave = await queryOne<{ id: number }>(
      `SELECT id FROM leave_requests
       WHERE company_id = $1::int
         AND user_id = $2::int
         AND status = ANY($4::text[])
         AND start_date <= $3::date
         AND end_date   >= $3::date
       LIMIT 1`,
      [companyId, resolvedUserId, seqDate, APPROVED_LEAVE_STATUSES],
    );
    if (onLeave) {
      errors.push(`Evento ${rowNum}: presenza non consentita durante ferie/permesso approvato`);
      failed++;
      continue;
    }

    // ── Sequence validation (same rules as checkin) ───────────────────────
    const dayEventsForSeq = await query<{ event_type: string }>(
      `SELECT event_type
       FROM attendance_events
       WHERE company_id = $1::int
         AND user_id = $2::int
         AND event_time >= (($3::DATE)::timestamp AT TIME ZONE $4)
         AND event_time <  ((($3::DATE + INTERVAL '1 day')::timestamp) AT TIME ZONE $4)
       ORDER BY event_time ASC`,
      [companyId, resolvedUserId, seqDate, dayShift.shift_timezone],
    );

    const hasEvt = (type: string) => dayEventsForSeq.some((e) => e.event_type === type);

    if (hasEvt(ev.event_type)) {
      errors.push(`Evento ${rowNum}: azione già registrata oggi`);
      failed++;
      continue;
    }

    if (ev.event_type === 'checkin') {
      if (dayEventsForSeq.length > 0) {
        errors.push(`Evento ${rowNum}: check-in già effettuato oggi`);
        failed++;
        continue;
      }
    } else if (ev.event_type === 'break_start') {
      if (!hasEvt('checkin')) {
        errors.push(`Evento ${rowNum}: devi effettuare prima il check-in`);
        failed++;
        continue;
      }
    } else if (ev.event_type === 'break_end') {
      if (!hasEvt('checkin')) {
        errors.push(`Evento ${rowNum}: devi effettuare prima il check-in`);
        failed++;
        continue;
      }
      if (!hasEvt('break_start')) {
        errors.push(`Evento ${rowNum}: devi avviare la pausa prima di terminarla`);
        failed++;
        continue;
      }
    } else if (ev.event_type === 'checkout') {
      if (!hasEvt('checkin')) {
        errors.push(`Evento ${rowNum}: devi effettuare prima il check-in`);
        failed++;
        continue;
      }
      if (hasEvt('break_start') && !hasEvt('break_end')) {
        errors.push(`Evento ${rowNum}: termina prima la pausa`);
        failed++;
        continue;
      }
    }

    // ── Shift linking (optional helper for reporting) ─────────────────────
    const linkedShift = await queryOne<{ id: number }>(
      `SELECT s.id
       FROM shifts s
       WHERE s.company_id = $1::int
         AND s.user_id = $2::int
         AND s.store_id = $3::int
         AND s.status != 'cancelled'
         AND ${SHIFT_START_UTC_SQL} <= $4::TIMESTAMPTZ
         AND ${SHIFT_END_UTC_SQL} >= $4::TIMESTAMPTZ
       ORDER BY ${SHIFT_START_UTC_SQL}
       LIMIT 1`,
      [companyId, resolvedUserId, storeId, eventIso],
    );

    try {
      await queryOne(
        `INSERT INTO attendance_events
           (company_id, store_id, user_id, event_type, event_time, source, shift_id, notes, qr_token_id)
         VALUES ($1::int, $2::int, $3::int, $4, $5, $6, $7::int, $8, $9::int)
         ON CONFLICT (company_id, user_id, event_type, event_time) DO NOTHING`,
        [
          companyId,
          storeId,
          resolvedUserId,
          ev.event_type,
          eventIso,
          qrTokenId != null ? 'qr' : 'sync',
          linkedShift?.id ?? null,
          ev.notes ?? null,
          qrTokenId,
        ],
      );
      synced++;
    } catch {
      errors.push(`Evento ${i + 1}: errore inserimento`);
      failed++;
    }
  }

  ok(res, { synced, failed, errors: errors.slice(0, 20), total: events.length });
});

// ---------------------------------------------------------------------------
// GET /api/attendance/anomalies
// Query params: store_id?, date_from?, date_to?
// Anomaly types: late_arrival, no_show, long_break, early_exit
// ---------------------------------------------------------------------------
export interface AnomalyResult {
  shift_id: number;
  company_id: number;
  user_id: number;
  user_name: string;
  user_surname: string;
  user_avatar_filename: string | null;
  store_name: string;
  date: string;
  anomaly_type: 'late_arrival' | 'no_show' | 'long_break' | 'early_exit' | 'overtime' | 'missing_checkout' | 'missing_break' | 'on_leave';
  severity: 'low' | 'medium' | 'high' | 'info';
  details: string;
  details_key: string;
  details_params: Record<string, string | number>;
  checkin_source: string | null;
}

export interface AnomalyScopeOptions {
  role?: string;
  callerStoreId?: number | null;
  managedStoreIds?: number[] | null;
  store_id?: string | number | null;
  filterUserId?: number | null;
  search?: string;
}

function parseShiftPointUtc(dateStr: string, timeStr: string, timeZone: string = DEFAULT_SHIFT_TIMEZONE): Date {
  const cleanTime = timeStr.length === 5 ? `${timeStr}:00` : timeStr;
  const isoString = `${dateStr}T${cleanTime}`;
  const naive = new Date(`${isoString}Z`);
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(naive);
    const getPart = (type: string) => parts.find((p) => p.type === type)?.value || '00';
    const tzYear = getPart('year');
    const tzMonth = getPart('month');
    const tzDay = getPart('day');
    const tzHour = getPart('hour') === '24' ? '00' : getPart('hour');
    const tzMinute = getPart('minute');
    const tzSecond = getPart('second');

    const naiveInTzAsUtc = new Date(Date.UTC(+tzYear, +tzMonth - 1, +tzDay, +tzHour, +tzMinute, +tzSecond)).getTime();
    const diff = naiveInTzAsUtc - naive.getTime();
    return new Date(naive.getTime() - diff);
  } catch {
    return new Date(isoString);
  }
}

function formatInTimezone(date: Date, timeZone: string = DEFAULT_SHIFT_TIMEZONE): string {
  try {
    return date.toLocaleTimeString('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return date.toTimeString().slice(0, 5);
  }
}

export async function calculateAnomaliesForRange(
  allowedCompanyIds: number[],
  from: string,
  to: string,
  scope: AnomalyScopeOptions = {}
): Promise<AnomalyResult[]> {
  if (!allowedCompanyIds || allowedCompanyIds.length === 0) {
    return [];
  }
  const { role, callerStoreId, managedStoreIds, store_id, filterUserId, search } = scope;

  // Build store-scope WHERE clause
  function buildStoreWhere(alias: string, startIdx: number): { clause: string; params: any[]; nextIdx: number } {
    if (role === 'store_manager') {
      return { clause: ` AND ${alias}.store_id = $${startIdx}`, params: [callerStoreId], nextIdx: startIdx + 1 };
    }
    if (role === 'area_manager' && managedStoreIds) {
      const ph = managedStoreIds.map((_, i) => `$${startIdx + i}`).join(',');
      return { clause: ` AND ${alias}.store_id IN (${ph})`, params: managedStoreIds, nextIdx: startIdx + managedStoreIds.length };
    }
    if (store_id) {
      return { clause: ` AND ${alias}.store_id = $${startIdx}`, params: [typeof store_id === 'string' ? parseInt(store_id, 10) : store_id], nextIdx: startIdx + 1 };
    }
    return { clause: '', params: [], nextIdx: startIdx };
  }

  // Fetch past non-cancelled shifts in date range
  const shiftScope = buildStoreWhere('s', 4);
  let shiftExtraWhere = '';
  const shiftExtraParams: Array<string | number> = [];
  let shiftIdx = shiftScope.nextIdx;
  if (filterUserId != null) {
    shiftExtraWhere += ` AND s.user_id = $${shiftIdx}`;
    shiftExtraParams.push(filterUserId);
    shiftIdx++;
  }
  if (search) {
    const escapedSearch = search.replace(/%/g, '\\%').replace(/_/g, '\\_');
    shiftExtraWhere += ` AND (LOWER(u.name) LIKE LOWER($${shiftIdx}) ESCAPE '\\' OR LOWER(u.surname) LIKE LOWER($${shiftIdx}) ESCAPE '\\' OR u.unique_id ILIKE $${shiftIdx} ESCAPE '\\')`;
    shiftExtraParams.push(`%${escapedSearch}%`);
    shiftIdx++;
  }

  const shifts = await query<{
    id: number; company_id: number; user_id: number; store_id: number; date: string;
    start_time: string; end_time: string;
    break_start: string | null; break_end: string | null; break_minutes: number | null;
    user_name: string; user_surname: string; store_name: string;
    user_avatar_filename: string | null;
    store_timezone: string | null;
  }>(
    `SELECT s.id, s.company_id, s.user_id, s.store_id, TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
            s.start_time, s.end_time, s.break_start, s.break_end, s.break_minutes,
            u.name AS user_name, u.surname AS user_surname, u.avatar_filename AS user_avatar_filename,
            st.name AS store_name,
            -- The gate in recordEvent resolves a shift's instants from s.timezone.
            -- Reading st.timezone here instead meant the two disagreed whenever a
            -- shift carried the wrong zone: the dashboard called the Varese four
            -- absent at 09:10 while the terminal was still telling them it was too
            -- early. One source of truth — the shift's own zone, the store's only
            -- as a fallback for legacy rows that never had one.
            COALESCE(
              NULLIF(BTRIM(s.timezone), ''),
              NULLIF(BTRIM(st.timezone), ''),
              '${DEFAULT_SHIFT_TIMEZONE_SQL}'
            ) AS store_timezone
     FROM shifts s
     LEFT JOIN users u  ON u.id  = s.user_id
     LEFT JOIN stores st ON st.id = s.store_id
     WHERE s.company_id = ANY($1)
       AND s.date BETWEEN $2 AND $3
       AND s.status != 'cancelled'
       AND s.date <= CURRENT_DATE
       ${shiftScope.clause}
       ${shiftExtraWhere}
     ORDER BY s.date, s.user_id`,
    [allowedCompanyIds, from, to, ...shiftScope.params, ...shiftExtraParams],
  );

  if (shifts.length === 0) {
    return [];
  }

  // Fetch attendance events for the same period + scope
  const evScope = buildStoreWhere('ae', 4);
  let evExtraWhere = '';
  const evExtraParams: Array<string | number> = [];
  let evIdx = evScope.nextIdx;
  if (filterUserId != null) {
    evExtraWhere += ` AND ae.user_id = $${evIdx}`;
    evExtraParams.push(filterUserId);
    evIdx++;
  }
  const events = await query<{
    user_id: number; event_type: string; event_time: string; source: string;
  }>(
    `SELECT ae.user_id, ae.event_type, ae.event_time, ae.source
     FROM attendance_events ae
     WHERE ae.company_id = ANY($1)
       AND ae.event_time::DATE BETWEEN $2 AND $3
       ${evScope.clause}
       ${evExtraWhere}
     ORDER BY ae.user_id, ae.event_time`,
    [allowedCompanyIds, from, to, ...evScope.params, ...evExtraParams],
  );

  // Group events by (user_id, date)
  type EventGroup = { checkin?: Date; checkout?: Date; break_start?: Date; break_end?: Date; checkin_source?: string };
  const eventMap = new Map<string, EventGroup>();
  for (const e of events) {
    const date = localDateStr(new Date(e.event_time));
    const key = `${e.user_id}:${date}`;
    if (!eventMap.has(key)) eventMap.set(key, {});
    const group = eventMap.get(key)!;
    const t = new Date(e.event_time);
    if (e.event_type === 'checkin' && (!group.checkin || t < group.checkin)) { group.checkin = t; group.checkin_source = e.source; }
    if (e.event_type === 'checkout' && (!group.checkout || t > group.checkout)) group.checkout = t;
    if (e.event_type === 'break_start' && (!group.break_start || t < group.break_start)) group.break_start = t;
    if (e.event_type === 'break_end' && (!group.break_end || t > group.break_end)) group.break_end = t;
  }

  // Days already covered by approved leave. Loaded once for the window: the
  // loop below runs over every shift and cannot afford a query each.
  const leaveDays = await loadApprovedLeaveDays(allowedCompanyIds, from, to, {
    userId: filterUserId ?? null,
  });

  const LATE_MS = 10 * 60 * 1000; // 10 minutes
  const EARLY_EXIT_MS = 1000;
  const LONG_BREAK_MS = 5 * 60 * 1000;  // 5 minutes
  const OVERTIME_MS = 60 * 60 * 1000; // 1 hour
  const MISSING_CHECKOUT_MS = 30 * 60 * 1000; // 30 minutes after shift end

  const anomalies: AnomalyResult[] = [];
  const nowTs = new Date().getTime();

  for (const shift of shifts) {
    const storeTz = normalizeShiftTimezone(shift.store_timezone, DEFAULT_SHIFT_TIMEZONE);
    const key = `${shift.user_id}:${shift.date}`;
    const evGroup = eventMap.get(key);
    const shiftStart = parseShiftPointUtc(shift.date, shift.start_time, storeTz);
    const shiftEnd   = parseShiftPointUtc(shift.date, shift.end_time, storeTz);
    
    // Only process shifts that have actually started (avoid future shifts loaded from today)
    if (shiftStart.getTime() > nowTs) continue;

    if (!evGroup?.checkin) {
      if (shiftEnd.getTime() < nowTs || shiftStart.getTime() + LATE_MS < nowTs) {
        // A person on approved leave is not an unjustified absence. The shift
        // may well still be active — cancel_shifts is optional on approval — so
        // the shift status alone cannot be trusted here. Reported as `on_leave`
        // rather than dropped, so the manager sees why the slot is empty.
        const onLeave = leaveDays.has(leaveCoverageKey(shift.user_id, shift.date));
        anomalies.push({
          shift_id: shift.id, company_id: shift.company_id, user_id: shift.user_id,
          user_name: shift.user_name, user_surname: shift.user_surname,
          user_avatar_filename: shift.user_avatar_filename,
          store_name: shift.store_name, date: shift.date,
          anomaly_type: onLeave ? 'on_leave' : 'no_show',
          severity: onLeave ? 'info' : 'high',
          details: onLeave
            ? `Assenza giustificata da permesso approvato. Turno: ${shift.start_time.slice(0, 5)}–${shift.end_time.slice(0, 5)}`
            : `Nessun arrivo registrato. Turno: ${shift.start_time.slice(0, 5)}–${shift.end_time.slice(0, 5)}`,
          details_key: onLeave ? 'attendance.detail_on_leave' : 'attendance.detail_no_show',
          details_params: { start: shift.start_time.slice(0, 5), end: shift.end_time.slice(0, 5) },
          checkin_source: null,
        });
      }
      continue;
    }

    const { checkin, checkout, break_start: bStart, break_end: bEnd } = evGroup;

    // Late arrival
    const lateMs = checkin.getTime() - shiftStart.getTime();
    if (lateMs > LATE_MS) {
      const lateMin = Math.round(lateMs / 60000);
      const entryStr = formatInTimezone(checkin, storeTz);
      anomalies.push({
        shift_id: shift.id, company_id: shift.company_id, user_id: shift.user_id,
        user_name: shift.user_name, user_surname: shift.user_surname,
        user_avatar_filename: shift.user_avatar_filename,
        store_name: shift.store_name, date: shift.date,
        anomaly_type: 'late_arrival', severity: lateMin > 30 ? 'high' : 'medium',
        details: `Ritardo di ${lateMin} min. Entrata: ${entryStr}, Turno: ${shift.start_time.slice(0, 5)}`,
        details_key: 'attendance.detail_late_arrival',
        details_params: { minutes: lateMin, entry: entryStr, shift: shift.start_time.slice(0, 5) },
        checkin_source: evGroup.checkin_source ?? null,
      });
    }

    // Early exit
    if (checkout) {
      const earlyMs = shiftEnd.getTime() - checkout.getTime();
      if (earlyMs >= EARLY_EXIT_MS) {
        const earlyMin = Math.round(earlyMs / 60000);
        const exitStr = formatInTimezone(checkout, storeTz);
        anomalies.push({
          shift_id: shift.id, company_id: shift.company_id, user_id: shift.user_id,
          user_name: shift.user_name, user_surname: shift.user_surname,
          user_avatar_filename: shift.user_avatar_filename,
          store_name: shift.store_name, date: shift.date,
          anomaly_type: 'early_exit', severity: earlyMin > 30 ? 'high' : 'medium',
          details: `Uscita anticipata di ${earlyMin} min. Uscita: ${exitStr}, Fine turno: ${shift.end_time.slice(0, 5)}`,
          details_key: 'attendance.detail_early_exit',
          details_params: { minutes: earlyMin, exit: exitStr, shift: shift.end_time.slice(0, 5) },
          checkin_source: evGroup.checkin_source ?? null,
        });
      }
    }

    // Long break
    if (bEnd && shift.break_end) {
      const scheduledBreakEnd = parseShiftPointUtc(shift.date, shift.break_end, storeTz);
      const breakLateMs = bEnd.getTime() - scheduledBreakEnd.getTime();
      if (breakLateMs > LONG_BREAK_MS) {
        const breakMin = Math.round(breakLateMs / 60000);
        anomalies.push({
          shift_id: shift.id, company_id: shift.company_id, user_id: shift.user_id,
          user_name: shift.user_name, user_surname: shift.user_surname,
          user_avatar_filename: shift.user_avatar_filename,
          store_name: shift.store_name, date: shift.date,
          anomaly_type: 'long_break', severity: breakMin > 30 ? 'high' : 'medium',
          details: `Pausa terminata in ritardo di ${breakMin} min. Fine prevista: ${shift.break_end.slice(0, 5)}`,
          details_key: 'attendance.detail_long_break',
          details_params: { minutes: breakMin },
          checkin_source: evGroup.checkin_source ?? null,
        });
      }
    }

    // Missing break (mandatory break scheduled, employee clocked in and out/shift passed, but no break recorded)
    const hasSchBreak = (shift.break_start && shift.break_end) || (shift.break_minutes && shift.break_minutes > 0);
    if (hasSchBreak && checkin && (checkout || shiftEnd.getTime() <= nowTs) && !bStart && !bEnd) {
      let schMins = 60;
      if (shift.break_minutes) {
        schMins = shift.break_minutes;
      } else if (shift.break_start && shift.break_end) {
        const [bsh, bsm] = shift.break_start.split(':').map(Number);
        const [beh, bem] = shift.break_end.split(':').map(Number);
        schMins = (beh * 60 + bem) - (bsh * 60 + bsm);
        if (schMins < 0) schMins += 24 * 60;
      }
      anomalies.push({
        shift_id: shift.id, company_id: shift.company_id, user_id: shift.user_id,
        user_name: shift.user_name, user_surname: shift.user_surname,
        user_avatar_filename: shift.user_avatar_filename,
        store_name: shift.store_name, date: shift.date,
        anomaly_type: 'missing_break', severity: 'medium',
        details: `Pausa obbligatoria di ${schMins} min programmata ma non registrata`,
        details_key: 'attendance.detail_missing_break',
        details_params: { minutes: schMins },
        checkin_source: evGroup.checkin_source ?? null,
      });
    }

    // Missing checkout
    if (checkin && !checkout && shiftEnd.getTime() + MISSING_CHECKOUT_MS < nowTs) {
      const checkinStr = formatInTimezone(checkin, storeTz);
      anomalies.push({
        shift_id: shift.id, company_id: shift.company_id, user_id: shift.user_id,
        user_name: shift.user_name, user_surname: shift.user_surname,
        user_avatar_filename: shift.user_avatar_filename,
        store_name: shift.store_name, date: shift.date,
        anomaly_type: 'missing_checkout', severity: 'high',
        details: `Mancata uscita. Entrata: ${checkinStr}, Fine turno: ${shift.end_time.slice(0, 5)}`,
        details_key: 'attendance.detail_missing_checkout',
        details_params: { 
          checkin: checkinStr, 
          shift_end: shift.end_time.slice(0, 5) 
        },
        checkin_source: evGroup.checkin_source ?? null,
      });
    }

    // Overtime
    if (checkout) {
      const overtimeMs = checkout.getTime() - shiftEnd.getTime();
      if (overtimeMs > OVERTIME_MS) {
        const overtimeMin = Math.round(overtimeMs / 60000);
        const exitStr = formatInTimezone(checkout, storeTz);
        anomalies.push({
          shift_id: shift.id, company_id: shift.company_id, user_id: shift.user_id,
          user_name: shift.user_name, user_surname: shift.user_surname,
          user_avatar_filename: shift.user_avatar_filename,
          store_name: shift.store_name, date: shift.date,
          anomaly_type: 'overtime', severity: overtimeMin > 30 ? 'high' : 'medium',
          details: `Straordinario di ${overtimeMin} min. Fine turno prevista: ${shift.end_time.slice(0, 5)}`,
          details_key: 'attendance.detail_overtime',
          details_params: {
            minutes: overtimeMin,
            actual: exitStr,
            scheduled: shift.end_time.slice(0, 5),
          },
          checkin_source: evGroup.checkin_source ?? null,
        });
      }
    }
  }

  return anomalies;
}

export async function sendAnomalyNotifications(anomalies: AnomalyResult[]): Promise<void> {
  const localeCache = new Map<number, string>();
  for (const anomaly of anomalies) {
    // `on_leave` is context for the manager's screen, not an incident. Alerting
    // someone because a colleague is on approved holiday is the noise this fix
    // exists to remove.
    if (anomaly.anomaly_type === 'on_leave') continue;
    if (!localeCache.has(anomaly.user_id)) {
      const localeRow = await queryOne<{ locale: string | null }>(
        `SELECT locale
         FROM users
         WHERE id = $1 AND company_id = $2
         LIMIT 1`,
        [anomaly.user_id, anomaly.company_id],
      );
      localeCache.set(anomaly.user_id, localeRow?.locale ?? 'it');
    }

    const locale = localeCache.get(anomaly.user_id) ?? 'it';
    const kind = t(locale, `notifications.attendance_anomaly_kind_${anomaly.anomaly_type}`);
    const title = t(locale, 'notifications.attendance_anomaly.title');
    const message = t(locale, 'notifications.attendance_anomaly.message', {
      kind,
      date: anomaly.date,
      store: anomaly.store_name,
    });

    const existing = await queryOne<{ id: number }>(
      `SELECT id
       FROM notifications
       WHERE company_id = $1
         AND user_id = $2
         AND type = 'attendance.anomaly'
         AND title = $3
         AND message = $4
         AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [anomaly.company_id, anomaly.user_id, title, message],
    );
    if (existing) {
      continue;
    }

    const priority = (anomaly.anomaly_type === 'no_show' || anomaly.anomaly_type === 'missing_checkout')
      ? 'high'
      : (anomaly.anomaly_type === 'overtime' ? 'low' : 'medium');

    await sendNotification({
      companyId: anomaly.company_id,
      userId: anomaly.user_id,
      type: 'attendance.anomaly',
      title,
      message,
      priority,
      locale,
    });
  }
}

export const getAnomalies = asyncHandler(async (req: Request, res: Response) => {
  const { role, userId, storeId: callerStoreId } = req.user!;
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const { store_id, user_id, search, date_from, date_to } = req.query as Record<string, string>;

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (date_from && !DATE_RE.test(date_from)) {
    badRequest(res, 'date_from non valido (YYYY-MM-DD)', 'VALIDATION_ERROR'); return;
  }
  if (date_to && !DATE_RE.test(date_to)) {
    badRequest(res, 'date_to non valido (YYYY-MM-DD)', 'VALIDATION_ERROR'); return;
  }
  let filterUserId: number | null = null;
  if (user_id) {
    const uid = parseInt(user_id, 10);
    if (isNaN(uid) || uid < 1) {
      badRequest(res, 'user_id non valido', 'VALIDATION_ERROR'); return;
    }
    filterUserId = uid;
  }

  const today = localToday();
  const from = date_from || today;
  const to = date_to || today;

  // Cap date range to 14 days to prevent expensive full-table scans
  const diffDays = (new Date(to).getTime() - new Date(from).getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays > 14) {
    badRequest(res, "L'intervallo di date non può superare 14 giorni", 'VALIDATION_ERROR'); return;
  }

  // Resolve managed store IDs once (used for both shifts and events scoping)
  let managedStoreIds: number[] | null = null;
  if (role === 'area_manager') {
    managedStoreIds = await resolveAreaManagerStoreIds(userId, allowedCompanyIds);
    if (managedStoreIds.length === 0) {
      ok(res, { anomalies: [], total: 0 });
      return;
    }
  }

  const rawCompParam = (req.query.company_id || req.query.companyId) as string | undefined;
  const targetCompanyIds = rawCompParam && !isNaN(parseInt(rawCompParam, 10)) && parseInt(rawCompParam, 10) > 0
    ? [parseInt(rawCompParam, 10)]
    : allowedCompanyIds;

  if (!targetCompanyIds || targetCompanyIds.length === 0) {
    ok(res, { anomalies: [], total: 0 });
    return;
  }

  const anomalies = await calculateAnomaliesForRange(targetCompanyIds, from, to, {
    role,
    callerStoreId,
    managedStoreIds,
    store_id: store_id ? parseInt(store_id, 10) : null,
    filterUserId,
    search
  });

  await sendAnomalyNotifications(anomalies);

  // `on_leave` rows are context, not incidents. They are returned so the
  // manager can see why a slot is empty, but the headline count must only
  // report real anomalies — otherwise excluding people on approved leave from
  // no_show would still leave them inflating the total.
  const realAnomalies = anomalies.filter(a => a.anomaly_type !== 'on_leave');
  ok(res, {
    anomalies,
    total: realAnomalies.length,
    on_leave_count: anomalies.length - realAnomalies.length,
  });
});

// ---------------------------------------------------------------------------
// PUT /api/attendance/:id
// body: { event_type?, event_time?, notes? }
// Requires admin or hr role. Updates a single attendance_events record.
// ---------------------------------------------------------------------------
export const updateAttendanceEvent = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const id = parseInt(req.params.id, 10);

  if (!id || isNaN(id)) {
    badRequest(res, 'ID non valido', 'VALIDATION_ERROR');
    return;
  }

  const { event_type, event_time, notes } = req.body as {
    event_type?: string;
    event_time?: string;
    notes?: string;
  };

  const VALID_EVENT_TYPES = new Set(['checkin', 'checkout', 'break_start', 'break_end']);
  if (event_type && !VALID_EVENT_TYPES.has(event_type)) {
    badRequest(res, 'event_type non valido', 'VALIDATION_ERROR');
    return;
  }

  if (event_time) {
    const ts = new Date(event_time);
    if (isNaN(ts.getTime())) {
      badRequest(res, 'event_time non valido', 'VALIDATION_ERROR');
      return;
    }
  }

  // Verify record exists and belongs to this company
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM attendance_events WHERE id = $1 AND company_id = ANY($2)`,
    [id, allowedCompanyIds],
  );
  if (!existing) {
    notFound(res, 'Evento non trovato');
    return;
  }

  // Build dynamic SET clause
  const setClauses: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (event_type !== undefined) {
    setClauses.push(`event_type = $${idx}`);
    params.push(event_type);
    idx++;
  }
  if (event_time !== undefined) {
    setClauses.push(`event_time = $${idx}::TIMESTAMPTZ`);
    params.push(event_time);
    idx++;
  }
  if (notes !== undefined) {
    setClauses.push(`notes = $${idx}`);
    params.push(notes);
    idx++;
  }

  if (setClauses.length === 0) {
    badRequest(res, 'Nessun campo da aggiornare', 'VALIDATION_ERROR');
    return;
  }

  params.push(id, allowedCompanyIds);
  const updated = await queryOne(
    `UPDATE attendance_events
     SET ${setClauses.join(', ')}
     WHERE id = $${idx} AND company_id = ANY($${idx + 1})
     RETURNING *`,
    params,
  );

  ok(res, updated, 'Evento aggiornato');
});

// ---------------------------------------------------------------------------
// GET /api/attendance/my  — employee self-service history
// Query params: date_from?, date_to?  (defaults: last 30 days)
// ---------------------------------------------------------------------------
export const listMyAttendanceEvents = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, userId } = req.user!;

  const deviceRow = await queryOne<{ registered_device_token: string | null; registered_device_identifier: string | null; device_reset_pending: boolean }>(
    `SELECT registered_device_token, registered_device_identifier, device_reset_pending
     FROM users
     WHERE id = $1 AND company_id = $2 AND role = 'employee'`,
    [userId, companyId],
  );

  if (
    !deviceRow
    || (deviceRow.registered_device_token == null && deviceRow.registered_device_identifier == null)
    || deviceRow.device_reset_pending === true
  ) {
    forbidden(res, 'Device non registrato. Effettua prima la registrazione del dispositivo.', 'DEVICE_NOT_REGISTERED');
    return;
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const { date_from, date_to, device_fingerprint, timezone } = req.query as Record<string, string>;
  const displayTimezone = normalizeShiftTimezone(timezone, DEFAULT_SHIFT_TIMEZONE);

  if (!device_fingerprint || typeof device_fingerprint !== 'string') {
    forbidden(
      res,
      'Your device is different, you will not able to check in, check out, break start, break end',
      'DEVICE_MISMATCH',
    );
    return;
  }

  // Matches the current identity, and falls back to the pre-install-id scheme so
  // a device registered before the rework is still recognised here.
  if (!matchesRegisteredDevice(deviceRow, resolveDeviceIdentity(device_fingerprint)).matched) {
    forbidden(
      res,
      'Your device is different, you will not able to check in, check out, break start, break end',
      'DEVICE_MISMATCH',
    );
    return;
  }

  if (date_from && !DATE_RE.test(date_from)) {
    badRequest(res, 'date_from non valido (YYYY-MM-DD)', 'VALIDATION_ERROR'); return;
  }
  if (date_to && !DATE_RE.test(date_to)) {
    badRequest(res, 'date_to non valido (YYYY-MM-DD)', 'VALIDATION_ERROR'); return;
  }

  const today = localToday();
  const defaultFrom = localDateStr(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const from = date_from || defaultFrom;
  const to = date_to || today;

  const events = await query(
    `SELECT
       ae.id, ae.event_type, ae.event_time, ae.source, ae.notes, ae.created_at,
       st.name AS store_name
     FROM attendance_events ae
     LEFT JOIN stores st ON st.id = ae.store_id
     WHERE ae.company_id = $1
       AND ae.user_id = $2
       AND ae.event_time >= (($3::DATE)::timestamp AT TIME ZONE $5)
       AND ae.event_time < ((($4::DATE + INTERVAL '1 day')::timestamp) AT TIME ZONE $5)
     ORDER BY ae.event_time DESC
     LIMIT 200`,
    [companyId, userId, from, to, displayTimezone],
  );

  ok(res, { events: events || [], total: (events || []).length });
});

// ---------------------------------------------------------------------------
// DELETE /api/attendance/:id
// Requires admin role. Hard-deletes a single attendance_events record.
// ---------------------------------------------------------------------------
export const deleteAttendanceEvent = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const id = parseInt(req.params.id, 10);

  if (!id || isNaN(id)) {
    badRequest(res, 'ID non valido', 'VALIDATION_ERROR');
    return;
  }

  // Verify record exists and belongs to this company
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM attendance_events WHERE id = $1 AND company_id = ANY($2)`,
    [id, allowedCompanyIds],
  );
  if (!existing) {
    notFound(res, 'Evento non trovato');
    return;
  }

  await queryOne(
    `DELETE FROM attendance_events WHERE id = $1 AND company_id = ANY($2)`,
    [id, allowedCompanyIds],
  );

  ok(res, { id }, 'Evento eliminato');
});

// ---------------------------------------------------------------------------
// GET /api/attendance/daily-state  — employee self-service today's state
// Returns { hasShift, hasLeave, state: { checkedIn, breakStarted, breakEnded, checkedOut } }
// Used by frontend to initialize the attendance state machine.
// ---------------------------------------------------------------------------
export const getDailyState = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, userId } = req.user!;

  // Resolve today in server local time
  const today = localToday();

  // 1. Check if employee has a shift today (any non-cancelled shift for today)
  const todayShift = await queryOne<{ id: number; store_id: number; store_name: string; shift_date: string; shift_timezone: string }>(
    `SELECT
       s.id,
       s.store_id,
       st.name AS store_name,
       TO_CHAR(s.date, 'YYYY-MM-DD') AS shift_date,
       ${SHIFT_TIMEZONE_SQL} AS shift_timezone
     FROM shifts s
     JOIN stores st ON s.store_id = st.id
     WHERE s.company_id = $1
       AND s.user_id = $2
       AND s.status != 'cancelled'
       AND s.date = $3::DATE
     ORDER BY ${SHIFT_START_UTC_SQL}
     LIMIT 1`,
    [companyId, userId, today],
  );

  // 2. Check for approved leave today
  const approvedLeave = todayShift
    ? await queryOne<{ id: number }>(
      `SELECT id
         FROM leave_requests
         WHERE company_id = $1
           AND user_id = $2
           AND status = ANY($4::text[])
           AND start_date <= $3::date
           AND end_date >= $3::date
         LIMIT 1`,
      [companyId, userId, today, APPROVED_LEAVE_STATUSES],
    )
    : null;

  const hasShift = !!todayShift;
  const hasLeave = !!approvedLeave;

  if (!hasShift || hasLeave) {
    ok(res, {
      hasShift,
      hasLeave,
      shiftStoreId: todayShift?.store_id,
      shiftStoreName: todayShift?.store_name,
      state: { checkedIn: false, breakStarted: false, breakEnded: false, checkedOut: false },
    });
    return;
  }

  // 3. Fetch today's events for state derivation
  const dayEvents = await query<{ event_type: string; event_time: Date }>(
    `SELECT event_type, event_time
     FROM attendance_events
     WHERE company_id = $1
       AND user_id = $2
       AND event_time >= (($3::DATE)::timestamp AT TIME ZONE $4)
       AND event_time <  ((($3::DATE + INTERVAL '1 day')::timestamp) AT TIME ZONE $4)
     ORDER BY event_time ASC`,
    [companyId, userId, today, todayShift.shift_timezone],
  );

  const types = dayEvents.map((e) => e.event_type);

  const findTime = (type: string) => {
    const found = dayEvents.find((e) => e.event_type === type);
    return found ? found.event_time.toISOString() : null;
  };

  const state = {
    checkedIn: types.includes('checkin'),
    checkedInTime: findTime('checkin'),
    breakStarted: types.includes('break_start'),
    breakStartedTime: findTime('break_start'),
    breakEnded: types.includes('break_end'),
    breakEndedTime: findTime('break_end'),
    checkedOut: types.includes('checkout'),
    checkedOutTime: findTime('checkout'),
  };

  ok(res, { hasShift, hasLeave, shiftStoreId: todayShift.store_id, shiftStoreName: todayShift.store_name, state });
});
