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

async function login(email: string, password = 'password123'): Promise<string> {
  const res = await request.post('/api/auth/login').send({ email, password });
  return res.body.data.token as string;
}

beforeAll(async () => {
  seeds = await seedTestData();
  await testPool.query('DELETE FROM login_attempts');
  await testPool.query('DELETE FROM audit_logs');
});

afterAll(async () => {
  await clearTestData();
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// GET /api/shifts
// ---------------------------------------------------------------------------

describe('GET /api/shifts', () => {
  it('returns 401 for unauthenticated request', async () => {
    const res = await request.get('/api/shifts').query({ week: '2026-W11' });
    expect(res.status).toBe(401);
  });

  it('admin sees all shifts in company (at least the seeded shift)', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .get('/api/shifts')
      .query({ week: '2026-W11' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.shifts)).toBe(true);
    expect(res.body.data.shifts.length).toBeGreaterThanOrEqual(1);
  });

  it('employee sees only their own shifts', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .get('/api/shifts')
      .query({ week: '2026-W11' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const shifts: any[] = res.body.data.shifts;
    shifts.forEach((s) => expect(s.user_id).toBe(seeds.employee1Id));
  });

  it('employee ignores user_id query param and sees only own shifts', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .get('/api/shifts')
      .query({ week: '2026-W11', user_id: seeds.adminId })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const shifts: any[] = res.body.data.shifts;
    // Should never see adminId's shifts
    shifts.forEach((s) => expect(s.user_id).toBe(seeds.employee1Id));
  });

  it('store_manager sees only shifts for their store', async () => {
    const token = await login('manager.roma@acme-test.com');
    const res = await request
      .get('/api/shifts')
      .query({ week: '2026-W11' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const shifts: any[] = res.body.data.shifts;
    shifts.forEach((s) => expect(s.store_id).toBe(seeds.romaStoreId));
  });

  it('area_manager sees company shifts like admin and hr', async () => {
    const token = await login('area@acme-test.com');
    const res = await request
      .get('/api/shifts')
      .query({ week: '2026-W11' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const shifts: any[] = res.body.data.shifts;
    expect(shifts.length).toBeGreaterThanOrEqual(1);
    expect(shifts.some((s) => s.id === seeds.shiftId)).toBe(true);
  });

  it('each shift response includes shift_hours calculated field', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .get('/api/shifts')
      .query({ week: '2026-W11' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const shifts: any[] = res.body.data.shifts;
    expect(shifts.length).toBeGreaterThan(0);
    // seeded shift: 09:00-17:00 = 480 minutes = 8 hours
    const seeded = shifts.find((s: any) => s.id === seeds.shiftId);
    expect(seeded).toBeDefined();
    expect(Number(seeded.shift_hours)).toBeCloseTo(8, 1);
  });

  it('filter by month returns correct shifts', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .get('/api/shifts')
      .query({ month: '2026-03' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.shifts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/shifts
// ---------------------------------------------------------------------------

describe('POST /api/shifts', () => {
  let createdShiftId: number;

  it('admin creates a shift', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: '2026-03-20',
        start_time: '08:00',
        end_time: '16:00',
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeDefined();
    createdShiftId = res.body.data.id;
  });

  it('employee gets 403 trying to create a shift', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: '2026-03-21',
        start_time: '08:00',
        end_time: '16:00',
      });
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing required fields', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({ user_id: seeds.employee1Id });
    expect(res.status).toBe(400);
  });

  afterAll(async () => {
    if (createdShiftId) {
      await testPool.query('DELETE FROM shifts WHERE id = $1', [createdShiftId]);
    }
  });
});

describe('Date-level off-day enforcement', () => {
  const saturdayDate = '2026-03-21';
  const explicitOffDate = '2026-03-22';

  afterAll(async () => {
    await testPool.query(
      `DELETE FROM shifts
       WHERE company_id = $1
         AND user_id = $2
         AND date IN ($3::date, $4::date)`,
      [seeds.acmeId, seeds.employee1Id, saturdayDate, explicitOffDate],
    );
  });

  it('allows creating a Saturday shift when no explicit off-day marker exists', async () => {
    const token = await login('admin@acme-test.com');
    await testPool.query(
      `DELETE FROM shifts
       WHERE company_id = $1
         AND user_id = $2
         AND date = $3::date`,
      [seeds.acmeId, seeds.employee1Id, saturdayDate],
    );

    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: saturdayDate,
        start_time: '08:00',
        end_time: '16:00',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('blocks creating a working shift when the date is explicitly marked as off-day', async () => {
    const token = await login('admin@acme-test.com');
    await testPool.query(
      `DELETE FROM shifts
       WHERE company_id = $1
         AND user_id = $2
         AND date = $3::date`,
      [seeds.acmeId, seeds.employee1Id, explicitOffDate],
    );

    const offDayRes = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: explicitOffDate,
        start_time: '00:00',
        end_time: '00:01',
        is_off_day: true,
        status: 'cancelled',
      });

    expect(offDayRes.status).toBe(201);
    expect(offDayRes.body.success).toBe(true);

    const blockedRes = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: explicitOffDate,
        start_time: '09:00',
        end_time: '17:00',
      });

    expect(blockedRes.status).toBe(400);
    expect(blockedRes.body.code).toBe('OFF_DAY_SHIFT_BLOCKED');
  });
});

// ---------------------------------------------------------------------------
// Overlap detection
// ---------------------------------------------------------------------------

describe('Overlap detection', () => {
  let overlapShiftId: number;

  beforeAll(async () => {
    // Create a base shift: employee1, 2026-03-25, 09:00-17:00
    const token = await login('admin@acme-test.com');
    // Seed helper also inserts a "today" shift; ensure determinism for this fixed test date.
    await testPool.query('DELETE FROM shifts WHERE date = $1 AND user_id = $2', ['2026-03-25', seeds.employee1Id]);
    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: '2026-03-25',
        start_time: '09:00',
        end_time: '17:00',
      });
    overlapShiftId = res.body.data.id;
  });

  afterAll(async () => {
    await testPool.query('DELETE FROM shifts WHERE date = $1 AND user_id = $2', ['2026-03-25', seeds.employee1Id]);
  });

  it('returns 409 OVERLAP_CONFLICT when creating overlapping shift same user+date', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: '2026-03-25',
        start_time: '12:00',
        end_time: '20:00',
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OVERLAP_CONFLICT');
    expect(res.body.error).toBe('Turno sovrapposto per questo dipendente in questa data');
  });

  it('allows non-overlapping shift same user+date', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: '2026-03-25',
        start_time: '17:30',
        end_time: '21:00',
      });
    expect(res.status).toBe(201);
    // Cleanup
    await testPool.query('DELETE FROM shifts WHERE id = $1', [res.body.data.id]);
  });

  it('returns 409 OVERLAP_CONFLICT when updating to create overlap', async () => {
    // Create a second non-overlapping shift first
    const tokenA = await login('admin@acme-test.com');
    const r = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: '2026-03-25',
        start_time: '17:30',
        end_time: '20:00',
      });
    const secondId = r.body.data.id;

    // Now update it to overlap with the base shift
    const res = await request
      .put(`/api/shifts/${secondId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ start_time: '08:00', end_time: '15:00' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OVERLAP_CONFLICT');

    await testPool.query('DELETE FROM shifts WHERE id = $1', [secondId]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/shifts/copy-week
// ---------------------------------------------------------------------------

describe('POST /api/shifts/copy-week', () => {
  afterAll(async () => {
    await testPool.query(
      `DELETE FROM shifts WHERE date >= '2026-03-23' AND date <= '2026-03-29' AND store_id = $1`,
      [seeds.romaStoreId]
    );
  });

  it('copies shifts from source week to target week', async () => {
    // Seed a shift in 2026-W11 (2026-03-09 to 2026-03-15)
    await testPool.query(
      `INSERT INTO shifts (company_id, store_id, user_id, date, start_time, end_time, status, created_by)
       VALUES ($1, $2, $3, '2026-03-09', '09:00', '17:00', 'scheduled', $4)`,
      [seeds.acmeId, seeds.romaStoreId, seeds.employee1Id, seeds.adminId]
    );

    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts/copy-week')
      .set('Authorization', `Bearer ${token}`)
      .send({
        store_id: seeds.romaStoreId,
        source_week: '2026-W11',
        target_week: '2026-W12',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.copied).toBeGreaterThanOrEqual(1);
  });

  it('returns 0 copied when source week has no shifts', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts/copy-week')
      .set('Authorization', `Bearer ${token}`)
      .send({
        store_id: seeds.romaStoreId,
        source_week: '2026-W01',
        target_week: '2026-W02',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.copied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Shift templates
// ---------------------------------------------------------------------------

describe('Shift templates CRUD', () => {
  let templateId: number;

  it('admin creates a template', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts/templates')
      .set('Authorization', `Bearer ${token}`)
      .send({
        store_id: seeds.romaStoreId,
        name: 'Template Mattina',
        template_data: { shifts: [{ start_time: '06:00', end_time: '14:00' }] },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Template Mattina');
    templateId = res.body.data.id;
  });

  it('GET /shifts/templates returns the created template', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .get('/api/shifts/templates')
      .query({ store_id: seeds.romaStoreId })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.templates)).toBe(true);
    const names = res.body.data.templates.map((t: any) => t.name);
    expect(names).toContain('Template Mattina');
  });

  it('DELETE /shifts/templates/:id removes the template', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .delete(`/api/shifts/templates/${templateId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    // Verify gone
    const check = await request
      .get('/api/shifts/templates')
      .query({ store_id: seeds.romaStoreId })
      .set('Authorization', `Bearer ${token}`);
    const names = check.body.data.templates.map((t: any) => t.name);
    expect(names).not.toContain('Template Mattina');
  });

  it('employee gets 403 accessing templates', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .get('/api/shifts/templates')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/shifts/export
// ---------------------------------------------------------------------------

describe('GET /api/shifts/export', () => {
  it('returns CSV with text/csv content-type', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .get('/api/shifts/export')
      .query({ week: '2026-W11', store_id: seeds.romaStoreId })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  it('CSV contains header row', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .get('/api/shifts/export')
      .query({ week: '2026-W11', store_id: seeds.romaStoreId })
      .set('Authorization', `Bearer ${token}`);
    expect(res.text).toContain('"data"');
  });

  it('employee gets 403 accessing export', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .get('/api/shifts/export')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/shifts/affluence
// ---------------------------------------------------------------------------

describe('GET /api/shifts/affluence', () => {
  it('returns 200 with empty array when no data seeded', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .get('/api/shifts/affluence')
      .query({ store_id: seeds.romaStoreId })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.affluence)).toBe(true);
  });

  it('employee gets 403 accessing affluence', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .get('/api/shifts/affluence')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST / PUT / DELETE /api/shifts/affluence
// ---------------------------------------------------------------------------

describe('POST /api/shifts/affluence', () => {
  it('admin can create an affluence entry', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts/affluence')
      .set('Authorization', `Bearer ${token}`)
      .send({
        store_id:       seeds.romaStoreId,
        day_of_week:    1,
        time_slot:      '09:00-12:00',
        level:          'low',
        required_staff: 3,
        iso_week:       null,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.affluence).toMatchObject({
      store_id:       seeds.romaStoreId,
      day_of_week:    1,
      time_slot:      '09:00-12:00',
      level:          'low',
      required_staff: 3,
    });
  });

  it('returns 400 for invalid level', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts/affluence')
      .set('Authorization', `Bearer ${token}`)
      .send({
        store_id:       seeds.romaStoreId,
        day_of_week:    1,
        time_slot:      '09:00-12:00',
        level:          'extreme',
        required_staff: 3,
      });
    expect(res.status).toBe(400);
  });

  it('store_manager gets 403', async () => {
    const token = await login('manager.roma@acme-test.com');
    const res = await request
      .post('/api/shifts/affluence')
      .set('Authorization', `Bearer ${token}`)
      .send({
        store_id:       seeds.romaStoreId,
        day_of_week:    2,
        time_slot:      '12:00-15:00',
        level:          'medium',
        required_staff: 4,
      });
    expect(res.status).toBe(403);
  });

  it('returns 409 CONFLICT when creating a duplicate slot', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts/affluence')
      .set('Authorization', `Bearer ${token}`)
      .send({
        store_id:       seeds.romaStoreId,
        day_of_week:    1,
        time_slot:      '09:00-12:00',
        level:          'high',
        required_staff: 5,
        iso_week:       null,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('returns 404 STORE_NOT_FOUND for non-existent store', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts/affluence')
      .set('Authorization', `Bearer ${token}`)
      .send({
        store_id:       999999,
        day_of_week:    1,
        time_slot:      '09:00-12:00',
        level:          'low',
        required_staff: 2,
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('STORE_NOT_FOUND');
  });
});

describe('PUT /api/shifts/affluence/:id', () => {
  let createdId: number;

  beforeAll(async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts/affluence')
      .set('Authorization', `Bearer ${token}`)
      .send({
        store_id:       seeds.romaStoreId,
        day_of_week:    3,
        time_slot:      '15:00-18:00',
        level:          'low',
        required_staff: 2,
      });
    createdId = res.body.data.affluence.id;
  });

  it('admin can update level and required_staff', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .put(`/api/shifts/affluence/${createdId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ level: 'high', required_staff: 8 });
    expect(res.status).toBe(200);
    expect(res.body.data.affluence).toMatchObject({ level: 'high', required_staff: 8 });
  });

  it('returns 404 for non-existent id', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .put('/api/shifts/affluence/999999')
      .set('Authorization', `Bearer ${token}`)
      .send({ level: 'medium', required_staff: 5 });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/shifts/affluence/:id', () => {
  let deletableId: number;

  beforeAll(async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts/affluence')
      .set('Authorization', `Bearer ${token}`)
      .send({
        store_id:       seeds.romaStoreId,
        day_of_week:    4,
        time_slot:      '18:00-21:00',
        level:          'medium',
        required_staff: 5,
      });
    deletableId = res.body.data.affluence.id;
  });

  it('admin can delete an affluence entry', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .delete(`/api/shifts/affluence/${deletableId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(deletableId);
  });

  it('returns 404 after deletion', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .delete(`/api/shifts/affluence/${deletableId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/shifts/affluence raw mode', () => {
  it('raw=1 returns 200 with array', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .get('/api/shifts/affluence')
      .query({ store_id: seeds.romaStoreId, raw: '1' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.affluence)).toBe(true);
  });
});

describe('GET /api/shifts/affluence with week — scheduledStaff annotation', () => {
  it('returns scheduled_staff count when week + store_id are provided', async () => {
    const token = await login('admin@acme-test.com');
    // First ensure at least one affluence slot exists for Monday
    await request
      .post('/api/shifts/affluence')
      .set('Authorization', `Bearer ${token}`)
      .send({
        store_id:       seeds.romaStoreId,
        day_of_week:    2,    // Tuesday — seed shift is 2026-03-10 (Tue, 2026-W11)
        time_slot:      '09:00-12:00',
        level:          'medium',
        required_staff: 3,
        iso_week:       null,
      });

    const res = await request
      .get('/api/shifts/affluence')
      .query({ store_id: seeds.romaStoreId, week: '2026-W11' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const rows: any[] = res.body.data.affluence;
    expect(Array.isArray(rows)).toBe(true);
    // Every row must have a scheduled_staff field (number)
    for (const row of rows) {
      expect(typeof row.scheduled_staff).toBe('number');
    }
    // The Tuesday 09:00-12:00 slot should show 1 scheduled staff
    // (seed shift for employee1 is 2026-03-10 09:00-17:00 which overlaps 09:00-12:00)
    const tueTile = rows.find((r: any) => r.day_of_week === 2 && r.time_slot === '09:00-12:00');
    expect(tueTile).toBeDefined();
    expect(tueTile.scheduled_staff).toBe(1);
  });
});

describe('POST /api/shifts — approved leave conflict', () => {
  let leaveId: number;
  const CONFLICT_DATE = '2026-04-08';

  beforeAll(async () => {
    const { rows: [lr] } = await testPool.query(
      `INSERT INTO leave_requests
         (company_id, user_id, store_id, leave_type, start_date, end_date,
          status, current_approver_role, approved_by, approved_at)
       VALUES ($1, $2, $3, 'vacation', $4, $4, 'approved', NULL, $5, NOW())
       RETURNING id`,
      [seeds.acmeId, seeds.employee1Id, seeds.romaStoreId, CONFLICT_DATE, seeds.adminId],
    );
    leaveId = lr.id;
  });

  afterAll(async () => {
    await testPool.query('DELETE FROM shifts WHERE user_id = $1 AND date = $2', [seeds.employee1Id, CONFLICT_DATE]);
    await testPool.query('DELETE FROM leave_requests WHERE id = $1', [leaveId]);
  });

  it('warns instead of silently creating a shift on an approved-leave day', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: CONFLICT_DATE,
        start_time: '09:00',
        end_time: '17:00',
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LEAVE_CONFLICT');
    // The operator needs to know *which* leave, not just that there is one.
    expect(res.body.details.leave.start_date).toBe(CONFLICT_DATE);
    expect(res.body.details.leave.leave_type).toBe('vacation');
  });

  it('does not create the shift when the warning is returned', async () => {
    const { rows } = await testPool.query(
      'SELECT COUNT(*)::int AS n FROM shifts WHERE user_id = $1 AND date = $2',
      [seeds.employee1Id, CONFLICT_DATE],
    );
    expect(rows[0].n).toBe(0);
  });

  it('creates the shift once the operator confirms', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: CONFLICT_DATE,
        start_time: '09:00',
        end_time: '17:00',
        confirm_leave_conflict: true,
      });

    expect(res.status).toBe(201);
  });

  it('leaves days without approved leave completely unaffected', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id: seeds.employee1Id,
        store_id: seeds.romaStoreId,
        date: '2026-04-09',
        start_time: '09:00',
        end_time: '17:00',
      });

    expect(res.status).toBe(201);
    await testPool.query('DELETE FROM shifts WHERE id = $1', [res.body.data.id]);
  });
});
