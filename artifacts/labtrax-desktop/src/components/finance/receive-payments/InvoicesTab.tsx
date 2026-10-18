import { useMemo, useRef } from "react";
import { Pencil, X } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/format";
import {
  computeShiftClickRange,
  shiftKeyFromChangeEvent,
  suppressShiftClickTextSelection,
} from "@/lib/shift-click-range";
import type { Selection } from "./types";
import {
  daysLabel,
  isInvoicePicked,
  pickInvoices,
  scopeFor,
  type PayableCustomer,
  type PayableInvoice,
  type SortKey,
  type SortState,
} from "./model";
import { Badge, Checkbox, SortHeader } from "./ui";

/** Picks or unpicks invoices that may belong to several customers. */
function pickAcrossCustomers(
  selection: Selection,
  invoices: readonly PayableInvoice[],
  customers: ReadonlyMap<string, PayableCustomer>,
  picked: boolean,
): Selection {
  const byCustomer = new Map<string, string[]>();
  for (const invoice of invoices) {
    const ids = byCustomer.get(invoice.customerId) ?? [];
    ids.push(invoice.id);
    byCustomer.set(invoice.customerId, ids);
  }
  let next = selection;
  for (const [customerId, ids] of byCustomer) {
    const customer = customers.get(customerId);
    if (customer) next = pickInvoices(next, customer, ids, picked);
  }
  return next;
}

export function InvoicesTab({
  rows,
  customersById,
  selection,
  sort,
  onSort,
  onSelectionChange,
  onEditInvoice,
  focusCustomer,
  onClearFocus,
}: {
  rows: readonly PayableInvoice[];
  customersById: ReadonlyMap<string, PayableCustomer>;
  selection: Selection;
  sort: SortState;
  onSort: (key: SortKey) => void;
  onSelectionChange: (next: Selection) => void;
  onEditInvoice: (invoice: PayableInvoice) => void;
  /** Set by "View invoices": the tab lists only this customer's invoices. */
  focusCustomer: PayableCustomer | null;
  onClearFocus: () => void;
}) {
  const anchor = useRef<string | null>(null);
  const visibleIds = useMemo(() => rows.map((invoice) => invoice.id), [rows]);
  const picked = (invoice: PayableInvoice) => {
    const customer = customersById.get(invoice.customerId);
    return !!customer && isInvoicePicked(selection, customer, invoice);
  };
  const pickedShown = rows.filter(picked).length;
  const allShown = rows.length > 0 && pickedShown === rows.length;

  const toggle = (invoice: PayableInvoice, checked: boolean, shifted: boolean) => {
    if (shifted) {
      const ids = computeShiftClickRange(visibleIds, anchor.current, invoice.id);
      if (ids) {
        const range = new Set(ids);
        onSelectionChange(
          pickAcrossCustomers(selection, rows.filter((row) => range.has(row.id)), customersById, true),
        );
        return;
      }
    }
    anchor.current = invoice.id;
    onSelectionChange(pickAcrossCustomers(selection, [invoice], customersById, checked));
  };

  const switched = selection.ids
    .map((id) => customersById.get(id))
    .filter((customer): customer is PayableCustomer => !!customer && !!scopeFor(selection, customer).switchedFromStatement);

  return (
    <div>
      {focusCustomer && (
        <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-1.5 text-xs">
          <span className="min-w-0 truncate">
            Showing invoices for <span className="font-medium">{focusCustomer.name}</span>
          </span>
          <button
            type="button"
            onClick={onClearFocus}
            className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium text-primary hover:underline"
          >
            <X size={12} aria-hidden="true" />
            Show all customers
          </button>
        </div>
      )}
      {switched.length > 0 && (
        <div role="status" className="space-y-0.5 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {switched.map((customer) => {
            const by = scopeFor(selection, customer).switchedBy;
            return (
              <p key={customer.id}>
                <span className="font-medium">{customer.name}</span> will pay invoices directly instead of by statement
                {by ? `: invoice ${by} is not on their statement.` : "."}
              </p>
            );
          })}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-[10.5px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="w-8 py-2 pl-3 pr-1 text-left">
                <Checkbox
                  aria-label="Select all shown invoices"
                  checked={allShown}
                  indeterminate={pickedShown > 0 && !allShown}
                  disabled={!rows.length}
                  onChange={(e) =>
                    onSelectionChange(pickAcrossCustomers(selection, rows, customersById, e.target.checked))
                  }
                />
              </th>
              <th scope="col" className="px-1.5 py-2 text-left font-medium">Invoice</th>
              <SortHeader label="Customer" sortKey="name" sort={sort} onSort={onSort} />
              <th scope="col" className="hidden px-1.5 py-2 text-left font-medium @min-[44rem]:table-cell">
                Doctor / patient
              </th>
              <SortHeader label="Invoice Date" sortKey="oldest" sort={sort} onSort={onSort} />
              <SortHeader label="Balance Due" sortKey="balance" sort={sort} onSort={onSort} align="right" className="pr-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((invoice) => {
              const customer = customersById.get(invoice.customerId);
              const isPicked = picked(invoice);
              const days = invoice.daysPastDue;
              return (
                <tr
                  key={invoice.id}
                  className={`border-b border-border/70 last:border-0 ${isPicked ? "bg-primary/[0.06]" : "hover:bg-secondary/40"}`}
                >
                  <td className="py-2 pl-3 pr-1">
                    <Checkbox
                      aria-label={`Select invoice ${invoice.invoiceNumber} for ${invoice.customerName}`}
                      checked={isPicked}
                      onMouseDown={suppressShiftClickTextSelection}
                      onChange={(e) => toggle(invoice, e.target.checked, shiftKeyFromChangeEvent(e))}
                    />
                  </td>
                  <td className="whitespace-nowrap px-1.5 py-2">
                    <button
                      type="button"
                      aria-label={`Edit invoice ${invoice.invoiceNumber}`}
                      onClick={() => onEditInvoice(invoice)}
                      className="inline-flex items-center gap-1 font-medium hover:underline"
                    >
                      {invoice.invoiceNumber}
                      <Pencil size={11} aria-hidden="true" className="text-muted-foreground" />
                    </button>
                    {customer?.statement && invoice.onStatement && (
                      <div className="mt-0.5">
                        <Badge tone="muted">On statement</Badge>
                      </div>
                    )}
                  </td>
                  <td className="w-full max-w-0 px-1.5 py-2">
                    <div className="truncate" title={invoice.customerName}>{invoice.customerName}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{customer?.accountNumber ?? ""}</div>
                  </td>
                  <td className="hidden max-w-[12rem] px-1.5 py-2 text-xs @min-[44rem]:table-cell">
                    <div className="truncate">{invoice.doctorName || "—"}</div>
                    <div className="truncate text-muted-foreground">{invoice.patientName || "—"}</div>
                  </td>
                  <td className="whitespace-nowrap px-1.5 py-2 text-xs tabular-nums">
                    <div>{formatDate(invoice.issuedAt ?? invoice.dueAt)}</div>
                    {days !== null && days > 0 && (
                      <div className="text-[11px] font-medium text-destructive">
                        {daysLabel(days)}
                        <span className="sr-only"> past due</span>
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2 pl-1.5 pr-3 text-right tabular-nums">
                    <div className="font-semibold">{formatMoney(invoice.balance)}</div>
                    {invoice.partiallyPaid && (
                      <div className="text-[11px] text-muted-foreground">of {formatMoney(invoice.total)}</div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
