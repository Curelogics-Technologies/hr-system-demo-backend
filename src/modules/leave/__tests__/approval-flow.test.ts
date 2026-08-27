/**
 * End-to-end walk of the approval chain, as the client will test it by hand:
 *
 *   employee submits
 *     -> store_manager sees it in "pending approvals"      (auto-advances if idle)
 *     -> area_manager  sees it in "pending approvals"      (auto-advances if idle)
 *     -> hr            sees it and MUST decide manually    (never auto)
 *     -> balance deducted, status approved
 *
 * Also covers who can see whose request, which is where the reported
 * "nothing in the pending approvals tab" symptom would show up.
 */
import express from 'express';
import supertest from 'supertest';
import authRoutes from '../../auth/auth.routes';
import leaveRoutes from '../leave.routes';
import { processEscalationLogic } from '../leave.controller';
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

async function login(email: string): Promise<string> {
  const res = await request.post('/api/auth/login').send({ email, password: 'password123' });
  return res.body.data.token as string;
}

async function pendingIds(email: string): Promise<number[]> {
  const token = await login(email);
  const res = await request.get('/api/leave/pending').set('Authorization', `Bearer ${token}`);
  return (res.body?.data?.requests ?? []).map((r: any) => r.id);
}

async function submitAs(email: string, start: string, end: string): Promise<number> {
  const token = await login(email);
  const res = await request
    .post('/api/leave')
    .set('Authorization', `Bearer ${token}`)
    .send({ leave_type: 'vacation', start_date: start, end_date: end });
  if (res.status !== 201) throw new Error(`submit failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data.id as number;
}

async function readRequest(id: number) {
  const { rows: [r] } = await testPool.query(
    `SELECT status, current_approver_role, approved_by, escalated FROM leave_requests WHERE id = $1`, [id]);
  return r;
}

/** Give an employee an allocation, which HR/Admin approval now requires. */
async function allocate(userId: number, year: number, days = 30, type = 'vacation') {
  await testPool.query(
    `INSERT INTO leave_balances (company_id, user_id, year, leave_type, total_days, used_days)
     VALUES ($1,$2,$3,$4,$5,0)
     ON CONFLICT (company_id, user_id, year, leave_type)
     DO UPDATE SET total_days = EXCLUDED.total_days, used_days = 0`,
    [seeds.acmeId, userId, year, type, days],
  );
}

async function makeStale(id: number) {
  await testPool.query(
    `UPDATE leave_requests
        SET last_action_at = NOW() - INTERVAL '5 days',
            last_reminder_at = NOW() - INTERVAL '5 days'
      WHERE id = $1`, [id]);
}

beforeAll(async () => {
  seeds = await seedTestData();
  await testPool.query('DELETE FROM leave_approval_config WHERE company_id = $1', [seeds.acmeId]);
  await testPool.query(
    `INSERT INTO leave_approval_config (company_id, role, enabled, sort_order)
     VALUES ($1,'store_manager',true,1), ($1,'area_manager',true,2), ($1,'hr',true,3)`,
    [seeds.acmeId],
  );
});

afterEach(async () => {
  await testPool.query('DELETE FROM leave_approvals');
  await testPool.query('DELETE FROM leave_requests');
  await testPool.query('DELETE FROM leave_balances');
});

afterAll(async () => { await clearTestData(); await closeTestDb(); });

describe('who sees a request in "pending approvals"', () => {
  it('an employee request appears for the store manager', async () => {
    const id = await submitAs('employee1@acme-test.com', '2026-11-02', '2026-11-04');
    expect(await pendingIds('manager.roma@acme-test.com')).toContain(id);
  });

  it('and NOT for the area manager or HR while it sits with the store manager', async () => {
    const id = await submitAs('employee1@acme-test.com', '2026-11-05', '2026-11-06');
    expect(await pendingIds('area@acme-test.com')).not.toContain(id);
    expect(await pendingIds('hr@acme-test.com')).not.toContain(id);
  });

  it('moves to the area manager once the store manager approves', async () => {
    const id = await submitAs('employee1@acme-test.com', '2026-11-09', '2026-11-10');
    const token = await login('manager.roma@acme-test.com');
    const res = await request.put(`/api/leave/${id}/approve`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);

    expect(await pendingIds('area@acme-test.com')).toContain(id);
    expect(await pendingIds('manager.roma@acme-test.com')).not.toContain(id);
  });

  it('a store manager\'s OWN request skips their level and goes to the area manager', async () => {
    const id = await submitAs('manager.roma@acme-test.com', '2026-11-12', '2026-11-13');
    const r = await readRequest(id);
    expect(r.current_approver_role).toBe('area_manager');
    expect(await pendingIds('area@acme-test.com')).toContain(id);
  });
});

describe('auto-advance below HR, never at HR', () => {
  it('carries an idle store_manager stage forward automatically', async () => {
    const id = await submitAs('employee1@acme-test.com', '2026-11-16', '2026-11-17');
    await makeStale(id);

    await processEscalationLogic();

    const r = await readRequest(id);
    expect(r.current_approver_role).toBe('area_manager');
    expect(r.escalated).toBe(true);
    expect(r.approved_by).toBeNull();          // still nobody's decision
  });

  it('stops dead at HR — no auto-approval, no advancing', async () => {
    const id = await submitAs('employee1@acme-test.com', '2026-11-19', '2026-11-20');

    // Walk it up to HR by letting the job clear the two manager stages.
    await makeStale(id); await processEscalationLogic();
    await makeStale(id); await processEscalationLogic();
    expect((await readRequest(id)).current_approver_role).toBe('hr');

    // Now hammer it: HR must never be bypassed.
    for (let i = 0; i < 5; i++) { await makeStale(id); await processEscalationLogic(); }

    const r = await readRequest(id);
    expect(r.current_approver_role).toBe('hr');
    expect(r.approved_by).toBeNull();
    expect(['approved', 'admin_approved', 'hr_approved']).not.toContain(r.status);
  });

  it('never deducts balance while auto-advancing', async () => {
    await allocate(seeds.employee1Id, 2026, 30);
    const id = await submitAs('employee1@acme-test.com', '2026-11-23', '2026-11-24');
    await makeStale(id); await processEscalationLogic();
    await makeStale(id); await processEscalationLogic();

    const { rows: [b] } = await testPool.query(
      `SELECT used_days FROM leave_balances WHERE user_id = $1 AND year = 2026 AND leave_type='vacation'`,
      [seeds.employee1Id]);
    expect(Number(b.used_days)).toBe(0);
  });
});

describe('HR approval requires a configured balance', () => {
  async function walkToHr(start: string, end: string): Promise<number> {
    const id = await submitAs('employee1@acme-test.com', start, end);
    await makeStale(id); await processEscalationLogic();
    await makeStale(id); await processEscalationLogic();
    expect((await readRequest(id)).current_approver_role).toBe('hr');
    return id;
  }

  it('refuses HR approval when no allocation exists, naming the reason', async () => {
    const id = await walkToHr('2026-12-01', '2026-12-02');
    const token = await login('hr@acme-test.com');
    const res = await request.put(`/api/leave/${id}/approve`).set('Authorization', `Bearer ${token}`).send({});

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('BALANCE_NOT_CONFIGURED');
    expect(await readRequest(id)).toMatchObject({ approved_by: null });
  });

  it('approves and deducts once the allocation is configured', async () => {
    await allocate(seeds.employee1Id, 2026, 30);
    const id = await walkToHr('2026-12-07', '2026-12-08');

    const token = await login('hr@acme-test.com');
    const res = await request.put(`/api/leave/${id}/approve`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);

    const r = await readRequest(id);
    expect(r.approved_by).not.toBeNull();       // a person, on the record
    expect(r.current_approver_role).toBeNull(); // chain complete

    const { rows: [b] } = await testPool.query(
      `SELECT used_days FROM leave_balances WHERE user_id = $1 AND year = 2026 AND leave_type='vacation'`,
      [seeds.employee1Id]);
    expect(Number(b.used_days)).toBeGreaterThan(0);
  });

  it('a lower level can still pass the request up without any allocation', async () => {
    const id = await submitAs('employee1@acme-test.com', '2026-12-14', '2026-12-15');
    const token = await login('manager.roma@acme-test.com');
    const res = await request.put(`/api/leave/${id}/approve`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);   // not blocked — only HR/Admin are gated
  });
});

describe('clearing an allocation (total_days = 0)', () => {
  async function putBalance(email: string, totalDays: number) {
    const token = await login(email);
    return request
      .put('/api/leave/balance')
      .set('Authorization', `Bearer ${token}`)
      .send({ user_id: seeds.employee1Id, year: 2026, leave_type: 'vacation', total_days: totalDays });
  }

  it('admin can clear an unused allocation, returning the employee to not-configured', async () => {
    await allocate(seeds.employee1Id, 2026, 25);

    const res = await putBalance('admin@acme-test.com', 0);
    expect(res.status).toBe(200);

    const { rows } = await testPool.query(
      `SELECT 1 FROM leave_balances WHERE user_id = $1 AND year = 2026 AND leave_type = 'vacation'`,
      [seeds.employee1Id],
    );
    expect(rows).toHaveLength(0);
  });

  it('HR cannot clear an allocation — that is an admin action', async () => {
    await allocate(seeds.employee1Id, 2026, 25);

    const res = await putBalance('hr@acme-test.com', 0);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BALANCE_CLEAR_ADMIN_ONLY');
  });

  it('refuses to clear once days have been used, rather than orphaning them', async () => {
    await allocate(seeds.employee1Id, 2026, 25);
    await testPool.query(
      `UPDATE leave_balances SET used_days = 3 WHERE user_id = $1 AND year = 2026 AND leave_type='vacation'`,
      [seeds.employee1Id],
    );

    const res = await putBalance('admin@acme-test.com', 0);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('BALANCE_CLEAR_HAS_USAGE');
  });

  it('still refuses a negative total', async () => {
    const res = await putBalance('admin@acme-test.com', -5);
    expect(res.status).toBe(400);
  });
});
