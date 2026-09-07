-- ---------------------------------------------------------------------------
-- 139. Tax on the billed total, and one notice per failed renewal.
--
--      Two unrelated facts, both belonging to the money the platform collects:
--
--      1. A subscription is now charged with a fixed tax rate on top of the
--         licence prices. The provider owns the calculation - Stripe applies
--         the tax rate attached to the subscription, PayPal the percentage on
--         the plan - so what is stored here is only the split the provider
--         reported, kept beside the total so a receipt can show subtotal, tax
--         and total without asking the provider again. Nullable throughout:
--         payments taken before tax existed have no split, and inventing one
--         would misstate what the customer actually paid.
--
--      2. A failed renewal opens a grace period, and the owner is emailed the
--         date by which it must be settled. Providers retry a failed invoice
--         for days and send a webhook for every attempt, so the stamp below
--         records that the notice went out and stops the same three-day
--         warning being mailed over and over. It is cleared whenever the
--         subscription is paid, so the next failure notifies again.
-- ---------------------------------------------------------------------------

ALTER TABLE billing_transactions
  -- What the licences cost before tax, and the tax charged on them. Their sum
  -- is amount_cents whenever both are present.
  ADD COLUMN IF NOT EXISTS subtotal_cents INTEGER,
  ADD COLUMN IF NOT EXISTS tax_cents      INTEGER,
  -- The rate in force at the moment of payment. Stored per row because a rate
  -- change must not rewrite the history of what was already charged.
  ADD COLUMN IF NOT EXISTS tax_percent    NUMERIC(5, 2);

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS payment_failed_notified_at TIMESTAMPTZ;
