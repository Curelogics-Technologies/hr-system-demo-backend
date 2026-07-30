-- Migration 123: allow 'video' as an interview type.
--
-- The ATS UI offers a "Video Interview" option, but the CHECK constraint added
-- in migration 084 only permits 'phone' and 'in_person'. The API was silently
-- coercing 'video' to 'in_person', so a user's choice was lost without any
-- error. This widens the constraint to match what the interface offers.
--
-- Safety notes:
--   * migrate() runs on every boot and aborts startup if a migration throws,
--     so this must not be able to fail. ADD CONSTRAINT validates existing rows,
--     which would error if any row held an out-of-range value — the UPDATE
--     below normalises those first so validation is guaranteed to pass.
--   * Fully re-runnable: DROP ... IF EXISTS is a no-op when absent, and the
--     UPDATE matches nothing on a second run.

ALTER TABLE interviews
  DROP CONSTRAINT IF EXISTS interviews_interview_type_check;

-- Defensive normalisation. Expected to affect 0 rows on a healthy database;
-- guards against legacy or imported rows holding an unrecognised value.
UPDATE interviews
   SET interview_type = 'in_person'
 WHERE interview_type IS NULL
    OR interview_type NOT IN ('phone', 'in_person', 'video');

ALTER TABLE interviews
  ADD CONSTRAINT interviews_interview_type_check
  CHECK (interview_type IN ('phone', 'in_person', 'video'));
