-- ---------------------------------------------------------------------------
-- 134. Remember which invoice an in-flight license upgrade is waiting on.
--
--      Licenses are granted by the paid-invoice webhook. If that webhook is
--      missed — the local tunnel was not running, the provider retried late,
--      the server was restarting — the upgrade would wait forever with no way
--      to recover. Storing the invoice id lets the system ask the provider
--      directly whether it was paid, and settle the upgrade either way.
-- ---------------------------------------------------------------------------

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS requested_invoice_id VARCHAR(255);
