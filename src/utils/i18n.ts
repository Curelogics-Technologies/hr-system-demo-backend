/**
 * Server-side i18n utility for notification content generation.
 *
 * Usage:
 *   import { t } from '../../utils/i18n';
 *   const title = t('it', 'notifications.onboarding_welcome.title');
 *   const msg   = t('it', 'notifications.onboarding_welcome.message', { name: 'Mario' });
 *
 * Supported locales: 'en', 'it' (falls back to 'it' for unknown locales).
 * Variables are interpolated with {{varName}} syntax (mirrors i18next).
 */

export type SupportedLocale = 'en' | 'it';

// ---------------------------------------------------------------------------
// Message catalogue
// Each key maps to { en: '...', it: '...' }.
// Variables use {{varName}} (consistent with the frontend i18next format).
// ---------------------------------------------------------------------------

const MESSAGES: Record<string, Record<SupportedLocale, string>> = {
  // ── onboarding.welcome ─────────────────────────────────────────────────────
  'notifications.onboarding_welcome.title': {
    en: 'Welcome to the team!',
    it: 'Benvenuto nel team!',
  },
  'notifications.onboarding_welcome.message': {
    en: 'Hi {{name}}, welcome to the company! Complete your onboarding tasks to get started.',
    it: 'Ciao {{name}}, benvenuto in azienda! Completa le tue attività di onboarding per iniziare.',
  },

  // ── onboarding.welcome_assigned (admin manually assigns tasks) ─────────────
  'notifications.onboarding_welcome_assigned.title': {
    en: 'Welcome to the team!',
    it: 'Benvenuto nel team!',
  },
  'notifications.onboarding_welcome_assigned.message': {
    en: 'You have {{count}} onboarding tasks to complete.',
    it: 'Hai {{count}} attività di onboarding da completare.',
  },

  // ── onboarding.task_reminder ───────────────────────────────────────────────
  'notifications.onboarding_task_reminder.title': {
    en: 'Onboarding tasks pending',
    it: 'Attività di onboarding in sospeso',
  },
  'notifications.onboarding_task_reminder.message': {
    en: 'You have {{count}} onboarding tasks to complete. Log in to the portal to proceed.',
    it: 'Hai {{count}} attività di onboarding da completare. Accedi al portale per procedere.',
  },

  // ── onboarding.task_reminder (admin manual) ────────────────────────────────
  'notifications.onboarding_reminder_manual.title': {
    en: 'Onboarding reminder',
    it: 'Promemoria onboarding',
  },
  'notifications.onboarding_reminder_manual.message': {
    en: 'You still have {{count}} onboarding tasks to complete. Don\'t forget!',
    it: 'Hai ancora {{count}} attività di onboarding da completare. Non dimenticarle!',
  },

  // ── document.expiring (employee) ────────────────────────────────────────────
  'notifications.document_expiring_employee.title': {
    en: 'Document expiring soon',
    it: 'Documento in scadenza',
  },
  'notifications.document_expiring_employee.message': {
    en: 'The document "{{fileName}}" will expire on {{date}}.',
    it: 'Il documento "{{fileName}}" scadrà il {{date}}.',
  },

  // ── document.expiring (HR) ─────────────────────────────────────────────────
  'notifications.document_expiring_hr.title': {
    en: 'Employee document expiring soon',
    it: 'Documento dipendente in scadenza',
  },
  'notifications.document_expiring_hr.message': {
    en: 'An employee\'s document "{{fileName}}" will expire on {{date}}.',
    it: 'Il documento "{{fileName}}" di un dipendente scadrà il {{date}}.',
  },

  // ── document.signature_required ────────────────────────────────────────────
  'notifications.document_signature_required.title': {
    en: 'Document signature required',
    it: 'Firma documento richiesta',
  },
  'notifications.document_signature_required.message': {
    en: 'You need to sign your document. Please sign your document first.',
    it: 'Devi firmare il tuo documento. Per favore, firma prima il tuo documento.',
  },

  // ── manager.alert (pending leave) ──────────────────────────────────────────
  'notifications.manager_alert_leave.title': {
    en: 'Leave requests pending',
    it: 'Richieste di permesso in attesa',
  },
  'notifications.manager_alert_leave.message': {
    en: 'You have {{count}} leave requests pending for more than 2 days.',
    it: 'Hai {{count}} richieste di permesso in attesa da più di 2 giorni.',
  },

  // ── leave events ──────────────────────────────────────────────────────────
  'notifications.leave_submitted.title': {
    en: 'New leave request',
    it: 'Nuova richiesta di permesso',
  },
  'notifications.leave_submitted.message': {
    en: '{{name}} submitted a leave request ({{start}} - {{end}}).',
    it: '{{name}} ha inviato una richiesta di permesso ({{start}} - {{end}}).',
  },
  'notifications.leave_approved.title': {
    en: 'Leave request approved',
    it: 'Richiesta di permesso approvata',
  },
  'notifications.leave_approved.message': {
    en: 'Your leave request for {{start}} - {{end}} has been approved.',
    it: 'La tua richiesta di permesso per il periodo {{start}} - {{end}} e stata approvata.',
  },
  'notifications.leave_rejected.title': {
    en: 'Leave request rejected',
    it: 'Richiesta di permesso rifiutata',
  },
  'notifications.leave_rejected.message': {
    en: 'Your leave request for {{start}} - {{end}} has been rejected.',
    it: 'La tua richiesta di permesso per il periodo {{start}} - {{end}} e stata rifiutata.',
  },

  // ── shift events ──────────────────────────────────────────────────────────
  'notifications.shift_assigned.title': {
    en: 'Shift assigned',
    it: 'Turno assegnato',
  },
  'notifications.shift_assigned.message': {
    en: 'New shift on {{date}} ({{start}}-{{end}}) at {{store}}.',
    it: 'Nuovo turno il {{date}} ({{start}}-{{end}}) in {{store}}.',
  },
  'notifications.shift_changed.title': {
    en: 'Shift updated',
    it: 'Turno modificato',
  },
  'notifications.shift_changed.message': {
    en: 'Your shift on {{date}} is now {{start}}-{{end}} at {{store}}.',
    it: 'Il tuo turno del {{date}} ora e {{start}}-{{end}} in {{store}}.',
  },

  // ── attendance anomalies ─────────────────────────────────────────────────
  'notifications.attendance_anomaly.title': {
    en: 'Attendance anomaly detected',
    it: 'Anomalia presenze rilevata',
  },
  'notifications.attendance_anomaly.message': {
    en: '{{kind}} on {{date}} at {{store}}.',
    it: '{{kind}} il {{date}} in {{store}}.',
  },
  'notifications.attendance_anomaly_kind_late_arrival': {
    en: 'Late arrival',
    it: 'Ritardo in ingresso',
  },
  'notifications.attendance_anomaly_kind_no_show': {
    en: 'No show',
    it: 'Assenza al turno',
  },
  'notifications.attendance_anomaly_kind_on_leave': {
    en: 'On approved leave',
    it: 'In permesso approvato',
  },
  'notifications.attendance_anomaly_kind_long_break': {
    en: 'Long break',
    it: 'Pausa troppo lunga',
  },
  'notifications.attendance_anomaly_kind_early_exit': {
    en: 'Early exit',
    it: 'Uscita anticipata',
  },
  'notifications.attendance_anomaly_kind_overtime': {
    en: 'Overtime',
    it: 'Straordinario',
  },

  // ── ats.bottleneck ────────────────────────────────────────────────────────
  'notifications.ats_bottleneck.title': {
    en: 'At-risk position: {{jobTitle}}',
    it: 'Posizione a rischio: {{jobTitle}}',
  },
  'notifications.ats_bottleneck.message': {
    en: '"{{jobTitle}}" is at risk ({{flags}}). Level: {{level}}.',
    it: '"{{jobTitle}}" è a rischio ({{flags}}). Livello: {{level}}.',
  },

  // ── ats.bottleneck flag labels ─────────────────────────────────────────────
  'notifications.ats_flag_lowCandidates': {
    en: 'few candidates',
    it: 'pochi candidati',
  },
  'notifications.ats_flag_noInterviews': {
    en: 'no interviews',
    it: 'nessun colloquio',
  },
  'notifications.ats_flag_noHires': {
    en: 'no hires',
    it: 'nessuna assunzione',
  },
  'notifications.ats_risk_high': {
    en: 'high',
    it: 'alto',
  },
  'notifications.ats_risk_medium': {
    en: 'medium',
    it: 'medio',
  },

  // ── ats.candidate_received ────────────────────────────────────────────────
  'notifications.ats_candidate_received.title': {
    en: 'New candidate received',
    it: 'Nuovo candidato ricevuto',
  },
  'notifications.ats_candidate_received.message': {
    en: '{{name}} has submitted their application.',
    it: '{{name}} ha inviato la propria candidatura.',
  },

  // ── ats.feedback_added ──────────────────────────────────────────────────
  'notifications.ats_feedback_added.title': {
    en: 'Interview feedback submitted',
    it: 'Feedback colloquio inviato',
  },
  'notifications.ats_feedback_added.message': {
    en: '{{managerName}} submitted feedback for candidate {{candidateName}}.',
    it: '{{managerName}} ha inserito un feedback per il candidato {{candidateName}}.',
  },

  // ── ats.interview_invite ──────────────────────────────────────────────────
  'notifications.ats_interview_invite.title': {
    en: 'Interview scheduled',
    it: 'Colloquio programmato',
  },
  'notifications.ats_interview_invite.message': {
    en: 'Interview with {{candidate}} on {{date}} at {{time}}{{location}}.',
    it: 'Colloquio con {{candidate}} il {{date}} alle {{time}}{{location}}.',
  },

  // ── ats.outcome ─────────────────────────────────────────────────────────
  'notifications.ats_outcome.title': {
    en: 'Candidate status updated',
    it: 'Stato candidato aggiornato',
  },
  'notifications.ats_outcome.message': {
    en: '{{name}} moved from **{{from}}** to **{{to}}**.',
    it: '{{name}} e passato da **{{from}}** a **{{to}}**.',
  },
  'notifications.ats_status_received': {
    en: 'Received',
    it: 'Ricevuto',
  },
  'notifications.ats_status_review': {
    en: 'In Review',
    it: 'In Revisione',
  },
  'notifications.ats_status_phone_interview': {
    en: 'Phone Interview',
    it: 'Colloquio Telefonico',
  },
  'notifications.ats_status_interview': {
    en: 'Interview',
    it: 'Colloquio',
  },
  'notifications.ats_status_hired': {
    en: 'Hired',
    it: 'Assunto',
  },
  'notifications.ats_status_rejected': {
    en: 'Rejected',
    it: 'Rifiutato',
  },
};

// ---------------------------------------------------------------------------
// t() — translate a message key with optional variable substitution
// ---------------------------------------------------------------------------

/**
 * Translates a notification message key into the requested locale.
 *
 * @param locale   - ISO locale string, e.g. 'it', 'en', 'en-US'. Only the
 *                   first two characters are used; unknown locales fall back
 *                   to 'it' (the default app locale).
 * @param key      - Message key, e.g. 'notifications.onboarding_welcome.title'
 * @param vars     - Optional variable map applied via {{varName}} substitution.
 * @returns        Translated, interpolated string. Falls back to the English
 *                 version if translation not found, then to the key itself.
 */
export function t(
  locale: string | undefined | null,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const lang = resolveLocale(locale);
  const entry = MESSAGES[key];

  let text: string;
  if (!entry) {
    // Unknown key — return the key itself so bugs are visible
    text = key;
  } else {
    text = entry[lang] ?? entry['it'] ?? entry['en'] ?? key;
  }

  if (vars) {
    text = interpolate(text, vars);
  }

  return text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveLocale(locale: string | undefined | null): SupportedLocale {
  if (!locale) return 'it';
  const base = locale.slice(0, 2).toLowerCase();
  return (base === 'en' || base === 'it') ? base : 'it';
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = vars[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}
