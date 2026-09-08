-- ---------------------------------------------------------------------------
-- 141. Record where a failed-payment warning actually went.
--
--      "The customer was emailed" is a claim the platform has to be able to
--      show, not one it should be believed on. When a renewal fails the app
--      writes a failed transaction row; these columns hang the outcome of the
--      warning off that same row, so the billing page can state who was told,
--      when, and whether the mail server accepted it.
--
--      Kept on the transaction rather than the subscription because it
--      describes one failure, and a subscription can fail more than once.
--
--      Status mirrors what the mailer reports: 'sent' - the SMTP server took
--      it; 'skipped' - the company has no SMTP configured, so nothing was
--      attempted; 'failed' - it was attempted and refused. Null means the row
--      predates this, not that nothing was sent.
-- ---------------------------------------------------------------------------

ALTER TABLE billing_transactions
  -- The account owner's warning.
  ADD COLUMN IF NOT EXISTS notice_email_to     TEXT,
  ADD COLUMN IF NOT EXISTS notice_email_status VARCHAR(16),
  ADD COLUMN IF NOT EXISTS notice_email_error  TEXT,
  ADD COLUMN IF NOT EXISTS notice_email_at     TIMESTAMPTZ,
  -- The operator copy (BILLING_ALERT_EMAIL), tracked separately: it can fail
  -- on its own, and a customer who was warned successfully must not be shown
  -- as unwarned because an internal copy bounced.
  ADD COLUMN IF NOT EXISTS notice_copy_to      TEXT,
  ADD COLUMN IF NOT EXISTS notice_copy_status  VARCHAR(16),
  -- How many people got the in-app notification, so the UI can say the alert
  -- was raised even where email is not configured at all.
  ADD COLUMN IF NOT EXISTS notice_in_app_count INTEGER;
