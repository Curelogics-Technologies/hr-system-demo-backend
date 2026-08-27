/**
 * The catalogue of reports, and who owns each one.
 *
 * Reports are grouped by owner role rather than sitting in a flat list:
 *   Admin  -> company-wide monthly + weekly
 *   HR     -> store-scoped monthly + weekly + daily
 *
 * Weekly reports default to suspended. They are the noisiest cadence, and nobody
 * should be subscribed to a weekly email they never asked for.
 */

export type OwnerRole = 'admin' | 'hr';
export type ReportCadence = 'daily' | 'weekly' | 'monthly';

export interface ReportDefinition {
  id: string;
  ownerRole: OwnerRole;
  cadence: ReportCadence;
  /** Days of history the report covers. */
  windowDays: number;
  /** Reports scoped to a single store when the owner has one. */
  storeScoped: boolean;
  defaultStatus: 'attivo' | 'sospeso';
  defaultTime: string;
  /** ISO weekday (1 = Monday) for weekly, day-of-month for monthly. */
  defaultDay: number;
  defaultSections: string[];
  /**
   * Sections this report can actually render.
   *
   * The configure dialog used to build its checkbox list from the user's ROLE,
   * so it offered sections the generator had no branch for: ticking them saved
   * fine and produced nothing in the PDF, with no warning. The list of what a
   * report can draw belongs to the report, so it lives here and both the API
   * and the UI read it from one place.
   */
  supportedSections: string[];
  /**
   * Whether the generator actually computes the previous period and renders a
   * comparison. The cover prints "Confronto con: <period>" only when this is
   * true — it used to print unconditionally, promising a comparison that the
   * daily branch never performed.
   */
  comparesPeriods: boolean;
}

/** Everything the general (non-daily) generator branch knows how to draw. */
const FULL_SECTIONS = [
  'workforce', 'shifts', 'anomalies', 'leave', 'attendance',
  'onboarding', 'trainings', 'medical', 'contracts', 'ats',
];

export const REPORT_DEFINITIONS: ReportDefinition[] = [
  {
    id: 'admin_monthly',
    ownerRole: 'admin',
    cadence: 'monthly',
    windowDays: 30,
    storeScoped: false,
    defaultStatus: 'attivo',
    defaultTime: '07:00',
    defaultDay: 1,
    defaultSections: ['workforce', 'shifts', 'anomalies', 'leave', 'contracts', 'ats'],
    supportedSections: FULL_SECTIONS,
    comparesPeriods: true,
  },
  {
    id: 'admin_weekly',
    ownerRole: 'admin',
    cadence: 'weekly',
    windowDays: 7,
    storeScoped: false,
    defaultStatus: 'sospeso',
    defaultTime: '07:00',
    defaultDay: 1,
    defaultSections: ['shifts', 'anomalies', 'leave'],
    supportedSections: FULL_SECTIONS,
    comparesPeriods: true,
  },
  {
    id: 'hr_monthly',
    ownerRole: 'hr',
    cadence: 'monthly',
    windowDays: 30,
    storeScoped: true,
    defaultStatus: 'attivo',
    defaultTime: '08:00',
    defaultDay: 1,
    defaultSections: ['workforce', 'leave', 'trainings', 'medical', 'contracts'],
    supportedSections: FULL_SECTIONS,
    comparesPeriods: true,
  },
  {
    id: 'hr_weekly',
    ownerRole: 'hr',
    cadence: 'weekly',
    windowDays: 7,
    storeScoped: true,
    defaultStatus: 'sospeso',
    defaultTime: '07:00',
    defaultDay: 1,
    defaultSections: ['attendance', 'anomalies', 'shifts', 'leave', 'onboarding'],
    supportedSections: FULL_SECTIONS,
    comparesPeriods: true,
  },
  {
    id: 'anomaly_daily',
    ownerRole: 'hr',
    cadence: 'daily',
    windowDays: 1,
    storeScoped: true,
    defaultStatus: 'attivo',
    defaultTime: '08:00',
    defaultDay: 1,
    defaultSections: ['ats'],
    // The daily alert renders sections directly with no period comparison.
    supportedSections: [
      'anomalies', 'shifts', 'ats', 'leave', 'attendance',
      'workforce', 'onboarding', 'contracts', 'trainings', 'medical',
    ],
    comparesPeriods: false,
  },
];

const BY_ID = new Map(REPORT_DEFINITIONS.map(d => [d.id, d]));

export function getReportDefinition(reportId: string): ReportDefinition | undefined {
  return BY_ID.get(reportId);
}

export function reportsForRole(role: OwnerRole): ReportDefinition[] {
  return REPORT_DEFINITIONS.filter(d => d.ownerRole === role);
}

/** An HR user must never receive an admin-owned report. */
export function canRoleAccessReport(role: string | undefined, reportId: string): boolean {
  const definition = BY_ID.get(reportId);
  if (!definition) return true; // unknown/legacy ids are governed by route-level guards
  if (definition.ownerRole === 'admin') return role !== 'hr';
  return true;
}
