/**
 * Local-data repair script.
 *
 * The bulk seed (Seed branch) leaves the local database in a state that does not
 * match how the product actually behaves:
 *   - 19 of 20 companies have no admin at all, so they can have no owner either
 *     (transferCompanyOwnership requires an active admin of that company).
 *   - Only 3 companies are attached to a company group; the rest are orphans.
 *   - The employee roster is generic filler, so the document auto-assignment
 *     bugs the client reported cannot be reproduced locally.
 *
 * This script repairs those gaps *incrementally*. It never wipes and never
 * re-seeds - existing attendance/shift data is left untouched. Re-running it is
 * a no-op.
 *
 *   npx ts-node src/scripts/repairLocalData.ts
 */
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { pool } from '../config/database';

dotenv.config();

const DEV_PASSWORD = process.env.REPAIR_DEV_PASSWORD || 'password123';

/** Companies that belong to the client's own group. */
const FUSARO_GROUP = ['FUSARO UOMO', 'Paradise Limited', 'MILANO STYLE', 'ROSSO CORSA'];

/**
 * Independent groups so group filtering has something meaningful to filter.
 * "Beta Industries" is deliberately left out of every group: we want exactly
 * one standalone company so the group_id IS NULL path stays covered.
 */
const EXTRA_GROUPS: Record<string, string[]> = {
  'EUROPA RETAIL': [
    'BERLIN APPARATUS', 'PARIS PARFUM', 'MADRID SOL', 'AMSTERDAM TRADING',
    'ZURICH CLOCK', 'VIENNA ENTERPRISE', 'STOCKHOLM DESIGN', 'WARSAW COURIERS',
  ],
  'GLOBAL VENTURES': [
    'TOKYO AUTO', 'TORONTO RESOURCE', 'SYDNEY LOGISTICS', 'RIO EXPORTS',
    'CAPE WINELANDS', 'MEXICO TACOS', 'MUMBAI SOFTWARE',
  ],
};

/**
 * The roster from the client's 26-payslip archive, plus the employees their
 * documents were wrongly assigned to. Deliberately includes the collision
 * shapes that broke the old matcher:
 *   - Piscopo Rosa / Piscopo Francesco      -> shared surname
 *   - Percope' Francesco                    -> shared first name, accented surname
 *   - Perrotta Pasqua / Perrotta Pasqualina -> one full name is a PREFIX of the other
 *   - Conti Anna                            -> "anna" is a substring of "Giovanna"
 *   - Baldesi Veronica / Mure' Francesca    -> first-name-only collisions
 * `company` is the company the employee really belongs to.
 */
type RosterEntry = { name: string; surname: string; company: string; uniqueId: string };

const CLIENT_ROSTER: RosterEntry[] = [
  // --- FUSARO UOMO: the real holders of the archive's payslips ---
  { name: 'Veronica', surname: 'De Falco', company: 'FUSARO UOMO', uniqueId: 'FU-CED-040' },
  { name: 'Giovanna', surname: 'Mulloni', company: 'FUSARO UOMO', uniqueId: 'FU-CED-013' },
  { name: 'Rosa', surname: 'Piscopo', company: 'FUSARO UOMO', uniqueId: 'FU-CED-018' },
  { name: 'Francesco', surname: 'Piscopo', company: 'FUSARO UOMO', uniqueId: 'FU-CED-019' },
  { name: 'Francesco', surname: 'Percopé', company: 'FUSARO UOMO', uniqueId: 'FU-CED-015' },
  { name: 'Francesca', surname: 'Baiano', company: 'FUSARO UOMO', uniqueId: 'FU-CED-033' },
  { name: 'Pasqualina', surname: 'Perrotta', company: 'FUSARO UOMO', uniqueId: 'FU-CED-032' },
  { name: 'Pasqua', surname: 'Perrotta', company: 'FUSARO UOMO', uniqueId: 'FU-CED-031' },
  { name: 'Veronica', surname: 'Baldesi', company: 'FUSARO UOMO', uniqueId: 'FU-CED-041' },
  { name: 'Francesca', surname: 'Murè', company: 'FUSARO UOMO', uniqueId: 'FU-CED-034' },
  { name: 'Gennaro', surname: 'Esposito', company: 'FUSARO UOMO', uniqueId: 'FU-CED-021' },
  { name: 'Carmela', surname: "Dell'Aversano", company: 'FUSARO UOMO', uniqueId: 'FU-CED-022' },
  { name: 'Antonio', surname: 'Di Palma', company: 'FUSARO UOMO', uniqueId: 'FU-CED-023' },
  { name: 'Maria', surname: 'Sorrentino', company: 'FUSARO UOMO', uniqueId: 'FU-CED-024' },
  { name: 'Ciro', surname: 'Improta', company: 'FUSARO UOMO', uniqueId: 'FU-CED-025' },
  { name: 'Assunta', surname: 'Cacciapuoti', company: 'FUSARO UOMO', uniqueId: 'FU-CED-026' },
  { name: 'Salvatore', surname: 'Coppola', company: 'FUSARO UOMO', uniqueId: 'FU-CED-027' },
  { name: 'Rita', surname: 'Sepe', company: 'FUSARO UOMO', uniqueId: 'FU-CED-028' },

  // --- ROSSO CORSA: cross-company homonyms. Same names, different company.
  // With a company selected these must NOT be auto-assignment candidates.
  { name: 'Rosa', surname: 'Piscopo', company: 'ROSSO CORSA', uniqueId: 'RC-CED-018' },
  { name: 'Giovanna', surname: 'Mulloni', company: 'ROSSO CORSA', uniqueId: 'RC-CED-013' },
  { name: 'Luigi', surname: 'Aversa', company: 'ROSSO CORSA', uniqueId: 'RC-CED-051' },
  { name: 'Teresa', surname: 'Barra', company: 'ROSSO CORSA', uniqueId: 'RC-CED-052' },

  // --- MILANO STYLE: exact duplicate within one company. Two people, same
  // full name -> genuinely ambiguous, must stay unassigned.
  { name: 'Marco', surname: 'Bianco', company: 'MILANO STYLE', uniqueId: 'MS-CED-061' },
  { name: 'Marco', surname: 'Bianco', company: 'MILANO STYLE', uniqueId: 'MS-CED-062' },
];

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

async function main() {
  const client = await pool.connect();
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 12);
  const summary: string[] = [];

  try {
    await client.query('BEGIN');

    // ---------------------------------------------------------------------
    // 1. Every company needs an active admin, then an owner.
    // ---------------------------------------------------------------------
    const { rows: companies } = await client.query<{ id: number; name: string; slug: string; owner_user_id: number | null }>(
      `SELECT id, name, slug, owner_user_id FROM companies ORDER BY id`,
    );

    const REAL_ADMIN_NAMES: Array<{ name: string; surname: string }> = [
      { name: 'Marco', surname: 'Rossi' },
      { name: 'Giuseppe', surname: 'Verdi' },
      { name: 'Luca', surname: 'Bianchi' },
      { name: 'Alessandro', surname: 'Ferrari' },
      { name: 'Andrea', surname: 'Romano' },
      { name: 'Lorenzo', surname: 'Ricci' },
      { name: 'Matteo', surname: 'Marino' },
      { name: 'Davide', surname: 'Greco' },
      { name: 'Stefano', surname: 'Bruno' },
      { name: 'Roberto', surname: 'Gallo' },
      { name: 'Luca', surname: 'Conti' },
      { name: 'Simone', surname: 'De Luca' },
      { name: 'Filippo', surname: 'Costa' },
      { name: 'Elena', surname: 'Giordano' },
      { name: 'Giulia', surname: 'Rizzo' },
      { name: 'Francesca', surname: 'Moretti' },
      { name: 'Sofia', surname: 'Lombardi' },
      { name: 'Chiara', surname: 'Barbieri' },
      { name: 'Martina', surname: 'Fontana' },
      { name: 'Valentina', surname: 'Santoro' },
    ];

    let adminsCreated = 0;
    let ownersSet = 0;

    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      const realPerson = REAL_ADMIN_NAMES[i % REAL_ADMIN_NAMES.length];

      // Fix any placeholder "Amministratore" names in existing users table
      await client.query(
        `UPDATE users SET name = $1, surname = $2 WHERE company_id = $3 AND (name = 'Amministratore' OR surname = $4)`,
        [realPerson.name, realPerson.surname, company.id, company.name]
      );

      let admin = await client.query<{ id: number }>(
        `SELECT id FROM users
          WHERE company_id = $1 AND role = 'admin' AND status = 'active'
          ORDER BY id LIMIT 1`,
        [company.id],
      );

      if (admin.rowCount === 0) {
        const slug = company.slug || slugify(company.name);
        const email = `admin@${slug}.local`;
        const prefix = slugify(company.name).slice(0, 3).toUpperCase() || 'CMP';

        admin = await client.query<{ id: number }>(
          `INSERT INTO users (company_id, name, surname, email, password_hash, role, unique_id, status, locale)
           VALUES ($1, $2, $3, $4, $5, 'admin', $6, 'active', 'it')
           ON CONFLICT (email) DO UPDATE
             SET role = 'admin', status = 'active', company_id = EXCLUDED.company_id, name = EXCLUDED.name, surname = EXCLUDED.surname
           RETURNING id`,
          [company.id, realPerson.name, realPerson.surname, email, passwordHash, `${prefix}-ADM-001`],
        );
        adminsCreated++;
      }

      if (!company.owner_user_id && admin.rows[0]) {
        await client.query(`UPDATE companies SET owner_user_id = $1 WHERE id = $2`, [admin.rows[0].id, company.id]);
        ownersSet++;
      }
    }

    summary.push(`admins created: ${adminsCreated}`);
    summary.push(`owners assigned: ${ownersSet}`);

    // ---------------------------------------------------------------------
    // 2. Group assignment - no orphan companies.
    // ---------------------------------------------------------------------
    const groupPlan: Record<string, string[]> = { FUSAROGROUP: FUSARO_GROUP, ...EXTRA_GROUPS };
    let grouped = 0;

    for (const [groupName, memberNames] of Object.entries(groupPlan)) {
      let group = await client.query<{ id: number }>(`SELECT id FROM company_groups WHERE name = $1`, [groupName]);

      if (group.rowCount === 0) {
        // Owner of the group = owner of its first member company.
        const anchor = await client.query<{ owner_user_id: number | null }>(
          `SELECT owner_user_id FROM companies WHERE name = $1`,
          [memberNames[0]],
        );
        group = await client.query<{ id: number }>(
          `INSERT INTO company_groups (name, owner_user_id) VALUES ($1, $2) RETURNING id`,
          [groupName, anchor.rows[0]?.owner_user_id ?? null],
        );
      }

      const res = await client.query(
        `UPDATE companies SET group_id = $1 WHERE name = ANY($2) AND group_id IS DISTINCT FROM $1`,
        [group.rows[0].id, memberNames],
      );
      grouped += res.rowCount ?? 0;
    }

    const { rows: orphans } = await client.query<{ name: string }>(
      `SELECT name FROM companies WHERE group_id IS NULL ORDER BY name`,
    );
    summary.push(`companies (re)grouped: ${grouped}`);
    summary.push(`companies still ungrouped: ${orphans.length}${orphans.length ? ` (${orphans.map(o => o.name).join(', ')})` : ''}`);

    // ---------------------------------------------------------------------
    // 3. Client payslip roster, so the reported bugs are reproducible locally.
    // ---------------------------------------------------------------------
    const companyIdByName = new Map(companies.map(c => [c.name, c.id]));
    let employeesCreated = 0;
    let employeesSkipped = 0;

    for (const entry of CLIENT_ROSTER) {
      const companyId = companyIdByName.get(entry.company);
      if (!companyId) {
        console.warn(`  ! company not found, skipping ${entry.name} ${entry.surname}: ${entry.company}`);
        continue;
      }

      // unique_id is the stable key here - full name deliberately is not unique.
      const existing = await client.query(`SELECT id FROM users WHERE unique_id = $1`, [entry.uniqueId]);
      if (existing.rowCount) {
        employeesSkipped++;
        continue;
      }

      const store = await client.query<{ id: number }>(
        `SELECT id FROM stores WHERE company_id = $1 ORDER BY id LIMIT 1`,
        [companyId],
      );
      const email = `${slugify(entry.name)}.${slugify(entry.surname)}.${entry.uniqueId.toLowerCase()}@example.local`;

      await client.query(
        `INSERT INTO users (
           company_id, store_id, name, surname, email, password_hash, role,
           unique_id, status, locale, hire_date, working_type, weekly_hours
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'employee', $7, 'active', 'it', $8, $9, $10)
         ON CONFLICT (email) DO NOTHING`,
        [
          companyId, store.rows[0]?.id ?? null, entry.name, entry.surname, email, passwordHash,
          entry.uniqueId, '2024-01-15', 'full_time', 40,
        ],
      );
      employeesCreated++;
    }

    summary.push(`roster employees created: ${employeesCreated} (already present: ${employeesSkipped})`);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log('\nLocal data repair complete:');
  for (const line of summary) console.log(`  - ${line}`);
  await pool.end();
}

main().catch((err) => {
  console.error('Repair failed:', err);
  process.exit(1);
});
