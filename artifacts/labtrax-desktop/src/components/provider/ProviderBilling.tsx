import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { formatShortDueDate } from "@/lib/format";
import type { LabCase } from "@/lib/types";
import { ProviderCaseInvoiceModal } from "./ProviderCaseInvoiceModal";
import { PayMyBillDialog } from "./PayMyBillDialog";

type ProviderCase = LabCase & {
  restorationTypes?: string | null;
  providerAccountNumber?: string | null;
  labName?: string | null;
  openInvoiceAmount?: number | null;
};

interface PaymentHistoryRow {
  id: string;
  paidAt: string | null;
  invoiceId: string;
  invoiceNumber: string | null;
  patientName: string | null;
  amount: string | number | null;
  paymentMethod: string | null;
  referenceNumber: string | null;
}

interface ProviderStatement {
  id: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  labName?: string | null;
  statementDate?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  invoiceCount?: number | null;
  totalAmount?: string | number | null;
  balanceDue?: string | number | null;
  invoiceIds?: string[] | null;
  createdAt?: string | null;
}

interface AccountBalance {
  currentBalance: string;
  openInvoiceCount: number;
}

interface InvoiceAutoPayPreference {
  providerOrganizationId: string;
  labOrganizationId: string | null;
  labName: string | null;
  providerName: string;
  enabled: boolean;
  chargeDay: number | null;
  authorization?: {
    authorizationId: string | null;
    authorizationStatus: string | null;
    nextRunAt: string | null;
    lastResult: string | null;
    lastFailureReason: string | null;
    updateCardRequired: boolean;
  };
}

interface ProviderCardSummary {
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
}

export interface StatementInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  total?: string | number | null;
  balanceDue?: string | number | null;
  currentBalanceDue?: string | number | null;
  eligibleForPayment?: boolean;
  /** ISO timestamp — used by PayMyBillDialog for oldest-first allocation. */
  issuedAt?: string | null;
  /** ISO timestamp — fallback sort key when issuedAt is absent. */
  createdAt?: string | null;
  displayMetadata?: {
    patientName?: string | null;
  } | null;
}


function formatCurrency(val: string | number | null | undefined): string {
  if (val == null) return "—";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

function formatCurrencyNum(amount: number | null | undefined): string {
  if (amount == null || amount === 0) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", {
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

function balanceDueNum(val: string | number | null | undefined): number {
  if (val == null) return 0;
  const n = typeof val === "string" ? parseFloat(val) : val;
  return isNaN(n) ? 0 : n;
}

function currentInvoiceBalance(invoice: StatementInvoice): number {
  return balanceDueNum(invoice.currentBalanceDue ?? invoice.balanceDue);
}

function canPayStatementInvoice(invoice: StatementInvoice): boolean {
  const legacyEligible = ["open", "partially_paid", "overdue"].includes(invoice.status);
  return (invoice.eligibleForPayment ?? legacyEligible) &&
    currentInvoiceBalance(invoice) > 0.005;
}

// ─────────────────────────────────────────────────────────────────────────────
// CaseDetailModal
// ─────────────────────────────────────────────────────────────────────────────
// PayDialog
// ─────────────────────────────────────────────────────────────────────────────
export interface PayDialogProps {
  invoice: StatementInvoice;
  onClose: () => void;
  onPaid: (updatedInvoice: StatementInvoice) => void;
}

export function PayDialog({ invoice, onClose, onPaid }: PayDialogProps) {
  const balance = currentInvoiceBalance(invoice);
  const [amount, setAmount] = useState(balance.toFixed(2));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `provider-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      setError("Please enter a valid amount greater than zero.");
      return;
    }
    if (parsed > balance + 0.005) {
      setError(
        `Amount cannot exceed balance due of ${formatCurrency(balance)}.`,
      );
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await apiFetch<{
        checkoutId: string;
        url: string | null;
        status: "pending" | "succeeded" | "cancelled" | "expired" | "failed";
      }>(
        "/provider/payment-checkout",
        {
          method: "POST",
          headers: { "Idempotency-Key": requestId },
          body: JSON.stringify({
            allocations: [{ invoiceId: invoice.id, amount: parsed }],
            savePaymentMethod: false,
          }),
        },
      );
      if (result.status === "succeeded") {
        onPaid({
          ...invoice,
          balanceDue: "0.00",
          currentBalanceDue: "0.00",
          eligibleForPayment: false,
        });
        return;
      }
      if (!result.url) {
        throw new Error(
          result.status === "pending"
            ? "Checkout is still being prepared. Please try again."
            : "This checkout is no longer available. Refresh the invoice before retrying.",
        );
      }
      window.location.assign(result.url);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not start secure card checkout. Please try again.",
      );
      setSubmitting(false);
    }
  }

  return (
    /* backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="bg-background border border-border rounded-lg shadow-xl w-full max-w-sm mx-4 overflow-hidden">
          <form onSubmit={handleSubmit}>
            <div className="px-4 py-3 border-b border-border">
              <div className="font-semibold text-sm">Pay Invoice</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Invoice{" "}
                <span className="font-mono">{invoice.invoiceNumber}</span>
                {invoice.displayMetadata?.patientName
                  ? ` · ${invoice.displayMetadata.patientName}`
                  : ""}
              </div>
            </div>

            <div className="px-4 py-4 space-y-3">
              {/* Amount */}
              <div>
                <label className="block text-xs font-medium mb-1">
                  Amount
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    $
                  </span>
                  <input
                    type="number"
                    min="0.01"
                    max={balance.toFixed(2)}
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full pl-7 pr-3 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                    required
                    disabled={submitting}
                  />
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Balance due: {formatCurrency(balance)}
                </div>
              </div>

              <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                You’ll complete this card payment securely in Stripe Checkout.
                Your invoice is updated only after Stripe confirms payment.
              </div>

              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 text-xs">
                  {error}
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
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
                disabled={submitting}
                className="px-4 py-1.5 text-sm rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {submitting ? "Opening secure checkout…" : "Continue to Checkout"}
              </button>
            </div>
          </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// StatementCard
// ─────────────────────────────────────────────────────────────────────────────
function StatementCard({
  statement,
  onPaymentComplete,
  onStatementBalanceChange,
  readOnly = false,
}: {
  statement: ProviderStatement;
  onPaymentComplete?: () => void;
  onStatementBalanceChange?: (statementId: string, newBalance: number) => void;
  readOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [invoices, setInvoices] = useState<StatementInvoice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Statement-level balance (updated optimistically after invoice payments)
  const [localBalance, setLocalBalance] = useState<number>(
    balanceDueNum(statement.balanceDue),
  );
  // Which invoice is currently being paid (null = no dialog open)
  const [payingInvoice, setPayingInvoice] = useState<StatementInvoice | null>(
    null,
  );

  async function loadInvoices() {
    if (invoices !== null || loading) return;
    if (!statement.invoiceIds || statement.invoiceIds.length === 0) {
      setInvoices([]);
      return;
    }
    setLoading(true);
    try {
      const detail = await apiFetch<{ invoices: StatementInvoice[] }>(
        `/provider/statements/${encodeURIComponent(statement.id)}`,
      );
      const loaded = detail.invoices;
      setInvoices(loaded);
      // Recompute localBalance from live invoice data and propagate upward so
      // ProviderBilling can re-filter displayedStatements with the true balance.
      const liveTotal = loaded.reduce(
        (s, inv) => s + currentInvoiceBalance(inv),
        0,
      );
      setLocalBalance(liveTotal);
      onStatementBalanceChange?.(statement.id, liveTotal);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load invoices.");
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadInvoices();
  }

  function handleInvoicePaid(updatedInvoice: StatementInvoice) {
    // Update the invoice in local list and recompute statement balance.
    setInvoices((prev) => {
      if (!prev) return prev;
      const updated = prev.map((inv) =>
        inv.id === updatedInvoice.id
          ? { ...inv, ...updatedInvoice }
          : inv,
      );
      const total = updated.reduce(
        (s, inv) => s + currentInvoiceBalance(inv),
        0,
      );
      setLocalBalance(total);
      // Propagate to parent so displayedStatements re-filters immediately.
      onStatementBalanceChange?.(statement.id, total);
      return updated;
    });
    setPayingInvoice(null);
    onPaymentComplete?.();
  }

  const statementHasBalance = localBalance > 0.005;

  return (
    <>
      <div className="rounded-md border border-border overflow-hidden">
        {/* Header */}
        <div className="w-full flex items-start justify-between px-4 py-3 hover:bg-muted/40 transition-colors">
          <button
            type="button"
            onClick={toggle}
            className="flex-1 flex items-start gap-2 text-left min-w-0"
          >
            <div className="min-w-0">
              <div className="font-medium text-sm">
                {statement.labName ?? "Your Lab"}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Statement date: {formatDate(statement.statementDate)}
                {statement.invoiceCount
                  ? ` · ${statement.invoiceCount} invoice${statement.invoiceCount === 1 ? "" : "s"}`
                  : ""}
              </div>
            </div>
          </button>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            <div className="text-right">
              <div className="text-sm font-semibold tabular-nums">
                {readOnly
                  ? formatCurrency(statement.totalAmount)
                  : formatCurrency(localBalance)}
              </div>
              <div className="text-xs text-muted-foreground">
                {readOnly ? "total billed" : "balance due"}
              </div>
            </div>
            <button
              type="button"
              onClick={toggle}
              className="text-muted-foreground text-xs transition-transform"
              aria-label={expanded ? "Collapse invoices" : "Expand invoices"}
            >
              <span
                className={`inline-block transition-transform ${expanded ? "rotate-180" : ""}`}
                aria-hidden="true"
              >
                ▼
              </span>
            </button>
          </div>
        </div>

        {/* Expanded invoice list */}
        {expanded && (
          <div className="border-t border-border">
            {loading ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                Loading invoices…
              </div>
            ) : error ? (
              <div className="px-4 py-3 text-sm text-destructive">{error}</div>
            ) : invoices && invoices.length === 0 ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                No invoices found for this statement.
              </div>
            ) : invoices ? (
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground text-left">
                  <tr>
                    <th className="px-4 py-2 font-medium">Invoice #</th>
                    <th className="px-4 py-2 font-medium">Patient</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium text-right">
                      Amount
                    </th>
                    <th className="px-4 py-2 font-medium text-right">
                      Balance
                    </th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => {
                    const invBalance = currentInvoiceBalance(inv);
                    const canPay = canPayStatementInvoice(inv);
                    return (
                      <tr key={inv.id} className="border-t border-border">
                        <td className="px-4 py-2 font-mono text-xs">
                          {inv.invoiceNumber}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {inv.displayMetadata?.patientName ?? "—"}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${
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
                        <td className="px-4 py-2 text-right tabular-nums">
                          {formatCurrency(inv.total)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs">
                          {invBalance > 0.005 ? (
                            <span className="text-amber-700 font-medium">
                              {formatCurrency(invBalance)}
                            </span>
                          ) : (
                            <span className="text-green-700">Paid</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {canPay && !readOnly && (
                            <button
                              type="button"
                              onClick={() => setPayingInvoice(inv)}
                              className="text-xs px-2.5 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
                            >
                              Pay
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : null}

            <div className="px-4 py-2 border-t border-border bg-muted/20 text-xs text-muted-foreground flex justify-between items-center">
              <span>Total billed: {formatCurrency(statement.totalAmount)}</span>
              <div className="flex items-center gap-3">
                {!readOnly && (
                  <span className="font-medium text-foreground">
                    Balance due: {formatCurrency(localBalance)}
                  </span>
                )}
                {statementHasBalance && invoices && invoices.length > 0 && !readOnly && (
                  <button
                    type="button"
                    onClick={() => {
                      // Open Pay dialog on the first payable invoice
                      const first = invoices.find(
                        (inv) =>
                          canPayStatementInvoice(inv),
                      );
                      if (first) setPayingInvoice(first);
                    }}
                    className="text-xs px-2.5 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
                  >
                    Pay oldest
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Statement-level Pay button (visible without expanding) */}
        {!expanded && statementHasBalance && !readOnly && (
          <div className="border-t border-border px-4 py-2 bg-muted/10 flex justify-end">
            <button
              type="button"
              onClick={async () => {
                // Ensure invoices are loaded before opening dialog
                if (!invoices) {
                  await loadInvoices();
                }
                setExpanded(true);
                // After loading, the user will see the per-invoice Pay buttons
              }}
              className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
            >
              View &amp; Pay — {formatCurrency(localBalance)} due
            </button>
          </div>
        )}
      </div>

      {/* Payment dialog (portal-like, rendered outside the card flow) */}
      {payingInvoice && (
        <PayDialog
          invoice={payingInvoice}
          onClose={() => setPayingInvoice(null)}
          onPaid={handleInvoicePaid}
        />
      )}
    </>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-md border border-border px-4 py-3 animate-pulse">
      <div className="h-4 bg-muted rounded w-40 mb-2" />
      <div className="h-3 bg-muted rounded w-56" />
    </div>
  );
}

const PAYMENT_METHOD_DISPLAY: Record<string, string> = {
  card: "Card",
  ach: "ACH",
  check: "Check",
  cash: "Cash",
  other: "Other",
};

function PaymentHistoryTable({
  rows,
  isFiltered,
}: {
  rows: PaymentHistoryRow[];
  isFiltered?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border py-10 text-center">
        <div className="text-2xl mb-2">💳</div>
        <div className="font-medium text-sm mb-1">
          {isFiltered ? "No payments in this period" : "No payments yet"}
        </div>
        <div className="text-xs text-muted-foreground">
          {isFiltered
            ? "Try a different date range or check another period."
            : "Payments you record will appear here."}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground text-left">
          <tr>
            <th className="px-4 py-2 font-medium">Date paid</th>
            <th className="px-4 py-2 font-medium">Invoice #</th>
            <th className="px-4 py-2 font-medium">Patient</th>
            <th className="px-4 py-2 font-medium">Method</th>
            <th className="px-4 py-2 font-medium">Reference #</th>
            <th className="px-4 py-2 font-medium text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="border-t border-border">
              <td className="px-4 py-2 tabular-nums text-xs">
                {formatDate(p.paidAt)}
              </td>
              <td className="px-4 py-2 font-mono text-xs">
                {p.invoiceNumber ?? "—"}
              </td>
              <td className="px-4 py-2 text-muted-foreground">
                {p.patientName ?? "—"}
              </td>
              <td className="px-4 py-2 text-muted-foreground">
                {p.paymentMethod
                  ? (PAYMENT_METHOD_DISPLAY[p.paymentMethod] ?? p.paymentMethod)
                  : "—"}
              </td>
              <td className="px-4 py-2 text-muted-foreground font-mono text-xs">
                {p.referenceNumber ?? "—"}
              </td>
              <td className="px-4 py-2 text-right tabular-nums font-medium">
                {formatCurrency(p.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ProviderBillingProps {
  cases: ProviderCase[] | null;
  casesError: string | null;
  onRefreshCases?: () => void;
}

type HistoryFilter = "this_month" | "last_month" | "custom";
type PastStatementsFilter = "this_year" | "last_year" | "custom";
export function ProviderBilling({ cases, casesError, onRefreshCases }: ProviderBillingProps) {
  const [statements, setStatements] = useState<ProviderStatement[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [accountBalances, setAccountBalances] = useState<AccountBalance[]>([]);

  const [paymentHistory, setPaymentHistory] = useState<
    PaymentHistoryRow[] | null
  >(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("this_month");
  const [pastStatementsOpen, setPastStatementsOpen] = useState(false);
  const [pastStatementsFilter, setPastStatementsFilter] = useState<PastStatementsFilter>("this_year");
  const [pastCustomFrom, setPastCustomFrom] = useState("");
  const [pastCustomTo, setPastCustomTo] = useState("");
  const [pastLabSearch, setPastLabSearch] = useState("");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  // Pay My Bill dialog state.
  // payMyBillStatement is captured at button-click time so the dialog stays
  // mounted through its result screen even after onDone() refreshes
  // displayedStatements and the paid statement is filtered out.
  const [payMyBillStatement, setPayMyBillStatement] = useState<ProviderStatement | null>(null);
  const [payMyBillInvoices, setPayMyBillInvoices] = useState<StatementInvoice[]>([]);
  const [payMyBillLoading, setPayMyBillLoading] = useState(false);
  const [payMyBillError, setPayMyBillError] = useState<string | null>(null);
  const [autoPayLabs, setAutoPayLabs] = useState<InvoiceAutoPayPreference[]>([]);
  const [autoPaySaving, setAutoPaySaving] = useState<string | null>(null);
  // The schedule the server last confirmed for each lab relationship. The
  // rows above are edited in place, so a refused save has nothing else to put
  // them back to.
  const confirmedAutoPay = useRef<
    Record<string, { enabled: boolean; chargeDay: number | null }>
  >({});
  const [card, setCard] = useState<ProviderCardSummary | null>(null);
  const [checkoutNotice, setCheckoutNotice] = useState<{
    tone: "success" | "warning" | "danger";
    message: string;
    checkoutId?: string;
  } | null>(null);

  const fetchStatements = useCallback(async () => {
    try {
      const data = await apiFetch<ProviderStatement[]>("/provider/statements");
      setStatements(data);
      const relationships = Array.from(
        new Map(
          data.map((statement) => [
            `${statement.labOrganizationId}:${statement.providerOrganizationId}`,
            statement,
          ]),
        ).values(),
      );
      setAccountBalances(
        await Promise.all(
          relationships.map((relationship) =>
            apiFetch<AccountBalance>(
              `/billing/${encodeURIComponent(relationship.labOrganizationId)}/accounts/${encodeURIComponent(relationship.providerOrganizationId)}/balance`,
            ).catch(() => ({
              currentBalance: String(relationship.balanceDue ?? 0),
              openInvoiceCount: Number(relationship.invoiceCount ?? 0),
            })),
          ),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load statements.");
    }
  }, []);

  const refreshConfirmedPayment = useCallback(async () => {
    await fetchStatements();
    onRefreshCases?.();
    if (paymentHistory !== null) {
      try {
        setPaymentHistory(
          await apiFetch<PaymentHistoryRow[]>("/provider/payment-history"),
        );
      } catch {
        // The settlement remains confirmed even if a secondary refresh fails.
      }
    }
  }, [fetchStatements, onRefreshCases, paymentHistory]);

  const checkCheckoutStatus = useCallback(
    async (checkoutId: string, cancelFirst = false) => {
      setCheckoutNotice({
        tone: "warning",
        message: "Confirming your payment with Stripe…",
        checkoutId,
      });
      try {
        if (cancelFirst) {
          await apiFetch(`/provider/payment-checkout/${encodeURIComponent(checkoutId)}/cancel`, {
            method: "POST",
          });
        }
        const result = await apiFetch<{
          status: "pending" | "succeeded" | "cancelled" | "expired" | "failed";
          failureReason: string | null;
        }>(`/provider/payment-checkout/${encodeURIComponent(checkoutId)}`);
        if (result.status === "succeeded") {
          await refreshConfirmedPayment();
          setCheckoutNotice({
            tone: "success",
            message: "Stripe confirmed your payment. Your balances are refreshed.",
          });
        } else if (result.status === "pending") {
          setCheckoutNotice({
            tone: "warning",
            message:
              "Stripe is still confirming this payment. No invoice has been marked paid yet.",
            checkoutId,
          });
        } else if (result.status === "cancelled") {
          setCheckoutNotice({
            tone: "warning",
            message: "Checkout was cancelled. No invoice was marked paid.",
          });
        } else if (result.status === "expired") {
          setCheckoutNotice({
            tone: "danger",
            message:
              "That checkout session expired. Refresh your balances before trying again.",
          });
        } else {
          setCheckoutNotice({
            tone: "danger",
            message:
              result.failureReason === "stale_invoice_balance"
                ? "Your invoice balance changed before settlement. Refresh and try again."
                : "Stripe could not complete this payment. No invoice was marked paid.",
          });
        }
      } catch (error) {
        setCheckoutNotice({
          tone: "danger",
          message:
            error instanceof Error
              ? error.message
              : "Could not confirm the checkout result.",
          checkoutId,
        });
      }
    },
    [refreshConfirmedPayment],
  );

  async function saveLabAutoPay(preference: InvoiceAutoPayPreference) {
    if (
      autoPaySaving ||
      (preference.chargeDay != null && (
        !Number.isInteger(preference.chargeDay) ||
        preference.chargeDay < 1 ||
        preference.chargeDay > 10
      ))
    ) {
      if (!autoPaySaving) {
        setCheckoutNotice({
          tone: "danger",
          message: "Invoice auto-pay charge day must be from 1 through 10.",
        });
      }
      return;
    }
    setAutoPaySaving(preference.providerOrganizationId);
    try {
      const result = await apiFetch<{ lab: InvoiceAutoPayPreference }>(
        `/provider/labs/${encodeURIComponent(preference.providerOrganizationId)}/invoice-autopay`,
        {
          method: "PATCH",
          body: JSON.stringify({
            enabled: preference.enabled,
            chargeDay: preference.enabled ? preference.chargeDay : null,
          }),
        },
      );
      setAutoPayLabs((current) =>
        current.map((lab) =>
          lab.providerOrganizationId === preference.providerOrganizationId
            ? { ...lab, ...result.lab }
            : lab,
        ),
      );
      confirmedAutoPay.current[preference.providerOrganizationId] = {
        enabled: result.lab.enabled,
        chargeDay: result.lab.chargeDay,
      };
      setCheckoutNotice({
        tone: "success",
        message: `${preference.labName ?? "Lab"} invoice auto-pay preference saved.`,
      });
    } catch (error) {
      // Nothing was stored, so the row goes back to the schedule the server
      // confirmed. A refused save that leaves the box ticked would read as an
      // active schedule the lab will never charge against.
      const confirmed = confirmedAutoPay.current[preference.providerOrganizationId];
      if (confirmed) {
        setAutoPayLabs((current) =>
          current.map((lab) =>
            lab.providerOrganizationId === preference.providerOrganizationId
              ? { ...lab, ...confirmed }
              : lab,
          ),
        );
      }
      setCheckoutNotice({
        tone: "danger",
        message:
          error instanceof Error ? error.message : "Could not save invoice auto-pay.",
      });
    } finally {
      setAutoPaySaving(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [data, preferences, cardData] = await Promise.all([
          apiFetch<ProviderStatement[]>("/provider/statements"),
          (async () => {
            try {
              return (
                (await apiFetch<{ labs: InvoiceAutoPayPreference[] }>(
                  "/provider/billing-preferences",
                )) ?? { labs: [] }
              );
            } catch {
              return { labs: [] };
            }
          })(),
          (async () => {
            try {
              return (
                (await apiFetch<{ card: ProviderCardSummary | null }>(
                  "/provider/payment-method",
                )) ?? { card: null }
              );
            } catch {
              return { card: null };
            }
          })(),
        ]);
        if (!cancelled) {
          setStatements(data);
          const relationships = Array.from(
            new Map(
              data.map((statement) => [
                `${statement.labOrganizationId}:${statement.providerOrganizationId}`,
                statement,
              ]),
            ).values(),
          );
          setAccountBalances(
            await Promise.all(
              relationships.map((relationship) =>
                apiFetch<AccountBalance>(
                  `/billing/${encodeURIComponent(relationship.labOrganizationId)}/accounts/${encodeURIComponent(relationship.providerOrganizationId)}/balance`,
                ).catch(() => ({
                  currentBalance: String(relationship.balanceDue ?? 0),
                  openInvoiceCount: Number(relationship.invoiceCount ?? 0),
                })),
              ),
            ),
          );
          const loadedLabs = preferences.labs ?? [];
          for (const lab of loadedLabs) {
            confirmedAutoPay.current[lab.providerOrganizationId] = {
              enabled: lab.enabled,
              chargeDay: lab.chargeDay,
            };
          }
          setAutoPayLabs(loadedLabs);
          setCard(cardData.card ?? null);
        }
        const params = new URLSearchParams(window.location.search);
        const checkoutId = params.get("providerPaymentCheckout");
        if (checkoutId && !cancelled) {
          await checkCheckoutStatus(checkoutId, params.get("cancelled") === "1");
          params.delete("providerPaymentCheckout");
          params.delete("cancelled");
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`,
          );
        }
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Failed to load statements.",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checkCheckoutStatus]);

  // Lazy-fetch: only load payment history once the section is first opened.
  useEffect(() => {
    if (!historyOpen) return;
    if (paymentHistory !== null || historyError !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<PaymentHistoryRow[]>(
          "/provider/payment-history",
        );
        if (!cancelled) setPaymentHistory(data);
      } catch (e) {
        if (!cancelled)
          setHistoryError(
            e instanceof Error ? e.message : "Failed to load payment history.",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [historyOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter statements to open/unpaid only (always an array once statements loaded)
  const displayedStatements: ProviderStatement[] = Array.isArray(statements)
    ? statements.filter((s) => balanceDueNum(s.balanceDue) > 0.005)
    : [];

  // Paid/void statements (balanceDue ≤ 0) shown in the collapsible Past Statements section
  const pastStatements = Array.isArray(statements)
    ? statements.filter((s) => balanceDueNum(s.balanceDue) <= 0.005)
    : [];

  // Client-side filter for past statements by statementDate then lab name
  const filteredPastStatements: ProviderStatement[] = (() => {
    if (pastStatements.length === 0) return [];
    const now = new Date();
    let dateFiltered: ProviderStatement[];
    if (pastStatementsFilter === "this_year") {
      const start = new Date(now.getFullYear(), 0, 1);
      const end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      dateFiltered = pastStatements.filter((s) => {
        if (!s.statementDate) return true;
        const d = new Date(s.statementDate);
        return d >= start && d <= end;
      });
    } else if (pastStatementsFilter === "last_year") {
      const start = new Date(now.getFullYear() - 1, 0, 1);
      const end = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);
      dateFiltered = pastStatements.filter((s) => {
        if (!s.statementDate) return true;
        const d = new Date(s.statementDate);
        return d >= start && d <= end;
      });
    } else {
      // custom
      dateFiltered = pastStatements.filter((s) => {
        if (!s.statementDate) return true;
        const d = new Date(s.statementDate);
        if (pastCustomFrom) {
          const from = new Date(pastCustomFrom + "T00:00:00");
          if (d < from) return false;
        }
        if (pastCustomTo) {
          const to = new Date(pastCustomTo + "T23:59:59.999");
          if (d > to) return false;
        }
        return true;
      });
    }
    // Unified search filter (client-side, case-insensitive substring) —
    // matches against lab name, the formatted/raw statement date, or the
    // invoice count so providers can search by any of those fields from the
    // same box, not just the lab name.
    const trimmedSearch = pastLabSearch.trim().toLowerCase();
    if (!trimmedSearch) return dateFiltered;
    return dateFiltered.filter((s) => {
      const labMatch = (s.labName ?? "").toLowerCase().includes(trimmedSearch);
      const formattedDateMatch = formatDate(s.statementDate)
        .toLowerCase()
        .includes(trimmedSearch);
      const rawDateMatch = (s.statementDate ?? "")
        .toLowerCase()
        .includes(trimmedSearch);
      const invoiceCountMatch =
        s.invoiceCount != null &&
        String(s.invoiceCount).includes(trimmedSearch);
      return labMatch || formattedDateMatch || rawDateMatch || invoiceCountMatch;
    });
  })();

  // Best-effort guess at which field the provider meant to search by, so the
  // "no match" empty state can name that field instead of always saying
  // "lab name" — a plain number reads as an invoice count, a digit paired
  // with a slash/dash/month name reads as a date, everything else is a name.
  const pastStatementsSearchFieldGuess: "invoiceCount" | "date" | "labName" =
    (() => {
      const t = pastLabSearch.trim();
      if (!t) return "labName";
      if (/^\d+$/.test(t)) return "invoiceCount";
      const monthNamePattern = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i;
      if (/\d/.test(t) && (/[-/]/.test(t) || monthNamePattern.test(t))) {
        return "date";
      }
      return "labName";
    })();

  // Client-side payment history filtering
  const filteredRows: PaymentHistoryRow[] = (() => {
    if (!paymentHistory) return [];
    if (historyFilter === "this_month") {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      return paymentHistory.filter((p) => {
        if (!p.paidAt) return false;
        const d = new Date(p.paidAt);
        return d >= start && d <= end;
      });
    }
    if (historyFilter === "last_month") {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return paymentHistory.filter((p) => {
        if (!p.paidAt) return false;
        const d = new Date(p.paidAt);
        return d >= start && d <= end;
      });
    }
    // custom
    return paymentHistory.filter((p) => {
      if (!p.paidAt) return false;
      const d = new Date(p.paidAt);
      if (customFrom) {
        const from = new Date(customFrom + "T00:00:00");
        if (d < from) return false;
      }
      if (customTo) {
        const to = new Date(customTo + "T23:59:59.999");
        if (d > to) return false;
      }
      return true;
    });
  })();

  // Compute open cases / balance from passed cases prop
  const labNames = cases
    ? Array.from(new Set(cases.map((c) => c.labName).filter(Boolean)))
    : [];
  const multiLab = labNames.length > 1;

  const openCases = cases
    ? cases.filter((c) => (c.openInvoiceAmount ?? 0) > 0)
    : cases;

  const totalOpenBalance =
    accountBalances.length > 0
      ? accountBalances.reduce(
          (sum, balance) => sum + Number(balance.currentBalance || 0),
          0,
        )
      : openCases
        ? openCases.reduce((sum, c) => sum + (c.openInvoiceAmount ?? 0), 0)
        : 0;
  const openCaseCount =
    accountBalances.length > 0
      ? accountBalances.reduce(
          (sum, balance) => sum + balance.openInvoiceCount,
          0,
        )
      : openCases
        ? openCases.length
        : 0;

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-base font-semibold">View and Pay My Bill</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Your recent billing statements from the lab
        </p>
      </div>

      {checkoutNotice && (
        <div
          role="status"
          className={`mb-4 rounded-md border px-4 py-3 text-sm ${
            checkoutNotice.tone === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : checkoutNotice.tone === "warning"
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          <div>{checkoutNotice.message}</div>
          {checkoutNotice.checkoutId && checkoutNotice.tone !== "success" && (
            <button
              type="button"
              onClick={() => void checkCheckoutStatus(checkoutNotice.checkoutId!)}
              className="mt-2 rounded-md border border-current/30 px-2.5 py-1 text-xs font-medium"
            >
              Check payment status again
            </button>
          )}
        </div>
      )}

      {autoPayLabs.length > 0 && (
        <section className="mb-6 rounded-lg border border-border bg-card p-5">
          <h3 className="text-sm font-semibold">Invoice auto-pay by lab</h3>
          <p className="mt-1 mb-4 text-xs text-muted-foreground">
            Each linked lab is controlled independently. When enabled, the full
            current balance for that lab is charged on your selected day.
            Payments are due by the 10th.
          </p>
          <div className="space-y-3">
            {autoPayLabs.map((preference) => (
              <div
                key={preference.providerOrganizationId}
                className="grid gap-3 rounded-md border border-border px-4 py-3 sm:grid-cols-[1fr_auto_auto]"
              >
                <div>
                  <div className="text-sm font-medium">
                    {preference.labName ?? "Linked lab"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Full current lab balance on day {preference.chargeDay}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {preference.authorization?.authorizationId
                      ? `Signed authorization active${preference.authorization.nextRunAt ? ` · Next run ${formatDate(preference.authorization.nextRunAt)}` : ""}`
                      : "Signed authorization required before charges can run"}
                  </div>
                  {preference.authorization?.lastResult && (
                    <div className={preference.authorization.updateCardRequired ? "mt-1 text-xs text-destructive" : "mt-1 text-xs text-muted-foreground"}>
                      Last result: {statusLabel(preference.authorization.lastResult)}
                      {preference.authorization.lastFailureReason ? ` · ${preference.authorization.lastFailureReason}` : ""}
                      {preference.authorization.updateCardRequired ? " · Update card required" : ""}
                    </div>
                  )}
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={preference.enabled}
                    disabled={autoPaySaving !== null}
                    onChange={(event) =>
                      setAutoPayLabs((current) =>
                        current.map((lab) =>
                          lab.providerOrganizationId === preference.providerOrganizationId
                            ? { ...lab, enabled: event.target.checked }
                            : lab,
                        ),
                      )
                    }
                    className="h-4 w-4 accent-primary"
                  />
                  Enable
                </label>
                <div className="flex items-center gap-2">
                  <label className="text-xs">Day</label>
                  <input
                    aria-label={`Charge day for ${preference.labName ?? "linked lab"}`}
                    type="number"
                    min={1}
                    max={10}
                    value={preference.chargeDay ?? ""}
                    disabled={autoPaySaving !== null}
                    onChange={(event) =>
                      setAutoPayLabs((current) =>
                        current.map((lab) =>
                          lab.providerOrganizationId === preference.providerOrganizationId
                            ? { ...lab, chargeDay: Number(event.target.value) }
                            : lab,
                        ),
                      )
                    }
                    className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    disabled={autoPaySaving !== null}
                    onClick={() => void saveLabAutoPay(preference)}
                    className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {autoPaySaving === preference.providerOrganizationId ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Outstanding balance summary card ── */}
      {!casesError && cases !== null && (
        <div className="mb-6 rounded-lg border border-border bg-card p-5 flex items-center gap-8 flex-wrap">
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Total Outstanding
            </p>
            {openCaseCount === 0 ? (
              <p className="mt-1 text-2xl font-semibold text-muted-foreground">
                $0.00
              </p>
            ) : (
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                  minimumFractionDigits: 2,
                }).format(totalOpenBalance)}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Open Cases
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {openCaseCount}
            </p>
          </div>
          {openCaseCount === 0 && (
            <p className="text-sm text-muted-foreground ml-4">
              No outstanding balances. You&apos;re all caught up!
            </p>
          )}
          {/* Pay My Bill button — shown when there is at least one open statement */}
          {displayedStatements.length > 0 && (
            <div className="ml-auto flex flex-col items-end gap-1">
              <button
                type="button"
                disabled={payMyBillLoading}
                onClick={async () => {
                  const mostRecent = displayedStatements[0];
                  if (!mostRecent) return;
                  setPayMyBillLoading(true);
                  setPayMyBillError(null);
                  // Ensure dialog is closed while loading so the provider
                  // can't interact with a dialog that has no invoices yet.
                  setPayMyBillStatement(null);
                  try {
                    const ids: string[] = Array.isArray(mostRecent.invoiceIds)
                      ? mostRecent.invoiceIds
                      : [];
                    // All-or-error: fetch every invoice before opening the
                    // dialog. If any request fails we surface an error near
                    // the button and never open the dialog, preventing silent
                    // underpayment from an incomplete invoice set.
                    const detail = await apiFetch<{ invoices: StatementInvoice[] }>(
                      `/provider/statements/${encodeURIComponent(mostRecent.id)}`,
                    );
                    // Set statement and invoices together so the dialog mounts
                    // fully-hydrated in a single render. The statement is
                    // captured here (not from displayedStatements) so the
                    // dialog stays mounted through onDone() refreshes that may
                    // filter the paid statement out of the list.
                    setPayMyBillInvoices(detail.invoices);
                    setPayMyBillStatement(mostRecent);
                  } catch (err) {
                    // Loading failed — keep dialog closed, show error near
                    // the button. payMyBillStatement is already null.
                    setPayMyBillError(
                      err instanceof Error
                        ? `Could not load invoices: ${err.message}`
                        : "Could not load invoices. Please try again.",
                    );
                  } finally {
                    setPayMyBillLoading(false);
                  }
                }}
                className="px-5 py-2.5 rounded-md bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-sm"
              >
                {payMyBillLoading ? "Loading…" : "Pay My Bill"}
              </button>
              {payMyBillError && (
                <p className="text-xs text-destructive max-w-48 text-right">
                  {payMyBillError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Pay My Bill dialog — keyed on statement id so it fully resets if
          a different statement is opened. Mounted from captured payMyBillStatement
          so it survives onDone() filtering the paid statement out of
          displayedStatements. Closed only via the dialog's own Done/Cancel. */}
      {payMyBillStatement && (
        <PayMyBillDialog
          key={payMyBillStatement.id}
          statement={payMyBillStatement}
          invoices={payMyBillInvoices}
          onClose={() => setPayMyBillStatement(null)}
          onDone={() => {
            void fetchStatements();
            onRefreshCases?.();
          }}
          card={card}
        />
      )}

      {/* ── Open Cases table ── */}
      <div className="mb-4">
        <h3 className="text-sm font-semibold">Open Cases</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Cases with outstanding invoice balances
        </p>
      </div>

      {casesError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-4 py-3 text-sm mb-6"
        >
          {casesError}
        </div>
      ) : cases === null ? (
        <div className="text-sm text-muted-foreground mb-6">Loading cases…</div>
      ) : openCases === null || openCases.length === 0 ? (
        <div className="text-sm text-muted-foreground py-6 text-center mb-6">
          {cases.length === 0
            ? "You have no assigned cases yet."
            : "No cases with outstanding balances."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border mb-8">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Case #</th>
                <th className="px-4 py-2 font-medium">Patient</th>
                <th className="px-4 py-2 font-medium">Restorations</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Due</th>
                {multiLab && (
                  <th className="px-4 py-2 font-medium">Lab</th>
                )}
                <th className="px-4 py-2 font-medium text-right">
                  Open Balance
                </th>
              </tr>
            </thead>
            <tbody>
              {openCases.map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => setSelectedCaseId(c.id)}
                >
                  <td className="px-4 py-2 font-mono text-xs">
                    {c.caseNumber}
                  </td>
                  <td className="px-4 py-2">
                    {c.patientFirstName || c.patientLastName
                      ? `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim()
                      : (c.patientInitials ?? "—")}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {c.restorationTypes ?? "—"}
                  </td>
                  <td className="px-4 py-2">{statusLabel(c.status)}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {formatShortDueDate(c.dueDate)}
                  </td>
                  {multiLab && (
                    <td className="px-4 py-2 text-muted-foreground">
                      {c.labName ?? "—"}
                    </td>
                  )}
                  <td className="px-4 py-2 text-right font-medium tabular-nums">
                    {formatCurrencyNum(c.openInvoiceAmount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Statements ── */}
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-4 py-3 text-sm"
        >
          {error}
        </div>
      ) : statements === null ? (
        <div className="space-y-3">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : statements.length === 0 ? (
        <div className="rounded-md border border-dashed border-border py-12 text-center">
          <div className="text-2xl mb-2">🧾</div>
          <div className="font-medium text-sm mb-1">No statements yet</div>
          <div className="text-xs text-muted-foreground">
            Your billing statements will appear here once the lab has generated
            them.
          </div>
        </div>
      ) : (
        <>
          {statements.length > 0 && (
            <p className="text-xs text-muted-foreground mb-3">
              Showing open and unpaid items — see Past Statements below for paid bills
            </p>
          )}
          {displayedStatements.length === 0 ? (
            <div className="rounded-md border border-dashed border-border py-10 text-center">
              <div className="text-2xl mb-2">✅</div>
              <div className="font-medium text-sm mb-1">All paid up</div>
              <div className="text-xs text-muted-foreground">
                No outstanding statements — you have no balance due.
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {displayedStatements.map((s) => (
                <StatementCard
                  key={s.id}
                  statement={s}
                  onPaymentComplete={onRefreshCases}
                  onStatementBalanceChange={(statementId, newBalance) => {
                    setStatements((prev) =>
                      Array.isArray(prev)
                        ? prev.map((st) =>
                            st.id === statementId
                              ? { ...st, balanceDue: newBalance.toFixed(2) }
                              : st,
                          )
                        : prev,
                    );
                    // When a statement is fully paid it migrates from the open list
                    // into Past Statements. Reset the past-statements filter to
                    // "this_year" and open the section so the newly-arrived
                    // statement is always visible instead of being silently hidden
                    // by whatever filter the user had previously selected.
                    if (newBalance <= 0.005) {
                      setPastStatementsFilter("this_year");
                      setPastStatementsOpen(true);
                    }
                  }}
                />
              ))}
            </div>
          )}

          {/* ── Past Statements (collapsed by default) ── */}
          {pastStatements.length > 0 && (
            <div className="mt-6">
              <button
                type="button"
                onClick={() => setPastStatementsOpen((v) => !v)}
                className="w-full flex items-center justify-between py-2 group"
                aria-expanded={pastStatementsOpen}
                data-testid="past-statements-toggle"
              >
                <div className="text-left">
                  <h2 className="text-base font-semibold group-hover:text-primary transition-colors">
                    Past Statements
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {pastStatements.length} paid{" "}
                    {pastStatements.length === 1 ? "statement" : "statements"}
                  </p>
                </div>
                <span
                  className={`text-muted-foreground transition-transform duration-200 ${pastStatementsOpen ? "rotate-180" : ""}`}
                  aria-hidden="true"
                >
                  ▼
                </span>
              </button>

              {pastStatementsOpen && (
                <div className="mt-3">
                  {/* Date filter chips */}
                  <div className="flex flex-wrap items-center gap-2 mb-4" data-testid="past-statements-filter">
                    {(
                      [
                        { key: "this_year", label: "This year" },
                        { key: "last_year", label: "Last year" },
                        { key: "custom", label: "Custom" },
                      ] as const
                    ).map(({ key, label }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setPastStatementsFilter(key)}
                        className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                          pastStatementsFilter === key
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background text-muted-foreground border-border hover:border-primary/60 hover:text-foreground"
                        }`}
                      >
                        {label}
                      </button>
                    ))}

                    {pastStatementsFilter === "custom" && (
                      <div className="flex items-center gap-2 ml-1">
                        <input
                          type="date"
                          value={pastCustomFrom}
                          onChange={(e) => setPastCustomFrom(e.target.value)}
                          className="px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                          aria-label="Past statements from date"
                        />
                        <span className="text-xs text-muted-foreground">to</span>
                        <input
                          type="date"
                          value={pastCustomTo}
                          onChange={(e) => setPastCustomTo(e.target.value)}
                          className="px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                          aria-label="Past statements to date"
                        />
                      </div>
                    )}
                  </div>

                  {/* Unified search — lab name, statement date, or invoice count */}
                  <div className="mb-3">
                    <input
                      type="text"
                      value={pastLabSearch}
                      onChange={(e) => setPastLabSearch(e.target.value)}
                      placeholder="Search by lab name, statement date, or invoice count…"
                      aria-label="Search past statements by lab name, statement date, or invoice count"
                      data-testid="past-statements-lab-search"
                      className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                    />
                  </div>

                  {filteredPastStatements.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border py-8 text-center">
                      <div className="text-2xl mb-2">📄</div>
                      <div className="font-medium text-sm mb-1">
                        {pastLabSearch.trim()
                          ? pastStatementsSearchFieldGuess === "invoiceCount"
                            ? "No statements match that invoice count"
                            : pastStatementsSearchFieldGuess === "date"
                              ? "No statements match that date"
                              : "No statements match that lab name"
                          : "No statements in this period"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {pastLabSearch.trim()
                          ? "Try a different search term or clear the search box."
                          : "Try a different date range or select \u201cCustom\u201d to search a specific window."}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {filteredPastStatements.map((s) => (
                        <StatementCard
                          key={s.id}
                          statement={s}
                          readOnly
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Payment history ── */}
      <div className="mt-8">
        {/* Collapsible header */}
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          className="w-full flex items-center justify-between py-2 group"
          aria-expanded={historyOpen}
        >
          <div className="text-left">
            <h2 className="text-base font-semibold group-hover:text-primary transition-colors">
              Payment History
            </h2>
          </div>
          <span
            className={`text-muted-foreground transition-transform duration-200 ${historyOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          >
            ▼
          </span>
        </button>

        {historyOpen && (
          <div className="mt-3">
            {/* Date filter chips */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              {(
                [
                  { key: "this_month", label: "This month" },
                  { key: "last_month", label: "Last month" },
                  { key: "custom", label: "Custom" },
                ] as const
              ).map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setHistoryFilter(key)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    historyFilter === key
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-muted-foreground border-border hover:border-primary/60 hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}

              {historyFilter === "custom" && (
                <div className="flex items-center gap-2 ml-1">
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                    aria-label="From date"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                    aria-label="To date"
                  />
                </div>
              )}
            </div>

            {historyError ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-4 py-3 text-sm"
              >
                {historyError}
              </div>
            ) : paymentHistory === null ? (
              <div className="rounded-md border border-border px-4 py-3 animate-pulse">
                <div className="h-4 bg-muted rounded w-full mb-2" />
                <div className="h-4 bg-muted rounded w-3/4" />
              </div>
            ) : (
              <PaymentHistoryTable rows={filteredRows} isFiltered={true} />
            )}
          </div>
        )}
      </div>

      {selectedCaseId && (
        <ProviderCaseInvoiceModal
          caseId={selectedCaseId}
          onClose={() => setSelectedCaseId(null)}
          onPaymentComplete={() => onRefreshCases?.()}
        />
      )}
    </div>
  );
}
