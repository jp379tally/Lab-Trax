import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, CheckCircle2, Loader2, Landmark, ArrowRight } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FinanceShell } from "@/components/finance/FinanceShell";
import type { BankAccount } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";

export default function MakeDepositsPage() {
  return (
    <FinanceShell>
      {({ organizationId, accounts }) => (
        <MakeDeposits organizationId={organizationId} accounts={accounts} />
      )}
    </FinanceShell>
  );
}

interface UndepositedTxn {
  id: string;
  txnDate: string;
  payee?: string | null;
  memo?: string | null;
  creditAmount: string;
  staleDays: number;
  ageWarning: boolean;
  invoiceLinks?: Array<{ invoiceId: string; invoiceNumber: string | null }>;
}

function MakeDeposits({
  organizationId,
  accounts,
}: {
  organizationId: string;
  accounts: BankAccount[];
}) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const ufQuery = useQuery({
    queryKey: ["finance", "undeposited-funds", organizationId],
    queryFn: () =>
      apiFetch<UndepositedTxn[]>(
        `/finance/undeposited-funds?organizationId=${organizationId}`
      ),
  });

  const depositableAccounts = useMemo(
    () => accounts.filter((a) => !a.isArchived && a.accountType !== "undeposited_funds"),
    [accounts]
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bankAccountId, setBankAccountId] = useState<string>(() => depositableAccounts[0]?.id ?? "");
  const [depositDate, setDepositDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  const items = ufQuery.data ?? [];
  const staleItems = useMemo(() => items.filter((t) => t.ageWarning), [items]);

  function toggleAll() {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((t) => t.id)));
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedTotal = useMemo(() => {
    return items
      .filter((t) => selected.has(t.id))
      .reduce((s, t) => s + Number(t.creditAmount), 0);
  }, [items, selected]);

  const deposit = useMutation({
    mutationFn: () => {
      if (!bankAccountId) throw new Error("Choose a bank account.");
      if (!selected.size) throw new Error("Select at least one payment.");
      return apiFetch("/finance/make-deposits", {
        method: "POST",
        body: JSON.stringify({
          organizationId,
          bankAccountId,
          depositDate: new Date(depositDate).toISOString(),
          transactionIds: Array.from(selected),
        }),
      });
    },
    onSuccess: (r: any) => {
      const accountName = depositableAccounts.find((a) => a.id === bankAccountId)?.name ?? "account";
      setDoneMsg(
        `Deposited ${formatMoney(r.totalAmount)} (${r.moved} payment${r.moved !== 1 ? "s" : ""}) to ${accountName}. Navigating to register…`
      );
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ["finance"] });
      const ch = new BroadcastChannel("labtrax:finance");
      ch.postMessage("undeposited-changed");
      ch.close();
      // Navigate to the destination register after a brief moment
      setTimeout(() => {
        navigate(`/finance/register?account=${encodeURIComponent(bankAccountId)}`);
      }, 1200);
    },
    onError: (e: Error) => setError(e.message),
  });

  function submit() {
    setError(null);
    setDoneMsg(null);
    deposit.mutate();
  }

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold">Make Deposits</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Select received payments to move from Undeposited Funds into a bank account.
        </p>
      </div>

      {/* Stale funds warning banner */}
      {staleItems.length > 0 && (
        <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
          <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              {staleItems.length === 1
                ? "1 payment has been sitting in Undeposited Funds for over 30 days."
                : `${staleItems.length} payments have been sitting in Undeposited Funds for over 30 days.`}
            </p>
            <p className="text-xs text-amber-600/80 dark:text-amber-400/70 mt-0.5">
              Payments left here won't appear on your bank statement. Select them below and click <strong>Make Deposits</strong> to move them.
            </p>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Landmark size={14} />
          Deposit to
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Bank account
            </label>
            <select
              value={bankAccountId}
              onChange={(e) => setBankAccountId(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            >
              {!depositableAccounts.length && (
                <option value="">No active bank accounts</option>
              )}
              {depositableAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.last4 ? ` ··${a.last4}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Deposit date
            </label>
            <input
              type="date"
              value={depositDate}
              onChange={(e) => setDepositDate(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            />
          </div>
        </div>
        {error && (
          <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
            {error}
          </div>
        )}
        {doneMsg && (
          <div className="text-sm text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-3 py-2 rounded-md flex items-center gap-2">
            <CheckCircle2 size={14} />
            {doneMsg}
          </div>
        )}
        <div className="flex items-center justify-between pt-1">
          <div className="text-xs text-muted-foreground">
            {selected.size > 0
              ? `${selected.size} payment${selected.size !== 1 ? "s" : ""} selected — ${formatMoney(selectedTotal)}`
              : "No payments selected"}
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={deposit.isPending || !selected.size || !bankAccountId}
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {deposit.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <ArrowRight size={14} />
            )}
            {deposit.isPending ? "Processing…" : "Make Deposits"}
          </button>
        </div>
      </div>

      {/* Undeposited payments list */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">Undeposited payments</h3>
          {items.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {selected.size === items.length ? "Deselect all" : "Select all"}
            </button>
          )}
        </div>
        {ufQuery.isLoading && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            <Loader2 size={16} className="inline animate-spin mr-2" />
            Loading…
          </div>
        )}
        {!ufQuery.isLoading && items.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            No payments are waiting in Undeposited Funds.
            <br />
            <span className="text-xs">
              Use <strong>Receive Payments</strong> to record incoming payments — they'll appear here.
            </span>
          </div>
        )}
        {items.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-secondary text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="pl-4 pr-2 py-2 text-left w-8">
                  <input
                    type="checkbox"
                    checked={selected.size === items.length && items.length > 0}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5"
                  />
                </th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Age</th>
                <th className="px-3 py-2 text-left">Payee / Memo</th>
                <th className="px-3 py-2 text-left">Invoices</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((txn) => (
                <tr
                  key={txn.id}
                  className={`border-t cursor-pointer ${
                    txn.ageWarning
                      ? "border-amber-300/40 bg-amber-500/5 hover:bg-amber-500/10"
                      : "border-border/30 hover:bg-secondary/20"
                  }`}
                  onClick={() => toggle(txn.id)}
                >
                  <td className="pl-4 pr-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(txn.id)}
                      onChange={() => toggle(txn.id)}
                      className="h-3.5 w-3.5 cursor-pointer"
                    />
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-xs">
                    {formatDate(txn.txnDate)}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-xs whitespace-nowrap">
                    {txn.ageWarning ? (
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                        <AlertTriangle size={11} />
                        {txn.staleDays}d
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{txn.staleDays}d</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div>
                      {txn.payee ? (
                        <span className="font-medium">{txn.payee}</span>
                      ) : (
                        <span className="text-muted-foreground italic">No payee</span>
                      )}
                      {txn.memo && (
                        <div className="text-[11px] text-muted-foreground mt-0.5 truncate max-w-[200px]">
                          {txn.memo}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {txn.invoiceLinks?.length ? (
                      <span className="text-xs text-muted-foreground">
                        {txn.invoiceLinks
                          .map((l) => l.invoiceNumber || l.invoiceId.slice(0, 6))
                          .join(", ")}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                    {formatMoney(Number(txn.creditAmount))}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border bg-secondary/30">
              <tr>
                <td colSpan={5} className="px-4 py-2 text-xs font-medium text-right text-muted-foreground">
                  Total undeposited
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">
                  {formatMoney(
                    items.reduce((s, t) => s + Number(t.creditAmount), 0)
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
