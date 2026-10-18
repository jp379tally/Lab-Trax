import { expect, test, type Route } from "@playwright/test";

const LAB = "lab-4189";
const BANK = "bank-4189";
const OTHER_BANK = "bank-other";
const BASE_URL = process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:80";

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

test("4189 moves selected payments into the destination bank register", async ({ page }) => {
  const transactionIds = ["uf-payment-alpha", "uf-payment-beta"];
  let deposited = false;
  let depositRequest:
    | {
        organizationId: string;
        bankAccountId: string;
        depositDate: string;
        transactionIds: string[];
      }
    | undefined;
  const registerRequests: URL[] = [];

  const invoices = [
    {
      id: "invoice-alpha",
      invoiceNumber: "INV-ALPHA",
      labOrganizationId: LAB,
      providerOrganizationId: "customer-alpha",
      status: "paid",
      balanceDue: "100.00",
      total: "100.00",
    },
    {
      id: "invoice-beta",
      invoiceNumber: "INV-BETA",
      labOrganizationId: LAB,
      providerOrganizationId: "customer-beta",
      status: "paid",
      balanceDue: "180.00",
      total: "180.00",
    },
  ];

  const undepositedRows = [
    {
      id: transactionIds[0],
      txnDate: "2025-02-10",
      payee: "Alpha Dental",
      memo: null,
      creditAmount: "100.00",
      staleDays: 1,
      ageWarning: false,
      statementDate: "2025-01-31",
      invoiceLinks: [{ invoiceId: "invoice-alpha", invoiceNumber: "INV-ALPHA" }],
      paymentSession: {
        id: "payment-alpha",
        receiptNumber: "R-ALPHA",
        statementId: "statement-alpha",
        receivedAmount: "100.00",
        appliedAmount: "100.00",
        customerCreditAmount: "0.00",
        customerCreditRemaining: "0.00",
        paymentMethod: "check",
        checkNumber: "CHK-A",
        cardLast4: null,
      },
    },
    {
      id: transactionIds[1],
      txnDate: "2025-02-10",
      payee: "Beta Dental",
      memo: null,
      creditAmount: "180.00",
      staleDays: 1,
      ageWarning: false,
      statementDate: "2025-01-31",
      invoiceLinks: [{ invoiceId: "invoice-beta", invoiceNumber: "INV-BETA" }],
      paymentSession: {
        id: "payment-beta",
        receiptNumber: "R-BETA",
        statementId: "statement-beta",
        receivedAmount: "180.00",
        appliedAmount: "180.00",
        customerCreditAmount: "0.00",
        customerCreditRemaining: "0.00",
        paymentMethod: "check",
        checkNumber: "CHK-B",
        cardLast4: null,
      },
    },
  ];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method();

    if (path === "/auth/me") {
      return fulfill(route, {
        success: true,
        user: {
          id: "user-4189",
          username: "admin",
          firstName: "Test",
          lastName: "Admin",
          email: "admin@example.test",
          userType: "lab",
          role: "owner",
        },
        memberships: [
          {
            organizationId: LAB,
            role: "owner",
            status: "active",
            organization: { id: LAB, type: "lab" },
          },
        ],
      });
    }
    if (path === "/billing/subscription") {
      return fulfill(route, {
        ok: true,
        entitlement: { status: "active", accessLevel: "full", planType: "lab" },
      });
    }
    if (path === "/organizations" || path === "/organizations/") {
      return fulfill(route, [
        {
          id: LAB,
          name: "Lab 4189",
          displayName: "Lab 4189",
          type: "lab",
          billingEmail: "lab@example.test",
        },
      ]);
    }
    if (path === "/organizations/connections") return fulfill(route, []);
    if (path === "/organizations/shared-accounts") {
      return fulfill(route, { contact: null, card: null, profileChangeRequests: [] });
    }
    if (path === "/finance/accounts") {
      return fulfill(route, [
        {
          id: OTHER_BANK,
          name: "Savings",
          accountType: "bank",
          isArchived: false,
          last4: "0001",
          currentBalance: "50.00",
        },
        {
          id: BANK,
          name: "Operating Checking",
          accountType: "bank",
          isArchived: false,
          last4: "4189",
          currentBalance: deposited ? "280.00" : "0.00",
        },
      ]);
    }
    if (path === "/finance/undeposited-funds" && method === "GET") {
      if (url.searchParams.get("summary")) {
        return fulfill(route, deposited ? { count: 0, total: 0 } : { count: 2, total: 280 });
      }
      return fulfill(route, deposited ? [] : undepositedRows);
    }
    if (path === "/finance/make-deposits" && method === "POST") {
      depositRequest = request.postDataJSON();
      deposited = true;
      return fulfill(route, { moved: 2, totalAmount: 280 });
    }
    if (path === "/finance/transactions" && method === "GET") {
      registerRequests.push(url);
      const requestedBank = url.searchParams.get("bankAccountId");
      return fulfill(
        route,
        deposited && requestedBank === BANK
          ? [
              {
                id: "deposit-4189",
                labOrganizationId: LAB,
                bankAccountId: BANK,
                txnDate: depositRequest?.depositDate ?? "2025-02-10T00:00:00.000Z",
                type: "deposit",
                checkNumber: null,
                payee: "Undeposited Funds",
                memo: "Payments R-ALPHA, R-BETA",
                categoryId: null,
                debitAmount: "0.00",
                creditAmount: "280.00",
                netAmount: "280.00",
                cleared: false,
                reconciled: false,
                status: "posted",
                source: "deposit",
                runningBalance: "280.00",
                invoices: [
                  { invoiceId: "invoice-alpha", invoiceNumber: "INV-ALPHA" },
                  { invoiceId: "invoice-beta", invoiceNumber: "INV-BETA" },
                ],
              },
            ]
          : requestedBank === OTHER_BANK
            ? [
                {
                  id: "other-account-entry",
                  labOrganizationId: LAB,
                  bankAccountId: OTHER_BANK,
                  txnDate: "2025-02-09T00:00:00.000Z",
                  type: "deposit",
                  checkNumber: null,
                  payee: "Savings opening balance",
                  memo: null,
                  categoryId: null,
                  debitAmount: "0.00",
                  creditAmount: "50.00",
                  netAmount: "50.00",
                  cleared: false,
                  reconciled: false,
                  status: "posted",
                  source: "manual",
                  runningBalance: "50.00",
                  invoices: [],
                },
              ]
            : [],
      );
    }
    if (path === "/finance/categories" || path === "/finance/vendors") {
      return fulfill(route, []);
    }
    if (path === "/invoices") return fulfill(route, invoices);
    if (path === "/cases" || path === "/cases/legacy-doctor-directory") {
      return fulfill(route, []);
    }
    return fulfill(route, {});
  });

  await page.addInitScript(() => {
    localStorage.setItem(
      "labtrax_desktop_tokens_v1",
      JSON.stringify({ accessToken: "e2e-4189-token", refreshToken: "" }),
    );
    localStorage.setItem("labtrax_finance_account_v1", "bank-other");
  });

  await page.goto(`${BASE_URL}/desktop/finance/make-deposits`);
  await expect(page.getByRole("heading", { name: "Make Deposits" })).toBeVisible();
  const depositAccount = page.locator("select").nth(2);
  await expect(depositAccount).toHaveValue(OTHER_BANK);
  await depositAccount.selectOption(BANK);
  await page.getByRole("button", { name: "Select all" }).click();
  await expect(page.getByText("2 payments selected — $280.00")).toBeVisible();
  await page.getByRole("button", { name: "Make Deposits" }).click();

  await expect
    .poll(() => depositRequest)
    .toMatchObject({
      organizationId: LAB,
      bankAccountId: BANK,
      transactionIds,
    });
  expect(Number.isNaN(Date.parse(depositRequest!.depositDate))).toBe(false);

  await expect(page).toHaveURL(
    new RegExp(`/desktop/finance/register\\?account=${BANK}$`),
    { timeout: 5_000 },
  );
  const depositedRow = page.getByRole("row").filter({ hasText: "Payments R-ALPHA, R-BETA" });
  await expect(depositedRow).toContainText("$280.00");
  await expect(depositedRow).toContainText("–split–");
  await expect(page.locator("select").nth(1)).toHaveValue(BANK);
  await expect(page.getByText("Savings opening balance")).toHaveCount(0);
  expect(
    registerRequests.at(-1)?.searchParams.get("organizationId") === LAB &&
      registerRequests.at(-1)?.searchParams.get("bankAccountId") === BANK,
  ).toBe(true);

  await page.locator("select").nth(1).selectOption(OTHER_BANK);
  await expect(page.getByText("Savings opening balance")).toBeVisible();
  await expect(depositedRow).toHaveCount(0);
});