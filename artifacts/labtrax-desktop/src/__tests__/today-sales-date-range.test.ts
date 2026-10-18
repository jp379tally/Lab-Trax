/**
 * Unit tests for getLocalDayRange() — the helper that produces the
 * dateFrom/dateTo UTC timestamps sent to /invoices/reports/sales when
 * rendering the "Today's Sales" dashboard widget.
 *
 * The server filters with inclusive gte/lte comparisons against
 * `COALESCE(issued_at, created_at)`. Passing bare YYYY-MM-DD strings
 * would make new Date("2026-08-10") resolve to midnight UTC at the
 * start of that day, causing the upper bound to exclude all invoices
 * issued later that day. getLocalDayRange() converts local-calendar
 * day boundaries to UTC ISO timestamps so the full local day is covered.
 */

import { describe, it, expect } from "vitest";
import { getLocalDayRange } from "@/lib/format";

describe("getLocalDayRange", () => {
  it("dateFrom is midnight at the start of the local day", () => {
    const anchor = new Date(2026, 7, 10, 14, 30, 0); // Aug 10 2026 14:30 local
    const { dateFrom } = getLocalDayRange(anchor);
    const parsed = new Date(dateFrom);
    // midnight local
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7); // August (0-indexed)
    expect(parsed.getDate()).toBe(10);
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getMinutes()).toBe(0);
    expect(parsed.getSeconds()).toBe(0);
    expect(parsed.getMilliseconds()).toBe(0);
  });

  it("dateTo is 23:59:59.999 at the end of the local day", () => {
    const anchor = new Date(2026, 7, 10, 14, 30, 0);
    const { dateTo } = getLocalDayRange(anchor);
    const parsed = new Date(dateTo);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(10);
    expect(parsed.getHours()).toBe(23);
    expect(parsed.getMinutes()).toBe(59);
    expect(parsed.getSeconds()).toBe(59);
    expect(parsed.getMilliseconds()).toBe(999);
  });

  it("an invoice issued at midday falls within the range", () => {
    const anchor = new Date(2026, 7, 10, 9, 0, 0); // 9 AM local — simulates current time
    const { dateFrom, dateTo } = getLocalDayRange(anchor);
    const from = new Date(dateFrom).getTime();
    const to = new Date(dateTo).getTime();

    // Midday local — would be missed by a bare YYYY-MM-DD upper bound
    const middayInvoice = new Date(2026, 7, 10, 12, 0, 0).getTime();
    expect(middayInvoice).toBeGreaterThanOrEqual(from);
    expect(middayInvoice).toBeLessThanOrEqual(to);
  });

  it("an invoice from yesterday is excluded", () => {
    const anchor = new Date(2026, 7, 10, 9, 0, 0);
    const { dateFrom } = getLocalDayRange(anchor);
    const from = new Date(dateFrom).getTime();

    const yesterdayInvoice = new Date(2026, 7, 9, 23, 59, 59, 999).getTime();
    expect(yesterdayInvoice).toBeLessThan(from);
  });

  it("an invoice from tomorrow is excluded", () => {
    const anchor = new Date(2026, 7, 10, 9, 0, 0);
    const { dateTo } = getLocalDayRange(anchor);
    const to = new Date(dateTo).getTime();

    const tomorrowInvoice = new Date(2026, 7, 11, 0, 0, 0, 0).getTime();
    expect(tomorrowInvoice).toBeGreaterThan(to);
  });

  it("defaults to today when no argument is supplied", () => {
    const before = Date.now();
    const { dateFrom, dateTo } = getLocalDayRange();
    const after = Date.now();
    const from = new Date(dateFrom).getTime();
    const to = new Date(dateTo).getTime();

    // The range must bracket 'now'
    expect(from).toBeLessThanOrEqual(before);
    expect(to).toBeGreaterThanOrEqual(after);
  });
});
