import express from 'express';
import supertest from 'supertest';
import authRoutes from '../../auth/auth.routes';
import leaveRoutes from '../leave.routes';
import { seedTestData, clearTestData, closeTestDb, testPool } from '../../../__tests__/helpers/db';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/leave', leaveRoutes);
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

  // Seed approval config for acme company to have store_manager -> area_manager -> hr chain
  await testPool.query('DELETE FROM leave_approval_config WHERE company_id = $1', [seeds.acmeId]);
  await testPool.query(
    `INSERT INTO leave_approval_config (company_id, role, enabled, sort_order)
     VALUES ($1, 'store_manager', true, 1),
            ($1, 'area_manager', true, 2),
            ($1, 'hr', true, 3)`,
    [seeds.acmeId]
  );
});

afterAll(async () => {
  await clearTestData();
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function cleanLeave(): Promise<void> {
  await testPool.query('DELETE FROM leave_balances');
  await testPool.query('DELETE FROM leave_approvals');
  await testPool.query('DELETE FROM leave_requests');
}

// ---------------------------------------------------------------------------
// POST /api/leave — submit a leave request
// ---------------------------------------------------------------------------

describe('POST /api/leave', () => {
  afterEach(async () => {
    await cleanLeave();
  });

  it('employee can submit a vacation request and gets 201', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .post('/api/leave')
      .set('Authorization', `Bearer ${token}`)
      .send({
        leave_type: 'vacation',
        start_date: '2026-12-01',
        end_date: '2026-12-05',
        notes: 'Ferie estive',
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.leave_type).toBe('vacation');
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.user_id).toBe(seeds.employee1Id);
    expect(res.body.data.company_id).toBe(seeds.acmeId);
    // current_approver_role must be set to the first approver in the chain
    expect(res.body.data.current_approver_role).toBeTruthy();
  });

  it('employee can submit a sick leave request and gets 201', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .post('/api/leave')
      .set('Authorization', `Bearer ${token}`)
      .send({
        leave_type: 'sick',
        start_date: '2026-12-10',
        end_date: '2026-12-10',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.leave_type).toBe('sick');
  });

  it('returns 400 when start_date is after end_date', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .post('/api/leave')
      .set('Authorization', `Bearer ${token}`)
      .send({
        leave_type: 'vacation',
        start_date: '2026-12-10',
        end_date: '2026-12-01',
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for an invalid leave_type', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .post('/api/leave')
      .set('Authorization', `Bearer ${token}`)
      .send({
        leave_type: 'personal_day',
        start_date: '2026-12-01',
        end_date: '2026-12-01',
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when start_date is missing', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .post('/api/leave')
      .set('Authorization', `Bearer ${token}`)
      .send({
        leave_type: 'vacation',
        end_date: '2026-12-05',
      });
    expect(res.status).toBe(400);
  });

  it('returns 401 for unauthenticated request', async () => {
    const res = await request
      .post('/api/leave')
      .send({
        leave_type: 'vacation',
        start_date: '2026-12-01',
        end_date: '2026-12-05',
      });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/leave — list leave requests
// ---------------------------------------------------------------------------

describe('GET /api/leave', () => {
  let leaveId: number;

  beforeAll(async () => {
    // Insert a leave request directly via DB for predictable test data
    const { rows: [lr] } = await testPool.query(
      `INSERT INTO leave_requests (company_id, user_id, store_id, leave_type, start_date, end_date, status, current_approver_role, notes)
       VALUES ($1, $2, $3, 'vacation', '2026-08-01', '2026-08-05', 'pending', 'store_manager', 'Test ferie')
       RETURNING id`,
      [seeds.acmeId, seeds.employee1Id, seeds.romaStoreId]
    );
    leaveId = lr.id;
  });

  afterAll(async () => {
    await cleanLeave();
  });

  it('employee sees only their own requests', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request.get('/api/leave').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const items: any[] = res.body.data.requests;
    expect(items.length).toBeGreaterThanOrEqual(1);
    items.forEach((r) => expect(r.user_id).toBe(seeds.employee1Id));
  });

  it('store_manager sees requests from their store', async () => {
    const token = await login('manager.roma@acme-test.com');
    const res = await request.get('/api/leave').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const items: any[] = res.body.data.requests;
    const found = items.find((r) => r.id === leaveId);
    expect(found).toBeDefined();
  });

  it('hr sees all company leave requests', async () => {
    const token = await login('hr@acme-test.com');
    const res = await request.get('/api/leave').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const items: any[] = res.body.data.requests;
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by status', async () => {
    const token = await login('hr@acme-test.com');
    const res = await request
      .get('/api/leave')
      .query({ status: 'pending' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    res.body.data.requests.forEach((r: any) => expect(r.status).toBe('pending'));
  });

  it('filters by leave_type', async () => {
    const token = await login('hr@acme-test.com');
    const res = await request
      .get('/api/leave')
      .query({ leave_type: 'vacation' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    res.body.data.requests.forEach((r: any) => expect(r.leave_type).toBe('vacation'));
  });

  it('includes cross-month leave requests when filtering by date_from and date_to', async () => {
    const { rows: [crossMonthReq] } = await testPool.query(
      `INSERT INTO leave_requests (company_id, user_id, store_id, leave_type, start_date, end_date, status, current_approver_role, notes)
       VALUES ($1, $2, $3, 'vacation', '2026-07-27', '2026-08-09', 'approved', 'admin', 'Cross month vacation')
       RETURNING id`,
      [seeds.acmeId, seeds.employee1Id, seeds.romaStoreId]
    );

    const token = await login('hr@acme-test.com');
    const res = await request
      .get('/api/leave')
      .query({ date_from: '2026-08-01', date_to: '2026-08-31' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const found = res.body.data.requests.find((r: any) => r.id === crossMonthReq.id);
    expect(found).toBeDefined();
  });

  it('returns 401 for unauthenticated request', async () => {
    const res = await request.get('/api/leave');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/leave/pending — approval queue for current user's role
// ---------------------------------------------------------------------------

describe('GET /api/leave/pending', () => {
  let leaveId: number;

  beforeAll(async () => {
    const { rows: [lr] } = await testPool.query(
      `INSERT INTO leave_requests (company_id, user_id, store_id, leave_type, start_date, end_date, status, current_approver_role)
       VALUES ($1, $2, $3, 'vacation', '2026-09-01', '2026-09-05', 'pending', 'store_manager')
       RETURNING id`,
      [seeds.acmeId, seeds.employee1Id, seeds.romaStoreId]
    );
    leaveId = lr.id;
  });

  afterAll(async () => {
    await cleanLeave();
  });

  it('store_manager sees pending requests assigned to their role', async () => {
    const token = await login('manager.roma@acme-test.com');
    const res = await request.get('/api/leave/pending').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const items: any[] = res.body.data.requests;
    const found = items.find((r: any) => r.id === leaveId);
    expect(found).toBeDefined();
    expect(found.current_approver_role).toBe('store_manager');
  });

  it('hr sees no pending items when current_approver_role is store_manager', async () => {
    const token = await login('hr@acme-test.com');
    const res = await request.get('/api/leave/pending').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // hr pending queue filters by current_approver_role = 'hr' — should not include store_manager items
    const items: any[] = res.body.data.requests;
    items.forEach((r: any) => expect(r.current_approver_role).toBe('hr'));
  });

  it('employee gets 403 — employees cannot be approvers', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request.get('/api/leave/pending').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/leave/:id/approve — approve a request
// ---------------------------------------------------------------------------

describe('PUT /api/leave/:id/approve', () => {
  let leaveId: number;

  beforeEach(async () => {
    const { rows: [lr] } = await testPool.query(
      `INSERT INTO leave_requests (company_id, user_id, store_id, leave_type, start_date, end_date, status, current_approver_role)
       VALUES ($1, $2, $3, 'vacation', '2026-10-07', '2026-10-09', 'pending', 'store_manager')
       RETURNING id`,
      [seeds.acmeId, seeds.employee1Id, seeds.romaStoreId]
    );
    leaveId = lr.id;
  });

  afterEach(async () => {
    await cleanLeave();
  });

  it('store_manager can approve a pending request — status advances to store manager approved', async () => {
    const token = await login('manager.roma@acme-test.com');
    const res = await request
      .put(`/api/leave/${leaveId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Approvato' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('store manager approved');
    expect(res.body.data.current_approver_role).toBe('area_manager');
  });

  it('approving with wrong role (employee) gets 403', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .put(`/api/leave/${leaveId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('approving a request not assigned to your role gets 403', async () => {
    // Request is assigned to store_manager; area_manager tries to approve
    const token = await login('area@acme-test.com');
    const res = await request
      .put(`/api/leave/${leaveId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('full approval chain: store_manager → area_manager → hr → hr_approved, balance decremented', async () => {
    // HR approval now requires the employee's entitlement to be configured —
    // leave is never granted against days nobody allocated.
    await testPool.query(
      `INSERT INTO leave_balances (company_id, user_id, year, leave_type, total_days, used_days)
       VALUES ($1, $2, 2026, 'vacation', 25, 0)
       ON CONFLICT (company_id, user_id, year, leave_type)
       DO UPDATE SET total_days = 25, used_days = 0`,
      [seeds.acmeId, seeds.employee1Id],
    );

    // Step 1: store_manager approves
    const smToken = await login('manager.roma@acme-test.com');
    const step1 = await request
      .put(`/api/leave/${leaveId}/approve`)
      .set('Authorization', `Bearer ${smToken}`)
      .send({});
    expect(step1.status).toBe(200);
    expect(step1.body.data.status).toBe('store manager approved');
    expect(step1.body.data.current_approver_role).toBe('area_manager');

    // Step 2: area_manager approves
    const amToken = await login('area@acme-test.com');
    const step2 = await request
      .put(`/api/leave/${leaveId}/approve`)
      .set('Authorization', `Bearer ${amToken}`)
      .send({});
    expect(step2.status).toBe(200);
    expect(step2.body.data.status).toBe('area manager approved');
    expect(step2.body.data.current_approver_role).toBe('hr');

    // Step 3: hr approves (final — triggers balance update)
    const hrToken = await login('hr@acme-test.com');
    const step3 = await request
      .put(`/api/leave/${leaveId}/approve`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({});
    expect(step3.status).toBe(200);
    expect(step3.body.data.status).toBe('HR approved');
    expect(step3.body.data.current_approver_role).toBeNull();

    // Verify balance was decremented
    // 2026-10-07 (Wed) to 2026-10-09 (Fri) = 3 working days
    const { rows: [balance] } = await testPool.query(
      `SELECT used_days FROM leave_balances WHERE user_id = $1 AND year = 2026 AND leave_type = 'vacation'`,
      [seeds.employee1Id]
    );
    expect(balance).toBeDefined();
    expect(parseFloat(balance.used_days)).toBe(3);
  });

  it('returns 404 for a leave request that does not exist', async () => {
    const token = await login('manager.roma@acme-test.com');
    const res = await request
      .put('/api/leave/999999/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/leave/:id/reject — reject a request
// ---------------------------------------------------------------------------

describe('PUT /api/leave/:id/reject', () => {
  let leaveId: number;

  beforeEach(async () => {
    const { rows: [lr] } = await testPool.query(
      `INSERT INTO leave_requests (company_id, user_id, store_id, leave_type, start_date, end_date, status, current_approver_role)
       VALUES ($1, $2, $3, 'vacation', '2026-11-01', '2026-11-07', 'pending', 'store_manager')
       RETURNING id`,
      [seeds.acmeId, seeds.employee1Id, seeds.romaStoreId]
    );
    leaveId = lr.id;
  });

  afterEach(async () => {
    await cleanLeave();
  });

  it('store_manager can reject a pending request', async () => {
    const token = await login('manager.roma@acme-test.com');
    const res = await request
      .put(`/api/leave/${leaveId}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Periodo già coperto da altri' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.current_approver_role).toBeNull();
  });

  it('hr can reject a request at any stage', async () => {
    // Advance to area_manager_approved first
    await testPool.query(
      `UPDATE leave_requests SET status='area_manager_approved', current_approver_role='hr' WHERE id=$1`,
      [leaveId]
    );
    const token = await login('hr@acme-test.com');
    const res = await request
      .put(`/api/leave/${leaveId}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Non approvato' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');
  });

  it('returns 400 when notes are missing on rejection', async () => {
    const token = await login('manager.roma@acme-test.com');
    const res = await request
      .put(`/api/leave/${leaveId}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('employee gets 403 trying to reject', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .put(`/api/leave/${leaveId}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'No' });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/leave/balance — leave balance
// ---------------------------------------------------------------------------

describe('GET /api/leave/balance', () => {
  beforeAll(async () => {
    // Seed a known balance for employee1
    await testPool.query(
      `INSERT INTO leave_balances (company_id, user_id, year, leave_type, total_days, used_days)
       VALUES ($1, $2, 2026, 'vacation', 25, 10)
       ON CONFLICT (company_id, user_id, year, leave_type) DO UPDATE SET used_days=10`,
      [seeds.acmeId, seeds.employee1Id]
    );
    // Seed approved leave request representing 10 days of vacation
    // 2026-05-01 (Fri) to 2026-05-14 (Tue) = 10 working days
    // approved_by is required: migration 135 forbids a request reaching a
    // terminal approval without a person behind it.
    await testPool.query(
      `INSERT INTO leave_requests (company_id, user_id, store_id, leave_type, start_date, end_date, status, current_approver_role, notes, approved_by, approved_at)
       VALUES ($1, $2, $3, 'vacation', '2026-05-01', '2026-05-14', 'approved', null, 'Ferie pregresse', $4, NOW())`,
      [seeds.acmeId, seeds.employee1Id, seeds.romaStoreId, seeds.adminId]
    );
  });

  afterAll(async () => {
    await cleanLeave();
  });

  it('employee gets their own balance with correct remaining_days', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .get('/api/leave/balance')
      .query({ year: 2026 })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const balances: any[] = res.body.data.balances;
    const vacation = balances.find((b: any) => b.leave_type === 'vacation');
    expect(vacation).toBeDefined();
    expect(parseFloat(vacation.total_days)).toBe(25);
    expect(parseFloat(vacation.used_days)).toBe(10);
    expect(parseFloat(vacation.remaining_days)).toBe(15);
  });

  it('hr can query balance for a specific user_id', async () => {
    const token = await login('hr@acme-test.com');
    const res = await request
      .get('/api/leave/balance')
      .query({ user_id: seeds.employee1Id, year: 2026 })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const balances: any[] = res.body.data.balances;
    expect(balances.length).toBeGreaterThanOrEqual(1);
  });

  it('employee cannot query another user balance — gets 403', async () => {
    const token = await login('employee1@acme-test.com');
    // Passing someone else's user_id should be rejected with 403
    const res = await request
      .get('/api/leave/balance')
      .query({ user_id: seeds.adminId, year: 2026 })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('hr approval of a request that exceeds balance returns 422', async () => {
    // Insert a request spanning many days (well over 25 day vacation total)
    const { rows: [lr] } = await testPool.query(
      `INSERT INTO leave_requests (company_id, user_id, store_id, leave_type, start_date, end_date, status, current_approver_role)
       VALUES ($1, $2, $3, 'vacation', '2026-12-01', '2027-01-15', 'area_manager_approved', 'hr')
       RETURNING id`,
      [seeds.acmeId, seeds.employee1Id, seeds.romaStoreId]
    );
    const hrToken = await login('hr@acme-test.com');
    const res = await request
      .put(`/api/leave/${lr.id}/approve`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
    // Cleanup
    await testPool.query('DELETE FROM leave_requests WHERE id=$1', [lr.id]);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/leave/balance — upsert leave balance allocation
// ---------------------------------------------------------------------------

describe('PUT /api/leave/balance', () => {
  afterEach(async () => {
    await cleanLeave();
  });

  it('admin can set total_days for an employee → 200 with correct total_days', async () => {
    const token = await login('admin@acme-test.com');
    const res = await request
      .put('/api/leave/balance')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id:    seeds.employee1Id,
        year:       2026,
        leave_type: 'vacation',
        total_days: 30,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(parseFloat(res.body.data.total_days)).toBe(30);
    expect(res.body.data.user_id).toBe(seeds.employee1Id);
    expect(res.body.data.leave_type).toBe('vacation');
    expect(res.body.data.year).toBe(2026);
  });

  it('hr can set total_days for an employee → 200', async () => {
    const token = await login('hr@acme-test.com');
    const res = await request
      .put('/api/leave/balance')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id:    seeds.employee1Id,
        year:       2026,
        leave_type: 'sick',
        total_days: 15,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(parseFloat(res.body.data.total_days)).toBe(15);
  });

  it('employee role gets 403', async () => {
    const token = await login('employee1@acme-test.com');
    const res = await request
      .put('/api/leave/balance')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id:    seeds.employee1Id,
        year:       2026,
        leave_type: 'vacation',
        total_days: 20,
      });
    expect(res.status).toBe(403);
  });

  it('total_days below existing used_days → 422 with code BALANCE_BELOW_USED', async () => {
    // Pre-insert a balance row with used_days = 5
    await testPool.query(
      `INSERT INTO leave_balances (company_id, user_id, year, leave_type, total_days, used_days)
       VALUES ($1, $2, 2026, 'vacation', 25, 5)
       ON CONFLICT (company_id, user_id, year, leave_type)
       DO UPDATE SET used_days = 5, total_days = 25`,
      [seeds.acmeId, seeds.employee1Id],
    );

    const token = await login('admin@acme-test.com');
    const res = await request
      .put('/api/leave/balance')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id:    seeds.employee1Id,
        year:       2026,
        leave_type: 'vacation',
        total_days: 3,
      });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('BALANCE_BELOW_USED');
  });

  it('user_id in allowed group company → 200', async () => {
    // Create an employee in the Beta company
    const { rows: [betaEmployee] } = await testPool.query(
      `INSERT INTO users (company_id, name, surname, email, password_hash, role, status)
       VALUES ($1, 'Beta', 'Employee', 'beta.emp@beta-test.com',
               '$2a$10$e/ULie.9SQf5MIQSNjkxEO7.xAyc6zv/qysVTE4mVFhZum/BjT5VG',
               'employee', 'active')
       RETURNING id`,
      [seeds.betaId],
    );

    const token = await login('admin@acme-test.com');
    const res = await request
      .put('/api/leave/balance')
      .set('Authorization', `Bearer ${token}`)
      .send({
        user_id:    betaEmployee.id,
        year:       2026,
        leave_type: 'vacation',
        total_days: 20,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Cleanup
    await testPool.query('DELETE FROM leave_balances WHERE user_id = $1', [betaEmployee.id]);
    await testPool.query('DELETE FROM users WHERE id = $1', [betaEmployee.id]);
  });
});
