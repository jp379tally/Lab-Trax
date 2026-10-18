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
import {
  mockStatementSummaryLabIds,
  resetMockAppState,
  setMockAppState,
} from "../../vitest.setup";

import InvoicesScreen from "@/app/finance/invoices";
import StatementsScreen from "@/app/finance/statements";
import { ColumnTotals, sumAmounts } from "@/components/ui/ColumnTotals";

afterEach(() => {
  cleanup();
  resetMockAppState();
  vi.clearAllMocks();
});

describe("sumAmounts", () => {
  it("sums numbers and numeric strings", async () => {
    expect(sumAmounts([100, "200.50", 0.5])).toBe(301);
  });

  it("treats null, undefined, and non-numeric strings as 0", async () => {
    expect(sumAmounts([null, undefined, "abc", "", 25])).toBe(25);
  });

  it("includes negative amounts", async () => {
    expect(sumAmounts(["-50.25", 100])).toBe(49.75);
  });

  it("returns 0 for an empty list", async () => {
    expect(sumAmounts([])).toBe(0);
  });
});

describe("ColumnTotals component", () => {
  it("shows a placeholder while loading instead of a partial sum", async () => {
    const { getByTestId } = await render(
      <ColumnTotals
        loading
        items={[{ label: "Total", values: [100], testID: "ct-loading" }]}
      />,
    );
    expect(getByTestId("ct-loading").props.children).toBe("—");
  });

  it("formats the sum as money when loaded", async () => {
    const { getByTestId } = await render(
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
  it("shows the Total and Balance sums of all displayed invoices", async () => {
    seedInvoices();
    const { getByTestId } = await render(<InvoicesScreen />);
    // Total: 100 + 200 + 300 + 50 = 650
    expect(getByTestId("column-total-total").props.children).toBe("$650.00");
    // Balance: 100 + 150 + 0 + 50 (null balanceDue falls back to total) = 300
    expect(getByTestId("column-total-balance").props.children).toBe("$300.00");
  });

  it("recomputes totals from only the filtered rows", async () => {
    seedInvoices();
    const { getByTestId } = await render(<InvoicesScreen />);
    await fireEvent.press(getByTestId("view-open"));
    // Open invoices: totals 100 + 200 = 300; balances 100 + 150 = 250
    expect(getByTestId("column-total-total").props.children).toBe("$300.00");
    expect(getByTestId("column-total-balance").props.children).toBe("$250.00");
  });

  it("shows $0.00 when no invoices are displayed", async () => {
    setMockAppState({ invoices: [] });
    const { getByTestId } = await render(<InvoicesScreen />);
    expect(getByTestId("column-total-total").props.children).toBe("$0.00");
    expect(getByTestId("column-total-balance").props.children).toBe("$0.00");
  });

  it("shows a placeholder instead of stale totals during a background refetch", async () => {
    seedInvoices();
    setMockAppState({ invoicesIsFetching: true });
    const { getByTestId } = await render(<InvoicesScreen />);
    expect(getByTestId("column-total-total").props.children).toBe("—");
    expect(getByTestId("column-total-balance").props.children).toBe("—");
  });
});

describe("StatementsScreen — column totals", () => {
  it("requests paged statement account summaries for the selected lab", async () => {
    setMockAppState({
      meMemberships: [
        {
          organizationId: "lab-1",
          role: "owner",
          status: "active",
          organization: { id: "lab-1", type: "lab", name: "Main Lab" },
        },
      ],
    });
    await render(<StatementsScreen />);
    expect(mockStatementSummaryLabIds.calls.at(-1)).toBe("lab-1");
  });

  it("shows the total open balance of all displayed practice summaries", async () => {
    setMockAppState({
      meMemberships: [
        {
          organizationId: "lab-1",
          role: "owner",
          status: "active",
          organization: { id: "lab-1", type: "lab", name: "Main Lab" },
        },
      ],
      statementAccountSummaries: [
        { practiceId: "p-1", practiceName: "Zenith Dental", billingEmail: "billing@zenith.test", openInvoiceCount: 1, openInvoiceTotal: 200, unpaidStatements: [{ id: "s-1", date: "2026-08-01T00:00:00.000Z", remainingBalance: 1000 }], totalOpenBalance: 1200, overdueBalance: 1000 },
        { practiceId: "p-2", practiceName: "Acme Dental", billingEmail: null, openInvoiceCount: 2, openInvoiceTotal: 800.5, unpaidStatements: [], totalOpenBalance: 800.5, overdueBalance: 0 },
      ],
    });
    const { getByTestId, getByText, getAllByText } = await render(<StatementsScreen />);
    expect(getByTestId("column-total-total").props.children).toBe("$2,000.50");
    expect(getByText("billing@zenith.test")).toBeTruthy();
    expect(getByText("No email on file.")).toBeTruthy();
    expect(getAllByText("$1,000.00")).toHaveLength(2);
  });

  it("shows $0.00 when there are no statement runs", async () => {
    setMockAppState({
      meMemberships: [
        {
          organizationId: "lab-1",
          role: "owner",
          status: "active",
          organization: { id: "lab-1", type: "lab", name: "Main Lab" },
        },
      ],
      statementAccountSummaries: [],
    });
    const { getByTestId } = await render(<StatementsScreen />);
    expect(getByTestId("column-total-total").props.children).toBe("$0.00");
  });

  it("shows a placeholder instead of stale totals during a background refetch", async () => {
    setMockAppState({
      meMemberships: [
        {
          organizationId: "lab-1",
          role: "owner",
          status: "active",
          organization: { id: "lab-1", type: "lab", name: "Main Lab" },
        },
      ],
      statementAccountSummaries: [
        { practiceId: "p-1", practiceName: "Zenith Dental", billingEmail: null, openInvoiceCount: 0, openInvoiceTotal: 0, unpaidStatements: [], totalOpenBalance: 1200, overdueBalance: 0 },
      ],
      statementAccountSummariesIsFetching: true,
    });
    const { getByTestId } = await render(<StatementsScreen />);
    expect(getByTestId("column-total-total").props.children).toBe("—");
  });
});
