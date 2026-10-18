import type { RegisterAnalytics } from "@workspace/api-client-react";
export type RegisterAnalyticsData = RegisterAnalytics;
export const MAX_RANGE_DAYS = 366;

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Last 30 calendar days inclusive of today (local time). */
export function defaultAnalyticsRange(now: Date = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
  return { from: ymd(start), to: ymd(now) };
}

export function isValidRange(from: string, to: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return false;
  if ([from, to].some((value) => {
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value;
  })) return false;
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  return Number.isFinite(days) && days <= MAX_RANGE_DAYS;
}

export function analyticsQueryString(p: { organizationId: string; accountId: string; from: string; to: string }): string {
  const sp = new URLSearchParams({
    organizationId: p.organizationId,
    bankAccountId: p.accountId,
    dateFrom: p.from,
    dateTo: p.to,
  });
  return sp.toString();
}

export function statusSlices(s: RegisterAnalyticsData["statuses"]) {
  const total = s.postedCleared + s.postedUncleared + s.voided + s.pending;
  const pct = (n: number) => (total ? `${((n / total) * 100).toFixed(1)}%` : "0.0%");
  return [
    { key: "cleared", label: "Cleared", value: s.postedCleared, pct: pct(s.postedCleared) },
    { key: "uncleared", label: "Uncleared", value: s.postedUncleared, pct: pct(s.postedUncleared) },
    { key: "voided", label: "Voided", value: s.voided, pct: pct(s.voided) },
    { key: "pending", label: "Pending", value: s.pending, pct: pct(s.pending) },
  ];
}

/** Aggregation-safe money parse for chart geometry only; display uses the raw strings. */
export function num(v: string | number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
