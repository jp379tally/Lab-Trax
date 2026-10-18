/**
 * Invoice generated-date filter presets and range computation.
 *
 * Mirrors the half-open interval pattern used by computeCaseDateRange in
 * case-date-filter.ts. `endDate` is always exclusive (the day *after* the
 * last included day) so a same-day range still includes the full day.
 */
import { dateRangeForFilter, invoiceUtcDay, parseDateInput, type InvoiceDateFilter } from "@workspace/api-client-react";

export type InvoiceDatePreset = Exclude<InvoiceDateFilter, "ytd">;

export const INVOICE_DATE_PRESET_LABELS: Record<InvoiceDatePreset, string> = {
  all: "Any time",
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
  last_month: "Last month",
  this_year: "This year",
  last_year: "Last year",
  custom: "Custom…",
};

/**
 * Resolve an invoice date preset into a concrete [startDate, endDate)
 * half-open interval.
 *
 * Returns `null` for either bound when that bound is unconstrained.
 * `now` is injectable so tests are not wall-clock dependent.
 */
export function computeInvoiceDateRange(
  preset: InvoiceDatePreset,
  customStart: string,
  customEnd: string,
  now: Date = new Date(),
): { startDate: Date | null; endDate: Date | null } {
  if (preset === "all") {
    return { startDate: null, endDate: null };
  }
  if (preset === "custom") {
    const start = parseDateInput(customStart);
    const end = parseDateInput(customEnd);
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return {
      startDate: start ? invoiceUtcDay(start) : null,
      endDate: invoiceUtcDay(end
        ? new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1)
        : tomorrow),
    };
  }
  const range = dateRangeForFilter(preset, now);
  return { startDate: range?.start ?? null, endDate: range?.end ?? null };
}
