/**
 * Diagnostic: run the real matcher over an arbitrary list of filenames, both
 * scoped to one company and unscoped, and print what each one resolves to.
 * Used to reproduce what an operator sees in the upload wizard.
 *
 *   npx ts-node src/scripts/checkZipBatch.ts [companyId]
 */
import dotenv from 'dotenv';
import { pool } from '../config/database';
import { matchEmployeeByFilename, MatchableEmployee } from '../modules/documents/employeeMatcher';

dotenv.config();

const SCOPED_COMPANY = Number(process.argv[2] ?? 1);

const FILES = [
  '_Barbieri_Matteo_09.pdf',
  '_Stefano_Bianchi_Invoice.pdf',
  '29-07-2026_Francesco_Bruno.pdf',
  'Antonio_Marino_Invoice_July2026.pdf',
  'AURORA_.GALLO.pdf',
  'Aurora-Bianchi-CV.pdf',
  'COSTA__Francesca_0921.pdf',
  'COSTA_Stefano34.pdf',
  'ELENA_ROSSI.pdf',
  'EmmaRomano.pdf',
  'GALLO_ALICE_V1.pdf',
  'Giulia De Luca.pdf',
  'Giulia Greco.pdf',
  'Giulia_Barbieri_67.pdf',
  'Lorenzo&Rossi.pdf',
  'Lorenzo.Fontana_Report.pdf',
  'marco_lombardi-resume.pdf',
  'mattiaLombardi.pdf',
  'Roberto.Barbieri.pdf',
];

async function main() {
  const { rows: employees } = await pool.query<MatchableEmployee>(
    `SELECT id, name, surname, unique_id, company_id
       FROM users
      WHERE (status = 'active' OR status IS NULL)
        AND role NOT IN ('admin', 'store_terminal', 'system_admin')`,
  );
  const { rows: companies } = await pool.query<{ id: number; name: string }>(`SELECT id, name FROM companies`);
  const companyName = (id: number | null) => companies.find(c => c.id === id)?.name ?? '—';

  console.log(`Pool: ${employees.length} employees. Scoped company: ${SCOPED_COMPANY} (${companyName(SCOPED_COMPANY)})\n`);
  console.log('FILE'.padEnd(38), 'SCOPED'.padEnd(11), 'GLOBAL'.padEnd(11), 'WHO / WHERE');
  console.log('-'.repeat(110));

  const perCompany = new Map<number, number>();
  let scopedAssigned = 0;

  for (const file of FILES) {
    const scoped = matchEmployeeByFilename(file, employees, { companyId: SCOPED_COMPANY });
    const global = matchEmployeeByFilename(file, employees, { companyId: null });

    if (scoped.outcome === 'assigned') scopedAssigned++;

    let who = '';
    if (global.employee) {
      who = `${global.employee.name} ${global.employee.surname} @ ${companyName(global.employee.company_id)}`;
      if (global.employee.company_id != null) {
        perCompany.set(global.employee.company_id, (perCompany.get(global.employee.company_id) ?? 0) + 1);
      }
    } else if (global.candidates.length > 0) {
      who = `candidates: ` + global.candidates.slice(0, 3)
        .map(c => `${c.employee.name} ${c.employee.surname}[${c.reason}]@${companyName(c.employee.company_id)}`)
        .join(', ');
    } else {
      who = '(nothing)';
    }

    console.log(file.padEnd(38), scoped.outcome.padEnd(11), global.outcome.padEnd(11), who);
  }

  console.log('\n--- Summary ---');
  console.log(`Scoped to company ${SCOPED_COMPANY}: ${scopedAssigned}/${FILES.length} auto-assigned`);
  console.log('Unscoped, matched employees belong to:');
  for (const [companyId, count] of Array.from(perCompany.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${companyName(companyId).padEnd(24)} ${count}`);
  }

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
