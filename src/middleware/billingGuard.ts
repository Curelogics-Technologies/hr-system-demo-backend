import { Request, Response, NextFunction } from 'express';
import { subscriptionService } from '../modules/billing/subscription.service';
import { verifyAuthToken } from '../config/jwt';
import { isBillingEnforced } from '../modules/billing/license.service';

/**
 * This guard is mounted on '/api' ahead of the feature routers, which each run
 * their own authenticate(). At that point req.user is not populated yet, so the
 * guard resolves the bearer token itself. Resolution is deliberately silent:
 * an absent or invalid token is left for the route's own authenticate() to
 * reject with 401, and the guard simply lets the request through.
 */
function resolveUser(req: Request) {
  if (req.user) return req.user;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    return verifyAuthToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function billingGuard(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const user = resolveUser(req);

  // Unauthenticated / public traffic — the route itself decides.
  if (!user) {
    return next();
  }

  // 1. Super Admins and System Admins always have unrestricted platform access
  if (user.is_super_admin || user.role === 'system_admin') {
    return next();
  }

  // 2. Store terminals must ALWAYS function for physical clock-in/clock-out
  if (user.role === 'store_terminal') {
    return next();
  }

  // 3. Exempt path prefixes.
  //
  // These are session-bootstrap and billing routes, not business data. The app
  // cannot render its shell — including the billing page a blocked company is
  // supposed to be sent to — without /auth and /permissions, so blocking those
  // does not restrict the customer, it locks them out of logging in entirely.
  //
  // A company that has not paid keeps a small working set: it must be able to
  // complete its own company details (VAT / SDI / PEC) before it can pay at
  // all, reach its settings and profile, read messages, and see its access
  // configuration. Everything operational — employees, shifts, attendance,
  // reports, documents — stays blocked.
  const path = req.path || '';
  const exemptPrefixes = [
    '/billing',
    '/auth',
    '/permissions',
    '/companies',
    '/messages',
    '/notifications',
    '/device',
    '/legal',
    '/public',
  ];

  if (exemptPrefixes.some((p) => path.startsWith(p))) {
    return next();
  }

  const companyId = user.companyId;
  if (!companyId) {
    return next();
  }

  try {
    // Companies that predate the billing module are not enforced until the
    // system administrator switches them on. Without this, deploying would
    // lock every existing customer out on the first request.
    const enforced = await isBillingEnforced(companyId);
    if (!enforced) {
      return next();
    }

    const access = await subscriptionService.checkBillingAccess(companyId);

    if (access.isBlocked) {
      if (access.reason === 'GRACE_PERIOD_EXPIRED') {
        return res.status(403).json({
          error: 'SUBSCRIPTION_BLOCKED',
          code: 'SUBSCRIPTION_BLOCKED',
          reason: 'GRACE_PERIOD_EXPIRED',
          gracePeriodEndsAt: access.gracePeriodEndsAt ?? null,
          message:
            'Il pagamento dell’abbonamento non è andato a buon fine e il periodo di tolleranza è terminato. ' +
            'L’accesso resta limitato alla sezione Fatturazione finché il pagamento non viene completato.',
        });
      }

      return res.status(403).json({
        error: 'SUBSCRIPTION_REQUIRED',
        code: 'SUBSCRIPTION_REQUIRED',
        reason: access.reason ?? 'NO_SUBSCRIPTION',
        message:
          'Questa azienda non ha ancora un abbonamento attivo. ' +
          'Vai su Fatturazione, scegli il numero di licenze per dipendenti e terminali e completa il pagamento per sbloccare la piattaforma.',
      });
    }

    // Attach grace period notice if applicable
    if (access.reason === 'PAST_DUE' && access.gracePeriodEndsAt) {
      res.setHeader(
        'X-Billing-Warning',
        `Payment past due. Grace period ends on ${access.gracePeriodEndsAt.toISOString()}`
      );
    }

    return next();
  } catch (err: any) {
    console.error('[BillingGuard] Error checking access:', err);
    // In case of unexpected DB error, fail open or log warning to avoid unexpected service denial
    return next();
  }
}
