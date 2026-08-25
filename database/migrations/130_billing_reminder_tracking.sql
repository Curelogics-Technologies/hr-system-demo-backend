-- ---------------------------------------------------------------------------
-- 130. Track the last renewal reminder so the daily job sends it only once
--      per billing period instead of once per day inside the reminder window.
-- ---------------------------------------------------------------------------

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
