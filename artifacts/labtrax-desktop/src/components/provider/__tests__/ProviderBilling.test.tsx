/** @vitest-environment jsdom */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProviderBilling } from "../ProviderBilling";
import { allocatePayment, PayMyBillDialog } from "../PayMyBillDialog";
import { makeWrapper } from "../../../__tests__/test-utils";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const statement = {
  id: "stmt-1",
  labName: "Sunrise Lab",
  statementDate: "2026-08-31",
  balanceDue: "120.00",
  invoiceIds: ["inv-1", "inv-2"],
};
const invoices = {
  "inv-1": {
    id: "inv-1",
    invoiceNumber: "INV-1",
    status: "open",
    balanceDue: "70.00",
    issuedAt: "2026-08-01T00:00:00Z",
  },
  "inv-2": {
    id: "inv-2",
    invoiceNumber: "INV-2",
    status: "partially_paid",
    balanceDue: "50.00",
    issuedAt: "2026-08-02T00:00:00Z",
  },
};

function mockApi(checkoutStatus = "pending") {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/provider/statements") return Promise.resolve([statement]);
    if (path === "/provider/statements/stmt-1") {
      return Promise.resolve({ invoices: Object.values(invoices) });
    }
    if (path === "/provider/billing-preferences") {
      return Promise.resolve({
        labs: [
          {
            providerOrganizationId: "provider-1",
            labOrganizationId: "lab-1",
            labName: "Sunrise Lab",
            providerName: "Bright Practice",
            enabled: false,
            chargeDay: 7,
          },
        ],
      });
    }
    if (path === "/provider/payment-method") {
      return Promise.resolve({
        card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
      });
    }
    if (path.startsWith("/invoices/")) {
      return Promise.resolve(invoices[path.split("/").pop() as keyof typeof invoices]);
    }
    if (path === "/provider/payment-checkout") {
      return Promise.resolve({
        checkoutId: "checkout-1",
        url: "https://checkout.stripe.test/session",
        status: "pending",
      });
    }
    if (path.includes("/invoice-autopay")) {
      return Promise.resolve({
        lab: {
          providerOrganizationId: "provider-1",
          enabled: true,
          chargeDay: 7,
        },
      });
    }
    if (path === "/provider/payment-checkout/checkout-1") {
      return Promise.resolve({
        status: checkoutStatus,
        failureReason: checkoutStatus === "failed" ? "stale_invoice_balance" : null,
      });
    }
    return Promise.resolve([]);
  });
}

function renderBilling(onRefreshCases = vi.fn()) {
  return {
    onRefreshCases,
    ...render(
      <ProviderBilling
        cases={[]}
        casesError={null}
        onRefreshCases={onRefreshCases}
      />,
      { wrapper: makeWrapper("/") },
    ),
  };
}

async function openPayMyBill() {
  fireEvent.click(await screen.findByRole("button", { name: /Pay My Bill/i }));
  await screen.findByRole("button", { name: "Partial Payment" });
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
  mockApi();
});

describe("ProviderBilling hosted checkout", () => {
  it("uses live eligibility and balance when historical statement status differs", () => {
    expect(allocatePayment([
      {
        id: "reopened",
        invoiceNumber: "INV-REOPENED",
        status: "paid",
        balanceDue: "0.00",
        currentBalanceDue: "25.00",
        eligibleForPayment: true,
      },
      {
        id: "voided",
        invoiceNumber: "INV-VOIDED",
        status: "open",
        balanceDue: "50.00",
        currentBalanceDue: "0.00",
        eligibleForPayment: false,
      },
    ], 50)).toEqual([{ invoiceId: "reopened", amount: 25 }]);
  });

  it("renders individual invoice controls from live eligibility and balance", () => {
    render(
      <PayMyBillDialog
        statement={statement}
        invoices={[
          {
            id: "reopened",
            invoiceNumber: "INV-REOPENED",
            status: "paid",
            balanceDue: "0.00",
            currentBalanceDue: "25.00",
            eligibleForPayment: true,
          },
          {
            id: "voided",
            invoiceNumber: "INV-VOIDED",
            status: "open",
            balanceDue: "50.00",
            currentBalanceDue: "0.00",
            eligibleForPayment: false,
          },
        ]}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Individual Invoices" }));
    const reopenedRow = screen.getByText("INV-REOPENED").closest("tr");
    const voidedRow = screen.getByText("INV-VOIDED").closest("tr");
    expect(reopenedRow?.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(reopenedRow?.querySelector('input[type="number"]')?.getAttribute("max"))
      .toBe("25.00");
    expect(voidedRow?.querySelector('input[type="checkbox"]')).toBeNull();
    expect(voidedRow?.querySelector('input[type="number"]')).toBeNull();
  });

  it("loads independent per-lab auto-pay and saves an authoritative preference", async () => {
    renderBilling();
    expect(await screen.findByText("Invoice auto-pay by lab")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/provider/labs/provider-1/invoice-autopay",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ enabled: true, chargeDay: 7 }),
        }),
      ),
    );
  });

  // The dangerous failure: the provider leaves believing the lab will charge
  // them, and nothing ever runs. The reason has to be the server's, and the
  // row has to fall back to the schedule the server confirmed.
  it("shows the server's refusal and keeps the last confirmed schedule", async () => {
    const rejection =
      "Your signed auto-pay authorization has expired. Sign a new one to continue.";
    const succeeding = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) =>
      String(path).includes("/invoice-autopay")
        ? Promise.reject(new Error(rejection))
        : succeeding(path, init),
    );
    renderBilling();
    expect(await screen.findByText("Invoice auto-pay by lab")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Enable" }));
    fireEvent.change(screen.getByLabelText("Charge day for Sunrise Lab"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(rejection)).toBeInTheDocument();
    expect(screen.queryByText(/invoice auto-pay preference saved/i)).not.toBeInTheDocument();
    // Back to the confirmed schedule (off, day 7) rather than the refused one
    // (on, day 3), so nothing on screen implies auto-pay runs.
    expect(screen.getByRole("checkbox", { name: "Enable" })).not.toBeChecked();
    expect(screen.getByLabelText("Charge day for Sunrise Lab")).toHaveValue(7);
    // Not retried behind the provider's back, and usable again so they can
    // act on the reason they were given.
    expect(
      apiFetchMock.mock.calls.filter(([path]) => String(path).includes("invoice-autopay")),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("rejects an invalid lab charge day before calling the API", async () => {
    renderBilling();
    const input = await screen.findByLabelText("Charge day for Sunrise Lab");
    fireEvent.change(input, { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/must be from 1 through 10/i)).toBeInTheDocument();
    expect(
      apiFetchMock.mock.calls.some(([path]) => String(path).includes("invoice-autopay")),
    ).toBe(false);
  });

  it("creates one hosted Checkout for a full-balance payment", async () => {
    renderBilling();
    await openPayMyBill();
    fireEvent.click(screen.getByRole("button", { name: /Continue to Checkout — \$120/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/provider/payment-checkout",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            allocations: [
              { invoiceId: "inv-1", amount: 70 },
              { invoiceId: "inv-2", amount: 50 },
            ],
            savePaymentMethod: false,
          }),
        }),
      ),
    );
  });

  it("preserves partial and selected-invoice allocation modes", async () => {
    renderBilling();
    await openPayMyBill();
    fireEvent.click(screen.getByRole("button", { name: "Partial Payment" }));
    fireEvent.change(screen.getByLabelText("Amount to pay"), {
      target: { value: "80" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to Checkout" }));
    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(([path]) => path === "/provider/payment-checkout");
      expect(JSON.parse(call?.[1]?.body as string).allocations).toEqual([
        { invoiceId: "inv-1", amount: 70 },
        { invoiceId: "inv-2", amount: 10 },
      ]);
    });
  });

  it("refreshes balances only after authoritative success", async () => {
    const onRefreshCases = vi.fn();
    window.history.replaceState(
      null,
      "",
      "/?providerPaymentCheckout=checkout-1",
    );
    mockApi("succeeded");
    renderBilling(onRefreshCases);
    expect(
      await screen.findByText(/Stripe confirmed your payment/i),
    ).toBeInTheDocument();
    expect(onRefreshCases).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["pending", /still confirming/i],
    ["cancelled", /was cancelled/i],
    ["expired", /session expired/i],
    ["failed", /balance changed/i],
  ])("does not claim payment for %s returns", async (status, copy) => {
    window.history.replaceState(
      null,
      "",
      "/?providerPaymentCheckout=checkout-1",
    );
    mockApi(status);
    const onRefreshCases = vi.fn();
    renderBilling(onRefreshCases);
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(onRefreshCases).not.toHaveBeenCalled();
  });
});