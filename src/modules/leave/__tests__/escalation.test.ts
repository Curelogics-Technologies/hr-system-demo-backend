import { processEscalationLogic } from '../leave.controller';
import { seedTestData, clearTestData, closeTestDb, testPool } from '../../../__tests__/helpers/db';

let seeds: Awaited<ReturnType<typeof seedTestData>>;

/** A request that has been sitting untouched for longer than the 2-day threshold. */
async function seedStaleRequest(approverRole: string, status = 'pending'): Promise<number> {
  const { rows: [lr] } = await testPool.query(
    `INSERT INTO leave_requests
       (company_id, user_id, store_id, leave_type, start_date, end_date,
        status, current_approver_role, last_action_at)
     VALUES ($1, $2, $3, 'vacation', '2026-11-02', '2026-11-06', $4, $5, NOW() - INTERVAL '5 days')
     RETURNING id`,
    [seeds.acmeId, seeds.employee1Id, seeds.romaStoreId, status, approverRole],
  );
  return lr.id as number;
}

async function readRequest(id: number) {
  const { rows: [r] } = await testPool.query(
    `SELECT status, current_approver_role, approved_by, escalated, last_reminder_at
       FROM leave_requests WHERE id = $1`,
    [id],
  );
  return r;
}

beforeAll(async () => {
  seeds = await seedTestData();
  await testPool.query('DELETE FROM leave_approval_config WHERE company_id = $1', [seeds.acmeId]);
  await testPool.query(
    `INSERT INTO leave_approval_config (company_id, role, enabled, sort_order)
     VALUES ($1, 'store_manager', true, 1),
            ($1, 'area_manager', true, 2),
            ($1, 'hr', true, 3)`,
    [seeds.acmeId],
  );
});

afterEach(async () => {
  await testPool.query('DELETE FROM leave_approvals');
  await testPool.query('DELETE FROM leave_requests');
  await testPool.query('DELETE FROM notifications');
});

afterAll(async () => {
  await clearTestData();
  await closeTestDb();
});

describe('processEscalationLogic — never approves', () => {
  it('reassigns a stale request to the next approver without touching its status', async () => {
    const id = await seedStaleRequest('store_manager');

    await processEscalationLogic();

    const after = await readRequest(id);
    // Moved down the chain...
    expect(after.current_approver_role).toBe('area_manager');
    // ...but nobody approved anything.
    expect(after.status).toBe('pending');
    expect(after.approved_by).toBeNull();
    expect(after.escalated).toBe(true);
  });

  it('never produces a terminal approval, however many times it runs', async () => {
    const id = await seedStaleRequest('store_manager');

    // Five full passes: the old job needed three to reach admin_approved.
    for (let i = 0; i < 5; i++) {
      await testPool.query(
        `UPDATE leave_requests SET last_action_at = NOW() - INTERVAL '5 days',
                                   last_reminder_at = NOW() - INTERVAL '5 days'
         WHERE id = $1`,
        [id],
      );
      await processEscalationLogic();
    }

    const after = await readRequest(id);
    expect(after.approved_by).toBeNull();
    expect(['approved', 'admin_approved', 'hr_approved']).not.toContain(after.status);
    // The request is still assigned to a human, never closed out by the job.
    expect(after.current_approver_role).not.toBeNull();
  });

  it('does not deduct leave balance', async () => {
    const id = await seedStaleRequest('store_manager');
    const before = await testPool.query(
      `SELECT COALESCE(SUM(used_days), 0) AS used FROM leave_balances WHERE user_id = $1`,
      [seeds.employee1Id],
    );

    await processEscalationLogic();

    const after = await testPool.query(
      `SELECT COALESCE(SUM(used_days), 0) AS used FROM leave_balances WHERE user_id = $1`,
      [seeds.employee1Id],
    );
    expect(Number(after.rows[0].used)).toBe(Number(before.rows[0].used));
    expect(id).toBeGreaterThan(0);
  });

  it('at the end of the chain it solicits instead of approving, and does not hand the request back to the first approver', async () => {
    // 'hr' is last in the configured chain, so there is nowhere to escalate to.
    const id = await seedStaleRequest('hr', 'area manager approved');

    await processEscalationLogic();

    const after = await readRequest(id);
    expect(after.current_approver_role).toBe('hr');   // not bounced back to store_manager
    expect(after.status).toBe('area manager approved'); // untouched
    expect(after.approved_by).toBeNull();
    expect(after.last_reminder_at).not.toBeNull();
  });

  it('throttles repeat reminders to once per 2 days', async () => {
    const id = await seedStaleRequest('hr', 'area manager approved');

    await processEscalationLogic();
    await processEscalationLogic();
    await processEscalationLogic();

    const { rows } = await testPool.query(
      `SELECT COUNT(*)::int AS n FROM leave_approvals
        WHERE leave_request_id = $1 AND action = 'escalated'`,
      [id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('records the escalation as an escalation, not as an approval', async () => {
    const id = await seedStaleRequest('store_manager');

    await processEscalationLogic();

    const { rows } = await testPool.query(
      `SELECT action, approver_role, notes FROM leave_approvals WHERE leave_request_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('escalated');
    expect(rows[0].approver_role).toBe('system');
    expect(rows[0].notes).not.toMatch(/auto-approved/i);
  });

  it('notifies the approver who now owes a decision', async () => {
    await seedStaleRequest('store_manager');

    await processEscalationLogic();

    const { rows } = await testPool.query(
      `SELECT type FROM notifications WHERE type = 'leave.escalated'`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('database guard (migration 135)', () => {
  it('rejects a terminal approval that has no approving user', async () => {
    const id = await seedStaleRequest('store_manager');

    await expect(
      testPool.query(
        `UPDATE leave_requests SET status = 'admin_approved', current_approver_role = NULL WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/without an approving user/i);
  });

  it('allows the same transition when a person is recorded', async () => {
    const id = await seedStaleRequest('store_manager');

    await expect(
      testPool.query(
        `UPDATE leave_requests SET status = 'admin_approved', current_approver_role = NULL, approved_by = $2 WHERE id = $1`,
        [id, seeds.adminId],
      ),
    ).resolves.toBeDefined();

    const after = await readRequest(id);
    expect(after.approved_by).toBe(seeds.adminId);
  });
});
