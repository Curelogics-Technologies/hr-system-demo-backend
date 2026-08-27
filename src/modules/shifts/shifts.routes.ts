import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import {
  listShifts,
  createShift,
  updateShift,
  deleteShift,
  copyWeek,
  approveWeekForEmployee,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  exportShifts,
  importShifts,
  importTemplate,
  getAffluence,
  createAffluence,
  updateAffluence,
  deleteAffluence,
} from './shifts.controller';
import { authenticate, requireRole, enforceCompany, requireModulePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';

const upload = multer({
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

const router = Router();

const managementRoles = ['admin', 'hr', 'area_manager', 'store_manager'] as const;
const allRoles = [...managementRoles, 'employee', 'store_terminal'] as const;

// Zod schemas
function toMins(t: string | null | undefined): number {
  if (!t || typeof t !== 'string' || !t.includes(':')) return 0;
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// ---------------------------------------------------------------------------
// M3: Standalone cross-field validator — returns a list of error strings.
// Used both by the Zod refinement (HTTP API) and importShifts (CSV/XLSX import).
// ---------------------------------------------------------------------------
export function validateShiftCrossFields(data: Record<string, any>): string[] {
  const { start_time, end_time, break_start, break_end, break_type, break_minutes, is_split, split_start2, split_end2 } = data;
  const isFlexible = break_type === 'flexible';
  const errs: string[] = [];

  // end > start
  if (start_time && end_time) {
    if (toMins(end_time) <= toMins(start_time)) {
      errs.push("L'orario di fine deve essere successivo all'inizio");
    }
  }

  if (isFlexible) {
    // M18: flexible break requires break_minutes
    if (break_minutes == null) {
      errs.push('La durata della pausa è obbligatoria per il tipo flessibile');
    }
    if (break_minutes != null && (break_minutes <= 0 || break_minutes > 480)) {
      errs.push('La durata della pausa deve essere tra 1 e 480 minuti');
    }
  } else {
    const hasBS = break_start && String(break_start).length > 0;
    const hasBE = break_end   && String(break_end).length   > 0;
    if (hasBS && !hasBE) {
      errs.push("L'orario di fine pausa è obbligatorio");
    }
    if (!hasBS && hasBE) {
      errs.push("L'orario di inizio pausa è obbligatorio");
    }
    if (hasBS && hasBE && start_time && end_time) {
      const sM  = toMins(start_time);
      const eM  = toMins(end_time);
      const bsM = toMins(break_start as string);
      const beM = toMins(break_end   as string);
      if (beM <= bsM) {
        errs.push("L'orario di fine pausa deve essere successivo all'inizio");
      }
      if (bsM < sM || beM > eM) {
        errs.push('La pausa deve rientrare nella finestra del turno');
      }
    }
  }

  if (is_split) {
    const hasSS2 = split_start2 && String(split_start2).length > 0;
    const hasSE2 = split_end2   && String(split_end2).length   > 0;
    if (!hasSS2) {
      errs.push("L'inizio del 2° blocco è obbligatorio");
    }
    if (!hasSE2) {
      errs.push("La fine del 2° blocco è obbligatoria");
    }
    if (hasSS2 && hasSE2 && end_time) {
      const eM   = toMins(end_time);
      const ss2M = toMins(split_start2 as string);
      const se2M = toMins(split_end2   as string);
      if (se2M <= ss2M) {
        errs.push("La fine del 2° blocco deve essere successiva all'inizio");
      }
      if (ss2M < eM) {
        errs.push('Il 2° blocco deve iniziare dopo la fine del 1° blocco');
      }
    }
  }

  return errs;
}

// Zod refinement wrapper — delegates to the shared validator and maps errors to Zod issues
function shiftCrossValidate(data: Record<string, any>, ctx: z.RefinementCtx): void {
  const errs = validateShiftCrossFields(data);
  for (const msg of errs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
  }
}

const baseShiftObject = z.object({
  user_id:       z.number().int().positive(),
  store_id:      z.number().int().positive(),
  date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida (YYYY-MM-DD)'),
  timezone:      z.string().min(1).max(64).optional(),
  start_time:    z.string().regex(/^\d{2}:\d{2}$/, 'Ora non valida (HH:MM)'),
  end_time:      z.string().regex(/^\d{2}:\d{2}$/, 'Ora non valida (HH:MM)'),
  break_type:    z.enum(['fixed', 'flexible']).optional(),
  break_start:   z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  break_end:     z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  break_minutes: z.number().int().min(1).max(480).optional().nullable(),
  is_split:      z.boolean().optional(),
  split_start2:  z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  split_end2:    z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  is_off_day:    z.boolean().optional(),
  notes:         z.string().max(500).optional().nullable(),
  status:        z.enum(['scheduled','confirmed','cancelled']).optional(),
  // Acknowledges a LEAVE_CONFLICT warning — the employee has approved leave on
  // this date and the operator has chosen to schedule them regardless. Must be
  // declared here: Zod strips keys the schema does not know about, so an
  // undeclared flag never reaches the controller.
  confirm_leave_conflict: z.boolean().optional(),
});

const createShiftSchema = baseShiftObject.superRefine(shiftCrossValidate);
const updateShiftSchema = baseShiftObject.partial().superRefine(shiftCrossValidate);

const copyWeekSchema = z.object({
  store_id:    z.number().int().positive(),
  source_week: z.string().regex(/^\d{4}-W\d{1,2}$/),
  target_week: z.string().regex(/^\d{4}-W\d{1,2}$/),
});

const approveWeekSchema = z.object({
  user_id:   z.number().int().positive(),
  week:      z.string().regex(/^\d{4}-W\d{1,2}$/),
  store_id:  z.number().int().positive().optional().nullable(),
});

const createTemplateSchema = z.object({
  store_id:      z.number().int().positive(),
  name:          z.string().min(1).max(100),
  template_data: z.record(z.string(), z.unknown()),
});

const updateTemplateSchema = z.object({
  store_id:      z.number().int().positive(),
  name:          z.string().min(1).max(100),
  template_data: z.record(z.string(), z.unknown()),
});

const createAffluenceSchema = z.object({
  store_id:       z.number().int().positive(),
  day_of_week:    z.number().int().min(1).max(7),
  time_slot:      z.enum(['09:00-12:00', '12:00-15:00', '15:00-18:00', '18:00-21:00']),
  level:          z.enum(['low', 'medium', 'high']),
  required_staff: z.number().int().min(0).max(999),
  iso_week:       z.number().int().min(1).max(53).optional().nullable(),
});

const updateAffluenceSchema = z.object({
  level:          z.enum(['low', 'medium', 'high']),
  required_staff: z.number().int().min(0).max(999),
});

// GET /api/shifts/export — must be BEFORE /:id to avoid route conflict
router.get(
  '/export',
  authenticate,
  enforceCompany,
  requireRole(...managementRoles),
  requireModulePermission('turni', 'read'),
  exportShifts,
);

// GET /api/shifts/import-template — download blank import template
router.get(
  '/import-template',
  authenticate,
  enforceCompany,
  requireRole(...managementRoles),
  requireModulePermission('turni', 'read'),
  importTemplate,
);

// POST /api/shifts/import — bulk import from xlsx/csv
router.post(
  '/import',
  authenticate,
  enforceCompany,
  requireRole(...managementRoles),
  requireModulePermission('turni', 'write'),
  upload.single('file'),
  importShifts,
);

// POST /api/shifts/affluence — admin/hr only
router.post(
  '/affluence',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('turni', 'write'),
  validate(createAffluenceSchema),
  createAffluence,
);

// PUT /api/shifts/affluence/:id — admin/hr only
router.put(
  '/affluence/:id',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('turni', 'write'),
  validate(updateAffluenceSchema),
  updateAffluence,
);

// DELETE /api/shifts/affluence/:id — admin/hr only
router.delete(
  '/affluence/:id',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('turni', 'write'),
  deleteAffluence,
);

// GET /api/shifts/affluence
router.get(
  '/affluence',
  authenticate,
  enforceCompany,
  requireRole(...managementRoles),
  requireModulePermission('turni', 'read'),
  getAffluence,
);

// POST /api/shifts/approve-week — must be BEFORE /:id
router.post(
  '/approve-week',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr', 'area_manager'),
  requireModulePermission('turni', 'write'),
  validate(approveWeekSchema),
  approveWeekForEmployee,
);

// POST /api/shifts/copy-week — must be BEFORE /:id
router.post(
  '/copy-week',
  authenticate,
  enforceCompany,
  requireRole(...managementRoles),
  requireModulePermission('turni', 'write'),
  validate(copyWeekSchema),
  copyWeek,
);

// GET /api/shifts/templates — must be BEFORE /:id
router.get(
  '/templates',
  authenticate,
  enforceCompany,
  requireRole(...managementRoles),
  requireModulePermission('turni', 'read'),
  listTemplates,
);

// POST /api/shifts/templates — must be BEFORE /:id
router.post(
  '/templates',
  authenticate,
  enforceCompany,
  requireRole(...managementRoles),
  requireModulePermission('turni', 'write'),
  validate(createTemplateSchema),
  createTemplate,
);

// PUT /api/shifts/templates/:id — must be BEFORE /:id
router.put(
  '/templates/:id',
  authenticate,
  enforceCompany,
  requireRole(...managementRoles),
  requireModulePermission('turni', 'write'),
  validate(updateTemplateSchema),
  updateTemplate,
);

// DELETE /api/shifts/templates/:id — must be BEFORE /:id
router.delete(
  '/templates/:id',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr', 'store_manager'),
  requireModulePermission('turni', 'write'),
  deleteTemplate,
);

// GET /api/shifts — all roles (employees see only own)
router.get(
  '/',
  authenticate,
  enforceCompany,
  requireRole(...allRoles),
  requireModulePermission('turni', 'read'),
  listShifts,
);

// POST /api/shifts — management only
router.post(
  '/',
  authenticate,
  enforceCompany,
  requireRole(...managementRoles),
  requireModulePermission('turni', 'write'),
  validate(createShiftSchema),
  createShift,
);

// PUT /api/shifts/:id
router.put(
  '/:id',
  authenticate,
  enforceCompany,
  requireRole(...managementRoles),
  requireModulePermission('turni', 'write'),
  validate(updateShiftSchema),
  updateShift,
);

// DELETE /api/shifts/:id
router.delete(
  '/:id',
  authenticate,
  enforceCompany,
  requireRole(...managementRoles),
  requireModulePermission('turni', 'write'),
  deleteShift,
);

export default router;
