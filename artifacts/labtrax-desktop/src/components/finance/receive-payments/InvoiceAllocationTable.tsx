import { Loader2, Pencil } from "lucide-react";
import { ColumnTotal, sumAmounts } from "@/components/ColumnTotal";
import { formatDate, formatMoney } from "@/lib/format";
import { shiftKeyFromChangeEvent, suppressShiftClickTextSelection } from "@/lib/shift-click-range";
import { plural } from "./model";
import type { Draft } from "./payments";
import type { EligibleAccount, StatementInvoice } from "./types";

type DoctorProfile = NonNullable<EligibleAccount["doctorProfiles"]>[number];

/**
 * The current customer's invoices in the receiving step: per-invoice payment
 * and credit amounts with column totals, shift-click ranges, inline invoice
 * editing and legacy doctor repair.
 */
export function InvoiceAllocationTable({
  rows,
  open,
  loading,
  provenance,
  draft,
  creditAvailable,
  doctorProfiles,
  repairSelections,
  onRepairSelect,
  onRepair,
  repairing,
  repairError,
  locked,
  scopeHiddenCount,
  onShowAllInvoices,
  onToggle,
  onApplication,
  onCredit,
  onEdit,
  onAutoApply,
}: {
  /** Payable invoices followed by the ones that can no longer be paid. */
  rows: readonly StatementInvoice[];
  /** Payable invoices only; they drive the column totals. */
  open: readonly StatementInvoice[];
  loading: boolean;
  provenance?: "snapshot" | "live" | "mixed";
  draft: Draft;
  creditAvailable: number;
  doctorProfiles: readonly DoctorProfile[];
  repairSelections: Record<string, string>;
  onRepairSelect: (invoiceId: string, profileId: string) => void;
  onRepair: (invoice: StatementInvoice, profile: DoctorProfile) => void;
  repairing: boolean;
  repairError: string | null;
  /** A save is pending or a receipt is open. */
  locked: boolean;
  /** Invoices hidden because only the picked ones are shown; null when not limited. */
  scopeHiddenCount: number | null;
  onShowAllInvoices: () => void;
  onToggle: (invoice: StatementInvoice, checked: boolean, shifted: boolean) => void;
  onApplication: (invoiceId: string, value: string) => void;
  onCredit: (invoiceId: string, value: string) => void;
  onEdit: (invoice: StatementInvoice) => void;
  onAutoApply: () => void;
}) {
  return (
    <section
      aria-labelledby="receive-invoices-heading"
      className="@container min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      {provenance === "mixed" && (
        <p role="alert" className="mx-4 mt-4 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800">
          Some invoice details are unavailable because this statement contains mixed detail sources.
        </p>
      )}
      {provenance === "live" && (
        <p role="alert" className="mx-4 mt-4 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800">
          This older statement has no invoice-detail snapshot; live invoice details are shown.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 id="receive-invoices-heading" className="text-sm font-semibold">
            Outstanding invoices
          </h3>
          {scopeHiddenCount !== null && (
            <p data-testid="receive-invoice-scope-note" className="mt-0.5 text-xs text-muted-foreground">
              Showing only the invoices picked on the selection screen
              {scopeHiddenCount > 0 ? ` (${plural(scopeHiddenCount, "other invoice")} hidden)` : ""}.{" "}
              <button
                type="button"
                onClick={onShowAllInvoices}
                disabled={locked}
                className="font-medium text-primary hover:underline disabled:opacity-60"
              >
                Show all invoices
              </button>
            </p>
          )}
          {repairError && (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {repairError}
            </p>
          )}
        </div>
        {open.length > 0 && (
          <button
            type="button"
            onClick={onAutoApply}
            disabled={locked}
            className="h-8 rounded-md bg-secondary px-3 text-xs font-medium disabled:opacity-60"
          >
            Auto-apply oldest / overdue first
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/40 text-[11px] uppercase text-muted-foreground">
              <th className="px-3 py-2" />
              <th className="py-2 pr-2 text-left">Invoice</th>
              <th className="py-2 pr-2 text-left">Doctor / patient</th>
              {/* In a narrow card the due date moves under the invoice number and the invoice amount
                  under the current due, so the payment and credit inputs stay in view. */}
              <th className="hidden py-2 pr-2 text-left @min-[40rem]:table-cell">Due date</th>
              <th className="hidden py-2 pr-2 text-right @min-[40rem]:table-cell">
                Invoice amount
                <ColumnTotal values={open.map((invoice) => invoice.total)} loading={loading} />
              </th>
              <th className="py-2 pr-2 text-right">
                Current due
                <ColumnTotal values={open.map((invoice) => invoice.currentBalanceDue)} loading={loading} />
                <span className="block whitespace-nowrap text-[10px] font-normal normal-case tracking-normal tabular-nums @min-[40rem]:hidden">
                  of {loading ? "—" : formatMoney(sumAmounts(open.map((invoice) => invoice.total)))}
                </span>
              </th>
              <th className="py-2 pr-2 text-right">Payment</th>
              <th className="px-3 py-2 text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center">
                  <Loader2 className="inline animate-spin" size={14} /> Loading outstanding invoices…
                </td>
              </tr>
            )}
            {!loading && !rows.length && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                  No eligible outstanding invoices.
                </td>
              </tr>
            )}
            {rows.map((invoice) => {
              const unavailable = invoice.eligibleForPayment === false;
              const amount = Number(draft.applications[invoice.id] || 0);
              const selectedProfileId = repairSelections[invoice.id] || "";
              const selectedProfile = doctorProfiles.find((profile) => profile.id === selectedProfileId);
              return (
                <tr key={invoice.id} className="border-t border-border">
                  <td className="pl-3 pr-1">
                    <input
                      type="checkbox"
                      checked={amount > 0}
                      disabled={unavailable}
                      aria-label={`Select invoice ${invoice.invoiceNumber}`}
                      onMouseDown={suppressShiftClickTextSelection}
                      onChange={(event) => onToggle(invoice, event.target.checked, shiftKeyFromChangeEvent(event))}
                    />
                  </td>
                  <td className="py-2.5 pr-2">
                    <button
                      type="button"
                      onClick={() => onEdit(invoice)}
                      className="inline-flex items-center gap-1 whitespace-nowrap hover:underline"
                    >
                      {invoice.invoiceNumber}
                      <Pencil size={12} />
                    </button>
                    {invoice.dueAt && (
                      <div className="text-[11px] text-muted-foreground @min-[40rem]:hidden">Due {formatDate(invoice.dueAt)}</div>
                    )}
                  </td>
                  <td className="py-2.5 pr-2">
                    <div>{invoice.doctorName || invoice.doctor || "—"}</div>
                    <div className="text-xs text-muted-foreground">{invoice.patientName || "—"}</div>
                    {!invoice.doctorProfileId && doctorProfiles.length ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] uppercase tracking-wide text-amber-700">Legacy identity</span>
                        <select
                          aria-label={`Doctor profile for invoice ${invoice.invoiceNumber}`}
                          value={selectedProfileId}
                          disabled={unavailable || repairing || locked}
                          onChange={(event) => onRepairSelect(invoice.id, event.target.value)}
                          className="h-7 w-full max-w-48 rounded border border-input bg-background px-1.5 text-xs @min-[40rem]:w-auto"
                        >
                          <option value="">Choose doctor</option>
                          {doctorProfiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.doctorDisplayName}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={unavailable || !selectedProfile || repairing || locked}
                          onClick={() => {
                            if (
                              selectedProfile &&
                              window.confirm(
                                `Assign ${selectedProfile.doctorDisplayName} to legacy invoice ${invoice.invoiceNumber}? This records an admin audit entry and changes its payment scope.`,
                              )
                            ) {
                              onRepair(invoice, selectedProfile);
                            }
                          }}
                          className="h-7 rounded bg-secondary px-2 text-xs font-medium disabled:opacity-50"
                        >
                          {repairing ? "Repairing…" : "Repair"}
                        </button>
                      </div>
                    ) : !invoice.doctorProfileId ? (
                      <div className="mt-1 text-[10px] text-amber-700">Legacy identity · no matching profile available</div>
                    ) : null}
                  </td>
                  <td className="hidden whitespace-nowrap pr-2 @min-[40rem]:table-cell">
                    {invoice.dueAt ? formatDate(invoice.dueAt) : "—"}
                  </td>
                  <td className="hidden pr-2 text-right tabular-nums @min-[40rem]:table-cell">{formatMoney(invoice.total)}</td>
                  <td className="pr-2 text-right tabular-nums">
                    {formatMoney(invoice.currentBalanceDue)}
                    <div className="whitespace-nowrap text-[11px] text-muted-foreground @min-[40rem]:hidden">
                      of {formatMoney(invoice.total)}
                    </div>
                  </td>
                  <td className="py-2 pr-2 text-right">
                    <input
                      type="number"
                      disabled={unavailable}
                      aria-label={`Payment for invoice ${invoice.invoiceNumber}`}
                      step="0.01"
                      min="0"
                      max={invoice.currentBalanceDue}
                      value={draft.applications[invoice.id] || ""}
                      onChange={(event) => onApplication(invoice.id, event.target.value)}
                      className="h-8 w-20 rounded-md border border-input bg-background px-2 text-right tabular-nums disabled:opacity-50 @min-[40rem]:w-24"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      disabled={unavailable || !creditAvailable}
                      aria-label={`Credit for invoice ${invoice.invoiceNumber}`}
                      step="0.01"
                      min="0"
                      max={invoice.currentBalanceDue}
                      value={draft.creditApplications[invoice.id] || ""}
                      onChange={(event) => onCredit(invoice.id, event.target.value)}
                      className="h-8 w-20 rounded-md border border-input bg-background px-2 text-right tabular-nums disabled:opacity-50 @min-[40rem]:w-24"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
