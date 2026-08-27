import express from 'express';
import supertest from 'supertest';
import attendanceRoutes from '../attendance.routes';
import { seedTestData, clearTestData, closeTestDb, testPool } from '../../../__tests__/helpers/db';
import authRoutes from '../../auth/auth.routes';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ success: false, error: err.message });
});

const request = supertest(app);
let seeds: Awaited<ReturnType<typeof seedTestData>>;

async function login(email: string): Promise<string> {
  const res = await request.post('/api/auth/login').send({ email, password: 'password123' });
  return res.body.data.token as string;
}

beforeAll(async () => { seeds = await seedTestData(); });
afterAll(async () => { await clearTestData(); await closeTestDb(); });

describe('GET /api/attendance/anomalies', () => {
  it('returns 200 with an array of anomalies', async () => {
    const token = await login('manager.roma@acme-test.com');
    const res = await request
      .get('/api/attendance/anomalies')
      .set('Authorization', `Bearer ${token}`)
      .query({ store_id: seeds.romaStoreId, date_from: '2026-03-01', date_to: '2026-03-15' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.anomalies)).toBe(true);
    expect(typeof res.body.data.total).toBe('number');
  });

  it('detects no_show for a past shift with no check-in', async () => {
    // seedTestData creates a shift on 2026-03-10 for employee1 with no attendance events
    const token = await login('manager.roma@acme-test.com');
    const res = await request
      .get('/api/attendance/anomalies')
      .set('Authorization', `Bearer ${token}`)
      .query({ store_id: seeds.romaStoreId, date_from: '2026-03-10', date_to: '2026-03-10' });

    expect(res.status).toBe(200);
    const noShows = res.body.data.anomalies.filter((a: any) => a.anomaly_type === 'no_show');
    expect(noShows.length).toBeGreaterThan(0);
  });

  it('returns 403 for employee role', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .get('/api/attendance/anomalies')
      .set('Authorization', `Bearer ${token}`)
      .query({ store_id: seeds.romaStoreId });

    expect(res.status).toBe(403);
  });
});

describe('approved leave is not an unjustified absence', () => {
  // The same 2026-03-10 shift the no_show test above relies on, but with an
  // approved leave covering it. Shifts are only cancelled when the approver
  // ticks the optional cancel_shifts box, so the shift stays active — which is
  // exactly the situation that produced false absences.
  let leaveId: number;

  beforeAll(async () => {
    const { rows: [lr] } = await testPool.query(
      `INSERT INTO leave_requests
         (company_id, user_id, store_id, leave_type, start_date, end_date,
          status, current_approver_role, approved_by, approved_at)
       VALUES ($1, $2, $3, 'vacation', '2026-03-10', '2026-03-10',
               'approved', NULL, $4, NOW())
       RETURNING id`,
      [seeds.acmeId, seeds.employee1Id, seeds.romaStoreId, seeds.adminId],
    );
    leaveId = lr.id;
  });

  afterAll(async () => {
    await testPool.query('DELETE FROM leave_requests WHERE id = $1', [leaveId]);
  });

  it('reports the day as on_leave instead of no_show', async () => {
    const token = await login('manager.roma@acme-test.com');
    const res = await request
      .get('/api/attendance/anomalies')
      .set('Authorization', `Bearer ${token}`)
      .query({ store_id: seeds.romaStoreId, date_from: '2026-03-10', date_to: '2026-03-10' });

    expect(res.status).toBe(200);
    const forEmployee = res.body.data.anomalies.filter(
      (a: any) => a.user_id === seeds.employee1Id,
    );
    expect(forEmployee.some((a: any) => a.anomaly_type === 'no_show')).toBe(false);
    expect(forEmployee.some((a: any) => a.anomaly_type === 'on_leave')).toBe(true);
  });

  it('marks it informational, so it does not drive the severity counters', async () => {
    const token = await login('manager.roma@acme-test.com');
    const res = await request
      .get('/api/attendance/anomalies')
      .set('Authorization', `Bearer ${token}`)
      .query({ store_id: seeds.romaStoreId, date_from: '2026-03-10', date_to: '2026-03-10' });

    const onLeave = res.body.data.anomalies.find(
      (a: any) => a.user_id === seeds.employee1Id && a.anomaly_type === 'on_leave',
    );
    expect(onLeave.severity).toBe('info');
  });
});
