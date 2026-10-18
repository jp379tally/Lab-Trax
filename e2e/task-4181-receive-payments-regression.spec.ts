import { test, expect, type Page, type Route } from "@playwright/test";

const LAB = "lab-4181";
const ALPHA = "customer-alpha";
const BETA = "customer-beta";
const BASE_URL = process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:80";

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

test("4181 records ordered customer payments and reconciles them everywhere", async ({ page }) => {
  const paymentPosts: Array<{ customer: string; receivedAmount: number; creditAmount: number }> = [];
  const requests: string[] = [];
  const sendReceiptCalls: string[] = [];
  const payments = new Map<string, { id: string; amount: string; receipt: string }>();
  let makeDepositsLoads = 0;

  const organizations = [
    { id: LAB, name: "Lab 4181", displayName: "Lab 4181", type: "lab", billingEmail: "lab@example.test" },
    { id: ALPHA, name: "Alpha Dental", displayName: "Alpha Dental", type: "provider", parentLabOrganizationId: LAB, billingEmail: "alpha@example.test" },
    { id: BETA, name: "Beta Dental", displayName: "Beta Dental", type: "provider", parentLabOrganizationId: LAB, billingEmail: "beta@example.test" },
  ];
  const account = (id: string, name: string, amount: string) => ({
    providerOrganizationId: id, providerName: name, statementId: `statement-${id}`,
    periodEnd: "2025-01-31", sentAt: "2025-02-01T00:00:00Z", invoiceCount: 1,
    currentBalanceDue: amount, statementCount: 1, sentDates: ["2025-02-01T00:00:00Z"],
    outstandingInvoices: [{ id: `invoice-${id}`, invoiceNumber: `INV-${id.slice(-1)}`,
      patientName: `${name} Patient`, doctorName: "Dr. Ledger", issuedAt: "2025-01-01",
      dueAt: "2025-01-31", total: amount, currentBalanceDue: amount, eligibleForPayment: true }],
  });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();
    requests.push(`${method} ${path}${url.search}`);
    if (path === "/auth/me") return fulfill(route, {
      success: true, user: { id: "user-4181", username: "admin", firstName: "Test", lastName: "Admin",
        email: "admin@example.test", userType: "lab", role: "owner" },
      memberships: [{ organizationId: LAB, role: "owner", status: "active", organization: { id: LAB, type: "lab" } }],
    });
    if (path === "/billing/subscription") return fulfill(route, {
      ok: true,
      entitlement: { status: "active", accessLevel: "full", planType: "lab" },
    });
    if (path === "/organizations" || path === "/organizations/") return fulfill(route, organizations);
    if (path === "/organizations/connections") return fulfill(route, []);
    if (path === "/organizations/shared-accounts") return fulfill(route, {
      contact: null,
      card: null,
      profileChangeRequests: [],
    });
    if (/^\/organizations\/(customer-alpha|customer-beta)$/.test(path)) {
      return fulfill(route, organizations.find((o) => o.id === path.split("/").pop()));
    }
    if (path === "/cases" || path === "/invoices") return fulfill(route, []);
    if (path === "/cases/legacy-doctor-directory") return fulfill(route, []);
    if (path.includes("/members") || path.includes("/unassigned-doctors") || path.includes("/invites")) return fulfill(route, []);
    if (path.includes("/doctor-duplicate") || path.includes("/doctor-duplicates")) return fulfill(route, { clusters: [] });
    if (path === "/finance/accounts") return fulfill(route, [{
      id: "bank-4181", name: "Operating Checking", accountType: "bank", isArchived: false, last4: "4181",
    }]);
    if (path === "/finance/undeposited-funds" && method === "GET") {
      if (url.searchParams.get("summary")) return fulfill(route, { count: payments.size, total: [...payments.values()].reduce((n, p) => n + Number(p.amount), 0) });
      makeDepositsLoads++;
      return fulfill(route, [...payments.values()].map((p) => ({
        id: `uf-${p.id}`, txnDate: "2025-02-10", payee: p.id === "payment-alpha" ? "Alpha Dental" : "Beta Dental",
        memo: null, creditAmount: p.amount, staleDays: 1, ageWarning: false, statementDate: "2025-01-31",
        invoiceLinks: [{ invoiceId: `invoice-${p.id.replace("payment-", "")}`, invoiceNumber: `INV-${p.id.slice(-5, -4)}` }],
        paymentSession: { id: p.id, receiptNumber: p.receipt, statementId: `statement-customer-${p.id.slice(-5, -4)}`,
          receivedAmount: p.amount, appliedAmount: p.amount, customerCreditAmount: "0", customerCreditRemaining: "0",
          paymentMethod: "check", checkNumber: "CHK-4181", cardLast4: null },
      })));
    }
    if (path === "/billing/lab-4181/eligible-statement-accounts") return fulfill(route, [
      account(ALPHA, "Alpha Dental", "100.00"), account(BETA, "Beta Dental", "200.00"),
    ]);
    if (/^\/billing\/lab-4181\/accounts\/(customer-alpha|customer-beta)\/statements$/.test(path)) {
      const id = path.split("/")[4]; const amount = id === ALPHA ? "100.00" : "200.00";
      return fulfill(route, [{ id: `statement-${id}`, periodStart: "2025-01-01", periodEnd: "2025-01-31", savedBalanceDue: amount, invoiceCount: 1 }]);
    }
    if (path.startsWith("/billing/statements/")) {
      const id = path.split("/").pop()!; const customer = id.endsWith(ALPHA) ? ALPHA : BETA;
      return fulfill(route, { id, periodStart: "2025-01-01", periodEnd: "2025-01-31", savedBalanceDue: customer === ALPHA ? "100.00" : "200.00", invoiceCount: 1,
        invoices: [{ id: `invoice-${customer}`, invoiceNumber: `INV-${customer.slice(-1)}`, currentBalanceDue: customer === ALPHA ? "100.00" : "200.00", eligibleForPayment: true }] });
    }
    if (path.includes("/customer-credits")) {
      return fulfill(route, path.includes(BETA)
        ? { totalAvailable: "20.00", credits: [{ id: "available-credit-beta", amount: "20.00" }] }
        : { totalAvailable: "0", credits: [] });
    }
    if (path.startsWith("/provider/lab-card")) return fulfill(route, { card: null });
    if (path.endsWith("/payment-receipt-template")) return fulfill(route, { emailSubject: "Receipt", emailBody: "Thanks" });
    if (path === "/billing/payment-sessions" && method === "POST") {
      const body = req.postDataJSON() as {
        providerOrganizationId: string;
        receivedAmount: number;
        applications: Array<{ creditAmount: number }>;
      };
      const creditAmount = body.applications.reduce((sum, application) => sum + application.creditAmount, 0);
      paymentPosts.push({ customer: body.providerOrganizationId, receivedAmount: body.receivedAmount, creditAmount });
      const id = `payment-${body.providerOrganizationId === ALPHA ? "alpha" : "beta"}`;
      const payment = { id, amount: Number(body.receivedAmount).toFixed(2), receipt: `R-${id}` };
      payments.set(body.providerOrganizationId, payment);
      return fulfill(route, { id, receiptNumber: payment.receipt, customerEmail: `${body.providerOrganizationId}@example.test`,
        receivedAmount: payment.amount, appliedAmount: payment.amount, customerCreditAmount: creditAmount.toFixed(2), accountBalanceAfter: "0", status: "succeeded" });
    }
    if (path.startsWith("/billing/payment-sessions/") && path.endsWith("/send-receipt")) {
      sendReceiptCalls.push(path); return fulfill(route, { delivered: true });
    }
    if (path.startsWith("/billing/payment-sessions/")) {
      const id = path.split("/").pop()!; return fulfill(route, { id, status: "succeeded" });
    }
    if (path.includes("/statement-charges")) {
      const customer = path.includes(ALPHA) ? ALPHA : BETA;
      const payment = payments.get(customer);
      const amount = customer === ALPHA ? "100.00" : "200.00";
      const monetaryPayment = customer === ALPHA ? "100.00" : "180.00";
      const appliedCredit = customer === ALPHA ? null : "20.00";
      return fulfill(route, [
        { id: `charge-${customer}`, date: "2025-01-01", type: "Charge", invoiceNumber: `INV-${customer.slice(-1)}`, invoiceAmount: amount, paymentAmount: null, openBalance: amount },
        ...(payment ? [
          { id: payment.id, date: "2025-02-10", type: "Payment", invoiceNumber: `INV-${customer.slice(-1)}`, invoiceAmount: null, paymentAmount: monetaryPayment, openBalance: appliedCredit ?? "0.00" },
          ...(appliedCredit ? [{ id: `credit-${customer}`, date: "2025-02-10", type: "Credit", invoiceNumber: `INV-${customer.slice(-1)}`, invoiceAmount: null, paymentAmount: appliedCredit, openBalance: "0.00" }] : []),
        ] : []),
      ]);
    }
    return fulfill(route, {});
  });

  await page.addInitScript(() => localStorage.setItem("labtrax_desktop_tokens_v1", JSON.stringify({ accessToken: "e2e-4181-token", refreshToken: "" })));
  await page.goto(`${BASE_URL}/desktop/finance/receive-payments`);
  await expect(page.getByRole("heading", { name: "Financial" })).toBeVisible();
  const picker = page.getByRole("button", { name: "Received from practices" }).first();
  await picker.click();
  await page.getByRole("menuitemcheckbox", { name: "Alpha Dental" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Beta Dental" }).click();
  await page.getByRole("button", { name: "Complete" }).click();
  await page.getByTestId("receive-continue").click();

  for (const [name, check, received, credit] of [
    ["Alpha Dental", "CHK-A", "100", null],
    ["Beta Dental", "CHK-B", "180", "20"],
  ] as const) {
    await expect(page.getByTestId("receive-practice-progress")).toContainText(name);
    await page.getByLabel("Total amount received").fill(received);
    await page.getByLabel("Reference number").fill(check);
    if (credit) await page.getByLabel("Credit for invoice INV-a").fill(credit);
    await page.getByRole("button", { name: "Save payment" }).click();
    await expect(page.getByRole("dialog", { name: "Email payment receipt" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Skip" }).click();
  }
  expect(paymentPosts).toEqual([
    { customer: ALPHA, receivedAmount: 100, creditAmount: 0 },
    { customer: BETA, receivedAmount: 180, creditAmount: 20 },
  ]);
  expect(sendReceiptCalls).toEqual([]);
  await expect(page).toHaveURL(/\/finance\/make-deposits$/);
  await expect(page.getByRole("heading", { name: "Make Deposits" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Select payment/ })).toHaveCount(2);
  expect(makeDepositsLoads).toBeGreaterThan(0);

  await page.goto(`${BASE_URL}/desktop/accounts`);
  await expect(page.getByRole("heading", { name: "Customer Center" })).toBeVisible();
  for (const [customer, expectedRows, paymentAmount] of [
    ["Alpha Dental", 2, "$100.00"],
    ["Beta Dental", 3, "$180.00"],
  ] as const) {
    await page.getByText(customer, { exact: true }).first().click();
    await page.getByRole("button", { name: "Customer statement charges" }).click();
    await expect(page.getByText("Payment", { exact: true })).toBeVisible();
    if (customer === "Beta Dental") await expect(page.getByText("Credit", { exact: true })).toBeVisible();
    const rows = page.getByRole("heading", { name: "Customer statement charges" }).locator("..").locator("..").locator("tbody tr");
    await expect(rows).toHaveCount(expectedRows);
    await expect(rows.nth(1)).toContainText(paymentAmount);
    await expect(rows.last()).toContainText("$0.00");
    await page.getByRole("button", { name: "Close" }).click();
  }
  expect(requests.filter((r) => r.includes("/statement-charges")).length).toBe(2);
});