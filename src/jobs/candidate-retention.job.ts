import fs from 'fs/promises';
import path from 'path';
import { query, queryOne } from '../config/database';

/**
 * GDPR candidate data retention sweep.
 *
 * The public privacy notice states candidate data is kept for a maximum of
 * 24 months from the last contact, after which it is "eliminato o reso anonimo".
 * This job enforces the anonymisation branch of that promise.
 *
 * Anonymise rather than delete: the application row is kept (so recruiting
 * funnel analytics and audit history stay intact) while every piece of personal
 * data is destroyed — which is what Art. 4(5) / Recital 26 require to take the
 * record out of scope. A hard DELETE would silently rewrite historical hiring
 * statistics the client reports on.
 *
 * Disabled per company by default; see candidate_retention_settings.
 */

const CV_DIR = process.env.PUBLIC_CV_UPLOAD_DIR
  ?? path.join(process.cwd(), 'uploads', 'public-cv');

const ANONYMISED_NAME = 'Candidato anonimizzato';

export interface RetentionSettings {
  enabled: boolean;
  retentionMonths: number;
  includeHired: boolean;
}

export interface RetentionCandidate {
  id: number;
  full_name: string;
  last_contact: string;
  cv_path: string | null;
  resume_path: string | null;
}

export interface RetentionResult {
  companyId: number;
  eligible: number;
  anonymized: number;
  filesDeleted: number;
  dryRun: boolean;
  candidates: RetentionCandidate[];
}

async function getSettings(companyId: number): Promise<RetentionSettings | null> {
  const row = await queryOne<{
    enabled: boolean;
    retention_months: number;
    include_hired: boolean;
  }>(
    `SELECT enabled, retention_months, include_hired
       FROM candidate_retention_settings
      WHERE company_id = $1`,
    [companyId],
  );

  // No row means the company has never opted in — treat as disabled.
  if (!row) return null;

  return {
    enabled: row.enabled,
    retentionMonths: row.retention_months,
    includeHired: row.include_hired,
  };
}

/**
 * Candidates whose last contact is older than the retention window.
 *
 * "Last contact" is the most recent of applied_at / last_stage_change /
 * created_at — a candidate moved through a stage last month has been contacted
 * recently even if they applied three years ago, so the clock restarts.
 */
async function findEligible(
  companyId: number,
  settings: RetentionSettings,
): Promise<RetentionCandidate[]> {
  const statusFilter = settings.includeHired ? '' : `AND status <> 'hired'`;

  return query<RetentionCandidate>(
    `SELECT id,
            full_name,
            GREATEST(
              COALESCE(applied_at,        created_at),
              COALESCE(last_stage_change, created_at),
              created_at
            ) AS last_contact,
            cv_path,
            resume_path
       FROM candidates
      WHERE company_id = $1
        AND anonymized_at IS NULL
        ${statusFilter}
        AND GREATEST(
              COALESCE(applied_at,        created_at),
              COALESCE(last_stage_change, created_at),
              created_at
            ) < NOW() - ($2 || ' months')::INTERVAL
      ORDER BY last_contact ASC`,
    [companyId, String(settings.retentionMonths)],
  );
}

/**
 * Removes the CV/resume file from disk. The uploaded document is itself personal
 * data, so nulling the DB column alone would not satisfy erasure.
 *
 * Path traversal is guarded because these values are persisted strings rather
 * than trusted constants. Failures are logged and swallowed: a missing file must
 * not stop the row from being anonymised.
 */
async function deleteCvFile(storedPath: string | null): Promise<boolean> {
  if (!storedPath || storedPath.trim() === '') return false;

  const fileName = path.basename(storedPath.trim());
  if (!fileName || fileName === '.' || fileName === '..') return false;

  const target = path.resolve(CV_DIR, fileName);
  if (!target.startsWith(path.resolve(CV_DIR) + path.sep)) {
    console.warn(`[candidate-retention] refusing to delete outside CV dir: ${storedPath}`);
    return false;
  }

  try {
    await fs.unlink(target);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== 'ENOENT') {
      console.warn(`[candidate-retention] could not delete ${fileName}:`, err);
    }
    return false;
  }
}

/**
 * @param dryRun when true, reports what would be anonymised and changes nothing.
 */
export async function runCandidateRetentionJob(
  companyId: number,
  dryRun = false,
): Promise<RetentionResult> {
  const empty: RetentionResult = {
    companyId,
    eligible: 0,
    anonymized: 0,
    filesDeleted: 0,
    dryRun,
    candidates: [],
  };

  const settings = await getSettings(companyId);
  if (!settings) return empty;

  // A dry run is a read-only preview, so it is allowed while disabled —
  // that is how the client inspects the impact before switching it on.
  if (!settings.enabled && !dryRun) return empty;

  const eligible = await findEligible(companyId, settings);
  if (eligible.length === 0) {
    if (!dryRun) {
      await query(
        `UPDATE candidate_retention_settings
            SET last_run_at = NOW(), last_run_count = 0, updated_at = NOW()
          WHERE company_id = $1`,
        [companyId],
      );
    }
    return { ...empty, candidates: [] };
  }

  if (dryRun) {
    return {
      companyId,
      eligible: eligible.length,
      anonymized: 0,
      filesDeleted: 0,
      dryRun: true,
      candidates: eligible,
    };
  }

  const ids = eligible.map((c) => c.id);

  await query(
    `UPDATE candidates
        SET full_name      = $2,
            email          = NULL,
            phone          = NULL,
            cv_path        = NULL,
            resume_path    = NULL,
            linkedin_url   = NULL,
            cover_letter   = NULL,
            tags           = '{}',
            unread         = FALSE,
            anonymized_at  = NOW(),
            updated_at     = NOW()
      WHERE id = ANY($1::int[])`,
    [ids, ANONYMISED_NAME],
  );

  let filesDeleted = 0;
  for (const candidate of eligible) {
    if (await deleteCvFile(candidate.cv_path)) filesDeleted++;
    if (candidate.resume_path && candidate.resume_path !== candidate.cv_path) {
      if (await deleteCvFile(candidate.resume_path)) filesDeleted++;
    }
  }

  // One audit entry per candidate so the erasure is individually evidenced —
  // a regulator asking "when was this person's data removed?" needs a per-record
  // answer, not a batch total. user_id is NULL: the actor is the platform.
  for (const candidate of eligible) {
    await query(
      `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, old_data, new_data)
       VALUES ($1, NULL, 'GDPR_ANONYMIZE', 'candidate', $2, $3, $4)`,
      [
        companyId,
        candidate.id,
        JSON.stringify({ last_contact: candidate.last_contact, had_cv: Boolean(candidate.cv_path || candidate.resume_path) }),
        JSON.stringify({ retention_months: settings.retentionMonths, anonymized: true }),
      ],
    );
  }

  await query(
    `UPDATE candidate_retention_settings
        SET last_run_at = NOW(), last_run_count = $2, updated_at = NOW()
      WHERE company_id = $1`,
    [companyId, eligible.length],
  );

  console.log(
    `[candidate-retention] company ${companyId}: anonymised ${eligible.length} candidate(s), removed ${filesDeleted} file(s)`,
  );

  return {
    companyId,
    eligible: eligible.length,
    anonymized: eligible.length,
    filesDeleted,
    dryRun: false,
    candidates: eligible,
  };
}

/**
 * Runs the sweep for every active company that has opted in.
 * Not routed through the scheduler's runForAllCompanies helper on purpose:
 * that helper defaults to enabled when a company has no automation_settings
 * row, which would make an irreversible job opt-out instead of opt-in.
 */
export async function runCandidateRetentionForAllCompanies(): Promise<void> {
  const companies = await query<{ id: number }>(
    `SELECT c.id
       FROM companies c
       JOIN candidate_retention_settings s ON s.company_id = c.id
      WHERE c.is_active = TRUE
        AND s.enabled = TRUE
      ORDER BY c.id`,
    [],
  );

  for (const { id } of companies) {
    try {
      await runCandidateRetentionJob(id);
    } catch (err) {
      console.error(`[candidate-retention] failed for company ${id}:`, err);
    }
  }
}
