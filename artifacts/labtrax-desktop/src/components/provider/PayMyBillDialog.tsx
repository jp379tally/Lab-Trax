/**
 * PayMyBillDialog — lets a provider pay the most recent open statement in one
 * place, with three modes:
 *   1. Pay in Full      — pre-fills the full balance; allocates oldest-first.
 *   2. Partial Payment  — provider enters any amount ≤ balance; same allocation.
 *   3. Pay Individual   — checkbox list; provider chooses which invoices to pay
 *                         and can edit each amount before submitting.
 *
 * All payments are submitted as one hosted Stripe Checkout attempt. Invoice
 * accounting changes only after the API confirms the processor settlement.
 */
import { useState, useMemo, useRef } from "react";
import { apiFetch } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StatementInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  total?: string | number | null;
  balanceDue?: string | number | null;
  currentBalanceDue?: string | number | null;
  eligibleForPayment?: boolean;
  /** ISO timestamp — preferred sort key for oldest-first allocation. */
  issuedAt?: string | null;
  /** ISO timestamp — fallback sort key when issuedAt is absent. */
  createdAt?: string | null;
  displayMetadata?: {
    patientName?: string | null;
  } | null;
}

interface ProviderStatement {
  id: string;
  labName?: string | null;
  statementDate?: string | null;
  totalAmount?: string | number | null;
  balanceDue?: string | number | null;
  invoiceIds?: string[] | null;
}

type PayMode = "full" | "partial" | "individual";

interface PayMyBillDialogProps {
  statement: ProviderStatement;
  invoices: StatementInvoice[];
  onClose: () => void;
  /** Called only when the server says an idempotent retry already settled. */
  onDone: () => void;
  card?: {
    brand: string;
    last4: string;
    expMonth?: number | null;
    expYear?: number | null;
  } | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function balanceDueNum(val: string | number | null | undefined): number {
  if (val == null) return 0;
  const n = typeof val === "string" ? parseFloat(val) : val;
  return isNaN(n) ? 0 : n;
}

function formatCurrency(val: string | number | null | undefined): string {
  if (val == null) return "—";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n);
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function statusLabel(status: string): string {
  return status
    .split(/[_\s]+/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

const PAYABLE_STATUSES = new Set(["open", "partially_paid", "overdue"]);

function currentBalance(invoice: StatementInvoice): number {
  return balanceDueNum(invoice.currentBalanceDue ?? invoice.balanceDue);
}

function isPayable(invoice: StatementInvoice): boolean {
  const eligible = invoice.eligibleForPayment ??
    PAYABLE_STATUSES.has(invoice.status);
  return eligible && currentBalance(invoice) > 0.005;
}

/**
 * Returns a numeric timestamp for chronological ordering, preferring
 * issuedAt then createdAt.  Returns Infinity for invoices with no timestamp
 * so they sort last.
 */
function invoiceChronologicalKey(inv: StatementInvoice): number {
  const ts = inv.issuedAt ?? inv.createdAt;
  if (!ts) return Infinity;
  const ms = new Date(ts).getTime();
  return isNaN(ms) ? Infinity : ms;
}

/**
 * Distributes `total` dollars across open invoices in chronological
 * (oldest-first) order, returning `{ invoiceId, amount }[]` for the invoices
 * that receive a non-zero allocation.
 *
 * Exported for unit-testing.
 */
export function allocatePayment(
  invoices: StatementInvoice[],
  total: number,
): { invoiceId: string; amount: number }[] {
  const sorted = [...invoices]
    .filter(isPayable)
    .sort((a, b) => invoiceChronologicalKey(a) - invoiceChronologicalKey(b));

  const result: { invoiceId: string; amount: number }[] = [];
  let remaining = total;

  for (const inv of sorted) {
    if (remaining <= 0.005) break;
    const cap = currentBalance(inv);
    const apply = Math.min(remaining, cap);
    if (apply > 0.005) {
      result.push({
        invoiceId: inv.id,
        amount: Math.round(apply * 100) / 100,
      });
      remaining -= apply;
    }
  }

  return result;
}

// ─── PayMyBillDialog ──────────────────────────────────────────────────────────

export function PayMyBillDialog({
  statement,
  invoices,
  onClose,
  onDone,
  card = null,
}: PayMyBillDialogProps) {
  const statementBalance = balanceDueNum(statement.balanceDue);

  const [mode, setMode] = useState<PayMode>("full");
  const [savePaymentMethod, setSavePaymentMethod] = useState(!card);
  const requestId = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `provider-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  // Partial-payment amount field
  const [partialAmount, setPartialAmount] = useState(
    statementBalance.toFixed(2),
  );

  // Individual-invoice selection: invoiceId → { checked, amount }
  const payableInvoices = useMemo(
    () => invoices.filter(isPayable),
    [invoices],
  );

  const [selections, setSelections] = useState<
    Record<string, { checked: boolean; amount: string }>
  >(() =>
    Object.fromEntries(
      payableInvoices.map((inv) => [
        inv.id,
        {
          checked: true,
          amount: currentBalance(inv).toFixed(2),
        },
      ]),
    ),
  );

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Derived values ──────────────────────────────────────────────────────────

  const selectedTotal = useMemo(() => {
    if (mode !== "individual") return 0;
    return Object.values(selections).reduce((sum, s) => {
      if (!s.checked) return sum;
      const n = parseFloat(s.amount);
      return sum + (isNaN(n) ? 0 : n);
    }, 0);
  }, [mode, selections]);

  // ── Submit helper ───────────────────────────────────────────────────────────

  async function submitPayments(
    allocations: { invoiceId: string; amount: number }[],
  ) {
    if (allocations.length === 0) {
      setError(
        "No invoices to pay. Please select at least one invoice with a valid amount.",
      );
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const checkout = await apiFetch<{
        checkoutId: string;
        url: string | null;
        status: "pending" | "succeeded" | "cancelled" | "expired" | "failed";
      }>("/provider/payment-checkout", {
        method: "POST",
        headers: { "Idempotency-Key": requestId.current },
        body: JSON.stringify({
          allocations,
          savePaymentMethod,
        }),
      });
      if (checkout.status === "succeeded") {
        onDone();
        onClose();
        return;
      }
      if (!checkout.url) {
        throw new Error(
          checkout.status === "pending"
            ? "Checkout is still being prepared. Please try again."
            : "This checkout is no longer available. Refresh your balance before retrying.",
        );
      }
      window.location.assign(checkout.url);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not start secure card checkout. Please try again.",
      );
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (mode === "full") {
      const allocations = allocatePayment(invoices, statementBalance);
      await submitPayments(allocations);
    } else if (mode === "partial") {
      const parsed = parseFloat(partialAmount);
      if (isNaN(parsed) || parsed <= 0) {
        setError("Please enter a valid amount greater than zero.");
        return;
      }
      if (parsed > statementBalance + 0.005) {
        setError(
          `Amount cannot exceed the statement balance of ${formatCurrency(statementBalance)}.`,
        );
        return;
      }
      const allocations = allocatePayment(invoices, parsed);
      await submitPayments(allocations);
    } else {
      // individual
      const allocations: { invoiceId: string; amount: number }[] = [];
      for (const [invoiceId, sel] of Object.entries(selections)) {
        if (!sel.checked) continue;
        const parsed = parseFloat(sel.amount);
        if (isNaN(parsed) || parsed <= 0.005) continue;
        const inv = invoices.find((i) => i.id === invoiceId);
        if (!inv) continue;
        if (!isPayable(inv)) continue;
        const cap = currentBalance(inv);
        if (parsed > cap + 0.005) {
          setError(
            `Amount for invoice ${inv.invoiceNumber} exceeds its balance of ${formatCurrency(cap)}.`,
          );
          return;
        }
        allocations.push({
          invoiceId,
          amount: Math.round(parsed * 100) / 100,
        });
      }
      await submitPayments(allocations);
    }
  }

  // ── Main form ───────────────────────────────────────────────────────────────

  const modeTabClass = (m: PayMode) =>
    `flex-1 px-3 py-2 text-xs font-medium rounded-md transition-colors ${
      mode === m
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
    }`;

  return (
    <DialogShell onClose={onClose} submitting={submitting}>
      <form onSubmit={handleSubmit}>
        {/* ── Header ── */}
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-sm">Pay My Bill</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {statement.labName ?? "Your Lab"} · Statement{" "}
                {formatDate(statement.statementDate)}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="text-muted-foreground hover:text-foreground text-xl leading-none shrink-0 disabled:opacity-50"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {/* Statement summary */}
          <div className="mt-3 flex gap-6 text-xs">
            <div>
              <span className="text-muted-foreground">Total billed: </span>
              <span className="font-medium tabular-nums">
                {formatCurrency(statement.totalAmount)}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Balance due: </span>
              <span className="font-semibold tabular-nums text-amber-700">
                {formatCurrency(statementBalance)}
              </span>
            </div>
          </div>
        </div>

        {/* ── Mode tabs ── */}
        <div className="px-5 pt-4 pb-2">
          <div className="flex gap-1 bg-muted/40 rounded-lg p-1">
            <button
              type="button"
              className={modeTabClass("full")}
              onClick={() => setMode("full")}
              disabled={submitting}
            >
              Pay in Full
            </button>
            <button
              type="button"
              className={modeTabClass("partial")}
              onClick={() => setMode("partial")}
              disabled={submitting}
            >
              Partial Payment
            </button>
            <button
              type="button"
              className={modeTabClass("individual")}
              onClick={() => setMode("individual")}
              disabled={submitting}
            >
              Individual Invoices
            </button>
          </div>
        </div>

        {/* ── Mode-specific body ── */}
        <div className="px-5 py-3 space-y-3 max-h-[40vh] overflow-y-auto">
          {/* ─ Pay in Full ─ */}
          {mode === "full" && (
            <>
              <div>
                <label className="block text-xs font-medium mb-1">
                  Amount (full balance)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    $
                  </span>
                  <input
                    type="text"
                    readOnly
                    value={statementBalance.toFixed(2)}
                    className="w-full pl-7 pr-3 py-1.5 text-sm border border-border rounded-md bg-muted/40 cursor-default"
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Will be distributed oldest-first across{" "}
                  {payableInvoices.length} open{" "}
                  {payableInvoices.length === 1 ? "invoice" : "invoices"}.
                </p>
              </div>
              <CheckoutCardChoice
                card={card}
                savePaymentMethod={savePaymentMethod}
                setSavePaymentMethod={setSavePaymentMethod}
                disabled={submitting}
              />
            </>
          )}

          {/* ─ Partial Payment ─ */}
          {mode === "partial" && (
            <>
              <div>
                <label
                  htmlFor="provider-partial-payment-amount"
                  className="block text-xs font-medium mb-1"
                >
                  Amount to pay
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    $
                  </span>
                  <input
                    id="provider-partial-payment-amount"
                    type="number"
                    min="0.01"
                    max={statementBalance.toFixed(2)}
                    step="0.01"
                    value={partialAmount}
                    onChange={(e) => setPartialAmount(e.target.value)}
                    className="w-full pl-7 pr-3 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                    required
                    disabled={submitting}
                    autoFocus
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Maximum: {formatCurrency(statementBalance)}. Distributed
                  oldest-first across open invoices.
                </p>
              </div>
              <CheckoutCardChoice
                card={card}
                savePaymentMethod={savePaymentMethod}
                setSavePaymentMethod={setSavePaymentMethod}
                disabled={submitting}
              />
            </>
          )}

          {/* ─ Individual Invoices ─ */}
          {mode === "individual" && (
            <>
              {invoices.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No invoices loaded for this statement.
                </p>
              ) : (
                <div className="rounded-md border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 text-muted-foreground uppercase text-left">
                      <tr>
                        <th className="px-3 py-2 w-8" />
                        <th className="px-3 py-2 font-medium">Invoice #</th>
                        <th className="px-3 py-2 font-medium">Patient</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium text-right">
                          Balance
                        </th>
                        <th className="px-3 py-2 font-medium text-right w-28">
                          Pay amount
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.map((inv) => {
                        const canPay = isPayable(inv);
                        const sel = selections[inv.id];
                        return (
                          <tr
                            key={inv.id}
                            className={`border-t border-border ${canPay ? "" : "opacity-50"}`}
                          >
                            <td className="px-3 py-2 text-center">
                              {canPay ? (
                                <input
                                  type="checkbox"
                                  checked={sel?.checked ?? false}
                                  onChange={(e) =>
                                    setSelections((prev) => ({
                                      ...prev,
                                      [inv.id]: {
                                        ...prev[inv.id],
                                        checked: e.target.checked,
                                      },
                                    }))
                                  }
                                  disabled={submitting}
                                  className="h-3.5 w-3.5 rounded border-border accent-primary"
                                />
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 font-mono">
                              {inv.invoiceNumber}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {inv.displayMetadata?.patientName ?? "—"}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={`inline-block px-1.5 py-0.5 rounded-full font-medium ${
                                  inv.status === "paid"
                                    ? "bg-green-100 text-green-800"
                                    : inv.status === "void"
                                      ? "bg-muted text-muted-foreground"
                                      : "bg-amber-100 text-amber-800"
                                }`}
                              >
                                {statusLabel(inv.status)}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {formatCurrency(currentBalance(inv))}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {canPay ? (
                                <div className="relative">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground">
                                    $
                                  </span>
                                  <input
                                    type="number"
                                    min="0.01"
                                    max={currentBalance(inv).toFixed(
                                      2,
                                    )}
                                    step="0.01"
                                    value={sel?.amount ?? "0.00"}
                                    onChange={(e) =>
                                      setSelections((prev) => ({
                                        ...prev,
                                        [inv.id]: {
                                          ...prev[inv.id],
                                          amount: e.target.value,
                                          checked: true,
                                        },
                                      }))
                                    }
                                    disabled={submitting || !(sel?.checked)}
                                    className="w-24 pl-5 pr-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:bg-muted/40"
                                  />
                                </div>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Selected total */}
              <div className="flex items-center justify-between text-xs pt-1">
                <span className="text-muted-foreground">Selected total:</span>
                <span className="font-semibold tabular-nums">
                  {formatCurrency(selectedTotal)}
                </span>
              </div>

              <CheckoutCardChoice
                card={card}
                savePaymentMethod={savePaymentMethod}
                setSavePaymentMethod={setSavePaymentMethod}
                disabled={submitting}
              />
            </>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 text-xs">
              {error}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || statementBalance <= 0.005}
            className="px-4 py-1.5 text-sm rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {submitting
              ? "Opening secure checkout…"
              : mode === "individual"
                ? `Continue to Checkout — ${formatCurrency(selectedTotal)}`
                : mode === "full"
                  ? `Continue to Checkout — ${formatCurrency(statementBalance)}`
                  : "Continue to Checkout"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function DialogShell({
  children,
  onClose,
  submitting,
}: {
  children: React.ReactNode;
  onClose: () => void;
  submitting: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="bg-background border border-border rounded-lg shadow-xl w-full max-w-2xl mx-4 overflow-hidden">
        {children}
      </div>
    </div>
  );
}

function CheckoutCardChoice({
  card,
  savePaymentMethod,
  setSavePaymentMethod,
  disabled,
}: {
  card: {
    brand: string;
    last4: string;
    expMonth?: number | null;
    expYear?: number | null;
  } | null;
  savePaymentMethod: boolean;
  setSavePaymentMethod: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-3 space-y-2">
      <div className="text-xs font-medium">Secure card payment</div>
      {card ? (
        <p className="text-xs text-muted-foreground">
          Stripe Checkout will offer your saved {card.brand.toUpperCase()} ending
          in {card.last4}. You can choose another card in Checkout.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No shared card is saved yet. Stripe Checkout will ask for a card.
        </p>
      )}
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={savePaymentMethod}
          onChange={(event) => setSavePaymentMethod(event.target.checked)}
          disabled={disabled}
          className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-primary"
        />
        <span>
          {card
            ? "Use any newly entered card as the shared card."
            : "Save this card as the shared card for future payments."}
        </span>
      </label>
      <p className="text-[11px] text-muted-foreground">
        Your card details are entered and stored by Stripe. LabTrax never sees
        the full card number.
      </p>
      </div>
  );
}
