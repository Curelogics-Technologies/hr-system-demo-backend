-- ---------------------------------------------------------------------------
-- 138. Give a receipt enough detail to stand on its own.
--
--      A receipt has to make sense years later, when the subscription behind it
--      may have been repriced, cancelled or recreated. Reading the period and
--      the payment method off the live subscription would therefore show the
--      wrong thing for an old payment, so both are recorded on the transaction
--      as it happens.
--
--      Every column is nullable: rows written before this migration cannot have
--      these facts, and inventing them would be worse than leaving the line off
--      the receipt.
-- ---------------------------------------------------------------------------

ALTER TABLE billing_transactions
  -- The billing period this payment covers, not when the row was written.
  ADD COLUMN IF NOT EXISTS period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS period_end   TIMESTAMPTZ,
  -- The card as it was at the moment of payment: "visa", "mastercard", and the
  -- last four digits. Kept as plain text because it is a label, not an
  -- identifier, and nothing is ever looked up by it.
  ADD COLUMN IF NOT EXISTS payment_method_brand  VARCHAR(40),
  ADD COLUMN IF NOT EXISTS payment_method_last4  VARCHAR(4);

-- Backfill what can be known safely: a paid transaction whose subscription
-- still has the period it was charged for. Only rows that have no period yet
-- are touched, and only where the payment falls inside the stored period, so a
-- renewal is never labelled with a later cycle than the one it paid for.
UPDATE billing_transactions t
   SET period_start = s.current_period_start,
       period_end   = s.current_period_end
  FROM subscriptions s
 WHERE t.subscription_id = s.id
   AND t.period_start IS NULL
   AND s.current_period_start IS NOT NULL
   AND s.current_period_end   IS NOT NULL
   AND t.paid_at IS NOT NULL
   AND t.paid_at >= s.current_period_start
   AND t.paid_at <= s.current_period_end;
