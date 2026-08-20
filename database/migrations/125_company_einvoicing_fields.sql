-- ---------------------------------------------------------------------------
-- 125. Italian e-invoicing fields on companies
--
-- Adds Partita IVA (VAT number), Codice Destinatario SDI and PEC address.
--
-- All three are NULLABLE on purpose: the table already holds live client data
-- and existing rows must keep saving without these values. "Mandatory" is
-- enforced in the application layer only for newly entered values, so no
-- existing record is invalidated by this migration.
--
-- Nullable ADD COLUMN with no DEFAULT is a metadata-only change in Postgres:
-- no table rewrite, no backfill, safe on a live database.
-- ---------------------------------------------------------------------------

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS vat_number         VARCHAR(20),
  ADD COLUMN IF NOT EXISTS sdi_recipient_code VARCHAR(7),
  ADD COLUMN IF NOT EXISTS pec_email          VARCHAR(255);
