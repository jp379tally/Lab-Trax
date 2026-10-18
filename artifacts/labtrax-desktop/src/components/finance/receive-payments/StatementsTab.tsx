import { formatDate, formatMoney } from "@/lib/format";
import type { Selection } from "./types";
import {
  deselectCustomers,
  isSelected,
  plural,
  scopeFor,
  selectStatementScope,
  type PayableCustomer,
  type SortKey,
  type SortState,
} from "./model";
import { scopeNote, statementDiffers } from "./CustomersTab";
import { Checkbox, SortHeader } from "./ui";

export const NO_STATEMENTS_TEXT = "No customers have a successfully sent statement with an unpaid balance.";

function periodText(customer: PayableCustomer): string {
  const statement = customer.statement;
  if (!statement) return "—";
  if (statement.periodStart && statement.periodEnd) {
    // The no-break space keeps the dash with the start date when a narrow panel wraps the period.
    return `${formatDate(statement.periodStart)}\u00a0– ${formatDate(statement.periodEnd)}`;
  }
  return statement.periodEnd ? `Ending ${formatDate(statement.periodEnd)}` : "—";
}

/** Each customer's payable sent statement; selecting one pays that customer by statement. */
export function StatementsTab({
  rows,
  selection,
  sort,
  onSort,
  onSelectionChange,
}: {
  rows: readonly PayableCustomer[];
  selection: Selection;
  sort: SortState;
  onSort: (key: SortKey) => void;
  onSelectionChange: (next: Selection) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-[10.5px] uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="w-8 py-2 pl-3 pr-1">
              <span className="sr-only">Pay by statement</span>
            </th>
            <SortHeader label="Customer" sortKey="name" sort={sort} onSort={onSort} />
            <th scope="col" className="px-1.5 py-2 text-left font-medium">Period</th>
            <th scope="col" className="px-1.5 py-2 text-left font-medium">Sent</th>
            <th scope="col" className="px-1.5 py-2 text-left font-medium">Unpaid sent</th>
            <SortHeader label="Statement Balance" sortKey="balance" sort={sort} onSort={onSort} align="right" className="pr-3" />
          </tr>
        </thead>
        <tbody>
          {rows.map((customer) => {
            const statement = customer.statement!;
            const selected = isSelected(selection, customer.id);
            const scope = scopeFor(selection, customer);
            const full = selected && scope.mode === "statement" && !scope.invoiceIds;
            const note = scopeNote(selection, customer);
            return (
              <tr
                key={customer.id}
                className={`border-b border-border/70 last:border-0 ${full ? "bg-primary/[0.06]" : "hover:bg-secondary/40"}`}
              >
                <td className="py-2 pl-3 pr-1">
                  <Checkbox
                    aria-label={`Pay ${customer.name} by statement`}
                    checked={full}
                    indeterminate={selected && !full}
                    onChange={(e) =>
                      onSelectionChange(
                        e.target.checked
                          ? selectStatementScope(selection, customer)
                          : deselectCustomers(selection, [customer.id]),
                      )
                    }
                  />
                </td>
                <td className="w-full max-w-0 px-1.5 py-2">
                  <div className="truncate font-medium" title={customer.name}>{customer.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {customer.accountNumber ?? ""}
                    {note && (
                      <span className="text-amber-700 dark:text-amber-300">
                        {customer.accountNumber ? " · " : ""}
                        {note}
                      </span>
                    )}
                  </div>
                </td>
                {/* Long text wraps in a narrow panel so the balance column stays in view. */}
                <td className="whitespace-normal px-1.5 py-2 text-xs tabular-nums @min-[34rem]:whitespace-nowrap">{periodText(customer)}</td>
                <td className="px-1.5 py-2 text-xs tabular-nums">
                  {statement.sentDates.length ? statement.sentDates.map((date) => formatDate(date)).join(", ") : "—"}
                </td>
                <td className="whitespace-nowrap px-1.5 py-2 text-xs tabular-nums">{plural(statement.statementCount, "statement")}</td>
                <td className="whitespace-nowrap py-2 pl-1.5 pr-3 text-right tabular-nums">
                  <div className="font-semibold">
                    {statement.balance === null ? "Unavailable" : formatMoney(statement.balance)}
                  </div>
                  {statementDiffers(customer) && (
                    <div className="whitespace-normal text-[11px] leading-tight text-muted-foreground @min-[34rem]:whitespace-nowrap @min-[34rem]:leading-normal">
                      Total outstanding {formatMoney(customer.totalBalance)}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
