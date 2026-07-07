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

  it("applies a valid custom range and keeps Apply disabled for an inverted range", () => {
    seedInvoices();
    const screen = render(<InvoicesScreen />);

    fireEvent.press(screen.getByTestId("filter-date"));
    fireEvent.press(screen.getByTestId("date-option-custom"));

    const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    const start = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 15);
    const end = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 5);

    // Inverted range first: Apply must not change the list.
    fireEvent.changeText(screen.getByTestId("custom-date-start"), fmt(end));
    fireEvent.changeText(screen.getByTestId("custom-date-end"), fmt(start));
    fireEvent.press(screen.getByText("Apply"));
    // Sheet still open (Apply disabled) — the options are still rendered.
    expect(screen.getByTestId("date-option-custom")).toBeTruthy();
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toHaveLength(4);

    // Valid range including only the overdue invoice's due window (issued 60d
    // ago is outside; paid-yesterday outside; only dueAt-10d invoice's issue
    // date of 60d ago is outside too — pick a range around day-10 issue dates).
    fireEvent.changeText(screen.getByTestId("custom-date-start"), fmt(start));
    fireEvent.changeText(screen.getByTestId("custom-date-end"), fmt(end));
    fireEvent.press(screen.getByText("Apply"));
    // No invoice was issued 5–15 days ago → filtered empty state.
    expect(visibleInvoiceIds(screen.queryAllByTestId)).toEqual([]);
    expect(screen.getByText("No invoices match your filters.")).toBeTruthy();
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
