import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Plus, RotateCcw, Send, Sparkles, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FinanceShell } from "@/components/finance/FinanceShell";
import type { BankAccount, RecurringRule, TransactionCategory } from "@/lib/types";
import { formatDate, formatMoney } from "@/lib/format";
import { useColumnWidths } from "@/hooks/useColumnWidths";

// 10 resizable columns: Name, Account, Payee, Category, Direction, Day, Amount, Last gen., Next run, Status
const RECURRING_COL_DEFAULTS = [160, 140, 140, 120, 90, 70, 90, 100, 100, 90] as const;
const RECURRING_FIXED_ACTIONS = 128;
const RECURRING_COL_LABELS = [
  "Name",
  "Account",
  "Payee",
  "Category",
  "Direction",
  "Day",
  "Amount",
  "Last gen.",
  "Next run",
  "Status",
] as const;

export default function RecurringPage() {
  return (
    <FinanceShell>
      {({ organizationId, accounts }) => (
        <Recurring organizationId={organizationId} accounts={accounts} />
      )}
    </FinanceShell>
  );
}

function Recurring({
  organizationId,
  accounts,
}: {
  organizationId: string;
  accounts: BankAccount[];
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<RecurringRule | "new" | null>(null);
  const [genResult, setGenResult] = useState<string | null>(null);

  const { widths: colWidths, totalWidth: colTotalWidth, resizingCol, startResize, resetColumn, resetAll } =
    useColumnWidths([...RECURRING_COL_DEFAULTS], "labtrax_recurring_col_widths_v1");

  const columnsAreCustom = colWidths.some((w, i) => w !== RECURRING_COL_DEFAULTS[i]);

  const rules = useQuery({
    queryKey: ["finance", "recurring", organizationId],
    queryFn: () =>
      apiFetch<RecurringRule[]>(
        `/finance/recurring?organizationId=${organizationId}`
      ),
  });

  const cats = useQuery({
    queryKey: ["finance", "categories", organizationId],
    queryFn: () =>
      apiFetch<TransactionCategory[]>(
        `/finance/categories?organizationId=${organizationId}`
      ),
  });

  const acctNameById = new Map(accounts.map((a) => [a.id, a.name]));
  const catNameById = new Map((cats.data || []).map((c) => [c.id, c.name]));

  const generate = useMutation({
    mutationFn: () =>
      apiFetch<{ created: number; ruleCount: number }>("/finance/recurring/generate", {
        method: "POST",
        body: JSON.stringify({ organizationId }),
      }),
    onSuccess: (r) => {
      setGenResult(
        `Generated ${r.created} projected entries from ${r.ruleCount} active rules.`
      );
      qc.invalidateQueries({ queryKey: ["finance"] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/finance/recurring/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finance", "recurring"] }),
  });

  const togglePause = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiFetch(`/finance/recurring/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finance", "recurring"] }),
  });

  const postNext = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ posted: boolean; bankTransactionId: string | null }>(
        `/finance/recurring/${id}/post-next`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["finance"] });
      setGenResult(
        r.posted
          ? "Posted next entry to the register."
          : "Skipped: an entry was already posted near this date."
      );
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-muted-foreground">
            Recurring entries auto-generate projected transactions in the register
            (one per month, idempotent).
          </div>
          {genResult && (
            <div className="text-sm text-emerald-700 dark:text-emerald-400 mt-1">
              {genResult}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {columnsAreCustom && (
            <button
              type="button"
              onClick={resetAll}
              title="Reset all column widths to default"
              className="h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <RotateCcw size={13} />
              Reset columns
            </button>
          )}
          <button
            type="button"
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            className="h-9 px-3 rounded-md bg-secondary text-sm font-medium hover:bg-secondary/80 inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            <Sparkles size={14} />
            {generate.isPending ? "Generating…" : "Generate this month"}
          </button>
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 inline-flex items-center gap-1.5"
          >
            <Plus size={14} /> New rule
          </button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto relative">
          {resizingCol !== null && (
            <div
              className="bg-primary/50 pointer-events-none absolute top-0 bottom-0 z-10"
              style={{
                left:
                  colWidths.slice(0, resizingCol + 1).reduce((a, b) => a + b, 0) - 1,
                width: 2,
              }}
            />
          )}
          <table
            className="text-sm"
            style={{
              tableLayout: "fixed",
              width: colTotalWidth + RECURRING_FIXED_ACTIONS,
              userSelect: "none",
            }}
          >
            <colgroup>
              {colWidths.map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
              <col style={{ width: RECURRING_FIXED_ACTIONS }} />
            </colgroup>
            <thead>
              <tr className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                {RECURRING_COL_LABELS.map((label, i) => {
                  const isAmount = i === 6;
                  return (
                    <th
                      key={label}
                      className={`font-medium py-2 relative px-3${i === 0 ? " pl-4" : ""}${isAmount ? " text-right" : " text-left"}`}
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
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {(rules.data || []).map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setEditing(r)}
                  className="border-t border-border cursor-pointer hover:bg-secondary/30"
                >
                  <td className="pl-4 pr-3 py-2.5 font-medium truncate">{r.name}</td>
                  <td className="px-3 py-2.5 truncate">{acctNameById.get(r.bankAccountId) || "—"}</td>
                  <td className="px-3 py-2.5 truncate">{r.payee || "—"}</td>
                  <td className="px-3 py-2.5 text-muted-foreground truncate">
                    {r.categoryId ? catNameById.get(r.categoryId) || "—" : "—"}
                  </td>
                  <td className="px-3 py-2.5 capitalize truncate">{r.direction}</td>
                  <td className="px-3 py-2.5 truncate">Day {r.dayOfMonth}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums truncate">
                    {r.amount != null
                      ? formatMoney(r.amount)
                      : <span className="text-muted-foreground italic">avg</span>}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground truncate">
                    {r.lastGeneratedFor || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground truncate">
                    {r.isActive ? computeNextRun(r) : "—"}
                  </td>
                  <td className="px-3 py-2.5 truncate">
                    {r.isActive ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                        Active
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                        Paused
                      </span>
                    )}
                  </td>
                  <td
                    className="px-2 py-2.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        title="Post next entry now"
                        disabled={!r.isActive || postNext.isPending}
                        onClick={() => postNext.mutate(r.id)}
                        className="h-7 w-7 rounded hover:bg-secondary text-muted-foreground hover:text-primary flex items-center justify-center disabled:opacity-40"
                      >
                        <Send size={13} />
                      </button>
                      <button
                        type="button"
                        title={r.isActive ? "Pause" : "Resume"}
                        onClick={() =>
                          togglePause.mutate({ id: r.id, isActive: !r.isActive })
                        }
                        className="h-7 w-7 rounded hover:bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center"
                      >
                        {r.isActive ? <Pause size={13} /> : <Play size={13} />}
                      </button>
                      <button
                        type="button"
                        title="Delete"
                        onClick={() => {
                          if (confirm(`Delete recurring rule "${r.name}"?`))
                            deleteMut.mutate(r.id);
                        }}
                        className="h-7 w-7 rounded hover:bg-secondary text-muted-foreground hover:text-destructive flex items-center justify-center"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!rules.data?.length && (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-muted-foreground">
                    No recurring rules yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <RuleEditor
          organizationId={organizationId}
          accounts={accounts}
          categories={cats.data || []}
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function RuleEditor({
  organizationId,
  accounts,
  categories,
  existing,
  onClose,
}: {
  organizationId: string;
  accounts: BankAccount[];
  categories: TransactionCategory[];
  existing: RecurringRule | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const usableAccounts = accounts.filter((a) => !a.isArchived);
  const [name, setName] = useState(existing?.name || "");
  const [bankAccountId, setBankAccountId] = useState(
    existing?.bankAccountId || usableAccounts[0]?.id || ""
  );
  const [payee, setPayee] = useState(existing?.payee || "");
  const [memo, setMemo] = useState(existing?.memo || "");
  const [categoryId, setCategoryId] = useState(existing?.categoryId || "");
  const [direction, setDirection] = useState<"debit" | "credit">(
    existing?.direction || "debit"
  );
  const [estimateMethod, setEstimateMethod] = useState<"fixed" | "avg_last_3">(
    existing?.estimateMethod || "fixed"
  );
  const [amount, setAmount] = useState<string>(
    existing?.amount != null ? String(existing.amount) : ""
  );
  const [dayOfMonth, setDayOfMonth] = useState<number>(existing?.dayOfMonth || 1);
  const [startDate, setStartDate] = useState(
    existing?.startDate
      ? new Date(existing.startDate).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10)
  );
  const [endDate, setEndDate] = useState(
    existing?.endDate ? new Date(existing.endDate).toISOString().slice(0, 10) : ""
  );
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        organizationId,
        bankAccountId,
        name,
        payee: payee || null,
        memo: memo || null,
        categoryId: categoryId || null,
        direction,
        estimateMethod,
        amount: estimateMethod === "fixed" ? Number(amount) || 0 : null,
        frequency: "monthly",
        dayOfMonth,
        startDate: new Date(startDate).toISOString(),
        endDate: endDate ? new Date(endDate).toISOString() : null,
        autoCreate: true,
        isActive,
      };
      const path = existing
        ? `/finance/recurring/${existing.id}`
        : "/finance/recurring";
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
            {existing ? "Edit recurring rule" : "New recurring rule"}
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
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              placeholder="e.g. Rent, Payroll, Utilities"
            />
          </Field>
          <Field label="Account">
            <select
              value={bankAccountId}
              onChange={(e) => setBankAccountId(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
            >
              {usableAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
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
            <Field label="Direction">
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as any)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              >
                <option value="debit">Money out (payment)</option>
                <option value="credit">Money in (deposit)</option>
              </select>
            </Field>
            <Field label="Day of month">
              <input
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) =>
                  setDayOfMonth(Math.min(31, Math.max(1, Number(e.target.value) || 1)))
                }
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm text-right"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Estimate method">
              <select
                value={estimateMethod}
                onChange={(e) => setEstimateMethod(e.target.value as any)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              >
                <option value="fixed">Fixed amount</option>
                <option value="avg_last_3">Average of last 3</option>
              </select>
            </Field>
            <Field label="Amount">
              <input
                type="number"
                step="0.01"
                value={amount}
                disabled={estimateMethod !== "fixed"}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm text-right tabular-nums disabled:opacity-50"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
            </Field>
            <Field label="End date (optional)">
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full h-9 px-2.5 rounded-md bg-background border border-input text-sm"
              />
            </Field>
          </div>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Active
          </label>
          {existing?.lastGeneratedFor && (
            <div className="text-xs text-muted-foreground">
              Last generated for {existing.lastGeneratedFor}
              {existing.startDate
                ? ` · started ${formatDate(existing.startDate)}`
                : ""}
            </div>
          )}
          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || !name.trim() || !bankAccountId}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
            >
              {save.isPending ? "Saving…" : existing ? "Save changes" : "Create rule"}
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

function computeNextRun(r: RecurringRule): string {
  // Predict next month + day. Generator runs monthly and stamps
  // lastGeneratedFor as "YYYY-MM"; the next run is the day-of-month
  // in the following month (or the start month if not yet generated).
  const today = new Date();
  let year: number;
  let month: number; // 0-indexed
  if (r.lastGeneratedFor && /^\d{4}-\d{2}$/.test(r.lastGeneratedFor)) {
    const [y, m] = r.lastGeneratedFor.split("-").map(Number);
    year = y;
    month = m - 1 + 1;
  } else if (r.startDate) {
    const s = new Date(r.startDate);
    year = s.getUTCFullYear();
    month = s.getUTCMonth();
  } else {
    year = today.getUTCFullYear();
    month = today.getUTCMonth();
  }
  if (month > 11) {
    year += 1;
    month -= 12;
  }
  // If predicted month is in the past, bump to current/next month.
  const predicted = new Date(Date.UTC(year, month, 1));
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  if (predicted < cursor) {
    year = today.getUTCFullYear();
    month = today.getUTCMonth();
    const dim = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    if (today.getUTCDate() > Math.min(r.dayOfMonth, dim)) {
      month += 1;
      if (month > 11) {
        year += 1;
        month -= 12;
      }
    }
  }
  if (r.endDate) {
    const end = new Date(r.endDate);
    if (
      year > end.getUTCFullYear() ||
      (year === end.getUTCFullYear() && month > end.getUTCMonth())
    ) {
      return "—";
    }
  }
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(r.dayOfMonth, daysInMonth);
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
