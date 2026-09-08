import nodemailer from 'nodemailer';
import { pool } from '../../config/database';
import { sendEmailForCompany } from '../email.service';
import {
  getPlatformSmtpConfig,
  isPlatformSmtpConfigured,
  sendPlatformEmail,
} from '../platformEmail.service';

jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
  query: jest.fn(),
  queryOne: jest.fn(),
}));
jest.mock('../email.service', () => ({
  sendEmailForCompany: jest.fn(),
}));
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn() },
}));

const mockQuery = pool.query as unknown as jest.Mock;
const mockCompanySend = sendEmailForCompany as unknown as jest.Mock;
const mockCreateTransport = (nodemailer as any).createTransport as jest.Mock;

const CONFIGURED = {
  smtp_host: 'smtp.veylo.it',
  smtp_port: 587,
  smtp_user: 'billing@veylo.it',
  smtp_pass: 'secret',
  smtp_from: 'VeylOHR <billing@veylo.it>',
  billing_alert_email: 'francesco@veylo.it',
  verified_at: null,
  last_error: null,
  updated_at: null,
};

const EMPTY_ROW = {
  smtp_host: '',
  smtp_port: 587,
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '',
  billing_alert_email: '',
  verified_at: null,
  last_error: null,
  updated_at: null,
};

const message = { to: 'owner@customer.it', subject: 'Test', html: '<p>hi</p>', text: 'hi' };

beforeEach(() => {
  mockQuery.mockReset();
  mockCompanySend.mockReset();
  mockCreateTransport.mockReset();
});

describe('platform mailbox configuration', () => {
  it('needs host, user and password before it will send', () => {
    expect(
      isPlatformSmtpConfigured({
        smtpHost: 'smtp.veylo.it',
        smtpPort: 587,
        smtpUser: 'billing@veylo.it',
        smtpPass: '',
        smtpFrom: '',
        billingAlertEmail: '',
        verifiedAt: null,
        lastError: null,
        updatedAt: null,
      })
    ).toBe(false);
  });

  it('survives the table not existing yet', async () => {
    // A deployment where migration 142 has not run must still boot and must
    // still fall back to the company transport rather than crashing.
    mockQuery.mockRejectedValue(new Error('relation "platform_smtp_config" does not exist'));
    const cfg = await getPlatformSmtpConfig();
    expect(cfg.smtpHost).toBe('');
    expect(isPlatformSmtpConfigured(cfg)).toBe(false);
  });
});

describe('sendPlatformEmail', () => {
  it('sends as the platform when the mailbox is configured', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [CONFIGURED] });
    const sendMail = jest.fn().mockResolvedValue({});
    mockCreateTransport.mockReturnValue({ sendMail });

    const result = await sendPlatformEmail(message, 7);

    expect(result.ok).toBe(true);
    expect(result.transport).toBe('platform');
    // The customer sees the platform's own From, not their own domain.
    expect(sendMail.mock.calls[0][0].from).toBe('VeylOHR <billing@veylo.it>');
    expect(mockCompanySend).not.toHaveBeenCalled();
  });

  it('falls back to the company mailbox when the platform one is unset', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [EMPTY_ROW] });
    mockCompanySend.mockResolvedValue({ ok: true, status: 'sent' });

    const result = await sendPlatformEmail(message, 7);

    // Without this, deploying the platform mailbox would silently stop billing
    // mail for every deployment that has not filled the form in yet.
    expect(result.ok).toBe(true);
    expect(result.transport).toBe('company');
    expect(mockCompanySend).toHaveBeenCalledWith(7, message);
  });

  it('refuses the fallback when none is offered', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [EMPTY_ROW] });

    const result = await sendPlatformEmail(message, null);

    // The operator copy names a customer and their failed payment. Pushing it
    // through that customer's own mail server would put the platform's
    // business into their mail logs.
    expect(result.ok).toBe(false);
    expect(result.status).toBe('skipped');
    expect(result.transport).toBe('none');
    expect(mockCompanySend).not.toHaveBeenCalled();
  });

  it('does not hide a broken platform mailbox behind the customer', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [CONFIGURED] });
    mockCreateTransport.mockReturnValue({
      sendMail: jest.fn().mockRejectedValue(new Error('535 5.7.0 Invalid credentials')),
    });
    mockCompanySend.mockResolvedValue({ ok: true, status: 'sent' });

    const result = await sendPlatformEmail(message, 7);

    // Configured but refusing: falling back here would deliver the message
    // from an address the customer does not expect, and would leave the real
    // fault invisible.
    expect(result.ok).toBe(false);
    expect(result.transport).toBe('platform');
    expect(result.message).toMatch(/Invalid credentials/);
    expect(mockCompanySend).not.toHaveBeenCalled();
  });

  it('retries on the other common port before giving up', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [CONFIGURED] });
    const sendMail = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({});
    mockCreateTransport.mockReturnValue({ sendMail });

    const result = await sendPlatformEmail(message, 7);

    // 465 and 587 are the two ports providers disagree about, and picking the
    // wrong one is the most common misconfiguration here.
    expect(result.ok).toBe(true);
    expect(result.portTried).toBe(465);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});
