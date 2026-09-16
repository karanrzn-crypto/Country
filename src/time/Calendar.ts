/**
 * Game calendar: converts between elapsed game time and
 * year/month/day/hour/minute. Uses real month lengths, non-leap years
 * (leap-year support is deferred to a later phase — deterministic either way).
 *
 * The clock works in integer MINUTES — the smallest unit the game tracks —
 * so conversion is exact and deterministic: no floating-point drift can
 * accumulate in the display, no matter how many ticks elapse.
 */

export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

export const HOURS_PER_DAY = 24;
export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface CalendarStart {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Converts total elapsed MINUTES since campaign start into a calendar date.
 * Overflow is handled exactly: minute → hour → day → month → year, with real
 * month lengths (Jan..Dec) and year rollover at December → January.
 */
export function minutesToCalendar(totalMinutes: number, start: CalendarStart): CalendarDate {
  let year = start.year;
  let month = start.month;
  let day = start.day;
  const minutes = Math.max(0, Math.floor(totalMinutes + 1e-6));
  const minute = minutes % MINUTES_PER_HOUR;
  let hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const hour = hours % HOURS_PER_DAY;
  let days = Math.floor(hours / HOURS_PER_DAY);
  while (days > 0) {
    const daysInMonth = DAYS_IN_MONTH[month - 1];
    const daysLeftInMonth = daysInMonth - day;
    if (days <= daysLeftInMonth) {
      day += days;
      days = 0;
    } else {
      days -= daysLeftInMonth + 1;
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  return { year, month, day, hour, minute };
}

/** Back-compat helper: hours (possibly fractional) → calendar date. */
export function hoursToCalendar(totalHours: number, start: CalendarStart): CalendarDate {
  return minutesToCalendar(totalHours * MINUTES_PER_HOUR, start);
}

/** Absolute calendar stamp: YYYY-MM-DD HH:MM (saves, logs, debug). */
export function formatCalendarDate(date: CalendarDate): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${date.year}-${pad(date.month)}-${pad(date.day)} ${pad(date.hour)}:${pad(date.minute)}`;
}

/**
 * Campaign-elapsed stamp shown in the time bar — the player-facing form of
 * the single source of truth, e.g. "Year 1 — Month 1 — Day 1 — 08:00".
 * Year/Month/Day are 1-based offsets walked from the campaign start date
 * through real month lengths (correct for any start date, not just Jan 1).
 */
export function formatCalendarElapsed(date: CalendarDate, start: CalendarStart): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  let remaining = Math.max(0, dayNumber(date) - dayNumber({ year: start.year, month: start.month, day: start.day }));
  remaining += start.day - 1; // express as "days since (startYear, startMonth, 1)"
  let year = start.year;
  let month = start.month;
  while (remaining >= DAYS_IN_MONTH[month - 1]) {
    remaining -= DAYS_IN_MONTH[month - 1];
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  const elapsedYear = year - start.year + 1;
  const elapsedMonth = (year - start.year) * 12 + (month - start.month) + 1;
  const elapsedDay = remaining + 1;
  return `Year ${elapsedYear} — Month ${elapsedMonth} — Day ${elapsedDay} — ${pad(date.hour)}:${pad(date.minute)}`;
}

/** 1-based absolute day index (days since year 0, ignoring leap years). */
function dayNumber(date: { year: number; month: number; day: number }): number {
  let days = date.year * 365;
  for (let month = 1; month < date.month; month++) days += DAYS_IN_MONTH[month - 1];
  return days + date.day;
}
