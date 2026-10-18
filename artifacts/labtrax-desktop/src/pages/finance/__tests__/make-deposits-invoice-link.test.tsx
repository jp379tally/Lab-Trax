/** @vitest-environment jsdom */
/**
 * Make Deposits invoice-link regression coverage.
 *
 * This intentionally uses a small rendered InvoiceEditor double: the behavior
 * under test is Make Deposits' link -> invoice fetch -> editor -> list refresh
 * wiring, not the editor's own form implementation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import MakeDepositsPage from "@/pages/finance/make-deposits";
import type { SessionUser } from "@/lib/api";
import type { Invoice } from "@/lib/types";
import { makeAuthWrapper } from "../../../__tests__/test-utils";

vi.mock("@/components/finance/FinanceShell", () => ({
  FinanceShell: ({
    children,
  }: {
    children: (ctx: {
      organizationId: string;
      accounts: unknown[];
    }) => React.ReactNode;
  }) => (
    <>
      {children({
        organizationId: "lab-1",
        accounts: [
          {
            id: "acc-1",
            name: "Checking",
            accountType: "checking",
            isArchived: false,
          },
        ],
      })}
    </>
  ),
}));

vi.mock("@/pages/invoices", () => ({
  InvoiceEditor: ({
    invoice,
    onClose,
  }: {
    invoice: Invoice;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label={`Edit invoice ${invoice.invoiceNumber}`}>
      <output>Invoice id: {invoice.id}</output>
      <button type="button" onClick={onClose}>
        Close invoice editor
      </button>
    </div>
  ),
}));

const ADMIN_USER = {
  id: "u1",
  username: "admin",
  role: "admin",
  userType: "lab",
} as unknown as SessionUser;

const INVOICE = {
  id: "invoice-1042",
  invoiceNumber: "INV-1042",
  labOrganizationId: "lab-1",
  providerOrganizationId: "practice-1",
  status: "open",
} as Invoice;

const TXNS = [
  {
    id: "txn-1",
    txnDate: "2026-06-01",
    payee: "Payer One",
    memo: null,
    creditAmount: "100.00",
    staleDays: 1,
    ageWarning: false,
    providerOrganizationId: "practice-1",
    providerName: "Practice One",
    practiceId: "practice-1",
    practiceName: "Practice One",
    doctorName: "Dr. Ada",
    statementDate: null,
    invoiceLinks: [
      { invoiceId: INVOICE.id, invoiceNumber: INVOICE.invoiceNumber },
    ],
    paymentSession: null,
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url, "http://localhost").pathname;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (path.endsWith("/finance/undeposited-funds")) return json(TXNS);
    if (path.endsWith(`/invoices/${INVOICE.id}`)) return json(INVOICE);
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

async function renderPage() {
  const Wrapper = makeAuthWrapper("/finance/make-deposits", {
    user: ADMIN_USER,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  render(
    <Wrapper>
      <MakeDepositsPage />
    </Wrapper>,
  );
  await screen.findByLabelText("Select payment txn-1");
}

function undepositedRequestCount() {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes("/finance/undeposited-funds"),
  ).length;
}

describe("Make Deposits invoice links", () => {
  it("opens the linked invoice and refreshes undeposited payments when the editor closes", async () => {
    await renderPage();

    const initialRequestCount = undepositedRequestCount();
    const invoiceAction = screen.getByRole("button", {
      name: INVOICE.invoiceNumber,
    });
    expect(invoiceAction).toBeInTheDocument();

    fireEvent.click(invoiceAction);

    expect(
      await screen.findByRole("dialog", {
        name: `Edit invoice ${INVOICE.invoiceNumber}`,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(`Invoice id: ${INVOICE.id}`)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/invoices/${INVOICE.id}`),
      expect.anything(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close invoice editor" }));

    await waitFor(() => {
      expect(undepositedRequestCount()).toBe(initialRequestCount + 1);
    });
    expect(
      screen.queryByRole("dialog", {
        name: `Edit invoice ${INVOICE.invoiceNumber}`,
      }),
    ).not.toBeInTheDocument();
  });
});