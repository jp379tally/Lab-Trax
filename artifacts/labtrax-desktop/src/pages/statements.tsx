import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Loader2, Receipt, Search, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { Invoice } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";

interface StatementRow {
  practiceId: string;
  practiceName: string;
  invoiceCount: number;
  totalBilled: number;
  totalPaid: number;
  openBalance: number;
  overdueBalance: number;
  oldestOpen: string | null;
}

type SortKey = "practiceName" | "invoiceCount" | "totalBilled" | "totalPaid" | "openBalance" | "overdueBalance";

function isOverdue(inv: Invoice): boolean {
  if (inv.status === "paid" || inv.status === "void") return false;
  const due = inv.dueAt ?? inv.dueDate;
  if (!due) return false;
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now() && Number(inv.balanceDue ?? 0) > 0;
}

export default function StatementsPage() {
  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });

  const [search, setSearch] = useState("");
  const [agingFilter, setAgingFilter] = useState<"all" | "open" | "overdue">("all");
  const [sortKey, setSortKey] = useState<SortKey>("openBalance");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<StatementRow | null>(null);

  const invoices = invoicesQuery.data ?? [];

  const rows = useMemo<StatementRow[]>(() => {
    const map = new Map<string, StatementRow>();
    for (const inv of invoices) {
      const id = inv.providerOrganizationId;
      const name = inv.providerOrganization?.name || "Unknown practice";
      const cur = map.get(id) ?? {
        practiceId: id,
        practiceName: name,
        invoiceCount: 0,
        totalBilled: 0,
        totalPaid: 0,
        openBalance: 0,
        overdueBalance: 0,
        oldestOpen: null,
      };
      cur.practiceName = name;
      cur.invoiceCount += 1;
      const total = Number(inv.total ?? 0);
      const balance = Number(inv.balanceDue ?? 0);
      cur.totalBilled += total;
      cur.totalPaid += Math.max(0, total - balance);
      if (inv.status !== "void") cur.openBalance += balance;
      if (isOverdue(inv)) {
        cur.overdueBalance += balance;
        const issued = inv.issuedAt || inv.createdAt || null;
        if (issued && (!cur.oldestOpen || issued < cur.oldestOpen)) {
          cur.oldestOpen = issued;
        }
      }
      map.set(id, cur);
    }
    return Array.from(map.values());
  }, [invoices]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (agingFilter === "open" && r.openBalance <= 0) return false;
        if (agingFilter === "overdue" && r.overdueBalance <= 0) return false;
        if (!q) return true;
        return r.practiceName.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const va = a[sortKey];
        const vb = b[sortKey];
        if (typeof va === "number" && typeof vb === "number") {
          return sortDir === "asc" ? va - vb : vb - va;
        }
        return sortDir === "asc"
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va));
      });
  }, [rows, search, agingFilter, sortKey, sortDir]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.billed += r.totalBilled;
        acc.paid += r.totalPaid;
        acc.open += r.openBalance;
        acc.overdue += r.overdueBalance;
        return acc;
      },
      { billed: 0, paid: 0, open: 0, overdue: 0 },
    );
  }, [rows]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  }
  function SortHeader({ k, children, align = "left" }: { k: SortKey; children: React.ReactNode; align?: "left" | "right" }) {
    return (
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className={`inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground font-medium hover:text-foreground ${align === "right" ? "justify-end" : ""}`}
      >
        {children}
        {sortKey === k && (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </button>
    );
  }

  return (
    <div className="px-8 py-7">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Statements</h1>
          <p className="text-sm text-muted-foreground mt-1">
            One row per practice with billed, paid, and open balance rolled up.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <Stat label="Total billed" value={formatMoney(totals.billed)} tone="neutral" />
        <Stat label="Collected" value={formatMoney(totals.paid)} tone="success" />
        <Stat label="Open balance" value={formatMoney(totals.open)} tone="primary" />
        <Stat label="Overdue" value={formatMoney(totals.overdue)} tone={totals.overdue > 0 ? "warning" : "neutral"} />
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search practice…"
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
          <select
            value={agingFilter}
            onChange={(e) => setAgingFilter(e.target.value as "all" | "open" | "overdue")}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            <option value="all">All practices</option>
            <option value="open">With open balance</option>
            <option value="overdue">Overdue only</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40">
                <th className="text-left px-5 py-2.5"><SortHeader k="practiceName">Practice</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="invoiceCount" align="right">Invoices</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="totalBilled" align="right">Billed</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="totalPaid" align="right">Paid</SortHeader></th>
                <th className="text-right py-2.5"><SortHeader k="openBalance" align="right">Open balance</SortHeader></th>
                <th className="text-right px-5 py-2.5"><SortHeader k="overdueBalance" align="right">Overdue</SortHeader></th>
              </tr>
            </thead>
            <tbody>
              {invoicesQuery.isLoading && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading statements…
                  </td>
                </tr>
              )}
              {invoicesQuery.error && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-destructive">{(invoicesQuery.error as Error).message}</td>
                </tr>
              )}
              {!invoicesQuery.isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground">
                    No statements match the current filters.
                  </td>
                </tr>
              )}
              {filtered.map((r) => (
                <tr
                  key={r.practiceId}
                  onClick={() => setSelected(r)}
                  className="border-t border-border cursor-pointer hover:bg-secondary/40"
                >
                  <td className="px-5 py-3 font-medium">{r.practiceName}</td>
                  <td className="py-3 text-right tabular-nums">{r.invoiceCount}</td>
                  <td className="py-3 text-right tabular-nums">{formatMoney(r.totalBilled)}</td>
                  <td className="py-3 text-right tabular-nums text-success">{formatMoney(r.totalPaid)}</td>
                  <td className="py-3 text-right tabular-nums font-medium">{formatMoney(r.openBalance)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {r.overdueBalance > 0 ? (
                      <span className="text-destructive font-medium">{formatMoney(r.overdueBalance)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <StatementDrawer
          row={selected}
          invoices={invoices.filter((i) => i.providerOrganizationId === selected.practiceId)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "primary" | "success" | "warning" | "neutral" }) {
  const cls =
    tone === "success"
      ? "bg-success/15 text-success"
      : tone === "warning"
        ? "bg-warning/20 text-warning"
        : tone === "primary"
          ? "bg-primary/10 text-primary"
          : "bg-secondary text-foreground";
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
          <div className="mt-1.5 text-xl font-semibold tabular-nums">{value}</div>
        </div>
        <div className={`h-8 w-8 rounded-md flex items-center justify-center ${cls}`}>
          <Receipt size={14} />
        </div>
      </div>
    </div>
  );
}

function StatementDrawer({ row, invoices, onClose }: { row: StatementRow; invoices: Invoice[]; onClose: () => void }) {
  const sorted = [...invoices].sort((a, b) => (b.issuedAt || b.createdAt || "").localeCompare(a.issuedAt || a.createdAt || ""));
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30" onClick={onClose} />
      <aside className="w-full max-w-[640px] bg-card border-l border-border h-full flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground">Statement</div>
            <div className="text-sm font-semibold">{row.practiceName}</div>
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center">
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Billed" value={formatMoney(row.totalBilled)} tone="neutral" />
            <Stat label="Open" value={formatMoney(row.openBalance)} tone="primary" />
            <Stat label="Paid" value={formatMoney(row.totalPaid)} tone="success" />
            <Stat label="Overdue" value={formatMoney(row.overdueBalance)} tone={row.overdueBalance > 0 ? "warning" : "neutral"} />
          </div>
          <section>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">Invoices</h3>
            <div className="border border-border rounded-md divide-y divide-border">
              {sorted.map((i) => (
                <div key={i.id} className="px-3 py-2 flex items-center justify-between text-sm">
                  <div className="min-w-0">
                    <div className="font-mono text-xs">{i.invoiceNumber}</div>
                    <div className="text-xs text-muted-foreground">
                      Issued {formatDate(i.issuedAt)} · Due {formatDate(i.dueAt ?? i.dueDate)}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusBadge status={i.status} />
                    <div className="text-right">
                      <div className="font-medium tabular-nums">{formatMoney(i.total)}</div>
                      {Number(i.balanceDue ?? 0) > 0 && (
                        <div className="text-xs text-muted-foreground tabular-nums">
                          {formatMoney(i.balanceDue)} open
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {sorted.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">No invoices.</div>
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
