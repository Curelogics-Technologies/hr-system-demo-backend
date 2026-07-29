/**
 * End-to-end check of document auto-assignment against the real local database.
 *
 * Mirrors the 26-file payslip archive the client tested with, including the
 * cases that were assigned to the wrong person. Every EXPECT below is the
 * behaviour the client asked for: auto-assign only on an exact match of both
 * first name and surname, otherwise leave it for the operator.
 *
 *   npx ts-node src/scripts/verifyDocumentMatching.ts
 */
import dotenv from 'dotenv';
import { pool } from '../config/database';
import { matchEmployeeByFilename, MatchableEmployee, MatchOutcome } from '../modules/documents/employeeMatcher';
import { isSupportedDocumentFile } from '../modules/documents/documentFileTypes';

dotenv.config();

const FUSARO_COMPANY_ID = 1;

type Expectation = {
  file: string;
  expect: MatchOutcome | 'skipped';
  /** "Name Surname" we expect to be picked, when expect === 'assigned'. */
  who?: string;
  note: string;
};

const ARCHIVE: Expectation[] = [
  // --- The five the client reported as mis-assigned. -----------------------
  // These employees DO exist locally now, so the correct holder must win.
  { file: 'DE FALCO_VERONICA_40.pdf', expect: 'assigned', who: 'Veronica De Falco', note: 'multi-word surname; must not go to Veronica Baldesi' },
  { file: 'MULLONI_GIOVANNA_13.pdf', expect: 'assigned', who: 'Giovanna Mulloni', note: 'must not go to Anna Conti ("anna" inside "Giovanna")' },
  { file: 'PISCOPO_ROSA_18.pdf', expect: 'assigned', who: 'Rosa Piscopo', note: 'must not go to Francesco Piscopo' },
  { file: 'PERCOPE_FRANCESCO_15.pdf', expect: 'assigned', who: 'Francesco Percopé', note: 'accented surname; must not go to Francesco Piscopo' },
  { file: 'BAIANO_FRANCESCA_33.pdf', expect: 'assigned', who: 'Francesca Baiano', note: 'must not go to Francesca Murè' },

  // --- The prefix collision the client flagged as "worth checking". --------
  { file: 'PERROTTA_PASQUALINA_32.pdf', expect: 'assigned', who: 'Pasqualina Perrotta', note: 'must not go to Pasqua Perrotta (prefix)' },
  { file: 'PERROTTA_PASQUA_31.pdf', expect: 'assigned', who: 'Pasqua Perrotta', note: 'the shorter name gets its own document' },

  // --- Employees NOT in the system. This is the exact condition that caused
  // the client's five wrong assignments: the real holder is absent, and the old
  // matcher handed the file to whoever shared one field. Must stay unassigned.
  { file: 'CONTI_GIOVANNI_51.pdf', expect: 'unmatched', note: 'unknown holder; "Conti" alone must not match Anna Conti' },
  { file: 'PISCOPO_ANTONIETTA_52.pdf', expect: 'unmatched', note: 'unknown holder; surname-only must not match' },
  { file: 'ESPOSITO_VERONICA_53.pdf', expect: 'unmatched', note: 'unknown holder; first-name-only must not match' },
  { file: 'MURE_GIUSEPPINA_54.pdf', expect: 'unmatched', note: 'unknown holder; surname-only must not match Francesca Murè' },
  { file: 'BALDESI_FRANCESCO_55.pdf', expect: 'unmatched', note: 'unknown holder; neither field pair exists' },

  // --- Genuine ambiguity: two different people, same full name. ------------
  { file: 'BIANCO_MARCO.pdf', expect: 'unmatched', note: 'two Marco Bianco in MILANO STYLE, but not in FUSARO -> other company' },

  // --- Cross-company homonym. Rosa Piscopo also exists in ROSSO CORSA. -----
  // Scoped to FUSARO, the FUSARO one must win rather than being ambiguous.
  { file: 'PISCOPO_ROSA_CEDOLINO_GIUGNO.pdf', expect: 'assigned', who: 'Rosa Piscopo', note: 'extra words tolerated; company scope resolves the homonym' },

  // --- Ordinary, correct payslips. ----------------------------------------
  { file: 'ESPOSITO_GENNARO_21.pdf', expect: 'assigned', who: 'Gennaro Esposito', note: 'plain SURNAME_NAME' },
  { file: "DELL'AVERSANO_CARMELA_22.pdf", expect: 'assigned', who: "Carmela Dell'Aversano", note: 'apostrophe surname' },
  { file: 'DELL AVERSANO_CARMELA_22b.pdf', expect: 'assigned', who: "Carmela Dell'Aversano", note: 'same surname written with a space' },
  { file: 'DI PALMA_ANTONIO_23.pdf', expect: 'assigned', who: 'Antonio Di Palma', note: 'two-word surname' },
  { file: 'SORRENTINO_MARIA_24.pdf', expect: 'assigned', who: 'Maria Sorrentino', note: 'plain' },
  { file: 'IMPROTA_CIRO_25.pdf', expect: 'assigned', who: 'Ciro Improta', note: 'plain' },
  { file: 'CACCIAPUOTI_ASSUNTA_26.pdf', expect: 'assigned', who: 'Assunta Cacciapuoti', note: 'plain' },
  { file: 'COPPOLA_SALVATORE_27.pdf', expect: 'assigned', who: 'Salvatore Coppola', note: 'plain' },
  { file: 'SEPE_RITA_28.pdf', expect: 'assigned', who: 'Rita Sepe', note: 'plain' },
  { file: 'RITA_SEPE_29.pdf', expect: 'assigned', who: 'Rita Sepe', note: 'reversed NAME_SURNAME order' },
  { file: 'sepearita.pdf', expect: 'unmatched', note: 'typo in a no-separator name: must not fuzzy-match' },

  // --- Not documents at all. ----------------------------------------------
  { file: '2643_CEDOLINO.xml', expect: 'skipped', note: 'payroll data file, must be skipped and reported' },
  { file: '000123.pdf', expect: 'unmatched', note: 'no alphabetic content; matches nobody' },
];

async function main() {
  const { rows: employees } = await pool.query<MatchableEmployee>(
    `SELECT id, name, surname, unique_id, company_id
       FROM users
      WHERE (status = 'active' OR status IS NULL)
        AND role NOT IN ('admin', 'store_terminal', 'system_admin')`,
  );

  console.log(`Candidate pool: ${employees.length} employees`);
  console.log(`Archive: ${ARCHIVE.length} entries, scoped to company ${FUSARO_COMPANY_ID}\n`);

  let pass = 0;
  const failures: string[] = [];
  const counts: Record<string, number> = { assigned: 0, ambiguous: 0, unmatched: 0, skipped: 0 };

  for (const entry of ARCHIVE) {
    let actual: MatchOutcome | 'skipped';
    let who = '';

    if (!isSupportedDocumentFile(entry.file)) {
      actual = 'skipped';
    } else {
      const result = matchEmployeeByFilename(entry.file, employees, { companyId: FUSARO_COMPANY_ID });
      actual = result.outcome;
      if (result.employee) who = `${result.employee.name} ${result.employee.surname}`;
    }

    counts[actual]++;

    const outcomeOk = actual === entry.expect;
    const whoOk = entry.expect !== 'assigned' || who === entry.who;
    const good = outcomeOk && whoOk;
    if (good) pass++;
    else failures.push(`${entry.file}: expected ${entry.expect}${entry.who ? ` -> ${entry.who}` : ''}, got ${actual}${who ? ` -> ${who}` : ''}`);

    const mark = good ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${entry.file.padEnd(34)} ${actual.padEnd(10)} ${who.padEnd(24)} ${entry.note}`);
  }

  console.log(`\nOutcomes: assigned ${counts.assigned}, ambiguous ${counts.ambiguous}, unmatched ${counts.unmatched}, skipped ${counts.skipped}`);
  console.log(`Result: ${pass}/${ARCHIVE.length} expectations met`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }

  await pool.end();
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
