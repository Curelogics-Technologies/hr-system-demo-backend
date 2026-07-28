import {
  matchesRegisteredDevice,
  parseDeviceFingerprint,
  resolveDeviceIdentity,
} from '../deviceProfile';

/**
 * These cover the device *identity* rules, independent of any storage.
 *
 * The bug they guard against: identity used to be a hash of the device's
 * observable profile (model, OS, browser version, screen, locale…). That value
 * is shared by every unit of the same model and changes on browser updates, so
 * a fleet of identical terminals could only ever have one registration alive at
 * a time, and any browser update invalidated a device's own binding.
 */

// Two units of the same tablet model, configured identically.
const IDENTICAL_HARDWARE = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0',
  browser: { name: 'Chrome', version: '126.0.0.0' },
  os: { name: 'Windows', version: '10' },
  device: { model: null, vendor: null, type: null },
  language: 'it-IT',
  timezone: 'Europe/Rome',
  platform: 'Win32',
  vendor: 'Google Inc.',
  hardwareConcurrency: 8,
  deviceMemory: 8,
  maxTouchPoints: 0,
  screen: { width: 1920, height: 1080, colorDepth: 24, pixelRatio: 1 },
};

const INSTALL_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const INSTALL_B = 'ff00ee11dd22cc33bb44aa5566778899';
const PROFILE = 'b'.repeat(64);

const fp = (installId: string, profileHash = PROFILE) => `web-device-v2:${installId}:${profileHash}`;

describe('parseDeviceFingerprint', () => {
  it('extracts the install id and the legacy profile hash', () => {
    const parsed = parseDeviceFingerprint(fp(INSTALL_A));
    expect(parsed.installId).toBe(INSTALL_A);
    expect(parsed.legacyProfileHash).toBe(PROFILE);
  });

  it('excludes the legacy hash from the canonical fingerprint', () => {
    // The stored token derives from this, so it must not move when the browser
    // updates and the profile hash changes.
    expect(parseDeviceFingerprint(fp(INSTALL_A, 'c'.repeat(64))).canonicalFingerprint)
      .toBe(parseDeviceFingerprint(fp(INSTALL_A, 'd'.repeat(64))).canonicalFingerprint);
  });

  it('still understands the previous client format', () => {
    const parsed = parseDeviceFingerprint(`web-profile-v1:${PROFILE}`);
    expect(parsed.installId).toBeNull();
    expect(parsed.legacyProfileHash).toBe(PROFILE);
  });

  it('rejects malformed install ids rather than trusting them', () => {
    expect(parseDeviceFingerprint('web-device-v2:not-hex!!:xyz').installId).toBeNull();
  });
});

describe('resolveDeviceIdentity', () => {
  it('gives identical hardware distinct identities', () => {
    const a = resolveDeviceIdentity(fp(INSTALL_A), IDENTICAL_HARDWARE);
    const b = resolveDeviceIdentity(fp(INSTALL_B), IDENTICAL_HARDWARE);

    expect(a.identifier).not.toBe(b.identifier);
    expect(a.token).not.toBe(b.token);
  });

  it('keeps one installation stable across a browser update', () => {
    const before = resolveDeviceIdentity(fp(INSTALL_A, 'c'.repeat(64)), IDENTICAL_HARDWARE);
    const after = resolveDeviceIdentity(fp(INSTALL_A, 'd'.repeat(64)), {
      ...IDENTICAL_HARDWARE,
      browser: { name: 'Chrome', version: '127.0.0.0' },
    });

    expect(after.identifier).toBe(before.identifier);
    expect(after.token).toBe(before.token);
  });

  it('never mints a profile-derived identifier for a modern client', () => {
    const identity = resolveDeviceIdentity(fp(INSTALL_A), IDENTICAL_HARDWARE);
    expect(identity.identifier).toMatch(/^device:[a-f0-9]{64}$/);
    expect(identity.isStable).toBe(true);
  });

  it('prefers a native device id when the client supplies one', () => {
    const identity = resolveDeviceIdentity(fp(INSTALL_A), {
      ...IDENTICAL_HARDWARE,
      nativeDeviceId: 'ios-vendor-device-abc-123',
    });
    expect(identity.identifier).toMatch(/^native:/);
  });

  it('marks an opaque fingerprint as unstable', () => {
    const identity = resolveDeviceIdentity('some-opaque-token-from-a-native-app');
    expect(identity.isStable).toBe(false);
    expect(identity.identifier).toMatch(/^fingerprint:/);
  });
});

describe('matchesRegisteredDevice', () => {
  it('matches a device against its own current binding', () => {
    const identity = resolveDeviceIdentity(fp(INSTALL_A), IDENTICAL_HARDWARE);
    const row = { registered_device_token: identity.token, registered_device_identifier: identity.identifier };

    expect(matchesRegisteredDevice(row, identity)).toEqual({ matched: true, viaLegacy: false });
  });

  it('does not match a different installation of the same hardware', () => {
    const a = resolveDeviceIdentity(fp(INSTALL_A), IDENTICAL_HARDWARE);
    const b = resolveDeviceIdentity(fp(INSTALL_B), IDENTICAL_HARDWARE);
    const rowA = { registered_device_token: a.token, registered_device_identifier: a.identifier };

    expect(matchesRegisteredDevice(rowA, b).matched).toBe(false);
  });

  it('recognises a binding created by the previous client, and flags it', () => {
    const legacy = resolveDeviceIdentity(`web-profile-v1:${PROFILE}`);
    const current = resolveDeviceIdentity(fp(INSTALL_A, PROFILE), IDENTICAL_HARDWARE);
    const legacyRow = {
      registered_device_token: legacy.token,
      registered_device_identifier: legacy.identifier,
    };

    expect(matchesRegisteredDevice(legacyRow, current)).toEqual({ matched: true, viaLegacy: true });
  });

  it('treats an unregistered row as no match', () => {
    const identity = resolveDeviceIdentity(fp(INSTALL_A), IDENTICAL_HARDWARE);
    expect(matchesRegisteredDevice({ registered_device_token: null, registered_device_identifier: null }, identity).matched)
      .toBe(false);
    expect(matchesRegisteredDevice(null, identity).matched).toBe(false);
  });
});
