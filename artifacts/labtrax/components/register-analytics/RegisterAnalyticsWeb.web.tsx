import React, { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "@/lib/theme-context";
import { getJson } from "@/lib/read-api";
import { formatMoney } from "@/lib/format";
import type { RegisterAnalytics } from "@workspace/api-client-react";
import { dailyBars, periodLabel, rankPayees, statusSegments } from "./registerAnalyticsModel";

const GREEN = "#0f9d6b";
const BLUE = "#2f6fe4";
const PANEL_BG = "#fbfcfd";

function ymd(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function defaults() {
  const n = new Date();
  return { from: ymd(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 29)), to: ymd(n) };
}
function valid(f: string, t: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t) || f > t) return false;
  if ([f, t].some((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== v;
  })) return false;
  return (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86400000 + 1 <= 366;
}
const money = (v: string) => formatMoney(Number(v));

export function RegisterAnalyticsWeb({ organizationId, accountId }: { organizationId: string; accountId: string }) {
  const { colors } = useTheme();
  const d = defaults();
  const [from, setFrom] = useState(d.from);
  const [to, setTo] = useState(d.to);
  const [active, setActive] = useState<string | null>(null);
  const [showDaily, setShowDaily] = useState(false);
  const ok = valid(from, to);
  const q = useQuery<RegisterAnalytics>({
    queryKey: ["bank-transactions", "analytics", organizationId, accountId, from, to],
    enabled: ok,
    queryFn: () =>
      getJson<RegisterAnalytics>(
        `/api/finance/register-analytics?${new URLSearchParams({ organizationId, bankAccountId: accountId, dateFrom: from, dateTo: to })}`,
      ),
  });
  const period = periodLabel(from, to);
  const txt = { color: colors.text, fontSize: 13 } as const;
  const muted = { color: colors.textSecondary, fontSize: 12 } as const;
  const panel = { marginHorizontal: 16, marginBottom: 12, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: PANEL_BG, minWidth: 0, maxWidth: "100%" } as const;
  const input = { ...txt, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 8, minWidth: 120, minHeight: 44, backgroundColor: "#fff" } as const;
  const data = q.data;
  const wellFormed = !!data && Array.isArray(data.daily) && Array.isArray(data.payees) && !!data.statuses && typeof data.totalEntries === "number";

  function gate(): React.ReactNode | null {
    if (!ok) return <Text style={txt}>Choose a valid range: start on or before end, at most 366 days.</Text>;
    if (q.isLoading) return <Text style={txt} accessibilityLabel="Loading analytics">Loading analytics...</Text>;
    if (q.isError || (data && !wellFormed))
      return (
        <Pressable onPress={() => q.refetch()} accessibilityRole="button" style={{ minHeight: 44, justifyContent: "center" }}>
          <Text style={{ ...txt, color: colors.error }}>Unable to load analytics. Tap to retry.</Text>
        </Pressable>
      );
    if (!data || data.totalEntries === 0) return <Text style={txt}>No entries in {period}.</Text>;
    return null;
  }
  const blocked = gate();
  const ready = !blocked && wellFormed ? data! : null;

  const bars = ready ? dailyBars(ready.daily) : [];
  const sel = bars.find((b) => b.date === active);
  const ranked = ready ? rankPayees(ready.payees) : [];
  const topVolume = Math.max(0, ...ranked.map((p) => Number(p.volume)));
  const seg = ready ? statusSegments(ready.statuses) : null;
  const n = bars.length;
  const slot = 10; // viewBox units per day: every day gets its own slot, so no bucket is clipped
  const H = 100;

  return (
    <View testID="register-analytics-web" style={{ minWidth: 0, maxWidth: "100%" }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, alignItems: "center" }}>
        <Text style={{ ...txt, fontWeight: "600" }}>Analytics period</Text>
        <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} style={{ ...input, borderStyle: "solid", maxWidth: "100%" }} aria-label="Analytics from" />
        <input type="date" value={to} onChange={(event) => setTo(event.target.value)} style={{ ...input, borderStyle: "solid", maxWidth: "100%" }} aria-label="Analytics to" />
      </View>

      <Text style={{ ...muted, marginHorizontal: 16, marginBottom: 10 }}>Independent of list filters. UTC calendar days; transfers excluded from money movement.</Text>
      <View style={panel} testID="analytics-panel-cash-flow">
        <Text style={{ ...txt, fontWeight: "700", marginBottom: 8 }}>Cash flow, {period}</Text>
        {blocked ?? (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", gap: 16 }}>
              <Text style={muted}><Text style={{ color: GREEN }}>{"\u25A0"}</Text> Deposits</Text>
              <Text style={muted}><Text style={{ color: BLUE }}>{"\u25A0"}</Text> Payments</Text>
            </View>
            <svg viewBox={`0 0 ${Math.max(n, 1) * slot} ${H}`} preserveAspectRatio="none" role="group" aria-label={`Daily deposits and payments, ${period}`} style={{ width: "100%", height: 120, display: "block" }}>
              {bars.map((b, i) => {
                const x = i * slot;
                const dh = Math.max(b.depositRatio * H, Number(b.deposits) > 0 ? 1 : 0);
                const ph = Math.max(b.paymentRatio * H, Number(b.payments) > 0 ? 1 : 0);
                return (
                  <g key={b.date} onClick={() => setActive(b.date)} style={{ cursor: "pointer" }} role="button" aria-label={`${b.date}: deposits ${money(b.deposits)}, payments ${money(b.payments)}`}>
                    <rect x={x} y={0} width={slot} height={H} fill={active === b.date ? "#e7eef9" : "transparent"} />
                    <rect x={x + 1} y={H - dh} width={4} height={dh} fill={GREEN} />
                    <rect x={x + 5} y={H - ph} width={4} height={ph} fill={BLUE} />
                  </g>
                );
              })}
            </svg>
            <Text style={txt} testID="analytics-selected-day">
              {sel ? `${sel.date}: deposits ${money(sel.deposits)}, payments ${money(sel.payments)}` : "Tap a day for its exact deposits and payments."}
            </Text>
            <Pressable onPress={() => setShowDaily((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: showDaily }} style={{ minHeight: 44, justifyContent: "center" }}>
              <Text style={{ ...txt, color: colors.tint, fontWeight: "600" }}>{showDaily ? "Hide daily details" : `Show daily details (${n} days)`}</Text>
            </Pressable>
            {showDaily && (
              <View style={{ maxHeight: 240, overflow: "scroll" as never }} testID="analytics-daily-details">
                {bars.map((b) => (
                  <View key={b.date} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border, gap: 8 }}>
                    <Text style={txt}>{b.date}</Text>
                    <Text style={{ ...txt, color: GREEN }}>{money(b.deposits)}</Text>
                    <Text style={{ ...txt, color: BLUE }}>{money(b.payments)}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </View>

      <View style={panel} testID="analytics-panel-top-payees">
        <Text style={{ ...txt, fontWeight: "700", marginBottom: 8 }}>Top 5 payees by posted volume (payments + deposits), {period}</Text>
        {blocked ?? (ranked.length === 0 ? <Text style={txt}>No payees in {period}.</Text> : (
          <View style={{ gap: 10 }}>
            {ranked.map((p, i) => (
              <View key={p.payee} style={{ gap: 3 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                  <Text style={{ ...txt, flexShrink: 1 }} numberOfLines={1}>{i + 1}. {p.payee}</Text>
                  <Text style={{ ...txt, fontWeight: "700" }}>{money(p.volume)}</Text>
                </View>
                <View style={{ height: 8, borderRadius: 4, backgroundColor: colors.surfaceAlt }}>
                  <View style={{ height: 8, borderRadius: 4, backgroundColor: BLUE, width: `${topVolume > 0 ? (Number(p.volume) / topVolume) * 100 : 0}%` }} />
                </View>
                <Text style={muted}>Deposits {money(p.deposits)} / Payments {money(p.payments)}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>

      <View style={panel} testID="analytics-panel-status">
        <Text style={{ ...txt, fontWeight: "700", marginBottom: 8 }}>Account status, {period}</Text>
        {blocked ?? (seg && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
            <View style={{ width: 120, height: 120 }}>
              <svg viewBox="0 0 42 42" width={120} height={120} role="img" aria-label={`${seg.total} entries by status`}>
                <circle cx={21} cy={21} r={15.915} fill="none" stroke="#e4e8ee" strokeWidth={6} />
                {seg.rows.filter((r) => r.count > 0).map((r) => (
                  <circle key={r.key} cx={21} cy={21} r={15.915} fill="none" stroke={r.color} strokeWidth={6}
                    strokeDasharray={`${r.fraction * 100} ${100 - r.fraction * 100}`} strokeDashoffset={25 - r.offset * 100} />
                ))}
                <text x={21} y={22} textAnchor="middle" fontSize={7} fontWeight={700} fill={colors.text}>{seg.total}</text>
                <text x={21} y={28} textAnchor="middle" fontSize={3.2} fill={colors.textSecondary}>Entries</text>
              </svg>
            </View>
            <View style={{ flex: 1, minWidth: 180, gap: 6 }}>
              {seg.rows.map((r) => (
                <View key={r.key} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: r.color }} />
                  <Text style={{ ...txt, flex: 1 }}>{r.label}</Text>
                  <Text style={{ ...txt, fontWeight: "700" }}>{r.count}</Text>
                  <Text style={{ ...muted, width: 52, textAlign: "right" }}>{r.percent}</Text>
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
