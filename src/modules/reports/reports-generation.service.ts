/**
 * Report generation, rebuilt as a management report rather than a data export.
 *
 * Every report has the same anatomy:
 *   1. Cover + executive summary - KPI cards, each with a delta vs the previous period
 *   2. Needs attention           - only threshold breaches, worst first
 *   3. Trends                    - sparklines over the trailing periods
 *   4. Breakdowns                - aggregated by store and by person, not raw rows
 *   5. Appendix                  - capped detail tables, pointing back into the platform
 *
 * Reports are scoped: an Admin report covers the whole company, an HR report covers
 * that HR user's store. Length is bounded by maxRowsPerSection and maxPages, so a
 * report stays roughly constant as stores and employees grow.
 *
 * The original row-dump implementation is preserved verbatim alongside this file as
 * reports-generation.service.legacy.bak (the repo has no commits yet).
 */

import { query, queryOne } from '../../config/database';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { sendEmailForCompany } from '../../services/email.service';
import {
  createDocContext,
  drawCoverHeader,
  drawSectionHeader,
  drawKpiGrid,
  drawExceptions,
  drawTrendStrip,
  drawCappedTable,
  drawStatusTable,
  finalizeFooters,
  DocContext,
} from './reports-pdf.kit';
import {
  Period,
  ReportScope,
  previousPeriod,
  snapshotPeriod,
  computeAnomalies,
  buildKpiCards,
  buildExceptions,
  buildTrends,
  buildStoreBreakdown,
  buildPeopleBreakdown,
  completionRate,
  AnomalyRecord,
  StoreBreakdownRow,
} from './reports-metrics.service';
import { resolveThresholds, ReportThresholds } from './reports-thresholds';
import { getReportDefinition } from './reports-registry';

export interface ReportRunConfig {
  recipients: string[];
  sections: string[];
  reportId?: string;
  /** Restricts the report to one store. Null/undefined = whole company. */
  storeId?: number | null;
  thresholds?: unknown;
  maxPages?: number;
  maxRowsPerSection?: number;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function itDate(value: string | Date): string {
  return new Date(value).toLocaleDateString('it-IT');
}

function presentation(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getUTCFullYear()}`;
}

/**
 * The window a report covers, taken from the registry. The cadence is part of the
 * report's identity ("Weekly HR Report" covers a week), so it is not configurable.
 */
function resolvePeriod(reportId: string, generationDate: Date): Period {
  const days = getReportDefinition(reportId)?.windowDays ?? 7;
  const end = new Date(generationDate);
  end.setDate(generationDate.getDate() - 1);
  const start = new Date(generationDate);
  start.setDate(generationDate.getDate() - days);
  return { start, end };
}

/** Section keys are canonical now; legacy Italian/English labels still resolve. */
const SECTION_ALIASES = {
  attendance: ['attendance', 'riepilogo presenze', 'registro presenze'],
  anomalies: ['anomalies', 'anomalie rilevate'],
  shifts: ['shifts', 'turni confermati', 'shift coverage', 'copertura turni'],
  leave: ['leave', 'richieste ferie', 'leave requests', 'ferie & permessi'],
  onboarding: ['onboarding', 'onboarding in corso', 'onboarding in process'],
  trainings: ['trainings', 'scadenze formazioni', 'training deadlines'],
  medical: ['medical', 'scadenze visite mediche', 'medical deadlines'],
  contracts: ['contracts', 'contratti in scadenza', 'contract deadlines'],
  workforce: ['workforce', 'variazioni organico', 'employees', 'turnover mensile'],
  ats: ['ats', 'position', 'received candidates', 'hired candidates', 'rejected candidates'],
} as const;

function wants(sections: string[], key: keyof typeof SECTION_ALIASES): boolean {
  const normalized = sections.map(s => s.toLowerCase().trim());
  return SECTION_ALIASES[key].some(alias => normalized.includes(alias));
}

const overflow = (shown: number, total: number) =>
  `Mostrati ${shown} di ${total}. Il dettaglio completo e' disponibile nella piattaforma.`;

const EMPTY = 'Nessun dato rilevato in questo periodo.';

// ---------------------------------------------------------------------------
// Aggregated sections. These replaced the raw per-event row dumps.
// ---------------------------------------------------------------------------

function sectionStoreBreakdown(ctx: DocContext, rows: StoreBreakdownRow[], index: number, maxRows: number) {
  if (!drawSectionHeader(ctx, index, 'Performance per sede')) return;
  drawStatusTable(ctx, {
    rows, maxRows, emptyLabel: EMPTY, overflowLabel: overflow,
    columns: [
      { header: 'Sede', width: 165, value: r => r.storeName },
      { header: 'Pianificati', width: 80, value: r => String(r.scheduled) },
      { header: 'Completati', width: 80, value: r => String(r.completed) },
      { header: 'Anomalie', width: 75, value: r => String(r.anomalies) },
      { header: 'Completamento', width: 95, bold: true, value: r => `${r.completionPct.toFixed(0)}%` },
    ],
  });
}

function sectionPeopleBreakdown(ctx: DocContext, anomalies: AnomalyRecord[], index: number, maxRows: number) {
  if (!drawSectionHeader(ctx, index, 'Collaboratori da seguire')) return;
  const rows = buildPeopleBreakdown(anomalies).map(r => ({
    ...r,
    // Three or more anomalies in one period is worth a conversation.
    status: (r.total >= 5 ? 'red' : r.total >= 3 ? 'amber' : 'green') as 'red' | 'amber' | 'green',
  }));

  drawStatusTable(ctx, {
    rows, maxRows,
    emptyLabel: 'Nessuna anomalia attribuita a collaboratori in questo periodo.',
    overflowLabel: overflow,
    columns: [
      { header: 'Collaboratore', width: 155, value: r => r.userName },
      { header: 'Sede', width: 120, value: r => r.storeName },
      { header: 'Assenze', width: 60, value: r => String(r.noShows) },
      { header: 'Ritardi', width: 60, value: r => String(r.late) },
      { header: 'Uscite ant.', width: 65, value: r => String(r.earlyExit) },
      { header: 'Totale', width: 45, bold: true, value: r => String(r.total) },
    ],
  });
}

async function sectionLeave(ctx: DocContext, scope: ReportScope, period: Period, index: number, maxRows: number) {
  if (!drawSectionHeader(ctx, index, 'Ferie e permessi')) return;
  const rows = await query<{ leave_type: string; status: string; total: string; people: string }>(
    `SELECT lr.leave_type, lr.status, COUNT(*) AS total, COUNT(DISTINCT lr.user_id) AS people
       FROM leave_requests lr
      WHERE lr.company_id = $1
        AND ($4::int IS NULL OR lr.store_id = $4)
        AND lr.start_date <= $3 AND lr.end_date >= $2
      GROUP BY lr.leave_type, lr.status
      ORDER BY (lr.status = 'pending') DESC, COUNT(*) DESC`,
    [scope.companyId, iso(period.start), iso(period.end), scope.storeId ?? null],
  );

  const decorated = rows.map(r => ({
    ...r,
    status: (r.status === 'pending' ? 'amber' : 'green') as 'amber' | 'green',
  }));

  drawStatusTable(ctx, {
    rows: decorated, maxRows, emptyLabel: EMPTY, overflowLabel: overflow,
    columns: [
      { header: 'Tipo', width: 150, value: r => (r.leave_type === 'sick' ? 'Malattia' : 'Ferie') },
      { header: 'Stato', width: 180, value: r => r.status },
      { header: 'Richieste', width: 85, bold: true, value: r => r.total },
      { header: 'Collaboratori', width: 80, value: r => r.people },
    ],
  });
}

async function sectionWorkforce(ctx: DocContext, scope: ReportScope, period: Period, index: number, maxRows: number) {
  if (!drawSectionHeader(ctx, index, 'Variazioni organico')) return;
  const rows = await query<{ name: string; surname: string; kind: string; effective_date: string }>(
    `SELECT name, surname, 'Assunzione' AS kind, hire_date AS effective_date
       FROM users
      WHERE company_id = $1 AND ($4::int IS NULL OR store_id = $4)
        AND hire_date BETWEEN $2 AND $3
     UNION ALL
     SELECT name, surname, 'Cessazione' AS kind, termination_date AS effective_date
       FROM users
      WHERE company_id = $1 AND ($4::int IS NULL OR store_id = $4)
        AND termination_date BETWEEN $2 AND $3
     ORDER BY effective_date DESC`,
    [scope.companyId, iso(period.start), iso(period.end), scope.storeId ?? null],
  );

  drawCappedTable(ctx, {
    rows, maxRows, emptyLabel: 'Nessuna variazione di organico nel periodo.', overflowLabel: overflow,
    columns: [
      { header: 'Collaboratore', width: 230, value: r => `${r.name ?? ''} ${r.surname ?? ''}`.trim() },
      { header: 'Evento', width: 130, value: r => r.kind, bold: true },
      { header: 'Data', width: 135, value: r => itDate(r.effective_date) },
    ],
  });
}

async function sectionContracts(ctx: DocContext, scope: ReportScope, thresholds: ReportThresholds, index: number, maxRows: number) {
  if (!drawSectionHeader(ctx, index, 'Contratti in scadenza')) return;
  const rows = await query<{ name: string; surname: string; contract_end_date: string; days_left: number }>(
    `SELECT name, surname, contract_end_date, (contract_end_date - CURRENT_DATE) AS days_left
       FROM users
      WHERE company_id = $1 AND termination_date IS NULL
        AND ($3::int IS NULL OR store_id = $3)
        AND contract_end_date IS NOT NULL
        AND contract_end_date >= CURRENT_DATE
        AND contract_end_date <= CURRENT_DATE + $2::int
      ORDER BY contract_end_date ASC`,
    [scope.companyId, thresholds.contractExpiryAmber, scope.storeId ?? null],
  );

  const decorated = rows.map(r => ({
    ...r,
    status: (Number(r.days_left) <= thresholds.contractExpiryRed ? 'red' : 'amber') as 'red' | 'amber',
  }));

  drawStatusTable(ctx, {
    rows: decorated, maxRows, emptyLabel: 'Nessun contratto in scadenza a breve.', overflowLabel: overflow,
    columns: [
      { header: 'Collaboratore', width: 220, value: r => `${r.name ?? ''} ${r.surname ?? ''}`.trim() },
      { header: 'Scadenza', width: 140, value: r => itDate(r.contract_end_date) },
      { header: 'Giorni rimanenti', width: 125, bold: true, value: r => String(r.days_left) },
    ],
  });
}

async function sectionCompliance(
  ctx: DocContext, scope: ReportScope, thresholds: ReportThresholds,
  index: number, maxRows: number, kind: 'trainings' | 'medical',
) {
  const title = kind === 'trainings' ? 'Scadenze formazione' : 'Scadenze visite mediche';
  if (!drawSectionHeader(ctx, index, title)) return;

  const sql = kind === 'trainings'
    ? `SELECT u.name, u.surname, et.training_type AS detail, et.end_date
         FROM employee_trainings et JOIN users u ON u.id = et.user_id
        WHERE et.company_id = $1 AND ($3::int IS NULL OR u.store_id = $3)
          AND et.end_date IS NOT NULL AND et.end_date <= CURRENT_DATE + $2::int
        ORDER BY et.end_date ASC`
    : `SELECT u.name, u.surname, '' AS detail, emc.end_date
         FROM employee_medical_checks emc JOIN users u ON u.id = emc.user_id
        WHERE emc.company_id = $1 AND ($3::int IS NULL OR u.store_id = $3)
          AND emc.end_date IS NOT NULL AND emc.end_date <= CURRENT_DATE + $2::int
        ORDER BY emc.end_date ASC`;

  const rows = await query<{ name: string; surname: string; detail: string; end_date: string }>(
    sql, [scope.companyId, thresholds.complianceExpiryAmber, scope.storeId ?? null],
  );

  const labels: Record<string, string> = {
    product: 'Prodotto', general: 'Generale',
    low_risk_safety: 'Sicurezza (basso rischio)', fire_safety: 'Antincendio',
  };

  drawCappedTable(ctx, {
    rows, maxRows,
    emptyLabel: kind === 'trainings' ? 'Nessuna scadenza formativa imminente.' : 'Nessuna visita medica in scadenza.',
    overflowLabel: overflow,
    columns: kind === 'trainings'
      ? [
          { header: 'Collaboratore', width: 200, value: r => `${r.name ?? ''} ${r.surname ?? ''}`.trim() },
          { header: 'Tipologia corso', width: 180, value: r => labels[r.detail] ?? r.detail },
          { header: 'Scadenza', width: 115, value: r => itDate(r.end_date), bold: true },
        ]
      : [
          { header: 'Collaboratore', width: 280, value: r => `${r.name ?? ''} ${r.surname ?? ''}`.trim() },
          { header: 'Scadenza', width: 215, value: r => itDate(r.end_date), bold: true },
        ],
  });
}

async function sectionOnboarding(ctx: DocContext, scope: ReportScope, index: number, maxRows: number) {
  if (!drawSectionHeader(ctx, index, 'Onboarding in corso')) return;
  const rows = await query<{ name: string; surname: string; total: string; done: string }>(
    `SELECT u.name, u.surname, COUNT(t.id) AS total, COUNT(t.id) FILTER (WHERE t.completed) AS done
       FROM users u
       JOIN employee_onboarding_tasks t ON t.employee_id = u.id
      WHERE u.company_id = $1 AND u.role = 'employee' AND u.status = 'active'
        AND ($2::int IS NULL OR u.store_id = $2)
      GROUP BY u.id, u.name, u.surname
     HAVING COUNT(t.id) > COUNT(t.id) FILTER (WHERE t.completed)
      ORDER BY u.surname, u.name`,
    [scope.companyId, scope.storeId ?? null],
  );

  drawCappedTable(ctx, {
    rows, maxRows, emptyLabel: 'Nessun onboarding in corso.', overflowLabel: overflow,
    columns: [
      { header: 'Collaboratore', width: 240, value: r => `${r.name ?? ''} ${r.surname ?? ''}`.trim() },
      { header: 'Completati', width: 120, value: r => `${r.done} / ${r.total}` },
      {
        header: 'Avanzamento', width: 135, bold: true, value: r => {
          const total = Number(r.total);
          return total === 0 ? '-' : `${((Number(r.done) / total) * 100).toFixed(0)}%`;
        },
      },
    ],
  });
}

async function sectionAts(ctx: DocContext, scope: ReportScope, thresholds: ReportThresholds, index: number, maxRows: number) {
  if (!drawSectionHeader(ctx, index, 'Pipeline selezione (ATS)')) return;
  // `pipeline_status` is the ATS stage; `status` is reserved by drawStatusTable for RAG.
  const rows = await query<{ pipeline_status: string; total: string; stalled: string }>(
    `SELECT status AS pipeline_status, COUNT(*) AS total,
            COUNT(*) FILTER (WHERE last_stage_change < NOW() - ($2::int * INTERVAL '1 day')) AS stalled
       FROM candidates
      WHERE company_id = $1 AND ($3::int IS NULL OR store_id = $3)
      GROUP BY status
      ORDER BY COUNT(*) DESC`,
    [scope.companyId, thresholds.candidateStallAmber, scope.storeId ?? null],
  );

  const stageLabels: Record<string, string> = {
    received: 'Ricevuti', review: 'In valutazione', interview: 'Colloquio',
    hired: 'Assunti', rejected: 'Rifiutati',
  };

  const decorated = rows.map(r => ({
    ...r,
    status: (Number(r.stalled) > 0 ? 'amber' : 'green') as 'amber' | 'green',
  }));

  drawStatusTable(ctx, {
    rows: decorated, maxRows, emptyLabel: 'Nessun candidato in pipeline.', overflowLabel: overflow,
    columns: [
      { header: 'Stato pipeline', width: 210, value: r => stageLabels[r.pipeline_status] ?? r.pipeline_status },
      { header: 'Candidati', width: 140, value: r => r.total },
      { header: `Fermi da ${thresholds.candidateStallAmber}+ gg`, width: 135, bold: true, value: r => r.stalled },
    ],
  });
}

async function sectionAttendance(ctx: DocContext, scope: ReportScope, period: Period, index: number, maxRows: number) {
  if (!drawSectionHeader(ctx, index, 'Presenze per collaboratore')) return;
  const rows = await query<{ name: string; surname: string; days: string; events: string }>(
    `SELECT u.name, u.surname,
            COUNT(DISTINCT ae.event_time::DATE) AS days,
            COUNT(*) AS events
       FROM attendance_events ae
       JOIN users u ON u.id = ae.user_id
      WHERE ae.company_id = $1 AND ae.event_time::DATE BETWEEN $2 AND $3
        AND ($4::int IS NULL OR ae.store_id = $4)
      GROUP BY u.id, u.name, u.surname
      ORDER BY COUNT(DISTINCT ae.event_time::DATE) DESC`,
    [scope.companyId, iso(period.start), iso(period.end), scope.storeId ?? null],
  );

  drawCappedTable(ctx, {
    rows, maxRows, emptyLabel: EMPTY, overflowLabel: overflow,
    columns: [
      { header: 'Collaboratore', width: 250, value: r => `${r.name ?? ''} ${r.surname ?? ''}`.trim() },
      { header: 'Giorni presenti', width: 130, value: r => r.days, bold: true },
      { header: 'Timbrature', width: 115, value: r => r.events },
    ],
  });
}

// ---------------------------------------------------------------------------
// Core renderer
// ---------------------------------------------------------------------------

const TITLES: Record<string, string> = {
  admin_monthly: 'Report Direzionale Mensile',
  admin_weekly: 'Report Direzionale Settimanale',
  hr_monthly: 'Report HR Mensile',
  hr_weekly: 'Report HR Settimanale',
  anomaly_daily: 'Avviso ATS Giornaliero',
};

async function resolveScopeLabel(scope: ReportScope): Promise<string> {
  if (!scope.storeId) return 'Ambito: tutte le sedi';
  const row = await queryOne<{ name: string }>('SELECT name FROM stores WHERE id = $1', [scope.storeId]);
  return `Ambito: ${row?.name ?? 'sede'}`;
}

async function renderReport(
  scope: ReportScope,
  companyName: string,
  reportId: string,
  config: ReportRunConfig,
  period: Period,
): Promise<Buffer> {
  const thresholds = resolveThresholds(config.thresholds);
  const maxRows = config.maxRowsPerSection ?? 20;
  const maxPages = config.maxPages ?? 12;
  const title = TITLES[reportId] ?? 'Report HR';

  const doc = await PDFDocument.create();
  const ctx = await createDocContext(doc, {
    font: await doc.embedFont(StandardFonts.Helvetica),
    fontBold: await doc.embedFont(StandardFonts.HelveticaBold),
    fontItalic: await doc.embedFont(StandardFonts.HelveticaOblique),
  }, { maxPages, title, companyName });

  const prior = previousPeriod(period);
  const definition = getReportDefinition(reportId);
  // Only claim a comparison the branch below actually performs. The daily alert
  // computes `prior` for nothing, so promising one on the cover was misleading.
  const comparesPeriods = definition?.comparesPeriods ?? reportId !== 'anomaly_daily';

  drawCoverHeader(ctx, {
    title,
    companyName,
    scopeLabel: await resolveScopeLabel(scope),
    periodLabel: `Periodo: ${presentation(period.start)} - ${presentation(period.end)}`,
    comparisonLabel: comparesPeriods
      ? `Confronto con: ${presentation(prior.start)} - ${presentation(prior.end)}`
      : undefined,
    alert: reportId === 'anomaly_daily',
  });

  if (reportId === 'anomaly_daily') {
    let index = 1;
    const step = () => index++;

    // 'anomalies' and 'shifts' were offered in the configure dialog but had no
    // branch here, so selecting them silently produced an empty PDF.
    const needsAnomalies = wants(config.sections, 'anomalies') || wants(config.sections, 'shifts');
    const anomalies = needsAnomalies ? await computeAnomalies(scope, period, thresholds) : [];

    if (wants(config.sections, 'anomalies')) sectionPeopleBreakdown(ctx, anomalies, step(), maxRows);
    if (wants(config.sections, 'shifts')) {
      const breakdown = await buildStoreBreakdown(scope, period, thresholds, anomalies);
      sectionStoreBreakdown(ctx, breakdown, step(), maxRows);
    }
    if (wants(config.sections, 'ats')) await sectionAts(ctx, scope, thresholds, step(), maxRows);
    if (wants(config.sections, 'leave')) await sectionLeave(ctx, scope, period, step(), maxRows);
    if (wants(config.sections, 'attendance')) await sectionAttendance(ctx, scope, period, step(), maxRows);
    if (wants(config.sections, 'workforce')) await sectionWorkforce(ctx, scope, period, step(), maxRows);
    if (wants(config.sections, 'onboarding')) await sectionOnboarding(ctx, scope, step(), maxRows);
    if (wants(config.sections, 'contracts')) await sectionContracts(ctx, scope, thresholds, step(), maxRows);
    if (wants(config.sections, 'trainings')) await sectionCompliance(ctx, scope, thresholds, step(), maxRows, 'trainings');
    if (wants(config.sections, 'medical')) await sectionCompliance(ctx, scope, thresholds, step(), maxRows, 'medical');
  } else {
    const [current, previous, anomalies] = await Promise.all([
      snapshotPeriod(scope, period, thresholds),
      snapshotPeriod(scope, prior, thresholds),
      computeAnomalies(scope, period, thresholds),
    ]);

    const storeBreakdown = await buildStoreBreakdown(scope, period, thresholds, anomalies);

    // 1. Executive summary. The reader should be able to stop here and still know
    //    whether anything needs their attention.
    drawSectionHeader(ctx, 1, 'Sintesi direzionale');
    drawKpiGrid(ctx, buildKpiCards(current, previous, thresholds));

    // 2. Needs attention. An empty list is itself a meaningful result.
    drawSectionHeader(ctx, 2, 'Richiede attenzione');
    drawExceptions(
      ctx,
      await buildExceptions(scope, period, thresholds, anomalies, storeBreakdown),
      'Nessuna criticita rilevata in questo periodo.',
    );

    // 3. Trends.
    drawSectionHeader(ctx, 3, 'Andamento');
    drawTrendStrip(ctx, await buildTrends(scope, period, thresholds));

    let index = 4;
    const step = () => index++;

    // 4. Breakdowns. Per-store only makes sense when the report spans stores.
    if (!scope.storeId && storeBreakdown.length > 1) {
      sectionStoreBreakdown(ctx, storeBreakdown, step(), maxRows);
    }
    if (wants(config.sections, 'anomalies')) sectionPeopleBreakdown(ctx, anomalies, step(), maxRows);

    // 5. Configured detail sections.
    if (wants(config.sections, 'shifts') && scope.storeId) sectionStoreBreakdown(ctx, storeBreakdown, step(), maxRows);
    if (wants(config.sections, 'leave')) await sectionLeave(ctx, scope, period, step(), maxRows);
    if (wants(config.sections, 'attendance')) await sectionAttendance(ctx, scope, period, step(), maxRows);
    if (wants(config.sections, 'workforce')) await sectionWorkforce(ctx, scope, period, step(), maxRows);
    if (wants(config.sections, 'onboarding')) await sectionOnboarding(ctx, scope, step(), maxRows);
    if (wants(config.sections, 'contracts')) await sectionContracts(ctx, scope, thresholds, step(), maxRows);
    if (wants(config.sections, 'trainings')) await sectionCompliance(ctx, scope, thresholds, step(), maxRows, 'trainings');
    if (wants(config.sections, 'medical')) await sectionCompliance(ctx, scope, thresholds, step(), maxRows, 'medical');
    if (wants(config.sections, 'ats')) await sectionAts(ctx, scope, thresholds, step(), maxRows);
  }

  finalizeFooters(ctx, {
    generatedLabel: `${companyName} - generato il ${new Date().toLocaleDateString('it-IT')}`,
    truncatedLabel: `Report troncato al limite di ${maxPages} pagine. Il dettaglio completo e' disponibile nella piattaforma.`,
  });

  return Buffer.from(await doc.save());
}

async function dispatchEmails(
  companyId: number, companyName: string, recipients: string[],
  subject: string, filename: string, pdfBuffer: Buffer,
  period: Period, current: { completion: number },
): Promise<void> {
  try {
    let failed = 0;
    for (const recipient of recipients) {
      if (!recipient || !recipient.trim().includes('@')) continue;
      const result = await sendEmailForCompany(companyId, {
        to: recipient.trim(),
        subject,
        html: `<p>Gentile utente,</p>
               <p>In allegato il <strong>${subject}</strong> per <strong>${companyName}</strong>.</p>
               <p>Periodo: <strong>${itDate(period.start)}</strong> - <strong>${itDate(period.end)}</strong>.<br>
                  Tasso di completamento turni: <strong>${current.completion.toFixed(1)}%</strong>.</p>
               <p>La prima pagina riporta i KPI principali con le variazioni rispetto al periodo precedente, seguita dalle criticita da gestire. Il dettaglio completo resta consultabile nella piattaforma.</p>
               <p>Cordiali saluti,<br><em>HR Automation Bot</em></p>`,
        attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
      });
      if (!result.ok && result.status === 'failed') failed += 1;
    }
    if (failed > 0) console.warn(`[REPORTS-GEN] ${failed} email delivery attempt(s) failed for company ${companyId}.`);
  } catch (err) {
    console.error('[REPORTS-GEN] Email dispatch failed, but the PDF was generated:', err);
  }
}

async function getCompanyName(companyId: number): Promise<string> {
  const row = await queryOne<{ name: string }>('SELECT name FROM companies WHERE id = $1', [companyId]);
  return row?.name ?? 'Azienda';
}

/**
 * Generates one report. Signature preserved so the scheduler and controller call
 * sites are unchanged; `storeId` on the config scopes it to a single store.
 */
export async function generateReport(
  companyId: number,
  config: ReportRunConfig,
  generationDate: Date = new Date(),
): Promise<Buffer | null> {
  try {
    const reportId = config.reportId ?? 'hr_weekly';
    const scope: ReportScope = { companyId, storeId: config.storeId ?? null };
    const period = resolvePeriod(reportId, generationDate);
    const companyName = await getCompanyName(companyId);

    console.log(`[REPORTS-GEN] ${reportId} company=${companyId} store=${scope.storeId ?? 'all'} range=[${iso(period.start)}..${iso(period.end)}]`);

    const pdfBuffer = await renderReport(scope, companyName, reportId, config, period);

    if (config.recipients.length > 0) {
      const snapshot = await snapshotPeriod(scope, period, resolveThresholds(config.thresholds));
      await dispatchEmails(
        companyId, companyName, config.recipients,
        `[Automated] ${TITLES[reportId] ?? 'Report HR'} - ${companyName}`,
        `${reportId}-${iso(period.start)}-${iso(period.end)}.pdf`,
        pdfBuffer, period, { completion: completionRate(snapshot) },
      );
    }

    return pdfBuffer;
  } catch (err) {
    console.error('[REPORTS-GEN] Generation failed:', err);
    return null;
  }
}

/** @deprecated Use generateReport. Kept so existing call sites keep compiling. */
export const generateAndSendWeeklyReport = generateReport;

/** @deprecated Use generateReport with reportId: 'admin_monthly'. */
export async function generateAndSendMonthlyAdminReport(
  companyId: number,
  config: ReportRunConfig,
  generationDate: Date = new Date(),
): Promise<Buffer | null> {
  return generateReport(companyId, { ...config, reportId: config.reportId ?? 'admin_monthly' }, generationDate);
}
