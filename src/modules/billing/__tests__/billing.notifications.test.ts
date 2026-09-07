import { pool } from '../../../config/database';
import { sendEmailForCompany } from '../../../services/email.service';
import { sendNotification } from '../../notifications/notifications.service';
import { sendPaymentFailedNotices, resolveFailureRecipients } from '../billing.notifications';

jest.mock('../../../config/database', () => ({
  pool: { query: jest.fn() },
  query: jest.fn(),
  queryOne: jest.fn(),
}));
jest.mock('../../../services/email.service', () => ({
  sendEmailForCompany: jest.fn(),
}));
jest.mock('../../notifications/notifications.service', () => ({
  sendNotification: jest.fn(),
}));

const mockQuery = pool.query as unknown as jest.Mock;
const mockEmail = sendEmailForCompany as unknown as jest.Mock;
const mockNotify = sendNotification as unknown as jest.Mock;

/** The two queries `resolveFailureRecipients` makes, in order. */
function mockRecipients(opts: {
  companyEmail?: string | null;
  owner?: { id: number; email: string; name: string } | null;
  admin?: { id: number; email: string; name: string } | null;
  adminIds?: number[];
}) {
  mockQuery.mockResolvedValueOnce({
    rowCount: 1,
    rows: [
      {
        company_email: opts.companyEmail ?? null,
        owner_id: opts.owner?.id ?? null,
        owner_email: opts.owner?.email ?? null,
        owner_name: opts.owner?.name ?? null,
        owner_surname: null,
        admin_id: opts.admin?.id ?? null,
        admin_email: opts.admin?.email ?? null,
        admin_name: opts.admin?.name ?? null,
        admin_surname: null,
      },
    ],
  });
  mockQuery.mockResolvedValueOnce({
    rowCount: (opts.adminIds ?? []).length,
    rows: (opts.adminIds ?? []).map((id) => ({ id })),
  });
}

const baseNotice = {
  companyId: 7,
  companyName: 'Fusaro Uomo',
  provider: 'stripe',
  amountCents: 12_200,
  currency: 'EUR',
  gracePeriodEndsAt: new Date('2026-09-11T00:00:00Z'),
  graceDays: 3,
  failureMessage: 'Your card was declined.',
};

beforeEach(() => {
  mockQuery.mockReset();
  mockEmail.mockReset();
  mockNotify.mockReset();
  mockNotify.mockResolvedValue(undefined);
  delete process.env.BILLING_ALERT_EMAIL;
});

describe('resolveFailureRecipients', () => {
  it('addresses the account owner when the company has one', async () => {
    mockRecipients({
      owner: { id: 3, email: 'owner@fusaro.it', name: 'Francesca' },
      admin: { id: 9, email: 'admin@fusaro.it', name: 'Marco' },
      adminIds: [9],
    });

    const res = await resolveFailureRecipients(7);

    expect(res.owner?.email).toBe('owner@fusaro.it');
    expect(res.owner?.userId).toBe(3);
    // The in-app alert goes wider than the email: the owner plus every admin.
    expect(res.inAppUserIds.sort()).toEqual([3, 9]);
  });

  it('falls back to the first active admin when no owner is recorded', async () => {
    mockRecipients({
      owner: null,
      admin: { id: 9, email: 'admin@fusaro.it', name: 'Marco' },
      adminIds: [9, 11],
    });

    const res = await resolveFailureRecipients(7);

    // Warning the wrong administrator beats warning nobody.
    expect(res.owner?.email).toBe('admin@fusaro.it');
    expect(res.owner?.userId).toBe(9);
  });

  it('reports no recipient rather than inventing one', async () => {
    mockRecipients({ owner: null, admin: null, adminIds: [] });
    const res = await resolveFailureRecipients(7);
    expect(res.owner).toBeNull();
  });
});

describe('sendPaymentFailedNotices', () => {
  it('reports the owner email as sent, and alerts everyone in-app', async () => {
    mockRecipients({
      owner: { id: 3, email: 'owner@fusaro.it', name: 'Francesca' },
      adminIds: [3, 9],
    });
    mockEmail.mockResolvedValue({ ok: true, status: 'sent' });

    const delivery = await sendPaymentFailedNotices(baseNotice);

    expect(delivery.ownerStatus).toBe('sent');
    expect(delivery.ownerEmail).toBe('owner@fusaro.it');
    expect(delivery.inAppCount).toBe(2);
    expect(mockNotify).toHaveBeenCalledTimes(2);

    // The alert must not be suppressible by a company's own notification
    // settings: it is the warning that its access is about to stop.
    expect(mockNotify.mock.calls[0][0]).toMatchObject({
      type: 'billing.payment_failed',
      priority: 'urgent',
      skipSettingsCheck: true,
    });

    // The settle-by date is the point of the email, so it has to be in it.
    const [, options] = mockEmail.mock.calls[0];
    expect(options.subject).toContain('11/09/2026');
    expect(options.text).toContain('11/09/2026');
  });

  it('distinguishes "no SMTP configured" from "sent"', async () => {
    mockRecipients({
      owner: { id: 3, email: 'owner@fusaro.it', name: 'Francesca' },
      adminIds: [3],
    });
    mockEmail.mockResolvedValue({
      ok: false,
      status: 'skipped',
      message: 'SMTP configuration missing or incomplete',
    });

    const delivery = await sendPaymentFailedNotices(baseNotice);

    // This is the failure mode that looks like success: nothing errored, and
    // the customer was never told. It has to be visible on the billing page.
    expect(delivery.ownerStatus).toBe('skipped');
    expect(delivery.ownerError).toMatch(/SMTP/);
    // The in-app alert still went out, which is why it is sent first.
    expect(delivery.inAppCount).toBe(1);
  });

  it('reports a refused send as failed, with the server’s reason', async () => {
    mockRecipients({
      owner: { id: 3, email: 'owner@fusaro.it', name: 'Francesca' },
      adminIds: [3],
    });
    mockEmail.mockResolvedValue({ ok: false, status: 'failed', message: 'Mailbox unavailable' });

    const delivery = await sendPaymentFailedNotices(baseNotice);

    expect(delivery.ownerStatus).toBe('failed');
    expect(delivery.ownerError).toBe('Mailbox unavailable');
  });

  it('copies the company mailbox only when it differs from the owner', async () => {
    mockRecipients({
      companyEmail: 'info@fusaro.it',
      owner: { id: 3, email: 'owner@fusaro.it', name: 'Francesca' },
      adminIds: [3],
    });
    mockEmail.mockResolvedValue({ ok: true, status: 'sent' });

    const delivery = await sendPaymentFailedNotices(baseNotice);
    expect(delivery.ownerEmail).toBe('owner@fusaro.it, info@fusaro.it');

    mockQuery.mockReset();
    mockEmail.mockClear();
    mockRecipients({
      companyEmail: 'Owner@Fusaro.it',
      owner: { id: 3, email: 'owner@fusaro.it', name: 'Francesca' },
      adminIds: [3],
    });

    const second = await sendPaymentFailedNotices(baseNotice);
    // Same address in a different case is still the same person.
    expect(second.ownerEmail).toBe('owner@fusaro.it');
  });

  it('tracks the operator copy separately from the customer warning', async () => {
    process.env.BILLING_ALERT_EMAIL = 'francesco@veylo.it, ops@veylo.it';
    mockRecipients({
      owner: { id: 3, email: 'owner@fusaro.it', name: 'Francesca' },
      adminIds: [3],
    });
    mockEmail
      .mockResolvedValueOnce({ ok: true, status: 'sent' })
      .mockResolvedValueOnce({ ok: false, status: 'failed', message: 'relay denied' });

    const delivery = await sendPaymentFailedNotices(baseNotice);

    // A customer who was warned successfully must not be reported as unwarned
    // because an internal copy bounced.
    expect(delivery.ownerStatus).toBe('sent');
    expect(delivery.copyTo).toBe('francesco@veylo.it, ops@veylo.it');
    expect(delivery.copyStatus).toBe('failed');
  });

  it('still alerts in-app when there is nobody to email', async () => {
    mockRecipients({ owner: null, admin: null, adminIds: [4] });

    const delivery = await sendPaymentFailedNotices(baseNotice);

    expect(delivery.ownerStatus).toBe('no_recipient');
    expect(delivery.inAppCount).toBe(1);
    expect(mockEmail).not.toHaveBeenCalled();
  });

  it('never throws when the mailer does', async () => {
    mockRecipients({
      owner: { id: 3, email: 'owner@fusaro.it', name: 'Francesca' },
      adminIds: [3],
    });
    mockEmail.mockRejectedValue(new Error('ECONNREFUSED'));

    const delivery = await sendPaymentFailedNotices(baseNotice);

    // Throwing here would fail the webhook, and the provider would redeliver
    // the whole event - writing the subscription state twice.
    expect(delivery.ownerStatus).toBe('failed');
    expect(delivery.ownerError).toMatch(/ECONNREFUSED/);
  });

  it('marks a rehearsal so nobody mistakes it for real dunning', async () => {
    mockRecipients({
      owner: { id: 3, email: 'owner@fusaro.it', name: 'Francesca' },
      adminIds: [3],
    });
    mockEmail.mockResolvedValue({ ok: true, status: 'sent' });

    await sendPaymentFailedNotices({ ...baseNotice, isTest: true });

    const [, options] = mockEmail.mock.calls[0];
    expect(options.subject).toContain('[TEST]');
    expect(options.text).toContain('prova');
    expect(mockNotify.mock.calls[0][0].metadata.isTest).toBe(true);
  });
});
