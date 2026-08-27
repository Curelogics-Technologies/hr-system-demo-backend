/**
 * Repair leave requests that the escalation job granted on its own.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed.
 *
 *   # see what would change on the live server
 *   DATABASE_URL="postgres://...prod..." npx ts-node src/scripts/repairLeaveEscalations.ts
 *
 *   # actually do it (take a backup first)
 *   DATABASE_URL="..." npx ts-node src/scripts/repairLeaveEscalations.ts --apply
 *
 * What it does to each affected request:
 *   - rewinds `status` to the last genuine human approval (or 'pending')
 *   - reassigns `current_approver_role` so a person has to decide
 *   - rewrites the misleading "System auto-approved ..." note, keeping the row
 *     as audit history rather than deleting it
 *
 * What it deliberately does NOT do:
 *   - touch requests whose leave period has already elapsed. Those days may
 *     have been taken already, so reopening them is a business decision, not a
 *     data fix. They are listed under "SKIPPED (elapsed)" and need a human
 *     call. Pass --include-elapsed only after that call has been made.
 *   - invent balance deductions. Reverting to pending removes the phantom
 *     approval; the real deduction happens when a person approves.
 */
import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const APPLY = process.argv.includes('--apply');
const INCLUDE_ELAPSED = process.argv.includes('--include-elapsed');

const DEFAULT_CHAIN = ['store_manager', 'area_manager', 'hr', 'admin'];
const ROLE_STATUS: Record<string, string> = {
  store_manager: 'store manager approved',
  area_manager: 'area manager approved',
  hr: 'HR approved',
  admin: 'approved',
};

interface Target {
  id: number;
  company_id: number;
  user_id: number;
  employee: string;
  company: string | null;
  status: string;
  start_date: string;
  end_date: string;
  days: number;
  elapsed: boolean;
}

async function approvalChain(client: PoolClient, companyId: number): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT role FROM leave_approval_config
      WHERE company_id = $1 AND enabled = true ORDER BY sort_order`,
    [companyId],
  );
  return rows.length ? rows.map((r) => r.role as string) : DEFAULT_CHAIN;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c timezone=UTC' });
  const client = await pool.connect();

  try {
    const { rows: [who] } = await client.query(`SELECT current_database() AS db`);
    console.log(`\nDatabase : ${who.db}`);
    console.log(`Mode     : ${APPLY ? '*** APPLY — changes will be written ***' : 'dry run (no changes)'}\n`);

    const { rows: targets } = await client.query<Target>(
      `SELECT lr.id, lr.company_id, lr.user_id,
              (u.name || ' ' || COALESCE(u.surname,'')) AS employee,
              c.name AS company, lr.status,
              lr.start_date::text AS start_date, lr.end_date::text AS end_date,
              (lr.end_date - lr.start_date + 1) AS days,
              (lr.end_date < CURRENT_DATE) AS elapsed
         FROM leave_requests lr
         JOIN users u ON u.id = lr.user_id
         LEFT JOIN companies c ON c.id = lr.company_id
        WHERE lr.current_approver_role IS NULL
          AND lr.status NOT IN ('pending','rejected','cancelled',
                                'store manager rejected','area manager rejected','HR rejected')
          AND NOT EXISTS (
                SELECT 1 FROM leave_approvals la
                 WHERE la.leave_request_id = lr.id
                   AND la.approver_id IS NOT NULL
                   AND la.action = 'approved')
        ORDER BY lr.start_date`,
    );

    if (targets.length === 0) {
      console.log('Nothing to repair — no leave was granted without a human approver.\n');
      return;
    }

    const actionable = targets.filter((t) => INCLUDE_ELAPSED || !t.elapsed);
    const skipped = targets.filter((t) => !INCLUDE_ELAPSED && t.elapsed);

    if (APPLY) await client.query('BEGIN');

    for (const t of actionable) {
      const chain = await approvalChain(client, t.company_id);

      // Rewind to the furthest phase a person actually signed off, if any.
      const { rows: humanActions } = await client.query(
        `SELECT approver_role FROM leave_approvals
          WHERE leave_request_id = $1 AND approver_id IS NOT NULL AND action = 'approved'
          ORDER BY created_at DESC LIMIT 1`,
        [t.id],
      );

      // Reopen at HR: that is the level where leave becomes real and the
      // balance is deducted, and it is precisely the decision these requests
      // never received. Sending them back to the start would make managers
      // re-approve stages the system had already cleared, so the request is
      // parked exactly where a human is actually required.
      //
      // If a person genuinely signed off a stage BEYOND hr (an admin), that is
      // preserved rather than thrown away.
      const hrIndex = chain.indexOf('hr');
      let newApprover = hrIndex >= 0 ? 'hr' : (chain[chain.length - 1] ?? 'admin');
      let newStatus = hrIndex > 0 ? (ROLE_STATUS[chain[hrIndex - 1]] ?? 'pending') : 'pending';

      if (humanActions.length) {
        const lastRole = humanActions[0].approver_role as string;
        const idx = chain.indexOf(lastRole);
        // Only honour a human action that is at or past HR; anything below is
        // superseded by parking the request on HR.
        if (idx >= 0 && hrIndex >= 0 && idx >= hrIndex) {
          newStatus = ROLE_STATUS[lastRole] ?? newStatus;
          newApprover = chain[idx + 1] ?? lastRole;
        }
      }

      console.log(
        `  #${t.id} ${t.employee} (${t.company ?? '-'}) ${t.start_date}→${t.end_date} ${t.days}d\n` +
        `        ${t.status} / no approver   ->   ${newStatus} / ${newApprover}`,
      );

      if (APPLY) {
        await client.query(
          `UPDATE leave_requests
              SET status = $1, current_approver_role = $2,
                  approved_by = NULL, approved_at = NULL,
                  escalated = FALSE, last_action_at = NOW(), last_reminder_at = NULL
            WHERE id = $3`,
          [newStatus, newApprover, t.id],
        );

        await client.query(
          `UPDATE leave_approvals
              SET notes = 'CORRETTO (' || TO_CHAR(NOW(),'YYYY-MM-DD') || '): la richiesta era stata approvata automaticamente per inattività. Riportata in attesa di decisione umana. Nota originale: ' || COALESCE(notes,'')
            WHERE leave_request_id = $1
              AND approver_role = 'system'
              AND notes ILIKE '%auto-approved%'`,
          [t.id],
        );
      }
    }

    if (skipped.length) {
      console.log('\nSKIPPED (leave period already elapsed — needs a business decision, not a data fix):');
      for (const t of skipped) {
        console.log(`  #${t.id} ${t.employee} (${t.company ?? '-'}) ${t.start_date}→${t.end_date} ${t.days}d — status ${t.status}`);
      }
      console.log('  Decide per request: ratify it (a manager approves properly, balance is deducted)');
      console.log('  or reopen it. Re-run with --include-elapsed once decided.');
    }

    if (APPLY) {
      await client.query('COMMIT');
      console.log(`\nApplied: ${actionable.length} request(s) returned to a human approver.`);
    } else {
      console.log(`\nDry run: ${actionable.length} request(s) would be changed, ${skipped.length} skipped.`);
      console.log('Re-run with --apply to write these changes.');
    }
    console.log('');
  } catch (err) {
    if (APPLY) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Repair failed:', err);
  process.exit(1);
});
