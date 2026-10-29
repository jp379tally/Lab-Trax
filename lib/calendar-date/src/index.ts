const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CALENDAR_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/i;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

/**
 * Parse an exact YYYY-MM-DD calendar value without treating it as an instant.
 * Invalid dates and rollover values return null.
 */
export function parseCalendarDate(value: string): CalendarDateParts | null {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

/**
 * Read the local calendar day represented by a Date. This deliberately
 * returns date parts rather than a timestamp so day-age comparisons can stay
 * independent of daylight-saving day lengths.
 */
export function getLocalCalendarDateParts(date: Date): CalendarDateParts | null {
  if (Number.isNaN(date.getTime())) return null;
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function parseCalendarDateValue(value: string): CalendarDateParts | null {
  const exactDate = parseCalendarDate(value);
  if (exactDate) return exactDate;

  const timestampMatch = CALENDAR_TIMESTAMP_PATTERN.exec(value);
  if (!timestampMatch || !parseCalendarDate(timestampMatch[1])) return null;

  const timestamp = new Date(value);
  return getLocalCalendarDateParts(timestamp);
}

function calendarDayOrdinal(parts: CalendarDateParts): number {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return date.getTime() / MILLISECONDS_PER_DAY;
}

/**
 * True when `value` is strictly more than `ageDays` local calendar days before
 * `today`. Exact YYYY-MM-DD values remain date-only (no UTC/local shift);
 * legacy ISO timestamps are interpreted as instants and mapped to their local
 * calendar day. Invalid, missing, and future values return false.
 *
 * The comparison uses calendar ordinals rather than elapsed milliseconds, so
 * daylight-saving transitions do not change the result.
 */
export function isMoreThanCalendarDaysAgo(
  value: string | null | undefined,
  ageDays: number,
  today: CalendarDateParts | null,
): boolean {
  if (
    !value ||
    !today ||
    !Number.isInteger(ageDays) ||
    ageDays < 0 ||
    !parseCalendarDate(
      `${String(today.year).padStart(4, "0")}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`,
    )
  ) {
    return false;
  }

  const valueDate = parseCalendarDateValue(value);
  if (!valueDate) return false;
  return calendarDayOrdinal(today) - calendarDayOrdinal(valueDate) > ageDays;
}

export function isValidCalendarDate(value: string): boolean {
  return parseCalendarDate(value) !== null;
}

/** Add whole calendar days to a date-only value without a timezone shift. */
export function addCalendarDays(
  value: string | null | undefined,
  days: number,
): string | null {
  const parts = value ? parseCalendarDate(value) : null;
  if (!parts || !Number.isInteger(days)) return null;

  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day + days);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** True when a valid date-only value falls inside an inclusive date range. */
export function isCalendarDateInInclusiveRange(
  value: string | null | undefined,
  start: string | null | undefined,
  end: string | null | undefined,
): boolean {
  return !!value &&
    !!start &&
    !!end &&
    isValidCalendarDate(value) &&
    isValidCalendarDate(start) &&
    isValidCalendarDate(end) &&
    value >= start &&
    value <= end;
}

/**
 * Keep an extracted Rx date only within the received-to-turnaround window.
 * With no positive configured turnaround, preserve any valid extracted date.
 */
export function resolveAiIntakePrescriptionDueDate(
  prescriptionDueDate: string | null | undefined,
  receivedDate: string | null | undefined,
  defaultCaseDueDays: number | null | undefined,
): string | null {
  if (!prescriptionDueDate || !isValidCalendarDate(prescriptionDueDate)) return null;
  if (defaultCaseDueDays == null || defaultCaseDueDays <= 0) {
    return prescriptionDueDate;
  }
  if (!Number.isInteger(defaultCaseDueDays) || !receivedDate) return null;
  const latestAllowedDate = addCalendarDays(receivedDate, defaultCaseDueDays);
  return latestAllowedDate &&
    isCalendarDateInInclusiveRange(prescriptionDueDate, receivedDate, latestAllowedDate)
    ? prescriptionDueDate
    : null;
}

/** Format an exact calendar value as fixed-order MM/DD/YYYY. */
export function formatCalendarDate(value: string): string | null {
  const parts = parseCalendarDate(value);
  if (!parts) return null;
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  const year = String(parts.year).padStart(4, "0");
  return `${month}/${day}/${year}`;
}

/** Cases range entry only: M/D, M/D/YYYY or a date-only calendar value. */
export function parseRangeDate(input: string, now: Date = new Date()): string | null {
  const text = input.trim();
  if (isValidCalendarDate(text)) return text.startsWith("0000-") ? null : text;
  const match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(text);
  if (!match) return null;
  const year = match[3] ?? String(now.getFullYear()).padStart(4, "0");
  const iso = `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return year !== "0000" && isValidCalendarDate(iso) ? iso : null;
}

export function rangeDateError(start: string | null, end: string | null): string | null {
  if (!start || !end) return "Enter a real Start date and End date (M/D or M/D/YYYY).";
  if (end < start) return "End date must be on or after Start date.";
  return null;
}

/** Construct a local month without Date's special 1900 offset for years 0–99. */
export function rangeCalendarMonth(year: number, month: number): Date {
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month, 1);
  return date;
}

/** A fixed six-week grid, represented as calendar strings, never instants. */
export function rangeMonthDays(year: number, month: number): Array<string | null> {
  const first = new Date(0);
  first.setUTCFullYear(year, month, 1);
  const count = new Date(0);
  count.setUTCFullYear(year, month + 1, 0);
  const offset = first.getUTCDay();
  return Array.from({ length: 42 }, (_, i) => {
    const day = i - offset + 1;
    return day < 1 || day > count.getUTCDate() ? null
      : `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  });
}

/**
 * Convert a calendar-only business date at a timestamp boundary.
 * Noon UTC preserves the established invoice/event convention.
 */
export function calendarDateToUtcNoon(value: string): Date {
  const parts = parseCalendarDate(value);
  if (!parts) {
    throw new RangeError(`Invalid calendar date: ${value}`);
  }
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return date;
}