import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate, requireRole, enforceCompany, requireModulePermission } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import {
  submitLeave,
  createLeaveAdmin,
  deleteLeaveRequest,
  archiveLeave,
  listLeaveRequests,
  getPendingApprovals,
  approveLeave,
  rejectLeave,
  getBalance,
  listBalances,
  setBalance,
  downloadCertificate,
  exportLeaveBalances,
  importTemplate,
  importLeaveBalances,
  cancelLeave,
  reopenLeave,
  executeEscalation,
  getApprovalConfig,
  updateApprovalConfig,
} from './leave.controller';

const router = Router();

// In-memory upload, max 5MB, PDF only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Solo file PDF sono accettati'));
    }
  },
});

const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const accepted =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.endsWith('.xlsx') ||
      file.originalname.endsWith('.csv');
    if (accepted) {
      cb(null, true);
    } else {
      cb(new Error('Tipo file non supportato. Carica un file .xlsx o .csv'));
    }
  },
});

const submitSchema = z.object({
  leave_type: z.enum(['vacation', 'sick']),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato data non valido (YYYY-MM-DD)'),
  end_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato data non valido (YYYY-MM-DD)'),
  leave_duration_type: z.enum(['full_day', 'short_leave']).optional(),
  short_start_time: z.string().regex(/^\d{2}:\d{2}$/, 'Formato ora non valido (HH:MM)').optional(),
  short_end_time: z.string().regex(/^\d{2}:\d{2}$/, 'Formato ora non valido (HH:MM)').optional(),
  notes:      z.string().max(1000).optional(),
});

const approveSchema = z.object({
  notes: z.string().max(500).optional(),
  cancel_shifts: z.boolean().optional(),
});

const rejectSchema = z.object({
  notes: z.string().min(1, 'Motivazione obbligatoria per il rifiuto').max(500),
});

const allRoles      = ['admin', 'hr', 'area_manager', 'store_manager', 'employee'] as const;
const managersRoles = ['admin', 'hr', 'area_manager', 'store_manager'] as const;

const adminCreateSchema = z.object({
  user_id:    z.number().int().positive(),
  leave_type: z.enum(['vacation', 'sick']),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato data non valido (YYYY-MM-DD)'),
  end_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato data non valido (YYYY-MM-DD)'),
  leave_duration_type: z.enum(['full_day', 'short_leave']).optional(),
  short_start_time: z.string().regex(/^\d{2}:\d{2}$/, 'Formato ora non valido (HH:MM)').optional(),
  short_end_time: z.string().regex(/^\d{2}:\d{2}$/, 'Formato ora non valido (HH:MM)').optional(),
  notes:      z.string().max(1000).optional(),
});

const setBalanceSchema = z.object({
  user_id:    z.number().int().positive(),
  year:       z.number().int().min(2020).max(2100),
  leave_type: z.enum(['vacation', 'sick']),
  // null removes the allocation (admin only); 0 is a real allocation of zero
  // days. See setBalance for why the two are kept distinct.
  total_days: z.number().min(0).max(365).nullable(),
});

// NOTE: /pending and /balance are declared BEFORE /:id routes to avoid
// Express matching the literal strings "pending" and "balance" as :id params.

// POST /api/leave — submit leave request (multipart for certificate upload)
router.post(
  '/',
  authenticate,
  enforceCompany,
  requireRole(...allRoles),
  requireModulePermission('permessi', 'write'),
  upload.single('certificate'),
  // Validate after multer so req.body is populated
  (req, res, next) => {
    const result = submitSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error.issues[0]?.message ?? 'Dati non validi',
        code: 'VALIDATION_ERROR',
      });
      return;
    }
    next();
  },
  submitLeave,
);

// GET /api/leave/pending — pending approvals for the caller's role
router.get(
  '/pending',
  authenticate,
  enforceCompany,
  requireRole(...managersRoles),
  requireModulePermission('permessi', 'read'),
  getPendingApprovals,
);

// GET /api/leave/balance/export — export leave balances
router.get(
  '/balance/export',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('permessi', 'read'),
  exportLeaveBalances,
);

// GET /api/leave/balance/import-template — download template
router.get(
  '/balance/import-template',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('permessi', 'read'),
  importTemplate,
);

// POST /api/leave/balance/import — import leave balances
router.post(
  '/balance/import',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('permessi', 'write'),
  uploadExcel.single('file'),
  importLeaveBalances,
);

// GET /api/leave/balances — all balances in scope (admin/HR panel)
// Declared before '/balance' so Express does not treat "balances" as a param.
router.get(
  '/balances',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('permessi', 'read'),
  listBalances,
);

// GET /api/leave/balance — leave balance for user
router.get(
  '/balance',
  authenticate,
  enforceCompany,
  requireRole(...allRoles),
  requireModulePermission('permessi', 'read'),
  getBalance,
);

// PUT /api/leave/balance — upsert leave balance allocation (admin/hr only)
router.put(
  '/balance',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('permessi', 'write'),
  validate(setBalanceSchema),
  setBalance,
);

// GET /api/leave — list leave requests (scoped by role)
router.get(
  '/',
  authenticate,
  enforceCompany,
  requireRole(...allRoles),
  requireModulePermission('permessi', 'read'),
  listLeaveRequests,
);

// GET /api/leave/:id/certificate — download medical certificate
// Managers can download any certificate; employees can download their own
router.get(
  '/:id/certificate',
  authenticate,
  enforceCompany,
  requireRole(...allRoles),
  requireModulePermission('permessi', 'read'),
  downloadCertificate,
);

// POST /api/leave/admin — admin/hr creates leave on behalf (auto-approved)
router.post(
  '/admin',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('permessi', 'write'),
  validate(adminCreateSchema),
  createLeaveAdmin,
);

// DELETE /api/leave/:id — delete request (admin, or owner if cancelled and unapproved)
router.delete(
  '/:id',
  authenticate,
  enforceCompany,
  requireRole(...allRoles),
  requireModulePermission('permessi', 'write'),
  deleteLeaveRequest,
);

// PUT /api/leave/:id/reopen — admin sends an auto-approved request back to HR
router.put(
  '/:id/reopen',
  authenticate,
  enforceCompany,
  requireRole('admin'),
  requireModulePermission('permessi', 'write'),
  reopenLeave,
);

// PUT /api/leave/:id/archive — archive request (admin/hr only)
router.put(
  '/:id/archive',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('permessi', 'write'),
  archiveLeave,
);

// PUT /api/leave/:id/approve
router.put(
  '/:id/approve',
  authenticate,
  enforceCompany,
  requireRole(...managersRoles),
  requireModulePermission('permessi', 'write'),
  validate(approveSchema),
  approveLeave,
);

// PUT /api/leave/:id/reject
router.put(
  '/:id/reject',
  authenticate,
  enforceCompany,
  requireRole(...managersRoles),
  requireModulePermission('permessi', 'write'),
  validate(rejectSchema),
  rejectLeave,
);

// PUT /api/leave/:id/cancel
router.put(
  '/:id/cancel',
  authenticate,
  enforceCompany,
  cancelLeave,
);

// GET /api/leave/approval-config — get approval chain config
router.get(
  '/approval-config',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('permessi', 'read'),
  getApprovalConfig,
);

// PUT /api/leave/approval-config — update approval chain config
router.put(
  '/approval-config',
  authenticate,
  enforceCompany,
  requireRole('admin'),
  requireModulePermission('permessi', 'write'),
  updateApprovalConfig,
);

// POST /api/leave/escalate - manual trigger for admins only.
// NOTE: automatic escalation already runs as an in-process hourly cron (see
// index.ts), so this endpoint is not required for automation — it is now locked
// behind authentication + admin role (+ a rate limit) to close the previously
// public exposure that allowed anyone to advance approvals for every company.
router.post(
  '/escalate',
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'leave-escalate' }),
  authenticate,
  requireRole('admin'),
  executeEscalation,
);

export default router;
