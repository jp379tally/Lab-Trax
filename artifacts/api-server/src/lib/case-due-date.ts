export {
  addCalendarDays,
  resolveAiIntakePrescriptionDueDate,
} from "@workspace/calendar-date";

/**
 * Shared resolver for new-case due dates.
 *
 * Rules:
 *   - When cap is ON (or unset/null — cap defaults to enabled) and a turnaround is set:
 *     return min(suppliedDate, entry + turnaround).
 *   - When no date is supplied: fall back to entry + turnaround (cap toggle does not affect
 *     the fallback — the fallback is the turnaround by definition).
 *   - When cap is explicitly OFF (capEnabled === false): supplied date is kept as-is;
 *     fallback to turnaround still applies when no date was supplied (existing behaviour).
 *   - When no turnaround is set: return suppliedDate as-is (or null if nothing was supplied).
 *
 * `capEnabled` semantics: null/undefined → treated as true (cap is on by default).
 * Only an explicit `false` disables the cap.
 *
 * This helper is intentionally pure so it can be unit-tested without a DB.
 */
export const DUE_TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidDueTime(value: string): boolean {
  return DUE_TIME_REGEX.test(value);
}

export function resolveCaseDueDate(
  suppliedDate: Date | null,
  entryDate: Date,
  defaultCaseDueDays: number | null | undefined,
  capEnabled: boolean | null | undefined,
): Date | null {
  const turnaroundMs = defaultCaseDueDays ? defaultCaseDueDays * 86_400_000 : null;
  const maxDate = turnaroundMs && capEnabled !== false
    ? new Date(entryDate.getTime() + turnaroundMs)
    : null;

  if (suppliedDate) {
    if (maxDate && suppliedDate.getTime() > maxDate.getTime()) return maxDate;
    return suppliedDate;
  }

  if (turnaroundMs) {
    return new Date(entryDate.getTime() + turnaroundMs);
  }

  return null;
}
