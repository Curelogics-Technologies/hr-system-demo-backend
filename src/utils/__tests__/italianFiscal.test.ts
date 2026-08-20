import {
  isValidPartitaIva,
  isValidPecEmail,
  isValidSdiCode,
  normalizePartitaIva,
  normalizePecEmail,
  normalizeSdiCode,
} from '../italianFiscal';

/**
 * Rules for the three Italian e-invoicing fields on a company.
 *
 * The important property these guard is that the fields stay *optional*: the
 * companies table holds live client records created before the fields existed,
 * and those rows must keep saving with the values blank. Validation therefore
 * only ever applies to a value someone actually typed — callers are expected to
 * skip these helpers for empty input, and nothing here treats "" as valid.
 */

describe('Partita IVA', () => {
  it('accepts a well-formed number with a correct check digit', () => {
    expect(isValidPartitaIva('12345678903')).toBe(true);
    expect(isValidPartitaIva('00743110157')).toBe(true);
  });

  it('tolerates how the number is copied off a letterhead', () => {
    expect(isValidPartitaIva('IT12345678903')).toBe(true);
    expect(isValidPartitaIva('it 12345678903')).toBe(true);
    expect(isValidPartitaIva('123.456.789-03')).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    expect(isValidPartitaIva('12345678901')).toBe(false);
  });

  it('rejects anything that is not 11 digits', () => {
    expect(isValidPartitaIva('1234567890')).toBe(false);
    expect(isValidPartitaIva('123456789031')).toBe(false);
    expect(isValidPartitaIva('ABCDEFGHIJK')).toBe(false);
    expect(isValidPartitaIva('')).toBe(false);
  });

  it('canonicalises to 11 bare digits for storage', () => {
    expect(normalizePartitaIva('IT 123.456.789-03')).toBe('12345678903');
  });
});

describe('Codice Destinatario SDI', () => {
  it('accepts the 0000000 placeholder', () => {
    // 0000000 is the documented value meaning "invoice this recipient by PEC".
    // Rejecting it would make every PEC-routed company unsaveable.
    expect(isValidSdiCode('0000000')).toBe(true);
  });

  it('accepts 7 characters for companies and 6 for public administration', () => {
    expect(isValidSdiCode('ABC1234')).toBe(true);
    expect(isValidSdiCode('UFXXXX')).toBe(true);
  });

  it('rejects wrong lengths and punctuation', () => {
    expect(isValidSdiCode('ABC12')).toBe(false);
    expect(isValidSdiCode('ABC12345')).toBe(false);
    expect(isValidSdiCode('ABC-123')).toBe(false);
    expect(isValidSdiCode('')).toBe(false);
  });

  it('upper-cases for storage', () => {
    expect(normalizeSdiCode(' abc1234 ')).toBe('ABC1234');
  });
});

describe('PEC address', () => {
  it('accepts an ordinary mailbox shape', () => {
    expect(isValidPecEmail('azienda@pec.it')).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(isValidPecEmail('not-an-email')).toBe(false);
    expect(isValidPecEmail('a@b')).toBe(false);
    expect(isValidPecEmail('')).toBe(false);
  });

  it('lower-cases for storage', () => {
    expect(normalizePecEmail('  Azienda@PEC.IT ')).toBe('azienda@pec.it');
  });
});
