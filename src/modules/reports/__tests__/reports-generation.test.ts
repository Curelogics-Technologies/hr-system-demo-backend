import { generateReport } from '../reports-generation.service';
import { getReportDefinition, REPORT_DEFINITIONS } from '../reports-registry';
import { seedTestData, clearTestData, closeTestDb } from '../../../__tests__/helpers/db';

let seeds: Awaited<ReturnType<typeof seedTestData>>;

const GENERATED_ON = new Date('2026-03-15');

function runConfig(sections: string[]) {
  return {
    reportId: 'anomaly_daily',
    sections,
    recipients: [] as string[],
    thresholds: {},
    maxRowsPerSection: 20,
    maxPages: 12,
    storeId: null,
  } as never;
}

beforeAll(async () => { seeds = await seedTestData(); });
afterAll(async () => { await clearTestData(); await closeTestDb(); });

describe('report registry declares what each report can draw', () => {
  it('every report lists supported sections', () => {
    for (const d of REPORT_DEFINITIONS) {
      expect(Array.isArray(d.supportedSections)).toBe(true);
      expect(d.supportedSections.length).toBeGreaterThan(0);
    }
  });

  it('every default section is one the report can actually render', () => {
    // This is the invariant that was broken: the UI offered sections the
    // generator had no branch for.
    for (const d of REPORT_DEFINITIONS) {
      for (const s of d.defaultSections) {
        expect(d.supportedSections).toContain(s);
      }
    }
  });

  it('the daily alert declares that it performs no period comparison', () => {
    expect(getReportDefinition('anomaly_daily')?.comparesPeriods).toBe(false);
  });

  it('the periodic reports declare that they do', () => {
    for (const id of ['admin_monthly', 'admin_weekly', 'hr_monthly', 'hr_weekly']) {
      expect(getReportDefinition(id)?.comparesPeriods).toBe(true);
    }
  });
});

describe('anomaly_daily renders the sections it offers', () => {
  it('produces more than a bare cover page for the anomalies section', async () => {
    const withAnomalies = await generateReport(seeds.acmeId, runConfig(['anomalies']), GENERATED_ON);
    const withNothing = await generateReport(seeds.acmeId, runConfig([]), GENERATED_ON);

    expect(withAnomalies).not.toBeNull();
    expect(withNothing).not.toBeNull();
    // Before the fix these were byte-identical: the branch had no 'anomalies'
    // case, so ticking it changed nothing in the output.
    expect(withAnomalies!.length).toBeGreaterThan(withNothing!.length);
  });

  it('produces more than a bare cover page for the shifts section', async () => {
    const withShifts = await generateReport(seeds.acmeId, runConfig(['shifts']), GENERATED_ON);
    const withNothing = await generateReport(seeds.acmeId, runConfig([]), GENERATED_ON);

    expect(withShifts!.length).toBeGreaterThan(withNothing!.length);
  });
});
