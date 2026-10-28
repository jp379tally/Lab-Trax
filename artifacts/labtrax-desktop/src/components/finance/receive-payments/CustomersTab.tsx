import { Eye, FileText } from "lucide-react";
import { formatDate, formatMoney } from "@/lib/format";
import type { Selection } from "./types";
import {
  daysLabel,
  deselectCustomers,
  isSelected,
  paysByStatement,
  plural,
  scopeFor,
  selectCustomers,
  type PayableCustomer,
  type SortKey,
  type SortState,
} from "./model";
import { Badge, Checkbox, CustomerAvatar, SortHeader } from "./ui";

/** How the customer's payment is limited, shown under their name. */
export function scopeNote(selection: Selection, customer: PayableCustomer): string | null {
  if (!isSelected(selection, customer.id)) return null;
  const scope = scopeFor(selection, customer);
  if (scope.switchedFromStatement) return "Paying invoices directly";
  if (scope.invoiceIds) {
    const of = scope.mode === "statement" && customer.statement
      ? customer.invoices.filter((invoice) => invoice.onStatement).length
      : customer.invoices.length;
    return `${scope.invoiceIds.length} of ${plural(of, "invoice")} picked`;
  }
  return null;
}

/** True when the statement settles a different amount than everything the customer owes. */
export function statementDiffers(customer: PayableCustomer): boolean {
  const balance = customer.statement?.balance;
  return balance === null || (balance !== undefined && Math.abs(balance - customer.totalBalance) > 0.005);
}

export function CustomersTab({
  rows,
  selection,
  sort,
  onSort,
  onSelectionChange,
  onViewInvoices,
}: {
  rows: readonly PayableCustomer[];
  selection: Selection;
  sort: SortState;
  onSort: (key: SortKey) => void;
  onSelectionChange: (next: Selection) => void;
  onViewInvoices: (customer: PayableCustomer) => void;
}) {
  const grouped = new Map<string, PayableCustomer[]>();
  for (const customer of rows) {
    const key = customer.practiceOrganizationId ?? customer.account.providerOrganizationId;
    const group = grouped.get(key) ?? [];
    group.push(customer);
    grouped.set(key, group);
  }
  const orderedRows = [...grouped.values()].flatMap((group) => {
    if (group.length < 2) return group;
    const practice = group.find((customer) => !customer.isDoctorAccount);
    return [
      ...(practice ? [practice] : []),
      ...group.filter((customer) => customer.isDoctorAccount),
    ];
  });
  const selectedShown = orderedRows.filter((customer) => isSelected(selection, customer.id)).length;
  const allShown = orderedRows.length > 0 && selectedShown === orderedRows.length;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-[10.5px] uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="w-8 py-2 pl-3 pr-1 text-left">
              <Checkbox
                aria-label="Select all shown customers"
                checked={allShown}
                indeterminate={selectedShown > 0 && !allShown}
                disabled={!orderedRows.length}
                onChange={(e) =>
                  onSelectionChange(
                    e.target.checked
                      ? selectCustomers(selection, orderedRows)
                      : deselectCustomers(selection, orderedRows.map((customer) => customer.id)),
                  )
                }
              />
            </th>
            <SortHeader label="Customer" sortKey="name" sort={sort} onSort={onSort} />
            {/* In a narrow panel the count moves under the customer's name so names stay readable. */}
            <SortHeader
              label="Unpaid Invoices"
              sortKey="invoices"
              sort={sort}
              onSort={onSort}
              className="hidden @min-[34rem]:table-cell"
            />
            <SortHeader label="Balance Due" sortKey="balance" sort={sort} onSort={onSort} align="right" />
            <SortHeader label="Oldest Invoice" sortKey="oldest" sort={sort} onSort={onSort} />
            <SortHeader label="Last Payment" sortKey="lastPayment" sort={sort} onSort={onSort} />
            <th scope="col" className="py-2 pl-1 pr-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {orderedRows.map((customer) => {
            const selected = isSelected(selection, customer.id);
            const byStatement = paysByStatement(selection, customer);
            const note = scopeNote(selection, customer);
            const oldest = customer.oldest;
            const days = oldest?.daysPastDue ?? null;
            return (
              <tr
                key={customer.id}
                data-testid={`receive-customer-row-${customer.id}`}
                className={`border-b border-border/70 last:border-0 ${selected ? "bg-primary/[0.06]" : "hover:bg-secondary/40"}`}
              >
                <td className="py-2 pl-3 pr-1">
                  <Checkbox
                    aria-label={
                      customer.isDoctorAccount
                        ? `Select ${customer.doctorDisplayName} at ${customer.practiceName}${
                            customer.doctorLabelQualifier ? ` (${customer.doctorLabelQualifier})` : ""
                          }`
                        : `Select ${customer.name}`
                    }
                    checked={selected}
                    onChange={(e) =>
                      onSelectionChange(
                        e.target.checked
                          ? selectCustomers(selection, [customer])
                          : deselectCustomers(selection, [customer.id]),
                      )
                    }
                  />
                </td>
                <td className="w-full max-w-0 px-1.5 py-2">
                  <div className={`flex min-w-0 items-center gap-2 ${customer.isDoctorAccount ? "pl-5" : ""}`}>
                    <span className="hidden @min-[36rem]:inline-flex">
                      <CustomerAvatar id={customer.id} initials={customer.initials} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium" title={customer.name}>
                          {customer.name}
                        </span>
                        {byStatement && (
                          <Badge title={`Pays by statement${customer.statement?.periodEnd ? ` ending ${formatDate(customer.statement.periodEnd)}` : ""}`}>
                            {/* Icon-only in a narrow panel; the label stays available to screen readers. */}
                            <FileText size={10} aria-hidden="true" className="my-[3px] @min-[34rem]:hidden" />
                            <span className="sr-only @min-[34rem]:not-sr-only">Statement</span>
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        <span>{customer.accountLabel}</span>
                        {customer.accountNumber && customer.accountLabel ? " · " : ""}
                        <span>{customer.accountNumber ?? ""}</span>
                        <span className="@min-[34rem]:hidden">
                          {customer.accountNumber ? " · " : ""}
                          {customer.unpaidCount} unpaid
                        </span>
                        {note && (
                          <span className="text-amber-700 dark:text-amber-300">
                            {customer.accountNumber ? " · " : <span className="@min-[34rem]:hidden"> · </span>}
                            {note}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="hidden whitespace-nowrap px-1.5 py-2 text-xs tabular-nums @min-[34rem]:table-cell">
                  {plural(customer.unpaidCount, "invoice")}
                </td>
                <td className="whitespace-nowrap px-1.5 py-2 text-right">
                  <div className="font-semibold tabular-nums">{formatMoney(customer.totalBalance)}</div>
                  {byStatement && statementDiffers(customer) && (
                    <div className="whitespace-normal text-[11px] leading-tight text-muted-foreground tabular-nums @min-[34rem]:whitespace-nowrap @min-[34rem]:leading-normal">
                      Statement {customer.statement?.balance === null ? "unavailable" : formatMoney(customer.statement?.balance)}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-1.5 py-2 text-xs tabular-nums">
                  {oldest ? (
                    <>
                      <div>{formatDate(oldest.issuedAt ?? oldest.dueAt)}</div>
                      {days !== null && days > 0 && (
                        <div className="text-[11px] font-medium text-destructive">
                          {daysLabel(days)}
                          <span className="sr-only"> past due</span>
                        </div>
                      )}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td
                  className="whitespace-nowrap px-1.5 py-2 text-xs tabular-nums"
                  aria-label={`Last payment for ${customer.isDoctorAccount ? customer.doctorDisplayName : customer.name}`}
                >
                  {customer.lastPaymentAt ? (
                    <>
                      <div>{formatDate(customer.lastPaymentAt)}</div>
                      {customer.lastPaymentAmount !== null && (
                        <div className="text-[11px] text-muted-foreground">{formatMoney(customer.lastPaymentAmount)}</div>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </td>
                <td className="py-2 pl-1 pr-3 text-right">
                  <button
                    type="button"
                    aria-label={`View invoices for ${customer.name}`}
                    title="View invoices"
                    onClick={() => onViewInvoices(customer)}
                    className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-background px-2 text-xs font-medium hover:bg-secondary"
                  >
                    <Eye size={13} aria-hidden="true" />
                    <span className="hidden @min-[44rem]:inline">View invoices</span>
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
