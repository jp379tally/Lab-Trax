import { useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, CalendarClock, FileText, Loader2, ScrollText, Users } from "lucide-react";
import type { Selection } from "./types";
import {
  DEFAULT_SORT,
  EMPTY_FILTERS,
  agingGroups,
  customerMatches,
  filtersActive,
  invoiceMatches,
  locationOptions,
  nextSort,
  plural,
  sortCustomers,
  sortInvoices,
  sortStatementCustomers,
  type PayableCustomer,
  type PayableInvoice,
  type SelectionFilters,
  type SortKey,
  type SortState,
} from "./model";
import { AgingTab } from "./AgingTab";
import { CustomersTab } from "./CustomersTab";
import { InvoicesTab } from "./InvoicesTab";
import { SavedSelections } from "./SavedSelections";
import { SelectionToolbar } from "./SelectionToolbar";
import { NO_STATEMENTS_TEXT, StatementsTab } from "./StatementsTab";

export type SelectionTab = "customers" | "invoices" | "aging" | "statements";

export type SelectionView = {
  tab: SelectionTab;
  filters: SelectionFilters;
  sort: SortState;
  /** Set by "View invoices": the Invoices tab lists only this customer's invoices. */
  invoiceCustomerId: string | null;
};

export const DEFAULT_SELECTION_VIEW: SelectionView = {
  tab: "customers",
  filters: EMPTY_FILTERS,
  sort: DEFAULT_SORT,
  invoiceCustomerId: null,
};

export type SelectionPanelStatus = "loading" | "error" | "ready";

const TABS: ReadonlyArray<{ key: SelectionTab; label: string; icon: ReactNode }> = [
  { key: "customers", label: "Customers", icon: <Users size={14} aria-hidden="true" /> },
  { key: "invoices", label: "Invoices", icon: <FileText size={14} aria-hidden="true" /> },
  { key: "aging", label: "Aging", icon: <CalendarClock size={14} aria-hidden="true" /> },
  { key: "statements", label: "Statements", icon: <ScrollText size={14} aria-hidden="true" /> },
];

/** The aging filter means something slightly different on each tab, so its name says which. */
const AGING_FILTER_LABELS: Record<SelectionTab, string> = {
  customers: "Aging of oldest invoice",
  invoices: "Invoice aging",
  aging: "Aging bucket",
  statements: "Aging of oldest invoice",
};

const PANEL_ID = "receive-selection-tabpanel";
const tabId = (tab: SelectionTab) => `receive-selection-tab-${tab}`;

function EmptyState({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
      <p>{children}</p>
      {actions && <div className="flex flex-wrap items-center justify-center gap-3">{actions}</div>}
    </div>
  );
}

const linkButtonClass = "text-xs font-medium text-primary hover:underline";

/**
 * The tabbed selection panel: Customers, Invoices, Aging and Statements views
 * over one shared selection, with the reference's filters, sorting and saved
 * selections. Every tab reads and writes the same `Selection`, so the
 * heads-up cards and the Payment Summary always agree with what is ticked.
 */
export function SelectionPanel({
  status,
  errorMessage,
  onRetry,
  customers,
  customersById,
  selection,
  onSelectionChange,
  view,
  onViewChange,
  onEditInvoice,
  savedSelectionsKey,
}: {
  status: SelectionPanelStatus;
  errorMessage?: string | null;
  onRetry: () => void;
  customers: readonly PayableCustomer[];
  customersById: ReadonlyMap<string, PayableCustomer>;
  selection: Selection;
  onSelectionChange: (next: Selection) => void;
  view: SelectionView;
  onViewChange: (next: SelectionView) => void;
  onEditInvoice: (invoice: PayableInvoice) => void;
  /** Null when there is no signed-in user to keep saved selections for. */
  savedSelectionsKey: string | null;
}) {
  const tabRefs = useRef<Partial<Record<SelectionTab, HTMLButtonElement | null>>>({});
  const { filters, sort, tab } = view;
  const { locations, hasMissing } = useMemo(() => locationOptions(customers), [customers]);
  const practiceCustomers = useMemo(
    () => customers.filter((customer) => !customer.isDoctorAccount),
    [customers],
  );
  const matching = useMemo(
    () => customers.filter((customer) => customerMatches(customer, filters)),
    [customers, filters],
  );
  const matchingCustomerRows = useMemo(() => {
    const visible = new Map(matching.map((customer) => [customer.id, customer]));
    for (const customer of matching) {
      if (!customer.isDoctorAccount || !customer.practiceOrganizationId) continue;
      const practice = customersById.get(customer.practiceOrganizationId);
      if (practice && !practice.isDoctorAccount) visible.set(practice.id, practice);
    }
    return sortCustomers([...visible.values()], sort);
  }, [matching, customersById, sort]);
  const focusCustomer =
    tab === "invoices" && view.invoiceCustomerId ? customersById.get(view.invoiceCustomerId) ?? null : null;
  const active = filtersActive(filters);

  const setFilters = (next: SelectionFilters) => onViewChange({ ...view, filters: next });
  const setSort = (next: SortState) => onViewChange({ ...view, sort: next });
  const onSort = (key: SortKey) => setSort(nextSort(sort, key));
  const clearFilters = () => onViewChange({ ...view, filters: EMPTY_FILTERS });
  const selectTab = (next: SelectionTab) => onViewChange({ ...view, tab: next, invoiceCustomerId: null });
  const viewInvoices = (customer: PayableCustomer) =>
    onViewChange({ ...view, tab: "invoices", invoiceCustomerId: customer.id });
  const clearFocus = () => onViewChange({ ...view, invoiceCustomerId: null });

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex((row) => row.key === tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const key = TABS[next]!.key;
    selectTab(key);
    tabRefs.current[key]?.focus();
  };

  const clearButton = active ? (
    <button type="button" onClick={clearFilters} className={linkButtonClass}>
      Clear filters
    </button>
  ) : null;

  const hiddenSelected =
    status === "ready" && (tab === "customers" || tab === "statements") && active
      ? selection.ids.filter((id) => {
          const customer = customersById.get(id);
          return !!customer && !customerMatches(customer, filters);
        }).length
      : 0;

  const renderTab = (): ReactNode => {
    if (status === "loading") {
      return (
        <div role="status" className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          Loading customers with a balance due…
        </div>
      );
    }
    if (status === "error") {
      return (
        <div role="alert" className="m-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0 space-y-1">
              <p className="font-medium text-destructive">Customer balances could not be loaded.</p>
              <p className="text-xs text-muted-foreground">
                {errorMessage || "The list of customers with a balance due is unavailable."} Nothing can be received
                until both payable-customer lists load.
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-1 h-8 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-secondary"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      );
    }
    if (tab === "statements" && !practiceCustomers.some((customer) => customer.statement)) {
      return <EmptyState>{NO_STATEMENTS_TEXT}</EmptyState>;
    }
    if (!customers.length) return <EmptyState>No customers have anything payable.</EmptyState>;

    switch (tab) {
      case "customers": {
        if (!matching.length) return <EmptyState actions={clearButton}>No customers match these filters.</EmptyState>;
        return (
          <CustomersTab
            rows={matchingCustomerRows}
            allCustomers={customers}
            selection={selection}
            sort={sort}
            onSort={onSort}
            onSelectionChange={onSelectionChange}
            onViewInvoices={viewInvoices}
          />
        );
      }
      case "invoices": {
        const source = focusCustomer ? [focusCustomer] : practiceCustomers;
        const rows = sortInvoices(
          source.flatMap((customer) => customer.invoices.filter((invoice) => invoiceMatches(invoice, customer, filters))),
          sort,
          customersById,
        );
        if (!rows.length) {
          return (
            <EmptyState
              actions={
                <>
                  {clearButton}
                  {focusCustomer && (
                    <button type="button" onClick={clearFocus} className={linkButtonClass}>
                      Show all customers
                    </button>
                  )}
                </>
              }
            >
              {focusCustomer
                ? `No invoices for ${focusCustomer.name} match these filters.`
                : active
                  ? "No invoices match these filters."
                  : "No outstanding invoice details are available."}
            </EmptyState>
          );
        }
        return (
          <InvoicesTab
            rows={rows}
            customersById={customersById}
            selection={selection}
            sort={sort}
            onSort={onSort}
            onSelectionChange={onSelectionChange}
            onEditInvoice={onEditInvoice}
            focusCustomer={focusCustomer}
            onClearFocus={clearFocus}
          />
        );
      }
      case "aging": {
        // The aging filter picks the bucket to show rather than filtering
        // customers by their oldest invoice.
        const base = practiceCustomers.filter((customer) => customerMatches(customer, { ...filters, aging: "" }));
        if (!base.length) return <EmptyState actions={clearButton}>No customers match these filters.</EmptyState>;
        const groups = agingGroups(sortCustomers(base, sort)).filter(
          (group) => !filters.aging || group.key === filters.aging,
        );
        return <AgingTab groups={groups} selection={selection} onSelectionChange={onSelectionChange} />;
      }
      case "statements": {
        const rows = practiceCustomers.filter((customer) => customerMatches(customer, filters) && customer.statement);
        if (!rows.length) return <EmptyState actions={clearButton}>No customers match these filters.</EmptyState>;
        return (
          <StatementsTab
            rows={sortStatementCustomers(rows, sort)}
            selection={selection}
            sort={sort}
            onSort={onSort}
            onSelectionChange={onSelectionChange}
          />
        );
      }
    }
  };

  return (
    <section
      aria-label="Choose customers to receive payment from"
      className="@container min-w-0 rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1 border-b border-border px-2 pt-2">
        <div role="tablist" aria-label="Choose customers by" className="-mb-px flex min-w-0 max-w-full overflow-x-auto">
          {TABS.map((row) => {
            const selected = row.key === tab;
            return (
              <button
                key={row.key}
                ref={(node) => {
                  tabRefs.current[row.key] = node;
                }}
                type="button"
                role="tab"
                id={tabId(row.key)}
                aria-selected={selected}
                aria-controls={PANEL_ID}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(row.key)}
                onKeyDown={onTabKeyDown}
                className={`inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-2.5 text-sm font-medium transition-colors @min-[36rem]:px-3 ${
                  selected
                    ? "border-primary bg-primary/[0.06] text-primary"
                    : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                }`}
              >
                {row.icon}
                {row.label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto pb-2">
          <SavedSelections
            storageKey={savedSelectionsKey}
            selection={selection}
            customersById={customersById}
            ready={status === "ready"}
            onLoad={onSelectionChange}
          />
        </div>
      </div>
      <div id={PANEL_ID} role="tabpanel" aria-labelledby={tabId(tab)}>
        <SelectionToolbar
          filters={filters}
          onFiltersChange={setFilters}
          sort={sort}
          onSortChange={setSort}
          locations={locations}
          hasMissingLocation={hasMissing}
          agingLabel={AGING_FILTER_LABELS[tab]}
          canClear={active || !!focusCustomer}
          onClear={() => onViewChange({ ...view, filters: EMPTY_FILTERS, invoiceCustomerId: null })}
        />
        {renderTab()}
        {hiddenSelected > 0 && (
          <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            {plural(hiddenSelected, "selected customer")} {hiddenSelected === 1 ? "is" : "are"} hidden by these filters
            and will still be received.
          </p>
        )}
      </div>
    </section>
  );
}
