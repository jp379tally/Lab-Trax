import React from "react";
import { Alert } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  mockInitPaymentSheet,
  mockInvalidateQueries,
  mockPresentPaymentSheet,
  refreshMockReceiptSession,
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockFetchHandler,
} from "../../vitest.setup";
import ReceivePaymentsScreen, { paymentErrorMessage } from "@/app/finance/receive-payments";
import { ApiError } from "@/lib/read-api";
import StatementsScreen from "@/app/finance/statements";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import InvoicesScreen from "@/app/finance/invoices";
import {
  FINANCE_INVOICES_QUERY_KEY,
  FINANCE_PAYMENT_HISTORY_QUERY_KEY,
  FINANCE_STATEMENT_SUMMARIES_QUERY_KEY,
} from "@/lib/provider-billing";

const invoices = [
  { id: "invoice-a", invoiceNumber: "INV-A", status: "open", balanceDue: "100.00", total: "100.00", labOrganizationId: "lab-1", providerOrganizationId: "practice-a", providerOrganization: { id: "practice-a", name: "Alpha Dental", billingEmail: "billing@alpha.test" } },
  { id: "invoice-b", invoiceNumber: "INV-B", status: "open", balanceDue: "75.00", total: "75.00", labOrganizationId: "lab-1", providerOrganizationId: "practice-b", providerOrganization: { id: "practice-b", name: "Beta Dental" } },
];
const statements = {
  "practice-a": [{ id: "statement-a", periodEnd: "2026-08-31T12:00:00.000Z", invoiceCount: 1, savedBalanceDue: "100.00" }],
  "practice-b": [{ id: "statement-b", periodEnd: "2026-08-31T12:00:00.000Z", invoiceCount: 1, savedBalanceDue: "75.00" }],
};
const contexts = {
  "statement-a": { ...statements["practice-a"][0], labOrganizationId: "lab-1", providerOrganizationId: "practice-a", invoices: [{ ...invoices[0], patientName: "Alex A", currentBalanceDue: "100.00", dueAt: "2026-08-01T12:00:00.000Z", eligibleForPayment: true }] },
  "statement-b": { ...statements["practice-b"][0], labOrganizationId: "lab-1", providerOrganizationId: "practice-b", invoices: [{ ...invoices[1], patientName: "Blair B", currentBalanceDue: "75.00", dueAt: "2026-08-02T12:00:00.000Z", eligibleForPayment: true }] },
};

function seed() {
  setMockAppState({
    meMemberships: [{ organizationId: "lab-1", role: "admin", status: "active", organization: { id: "lab-1", type: "lab", name: "Test Lab" } }],
    receivePaymentsInvoices: invoices,
    receivePaymentsStatements: statements,
    receivePaymentsStatementContexts: contexts,
    receivePaymentsEligibleAccounts: [{
      providerOrganizationId: "practice-a",
      doctorProfiles: [{ id: "doctor-profile-a", doctorName: "Dr. Ada", doctorDisplayName: "Dr. Ada Lovelace" }],
      outstandingInvoices: [{ ...contexts["statement-a"].invoices[0], doctorName: "Ada", doctorProfileId: null }],
    }, {
      providerOrganizationId: "practice-b",
      doctorProfiles: [],
      outstandingInvoices: [{ ...contexts["statement-b"].invoices[0], doctorName: "Blair", doctorProfileId: null }],
    }],
  });
}
async function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return await render(<QueryClientProvider client={client}><ReceivePaymentsScreen /></QueryClientProvider>);
}

const financeInvalidationKeys: unknown[][] = [
  ["receive-payments"],
  ["finance"],
  [...FINANCE_INVOICES_QUERY_KEY],
  ["statements"],
  [...FINANCE_STATEMENT_SUMMARIES_QUERY_KEY],
  [...FINANCE_PAYMENT_HISTORY_QUERY_KEY],
];

function invalidatedQueryKeys(): unknown[][] {
  return (mockInvalidateQueries.mock.calls as unknown[][]).map((call) =>
    (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey ?? [],
  );
}

afterEach(() => { cleanup(); resetMockAppState(); resetMockFetchHandler(); vi.clearAllMocks(); });

describe("statement-led Receive Payments", () => {
  it("keeps fenced card attempts explicit about the safe next step", () => {
    expect(paymentErrorMessage(new ApiError(409, "blocked", {
      details: { code: "CARD_PAYMENT_ATTEMPT_BLOCKED", nextStep: "automatic_reconciliation" },
    }))).toContain("Stripe is still confirming a prior card attempt");
    expect(paymentErrorMessage(new ApiError(409, "blocked", {
      details: { code: "CARD_PAYMENT_ATTEMPT_BLOCKED", nextStep: "support_review" },
    }))).toContain("Support review is required");
    expect(paymentErrorMessage(new ApiError(409, "blocked", {
      details: { code: "CARD_PAYMENT_ATTEMPT_BLOCKED", nextStep: "support_review" },
    }))).toContain("Do not submit another charge");
  });
  it("routes hosted card setup through the HTTPS mobile return bridge and reconciles on resume", async () => {
    const source = fs.readFileSync(fileURLToPath(import.meta.resolve("../finance/receive-payments.tsx")), "utf8");
    expect(source).toContain("providerBillingReturnUrl()");
    expect(source).toContain("providerBillingReturnUrl(true)");
    expect(source).toContain("providerCardSetupSession={CHECKOUT_SESSION_ID}");
    expect(source).toContain("/lab-card/setup-status/");
    expect(source).toContain('AppState.addEventListener("change"');
    expect(source).toContain("AsyncStorage.setItem(RECEIVE_CARD_SETUP_KEY");
    expect(source).not.toContain("https://${process.env.EXPO_PUBLIC_DOMAIN}");
  });
  it("keeps Stripe native internals behind the platform adapter", async () => {
    const routeSource = fs.readFileSync(fileURLToPath(import.meta.resolve("../finance/receive-payments.tsx")), "utf8");
    const webAdapterSource = fs.readFileSync(fileURLToPath(import.meta.resolve("../../lib/stripe-payment-sheet.web.ts")), "utf8");

    expect(routeSource).toContain('from "@/lib/stripe-payment-sheet"');
    expect(routeSource).not.toContain('from "@stripe/stripe-react-native"');
    expect(routeSource).toContain('Platform.OS === "web"');
    expect(routeSource).toContain("desktop Financial workspace");
    expect(webAdapterSource).not.toContain("@stripe/stripe-react-native");
  });
  it.each([
    ["pending", "receipt-reversal-pending"],
    ["completed", "receipt-reversal-completed"],
    ["failed", "receipt-reversal-failed"],
  ] as const)("keeps the flat %s reversal response visible in the receipt composer", async (status, testID) => {
    seed();
    const terminalActions: string[] = [];
    setMockFetchHandler(async (url, init) => {
      if (url.includes("/api/billing/payment-sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "session-1", receiptNumber: "R-1", customerEmail: "billing@alpha.test" } }), { status: 201 });
      }
      if (url.endsWith("/api/billing/payment-sessions/session-1") && init?.method === "DELETE") {
        terminalActions.push("DELETE");
        return new Response(JSON.stringify({ data: { id: "session-1", receiptNumber: "R-1", reversal: { status, reason: status === "failed" ? "processor_declined" : undefined } } }), { status: 200 });
      }
      if (url.endsWith("/api/billing/payment-sessions/session-1/send-receipt") && init?.method === "POST") {
        terminalActions.push("SEND");
        return new Response(JSON.stringify({ data: { delivered: true } }), { status: 200 });
      }
      if (url.endsWith("/api/billing/payment-sessions/session-1")) {
        return new Response(JSON.stringify({
          data: {
            id: "session-1",
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    vi.mocked(Alert.alert).mockImplementation((_title, _message, buttons) => buttons?.at(-1)?.onPress?.());
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("receive-invoice-amount-invoice-a")).toBeTruthy());
    expect(screen.getByText(/Due 08\/01\/2026/)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("receive-check-number"), "CHK-100");
    await fireEvent.press(screen.getByTestId("receive-save"));
    await waitFor(() => expect(screen.getByTestId("receipt-composer-sheet")).toBeTruthy());
    await act(async () => {
      await fireEvent.press(screen.getByTestId("receipt-composer-cancel"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(terminalActions).toContain("DELETE"));
    await waitFor(() => expect(screen.getByTestId(testID)).toBeTruthy());
    if (status === "pending") expect(screen.getByTestId("receipt-composer-save").props.accessibilityState?.disabled ?? screen.getByTestId("receipt-composer-save").props.disabled).toBeTruthy();
    if (status === "failed") {
      expect(screen.getByText(/processor_declined/)).toBeTruthy();
      expect(screen.getByText(/Reversal needs review/)).toBeTruthy();
      expect(screen.queryByTestId("receipt-composer-delete")).toBeNull();
      expect(screen.queryByText("Retry reversal")).toBeNull();
      const actionsBeforeDismissal = [...terminalActions];
      await fireEvent.press(screen.getByTestId("receipt-composer-save"));
      await waitFor(() => expect(screen.queryByTestId("receipt-reversal-failed")).toBeNull());
      expect(terminalActions).toEqual(actionsBeforeDismissal);
    }
  });
  it("shows statement detail, oldest-first invoice application, and customer credit", async () => {
    seed();
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("receive-invoice-amount-invoice-a").props.value).toBe("100.00"));
    expect(screen.getByText(/Alex A/)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("receive-total"), "125.00");
    expect(screen.getByText("The unapplied $25.00 will remain as customer account credit.")).toBeTruthy();
  });

  it("shows a failed reversal refresh and retries status without creating another reversal", async () => {
    seed();
    let reversalRequests = 0;
    let statusRefreshAttempts = 0;
    setMockFetchHandler(async (url, init) => {
      if (url.includes("/api/billing/payment-sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "session-reversal-retry", receiptNumber: "R-RETRY", customerEmail: "billing@alpha.test" } }), { status: 201 });
      }
      if (url.endsWith("/api/billing/payment-sessions/session-reversal-retry") && init?.method === "DELETE") {
        reversalRequests += 1;
        return new Response(JSON.stringify({
          data: { id: "session-reversal-retry", receiptNumber: "R-RETRY", reversal: { status: "pending" } },
        }), { status: 200 });
      }
      if (url.endsWith("/api/billing/payment-sessions/session-reversal-retry")) {
        if (reversalRequests === 0) {
          return new Response(JSON.stringify({ data: { id: "session-reversal-retry", receiptNumber: "R-RETRY" } }), { status: 200 });
        }
        statusRefreshAttempts += 1;
        if (statusRefreshAttempts === 1) {
          return new Response(JSON.stringify({ error: "Processor status unavailable" }), { status: 503 });
        }
        return new Response(JSON.stringify({
          data: { id: "session-reversal-retry", receiptNumber: "R-RETRY", reversal: { status: "completed" } },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    vi.mocked(Alert.alert).mockImplementation((_title, _message, buttons) => buttons?.at(-1)?.onPress?.());

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("receive-invoice-amount-invoice-a")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("receive-check-number"), "CHK-RETRY");
    await fireEvent.press(screen.getByTestId("receive-save"));
    await waitFor(() => expect(screen.getByTestId("receipt-composer-sheet")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("receipt-composer-cancel"));
    await waitFor(() => expect(screen.getByTestId("receipt-reversal-pending")).toBeTruthy());
    await refreshMockReceiptSession("session-reversal-retry");
    await waitFor(() => expect(screen.getByTestId("receipt-reversal-refresh-error")).toBeTruthy());
    expect(screen.queryByTestId("receipt-reversal-completed")).toBeNull();
    expect(screen.getByText("Status refresh failed. The reversal is still pending and has not been marked completed.")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("receipt-reversal-refresh-retry"));
    await waitFor(() => expect(screen.getByTestId("receipt-reversal-completed")).toBeTruthy());
    expect(reversalRequests).toBe(1);
    expect(statusRefreshAttempts).toBe(2);
    expect(screen.queryByTestId("receipt-reversal-refresh-error")).toBeNull();
  });

  it("warns for mixed details and disables unavailable invoice application", async () => {
    const original = contexts["statement-a"];
    contexts["statement-a"] = {
      ...original,
      detailProvenance: "mixed",
      invoices: [
        ...original.invoices,
        { id: "deleted-mobile", invoiceNumber: "Unavailable", currentBalanceDue: "40.00", eligibleForPayment: false, detailProvenance: "unavailable" } as any,
      ],
    } as any;
    try {
      seed();
      const view = await renderScreen();
      await waitFor(() => expect(view.getByTestId("receive-continue")).toBeTruthy());
      await fireEvent.press(view.getByTestId("receive-continue"));
      await waitFor(() => expect(view.getByTestId("legacy-statement-warning")).toBeTruthy());
      expect(view.getByTestId("receive-invoice-amount-deleted-mobile").props.editable).toBe(false);
      expect(view.getByText("Original invoice unavailable (deleted); this row cannot receive payment.")).toBeTruthy();
    } finally {
      contexts["statement-a"] = original;
    }
  });

  it("warns for live details", async () => {
    const original = contexts["statement-a"];
    try {
      contexts["statement-a"] = { ...original, detailProvenance: "live" } as any;
      seed();
      const liveView = await renderScreen();
      await waitFor(() => expect(liveView.getByTestId("receive-continue")).toBeTruthy());
      await fireEvent.press(liveView.getByTestId("receive-continue"));
      expect(await liveView.findByTestId("legacy-statement-warning")).toBeTruthy();
    } finally {
      contexts["statement-a"] = original;
    }
  });

  it("does not warn for trustworthy snapshot details", async () => {
    const original = contexts["statement-a"];
    contexts["statement-a"] = { ...original, detailProvenance: "snapshot" } as any;
    try {
      seed();
      const snapshotView = await renderScreen();
      await waitFor(() => expect(snapshotView.getByTestId("receive-continue")).toBeTruthy());
      await fireEvent.press(snapshotView.getByTestId("receive-continue"));
      await waitFor(() => expect(snapshotView.getByTestId("receive-invoice-amount-invoice-a")).toBeTruthy());
      expect(snapshotView.queryByTestId("legacy-statement-warning")).toBeNull();
    } finally {
      contexts["statement-a"] = original;
    }
  });

  it("does not invalidate financial views when saving a payment fails", async () => {
    seed();
    let paymentAttempted = false;
    setMockFetchHandler(async (url, init) => {
      if (url.includes("/api/billing/payment-sessions") && init?.method === "POST") {
        paymentAttempted = true;
        return new Response(JSON.stringify({ error: "Payment unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("receive-invoice-amount-invoice-a")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("receive-check-number"), "CHK-FAILED");
    mockInvalidateQueries.mockClear();
    await fireEvent.press(screen.getByTestId("receive-save"));

    await waitFor(() => expect(paymentAttempted).toBe(true));
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["invoices"],
    });
  });

  it("repairs a legacy doctor identity with explicit confirmation and displays its audit history", async () => {
    seed();
    const requests: Array<{ url: string; method?: string; body?: Record<string, unknown> }> = [];
    setMockFetchHandler(async (url, init) => {
      requests.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/api/invoices/invoice-a/repair-doctor") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ data: { ...contexts["statement-a"].invoices[0], doctorProfileId: "doctor-profile-a" } }), { status: 200 });
      }
      if (url.endsWith("/api/invoices/invoice-a")) {
        return new Response(JSON.stringify({ data: {
          ...contexts["statement-a"].invoices[0],
          doctorIdentityRepairLogs: [{
            id: "audit-1",
            createdAt: "2026-09-13T12:00:00.000Z",
            actorFirstName: "Lab",
            actorLastName: "Admin",
            beforeJson: { doctorDisplayName: "Ada" },
            afterJson: { doctorDisplayName: "Dr. Ada Lovelace" },
          }],
        } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    vi.mocked(Alert.alert).mockImplementation((_title, _message, buttons) => buttons?.find((button) => button.text === "Repair identity")?.onPress?.());

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("doctor-repair-legacy-invoice-a")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("doctor-repair-open-invoice-a"));
    await fireEvent.press(screen.getByTestId("doctor-repair-profile-doctor-profile-a"));
    await fireEvent.press(screen.getByTestId("doctor-repair-save"));

    await waitFor(() => expect(requests.some((request) =>
      request.url.endsWith("/api/invoices/invoice-a/repair-doctor") &&
      request.method === "PATCH" &&
      request.body?.doctorProfileId === "doctor-profile-a",
    )).toBe(true));
    expect(Alert.alert).toHaveBeenCalledWith(
      "Repair doctor identity?",
      expect.stringContaining("changes its payment scope"),
      expect.any(Array),
    );
    await waitFor(() => expect(screen.getByTestId("doctor-repair-history")).toBeTruthy());
    expect(screen.getByText("Ada → Dr. Ada Lovelace")).toBeTruthy();
    expect(screen.getByText(/Lab Admin/)).toBeTruthy();
  });

  it("shows legacy invoices without offering profiles from another practice", async () => {
    seed();
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-account-picker")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-account-picker"));
    await fireEvent.press(screen.getByTestId("receive-account-option-practice-a"));
    await fireEvent.press(screen.getByTestId("receive-account-option-practice-b"));
    await fireEvent.press(screen.getByTestId("receive-account-save"));
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("doctor-repair-legacy-invoice-b")).toBeTruthy());
    expect(screen.getByText("No doctor profile available for this practice.")).toBeTruthy();
    expect(screen.queryByTestId("doctor-repair-open-invoice-b")).toBeNull();
  });

  it("keeps a successful repair visible when audit history cannot load", async () => {
    seed();
    let historyAttempts = 0;
    let patchCount = 0;
    setMockFetchHandler(async (url, init) => {
      if (url.endsWith("/api/invoices/invoice-a/repair-doctor") && init?.method === "PATCH") {
        patchCount += 1;
        return new Response(JSON.stringify({ data: { ...contexts["statement-a"].invoices[0], doctorProfileId: "doctor-profile-a" } }), { status: 200 });
      }
      if (url.endsWith("/api/invoices/invoice-a")) {
        historyAttempts += 1;
        if (historyAttempts === 1) {
          return new Response(JSON.stringify({ error: "History unavailable" }), { status: 503 });
        }
        return new Response(JSON.stringify({ data: {
          ...contexts["statement-a"].invoices[0],
          doctorIdentityRepairLogs: [{
            id: "audit-recovered",
            createdAt: "2026-09-13T12:00:00.000Z",
            actorFirstName: "Lab",
            actorLastName: "Admin",
            beforeJson: { doctorDisplayName: "Ada" },
            afterJson: { doctorDisplayName: "Dr. Ada Lovelace" },
          }],
        } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    vi.mocked(Alert.alert).mockImplementation((_title, _message, buttons) => buttons?.find((button) => button.text === "Repair identity")?.onPress?.());

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("doctor-repair-open-invoice-a")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("doctor-repair-open-invoice-a"));
    await fireEvent.press(screen.getByTestId("doctor-repair-profile-doctor-profile-a"));
    await fireEvent.press(screen.getByTestId("doctor-repair-save"));

    await waitFor(() => expect(screen.getByText("The identity was repaired, but its audit history could not be loaded.")).toBeTruthy());
    expect(screen.getByTestId("doctor-repair-retry-history")).toBeTruthy();
    expect(screen.getByTestId("doctor-repair-history")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("doctor-repair-retry-history"));
    await waitFor(() => expect(screen.getByText("Ada → Dr. Ada Lovelace")).toBeTruthy());
    expect(patchCount).toBe(1);
    expect(historyAttempts).toBe(2);
  });

  it("warns admins and offers retry when legacy eligibility cannot be checked", async () => {
    seed();
    setMockAppState({ receivePaymentsEligibleAccountsIsError: true });
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByText(/Legacy doctor identities could not be checked/)).toBeTruthy());
    await fireEvent.press(screen.getByTestId("doctor-repair-retry-eligibility"));
    const eligibleQueryCallIndexes = vi.mocked(useQuery).mock.calls
      .map(([options], index) => ({ options, index }))
      .filter(({ options }) => Array.isArray(options?.queryKey) &&
        options.queryKey[0] === "receive-payments" &&
        options.queryKey[1] === "eligible-accounts")
      .map(({ index }) => index);
    expect(eligibleQueryCallIndexes.length).toBeGreaterThan(0);
    expect(eligibleQueryCallIndexes.some((index) =>
      vi.mocked(useQuery).mock.results[index]?.value.refetch.mock.calls.length > 0,
    )).toBe(true);
  });

  it("preserves the active draft while editing the account queue and exposes method-specific fields", async () => {
    seed();
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("receive-total").props.value).toBe("100.00"));
    await fireEvent.changeText(screen.getByTestId("receive-total"), "50.00");
    await fireEvent.changeText(screen.getByTestId("receive-memo"), "Alpha draft");
    await fireEvent.press(screen.getByTestId("receive-account-picker"));
    await fireEvent.press(screen.getByTestId("receive-account-option-practice-b"));
    await fireEvent.press(screen.getByTestId("receive-account-save"));
    expect(screen.getByTestId("receive-total").props.value).toBe("50.00");
    expect(screen.getByTestId("receive-memo").props.value).toBe("Alpha draft");
    await fireEvent.press(screen.getByTestId("payment-method-card"));
    expect(screen.getByText(/No saved card|Saved card:/)).toBeTruthy();
    expect(screen.getByTestId("receive-card-setup")).toBeTruthy();
  });

  it("pays an outstanding invoice for an account with no statement and sends a null statementId", async () => {
    const invoice = { id: "invoice-c", invoiceNumber: "INV-C", status: "open", balanceDue: "60.00", total: "60.00", labOrganizationId: "lab-1", providerOrganizationId: "practice-c", providerOrganization: { id: "practice-c", name: "Gamma Dental", billingEmail: "billing@gamma.test" } };
    setMockAppState({
      meMemberships: [{ organizationId: "lab-1", role: "admin", status: "active", organization: { id: "lab-1", type: "lab", name: "Test Lab" } }],
      receivePaymentsInvoices: [invoice],
      // No statement was ever generated for this account.
      receivePaymentsStatements: { "practice-c": [] },
      receivePaymentsStatementContexts: {},
      receivePaymentsEligibleAccounts: [],
      receivePaymentsInvoiceAccounts: [{
        providerOrganizationId: "practice-c",
        doctorProfiles: [],
        currentBalanceDue: "60.00",
        outstandingInvoices: [{ ...invoice, patientName: "Cory C", currentBalanceDue: "60.00", dueAt: "2026-08-03T12:00:00.000Z", eligibleForPayment: true }],
      }],
    });
    const submitted: Record<string, unknown>[] = [];
    setMockFetchHandler(async (url, init) => {
      if (url.includes("/api/billing/payment-sessions") && init?.method === "POST") {
        submitted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ data: { id: "session-1", receiptNumber: "R-1", customerEmail: "billing@gamma.test" } }), { status: 201 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    expect(screen.getByTestId("receive-continue").props.accessibilityState?.disabled ?? screen.getByTestId("receive-continue").props.disabled).toBeFalsy();
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("receive-invoice-amount-invoice-c")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("receive-check-number"), "CHK-60");
    await fireEvent.press(screen.getByTestId("receive-save"));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({ statementId: null, providerOrganizationId: "practice-c", receivedAmount: 60, applications: [{ invoiceId: "invoice-c", amount: 60 }] });
  });
  it("pays every outstanding invoice when an account with a statement chooses no statement", async () => {
    // practice-a has a sent statement covering invoice-a only, plus a second
    // invoice that never made it onto a statement.
    const offStatement = { id: "invoice-a2", invoiceNumber: "INV-A2", status: "open", balanceDue: "40.00", total: "40.00", labOrganizationId: "lab-1", providerOrganizationId: "practice-a", providerOrganization: { id: "practice-a", name: "Alpha Dental", billingEmail: "billing@alpha.test" } };
    seed();
    setMockAppState({
      receivePaymentsInvoices: [invoices[0], offStatement],
      receivePaymentsInvoiceAccounts: [{
        providerOrganizationId: "practice-a",
        doctorProfiles: [],
        currentBalanceDue: "140.00",
        outstandingInvoices: [
          { ...contexts["statement-a"].invoices[0] },
          { ...offStatement, patientName: "Avery A", currentBalanceDue: "40.00", dueAt: "2026-08-05T12:00:00.000Z", eligibleForPayment: true },
        ],
      }],
    });
    const submitted: Record<string, unknown>[] = [];
    setMockFetchHandler(async (url, init) => {
      if (url.includes("/api/billing/payment-sessions") && init?.method === "POST") {
        submitted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ data: { id: "session-1", receiptNumber: "R-1", customerEmail: "billing@alpha.test" } }), { status: 201 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    // The statement is selected by default and only covers invoice-a.
    await waitFor(() => expect(screen.getByTestId("receive-invoice-amount-invoice-a")).toBeTruthy());
    expect(screen.queryByTestId("receive-invoice-amount-invoice-a2")).toBeNull();

    await fireEvent.press(await screen.findByTestId("receive-statement-none"));
    // Choosing no statement exposes every outstanding invoice, including the
    // one that is not on the statement.
    await waitFor(() => expect(screen.getByTestId("receive-invoice-amount-invoice-a2")).toBeTruthy());
    expect(screen.getByTestId("receive-invoice-amount-invoice-a")).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId("receive-check-number"), "CHK-140");
    await fireEvent.press(screen.getByTestId("receive-save"));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      statementId: null,
      providerOrganizationId: "practice-a",
      receivedAmount: 140,
      applications: [{ invoiceId: "invoice-a", amount: 100 }, { invoiceId: "invoice-a2", amount: 40 }],
    });
  });
  it("submits the full statement-session contract and opens the receipt composer", async () => {
    seed();
    const submitted: Record<string, unknown>[] = [];
    setMockFetchHandler(async (url, init) => {
      if (url.includes("/api/billing/payment-sessions") && init?.method === "POST") {
        submitted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ data: { id: "session-1", receiptNumber: "R-1", customerEmail: "billing@alpha.test", customerCreditAmount: "25.00" } }), { status: 201 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("receive-invoice-amount-invoice-a")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("receive-total"), "125.00");
    await fireEvent.changeText(screen.getByTestId("receive-check-number"), "CHK-125");
    await fireEvent.press(screen.getByTestId("receive-save"));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({ statementId: "statement-a", providerOrganizationId: "practice-a", receivedAmount: 125, paymentMethod: "check", checkNumber: "CHK-125", applications: [{ invoiceId: "invoice-a", amount: 100 }] });
    expect(screen.getByTestId("receipt-composer-sheet")).toBeTruthy();
    expect(screen.getByTestId("receipt-email").props.value).toBe("billing@alpha.test");
  });

  it("refreshes mobile statement open and overdue balances after recording a payment", async () => {
    seed();
    setMockAppState({
      invoices: [{
        ...invoices[0],
        status: "paid",
        balanceDue: "0.00",
      }],
      statementAccountSummaries: [{
        practiceId: "practice-a",
        practiceName: "Alpha Dental",
        billingEmail: "billing@alpha.test",
        openInvoiceCount: 1,
        openInvoiceTotal: 100,
        totalOpenBalance: 100,
        overdueBalance: 100,
        unpaidStatements: [{
          id: "statement-a",
          date: "2026-08-31T12:00:00.000Z",
          remainingBalance: 100,
        }],
      }],
    });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const statementsBeforePayment = await render(
      <QueryClientProvider client={client}>
        <StatementsScreen />
      </QueryClientProvider>,
    );
    expect(statementsBeforePayment.getByTestId("column-total-total").props.children).toBe("$100.00");
    expect(statementsBeforePayment.getByTestId("statement-open-total-practice-a").props.children).toBe("$100.00");
    expect(statementsBeforePayment.getByTestId("statement-balance-practice-a").props.children).toBe("$100.00");
    expect(statementsBeforePayment.getByTestId("statement-overdue-practice-a").props.children).toBe("$100.00");
    await statementsBeforePayment.rerender(
      <QueryClientProvider client={client}>
        <InvoicesScreen />
      </QueryClientProvider>,
    );
    const invoiceBeforeReversal = statementsBeforePayment.getByTestId("invoice-invoice-a");
    expect(invoiceBeforeReversal).toBeTruthy();
    expect(within(invoiceBeforeReversal).getByText("$0.00")).toBeTruthy();

    setMockFetchHandler(async (url, init) => {
      if (url.includes("/api/billing/payment-sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({
          data: {
            id: "session-balance-refresh",
            receiptNumber: "R-REFRESH",
            customerEmail: "billing@alpha.test",
          },
        }), { status: 201 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    await statementsBeforePayment.rerender(
      <QueryClientProvider client={client}>
        <ReceivePaymentsScreen />
      </QueryClientProvider>,
    );
    const receivePayments = statementsBeforePayment;
    await waitFor(() => expect(receivePayments.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(receivePayments.getByTestId("receive-continue"));
    await waitFor(() => expect(receivePayments.getByTestId("receive-invoice-amount-invoice-a")).toBeTruthy());
    await fireEvent.changeText(receivePayments.getByTestId("receive-check-number"), "CHK-REFRESH");
    await fireEvent.press(receivePayments.getByTestId("receive-save"));

    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: FINANCE_STATEMENT_SUMMARIES_QUERY_KEY,
    }));
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: FINANCE_INVOICES_QUERY_KEY,
    });

    setMockAppState({
      statementAccountSummaries: [{
        practiceId: "practice-a",
        practiceName: "Alpha Dental",
        billingEmail: "billing@alpha.test",
        openInvoiceCount: 0,
        openInvoiceTotal: 0,
        totalOpenBalance: 0,
        overdueBalance: 0,
        unpaidStatements: [],
      }],
    });
    await statementsBeforePayment.rerender(
      <QueryClientProvider client={client}>
        <StatementsScreen />
      </QueryClientProvider>,
    );
    const statementsAfterPayment = statementsBeforePayment;
    expect(statementsAfterPayment.getByTestId("column-total-total").props.children).toBe("$0.00");
    expect(statementsAfterPayment.getByTestId("statement-open-total-practice-a").props.children).toBe("$0.00");
    expect(statementsAfterPayment.getByTestId("statement-balance-practice-a").props.children).toBe("$0.00");
    expect(statementsAfterPayment.getByTestId("statement-overdue-practice-a").props.children).toBe("$0.00");
  });

  it("restores mobile statement balances after a pending reversal later completes", async () => {
    seed();
    setMockAppState({
      statementAccountSummaries: [{
        practiceId: "practice-a",
        practiceName: "Alpha Dental",
        billingEmail: "billing@alpha.test",
        openInvoiceCount: 1,
        openInvoiceTotal: 100,
        totalOpenBalance: 100,
        overdueBalance: 100,
        unpaidStatements: [{
          id: "statement-a",
          date: "2026-08-31T12:00:00.000Z",
          remainingBalance: 100,
        }],
      }],
    });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const statementsBeforePayment = await render(
      <QueryClientProvider client={client}>
        <StatementsScreen />
      </QueryClientProvider>,
    );
    expect(statementsBeforePayment.getByTestId("column-total-total").props.children).toBe("$100.00");
    expect(statementsBeforePayment.getByTestId("statement-open-total-practice-a").props.children).toBe("$100.00");
    expect(statementsBeforePayment.getByTestId("statement-balance-practice-a").props.children).toBe("$100.00");
    expect(statementsBeforePayment.getByTestId("statement-overdue-practice-a").props.children).toBe("$100.00");

    setMockAppState({
      statementAccountSummaries: [{
        practiceId: "practice-a",
        practiceName: "Alpha Dental",
        billingEmail: "billing@alpha.test",
        openInvoiceCount: 0,
        openInvoiceTotal: 0,
        totalOpenBalance: 0,
        overdueBalance: 0,
        unpaidStatements: [],
      }],
    });
    let receiptStatusReads = 0;
    setMockFetchHandler(async (url, init) => {
      if (url.includes("/api/billing/payment-sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({
          data: {
            id: "session-reversal-refresh",
            receiptNumber: "R-REVERSAL-REFRESH",
            customerEmail: "billing@alpha.test",
          },
        }), { status: 201 });
      }
      if (url.endsWith("/api/billing/payment-sessions/session-reversal-refresh") && init?.method === "DELETE") {
        return new Response(JSON.stringify({
          data: {
            id: "session-reversal-refresh",
            receiptNumber: "R-REVERSAL-REFRESH",
            reversal: { status: "pending" },
          },
        }), { status: 200 });
      }
      if (url.endsWith("/api/billing/payment-sessions/session-reversal-refresh")) {
        receiptStatusReads += 1;
        return new Response(JSON.stringify({
          data: receiptStatusReads > 1
            ? {
                id: "session-reversal-refresh",
                receiptNumber: "R-REVERSAL-REFRESH",
                reversal: { status: "completed" },
              }
            : null,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    vi.mocked(Alert.alert).mockImplementation((_title, _message, buttons) => buttons?.at(-1)?.onPress?.());

    await statementsBeforePayment.rerender(
      <QueryClientProvider client={client}>
        <ReceivePaymentsScreen />
      </QueryClientProvider>,
    );
    const receivePayments = statementsBeforePayment;
    await waitFor(() => expect(receivePayments.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(receivePayments.getByTestId("receive-continue"));
    await waitFor(() => expect(receivePayments.getByTestId("receive-invoice-amount-invoice-a")).toBeTruthy());
    await fireEvent.changeText(receivePayments.getByTestId("receive-check-number"), "CHK-REVERSAL-REFRESH");
    await fireEvent.press(receivePayments.getByTestId("receive-save"));
    await waitFor(() => expect(receivePayments.getByTestId("receipt-composer-sheet")).toBeTruthy());

    mockInvalidateQueries.mockClear();
    await fireEvent.press(receivePayments.getByTestId("receipt-composer-cancel"));
    await waitFor(() => expect(receivePayments.getByTestId("receipt-reversal-pending")).toBeTruthy());
    expect(await AsyncStorage.getItem("labtrax_receive_payment_pending_reversal")).toContain("session-reversal-refresh");
    expect(invalidatedQueryKeys()).not.toEqual(expect.arrayContaining(financeInvalidationKeys));
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
      queryKey: FINANCE_STATEMENT_SUMMARIES_QUERY_KEY,
    });
    await refreshMockReceiptSession("session-reversal-refresh");
    await waitFor(() => expect(receiptStatusReads).toBeGreaterThan(1), { timeout: 5_000 });
    await waitFor(() => expect(receivePayments.getByTestId("receipt-reversal-completed")).toBeTruthy(), { timeout: 5_000 });
    await waitFor(() => {
      expect(invalidatedQueryKeys()).toEqual(expect.arrayContaining(financeInvalidationKeys));
    });

    setMockAppState({
      invoices: [{
        ...invoices[0],
        status: "open",
        balanceDue: "100.00",
      }],
      statementAccountSummaries: [{
        practiceId: "practice-a",
        practiceName: "Alpha Dental",
        billingEmail: "billing@alpha.test",
        openInvoiceCount: 1,
        openInvoiceTotal: 100,
        totalOpenBalance: 100,
        overdueBalance: 100,
        unpaidStatements: [{
          id: "statement-a",
          date: "2026-08-31T12:00:00.000Z",
          remainingBalance: 100,
        }],
      }],
    });
    await statementsBeforePayment.rerender(
      <QueryClientProvider client={client}>
        <StatementsScreen />
      </QueryClientProvider>,
    );
    expect(statementsBeforePayment.getByTestId("column-total-total").props.children).toBe("$100.00");
    expect(statementsBeforePayment.getByTestId("statement-open-total-practice-a").props.children).toBe("$100.00");
    expect(statementsBeforePayment.getByTestId("statement-balance-practice-a").props.children).toBe("$100.00");
    expect(statementsBeforePayment.getByTestId("statement-overdue-practice-a").props.children).toBe("$100.00");
    await statementsBeforePayment.rerender(
      <QueryClientProvider client={client}>
        <InvoicesScreen />
      </QueryClientProvider>,
    );
    const invoiceAfterReversal = statementsBeforePayment.getByTestId("invoice-invoice-a");
    expect(invoiceAfterReversal).toBeTruthy();
    expect(within(invoiceAfterReversal).getByText("$100.00")).toBeTruthy();
    expect(within(invoiceAfterReversal).getByText("OPEN")).toBeTruthy();
  });

  it("recovers a pending reversal after leaving and returning to Receive Payments", async () => {
    seed();
    await AsyncStorage.setItem("labtrax_receive_payment_pending_reversal", JSON.stringify({
      id: "session-restored-reversal",
      receiptNumber: "R-RESTORED",
      customerEmail: "billing@alpha.test",
      reversal: { status: "pending" },
    }));
    let receiptStatusReads = 0;
    setMockFetchHandler(async (url, init) => {
      if (url.endsWith("/api/billing/payment-sessions/session-restored-reversal")) {
        receiptStatusReads += 1;
        return new Response(JSON.stringify({
          data: {
            id: "session-restored-reversal",
            receiptNumber: "R-RESTORED",
            customerEmail: "billing@alpha.test",
            reversal: { status: receiptStatusReads > 1 ? "completed" : "pending" },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receipt-composer-sheet")).toBeTruthy());
    expect(screen.getByTestId("receipt-reversal-pending")).toBeTruthy();
    await waitFor(() => expect(receiptStatusReads).toBeGreaterThan(0));
    await refreshMockReceiptSession("session-restored-reversal");
    await waitFor(() => expect(screen.getByTestId("receipt-reversal-completed")).toBeTruthy());
    expect(await AsyncStorage.getItem("labtrax_receive_payment_pending_reversal")).toBeNull();
    await waitFor(() => {
      const invalidatedKeys = (mockInvalidateQueries.mock.calls as unknown[][]).map((call) =>
        (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey,
      );
      expect(invalidatedKeys).toEqual(expect.arrayContaining([
        ["invoices"],
        ["statement-account-summaries"],
      ]));
    });
  });

  it("keeps finance views unchanged when a payment reversal fails", async () => {
    seed();
    let reversalRequested = false;
    setMockFetchHandler(async (url, init) => {
      if (url.includes("/api/billing/payment-sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({
          data: {
            id: "session-reversal-failed",
            receiptNumber: "R-REVERSAL-FAILED",
            customerEmail: "billing@alpha.test",
          },
        }), { status: 201 });
      }
      if (url.endsWith("/api/billing/payment-sessions/session-reversal-failed") && init?.method === "DELETE") {
        reversalRequested = true;
        return new Response(JSON.stringify({
          data: {
            id: "session-reversal-failed",
            receiptNumber: "R-REVERSAL-FAILED",
            reversal: { status: "failed", reason: "processor_declined" },
          },
        }), { status: 200 });
      }
      if (url.endsWith("/api/billing/payment-sessions/session-reversal-failed")) {
        return new Response(JSON.stringify({
          data: {
            id: "session-reversal-failed",
            reversal: reversalRequested ? { status: "failed", reason: "processor_declined" } : undefined,
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    vi.mocked(Alert.alert).mockImplementation((_title, _message, buttons) => buttons?.at(-1)?.onPress?.());

    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("receive-invoice-amount-invoice-a")).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId("receive-check-number"), "CHK-REVERSAL-FAILED");
    await fireEvent.press(screen.getByTestId("receive-save"));
    await waitFor(() => expect(screen.getByTestId("receipt-composer-sheet")).toBeTruthy());

    mockInvalidateQueries.mockClear();
    await fireEvent.press(screen.getByTestId("receipt-composer-cancel"));
    await waitFor(() => expect(screen.getByTestId("receipt-reversal-failed")).toBeTruthy());
    expect(screen.getByText(/processor_declined/)).toBeTruthy();
    expect(invalidatedQueryKeys()).not.toEqual(expect.arrayContaining(financeInvalidationKeys));
  });

  it("charges a new card through prepare, native PaymentSheet, and confirm without sending raw card data", async () => {
    seed();
    setMockAppState({ receivePaymentsCardConfig: { publishableKey: "pk_test_mobile" } });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    setMockFetchHandler(async (url, init) => {
      if (url.endsWith("/card/prepare") && init?.method === "POST") {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ data: { clientSecret: "pi_secret_mobile", paymentIntentId: "pi_mobile_1", status: "requires_payment_method" } }), { status: 201 });
      }
      if (url.endsWith("/card/confirm") && init?.method === "POST") {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ data: { id: "session-card", receiptNumber: "R-CARD", customerEmail: "billing@alpha.test" } }), { status: 201 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("payment-method-card")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("payment-method-card"));
    await fireEvent.press(screen.getByTestId("receive-card-new"));
    expect(screen.getByText(/This is off by default/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("receive-save"));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(mockInitPaymentSheet).toHaveBeenCalledWith(expect.objectContaining({
      paymentIntentClientSecret: "pi_secret_mobile",
      paymentMethodOrder: ["card"],
    }));
    expect(mockPresentPaymentSheet).toHaveBeenCalledTimes(1);
    expect(requests[0].body).toMatchObject({
      paymentMethod: "card",
      savePaymentMethod: false,
      idempotencyKey: expect.stringMatching(/^mobile-/),
    });
    expect(Object.keys(requests[0].body).sort()).toEqual([
      "applications", "customerEmail", "existingCreditAmount", "idempotencyKey",
      "labOrganizationId", "memo", "paymentDate", "paymentMethod",
      "providerOrganizationId", "receivedAmount", "savePaymentMethod", "statementId",
    ]);
    expect(requests[1].body).toMatchObject({
      paymentIntentId: "pi_mobile_1",
      savePaymentMethod: false,
    });
    const serialized = JSON.stringify(requests);
    expect(serialized).not.toMatch(/"(?:cardNumber|cvc|securityCode|expMonth|expYear|postalCode|billingZip)"\s*:/i);
    expect(screen.getByTestId("receipt-composer-sheet")).toBeTruthy();
  });

  it("charges the existing saved card without opening new-card PaymentSheet", async () => {
    seed();
    setMockAppState({
      receivePaymentsSavedCards: {
        "practice-a": { card: { brand: "Visa", last4: "4242" } },
      },
    });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    setMockFetchHandler(async (url, init) => {
      if (url.endsWith("/api/billing/payment-sessions/card") && init?.method === "POST") {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ data: { id: "session-saved", receiptNumber: "R-SAVED" } }), { status: 201 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("payment-method-card")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("payment-method-card"));
    expect(screen.getByText("Use saved Visa ···· 4242")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("receive-save"));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].body).toMatchObject({ cardLast4: "4242", paymentMethod: "card" });
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    expect(mockPresentPaymentSheet).not.toHaveBeenCalled();
  });

  it("saves a new card only when selected and keeps a cancelled payment out of accounting", async () => {
    seed();
    setMockAppState({ receivePaymentsCardConfig: { publishableKey: "pk_test_mobile" } });
    mockPresentPaymentSheet.mockResolvedValueOnce({ error: { code: "Canceled", message: "Card entry was cancelled" } } as never);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    setMockFetchHandler(async (url, init) => {
      if (url.endsWith("/card/prepare") && init?.method === "POST") {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ data: { clientSecret: "pi_secret_cancel", paymentIntentId: "pi_mobile_cancel", status: "requires_payment_method" } }), { status: 201 });
      }
      if (url.endsWith("/card/confirm") && init?.method === "POST") {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ data: { status: "requires_payment_method" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("payment-method-card")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("payment-method-card"));
    await fireEvent.press(screen.getByTestId("receive-card-new"));
    await fireEvent.press(screen.getByTestId("receive-card-save-on-file"));
    await fireEvent.press(screen.getByTestId("receive-save"));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0].body).toMatchObject({ savePaymentMethod: true });
    expect(requests[1].body).toMatchObject({ savePaymentMethod: true });
    await waitFor(() => expect(screen.getByText("Card entry was cancelled")).toBeTruthy());
    expect(screen.queryByText("R-CARD")).toBeNull();
  });

  it("reconciles an already-succeeded retry without reopening PaymentSheet", async () => {
    seed();
    setMockAppState({ receivePaymentsCardConfig: { publishableKey: "pk_test_mobile" } });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    setMockFetchHandler(async (url, init) => {
      if (url.endsWith("/card/prepare") && init?.method === "POST") {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ data: { clientSecret: "pi_secret_retry", paymentIntentId: "pi_mobile_retry", status: "succeeded" } }), { status: 200 });
      }
      if (url.endsWith("/card/confirm") && init?.method === "POST") {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ data: { id: "session-retry", receiptNumber: "R-RETRY" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("payment-method-card")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("payment-method-card"));
    await fireEvent.press(screen.getByTestId("receive-card-new"));
    await fireEvent.press(screen.getByTestId("receive-save"));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    expect(mockPresentPaymentSheet).not.toHaveBeenCalled();
    expect(requests[1].body).toMatchObject({ paymentIntentId: "pi_mobile_retry" });
  });

  it("trusts a reconciled receipt when native PaymentSheet closes with an error", async () => {
    seed();
    setMockAppState({ receivePaymentsCardConfig: { publishableKey: "pk_test_mobile" } });
    mockPresentPaymentSheet.mockRejectedValueOnce(new Error("Native sheet disconnected"));
    setMockFetchHandler(async (url, init) => {
      if (url.endsWith("/card/prepare") && init?.method === "POST") {
        return new Response(JSON.stringify({ data: {
          clientSecret: "pi_secret_reconciled",
          paymentIntentId: "pi_mobile_reconciled",
          status: "requires_payment_method",
        } }), { status: 201 });
      }
      if (url.endsWith("/card/confirm") && init?.method === "POST") {
        return new Response(JSON.stringify({ data: {
          id: "session-reconciled",
          receiptNumber: "R-RECONCILED",
          customerEmail: "billing@alpha.test",
        } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    const screen = await renderScreen();
    await waitFor(() => expect(screen.getByTestId("receive-continue")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("receive-continue"));
    await waitFor(() => expect(screen.getByTestId("payment-method-card")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("payment-method-card"));
    await fireEvent.press(screen.getByTestId("receive-card-new"));
    await fireEvent.press(screen.getByTestId("receive-save"));
    await waitFor(() => expect(screen.getByTestId("receipt-composer-sheet")).toBeTruthy());
    expect(screen.getByTestId("receipt-email").props.value).toBe("billing@alpha.test");
    expect(screen.queryByText("Native sheet disconnected")).toBeNull();
  });
});