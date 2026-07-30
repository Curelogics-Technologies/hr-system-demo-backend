/**
 * Calls the live /documents/match-preview endpoint the way the upload wizard
 * does, so we can see exactly what the browser receives.
 *
 *   npx ts-node src/scripts/probeMatchPreview.ts [userId] [companyIdOrNull]
 */
import dotenv from 'dotenv';
dotenv.config();

import { pool } from '../config/database';
import { signAuthToken } from '../config/jwt';
import { resolveAllowedCompanyIds } from '../utils/companyScope';

const USER_ID = Number(process.argv[2] ?? 1);
const SCOPE = process.argv[3] === 'null' ? null : Number(process.argv[3] ?? 1);
const BASE = `http://localhost:${process.env.PORT || 3001}`;

const FILES = [
  "Giulia_Barbieri_67.pdf", "_Barbieri_Matteo_09.pdf", "Roberto.Barbieri.pdf",
  "Aurora-Bianchi-CV.pdf", "_Stefano_Bianchi_Invoice.pdf", "29-07-2026_Francesco_Bruno.pdf",
  "COSTA_Stefano34.pdf", "ELENA_ROSSI.pdf", "EmmaRomano.pdf",
  "Giulia Greco.pdf", "Lorenzo&Rossi.pdf", "Lorenzo.Fontana_Report.pdf",
];

async function main() {
  const { rows } = await pool.query(
    `SELECT id, email, role, company_id, store_id, supervisor_id, is_super_admin FROM users WHERE id = $1`,
    [USER_ID],
  );
  const u = rows[0];
  if (!u) throw new Error(`user ${USER_ID} not found`);

  console.log(`User ${u.id} <${u.email}> role=${u.role} company=${u.company_id} is_super_admin=${u.is_super_admin}`);

  const allowed = await resolveAllowedCompanyIds({
    userId: u.id, email: u.email, role: u.role, companyId: u.company_id,
    storeId: u.store_id, supervisorId: u.supervisor_id, is_super_admin: u.is_super_admin, jti: 'probe',
  } as any);
  console.log(`resolveAllowedCompanyIds -> [${allowed.join(', ')}] (${allowed.length} companies)\n`);

  const token = signAuthToken({
    userId: u.id, email: u.email, role: u.role, companyId: u.company_id,
    storeId: u.store_id, supervisorId: u.supervisor_id, is_super_admin: u.is_super_admin,
  });

  const res = await fetch(`${BASE}/api/documents/match-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ files: FILES.map((f, i) => ({ document_id: 1000 + i, file_name: f })), company_id: SCOPE }),
  });

  console.log(`POST /api/documents/match-preview (company_id=${SCOPE}) -> ${res.status}`);
  const body: any = await res.json();
  if (!res.ok) { console.log(JSON.stringify(body, null, 2)); await pool.end(); return; }

  for (const entry of body.data.files) {
    const who = entry.employee ? `${entry.employee.name} ${entry.employee.surname} (co ${entry.employee.companyId})` : '—';
    console.log(`  ${entry.fileName.padEnd(36)} ${entry.outcome.padEnd(10)} ${who.padEnd(38)} suggestions=${entry.suggestions.length}`);
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
