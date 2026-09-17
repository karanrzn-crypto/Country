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

/** Month names for the campaign-elapsed stamp (calendar months, not counts). */
const MONTH_NAMES: readonly string[] = [
  'ژانویه', 'فوریه', 'مارس', 'آوریل', 'مه', 'ژوئن',
  'ژوئیه', 'اوت', 'سپتامبر', 'اکتبر', 'نوامبر', 'دسامبر'
];

/** Zero-pads a number to 2 digits ("07:05"). */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Campaign-elapsed stamp shown in the time bar — the player-facing form of
 * the single source of truth, e.g. «سال 1 — ژانویه — روز 1 — 08:00».
 *
 * Year counts campaigns years (1-based from the start year), the month is
 * the CALENDAR month of that year (a month COUNT like "Month 24" is noise —
 * the player reads January → February → March), and Day is 1-based within
 * the month, walked through real month lengths (correct for any start date).
 * Latin digits are kept deliberately: they stay unambiguous inside the RTL
 * time bar and read tabularly next to the numeric clock.
 */
export function formatCalendarElapsed(date: CalendarDate, start: CalendarStart): string {
  return `سال ${date.year - start.year + 1} — ${MONTH_NAMES[date.month - 1]} — روز ${date.day} — ${pad2(date.hour)}:${pad2(date.minute)}`;
}

/** 1-based absolute day index (days since year 0, ignoring leap years). */
function dayNumber(date: { year: number; month: number; day: number }): number {
  let days = date.year * 365;
  for (let month = 1; month < date.month; month++) days += DAYS_IN_MONTH[month - 1];
  return days + date.day;
}

/**
 * Converts a calendar date into total elapsed MINUTES since `start` — the
 * exact inverse of minutesToCalendar (integer math, no drift). The date is
 * clamped into the supported range so round-trips are stable.
 */
export function calendarToMinutes(date: CalendarDate, start: CalendarStart): number {
  const days = dayNumber({ year: date.year, month: date.month, day: date.day }) -
    dayNumber({ year: start.year, month: start.month, day: start.day });
  return days * MINUTES_PER_DAY + date.hour * MINUTES_PER_HOUR + date.minute;
}

/** The number of days in a month (no leap years — deterministic). */
export function daysInMonth(year: number, month: number): number {
  void year;
  return DAYS_IN_MONTH[Math.min(11, Math.max(0, month - 1))];
}

/**
 * Advances a date by EXACTLY ONE calendar MONTH, landing on the same
 * time-of-day with the day-of-month clamped into the target month
 * (Jan 31 + 1 month = Feb 28). Returns the new elapsed-minutes value.
 * Pure integer math — deterministic for any input.
 */
export function minutesAfterOneMonth(elapsedMinutes: number, start: CalendarStart): number {
  const date = minutesToCalendar(elapsedMinutes, start);
  let month = date.month + 1;
  let year = date.year;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  const day = Math.min(date.day, daysInMonth(year, month));
  return calendarToMinutes({ year, month, day, hour: date.hour, minute: date.minute }, start);
}

/**
 * Advances a date by EXACTLY ONE calendar YEAR (same month/day/time —
 * always valid without leap years). Returns the new elapsed-minutes value.
 */
export function minutesAfterOneYear(elapsedMinutes: number, start: CalendarStart): number {
  const date = minutesToCalendar(elapsedMinutes, start);
  return calendarToMinutes(
    { year: date.year + 1, month: date.month, day: date.day, hour: date.hour, minute: date.minute },
    start
  );
}

/** ABSOLUTE month index since campaign start — the simulation's month math unit. */
export function absoluteMonthIndex(date: CalendarDate, start: CalendarStart): number {
  return (date.year - start.year) * 12 + (date.month - start.month);
}
