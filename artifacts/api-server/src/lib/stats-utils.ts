export interface CalendarDate {
  yr: number;
  mo: number;
  day: number;
}

function dateToYmd(date: Date): string {
  return (
    `${date.getUTCFullYear()}-` +
    `${String(date.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(date.getUTCDate()).padStart(2, "0")}`
  );
}

function localYmd(formatter: Intl.DateTimeFormat, date: Date): CalendarDate {
  const [yr, month, day] = formatter.format(date).split("-").map(Number);
  return { yr, mo: month - 1, day };
}

export function remakeReasonBucket(
  reason: string,
  reasonKey: string | null | undefined,
): string {
  return reasonKey === "other" ? "Other" : reason;
}

export function listExcludedBusinessDays(
  start: CalendarDate,
  endInclusive: CalendarDate,
  federal: ReadonlySet<string>,
  custom: ReadonlySet<string>,
): Array<{ date: string; reason: "holiday" | "custom" }> {
  const result: Array<{ date: string; reason: "holiday" | "custom" }> = [];
  let current = Date.UTC(start.yr, start.mo, start.day);
  const end = Date.UTC(endInclusive.yr, endInclusive.mo, endInclusive.day);
  while (current <= end) {
    const date = new Date(current);
    const weekday = date.getUTCDay();
    if (weekday >= 1 && weekday <= 5) {
      const ymd = dateToYmd(date);
      if (federal.has(ymd)) result.push({ date: ymd, reason: "holiday" });
      else if (custom.has(ymd)) result.push({ date: ymd, reason: "custom" });
    }
    current += 86_400_000;
  }
  return result;
}

export function lastCompletedBusinessDay(
  now: Date,
  formatter: Intl.DateTimeFormat,
  holidays?: ReadonlySet<string>,
): CalendarDate {
  const today = localYmd(formatter, now);
  let current = Date.UTC(today.yr, today.mo, today.day) - 86_400_000;
  for (let guard = 0; guard < 14; guard += 1) {
    const date = new Date(current);
    const weekday = date.getUTCDay();
    if (weekday >= 1 && weekday <= 5 && !holidays?.has(dateToYmd(date))) {
      return {
        yr: date.getUTCFullYear(),
        mo: date.getUTCMonth(),
        day: date.getUTCDate(),
      };
    }
    current -= 86_400_000;
  }
  const fallback = new Date(Date.UTC(today.yr, today.mo, today.day) - 86_400_000);
  return {
    yr: fallback.getUTCFullYear(),
    mo: fallback.getUTCMonth(),
    day: fallback.getUTCDate(),
  };
}

export function countBusinessDays(
  start: CalendarDate,
  endInclusive: CalendarDate,
  holidays?: ReadonlySet<string>,
): number {
  let current = Date.UTC(start.yr, start.mo, start.day);
  const end = Date.UTC(endInclusive.yr, endInclusive.mo, endInclusive.day);
  let count = 0;
  while (current <= end) {
    const date = new Date(current);
    const weekday = date.getUTCDay();
    if (weekday >= 1 && weekday <= 5 && !holidays?.has(dateToYmd(date))) {
      count += 1;
    }
    current += 86_400_000;
  }
  return count;
}

export function nthBusinessDay(
  start: CalendarDate,
  n: number,
  end?: CalendarDate,
  holidays?: ReadonlySet<string>,
): CalendarDate | null {
  if (n <= 0) return null;
  let current = Date.UTC(start.yr, start.mo, start.day);
  const endMs = end ? Date.UTC(end.yr, end.mo, end.day) : null;
  let count = 0;
  for (let guard = 0; guard < 366 * 2; guard += 1) {
    if (endMs !== null && current > endMs) return null;
    const date = new Date(current);
    const weekday = date.getUTCDay();
    if (weekday >= 1 && weekday <= 5 && !holidays?.has(dateToYmd(date))) {
      count += 1;
      if (count === n) {
        return {
          yr: date.getUTCFullYear(),
          mo: date.getUTCMonth(),
          day: date.getUTCDate(),
        };
      }
    }
    current += 86_400_000;
  }
  return null;
}
