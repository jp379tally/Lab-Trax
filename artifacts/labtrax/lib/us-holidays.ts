/**
 * Mobile mirror of the desktop us-holidays.ts — resolves a "YYYY-MM-DD"
 * date back to a human-readable US federal holiday name.
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
 * because Saturday is already a non-working day.
 */
function observed(yr: number, mo1: number, day: number): string | null {
  const d = new Date(Date.UTC(yr, mo1 - 1, day));
  const dow = d.getUTCDay();
  if (dow === 6) return null;                        // Sat → omit
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1); // Sun → Mon
  return dateToYmd(d);
}

function nthWeekday(yr: number, mo1: number, n: number, weekday: number): string {
  const first = new Date(Date.UTC(yr, mo1 - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return dateToYmd(new Date(Date.UTC(yr, mo1 - 1, day)));
}

function lastWeekday(yr: number, mo1: number, weekday: number): string {
  const last = new Date(Date.UTC(yr, mo1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  const day = last.getUTCDate() - offset;
  return dateToYmd(new Date(Date.UTC(yr, mo1 - 1, day)));
}

/**
 * Returns a Map of "YYYY-MM-DD" → holiday name for all US federal holidays
 * across the given calendar years. Saturday holidays are omitted (no entry
 * added); Sunday holidays shift to Monday.
 */
export function usHolidayNameMap(years: number[]): Map<string, string> {
  const out = new Map<string, string>();
  const add = (date: string | null, name: string) => {
    if (date !== null) out.set(date, name);
  };
  for (const yr of years) {
    add(observed(yr, 1, 1),        "New Year's Day");
    add(nthWeekday(yr, 1, 3, 1),   "MLK Jr. Day");
    add(nthWeekday(yr, 2, 3, 1),   "Presidents' Day");
    add(lastWeekday(yr, 5, 1),     "Memorial Day");
    add(observed(yr, 6, 19),       "Juneteenth");
    add(observed(yr, 7, 4),        "Independence Day");
    add(nthWeekday(yr, 9, 1, 1),   "Labor Day");
    add(nthWeekday(yr, 10, 2, 1),  "Columbus Day");
    add(observed(yr, 11, 11),      "Veterans Day");
    add(nthWeekday(yr, 11, 4, 4),  "Thanksgiving Day");
    add(observed(yr, 12, 25),      "Christmas Day");
  }
  return out;
}

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  timeZone: "UTC",
});

/** Format a "YYYY-MM-DD" string as "MM/DD" (e.g. "07/04"). */
export function formatExcludedDate(ymd: string): string {
  const [yr, mo, dy] = ymd.split("-").map(Number);
  return DATE_FMT.format(new Date(Date.UTC(yr, mo - 1, dy)));
}
