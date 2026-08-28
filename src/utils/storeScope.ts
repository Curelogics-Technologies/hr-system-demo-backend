import { query } from '../config/database';

/**
 * Returns the store IDs an area manager is responsible for.
 *
 * There are two ways a store ends up under an area manager, and both count:
 *
 *  1. The area manager is assigned to the store directly (`users.store_id`).
 *     This is what the employee form writes when you pick a store on the area
 *     manager's own profile, and it is the assignment people reach for first.
 *  2. A store manager of that store reports to them (`users.supervisor_id`).
 *     This is the indirect route, and it was historically the only one the
 *     scoping queries looked at — so assigning the store directly appeared to
 *     do nothing at all.
 *
 * Callers must union both, or the visible UI action silently fails to grant
 * any visibility.
 */
export async function resolveAreaManagerStoreIds(
  userId: number,
  allowedCompanyIds: number[],
): Promise<number[]> {
  if (allowedCompanyIds.length === 0) return [];

  const rows = await query<{ store_id: number }>(
    `SELECT DISTINCT store_id FROM (
       -- Stores the area manager is assigned to directly
       SELECT store_id FROM users
        WHERE id = $1 AND company_id = ANY($2)
          AND status = 'active' AND store_id IS NOT NULL
       UNION
       -- Stores whose store manager reports to this area manager
       SELECT store_id FROM users
        WHERE role = 'store_manager' AND supervisor_id = $1
          AND company_id = ANY($2)
          AND status = 'active' AND store_id IS NOT NULL
     ) s
     ORDER BY store_id`,
    [userId, allowedCompanyIds],
  );

  return rows.map((r) => r.store_id);
}
