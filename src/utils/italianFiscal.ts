// ---------------------------------------------------------------------------
// Italian e-invoicing field validators (Partita IVA / Codice Destinatario / PEC)
//
// All three company fields are optional: existing records predate them and must
// keep saving untouched. These helpers therefore only ever run against a value
// the user actually typed — an empty or missing value is never rejected here.
// ---------------------------------------------------------------------------

/**
 * Partita IVA: 11 digits with a Luhn-style check digit.
 * Accepts an optional `IT` country prefix and internal spacing/dots, which is
 * how it is usually copied off letterheads.
 */
export function normalizePartitaIva(value: string): string {
  return value.replace(/[\s.\-]/g, '').replace(/^IT/i, '').toUpperCase();
}

export function isValidPartitaIva(value: string): boolean {
  const piva = normalizePartitaIva(value);
  if (!/^\d{11}$/.test(piva)) return false;

  let total = 0;
  for (let i = 0; i < 10; i += 1) {
    const digit = piva.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      total += digit;
    } else {
      const doubled = digit * 2;
      total += doubled > 9 ? doubled - 9 : doubled;
    }
  }

  const checkDigit = (10 - (total % 10)) % 10;
  return checkDigit === piva.charCodeAt(10) - 48;
}

/**
 * Codice Destinatario SDI: 7 alphanumeric characters for private companies,
 * 6 for the Pubblica Amministrazione. `0000000` is the documented placeholder
 * meaning "this recipient is invoiced via PEC instead", so it must stay valid.
 */
export function normalizeSdiCode(value: string): string {
  return value.replace(/\s/g, '').toUpperCase();
}

export function isValidSdiCode(value: string): boolean {
  return /^[A-Z0-9]{6,7}$/.test(normalizeSdiCode(value));
}

/**
 * PEC is an ordinary mailbox on a certified domain — there is no syntactic
 * marker distinguishing it from normal email, so validate shape only and let
 * the operator own the domain choice.
 */
export function normalizePecEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidPecEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizePecEmail(value));
}
