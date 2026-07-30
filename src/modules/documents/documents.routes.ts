import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireModulePermission, requireRole, enforceCompany } from '../../middleware/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, created, badRequest, forbidden, notFound, conflict } from '../../utils/response';
import {
  getEmployeeDocuments,
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getDocumentById,
  softDeleteDocument,
  updateDocumentVisibility,
  signDocument,
  signGenericDocument,
  createGenericDocument,
  getGenericDocuments,
  updateGenericDocumentEmployee,
  deleteDocumentUnified,
  getDeletedDocuments,
  getOrphanEmployeeDocuments,
  restoreDocument,
  permanentlyDeleteDocument,
} from './documents.service';
import { resolveAllowedCompanyIds, resolveCompanyGroupId } from '../../utils/companyScope';
import { matchEmployeeByFilename, MatchableEmployee, MatchCandidate, MatchOutcome, MatchReason } from './employeeMatcher';
import { isSupportedDocumentFile, mimeTypeForFilename, isArchiveNoise } from './documentFileTypes';
import { query, queryOne, pool } from '../../config/database';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { sendNotification } from '../notifications/notifications.service';
import { t } from '../../utils/i18n';
import { sendDocumentSignatureEmailAutomation } from '../automations/documentSignature';

// Phase 3 placeholder: employee documents, bulk uploads, and e-signature.
// This router is intentionally NOT wired into src/index.ts yet.

const router = Router();

// Enforce module-level permission for all document routes
router.use(authenticate, requireModulePermission('documenti'));

// ---------------------------------------------------------------------------
// Upload directories
// ---------------------------------------------------------------------------

const DOCUMENTS_UPLOAD_DIR = process.env.UPLOADS_DIR
  ? path.join(path.dirname(process.env.UPLOADS_DIR), 'documents')
  : path.join(process.cwd(), 'uploads', 'documents');

fs.mkdirSync(DOCUMENTS_UPLOAD_DIR, { recursive: true });

const DOCUMENTS_SINGLE_DIR = path.join(DOCUMENTS_UPLOAD_DIR, 'single');
const DOCUMENTS_BULK_DIR = path.join(DOCUMENTS_UPLOAD_DIR, 'bulk');

fs.mkdirSync(DOCUMENTS_SINGLE_DIR, { recursive: true });
fs.mkdirSync(DOCUMENTS_BULK_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Multer — single document (10 MB, PDF/JPG/PNG/WebP)
// ---------------------------------------------------------------------------

const allowedDocMime = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
];

const documentsStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DOCUMENTS_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const employeeId = req.params.employeeId || 'unknown';
    const ext = path.extname(file.originalname) || '.bin';
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${employeeId}_${Date.now()}_${safeName}${ext}`);
  },
});

const uploadDocumentMulter = multer({
  storage: documentsStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (allowedDocMime.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('INVALID_FILE_TYPE'));
    }
  },
}).single('file');

const uploadDocumentMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  uploadDocumentMulter(req, res, (err: any) => {
    if (!err) { next(); return; }
    if (err.code === 'LIMIT_FILE_SIZE') {
      badRequest(res, 'Il file supera il limite di 10MB', 'FILE_TOO_LARGE');
      return;
    }
    if (err.message === 'INVALID_FILE_TYPE') {
      badRequest(res, 'Formato file non supportato. Usa PDF o immagini (JPG, PNG, WebP)', 'INVALID_FILE_TYPE');
      return;
    }
    next(err);
  });
};

// ---------------------------------------------------------------------------
// Multer — bulk ZIP upload (50 MB)
// ---------------------------------------------------------------------------

const zipStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DOCUMENTS_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `bulk_${Date.now()}_${safeName}`);
  },
});

const uploadZipMulter = multer({
  storage: zipStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
    if (allowed.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('INVALID_ZIP_TYPE'));
    }
  },
}).single('file');

const uploadZipMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  uploadZipMulter(req, res, (err: any) => {
    if (!err) { next(); return; }
    if (err.code === 'LIMIT_FILE_SIZE') {
      badRequest(res, 'ZIP file too large (max 50MB)', 'FILE_TOO_LARGE');
      return;
    }
    if (err.message === 'INVALID_ZIP_TYPE') {
      badRequest(res, 'Invalid ZIP file type', 'INVALID_FILE_TYPE');
      return;
    }
    next(err);
  });
};

// --- Multer Generic (Step 1) ---

const genericStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DOCUMENTS_SINGLE_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  },
});

const uploadUnifiedMulter = multer({
  storage: genericStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (_req, _file, cb) => {
    // Accept any file; format validation happens gracefully inside the route handler
    cb(null, true);
  },
}).single('file');

const uploadUnifiedMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  uploadUnifiedMulter(req, res, (err: any) => {
    if (!err) { next(); return; }
    if (err.code === 'LIMIT_FILE_SIZE') {
      badRequest(res, 'File too large (max 100MB)', 'FILE_TOO_LARGE');
      return;
    }
    next(err);
  });
};

// --- Step 2 Auto-assignment Logic ---
//
// Matching itself lives in ./employeeMatcher. The rule, agreed with the client:
// auto-assign only on an unambiguous match of BOTH first name and surname;
// anything else stays unassigned for the operator to resolve by hand.

export interface AutoAssignResult {
  matched: boolean;
  outcome: MatchOutcome;
  reason: MatchReason;
  employee: { id: number; name: string; surname: string; companyId: number | null } | null;
  /** Ranked suggestions for the manual step. Never written to the database. */
  suggestions: Array<{
    id: number;
    name: string;
    surname: string;
    companyId: number | null;
    reason: MatchReason;
  }>;
}

const toEmployeeRef = (emp: MatchableEmployee) => ({
  id: emp.id,
  name: emp.name || '',
  surname: emp.surname || '',
  companyId: emp.company_id,
});

export async function performAutoAssign(
  documentId: number,
  filename: string,
  allowedCompanyIds: number[],
  options?: {
    requiresSignature?: boolean;
    expiresAt?: string | null;
    visibleToRoles?: string[];
    uploadedBy?: number;
    employeeId?: number | null;
    isSuperAdmin?: boolean;
    companyId?: number | null;
    simulate?: boolean;
  },
): Promise<AutoAssignResult> {
  // Candidate pool, narrowed to the selected company's group when one is given.
  // Auto-assignment is gated on the company anyway; keeping the pool aligned
  // with the suggestions shown in the wizard means the two can never disagree.
  let poolCompanyIds: number[] = allowedCompanyIds ?? [];
  if (options?.companyId != null) {
    const groupId = await resolveCompanyGroupId(options.companyId);
    if (groupId == null) {
      poolCompanyIds = [options.companyId];
    } else {
      const siblings = await query<{ id: number }>(
        `SELECT id FROM companies WHERE group_id = $1`,
        [groupId],
      );
      const groupIds = siblings.map(r => r.id);
      poolCompanyIds = (allowedCompanyIds && allowedCompanyIds.length > 0)
        ? groupIds.filter(id => allowedCompanyIds.includes(id))
        : groupIds;
      if (!poolCompanyIds.includes(options.companyId)) poolCompanyIds.push(options.companyId);
    }
  }

  let companyFilterSql = '';
  let params: any[] = [];

  if (poolCompanyIds.length > 0) {
    companyFilterSql = 'AND (company_id = ANY($1) OR company_id IS NULL)';
    params = [poolCompanyIds];
  }

  // Candidate pool: real people only. Terminals and admins never hold payslips.
  const employees = await query<MatchableEmployee>(
    `SELECT id, name, surname, unique_id, company_id
       FROM users
      WHERE (status = 'active' OR status IS NULL)
        AND role NOT IN ('admin', 'store_terminal', 'system_admin')
        ${companyFilterSql}`,
    params,
  );

  const match = matchEmployeeByFilename(filename, employees, {
    // The company chosen in the wizard is a hard gate, not a tie-breaker.
    companyId: options?.companyId ?? null,
  });

  // An explicit employee chosen by the operator always wins over automation.
  let providedEmpId: number | null = null;
  if (options?.employeeId !== undefined && options?.employeeId !== null) {
    const parsed = Number(options.employeeId);
    if (Number.isFinite(parsed) && parsed > 0) providedEmpId = parsed;
  }

  const suggestions = match.candidates.slice(0, 8).map((c: MatchCandidate) => ({
    ...toEmployeeRef(c.employee),
    reason: c.reason,
  }));

  let finalEmpId: number | null = providedEmpId;
  let finalCompanyId: number | null = null;
  let resolvedEmployee: { id: number; name: string; surname: string; companyId: number | null } | null = null;

  if (providedEmpId !== null) {
    // An explicitly chosen employee still has to be someone this caller is
    // allowed to file documents for, and must not be an admin or a terminal.
    // Without this check an employee_id from the request body could put a
    // payslip into any company on the platform.
    const empInfo = await queryOne<{ id: number; name: string; surname: string; company_id: number; role: string; status: string | null }>(
      `SELECT id, name, surname, company_id, role, status FROM users WHERE id = $1`,
      [providedEmpId],
    );

    const inScope = !!empInfo
      && empInfo.company_id != null
      && (allowedCompanyIds.length === 0 || allowedCompanyIds.includes(empInfo.company_id));
    const assignableRole = !!empInfo && !['admin', 'store_terminal', 'system_admin'].includes(empInfo.role);

    if (empInfo && inScope && assignableRole) {
      resolvedEmployee = { id: empInfo.id, name: empInfo.name, surname: empInfo.surname, companyId: empInfo.company_id };
      finalCompanyId = empInfo.company_id;
    } else {
      // Refuse the assignment rather than guessing a company for it.
      finalEmpId = null;
      finalCompanyId = options?.companyId ?? (allowedCompanyIds.length > 0 ? allowedCompanyIds[0] : null);
    }
  } else if (match.outcome === 'assigned' && match.employee) {
    finalEmpId = match.employee.id;
    finalCompanyId = match.employee.company_id;
    resolvedEmployee = toEmployeeRef(match.employee);
  }

  const result: AutoAssignResult = {
    matched: !!finalEmpId,
    // Only claim "assigned" when an employee actually survived the checks -
    // a refused employee_id must not be reported as a successful assignment.
    outcome: finalEmpId ? 'assigned' : match.outcome,
    reason: match.reason,
    employee: resolvedEmployee,
    suggestions,
  };

  if (options?.simulate) return result;

  if (finalEmpId && finalCompanyId) {
    const empId = finalEmpId;
    const targetCompanyId = finalCompanyId;

    await query(
      `UPDATE documents SET employee_id = $1, company_id = $2 WHERE id = $3`,
      [empId, targetCompanyId, documentId],
    );

    const doc = await queryOne<{ file_url: string }>(
      `SELECT file_url FROM documents WHERE id = $1`,
      [documentId],
    );

    if (doc) {
      const categoryRow = await queryOne<{ id: number; name: string }>(
        `SELECT id, name FROM document_categories WHERE company_id = $1 AND is_active = true ORDER BY created_at ASC LIMIT 1`,
        [targetCompanyId],
      );
      const autoCategoryId = categoryRow?.id || null;
      const autoCategoryName = categoryRow?.name || null;

      if (autoCategoryName) {
        await query('UPDATE documents SET category = $1 WHERE id = $2', [autoCategoryName, documentId]);
      }

      const mimeType = mimeTypeForFilename(filename);

      const existingEmpDoc = await queryOne<{ id: number }>(
        `SELECT id FROM employee_documents WHERE storage_path = $1 AND deleted_at IS NULL`,
        [doc.file_url],
      );

      if (!existingEmpDoc) {
        await query(
          `INSERT INTO employee_documents (
            company_id, employee_id, category_id, file_name, storage_path, mime_type,
            uploaded_by_user_id, is_visible_to_roles, requires_signature, expires_at
          )
          SELECT $1, $2, $3, $4, d.file_url, $5, $6, d.is_visible_to_roles, d.requires_signature, d.expires_at
            FROM documents d WHERE d.id = $7`,
          [targetCompanyId, empId, autoCategoryId, filename, mimeType, options?.uploadedBy || 0, documentId],
        );
      } else {
        await query(
          `UPDATE employee_documents
              SET company_id = $1, employee_id = $2, category_id = $3, file_name = $4, updated_at = NOW()
            WHERE id = $5`,
          [targetCompanyId, empId, autoCategoryId, filename, existingEmpDoc.id],
        );
      }
    }
  }

  return result;
}


// --- Secure Download Feature ---

// --- Unified Download Route ---
router.get(
  '/:id/download',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      badRequest(res, 'ID documento non valido', 'BAD_REQUEST');
      return;
    }

    const allowedCompanyIds = await resolveAllowedCompanyIds(user);
    const source = req.query.source as 'documents' | 'employee_documents' | undefined;
    const doc = await getDocumentById(id, allowedCompanyIds, user, source);

    if (!doc) {
      notFound(res, 'Documento non trovato o non autorizzato', 'NOT_FOUND');
      return;
    }

    const resolvedPath = path.resolve(doc.storagePath);
    if (!fs.existsSync(resolvedPath)) {
      notFound(res, 'File non trovato sul server', 'FILE_NOT_FOUND');
      return;
    }

    res.download(resolvedPath, doc.fileName);
  }),
);

// --- Manual Assignment & Rename ---

router.put(
  '/:id',
  authenticate,
  requireRole('admin', 'hr'),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const { title, employee_id, requires_signature, expires_at, visible_to_roles, company_id, category } = req.body;

    if (!title) {
      badRequest(res, 'Il titolo è obbligatorio', 'MISSING_TITLE');
      return;
    }

    // 1. Get existing document
    const doc = await queryOne<{
      id: number;
      file_url: string;
      title: string;
      is_visible_to_roles: string[];
      requires_signature: boolean;
      expires_at: string | null;
      company_id: number | null;
      employee_company_id: number | null;
    }>(
      `SELECT d.id, d.file_url, d.title, d.is_visible_to_roles, d.requires_signature, d.expires_at,
              d.company_id, e.company_id AS employee_company_id
         FROM documents d
         LEFT JOIN users e ON e.id = d.employee_id
        WHERE d.id = $1`,
      [id],
    );

    if (!doc) {
      notFound(res, 'Documento non trovato', 'NOT_FOUND');
      return;
    }

    // The caller must already have access to the document they are editing.
    // Without this any admin/HR could edit any document on the platform simply
    // by guessing its id.
    const callerCompanyIds = await resolveAllowedCompanyIds(req.user!);
    const docCompanyId = doc.employee_company_id ?? doc.company_id;
    if (
      callerCompanyIds.length > 0
      && docCompanyId != null
      && !callerCompanyIds.includes(docCompanyId)
    ) {
      notFound(res, 'Documento non trovato', 'NOT_FOUND');
      return;
    }

    // 2. Prepare paths and renaming
    const oldPath = path.resolve(doc.file_url);
    const ext = path.extname(doc.file_url);
    const newTitle = title.toLowerCase().endsWith(ext.toLowerCase()) ? title : `${title}${ext}`;
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, `${Date.now()}_${title.replace(/[^a-zA-Z0-9._-]/g, '_')}${ext}`);

    try {
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath);
      } else {
        // If file doesn't exist, we just update the DB with the expected path
        // but log a warning (or maybe fail? user says "rename file on disk")
        console.warn(`File not found at ${oldPath}, skipping disk rename`);
      }

      // 3. Update DB
      let autoCategoryName: string | null = null;
      let autoCategoryId: number | null = null;
      let targetCompanyId = company_id || req.user!.companyId; // Company from body or user company default

      if (employee_id) {
        // Resolve company and role for the employee
        const emp = await queryOne<{ company_id: number; role: string }>(
          `SELECT company_id, role FROM users WHERE id = $1`,
          [employee_id]
        );

        if (!emp) {
          badRequest(res, 'Dipendente non trovato', 'EMPLOYEE_NOT_FOUND');
          return;
        }

        // Terminals and administrator accounts never hold personal documents.
        if (['admin', 'store_terminal', 'system_admin'].includes(emp.role)) {
          badRequest(res, 'I documenti non possono essere assegnati a questo tipo di utente', 'FORBIDDEN_ASSIGNMENT');
          return;
        }

        // The target employee must be in a company the caller administers.
        if (callerCompanyIds.length > 0 && !callerCompanyIds.includes(emp.company_id)) {
          badRequest(res, 'Il dipendente selezionato appartiene a un\'azienda non accessibile', 'EMPLOYEE_OUT_OF_SCOPE');
          return;
        }

        // The document must not silently migrate to another company: if a
        // company was chosen explicitly, the employee has to belong to it.
        const requestedCompanyId = company_id ? parseInt(String(company_id), 10) : null;
        if (requestedCompanyId && emp.company_id !== requestedCompanyId) {
          badRequest(
            res,
            'Il dipendente selezionato non appartiene all\'azienda scelta per il documento',
            'EMPLOYEE_COMPANY_MISMATCH',
          );
          return;
        }

        targetCompanyId = emp.company_id; // Sync document to employee's company
      }

      // An explicit category always wins. Only fall back to "the company's
      // first category" when the caller did not choose one - otherwise a
      // company with several categories could never keep the operator's pick.
      const requestedCategory = typeof category === 'string' ? category.trim() : '';
      if (requestedCategory) {
        const categoryRow = await queryOne<{ id: number; name: string }>(
          `SELECT id, name FROM document_categories
            WHERE company_id = $1 AND is_active = true AND LOWER(TRIM(name)) = LOWER($2)
            LIMIT 1`,
          [targetCompanyId, requestedCategory],
        );
        if (!categoryRow) {
          badRequest(res, `Categoria non valida per questa azienda: "${requestedCategory}"`, 'INVALID_CATEGORY');
          return;
        }
        autoCategoryId = categoryRow.id;
        autoCategoryName = categoryRow.name;
      } else if (employee_id && targetCompanyId) {
        const categoryRow = await queryOne<{ id: number; name: string }>(
          `SELECT id, name FROM document_categories WHERE company_id = $1 AND is_active = true ORDER BY created_at ASC LIMIT 1`,
          [targetCompanyId],
        );
        autoCategoryId = categoryRow?.id || null;
        autoCategoryName = categoryRow?.name || null;
      }

      // Sync metadata from body if provided, otherwise keep existing
      const finalRequiresSignature = requires_signature !== undefined ? (requires_signature === 'true' || requires_signature === true) : doc.requires_signature;
      const finalExpiresAt = expires_at !== undefined ? (expires_at || null) : doc.expires_at;
      
      let finalVisibleToRolesArr = doc.is_visible_to_roles;
      if (visible_to_roles) {
        try {
          const parsed = JSON.parse(visible_to_roles);
          if (Array.isArray(parsed)) finalVisibleToRolesArr = parsed;
        } catch {
          finalVisibleToRolesArr = String(visible_to_roles).split(',').map(r => r.trim()).filter(Boolean);
        }
      }

      const isConfirming = req.body.confirm === true || req.body.confirm === 'true';

      await query(
        `UPDATE documents
            SET title = $1,
                file_url = $2,
                employee_id = $3,
                category = $4,
                company_id = $5,
                requires_signature = $6,
                expires_at = $7,
                is_visible_to_roles = $8,
                is_confirmed = (is_confirmed = true OR $10::boolean)
          WHERE id = $9`,
        [newTitle, newPath, employee_id || null, autoCategoryName, targetCompanyId || 0, finalRequiresSignature, finalExpiresAt, finalVisibleToRolesArr, id, isConfirming]
      );

      // 4. Migration/Sync to employee_documents ONLY when confirming
      const existing = await queryOne<{ id: number }>(`SELECT id FROM employee_documents WHERE storage_path = $1 AND deleted_at IS NULL`, [doc.file_url]);

      if (employee_id && isConfirming) {
        // Fetch companyId of the employee to ensure multi-tenant safety
        const emp = await queryOne<{ company_id: number }>(
          `SELECT company_id FROM users WHERE id = $1`,
          [employee_id]
        );

        if (emp) {
          const ext = path.extname(doc.file_url).toLowerCase();
          const mimeMap: Record<string, string> = {
            '.pdf': 'application/pdf',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.bin': 'application/octet-stream',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          };
          const mimeType = mimeMap[ext] ?? 'application/octet-stream';

          if (!existing) {
            // New assignment
            await query(
              `INSERT INTO employee_documents (
                company_id, employee_id, category_id, file_name, storage_path, mime_type,
                uploaded_by_user_id, is_visible_to_roles, requires_signature, expires_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [emp.company_id, employee_id, autoCategoryId, newTitle, newPath, mimeType, req.user!.userId, finalVisibleToRolesArr, finalRequiresSignature, finalExpiresAt]
            );
          } else {
            // Re-assignment: Update existing record with NEW company and NEW employee
            await query(
              `UPDATE employee_documents 
                  SET company_id = $1, 
                      employee_id = $2, 
                      category_id = $3, 
                      file_name = $4, 
                      storage_path = $5,
                      requires_signature = $6,
                      expires_at = $7,
                      is_visible_to_roles = $8,
                      updated_at = NOW()
                WHERE id = $9`,
              [emp.company_id, employee_id, autoCategoryId, newTitle, newPath, finalRequiresSignature, finalExpiresAt, finalVisibleToRolesArr, existing.id]
            );
          }

          const shouldNotify = req.body.notify === true || req.body.notify === 'true' || req.body.confirm === true || req.body.confirm === 'true';

          if (shouldNotify) {
            const empRow = await queryOne<{ locale?: string }>(`SELECT locale FROM users WHERE id = $1`, [employee_id]);
            const userLocale = empRow?.locale || 'it';
            const notificationTitle = t(userLocale, finalRequiresSignature ? 'notifications.document_signature_required.title' : 'notifications.document_signature_required.title');
            const notificationMessage = t(userLocale, finalRequiresSignature ? 'notifications.document_signature_required.message' : 'notifications.document_signature_required.message');

            await sendNotification({
              companyId: emp.company_id,
              userId: employee_id,
              type: finalRequiresSignature ? 'document.signature_required' : 'document.assigned',
              title: notificationTitle,
              message: notificationMessage,
              priority: 'high',
              channels: ['in_app']
            });

            sendDocumentSignatureEmailAutomation(
              emp.company_id,
              employee_id,
              newTitle,
              req.user?.companyId
            ).catch(err => console.error('[AUTOMATION] Document signature email error:', err));
          }
        }
      } else if (existing) {
        // Employee removed: soft delete from employee_documents
        await query(`UPDATE employee_documents SET deleted_at = NOW() WHERE id = $1`, [existing.id]);
      }

      ok(res, { success: true, message: 'Documento aggiornato con successo' });
    } catch (err: any) {
      console.error('Update document error:', err);
      badRequest(res, `Errore durante l'aggiornamento: ${err.message}`);
    }
  }),
);



import { isRoleEligibleForModule, isDefaultEnabledForModule } from '../permissions/permission-catalog';

async function hasTeamDocumentsPermission(user: any, companyId: number): Promise<boolean> {
  if (user.is_super_admin) return true;
  if (!isRoleEligibleForModule(user.role, 'team_documents')) return false;

  const row = await queryOne<{ is_enabled: boolean }>(
    `SELECT is_enabled
     FROM role_module_permissions
     WHERE company_id = $1 AND role = $2 AND module_name = 'team_documents'
     LIMIT 1`,
    [companyId, user.role]
  );
  if (!row) {
    return isDefaultEnabledForModule(user.role, 'team_documents');
  }
  return row.is_enabled === true;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get(
  '/',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const { companyId, userId, role, storeId, is_super_admin } = req.user!;
    const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
    const tab = req.query.tab as 'my' | 'team' | undefined;

    if (tab === 'team') {
      const hasPerm = await hasTeamDocumentsPermission(req.user!, companyId!);
      if (!hasPerm) {
        res.status(403).json({ success: false, error: 'Modulo disabilitato per il ruolo', code: 'MODULE_DISABLED' });
        return;
      }
    }

    const docs = await getGenericDocuments({
      companyId: companyId!,
      employeeId: userId,
      role,
      storeId,
      allowedCompanyIds,
      isSuperAdmin: is_super_admin,
      tab,
    });

    // Documents written only into employee_documents (legacy /bulk-upload) are
    // invisible to the query above. Admin, HR and super admin manage the whole
    // company, so for them the team list has to include those too - otherwise
    // part of the platform's documents can never be seen or managed.
    if (tab === 'team' && (role === 'admin' || role === 'hr' || is_super_admin)) {
      const scope = allowedCompanyIds.length > 0
        ? allowedCompanyIds
        : (companyId ? [companyId] : []);
      const orphans = await getOrphanEmployeeDocuments({
        companyIds: scope,
        excludeEmployeeId: userId,
      });
      if (orphans.length > 0) {
        // Key by source + id: the two tables have independent id sequences.
        const seen = new Set(docs.map((d: any) => `${d.sourceTable ?? 'documents'}:${d.id}`));
        for (const orphan of orphans) {
          const key = `employee_documents:${orphan.id}`;
          if (!seen.has(key)) { docs.push(orphan as any); seen.add(key); }
        }
      }
    }

    ok(res, docs);
  }),
);

// ---------------------------------------------------------------------------
// Valid roles for visibility
// ---------------------------------------------------------------------------

const VALID_ROLES = ['admin', 'hr', 'area_manager', 'store_manager', 'employee'];

// ---------------------------------------------------------------------------
// GET /api/documents/my — current user's documents
// ---------------------------------------------------------------------------

router.get(
  '/my',
  authenticate,
  requireModulePermission('documenti', 'read'),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (!user.companyId) {
      res.status(403).json({ success: false, error: 'Accesso negato: azienda non valida', code: 'COMPANY_MISMATCH' });
      return;
    }
    const docs = await getEmployeeDocuments(user.companyId, user.userId, user);
    ok(res, docs);
  }),
);

// ---------------------------------------------------------------------------
// Unified Upload Endpoint
// ---------------------------------------------------------------------------

router.post(
  '/upload',
  authenticate,
  requireRole('admin', 'hr'),
  uploadUnifiedMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      badRequest(res, 'Upload failed: No file received', 'NO_FILE');
      return;
    }

    const { originalname, mimetype, path: tempPath } = req.file;
    const { requires_signature, expires_at, visible_to_roles, employee_id, company_id, extract_zip } = req.body;

    // Detect ZIP by extension or mimetype, and check if we should extract it
    const isZip = (originalname.toLowerCase().endsWith('.zip') ||
      ['application/zip', 'application/x-zip-compressed'].includes(mimetype)) &&
      extract_zip !== 'false';



    const requiresSignature = requires_signature === 'true' || requires_signature === true;
    let visibleToRolesArr: string[] | undefined;
    if (visible_to_roles) {
      try {
        const parsed = JSON.parse(visible_to_roles);
        if (Array.isArray(parsed)) visibleToRolesArr = parsed;
      } catch {
        visibleToRolesArr = String(visible_to_roles).split(',').map(r => r.trim()).filter(Boolean);
      }
    }

    // Determine target company: Super Admin might have null companyId, so we resolve it from target employee if possible
    let baseCompanyId = req.user!.companyId;
    if (company_id && String(company_id) !== 'null' && String(company_id) !== 'undefined') {
      baseCompanyId = parseInt(String(company_id), 10);
    }

    const options = {
      requiresSignature,
      expiresAt: expires_at || null,
      visibleToRoles: visibleToRolesArr,
      uploadedBy: req.user!.userId,
      employeeId: employee_id && String(employee_id) !== 'null' && String(employee_id) !== 'undefined' ? parseInt(String(employee_id), 10) : undefined,
      isSuperAdmin: req.user!.is_super_admin,
      companyId: baseCompanyId ? parseInt(String(baseCompanyId), 10) : undefined
    };

    if (!baseCompanyId && options.employeeId) {
      const emp = await queryOne<{ company_id: number }>(
        `SELECT company_id FROM users WHERE id = $1`,
        [options.employeeId]
      );
      if (emp) baseCompanyId = emp.company_id;
    }

    const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

    if (isZip) {
      // Handle ZIP
      const timestamp = Date.now();
      const extractDir = path.join(DOCUMENTS_BULK_DIR, String(timestamp));
      fs.mkdirSync(extractDir, { recursive: true });

      try {
        const zip = new AdmZip(tempPath);
        zip.extractAllTo(extractDir, true);

        const entries = zip.getEntries();
        const extractedFiles: Array<{
          documentId: number;
          fileName: string;
          size: number;
          mimeType: string;
          matched: boolean;
          outcome: MatchOutcome;
          reason: MatchReason;
          employee: any;
          suggestions: any[];
        }> = [];
        // Entries we deliberately did not import, reported in the summary so a
        // companion .xml no longer silently becomes a "document".
        const skippedFiles: Array<{ fileName: string; size: number; reason: 'unsupported_format' }> = [];
        // Entries that blew up on their own; reported, never fatal to the batch.
        const failedFiles: Array<{ fileName: string; size: number; reason: 'processing_error'; message: string }> = [];
        const seenNames = new Map<string, number>();
        const duplicateFiles: Array<{ fileName: string; firstDocumentId: number }> = [];

        for (const entry of entries) {
          if (entry.isDirectory) continue;
          const entryBasename = entry.name ? entry.name.trim() : '';
          if (isArchiveNoise(entry.entryName, entryBasename)) continue;

          const size = entry.header?.size ?? 0;

          if (!isSupportedDocumentFile(entryBasename)) {
            skippedFiles.push({ fileName: entryBasename, size, reason: 'unsupported_format' });
            continue;
          }

          // Same filename twice in one archive: import both, but flag it - two
          // payslips with the same name usually means a packaging mistake.
          const previous = seenNames.get(entryBasename.toLowerCase());
          if (previous !== undefined) {
            duplicateFiles.push({ fileName: entryBasename, firstDocumentId: previous });
          }

          // Each entry is isolated: one unreadable or corrupt file inside the
          // archive must never fail the other 25. The client explicitly asked
          // for per-file reporting rather than a single pass/fail.
          try {
            const filePath = path.join(extractDir, entry.entryName);
            const doc = await createGenericDocument({
              companyId: baseCompanyId || 0,
              title: entryBasename,
              fileUrl: filePath,
              uploadedBy: req.user!.userId,
              requiresSignature: options.requiresSignature,
              expiresAt: options.expiresAt,
              isVisibleToRoles: options.visibleToRoles,
            });

            if (previous === undefined) seenNames.set(entryBasename.toLowerCase(), doc.id);

            // Simulated so the wizard user reviews and confirms before anything is
            // written to the employee's personal area.
            const autoAssignResult = await performAutoAssign(doc.id, entryBasename, allowedCompanyIds, {
              ...options,
              simulate: true
            });

            extractedFiles.push({
              documentId: doc.id,
              fileName: entryBasename,
              size,
              mimeType: mimeTypeForFilename(entryBasename),
              matched: autoAssignResult.matched,
              outcome: autoAssignResult.outcome,
              reason: autoAssignResult.reason,
              employee: autoAssignResult.employee,
              suggestions: autoAssignResult.suggestions
            });
          } catch (entryErr: any) {
            console.error(`[documents] ZIP entry failed: ${entryBasename}`, entryErr);
            failedFiles.push({
              fileName: entryBasename,
              size,
              reason: 'processing_error',
              message: entryErr?.message ? String(entryErr.message) : 'unknown error',
            });
          }
        }

        ok(res, {
          isZip: true,
          totalEntries: extractedFiles.length + skippedFiles.length + failedFiles.length,
          totalExtracted: extractedFiles.length,
          files: extractedFiles,
          skipped: skippedFiles,
          failed: failedFiles,
          duplicates: duplicateFiles,
          summary: {
            assigned: extractedFiles.filter(f => f.outcome === 'assigned').length,
            ambiguous: extractedFiles.filter(f => f.outcome === 'ambiguous').length,
            unmatched: extractedFiles.filter(f => f.outcome === 'unmatched').length,
            skipped: skippedFiles.length,
            failed: failedFiles.length,
            duplicates: duplicateFiles.length,
          },
          message: `${extractedFiles.length} file(s) extracted from ZIP`
        });
      } catch (err: any) {
        badRequest(res, 'ZIP processing failed: ' + (err.message || ''), 'ZIP_ERROR');
      } finally {
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
        }
      }
    } else {
      // Handle Single File
      if (!isSupportedDocumentFile(originalname)) {
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
        }
        ok(res, {
          isZip: false,
          totalEntries: 1,
          totalExtracted: 0,
          files: [],
          skipped: [{ fileName: originalname, size: req.file.size ?? 0, reason: 'unsupported_format' }],
          duplicates: [],
          message: `File ${originalname} non supportato ed è stato ignorato`
        });
        return;
      }

      const destPath = path.join(DOCUMENTS_SINGLE_DIR, req.file.filename);
      fs.renameSync(tempPath, destPath);

      const doc = await createGenericDocument({
        companyId: baseCompanyId || 0,
        title: originalname,
        fileUrl: destPath,
        uploadedBy: req.user!.userId,
        requiresSignature: options.requiresSignature,
        expiresAt: options.expiresAt,
        isVisibleToRoles: options.visibleToRoles,
      });

      // Rule based auto-assignment (simulated, no DB write)
      const autoAssignResult = await performAutoAssign(doc.id, originalname, allowedCompanyIds, {
        ...options,
        simulate: true
      });

      ok(res, {
        matched: autoAssignResult.matched,
        documentId: doc.id,
        fileName: originalname,
        size: req.file.size ?? 0,
        mimeType: mimeTypeForFilename(originalname),
        outcome: autoAssignResult.outcome,
        reason: autoAssignResult.reason,
        employee: autoAssignResult.employee,
        suggestions: autoAssignResult.suggestions
      });
    }

  }),
);

// ---------------------------------------------------------------------------
// POST /api/documents/cleanup-drafts
// ---------------------------------------------------------------------------

router.post(
  '/cleanup-drafts',
  authenticate,
  requireRole('admin', 'hr'),
  asyncHandler(async (req: Request, res: Response) => {
    const { documentIds } = req.body as { documentIds?: number[] };
    if (Array.isArray(documentIds) && documentIds.length > 0) {
      await query(
        `DELETE FROM documents WHERE id = ANY($1) AND (is_confirmed = false OR is_confirmed IS NULL)`,
        [documentIds]
      );
    }
    ok(res, { success: true });
  })
);

// ---------------------------------------------------------------------------
// POST /api/documents/match-preview
//
// Re-evaluate document matching against a company without persisting
// anything. Needed because the company chosen in step 2 is a hard gate on
// auto-assignment: if the operator changes company after the files were
// uploaded, the matches computed at upload time are no longer valid.
// ---------------------------------------------------------------------------

router.post(
  '/match-preview',
  authenticate,
  requireRole('admin', 'hr'),
  asyncHandler(async (req: Request, res: Response) => {
    const { files, company_id } = req.body as {
      files?: Array<{ documentId?: number; fileName?: string; document_id?: number; file_name?: string }>;
      company_id?: number | string | null;
    };

    if (!Array.isArray(files) || files.length === 0) {
      badRequest(res, 'Nessun file da analizzare', 'NO_FILES');
      return;
    }

    // The web client runs every request body through a camelCase -> snake_case
    // transform, so what arrives here is { document_id, file_name }. Accept both
    // spellings: reading only the camelCase form silently produced an empty
    // filename for every entry, and the matcher then answered "not_a_name".
    const readEntry = (f: typeof files[number]) => ({
      documentId: f?.documentId ?? f?.document_id ?? null,
      fileName: String(f?.fileName ?? f?.file_name ?? ''),
    });

    const companyId =
      company_id !== undefined && company_id !== null && String(company_id) !== 'null'
        ? parseInt(String(company_id), 10)
        : null;

    const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);

    /**
     * Candidate pool. Once a company is chosen, suggestions are restricted to
     * that company's GROUP rather than the whole platform - a super admin can
     * reach every company, but showing them all of it turns "did you mean" into
     * noise and invites a mis-assignment across unrelated tenants. Standalone
     * companies (no group) resolve to themselves alone.
     */
    let poolCompanyIds: number[] = allowedCompanyIds;
    if (companyId != null) {
      const groupId = await resolveCompanyGroupId(companyId);
      if (groupId == null) {
        poolCompanyIds = [companyId];
      } else {
        const siblings = await query<{ id: number }>(
          `SELECT id FROM companies WHERE group_id = $1`,
          [groupId],
        );
        const groupIds = siblings.map(r => r.id);
        // Never widen beyond what the caller may already see.
        poolCompanyIds = allowedCompanyIds.length > 0
          ? groupIds.filter(id => allowedCompanyIds.includes(id))
          : groupIds;
        if (!poolCompanyIds.includes(companyId)) poolCompanyIds.push(companyId);
      }
    }

    const unscopedPool = poolCompanyIds.length === 0;

    const employees = await query<MatchableEmployee>(
      `SELECT id, name, surname, unique_id, company_id
         FROM users
        WHERE (status = 'active' OR status IS NULL)
          AND role NOT IN ('admin', 'store_terminal', 'system_admin')
          ${unscopedPool ? '' : 'AND (company_id = ANY($1) OR company_id IS NULL)'}`,
      unscopedPool ? [] : [poolCompanyIds],
    );

    const results = files.map((f) => {
      const { documentId, fileName } = readEntry(f);
      const match = matchEmployeeByFilename(fileName, employees, { companyId });
      return {
        documentId,
        fileName,
        matched: match.outcome === 'assigned',
        outcome: match.outcome,
        reason: match.reason,
        employee: match.employee
          ? {
              id: match.employee.id,
              name: match.employee.name || '',
              surname: match.employee.surname || '',
              companyId: match.employee.company_id,
            }
          : null,
        suggestions: match.candidates.slice(0, 8).map((c) => ({
          id: c.employee.id,
          name: c.employee.name || '',
          surname: c.employee.surname || '',
          companyId: c.employee.company_id,
          reason: c.reason,
        })),
      };
    });

    ok(res, { files: results });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/documents/categories
// ---------------------------------------------------------------------------

router.get(
  '/categories',
  authenticate,
  requireModulePermission('documenti', 'read'),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const allowedCompanyIds = await resolveAllowedCompanyIds(user);

    if (allowedCompanyIds.length === 0) {
      ok(res, []);
      return;
    }

    // Only admin/hr may see inactive categories
    const canSeeInactive = ['admin', 'hr'].includes(user.role) || user.is_super_admin === true;
    const includeInactive = canSeeInactive && req.query.include_inactive === 'true';

    const categories = await getCategories(allowedCompanyIds, includeInactive);
    ok(res, categories);
  }),
);

// ---------------------------------------------------------------------------
// POST /api/documents/categories
// ---------------------------------------------------------------------------

router.post(
  '/categories',
  authenticate,
  requireRole('admin', 'hr'),
  enforceCompany,
  asyncHandler(async (req: Request, res: Response) => {
    const { name, company_id } = req.body as { name?: string; company_id?: number };

    // enforceCompany already ensures req.body.company_id is valid and accessible,
    // or falls back to req.user.companyId if not provided.
    const targetCompanyId = company_id || req.user!.companyId;
    if (!targetCompanyId) {
      badRequest(res, 'ID azienda mancante', 'MISSING_COMPANY_ID');
      return;
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      badRequest(res, 'Il nome della categoria è obbligatorio', 'VALIDATION_ERROR');
      return;
    }
    if (name.trim().length > 100) {
      badRequest(res, 'Il nome della categoria non può superare i 100 caratteri', 'VALIDATION_ERROR');
      return;
    }

    const trimmedName = name.trim();

    // A company may have as many categories as it likes; what it may not have
    // is two categories with the same name. The previous check tested only
    // `company_id`, so once a company had any category at all, creating another
    // one always failed with "this company already has a category".
    const duplicate = await queryOne<{ id: number; name: string; is_active: boolean }>(
      `SELECT id, name, is_active
         FROM document_categories
        WHERE company_id = $1
          AND LOWER(TRIM(name)) = LOWER($2)
        LIMIT 1`,
      [targetCompanyId, trimmedName],
    );

    if (duplicate) {
      conflict(
        res,
        duplicate.is_active
          ? `Esiste già una categoria chiamata "${duplicate.name}" per questa azienda. Scegli un nome diverso.`
          : `Esiste già una categoria chiamata "${duplicate.name}" per questa azienda, ma è disattivata. Riattivala invece di crearne una nuova.`,
        'CATEGORY_NAME_EXISTS',
      );
      return;
    }

    // Was this company's first category? If so - and only then - adopt the
    // documents that have no category yet, which is what the original
    // behaviour intended. Doing this for every new category would sweep
    // unrelated documents into whatever was created last.
    const existingCount = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM document_categories WHERE company_id = $1`,
      [targetCompanyId],
    );
    const isFirstCategory = Number(existingCount?.count ?? '0') === 0;

    const category = await createCategory(targetCompanyId, trimmedName);

    if (isFirstCategory) {
      await query(
        `UPDATE employee_documents
            SET category_id = $1
          WHERE company_id = $2 AND category_id IS NULL AND deleted_at IS NULL`,
        [category.id, targetCompanyId],
      );
      await query(
        `UPDATE documents d
            SET category = $1
           FROM users u
          WHERE d.employee_id = u.id
            AND u.company_id = $2
            AND d.category IS NULL`,
        [category.name, targetCompanyId],
      );
    }

    created(res, category, 'Categoria creata con successo');
  }),
);

// ---------------------------------------------------------------------------
// PATCH /api/documents/categories/:id
// ---------------------------------------------------------------------------

router.patch(
  '/categories/:id',
  authenticate,
  requireRole('admin', 'hr'),
  enforceCompany,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      badRequest(res, 'ID categoria non valido', 'BAD_REQUEST');
      return;
    }

    const { name, is_active, company_id, current_company_id } = req.body as {
      name?: string;
      is_active?: boolean;
      company_id?: number;
      current_company_id?: number;
    };

    const sourceCompanyId = current_company_id || req.user!.companyId;
    const destinationCompanyId = company_id;

    if (!sourceCompanyId) {
      badRequest(res, 'ID azienda sorgente mancante', 'MISSING_SOURCE_COMPANY_ID');
      return;
    }

    // enforceCompany already validated company_id (destination) if present.
    // We also need to ensure the user has access to sourceCompanyId if it's different.
    if (sourceCompanyId !== (company_id || req.user!.companyId)) {
      const allowed = await resolveAllowedCompanyIds(req.user!);
      if (!allowed.includes(sourceCompanyId)) {
        forbidden(res, 'Accesso negato all\'azienda sorgente');
        return;
      }
    }

    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      badRequest(res, 'Il nome della categoria non può essere vuoto', 'VALIDATION_ERROR');
      return;
    }

    // The category being changed, so we know its old name and can reject a
    // rename that would collide with another category of the same company.
    const before = await queryOne<{ name: string; company_id: number }>(
      `SELECT name, company_id FROM document_categories WHERE id = $1 AND company_id = $2`,
      [id, sourceCompanyId],
    );

    if (!before) {
      notFound(res, 'Categoria non trovata per l\'azienda specificata', 'NOT_FOUND');
      return;
    }

    if (name !== undefined) {
      const targetCompany = destinationCompanyId ?? before.company_id;
      const clash = await queryOne<{ name: string }>(
        `SELECT name FROM document_categories
          WHERE company_id = $1
            AND LOWER(TRIM(name)) = LOWER($2)
            AND id <> $3
          LIMIT 1`,
        [targetCompany, name.trim(), id],
      );
      if (clash) {
        conflict(
          res,
          `Esiste già una categoria chiamata "${clash.name}" per questa azienda. Scegli un nome diverso.`,
          'CATEGORY_NAME_EXISTS',
        );
        return;
      }
    }

    const updated = await updateCategory(id, sourceCompanyId, {
      name: name !== undefined ? name.trim() : undefined,
      isActive: is_active,
      companyId: destinationCompanyId,
    });

    if (!updated) {
      notFound(res, 'Categoria non trovata per l\'azienda specificata', 'NOT_FOUND');
      return;
    }

    if (name !== undefined && before.name !== updated.name) {
      // Re-label only the documents that were in THIS category. The previous
      // query matched every document of the company, so renaming one category
      // silently relabelled all the others too.
      await query(
        `UPDATE documents d
             SET category = $1
            FROM users u
           WHERE d.employee_id = u.id
             AND u.company_id = $2
             AND d.category = $3`,
        [updated.name, updated.companyId, before.name],
      );
      // Documents not linked to an employee are scoped by company_id instead.
      await query(
        `UPDATE documents
             SET category = $1
           WHERE employee_id IS NULL
             AND company_id = $2
             AND category = $3`,
        [updated.name, updated.companyId, before.name],
      );
    }

    ok(res, updated, 'Categoria aggiornata con successo');
  }),
);

// ---------------------------------------------------------------------------
// DELETE /api/documents/categories/:id
// ---------------------------------------------------------------------------

router.delete(
  '/categories/:id',
  authenticate,
  requireRole('admin', 'hr'),
  enforceCompany,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      badRequest(res, 'ID categoria non valido', 'BAD_REQUEST');
      return;
    }

    const companyId = req.body.current_company_id || req.query.current_company_id || req.user!.companyId;
    if (!companyId) {
      badRequest(res, 'ID azienda mancante', 'MISSING_COMPANY_ID');
      return;
    }

    const deleted = await deleteCategory(id, companyId);
    if (!deleted) {
      notFound(res, 'Categoria non trovata', 'NOT_FOUND');
      return;
    }

    ok(res, { id }, 'Categoria eliminata con successo');
  }),
);

// ---------------------------------------------------------------------------
// POST /api/documents/bulk-upload
// ---------------------------------------------------------------------------

router.post(
  '/bulk-upload',
  authenticate,
  requireRole('admin', 'hr'),
  uploadZipMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (!user.companyId) {
      if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
      res.status(403).json({ success: false, error: 'Accesso negato: azienda non valida', code: 'COMPANY_MISMATCH' });
      return;
    }

    if (!req.file) {
      badRequest(res, 'Nessun file ricevuto', 'NO_FILE');
      return;
    }

    // Extra mime-type guard (some clients send application/octet-stream for zip)
    const zipMimes = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
    const isZipByName = req.file.originalname.toLowerCase().endsWith('.zip');
    if (!zipMimes.includes(req.file.mimetype) && !isZipByName) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      badRequest(res, 'Formato non supportato. Carica un file ZIP', 'INVALID_FILE_TYPE');
      return;
    }

    const allowedCompanyIds = await resolveAllowedCompanyIds(user);

    // Insert upload record
    const uploadRow = await queryOne<{ id: number }>(
      `INSERT INTO bulk_document_uploads
         (company_id, uploaded_by_id, original_name, storage_path, status)
       VALUES ($1, $2, $3, $4, 'processing')
       RETURNING id`,
      [user.companyId, user.userId, req.file.originalname, req.file.path],
    );
    const uploadId = uploadRow!.id;

    try {
      const zip = new AdmZip(req.file.path);
      const entries = zip.getEntries().filter((e) => !e.isDirectory);

      let matchedFiles = 0;
      let unmatchedFiles = 0;
      const unmatchedFileNames: string[] = [];
      const skippedFileNames: string[] = [];

      // Single source of truth for matching - this route used to carry its own
      // exact-match implementation ending in LIMIT 1, which silently picked one
      // of several homonyms. It now shares the engine used by /upload.
      const candidatePool = await query<MatchableEmployee>(
        `SELECT id, name, surname, unique_id, company_id
           FROM users
          WHERE (status = 'active' OR status IS NULL)
            AND role NOT IN ('admin', 'store_terminal', 'system_admin')
            AND company_id = ANY($1)`,
        [allowedCompanyIds],
      );

      for (const entry of entries) {
        const origName = entry.entryName.split('/').pop() ?? entry.entryName;

        if (isArchiveNoise(entry.entryName, origName)) continue;

        if (!isSupportedDocumentFile(origName)) {
          await queryOne<{ id: number }>(
            `INSERT INTO bulk_document_files
               (bulk_upload_id, original_file_name, status, error_message)
             VALUES ($1, $2, 'skipped', 'unsupported_format')
             RETURNING id`,
            [uploadId, origName],
          );
          skippedFileNames.push(origName);
          continue;
        }

        const match = matchEmployeeByFilename(origName, candidatePool, { companyId: user.companyId });
        // Ambiguous and partial matches deliberately fall through to unmatched.
        const matchedEmployeeId: number | null =
          match.outcome === 'assigned' && match.employee ? match.employee.id : null;

        if (matchedEmployeeId !== null) {
          // Extract and save file
          const fileBytes = entry.getData();
          const destFileName = `${uploadId}_${origName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          const destPath = path.join(DOCUMENTS_UPLOAD_DIR, destFileName);
          fs.writeFileSync(destPath, fileBytes);

          const mimeType = mimeTypeForFilename(origName);

          // Fetch company_id for the matched employee
          const empRow = await queryOne<{ company_id: number }>(
            `SELECT company_id FROM users WHERE id = $1`,
            [matchedEmployeeId],
          );

          if (empRow) {
            await queryOne<{ id: number }>(
              `INSERT INTO employee_documents
                 (company_id, employee_id, file_name, storage_path, mime_type, uploaded_by_user_id)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id`,
              [empRow.company_id, matchedEmployeeId, origName, destPath, mimeType, user.userId],
            );
          }

          await queryOne<{ id: number }>(
            `INSERT INTO bulk_document_files
               (bulk_upload_id, original_file_name, employee_id, storage_path, status)
             VALUES ($1, $2, $3, $4, 'matched')
             RETURNING id`,
            [uploadId, origName, matchedEmployeeId, destPath],
          );

          matchedFiles++;
        } else {
          // Unmatched, ambiguous, or matched only on one field - all of which
          // require a human decision rather than a guess.
          await queryOne<{ id: number }>(
            `INSERT INTO bulk_document_files
               (bulk_upload_id, original_file_name, employee_identifier, status, error_message)
             VALUES ($1, $2, $3, 'unmatched', $4)
             RETURNING id`,
            [uploadId, origName, match.candidates[0] ? String(match.candidates[0].employee.id) : null, match.reason],
          );
          unmatchedFiles++;
          unmatchedFileNames.push(origName);
        }
      }

      const totalFiles = entries.length;

      // Update summary
      await queryOne<{ id: number }>(
        `UPDATE bulk_document_uploads
            SET total_files = $2, matched_files = $3, unmatched_files = $4,
                status = 'completed', updated_at = NOW()
          WHERE id = $1
          RETURNING id`,
        [uploadId, totalFiles, matchedFiles, unmatchedFiles],
      );

      ok(res, {
        uploadId,
        totalFiles,
        matchedFiles,
        unmatchedFiles,
        unmatchedFileNames,
        skippedFiles: skippedFileNames.length,
        skippedFileNames,
      });
    } catch (err: any) {
      await queryOne<{ id: number }>(
        `UPDATE bulk_document_uploads
            SET status = 'failed', error_message = $2, updated_at = NOW()
          WHERE id = $1
          RETURNING id`,
        [uploadId, err?.message ?? 'Errore sconosciuto'],
      );
      throw err;
    }
  }),
);

// ---------------------------------------------------------------------------
// GET /api/documents/bulk-upload/:uploadId/report
// ---------------------------------------------------------------------------

router.get(
  '/bulk-upload/:uploadId/report',
  authenticate,
  requireRole('admin', 'hr'),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (!user.companyId) {
      res.status(403).json({ success: false, error: 'Accesso negato: azienda non valida', code: 'COMPANY_MISMATCH' });
      return;
    }

    const uploadId = parseInt(req.params.uploadId, 10);
    if (Number.isNaN(uploadId)) {
      badRequest(res, 'ID upload non valido', 'BAD_REQUEST');
      return;
    }

    const allowedCompanyIds = await resolveAllowedCompanyIds(user);

    const uploadRow = await queryOne<{
      id: number;
      company_id: number;
      uploaded_by_id: number;
      original_name: string;
      storage_path: string;
      status: string;
      total_files: number | null;
      matched_files: number | null;
      unmatched_files: number | null;
      error_message: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, company_id, uploaded_by_id, original_name, storage_path,
              status, total_files, matched_files, unmatched_files, error_message,
              created_at, updated_at
         FROM bulk_document_uploads
        WHERE id = $1`,
      [uploadId],
    );

    if (!uploadRow) {
      notFound(res, 'Upload non trovato', 'NOT_FOUND');
      return;
    }

    if (!allowedCompanyIds.includes(uploadRow.company_id)) {
      forbidden(res, 'Accesso negato');
      return;
    }

    const files = await query<{
      id: number;
      bulk_upload_id: number;
      original_file_name: string;
      employee_id: number | null;
      employee_identifier: string | null;
      storage_path: string | null;
      status: string;
      error_message: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, bulk_upload_id, original_file_name, employee_id,
              employee_identifier, storage_path, status, error_message,
              created_at, updated_at
         FROM bulk_document_files
        WHERE bulk_upload_id = $1
        ORDER BY id ASC`,
      [uploadId],
    );

    ok(res, {
      upload: {
        id: uploadRow.id,
        companyId: uploadRow.company_id,
        uploadedById: uploadRow.uploaded_by_id,
        originalName: uploadRow.original_name,
        status: uploadRow.status,
        totalFiles: uploadRow.total_files,
        matchedFiles: uploadRow.matched_files,
        unmatchedFiles: uploadRow.unmatched_files,
        errorMessage: uploadRow.error_message,
        createdAt: uploadRow.created_at,
        updatedAt: uploadRow.updated_at,
      },
      files: files.map((f) => ({
        id: f.id,
        bulkUploadId: f.bulk_upload_id,
        originalFileName: f.original_file_name,
        employeeId: f.employee_id,
        employeeIdentifier: f.employee_identifier,
        status: f.status,
        errorMessage: f.error_message,
        createdAt: f.created_at,
        updatedAt: f.updated_at,
      })),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/documents/employee/:employeeId — HR/Admin view of employee docs
// ---------------------------------------------------------------------------

router.get(
  '/employee/:employeeId',
  authenticate,
  requireModulePermission('documenti', 'read'),
  asyncHandler(async (req: Request, res: Response) => {
    const { user } = req;
    if (!user) {
      res.status(401).json({ success: false, error: 'Non autenticato', code: 'NOT_AUTHENTICATED' });
      return;
    }

    const isAdminOrHr = ['admin', 'hr'].includes(user.role) || user.is_super_admin === true;
    const isAreaManager = user.role === 'area_manager';
    const isStoreManager = user.role === 'store_manager';

    if (!isAdminOrHr && !isAreaManager && !isStoreManager) {
      res.status(403).json({ success: false, error: 'Accesso negato', code: 'FORBIDDEN' });
      return;
    }

    const employeeId = parseInt(req.params.employeeId, 10);
    if (Number.isNaN(employeeId)) {
      res.status(400).json({ success: false, error: 'ID dipendente non valido', code: 'BAD_REQUEST' });
      return;
    }

    const employee = await queryOne<{ company_id: number }>(
      'SELECT company_id FROM users WHERE id = $1',
      [employeeId],
    );

    if (!employee) {
      res.status(404).json({ success: false, error: 'Dipendente non trovato', code: 'NOT_FOUND' });
      return;
    }

    const allowedCompanyIds = await resolveAllowedCompanyIds(user);
    if (!allowedCompanyIds.includes(employee.company_id)) {
      res.status(403).json({ success: false, error: 'Accesso negato: azienda non valida', code: 'COMPANY_MISMATCH' });
      return;
    }

    const hasCrossCompanyAccess = allowedCompanyIds.length > 1;

    // Scoped check for managers: skip if caller has cross-company access.
    // Area managers follow the same employee-detail scope and may open
    // document tabs for employees visible in their allowed company scope.
    if (!isAdminOrHr && !hasCrossCompanyAccess) {
      if (isStoreManager && user.storeId) {
        const inStore = await queryOne(`SELECT id FROM users WHERE id = $1 AND store_id = $2`, [employeeId, user.storeId]);
        if (!inStore) {
          res.status(403).json({ success: false, error: 'Non autorizzato: dipendente fuori ambito', code: 'FORBIDDEN' });
          return;
        }
      }
    }

    const docs = await getEmployeeDocuments(employee.company_id, employeeId, user);
    ok(res, docs);
  }),
);

// ---------------------------------------------------------------------------
// POST /api/documents/employee/:employeeId — upload a document for an employee
// ---------------------------------------------------------------------------

router.post(
  '/employee/:employeeId',
  authenticate,
  requireModulePermission('documenti', 'read'),
  uploadDocumentMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    const { user } = req;
    if (!user) {
      res.status(401).json({ success: false, error: 'Non autenticato', code: 'NOT_AUTHENTICATED' });
      return;
    }

    if (!['admin', 'hr', 'area_manager', 'store_manager'].includes(user.role)) {
      if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
      forbidden(res, 'Accesso negato');
      return;
    }

    const employeeId = parseInt(req.params.employeeId, 10);
    if (Number.isNaN(employeeId)) {
      if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
      badRequest(res, 'ID dipendente non valido', 'BAD_REQUEST');
      return;
    }

    if (!req.file) {
      badRequest(res, 'Nessun file ricevuto', 'NO_FILE');
      return;
    }

    const employee = await queryOne<{ company_id: number }>(
      'SELECT company_id FROM users WHERE id = $1',
      [employeeId],
    );

    if (!employee) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      notFound(res, 'Dipendente non trovato', 'NOT_FOUND');
      return;
    }

    const allowedCompanyIds = await resolveAllowedCompanyIds(user);
    if (!allowedCompanyIds.includes(employee.company_id)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      forbidden(res, 'Accesso negato: azienda non valida', 'COMPANY_MISMATCH');
      return;
    }

    const { originalname, mimetype, path: storagePath } = req.file;

    const { requires_signature, expires_at, visible_to_roles } = req.body;
    const requiresSignature = requires_signature === 'true' || requires_signature === true;



    const expiresAt: string | null = expires_at ? String(expires_at) : null;

    // Fetch first active category for the company automatically
    const categoryRow = await queryOne<{ id: number }>(
      `SELECT id FROM document_categories WHERE company_id = $1 AND is_active = true ORDER BY created_at ASC LIMIT 1`,
      [employee.company_id]
    );
    const autoCategoryId = categoryRow?.id || null;

    // Parse visible_to_roles: accept comma-separated string or JSON array string
    let visibleToRoles: string[] | null = null;
    if (visible_to_roles) {
      try {
        const parsed = JSON.parse(visible_to_roles);
        if (Array.isArray(parsed)) visibleToRoles = parsed;
      } catch {
        visibleToRoles = String(visible_to_roles).split(',').map((r) => r.trim()).filter(Boolean);
      }
    }

    const insertResult = await queryOne<{ id: number }>(
      `INSERT INTO employee_documents (
         company_id, employee_id, category_id, file_name, storage_path, mime_type,
         uploaded_by_user_id, requires_signature, expires_at, is_visible_to_roles
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        employee.company_id,
        employeeId,
        autoCategoryId,
        originalname,
        storagePath,
        mimetype,
        user.userId,
        requiresSignature,
        expiresAt,
        visibleToRoles || ['admin', 'hr', 'area_manager', 'store_manager', 'employee'],
      ],
    );
    ok(res, { id: insertResult?.id ?? null, fileName: originalname }, 'Documento caricato');
  }),
);


// ---------------------------------------------------------------------------
// DELETE /api/documents/:id — soft delete
// ---------------------------------------------------------------------------

router.delete(
  '/:id',
  authenticate,
  requireRole('admin', 'hr'),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (!user.companyId) {
      res.status(403).json({ success: false, error: 'Accesso negato: azienda non valida', code: 'COMPANY_MISMATCH' });
      return;
    }

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      badRequest(res, 'ID documento non valido', 'BAD_REQUEST');
      return;
    }

    const allowedCompanyIds = await resolveAllowedCompanyIds(user);

    const deleted = await deleteDocumentUnified(id, allowedCompanyIds);
    if (deleted) {
      ok(res, { id }, 'Documento eliminato con successo');
      return;
    }

    notFound(res, 'Documento non trovato o già eliminato');
  }),
);

// ---------------------------------------------------------------------------
// GET /api/documents/trash — fetch trash bin
// ---------------------------------------------------------------------------

router.get(
  '/trash',
  authenticate,
  requireModulePermission('documenti', 'read'),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const allowedCompanyIds = await resolveAllowedCompanyIds(user);
    if (!user.is_super_admin && allowedCompanyIds.length === 0) {
      res.status(403).json({ success: false, error: 'Accesso negato: nessuna azienda autorizzata', code: 'COMPANY_MISMATCH' });
      return;
    }

    const tab = req.query.tab as 'my' | 'team' | undefined;
    if (tab === 'team') {
      const hasPerm = await hasTeamDocumentsPermission(user, user.companyId!);
      if (!hasPerm) {
        res.status(403).json({ success: false, error: 'Modulo disabilitato per il ruolo', code: 'MODULE_DISABLED' });
        return;
      }
    }
    const employeeId = req.query.employee_id ? parseInt(req.query.employee_id as string, 10) : undefined;
    const docs = await getDeletedDocuments(allowedCompanyIds, employeeId, tab, user.userId);
    ok(res, docs);
  }),
);

// ---------------------------------------------------------------------------
// POST /api/documents/:source/:id/restore — recover a soft-deleted document
// ---------------------------------------------------------------------------

router.post(
  '/:source/:id/restore',
  authenticate,
  requireRole('admin', 'hr'),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const allowedCompanyIds = await resolveAllowedCompanyIds(user);
    if (!user.is_super_admin && allowedCompanyIds.length === 0) {
      res.status(403).json({ success: false, error: 'Accesso negato: nessuna azienda autorizzata', code: 'COMPANY_MISMATCH' });
      return;
    }

    const id = parseInt(req.params.id, 10);
    const source = req.params.source as 'documents' | 'employee_documents';

    if (Number.isNaN(id)) {
      badRequest(res, 'ID documento non valido', 'BAD_REQUEST');
      return;
    }

    if (source !== 'documents' && source !== 'employee_documents') {
      badRequest(res, 'Sorgente documento non valida', 'INVALID_SOURCE');
      return;
    }

    const restored = await restoreDocument(id, allowedCompanyIds, user.userId, source);
    if (restored) {
      ok(res, { id }, 'Documento ripristinato con successo');
      return;
    }

    notFound(res, 'Documento non trovato nel cestino o già ripristinato');
  }),
);

// ---------------------------------------------------------------------------
// DELETE /api/documents/:id/permanent — permanently delete document (admin only)
// ---------------------------------------------------------------------------

router.delete(
  '/:id/permanent',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const allowedCompanyIds = await resolveAllowedCompanyIds(user);
    if (!user.is_super_admin && allowedCompanyIds.length === 0) {
      res.status(403).json({ success: false, error: 'Accesso negato: nessuna azienda autorizzata', code: 'COMPANY_MISMATCH' });
      return;
    }

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      badRequest(res, 'ID documento non valido', 'BAD_REQUEST');
      return;
    }

    const source = req.query.source as 'documents' | 'employee_documents' | undefined;

    const deleted = await permanentlyDeleteDocument(id, allowedCompanyIds, source);
    if (deleted) {
      ok(res, { id }, 'Documento eliminato definitivamente');
      return;
    }

    notFound(res, 'Documento non trovato o non autorizzato');
  }),
);

// ---------------------------------------------------------------------------
// PATCH /api/documents/:id/visibility
// ---------------------------------------------------------------------------

router.patch(
  '/:id/visibility',
  authenticate,
  requireRole('admin', 'hr'),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    if (!user.companyId) {
      res.status(403).json({ success: false, error: 'Accesso negato: azienda non valida', code: 'COMPANY_MISMATCH' });
      return;
    }

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      badRequest(res, 'ID documento non valido', 'BAD_REQUEST');
      return;
    }

    const { roles } = req.body as { roles?: string[] };
    if (!Array.isArray(roles) || roles.length === 0) {
      badRequest(res, 'Il campo roles è obbligatorio e deve essere un array non vuoto', 'VALIDATION_ERROR');
      return;
    }

    const invalidRoles = roles.filter((r) => !VALID_ROLES.includes(r));
    if (invalidRoles.length > 0) {
      badRequest(res, `Ruoli non validi: ${invalidRoles.join(', ')}`, 'INVALID_ROLES');
      return;
    }

    const allowedCompanyIds = await resolveAllowedCompanyIds(user);

    // Collision-aware lookup for visibility update
    let docData: { id: number; company_id: number; source: 'employee_documents' | 'documents' } | null = null;

    const empDoc = await queryOne<{ id: number; company_id: number }>(
      `SELECT id, company_id FROM employee_documents WHERE id = $1 AND company_id = ANY($2) AND deleted_at IS NULL`,
      [id, allowedCompanyIds],
    );

    if (empDoc) {
      docData = { id: empDoc.id, company_id: empDoc.company_id, source: 'employee_documents' };
    } else {
      const genDoc = await queryOne<{ id: number; company_id: number }>(
        `SELECT id, company_id FROM documents WHERE id = $1 AND company_id = ANY($2)`,
        [id, allowedCompanyIds],
      );
      if (genDoc) {
        docData = { id: genDoc.id, company_id: genDoc.company_id, source: 'documents' };
      }
    }

    if (!docData) {
      notFound(res, 'Documento non trovato', 'NOT_FOUND');
      return;
    }

    let updated = false;
    if (docData.source === 'employee_documents') {
      updated = await updateDocumentVisibility(id, docData.company_id, roles);
    } else {
      // Update generic document visibility
      await query(`UPDATE documents SET is_visible_to_roles = $1 WHERE id = $2`, [roles, id]);
      updated = true;
    }

    if (!updated) {
      notFound(res, 'Documento non trovato per l\'aggiornamento', 'NOT_FOUND');
      return;
    }

    ok(res, { id, isVisibleToRoles: roles }, 'Visibilità aggiornata con successo');
  }),
);

// ---------------------------------------------------------------------------
// POST /api/documents/:id/sign — e-signature
// ---------------------------------------------------------------------------

router.post(
  '/:id/sign',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (!user.companyId) {
        forbidden(res, 'Accesso negato: azienda non valida', 'COMPANY_MISMATCH');
        return;
      }

      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        badRequest(res, 'ID documento non valido', 'BAD_REQUEST');
        return;
      }

      const allowedCompanyIds = await resolveAllowedCompanyIds(user);

      // Look up across both potential tables - Handle ID Collisions
      let docData: any = null;

      // 1. Try employee_documents
      const empDoc = await queryOne<{
        id: number;
        company_id: number;
        employee_id: number;
        file_name: string;
        storage_path: string;
        mime_type: string | null;
        requires_signature: boolean;
        signed_at: string | null;
        deleted_at: string | null;
      }>(
        `SELECT id, company_id, employee_id, file_name, storage_path, mime_type, 
                requires_signature, signed_at, deleted_at
           FROM employee_documents 
          WHERE id = $1 AND company_id = ANY($2)`,
        [id, allowedCompanyIds],
      );

      // 2. Try generic documents
      const genDocRow = await queryOne<{
        id: number;
        company_id: number;
        employee_id: number | null;
        title: string;
        file_url: string;
        requires_signature: boolean;
        signed_at: string | null;
      }>(
        `SELECT id, company_id, employee_id, title, file_url,
                requires_signature, signed_at
           FROM documents
          WHERE id = $1 AND company_id = ANY($2)`,
        [id, allowedCompanyIds],
      );

      // Decision Logic: If both exist, pick the most relevant one
      if (empDoc && genDocRow) {
        const genDoc = {
          id: genDocRow.id,
          company_id: genDocRow.company_id,
          employee_id: genDocRow.employee_id,
          file_name: genDocRow.title,
          storage_path: genDocRow.file_url,
          mime_type: genDocRow.file_url.toLowerCase().endsWith('.pdf') ? 'application/pdf' : null,
          requires_signature: genDocRow.requires_signature,
          signed_at: genDocRow.signed_at,
          sourceTable: 'documents'
        };

        // If one is assigned to the current user and the other isn't, pick the assigned one
        const empIsAssigned = empDoc.employee_id === user.userId;
        const genIsAssigned = genDoc.employee_id === user.userId;

        if (genIsAssigned && !empIsAssigned) {
          docData = genDoc;
        } else if (empIsAssigned && !genIsAssigned) {
          docData = { ...empDoc, sourceTable: 'employee_documents' };
        } else {
          // If both assigned (or neither), prefer the one that is NOT signed yet
          if (genDoc.signed_at === null && empDoc.signed_at !== null) {
            docData = genDoc;
          } else {
            docData = { ...empDoc, sourceTable: 'employee_documents' };
          }
        }
      } else if (empDoc && empDoc.deleted_at === null) {
        docData = { ...empDoc, sourceTable: 'employee_documents' };
      } else if (genDocRow) {
        docData = {
          id: genDocRow.id,
          company_id: genDocRow.company_id,
          employee_id: genDocRow.employee_id,
          file_name: genDocRow.title,
          storage_path: genDocRow.file_url,
          mime_type: genDocRow.file_url.toLowerCase().endsWith('.pdf') ? 'application/pdf' : null,
          requires_signature: genDocRow.requires_signature,
          signed_at: genDocRow.signed_at,
          sourceTable: 'documents'
        };
      }

      if (!docData) {
        notFound(res, 'Documento non trovato', 'NOT_FOUND');
        return;
      }

      if (!docData.requires_signature) {
        badRequest(res, 'Questo documento non richiede firma', 'SIGNATURE_NOT_REQUIRED');
        return;
      }

      if (docData.signed_at !== null) {
        conflict(res, 'Documento già firmato', 'ALREADY_SIGNED');
        return;
      }

      // New Expiry Check: Reject if document is expired
      if (docData.expires_at && new Date(docData.expires_at) < new Date()) {
        const isIt = (req.headers['x-lang'] || 'it') === 'it';
        badRequest(
          res,
          isIt ? 'Impossibile firmare: il documento è scaduto' : 'Cannot sign: the document has expired',
          'DOCUMENT_EXPIRED'
        );
        return;
      }

      // Role-agnostic Authorization: owner (assigned user) or admin/hr
      const isAdminOrHr = ['admin', 'hr'].includes(user.role) || user.is_super_admin === true;
      if (!isAdminOrHr && user.userId !== docData.employee_id) {
        forbidden(res, 'Non sei autorizzato a firmare questo documento');
        return;
      }

      // Signer info gathering
      const signerInfo = await queryOne<{ name: string; surname: string; role: string; email: string }>(
        `SELECT name, surname, role, email FROM users WHERE id = $1`,
        [user.userId],
      );

      const signerName = signerInfo?.name ?? '';
      const signerSurname = signerInfo?.surname ?? '';
      const signerRole = signerInfo?.role ?? user.role;
      const signerEmail = signerInfo?.email ?? user.email ?? '';

      // IP Normalization
      const forwardedFor = req.headers['x-forwarded-for'];
      let signedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : req.ip ?? '0.0.0.0');
      if (signedIp.startsWith('::ffff:')) signedIp = signedIp.substring(7);
      else if (signedIp === '::1') signedIp = '127.0.0.1';

      // Timestamp handling - handle both camelCase and snake_case from frontend
      const body = req.body as any;
      const rawSignedAt = body.signedAt || body.signed_at;
      const rawSignedAtDisplay = body.signedAtDisplay || body.signed_at_display;

      // Diagnostic log update
      console.log('[DEBUG_SIGN] Derived values - rawSignedAt:', rawSignedAt, 'rawSignedAtDisplay:', rawSignedAtDisplay);

      const now = rawSignedAt ? new Date(rawSignedAt) : new Date();
      const finalDate = isNaN(now.getTime()) ? new Date() : now;

      const signatureMeta: Record<string, unknown> = {
        signerName,
        signerSurname,
        signerRole,
        signerEmail,
        timestamp: finalDate.toISOString(),
        signedAtDisplay: rawSignedAtDisplay || null,
        ip: signedIp,
        userAgent: req.headers['user-agent'] ?? '',
      };

      let newStoragePath: string | undefined;

      // PDF modification
      if (docData.mime_type === 'application/pdf' || docData.storage_path.toLowerCase().endsWith('.pdf')) {
        try {
          const fullPath = path.resolve(docData.storage_path);
          if (!fs.existsSync(fullPath)) throw new Error(`File not found at ${fullPath}`);

          const pdfBytes = fs.readFileSync(fullPath);
          const pdfDoc = await PDFDocument.load(pdfBytes);
          const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
          const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

          const page = pdfDoc.addPage();
          const { height } = page.getSize();
          const fontSize = 12;
          const lineHeight = fontSize * 1.8;
          const margin = 60;

          const lang = (req.headers['accept-language'] || req.headers['x-lang'] || 'it').toString().toLowerCase();
          const isIt = lang.startsWith('it');

          const labels = isIt ? {
            title: 'Dettagli Firma Elettronica (Verify V3)',
            signedBy: 'Firmato da',
            email: 'Email',
            date: 'Data e Ora',
            ip: 'Indirizzo IP',
            browser: 'Browser',
            disclaimer: 'Questo documento è stato firmato elettronicamente con consenso legale.'
          } : {
            title: 'E-Signature Audit Trail (Verify V3)',
            signedBy: 'Signed by',
            email: 'Email',
            date: 'Date and Time',
            ip: 'IP Address',
            browser: 'Browser',
            disclaimer: 'This document has been electronically signed with legal consent.'
          };

          // Priority: 
          // 1. Explicit display string from client
          // 2. Format the ISO date from client using server locale as backup
          // 3. Current server time as ultimate fallback
          const dateStr = rawSignedAtDisplay || finalDate.toLocaleString(isIt ? 'it-IT' : 'en-US', {
            dateStyle: 'medium',
            timeStyle: 'medium',
            hour12: false
          });

          console.log('[DEBUG_SIGN] Final dateStr for PDF:', dateStr);

          let y = height - margin;
          page.drawText(labels.title, { x: margin, y, size: 16, font: fontBold });
          y -= lineHeight * 1.5;

          const drawField = (label: string, value: string) => {
            page.drawText(`${label}:`, { x: margin, y, size: fontSize, font: fontBold });
            page.drawText(value, { x: margin + 100, y, size: fontSize, font });
            y -= lineHeight;
          };

          drawField(labels.signedBy, `${signerName} ${signerSurname}`);
          drawField(labels.email, signerEmail);
          drawField(labels.date, dateStr);
          drawField(labels.ip, signedIp);

          const browser = req.headers['user-agent'] || 'Unknown';
          page.drawText(`${labels.browser}:`, { x: margin, y, size: fontSize, font: fontBold });
          page.drawText(browser.length > 60 ? browser.substring(0, 57) + '...' : browser, { x: margin + 100, y, size: fontSize, font });
          y -= lineHeight * 2;

          page.drawText(labels.disclaimer, { x: margin, y, size: 10, font, color: rgb(0.4, 0.4, 0.4) });

          const modifiedPdfBytes = await pdfDoc.save();

          // Generate a new unique filename for the signed version
          const dir = path.dirname(fullPath);
          const ext = path.extname(fullPath);
          const baseName = path.basename(fullPath, ext);
          const newFileName = `signed_${user.userId}_${Date.now()}_${baseName}${ext}`;
          const newFullPath = path.join(dir, newFileName);

          fs.writeFileSync(newFullPath, modifiedPdfBytes);

          // The path we store in the database (relative or absolute as per convention)
          // Here we use the same directory structure but the new file name
          newStoragePath = path.join(path.dirname(docData.storage_path), newFileName);
        } catch (pdfErr: any) {
          signatureMeta['pdfSignatureError'] = pdfErr?.message ?? 'Errore PDF';
        }
      }

      // Update the correct table
      let updated: any = null;
      if (docData.sourceTable === 'employee_documents') {
        updated = await signDocument(id, {
          signedByUserId: user.userId,
          signedIp,
          signatureMeta,
          newStoragePath, // Use the new signed file path
          signedAt: finalDate.toISOString(),
        });

        // SYNC: Update corresponding record in 'documents' table if exists
        if (updated) {
          await query(
            `UPDATE documents 
              SET signed_at = $1, 
                  signed_by_user_id = $2, 
                  signed_ip = $3::inet, 
                  signature_meta = $4,
                  file_url = $5
            WHERE (file_url = $6 OR file_url = $7) AND (employee_id = $8 OR employee_id IS NULL)`,
            [
              finalDate.toISOString(),
              user.userId,
              signedIp,
              signatureMeta,
              newStoragePath || docData.storage_path,
              docData.storage_path,
              newStoragePath || docData.storage_path,
              docData.employee_id
            ]
          );
        }
      } else {
        updated = await signGenericDocument(id, {
          signedByUserId: user.userId,
          signedIp,
          signatureMeta,
          newStoragePath,
          signedAt: finalDate.toISOString(),
        });

        // SYNC: Update corresponding record in 'employee_documents' table if exists
        if (updated) {
          await query(
            `UPDATE employee_documents 
              SET signed_at = $1, 
                  signed_by_user_id = $2, 
                  signed_ip = $3::inet, 
                  signature_meta = $4,
                  storage_path = $5
            WHERE storage_path = $6 AND employee_id = $7`,
            [
              finalDate.toISOString(),
              user.userId,
              signedIp,
              signatureMeta,
              newStoragePath || docData.storage_path,
              docData.storage_path,
              docData.employee_id
            ]
          );
        }
      }

      if (!updated) {
        notFound(res, 'Documento non trovato per l\'aggiornamento', 'NOT_FOUND');
        return;
      }

      // Success response
      const { storage_path: _sp1, storagePath: _sp2, fileUrl: _sp3, file_url: _sp4, ...safeDoc } = updated;
      ok(res, {
        ...safeDoc,
        signedAt: finalDate.toISOString(),
        signedByUserId: user.userId,
        signedIp,
        signatureMeta
      }, 'Documento firmato con successo');
    } catch (error: any) {
      console.error('SIGN_ERROR_DETAILS:', error);
      res.status(500).json({
        success: false,
        error: 'Errore durante la firma del documento',
        details: error.message,
        code: 'SIGN_ERROR'
      });
    }
  }),
);

export default router;
