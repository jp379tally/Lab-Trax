import type { RegisterAnalytics } from "@workspace/api-client-react";

export function periodLabel(from: string, to: string): string {
  return `${from} to ${to}`;
}

/** Ranked by combined posted volume (payments + deposits); server volume is authoritative. */
export function rankPayees(payees: RegisterAnalytics["payees"], limit = 5) {
  return [...payees]
    .sort((a, b) => Number(b.volume) - Number(a.volume) || a.payee.localeCompare(b.payee))
    .slice(0, limit);
}

export function dailyBars(daily: RegisterAnalytics["daily"]) {
  const max = Math.max(0, ...daily.flatMap((d) => [Number(d.deposits), Number(d.payments)]));
  return daily.map((d) => ({
    date: d.date,
    deposits: d.deposits,
    payments: d.payments,
    depositRatio: max > 0 ? Number(d.deposits) / max : 0,
    paymentRatio: max > 0 ? Number(d.payments) / max : 0,
  }));
}

export function statusSegments(s: RegisterAnalytics["statuses"]) {
  const rows = [
    { key: "cleared", label: "Cleared", count: s.postedCleared, color: "#0f9d6b" },
    { key: "uncleared", label: "Uncleared", count: s.postedUncleared, color: "#e08a1e" },
    { key: "voided", label: "Voided", count: s.voided, color: "#6b7280" },
    { key: "pending", label: "Pending", count: s.pending, color: "#b6bec9" },
  ];
  const total = rows.reduce((a, r) => a + r.count, 0);
  let acc = 0;
  return {
    total,
    rows: rows.map((r) => {
      const fraction = total ? r.count / total : 0;
      const seg = { ...r, fraction, percent: `${(fraction * 100).toFixed(1)}%`, offset: acc };
      acc += fraction;
      return seg;
    }),
  };
}
