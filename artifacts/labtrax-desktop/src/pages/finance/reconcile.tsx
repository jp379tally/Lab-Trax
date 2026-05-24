import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, History } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FinanceShell } from "@/components/finance/FinanceShell";
import type { BankTransaction, Reconciliation } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { useColumnWidths } from "@/hooks/useColumnWidths";

// 5 resizable columns: Date(0), Type(1), Payee(2), Memo(3), Amount(4)
const RECON_COL_DEFAULTS = [100, 80, 160, 240, 110] as const;
const RECON_FIXED_CHECK = 48;
const RECON_COL_LABELS = ["Date", "Type", "Payee", "Memo", "Amount"] as const;

export default function ReconcilePage() {
  return (
    <FinanceShell requireAccount>
      {({ accountId }) => <Reconcile accountId={accountId!} />}
    </FinanceShell>
  );
}

function Reconcile({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const [statementDate, setStatementDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [endingBalance, setEndingBalance] = useState<string>("0");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const { widths: colWidths, totalWidth: colTotalWidth, resizingCol, startResize, resetColumn } =
    useColumnWidths([...RECON_COL_DEFAULTS], "labtrax_recon_col_widths_v1");

  const candidatesQuery = useQuery({
    queryKey: ["finance", "recon-candidates", accountId, statementDate],
    queryFn: () =>
      apiFetch<{ startingBalance: string; candidates: BankTransaction[] }>(
        `/finance/reconciliation/candidates?bankAccountId=${accountId}&statementDate=${new Date(
          statementDate
        ).toISOString()}`
      ),
  });

  const history = useQuery({
    queryKey: ["finance", "recon-history", accountId],
    queryFn: () =>
      apiFetch<Reconciliation[]>(
        `/finance/reconciliation/history?bankAccountId=${accountId}`
      ),
  });

  const finishMut = useMutation({
    mutationFn: () =>
      apiFetch<Reconciliation>("/finance/reconciliation/finish", {
        method: "POST",
        body: JSON.stringify({
          bankAccountId: accountId,
          statementDate: new Date(statementDate).toISOString(),
          endingBalance: Number(endingBalance) || 0,
          transactionIds: Array.from(selected),
        }),
      }),
    onSuccess: (r) => {
      setDone(r.id);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const totals = useMemo(() => {
    const candidates = candidatesQuery.data?.candidates || [];
    const starting = Number(candidatesQuery.data?.startingBalance || 0);
    const cleared = candidates
      .filter((c) => selected.has(c.id))
      .reduce((s, c) => s + Number(c.netAmount), 0);
    const expected = Number(endingBalance) || 0;
    const difference = +(starting + cleared - expected).toFixed(2);
    return { starting, cleared, expected, difference };
  }, [candidatesQuery.data, selected, endingBalance]);

  function toggleAll() {
    const all = candidatesQuery.data?.candidates || [];
    if (selected.size === all.length) setSelected(new Set());
    else setSelected(new Set(all.map((c) => c.id)));
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-5">
      <div className="space-y-4">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Statement date">
              <input
                type="date"
                value={statementDate}
                onChange={(e) => setStatementDate(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
            </Field>
            <Field label="Starting balance">
              <div className="h-9 px-2.5 rounded-md bg-secondary text-sm flex items-center justify-end tabular-nums">
                {formatMoney(totals.starting)}
              </div>
            </Field>
            <Field label="Ending balance (statement)">
              <input
                type="number"
                step="0.01"
                value={endingBalance}
                onChange={(e) => setEndingBalance(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm text-right tabular-nums"
              />
            </Field>
            <Field label="Difference">
              <div
                className={`h-9 px-2.5 rounded-md text-sm flex items-center justify-end font-semibold tabular-nums ${
                  Math.abs(totals.difference) < 0.005
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                }`}
              >
                {formatMoney(totals.difference)}
              </div>
            </Field>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Candidate transactions</div>
              <div className="text-xs text-muted-foreground">
                Check off entries that appear on your statement.
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {selected.size} of {candidatesQuery.data?.candidates.length || 0} selected ·
              cleared {formatMoney(totals.cleared)}
            </div>
          </div>
          <div className="overflow-x-auto relative">
            {resizingCol !== null && (
              <div
                className="bg-primary/50 pointer-events-none absolute top-0 bottom-0 z-10"
                style={{
                  left:
                    RECON_FIXED_CHECK +
                    colWidths.slice(0, resizingCol + 1).reduce((a, b) => a + b, 0) -
                    1,
                  width: 2,
                }}
              />
            )}
            <table
              className="text-sm"
              style={{
                tableLayout: "fixed",
                width: RECON_FIXED_CHECK + colTotalWidth,
                userSelect: "none",
              }}
            >
              <colgroup>
                <col style={{ width: RECON_FIXED_CHECK }} />
                {colWidths.map((w, i) => (
                  <col key={i} style={{ width: w }} />
                ))}
              </colgroup>
              <thead>
                <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 w-10">
                    <input
                      type="checkbox"
                      onChange={toggleAll}
                      checked={
                        !!candidatesQuery.data?.candidates.length &&
                        selected.size === candidatesQuery.data.candidates.length
                      }
                    />
                  </th>
                  {RECON_COL_LABELS.map((label, i) => {
                    const isAmount = i === 4;
                    return (
                      <th
                        key={label}
                        className={`font-medium py-2 relative px-3${isAmount ? " text-right" : " text-left"}`}
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
                </tr>
              </thead>
              <tbody>
                {(candidatesQuery.data?.candidates || []).map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => {
                      const next = new Set(selected);
                      if (next.has(r.id)) next.delete(r.id);
                      else next.add(r.id);
                      setSelected(next);
                    }}
                    className={`border-t border-border cursor-pointer ${
                      selected.has(r.id) ? "bg-primary/5" : "hover:bg-secondary/30"
                    }`}
                  >
                    <td className="px-4 py-2">
                      <input type="checkbox" checked={selected.has(r.id)} readOnly />
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap">{formatDate(r.txnDate)}</td>
                    <td className="py-2 px-3 capitalize">{r.type}</td>
                    <td className="py-2 px-3 truncate">{r.payee || "—"}</td>
                    <td className="py-2 px-3 text-muted-foreground truncate">
                      {r.memo || ""}
                    </td>
                    <td
                      className={`py-2 px-3 text-right tabular-nums ${
                        Number(r.netAmount) >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : ""
                      }`}
                    >
                      {formatMoney(r.netAmount)}
                    </td>
                  </tr>
                ))}
                {!candidatesQuery.data?.candidates.length && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                      Nothing left to reconcile up to this statement date.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {error && (
          <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
            {error}
          </div>
        )}
        {done && (
          <div className="text-sm text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-3 py-2 rounded-md">
            Reconciliation completed and locked.
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setDone(null);
              if (Math.abs(totals.difference) > 0.005) {
                setError(
                  `Difference must be zero to finish. Currently ${formatMoney(
                    totals.difference
                  )}.`
                );
                return;
              }
              finishMut.mutate();
            }}
            disabled={finishMut.isPending}
            className="h-10 px-5 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-2"
          >
            <CheckCircle2 size={16} />
            {finishMut.isPending ? "Finalizing…" : "Finish reconciliation"}
          </button>
        </div>
      </div>

      <aside className="bg-card border border-border rounded-xl p-4 h-fit">
        <div className="flex items-center gap-2 mb-3 text-sm font-semibold">
          <History size={14} /> History
        </div>
        <ul className="space-y-2.5">
          {(history.data || []).map((h) => (
            <li
              key={h.id}
              className="text-sm border border-border rounded-md px-3 py-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{formatDate(h.statementDate)}</span>
                <span className="tabular-nums">{formatMoney(h.endingBalance)}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Cleared {formatMoney(h.clearedTotal)} · diff{" "}
                {formatMoney(h.difference)}
              </div>
            </li>
          ))}
          {!history.data?.length && (
            <li className="text-sm text-muted-foreground">No reconciliations yet.</li>
          )}
        </ul>
      </aside>
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
