import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRightLeft,
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileDown,
  Loader2,
  Mail,
  Phone,
  Search,
} from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { Invoice, Organization } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { InvoiceEditor } from "./invoices";
import { downloadStatementPdf } from "@/lib/export";

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
  const { user } = useAuth();

  const isAdmin =
    user?.role === "owner" ||
    user?.role === "admin";

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

  // Bulk reassign dialog state
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignTargetId, setReassignTargetId] = useState<string>("");
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [reassignSuccess, setReassignSuccess] = useState<string | null>(null);

  const reassignMutation = useMutation({
    mutationFn: async ({
      labOrganizationId,
      fromProviderOrganizationId,
      toProviderOrganizationId,
    }: {
      labOrganizationId: string;
      fromProviderOrganizationId: string;
      toProviderOrganizationId: string;
    }) => {
      return apiFetch<{ movedCount: number }>("/invoices/bulk-reassign", {
        method: "POST",
        body: JSON.stringify({
          labOrganizationId,
          fromProviderOrganizationId,
          toProviderOrganizationId,
        }),
      });
    },
    onSuccess: (data) => {
      setReassignSuccess(
        data.movedCount === 0
          ? "No invoices to move."
          : `Moved ${data.movedCount} invoice${data.movedCount !== 1 ? "s" : ""} successfully.`,
      );
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (err) => {
      setReassignError(
        err instanceof ApiError ? err.message : "Reassignment failed.",
      );
    },
  });

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

  const labOrgId = useMemo(
    () => orgs.find((o) => o.type === "lab")?.id ?? "",
    [orgs],
  );

  const nonVoidedCount = useMemo(
    () => selectedPracticeInvoices.filter((inv) => inv.status !== "void").length,
    [selectedPracticeInvoices],
  );

  // All practices other than the selected one — target options for reassignment
  const otherPractices = useMemo(
    () =>
      orgs
        .filter(
          (o) =>
            o.type === "provider" &&
            !o.deletedAt &&
            o.id !== selectedId,
        )
        .sort((a, b) =>
          (a.displayName || a.name).localeCompare(b.displayName || b.name),
        ),
    [orgs, selectedId],
  );

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

  function handleExportStatementPdf() {
    if (!selected) return;

    // Summary totals come from the full unfiltered invoice list so the account
    // summary on the PDF always reflects the practice's true account position,
    // regardless of which date range or status filter is active in the UI.
    const allInvoices = selectedPracticeInvoices;
    const billed = allInvoices.reduce((s, i) => s + Number(i.total ?? 0), 0);
    const paid = allInvoices.reduce(
      (s, i) => s + Math.max(0, Number(i.total ?? 0) - Number(i.balanceDue ?? i.total ?? 0)),
      0
    );
    const open = allInvoices.reduce(
      (s, i) =>
        i.status === "open" || i.status === "partially_paid"
          ? s + Number(i.balanceDue ?? i.total ?? 0)
          : s,
      0
    );
    const overdue = allInvoices.reduce((s, i) => {
      const ag = agingDays(i);
      return ag != null ? s + Number(i.balanceDue ?? i.total ?? 0) : s;
    }, 0);

    const filterParts: string[] = [];
    if (filterBy !== "all") {
      filterParts.push(
        filterBy === "open"
          ? "Open invoices"
          : filterBy === "overdue"
          ? "Overdue invoices"
          : "Paid invoices"
      );
    }
    if (dateRange !== "all") {
      const labels: Record<string, string> = {
        this_month: "This month",
        last_month: "Last month",
        this_quarter: "This quarter",
        last_quarter: "Last quarter",
        this_year: "This year",
        custom: customFrom || customTo
          ? `${customFrom || "…"} – ${customTo || "…"}`
          : "Custom range",
      };
      filterParts.push(labels[dateRange] ?? dateRange);
    }

    downloadStatementPdf({
      practiceName: selected.displayName || selected.name,
      generatedAt: new Date(),
      filtersDescription: filterParts.length > 0 ? filterParts.join(" · ") : undefined,
      totals: { billed, paid, open, overdue },
      invoices: practiceInvoices.map((inv) => ({
        invoiceNumber: inv.invoiceNumber ?? String(inv.id),
        issuedAt: inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString("en-US") : "—",
        dueAt: inv.dueAt ?? inv.dueDate
          ? new Date((inv.dueAt ?? inv.dueDate)!).toLocaleDateString("en-US")
          : "—",
        status: inv.status,
        total: String(inv.total ?? 0),
        balanceDue: String(inv.balanceDue ?? 0),
        patientName: inv.displayMetadata?.patientName ?? inv.displayMetadataJson?.patientName,
        billTo: inv.displayMetadata?.billTo ?? inv.displayMetadataJson?.billTo,
      })),
    });
  }

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
                <div className="flex items-start gap-4 shrink-0">
                  <div className="text-right">
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
                  <button
                    type="button"
                    onClick={handleExportStatementPdf}
                    disabled={practiceInvoicesQuery.isLoading}
                    title={practiceInvoicesQuery.isLoading ? "Loading transactions…" : "Export statement as PDF"}
                    className="mt-0.5 inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-secondary hover:bg-secondary/80 text-xs font-medium border border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {practiceInvoicesQuery.isLoading ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <FileDown size={13} />
                    )}
                    Export PDF
                  </button>
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
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    setReassignTargetId("");
                    setReassignError(null);
                    setReassignSuccess(null);
                    reassignMutation.reset();
                    setReassignOpen(true);
                  }}
                  className="flex items-center gap-1.5 h-7 px-2.5 rounded bg-secondary text-xs text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors border border-border"
                >
                  <ArrowRightLeft size={11} />
                  Reassign all invoices…
                </button>
              )}
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

      {/* Bulk reassign dialog */}
      {reassignOpen && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <ArrowRightLeft size={15} />
              </div>
              <div>
                <h2 className="text-base font-semibold">Reassign all invoices</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Move invoices from{" "}
                  <span className="font-medium text-foreground">
                    {selected.displayName || selected.name}
                  </span>{" "}
                  to another practice
                </p>
              </div>
            </div>

            {!reassignSuccess ? (
              <>
                <div className="rounded-md bg-secondary/60 px-4 py-3 mb-4 text-sm">
                  <span className="font-medium tabular-nums text-foreground">
                    {nonVoidedCount}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    non-void invoice{nonVoidedCount !== 1 ? "s" : ""} will be moved.
                  </span>
                </div>

                <div className="mb-4">
                  <label className="block text-xs font-medium mb-1.5">
                    Destination practice
                  </label>
                  <select
                    value={reassignTargetId}
                    onChange={(e) => {
                      setReassignTargetId(e.target.value);
                      setReassignError(null);
                    }}
                    className="w-full h-9 px-3 rounded-md bg-secondary text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                    disabled={reassignMutation.isPending}
                  >
                    <option value="">Select a practice…</option>
                    {otherPractices.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName || p.name}
                      </option>
                    ))}
                  </select>
                </div>

                {reassignError && (
                  <div className="mb-4 text-xs text-destructive flex items-center gap-1.5">
                    <AlertCircle size={12} />
                    {reassignError}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setReassignOpen(false)}
                    disabled={reassignMutation.isPending}
                    className="h-8 px-3 rounded text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!reassignTargetId || reassignMutation.isPending || nonVoidedCount === 0}
                    onClick={() => {
                      if (!reassignTargetId || !labOrgId) return;
                      setReassignError(null);
                      reassignMutation.mutate({
                        labOrganizationId: labOrgId,
                        fromProviderOrganizationId: selected.id,
                        toProviderOrganizationId: reassignTargetId,
                      });
                    }}
                    className="h-8 px-4 rounded bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                  >
                    {reassignMutation.isPending ? (
                      <>
                        <Loader2 size={12} className="animate-spin" />
                        Moving…
                      </>
                    ) : (
                      <>
                        <ArrowRightLeft size={12} />
                        Move {nonVoidedCount} invoice{nonVoidedCount !== 1 ? "s" : ""}
                      </>
                    )}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-md bg-green-500/10 border border-green-500/20 px-4 py-3 mb-4 text-sm text-green-600 dark:text-green-400">
                  {reassignSuccess}
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setReassignOpen(false);
                      setSelectedId(null);
                    }}
                    className="h-8 px-4 rounded bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
