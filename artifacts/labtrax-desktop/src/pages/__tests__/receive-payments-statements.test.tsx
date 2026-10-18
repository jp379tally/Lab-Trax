/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ReceivePaymentsPage, { localCalendarDate, paymentErrorMessage } from "@/pages/finance/receive-payments";
import { ApiError } from "@/lib/api";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { receivePaymentCancellationRefusal, receivePaymentRoute, receivePaymentRouteRefusal, type ReceivePaymentRoute } from "../../__tests__/receive-payment-routes";

const stripeMocks = vi.hoisted(() => ({
  confirmPayment: vi.fn(),
  submit: vi.fn(),
}));
vi.mock("@stripe/react-stripe-js", () => {
  const React = require("react");
  const Context = React.createContext({ stripe: { confirmPayment: stripeMocks.confirmPayment }, elements: { submit: stripeMocks.submit } });
  return {
    Elements: ({ children }: { children: any; options?: { amount?: number } }) => <Context.Provider value={{ stripe: { confirmPayment: stripeMocks.confirmPayment }, elements: { submit: stripeMocks.submit } }}>{children}</Context.Provider>,
    PaymentElement: () => <div data-testid="inline-payment-element">Secure Stripe PaymentElement</div>,
    useStripe: () => React.useContext(Context).stripe,
  useElements: () => React.useContext(Context).elements,
  };
});
vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn(async () => ({ confirmPayment: stripeMocks.confirmPayment })) }));

const invoices = [
  { id: "seed-a", labOrganizationId: "lab", providerOrganizationId: "a", providerOrganization: { name: "Alpha" }, status: "sent", balanceDue: "100.00" },
  { id: "seed-b", labOrganizationId: "lab", providerOrganizationId: "b", providerOrganization: { name: "Beta" }, status: "sent", balanceDue: "200.00" },
];
const lists: Record<string, any[]> = {
  a: [{ id: "a-new", periodEnd: "2026-02-28", savedBalanceDue: "100.00", invoiceCount: 2 }, { id: "a-old", periodEnd: "2026-01-31", savedBalanceDue: "30.00", invoiceCount: 1 }],
  b: [{ id: "b-new", periodEnd: "2026-02-28", savedBalanceDue: "200.00", invoiceCount: 1 }],
};
const details: Record<string, any> = {
  "a-new": { invoices: [
    { id: "late", invoiceNumber: "INV-LATE", patientName: "Ada", doctorName: "Dr. Ada", dueAt: new Date(2026, 0, 1, 12).toISOString(), total: "80.00", currentBalanceDue: "80.00", eligibleForPayment: true },
    { id: "new", invoiceNumber: "INV-NEW", patientName: "Bea", doctorName: "Dr. Bea", dueAt: "2026-02-01", total: "20.00", currentBalanceDue: "20.00", eligibleForPayment: true },
  ] },
  "a-old": { invoices: [{ id: "old", invoiceNumber: "INV-OLD", total: "30.00", currentBalanceDue: "30.00", eligibleForPayment: true }] },
  "b-new": { invoices: [{ id: "beta", invoiceNumber: "INV-B", total: "200.00", currentBalanceDue: "200.00", eligibleForPayment: true }] },
};
let invoiceLedAccounts: any[] = [];
let mixedContext = false;
let contextProvenance: "snapshot" | "live" | undefined;
let posts: any[] = [], requests: Array<{ path: string; method?: string; body?: any }> = [], fail = false, deleted = false, cancelFails = false, sendDelivered = true, sendPending = false, cancelPending = false, cardReversal: any = null, inlinePrepareResponse: any = { clientSecret: "pi-secret", paymentIntentId: "pi-inline-1", status: "requires_payment_method" }, inlineConfirmResponse: any = { id: "session-1", customerEmail: "billing@alpha.test", receiptNumber: "R-1" };
let resolveSend: (() => void) | undefined, resolveCancel: (() => void) | undefined;
// The server route each ordinary or saved-card save was sent to, in order, and
// the account's available customer credit.
let paymentRoutes: ReceivePaymentRoute[] = [], availableCredit = "0.00";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  invoiceLedAccounts = []; mixedContext = false; contextProvenance = undefined;
  posts = []; requests = []; fail = false; deleted = false; cancelFails = false; sendDelivered = true; sendPending = false; cancelPending = false; cardReversal = null; inlinePrepareResponse = { clientSecret: "pi-secret", paymentIntentId: "pi-inline-1", status: "requires_payment_method" }; inlineConfirmResponse = { id: "session-1", customerEmail: "billing@alpha.test", receiptNumber: "R-1" }; resolveSend = undefined; resolveCancel = undefined;
  paymentRoutes = []; availableCredit = "0.00";
  stripeMocks.confirmPayment.mockReset().mockResolvedValue({ paymentIntent: { id: "pi-inline-1" } });
  stripeMocks.submit.mockReset().mockResolvedValue({});
  vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input.toString(), "http://localhost").pathname;
    requests.push({ path, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith("/organizations")) return response([{ id: "lab", name: "Lab", type: "lab" }]);
    // Receive Payments is gated on the user's role in the selected lab.
    if (path.endsWith("/auth/me")) return response({ user: { id: "u", role: "admin", userType: "lab" }, memberships: [{ organizationId: "lab", role: "admin", status: "active", organization: { id: "lab", name: "Lab" } }] });
    if (path.endsWith("/finance/accounts")) return response([]);
    if (path.endsWith("/finance/undeposited-funds")) return response({ count: 0, total: 0 });
    if (path.endsWith("/billing/lab/eligible-statement-accounts")) return response([
      { providerOrganizationId: "a", providerName: "Alpha", statementId: "a-new", periodEnd: "2026-02-28", sentAt: "2026-03-01", invoiceCount: 2, currentBalanceDue: lists.a[0]?.savedBalanceDue || "0.00" },
      { providerOrganizationId: "b", providerName: "Beta", statementId: "b-new", periodEnd: "2026-02-28", sentAt: "2026-03-01", invoiceCount: 1, currentBalanceDue: lists.b[0]?.savedBalanceDue || "0.00" },
    ].filter(account => Number(account.currentBalanceDue) > 0));
    if (path.endsWith("/billing/lab/eligible-invoice-accounts")) return response(invoiceLedAccounts);
    if (path.endsWith("/invoices")) return response(invoices);
    if (path.endsWith("/provider/lab-card")) return response({ card: { brand: "Visa", last4: "1234" } });
    if (path.endsWith("/billing/payment-sessions/card/config")) return response({ publishableKey: "pk_test_inline" });
    if (path.endsWith("/customer-credits")) return response({ totalAvailable: availableCredit, credits: [] });
    const statement = path.match(/statements\/([^/]+)$/)?.[1];
    if (statement) return response(mixedContext && statement === "a-new"
      ? { ...details[statement], detailProvenance: "mixed", invoices: [...details[statement].invoices, { id: "deleted", invoiceNumber: "Unavailable", currentBalanceDue: "40.00", eligibleForPayment: false, detailProvenance: "unavailable" }] }
      : { ...details[statement], ...(contextProvenance ? { detailProvenance: contextProvenance } : {}) });
    const account = path.match(/accounts\/([^/]+)\/statements/)?.[1];
    if (account) return response(lists[account]);
    const paymentRoute = receivePaymentRoute(path);
    if (paymentRoute && init?.method === "POST") {
      const body = JSON.parse(String(init.body)); posts.push(body); paymentRoutes.push(paymentRoute);
      // Like the real server, each route refuses the other's payments before
      // anything is recorded.
      const refusal = receivePaymentRouteRefusal(paymentRoute, body);
      if (refusal) return response({ ok: false, message: refusal }, 400);
      return fail ? response({ message: "Try again" }, 500) : response({ id: "session-1", customerEmail: "billing@alpha.test", receiptNumber: "R-1" }, 201);
    }
    if (path.endsWith("/payment-sessions/card/prepare") && init?.method === "POST") {
      return response(inlinePrepareResponse);
    }
    if (path.endsWith("/payment-sessions/card/confirm") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)); posts.push(body);
      return response(inlineConfirmResponse, 201);
    }
    if (path.endsWith("/payment-receipt-template")) return response({ emailSubject: "Receipt {{receiptNumber}}", emailBody: "Thanks {{customerName}}" });
    if (path.endsWith("/send-receipt") && init?.method === "POST") {
      if (sendPending) return new Promise<Response>(resolve => { resolveSend = () => resolve(response({ delivered: true })); });
      return response(sendDelivered ? { delivered: true } : { delivered: false, reason: "Mailbox unavailable" });
    }
    if (path.endsWith("/receipt.pdf")) return new Response("pdf", { status: 200, headers: { "Content-Type": "application/pdf" } });
    if (path.endsWith("/session-1") && !init?.method) return response({ id: "session-1", reversal: cardReversal });
    if (path.endsWith("/session-1") && init?.method === "DELETE") {
      deleted = true;
      // Like the real server, a receipt recorded as a card payment that charged
      // nothing has no charge to reverse and cannot be cancelled.
      const cancelRefusal = posts.length ? receivePaymentCancellationRefusal(posts[posts.length - 1]) : null;
      if (cancelRefusal) return response({ ok: false, message: cancelRefusal }, 409);
      if (cancelPending) return new Promise<Response>(resolve => { resolveCancel = () => resolve(response({})); });
      return cancelFails ? response({ message: "Payment cannot be cancelled" }, 500) : response(cardReversal ? { id: "session-1", reversal: cardReversal } : {});
    }
    return response({});
  }));
});
afterEach(() => vi.unstubAllGlobals());
async function page(waitForInvoices = true) {
  const Wrapper = makeAuthWrapper("/finance/receive-payments", { user: { id: "u", role: "admin", userType: "lab", practiceOrganizationId: "lab" } as any, status: "authed", restoreStatus: "ok", restoreNoticeDismissed: true });
  render(<Wrapper><ReceivePaymentsPage /></Wrapper>);
  if (waitForInvoices) {
    fireEvent.click((await screen.findAllByRole("checkbox", { name: "Select Alpha" }))[0]);
    await waitFor(() => expect(screen.getByTestId("expected-payments")).toHaveTextContent("$100.00"));
    // These suites exercise the receipt email form, which opens after each
    // payment only with "Email receipts to customers" on.
    fireEvent.click(screen.getByLabelText("Email receipts to customers"));
    fireEvent.click(screen.getByTestId("receive-continue"));
    await screen.findByText("INV-LATE");
  }
}
async function recordPayment() {
  fireEvent.change(screen.getByLabelText("Total amount received"), { target: { value: "100" } });
  fireEvent.change(screen.getByLabelText("Reference number"), { target: { value: "1234" } });
  fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
  await screen.findByRole("dialog", { name: "Email payment receipt" });
}
async function addBeta() {
  fireEvent.click(screen.getByTestId("receive-practice-picker"));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Beta" }));
  // Beta joins the batch queue as its own customer.
  await within(await screen.findByTestId("receive-queue")).findByText("Beta");
}
function expectReceiptActionsDisabled(activeAction: "Sending…" | "Cancelling…") {
  for (const name of ["Preview / download PDF", "Skip", activeAction === "Sending…" ? "Sending…" : "Email receipt", "Dismiss", activeAction === "Cancelling…" ? "Cancelling…" : "Cancel email and payment"]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
  }
}

describe("statement receive payments", () => {
  it("keeps fenced card attempts explicit about the safe next step", () => {
    expect(paymentErrorMessage(new ApiError("blocked", 409, {
      details: { code: "CARD_PAYMENT_ATTEMPT_BLOCKED", nextStep: "automatic_reconciliation" },
    }))).toContain("Stripe is still confirming a prior card attempt");
    expect(paymentErrorMessage(new ApiError("blocked", 409, {
      details: { code: "CARD_PAYMENT_ATTEMPT_BLOCKED", nextStep: "support_review" },
    }))).toContain("Support review is required");
    expect(paymentErrorMessage(new ApiError("blocked", 409, {
      details: { code: "CARD_PAYMENT_ATTEMPT_BLOCKED", nextStep: "support_review" },
    }))).toContain("Do not submit another charge");
  });
  it("formats the payment date from the local calendar rather than UTC", () => {
    // This instant is the prior local calendar day in western time zones.
    const date = new Date(2026, 7, 12, 0, 15, 0);
    expect(localCalendarDate(date)).toBe("2026-08-12");
  });

  it("warns for mixed statement details and disables unavailable invoice actions", async () => {
    mixedContext = true;
    await page();
    expect(await screen.findByText(/Some invoice details/)).toBeInTheDocument();
    const unavailable = screen.getByLabelText("Select invoice Unavailable");
    expect(unavailable).toBeDisabled();
    const row = unavailable.closest("tr")!;
    expect(within(row).getByLabelText("Payment for invoice Unavailable")).toBeDisabled();
    expect(within(row).getByLabelText("Credit for invoice Unavailable")).toBeDisabled();
  });

  it("warns for live details and stays quiet for snapshot details", async () => {
    contextProvenance = "live";
    await page();
    expect(await screen.findByText(/older statement has no invoice-detail snapshot/)).toBeInTheDocument();
    cleanup();
    contextProvenance = "snapshot";
    await page();
    await screen.findByLabelText("Payment for invoice INV-LATE");
    expect(screen.queryByText(/older statement has no invoice-detail snapshot/)).not.toBeInTheDocument();
  });

  it("keeps account statement choices, allocates oldest first, and submits the full receipt amount", async () => {
    await page();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("01/01/2026")).toBeInTheDocument();
    await addBeta();
    fireEvent.change(screen.getByLabelText("Total amount received"), { target: { value: "90" } });
    expect(screen.getByLabelText("Payment for invoice INV-LATE")).toHaveValue(80);
    expect(screen.getByLabelText("Payment for invoice INV-NEW")).toHaveValue(10);
    expect(screen.getByText("Existing credit applied")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reference number"), { target: { value: "1234" } });
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "card" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
    await screen.findByRole("dialog", { name: "Email payment receipt" });
    expect(posts[0]).toMatchObject({ statementId: "a-new", receivedAmount: 90, cardLast4: "1234", checkNumber: null });
    expect(paymentRoutes).toEqual(["saved-card"]);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await screen.findByText("INV-B");
  });

  it.each(["check", "cash", "ach", "other"] as const)("records a %s payment through the ordinary receipt route and reaches the receipt step", async (method) => {
    await page();
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: method } });
    await recordPayment();
    expect(paymentRoutes).toEqual(["ordinary"]);
    expect(posts).toEqual([expect.objectContaining({
      statementId: "a-new",
      providerOrganizationId: "a",
      paymentMethod: method,
      receivedAmount: 100,
      checkNumber: method === "check" ? "1234" : null,
      referenceNumber: method === "ach" || method === "other" ? "1234" : null,
      cardLast4: null,
    })]);
    expect(screen.queryByText(/saved-card payments/)).not.toBeInTheDocument();
  });

  it.each([
    { label: "Check", method: "check" },
    { label: "Cash", method: "cash" },
    { label: "ACH", method: "ach" },
    { label: "Other", method: "other" },
    { label: "a saved card", method: "card", cardChoice: "saved" },
    { label: "a new card", method: "card", cardChoice: "new" },
  ] as const)("applies only existing customer credit through the ordinary receipt route with $label selected, and can cancel it", async (scenario) => {
    availableCredit = "50.00";
    await page();
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: scenario.method } });
    if ("cardChoice" in scenario) {
      fireEvent.click(await screen.findByLabelText(scenario.cardChoice === "new" ? "Use a new card" : "Use saved Visa ···· 1234"));
    }
    fireEvent.change(screen.getByLabelText("Total amount received"), { target: { value: "0" } });
    const credit = screen.getByLabelText("Credit for invoice INV-LATE");
    await waitFor(() => expect(credit).not.toBeDisabled());
    fireEvent.change(credit, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
    await screen.findByRole("dialog", { name: "Email payment receipt" });

    expect(paymentRoutes).toEqual(["ordinary"]);
    expect(posts).toEqual([expect.objectContaining({
      statementId: "a-new",
      // No card is charged, so the receipt is not recorded as a card payment.
      paymentMethod: scenario.method === "card" ? "other" : scenario.method,
      receivedAmount: 0,
      existingCreditAmount: 30,
      checkNumber: null,
      referenceNumber: null,
      cardLast4: null,
      applications: [{ invoiceId: "late", amount: 0, creditAmount: 30 }],
    })]);
    expect(requests.some(request => /\/payment-sessions\/card\/(prepare|confirm)$/.test(request.path))).toBe(false);

    // Cancelling is how a mistaken credit application is undone and the
    // credit restored, so the receipt must be cancellable.
    vi.stubGlobal("confirm", vi.fn(() => true));
    fireEvent.click(screen.getByRole("button", { name: "Cancel email and payment" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Email payment receipt" })).not.toBeInTheDocument());
    expect(deleted).toBe(true);
    expect(screen.queryByText(/cannot be reversed/)).not.toBeInTheDocument();
  });

  it("filters statement invoices by doctor and recalculates the allocation", async () => {
    await page();

    const doctor = screen.getByLabelText("Payment for");
    expect(doctor).toHaveValue("");
    expect(screen.getByLabelText("Total amount received")).toHaveValue(100);
    expect(screen.getByLabelText("Payment for invoice INV-LATE")).toHaveValue(80);
    expect(screen.getByLabelText("Payment for invoice INV-NEW")).toHaveValue(20);

    fireEvent.change(doctor, { target: { value: "Dr. Bea" } });
    await waitFor(() => {
      expect(screen.queryByText("INV-LATE")).not.toBeInTheDocument();
      expect(screen.getByText("INV-NEW")).toBeInTheDocument();
      expect(screen.getByLabelText("Total amount received")).toHaveValue(100);
    });
    expect(screen.getByLabelText("Payment for invoice INV-NEW")).toHaveValue(20);

    fireEvent.change(doctor, { target: { value: "Dr. Ada" } });
    await waitFor(() => {
      expect(screen.getByText("INV-LATE")).toBeInTheDocument();
      expect(screen.getByLabelText("Total amount received")).toHaveValue(80);
    });
    expect(screen.getByLabelText("Payment for invoice INV-LATE")).toHaveValue(80);
  });

  it("supports a new inline card, leaves save default off, and sends only a Stripe token payload", async () => {
    await page();
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "card" } });
    fireEvent.click(screen.getByLabelText("Use a new card"));
    expect(screen.getByTestId("inline-payment-element")).toBeInTheDocument();
    expect(screen.getByLabelText("Save this card on file")).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Cardholder name"), { target: { value: "Ada Lovelace" } });
    fireEvent.click(screen.getByLabelText("Save this card on file"));
    fireEvent.change(screen.getByLabelText("Total amount received"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
    await screen.findByRole("dialog", { name: "Email payment receipt" });

    const prepare = requests.find(request => request.path.endsWith("/payment-sessions/card/prepare"));
    const confirm = requests.find(request => request.path.endsWith("/payment-sessions/card/confirm"));
    expect(prepare?.body).toMatchObject({ paymentMethod: "card", savePaymentMethod: true });
    expect(confirm?.body).toMatchObject({ paymentMethod: "card", savePaymentMethod: true, paymentIntentId: "pi-inline-1" });
    expect(paymentRoutes).toEqual([]);
    for (const body of [prepare?.body, confirm?.body]) {
      expect(body).not.toHaveProperty("cardNumber");
      expect(body).not.toHaveProperty("pan");
      expect(body).not.toHaveProperty("cvc");
      expect(body).not.toHaveProperty("expiry");
      expect(body).not.toHaveProperty("expMonth");
      expect(body).not.toHaveProperty("expYear");
    }
    expect(stripeMocks.confirmPayment).toHaveBeenCalledWith(expect.objectContaining({
      clientSecret: "pi-secret",
      redirect: "if_required",
    }));
  });

  it("reconciles an already-succeeded inline card without reconfirming it", async () => {
    inlinePrepareResponse = {
      clientSecret: "pi-secret",
      paymentIntentId: "pi-inline-1",
      status: "succeeded",
    };
    await page();
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "card" } });
    fireEvent.click(screen.getByLabelText("Use a new card"));
    fireEvent.change(screen.getByLabelText("Cardholder name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Total amount received"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
    await screen.findByRole("dialog", { name: "Email payment receipt" });
    expect(stripeMocks.submit).not.toHaveBeenCalled();
    expect(stripeMocks.confirmPayment).not.toHaveBeenCalled();
    expect(requests.some(request => request.path.endsWith("/payment-sessions/card/confirm"))).toBe(true);
  });

  it("accepts the server receipt when Stripe confirmation throws after processing", async () => {
    stripeMocks.confirmPayment.mockRejectedValueOnce(new Error("Network response was lost."));
    await page();
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "card" } });
    fireEvent.click(screen.getByLabelText("Use a new card"));
    fireEvent.change(screen.getByLabelText("Cardholder name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Total amount received"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
    await screen.findByRole("dialog", { name: "Email payment receipt" });
    expect(screen.queryByText("Network response was lost.")).not.toBeInTheDocument();
  });

  it.each([
    ["Stripe validation", { error: { message: "Check your card details." } }, "Check your card details."],
    ["decline", { error: { message: "Your card was declined." } }, "Your card was declined."],
    ["pending", { paymentIntent: { id: "pi-inline-1" } }, "Stripe is still confirming a prior card attempt"],
    ["action required", { paymentIntent: { id: "pi-inline-1" } }, "The card requires additional authentication"],
  ] as const)("keeps the draft and reports inline card %s", async (name, stripeResult, expected) => {
    void name;
    stripeMocks.confirmPayment.mockResolvedValueOnce(stripeResult);
    inlineConfirmResponse = "paymentIntent" in stripeResult
      ? { status: name === "pending" ? "processing" : "requires_action" }
      : { status: "requires_payment_method" };
    await page();
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "card" } });
    fireEvent.click(screen.getByLabelText("Use a new card"));
    fireEvent.change(screen.getByLabelText("Cardholder name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Total amount received"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
    await screen.findByText(expected, { exact: false });
    expect(screen.getByLabelText("Total amount received")).toHaveValue(100);
    expect(screen.queryByRole("dialog", { name: "Email payment receipt" })).not.toBeInTheDocument();
  });

  it("preserves a failed draft and can cancel a recorded payment", async () => {
    await page();
    fireEvent.change(screen.getByLabelText("Total amount received"), { target: { value: "105" } });
    fireEvent.change(screen.getByLabelText("Reference number"), { target: { value: "77" } });
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
    await screen.findByText("Try again");
    expect(screen.getByLabelText("Total amount received")).toHaveValue(105);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
    await screen.findByRole("dialog", { name: "Email payment receipt" });
    vi.stubGlobal("confirm", vi.fn(() => true));
    fireEvent.click(screen.getByRole("button", { name: "Cancel email and payment" }));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it("shows a processor-backed card reversal as pending and prevents duplicate requests", async () => {
    await page();
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "card" } });
    fireEvent.change(screen.getByLabelText("Total amount received"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
    await screen.findByRole("dialog", { name: "Email payment receipt" });
    cardReversal = { status: "pending" };
    vi.stubGlobal("confirm", vi.fn(() => true));
    fireEvent.click(screen.getByRole("button", { name: "Cancel email and payment" }));
    await screen.findByText(/Card reversal pending/);
    expect(screen.getByRole("button", { name: "Preview / download PDF" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel email and payment" })).toBeDisabled();
    expect(requests.filter(request => request.path.endsWith("/payment-sessions/session-1") && !request.method).length).toBeGreaterThan(0);
  });

  it.each([
    ["completed", undefined, /Card reversal completed/, "Cancel email and payment"],
    ["failed", "processor_declined", /Reversal needs review/, "Retry reversal"],
  ] as const)("shows a flat processor reversal response as %s", async (status, reason, message, action) => {
    await page();
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "card" } });
    fireEvent.change(screen.getByLabelText("Total amount received"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
    await screen.findByRole("dialog", { name: "Email payment receipt" });
    cardReversal = { status, reason };
    vi.stubGlobal("confirm", vi.fn(() => true));
    fireEvent.click(screen.getByRole("button", { name: "Cancel email and payment" }));
    await screen.findByText(message);
    if (status === "completed") expect(screen.queryByRole("button", { name: "Cancel email and payment" })).not.toBeInTheDocument();
    else {
      expect(screen.getByRole("alert")).toHaveTextContent("The payment remains recorded (processor_declined)");
      expect(screen.queryByRole("button", { name: action })).not.toBeInTheDocument();
    }
  });

  it("keeps the receipt dialog open when a 200 response reports email delivery failed, then advances after retry", async () => {
    await page();
    await addBeta();
    await recordPayment();

    sendDelivered = false;
    fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog", { name: "Email payment receipt" })).toBeInTheDocument();

    sendDelivered = true;
    fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
    await screen.findByText("INV-B");
    expect(screen.queryByRole("dialog", { name: "Email payment receipt" })).not.toBeInTheDocument();
  });

  it("keeps the receipt dialog and draft after cancellation fails, then advances after retry", async () => {
    await page();
    await addBeta();
    fireEvent.change(screen.getByLabelText("Total amount received"), { target: { value: "105" } });
    fireEvent.change(screen.getByLabelText("Reference number"), { target: { value: "77" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
    await screen.findByRole("dialog", { name: "Email payment receipt" });
    vi.stubGlobal("confirm", vi.fn(() => true));

    cancelFails = true;
    fireEvent.click(screen.getByRole("button", { name: "Cancel email and payment" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog", { name: "Email payment receipt" })).toBeInTheDocument();
    expect(screen.getByLabelText("Total amount received")).toHaveValue(105);

    cancelFails = false;
    fireEvent.click(screen.getByRole("button", { name: "Cancel email and payment" }));
    await screen.findByText("INV-B");
  });

  it("requests the receipt PDF without advancing the payment flow", async () => {
    await page();
    await addBeta();
    await recordPayment();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    fireEvent.click(screen.getByRole("button", { name: "Preview / download PDF" }));
    await waitFor(() => expect(requests.some(request => request.path.endsWith("/billing/payment-sessions/session-1/receipt.pdf"))).toBe(true));
    expect(screen.getByRole("dialog", { name: "Email payment receipt" })).toBeInTheDocument();
    expect(screen.queryByText("INV-B")).not.toBeInTheDocument();
    click.mockRestore();
  });

  it("disables every mutually exclusive receipt action while sending", async () => {
    await page();
    await recordPayment();

    sendPending = true;
    fireEvent.click(screen.getByRole("button", { name: "Email receipt" }));
    await screen.findByRole("button", { name: "Sending…" });
    expectReceiptActionsDisabled("Sending…");
    resolveSend?.();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Email payment receipt" })).not.toBeInTheDocument());
  });

  it("disables every mutually exclusive receipt action while cancelling", async () => {
    await page();
    await recordPayment();
    vi.stubGlobal("confirm", vi.fn(() => true));
    cancelPending = true;
    fireEvent.click(screen.getByRole("button", { name: "Cancel email and payment" }));
    await screen.findByRole("button", { name: "Cancelling…" });
    expectReceiptActionsDisabled("Cancelling…");
    resolveCancel?.();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Email payment receipt" })).not.toBeInTheDocument());
  });

  it("disables Save for an account with neither a statement nor an outstanding invoice", async () => {
    const original = lists.a;
    lists.a = [{ id: "a-zero", periodEnd: "2026-02-28", savedBalanceDue: "0.00", invoiceCount: 1 }];
    try {
      await page(false);
      await screen.findByRole("checkbox", { name: "Select Beta" });
      expect(screen.queryByRole("checkbox", { name: "Select Alpha" })).not.toBeInTheDocument();
      expect(screen.getByTestId("receive-continue")).toBeDisabled();
      expect(requests.some(request => request.path === "/invoices/receive-payments")).toBe(false);
      expect(posts).toEqual([]);
    } finally {
      lists.a = original;
    }
  });

  it("scopes a selected statement to its own invoices and reveals the rest only under No statement", async () => {
    // The account has an invoice the statement never covered. While the
    // statement is selected the server rejects paying it, so it must not be
    // offered or auto-allocated here.
    invoiceLedAccounts = [{
      providerOrganizationId: "a",
      providerName: "Alpha",
      statementId: null,
      periodEnd: "2026-02-28",
      sentAt: "",
      invoiceCount: 3,
      currentBalanceDue: "145.00",
      outstandingInvoices: [
        { id: "late", invoiceNumber: "INV-LATE", patientName: "Ada", doctorName: "Dr. Ada", dueAt: "2026-01-01", total: "80.00", currentBalanceDue: "80.00", eligibleForPayment: true },
        { id: "new", invoiceNumber: "INV-NEW", patientName: "Bea", doctorName: "Dr. Bea", dueAt: "2026-02-01", total: "20.00", currentBalanceDue: "20.00", eligibleForPayment: true },
        { id: "offstmt", invoiceNumber: "INV-OFFSTMT", patientName: "Cy", doctorName: "Dr. Cy", dueAt: "2026-03-01", total: "45.00", currentBalanceDue: "45.00", eligibleForPayment: true },
      ],
    }];
    await page();

    expect(screen.getByLabelText("Statement")).toHaveValue("a-new");
    await screen.findByText("INV-LATE");
    expect(screen.queryByText("INV-OFFSTMT")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Total amount received")).toHaveValue(100);

    fireEvent.change(screen.getByLabelText("Statement"), { target: { value: "" } });
    await screen.findByText("INV-OFFSTMT");
    expect(screen.getByText("INV-LATE")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Total amount received"), { target: { value: "145" } });
    fireEvent.change(screen.getByLabelText("Reference number"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payment" }));
    await screen.findByRole("dialog", { name: "Email payment receipt" });
    expect(posts[0]).toMatchObject({ statementId: null, receivedAmount: 145 });
    expect(posts[0].applications).toEqual(expect.arrayContaining([
      expect.objectContaining({ invoiceId: "offstmt", amount: 45 }),
    ]));
  });

  it("pays outstanding invoices for an account with no statement and posts a null statementId", async () => {
    const original = lists.a;
    lists.a = [{ id: "a-zero", periodEnd: "2026-02-28", savedBalanceDue: "0.00", invoiceCount: 1 }];
    invoiceLedAccounts = [{
      providerOrganizationId: "a",
      providerName: "Alpha",
      statementId: null,
      periodEnd: "2026-02-28",
      sentAt: "",
      invoiceCount: 2,
      currentBalanceDue: "100.00",
      outstandingInvoices: [
        { id: "late", invoiceNumber: "INV-LATE", patientName: "Ada", doctorName: "Dr. Ada", dueAt: "2026-01-01", total: "80.00", currentBalanceDue: "80.00", eligibleForPayment: true },
        { id: "new", invoiceNumber: "INV-NEW", patientName: "Bea", doctorName: "Dr. Bea", dueAt: "2026-02-01", total: "20.00", currentBalanceDue: "20.00", eligibleForPayment: true },
      ],
    }];
    try {
      await page();
      expect(screen.getByLabelText("Statement")).toHaveValue("");
      await screen.findByText("No saved statement for this account. Its outstanding invoices are listed in the invoice table and can be paid directly.");
      await recordPayment();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ statementId: null, providerOrganizationId: "a", receivedAmount: 100 });
      expect(posts[0].applications).toEqual(expect.arrayContaining([
        expect.objectContaining({ invoiceId: "late", amount: 80 }),
        expect.objectContaining({ invoiceId: "new", amount: 20 }),
      ]));
    } finally {
      lists.a = original;
    }
  });
});