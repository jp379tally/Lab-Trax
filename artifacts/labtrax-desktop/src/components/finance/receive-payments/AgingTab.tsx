import { formatMoney } from "@/lib/format";
import type { Selection } from "./types";
import {
  AGING_BUCKETS,
  deselectCustomers,
  isSelected,
  plural,
  selectCustomers,
  type AgingGroup,
} from "./model";
import { Checkbox, CustomerAvatar } from "./ui";

/** Customers grouped by the A/R Aging buckets; a whole bucket or single customers can be selected. */
export function AgingTab({
  groups,
  selection,
  onSelectionChange,
}: {
  groups: readonly AgingGroup[];
  selection: Selection;
  onSelectionChange: (next: Selection) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <p className="border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        Days past due are counted from each invoice’s due date, or its invoice date when it has no due date, as on the A/R Aging report.
        Selecting a customer selects their whole payable balance; pick single invoices on the Invoices tab.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-[10.5px] uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="w-8 py-2 pl-3 pr-1">
              <span className="sr-only">Select</span>
            </th>
            <th scope="col" className="px-1.5 py-2 text-left font-medium">Customer</th>
            <th scope="col" className="px-1.5 py-2 text-left font-medium">Invoices in bucket</th>
            <th scope="col" className="py-2 pl-1.5 pr-3 text-right font-medium">Bucket balance</th>
          </tr>
        </thead>
        {groups.map((group) => {
          const label = AGING_BUCKETS.find((bucket) => bucket.key === group.key)?.filterLabel ?? group.label;
          const selectedRows = group.rows.filter((row) => isSelected(selection, row.customer.id)).length;
          const allSelected = group.rows.length > 0 && selectedRows === group.rows.length;
          return (
            <tbody key={group.key} data-testid={`receive-aging-group-${group.key}`}>
              <tr className="border-b border-border bg-secondary/50">
                <td className="py-2 pl-3 pr-1">
                  <Checkbox
                    aria-label={`Select all customers in ${label}`}
                    checked={allSelected}
                    indeterminate={selectedRows > 0 && !allSelected}
                    disabled={!group.rows.length}
                    onChange={(e) =>
                      onSelectionChange(
                        e.target.checked
                          ? selectCustomers(selection, group.rows.map((row) => row.customer))
                          : deselectCustomers(selection, group.rows.map((row) => row.customer.id)),
                      )
                    }
                  />
                </td>
                <th scope="rowgroup" colSpan={2} className="px-1.5 py-2 text-left text-xs font-semibold">
                  {label}
                  <span className="ml-2 font-normal text-muted-foreground">{plural(group.rows.length, "customer")}</span>
                </th>
                <td data-testid={`receive-aging-total-${group.key}`} className="py-2 pl-1.5 pr-3 text-right text-xs font-semibold tabular-nums">
                  {formatMoney(group.total)}
                </td>
              </tr>
              {group.rows.map((row) => (
                <tr key={row.customer.id} className="border-b border-border/70">
                  <td className="py-1.5 pl-3 pr-1">
                    <Checkbox
                      aria-label={`Select ${row.customer.name} in ${label}`}
                      checked={isSelected(selection, row.customer.id)}
                      onChange={(e) =>
                        onSelectionChange(
                          e.target.checked
                            ? selectCustomers(selection, [row.customer])
                            : deselectCustomers(selection, [row.customer.id]),
                        )
                      }
                    />
                  </td>
                  <td className="w-full max-w-0 px-1.5 py-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="hidden @min-[36rem]:inline-flex">
                        <CustomerAvatar id={row.customer.id} initials={row.customer.initials} />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium" title={row.customer.name}>{row.customer.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{row.customer.accountNumber ?? ""}</div>
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-1.5 py-1.5 text-xs tabular-nums">{plural(row.invoiceCount, "invoice")}</td>
                  <td className="whitespace-nowrap py-1.5 pl-1.5 pr-3 text-right font-medium tabular-nums">{formatMoney(row.balance)}</td>
                </tr>
              ))}
              {!group.rows.length && (
                <tr className="border-b border-border/70">
                  <td colSpan={4} className="px-3 py-2 text-xs text-muted-foreground">
                    No customers in this bucket.
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
