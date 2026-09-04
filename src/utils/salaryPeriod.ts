/**
 * Single source of truth for job salary periods.
 *
 * `job_postings.salary_period` stores the English tokens written by the app,
 * but the DB check constraint also still permits legacy Italian phrases, so
 * every reader must accept both. Emitting the wrong period previously caused
 * Indeed to publish monthly salaries as annual ones.
 */

export type SalaryPeriod = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'annually';

const CANONICAL: Record<string, SalaryPeriod> = {
  hourly: 'hourly',
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
  yearly: 'yearly',
  annually: 'annually',
  // Legacy Italian values still allowed by job_postings_salary_period_chk
  "all'ora": 'hourly',
  'al giorno': 'daily',
  'a settimana': 'weekly',
  'al mese': 'monthly',
  'per anno': 'yearly',
};

/** Italian text that Indeed parses out of the free-text <salary> feed field. */
const IT_LABEL: Record<SalaryPeriod, string> = {
  hourly: "all'ora",
  daily: 'al giorno',
  weekly: 'a settimana',
  monthly: 'al mese',
  yearly: 'per anno',
  annually: 'per anno',
};

/** Maps any accepted input (English token or legacy Italian) to a stored token. */
export function canonicalizeSalaryPeriod(value: string | null | undefined): SalaryPeriod | null {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase().replace(/’/g, "'");
  return CANONICAL[normalized] ?? null;
}

/** Italian label for a stored period, or null when unset/unrecognised. */
export function salaryPeriodItalianLabel(value: string | null | undefined): string | null {
  const canonical = canonicalizeSalaryPeriod(value);
  return canonical ? IT_LABEL[canonical] : null;
}

/**
 * Plain digits, no thousands separator — this feeds Indeed's <salary> tag and
 * their spec only ever shows unseparated amounts ("$50000 per year"). An
 * it-IT grouped amount would read as "€1.000", which their parser can take for
 * one euro. Not using Intl also keeps the output identical on a Node build
 * without full ICU data.
 */
export function formatItalianAmount(value: number): string {
  return String(Math.round(value));
}

/**
 * Builds the human-readable salary string, e.g. "€1800 - €2400 al mese".
 * When the period is unset or unrecognised the amount is returned without a
 * period suffix — never guess, a wrong period is worse than none.
 */
export function buildSalaryText(
  min: number | null,
  max: number | null,
  periodRaw: string | null,
): string | null {
  if (min === null && max === null) return null;

  const period = salaryPeriodItalianLabel(periodRaw);
  const minText = min !== null ? `€${formatItalianAmount(min)}` : null;
  const maxText = max !== null ? `€${formatItalianAmount(max)}` : null;

  const amount = minText && maxText ? `${minText} - ${maxText}` : (minText ?? maxText);
  if (!amount) return null;

  return period ? `${amount} ${period}` : amount;
}
