/**
 * Tests for the mobile finance column totals (parity with the desktop
 * ColumnTotal header sums).
 *
 * Invariants protected:
 *  - sumAmounts treats null/undefined/non-numeric strings as 0 and includes
 *    negatives.
 *  - The Invoices list shows a Total and Balance sum of the currently
 *    displayed (filtered) rows, updating when filters change, and $0.00 when
 *    the list is empty.
 *  - The Statements list shows a Total sum of the displayed runs.
 *  - The ColumnTotals bar shows a placeholder while loading (never a stale
 *    or partial sum).
 */

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react-native";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";

import InvoicesScreen from "@/app/finance/invoices";
import StatementsScreen from "@/app/finance/statements";
import { ColumnTotals, sumAmounts } from "@/components/ui/ColumnTotals";

afterEach(() => {
  cleanup();
  resetMockAppState();
  vi.clearAllMocks();
});

describe("sumAmounts", () => {
  it("sums numbers and numeric strings", () => {
    expect(sumAmounts([100, "200.50", 0.5])).toBe(301);
  });

  it("treats null, undefined, and non-numeric strings as 0", () => {
    expect(sumAmounts([null, undefined, "abc", "", 25])).toBe(25);
  });

  it("includes negative amounts", () => {
    expect(sumAmounts(["-50.25", 100])).toBe(49.75);
  });

  it("returns 0 for an empty list", () => {
    expect(sumAmounts([])).toBe(0);
  });
});

describe("ColumnTotals component", () => {
  it("shows a placeholder while loading instead of a partial sum", () => {
    const { getByTestId } = render(
      <ColumnTotals
        loading
        items={[{ label: "Total", values: [100], testID: "ct-loading" }]}
      />,
    );
    expect(getByTestId("ct-loading").props.children).toBe("—");
  });

  it("formats the sum as money when loaded", () => {
    const { getByTestId } = render(
      <ColumnTotals
        items={[{ label: "Total", values: ["1000", null, "234.56"], testID: "ct-loaded" }]}
      />,
    );
    expect(getByTestId("ct-loaded").props.children).toBe("$1,234.56");
  });
});

function seedInvoices() {
  setMockAppState({
    invoices: [
      {
        id: "inv-open",
        invoiceNumber: "INV-26-104",
        status: "open",
        total: "100.00",
        balanceDue: "100.00",
        issuedAt: new Date().toISOString(),
        providerOrganization: { name: "Zenith Dental" },
      },
      {
        id: "inv-partial",
        invoiceNumber: "INV-26-103",
        status: "open",
        total: "200.00",
        balanceDue: "150.00",
        issuedAt: new Date().toISOString(),
        providerOrganization: { name: "Acme Dental" },
      },
      {
        id: "inv-paid",
        invoiceNumber: "INV-26-102",
        status: "paid",
        total: "300.00",
        balanceDue: "0.00",
        issuedAt: new Date().toISOString(),
        providerOrganization: { name: "Midtown Ortho" },
      },
      {
        // Null balance falls back to total (matches the desktop Balance column).
        id: "inv-draft",
        invoiceNumber: "INV-26-101",
        status: "draft",
        total: "50.00",
        balanceDue: null,
        issuedAt: null,
        providerOrganization: null,
      },
    ],
  });
}

describe("InvoicesScreen — column totals", () => {
  it("shows the Total and Balance sums of all displayed invoices", () => {
    seedInvoices();
    const { getByTestId } = render(<InvoicesScreen />);
    // Total: 100 + 200 + 300 + 50 = 650
    expect(getByTestId("column-total-total").props.children).toBe("$650.00");
    // Balance: 100 + 150 + 0 + 50 (null balanceDue falls back to total) = 300
    expect(getByTestId("column-total-balance").props.children).toBe("$300.00");
  });

  it("recomputes totals from only the filtered rows", () => {
    seedInvoices();
    const { getByTestId } = render(<InvoicesScreen />);
    fireEvent.press(getByTestId("filter-open"));
    // Open invoices: totals 100 + 200 = 300; balances 100 + 150 = 250
    expect(getByTestId("column-total-total").props.children).toBe("$300.00");
    expect(getByTestId("column-total-balance").props.children).toBe("$250.00");
  });

  it("shows $0.00 when no invoices are displayed", () => {
    setMockAppState({ invoices: [] });
    const { getByTestId } = render(<InvoicesScreen />);
    expect(getByTestId("column-total-total").props.children).toBe("$0.00");
    expect(getByTestId("column-total-balance").props.children).toBe("$0.00");
  });

  it("shows a placeholder instead of stale totals during a background refetch", () => {
    seedInvoices();
    setMockAppState({ invoicesIsFetching: true });
    const { getByTestId } = render(<InvoicesScreen />);
    expect(getByTestId("column-total-total").props.children).toBe("—");
    expect(getByTestId("column-total-balance").props.children).toBe("—");
  });
});

describe("StatementsScreen — column totals", () => {
  it("shows the Total sum of all displayed statement runs", () => {
    setMockAppState({
      meMemberships: [
        {
          organizationId: "lab-1",
          role: "owner",
          status: "active",
          organization: { id: "lab-1", type: "lab", name: "Main Lab" },
        },
      ],
      statementRuns: [
        { id: "run-1", practiceName: "Zenith Dental", totalAmount: "1200.00", status: "sent" },
        { id: "run-2", practiceName: "Acme Dental", totalAmount: 800.5, status: "sent" },
        { id: "run-3", practiceName: "Midtown Ortho", totalAmount: null, status: "failed" },
      ],
    });
    const { getByTestId } = render(<StatementsScreen />);
    expect(getByTestId("column-total-total").props.children).toBe("$2,000.50");
  });

  it("shows $0.00 when there are no statement runs", () => {
    setMockAppState({
      meMemberships: [
        {
          organizationId: "lab-1",
          role: "owner",
          status: "active",
          organization: { id: "lab-1", type: "lab", name: "Main Lab" },
        },
      ],
      statementRuns: [],
    });
    const { getByTestId } = render(<StatementsScreen />);
    expect(getByTestId("column-total-total").props.children).toBe("$0.00");
  });

  it("shows a placeholder instead of stale totals during a background refetch", () => {
    setMockAppState({
      meMemberships: [
        {
          organizationId: "lab-1",
          role: "owner",
          status: "active",
          organization: { id: "lab-1", type: "lab", name: "Main Lab" },
        },
      ],
      statementRuns: [
        { id: "run-1", practiceName: "Zenith Dental", totalAmount: "1200.00", status: "sent" },
      ],
      statementRunsIsFetching: true,
    });
    const { getByTestId } = render(<StatementsScreen />);
    expect(getByTestId("column-total-total").props.children).toBe("—");
  });
});
