import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Ban, CheckCircle2, Download, Landmark, Loader2, Plus, Repeat, Scale, Search, Trash2, Upload, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { TYPE_BADGE_CLASS, TYPE_LABEL, useVendors, VendorCombobox } from "@/components/finance/VendorCombobox";
import { CategorySelect } from "@/components/finance/CategorySelect";
import type { BankAccount, BankTransaction, Invoice, RecurringRule, TransactionCategory } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { useColumnWidths } from "@/hooks/useColumnWidths";
import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";

type BlankRowValues = {
  date: string;
  payee: string;
  memo: string;
  categoryId: string;
  payment: string;
  deposit: string;
};

type BlankRowEntry = { key: number; initialValues?: BlankRowValues };

// QB-style layout — 7 resizable cols: Date(0) Num(1) Payee(2) Account(3) Payment(4) Deposit(5) Balance(6)
// DOM order: Date | Num | Payee | Account | Payment | ✓(fixed) | Deposit | Balance | Actions(fixed)
const FINANCE_COL_DEFAULTS = [90, 70, 160, 150, 100, 100, 110] as const;
const FINANCE_FIXED_CLR = 40; // combined cleared / reconciled "✓" indicator column
const FINANCE_FIXED_ACTIONS = 80;
// Labels for cols 0-4 (before the fixed ✓ column); Deposit and Balance are rendered separately
const FINANCE_PRE_LABELS = ["Date", "Num", "Payee", "Account", "Payment"] as const;

export default function RegisterPage() {
  return (
    <FinanceShell requireAccount>
      {({ organizationId, accountId, accounts }) => (
        <RegisterTable
          organizationId={organizationId}
          accountId={accountId!}
          accounts={accounts}
        />
      )}
    </FinanceShell>
  );
}

function RegisterTable({
  organizationId,
  accountId,
  accounts,
}: {
  organizationId: string;
  accountId: string;
  accounts: BankAccount[];
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showInlineRows, setShowInlineRows] = useState(false);
  const [inlineDateGroup, setInlineDateGroup] = useState<string | null>(null);
  const [inlineDateGroupIsPartial, setInlineDateGroupIsPartial] = useState(false);
  const pendingGroupInvalidateRef = useRef(false);
  const qcRef = useRef(qc);
  qcRef.current = qc;
  useEffect(() => {
    return () => {
      if (pendingGroupInvalidateRef.current) {
        pendingGroupInvalidateRef.current = false;
        void qcRef.current.invalidateQueries({ queryKey: ["finance"] });
      }
    };
  }, [accountId, organizationId]);
  const [importing, setImporting] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [reconOpen, setReconOpen] = useState(false);
  const [recurringFor, setRecurringFor] = useState<BankTransaction | null>(null);

  const account = accounts.find((a) => a.id === accountId);
  const isUF = account?.accountType === "undeposited_funds";

  const { widths: colWidths, totalWidth: colTotalWidth, resizingCol, startResize, resetColumn } =
    useColumnWidths([...FINANCE_COL_DEFAULTS], "labtrax_finance_col_widths_v4");

  const theadRef = useRef<HTMLTableSectionElement>(null);
  const [theadHeight, setTheadHeight] = useState(33);
  useLayoutEffect(() => {
    if (theadRef.current) {
      setTheadHeight(theadRef.current.getBoundingClientRect().height);
    }
  }, [colWidths]);

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("organizationId", organizationId);
    sp.set("bankAccountId", accountId);
    if (statusFilter !== "all") sp.set("status", statusFilter);
    if (categoryFilter) sp.set("categoryId", categoryFilter);
    if (search.trim()) sp.set("search", search.trim());
    if (dateFrom) sp.set("dateFrom", new Date(dateFrom).toISOString());
    if (dateTo) sp.set("dateTo", new Date(dateTo).toISOString());
    return sp.toString();
  }, [organizationId, accountId, statusFilter, categoryFilter, search, dateFrom, dateTo]);

  const txnsQuery = useQuery({
    queryKey: ["finance", "txns", params],
    queryFn: () => apiFetch<BankTransaction[]>(`/finance/transactions?${params}`),
  });

  const cats = useQuery({
    queryKey: ["finance", "categories", organizationId],
    queryFn: () =>
      apiFetch<TransactionCategory[]>(
        `/finance/categories?organizationId=${organizationId}`
      ),
  });

  const catNameById = new Map((cats.data || []).map((c) => [c.id, c.name]));

  const vendorsQuery = useVendors(organizationId);
  const vendorTypeById = useMemo(
    () => new Map((vendorsQuery.data ?? []).map((v) => [v.id, v.vendorType])),
    [vendorsQuery.data]
  );

  const dateGroups = useMemo(() => {
    const rows = txnsQuery.data || [];
    const groups: { date: string; rows: typeof rows }[] = [];
    for (const r of rows) {
      const d = r.txnDate.slice(0, 10);
      const last = groups[groups.length - 1];
      if (last && last.date === d) {
        last.rows.push(r);
      } else {
        groups.push({ date: d, rows: [r] });
      }
    }
    return groups;
  }, [txnsQuery.data]);

  const clearingStatusMut = useMutation({
    mutationFn: ({ id, cleared, reconciled }: { id: string; cleared: boolean; reconciled: boolean }) =>
      apiFetch(`/finance/transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ cleared, reconciled }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finance"] }),
  });
  const voidMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/finance/transactions/${id}/void`, { method: "POST", body: "{}" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finance"] }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/finance/transactions/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finance"] }),
  });

  function exportCsv() {
    const rows = txnsQuery.data || [];
    const header = [
      "Date",
      "Type",
      "Check #",
      "Payee",
      "Memo",
      "Category",
      "Payment",
      "Deposit",
      "Cleared",
      "Reconciled",
      "Status",
      "Source",
      "Running Balance",
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      const fields = [
        formatDate(r.txnDate),
        r.type,
        r.checkNumber || "",
        r.payee || "",
        r.memo || "",
        r.categoryId ? catNameById.get(r.categoryId) || "" : "",
        Number(r.debitAmount).toFixed(2),
        Number(r.creditAmount).toFixed(2),
        r.cleared ? "Y" : "",
        r.reconciled ? "Y" : "",
        r.status,
        r.source,
        r.runningBalance || "",
      ].map((f) => `"${String(f).replace(/"/g, '""')}"`);
      lines.push(fields.join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `register-${account?.name || "export"}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Book balance" value={account?.bookBalance} />
        <SummaryCard label="Cleared" value={account?.clearedBalance} tone="info" />
        <SummaryCard
          label="Uncleared"
          value={
            account
              ? Number(account.bookBalance ?? 0) - Number(account.clearedBalance ?? 0)
              : 0
          }
          tone="warning"
        />
        <SummaryCard
          label="Unreconciled"
          value={account?.unreconciledBalance}
          tone="warning"
        />
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search payee, memo, check #…"
              className="w-full h-9 pl-8 pr-3 rounded-md bg-secondary text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-transparent focus:border-primary"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            <option value="all">All status</option>
            <option value="posted">Posted</option>
            <option value="projected">Projected</option>
            <option value="uncleared">Uncleared</option>
            <option value="unreconciled">Unreconciled</option>
            <option value="void">Voided</option>
          </select>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="h-9 px-2.5 rounded-md bg-secondary text-sm border border-transparent focus:bg-card focus:border-border focus:outline-none"
          >
            <option value="">All categories</option>
            {(cats.data || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-9 px-2 rounded-md bg-secondary text-sm border border-transparent"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-9 px-2 rounded-md bg-secondary text-sm border border-transparent"
          />
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setImporting(true)}
            className="h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 inline-flex items-center gap-1.5"
          >
            <Upload size={14} /> Import CSV
          </button>
          <button
            type="button"
            onClick={exportCsv}
            className="h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 inline-flex items-center gap-1.5"
          >
            <Download size={14} /> Export
          </button>
          <button
            type="button"
            onClick={() => setTransferring(true)}
            disabled={accounts.length < 2}
            title={accounts.length < 2 ? "Add a second bank account to transfer between accounts." : undefined}
            className="h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ArrowLeftRight size={14} /> New transfer
          </button>
          {!isUF && (
            <button
              type="button"
              onClick={() => setReconOpen(true)}
              className="h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 inline-flex items-center gap-1.5"
            >
              <Scale size={14} /> Reconcile
            </button>
          )}
          <button
            type="button"
            onClick={() => !isUF && setShowInlineRows(true)}
            disabled={isUF}
            title={isUF ? "Undeposited Funds holds received payments — entries are created automatically via Receive Payments" : undefined}
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus size={14} /> Add entry
          </button>
        </div>

        {isUF && (
          <div className="mx-0 px-4 py-2.5 bg-sky-50 dark:bg-sky-950/40 border-b border-sky-200 dark:border-sky-800 text-sky-800 dark:text-sky-300 text-xs flex items-center gap-2">
            <span className="font-semibold">Undeposited Funds</span>
            <span className="text-sky-600 dark:text-sky-400">—</span>
            <span>
              Received payments accumulate here until you run{" "}
              <a href="/finance/make-deposits" className="underline font-medium hover:text-sky-900 dark:hover:text-sky-100">
                Make Deposits
              </a>{" "}
              to move them to a bank account.
            </span>
          </div>
        )}

        <div className="overflow-x-auto overflow-y-auto relative" style={{ maxHeight: "calc(100vh - 22rem)" }}>
          {resizingCol !== null && (
            <div
              className="bg-primary/50 pointer-events-none absolute top-0 bottom-0 z-10"
              style={{
                left:
                  resizingCol <= 4
                    ? colWidths.slice(0, resizingCol + 1).reduce((a, b) => a + b, 0) - 1
                    : colWidths.slice(0, 5).reduce((a, b) => a + b, 0) +
                      FINANCE_FIXED_CLR +
                      colWidths.slice(5, resizingCol + 1).reduce((a, b) => a + b, 0) -
                      1,
                width: 2,
              }}
            />
          )}
          <table
            className="text-sm"
            style={{
              tableLayout: "fixed",
              width: colTotalWidth + FINANCE_FIXED_CLR + FINANCE_FIXED_ACTIONS,
              userSelect: "none",
            }}
          >
            <colgroup>
              {/* cols 0-4: Date Num Payee Account Payment */}
              {colWidths.slice(0, 5).map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
              {/* fixed ✓ */}
              <col style={{ width: FINANCE_FIXED_CLR }} />
              {/* col 5: Deposit */}
              <col style={{ width: colWidths[5] }} />
              {/* col 6: Balance — hidden for UF */}
              {!isUF && <col style={{ width: colWidths[6] }} />}
              {/* fixed Actions */}
              <col style={{ width: FINANCE_FIXED_ACTIONS }} />
            </colgroup>
            <thead ref={theadRef} style={{ position: "sticky", top: 0, zIndex: 20 }}>
              <tr className="bg-secondary text-[11px] uppercase tracking-wide text-muted-foreground">
                {/* Cols 0-4: Date Num Payee Account Payment */}
                {FINANCE_PRE_LABELS.map((label, i) => {
                  const isRight = i === 4; // Payment is right-aligned
                  const isFirst = i === 0;
                  return (
                    <th
                      key={label}
                      className={`font-medium py-2 relative${isFirst ? " px-4" : " px-3"}${isRight ? " text-right" : " text-left"}`}
                      style={{ overflow: "hidden" }}
                    >
                      {label}
                      <div
                        onMouseDown={(e) => startResize(i, e)}
                        onDoubleClick={() => resetColumn(i)}
                        className="group/resize"
                        style={{
                          position: "absolute",
                          top: 0,
                          right: 0,
                          width: 6,
                          height: "100%",
                          cursor: "col-resize",
                          userSelect: "none",
                          display: "flex",
                          alignItems: "stretch",
                          justifyContent: "flex-end",
                        }}
                      >
                        <span
                          className={`w-0.5 transition-colors duration-100 ${resizingCol === i ? "bg-primary" : "bg-border/60 group-hover/resize:bg-primary/50"}`}
                          style={{ display: "block", height: "100%" }}
                        />
                      </div>
                    </th>
                  );
                })}
                {/* Fixed: ✓ (cleared + reconciled combined) */}
                <th className="text-center font-medium py-2">✓</th>
                {/* Resizable: Deposit (index 5) */}
                <th
                  className="font-medium px-3 py-2 relative text-right"
                  style={{ overflow: "hidden" }}
                >
                  Deposit
                  <div
                    onMouseDown={(e) => startResize(5, e)}
                    onDoubleClick={() => resetColumn(5)}
                    className="group/resize"
                    style={{
                      position: "absolute",
                      top: 0,
                      right: 0,
                      width: 6,
                      height: "100%",
                      cursor: "col-resize",
                      userSelect: "none",
                      display: "flex",
                      alignItems: "stretch",
                      justifyContent: "flex-end",
                    }}
                  >
                    <span
                      className={`w-0.5 transition-colors duration-100 ${resizingCol === 5 ? "bg-primary" : "bg-border/60 group-hover/resize:bg-primary/50"}`}
                      style={{ display: "block", height: "100%" }}
                    />
                  </div>
                </th>
                {/* Resizable: Balance (index 6) — hidden for UF */}
                {!isUF && (
                  <th
                    className="font-medium px-4 py-2 relative text-right"
                    style={{ overflow: "hidden" }}
                  >
                    Balance
                    <div
                      onMouseDown={(e) => startResize(6, e)}
                      onDoubleClick={() => resetColumn(6)}
                      className="group/resize"
                      style={{
                        position: "absolute",
                        top: 0,
                        right: 0,
                        width: 6,
                        height: "100%",
                        cursor: "col-resize",
                        userSelect: "none",
                        display: "flex",
                        alignItems: "stretch",
                        justifyContent: "flex-end",
                      }}
                    >
                      <span
                        className={`w-0.5 transition-colors duration-100 ${resizingCol === 6 ? "bg-primary" : "bg-border/60 group-hover/resize:bg-primary/50"}`}
                        style={{ display: "block", height: "100%" }}
                      />
                    </div>
                  </th>
                )}
                {/* Fixed: Actions */}
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {txnsQuery.isLoading && (
                <tr>
                  <td colSpan={isUF ? 8 : 9} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading register…
                  </td>
                </tr>
              )}
              {txnsQuery.data?.length === 0 && !txnsQuery.isLoading && (
                <tr>
                  <td colSpan={isUF ? 8 : 9} className="px-5 py-12 text-center text-muted-foreground">
                    No transactions match the current filters.
                  </td>
                </tr>
              )}
              {dateGroups.map(({ date, rows: groupRows }) => (
                <Fragment key={date}>
                  <tr className="border-t border-border/60">
                    <td
                      colSpan={isUF ? 8 : 9}
                      className="px-4 py-1 text-[11px] font-semibold text-muted-foreground tracking-wide uppercase select-none bg-muted/80"
                      style={{ position: "sticky", top: theadHeight, zIndex: 10 }}
                    >
                      {formatDate(date)}
                    </td>
                  </tr>
                  {groupRows.map((r) => {
                    const debit = Number(r.debitAmount);
                    const credit = Number(r.creditAmount);
                    const isVoid = r.status === "void";
                    const isProjected = r.status === "projected";
                    const cols = isUF ? 8 : 9;
                    return (
                      <Fragment key={r.id}>
                      <tr
                        onClick={() => !isUF && setExpandedId(expandedId === r.id ? null : r.id)}
                        className={`border-t border-border/30 ${isUF ? "" : "cursor-pointer hover:bg-secondary/30"} ${expandedId === r.id ? "bg-secondary/40" : ""} ${
                          isVoid ? "text-muted-foreground line-through" : ""
                        } ${isProjected ? "italic text-muted-foreground" : ""}`}
                      >
                        <td
                          className="px-4 py-2.5"
                          onClick={(e) => { if (!r.reconciled) e.stopPropagation(); }}
                        >
                          <InlineDateCell
                            txn={r}
                            onUpdated={() => qc.invalidateQueries({ queryKey: ["finance"] })}
                          />
                        </td>
                        {/* Num — check number, empty for non-check types */}
                        <td className="py-2.5 px-3 font-mono text-xs text-muted-foreground">
                          {r.checkNumber || (r.type !== "other" ? <span className="capitalize">{r.type}</span> : "")}
                        </td>
                        {/* Payee — with vendor type badge; memo shown as secondary text */}
                        <td className="py-2.5 px-3">
                          <div className="min-w-0">
                            {r.payee ? (
                              <span className="flex items-center gap-1.5 min-w-0">
                                {r.vendorId && vendorTypeById.has(r.vendorId) && (
                                  <span
                                    className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${TYPE_BADGE_CLASS[vendorTypeById.get(r.vendorId)!]}`}
                                  >
                                    {TYPE_LABEL[vendorTypeById.get(r.vendorId)!]}
                                  </span>
                                )}
                                <span className="truncate">{r.payee}</span>
                              </span>
                            ) : <span className="text-muted-foreground">—</span>}
                            {r.memo && (
                              <div className="text-[11px] text-muted-foreground truncate mt-0.5">{r.memo}</div>
                            )}
                          </div>
                        </td>
                        {/* Account (Category) — shows "–split–" when multiple invoice links */}
                        <td className="py-2.5 px-3 text-muted-foreground">
                          {(r.invoices?.length ?? 0) > 1
                            ? <span className="italic text-xs">–split–</span>
                            : r.categoryId
                              ? catNameById.get(r.categoryId) || "—"
                              : "—"}
                        </td>
                        {/* Payment (debit) */}
                        <td className="py-2.5 px-3 text-right tabular-nums">
                          {debit > 0 ? formatMoney(debit) : ""}
                        </td>
                        {/* ✓ — click-to-cycle: none → C (cleared) → R (reconciled) → none */}
                        <td
                          className={`py-2.5 text-center${isVoid || isUF ? "" : " cursor-pointer"}`}
                          title={
                            isVoid || isUF
                              ? undefined
                              : r.reconciled
                              ? "Reconciled — click to clear"
                              : r.cleared
                              ? "Cleared — click to mark reconciled"
                              : "Uncleared — click to mark cleared"
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isVoid || isUF) return;
                            if (r.reconciled) {
                              clearingStatusMut.mutate({ id: r.id, cleared: false, reconciled: false });
                            } else if (r.cleared) {
                              clearingStatusMut.mutate({ id: r.id, cleared: true, reconciled: true });
                            } else {
                              clearingStatusMut.mutate({ id: r.id, cleared: true, reconciled: false });
                            }
                          }}
                        >
                          {r.reconciled ? (
                            <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold select-none">R</span>
                          ) : r.cleared ? (
                            <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-sky-500/20 text-sky-600 dark:text-sky-400 text-[10px] font-bold select-none">C</span>
                          ) : (
                            <span className="inline-flex items-center justify-center h-4 w-4 rounded-full text-muted-foreground/40 text-[10px] select-none">–</span>
                          )}
                        </td>
                        {/* Deposit (credit) */}
                        <td className="py-2.5 px-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                          {credit > 0 ? formatMoney(credit) : ""}
                        </td>
                        {/* Balance — hidden for UF accounts */}
                        {!isUF && (
                          <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                            {formatMoney(r.runningBalance ?? 0)}
                          </td>
                        )}
                        <td
                          className="px-2 py-2.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-end gap-0.5">
                            {!isUF && !isVoid && (
                              <button
                                type="button"
                                onClick={() => setRecurringFor(r)}
                                className="h-6 w-6 rounded hover:bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center"
                                aria-label="Make recurring"
                                title="Make recurring"
                              >
                                <Repeat size={12} />
                              </button>
                            )}
                            {!isUF && !r.reconciled && !isVoid && (
                              <button
                                type="button"
                                onClick={() => voidMut.mutate(r.id)}
                                className="h-6 w-6 rounded hover:bg-secondary text-muted-foreground hover:text-destructive flex items-center justify-center"
                                aria-label="Void"
                                title="Void"
                              >
                                <Ban size={12} />
                              </button>
                            )}
                            {!isUF && !r.reconciled && (
                              <button
                                type="button"
                                onClick={() => {
                                  if (confirm("Delete this transaction?"))
                                    deleteMut.mutate(r.id);
                                }}
                                className="h-6 w-6 rounded hover:bg-secondary text-muted-foreground hover:text-destructive flex items-center justify-center"
                                aria-label="Delete"
                                title="Delete"
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expandedId === r.id && (
                        <InlineEditRow
                          key={`edit-${r.id}`}
                          organizationId={organizationId}
                          accountId={accountId}
                          existing={r}
                          categories={cats.data || []}
                          colSpan={cols}
                          onClose={() => setExpandedId(null)}
                          onSaved={() => {
                            setExpandedId(null);
                            void qc.invalidateQueries({ queryKey: ["finance"] });
                          }}
                        />
                      )}
                      </Fragment>
                    );
                  })}
                  {inlineDateGroup === date ? (
                    <InlineBlankRows
                      accountId={accountId}
                      organizationId={organizationId}
                      accounts={accounts}
                      categories={cats.data || []}
                      rowCount={1}
                      defaultDate={date}
                      showDatePicker
                      onSaved={() => { pendingGroupInvalidateRef.current = true; }}
                      onAllDismissed={() => {
                        setInlineDateGroup(null);
                        setInlineDateGroupIsPartial(false);
                        if (pendingGroupInvalidateRef.current) {
                          pendingGroupInvalidateRef.current = false;
                          void qc.invalidateQueries({ queryKey: ["finance"] });
                        }
                      }}
                      onPartialChange={setInlineDateGroupIsPartial}
                    />
                  ) : (
                    !isUF && (
                    <tr className="border-t border-border/30">
                      <td colSpan={8} className="px-4 py-0">
                        <button
                          type="button"
                          disabled={inlineDateGroupIsPartial}
                          title={inlineDateGroupIsPartial ? "Finish or dismiss the open entry form first" : undefined}
                          onClick={() => {
                            setShowInlineRows(false);
                            setInlineDateGroupIsPartial(false);
                            if (pendingGroupInvalidateRef.current) {
                              pendingGroupInvalidateRef.current = false;
                              void qc.invalidateQueries({ queryKey: ["finance"] });
                            }
                            setInlineDateGroup(date);
                          }}
                          className="text-xs text-muted-foreground/60 hover:text-primary inline-flex items-center gap-1 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground/60"
                        >
                          <Plus size={11} /> Add entry
                        </button>
                      </td>
                    </tr>
                    )
                  )}
                </Fragment>
              ))}
              {showInlineRows && (
                <InlineBlankRows
                  accountId={accountId}
                  organizationId={organizationId}
                  accounts={accounts}
                  categories={cats.data || []}
                  rowCount={1}
                  showDatePicker
                  onSaved={() => qc.invalidateQueries({ queryKey: ["finance"] })}
                  onAllDismissed={() => setShowInlineRows(false)}
                />
              )}
            </tbody>
          </table>
        </div>
      </div>


      {importing && (
        <ImportDialog
          accountId={accountId}
          onClose={() => setImporting(false)}
          onComplete={() => qc.invalidateQueries({ queryKey: ["finance"] })}
        />
      )}

      {transferring && (
        <TransferDialog
          accounts={accounts}
          defaultFromAccountId={accountId}
          onClose={() => setTransferring(false)}
          onComplete={() => qc.invalidateQueries({ queryKey: ["finance"] })}
        />
      )}

      {recurringFor && (
        <MakeRecurringDialog
          organizationId={organizationId}
          accounts={accounts}
          categories={cats.data || []}
          source={recurringFor}
          onClose={() => setRecurringFor(null)}
          onComplete={() => {
            setRecurringFor(null);
            qc.invalidateQueries({ queryKey: ["finance"] });
          }}
        />
      )}

      {reconOpen && account && (
        <ReconcileDialog
          accountId={accountId}
          account={account}
          onClose={() => setReconOpen(false)}
          onComplete={() => {
            setReconOpen(false);
            qc.invalidateQueries({ queryKey: ["finance"] });
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────── Reconciliation worksheet ────────────────────────

function ReconcileDialog({
  accountId,
  account,
  onClose,
  onComplete,
}: {
  accountId: string;
  account: BankAccount;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [step, setStep] = useState<"setup" | "worksheet">("setup");

  // Step 1 inputs
  const today = new Date().toISOString().slice(0, 10);
  const [statementDate, setStatementDate] = useState(today);
  const [endingBalanceStr, setEndingBalanceStr] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);

  // Worksheet state
  const [candidates, setCandidates] = useState<BankTransaction[]>([]);
  const [startingBalance, setStartingBalance] = useState(0);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const endingBalance = parseFloat(endingBalanceStr) || 0;

  async function loadCandidates() {
    const parsed = parseFloat(endingBalanceStr);
    if (!statementDate) {
      setSetupError("Enter a statement ending date.");
      return;
    }
    if (isNaN(parsed)) {
      setSetupError("Enter a valid statement ending balance.");
      return;
    }
    setSetupError(null);
    setLoadingCandidates(true);
    try {
      const sp = new URLSearchParams({
        bankAccountId: accountId,
        statementDate: new Date(statementDate).toISOString(),
      });
      const data = await apiFetch<{ startingBalance: string; candidates: BankTransaction[] }>(
        `/finance/reconciliation/candidates?${sp}`
      );
      setStartingBalance(Number(data.startingBalance));
      setCandidates(data.candidates);
      setCheckedIds(new Set(data.candidates.filter((c) => c.cleared).map((c) => c.id)));
      setStep("worksheet");
    } catch (e: any) {
      setSetupError(e?.message || "Failed to load transactions.");
    } finally {
      setLoadingCandidates(false);
    }
  }

  function toggleId(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (checkedIds.size === candidates.length) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(candidates.map((c) => c.id)));
    }
  }

  // Running totals
  const clearedSum = candidates
    .filter((c) => checkedIds.has(c.id))
    .reduce((s, c) => s + Number(c.netAmount), 0);
  const difference = +(startingBalance + clearedSum - endingBalance).toFixed(2);
  const balanced = Math.abs(difference) < 0.005;

  async function finish() {
    setFinishing(true);
    setFinishError(null);
    try {
      await apiFetch("/finance/reconciliation/finish", {
        method: "POST",
        body: JSON.stringify({
          bankAccountId: accountId,
          statementDate: new Date(statementDate).toISOString(),
          endingBalance,
          transactionIds: Array.from(checkedIds),
        }),
      });
      onComplete();
    } catch (e: any) {
      setFinishError(e?.message || "Failed to finish reconciliation.");
    } finally {
      setFinishing(false);
    }
  }

  const inputCls = "h-9 px-2.5 rounded-md bg-background border border-input text-sm w-full";

  // Payments (debits < 0 netAmount) and deposits (credits > 0 netAmount)
  const payments = candidates.filter((c) => Number(c.netAmount) < 0);
  const deposits = candidates.filter((c) => Number(c.netAmount) >= 0);
  const paymentSum = payments
    .filter((c) => checkedIds.has(c.id))
    .reduce((s, c) => s + Math.abs(Number(c.netAmount)), 0);
  const depositSum = deposits
    .filter((c) => checkedIds.has(c.id))
    .reduce((s, c) => s + Number(c.netAmount), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch bg-foreground/40">
      <div className="flex flex-col w-full max-w-4xl mx-auto my-6 bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <header className="shrink-0 bg-card border-b border-border px-6 py-4 flex items-center gap-3">
          <Scale size={18} className="text-primary shrink-0" />
          <div>
            <h2 className="text-base font-semibold leading-none">Reconcile account</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{account.name}{account.last4 ? ` ··${account.last4}` : ""}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </header>

        {step === "setup" ? (
          /* ── Step 1: Enter statement info ── */
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="w-full max-w-sm space-y-5">
              <div>
                <p className="text-sm text-muted-foreground mb-4">
                  Enter the ending date and balance from your bank statement. LabTrax will show you
                  all unreconciled transactions through that date so you can check them off.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5">Statement ending date</label>
                <input
                  type="date"
                  value={statementDate}
                  onChange={(e) => setStatementDate(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5">Statement ending balance</label>
                <input
                  type="number"
                  step="0.01"
                  value={endingBalanceStr}
                  onChange={(e) => setEndingBalanceStr(e.target.value)}
                  placeholder="0.00"
                  className={`${inputCls} text-right tabular-nums`}
                  onKeyDown={(e) => { if (e.key === "Enter") void loadCandidates(); }}
                  autoFocus
                />
              </div>
              {setupError && (
                <p className="text-xs text-destructive">{setupError}</p>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 px-4 rounded-md text-sm hover:bg-secondary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={loadingCandidates}
                  onClick={() => void loadCandidates()}
                  className="h-9 px-5 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-2"
                >
                  {loadingCandidates && <Loader2 size={13} className="animate-spin" />}
                  Start reconciling
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ── Step 2: Worksheet ── */
          <>
            {/* Running-total summary bar */}
            <div className="shrink-0 bg-muted/40 border-b border-border px-6 py-3 flex flex-wrap gap-6 items-center text-sm">
              <div className="flex flex-col min-w-[110px]">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Starting balance</span>
                <span className="tabular-nums font-semibold">{formatMoney(startingBalance)}</span>
              </div>
              <span className="text-muted-foreground text-lg leading-none">+</span>
              <div className="flex flex-col min-w-[130px]">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Cleared (net)</span>
                <span className="tabular-nums font-semibold">{formatMoney(clearedSum)}</span>
              </div>
              <span className="text-muted-foreground text-base leading-none">=</span>
              <div className="flex flex-col min-w-[130px]">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Cleared balance</span>
                <span className="tabular-nums font-semibold">{formatMoney(startingBalance + clearedSum)}</span>
              </div>
              <div className="flex flex-col min-w-[130px]">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Statement balance</span>
                <span className="tabular-nums font-semibold text-primary">{formatMoney(endingBalance)}</span>
              </div>
              <div className="flex flex-col min-w-[110px]">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Difference</span>
                <span
                  className={`tabular-nums font-bold text-base ${
                    balanced
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-amber-600 dark:text-amber-400"
                  }`}
                >
                  {balanced ? "✓ Balanced" : formatMoney(difference)}
                </span>
              </div>
              <div className="ml-auto flex gap-2 shrink-0 items-center text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-sky-500/20 text-sky-600 dark:text-sky-400 text-[10px] font-bold">C</span>
                  Deposits: {formatMoney(depositSum)}
                </span>
                <span className="text-border">|</span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-rose-500/20 text-rose-600 dark:text-rose-400 text-[10px] font-bold">C</span>
                  Payments: {formatMoney(paymentSum)}
                </span>
              </div>
            </div>

            {/* Transaction list */}
            <div className="flex-1 overflow-y-auto">
              {candidates.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground gap-2">
                  <Scale size={32} className="opacity-30" />
                  <p className="text-sm font-medium">No unreconciled transactions</p>
                  <p className="text-xs">There are no posted, unreconciled transactions on or before {statementDate}.</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-secondary text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border">
                      <th className="px-4 py-2 text-left w-10">
                        <input
                          type="checkbox"
                          title="Toggle all"
                          checked={checkedIds.size === candidates.length && candidates.length > 0}
                          onChange={toggleAll}
                          className="cursor-pointer"
                        />
                      </th>
                      <th className="px-3 py-2 text-left w-28">Date</th>
                      <th className="px-3 py-2 text-left">Payee / Memo</th>
                      <th className="px-3 py-2 text-right w-28">Payment</th>
                      <th className="px-3 py-2 text-right w-28">Deposit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((txn) => {
                      const checked = checkedIds.has(txn.id);
                      const debit = Number(txn.debitAmount);
                      const credit = Number(txn.creditAmount);
                      return (
                        <tr
                          key={txn.id}
                          onClick={() => toggleId(txn.id)}
                          className={`border-t border-border/30 cursor-pointer transition-colors ${
                            checked
                              ? "bg-sky-50/60 dark:bg-sky-950/30 hover:bg-sky-100/60 dark:hover:bg-sky-900/30"
                              : "hover:bg-secondary/30"
                          }`}
                        >
                          <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleId(txn.id)}
                              className="cursor-pointer"
                            />
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground tabular-nums text-xs">
                            {formatDate(txn.txnDate)}
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="min-w-0">
                              {txn.payee ? (
                                <span className="font-medium truncate block">{txn.payee}</span>
                              ) : (
                                <span className="text-muted-foreground italic text-xs">No payee</span>
                              )}
                              {txn.memo && (
                                <span className="text-[11px] text-muted-foreground block truncate">
                                  {txn.memo}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {debit > 0 ? (
                              <span className="text-foreground">{formatMoney(debit)}</span>
                            ) : ""}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {credit > 0 ? (
                              <span className="text-emerald-600 dark:text-emerald-400">{formatMoney(credit)}</span>
                            ) : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer */}
            <footer className="shrink-0 bg-card border-t border-border px-6 py-3 flex items-center gap-3">
              <button
                type="button"
                onClick={() => { setStep("setup"); setFinishError(null); }}
                className="h-9 px-3 rounded-md text-sm hover:bg-secondary"
              >
                ← Back
              </button>
              <div className="flex-1" />
              {finishError && (
                <p className="text-xs text-destructive max-w-xs text-right">{finishError}</p>
              )}
              <button
                type="button"
                onClick={onClose}
                className="h-9 px-4 rounded-md text-sm hover:bg-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!balanced || finishing || checkedIds.size === 0}
                onClick={() => void finish()}
                title={
                  !balanced
                    ? `Difference must be zero before finishing (${formatMoney(difference)} remaining)`
                    : checkedIds.size === 0
                    ? "Check at least one transaction to finish"
                    : undefined
                }
                className="h-9 px-5 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
              >
                {finishing && <Loader2 size={13} className="animate-spin" />}
                Finish reconciliation
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

interface RecurringSource {
  payee?: string | null;
  memo?: string | null;
  categoryId?: string | null;
  bankAccountId: string;
  txnDate: string;
  debitAmount: string | number;
  creditAmount: string | number;
}

function MakeRecurringDialog({
  organizationId,
  accounts,
  categories,
  source,
  editRule,
  onClose,
  onComplete,
}: {
  organizationId: string;
  accounts: BankAccount[];
  categories: TransactionCategory[];
  source: RecurringSource;
  editRule?: RecurringRule;
  onClose: () => void;
  onComplete: () => void;
}) {
  const isEdit = !!editRule;
  const qc = useQueryClient();

  const debit = Number(source.debitAmount);
  const credit = Number(source.creditAmount);
  const initialDirection: "debit" | "credit" = isEdit
    ? editRule!.direction
    : credit > 0 ? "credit" : "debit";
  const initialAmount = isEdit
    ? Number(editRule!.amount || 0).toFixed(2)
    : (initialDirection === "credit" ? credit : debit || 0).toFixed(2);
  const today = new Date().toISOString().slice(0, 10);

  const vendorsQuery = useVendors(organizationId);
  const vendorById = useMemo(
    () => new Map((vendorsQuery.data ?? []).map((v) => [v.id, v])),
    [vendorsQuery.data]
  );

  const [name, setName] = useState(
    isEdit
      ? editRule!.name
      : source.payee || `Recurring ${initialDirection === "credit" ? "deposit" : "payment"}`
  );
  const [payee, setPayee] = useState(isEdit ? (editRule!.payee || "") : (source.payee || ""));
  const [vendorId, setVendorId] = useState(isEdit ? (editRule!.vendorId || null) : null);
  const [payeeUserEdited, setPayeeUserEdited] = useState(false);

  useEffect(() => {
    if (isEdit && editRule!.vendorId && !payeeUserEdited) {
      const v = vendorById.get(editRule!.vendorId);
      if (v) setPayee(v.name);
    }
  }, [vendorById, isEdit, editRule, payeeUserEdited]);
  const [memo, setMemo] = useState(isEdit ? (editRule!.memo || "") : (source.memo || ""));
  const [categoryId, setCategoryId] = useState(isEdit ? (editRule!.categoryId || "") : (source.categoryId || ""));
  const [bankAccountId, setBankAccountId] = useState(isEdit ? editRule!.bankAccountId : source.bankAccountId);
  const [direction, setDirection] = useState<"debit" | "credit">(initialDirection);
  const estimateMethod = "fixed" as const;
  const [amount, setAmount] = useState(initialAmount);
  const [frequency, setFrequency] = useState<"weekly" | "biweekly" | "monthly" | "quarterly" | "annual">(
    isEdit ? editRule!.frequency : "monthly"
  );
  const [dayOfMonth, setDayOfMonth] = useState<number>(
    isEdit ? editRule!.dayOfMonth : (new Date(source.txnDate).getDate() || 1)
  );
  const [startDate, setStartDate] = useState(
    isEdit ? editRule!.startDate.slice(0, 10) : today
  );
  const [endDate, setEndDate] = useState(
    isEdit ? (editRule!.endDate?.slice(0, 10) || "") : ""
  );
  const [autoCreate, setAutoCreate] = useState(isEdit ? editRule!.autoCreate : true);
  const [postNow, setPostNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const usableAccounts = accounts.filter((a) => !a.isArchived);

  const save = useMutation({
    mutationFn: async () => {
      const amt = estimateMethod === "fixed" ? Number(amount) : null;
      if (estimateMethod === "fixed" && (!amt || !(amt > 0))) {
        throw new Error("Enter a positive amount, or switch to 'Average of last 3'.");
      }
      if (!name.trim()) throw new Error("Give the rule a name.");
      if (!bankAccountId) throw new Error("Choose a bank account.");
      const payload = {
        organizationId,
        bankAccountId,
        name: name.trim(),
        payee: payee.trim() || null,
        vendorId: vendorId || null,
        memo: memo.trim() || null,
        categoryId: categoryId || null,
        direction,
        estimateMethod,
        amount: amt,
        frequency,
        dayOfMonth,
        startDate: new Date(startDate).toISOString(),
        endDate: endDate ? new Date(endDate).toISOString() : null,
        autoCreate,
        isActive: true,
      };
      if (isEdit) {
        return apiFetch(`/finance/recurring/${editRule!.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      }
      const created = await apiFetch<{ id: string }>("/finance/recurring", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (postNow && created?.id) {
        await apiFetch(`/finance/recurring/${created.id}/post-next`, {
          method: "POST",
        });
      }
      return created;
    },
    onSuccess: () => onComplete(),
    onError: (e: any) => setError(e?.message || (isEdit ? "Failed to update rule." : "Failed to create rule.")),
  });

  const deleteRule = useMutation({
    mutationFn: () =>
      apiFetch(`/finance/recurring/${editRule!.id}`, { method: "DELETE" }),
    onSuccess: () => onComplete(),
    onError: (e: any) => setError(e?.message || "Failed to delete rule."),
  });

  const inputCls =
    "h-9 px-2.5 rounded-md bg-background border border-input text-sm";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4">
      <div className="w-full max-w-lg bg-card border border-border rounded-xl shadow-lg max-h-[90vh] overflow-y-auto">
        <header className="sticky top-0 bg-card border-b border-border px-5 py-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{isEdit ? "Edit recurring rule" : "Make recurring"}</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </header>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">Rule name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${inputCls} w-full`}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Payee</label>
              <VendorCombobox
                organizationId={organizationId}
                value={payee}
                onChange={setPayee}
                onChangeId={(id) => {
                  setVendorId(id);
                  setPayeeUserEdited(!id);
                }}
                onMerged={() => qc.invalidateQueries({ queryKey: ["finance"] })}
                className={`${inputCls} w-full`}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Category</label>
              <CategorySelect
                organizationId={organizationId}
                value={categoryId}
                onChange={setCategoryId}
                className={`${inputCls} w-full`}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Memo</label>
            <input
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              className={`${inputCls} w-full`}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Bank account</label>
              <select
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
                className={`${inputCls} w-full`}
              >
                {usableAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.last4 ? ` ··${a.last4}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Direction</label>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as "debit" | "credit")}
                className={`${inputCls} w-full`}
              >
                <option value="debit">Payment (out)</option>
                <option value="credit">Deposit (in)</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Amount</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={`${inputCls} w-full text-right tabular-nums`}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Frequency</label>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as typeof frequency)}
                className={`${inputCls} w-full`}
              >
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every 2 weeks</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Yearly</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Day of month</label>
              <input
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) =>
                  setDayOfMonth(
                    Math.max(1, Math.min(31, Number(e.target.value) || 1))
                  )
                }
                className={`${inputCls} w-full`}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Start date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={`${inputCls} w-full`}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                End date <span className="text-muted-foreground">(optional)</span>
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={`${inputCls} w-full`}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoCreate}
              onChange={(e) => setAutoCreate(e.target.checked)}
            />
            Auto-create projected register entries
          </label>
          {!isEdit && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={postNow}
                onChange={(e) => setPostNow(e.target.checked)}
              />
              Post next entry now (creates a real register row dated today)
            </label>
          )}
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
          {confirmDelete && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 space-y-2">
              <p className="text-sm font-medium text-destructive">Delete this recurring rule?</p>
              <p className="text-xs text-muted-foreground">
                Existing projected entries linked to this rule won't be removed, but no new ones will be created.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  disabled={deleteRule.isPending}
                  onClick={() => deleteRule.mutate()}
                  className="h-8 px-3 rounded-md bg-destructive text-destructive-foreground text-xs font-semibold hover:bg-destructive/90 disabled:opacity-60 inline-flex items-center gap-1"
                >
                  {deleteRule.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Yes, delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="h-8 px-3 rounded-md hover:bg-secondary text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        <footer className="sticky bottom-0 bg-card border-t border-border px-5 py-3 flex items-center gap-2">
          {isEdit && !confirmDelete && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="h-9 px-3 rounded-md text-sm text-destructive hover:bg-destructive/10 inline-flex items-center gap-1.5"
            >
              <Trash2 size={13} />
              Delete rule
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3 rounded-md hover:bg-secondary text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => {
                setError(null);
                save.mutate();
              }}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {save.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
              {isEdit ? "Save changes" : "Create rule"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function InlineBlankRows({
  accountId,
  organizationId,
  accounts,
  rowCount,
  categories,
  defaultDate,
  showDatePicker,
  onSaved,
  onAllDismissed,
  onPartialChange,
}: {
  accountId: string;
  organizationId: string;
  accounts: BankAccount[];
  rowCount: number;
  categories: TransactionCategory[];
  defaultDate?: string;
  showDatePicker?: boolean;
  onSaved: () => void;
  onAllDismissed?: () => void;
  onPartialChange?: (hasPartial: boolean) => void;
}) {
  const [entries, setEntries] = useState<BlankRowEntry[]>(() =>
    Array.from({ length: Math.max(1, rowCount) }, (_, i) => ({
      key: i,
      initialValues: defaultDate
        ? { date: defaultDate, payee: "", memo: "", categoryId: "", payment: "", deposit: "" }
        : undefined,
    }))
  );
  const nextKeyRef = useRef(entries.length);
  const [latestKey, setLatestKey] = useState<number | null>(null);
  const partialKeysRef = useRef<Set<number>>(new Set());
  const onPartialChangeRef = useRef(onPartialChange);
  onPartialChangeRef.current = onPartialChange;

  function handlePartialChange(key: number, isPartial: boolean) {
    const prev = partialKeysRef.current.has(key);
    if (isPartial === prev) return;
    const next = new Set(partialKeysRef.current);
    if (isPartial) next.add(key);
    else next.delete(key);
    partialKeysRef.current = next;
    onPartialChangeRef.current?.(next.size > 0);
  }

  function handleSaved() {
    const newKey = nextKeyRef.current++;
    setEntries((prev) => [
      ...prev,
      {
        key: newKey,
        initialValues: defaultDate
          ? { date: defaultDate, payee: "", memo: "", categoryId: "", payment: "", deposit: "" }
          : undefined,
      },
    ]);
    setLatestKey(newKey);
    onSaved();
  }

  function handleDismiss(key: number, values: BlankRowValues) {
    handlePartialChange(key, false);
    setEntries((prev) => {
      const next = prev.filter((e) => e.key !== key);
      if (next.length === 0) onAllDismissed?.();
      return next;
    });
    const newKey = nextKeyRef.current++;
    toast({
      title: "Entry dismissed",
      duration: 5000,
      action: (
        <ToastAction
          altText="Undo"
          onClick={() =>
            setEntries((prev) => [...prev, { key: newKey, initialValues: values }])
          }
        >
          Undo
        </ToastAction>
      ),
    });
  }

  return (
    <>
      {entries.map((entry) => (
        <BlankRow
          key={entry.key}
          accountId={accountId}
          organizationId={organizationId}
          accounts={accounts}
          categories={categories}
          initialValues={entry.initialValues}
          autoFocus={entry.key === latestKey}
          showDatePicker={showDatePicker}
          onSaved={handleSaved}
          onDismiss={(values) => handleDismiss(entry.key, values)}
          onIsPartialChange={(partial) => handlePartialChange(entry.key, partial)}
        />
      ))}
    </>
  );
}

function BlankRow({
  accountId,
  organizationId,
  accounts,
  categories,
  autoFocus,
  initialValues,
  showDatePicker,
  onSaved,
  onDismiss,
  onIsPartialChange,
}: {
  accountId: string;
  organizationId: string;
  accounts: BankAccount[];
  categories: TransactionCategory[];
  autoFocus?: boolean;
  initialValues?: BlankRowValues;
  showDatePicker?: boolean;
  onSaved: () => void;
  onDismiss?: (values: BlankRowValues) => void;
  onIsPartialChange?: (isPartial: boolean) => void;
}) {
  const qc = useQueryClient();
  const rowRef = useRef<HTMLTableRowElement>(null);
  const dateRowRef = useRef<HTMLTableRowElement>(null);
  const [date, setDate] = useState(initialValues?.date ?? new Date().toISOString().slice(0, 10));
  const [checkNumber, setCheckNumber] = useState("");
  const [payee, setPayee] = useState(initialValues?.payee ?? "");
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [memo, setMemo] = useState(initialValues?.memo ?? "");
  const [categoryId, setCategoryId] = useState(initialValues?.categoryId ?? "");
  const [payment, setPayment] = useState(initialValues?.payment ?? "");
  const [deposit, setDeposit] = useState(initialValues?.deposit ?? "");
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recurringOpen, setRecurringOpen] = useState(false);

  useEffect(() => {
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const hasAmount =
    (Number(payment) || 0) > 0 || (Number(deposit) || 0) > 0;
  const ready = !!date && !!payee.trim() && hasAmount;
  const hasAnyData =
    !!payee.trim() || hasAmount || !!memo.trim() || !!categoryId;
  const isPartial = hasAnyData && !ready && !savedOnce;

  const onIsPartialChangeRef = useRef(onIsPartialChange);
  onIsPartialChangeRef.current = onIsPartialChange;
  useEffect(() => {
    onIsPartialChangeRef.current?.(isPartial);
  }, [isPartial]);
  useEffect(() => {
    return () => { onIsPartialChangeRef.current?.(false); };
  }, []);

  async function save() {
    if (!ready || saving || savedOnce) return;
    setError(null);
    setSaving(true);
    try {
      await apiFetch("/finance/transactions", {
        method: "POST",
        body: JSON.stringify({
          bankAccountId: accountId,
          txnDate: new Date(date).toISOString(),
          type: Number(deposit) > 0 ? "deposit" : "other",
          checkNumber: checkNumber.trim() || null,
          payee: payee.trim(),
          vendorId: vendorId || null,
          memo: memo.trim() || null,
          categoryId: categoryId || null,
          payment: Number(payment) || 0,
          deposit: Number(deposit) || 0,
          cleared: false,
          invoiceIds: [],
        }),
      });
      setSavedOnce(true);
      onSaved();
    } catch (e: any) {
      setError(e?.message || "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  function handleBlur(e: React.FocusEvent<HTMLTableRowElement>) {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    if (showDatePicker && next && dateRowRef.current?.contains(next)) return;
    if (ready) void save();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  }

  function currentValues(): BlankRowValues {
    return { date, payee, memo, categoryId, payment, deposit };
  }

  function onRowKeyDownCapture(e: React.KeyboardEvent<HTMLTableRowElement>) {
    if (e.key === "Escape" && !savedOnce) {
      e.preventDefault();
      e.stopPropagation();
      onDismiss?.(currentValues());
    }
  }

  const inputCls =
    "w-full h-7 px-2 rounded bg-background border border-input text-sm";

  return (
    <>
      {showDatePicker && (
        <tr ref={dateRowRef} className="border-t border-border bg-secondary/10">
          <td colSpan={9} className="px-4 pt-1.5 pb-0">
            <div className="inline-flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground uppercase tracking-wide font-medium">
                Date
              </span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                disabled={savedOnce}
                className="h-6 px-2 rounded bg-background border border-input text-xs tabular-nums"
              />
            </div>
          </td>
        </tr>
      )}
      <tr
        ref={rowRef}
        className={`${showDatePicker ? "" : "border-t border-border "}bg-secondary/10 transition-shadow${isPartial ? " shadow-[inset_3px_0_0_0_#fbbf24]" : ""}`}
        onBlur={handleBlur}
        onKeyDownCapture={onRowKeyDownCapture}
      >
        {/* Date (col 0) */}
        <td className="px-4 py-1.5">
          {!showDatePicker && (
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={savedOnce}
              className="h-6 px-1 rounded bg-background border border-input text-xs tabular-nums w-full"
            />
          )}
        </td>
        {/* Num / Check# (col 1) */}
        <td className="py-1.5 px-3">
          <input
            type="text"
            value={checkNumber}
            onChange={(e) => setCheckNumber(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Num"
            disabled={savedOnce}
            className={`${inputCls} font-mono`}
          />
        </td>
        {/* Payee — VendorCombobox typeahead (col 2) */}
        <td className="py-1.5 px-3">
          <VendorCombobox
            organizationId={organizationId}
            value={payee}
            onChange={setPayee}
            onChangeId={setVendorId}
            onMerged={() => qc.invalidateQueries({ queryKey: ["finance"] })}
            placeholder="Payee"
            disabled={savedOnce}
            className={inputCls}
          />
        </td>
        {/* Account / Category — CategorySelect typeahead (col 3) */}
        <td className="py-1.5 px-3">
          <CategorySelect
            organizationId={organizationId}
            value={categoryId}
            onChange={setCategoryId}
            onKeyDown={onKeyDown}
            disabled={savedOnce}
            className={inputCls}
          />
        </td>
        {/* Payment (col 4) */}
        <td className="py-1.5 px-3">
          <input
            type="number"
            step="0.01"
            min="0"
            value={payment}
            onChange={(e) => setPayment(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="0.00"
            disabled={savedOnce}
            className={`${inputCls} text-right tabular-nums`}
          />
        </td>
        {/* ✓ — partial indicator (fixed col) */}
        <td className="py-1.5 text-center">
          {isPartial && (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse"
              title="Unsaved — fill in date, payee, and an amount to save"
            />
          )}
        </td>
        {/* Deposit (col 5) */}
        <td className="py-1.5 px-3">
          <input
            type="number"
            step="0.01"
            min="0"
            value={deposit}
            onChange={(e) => setDeposit(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="0.00"
            disabled={savedOnce}
            className={`${inputCls} text-right tabular-nums`}
          />
        </td>
        {/* Balance — empty for new rows (col 6) */}
        <td className="px-4 py-1.5 text-right text-xs text-muted-foreground italic">
          {savedOnce ? "saved" : ""}
        </td>
        {/* Actions (fixed col) */}
        <td className="px-2 py-1.5">
          <div className="flex items-center gap-1">
            {ready && !savedOnce && (
              <button
                type="button"
                onClick={() => setRecurringOpen(true)}
                className="h-7 w-7 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary"
                aria-label="Make recurring"
                title="Make recurring"
              >
                <Repeat size={13} />
              </button>
            )}
            <button
              type="button"
              onClick={save}
              disabled={!ready || saving || savedOnce}
              className="h-7 px-2 rounded bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-40 inline-flex items-center gap-1"
              aria-label="Save row"
              title={savedOnce ? "Saved" : "Save row"}
            >
              {saving ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <CheckCircle2 size={11} />
              )}
            </button>
            {!savedOnce && onDismiss && (
              <button
                type="button"
                onClick={() => onDismiss(currentValues())}
                className="h-7 w-7 rounded inline-flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-secondary"
                aria-label="Dismiss row"
                title="Dismiss"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={9} className="px-4 py-1 text-xs text-destructive">
            {error}
          </td>
        </tr>
      )}
      {recurringOpen && (
        <MakeRecurringDialog
          organizationId={organizationId}
          accounts={accounts}
          categories={categories}
          source={{
            payee: payee.trim() || null,
            memo: memo.trim() || null,
            categoryId: categoryId || null,
            bankAccountId: accountId,
            txnDate: new Date(date).toISOString(),
            debitAmount: Number(payment) || 0,
            creditAmount: Number(deposit) || 0,
          }}
          onClose={() => setRecurringOpen(false)}
          onComplete={() => {
            setRecurringOpen(false);
            qc.invalidateQueries({ queryKey: ["finance"] });
          }}
        />
      )}
    </>
  );
}

function InlineDateCell({
  txn,
  onUpdated,
}: {
  txn: BankTransaction;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(toInputDate(txn.txnDate));
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(toInputDate(txn.txnDate));
  }, [txn.txnDate]);

  const canEdit = !txn.reconciled;

  async function commit(newDate: string) {
    const original = toInputDate(txn.txnDate);
    setEditing(false);
    if (!newDate || newDate === original) return;
    setSaving(true);
    try {
      await apiFetch(`/finance/transactions/${txn.id}`, {
        method: "PATCH",
        body: JSON.stringify({ txnDate: new Date(newDate).toISOString() }),
      });
      onUpdated();
    } catch (e: any) {
      setValue(original);
      toast({
        title: "Date not saved",
        description: e?.message || "Failed to update the transaction date.",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setSaving(false);
    }
  }

  function handleClick() {
    if (!canEdit || saving) return;
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    void commit(e.currentTarget.value);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commit(e.currentTarget.value);
    }
    if (e.key === "Escape") {
      setValue(toInputDate(txn.txnDate));
      setEditing(false);
    }
  }

  if (saving) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
        <Loader2 size={11} className="animate-spin" />
        saving…
      </span>
    );
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="date"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className="h-6 px-1 rounded bg-background border border-primary text-xs tabular-nums w-full focus:outline-none"
      />
    );
  }

  return (
    <span
      onClick={canEdit ? handleClick : undefined}
      className={`text-xs tabular-nums block truncate ${
        canEdit
          ? "cursor-pointer hover:text-primary transition-colors"
          : "text-muted-foreground cursor-default"
      }`}
      title={canEdit ? "Click to edit date" : "Reconciled — date is locked"}
    >
      {formatDate(txn.txnDate)}
    </span>
  );
}

function TransferDialog({
  accounts,
  defaultFromAccountId,
  onClose,
  onComplete,
}: {
  accounts: BankAccount[];
  defaultFromAccountId: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [fromAccountId, setFromAccountId] = useState(defaultFromAccountId);
  const [toAccountId, setToAccountId] = useState(
    accounts.find((a) => a.id !== defaultFromAccountId)?.id || ""
  );
  const [amount, setAmount] = useState("0");
  const [txnDate, setTxnDate] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      apiFetch("/finance/transactions/transfer", {
        method: "POST",
        body: JSON.stringify({
          fromAccountId,
          toAccountId,
          amount: Number(amount),
          txnDate: new Date(txnDate).toISOString(),
          memo: memo || null,
        }),
      }),
    onSuccess: () => {
      onComplete();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function submit() {
    setError(null);
    if (!fromAccountId || !toAccountId) {
      setError("Pick both a source and destination account.");
      return;
    }
    if (fromAccountId === toAccountId) {
      setError("From and to accounts must differ.");
      return;
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    save.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-foreground/30">
      <div className="w-full max-w-md bg-card border-l border-border h-full overflow-y-auto scrollbar-thin">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-6 py-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">New transfer</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>
        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Creates two linked register entries — a withdrawal from the source
            account and a matching deposit to the destination — in a single
            atomic operation. Transfers are excluded from cash flow revenue and
            expense totals.
          </p>
          <Field label="From account">
            <select
              value={fromAccountId}
              onChange={(e) => setFromAccountId(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="To account">
            <select
              value={toAccountId}
              onChange={(e) => setToAccountId(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            >
              <option value="">— Select —</option>
              {accounts
                .filter((a) => a.id !== fromAccountId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount">
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm text-right tabular-nums"
              />
            </Field>
            <Field label="Date">
              <input
                type="date"
                value={txnDate}
                onChange={(e) => setTxnDate(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
            </Field>
          </div>
          <Field label="Memo">
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Optional"
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            />
          </Field>
          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={submit}
              disabled={save.isPending}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              <ArrowLeftRight size={14} />
              {save.isPending ? "Recording…" : "Record transfer"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-4 rounded-md text-sm hover:bg-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value?: string | number | null;
  tone?: "neutral" | "info" | "warning";
}) {
  const v = Number(value ?? 0);
  const color =
    tone === "warning"
      ? "text-amber-600 dark:text-amber-400"
      : tone === "info"
      ? "text-sky-600 dark:text-sky-400"
      : "text-foreground";
  return (
    <div className="bg-card border border-border rounded-xl px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
        {label}
      </div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>
        {formatMoney(v)}
      </div>
    </div>
  );
}

function InlineEditRow({
  organizationId,
  accountId,
  existing,
  categories,
  colSpan,
  onClose,
  onSaved,
}: {
  organizationId: string;
  accountId: string;
  existing: BankTransaction;
  categories: TransactionCategory[];
  colSpan: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [txnDate, setTxnDate] = useState(toInputDate(existing.txnDate));
  const [checkNumber, setCheckNumber] = useState(existing.checkNumber || "");
  const [payee, setPayee] = useState(existing.payee || "");
  const [vendorId, setVendorId] = useState<string | null>(existing.vendorId ?? null);
  const [memo, setMemo] = useState(existing.memo || "");
  const [categoryId, setCategoryId] = useState(existing.categoryId || "");
  const [payment, setPayment] = useState(Number(existing.debitAmount).toString());
  const [deposit, setDeposit] = useState(Number(existing.creditAmount).toString());
  const [cleared, setCleared] = useState(existing.cleared ?? false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/finance/transactions/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          bankAccountId: accountId,
          txnDate: new Date(txnDate).toISOString(),
          checkNumber: checkNumber || null,
          payee: payee || null,
          vendorId: vendorId || null,
          memo: memo || null,
          categoryId: categoryId || null,
          payment: Number(payment) || 0,
          deposit: Number(deposit) || 0,
          cleared,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["finance"] });
      onSaved();
    },
    onError: (e: Error) => setError(e.message),
  });

  const inputCls = "h-7 px-2 rounded bg-background border border-input text-xs w-full";

  return (
    <tr className="bg-secondary/20 border-t border-border/30">
      <td colSpan={colSpan} className="px-4 py-2.5">
        <div className="flex flex-wrap items-end gap-2">
          {/* Date */}
          <div className="flex flex-col gap-0.5 min-w-[96px]">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Date</label>
            <input type="date" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} className={inputCls} />
          </div>
          {/* Num */}
          <div className="flex flex-col gap-0.5 min-w-[64px]">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Num</label>
            <input type="text" value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} placeholder="—" className={`${inputCls} font-mono`} />
          </div>
          {/* Payee */}
          <div className="flex flex-col gap-0.5 min-w-[140px] flex-1">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Payee</label>
            <VendorCombobox
              organizationId={organizationId}
              value={payee}
              onChange={setPayee}
              onChangeId={setVendorId}
              onMerged={() => qc.invalidateQueries({ queryKey: ["finance"] })}
              className={inputCls}
            />
          </div>
          {/* Memo */}
          <div className="flex flex-col gap-0.5 min-w-[120px] flex-1">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Memo</label>
            <input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="—" className={inputCls} />
          </div>
          {/* Account */}
          <div className="flex flex-col gap-0.5 min-w-[130px] flex-1">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Account</label>
            <CategorySelect
              organizationId={organizationId}
              value={categoryId}
              onChange={setCategoryId}
              className={inputCls}
            />
          </div>
          {/* Payment */}
          <div className="flex flex-col gap-0.5 min-w-[80px]">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Payment</label>
            <input type="number" step="0.01" min="0" value={payment} onChange={(e) => setPayment(e.target.value)} placeholder="0.00" className={`${inputCls} text-right tabular-nums`} />
          </div>
          {/* Deposit */}
          <div className="flex flex-col gap-0.5 min-w-[80px]">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Deposit</label>
            <input type="number" step="0.01" min="0" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="0.00" className={`${inputCls} text-right tabular-nums`} />
          </div>
          {/* Cleared */}
          <div className="flex flex-col gap-0.5 items-center min-w-[40px]">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">✓</label>
            <input type="checkbox" checked={cleared} onChange={(e) => setCleared(e.target.checked)} className="h-4 w-4 mt-1" />
          </div>
          {/* Actions */}
          <div className="flex flex-col gap-0.5">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium invisible">Act</label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="h-7 px-2.5 rounded bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1"
              >
                {save.isPending ? <Loader2 size={10} className="animate-spin" /> : <CheckCircle2 size={10} />}
                Save
              </button>
              <button
                type="button"
                onClick={onClose}
                className="h-7 w-7 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        </div>
        {error && <div className="mt-1 text-xs text-destructive">{error}</div>}
        {existing.depositedAt && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 rounded px-2.5 py-1.5">
            <Landmark size={11} className="text-sky-500 shrink-0" />
            <span>
              Deposited{" "}
              {existing.depositedByName ? (
                <>by <span className="font-medium text-foreground">{existing.depositedByName}</span>{" "}</>
              ) : null}
              on{" "}
              <span className="font-medium text-foreground">
                {formatDate(existing.depositedAt)}
              </span>
            </span>
          </div>
        )}
      </td>
    </tr>
  );
}

function TxnEditor({
  organizationId,
  accountId,
  accounts,
  existing,
  categories,
  onClose,
}: {
  organizationId: string;
  accountId: string;
  accounts: BankAccount[];
  existing: BankTransaction | null;
  categories: TransactionCategory[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [showRecurring, setShowRecurring] = useState(false);
  const [editRuleData, setEditRuleData] = useState<RecurringRule | null>(null);
  const [fetchingRule, setFetchingRule] = useState(false);
  const [txnDate, setTxnDate] = useState<string>(
    existing ? toInputDate(existing.txnDate) : new Date().toISOString().slice(0, 10)
  );
  const [type, setType] = useState(existing?.type || "other");
  const [checkNumber, setCheckNumber] = useState(existing?.checkNumber || "");
  const [payee, setPayee] = useState(existing?.payee || "");
  const [vendorId, setVendorId] = useState<string | null>(existing?.vendorId ?? null);
  const [memo, setMemo] = useState(existing?.memo || "");
  const [categoryId, setCategoryId] = useState(existing?.categoryId || "");
  const [payment, setPayment] = useState<string>(
    existing ? Number(existing.debitAmount).toString() : "0"
  );
  const [deposit, setDeposit] = useState<string>(
    existing ? Number(existing.creditAmount).toString() : "0"
  );
  const [cleared, setCleared] = useState(existing?.cleared ?? false);
  const [invoiceIds, setInvoiceIds] = useState<string[]>(
    (existing?.invoices ?? []).map((i) => i.invoiceId)
  );
  const [error, setError] = useState<string | null>(null);

  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<Invoice[]>("/invoices"),
  });
  const orgInvoices = useMemo(
    () =>
      (invoicesQuery.data ?? []).filter(
        (i) => i.labOrganizationId === organizationId
      ),
    [invoicesQuery.data, organizationId]
  );
  const invoiceById = useMemo(
    () => new Map(orgInvoices.map((i) => [i.id, i])),
    [orgInvoices]
  );

  const save = useMutation({
    mutationFn: () => {
      const body = {
        bankAccountId: accountId,
        txnDate: new Date(txnDate).toISOString(),
        type,
        checkNumber: checkNumber || null,
        payee: payee || null,
        vendorId: vendorId || null,
        memo: memo || null,
        categoryId: categoryId || null,
        payment: Number(payment) || 0,
        deposit: Number(deposit) || 0,
        cleared,
        invoiceIds,
      };
      const path = existing
        ? `/finance/transactions/${existing.id}`
        : "/finance/transactions";
      return apiFetch(path, {
        method: existing ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["finance"] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-foreground/30">
      <div className="w-full max-w-md bg-card border-l border-border h-full overflow-y-auto scrollbar-thin">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-6 py-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {existing ? "Edit transaction" : "Add transaction"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>
        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
          <Field label="Date">
            <input
              type="date"
              value={txnDate}
              onChange={(e) => setTxnDate(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              >
                {[
                  "check",
                  "deposit",
                  "withdraw",
                  "transfer",
                  "fee",
                  "payment",
                  "other",
                ].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Check #">
              <input
                type="text"
                value={checkNumber}
                onChange={(e) => setCheckNumber(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm font-mono"
              />
            </Field>
          </div>
          <Field label="Payee">
            <VendorCombobox
              organizationId={organizationId}
              value={payee}
              onChange={setPayee}
              onChangeId={setVendorId}
              onMerged={() => qc.invalidateQueries({ queryKey: ["finance"] })}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            />
          </Field>
          <Field label="Memo">
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            />
          </Field>
          <Field label="Category">
            <CategorySelect
              organizationId={organizationId}
              value={categoryId}
              onChange={setCategoryId}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Payment">
              <input
                type="number"
                step="0.01"
                min="0"
                value={payment}
                onChange={(e) => setPayment(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm text-right tabular-nums"
              />
            </Field>
            <Field label="Deposit">
              <input
                type="number"
                step="0.01"
                min="0"
                value={deposit}
                onChange={(e) => setDeposit(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm text-right tabular-nums"
              />
            </Field>
          </div>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={cleared}
              onChange={(e) => setCleared(e.target.checked)}
            />
            Mark as cleared
          </label>
          <Field label="Linked invoices">
            <div className="space-y-2">
              {invoiceIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {invoiceIds.map((id) => {
                    const inv = invoiceById.get(id);
                    return (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-secondary text-xs font-mono"
                      >
                        {inv?.invoiceNumber || id}
                        <button
                          type="button"
                          onClick={() =>
                            setInvoiceIds((prev) =>
                              prev.filter((x) => x !== id)
                            )
                          }
                          className="text-muted-foreground hover:text-destructive"
                          aria-label="Remove link"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              <select
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v && !invoiceIds.includes(v)) {
                    setInvoiceIds((prev) => [...prev, v]);
                  }
                }}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              >
                <option value="">— Add an invoice link —</option>
                {orgInvoices
                  .filter((i) => !invoiceIds.includes(i.id))
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.invoiceNumber} ·{" "}
                      {i.providerOrganization?.name || "—"} ·{" "}
                      {i.status}
                    </option>
                  ))}
              </select>
            </div>
          </Field>
          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              <CheckCircle2 size={14} />
              {save.isPending ? "Saving…" : existing ? "Save changes" : "Add entry"}
            </button>
            {existing?.recurringRuleId ? (
              <button
                type="button"
                disabled={fetchingRule}
                onClick={async () => {
                  setFetchingRule(true);
                  try {
                    const rule = await apiFetch<RecurringRule>(
                      `/finance/recurring/${existing.recurringRuleId}`
                    );
                    setEditRuleData(rule);
                  } catch {
                    setError("Could not load recurring rule.");
                  } finally {
                    setFetchingRule(false);
                  }
                }}
                className="h-9 px-4 rounded-md text-sm hover:bg-secondary inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                {fetchingRule ? <Loader2 size={14} className="animate-spin" /> : <Repeat size={14} />}
                Edit rule
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowRecurring(true)}
                className="h-9 px-4 rounded-md text-sm hover:bg-secondary inline-flex items-center gap-1.5"
              >
                <Repeat size={14} />
                Recurring
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-4 rounded-md text-sm hover:bg-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
      {showRecurring && (
        <MakeRecurringDialog
          organizationId={organizationId}
          accounts={accounts}
          categories={categories}
          source={{
            payee: payee || null,
            memo: memo || null,
            categoryId: categoryId || null,
            bankAccountId: accountId,
            txnDate: txnDate,
            debitAmount: payment,
            creditAmount: deposit,
          }}
          onClose={() => setShowRecurring(false)}
          onComplete={() => setShowRecurring(false)}
        />
      )}
      {editRuleData && (
        <MakeRecurringDialog
          organizationId={organizationId}
          accounts={accounts}
          categories={categories}
          source={{
            payee: payee || null,
            memo: memo || null,
            categoryId: categoryId || null,
            bankAccountId: accountId,
            txnDate: txnDate,
            debitAmount: payment,
            creditAmount: deposit,
          }}
          editRule={editRuleData}
          onClose={() => setEditRuleData(null)}
          onComplete={() => {
            setEditRuleData(null);
            qc.invalidateQueries({ queryKey: ["finance"] });
          }}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="block text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function ImportDialog({
  accountId,
  onClose,
  onComplete,
}: {
  accountId: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<
    Array<{ date: string; payee: string; memo: string; amount: number; checkNumber?: string }>
  >([]);
  const [windowDays, setWindowDays] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ matched: number; created: number; total: number } | null>(
    null
  );

  function handleFile(file: File) {
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const rows = parseCsv(text);
        if (!rows.length) {
          setError("No rows found in file.");
          return;
        }
        const header = rows[0].map((h) => h.toLowerCase().trim());
        const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
        const dateIdx = idx(["date", "transaction date", "posted date"]);
        const amountIdx = idx(["amount", "value"]);
        const debitIdx = idx(["debit", "withdrawal", "withdrawals"]);
        const creditIdx = idx(["credit", "deposit", "deposits"]);
        const payeeIdx = idx(["payee", "description", "name", "merchant"]);
        const memoIdx = idx(["memo", "notes", "note"]);
        const checkIdx = idx(["check", "check #", "check number", "check no"]);
        if (dateIdx < 0 || (amountIdx < 0 && debitIdx < 0 && creditIdx < 0)) {
          setError(
            "CSV needs at least a Date column and Amount (or Debit/Credit) columns."
          );
          return;
        }
        const out = rows.slice(1).map((cells) => {
          let amount = 0;
          if (amountIdx >= 0) amount = Number((cells[amountIdx] || "0").replace(/[$,]/g, ""));
          else {
            const d = Number((cells[debitIdx] || "0").replace(/[$,]/g, ""));
            const c = Number((cells[creditIdx] || "0").replace(/[$,]/g, ""));
            amount = (c || 0) - (d || 0);
          }
          return {
            date: cells[dateIdx] || "",
            payee: payeeIdx >= 0 ? cells[payeeIdx] || "" : "",
            memo: memoIdx >= 0 ? cells[memoIdx] || "" : "",
            amount,
            checkNumber: checkIdx >= 0 ? cells[checkIdx] || "" : "",
          };
        });
        setParsed(out.filter((r) => r.date && !Number.isNaN(r.amount)));
      } catch (e: any) {
        setError(e?.message || "Failed to read CSV.");
      }
    };
    reader.readAsText(file);
  }

  const importMut = useMutation({
    mutationFn: () =>
      apiFetch<{ matched: number; created: number; total: number }>(
        "/finance/transactions/import",
        {
          method: "POST",
          body: JSON.stringify({ bankAccountId: accountId, windowDays, rows: parsed }),
        }
      ),
    onSuccess: (r) => {
      setResult(r);
      onComplete();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-foreground/30">
      <div className="w-full max-w-2xl bg-card border-l border-border h-full overflow-y-auto scrollbar-thin">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-6 py-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Import bank statement (CSV)</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 rounded-md hover:bg-secondary flex items-center justify-center"
          >
            <X size={16} />
          </button>
        </header>
        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
          {result ? (
            <div className="space-y-3">
              <div className="text-sm">
                Imported {result.total} rows: <strong>{result.matched}</strong> matched
                existing entries (marked cleared) and <strong>{result.created}</strong> new
                entries created.
              </div>
              <button
                type="button"
                onClick={onClose}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                  className="text-sm"
                />
                <label className="text-sm text-muted-foreground inline-flex items-center gap-2">
                  Match window:
                  <input
                    type="number"
                    value={windowDays}
                    min={0}
                    max={30}
                    onChange={(e) => setWindowDays(Math.max(0, Number(e.target.value) || 0))}
                    className="w-16 h-8 px-2 rounded bg-background border border-input text-sm text-right"
                  />
                  days
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                Expected columns: Date, Amount (or Debit/Credit), Payee/Description,
                optional Memo and Check #.
              </p>
              {parsed.length > 0 && (
                <>
                  <div className="text-sm font-medium">
                    Preview ({parsed.length} rows)
                  </div>
                  <div className="border border-border rounded-md overflow-hidden max-h-72 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-2">Date</th>
                          <th className="text-left px-3 py-2">Payee</th>
                          <th className="text-right px-3 py-2">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parsed.slice(0, 50).map((r, i) => (
                          <tr key={i} className="border-t border-border">
                            <td className="px-3 py-1.5">{r.date}</td>
                            <td className="px-3 py-1.5 truncate max-w-[260px]">
                              {r.payee}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {formatMoney(r.amount)}
                            </td>
                          </tr>
                        ))}
                        {parsed.length > 50 && (
                          <tr>
                            <td colSpan={3} className="px-3 py-2 text-center text-muted-foreground">
                              + {parsed.length - 50} more rows…
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => importMut.mutate()}
                      disabled={importMut.isPending}
                      className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
                    >
                      {importMut.isPending ? "Importing…" : `Import ${parsed.length} rows`}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setParsed([]);
                        if (fileRef.current) fileRef.current.value = "";
                      }}
                      className="h-9 px-4 rounded-md text-sm hover:bg-secondary"
                    >
                      Clear
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) out.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length) {
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) out.push(row);
  }
  return out;
}

function toInputDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}
