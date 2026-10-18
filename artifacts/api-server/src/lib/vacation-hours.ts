/**
 * Pure helper for computing total requested vacation hours from a list of
 * request day entries. Rules:
 *   - All-day entry  → 8 h
 *   - Custom range   → endTime − startTime (raw hours; no lunch-break
 *                       deduction applied here — TODO: plug in a policy,
 *                       e.g. −0.5 h for shifts ≥ 6 h, when required)
 *
 * Throws if any custom-range entry has endTime ≤ startTime.
 */

export interface VacationRequestDayInput {
  isAllDay: boolean;
  startTime?: string | null;
  endTime?: string | null;
}

function parseHHMM(t: string): number {
  const [hStr, mStr] = t.split(":");
  const h = Number(hStr ?? 0);
  const m = Number(mStr ?? 0);
  if (Number.isNaN(h) || Number.isNaN(m)) {
    throw new Error(`Invalid time value: "${t}". Expected HH:MM.`);
  }
  return h + m / 60;
}

export function calculateRequestedHours(
  days: VacationRequestDayInput[]
): number {
  if (days.length === 0) {
    throw new Error("At least one day is required.");
  }
  let total = 0;
  for (const day of days) {
    if (day.isAllDay) {
      total += 8;
    } else {
      if (!day.startTime || !day.endTime) {
        throw new Error(
          "startTime and endTime are required for custom-range days."
        );
      }
      const start = parseHHMM(day.startTime);
      const end = parseHHMM(day.endTime);
      if (end <= start) {
        throw new Error(
          `endTime (${day.endTime}) must be after startTime (${day.startTime}).`
        );
      }
      // TODO: apply lunch-break deduction policy here (e.g. −0.5 h for
      // shifts ≥ 6 h) when the lab configures a break policy.
      total += end - start;
    }
  }
  return total;
}
