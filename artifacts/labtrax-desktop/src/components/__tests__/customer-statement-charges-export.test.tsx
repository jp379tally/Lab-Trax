/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Organization } from "@/lib/types";

const apiFetchMock = vi.fn();
const downloadCsvMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

vi.mock("@/lib/export", () => ({
  downloadCsv: (...args: unknown[]) => downloadCsvMock(...args),
  safeFilename: (name: string) => name.replace(/[^a-z0-9-_]+/gi, "_"),
}));

import { CustomerStatementChargesTab } from "@/components/customer-detail-tabs";

const selected = {
  id: "provider-1",
  name: "Bright Smiles",
  displayName: "Bright Smiles Dental",
} as Organization;

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CustomerStatementChargesTab selected={selected} labOrgId="lab-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  downloadCsvMock.mockReset();
});

describe("CustomerStatementChargesTab CSV export", () => {
  it("exports authorized ledger rows in their current chronological order", async () => {
    apiFetchMock.mockResolvedValue({
      rows: [
        {
          id: "invoice:inv-1",
          date: "2026-08-01T12:00:00.000Z",
          type: "invoice",
          typeLabel: "Invoice",
          invoiceNumber: "INV-100",
          doctorName: "Dr. Rivera",
          patientName: "Alex Smith",
          invoiceAmount: "125.00",
          paymentAmount: null,
          balance: "125.00",
          openBalance: "125.00",
        },
        {
          id: "payment:pay-1",
          date: "2026-08-02T12:00:00.000Z",
          type: "payment",
          typeLabel: "Payment",
          invoiceNumber: "INV-100",
          doctorName: "Dr. Rivera",
          patientName: "Alex Smith",
          invoiceAmount: "125.00",
          paymentAmount: "25.00",
          paymentMethod: "check",
          referenceNumber: "CHK-88",
          balance: "100.00",
          openBalance: "100.00",
        },
      ],
    });
    renderTab();

    const button = await screen.findByTestId("button-export-statement-charges");
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      "/billing/lab-1/accounts/provider-1/statement-charges?limit=10&offset=0",
    ));
    await waitFor(() => expect(downloadCsvMock).toHaveBeenCalledWith(
      expect.stringMatching(/^statement-charge-history-Bright_Smiles_Dental-\d{4}-\d{2}-\d{2}\.csv$/),
      [
        {
          Date: "2026-08-01T12:00:00.000Z",
          "Row Type": "Invoice",
          "Invoice Number": "INV-100",
          Doctor: "Dr. Rivera",
          Patient: "Alex Smith",
          "Invoice Amount": "125.00",
          "Payment Amount": "",
          "Payment Method": "",
          Reference: "",
          Statement: "",
          Balance: "125.00",
        },
        {
          Date: "2026-08-02T12:00:00.000Z",
          "Row Type": "Payment",
          "Invoice Number": "INV-100",
          Doctor: "Dr. Rivera",
          Patient: "Alex Smith",
          "Invoice Amount": "125.00",
          "Payment Amount": "25.00",
          "Payment Method": "Check",
          Reference: "CHK-88",
          Statement: "",
          Balance: "100.00",
        },
      ],
    ));
  });

  it("shows and exports a payment covering several invoices as one row", async () => {
    // One payment from the practice settles many invoices. The ledger reports
    // the payment itself, so the row carries the payment's identity — method,
    // receipt, statement — instead of borrowing one invoice's details.
    apiFetchMock.mockResolvedValue({
      rows: [
        {
          id: "payment-session:sess-1",
          date: "2026-08-05T12:00:00.000Z",
          type: "payment",
          typeLabel: "Payment (3 invoices)",
          invoiceCount: 3,
          invoiceNumber: null,
          doctorName: "Dr. Rivera",
          patientName: null,
          invoiceAmount: null,
          paymentAmount: "450.00",
          paymentMethod: "check",
          referenceNumber: "RCPT-2210",
          statementId: "stmt-1",
          statementLabel: "07-2026",
          balance: "0.00",
          openBalance: "0.00",
        },
      ],
    });
    renderTab();

    expect(await screen.findByText("Payment (3 invoices)")).toBeInTheDocument();
    expect(screen.getByText(/Check · RCPT-2210 · Statement 07-2026/)).toBeInTheDocument();

    const button = screen.getByTestId("button-export-statement-charges");
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() => expect(downloadCsvMock.mock.calls.at(-1)?.[1]).toEqual([
      {
        Date: "2026-08-05T12:00:00.000Z",
        "Row Type": "Payment (3 invoices)",
        "Invoice Number": "",
        Doctor: "Dr. Rivera",
        Patient: "",
        "Invoice Amount": "",
        "Payment Amount": "450.00",
        "Payment Method": "Check",
        Reference: "RCPT-2210",
        Statement: "07-2026",
        Balance: "0.00",
      },
    ]));
  });

  it("shows an empty message and does not create a blank download", async () => {
    apiFetchMock.mockResolvedValue({ rows: [] });
    renderTab();

    expect(await screen.findByTestId("status-statement-charges-empty")).toHaveTextContent(
      "No statement charges are available to export.",
    );
    expect(screen.getByTestId("button-export-statement-charges")).toBeDisabled();
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });

  it("shows unavailable feedback and keeps export disabled when loading fails", async () => {
    apiFetchMock.mockRejectedValue(new Error("Request failed"));
    renderTab();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Statement charge history is unavailable. Request failed",
    );
    expect(screen.getByTestId("button-export-statement-charges")).toBeDisabled();
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });

  it("uses the selected date range for both the visible ledger and CSV export", async () => {
    const timeZone = encodeURIComponent(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    );
    apiFetchMock.mockImplementation(async (path: string) => {
      const params = new URL(path, "https://labtrax.test").searchParams;
      const matchesRange = params.get("from") === "2026-09-01"
        && params.get("to") === "2026-09-30";
      return {
        rows: matchesRange ? [{
          id: "invoice:inv-200",
          date: "2026-09-05T12:00:00.000Z",
          type: "invoice",
          invoiceNumber: "INV-200",
          balance: "50.00",
        }] : [],
        offset: Number(params.get("offset") ?? 0),
        total: matchesRange ? 1 : 0,
        hasMore: false,
      };
    });
    renderTab();
    await screen.findByTestId("status-statement-charges-empty");

    fireEvent.change(screen.getByTestId("select-statement-charge-range"), {
      target: { value: "range" },
    });
    fireEvent.change(screen.getByLabelText("Statement charges from"), {
      target: { value: "2026-09-01" },
    });
    fireEvent.change(screen.getByLabelText("Statement charges to"), {
      target: { value: "2026-09-30" },
    });

    await waitFor(() => expect(apiFetchMock).toHaveBeenLastCalledWith(
      `/billing/lab-1/accounts/provider-1/statement-charges?from=2026-09-01&to=2026-09-30&timeZone=${timeZone}&limit=10&offset=0`,
    ));
    expect(await screen.findByText("INV-200")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-export-statement-charges"));
    await waitFor(() => expect(apiFetchMock).toHaveBeenLastCalledWith(
      `/billing/lab-1/accounts/provider-1/statement-charges?from=2026-09-01&to=2026-09-30&timeZone=${timeZone}`,
    ));
    await waitFor(() => expect(downloadCsvMock.mock.calls.at(-1)?.[1]).toEqual([
      expect.objectContaining({ "Invoice Number": "INV-200" }),
    ]));
  });

  it("explains when the selected period has no charges", async () => {
    apiFetchMock.mockResolvedValue({ rows: [] });
    renderTab();
    await screen.findByTestId("status-statement-charges-empty");
    fireEvent.change(screen.getByTestId("select-statement-charge-range"), {
      target: { value: "range" },
    });

    expect(await screen.findByTestId("status-statement-charges-empty")).toHaveTextContent(
      "No statement charges exist in the selected period.",
    );
  });

  it("hides stale rows and disables export while the range is invalid", async () => {
    apiFetchMock.mockResolvedValue({
      rows: [{ date: "2026-09-05T12:00:00.000Z", type: "invoice", invoiceNumber: "INV-300" }],
    });
    renderTab();
    expect(await screen.findByText("INV-300")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("select-statement-charge-range"), {
      target: { value: "range" },
    });
    fireEvent.change(screen.getByLabelText("Statement charges from"), {
      target: { value: "2026-10-01" },
    });
    fireEvent.change(screen.getByLabelText("Statement charges to"), {
      target: { value: "2026-09-01" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The From date must be on or before the To date.",
    );
    expect(screen.queryByText("INV-300")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-export-statement-charges")).toBeDisabled();
  });
});