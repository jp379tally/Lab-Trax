/**
 * Provider-facing invoice detail modal, opened from a case row on the
 * Billing tab (ProviderBilling). Unlike ProviderCaseDetailModal (used on the
 * Dashboard tab for lab notes / restoration info), this modal is invoice-first:
 * it surfaces the balance due, line items, and a Pay button so a provider can
 * act on a case's bill without hunting for the matching statement card.
 */
import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { PayDialog, type StatementInvoice } from "./ProviderBilling";

interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: string;
  totalPrice: string;
}

interface ProviderCaseInvoiceDetail {
  id: string;
  caseNumber: string;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  invoiceLines?: InvoiceLine[];
  invoiceNotes?: string | null;
  invoiceTotal?: string | null;
  invoiceBalanceDue?: string | null;
  invoiceStatus?: string | null;
}

function statusLabel(status: string): string {
  return status
    .split(/[_\s]+/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
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

function balanceDueNum(val: string | number | null | undefined): number {
  if (val == null) return 0;
  const n = typeof val === "string" ? parseFloat(val) : val;
  return isNaN(n) ? 0 : n;
}

const PAYABLE_STATUSES = ["open", "partially_paid", "overdue"];

export function ProviderCaseInvoiceModal({
  caseId,
  onClose,
  onPaymentComplete,
}: {
  caseId: string;
  onClose: () => void;
  /** Called after a payment is recorded so the caller can refresh case balances. */
  onPaymentComplete?: () => void;
}) {
  const [detail, setDetail] = useState<ProviderCaseInvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [balanceDue, setBalanceDue] = useState<number>(0);
  const [invoiceStatus, setInvoiceStatus] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<ProviderCaseInvoiceDetail>(
          `/cases/provider/${caseId}`,
        );
        if (!cancelled) {
          setDetail(data);
          setBalanceDue(balanceDueNum(data.invoiceBalanceDue));
          setInvoiceStatus(data.invoiceStatus ?? null);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load invoice.");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const patientName =
    detail &&
    (detail.patientFirstName || detail.patientLastName
      ? `${detail.patientFirstName ?? ""} ${detail.patientLastName ?? ""}`.trim()
      : "—");

  const hasInvoice = Boolean(detail?.invoiceId);
  const canPay =
    hasInvoice &&
    balanceDue > 0.005 &&
    PAYABLE_STATUSES.includes(invoiceStatus ?? "");

  const invoiceForPay: StatementInvoice | null =
    detail?.invoiceId
      ? {
          id: detail.invoiceId,
          invoiceNumber: detail.invoiceNumber ?? "",
          status: invoiceStatus ?? "open",
          total: detail.invoiceTotal,
          balanceDue,
          displayMetadata: { patientName },
        }
      : null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        role="dialog"
        aria-modal="true"
        aria-label="Case invoice"
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/40"
          onClick={onClose}
          aria-hidden="true"
        />

        {/* Panel */}
        <div className="relative z-10 bg-background border border-border rounded-lg shadow-xl w-full max-w-xl mx-4 max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
            <div>
              <h2 className="text-base font-semibold">
                {detail ? `Case #${detail.caseNumber} — Invoice` : "Invoice"}
              </h2>
              {detail?.invoiceNumber && (
                <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                  {detail.invoiceNumber}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground text-xl leading-none ml-2"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {/* Scrollable body */}
          <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
            {loading ? (
              <div className="text-sm text-muted-foreground py-4">Loading…</div>
            ) : error ? (
              <div className="text-sm text-destructive py-4">{error}</div>
            ) : detail ? (
              <>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Patient
                    </div>
                    <div className="mt-0.5 text-sm font-medium">
                      {patientName}
                    </div>
                  </div>
                  {invoiceStatus && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-muted border border-border font-medium">
                      {statusLabel(invoiceStatus)}
                    </span>
                  )}
                </div>

                {!hasInvoice ? (
                  <div className="text-sm text-muted-foreground italic py-4 text-center">
                    No active invoice found for this case.
                  </div>
                ) : (
                  <>
                    <div className="rounded-md border border-border overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground text-left">
                          <tr>
                            <th className="px-3 py-2 font-medium">Description</th>
                            <th className="px-3 py-2 font-medium text-center w-14">
                              Qty
                            </th>
                            <th className="px-3 py-2 font-medium text-right w-24">
                              Unit
                            </th>
                            <th className="px-3 py-2 font-medium text-right w-24">
                              Total
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {(detail.invoiceLines ?? []).length === 0 ? (
                            <tr>
                              <td
                                colSpan={4}
                                className="px-3 py-3 text-muted-foreground text-center"
                              >
                                No line items on this invoice.
                              </td>
                            </tr>
                          ) : (
                            detail.invoiceLines!.map((line, idx) => (
                              <tr key={idx} className="border-t border-border">
                                <td className="px-3 py-2">{line.description}</td>
                                <td className="px-3 py-2 text-center">
                                  {line.quantity}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {formatCurrency(line.unitPrice)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums font-medium">
                                  {formatCurrency(line.totalPrice)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                      <div className="px-3 py-2 border-t border-border bg-muted/20 text-xs text-muted-foreground flex justify-between items-center">
                        <span>
                          Total billed: {formatCurrency(detail.invoiceTotal)}
                        </span>
                        <span className="font-medium text-foreground">
                          Balance due: {formatCurrency(balanceDue)}
                        </span>
                      </div>
                    </div>
                    {detail.invoiceNotes ? (
                      <section
                        aria-label="Invoice notes"
                        className="rounded-md border border-border bg-muted/20 px-3 py-2"
                      >
                        <h3 className="text-xs font-medium text-muted-foreground">
                          Invoice notes
                        </h3>
                        <p className="mt-1 text-sm whitespace-pre-wrap">
                          {detail.invoiceNotes}
                        </p>
                      </section>
                    ) : null}
                  </>
                )}
              </>
            ) : null}
          </div>

          {/* Footer — Pay action */}
          {!loading && !error && canPay && (
            <div className="px-6 py-3 border-t border-border shrink-0 flex justify-end">
              <button
                type="button"
                onClick={() => setPaying(true)}
                className="text-sm px-4 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
              >
                Pay — {formatCurrency(balanceDue)} due
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Payment dialog */}
      {paying && invoiceForPay && (
        <PayDialog
          invoice={invoiceForPay}
          onClose={() => setPaying(false)}
          onPaid={(updated) => {
            setBalanceDue(balanceDueNum(updated.balanceDue));
            setInvoiceStatus(updated.status);
            setPaying(false);
            onPaymentComplete?.();
          }}
        />
      )}
    </>
  );
}
