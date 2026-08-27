import { Request, Response } from 'express';
import { query, queryOne } from '../../config/database';
import { ok, notFound, badRequest, forbidden } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { generateReport } from './reports-generation.service';
import { getLastScheduledRunDate } from './reports-schedule';
import { readGeneratedReportPdf, deleteGeneratedReportPdf } from './reports-storage.service';
import { resolveThresholds } from './reports-thresholds';
import { previousPeriod, snapshotPeriod, completionRate } from './reports-metrics.service';
import {
  getReportDefinition,
  reportsForRole,
  canRoleAccessReport,
  REPORT_DEFINITIONS,
  OwnerRole,
} from './reports-registry';

/** Reports an HR user must never see, regardless of what the frontend renders. */
const ADMIN_ONLY_REPORT_IDS = new Set(
  REPORT_DEFINITIONS.filter(d => d.ownerRole === 'admin').map(d => d.id),
);

const canAccessReport = canRoleAccessReport;

interface ReportConfigRow {
  id: number;
  report_id: string;
  day: number;
  time: string;
  recipients: string[] | string;
  sections: string[] | string;
  status: string;
  run_count: number;
  last_generated: string | null;
  period: string;
  custom_start: string | null;
  custom_end: string | null;
  thresholds: Record<string, number> | string;
  max_pages: number;
  max_rows_per_section: number;
  retention_count: number;
  owner_user_id: number | null;
  store_id: number | null;
}

const CONFIG_COLUMNS = `id, report_id, day, time, recipients, sections, status, run_count, last_generated,
                        period, custom_start, custom_end, thresholds, max_pages, max_rows_per_section, retention_count,
                        owner_user_id, store_id`;

function parseJsonColumn<T>(value: T | string, fallback: T): T {
  if (typeof value !== 'string') return value ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapConfigRow(r: ReportConfigRow) {
  const definition = getReportDefinition(r.report_id);
  return {
    reportId: r.report_id,
    // What this particular report can render. The configure dialog used to
    // build its checkbox list from the user's role, which offered sections the
    // generator had no branch for — they saved, then produced nothing.
    supportedSections: definition?.supportedSections ?? [],
    comparesPeriods: definition?.comparesPeriods ?? true,
    day: r.day,
    time: r.time,
    recipients: parseJsonColumn<string[]>(r.recipients, []),
    sections: parseJsonColumn<string[]>(r.sections, []),
    status: r.status,
    runCount: r.run_count,
    lastGenerated: r.last_generated,
    period: r.period,
    customStart: r.custom_start,
    customEnd: r.custom_end,
    thresholds: parseJsonColumn<Record<string, number>>(r.thresholds, {}),
    maxPages: r.max_pages,
    maxRowsPerSection: r.max_rows_per_section,
    retentionCount: r.retention_count,
    ownerUserId: r.owner_user_id,
    storeId: r.store_id,
  };
}

function getClampedMonthDay(year: number, monthIndex: number, targetDay: number): number {
  const lastDayOfMonth = new Date(year, monthIndex + 1, 0).getDate();
  return Math.min(Math.max(targetDay, 1), lastDayOfMonth);
}

function getPreviousMonthDateClamped(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth() - 1,
    getClampedMonthDay(date.getFullYear(), date.getMonth() - 1, date.getDate()),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function buildReportFilename(reportId: string, targetDate: Date): string {
  const end = new Date(targetDate);
  end.setDate(targetDate.getDate() - 1);
  const start = new Date(targetDate);

  if (reportId === 'admin_monthly') {
    start.setTime(getPreviousMonthDateClamped(targetDate).getTime());
    return `monthly-admin-report-${formatDate(start)}-to-${formatDate(end)}.pdf`;
  }

  if (reportId === 'hr_monthly') {
    start.setDate(targetDate.getDate() - 30);
    return `monthly-hr-report-${formatDate(start)}-to-${formatDate(end)}.pdf`;
  }

  if (reportId === 'anomaly_daily') {
    return `daily-hr-alert-ats-${formatDate(targetDate)}.pdf`;
  }

  start.setDate(targetDate.getDate() - 7);
  return `weekly-hr-report-${formatDate(start)}-to-${formatDate(end)}.pdf`;
}

// GET /api/reports/configurations
export const getReportConfigurations = asyncHandler(async (req: Request, res: Response) => {
  const explicit = req.body?.company_id ?? req.query?.company_id ?? req.params?.company_id;
  const targetCompanyId = explicit !== undefined ? parseInt(String(explicit), 10) : req.user!.companyId;

  if (!targetCompanyId) {
    notFound(res, 'Company not found');
    return;
  }

  const rows = await query<ReportConfigRow>(
    `SELECT ${CONFIG_COLUMNS} FROM report_configurations WHERE company_id = $1`,
    [targetCompanyId],
  );

  const visible = rows.filter(r => canAccessReport(req.user?.role, r.report_id));
  ok(res, visible.map(mapConfigRow));
});

// PUT /api/reports/configurations/:reportId
export const saveReportConfiguration = asyncHandler(async (req: Request, res: Response) => {
  const explicit = req.body?.company_id ?? req.query?.company_id ?? req.params?.company_id;
  const targetCompanyId = explicit !== undefined ? parseInt(String(explicit), 10) : req.user!.companyId;

  if (!targetCompanyId) {
    notFound(res, 'Company not found');
    return;
  }

  const { reportId } = req.params;
  const { day, time, recipients, sections, status, thresholds } = req.body;
  const ownerUserId = req.body.owner_user_id ?? req.body.ownerUserId ?? null;
  const storeId = req.body.store_id ?? req.body.storeId ?? null;
  const maxPages = req.body.max_pages ?? req.body.maxPages ?? null;
  const maxRowsPerSection = req.body.max_rows_per_section ?? req.body.maxRowsPerSection ?? null;
  const retentionCount = req.body.retention_count ?? req.body.retentionCount ?? null;

  if (!canAccessReport(req.user?.role, reportId)) {
    forbidden(res, 'Non hai i permessi per questo report.');
    return;
  }

  // An HR user may only edit their own schedules, and cannot set ownerUserId to null or other IDs.
  if (req.user?.role === 'hr') {
    if (ownerUserId === null || ownerUserId !== req.user.userId) {
      forbidden(res, 'Non hai i permessi per modificare questo report.');
      return;
    }
    // Set/verify the store ID matches their token's storeId to prevent config tampering
    if (storeId !== req.user.storeId) {
      forbidden(res, 'Non hai i permessi per impostare questo negozio.');
      return;
    }
  }

  // Refuse sections this report cannot draw, instead of storing them and
  // producing a PDF that silently omits them.
  if (Array.isArray(sections)) {
    const definition = getReportDefinition(reportId);
    if (definition) {
      const unsupported = sections.filter(
        (s: string) => !definition.supportedSections.includes(String(s).toLowerCase().trim()),
      );
      if (unsupported.length > 0) {
        badRequest(
          res,
          `Sezioni non disponibili per questo report: ${unsupported.join(', ')}`,
          'UNSUPPORTED_SECTION',
        );
        return;
      }
    }
  }

  let finalRecipients = recipients;
  if (status === 'attivo' && (!finalRecipients || (Array.isArray(finalRecipients) && finalRecipients.length === 0))) {
    if (req.user?.email) {
      finalRecipients = [req.user.email];
    }
  }

  const result = await queryOne<ReportConfigRow>(
    `INSERT INTO report_configurations
       (company_id, report_id, owner_user_id, store_id, day, time, recipients, sections, status,
        thresholds, max_pages, max_rows_per_section, retention_count, updated_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, 1), COALESCE($6, '07:00'),
             COALESCE($7::jsonb, '[]'::jsonb), COALESCE($8::jsonb, '[]'::jsonb), COALESCE($9, 'attivo'),
             COALESCE($10::jsonb, '{}'::jsonb), COALESCE($11, 12), COALESCE($12, 20), COALESCE($13, 24),
             CURRENT_TIMESTAMP)
     ON CONFLICT (company_id, report_id, COALESCE(owner_user_id, 0))
     DO UPDATE SET
       store_id = COALESCE($4, report_configurations.store_id),
       day = COALESCE($5, report_configurations.day),
       time = COALESCE($6, report_configurations.time),
       recipients = COALESCE($7::jsonb, report_configurations.recipients),
       sections = COALESCE($8::jsonb, report_configurations.sections),
       status = COALESCE($9, report_configurations.status),
       thresholds = COALESCE($10::jsonb, report_configurations.thresholds),
       max_pages = COALESCE($11, report_configurations.max_pages),
       max_rows_per_section = COALESCE($12, report_configurations.max_rows_per_section),
       retention_count = COALESCE($13, report_configurations.retention_count),
       updated_at = CURRENT_TIMESTAMP
     RETURNING ${CONFIG_COLUMNS}`,
    [
      targetCompanyId,
      reportId,
      ownerUserId,
      storeId,
      day !== undefined ? day : null,
      time || null,
      finalRecipients ? JSON.stringify(finalRecipients) : null,
      sections ? JSON.stringify(sections) : null,
      status || null,
      thresholds ? JSON.stringify(thresholds) : null,
      maxPages ?? null,
      maxRowsPerSection ?? null,
      retentionCount ?? null,
    ],
  );

  if (!result) {
    badRequest(res, 'Impossibile salvare la configurazione del report.');
    return;
  }

  ok(res, mapConfigRow(result));
});

// POST /api/reports/configurations/:reportId/send-now
export const sendReportNow = asyncHandler(async (req: Request, res: Response) => {
  const explicit = req.body?.company_id ?? req.query?.company_id ?? req.params?.company_id;
  const targetCompanyId = explicit !== undefined ? parseInt(String(explicit), 10) : req.user!.companyId;

  if (!targetCompanyId) {
    notFound(res, 'Company not found');
    return;
  }

  const { reportId } = req.params;
  if (!canAccessReport(req.user?.role, reportId)) {
    forbidden(res, 'Non hai i permessi per questo report.');
    return;
  }

  const ownerUserId = req.body.owner_user_id ?? req.body.ownerUserId ?? (req.user?.role === 'hr' ? req.user.userId : null);

  let config = await queryOne<ReportConfigRow>(
    `SELECT ${CONFIG_COLUMNS} FROM report_configurations
      WHERE company_id = $1 AND report_id = $2
        AND COALESCE(owner_user_id, 0) = COALESCE($3::int, 0)`,
    [targetCompanyId, reportId, ownerUserId],
  );

  if (!config) {
    const def = getReportDefinition(reportId);
    if (!def) {
      notFound(res, 'Report non trovato');
      return;
    }
    config = {
      id: 0,
      company_id: targetCompanyId,
      report_id: reportId,
      owner_user_id: ownerUserId,
      status: 'attivo',
      day: def.defaultDay,
      time: def.defaultTime,
      recipients: JSON.stringify(req.user?.email ? [req.user.email] : []),
      sections: JSON.stringify(def.defaultSections),
      thresholds: {},
      max_pages: 12,
      max_rows_per_section: 20,
      retention_count: 24,
      run_count: 0,
      last_generated: null,
      period: 'weekly',
      custom_start: null,
      custom_end: null,
      store_id: req.user?.storeId ?? null,
      // Cast to the row type, not `any`: assigning `any` to a `T | null`
      // variable leaves it nullable, so every later `config.x` read errors.
    } as ReportConfigRow;
  }

  let parsedRecipients: string[] = [];
  try {
    parsedRecipients = typeof config.recipients === 'string' ? JSON.parse(config.recipients as string) : config.recipients;
  } catch {
    parsedRecipients = [];
  }

  if (!parsedRecipients || parsedRecipients.length === 0) {
    if (req.user?.email) {
      parsedRecipients = [req.user.email];
    } else {
      badRequest(res, 'Nessun destinatario configurato per l\'invio delle email.');
      return;
    }
  }

  let parsedSections: string[] = [];
  try {
    parsedSections = typeof config.sections === 'string' ? JSON.parse(config.sections as string) : config.sections;
  } catch {
    parsedSections = [];
  }

  const now = new Date();
  const pdfBuffer = await generateReport(targetCompanyId, {
    recipients: parsedRecipients,
    sections: parsedSections,
    reportId,
    storeId: config.store_id ?? null,
    thresholds: config.thresholds,
    maxPages: config.max_pages,
    maxRowsPerSection: config.max_rows_per_section,
  }, now);

  if (!pdfBuffer) {
    badRequest(res, 'Impossibile generare il report.');
    return;
  }

  await query(
    `UPDATE report_configurations
        SET run_count = run_count + 1,
            last_generated = CURRENT_TIMESTAMP,
            recipients = COALESCE($4::jsonb, recipients)
      WHERE company_id = $1 AND report_id = $2
        AND COALESCE(owner_user_id, 0) = COALESCE($3::int, 0)`,
    [targetCompanyId, reportId, ownerUserId, JSON.stringify(parsedRecipients)]
  );

  ok(res, { sentTo: parsedRecipients }, 'Report inviato con successo!');
});

// GET /api/reports/configurations/:reportId/download-last
export const downloadLastReport = asyncHandler(async (req: Request, res: Response) => {
  const explicit = req.body?.company_id ?? req.query?.company_id ?? req.params?.company_id;
  const targetCompanyId = explicit !== undefined ? parseInt(String(explicit), 10) : req.user!.companyId;

  if (!targetCompanyId) {
    notFound(res, 'Company not found');
    return;
  }

  const { reportId } = req.params;

  if (!canAccessReport(req.user?.role, reportId)) {
    forbidden(res, 'Non hai i permessi per questo report.');
    return;
  }

  const ownerUserId = req.query.owner_user_id ? parseInt(String(req.query.owner_user_id), 10) : null;

  // Secure owner scope for HR users
  if (req.user?.role === 'hr' && ownerUserId !== req.user.userId) {
    forbidden(res, 'Non hai i permessi per questo report.');
    return;
  }

  let config = await queryOne<any>(
    `SELECT day, time, sections, thresholds, max_pages, max_rows_per_section, store_id
     FROM report_configurations
     WHERE company_id = $1 AND report_id = $2
       AND COALESCE(owner_user_id, 0) = COALESCE($3::int, 0)`,
    [targetCompanyId, reportId, ownerUserId],
  );

  if (!config) {
    // Fall back to the registry rather than a hand-maintained switch statement.
    const definition = getReportDefinition(reportId);
    config = {
      day: definition?.defaultDay ?? 1,
      time: definition?.defaultTime ?? '07:00',
      sections: definition?.defaultSections ?? [],
      store_id: null,
    };
  }

  let parsedSections: string[] = [];
  try {
    parsedSections = typeof config.sections === 'string' ? JSON.parse(config.sections) : config.sections;
  } catch {
    parsedSections = [];
  }

  const now = new Date();
  const targetDay = config.day;
  const targetTimeStr = config.time || '07:00';
  const lastScheduledDate = getLastScheduledRunDate(reportId, targetDay, targetTimeStr, now);

  const pdfBuffer = await generateReport(targetCompanyId, {
    recipients: [], // Empty to skip email delivery
    sections: parsedSections,
    reportId,
    storeId: config.store_id ?? null,
    thresholds: config.thresholds,
    maxPages: config.max_pages,
    maxRowsPerSection: config.max_rows_per_section,
  }, lastScheduledDate);

  if (!pdfBuffer) {
    badRequest(res, 'Impossibile generare il PDF per la data selezionata.');
    return;
  }

  const filename = buildReportFilename(reportId, lastScheduledDate);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.send(pdfBuffer);
});

// GET /api/reports/history?limit=&offset=
// Previously this hardcoded LIMIT 10 with no offset, so the 11th archived report
// was unreachable rather than paginated. Now it returns a page plus the true total.
export const getReportHistory = asyncHandler(async (req: Request, res: Response) => {
  const explicit = req.body?.company_id ?? req.query?.company_id ?? req.params?.company_id;
  const targetCompanyId = explicit !== undefined ? parseInt(String(explicit), 10) : req.user!.companyId;

  if (!targetCompanyId) {
    notFound(res, 'Company not found');
    return;
  }

  const parsedLimit = parseInt(String(req.query.limit ?? '8'), 10);
  const parsedOffset = parseInt(String(req.query.offset ?? '0'), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 50) : 8;
  const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

  // Enforce the admin-only filter in SQL rather than trusting the client to hide rows.
  const hiddenReportIds = req.user?.role === 'hr' ? Array.from(ADMIN_ONLY_REPORT_IDS) : [];

  let scopeFilter = '';
  const queryParams: any[] = [targetCompanyId, hiddenReportIds, limit, offset];
  if (req.user?.role === 'hr') {
    scopeFilter = ` AND (owner_user_id = $5 OR store_id = $6)`;
    queryParams.push(req.user.userId, req.user.storeId ?? 0);
  }

  const rows = await query<{ id: number, report_id: string, generated_at: string, size_bytes: number, sections: any, target_date: string, total: string }>(
    `SELECT id, report_id, generated_at, size_bytes, sections, target_date,
            COUNT(*) OVER() AS total
     FROM generated_reports
     WHERE company_id = $1
       AND ($2::text[] = '{}' OR report_id <> ALL($2::text[]))
       ${scopeFilter}
     ORDER BY generated_at DESC
     LIMIT $3 OFFSET $4`,
    queryParams
  );

  const items = rows.map(r => ({
    id: r.id,
    reportId: r.report_id,
    generatedAt: r.generated_at,
    sizeBytes: r.size_bytes,
    sections: typeof r.sections === 'string' ? JSON.parse(r.sections) : r.sections,
    targetDate: r.target_date
  }));

  // COUNT(*) OVER() only comes back on returned rows; an empty page means zero total.
  const total = rows.length > 0 ? parseInt(rows[0].total, 10) : 0;

  ok(res, { items, total, limit, offset, hasMore: offset + items.length < total });
});

// DELETE /api/reports/history/:id
export const deleteArchivedReport = asyncHandler(async (req: Request, res: Response) => {
  const explicit = req.body?.company_id ?? req.query?.company_id ?? req.params?.company_id;
  const targetCompanyId = explicit !== undefined ? parseInt(String(explicit), 10) : req.user!.companyId;

  if (!targetCompanyId) {
    notFound(res, 'Company not found');
    return;
  }

  const { id } = req.params;

  const record = await queryOne<{ report_id: string; storage_path: string | null }>(
    `SELECT report_id, storage_path FROM generated_reports WHERE id = $1 AND company_id = $2`,
    [id, targetCompanyId]
  );

  if (!record) {
    notFound(res, 'Report non trovato nel registro dell\'archivio.');
    return;
  }

  if (!canAccessReport(req.user?.role, record.report_id)) {
    forbidden(res, 'Non hai i permessi per eliminare questo report.');
    return;
  }

  // Unlink first; a failure here must not orphan the row silently.
  const unlinked = await deleteGeneratedReportPdf(record.storage_path);
  if (!unlinked) {
    badRequest(res, 'Impossibile eliminare il file PDF archiviato.');
    return;
  }

  await query(`DELETE FROM generated_reports WHERE id = $1 AND company_id = $2`, [id, targetCompanyId]);
  ok(res, { id: Number(id) });
});

// DELETE /api/reports/history?olderThanDays=  (bulk purge)
export const purgeReportHistory = asyncHandler(async (req: Request, res: Response) => {
  const explicit = req.body?.company_id ?? req.query?.company_id ?? req.params?.company_id;
  const targetCompanyId = explicit !== undefined ? parseInt(String(explicit), 10) : req.user!.companyId;

  if (!targetCompanyId) {
    notFound(res, 'Company not found');
    return;
  }

  const parsedDays = parseInt(String(req.query.olderThanDays ?? ''), 10);
  if (!Number.isFinite(parsedDays) || parsedDays < 1) {
    badRequest(res, 'olderThanDays deve essere un numero maggiore di zero.');
    return;
  }

  const hiddenReportIds = req.user?.role === 'hr' ? Array.from(ADMIN_ONLY_REPORT_IDS) : [];

  const doomed = await query<{ id: number; storage_path: string | null }>(
    `SELECT id, storage_path FROM generated_reports
      WHERE company_id = $1
        AND generated_at < NOW() - ($2::int * INTERVAL '1 day')
        AND ($3::text[] = '{}' OR report_id <> ALL($3::text[]))`,
    [targetCompanyId, parsedDays, hiddenReportIds]
  );

  let deleted = 0;
  for (const row of doomed) {
    if (!(await deleteGeneratedReportPdf(row.storage_path))) continue;
    await query(`DELETE FROM generated_reports WHERE id = $1`, [row.id]);
    deleted += 1;
  }

  ok(res, { deleted, considered: doomed.length });
});

// GET /api/reports/configurations/:reportId/preview
// Powers the live structure preview in the Configure modal: what the PDF will
// contain, how many rows each section would hold, and the resulting page estimate.
export const previewReportStructure = asyncHandler(async (req: Request, res: Response) => {
  const explicit = req.body?.company_id ?? req.query?.company_id ?? req.params?.company_id;
  const targetCompanyId = explicit !== undefined ? parseInt(String(explicit), 10) : req.user!.companyId;

  if (!targetCompanyId) {
    notFound(res, 'Company not found');
    return;
  }

  const { reportId } = req.params;

  if (!canAccessReport(req.user?.role, reportId)) {
    forbidden(res, 'Non hai i permessi per questo report.');
    return;
  }

  const ownerUserId = req.query.owner_user_id ? parseInt(String(req.query.owner_user_id), 10) : null;

  // Secure owner scope for HR users
  if (req.user?.role === 'hr' && ownerUserId !== req.user.userId) {
    forbidden(res, 'Non hai i permessi per questo report.');
    return;
  }

  const config = await queryOne<{ thresholds: any; max_rows_per_section: number; store_id: number | null }>(
    `SELECT thresholds, max_rows_per_section, store_id
       FROM report_configurations
      WHERE company_id = $1 AND report_id = $2
        AND COALESCE(owner_user_id, 0) = COALESCE($3::int, 0)`,
    [targetCompanyId, reportId, ownerUserId]
  );

  const thresholds = resolveThresholds(config?.thresholds);
  const maxRows = config?.max_rows_per_section ?? 20;

  // Sample the exact window the report covers, so the numbers are real.
  const definition = getReportDefinition(reportId);
  const now = new Date();
  const end = new Date(now);
  end.setDate(now.getDate() - 1);
  const start = new Date(now);
  start.setDate(now.getDate() - (definition?.windowDays ?? 7));

  const scope = { companyId: targetCompanyId, storeId: config?.store_id ?? null };
  const period = { start, end };

  const [current, prior] = await Promise.all([
    snapshotPeriod(scope, period, thresholds),
    snapshotPeriod(scope, previousPeriod(period), thresholds),
  ]);

  const completion = completionRate(current);

  ok(res, {
    reportId,
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
    maxRowsPerSection: maxRows,
    // The headline numbers the report will lead with, so the modal can show the
    // user what this report is actually going to tell them.
    highlights: {
      scheduledShifts: current.scheduledShifts,
      completedShifts: current.completedShifts,
      completionRate: Number(completion.toFixed(1)),
      anomalies: current.anomalies,
      previousAnomalies: prior.anomalies,
      pendingLeave: current.pendingLeave,
      headcount: current.headcount,
    },
  });
});

// GET /api/reports/owners
// One row per report owner: the company Admin, then each HR user with their store.
// Drives the grouped dashboard layout.
export const getReportOwners = asyncHandler(async (req: Request, res: Response) => {
  const explicit = req.body?.company_id ?? req.query?.company_id ?? req.params?.company_id;
  const targetCompanyId = explicit !== undefined ? parseInt(String(explicit), 10) : req.user!.companyId;

  if (!targetCompanyId) {
    notFound(res, 'Company not found');
    return;
  }

  const company = await queryOne<{ name: string }>('SELECT name FROM companies WHERE id = $1', [targetCompanyId]);

  const users = await query<{
    id: number; name: string; surname: string; role: string;
    avatar_filename: string | null; store_id: number | null; store_name: string | null;
  }>(
    `SELECT u.id, u.name, u.surname, u.role, u.avatar_filename,
            u.store_id, st.name AS store_name
       FROM users u
       LEFT JOIN stores st ON st.id = u.store_id
      WHERE u.company_id = $1
        AND u.role IN ('admin', 'hr')
        AND u.status = 'active'
      ORDER BY (u.role = 'admin') DESC, st.name NULLS FIRST, u.surname, u.name`,
    [targetCompanyId]
  );

  // An HR user only ever sees their own row.
  const visible = req.user?.role === 'hr'
    ? users.filter(u => u.role === 'hr' && u.id === req.user!.userId)
    : users;

  const owners = visible.map(u => {
    const role = u.role as OwnerRole;
    return {
      userId: u.id,
      name: `${u.name} ${u.surname ?? ''}`.trim(),
      role,
      avatarFilename: u.avatar_filename,
      storeId: u.store_id,
      // The Admin is scoped to the company; HR to their store (or all stores if unassigned).
      scopeLabel: role === 'admin'
        ? (company?.name ?? 'Azienda')
        : (u.store_name ?? 'Tutte le sedi'),
      reports: reportsForRole(role).map(d => ({
        reportId: d.id,
        cadence: d.cadence,
        defaultStatus: d.defaultStatus,
      })),
    };
  });

  ok(res, owners);
});

// GET /api/reports/history/:id/download
export const downloadArchivedReport = asyncHandler(async (req: Request, res: Response) => {
  const explicit = req.body?.company_id ?? req.query?.company_id ?? req.params?.company_id;
  const targetCompanyId = explicit !== undefined ? parseInt(String(explicit), 10) : req.user!.companyId;

  if (!targetCompanyId) {
    notFound(res, 'Company not found');
    return;
  }

  const { id } = req.params;

  const record = await queryOne<{ company_id: number; report_id: string; sections: string[] | string; target_date: Date | string; storage_path: string | null; store_id: number | null; owner_user_id: number | null }>(
    `SELECT company_id, report_id, sections, target_date, storage_path, store_id, owner_user_id
     FROM generated_reports
     WHERE id = $1 AND company_id = $2`,
    [id, targetCompanyId]
  );

  if (!record) {
    notFound(res, 'Report non trovato nel registro dell\'archivio.');
    return;
  }

  // The frontend hides admin_monthly from HR users, but that is presentation only —
  // without this check an HR user could fetch the PDF by guessing an archive id.
  if (!canAccessReport(req.user?.role, record.report_id)) {
    forbidden(res, 'Non hai i permessi per questo report.');
    return;
  }

  // Secure store/owner scope for HR users
  if (req.user?.role === 'hr') {
    if (record.owner_user_id !== req.user.userId && record.store_id !== req.user.storeId) {
      forbidden(res, 'Non hai i permessi per scaricare questo report.');
      return;
    }
  }

  const targetDate = new Date(record.target_date);
  const filename = buildReportFilename(record.report_id, targetDate);

  if (record.storage_path) {
    const archivedPdf = await readGeneratedReportPdf(record.storage_path);
    if (archivedPdf) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.send(archivedPdf);
      return;
    }
  }

  let parsedSections: string[] = [];
  try {
    parsedSections = typeof record.sections === 'string' ? JSON.parse(record.sections) : record.sections;
  } catch {
    parsedSections = [];
  }

  // Regenerated from the archive row when the stored PDF is missing; the store
  // scope is carried on the row so the reproduction matches the original.
  const pdfBuffer = await generateReport(
    record.company_id,
    {
      recipients: [], // Empty to skip email delivery
      sections: parsedSections,
      reportId: record.report_id,
      storeId: record.store_id ?? null,
    },
    new Date(record.target_date),
  );

  if (!pdfBuffer) {
    badRequest(res, 'Impossibile rigenerare il PDF dall\'archivio.');
    return;
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.send(pdfBuffer);
});
