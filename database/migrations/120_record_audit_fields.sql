-- Migration 120: creation / modification audit fields
--
-- Stores, employees and terminal registrations recorded who created or last
-- changed them nowhere: `users` carried created_at/updated_at but no actor,
-- `stores` carried only created_at, and the create/update paths wrote no
-- audit_logs rows. That left no way to answer "when was this set up, and by
-- whom?" during support work.
--
-- All columns are nullable with no backfill: rows that predate this migration
-- genuinely have no known actor, and inventing one would be worse than showing
-- nothing. The UI renders those as "—".

-- ---------------------------------------------------------------------------
-- users (employees + terminal accounts)
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_created_by ON users(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_updated_by ON users(updated_by) WHERE updated_by IS NOT NULL;

-- ---------------------------------------------------------------------------
-- stores
-- ---------------------------------------------------------------------------
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Seed updated_at from created_at so ordering/formatting has something sane to
-- work with for pre-existing rows.
UPDATE stores SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE stores ALTER COLUMN updated_at SET DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_stores_created_by ON stores(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stores_updated_by ON stores(updated_by) WHERE updated_by IS NOT NULL;
