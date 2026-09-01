import { Request, Response } from 'express';
import { query, queryOne } from '../../config/database';
import { ok } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { resolveAreaManagerStoreIds } from '../../utils/storeScope';
import { coalescedShiftPointUtcSql } from '../../utils/shiftTimezone';
import { resolveAllowedCompanyIds } from '../../utils/companyScope';
import { loadApprovedLeaveDays, leaveCoverageKey } from '../../utils/leaveCoverage';

function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function localDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
export const getHomeData = asyncHandler(async (req: Request, res: Response) => {
  const { companyId, role, userId, storeId } = req.user!;

  switch (role) {
    case 'admin': {
      const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
      const tr = req.query.timeRange || req.query.time_range || req.query.timerange || 'this_month';
      const timeRange = String(tr).trim().toLowerCase();

      // DEBUG: Log the received parameters to a file in the workspace
      const fs = require('fs');
      const logMsg = `[${new Date().toISOString()}] req.query: ${JSON.stringify(req.query)}, resolved timeRange: ${timeRange}\n`;
      fs.appendFileSync('home_debug.log', logMsg);

      const now = new Date();
      let startDate: Date;
      let endDate: Date = new Date(now);

      if (timeRange === 'this_week') {
        // Monday → Current Day
        startDate = new Date(now);
        const day = startDate.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        const diffToMonday = (day === 0 ? -6 : 1) - day;
        startDate.setDate(startDate.getDate() + diffToMonday);
        startDate.setHours(0, 0, 0, 0);
      } else if (timeRange === 'three_months') {
        // Start: 1st day of (current month - 2), End: Current date
        startDate = new Date(now);
        startDate.setMonth(startDate.getMonth() - 2);
        startDate.setDate(1);
        startDate.setHours(0, 0, 0, 0);
      } else {
        // default: this_month (1st of current month → Current date)
        startDate = new Date(now);
        startDate.setDate(1);
        startDate.setHours(0, 0, 0, 0);
      }

      const startStr = startDate.toISOString().split('T')[0];
      // We look until end of today to include all potential events
      const endStr = new Date(now.getTime() + 86400000).toISOString().split('T')[0];

      console.log(`[AdminHome] SQL Range: ${startStr} to ${endStr}`);

      const [
        companiesRes, storesRes, employeesRes, roleBreakdown, storeBreakdown,
        attendanceRes, coverageRes,
        documentExpiryRes, onboardingRes, atsRes
      ] = await Promise.all([
        queryOne<{ count: string }>(
          `SELECT COUNT(*) AS count FROM companies WHERE id = ANY($1)`,
          [allowedCompanyIds]
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) AS count FROM stores WHERE company_id = ANY($1) AND is_active = true`,
          [allowedCompanyIds]
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) AS count FROM users WHERE company_id = ANY($1) AND status = 'active' AND role != 'store_terminal'`,
          [allowedCompanyIds]
        ),
        query<{ role: string; count: number }>(
          `SELECT role, COUNT(*)::int AS count
           FROM users
           WHERE company_id = ANY($1) AND status = 'active'
           GROUP BY role ORDER BY count DESC`,
          [allowedCompanyIds]
        ),
        query<{ name: string; count: number }>(
          `SELECT s.name, COUNT(u.id)::int AS count
           FROM stores s
           LEFT JOIN users u ON u.store_id = s.id AND u.status = 'active'
           WHERE s.company_id = ANY($1) AND s.is_active = true
           GROUP BY s.id, s.name ORDER BY count DESC LIMIT 10`,
          [allowedCompanyIds]
        ),
        queryOne<{ expected: string; present: string }>(
          `SELECT 
            COUNT(DISTINCT (s.user_id, s.date))::text AS expected,
            COUNT(DISTINCT CASE WHEN ae.id IS NOT NULL THEN (s.user_id, s.date) END)::text AS present
          FROM shifts s
          LEFT JOIN attendance_events ae 
            ON ae.user_id = s.user_id 
            AND ae.event_time::DATE = s.date 
            AND ae.event_type = 'checkin'
          WHERE s.company_id = ANY($1) 
            AND s.status != 'cancelled'
            AND s.date >= $2
            AND s.date < $3
            AND (s.date < CURRENT_DATE OR (s.date = CURRENT_DATE AND s.start_time <= CURRENT_TIME))`,
          [allowedCompanyIds, startStr, endStr]
        ),
        queryOne<{ total: string; confirmed: string }>(
          `SELECT 
            COUNT(*)::text AS total,
            SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END)::text AS confirmed
          FROM shifts
          WHERE company_id = ANY($1)
            AND status IN ('confirmed', 'scheduled')
            AND date >= $2
            AND date < $3`,
          [allowedCompanyIds, startStr, endStr]
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(DISTINCT storage_path)::text AS count
          FROM (
            SELECT storage_path FROM employee_documents
            WHERE company_id = ANY($1) 
              AND deleted_at IS NULL 
              AND (is_deleted = FALSE OR is_deleted IS NULL)
              AND expires_at >= CURRENT_DATE 
              AND expires_at <= CURRENT_DATE + INTERVAL '60 days'
            UNION
            SELECT d.file_url AS storage_path FROM documents d
            LEFT JOIN users e ON e.id = d.employee_id
            LEFT JOIN users u ON u.id = d.uploaded_by
            WHERE (e.company_id = ANY($1) OR (e.id IS NULL AND u.company_id = ANY($1)))
              AND d.is_deleted = false
              AND d.expires_at >= CURRENT_DATE 
              AND d.expires_at <= CURRENT_DATE + INTERVAL '60 days'
          ) combined`,
          [allowedCompanyIds]
        ),
        queryOne<{ in_progress: string; avg_pct: string }>(
          `SELECT
            COUNT(*) FILTER (WHERE total_tasks > 0 AND completed_tasks < total_tasks)::text AS in_progress,
            COALESCE(AVG(CASE WHEN total_tasks > 0 THEN (completed_tasks * 100.0 / total_tasks) ELSE 0 END), 0)::text AS avg_pct
          FROM (
            SELECT
              u.id,
              COUNT(t.id) AS total_tasks,
              COUNT(t.id) FILTER (WHERE t.completed = TRUE) AS completed_tasks
            FROM users u
            LEFT JOIN employee_onboarding_tasks t ON t.employee_id = u.id
            LEFT JOIN onboarding_templates tmpl ON tmpl.id = t.template_id AND tmpl.company_id = u.company_id
            WHERE u.company_id = ANY($1)
              AND u.role = 'employee'
              AND u.status = 'active'
            GROUP BY u.id
          ) sub`,
          [allowedCompanyIds]
        ),
        queryOne<{ total: string; interview: string }>(
          `SELECT
            COUNT(*)::text AS total,
            SUM(CASE WHEN status = 'interview' THEN 1 ELSE 0 END)::text AS interview
          FROM candidates
          WHERE company_id = ANY($1)`,
          [allowedCompanyIds]
        )
      ]);

      // Calculate backward date boundaries specifically for anomalies: No Show and Late Arrival
      let anomalyStartDate = new Date(now);
      if (timeRange === 'this_week') {
        anomalyStartDate.setDate(now.getDate() - 6);
      } else if (timeRange === 'three_months') {
        anomalyStartDate.setDate(now.getDate() - 89);
      } else {
        // default: this_month (last 30 days)
        anomalyStartDate.setDate(now.getDate() - 29);
      }
      const anomalyStartStr = localDateStr(anomalyStartDate);
      const anomalyEndStr = localDateStr(now);

      console.log(`[AdminHome] Anomalies calculation backward range: ${anomalyStartStr} to ${anomalyEndStr}`);

      // Fetch active non-cancelled shifts in date range
      const anomalyShifts = await query<{
        id: number;
        company_id: number;
        user_id: number;
        store_id: number;
        date: string;
        start_time: string;
        end_time: string;
      }>(
        `SELECT s.id, s.company_id, s.user_id, s.store_id, TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
                s.start_time, s.end_time
         FROM shifts s
         WHERE s.company_id = ANY($1)
           AND s.date BETWEEN $2 AND $3
           AND s.status != 'cancelled'
           AND s.date <= CURRENT_DATE
         ORDER BY s.date, s.user_id`,
        [allowedCompanyIds, anomalyStartStr, anomalyEndStr]
      );

      // Fetch attendance check-ins/checkouts for the same period + scope
      const anomalyEvents = await query<{
        user_id: number;
        event_type: string;
        event_time: string;
      }>(
        `SELECT ae.user_id, ae.event_type, ae.event_time
         FROM attendance_events ae
         WHERE ae.company_id = ANY($1)
           AND ae.event_time::DATE BETWEEN $2 AND $3
         ORDER BY ae.user_id, ae.event_time`,
        [allowedCompanyIds, anomalyStartStr, anomalyEndStr]
      );

      // Group events by (user_id, date)
      type EventGroup = { checkin?: Date; checkout?: Date };
      const eventMap = new Map<string, EventGroup>();
      for (const e of anomalyEvents) {
        const date = localDateStr(new Date(e.event_time));
        const key = `${e.user_id}:${date}`;
        if (!eventMap.has(key)) eventMap.set(key, {});
        const group = eventMap.get(key)!;
        const t = new Date(e.event_time);
        if (e.event_type === 'checkin' && (!group.checkin || t < group.checkin)) {
          group.checkin = t;
        }
        if (e.event_type === 'checkout' && (!group.checkout || t > group.checkout)) {
          group.checkout = t;
        }
      }

      const LATE_MS = 10 * 60 * 1000; // 10 minutes
      let totalAbsences = 0;
      let justifiedAbsences = 0;
      let delays = 0;
      const nowTs = now.getTime();

      // Fourth copy of the no-show rule (anomaly engine, reports, store
      // dashboard, here). Approved leave must not count as an absence in any
      // of them, or the admin KPI keeps contradicting the anomaly list.
      const adminLeaveDays = await loadApprovedLeaveDays(
        allowedCompanyIds, anomalyStartStr, anomalyEndStr,
      );

      for (const shift of anomalyShifts) {
        const key = `${shift.user_id}:${shift.date}`;
        const evGroup = eventMap.get(key);
        const shiftStart = new Date(`${shift.date}T${shift.start_time}`);
        const shiftEnd   = new Date(`${shift.date}T${shift.end_time}`);

        // Only process shifts that have actually started (avoid future shifts)
        if (shiftStart.getTime() > nowTs) continue;

        if (!evGroup?.checkin) {
          if (shiftEnd.getTime() < nowTs || shiftStart.getTime() + LATE_MS < nowTs) {
            if (adminLeaveDays.has(leaveCoverageKey(shift.user_id, shift.date))) {
              justifiedAbsences++;
            } else {
              totalAbsences++;
            }
          }
          continue;
        }

        const { checkin } = evGroup;
        const lateMs = checkin.getTime() - shiftStart.getTime();
        if (lateMs > LATE_MS) {
          delays++;
        }
      }

      const expectedAtt = parseInt(attendanceRes?.expected || '0', 10);
      const presentAtt = parseInt(attendanceRes?.present || '0', 10);
      const attendanceRate = expectedAtt > 0 ? Math.round((presentAtt / expectedAtt) * 100) : 0;

      const totalShiftsCov = parseInt(coverageRes?.total || '0', 10);
      const confirmedShiftsCov = parseInt(coverageRes?.confirmed || '0', 10);
      const shiftCoverage = totalShiftsCov > 0 ? Math.round((confirmedShiftsCov / totalShiftsCov) * 100) : 0;

      console.log(`[AdminHome] Results - AttRate: ${attendanceRate}% (${presentAtt}/${expectedAtt}), Absences: ${totalAbsences}, Delays: ${delays}, Coverage: ${shiftCoverage}%`);

      const onboardingInProgress = parseInt(onboardingRes?.in_progress || '0', 10);
      const onboardingCompletionRate = Math.round(parseFloat(onboardingRes?.avg_pct || '0'));

      ok(res, {
        stats: {
          companies: parseInt(companiesRes?.count || '0', 10),
          activeStores: parseInt(storesRes?.count || '0', 10),
          activeEmployees: parseInt(employeesRes?.count || '0', 10),
        },
        dashboardStats: {
          attendanceRate,
          totalAbsences,
          // Reported separately so the dashboard can show that the drop in
          // absences is justified leave, not a data loss.
          justifiedAbsences,
          delays,
          shiftCoverage,
        },
        staticStats: {
          documentExpiryCount: parseInt(documentExpiryRes?.count || '0', 10),
          onboardingInProgress,
          onboardingCompletionRate,
          atsTotalCandidates: parseInt(atsRes?.total || '0', 10),
          atsInterviewCandidates: parseInt(atsRes?.interview || '0', 10),
        },
        roleBreakdown,
        storeBreakdown,
      });
      break;
    }

    case 'hr': {
      const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
      const [
        expiringContracts, newHires, totalEmployeesRes, monthlyHires, statusBreakdown, expiringTrainings, expiringMedicals,
        pendingShiftPreview, pendingShiftCountRow, pendingLeavePreview, pendingLeaveCountRow,
        totalStoresRes, expiringContractsCountRes, nextShiftRow,
      ] = await Promise.all([
        query(
          `SELECT id, name, surname, store_id, termination_date AS contract_end_date FROM users
           WHERE company_id = ANY($1) AND status = 'active' AND role != 'store_terminal' AND termination_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
           ORDER BY termination_date LIMIT 10`,
          [allowedCompanyIds]
        ),
        query(
          `SELECT id, name, surname, role, hire_date FROM users
           WHERE company_id = ANY($1) AND hire_date >= DATE_TRUNC('month', CURRENT_DATE)
           ORDER BY hire_date DESC LIMIT 10`,
          [allowedCompanyIds]
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) AS count FROM users WHERE company_id = ANY($1) AND status = 'active' AND role != 'store_terminal'`,
          [allowedCompanyIds]
        ),
        query<{ month: string; count: number }>(
          `SELECT TO_CHAR(DATE_TRUNC('month', hire_date), 'YYYY-MM') AS month, COUNT(*)::int AS count
           FROM users
           WHERE company_id = ANY($1) AND hire_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months'
           GROUP BY DATE_TRUNC('month', hire_date)
           ORDER BY 1`,
          [allowedCompanyIds]
        ),
        query<{ status: string; count: number }>(
          `SELECT status, COUNT(*)::int AS count FROM users WHERE company_id = ANY($1) GROUP BY status`,
          [allowedCompanyIds]
        ),
        query(
          `SELECT t.id, t.training_type, t.end_date,
                  u.id AS user_id, u.name, u.surname
           FROM employee_trainings t
           JOIN users u ON u.id = t.user_id
           WHERE t.company_id = ANY($1) AND t.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '60 days'
           ORDER BY t.end_date LIMIT 10`,
          [allowedCompanyIds]
        ),
        query(
          `SELECT m.id, m.end_date,
                  u.id AS user_id, u.name, u.surname
           FROM employee_medical_checks m
           JOIN users u ON u.id = m.user_id
           WHERE m.company_id = ANY($1) AND m.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '60 days'
           ORDER BY m.end_date LIMIT 10`,
          [allowedCompanyIds]
        ),
        query(
          `SELECT s.id, s.user_id, TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
                  s.start_time, s.end_time, u.name AS user_name, u.surname AS user_surname, st.name AS store_name
           FROM shifts s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN stores st ON st.id = s.store_id
           WHERE s.company_id = ANY($1) AND s.status = 'scheduled'
             AND s.date >= CURRENT_DATE AND s.date <= CURRENT_DATE + INTERVAL '60 days'
           ORDER BY s.date, s.start_time
           LIMIT 8`,
          [allowedCompanyIds],
        ),
        queryOne<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM shifts s
           WHERE s.company_id = ANY($1) AND s.status = 'scheduled'
             AND s.date >= CURRENT_DATE AND s.date <= CURRENT_DATE + INTERVAL '60 days'`,
          [allowedCompanyIds],
        ),
        query(
          `SELECT lr.id, lr.user_id, lr.leave_type, lr.start_date, lr.end_date,
                  u.name AS user_name, u.surname AS user_surname
           FROM leave_requests lr
           JOIN users u ON u.id = lr.user_id
           WHERE lr.company_id = ANY($1) AND lr.current_approver_role = 'hr'
           ORDER BY lr.created_at ASC
           LIMIT 8`,
          [allowedCompanyIds],
        ),
        queryOne<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM leave_requests lr
           WHERE lr.company_id = ANY($1) AND lr.current_approver_role = 'hr'`,
          [allowedCompanyIds],
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) AS count FROM stores WHERE company_id = ANY($1) AND is_active = true`,
          [allowedCompanyIds]
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) AS count FROM users WHERE company_id = ANY($1) AND status = 'active' AND role != 'store_terminal' AND termination_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`,
          [allowedCompanyIds]
        ),
        // Caller's own next shift
        queryOne(
          `SELECT s.id, TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
                  s.start_time, s.end_time, s.status,
                  st.name AS store_name
           FROM shifts s
           JOIN stores st ON st.id = s.store_id
           WHERE s.user_id = $1 AND s.company_id = $2
             AND s.status != 'cancelled'
             AND s.date >= CURRENT_DATE
           ORDER BY s.date, s.start_time
           LIMIT 1`,
          [userId, companyId]
        ),
      ]);
      ok(res, {
        expiringContracts,
        newHires,
        totalEmployees: parseInt(totalEmployeesRes?.count || '0', 10),
        monthlyHires,
        statusBreakdown,
        expiringTrainings,
        expiringMedicals,
        pendingShiftPreview,
        pendingShiftCount: parseInt(pendingShiftCountRow?.c ?? '0', 10),
        pendingLeavePreview,
        pendingLeaveCount: parseInt(pendingLeaveCountRow?.c ?? '0', 10),
        totalStores: parseInt(totalStoresRes?.count || '0', 10),
        expiringContractsCount: parseInt(expiringContractsCountRes?.count || '0', 10),
        nextShift: nextShiftRow ?? null,
      });
      break;
    }

    case 'area_manager': {
      const allowedCompanyIds = await resolveAllowedCompanyIds(req.user!);
      const hasCrossCompanyAccess = allowedCompanyIds.length > 1;

      let visibleStoreIds: number[] = [];
      let assignedStores: { id: number; name: string; code: string; employee_count: number; logo_filename: string | null; store_manager: string | null }[] = [];

      if (hasCrossCompanyAccess) {
        // Toggle is ON: Include all stores in the group companies
        assignedStores = await query<{ id: number; name: string; code: string; employee_count: number; logo_filename: string | null; store_manager: string | null }>(
          `SELECT s.id, s.name, s.code, s.logo_filename,
            (SELECT STRING_AGG(u2.name || ' ' || u2.surname, ', ') FROM users u2 WHERE u2.store_id = s.id AND u2.role = 'store_manager' AND u2.status = 'active') AS store_manager,
            (SELECT COUNT(*) FROM users u WHERE u.store_id = s.id AND u.status = 'active')::int AS employee_count
           FROM stores s
           WHERE s.is_active = true AND s.company_id = ANY($1)
           ORDER BY s.name`,
          [allowedCompanyIds]
        );
        visibleStoreIds = assignedStores.map(s => s.id);
      } else {
        // Toggle is OFF: Only include stores assigned directly in own company
        assignedStores = await query<{ id: number; name: string; code: string; employee_count: number; logo_filename: string | null; store_manager: string | null }>(
          `SELECT DISTINCT s.id, s.name, s.code, s.logo_filename,
            (SELECT STRING_AGG(u2.name || ' ' || u2.surname, ', ') FROM users u2 WHERE u2.store_id = s.id AND u2.role = 'store_manager' AND u2.status = 'active') AS store_manager,
            (SELECT COUNT(*) FROM users u WHERE u.store_id = s.id AND u.status = 'active')::int AS employee_count
           FROM stores s
           INNER JOIN users emp ON emp.store_id = s.id AND emp.supervisor_id = $1 AND emp.company_id = $2
           WHERE s.is_active = true
           ORDER BY s.name`,
          [userId, companyId]
        );

        const amStores = (await resolveAreaManagerStoreIds(userId, [companyId as number]))
          .map((store_id) => ({ store_id }));

        visibleStoreIds = Array.from(new Set([
          ...assignedStores.map(s => s.id),
          ...amStores.map(r => r.store_id)
        ]));
      }

      // Metrics calculation
      let activeEmployeesCount = 0;
      let presentEmployeesCount = 0;
      let weeklyHours = 0;

      if (visibleStoreIds.length > 0) {
        const [empRes, presRes, hoursRes] = await Promise.all([
          queryOne<{ c: string }>(
            `SELECT COUNT(*)::text AS c FROM users 
             WHERE role = 'employee' AND status = 'active' AND store_id = ANY($1)`,
            [visibleStoreIds]
          ),
          queryOne<{ c: string }>(
            `SELECT COUNT(DISTINCT ae.user_id)::text AS c 
             FROM attendance_events ae
             JOIN users u ON u.id = ae.user_id
             WHERE ae.event_type = 'checkin' 
               AND ae.created_at::date = CURRENT_DATE
               AND u.role = 'employee' AND u.status = 'active' 
               AND u.store_id = ANY($1)`,
            [visibleStoreIds]
          ),
          queryOne<{ total: string }>(
            `SELECT COALESCE(SUM(weekly_hours), 0)::text AS total
             FROM users
             WHERE role = 'employee' AND status = 'active'
               AND store_id = ANY($1)`,
            [visibleStoreIds]
          )
        ]);

        activeEmployeesCount = parseInt(empRes?.c ?? '0', 10);
        presentEmployeesCount = parseInt(presRes?.c ?? '0', 10);
        weeklyHours = Math.round(parseFloat(hoursRes?.total ?? '0'));
      }

      let pendingShiftPreview: unknown[] = [];
      let pendingShiftCount = 0;
      let pendingLeavePreview: unknown[] = [];
      let pendingLeaveCount = 0;

      const storesForPending = hasCrossCompanyAccess ? visibleStoreIds : visibleStoreIds; // Both cases use visibleStoreIds now

      if (storesForPending.length > 0) {
        const ph = storesForPending.map((_, i) => `$${2 + i}`).join(', ');
        pendingShiftPreview = await query(
          `SELECT s.id, s.user_id, TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
                  s.start_time, s.end_time, u.name AS user_name, u.surname AS user_surname, u.role AS user_role, u.avatar_filename AS user_avatar_filename, st.name AS store_name
           FROM shifts s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN stores st ON st.id = s.store_id
           WHERE s.company_id = ANY($1) AND s.store_id IN (${ph})
             AND s.status = 'scheduled'
             AND s.date >= CURRENT_DATE AND s.date <= CURRENT_DATE + INTERVAL '60 days'
           ORDER BY s.date, s.start_time
           LIMIT 8`,
          [allowedCompanyIds, ...storesForPending],
        );
        const psc = await queryOne<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM shifts s
           WHERE s.company_id = ANY($1) AND s.store_id IN (${ph})
             AND s.status = 'scheduled'
             AND s.date >= CURRENT_DATE AND s.date <= CURRENT_DATE + INTERVAL '60 days'`,
          [allowedCompanyIds, ...storesForPending],
        );
        pendingShiftCount = parseInt(psc?.c ?? '0', 10);
        pendingLeavePreview = await query(
          `SELECT lr.id, lr.user_id, lr.leave_type, lr.start_date, lr.end_date,
                  u.name AS user_name, u.surname AS user_surname, u.role AS user_role, u.avatar_filename AS user_avatar_filename, st.name AS store_name
           FROM leave_requests lr
           JOIN users u ON u.id = lr.user_id
           LEFT JOIN stores st ON st.id = lr.store_id
           WHERE lr.company_id = ANY($1) AND lr.current_approver_role = 'area_manager'
             AND lr.store_id IN (${ph})
           ORDER BY lr.created_at ASC
           LIMIT 8`,
          [allowedCompanyIds, ...storesForPending],
        );
        const plc = await queryOne<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM leave_requests lr
           WHERE lr.company_id = ANY($1) AND lr.current_approver_role = 'area_manager'
             AND lr.store_id IN (${ph})`,
          [allowedCompanyIds, ...storesForPending],
        );
        pendingLeaveCount = parseInt(plc?.c ?? '0', 10);
      }
      const nextShiftRow = await queryOne(
        `SELECT s.id, TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
                s.start_time, s.end_time, s.status,
                st.name AS store_name
         FROM shifts s
         JOIN stores st ON st.id = s.store_id
         WHERE s.user_id = $1 AND s.company_id = $2
           AND s.status != 'cancelled'
           AND s.date >= CURRENT_DATE
         ORDER BY s.date, s.start_time
         LIMIT 1`,
        [userId, companyId]
      );

      ok(res, {
        assignedStores,
        pendingShiftPreview,
        pendingShiftCount,
        pendingLeavePreview,
        pendingLeaveCount,
        nextShift: nextShiftRow ?? null,
        stats: {
          totalStores: visibleStoreIds.length,
          activeEmployees: activeEmployeesCount,
          presentEmployees: presentEmployeesCount,
          weeklyHours: weeklyHours
        }
      });
      break;
    }

    case 'store_manager': {
      if (!storeId) {
        ok(res, { store: null, employeeCount: 0, todayShifts: [], todayAttendance: {}, upcomingWeekShiftsPlanned: true, upcomingWeekNumber: 0, todayAnomalies: [] });
        break;
      }
      const today = localToday();
      const [
        store,
        employeeCount,
        todayShifts,
        todayAttendanceSummary,
        upcomingWeekCheck,
        activeEmpRes,
        presentEmpRes,
        ongoingOnboardingRes,
        pendingLeaveRequestsRes,
        nextShiftRow
      ] = await Promise.all([
        queryOne(
          `SELECT id, name, code, max_staff FROM stores WHERE id = $1 AND company_id = $2`,
          [storeId, companyId]
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) AS count FROM users WHERE store_id = $1 AND company_id = $2 AND status = 'active'`,
          [storeId, companyId]
        ),
        query(
          `SELECT s.id, u.name, u.surname, s.start_time, s.end_time, s.status,
                  (
                    SELECT ae.event_type
                    FROM attendance_events ae
                    WHERE ae.user_id = s.user_id
                      AND ae.store_id = s.store_id
                      AND ae.event_time::DATE = CURRENT_DATE
                    ORDER BY ae.event_time DESC
                    LIMIT 1
                  ) AS latest_event
           FROM shifts s
           JOIN users u ON u.id = s.user_id
           WHERE s.store_id = $1 AND s.company_id = $2
             AND s.date = CURRENT_DATE
             AND s.status != 'cancelled'
           ORDER BY s.start_time`,
          [storeId, companyId]
        ),
        query<{ event_type: string; count: string }>(
          `SELECT event_type, COUNT(*)::int AS count
           FROM attendance_events
           WHERE store_id = $1 AND company_id = $2
             AND event_time::DATE = CURRENT_DATE
           GROUP BY event_type`,
          [storeId, companyId]
        ),
        queryOne<{ count: string; week_number: string }>(
          `SELECT
             COUNT(*)::text AS count,
             EXTRACT(WEEK FROM DATE_TRUNC('week', CURRENT_DATE + INTERVAL '1 week'))::text AS week_number
           FROM shifts
           WHERE store_id = $1 AND company_id = $2
             AND date >= DATE_TRUNC('week', CURRENT_DATE + INTERVAL '1 week')
             AND date < DATE_TRUNC('week', CURRENT_DATE + INTERVAL '2 weeks')
             AND status != 'cancelled'`,
          [storeId, companyId]
        ),
        // Active Employees Count
        queryOne<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM users 
           WHERE store_id = $1 AND role = 'employee' AND status = 'active'`,
          [storeId]
        ),
        // Present Employees Count (today)
        queryOne<{ c: string }>(
          `SELECT COUNT(DISTINCT user_id)::text AS c 
           FROM attendance_events 
           WHERE store_id = $1 AND event_type = 'checkin' AND event_time::date = CURRENT_DATE`,
          [storeId]
        ),
        // Ongoing Onboarding Tasks Count (not completed)
        queryOne<{ total: string }>(
          `SELECT COUNT(t.id)::text AS total 
           FROM employee_onboarding_tasks t
           JOIN users u ON u.id = t.employee_id
           WHERE u.store_id = $1 AND u.company_id = $2 AND u.status = 'active' AND t.completed = FALSE`,
          [storeId, companyId]
        ),
        // Pending Leave Requests Count (store manager approval stage)
        queryOne<{ total: string }>(
          `SELECT COUNT(*)::text AS total
           FROM leave_requests lr
           WHERE lr.store_id = $1 AND lr.company_id = $2 AND lr.current_approver_role = 'store_manager'`,
          [storeId, companyId]
        ),
        // Manager's own next shift
        queryOne(
          `SELECT s.id, TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
                  s.start_time, s.end_time, s.status,
                  st.name AS store_name
           FROM shifts s
           JOIN stores st ON st.id = s.store_id
           WHERE s.user_id = $1 AND s.company_id = $2
             AND s.status != 'cancelled'
             AND s.date >= CURRENT_DATE
           ORDER BY s.date, s.start_time
           LIMIT 1`,
          [userId, companyId]
        )
      ]);

      const activeCount = parseInt(activeEmpRes?.c ?? '0', 10);
      const presentCount = parseInt(presentEmpRes?.c ?? '0', 10);
      const ongoingOnboarding = parseInt(ongoingOnboardingRes?.total ?? '0', 10);
      const pendingLeaveRequests = parseInt(pendingLeaveRequestsRes?.total ?? '0', 10);

      // ── Anomalies calculation (mirrors attendance.controller.ts) ──────────
      // 1. Fetch finished shifts for today
      const finishedShifts = await query<{
        id: number; company_id: number; user_id: number; store_id: number; date: string;
        start_time: string; end_time: string;
        break_start: string | null; break_end: string | null;
        user_name: string; user_surname: string; store_name: string;
        user_avatar_filename: string | null;
      }>(
        `SELECT s.id, s.company_id, s.user_id, s.store_id, TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
                s.start_time, s.end_time, s.break_start, s.break_end,
                u.name AS user_name, u.surname AS user_surname, u.avatar_filename AS user_avatar_filename,
                st.name AS store_name
         FROM shifts s
         LEFT JOIN users u  ON u.id  = s.user_id
         LEFT JOIN stores st ON st.id = s.store_id
         WHERE s.company_id = $1
           AND s.store_id = $2
           AND s.date = $3
           AND s.status != 'cancelled'
         ORDER BY s.user_id`,
        [companyId, storeId, today],
      );

      // 2. Fetch events for today
      const events = await query<{
        user_id: number; event_type: string; event_time: string; source: string;
      }>(
        `SELECT ae.user_id, ae.event_type, ae.event_time, ae.source
         FROM attendance_events ae
         WHERE ae.company_id = $1
           AND ae.store_id = $2
           AND ae.event_time::DATE = $3
         ORDER BY ae.user_id, ae.event_time`,
        [companyId, storeId, today],
      );

      // 3. Process anomalies
      type EventGroup = { checkin?: Date; checkout?: Date; break_start?: Date; break_end?: Date; checkin_source?: string };
      const eventMap = new Map<string, EventGroup>();
      for (const e of events) {
        const date = localDateStr(new Date(e.event_time));
        const key = `${e.user_id}:${date}`;
        if (!eventMap.has(key)) eventMap.set(key, {});
        const group = eventMap.get(key)!;
        const t = new Date(e.event_time);
        if (e.event_type === 'checkin' && (!group.checkin || t < group.checkin)) { group.checkin = t; group.checkin_source = e.source; }
        if (e.event_type === 'checkout' && (!group.checkout || t > group.checkout)) group.checkout = t;
        if (e.event_type === 'break_start' && (!group.break_start || t < group.break_start)) group.break_start = t;
        if (e.event_type === 'break_end' && (!group.break_end || t > group.break_end)) group.break_end = t;
      }

      const leaveDays = companyId
        ? await loadApprovedLeaveDays([companyId], today, today, { storeId })
        : new Set<string>();

      const LATE_MS = 10 * 60 * 1000; // 10 minutes
      const EARLY_EXIT_MS = 1000;
      const LONG_BREAK_MS = 5 * 60 * 1000;  // 5 minutes
      const OVERTIME_MS = 60 * 60 * 1000; // 1 hour

      const todayAnomalies: any[] = [];
      const nowTs = new Date().getTime();
      for (const shift of finishedShifts) {
        const key = `${shift.user_id}:${shift.date}`;
        const evGroup = eventMap.get(key);
        // Parse shift times as server-local time (matches how shift times are entered)
        const shiftStart = new Date(`${shift.date}T${shift.start_time}`);
        const shiftEnd   = new Date(`${shift.date}T${shift.end_time}`);
        // Skip shifts that haven't started yet
        if (shiftStart.getTime() > nowTs) continue;

        if (!evGroup?.checkin) {
          // Same rule as the anomaly engine: approved leave is a justified
          // absence, so it must not appear on the manager's dashboard as a
          // no-show. (This third copy of the no-show logic was not in the
          // original report — it had the same defect.)
          const onLeave = leaveDays.has(leaveCoverageKey(shift.user_id, shift.date));
          if (shiftEnd.getTime() < nowTs && !onLeave) {
            todayAnomalies.push({
              anomaly_type: 'no_show', severity: 'high',
              user_name: shift.user_name, user_surname: shift.user_surname,
              user_avatar_filename: shift.user_avatar_filename,
              details_key: 'attendance.detail_no_show',
              details_params: { start: shift.start_time.slice(0, 5), end: shift.end_time.slice(0, 5) },
            });
          }
          continue;
        }

        const { checkin, checkout, break_start: bStart, break_end: bEnd } = evGroup;
        const lateMs = checkin.getTime() - shiftStart.getTime();
        if (lateMs > LATE_MS) {
          const lateMin = Math.round(lateMs / 60000);
          todayAnomalies.push({
            anomaly_type: 'late_arrival', severity: lateMin > 30 ? 'high' : 'medium',
            user_name: shift.user_name, user_surname: shift.user_surname,
            user_avatar_filename: shift.user_avatar_filename,
            details_key: 'attendance.detail_late_arrival',
            details_params: { minutes: lateMin, entry: checkin.toTimeString().slice(0, 5), shift: shift.start_time.slice(0, 5) },
          });
        }
        if (checkout) {
          const earlyMs = shiftEnd.getTime() - checkout.getTime();
          if (earlyMs >= EARLY_EXIT_MS) {
            const earlyMin = Math.round(earlyMs / 60000);
            todayAnomalies.push({
              anomaly_type: 'early_exit', severity: earlyMin > 30 ? 'high' : 'medium',
              user_name: shift.user_name, user_surname: shift.user_surname,
              user_avatar_filename: shift.user_avatar_filename,
              details_key: 'attendance.detail_early_exit',
              details_params: { minutes: earlyMin, exit: checkout.toTimeString().slice(0, 5), shift: shift.end_time.slice(0, 5) },
            });
          }
        }
        if (bEnd && shift.break_end) {
          const scheduledBreakEnd = new Date(`${shift.date}T${shift.break_end}`);
          const breakLateMs = bEnd.getTime() - scheduledBreakEnd.getTime();
          if (breakLateMs > LONG_BREAK_MS) {
            const breakMin = Math.round(breakLateMs / 60000);
            todayAnomalies.push({
              anomaly_type: 'long_break', severity: breakMin > 30 ? 'high' : 'medium',
              user_name: shift.user_name, user_surname: shift.user_surname,
              user_avatar_filename: shift.user_avatar_filename,
              details_key: 'attendance.detail_long_break',
              details_params: { minutes: breakMin },
            });
          }
        }
        if (checkout) {
          const overtimeMs = checkout.getTime() - shiftEnd.getTime();
          if (overtimeMs > OVERTIME_MS) {
            const overtimeMin = Math.round(overtimeMs / 60000);
            todayAnomalies.push({
              anomaly_type: 'overtime', severity: overtimeMin > 30 ? 'high' : 'medium',
              user_name: shift.user_name, user_surname: shift.user_surname,
              user_avatar_filename: shift.user_avatar_filename,
              details_key: 'attendance.detail_overtime',
              details_params: {
                minutes: overtimeMin,
                actual: checkout.toTimeString().slice(0, 5),
                scheduled: shift.end_time.slice(0, 5),
              },
            });
          }
        }
      }

      ok(res, {
        store,
        employeeCount: parseInt(employeeCount?.count || '0', 10),
        todayShifts,
        todayAnomalies,
        todayAttendance: Object.fromEntries(
          todayAttendanceSummary.map((r) => [r.event_type, parseInt(r.count, 10)])
        ),
        upcomingWeekShiftsPlanned: parseInt(upcomingWeekCheck?.count || '0', 10) > 0,
        upcomingWeekNumber: parseInt(upcomingWeekCheck?.week_number || '0', 10),
        nextShift: nextShiftRow ?? null,
        stats: {
          activeEmployees: activeCount,
          presentEmployees: presentCount,
          ongoingOnboarding: ongoingOnboarding,
          pendingLeaveRequests: pendingLeaveRequests
        }
      });
      break;
    }

    case 'employee': {
      const [profile, nextShiftRow, leaveBalances, birthdayRow, companySettings, turniPermission] = await Promise.all([
        queryOne(
          `SELECT u.id, u.name, u.surname, u.role, u.department,
                  s.name AS store_name
           FROM users u
           LEFT JOIN stores s ON s.id = u.store_id
           WHERE u.id = $1 AND u.company_id = $2`,
          [userId, companyId]
        ),
        queryOne(
          `SELECT s.id, TO_CHAR(s.date, 'YYYY-MM-DD') AS date,
                  s.start_time, s.end_time, s.status,
                  st.name AS store_name
           FROM shifts s
           JOIN stores st ON st.id = s.store_id
           WHERE s.user_id = $1 AND s.company_id = $2
             AND s.status != 'cancelled'
             AND s.date >= CURRENT_DATE
           ORDER BY s.date, s.start_time
           LIMIT 1`,
          [userId, companyId]
        ),
        query<{ leave_type: string; total_days: string; used_days: string }>(
          `SELECT leave_type, total_days, used_days
           FROM leave_balances
           WHERE user_id = $1 AND company_id = $2
             AND year = EXTRACT(YEAR FROM CURRENT_DATE)::int`,
          [userId, companyId]
        ),
        queryOne<{ is_birthday: boolean }>(
          `SELECT (
             date_of_birth IS NOT NULL
             AND EXTRACT(MONTH FROM date_of_birth) = EXTRACT(MONTH FROM CURRENT_DATE)
             AND EXTRACT(DAY   FROM date_of_birth) = EXTRACT(DAY   FROM CURRENT_DATE)
           ) AS is_birthday
           FROM users WHERE id = $1`,
          [userId]
        ),
        queryOne<{ show_leave_balance_to_employee: boolean }>(
          `SELECT show_leave_balance_to_employee FROM companies WHERE id = $1`,
          [companyId]
        ),
        queryOne<{ is_enabled: boolean }>(
          `SELECT is_enabled FROM role_module_permissions
           WHERE company_id = $1 AND role = 'employee' AND module_name = 'turni'`,
          [companyId]
        ),
      ]);
      ok(res, {
        profile,
        nextShift: nextShiftRow ?? null,
        leaveBalance: leaveBalances.map((b) => ({
          leaveType: b.leave_type,
          totalDays: parseFloat(b.total_days),
          usedDays: parseFloat(b.used_days),
          remaining: parseFloat(b.total_days) - parseFloat(b.used_days),
        })),
        isBirthday: birthdayRow?.is_birthday ?? false,
        showLeaveBalance: companySettings?.show_leave_balance_to_employee ?? true,
        showShifts: turniPermission?.is_enabled ?? true,
      });
      break;
    }

    case 'store_terminal': {
      if (!storeId) {
        ok(res, { store: null });
        break;
      }
      // The terminal screen shows a clock, and the clock-in window it is about to
      // open is enforced in the store's zone — so the screen has to know which zone
      // that is, or it silently shows the tablet's own clock instead.
      const store = await queryOne(
        `SELECT id, name, code, timezone FROM stores WHERE id = $1 AND company_id = $2`,
        [storeId, companyId]
      );
      ok(res, { store });
      break;
    }

    default:
      ok(res, {});
  }
});
