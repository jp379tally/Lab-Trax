import type { CanonicalInvoice } from "@workspace/api-client-react";

// ── Filter/sort vocab ────────────────────────────────────────────────────────

export type InvoiceStatusFilter = "all" | "open" | "closed" | "pastdue" | "frozen";

export type InvoiceDateFilter =
  | "all"
  | "today"
  | "yesterday"
  | "last_week"
  | "this_month"
  | "last_month"
  | "last_year"
  | "this_year"
  | "ytd"
  | "custom";

export type InvoiceSort = "newest" | "customer";

export const STATUS_FILTERS: { key: InvoiceStatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
  { key: "pastdue", label: "Past Due" },
  { key: "frozen", label: "Frozen" },
];

export const DATE_FILTERS: { key: InvoiceDateFilter; label: string }[] = [
  { key: "all", label: "All dates" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last_week", label: "Last week" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_year", label: "Last year" },
  { key: "this_year", label: "This year" },
  { key: "ytd", label: "This year to date" },
  { key: "custom", label: "Custom range" },
];

export function dateFilterLabel(key: InvoiceDateFilter): string {
  return DATE_FILTERS.find((f) => f.key === key)?.label ?? "All dates";
}

// ── Status semantics (parity with desktop invoices page) ────────────────────
// "Open"   = status open or partially_paid (balance still collectible)
// "Closed" = status paid or void (nothing left to collect)
// "Past due" = open-ish AND dueAt strictly before the start of today

function isOpenStatus(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "open" || s === "partially_paid";
}

function isClosedStatus(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "paid" || s === "void";
}

export function matchesStatusFilter(
  inv: CanonicalInvoice,
  filter: InvoiceStatusFilter,
  now: Date,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "open":
      return isOpenStatus(inv.status);
    case "closed":
      return isClosedStatus(inv.status);
    case "pastdue": {
      if (!isOpenStatus(inv.status)) return false;
      const due = parseIsoDate(inv.dueAt);
      if (!due) return false;
      return due.getTime() < startOfDay(now).getTime();
    }
    case "frozen":
      return Boolean(inv.frozen);
  }
}

// ── Date helpers (all local time) ────────────────────────────────────────────

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

function parseIsoDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse a user-entered date. Accepts `MM/DD/YYYY` and `YYYY-MM-DD` (also with
 * `/` or `.` separators and 1-digit month/day). Returns a local-midnight Date
 * or null when unparseable.
 */
export function parseDateInput(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (match) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else {
    match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (!match) return null;
    m = Number(match[1]);
    d = Number(match[2]);
    y = Number(match[3]);
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, m - 1, d);
  // Reject rollovers like Feb 30 → Mar 2.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

export interface DateRange {
  /** Inclusive start. */
  start: Date;
  /** Exclusive end. */
  end: Date;
}

/**
 * Resolve a date-filter key into a concrete [start, end) range, or null when
 * no date filtering applies ("all", or an incomplete/invalid custom range).
 */
export function dateRangeForFilter(
  filter: InvoiceDateFilter,
  now: Date,
  customStart?: Date | null,
  customEnd?: Date | null,
): DateRange | null {
  const today = startOfDay(now);
  switch (filter) {
    case "all":
      return null;
    case "today":
      return { start: today, end: addDays(today, 1) };
    case "yesterday":
      return { start: addDays(today, -1), end: today };
    case "last_week": {
      // Previous calendar week, Sunday through Saturday.
      const thisWeekStart = addDays(today, -today.getDay());
      return { start: addDays(thisWeekStart, -7), end: thisWeekStart };
    }
    case "this_month": {
      // First of the current month through the end of today ("so far this month").
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start, end: addDays(today, 1) };
    }
    case "last_month": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start, end };
    }
    case "last_year": {
      const start = new Date(now.getFullYear() - 1, 0, 1);
      const end = new Date(now.getFullYear(), 0, 1);
      return { start, end };
    }
    case "this_year": {
      const start = new Date(now.getFullYear(), 0, 1);
      const end = new Date(now.getFullYear() + 1, 0, 1);
      return { start, end };
    }
    case "ytd": {
      const start = new Date(now.getFullYear(), 0, 1);
      return { start, end: addDays(today, 1) };
    }
    case "custom": {
      if (!customStart || !customEnd) return null;
      const start = startOfDay(customStart);
      const end = addDays(startOfDay(customEnd), 1);
      if (end.getTime() <= start.getTime()) return null;
      return { start, end };
    }
  }
}

/**
 * The date an invoice is bucketed by for date filtering: the issued date when
 * present, otherwise the created date (drafts have no issuedAt).
 */
export function invoiceFilterDate(inv: CanonicalInvoice): Date | null {
  const issued = parseIsoDate(inv.issuedAt);
  if (issued) return issued;
  const created = typeof inv.createdAt === "string" ? parseIsoDate(inv.createdAt) : null;
  return created;
}

export function matchesDateRange(inv: CanonicalInvoice, range: DateRange | null): boolean {
  if (!range) return true;
  const d = invoiceFilterDate(inv);
  if (!d) return false;
  const t = d.getTime();
  return t >= range.start.getTime() && t < range.end.getTime();
}

// ── Sorting ──────────────────────────────────────────────────────────────────

export function customerNameOf(inv: CanonicalInvoice): string {
  const org = inv.providerOrganization;
  return (org?.displayName || org?.name || "").trim();
}

// ── Combined pipeline ────────────────────────────────────────────────────────

export interface InvoiceFilterOptions {
  status: InvoiceStatusFilter;
  date: InvoiceDateFilter;
  customStart?: Date | null;
  customEnd?: Date | null;
  sort: InvoiceSort;
}

export function filterAndSortInvoices(
  invoices: CanonicalInvoice[],
  opts: InvoiceFilterOptions,
  now: Date = new Date(),
): CanonicalInvoice[] {
  const range = dateRangeForFilter(opts.date, now, opts.customStart, opts.customEnd);
  const filtered = invoices.filter(
    (inv) => matchesStatusFilter(inv, opts.status, now) && matchesDateRange(inv, range),
  );
  if (opts.sort === "customer") {
    // Stable sort by customer name (case-insensitive); unnamed customers last.
    return [...filtered].sort((a, b) => {
      const an = customerNameOf(a);
      const bn = customerNameOf(b);
      if (!an && !bn) return 0;
      if (!an) return 1;
      if (!bn) return -1;
      return an.localeCompare(bn, undefined, { sensitivity: "base" });
    });
  }
  return filtered;
}
