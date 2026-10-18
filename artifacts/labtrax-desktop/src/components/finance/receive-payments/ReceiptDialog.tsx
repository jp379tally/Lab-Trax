import { Download } from "lucide-react";
import { formatMoney } from "@/lib/format";
import type { Session } from "./payments";
import { fieldClass, Label } from "./ui";

/**
 * The receipt step after a payment saves. With "Email receipts to customers"
 * on it opens on the prefilled, editable email; otherwise it offers the PDF,
 * an on-demand email, continue and cancel. Nothing is ever sent without the
 * user pressing Email receipt.
 */
export function ReceiptDialog({
  receipt,
  scopeLabel,
  fallbackReceived,
  fallbackApplied,
  composing,
  onCompose,
  to,
  subject,
  body,
  onToChange,
  onSubjectChange,
  onBodyChange,
  error,
  sending,
  cancelling,
  onDownload,
  onSend,
  onContinue,
  onCancelPayment,
}: {
  receipt: Session;
  /** Who the payment is for: "Dr. Name · Customer" or "Entire practice · Customer". */
  scopeLabel: string;
  fallbackReceived: number;
  fallbackApplied: number;
  composing: boolean;
  onCompose: () => void;
  to: string;
  subject: string;
  body: string;
  onToChange: (value: string) => void;
  onSubjectChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  error: string | null;
  sending: boolean;
  cancelling: boolean;
  onDownload: () => void;
  onSend: () => void;
  /** Leave the payment recorded without emailing and move on. */
  onContinue: () => void;
  onCancelPayment: () => void;
}) {
  const reversal = receipt.reversal;
  const reversalPending = reversal?.status === "pending";
  const reversalFailed = reversal?.status === "failed";
  const reversalCompleted = reversal?.status === "completed";
  const busy = sending || cancelling || reversalPending;
  const cancelText = composing
    ? "Cancel email and payment? This restores invoice balances."
    : "Cancel this payment? This restores invoice balances.";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={composing ? "Email payment receipt" : "Payment recorded"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-xl space-y-3 rounded-xl border border-border bg-card p-5 shadow-xl">
        <div>
          <h2 className="font-semibold">{composing ? "Payment recorded — send receipt" : "Payment recorded"}</h2>
          <p data-testid="receipt-payment-scope" className="text-sm font-medium">
            {scopeLabel}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Receipt {receipt.receiptNumber || "—"} · received {formatMoney(receipt.receivedAmount || fallbackReceived)} ·
          applied {formatMoney(receipt.appliedAmount || fallbackApplied)} · customer credit{" "}
          {formatMoney(receipt.customerCreditAmount || 0)} · account balance {formatMoney(receipt.accountBalanceAfter || 0)}
        </p>
        {reversalPending && (
          <p role="status" className="text-sm text-amber-700">
            Card reversal pending. We’ll refresh its processor status automatically. Do not submit another reversal.
          </p>
        )}
        {reversalCompleted && (
          <p role="status" className="text-sm text-green-700">
            Card reversal completed. Invoice balances and customer credit have been refreshed.
          </p>
        )}
        {reversalFailed && (
          <p role="alert" className="text-sm text-destructive">
            <strong>Reversal needs review.</strong> The payment remains recorded
            {reversal?.reason ? ` (${reversal.reason})` : ""}. Ask an administrator to review the payment and contact
            the payment processor if needed.
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {composing ? (
          <>
            <div>
              <Label>To</Label>
              <input
                disabled={busy}
                type="email"
                aria-label="Receipt email recipient"
                value={to}
                onChange={(event) => onToChange(event.target.value)}
                className={fieldClass}
              />
            </div>
            <div>
              <Label>Subject</Label>
              <input
                disabled={busy}
                aria-label="Receipt email subject"
                value={subject}
                onChange={(event) => onSubjectChange(event.target.value)}
                className={fieldClass}
              />
            </div>
            <div>
              <Label>Message</Label>
              <textarea
                disabled={busy}
                aria-label="Receipt email message"
                value={body}
                onChange={(event) => onBodyChange(event.target.value)}
                className="min-h-28 w-full rounded-md border border-input bg-background p-2.5 text-sm"
              />
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                disabled={busy}
                onClick={onDownload}
                className="inline-flex h-9 items-center gap-1 rounded-md bg-secondary px-3 text-sm"
              >
                <Download size={14} />
                Preview / download PDF
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onContinue}
                className="h-9 rounded-md bg-secondary px-3 text-sm"
              >
                Skip
              </button>
              <button
                type="button"
                disabled={busy || !to}
                onClick={onSend}
                className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground"
              >
                {sending ? "Sending…" : "Email receipt"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Keep payment records the payment without sending email. Cancel email and payment reverses it.",
                    )
                  ) {
                    onContinue();
                  }
                }}
                className="ml-auto text-sm text-muted-foreground underline"
              >
                Dismiss
              </button>
              {!reversalCompleted && !reversalFailed && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(cancelText)) onCancelPayment();
                  }}
                  className="text-sm text-destructive underline"
                >
                  {cancelling ? "Cancelling…" : "Cancel email and payment"}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              The receipt has not been emailed. Download the PDF, or email it to the customer now.
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                disabled={busy}
                onClick={onDownload}
                className="inline-flex h-9 items-center gap-1 rounded-md bg-secondary px-3 text-sm"
              >
                <Download size={14} />
                Preview / download PDF
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onCompose}
                className="h-9 rounded-md bg-secondary px-3 text-sm"
              >
                Email receipt
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onContinue}
                className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground"
              >
                Continue
              </button>
              {!reversalCompleted && !reversalFailed && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(cancelText)) onCancelPayment();
                  }}
                  className="ml-auto text-sm text-destructive underline"
                >
                  {cancelling ? "Cancelling…" : "Cancel payment"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
