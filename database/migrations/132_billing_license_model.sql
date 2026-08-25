-- ---------------------------------------------------------------------------
-- 132. License-based billing.
--
--      The billed quantities are no longer derived from how many users happen
--      to exist. The company admin buys a number of employee and terminal
--      licenses; seat_quantity / device_quantity on the subscription ARE that
--      purchased allowance, and creating a user beyond it is refused until
--      more licenses are paid for.
--
--      requested_* holds an increase the admin has asked for but the provider
--      has not confirmed payment on yet. It is applied to the licensed columns
--      only when the paid-invoice webhook arrives, so an unpaid or failed
--      upgrade never widens the allowance.
-- ---------------------------------------------------------------------------

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS requested_seat_quantity   INTEGER,
  ADD COLUMN IF NOT EXISTS requested_device_quantity INTEGER,
  ADD COLUMN IF NOT EXISTS requested_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requested_amount_cents    INTEGER;
