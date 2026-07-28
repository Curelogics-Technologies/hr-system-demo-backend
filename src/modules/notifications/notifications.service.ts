import { query, queryOne } from '../../config/database';
import { sendNotificationEmail } from '../../services/email.service';
import { emitToCompany } from '../../config/socket';
import {
  isRoleEligibleForModule,
  isDefaultEnabledForModule,
  ModuleName,
} from '../permissions/permission-catalog';
import { UserRole } from '../../config/jwt';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationPriority = 'urgent' | 'high' | 'medium' | 'low';

export type NotificationEventType =
  | 'shift.assigned'
  | 'shift.changed'
  | 'attendance.anomaly'
  | 'leave.submitted'
  | 'leave.approved'
  | 'leave.rejected'
  | 'document.uploaded'
  | 'document.assigned'
  | 'document.signature_required'
  | 'document.signed'
  | 'document.expiring'
  | 'ats.candidate_received'
  | 'ats.interview_invite'
  | 'ats.feedback_added'
  | 'ats.outcome'
  | 'onboarding.welcome'
  | 'onboarding.task_reminder'
  | 'manager.alert';

export type NotificationCategory =
  | 'employees'
  | 'shifts'
  | 'attendance'
  | 'leave'
  | 'documents'
  | 'ats'
  | 'onboarding'
  | 'manager';

/**
 * Derives the notification category from the event type.
 * Maps event types to their corresponding module/category.
 */
function deriveCategory(eventType: NotificationEventType): NotificationCategory {
  if (eventType.startsWith('employee.')) return 'employees';
  if (eventType.startsWith('shift.')) return 'shifts';
  if (eventType.startsWith('attendance.')) return 'attendance';
  if (eventType.startsWith('leave.')) return 'leave';
  if (eventType.startsWith('document.')) return 'documents';
  if (eventType.startsWith('ats.')) return 'ats';
  if (eventType.startsWith('onboarding.')) return 'onboarding';
  if (eventType.startsWith('manager.')) return 'manager';
  
  // Fallback for unknown types
  return 'manager';
}

// ---------------------------------------------------------------------------
// Module-permission gating
// ---------------------------------------------------------------------------
// Notifications must respect the company's per-role module configuration
// (the same rules the route middleware enforces). A role that cannot access a
// module must not receive notifications belonging to that module — neither new
// ones (dispatch path) nor previously-stored ones (read path).

/**
 * SQL LIKE patterns mapping notification types to the module that governs them.
 * Events with no entry here (e.g. `manager.alert`) are never module-gated.
 */
const NOTIFICATION_MODULE_PATTERNS: ReadonlyArray<readonly [string, ModuleName]> = [
  ['attendance.anomaly', 'anomalie'],
  ['employee.%', 'dipendenti'],
  ['shift.%', 'turni'],
  ['leave.%', 'permessi'],
  ['document.%', 'documenti'],
  ['ats.%', 'ats'],
  ['onboarding.%', 'onboarding'],
];

/** Maps a single event type to its governing module (or null if not gated). */
function moduleForEventType(type: string): ModuleName | null {
  if (type === 'attendance.anomaly') return 'anomalie';
  if (type.startsWith('employee.')) return 'dipendenti';
  if (type.startsWith('shift.')) return 'turni';
  if (type.startsWith('leave.')) return 'permessi';
  if (type.startsWith('document.')) return 'documenti';
  if (type.startsWith('ats.')) return 'ats';
  if (type.startsWith('onboarding.')) return 'onboarding';
  return null;
}

/**
 * Resolves whether a role may access a module in a company, mirroring the route
 * middleware: hard eligibility guard, then `role_module_permissions` with the
 * same default-on fallback when no explicit row exists.
 */
async function isModuleAllowedForRole(
  companyId: number,
  role: string,
  moduleName: ModuleName,
): Promise<boolean> {
  if (!isRoleEligibleForModule(role as UserRole, moduleName)) return false;
  const row = await queryOne<{ is_enabled: boolean }>(
    `SELECT is_enabled
     FROM role_module_permissions
     WHERE company_id = $1 AND role = $2 AND module_name = $3
     LIMIT 1`,
    [companyId, role, moduleName],
  );
  if (!row) return isDefaultEnabledForModule(role as UserRole, moduleName);
  return row.is_enabled === true;
}

/**
 * Returns the SQL LIKE patterns for notification types the given role may NOT
 * receive in this company. Used by the read path so already-stored notifications
 * for now-disabled modules are filtered out of a user's own inbox.
 */
async function getBlockedTypePatterns(
  companyId: number,
  role: string,
): Promise<string[]> {
  const blocked: string[] = [];
  for (const [pattern, moduleName] of NOTIFICATION_MODULE_PATTERNS) {
    if (!(await isModuleAllowedForRole(companyId, role, moduleName))) {
      blocked.push(pattern);
    }
  }
  return blocked;
}

export interface SendNotificationOptions {
  companyId: number;
  userId: number;
  type: NotificationEventType;
  title: string;
  message: string;
  priority?: NotificationPriority;
  channels?: ('in_app' | 'email')[];
  emailSubject?: string;
  emailBody?: string;
  /** When true, skips the notification_settings check entirely. Default: false */
  skipSettingsCheck?: boolean;
  /** Optional locale (e.g. 'it', 'en-US') for this notification's content */
  locale?: string;
  /** Optional additional data for deep linking */
  metadata?: Record<string, any>;
}

export interface Notification {
  id: number;
  companyId: number;
  userId: number;
  type: string;
  title: string;
  message: string;
  priority: NotificationPriority;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
  /** Locale in which title/message were generated, if available */
  locale?: string;
  /** Category/module this notification belongs to */
  category?: string;
  /** Recipient details (used in company-scope feeds) */
  recipientName?: string | null;
  recipientSurname?: string | null;
  recipientRole?: string | null;
  recipientAvatarFilename?: string | null;
  /** Additional data for deep linking */
  metadata?: any;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface NotificationRow {
  id: number;
  company_id: number;
  user_id: number;
  type: string;
  title: string;
  message: string;
  priority: NotificationPriority;
  is_enabled?: boolean;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
  locale?: string | null;
  category?: string | null;
  recipient_name?: string | null;
  recipient_surname?: string | null;
  recipient_role?: string | null;
  recipient_avatar_filename?: string | null;
  metadata?: string | null;
}

interface NotificationSettingRow {
  enabled: boolean;
  roles: string[];
}


function toNotification(row: NotificationRow): Notification {
  let parsedMetadata: any = undefined;
  
  if (row.metadata) {
    try {
      // Handle case where metadata might be a string "[object Object]" or invalid JSON
      if (typeof row.metadata === 'string') {
        // Check if it's the invalid "[object Object]" string
        if (row.metadata === '[object Object]' || row.metadata.startsWith('[object')) {
          console.warn(`[notifications] Invalid metadata for notification ${row.id}: "${row.metadata}"`);
          parsedMetadata = undefined;
        } else {
          parsedMetadata = JSON.parse(row.metadata);
        }
      } else {
        // If it's already an object, use it directly
        parsedMetadata = row.metadata;
      }
    } catch (err) {
      console.error(`[notifications] Failed to parse metadata for notification ${row.id}:`, err);
      parsedMetadata = undefined;
    }
  }
  
  return {
    id: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    message: row.message,
    priority: row.priority,
    isRead: row.is_read,
    readAt: row.read_at,
    createdAt: row.created_at,
    locale: row.locale ?? undefined,
    category: row.category ?? undefined,
    recipientName: row.recipient_name ?? undefined,
    recipientSurname: row.recipient_surname ?? undefined,
    recipientRole: row.recipient_role ?? undefined,
    recipientAvatarFilename: row.recipient_avatar_filename ?? undefined,
    metadata: parsedMetadata,
  };
}

// ---------------------------------------------------------------------------
// Core dispatcher
// ---------------------------------------------------------------------------

/**
 * Sends a notification to a user. This is the single entry point for all
 * notification dispatching across every module.
 *
 * IMPORTANT: This function must NEVER throw. All failures are caught and
 * logged (or written to notification_failures) silently.
 */
export async function sendNotification(
  options: SendNotificationOptions,
): Promise<void> {
  const {
    companyId,
    userId,
    type,
    title,
    message,
    priority = 'medium',
    channels = ['in_app'],
    emailSubject,
    emailBody,
    skipSettingsCheck = false,
  locale,
  } = options;

  try {
    // Fetch the recipient once — reused for the settings/module checks,
    // locale resolution, and the email channel below.
    const recipient = await queryOne<{
      id: number;
      email: string;
      role: string;
      locale: string | null;
    }>(
      `SELECT id, email, role, locale FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );

    // ------------------------------------------------------------------
    // 1. Settings + module checks — skip if explicitly requested
    // ------------------------------------------------------------------
    if (!skipSettingsCheck) {
      const setting = await queryOne<NotificationSettingRow>(
        `SELECT enabled, roles
         FROM notification_settings
         WHERE company_id = $1 AND event_key = $2
         LIMIT 1`,
        [companyId, type],
      );

      if (setting && !setting.enabled) {
        // Notification disabled for this event in this company — do nothing
        return;
      }

      if (setting && setting.enabled && recipient && !setting.roles.includes(recipient.role)) {
        // User's role is not permitted to receive this notification type
        return;
      }

      // Module-permission guard: respect the company's per-role module
      // configuration. If the recipient's role cannot access the module this
      // event belongs to, do not dispatch (e.g. employees are not eligible for
      // the `anomalie` module, so they never receive anomaly notifications).
      const moduleName = moduleForEventType(type);
      if (
        moduleName &&
        recipient &&
        !(await isModuleAllowedForRole(companyId, recipient.role, moduleName))
      ) {
        return;
      }
    }

    // Resolve effective locale for this notification (explicit > user.locale > fallback)
    const effectiveLocale = locale || recipient?.locale || 'it';

    // Derive category from event type
    const category = deriveCategory(type);

    // ------------------------------------------------------------------
    // 2. In-app notification — always inserted (unless filtered above)
    // ------------------------------------------------------------------
    await query(
        `INSERT INTO notifications
           (company_id, user_id, type, title, message, priority, is_enabled, locale, category, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8, $9)`,
        [companyId, userId, type, title, message, priority, effectiveLocale, category, options.metadata ? JSON.stringify(options.metadata) : null],
      );

    // Emit real-time notification event via Socket.io
    emitToCompany(companyId, 'NOTIFICATION_CREATED', { userId, type });

    // ------------------------------------------------------------------
    // 3. Email channel — failures are caught and logged silently
    // ------------------------------------------------------------------
    if (channels.includes('email')) {
      try {
        if (recipient?.email) {
          await sendNotificationEmail({
            companyId,
            toEmail: recipient.email,
            eventKey: type,
            variables: {},
            fallbackSubject: emailSubject ?? title,
            fallbackBody:   emailBody   ?? `<p>${message}</p>`,
          });
        }
      } catch (emailErr: unknown) {
        // Log failure to notification_failures — do not rethrow
        const errMsg =
          emailErr instanceof Error ? emailErr.message : String(emailErr);
        console.error(
          `[notifications] Email send failed for user ${userId}, event "${type}":`,
          errMsg,
        );
        try {
          await query(
            `INSERT INTO notification_failures
               (company_id, user_id, event_key, error)
             VALUES ($1, $2, $3, $4)`,
            [companyId, userId, type, errMsg],
          );
        } catch (dbErr: unknown) {
          // Last resort: just log — never throw
          console.error('[notifications] Could not write to notification_failures:', dbErr);
        }
      }
    }
  } catch (err: unknown) {
    // Top-level guard — sendNotification must NEVER throw
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[notifications] Unhandled error in sendNotification for user ${userId}, event "${type}":`,
      errMsg,
    );
    try {
      await query(
        `INSERT INTO notification_failures
           (company_id, user_id, event_key, error)
         VALUES ($1, $2, $3, $4)`,
        [companyId, userId, type, errMsg],
      );
    } catch {
      // Absolutely last resort — swallow silently
    }
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Returns a paginated list of notifications for a user, optionally filtered
 * to unread only, along with the total count and overall unread count.
 */
export async function getNotifications(options: {
  userId: number;
  companyId: number;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
  scope?: 'mine' | 'company';
  isSuperAdmin?: boolean;
  /** Recipient role — used to filter the user's own inbox by module permissions. */
  recipientRole?: string;
}): Promise<{ notifications: Notification[]; total: number; unreadCount: number }> {
  const {
    userId,
    companyId,
    unreadOnly = false,
    limit = 50,
    offset = 0,
    scope = 'mine',
    isSuperAdmin = false,
    recipientRole,
  } = options;

  const safeLimit  = Math.min(limit, 100);
  const safeOffset = Math.max(offset, 0);

  if (scope === 'company') {
    const unreadFilter = unreadOnly ? 'AND n.is_read = FALSE' : '';
    const companyFilter = isSuperAdmin ? '' : 'AND n.company_id = $1';
    const params = isSuperAdmin ? [] : [companyId];

    const countRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM notifications n
       WHERE n.is_enabled = TRUE
         ${companyFilter}
         ${unreadFilter}`,
      params,
    );
    const total = parseInt(countRow?.count ?? '0', 10);

    const unreadRow = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM notifications n
       WHERE n.is_enabled = TRUE
         ${companyFilter}
         AND n.is_read = FALSE`,
      params,
    );
    const unreadCount = parseInt(unreadRow?.count ?? '0', 10);

    const rows = await query<NotificationRow>(
      `SELECT n.id, n.company_id, n.user_id, n.type, n.title, n.message,
              n.priority, n.is_enabled, n.is_read, n.read_at, n.created_at, n.locale, n.category, n.metadata,
              u.name AS recipient_name,
              u.surname AS recipient_surname,
              u.role::text AS recipient_role,
              u.avatar_filename AS recipient_avatar_filename
       FROM notifications n
       LEFT JOIN users u ON u.id = n.user_id
       WHERE n.is_enabled = TRUE
         ${companyFilter}
         ${unreadFilter}
       ORDER BY n.created_at DESC
       LIMIT $${isSuperAdmin ? 1 : 2} OFFSET $${isSuperAdmin ? 2 : 3}`,
        isSuperAdmin ? [safeLimit, safeOffset] : [companyId, safeLimit, safeOffset],
      );

    return {
      notifications: rows.map(toNotification),
      total,
      unreadCount,
    };
  }

  const unreadFilter = unreadOnly ? 'AND n.is_read = FALSE' : '';

  // Filter the user's own inbox by module permissions: notifications whose
  // module is disabled for the recipient's role are hidden (and excluded from
  // counts), so previously-stored notifications are handled consistently.
  let blockedPatterns: string[] = [];
  if (recipientRole && !isSuperAdmin) {
    blockedPatterns = await getBlockedTypePatterns(companyId, recipientRole);
  }

  const countParams: unknown[] = [userId, companyId];
  let countBlockedFilter = '';
  if (blockedPatterns.length > 0) {
    countParams.push(blockedPatterns);
    countBlockedFilter = `AND NOT (n.type LIKE ANY($${countParams.length}))`;
  }

  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM notifications n
     WHERE n.user_id = $1
       AND n.company_id = $2
       AND n.is_enabled = TRUE
       ${unreadFilter}
       ${countBlockedFilter}`,
    countParams,
  );
  const total = parseInt(countRow?.count ?? '0', 10);

  const unreadParams: unknown[] = [userId, companyId];
  let unreadBlockedFilter = '';
  if (blockedPatterns.length > 0) {
    unreadParams.push(blockedPatterns);
    unreadBlockedFilter = `AND NOT (n.type LIKE ANY($${unreadParams.length}))`;
  }

  const unreadRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM notifications n
     WHERE n.user_id = $1
       AND n.company_id = $2
       AND n.is_enabled = TRUE
       AND n.is_read = FALSE
       ${unreadBlockedFilter}`,
    unreadParams,
  );
  const unreadCount = parseInt(unreadRow?.count ?? '0', 10);

  const rowParams: unknown[] = [userId, companyId, safeLimit, safeOffset];
  let rowsBlockedFilter = '';
  if (blockedPatterns.length > 0) {
    rowParams.push(blockedPatterns);
    rowsBlockedFilter = `AND NOT (n.type LIKE ANY($${rowParams.length}))`;
  }

  const rows = await query<NotificationRow>(
    `SELECT n.id, n.company_id, n.user_id, n.type, n.title, n.message,
             n.priority, n.is_enabled, n.is_read, n.read_at, n.created_at, n.locale, n.category, n.metadata
      FROM notifications n
      WHERE n.user_id = $1
        AND n.company_id = $2
        AND n.is_enabled = TRUE
        ${unreadFilter}
        ${rowsBlockedFilter}
      ORDER BY n.created_at DESC
      LIMIT $3 OFFSET $4`,
    rowParams,
  );

  return {
    notifications: rows.map(toNotification),
    total,
    unreadCount,
  };
}

/**
 * Returns recent users (last 24 hours) who received notifications for a specific event type.
 * Used to display avatars in the settings modal.
 * 
 * @param companyId - Company ID (0 for super admin to see all companies)
 * @param eventKey - Notification event type
 * @param isSuperAdmin - Whether the requester is a super admin
 */
export async function getRecentNotificationRecipients(
  companyId: number,
  eventKey: string,
  isSuperAdmin: boolean = false,
): Promise<Array<{ userId: number; name: string; surname: string; avatarFilename: string | null }>> {
  const companyFilter = isSuperAdmin ? '' : 'AND n.company_id = $1';
  const params = isSuperAdmin ? [eventKey] : [companyId, eventKey];
  const eventKeyIndex = isSuperAdmin ? 1 : 2;

  const rows = await query<{
    user_id: number;
    name: string;
    surname: string;
    avatar_filename: string | null;
  }>(
    `SELECT DISTINCT ON (n.user_id) n.user_id, u.name, u.surname, u.avatar_filename
     FROM notifications n
     LEFT JOIN users u ON u.id = n.user_id
     WHERE n.type = $${eventKeyIndex}
       ${companyFilter}
       AND n.created_at > NOW() - INTERVAL '24 hours'
       AND n.is_enabled = TRUE
     ORDER BY n.user_id, n.created_at DESC
     LIMIT 10`,
    params,
  );

  return rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    surname: row.surname,
    avatarFilename: row.avatar_filename,
  }));
}

/**
 * Marks a single notification as read.
 * Returns true if the notification was found and updated, false otherwise.
 * Security: only the owning user can mark their own notifications.
 */
export async function markAsRead(
  id: number,
  userId: number,
): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `UPDATE notifications
     SET is_read = TRUE, read_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_enabled = TRUE AND is_read = FALSE
     RETURNING id`,
    [id, userId],
  );
  return rows.length > 0;
}

/**
 * Marks all unread notifications as read for a given user within a company.
 * Returns the number of notifications that were updated.
 */
export async function markAllAsRead(
  userId: number,
  companyId: number,
): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE notifications
     SET is_read = TRUE, read_at = NOW()
     WHERE user_id = $1 AND company_id = $2 AND is_enabled = TRUE AND is_read = FALSE
     RETURNING id`,
    [userId, companyId],
  );
  return rows.length;
}

/**
 * Returns the total number of unread notifications for a user.
 * Used by the frontend bell-badge polling endpoint.
 */
export async function getUnreadCount(
  userId: number,
  companyId?: number,
  role?: string,
): Promise<number> {
  const params: unknown[] = [userId];
  let blockedFilter = '';

  // Keep the badge count consistent with the filtered inbox: exclude
  // notifications whose module is disabled for the recipient's role.
  if (companyId && role) {
    const blockedPatterns = await getBlockedTypePatterns(companyId, role);
    if (blockedPatterns.length > 0) {
      params.push(blockedPatterns);
      blockedFilter = `AND NOT (type LIKE ANY($${params.length}))`;
    }
  }

  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM notifications
     WHERE user_id = $1 AND is_enabled = TRUE AND is_read = FALSE
       ${blockedFilter}`,
    params,
  );
  return parseInt(row?.count ?? '0', 10);
}
