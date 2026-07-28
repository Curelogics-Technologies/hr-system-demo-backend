import crypto from 'crypto';

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function normalizeObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

export function computeDeviceProfileHash(metadata: unknown): string | null {
  const root = normalizeObject(metadata);
  const browser = normalizeObject(root.browser);
  const os = normalizeObject(root.os);
  const device = normalizeObject(root.device);
  const screen = normalizeObject(root.screen);

  const profile = {
    userAgent: normalizeText(root.userAgent),
    browserName: normalizeText(browser.name),
    browserVersion: normalizeText(browser.version),
    osName: normalizeText(os.name),
    osVersion: normalizeText(os.version),
    deviceModel: normalizeText(device.model),
    deviceVendor: normalizeText(device.vendor),
    deviceType: normalizeText(device.type),
    language: normalizeText(root.language),
    timezone: normalizeText(root.timezone),
    platform: normalizeText(root.platform),
    vendor: normalizeText(root.vendor),
    hardwareConcurrency: normalizeNumber(root.hardwareConcurrency),
    deviceMemory: normalizeNumber(root.deviceMemory),
    maxTouchPoints: normalizeNumber(root.maxTouchPoints),
    screenWidth: normalizeNumber(screen.width),
    screenHeight: normalizeNumber(screen.height),
    screenColorDepth: normalizeNumber(screen.colorDepth),
    screenPixelRatio: normalizeNumber(screen.pixelRatio),
  };

  const populatedCount = Object.values(profile).filter((value) => value !== null).length;
  if (populatedCount < 6) {
    return null;
  }

  return crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

function hashStableIdentifier(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pickNestedText(root: Record<string, any>, paths: string[][]): string | null {
  for (const path of paths) {
    let current: unknown = root;
    for (const key of path) {
      current = normalizeObject(current)[key];
    }
    const value = normalizeText(current);
    if (value) return value;
  }
  return null;
}

function resolveNativeDeviceIdentifier(metadata: unknown): string | null {
  const root = normalizeObject(metadata);
  const nativeIdentifier = pickNestedText(root, [
    ['stableDevice', 'nativeId'],
    ['stableDevice', 'identifier'],
    ['nativeDeviceId'],
    ['deviceIdentifier'],
    ['deviceId'],
    ['androidId'],
    ['iosVendorId'],
    ['identifierForVendor'],
  ]);

  return nativeIdentifier ? `native:${hashStableIdentifier(nativeIdentifier)}` : null;
}

/**
 * Resolve the canonical identifier for a device from its registration metadata.
 *
 * Priority:
 *  1. A native/OS-provided device id (most stable — survives reinstalls).
 *  2. The per-installation random id minted by the web client (`web-device-v2`).
 *  3. The opaque fingerprint token, as a last resort.
 *
 * NOTE: the legacy `profile:<hash>` form is deliberately NOT produced here.
 * That hash was derived purely from device-class attributes (model, OS, browser
 * version, screen, locale…), so two identical terminals produced the same value
 * and only one of them could ever hold a registration. Legacy identifiers are
 * still *matched* (see `resolveDeviceIdentity`) so existing registrations keep
 * working, but they are never minted for new ones.
 */
export function resolveStableDeviceIdentifier(metadata: unknown, fallbackToken?: string | null): string | null {
  const nativeIdentifier = resolveNativeDeviceIdentifier(metadata);
  if (nativeIdentifier) return nativeIdentifier;

  const root = normalizeObject(metadata);
  const stableDevice = normalizeObject(root.stableDevice);
  const installId = normalizeText(stableDevice.installId) ?? normalizeText(root.installId);
  if (installId) {
    return `device:${hashStableIdentifier(installId)}`;
  }

  return fallbackToken ? `fingerprint:${fallbackToken}` : null;
}

export function resolveStableDeviceIdentifierFromFingerprint(fingerprint: unknown, fallbackToken?: string | null): string | null {
  const parsed = parseDeviceFingerprint(fingerprint);
  if (parsed.installId) {
    return `device:${hashStableIdentifier(parsed.installId)}`;
  }
  if (parsed.legacyProfileHash) {
    return `profile:${parsed.legacyProfileHash}`;
  }

  return fallbackToken ? `fingerprint:${fallbackToken}` : null;
}

// ---------------------------------------------------------------------------
// Canonical device identity
// ---------------------------------------------------------------------------

export const DEVICE_FINGERPRINT_V2_PREFIX = 'web-device-v2:';
export const DEVICE_FINGERPRINT_V1_PREFIX = 'web-profile-v1:';

const INSTALL_ID_RE = /^[a-f0-9]{16,64}$/;
const PROFILE_HASH_RE = /^[a-f0-9]{32,64}$/;

export function getDeviceBindingSecret(): string {
  // NOTE: In production you should set this env var.
  // Keeping a non-empty fallback makes local/dev runs work without configuration.
  return process.env.DEVICE_BINDING_SECRET || 'dev-device-binding-secret-change-me';
}

function hashWithSecret(value: string, secret = getDeviceBindingSecret()): string {
  return crypto.createHash('sha256').update(secret).update(value).digest('hex');
}

interface ParsedFingerprint {
  installId: string | null;
  legacyProfileHash: string | null;
  /** Fingerprint string the stored token is derived from — stable across browser updates. */
  canonicalFingerprint: string;
}

/**
 * Parse the fingerprint string sent by the client.
 *
 * Accepted forms:
 *   `web-device-v2:<installId>[:<legacyProfileHash>]`  — current web client
 *   `web-profile-v1:<profileHash>`                     — previous web client
 *   `<anything else>`                                  — opaque token (native apps, tests)
 *
 * The optional legacy hash carried by v2 fingerprints is what lets a device that
 * registered under the old scheme keep working without re-registering.
 */
export function parseDeviceFingerprint(fingerprint: unknown): ParsedFingerprint {
  const raw = typeof fingerprint === 'string' ? fingerprint.trim() : '';

  if (raw.toLowerCase().startsWith(DEVICE_FINGERPRINT_V2_PREFIX)) {
    const [installIdPart, legacyPart] = raw.slice(DEVICE_FINGERPRINT_V2_PREFIX.length).split(':');
    const installId = normalizeText(installIdPart);
    const legacyProfileHash = normalizeText(legacyPart);
    return {
      installId: installId && INSTALL_ID_RE.test(installId) ? installId : null,
      legacyProfileHash: legacyProfileHash && PROFILE_HASH_RE.test(legacyProfileHash) ? legacyProfileHash : null,
      // Deliberately excludes the legacy suffix so the token does not change
      // when the browser or OS updates.
      canonicalFingerprint: installId ? `${DEVICE_FINGERPRINT_V2_PREFIX}${installId}` : raw,
    };
  }

  if (raw.toLowerCase().startsWith(DEVICE_FINGERPRINT_V1_PREFIX)) {
    const profileHash = normalizeText(raw.slice(DEVICE_FINGERPRINT_V1_PREFIX.length));
    return {
      installId: null,
      legacyProfileHash: profileHash && PROFILE_HASH_RE.test(profileHash) ? profileHash : null,
      canonicalFingerprint: raw,
    };
  }

  return { installId: null, legacyProfileHash: null, canonicalFingerprint: raw };
}

export interface DeviceIdentity {
  /** Token to persist for this device. */
  token: string;
  /** Canonical identifier to persist for this device. */
  identifier: string | null;
  /** Token this device would have had under the previous scheme, if known. */
  legacyToken: string | null;
  /** Identifier this device would have had under the previous scheme, if known. */
  legacyIdentifier: string | null;
  installId: string | null;
  /** True when the client supplied a per-installation id (i.e. a real device identity). */
  isStable: boolean;
}

/**
 * Build the full identity for an incoming device: the values to store going
 * forward plus the legacy values used to recognise an existing registration.
 */
export function resolveDeviceIdentity(fingerprint: unknown, metadata?: unknown): DeviceIdentity {
  const parsed = parseDeviceFingerprint(fingerprint);
  const token = hashWithSecret(parsed.canonicalFingerprint);

  const identifier = resolveStableDeviceIdentifier(metadata, null)
    ?? (parsed.installId ? `device:${hashStableIdentifier(parsed.installId)}` : null)
    ?? (parsed.legacyProfileHash ? `profile:${parsed.legacyProfileHash}` : null)
    ?? `fingerprint:${token}`;

  let legacyToken: string | null = null;
  let legacyIdentifier: string | null = null;
  if (parsed.installId && parsed.legacyProfileHash) {
    // The v1 client hashed `web-profile-v1:<hash>` to build its token.
    legacyToken = hashWithSecret(`${DEVICE_FINGERPRINT_V1_PREFIX}${parsed.legacyProfileHash}`);
    legacyIdentifier = `profile:${parsed.legacyProfileHash}`;
  }

  return {
    token,
    identifier,
    legacyToken,
    legacyIdentifier,
    installId: parsed.installId,
    isStable: parsed.installId != null || resolveNativeDeviceIdentifier(metadata) != null,
  };
}

export interface RegisteredDeviceRow {
  registered_device_token?: string | null;
  registered_device_identifier?: string | null;
}

export interface DeviceMatchResult {
  matched: boolean;
  /** True when the match only succeeded through the previous scheme's values. */
  viaLegacy: boolean;
}

/**
 * Does an incoming device identity correspond to the registration stored on a row?
 * Matches on the current values first, then falls back to the legacy ones so a
 * device registered before the identity rework is still recognised.
 */
export function matchesRegisteredDevice(row: RegisteredDeviceRow | null | undefined, identity: DeviceIdentity): DeviceMatchResult {
  if (!row) return { matched: false, viaLegacy: false };

  const storedToken = row.registered_device_token ?? null;
  const storedIdentifier = row.registered_device_identifier ?? null;
  if (storedToken == null && storedIdentifier == null) {
    return { matched: false, viaLegacy: false };
  }

  if ((storedToken != null && storedToken === identity.token)
    || (storedIdentifier != null && identity.identifier != null && storedIdentifier === identity.identifier)) {
    return { matched: true, viaLegacy: false };
  }

  if ((storedToken != null && identity.legacyToken != null && storedToken === identity.legacyToken)
    || (storedIdentifier != null && identity.legacyIdentifier != null && storedIdentifier === identity.legacyIdentifier)) {
    return { matched: true, viaLegacy: true };
  }

  return { matched: false, viaLegacy: false };
}

export function getStoredDeviceProfileHash(metadata: unknown): string | null {
  const root = normalizeObject(metadata);
  const deviceProfile = normalizeObject(root.deviceProfile);
  return normalizeText(deviceProfile.hash) ?? computeDeviceProfileHash(metadata);
}

export function withDeviceProfileHash<T>(metadata: T): T {
  const root = normalizeObject(metadata);
  const hash = computeDeviceProfileHash(root);
  if (!hash) {
    return root as T;
  }

  const deviceProfile = normalizeObject(root.deviceProfile);
  return {
    ...root,
    deviceProfile: {
      ...deviceProfile,
      hash,
    },
  } as T;
}
