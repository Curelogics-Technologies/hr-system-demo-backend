import { query, queryOne } from '../../config/database';
import { JwtPayload, UserRole } from '../../config/jwt';

// ---------------------------------------------------------------------------
// Document Categories
// ---------------------------------------------------------------------------

export interface DocumentCategory {
  id: number;
  companyId: number;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** How many documents currently sit in this category. */
  documentCount?: number;
}

function mapCategory(row: {
  id: number;
  company_id: number;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}): DocumentCategory {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCategories(
  companyIds: number[],
  includeInactive = false,
): Promise<DocumentCategory[]> {
  const rows = await query<{
    id: number;
    company_id: number;
    name: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
    document_count: string;
  }>(
    // document_count powers the "N documents" badge in the categories manager,
    // so an operator can see what a category actually holds before renaming or
    // deactivating it. Counts both storage tables and ignores deleted rows.
    `SELECT c.id, c.company_id, c.name, c.is_active, c.created_at, c.updated_at,
            (
              COALESCE((
                SELECT COUNT(*) FROM employee_documents ed
                 WHERE ed.category_id = c.id AND ed.is_deleted = false
              ), 0)
              + COALESCE((
                SELECT COUNT(*) FROM documents d
                 WHERE d.company_id = c.company_id AND d.category = c.name AND d.is_deleted = false
              ), 0)
            ) AS document_count
       FROM document_categories c
      WHERE c.company_id = ANY($1)
        ${includeInactive ? '' : 'AND c.is_active = true'}
      ORDER BY c.name ASC`,
    [companyIds],
  );
  return rows.map(row => ({ ...mapCategory(row), documentCount: Number(row.document_count) || 0 }));
}

export async function createCategory(companyId: number, name: string): Promise<DocumentCategory> {
  const row = await queryOne<{
    id: number;
    company_id: number;
    name: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO document_categories (company_id, name)
     VALUES ($1, $2)
     RETURNING id, company_id, name, is_active, created_at, updated_at`,
    [companyId, name],
  );
  return mapCategory(row!);
}

export async function updateCategory(
  id: number,
  currentCompanyId: number,
  updates: { name?: string; isActive?: boolean; companyId?: number },
): Promise<DocumentCategory | null> {
  const { pool } = await import('../../config/database');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Get current state
    const currentRes = await client.query<{ name: string; is_active: boolean; company_id: number }>(
      `SELECT name, is_active, company_id FROM document_categories WHERE id = $1 AND company_id = $2`,
      [id, currentCompanyId]
    );
    const current = currentRes.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return null;
    }

    // 2. Build update query
    const setParts: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (updates.name !== undefined) {
      setParts.push(`name = $${idx++}`);
      params.push(updates.name);
    }
    if (updates.isActive !== undefined) {
      setParts.push(`is_active = $${idx++}`);
      params.push(updates.isActive);
    }
    if (updates.companyId !== undefined) {
      setParts.push(`company_id = $${idx++}`);
      params.push(updates.companyId);
    }

    if (setParts.length > 0) {
      setParts.push(`updated_at = NOW()`);
      params.push(id, currentCompanyId);
      const updateQuery = `
        UPDATE document_categories
           SET ${setParts.join(', ')}
         WHERE id = $${idx++} AND company_id = $${idx++}
         RETURNING id, company_id, name, is_active, created_at, updated_at
      `;
      const updateResult = await client.query(updateQuery, params);
      const updatedRow = updateResult.rows[0];

      if (updatedRow) {
        const newName = updates.name !== undefined ? updates.name : current.name;
        const newActive = updates.isActive !== undefined ? updates.isActive : current.is_active;
        const targetCompanyId = updates.companyId !== undefined ? updates.companyId : current.company_id;

        // 3. Propagation Logic

        // CASE A: Deactivation (Active -> Inactive)
        if (current.is_active && !newActive) {
          // Nullify references in employee_documents
          await client.query(
            `UPDATE employee_documents SET category_id = NULL WHERE category_id = $1`,
            [id]
          );
          // Nullify references in generic documents table
          await client.query(
            `UPDATE documents 
                SET category = NULL 
              WHERE category = $1 
                AND (
                  employee_id IN (SELECT id FROM users WHERE company_id = $2)
                  OR uploaded_by IN (SELECT id FROM users WHERE company_id = $2)
                )`,
            [current.name, currentCompanyId]
          );
        }

        // CASE B: Reactivation (Inactive -> Active)
        else if (!current.is_active && newActive) {
          // Propagate to all employee_documents for this company
          await client.query(
            `UPDATE employee_documents SET category_id = $1 WHERE company_id = $2 AND deleted_at IS NULL`,
            [id, targetCompanyId]
          );
          // Propagate to all generic documents for this company
          await client.query(
            `UPDATE documents 
                SET category = $1 
              WHERE (
                employee_id IN (SELECT id FROM users WHERE company_id = $2)
                OR (employee_id IS NULL AND uploaded_by IN (SELECT id FROM users WHERE company_id = $2))
              )`,
            [newName, targetCompanyId]
          );
        }

        // CASE C: Name change while active
        else if (newActive && updates.name !== undefined && updates.name !== current.name) {
          await client.query(
            `UPDATE documents 
                SET category = $1 
              WHERE category = $2
                AND (
                  employee_id IN (SELECT id FROM users WHERE company_id = $3)
                  OR (employee_id IS NULL AND uploaded_by IN (SELECT id FROM users WHERE company_id = $3))
                )`,
            [updates.name, current.name, targetCompanyId]
          );
        }

        await client.query('COMMIT');
        return mapCategory(updatedRow);
      }
    }

    await client.query('ROLLBACK');
    return null;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating category:', err);
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteCategory(id: number, companyId: number): Promise<boolean> {
  const { pool } = await import('../../config/database');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Get category name before deletion
    const catRes = await client.query<{ name: string }>(
      `SELECT name FROM document_categories WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );
    const cat = catRes.rows[0];
    if (!cat) {
      await client.query('ROLLBACK');
      return false;
    }

    // 2. Nullify references in employee_documents (global ID match is safer)
    await client.query(
      `UPDATE employee_documents SET category_id = NULL WHERE category_id = $1`,
      [id]
    );

    // 3. Nullify references in generic documents table (include unassigned docs)
    await client.query(
      `UPDATE documents 
          SET category = NULL 
        WHERE category = $1 
          AND (
            employee_id IN (SELECT id FROM users WHERE company_id = $2)
            OR uploaded_by IN (SELECT id FROM users WHERE company_id = $2)
          )`,
      [cat.name, companyId]
    );

    // 4. Perform deletion
    await client.query(`DELETE FROM document_categories WHERE id = $1 AND company_id = $2`, [id, companyId]);

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting category:', err);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Document Record
// ---------------------------------------------------------------------------

export interface DocumentRecord {
  id: number;
  companyId: number;
  employeeId: number;
  categoryId: number | null;
  categoryName: string | null;
  fileName: string;
  storagePath: string;
  mimeType: string | null;
  uploadedByUserId: number | null;
  uploadedAt: string;
  requiresSignature: boolean;
  signedAt: string | null;
  signedByUserId: number | null;
  signedIp: string | null;
  signatureMeta: Record<string, unknown> | null;
  expiresAt: string | null;
  isVisibleToRoles: string[];
  isDeleted: boolean;
  deletedAt: string | null;
  restoredAt: string | null;
  restoredBy: number | null;
  createdAt: string;
  updatedAt: string;
  sourceTable?: 'documents' | 'employee_documents';
  employeeName?: string;
  employeeSurname?: string;
  employeeAvatarFilename?: string;
  employeeRole?: string;
}

function mapDocumentRecord(row: {
  id: number;
  company_id: number;
  employee_id: number;
  employee_company_id?: number | null;
  category_id: number | null;
  category_name: string | null;
  file_name: string;
  storage_path: string;
  mime_type: string | null;
  uploaded_by_user_id: number | null;
  uploaded_at: string;
  requires_signature: boolean;
  signed_at: string | null;
  signed_by_user_id: number | null;
  signed_ip: string | null;
  signature_meta: Record<string, unknown> | null;
  expires_at: string | null;
  is_visible_to_roles: string[];
  is_deleted: boolean;
  deleted_at: string | null;
  restored_at: string | null;
  restored_by: number | null;
  created_at: string;
  updated_at: string;
  employee_surname?: string;
  employee_avatar_filename?: string;
  employee_role?: string;
} | any): DocumentRecord {
  return {
    id: row.id,
    // Prioritize the employee's company ID if the document is assigned to an employee
    companyId: row.employee_company_id || row.company_id,
    employeeId: row.employee_id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    fileName: row.file_name,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    uploadedByUserId: row.uploaded_by_user_id,
    uploadedAt: row.uploaded_at,
    requiresSignature: row.requires_signature,
    signedAt: row.signed_at,
    signedByUserId: row.signed_by_user_id,
    signedIp: row.signed_ip,
    signatureMeta: row.signature_meta,
    expiresAt: row.expires_at,
    isVisibleToRoles: row.is_visible_to_roles,
    isDeleted: row.is_deleted || false,
    deletedAt: row.deleted_at,
    restoredAt: row.restored_at || null,
    restoredBy: row.restored_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    employeeName: row.employee_name,
    employeeSurname: row.employee_surname,
    employeeAvatarFilename: row.employee_avatar_filename,
    employeeRole: row.employee_role,
    sourceTable: 'employee_documents',
  };
}

const DOC_SELECT = `
  SELECT d.id,
         d.company_id,
         d.employee_id,
         e.company_id AS employee_company_id,
         CONCAT(e.name, ' ', e.surname) AS employee_name,
         e.name AS employee_first_name,
         e.surname AS employee_surname,
         e.avatar_filename AS employee_avatar_filename,
         e.role AS employee_role,
         d.category_id,
         c.name AS category_name,
         d.file_name,
         d.storage_path,
         d.mime_type,
         d.uploaded_by_user_id,
         d.uploaded_at,
         d.requires_signature,
         d.signed_at,
         d.signed_by_user_id,
         d.signed_ip::text AS signed_ip,
         d.signature_meta,
         d.expires_at,
         d.is_visible_to_roles,
         d.is_deleted,
         d.deleted_at,
         d.restored_at,
         d.restored_by,
         d.created_at,
         d.updated_at
    FROM employee_documents d
    LEFT JOIN document_categories c ON c.id = d.category_id
    LEFT JOIN users e ON e.id = d.employee_id
`;

/**
 * Helper to check if a user can access a specific document based on its visibility and assigned employee.
 */
async function checkDocumentAccess(
  isVisibleToRoles: string[] | null,
  assignedEmployeeId: number | null,
  user: JwtPayload,
  assignedEmployeeRole?: string | null
): Promise<boolean> {
  if (user.is_super_admin) return true;
  if (user.role === 'admin') return true;

  // 1. Role must be in is_visible_to_roles (handles "Only HR" etc)
  const roles = isVisibleToRoles || ['admin', 'hr', 'area_manager', 'store_manager', 'employee'];
  if (!roles.includes(user.role)) return false;

  // 2. HR can see anything in their allowed companies (company check is done upstream)
  if (user.role === 'hr') return true;

  // 3. Hierarchy Check
  if (assignedEmployeeId === user.userId) return true; // Always see own docs

  if (user.role === 'area_manager') {
    // Can see SM and Employee docs within same company
    if (assignedEmployeeId === null) return true; // Company-wide docs
    return assignedEmployeeRole === 'store_manager' || assignedEmployeeRole === 'employee';
  }

  if (user.role === 'store_manager' && user.storeId) {
    if (assignedEmployeeId === null) return true; // Store context docs often have employeeId null
    
    // Check if the assigned employee is in the same store and is an 'employee'
    if (assignedEmployeeRole !== 'employee') return false;

    const sameStore = await queryOne(`
      SELECT id FROM users WHERE id = $1 AND store_id = $2
    `, [assignedEmployeeId, user.storeId]);
    return !!sameStore;
  }

  if (user.role === 'employee') {
    return assignedEmployeeId === user.userId;
  }

  return false;
}

export async function getEmployeeDocumentById(
  id: number,
  companyIds: number[],
  user: JwtPayload
): Promise<DocumentRecord | null> {
  const doc = await queryOne<{
    id: number;
    company_id: number;
    employee_id: number;
    category_id: number | null;
    category_name: string | null;
    file_name: string;
    storage_path: string;
    mime_type: string | null;
    uploaded_by_user_id: number | null;
    uploaded_at: string;
    requires_signature: boolean;
    signed_at: string | null;
    signed_by_user_id: number | null;
    signed_ip: string | null;
    signature_meta: Record<string, unknown> | null;
    expires_at: string | null;
    is_visible_to_roles: string[];
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `${DOC_SELECT}
      WHERE d.id = $1 AND d.company_id = ANY($2)`,
    [id, companyIds],
  );

  if (!doc) return null;

  // Verify visibility
  if (!(await checkDocumentAccess(doc.is_visible_to_roles, doc.employee_id, user, (doc as any).employee_role))) {
    return null;
  }

  const mapped = mapDocumentRecord(doc);
  mapped.sourceTable = 'employee_documents';
  return mapped;
}

export async function getGenericDocumentById(
  id: number,
  companyIds: number[],
  user: JwtPayload
): Promise<DocumentRecord | null> {
  const doc = await queryOne<{
    id: number;
    title: string;
    file_url: string;
    category: string | null;
    employee_id: number | null;
    uploaded_by: number;
    requires_signature: boolean;
    expires_at: string | null;
    is_visible_to_roles: string[];
    created_at: string;
    signed_at: string | null;
    signed_by_user_id: number | null;
    signed_ip: string | null;
    signature_meta: Record<string, unknown> | null;
    is_deleted?: boolean;
    deleted_at?: string | null;
    restored_at?: string | null;
    restored_by?: number | null;
  }>(
    `SELECT d.*, u_up.company_id as u_up_company_id, e.company_id as e_company_id, e.role as e_role
       FROM documents d
       LEFT JOIN users e ON e.id = d.employee_id
       LEFT JOIN users u_up ON u_up.id = d.uploaded_by
      WHERE d.id = $1`,
    [id]
  );

  if (!doc) return null;

  // Verify company access
  const docCompanyId = (doc as any).e_company_id || (doc as any).u_up_company_id;
  if (!companyIds.includes(docCompanyId)) return null;

  // Verify role visibility
  if (!(await checkDocumentAccess(doc.is_visible_to_roles, doc.employee_id, user, (doc as any).e_role))) {
    return null;
  }

  // Map GenericDocument to DocumentRecord structure
  return {
    id: doc.id,
    companyId: docCompanyId,
    employeeId: doc.employee_id || 0,
    categoryId: null, // Basic version
    categoryName: doc.category,
    fileName: doc.title,
    storagePath: doc.file_url,
    mimeType: null, // Will be inferred
    uploadedByUserId: doc.uploaded_by,
    uploadedAt: doc.created_at,
    requiresSignature: doc.requires_signature,
    signedAt: doc.signed_at,
    signedByUserId: doc.signed_by_user_id,
    signedIp: doc.signed_ip ? String(doc.signed_ip) : null,
    signatureMeta: doc.signature_meta as any,
    expiresAt: doc.expires_at,
    isVisibleToRoles: doc.is_visible_to_roles,
    isDeleted: doc.is_deleted || false,
    deletedAt: doc.deleted_at || null,
    restoredAt: doc.restored_at || null,
    restoredBy: doc.restored_by || null,
    createdAt: doc.created_at,
    updatedAt: doc.created_at,
    sourceTable: 'documents',
    employeeRole: (doc as any).e_role,
  };
}

/**
 * Unified lookup that checks both employee_documents and documents tables.
 * If source is provided, it strictly checks only that table.
 */
export async function getDocumentById(
  id: number,
  companyIds: number[],
  user: JwtPayload,
  source?: 'documents' | 'employee_documents'
): Promise<DocumentRecord | null> {
  if (source === 'employee_documents') {
    return getEmployeeDocumentById(id, companyIds, user);
  }
  if (source === 'documents') {
    return getGenericDocumentById(id, companyIds, user);
  }

  // Fallback: try employee_documents first (legacy behavior for old links)
  const empDoc = await getEmployeeDocumentById(id, companyIds, user);
  if (empDoc) return empDoc;

  // Then try generic documents
  return getGenericDocumentById(id, companyIds, user);
}

export async function getEmployeeDocuments(
  companyId: number,
  employeeId: number,
  user: JwtPayload,
): Promise<DocumentRecord[]> {
  let where = 'd.company_id = $1 AND d.employee_id = $2 AND d.is_deleted = false';
  const params: any[] = [companyId, employeeId];

  // Fetch target employee details to check role and store association
  const target = await queryOne<{ role: string; store_id: number | null }>(
    'SELECT role, store_id FROM users WHERE id = $1',
    [employeeId]
  );
  if (!target) return [];

  // Role-based filtering
  if (user.is_super_admin || user.role === 'admin' || user.role === 'hr') {
    // Full access within authorized companies (handled by companyId param)
  } else if (user.role === 'area_manager') {
    // Area Manager: See SM and Employee docs, or their own
    if (user.userId !== employeeId) {
      const allowedSubRoles = ['store_manager', 'employee'];
      if (!allowedSubRoles.includes(target.role)) return [];
    }
    where += " AND ($3 = ANY(d.is_visible_to_roles) OR d.is_visible_to_roles IS NULL)";
    params.push(user.role);
  } else if (user.role === 'store_manager') {
    // Store Manager: See documents of employees in their store only, or their own
    if (user.userId !== employeeId) {
      if (target.role !== 'employee' || target.store_id !== user.storeId) return [];
    }
    where += " AND ($3 = ANY(d.is_visible_to_roles) OR d.is_visible_to_roles IS NULL)";
    params.push(user.role);
  } else if (user.role === 'employee') {
    if (user.userId !== employeeId) return []; // Cannot see others
    where += " AND ($3 = ANY(d.is_visible_to_roles) OR d.is_visible_to_roles IS NULL)";
    params.push(user.role);
  } else {
    return [];
  }

  const rows = await query<{
    id: number;
    company_id: number;
    employee_id: number;
    category_id: number | null;
    category_name: string | null;
    file_name: string;
    storage_path: string;
    mime_type: string | null;
    uploaded_by_user_id: number | null;
    uploaded_at: string;
    requires_signature: boolean;
    signed_at: string | null;
    signed_by_user_id: number | null;
    signed_ip: string | null;
    signature_meta: Record<string, unknown> | null;
    expires_at: string | null;
    is_visible_to_roles: string[];
    employee_name: string | null;
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `${DOC_SELECT}
      WHERE ${where}
      ORDER BY d.uploaded_at DESC, d.id DESC`,
    params,
  );
  return rows.map(mapDocumentRecord);
}


/**
 * Employee documents that have no counterpart in the `documents` table.
 *
 * The legacy /bulk-upload route writes straight into `employee_documents`, so
 * those files never appeared in the admin/HR document list - which is why a
 * super admin could not see everything on the platform. They are matched by
 * storage_path so a document present in both tables is not listed twice.
 */
export async function getOrphanEmployeeDocuments(options: {
  companyIds: number[];
  excludeEmployeeId?: number | null;
}): Promise<DocumentRecord[]> {
  if (!options.companyIds || options.companyIds.length === 0) return [];

  const params: unknown[] = [options.companyIds];
  let extra = '';
  if (options.excludeEmployeeId != null) {
    params.push(options.excludeEmployeeId);
    extra = `AND (d.employee_id IS NULL OR d.employee_id <> $${params.length})`;
  }

  const rows = await query<any>(
    `${DOC_SELECT}
      WHERE d.company_id = ANY($1)
        AND d.is_deleted = false
        AND d.deleted_at IS NULL
        ${extra}
        AND NOT EXISTS (
          SELECT 1 FROM documents g
           WHERE g.file_url = d.storage_path
             AND g.is_deleted = false
        )
      ORDER BY d.uploaded_at DESC, d.id DESC`,
    params,
  );
  return rows.map(mapDocumentRecord);
}

export async function softDeleteDocument(
  id: number,
  companyId: number,
  sourceTable: 'documents' | 'employee_documents' = 'employee_documents',
  client?: any
): Promise<boolean> {
  const db = client || { query: (text: string, params: any[]) => query(text, params) };
  const table = sourceTable === 'documents' ? 'documents' : 'employee_documents';
  const idCol = 'id';

  // Refined check: for generic documents, we check if uploader company matches OR if it's assigned to an employee in that company.
  const authFilter = table === 'employee_documents'
    ? 'company_id = $2'
    : '(uploaded_by IN (SELECT id FROM users WHERE company_id = $2) OR employee_id IN (SELECT id FROM users WHERE company_id = $2))';

  const queryText = `
    UPDATE ${table}
       SET is_deleted = true, 
           deleted_at = NOW(), 
           updated_at = NOW()
     WHERE ${idCol} = $1 
       AND (${authFilter})
       AND is_deleted = false
    RETURNING id
  `;

  const rows = await db.query(queryText, [id, companyId]);
  const row = (client ? rows.rows[0] : rows[0]) || null;
  return row !== null;
}

export async function restoreDocument(
  id: number,
  allowedCompanyIds: number[],
  restoredBy: number,
  sourceTable: 'documents' | 'employee_documents'
): Promise<boolean> {
  const { pool } = await import('../../config/database');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Identify storage path and verify company
    let storagePath: string | null = null;
    let mainCompanyId: number | null = null;

    if (sourceTable === 'documents') {
      const doc = await client.query(`SELECT file_url as storage_path, company_id FROM documents WHERE id = $1`, [id]);
      if (doc.rows[0]) {
        storagePath = doc.rows[0].storage_path;
        mainCompanyId = doc.rows[0].company_id;
      }
    } else {
      const doc = await client.query(`SELECT storage_path, company_id FROM employee_documents WHERE id = $1`, [id]);
      if (doc.rows[0]) {
        storagePath = doc.rows[0].storage_path;
        mainCompanyId = doc.rows[0].company_id;
      }
    }

    if (!storagePath || !mainCompanyId || !allowedCompanyIds.includes(mainCompanyId)) {
      await client.query('ROLLBACK');
      return false;
    }

    // 2. Restore in BOTH tables
    // Table: documents
    await client.query(`
      UPDATE documents 
         SET is_deleted = false, 
             deleted_at = NULL,
             restored_at = NOW(), restored_by = $2, updated_at = NOW()
       WHERE (file_url = $1 OR id = $3) AND is_deleted = true
    `, [storagePath, restoredBy, id]);

    // Table: employee_documents
    await client.query(`
      UPDATE employee_documents 
         SET is_deleted = false, 
             deleted_at = NULL,
             restored_at = NOW(), restored_by = $2, updated_at = NOW()
       WHERE (storage_path = $1 OR id = $3) AND is_deleted = true
    `, [storagePath, restoredBy, id]);

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('restoreDocument error:', err);
    throw err;
  } finally {
    client.release();
  }
}


export async function getDeletedDocuments(
  companyIds: number[],
  employeeId?: number,
  tab?: 'my' | 'team',
  loggedInUserId?: number
): Promise<DocumentRecord[]> {
  // 1. Fetch from employee_documents
  let empWhere = 'd.company_id = ANY($1) AND d.is_deleted = true';
  const empParams: any[] = [companyIds];
  if (employeeId) {
    empWhere += ' AND d.employee_id = $2';
    empParams.push(employeeId);
  }

  if (tab === 'my' && loggedInUserId) {
    empWhere += ` AND d.employee_id = $${empParams.length + 1}`;
    empParams.push(loggedInUserId);
  } else if (tab === 'team' && loggedInUserId) {
    empWhere += ` AND (d.employee_id IS NULL OR d.employee_id <> $${empParams.length + 1})`;
    empParams.push(loggedInUserId);
  }

  const empRows = await query<any>(
    `${DOC_SELECT}
     WHERE ${empWhere}
     ORDER BY d.deleted_at DESC`,
    empParams
  );
  const empDocs = empRows.map(mapDocumentRecord);

  // 2. Fetch from documents (generic)
  let genWhere = 'd.company_id = ANY($1) AND d.is_deleted = true';
  const genParams: any[] = [companyIds];
  if (employeeId) {
    genWhere += ' AND d.employee_id = $2';
    genParams.push(employeeId);
  }

  if (tab === 'my' && loggedInUserId) {
    genWhere += ` AND d.employee_id = $${genParams.length + 1}`;
    genParams.push(loggedInUserId);
  } else if (tab === 'team' && loggedInUserId) {
    genWhere += ` AND (d.employee_id IS NULL OR d.employee_id <> $${genParams.length + 1})`;
    genParams.push(loggedInUserId);
  }

  const genRows = await query<any>(
    `SELECT d.*, 
            CONCAT(e.name, ' ', e.surname) AS employee_name,
         e.name AS employee_first_name,
         e.surname AS employee_surname,
         e.avatar_filename AS employee_avatar_filename,
            e.company_id AS employee_company_id
       FROM documents d
       LEFT JOIN users e ON e.id = d.employee_id
      WHERE ${genWhere}
      ORDER BY d.deleted_at DESC`,
    genParams
  );


  const genDocs: DocumentRecord[] = genRows.map((r: any) => ({
    id: r.id,
    companyId: r.employee_company_id || r.company_id,
    employeeId: r.employee_id, // Preserving null instead of using 0
    categoryId: null,
    categoryName: r.category,
    fileName: r.title,
    storagePath: r.file_url,
    mimeType: null,
    uploadedByUserId: r.uploaded_by,
    uploadedAt: r.created_at,
    requiresSignature: r.requires_signature,
    signedAt: r.signed_at,
    signedByUserId: r.signed_by_user_id,
    signedIp: r.signed_ip ? String(r.signed_ip) : null,
    signatureMeta: r.signature_meta,
    expiresAt: r.expires_at,
    isVisibleToRoles: r.is_visible_to_roles,
    isDeleted: r.is_deleted || false,
    deletedAt: r.deleted_at || null,
    restoredAt: r.restored_at || null,
    restoredBy: r.restored_by || null,
    createdAt: r.created_at,
    updatedAt: r.created_at,
    sourceTable: 'documents',
    employeeName: r.employee_name && r.employee_name.trim() !== '' ? r.employee_name : undefined,
    employeeSurname: r.employee_surname || undefined,
    employeeAvatarFilename: r.employee_avatar_filename || undefined,
  }));

  // 3. Deduplicate by storage path, PRIORITIZING records that have an employee assigned
  const combined = [...empDocs, ...genDocs];

  // Sort combined array so that records with employeeId and employeeName come first
  combined.sort((a, b) => {
    const aHasEmp = (a.employeeId && a.employeeName) ? 1 : 0;
    const bHasEmp = (b.employeeId && b.employeeName) ? 1 : 0;
    return bHasEmp - aHasEmp;
  });

  const seenPaths = new Set<string>();
  const uniqueDocs: DocumentRecord[] = [];

  for (const doc of combined) {
    if (!seenPaths.has(doc.storagePath)) {
      seenPaths.add(doc.storagePath);
      uniqueDocs.push(doc);
    }
  }

  return uniqueDocs.sort((a, b) =>
    new Date(b.deletedAt!).getTime() - new Date(a.deletedAt!).getTime()
  );
}

export async function updateDocumentVisibility(
  id: number,
  companyId: number,
  roles: string[],
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `UPDATE employee_documents
        SET is_visible_to_roles = $3, updated_at = NOW()
      WHERE id = $1 AND company_id = $2 AND is_deleted = false
      RETURNING id`,
    [id, companyId, roles],
  );
  return row !== null;
}

export async function signDocument(
  id: number,
  options: {
    signedByUserId: number;
    signedIp: string;
    signatureMeta: Record<string, unknown>;
    newStoragePath?: string;
    signedAt?: string;
  },
): Promise<DocumentRecord | null> {
  const setParts = [
    `signed_at = $5`,
    `signed_by_user_id = $2`,
    `signed_ip = $3::inet`,
    `signature_meta = $4`,
    `updated_at = NOW()`,
  ];
  const signedAt = options.signedAt || new Date().toISOString();
  const params: unknown[] = [id, options.signedByUserId, options.signedIp, options.signatureMeta, signedAt];

  if (options.newStoragePath) {
    params.push(options.newStoragePath);
    setParts.push(`storage_path = $${params.length}`);
  }

  const row = await queryOne<{
    id: number;
    company_id: number;
    employee_id: number;
    category_id: number | null;
    category_name: string | null;
    file_name: string;
    storage_path: string;
    mime_type: string | null;
    uploaded_by_user_id: number | null;
    uploaded_at: string;
    requires_signature: boolean;
    signed_at: string | null;
    signed_by_user_id: number | null;
    signed_ip: string | null;
    signature_meta: Record<string, unknown> | null;
    expires_at: string | null;
    is_visible_to_roles: string[];
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `UPDATE employee_documents d
        SET ${setParts.join(', ')}
      WHERE d.id = $1 AND d.is_deleted = false
      RETURNING
        d.id,
        d.company_id,
        d.employee_id,
        d.category_id,
        NULL::text AS category_name,
        d.file_name,
        d.storage_path,
        d.mime_type,
        d.uploaded_by_user_id,
        d.uploaded_at,
        d.requires_signature,
        d.signed_at,
        d.signed_by_user_id,
        d.signed_ip::text AS signed_ip,
        d.signature_meta,
        d.expires_at,
        d.is_visible_to_roles,
        d.deleted_at,
        d.created_at,
        d.updated_at`,
    params,
  );
  return row ? mapDocumentRecord(row) : null;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Generic Documents (Step 1)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface GenericDocument {
  id: number;
  title: string;
  fileUrl: string;
  category: string | null;
  employeeId: number | null;
  uploadedBy: number;
  requiresSignature: boolean;
  signedAt?: string | null;
  signedByUserId?: number | null;
  signedIp?: string | null;
  signatureMeta?: Record<string, unknown> | null;
  expiresAt: string | null;
  isVisibleToRoles: string[];
  isDeleted: boolean;
  deletedAt: string | null;
  restoredAt: string | null;
  restoredBy: number | null;
  createdAt: string;
  employeeRole?: string;
}

(async () => {
  try {
    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_confirmed BOOLEAN DEFAULT false;`);
    await query(`UPDATE documents SET is_confirmed = true WHERE is_confirmed IS NULL;`);
  } catch { /* ignore initialization */ }
})();

export async function createGenericDocument(data: {
  companyId: number;
  title: string;
  fileUrl: string;
  category?: string;
  employeeId?: number;
  uploadedBy: number;
  requiresSignature?: boolean;
  expiresAt?: string | null;
  isVisibleToRoles?: string[];
  isConfirmed?: boolean;
}): Promise<GenericDocument> {
  const isConfirmed = data.isConfirmed ?? false;
  const row = await queryOne<{
    id: number;
    company_id: number;
    title: string;
    file_url: string;
    category: string | null;
    employee_id: number | null;
    uploaded_by: number;
    requires_signature: boolean;
    expires_at: string | null;
    is_visible_to_roles: string[];
    is_deleted: boolean;
    deleted_at: string | null;
    restored_at: string | null;
    restored_by: number | null;
    created_at: string;
  }>(
    `INSERT INTO documents (company_id, title, file_url, category, employee_id, uploaded_by, requires_signature, expires_at, is_visible_to_roles, is_confirmed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, company_id, title, file_url, category, employee_id, uploaded_by, requires_signature, expires_at, is_visible_to_roles, created_at`,
    [
      data.companyId,
      data.title,
      data.fileUrl,
      data.category || null,
      data.employeeId || null,
      data.uploadedBy,
      data.requiresSignature || false,
      data.expiresAt || null,
      data.isVisibleToRoles || ['admin', 'hr', 'area_manager', 'store_manager', 'employee'],
      isConfirmed
    ],
  );

  return {
    id: row!.id,
    title: row!.title,
    fileUrl: row!.file_url,
    category: row!.category,
    employeeId: row!.employee_id,
    uploadedBy: row!.uploaded_by,
    requiresSignature: row!.requires_signature,
    expiresAt: row!.expires_at,
    isVisibleToRoles: row!.is_visible_to_roles,
    createdAt: row!.created_at,
    isDeleted: false,
    deletedAt: null,
    restoredAt: null,
    restoredBy: null,
  };
}

export async function getGenericDocuments(options: {
  companyId: number;
  employeeId?: number;
  role: UserRole;
  isSuperAdmin?: boolean;
  storeId?: number | null;
  allowedCompanyIds?: number[];
  tab?: 'my' | 'team';
}): Promise<(GenericDocument & { employeeName?: string })[]> {
  let where = '1=1';
  const params: any[] = [];

  // Role-based visibility check: By default, documents are visible to all if null
  // but if specified (e.g., "Only HR"), we must strictly check the role.
  const visibilityFilter = `($roleIndex = ANY(COALESCE(d.is_visible_to_roles, ARRAY['admin','hr','area_manager','store_manager','employee']::text[])))`;

  const tab = options.tab;

  // Scoping logic based on role hierarchy and tab filtering
  if (tab === undefined) {
    // --- ORIGINAL BACKWARDS-COMPATIBLE BEHAVIOR ---
    if (options.role === 'admin' || options.isSuperAdmin) {
      // Admin: see all documents in allowed companies
      const ids = options.allowedCompanyIds || [options.companyId];
      where = 'd.company_id = ANY($1) AND d.is_deleted = false';
      params.push(ids);
    } else if (options.role === 'hr') {
      // HR: see all documents in allowed companies
      const ids = options.allowedCompanyIds || [options.companyId];
      where = 'd.company_id = ANY($1) AND d.is_deleted = false';
      params.push(ids);
    } else if (options.role === 'area_manager') {
      // Area Manager: See AM, SM and Employee docs within same company
      const ids = options.allowedCompanyIds || [options.companyId];
      where = `d.company_id = ANY($1) 
               AND ${visibilityFilter.replace('$roleIndex', '$2')} 
               AND (d.employee_id = $3 OR e.role IN ('store_manager', 'employee')) 
               AND d.is_deleted = false`;
      params.push(ids, options.role, options.employeeId);
    } else if (options.role === 'store_manager' && options.storeId) {
      // Store Manager: See own docs and Employee docs in their store
      where = `(
        d.company_id = $4
        AND ${visibilityFilter.replace('$roleIndex', '$3')}
        AND (d.employee_id = $2 OR (e.store_id = $1 AND e.role = 'employee'))
        AND d.is_deleted = false
      )`;
      params.push(options.storeId, options.employeeId, options.role, options.companyId);
    } else if (options.role === 'employee' && options.employeeId) {
      // Employee:
      // 1. Must pass visibility check
      // 2. See ONLY their own assigned documents
      where = `(
        d.company_id = $3
        AND ${visibilityFilter.replace('$roleIndex', '$2')}
        AND d.employee_id = $1
        AND d.is_deleted = false
      )`;
      params.push(options.employeeId, options.role, options.companyId);
    } else {
      // Default safe state: no documents
      where = '1=0';
    }
  } else if (tab === 'my') {
    // --- MY DOCUMENTS TAB ---
    // Displays ONLY documents assigned directly to the logged-in user.
    if (options.role === 'admin' || options.isSuperAdmin) {
      const ids = options.allowedCompanyIds || [options.companyId];
      where = 'd.company_id = ANY($1) AND d.employee_id = $2 AND d.is_deleted = false';
      params.push(ids, options.employeeId);
    } else if (options.role === 'hr') {
      const ids = options.allowedCompanyIds || [options.companyId];
      where = 'd.company_id = ANY($1) AND d.employee_id = $2 AND d.is_deleted = false';
      params.push(ids, options.employeeId);
    } else if (options.role === 'area_manager') {
      const ids = options.allowedCompanyIds || [options.companyId];
      where = `d.company_id = ANY($1) 
               AND d.employee_id = $2 
               AND ${visibilityFilter.replace('$roleIndex', '$3')} 
               AND d.is_deleted = false`;
      params.push(ids, options.employeeId, options.role);
    } else if (options.role === 'store_manager') {
      where = `d.company_id = $1 
               AND d.employee_id = $2 
               AND ${visibilityFilter.replace('$roleIndex', '$3')} 
               AND d.is_deleted = false`;
      params.push(options.companyId, options.employeeId, options.role);
    } else if (options.role === 'employee') {
      where = `d.company_id = $1 
               AND d.employee_id = $2 
               AND ${visibilityFilter.replace('$roleIndex', '$3')} 
               AND d.is_deleted = false`;
      params.push(options.companyId, options.employeeId, options.role);
    } else {
      where = '1=0';
    }
  } else if (tab === 'team') {
    // --- TEAM DOCUMENTS TAB ---
    // Displays ONLY documents belonging to lower-level managed team members.
    if (options.role === 'admin' || options.isSuperAdmin) {
      const ids = options.allowedCompanyIds || [options.companyId];
      where = 'd.company_id = ANY($1) AND (d.employee_id IS NULL OR d.employee_id <> $2) AND d.is_deleted = false';
      params.push(ids, options.employeeId);
    } else if (options.role === 'hr') {
      const ids = options.allowedCompanyIds || [options.companyId];
      where = 'd.company_id = ANY($1) AND (d.employee_id IS NULL OR d.employee_id <> $2) AND d.is_deleted = false';
      params.push(ids, options.employeeId);
    } else if (options.role === 'area_manager') {
      // Area Manager views Store Managers and Employees (excluding own)
      const ids = options.allowedCompanyIds || [options.companyId];
      where = `d.company_id = ANY($1) 
               AND ${visibilityFilter.replace('$roleIndex', '$2')} 
               AND e.role IN ('store_manager', 'employee') 
               AND d.is_deleted = false`;
      params.push(ids, options.role);
    } else if (options.role === 'store_manager' && options.storeId) {
      // Store Manager views Employees in their store (excluding own)
      where = `d.company_id = $1 
               AND e.store_id = $2 
               AND e.role = 'employee' 
               AND ${visibilityFilter.replace('$roleIndex', '$3')} 
               AND d.is_deleted = false`;
      params.push(options.companyId, options.storeId, options.role);
    } else if (options.role === 'employee') {
      // Employee has no managed roles; Team Documents tab hidden/unauthorized
      where = '1=0';
    } else {
      where = '1=0';
    }
  }

  const rows = await query<{
    id: number;
    company_id: number;
    title: string;
    file_url: string;
    category: string | null;
    employee_id: number | null;
    employee_company_id: number | null;
    uploaded_by: number;
    requires_signature: boolean;
    expires_at: string | null;
    is_visible_to_roles: string[];
    created_at: string;
    employee_name: string | null;
    signed_at: string | null;
    signed_at_combined: string | null;
    signed_by_user_id: number | null;
    signed_ip: string | null;
    signature_meta: Record<string, unknown> | null;
    is_deleted: boolean;
    deleted_at: string | null;
    restored_at: string | null;
    restored_by: number | null;
    employee_surname?: string;
    employee_avatar_filename?: string;
    employee_role?: string;
  }>(
    `SELECT d.*, CONCAT(e.name, ' ', e.surname) AS employee_name,
         e.name AS employee_first_name,
         e.surname AS employee_surname,
         e.avatar_filename AS employee_avatar_filename,
            e.company_id AS employee_company_id,
            COALESCE(d.signed_at, (SELECT max(ed.signed_at) FROM employee_documents ed WHERE ed.storage_path = d.file_url AND ed.employee_id = d.employee_id AND ed.is_deleted = false)) as signed_at_combined
       FROM documents d
       LEFT JOIN users e ON e.id = d.employee_id
       LEFT JOIN users u_up ON u_up.id = d.uploaded_by
       WHERE ${where} AND d.is_deleted = false AND (d.is_confirmed = true OR d.is_confirmed IS NULL)
      ORDER BY d.created_at DESC`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    companyId: r.employee_company_id || r.company_id,
    title: r.title,
    fileUrl: r.file_url,
    category: r.category,
    employeeId: r.employee_id,
    uploadedBy: r.uploaded_by,
    requiresSignature: r.requires_signature,
    signedAt: r.signed_at_combined || r.signed_at,
    signedByUserId: r.signed_by_user_id,
    signedIp: r.signed_ip ? String(r.signed_ip) : null,
    signatureMeta: r.signature_meta,
    expiresAt: r.expires_at,
    isVisibleToRoles: r.is_visible_to_roles,
    createdAt: r.created_at,
    employeeName: r.employee_name || undefined,
    employeeSurname: r.employee_surname || undefined,
    employeeAvatarFilename: r.employee_avatar_filename || undefined,
    employeeRole: r.employee_role,
    isDeleted: r.is_deleted,
    deletedAt: r.deleted_at,
    restoredAt: r.restored_at,
    restoredBy: r.restored_by,
    sourceTable: 'documents',
  }));
}

export async function signGenericDocument(
  id: number,
  options: {
    signedByUserId: number;
    signedIp: string;
    signatureMeta: Record<string, unknown>;
    newStoragePath?: string;
    signedAt?: string;
  },
): Promise<GenericDocument | null> {
  const setParts = [
    `signed_at = $2`,
    `signed_by_user_id = $3`,
    `signed_ip = $4::inet`,
    `signature_meta = $5`
  ];
  const params: unknown[] = [id, options.signedAt || new Date().toISOString(), options.signedByUserId, options.signedIp, options.signatureMeta];

  if (options.newStoragePath) {
    params.push(options.newStoragePath);
    setParts.push(`file_url = $${params.length}`);
  }

  const row = await queryOne<{
    id: number;
    title: string;
    file_url: string;
    category: string | null;
    employee_id: number | null;
    uploaded_by: number;
    requires_signature: boolean;
    signed_at: string | null;
    signed_by_user_id: number | null;
    signed_ip: string | null;
    signature_meta: Record<string, unknown> | null;
    expires_at: string | null;
    is_visible_to_roles: string[];
    is_deleted: boolean;
    deleted_at: string | null;
    restored_at: string | null;
    restored_by: number | null;
    created_at: string;
  }>(
    `UPDATE documents
        SET ${setParts.join(', ')}
      WHERE id = $1 AND is_deleted = false
      RETURNING *`,
    params,
  );

  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    fileUrl: row.file_url,
    category: row.category,
    employeeId: row.employee_id,
    uploadedBy: row.uploaded_by,
    requiresSignature: row.requires_signature,
    signedAt: row.signed_at,
    signedByUserId: row.signed_by_user_id,
    signedIp: row.signed_ip ? String(row.signed_ip) : null,
    signatureMeta: row.signature_meta,
    expiresAt: row.expires_at,
    isVisibleToRoles: row.is_visible_to_roles,
    createdAt: row.created_at,
    isDeleted: row.is_deleted || false,
    deletedAt: row.deleted_at || null,
    restoredAt: row.restored_at || null,
    restoredBy: row.restored_by || null,
  };
}

export async function updateGenericDocumentEmployee(id: number, employeeId: number | null): Promise<void> {
  await query('UPDATE documents SET employee_id = $1 WHERE id = $2', [employeeId, id]);
}

export async function deleteDocumentUnified(id: number, allowedCompanyIds: number[]): Promise<boolean> {
  const { pool } = await import('../../config/database');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Identify the target document and its storage path
    let storagePath: string | null = null;
    let mainCompanyId: number | null = null;

    // Check generic documents
    const genDoc = await client.query(`
      SELECT file_url as storage_path, company_id
        FROM documents
       WHERE id = $1 AND is_deleted = false
    `, [id]);

    if (genDoc.rows[0]) {
      storagePath = genDoc.rows[0].storage_path;
      mainCompanyId = genDoc.rows[0].company_id;
    } else {
      // Check employee documents
      const empDoc = await client.query(`
        SELECT storage_path, company_id FROM employee_documents 
         WHERE id = $1 AND is_deleted = false
      `, [id]);
      if (empDoc.rows[0]) {
        storagePath = empDoc.rows[0].storage_path;
        mainCompanyId = empDoc.rows[0].company_id;
      }
    }

    if (!storagePath || !mainCompanyId || !allowedCompanyIds.includes(mainCompanyId)) {
      await client.query('ROLLBACK');
      return false;
    }

    // 2. Perform soft-delete in BOTH tables by storage path to ensure unified removal
    // We update is_deleted, deleted_at and updated_at

    // Table: documents
    await client.query(`
      UPDATE documents 
         SET is_deleted = true, deleted_at = NOW(), updated_at = NOW()
       WHERE file_url = $1 AND is_deleted = false
    `, [storagePath]);

    // Table: employee_documents
    await client.query(`
      UPDATE employee_documents 
         SET is_deleted = true, deleted_at = NOW(), updated_at = NOW()
       WHERE storage_path = $1 AND is_deleted = false
    `, [storagePath]);

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('deleteDocumentUnified error:', err);
    throw err;
  } finally {
    client.release();
  }
}

export async function permanentlyDeleteDocument(
  id: number,
  allowedCompanyIds: number[],
  sourceTable?: 'documents' | 'employee_documents'
): Promise<boolean> {
  const { pool } = await import('../../config/database');
  const fs = await import('fs');
  const path = await import('path');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let storagePath: string | null = null;
    let mainCompanyId: number | null = null;

    if (sourceTable === 'documents') {
      const genDoc = await client.query(`SELECT file_url as storage_path, company_id FROM documents WHERE id = $1`, [id]);
      if (genDoc.rows[0]) {
        storagePath = genDoc.rows[0].storage_path;
        mainCompanyId = genDoc.rows[0].company_id;
      }
    } else if (sourceTable === 'employee_documents') {
      const empDoc = await client.query(`SELECT storage_path, company_id FROM employee_documents WHERE id = $1`, [id]);
      if (empDoc.rows[0]) {
        storagePath = empDoc.rows[0].storage_path;
        mainCompanyId = empDoc.rows[0].company_id;
      }
    }

    if (!storagePath || !mainCompanyId) {
      const genDoc = await client.query(`SELECT file_url as storage_path, company_id FROM documents WHERE id = $1`, [id]);
      if (genDoc.rows[0]) {
        storagePath = genDoc.rows[0].storage_path;
        mainCompanyId = genDoc.rows[0].company_id;
      } else {
        const empDoc = await client.query(`SELECT storage_path, company_id FROM employee_documents WHERE id = $1`, [id]);
        if (empDoc.rows[0]) {
          storagePath = empDoc.rows[0].storage_path;
          mainCompanyId = empDoc.rows[0].company_id;
        }
      }
    }

    if (!mainCompanyId || !allowedCompanyIds.includes(mainCompanyId)) {
      await client.query('ROLLBACK');
      return false;
    }

    if (storagePath) {
      await client.query(`DELETE FROM documents WHERE file_url = $1 OR id = $2`, [storagePath, id]);
      await client.query(`DELETE FROM employee_documents WHERE storage_path = $1 OR id = $2`, [storagePath, id]);
    } else {
      await client.query(`DELETE FROM documents WHERE id = $1`, [id]);
      await client.query(`DELETE FROM employee_documents WHERE id = $1`, [id]);
    }

    await client.query('COMMIT');

    if (storagePath) {
      try {
        const absPath = path.resolve(storagePath);
        if (fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
        }
      } catch (fileErr) {
        console.warn('Physical file deletion error (non-fatal):', fileErr);
      }
    }

    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('permanentlyDeleteDocument error:', err);
    throw err;
  } finally {
    client.release();
  }
}

