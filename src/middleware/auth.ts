import { Request, Response, NextFunction } from 'express';
import { verifyAuthToken, JwtPayload, UserRole } from '../config/jwt';
import { resolveAllowedCompanyIds } from '../utils/companyScope';
import { queryOne } from '../config/database';
import { ModuleName, isDefaultEnabledForModule, isRoleEligibleForModule } from '../modules/permissions/permission-catalog';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Token di autorizzazione mancante', code: 'MISSING_TOKEN' });
    return;
  }
  const token = authHeader.slice(7);
  try {
    req.user = verifyAuthToken(token);
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token non valido o scaduto', code: 'INVALID_TOKEN' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Non autenticato', code: 'NOT_AUTHENTICATED' });
      return;
    }
    // Super admins bypass role checks — they have access to every endpoint
    if (req.user.is_super_admin === true) {
      next();
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ success: false, error: 'Accesso negato', code: 'FORBIDDEN' });
      return;
    }
    next();
  };
}

// Guards endpoints that must be accessible only to the Main Admin.
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.is_super_admin !== true) {
    res.status(403).json({ success: false, error: 'Richiede Super Admin', code: 'FORBIDDEN' });
    return;
  }
  next();
}

// Enforces company isolation — all routes must call this after authenticate()
export async function enforceCompany(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Non autenticato', code: 'NOT_AUTHENTICATED' });
    return;
  }

  // Check user's own company expiration first to reject immediately with COMPANY_ACCESS_EXPIRED
  if (req.user.is_super_admin !== true && req.user.companyId !== null) {
    const ownComp = await queryOne<{ is_active: boolean; access_valid_from: string | null; access_valid_to: string | null }>(
      `SELECT is_active, access_valid_from, access_valid_to FROM companies WHERE id = $1`,
      [req.user.companyId]
    );
    if (ownComp) {
      if (ownComp.is_active === false) {
        res.status(403).json({ success: false, error: 'Azienda disattivata.', code: 'COMPANY_INACTIVE' });
        return;
      }
      const now = new Date();
      if (ownComp.access_valid_from && now < new Date(ownComp.access_valid_from)) {
        res.status(403).json({ success: false, error: 'Accesso non ancora attivo per questa azienda.', code: 'COMPANY_ACCESS_NOT_ACTIVE' });
        return;
      }
      if (ownComp.access_valid_to) {
        const toDate = new Date(ownComp.access_valid_to);
        toDate.setHours(23, 59, 59, 999);
        if (now > toDate) {
          res.status(403).json({ success: false, error: 'Il periodo di accesso per questa azienda è scaduto.', code: 'COMPANY_ACCESS_EXPIRED' });
          return;
        }
      }
    }
  }

  // If the request does not explicitly specify a company_id, we let the
  // controller decide based on the user's role/group scope.
  const explicit = req.body?.company_id ?? req.query?.company_id ?? req.params?.company_id;
  const targetCompanyId = explicit === undefined ? req.user.companyId : parseInt(String(explicit), 10);

  // A null companyId with no explicit target is only valid for super admins.
  // Non-super-admin tokens with no company binding must be rejected.
  if (targetCompanyId === null) {
    if (req.user.is_super_admin === true) { next(); return; }
    res.status(403).json({ success: false, error: 'Accesso negato: azienda non valida', code: 'COMPANY_MISMATCH' });
    return;
  }

  if (Number.isNaN(targetCompanyId)) {
    res.status(403).json({ success: false, error: 'Accesso negato: azienda non valida', code: 'COMPANY_MISMATCH' });
    return;
  }

  // Super admin can target any company; group-scoped roles can target any
  // company inside their allowed set (based on company_groups + visibility flags).
  const allowedCompanyIds = await resolveAllowedCompanyIds(req.user);
  if (!allowedCompanyIds.includes(targetCompanyId)) {
    res.status(403).json({ success: false, error: 'Accesso negato: azienda non valida', code: 'COMPANY_MISMATCH' });
    return;
  }

  // Enforce company access validity for non-super-admins
  if (req.user.is_super_admin !== true) {
    const comp = await queryOne<{ access_valid_from: string | null; access_valid_to: string | null }>(
      `SELECT access_valid_from, access_valid_to FROM companies WHERE id = $1`,
      [targetCompanyId]
    );
    if (comp) {
      const now = new Date();
      if (comp.access_valid_from && now < new Date(comp.access_valid_from)) {
        res.status(403).json({ success: false, error: 'Accesso non ancora attivo per questa azienda.', code: 'COMPANY_ACCESS_NOT_ACTIVE' });
        return;
      }
      if (comp.access_valid_to) {
        const toDate = new Date(comp.access_valid_to);
        toDate.setHours(23, 59, 59, 999);
        if (now > toDate) {
          res.status(403).json({ success: false, error: 'Il periodo di accesso per questa azienda è scaduto.', code: 'COMPANY_ACCESS_EXPIRED' });
          return;
        }
      }
    }
  }

  next();
}

export function requireModulePermission(moduleName: string, _action: 'read' | 'write' = 'read') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Non autenticato', code: 'NOT_AUTHENTICATED' });
      return;
    }
    if (req.user.is_super_admin === true) {
      next();
      return;
    }

    const allowedCompanyIds = await resolveAllowedCompanyIds(req.user);
    const explicit = req.body?.target_company_id ?? req.body?.company_id ?? req.query?.target_company_id ?? req.query?.company_id;
    const targetCompanyId = explicit != null ? parseInt(String(explicit), 10) : req.user.companyId;
    if (targetCompanyId == null || Number.isNaN(targetCompanyId) || !allowedCompanyIds.includes(targetCompanyId)) {
      res.status(403).json({ success: false, error: 'Accesso negato: azienda non valida', code: 'COMPANY_MISMATCH' });
      return;
    }

    const mod = moduleName as ModuleName;
    const role = req.user.role;
    // Hard eligibility guard: if the role doesn't make sense for the module, never allow.
    if (!isRoleEligibleForModule(role as never, mod)) {
      res.status(403).json({ success: false, error: 'Modulo non abilitato per questo ruolo', code: 'ROLE_NOT_ELIGIBLE' });
      return;
    }

    const targetRow = await queryOne<{ is_enabled: boolean }>(
      `SELECT is_enabled
       FROM role_module_permissions
       WHERE company_id = $1 AND role = $2 AND module_name = $3
       LIMIT 1`,
      [targetCompanyId, role, moduleName],
    );

    const homeCompanyId = req.user.companyId;
    const canUseHomeCompanyFallback =
      (role === 'admin' || role === 'hr' || role === 'area_manager') &&
      homeCompanyId != null &&
      homeCompanyId !== targetCompanyId &&
      allowedCompanyIds.includes(homeCompanyId);

    let homeRowCache: { is_enabled: boolean } | null | undefined;
    const readHomeCompanyEnablement = async (): Promise<boolean> => {
      if (!canUseHomeCompanyFallback || homeCompanyId == null) return false;
      if (homeRowCache === undefined) {
        homeRowCache = await queryOne<{ is_enabled: boolean }>(
          `SELECT is_enabled
           FROM role_module_permissions
           WHERE company_id = $1 AND role = $2 AND module_name = $3
           LIMIT 1`,
          [homeCompanyId, role, moduleName],
        );
      }

      if (!homeRowCache) {
        return isDefaultEnabledForModule(role as never, mod);
      }

      return homeRowCache.is_enabled === true;
    };

    if (!targetRow) {
      // If the DB has no explicit row, apply the same default-on policy
      // used by /api/permissions so runtime access matches UI expectations.
      if (isDefaultEnabledForModule(role as never, mod)) {
        next();
        return;
      }

      if (await readHomeCompanyEnablement()) {
        next();
        return;
      }

      res.status(403).json({ success: false, error: 'Modulo disabilitato per il ruolo', code: 'MODULE_DISABLED', moduleName });
      return;
    }

    if (targetRow.is_enabled === false) {
      if (await readHomeCompanyEnablement()) {
        next();
        return;
      }

      res.status(403).json({ success: false, error: 'Modulo disabilitato per il ruolo', code: 'MODULE_DISABLED', moduleName });
      return;
    }

    next();
  };
}
