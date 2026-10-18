/**
 * US Federal Holiday calendar.
 *
 * Returns a Set of "YYYY-MM-DD" strings representing the *observed* date of
 * each US federal holiday for the requested calendar years. Observance rules:
 *   - Holiday on Saturday → omitted (Saturday is already a non-working day;
 *     no federal observance is gained or lost — the lab simply does not work
 *     that day regardless)
 *   - Holiday on Sunday  → observed Monday
 *
 * Federal holidays included (up to 11 per year):
 *   New Year's Day, MLK Jr. Day, Presidents' Day (Washington's Birthday),
 *   Memorial Day, Juneteenth, Independence Day, Labor Day, Columbus Day,
 *   Veterans Day, Thanksgiving Day, Christmas Day.
 */

function dateToYmd(d: Date): string {
  return (
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")}`
  );
}

/**
 * Applies Sun→Mon observance. Saturday holidays are omitted (return null)
 * because Saturday is already a non-working day — no weekday is lost.
 */
function observed(yr: number, mo1: number, day: number): string | null {
  const d = new Date(Date.UTC(yr, mo1 - 1, day));
  const dow = d.getUTCDay();
  if (dow === 6) return null;                        // Sat → omit
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1); // Sun → Mon
  return dateToYmd(d);
}

/**
 * Nth occurrence of a weekday (0=Sun … 6=Sat) in the given month.
 * E.g. nthWeekday(2026, 1, 3, 1) = 3rd Monday of January 2026.
 */
function nthWeekday(yr: number, mo1: number, n: number, weekday: number): string {
  const first = new Date(Date.UTC(yr, mo1 - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return dateToYmd(new Date(Date.UTC(yr, mo1 - 1, day)));
}

/**
 * Last occurrence of a weekday in the given month.
 * E.g. lastWeekday(2026, 5, 1) = last Monday of May 2026.
 */
function lastWeekday(yr: number, mo1: number, weekday: number): string {
  const last = new Date(Date.UTC(yr, mo1, 0)); // last day of month
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  const day = last.getUTCDate() - offset;
  return dateToYmd(new Date(Date.UTC(yr, mo1 - 1, day)));
}

/**
 * Returns a Set of "YYYY-MM-DD" observed dates for all US federal holidays in
 * the given year. Saturday holidays are omitted (no Friday shift); Sunday
 * holidays shift to Monday.
 */
export function usHolidaysForYear(yr: number): Set<string> {
  return new Set<string>(
    [
      observed(yr, 1, 1),           // New Year's Day
      nthWeekday(yr, 1, 3, 1),      // MLK Jr. Day — 3rd Monday of January
      nthWeekday(yr, 2, 3, 1),      // Presidents' Day — 3rd Monday of February
      lastWeekday(yr, 5, 1),        // Memorial Day — last Monday of May
      observed(yr, 6, 19),          // Juneteenth — June 19
      observed(yr, 7, 4),           // Independence Day — July 4
      nthWeekday(yr, 9, 1, 1),      // Labor Day — 1st Monday of September
      nthWeekday(yr, 10, 2, 1),     // Columbus Day — 2nd Monday of October
      observed(yr, 11, 11),         // Veterans Day — November 11
      nthWeekday(yr, 11, 4, 4),     // Thanksgiving — 4th Thursday of November
      observed(yr, 12, 25),         // Christmas Day — December 25
    ].filter((d): d is string => d !== null),
  );
}

/**
 * Returns a Set of "YYYY-MM-DD" observed US federal holiday dates covering
 * all of the requested years.
 */
export function usHolidaySet(years: number[]): Set<string> {
  const out = new Set<string>();
  for (const yr of years) {
    for (const d of usHolidaysForYear(yr)) {
      out.add(d);
    }
  }
  return out;
}
