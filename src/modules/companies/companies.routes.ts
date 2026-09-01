import { Router } from 'express';
import { z } from 'zod';
import {
  listCompanies,
  getCompanyById,
  updateCompany,
  getCompanySettings,
  updateCompanySettings,
  getBreakSettings,
  updateBreakSettings,
  createCompany,
  deactivateCompany,
  activateCompany,
  deleteCompany,
  transferCompanyOwnership,
} from './companies.controller';
import { authenticate, requireRole, enforceCompany, requireSuperAdmin, requireModulePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { auditLog } from '../../middleware/auditLog';
import { isValidSdiCode, isValidPecEmail, normalizePartitaIva } from '../../utils/italianFiscal';
import {
  companyLogoUploadMiddleware,
  uploadCompanyLogo,
  deleteCompanyLogo,
  companyBannerUploadMiddleware,
  uploadCompanyBanner,
  deleteCompanyBanner,
} from './logo.controller';

const router = Router();

// Italian e-invoicing fields. Optional by design: the companies table already
// holds live client records that predate them, and those must keep saving
// without a value. Format is checked only when something was actually entered.
const optionalFiscalField = (
  max: number,
  isValid: (value: string) => boolean,
  message: string,
) =>
  z
    .string()
    .max(max)
    .nullable()
    .optional()
    .refine((value) => value == null || value.trim() === '' || isValid(value), { message });

// Milestone 1 stores these fields; it does not transmit them to SDI or run
// fiscal checks. Enforcing the Partita IVA control digit here only blocks
// legitimate onboarding, so the rule is the shape: 11 digits once the optional
// IT prefix and separators are removed.
const hasElevenDigits = (value: string) =>
  /^\d{11}$/.test(normalizePartitaIva(value));

const vatNumberField = () =>
  optionalFiscalField(
    20,
    hasElevenDigits,
    'Partita IVA non valida: servono 11 cifre (il prefisso IT e gli spazi sono facoltativi)'
  );
const sdiRecipientCodeField = () =>
  optionalFiscalField(7, isValidSdiCode, 'Codice Destinatario SDI non valido (6-7 caratteri)');
const pecEmailField = () =>
  optionalFiscalField(255, isValidPecEmail, 'Indirizzo PEC non valido');

const updateCompanySchema = z.object({
  name: z.string().min(1, 'Nome azienda obbligatorio').max(255),
  group_id: z.number().int().nullable().optional(),
  registration_number: z.string().max(100).nullable().optional(),
  company_email: z.string().max(255).nullable().optional(),
  company_phone_numbers: z.string().max(1000).nullable().optional(),
  offices_locations: z.string().max(2000).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  currency: z.string().max(50).nullable().optional(),
  price_per_employee: z.number().nullable().optional(),
  price_per_device: z.number().nullable().optional(),
  extra_storage_price_per_gb: z.number().nullable().optional(),
  storage_limit_gb: z.number().nullable().optional(),
  access_valid_from: z.string().nullable().optional(),
  access_valid_to: z.string().nullable().optional(),
  discount_percent: z.number().min(0).max(100).nullable().optional(),
  discount_valid_from: z.string().nullable().optional(),
  discount_valid_to: z.string().nullable().optional(),
  bill_reminder_days_before: z.number().int().min(1).max(30).nullable().optional(),
  grace_period_days: z.number().int().min(0).max(30).nullable().optional(),
  vat_number: vatNumberField(),
  sdi_recipient_code: sdiRecipientCodeField(),
  pec_email: pecEmailField(),
});

const createCompanySchema = z.object({
  name: z.string().min(1, 'Nome azienda obbligatorio').max(255),
  group_id: z.number().int().nullable().optional(),
  owner_user_id: z.number().int().positive().nullable().optional(),
  registration_number: z.string().max(100).nullable().optional(),
  company_email: z.string().max(255).nullable().optional(),
  company_phone_numbers: z.string().max(1000).nullable().optional(),
  offices_locations: z.string().max(2000).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  currency: z.string().max(50).nullable().optional(),
  price_per_employee: z.number().nullable().optional(),
  price_per_device: z.number().nullable().optional(),
  extra_storage_price_per_gb: z.number().nullable().optional(),
  storage_limit_gb: z.number().nullable().optional(),
  access_valid_from: z.string().nullable().optional(),
  access_valid_to: z.string().nullable().optional(),
  discount_percent: z.number().min(0).max(100).nullable().optional(),
  discount_valid_from: z.string().nullable().optional(),
  discount_valid_to: z.string().nullable().optional(),
  bill_reminder_days_before: z.number().int().min(1).max(30).nullable().optional(),
  grace_period_days: z.number().int().min(0).max(30).nullable().optional(),
  vat_number: vatNumberField(),
  sdi_recipient_code: sdiRecipientCodeField(),
  pec_email: pecEmailField(),
});

const transferOwnershipSchema = z.object({
  owner_user_id: z.number().int().positive(),
});

// Axios interceptor sends snake_case
const updateCompanySettingsSchema = z.object({
  show_leave_balance_to_employee: z.boolean(),
});

const updateBreakSettingsSchema = z.object({
  break_enforcement_enabled: z.boolean().optional(),
  break_tolerance_minutes: z.number().int().min(0).max(120).optional(),
});

router.get('/', authenticate, requireRole('admin', 'hr', 'area_manager'), enforceCompany, listCompanies);
router.get('/settings', authenticate, requireRole('admin', 'hr'), enforceCompany, requireModulePermission('impostazioni', 'read'), getCompanySettings);
router.get('/break-settings', authenticate, requireRole('admin', 'hr'), enforceCompany, getBreakSettings);
router.patch('/break-settings', authenticate, requireRole('admin'), enforceCompany, validate(updateBreakSettingsSchema), updateBreakSettings);
router.get('/:id', authenticate, requireRole('admin', 'hr', 'area_manager'), enforceCompany, getCompanyById);
router.patch('/settings', authenticate, requireRole('admin'), enforceCompany, requireModulePermission('impostazioni', 'write'), validate(updateCompanySettingsSchema), updateCompanySettings);
router.put('/:id', authenticate, requireRole('admin', 'hr'), enforceCompany, validate(updateCompanySchema), auditLog('company'), updateCompany);
router.patch('/:id/owner', authenticate, requireRole('admin', 'hr'), enforceCompany, validate(transferOwnershipSchema), auditLog('company'), transferCompanyOwnership);
router.post('/:id/logo', authenticate, requireRole('admin', 'hr'), enforceCompany, companyLogoUploadMiddleware, uploadCompanyLogo);
router.delete('/:id/logo', authenticate, requireRole('admin', 'hr'), enforceCompany, deleteCompanyLogo);
router.post('/:id/banner', authenticate, requireRole('admin', 'hr'), enforceCompany, companyBannerUploadMiddleware, uploadCompanyBanner);
router.delete('/:id/banner', authenticate, requireRole('admin', 'hr'), enforceCompany, deleteCompanyBanner);
router.post('/', authenticate, requireSuperAdmin, validate(createCompanySchema), auditLog('company'), createCompany);

// Super Admin: deactivate / activate / delete a company
router.patch('/:id/deactivate', authenticate, requireSuperAdmin, auditLog('company'), deactivateCompany);
router.patch('/:id/activate', authenticate, requireSuperAdmin, auditLog('company'), activateCompany);
router.delete('/:id', authenticate, requireSuperAdmin, auditLog('company'), deleteCompany);

export default router;
