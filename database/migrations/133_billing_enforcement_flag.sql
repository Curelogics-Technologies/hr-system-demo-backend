-- ---------------------------------------------------------------------------
-- 133. Per-company billing enforcement switch.
--
--      Turning the license model on globally would lock every existing company
--      out of the platform the moment this deploys, because none of them has a
--      subscription yet. Enforcement is therefore opt-in per company: existing
--      companies keep working untouched, and the system administrator switches
--      each one on when it is ready to be billed.
--
--      Default is FALSE so the deploy itself changes nothing for anyone.
-- ---------------------------------------------------------------------------

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS billing_enforced BOOLEAN NOT NULL DEFAULT false;

-- A company that already paid is, by definition, already on the new model.
UPDATE companies c
   SET billing_enforced = true
 WHERE EXISTS (
   SELECT 1 FROM subscriptions s
    WHERE s.company_id = c.id
      AND s.status IN ('active', 'past_due')
 );
