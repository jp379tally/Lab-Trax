/** @vitest-environment jsdom */
/**
 * Unit tests for ProviderCaseInvoiceModal — the invoice-first modal opened
 * from a case row on the provider Billing tab (task #3694).
 *
 * Invariants protected:
 *  1. It fetches GET /cases/provider/:caseId and renders balance due + line
 *     items, not the generic case-detail view (that's ProviderCaseDetailModal,
 *     which stays on the Dashboard tab).
 *  2. A Pay button appears only when there is an invoice with a payable
 *     status and a positive balance due.
 *  3. Clicking Pay opens the shared PayDialog, and a successful payment
 *     updates the balance shown and notifies the caller via onPaymentComplete.
 */

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProviderCaseInvoiceModal } from "../ProviderCaseInvoiceModal";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status = 500, body: unknown = null) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getAccessToken: () => "test-token",
}));

const CASE_WITH_OPEN_INVOICE = {
  id: "case-123",
  caseNumber: "1001",
  patientFirstName: "John",
  patientLastName: "Smith",
  invoiceId: "inv-1",
  invoiceNumber: "INV-1001",
  invoiceLines: [
    { description: "Zirconia Crown", quantity: 1, unitPrice: "150.00", totalPrice: "150.00" },
  ],
  invoiceTotal: "150.00",
  invoiceBalanceDue: "150.00",
  invoiceStatus: "open",
};

function renderModal(
  overrides: Partial<{ onClose: () => void; onPaymentComplete: () => void }> = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const onPaymentComplete = overrides.onPaymentComplete ?? vi.fn();
  const utils = render(
    <ProviderCaseInvoiceModal
      caseId="case-123"
      onClose={onClose}
      onPaymentComplete={onPaymentComplete}
    />,
  );
  return { ...utils, onClose, onPaymentComplete };
}

beforeEach(() => {
  vi.resetAllMocks();
  apiFetchMock.mockResolvedValue(CASE_WITH_OPEN_INVOICE);
});

describe("ProviderCaseInvoiceModal", () => {
  it("fetches the case-provider detail endpoint for the given caseId", async () => {
    renderModal();
    await screen.findByText("Case #1001 — Invoice");
    expect(apiFetchMock).toHaveBeenCalledWith("/cases/provider/case-123");
  });

  it("shows the invoice number, line items, and balance due", async () => {
    renderModal();
    await screen.findByText("Case #1001 — Invoice");

    expect(screen.getByText("INV-1001")).toBeInTheDocument();
    expect(screen.getByText("Zirconia Crown")).toBeInTheDocument();
    expect(screen.getAllByText(/Balance due: \$150\.00/).length).toBeGreaterThan(0);
  });

  it("shows a Pay button when the invoice has a positive balance and a payable status", async () => {
    renderModal();
    await screen.findByText("Case #1001 — Invoice");

    expect(
      screen.getByRole("button", { name: /Pay — \$150\.00 due/ }),
    ).toBeInTheDocument();
  });

  it("does not show a Pay button when the balance due is zero", async () => {
    apiFetchMock.mockResolvedValue({
      ...CASE_WITH_OPEN_INVOICE,
      invoiceBalanceDue: "0.00",
      invoiceStatus: "paid",
    });
    renderModal();
    await screen.findByText("Case #1001 — Invoice");

    expect(screen.queryByRole("button", { name: /Pay/ })).not.toBeInTheDocument();
  });

  it("does not show a Pay button when there is no invoice on the case", async () => {
    apiFetchMock.mockResolvedValue({
      id: "case-456",
      caseNumber: "1002",
      patientFirstName: "Jane",
      patientLastName: "Doe",
      invoiceId: null,
      invoiceNumber: null,
      invoiceLines: [],
      invoiceTotal: null,
      invoiceBalanceDue: null,
      invoiceStatus: null,
    });
    renderModal();
    await screen.findByText("No active invoice found for this case.");

    expect(screen.queryByRole("button", { name: /Pay/ })).not.toBeInTheDocument();
  });

  it("opens hosted checkout without claiming the invoice was already paid", async () => {
    renderModal();
    await screen.findByText("Case #1001 — Invoice");

    fireEvent.click(screen.getByRole("button", { name: /Pay — \$150\.00 due/ }));

    // PayDialog is now open
    expect(screen.getByText(/complete this card payment securely/i)).toBeInTheDocument();

    // Payment succeeds
    apiFetchMock.mockResolvedValueOnce({
      checkoutId: "checkout-1",
      url: "https://checkout.stripe.test/session",
      status: "pending",
    });
    fireEvent.click(screen.getByRole("button", { name: /Continue to Checkout/i }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/provider/payment-checkout",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            allocations: [{ invoiceId: "inv-1", amount: 150 }],
            savePaymentMethod: false,
          }),
        }),
      ),
    );
    expect(
      screen.getAllByText(/Balance due: \$150\.00/).length,
    ).toBeGreaterThan(0);
  });

  it("closes when the close button is clicked", async () => {
    const { onClose } = renderModal();
    await screen.findByText("Case #1001 — Invoice");

    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});
