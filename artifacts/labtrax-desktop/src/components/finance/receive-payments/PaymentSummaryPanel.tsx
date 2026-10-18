import type { ReactNode } from "react";
import { Calculator, CreditCard, Info, Loader2 } from "lucide-react";
import type { ReceivePaymentsInputPaymentMethod } from "@workspace/api-client-react";
import { formatMoney } from "@/lib/format";
import { plural, type SelectionTotals } from "./model";
import { PAYMENT_METHODS, paymentMethodLabel } from "./payments";
import type { PaymentDefaults, PaymentOptions } from "./types";
import { Checkbox, fieldClass } from "./ui";

export type SummaryStatus = "loading" | "error" | "ready";

const OPTION_ROWS: ReadonlyArray<{ key: keyof PaymentOptions; label: string; hint: string }> = [
  {
    key: "applyOldestFirst",
    label: "Apply to oldest invoices first",
    hint: "Each amount received is allocated automatically. Turn off to allocate by hand.",
  },
  {
    key: "allowOverpayment",
    label: "Allow overpayment (create credit)",
    hint: "Money received beyond what is applied becomes customer credit.",
  },
  {
    key: "emailReceipts",
    label: "Email receipts to customers",
    hint: "Opens each receipt email ready to review. Nothing is sent automatically.",
  },
];

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-foreground/80">
      {children}
    </label>
  );
}

/**
 * The reference's Payment Summary: totals for the selection, the defaults
 * every customer's payment starts with, the apply options and the Receive
 * Payments button. Money received goes to Undeposited Funds; each customer's
 * check or reference number is entered in the receiving step.
 */
export function PaymentSummaryPanel({
  status,
  totals,
  defaults,
  onDefaultsChange,
  options,
  onOptionsChange,
  blockedReason,
  onReceive,
}: {
  status: SummaryStatus;
  totals: SelectionTotals | null;
  defaults: PaymentDefaults;
  onDefaultsChange: (next: PaymentDefaults) => void;
  options: PaymentOptions;
  onOptionsChange: (next: PaymentOptions) => void;
  /** Why receiving cannot start yet; empty when it can. */
  blockedReason: string;
  onReceive: () => void;
}) {
  const ready = status === "ready" && totals ? totals : null;
  const amountKnown = !!ready && ready.amount !== null;
  const customersLine =
    status === "loading"
      ? "Loading customers…"
      : status === "error"
        ? "Customers unavailable"
        : `${plural(ready?.customers ?? 0, "customer")} selected`;
  const invoicesValue = ready ? String(ready.invoices) : status === "loading" ? "…" : "—";
  const amountValue =
    status === "loading" ? "Loading…" : amountKnown ? formatMoney(ready!.amount!) : "Unavailable";
  const subtitle =
    status === "loading"
      ? "Loading balances…"
      : status === "error"
        ? "Balances unavailable"
        : !amountKnown
          ? "Selected balance unavailable"
          : `Apply ${formatMoney(ready!.amount!)} to ${plural(ready!.invoices, "invoice")}`;

  return (
    <aside
      aria-labelledby="receive-summary-title"
      className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm space-y-4"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Calculator size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 id="receive-summary-title" className="text-base font-semibold leading-tight">
            Payment Summary
          </h3>
          <p data-testid="receive-summary-customers" className="text-xs text-muted-foreground">
            {customersLine}
          </p>
        </div>
      </div>

      <dl className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Total Invoices</dt>
          <dd data-testid="receive-summary-invoices" className="font-semibold tabular-nums">
            {invoicesValue}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Total Payment Amount</dt>
          <dd
            data-testid="expected-payments"
            className={`font-semibold tabular-nums ${amountKnown ? "" : "text-muted-foreground"}`}
          >
            {amountValue}
          </dd>
        </div>
      </dl>

      <div className="space-y-3 border-t border-border pt-3">
        <div>
          <FieldLabel htmlFor="receive-default-method">Payment Method</FieldLabel>
          <select
            id="receive-default-method"
            value={defaults.paymentMethod}
            onChange={(event) =>
              onDefaultsChange({
                ...defaults,
                paymentMethod: event.target.value as ReceivePaymentsInputPaymentMethod,
              })
            }
            className={fieldClass}
          >
            {PAYMENT_METHODS.map((method) => (
              <option key={method} value={method}>
                {paymentMethodLabel(method)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <FieldLabel htmlFor="receive-default-date">Payment Date</FieldLabel>
          <input
            id="receive-default-date"
            type="date"
            value={defaults.paymentDate}
            onChange={(event) => onDefaultsChange({ ...defaults, paymentDate: event.target.value })}
            className={fieldClass}
          />
        </div>
        <div>
          <FieldLabel htmlFor="receive-default-memo">Memo (optional)</FieldLabel>
          <input
            id="receive-default-memo"
            value={defaults.memo}
            placeholder="e.g. June statement payments"
            onChange={(event) => onDefaultsChange({ ...defaults, memo: event.target.value })}
            className={fieldClass}
          />
        </div>
        <p
          data-testid="receive-deposit-note"
          className="flex items-start gap-1.5 rounded-md bg-secondary/60 px-2.5 py-2 text-[11px] leading-snug text-muted-foreground"
        >
          <Info size={13} className="mt-px shrink-0" aria-hidden="true" />
          <span>
            Payments go to Undeposited Funds until you bank them in Make Deposits. Check and reference numbers are
            entered for each customer.
          </span>
        </p>
      </div>

      <div className="space-y-1.5">
        <button
          type="button"
          data-testid="receive-continue"
          disabled={!!blockedReason}
          aria-describedby={blockedReason ? "receive-summary-blocked" : undefined}
          onClick={onReceive}
          className="w-full rounded-lg bg-primary px-3 py-2.5 text-primary-foreground shadow-sm transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-55"
        >
          <span className="flex items-center justify-center gap-2 text-sm font-semibold">
            {status === "loading" ? (
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <CreditCard size={16} aria-hidden="true" />
            )}
            Receive Payments
          </span>
          <span className="sr-only"> — </span>
          <span data-testid="receive-continue-subtitle" className="mt-0.5 block text-[11px] font-normal opacity-90">
            {subtitle}
          </span>
        </button>
        {blockedReason && (
          <p id="receive-summary-blocked" className="text-xs text-amber-700 dark:text-amber-400">
            {blockedReason}
          </p>
        )}
      </div>

      <fieldset className="rounded-lg border border-border p-3">
        <legend className="px-1 text-xs font-semibold">Apply Payments</legend>
        <div className="space-y-2">
          {OPTION_ROWS.map((row) => (
            <div key={row.key} className="flex items-start gap-2 text-xs">
              <Checkbox
                id={`receive-option-${row.key}`}
                checked={options[row.key]}
                onChange={(event) => onOptionsChange({ ...options, [row.key]: event.target.checked })}
                aria-describedby={`receive-option-${row.key}-hint`}
                className="mt-px"
              />
              <div className="min-w-0">
                <label htmlFor={`receive-option-${row.key}`} className="block font-medium text-foreground">
                  {row.label}
                </label>
                <p id={`receive-option-${row.key}-hint`} className="text-[11px] leading-snug text-muted-foreground">
                  {row.hint}
                </p>
              </div>
            </div>
          ))}
        </div>
      </fieldset>
    </aside>
  );
}
