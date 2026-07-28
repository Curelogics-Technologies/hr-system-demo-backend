-- Migration 119: Device identity — company-scoped uniqueness
--
-- Background
-- ----------
-- Device identity used to be derived from a hash of the device's *observable
-- profile*: user-agent, browser name+version, OS name+version, model, locale,
-- timezone, screen geometry, core/memory counts. That value is not unique to a
-- device — two units of the same model configured the same way produce exactly
-- the same hash — and it changes whenever the browser updates.
--
-- Combined with GLOBAL unique constraints, that meant:
--   * a company rolling out identical terminals to several stores could only
--     ever have ONE of them registered; disabling it freed the slot for the next
--   * a browser update silently invalidated a device's own registration
--   * one company's registrations could block an unrelated company's
--
-- The application now identifies a device by a random per-installation id, so
-- the constraints below are re-pointed at that value and scoped to the company.
-- Existing registrations keep working: the client still reports the old profile
-- hash, the API matches on it, and rewrites the row to the new scheme on first
-- contact.

-- ---------------------------------------------------------------------------
-- 1. Drop the profile-hash uniqueness (the direct cause of the collisions)
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS uq_users_registered_device_profile_hash_active;

-- ---------------------------------------------------------------------------
-- 2. Drop the global token / identifier uniqueness
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_registered_device_token;
DROP INDEX IF EXISTS uq_users_registered_device_token_active;
DROP INDEX IF EXISTS uq_users_registered_device_identifier_active;

-- ---------------------------------------------------------------------------
-- 3. Defensive de-duplication inside each company
--
-- The dropped constraints already guaranteed global uniqueness, so this is
-- expected to be a no-op. It is kept so the migration is safe to run against a
-- database whose constraints were dropped or never applied. The OLDEST
-- registration in each group wins, matching what migrations 109/111/112 did.
-- ---------------------------------------------------------------------------
UPDATE users
SET registered_device_token = NULL,
    registered_device_identifier = NULL,
    registered_device_metadata = NULL,
    registered_device_registered_at = NULL
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY company_id, registered_device_token
        ORDER BY registered_device_registered_at ASC NULLS LAST, id ASC
      ) AS rn
    FROM users
    WHERE device_reset_pending = false
      AND company_id IS NOT NULL
      AND registered_device_token IS NOT NULL
  ) dedup
  WHERE rn > 1
);

UPDATE users
SET registered_device_token = NULL,
    registered_device_identifier = NULL,
    registered_device_metadata = NULL,
    registered_device_registered_at = NULL
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY company_id, registered_device_identifier
        ORDER BY registered_device_registered_at ASC NULLS LAST, id ASC
      ) AS rn
    FROM users
    WHERE device_reset_pending = false
      AND company_id IS NOT NULL
      AND registered_device_identifier IS NOT NULL
  ) dedup
  WHERE rn > 1
);

-- ---------------------------------------------------------------------------
-- 4. Company-scoped uniqueness
--
-- Still "one account per device", but only within the organisation that owns
-- the account — which is the rule the product actually needs.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_device_token_per_company
  ON users (company_id, registered_device_token)
  WHERE device_reset_pending = false
    AND company_id IS NOT NULL
    AND registered_device_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_device_identifier_per_company
  ON users (company_id, registered_device_identifier)
  WHERE device_reset_pending = false
    AND company_id IS NOT NULL
    AND registered_device_identifier IS NOT NULL;

-- Lookup path used when matching an incoming device.
CREATE INDEX IF NOT EXISTS idx_users_device_identifier_lookup
  ON users (registered_device_identifier)
  WHERE registered_device_identifier IS NOT NULL;
