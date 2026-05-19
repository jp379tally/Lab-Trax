import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mail,
  Phone,
  Search,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { Invoice, Organization } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { InvoiceEditor } from "./invoices";

const today = () => new Date();

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function startOfQuarter(d: Date) {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3, 1);
}
function endOfQuarter(d: Date) {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3 + 3, 0, 23, 59, 59, 999);
}

type DateRangeKey =
  | "all"
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "last_quarter"
  | "this_year"
  | "custom";

function resolveDateRange(
  key: DateRangeKey,
  custom: { from: string; to: string }
): { from: Date | null; to: Date | null } {
  const now = today();
  switch (key) {
    case "this_month":
      return { from: startOfMonth(now), to: endOfMonth(now) };
    case "last_month": {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { from: startOfMonth(prev), to: endOfMonth(prev) };
    }
    case "this_quarter":
      return { from: startOfQuarter(now), to: endOfQuarter(now) };
    case "last_quarter": {
      const prev = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      return { from: startOfQuarter(prev), to: endOfQuarter(prev) };
    }
    case "this_year":
      return {
        from: new Date(now.getFullYear(), 0, 1),
        to: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
      };
    case "custom":
      return {
        from: custom.from ? new Date(custom.from) : null,
        to: custom.to ? new Date(custom.to) : null,
      };
    default:
      return { from: null, to: null };
  }
}

function agingDays(inv: Invoice): number | null {
  const isOpen = inv.status === "open" || inv.status === "partially_paid";
  if (!isOpen) return null;
  const due = inv.dueAt ?? inv.dueDate;
  if (!due) return null;
  const diff = Math.floor(
    (today().getTime() - new Date(due).getTime()) / 86_400_000
  );
  return diff > 0 ? diff : null;
}

const LEFT_MIN = 220;
const LEFT_MAX = 500;
const LEFT_DEFAULT = 300;

export default function CustomerCenterPage() {
  const queryClient = useQueryClient();

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: () => apiFetch<Organization[]>("/organizations"),
  });

  const openInvoicesQuery = useQuery({
    queryKey: ["invoices", { status: "open" }],
    queryFn: () => apiFetch<Invoice[]>("/invoices?status=open"),
  });

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const practiceInvoicesQuery = useQuery({
    queryKey: ["invoices", { practiceId: selectedId }],
    queryFn: () =>
      apiFetch<Invoice[]>(`/invoices?practiceId=${encodeURIComponent(selectedId!)}`),
    enabled: !!selectedId,
  });

  const [filterBy, setFilterBy] = useState<"all" | "open" | "overdue" | "paid">("all");
  const [dateRange, setDateRange] = useState<DateRangeKey>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);

  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(LEFT_DEFAULT);

  function onDividerMouseDown(e: React.MouseEvent) {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = leftWidth;
    e.preventDefault();

    function onMouseMove(ev: MouseEvent) {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      setLeftWidth(Math.min(LEFT_MAX, Math.max(LEFT_MIN, startW.current + delta)));
    }
    function onMouseUp() {
      dragging.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  const orgs = orgsQuery.data ?? [];
  const openInvoices = openInvoicesQuery.data ?? [];
  const selectedPracticeInvoices = practiceInvoicesQuery.data ?? [];

  const practiceOpenBalance = useMemo(() => {
    const map = new Map<string, number>();
    for (const inv of openInvoices) {
      const id = inv.providerOrganizationId;
      map.set(id, (map.get(id) ?? 0) + Number(inv.balanceDue ?? inv.total ?? 0));
    }
    return map;
  }, [openInvoices]);

  const practiceInvoiceCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const inv of openInvoices) {
      const id = inv.providerOrganizationId;
      map.set(id, (map.get(id) ?? 0) + 1);
    }
    return map;
  }, [openInvoices]);

  const practices = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orgs
      .filter((o) => {
        if (o.type !== "provider") return false;
        if (o.deletedAt) return false;
        if (!q) return true;
        return (
          o.name.toLowerCase().includes(q) ||
          (o.displayName || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) =>
        (a.displayName || a.name).localeCompare(b.displayName || b.name)
      );
  }, [orgs, search]);

  const selected = practices.find((p) => p.id === selectedId) ?? null;

  const { from: rangeFrom, to: rangeTo } = resolveDateRange(dateRange, {
    from: customFrom,
    to: customTo,
  });

  const practiceInvoices = useMemo(() => {
    if (!selectedId) return [];
    return selectedPracticeInvoices
      .filter((inv) => {
        if (filterBy === "open") {
          if (inv.status !== "open" && inv.status !== "partially_paid")
            return false;
        } else if (filterBy === "overdue") {
          const ag = agingDays(inv);
          if (!ag) return false;
        } else if (filterBy === "paid") {
          if (inv.status !== "paid") return false;
        }

        if (rangeFrom || rangeTo) {
          const issued = inv.issuedAt ? new Date(inv.issuedAt) : null;
          if (issued) {
            if (rangeFrom && issued < rangeFrom) return false;
            if (rangeTo && issued > rangeTo) return false;
          }
        }

        return true;
      })
      .sort((a, b) =>
        (b.issuedAt || b.createdAt || "").localeCompare(
          a.issuedAt || a.createdAt || ""
        )
      );
  }, [selectedPracticeInvoices, selectedId, filterBy, rangeFrom, rangeTo]);

  const isLoading = orgsQuery.isLoading || openInvoicesQuery.isLoading;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left pane */}
      <div
        className="shrink-0 flex flex-col border-r border-border overflow-hidden"
        style={{ width: leftWidth }}
      >
        <div className="px-4 pt-5 pb-3 border-b border-border">
          <h1 className="text-base font-semibold tracking-tight mb-3">
            Customer Center
          </h1>
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search practices…"
              className="w-full h-8 pl-8 pr-2.5 rounded-md bg-secondary text-xs focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {isLoading && (
            <div className="py-8 text-center text-muted-foreground text-xs">
              <Loader2 size={14} className="inline animate-spin mr-1.5" />
              Loading…
            </div>
          )}
          {!isLoading && practices.length === 0 && (
            <div className="py-8 text-center text-muted-foreground text-xs">
              No practices found.
            </div>
          )}
          {practices.map((p) => {
            const balance = practiceOpenBalance.get(p.id) ?? 0;
            const active = p.id === selectedId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={`w-full text-left px-4 py-2.5 border-b border-border text-sm transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-secondary/60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`font-medium truncate ${active ? "" : ""}`}
                  >
                    {p.displayName || p.name}
                  </span>
                  {balance > 0 && (
                    <span
                      className={`text-xs tabular-nums font-medium shrink-0 ${
                        active ? "text-primary-foreground/80" : "text-warning"
                      }`}
                    >
                      {formatMoney(balance)}
                    </span>
                  )}
                </div>
                {!active && (
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {practiceInvoiceCounts.get(p.id) ?? 0} invoice
                    {(practiceInvoiceCounts.get(p.id) ?? 0) !== 1 ? "s" : ""}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={onDividerMouseDown}
        className="w-1 shrink-0 cursor-col-resize hover:bg-primary/30 bg-border transition-colors select-none"
      />

      {/* Right pane */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            <div className="text-center">
              <Building2 size={32} className="mx-auto mb-3 opacity-30" />
              <p>Select a practice to view their transactions</p>
            </div>
          </div>
        ) : (
          <>
            {/* Practice header */}
            <div className="px-6 py-4 border-b border-border bg-card shrink-0">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="h-7 w-7 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <Building2 size={13} />
                    </div>
                    <h2 className="text-lg font-semibold tracking-tight">
                      {selected.displayName || selected.name}
                    </h2>
                  </div>
                  {selected.displayName && (
                    <p className="text-xs text-muted-foreground ml-9">
                      {selected.name}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
                    Open balance
                  </div>
                  <div
                    className={`text-xl font-semibold tabular-nums ${
                      (practiceOpenBalance.get(selected.id) ?? 0) > 0
                        ? "text-warning"
                        : "text-muted-foreground"
                    }`}
                  >
                    {formatMoney(practiceOpenBalance.get(selected.id) ?? 0)}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 ml-9 text-xs text-muted-foreground">
                {selected.phone && (
                  <span className="flex items-center gap-1">
                    <Phone size={11} />
                    {selected.phone}
                  </span>
                )}
                {selected.billingEmail && (
                  <span className="flex items-center gap-1">
                    <Mail size={11} />
                    {selected.billingEmail}
                  </span>
                )}
                {(selected.city || selected.state) && (
                  <span>
                    {[selected.city, selected.state].filter(Boolean).join(", ")}
                    {selected.zip ? ` ${selected.zip}` : ""}
                  </span>
                )}
                {selected.addressLine1 && (
                  <span>
                    {[selected.addressLine1, selected.addressLine2]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                )}
              </div>
            </div>

            {/* Toolbar */}
            <div className="px-6 py-2.5 border-b border-border bg-card/50 flex flex-wrap items-center gap-3 shrink-0">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-medium">Filter by:</span>
                <select
                  value={filterBy}
                  onChange={(e) => setFilterBy(e.target.value as any)}
                  className="h-7 px-2 rounded bg-secondary text-xs border-none focus:outline-none"
                >
                  <option value="all">All</option>
                  <option value="open">Open Invoices</option>
                  <option value="overdue">Overdue</option>
                  <option value="paid">Paid</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarDays size={12} />
                <select
                  value={dateRange}
                  onChange={(e) => setDateRange(e.target.value as DateRangeKey)}
                  className="h-7 px-2 rounded bg-secondary text-xs border-none focus:outline-none"
                >
                  <option value="all">All Dates</option>
                  <option value="this_month">This Month</option>
                  <option value="last_month">Last Month</option>
                  <option value="this_quarter">This Quarter</option>
                  <option value="last_quarter">Last Quarter</option>
                  <option value="this_year">This Year</option>
                  <option value="custom">Custom…</option>
                </select>
              </div>
              {dateRange === "custom" && (
                <div className="flex items-center gap-1.5 text-xs">
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="h-7 px-2 rounded bg-secondary text-xs border-none focus:outline-none"
                  />
                  <span className="text-muted-foreground">–</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="h-7 px-2 rounded bg-secondary text-xs border-none focus:outline-none"
                  />
                </div>
              )}
              <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                {practiceInvoices.length} row
                {practiceInvoices.length !== 1 ? "s" : ""}
              </span>
            </div>

            {/* Transaction table */}
            <div className="flex-1 overflow-auto scrollbar-thin">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-secondary/80 backdrop-blur-sm">
                  <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left font-medium px-5 py-2.5">Num</th>
                    <th className="text-left font-medium py-2.5">Date</th>
                    <th className="text-left font-medium py-2.5">Due Date</th>
                    <th className="text-left font-medium py-2.5">Status</th>
                    <th className="text-right font-medium py-2.5">Aging</th>
                    <th className="text-right font-medium py-2.5">Amount</th>
                    <th className="text-right font-medium px-5 py-2.5">
                      Open Balance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {practiceInvoicesQuery.isLoading && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-5 py-12 text-center text-muted-foreground"
                      >
                        <Loader2
                          size={16}
                          className="inline animate-spin mr-2"
                        />
                        Loading transactions…
                      </td>
                    </tr>
                  )}
                  {!practiceInvoicesQuery.isLoading && practiceInvoices.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-5 py-12 text-center text-muted-foreground"
                      >
                        No transactions match the current filters.
                      </td>
                    </tr>
                  )}
                  {practiceInvoices.map((inv) => {
                    const aging = agingDays(inv);
                    return (
                      <tr
                        key={inv.id}
                        onClick={() => setEditingInvoice(inv)}
                        onDoubleClick={() => setEditingInvoice(inv)}
                        className="border-t border-border cursor-pointer hover:bg-secondary/40"
                      >
                        <td className="px-5 py-2.5 font-mono text-xs">
                          {inv.invoiceNumber}
                        </td>
                        <td className="py-2.5 text-muted-foreground">
                          {formatDate(inv.issuedAt)}
                        </td>
                        <td className="py-2.5 text-muted-foreground">
                          {formatDate(inv.dueAt ?? inv.dueDate)}
                        </td>
                        <td className="py-2.5">
                          <StatusBadge status={inv.status} />
                        </td>
                        <td className="py-2.5 text-right tabular-nums">
                          {aging != null ? (
                            <span className="inline-flex items-center gap-1 text-destructive text-xs font-medium">
                              <AlertCircle size={11} />
                              {aging}d
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right tabular-nums font-medium">
                          {formatMoney(inv.total)}
                        </td>
                        <td className="px-5 py-2.5 text-right tabular-nums">
                          {Number(inv.balanceDue ?? inv.total ?? 0) > 0 ? (
                            <span className="text-warning font-medium">
                              {formatMoney(inv.balanceDue ?? inv.total)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {formatMoney(0)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {editingInvoice && (
        <InvoiceEditor
          invoice={editingInvoice}
          onClose={() => {
            setEditingInvoice(null);
            queryClient.invalidateQueries({ queryKey: ["invoices"] });
          }}
        />
      )}
    </div>
  );
}
