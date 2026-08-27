import { Request, Response } from 'express';
import { query } from '../../config/database';
import { ok } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { resolveAllowedCompanyIds } from '../../utils/companyScope';

function getRoleFromQuery(q: string): string | null {
  const clean = q.toLowerCase().trim();
  if (['admin', 'administrator', 'amministratore', 'amministratori', 'admins'].includes(clean)) {
    return 'admin';
  }
  if (['hr', 'human resources', 'risorse umane', 'human resource'].includes(clean)) {
    return 'hr';
  }
  if (['area manager', 'area_manager', 'area managers'].includes(clean)) {
    return 'area_manager';
  }
  if (['store manager', 'store_manager', 'resp negozio', 'responsabile negozio', 'store managers'].includes(clean)) {
    return 'store_manager';
  }
  if (['employee', 'dipendente', 'dipendenti', 'employees', 'staff'].includes(clean)) {
    return 'employee';
  }
  if (['terminal', 'terminale', 'store terminal'].includes(clean)) {
    return 'store_terminal';
  }
  if (['super admin', 'superadmin', 'system admin', 'system_admin', 'systemadmin'].includes(clean)) {
    return 'system_admin';
  }
  return null;
}

export const globalSearch = asyncHandler(async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const moduleFilter = typeof req.query.module === 'string' ? req.query.module.trim().toLowerCase() : 'all';
  const roleFilterStr = typeof req.query.roleFilter === 'string' ? req.query.roleFilter.trim() : '';

  if (!q || q.length < 2) {
    return ok(res, {
      companies: [],
      employees: [],
      candidates: [],
      jobs: [],
      onboarding: [],
      stores: [],
      messages: [],
      documents: []
    });
  }

  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
  const searchPattern = `%${q}%`;
  const callerUserId = req.user!.userId;
  const queryRole = getRoleFromQuery(q);
  const roleFilter = roleFilterStr && roleFilterStr !== 'all' ? roleFilterStr : null;

  const results: {
    companies: any[];
    employees: any[];
    candidates: any[];
    jobs: any[];
    onboarding: any[];
    stores: any[];
    messages: any[];
    documents: any[];
  } = {
    companies: [],
    employees: [],
    candidates: [],
    jobs: [],
    onboarding: [],
    stores: [],
    messages: [],
    documents: []
  };

  const queryAll = moduleFilter === 'all';
  const queryCompanies = (queryAll || moduleFilter === 'companies') && !roleFilter;
  const queryEmployees = queryAll || moduleFilter === 'employees';
  const queryCandidates = queryAll || moduleFilter === 'candidates';
  const queryJobs = queryAll || moduleFilter === 'jobs';
  const queryOnboarding = queryAll || moduleFilter === 'onboarding';
  const queryStores = queryAll || moduleFilter === 'stores';
  const queryMessages = queryAll || moduleFilter === 'messages';
  const queryDocuments = queryAll || moduleFilter === 'documents';

  const limitVal = queryAll ? 10 : 30;
  const queries: Promise<any>[] = [];

  // 1. Companies Query
  if (queryCompanies) {
    queries.push(
      query(
        `SELECT c.id, c.name, c.slug, c.logo_filename, cg.name AS group_name,
                (SELECT COUNT(*)::int FROM stores s WHERE s.company_id = c.id) AS store_count,
                (SELECT COUNT(*)::int FROM users u WHERE u.company_id = c.id AND u.role::text != 'store_terminal') AS employee_count
         FROM companies c
         LEFT JOIN company_groups cg ON cg.id = c.group_id
         WHERE c.id = ANY($1) 
           AND (c.name ILIKE $2 OR c.slug ILIKE $2)
         ORDER BY c.name
         LIMIT $3`,
        [allowedCompanyIds, searchPattern, limitVal]
      ).then((res) => {
        results.companies = res;
      })
    );
  }

  // 2. Employees Query
  if (queryEmployees) {
    queries.push(
      query(
        `SELECT u.id, u.name, u.surname, u.email, u.unique_id, u.role, u.avatar_filename, u.company_id, c.name AS company_name
         FROM users u
         LEFT JOIN companies c ON c.id = u.company_id
         WHERE u.company_id = ANY($1)
           AND u.role::text != 'store_terminal'
           AND (
             u.name ILIKE $2 OR u.surname ILIKE $2 OR u.email ILIKE $2 OR u.unique_id ILIKE $2
             OR ($4::TEXT IS NOT NULL AND u.role::text = $4)
           )
           AND ($5::TEXT IS NULL OR u.role::text = $5)
         ORDER BY u.surname, u.name
         LIMIT $3`,
        [allowedCompanyIds, searchPattern, limitVal, queryRole, roleFilter]
      ).then((res) => {
        results.employees = res;
      })
    );
  }

  // 3. Candidates Query (ATS)
  if (queryCandidates) {
    queries.push(
      query(
        `SELECT cand.id, cand.full_name, cand.email, cand.phone, cand.status, cand.company_id, c.name AS company_name, jp.title AS job_title
         FROM candidates cand
         LEFT JOIN companies c ON c.id = cand.company_id
         LEFT JOIN job_postings jp ON jp.id = cand.job_posting_id
         WHERE cand.company_id = ANY($1)
           AND (cand.full_name ILIKE $2 OR cand.email ILIKE $2 OR cand.phone ILIKE $2)
           AND ($4::TEXT IS NULL OR jp.target_role = $4)
         ORDER BY cand.full_name
         LIMIT $3`,
        [allowedCompanyIds, searchPattern, limitVal, roleFilter]
      ).then((res) => {
        results.candidates = res;
      })
    );
  }

  // 4. Job Postings Query (ATS)
  if (queryJobs) {
    queries.push(
      query(
        `SELECT jp.id, jp.title, jp.status, jp.company_id, c.name AS company_name, jp.target_role
         FROM job_postings jp
         LEFT JOIN companies c ON c.id = jp.company_id
         WHERE jp.company_id = ANY($1)
           AND (
             jp.title ILIKE $2 OR jp.description ILIKE $2
             OR ($4::TEXT IS NOT NULL AND jp.target_role = $4)
           )
           AND ($5::TEXT IS NULL OR jp.target_role = $5)
         ORDER BY jp.title
         LIMIT $3`,
        [allowedCompanyIds, searchPattern, limitVal, queryRole, roleFilter]
      ).then((res) => {
        results.jobs = res;
      })
    );
  }

  // 5. Onboarding Query
  if (queryOnboarding) {
    const templatesQuery = (!roleFilter) ? query(
      `SELECT ot.id, ot.name, ot.description, ot.category, ot.task_type, ot.priority, ot.company_id, c.name AS company_name
       FROM onboarding_templates ot
       LEFT JOIN companies c ON c.id = ot.company_id
       WHERE ot.company_id = ANY($1)
         AND (ot.name ILIKE $2 OR ot.description ILIKE $2)
       ORDER BY ot.name
       LIMIT $3`,
      [allowedCompanyIds, searchPattern, limitVal]
    ) : Promise.resolve([]);

    const tasksQuery = query(
      `SELECT eot.id,
              ot.name AS task_name,
              ot.description AS task_description,
              ot.category AS task_category,
              ot.priority AS task_priority,
              eot.completed,
              eot.completed_at,
              u.id AS employee_id,
              u.name AS employee_name,
              u.surname AS employee_surname,
              u.email AS employee_email,
              u.role AS employee_role,
              ot.company_id,
              c.name AS company_name
       FROM employee_onboarding_tasks eot
       JOIN onboarding_templates ot ON ot.id = eot.template_id
       JOIN users u ON u.id = eot.employee_id
       LEFT JOIN companies c ON c.id = ot.company_id
       WHERE ot.company_id = ANY($1)
         AND (
           (ot.name ILIKE $2 OR ot.description ILIKE $2 OR u.name ILIKE $2 OR u.surname ILIKE $2)
           OR ($4::TEXT IS NOT NULL AND u.role::text = $4)
         )
         AND ($5::TEXT IS NULL OR u.role::text = $5)
       ORDER BY ot.name
       LIMIT $3`,
      [allowedCompanyIds, searchPattern, limitVal, queryRole, roleFilter]
    );

    queries.push(
      Promise.all([templatesQuery, tasksQuery]).then(([templatesList, tasksList]) => {
        results.onboarding = [
          ...templatesList.map((t: any) => ({ ...t, onboarding_type: 'template' })),
          ...tasksList.map((t: any) => ({ ...t, onboarding_type: 'task' }))
        ];
      })
    );
  }

  // 6. Stores Query
  if (queryStores) {
    queries.push(
      query(
        `SELECT s.id, s.name, s.code, s.address, s.company_id, c.name AS company_name, s.is_active
         FROM stores s
         LEFT JOIN companies c ON c.id = s.company_id
         WHERE s.company_id = ANY($1)
           AND (
             (s.name ILIKE $2 OR s.code ILIKE $2 OR s.address ILIKE $2)
             OR ($4::TEXT IS NOT NULL AND EXISTS (
               SELECT 1 FROM users u WHERE u.store_id = s.id AND u.role::text = $4
             ))
           )
           AND ($5::TEXT IS NULL OR EXISTS (
             SELECT 1 FROM users u WHERE u.store_id = s.id AND u.role::text = $5
           ))
         ORDER BY s.name
         LIMIT $3`,
        [allowedCompanyIds, searchPattern, limitVal, queryRole, roleFilter]
      ).then((res) => {
        results.stores = res;
      })
    );
  }

  // 7. Messages Query
  if (queryMessages) {
    queries.push(
      query(
        `SELECT m.id, m.subject, m.body, m.created_at, m.is_read,
                m.company_id, c.name AS company_name,
                sender.id AS sender_id, sender.name AS sender_name, sender.surname AS sender_surname, sender.role AS sender_role,
                recipient.id AS recipient_id, recipient.name AS recipient_name, recipient.surname AS recipient_surname, recipient.role AS recipient_role
         FROM messages m
         LEFT JOIN companies c ON c.id = m.company_id
         LEFT JOIN users sender ON sender.id = m.sender_id
         LEFT JOIN users recipient ON recipient.id = m.recipient_id
         WHERE m.company_id = ANY($1)
           AND (m.sender_id = $3 OR m.recipient_id = $3)
           AND (
             (m.subject ILIKE $2 OR m.body ILIKE $2 OR sender.name ILIKE $2 OR sender.surname ILIKE $2 OR recipient.name ILIKE $2 OR recipient.surname ILIKE $2)
             OR ($4::TEXT IS NOT NULL AND (sender.role::text = $4 OR recipient.role::text = $4))
           )
           AND ($5::TEXT IS NULL OR sender.role::text = $5 OR recipient.role::text = $5)
         ORDER BY m.created_at DESC
         LIMIT $6`,
        [allowedCompanyIds, searchPattern, callerUserId, queryRole, roleFilter, limitVal]
      ).then((res) => {
        results.messages = res;
      })
    );
  }

  // 8. Documents Query
  if (queryDocuments) {
    queries.push(
      query(
        `SELECT d.id, d.file_name, d.mime_type, d.uploaded_at, d.requires_signature, d.signed_at,
                dc.name AS category_name,
                u.name AS employee_name, u.surname AS employee_surname, u.role AS employee_role,
                d.company_id, c.name AS company_name
         FROM employee_documents d
         LEFT JOIN companies c ON c.id = d.company_id
         LEFT JOIN document_categories dc ON dc.id = d.category_id
         LEFT JOIN users u ON u.id = d.employee_id
         WHERE d.company_id = ANY($1)
           AND (
             (d.file_name ILIKE $2 OR dc.name ILIKE $2 OR u.name ILIKE $2 OR u.surname ILIKE $2)
             OR ($4::TEXT IS NOT NULL AND u.role::text = $4)
           )
           AND ($5::TEXT IS NULL OR u.role::text = $5)
         ORDER BY d.uploaded_at DESC
         LIMIT $3`,
        [allowedCompanyIds, searchPattern, limitVal, queryRole, roleFilter]
      ).then((res) => {
        results.documents = res;
      })
    );
  }

  await Promise.all(queries);

  ok(res, results);
});
