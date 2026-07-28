import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { UAParser } from 'ua-parser-js';
import { queryOne, query } from '../../config/database';
import { ok, badRequest, forbidden } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { emitToCompany } from '../../config/socket';
import {
  DeviceIdentity,
  getStoredDeviceProfileHash,
  matchesRegisteredDevice,
  resolveDeviceIdentity,
  withDeviceProfileHash,
} from '../../utils/deviceProfile';

interface DeviceRow {
  registered_device_token: string | null;
  registered_device_identifier: string | null;
  registered_device_metadata: any;
  device_reset_pending: boolean;
}

function getClientIp(req: Request): string {
  let ipAddress = ((req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim();
  if (ipAddress.startsWith('::ffff:')) {
    ipAddress = ipAddress.substring(7);
  }
  return ipAddress;
}

/**
 * Merge client-supplied metadata with server-derived user-agent/IP details.
 * The device-profile hash is stored alongside for the audit trail — it is never
 * used as an identity key, since identical hardware shares the same profile.
 */
function buildDeviceMetadata(req: Request, metadata: any, ipAddress: string) {
  const ua = req.headers['user-agent'] || '';
  const uaResult = new UAParser(ua).getResult();

  return withDeviceProfileHash({
    ...metadata,
    ipAddress,
    userAgent: ua,
    browser: {
      name: metadata?.browser?.name || uaResult.browser.name || null,
      version: metadata?.browser?.version || uaResult.browser.version || null,
    },
    os: {
      name: metadata?.os?.name || uaResult.os.name || null,
      version: metadata?.os?.version || uaResult.os.version || null,
    },
    device: {
      model: metadata?.device?.model || uaResult.device.model || null,
      vendor: metadata?.device?.vendor || uaResult.device.vendor || null,
      type: metadata?.device?.type || uaResult.device.type || null,
    },
  });
}

/**
 * Find another account in the same company already holding this device.
 *
 * Scoped to the company on purpose: the rule being enforced is "one account per
 * device within an organisation", and a global check lets one company's
 * registrations block an unrelated company's.
 *
 * Matching uses the canonical token/identifier ONLY. Neither the device-profile
 * hash nor the legacy identity derived from it is considered: both are shared by
 * every unit of the same model, so a second identical terminal would be reported
 * as a conflict against the first. Legacy values still work for recognising your
 * *own* prior registration (see `matchesRegisteredDevice`) — just not for
 * deciding that someone else owns this device.
 */
async function findConflictingRegistration(
  userId: number,
  companyId: number | null | undefined,
  identity: DeviceIdentity,
): Promise<{ id: number; name: string; surname: string } | null> {
  const params: any[] = [userId, identity.token, identity.identifier];
  let companyClause = '';
  if (companyId != null) {
    params.push(companyId);
    companyClause = `AND company_id = $${params.length}`;
  }

  return queryOne<{ id: number; name: string; surname: string }>(
    `SELECT id, name, surname
     FROM users
     WHERE id <> $1
       AND device_reset_pending = false
       ${companyClause}
       AND (
         registered_device_token = $2
         OR ($3::text IS NOT NULL AND registered_device_identifier = $3)
       )
     LIMIT 1`,
    params,
  );
}

/**
 * Release this device from accounts already flagged for reset, so the incoming
 * registration does not trip the unique index.
 */
async function releaseResetPendingHolders(userId: number, identity: DeviceIdentity): Promise<void> {
  await query(
    `UPDATE users
     SET registered_device_token = NULL,
         registered_device_identifier = NULL,
         registered_device_metadata = NULL,
         registered_device_registered_at = NULL
     WHERE id <> $1
       AND device_reset_pending = true
       AND (
         registered_device_token = $2
         OR ($3::text IS NOT NULL AND registered_device_identifier = $3)
       )`,
    [userId, identity.token, identity.identifier],
  );
}

/**
 * Move a registration created by the previous client onto the current identity
 * scheme. Best-effort: if it cannot be applied the legacy values stay in place
 * and continue to match, so the device keeps working either way.
 */
async function upgradeLegacyRegistration(userId: number, identity: DeviceIdentity): Promise<void> {
  if (!identity.isStable) return;
  try {
    await query(
      `UPDATE users
       SET registered_device_token = $1,
           registered_device_identifier = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [identity.token, identity.identifier, userId],
    );
  } catch (err) {
    console.warn('Failed to upgrade legacy device registration for user', userId, err);
  }
}

export const getDeviceStatus = asyncHandler(async (req: Request, res: Response) => {
  const { userId, companyId } = req.user!;
  const fingerprint = req.query.fingerprint as string | undefined;

  const user = await queryOne<DeviceRow>(
    `SELECT registered_device_token, registered_device_identifier, device_reset_pending, registered_device_metadata
     FROM users
     WHERE id = $1 AND company_id = $2`,
    [userId, companyId],
  );

  if (!user) {
    forbidden(res, 'Utente non trovato', 'USER_NOT_FOUND');
    return;
  }

  const ipAddress = getClientIp(req);

  // Update last seen
  await query(
    `UPDATE users
     SET last_seen_ip = $1, last_seen_at = NOW(), updated_at = NOW()
     WHERE id = $2`,
    [ipAddress, userId],
  );

  const isDeviceRegistered = user.registered_device_token != null || user.registered_device_identifier != null;
  const requiresDeviceRegistration = !isDeviceRegistered || user.device_reset_pending === true;

  let isDeviceMatched = false;
  if (isDeviceRegistered && fingerprint) {
    const identity = resolveDeviceIdentity(fingerprint);
    const match = matchesRegisteredDevice(user, identity);
    isDeviceMatched = match.matched;

    if (match.matched && match.viaLegacy) {
      // Registered under the previous scheme — migrate it in place so the device
      // is no longer tied to a profile hash that browser updates change.
      await upgradeLegacyRegistration(userId, identity);
    }
  }

  if (isDeviceRegistered) {
    if (!isDeviceMatched) {
      query(
        `INSERT INTO device_events (user_id, event_type, ip_address, user_agent)
         VALUES ($1, 'mismatch_blocked', $2, $3)`,
        [userId, ipAddress, req.headers['user-agent'] || ''],
      ).catch(() => {});
    } else {
      // Check for suspicious IP address change
      const registeredIp = user.registered_device_metadata?.ipAddress;
      if (registeredIp && ipAddress !== registeredIp) {
        query(
          `INSERT INTO device_events (user_id, event_type, ip_address, user_agent, metadata)
           VALUES ($1, 'suspicious_ip', $2, $3, $4)`,
          [userId, ipAddress, req.headers['user-agent'] || '', { registeredIp }],
        ).catch(() => {});
      }
    }
  }

  ok(res, {
    isDeviceRegistered,
    deviceResetPending: user.device_reset_pending === true,
    requiresDeviceRegistration,
    isDeviceMatched,
    // A registered-but-unmatched device can recover on its own by re-confirming
    // its credentials, instead of needing an HR reset.
    canSelfRecover: isDeviceRegistered && !requiresDeviceRegistration && !isDeviceMatched,
  });
});

export const registerDevice = asyncHandler(async (req: Request, res: Response) => {
  const { userId, companyId } = req.user!;
  const { fingerprint, metadata } = req.body as { fingerprint: string; metadata?: any };

  if (!fingerprint || typeof fingerprint !== 'string') {
    badRequest(res, 'Device fingerprint obbligatorio', 'VALIDATION_ERROR');
    return;
  }

  const user = await queryOne<DeviceRow>(
    `SELECT registered_device_token, registered_device_identifier, registered_device_metadata, device_reset_pending
     FROM users
     WHERE id = $1 AND company_id = $2 AND role <> 'admin'`,
    [userId, companyId],
  );

  if (!user) {
    forbidden(res, 'Utente non trovato', 'USER_NOT_FOUND');
    return;
  }

  const isDeviceRegistered = user.registered_device_token != null || user.registered_device_identifier != null;
  const requiresDeviceRegistration = !isDeviceRegistered || user.device_reset_pending === true;

  const ipAddress = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const mergedMetadata = buildDeviceMetadata(req, metadata, ipAddress);
  const identity = resolveDeviceIdentity(fingerprint, mergedMetadata);

  if (!requiresDeviceRegistration) {
    const match = matchesRegisteredDevice(user, identity);
    if (match.matched) {
      if (match.viaLegacy) {
        await upgradeLegacyRegistration(userId, identity);
      }
      ok(res, {
        isDeviceRegistered: true,
        deviceResetPending: false,
        requiresDeviceRegistration: false,
      }, 'Device gia registrata correttamente');
      return;
    }

    // Already bound to a different device. Recovery goes through /re-register,
    // which re-checks the account's own credentials.
    forbidden(res, 'Device registration not required', 'DEVICE_REGISTRATION_NOT_REQUIRED');
    return;
  }

  const conflict = await findConflictingRegistration(userId, companyId, identity);
  if (conflict) {
    badRequest(
      res,
      `Questo dispositivo e gia registrato da un altro dipendente (${conflict.name} ${conflict.surname})`,
      'DEVICE_ALREADY_REGISTERED',
    );
    return;
  }

  await releaseResetPendingHolders(userId, identity);

  try {
    await query(
      `UPDATE users
       SET registered_device_token = $1,
           registered_device_identifier = $2,
           registered_device_metadata = $3,
           registered_device_registered_at = NOW(),
           device_reset_pending = false,
           updated_at = NOW()
       WHERE id = $4 AND company_id = $5`,
      [identity.token, identity.identifier, mergedMetadata, userId, companyId],
    );
  } catch (err: any) {
    if (err?.code === '23505') {
      badRequest(
        res,
        'Questo dispositivo e gia registrato da un altro dipendente',
        'DEVICE_ALREADY_REGISTERED',
      );
      return;
    }
    throw err;
  }

  await logDeviceRegistration(userId, companyId, ipAddress, ua, mergedMetadata, identity);

  ok(res, {
    isDeviceRegistered: true,
    deviceResetPending: false,
    requiresDeviceRegistration: false,
  }, 'Device registrata correttamente');
});

/**
 * Record the registration in device_events + audit_logs and notify HR.
 * Also flags when another account in the company reports the same hardware
 * profile — informational only, since identical hardware is legitimate.
 */
async function logDeviceRegistration(
  userId: number,
  companyId: number | null | undefined,
  ipAddress: string,
  ua: string,
  mergedMetadata: any,
  identity: DeviceIdentity,
): Promise<void> {
  await query(
    `INSERT INTO device_events (user_id, event_type, ip_address, user_agent, metadata)
     VALUES ($1, 'registered', $2, $3, $4)`,
    [userId, ipAddress, ua, mergedMetadata],
  ).catch(err => {
    console.error('Failed to log device registration event:', err);
  });

  const profileHash = getStoredDeviceProfileHash(mergedMetadata);
  if (profileHash && companyId != null) {
    query(
      `INSERT INTO device_events (user_id, event_type, ip_address, user_agent, metadata)
       SELECT $1, 'shared_profile', $2, $3, $4
       WHERE EXISTS (
         SELECT 1 FROM users
         WHERE id <> $1
           AND company_id = $5
           AND device_reset_pending = false
           AND registered_device_metadata->'deviceProfile'->>'hash' = $6
       )`,
      [userId, ipAddress, ua, { profileHash, identifier: identity.identifier }, companyId, profileHash],
    ).catch(() => {});
  }

  query(
    `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id)
     VALUES ($1, $2, 'DEVICE_REGISTER', 'user', $2)`,
    [companyId, userId],
  ).catch(() => {});

  if (companyId) {
    emitToCompany(companyId, 'DEVICE_REGISTERED', { userId });
  }
}

export const getDeviceHistory = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { companyId } = req.user!;

  const userExists = await queryOne(
    `SELECT 1 FROM users WHERE id = $1 AND company_id = $2`,
    [userId, companyId]
  );

  if (!userExists) {
    forbidden(res, 'Utente non trovato o non autorizzato', 'USER_NOT_FOUND');
    return;
  }

  const events = await query(
    `SELECT id, event_type, ip_address, user_agent, metadata, created_at
     FROM device_events
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [userId]
  );

  ok(res, events);
});

/**
 * Self-service recovery: re-bind the logged-in account to the device in front of
 * the user, after re-confirming that account's own credentials. This is the way
 * out of a device mismatch (new hardware, reinstalled browser, cleared storage)
 * without waiting for an HR reset.
 */
export const reRegisterDevice = asyncHandler(async (req: Request, res: Response) => {
  const { userId, companyId } = req.user!;
  const { email, password, fingerprint, metadata } = req.body as { email: string; password: string; fingerprint: string; metadata?: any };

  if (!email || !password || !fingerprint) {
    return badRequest(res, 'Email, password and fingerprint are required');
  }

  const user = await queryOne<{ id: number; company_id: number; email: string; password_hash: string; role: string }>(
    `SELECT id, company_id, email, password_hash, role
     FROM users
     WHERE id = $1 AND company_id = $2`,
    [userId, companyId]
  );

  if (!user) {
    return forbidden(res, 'User not found');
  }

  if (user.email.toLowerCase() !== email.toLowerCase()) {
    return forbidden(res, 'Credentials do not match the current logged-in user');
  }

  if (!(await bcrypt.compare(password, user.password_hash))) {
    return forbidden(res, 'Invalid password');
  }

  const ipAddress = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const mergedMetadata = buildDeviceMetadata(req, metadata, ipAddress);
  const identity = resolveDeviceIdentity(fingerprint, mergedMetadata);

  const conflict = await findConflictingRegistration(userId, companyId, identity);
  if (conflict) {
    badRequest(
      res,
      `Questo dispositivo e gia registrato da un altro dipendente (${conflict.name} ${conflict.surname})`,
      'DEVICE_ALREADY_REGISTERED',
    );
    return;
  }

  await releaseResetPendingHolders(userId, identity);

  try {
    await query(
      `UPDATE users
       SET registered_device_token = $1,
           registered_device_identifier = $2,
           registered_device_metadata = $3,
           registered_device_registered_at = NOW(),
           device_reset_pending = false,
           updated_at = NOW()
       WHERE id = $4`,
      [identity.token, identity.identifier, mergedMetadata, userId]
    );
  } catch (err: any) {
    if (err?.code === '23505') {
      badRequest(
        res,
        'Questo dispositivo e gia registrato da un altro dipendente',
        'DEVICE_ALREADY_REGISTERED',
      );
      return;
    }
    throw err;
  }

  await query(
    `INSERT INTO device_events (user_id, event_type, ip_address, user_agent)
     VALUES ($1, 'reset', $2, $3)`,
    [userId, ipAddress, ua]
  ).catch(() => {});

  await logDeviceRegistration(userId, companyId, ipAddress, ua, mergedMetadata, identity);

  if (companyId) {
    emitToCompany(companyId, 'DEVICE_RESET', { userId });
  }

  ok(res, { success: true }, 'Terminal re-registered successfully');
});

export const checkDeviceRegistration = asyncHandler(async (req: Request, res: Response) => {
  const { email, password, fingerprint } = req.body as { email?: string; password?: string; fingerprint?: string };

  if (!email || !password || !fingerprint) {
    badRequest(res, 'Email del manager, password e fingerprint del dispositivo sono obbligatori', 'VALIDATION_ERROR');
    return;
  }

  const manager = await queryOne<{ id: number; role: string; password_hash: string; company_id: number }>(
    `SELECT id, role, password_hash, company_id
     FROM users
     WHERE LOWER(email) = LOWER($1) AND status = 'active'`,
    [email.trim()]
  );

  if (!manager) {
    forbidden(res, 'Credenziali non valide o utente non autorizzato', 'INVALID_CREDENTIALS');
    return;
  }

  const allowedRoles = ['admin', 'hr', 'area_manager', 'store_manager', 'store_terminal'];
  if (!allowedRoles.includes(manager.role)) {
    forbidden(res, 'Questo utente non ha i permessi per verificare le registrazioni', 'UNAUTHORIZED');
    return;
  }

  const isPasswordValid = await bcrypt.compare(password, manager.password_hash);
  if (!isPasswordValid) {
    forbidden(res, 'Credenziali non valide o utente non autorizzato', 'INVALID_CREDENTIALS');
    return;
  }

  const identity = resolveDeviceIdentity(fingerprint);

  // Legacy values are only consulted for clients that have no per-installation
  // id yet. Once one exists, a legacy hit would just mean "same hardware model"
  // and could name the wrong employee.
  const legacyToken = identity.isStable ? null : identity.legacyToken;
  const legacyIdentifier = identity.isStable ? null : identity.legacyIdentifier;

  const registeredUser = await queryOne<{
    name: string;
    surname: string;
    role: string;
    registered_at: string;
    registered_device_metadata: any;
  }>(
    `SELECT name, surname, role, TO_CHAR(registered_device_registered_at, 'YYYY-MM-DD HH24:MI:SS') AS registered_at, registered_device_metadata
     FROM users
     WHERE company_id = $1
       AND device_reset_pending = false
       AND (
         registered_device_token = $2
         OR ($3::text IS NOT NULL AND registered_device_identifier = $3)
         OR ($4::text IS NOT NULL AND registered_device_token = $4)
         OR ($5::text IS NOT NULL AND registered_device_identifier = $5)
       )`,
    [manager.company_id, identity.token, identity.identifier, legacyToken, legacyIdentifier]
  );

  if (!registeredUser) {
    ok(res, { found: false, message: 'Nessun dipendente registrato con questo dispositivo in questa azienda.' });
    return;
  }

  ok(res, {
    found: true,
    details: {
      name: registeredUser.name,
      surname: registeredUser.surname,
      role: registeredUser.role,
      registeredAt: registeredUser.registered_at,
      ipAddress: registeredUser.registered_device_metadata?.ipAddress || 'N/A',
      browser: registeredUser.registered_device_metadata?.browser?.name || 'N/A',
      os: registeredUser.registered_device_metadata?.os?.name || 'N/A',
    }
  });
});
