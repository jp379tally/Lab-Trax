import type { LabCase } from "@/lib/types";

/**
 * The Cases page date-range filter selection. Mirrors the dropdown options on
 * the Cases page: a fixed preset, a rolling N-day window, a custom range, or
 * "all" (no date filtering).
 */
export type DateRangeFilter = "all" | "today" | "30" | "60" | "90" | "custom";

/**
 * Resolve a date-range filter selection into a concrete [startDate, endDate)
 * half-open interval.
 *
 * Returns `null` for either bound when that bound is unconstrained. `endDate`
 * is always exclusive (the day *after* the last included day) so that a
 * same-day "today → today" custom range still includes the entire current day.
 *
 * `now` is injectable so tests are not wall-clock dependent.
 */
export function computeCaseDateRange(
  dateRangeFilter: DateRangeFilter,
  customStartDate: string,
  customEndDate: string,
  now: Date = new Date(),
): { startDate: Date | null; endDate: Date | null } {
  let startDate: Date | null = null;
  let endDate: Date | null = null;

  if (dateRangeFilter === "today") {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  } else if (
    dateRangeFilter === "30" ||
    dateRangeFilter === "60" ||
    dateRangeFilter === "90"
  ) {
    const days = Number(dateRangeFilter);
    startDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - days + 1,
    );
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  } else if (dateRangeFilter === "custom") {
    if (customStartDate) {
      const [y, m, d] = customStartDate.split("-").map(Number);
      startDate = new Date(y, m - 1, d);
    }
    if (customEndDate) {
      const [y, m, d] = customEndDate.split("-").map(Number);
      endDate = new Date(y, m - 1, d + 1);
    } else {
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    }
  }

  return { startDate, endDate };
}

/**
 * Decide whether a case falls inside a resolved [startDate, endDate) range.
 *
 * The case is matched on its **received date** (`receivedAt`) — when the lab
 * received it — falling back to the **created date** (`createdAt`) so cases
 * without a received timestamp (legacy/mobile-projected rows) are never
 * silently dropped. A row with neither timestamp, or an unparseable one, is
 * excluded while any date constraint is active.
 *
 * When both bounds are `null` (filter is "all"), every case matches.
 */
export function caseWithinDateRange(
  c: Pick<LabCase, "receivedAt" | "createdAt">,
  startDate: Date | null,
  endDate: Date | null,
): boolean {
  if (startDate === null && endDate === null) return true;
  // Filter by the case's received date (when the lab received it), falling
  // back to the created date so cases without a received timestamp never
  // silently disappear.
  const dateSource = c.receivedAt ?? c.createdAt;
  if (!dateSource) return false;
  const d = new Date(dateSource);
  if (Number.isNaN(d.getTime())) return false;
  if (startDate !== null && d < startDate) return false;
  if (endDate !== null && d >= endDate) return false;
  return true;
}
