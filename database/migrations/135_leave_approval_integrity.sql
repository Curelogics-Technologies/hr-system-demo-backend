-- Migration 135: Leave approval integrity
--
-- Background: processEscalationLogic() used to advance `status` as well as the
-- approver role, so a request nobody opened for two days was granted by the
-- hourly job — with no balance deduction and no notification. This migration
-- adds the audit columns the approval path was missing and a trigger that makes
-- a repeat structurally impossible, whatever the calling code does.
--
-- Safe to run against production: every statement is idempotent and no row is
-- deleted or re-stated. Requests already damaged are REPORTED, not silently
-- rewritten — see scripts/diagnose-leave-integrity.ts and the NOTICE below.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Audit columns
-- ---------------------------------------------------------------------------
-- approved_by is the person who granted the leave. It is the marker the trigger
-- keys off: no human, no approval. last_reminder_at throttles the solicitation
-- the escalation job now sends instead of approving.
ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS approved_by       INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reminder_at  TIMESTAMPTZ;

COMMENT ON COLUMN leave_requests.approved_by IS
  'User who granted the leave. NULL on a fully-approved request means the row was never approved by a person.';
COMMENT ON COLUMN leave_requests.last_reminder_at IS
  'Last time the escalation job solicited the current approver. Throttles reminders; NOT an approval action.';

-- ---------------------------------------------------------------------------
-- 2. Helper: is this status a *terminal* approval?
-- ---------------------------------------------------------------------------
-- The approval chain is company-configurable, so the terminal status varies
-- ('approved' when the chain ends at admin, 'HR approved' when it ends at hr,
-- and so on). Rather than enumerate them, we use the invariant that holds for
-- every chain: a request with no further approver that was not refused or
-- withdrawn is granted.
CREATE OR REPLACE FUNCTION leave_status_is_terminal_approval(p_status TEXT, p_approver TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_approver IS NULL
     AND p_status NOT IN (
       'pending',
       'rejected', 'cancelled',
       'store manager rejected', 'area manager rejected', 'HR rejected'
     );
$$;

-- ---------------------------------------------------------------------------
-- 3. Backfill approved_by for legitimately approved historical requests
-- ---------------------------------------------------------------------------
-- Takes the most recent human 'approved' action. Rows with no human action are
-- deliberately left NULL: that NULL is the evidence of the defect and the
-- diagnose script reports on it.
UPDATE leave_requests lr
SET approved_by = la.approver_id,
    approved_at = la.created_at
FROM (
  SELECT DISTINCT ON (leave_request_id)
         leave_request_id, approver_id, created_at
  FROM leave_approvals
  WHERE action = 'approved'
    AND approver_id IS NOT NULL
  ORDER BY leave_request_id, created_at DESC
) la
WHERE la.leave_request_id = lr.id
  AND lr.approved_by IS NULL
  AND leave_status_is_terminal_approval(lr.status, lr.current_approver_role);

-- ---------------------------------------------------------------------------
-- 4. Report what is still broken (does not modify anything)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_orphans INTEGER;
  v_ids     TEXT;
BEGIN
  SELECT COUNT(*), COALESCE(STRING_AGG(id::text, ', ' ORDER BY id), '-')
    INTO v_orphans, v_ids
  FROM leave_requests
  WHERE approved_by IS NULL
    AND leave_status_is_terminal_approval(status, current_approver_role);

  IF v_orphans > 0 THEN
    RAISE WARNING
      '[135] % leave request(s) are fully approved with NO human approver: %. These were granted by the escalation job. Run: npm run diagnose:leave -- --json',
      v_orphans, v_ids;
  ELSE
    RAISE NOTICE '[135] No auto-approved leave requests found. Clean.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. The guard
-- ---------------------------------------------------------------------------
-- Fires only on the *transition* into a terminal approval, never on the state.
-- That keeps unrelated updates to already-damaged historical rows (archiving,
-- note edits) working, while blocking any new approval that has no person
-- behind it — including a direct UPDATE from psql.
CREATE OR REPLACE FUNCTION leave_requests_require_human_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT leave_status_is_terminal_approval(NEW.status, NEW.current_approver_role) THEN
    RETURN NEW;
  END IF;

  -- Only police the moment the request becomes approved.
  IF TG_OP = 'UPDATE'
     AND NOT (OLD.status IS DISTINCT FROM NEW.status
              OR OLD.current_approver_role IS DISTINCT FROM NEW.current_approver_role) THEN
    RETURN NEW;
  END IF;

  IF NEW.approved_by IS NULL THEN
    RAISE EXCEPTION
      'Leave request % cannot reach status "%" without an approving user (approved_by is NULL). Automated escalation must never approve a request.',
      COALESCE(NEW.id, -1), NEW.status
      USING ERRCODE = 'check_violation',
            HINT = 'Approve through PUT /api/leave/:id/approve, which deducts the balance and notifies the employee.';
  END IF;

  IF NEW.approved_at IS NULL THEN
    NEW.approved_at := NOW();
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_leave_requests_require_human_approval ON leave_requests;
CREATE TRIGGER trg_leave_requests_require_human_approval
  BEFORE INSERT OR UPDATE ON leave_requests
  FOR EACH ROW
  EXECUTE FUNCTION leave_requests_require_human_approval();

CREATE INDEX IF NOT EXISTS idx_leave_requests_stale_approval
  ON leave_requests (company_id, last_action_at)
  WHERE current_approver_role IS NOT NULL;

COMMIT;
