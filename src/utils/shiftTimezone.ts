export const DEFAULT_SHIFT_TIMEZONE = process.env.DEFAULT_SHIFT_TIMEZONE || 'Europe/Rome';

const DEFAULT_SHIFT_TIMEZONE_SQL = DEFAULT_SHIFT_TIMEZONE.replace(/'/g, "''");

const COUNTRY_TIMEZONE_FALLBACKS: Record<string, string[]> = {
  IT: ['Europe/Rome'],
  GB: ['Europe/London'],
  IE: ['Europe/Dublin'],
  ES: ['Europe/Madrid'],
  FR: ['Europe/Paris'],
  DE: ['Europe/Berlin'],
  NL: ['Europe/Amsterdam'],
  BE: ['Europe/Brussels'],
  PT: ['Europe/Lisbon'],
  US: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'],
  CA: ['America/Toronto', 'America/Vancouver'],
  BR: ['America/Sao_Paulo'],
  AE: ['Asia/Dubai'],
  SA: ['Asia/Riyadh'],
  IN: ['Asia/Kolkata'],
  CN: ['Asia/Shanghai'],
  JP: ['Asia/Tokyo'],
  SG: ['Asia/Singapore'],
  AU: ['Australia/Sydney', 'Australia/Perth'],
  NZ: ['Pacific/Auckland'],
};

export function isValidIanaTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Timezone safe to pass to Date#toLocaleString / Intl — never throws. Guards the
 * notification/email/PDF formatting path against a legacy or imported store row
 * that somehow holds an invalid timezone (new writes are already normalised).
 */
export function safeDisplayTimezone(tz: string | null | undefined, fallback: string = 'Europe/Rome'): string {
  if (typeof tz !== 'string') return fallback;
  const trimmed = tz.trim();
  if (!trimmed) return fallback;
  return isValidIanaTimezone(trimmed) ? trimmed : fallback;
}

export function normalizeShiftTimezone(raw: unknown, fallback: string = DEFAULT_SHIFT_TIMEZONE): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  return isValidIanaTimezone(trimmed) ? trimmed : fallback;
}

export function suggestTimezoneFromCountry(
  countryCode: unknown,
  fallback: string = DEFAULT_SHIFT_TIMEZONE,
): string {
  if (typeof countryCode !== 'string') return fallback;
  const code = countryCode.trim().toUpperCase();
  if (!code) return fallback;

  const suggestions = COUNTRY_TIMEZONE_FALLBACKS[code] ?? [];
  for (const timezone of suggestions) {
    if (isValidIanaTimezone(timezone)) {
      return timezone;
    }
  }

  return fallback;
}

export function shiftPointToUtcSql(
  dateExpression: string,
  timeExpression: string,
  timezoneExpression: string,
): string {
  return `(((${dateExpression})::timestamp + (${timeExpression})) AT TIME ZONE COALESCE(NULLIF(BTRIM(${timezoneExpression}), ''), '${DEFAULT_SHIFT_TIMEZONE_SQL}'))`;
}

export function coalescedShiftPointUtcSql(
  utcExpression: string,
  dateExpression: string,
  timeExpression: string,
  timezoneExpression: string,
): string {
  return `COALESCE(${utcExpression}, ${shiftPointToUtcSql(dateExpression, timeExpression, timezoneExpression)})`;
}
