/**
 * Screen tests for the mobile Invoices list filters.
 *
 * Invariants protected:
 *  - Status pills (All / Open / Closed / Past Due / Frozen) filter the list.
 *  - The date chip opens a sheet whose options filter by issued date, and
 *    the custom range applies only valid from/to dates.
 *  - The sort toggle re-orders rows by customer name and back.
 */

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, within } from "@testing-library/react-native";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";

import InvoicesScreen from "@/app/finance/invoices";

const NOW = new Date();
function daysAgo(n: number): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n, 10).toISOString();
}

function seedInvoices() {
  setMockAppState({
    invoices: [
      {
        id: "open-today",
        invoiceNumber: "INV-26-104",
        status: "open",
        total: "100.00",
        balanceDue: "100.00",
        issuedAt: daysAgo(0),
        dueAt: daysAgo(-30),
        providerOrganization: { name: "Zenith Dental" },
      },
      {
        id: "overdue-old",
        invoiceNumber: "INV-26-103",
        status: "open",
        total: "200.00",
        balanceDue: "150.00",
        issuedAt: daysAgo(60),
        dueAt: daysAgo(10),
        providerOrganization: { name: "Acme Dental" },
      },
      {
        id: "paid-yesterday",
        invoiceNumber: "INV-26-102",
        status: "paid",
        total: "300.00",
        balanceDue: "0.00",
        issuedAt: daysAgo(1),
        providerOrganization: { name: "Midtown Ortho" },
      },
      {
        id: "frozen-draft",
        invoiceNumber: "INV-26-101",
        status: "draft",
        total: "50.00",
        issuedAt: null,
        frozen: true,
        providerOrganization: null,
      },
    ],
  });
}

afterEach(() => {
  cleanup();
  resetMockAppState();
  vi.clearAllMocks();
});

function visibleInvoiceIds(queryAllByTestId: (m: RegExp) => Array<{ props: { testID?: string } }>) {
  return queryAllByTestId(/^invoice-/).map((n) => n.props.testID);
}

describe("InvoicesScreen — status filters", () => {
  it("shows all invoices by default and filters Open / Closed / Past Due / Frozen", () => {
    seedInvoices();
    const screen = render(<InvoicesScreen />);
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toEqual([
      "invoice-open-today",
      "invoice-overdue-old",
      "invoice-paid-yesterday",
      "invoice-frozen-draft",
    ]);

    fireEvent.press(screen.getByTestId("filter-open"));
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toEqual([
      "invoice-open-today",
      "invoice-overdue-old",
    ]);

    fireEvent.press(screen.getByTestId("filter-closed"));
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toEqual(["invoice-paid-yesterday"]);

    fireEvent.press(screen.getByTestId("filter-pastdue"));
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toEqual(["invoice-overdue-old"]);

    fireEvent.press(screen.getByTestId("filter-frozen"));
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toEqual(["invoice-frozen-draft"]);

    fireEvent.press(screen.getByTestId("filter-all"));
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toHaveLength(4);
  });
});

describe("InvoicesScreen — date filter sheet", () => {
  it("filters by Today and Yesterday via the date sheet", () => {
    seedInvoices();
    const screen = render(<InvoicesScreen />);

    fireEvent.press(screen.getByTestId("filter-date"));
    fireEvent.press(screen.getByTestId("date-option-today"));
    fireEvent.press(screen.getByText("Apply"));
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toEqual(["invoice-open-today"]);

    fireEvent.press(screen.getByTestId("filter-date"));
    fireEvent.press(screen.getByTestId("date-option-yesterday"));
    fireEvent.press(screen.getByText("Apply"));
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toEqual(["invoice-paid-yesterday"]);
  });

  it("excludes undated drafts when a date filter is active and shows the filtered empty state", () => {
    seedInvoices();
    const screen = render(<InvoicesScreen />);

    // Frozen draft has no issuedAt/createdAt → excluded under any date range.
    fireEvent.press(screen.getByTestId("filter-frozen"));
    fireEvent.press(screen.getByTestId("filter-date"));
    fireEvent.press(screen.getByTestId("date-option-today"));
    fireEvent.press(screen.getByText("Apply"));
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toEqual([]);
    expect(screen.getByText("No invoices match your filters.")).toBeTruthy();
  });

  it("applies a valid custom range via the calendar and keeps Apply disabled for an inverted range", () => {
    seedInvoices();
    const screen = render(<InvoicesScreen />);

    fireEvent.press(screen.getByTestId("filter-date"));
    fireEvent.press(screen.getByTestId("date-option-custom"));

    // The custom range is now picked with calendars (not typed text). Both
    // pickers default to the current month, so days 1..lastDay are available.
    const lastDay = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 0).getDate();

    // Each picker's internal controls are uniquely addressable (namespaced by
    // the trigger testID) so the two mounted calendars never collide.
    expect(screen.getByTestId("custom-date-start-clear")).toBeTruthy();
    expect(screen.getByTestId("custom-date-end-clear")).toBeTruthy();

    // Inverted range first (From = last day, To = 1st): Apply must be a no-op.
    fireEvent.press(screen.getByTestId("custom-date-start"));
    fireEvent.press(screen.getByTestId(`custom-date-start-day-${lastDay}`));
    fireEvent.press(screen.getByTestId("custom-date-end"));
    fireEvent.press(screen.getByTestId("custom-date-end-day-1"));
    fireEvent.press(screen.getByText("Apply"));
    // Sheet still open (Apply disabled) — the options are still rendered.
    expect(screen.getByTestId("date-option-custom")).toBeTruthy();
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toHaveLength(4);

    // Valid range = the whole current month (1st → last day). This always
    // includes the invoice issued today and excludes the one issued ~60 days
    // ago and the undated frozen draft, regardless of the current date.
    fireEvent.press(screen.getByTestId("custom-date-start"));
    fireEvent.press(screen.getByTestId("custom-date-start-day-1"));
    fireEvent.press(screen.getByTestId("custom-date-end"));
    fireEvent.press(screen.getByTestId(`custom-date-end-day-${lastDay}`));
    fireEvent.press(screen.getByText("Apply"));
    const ids = visibleInvoiceIds(screen.queryAllByTestId);
    expect(ids).toContain("invoice-open-today");
    expect(ids).not.toContain("invoice-overdue-old");
    expect(ids).not.toContain("invoice-frozen-draft");
  });

  it('filters to the current month via the "This month" option', () => {
    seedInvoices();
    const screen = render(<InvoicesScreen />);

    fireEvent.press(screen.getByTestId("filter-date"));
    fireEvent.press(screen.getByTestId("date-option-this_month"));
    fireEvent.press(screen.getByText("Apply"));
    const ids = visibleInvoiceIds(screen.queryAllByTestId);
    expect(ids).toContain("invoice-open-today");
    expect(ids).not.toContain("invoice-overdue-old");
    expect(ids).not.toContain("invoice-frozen-draft");
  });
});

describe("InvoicesScreen — sort by customer", () => {
  it("toggles between server order and customer name order", () => {
    seedInvoices();
    const screen = render(<InvoicesScreen />);

    fireEvent.press(screen.getByTestId("sort-toggle"));
    // Acme < Midtown < Zenith, unnamed (frozen draft) last.
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toEqual([
      "invoice-overdue-old",
      "invoice-paid-yesterday",
      "invoice-open-today",
      "invoice-frozen-draft",
    ]);

    fireEvent.press(screen.getByTestId("sort-toggle"));
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toEqual([
      "invoice-open-today",
      "invoice-overdue-old",
      "invoice-paid-yesterday",
      "invoice-frozen-draft",
    ]);
  });

  it("shows the customer name on invoice rows", () => {
    seedInvoices();
    const screen = render(<InvoicesScreen />);
    const row = screen.getByTestId("invoice-open-today");
    expect(within(row).getByText("Zenith Dental")).toBeTruthy();
  });
});
