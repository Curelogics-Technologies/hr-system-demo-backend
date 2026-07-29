/**
 * Filename -> employee matching for document auto-assignment.
 *
 * Design rule, agreed with the client after payslips were assigned to the wrong
 * people: a document is auto-assigned ONLY on an unambiguous match of BOTH the
 * first name and the surname. Anything less stays unassigned and is offered to
 * the operator as a suggestion. Ten documents to assign by hand is far
 * preferable to one assigned to the wrong person.
 *
 * What the previous implementation got wrong, and what is deliberately gone:
 *   - `filename.includes(firstName)` auto-assigned MULLONI_GIOVANNA_13.pdf to
 *     "Anna Conti", because "anna" is a substring of "Giovanna".
 *   - `filename.includes(surname + name)` auto-assigned Pasqualina Perrotta's
 *     payslip to "Pasqua Perrotta", because "perrottapasqua" is a prefix of
 *     "perrottapasqualina". This scored in a "full name" tier, so it looked
 *     like a high-confidence match.
 *   - A single-field match (surname only, or first name only) auto-assigned
 *     whenever exactly one employee happened to match.
 *   - `filename.includes(unique_id)` matched an employee whose id was "13"
 *     against any filename containing "13" - including payslip sequence numbers.
 *   - Company was a +10 score bonus, so a wrong-company match in a strong tier
 *     beat a right-company match in a weaker one. It is now a hard filter.
 *
 * Comparisons are always between WHOLE tokens or fully-consumed strings, never
 * substrings.
 */

export interface MatchableEmployee {
  id: number;
  name: string | null;
  surname: string | null;
  unique_id?: string | null;
  company_id: number | null;
}

export type MatchOutcome =
  /** Exactly one employee matched on both names (and company, if scoped). */
  | 'assigned'
  /** Several employees matched equally well - a human must choose. */
  | 'ambiguous'
  /** Nothing matched well enough to be safe. */
  | 'unmatched';

export type MatchReason =
  | 'exact_full_name'
  | 'exact_full_name_concatenated'
  | 'unique_id'
  | 'duplicate_full_name'
  | 'other_company'
  | 'surname_only'
  | 'first_name_only'
  | 'no_candidate'
  | 'not_a_name';

export interface MatchCandidate {
  employee: MatchableEmployee;
  reason: MatchReason;
  /** True when this candidate alone would have been safe to auto-assign. */
  strong: boolean;
}

export interface MatchResult {
  outcome: MatchOutcome;
  /** Populated only when outcome === 'assigned'. */
  employee: MatchableEmployee | null;
  /** Why we did what we did. Drives the operator-facing explanation. */
  reason: MatchReason;
  /** Ranked suggestions for the manual assignment step. Never auto-applied. */
  candidates: MatchCandidate[];
}

export interface MatchOptions {
  /**
   * When set, only employees of this company may be auto-assigned. Employees
   * elsewhere are still surfaced as suggestions, flagged `other_company`.
   */
  companyId?: number | null;
  /** Minimum length before a unique_id is trusted, to avoid "13"-style collisions. */
  minUniqueIdLength?: number;
}

const DEFAULT_MIN_UNIQUE_ID_LENGTH = 4;

/** Lowercase, strip accents and apostrophes. Keeps separators intact. */
function normalize(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .toLowerCase()
    .trim();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function alphaOnly(value: string): string {
  return normalize(value).replace(/[^a-z0-9]/g, '');
}

/**
 * Payroll exports commonly append a sequence number: MULLONI_GIOVANNA_13.pdf.
 * Those digits are not part of anybody's name, and leaving them in is what let
 * a numeric unique_id hijack the match.
 */
function stripTrailingSequence(tokens: string[]): string[] {
  const out = [...tokens];
  while (out.length > 1 && /^\d+$/.test(out[out.length - 1])) out.pop();
  return out;
}

/**
 * A person's name may be written as one token or several: "Dell'Aversano" vs
 * "Dell Aversano", "De Falco" vs "DeFalco". Accept either spelling by matching
 * against both the split tokens and the joined form.
 */
/**
 * Every whole token in the filename, plus two safe normalisations:
 *
 *  - a trailing digit run stripped ("stefano34" also counts as "stefano"),
 *    because payroll exports glue a sequence number onto the name itself;
 *  - contiguous runs of tokens joined ("de" + "luca" also counts as "deluca"),
 *    because the same surname is filed as "De Luca", "DeLuca" or "DELL'AVERSANO"
 *    depending on who produced the archive.
 *
 * Both only ever ADD whole-token candidates - no substring of a token is ever
 * produced, so "pasqua" still cannot match "pasqualina".
 */
function expandFileTokens(fileTokens: string[]): Set<string> {
  const expanded = new Set<string>();

  const add = (value: string) => { if (value.length >= 2) expanded.add(value); };

  for (const token of fileTokens) {
    add(token);
    const withoutTrailingDigits = token.replace(/\d+$/, '');
    if (withoutTrailingDigits !== token) add(withoutTrailingDigits);
  }

  // Joined windows, but ONLY where the window starts with a short name particle
  // - "de luca", "di palma", "dell aversano", "van der berg", "lo russo".
  // Joining arbitrary adjacent tokens would let two unrelated names in a
  // filename fuse into a third person's name, so the window must begin with a
  // particle of at most 4 characters. That is exactly how split surnames are
  // written and nothing else.
  const MAX_PARTICLE_LENGTH = 4;
  const MAX_WINDOW = 3;
  for (let i = 0; i < fileTokens.length; i++) {
    if (fileTokens[i].length > MAX_PARTICLE_LENGTH || /\d/.test(fileTokens[i])) continue;
    for (let size = 2; size <= MAX_WINDOW && i + size <= fileTokens.length; size++) {
      add(fileTokens.slice(i, i + size).join(''));
    }
  }

  return expanded;
}

function consumesTokens(expandedTokens: Set<string>, nameParts: string[]): boolean {
  if (nameParts.length === 0) return false;

  const joined = nameParts.join('');
  if (joined.length < 2) return false;

  // Written without separators, or reachable by joining adjacent tokens.
  if (expandedTokens.has(joined)) return true;

  // Or every part present as its own whole token: "de" + "falco".
  if (nameParts.every(part => expandedTokens.has(part))) return true;

  // If the stored name contains multiple tokens (e.g. "MARIO GIUSEPPE" or "DE SANCTIS"),
  // match if any significant part (3+ chars) is present in the filename tokens.
  const significantParts = nameParts.filter(p => p.length >= 3);
  if (significantParts.length > 0 && significantParts.some(part => expandedTokens.has(part))) {
    return true;
  }

  return false;
}

/**
 * Split a stored person name into its parts. An apostrophe is a word boundary
 * here - "Dell'Aversano" is filed as DELL'AVERSANO, DELLAVERSANO or
 * DELL AVERSANO depending on who exported the archive, and all three have to
 * resolve to the same person.
 */
function nameParts(value: string | null): string[] {
  return (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function matchEmployeeByFilename(
  filename: string,
  employees: MatchableEmployee[],
  options: MatchOptions = {},
): MatchResult {
  const minUniqueIdLength = options.minUniqueIdLength ?? DEFAULT_MIN_UNIQUE_ID_LENGTH;
  const scopedCompanyId = options.companyId ?? null;

  const stem = filename.replace(/\.[^.]+$/i, '');
  const rawTokens = tokenize(stem);
  const fileTokens = stripTrailingSequence(rawTokens);
  // Alphabetic signature of the filename, sequence number removed.
  const fileAlpha = fileTokens.join('');
  const expandedTokens = expandFileTokens(fileTokens);

  // A filename with no alphabetic content cannot name a person.
  if (!fileTokens.some(t => /[a-z]/.test(t))) {
    return { outcome: 'unmatched', employee: null, reason: 'not_a_name', candidates: [] };
  }

  const strong: MatchCandidate[] = [];
  const weak: MatchCandidate[] = [];

  for (const emp of employees) {
    const first = nameParts(emp.name);
    const last = nameParts(emp.surname);
    if (first.length === 0 || last.length === 0) continue;

    const firstAlpha = first.join('');
    const lastAlpha = last.join('');

    // --- Strong tier 1: unique_id as a WHOLE token, never a substring. ---
    const uid = alphaOnly(emp.unique_id || '');
    if (uid.length >= minUniqueIdLength && (expandedTokens.has(uid) || rawTokens.join('') === uid || fileAlpha === uid)) {
      strong.push({ employee: emp, reason: 'unique_id', strong: true });
      continue;
    }

    // --- Strong tier 2: both names present as whole tokens. ---
    // Extra words in the filename are tolerated ("ROSSI_MARIO_CEDOLINO.pdf"),
    // but a partial word is not: "pasqualina" never satisfies "pasqua".
    if (consumesTokens(expandedTokens, first) && consumesTokens(expandedTokens, last)) {
      strong.push({ employee: emp, reason: 'exact_full_name', strong: true });
      continue;
    }

    // --- Strong tier 3: written with no separator at all ("rossimario.pdf").
    // Equality, NOT includes() - that is what let a name match a longer name
    // it happened to prefix.
    if (fileAlpha === firstAlpha + lastAlpha || fileAlpha === lastAlpha + firstAlpha) {
      strong.push({ employee: emp, reason: 'exact_full_name_concatenated', strong: true });
      continue;
    }

    // --- Weak: one field only. Suggestion material, never auto-assigned. ---
    const firstMatches = consumesTokens(expandedTokens, first);
    const lastMatches = consumesTokens(expandedTokens, last);
    if (lastMatches) {
      weak.push({ employee: emp, reason: 'surname_only', strong: false });
    } else if (firstMatches) {
      weak.push({ employee: emp, reason: 'first_name_only', strong: false });
    }
  }

  // Company is a hard gate for auto-assignment, not a tie-breaker bonus.
  const inScope = (c: MatchCandidate) =>
    scopedCompanyId == null || c.employee.company_id === scopedCompanyId;

  const strongInScope = strong.filter(inScope);
  const strongOutOfScope = strong
    .filter(c => !inScope(c))
    .map(c => ({ ...c, reason: 'other_company' as MatchReason, strong: false }));

  const suggestions: MatchCandidate[] = [...strongInScope, ...strongOutOfScope, ...weak.filter(inScope), ...weak.filter(c => !inScope(c))];

  if (strongInScope.length === 1) {
    return {
      outcome: 'assigned',
      employee: strongInScope[0].employee,
      reason: strongInScope[0].reason,
      candidates: suggestions,
    };
  }

  if (strongInScope.length > 1) {
    // Two real people with the same name, or the same person duplicated.
    // Either way a human has to decide.
    return { outcome: 'ambiguous', employee: null, reason: 'duplicate_full_name', candidates: suggestions };
  }

  if (strongOutOfScope.length > 0) {
    return { outcome: 'unmatched', employee: null, reason: 'other_company', candidates: suggestions };
  }

  if (suggestions.length > 0) {
    return { outcome: 'unmatched', employee: null, reason: suggestions[0].reason, candidates: suggestions };
  }

  return { outcome: 'unmatched', employee: null, reason: 'no_candidate', candidates: [] };
}
