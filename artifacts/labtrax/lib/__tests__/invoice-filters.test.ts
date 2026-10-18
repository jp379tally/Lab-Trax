import { describe, expect, it } from "vitest";
import type { CanonicalInvoice } from "@workspace/api-client-react";
import {
  INVOICE_FILTER_PARITY_CASES,
  INVOICE_FILTER_PARITY_NOW as NOW,
  INVOICE_FILTER_PARITY_ROWS as rows,
  invoiceFilterParityInvoice as invoice,
} from "@workspace/api-client-react/invoice-filter-test-fixtures";
import {
  dateRangeForFilter,
  formatInvoiceIssueDate,
  filterAndSortInvoices,
  matchesOverdueFilter,
  parseDateInput,
  matchesDateRange,
} from "../invoice-filters";

describe("invoice filter parity", () => {
  it.each(INVOICE_FILTER_PARITY_CASES)("$name", ({ options, expectedIds }) => {
    expect(filterAndSortInvoices(rows, options, NOW).map((row) => row.id))
      .toEqual(expectedIds);
  });

  it("Open includes open and partially paid; Outstanding additionally requires a past due date", async () => {
    expect(filterAndSortInvoices(rows, { view: "open", statuses: [], date: "all" }, NOW).map((r) => r.id))
      .toEqual(["open-past", "partial-past"]);
    expect(filterAndSortInvoices(rows, { view: "outstanding", statuses: ["paid"], overdue: "0_30", date: "all" }, NOW).map((r) => r.id))
      .toEqual(["open-past", "partial-past"]);
  });

  it("unions Paid, Void, Frozen, and $0 balance status selections", async () => {
    expect(filterAndSortInvoices(rows, { statuses: ["paid", "frozen"], date: "all" }, NOW).map((r) => r.id))
      .toEqual(["void-zero", "paid-zero"]);
    expect(filterAndSortInvoices(rows, { statuses: ["zero_balance"], date: "all" }, NOW).map((r) => r.id))
      .toEqual(["void-zero", "paid-zero"]);
  });

  it("combines search, practice, doctor, AI-only, and issued date with AND semantics", async () => {
    const result = filterAndSortInvoices(rows, {
      search: "amy", practiceId: "p2", doctorName: "Dr Z", aiOnly: true, date: "today",
    }, NOW);
    expect(result.map((r) => r.id)).toEqual(["open-past"]);
  });

  it("uses inclusive custom issued-date boundaries for both date controls", async () => {
    const sameDay = new Date(2026, 6, 7);
    expect(dateRangeForFilter("custom", NOW, sameDay, sameDay)?.end.getTime())
      .toBe(Date.UTC(2026, 6, 8));
    expect(matchesOverdueFilter(rows[0], "custom", NOW, new Date(2026, 6, 7), new Date(2026, 6, 7))).toBe(true);
  });

  it("matches UTC midnight and noon by issue day, with created-date fallback", () => {
    const day = new Date(2026, 0, 1);
    const range = dateRangeForFilter("custom", day, day, day)!;
    expect(range.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    for (const time of ["2026-01-01T00:00:00.000Z", "2026-01-01T12:00:00.000Z"]) {
      expect(matchesDateRange(invoice("inside", { issuedAt: time }), range)).toBe(true);
      expect(formatInvoiceIssueDate(time)).toBe("01/01/2026");
    }
    expect(matchesDateRange(invoice("before", { issuedAt: "2025-12-31T23:59:59.999Z" }), range)).toBe(false);
    expect(matchesDateRange(invoice("after", { issuedAt: "2026-01-02T00:00:00.000Z" }), range)).toBe(false);
    expect(matchesDateRange(invoice("fallback", { issuedAt: null, createdAt: "2026-01-01T23:59:00Z" }), range)).toBe(true);
    expect(formatInvoiceIssueDate("2026-01-01T00:00:00+09:00")).toBe("12/31/2025");
  });

  it.each([
    ["America/Los_Angeles", "2026-02-28"],
    ["Asia/Tokyo", "2026-03-01"],
  ])("uses local labels and UTC-day bounds in %s", (zone, selectedDay) => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = zone;
      const now = new Date("2026-03-01T01:00:00.000Z");
      const range = dateRangeForFilter("today", now)!;
      expect(range.start.toISOString().slice(0, 10)).toBe(selectedDay);
      expect(matchesDateRange(invoice("midnight", { issuedAt: range.start.toISOString() }), range)).toBe(true);
      expect(matchesDateRange(invoice("next", { issuedAt: range.end.toISOString() }), range)).toBe(false);
      expect(dateRangeForFilter("yesterday", now)!.end).toEqual(range.start);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("pins aging bucket boundaries and excludes zero balances", async () => {
    expect(matchesOverdueFilter(invoice("d30", { dueAt: new Date(2026, 5, 7).toISOString() }), "0_30", NOW)).toBe(true);
    expect(matchesOverdueFilter(invoice("d31", { dueAt: new Date(2026, 5, 6).toISOString() }), "31_60", NOW)).toBe(true);
    expect(matchesOverdueFilter(invoice("zero", { dueAt: new Date(2026, 5, 6).toISOString(), balanceDue: 0 }), "31_60", NOW)).toBe(false);
    expect(matchesOverdueFilter(invoice("frozen", { dueAt: new Date(2026, 5, 6).toISOString(), frozen: true }), "31_60", NOW)).toBe(false);
  });

  it("compares Outstanding by ISO calendar date without timezone shifts", async () => {
    const dueTodayUtc = invoice("today", { dueAt: "2026-07-07T00:00:00.000Z" });
    expect(filterAndSortInvoices([dueTodayUtc], { view: "outstanding", date: "all" }, NOW)).toEqual([]);
  });

  it("sorts all three fields in both directions", async () => {
    for (const field of ["practice", "issued", "due"] as const) {
      const asc = filterAndSortInvoices(rows, { date: "all", sort: field, sortDirection: "asc" }, NOW);
      const desc = filterAndSortInvoices(rows, { date: "all", sort: field, sortDirection: "desc" }, NOW);
      const value = (row: CanonicalInvoice) => field === "practice"
        ? row.providerOrganization?.name ?? ""
        : field === "issued" ? row.issuedAt ?? "" : row.dueAt ?? "";
      expect(value(asc[0]).localeCompare(value(asc.at(-1)!))).toBeLessThanOrEqual(0);
      expect(value(desc[0]).localeCompare(value(desc.at(-1)!))).toBeGreaterThanOrEqual(0);
    }
  });

  it("validates typed custom dates", async () => {
    expect(parseDateInput("2026-07-07")).toEqual(new Date(2026, 6, 7));
    expect(parseDateInput("02/30/2026")).toBeNull();
  });
});