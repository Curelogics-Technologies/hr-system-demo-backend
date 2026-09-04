import { Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sanitizeHtml from 'sanitize-html';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, created, badRequest, forbidden, notFound } from '../../utils/response';
import { buildSalaryText, canonicalizeSalaryPeriod } from '../../utils/salaryPeriod';
import { resolveIndeedApiToken } from '../../services/indeedCredentials.service';
import { safeDisplayTimezone } from '../../utils/shiftTimezone';
import { sendEmailForCompany } from '../../services/email.service';
import { query, queryOne } from '../../config/database';
import { runCandidateRetentionJob } from '../../jobs/candidate-retention.job';

/**
 * Interview types accepted by the API. Must stay in step with the
 * interviews_interview_type_check constraint (migration 123) — an unknown value
 * here would be coerced silently, which previously turned a user's "Video"
 * choice into "In-Person" without any error.
 */
const INTERVIEW_TYPES = ['phone', 'in_person', 'video'] as const;
type InterviewTypeValue = (typeof INTERVIEW_TYPES)[number];

function isInterviewType(value: unknown): value is InterviewTypeValue {
  return typeof value === 'string' && (INTERVIEW_TYPES as readonly string[]).includes(value);
}
import {
  listJobs, getJob, createJob, updateJob, deleteJob,
  publishJobToIndeed, syncIndeedApplications,
  listCandidates, getCandidate, createCandidate,
  updateCandidateStage, markCandidateRead, deleteCandidate,
  listInterviews, listAllInterviews, createInterview, updateInterview, deleteInterview,
  listCandidateComments, addCandidateComment, deleteCandidateComment,
  listInterviewFeedbackComments, addInterviewFeedbackComment, deleteInterviewFeedbackComment,
  listAllInterviewFeedbackComments,
  listInterviewNotificationLogs, createInterviewNotificationLog, updateInterviewNotificationLog,
  getPublishedJobsForFeed,
  CandidateStatus,
  JobLanguage,
  JobType,
  RemoteType,
  getIndeedStats,
} from './ats.service';
import { getHRAlerts } from './ats.alerts.service';
import { evaluateAllJobRisks } from './ats.risk.service';
import { generateICSEvent } from './ics.service';
import { sendNotification } from '../notifications/notifications.service';
import { t } from '../../utils/i18n';
import { emitToCompany } from '../../config/socket';
import { resolveAllowedCompanyIds, resolveCompanyGroupId } from '../../utils/companyScope';
import { resolveItalianProvince } from '../../utils/italianProvinces';
// Store managers only see their own store; other roles see everything
function resolveStoreIds(user: Express.Request['user']): number[] | undefined {
  if (!user) return undefined;
  if (user.role === 'store_manager' && user.storeId) return [user.storeId];
  return undefined;
}

async function isNotificationEnabledForRole(
  companyId: number,
  eventKey: string,
  role?: string | null,
): Promise<boolean> {
  const setting = await queryOne<{ enabled: boolean; roles: string[] }>(
    `SELECT enabled, roles
     FROM notification_settings
     WHERE company_id = $1 AND event_key = $2
     LIMIT 1`,
    [companyId, eventKey],
  );

  if (!setting) return true;
  if (!setting.enabled) return false;
  if (role && Array.isArray(setting.roles) && setting.roles.length > 0) {
    return setting.roles.includes(role);
  }
  return true;
}

async function isSmtpConfigured(companyId: number): Promise<boolean> {
  const row = await queryOne<{ smtp_host: string | null; smtp_user: string | null; smtp_pass: string | null }>(
    `SELECT smtp_host, smtp_user, smtp_pass
     FROM company_smtp_configs
     WHERE company_id = $1
     LIMIT 1`,
    [companyId],
  );
  return Boolean(row?.smtp_host && row?.smtp_user && row?.smtp_pass);
}

const VALID_JOB_STATUSES = new Set(['draft', 'published', 'closed']);

type PgLikeError = {
  code?: string;
  constraint?: string;
};

async function validateAtsStore(storeId: number, companyId: number): Promise<string | null> {
  const store = await queryOne<{ id: number; is_active: boolean }>(
    `SELECT id, is_active FROM stores WHERE id = $1 AND company_id = $2`,
    [storeId, companyId],
  );

  if (!store) {
    return 'Il punto vendita specificato non esiste in questa azienda';
  }
  if (!store.is_active) {
    return 'Il punto vendita specificato non è attivo';
  }
  return null;
}

function handleJobPersistenceError(res: Response, err: unknown): boolean {
  const pgErr = err as PgLikeError;

  if (pgErr?.code === '23503') {
    if ((pgErr.constraint ?? '').includes('store_id')) {
      badRequest(res, 'Il punto vendita specificato non esiste in questa azienda', 'INVALID_STORE');
      return true;
    }
  }

  if (pgErr?.code === '23514') {
    if (pgErr.constraint === 'job_postings_salary_range_chk') {
      badRequest(res, 'Salary min deve essere <= salary max', 'VALIDATION_ERROR');
      return true;
    }
    if (pgErr.constraint === 'job_postings_salary_period_chk') {
      badRequest(res, "Salary period non valido. Usa: per anno, al mese, all'ora, a settimana", 'VALIDATION_ERROR');
      return true;
    }
    if (pgErr.constraint === 'job_postings_language_chk') {
      badRequest(res, 'La lingua annuncio deve essere it, en oppure both', 'VALIDATION_ERROR');
      return true;
    }
    if (pgErr.constraint === 'job_postings_job_type_chk') {
      badRequest(res, 'Il tipo contratto deve essere fulltime, parttime, contract o internship', 'VALIDATION_ERROR');
      return true;
    }
    if (pgErr.constraint === 'job_postings_remote_type_chk') {
      badRequest(res, 'Remote type non valido (onsite, hybrid, remote)', 'VALIDATION_ERROR');
      return true;
    }
    if ((pgErr.constraint ?? '').includes('job_postings') && (pgErr.constraint ?? '').includes('status')) {
      badRequest(res, 'Lo stato deve essere draft, published o closed', 'VALIDATION_ERROR');
      return true;
    }
  }

  return false;
}

async function resolveAtsCompanyId(req: Request): Promise<number | null> {
  if (!req.user) return null;

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user);
  const explicit = req.body?.company_id ?? req.body?.target_company_id ?? req.query?.company_id ?? req.query?.target_company_id;

  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const parsed = Number.parseInt(String(explicit), 10);
    if (Number.isNaN(parsed)) return null;
    return allowedCompanyIds.includes(parsed) ? parsed : null;
  }

  if (req.user.companyId && allowedCompanyIds.includes(req.user.companyId)) {
    return req.user.companyId;
  }

  if (allowedCompanyIds.length === 1) {
    return allowedCompanyIds[0];
  }

  return null;
}

function resolveAtsCompanyScope(req: Request, allowedCompanyIds: number[]): number[] | null {
  const explicit =
    req.query.company_id
    ?? req.query.companyId
    ?? req.query.target_company_id
    ?? req.query.targetCompanyId;
  const explicitValue = Array.isArray(explicit) ? explicit[0] : explicit;

  if (explicitValue !== undefined && explicitValue !== null && String(explicitValue).trim() !== '') {
    const parsed = Number.parseInt(String(explicitValue), 10);
    if (Number.isNaN(parsed) || !allowedCompanyIds.includes(parsed)) {
      return null;
    }
    return [parsed];
  }

  return [...allowedCompanyIds];
}

// ---------------------------------------------------------------------------
// Job Postings
// ---------------------------------------------------------------------------

export const listJobsHandler = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  let scopedCompanyIds = [...allowedCompanyIds];
  const explicitCompanyId = typeof req.query.company_id === 'string'
    ? Number.parseInt(req.query.company_id, 10)
    : null;

  if (explicitCompanyId !== null && !Number.isNaN(explicitCompanyId)) {
    if (!allowedCompanyIds.includes(explicitCompanyId)) {
      forbidden(res, 'Nessuna azienda valida selezionata');
      return;
    }
    scopedCompanyIds = [explicitCompanyId];
  }

  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const storeIds = resolveStoreIds(req.user);

  const jobs = await listJobs(scopedCompanyIds, { status, storeIds });
  ok(res, { jobs });
});

export const getJobHandler = asyncHandler(async (req: Request, res: Response) => {
  const companyId = await resolveAtsCompanyId(req);
  if (!companyId) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  const job = await getJob(id, companyId);
  if (!job) { notFound(res, 'Annuncio non trovato'); return; }
  ok(res, { job });
});

export const getJobComplianceHandler = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  // Check if there is an explicit, valid company ID requested.
  const explicit = req.body?.company_id ?? req.body?.target_company_id ?? req.query?.company_id ?? req.query?.target_company_id;
  let companyIdsToSearch = allowedCompanyIds;

  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const parsed = Number.parseInt(String(explicit), 10);
    if (!Number.isNaN(parsed) && allowedCompanyIds.includes(parsed)) {
      companyIdsToSearch = [parsed];
    }
  }

  const { identifier } = req.params;
  const isNumeric = /^\d+$/.test(identifier);
  const jobId = isNumeric ? parseInt(identifier, 10) : null;
  const referenceId = isNumeric ? null : identifier;

  const job = await queryOne<Record<string, unknown>>(
    `SELECT j.*,
            c.slug AS company_slug,
            c.name AS company_name,
            c.company_email AS company_email,
            COALESCE(j.job_city, c.city) AS resolved_city,
            COALESCE(j.job_state, c.state) AS resolved_state,
            COALESCE(j.job_country, c.country) AS resolved_country,
            COALESCE(j.job_postal_code, s.cap) AS resolved_postal_code
     FROM job_postings j
     JOIN companies c ON c.id = j.company_id
     LEFT JOIN stores s ON s.id = j.store_id
     WHERE (${jobId ? 'j.id = $1' : 'j.reference_id = $1'}) AND j.company_id = ANY($2::int[])`,
    [jobId ?? referenceId, companyIdsToSearch],
  );

  if (!job) { notFound(res, 'Annuncio non trovato'); return; }

  let isReferenceIdDuplicate = false;
  if (job.reference_id) {
    const dupRow = await queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM job_postings WHERE reference_id = $1 AND id <> $2`,
      [job.reference_id, job.id],
    );
    isReferenceIdDuplicate = (dupRow?.count ?? 0) > 0;
  }

  const mappedJob = {
    id: job.id,
    companyId: job.company_id,
    companySlug: job.company_slug,
    companyName: job.company_name,
    companyEmail: job.company_email,
    title: job.title,
    description: job.description,
    tags: job.tags || [],
    status: job.status,
    source: job.source,
    indeedPostId: job.indeed_post_id,
    referenceId: job.reference_id,
    language: job.language,
    jobType: job.job_type,
    isRemote: job.is_remote,
    remoteType: job.remote_type,
    city: job.resolved_city || '',
    state: job.resolved_state || '',
    country: job.resolved_country || '',
    postalCode: job.resolved_postal_code || '',
    publishedAt: job.published_at,
    createdAt: job.created_at,
    expirationDate: job.expiration_date || null,
    salaryMin: job.salary_min !== null && job.salary_min !== undefined ? Number(job.salary_min) : null,
    salaryMax: job.salary_max !== null && job.salary_max !== undefined ? Number(job.salary_max) : null,
    salaryPeriod: job.salary_period || null,
    isReferenceIdDuplicate,
    indeedApplyTokenConfigured: !!process.env.INDEED_APPLY_API_TOKEN,
    indeedApplyPostUrl: process.env.INDEED_APPLY_POST_URL || `${process.env.APP_BASE_URL || 'https://veylohr.com'}/api/public/indeed-apply/${job.company_slug}`,
  };

  ok(res, { job: mappedJob });
});

export const createJobHandler = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.user!;
  const companyId = await resolveAtsCompanyId(req);
  if (!companyId) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const {
    title,
    description,
    tags,
    status,
    store_id,
    language,
    job_type,
    is_remote,
    remote_type,
    job_city,
    job_state,
    job_country,
    job_postal_code,
    job_address,
    department,
    weekly_hours,
    contract_type,
    salary_min,
    salary_max,
    salary_period,
    target_role,
  } = req.body as Record<string, unknown>;
  let statusValue: 'draft' | 'published' | 'closed' = 'draft';
  if (status !== undefined) {
    if (typeof status !== 'string') {
      badRequest(res, 'Stato annuncio non valido', 'VALIDATION_ERROR');
      return;
    }
    const normalized = status.toLowerCase();
    if (!VALID_JOB_STATUSES.has(normalized)) {
      badRequest(res, 'Lo stato deve essere draft, published o closed', 'VALIDATION_ERROR');
      return;
    }
    statusValue = normalized as 'draft' | 'published' | 'closed';
  }


  if (!title || typeof title !== 'string' || title.trim() === '') {
    badRequest(res, 'Il titolo è obbligatorio', 'VALIDATION_ERROR');
    return;
  }

  const languageValue = typeof language === 'string' ? language.toLowerCase() : 'it';
  if (!['it', 'en', 'both'].includes(languageValue)) {
    badRequest(res, 'La lingua annuncio deve essere it, en oppure both', 'VALIDATION_ERROR');
    return;
  }

  const jobTypeValue = typeof job_type === 'string' ? job_type.toLowerCase() : 'fulltime';
  if (!['fulltime', 'parttime', 'contract', 'internship'].includes(jobTypeValue)) {
    badRequest(res, 'Il tipo contratto deve essere fulltime, parttime, contract o internship', 'VALIDATION_ERROR');
    return;
  }

  const weeklyHoursValue = typeof weekly_hours === 'number' ? weekly_hours : undefined;
  if (weeklyHoursValue !== undefined && (!Number.isFinite(weeklyHoursValue) || weeklyHoursValue < 0 || weeklyHoursValue > 168)) {
    badRequest(res, 'Le ore settimanali devono essere comprese tra 0 e 168', 'VALIDATION_ERROR');
    return;
  }

  const salaryMinValue = salary_min === null ? null : (typeof salary_min === 'number' ? salary_min : undefined);
  const salaryMaxValue = salary_max === null ? null : (typeof salary_max === 'number' ? salary_max : undefined);

  if (salaryMinValue !== undefined && salaryMinValue !== null && (!Number.isFinite(salaryMinValue) || salaryMinValue < 0)) {
    badRequest(res, 'Salary min non valido', 'VALIDATION_ERROR');
    return;
  }
  if (salaryMaxValue !== undefined && salaryMaxValue !== null && (!Number.isFinite(salaryMaxValue) || salaryMaxValue < 0)) {
    badRequest(res, 'Salary max non valido', 'VALIDATION_ERROR');
    return;
  }
  if (
    salaryMinValue !== undefined && salaryMinValue !== null
    && salaryMaxValue !== undefined && salaryMaxValue !== null
    && salaryMinValue > salaryMaxValue
  ) {
    badRequest(res, 'Salary min deve essere <= salary max', 'VALIDATION_ERROR');
    return;
  }

  let salaryPeriodValue: string | undefined;
  if (salary_period !== undefined && salary_period !== null && String(salary_period).trim() !== '') {
    if (typeof salary_period !== 'string') {
      badRequest(res, 'Periodo salario non valido', 'VALIDATION_ERROR');
      return;
    }
    const normalizedSalaryPeriod = canonicalizeSalaryPeriod(salary_period);
    if (!normalizedSalaryPeriod) {
      badRequest(res, 'Periodo salario non valido', 'VALIDATION_ERROR');
      return;
    }
    salaryPeriodValue = normalizedSalaryPeriod;
  }

  let targetRoleValue: string | undefined;
  if (target_role !== undefined && target_role !== null && String(target_role).trim() !== '') {
    if (typeof target_role !== 'string') {
      badRequest(res, 'Ruolo target non valido', 'VALIDATION_ERROR');
      return;
    }
    const normalizedTargetRole = target_role.trim().toLowerCase();
    const allowedTargetRoles = new Set(['hr', 'area_manager', 'store_manager', 'employee']);
    if (!allowedTargetRoles.has(normalizedTargetRole)) {
      badRequest(res, 'Ruolo target non valido', 'VALIDATION_ERROR');
      return;
    }
    targetRoleValue = normalizedTargetRole;
  }

  let remoteTypeValue: RemoteType;
  if (typeof remote_type === 'string') {
    const normalized = remote_type.toLowerCase();
    if (!['onsite', 'hybrid', 'remote'].includes(normalized)) {
      badRequest(res, 'Remote type non valido (onsite, hybrid, remote)', 'VALIDATION_ERROR');
      return;
    }
    remoteTypeValue = normalized as RemoteType;
  } else {
    remoteTypeValue = (is_remote === true || is_remote === 'true') ? 'remote' : 'onsite';
  }

  if (typeof store_id === 'number') {
    const storeError = await validateAtsStore(store_id, companyId);
    if (storeError) {
      badRequest(res, storeError, 'INVALID_STORE');
      return;
    }
  }



  let job;
  try {
    job = await createJob(companyId, userId, {
      title: title.trim(),
      description: typeof description === 'string' ? description : undefined,
      tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
      status: statusValue,
      storeId: typeof store_id === 'number' ? store_id : undefined,
      language: languageValue as JobLanguage,
      jobType: jobTypeValue as JobType,
      isRemote: remoteTypeValue === 'remote',
      remoteType: remoteTypeValue,
      jobCity: typeof job_city === 'string' ? job_city.trim() : undefined,
      jobState: typeof job_state === 'string' ? job_state.trim() : undefined,
      jobCountry: typeof job_country === 'string' ? job_country.trim() : undefined,
      jobPostalCode: typeof job_postal_code === 'string' ? job_postal_code.trim() : undefined,
      jobAddress: typeof job_address === 'string' ? job_address.trim() : undefined,
      department: typeof department === 'string' ? department.trim() : undefined,
      weeklyHours: weeklyHoursValue,
      contractType: typeof contract_type === 'string' ? contract_type.trim() : undefined,
      salaryMin: salaryMinValue === undefined ? undefined : salaryMinValue ?? undefined,
      salaryMax: salaryMaxValue === undefined ? undefined : salaryMaxValue ?? undefined,
      salaryPeriod: salaryPeriodValue,
      targetRole: targetRoleValue,
    });
  } catch (err) {
    if (handleJobPersistenceError(res, err)) return;
    throw err;
  }

  created(res, { job }, 'Annuncio creato');
});

export const updateJobHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const owner = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM job_postings WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (!owner) {
    notFound(res, 'Annuncio non trovato');
    return;
  }

  if (!allowedCompanyIds.includes(owner.company_id)) {
    forbidden(res, 'Nessuna azienda valida selezionata');
    return;
  }

  const effectiveCompanyId = owner.company_id;

  const {
    title,
    description,
    tags,
    status,
    company_id,
    target_company_id,
    store_id,
    language,
    job_type,
    is_remote,
    remote_type,
    job_city,
    job_state,
    job_country,
    job_postal_code,
    job_address,
    department,
    weekly_hours,
    contract_type,
    salary_min,
    salary_max,
    salary_period,
    target_role,
  } = req.body as Record<string, unknown>;

  let targetCompanyId = effectiveCompanyId;
  const requestedCompanyRaw = company_id ?? target_company_id;
  if (requestedCompanyRaw !== undefined && requestedCompanyRaw !== null && String(requestedCompanyRaw).trim() !== '') {
    const parsedTargetCompany = Number.parseInt(String(requestedCompanyRaw), 10);
    if (Number.isNaN(parsedTargetCompany)) {
      badRequest(res, 'ID azienda non valido', 'VALIDATION_ERROR');
      return;
    }
    if (!allowedCompanyIds.includes(parsedTargetCompany)) {
      forbidden(res, 'Nessuna azienda valida selezionata');
      return;
    }
    targetCompanyId = parsedTargetCompany;
  }

  let parsedLanguage: JobLanguage | undefined;
  if (language !== undefined) {
    if (typeof language !== 'string') {
      badRequest(res, 'Lingua annuncio non valida', 'VALIDATION_ERROR');
      return;
    }
    const normalized = language.toLowerCase();
    if (!['it', 'en', 'both'].includes(normalized)) {
      badRequest(res, 'La lingua annuncio deve essere it, en oppure both', 'VALIDATION_ERROR');
      return;
    }
    parsedLanguage = normalized as JobLanguage;
  }

  let parsedJobType: JobType | undefined;
  if (job_type !== undefined) {
    if (typeof job_type !== 'string') {
      badRequest(res, 'Tipo contratto non valido', 'VALIDATION_ERROR');
      return;
    }
    const normalized = job_type.toLowerCase();
    if (!['fulltime', 'parttime', 'contract', 'internship'].includes(normalized)) {
      badRequest(res, 'Il tipo contratto deve essere fulltime, parttime, contract o internship', 'VALIDATION_ERROR');
      return;
    }
    parsedJobType = normalized as JobType;
  }

  let parsedStatus: 'draft' | 'published' | 'closed' | undefined;
  if (status !== undefined) {
    if (typeof status !== 'string') {
      badRequest(res, 'Stato annuncio non valido', 'VALIDATION_ERROR');
      return;
    }
    const normalized = status.toLowerCase();
    if (!VALID_JOB_STATUSES.has(normalized)) {
      badRequest(res, 'Lo stato deve essere draft, published o closed', 'VALIDATION_ERROR');
      return;
    }
    parsedStatus = normalized as 'draft' | 'published' | 'closed';
  }

  let parsedWeeklyHours: number | null | undefined;
  if (weekly_hours !== undefined) {
    if (weekly_hours === null) {
      parsedWeeklyHours = null;
    } else if (typeof weekly_hours === 'number' && Number.isFinite(weekly_hours) && weekly_hours >= 0 && weekly_hours <= 168) {
      parsedWeeklyHours = weekly_hours;
    } else {
      badRequest(res, 'Le ore settimanali devono essere comprese tra 0 e 168', 'VALIDATION_ERROR');
      return;
    }
  }

  let parsedSalaryMin: number | null | undefined;
  if (salary_min !== undefined) {
    if (salary_min === null) {
      parsedSalaryMin = null;
    } else if (typeof salary_min === 'number' && Number.isFinite(salary_min) && salary_min >= 0) {
      parsedSalaryMin = salary_min;
    } else {
      badRequest(res, 'Salary min non valido', 'VALIDATION_ERROR');
      return;
    }
  }

  let parsedSalaryMax: number | null | undefined;
  if (salary_max !== undefined) {
    if (salary_max === null) {
      parsedSalaryMax = null;
    } else if (typeof salary_max === 'number' && Number.isFinite(salary_max) && salary_max >= 0) {
      parsedSalaryMax = salary_max;
    } else {
      badRequest(res, 'Salary max non valido', 'VALIDATION_ERROR');
      return;
    }
  }

  const effectiveSalaryMin = parsedSalaryMin !== undefined ? parsedSalaryMin : undefined;
  const effectiveSalaryMax = parsedSalaryMax !== undefined ? parsedSalaryMax : undefined;
  if (
    effectiveSalaryMin !== undefined && effectiveSalaryMin !== null
    && effectiveSalaryMax !== undefined && effectiveSalaryMax !== null
    && effectiveSalaryMin > effectiveSalaryMax
  ) {
    badRequest(res, 'Salary min deve essere <= salary max', 'VALIDATION_ERROR');
    return;
  }

  let parsedSalaryPeriod: string | null | undefined;
  if (salary_period !== undefined) {
    if (salary_period === null || String(salary_period).trim() === '') {
      parsedSalaryPeriod = null;
    } else if (typeof salary_period === 'string') {
      const normalizedSalaryPeriod = canonicalizeSalaryPeriod(salary_period);
      if (!normalizedSalaryPeriod) {
        badRequest(res, 'Periodo salario non valido', 'VALIDATION_ERROR');
        return;
      }
      parsedSalaryPeriod = normalizedSalaryPeriod;
    } else {
      badRequest(res, 'Periodo salario non valido', 'VALIDATION_ERROR');
      return;
    }
  }

  let parsedTargetRole: string | null | undefined;
  if (target_role !== undefined) {
    if (target_role === null || String(target_role).trim() === '') {
      parsedTargetRole = null;
    } else if (typeof target_role === 'string') {
      const normalizedTargetRole = target_role.trim().toLowerCase();
      const allowedTargetRoles = new Set(['hr', 'area_manager', 'store_manager', 'employee']);
      if (!allowedTargetRoles.has(normalizedTargetRole)) {
        badRequest(res, 'Ruolo target non valido', 'VALIDATION_ERROR');
        return;
      }
      parsedTargetRole = normalizedTargetRole;
    } else {
      badRequest(res, 'Ruolo target non valido', 'VALIDATION_ERROR');
      return;
    }
  }

  let parsedRemoteType: RemoteType | undefined;
  if (remote_type !== undefined) {
    if (typeof remote_type !== 'string') {
      badRequest(res, 'Remote type non valido', 'VALIDATION_ERROR');
      return;
    }
    const normalized = remote_type.toLowerCase();
    if (!['onsite', 'hybrid', 'remote'].includes(normalized)) {
      badRequest(res, 'Remote type non valido (onsite, hybrid, remote)', 'VALIDATION_ERROR');
      return;
    }
    parsedRemoteType = normalized as RemoteType;
  }

  const requestedStoreId = typeof store_id === 'number'
    ? store_id
    : store_id === null
      ? null
      : undefined;

  if (typeof requestedStoreId === 'number') {
    const storeError = await validateAtsStore(requestedStoreId, targetCompanyId);
    if (storeError) {
      badRequest(res, storeError, 'INVALID_STORE');
      return;
    }
  }

  const normalizedStoreId = targetCompanyId !== effectiveCompanyId && requestedStoreId === undefined
    ? null
    : requestedStoreId;



  let updated;
  try {
    updated = await updateJob(id, effectiveCompanyId, {
      companyId: targetCompanyId,
      title:       typeof title === 'string' ? title.trim() : undefined,
      description: typeof description === 'string' ? description : undefined,
      tags:        Array.isArray(tags) ? (tags as string[]) : undefined,
      status: parsedStatus,
      storeId: normalizedStoreId,
      language: parsedLanguage,
      jobType: parsedJobType,
      isRemote: is_remote === undefined ? undefined : (is_remote === true || is_remote === 'true'),
      remoteType: parsedRemoteType,
      jobCity: typeof job_city === 'string' ? job_city.trim() : job_city === null ? null : undefined,
      jobState: typeof job_state === 'string' ? job_state.trim() : job_state === null ? null : undefined,
      jobCountry: typeof job_country === 'string' ? job_country.trim() : job_country === null ? null : undefined,
      jobPostalCode: typeof job_postal_code === 'string' ? job_postal_code.trim() : job_postal_code === null ? null : undefined,
      jobAddress: typeof job_address === 'string' ? job_address.trim() : job_address === null ? null : undefined,
      department: typeof department === 'string' ? department.trim() : department === null ? null : undefined,
      weeklyHours: parsedWeeklyHours,
      contractType: typeof contract_type === 'string' ? contract_type.trim() : contract_type === null ? null : undefined,
      salaryMin: parsedSalaryMin,
      salaryMax: parsedSalaryMax,
      salaryPeriod: parsedSalaryPeriod,
      targetRole: parsedTargetRole,
    });
  } catch (err) {
    if (handleJobPersistenceError(res, err)) return;
    throw err;
  }

  if (!updated) { notFound(res, 'Annuncio non trovato'); return; }
  ok(res, { job: updated }, 'Annuncio aggiornato');
});

export const deleteJobHandler = asyncHandler(async (req: Request, res: Response) => {
  const companyId = await resolveAtsCompanyId(req);
  if (!companyId) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  const deleted = await deleteJob(id, companyId);
  if (!deleted) { notFound(res, 'Annuncio non trovato'); return; }
  ok(res, {}, 'Annuncio eliminato');
});

export const publishJobHandler = asyncHandler(async (req: Request, res: Response) => {
  const companyId = await resolveAtsCompanyId(req);
  if (!companyId) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  const job = await publishJobToIndeed(id, companyId);
  if (!job) { notFound(res, 'Annuncio non trovato'); return; }
  ok(res, { job }, 'Annuncio pubblicato su Indeed');
});

export const syncJobHandler = asyncHandler(async (req: Request, res: Response) => {
  const companyId = await resolveAtsCompanyId(req);
  if (!companyId) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  const result = await syncIndeedApplications(id, companyId);
  ok(res, result, `Sincronizzati ${result.imported} candidati`);
});

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export const listCandidatesHandler = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const explicitRaw = req.query.company_id ?? req.query.target_company_id;
  const explicitCompanyId = explicitRaw != null && String(explicitRaw).trim() !== ''
    ? Number.parseInt(String(explicitRaw), 10)
    : undefined;
  if (explicitCompanyId !== undefined && Number.isNaN(explicitCompanyId)) {
    badRequest(res, 'Azienda non valida');
    return;
  }

  let companyScope: number[] = [];
  if (explicitCompanyId !== undefined) {
    if (!allowedCompanyIds.includes(explicitCompanyId)) {
      forbidden(res, 'Nessuna azienda valida selezionata');
      return;
    }
    companyScope = [explicitCompanyId];
  } else if (req.user?.is_super_admin || allowedCompanyIds.length > 1) {
    // Multi-company contexts should default to full allowed scope to avoid hiding data
    // when a stale/default company is selected locally.
    companyScope = allowedCompanyIds;
  } else if (req.user?.companyId && allowedCompanyIds.includes(req.user.companyId)) {
    companyScope = [req.user.companyId];
  } else {
    companyScope = allowedCompanyIds;
  }
  if (companyScope.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const jobIdRaw = req.query.job_id ?? req.query.jobId;
  const jobId = jobIdRaw ? parseInt(String(jobIdRaw), 10) : undefined;
  const storeIds = resolveStoreIds(req.user);

  const candidates = await listCandidates(companyScope, {
    status,
    jobPostingId: jobId && !Number.isNaN(jobId) ? jobId : undefined,
    storeIds,
  });
  ok(res, { candidates });
});

// GET /api/ats/interviewers — eligible interviewers for a company (with group scope)
export const listInterviewersHandler = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const rawCompanyId = req.query.company_id ?? req.query.target_company_id ?? req.query.companyId;
  const fallbackCompanyId = req.user?.companyId ?? null;
  const parsedCompanyId = rawCompanyId != null && String(rawCompanyId).trim() !== ''
    ? Number.parseInt(String(rawCompanyId), 10)
    : fallbackCompanyId;

  if (!parsedCompanyId || Number.isNaN(parsedCompanyId)) {
    badRequest(res, 'Azienda non valida');
    return;
  }
  if (!allowedCompanyIds.includes(parsedCompanyId)) {
    forbidden(res, 'Nessuna azienda valida selezionata');
    return;
  }

  const groupId = await resolveCompanyGroupId(parsedCompanyId);
  let groupCompanyIds = [parsedCompanyId];
  if (groupId !== null) {
    const rows = await query<{ id: number }>(
      `SELECT id FROM companies WHERE group_id = $1 AND is_active = true ORDER BY id`,
      [groupId],
    );
    groupCompanyIds = rows.map((row) => row.id);
  }

  const scopedCompanyIds = groupCompanyIds.filter((id) => allowedCompanyIds.includes(id));
  if (scopedCompanyIds.length === 0) {
    ok(res, { interviewers: [] });
    return;
  }

  const interviewers = await query(
    `SELECT
       u.id, u.company_id, u.store_id, u.name, u.surname, u.email, u.role, u.status,
       u.avatar_filename, c.name AS company_name, c.logo_filename AS company_logo_filename,
       s.name AS store_name
     FROM users u
     LEFT JOIN companies c ON c.id = u.company_id
     LEFT JOIN stores s ON s.id = u.store_id
     WHERE u.company_id = ANY($1)
       AND u.status = 'active'
       AND u.role IN ('hr', 'area_manager', 'store_manager')
     ORDER BY c.name, u.surname, u.name`,
    [scopedCompanyIds],
  );

  ok(res, { interviewers });
});

export const getCandidateHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const owner = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM candidates WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (!owner) { notFound(res, 'Candidato non trovato'); return; }
  if (!allowedCompanyIds.includes(owner.company_id)) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const storeIds = resolveStoreIds(req.user);
  const scopedCandidate = await getCandidate(id, owner.company_id, storeIds);
  if (!scopedCandidate) { notFound(res, 'Candidato non trovato'); return; }

  const candidate = await getCandidate(id, owner.company_id, storeIds);
  if (!candidate) { notFound(res, 'Candidato non trovato'); return; }

  // Mark as read on retrieval
  await markCandidateRead(id, owner.company_id);

  ok(res, { candidate });
});

export const createCandidateHandler = asyncHandler(async (req: Request, res: Response) => {
  const { companyId: userCompanyId, userId } = req.user!;
  if (!userCompanyId) { forbidden(res, 'Nessuna azienda'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const body = req.body as Record<string, unknown>;
  const {
    full_name,
    email,
    phone,
    job_posting_id,
    store_id,
    tags,
    cv_path,
    resume_path,
    linkedin_url,
    cover_letter,
    source,
    source_ref,
    availability,
    gender,
    nationality,
    country,
    state,
    city,
    date_of_birth,
    current_employer,
    current_role,
    marital_status,
    has_current_employer,
    unique_id,
    password,
    hire_date,
    contract_type,
    application_date,
    application_source,
    application_channel,
    gdpr_consent,
    applicant_locale,
    consent_accepted_at,
    applied_at,
  } = body;

  const uploadedFile = (req as Request & { file?: Express.Multer.File }).file;
  let cvPathResolved = typeof cv_path === 'string' && cv_path.trim() !== '' ? cv_path.trim() : undefined;
  let resumePathResolved = typeof resume_path === 'string' && resume_path.trim() !== '' ? resume_path.trim() : undefined;
  if (uploadedFile?.filename) {
    const rel = `public-cv/${uploadedFile.filename}`;
    cvPathResolved = rel;
    resumePathResolved = rel;
  }

  let tagList: string[] = [];
  if (Array.isArray(tags)) {
    tagList = tags as string[];
  } else if (typeof tags === 'string' && tags.trim() !== '') {
    try {
      const parsed = JSON.parse(tags) as unknown;
      if (Array.isArray(parsed)) tagList = parsed as string[];
    } catch {
      tagList = [];
    }
  }

  const gdprConsentParsed = typeof gdpr_consent === 'boolean'
    ? gdpr_consent
    : (typeof gdpr_consent === 'string' && ['true', '1', 'on', 'yes'].includes(gdpr_consent.trim().toLowerCase()));

  if (!full_name || typeof full_name !== 'string' || full_name.trim() === '') {
    badRequest(res, 'Il nome è obbligatorio', 'VALIDATION_ERROR');
    return;
  }

  const parsedJobPostingId = typeof job_posting_id === 'number'
    ? job_posting_id
    : (typeof job_posting_id === 'string' && job_posting_id.trim() !== ''
      ? Number.parseInt(job_posting_id, 10)
      : undefined);

  if (parsedJobPostingId !== undefined && Number.isNaN(parsedJobPostingId)) {
    badRequest(res, 'Posizione non valida', 'VALIDATION_ERROR');
    return;
  }

  let parsedStoreId = typeof store_id === 'number'
    ? store_id
    : (typeof store_id === 'string' && store_id.trim() !== ''
      ? Number.parseInt(store_id, 10)
      : undefined);

  if (parsedStoreId === undefined && req.user?.role === 'store_manager' && req.user?.storeId) {
    parsedStoreId = req.user.storeId;
  }

  if (parsedStoreId !== undefined && Number.isNaN(parsedStoreId)) {
    badRequest(res, 'Punto vendita non valido', 'VALIDATION_ERROR');
    return;
  }

  let targetCompanyId = userCompanyId;

  if (parsedJobPostingId !== undefined) {
    const jobRow = await queryOne<{ id: number; company_id: number; store_id: number | null }>(
      `SELECT id, company_id, store_id FROM job_postings WHERE id = $1`,
      [parsedJobPostingId],
    );

    if (!jobRow) {
      badRequest(res, 'Posizione non valida', 'VALIDATION_ERROR');
      return;
    }

    if (!allowedCompanyIds.includes(jobRow.company_id)) {
      forbidden(res, 'Nessuna azienda valida selezionata');
      return;
    }

    targetCompanyId = jobRow.company_id;

    if (parsedStoreId !== undefined) {
      const storeError = await validateAtsStore(parsedStoreId, targetCompanyId);
      if (storeError) {
        badRequest(res, storeError, 'INVALID_STORE');
        return;
      }
    } else if (jobRow.store_id !== null) {
      parsedStoreId = jobRow.store_id;
    }
  } else if (parsedStoreId !== undefined) {
    const storeError = await validateAtsStore(parsedStoreId, targetCompanyId);
    if (storeError) {
      badRequest(res, storeError, 'INVALID_STORE');
      return;
    }
  }

  const sourceRefResolved = typeof source_ref === 'string' && source_ref.trim() !== ''
    ? source_ref
    : JSON.stringify({
      availability: typeof availability === 'string' ? availability : undefined,
      gender: typeof gender === 'string' ? gender : undefined,
      nationality: typeof nationality === 'string' ? nationality : undefined,
      country: typeof country === 'string' ? country : undefined,
      state: typeof state === 'string' ? state : undefined,
      city: typeof city === 'string' ? city : undefined,
      dateOfBirth: typeof date_of_birth === 'string' ? date_of_birth : undefined,
      currentEmployer: typeof current_employer === 'string' ? current_employer : undefined,
      currentRole: typeof current_role === 'string' ? current_role : undefined,
      maritalStatus: typeof marital_status === 'string' ? marital_status : undefined,
      hasCurrentEmployer: typeof has_current_employer === 'string' ? has_current_employer : undefined,
      uniqueId: typeof unique_id === 'string' ? unique_id : undefined,
      password: typeof password === 'string' ? password : undefined,
      hireDate: typeof hire_date === 'string' ? hire_date : undefined,
      contractType: typeof contract_type === 'string' ? contract_type : undefined,
      applicationDate: typeof application_date === 'string' ? application_date : undefined,
      applicationSource: typeof application_source === 'string' ? application_source : undefined,
      applicationChannel: typeof application_channel === 'string' ? application_channel : undefined,
    });

  const candidate = await createCandidate(targetCompanyId, {
    fullName:     full_name.trim(),
    email:        typeof email === 'string' ? email : undefined,
    phone:        typeof phone === 'string' ? phone : undefined,
    jobPostingId: parsedJobPostingId,
    storeId:      parsedStoreId,
    tags:         tagList,
    cvPath:       cvPathResolved,
    resumePath:   resumePathResolved,
    linkedinUrl:  typeof linkedin_url === 'string' ? linkedin_url : undefined,
    coverLetter:  typeof cover_letter === 'string' ? cover_letter : undefined,
    source:       typeof source === 'string' ? source : undefined,
    sourceRef:    sourceRefResolved,
    gdprConsent:  gdprConsentParsed,
    applicantLocale: typeof applicant_locale === 'string' ? applicant_locale : undefined,
    consentAcceptedAt: typeof consent_accepted_at === 'string' ? consent_accepted_at : undefined,
    appliedAt:    typeof applied_at === 'string' ? applied_at : undefined,
  });

  const locale = (req.user as any)?.locale || 'it';

  sendNotification({
    companyId: targetCompanyId,
    userId,
    type: 'ats.candidate_received',
    title:   t(locale, 'notifications.ats_candidate_received.title'),
    message: t(locale, 'notifications.ats_candidate_received.message', { name: candidate.fullName }),
    priority: 'high',
    locale,
  }).catch(() => undefined);

  emitToCompany(targetCompanyId, 'ATS_CANDIDATE_CREATED', { candidate });

  created(res, { candidate }, 'Candidato aggiunto');
});

export const updateCandidateHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const owner = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM candidates WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (!owner) { notFound(res, 'Candidato non trovato'); return; }
  if (!allowedCompanyIds.includes(owner.company_id)) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const { status, rejection_reason } = req.body as { status?: unknown; rejection_reason?: unknown };

  if (!status || typeof status !== 'string') {
    badRequest(res, 'Il campo "status" è obbligatorio', 'VALIDATION_ERROR');
    return;
  }

  const validStatuses: CandidateStatus[] = ['received', 'review', 'phone_interview', 'interview', 'hired', 'rejected'];
  if (!validStatuses.includes(status as CandidateStatus)) {
    badRequest(res, `Stato non valido. Valori ammessi: ${validStatuses.join(', ')}`, 'VALIDATION_ERROR');
    return;
  }

  const storeIds = resolveStoreIds(req.user);
  const previousStatusRow = await queryOne<{ status: CandidateStatus }>(
    storeIds && storeIds.length > 0
      ? `SELECT c.status
         FROM candidates c
         LEFT JOIN job_postings jp ON jp.id = c.job_posting_id
         WHERE c.id = $1
           AND c.company_id = $2
           AND (
             COALESCE(c.store_id, jp.store_id) = ANY($3::int[])
             OR COALESCE(c.store_id, jp.store_id) IS NULL
           )
         LIMIT 1`
      : `SELECT status
         FROM candidates
         WHERE id = $1 AND company_id = $2
         LIMIT 1`,
    storeIds && storeIds.length > 0
      ? [id, owner.company_id, storeIds]
      : [id, owner.company_id],
  );

  if (!previousStatusRow) {
    notFound(res, 'Candidato non trovato');
    return;
  }

  const { candidate, error } = await updateCandidateStage(
    id, 
    owner.company_id, 
    status as CandidateStatus, 
    storeIds, 
    typeof rejection_reason === 'string' ? rejection_reason : undefined
  );
  if (error) { badRequest(res, error, 'INVALID_TRANSITION'); return; }
  if (!candidate) { notFound(res, 'Candidato non trovato'); return; }

  if (previousStatusRow.status !== candidate.status) {
    const recipients = await query<{ id: number; locale: string | null }>(
      `SELECT id, locale
       FROM users
       WHERE company_id = $1
         AND role IN ('admin', 'hr')
         AND status = 'active'`,
      [owner.company_id],
    );

    void Promise.all(
      recipients.map((recipient) => {
        const recipientLocale = recipient.locale ?? 'it';
        return sendNotification({
          companyId: owner.company_id,
          userId: recipient.id,
          type: 'ats.outcome',
          title: t(recipientLocale, 'notifications.ats_outcome.title'),
          message: t(recipientLocale, 'notifications.ats_outcome.message', {
            name: candidate.fullName,
            from: t(recipientLocale, `notifications.ats_status_${previousStatusRow.status}`),
            to: t(recipientLocale, `notifications.ats_status_${candidate.status}`),
          }),
          priority: 'medium',
          locale: recipientLocale,
          metadata: {
            candidateId: candidate.id,
          },
        });
      }),
    ).catch(() => undefined);
  }

  ok(res, { candidate }, 'Stato candidato aggiornato');
});

export const updateCandidateTagsHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const owner = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM candidates WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (!owner) { notFound(res, 'Candidato non trovato'); return; }
  if (!allowedCompanyIds.includes(owner.company_id)) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const { tags } = req.body as { tags?: unknown };

  if (!Array.isArray(tags)) {
    badRequest(res, 'Il campo "tags" deve essere un array', 'VALIDATION_ERROR');
    return;
  }

  // Validate that all tags are strings
  if (!tags.every(tag => typeof tag === 'string')) {
    badRequest(res, 'Tutti i tag devono essere stringhe', 'VALIDATION_ERROR');
    return;
  }

  const candidateRow = await queryOne<Record<string, unknown>>(
    `UPDATE candidates SET tags = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
    [tags, id]
  );

  if (!candidateRow) { notFound(res, 'Candidato non trovato'); return; }

  const storeIds = resolveStoreIds(req.user);
  const candidate = await getCandidate(id, owner.company_id, storeIds);
  if (!candidate) { notFound(res, 'Candidato non trovato'); return; }

  ok(res, { candidate }, 'Tag aggiornati');
});

export const deleteCandidateHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const owner = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM candidates WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (!owner) { notFound(res, 'Candidato non trovato'); return; }
  if (!allowedCompanyIds.includes(owner.company_id)) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const deleted = await deleteCandidate(id, owner.company_id);
  if (!deleted) { notFound(res, 'Candidato non trovato'); return; }
  ok(res, {}, 'Candidato eliminato');
});

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

export const listInterviewsHandler = asyncHandler(async (req: Request, res: Response) => {
  const candidateId = parseInt(req.params.candidateId, 10);
  if (Number.isNaN(candidateId)) { badRequest(res, 'ID candidato non valido'); return; }

  // Get the candidate to determine the company_id
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const candidateRow = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM candidates WHERE id = $1 LIMIT 1`,
    [candidateId],
  );
  
  if (!candidateRow) { notFound(res, 'Candidato non trovato'); return; }
  if (!allowedCompanyIds.includes(candidateRow.company_id)) { 
    forbidden(res, 'Nessuna azienda valida selezionata'); 
    return; 
  }

  const companyId = candidateRow.company_id;

  const storeIds = resolveStoreIds(req.user);
  const interviews = await listInterviews(candidateId, companyId, storeIds);
  ok(res, { interviews });
});

export const listAllInterviewsHandler = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { 
    forbidden(res, 'Nessuna azienda valida selezionata'); 
    return; 
  }

  const scopedCompanyIds = resolveAtsCompanyScope(req, allowedCompanyIds);
  if (!scopedCompanyIds) {
    forbidden(res, 'Nessuna azienda valida selezionata');
    return;
  }

  const filters: {
    dateFrom?: string;
    dateTo?: string;
    positionId?: number;
    candidateId?: number;
    interviewerId?: number;
  } = {};

  // Parse query parameters
  if (req.query.date_from && typeof req.query.date_from === 'string') {
    filters.dateFrom = req.query.date_from;
  }

  if (req.query.date_to && typeof req.query.date_to === 'string') {
    filters.dateTo = req.query.date_to;
  }

  if (req.query.position_id) {
    const positionId = parseInt(req.query.position_id as string, 10);
    if (!Number.isNaN(positionId)) {
      filters.positionId = positionId;
    }
  }

  if (req.query.candidate_id) {
    const candidateId = parseInt(req.query.candidate_id as string, 10);
    if (!Number.isNaN(candidateId)) {
      filters.candidateId = candidateId;
    }
  }

  if (req.query.interviewer_id) {
    const interviewerId = parseInt(req.query.interviewer_id as string, 10);
    if (!Number.isNaN(interviewerId)) {
      filters.interviewerId = interviewerId;
    }
  }

  const storeIds = resolveStoreIds(req.user);
  
  // Fetch interviews for all allowed companies unless a company filter is explicit
  const interviews = await listAllInterviews(scopedCompanyIds, filters, storeIds);
  ok(res, { interviews });
});

export const createInterviewHandler = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.user!;
  
  const candidateId = parseInt(req.params.candidateId, 10);
  if (Number.isNaN(candidateId)) { badRequest(res, 'ID candidato non valido'); return; }

  // First, get the candidate to determine the company_id
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const candidateRow = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM candidates WHERE id = $1 LIMIT 1`,
    [candidateId],
  );
  
  if (!candidateRow) { notFound(res, 'Candidato non trovato'); return; }
  if (!allowedCompanyIds.includes(candidateRow.company_id)) { 
    forbidden(res, 'Nessuna azienda valida selezionata'); 
    return; 
  }

  const companyId = candidateRow.company_id;

  const { scheduled_at, interview_type, location, description, notes, duration_minutes, interviewer_id, send_ics } = req.body as Record<string, unknown>;

  if (!scheduled_at || typeof scheduled_at !== 'string') {
    badRequest(res, 'La data del colloquio è obbligatoria', 'VALIDATION_ERROR');
    return;
  }

  const scheduledDate = new Date(scheduled_at);
  if (isNaN(scheduledDate.getTime())) {
    badRequest(res, 'Data non valida', 'VALIDATION_ERROR');
    return;
  }

  const normalizedInterviewType = isInterviewType(interview_type)
    ? interview_type
    : 'in_person';
  const normalizedDescription =
    typeof description === 'string' ? description :
    typeof notes === 'string' ? notes :
    undefined;

  let icsUid: string | undefined;
  if (send_ics === true) {
    try {
      const { uid } = generateICSEvent({
        title: 'Colloquio di lavoro',
        description: normalizedDescription,
        location: typeof location === 'string' ? location : undefined,
        startDate: scheduledDate,
      });
      icsUid = uid;
    } catch {
      // ICS generation failure is non-fatal
    }
  }

  const storeIds = resolveStoreIds(req.user);
  const interview = await createInterview(candidateId, companyId, {
    interviewerId: typeof interviewer_id === 'number' ? interviewer_id : undefined,
    interviewType: normalizedInterviewType,
    scheduledAt:   scheduledDate.toISOString(),
    location:      typeof location === 'string' ? location : undefined,
    description:   normalizedDescription,
    notes:         typeof notes === 'string' ? notes : undefined,
    durationMinutes: typeof duration_minutes === 'number' ? duration_minutes : undefined,
    icsUid,
  }, storeIds);

  if (!interview) { notFound(res, 'Candidato non trovato'); return; }

  const candidateDetails = await queryOne<{
    email: string | null;
    full_name: string | null;
    store_timezone: string | null;
    store_address: string | null;
    store_cap: string | null;
    store_city: string | null;
    store_name: string | null;
  }>(
    `SELECT c.email, c.full_name,
            st.timezone AS store_timezone, st.address AS store_address, st.cap AS store_cap, st.city AS store_city, st.name AS store_name
     FROM candidates c
     LEFT JOIN stores st ON st.id = c.store_id
     WHERE c.id = $1 LIMIT 1`,
    [candidateId]
  );
  const targetTimezone = safeDisplayTimezone(candidateDetails?.store_timezone);

  // Create notification logs for tracking
  const notificationPromises: Promise<void>[] = [];

  // Notify the assigned interviewer in their own locale (resolved inside sendNotification from DB)
  if (typeof interviewer_id === 'number') {
    const interviewerRow = await queryOne<{ locale?: string | null; role?: string | null; email?: string | null; name?: string; surname?: string }>(
      `SELECT locale, role, email, name, surname FROM users WHERE id = $1 LIMIT 1`,
      [interviewer_id],
    );
    const interviewerLocale = interviewerRow?.locale ?? 'it';
    const dateLocale = interviewerLocale === 'it' ? 'it-IT' : 'en-GB';
    const inviteEnabled = await isNotificationEnabledForRole(
      companyId,
      'ats.interview_invite',
      interviewerRow?.role ?? null,
    );

    // Send in-app notification
    if (inviteEnabled) {
      const interviewerNotifLog = await createInterviewNotificationLog(
        interview.id,
        'in_app',
        'interviewer'
      );

      if (interviewerNotifLog) {
        const scheduledTime = scheduledDate.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit', timeZone: targetTimezone });
        const candidateName = candidateDetails?.full_name?.trim()
          || (interviewerLocale === 'it' ? 'il candidato' : 'the candidate');
        const isInPerson = normalizedInterviewType === 'in_person';
        const rawStoreAddr = [candidateDetails?.store_address, candidateDetails?.store_cap, candidateDetails?.store_city].filter(Boolean).join(', ');
        const fallbackAddr = rawStoreAddr || candidateDetails?.store_name || '';
        const effectiveLocation = isInPerson
          ? (typeof location === 'string' && location.trim() ? location.trim() : fallbackAddr)
          : '';
        const locationSuffix = isInPerson && effectiveLocation
          ? (interviewerLocale === 'it' ? ` presso ${effectiveLocation}` : ` at ${effectiveLocation}`)
          : '';

        notificationPromises.push(
          updateInterviewNotificationLog(interviewerNotifLog.id, 'sending')
            .then(() => sendNotification({
              companyId,
              userId: interviewer_id,
              type: 'ats.interview_invite',
              title:   t(interviewerLocale, 'notifications.ats_interview_invite.title'),
              message: t(interviewerLocale, 'notifications.ats_interview_invite.message', {
                candidate: candidateName,
                date: scheduledDate.toLocaleDateString(dateLocale, { timeZone: targetTimezone }),
                time: scheduledTime,
                location: locationSuffix,
              }),
              priority: 'high',
              locale: interviewerLocale,
              channels: ['in_app'],
            }))
            .then(() => updateInterviewNotificationLog(interviewerNotifLog.id, 'done'))
            .catch((err) => updateInterviewNotificationLog(
              interviewerNotifLog.id,
              'error',
              err instanceof Error ? err.message : String(err)
            ))
        );
      }
    }

    const smtpEnabled = await isSmtpConfigured(companyId);
    if (smtpEnabled) {
      const nameParts = (candidateDetails?.full_name ?? '').split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      
      const storeRow = await queryOne<{ name: string }>(
        `SELECT s.name FROM stores s JOIN candidates c ON c.store_id = s.id WHERE c.id = $1 LIMIT 1`,
        [candidateId]
      );
      const storeName = storeRow?.name ?? 'Store';

      // Candidate email
      if (candidateDetails?.email) {
        const candidateEmailLog = await createInterviewNotificationLog(
          interview.id,
          'email',
          'candidate',
          candidateDetails.email
        );
        if (candidateEmailLog) {
          notificationPromises.push(
            sendProfessionalInterviewEmail({
              interviewId: interview.id,
              companyId,
              recipientEmail: candidateDetails.email,
              recipientName: candidateDetails.full_name ?? '',
              recipientType: 'candidate',
              logId: candidateEmailLog.id,
              req,
              firstName,
              lastName,
              storeName
            })
          );
        }
      }

      // Interviewer email
      if (typeof interviewer_id === 'number') {
        const interviewerRow = await queryOne<{ email: string | null; name: string; surname: string }>(
          `SELECT email, name, surname FROM users WHERE id = $1 LIMIT 1`,
          [interviewer_id],
        );
        if (interviewerRow?.email) {
          const interviewerEmailLog = await createInterviewNotificationLog(
            interview.id,
            'email',
            'interviewer',
            interviewerRow.email
          );
          if (interviewerEmailLog) {
            notificationPromises.push(
              sendProfessionalInterviewEmail({
                interviewId: interview.id,
                companyId,
                recipientEmail: interviewerRow.email,
                recipientName: `${interviewerRow.name} ${interviewerRow.surname}`,
                recipientType: 'interviewer',
                logId: interviewerEmailLog.id,
                req,
                firstName,
                lastName,
                storeName
              })
            );
          }
        }
      }
    }
  }

  // Execute all notifications in parallel (don't wait for completion)
  Promise.allSettled(notificationPromises).catch(() => {
    // Silently handle notification failures - they're logged in the notification_logs table
  });

  created(res, { interview }, 'Colloquio programmato');
});

export const updateInterviewHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  // Get the interview to determine the company_id
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const interviewRow = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM interviews WHERE id = $1 LIMIT 1`,
    [id],
  );
  
  if (!interviewRow) { notFound(res, 'Colloquio non trovato'); return; }
  if (!allowedCompanyIds.includes(interviewRow.company_id)) { 
    forbidden(res, 'Nessuna azienda valida selezionata'); 
    return; 
  }

  const companyId = interviewRow.company_id;

  const { scheduled_at, interview_type, location, description, notes, duration_minutes, feedback, interviewer_id } = req.body as Record<string, unknown>;

  const role = req.user?.role;
  const feedbackOnlyRole = role === 'store_manager';
  if (feedbackOnlyRole) {
    const hasRestrictedFields =
      scheduled_at !== undefined ||
      interview_type !== undefined ||
      location !== undefined ||
      description !== undefined ||
      notes !== undefined ||
      duration_minutes !== undefined ||
      interviewer_id !== undefined;

    if (hasRestrictedFields) {
      forbidden(res, 'Store manager può aggiornare solo il feedback del colloquio');
      return;
    }

    if (typeof feedback !== 'string' || feedback.trim() === '') {
      badRequest(res, 'Il feedback è obbligatorio', 'VALIDATION_ERROR');
      return;
    }
  }

  const storeIds = resolveStoreIds(req.user);
  const updated = await updateInterview(id, companyId, {
    scheduledAt:   typeof scheduled_at === 'string' ? new Date(scheduled_at).toISOString() : undefined,
    interviewType: isInterviewType(interview_type)
    ? interview_type : undefined,
    location:      typeof location === 'string' ? location : undefined,
    description:   typeof description === 'string' ? description : undefined,
    notes:         typeof notes === 'string' ? notes : undefined,
    durationMinutes: typeof duration_minutes === 'number' ? duration_minutes : undefined,
    feedback:      typeof feedback === 'string' ? feedback : undefined,
    interviewerId:
      typeof interviewer_id === 'number' ? interviewer_id :
      interviewer_id === null ? null : undefined,
  }, storeIds);

  if (!updated) { notFound(res, 'Colloquio non trovato'); return; }
  ok(res, { interview: updated }, 'Colloquio aggiornato');
});

export const deleteInterviewHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  // Get the interview to determine the company_id
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const interviewRow = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM interviews WHERE id = $1 LIMIT 1`,
    [id],
  );
  
  if (!interviewRow) { notFound(res, 'Colloquio non trovato'); return; }
  if (!allowedCompanyIds.includes(interviewRow.company_id)) { 
    forbidden(res, 'Nessuna azienda valida selezionata'); 
    return; 
  }

  const companyId = interviewRow.company_id;

  const deleted = await deleteInterview(id, companyId);
  if (!deleted) { notFound(res, 'Colloquio non trovato'); return; }
  ok(res, {}, 'Colloquio eliminato');
});

// ---------------------------------------------------------------------------
// Alerts + Risks
// ---------------------------------------------------------------------------

export const getAlertsHandler = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const scopedCompanyIds = resolveAtsCompanyScope(req, allowedCompanyIds);
  if (!scopedCompanyIds) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const storeIds = resolveStoreIds(req.user);
  const alerts = (await Promise.all(
    scopedCompanyIds.map((companyId) => getHRAlerts(companyId, storeIds)),
  )).flat();
  ok(res, { alerts });
});

export const getRisksHandler = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const scopedCompanyIds = resolveAtsCompanyScope(req, allowedCompanyIds);
  if (!scopedCompanyIds) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const risks = (await Promise.all(
    scopedCompanyIds.map((companyId) => evaluateAllJobRisks(companyId)),
  )).flat();
  ok(res, { risks });
});

export const getIndeedStatsHandler = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const isSuperAdmin = req.user!.is_super_admin === true;
  
  let companyId: number | null = null;
  
  const explicitCompanyId = typeof req.query.company_id === 'string'
    ? Number.parseInt(req.query.company_id, 10)
    : null;

  if (explicitCompanyId !== null && !Number.isNaN(explicitCompanyId)) {
    if (!allowedCompanyIds.includes(explicitCompanyId)) {
      forbidden(res, 'Nessuna azienda valida selezionata');
      return;
    }
    companyId = explicitCompanyId;
  } else if (!isSuperAdmin) {
    companyId = req.user!.companyId ?? allowedCompanyIds[0];
  }

  const stats = await getIndeedStats(companyId);
  
  let companySlug = 'all';
  if (companyId) {
    const comp = await queryOne<{ slug: string }>('SELECT slug FROM companies WHERE id = $1', [companyId]);
    if (comp) {
      companySlug = comp.slug;
    }
  }
  
  // Company's own stored token (encrypted, DB) → environment → null.
  const apiToken = await resolveIndeedApiToken(companyId, companySlug);
  const isIndeedApplyConfigured = !!apiToken;
  const isDispositionSyncReal = !!(apiToken && apiToken !== 'mock_veylohr_indeed_token_2026');

  ok(res, {
    ...stats,
    isIndeedApplyConfigured,
    isDispositionSyncReal,
    companySlug,
  });
});

// ---------------------------------------------------------------------------
// Public job feed (no auth) — Indeed XML + generic RSS feed
// ---------------------------------------------------------------------------

function wrapCdata(value: string): string {
  // Trim leading/trailing whitespace so Indeed does not read padded values
  // like " FUSARO UOMO " (it interprets the surrounding spaces literally).
  const trimmed = (value ?? '').trim();
  return `<![CDATA[${trimmed.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

// Indeed penalises job titles that embed the location, and the city is already
// carried in the dedicated <city> tag. Remove the city (as a standalone word,
// optionally after a - – , separator) and collapse any repeated whitespace.
function cleanFeedTitle(rawTitle: string, city: string): string {
  let out = (rawTitle ?? '').replace(/\s+/g, ' ').trim();
  const c = (city ?? '').trim();
  if (c && c.toLowerCase() !== 'remote') {
    const escaped = c
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // A city is often written in the title without its internal separator,
      // so "San Remo" must also strip a title that says "Sanremo".
      .replace(/\s+/g, "[\\s'’-]*");
    out = out.replace(new RegExp(`\\s*[-–,]?\\s*\\b${escaped}\\b`, 'gi'), ' ');
  }
  out = out.replace(/\s+/g, ' ').replace(/[\s\-–,]+$/g, '').trim();
  // Never return an empty title if the whole thing was the city name.
  return out || (rawTitle ?? '').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function sanitizeFeedDescription(input: string): string {
  const cleaned = sanitizeHtml(input, {
    allowedTags: ['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'ul', 'ol', 'li'],
    allowedAttributes: {},
    parser: { lowerCaseTags: true },
    enforceHtmlBoundary: true,
  });

  return decodeHtmlEntities(cleaned).trim();
}

function normalizeJobType(value: string): 'fulltime' | 'parttime' | 'contract' | 'internship' {
  const normalized = value.toLowerCase();
  if (normalized === 'parttime' || normalized === 'part_time') return 'parttime';
  if (normalized === 'fulltime' || normalized === 'full_time') return 'fulltime';
  if (normalized === 'contract') return 'contract';
  if (normalized === 'internship' || normalized === 'intern') return 'internship';
  return 'fulltime';
}

function normalizeLanguage(value: string): 'it' | 'en' | 'it,en' {
  const normalized = value.toLowerCase();
  if (normalized === 'en') return 'en';
  if (normalized === 'both' || normalized === 'it,en') return 'it,en';
  return 'it';
}

function normalizeCountryCode(value: string): string {
  const clean = value.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(clean)) return clean;
  return 'IT';
}

function resolveFrontendBase(req: Request): string {
  const raw = process.env.APP_BASE_URL ?? process.env.FRONTEND_URL ?? process.env.PUBLIC_APP_URL ?? process.env.CORS_ORIGIN?.split(',')[0];
  if (raw && raw.trim() !== '') {
    return raw.replace(/\/+$/, '');
  }

  const host = req.get('host');
  if (host) {
    return `${req.protocol}://${host}`.replace(/\/+$/, '');
  }

  return 'http://localhost:5173';
}

function resolveBackendBase(req: Request): string {
  const raw = process.env.PUBLIC_API_URL ?? process.env.BACKEND_URL ?? process.env.API_URL ?? process.env.APP_BASE_URL;
  if (raw && raw.trim() !== '') {
    const cleaned = raw.trim().replace(/\/+$/, '');
    return cleaned.endsWith('/api') ? cleaned.slice(0, -4) : cleaned;
  }

  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || req.get('host');
  if (host) {
    return `${forwardedProto || req.protocol}://${host}`.replace(/\/+$/, '');
  }

  return 'http://localhost:3001';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function findEmailLogoPath(): string | null {
  const candidates = [
    process.env.EMAIL_LOGO_PATH,
    path.resolve(process.cwd(), '../hr-system-demo-frontend/public/IMG_5144.png'),
    path.resolve(process.cwd(), 'public/IMG_5144.png'),
    path.resolve(process.cwd(), '../frontend/public/IMG_5144.png'),
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function getPdfTokenSecret(): string {
  return process.env.JWT_SECRET ?? process.env.QR_SECRET ?? 'ats-pdf-token-secret';
}

export function signCandidatePdfToken(candidateId: number, companyId: number, interviewId: number, recipientType: 'candidate' | 'interviewer'): string {
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  const payload = `${candidateId}.${companyId}.${interviewId}.${recipientType}.${expiresAt}`;
  const signature = crypto.createHmac('sha256', getPdfTokenSecret()).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

export function verifyCandidatePdfToken(token: string, expectedCandidateId: number): { companyId: number; interviewId: number; recipientType: 'candidate' | 'interviewer' } | null {
  const parts = token.split('.');
  if (parts.length !== 5 && parts.length !== 6) return null;

  let candidateIdRaw: string;
  let companyIdRaw: string;
  let interviewIdRaw: string;
  let expiresAtRaw: string;
  let signature: string;
  let recipientType: 'candidate' | 'interviewer' = 'candidate';

  if (parts.length === 6) {
    const recipientTypeRaw = parts[3];
    recipientType = recipientTypeRaw === 'interviewer' ? 'interviewer' : 'candidate';
    [candidateIdRaw, companyIdRaw, interviewIdRaw, , expiresAtRaw, signature] = parts;
  } else {
    // Old token format (parts.length === 5)
    [candidateIdRaw, companyIdRaw, interviewIdRaw, expiresAtRaw, signature] = parts;
  }

  const candidateId = Number.parseInt(candidateIdRaw, 10);
  const companyId = Number.parseInt(companyIdRaw, 10);
  const interviewId = Number.parseInt(interviewIdRaw, 10);
  const expiresAt = Number.parseInt(expiresAtRaw, 10);

  if (
    Number.isNaN(candidateId)
    || Number.isNaN(companyId)
    || Number.isNaN(interviewId)
    || Number.isNaN(expiresAt)
    || candidateId !== expectedCandidateId
    || expiresAt < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }

  let payload: string;
  if (parts.length === 6) {
    payload = `${candidateId}.${companyId}.${interviewId}.${parts[3]}.${expiresAt}`;
  } else {
    payload = `${candidateId}.${companyId}.${interviewId}.${expiresAt}`;
  }

  const expected = crypto.createHmac('sha256', getPdfTokenSecret()).update(payload).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');

  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    return null;
  }

  return { companyId, interviewId, recipientType };
}

function pdfText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, '')
    .trim();
}

function parseCandidateSourceProfile(sourceRef: unknown): Record<string, string> {
  if (typeof sourceRef !== 'string' || !sourceRef.trim()) return {};
  try {
    const parsed = JSON.parse(sourceRef) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
        .map(([key, value]) => [key, String(value).trim()]),
    );
  } catch {
    return {};
  }
}

function formatPdfDate(value: unknown, timeZone: string = 'Europe/Rome'): string {
  if (value === null || value === undefined || value === '') return '-';
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return pdfText(value);
  return date.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

async function buildCandidateProfilePdf(candidateId: number, companyId: number, recipientType: 'candidate' | 'interviewer' = 'candidate'): Promise<Buffer | null> {
  const candidate = await queryOne<Record<string, unknown>>(
    `SELECT c.*,
            jp.title AS position_title,
            co.name AS company_name,
            s.name AS store_name,
            s.timezone AS store_timezone
     FROM candidates c
     LEFT JOIN job_postings jp ON jp.id = c.job_posting_id
     LEFT JOIN companies co ON co.id = c.company_id
     LEFT JOIN stores s ON s.id = COALESCE(c.store_id, jp.store_id)
     WHERE c.id = $1 AND c.company_id = $2
     LIMIT 1`,
    [candidateId, companyId],
  );

  if (!candidate) return null;

  // Render dates in the candidate's store timezone (falls back to Europe/Rome).
  const storeTz = safeDisplayTimezone(candidate.store_timezone as string | null);

  const candidateComments = await query<Record<string, unknown>>(
    `SELECT cc.body, cc.created_at, u.name, u.surname, u.role
     FROM candidate_comments cc
     JOIN users u ON u.id = cc.user_id AND u.company_id = $2
     WHERE cc.candidate_id = $1
     ORDER BY cc.created_at ASC`,
    [candidateId, companyId],
  );

  const interviewFeedback = await query<Record<string, unknown>>(
    `SELECT ifc.body, ifc.created_at, u.name, u.surname, u.role,
            i.scheduled_at, i.interview_type
     FROM interview_feedback_comments ifc
     JOIN interviews i ON i.id = ifc.interview_id
     JOIN candidates c ON c.id = i.candidate_id
     JOIN users u ON u.id = ifc.user_id AND u.company_id = $2
     WHERE c.id = $1 AND c.company_id = $2
     ORDER BY ifc.created_at ASC`,
    [candidateId, companyId],
  );

  const profile = parseCandidateSourceProfile(candidate.source_ref);
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const pageSize: [number, number] = [595.28, 841.89];
  const margin = 48;
  let page = pdfDoc.addPage(pageSize);
  let y = pageSize[1] - margin;

  const drawLine = (text: string, options: { size?: number; bold?: boolean; italic?: boolean; color?: ReturnType<typeof rgb>; indent?: number } = {}) => {
    const size = options.size ?? 10;
    const activeFont = options.bold ? fontBold : options.italic ? fontItalic : font;
    const x = margin + (options.indent ?? 0);
    const maxWidth = pageSize[0] - margin * 2 - (options.indent ?? 0);
    const words = pdfText(text).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';

    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (activeFont.widthOfTextAtSize(next, size) <= maxWidth) {
        line = next;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    if (lines.length === 0) lines.push('');

    for (const current of lines) {
      if (y < 70) {
        page = pdfDoc.addPage(pageSize);
        y = pageSize[1] - margin;
      }
      page.drawText(current, {
        x,
        y,
        size,
        font: activeFont,
        color: options.color ?? rgb(0.12, 0.16, 0.22),
      });
      y -= size + 6;
    }
  };

  const section = (title: string) => {
    y -= 10;
    if (y < 90) {
      page = pdfDoc.addPage(pageSize);
      y = pageSize[1] - margin;
    }
    page.drawRectangle({
      x: margin,
      y: y - 8,
      width: pageSize[0] - margin * 2,
      height: 24,
      color: rgb(0.94, 0.96, 0.98),
    });
    drawLine(title, { size: 12, bold: true, color: rgb(0.05, 0.13, 0.22) });
    y -= 8;
  };

  const field = (label: string, value: unknown) => {
    const display = pdfText(value) || '-';
    drawLine(`${label}: ${display}`, { size: 10 });
  };

  page.drawRectangle({
    x: 0,
    y: pageSize[1] - 110,
    width: pageSize[0],
    height: 110,
    color: rgb(0.05, 0.13, 0.22),
  });
  page.drawText('VEYLO HR', { x: margin, y: pageSize[1] - 52, size: 15, font: fontBold, color: rgb(0.95, 0.78, 0.35) });
  page.drawText(recipientType === 'interviewer' ? 'Candidate Profile & Comments' : 'Candidate Profile', { x: margin, y: pageSize[1] - 82, size: 21, font: fontBold, color: rgb(1, 1, 1) });
  page.drawText(`Generated: ${formatPdfDate(new Date().toISOString(), storeTz)}`, { x: margin, y: pageSize[1] - 100, size: 8.5, font, color: rgb(0.82, 0.87, 0.93) });
  y = pageSize[1] - 145;

  section('Candidate data');
  field('Full name', candidate.full_name);
  field('Status', candidate.status);
  field('Email', candidate.email);
  field('Phone', candidate.phone);
  field('LinkedIn', candidate.linkedin_url);
  field('CV / Resume file', candidate.resume_path);
  field('Company', candidate.company_name);
  field('Store', candidate.store_name);
  field('Position', candidate.position_title);
  field('Tags', Array.isArray(candidate.tags) ? (candidate.tags as string[]).join(', ') : '');
  field('Applied at', candidate.applied_at ?? candidate.created_at);
  field('Last stage change', candidate.last_stage_change);

  section('Application profile');
  const profileFields: Array<[string, string[]]> = [
    ['Availability', ['availability', 'availableStartDate', 'available_start_date']],
    ['Current employer', ['currentEmployer', 'current_employer']],
    ['Current role', ['currentRole', 'current_role']],
    ['Nationality', ['nationality']],
    ['Gender', ['gender']],
    ['Date of birth', ['dateOfBirth', 'date_of_birth']],
    ['Address', ['address']],
    ['City', ['city']],
    ['State', ['state']],
    ['Country', ['country']],
    ['Postal code', ['postalCode', 'postal_code']],
    ['Application source', ['applicationSource', 'application_source']],
    ['Application channel', ['applicationChannel', 'application_channel']],
  ];
  for (const [label, keys] of profileFields) {
    field(label, keys.map((key) => profile[key]).find(Boolean));
  }
  if (candidate.cover_letter) {
    y -= 6;
    drawLine('Cover letter:', { bold: true });
    drawLine(candidate.cover_letter as string, { indent: 14 });
  }

  if (recipientType === 'interviewer') {
    section('Candidate comments');
    if (candidateComments.length === 0) {
      drawLine('No candidate comments recorded.', { italic: true, color: rgb(0.42, 0.46, 0.53) });
    } else {
      candidateComments.forEach((comment, index) => {
        const author = `${comment.name ?? ''} ${comment.surname ?? ''}`.trim() || 'User';
        drawLine(`${index + 1}. ${author} (${comment.role ?? '-'}) - ${formatPdfDate(comment.created_at as string, storeTz)}`, { bold: true });
        drawLine(comment.body as string, { indent: 14 });
        y -= 4;
      });
    }

    section('Interview feedback');
    if (interviewFeedback.length === 0) {
      drawLine('No interview feedback recorded.', { italic: true, color: rgb(0.42, 0.46, 0.53) });
    } else {
      interviewFeedback.forEach((comment, index) => {
        const author = `${comment.name ?? ''} ${comment.surname ?? ''}`.trim() || 'User';
        const interviewLabel = `${comment.interview_type === 'phone' ? 'Phone' : 'In-person'} interview ${formatPdfDate(comment.scheduled_at as string)}`;
        drawLine(`${index + 1}. ${author} (${comment.role ?? '-'}) - ${formatPdfDate(comment.created_at as string, storeTz)}`, { bold: true });
        drawLine(interviewLabel, { italic: true, indent: 14, color: rgb(0.42, 0.46, 0.53) });
        drawLine(comment.body as string, { indent: 14 });
        y -= 4;
      });
    }
  }

  return Buffer.from(await pdfDoc.save());
}

export const candidateProfilePdfHandler = asyncHandler(async (req: Request, res: Response) => {
  const candidateId = Number.parseInt(req.params.candidateId, 10);
  if (Number.isNaN(candidateId)) {
    badRequest(res, 'ID candidato non valido');
    return;
  }

  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const verified = token ? verifyCandidatePdfToken(token, candidateId) : null;
  if (!verified) {
    forbidden(res, 'Link PDF non valido o scaduto');
    return;
  }

  const pdf = await buildCandidateProfilePdf(candidateId, verified.companyId, verified.recipientType);
  if (!pdf) {
    notFound(res, 'Candidato non trovato');
    return;
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="candidate-${candidateId}-profile.pdf"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(pdf);
});

export const translatePreviewHandler = asyncHandler(async (req: Request, res: Response) => {
  const { text, source_language } = req.body as { text?: unknown; source_language?: unknown };

  if (typeof text !== 'string' || text.trim() === '') {
    badRequest(res, 'Testo da tradurre mancante', 'VALIDATION_ERROR');
    return;
  }

  const sourceLanguage = typeof source_language === 'string' && ['it', 'en', 'both'].includes(source_language.toLowerCase())
    ? source_language.toLowerCase()
    : undefined;

  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) {
    res.status(503).json({ success: false, error: 'GOOGLE_TRANSLATE_API_KEY non configurata', code: 'TRANSLATE_NOT_CONFIGURED' });
    return;
  }

  const payload: Record<string, unknown> = {
    q: text,
    target: 'en',
    format: 'text',
  };
  if (sourceLanguage && sourceLanguage !== 'both') {
    payload.source = sourceLanguage;
  }

  const response = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    res.status(502).json({ success: false, error: 'Errore Google Translate', details: body, code: 'TRANSLATE_PROVIDER_ERROR' });
    return;
  }

  const data = await response.json() as {
    data?: {
      translations?: Array<{ translatedText?: string }>;
    };
  };

  const translated = data.data?.translations?.[0]?.translatedText;
  if (!translated) {
    res.status(502).json({ success: false, error: 'Traduzione non disponibile', code: 'TRANSLATE_EMPTY' });
    return;
  }

  ok(res, {
    translatedText: decodeHtmlEntities(translated),
    targetLanguage: 'en',
    provider: 'google_translate',
  });
});

function normalizeState(state: string | null | undefined, city: string | null | undefined): string {
  return resolveItalianProvince(city || '', state || '');
}

export const jobFeedHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { slug } = req.params;
    const { company, jobs } = await getPublishedJobsForFeed(slug);

    if (!company) {
      // Respond with a proper 404 AND a valid XML document (not plain text),
      // so crawlers and clients get a well-formed, correctly-typed response.
      res
        .status(404)
        .type('application/xml; charset=UTF-8')
        .send('<?xml version="1.0" encoding="UTF-8"?>\n<source>\n  <error code="404">Company not found</error>\n</source>');
      return;
    }

    const frontendBase = resolveFrontendBase(req);
    const encodedCompanySlug = encodeURIComponent(company.slug);
    const publisherUrl = company.slug === 'all'
      ? `${frontendBase}/careers`
      : `${frontendBase}/careers/${encodedCompanySlug}`;

    // Resolve each company's Indeed Apply token ONCE (company DB value → env),
    // so the per-job loop below stays synchronous and does not query per row.
    const tokenByCompany = new Map<number, string | null>();
    const distinctCompanyIds = Array.from(
      new Set(jobs.map((j) => j.companyId).filter((v): v is number => typeof v === 'number')),
    );
    for (const cid of distinctCompanyIds) {
      const slug = jobs.find((j) => j.companyId === cid)?.companySlug || company.slug;
      tokenByCompany.set(cid, await resolveIndeedApiToken(cid, slug));
    }

    const jobItems = jobs
      .map((job) => {
        const isFullRemote = job.remoteType === 'remote';
        let city = (job.city ?? '').trim() || (isFullRemote ? 'Remote' : '');
        if (city) {
          city = city
            .replace(/Città metropolitana di\s+/i, '')
            .replace(/\s+Capitale/i, '')
            .trim();
        }
        let country = normalizeCountryCode((job.country ?? 'IT').trim() || 'IT');

        if (!city || !country) {
          if (!city) {
            city = 'Remote';
          }
          if (!country) {
            country = 'IT';
          }
          console.log(`Warning: job ${job.id} missing location — using fallback values`);
        }

        const pubDate = new Date(job.publishedAt ?? job.createdAt).toISOString();
        // Feed title excludes the location (kept in <city>) and has no double spaces.
        const title = cleanFeedTitle(job.title, city);
        const descriptionRaw = job.description ?? job.title;
        const description = sanitizeFeedDescription(descriptionRaw) || `<p>${title}</p>`;

        const state = isFullRemote ? '' : normalizeState(job.state, city);
        const postalCode = isFullRemote ? '' : (job.postalCode ?? '').trim();
        const streetAddress = isFullRemote ? '' : (job.address ?? '').trim();

        const language = normalizeLanguage(job.language);
        const jobType = normalizeJobType(job.jobType);
        const referenceNumber = job.referenceId || `JOB-${job.id}`;
        const jobCompanySlug = encodeURIComponent(job.companySlug);
        const baseJobUrl = `${frontendBase}/careers/${jobCompanySlug}/jobs/${job.id}`;
        const jobUrl = baseJobUrl + (baseJobUrl.includes('?') ? '&' : '?') + 'source=Indeed';
        const salaryText = buildSalaryText(job.salaryMin, job.salaryMax, job.salaryPeriod ?? null);
        const category = (job.category ?? '').trim() || (job.tags.length > 0 ? job.tags.join(', ') : '');
        const experience = (job.experience ?? '').trim();
        const education = (job.education ?? '').trim();

        const expirationDate = job.expirationDate
          ? new Date(job.expirationDate).toISOString()
          : null;
        // Company's own stored token (encrypted, DB) → environment → null.
        const configuredApiToken = (job.companyId != null ? tokenByCompany.get(job.companyId) : null) ?? null;
        // Native "Apply on Indeed" is advertised ONLY when a real token is configured.
        // Without one (partnership not signed / placeholder), we omit <indeed-apply-data>
        // entirely so Indeed routes candidates to the job <url> (the Careers page) rather
        // than to a channel that would silently reject applications on a fake token.
        // Re-enabling later is a one-line env change (set INDEED_APPLY_API_TOKEN).
        const hasRealIndeedApplyToken =
          !!configuredApiToken && configuredApiToken !== 'mock_veylohr_indeed_token_2026';

        const baseUrl = process.env.APP_BASE_URL || 'https://veylohr.com';
        let indeedApplyData = '';
        if (hasRealIndeedApplyToken) {
          const indeedApplyParams = new URLSearchParams({
            'indeed-apply-apiToken': configuredApiToken as string,
            'indeed-apply-jobUrl': jobUrl,
            'indeed-apply-jobTitle': title,
            'indeed-apply-jobLocation': `${city}, ${country}`,
            'indeed-apply-jobCompanyName': job.companyName || company.name,
            'indeed-apply-jobId': String(job.id),
            'indeed-apply-postUrl': `${baseUrl}/api/public/indeed-apply/${job.companySlug}`,
            'indeed-apply-name': 'true',
            'indeed-apply-email': 'true',
            'indeed-apply-resume': 'true',
            'indeed-apply-coverletter': 'optional',
            'indeed-apply-phone': 'optional',
            'indeed-apply-questions': `${baseUrl}/api/public/indeed-apply-questions/${job.companySlug}/${job.id}`
          });
          indeedApplyData = indeedApplyParams.toString();
        }

        const xmlFields: string[] = [
          '  <job>',
          `    <title>${wrapCdata(title)}</title>`,
          `    <date>${wrapCdata(pubDate)}</date>`,
          `    <referencenumber>${wrapCdata(referenceNumber)}</referencenumber>`,
          `    <requisitionid>${wrapCdata(`REQ-${job.id}`)}</requisitionid>`,
          `    <url>${wrapCdata(jobUrl)}</url>`,
          `    <company>${wrapCdata(job.companyName || company.name)}</company>`,
          `    <sourcename>${wrapCdata(job.companyGroupName || job.companyName || company.name)}</sourcename>`,
          ...(indeedApplyData
            ? [`    <indeed-apply-data>${wrapCdata(indeedApplyData)}</indeed-apply-data>`]
            : []),
          `    <city>${wrapCdata(city)}</city>`,
        ];

        // Emitted only when the company actually has an address on record.
        // Previously this fell back to a hardcoded tenant address, which
        // published one client's contact email against every other client's jobs.
        const feedEmail = job.companyEmail || company.companyEmail;
        if (feedEmail) {
          xmlFields.splice(-2, 0, `    <email>${wrapCdata(feedEmail)}</email>`);
        }

        if (state) {
          xmlFields.push(`    <state>${wrapCdata(state)}</state>`);
        }
        if (country) {
          xmlFields.push(`    <country>${wrapCdata(country)}</country>`);
        }
        if (postalCode) {
          xmlFields.push(`    <postalcode>${wrapCdata(postalCode)}</postalcode>`);
        }
        if (streetAddress) {
          xmlFields.push(`    <streetaddress>${wrapCdata(streetAddress)}</streetaddress>`);
        }

        xmlFields.push(`    <description>${wrapCdata(description)}</description>`);
        xmlFields.push(`    <jobtype>${wrapCdata(jobType)}</jobtype>`);
        xmlFields.push(`    <language>${wrapCdata(language)}</language>`);

        if (salaryText) {
          xmlFields.push(`    <salary>${wrapCdata(salaryText)}</salary>`);
        }

        if (category) {
          xmlFields.push(`    <category>${wrapCdata(category)}</category>`);
        }

        if (experience) {
          xmlFields.push(`    <experience>${wrapCdata(experience)}</experience>`);
        }

        if (education) {
          xmlFields.push(`    <education>${wrapCdata(education)}</education>`);
        }

        if (expirationDate && expirationDate !== 'Invalid Date') {
          xmlFields.push(`    <expirationdate>${wrapCdata(expirationDate)}</expirationdate>`);
        }

        const isHybrid = job.remoteType === 'hybrid';
        if (isFullRemote) {
          xmlFields.push(`    <remotetype>${wrapCdata('Fully remote')}</remotetype>`);
        } else if (isHybrid) {
          xmlFields.push(`    <remotetype>${wrapCdata('Hybrid remote')}</remotetype>`);
        }

        xmlFields.push('  </job>');
        return xmlFields.join('\n');
      })
      .filter((item): item is string => item !== null)
      .join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<source>
  <publisher>${wrapCdata(company.name)}</publisher>
  <publisherurl>${wrapCdata(publisherUrl)}</publisherurl>
  <lastBuildDate>${wrapCdata(new Date().toISOString())}</lastBuildDate>
${jobItems}
</source>`;

    res.setHeader('Content-Type', 'application/xml; charset=UTF-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(xml);
  } catch (err) {
    res.status(500).type('text/plain').send('Internal server error');
  }
};

// ---------------------------------------------------------------------------
// Candidate Comments
// ---------------------------------------------------------------------------

export const listCandidateCommentsHandler = asyncHandler(async (req: Request, res: Response) => {
  const candidateId = parseInt(req.params.candidateId, 10);
  if (Number.isNaN(candidateId)) { badRequest(res, 'ID non valido'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const candidateRow = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM candidates WHERE id = $1 LIMIT 1`,
    [candidateId],
  );
  if (!candidateRow) { notFound(res, 'Candidato non trovato'); return; }
  if (!allowedCompanyIds.includes(candidateRow.company_id)) { forbidden(res, 'Azienda non autorizzata'); return; }

  const storeIds = resolveStoreIds(req.user);
  const comments = await listCandidateComments(candidateId, candidateRow.company_id, storeIds);
  ok(res, { comments });
});

export const addCandidateCommentHandler = asyncHandler(async (req: Request, res: Response) => {
  const candidateId = parseInt(req.params.candidateId, 10);
  if (Number.isNaN(candidateId)) { badRequest(res, 'ID non valido'); return; }
  
  const { body } = req.body as Record<string, unknown>;
  if (typeof body !== 'string' || !body.trim()) { badRequest(res, 'Il commento è obbligatorio'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const candidateRow = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM candidates WHERE id = $1 LIMIT 1`,
    [candidateId],
  );
  if (!candidateRow) { notFound(res, 'Candidato non trovato'); return; }
  if (!allowedCompanyIds.includes(candidateRow.company_id)) { forbidden(res, 'Azienda non autorizzata'); return; }

  const storeIds = resolveStoreIds(req.user);
  const comment = await addCandidateComment(candidateId, req.user!.userId, candidateRow.company_id, body.trim(), storeIds);
  if (!comment) { notFound(res, 'Candidato non trovato'); return; }

  created(res, { comment }, 'Commento aggiunto');
});

export const deleteCandidateCommentHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  // HR or Admin check
  if (req.user?.role !== 'admin' && req.user?.role !== 'hr') {
    forbidden(res, 'Solo HR o Admin possono eliminare i commenti');
    return;
  }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const storeIds = resolveStoreIds(req.user);
  const commentRow = await queryOne<{ company_id: number }>(
    `SELECT c.company_id FROM candidate_comments cc
     JOIN candidates c ON c.id = cc.candidate_id
     WHERE cc.id = $1 LIMIT 1`,
     [id]
  );
  if (!commentRow) { notFound(res, 'Commento non trovato'); return; }
  if (!allowedCompanyIds.includes(commentRow.company_id)) { forbidden(res, 'Azienda non autorizzata'); return; }

  const deleted = await deleteCandidateComment(id, commentRow.company_id, storeIds);
  if (!deleted) { notFound(res, 'Commento non trovato'); return; }
  
  ok(res, {}, 'Commento eliminato');
});

// ---------------------------------------------------------------------------
// Interview Feedback Comments
// ---------------------------------------------------------------------------

export const listInterviewFeedbackCommentsHandler = asyncHandler(async (req: Request, res: Response) => {
  const interviewId = parseInt(req.params.interviewId, 10);
  if (Number.isNaN(interviewId)) { badRequest(res, 'ID non valido'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const interviewRow = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM interviews WHERE id = $1 LIMIT 1`,
    [interviewId],
  );
  if (!interviewRow) { notFound(res, 'Colloquio non trovato'); return; }
  if (!allowedCompanyIds.includes(interviewRow.company_id)) { forbidden(res, 'Azienda non autorizzata'); return; }

  const storeIds = resolveStoreIds(req.user);
  const comments = await listInterviewFeedbackComments(interviewId, interviewRow.company_id, storeIds);
  ok(res, { comments });
});

export const listAllInterviewFeedbackCommentsHandler = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const scope = resolveAtsCompanyScope(req, allowedCompanyIds);
  if (!scope) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const storeIds = resolveStoreIds(req.user);
  const comments = await listAllInterviewFeedbackComments(scope, storeIds);
  ok(res, { comments });
});

export const addInterviewFeedbackCommentHandler = asyncHandler(async (req: Request, res: Response) => {
  const interviewId = parseInt(req.params.interviewId, 10);
  if (Number.isNaN(interviewId)) { badRequest(res, 'ID non valido'); return; }

  const { body } = req.body as Record<string, unknown>;
  if (typeof body !== 'string' || !body.trim()) { badRequest(res, 'Il feedback è obbligatorio'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const interviewRow = await queryOne<{ company_id: number; candidate_id: number }>(
    `SELECT candidate_id, company_id FROM interviews WHERE id = $1 LIMIT 1`,
    [interviewId],
  );
  const candidateId = interviewRow?.candidate_id;
  if (!interviewRow) { notFound(res, 'Colloquio non trovato'); return; }
  if (!allowedCompanyIds.includes(interviewRow.company_id)) { forbidden(res, 'Azienda non autorizzata'); return; }

  const storeIds = resolveStoreIds(req.user);
  const comment = await addInterviewFeedbackComment(
    interviewId,
    req.user!.userId,
    interviewRow.company_id,
    body.trim(),
    storeIds,
  );
  if (!comment) { notFound(res, 'Colloquio non trovato'); return; }

  // Send notification to HR and area_manager users of the same company or same company group
  try {
    const candidateAndManagerRow = await queryOne<{ candidate_name: string; manager_name: string; manager_surname: string; group_id: number | null }>(
      `SELECT c.full_name AS candidate_name, u.name AS manager_name, u.surname AS manager_surname, co.group_id
       FROM interviews i
       JOIN candidates c ON c.id = i.candidate_id
       JOIN users u ON u.id = $1
       JOIN companies co ON co.id = $2
       WHERE i.id = $3
       LIMIT 1`,
      [req.user!.userId, interviewRow.company_id, interviewId]
    );

    if (candidateAndManagerRow) {
      const candidateName = candidateAndManagerRow.candidate_name;
      const managerFullName = `${candidateAndManagerRow.manager_name} ${candidateAndManagerRow.manager_surname}`.trim();

      // Find all target users in the same company group, or just the same company if no group
      const targetUsers = await query<{ id: number; locale: string | null; role: string; name: string; surname: string; avatar_filename: string | null; company_name: string; store_name: string | null; company_id: number }>(
        `SELECT u.id, u.locale, u.role, u.name, u.surname, u.avatar_filename, co.name AS company_name, s.name AS store_name, u.company_id
         FROM users u
         JOIN companies co ON co.id = u.company_id
         LEFT JOIN stores s ON s.id = u.store_id
         WHERE (
           ($1::int IS NOT NULL AND co.group_id = $1::int)
           OR
           ($1::int IS NULL AND u.company_id = $2)
         )
         AND u.role IN ('admin', 'hr', 'area_manager')
         AND u.id != $3`,
        [candidateAndManagerRow.group_id, interviewRow.company_id, req.user!.userId]
      );

      const { sendNotification } = await import('../notifications/notifications.service');
      const { t } = await import('../../utils/i18n');

      for (const targetUser of targetUsers) {
        const userLocale = targetUser.locale || 'it';
        await sendNotification({
          companyId: targetUser.company_id,
          userId: targetUser.id,
          type: 'ats.feedback_added',
          title: t(userLocale, 'notifications.ats_feedback_added.title'),
          message: t(userLocale, 'notifications.ats_feedback_added.message', {
            managerName: managerFullName,
            candidateName: candidateName,
          }),
          priority: 'medium',
          locale: userLocale,
          channels: ['in_app'],
          metadata: {
            candidateId,
            interviewId,
            feedbackId: comment.id,
          },
        });

        // Also log this notification for the UI to display in the feedback icon
        const log = await createInterviewNotificationLog(
          interviewId,
          'in_app',
          'interviewer',
          JSON.stringify({
            name: `${targetUser.name} ${targetUser.surname}`.trim(),
            avatarFilename: targetUser.avatar_filename,
            role: targetUser.role,
            companyName: targetUser.company_name,
            storeName: targetUser.store_name,
            feedbackId: comment.id
          })
        );
        if (log) {
          await updateInterviewNotificationLog(log.id, 'done');
        }
      }
    }
  } catch (err) {
    console.error('[ATS feedback notification] Failed to send feedback notifications:', err);
  }

  created(res, { comment }, 'Feedback aggiunto');
});

export const deleteInterviewFeedbackCommentHandler = asyncHandler(async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { badRequest(res, 'ID non valido'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const storeIds = resolveStoreIds(req.user);
  const commentRow = await queryOne<{ company_id: number; user_id: number }>(
    `SELECT c.company_id, ifc.user_id
     FROM interview_feedback_comments ifc
     JOIN interviews i ON i.id = ifc.interview_id
     JOIN candidates c ON c.id = i.candidate_id
     WHERE ifc.id = $1
     LIMIT 1`,
    [id],
  );
  if (!commentRow) { notFound(res, 'Feedback non trovato'); return; }
  if (!allowedCompanyIds.includes(commentRow.company_id)) { forbidden(res, 'Azienda non autorizzata'); return; }

  if (req.user?.role !== 'admin' && req.user?.role !== 'hr' && commentRow.user_id !== req.user?.userId) {
    forbidden(res, 'Non puoi eliminare questo feedback');
    return;
  }

  const deleted = await deleteInterviewFeedbackComment(id, commentRow.company_id, storeIds);
  if (!deleted) { notFound(res, 'Feedback non trovato'); return; }

  ok(res, {}, 'Feedback eliminato');
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const listInterviewNotificationsHandler = asyncHandler(async (req: Request, res: Response) => {
  const interviewId = parseInt(req.params.id, 10);
  if (Number.isNaN(interviewId)) { badRequest(res, 'ID non valido'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds((req as any).user);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const interviewRow = await queryOne<{ company_id: number }>(
    `SELECT company_id FROM interviews WHERE id = $1 LIMIT 1`,
    [interviewId],
  );
  if (!interviewRow) { notFound(res, 'Colloquio non trovato'); return; }
  if (!allowedCompanyIds.includes(interviewRow.company_id)) { forbidden(res, 'Azienda non autorizzata'); return; }

  const storeIds = resolveStoreIds((req as any).user);
  const logs = await listInterviewNotificationLogs(interviewId, interviewRow.company_id, storeIds);
  ok(res, { logs });
});

export const sendInterviewNotificationHandler = asyncHandler(async (req: Request, res: Response) => {
  const interviewId = parseInt(req.params.id, 10);
  if (Number.isNaN(interviewId)) { badRequest(res, 'ID non valido'); return; }

  const allowedCompanyIds = await resolveAllowedCompanyIds((req as any).user);
  if (allowedCompanyIds.length === 0) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const interviewRow = await queryOne<{
    company_id: number;
    candidate_id: number;
    interviewer_id: number | null;
    scheduled_at: string | null;
    location: string | null;
    description: string | null;
    interview_type: string | null;
    store_timezone: string | null;
    store_address: string | null;
    store_cap: string | null;
    store_city: string | null;
    store_name: string | null;
  }>(
    `SELECT i.company_id, i.candidate_id, i.interviewer_id, i.scheduled_at, i.location, i.description, i.interview_type,
            st.timezone AS store_timezone, st.address AS store_address, st.cap AS store_cap, st.city AS store_city, st.name AS store_name
     FROM interviews i
     LEFT JOIN candidates c ON c.id = i.candidate_id
     LEFT JOIN stores st ON st.id = COALESCE(i.store_id, c.store_id)
     WHERE i.id = $1 LIMIT 1`,
    [interviewId],
  );
  if (!interviewRow) { notFound(res, 'Colloquio non trovato'); return; }
  if (!allowedCompanyIds.includes(interviewRow.company_id)) { forbidden(res, 'Azienda non autorizzata'); return; }

  const payload = req.body as Record<string, unknown>;
  const requestedLogId = typeof payload.logId === 'number' ? payload.logId : null;
  const requestedChannel = payload.channel === 'email' || payload.channel === 'in_app'
    ? payload.channel
    : null;
  const requestedRecipientType = payload.recipientType === 'candidate' || payload.recipientType === 'interviewer'
    ? payload.recipientType
    : 'interviewer';

  let logId = requestedLogId;
  let logRow = requestedLogId
    ? await queryOne<{
        recipient_email: string | null;
        recipient_type: string;
        channel: string;
        status: string;
      }>(
        `SELECT recipient_email, recipient_type, channel, status
         FROM interview_notification_logs
         WHERE id = $1 AND interview_id = $2
         LIMIT 1`,
        [requestedLogId, interviewId]
      )
    : null;

  let recipientName = '';
  let recipientEmail = '';

  if (!logRow) {
    if (!requestedChannel) {
      notFound(res, 'Log di notifica non trovato');
      return;
    }

    if (requestedRecipientType === 'interviewer') {
      if (!interviewRow.interviewer_id) {
        badRequest(res, 'Intervistatore non assegnato');
        return;
      }

      const interviewerRow = await queryOne<{ email: string | null; name: string; surname: string }>(
        `SELECT email, name, surname FROM users WHERE id = $1 LIMIT 1`,
        [interviewRow.interviewer_id],
      );

      if (requestedChannel === 'email' && !interviewerRow?.email) {
        badRequest(res, 'Email intervistatore mancante');
        return;
      }

      recipientName = `${interviewerRow?.name ?? ''} ${interviewerRow?.surname ?? ''}`.trim();
      recipientEmail = interviewerRow?.email ?? '';

      const createdLog = await createInterviewNotificationLog(
        interviewId,
        requestedChannel,
        'interviewer',
        requestedChannel === 'email' ? interviewerRow?.email ?? undefined : undefined,
      );

      if (!createdLog) {
        badRequest(res, 'Impossibile creare il log di notifica');
        return;
      }

      logId = createdLog.id;
      logRow = {
        recipient_email: createdLog.recipientEmail,
        recipient_type: createdLog.recipientType,
        channel: createdLog.channel,
        status: createdLog.status,
      };
    } else {
      // Candidate
      const candidateRow = await queryOne<{ email: string | null; full_name: string }>(
        `SELECT email, full_name FROM candidates WHERE id = $1 LIMIT 1`,
        [interviewRow.candidate_id],
      );

      if (requestedChannel === 'email' && !candidateRow?.email) {
        badRequest(res, 'Email candidato mancante');
        return;
      }

      recipientName = candidateRow?.full_name ?? '';
      recipientEmail = candidateRow?.email ?? '';

      const createdLog = await createInterviewNotificationLog(
        interviewId,
        requestedChannel,
        'candidate',
        requestedChannel === 'email' ? candidateRow?.email ?? undefined : undefined,
      );

      if (!createdLog) {
        badRequest(res, 'Impossibile creare il log di notifica');
        return;
      }

      logId = createdLog.id;
      logRow = {
        recipient_email: createdLog.recipientEmail,
        recipient_type: createdLog.recipientType,
        channel: createdLog.channel,
        status: createdLog.status,
      };
    }
  } else {
    // Get recipient info from existing log
    if (logRow.recipient_type === 'interviewer' && interviewRow.interviewer_id) {
      const interviewerRow = await queryOne<{ name: string; surname: string; email: string | null }>(
        `SELECT name, surname, email FROM users WHERE id = $1 LIMIT 1`,
        [interviewRow.interviewer_id],
      );
      recipientName = `${interviewerRow?.name ?? ''} ${interviewerRow?.surname ?? ''}`.trim();
      recipientEmail = interviewerRow?.email ?? logRow.recipient_email ?? '';
    } else if (logRow.recipient_type === 'candidate') {
      const candidateRow = await queryOne<{ full_name: string; email: string | null }>(
        `SELECT full_name, email FROM candidates WHERE id = $1 LIMIT 1`,
        [interviewRow.candidate_id],
      );
      recipientName = candidateRow?.full_name ?? '';
      recipientEmail = candidateRow?.email ?? logRow.recipient_email ?? '';
    }
  }

  if (!logId) {
    badRequest(res, 'ID log non valido');
    return;
  }

  await updateInterviewNotificationLog(logId, 'sending');

  try {
    if (logRow.channel === 'in_app') {
      if (!interviewRow.interviewer_id) {
        throw new Error('Intervistatore non assegnato');
      }

      const interviewerRow = await queryOne<{ locale?: string | null; role?: string | null }>(
        `SELECT locale, role FROM users WHERE id = $1 LIMIT 1`,
        [interviewRow.interviewer_id],
      );
      const inviteEnabled = await isNotificationEnabledForRole(
        interviewRow.company_id,
        'ats.interview_invite',
        interviewerRow?.role ?? null,
      );
      if (!inviteEnabled) {
        throw new Error('Notifica disabilitata nelle impostazioni');
      }

      const interviewerLocale = interviewerRow?.locale ?? 'it';
      const dateLocale = interviewerLocale === 'it' ? 'it-IT' : 'en-GB';
      const scheduledDate = interviewRow.scheduled_at ? new Date(interviewRow.scheduled_at) : new Date();

      const candidateRow = await queryOne<{ full_name: string | null }>(
        `SELECT full_name FROM candidates WHERE id = $1 LIMIT 1`,
        [interviewRow.candidate_id],
      );
      const targetTimezone = safeDisplayTimezone(interviewRow.store_timezone);
      const scheduledTime = scheduledDate.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit', timeZone: targetTimezone });
      const candidateName = candidateRow?.full_name?.trim()
        || (interviewerLocale === 'it' ? 'il candidato' : 'the candidate');
      const isInPerson = interviewRow.interview_type === 'in_person' || !interviewRow.interview_type;
      const rawStoreAddr = [interviewRow.store_address, interviewRow.store_cap, interviewRow.store_city].filter(Boolean).join(', ');
      const fallbackAddr = rawStoreAddr || interviewRow.store_name || '';
      const effectiveLocation = isInPerson
        ? (interviewRow.location && interviewRow.location.trim() ? interviewRow.location.trim() : fallbackAddr)
        : '';
      const locationSuffix = isInPerson && effectiveLocation
        ? (interviewerLocale === 'it' ? ` presso ${effectiveLocation}` : ` at ${effectiveLocation}`)
        : '';

      await sendNotification({
        companyId: interviewRow.company_id,
        userId: interviewRow.interviewer_id,
        type: 'ats.interview_invite',
        title: t(interviewerLocale, 'notifications.ats_interview_invite.title'),
        message: t(interviewerLocale, 'notifications.ats_interview_invite.message', {
          candidate: candidateName,
          date: scheduledDate.toLocaleDateString(dateLocale, { timeZone: targetTimezone }),
          time: scheduledTime,
          location: locationSuffix,
        }),
        priority: 'high',
        locale: interviewerLocale,
        channels: ['in_app'],
      });
      
      await updateInterviewNotificationLog(logId, 'done');
      ok(res, { 
        success: true, 
        recipientName, 
        recipientEmail: undefined 
      }, 'Notifica inviata con successo');
    } else {
      if (!logRow.recipient_email) {
        throw new Error('Indirizzo email mancante');
      }

      const smtpEnabled = await isSmtpConfigured(interviewRow.company_id);
      if (!smtpEnabled) {
        throw new Error('SMTP non configurato');
      }

      const candidateRow = await queryOne<{ full_name: string; first_name: string; last_name: string; store_name: string | null }>(
        `SELECT c.full_name, 
                split_part(c.full_name, ' ', 1) as first_name,
                substring(c.full_name from position(' ' in c.full_name) + 1) as last_name,
                s.name as store_name
         FROM candidates c
         LEFT JOIN stores s ON s.id = c.store_id
         WHERE c.id = $1 LIMIT 1`,
        [interviewRow.candidate_id],
      );

      const firstName = candidateRow?.first_name ?? '';
      const lastName = candidateRow?.last_name ?? '';
      const storeName = candidateRow?.store_name ?? interviewRow.location ?? 'Store';

      await sendProfessionalInterviewEmail({
        interviewId,
        companyId: interviewRow.company_id,
        recipientEmail: logRow.recipient_email,
        recipientName,
        recipientType: logRow.recipient_type as 'candidate' | 'interviewer',
        logId,
        req,
        firstName,
        lastName,
        storeName
      });

      ok(res, { 
        success: true, 
        recipientName, 
        recipientEmail: logRow.channel === 'email' ? logRow.recipient_email : undefined 
      }, 'Notifica inviata con successo');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateInterviewNotificationLog(logId, 'error', message);
    badRequest(res, 'Errore nell\'invio della notifica: ' + message);
  }
});

async function sendProfessionalInterviewEmail(params: {
  interviewId: number;
  companyId: number;
  recipientEmail: string;
  recipientName: string;
  recipientType: 'candidate' | 'interviewer';
  logId: number;
  req: Request;
  firstName: string;
  lastName: string;
  storeName: string;
}) {
  const { interviewId, companyId, recipientEmail, recipientName, recipientType, logId, req, firstName, lastName, storeName } = params;

  try {
    const interviewRow = await queryOne<{
      scheduled_at: string | null;
      location: string | null;
      description: string | null;
      interview_type: string | null;
      candidate_id: number;
      store_timezone: string | null;
      store_address: string | null;
      store_cap: string | null;
      store_city: string | null;
      store_name: string | null;
    }>(
      `SELECT i.scheduled_at, i.location, i.description, i.interview_type, i.candidate_id,
              st.timezone AS store_timezone, st.address AS store_address, st.cap AS store_cap, st.city AS store_city, st.name AS store_name
       FROM interviews i
       LEFT JOIN candidates c ON c.id = i.candidate_id
       LEFT JOIN stores st ON st.id = COALESCE(i.store_id, c.store_id)
       WHERE i.id = $1 LIMIT 1`,
      [interviewId],
    );

    if (!interviewRow) throw new Error('Interview not found');

    const targetTimezone = safeDisplayTimezone(interviewRow.store_timezone);
    const isInPerson = interviewRow.interview_type === 'in_person' || !interviewRow.interview_type;
    const rawStoreAddr = [interviewRow.store_address, interviewRow.store_cap, interviewRow.store_city].filter(Boolean).join(', ');
    const fallbackAddr = rawStoreAddr || interviewRow.store_name || storeName || '';
    const effectiveLocation = isInPerson
      ? (interviewRow.location && interviewRow.location.trim() ? interviewRow.location.trim() : fallbackAddr)
      : '';

    const frontendBase = resolveFrontendBase(req);
    const backendBase = resolveBackendBase(req);
    const candidatePdfToken = signCandidatePdfToken(interviewRow.candidate_id, companyId, interviewId, recipientType);
    const candidateUrl = `${backendBase}/api/ats/candidates/${encodeURIComponent(String(interviewRow.candidate_id))}/profile.pdf?token=${encodeURIComponent(candidatePdfToken)}`;
    const scheduledDate = interviewRow.scheduled_at ? new Date(interviewRow.scheduled_at) : new Date();
    const candidateName = `${firstName} ${lastName}`.trim() || recipientName || 'Candidato';
    const interviewTypeLabel = interviewRow.interview_type === 'phone' ? 'Telefonico' : 'Di persona';
    const dateLabel = scheduledDate.toLocaleDateString('it-IT', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      timeZone: targetTimezone,
    });
    const timeLabel = scheduledDate.toLocaleTimeString('it-IT', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: targetTimezone,
    });
    const logoPath = findEmailLogoPath();
    const logoCid = logoPath ? 'veylo-hr-logo' : null;
    const logoSrc = logoCid ? `cid:${logoCid}` : `${frontendBase}/IMG_5144.png`;
    const safeCandidateUrl = escapeHtml(candidateUrl);
    const safeRecipientName = escapeHtml(recipientName || candidateName);
    const safeCandidateName = escapeHtml(candidateName);
    const safeStoreName = escapeHtml(storeName);
    const safeLogoSrc = escapeHtml(logoSrc);
    const safeLocation = escapeHtml(effectiveLocation);
    const safeDescription = escapeHtml(interviewRow.description || '').replace(/\r?\n/g, '<br />');
    const logoUrl = logoSrc;

    const { generateICSEvent } = await import('./ics.service');
    const ics = generateICSEvent({
      title: `Colloquio: ${candidateName}`,
      description: interviewRow.description || 'Job Interview',
      location: effectiveLocation,
      startDate: scheduledDate,
    });
    
    const subject = `${candidateName} - ${storeName} - Interview Invitation`;

    let professionalBody = `
      <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; line-height: 1.6;">
        <div style="text-align: center; padding: 20px 0; border-bottom: 2px solid #f1f5f9;">
          <img src="${logoUrl}" alt="Veylo HR Logo" style="max-height: 60px; margin-bottom: 10px;">
          <h1 style="color: #0f172a; font-size: 24px; margin: 0;">Invito al Colloquio</h1>
        </div>
        
        <div style="padding: 30px 20px;">
          <p style="font-size: 16px; margin-bottom: 20px;">Gentile <strong>${recipientName}</strong>,</p>
          
          <p style="font-size: 16px; margin-bottom: 25px;">
            ${recipientType === 'interviewer' 
              ? 'Ti informiamo che è stato programmato un colloquio di selezione. Di seguito trovi i dettagli:'
              : 'Siamo lieti di confermare il tuo colloquio di lavoro. Di seguito trovi tutti i dettagli dell\'appuntamento:'}
          </p>

          <div style="background-color: #f8fafc; border-radius: 12px; padding: 25px; margin-bottom: 30px; border: 1px solid #e2e8f0;">
            <h3 style="margin-top: 0; color: #0f172a; border-bottom: 1px solid #cbd5e1; padding-bottom: 10px; margin-bottom: 15px;">Dettagli Appuntamento</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #64748b; font-weight: 600; width: 140px;">Data e Ora</td>
                <td style="padding: 8px 0; color: #0f172a;">${interviewRow.scheduled_at ? new Date(interviewRow.scheduled_at).toLocaleString('it-IT', { timeZone: targetTimezone }) : 'N/A'}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Tipo</td>
                <td style="padding: 8px 0; color: #0f172a;">${interviewRow.interview_type === 'phone' ? 'Telefonico 📞' : 'Di Persona 🤝'}</td>
              </tr>
              ${effectiveLocation ? `
              <tr>
                <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Luogo</td>
                <td style="padding: 8px 0; color: #0f172a;">${escapeHtml(effectiveLocation)}</td>
              </tr>` : ''}
              ${interviewRow.description ? `
              <tr>
                <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Note</td>
                <td style="padding: 8px 0; color: #0f172a;">${interviewRow.description}</td>
              </tr>` : ''}
            </table>
          </div>

          ${recipientType === 'interviewer' ? `
          <div style="text-align: center; margin: 40px 0;">
            <a href="${candidateUrl}" style="background-color: #c9973a; color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(201,151,58,0.2);">Apri Profilo Candidato & CV</a>
          </div>

          <p style="font-size: 14px; color: #64748b; text-align: center; margin-bottom: 30px;">
            Clicca sul pulsante sopra per accedere direttamente al profilo del candidato, visualizzare il CV e aggiungere i tuoi commenti.
          </p>
          ` : ''}

          <div style="background-color: #fffbeb; padding: 15px; border-radius: 8px; border: 1px solid #fef3c7; margin-bottom: 30px;">
            <p style="margin: 0; font-size: 13px; color: #92400e; text-align: center;">
              <strong>Sincronizzazione Calendario:</strong> In allegato trovi il file <strong>interview.ics</strong> per aggiungere l'evento al tuo calendario.
            </p>
          </div>

          <div style="margin-top: 50px; padding-top: 25px; border-top: 1px solid #f1f5f9; text-align: center;">
            <p style="font-size: 12px; color: #94a3b8; margin: 0;">&copy; ${new Date().getFullYear()} Veylo HR - Recruiting Pipeline. Tutti i diritti riservati.</p>
          </div>
        </div>
      </div>
    `;

    professionalBody = `
      <!doctype html>
      <html>
        <head>
          <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <style>
            @media only screen and (max-width: 620px) {
              .email-container { width: 100% !important; }
              .email-padding { padding: 22px 18px !important; }
              .detail-label, .detail-value { display: block !important; width: 100% !important; padding-left: 0 !important; }
              .profile-button { display: block !important; width: 100% !important; box-sizing: border-box !important; }
            }
          </style>
        </head>
        <body style="margin:0; padding:0; background:#f3f6f8; font-family:Arial, Helvetica, sans-serif; color:#18212f;">
          <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
            Invito al colloquio per ${safeCandidateName} - ${escapeHtml(dateLabel)} alle ${escapeHtml(timeLabel)}.
          </div>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f6f8; margin:0; padding:28px 12px;">
            <tr>
              <td align="center">
                <table role="presentation" class="email-container" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px; max-width:600px; background:#ffffff; border:1px solid #e3e9ef; border-radius:16px; overflow:hidden;">
                  <tr>
                    <td align="center" style="background:#0f2338; padding:30px 28px 26px;">
                      <img src="${safeLogoSrc}" width="156" alt="Veylo HR" style="display:block; width:156px; max-width:156px; height:auto; border:0; outline:none; text-decoration:none; margin:0 auto 18px;" />
                      <div style="font-size:12px; line-height:16px; letter-spacing:1.8px; text-transform:uppercase; color:#d4a947; font-weight:700;">Recruiting</div>
                      <h1 style="margin:8px 0 0; font-size:26px; line-height:32px; color:#ffffff; font-weight:700;">Invito al colloquio</h1>
                    </td>
                  </tr>
                  <tr>
                    <td class="email-padding" style="padding:34px 38px 30px;">
                      <p style="margin:0 0 16px; font-size:16px; line-height:25px; color:#18212f;">Gentile <strong>${safeRecipientName}</strong>,</p>
                      <p style="margin:0 0 26px; font-size:15px; line-height:24px; color:#465568;">
                        ${recipientType === 'interviewer'
                          ? 'Ti informiamo che &egrave; stato programmato un colloquio di selezione. Di seguito trovi i dettagli:'
                          : 'Siamo lieti di confermare il tuo colloquio di lavoro. Di seguito trovi tutti i dettagli dell&rsquo;appuntamento:'}
                      </p>

                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f8fafc; border:1px solid #e1e8ef; border-radius:12px;">
                        <tr>
                          <td style="padding:22px 24px;">
                            <h2 style="margin:0 0 16px; font-size:17px; line-height:22px; color:#18212f; font-weight:700;">Dettagli appuntamento</h2>
                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                              <tr>
                                <td class="detail-label" width="145" style="padding:10px 18px 10px 0; border-top:1px solid #e5ebf1; color:#6b7787; font-size:13px; line-height:19px; font-weight:700;">Candidato</td>
                                <td class="detail-value" style="padding:10px 0; border-top:1px solid #e5ebf1; color:#18212f; font-size:14px; line-height:20px;">${safeCandidateName}</td>
                              </tr>
                              <tr>
                                <td class="detail-label" width="145" style="padding:10px 18px 10px 0; border-top:1px solid #e5ebf1; color:#6b7787; font-size:13px; line-height:19px; font-weight:700;">Data</td>
                                <td class="detail-value" style="padding:10px 0; border-top:1px solid #e5ebf1; color:#18212f; font-size:14px; line-height:20px;">${escapeHtml(dateLabel)}</td>
                              </tr>
                              <tr>
                                <td class="detail-label" width="145" style="padding:10px 18px 10px 0; border-top:1px solid #e5ebf1; color:#6b7787; font-size:13px; line-height:19px; font-weight:700;">Ora</td>
                                <td class="detail-value" style="padding:10px 0; border-top:1px solid #e5ebf1; color:#18212f; font-size:14px; line-height:20px;">${escapeHtml(timeLabel)}</td>
                              </tr>
                              <tr>
                                <td class="detail-label" width="145" style="padding:10px 18px 10px 0; border-top:1px solid #e5ebf1; color:#6b7787; font-size:13px; line-height:19px; font-weight:700;">Tipo</td>
                                <td class="detail-value" style="padding:10px 0; border-top:1px solid #e5ebf1; color:#18212f; font-size:14px; line-height:20px;">${escapeHtml(interviewTypeLabel)}</td>
                              </tr>
                              ${interviewRow.location ? `
                              <tr>
                                <td class="detail-label" width="145" style="padding:10px 18px 10px 0; border-top:1px solid #e5ebf1; color:#6b7787; font-size:13px; line-height:19px; font-weight:700;">Luogo / Link</td>
                                <td class="detail-value" style="padding:10px 0; border-top:1px solid #e5ebf1; color:#18212f; font-size:14px; line-height:20px;">${safeLocation}</td>
                              </tr>` : ''}
                              ${interviewRow.description ? `
                              <tr>
                                <td class="detail-label" width="145" style="padding:10px 18px 10px 0; border-top:1px solid #e5ebf1; color:#6b7787; font-size:13px; line-height:19px; font-weight:700;">Note</td>
                                <td class="detail-value" style="padding:10px 0; border-top:1px solid #e5ebf1; color:#18212f; font-size:14px; line-height:20px;">${safeDescription}</td>
                              </tr>` : ''}
                              <tr>
                                <td class="detail-label" width="145" style="padding:10px 18px 0 0; border-top:1px solid #e5ebf1; color:#6b7787; font-size:13px; line-height:19px; font-weight:700;">Store</td>
                                <td class="detail-value" style="padding:10px 0 0; border-top:1px solid #e5ebf1; color:#18212f; font-size:14px; line-height:20px;">${safeStoreName}</td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>

                      ${recipientType === 'interviewer' ? `
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                        <tr>
                          <td align="center" style="padding:30px 0 18px;">
                            <a class="profile-button" href="${safeCandidateUrl}" target="_blank" style="display:inline-block; background:#c9973a; color:#ffffff; text-decoration:none; font-size:15px; line-height:18px; font-weight:700; padding:15px 26px; border-radius:8px; box-shadow:0 8px 18px rgba(201,151,58,0.22);">Apri Profilo Candidato &amp; CV</a>
                          </td>
                        </tr>
                      </table>

                      <p style="margin:0 0 24px; font-size:13px; line-height:21px; color:#667386; text-align:center;">
                        Clicca sul pulsante sopra per accedere direttamente al profilo del candidato, visualizzare il CV e aggiungere i tuoi commenti.
                      </p>
                      ` : ''}

                      <div style="background:#fff8e6; border:1px solid #f3dfab; border-radius:10px; padding:14px 16px;">
                        <p style="margin:0; font-size:13px; line-height:20px; color:#7c5b14; text-align:center;">
                          <strong>Sincronizzazione calendario:</strong> in allegato trovi il file <strong>interview.ics</strong> per aggiungere l&rsquo;evento al tuo calendario.
                        </p>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding:20px 28px 28px; border-top:1px solid #edf1f5;">
                      <p style="margin:0; font-size:12px; line-height:18px; color:#8a97a8;">&copy; ${new Date().getFullYear()} Veylo HR - Recruiting Pipeline. Tutti i diritti riservati.</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;
    const plainText = [
      'Invito al colloquio',
      `Gentile ${recipientName || candidateName},`,
      recipientType === 'interviewer'
        ? "Ti informiamo che e' stato programmato un colloquio di selezione."
        : "Siamo lieti di confermare il tuo colloquio di lavoro.",
      `Candidato: ${candidateName}`,
      `Data: ${dateLabel}`,
      `Ora: ${timeLabel}`,
      `Tipo: ${interviewTypeLabel}`,
      interviewRow.location ? `Luogo / Link: ${interviewRow.location}` : '',
      interviewRow.description ? `Note: ${interviewRow.description}` : '',
      recipientType === 'interviewer' ? `Profilo candidato e CV: ${candidateUrl}` : '',
      "In allegato trovi il file interview.ics per aggiungere l'evento al tuo calendario.",
    ].filter(Boolean).join('\n\n');

    const { sendEmailForCompany } = await import('../../services/email.service');
    await sendEmailForCompany(companyId, {
      to: recipientEmail,
      subject: subject,
      html: professionalBody,
      text: plainText,
      attachments: [
        ...(logoPath && logoCid ? [{
          filename: 'IMG_5144.png',
          content: fs.readFileSync(logoPath),
          contentType: 'image/png',
          cid: logoCid,
        }] : []),
        {
          filename: 'interview.ics',
          content: ics.icsContent,
          contentType: 'text/calendar; charset=utf-8; method=REQUEST',
        }
      ],
    });

    await updateInterviewNotificationLog(logId, 'done');
  } catch (err) {
    await updateInterviewNotificationLog(
      logId,
      'error',
      err instanceof Error ? err.message : String(err)
    );
    console.error(`[sendProfessionalInterviewEmail] Failed to send email to ${recipientEmail}:`, err);
  }
}

export const testSsrHandler = asyncHandler(async (req: Request, res: Response) => {
  const { url } = req.query;
  if (typeof url !== 'string' || !url.startsWith('http')) {
    badRequest(res, 'URL non valido', 'INVALID_URL');
    return;
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Indeedbot/1.0)',
      },
    });

    const text = await response.text();
    const isSsrWorking = text.includes('addetto vendite') || text.includes('careers') || text.includes('Position Not Found') || text.includes('Posizioni Aperte') || text.includes('Informativa sui Cookie') || text.includes('Privacy Policy');
    
    ok(res, {
      success: true,
      isSsrWorking,
      snippet: text.slice(0, 1000),
    });
  } catch (err: any) {
    ok(res, {
      success: false,
      isSsrWorking: false,
      error: err.message,
    });
  }
});

export const listScreenerQuestionsHandler = asyncHandler(async (req: Request, res: Response) => {
  const companyId = await resolveAtsCompanyId(req);
  if (!companyId) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const jobId = parseInt(req.params.jobId, 10);
  if (Number.isNaN(jobId)) { badRequest(res, 'ID annuncio non valido'); return; }

  const job = await queryOne('SELECT id FROM job_postings WHERE id = $1 AND company_id = $2', [jobId, companyId]);
  if (!job) { notFound(res, 'Annuncio non trovato'); return; }

  const questions = await query(
    `SELECT id, job_id, company_id, question_text, question_type, options, is_knockout, knockout_value, display_order, is_required, created_at, updated_at
     FROM job_screener_questions
     WHERE job_id = $1 AND company_id = $2
     ORDER BY display_order ASC, id ASC`,
    [jobId, companyId]
  );
  ok(res, { questions });
});

export const createScreenerQuestionHandler = asyncHandler(async (req: Request, res: Response) => {
  const companyId = await resolveAtsCompanyId(req);
  if (!companyId) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const jobId = parseInt(req.params.jobId, 10);
  if (Number.isNaN(jobId)) { badRequest(res, 'ID annuncio non valido'); return; }

  const job = await queryOne('SELECT id FROM job_postings WHERE id = $1 AND company_id = $2', [jobId, companyId]);
  if (!job) { notFound(res, 'Annuncio non trovato'); return; }

  const { question_text, question_type, options, is_knockout, knockout_value, display_order, is_required } = req.body;
  if (!question_text || !question_type) {
    badRequest(res, 'Testo e tipo della domanda richiesti');
    return;
  }
  const validTypes = ['radio', 'checkbox', 'text', 'number'];
  if (!validTypes.includes(question_type)) {
    badRequest(res, 'Tipo della domanda non valido');
    return;
  }

  const result = await queryOne(
    `INSERT INTO job_screener_questions (job_id, company_id, question_text, question_type, options, is_knockout, knockout_value, display_order, is_required)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      jobId,
      companyId,
      question_text.trim(),
      question_type,
      options ? (typeof options === 'string' ? options : JSON.stringify(options)) : '[]',
      !!is_knockout,
      knockout_value ?? null,
      parseInt(display_order, 10) || 0,
      is_required !== undefined ? !!is_required : true
    ]
  );
  created(res, { question: result });
});

export const updateScreenerQuestionHandler = asyncHandler(async (req: Request, res: Response) => {
  const companyId = await resolveAtsCompanyId(req);
  if (!companyId) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const jobId = parseInt(req.params.jobId, 10);
  if (Number.isNaN(jobId)) { badRequest(res, 'ID annuncio non valido'); return; }

  const qId = parseInt(req.params.qId, 10);
  if (Number.isNaN(qId)) { badRequest(res, 'ID domanda non valido'); return; }

  const existing = await queryOne(
    'SELECT id FROM job_screener_questions WHERE id = $1 AND job_id = $2 AND company_id = $3',
    [qId, jobId, companyId]
  );
  if (!existing) { notFound(res, 'Domanda non trovata'); return; }

  const { question_text, question_type, options, is_knockout, knockout_value, display_order, is_required } = req.body;

  const updates: string[] = [];
  const params: any[] = [qId, jobId, companyId];
  let paramIndex = 4;

  if (question_text !== undefined) {
    updates.push(`question_text = $${paramIndex++}`);
    params.push(question_text.trim());
  }
  if (question_type !== undefined) {
    const validTypes = ['radio', 'checkbox', 'text', 'number'];
    if (!validTypes.includes(question_type)) {
      badRequest(res, 'Tipo della domanda non valido');
      return;
    }
    updates.push(`question_type = $${paramIndex++}`);
    params.push(question_type);
  }
  if (options !== undefined) {
    updates.push(`options = $${paramIndex++}`);
    params.push(typeof options === 'string' ? options : JSON.stringify(options));
  }
  if (is_knockout !== undefined) {
    updates.push(`is_knockout = $${paramIndex++}`);
    params.push(!!is_knockout);
  }
  if (knockout_value !== undefined) {
    updates.push(`knockout_value = $${paramIndex++}`);
    params.push(knockout_value);
  }
  if (display_order !== undefined) {
    updates.push(`display_order = $${paramIndex++}`);
    params.push(parseInt(display_order, 10) || 0);
  }
  if (is_required !== undefined) {
    updates.push(`is_required = $${paramIndex++}`);
    params.push(!!is_required);
  }

  updates.push(`updated_at = NOW()`);

  const updated = await queryOne(
    `UPDATE job_screener_questions
     SET ${updates.join(', ')}
     WHERE id = $1 AND job_id = $2 AND company_id = $3
     RETURNING *`,
    params
  );
  ok(res, { question: updated });
});

export const deleteScreenerQuestionHandler = asyncHandler(async (req: Request, res: Response) => {
  const companyId = await resolveAtsCompanyId(req);
  if (!companyId) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const jobId = parseInt(req.params.jobId, 10);
  if (Number.isNaN(jobId)) { badRequest(res, 'ID annuncio non valido'); return; }

  const qId = parseInt(req.params.qId, 10);
  if (Number.isNaN(qId)) { badRequest(res, 'ID domanda non valido'); return; }

  const existing = await queryOne(
    'SELECT id FROM job_screener_questions WHERE id = $1 AND job_id = $2 AND company_id = $3',
    [qId, jobId, companyId]
  );
  if (!existing) { notFound(res, 'Domanda non trovata'); return; }

  await query(
    'DELETE FROM job_screener_questions WHERE id = $1 AND job_id = $2 AND company_id = $3',
    [qId, jobId, companyId]
  );
  ok(res, { success: true });
});

// ---------------------------------------------------------------------------
// GDPR candidate retention
//
// The public privacy notice promises candidate data is erased or anonymised
// after a maximum retention window. These endpoints let an admin see the
// current policy, preview exactly which records the nightly sweep would touch,
// and turn enforcement on. Preview is deliberately available while the policy
// is disabled so the impact can be inspected before committing to it.
// ---------------------------------------------------------------------------

export const getCandidateRetentionHandler = asyncHandler(async (req: Request, res: Response) => {
  const companyId = await resolveAtsCompanyId(req);
  if (!companyId) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const settings = await queryOne(
    `SELECT enabled, retention_months, include_hired, last_run_at, last_run_count
       FROM candidate_retention_settings
      WHERE company_id = $1`,
    [companyId],
  );

  // A company created before migration 122 ran has no row yet; report the
  // documented default rather than a null policy.
  const effective = settings ?? {
    enabled: false,
    retention_months: 24,
    include_hired: false,
    last_run_at: null,
    last_run_count: 0,
  };

  const preview = await runCandidateRetentionJob(companyId, true);

  ok(res, {
    settings: effective,
    pendingCount: preview.eligible,
  });
});

export const updateCandidateRetentionHandler = asyncHandler(async (req: Request, res: Response) => {
  const companyId = await resolveAtsCompanyId(req);
  if (!companyId) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const { enabled, retention_months, include_hired } = req.body ?? {};

  if (typeof enabled !== 'boolean') {
    badRequest(res, 'Il campo "enabled" deve essere booleano');
    return;
  }

  const months = retention_months === undefined ? 24 : Number(retention_months);
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    badRequest(res, 'Il periodo di conservazione deve essere tra 1 e 120 mesi');
    return;
  }

  const includeHired = include_hired === undefined ? false : Boolean(include_hired);

  const saved = await queryOne(
    `INSERT INTO candidate_retention_settings (company_id, enabled, retention_months, include_hired, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (company_id) DO UPDATE
       SET enabled          = EXCLUDED.enabled,
           retention_months = EXCLUDED.retention_months,
           include_hired    = EXCLUDED.include_hired,
           updated_at       = NOW()
     RETURNING enabled, retention_months, include_hired, last_run_at, last_run_count`,
    [companyId, enabled, months, includeHired],
  );

  ok(res, { settings: saved });
});

/**
 * Read-only preview of the next sweep. Returns the candidate list so an admin
 * can eyeball it — never mutates, regardless of whether the policy is enabled.
 */
export const previewCandidateRetentionHandler = asyncHandler(async (req: Request, res: Response) => {
  const companyId = await resolveAtsCompanyId(req);
  if (!companyId) { forbidden(res, 'Nessuna azienda valida selezionata'); return; }

  const preview = await runCandidateRetentionJob(companyId, true);

  ok(res, {
    eligible: preview.eligible,
    candidates: preview.candidates.map((c) => ({
      id: c.id,
      fullName: c.full_name,
      lastContact: c.last_contact,
      hasCv: Boolean(c.cv_path || c.resume_path),
    })),
  });
});
