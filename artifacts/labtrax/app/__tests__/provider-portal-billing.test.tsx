// Provider portal → View and Pay My Bill.
//
// The mobile section mirrors the desktop billing screen, so these tests cover
// the outcomes a provider depends on rather than the layout: the outstanding
// figures (and their zero state), the rule that a payment flow only opens once
// every invoice on the statement has loaded, the open/past statement split with
// each filter and search path, the payment-history filters, per-lab auto-pay
// saving, the post-checkout outcomes including the re-check, and the refresh
// that follows a completed payment.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppState, Linking } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import {
  flushPendingReactUpdates,
  resetMockAppState,
  resetMockFetchHandler,
  setMockFetchHandler,
} from "../../vitest.setup";

// The global setup replaces `useQuery`/`useQueryClient` with static stubs. This
// section is about what happens when data actually refetches (after a payment,
// after an auto-pay save), so it runs React Query for real against a mocked
// network.
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
}));

import { ProviderBillingSection } from "@/components/provider-portal/sections/ProviderBillingSection";
import { PROVIDER_CHECKOUT_PENDING_KEY } from "@/lib/provider-billing";
import { allocatePayment, isPayable } from "@/lib/provider-portal-billing";
import {
  deliverProviderCheckoutReturn,
  latestProviderCheckoutReturn,
  parseProviderCheckoutReturnUrl,
  resetProviderCheckoutReturn,
  type ProviderCheckoutReturnSignal,
} from "@/lib/provider-checkout-return";

// ── Fixture dates ──────────────────────────────────────────────────────────
// Filters are relative to "now", so the fixtures are too. Midday keeps a date
// inside its intended day whatever the runner's timezone is.
const NOW = new Date();
const THIS_YEAR = NOW.getFullYear();
const LAST_YEAR = THIS_YEAR - 1;
const at = (year: number, month: number, day: number): string =>
  new Date(year, month, day, 12).toISOString();
const THIS_YEAR_DATE = at(THIS_YEAR, 0, 15);
const LAST_YEAR_DATE = at(LAST_YEAR, 5, 20);
const THIS_MONTH_DATE = at(THIS_YEAR, NOW.getMonth(), Math.min(NOW.getDate(), 28));
const LAST_MONTH_DATE = new Date(THIS_YEAR, NOW.getMonth() - 1, 15, 12).toISOString();

// ── Server ─────────────────────────────────────────────────────────────────
interface Statement {
  id: string;
  labOrganizationId: string;
  providerOrganizationId: string;
  labName: string;
  statementDate: string;
  totalAmount: string;
  balanceDue: string;
  invoiceCount: number;
  invoiceIds: string[];
}

interface Balance {
  labOrganizationId: string;
  providerOrganizationId: string;
  invoiceBalance: string;
  availableCredit: string;
  currentBalance: string;
  openInvoiceCount: number;
  calculatedAt: string;
}

const OPEN_STATEMENT: Statement = {
  id: "st-open",
  labOrganizationId: "lab-north",
  providerOrganizationId: "prac-1",
  labName: "Northline Dental Lab",
  statementDate: THIS_MONTH_DATE,
  totalAmount: "1200.00",
  balanceDue: "450.00",
  invoiceCount: 2,
  invoiceIds: ["inv-1", "inv-2"],
};

// A second open statement for the same lab relationship: its balance is part
// of the account balance, so paying "in full" has to cover it too.
const SECOND_OPEN_STATEMENT: Statement = {
  id: "st-open-2",
  labOrganizationId: "lab-north",
  providerOrganizationId: "prac-1",
  labName: "Northline Dental Lab",
  statementDate: LAST_MONTH_DATE,
  totalAmount: "500.00",
  balanceDue: "200.00",
  invoiceCount: 1,
  invoiceIds: ["inv-2"],
};

const PAID_THIS_YEAR: Statement = {
  id: "st-paid-this-year",
  labOrganizationId: "lab-north",
  providerOrganizationId: "prac-1",
  labName: "Northline Dental Lab",
  statementDate: THIS_YEAR_DATE,
  totalAmount: "800.00",
  balanceDue: "0.00",
  invoiceCount: 3,
  invoiceIds: ["inv-3"],
};

const PAID_LAST_YEAR: Statement = {
  id: "st-paid-last-year",
  labOrganizationId: "lab-south",
  providerOrganizationId: "prac-1",
  labName: "Southgate Dental Studio",
  statementDate: LAST_YEAR_DATE,
  totalAmount: "300.00",
  balanceDue: "0",
  invoiceCount: 5,
  invoiceIds: [],
};

function balance(
  labOrganizationId: string,
  currentBalance: string,
  openInvoiceCount: number,
): Balance {
  return {
    labOrganizationId,
    providerOrganizationId: "prac-1",
    invoiceBalance: currentBalance,
    availableCredit: "0.00",
    currentBalance,
    openInvoiceCount,
    calculatedAt: THIS_MONTH_DATE,
  };
}

const CASES = [
  {
    id: "case-1",
    caseNumber: "SYN-CASE-001",
    patientFirstName: "Ada",
    patientLastName: "Lovelace",
    restorationTypes: "Zirconia Crown",
    status: "in_design",
    dueDate: THIS_MONTH_DATE,
    labName: "Northline Dental Lab",
    openInvoiceAmount: 300,
  },
  {
    id: "case-2",
    caseNumber: "C-1002",
    patientFirstName: "Grace",
    patientLastName: "Hopper",
    restorationTypes: "PFM Bridge",
    status: "qc",
    dueDate: THIS_MONTH_DATE,
    labName: "Southgate Dental Studio",
    openInvoiceAmount: 150,
  },
  {
    id: "case-3",
    caseNumber: "C-1003",
    patientFirstName: "Alan",
    patientLastName: "Turing",
    restorationTypes: "Night Guard",
    status: "delivered",
    dueDate: THIS_MONTH_DATE,
    labName: "Northline Dental Lab",
    openInvoiceAmount: 0,
  },
];

const AUTOPAY_LAB = {
  providerOrganizationId: "prac-1",
  labOrganizationId: "lab-north",
  labName: "Northline Dental Lab",
  providerName: "North Dental",
  enabled: false,
  chargeDay: 5,
  authorization: {
    authorizationId: "auth-1",
    authorizationStatus: "active",
    nextRunAt: THIS_MONTH_DATE,
    lastResult: "requires_payment_method",
    lastFailureReason: "Card declined",
    updateCardRequired: true,
  },
};

const INVOICES: Record<string, unknown> = {
  "inv-1": {
    id: "inv-1",
    invoiceNumber: "INV-2001",
    status: "open",
    total: "300.00",
    balanceDue: "300.00",
    issuedAt: at(THIS_YEAR, 0, 5),
    displayMetadata: { patientName: "Ada Lovelace" },
  },
  "inv-2": {
    id: "inv-2",
    invoiceNumber: "INV-2002",
    status: "partially_paid",
    total: "300.00",
    balanceDue: "150.00",
    issuedAt: at(THIS_YEAR, 0, 9),
    displayMetadata: { patientName: "Grace Hopper" },
  },
};

const PAYMENTS = [
  {
    id: "pay-1",
    paidAt: THIS_MONTH_DATE,
    invoiceId: "inv-9",
    invoiceNumber: "INV-1900",
    patientName: "Ada Lovelace",
    amount: "120.00",
    paymentMethod: "card",
    referenceNumber: "ch_123",
  },
  {
    id: "pay-2",
    paidAt: LAST_MONTH_DATE,
    invoiceId: "inv-8",
    invoiceNumber: "INV-1800",
    patientName: "Grace Hopper",
    amount: "80.00",
    paymentMethod: "check",
    referenceNumber: null,
  },
];

interface ServerState {
  statements: Statement[];
  balances: Balance[];
  cases: unknown[];
  autoPayLabs: Array<typeof AUTOPAY_LAB>;
  /** Set to make the auto-pay save reject, the way the server does. */
  autoPayRejection: { status: number; error: string } | null;
  /** Set to answer preference reads with pre-save values instead of live ones. */
  stalePreferenceLabs: Array<typeof AUTOPAY_LAB> | null;
  payments: unknown[];
  failingInvoiceIds: Set<string>;
  checkout: { checkoutId: string; status: string; url: string | null };
  checkoutStatus: { checkoutId: string; status: string; failureReason?: string | null };
  /** Runs after the checkout POST, so a test can settle balances server-side. */
  onCheckout?: () => void;
}

let server: ServerState;
let sent: Array<{ url: string; method: string; body: string | null }>;

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function failure(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installServer(): void {
  setMockFetchHandler((url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    sent.push({ url, method, body });

    const statementDetailMatch = /\/api\/provider\/statements\/([^/?]+)/.exec(url);
    if (statementDetailMatch) {
      const statement = server.statements.find((row) => row.id === statementDetailMatch[1]);
      if (!statement) return failure(404, "Statement not found.");
      if (statement.invoiceIds.some((id) => server.failingInvoiceIds.has(id))) {
        return failure(500, "Invoice unavailable.");
      }
      return envelope({
        invoices: statement.invoiceIds.flatMap((id) => INVOICES[id] ? [INVOICES[id]] : []),
      });
    }
    if (url.includes("/api/provider/statements")) return envelope(server.statements);
    if (url.includes("/api/cases/provider")) return envelope(server.cases);
    if (url.includes("/api/provider/payment-history")) return envelope(server.payments);
    if (url.includes("/api/provider/payment-method")) {
      return envelope({ card: null, cards: [], hasCard: false });
    }
    if (url.includes("/api/provider/billing-preferences")) {
      return envelope({
        capabilities: { autoPayScheduling: true },
        subscription: { enabled: false, chargeDay: null },
        // A read can land behind a save this screen already made: a refetch
        // that started before the save, or a replica still catching up.
        labs: server.stalePreferenceLabs ?? server.autoPayLabs,
      });
    }
    const balanceMatch = /\/api\/billing\/([^/]+)\/accounts\/([^/]+)\/balance/.exec(url);
    if (balanceMatch) {
      const found = server.balances.find(
        (b) => b.labOrganizationId === balanceMatch[1],
      );
      return found ? envelope(found) : failure(404, "No balance for that account.");
    }
    const invoiceMatch = /\/api\/invoices\/([^/?]+)/.exec(url);
    if (invoiceMatch) {
      const id = invoiceMatch[1]!;
      if (server.failingInvoiceIds.has(id)) return failure(500, "Invoice unavailable.");
      const invoice = INVOICES[id];
      return invoice ? envelope(invoice) : failure(404, "Invoice not found.");
    }
    const autoPayMatch = /\/api\/provider\/labs\/([^/]+)\/invoice-autopay/.exec(url);
    if (autoPayMatch && method === "PATCH") {
      // A rejected save stores nothing, so the recorded preference is left
      // exactly as it was before the request.
      if (server.autoPayRejection) {
        return failure(server.autoPayRejection.status, server.autoPayRejection.error);
      }
      const requested = body
        ? (JSON.parse(body) as { enabled: boolean; chargeDay: number | null })
        : { enabled: false, chargeDay: null };
      const lab = server.autoPayLabs.find(
        (l) => l.providerOrganizationId === autoPayMatch[1],
      );
      if (lab) {
        lab.enabled = requested.enabled;
        lab.chargeDay = requested.chargeDay as number;
      }
      return envelope({
        lab: {
          enabled: requested.enabled,
          chargeDay: requested.chargeDay,
          authorization: lab?.authorization,
        },
      });
    }
    const cancelMatch = /\/api\/provider\/payment-checkout\/([^/]+)\/cancel/.exec(url);
    if (cancelMatch && method === "POST") {
      const checkoutId = cancelMatch[1]!;
      // Mirrors the server: cancelling releases a pending checkout, and a
      // checkout that already settled keeps the status it has.
      if (server.checkoutStatus.status === "pending") {
        server.checkoutStatus = { checkoutId, status: "cancelled" };
      }
      return envelope({ checkoutId, status: server.checkoutStatus.status });
    }
    if (url.includes("/api/provider/payment-checkout")) {
      if (method === "POST") {
        const input = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        // Mirrors the server's "full" mode: every currently payable invoice
        // for that provider organization, across all of its open statements.
        if (input.mode === "full" && typeof input.providerOrganizationId === "string") {
          const providerOrganizationId = input.providerOrganizationId;
          server.statements = server.statements.map((statement) =>
            statement.providerOrganizationId === providerOrganizationId
              ? { ...statement, balanceDue: "0.00" }
              : statement,
          );
          server.balances = server.balances.map((accountBalance) =>
            accountBalance.providerOrganizationId === providerOrganizationId
              ? { ...accountBalance, currentBalance: "0.00", openInvoiceCount: 0 }
              : accountBalance,
          );
        }
        server.onCheckout?.();
        return envelope(server.checkout);
      }
      return envelope(server.checkoutStatus);
    }
    return envelope(null);
  });
}

async function renderBilling(
  checkoutReturn: ProviderCheckoutReturnSignal | null = null,
  origin: "portal" | "settings" = "portal",
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = await render(
    <QueryClientProvider client={client}>
      <ProviderBillingSection checkoutReturn={checkoutReturn} origin={origin} />
    </QueryClientProvider>,
  );
  await flushPendingReactUpdates();
  return { ...utils, client };
}

/** The message currently shown in the section's notice banner. */
function noticeText(getByTestId: (id: string) => { props: Record<string, any> }): string {
  return getByTestId("provider-portal-billing-notice").props.children[0].props.children;
}

/**
 * Drive the app's real return handling for a link Stripe's bridge emits.
 * Returns which billing surface the link was delivered to.
 */
async function arriveFromStripe(url: string): Promise<"portal" | "settings"> {
  const parsed = parseProviderCheckoutReturnUrl(url);
  if (!parsed) throw new Error(`Not a provider return link: ${url}`);
  let surface: "portal" | "settings" = "settings";
  await act(async () => {
    surface = await deliverProviderCheckoutReturn(parsed);
  });
  return surface;
}

/** Foreground the app, the way returning from the Stripe browser tab does. */
async function foregroundApp(): Promise<void> {
  const listeners = (AppState.addEventListener as ReturnType<typeof vi.fn>).mock.calls
    .filter((call) => call[0] === "change")
    .map((call) => call[1] as (state: string) => void);
  await act(async () => {
    for (const listener of listeners) listener("active");
  });
  await flushPendingReactUpdates();
}

async function press(element: Parameters<typeof fireEvent.press>[0]): Promise<void> {
  await act(async () => {
    await fireEvent.press(element);
  });
  await flushPendingReactUpdates();
}

async function type(
  element: Parameters<typeof fireEvent.changeText>[0],
  text: string,
): Promise<void> {
  await act(async () => {
    await fireEvent.changeText(element, text);
  });
}

function requestsTo(fragment: string): Array<{ url: string; method: string; body: string | null }> {
  return sent.filter((request) => request.url.includes(fragment));
}

beforeEach(async () => {
  resetMockAppState();
  resetMockFetchHandler();
  resetProviderCheckoutReturn();
  (AppState.addEventListener as ReturnType<typeof vi.fn>).mockClear();
  sent = [];
  server = {
    statements: [OPEN_STATEMENT, PAID_THIS_YEAR, PAID_LAST_YEAR],
    balances: [balance("lab-north", "450.00", 2), balance("lab-south", "0.00", 0)],
    cases: CASES,
    autoPayLabs: [{ ...AUTOPAY_LAB }],
    autoPayRejection: null,
    stalePreferenceLabs: null,
    payments: PAYMENTS,
    failingInvoiceIds: new Set<string>(),
    checkout: { checkoutId: "co_1", status: "succeeded", url: null },
    checkoutStatus: { checkoutId: "co_1", status: "succeeded" },
  };
  installServer();
  (router.push as ReturnType<typeof vi.fn>).mockClear();
  (Linking.openURL as ReturnType<typeof vi.fn>).mockClear();
  (Linking.canOpenURL as ReturnType<typeof vi.fn>).mockClear();
  await AsyncStorage.clear();
});

afterEach(() => {
  cleanup();
  resetMockFetchHandler();
});

// ── Outstanding summary ────────────────────────────────────────────────────
describe("outstanding summary", () => {
  it("totals the account balances, counts open invoices and offers Pay My Bill", async () => {
    const { getByTestId } = await renderBilling();

    await waitFor(() =>
      expect(getByTestId("provider-portal-total-outstanding").props.children).toBe(
        "$450.00",
      ),
    );
    expect(getByTestId("provider-portal-open-case-count").props.children).toBe(2);
    expect(getByTestId("provider-portal-pay-my-bill-button")).toBeTruthy();
  });

  it("shows the all-caught-up zero state and hides Pay My Bill without an open statement", async () => {
    server.statements = [PAID_THIS_YEAR, PAID_LAST_YEAR];
    server.balances = [balance("lab-north", "0.00", 0), balance("lab-south", "0.00", 0)];
    server.cases = CASES.map((c) => ({ ...c, openInvoiceAmount: 0 }));

    const { getByTestId, getByText, queryByTestId } = await renderBilling();

    await waitFor(() =>
      expect(getByTestId("provider-portal-total-outstanding").props.children).toBe("$0.00"),
    );
    expect(getByTestId("provider-portal-open-case-count").props.children).toBe(0);
    expect(getByText("No outstanding balances. You're all caught up!")).toBeTruthy();
    expect(queryByTestId("provider-portal-pay-my-bill-button")).toBeNull();
    expect(getByTestId("provider-portal-open-cases-empty").props.children).toBe(
      "No cases with outstanding balances.",
    );
  });
});

// ── All-or-nothing invoice load ────────────────────────────────────────────
describe("starting a payment", () => {
  it("uses live eligibility and balance when historical statement status differs", async () => {
    const reopened = {
      id: "reopened",
      invoiceNumber: "INV-REOPENED",
      status: "paid",
      balanceDue: "0.00",
      currentBalanceDue: "25.00",
      eligibleForPayment: true,
    };
    const voided = {
      id: "voided",
      invoiceNumber: "INV-VOIDED",
      status: "open",
      balanceDue: "50.00",
      currentBalanceDue: "0.00",
      eligibleForPayment: false,
    };
    expect(isPayable(reopened)).toBe(true);
    expect(isPayable(voided)).toBe(false);
    expect(allocatePayment([reopened, voided], 50))
      .toEqual([{ invoiceId: "reopened", amount: 25 }]);
  });

  it("opens the payment flow only after every invoice on the statement loads", async () => {
    const { getByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("provider-portal-pay-my-bill-button")).toBeTruthy());

    await press(getByTestId("provider-portal-pay-my-bill-button"));

    await waitFor(() => expect(getByTestId("provider-portal-pay-my-bill")).toBeTruthy());
    expect(requestsTo("/api/provider/statements/st-open")).toHaveLength(1);
    expect(getByTestId("pay-my-bill-balance").props.children).toEqual([
      "Balance due: ",
      "$450.00",
    ]);
  });

  it("refuses to open the payment flow when one invoice fails to load, and says why", async () => {
    server.failingInvoiceIds = new Set(["inv-2"]);
    const { getByTestId, queryByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("provider-portal-pay-my-bill-button")).toBeTruthy());

    await press(getByTestId("provider-portal-pay-my-bill-button"));

    await waitFor(() =>
      expect(getByTestId("provider-portal-pay-my-bill-error").props.children).toBe(
        "Could not load invoices: Request failed (500).",
      ),
    );
    expect(queryByTestId("provider-portal-pay-my-bill")).toBeNull();
  });
});

// ── Paying the whole account balance ───────────────────────────────────────
// A relationship's balance covers every open statement it has, so this is the
// one action that settles all of them at once. Both provider entry points
// render this section, so both offer it.
describe("paying a whole account balance", () => {
  beforeEach(() => {
    server.statements = [OPEN_STATEMENT, SECOND_OPEN_STATEMENT, PAID_LAST_YEAR];
    server.balances = [balance("lab-north", "650.00", 3), balance("lab-south", "0.00", 0)];
    server.checkout = {
      checkoutId: "co_full",
      status: "pending",
      url: "https://checkout.stripe.test/full",
    };
    server.checkoutStatus = { checkoutId: "co_full", status: "pending" };
  });

  it("settles every open statement for the lab in one checkout", async () => {
    const { getByTestId, getByText, queryByTestId } = await renderBilling();
    await waitFor(() =>
      expect(getByTestId("provider-portal-total-outstanding").props.children).toBe(
        "$650.00",
      ),
    );

    await press(getByTestId("provider-portal-pay-full-balance-prac-1"));

    const [request] = requestsTo("/api/provider/payment-checkout");
    const payload = JSON.parse(request!.body!) as Record<string, unknown>;
    // Account-wide rather than statement-scoped: the server resolves every
    // payable invoice for the relationship, so no open statement is left
    // behind and the client cannot underpay from a stale list.
    expect(payload).toMatchObject({ mode: "full", providerOrganizationId: "prac-1" });
    expect(payload.allocations).toBeUndefined();
    expect(payload.invoiceIds).toBeUndefined();
    expect(Linking.openURL).toHaveBeenCalledWith("https://checkout.stripe.test/full");

    // Coming back from Stripe confirms the one checkout, and both statements
    // are settled by it.
    server.checkoutStatus = { checkoutId: "co_full", status: "succeeded" };
    await foregroundApp();

    await waitFor(() =>
      expect(getByTestId("provider-portal-total-outstanding").props.children).toBe(
        "$0.00",
      ),
    );
    expect(getByText("No outstanding balances. You're all caught up!")).toBeTruthy();
    expect(queryByTestId("provider-portal-pay-full-balance-prac-1")).toBeNull();
    expect(requestsTo("/api/provider/payment-checkout").filter((r) => r.method === "POST"))
      .toHaveLength(1);
  });

  it("brings a settings-launched account payment back to the settings screen", async () => {
    const { getByTestId } = await renderBilling(null, "settings");
    await waitFor(() =>
      expect(getByTestId("provider-portal-pay-full-balance-prac-1")).toBeTruthy(),
    );

    await press(getByTestId("provider-portal-pay-full-balance-prac-1"));

    const pending = JSON.parse(
      (await AsyncStorage.getItem(PROVIDER_CHECKOUT_PENDING_KEY))!,
    ) as Record<string, unknown>;
    expect(pending).toMatchObject({
      checkoutId: "co_full",
      mode: "full",
      providerOrganizationId: "prac-1",
      origin: "settings",
    });
    // Stripe's link says a return happened, never where the payment started;
    // the recorded origin sends it back to the surface that launched it.
    expect(await arriveFromStripe("labtrax://provider-billing?returned=1")).toBe(
      "settings",
    );
  });

  it("offers no full-balance payment for a relationship that owes nothing", async () => {
    server.statements = [PAID_THIS_YEAR, PAID_LAST_YEAR];
    server.balances = [balance("lab-north", "0.00", 0), balance("lab-south", "0.00", 0)];

    const { getByTestId, queryByTestId } = await renderBilling();
    await waitFor(() =>
      expect(getByTestId("provider-portal-total-outstanding").props.children).toBe(
        "$0.00",
      ),
    );
    expect(queryByTestId("provider-portal-pay-full-balance-prac-1")).toBeNull();
  });
});

// ── Open cases ─────────────────────────────────────────────────────────────
describe("open cases", () => {
  it("lists only cases with a balance and opens the case's invoice detail", async () => {
    const { getByTestId, queryByTestId } = await renderBilling();

    await waitFor(() => expect(getByTestId("provider-portal-open-case-case-1")).toBeTruthy());
    expect(queryByTestId("provider-portal-open-case-case-3")).toBeNull();

    await press(getByTestId("provider-portal-open-case-case-2"));

    expect(router.push).toHaveBeenCalledWith({
      pathname: "/case/provider/[id]",
      params: { id: "case-2", invoice: "1" },
    });
  });
});

// ── Statements ─────────────────────────────────────────────────────────────
describe("statements", () => {
  it("keeps statements with a balance open and moves paid ones into the archive", async () => {
    const { getByTestId, queryByTestId, getByText } = await renderBilling();

    await waitFor(() => expect(getByTestId("provider-portal-statement-st-open")).toBeTruthy());
    expect(queryByTestId("provider-portal-statement-st-paid-this-year")).toBeNull();
    expect(getByText("2 paid statements")).toBeTruthy();

    await press(getByTestId("past-statements-toggle"));

    // "This year" is the default archive filter.
    expect(getByTestId("provider-portal-past-statement-st-paid-this-year")).toBeTruthy();
    expect(queryByTestId("provider-portal-past-statement-st-paid-last-year")).toBeNull();
  });

  it("filters the archive by last year, a custom range, and a lab-name search", async () => {
    const { getByTestId, queryByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("past-statements-toggle")).toBeTruthy());
    await press(getByTestId("past-statements-toggle"));

    await press(getByTestId("past-statements-filter-last_year"));
    expect(getByTestId("provider-portal-past-statement-st-paid-last-year")).toBeTruthy();
    expect(queryByTestId("provider-portal-past-statement-st-paid-this-year")).toBeNull();

    await press(getByTestId("past-statements-filter-custom"));
    await type(getByTestId("past-statements-from"), `${LAST_YEAR}-01-01`);
    await type(getByTestId("past-statements-to"), `${LAST_YEAR}-12-31`);
    expect(getByTestId("provider-portal-past-statement-st-paid-last-year")).toBeTruthy();
    expect(queryByTestId("provider-portal-past-statement-st-paid-this-year")).toBeNull();

    // Search narrows within the selected period.
    await press(getByTestId("past-statements-filter-this_year"));
    await type(getByTestId("past-statements-lab-search"), "northline");
    expect(getByTestId("provider-portal-past-statement-st-paid-this-year")).toBeTruthy();

    await type(getByTestId("past-statements-lab-search"), "southgate");
    expect(getByTestId("past-statements-empty")).toBeTruthy();
  });

  it("names the field a fruitless search was read as", async () => {
    const { getByTestId, getByText } = await renderBilling();
    await waitFor(() => expect(getByTestId("past-statements-toggle")).toBeTruthy());
    await press(getByTestId("past-statements-toggle"));

    await type(getByTestId("past-statements-lab-search"), "9");
    expect(getByText("No statements match that invoice count")).toBeTruthy();

    await type(getByTestId("past-statements-lab-search"), "12/25");
    expect(getByText("No statements match that date")).toBeTruthy();

    await type(getByTestId("past-statements-lab-search"), "westside");
    expect(getByText("No statements match that lab name")).toBeTruthy();
  });

  it("finds an archived statement by its invoice count", async () => {
    const { getByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("past-statements-toggle")).toBeTruthy());
    await press(getByTestId("past-statements-toggle"));

    await type(getByTestId("past-statements-lab-search"), "3");
    expect(getByTestId("provider-portal-past-statement-st-paid-this-year")).toBeTruthy();
  });
});

// ── Payment history ────────────────────────────────────────────────────────
describe("payment history", () => {
  it("loads on expand and filters by this month, last month and a custom range", async () => {
    const { getByTestId, queryByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("payment-history-toggle")).toBeTruthy());
    expect(requestsTo("/api/provider/payment-history")).toHaveLength(0);

    await press(getByTestId("payment-history-toggle"));
    await waitFor(() => expect(getByTestId("payment-history-row-pay-1")).toBeTruthy());
    expect(queryByTestId("payment-history-row-pay-2")).toBeNull();

    await press(getByTestId("payment-history-filter-last_month"));
    expect(getByTestId("payment-history-row-pay-2")).toBeTruthy();
    expect(queryByTestId("payment-history-row-pay-1")).toBeNull();

    await press(getByTestId("payment-history-filter-custom"));
    await type(getByTestId("payment-history-from"), `${THIS_YEAR}-01-01`);
    await type(getByTestId("payment-history-to"), `${THIS_YEAR}-12-31`);
    expect(getByTestId("payment-history-row-pay-1")).toBeTruthy();

    await type(getByTestId("payment-history-from"), `${LAST_YEAR}-01-01`);
    await type(getByTestId("payment-history-to"), `${LAST_YEAR}-12-31`);
    expect(getByTestId("payment-history-empty")).toBeTruthy();
  });
});

// ── Per-lab auto-pay ───────────────────────────────────────────────────────
describe("invoice auto-pay by lab", () => {
  it("rejects a charge day outside 1–10 without sending anything", async () => {
    const { getByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("provider-portal-autopay-prac-1")).toBeTruthy());

    await type(getByTestId("provider-portal-autopay-day-prac-1"), "12");
    await press(getByTestId("provider-portal-autopay-save-prac-1"));

    expect(getByTestId("provider-portal-billing-notice")).toBeTruthy();
    expect(getByTestId("provider-portal-billing-notice").props.children[0].props.children).toBe(
      "Invoice auto-pay charge day must be from 1 through 10.",
    );
    expect(requestsTo("/invoice-autopay")).toHaveLength(0);
  });

  it("saves the toggle and charge day, and keeps showing what was saved", async () => {
    const { getByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("provider-portal-autopay-prac-1")).toBeTruthy());

    await act(async () => {
      await fireEvent(getByTestId("provider-portal-autopay-enable-prac-1"), "valueChange", true);
    });
    await type(getByTestId("provider-portal-autopay-day-prac-1"), "7");
    await press(getByTestId("provider-portal-autopay-save-prac-1"));

    const saves = requestsTo("/invoice-autopay");
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0]!.body as string)).toEqual({ enabled: true, chargeDay: 7 });
    await waitFor(() =>
      expect(
        getByTestId("provider-portal-billing-notice").props.children[0].props.children,
      ).toBe("Northline Dental Lab invoice auto-pay preference saved."),
    );
    expect(getByTestId("provider-portal-autopay-day-prac-1").props.value).toBe("7");
  });

  // A rejected save is the dangerous one: the provider walks away believing
  // the lab will charge them, and nothing ever runs. The reason has to be the
  // server's, and the controls have to fall back to what the server confirmed.
  it("shows the server's refusal and keeps the last confirmed schedule", async () => {
    server.autoPayRejection = {
      status: 409,
      error: "Your signed auto-pay authorization has expired. Sign a new one to continue.",
    };
    const { getByTestId, queryByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("provider-portal-autopay-prac-1")).toBeTruthy());

    await act(async () => {
      await fireEvent(getByTestId("provider-portal-autopay-enable-prac-1"), "valueChange", true);
    });
    await type(getByTestId("provider-portal-autopay-day-prac-1"), "3");
    await press(getByTestId("provider-portal-autopay-save-prac-1"));

    await waitFor(() =>
      expect(noticeText(getByTestId)).toBe(
        "Your signed auto-pay authorization has expired. Sign a new one to continue.",
      ),
    );
    expect(noticeText(getByTestId)).not.toBe(
      "Northline Dental Lab invoice auto-pay preference saved.",
    );
    // Back to the preference the server confirmed (off, day 5) rather than the
    // one it refused (on, day 3), so nothing on screen implies auto-pay runs.
    expect(getByTestId("provider-portal-autopay-enable-prac-1").props.value).toBe(false);
    expect(getByTestId("provider-portal-autopay-day-prac-1").props.value).toBe("5");
    expect(server.autoPayLabs[0]!.enabled).toBe(false);
    // The refusal is not retried behind the provider's back, and the row is
    // usable again so they can act on the reason they were given.
    expect(requestsTo("/invoice-autopay")).toHaveLength(1);
    expect(getByTestId("provider-portal-autopay-save-prac-1").props.accessibilityState?.disabled)
      .toBeFalsy();
    expect(queryByTestId("provider-portal-recheck-payment")).toBeNull();
  });

  // The reads that back this screen can land behind a save it already made,
  // so a refusal must restore what the save confirmed — not what a stale read
  // still reports, which would understate a schedule the lab will charge on.
  it("restores the saved schedule even when preference reads lag behind", async () => {
    // Every later read answers with the pre-save preference.
    server.stalePreferenceLabs = [{ ...AUTOPAY_LAB }];
    const { getByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("provider-portal-autopay-prac-1")).toBeTruthy());

    await act(async () => {
      await fireEvent(getByTestId("provider-portal-autopay-enable-prac-1"), "valueChange", true);
    });
    await type(getByTestId("provider-portal-autopay-day-prac-1"), "7");
    await press(getByTestId("provider-portal-autopay-save-prac-1"));
    await waitFor(() =>
      expect(noticeText(getByTestId)).toBe(
        "Northline Dental Lab invoice auto-pay preference saved.",
      ),
    );

    server.autoPayRejection = {
      status: 409,
      error: "Changing the charge day needs a new signed authorization.",
    };
    await type(getByTestId("provider-portal-autopay-day-prac-1"), "9");
    await press(getByTestId("provider-portal-autopay-save-prac-1"));

    await waitFor(() =>
      expect(noticeText(getByTestId)).toBe(
        "Changing the charge day needs a new signed authorization.",
      ),
    );
    // The schedule the save confirmed (on, day 7) — not the refused day 9, and
    // not the pre-save values the lagging read still reports.
    expect(getByTestId("provider-portal-autopay-enable-prac-1").props.value).toBe(true);
    expect(getByTestId("provider-portal-autopay-day-prac-1").props.value).toBe("7");
  });

  it("sends no charge day when auto-pay is switched off", async () => {
    server.autoPayLabs = [{ ...AUTOPAY_LAB, enabled: true, chargeDay: 5 }];
    const { getByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("provider-portal-autopay-prac-1")).toBeTruthy());

    await act(async () => {
      await fireEvent(getByTestId("provider-portal-autopay-enable-prac-1"), "valueChange", false);
    });
    await press(getByTestId("provider-portal-autopay-save-prac-1"));

    const saves = requestsTo("/invoice-autopay");
    expect(JSON.parse(saves[0]!.body as string)).toEqual({ enabled: false, chargeDay: null });
  });
});

// ── Payment completion and return ──────────────────────────────────────────
describe("completing a payment", () => {
  it("refreshes balances, statements and cases in place once the payment settles", async () => {
    server.onCheckout = () => {
      server.statements = [
        { ...OPEN_STATEMENT, balanceDue: "0.00" },
        PAID_THIS_YEAR,
        PAID_LAST_YEAR,
      ];
      server.balances = [balance("lab-north", "0.00", 0), balance("lab-south", "0.00", 0)];
      server.cases = CASES.map((c) => ({ ...c, openInvoiceAmount: 0 }));
    };

    const { getByTestId, queryByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("provider-portal-pay-my-bill-button")).toBeTruthy());
    await press(getByTestId("provider-portal-pay-my-bill-button"));
    await waitFor(() => expect(getByTestId("provider-portal-pay-my-bill")).toBeTruthy());

    await press(getByTestId("pay-my-bill-submit"));

    await waitFor(() =>
      expect(getByTestId("provider-portal-total-outstanding").props.children).toBe("$0.00"),
    );
    expect(queryByTestId("provider-portal-pay-my-bill")).toBeNull();
    expect(queryByTestId("provider-portal-statement-st-open")).toBeNull();
    expect(queryByTestId("provider-portal-open-case-case-1")).toBeNull();
    expect(
      getByTestId("provider-portal-billing-notice").props.children[0].props.children,
    ).toBe("Stripe confirmed your payment. Your balances are refreshed.");
  });

  it("reports a still-confirming checkout and can re-check it after the return", async () => {
    server.checkout = {
      checkoutId: "co_2",
      status: "pending",
      url: "https://checkout.stripe.test/c/co_2",
    };
    server.checkoutStatus = { checkoutId: "co_2", status: "pending" };

    const { getByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("provider-portal-pay-my-bill-button")).toBeTruthy());
    await press(getByTestId("provider-portal-pay-my-bill-button"));
    await waitFor(() => expect(getByTestId("provider-portal-pay-my-bill")).toBeTruthy());
    await press(getByTestId("pay-my-bill-submit"));

    await waitFor(() =>
      expect(
        getByTestId("provider-portal-billing-notice").props.children[0].props.children,
      ).toBe(
        "Stripe is still confirming this payment. No invoice has been marked paid yet.",
      ),
    );
    expect(Linking.openURL).toHaveBeenCalledWith("https://checkout.stripe.test/c/co_2");

    // Still pending on the first re-check: nothing is treated as paid.
    await press(getByTestId("provider-portal-recheck-payment"));
    await waitFor(() =>
      expect(
        getByTestId("provider-portal-billing-notice").props.children[0].props.children,
      ).toBe(
        "Stripe is still confirming this payment. No invoice has been marked paid yet.",
      ),
    );

    server.checkoutStatus = { checkoutId: "co_2", status: "succeeded" };
    await press(getByTestId("provider-portal-recheck-payment"));

    await waitFor(() =>
      expect(
        getByTestId("provider-portal-billing-notice").props.children[0].props.children,
      ).toBe("Stripe confirmed your payment. Your balances are refreshed."),
    );
  });

  it("surfaces a declined checkout without marking anything paid", async () => {
    server.checkout = {
      checkoutId: "co_3",
      status: "pending",
      url: "https://checkout.stripe.test/c/co_3",
    };
    server.checkoutStatus = { checkoutId: "co_3", status: "failed", failureReason: null };

    const { getByTestId } = await renderBilling();
    await waitFor(() => expect(getByTestId("provider-portal-pay-my-bill-button")).toBeTruthy());
    await press(getByTestId("provider-portal-pay-my-bill-button"));
    await waitFor(() => expect(getByTestId("provider-portal-pay-my-bill")).toBeTruthy());
    await press(getByTestId("pay-my-bill-submit"));
    await waitFor(() => expect(getByTestId("provider-portal-recheck-payment")).toBeTruthy());

    await press(getByTestId("provider-portal-recheck-payment"));

    await waitFor(() =>
      expect(
        getByTestId("provider-portal-billing-notice").props.children[0].props.children,
      ).toBe("Stripe could not complete this payment. No invoice was marked paid."),
    );
    expect(getByTestId("provider-portal-statement-st-open")).toBeTruthy();
  });
});

// ── Coming back from Stripe ────────────────────────────────────────────────
// Stripe's hosted page returns through a deep link that only says a return
// happened. These cover the whole path the app really takes: the link is
// parsed, delivered to the surface that launched the checkout, and reconciled
// against the server.
describe("returning from hosted checkout", () => {
  /** Record a checkout the portal launched, as PayMyBillSheet does. */
  async function pendingPortalCheckout(checkoutId: string): Promise<void> {
    await AsyncStorage.setItem(
      PROVIDER_CHECKOUT_PENDING_KEY,
      JSON.stringify({
        mode: "pay-my-bill:st-open",
        checkoutId,
        idempotencyKey: "mobile-provider-test",
        invoiceIds: ["inv-1", "inv-2"],
        amount: "450.00",
        providerOrganizationId: "prac-1",
        origin: "portal",
      }),
    );
  }

  it("keeps a portal-launched return in the portal instead of the settings screen", async () => {
    await pendingPortalCheckout("co_5");
    server.checkoutStatus = { checkoutId: "co_5", status: "succeeded" };

    const surface = await arriveFromStripe("labtrax://provider-billing?returned=1");

    expect(surface).toBe("portal");
    expect(router.push).not.toHaveBeenCalled();
    const signal = latestProviderCheckoutReturn();
    expect(signal?.checkoutId).toBe("co_5");

    // The portal shell hands the signal to the section, which reconciles it.
    const { getByTestId } = await renderBilling(signal);
    await waitFor(() =>
      expect(noticeText(getByTestId)).toBe(
        "Stripe confirmed your payment. Your balances are refreshed.",
      ),
    );
    expect(await AsyncStorage.getItem(PROVIDER_CHECKOUT_PENDING_KEY)).toBeNull();
  });

  it("releases the checkout the provider backed out of, rather than reporting it as confirming", async () => {
    await pendingPortalCheckout("co_6");
    // Stripe leaves a backed-out checkout pending on the server.
    server.checkoutStatus = { checkoutId: "co_6", status: "pending" };

    const surface = await arriveFromStripe(
      "labtrax://provider-billing?returned=1&cancelled=1",
    );
    expect(surface).toBe("portal");

    const { getByTestId } = await renderBilling(latestProviderCheckoutReturn());

    await waitFor(() =>
      expect(noticeText(getByTestId)).toBe(
        "Checkout was cancelled. No invoice was marked paid.",
      ),
    );
    expect(requestsTo("/payment-checkout/co_6/cancel")).toHaveLength(1);
    // The reservation is released, so the statement can be paid again.
    expect(await AsyncStorage.getItem(PROVIDER_CHECKOUT_PENDING_KEY)).toBeNull();
    expect(getByTestId("provider-portal-statement-st-open")).toBeTruthy();
  });

  it("still releases a cancelled checkout when the app is relaunched before it can", async () => {
    await pendingPortalCheckout("co_7");
    server.checkoutStatus = { checkoutId: "co_7", status: "pending" };

    // The cancel is recorded while the app is locked (or is killed on return);
    // nothing renders until the next launch.
    await arriveFromStripe("labtrax://provider-billing?returned=1&cancelled=1");
    resetProviderCheckoutReturn();

    const { getByTestId } = await renderBilling();

    await waitFor(() =>
      expect(noticeText(getByTestId)).toBe(
        "Checkout was cancelled. No invoice was marked paid.",
      ),
    );
    expect(requestsTo("/payment-checkout/co_7/cancel")).toHaveLength(1);
  });

  it("confirms a payment that settles while the app is in the background", async () => {
    await pendingPortalCheckout("co_8");
    server.checkoutStatus = { checkoutId: "co_8", status: "pending" };

    const { getByTestId } = await renderBilling();
    await waitFor(() =>
      expect(noticeText(getByTestId)).toBe(
        "Stripe is still confirming this payment. No invoice has been marked paid yet.",
      ),
    );

    server.checkoutStatus = { checkoutId: "co_8", status: "succeeded" };
    server.statements = [
      { ...OPEN_STATEMENT, balanceDue: "0.00" },
      PAID_THIS_YEAR,
      PAID_LAST_YEAR,
    ];
    server.balances = [balance("lab-north", "0.00", 0), balance("lab-south", "0.00", 0)];
    await foregroundApp();

    await waitFor(() =>
      expect(noticeText(getByTestId)).toBe(
        "Stripe confirmed your payment. Your balances are refreshed.",
      ),
    );
    await waitFor(() =>
      expect(getByTestId("provider-portal-total-outstanding").props.children).toBe("$0.00"),
    );
    // Nothing was cancelled: the provider completed this payment.
    expect(requestsTo("/payment-checkout/co_8/cancel")).toHaveLength(0);
  });

  it("sends a settings-launched return, and every card setup, to the settings screen", async () => {
    // No origin recorded: the settings screen started this one.
    await AsyncStorage.setItem(
      PROVIDER_CHECKOUT_PENDING_KEY,
      JSON.stringify({ mode: "invoice", checkoutId: "co_9" }),
    );

    expect(await arriveFromStripe("labtrax://provider-billing?checkoutId=co_9")).toBe(
      "settings",
    );
    expect(router.push).toHaveBeenCalledWith("/settings/provider-billing?checkoutId=co_9");
    expect(latestProviderCheckoutReturn()).toBeNull();

    // A card setup belongs to the settings screen even while the portal has a
    // payment of its own waiting.
    await pendingPortalCheckout("co_10");
    expect(
      await arriveFromStripe(
        "https://labtrax.test/provider-billing?returned=1&providerCardSetupSession=seti_1",
      ),
    ).toBe("settings");
    expect(router.push).toHaveBeenCalledWith(
      "/settings/provider-billing?providerCardSetupSession=seti_1",
    );
    expect(latestProviderCheckoutReturn()).toBeNull();
  });

  it("reads a return out of both link shapes and never trusts it as an outcome", async () => {
    expect(parseProviderCheckoutReturnUrl("labtrax://provider-billing?returned=1")).toEqual({
      checkoutId: null,
      cardSetupSession: null,
      cancelled: false,
    });
    expect(
      parseProviderCheckoutReturnUrl(
        "https://labtrax.test/provider-billing?providerPaymentCheckout=co_11&cancelled=1",
      ),
    ).toEqual({ checkoutId: "co_11", cardSetupSession: null, cancelled: true });
    // Unrelated deep links are left alone.
    expect(parseProviderCheckoutReturnUrl("labtrax://share?file=/tmp/scan.pdf")).toBeNull();
    expect(parseProviderCheckoutReturnUrl("https://labtrax.test/cases/SYN-CASE-001")).toBeNull();
  });
});
