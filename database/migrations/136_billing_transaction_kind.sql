-- ---------------------------------------------------------------------------
-- 135. Classify each payment so its label can be translated.
--
--      The description used to be an English or Italian sentence written at
--      insert time, which meant the payment history could never follow the
--      language the user selected. Storing what the payment WAS, alongside the
--      quantities already recorded, lets the interface render the wording in
--      whichever language is active. The free-text description is kept for
--      rows written before this change.
-- ---------------------------------------------------------------------------

ALTER TABLE billing_transactions
  ADD COLUMN IF NOT EXISTS kind VARCHAR(30);

-- Backfill from the sentences the old code wrote.
UPDATE billing_transactions
   SET kind = CASE
     WHEN description ILIKE 'Initial activation%'   THEN 'activation'
     WHEN description ILIKE 'Licenze aggiuntive%'   THEN 'license_upgrade'
     WHEN description ILIKE 'Additional licenses%'  THEN 'license_upgrade'
     WHEN description ILIKE 'Monthly payment%'      THEN 'renewal'
     WHEN description ILIKE 'Rinnovo mensile%'      THEN 'renewal'
     WHEN status = 'failed'                         THEN 'failed'
     ELSE 'renewal'
   END
 WHERE kind IS NULL;
