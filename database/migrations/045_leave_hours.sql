-- =============================================================================
-- Migration 045: Add hours column for partial-day leave requests
-- =============================================================================

BEGIN;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS hours SMALLINT DEFAULT NULL;

-- hours must be between 1 and 7 when specified (8 hours = full day)
-- Dropped first: migrate() re-runs every migration whose migration_history row
-- is missing, so a bare ADD CONSTRAINT here aborts boot on any restored or
-- re-pointed database where the column already carries the constraint.
ALTER TABLE leave_requests
  DROP CONSTRAINT IF EXISTS chk_leave_hours;

ALTER TABLE leave_requests
  ADD CONSTRAINT chk_leave_hours CHECK (hours IS NULL OR (hours >= 1 AND hours <= 7));

COMMIT;
