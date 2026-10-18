import { isValidCalendarDate } from "@workspace/calendar-date";

/** Return a date-only value only for an exact, real MM/DD/YYYY calendar date. */
export function parseTypedCaseDate(input: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input);
  if (!match) return null;
  if (match[3] === "0000") return null;
  const iso = `${match[3]}-${match[1]}-${match[2]}`;
  return isValidCalendarDate(iso) ? iso : null;
}