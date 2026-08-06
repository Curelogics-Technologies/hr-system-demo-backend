import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { NextFunction, Request, Response, Router, raw } from 'express';
import multer from 'multer';
import { query, queryOne } from '../../config/database';
import { asyncHandler } from '../../utils/asyncHandler';
import { badRequest, conflict, created, notFound, ok } from '../../utils/response';
import { sendEmailForCompany } from '../../services/email.service';
import { createCandidate } from '../ats/ats.service';
import { sendNotification } from '../notifications/notifications.service';
import { t } from '../../utils/i18n';
import { authenticate, requireSuperAdmin } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rateLimit';
import { resolveIndeedSecretBySlug } from '../../services/indeedCredentials.service';

export type PublicJobRow = {
  id: number;
  status: string;
  company_id: number;
  company_name: string;
  company_slug: string;
  company_country: string | null;
  store_id: number | null;
  store_name: string | null;
  title: string;
  description: string | null;
  tags: string[] | null;
  language: string | null;
  job_type: string | null;
  department: string | null;
  weekly_hours: number | null;
  contract_type: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_period: string | null;
  experience: string | null;
  education: string | null;
  category: string | null;
  expiration_date: string | null;
  is_remote: boolean | null;
  remote_type: string | null;
  job_city: string | null;
  job_state: string | null;
  job_country: string | null;
  job_postal_code: string | null;
  job_address: string | null;
  created_at: string;
  published_at: string | null;
  company_group_name: string | null;
  company_logo_filename: string | null;
  company_banner_filename: string | null;
  store_code: string | null;
  store_logo_filename: string | null;
  store_employee_count: number | null;
  applicants_count: number;
  location_address: string | null;
  location_postal_code: string | null;
  location_city: string | null;
  location_state: string | null;
  location_country: string | null;
  posted_by_id: number | null;
  posted_by_name: string | null;
  posted_by_surname: string | null;
  posted_by_role: string | null;
  posted_by_avatar_filename: string | null;
  posted_by_store_id: number | null;
  posted_by_store_name: string | null;
};

export type PublicCompanyRow = {
  id: number;
  name: string;
  slug: string;
  city: string | null;
  state: string | null;
  country: string | null;
  address: string | null;
  group_name: string | null;
  logo_filename: string | null;
  banner_filename: string | null;
  owner_user_id: number | null;
  owner_name: string | null;
  owner_surname: string | null;
  owner_avatar_filename: string | null;
  open_roles_count: number;
  company_email: string | null;
};

export type PublicHiringContactRow = {
  id: number;
  name: string;
  surname: string | null;
  role: string;
  avatar_filename: string | null;
  store_id: number | null;
  store_name: string | null;
};

const router = Router();

const ALLOWED_RESUME_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const RESUME_UPLOAD_DIR = process.env.PUBLIC_CV_UPLOAD_DIR
  ?? path.join(process.cwd(), 'uploads', 'public-cv');

fs.mkdirSync(RESUME_UPLOAD_DIR, { recursive: true });

const resumeStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, RESUME_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const parsedJobId = parsePositiveInt(req.params.jobId);
    const ext = pickResumeExtension(file.originalname, file.mimetype);
    const random = Math.random().toString(36).slice(2, 10);
    const filename = `job-${parsedJobId ?? 'x'}-${Date.now()}-${random}${ext}`;
    cb(null, filename);
  },
});

const resumeUpload = multer({
  storage: resumeStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_RESUME_MIME.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('INVALID_FILE_TYPE'));
  },
}).single('resume');

function pickResumeExtension(originalName: string, mimeType: string): string {
  const ext = path.extname(originalName || '').toLowerCase();
  if (ext === '.pdf' || ext === '.doc' || ext === '.docx') {
    return ext;
  }
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType === 'application/msword') return '.doc';
  return '.docx';
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeOptionalText(value: unknown, maxLength = 255): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function parseBooleanInput(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  return false;
}

function cleanupUploadedResume(req: Request): void {
  if (!req.file?.path) return;
  try {
    fs.unlinkSync(req.file.path);
  } catch {
    // ignore cleanup errors
  }
}

function resumeUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  resumeUpload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }

    const multerError = err as { code?: string; message?: string };
    if (multerError.code === 'LIMIT_FILE_SIZE') {
      badRequest(res, 'Il file supera il limite di 5MB', 'FILE_TOO_LARGE');
      return;
    }
    if (multerError.message === 'INVALID_FILE_TYPE') {
      badRequest(res, 'Formato CV non supportato. Usa PDF, DOC o DOCX', 'INVALID_FILE_TYPE');
      return;
    }

    next(err as Error);
  });
}

export function mapPublicJob(row: PublicJobRow): Record<string, any> {
  const language = row.language ?? 'it';
  const jobType = row.job_type ?? 'fulltime';
  const remoteType = row.remote_type ?? ((row.is_remote ?? false) ? 'remote' : 'onsite');

  const postedBy = row.posted_by_id
    ? {
      id: row.posted_by_id,
      name: row.posted_by_name,
      surname: row.posted_by_surname,
      role: row.posted_by_role,
      avatar_filename: row.posted_by_avatar_filename,
      store_id: row.posted_by_store_id,
      store_name: row.posted_by_store_name,
    }
    : null;

  return {
    id: row.id,
    status: row.status,
    company_id: row.company_id,
    company_name: row.company_name,
    company_slug: row.company_slug,
      company_country: row.company_country,
    store_id: row.store_id,
    store_name: row.store_name,
    title: row.title,
    description: row.description,
    tags: row.tags ?? [],
    language,
    job_type: jobType,
    department: row.department,
    weekly_hours: row.weekly_hours,
    contract_type: row.contract_type,
    salary_min: row.salary_min,
    salary_max: row.salary_max,
    salary_period: row.salary_period,
    experience: row.experience,
    education: row.education,
    category: row.category,
    expiration_date: row.expiration_date,
    is_remote: row.is_remote ?? (remoteType === 'remote'),
    remote_type: remoteType,
    job_city: row.job_city ?? row.location_city,
    job_state: row.job_state ?? row.location_state,
    job_country: row.job_country ?? row.location_country,
    job_postal_code: row.job_postal_code ?? row.location_postal_code,
    job_address: row.job_address ?? row.location_address,
    published_at: row.published_at,
    created_at: row.created_at,
    company_group_name: row.company_group_name,
    company_logo_filename: row.company_logo_filename,
    company_banner_filename: row.company_banner_filename,
    store_code: row.store_code,
    store_logo_filename: row.store_logo_filename,
    store_employee_count: row.store_employee_count,
    applicants_count: row.applicants_count,
    posted_by: postedBy,
    location: {
      address: row.location_address,
      postal_code: row.location_postal_code,
      city: row.location_city,
      state: row.location_state,
      country: row.location_country,
    },
  };
}

function mapPublicCompany(row: PublicCompanyRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    city: row.city,
    state: row.state,
    country: row.country,
    address: row.address,
    group_name: row.group_name,
    logo_filename: row.logo_filename,
    banner_filename: row.banner_filename,
    owner_user_id: row.owner_user_id,
    owner_name: row.owner_name,
    owner_surname: row.owner_surname,
    owner_avatar_filename: row.owner_avatar_filename,
    open_roles_count: row.open_roles_count,
    company_email: row.company_email,
  };
}

function mapHiringContact(row: PublicHiringContactRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    surname: row.surname,
    role: row.role,
    avatar_filename: row.avatar_filename,
    store_id: row.store_id,
    store_name: row.store_name,
  };
}

export async function getPublicCompanyBySlug(companySlug: string): Promise<PublicCompanyRow | null> {
  return queryOne<PublicCompanyRow>(
    `SELECT c.id,
            c.name,
            c.slug,
            c.city,
            c.state,
            c.country,
            c.address,
            cg.name AS group_name,
            c.logo_filename,
            c.banner_filename,
            c.owner_user_id,
            owner.name AS owner_name,
            owner.surname AS owner_surname,
            owner.avatar_filename AS owner_avatar_filename,
            (
              SELECT COUNT(*)::int
              FROM job_postings j
              WHERE j.company_id = c.id
                AND j.status = 'published'
            ) AS open_roles_count,
            c.company_email AS company_email
     FROM companies c
     LEFT JOIN company_groups cg ON cg.id = c.group_id
     LEFT JOIN users owner ON owner.id = c.owner_user_id
     WHERE c.slug = $1
       AND c.is_active = true
     LIMIT 1`,
    [companySlug],
  );
}

export async function getPublicCompanyById(companyId: number): Promise<PublicCompanyRow | null> {
  return queryOne<PublicCompanyRow>(
    `SELECT c.id,
            c.name,
            c.slug,
            c.city,
            c.state,
            c.country,
            c.address,
            cg.name AS group_name,
            c.logo_filename,
            c.banner_filename,
            c.owner_user_id,
            owner.name AS owner_name,
            owner.surname AS owner_surname,
            owner.avatar_filename AS owner_avatar_filename,
            (
              SELECT COUNT(*)::int
              FROM job_postings j
              WHERE j.company_id = c.id
                AND j.status = 'published'
            ) AS open_roles_count,
            c.company_email AS company_email
     FROM companies c
     LEFT JOIN company_groups cg ON cg.id = c.group_id
     LEFT JOIN users owner ON owner.id = c.owner_user_id
     WHERE c.id = $1
       AND c.is_active = true
     LIMIT 1`,
    [companyId],
  );
}

export async function listPublicJobs(companySlug?: string): Promise<PublicJobRow[]> {
  const params: unknown[] = [];
  let whereClause = `c.is_active = true AND j.status IN ('published', 'closed')`;

  if (companySlug) {
    params.push(companySlug);
    whereClause += ` AND c.slug = $${params.length}`;
  }

  return query<PublicJobRow>(
    `SELECT j.id,
            j.status,
            j.company_id,
            c.name AS company_name,
            c.slug AS company_slug,
            c.country AS company_country,
            j.store_id,
            s.name AS store_name,
            j.title,
            j.description,
            j.tags,
            j.language,
            j.job_type,
            j.department,
            j.weekly_hours,
            j.contract_type,
            j.salary_min,
            j.salary_max,
            j.salary_period,
            j.experience,
            j.education,
            j.category,
            j.expiration_date,
            j.is_remote,
            j.remote_type,
            j.job_city,
            j.job_state,
            j.job_country,
            j.job_postal_code,
            j.job_address,
            j.created_at,
            j.published_at,
            cg.name AS company_group_name,
            c.logo_filename AS company_logo_filename,
            c.banner_filename AS company_banner_filename,
            s.code AS store_code,
            s.logo_filename AS store_logo_filename,
            (
              CASE
                WHEN s.id IS NULL THEN NULL
                ELSE (
                  SELECT COUNT(*)::int
                  FROM users su
                  WHERE su.store_id = s.id
                    AND su.status = 'active'
                )
              END
            ) AS store_employee_count,
            (
              SELECT COUNT(*)::int
              FROM candidates ca
              WHERE ca.job_posting_id = j.id
            ) AS applicants_count,
            COALESCE(j.job_address, s.address, c.address) AS location_address,
            COALESCE(j.job_postal_code, s.cap) AS location_postal_code,
            COALESCE(j.job_city, c.city) AS location_city,
            COALESCE(j.job_state, c.state) AS location_state,
            COALESCE(j.job_country, c.country) AS location_country,
            creator.id AS posted_by_id,
            creator.name AS posted_by_name,
            creator.surname AS posted_by_surname,
            creator.role::text AS posted_by_role,
            creator.avatar_filename AS posted_by_avatar_filename,
            creator.store_id AS posted_by_store_id,
            creator_store.name AS posted_by_store_name
     FROM job_postings j
     JOIN companies c ON c.id = j.company_id
     LEFT JOIN company_groups cg ON cg.id = c.group_id
     LEFT JOIN stores s ON s.id = j.store_id
     LEFT JOIN users creator ON creator.id = j.created_by_id
     LEFT JOIN stores creator_store ON creator_store.id = creator.store_id
     WHERE ${whereClause}
     ORDER BY COALESCE(j.published_at, j.created_at) DESC, j.id DESC`,
    params,
  );
}

export async function getPublicJobById(jobId: number, companySlug?: string): Promise<PublicJobRow | null> {
  const params: unknown[] = [jobId];
  const companyFilter = companySlug
    ? ` AND c.slug = $2`
    : '';

  if (companySlug) {
    params.push(companySlug);
  }

  return queryOne<PublicJobRow>(
    `SELECT j.id,
            j.status,
            j.company_id,
            c.name AS company_name,
            c.slug AS company_slug,
            j.store_id,
            s.name AS store_name,
            j.title,
            j.description,
            j.tags,
            j.language,
            j.job_type,
            j.department,
            j.weekly_hours,
            j.contract_type,
            j.salary_min,
            j.salary_max,
            j.salary_period,
            j.experience,
            j.education,
            j.category,
            j.expiration_date,
            j.is_remote,
            j.remote_type,
            j.job_city,
            j.job_state,
            j.job_country,
            j.job_postal_code,
            j.job_address,
            j.created_at,
            j.published_at,
            cg.name AS company_group_name,
            c.logo_filename AS company_logo_filename,
            c.banner_filename AS company_banner_filename,
            s.code AS store_code,
            s.logo_filename AS store_logo_filename,
            (
              CASE
                WHEN s.id IS NULL THEN NULL
                ELSE (
                  SELECT COUNT(*)::int
                  FROM users su
                  WHERE su.store_id = s.id
                    AND su.status = 'active'
                )
              END
            ) AS store_employee_count,
            (
              SELECT COUNT(*)::int
              FROM candidates ca
              WHERE ca.job_posting_id = j.id
            ) AS applicants_count,
            COALESCE(j.job_address, s.address, c.address) AS location_address,
            COALESCE(j.job_postal_code, s.cap) AS location_postal_code,
            COALESCE(j.job_city, c.city) AS location_city,
            COALESCE(j.job_state, c.state) AS location_state,
            COALESCE(j.job_country, c.country) AS location_country,
            creator.id AS posted_by_id,
            creator.name AS posted_by_name,
            creator.surname AS posted_by_surname,
            creator.role::text AS posted_by_role,
            creator.avatar_filename AS posted_by_avatar_filename,
            creator.store_id AS posted_by_store_id,
            creator_store.name AS posted_by_store_name
     FROM job_postings j
     JOIN companies c ON c.id = j.company_id
     LEFT JOIN company_groups cg ON cg.id = c.group_id
     LEFT JOIN stores s ON s.id = j.store_id
     LEFT JOIN users creator ON creator.id = j.created_by_id
     LEFT JOIN stores creator_store ON creator_store.id = creator.store_id
     WHERE j.id = $1
       AND c.is_active = true
       AND j.status IN ('published', 'closed')
       ${companyFilter}
     LIMIT 1`,
    params,
  );
}

async function listHiringTeam(companyId: number, leadUserId: number | null): Promise<PublicHiringContactRow[]> {
  return query<PublicHiringContactRow>(
    `SELECT u.id,
            u.name,
            u.surname,
            u.role::text AS role,
            u.avatar_filename,
            u.store_id,
            s.name AS store_name
     FROM users u
     LEFT JOIN stores s ON s.id = u.store_id
     WHERE u.company_id = $1
       AND u.status = 'active'
       AND u.role IN ('admin', 'hr', 'area_manager', 'store_manager')
     ORDER BY
       CASE WHEN $2::int IS NOT NULL AND u.id = $2 THEN 0 ELSE 1 END,
       CASE u.role::text
         WHEN 'admin' THEN 0
         WHEN 'hr' THEN 1
         WHEN 'area_manager' THEN 2
         WHEN 'store_manager' THEN 3
         ELSE 4
       END,
       u.name ASC,
       u.id ASC
     LIMIT 8`,
    [companyId, leadUserId],
  );
}

router.get('/jobs', asyncHandler(async (_req: Request, res: Response) => {
  const jobs = await listPublicJobs();
  ok(res, { jobs: jobs.map(mapPublicJob) });
}));

router.get('/jobs/:jobId', asyncHandler(async (req: Request, res: Response) => {
  const jobId = parsePositiveInt(req.params.jobId);
  if (!jobId) {
    badRequest(res, 'ID posizione non valido', 'INVALID_JOB_ID');
    return;
  }

  const job = await getPublicJobById(jobId);
  if (!job) {
    notFound(res, 'Posizione non trovata');
    return;
  }

  const company = await getPublicCompanyById(job.company_id);
  if (!company) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  const hiringTeam = await listHiringTeam(job.company_id, job.posted_by_id);

  ok(res, {
    company: mapPublicCompany(company),
    job: mapPublicJob(job),
    hiring_team: hiringTeam.map(mapHiringContact),
  });
}));

router.post('/jobs/:jobId/apply', resumeUploadMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const jobId = parsePositiveInt(req.params.jobId);
  if (!jobId) {
    cleanupUploadedResume(req);
    badRequest(res, 'ID posizione non valido', 'INVALID_JOB_ID');
    return;
  }

  const body = req.body as Record<string, unknown>;

  const fullName = normalizeOptionalText(body.full_name ?? body.fullName, 255);
  const email = normalizeOptionalText(body.email, 255);
  const phone = normalizeOptionalText(body.phone, 50);
  const linkedinUrl = normalizeOptionalText(body.linkedin_url ?? body.linkedinUrl, 255);
  const coverLetter = normalizeOptionalText(body.cover_letter ?? body.coverLetter, 1000);
  const applicantLocale = normalizeOptionalText(body.applicant_locale ?? body.applicantLocale, 10) ?? 'it';
  const availability = normalizeOptionalText(body.availability, 120);
  const gender = normalizeOptionalText(body.gender, 30);
  const nationality = normalizeOptionalText(body.nationality, 120);
  const country = normalizeOptionalText(body.country, 120);
  const state = normalizeOptionalText(body.state, 120);
  const city = normalizeOptionalText(body.city, 120);
  const dateOfBirth = normalizeOptionalText(body.date_of_birth ?? body.dateOfBirth, 32);
  const currentEmployer = normalizeOptionalText(body.current_employer ?? body.currentEmployer, 255);
  const currentRole = normalizeOptionalText(body.current_role ?? body.currentRole, 255);
  const maritalStatus = normalizeOptionalText(body.marital_status ?? body.maritalStatus, 50);
  const hasCurrentEmployer = normalizeOptionalText(body.has_current_employer ?? body.hasCurrentEmployer, 12);
  const applicationDate = normalizeOptionalText(body.application_date ?? body.applicationDate, 32);
  const startDate = normalizeOptionalText(body.start_date ?? body.startDate, 32);
  const postalCode = normalizeOptionalText(body.postal_code ?? body.postalCode, 20);
  const gdprConsent = parseBooleanInput(body.gdpr_consent ?? body.gdprConsent);
  const utmSource = normalizeOptionalText(req.query.utm_source, 100) ?? 'direct';

  let screenerAnswers: any[] = [];
  if (body.screener_answers) {
    try {
      screenerAnswers = typeof body.screener_answers === 'string'
        ? JSON.parse(body.screener_answers)
        : (Array.isArray(body.screener_answers) ? body.screener_answers : []);
    } catch (e) {
      console.error('[PUBLIC_APPLY] Failed to parse screener_answers', e);
    }
  }

  if (!fullName) {
    cleanupUploadedResume(req);
    badRequest(res, 'Nome e cognome obbligatori', 'VALIDATION_ERROR');
    return;
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    cleanupUploadedResume(req);
    badRequest(res, 'Email non valida', 'VALIDATION_ERROR');
    return;
  }

  if (!req.file) {
    badRequest(res, 'CV obbligatorio', 'NO_FILE');
    return;
  }

  if (!gdprConsent) {
    cleanupUploadedResume(req);
    badRequest(res, 'Consenso privacy obbligatorio', 'PRIVACY_CONSENT_REQUIRED');
    return;
  }

  const job = await queryOne<{ id: number; company_id: number; store_id: number | null; status: string; title: string; company_name: string; company_logo_filename: string | null }>(
    `SELECT j.id, j.company_id, j.store_id, j.status, j.title, c.name AS company_name, c.logo_filename AS company_logo_filename
     FROM job_postings j
     JOIN companies c ON c.id = j.company_id
     WHERE j.id = $1`,
    [jobId],
  );

  if (!job) {
    cleanupUploadedResume(req);
    notFound(res, 'Posizione non trovata');
    return;
  }

  if (job.status !== 'published') {
    cleanupUploadedResume(req);
    badRequest(res, 'Posizione chiusa', 'JOB_CLOSED');
    return;
  }

  const duplicate = await queryOne<{ id: number }>(
    `SELECT id
     FROM candidates
     WHERE job_posting_id = $1
       AND email IS NOT NULL
       AND LOWER(email) = LOWER($2)
       AND created_at >= NOW() - INTERVAL '120 days'
     LIMIT 1`,
    [jobId, email],
  );

  if (duplicate) {
    cleanupUploadedResume(req);
    conflict(res, 'Hai gia inviato una candidatura recente per questa posizione', 'APPLICATION_ALREADY_EXISTS');
    return;
  }

  const sourceRef = JSON.stringify({
    channel: 'public-careers',
    application_source: 'public-careers',
    application_channel: 'public',
    utm_source: utmSource,
    applicant_locale: applicantLocale,
    linkedin_url: linkedinUrl,
    cover_letter: coverLetter,
    availability,
    gender,
    nationality,
    country,
    state,
    city,
    date_of_birth: dateOfBirth,
    current_employer: currentEmployer,
    current_role: currentRole,
    marital_status: maritalStatus,
    has_current_employer: hasCurrentEmployer,
    application_date: applicationDate,
    start_date: startDate,
    postal_code: postalCode,
    uploaded_filename: req.file.filename,
    screener_answers: screenerAnswers,
  });

  const resumeRelativePath = `public-cv/${req.file.filename}`;

  const inserted = await queryOne<{ id: number }>(
    `INSERT INTO candidates (
       company_id,
       store_id,
       job_posting_id,
       full_name,
       email,
       phone,
       cv_path,
       resume_path,
       linkedin_url,
       cover_letter,
       tags,
       source,
       source_ref,
       gdpr_consent,
       applicant_locale,
       consent_accepted_at,
       applied_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12, $13, $14, $15, NOW(), NOW())
     RETURNING id`,
    [
      job.company_id,
      job.store_id,
      jobId,
      fullName,
      email,
      phone,
      resumeRelativePath,
      resumeRelativePath,
      linkedinUrl,
      coverLetter,
      ['public-careers', 'external', `locale:${applicantLocale}`],
      'external',
      sourceRef,
      gdprConsent,
      applicantLocale,
    ],
  );

  if (!inserted) {
    cleanupUploadedResume(req);
    badRequest(res, 'Impossibile inviare la candidatura', 'APPLICATION_FAILED');
    return;
  }

  // Attach the fixed website logo
  let attachments: { filename: string; content: Buffer; contentType: string; cid: string }[] = [];
  const logoPath = path.join(process.cwd(), '../hr-system-demo-frontend/src/assets/fusaro-logo-2.png');
  try {
    if (fs.existsSync(logoPath)) {
      const logoBuffer = fs.readFileSync(logoPath);
      attachments.push({
        filename: 'fusaro-logo-2.png',
        content: logoBuffer,
        contentType: 'image/png',
        cid: 'website-logo'
      });
    }
  } catch (e) {
    console.error('[PUBLIC_CAREERS] Failed to read static logo for email', e);
  }

  const htmlDataRows = [
    fullName && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569; width: 40%;"><strong>Nome e cognome</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${fullName}</td></tr>`,
    email && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Email</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${email}</td></tr>`,
    phone && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Telefono</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${phone}</td></tr>`,
    linkedinUrl && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>LinkedIn</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${linkedinUrl}</td></tr>`,
    coverLetter && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Lettera di presentazione</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${coverLetter.replace(/\n/g, '<br/>')}</td></tr>`,
    availability && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Disponibilità</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${availability}</td></tr>`,
    gender && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Genere</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${gender}</td></tr>`,
    nationality && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Nazionalità</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${nationality}</td></tr>`,
    country && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Nazione</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${country}</td></tr>`,
    state && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Provincia</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${state}</td></tr>`,
    city && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Città</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${city}</td></tr>`,
    dateOfBirth && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Data di nascita</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${dateOfBirth}</td></tr>`,
    currentEmployer && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Attuale datore di lavoro</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${currentEmployer}</td></tr>`,
    currentRole && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Attuale ruolo</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${currentRole}</td></tr>`,
    maritalStatus && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Stato civile</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${maritalStatus}</td></tr>`,
    startDate && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Data di inizio desiderata</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${startDate}</td></tr>`,
    postalCode && `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569;"><strong>Codice postale</strong></td><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #0f172a;">${postalCode}</td></tr>`
  ].filter(Boolean).join('');

  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; background-color: #ffffff; padding: 32px; border-radius: 8px; border: 1px solid #e2e8f0;">
      ${attachments.length > 0 ? `<div style="text-align: center; margin-bottom: 32px;"><img src="cid:website-logo" alt="Logo" style="max-height: 80px; max-width: 200px; object-fit: contain;" /></div>` : ''}
      <h2 style="color: #0f172a; text-align: center; margin-bottom: 24px; font-size: 22px;">Candidatura inviata con successo!</h2>
      <p style="font-size: 15px; line-height: 1.6; color: #334155;">Ciao <strong>${fullName}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #334155;">Ti confermiamo di aver ricevuto la tua candidatura per la posizione di <strong style="color: #0ea5e9;">${job.title}</strong> presso <strong>${job.company_name}</strong>.</p>
      
      <div style="margin-top: 32px; padding: 24px; background-color: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
        <h3 style="margin-top: 0; margin-bottom: 16px; color: #0f172a; font-size: 16px;">Riepilogo dei tuoi dati</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          ${htmlDataRows}
        </table>
      </div>
      
      <p style="margin-top: 32px; font-size: 13px; line-height: 1.5; color: #64748b; text-align: center;">
        Il team di selezione di ${job.company_name} esaminerà il tuo profilo e ti contatterà al più presto.<br>
        Grazie per il tuo interesse!
      </p>
    </div>
  `;

  sendEmailForCompany(job.company_id, {
    to: email,
    subject: `Conferma candidatura: ${job.title} - ${job.company_name}`,
    html,
    attachments
  }).catch(e => console.error('[PUBLIC_CAREERS] Failed to send application confirmation email', e));

  created(res, { application_id: inserted.id }, 'Candidatura inviata con successo');
}));

router.get('/companies/:companySlug', asyncHandler(async (req: Request, res: Response) => {
  const companySlug = (req.params.companySlug || '').trim().toLowerCase();
  if (!companySlug) {
    badRequest(res, 'Slug azienda non valido', 'INVALID_COMPANY_SLUG');
    return;
  }

  const company = await getPublicCompanyBySlug(companySlug);
  if (!company) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  ok(res, { company: mapPublicCompany(company) });
}));

router.get('/:companySlug/jobs', asyncHandler(async (req: Request, res: Response) => {
  const companySlug = (req.params.companySlug || '').trim().toLowerCase();
  if (!companySlug) {
    badRequest(res, 'Slug azienda non valido', 'INVALID_COMPANY_SLUG');
    return;
  }

  const company = await getPublicCompanyBySlug(companySlug);
  if (!company) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  const jobs = await listPublicJobs(companySlug);

  ok(res, {
    company: mapPublicCompany(company),
    jobs: jobs.map(mapPublicJob),
  });
}));

router.get('/:companySlug/jobs/:jobId', asyncHandler(async (req: Request, res: Response) => {
  const companySlug = (req.params.companySlug || '').trim().toLowerCase();
  const jobId = parsePositiveInt(req.params.jobId);

  if (!companySlug) {
    badRequest(res, 'Slug azienda non valido', 'INVALID_COMPANY_SLUG');
    return;
  }

  if (!jobId) {
    badRequest(res, 'ID posizione non valido', 'INVALID_JOB_ID');
    return;
  }

  const company = await getPublicCompanyBySlug(companySlug);
  if (!company) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  const job = await getPublicJobById(jobId, companySlug);
  if (!job) {
    notFound(res, 'Posizione non trovata');
    return;
  }

  const hiringTeam = await listHiringTeam(job.company_id, job.posted_by_id);

  ok(res, {
    company: mapPublicCompany(company),
    job: mapPublicJob(job),
    hiring_team: hiringTeam.map(mapHiringContact),
  });
}));

// Route 2: GET /api/public/indeed-apply-questions/:companySlug/:jobId
router.get(
  '/indeed-apply-questions/:companySlug/:jobId',
  asyncHandler(async (req: Request, res: Response) => {
    const { companySlug, jobId: jobIdStr } = req.params;
    const jobId = parseInt(jobIdStr, 10);
    if (Number.isNaN(jobId)) {
      res.json({ questions: [] });
      return;
    }

    // Verify that the job exists and matches companySlug
    const job = await queryOne<{ id: number }>(
      `SELECT j.id
       FROM job_postings j
       JOIN companies c ON c.id = j.company_id
       WHERE j.id = $1 AND c.slug = $2 AND j.status = 'published'`,
      [jobId, companySlug]
    );
    if (!job) {
      res.json({ questions: [] });
      return;
    }

    const rows = await query<{
      id: number;
      question_text: string;
      question_type: string;
      options: any;
      is_knockout: boolean;
      knockout_value: string | null;
      is_required: boolean;
    }>(
      `SELECT id, question_text, question_type, options, is_knockout, knockout_value, is_required
       FROM job_screener_questions
       WHERE job_id = $1
       ORDER BY display_order ASC, id ASC`,
      [jobId]
    );

    const questions = rows.map((row) => {
      let optionsArray: any[] = [];
      if (row.options) {
        if (typeof row.options === 'string') {
          try {
            optionsArray = JSON.parse(row.options);
          } catch {
            optionsArray = [];
          }
        } else if (Array.isArray(row.options)) {
          optionsArray = row.options;
        }
      }

      const formatted: any = {
        id: `q_${row.id}`,
        type: row.question_type,
        label: row.question_text,
        required: row.is_required !== false,
        isKnockout: !!row.is_knockout
      };

      if (row.question_type === 'radio' || row.question_type === 'checkbox') {
        const isYesNo = row.question_type === 'radio' && optionsArray.length === 2 && (() => {
          const opt0 = typeof optionsArray[0] === 'string' ? optionsArray[0] : (optionsArray[0]?.value || optionsArray[0]?.label || '');
          const opt1 = typeof optionsArray[1] === 'string' ? optionsArray[1] : (optionsArray[1]?.value || optionsArray[1]?.label || '');
          const norm0 = String(opt0).toLowerCase().trim();
          const norm1 = String(opt1).toLowerCase().trim();
          return (norm0 === 'yes' || norm0 === 'sì' || norm0 === 'si') && (norm1 === 'no');
        })();

        if (isYesNo) {
          formatted.options = [
            { label: 'Sì', value: 'yes' },
            { label: 'No', value: 'no' }
          ];
          if (row.is_knockout && row.knockout_value) {
            const kValNorm = String(row.knockout_value).toLowerCase().trim();
            const targetVal = (kValNorm === 'yes' || kValNorm === 'sì' || kValNorm === 'si') ? 'yes' : 'no';
            formatted.options = formatted.options.map((opt: any) => {
              if (opt.value === targetVal) {
                return { ...opt, isKnockout: true };
              }
              return opt;
            });
          }
        } else {
          formatted.options = optionsArray.map((opt: any) => {
            const label = typeof opt === 'string' ? opt : (opt.label || opt.value || '');
            const value = typeof opt === 'string' ? opt : (opt.value || opt.label || '');
            const optionObj: any = { label, value };
            if (row.is_knockout && row.knockout_value && String(row.knockout_value).trim() === String(value).trim()) {
              optionObj.isKnockout = true;
            }
            return optionObj;
          });
        }
      }

      return formatted;
    });

    res.json({ questions });
  })
);

// Route 1: POST /api/public/indeed-apply/:companySlug
// Public webhook (no auth by design). Protected by HMAC signature verification
// and a rate limit against abuse/spam. Max 60 requests/minute per IP — far above
// any legitimate Indeed delivery volume.
router.post(
  '/indeed-apply/:companySlug',
  rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'indeed-apply', message: 'Too Many Requests' }),
  raw({ type: '*/*' }),
  asyncHandler(async (req: Request, res: Response) => {
    const { companySlug } = req.params;
    const signature = req.headers['x-indeed-signature'] as string;
    const rawBody = req.body; // Buffer, since we used raw() middleware

    // Send HTTP 200 immediately
    res.status(200).send('OK');

    // Run signature verification and candidate creation asynchronously
    setImmediate(async () => {
      try {
        // Resolve company-specific or global secret. NO hardcoded fallback: if no
        // secret is configured we FAIL CLOSED and reject the payload, rather than
        // trusting a value that lives in the source (which anyone could use to
        // forge a valid signature for any company). Resolved from the company's
        // own stored (encrypted) secret first, then the environment variable.
        const secret = await resolveIndeedSecretBySlug(companySlug);

        if (!secret) {
          console.error(`Indeed Apply: no INDEED_APPLY_SECRET configured for company '${companySlug}' — payload rejected (fail-closed).`);
          return;
        }

        // Calculate the expected HMAC and compare in constant time.
        const hmac = crypto.createHmac('sha1', secret);
        hmac.update(rawBody || '');
        const expectedSig = hmac.digest('base64');

        const providedBuf = Buffer.from(signature || '', 'utf8');
        const expectedBuf = Buffer.from(expectedSig, 'utf8');
        const signatureValid = providedBuf.length === expectedBuf.length
          && crypto.timingSafeEqual(providedBuf, expectedBuf);

        if (!signatureValid) {
          console.warn('Indeed Apply: invalid HMAC signature — payload discarded');
          return;
        }

        // Parse JSON payload
        let payload: any;
        try {
          payload = JSON.parse(rawBody.toString());
        } catch (err: any) {
          console.error('Indeed Apply: malformed JSON payload:', err.message);
          return;
        }

        const { applicant, job: indeedJob, screenerQuestionsAndAnswers } = payload;
        const fullName = applicant?.fullName || '';
        const email = applicant?.email || '';
        const phone = applicant?.phoneNumber || '';
        const resumeData = applicant?.resume?.file?.data || null;  // Base64
        const resumeFileName = applicant?.resume?.file?.fileName || 'resume.pdf';
        const jobIdStr = indeedJob?.jobId || '';
        const indeedApplyId = payload.indeedApplyID || payload.id || payload.appliedJobID || '';

        const jobId = parseInt(jobIdStr, 10);
        if (Number.isNaN(jobId)) {
          console.error(`Indeed Apply: invalid job ID: ${jobIdStr}`);
          return;
        }

        // Verify job and company exist
        const job = await queryOne<{ id: number; company_id: number; store_id: number | null; status: string; title: string; company_name: string }>(
          `SELECT j.id, j.company_id, j.store_id, j.status, j.title, c.name AS company_name
           FROM job_postings j
           JOIN companies c ON c.id = j.company_id
           WHERE j.id = $1`,
          [jobId],
        );

        if (!job) {
          console.error(`Indeed Apply: job with ID ${jobId} not found`);
          return;
        }

        const company = await queryOne<{ id: number; slug: string; name: string }>(
          `SELECT id, slug, name FROM companies WHERE id = $1 LIMIT 1`,
          [job.company_id],
        );

        if (!company || company.slug !== companySlug) {
          console.error(`Indeed Apply: company slug mismatch: URL slug "${companySlug}", job company slug "${company?.slug}"`);
          return;
        }

        // Check for duplicate candidate (same email AND same job ID) within the last 120 days
        if (email) {
          const duplicateCandidate = await queryOne<{ id: number }>(
            `SELECT id FROM candidates
             WHERE job_posting_id = $1
               AND email IS NOT NULL
               AND LOWER(email) = LOWER($2)
               AND created_at >= NOW() - INTERVAL '120 days'
             LIMIT 1`,
            [job.id, email]
          );

          if (duplicateCandidate) {
            console.warn(`Indeed Apply: duplicate application skipped for email ${email} on job ID ${job.id}`);
            return;
          }
        }

        // Decode and save resume
        let resumeRelativePath: string | undefined = undefined;
        if (resumeData) {
          try {
            const resumeBuffer = Buffer.from(resumeData, 'base64');
            const ext = path.extname(resumeFileName) || '.pdf';
            const baseName = path.basename(resumeFileName, ext);
            const random = Math.random().toString(36).slice(2, 10);
            const uniqueFileName = `indeed-${baseName}-${Date.now()}-${random}${ext}`;
            const absolutePath = path.join(RESUME_UPLOAD_DIR, uniqueFileName);

            fs.writeFileSync(absolutePath, resumeBuffer);
            resumeRelativePath = `public-cv/${uniqueFileName}`;
          } catch (fileErr: any) {
            console.error('Indeed Apply: failed to save resume file:', fileErr.message);
          }
        }

        // Create candidate record
        const sourceRef = JSON.stringify({
          channel: 'indeed',
          application_source: 'indeed',
          application_channel: 'indeed',
          screener_answers: screenerQuestionsAndAnswers || [],
          phone,
          resume_filename: resumeFileName,
        });

        const candidate = await createCandidate(job.company_id, {
          fullName,
          email: email || undefined,
          phone: phone || undefined,
          jobPostingId: job.id,
          storeId: job.store_id || undefined,
          tags: ['indeed-apply', 'external'],
          cvPath: resumeRelativePath,
          resumePath: resumeRelativePath,
          source: 'indeed',
          sourceRef,
          gdprConsent: true,
          appliedAt: new Date().toISOString(),
          indeedApplyId: indeedApplyId || undefined,
        });

        // Trigger recruiter notification flow
        const recruiters = await query<{ id: number; locale: string | null }>(
          `SELECT id, locale FROM users
           WHERE company_id = $1 AND role IN ('admin', 'hr') AND status = 'active'`,
          [job.company_id],
        );

        for (const recruiter of recruiters) {
          const recLocale = recruiter.locale || 'it';
          const title = t(recLocale, 'notifications.ats_candidate_received.title');
          const baseMsg = t(recLocale, 'notifications.ats_candidate_received.message', { name: candidate.fullName });
          const message = recLocale === 'it'
            ? `${baseMsg} (Fonte: Indeed)`
            : `${baseMsg} (Source: Indeed)`;

          await sendNotification({
            companyId: job.company_id,
            userId: recruiter.id,
            type: 'ats.candidate_received',
            title,
            message,
            priority: 'high',
            locale: recLocale,
            channels: ['in_app', 'email'],
            emailSubject: recLocale === 'it'
              ? `Nuova candidatura da Indeed: ${candidate.fullName}`
              : `New application from Indeed: ${candidate.fullName}`,
            emailBody: recLocale === 'it'
              ? `<p>Il candidato <strong>${candidate.fullName}</strong> ha inviato la sua candidatura da <strong>Indeed</strong> per la posizione di <strong>${job.title}</strong>.</p>`
              : `<p>Candidate <strong>${candidate.fullName}</strong> has submitted their application from <strong>Indeed</strong> for the position of <strong>${job.title}</strong>.</p>`,
          });
        }
      } catch (err: any) {
        console.error('Indeed Apply: error in asynchronous processing:', err.message);
      }
    });
  })
);

// ── Legal Documents Endpoints ────────────────────────────────────────────────
// GET /api/public/legal-documents/:key (Public)
router.get(
  '/legal-documents/:key',
  asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params;
    const lang = (req.query.lang as string) === 'en' ? 'en' : 'it';

    if (!['privacy', 'terms', 'cookie'].includes(key)) {
      return notFound(res, 'Documento non trovato');
    }

    const doc = await queryOne<{
      id: number;
      document_key: string;
      language: string;
      title: string;
      content: string;
      platform_company_name: string | null;
      platform_company_email: string | null;
      updated_at: string;
      updated_by_name: string | null;
    }>(
      `SELECT ld.id, ld.document_key, ld.language, ld.title, ld.content,
              ld.platform_company_name, ld.platform_company_email, ld.updated_at,
              CONCAT(u.name, ' ', u.surname) as updated_by_name
       FROM legal_documents ld
       LEFT JOIN users u ON u.id = ld.updated_by
       WHERE ld.document_key = $1 AND ld.language = $2`,
      [key, lang]
    );

    if (!doc) {
      return notFound(res, 'Documento non trovato');
    }

    return ok(res, {
      document: doc
    });
  })
);

// PUT /api/public/legal-documents/:key (Super Admin Only)
router.put(
  '/legal-documents/:key',
  authenticate,
  requireSuperAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params;
    const { language, title, content, platform_company_name, platform_company_email } = req.body;
    const userId = req.user!.userId;

    if (!['privacy', 'terms', 'cookie'].includes(key)) {
      return badRequest(res, 'Chiave documento non valida', 'INVALID_KEY');
    }
    if (!language || !title || content === undefined) {
      return badRequest(res, 'Parametri obbligatori mancanti', 'MISSING_PARAMS');
    }
    if (!['it', 'en'].includes(language)) {
      return badRequest(res, 'Lingua non supportata', 'UNSUPPORTED_LANGUAGE');
    }

    const queryText = `
      INSERT INTO legal_documents (document_key, language, title, content, platform_company_name, platform_company_email, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      ON CONFLICT (document_key, language) DO UPDATE
      SET title = EXCLUDED.title,
          content = EXCLUDED.content,
          platform_company_name = EXCLUDED.platform_company_name,
          platform_company_email = EXCLUDED.platform_company_email,
          updated_by = EXCLUDED.updated_by,
          updated_at = CURRENT_TIMESTAMP
      RETURNING id, document_key, language, title, content, platform_company_name, platform_company_email, updated_at
    `;
    const result = await queryOne(queryText, [key, language, title, content, platform_company_name || null, platform_company_email || null, userId]);

    // Sync platform company name and email globally to all legal documents
    await query(
      `UPDATE legal_documents 
       SET platform_company_name = $1, 
           platform_company_email = $2`,
      [platform_company_name || null, platform_company_email || null]
    );

    // Fetch user full name for response metadata
    const user = await queryOne<{ name: string; surname: string | null }>(
      `SELECT name, surname FROM users WHERE id = $1`,
      [userId]
    );
    const updatedByName = user ? `${user.name} ${user.surname ?? ''}`.trim() : '';

    return ok(res, {
      document: {
        ...result,
        updated_by_name: updatedByName
      }
    });
  })
);

export default router;
