import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingDown, TrendingUp } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { formatMoney } from "@/lib/format";

type CashFlow = {
  from: string;
  to: string;
  revenue: string;
  expenses: string;
  projectedRevenue: string;
  projectedExpenses: string;
  net: string;
  startingBalance: string;
  endingBalance: string;
  categoryBreakdown: Array<{
    bucketKey: string;
    categoryId: string | null;
    name: string;
    income: string;
    expense: string;
    net: string;
  }>;
};

const RANGES = [
  { value: "current_month", label: "Current month" },
  { value: "prior_month", label: "Prior month" },
  { value: "next_30", label: "Next 30 days" },
  { value: "next_60", label: "Next 60 days" },
  { value: "next_90", label: "Next 90 days" },
];

export default function CashFlowPage() {
  return (
    <FinanceShell>
      {({ organizationId, accountId }) => (
        <CashFlow organizationId={organizationId} accountId={accountId} />
      )}
    </FinanceShell>
  );
}

function CashFlow({
  organizationId,
  accountId,
}: {
  organizationId: string;
  accountId: string | null;
}) {
  const [range, setRange] = useState("current_month");
  const [scope, setScope] = useState<"all" | "account">("all");

  const params = new URLSearchParams({ organizationId, range });
  if (scope === "account" && accountId) params.set("bankAccountId", accountId);

  const cf = useQuery({
    queryKey: ["finance", "cashflow", params.toString()],
    queryFn: () => apiFetch<CashFlow>(`/finance/cashflow?${params.toString()}`),
  });

  const data = cf.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={range}
          onChange={(e) => setRange(e.target.value)}
          className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
        >
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as any)}
          className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
        >
          <option value="all">All accounts</option>
          <option value="account" disabled={!accountId}>
            Selected account
          </option>
        </select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card label="Revenue (posted)" value={data?.revenue} positive />
        <Card label="Expenses (posted)" value={data?.expenses} negative />
        <Card label="Projected revenue" value={data?.projectedRevenue} muted positive />
        <Card label="Projected expenses" value={data?.projectedExpenses} muted negative />
        <Card label="Starting balance" value={data?.startingBalance} />
        <Card label="Net change" value={data?.net} positive={Number(data?.net || 0) >= 0} />
        <Card label="Ending balance (projected)" value={data?.endingBalance} highlight />
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-sm font-semibold">
          By category
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="text-left font-medium px-4 py-2">Category</th>
                <th className="text-right font-medium py-2">Income</th>
                <th className="text-right font-medium py-2">Expense</th>
                <th className="text-right font-medium px-4 py-2">Net</th>
              </tr>
            </thead>
            <tbody>
              {(data?.categoryBreakdown || [])
                .sort((a, b) => Math.abs(Number(b.net)) - Math.abs(Number(a.net)))
                .map((c) => {
                  const net = Number(c.net);
                  return (
                    <tr key={c.bucketKey} className="border-t border-border">
                      <td className="px-4 py-2.5">{c.name}</td>
                      <td className="py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {Number(c.income) > 0 ? formatMoney(c.income) : ""}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {Number(c.expense) > 0 ? formatMoney(c.expense) : ""}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right tabular-nums font-medium ${
                          net >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-foreground"
                        }`}
                      >
                        {formatMoney(net)}
                      </td>
                    </tr>
                  );
                })}
              {!data?.categoryBreakdown?.length && (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">
                    No activity in the selected range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  positive,
  negative,
  muted,
  highlight,
}: {
  label: string;
  value?: string | null;
  positive?: boolean;
  negative?: boolean;
  muted?: boolean;
  highlight?: boolean;
}) {
  const Icon = positive ? TrendingUp : negative ? TrendingDown : null;
  const tone = highlight
    ? "bg-primary/10 border-primary/30"
    : "bg-card border-border";
  const valueColor = positive
    ? "text-emerald-600 dark:text-emerald-400"
    : negative
    ? "text-foreground"
    : "text-foreground";
  return (
    <div className={`border rounded-xl px-4 py-3 ${tone} ${muted ? "opacity-80" : ""}`}>
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
        <span>{label}</span>
        {Icon && <Icon size={12} />}
      </div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${valueColor}`}>
        {formatMoney(value ?? 0)}
      </div>
    </div>
  );
}
