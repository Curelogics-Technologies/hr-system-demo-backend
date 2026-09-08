-- ---------------------------------------------------------------------------
-- 142. A mailbox that belongs to the platform, not to a customer.
--
--      Until now every email this system sent went through the SMTP server of
--      the company it concerned. That is right for a company's own mail - a
--      leave approval, a shift change - but wrong for the platform's own:
--      "your subscription payment failed" is VeylOHR writing to its customer,
--      and routing it through that customer's mail server means the warning
--      dies exactly when the customer's own configuration is missing or wrong.
--      It also cannot deliver the operator copy at all, because that address
--      belongs to neither party.
--
--      One row, always id = 1. `billing_alert_email` lives here rather than in
--      the environment so the operator can change where the copies go without
--      a redeploy.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform_smtp_config (
  id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  smtp_host           TEXT    NOT NULL DEFAULT '',
  smtp_port           INTEGER NOT NULL DEFAULT 587,
  smtp_user           TEXT    NOT NULL DEFAULT '',
  smtp_pass           TEXT    NOT NULL DEFAULT '',
  -- The From: the customer sees, e.g. "VeylOHR <billing@veylo.it>".
  smtp_from           TEXT    NOT NULL DEFAULT '',
  -- Where the operator wants a copy of every failed payment. Comma-separated.
  billing_alert_email TEXT    NOT NULL DEFAULT '',
  -- Set by the Verify button, so the page can say the credentials were proved
  -- to work rather than merely proved to be present.
  verified_at         TIMESTAMPTZ,
  last_error          TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the single row so every later write is a plain UPDATE.
INSERT INTO platform_smtp_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Which mailbox actually carried the warning. Belongs with this change because
-- it only becomes a question once there are two possible transports: the
-- platform's own mailbox, or a fallback through the customer's SMTP server.
-- Shown on the billing page so "it was sent" is never ambiguous about by whom.
ALTER TABLE billing_transactions
  ADD COLUMN IF NOT EXISTS notice_email_transport VARCHAR(16);
