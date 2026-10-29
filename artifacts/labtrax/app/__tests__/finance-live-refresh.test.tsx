/**
 * Live-query proof that recording a payment actually REFRESHES the mobile
 * finance lists.
 *
 * The shared harness normally stubs the finance hooks with static fixtures and
 * records invalidateQueries calls, so a screen can "invalidate" a list that
 * never refetches and the suite still passes. These tests opt into
 * `liveInvoiceQueries`, which routes the paged invoice list and the statement
 * account summaries through REAL React Query under the production query keys,
 * inside a real QueryClientProvider.
 *
 * Invariants protected:
 *  - Recording a payment while the Invoices list is mounted refetches it: the
 *    row and the Balance column total show the settled figures without the
 *    screen being remounted.
 *  - The same holds for the Statements list (open balance, open invoice total
 *    and overdue).
 *  - The assertions above are load-bearing: when the payment fails and no
 *    invalidation is issued, both lists keep showing the pre-payment figures
 *    even though the server-side fixture already changed. Without a real
 *    refetch the success cases could not have observed the new values.
 */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";
import {
  mockInvalidateQueries,
  mockUpdateInvoiceMutateAsync,
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockFetchHandler,
  setMockSearchParams,
} from "../../vitest.setup";
import ReceivePaymentsScreen from "@/app/finance/receive-payments";
import InvoicesScreen from "@/app/finance/invoices";
import StatementsScreen from "@/app/finance/statements";
import InvoiceEditorScreen from "@/app/invoice-editor/[id]";

const openInvoice = {
  id: "invoice-a",
  invoiceNumber: "INV-A",
  status: "open",
  total: "100.00",
  balanceDue: "100.00",
  issuedAt: "2026-08-01T12:00:00.000Z",
  dueAt: "2026-08-15T12:00:00.000Z",
  labOrganizationId: "lab-1",
  providerOrganizationId: "practice-a",
  providerOrganization: { id: "practice-a", name: "Alpha Dental", billingEmail: "billing@alpha.test" },
};
// What the server holds once the payment is recorded.
const settledInvoice = { ...openInvoice, status: "paid", balanceDue: "0.00" };

const statements = {
  "practice-a": [{
    id: "statement-a",
    periodEnd: "2026-08-31T12:00:00.000Z",
    invoiceCount: 1,
    savedBalanceDue: "100.00",
  }],
};
const statementContexts = {
  "statement-a": {
    ...statements["practice-a"][0],
    labOrganizationId: "lab-1",
    providerOrganizationId: "practice-a",
    invoices: [{
      ...openInvoice,
      patientName: "Alex A",
      currentBalanceDue: "100.00",
      eligibleForPayment: true,
    }],
  },
};

const openSummary = {
  practiceId: "practice-a",
  practiceName: "Alpha Dental",
  billingEmail: "billing@alpha.test",
  openInvoiceCount: 1,
  openInvoiceTotal: 100,
  totalOpenBalance: 100,
  overdueBalance: 100,
  unpaidStatements: [{ id: "statement-a", date: "2026-08-31T12:00:00.000Z", remainingBalance: 100 }],
};
const settledSummary = {
  ...openSummary,
  openInvoiceCount: 0,
  openInvoiceTotal: 0,
  totalOpenBalance: 0,
  overdueBalance: 0,
  unpaidStatements: [],
};

function seed() {
  setMockAppState({
    // Gate the live React Query branches of the shared hook mocks. Seeded
    // before render so hook order never changes mid-test.
    liveInvoiceQueries: true,
    meMemberships: [{
      organizationId: "lab-1",
      role: "admin",
      status: "active",
      organization: { id: "lab-1", type: "lab", name: "Test Lab" },
    }],
    invoices: [openInvoice],
    statementAccountSummaries: [openSummary],
    receivePaymentsInvoices: [openInvoice],
    receivePaymentsStatements: statements,
    receivePaymentsStatementContexts: statementContexts,
    receivePaymentsEligibleAccounts: [{
      providerOrganizationId: "practice-a",
      doctorProfiles: [],
      outstandingInvoices: [{ ...statementContexts["statement-a"].invoices[0], doctorName: "Ada", doctorProfileId: null }],
    }],
  });
}

/** Payment endpoint that settles the server-side fixture, or fails outright. */
function respondToPayment(options: { settle: (() => void) | null }) {
  setMockFetchHandler(async (url, init) => {
    if (url.includes("/api/billing/payment-sessions") && init?.method === "POST") {
      if (!options.settle) {
        return new Response(JSON.stringify({ error: "Payment could not be recorded." }), { status: 500 });
      }
      options.settle();
      return new Response(JSON.stringify({
        data: { id: "session-live", receiptNumber: "R-LIVE", customerEmail: "billing@alpha.test" },
      }), { status: 201 });
    }
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  });
}

/**
 * Renders Receive Payments next to a finance list in ONE real
 * QueryClientProvider, so the list stays mounted across the payment and can
 * only change by refetching.
 */
async function renderWithList(list: React.ReactElement) {
  return renderWithClient(
    <>
      <ReceivePaymentsScreen />
      {list}
    </>,
  );
}

async function renderWithClient(
  content: React.ReactElement,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  vi.spyOn(client, "invalidateQueries");
  const screen = await render(
    <QueryClientProvider client={client}>
      {content}
    </QueryClientProvider>,
  );
  return { ...screen, client };
}

async function recordPayment(screen: Awaited<ReturnType<typeof renderWithList>>) {
  await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
  await fireEvent.press(screen.getByTestId("receive-continue"));
  await waitFor(() => expect(screen.getByTestId("receive-invoice-amount-invoice-a")).toBeTruthy());
  await fireEvent.changeText(screen.getByTestId("receive-check-number"), "CHK-LIVE");
  await fireEvent.press(screen.getByTestId("receive-save"));
}

afterEach(() => {
  cleanup();
  resetMockAppState();
  resetMockFetchHandler();
  mockUpdateInvoiceMutateAsync.mockReset().mockResolvedValue({ ok: true, data: null });
  vi.clearAllMocks();
});

describe("mobile invoice editor — live refresh after a saved amount edit", () => {
  it("keeps a non-midnight issue timestamp and refreshes the mounted invoice list before returning", async () => {
    const invoice = {
      ...openInvoice,
      issuedAt: "2026-03-10T05:30:00.000Z",
      items: [{
        id: "line-a",
        description: "Crown",
        quantity: 1,
        unitPrice: "100.00",
        subItems: [{
          id: "child-a",
          description: "Layered porcelain",
          quantity: 1,
          unitPrice: "10.00",
        }],
      }],
    };
    const revised = { ...invoice, total: "160.00", balanceDue: "160.00" };
    setMockAppState({
      liveInvoiceQueries: true,
      meMemberships: [{
        organizationId: "lab-1",
        role: "admin",
        status: "active",
        organization: { id: "lab-1", type: "lab", name: "Test Lab" },
      }],
      invoices: [invoice],
    });
    setMockSearchParams({ id: invoice.id });
    mockUpdateInvoiceMutateAsync.mockImplementation(async () => {
      setMockAppState({ invoices: [revised] });
      return { ok: true, data: null };
    });

    const view = await renderWithClient(
      <>
        <InvoicesScreen />
        <InvoiceEditorScreen />
      </>,
    );
    await waitFor(() => {
      expect(view.getByTestId("column-total-total").props.children).toBe("$100.00");
      expect(view.getByTestId("invoice-editor-line-price-0").props.value).toBe("100");
    });

    await fireEvent.changeText(view.getByTestId("invoice-editor-line-price-0"), "150");
    mockInvalidateQueries.mockClear();
    await fireEvent.press(view.getByTestId("invoice-editor-save"));

    await waitFor(() => {
      expect(view.getByTestId("column-total-total").props.children).toBe("$160.00");
    });
    expect(revised.issuedAt).toBe(invoice.issuedAt);
    expect(router.back).toHaveBeenCalled();
    expect(view.client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["invoices"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["customer-center-summary"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["receive-payments", "statements"],
    });
  });
});

describe("mobile invoice editor — live refresh after AI review acknowledgment", () => {
  const aiInvoice = {
    ...openInvoice,
    aiGenerated: true,
    aiReviewedAt: null as string | null,
    items: [],
  };
  const reviewedAiInvoice = {
    ...aiInvoice,
    aiReviewedAt: "2026-10-25T12:00:00.000Z",
  };

  async function renderAiReviewFlow() {
    setMockAppState({
      liveInvoiceQueries: true,
      meMemberships: [{
        organizationId: "lab-1",
        role: "admin",
        status: "active",
        organization: { id: "lab-1", type: "lab", name: "Test Lab" },
      }],
      invoices: [aiInvoice],
    });
    setMockSearchParams({ id: aiInvoice.id });
    return renderWithClient(
      <>
        <InvoicesScreen />
        <InvoiceEditorScreen />
      </>,
    );
  }

  it("updates the mounted invoice list after acknowledgment succeeds", async () => {
    const screen = await renderAiReviewFlow();
    await waitFor(() =>
      expect(screen.getByTestId(`invoice-ai-review-status-${aiInvoice.id}`).props.children).toBeTruthy(),
    );
    expect(screen.getByText("AI review needed")).toBeTruthy();

    setMockFetchHandler(async (url) => {
      if (url.includes("/ai-review")) {
        setMockAppState({ invoices: [reviewedAiInvoice] });
        return new Response(JSON.stringify({ data: reviewedAiInvoice }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await fireEvent.press(screen.getByTestId("invoice-editor-mark-ai-reviewed"));

    await waitFor(() => expect(screen.getByText("AI reviewed")).toBeTruthy());
    expect(screen.queryByText("AI review needed")).toBeNull();
    expect(screen.client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
  });

  it("leaves the mounted invoice list unchanged when acknowledgment fails", async () => {
    const screen = await renderAiReviewFlow();
    await waitFor(() => expect(screen.getByText("AI review needed")).toBeTruthy());

    setMockFetchHandler(async (url) => {
      if (url.includes("/ai-review")) {
        // Even if the server-side fixture changes independently, a failed
        // response must not trigger a cache refresh that marks the row reviewed.
        setMockAppState({ invoices: [reviewedAiInvoice] });
        return new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await fireEvent.press(screen.getByTestId("invoice-editor-mark-ai-reviewed"));

    await waitFor(() =>
      expect(screen.getByTestId("invoice-editor-ai-review-warning")).toBeTruthy(),
    );
    expect(screen.getByText("AI review needed")).toBeTruthy();
    expect(screen.queryByText("AI reviewed")).toBeNull();
    expect(screen.client.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
  });
});

describe("mobile Invoices list — live refresh after a payment", () => {
  it("refetches the mounted list and shows the settled balance", async () => {
    seed();
    respondToPayment({ settle: () => setMockAppState({ invoices: [settledInvoice] }) });
    const screen = await renderWithList(<InvoicesScreen />);

    await waitFor(() =>
      expect(within(screen.getByTestId("invoice-invoice-a")).getByText("$100.00")).toBeTruthy(),
    );
    expect(screen.getByTestId("column-total-balance").props.children).toBe("$100.00");

    await recordPayment(screen);
    await waitFor(() => expect(screen.getByTestId("receipt-composer-sheet")).toBeTruthy());

    // Same mounted list, no remount: the invalidation reached the real client
    // and the paged invoice query refetched the settled row.
    await waitFor(() =>
      expect(within(screen.getByTestId("invoice-invoice-a")).getByText("$0.00")).toBeTruthy(),
    );
    expect(within(screen.getByTestId("invoice-invoice-a")).getByText("PAID")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("column-total-balance").props.children).toBe("$0.00"),
    );
    expect(screen.getByTestId("column-total-total").props.children).toBe("$100.00");
    expect(screen.client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["invoices"] });
  });

  it("keeps the pre-payment balance visible when the payment fails", async () => {
    seed();
    // The fixture changes anyway: only an invalidation-driven refetch could
    // surface it, so a stale list here proves the success case refetched.
    respondToPayment({ settle: null });
    const screen = await renderWithList(<InvoicesScreen />);

    await waitFor(() =>
      expect(within(screen.getByTestId("invoice-invoice-a")).getByText("$100.00")).toBeTruthy(),
    );
    await recordPayment(screen);
    await waitFor(() => expect(screen.getByText("Payment could not be recorded.")).toBeTruthy());
    setMockAppState({ invoices: [settledInvoice] });

    expect(within(screen.getByTestId("invoice-invoice-a")).getByText("$100.00")).toBeTruthy();
    expect(within(screen.getByTestId("invoice-invoice-a")).getByText("OPEN")).toBeTruthy();
    expect(screen.getByTestId("column-total-balance").props.children).toBe("$100.00");
    expect(screen.client.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["invoices"] });
  });
});

describe("mobile Statements list — live refresh after a payment", () => {
  it("refetches the mounted list and shows the settled open balance", async () => {
    seed();
    respondToPayment({ settle: () => setMockAppState({ statementAccountSummaries: [settledSummary] }) });
    const screen = await renderWithList(<StatementsScreen />);

    await waitFor(() =>
      expect(screen.getByTestId("statement-balance-practice-a").props.children).toBe("$100.00"),
    );
    expect(screen.getByTestId("column-total-total").props.children).toBe("$100.00");
    expect(screen.getByTestId("statement-overdue-practice-a").props.children).toBe("$100.00");

    await recordPayment(screen);
    await waitFor(() => expect(screen.getByTestId("receipt-composer-sheet")).toBeTruthy());

    await waitFor(() =>
      expect(screen.getByTestId("statement-balance-practice-a").props.children).toBe("$0.00"),
    );
    expect(screen.getByTestId("statement-open-total-practice-a").props.children).toBe("$0.00");
    expect(screen.getByTestId("statement-overdue-practice-a").props.children).toBe("$0.00");
    await waitFor(() =>
      expect(screen.getByTestId("column-total-total").props.children).toBe("$0.00"),
    );
    expect(screen.client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["statement-account-summaries"],
    });
  });

  it("keeps the pre-payment open balance visible when the payment fails", async () => {
    seed();
    respondToPayment({ settle: null });
    const screen = await renderWithList(<StatementsScreen />);

    await waitFor(() =>
      expect(screen.getByTestId("statement-balance-practice-a").props.children).toBe("$100.00"),
    );
    await recordPayment(screen);
    await waitFor(() => expect(screen.getByText("Payment could not be recorded.")).toBeTruthy());
    setMockAppState({ statementAccountSummaries: [settledSummary] });

    // The screen re-renders on the error, but its focus-driven refresh already
    // ran at mount, so nothing refetches without the payment's invalidation.
    expect(screen.getByTestId("statement-balance-practice-a").props.children).toBe("$100.00");
    expect(screen.getByTestId("column-total-total").props.children).toBe("$100.00");
    expect(screen.client.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["statement-account-summaries"],
    });
  });
});
