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

/**
 * The timezone a shift must be stored in: the one configured on the store it
 * belongs to, never the one the caller's browser happens to be set to.
 *
 * A shift is an instruction to be somewhere at a wall-clock time — "09:00 at
 * Varese". The only zone that can turn that into a real instant is the store's.
 * Sourcing it from the client meant a manager on a laptop set to America/Chicago
 * stored "09:00 Chicago" (14:00 UTC) for an Italian shop, and the clock-in gate
 * opened at 15:45 Italian time. Her own calendar converted it back to her own
 * zone, so it looked correct to the only person able to see it.
 *
 * Falls back to the default when the store row carries no timezone: `stores`
 * was backfilled by migration 051 and both store write paths normalise it, but
 * the column is still nullable and the seed script inserts without it.
 */
export async function resolveStoreTimezone(
  storeId: number | null | undefined,
  companyId: number | null | undefined,
  runQuery: (sql: string, params: unknown[]) => Promise<Array<{ timezone: string | null }>>,
  fallback: string = DEFAULT_SHIFT_TIMEZONE,
): Promise<string> {
  if (storeId == null || companyId == null) return fallback;
  const rows = await runQuery(
    `SELECT timezone FROM stores WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [storeId, companyId],
  );
  return normalizeShiftTimezone(rows[0]?.timezone, fallback);
}
