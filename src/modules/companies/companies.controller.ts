import { Request, Response } from 'express';
import { pool, query, queryOne } from '../../config/database';
import { ok, created, notFound, badRequest } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { resolveAllowedCompanyIds, resolveCompanyGroupId } from '../../utils/companyScope';
import { normalizePartitaIva, normalizeSdiCode, normalizePecEmail } from '../../utils/italianFiscal';
import { syncSubscriptionPricing } from '../billing/subscription.service';

interface CompanyRow {
  id: number;
  name: string;
  slug: string;
  is_active: boolean;
  logo_filename: string | null;
  banner_filename: string | null;
  group_id: number | null;
  group_name: string | null;
  owner_user_id: number | null;
  owner_name: string | null;
  owner_surname: string | null;
  owner_avatar_filename: string | null;
  registration_number: string | null;
  vat_number: string | null;
  sdi_recipient_code: string | null;
  pec_email: string | null;
  company_email: string | null;
  company_phone_numbers: string | null;
  offices_locations: string | null;
  country: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
  currency: string | null;
  price_per_employee: number | null;
  price_per_device: number | null;
  extra_storage_price_per_gb: number | null;
  storage_limit_gb: number | null;
  access_valid_from: string | null;
  access_valid_to: string | null;
  discount_percent: number | null;
  discount_valid_from: string | null;
  discount_valid_to: string | null;
  store_count: number;
  employee_count: number;
  created_at: string;
}

type CompanyProfileInput = {
  registration_number?: string | null;
  vat_number?: string | null;
  sdi_recipient_code?: string | null;
  pec_email?: string | null;
  company_email?: string | null;
  company_phone_numbers?: string | null;
  offices_locations?: string | null;
  country?: string | null;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  currency?: string | null;
  price_per_employee?: number | null;
  price_per_device?: number | null;
  extra_storage_price_per_gb?: number | null;
  storage_limit_gb?: number | null;
  access_valid_from?: string | null;
  access_valid_to?: string | null;
  discount_percent?: number | null;
  discount_valid_from?: string | null;
  discount_valid_to?: string | null;
  bill_reminder_days_before?: number | null;
  grace_period_days?: number | null;
  billing_enforced?: boolean | string | null;
};

function normalizeOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

// Stores the e-invoicing fields in a canonical shape (IT prefix stripped, SDI
// upper-cased, PEC lower-cased) so lookups and comparisons stay predictable.
// An absent or blank value stays absent/null — these fields remain optional.
function normalizeFiscalString(
  value: unknown,
  canonicalize: (raw: string) => string,
): string | null | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined || normalized === null) return normalized;
  return canonicalize(normalized);
}

function normalizeOptionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const num = Number(value);
  return isNaN(num) ? null : num;
}

function extractCompanyProfileInput(payload: Record<string, unknown>): CompanyProfileInput {
  return {
    registration_number: normalizeOptionalString(payload.registration_number),
    vat_number: normalizeFiscalString(payload.vat_number, normalizePartitaIva),
    sdi_recipient_code: normalizeFiscalString(payload.sdi_recipient_code, normalizeSdiCode),
    pec_email: normalizeFiscalString(payload.pec_email, normalizePecEmail),
    company_email: normalizeOptionalString(payload.company_email),
    company_phone_numbers: normalizeOptionalString(payload.company_phone_numbers),
    offices_locations: normalizeOptionalString(payload.offices_locations),
    country: normalizeOptionalString(payload.country),
    city: normalizeOptionalString(payload.city),
    state: normalizeOptionalString(payload.state),
    address: normalizeOptionalString(payload.address),
    currency: normalizeOptionalString(payload.currency),
    price_per_employee: normalizeOptionalNumber(payload.price_per_employee),
    price_per_device: normalizeOptionalNumber(payload.price_per_device),
    extra_storage_price_per_gb: normalizeOptionalNumber(payload.extra_storage_price_per_gb),
    storage_limit_gb: normalizeOptionalNumber(payload.storage_limit_gb),
    access_valid_from: normalizeOptionalString(payload.access_valid_from),
    access_valid_to: normalizeOptionalString(payload.access_valid_to),
    discount_percent: normalizeOptionalNumber(payload.discount_percent),
    discount_valid_from: normalizeOptionalString(payload.discount_valid_from),
    discount_valid_to: normalizeOptionalString(payload.discount_valid_to),
    bill_reminder_days_before: normalizeOptionalNumber(payload.bill_reminder_days_before),
    grace_period_days: normalizeOptionalNumber(payload.grace_period_days),
    // Whether this company is on the license/subscription model at all.
    // Off for every company that predates the billing module.
    billing_enforced:
      payload.billing_enforced === undefined || payload.billing_enforced === null
        ? undefined
        : payload.billing_enforced === true || payload.billing_enforced === 'true',
  };
}

const COMPANY_LIST_SELECT = `
  SELECT c.id, c.name, c.slug, c.created_at,
    c.is_active,
    c.logo_filename,
    c.banner_filename,
    c.group_id,
    cg.name AS group_name,
    c.owner_user_id,
    owner.name AS owner_name,
    owner.surname AS owner_surname,
    owner.avatar_filename AS owner_avatar_filename,
    c.registration_number,
    c.vat_number,
    c.sdi_recipient_code,
    c.pec_email,
    c.company_email,
    c.company_phone_numbers,
    c.offices_locations,
    c.country,
    c.city,
    c.state,
    c.address,
    c.currency,
    c.price_per_employee::float,
    c.price_per_device::float,
    c.extra_storage_price_per_gb::float,
    c.storage_limit_gb::float AS storage_limit_gb,
    c.access_valid_from,
    c.access_valid_to,
    c.discount_percent::float AS discount_percent,
    c.discount_valid_from,
    c.discount_valid_to,
    COALESCE(c.bill_reminder_days_before, 3)::int AS bill_reminder_days_before,
    COALESCE(c.grace_period_days, 3)::int AS grace_period_days,
    COALESCE(c.billing_enforced, false) AS billing_enforced,
    (SELECT COUNT(*) FROM stores s WHERE s.company_id = c.id AND s.is_active = true)::int AS store_count,
    (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.status = 'active' AND u.role != 'store_terminal')::int AS employee_count,
    (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.status = 'active' AND u.role = 'store_terminal' AND (u.registered_device_token IS NOT NULL OR u.registered_device_identifier IS NOT NULL))::int AS active_devices_count,
    (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.status = 'active' AND u.role != 'store_terminal' AND (u.registered_device_token IS NOT NULL OR u.registered_device_identifier IS NOT NULL))::int AS employee_devices_count
  FROM companies c
  LEFT JOIN company_groups cg ON cg.id = c.group_id
  LEFT JOIN users owner ON owner.id = c.owner_user_id
`;

async function getCompanyCardById(companyId: number): Promise<CompanyRow | null> {
  const row = await queryOne<CompanyRow>(
    `${COMPANY_LIST_SELECT}
     WHERE c.id = $1`,
    [companyId],
  );
  if (row) {
    (row as any).storage_used_bytes = await calculateCompanyStorage(companyId);
  }
  return row;
}

async function calculateCompanyStorage(companyId: number): Promise<number> {
  const genericDocs = await query<{ file_url: string }>(`SELECT file_url FROM documents WHERE company_id = $1`, [companyId]);
  const employeeDocs = await query<{ storage_path: string }>(`SELECT storage_path FROM employee_documents WHERE company_id = $1`, [companyId]);

  const allPaths = new Set<string>();
  genericDocs.forEach(d => { if (d.file_url) allPaths.add(d.file_url); });
  employeeDocs.forEach(d => { if (d.storage_path) allPaths.add(d.storage_path); });

  const fs = require('fs');
  const path = require('path');
  let totalBytes = 0;
  for (const p of allPaths) {
    try {
      const stat = fs.statSync(path.resolve(p));
      totalBytes += stat.size;
    } catch {
      // Ignore if file doesn't exist
    }
  }
  return totalBytes;
}

// GET /api/companies — scoped by group visibility rules
export const listCompanies = asyncHandler(async (req: Request, res: Response) => {
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  const companies = await query<CompanyRow>(
    `${COMPANY_LIST_SELECT}
     WHERE c.id = ANY($1)
     ORDER BY c.id`,
    [allowedCompanyIds],
  );

  for (const c of companies) {
    (c as any).storage_used_bytes = await calculateCompanyStorage(c.id);
  }

  ok(res, companies);
});

// GET /api/companies/:id — scoped company detail card
export const getCompanyById = asyncHandler(async (req: Request, res: Response) => {
  const targetCompanyId = parseInt(req.params.id, 10);
  if (Number.isNaN(targetCompanyId)) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (!allowedCompanyIds.includes(targetCompanyId)) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  const company = await getCompanyCardById(targetCompanyId);
  if (!company) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  ok(res, company);
});

// PUT /api/companies/:id — Admin only, update name/slug for any company
export const updateCompany = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const targetCompanyId = parseInt(id, 10);
  if (isNaN(targetCompanyId)) { notFound(res, 'Azienda non trovata'); return; }
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

  if (!allowedCompanyIds.includes(targetCompanyId)) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  const body = req.body as Record<string, unknown>;
  const name = String(body.name ?? '').trim();
  const group_id = body.group_id as number | null | undefined;
  const profile = extractCompanyProfileInput(body);
  const user = req.user!;

  if (!name) {
    badRequest(res, 'Nome azienda obbligatorio', 'VALIDATION_ERROR');
    return;
  }

  // Restrict non-super-admins to only re-assign the company inside their own group.
  // They can also set the company as standalone (`group_id = null`) within their scope.
  let permittedUserGroupId: number | null = null;
  if (user.is_super_admin !== true && group_id !== undefined) {
    permittedUserGroupId = user.companyId === null ? null : await resolveCompanyGroupId(user.companyId);
    if (group_id !== null && group_id !== permittedUserGroupId) {
      notFound(res, 'Azienda non trovata');
      return;
    }
  }

  // Validate group_id if explicitly provided.
  if (group_id !== undefined && group_id !== null) {
    const exists = await queryOne<{ id: number }>(
      `SELECT id FROM company_groups WHERE id = $1`,
      [group_id]
    );
    if (!exists) {
      badRequest(res, 'Gruppo azienda non valido', 'INVALID_GROUP');
      return;
    }
  }

  // Derive slug from name: lowercase, spaces → hyphens, strip non-alphanumeric
  const slug = name.toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!slug) {
    badRequest(res, 'Nome azienda non valido', 'VALIDATION_ERROR');
    return;
  }

  // Check slug uniqueness against other companies
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM companies WHERE slug = $1 AND id != $2`,
    [slug, id]
  );
  const finalSlug = existing ? `${slug}-${id}` : slug;

  const setClauses: string[] = ['name = $1', 'slug = $2'];
  const params: any[] = [name, finalSlug];
  let nextParam = 3;

  if (group_id !== undefined) {
    setClauses.push(`group_id = $${nextParam}`);
    params.push(group_id ?? null);
    nextParam += 1;
  }

  const profileEntries: Array<
    [keyof CompanyProfileInput, string | number | boolean | null | undefined]
  > = [
    ['registration_number', profile.registration_number],
    ['vat_number', profile.vat_number],
    ['sdi_recipient_code', profile.sdi_recipient_code],
    ['pec_email', profile.pec_email],
    ['company_email', profile.company_email],
    ['company_phone_numbers', profile.company_phone_numbers],
    ['offices_locations', profile.offices_locations],
    ['country', profile.country],
    ['city', profile.city],
    ['state', profile.state],
    ['address', profile.address],
    ['currency', profile.currency],
    ['price_per_employee', profile.price_per_employee],
    ['price_per_device', profile.price_per_device],
    ['extra_storage_price_per_gb', profile.extra_storage_price_per_gb],
    ['storage_limit_gb', profile.storage_limit_gb],
    ['access_valid_from', profile.access_valid_from],
    ['access_valid_to', profile.access_valid_to],
    ['discount_percent', profile.discount_percent],
    ['discount_valid_from', profile.discount_valid_from],
    ['discount_valid_to', profile.discount_valid_to],
    ['bill_reminder_days_before', profile.bill_reminder_days_before],
    ['grace_period_days', profile.grace_period_days],
    ['billing_enforced', profile.billing_enforced],
  ];

  for (const [column, value] of profileEntries) {
    if (value === undefined) continue;
    setClauses.push(`${column} = $${nextParam}`);
    params.push(value);
    nextParam += 1;
  }

  params.push(targetCompanyId);

  const updated = await queryOne<{ id: number }>(
    `UPDATE companies
     SET ${setClauses.join(', ')}
     WHERE id = $${nextParam}
     RETURNING id`,
    params,
  );
  if (!updated) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  // A price or discount edit has to reach the live subscription, or the app
  // would show the new rate while the provider kept billing the old one. This
  // never fails the save: the daily job repairs anything that does not stick.
  const pricingTouched =
    profile.price_per_employee !== undefined ||
    profile.price_per_device !== undefined ||
    profile.discount_percent !== undefined ||
    profile.discount_valid_from !== undefined ||
    profile.discount_valid_to !== undefined;

  if (pricingTouched) {
    try {
      const subs = await pool.query(
        `SELECT id, company_id, provider, provider_subscription_id, seat_quantity,
                device_quantity, unit_price_employee, unit_price_device, currency, status
         FROM subscriptions
         WHERE company_id = $1 AND status IN ('active', 'past_due')
        `,
        [targetCompanyId]
      );
      for (const sub of subs.rows) {
        await syncSubscriptionPricing(sub);
      }
    } catch (err) {
      console.error(
        `[Companies] Could not reprice subscriptions for company ${targetCompanyId}:`,
        (err as Error)?.message || err
      );
    }
  }


  const company = await getCompanyCardById(targetCompanyId);
  if (!company) { notFound(res, 'Azienda non trovata'); return; }

  ok(res, company, 'Azienda aggiornata');
});

// POST /api/companies — admin only, create a new company
export const createCompany = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const name = String(body.name ?? '').trim();
  const group_id = body.group_id as number | null | undefined;
  const requestedOwnerUserId = body.owner_user_id == null ? null : Number(body.owner_user_id);
  const profile = extractCompanyProfileInput(body);
  let ownerUserId = req.user!.userId;

  const baseSlug = name.toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!name) {
    badRequest(res, 'Nome azienda obbligatorio', 'VALIDATION_ERROR');
    return;
  }

  if (!baseSlug) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  // Validate group_id if explicitly provided
  if (group_id !== undefined && group_id !== null) {
    const exists = await queryOne<{ id: number }>(
      `SELECT id FROM company_groups WHERE id = $1`,
      [group_id]
    );
    if (!exists) {
      badRequest(res, 'Gruppo azienda non valido', 'INVALID_GROUP');
      return;
    }
  }

  if (requestedOwnerUserId !== null) {
    if (!Number.isInteger(requestedOwnerUserId) || requestedOwnerUserId <= 0) {
      badRequest(res, 'Proprietario non valido', 'VALIDATION_ERROR');
      return;
    }

    const owner = await queryOne<{ id: number }>(
      `SELECT id
       FROM users
       WHERE id = $1
         AND role = 'admin'
         AND status = 'active'`,
      [requestedOwnerUserId],
    );

    if (!owner) {
      badRequest(res, 'Il proprietario deve essere un admin attivo', 'INVALID_OWNER');
      return;
    }

    ownerUserId = requestedOwnerUserId;
  }

  // Ensure slug uniqueness (companies.slug is UNIQUE)
  let slug = baseSlug;
  let attempt = 2;
  // eslint-disable-next-line no-await-in-loop
  while (true) {
    const existing = await queryOne<{ id: number }>(
      `SELECT id FROM companies WHERE slug = $1`,
      [slug]
    );
    if (!existing) break;
    slug = `${baseSlug}-${attempt++}`;
  }

  const createdCompanyId = await queryOne<{ id: number }>(
    `INSERT INTO companies (
       name,
       slug,
       group_id,
       owner_user_id,
       registration_number,
       vat_number,
       sdi_recipient_code,
       pec_email,
       company_email,
       company_phone_numbers,
       offices_locations,
       country,
       city,
       state,
       address,
       currency,
       price_per_employee,
       price_per_device,
       extra_storage_price_per_gb,
       storage_limit_gb,
       access_valid_from,
       access_valid_to,
       discount_percent,
       discount_valid_from,
       discount_valid_to,
       bill_reminder_days_before,
       grace_period_days,
       billing_enforced
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
     RETURNING id`,
    [
      name,
      slug,
      group_id ?? null,
      ownerUserId,
      profile.registration_number ?? null,
      profile.vat_number ?? null,
      profile.sdi_recipient_code ?? null,
      profile.pec_email ?? null,
      profile.company_email ?? null,
      profile.company_phone_numbers ?? null,
      profile.offices_locations ?? null,
      profile.country ?? null,
      profile.city ?? null,
      profile.state ?? null,
      profile.address ?? null,
      profile.currency ?? null,
      profile.price_per_employee ?? 0,
      profile.price_per_device ?? 0,
      profile.extra_storage_price_per_gb ?? 0,
      profile.storage_limit_gb ?? 500,
      profile.access_valid_from ?? null,
      profile.access_valid_to ?? null,
      profile.discount_percent ?? 0,
      profile.discount_valid_from ?? null,
      profile.discount_valid_to ?? null,
      profile.bill_reminder_days_before ?? 3,
      profile.grace_period_days ?? 3,
      // New companies are created on the billing model unless told otherwise.
      profile.billing_enforced ?? true,
    ]
  );
  if (!createdCompanyId) {
    badRequest(res, "Impossibile creare l'azienda");
    return;
  }

  const company = await getCompanyCardById(createdCompanyId.id);
  if (!company) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  created(res, company, 'Azienda creata');
});

// GET /api/companies/settings — admin/hr: get current company settings
export const getCompanySettings = asyncHandler(async (req: Request, res: Response) => {
  const { companyId } = req.user!;
  const company = await queryOne<{ show_leave_balance_to_employee: boolean }>(
    `SELECT show_leave_balance_to_employee FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!company) { notFound(res, 'Azienda non trovata'); return; }
  ok(res, { showLeaveBalanceToEmployee: company.show_leave_balance_to_employee });
});

// PATCH /api/companies/settings — admin only, update company-level settings
export const updateCompanySettings = asyncHandler(async (req: Request, res: Response) => {
  const { companyId } = req.user!;
  // Validated by Zod schema in routes (snake_case from Axios interceptor)
  const { show_leave_balance_to_employee } = req.body as { show_leave_balance_to_employee: boolean };

  const company = await queryOne(
    `UPDATE companies SET show_leave_balance_to_employee = $1 WHERE id = $2
     RETURNING id, show_leave_balance_to_employee`,
    [show_leave_balance_to_employee, companyId]
  );
  if (!company) { notFound(res, 'Azienda non trovata'); return; }
  ok(res, company, 'Impostazioni aggiornate');
});

// GET /api/companies/break-settings — admin/hr: get company break & payroll settings
export const getBreakSettings = asyncHandler(async (req: Request, res: Response) => {
  const { companyId } = req.user!;
  try {
    const row = await queryOne<{ break_enforcement_enabled: boolean; break_tolerance_minutes: number }>(
      `SELECT break_enforcement_enabled, break_tolerance_minutes FROM company_break_settings WHERE company_id = $1`,
      [companyId]
    );
    ok(res, {
      breakEnforcementEnabled: row?.break_enforcement_enabled ?? false,
      breakToleranceMinutes: row?.break_tolerance_minutes ?? 10,
    });
  } catch (e) {
    // If table doesn't exist yet in local dev environment
    ok(res, { breakEnforcementEnabled: false, breakToleranceMinutes: 10 });
  }
});

// PATCH /api/companies/break-settings — admin only, update company break & payroll settings
export const updateBreakSettings = asyncHandler(async (req: Request, res: Response) => {
  const { companyId } = req.user!;
  const { break_enforcement_enabled, break_tolerance_minutes } = req.body as {
    break_enforcement_enabled?: boolean;
    break_tolerance_minutes?: number;
  };

  const enforcement = break_enforcement_enabled ?? false;
  const tolerance = Math.max(0, Math.min(120, break_tolerance_minutes ?? 10));

  const row = await queryOne<{ break_enforcement_enabled: boolean; break_tolerance_minutes: number }>(
    `INSERT INTO company_break_settings (company_id, break_enforcement_enabled, break_tolerance_minutes, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (company_id) DO UPDATE SET
       break_enforcement_enabled = EXCLUDED.break_enforcement_enabled,
       break_tolerance_minutes = EXCLUDED.break_tolerance_minutes,
       updated_at = NOW()
     RETURNING break_enforcement_enabled, break_tolerance_minutes`,
    [companyId, enforcement, tolerance]
  );

  ok(res, {
    breakEnforcementEnabled: row?.break_enforcement_enabled ?? enforcement,
    breakToleranceMinutes: row?.break_tolerance_minutes ?? tolerance,
  }, 'Impostazioni pause aggiornate');
});

// PATCH /api/companies/:id/deactivate — Super Admin only
export const deactivateCompany = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const targetCompanyId = parseInt(id, 10);
  if (isNaN(targetCompanyId)) { notFound(res, 'Azienda non trovata'); return; }

  const updated = await queryOne(
    `UPDATE companies SET is_active = false WHERE id = $1 RETURNING id, name, slug, is_active, logo_filename, banner_filename, group_id, owner_user_id, registration_number, vat_number, sdi_recipient_code, pec_email, company_email, company_phone_numbers, offices_locations, country, city, state, address, currency, created_at`,
    [targetCompanyId]
  );
  if (!updated) { notFound(res, 'Azienda non trovata'); return; }

  ok(res, updated, 'Azienda disattivata');
});

// PATCH /api/companies/:id/activate — Super Admin only
export const activateCompany = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const targetCompanyId = parseInt(id, 10);
  if (isNaN(targetCompanyId)) { notFound(res, 'Azienda non trovata'); return; }

  const updated = await queryOne(
    `UPDATE companies SET is_active = true WHERE id = $1 RETURNING id, name, slug, is_active, logo_filename, banner_filename, group_id, owner_user_id, registration_number, vat_number, sdi_recipient_code, pec_email, company_email, company_phone_numbers, offices_locations, country, city, state, address, currency, created_at`,
    [targetCompanyId]
  );
  if (!updated) { notFound(res, 'Azienda non trovata'); return; }

  ok(res, updated, 'Azienda attivata');
});

// DELETE /api/companies/:id — Super Admin only (permanent)
export const deleteCompany = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const targetCompanyId = parseInt(id, 10);
  if (isNaN(targetCompanyId)) { notFound(res, 'Azienda non trovata'); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Manually delete related data from tables missing ON DELETE CASCADE to avoid 500 error
    await client.query('DELETE FROM notification_failures WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM employee_trainings WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM employee_medical_checks WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM attendance_events WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM qr_tokens WHERE company_id = $1', [targetCompanyId]);

    // Leave approvals and configs
    await client.query('DELETE FROM leave_approvals WHERE leave_request_id IN (SELECT id FROM leave_requests WHERE company_id = $1)', [targetCompanyId]);
    await client.query('DELETE FROM leave_requests WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM leave_balances WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM leave_approval_config WHERE company_id = $1', [targetCompanyId]);

    // Shifts & Affluence
    await client.query('DELETE FROM shift_templates WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM store_affluence WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM shifts WHERE company_id = $1', [targetCompanyId]);

    // Finally delete the company itself (cascades to users, stores, documents, permissions, etc.)
    const result = await client.query(
      'DELETE FROM companies WHERE id = $1 RETURNING id',
      [targetCompanyId]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      notFound(res, 'Azienda non trovata');
      return;
    }

    await client.query('COMMIT');
    ok(res, { id: targetCompanyId }, 'Azienda eliminata');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export const transferCompanyOwnership = asyncHandler(async (req: Request, res: Response) => {
  const targetCompanyId = parseInt(req.params.id, 10);
  if (Number.isNaN(targetCompanyId)) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  const { owner_user_id } = req.body as { owner_user_id: number };
  const nextOwnerId = Number(owner_user_id);
  if (!Number.isFinite(nextOwnerId) || nextOwnerId <= 0) {
    badRequest(res, 'Proprietario non valido', 'VALIDATION_ERROR');
    return;
  }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  if (!allowedCompanyIds.includes(targetCompanyId)) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  const owner = await queryOne<{ id: number }>(
    `SELECT id
     FROM users
     WHERE id = $1
       AND company_id = $2
       AND role = 'admin'
       AND status = 'active'`,
    [nextOwnerId, targetCompanyId],
  );

  if (!owner) {
    badRequest(res, 'Il proprietario deve essere un admin attivo dell\'azienda', 'INVALID_OWNER');
    return;
  }

  const updated = await queryOne<{ id: number }>(
    `UPDATE companies
     SET owner_user_id = $1
     WHERE id = $2
     RETURNING id`,
    [nextOwnerId, targetCompanyId],
  );

  if (!updated) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  const company = await getCompanyCardById(targetCompanyId);
  if (!company) {
    notFound(res, 'Azienda non trovata');
    return;
  }

  ok(res, company, 'Proprietario azienda aggiornato');
});
