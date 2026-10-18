/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Route, Router, Switch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import ReceivePaymentsPage from "@/pages/finance/receive-payments";
import MakeDepositsPage from "@/pages/finance/make-deposits";
import AgingPage from "@/pages/finance/aging";
import { LabFinanceRoute } from "@/components/finance/FinanceShell";
import { AuthContext, type AuthContextValue } from "@/lib/auth-context";
import { formatDate } from "@/lib/format";
import { MOCK_AUTH_DEFAULTS, makeQueryClient } from "../../__tests__/test-utils";
import { receivePaymentRoute, receivePaymentRouteRefusal } from "../../__tests__/receive-payment-routes";

// The selection surface of Receive Payments: heads-up cards, the Customers /
// Invoices / Aging / Statements tabs, saved selections, the Payment Summary
// defaults and options, and the gate on the user's role in the selected lab.

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: unknown }) => children,
  PaymentElement: () => null,
  useStripe: () => null,
  useElements: () => null,
}));
vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn(async () => null) }));

// Local-noon dates keep days past due whole and independent of the clock.
const today = new Date();
const day = (offset: number) =>
  new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 12).toISOString();

type Invoice = {
  id: string;
  invoiceNumber: string;
  patientName: string;
  doctorName: string;
  issuedAt: string;
  dueAt: string;
  total: string;
  currentDue: string;
  currentBalanceDue: string;
  eligibleForPayment: boolean;
};
const invoice = (
  id: string,
  invoiceNumber: string,
  doctorName: string,
  issued: number,
  due: number,
  total: string,
  balance: string,
): Invoice => ({
  id,
  invoiceNumber,
  patientName: `Patient ${invoiceNumber}`,
  doctorName,
  issuedAt: day(issued),
  dueAt: day(due),
  total,
  currentDue: balance,
  currentBalanceDue: balance,
  eligibleForPayment: true,
});

// Alpha: a sent statement covering a1+a2 ($150) plus a3, not on it ($180 owed).
// Beta: a statement covering everything it owes ($250, 95 days past due).
// Gamma: no statement, nothing past due, no account details on file.
const INVOICES = {
  a1: invoice("a1", "INV-1001", "Dr. Ada Smith", -70, -40, "100.00", "100.00"),
  a2: invoice("a2", "INV-1002", "Dr. Ada Smith", -40, -10, "80.00", "50.00"),
  a3: invoice("a3", "INV-1003", "Dr. Ada Smith", -10, 20, "30.00", "30.00"),
  b1: invoice("b1", "INV-2001", "Dr. Ben Cole", -125, -95, "400.00", "250.00"),
  g1: invoice("g1", "INV-3001", "Dr. Gia Park", -5, 25, "60.00", "60.00"),
  g2: invoice("g2", "INV-3002", "Dr. Gia Park", -3, 27, "40.00", "40.00"),
};
const LAST_ALPHA_PAYMENT = day(-5);
const LAST_BETA_PAYMENT = day(-40);
const ALPHA = { accountNumber: "LT-1001", city: "Austin", state: "TX", lastPaymentAt: LAST_ALPHA_PAYMENT, lastPaymentAmount: "75.00" };
const BETA = { accountNumber: "LT-1002", city: "Denver", state: "CO", lastPaymentAt: LAST_BETA_PAYMENT, lastPaymentAmount: "150.00" };
const GAMMA = { accountNumber: null, city: null, state: null, lastPaymentAt: null, lastPaymentAmount: null };

const statementAccount = (
  id: string,
  name: string,
  statementId: string,
  invoices: Invoice[],
  balance: string,
  doctorNames: string[],
  details: Record<string, unknown>,
) => ({
  providerOrganizationId: id,
  providerName: name,
  statementId,
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  sentAt: "2026-09-01",
  sentDates: ["2026-09-01"],
  statementCount: 1,
  invoiceCount: invoices.length,
  currentBalanceDue: balance,
  doctorNames,
  outstandingInvoices: invoices,
  statements: [
    {
      statementId,
      sentAt: "2026-09-01",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      invoiceCount: invoices.length,
      invoiceIds: invoices.map((row) => row.id),
    },
  ],
  ...details,
});
const invoiceAccount = (
  id: string,
  name: string,
  invoices: Invoice[],
  balance: string,
  doctorNames: string[],
  details: Record<string, unknown>,
) => ({
  providerOrganizationId: id,
  providerName: name,
  invoiceCount: invoices.length,
  currentBalanceDue: balance,
  doctorNames,
  outstandingInvoices: invoices,
  ...details,
});

const STATEMENT_ACCOUNTS = [
  statementAccount("alpha", "Alpha Dental", "st-a", [INVOICES.a1, INVOICES.a2], "150.00", ["Dr. Ada Smith"], ALPHA),
  statementAccount("beta", "Beta Smiles", "st-b", [INVOICES.b1], "250.00", ["Dr. Ben Cole"], BETA),
];
const INVOICE_ACCOUNTS = [
  invoiceAccount("alpha", "Alpha Dental", [INVOICES.a1, INVOICES.a2, INVOICES.a3], "180.00", ["Dr. Ada Smith"], ALPHA),
  invoiceAccount("beta", "Beta Smiles", [INVOICES.b1], "250.00", ["Dr. Ben Cole"], BETA),
  invoiceAccount("gamma", "Gamma Ortho", [INVOICES.g1, INVOICES.g2], "100.00", ["Dr. Gia Park"], GAMMA),
];
const STATEMENT_DETAILS: Record<string, { balance: string; invoices: Invoice[] }> = {
  "st-a": { balance: "150.00", invoices: [INVOICES.a1, INVOICES.a2] },
  "st-b": { balance: "250.00", invoices: [INVOICES.b1] },
};
const STATEMENT_HISTORY: Record<string, unknown[]> = {
  alpha: [{ id: "st-a", periodEnd: "2026-08-31", savedBalanceDue: "150.00", invoiceCount: 2 }],
  beta: [{ id: "st-b", periodEnd: "2026-08-31", savedBalanceDue: "250.00", invoiceCount: 1 }],
  gamma: [],
};
const SAVED_SELECTIONS_KEY = "labtrax_receive_payment_selections_v1:u:lab";
const AGING_BUCKETS = [
  { key: "current", label: "Current" },
  { key: "d1_30", label: "1–30" },
  { key: "d31_60", label: "31–60" },
  { key: "d61_90", label: "61–90" },
  { key: "d90_plus", label: "90+" },
];
const NO_AGING = { current: "0.00", d1_30: "0.00", d31_60: "0.00", d61_90: "0.00", d90_plus: "0.00" };
const AR_AGING_REPORT = {
  basis: "accrual",
  asOf: "2026-09-30T23:59:59.999Z",
  buckets: AGING_BUCKETS,
  rows: [
    {
      customerId: "c1",
      customerName: "Smile Dental",
      buckets: { ...NO_AGING, d1_30: "75.00" },
      total: "75.00",
      unappliedCredit: "0.00",
      invoices: [],
    },
  ],
  totals: { ...NO_AGING, d1_30: "75.00" },
  total: "75.00",
  unappliedCreditTotal: "0.00",
  limitations: [],
};

let requests: Array<{ path: string; method: string; body: any }> = [];
let paymentPosts: any[] = [];
// The user's role in the selected lab; null when they are not a member.
let labRole: string | null = "admin";
let roleCheckPending = false;
let failingList: "statement" | "invoice" | null = null;
let listGate: Promise<void> | null = null;
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function eligibleAccounts(list: "statement" | "invoice", rows: unknown[]) {
  if (listGate) await listGate;
  return failingList === list ? response({ message: "Balances unavailable" }, 500) : response(rows);
}

beforeEach(() => {
  localStorage.clear();
  requests = [];
  paymentPosts = [];
  labRole = "admin";
  roleCheckPending = false;
  failingList = null;
  listGate = null;
  vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), "http://localhost");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    if (path.endsWith("/organizations")) return response([{ id: "lab", name: "Lab", type: "lab" }]);
    if (path.endsWith("/auth/me")) {
      if (roleCheckPending) return new Promise<Response>(() => {});
      return response({
        user: { id: "u", role: "admin", userType: "lab" },
        memberships: labRole
          ? [{ organizationId: "lab", role: labRole, status: "active", organization: { id: "lab", name: "Lab" } }]
          : [],
      });
    }
    if (path.endsWith("/finance/accounts")) return response([]);
    if (path.endsWith("/finance/undeposited-funds")) {
      return response(url.searchParams.get("summary") === "1" ? { count: 0, total: 0 } : []);
    }
    if (path.endsWith("/finance/reports/ar-aging")) return response(AR_AGING_REPORT);
    if (path.endsWith("/billing/lab/eligible-statement-accounts")) return eligibleAccounts("statement", STATEMENT_ACCOUNTS);
    if (path.endsWith("/billing/lab/eligible-invoice-accounts")) return eligibleAccounts("invoice", INVOICE_ACCOUNTS);
    if (path.endsWith("/provider/lab-card")) return response({ card: null });
    if (path.endsWith("/billing/payment-sessions/card/config")) return response({ publishableKey: "pk_test" });
    if (path.endsWith("/customer-credits")) return response({ totalAvailable: "0.00", credits: [] });
    const statementId = path.match(/statements\/([^/]+)$/)?.[1];
    if (statementId) {
      const detail = STATEMENT_DETAILS[statementId];
      if (!detail) return response({ message: "Not found" }, 404);
      return response({
        id: statementId,
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        savedBalanceDue: detail.balance,
        invoiceCount: detail.invoices.length,
        invoices: detail.invoices,
      });
    }
    const account = path.match(/accounts\/([^/]+)\/statements/)?.[1];
    if (account) return response(STATEMENT_HISTORY[account] ?? []);
    const route = receivePaymentRoute(path);
    if (route && method === "POST") {
      paymentPosts.push(body);
      const refusal = receivePaymentRouteRefusal(route, body);
      if (refusal) return response({ ok: false, message: refusal }, 400);
      return response({ id: "session-1", customerEmail: "billing@alpha.test", receiptNumber: "R-1" }, 201);
    }
    if (path.endsWith("/payment-receipt-template")) {
      return response({ emailSubject: "Receipt {{receiptNumber}}", emailBody: "Thanks {{customerName}}" });
    }
    if (path.endsWith("/send-receipt") && method === "POST") return response({ delivered: true });
    if (path.endsWith("/session-1") && method === "GET") return response({ id: "session-1", reversal: null });
    return response({});
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Renders the screen for a user whose session role is `sessionRole`; returns the navigation history. */
function renderPage(sessionRole = "admin") {
  const memory = memoryLocation({ path: "/finance/receive-payments", record: true });
  const auth: AuthContextValue = {
    ...MOCK_AUTH_DEFAULTS,
    user: { id: "u", role: sessionRole, userType: "lab", practiceOrganizationId: "lab" } as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  };
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <Router hook={memory.hook} searchHook={memory.searchHook}>
        <AuthContext.Provider value={auth}>
          <ReceivePaymentsPage />
        </AuthContext.Provider>
      </Router>
    </QueryClientProvider>,
  );
  return memory.history;
}

const loaded = () => screen.findByTestId("receive-customer-row-alpha", undefined, { timeout: 3000 });
const rowIds = () =>
  screen
    .getAllByTestId(/^receive-customer-row-/)
    .map((row) => row.getAttribute("data-testid")!.replace("receive-customer-row-", ""));
const invoiceOrder = () =>
  screen
    .getAllByRole("checkbox", { name: /^Select invoice / })
    .map((box) => box.getAttribute("aria-label")!.split(" ")[2]);
const toggle = (name: string) => fireEvent.click(screen.getByRole("checkbox", { name }));
const openTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const cardValue = (card: string) => screen.getByTestId(`heads-up-${card}-value`).textContent;
function expectCards(customers: string, invoices: string, amount: string) {
  expect(cardValue("customers")).toBe(customers);
  expect(cardValue("invoices")).toBe(invoices);
  expect(cardValue("amount")).toBe(amount);
}
const customerRow = (id: string) => within(screen.getByTestId(`receive-customer-row-${id}`));
async function startReceiving() {
  fireEvent.click(screen.getByTestId("receive-continue"));
  await screen.findByRole("button", { name: "Save payment" });
}
async function savePayment() {
  const button = screen.getByRole("button", { name: "Save payment" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
const sentReceipts = () => requests.filter((request) => request.path.endsWith("/send-receipt"));

describe("Receive Payments selection", () => {
  it("shows loading cards, then live figures that follow the selection, never a made-up $0", async () => {
    let release = () => {};
    listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderPage();
    await screen.findByTestId("heads-up-customers");
    for (const card of ["customers", "invoices", "amount", "oldest"]) {
      expect(screen.getByTestId(`heads-up-${card}-value`)).toHaveTextContent("Loading…");
    }
    expect(screen.getByTestId("heads-up-amount")).not.toHaveTextContent("$");
    expect(screen.getByTestId("expected-payments")).toHaveTextContent("Loading…");
    expect(screen.getByTestId("receive-continue")).toBeDisabled();
    expect(document.getElementById("receive-summary-blocked")).toHaveTextContent("Loading customers with a balance due…");

    release();
    await loaded();
    expectCards("0", "0", "$0.00");
    expect(screen.getByTestId("heads-up-customers")).toHaveTextContent("of 3 customers with a balance due");
    expect(cardValue("oldest")).toBe("—");
    expect(screen.getByTestId("heads-up-oldest")).toHaveTextContent("No invoices selected");
    expect(screen.getByTestId("receive-continue")).toBeDisabled();
    expect(document.getElementById("receive-summary-blocked")).toHaveTextContent(
      "Select at least one customer to receive payment from.",
    );

    // Alpha pays its statement: a1 + a2.
    toggle("Select Alpha Dental");
    expectCards("1", "2", "$150.00");
    expect(cardValue("oldest")).toBe("40 days");
    expect(screen.getByTestId("heads-up-oldest")).toHaveTextContent("Alpha Dental");
    expect(screen.getByTestId("receive-summary-customers")).toHaveTextContent("1 customer selected");
    expect(screen.getByTestId("receive-summary-invoices").textContent).toBe("2");
    expect(screen.getByTestId("expected-payments").textContent).toBe("$150.00");
    expect(screen.getByTestId("receive-continue-subtitle").textContent).toBe("Apply $150.00 to 2 invoices");
    expect(screen.getByTestId("receive-continue")).toBeEnabled();
    expect(document.getElementById("receive-summary-blocked")).toBeNull();

    toggle("Select Gamma Ortho");
    expectCards("2", "4", "$250.00");
    expect(cardValue("oldest")).toBe("40 days");

    toggle("Select Beta Smiles");
    expectCards("3", "5", "$500.00");
    expect(cardValue("oldest")).toBe("95 days");
    expect(screen.getByTestId("heads-up-oldest")).toHaveTextContent("Beta Smiles");
    expect(screen.getByTestId("receive-summary-customers")).toHaveTextContent("3 customers selected");
    expect(screen.getByTestId("receive-continue-subtitle").textContent).toBe("Apply $500.00 to 5 invoices");
  });

  it.each(["statement", "invoice"] as const)(
    "shows every figure as unavailable when the %s list fails, and recovers on retry",
    async (list) => {
      failingList = list;
      renderPage();
      await screen.findByText("Customer balances could not be loaded.");
      for (const card of ["customers", "invoices", "amount", "oldest"]) {
        expect(cardValue(card)).toBe("Unavailable");
      }
      expect(screen.getByTestId("heads-up-amount")).toHaveTextContent("Balances could not be loaded");
      expect(screen.getByTestId("expected-payments").textContent).toBe("Unavailable");
      expect(screen.getByTestId("receive-continue")).toBeDisabled();
      expect(document.getElementById("receive-summary-blocked")).toHaveTextContent(
        "Customer balances could not be loaded. Retry the list before receiving payments.",
      );
      expect(screen.queryByTestId("receive-customer-row-alpha")).toBeNull();

      failingList = null;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await loaded();
      expectCards("0", "0", "$0.00");
      expect(screen.getByTestId("heads-up-customers")).toHaveTextContent("of 3 customers with a balance due");
    },
  );

  it("lists each customer's account details, marks statement payers and shows both balances when they differ", async () => {
    renderPage();
    await loaded();

    const alpha = customerRow("alpha");
    expect(alpha.getByText("AD")).toBeInTheDocument();
    expect(alpha.getByText("Alpha Dental")).toBeInTheDocument();
    expect(alpha.getByText("LT-1001")).toBeInTheDocument();
    expect(alpha.getByText("Statement")).toBeInTheDocument();
    expect(alpha.getByText("3 invoices")).toBeInTheDocument();
    expect(alpha.getByText("$180.00")).toBeInTheDocument();
    expect(alpha.getByText("Statement $150.00")).toBeInTheDocument();
    expect(alpha.getByText(formatDate(INVOICES.a1.issuedAt))).toBeInTheDocument();
    expect(alpha.getByText("40 days")).toHaveClass("text-destructive");
    expect(alpha.getByText(formatDate(LAST_ALPHA_PAYMENT))).toBeInTheDocument();
    expect(alpha.getByText("$75.00")).toBeInTheDocument();

    const beta = customerRow("beta");
    expect(beta.getByText("LT-1002")).toBeInTheDocument();
    expect(beta.getByText("Statement")).toBeInTheDocument();
    expect(beta.getByText("$250.00")).toBeInTheDocument();
    expect(beta.queryByText(/^Statement \$/)).toBeNull();
    expect(beta.getByText(formatDate(INVOICES.b1.issuedAt))).toBeInTheDocument();
    expect(beta.getByText("95 days")).toHaveClass("text-destructive");
    expect(beta.getByText(formatDate(LAST_BETA_PAYMENT))).toBeInTheDocument();
    expect(beta.getByText("$150.00")).toBeInTheDocument();

    // No statement, nothing overdue, no account number and no payment yet.
    const gamma = customerRow("gamma");
    expect(gamma.getByText("GO")).toBeInTheDocument();
    expect(gamma.queryByText("Statement")).toBeNull();
    expect(gamma.queryByText(/^LT-/)).toBeNull();
    expect(gamma.getByText("2 invoices")).toBeInTheDocument();
    expect(gamma.getByText("$100.00")).toBeInTheDocument();
    expect(gamma.getByText(formatDate(INVOICES.g1.issuedAt))).toBeInTheDocument();
    expect(gamma.queryByText(/days$/)).toBeNull();
    expect(gamma.getByText("None")).toBeInTheDocument();

    // View invoices opens the Invoices tab focused on that customer.
    fireEvent.click(alpha.getByRole("button", { name: "View invoices for Alpha Dental" }));
    expect(screen.getByRole("tab", { name: "Invoices" })).toHaveAttribute("aria-selected", "true");
    expect(invoiceOrder()).toEqual(["INV-1001", "INV-1002", "INV-1003"]);
    fireEvent.click(screen.getByRole("button", { name: "Show all customers" }));
    expect(invoiceOrder()).toHaveLength(6);
  });

  it("sorts from the column headers and the toolbar, flipping direction on the same column", async () => {
    renderPage();
    await loaded();
    expect(rowIds()).toEqual(["beta", "alpha", "gamma"]);
    expect(screen.getByRole("columnheader", { name: "Balance Due" })).toHaveAttribute("aria-sort", "descending");

    fireEvent.click(screen.getByRole("button", { name: "Customer" }));
    expect(rowIds()).toEqual(["alpha", "beta", "gamma"]);
    expect(screen.getByRole("columnheader", { name: "Customer" })).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(screen.getByRole("button", { name: "Customer" }));
    expect(rowIds()).toEqual(["gamma", "beta", "alpha"]);
    expect(screen.getByRole("columnheader", { name: "Customer" })).toHaveAttribute("aria-sort", "descending");

    fireEvent.click(screen.getByRole("button", { name: "Last Payment" }));
    expect(rowIds()).toEqual(["alpha", "beta", "gamma"]);
    fireEvent.click(screen.getByRole("button", { name: "Last Payment" }));
    expect(rowIds()).toEqual(["beta", "alpha", "gamma"]);

    fireEvent.click(screen.getByRole("button", { name: "Oldest Invoice" }));
    expect(rowIds()).toEqual(["beta", "alpha", "gamma"]);
    expect(screen.getByRole("columnheader", { name: "Oldest Invoice" })).toHaveAttribute("aria-sort", "ascending");

    fireEvent.click(screen.getByRole("button", { name: "Unpaid Invoices" }));
    expect(rowIds()).toEqual(["alpha", "gamma", "beta"]);

    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "balance" } });
    expect(rowIds()).toEqual(["beta", "alpha", "gamma"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort direction: descending" }));
    expect(rowIds()).toEqual(["gamma", "alpha", "beta"]);
    expect(screen.getByRole("button", { name: "Sort direction: ascending" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "name" } });
    expect(rowIds()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("filters by status, location, aging and search, selects only the shown rows, and clears", async () => {
    renderPage();
    await loaded();
    const status = screen.getByLabelText("Status");
    const expectStatus = (value: string, ids: string[]) => {
      fireEvent.change(status, { target: { value } });
      expect(rowIds()).toEqual(ids);
    };
    expectStatus("overdue", ["beta", "alpha"]);
    expectStatus("partial", ["beta", "alpha"]);
    expectStatus("statement", ["beta", "alpha"]);
    expectStatus("not_due", ["gamma"]);
    expectStatus("no_statement", ["gamma"]);

    // Select all covers the filtered rows only, and survives the filter changing.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all shown customers" }));
    expectCards("1", "2", "$100.00");
    expectStatus("", ["beta", "alpha", "gamma"]);
    expect(screen.getByRole("checkbox", { name: "Select Gamma Ortho" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Alpha Dental" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Beta Smiles" })).not.toBeChecked();

    const location = screen.getByLabelText("Location");
    fireEvent.change(location, { target: { value: "Denver, CO" } });
    expect(rowIds()).toEqual(["beta"]);
    fireEvent.change(location, { target: { value: "__none__" } });
    expect(rowIds()).toEqual(["gamma"]);
    fireEvent.change(location, { target: { value: "" } });

    const aging = screen.getByLabelText("Aging of oldest invoice");
    fireEvent.change(aging, { target: { value: "d90_plus" } });
    expect(rowIds()).toEqual(["beta"]);
    fireEvent.change(aging, { target: { value: "d31_60" } });
    expect(rowIds()).toEqual(["alpha"]);
    fireEvent.change(aging, { target: { value: "d61_90" } });
    expect(screen.queryAllByTestId(/^receive-customer-row-/)).toHaveLength(0);
    fireEvent.change(aging, { target: { value: "" } });

    const search = screen.getByLabelText("Search customers");
    const searches: Array<[string, string[]]> = [
      ["LT-1002", ["beta"]],
      ["Gia", ["gamma"]],
      ["INV-1003", ["alpha"]],
      ["beta smiles", ["beta"]],
    ];
    for (const [term, ids] of searches) {
      fireEvent.change(search, { target: { value: term } });
      expect(rowIds()).toEqual(ids);
    }

    fireEvent.change(status, { target: { value: "overdue" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(rowIds()).toEqual(["beta", "alpha", "gamma"]);
    expect(search).toHaveValue("");
    expect(status).toHaveValue("");
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("limits a customer's payment to picked invoices and pays directly when one is not on the statement", async () => {
    renderPage();
    await loaded();
    openTab("Invoices");
    expect(invoiceOrder()).toEqual(["INV-2001", "INV-1001", "INV-3001", "INV-1002", "INV-3002", "INV-1003"]);
    expect(screen.getAllByText("On statement")).toHaveLength(3);

    toggle("Select invoice INV-1001 for Alpha Dental");
    expectCards("1", "1", "$100.00");
    openTab("Customers");
    expect(customerRow("alpha").getByText(/1 of 2 invoices picked/)).toBeInTheDocument();
    expect(customerRow("alpha").getByText("Statement")).toBeInTheDocument();

    // INV-1003 is not on Alpha's statement, so Alpha now pays invoices directly.
    openTab("Invoices");
    toggle("Select invoice INV-1003 for Alpha Dental");
    expect(screen.getByText(/will pay invoices directly instead of by statement/).closest("p")).toHaveTextContent(
      "Alpha Dental will pay invoices directly instead of by statement: invoice INV-1003 is not on their statement.",
    );
    expectCards("1", "2", "$130.00");
    openTab("Customers");
    expect(customerRow("alpha").getByText(/Paying invoices directly/)).toBeInTheDocument();
    expect(customerRow("alpha").queryByText("Statement")).toBeNull();

    await startReceiving();
    expect(await screen.findByTestId("receive-switched-note")).toHaveTextContent(
      "Paying invoices directly: INV-1003 is not on the statement.",
    );
    expect(screen.getByTestId("receive-invoice-scope-note")).toHaveTextContent(
      "Showing only the invoices picked on the selection screen",
    );
    expect(screen.getByLabelText("Statement")).toHaveValue("");
    expect(screen.getByLabelText("Total amount received")).toHaveValue(130);
    expect(await screen.findByLabelText("Payment for invoice INV-1001")).toHaveValue(100);
    expect(screen.getByLabelText("Payment for invoice INV-1003")).toHaveValue(30);
    expect(screen.queryByLabelText("Payment for invoice INV-1002")).toBeNull();

    fireEvent.change(screen.getByLabelText("Reference number"), { target: { value: "CHK-55" } });
    await savePayment();
    await screen.findByRole("dialog", { name: "Payment recorded" });
    expect(paymentPosts).toHaveLength(1);
    expect(paymentPosts[0]).toMatchObject({
      providerOrganizationId: "alpha",
      statementId: null,
      receivedAmount: 130,
      paymentMethod: "check",
      checkNumber: "CHK-55",
    });
    expect(paymentPosts[0].applications).toEqual([
      { invoiceId: "a1", amount: 100, creditAmount: 0 },
      { invoiceId: "a3", amount: 30, creditAmount: 0 },
    ]);
  });

  it("picks a shift-click range of invoices across customers", async () => {
    renderPage();
    await loaded();
    openTab("Invoices");
    toggle("Select invoice INV-3001 for Gamma Ortho");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select invoice INV-3002 for Gamma Ortho" }), { shiftKey: true });
    for (const name of ["INV-3001 for Gamma Ortho", "INV-1002 for Alpha Dental", "INV-3002 for Gamma Ortho"]) {
      expect(screen.getByRole("checkbox", { name: `Select invoice ${name}` })).toBeChecked();
    }
    for (const name of ["INV-2001 for Beta Smiles", "INV-1001 for Alpha Dental", "INV-1003 for Alpha Dental"]) {
      expect(screen.getByRole("checkbox", { name: `Select invoice ${name}` })).not.toBeChecked();
    }
    // Alpha pays INV-1002 by statement; Gamma pays both of its invoices.
    expectCards("2", "3", "$150.00");
  });

  it("groups customers by aging bucket with totals, selecting a whole bucket or one customer", async () => {
    renderPage();
    await loaded();
    openTab("Aging");
    const totals: Record<string, string> = {
      current: "$130.00",
      d1_30: "$50.00",
      d31_60: "$100.00",
      d61_90: "$0.00",
      d90_plus: "$250.00",
    };
    for (const [key, total] of Object.entries(totals)) {
      expect(screen.getByTestId(`receive-aging-total-${key}`).textContent).toBe(total);
    }
    expect(within(screen.getByTestId("receive-aging-group-d61_90")).getByText("No customers in this bucket.")).toBeInTheDocument();
    const current = within(screen.getByTestId("receive-aging-group-current"));
    expect(current.getByText("Alpha Dental")).toBeInTheDocument();
    expect(current.getByText("Gamma Ortho")).toBeInTheDocument();
    expect(current.queryByText("Beta Smiles")).toBeNull();

    toggle("Select all customers in Current");
    expectCards("2", "4", "$250.00");
    toggle("Select Beta Smiles in Over 90 days");
    expectCards("3", "5", "$500.00");
    expect(screen.getByRole("checkbox", { name: "Select all customers in Over 90 days" })).toBeChecked();
    toggle("Select all customers in Current");
    expectCards("1", "1", "$250.00");
    expect(screen.getByRole("checkbox", { name: "Select Alpha Dental in 31 - 60 days" })).not.toBeChecked();
  });

  it("lists payable statements and puts a customer back on paying by statement", async () => {
    renderPage();
    await loaded();
    openTab("Invoices");
    toggle("Select invoice INV-1003 for Alpha Dental");
    expectCards("1", "1", "$30.00");

    openTab("Statements");
    expect(screen.queryByRole("checkbox", { name: "Pay Gamma Ortho by statement" })).toBeNull();
    const alphaBox = screen.getByRole("checkbox", { name: "Pay Alpha Dental by statement" });
    expect(alphaBox).not.toBeChecked();
    const alphaRow = within(alphaBox.closest("tr")!);
    expect(alphaRow.getByText(`${formatDate("2026-08-01")} – ${formatDate("2026-08-31")}`)).toBeInTheDocument();
    expect(alphaRow.getByText(formatDate("2026-09-01"))).toBeInTheDocument();
    expect(alphaRow.getByText("1 statement")).toBeInTheDocument();
    expect(alphaRow.getByText("$150.00")).toBeInTheDocument();
    expect(alphaRow.getByText("Total outstanding $180.00")).toBeInTheDocument();
    const betaRow = within(screen.getByRole("checkbox", { name: "Pay Beta Smiles by statement" }).closest("tr")!);
    expect(betaRow.getByText("$250.00")).toBeInTheDocument();
    expect(betaRow.queryByText(/^Total outstanding/)).toBeNull();

    fireEvent.click(alphaBox);
    expect(alphaBox).toBeChecked();
    expectCards("1", "2", "$150.00");
    openTab("Customers");
    expect(customerRow("alpha").getByText("Statement")).toBeInTheDocument();
    expect(customerRow("alpha").queryByText(/Paying invoices directly/)).toBeNull();
  });

  it("saves a named selection on this computer and reloads it, naming customers no longer payable", async () => {
    localStorage.setItem(
      SAVED_SELECTIONS_KEY,
      JSON.stringify([
        {
          name: "Mixed",
          savedAt: "2026-09-01T12:00:00.000Z",
          customers: [{ id: "gamma", name: "Gamma Ortho" }, { id: "zeta", name: "Zeta" }],
        },
        { name: "Old batch", savedAt: "2026-08-01T12:00:00.000Z", customers: [{ id: "zeta", name: "Zeta" }] },
      ]),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await loaded();

    toggle("Select Alpha Dental");
    toggle("Select Beta Smiles");
    fireEvent.click(screen.getByRole("button", { name: "Save Selection" }));
    const saveDialog = within(screen.getByRole("dialog", { name: "Save selection" }));
    fireEvent.change(saveDialog.getByLabelText("Name this set of 2 customers"), { target: { value: "Monthly statements" } });
    fireEvent.click(saveDialog.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Saved “Monthly statements” (2 customers) on this computer.")).toHaveAttribute("role", "status");
    const stored = () =>
      JSON.parse(localStorage.getItem(SAVED_SELECTIONS_KEY) ?? "[]") as Array<{
        name: string;
        customers: Array<{ id: string; name: string; scope?: unknown }>;
      }>;
    expect(stored().map((entry) => entry.name).sort()).toEqual(["Mixed", "Monthly statements", "Old batch"]);
    expect(stored().find((entry) => entry.name === "Monthly statements")?.customers).toEqual([
      { id: "alpha", name: "Alpha Dental", scope: { mode: "statement", invoiceIds: null } },
      { id: "beta", name: "Beta Smiles", scope: { mode: "statement", invoiceIds: null } },
    ]);

    const load = (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Load Saved Selection" }));
      fireEvent.click(
        within(screen.getByRole("dialog", { name: "Saved selections" })).getByRole("button", { name: `Load ${name}` }),
      );
    };

    // Loading replaces the selection with the customers that are still payable.
    load("Mixed");
    expect(screen.getByText("Loaded “Mixed”: 1 customer selected. No longer payable: Zeta.")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("checkbox", { name: "Select Gamma Ortho" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Alpha Dental" })).not.toBeChecked();
    expectCards("1", "2", "$100.00");

    load("Old batch");
    expect(screen.getByText("None of the customers in “Old batch” have a payable balance now: Zeta.")).toHaveAttribute(
      "role",
      "alert",
    );
    expectCards("0", "0", "$0.00");

    load("Monthly statements");
    expect(screen.getByText("Loaded “Monthly statements”: 2 customers selected.")).toHaveAttribute("role", "status");
    expectCards("2", "3", "$400.00");

    fireEvent.click(screen.getByRole("button", { name: "Load Saved Selection" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Old batch" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Load Old batch" })).toBeNull();
    expect(stored().map((entry) => entry.name).sort()).toEqual(["Mixed", "Monthly statements"]);
  });

  it("saves each customer's picked invoices and restores them without widening the payment", async () => {
    localStorage.setItem(
      SAVED_SELECTIONS_KEY,
      JSON.stringify([
        {
          name: "Stale picks",
          savedAt: "2026-09-01T12:00:00.000Z",
          customers: [
            // The invoices a-paid and g-paid have been paid since this set was saved.
            { id: "alpha", name: "Alpha Dental", scope: { mode: "statement", invoiceIds: ["a1", "a-paid"] } },
            { id: "gamma", name: "Gamma Ortho", scope: { mode: "invoices", invoiceIds: ["g-paid"] } },
          ],
        },
      ]),
    );
    renderPage();
    await loaded();
    openTab("Invoices");
    toggle("Select invoice INV-1001 for Alpha Dental");
    toggle("Select invoice INV-3001 for Gamma Ortho");
    expectCards("2", "2", "$160.00");

    fireEvent.click(screen.getByRole("button", { name: "Save Selection" }));
    const saveDialog = within(screen.getByRole("dialog", { name: "Save selection" }));
    fireEvent.change(saveDialog.getByLabelText("Name this set of 2 customers"), { target: { value: "Partial" } });
    fireEvent.click(saveDialog.getByRole("button", { name: "Save" }));
    const stored = JSON.parse(localStorage.getItem(SAVED_SELECTIONS_KEY) ?? "[]") as Array<{
      name: string;
      customers: unknown[];
    }>;
    expect(stored.find((entry) => entry.name === "Partial")?.customers).toEqual([
      { id: "alpha", name: "Alpha Dental", scope: { mode: "statement", invoiceIds: ["a1"] } },
      { id: "gamma", name: "Gamma Ortho", scope: { mode: "invoices", invoiceIds: ["g1"] } },
    ]);

    const load = (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Load Saved Selection" }));
      fireEvent.click(
        within(screen.getByRole("dialog", { name: "Saved selections" })).getByRole("button", { name: `Load ${name}` }),
      );
    };

    // A different selection: Beta in full, Alpha dropped.
    openTab("Customers");
    toggle("Select Beta Smiles");
    toggle("Select Alpha Dental");
    expectCards("2", "2", "$310.00");

    // Loading restores the picked invoices, not each customer's whole balance.
    load("Partial");
    expect(screen.getByText("Loaded “Partial”: 2 customers selected.")).toHaveAttribute("role", "status");
    expectCards("2", "2", "$160.00");
    expect(screen.getByRole("checkbox", { name: "Select Beta Smiles" })).not.toBeChecked();
    expect(customerRow("alpha").getByText(/1 of 2 invoices picked/)).toBeInTheDocument();
    expect(customerRow("alpha").getByText("Statement")).toBeInTheDocument();
    expect(customerRow("gamma").getByText(/1 of 2 invoices picked/)).toBeInTheDocument();

    // Picks paid since saving are left out, and a customer with none left stays unselected.
    load("Stale picks");
    expect(
      screen.getByText(
        "Loaded “Stale picks”: 1 customer selected. Not selected because none of their picked invoices are still outstanding: Gamma Ortho. Picked invoices no longer outstanding were left out for Alpha Dental.",
      ),
    ).toHaveAttribute("role", "alert");
    expectCards("1", "1", "$100.00");
    expect(screen.getByRole("checkbox", { name: "Select Gamma Ortho" })).not.toBeChecked();

    load("Partial");
    expectCards("2", "2", "$160.00");
    await startReceiving();
    expect(screen.getByTestId("receive-practice-progress")).toHaveTextContent("Customer 1 of 2: Alpha Dental");
    // Alpha pays only the picked statement invoice, not the whole $150.00 statement.
    await waitFor(() => expect(screen.getByLabelText("Total amount received")).toHaveValue(100));
    expect(screen.getByLabelText("Payment for invoice INV-1001")).toHaveValue(100);
    expect(screen.queryByLabelText("Payment for invoice INV-1002")).toBeNull();
    expect(screen.getByTestId("receive-invoice-scope-note")).toHaveTextContent(
      "Showing only the invoices picked on the selection screen",
    );
    expect(screen.getByLabelText("Statement")).toHaveValue("st-a");

    fireEvent.change(screen.getByLabelText("Reference number"), { target: { value: "CHK-77" } });
    await savePayment();
    await screen.findByRole("dialog", { name: "Payment recorded" });
    expect(paymentPosts).toHaveLength(1);
    expect(paymentPosts[0]).toMatchObject({ providerOrganizationId: "alpha", statementId: "st-a", receivedAmount: 100 });
    expect(paymentPosts[0].applications).toEqual([{ invoiceId: "a1", amount: 100, creditAmount: 0 }]);
  });

  it("opens the A/R side of Aging from View Receivables Aging", async () => {
    const history = renderPage();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "View Receivables Aging" }));
    expect(history[history.length - 1]).toBe("/finance/aging?side=ar");
  });
});

describe("Receive Payments summary defaults and options", () => {
  it("carries the summary defaults into each customer's draft and receives the batch one customer at a time", async () => {
    const history = renderPage();
    await loaded();
    toggle("Select Alpha Dental");
    toggle("Select Gamma Ortho");

    const method = screen.getByLabelText("Payment Method") as HTMLSelectElement;
    expect(method).toHaveValue("check");
    expect(Array.from(method.options).map((option) => option.value)).toEqual(["check", "ach", "card", "cash", "other"]);
    expect(screen.getByTestId("receive-deposit-note")).toHaveTextContent("Undeposited Funds");
    expect(screen.getByTestId("receive-deposit-note")).toHaveTextContent("Make Deposits");
    expect(screen.getByLabelText("Apply to oldest invoices first")).toBeChecked();
    expect(screen.getByLabelText("Allow overpayment (create credit)")).toBeChecked();
    expect(screen.getByLabelText("Email receipts to customers")).not.toBeChecked();
    fireEvent.change(method, { target: { value: "ach" } });
    fireEvent.change(screen.getByLabelText("Payment Date"), { target: { value: "2026-09-15" } });
    fireEvent.change(screen.getByLabelText("Memo (optional)"), { target: { value: "September batch" } });
    expect(screen.getByTestId("receive-continue-subtitle").textContent).toBe("Apply $250.00 to 4 invoices");

    await startReceiving();
    expect(screen.getByTestId("receive-practice-progress")).toHaveTextContent("Customer 1 of 2: Alpha Dental");
    const queue = within(screen.getByTestId("receive-queue"));
    expect(queue.getByText("Alpha Dental")).toBeInTheDocument();
    expect(queue.getByText("Gamma Ortho")).toBeInTheDocument();

    // Alpha pays its statement: the full statement balance, oldest first.
    await waitFor(() => expect(screen.getByLabelText("Total amount received")).toHaveValue(150));
    expect(screen.getByLabelText("Payment for invoice INV-1001")).toHaveValue(100);
    expect(screen.getByLabelText("Payment for invoice INV-1002")).toHaveValue(50);
    expect(screen.queryByLabelText("Payment for invoice INV-1003")).toBeNull();
    expect(screen.getByLabelText("Statement")).toHaveValue("st-a");
    expect(screen.getByLabelText("Payment method")).toHaveValue("ach");
    expect(screen.getByLabelText("Payment date")).toHaveValue("2026-09-15");
    expect(screen.getByLabelText("Memo")).toHaveValue("September batch");
    expect(screen.getByLabelText("Reference number")).toHaveValue("08-2026SMITHPMTACH");

    await savePayment();
    await screen.findByRole("dialog", { name: "Payment recorded" });
    expect(paymentPosts).toHaveLength(1);
    expect(paymentPosts[0]).toMatchObject({
      labOrganizationId: "lab",
      providerOrganizationId: "alpha",
      statementId: "st-a",
      receivedAmount: 150,
      paymentMethod: "ach",
      checkNumber: null,
      referenceNumber: "08-2026SMITHPMTACH",
      memo: "September batch",
      paymentDate: "2026-09-15T00:00:00.000Z",
    });
    expect(paymentPosts[0].applications).toEqual([
      { invoiceId: "a1", amount: 100, creditAmount: 0 },
      { invoiceId: "a2", amount: 50, creditAmount: 0 },
    ]);

    // Gamma has no statement: its invoices' full balances, with the same defaults.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Customer 2 of 2: Gamma Ortho")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Total amount received")).toHaveValue(100));
    expect(await screen.findByLabelText("Payment for invoice INV-3001")).toHaveValue(60);
    expect(screen.getByLabelText("Payment for invoice INV-3002")).toHaveValue(40);
    expect(screen.getByLabelText("Statement")).toHaveValue("");
    expect(screen.getByLabelText("Payment method")).toHaveValue("ach");
    expect(screen.getByLabelText("Payment date")).toHaveValue("2026-09-15");
    expect(screen.getByLabelText("Memo")).toHaveValue("September batch");
    // Each customer's payment carries its own reference number.
    expect(screen.getByLabelText("Reference number")).toHaveValue("");
    await savePayment();
    expect(await screen.findByText("Reference number is required for ACH and other payments.")).toBeInTheDocument();
    expect(paymentPosts).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Reference number"), { target: { value: "ACH-77" } });
    await savePayment();
    await screen.findByRole("dialog", { name: "Payment recorded" });
    expect(paymentPosts).toHaveLength(2);
    expect(paymentPosts[1]).toMatchObject({
      providerOrganizationId: "gamma",
      statementId: null,
      receivedAmount: 100,
      paymentMethod: "ach",
      referenceNumber: "ACH-77",
      memo: "September batch",
      paymentDate: "2026-09-15T00:00:00.000Z",
    });
    expect(paymentPosts[1].applications).toEqual([
      { invoiceId: "g1", amount: 60, creditAmount: 0 },
      { invoiceId: "g2", amount: 40, creditAmount: 0 },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(history).toContain("/finance/make-deposits"));
    expect(sentReceipts()).toHaveLength(0);
  });

  it("applies a changed amount to the oldest invoices first while that option is on", async () => {
    renderPage();
    await loaded();
    toggle("Select Alpha Dental");
    await startReceiving();
    const total = screen.getByLabelText("Total amount received");
    await waitFor(() => expect(total).toHaveValue(150));
    fireEvent.change(total, { target: { value: "120" } });
    expect(screen.getByLabelText("Payment for invoice INV-1001")).toHaveValue(100);
    expect(screen.getByLabelText("Payment for invoice INV-1002")).toHaveValue(20);
    expect(screen.queryByText("Monetary applications exceed payment received.")).toBeNull();
  });

  it("leaves allocation to the user when oldest-first is off", async () => {
    renderPage();
    await loaded();
    toggle("Select Alpha Dental");
    fireEvent.click(screen.getByLabelText("Apply to oldest invoices first"));
    await startReceiving();
    const total = screen.getByLabelText("Total amount received");
    await waitFor(() => expect(total).toHaveValue(150));
    fireEvent.change(total, { target: { value: "120" } });
    expect(screen.getByLabelText("Payment for invoice INV-1001")).toHaveValue(100);
    expect(screen.getByLabelText("Payment for invoice INV-1002")).toHaveValue(50);
    expect(screen.getByText("Monetary applications exceed payment received.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save payment" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Payment for invoice INV-1002"), { target: { value: "20" } });
    expect(screen.queryByText("Monetary applications exceed payment received.")).toBeNull();
    expect(screen.getByRole("button", { name: "Save payment" })).toBeEnabled();
  });

  it("blocks saving money that is not applied when overpayment is off", async () => {
    renderPage();
    await loaded();
    toggle("Select Alpha Dental");
    fireEvent.click(screen.getByLabelText("Allow overpayment (create credit)"));
    await startReceiving();
    const total = screen.getByLabelText("Total amount received");
    await waitFor(() => expect(total).toHaveValue(150));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save payment" })).toBeEnabled());
    fireEvent.change(total, { target: { value: "170" } });
    expect(screen.getByLabelText("Payment for invoice INV-1001")).toHaveValue(100);
    expect(screen.getByLabelText("Payment for invoice INV-1002")).toHaveValue(50);
    expect(screen.getByTestId("receive-overpayment-blocked")).toHaveTextContent(
      "$20.00 of the amount received is not applied to an invoice. Overpayment is turned off for this batch.",
    );
    expect(screen.queryByTestId("receive-overpayment-credit")).toBeNull();
    expect(screen.getByRole("button", { name: "Save payment" })).toBeDisabled();

    fireEvent.change(total, { target: { value: "150" } });
    expect(screen.queryByTestId("receive-overpayment-blocked")).toBeNull();
    expect(screen.getByRole("button", { name: "Save payment" })).toBeEnabled();
    expect(paymentPosts).toHaveLength(0);
  });

  it("keeps money that is not applied as customer credit when overpayment is on", async () => {
    renderPage();
    await loaded();
    toggle("Select Alpha Dental");
    await startReceiving();
    const total = screen.getByLabelText("Total amount received");
    await waitFor(() => expect(total).toHaveValue(150));
    fireEvent.change(total, { target: { value: "170" } });
    expect(screen.getByTestId("receive-overpayment-credit")).toHaveTextContent(
      "$20.00 not applied to an invoice will be kept as customer credit.",
    );
    expect(screen.queryByTestId("receive-overpayment-blocked")).toBeNull();
    await savePayment();
    await screen.findByRole("dialog", { name: "Payment recorded" });
    expect(paymentPosts).toHaveLength(1);
    expect(paymentPosts[0]).toMatchObject({ providerOrganizationId: "alpha", statementId: "st-a", receivedAmount: 170 });
    expect(paymentPosts[0].applications).toEqual([
      { invoiceId: "a1", amount: 100, creditAmount: 0 },
      { invoiceId: "a2", amount: 50, creditAmount: 0 },
    ]);
  });

  it("keeps the receipt email closed with email receipts off, offering it on demand without sending", async () => {
    renderPage();
    await loaded();
    toggle("Select Alpha Dental");
    await startReceiving();
    await waitFor(() => expect(screen.getByLabelText("Total amount received")).toHaveValue(150));
    await savePayment();
    const dialog = within(await screen.findByRole("dialog", { name: "Payment recorded" }));
    expect(dialog.queryByLabelText("Receipt email recipient")).toBeNull();
    for (const name of ["Preview / download PDF", "Email receipt", "Continue", "Cancel payment"]) {
      expect(dialog.getByRole("button", { name })).toBeInTheDocument();
    }
    fireEvent.click(dialog.getByRole("button", { name: "Email receipt" }));
    const composer = within(await screen.findByRole("dialog", { name: "Email payment receipt" }));
    expect(composer.getByLabelText("Receipt email recipient")).toHaveValue("billing@alpha.test");
    expect(sentReceipts()).toHaveLength(0);
  });

  it("opens the prefilled receipt email after saving with email receipts on, still without sending", async () => {
    renderPage();
    await loaded();
    toggle("Select Alpha Dental");
    fireEvent.click(screen.getByLabelText("Email receipts to customers"));
    await startReceiving();
    await waitFor(() => expect(screen.getByLabelText("Total amount received")).toHaveValue(150));
    await savePayment();
    const composer = within(await screen.findByRole("dialog", { name: "Email payment receipt" }));
    expect(composer.getByLabelText("Receipt email recipient")).toHaveValue("billing@alpha.test");
    expect(composer.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(sentReceipts()).toHaveLength(0);
  });
});

describe("Receive Payments role in the selected lab", () => {
  it("is not available to a billing member of the selected lab, even with an admin session role", async () => {
    labRole = "billing";
    renderPage("admin");
    expect(await screen.findByText(/Your role in Lab is Billing\./)).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByTestId("heads-up-customers")).toBeNull();
    expect(requests.some((request) => request.path.includes("/eligible-"))).toBe(false);
  });

  it("explains when the user is not an active member of the selected lab", async () => {
    labRole = null;
    renderPage("admin");
    expect(await screen.findByText(/You are not an active member of Lab\./)).toBeInTheDocument();
    expect(screen.queryByTestId("heads-up-customers")).toBeNull();
  });

  it("opens for an owner of the selected lab whose session role is lower", async () => {
    labRole = "owner";
    renderPage("user");
    await loaded();
    expect(screen.queryByText("Not available")).toBeNull();
  });

  it("shows nothing but the role check until the lab role is known", async () => {
    roleCheckPending = true;
    renderPage();
    expect(await screen.findByText("Checking your role in Lab…")).toBeInTheDocument();
    expect(screen.queryByTestId("heads-up-customers")).toBeNull();
    expect(requests.some((request) => request.path.includes("/eligible-"))).toBe(false);
  });
});

// The Financial routes as App wires them: each screen gates on the user's role
// in the lab selected in the Financial header, so a lab's admin can follow
// Receive Payments to the screens it hands off to whatever their session role.
describe("Receive Payments hand-offs in the selected lab", () => {
  const DEPOSITS_INTRO = "Select received payments to move from Undeposited Funds into a bank account.";

  function renderFinanceRoutes(sessionRole: string, { path = "/finance/receive-payments", userType = "lab" } = {}) {
    const memory = memoryLocation({ path, record: true });
    const auth: AuthContextValue = {
      ...MOCK_AUTH_DEFAULTS,
      user: { id: "u", role: sessionRole, userType, practiceOrganizationId: "lab" } as any,
      status: "authed",
      restoreStatus: "ok",
      restoreNoticeDismissed: true,
    };
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <Router hook={memory.hook} searchHook={memory.searchHook}>
          <AuthContext.Provider value={auth}>
            <Switch>
              <Route path="/finance/receive-payments">
                {() => <LabFinanceRoute><ReceivePaymentsPage /></LabFinanceRoute>}
              </Route>
              <Route path="/finance/make-deposits">
                {() => <LabFinanceRoute><MakeDepositsPage /></LabFinanceRoute>}
              </Route>
              <Route path="/finance/aging">
                {() => <LabFinanceRoute><AgingPage /></LabFinanceRoute>}
              </Route>
              <Route path="/finance/register">
                <p>Bank register</p>
              </Route>
            </Switch>
          </AuthContext.Provider>
        </Router>
      </QueryClientProvider>,
    );
    return memory.history;
  }

  it("lets an admin of the selected lab whose session role is user open A/R Aging and finish in Make Deposits", async () => {
    labRole = "admin";
    const history = renderFinanceRoutes("user");
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "View Receivables Aging" }));
    expect(await screen.findByText("Smile Dental")).toBeInTheDocument();
    expect(history[history.length - 1]).toBe("/finance/aging?side=ar");
    expect(screen.queryByText("Not available")).toBeNull();
    expect(screen.queryByText("Bank register")).toBeNull();

    // Back on Receive Payments, the last customer's receipt hands off to Make Deposits.
    fireEvent.click(screen.getByRole("link", { name: "Receive Payments" }));
    await loaded();
    toggle("Select Gamma Ortho");
    await startReceiving();
    fireEvent.change(screen.getByLabelText("Reference number"), { target: { value: "CHK-90" } });
    await savePayment();
    await screen.findByRole("dialog", { name: "Payment recorded" });
    expect(paymentPosts).toHaveLength(1);
    expect(paymentPosts[0]).toMatchObject({ providerOrganizationId: "gamma", receivedAmount: 100, checkNumber: "CHK-90" });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(DEPOSITS_INTRO)).toBeInTheDocument();
    expect(history[history.length - 1]).toBe("/finance/make-deposits");
    expect(screen.queryByText("Not available")).toBeNull();
    expect(screen.queryByText("Bank register")).toBeNull();
  });

  it("keeps Make Deposits from a billing member of the selected lab, even with an admin session role", async () => {
    labRole = "billing";
    renderFinanceRoutes("admin", { path: "/finance/make-deposits" });
    expect(await screen.findByText(/Your role in Lab is Billing\./)).toBeInTheDocument();
    expect(screen.getByText(/Make Deposits is available only to lab owners and administrators\./)).toBeInTheDocument();
    expect(screen.queryByText(DEPOSITS_INTRO)).toBeNull();
  });

  it("sends accounts that are not lab accounts to the register", async () => {
    const history = renderFinanceRoutes("admin", { path: "/finance/make-deposits", userType: "provider" });
    expect(await screen.findByText("Bank register")).toBeInTheDocument();
    expect(history[history.length - 1]).toBe("/finance/register");
  });
});
