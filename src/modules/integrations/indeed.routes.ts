import { Router, Request, Response } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, badRequest, notFound } from '../../utils/response';
import { queryOne } from '../../config/database';
import { getCompanyIndeedStatus, setCompanyIndeedConfig } from '../../services/indeedCredentials.service';
import { isSecretCryptoAvailable } from '../../utils/secretCrypto';

const router = Router();

/**
 * Per-company Indeed Apply credentials, managed by the company's Admin/HR.
 * Values are stored encrypted (see indeedCredentials.service). The raw token/
 * secret are NEVER returned to the browser — only a masked status.
 */

// Resolve which company the caller may act on. Admin/HR are locked to their own
// company; super admins may target any company via company_id.
function resolveTargetCompanyId(req: Request): number | null {
  const user = req.user!;
  if (user.is_super_admin) {
    const raw = (req.body?.company_id ?? req.body?.companyId ?? req.query.company_id) as string | number | undefined;
    const parsed = typeof raw === 'number' ? raw : (raw ? parseInt(String(raw), 10) : NaN);
    return Number.isFinite(parsed) ? parsed : (user.companyId ?? null);
  }
  return user.companyId ?? null;
}

// GET /api/integrations/indeed/config  → masked status
router.get('/config', authenticate, requireRole('admin', 'hr'), asyncHandler(async (req: Request, res: Response) => {
  const companyId = resolveTargetCompanyId(req);
  if (!companyId) { notFound(res, 'Company not found'); return; }

  const company = await queryOne<{ id: number; name: string; slug: string }>(
    `SELECT id, name, slug FROM companies WHERE id = $1 LIMIT 1`,
    [companyId],
  );
  if (!company) { notFound(res, 'Company not found'); return; }

  const status = await getCompanyIndeedStatus(companyId, company.slug);
  ok(res, {
    company: { id: company.id, name: company.name },
    encryptionAvailable: isSecretCryptoAvailable(),
    ...status,
  });
}));

// PUT /api/integrations/indeed/config  → set/update token and/or secret
// Body: { apiToken?: string, secret?: string }  (empty string clears a field)
router.put('/config', authenticate, requireRole('admin', 'hr'), asyncHandler(async (req: Request, res: Response) => {
  const companyId = resolveTargetCompanyId(req);
  if (!companyId) { badRequest(res, 'Company ID is required', 'VALIDATION_ERROR'); return; }

  if (!isSecretCryptoAvailable()) {
    badRequest(res, 'Encryption key not configured on the server; cannot store credentials securely.', 'ENCRYPTION_UNAVAILABLE');
    return;
  }

  const body = req.body as { apiToken?: unknown; secret?: unknown };
  const updates: { apiToken?: string; secret?: string } = {};
  if (body.apiToken !== undefined) {
    if (typeof body.apiToken !== 'string') { badRequest(res, 'apiToken must be a string', 'VALIDATION_ERROR'); return; }
    updates.apiToken = body.apiToken.trim();
  }
  if (body.secret !== undefined) {
    if (typeof body.secret !== 'string') { badRequest(res, 'secret must be a string', 'VALIDATION_ERROR'); return; }
    updates.secret = body.secret.trim();
  }
  if (updates.apiToken === undefined && updates.secret === undefined) {
    badRequest(res, 'Nothing to update', 'VALIDATION_ERROR');
    return;
  }

  await setCompanyIndeedConfig(companyId, updates);

  const company = await queryOne<{ slug: string }>(`SELECT slug FROM companies WHERE id = $1 LIMIT 1`, [companyId]);
  const status = await getCompanyIndeedStatus(companyId, company?.slug ?? '');
  ok(res, status, 'Indeed credentials saved');
}));

// DELETE /api/integrations/indeed/config  → clear both fields (fall back to env)
router.delete('/config', authenticate, requireRole('admin', 'hr'), asyncHandler(async (req: Request, res: Response) => {
  const companyId = resolveTargetCompanyId(req);
  if (!companyId) { badRequest(res, 'Company ID is required', 'VALIDATION_ERROR'); return; }

  await setCompanyIndeedConfig(companyId, { apiToken: '', secret: '' });

  const company = await queryOne<{ slug: string }>(`SELECT slug FROM companies WHERE id = $1 LIMIT 1`, [companyId]);
  const status = await getCompanyIndeedStatus(companyId, company?.slug ?? '');
  ok(res, status, 'Indeed credentials cleared');
}));

export default router;
