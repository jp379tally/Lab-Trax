/** @vitest-environment jsdom */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import ReceivePaymentsPage from "@/pages/finance/receive-payments";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import {
  receivePaymentRoute,
  receivePaymentRouteRefusal,
  type ReceivePaymentRoute,
} from "../../__tests__/receive-payment-routes";

const LAB_ORG = { id: "lab-1", name: "Lab One", type: "lab" };
const PROVIDERS = [
  { id: "prov-alpha", name: "Alpha Dental" },
  { id: "prov-beta", name: "Beta Smiles" },
  { id: "prov-gamma", name: "Gamma Dental" },
];

const ALL_INVOICES = PROVIDERS.map((provider, index) => ({
  id: `seed-${index + 1}`,
  invoiceNumber: `SEED-${index + 1}`,
  labOrganizationId: LAB_ORG.id,
  providerOrganizationId: provider.id,
  providerOrganization: { name: provider.name },
  status: "sent",
  total: index === 0 ? "100.00" : "200.00",
  balanceDue: index === 0 ? "100.00" : "200.00",
}));

const OPEN_BY_PROVIDER = {
  "prov-alpha": [
    {
      id: "alpha-inv",
      invoiceNumber: "INV-ALPHA",
      issuedAt: "2026-06-10T10:00:00.000Z",
      ageDays: 20,
      total: "100.00",
      balanceDue: "100.00",
    },
  ],
  "prov-beta": [
    {
      id: "beta-inv",
      invoiceNumber: "INV-BETA",
      issuedAt: "2026-06-11T10:00:00.000Z",
      ageDays: 19,
      total: "200.00",
      balanceDue: "200.00",
    },
  ],
  "prov-gamma": [
    {
      id: "gamma-inv",
      invoiceNumber: "INV-GAMMA",
      issuedAt: "2026-06-12T10:00:00.000Z",
      ageDays: 18,
      total: "300.00",
      balanceDue: "300.00",
    },
  ],
} as const;

type PostedPayment = {
  labOrganizationId: string;
  providerOrganizationId: string;
  statementId: string;
  receivedAmount: number;
  paymentDate: string;
  paymentMethod: string;
  checkNumber: string | null;
  cardLast4: string | null;
  memo: string | null;
  applications: Array<{ invoiceId: string; amount: number }>;
};

let postedPayments: PostedPayment[];
/** The server route each entry in postedPayments was sent to, in order. */
let paymentRoutes: ReceivePaymentRoute[];
let failNextAlphaPayment: boolean;
let paidProviders: Set<string>;
let holdNextAlphaPayment: boolean;
let resolveHeldPayment: (() => void) | null;
let keepPaidProvidersEligible: boolean;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const statementsFor = (providerId: string) => [{
  id: `statement-${providerId}`,
  periodStart: "2026-06-01T00:00:00.000Z",
  periodEnd: "2026-06-30T00:00:00.000Z",
  savedBalanceDue: OPEN_BY_PROVIDER[providerId as keyof typeof OPEN_BY_PROVIDER]?.[0]?.balanceDue || "0.00",
  invoiceCount: 1,
}];

const betaOlderStatement = {
  id: "statement-prov-beta-older",
  periodStart: "2026-05-01T00:00:00.000Z",
  periodEnd: "2026-05-31T00:00:00.000Z",
  savedBalanceDue: "125.00",
  invoiceCount: 3,
};

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? new URL(input, "http://localhost")
          : new URL(input.toString(), "http://localhost");
      const path = url.pathname;

      if (path.endsWith("/billing/lab-1/eligible-statement-accounts")) {
        return json(PROVIDERS.filter(provider => keepPaidProvidersEligible || !paidProviders.has(provider.id)).map(provider => {
          const statement = statementsFor(provider.id)[0];
          return {
            providerOrganizationId: provider.id,
            providerName: provider.name,
            statementId: statement.id,
            periodEnd: statement.periodEnd,
            sentAt: "2026-07-01T00:00:00.000Z",
            invoiceCount: statement.invoiceCount,
            currentBalanceDue: statement.savedBalanceDue,
          };
        }));
      }

      const statementMatch = path.match(
        /\/billing\/([^/]+)\/accounts\/([^/]+)\/statements$/,
      );
      if (statementMatch) return json(statementMatch[2] === "prov-beta" ? [...statementsFor(statementMatch[2]), betaOlderStatement] : statementsFor(statementMatch[2]));
      const detailMatch = path.match(/\/billing\/statements\/([^/]+)$/);
      if (detailMatch) {
        const providerId = detailMatch[1].replace(/^statement-/, "");
        return json({
          ...statementsFor(providerId)[0],
          invoices: (OPEN_BY_PROVIDER[providerId as keyof typeof OPEN_BY_PROVIDER] || []).map(invoice => ({
            ...invoice,
            currentBalanceDue: invoice.balanceDue,
            eligibleForPayment: true,
          })),
        });
      }
      const paymentRoute = receivePaymentRoute(path);
      if (paymentRoute && init?.method === "POST") {
        const body = JSON.parse(String(init?.body)) as PostedPayment;
        postedPayments.push(body);
        paymentRoutes.push(paymentRoute);
        // Like the real server, each route refuses the other's payments
        // before anything is recorded.
        const refusal = receivePaymentRouteRefusal(paymentRoute, body);
        if (refusal) return json({ ok: false, message: refusal }, 400);
        if (
          body.providerOrganizationId === "prov-alpha" &&
          failNextAlphaPayment
        ) {
          failNextAlphaPayment = false;
          return json({ message: "Payment could not be recorded." }, 500);
        }
        if (
          body.providerOrganizationId === "prov-alpha" &&
          holdNextAlphaPayment
        ) {
          holdNextAlphaPayment = false;
          return await new Promise<Response>((resolve) => {
            resolveHeldPayment = () => {
              paidProviders.add(body.providerOrganizationId);
              resolve(
                json({
                  id: `session-${postedPayments.length}`,
                  customerEmail: "billing@example.test",
                  receiptNumber: `R-${postedPayments.length}`,
                  receivedAmount: body.receivedAmount.toFixed(2),
                  appliedAmount: body.applications
                    .reduce((sum, app) => sum + app.amount, 0)
                    .toFixed(2),
                  customerCreditAmount: "0.00",
                  accountBalanceAfter: "0.00",
                }),
              );
            };
          });
        }
        paidProviders.add(body.providerOrganizationId);
        return json({
          id: `session-${postedPayments.length}`,
          customerEmail: "billing@example.test",
          receiptNumber: `R-${postedPayments.length}`,
          receivedAmount: body.receivedAmount.toFixed(2),
          appliedAmount: body.applications
            .reduce((sum, app) => sum + app.amount, 0)
            .toFixed(2),
          customerCreditAmount: "0.00",
          accountBalanceAfter: "0.00",
        });
      }
      if (path.endsWith("/invoices")) {
        return json(
          ALL_INVOICES.filter(
            (invoice) =>
              keepPaidProvidersEligible ||
              !paidProviders.has(invoice.providerOrganizationId),
          ),
        );
      }
      if (path.endsWith("/provider/lab-card")) return json({ card: { brand: "Visa", last4: "1234" } });
      // Receive Payments is gated on the user's role in the selected lab.
      if (path.endsWith("/auth/me")) {
        return json({
          user: { id: "u1", username: "admin", role: "admin", userType: "lab" },
          memberships: [{ organizationId: LAB_ORG.id, role: "admin", status: "active", organization: LAB_ORG }],
        });
      }
      if (path.endsWith("/organizations")) return json([LAB_ORG]);
      if (path.endsWith("/finance/accounts")) return json([]);
      if (path.endsWith("/finance/undeposited-funds")) {
        return json({ count: 0, total: 0 });
      }
      return json({});
    }),
  );
}

async function renderPage() {
  const Wrapper = makeAuthWrapper("/finance/receive-payments", {
    user: {
      id: "u1",
      username: "admin",
      role: "admin",
      userType: "lab",
    } as any,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  render(
    <Wrapper>
      <ReceivePaymentsPage />
    </Wrapper>,
  );
  expect(screen.queryByText("Review selected accounts")).not.toBeInTheDocument();
  await selectAndReceive("Alpha Dental", "$100.00");
}

/** Selects one customer on the Customers tab and starts receiving. */
async function selectAndReceive(name: string, expectedAmount: string) {
  fireEvent.click(await screen.findByRole("checkbox", { name: `Select ${name}` }));
  await waitFor(() => expect(screen.getByTestId("expected-payments")).toHaveTextContent(expectedAmount));
  fireEvent.click(screen.getByTestId("receive-continue"));
  await screen.findByText(name === "Alpha Dental" ? "INV-ALPHA" : "INV-BETA");
}

/** With "Email receipts to customers" off (the default) the receipt step opens without the email form. */
async function skipReceipt() {
  await screen.findByRole("dialog", { name: "Payment recorded" });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

/** After the last customer the batch ends and the selection surface returns empty. */
async function expectBatchFinished() {
  await waitFor(() => {
    expect(screen.queryByTestId("receive-practice-picker")).not.toBeInTheDocument();
    expect(screen.getByTestId("receive-summary-customers")).toHaveTextContent("0 customers selected");
  });
  expect(screen.getByTestId("receive-continue")).toBeDisabled();
}

function practicePicker() {
  return screen.getByTestId("receive-practice-picker");
}

function openPracticePicker() {
  if (practicePicker().getAttribute("aria-expanded") !== "true") {
    fireEvent.click(practicePicker());
  }
}

function togglePractice(name: string) {
  openPracticePicker();
  fireEvent.click(
    screen.getByRole("menuitemcheckbox", { name }),
  );
}

beforeEach(() => {
  postedPayments = [];
  paymentRoutes = [];
  failNextAlphaPayment = false;
  paidProviders = new Set();
  holdNextAlphaPayment = false;
  resolveHeldPayment = null;
  keepPaidProvidersEligible = false;
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      postMessage() {}
      close() {}
    },
  );
  installFetch();
});

afterEach(() => {
  delete window.umami;
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("Receive Payments multi-practice batch", () => {
  it.sequential("keeps selected accounts separate rather than presenting a combined balance", async () => {
    await renderPage();
    togglePractice("Beta Smiles");

    await waitFor(() => {
      // Each customer is a separate entry in the batch queue.
      const queue = within(screen.getByTestId("receive-queue"));
      expect(queue.getByText("Alpha Dental")).toBeInTheDocument();
      expect(queue.getByText("Beta Smiles")).toBeInTheDocument();
      expect(queue.getAllByRole("listitem")).toHaveLength(2);
      expect(screen.queryByText(/Combined selected statement balance/)).not.toBeInTheDocument();
    });
    expect(screen.getByText("Current payment · Alpha Dental")).toBeInTheDocument();
    expect(screen.getByText("INV-ALPHA")).toBeInTheDocument();

    togglePractice("Alpha Dental");
    await screen.findByText("INV-BETA");
    expect(screen.getByLabelText("Statement")).toHaveValue("statement-prov-beta");
    expect(screen.queryByRole("option", { name: /05\/31\/2026/ })).not.toBeInTheDocument();

    togglePractice("Alpha Dental");
    await waitFor(() => expect(screen.getAllByText("Alpha Dental").length).toBeGreaterThan(0));
    togglePractice("Beta Smiles");
    await waitFor(() => expect(screen.getAllByText("Alpha Dental").length).toBeGreaterThan(0));
  });

  it.sequential("opens a checkbox practice picker and updates its accessible selection", async () => {
    await renderPage();

    expect(practicePicker()).toHaveAttribute("aria-expanded", "false");
    expect(practicePicker()).toHaveTextContent("Alpha Dental");

    openPracticePicker();
    expect(practicePicker()).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Alpha Dental" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Beta Smiles" }),
    ).toHaveAttribute("aria-checked", "false");

    togglePractice("Beta Smiles");
    expect(practicePicker()).toHaveTextContent("2 customers selected");
    expect(screen.getByTestId("receive-practice-progress")).toHaveTextContent(
      "Customer 1 of 2: Alpha Dental",
    );

    fireEvent.keyDown(
      screen.getByRole("menuitemcheckbox", { name: "Beta Smiles" }),
      { key: "Escape" },
    );
    expect(practicePicker()).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(practicePicker());
  });

  it.sequential("closes on outside mouse interaction without changing selection or payment values", async () => {
    await renderPage();
    togglePractice("Beta Smiles");

    fireEvent.change(screen.getByLabelText("Total amount received"), {
      target: { value: "45.00" },
    });
    fireEvent.change(screen.getByLabelText("Reference number"), {
      target: { value: "OUTSIDE-CLICK" },
    });
    expect(practicePicker()).toHaveAttribute("aria-expanded", "true");

    fireEvent.mouseDown(document.body);

    expect(practicePicker()).toHaveAttribute("aria-expanded", "false");
    expect(practicePicker()).toHaveTextContent("2 customers selected");
    expect(screen.getByTestId("receive-practice-progress")).toHaveTextContent(
      "Customer 1 of 2: Alpha Dental",
    );
    expect(screen.getByLabelText("Total amount received")).toHaveValue(45);
    expect(screen.getByLabelText("Reference number")).toHaveValue(
      "OUTSIDE-CLICK",
    );
  });

  it.sequential("closes with Complete, returns focus to the trigger, and preserves state", async () => {
    await renderPage();
    togglePractice("Beta Smiles");

    fireEvent.change(screen.getByLabelText("Total amount received"), {
      target: { value: "55.00" },
    });
    fireEvent.change(screen.getByLabelText("Reference number"), {
      target: { value: "COMPLETE" },
    });
    expect(practicePicker()).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Complete" }));

    expect(practicePicker()).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(practicePicker());
    expect(practicePicker()).toHaveTextContent("2 customers selected");
    expect(screen.getByTestId("receive-practice-progress")).toHaveTextContent(
      "Customer 1 of 2: Alpha Dental",
    );
    expect(screen.getByLabelText("Total amount received")).toHaveValue(55);
    expect(screen.getByLabelText("Reference number")).toHaveValue("COMPLETE");
  });

  it.sequential("loads each provider separately, keeps form values independent, and tracks a saved-card payment", async () => {
    const track = vi.fn();
    window.umami = { track };
    await renderPage();
    togglePractice("Beta Smiles");

    fireEvent.change(screen.getByLabelText("Total amount received"), {
      target: { value: "45.00" },
    });
    fireEvent.change(screen.getByLabelText("Reference number"), {
      target: { value: "1234" },
    });
    fireEvent.change(screen.getByLabelText("Payment date"), {
      target: { value: "2026-08-12" },
    });
    fireEvent.change(screen.getByLabelText("Payment method"), {
      target: { value: "card" },
    });
    fireEvent.change(screen.getByLabelText("Memo"), {
      target: { value: "First practice" },
    });
    fireEvent.change(screen.getByLabelText("Payment for invoice INV-ALPHA"), {
      target: { value: "30.00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await skipReceipt();
    await screen.findByText("INV-BETA");
    expect(screen.queryByText("INV-ALPHA")).not.toBeInTheDocument();
    expect(screen.getByTestId("receive-practice-progress")).toHaveTextContent(
      "Customer 2 of 2: Beta Smiles",
    );
    expect(screen.getByLabelText("Total amount received")).toHaveValue(200);
    expect(screen.getByLabelText("Reference number")).toHaveValue("06-2026PMTCK");
    expect(screen.getByLabelText("Payment method")).toHaveValue("check");
    expect(screen.getByLabelText("Memo")).toHaveValue("");

    fireEvent.change(screen.getByLabelText("Total amount received"), {
      target: { value: "75.00" },
    });
    fireEvent.change(screen.getByLabelText("Reference number"), {
      target: { value: "BETA-REF" },
    });
    fireEvent.change(screen.getByLabelText("Memo"), {
      target: { value: "Second practice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await skipReceipt();
    await waitFor(() => expect(postedPayments).toHaveLength(2));
    await expectBatchFinished();
    expect(postedPayments[0]).toMatchObject({
      providerOrganizationId: "prov-alpha",
      statementId: "statement-prov-alpha",
      receivedAmount: 45,
      paymentDate: new Date("2026-08-12").toISOString(),
      paymentMethod: "card",
      checkNumber: null,
      cardLast4: "1234",
      memo: "First practice",
      applications: [{ invoiceId: "alpha-inv", amount: 30 }],
    });
    expect(postedPayments[1]).toMatchObject({
      providerOrganizationId: "prov-beta",
      statementId: "statement-prov-beta",
      receivedAmount: 75,
      checkNumber: "BETA-REF",
      cardLast4: null,
      memo: "Second practice",
      applications: [{ invoiceId: "beta-inv", amount: 75 }],
    });
    expect(postedPayments[1].receivedAmount).toBe(75);
    expect(paymentRoutes).toEqual(["saved-card", "ordinary"]);
    expect(track.mock.calls).toEqual([
      ["inline_card_payment_started", { card_source: "saved" }],
      ["inline_card_payment_succeeded", { card_source: "saved" }],
    ]);
  });

  it.sequential("records a check payment for every practice in the batch through the ordinary receipt route", async () => {
    const track = vi.fn();
    window.umami = { track };
    await renderPage();
    togglePractice("Beta Smiles");

    expect(screen.getByLabelText("Payment method")).toHaveValue("check");
    fireEvent.change(screen.getByLabelText("Total amount received"), {
      target: { value: "100.00" },
    });
    fireEvent.change(screen.getByLabelText("Reference number"), {
      target: { value: "ALPHA-CHECK" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await skipReceipt();
    await screen.findByText("INV-BETA");
    expect(screen.getByLabelText("Payment method")).toHaveValue("check");
    fireEvent.change(screen.getByLabelText("Total amount received"), {
      target: { value: "200.00" },
    });
    fireEvent.change(screen.getByLabelText("Reference number"), {
      target: { value: "BETA-CHECK" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await skipReceipt();
    await expectBatchFinished();
    expect(paymentRoutes).toEqual(["ordinary", "ordinary"]);
    expect(postedPayments).toEqual([
      expect.objectContaining({
        providerOrganizationId: "prov-alpha",
        paymentMethod: "check",
        checkNumber: "ALPHA-CHECK",
        cardLast4: null,
        receivedAmount: 100,
        applications: [expect.objectContaining({ invoiceId: "alpha-inv", amount: 100 })],
      }),
      expect.objectContaining({
        providerOrganizationId: "prov-beta",
        paymentMethod: "check",
        checkNumber: "BETA-CHECK",
        cardLast4: null,
        receivedAmount: 200,
        applications: [expect.objectContaining({ invoiceId: "beta-inv", amount: 200 })],
      }),
    ]);
    expect(screen.queryByText(/saved-card payments/)).not.toBeInTheDocument();
    expect(track).not.toHaveBeenCalled();
  });

  it.sequential("preserves each practice's card choice and card draft independently", async () => {
    await renderPage();
    togglePractice("Beta Smiles");

    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "card" } });
    fireEvent.click(screen.getByLabelText("Use a new card"));
    fireEvent.change(screen.getByLabelText("Cardholder name"), { target: { value: "Alpha Cardholder" } });
    fireEvent.click(screen.getByLabelText("Save this card on file"));

    togglePractice("Alpha Dental");
    await screen.findByText("INV-BETA");
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "card" } });
    fireEvent.click(screen.getByLabelText("Use a new card"));
    expect(screen.getByLabelText("Cardholder name")).toHaveValue("");
    expect(screen.getByLabelText("Save this card on file")).not.toBeChecked();

    togglePractice("Alpha Dental");
    togglePractice("Beta Smiles");
    await screen.findByText("INV-ALPHA");
    expect(screen.getByLabelText("Cardholder name")).toHaveValue("Alpha Cardholder");
    expect(screen.getByLabelText("Save this card on file")).toBeChecked();
  });

  it.sequential("stays on the current practice with its values after an error, then retries", async () => {
    failNextAlphaPayment = true;
    await renderPage();
    togglePractice("Beta Smiles");

    fireEvent.change(screen.getByLabelText("Total amount received"), {
      target: { value: "60.00" },
    });
    fireEvent.change(screen.getByLabelText("Reference number"), {
      target: { value: "RETRY-ME" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await screen.findByText("Payment could not be recorded.");
    expect(screen.getByText("INV-ALPHA")).toBeInTheDocument();
    expect(screen.getByLabelText("Total amount received")).toHaveValue(60);
    expect(screen.getByLabelText("Reference number")).toHaveValue("RETRY-ME");
    expect(screen.getByTestId("receive-practice-progress")).toHaveTextContent(
      "Customer 1 of 2: Alpha Dental",
    );
    expect(postedPayments).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await skipReceipt();
    await screen.findByText("INV-BETA");
    expect(postedPayments).toHaveLength(2);
    expect(postedPayments[0]).toEqual(postedPayments[1]);
  });

  it.sequential("locks batch membership while saving and cannot requeue a completed practice", async () => {
    keepPaidProvidersEligible = true;
    holdNextAlphaPayment = true;
    await renderPage();
    togglePractice("Beta Smiles");
    fireEvent.change(screen.getByLabelText("Total amount received"), {
      target: { value: "40.00" },
    });
    fireEvent.change(screen.getByLabelText("Reference number"), {
      target: { value: "ALPHA-LOCK" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(practicePicker()).toBeDisabled());
    fireEvent.click(practicePicker());
    expect(practicePicker()).toHaveAttribute("aria-expanded", "false");

    const releasePayment = resolveHeldPayment;
    expect(releasePayment).not.toBeNull();
    releasePayment?.();

    await skipReceipt();
    await screen.findByText("INV-BETA");
    openPracticePicker();
    const alphaOption = screen.getByRole("menuitemcheckbox", {
      name: "Alpha Dental",
    });
    expect(alphaOption).toBeDisabled();
    expect(alphaOption).toHaveAttribute("aria-checked", "true");
    fireEvent.click(alphaOption);
    expect(alphaOption).toHaveAttribute("aria-checked", "true");

    fireEvent.change(screen.getByLabelText("Total amount received"), {
      target: { value: "50.00" },
    });
    fireEvent.change(screen.getByLabelText("Reference number"), {
      target: { value: "BETA-LOCK" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await skipReceipt();
    await waitFor(() => expect(postedPayments).toHaveLength(2));
    expect(postedPayments.map((payment) => payment.providerOrganizationId)).toEqual([
      "prov-alpha",
      "prov-beta",
    ]);
  });

  it.sequential("never reactivates a completed practice when the remaining practice is removed", async () => {
    keepPaidProvidersEligible = true;
    await renderPage();
    togglePractice("Beta Smiles");
    fireEvent.change(screen.getByLabelText("Total amount received"), {
      target: { value: "40.00" },
    });
    fireEvent.change(screen.getByLabelText("Reference number"), {
      target: { value: "ALPHA-DONE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await skipReceipt();
    await screen.findByText("INV-BETA");
    openPracticePicker();
    const betaOption = screen.getByRole("menuitemcheckbox", {
      name: "Beta Smiles",
    });
    fireEvent.click(betaOption);

    expect(practicePicker()).toHaveTextContent("Select customer…");
    expect(
      screen.getByRole("button", { name: "Save payment" }),
    ).toBeDisabled();
    expect(screen.queryByText("INV-ALPHA")).not.toBeInTheDocument();
    expect(postedPayments).toHaveLength(1);
  });

  it.sequential("clears a successful partial-payment draft before the practice is selected again", async () => {
    keepPaidProvidersEligible = true;
    await renderPage();
    fireEvent.change(screen.getByLabelText("Total amount received"), {
      target: { value: "25.00" },
    });
    fireEvent.change(screen.getByLabelText("Reference number"), {
      target: { value: "ONE-TIME" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));

    await skipReceipt();
    await expectBatchFinished();
    await selectAndReceive("Alpha Dental", "$100.00");

    expect(screen.getByLabelText("Total amount received")).toHaveValue(100);
    expect(screen.getByLabelText("Reference number")).toHaveValue("06-2026PMTCK");
    expect(screen.getByLabelText("Statement")).toHaveValue("statement-prov-alpha");
    expect(screen.getByLabelText("Payment for invoice INV-ALPHA")).toHaveValue(100);
    expect(
      screen.getByRole("button", { name: "Save payment" }),
    ).not.toBeDisabled();
    expect(postedPayments).toHaveLength(1);
  });
});