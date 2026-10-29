export interface InvoiceFilterRecord {
  invoiceNumber: string;
  status: string;
  total?: string | number | null;
  balanceDue?: string | number | null;
  issuedAt?: string | null;
  createdAt?: string | null;
  dueAt?: string | null;
  dueDate?: string | null;
  updatedAt?: string | null;
  frozen?: boolean;
  providerOrganizationId?: string | null;
  providerOrganization?: {
    name?: string | null;
    displayName?: string | null;
  } | null;
  displayMetadata?: unknown;
  displayMetadataJson?: unknown;
  aiGenerated?: boolean;
}

export type InvoiceViewMode = "all" | "open" | "outstanding";
export type InvoiceStatusFilter = "open" | "paid" | "draft" | "void" | "frozen" | "zero_balance";
export type InvoiceOrdinaryStatusFilter = Exclude<InvoiceStatusFilter, "open">;
export type InvoiceUnifiedStatusFilter = InvoiceViewMode | InvoiceStatusFilter;
export type InvoiceLegacyStatusFilter =
  | InvoiceStatusFilter
  | "all"
  | "closed"
  | "pastdue"
  | "overdue";
export type InvoiceStatusSelection =
  | { kind: "all" }
  | { kind: "view"; view: "open" | "outstanding" }
  | { kind: "statuses"; statuses: [InvoiceOrdinaryStatusFilter, ...InvoiceOrdinaryStatusFilter[]] };
export type InvoiceDateFilter =
  | "all" | "today" | "yesterday" | "this_week" | "last_week"
  | "this_month" | "last_month" | "this_year" | "last_year" | "ytd" | "custom";
export type InvoiceOverdueFilter = "all" | "0_30" | "31_60" | "61_90" | "90_plus" | "custom";
export type InvoiceSortField = "practice" | "issued" | "due";
export type InvoiceSortDirection = "asc" | "desc";

export const STATUS_FILTERS: { key: InvoiceStatusFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "paid", label: "Paid" },
  { key: "draft", label: "Draft" },
  { key: "void", label: "Void" },
  { key: "frozen", label: "Frozen" },
  { key: "zero_balance", label: "$0 Balance" },
];

export const UNIFIED_STATUS_FILTERS: { key: InvoiceUnifiedStatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "outstanding", label: "Outstanding" },
  ...STATUS_FILTERS.filter((option) => option.key !== "open"),
];

const ORDINARY_STATUS_FILTERS = new Set<InvoiceOrdinaryStatusFilter>([
  "paid",
  "draft",
  "void",
  "frozen",
  "zero_balance",
]);

const LEGACY_STATUS_FILTERS = new Set<InvoiceLegacyStatusFilter>([
  "all",
  "open",
  "paid",
  "draft",
  "void",
  "frozen",
  "zero_balance",
  "closed",
  "pastdue",
  "overdue",
]);

const OVERDUE_FILTER_VALUES = new Set<InvoiceOverdueFilter>([
  "all",
  "0_30",
  "31_60",
  "61_90",
  "90_plus",
  "custom",
]);

function stringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => stringValues(item));
}

function validLegacyStatus(value: unknown): InvoiceLegacyStatusFilter | null {
  const values = stringValues(value);
  if (values.length !== 1) return null;
  const [status] = values;
  return LEGACY_STATUS_FILTERS.has(status as InvoiceLegacyStatusFilter)
    ? status as InvoiceLegacyStatusFilter
    : null;
}

export interface InvoiceFilterPrecedenceInput {
  view?: unknown;
  statuses?: unknown;
  legacyStatus?: unknown;
  aging?: unknown;
}

export interface NormalizedInvoiceFilterPrecedence {
  selection: InvoiceStatusSelection;
  view: InvoiceViewMode;
  statuses: InvoiceStatusFilter[];
  legacyStatus: InvoiceLegacyStatusFilter | null;
  aging: InvoiceOverdueFilter | null;
}

/**
 * Normalize all invoice list filter controls at their shared boundary.
 *
 * `view` wins over `statuses`, which wins over the legacy `status` field.
 * The outstanding view owns its overdue window, so it also wins over aging.
 * The inputs are intentionally unknown because this function is shared by
 * URL/query callers as well as typed desktop and mobile options.
 */
export function normalizeInvoiceFilterPrecedence(
  input: InvoiceFilterPrecedenceInput,
): NormalizedInvoiceFilterPrecedence {
  const requestedView =
    input.view === "open" || input.view === "outstanding"
      ? input.view
      : "all";
  const modernStatuses = stringValues(input.statuses);
  const legacyStatuses = stringValues(input.legacyStatus);
  const selectedStatuses = requestedView !== "all"
    ? []
    : modernStatuses.length > 0
      ? modernStatuses
      : legacyStatuses;
  const selection = invoiceStatusSelectionFromLegacy(requestedView, selectedStatuses);
  const view = selection.kind === "view" ? selection.view : "all";
  const statuses = selection.kind === "statuses" ? [...selection.statuses] : [];
  const legacyStatus = requestedView !== "all" || modernStatuses.length > 0
    ? null
    : validLegacyStatus(input.legacyStatus);
  const requestedAging = stringValues(input.aging)[0];
  const aging = view === "outstanding"
    ? null
    : OVERDUE_FILTER_VALUES.has(requestedAging as InvoiceOverdueFilter)
      ? requestedAging as InvoiceOverdueFilter
      : null;

  return { selection, view, statuses, legacyStatus, aging };
}

export function invoiceStatusSelectionFromLegacy(
  view: InvoiceViewMode,
  statuses: readonly string[],
): InvoiceStatusSelection {
  if (view === "open" || view === "outstanding") return { kind: "view", view };
  if (statuses.includes("open")) return { kind: "view", view: "open" };
  const valid = [...new Set(statuses.filter(
    (status): status is InvoiceOrdinaryStatusFilter =>
      ORDINARY_STATUS_FILTERS.has(status as InvoiceOrdinaryStatusFilter),
  ))];
  return valid.length > 0
    ? {
      kind: "statuses",
      statuses: valid as [InvoiceOrdinaryStatusFilter, ...InvoiceOrdinaryStatusFilter[]],
    }
    : { kind: "all" };
}

export function invoiceStatusSelectionToLegacy(selection: InvoiceStatusSelection): {
  view: InvoiceViewMode;
  statuses: InvoiceStatusFilter[];
} {
  if (selection.kind === "view") return { view: selection.view, statuses: [] };
  if (selection.kind === "statuses") return { view: "all", statuses: [...selection.statuses] };
  return { view: "all", statuses: [] };
}

export function invoiceStatusSelectionValues(
  selection: InvoiceStatusSelection,
): InvoiceUnifiedStatusFilter[] {
  if (selection.kind === "view") return [selection.view];
  if (selection.kind === "statuses") return [...selection.statuses];
  return ["all"];
}

export function transitionInvoiceStatusSelection(
  current: InvoiceStatusSelection,
  choice: InvoiceUnifiedStatusFilter,
): InvoiceStatusSelection {
  if (choice === "all") return { kind: "all" };
  if (choice === "open" || choice === "outstanding") return { kind: "view", view: choice };

  const statuses: readonly InvoiceOrdinaryStatusFilter[] =
    current.kind === "statuses" ? current.statuses : [];
  if (statuses.includes(choice)) {
    const remaining = statuses.filter((status) => status !== choice);
    return remaining.length > 0
      ? {
        kind: "statuses",
        statuses: remaining as [InvoiceOrdinaryStatusFilter, ...InvoiceOrdinaryStatusFilter[]],
      }
      : { kind: "all" };
  }
  const nextStatuses: [InvoiceOrdinaryStatusFilter, ...InvoiceOrdinaryStatusFilter[]] =
    statuses.length === 0
    ? [choice]
    : [statuses[0], ...statuses.slice(1), choice];
  return { kind: "statuses", statuses: nextStatuses };
}

export function transitionInvoiceStatusSelectionValues(
  current: InvoiceStatusSelection,
  nextValues: readonly string[],
): InvoiceStatusSelection {
  const currentValues = invoiceStatusSelectionValues(current);
  const added = nextValues.find((value) => !currentValues.includes(
    value as InvoiceUnifiedStatusFilter,
  ));
  if (added) {
    return transitionInvoiceStatusSelection(current, added as InvoiceUnifiedStatusFilter);
  }

  const remaining = [...new Set(nextValues.filter(
    (value): value is InvoiceOrdinaryStatusFilter =>
      ORDINARY_STATUS_FILTERS.has(value as InvoiceOrdinaryStatusFilter),
  ))];
  if (remaining.length > 0) {
    return {
      kind: "statuses",
      statuses: remaining as [InvoiceOrdinaryStatusFilter, ...InvoiceOrdinaryStatusFilter[]],
    };
  }
  return { kind: "all" };
}

export const DATE_FILTERS: { key: InvoiceDateFilter; label: string }[] = [
  { key: "all", label: "Any time" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "custom", label: "Custom range" },
];

export const OVERDUE_FILTERS: { key: InvoiceOverdueFilter; label: string }[] = [
  { key: "all", label: "Any age" },
  { key: "0_30", label: "0–30 days overdue" },
  { key: "31_60", label: "31–60 days overdue" },
  { key: "61_90", label: "61–90 days overdue" },
  { key: "90_plus", label: "90+ days overdue" },
  { key: "custom", label: "Custom due-date range" },
];

export function dateFilterLabel(key: InvoiceDateFilter): string {
  return DATE_FILTERS.find((filter) => filter.key === key)?.label ?? "Any time";
}

export function overdueFilterLabel(key: InvoiceOverdueFilter): string {
  return OVERDUE_FILTERS.find((filter) => filter.key === key)?.label ?? "Any age";
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function millisecondsUntilNextLocalMidnight(now: Date): number {
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return nextMidnight.getTime() - now.getTime();
}

export function getLocalTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseDateInput(raw: string): Date | null {
  const value = raw.trim();
  if (!value) return null;
  let year: number;
  let month: number;
  let day: number;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(value);
    if (!match) return null;
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  }
  const date = new Date(year, month - 1, day);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
    && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

export interface DateRange {
  start: Date;
  end: Date;
}

export interface InvoiceDateRange {
  start: Date | null;
  end: Date | null;
}

/** A selected local calendar day, represented as the UTC day used for invoice issue dates. */
export function invoiceUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

export function dateRangeForFilter(
  filter: InvoiceDateFilter,
  now: Date,
  customStart?: Date | null,
  customEnd?: Date | null,
): DateRange | null {
  const today = startOfDay(now);
  const isoDay = (now.getDay() + 6) % 7;
  let localRange: DateRange | null;
  switch (filter) {
    case "all": localRange = null; break;
    case "today": localRange = { start: today, end: addDays(today, 1) }; break;
    case "yesterday": localRange = { start: addDays(today, -1), end: today }; break;
    case "this_week": localRange = { start: addDays(today, -isoDay), end: addDays(today, 1) }; break;
    case "last_week": {
      const thisMonday = addDays(today, -isoDay);
      localRange = { start: addDays(thisMonday, -7), end: thisMonday }; break;
    }
    case "this_month": localRange = { start: new Date(now.getFullYear(), now.getMonth(), 1), end: addDays(today, 1) }; break;
    case "last_month": localRange = {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      end: new Date(now.getFullYear(), now.getMonth(), 1),
    }; break;
    case "this_year":
    case "ytd":
      localRange = { start: new Date(now.getFullYear(), 0, 1), end: addDays(today, 1) }; break;
    case "last_year":
      localRange = { start: new Date(now.getFullYear() - 1, 0, 1), end: new Date(now.getFullYear(), 0, 1) }; break;
    case "custom":
      if (!customStart || !customEnd || customEnd < customStart) return null;
      localRange = { start: startOfDay(customStart), end: addDays(startOfDay(customEnd), 1) }; break;
  }
  return localRange && { start: invoiceUtcDay(localRange.start), end: invoiceUtcDay(localRange.end) };
}

export function invoiceFilterDate(invoice: InvoiceFilterRecord): Date | null {
  return invoice.issuedAt
    ? parseIsoDate(invoice.issuedAt)
    : parseIsoDate(invoice.createdAt);
}

/** Issue dates are calendar-day values encoded as UTC timestamps, not local instants. */
export function formatInvoiceIssueDate(value?: string | null): string {
  if (!value) return "—";
  const date = parseIsoDate(value);
  if (!date) return "—";
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

export function matchesDateRange(
  invoice: InvoiceFilterRecord,
  range: InvoiceDateRange | null,
): boolean {
  if (!range) return true;
  const date = invoiceFilterDate(invoice);
  return Boolean(
    date
    && (!range.start || date >= range.start)
    && (!range.end || date < range.end),
  );
}

function statusMatches(invoice: InvoiceFilterRecord, status: InvoiceStatusFilter): boolean {
  if (status === "zero_balance") return Number(invoice.balanceDue ?? invoice.total ?? 0) === 0;
  if (status === "frozen") return Boolean(invoice.frozen);
  if (status === "draft") return invoice.status === "draft" || invoice.status === "recovery_draft";
  if (status === "open") return invoice.status === "open";
  return invoice.status === status;
}

export function matchesStatusFilters(
  invoice: InvoiceFilterRecord,
  statuses: InvoiceStatusFilter[],
): boolean {
  return statuses.length === 0 || statuses.some((status) => statusMatches(invoice, status));
}

export function matchesStatusFilter(
  invoice: InvoiceFilterRecord,
  filter: InvoiceStatusFilter | "all" | "closed" | "pastdue" | "overdue",
  now: Date,
): boolean {
  if (filter === "all") return true;
  if (filter === "closed") return invoice.status === "paid" || invoice.status === "void";
  if (filter === "pastdue" || filter === "overdue") {
    return matchesViewMode(invoice, "outstanding", now)
      || (
        invoice.status === "overdue"
        && Number(invoice.balanceDue ?? 0) > 0
        && !invoice.frozen
      );
  }
  return statusMatches(invoice, filter);
}

export function matchesViewMode(
  invoice: InvoiceFilterRecord,
  view: InvoiceViewMode,
  now: Date,
): boolean {
  if (view === "all") return true;
  if (view === "open") return invoice.status === "open" || invoice.status === "partially_paid";
  const dueKey = typeof (invoice.dueAt ?? invoice.dueDate) === "string"
    ? String(invoice.dueAt ?? invoice.dueDate).slice(0, 10)
    : "";
  const todayKey = now.toISOString().slice(0, 10);
  return (invoice.status === "open" || invoice.status === "partially_paid")
    && Number(invoice.balanceDue ?? 0) > 0
    && Boolean(dueKey && dueKey < todayKey);
}

export function matchesOverdueFilter(
  invoice: InvoiceFilterRecord,
  filter: InvoiceOverdueFilter,
  now: Date,
  customStart?: Date | null,
  customEnd?: Date | null,
): boolean {
  if (filter === "all") return true;
  if (filter === "custom") {
    if (!customStart || !customEnd || customEnd < customStart) return true;
    return matchesDateRange(
      invoice,
      dateRangeForFilter("custom", now, customStart, customEnd),
    );
  }
  if (invoice.frozen) return false;
  const due = parseIsoDate(invoice.dueAt ?? invoice.dueDate);
  if (!due || Number(invoice.balanceDue ?? 0) <= 0) return false;
  const ageDays = Math.floor(
    (startOfDay(now).getTime() - startOfDay(due).getTime()) / 86_400_000,
  );
  if (filter === "0_30") return ageDays >= 0 && ageDays <= 30;
  if (filter === "31_60") return ageDays >= 31 && ageDays <= 60;
  if (filter === "61_90") return ageDays >= 61 && ageDays <= 90;
  return ageDays >= 91;
}

export function customerNameOf(invoice: InvoiceFilterRecord): string {
  return (
    invoice.providerOrganization?.displayName
    || invoice.providerOrganization?.name
    || ""
  ).trim();
}

function metadata(invoice: InvoiceFilterRecord): Record<string, unknown> {
  const value = invoice.displayMetadata ?? invoice.displayMetadataJson;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function doctorNameOf(invoice: InvoiceFilterRecord): string {
  const meta = metadata(invoice);
  return String(meta.billTo ?? meta.doctorName ?? "").trim();
}

export function matchesSearch(invoice: InvoiceFilterRecord, raw: string): boolean {
  const query = raw.trim().toLocaleLowerCase();
  if (!query) return true;
  const meta = metadata(invoice);
  return [invoice.invoiceNumber, customerNameOf(invoice), meta.patientName, meta.billTo]
    .some((value) => String(value ?? "").toLocaleLowerCase().includes(query));
}

export interface InvoiceFilterOptions {
  view?: InvoiceViewMode;
  statuses?: InvoiceStatusFilter[];
  status?: InvoiceLegacyStatusFilter;
  search?: string;
  practiceId?: string;
  doctorName?: string;
  aiOnly?: boolean;
  date: InvoiceDateFilter;
  customStart?: Date | null;
  customEnd?: Date | null;
  issuedRange?: InvoiceDateRange | null;
  overdue?: InvoiceOverdueFilter;
  overdueCustomStart?: Date | null;
  overdueCustomEnd?: Date | null;
  sort?: InvoiceSortField | "newest" | "customer";
  sortDirection?: InvoiceSortDirection;
}

export function filterAndSortInvoices<T extends InvoiceFilterRecord>(
  invoices: T[],
  options: InvoiceFilterOptions,
  now: Date = new Date(),
): T[] {
  const normalized = normalizeInvoiceFilterPrecedence({
    view: options.view,
    statuses: options.statuses,
    legacyStatus: options.status,
    aging: options.overdue,
  });
  const { view, statuses, legacyStatus } = normalized;
  const range = options.issuedRange === undefined
    ? dateRangeForFilter(options.date, now, options.customStart, options.customEnd)
    : options.issuedRange;
  const rows = invoices.filter((invoice) => {
    if (
      (legacyStatus === "pastdue" || legacyStatus === "overdue")
      && !matchesStatusFilter(invoice, "pastdue", now)
    ) return false;
    if (legacyStatus === "closed" && !matchesStatusFilter(invoice, "closed", now)) return false;
    if (view !== "all" && !matchesViewMode(invoice, view, now)) return false;
    if (view !== "outstanding") {
      if (!matchesStatusFilters(invoice, statuses)) return false;
      if (!matchesOverdueFilter(
        invoice,
        normalized.aging ?? "all",
        now,
        options.overdueCustomStart,
        options.overdueCustomEnd,
      )) return false;
    }
    return matchesSearch(invoice, options.search ?? "")
      && (!options.practiceId || invoice.providerOrganizationId === options.practiceId)
      && (!options.doctorName || doctorNameOf(invoice) === options.doctorName)
      && (!options.aiOnly || invoice.aiGenerated === true)
      && matchesDateRange(invoice, range);
  });

  const field = options.sort === "customer"
    ? "practice"
    : options.sort === "newest" ? undefined : options.sort;
  const direction = options.sortDirection === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    if (!field) {
      if (options.sort === "newest") return 0;
      return String(right.createdAt ?? right.issuedAt ?? "")
        .localeCompare(String(left.createdAt ?? left.issuedAt ?? ""));
    }
    if (field === "practice") {
      return direction * customerNameOf(left).localeCompare(
        customerNameOf(right),
        undefined,
        { sensitivity: "base" },
      );
    }
    const leftValue = field === "issued" ? left.issuedAt : (left.dueAt ?? left.dueDate);
    const rightValue = field === "issued" ? right.issuedAt : (right.dueAt ?? right.dueDate);
    return direction * String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
  });
}