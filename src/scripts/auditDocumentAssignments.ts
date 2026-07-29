/**
 * Finds documents whose current employee assignment the new matcher would NOT
 * make, and optionally reverts them to unassigned.
 *
 * This exists because of a live incident: payslips were auto-assigned to the
 * wrong employees and saved with signature required and broad visibility, so
 * people could see - and were being asked to sign - a colleague's salary
 * document. Reverting removes the document from the wrong person's personal
 * area and clears the pending signature request.
 *
 * Dry run (default, changes nothing):
 *   npx ts-node src/scripts/auditDocumentAssignments.ts
 * Apply:
 *   npx ts-node src/scripts/auditDocumentAssignments.ts --apply
 * Restrict to one company:
 *   npx ts-node src/scripts/auditDocumentAssignments.ts --company=1 --apply
 */
import dotenv from 'dotenv';
import { pool } from '../config/database';
import { matchEmployeeByFilename, MatchableEmployee } from '../modules/documents/employeeMatcher';

dotenv.config();

const apply = process.argv.includes('--apply');
const companyArg = process.argv.find(a => a.startsWith('--company='));
const companyFilter = companyArg ? Number(companyArg.split('=')[1]) : null;

interface AssignedDoc {
  id: number;
  title: string;
  company_id: number | null;
  employee_id: number;
  requires_signature: boolean | null;
  signed_at: Date | null;
  emp_name: string;
  emp_surname: string;
}

async function main() {
  const { rows: employees } = await pool.query<MatchableEmployee>(
    `SELECT id, name, surname, unique_id, company_id
       FROM users
      WHERE (status = 'active' OR status IS NULL)
        AND role NOT IN ('admin', 'store_terminal', 'system_admin')`,
  );

  const { rows: docs } = await pool.query<AssignedDoc>(
    `SELECT d.id, d.title, d.company_id, d.employee_id, d.requires_signature, d.signed_at,
            u.name AS emp_name, u.surname AS emp_surname
       FROM documents d
       JOIN users u ON u.id = d.employee_id
      WHERE d.employee_id IS NOT NULL
        AND d.is_deleted = false
        ${companyFilter ? 'AND d.company_id = $1' : ''}
      ORDER BY d.id`,
    companyFilter ? [companyFilter] : [],
  );

  console.log(`Auditing ${docs.length} assigned document(s) against the current matching rules.`);
  console.log(apply ? 'MODE: apply - mis-assignments will be reverted.\n' : 'MODE: dry run - nothing will be changed.\n');

  const suspect: AssignedDoc[] = [];

  for (const doc of docs) {
    const result = matchEmployeeByFilename(doc.title, employees, { companyId: doc.company_id });

    // The assignment stands if the matcher would independently reach the same
    // employee. Anything else may have been an operator's manual choice, so it
    // is reported rather than assumed wrong - except where the matcher is
    // confident about a DIFFERENT person, which is the failure we are hunting.
    const agrees = result.outcome === 'assigned' && result.employee?.id === doc.employee_id;
    if (agrees) continue;

    const wouldPickSomeoneElse = result.outcome === 'assigned' && result.employee?.id !== doc.employee_id;
    const flag = wouldPickSomeoneElse ? 'WRONG-PERSON' : 'UNVERIFIABLE';
    const alt = result.employee ? `${result.employee.name} ${result.employee.surname}` : '-';

    console.log(
      `[${flag}] doc ${String(doc.id).padEnd(6)} ${doc.title.padEnd(36)} ` +
      `currently: ${`${doc.emp_name} ${doc.emp_surname}`.padEnd(24)} matcher says: ${alt}` +
      (doc.signed_at ? '  (ALREADY SIGNED)' : ''),
    );

    // Never silently undo something a person has already signed - that needs a
    // human decision and probably a conversation with the employee.
    if (!doc.signed_at) suspect.push(doc);
  }

  console.log(`\n${suspect.length} document(s) would be reverted to unassigned.`);

  if (!apply) {
    console.log('Re-run with --apply to make the change.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const doc of suspect) {
      await client.query(
        `UPDATE documents
            SET employee_id = NULL, requires_signature = false, updated_at = NOW()
          WHERE id = $1`,
        [doc.id],
      );
      // Remove the copy that surfaced in the wrong employee's personal area.
      await client.query(
        `UPDATE employee_documents
            SET deleted_at = NOW(), is_deleted = true, updated_at = NOW()
          WHERE employee_id = $1
            AND file_name = $2
            AND deleted_at IS NULL
            AND signed_at IS NULL`,
        [doc.employee_id, doc.title],
      );
    }
    await client.query('COMMIT');
    console.log(`Reverted ${suspect.length} document(s).`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
