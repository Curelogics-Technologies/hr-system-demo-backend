import { Request, Response } from 'express';
import { subscriptionService, BillingError } from './subscription.service';
import { PaymentProvider } from './gateway.interface';
import { pool } from '../../config/database';
import { getHeadcountHistory } from './headcount.service';
import { getLicenseSnapshot, isBillingEnforced } from './license.service';
import { resolveAllowedCompanyIds } from '../../utils/companyScope';
import { describeTaxConfig, getTaxConfig, loadTaxConfig, setStripeTaxRateId } from './tax';
import { realignSubscriptionTaxRates, syncBillingTaxRate } from './tax.sync';
import { sendPaymentFailedTestNotice, resolveFailureRecipients } from './billing.notifications';
import { getPlatformSmtpConfig, isPlatformSmtpConfigured } from '../../services/platformEmail.service';

/**
 * Reads the license quantities from a request body.
 *
 * The frontend API client rewrites outgoing bodies to snake_case, so the same
 * field arrives as employee_licenses from the browser and employeeLicenses
 * from a direct API call. Accept both rather than silently reading undefined.
 */
function readLicenseBody(req: Request): {
  employeeLicenses: number | null;
  terminalLicenses: number | null;
} {
  const body = (req.body || {}) as Record<string, unknown>;
  const pick = (...names: string[]): number | null => {
    for (const n of names) {
      const raw = body[n];
      if (raw === undefined || raw === null || raw === '') continue;
      const num = Number(raw);
      if (Number.isFinite(num)) return Math.floor(num);
    }
    return null;
  };
  return {
    employeeLicenses: pick('employeeLicenses', 'employee_licenses'),
    terminalLicenses: pick('terminalLicenses', 'terminal_licenses'),
  };
}

export class BillingController {
  /**
   * Resolves which company this request is about.
   *
   * An explicitly requested company id is honoured only after checking it
   * against the caller's real scope in the database. The JWT does not carry
   * allowedCompanyIds, so the previous check against req.user.allowedCompanyIds
   * was always undefined — every non-super-admin silently fell back to their
   * own company, which is why the company selector appeared to do nothing.
   */
  private async getEffectiveCompanyId(req: Request): Promise<number | null> {
    const explicit =
      req.body?.company_id ??
      req.body?.companyId ??
      req.query?.company_id ??
      req.query?.companyId ??
      req.params?.company_id ??
      req.params?.companyId ??
      req.headers['x-company-id'];

    if (explicit && req.user) {
      const parsed = parseInt(String(explicit), 10);
      if (!isNaN(parsed) && parsed > 0) {
        if (req.user.is_super_admin || req.user.role === 'system_admin') {
          return parsed;
        }
        if (parsed === req.user.companyId) {
          return parsed;
        }
        const allowed = await resolveAllowedCompanyIds(req.user);
        if (allowed.includes(parsed)) {
          return parsed;
        }
        // Requested a company the caller has no claim on — fall through to
        // their own company rather than serving another company's billing.
      }
    }

    if (req.user?.companyId) {
      return req.user.companyId;
    }
    if (req.user?.is_super_admin) {
      return null;
    }
    return null;
  }

  /**
   * POST /api/billing/checkout
   * Initiates checkout session for the company admin
   */
  async createCheckout(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }

      const { provider } = req.body as { provider: PaymentProvider };
      if (!provider || !['stripe', 'paypal'].includes(provider)) {
        return res.status(400).json({ error: 'Valid provider (stripe or paypal) is required' });
      }

      const appBaseUrl =
        (req.headers.origin as string) ||
        (req.headers.referer ? new URL(req.headers.referer).origin : undefined);

      const { employeeLicenses, terminalLicenses } = readLicenseBody(req);

      const result = await subscriptionService.initiateCheckout({
        companyId,
        provider,
        appBaseUrl,
        ...(employeeLicenses !== null ? { employeeLicenses } : {}),
        ...(terminalLicenses !== null ? { terminalLicenses } : {}),
      });

      return res.json(result);
    } catch (err: any) {
      if (err instanceof BillingError) {
        console.warn('[BillingController] createCheckout rejected:', err.code, err.message);
        return res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
          ...(err.details || {}),
        });
      }
      console.error('[BillingController] createCheckout error:', err);
      return res.status(500).json({ error: err.message || 'Failed to create checkout session' });
    }
  }

  /**
   * GET /api/billing/overview
   * Returns current subscription, live counts, pricing, and recent transactions
   */
  async getOverview(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }

      const overview = await subscriptionService.getCompanyBillingOverview(companyId);

      // `taxPercent` stays for everyone: it labels the tax line on the
      // customer's own invoice, which is their money and their right to see.
      // The `tax` block is the platform's configuration - which Stripe rate
      // object, when it was last synced, what went wrong - and belongs to the
      // operator alone.
      const isOperator = !!(req.user?.is_super_admin || req.user?.role === 'system_admin');
      if (!isOperator) {
        delete (overview as any).tax;
      }

      return res.json(overview);
    } catch (err: any) {
      console.error('[BillingController] getOverview error:', err);
      return res.status(500).json({ error: err.message || 'Failed to fetch billing overview' });
    }
  }

  /**
   * GET /api/billing/transactions
   * Returns paginated transaction history
   */
  async getTransactions(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }

      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      const countRes = await pool.query(
        `SELECT COUNT(*)::int AS total FROM billing_transactions WHERE company_id = $1`,
        [companyId]
      );
      const total = countRes.rows[0]?.total || 0;

      const txRes = await pool.query(
        `SELECT * FROM billing_transactions 
         WHERE company_id = $1 
         ORDER BY id DESC 
         LIMIT $2 OFFSET $3`,
        [companyId, limit, offset]
      );

      return res.json({
        data: txRes.rows.map((tx) => ({
          id: tx.id,
          provider: tx.provider,
          amountCents: tx.amount_cents,
          currency: tx.currency,
          status: tx.status,
          kind: tx.kind,
          description: tx.description,
          seatQuantity: tx.seat_quantity,
          deviceQuantity: tx.device_quantity,
          invoiceUrl: tx.invoice_url,
          failureCode: tx.failure_code,
          failureMessage: tx.failure_message,
          attemptCount: tx.attempt_count,
          paidAt: tx.paid_at,
          createdAt: tx.created_at,
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err: any) {
      console.error('[BillingController] getTransactions error:', err);
      return res.status(500).json({ error: err.message || 'Failed to fetch transactions' });
    }
  }

  /**
   * POST /api/billing/cancel
   * Schedules subscription cancellation at end of current period
   */
  async cancel(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }

      const result = await subscriptionService.cancelSubscription(companyId);
      return res.json(result);
    } catch (err: any) {
      console.error('[BillingController] cancel error:', err);
      return res.status(500).json({ error: err.message || 'Failed to cancel subscription' });
    }
  }

  /**
   * POST /api/billing/reactivate
   * Undoes pending cancellation
   */
  async reactivate(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }

      const result = await subscriptionService.reactivateSubscription(companyId);
      return res.json(result);
    } catch (err: any) {
      console.error('[BillingController] reactivate error:', err);
      return res.status(500).json({ error: err.message || 'Failed to reactivate subscription' });
    }
  }

  /**
   * POST /api/billing/payment-method
   * Hosted page for replacing the card on an active subscription.
   */
  async updatePaymentMethod(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }
      const appBaseUrl =
        (req.headers.origin as string) ||
        (req.headers.referer ? new URL(req.headers.referer).origin : undefined);

      const result = await subscriptionService.startPaymentMethodUpdate({
        companyId,
        appBaseUrl,
      });
      return res.json(result);
    } catch (err: any) {
      if (err instanceof BillingError) {
        return res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
          ...(err.details || {}),
        });
      }
      console.error('[BillingController] updatePaymentMethod error:', err);
      return res.status(500).json({ error: err.message || 'Failed to start payment method update' });
    }
  }

  /**
   * POST /api/billing/licenses/verify
   * Asks the provider what happened to an in-flight upgrade and settles it.
   * The admin's escape hatch when the UI still says "awaiting confirmation".
   */
  async verifyPendingUpgrade(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }
      const result = await subscriptionService.reconcilePendingUpgrade(companyId);
      const snapshot = await getLicenseSnapshot(companyId);
      return res.json({ ...result, licenses: snapshot });
    } catch (err: any) {
      console.error('[BillingController] verifyPendingUpgrade error:', err);
      return res.status(500).json({ error: err.message || 'Failed to verify the payment' });
    }
  }

  /**
   * GET /api/billing/licenses
   * Current allowance, usage and any change in flight.
   */
  async getLicenses(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }
      // Settle anything the webhook missed before reporting the allowance,
      // so a stuck "awaiting confirmation" resolves itself on page load.
      try {
        await subscriptionService.reconcilePendingUpgrade(companyId);
      } catch (err: any) {
        console.error('[BillingController] reconcile failed:', err?.message || err);
      }

      const snapshot = await getLicenseSnapshot(companyId);
      return res.json(snapshot);
    } catch (err: any) {
      console.error('[BillingController] getLicenses error:', err);
      return res.status(500).json({ error: err.message || 'Failed to fetch licenses' });
    }
  }

  /**
   * POST /api/billing/licenses/quote
   * What a proposed license change would cost. No side effects.
   */
  async quoteLicenses(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }
      const { employeeLicenses, terminalLicenses } = readLicenseBody(req);
      if (employeeLicenses === null || terminalLicenses === null) {
        return res.status(400).json({ error: 'employeeLicenses and terminalLicenses are required' });
      }
      const quote = await subscriptionService.quoteLicenseChange({
        companyId,
        employeeLicenses,
        terminalLicenses,
      });
      return res.json(quote);
    } catch (err: any) {
      console.error('[BillingController] quoteLicenses error:', err);
      return res.status(500).json({ error: err.message || 'Failed to quote license change' });
    }
  }

  /**
   * POST /api/billing/licenses
   * Buys more licenses (charged now, prorated) or schedules a reduction.
   */
  async changeLicenses(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }
      const { employeeLicenses, terminalLicenses } = readLicenseBody(req);
      if (employeeLicenses === null || terminalLicenses === null) {
        return res.status(400).json({ error: 'employeeLicenses and terminalLicenses are required' });
      }
      const result = await subscriptionService.requestLicenseChange({
        companyId,
        employeeLicenses,
        terminalLicenses,
      });
      return res.json(result);
    } catch (err: any) {
      if (err instanceof BillingError) {
        return res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
          ...(err.details || {}),
        });
      }
      console.error('[BillingController] changeLicenses error:', err);
      return res.status(500).json({ error: err.message || 'Failed to change licenses' });
    }
  }

  /**
   * GET /api/billing/admin/overview
   * Super Admin dashboard overview across all companies
   */
  async getSuperAdminOverview(_req: Request, res: Response) {
    try {
      const rows = await subscriptionService.getSuperAdminBillingOverview();
      return res.json(rows);
    } catch (err: any) {
      console.error('[BillingController] getSuperAdminOverview error:', err);
      return res.status(500).json({ error: err.message || 'Failed to fetch admin billing overview' });
    }
  }

  /**
   * GET /api/billing/status
   * Small, cheap payload the app shell polls to decide which navigation the
   * company may use while unpaid. Deliberately separate from /overview so the
   * sidebar does not pull the full billing page payload on every render.
   */
  async getStatus(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.json({ status: null, isBlocked: false, restricted: false });
      }

      // Super admins are never restricted by their own company's billing.
      if (req.user?.is_super_admin || req.user?.role === 'system_admin') {
        return res.json({ status: null, isBlocked: false, restricted: false });
      }

      if (!(await isBillingEnforced(companyId))) {
        return res.json({ isBlocked: false, restricted: false, enforced: false });
      }

      const access = await subscriptionService.checkBillingAccess(companyId);
      return res.json({
        enforced: true,
        isBlocked: access.isBlocked,
        restricted: access.isBlocked,
        reason: access.reason ?? null,
        gracePeriodEndsAt: access.gracePeriodEndsAt ?? null,
      });
    } catch (err: any) {
      console.error('[BillingController] getStatus error:', err);
      // Never let this endpoint break the app shell.
      return res.json({ isBlocked: false, restricted: false });
    }
  }

  /**
   * GET /api/billing/tax
   *
   * The tax rate as the platform currently knows it: the figure every total on
   * screen is built from, where it came from, and when it was last confirmed
   * against Stripe. Readable by any billing admin, because it explains the tax
   * line on their own invoice.
   */
  async getTax(_req: Request, res: Response) {
    try {
      // Read through storage rather than trusting this process's copy: another
      // instance may have synced since this one booted.
      const cfg = await loadTaxConfig();
      return res.json(describeTaxConfig(cfg));
    } catch (err: any) {
      console.error('[BillingController] getTax error:', err);
      // Never break the billing page over the tax panel: fall back to whatever
      // this process already holds.
      return res.json(describeTaxConfig(getTaxConfig()));
    }
  }

  /**
   * PUT /api/billing/tax
   *
   * Chooses which Stripe Tax Rate this platform charges, then reads it back
   * from Stripe immediately so the caller sees the real percentage rather than
   * the id they just typed. The rate itself is still created and owned in the
   * Stripe dashboard - only the choice of which one to use lives here.
   */
  async setTax(req: Request, res: Response) {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const raw = body.stripeTaxRateId ?? body.stripe_tax_rate_id ?? '';
      const rateId = String(raw ?? '').trim();

      // Cheap shape check, so an obvious paste error is rejected here with a
      // clear message instead of coming back as "Stripe has no tax rate ..."
      // after a network round trip.
      if (rateId && !/^txr_[A-Za-z0-9]+$/.test(rateId)) {
        return res.status(400).json({
          error:
            'A Stripe tax rate id looks like txr_1AbC… — copy it from Stripe > Product catalogue > Tax rates.',
        });
      }

      await setStripeTaxRateId(rateId || null);
      await syncBillingTaxRate();

      // Existing subscriptions point at the previous Stripe Tax Rate object -
      // they are immutable, so a new percentage is a new object - and would
      // otherwise keep renewing at the old rate forever. Correct them now
      // rather than waiting for tonight's job, because the operator is
      // standing in front of the screen expecting the change to have happened.
      const realignment = await realignSubscriptionTaxRates();

      const cfg = getTaxConfig();
      return res.json({
        ...describeTaxConfig(cfg),
        realignment,
        ok: rateId === '' || (cfg.source === 'stripe' && !cfg.syncError),
      });
    } catch (err: any) {
      console.error('[BillingController] setTax error:', err);
      return res.status(500).json({ error: err.message || 'Could not save the tax rate' });
    }
  }

  /**
   * POST /api/billing/tax/sync
   *
   * Pulls the rate from Stripe again. Stripe owns the rate; this only refreshes
   * the local mirror, so it is safe to press at any time and changes nothing at
   * the provider. Super admin only - it is a platform-wide setting, not a
   * company one.
   */
  async syncTax(_req: Request, res: Response) {
    try {
      await syncBillingTaxRate();
      const realignment = await realignSubscriptionTaxRates();
      const cfg = getTaxConfig();
      const described = describeTaxConfig(cfg);

      // A sync that reached Stripe but found nothing usable is not an error the
      // caller should see as a failure - the answer is on the row.
      return res.json({
        ...described,
        realignment,
        ok: cfg.source === 'stripe' && !cfg.syncError,
      });
    } catch (err: any) {
      console.error('[BillingController] syncTax error:', err);
      return res
        .status(502)
        .json({ error: err.message || 'Could not read the tax rate from Stripe' });
    }
  }

  /**
   * GET /api/billing/notices/recipients
   *
   * Who a failed-payment warning for this company would actually reach, and
   * which mailbox would carry it.
   *
   * This is the question the email settings page needs to answer on screen -
   * "VeylOHR <billing@…> writes to Mario <mario@…>" - because the alternative
   * is an operator saving credentials and hoping. It resolves the recipients
   * exactly as the real alert does, so what is drawn is what would happen.
   */
  async getNoticeRecipients(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }

      const [recipients, platform] = await Promise.all([
        resolveFailureRecipients(companyId),
        getPlatformSmtpConfig(),
      ]);

      const company = await pool.query(`SELECT name FROM companies WHERE id = $1`, [companyId]);

      return res.json({
        companyId,
        companyName: company.rows[0]?.name ?? null,
        ownerEmail: recipients.owner?.email ?? null,
        ownerName: recipients.owner?.name ?? null,
        companyEmail: recipients.companyEmail,
        inAppRecipients: recipients.inAppUserIds.length,
        platform: {
          configured: isPlatformSmtpConfigured(platform),
          from: platform.smtpFrom || platform.smtpUser || null,
          alertEmail: platform.billingAlertEmail || process.env.BILLING_ALERT_EMAIL || null,
        },
      });
    } catch (err: any) {
      console.error('[BillingController] getNoticeRecipients error:', err);
      return res.status(500).json({ error: err.message || 'Could not resolve the recipients' });
    }
  }

  /**
   * POST /api/billing/notices/test
   *
   * Rehearses the failed-payment alert for a company: the same recipients, the
   * same SMTP configuration, the same in-app notification, everything labelled
   * as a test. Nothing about the subscription changes.
   *
   * This exists because the alternative way to prove the alert works is to let
   * a real customer's renewal fail.
   */
  async sendTestNotice(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }

      const delivery = await sendPaymentFailedTestNotice({ companyId });
      return res.json(delivery);
    } catch (err: any) {
      console.error('[BillingController] sendTestNotice error:', err);
      return res.status(500).json({ error: err.message || 'Could not send the test notice' });
    }
  }

  /**
   * GET /api/billing/headcount-history
   * The audit trail behind the billed quantities.
   */
  async getHeadcountHistory(req: Request, res: Response) {
    try {
      const companyId = await this.getEffectiveCompanyId(req);
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit as string) || 100));
      const history = await getHeadcountHistory(companyId, limit);
      return res.json(history);
    } catch (err: any) {
      console.error('[BillingController] getHeadcountHistory error:', err);
      return res.status(500).json({ error: err.message || 'Failed to fetch headcount history' });
    }
  }

  /**
   * GET /api/billing/admin/companies/:id
   * Billing detail for one company. Super admins may read any company; a
   * company admin may read their own, which is what the Billing tab on the
   * company detail page uses.
   */
  async getAdminCompanyBilling(req: Request, res: Response) {
    try {
      const companyId = parseInt(req.params.id);
      if (isNaN(companyId)) {
        return res.status(400).json({ error: 'Valid company ID is required' });
      }

      const isSuper = req.user?.is_super_admin || req.user?.role === 'system_admin';
      if (!isSuper) {
        if (req.user?.role !== 'admin') {
          return res.status(403).json({ error: 'Accesso negato', code: 'FORBIDDEN' });
        }
        const allowed =
          companyId === req.user?.companyId ||
          (req.user ? (await resolveAllowedCompanyIds(req.user)).includes(companyId) : false);
        if (!allowed) {
          return res.status(403).json({ error: 'Accesso negato', code: 'FORBIDDEN' });
        }
      }

      const overview = await subscriptionService.getCompanyBillingOverview(companyId);
      return res.json(overview);
    } catch (err: any) {
      console.error('[BillingController] getAdminCompanyBilling error:', err);
      return res.status(500).json({ error: err.message || 'Failed to fetch company billing details' });
    }
  }
}

export const billingController = new BillingController();
