import { Router } from 'express';
import { z } from 'zod';
import {
  listEmployees,
  getEmployee,
  getEmployeeAssociations,
  createEmployee,
  updateEmployee,
  deactivateEmployee,
  deleteEmployeePermanently,
  activateEmployee,
  resetEmployeeDevice,
  getImportTemplates,
  saveImportTemplate,
  deleteImportTemplate,
} from './employees.controller';
import { authenticate, requireRole, enforceCompany, requireModulePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { auditLog } from '../../middleware/auditLog';
import trainingsRoutes from './trainings.routes';
import medicalsRoutes from './medicals.routes';
import { uploadMiddleware, uploadAvatar, deleteAvatar } from './avatar.controller';

const router = Router();

const createEmployeeSchema = z.object({
  name: z.string().min(1, 'Nome obbligatorio').max(100),
  surname: z.string().min(1, 'Cognome obbligatorio').max(100),
  email: z.string().email('Email non valida'),
  role: z.enum(['admin', 'hr', 'area_manager', 'store_manager', 'employee', 'store_terminal']),
  company_id: z.number().int().nullable().optional(),
  store_id: z.number().int().optional().nullable(),
  supervisor_id: z.number().int().optional().nullable(),
  unique_id: z.string().max(100).optional().nullable(),
  department: z.string().max(100).optional().nullable(),
  hire_date: z.string().optional().nullable(),
  contract_end_date: z.string().optional().nullable(),
  working_type: z.enum(['full_time', 'part_time']).optional().nullable(),
  weekly_hours: z.number().min(0).max(80).optional().nullable(),
  off_days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  personal_email: z.string().email().optional().nullable(),
  date_of_birth: z.string().optional().nullable(),
  nationality: z.string().max(100).optional().nullable(),
  gender: z.string().max(20).optional().nullable(),
  iban: z.string().max(34).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  address: z.string().optional().nullable(),
  cap: z.string().max(10).optional().nullable(),
  first_aid_flag: z.boolean().optional(),
  marital_status: z.string().max(50).optional().nullable(),
  contract_type: z.string().max(100).optional().nullable(),
  probation_months: z.number().int().min(0).max(60).optional().nullable(),
  termination_date: z.string().optional().nullable(),
  termination_type: z.string().max(100).optional().nullable(),
  password: z.string().min(8).optional(), // initial password
});

// Update schema: same as create but company reassignment is restricted.
// Email is optional on edit to keep backward compatibility with older clients.
const updateEmployeeSchema = createEmployeeSchema
  .omit({ company_id: true })
  .extend({
    email: z.string().email('Email non valida').optional(),
  });

const allManagementRoles = ['admin', 'hr', 'area_manager', 'store_manager'] as const;

router.get(
  '/',
  authenticate,
  enforceCompany,
  requireRole(...allManagementRoles),
  requireModulePermission('dipendenti', 'read'),
  listEmployees,
);

router.get(
  '/:id',
  authenticate,
  enforceCompany,
  requireRole(...allManagementRoles, 'employee'),
  requireModulePermission('dipendenti', 'read'),
  getEmployee,
);

router.get(
  '/:id/associations',
  authenticate,
  enforceCompany,
  requireRole(...allManagementRoles, 'employee'),
  requireModulePermission('dipendenti', 'read'),
  getEmployeeAssociations,
);

router.post(
  '/',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr', 'area_manager'),
  requireModulePermission('dipendenti', 'write'),
  validate(createEmployeeSchema),
  auditLog('employee'),
  createEmployee,
);

router.put(
  '/:id',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('dipendenti', 'write'),
  validate(updateEmployeeSchema),
  auditLog('employee'),
  updateEmployee,
);

router.delete(
  '/:id',
  authenticate,
  enforceCompany,
  requireRole('admin'),
  requireModulePermission('dipendenti', 'write'),
  auditLog('employee'),
  deactivateEmployee,
);

router.delete(
  '/:id/permanent',
  authenticate,
  enforceCompany,
  requireRole('admin'),
  requireModulePermission('dipendenti', 'write'),
  auditLog('employee'),
  deleteEmployeePermanently,
);

router.patch(
  '/:id/activate',
  authenticate,
  enforceCompany,
  requireRole('admin'),
  requireModulePermission('dipendenti', 'write'),
  auditLog('employee'),
  activateEmployee,
);

// PATCH /api/employees/:id/device-reset — Admin/HR only
router.patch(
  '/:id/device-reset',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('dipendenti', 'write'),
  auditLog('employee'),
  resetEmployeeDevice,
);

router.use('/:id/trainings', trainingsRoutes);
router.use('/:id/medicals', medicalsRoutes);

// Avatar upload/delete — employee can do their own; managers/admin/hr can do any in company
router.post(
  '/:id/avatar',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr', 'area_manager', 'store_manager', 'employee'),
  uploadMiddleware,
  uploadAvatar,
);

router.delete(
  '/:id/avatar',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr', 'area_manager', 'store_manager', 'employee'),
  deleteAvatar,
);

// Import templates routes
router.get(
  '/import-templates',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('dipendenti', 'read'),
  getImportTemplates,
);

router.post(
  '/import-templates',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('dipendenti', 'write'),
  saveImportTemplate,
);

router.delete(
  '/import-templates/:id',
  authenticate,
  enforceCompany,
  requireRole('admin', 'hr'),
  requireModulePermission('dipendenti', 'write'),
  deleteImportTemplate,
);

export default router;
