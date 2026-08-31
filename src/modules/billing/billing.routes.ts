import { Router } from 'express';
import { billingController } from './billing.controller';
import { requireRole, requireSuperAdmin, enforceCompany } from '../../middleware/auth';

const router = Router();

// Company Admin billing endpoints
router.post(
  '/checkout',
  requireRole('admin'),
  enforceCompany,
  (req, res) => billingController.createCheckout(req, res)
);

router.get(
  '/overview',
  requireRole('admin'),
  enforceCompany,
  (req, res) => billingController.getOverview(req, res)
);

router.get(
  '/transactions',
  requireRole('admin'),
  enforceCompany,
  (req, res) => billingController.getTransactions(req, res)
);

router.post(
  '/cancel',
  requireRole('admin'),
  enforceCompany,
  (req, res) => billingController.cancel(req, res)
);

router.post(
  '/reactivate',
  requireRole('admin'),
  enforceCompany,
  (req, res) => billingController.reactivate(req, res)
);

router.post(
  '/payment-method',
  requireRole('admin'),
  enforceCompany,
  (req, res) => billingController.updatePaymentMethod(req, res)
);

// Licenses: what the company bought, what it is using, and changing it.
router.get(
  '/licenses',
  requireRole('admin'),
  enforceCompany,
  (req, res) => billingController.getLicenses(req, res)
);

router.post(
  '/licenses/verify',
  requireRole('admin'),
  enforceCompany,
  (req, res) => billingController.verifyPendingUpgrade(req, res)
);

router.post(
  '/licenses/quote',
  requireRole('admin'),
  enforceCompany,
  (req, res) => billingController.quoteLicenses(req, res)
);

router.post(
  '/licenses',
  requireRole('admin'),
  enforceCompany,
  (req, res) => billingController.changeLicenses(req, res)
);

// Read-only status for the app shell. No enforceCompany: it must answer even
// for a company whose access is currently restricted.
router.get(
  '/status',
  (req, res) => billingController.getStatus(req, res)
);

router.get(
  '/headcount-history',
  requireRole('admin'),
  enforceCompany,
  (req, res) => billingController.getHeadcountHistory(req, res)
);

// Super Admin billing endpoints
router.get(
  '/admin/overview',
  requireSuperAdmin,
  (req, res) => billingController.getSuperAdminOverview(req, res)
);

// Authorisation is done inside the handler: super admin -> any company,
// company admin -> only companies within their own scope.
router.get(
  '/admin/companies/:id',
  requireRole('admin'),
  (req, res) => billingController.getAdminCompanyBilling(req, res)
);

export default router;
