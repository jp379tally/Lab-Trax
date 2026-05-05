import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CheckCircle2, Download, Loader2, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FinanceShell } from "@/components/finance/FinanceShell";
import type { BankAccount, BankTransaction, TransactionCategory } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";

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
  const [importing, setImporting] = useState(false);

  const account = accounts.find((a) => a.id === accountId);

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
            onClick={() => setAdding(true)}
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 inline-flex items-center gap-1.5"
          >
            <Plus size={14} /> Add entry
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="text-left font-medium px-4 py-2">Date</th>
                <th className="text-left font-medium py-2">Type</th>
                <th className="text-left font-medium py-2">Check #</th>
                <th className="text-left font-medium py-2">Payee</th>
                <th className="text-left font-medium py-2">Category</th>
                <th className="text-left font-medium py-2">Memo</th>
                <th className="text-right font-medium py-2">Payment</th>
                <th className="text-right font-medium py-2">Deposit</th>
                <th className="text-center font-medium py-2 w-12">Clr</th>
                <th className="text-center font-medium py-2 w-12">Rec</th>
                <th className="text-right font-medium px-4 py-2">Balance</th>
                <th className="px-2 py-2 w-10" />
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
                    <td className="py-2.5">{r.payee || "—"}</td>
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
            </tbody>
          </table>
        </div>
      </div>

      {(adding || editing) && (
        <TxnEditor
          organizationId={organizationId}
          accountId={accountId}
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
  existing,
  categories,
  onClose,
}: {
  organizationId: string;
  accountId: string;
  existing: BankTransaction | null;
  categories: TransactionCategory[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
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
  const [error, setError] = useState<string | null>(null);

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
            <input
              type="text"
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
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
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            >
              <option value="">— None —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
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
