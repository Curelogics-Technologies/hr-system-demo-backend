/**
 * Resolves a company's stored currency to an ISO 4217 code.
 *
 * The currency on a company is free text — someone can type "Euro", "Riyal" or
 * "Pakistani Rupee". Payment providers only accept the three-letter code, and
 * the billing tables store that code, so anything else has to be translated
 * before it reaches either. Sending a display name straight through produced a
 * database overflow on the way in, and would have produced an unhelpful
 * provider rejection even if the column had been wide enough.
 */

/** Currencies the platform can bill in, with the names people actually type. */
const ALIASES: Record<string, string> = {
  // Euro
  eur: 'EUR', euro: 'EUR', euros: 'EUR', 'euro (eur)': 'EUR', '€': 'EUR',
  // Pound sterling
  gbp: 'GBP', pound: 'GBP', pounds: 'GBP', sterling: 'GBP',
  'pound sterling': 'GBP', 'british pound': 'GBP', '£': 'GBP',
  // US dollar
  usd: 'USD', dollar: 'USD', dollars: 'USD', 'us dollar': 'USD',
  'usd ($)': 'USD', $: 'USD',
  // Swiss franc
  chf: 'CHF', franc: 'CHF', francs: 'CHF', 'swiss franc': 'CHF',
  // Saudi riyal
  sar: 'SAR', riyal: 'SAR', riyals: 'SAR', 'saudi riyal': 'SAR',
  // UAE dirham
  aed: 'AED', dirham: 'AED', 'uae dirham': 'AED',
  // Pakistani rupee
  pkr: 'PKR', 'pakistani rupee': 'PKR', 'pakistan rupee': 'PKR',
  // Indian rupee
  inr: 'INR', 'indian rupee': 'INR', rupee: 'INR', rupees: 'INR',
  // Others commonly configured
  sek: 'SEK', nok: 'NOK', dkk: 'DKK', pln: 'PLN', czk: 'CZK',
  cad: 'CAD', aud: 'AUD', jpy: 'JPY', try: 'TRY', ron: 'RON', huf: 'HUF',
};

export class UnsupportedCurrencyError extends Error {
  public readonly code = 'CURRENCY_NOT_SUPPORTED';
  public readonly statusCode = 400;

  constructor(public readonly given: string) {
    super(
      `"${given}" is not a recognised currency. Set the company currency to a ` +
        `three-letter code such as EUR, GBP or USD in the company's billing settings.`
    );
    this.name = 'UnsupportedCurrencyError';
  }
}

/**
 * Returns the ISO code for a stored currency value.
 * Throws when it cannot be resolved, rather than passing something the
 * provider will reject with a far less obvious message.
 */
export function resolveIsoCurrency(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (raw === '') return 'EUR';

  // Already a bare code.
  if (/^[A-Za-z]{3}$/.test(raw)) return raw.toUpperCase();

  const key = raw.toLowerCase();
  if (ALIASES[key]) return ALIASES[key];

  // "EUR (€)" / "Euro - EUR" and similar: take the first standalone 3-letter
  // run and accept it only if it is a code we know.
  const candidates = raw.toUpperCase().match(/\b[A-Z]{3}\b/g) ?? [];
  for (const c of candidates) {
    if (Object.values(ALIASES).includes(c)) return c;
  }

  throw new UnsupportedCurrencyError(raw);
}

/** True when the value resolves without throwing. */
export function isSupportedCurrency(value: string | null | undefined): boolean {
  try {
    resolveIsoCurrency(value);
    return true;
  } catch {
    return false;
  }
}
