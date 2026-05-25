import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Ban, CheckCircle2, Download, Loader2, Plus, Repeat, Search, Trash2, Upload, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FinanceShell } from "@/components/finance/FinanceShell";
import { TYPE_BADGE_CLASS, TYPE_LABEL, useVendors, VendorCombobox } from "@/components/finance/VendorCombobox";
import { CategorySelect } from "@/components/finance/CategorySelect";
import type { BankAccount, BankTransaction, Invoice, RecurringRule, TransactionCategory } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { useColumnWidths } from "@/hooks/useColumnWidths";

// 9 resizable columns in body order: Date(0)…Deposit(7), then Balance(8) after fixed Clr/Rec
const FINANCE_COL_DEFAULTS = [100, 90, 80, 160, 130, 180, 100, 100, 110] as const;
const FINANCE_FIXED_CLR = 48;
const FINANCE_FIXED_REC = 48;
const FINANCE_FIXED_ACTIONS = 80;
// Labels for the first 8 resizable columns (before Clr/Rec in body order)
const FINANCE_PRE_LABELS = ["Date", "Type", "Check #", "Payee", "Category", "Memo", "Payment", "Deposit"] as const;

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
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BankTransaction | null>(null);
  const [blankRowKeys, setBlankRowKeys] = useState<number[]>([]);
  const nextBlankKeyRef = useRef(0);
  const [importing, setImporting] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [recurringFor, setRecurringFor] = useState<BankTransaction | null>(null);

  const account = accounts.find((a) => a.id === accountId);

  const { widths: colWidths, totalWidth: colTotalWidth, resizingCol, startResize, resetColumn } =
    useColumnWidths([...FINANCE_COL_DEFAULTS], "labtrax_finance_col_widths_v1");

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
  const vendorTypeByName = useMemo(
    () => new Map((vendorsQuery.data ?? []).map((v) => [v.name, v.vendorType])),
    [vendorsQuery.data]
  );

  const clearMut = useMutation({
    mutationFn: ({ id, cleared }: { id: string; cleared: boolean }) =>
      apiFetch(`/finance/transactions/${id}/clear`, {
        method: "POST",
        body: JSON.stringify({ cleared }),
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
          <button
            type="button"
            onClick={() =>
              setBlankRowKeys((prev) => [...prev, nextBlankKeyRef.current++])
            }
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 inline-flex items-center gap-1.5"
          >
            <Plus size={14} /> Add entry
          </button>
        </div>

        <div className="overflow-x-auto relative">
          {resizingCol !== null && (
            <div
              className="bg-primary/50 pointer-events-none absolute top-0 bottom-0 z-10"
              style={{
                left:
                  resizingCol <= 7
                    ? colWidths.slice(0, resizingCol + 1).reduce((a, b) => a + b, 0) - 1
                    : colWidths.slice(0, 8).reduce((a, b) => a + b, 0) +
                      FINANCE_FIXED_CLR +
                      FINANCE_FIXED_REC +
                      colWidths[8] -
                      1,
                width: 2,
              }}
            />
          )}
          <table
            className="text-sm"
            style={{
              tableLayout: "fixed",
              width: colTotalWidth + FINANCE_FIXED_CLR + FINANCE_FIXED_REC + FINANCE_FIXED_ACTIONS,
              userSelect: "none",
            }}
          >
            <colgroup>
              {/* cols 0-7: resizable Date→Deposit */}
              {colWidths.slice(0, 8).map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
              {/* col 8: fixed Clr */}
              <col style={{ width: FINANCE_FIXED_CLR }} />
              {/* col 9: fixed Rec */}
              <col style={{ width: FINANCE_FIXED_REC }} />
              {/* col 10: resizable Balance */}
              <col style={{ width: colWidths[8] }} />
              {/* col 11: fixed Actions */}
              <col style={{ width: FINANCE_FIXED_ACTIONS }} />
            </colgroup>
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                {/* First 8 resizable columns: Date → Deposit */}
                {FINANCE_PRE_LABELS.map((label, i) => {
                  const isRight = i === 6 || i === 7;
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
                {/* Fixed: Clr, Rec */}
                <th className="text-center font-medium py-2">Clr</th>
                <th className="text-center font-medium py-2">Rec</th>
                {/* Resizable: Balance (index 8) */}
                <th
                  className="font-medium px-4 py-2 relative text-right"
                  style={{ overflow: "hidden" }}
                >
                  Balance
                  <div
                    onMouseDown={(e) => startResize(8, e)}
                    onDoubleClick={() => resetColumn(8)}
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
                      className={`w-0.5 transition-colors duration-100 ${resizingCol === 8 ? "bg-primary" : "bg-border/60 group-hover/resize:bg-primary/50"}`}
                      style={{ display: "block", height: "100%" }}
                    />
                  </div>
                </th>
                {/* Fixed: Actions */}
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {txnsQuery.isLoading && (
                <tr>
                  <td colSpan={12} className="px-5 py-12 text-center text-muted-foreground">
                    <Loader2 size={16} className="inline animate-spin mr-2" />
                    Loading register…
                  </td>
                </tr>
              )}
              {txnsQuery.data?.length === 0 && !txnsQuery.isLoading && (
                <tr>
                  <td colSpan={12} className="px-5 py-12 text-center text-muted-foreground">
                    No transactions match the current filters.
                  </td>
                </tr>
              )}
              {(txnsQuery.data || []).map((r) => {
                const debit = Number(r.debitAmount);
                const credit = Number(r.creditAmount);
                const isVoid = r.status === "void";
                const isProjected = r.status === "projected";
                return (
                  <tr
                    key={r.id}
                    onClick={() => setEditing(r)}
                    className={`border-t border-border cursor-pointer hover:bg-secondary/30 ${
                      isVoid ? "text-muted-foreground line-through" : ""
                    } ${isProjected ? "italic text-muted-foreground" : ""}`}
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {formatDate(r.txnDate)}
                    </td>
                    <td className="py-2.5 capitalize">{r.type}</td>
                    <td className="py-2.5 font-mono text-xs">{r.checkNumber || "—"}</td>
                    <td className="py-2.5">
                      {r.payee ? (
                        <span className="flex items-center gap-1.5 min-w-0">
                          {vendorTypeByName.has(r.payee) && (
                            <span
                              className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${TYPE_BADGE_CLASS[vendorTypeByName.get(r.payee)!]}`}
                            >
                              {TYPE_LABEL[vendorTypeByName.get(r.payee)!]}
                            </span>
                          )}
                          <span className="truncate">{r.payee}</span>
                        </span>
                      ) : "—"}
                    </td>
                    <td className="py-2.5 text-muted-foreground">
                      {r.categoryId ? catNameById.get(r.categoryId) || "—" : "—"}
                    </td>
                    <td className="py-2.5 text-muted-foreground truncate max-w-[180px]">
                      {r.memo || ""}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {debit > 0 ? formatMoney(debit) : ""}
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {credit > 0 ? formatMoney(credit) : ""}
                    </td>
                    <td
                      className="py-2.5 text-center"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isVoid) return;
                        clearMut.mutate({ id: r.id, cleared: !r.cleared });
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={r.cleared}
                        readOnly
                        className="h-3.5 w-3.5 cursor-pointer"
                      />
                    </td>
                    <td className="py-2.5 text-center text-muted-foreground">
                      {r.reconciled ? "✓" : ""}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      {formatMoney(r.runningBalance ?? 0)}
                    </td>
                    <td
                      className="px-2 py-2.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-end gap-0.5">
                        {!isVoid && (
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
                        {!r.reconciled && !isVoid && (
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
                        {!r.reconciled && (
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
                );
              })}
              {blankRowKeys.map((k, i) => (
                <BlankRow
                  key={k}
                  accountId={accountId}
                  organizationId={organizationId}
                  accounts={accounts}
                  categories={cats.data || []}
                  autoFocus={i === blankRowKeys.length - 1}
                  onSaved={() =>
                    qc.invalidateQueries({ queryKey: ["finance"] })
                  }
                  onDismiss={() =>
                    setBlankRowKeys((prev) => prev.filter((id) => id !== k))
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(adding || editing) && (
        <TxnEditor
          organizationId={organizationId}
          accountId={accountId}
          accounts={accounts}
          existing={editing}
          categories={cats.data || []}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}

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

  const debit = Number(source.debitAmount);
  const credit = Number(source.creditAmount);
  const initialDirection: "debit" | "credit" = isEdit
    ? editRule!.direction
    : credit > 0 ? "credit" : "debit";
  const initialAmount = isEdit
    ? Number(editRule!.amount || 0).toFixed(2)
    : (initialDirection === "credit" ? credit : debit || 0).toFixed(2);
  const today = new Date().toISOString().slice(0, 10);

  const [name, setName] = useState(
    isEdit
      ? editRule!.name
      : source.payee || `Recurring ${initialDirection === "credit" ? "deposit" : "payment"}`
  );
  const [payee, setPayee] = useState(isEdit ? (editRule!.payee || "") : (source.payee || ""));
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
  onSaved,
}: {
  accountId: string;
  organizationId: string;
  accounts: BankAccount[];
  rowCount: number;
  categories: TransactionCategory[];
  onSaved: () => void;
}) {
  const [keys, setKeys] = useState<number[]>(() =>
    Array.from({ length: Math.max(1, rowCount) }, (_, i) => i)
  );
  const nextKeyRef = useRef(keys.length);

  function handleSaved() {
    setKeys((prev) => [...prev, nextKeyRef.current++]);
    onSaved();
  }

  return (
    <>
      {keys.map((k) => (
        <BlankRow
          key={k}
          accountId={accountId}
          organizationId={organizationId}
          accounts={accounts}
          categories={categories}
          onSaved={handleSaved}
          onDismiss={() => setKeys((prev) => prev.filter((id) => id !== k))}
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
  onSaved,
  onDismiss,
}: {
  accountId: string;
  organizationId: string;
  accounts: BankAccount[];
  categories: TransactionCategory[];
  autoFocus?: boolean;
  onSaved: () => void;
  onDismiss?: () => void;
}) {
  const qc = useQueryClient();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [payee, setPayee] = useState("");
  const [memo, setMemo] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [payment, setPayment] = useState("");
  const [deposit, setDeposit] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recurringOpen, setRecurringOpen] = useState(false);

  const hasAmount =
    (Number(payment) || 0) > 0 || (Number(deposit) || 0) > 0;
  const ready = !!date && !!payee.trim() && hasAmount;

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
          payee: payee.trim(),
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
    if (ready) void save();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  }

  function onRowKeyDownCapture(e: React.KeyboardEvent<HTMLTableRowElement>) {
    if (e.key === "Escape" && !savedOnce) {
      e.preventDefault();
      e.stopPropagation();
      onDismiss?.();
    }
  }

  const inputCls =
    "w-full h-7 px-2 rounded bg-background border border-input text-sm";

  return (
    <>
      <tr
        className="border-t border-border bg-secondary/10"
        onBlur={handleBlur}
        onKeyDownCapture={onRowKeyDownCapture}
      >
        <td className="px-4 py-1.5">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={savedOnce}
            autoFocus={autoFocus}
            className={inputCls}
          />
        </td>
        <td className="py-1.5 text-xs text-muted-foreground italic">
          {savedOnce ? "saved" : "new"}
        </td>
        <td className="py-1.5"></td>
        <td className="py-1.5">
          <VendorCombobox
            organizationId={organizationId}
            value={payee}
            onChange={setPayee}
            placeholder="Payee"
            disabled={savedOnce}
            className={inputCls}
          />
        </td>
        <td className="py-1.5">
          <CategorySelect
            organizationId={organizationId}
            value={categoryId}
            onChange={setCategoryId}
            onKeyDown={onKeyDown}
            disabled={savedOnce}
            className={inputCls}
          />
        </td>
        <td className="py-1.5">
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Memo"
            disabled={savedOnce}
            className={inputCls}
          />
        </td>
        <td className="py-1.5">
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
        <td className="py-1.5">
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
        <td className="py-1.5"></td>
        <td className="py-1.5"></td>
        <td className="px-4 py-1.5"></td>
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
                onClick={onDismiss}
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
          <td colSpan={12} className="px-4 py-1 text-xs text-destructive">
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
