export type SalesPreset = "today" | "week" | "month" | "quarter" | "year" | "custom";

export const SALES_PRESETS: Array<{ key: SalesPreset; label: string }> = [
  { key: "today", label: "Today" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "year", label: "Year" },
  { key: "custom", label: "Custom" },
];

/** Route the Today sales dashboard card opens (local-day preset). */
export const TODAY_SALES_ROUTE = "/manage/reports?preset=today";

export function isSalesPreset(v: unknown): v is SalesPreset {
  return SALES_PRESETS.some((p) => p.key === v);
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

export interface SalesRange {
  dateFrom: string;
  dateTo: string;
}

/** Local inclusive bounds as ISO instants. */
export function rangeForPreset(
  preset: Exclude<SalesPreset, "custom">,
  now: Date = new Date(),
): SalesRange {
  let from: Date;
  if (preset === "today") from = startOfDay(now);
  else if (preset === "week")
    from = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)));
  else if (preset === "month") from = new Date(now.getFullYear(), now.getMonth(), 1);
  else if (preset === "quarter") from = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  else from = new Date(now.getFullYear(), 0, 1);
  return { dateFrom: from.toISOString(), dateTo: endOfDay(now).toISOString() };
}

export function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? dt : null;
}

export function customRange(
  from: string,
  to: string,
): { range: SalesRange } | { error: string } {
  const f = parseLocalDate(from);
  const t = parseLocalDate(to);
  if (!f || !t) return { error: "Enter dates as YYYY-MM-DD." };
  if (f.getTime() > t.getTime()) return { error: "Start date must be on or before end date." };
  return { range: { dateFrom: startOfDay(f).toISOString(), dateTo: endOfDay(t).toISOString() } };
}
