import { query, queryOne } from '../config/database';
import { decryptSecret, encryptSecret, maskSecret } from '../utils/secretCrypto';

/**
 * Resolves and manages per-company Indeed Apply credentials.
 *
 * Resolution order for both the API token (feed) and the HMAC secret (webhook):
 *   1. the company's own value stored (encrypted) in company_indeed_configs
 *   2. the environment variable (per-company name, then global)
 *   3. null  → caller fails closed
 */

function envValue(prefix: string, slug: string): string | null {
  const upper = (slug || '').replace(/-/g, '_').toUpperCase();
  const short = (slug || '').split('-')[0].toUpperCase();
  return process.env[`${prefix}_${upper}`]
    || process.env[`${prefix}_${short}`]
    || process.env[prefix]
    || null;
}

interface DbRow {
  api_token_enc: string | null;
  secret_enc: string | null;
}

async function readDbConfig(companyId: number): Promise<DbRow | null> {
  // Fail-safe: a DB/table error here must never break the feed or webhook — it
  // simply degrades to the environment-variable fallback.
  try {
    return await queryOne<DbRow>(
      `SELECT api_token_enc, secret_enc FROM company_indeed_configs WHERE company_id = $1 LIMIT 1`,
      [companyId],
    );
  } catch {
    return null;
  }
}

/** Effective Indeed Apply API token for a company (DB → env → null). */
export async function resolveIndeedApiToken(companyId: number | null | undefined, companySlug: string): Promise<string | null> {
  if (companyId) {
    const decrypted = decryptSecret((await readDbConfig(companyId))?.api_token_enc);
    if (decrypted) return decrypted;
  }
  return envValue('INDEED_APPLY_API_TOKEN', companySlug);
}

/** Effective Indeed Apply HMAC secret for a company (DB → env → null). */
export async function resolveIndeedSecret(companyId: number | null | undefined, companySlug: string): Promise<string | null> {
  if (companyId) {
    const decrypted = decryptSecret((await readDbConfig(companyId))?.secret_enc);
    if (decrypted) return decrypted;
  }
  return envValue('INDEED_APPLY_SECRET', companySlug);
}

/** Same as resolveIndeedSecret but starting from a company slug (webhook URL). */
export async function resolveIndeedSecretBySlug(companySlug: string): Promise<string | null> {
  let companyId: number | null = null;
  try {
    const company = await queryOne<{ id: number }>(`SELECT id FROM companies WHERE slug = $1 LIMIT 1`, [companySlug]);
    companyId = company?.id ?? null;
  } catch {
    companyId = null; // fall back to env resolution by slug
  }
  return resolveIndeedSecret(companyId, companySlug);
}

export interface IndeedConfigStatus {
  apiTokenConfigured: boolean;
  apiTokenMask: string | null;
  apiTokenSource: 'company' | 'environment' | 'none';
  secretConfigured: boolean;
  secretMask: string | null;
  secretSource: 'company' | 'environment' | 'none';
}

/** Masked, browser-safe view of a company's credential configuration. */
export async function getCompanyIndeedStatus(companyId: number, companySlug: string): Promise<IndeedConfigStatus> {
  const row = await readDbConfig(companyId);
  const dbToken = decryptSecret(row?.api_token_enc);
  const dbSecret = decryptSecret(row?.secret_enc);
  const envToken = envValue('INDEED_APPLY_API_TOKEN', companySlug);
  const envSecret = envValue('INDEED_APPLY_SECRET', companySlug);
  return {
    apiTokenConfigured: !!(dbToken || envToken),
    apiTokenMask: dbToken ? maskSecret(dbToken) : (envToken ? '••••(env)' : null),
    apiTokenSource: dbToken ? 'company' : (envToken ? 'environment' : 'none'),
    secretConfigured: !!(dbSecret || envSecret),
    secretMask: dbSecret ? maskSecret(dbSecret) : (envSecret ? '••••(env)' : null),
    secretSource: dbSecret ? 'company' : (envSecret ? 'environment' : 'none'),
  };
}

/**
 * Upserts a company's credentials. Only fields present in `updates` are changed;
 * an explicit empty string clears that field (stored as NULL → falls back to env).
 */
export async function setCompanyIndeedConfig(
  companyId: number,
  updates: { apiToken?: string; secret?: string },
): Promise<void> {
  const setToken = updates.apiToken !== undefined;
  const setSecret = updates.secret !== undefined;
  const tokenEnc = setToken ? (updates.apiToken ? encryptSecret(updates.apiToken) : null) : null;
  const secretEnc = setSecret ? (updates.secret ? encryptSecret(updates.secret) : null) : null;

  await query(
    `INSERT INTO company_indeed_configs (company_id, api_token_enc, secret_enc, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (company_id) DO UPDATE SET
       api_token_enc = CASE WHEN $4 THEN EXCLUDED.api_token_enc ELSE company_indeed_configs.api_token_enc END,
       secret_enc    = CASE WHEN $5 THEN EXCLUDED.secret_enc    ELSE company_indeed_configs.secret_enc END,
       updated_at    = NOW()`,
    [companyId, tokenEnc, secretEnc, setToken, setSecret],
  );
}
