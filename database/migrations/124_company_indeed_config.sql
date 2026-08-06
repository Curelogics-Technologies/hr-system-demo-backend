-- Migration 124: per-company Indeed Apply credentials.
--
-- Until now the Indeed Apply API token (emitted into the XML feed) and the HMAC
-- secret (used to verify incoming application webhooks) were resolved only from
-- environment variables — so only a developer with server access could set them.
--
-- In the direct-employer model each company registers with Indeed on its own and
-- receives its own token + secret. This table lets each company's Admin/HR store
-- those credentials themselves. Values are stored ENCRYPTED at rest (AES-256-GCM,
-- see utils/secretCrypto.ts) — never in plaintext.
--
-- One row per company; if no row exists (or a field is null) the resolver falls
-- back to the environment variable, then fails closed. Fully re-runnable.

CREATE TABLE IF NOT EXISTS company_indeed_configs (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  api_token_enc  TEXT,               -- encrypted Indeed Apply API token (feed)
  secret_enc     TEXT,               -- encrypted Indeed Apply HMAC secret (webhook)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_indeed_configs_company_id
  ON company_indeed_configs (company_id);
