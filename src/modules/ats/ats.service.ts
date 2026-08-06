import { query, queryOne } from '../../config/database';
import { getIndeedAdapter } from '../../services/indeed.adapter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = 'draft' | 'published' | 'closed';
export type JobLanguage = 'it' | 'en' | 'both';
export type JobType = 'fulltime' | 'parttime' | 'contract' | 'internship';
export type RemoteType = 'onsite' | 'hybrid' | 'remote';
export type CandidateStatus = 'received' | 'review' | 'phone_interview' | 'interview' | 'hired' | 'rejected';

// Valid forward stage transitions — backward moves are not allowed
const FORWARD_TRANSITIONS: Record<CandidateStatus, CandidateStatus[]> = {
  received:        ['review',          'rejected'],
  review:          ['phone_interview', 'interview', 'rejected'],
  phone_interview: ['interview',       'rejected'],
  interview:       ['hired',           'rejected'],
  hired:           [],
  rejected:        [],
};

export function isValidTransition(from: CandidateStatus, to: CandidateStatus): boolean {
  return FORWARD_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface JobPosting {
  id: number;
  companyId: number;
  companySlug: string;
  companyName: string | null;
  companyLogoFilename: string | null;
  companyGroupName: string | null;
  companyCountry: string | null;
  companyOwnerName: string | null;
  companyOwnerSurname: string | null;
  companyOwnerAvatarFilename: string | null;
  companyStoreCount: number | null;
  storeId: number | null;
  storeName: string | null;
  storeLogoFilename: string | null;
  storeCountry: string | null;
  storeHrName: string | null;
  storeHrSurname: string | null;
  storeHrAvatarFilename: string | null;
  storeAreaManagerName: string | null;
  storeAreaManagerSurname: string | null;
  storeAreaManagerAvatarFilename: string | null;
  storeManagerName: string | null;
  storeManagerSurname: string | null;
  storeManagerAvatarFilename: string | null;
  location: string;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  address: string | null;
  isRemote: boolean;
  remoteType: RemoteType;
  jobCity: string | null;
  jobState: string | null;
  jobCountry: string | null;
  jobPostalCode: string | null;
  jobAddress: string | null;
  department: string | null;
  weeklyHours: number | null;
  contractType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryPeriod: string | null;
  targetRole: string | null;
  experience: string | null;
  education: string | null;
  category: string | null;
  expirationDate: string | null;
  title: string;
  description: string | null;
  tags: string[];
  language: JobLanguage;
  jobType: JobType;
  status: JobStatus;
  source: string;
  indeedPostId: string | null;
  referenceId: string | null;
  createdById: number | null;
  createdByName: string | null;
  createdBySurname: string | null;
  createdByRole: string | null;
  createdByAvatarFilename: string | null;
  createdByStoreName: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export interface Candidate {
  id: number;
  companyId: number;
  storeId: number | null;
  jobPostingId: number | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  cvPath: string | null;
  resumePath: string | null;
  linkedinUrl: string | null;
  coverLetter: string | null;
  tags: string[];
  status: CandidateStatus;
  rejectionReason: string | null;
  source: string;
  sourceRef: string | null;
  gdprConsent: boolean;
  unread: boolean;
  applicantLocale: string | null;
  consentAcceptedAt: string | null;
  appliedAt: string | null;
  lastStageChange: string;
  indeedApplyId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeedCompany {
  id: number;
  name: string;
  slug: string;
  city: string | null;
  state: string | null;
  country: string | null;
  address: string | null;
  companyEmail?: string | null;
}

export interface FeedJob extends JobPosting {
  companyName: string;
  storeName: string | null;
  storeAddress: string | null;
  storePostalCode: string | null;
  storeCity: string | null;
  storeState: string | null;
  storeCountry: string | null;
  companyCity: string | null;
  companyState: string | null;
  companyCountry: string | null;
  companyAddress: string | null;
  companyEmail?: string | null;
}

export interface Interview {
  id: number;
  candidateId: number;
  interviewerId: number | null;
  storeId: number | null;
  interviewType: 'phone' | 'in_person' | 'video';
  scheduledAt: string;
  location: string | null;
  description: string | null;
  notes: string | null;
  durationMinutes: number | null;
  icsUid: string | null;
  feedback: string | null;
  createdAt: string;
  updatedAt: string;
  // Extended fields for calendar view
  candidateName?: string;
  candidateSurname?: string;
  candidateAvatarFilename?: string | null;
  candidateEmail?: string | null;
  candidatePhone?: string | null;
  candidateLinkedinUrl?: string | null;
  resumePath?: string | null;
  cvPath?: string | null;
  positionTitle?: string;
  positionId?: number | null;
  positionJobType?: string;
  positionWeeklyHours?: number;
  positionSalaryMin?: number;
  positionSalaryMax?: number;
  positionLocation?: string;
  companyId?: number;
  companyName?: string;
  companyLogoFilename?: string | null;
  companyGroupName?: string | null;
  storeName?: string | null;
  storeLogoFilename?: string | null;
  interviewerName?: string;
  interviewerSurname?: string;
  interviewerAvatarFilename?: string | null;
  interviewerRole?: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapJobPosting(row: Record<string, unknown>): JobPosting {
  const city = row.city as string | null;
  const state = row.state as string | null;
  const country = row.country as string | null;
  const postalCode = row.postal_code as string | null;
  const address = row.address as string | null;
  const remoteTypeRaw = row.remote_type as string | null;
  const remoteType: RemoteType = remoteTypeRaw === 'remote' || remoteTypeRaw === 'hybrid' || remoteTypeRaw === 'onsite'
    ? remoteTypeRaw
    : ((row.is_remote as boolean | null) ? 'remote' : 'onsite');

  const derivedLocation = [city, state, country].filter(Boolean).join(', ');

  return {
    id: row.id as number,
    companyId: row.company_id as number,
    companySlug: row.company_slug as string,
    companyName: (row.company_name as string | null) ?? null,
    companyLogoFilename: (row.company_logo_filename as string | null) ?? null,
    companyGroupName: (row.company_group_name as string | null) ?? null,
    companyCountry: (row.company_country as string | null) ?? null,
    companyOwnerName: (row.company_owner_name as string | null) ?? null,
    companyOwnerSurname: (row.company_owner_surname as string | null) ?? null,
    companyOwnerAvatarFilename: (row.company_owner_avatar_filename as string | null) ?? null,
    companyStoreCount: typeof row.company_store_count === 'number' ? (row.company_store_count as number) : null,
    storeId: row.store_id as number | null,
    storeName: (row.store_name as string | null) ?? null,
    storeLogoFilename: (row.store_logo_filename as string | null) ?? null,
    storeCountry: (row.store_country as string | null) ?? null,
    storeHrName: (row.store_hr_name as string | null) ?? null,
    storeHrSurname: (row.store_hr_surname as string | null) ?? null,
    storeHrAvatarFilename: (row.store_hr_avatar_filename as string | null) ?? null,
    storeAreaManagerName: (row.store_area_manager_name as string | null) ?? null,
    storeAreaManagerSurname: (row.store_area_manager_surname as string | null) ?? null,
    storeAreaManagerAvatarFilename: (row.store_area_manager_avatar_filename as string | null) ?? null,
    storeManagerName: (row.store_manager_name as string | null) ?? null,
    storeManagerSurname: (row.store_manager_surname as string | null) ?? null,
    storeManagerAvatarFilename: (row.store_manager_avatar_filename as string | null) ?? null,
    location: (row.location as string | null) ?? derivedLocation,
    city,
    state,
    country,
    postalCode,
    address,
    isRemote: remoteType === 'remote',
    remoteType,
    jobCity: row.job_city as string | null,
    jobState: row.job_state as string | null,
    jobCountry: row.job_country as string | null,
    jobPostalCode: row.job_postal_code as string | null,
    jobAddress: row.job_address as string | null,
    department: row.department as string | null,
    weeklyHours: typeof row.weekly_hours === 'number' ? (row.weekly_hours as number) : null,
    contractType: row.contract_type as string | null,
    salaryMin: parseNullableNumber(row.salary_min),
    salaryMax: parseNullableNumber(row.salary_max),
    salaryPeriod: row.salary_period as string | null,
    targetRole: row.target_role as string | null,
    experience: row.experience as string | null,
    education: row.education as string | null,
    category: row.category as string | null,
    expirationDate: row.expiration_date as string | null,
    title: row.title as string,
    description: row.description as string | null,
    tags: (row.tags as string[]) ?? [],
    language: ((row.language as JobLanguage | null) ?? 'it'),
    jobType: ((row.job_type as JobType | null) ?? 'fulltime'),
    status: row.status as JobStatus,
    source: row.source as string,
    indeedPostId: row.indeed_post_id as string | null,
    referenceId: (row.reference_id as string | null) ?? null,
    createdById: row.created_by_id as number | null,
    createdByName: (row.created_by_name as string | null) ?? null,
    createdBySurname: (row.created_by_surname as string | null) ?? null,
    createdByRole: (row.created_by_role as string | null) ?? null,
    createdByAvatarFilename: (row.created_by_avatar_filename as string | null) ?? null,
    createdByStoreName: (row.created_by_store_name as string | null) ?? null,
    publishedAt: row.published_at as string | null,
    closedAt: row.closed_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapCandidate(row: Record<string, unknown>): Candidate {
  const rawStatus = typeof row.status === 'string' ? row.status : '';
  const normalizedStatus: CandidateStatus = (
    rawStatus === 'received'
    || rawStatus === 'review'
    || rawStatus === 'phone_interview'
    || rawStatus === 'interview'
    || rawStatus === 'hired'
    || rawStatus === 'rejected'
  ) ? rawStatus : 'received';
  return {
    id: row.id as number,
    companyId: row.company_id as number,
    storeId: row.store_id as number | null,
    jobPostingId: row.job_posting_id as number | null,
    fullName: row.full_name as string,
    email: row.email as string | null,
    phone: row.phone as string | null,
    cvPath: row.cv_path as string | null,
    resumePath: row.resume_path as string | null,
    linkedinUrl: row.linkedin_url as string | null,
    coverLetter: row.cover_letter as string | null,
    tags: (row.tags as string[]) ?? [],
    status: normalizedStatus,
    rejectionReason: row.rejection_reason as string | null,
    source: row.source as string,
    sourceRef: row.source_ref as string | null,
    gdprConsent: (row.gdpr_consent as boolean | null) ?? false,
    unread: row.unread as boolean,
    applicantLocale: row.applicant_locale as string | null,
    consentAcceptedAt: row.consent_accepted_at as string | null,
    appliedAt: row.applied_at as string | null,
    lastStageChange: row.last_stage_change as string,
    indeedApplyId: row.indeed_apply_id as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapFeedJob(row: Record<string, unknown>): FeedJob {
  const base = mapJobPosting(row);
  return {
    ...base,
    companyName: (row.company_name as string | null) ?? 'Company',
    storeName: row.store_name as string | null,
    storeAddress: row.store_address as string | null,
    storePostalCode: row.store_postal_code as string | null,
    storeCity: row.store_city as string | null,
    storeState: row.store_state as string | null,
    storeCountry: row.store_country as string | null,
    companyCity: row.company_city as string | null,
    companyState: row.company_state as string | null,
    companyCountry: row.company_country as string | null,
    companyAddress: row.company_address as string | null,
    companyEmail: row.company_email as string | null,
  };
}

function mapInterview(row: Record<string, unknown>): Interview {
  return {
    id: row.id as number,
    candidateId: row.candidate_id as number,
    interviewerId: row.interviewer_id as number | null,
    storeId: row.store_id as number | null,
    interviewType: (row.interview_type as 'phone' | 'in_person' | 'video') || 'in_person',
    scheduledAt: row.scheduled_at as string,
    location: row.location as string | null,
    description: row.description as string | null,
    notes: row.notes as string | null,
    durationMinutes: row.duration_minutes as number | null,
    icsUid: row.ics_uid as string | null,
    feedback: row.feedback as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    // Extended fields for calendar view - these will be overwritten by listAllInterviews
    candidateName: row.candidate_name as string | undefined,
    candidateSurname: row.candidate_surname as string | undefined,
    candidateAvatarFilename: row.candidate_avatar_filename as string | null | undefined,
    candidateEmail: row.candidate_email as string | null | undefined,
    candidatePhone: row.candidate_phone as string | null | undefined,
    candidateLinkedinUrl: row.candidate_linkedin_url as string | null | undefined,
    resumePath: row.resume_path as string | null | undefined,
    cvPath: row.cv_path as string | null | undefined,
    positionTitle: row.position_title as string | undefined,
    positionId: row.position_id as number | null | undefined,
    positionJobType: row.position_job_type as string | undefined,
    positionWeeklyHours: row.position_weekly_hours as number | undefined,
    positionSalaryMin: row.position_salary_min as number | undefined,
    positionSalaryMax: row.position_salary_max as number | undefined,
    positionLocation: row.position_location as string | undefined,
    companyId: row.company_id as number | undefined,
    companyName: row.company_name as string | undefined,
    companyLogoFilename: row.company_logo_filename as string | null | undefined,
    companyGroupName: row.company_group_name as string | null | undefined,
    storeName: row.store_name as string | null | undefined,
    storeLogoFilename: row.store_logo_filename as string | null | undefined,
    interviewerName: row.interviewer_name as string | undefined,
    interviewerSurname: row.interviewer_surname as string | undefined,
    interviewerAvatarFilename: row.interviewer_avatar_filename as string | null | undefined,
    interviewerRole: row.interviewer_role as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Job Postings
// ---------------------------------------------------------------------------

export async function listJobs(
  companyId: number | number[],
  filters: { status?: string; storeIds?: number[] } = {},
): Promise<JobPosting[]> {
  const companyIds = Array.isArray(companyId) ? companyId : [companyId];
  if (companyIds.length === 0) {
    return [];
  }

  const conditions: string[] = ['j.company_id = ANY($1::int[])'];
  const params: unknown[] = [companyIds];
  let idx = 2;

  if (filters.status) {
    conditions.push(`j.status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters.storeIds?.length) {
    conditions.push(`(j.store_id IS NULL OR j.store_id = ANY($${idx++}::int[]))`);
    params.push(filters.storeIds);
  }

  const rows = await query<Record<string, unknown>>(
      `SELECT j.*,
        c.slug AS company_slug,
            c.name AS company_name,
            c.logo_filename AS company_logo_filename,
            c.country AS company_country,
            cg.name AS company_group_name,
            c_owner.name AS company_owner_name,
            c_owner.surname AS company_owner_surname,
            c_owner.avatar_filename AS company_owner_avatar_filename,
            (SELECT COUNT(*) FROM stores WHERE company_id = c.id AND is_active = true)::int AS company_store_count,
            s.name AS store_name,
            s.logo_filename AS store_logo_filename,
            s.country AS store_country,
            (SELECT u.name FROM users u WHERE u.store_id = s.id AND u.role = 'hr' AND u.status = 'active' ORDER BY u.id LIMIT 1) AS store_hr_name,
            (SELECT u.surname FROM users u WHERE u.store_id = s.id AND u.role = 'hr' AND u.status = 'active' ORDER BY u.id LIMIT 1) AS store_hr_surname,
            (SELECT u.avatar_filename FROM users u WHERE u.store_id = s.id AND u.role = 'hr' AND u.status = 'active' ORDER BY u.id LIMIT 1) AS store_hr_avatar_filename,
            (SELECT u.name FROM users u WHERE u.store_id = s.id AND u.role = 'area_manager' AND u.status = 'active' ORDER BY u.id LIMIT 1) AS store_area_manager_name,
            (SELECT u.surname FROM users u WHERE u.store_id = s.id AND u.role = 'area_manager' AND u.status = 'active' ORDER BY u.id LIMIT 1) AS store_area_manager_surname,
            (SELECT u.avatar_filename FROM users u WHERE u.store_id = s.id AND u.role = 'area_manager' AND u.status = 'active' ORDER BY u.id LIMIT 1) AS store_area_manager_avatar_filename,
            (SELECT u.name FROM users u WHERE u.store_id = s.id AND u.role = 'store_manager' AND u.status = 'active' ORDER BY u.id LIMIT 1) AS store_manager_name,
            (SELECT u.surname FROM users u WHERE u.store_id = s.id AND u.role = 'store_manager' AND u.status = 'active' ORDER BY u.id LIMIT 1) AS store_manager_surname,
            (SELECT u.avatar_filename FROM users u WHERE u.store_id = s.id AND u.role = 'store_manager' AND u.status = 'active' ORDER BY u.id LIMIT 1) AS store_manager_avatar_filename,
            creator.name AS created_by_name,
            creator.surname AS created_by_surname,
            creator.role::text AS created_by_role,
            creator.avatar_filename AS created_by_avatar_filename,
            creator_store.name AS created_by_store_name,
            -- Explicit raw job-location overrides. j.* already returns these, but
            -- selecting them explicitly guarantees the edit form gets the true
            -- per-job value even if this SELECT is ever refactored away from j.*
            -- (the mapper reads row.job_city/etc, NOT the COALESCE'd aliases below).
            j.job_city AS job_city,
            j.job_state AS job_state,
            j.job_country AS job_country,
            j.job_postal_code AS job_postal_code,
            j.job_address AS job_address,
                 COALESCE(j.job_city, c.city) AS city,
                 COALESCE(j.job_state, c.state) AS state,
                 COALESCE(j.job_country, c.country) AS country,
            COALESCE(j.job_postal_code, s.cap) AS postal_code,
            COALESCE(j.job_address, s.address, c.address) AS address,
                 CONCAT_WS(', ', COALESCE(j.job_city, c.city), COALESCE(j.job_state, c.state), COALESCE(j.job_country, c.country)) AS location
     FROM job_postings j
     JOIN companies c ON c.id = j.company_id
     LEFT JOIN company_groups cg ON cg.id = c.group_id
     LEFT JOIN users c_owner ON c_owner.id = c.owner_user_id
     LEFT JOIN stores s ON s.id = j.store_id
     LEFT JOIN users creator ON creator.id = j.created_by_id
     LEFT JOIN stores creator_store ON creator_store.id = creator.store_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY j.created_at DESC`,
    params,
  );
  return rows.map(mapJobPosting);
}

export async function getPublishedJobsForFeed(identifier: string): Promise<{ company: FeedCompany | null; jobs: FeedJob[] }> {
  const normalizedIdentifier = identifier.trim().toLowerCase();

  if (normalizedIdentifier === 'all') {
    const rows = await query<Record<string, unknown>>(
      `SELECT j.*,
              c.name AS company_name,
              c.slug AS company_slug,
              c.company_email AS company_email,
              cg.name AS company_group_name,
              s.name AS store_name,
              s.address AS store_address,
              s.cap AS store_postal_code,
              NULL::text AS store_city,
              NULL::text AS store_state,
              NULL::text AS store_country,
              c.city AS company_city,
              c.state AS company_state,
              c.country AS company_country,
              c.address AS company_address,
              COALESCE(j.job_city, c.city) AS city,
              COALESCE(j.job_state, c.state) AS state,
              COALESCE(j.job_country, c.country) AS country,
              COALESCE(j.job_postal_code, s.cap) AS postal_code,
              COALESCE(j.job_address, s.address, c.address) AS address,
              CONCAT_WS(', ', COALESCE(j.job_city, c.city), COALESCE(j.job_state, c.state), COALESCE(j.job_country, c.country)) AS location
       FROM job_postings j
       JOIN companies c ON c.id = j.company_id
       LEFT JOIN company_groups cg ON cg.id = c.group_id
       LEFT JOIN stores s ON s.id = j.store_id
       WHERE c.is_active = true
         AND j.status = 'published'
         AND (j.expiration_date IS NULL OR j.expiration_date > NOW())
       ORDER BY COALESCE(j.published_at, j.created_at) DESC`,
    );

    return {
      company: {
        id: 1,
        name: 'All Published Jobs',
        slug: 'all',
        city: null,
        state: null,
        country: null,
        address: null,
        companyEmail: 'recruitment@veylohr.com',
      },
      jobs: rows.map(mapFeedJob),
    };
  }

  const numericId = /^\d+$/.test(identifier) ? parseInt(identifier, 10) : null;
  const company = await queryOne<FeedCompany>(
    numericId
      ? `SELECT id, name, slug, city, state, country, address, company_email AS "companyEmail"
         FROM companies
         WHERE id = $1 AND is_active = true
         LIMIT 1`
      : `SELECT id, name, slug, city, state, country, address, company_email AS "companyEmail"
         FROM companies
         WHERE slug = $1 AND is_active = true
         LIMIT 1`,
    [numericId ?? identifier],
  );
  if (!company) return { company: null, jobs: [] };

  const rows = await query<Record<string, unknown>>(
      `SELECT j.*,
        c.name AS company_name,
        c.slug AS company_slug,
        c.company_email AS company_email,
        cg.name AS company_group_name,
            s.name AS store_name,
            s.address AS store_address,
            s.cap AS store_postal_code,
          NULL::text AS store_city,
          NULL::text AS store_state,
          NULL::text AS store_country,
            c.city AS company_city,
            c.state AS company_state,
            c.country AS company_country,
            c.address AS company_address,
          COALESCE(j.job_city, c.city) AS city,
          COALESCE(j.job_state, c.state) AS state,
          COALESCE(j.job_country, c.country) AS country,
            COALESCE(j.job_postal_code, s.cap) AS postal_code,
            COALESCE(j.job_address, s.address, c.address) AS address,
          CONCAT_WS(', ', COALESCE(j.job_city, c.city), COALESCE(j.job_state, c.state), COALESCE(j.job_country, c.country)) AS location
     FROM job_postings j
     JOIN companies c ON c.id = j.company_id
     LEFT JOIN company_groups cg ON cg.id = c.group_id
     LEFT JOIN stores s ON s.id = j.store_id
     WHERE j.company_id = $1 AND j.status = 'published'
       AND (j.expiration_date IS NULL OR j.expiration_date > NOW())
     ORDER BY COALESCE(j.published_at, j.created_at) DESC`,
    [company.id],
  );

  return { company, jobs: rows.map(mapFeedJob) };
}

export async function getJob(id: number, companyId: number): Promise<JobPosting | null> {
  const row = await queryOne<Record<string, unknown>>(
      `SELECT j.*,
        c.slug AS company_slug,
            c.name AS company_name,
            c.logo_filename AS company_logo_filename,
            s.name AS store_name,
            s.logo_filename AS store_logo_filename,
            creator.name AS created_by_name,
            creator.surname AS created_by_surname,
            creator.role::text AS created_by_role,
            creator.avatar_filename AS created_by_avatar_filename,
            creator_store.name AS created_by_store_name,
            -- Explicit raw job-location overrides (see note in listJobs): the edit
            -- form reads these raw values, so guarantee they are always returned.
            j.job_city AS job_city,
            j.job_state AS job_state,
            j.job_country AS job_country,
            j.job_postal_code AS job_postal_code,
            j.job_address AS job_address,
                 COALESCE(j.job_city, c.city) AS city,
                 COALESCE(j.job_state, c.state) AS state,
                 COALESCE(j.job_country, c.country) AS country,
            COALESCE(j.job_postal_code, s.cap) AS postal_code,
            COALESCE(j.job_address, s.address, c.address) AS address,
                 CONCAT_WS(', ', COALESCE(j.job_city, c.city), COALESCE(j.job_state, c.state), COALESCE(j.job_country, c.country)) AS location
     FROM job_postings j
     JOIN companies c ON c.id = j.company_id
     LEFT JOIN stores s ON s.id = j.store_id
     LEFT JOIN users creator ON creator.id = j.created_by_id
     LEFT JOIN stores creator_store ON creator_store.id = creator.store_id
     WHERE j.id = $1 AND j.company_id = $2`,
    [id, companyId],
  );
  return row ? mapJobPosting(row) : null;
}

export async function createJob(
  companyId: number,
  createdById: number,
  data: {
    title: string;
    description?: string;
    tags?: string[];
    status?: JobStatus;
    storeId?: number;
    language?: JobLanguage;
    jobType?: JobType;
    isRemote?: boolean;
    remoteType?: RemoteType;
    jobCity?: string;
    jobState?: string;
    jobCountry?: string;
    jobPostalCode?: string;
    jobAddress?: string;
    department?: string;
    weeklyHours?: number;
    contractType?: string;
    salaryMin?: number;
    salaryMax?: number;
    salaryPeriod?: string;
    targetRole?: string;
  },
): Promise<JobPosting> {
  const company = await queryOne<{ slug: string }>(
    `SELECT slug FROM companies WHERE id = $1 LIMIT 1`,
    [companyId]
  );
  if (!company) {
    throw new Error('Company not found');
  }
  const cleanSlug = company.slug.replace(/[^a-zA-Z]/g, '');
  const prefixRaw = cleanSlug.length >= 2 ? cleanSlug : company.slug;
  const slugPrefix = prefixRaw.slice(0, 2).toUpperCase().padEnd(2, 'X');

  const row = await queryOne<{ id: number }>(
    `INSERT INTO job_postings (
       company_id,
       created_by_id,
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
       reference_id,
       published_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, CASE WHEN $6 = 'published' THEN NOW() ELSE NULL END)
     RETURNING id`,
    [
      companyId,
      createdById,
      data.title,
      data.description ?? null,
      data.tags ?? [],
      data.status ?? 'draft',
      data.storeId ?? null,
      data.language ?? 'it',
      data.jobType ?? 'fulltime',
      data.remoteType === 'remote' || data.remoteType === 'hybrid'
        ? data.remoteType === 'remote'
        : (data.isRemote ?? false),
      data.remoteType ?? (data.isRemote ? 'remote' : 'onsite'),
      data.jobCity ?? null,
      data.jobState ?? null,
      data.jobCountry ?? null,
      data.jobPostalCode ?? null,
      data.jobAddress ?? null,
      data.department ?? null,
      data.weeklyHours ?? null,
      data.contractType ?? null,
      data.salaryMin ?? null,
      data.salaryMax ?? null,
      data.salaryPeriod ?? null,
      data.targetRole ?? null,
      null, // reference_id placeholder, will be set below using primary key id
    ],
  );
  const createdId = row?.id as number | undefined;
  if (!createdId) {
    throw new Error('Failed to create job posting');
  }

  const seqStr = String(createdId).padStart(4, '0');
  const referenceId = `VY-${slugPrefix}-${seqStr}`;
  await query(
    `UPDATE job_postings SET reference_id = $1 WHERE id = $2`,
    [referenceId, createdId]
  );

  const created = await getJob(createdId, companyId);
  if (!created) {
    throw new Error('Failed to load created job posting');
  }
  return created;
}

export async function updateJob(
  id: number,
  companyId: number,
  data: {
    companyId?: number;
    title?: string;
    description?: string;
    tags?: string[];
    status?: JobStatus;
    storeId?: number | null;
    language?: JobLanguage;
    jobType?: JobType;
    isRemote?: boolean;
    remoteType?: RemoteType;
    jobCity?: string | null;
    jobState?: string | null;
    jobCountry?: string | null;
    jobPostalCode?: string | null;
    jobAddress?: string | null;
    department?: string | null;
    weeklyHours?: number | null;
    contractType?: string | null;
    salaryMin?: number | null;
    salaryMax?: number | null;
    salaryPeriod?: string | null;
    targetRole?: string | null;
  },
): Promise<JobPosting | null> {
  const setParts: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (data.companyId !== undefined)   { setParts.push(`company_id = $${idx++}`);   params.push(data.companyId); }
  if (data.title !== undefined)       { setParts.push(`title = $${idx++}`);       params.push(data.title); }
  if (data.description !== undefined) { setParts.push(`description = $${idx++}`); params.push(data.description); }
  if (data.tags !== undefined)        { setParts.push(`tags = $${idx++}`);         params.push(data.tags); }
  if (data.status !== undefined)      {
    setParts.push(`status = $${idx++}`);
    params.push(data.status);
    if (data.status === 'published') {
      setParts.push(`published_at = COALESCE(published_at, NOW())`);
    } else if (data.status === 'closed') {
      setParts.push(`closed_at = COALESCE(closed_at, NOW())`);
    } else if (data.status === 'draft') {
      setParts.push(`closed_at = NULL`);
    }
  }
  if (data.storeId !== undefined)     { setParts.push(`store_id = $${idx++}`);     params.push(data.storeId); }
  if (data.language !== undefined)    { setParts.push(`language = $${idx++}`);     params.push(data.language); }
  if (data.jobType !== undefined)     { setParts.push(`job_type = $${idx++}`);     params.push(data.jobType); }
  if (data.isRemote !== undefined && data.remoteType === undefined) {
    setParts.push(`is_remote = $${idx++}`);
    params.push(data.isRemote);
  }
  if (data.remoteType !== undefined)  {
    setParts.push(`remote_type = $${idx++}`);
    params.push(data.remoteType);
    setParts.push(`is_remote = $${idx++}`);
    params.push(data.remoteType === 'remote');
  }
  if (data.jobCity !== undefined)     { setParts.push(`job_city = $${idx++}`);      params.push(data.jobCity); }
  if (data.jobState !== undefined)    { setParts.push(`job_state = $${idx++}`);     params.push(data.jobState); }
  if (data.jobCountry !== undefined)  { setParts.push(`job_country = $${idx++}`);   params.push(data.jobCountry); }
  if (data.jobPostalCode !== undefined) { setParts.push(`job_postal_code = $${idx++}`); params.push(data.jobPostalCode); }
  if (data.jobAddress !== undefined)  { setParts.push(`job_address = $${idx++}`);   params.push(data.jobAddress); }
  if (data.department !== undefined)  { setParts.push(`department = $${idx++}`);   params.push(data.department); }
  if (data.weeklyHours !== undefined) { setParts.push(`weekly_hours = $${idx++}`); params.push(data.weeklyHours); }
  if (data.contractType !== undefined){ setParts.push(`contract_type = $${idx++}`);params.push(data.contractType); }
  if (data.salaryMin !== undefined)   { setParts.push(`salary_min = $${idx++}`);   params.push(data.salaryMin); }
  if (data.salaryMax !== undefined)   { setParts.push(`salary_max = $${idx++}`);   params.push(data.salaryMax); }
  if (data.salaryPeriod !== undefined){ setParts.push(`salary_period = $${idx++}`);params.push(data.salaryPeriod); }
  if (data.targetRole !== undefined)  { setParts.push(`target_role = $${idx++}`);  params.push(data.targetRole); }

  if (setParts.length === 0) return getJob(id, companyId);

  setParts.push(`updated_at = NOW()`);
  params.push(id, companyId);

  const row = await queryOne<{ id: number }>(
    `UPDATE job_postings
     SET ${setParts.join(', ')}
     WHERE id = $${idx++} AND company_id = $${idx++}
     RETURNING id`,
    params,
  );
  if (!row) return null;

  const responseCompanyId = data.companyId ?? companyId;
  return getJob(row.id, responseCompanyId);
}

export async function deleteJob(id: number, companyId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `DELETE FROM job_postings WHERE id = $1 AND company_id = $2 RETURNING id`,
    [id, companyId],
  );
  return row !== null;
}

export async function publishJobToIndeed(id: number, companyId: number): Promise<JobPosting | null> {
  const job = await getJob(id, companyId);
  if (!job) return null;

  const adapter = getIndeedAdapter();
  const companyRow = await queryOne<{ name: string }>(
    `SELECT name FROM companies WHERE id = $1`,
    [companyId],
  );

  const indeedPostId = await adapter.publishJob({
    title: job.title,
    description: job.description ?? '',
    companyName: companyRow?.name ?? '',
  });

  const row = await queryOne<{ id: number }>(
    `UPDATE job_postings
     SET indeed_post_id = $1, source = 'indeed', status = 'published', published_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND company_id = $3
     RETURNING id`,
    [indeedPostId, id, companyId],
  );
  if (!row) return null;

  return getJob(row.id, companyId);
}

export async function syncIndeedApplications(
  jobId: number,
  companyId: number,
): Promise<{ imported: number; skipped: number }> {
  const job = await getJob(jobId, companyId);
  if (!job?.indeedPostId) return { imported: 0, skipped: 0 };

  const adapter = getIndeedAdapter();
  const applications = await adapter.getApplications(job.indeedPostId);

  let imported = 0;
  let skipped = 0;

  for (const app of applications) {
    const existing = await queryOne<{ id: number }>(
      `SELECT id FROM candidates WHERE company_id = $1 AND source_ref = $2 LIMIT 1`,
      [companyId, app.sourceRef],
    );
    if (existing) { skipped++; continue; }

    await query(
      `INSERT INTO candidates (company_id, job_posting_id, full_name, email, phone, source, source_ref, indeed_apply_id)
       VALUES ($1, $2, $3, $4, $5, 'indeed', $6, $7)`,
      [companyId, jobId, app.fullName, app.email, app.phone ?? null, app.sourceRef, app.sourceRef],
    );
    imported++;
  }

  return { imported, skipped };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export async function listCandidates(
  companyId: number | number[],
  filters: { status?: string; jobPostingId?: number; storeIds?: number[] } = {},
): Promise<Candidate[]> {
  const companyIds = Array.isArray(companyId) ? companyId : [companyId];
  const conditions: string[] = ['c.company_id = ANY($1::int[])', "(c.job_posting_id IS NULL OR jp.status = 'published')"];
  const params: unknown[] = [companyIds];
  let idx = 2;

  if (filters.status) {
    conditions.push(`c.status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters.jobPostingId) {
    conditions.push(`c.job_posting_id = $${idx++}`);
    params.push(filters.jobPostingId);
  }
  if (filters.storeIds?.length) {
    // Store-scoped roles: match assigned store, or company-wide postings (both null) so candidates are not hidden.
    conditions.push(`(
      COALESCE(c.store_id, jp.store_id) = ANY($${idx}::int[])
      OR COALESCE(c.store_id, jp.store_id) IS NULL
    )`);
    params.push(filters.storeIds);
    idx++;
  }

  const rows = await query<Record<string, unknown>>(
    `SELECT c.*
     FROM candidates c
     LEFT JOIN job_postings jp ON jp.id = c.job_posting_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.created_at DESC`,
    params,
  );
  return rows.map(mapCandidate);
}

export async function getCandidate(id: number, companyId: number, storeIds?: number[]): Promise<Candidate | null> {
  const useStoreScope = Array.isArray(storeIds) && storeIds.length > 0;
  const row = await queryOne<Record<string, unknown>>(
    useStoreScope
      ? `SELECT c.*
         FROM candidates c
         LEFT JOIN job_postings jp ON jp.id = c.job_posting_id
         WHERE c.id = $1
           AND c.company_id = $2
           AND (
             COALESCE(c.store_id, jp.store_id) = ANY($3::int[])
             OR COALESCE(c.store_id, jp.store_id) IS NULL
           )`
      : `SELECT * FROM candidates WHERE id = $1 AND company_id = $2`,
    useStoreScope ? [id, companyId, storeIds] : [id, companyId],
  );
  return row ? mapCandidate(row) : null;
}

export async function createCandidate(
  companyId: number,
  data: {
    fullName: string;
    email?: string;
    phone?: string;
    jobPostingId?: number;
    storeId?: number;
    tags?: string[];
    cvPath?: string;
    resumePath?: string;
    linkedinUrl?: string;
    coverLetter?: string;
    source?: string;
    sourceRef?: string;
    gdprConsent?: boolean;
    applicantLocale?: string;
    consentAcceptedAt?: string;
    appliedAt?: string;
    indeedApplyId?: string;
  },
): Promise<Candidate> {
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO candidates (
       company_id,
       full_name,
       email,
       phone,
       cv_path,
       resume_path,
       linkedin_url,
       cover_letter,
       job_posting_id,
       store_id,
       tags,
       source,
       source_ref,
       gdpr_consent,
       applicant_locale,
       consent_accepted_at,
       applied_at,
       indeed_apply_id
     )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING *`,
    [
      companyId,
      data.fullName,
      data.email ?? null,
      data.phone ?? null,
      data.cvPath ?? data.resumePath ?? null,
      data.resumePath ?? null,
      data.linkedinUrl ?? null,
      data.coverLetter ?? null,
      data.jobPostingId ?? null,
      data.storeId ?? null,
      data.tags ?? [],
      data.source ?? 'internal',
      data.sourceRef ?? null,
      data.gdprConsent ?? false,
      data.applicantLocale ?? null,
      data.consentAcceptedAt ?? null,
      data.appliedAt ?? null,
      data.indeedApplyId ?? null,
    ],
  );
  return mapCandidate(row!);
}

export async function updateCandidateStage(
  id: number,
  companyId: number,
  newStatus: CandidateStatus,
  storeIds?: number[],
  rejectionReason?: string
): Promise<{ candidate: Candidate | null; error?: string }> {
  const candidate = await getCandidate(id, companyId, storeIds);
  if (!candidate) return { candidate: null };

  if (candidate.status === newStatus && candidate.rejectionReason === (rejectionReason ?? null)) {
    return { candidate };
  }

  if (candidate.status !== newStatus && !isValidTransition(candidate.status, newStatus)) {
    return {
      candidate: null,
      error: `Transizione di stato non valida: ${candidate.status} → ${newStatus}`,
    };
  }

  let queryStr = `UPDATE candidates SET status = $1, unread = FALSE, last_stage_change = NOW(), updated_at = NOW()`;
  const queryParams: unknown[] = [newStatus, id, companyId];

  if (newStatus === 'rejected' && rejectionReason !== undefined) {
    queryStr = `UPDATE candidates SET status = $1, rejection_reason = $4, unread = FALSE, last_stage_change = NOW(), updated_at = NOW()`;
    queryParams.push(rejectionReason);
  }

  queryStr += ` WHERE id = $2 AND company_id = $3 RETURNING *`;

  const row = await queryOne<Record<string, unknown>>(queryStr, queryParams);
  const updatedCandidate = row ? mapCandidate(row) : null;

  if (updatedCandidate && updatedCandidate.indeedApplyId) {
    setImmediate(async () => {
      await syncCandidateStageToIndeed(updatedCandidate, newStatus);
    });
  }

  return { candidate: updatedCandidate };
}

export async function markCandidateRead(id: number, companyId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `UPDATE candidates SET unread = FALSE, updated_at = NOW()
     WHERE id = $1 AND company_id = $2 AND unread = TRUE
     RETURNING id`,
    [id, companyId],
  );
  return row !== null;
}

export async function deleteCandidate(id: number, companyId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `DELETE FROM candidates WHERE id = $1 AND company_id = $2 RETURNING id`,
    [id, companyId],
  );
  return row !== null;
}

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

export async function listInterviews(candidateId: number, companyId: number, storeIds?: number[]): Promise<Interview[]> {
  const useStoreScope = Array.isArray(storeIds) && storeIds.length > 0;
  const rows = await query<Record<string, unknown>>(
    useStoreScope
      ? `SELECT i.*
         FROM interviews i
         JOIN candidates c ON c.id = i.candidate_id
         LEFT JOIN job_postings jp ON jp.id = c.job_posting_id
         WHERE i.candidate_id = $1
           AND c.company_id = $2
           AND (c.job_posting_id IS NULL OR jp.status = 'published')
           AND COALESCE(c.store_id, jp.store_id) = ANY($3::int[])
         ORDER BY i.scheduled_at ASC`
      : `SELECT i.* FROM interviews i
         JOIN candidates c ON c.id = i.candidate_id
         LEFT JOIN job_postings jp ON jp.id = c.job_posting_id
         WHERE i.candidate_id = $1 AND c.company_id = $2 AND (c.job_posting_id IS NULL OR jp.status = 'published')
         ORDER BY i.scheduled_at ASC`,
    useStoreScope ? [candidateId, companyId, storeIds] : [candidateId, companyId],
  );
  return rows.map(mapInterview);
}

export async function listAllInterviews(
  companyIds: number[],
  filters: {
    dateFrom?: string;
    dateTo?: string;
    positionId?: number;
    candidateId?: number;
    interviewerId?: number;
  },
  storeIds?: number[]
): Promise<Interview[]> {
  const useStoreScope = Array.isArray(storeIds) && storeIds.length > 0;
  
  // Build WHERE conditions
  const conditions: string[] = ['c.company_id = ANY($1::int[])', "(c.job_posting_id IS NULL OR jp.status = 'published')"];
  const params: any[] = [companyIds];
  let paramIndex = 2;

  if (useStoreScope) {
    // Check interview store_id, candidate store_id, or job_posting store_id
    conditions.push(`(
      COALESCE(i.store_id, c.store_id, jp.store_id) = ANY($${paramIndex}::int[])
      OR COALESCE(i.store_id, c.store_id, jp.store_id) IS NULL
    )`);
    params.push(storeIds);
    paramIndex++;
  }

  if (filters.dateFrom) {
    conditions.push(`i.scheduled_at >= $${paramIndex}`);
    params.push(filters.dateFrom);
    paramIndex++;
  }

  if (filters.dateTo) {
    conditions.push(`i.scheduled_at <= $${paramIndex}`);
    params.push(filters.dateTo);
    paramIndex++;
  }

  if (filters.positionId) {
    conditions.push(`c.job_posting_id = $${paramIndex}`);
    params.push(filters.positionId);
    paramIndex++;
  }

  if (filters.candidateId) {
    conditions.push(`i.candidate_id = $${paramIndex}`);
    params.push(filters.candidateId);
    paramIndex++;
  }

  if (filters.interviewerId) {
    conditions.push(`i.interviewer_id = $${paramIndex}`);
    params.push(filters.interviewerId);
    paramIndex++;
  }

  const whereClause = conditions.join(' AND ');

  const sql = `
    SELECT 
      i.*,
      c.full_name as candidate_full_name,
      c.email as candidate_email,
      c.phone as candidate_phone,
      c.linkedin_url as candidate_linkedin_url,
      c.resume_path as candidate_resume_path,
      jp.id as position_id,
      jp.title as position_title,
      jp.job_type as position_job_type,
      jp.weekly_hours as position_weekly_hours,
      jp.salary_min as position_salary_min,
      jp.salary_max as position_salary_max,
      COALESCE(
        NULLIF(TRIM(CONCAT_WS(', ', jp.job_city, jp.job_state, jp.job_country)), ''),
        NULL
      ) as position_location,
      jp.company_id as company_id,
      co.name as company_name,
      co.logo_filename as company_logo_filename,
      cg.name as company_group_name,
      jp.store_id as store_id,
      s.name as store_name,
      s.logo_filename as store_logo_filename,
      u.name as interviewer_name,
      u.surname as interviewer_surname,
      u.avatar_filename as interviewer_avatar_filename,
      u.role as interviewer_role
    FROM interviews i
    JOIN candidates c ON c.id = i.candidate_id
    LEFT JOIN job_postings jp ON jp.id = c.job_posting_id
    LEFT JOIN companies co ON co.id = jp.company_id
    LEFT JOIN company_groups cg ON cg.id = co.group_id
    LEFT JOIN stores s ON s.id = jp.store_id
    LEFT JOIN users u ON u.id = i.interviewer_id
    WHERE ${whereClause}
    ORDER BY i.scheduled_at ASC
  `;

  const rows = await query<Record<string, unknown>>(sql, params);
  
  // Map rows and split full_name into name and surname
  return rows.map((row) => {
    const fullName = row.candidate_full_name as string || '';
    const nameParts = fullName.trim().split(/\s+/);
    const candidateName = nameParts[0] || '';
    const candidateSurname = nameParts.slice(1).join(' ') || '';
    
    return {
      ...mapInterview(row),
      candidateName,
      candidateSurname,
      candidateAvatarFilename: null, // Candidates don't have avatars in this system
      candidateEmail: row.candidate_email as string | null,
      candidatePhone: row.candidate_phone as string | null,
      candidateLinkedinUrl: row.candidate_linkedin_url as string | null,
      resumePath: row.candidate_resume_path as string | null,
      cvPath: row.candidate_resume_path as string | null, // Use resume_path as cv_path
      positionId: row.position_id as number | null,
      positionTitle: row.position_title as string | undefined,
      positionJobType: row.position_job_type as string | undefined,
      positionWeeklyHours: row.position_weekly_hours as number | undefined,
      positionSalaryMin: row.position_salary_min as number | undefined,
      positionSalaryMax: row.position_salary_max as number | undefined,
      positionLocation: row.position_location as string | undefined,
      companyId: row.company_id as number | undefined,
      companyName: row.company_name as string | undefined,
      companyLogoFilename: row.company_logo_filename as string | null | undefined,
      companyGroupName: row.company_group_name as string | null | undefined,
      storeName: row.store_name as string | null | undefined,
      storeLogoFilename: row.store_logo_filename as string | null | undefined,
      interviewerName: row.interviewer_name as string | undefined,
      interviewerSurname: row.interviewer_surname as string | undefined,
      interviewerAvatarFilename: row.interviewer_avatar_filename as string | null | undefined,
      interviewerRole: row.interviewer_role as string | undefined,
    };
  });
}

export async function getInterview(id: number, companyId: number, storeIds?: number[]): Promise<Interview | null> {
  const useStoreScope = Array.isArray(storeIds) && storeIds.length > 0;
  const row = await queryOne<Record<string, unknown>>(
    useStoreScope
      ? `SELECT i.*
         FROM interviews i
         JOIN candidates c ON c.id = i.candidate_id
         LEFT JOIN job_postings jp ON jp.id = c.job_posting_id
         WHERE i.id = $1
           AND c.company_id = $2
           AND COALESCE(c.store_id, jp.store_id) = ANY($3::int[])`
      : `SELECT i.* FROM interviews i
         JOIN candidates c ON c.id = i.candidate_id
         WHERE i.id = $1 AND c.company_id = $2`,
    useStoreScope ? [id, companyId, storeIds] : [id, companyId],
  );
  return row ? mapInterview(row) : null;
}

export async function createInterview(
  candidateId: number,
  companyId: number,
  data: {
    interviewerId?: number;
    interviewType?: 'phone' | 'in_person' | 'video';
    scheduledAt: string;
    location?: string;
    description?: string;
    notes?: string;
    durationMinutes?: number;
    icsUid?: string;
  },
  storeIds?: number[],
): Promise<Interview | null> {
  const candidate = await getCandidate(candidateId, companyId, storeIds);
  if (!candidate) return null;

  const fallbackStoreId = Array.isArray(storeIds) && storeIds.length > 0 ? storeIds[0] : null;
  const effectiveStoreId = candidate.storeId ?? fallbackStoreId;

  if (candidate.storeId == null && effectiveStoreId != null) {
    await query(`UPDATE candidates SET store_id = $1 WHERE id = $2 AND store_id IS NULL`, [effectiveStoreId, candidateId]);
  }

  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO interviews (
       candidate_id, company_id, store_id, interviewer_id,
       interview_type, scheduled_at, location, description, notes, duration_minutes, ics_uid
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      candidateId,
      companyId,
      effectiveStoreId,
      data.interviewerId ?? null,
      data.interviewType || 'in_person',
      data.scheduledAt,
      data.location ?? null,
      data.description ?? null,
      data.notes ?? null,
      data.durationMinutes ?? null,
      data.icsUid ?? null,
    ],
  );
  if (row) {
    await markCandidateRead(candidateId, companyId);
  }
  return row ? mapInterview(row) : null;
}

export async function updateInterview(
  id: number,
  companyId: number,
  data: {
    scheduledAt?: string;
    interviewType?: 'phone' | 'in_person' | 'video';
    location?: string;
    description?: string;
    notes?: string;
    durationMinutes?: number;
    feedback?: string;
    interviewerId?: number | null;
  },
  storeIds?: number[],
): Promise<Interview | null> {
  const setParts: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (data.scheduledAt !== undefined)    { setParts.push(`scheduled_at = $${idx++}`);     params.push(data.scheduledAt); }
  if (data.interviewType !== undefined)  { setParts.push(`interview_type = $${idx++}`);   params.push(data.interviewType); }
  if (data.location !== undefined)       { setParts.push(`location = $${idx++}`);         params.push(data.location); }
  if (data.description !== undefined)    { setParts.push(`description = $${idx++}`);      params.push(data.description); }
  if (data.notes !== undefined)          { setParts.push(`notes = $${idx++}`);            params.push(data.notes); }
  if (data.durationMinutes !== undefined){ setParts.push(`duration_minutes = $${idx++}`); params.push(data.durationMinutes); }
  if (data.feedback !== undefined)       { setParts.push(`feedback = $${idx++}`);         params.push(data.feedback); }
  if (data.interviewerId !== undefined)  { setParts.push(`interviewer_id = $${idx++}`);   params.push(data.interviewerId); }

  if (setParts.length === 0) return getInterview(id, companyId, storeIds);

  setParts.push(`updated_at = NOW()`);
  const useStoreScope = Array.isArray(storeIds) && storeIds.length > 0;
  params.push(id, companyId);
  if (useStoreScope) {
    params.push(storeIds);
  }

  const row = await queryOne<Record<string, unknown>>(
    `UPDATE interviews
     SET ${setParts.join(', ')}
     WHERE id = $${idx++}
       AND candidate_id IN (
         SELECT c.id
         FROM candidates c
         LEFT JOIN job_postings jp ON jp.id = c.job_posting_id
         WHERE c.company_id = $${idx++}
         ${useStoreScope ? `AND COALESCE(c.store_id, jp.store_id) = ANY($${idx++}::int[])` : ''}
       )
     RETURNING *`,
    params,
  );
  return row ? mapInterview(row) : null;
}

export async function deleteInterview(id: number, companyId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `DELETE FROM interviews
     WHERE id = $1
       AND candidate_id IN (SELECT id FROM candidates WHERE company_id = $2)
     RETURNING id`,
    [id, companyId],
  );
  return row !== null;
}

// ---------------------------------------------------------------------------
// Candidate Comments
// ---------------------------------------------------------------------------

export interface CandidateComment {
  id: number;
  candidateId: number;
  userId: number;
  userFullName: string;
  userAvatarFilename: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export async function listCandidateComments(candidateId: number, companyId: number, storeIds?: number[]): Promise<CandidateComment[]> {
  const candidate = await getCandidate(candidateId, companyId, storeIds);
  if (!candidate) return [];

  const rows = await query<Record<string, unknown>>(
    `SELECT cc.*, u.name as user_name, u.surname as user_surname, u.avatar_filename as user_avatar_filename
     FROM candidate_comments cc
     JOIN users u ON cc.user_id = u.id
     WHERE cc.candidate_id = $1
     ORDER BY cc.created_at ASC`,
    [candidateId],
  );

  return rows.map(r => ({
    id: r.id as number,
    candidateId: r.candidate_id as number,
    userId: r.user_id as number,
    userFullName: `${r.user_name} ${r.user_surname}`,
    userAvatarFilename: r.user_avatar_filename as string | null,
    body: r.body as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

export async function addCandidateComment(
  candidateId: number,
  userId: number,
  companyId: number,
  body: string,
  storeIds?: number[]
): Promise<CandidateComment | null> {
  const candidate = await getCandidate(candidateId, companyId, storeIds);
  if (!candidate) return null;

  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO candidate_comments (candidate_id, user_id, body)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [candidateId, userId, body]
  );
  if (!row) return null;

  const newComment = await queryOne<Record<string, unknown>>(
    `SELECT cc.*, u.name as user_name, u.surname as user_surname, u.avatar_filename as user_avatar_filename
     FROM candidate_comments cc
     JOIN users u ON cc.user_id = u.id
     WHERE cc.id = $1`,
    [row.id]
  );

  return newComment ? {
    id: newComment.id as number,
    candidateId: newComment.candidate_id as number,
    userId: newComment.user_id as number,
    userFullName: `${newComment.user_name} ${newComment.user_surname}`,
    userAvatarFilename: newComment.user_avatar_filename as string | null,
    body: newComment.body as string,
    createdAt: newComment.created_at as string,
    updatedAt: newComment.updated_at as string,
  } : null;
}

export async function deleteCandidateComment(
  commentId: number,
  companyId: number,
  storeIds?: number[]
): Promise<boolean> {
  const useStoreScope = Array.isArray(storeIds) && storeIds.length > 0;
  
  // Verify ownership/visibility first
  const valid = await queryOne<{ id: number }>(
    `SELECT cc.id FROM candidate_comments cc
     JOIN candidates c ON c.id = cc.candidate_id
     LEFT JOIN job_postings jp ON jp.id = c.job_posting_id
     WHERE cc.id = $1 AND c.company_id = $2
     ${useStoreScope ? 'AND COALESCE(c.store_id, jp.store_id) = ANY($3::int[])' : ''}`,
     useStoreScope ? [commentId, companyId, storeIds] : [commentId, companyId]
  );
  
  if (!valid) return false;

  const row = await queryOne<{ id: number }>(
    `DELETE FROM candidate_comments WHERE id = $1 RETURNING id`,
    [commentId]
  );
  return row !== null;
}

// ---------------------------------------------------------------------------
// Interview Feedback Comments
// ---------------------------------------------------------------------------

export interface InterviewFeedbackComment {
  id: number;
  interviewId: number;
  authorId: number;
  authorName: string | null;
  authorSurname: string | null;
  authorAvatarFilename: string | null;
  authorRole: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export async function listInterviewFeedbackComments(
  interviewId: number,
  companyId: number,
  storeIds?: number[],
): Promise<InterviewFeedbackComment[]> {
  const interview = await getInterview(interviewId, companyId, storeIds);
  if (!interview) return [];

  const rows = await query<Record<string, unknown>>(
    `SELECT ifc.*, u.name as author_name, u.surname as author_surname,
            u.avatar_filename as author_avatar_filename, u.role as author_role
     FROM interview_feedback_comments ifc
     JOIN users u ON ifc.user_id = u.id
     WHERE ifc.interview_id = $1
     ORDER BY ifc.created_at ASC`,
    [interviewId],
  );

  return rows.map((r) => ({
    id: r.id as number,
    interviewId: r.interview_id as number,
    authorId: r.user_id as number,
    authorName: (r.author_name as string | null) ?? null,
    authorSurname: (r.author_surname as string | null) ?? null,
    authorAvatarFilename: (r.author_avatar_filename as string | null) ?? null,
    authorRole: (r.author_role as string | null) ?? null,
    body: r.body as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

export async function addInterviewFeedbackComment(
  interviewId: number,
  userId: number,
  companyId: number,
  body: string,
  storeIds?: number[],
): Promise<InterviewFeedbackComment | null> {
  const interview = await getInterview(interviewId, companyId, storeIds);
  if (!interview) return null;

  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO interview_feedback_comments (interview_id, user_id, body)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [interviewId, userId, body],
  );
  if (!row) return null;

  const newComment = await queryOne<Record<string, unknown>>(
    `SELECT ifc.*, u.name as author_name, u.surname as author_surname,
            u.avatar_filename as author_avatar_filename, u.role as author_role
     FROM interview_feedback_comments ifc
     JOIN users u ON ifc.user_id = u.id
     WHERE ifc.id = $1`,
    [row.id],
  );

  return newComment ? {
    id: newComment.id as number,
    interviewId: newComment.interview_id as number,
    authorId: newComment.user_id as number,
    authorName: (newComment.author_name as string | null) ?? null,
    authorSurname: (newComment.author_surname as string | null) ?? null,
    authorAvatarFilename: (newComment.author_avatar_filename as string | null) ?? null,
    authorRole: (newComment.author_role as string | null) ?? null,
    body: newComment.body as string,
    createdAt: newComment.created_at as string,
    updatedAt: newComment.updated_at as string,
  } : null;
}

export async function deleteInterviewFeedbackComment(
  commentId: number,
  companyId: number,
  storeIds?: number[],
): Promise<boolean> {
  const useStoreScope = Array.isArray(storeIds) && storeIds.length > 0;
  const valid = await queryOne<{ id: number }>(
    `SELECT ifc.id
     FROM interview_feedback_comments ifc
     JOIN interviews i ON i.id = ifc.interview_id
     JOIN candidates c ON c.id = i.candidate_id
     LEFT JOIN job_postings jp ON jp.id = c.job_posting_id
     WHERE ifc.id = $1 AND c.company_id = $2
     ${useStoreScope ? 'AND COALESCE(c.store_id, jp.store_id) = ANY($3::int[])' : ''}`,
    useStoreScope ? [commentId, companyId, storeIds] : [commentId, companyId],
  );
  if (!valid) return false;

  const row = await queryOne<{ id: number }>(
    `DELETE FROM interview_feedback_comments WHERE id = $1 RETURNING id`,
    [commentId],
  );
  return row !== null;
}

// ---------------------------------------------------------------------------
// Interview Notification Logs
// ---------------------------------------------------------------------------

export interface InterviewNotificationLog {
  id: number;
  interviewId: number;
  channel: 'email' | 'push' | 'in_app';
  recipientType: 'candidate' | 'interviewer';
  recipientEmail: string | null;
  status: 'pending' | 'sending' | 'done' | 'error';
  errorMessage: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listInterviewNotificationLogs(
  interviewId: number,
  companyId: number,
  storeIds?: number[]
): Promise<InterviewNotificationLog[]> {
  const interview = await getInterview(interviewId, companyId, storeIds);
  if (!interview) return [];

  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM interview_notification_logs
     WHERE interview_id = $1
     ORDER BY created_at DESC`,
    [interviewId],
  );

  return rows.map(r => ({
    id: r.id as number,
    interviewId: r.interview_id as number,
    channel: r.channel as 'email' | 'push' | 'in_app',
    recipientType: r.recipient_type as 'candidate' | 'interviewer',
    recipientEmail: r.recipient_email as string | null,
    status: r.status as 'pending' | 'sending' | 'done' | 'error',
    errorMessage: r.error_message as string | null,
    attempts: r.attempts as number,
    lastAttemptAt: r.last_attempt_at as string | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

export async function createInterviewNotificationLog(
  interviewId: number,
  channel: 'email' | 'push' | 'in_app',
  recipientType: 'candidate' | 'interviewer',
  recipientEmail?: string
): Promise<InterviewNotificationLog | null> {
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO interview_notification_logs (interview_id, channel, recipient_type, recipient_email)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [interviewId, channel, recipientType, recipientEmail ?? null]
  );
  if (!row) return null;
  return {
    id: row.id as number,
    interviewId: row.interview_id as number,
    channel: row.channel as 'email' | 'push' | 'in_app',
    recipientType: row.recipient_type as 'candidate' | 'interviewer',
    recipientEmail: row.recipient_email as string | null,
    status: row.status as 'pending' | 'sending' | 'done' | 'error',
    errorMessage: row.error_message as string | null,
    attempts: row.attempts as number,
    lastAttemptAt: row.last_attempt_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function updateInterviewNotificationLog(
  id: number,
  status: 'pending' | 'sending' | 'done' | 'error',
  errorMessage?: string | null
): Promise<void> {
  await query(
    `UPDATE interview_notification_logs
     SET status = $2,
         error_message = $3,
         attempts = attempts + 1,
         last_attempt_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [id, status, errorMessage ?? null]
  );
}

export interface AllInterviewFeedbackComment {
  id: number;
  interviewId: number;
  candidateId: number;
  candidateName: string;
  positionTitle: string | null;
  authorId: number;
  authorName: string | null;
  authorSurname: string | null;
  authorAvatarFilename: string | null;
  authorRole: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export async function listAllInterviewFeedbackComments(
  companyIds: number[],
  storeIds?: number[],
): Promise<AllInterviewFeedbackComment[]> {
  const useStoreScope = Array.isArray(storeIds) && storeIds.length > 0;
  
  const conditions: string[] = ['c.company_id = ANY($1::int[])', "(c.job_posting_id IS NULL OR jp.status = 'published')"];
  const params: any[] = [companyIds];
  let paramIndex = 2;

  if (useStoreScope) {
    conditions.push(`COALESCE(i.store_id, c.store_id, jp.store_id) = ANY($${paramIndex}::int[])`);
    params.push(storeIds);
    paramIndex++;
  }

  const sql = `
    SELECT ifc.*, 
           u.name as author_name, u.surname as author_surname,
           u.avatar_filename as author_avatar_filename, u.role as author_role,
           c.id as candidate_id, c.full_name as candidate_name,
           jp.title as position_title
    FROM interview_feedback_comments ifc
    JOIN interviews i ON i.id = ifc.interview_id
    JOIN candidates c ON c.id = i.candidate_id
    LEFT JOIN job_postings jp ON jp.id = c.job_posting_id
    JOIN users u ON ifc.user_id = u.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ifc.created_at DESC
  `;

  const rows = await query<Record<string, unknown>>(sql, params);

  return rows.map((r) => ({
    id: r.id as number,
    interviewId: r.interview_id as number,
    candidateId: r.candidate_id as number,
    candidateName: r.candidate_name as string || '',
    positionTitle: (r.position_title as string | null) ?? null,
    authorId: r.user_id as number,
    authorName: (r.author_name as string | null) ?? null,
    authorSurname: (r.author_surname as string | null) ?? null,
    authorAvatarFilename: (r.author_avatar_filename as string | null) ?? null,
    authorRole: (r.author_role as string | null) ?? null,
    body: r.body as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

export interface IndeedStats {
  companiesOnFeed: number;
  livePositions: number;
  indeedCandidatesThisMonth: number;
  totalIndeedCandidates: number;
  totalDirectCandidates: number;
  monthlyTrend: Array<{
    month: string;
    indeedCandidates: number;
    directCandidates: number;
    newPositionsPublished: number;
  }>;
}

export async function getIndeedStats(companyId: number | null): Promise<IndeedStats> {
  // Query 1: companiesOnFeed
  const companiesOnFeedQuery = companyId
    ? `SELECT COUNT(DISTINCT company_id)::int AS count FROM job_postings WHERE status = 'published' AND company_id = $1`
    : `SELECT COUNT(DISTINCT company_id)::int AS count FROM job_postings WHERE status = 'published'`;
  const companiesOnFeedParams = companyId ? [companyId] : [];
  const companiesOnFeedRow = await queryOne<{ count: number }>(companiesOnFeedQuery, companiesOnFeedParams);
  const companiesOnFeed = companiesOnFeedRow?.count ?? 0;

  // Query 2: livePositions
  const livePositionsQuery = companyId
    ? `SELECT COUNT(*)::int AS count FROM job_postings WHERE status = 'published' AND company_id = $1`
    : `SELECT COUNT(*)::int AS count FROM job_postings WHERE status = 'published'`;
  const livePositionsParams = companyId ? [companyId] : [];
  const livePositionsRow = await queryOne<{ count: number }>(livePositionsQuery, livePositionsParams);
  const livePositions = livePositionsRow?.count ?? 0;

  // Query 3: indeedCandidatesThisMonth
  const indeedCandidatesThisMonthQuery = companyId
    ? `SELECT COUNT(c.*)::int AS count FROM candidates c JOIN job_postings jp ON jp.id = c.job_posting_id WHERE c.source = 'indeed' AND c.created_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP) AND jp.status = 'published' AND c.company_id = $1`
    : `SELECT COUNT(c.*)::int AS count FROM candidates c JOIN job_postings jp ON jp.id = c.job_posting_id WHERE c.source = 'indeed' AND c.created_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP) AND jp.status = 'published'`;
  const indeedCandidatesThisMonthParams = companyId ? [companyId] : [];
  const indeedCandidatesThisMonthRow = await queryOne<{ count: number }>(indeedCandidatesThisMonthQuery, indeedCandidatesThisMonthParams);
  const indeedCandidatesThisMonth = indeedCandidatesThisMonthRow?.count ?? 0;

  // Query 4: totalIndeedCandidates
  const totalIndeedCandidatesQuery = companyId
    ? `SELECT COUNT(c.*)::int AS count FROM candidates c JOIN job_postings jp ON jp.id = c.job_posting_id WHERE c.source = 'indeed' AND jp.status = 'published' AND c.company_id = $1`
    : `SELECT COUNT(c.*)::int AS count FROM candidates c JOIN job_postings jp ON jp.id = c.job_posting_id WHERE c.source = 'indeed' AND jp.status = 'published'`;
  const totalIndeedCandidatesParams = companyId ? [companyId] : [];
  const totalIndeedCandidatesRow = await queryOne<{ count: number }>(totalIndeedCandidatesQuery, totalIndeedCandidatesParams);
  const totalIndeedCandidates = totalIndeedCandidatesRow?.count ?? 0;

  // Query 5: totalDirectCandidates
  const totalDirectCandidatesQuery = companyId
    ? `SELECT COUNT(c.*)::int AS count FROM candidates c JOIN job_postings jp ON jp.id = c.job_posting_id WHERE c.source != 'indeed' AND jp.status = 'published' AND c.company_id = $1`
    : `SELECT COUNT(c.*)::int AS count FROM candidates c JOIN job_postings jp ON jp.id = c.job_posting_id WHERE c.source != 'indeed' AND jp.status = 'published'`;
  const totalDirectCandidatesParams = companyId ? [companyId] : [];
  const totalDirectCandidatesRow = await queryOne<{ count: number }>(totalDirectCandidatesQuery, totalDirectCandidatesParams);
  const totalDirectCandidates = totalDirectCandidatesRow?.count ?? 0;

  // Query 6: monthlyTrend (last 6 calendar months)
  const trendQuery = `
    WITH months AS (
      SELECT DATE_TRUNC('month', m) as m_start,
             DATE_TRUNC('month', m) + INTERVAL '1 month' as m_end
      FROM GENERATE_SERIES(
        DATE_TRUNC('month', CURRENT_TIMESTAMP) - INTERVAL '5 months',
        DATE_TRUNC('month', CURRENT_TIMESTAMP),
        INTERVAL '1 month'
      ) m
    )
    SELECT 
      months.m_start as month_start,
      COALESCE(c_indeed.count, 0)::int as indeed_candidates,
      COALESCE(c_direct.count, 0)::int as direct_candidates,
      COALESCE(j_pub.count, 0)::int as new_positions_published
    FROM months
    LEFT JOIN LATERAL (
      SELECT COUNT(c.*)::int as count
      FROM candidates c
      JOIN job_postings jp ON jp.id = c.job_posting_id
      WHERE c.source = 'indeed'
        AND c.created_at >= months.m_start
        AND c.created_at < months.m_end
        AND jp.status = 'published'
        AND ($1::int IS NULL OR c.company_id = $1)
    ) c_indeed ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(c.*)::int as count
      FROM candidates c
      JOIN job_postings jp ON jp.id = c.job_posting_id
      WHERE c.source != 'indeed'
        AND c.created_at >= months.m_start
        AND c.created_at < months.m_end
        AND jp.status = 'published'
        AND ($1::int IS NULL OR c.company_id = $1)
    ) c_direct ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int as count
      FROM job_postings
      WHERE status = 'published'
        AND published_at >= months.m_start
        AND published_at < months.m_end
        AND ($1::int IS NULL OR company_id = $1)
    ) j_pub ON TRUE
    ORDER BY months.m_start DESC
  `;

  const trendRows = await query<Record<string, unknown>>(trendQuery, [companyId]);

  const monthsList = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  const monthlyTrend = trendRows.map(row => {
    const d = new Date(row.month_start as string | Date);
    const monthName = monthsList[d.getMonth()];
    const year = d.getFullYear();
    return {
      month: `${monthName} ${year}`,
      indeedCandidates: row.indeed_candidates as number,
      directCandidates: row.direct_candidates as number,
      newPositionsPublished: row.new_positions_published as number
    };
  });

  return {
    companiesOnFeed,
    livePositions,
    indeedCandidatesThisMonth,
    totalIndeedCandidates,
    totalDirectCandidates,
    monthlyTrend
  };
}

async function syncCandidateStageToIndeed(candidate: Candidate, newStatus: CandidateStatus): Promise<void> {
  const indeedApplyId = candidate.indeedApplyId;
  if (!indeedApplyId) return;

  try {
    const company = await queryOne<{ slug: string }>('SELECT slug FROM companies WHERE id = $1', [candidate.companyId]);
    const companySlug = company?.slug || 'all';
    const companyUpper = companySlug.replace(/-/g, '_').toUpperCase();
    const companySlugShort = companySlug.split('-')[0].toUpperCase();
    const apiToken = process.env[`INDEED_APPLY_API_TOKEN_${companyUpper}`] ||
                     process.env[`INDEED_APPLY_API_TOKEN_${companySlugShort}`] ||
                     process.env.INDEED_APPLY_API_TOKEN;

    if (!apiToken || apiToken === 'mock_veylohr_indeed_token_2026') {
      console.log(`[Indeed Disposition] Skip sync for candidate ${candidate.id} — missing or mock credentials`);
      return;
    }

    // Map stages
    const stageMapping: Record<CandidateStatus, string> = {
      received: 'NEW',
      review: 'REVIEW',
      phone_interview: 'SCREEN',
      interview: 'INTERVIEW',
      hired: 'HIRED',
      rejected: 'NOT_SELECTED'
    };

    const mappedStatus = stageMapping[newStatus] || 'NEW';
    const atsName = process.env.ATS_NAME || 'VeyloHR';

    const maxRetries = 3;
    let attempt = 0;
    let success = false;
    let lastError = '';

    while (attempt < maxRetries && !success) {
      attempt++;
      try {
        const response = await fetch('https://apis.indeed.com/graphql', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiToken}`
          },
          body: JSON.stringify({
            query: `
              mutation Send($input: SendPartnerDispositionInput!) {
                partnerDisposition {
                  send(input: $input) {
                    numberGoodDispositions
                    failedDispositions {
                      identifiedBy {
                        indeedApplyID
                      }
                      rationale
                    }
                  }
                }
              }
            `,
            variables: {
              input: {
                dispositions: [
                  {
                    identifiedBy: {
                      indeedApplyID: indeedApplyId
                    },
                    dispositionStatus: mappedStatus,
                    rawDispositionStatus: newStatus,
                    atsName: atsName,
                    statusChangeDateTime: new Date().toISOString()
                  }
                ]
              }
            }
          })
        });

        if (response.ok) {
          const resJson = await response.json() as any;
          const sendResult = resJson?.data?.partnerDisposition?.send;
          const failed = sendResult?.failedDispositions || [];
          if (failed.length > 0) {
            lastError = `Indeed rejected: ${failed.map((f: any) => f.rationale).join(', ')}`;
            // If Indeed explicitly rejected the payload, retrying won't help (logical error), so break
            break;
          } else {
            success = true;
          }
        } else {
          lastError = `HTTP Status ${response.status}: ${response.statusText}`;
          // Retry only on network/5xx errors
          if (response.status < 500) {
            break;
          }
        }
      } catch (err: any) {
        lastError = err.message || 'Unknown network error';
      }

      if (!success && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Write attempt log to database
    await query(
      `INSERT INTO indeed_disposition_sync_logs 
       (candidate_id, indeed_apply_id, status_sent, raw_status_sent, success, error_message, attempt_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        candidate.id,
        indeedApplyId,
        mappedStatus,
        newStatus,
        success,
        success ? null : lastError,
        attempt
      ]
    );

    if (success) {
      console.log(`[Indeed Disposition] Successfully synced candidate ${candidate.id} to stage ${mappedStatus} (Indeed ID: ${indeedApplyId})`);
    } else {
      console.error(`[Indeed Disposition] Failed to sync candidate ${candidate.id} to stage ${mappedStatus}: ${lastError}`);
    }

  } catch (outerErr: any) {
    console.error(`[Indeed Disposition] Outer handler crash for candidate ${candidate.id}:`, outerErr.message);
  }
}

