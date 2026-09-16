/**
 * Game calendar: converts between "hours since campaign start" and
 * year/month/day/hour/minute. Uses real month lengths, non-leap years
 * (leap-year support is deferred to a later phase — deterministic either way).
 *
 * Minute support: `hoursPerTick` may be fractional (e.g. 0.25 = 15-minute
 * ticks), so conversion works in integer MINUTES to stay exact and
 * deterministic — no floating-point drift accumulates in the display.
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

export function hoursToCalendar(totalHours: number, start: CalendarStart): CalendarDate {
  let year = start.year;
  let month = start.month;
  let day = start.day;
  // Integer minutes keep the conversion exact for fractional hour ticks.
  const totalMinutes = Math.max(0, Math.floor(totalHours * MINUTES_PER_HOUR + 1e-6));
  const minute = totalMinutes % MINUTES_PER_HOUR;
  let hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
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

export function formatCalendarDate(date: CalendarDate): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${date.year}-${pad(date.month)}-${pad(date.day)} ${pad(date.hour)}:${pad(date.minute)}`;
}
