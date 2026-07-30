-- Migration 122: GDPR candidate data retention (Art. 5(1)(e) storage limitation)
--
-- The public privacy notice promises candidate data is erased or anonymised after
-- a maximum of 24 months. This adds the state + per-company policy needed to
-- enforce that automatically instead of relying on manual deletion.

-- Marks a candidate row as already anonymised so the job never reprocesses it,
-- and so the UI can explain why a record has no personal data.
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_candidates_retention_sweep
  ON candidates (company_id, anonymized_at, last_stage_change);

-- Per-company retention policy. Deliberately NOT stored in automation_settings:
-- that table defaults missing rows to enabled, which is unsafe for an
-- irreversible job. Absence of a row here means "disabled".
CREATE TABLE IF NOT EXISTS candidate_retention_settings (
  company_id        INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  retention_months  INTEGER NOT NULL DEFAULT 24 CHECK (retention_months BETWEEN 1 AND 120),
  -- Hired candidates are retained under the employment relationship, not the
  -- recruitment basis, so they are excluded from the sweep by default.
  include_hired     BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at       TIMESTAMPTZ,
  last_run_count    INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a disabled row for every existing company so the setting is visible in
-- the admin UI without the client having to create it first.
INSERT INTO candidate_retention_settings (company_id, enabled, retention_months)
SELECT id, FALSE, 24 FROM companies
ON CONFLICT (company_id) DO NOTHING;
