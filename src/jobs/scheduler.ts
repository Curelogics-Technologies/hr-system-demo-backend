import cron from 'node-cron';
import { query } from '../config/database';
import { runWelcomeEmailJob } from './welcome-email.job';
import { runOnboardingReminderJob } from './onboarding-reminder.job';
import { runDocumentExpiryJob } from './document-expiry.job';
import { runSignatureReminderJob } from './signature-reminder.job';
import { runAtsBottleneckJob } from './ats-bottleneck.job';
import { runManagerAlertJob } from './manager-alert.job';
import { runReportConfigurationsJob } from './reports.job';
import { runAttendanceAnomalyCheckJob, runNoShowAlertEmailJob } from './attendance-anomaly-check.job';
import { runShiftApprovalReminderJob } from './shift-approval-reminder.job';
import { runCandidateRetentionForAllCompanies } from './candidate-retention.job';

type JobKey =
  | 'welcome_email'
  | 'onboarding_reminder'
  | 'document_expiry'
  | 'signature_reminder'
  | 'ats_bottleneck'
  | 'manager_alert'
  | 'shift_approval_reminder'
  | 'attendance_anomaly_check';

async function isJobEnabled(companyId: number, jobKey: JobKey): Promise<boolean> {
  const rows = await query<{ enabled: boolean }>(
    `SELECT enabled FROM automation_settings WHERE company_id = $1 AND job_key = $2`,
    [companyId, jobKey],
  );
  // Default to enabled if the company has no explicit setting
  return rows.length === 0 ? true : rows[0].enabled;
}

async function getActiveCompanyIds(): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `SELECT id FROM companies WHERE is_active = TRUE ORDER BY id`,
    [],
  );
  return rows.map((r) => r.id);
}

async function runForAllCompanies(
  jobKey: JobKey,
  jobFn: (companyId: number) => Promise<void>,
): Promise<void> {
  const companyIds = await getActiveCompanyIds();
  for (const companyId of companyIds) {
    try {
      const enabled = await isJobEnabled(companyId, jobKey);
      if (!enabled) continue;
      await jobFn(companyId);
    } catch (err) {
      console.error(`[scheduler] Job "${jobKey}" failed for company ${companyId}:`, err);
    }
  }
}

export function startScheduler(): void {
  console.log('[scheduler] Starting cron jobs...');

  // Welcome email — every hour (picks up new hires from the last hour)
  cron.schedule('0 * * * *', () => {
    console.log('[scheduler] welcome-email');
    runForAllCompanies('welcome_email', runWelcomeEmailJob).catch(console.error);
  });

  // Onboarding reminder — daily at 09:00 UTC
  cron.schedule('0 9 * * *', () => {
    console.log('[scheduler] onboarding-reminder');
    runForAllCompanies('onboarding_reminder', runOnboardingReminderJob).catch(console.error);
  });

  // Document expiry — daily at 08:00 UTC
  cron.schedule('0 8 * * *', () => {
    console.log('[scheduler] document-expiry');
    runForAllCompanies('document_expiry', runDocumentExpiryJob).catch(console.error);
  });

  // Signature reminder — daily at 09:30 UTC
  cron.schedule('30 9 * * *', () => {
    console.log('[scheduler] signature-reminder');
    runForAllCompanies('signature_reminder', runSignatureReminderJob).catch(console.error);
  });

  // ATS bottleneck check — every 6 hours
  cron.schedule('0 */6 * * *', () => {
    console.log('[scheduler] ats-bottleneck');
    runForAllCompanies('ats_bottleneck', runAtsBottleneckJob).catch(console.error);
  });

  // Manager daily alert — daily at 07:00 UTC
  cron.schedule('0 7 * * *', () => {
    console.log('[scheduler] manager-alert');
    runForAllCompanies('manager_alert', runManagerAlertJob).catch(console.error);
  });

  // Shift approval reminder — daily at 09:00 Europe/Rome
  cron.schedule('0 9 * * *', () => {
    console.log('[scheduler] shift-approval-reminder');
    runForAllCompanies('shift_approval_reminder', runShiftApprovalReminderJob).catch(console.error);
  }, {
    timezone: 'Europe/Rome',
  });

  // No-show alert email checker — every minute
  cron.schedule('* * * * *', () => {
    console.log('[scheduler] no-show-alert-email');
    runForAllCompanies('attendance_anomaly_check', runNoShowAlertEmailJob).catch(console.error);
  });

  // Attendance anomaly checker — every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    console.log('[scheduler] attendance-anomaly-check');
    runForAllCompanies('attendance_anomaly_check', runAttendanceAnomalyCheckJob).catch(console.error);
  });

  // Weekly report schedules — every minute
  cron.schedule('* * * * *', () => {
    runReportConfigurationsJob().catch(console.error);
  });

  // GDPR candidate retention sweep — daily at 03:30 Europe/Rome.
  // Runs off-peak because it writes to candidates and deletes CV files.
  // Opt-in per company, so it does its own company filtering rather than
  // going through runForAllCompanies (which defaults missing settings to on).
  cron.schedule('30 3 * * *', () => {
    console.log('[scheduler] candidate-retention');
    runCandidateRetentionForAllCompanies().catch(console.error);
  }, {
    timezone: 'Europe/Rome',
  });

  console.log('[scheduler] All cron jobs registered');
}
