/**
 * Shared resolver for new-case due dates.
 *
 * Rules:
 *   - When cap is ON and a turnaround is set: return min(suppliedDate, entry + turnaround).
 *   - When no date is supplied: fall back to entry + turnaround (cap toggle does not affect
 *     the fallback — the fallback is the turnaround by definition).
 *   - When cap is OFF: supplied date is kept as-is; fallback to turnaround still applies when
 *     no date was supplied (existing behaviour).
 *   - When no turnaround is set: return suppliedDate as-is (or null if nothing was supplied).
 *
 * This helper is intentionally pure so it can be unit-tested without a DB.
 */
export function resolveCaseDueDate(
  suppliedDate: Date | null,
  entryDate: Date,
  defaultCaseDueDays: number | null | undefined,
  capEnabled: boolean | null | undefined,
): Date | null {
  const turnaroundMs = defaultCaseDueDays ? defaultCaseDueDays * 86_400_000 : null;
  const maxDate = turnaroundMs && capEnabled
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
