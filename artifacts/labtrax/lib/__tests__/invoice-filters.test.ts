/**
 * Unit tests for the mobile invoice list filter/sort helpers.
 *
 * Invariants protected:
 *  - Status semantics match desktop parity: Open = open|partially_paid,
 *    Closed = paid|void, Past Due = open-ish AND dueAt before today.
 *  - Date-range resolution for every preset (today, yesterday, last week,
 *    last month, last year, this year, YTD, custom) uses local time with an
 *    inclusive start / exclusive end.
 *  - Custom-date parsing accepts MM/DD/YYYY and YYYY-MM-DD and rejects
 *    rollover dates (Feb 30).
 *  - Sorting by customer is a stable, case-insensitive name sort with
 *    unnamed customers last; the default sort preserves server order.
 */

import { describe, it, expect } from "vitest";
import type { CanonicalInvoice } from "@workspace/api-client-react";
import {
  matchesStatusFilter,
  dateRangeForFilter,
  parseDateInput,
  invoiceFilterDate,
  matchesDateRange,
  filterAndSortInvoices,
  customerNameOf,
} from "../invoice-filters";

// A fixed "now": Tuesday, July 7, 2026 local time.
const NOW = new Date(2026, 6, 7, 14, 30, 0);

function inv(overrides: Partial<CanonicalInvoice>): CanonicalInvoice {
  return {
    id: overrides.id ?? "inv-1",
    invoiceNumber: overrides.invoiceNumber ?? "INV-26-1",
    status: overrides.status ?? "open",
    ...overrides,
  } as CanonicalInvoice;
}

describe("matchesStatusFilter", () => {
  it("all matches everything", () => {
    for (const status of ["draft", "open", "partially_paid", "paid", "void"]) {
      expect(matchesStatusFilter(inv({ status }), "all", NOW)).toBe(true);
    }
  });

  it("open matches open and partially_paid only", () => {
    expect(matchesStatusFilter(inv({ status: "open" }), "open", NOW)).toBe(true);
    expect(matchesStatusFilter(inv({ status: "partially_paid" }), "open", NOW)).toBe(true);
    expect(matchesStatusFilter(inv({ status: "draft" }), "open", NOW)).toBe(false);
    expect(matchesStatusFilter(inv({ status: "paid" }), "open", NOW)).toBe(false);
    expect(matchesStatusFilter(inv({ status: "void" }), "open", NOW)).toBe(false);
  });

  it("closed matches paid and void only", () => {
    expect(matchesStatusFilter(inv({ status: "paid" }), "closed", NOW)).toBe(true);
    expect(matchesStatusFilter(inv({ status: "void" }), "closed", NOW)).toBe(true);
    expect(matchesStatusFilter(inv({ status: "open" }), "closed", NOW)).toBe(false);
    expect(matchesStatusFilter(inv({ status: "draft" }), "closed", NOW)).toBe(false);
  });

  it("pastdue requires an open-ish status AND a due date before today", () => {
    const yesterday = new Date(2026, 6, 6).toISOString();
    const tomorrow = new Date(2026, 6, 8).toISOString();
    expect(matchesStatusFilter(inv({ status: "open", dueAt: yesterday }), "pastdue", NOW)).toBe(true);
    expect(
      matchesStatusFilter(inv({ status: "partially_paid", dueAt: yesterday }), "pastdue", NOW),
    ).toBe(true);
    // Due later today / in the future is NOT past due.
    expect(matchesStatusFilter(inv({ status: "open", dueAt: tomorrow }), "pastdue", NOW)).toBe(false);
    expect(
      matchesStatusFilter(inv({ status: "open", dueAt: new Date(2026, 6, 7, 9).toISOString() }), "pastdue", NOW),
    ).toBe(false);
    // Paid invoices are never past due, no matter the due date.
    expect(matchesStatusFilter(inv({ status: "paid", dueAt: yesterday }), "pastdue", NOW)).toBe(false);
    // No due date at all → not past due.
    expect(matchesStatusFilter(inv({ status: "open", dueAt: null }), "pastdue", NOW)).toBe(false);
  });

  it("frozen matches the frozen flag", () => {
    expect(matchesStatusFilter(inv({ frozen: true }), "frozen", NOW)).toBe(true);
    expect(matchesStatusFilter(inv({ frozen: false }), "frozen", NOW)).toBe(false);
    expect(matchesStatusFilter(inv({}), "frozen", NOW)).toBe(false);
  });
});

describe("parseDateInput", () => {
  it("accepts MM/DD/YYYY and YYYY-MM-DD", () => {
    expect(parseDateInput("7/4/2026")?.getTime()).toBe(new Date(2026, 6, 4).getTime());
    expect(parseDateInput("07/04/2026")?.getTime()).toBe(new Date(2026, 6, 4).getTime());
    expect(parseDateInput("2026-07-04")?.getTime()).toBe(new Date(2026, 6, 4).getTime());
  });

  it("rejects garbage and rollover dates", () => {
    expect(parseDateInput("")).toBeNull();
    expect(parseDateInput("hello")).toBeNull();
    expect(parseDateInput("13/01/2026")).toBeNull();
    expect(parseDateInput("02/30/2026")).toBeNull();
  });
});

describe("dateRangeForFilter", () => {
  it("all → null (no filtering)", () => {
    expect(dateRangeForFilter("all", NOW)).toBeNull();
  });

  it("today covers local midnight to next midnight", () => {
    const r = dateRangeForFilter("today", NOW)!;
    expect(r.start.getTime()).toBe(new Date(2026, 6, 7).getTime());
    expect(r.end.getTime()).toBe(new Date(2026, 6, 8).getTime());
  });

  it("yesterday covers the previous local day", () => {
    const r = dateRangeForFilter("yesterday", NOW)!;
    expect(r.start.getTime()).toBe(new Date(2026, 6, 6).getTime());
    expect(r.end.getTime()).toBe(new Date(2026, 6, 7).getTime());
  });

  it("last_week covers the previous Sunday–Saturday calendar week", () => {
    // July 7 2026 is a Tuesday; this week started Sunday July 5.
    const r = dateRangeForFilter("last_week", NOW)!;
    expect(r.start.getTime()).toBe(new Date(2026, 5, 28).getTime()); // Sun Jun 28
    expect(r.end.getTime()).toBe(new Date(2026, 6, 5).getTime()); // Sun Jul 5 (exclusive)
  });

  it("last_month covers the previous calendar month", () => {
    const r = dateRangeForFilter("last_month", NOW)!;
    expect(r.start.getTime()).toBe(new Date(2026, 5, 1).getTime());
    expect(r.end.getTime()).toBe(new Date(2026, 6, 1).getTime());
  });

  it("last_year covers the previous calendar year", () => {
    const r = dateRangeForFilter("last_year", NOW)!;
    expect(r.start.getTime()).toBe(new Date(2025, 0, 1).getTime());
    expect(r.end.getTime()).toBe(new Date(2026, 0, 1).getTime());
  });

  it("this_year covers the whole current calendar year", () => {
    const r = dateRangeForFilter("this_year", NOW)!;
    expect(r.start.getTime()).toBe(new Date(2026, 0, 1).getTime());
    expect(r.end.getTime()).toBe(new Date(2027, 0, 1).getTime());
  });

  it("ytd covers Jan 1 through the end of today", () => {
    const r = dateRangeForFilter("ytd", NOW)!;
    expect(r.start.getTime()).toBe(new Date(2026, 0, 1).getTime());
    expect(r.end.getTime()).toBe(new Date(2026, 6, 8).getTime());
  });

  it("custom uses inclusive start and end days; invalid/inverted → null", () => {
    const r = dateRangeForFilter("custom", NOW, new Date(2026, 6, 1), new Date(2026, 6, 3))!;
    expect(r.start.getTime()).toBe(new Date(2026, 6, 1).getTime());
    expect(r.end.getTime()).toBe(new Date(2026, 6, 4).getTime()); // end day is inclusive
    expect(dateRangeForFilter("custom", NOW, null, new Date(2026, 6, 3))).toBeNull();
    expect(dateRangeForFilter("custom", NOW, new Date(2026, 6, 5), new Date(2026, 6, 3))).toBeNull();
    // Same start and end day = that single day.
    const single = dateRangeForFilter("custom", NOW, new Date(2026, 6, 2), new Date(2026, 6, 2))!;
    expect(single.start.getTime()).toBe(new Date(2026, 6, 2).getTime());
    expect(single.end.getTime()).toBe(new Date(2026, 6, 3).getTime());
  });
});

describe("invoiceFilterDate + matchesDateRange", () => {
  it("uses issuedAt when present, falls back to createdAt (drafts)", () => {
    const issued = new Date(2026, 6, 2).toISOString();
    const created = new Date(2026, 6, 1).toISOString();
    expect(invoiceFilterDate(inv({ issuedAt: issued, createdAt: created }))!.getTime()).toBe(
      new Date(issued).getTime(),
    );
    expect(invoiceFilterDate(inv({ issuedAt: null, createdAt: created }))!.getTime()).toBe(
      new Date(created).getTime(),
    );
    expect(invoiceFilterDate(inv({ issuedAt: null }))).toBeNull();
  });

  it("undated invoices are excluded when a range is active but included on 'all'", () => {
    const undated = inv({ issuedAt: null });
    expect(matchesDateRange(undated, null)).toBe(true);
    const r = dateRangeForFilter("today", NOW)!;
    expect(matchesDateRange(undated, r)).toBe(false);
  });
});

describe("filterAndSortInvoices", () => {
  const invoices: CanonicalInvoice[] = [
    inv({
      id: "a",
      invoiceNumber: "INV-26-3",
      status: "open",
      issuedAt: new Date(2026, 6, 7, 8).toISOString(),
      dueAt: new Date(2026, 6, 20).toISOString(),
      providerOrganization: { name: "Bright Smiles" },
    }),
    inv({
      id: "b",
      invoiceNumber: "INV-26-2",
      status: "paid",
      issuedAt: new Date(2026, 5, 15).toISOString(),
      providerOrganization: { name: "acme dental" },
    }),
    inv({
      id: "c",
      invoiceNumber: "INV-26-1",
      status: "open",
      issuedAt: new Date(2026, 5, 10).toISOString(),
      dueAt: new Date(2026, 6, 1).toISOString(),
      providerOrganization: null,
    }),
  ];

  it("combines status + date filters", () => {
    const out = filterAndSortInvoices(
      invoices,
      { status: "open", date: "last_month", sort: "newest" },
      NOW,
    );
    expect(out.map((i) => i.id)).toEqual(["c"]);
  });

  it("pastdue picks only overdue open invoices", () => {
    const out = filterAndSortInvoices(invoices, { status: "pastdue", date: "all", sort: "newest" }, NOW);
    expect(out.map((i) => i.id)).toEqual(["c"]);
  });

  it("default sort preserves server order", () => {
    const out = filterAndSortInvoices(invoices, { status: "all", date: "all", sort: "newest" }, NOW);
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("customer sort is case-insensitive with unnamed customers last", () => {
    const out = filterAndSortInvoices(invoices, { status: "all", date: "all", sort: "customer" }, NOW);
    expect(out.map((i) => i.id)).toEqual(["b", "a", "c"]); // acme < Bright, unnamed last
  });

  it("customerNameOf prefers displayName over name", () => {
    expect(customerNameOf(inv({ providerOrganization: { name: "N", displayName: "D" } }))).toBe("D");
    expect(customerNameOf(inv({ providerOrganization: { name: "N" } }))).toBe("N");
    expect(customerNameOf(inv({ providerOrganization: null }))).toBe("");
  });
});
