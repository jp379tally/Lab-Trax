import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, CheckCircle2, Loader2, Landmark, ArrowRight, Pencil, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import {
  computeShiftClickRange,
  shiftKeyFromChangeEvent,
  suppressShiftClickTextSelection,
} from "@/lib/shift-click-range";
import { FinanceShell } from "@/components/finance/FinanceShell";
import type { BankAccount, Invoice } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { useBatchedListReset } from "@/hooks/useBatchedListReset";
import { InvoiceEditor } from "@/pages/invoices";
import {
  doctorDisplayNameForRow,
  doctorIdentityKeysForRow,
  retainVisibleSelection,
  visibleDoctorScopedRows,
} from "@/lib/doctor-payment-scope";

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
  providerOrganizationId?: string | null;
  providerName?: string | null;
  practiceId?: string | null;
  practiceName?: string | null;
  doctorName?: string | null;
  statementDate: string | null;
  invoiceLinks?: Array<{ invoiceId: string; invoiceNumber: string | null }>;
  paymentSession?: {
    id: string;
    receiptNumber: string;
    statementId: string | null;
    receivedAmount: string;
    appliedAmount: string;
    customerCreditAmount: string;
    customerCreditRemaining: string;
    paymentMethod: string;
    checkNumber: string | null;
    cardLast4: string | null;
    doctorName?: string | null;
    doctorIdentity?: string | null;
    doctorDisplayName?: string | null;
    practiceName?: string | null;
    providerOrganizationId?: string | null;
  } | null;
}
const PAGE_SIZE = 10;
/** Matches the server's per-request cap on transactionIds. */
const MAX_DEPOSIT_SELECTION = 500;
/** Stable identity for an unloaded batch. */
const EMPTY_UNDEPOSITED: UndepositedTxn[] = [];
/** Stable identity for "no full-set selection is in force". */
const EMPTY_SELECTION_AMOUNTS = new Map<string, number>();
type SelectionRow = { id: string; creditAmount: string };
type UndepositedPage = {
  rows: UndepositedTxn[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextCursor?: string | null;
  amountTotal: string;
  staleCount: number;
  filterOptions?: {
    practices: Array<{ id: string; name: string }>;
    doctors: Array<{ practiceId: string; identity: string; displayName: string }>;
  };
};

export function MakeDeposits({
  organizationId,
  accounts,
}: {
  organizationId: string;
  accounts: BankAccount[];
}) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [practiceFilter, setPracticeFilter] = useState("all");
  const [doctorFilter, setDoctorFilter] = useState("all");
  // Batches are anchored on the last row already received (a keyset cursor),
  // so payments received while the user pages cannot shift the window.
  const [cursor, setCursor] = useState<string | null>(null);
  // Rows accumulate against the identity of the server query (everything but
  // the cursor), so a filter change restarts the list at the newest matches.
  const [loaded, setLoaded] = useState<{ key: string; rows: UndepositedTxn[] }>({
    key: "",
    rows: [],
  });
  const ufParams = useMemo(() => {
    const params = new URLSearchParams({
      organizationId,
      limit: String(PAGE_SIZE),
    });
    if (cursor) params.set("cursor", cursor);
    if (practiceFilter !== "all") params.set("practiceId", practiceFilter);
    if (doctorFilter !== "all") params.set("doctorKey", doctorFilter);
    return params.toString();
  }, [organizationId, practiceFilter, doctorFilter, cursor]);
  const ufBase = useMemo(() => {
    const params = new URLSearchParams(ufParams);
    params.delete("cursor");
    return params.toString();
  }, [ufParams]);
  // The query identity a returning "Select all" response has to match to still
  // be relevant, read in async callbacks that cannot close over fresh state.
  const ufBaseRef = useRef(ufBase);
  ufBaseRef.current = ufBase;
  // Query identity of the in-flight "Select all" request, so a request for
  // older filters never blocks one for the filters now on screen.
  const pendingSelectionKeyRef = useRef<string | null>(null);
  // Restart during render (not in an effect) so the first request after a
  // filter change never carries the previous batch's cursor.
  const [pagedUfBase, setPagedUfBase] = useState(ufBase);
  if (pagedUfBase !== ufBase) {
    setPagedUfBase(ufBase);
    setCursor(null);
  }
  const restartBatches = useCallback(() => setCursor(null), []);
  useBatchedListReset("finance", restartBatches);

  const ufQuery = useQuery({
    queryKey: ["finance", "undeposited-funds", ufParams],
    queryFn: async () => {
      const query = ufParams;
      const requestCursor = cursor;
      const response = await apiFetch<UndepositedPage | UndepositedTxn[]>(
        `/finance/undeposited-funds?${query}`
      );
      // A legacy bare-array response carries no aggregates, so the page falls
      // back to computing them from the rows it can see.
      const paginated = !Array.isArray(response);
      const result = Array.isArray(response)
        ? {
            rows: response,
            total: response.length,
            limit: response.length,
            offset: 0,
            hasMore: false,
            nextCursor: null,
            amountTotal: response.reduce((sum, row) => sum + Number(row.creditAmount), 0).toFixed(2),
            staleCount: response.filter((row) => row.ageWarning).length,
          }
        : response;
      return { ...result, query, paginated, requestCursor };
    },
  });
  useEffect(() => {
    const result = ufQuery.data;
    if (!result || result.query !== ufParams) return;
    setLoaded((previous) => ({
      key: ufBase,
      rows: previous.key === ufBase && result.requestCursor
        ? [...previous.rows.filter((row) => !result.rows.some((next) => next.id === row.id)), ...result.rows]
        : result.rows,
    }));
  }, [ufParams, ufBase, ufQuery.data]);


  const depositableAccounts = useMemo(
    () => accounts.filter((a) => !a.isArchived && a.accountType !== "undeposited_funds"),
    [accounts]
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Amounts for a "Select all" that reached past the loaded batch, keyed by the
  // query identity it was taken under so a filter change retires it.
  const [fullSelection, setFullSelection] = useState<{ key: string; amounts: Map<string, number> }>({
    key: "",
    amounts: EMPTY_SELECTION_AMOUNTS,
  });
  const [bankAccountId, setBankAccountId] = useState<string>(() => depositableAccounts[0]?.id ?? "");
  const [depositDate, setDepositDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);

  useEffect(() => {
    if (depositableAccounts.some((account) => account.id === bankAccountId)) return;
    setBankAccountId(depositableAccounts[0]?.id ?? "");
  }, [bankAccountId, depositableAccounts]);

  const items = loaded.key === ufBase ? loaded.rows : EMPTY_UNDEPOSITED;
  const practiceOptions = useMemo(() => {
    if (ufQuery.data?.filterOptions?.practices) {
      return [...ufQuery.data.filterOptions.practices].sort((a, b) => a.name.localeCompare(b.name));
    }
    const map = new Map<string, { id: string; name: string }>();
    items.forEach(t => {
      const id = t.practiceId || t.providerOrganizationId || t.paymentSession?.providerOrganizationId || "";
      if (id) map.set(id, { id, name: t.practiceName || t.providerName || t.paymentSession?.practiceName || "Unknown practice" });
    });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [items, ufQuery.data?.filterOptions?.practices]);
  const doctorOptions = useMemo(() => {
    if (ufQuery.data?.filterOptions?.doctors) {
      return [...ufQuery.data.filterOptions.doctors]
        .filter((doctor) => practiceFilter === "all" || doctor.practiceId === practiceFilter)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    const visiblePractice = items.filter(t => practiceFilter === "all" || (t.practiceId || t.providerOrganizationId || t.paymentSession?.providerOrganizationId) === practiceFilter);
    const doctors = new Map<string, string>();
    visiblePractice.forEach(t => {
      const displayName = doctorDisplayNameForRow(t);
      for (const identity of doctorIdentityKeysForRow(t)) {
        doctors.set(identity, displayName || identity);
      }
    });
    return [...doctors.entries()]
      .map(([identity, displayName]) => ({ identity, displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [items, practiceFilter, ufQuery.data?.filterOptions?.doctors]);
  const visibleItems = useMemo(
    () => visibleDoctorScopedRows(items, practiceFilter, doctorFilter),
    [items, practiceFilter, doctorFilter],
  );
  // Prune hidden selections only once the batch for the current filters has
  // arrived. While a filter change is in flight the list is momentarily empty,
  // and pruning against it would drop selections the new filter still shows.
  const hasCurrentBatch = loaded.key === ufBase;
  // A full-set selection taken under the current filters keeps its unloaded
  // ids selectable; one taken under older filters is retired.
  const fullSelectionAmounts =
    fullSelection.key === ufBase ? fullSelection.amounts : EMPTY_SELECTION_AMOUNTS;
  useEffect(() => {
    if (!hasCurrentBatch) return;
    // A full-set selection deliberately contains ids that are not present in
    // the currently loaded page. Do not prune it during the intermediate
    // render where the selection response has already populated `selected`
    // but the loaded-page merge has not caught up yet.
    if (fullSelection.key === ufBase && fullSelection.amounts.size > 0) return;
    setSelected(prev =>
      retainVisibleSelection(prev, [
        ...visibleItems.map(t => t.id),
        ...fullSelectionAmounts.keys(),
      ]),
    );
    if (doctorFilter !== "all" && doctorFilter !== "entire" && !doctorOptions.some(({ identity }) => identity === doctorFilter)) setDoctorFilter("all");
  }, [hasCurrentBatch, visibleItems, fullSelectionAmounts, doctorFilter, doctorOptions]);
  // Aggregates describe the whole filtered set, not the loaded batch, so they
  // come from the server whenever it paginated the response.
  const serverAggregates =
    ufQuery.data?.paginated && ufQuery.data.query === ufParams ? ufQuery.data : null;
  const staleCount = serverAggregates
    ? serverAggregates.staleCount
    : visibleItems.filter((t) => t.ageWarning).length;
  const total = serverAggregates ? serverAggregates.total : visibleItems.length;
  const fullAmountTotal = serverAggregates
    ? Number(serverAggregates.amountTotal)
    : visibleItems.reduce((sum, row) => sum + Number(row.creditAmount), 0);

  // "Select all" covers every payment the current filters match, not just the
  // loaded batch, so it asks the server for the matching ids whenever the list
  // is paged. When everything is already loaded it stays local.
  const selectAllMatching = useMutation({
    mutationFn: async () => {
      const params = new URLSearchParams(ufBase);
      params.delete("limit");
      params.set("selection", "ids");
      const key = ufBase;
      pendingSelectionKeyRef.current = key;
      const response = await apiFetch<{ selection?: SelectionRow[] } | UndepositedTxn[]>(
        `/finance/undeposited-funds?${params.toString()}`
      );
      const rows: SelectionRow[] = Array.isArray(response)
        ? response.map((row) => ({ id: row.id, creditAmount: row.creditAmount }))
        : response.selection ?? [];
      return { key, rows };
    },
    onSuccess: ({ key, rows }) => {
      // The filters may have moved on while the ids were in flight. Selecting
      // the old set would leave the table showing one filter and the deposit
      // carrying another, so a stale result is simply dropped.
      if (key === pendingSelectionKeyRef.current) pendingSelectionKeyRef.current = null;
      if (key !== ufBaseRef.current) return;
      setFullSelection({
        key,
        amounts: new Map(rows.map((row) => [row.id, Number(row.creditAmount)])),
      });
      setSelected(new Set(rows.map((row) => row.id)));
      selectionAnchorIdRef.current = null;
    },
    onError: (e: Error) => {
      pendingSelectionKeyRef.current = null;
      toast({
        title: "Could not select every matching payment",
        description: e.message,
        variant: "destructive",
      });
    },
  });
  // Only a request for the filters currently on screen makes the control busy;
  // one left over from older filters is ignored when it lands.
  const selectionPending =
    selectAllMatching.isPending && pendingSelectionKeyRef.current === ufBase;

  const allMatchesLoaded = visibleItems.length >= total;
  // Either the whole filtered set is selected, or every loaded row is selected
  // and there is nothing further to load.
  const everythingSelected =
    visibleItems.length > 0 &&
    ((total > 0 && selected.size >= total) ||
      (allMatchesLoaded && selected.size === visibleItems.length));

  function toggleAll() {
    if (everythingSelected) {
      setSelected(new Set());
      setFullSelection({ key: "", amounts: EMPTY_SELECTION_AMOUNTS });
      return;
    }
    if (allMatchesLoaded) {
      setSelected(new Set(visibleItems.map((t) => t.id)));
      return;
    }
    if (selectionPending) return;
    selectAllMatching.mutate();
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    selectionAnchorIdRef.current = id;
  }

  // Shift-click range selection for the payment checkboxes. A normal click
  // toggles the single payment and moves the anchor; a shift-click with a
  // valid anchor adds every payment between the anchor and the clicked row
  // (in the current visible order) to the selection. If the anchor is no
  // longer visible, fall back to a normal single toggle.
  const selectionAnchorIdRef = useRef<string | null>(null);
  function handleDepositCheckboxChange(
    id: string,
    checked: boolean,
    shiftKey: boolean,
  ) {
    if (shiftKey) {
      const rangeIds = computeShiftClickRange(
        visibleItems.map((t) => t.id),
        selectionAnchorIdRef.current,
        id,
      );
      if (rangeIds) {
        setSelected((prev) => {
          const next = new Set(prev);
          for (const rid of rangeIds) next.add(rid);
          return next;
        });
        return;
      }
      selectionAnchorIdRef.current = null;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    selectionAnchorIdRef.current = id;
  }

  // Selected payments can include matches that were never paged in, so amounts
  // come from the loaded rows first and from the full-set selection otherwise.
  const selectedTotal = useMemo(() => {
    const loadedAmounts = new Map(visibleItems.map((t) => [t.id, Number(t.creditAmount)]));
    let sum = 0;
    for (const id of selected) {
      const amount = loadedAmounts.get(id) ?? fullSelectionAmounts.get(id);
      if (amount !== undefined) sum += amount;
    }
    return sum;
  }, [visibleItems, selected, fullSelectionAmounts]);

  const deletePayment = useMutation({
    mutationFn: (bankTransactionId: string) =>
      apiFetch(`/finance/payments/${bankTransactionId}`, { method: "DELETE" }),
    onSuccess: (_data, bankTransactionId) => {
      // Remove the now-deleted row from the selection so a stale ID cannot
      // cause the next Make Deposits call to fail with "not found".
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(bankTransactionId);
        return next;
      });
      setConfirmingDeleteId(null);
      // Drop the row from the loaded batch immediately; the refetch below
      // replaces the batch with the head of the server's list.
      setCursor(null);
      setLoaded((previous) => ({
        ...previous,
        rows: previous.rows.filter((row) => row.id !== bankTransactionId),
      }));
      void qc.invalidateQueries({ queryKey: ["finance", "undeposited-funds"] });
    },
    onError: (e: Error) => {
      setConfirmingDeleteId(null);
      toast({ title: "Could not delete payment", description: e.message, variant: "destructive" });
    },
  });

  const deposit = useMutation({
    mutationFn: () => {
      if (!bankAccountId) throw new Error("Choose a bank account.");
      if (!selected.size) throw new Error("Select at least one payment.");
      if (selected.size > MAX_DEPOSIT_SELECTION) {
        throw new Error(
          `Deposits are limited to ${MAX_DEPOSIT_SELECTION} payments at a time. Narrow the filters and deposit in smaller batches.`
        );
      }
      // Every selected payment is deposited, including matches that were
      // selected through "Select all" but never paged into the table.
      return apiFetch("/finance/make-deposits", {
        method: "POST",
        body: JSON.stringify({
          organizationId,
          bankAccountId,
          depositDate: new Date(depositDate).toISOString(),
          transactionIds: [...selected],
        }),
      });
    },
    onSuccess: (r: any) => {
      const accountName = depositableAccounts.find((a) => a.id === bankAccountId)?.name ?? "account";
      setDoneMsg(
        `Deposited ${formatMoney(r.totalAmount)} (${r.moved} payment${r.moved !== 1 ? "s" : ""}) to ${accountName}. Navigating to register…`
      );
      setSelected(new Set());
      setFullSelection({ key: "", amounts: EMPTY_SELECTION_AMOUNTS });
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
         <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
           <label className="block text-xs font-medium text-muted-foreground">Practice
             <select value={practiceFilter} onChange={e => setPracticeFilter(e.target.value)} className="mt-1 w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"><option value="all">All practices</option>{practiceOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
           </label>
           <label className="block text-xs font-medium text-muted-foreground">Doctor
              <select value={doctorFilter} onChange={e => setDoctorFilter(e.target.value)} className="mt-1 w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"><option value="all">All doctors</option><option value="entire">Entire-practice payments</option>{doctorOptions.map(({ identity, displayName }) => <option key={identity} value={identity}>{displayName}</option>)}</select>
           </label>
         </div>

      {/* Stale funds warning banner */}
      {staleCount > 0 && (
        <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
          <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
               {staleCount === 1
                ? "1 payment has been sitting in Undeposited Funds for over 30 days."
                 : `${staleCount} payments have been sitting in Undeposited Funds for over 30 days.`}
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

      {editing && (
        <InvoiceEditor
          invoice={editing}
          onClose={() => {
            setEditing(null);
            void ufQuery.refetch();
          }}
          onGoToCase={() => setEditing(null)}
        />
      )}

      {/* Undeposited payments list */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">Undeposited payments</h3>
           {visibleItems.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              disabled={selectionPending}
              data-testid="make-deposits-select-all"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
               {selectionPending
                ? "Selecting…"
                : everythingSelected
                  ? "Deselect all"
                  : "Select all"}
            </button>
          )}
        </div>
        {ufQuery.isLoading && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            <Loader2 size={16} className="inline animate-spin mr-2" />
            Loading…
          </div>
        )}
        {!ufQuery.isLoading && visibleItems.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            No payments are waiting in Undeposited Funds.
            <br />
            <span className="text-xs">
              Use <strong>Receive Payments</strong> to record incoming payments — they'll appear here.
            </span>
          </div>
        )}
        {visibleItems.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-secondary text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="pl-4 pr-2 py-2 text-left w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all payments"
                    checked={everythingSelected}
                    disabled={selectionPending}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5"
                  />
                </th>
                <th className="px-3 py-2 text-left">Date of Payment</th>
                <th className="px-3 py-2 text-left">Age</th>
                <th className="px-3 py-2 text-left">Payee / Memo</th>
                <th className="px-3 py-2 text-left">Statement Date</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-2 py-2 w-8" />
              </tr>
            </thead>
            <tbody>
               {visibleItems.map((txn) => (
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
                      aria-label={`Select payment ${txn.id}`}
                      checked={selected.has(txn.id)}
                      onMouseDown={suppressShiftClickTextSelection}
                      onChange={(e) =>
                        handleDepositCheckboxChange(
                          txn.id,
                          e.target.checked,
                          shiftKeyFromChangeEvent(e),
                        )
                      }
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
                     <div className="text-xs text-muted-foreground">{doctorDisplayNameForRow(txn) || "Entire practice"} · {txn.practiceName || txn.providerName || txn.paymentSession?.practiceName || "Unknown practice"}</div>
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
                      {txn.invoiceLinks && txn.invoiceLinks.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1" onClick={(e) => e.stopPropagation()}>
                          {txn.invoiceLinks.map((link) => (
                            <button
                              key={link.invoiceId}
                              type="button"
                              onClick={() =>
                                apiFetch<Invoice>(`/invoices/${link.invoiceId}`).then(setEditing)
                              }
                              className="group inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-primary transition-colors"
                              title="Edit invoice"
                            >
                              {link.invoiceNumber ?? link.invoiceId.slice(0, 8)}
                              <Pencil
                                size={10}
                                className="opacity-0 group-hover:opacity-60 transition-opacity shrink-0"
                              />
                            </button>
                          ))}
                        </div>
                      )}
                      {txn.paymentSession && (
                        <div className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                          <div className="flex flex-wrap gap-x-2">
                            <span title={`Payment session ${txn.paymentSession.id}`}>
                              Receipt <span className="font-mono text-foreground">{txn.paymentSession.receiptNumber}</span>
                            </span>
                            <span title={`Payment session ${txn.paymentSession.id}`}>
                              Session <span className="font-mono">{txn.paymentSession.id.slice(0, 8)}</span>
                            </span>
                            {txn.paymentSession.statementId && (
                              <span title={`Statement ${txn.paymentSession.statementId}`}>
                                Statement <span className="font-mono">{txn.paymentSession.statementId.slice(0, 8)}</span>
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-x-2">
                            <span>Received {formatMoney(Number(txn.paymentSession.receivedAmount))}</span>
                            <span>Applied {formatMoney(Number(txn.paymentSession.appliedAmount))}</span>
                            <span>
                              Customer credit {formatMoney(Number(txn.paymentSession.customerCreditAmount))}
                              {Number(txn.paymentSession.customerCreditAmount) > 0 &&
                                ` (${formatMoney(Number(txn.paymentSession.customerCreditRemaining))} remaining)`}
                            </span>
                          </div>
                          <div>
                            {txn.paymentSession.paymentMethod}
                            {txn.paymentSession.checkNumber
                              ? ` · Check #${txn.paymentSession.checkNumber}`
                              : txn.paymentSession.cardLast4
                                ? ` · Card ••••${txn.paymentSession.cardLast4}`
                                : ""}
                          </div>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {txn.statementDate ? (
                      <span className="text-xs text-muted-foreground">
                        {formatDate(txn.statementDate)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                    {formatMoney(Number(txn.creditAmount))}
                  </td>
                  <td className="px-2 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                    {/* Only receive-payment rows (backed by payments rows + invoice links)
                        can be reversed via the delete endpoint. Hide the action on other
                        undeposited entries (manual credits, transfers, etc.). */}
                    {!(txn.invoiceLinks && txn.invoiceLinks.length > 0) ? null : confirmingDeleteId === txn.id ? (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <button
                          type="button"
                          disabled={deletePayment.isPending}
                          onClick={() => deletePayment.mutate(txn.id)}
                          className="text-[11px] font-semibold text-destructive hover:text-destructive/80 disabled:opacity-50 px-1.5 py-0.5 rounded border border-destructive/40 hover:bg-destructive/10 transition-colors"
                        >
                          {deletePayment.isPending ? (
                            <Loader2 size={10} className="animate-spin inline" />
                          ) : (
                            "Yes, delete"
                          )}
                        </button>
                        <button
                          type="button"
                          disabled={deletePayment.isPending}
                          onClick={() => setConfirmingDeleteId(null)}
                          className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50 px-1 py-0.5 rounded hover:bg-secondary/60 transition-colors"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={deposit.isPending}
                        onClick={() => setConfirmingDeleteId(txn.id)}
                        title="Delete this payment"
                        className="text-muted-foreground hover:text-destructive disabled:opacity-30 p-1 rounded hover:bg-destructive/10 transition-colors"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border bg-secondary/30">
              <tr>
                <td colSpan={6} className="px-4 py-2 text-xs font-medium text-right text-muted-foreground">
                  Total undeposited
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">
                  {formatMoney(fullAmountTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <span data-testid="make-deposits-loaded-count" className="text-xs text-muted-foreground">
            Showing {visibleItems.length} of {total}
          </span>
          {ufQuery.data?.query === ufParams && ufQuery.data.hasMore && (
            <button
              type="button"
              data-testid="make-deposits-load-more"
              onClick={() => setCursor(ufQuery.data?.nextCursor ?? null)}
              disabled={ufQuery.isFetching}
              className="h-8 rounded-md bg-secondary px-3 text-xs font-medium disabled:opacity-50"
            >
              {ufQuery.isFetching ? "Loading…" : `Load more (${visibleItems.length} of ${total})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
