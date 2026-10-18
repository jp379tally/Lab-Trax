import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiFetch } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import {
  analyticsQueryString,
  defaultAnalyticsRange,
  isValidRange,
  num,
  statusSlices,
  type RegisterAnalyticsData,
} from "@/lib/register-analytics";

const SLICE_COLORS: Record<string, string> = {
  cleared: "#0f9d6b",
  uncleared: "#e08a1e",
  voided: "#6b7280",
  pending: "#c3cad4",
};

function PanelShell({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section data-testid={testId} aria-label={title} className="bg-card border border-border rounded-xl p-4 min-w-0">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      {children}
    </section>
  );
}

export function RegisterAnalyticsPanels({ organizationId, accountId }: { organizationId: string; accountId: string }) {
  const initial = defaultAnalyticsRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [showDaily, setShowDaily] = useState(false);
  const valid = isValidRange(from, to);
  const query = useQuery({
    queryKey: ["finance", "register-analytics", organizationId, accountId, from, to],
    enabled: valid,
    queryFn: () =>
      apiFetch<RegisterAnalyticsData>(
        `/finance/register-analytics?${analyticsQueryString({ organizationId, accountId, from, to })}`,
      ),
  });
  const raw = query.data;
  const wellFormed = !!raw && !!raw.statuses && Array.isArray(raw.daily) && typeof raw.totalEntries === "number";
  const data = wellFormed ? raw : undefined;
  const loading = valid && query.isLoading;
  const failed = valid && (query.isError || (!!raw && !wellFormed));
  const empty = !!data && data.totalEntries === 0;
  const ready = !!data && !empty && !failed;

  const daily = (data?.daily ?? []).map((d) => ({ date: d.date.slice(5), deposits: num(d.deposits), payments: num(d.payments), rawD: d.deposits, rawP: d.payments }));
  const payees = (data?.payees ?? []).slice(0, 5);
  const maxVol = Math.max(1, ...payees.map((p) => num(p.volume)));
  const slices = data ? statusSlices(data.statuses) : [];

  function state(h = "h-48") {
    if (!valid) return <p className="text-sm text-muted-foreground">Choose a valid range: start on or before end, at most 366 days.</p>;
    if (loading) return <div className={`${h} rounded-md bg-secondary animate-pulse`} aria-label="Loading analytics" />;
    if (failed)
      return (
        <div className="text-sm text-destructive flex items-center gap-3" role="alert">
          Unable to load analytics.
          <button type="button" onClick={() => void query.refetch()} className="h-8 px-3 rounded-md bg-secondary text-foreground text-xs font-medium">Retry</button>
        </div>
      );
    if (empty) return <p className="text-sm text-muted-foreground">No entries in this date range.</p>;
    return null;
  }
  const placeholder = state();

  return (
    <div className="space-y-2" data-testid="register-analytics">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Analytics range</span>
        <input type="date" aria-label="Analytics from" data-testid="analytics-from" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 px-2 rounded-md bg-secondary text-sm" />
        <span>to</span>
        <input type="date" aria-label="Analytics to" data-testid="analytics-to" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 px-2 rounded-md bg-secondary text-sm" />
        <button type="button" onClick={() => { const r = defaultAnalyticsRange(); setFrom(r.from); setTo(r.to); }} className="h-8 px-2 rounded-md hover:bg-secondary text-xs font-medium">Last 30 days</button>
        <span>Independent of the list filters below. Daily buckets use UTC; money movement excludes transfers.</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr_0.8fr] gap-3">
        <PanelShell title={`Cash flow, ${from} to ${to}`} testId="panel-cash-flow">
          {placeholder ?? (
            <>
              <div className="flex flex-wrap gap-4 text-xs mb-2" aria-label="Cash flow legend">
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#0f9d6b]" />Deposits</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#2f6fe4]" />Payments</span>
              </div>
              <div className="h-48" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={daily}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 10 }} width={48} />
                    <Tooltip formatter={(v: number) => formatMoney(v)} />
                    <Bar dataKey="deposits" name="Deposits" fill="#0f9d6b" />
                    <Bar dataKey="payments" name="Payments" fill="#2f6fe4" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <button type="button" data-testid="toggle-daily-details" aria-expanded={showDaily} onClick={() => setShowDaily((v) => !v)} className="mt-2 h-9 px-3 rounded-md bg-secondary text-xs font-medium">
                {showDaily ? "Hide daily details" : "Show daily details"}
              </button>
              {showDaily && (
                <div className="mt-2 max-h-48 overflow-y-auto">
                  <table className="w-full text-xs" data-testid="cash-flow-values">
                    <caption className="sr-only">Daily deposits and payments</caption>
                    <thead><tr className="text-left text-muted-foreground"><th className="py-1">Date</th><th className="text-right">Deposits</th><th className="text-right">Payments</th></tr></thead>
                    <tbody>
                      {(data?.daily ?? []).map((d) => (
                        <tr key={d.date} className="border-t border-border/40"><td className="py-1">{d.date}</td><td className="text-right tabular-nums">{formatMoney(num(d.deposits))}</td><td className="text-right tabular-nums">{formatMoney(num(d.payments))}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </PanelShell>
        <PanelShell title={`Top 5 payees by posted volume (payments + deposits), ${from} to ${to}`} testId="panel-top-payees">
          {placeholder ?? (
            ready && payees.length === 0 ? <p className="text-sm text-muted-foreground">No payees in this range.</p> : (
              <ul className="space-y-2">
                {payees.map((p) => (
                  <li key={p.payee}>
                    <div className="flex flex-wrap justify-between text-xs gap-2"><span className="min-w-0 break-words">{p.payee}</span><span className="tabular-nums font-medium">{formatMoney(num(p.volume))}</span></div>
                    <div className="text-[11px] text-muted-foreground tabular-nums">Deposits {formatMoney(num(p.deposits))} / Payments {formatMoney(num(p.payments))}</div>
                    <div className="h-2 rounded-full bg-secondary"><div className="h-2 rounded-full bg-[#2f6fe4]" style={{ width: `${(num(p.volume) / maxVol) * 100}%` }} /></div>
                  </li>
                ))}
              </ul>
            )
          )}
        </PanelShell>
        <PanelShell title={`Account status, ${from} to ${to}`} testId="panel-status">
          {placeholder ?? (
            <div className="flex flex-col items-center gap-3">
              <div className="relative w-28 max-w-full h-28 shrink-0" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={slices} dataKey="value" innerRadius="62%" outerRadius="93%" stroke="none">
                      {slices.map((s) => <Cell key={s.key} fill={SLICE_COLORS[s.key]} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center"><span className="text-lg font-semibold">{data?.totalEntries}</span><span className="text-[10px] text-muted-foreground">Entries</span></div>
              </div>
              <ul className="text-xs space-y-1 w-full min-w-0">
                {slices.map((s) => (
                  <li key={s.key} className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="w-2 h-2 rounded-full" style={{ background: SLICE_COLORS[s.key] }} /><span className="flex-1">{s.label}</span><span className="tabular-nums font-medium">{s.value}</span><span className="tabular-nums text-muted-foreground w-12 text-right">{s.pct}</span></li>
                ))}
              </ul>
            </div>
          )}
        </PanelShell>
      </div>
    </div>
  );
}
