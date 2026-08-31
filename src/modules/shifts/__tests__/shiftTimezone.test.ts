import express from 'express';
import supertest from 'supertest';
import authRoutes from '../../auth/auth.routes';
import shiftsRoutes from '../shifts.routes';
import { seedTestData, clearTestData, closeTestDb, testPool } from '../../../__tests__/helpers/db';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/shifts', shiftsRoutes);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ success: false, error: err.message, code: 'SERVER_ERROR' });
});

const request = supertest(app);
let seeds: Awaited<ReturnType<typeof seedTestData>>;
let chicagoStoreId: number;

async function login(email: string, password = 'password123'): Promise<string> {
  const res = await request.post('/api/auth/login').send({ email, password });
  return res.body.data.token as string;
}

async function readShift(id: number) {
  const { rows } = await testPool.query(
    `SELECT timezone, start_at_utc, end_at_utc FROM shifts WHERE id = $1`,
    [id],
  );
  return rows[0] as { timezone: string; start_at_utc: Date; end_at_utc: Date };
}

beforeAll(async () => {
  seeds = await seedTestData();
  await testPool.query('DELETE FROM login_attempts');
  await testPool.query('DELETE FROM audit_logs');

  // The seeded store is created without a timezone; give it the Italian one so
  // these tests describe the real deployment.
  await testPool.query(`UPDATE stores SET timezone = 'Europe/Rome' WHERE id = $1`, [seeds.romaStoreId]);

  // A genuinely non-Italian shop, to prove the rule is "the store's zone" and
  // not "always Europe/Rome".
  const { rows: [chicago] } = await testPool.query(
    `INSERT INTO stores (company_id, name, code, max_staff, timezone)
     VALUES ($1, 'Chicago Test', 'CHI-T1', 10, 'America/Chicago')
     ON CONFLICT (company_id, code)
     DO UPDATE SET timezone = EXCLUDED.timezone
     RETURNING id`,
    [seeds.acmeId],
  );
  chicagoStoreId = chicago.id;
});

afterAll(async () => {
  await clearTestData();
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// The Varese incident: a manager whose browser reported America/Chicago stored
// Italian shifts on an American clock, and the clock-in gate opened five hours
// late. The zone must come from the store, whatever the caller claims.
// ---------------------------------------------------------------------------

describe('shift timezone comes from the store, not the caller', () => {
  it('ignores a browser timezone on create', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: '2026-09-01',
        start_time: '09:00',
        end_time: '18:00',
        timezone: 'America/Chicago',
      });
    expect(res.status).toBe(201);

    const row = await readShift(res.body.data.id);
    expect(row.timezone).toBe('Europe/Rome');
    // 09:00 Rome in September (CEST, UTC+2) is 07:00Z — not the 14:00Z the
    // Chicago claim would have produced.
    expect(row.start_at_utc.toISOString()).toBe('2026-09-01T07:00:00.000Z');
    expect(row.end_at_utc.toISOString()).toBe('2026-09-01T16:00:00.000Z');
  });

  it('ignores a browser timezone on update', async () => {
    const token = await login('admin@acme-test.com');
    const created = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: '2026-09-02',
        start_time: '09:00',
        end_time: '18:00',
      });
    expect(created.status).toBe(201);

    const res = await request
      .put(`/api/shifts/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ start_time: '10:00', end_time: '19:00', timezone: 'America/Chicago' });
    expect(res.status).toBe(200);

    const row = await readShift(created.body.data.id);
    expect(row.timezone).toBe('Europe/Rome');
    expect(row.start_at_utc.toISOString()).toBe('2026-09-02T08:00:00.000Z');
  });

  // Scheduling an employee outside their home store legitimately requires a
  // transfer, so these exercise the same resolveStoreTimezone path by changing
  // the store's own zone rather than by moving people between shops.
  it('uses the real zone of a store that is genuinely not Italian', async () => {
    await testPool.query(`UPDATE stores SET timezone = 'America/Chicago' WHERE id = $1`, [seeds.romaStoreId]);
    try {
      const token = await login('admin@acme-test.com');
      const res = await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          user_id: seeds.employee1Id,
          store_id: seeds.romaStoreId,
          date: '2026-09-03',
          start_time: '09:00',
          end_time: '18:00',
          timezone: 'Europe/Rome',
        });
      expect(res.status).toBe(201);

      const row = await readShift(res.body.data.id);
      // The rule is 'the store's zone', not 'always Europe/Rome': 09:00 Chicago
      // in September (CDT, UTC-5) is 14:00Z.
      expect(row.timezone).toBe('America/Chicago');
      expect(row.start_at_utc.toISOString()).toBe('2026-09-03T14:00:00.000Z');
    } finally {
      await testPool.query(`UPDATE stores SET timezone = 'Europe/Rome' WHERE id = $1`, [seeds.romaStoreId]);
    }
  });

  it('re-stamps a shift from the store when the store zone changes', async () => {
    const token = await login('admin@acme-test.com');
    const created = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: '2026-09-04',
        start_time: '09:00',
        end_time: '18:00',
      });
    expect(created.status).toBe(201);
    expect((await readShift(created.body.data.id)).start_at_utc.toISOString())
      .toBe('2026-09-04T07:00:00.000Z');

    // The shop is corrected to its real zone. The next save must follow the
    // store, not the zone already sitting on the row.
    await testPool.query(`UPDATE stores SET timezone = 'America/Chicago' WHERE id = $1`, [seeds.romaStoreId]);
    try {
      const moved = await request
        .put(`/api/shifts/${created.body.data.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ start_time: '09:00', end_time: '18:00' });
      expect(moved.status).toBe(200);

      const row = await readShift(created.body.data.id);
      expect(row.timezone).toBe('America/Chicago');
      expect(row.start_at_utc.toISOString()).toBe('2026-09-04T14:00:00.000Z');
    } finally {
      await testPool.query(`UPDATE stores SET timezone = 'Europe/Rome' WHERE id = $1`, [seeds.romaStoreId]);
    }
  });

  it('falls back to the default when the store carries no timezone', async () => {
    await testPool.query(`UPDATE stores SET timezone = NULL WHERE id = $1`, [seeds.romaStoreId]);
    try {
      const token = await login('admin@acme-test.com');
      const res = await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          user_id: seeds.employee1Id,
          store_id: seeds.romaStoreId,
          date: '2026-09-05',
          start_time: '09:00',
          end_time: '18:00',
          timezone: 'America/Chicago',
        });
      expect(res.status).toBe(201);

      const row = await readShift(res.body.data.id);
      expect(row.timezone).toBe('Europe/Rome');
      expect(row.start_at_utc.toISOString()).toBe('2026-09-05T07:00:00.000Z');
    } finally {
      await testPool.query(`UPDATE stores SET timezone = 'Europe/Rome' WHERE id = $1`, [seeds.romaStoreId]);
    }
  });
  it('copy-week does not clone a bad zone into the new week', async () => {
    const token = await login('admin@acme-test.com');
    // A row already corrupted the way the Varese ones were.
    const { rows: [bad] } = await testPool.query(
      `INSERT INTO shifts (company_id, store_id, user_id, date, timezone,
                           start_time, end_time, start_at_utc, end_at_utc, status, created_by)
       VALUES ($1, $2, $3, '2026-09-07', 'America/Chicago', '09:00', '18:00',
               (('2026-09-07'::DATE + '09:00'::TIME) AT TIME ZONE 'America/Chicago'),
               (('2026-09-07'::DATE + '18:00'::TIME) AT TIME ZONE 'America/Chicago'),
               'scheduled', $4)
       RETURNING id`,
      [seeds.acmeId, seeds.romaStoreId, seeds.employee1Id, seeds.adminId],
    );
    expect((await readShift(bad.id)).timezone).toBe('America/Chicago');

    const res = await request
      .post('/api/shifts/copy-week')
      .set('Authorization', `Bearer ${token}`)
      .send({ store_id: seeds.romaStoreId, source_week: '2026-W37', target_week: '2026-W38' });
    expect(res.status).toBe(200);
    expect(res.body.data.copied).toBeGreaterThanOrEqual(1);

    const { rows: copies } = await testPool.query(
      `SELECT timezone, start_at_utc FROM shifts
       WHERE store_id = $1 AND date = '2026-09-14'`,
      [seeds.romaStoreId],
    );
    expect(copies.length).toBeGreaterThanOrEqual(1);
    for (const c of copies) {
      expect(c.timezone).toBe('Europe/Rome');
      expect(c.start_at_utc.toISOString()).toBe('2026-09-14T07:00:00.000Z');
    }
  });
});
