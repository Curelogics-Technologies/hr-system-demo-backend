import { query, queryOne } from '../../config/database';
import { AutomationRecipientRole } from './automationDefaults';

interface RecipientRow {
  personal_email: string | null;
  email: string | null;
}

interface AreaManagerRecipientRow extends RecipientRow {
  id: number;
}

export async function resolveAutomationRecipientEmails(options: {
  companyId: number;
  roles: AutomationRecipientRole[];
  targetEmployeeId?: number | null;
  storeId?: number | null;
  scopeManagementRolesToStore?: boolean;
}): Promise<string[]> {
  const { companyId, roles, targetEmployeeId = null, scopeManagementRolesToStore = true } = options;
  let { storeId = null } = options;

  const emails = new Set<string>();

  const addEmail = (value: string | null | undefined) => {
    const normalized = value?.trim();
    if (normalized && normalized.includes('@')) {
      emails.add(normalized);
    }
  };

  if (scopeManagementRolesToStore && storeId == null && targetEmployeeId != null) {
    const employeeStore = await queryOne<{ store_id: number | null }>(
      `SELECT store_id
       FROM users
       WHERE id = $1 AND company_id = $2`,
      [targetEmployeeId, companyId],
    );
    storeId = employeeStore?.store_id ?? null;
  }

  const effectiveStoreId = scopeManagementRolesToStore ? storeId : null;

  if (roles.includes('employee') && targetEmployeeId != null) {
    const employee = await queryOne<RecipientRow>(
      `SELECT personal_email, email
       FROM users
       WHERE id = $1`,
      [targetEmployeeId],
    );
    addEmail(employee?.personal_email ?? employee?.email ?? null);
  }

  const companyWideRoles = roles.filter((role) => role === 'admin' || role === 'hr');
  if (companyWideRoles.length > 0) {
    const recipients = await query<RecipientRow>(
      `SELECT DISTINCT personal_email, email
       FROM users
       WHERE company_id = $1
         AND status = 'active'
         AND role = ANY($2)`,
      [companyId, companyWideRoles],
    );
    recipients.forEach((recipient) => {
      addEmail(recipient.personal_email ?? recipient.email);
    });
  }

  if (roles.includes('store_manager')) {
    const recipients = await query<RecipientRow>(
      `SELECT DISTINCT personal_email, email
       FROM users
       WHERE company_id = $1
         AND status = 'active'
         AND role = 'store_manager'
         AND ($2::int IS NULL OR store_id = $2)`,
      [companyId, effectiveStoreId],
    );
    recipients.forEach((recipient) => {
      addEmail(recipient.personal_email ?? recipient.email);
    });
  }

  if (roles.includes('area_manager')) {
    if (effectiveStoreId == null) {
      const recipients = await query<RecipientRow>(
        `SELECT DISTINCT personal_email, email
         FROM users
         WHERE company_id = $1
           AND status = 'active'
           AND role = 'area_manager'`,
        [companyId],
      );
      recipients.forEach((recipient) => {
        addEmail(recipient.personal_email ?? recipient.email);
      });
    } else {
      const directManagers = await query<AreaManagerRecipientRow>(
        `SELECT DISTINCT id, personal_email, email
         FROM users
         WHERE company_id = $1
           AND status = 'active'
           AND role = 'area_manager'
           AND store_id = $2`,
        [companyId, effectiveStoreId],
      );
      directManagers.forEach((recipient) => {
        addEmail(recipient.personal_email ?? recipient.email);
      });

      const supervisingManagers = await query<RecipientRow>(
        `SELECT DISTINCT am.personal_email, am.email
         FROM users am
         WHERE am.company_id = $1
           AND am.status = 'active'
           AND am.role = 'area_manager'
           AND EXISTS (
               SELECT 1
               FROM users sm
               WHERE sm.company_id = am.company_id
                 AND sm.status = 'active'
                 AND sm.role = 'store_manager'
                 AND sm.store_id = $2
                 AND sm.supervisor_id = am.id
           )`,
        [companyId, effectiveStoreId],
      );
      supervisingManagers.forEach((recipient) => {
        addEmail(recipient.personal_email ?? recipient.email);
      });
    }
  }

  return Array.from(emails);
}
