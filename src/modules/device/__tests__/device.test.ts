import express from 'express';
import supertest from 'supertest';
import authRoutes from '../../auth/auth.routes';
import deviceRoutes from '../device.routes';
import { seedTestData, clearTestData, closeTestDb, testPool } from '../../../__tests__/helpers/db';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/device', deviceRoutes);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ success: false, error: err.message, code: 'SERVER_ERROR' });
});

const request = supertest(app);
let seeds: Awaited<ReturnType<typeof seedTestData>>;

async function login(email: string, password = 'password123'): Promise<string> {
  const res = await request.post('/api/auth/login').send({ email, password });
  return res.body.data.token as string;
}

beforeAll(async () => {
  seeds = await seedTestData();

  // A second company is needed to prove device uniqueness is scoped per company
  // rather than global — one company's registrations must not block another's.
  const HASH = '$2a$10$e/ULie.9SQf5MIQSNjkxEO7.xAyc6zv/qysVTE4mVFhZum/BjT5VG'; // password123
  await testPool.query(
    `INSERT INTO users (company_id, name, surname, email, password_hash, role, status)
     VALUES ($1, 'Beta', 'Employee', 'employee.beta@beta-test.com', $2, 'employee', 'active')
     ON CONFLICT (email) DO UPDATE SET
       company_id = EXCLUDED.company_id,
       password_hash = EXCLUDED.password_hash,
       status = EXCLUDED.status`,
    [seeds.betaId, HASH]
  );
});

afterAll(async () => {
  await clearTestData();
  await closeTestDb();
});

describe('Device Registration & Verification', () => {
  const testFingerprint = 'test-fingerprint-unique-id-999';

  // Per-installation ids minted by the web client. Two units of the same model
  // get different ones; the same unit keeps its own across browser updates.
  const INSTALL_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const INSTALL_B = 'ff00ee11dd22cc33bb44aa5566778899';
  const LEGACY_PROFILE_HASH = 'b'.repeat(64);
  const PROFILE_HASH_BEFORE_UPDATE = 'c'.repeat(64);
  const PROFILE_HASH_AFTER_UPDATE = 'd'.repeat(64);

  const deviceFingerprint = (installId: string, profileHash = LEGACY_PROFILE_HASH) =>
    `web-device-v2:${installId}:${profileHash}`;

  const sharedDeviceMetadata = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1',
    browser: { name: 'Mobile Safari', version: '26.2' },
    os: { name: 'iOS', version: '26.2' },
    device: { model: 'iPhone', vendor: 'Apple', type: 'mobile' },
    language: 'en-US',
    timezone: 'Asia/Karachi',
    platform: 'iOS',
    vendor: 'Apple Computer, Inc.',
    hardwareConcurrency: 6,
    deviceMemory: 4,
    maxTouchPoints: 5,
    screen: { width: 430, height: 932, colorDepth: 24, pixelRatio: 3 }
  };

  beforeEach(async () => {
    // Reset device fields for users
    await testPool.query(
      `UPDATE users 
       SET registered_device_token = NULL, 
           registered_device_identifier = NULL,
           device_reset_pending = false, 
           registered_device_metadata = NULL, 
           registered_device_registered_at = NULL`
    );
  });

  describe('POST /api/device/register', () => {
    it('successfully registers device if reset is pending or token is null', async () => {
      // 1. Mark employee1 as requiring device registration
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );

      const token = await login('employee1@acme-test.com');
      const res = await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fingerprint: testFingerprint,
          metadata: { os: { name: 'iOS' }, browser: { name: 'Safari' } }
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isDeviceRegistered).toBe(true);
      expect(res.body.data.deviceResetPending).toBe(false);
    });

    it('fails to register device if it is already registered by another employee', async () => {
      // 1. Employee 1 registers the device
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );
      const token1 = await login('employee1@acme-test.com');
      await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token1}`)
        .send({ fingerprint: testFingerprint });

      // 2. Roma Manager attempts to register the same device (requires registration set to true first)
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.romaManagerId]
      );
      const token2 = await login('manager.roma@acme-test.com');
      const res = await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token2}`)
        .send({ fingerprint: testFingerprint });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('DEVICE_ALREADY_REGISTERED');
    });

    it('succeeds to register device if the existing registration has device_reset_pending = true', async () => {
      // 1. Employee 1 registers the device, but then has their device reset by admin (device_reset_pending = true)
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );
      const token1 = await login('employee1@acme-test.com');
      await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token1}`)
        .send({ fingerprint: testFingerprint });

      // Simulate admin reset
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );

      // 2. Roma Manager registers the same device (which is now free for registration since Employee 1's is reset)
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.romaManagerId]
      );
      const token2 = await login('manager.roma@acme-test.com');
      const res = await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token2}`)
        .send({ fingerprint: testFingerprint });

      if (res.status !== 200) {
        console.log("DEBUG REGISTRATION ERROR STATUS:", res.status);
        console.log("DEBUG REGISTRATION ERROR BODY:", res.body);
      }

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isDeviceRegistered).toBe(true);
    });

    // Regression: identical hardware in different stores must both be able to
    // register. The device profile (model/OS/browser/screen/locale) is shared by
    // every unit of the same model, so using it as an identity key meant only
    // one terminal in a fleet could ever hold a registration — disabling it was
    // what freed the slot for the next one.
    it('allows two identical devices to register to different accounts', async () => {
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );
      const token1 = await login('employee1@acme-test.com');
      const firstRes = await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token1}`)
        .send({ fingerprint: deviceFingerprint(INSTALL_A), metadata: sharedDeviceMetadata });

      expect(firstRes.status).toBe(200);

      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.romaManagerId]
      );
      const token2 = await login('manager.roma@acme-test.com');
      const res = await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token2}`)
        // Same hardware profile, different physical unit → different install id.
        .send({ fingerprint: deviceFingerprint(INSTALL_B), metadata: sharedDeviceMetadata });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isDeviceRegistered).toBe(true);
    });

    it('still blocks a second account registering from the same physical installation', async () => {
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );
      const token1 = await login('employee1@acme-test.com');
      await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token1}`)
        .send({ fingerprint: deviceFingerprint(INSTALL_A), metadata: sharedDeviceMetadata });

      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.romaManagerId]
      );
      const token2 = await login('manager.roma@acme-test.com');
      const res = await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token2}`)
        .send({ fingerprint: deviceFingerprint(INSTALL_A), metadata: sharedDeviceMetadata });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DEVICE_ALREADY_REGISTERED');
    });

    // Regression: the identity must not move when the browser updates. The old
    // profile hash included the browser version and the full user-agent, so a
    // routine Chrome update silently locked a device out of its own account.
    it('keeps a device registered across a browser update', async () => {
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );
      const token = await login('employee1@acme-test.com');
      await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fingerprint: deviceFingerprint(INSTALL_A, PROFILE_HASH_BEFORE_UPDATE),
          metadata: sharedDeviceMetadata,
        });

      const res = await request
        .get('/api/device/status')
        .set('Authorization', `Bearer ${token}`)
        // Same installation, new browser version → new profile hash.
        .query({ fingerprint: deviceFingerprint(INSTALL_A, PROFILE_HASH_AFTER_UPDATE) });

      expect(res.status).toBe(200);
      expect(res.body.data.isDeviceMatched).toBe(true);
    });

    it('does not let one company\'s registration block another company\'s', async () => {
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );
      const token1 = await login('employee1@acme-test.com');
      await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token1}`)
        .send({ fingerprint: deviceFingerprint(INSTALL_A), metadata: sharedDeviceMetadata });

      const betaToken = await login('employee.beta@beta-test.com');
      const res = await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${betaToken}`)
        .send({ fingerprint: deviceFingerprint(INSTALL_A), metadata: sharedDeviceMetadata });

      expect(res.status).toBe(200);
      expect(res.body.data.isDeviceRegistered).toBe(true);
    });

    // Devices registered by the previous client stored a token derived from
    // `web-profile-v1:<hash>`. They must keep working without re-registering.
    it('recognises and upgrades a registration made by the previous client', async () => {
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );
      const token = await login('employee1@acme-test.com');

      const legacyRes = await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token}`)
        .send({ fingerprint: `web-profile-v1:${LEGACY_PROFILE_HASH}`, metadata: sharedDeviceMetadata });
      expect(legacyRes.status).toBe(200);

      const { rows: [beforeUpgrade] } = await testPool.query(
        `SELECT registered_device_identifier FROM users WHERE id = $1`,
        [seeds.employee1Id]
      );
      expect(beforeUpgrade.registered_device_identifier).toBe(`profile:${LEGACY_PROFILE_HASH}`);

      // The updated client reports its install id plus the legacy hash.
      const statusRes = await request
        .get('/api/device/status')
        .set('Authorization', `Bearer ${token}`)
        .query({ fingerprint: deviceFingerprint(INSTALL_A, LEGACY_PROFILE_HASH) });

      expect(statusRes.status).toBe(200);
      expect(statusRes.body.data.isDeviceMatched).toBe(true);

      const { rows: [afterUpgrade] } = await testPool.query(
        `SELECT registered_device_identifier FROM users WHERE id = $1`,
        [seeds.employee1Id]
      );
      expect(afterUpgrade.registered_device_identifier).toMatch(/^device:[a-f0-9]{64}$/);
    });

    it('fails to register a second account with the same native stable device id even if the profile changes', async () => {
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );
      const token1 = await login('employee1@acme-test.com');
      const firstRes = await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token1}`)
        .send({
          fingerprint: 'first-browser-token-for-native-device',
          metadata: {
            ...sharedDeviceMetadata,
            nativeDeviceId: 'ios-vendor-device-abc-123'
          }
        });

      expect(firstRes.status).toBe(200);

      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.romaManagerId]
      );
      const token2 = await login('manager.roma@acme-test.com');
      const res = await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token2}`)
        .send({
          fingerprint: 'second-browser-token-after-reinstall',
          metadata: {
            ...sharedDeviceMetadata,
            browser: { name: 'Chrome Mobile', version: '126.0' },
            screen: { width: 390, height: 844, colorDepth: 24, pixelRatio: 3 },
            nativeDeviceId: 'ios-vendor-device-abc-123'
          }
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('DEVICE_ALREADY_REGISTERED');
    });

    it('treats a duplicate registration from the same account and same device as already successful', async () => {
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );
      const token = await login('employee1@acme-test.com');
      const firstRes = await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token}`)
        .send({ fingerprint: testFingerprint, metadata: sharedDeviceMetadata });

      expect(firstRes.status).toBe(200);

      const secondRes = await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token}`)
        .send({ fingerprint: testFingerprint, metadata: sharedDeviceMetadata });

      expect(secondRes.status).toBe(200);
      expect(secondRes.body.success).toBe(true);
      expect(secondRes.body.data.isDeviceRegistered).toBe(true);
    });
  });

  describe('POST /api/device/re-register', () => {
    it('fails to re-register a device that is already assigned to another active user', async () => {
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );
      const employeeToken = await login('employee1@acme-test.com');
      await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ fingerprint: testFingerprint });

      const managerToken = await login('manager.roma@acme-test.com');
      const res = await request
        .post('/api/device/re-register')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          email: 'manager.roma@acme-test.com',
          password: 'password123',
          fingerprint: testFingerprint
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('DEVICE_ALREADY_REGISTERED');
    });

    it('allows re-register when the current device owner has reset pending', async () => {
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );
      const employeeToken = await login('employee1@acme-test.com');
      await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ fingerprint: testFingerprint });

      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );

      const managerToken = await login('manager.roma@acme-test.com');
      const res = await request
        .post('/api/device/re-register')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          email: 'manager.roma@acme-test.com',
          password: 'password123',
          fingerprint: testFingerprint
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/device/check-fingerprint', () => {
    beforeEach(async () => {
      // Register device for Employee 1
      await testPool.query(
        `UPDATE users SET device_reset_pending = true WHERE id = $1`,
        [seeds.employee1Id]
      );
      const token1 = await login('employee1@acme-test.com');
      await request
        .post('/api/device/register')
        .set('Authorization', `Bearer ${token1}`)
        .send({
          fingerprint: testFingerprint,
          metadata: { os: { name: 'iOS' }, browser: { name: 'Safari' } }
        });
    });

    it('returns owner details for authorized manager (no Authorization header required)', async () => {
      const res = await request
        .post('/api/device/check-fingerprint')
        .send({
          email: 'manager.roma@acme-test.com',
          password: 'password123',
          fingerprint: testFingerprint
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.found).toBe(true);
      expect(res.body.data.details.name).toBe('Anna');
      expect(res.body.data.details.surname).toBe('Test');
      expect(res.body.data.details.os).toBe('iOS');
      expect(res.body.data.details.browser).toBe('Safari');
    });

    it('returns found = false if device is not registered', async () => {
      const res = await request
        .post('/api/device/check-fingerprint')
        .send({
          email: 'manager.roma@acme-test.com',
          password: 'password123',
          fingerprint: 'non-existent-fingerprint-abc-123'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.found).toBe(false);
    });

    it('returns 403 Forbidden with INVALID_CREDENTIALS for wrong password', async () => {
      const res = await request
        .post('/api/device/check-fingerprint')
        .send({
          email: 'manager.roma@acme-test.com',
          password: 'wrongpassword',
          fingerprint: testFingerprint
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 403 Forbidden with UNAUTHORIZED for non-manager role credentials', async () => {
      const res = await request
        .post('/api/device/check-fingerprint')
        .send({
          email: 'employee1@acme-test.com',
          password: 'password123',
          fingerprint: testFingerprint
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });
  });
});
