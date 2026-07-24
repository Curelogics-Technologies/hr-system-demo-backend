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
  restoreDocument,
  permanentlyDeleteDocument,
} from './documents.service';
import { resolveAllowedCompanyIds } from '../../utils/companyScope';
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
  fileFilter: (_req, file, cb) => {
    const allowed = [
      ...allowedDocMime,
      'application/zip',
      'application/x-zip-compressed',
      'application/rar',
      'application/x-rar-compressed',
      'application/x-7z-compressed',
      'application/octet-stream'
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(file.mimetype) || ['.zip', '.rar', '.7z'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('INVALID_FILE_TYPE'));
    }
  },
}).single('file');

const uploadUnifiedMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  uploadUnifiedMulter(req, res, (err: any) => {
    if (!err) { next(); return; }
    if (err.code === 'LIMIT_FILE_SIZE') {
      badRequest(res, 'File too large (max 100MB)', 'FILE_TOO_LARGE');
      return;
    }
    if (err.message === 'INVALID_FILE_TYPE') {
      badRequest(res, 'Unsupported file type. Use PDF, JPG, PNG, ZIP, RAR or 7Z', 'INVALID_FILE_TYPE');
      return;
    }
    next(err);
  });
};

// Helper for fuzzy string matching (Levenshtein distance)
function getLevenshteinDistance(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1, // deletion
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j - 1] + 1 // substitution
        );
      }
    }
  }
  return matrix[a.length][b.length];
}

// Sliding window similarity check to find fuzzy substrings of any order
function getFuzzySubstringSimilarity(filename: string, pattern: string): number {
  if (!filename || !pattern) return 0;
  if (filename.includes(pattern)) return 1.0;

  let maxSim = 0;
  const windowSize = pattern.length;

  for (let i = 0; i <= filename.length - windowSize; i++) {
    const sub = filename.substring(i, i + windowSize);
    const dist = getLevenshteinDistance(sub, pattern);
    const sim = 1 - dist / windowSize;
    if (sim > maxSim) {
      maxSim = sim;
    }
  }

  for (let w = Math.max(3, windowSize - 2); w <= Math.min(filename.length, windowSize + 2); w++) {
    for (let i = 0; i <= filename.length - w; i++) {
      const sub = filename.substring(i, i + w);
      const dist = getLevenshteinDistance(sub, pattern);
      const maxLen = Math.max(sub.length, pattern.length);
      const sim = 1 - dist / maxLen;
      if (sim > maxSim) {
        maxSim = sim;
      }
    }
  }

  return maxSim;
}

// --- Step 2 Auto-assignment Logic ---

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
): Promise<any> {
  const isGlobalSearch = options?.isSuperAdmin || !allowedCompanyIds || allowedCompanyIds.length === 0;

  let companyFilterSql = '';
  let params: any[] = [];

  if (options?.companyId) {
    companyFilterSql = 'AND company_id = $1';
    params = [options.companyId];
  } else if (!isGlobalSearch) {
    companyFilterSql = 'AND company_id = ANY($1)';
    params = [allowedCompanyIds];
  }

  // Fetch active employees (filtered by allowed company IDs unless global search for super admin)
  const employees = await query<{
    id: number;
    name: string;
    surname: string;
    unique_id: string | null;
    company_id: number;
  }>(
    `SELECT id, name, surname, unique_id, company_id FROM users WHERE status = 'active' ${companyFilterSql}`,
    params,
  );

  // Normalize filename for matching: remove extension and trim
  const cleanBaseName = filename.replace(/\.(pdf|zip|jpg|jpeg|png|webp|bin|docx|xlsx)$/i, '').trim();
  const normalizedFile = cleanBaseName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = normalizedFile.split(/[_\s.-]+/).filter(Boolean);
  const filenameAlphaOnly = normalizedFile.replace(/[^a-z0-9]/g, '');

  let bestScore = 0;
  let matches: typeof employees = [];

  for (const emp of employees) {
    const name = emp.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const surname = emp.surname.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const cleanName = name.replace(/[^a-z0-9]/g, '');
    const cleanSurname = surname.replace(/[^a-z0-9]/g, '');
    const uid = emp.unique_id?.toLowerCase().trim();

    let score = 0;

    // Level 1: Unique ID match (highest priority)
    if (uid && tokens.includes(uid)) {
      score = 200;
    }
    else if (cleanName && cleanSurname) {
      const nameSim = getFuzzySubstringSimilarity(filenameAlphaOnly, cleanName);
      const surnameSim = getFuzzySubstringSimilarity(filenameAlphaOnly, cleanSurname);

      if (nameSim >= 0.75 && surnameSim >= 0.75) {
        // Level 2: Exact adjacent match
        if (filenameAlphaOnly.includes(cleanName + cleanSurname) || filenameAlphaOnly.includes(cleanSurname + cleanName)) {
          score = 100;
        } else {
          // Level 2.5: Both match but not adjacent or fuzzy
          const averageSim = (nameSim + surnameSim) / 2;
          score = Math.round(averageSim * 100) - 10; // score between 65 and 90
        }
      }
    }
    else {
      // Fallback for single-name records in DB
      const nameSim = cleanName ? getFuzzySubstringSimilarity(filenameAlphaOnly, cleanName) : 0;
      const surnameSim = cleanSurname ? getFuzzySubstringSimilarity(filenameAlphaOnly, cleanSurname) : 0;
      const maxSim = Math.max(nameSim, surnameSim);

      if (maxSim >= 0.75) {
        score = Math.round(maxSim * 100) - 50; // lower score for single-field match
      }
    }

    if (score > 0) {
      if (score > bestScore) {
        bestScore = score;
        matches = [emp];
      } else if (score === bestScore) {
        matches.push(emp);
      }
    }
  }

  // Parse provided employee ID safely
  let providedEmpId: number | null = null;
  if (options?.employeeId !== undefined && options?.employeeId !== null) {
    const parsed = Number(options.employeeId);
    if (Number.isFinite(parsed) && parsed > 0) {
      providedEmpId = parsed;
    }
  }

  let matchedEmp: typeof employees[0] | null = null;

  if (providedEmpId === null) {
    if (matches.length === 1) {
      matchedEmp = matches[0];
    }
  }

  let finalEmpId: number | null = providedEmpId;
  let finalCompanyId: number | null = null;

  if (matchedEmp) {
    finalEmpId = matchedEmp.id;
    finalCompanyId = matchedEmp.company_id;
  } else if (providedEmpId) {
    // If ID was provided but no match found in our search list, resolve its company explicitly
    const empInfo = await queryOne<{ company_id: number }>(
      `SELECT company_id FROM users WHERE id = $1`,
      [providedEmpId]
    );
    finalCompanyId = empInfo?.company_id || (allowedCompanyIds.length > 0 ? allowedCompanyIds[0] : 0);
  }

  if (options?.simulate) {
    let returnEmp = null;
    if (matchedEmp) {
      returnEmp = {
        id: matchedEmp.id,
        name: matchedEmp.name,
        surname: matchedEmp.surname,
        companyId: matchedEmp.company_id
      };
    } else if (finalEmpId) {
      const emp = await queryOne<{ id: number; name: string; surname: string; company_id: number }>(
        `SELECT id, name, surname, company_id FROM users WHERE id = $1`,
        [finalEmpId]
      );
      if (emp) {
        returnEmp = {
          id: emp.id,
          name: emp.name,
          surname: emp.surname,
          companyId: emp.company_id
        };
      }
    }
    return {
      matched: !!finalEmpId,
      employee: returnEmp
    };
  }

  if (finalEmpId && finalCompanyId) {
    const empId = finalEmpId;
    const targetCompanyId = finalCompanyId;

    // 1. Update the generic document as assigned AND set the correct company_id
    await query(
      `UPDATE documents SET employee_id = $1, company_id = $2 WHERE id = $3`,
      [empId, targetCompanyId, documentId]
    );

    // 2. Fetch origin doc info to migrate to employee_documents
    const doc = await queryOne<{ file_url: string; mime_type?: string }>(
      `SELECT file_url FROM documents WHERE id = $1`,
      [documentId]
    );

    if (doc) {
      // 3. Fetch first active category for the company automatically
      const categoryRow = await queryOne<{ id: number; name: string }>(
        `SELECT id, name FROM document_categories WHERE company_id = $1 AND is_active = true ORDER BY created_at ASC LIMIT 1`,
        [targetCompanyId]
      );
      const autoCategoryId = categoryRow?.id || null;
      const autoCategoryName = categoryRow?.name || null;

      // Update the generic document with category name if found
      if (autoCategoryName) {
        await query('UPDATE documents SET category = $1 WHERE id = $2', [autoCategoryName, documentId]);
      }

      // Map extension to mime type
      const ext = path.extname(filename).toLowerCase();
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

      // Insert into employee_documents (the "rich" table)
      await queryOne<{ id: number }>(
        `INSERT INTO employee_documents (
            company_id, employee_id, category_id, file_name, storage_path, mime_type,
            uploaded_by_user_id, requires_signature, expires_at, is_visible_to_roles
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id`,
        [
          targetCompanyId,
          empId,
          autoCategoryId,
          filename,
          doc.file_url,
          mimeType,
          options?.uploadedBy || null,
          options?.requiresSignature || false,
          options?.expiresAt || null,
          options?.visibleToRoles || ['admin', 'hr', 'area_manager', 'store_manager', 'employee']
        ]
      );

      if (options?.requiresSignature) {
        const empRow = await queryOne<{ locale?: string }>(`SELECT locale FROM users WHERE id = $1`, [empId]);
        const userLocale = empRow?.locale || 'it';
        const title = t(userLocale, 'notifications.document_signature_required.title');
        const message = t(userLocale, 'notifications.document_signature_required.message');

        await sendNotification({
          companyId: targetCompanyId,
          userId: empId,
          type: 'document.signature_required',
          title,
          message,
          priority: 'high',
          channels: ['in_app']
        });

        sendDocumentSignatureEmailAutomation(
          targetCompanyId,
          empId,
          filename,
          allowedCompanyIds[0]
        ).catch(err => console.error('[AUTOMATION] Document signature email error:', err));
      }

      return true;
    }
  }
  return false;
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
    const { title, employee_id, requires_signature, expires_at, visible_to_roles } = req.body;

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
    }>(
      `SELECT id, file_url, title, is_visible_to_roles, requires_signature, expires_at FROM documents WHERE id = $1`,
      [id],
    );

    if (!doc) {
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
      let targetCompanyId = req.user!.companyId; // Existing company by default

      if (employee_id) {
        // Resolve company and category for the employee
        const emp = await queryOne<{ company_id: number; role: string }>(
          `SELECT company_id, role FROM users WHERE id = $1`,
          [employee_id]
        );

        if (emp && emp.role === 'admin') {
          badRequest(res, 'I documenti non possono essere assegnati agli amministratori', 'FORBIDDEN_ASSIGNMENT');
          return;
        }

        if (emp) {
          targetCompanyId = emp.company_id; // Sync document to employee's company
          const categoryRow = await queryOne<{ id: number; name: string }>(
            `SELECT id, name FROM document_categories WHERE company_id = $1 AND is_active = true ORDER BY created_at ASC LIMIT 1`,
            [emp.company_id]
          );
          autoCategoryId = categoryRow?.id || null;
          autoCategoryName = categoryRow?.name || null;
        }
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

      await query(
        `UPDATE documents
            SET title = $1,
                file_url = $2,
                employee_id = $3,
                category = $4,
                company_id = $5,
                requires_signature = $6,
                expires_at = $7,
                is_visible_to_roles = $8
          WHERE id = $9`,
        [newTitle, newPath, employee_id || null, autoCategoryName, targetCompanyId || 0, finalRequiresSignature, finalExpiresAt, finalVisibleToRolesArr, id]
      );

      // 4. Migration/Sync to employee_documents
      // We look for existing record using the OLD path (doc.file_url) 
      const existing = await queryOne<{ id: number }>(`SELECT id FROM employee_documents WHERE storage_path = $1 AND deleted_at IS NULL`, [doc.file_url]);

      if (employee_id) {
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

          if (finalRequiresSignature) {
            const empRow = await queryOne<{ locale?: string }>(`SELECT locale FROM users WHERE id = $1`, [employee_id]);
            const userLocale = empRow?.locale || 'it';
            const title = t(userLocale, 'notifications.document_signature_required.title');
            const message = t(userLocale, 'notifications.document_signature_required.message');

            await sendNotification({
              companyId: emp.company_id,
              userId: employee_id,
              type: 'document.signature_required',
              title,
              message,
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
        for (const entry of entries) {
          if (entry.isDirectory) continue;

          const filePath = path.join(extractDir, entry.entryName);
          const doc = await createGenericDocument({
            companyId: baseCompanyId || 0, // Fallback to 0 if still null, though auto-assign will correct it if matched
            title: entry.name,
            fileUrl: filePath,
            uploadedBy: req.user!.userId,
            requiresSignature: options.requiresSignature,
            expiresAt: options.expiresAt,
            isVisibleToRoles: options.visibleToRoles,
          });

          // Rule based auto-assignment
          await performAutoAssign(doc.id, entry.name, allowedCompanyIds, options);
        }

        ok(res, { success: true, message: 'ZIP extracted and files saved successfully' });
      } catch (err: any) {
        badRequest(res, 'ZIP processing failed', 'ZIP_ERROR');
      } finally {
        // Clean up temp zip file
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    } else {
      // Handle Single File
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
        employee: autoAssignResult.employee
      });
    }

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

    try {
      const existing = await queryOne(`SELECT id FROM document_categories WHERE company_id = $1`, [targetCompanyId]);
      if (existing) {
        conflict(res, 'Questa azienda ha già una categoria. Puoi solo modificarla.', 'CATEGORY_EXISTS');
        return;
      }

      const category = await createCategory(targetCompanyId, name.trim());

      // Retroactive assignment:
      // 1. Update employee_documents
      await query(
        `UPDATE employee_documents 
            SET category_id = $1 
          WHERE company_id = $2 AND category_id IS NULL AND deleted_at IS NULL`,
        [category.id, targetCompanyId]
      );

      // 2. Update generic documents table for consistency
      await query(
        `UPDATE documents d
            SET category = $1
           FROM users u
          WHERE d.employee_id = u.id
            AND u.company_id = $2
            AND d.category IS NULL`,
        [category.name, targetCompanyId]
      );

      created(res, category, 'Categoria creata con successo');
    } catch (err: any) {
      throw err;
    }
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

    try {
      const updated = await updateCategory(id, sourceCompanyId, {
        name: name !== undefined ? name.trim() : undefined,
        isActive: is_active,
        companyId: destinationCompanyId,
      });

      if (!updated) {
        notFound(res, 'Categoria non trovata per l\'azienda specificata', 'NOT_FOUND');
        return;
      }

      if (name !== undefined) {
        await query(
          `UPDATE documents d
               SET category = $1 
              FROM users u
             WHERE d.employee_id = u.id
               AND u.company_id = $2`,
          [updated.name, updated.companyId]
        );
      }

      ok(res, updated, 'Categoria aggiornata con successo');
    } catch (err: any) {
      throw err;
    }
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

      for (const entry of entries) {
        const origName = entry.entryName.split('/').pop() ?? entry.entryName;
        const stem = origName.replace(/\.[^.]+$/, '');

        // Normalize: lowercase, strip accents, replace non-alpha with _
        const normalized = stem
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '_');

        // Attempt to find a matching employee
        let matchedEmployeeId: number | null = null;

        // Pattern 3: unique_id prefix (UNIQUEID_...)
        const uniqueIdPart = normalized.split('_')[0];
        if (!matchedEmployeeId && uniqueIdPart) {
          // Try exact unique_id match with the first segment (also try full stem for UNIQUEID only files)
          const tryIds = Array.from(new Set([uniqueIdPart, normalized.replace(/_/g, '-')]));
          for (const tryId of tryIds) {
            const row = await queryOne<{ id: number; company_id: number }>(
              `SELECT id, company_id FROM users WHERE LOWER(unique_id) = $1 AND company_id = ANY($2) LIMIT 1`,
              [tryId, allowedCompanyIds],
            );
            if (row) { matchedEmployeeId = row.id; break; }
          }
        }

        // Pattern 1: SURNAME_NAME
        if (!matchedEmployeeId) {
          const parts = normalized.split('_').filter(Boolean);
          if (parts.length >= 2) {
            const surname = parts[0];
            const name = parts.slice(1).join('_');
            const row = await queryOne<{ id: number }>(
              `SELECT id FROM users
                WHERE LOWER(surname) = $1 AND LOWER(name) = $2
                  AND company_id = ANY($3)
               LIMIT 1`,
              [surname, name, allowedCompanyIds],
            );
            if (row) matchedEmployeeId = row.id;
          }
        }

        // Pattern 2: NAME_SURNAME
        if (!matchedEmployeeId) {
          const parts = normalized.split('_').filter(Boolean);
          if (parts.length >= 2) {
            const name = parts[0];
            const surname = parts.slice(1).join('_');
            const row = await queryOne<{ id: number }>(
              `SELECT id FROM users
                WHERE LOWER(name) = $1 AND LOWER(surname) = $2
                  AND company_id = ANY($3)
               LIMIT 1`,
              [name, surname, allowedCompanyIds],
            );
            if (row) matchedEmployeeId = row.id;
          }
        }

        if (matchedEmployeeId !== null) {
          // Extract and save file
          const fileBytes = entry.getData();
          const destFileName = `${uploadId}_${origName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          const destPath = path.join(DOCUMENTS_UPLOAD_DIR, destFileName);
          fs.writeFileSync(destPath, fileBytes);

          // Determine mime type from extension
          const ext = path.extname(origName).toLowerCase();
          const mimeMap: Record<string, string> = {
            '.pdf': 'application/pdf',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
          };
          const mimeType = mimeMap[ext] ?? 'application/octet-stream';

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
          // Unmatched
          await queryOne<{ id: number }>(
            `INSERT INTO bulk_document_files
               (bulk_upload_id, original_file_name, employee_identifier, status)
             VALUES ($1, $2, $3, 'unmatched')
             RETURNING id`,
            [uploadId, origName, normalized],
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

      ok(res, { uploadId, totalFiles, matchedFiles, unmatchedFiles, unmatchedFileNames });
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
  requireRole('admin', 'hr'),
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
