export const REPORTS_TIMEZONE = 'Europe/Rome';

const WEEKDAY_MAP: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
}

function getZonedDateParts(date: Date, timeZone = REPORTS_TIMEZONE): ZonedDateParts {
  const parts = getFormatter(timeZone).formatToParts(date);
  const readPart = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) {
      throw new Error(`Missing ${type} in zoned date parts`);
    }
    return value;
  };

  const weekdayLabel = readPart('weekday');
  const weekday = WEEKDAY_MAP[weekdayLabel];
  if (!weekday) {
    throw new Error(`Unsupported weekday label "${weekdayLabel}"`);
  }

  return {
    year: Number(readPart('year')),
    month: Number(readPart('month')),
    day: Number(readPart('day')),
    hour: Number(readPart('hour')),
    minute: Number(readPart('minute')),
    weekday,
  };
}

export function getCurrentReportClock(now: Date = new Date()): {
  dayOfMonth: number;
  weekday: number;
  time: string;
} {
  const parts = getZonedDateParts(now);
  return {
    dayOfMonth: parts.day,
    weekday: parts.weekday,
    time: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
  };
}

function toWallClockDate(parts: ZonedDateParts): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0));
}

function withTime(date: Date, hours: number, minutes: number): Date {
  const next = new Date(date);
  next.setUTCHours(hours, minutes, 0, 0);
  return next;
}

function shiftDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function getClampedMonthDay(year: number, monthIndex: number, targetDay: number): number {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Math.min(Math.max(targetDay, 1), lastDay);
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

export function isMonthlyDayBasedReport(reportId: string): boolean {
  return reportId === 'admin_monthly' || reportId === 'hr_monthly';
}

export function isWeekdayOnlyReport(reportId: string): boolean {
  return reportId === 'anomaly_daily';
}

export function shouldRunReportAtCurrentTime(
  reportId: string,
  day: number,
  now: Date = new Date(),
): boolean {
  const parts = getZonedDateParts(now);

  if (isWeekdayOnlyReport(reportId)) {
    return parts.weekday >= 1 && parts.weekday <= 5;
  }

  const safeDay = day > 7 ? ((day - 1) % 7) + 1 : day;
  return parts.weekday === safeDay;
}

export function getLastScheduledRunDate(
  reportId: string,
  day: number,
  time: string,
  now: Date = new Date(),
): Date {
  const [hours, minutes] = time.split(':').map(Number);
  const parts = getZonedDateParts(now);
  const currentWallClock = toWallClockDate(parts);

  if (isWeekdayOnlyReport(reportId)) {
    let candidate = withTime(currentWallClock, hours, minutes);
    if (candidate.getTime() > currentWallClock.getTime()) {
      candidate = shiftDays(candidate, -1);
    }
    while (isWeekend(candidate)) {
      candidate = shiftDays(candidate, -1);
    }
    return candidate;
  }

  const safeDay = day > 7 ? ((day - 1) % 7) + 1 : day;
  let candidate = withTime(shiftDays(currentWallClock, safeDay - parts.weekday), hours, minutes);
  if (candidate.getTime() > currentWallClock.getTime()) {
    candidate = shiftDays(candidate, -7);
  }
  return candidate;
}
