import { test, expect, type Frame, type Page } from "@playwright/test";

type Card = {
  number: string;
  expiry: string;
  cvc: string;
};

type Fixture = {
  providerName: string;
  invoiceNumber: string;
  amount: string;
};

type LiveConfig = {
  baseUrl: string;
  accessToken: string;
  labOrganizationId: string;
  cancelCard: Card;
  successCard: Card;
  cancelFixture: Fixture;
  successFixture: Fixture;
};

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function cardFromEnv(prefix: string): Card | undefined {
  const number = env(`${prefix}_NUMBER`);
  const expiry = env(`${prefix}_EXPIRY`);
  const cvc = env(`${prefix}_CVC`);
  return number && expiry && cvc ? { number, expiry, cvc } : undefined;
}

function fixtureFromEnv(prefix: string): Fixture | undefined {
  const providerName = env(`${prefix}_PROVIDER_NAME`);
  const invoiceNumber = env(`${prefix}_INVOICE_NUMBER`);
  const amount = env(`${prefix}_AMOUNT`);
  return providerName && invoiceNumber && amount
    ? { providerName, invoiceNumber, amount }
    : undefined;
}

function readLiveConfig(): LiveConfig | undefined {
  if (process.env["PLAYWRIGHT_STRIPE_LIVE"] !== "1") return undefined;

  const baseUrl = env("PLAYWRIGHT_BASE_URL");
  const accessToken = env("PLAYWRIGHT_STRIPE_ACCESS_TOKEN");
  const testSecretKey = env("PLAYWRIGHT_STRIPE_TEST_SECRET_KEY");
  const labOrganizationId = env("PLAYWRIGHT_STRIPE_LAB_ORGANIZATION_ID");
  const cancelCard = cardFromEnv("PLAYWRIGHT_STRIPE_CANCEL_CARD");
  const successCard = cardFromEnv("PLAYWRIGHT_STRIPE_SUCCESS_CARD");
  const cancelFixture = fixtureFromEnv("PLAYWRIGHT_STRIPE_CANCEL_FIXTURE");
  const successFixture = fixtureFromEnv("PLAYWRIGHT_STRIPE_SUCCESS_FIXTURE");

  // A live Stripe run must target a separately provisioned HTTPS environment.
  // The publishable key is checked again after the page loads because the
  // browser receives it from the API, not from this test process.
  if (
    !baseUrl ||
    !baseUrl.startsWith("https://") ||
    !accessToken ||
    !testSecretKey?.startsWith("sk_test_") ||
    !labOrganizationId ||
    !cancelCard ||
    !successCard ||
    !cancelFixture ||
    !successFixture
  ) {
    return undefined;
  }

  return {
    baseUrl,
    accessToken,
    labOrganizationId,
    cancelCard,
    successCard,
    cancelFixture,
    successFixture,
  };
}

const config = readLiveConfig();
test.use({ screenshot: "off", video: "off", trace: "off" });

function stripeFrames(page: Page): Frame[] {
  return page
    .frames()
    .filter(
      (frame) =>
        frame !== page.mainFrame() &&
        /stripe\.com|stripe\.network/i.test(frame.url()),
    );
}

async function fillStripeField(
  page: Page,
  selectors: string,
  value: string,
): Promise<void> {
  await expect
    .poll(() => stripeFrames(page).length, {
      message: "Stripe hosted fields did not load",
      timeout: 30_000,
    })
    .toBeGreaterThan(0);

  await expect
    .poll(
      async () => {
        for (const frame of stripeFrames(page)) {
          const input = frame.locator(selectors).first();
          if (await input.isVisible().catch(() => false)) {
            await input.fill(value);
            return true;
          }
        }
        return false;
      },
      {
        message: "A Stripe hosted field did not become visible",
        timeout: 30_000,
      },
    )
    .toBe(true);
}

async function fillHostedCard(page: Page, card: Card): Promise<void> {
  await fillStripeField(
    page,
    'input[autocomplete="cc-number"], input[placeholder*="1234"]',
    card.number,
  );
  await fillStripeField(
    page,
    'input[autocomplete="cc-exp"], input[placeholder*="MM"]',
    card.expiry,
  );
  await fillStripeField(
    page,
    'input[autocomplete="cc-csc"], input[placeholder*="CVC"]',
    card.cvc,
  );
}

async function clickStripeChallengeAction(
  page: Page,
  action: RegExp,
): Promise<void> {
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          const button = frame.getByRole("button", { name: action }).first();
          if (await button.isVisible().catch(() => false)) {
            await button.click();
            return true;
          }
        }
        return false;
      },
      {
        message: "Stripe authentication challenge action did not appear",
        timeout: 60_000,
      },
    )
    .toBe(true);
}

async function openDraft(
  page: Page,
  fixture: Fixture,
  config: LiveConfig,
): Promise<void> {
  await page.addInitScript(
    ({ accessToken }) => {
      localStorage.setItem(
        "labtrax_desktop_tokens_v1",
        JSON.stringify({ accessToken, refreshToken: "" }),
      );
    },
    { accessToken: config.accessToken },
  );

  const configResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/billing/payment-sessions/card/config") &&
      response.request().method() === "GET",
  );
  await page.goto("/desktop/finance/receive-payments");
  const stripeConfig = await configResponse;
  expect(stripeConfig.ok()).toBe(true);
  const stripeConfigBody = (await stripeConfig.json()) as {
    ok?: boolean;
    data?: { publishableKey?: unknown };
  };
  expect(stripeConfigBody.ok).toBe(true);
  expect(typeof stripeConfigBody.data?.publishableKey).toBe("string");
  expect(String(stripeConfigBody.data?.publishableKey)).toMatch(/^pk_test_/);

  await expect(page.getByRole("heading", { name: "Financial" })).toBeVisible();
  const picker = page
    .getByRole("button", { name: "Received from practices" })
    .first();
  await expect(picker).toBeEnabled();
  await picker.click();
  await page
    .getByRole("menuitemcheckbox", { name: fixture.providerName })
    .click();
  await page.getByRole("button", { name: "Complete" }).click();
  await page.getByTestId("receive-continue").click();

  await expect(page.getByLabel("Payment method")).toBeVisible();
  await page.getByLabel("Total amount received").fill(fixture.amount);
  await page.getByLabel("Payment method").selectOption("card");
  await page.getByRole("radio", { name: "Use a new card" }).check();
  await page.getByLabel("Cardholder name").fill("Stripe browser test");
  await expect
    .poll(() => stripeFrames(page).length, {
      message: "Stripe hosted payment fields did not load",
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
}

async function readInvoiceBalance(
  page: Page,
  config: LiveConfig,
  fixture: Fixture,
): Promise<string | undefined> {
  return page.evaluate(
    async ({ labOrganizationId, accessToken, providerName, invoiceNumber }) => {
      const response = await fetch(
        `/api/billing/${encodeURIComponent(labOrganizationId)}/eligible-invoice-accounts`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!response.ok)
        throw new Error(
          `Could not read the invoice fixture (${response.status}).`,
        );
      const body = (await response.json()) as {
        ok?: boolean;
        data?: unknown;
      };
      if (!body.ok || !Array.isArray(body.data)) {
        throw new Error(
          "The invoice fixture response was not a valid API response.",
        );
      }
      const accounts = body.data as Array<{
        providerName?: string;
        outstandingInvoices?: Array<{
          invoiceNumber?: string;
          currentBalanceDue?: string;
        }>;
      }>;
      return accounts
        .find((account) => account.providerName === providerName)
        ?.outstandingInvoices?.find(
          (invoice) => invoice.invoiceNumber === invoiceNumber,
        )?.currentBalanceDue;
    },
    {
      labOrganizationId: config.labOrganizationId,
      accessToken: config.accessToken,
      providerName: fixture.providerName,
      invoiceNumber: fixture.invoiceNumber,
    },
  );
}

test.describe("Stripe test-mode Receive Payments flow", () => {
  test.skip(
    !config,
    "Opt-in only: set the approved Stripe test-mode browser configuration to run this spec.",
  );

  test("keeps a cancelled authentication in its draft and does not change accounting", async ({
    page,
  }) => {
    if (!config) return;
    await openDraft(page, config.cancelFixture, config);
    const balanceBefore = await readInvoiceBalance(
      page,
      config,
      config.cancelFixture,
    );
    expect(balanceBefore).toBe(config.cancelFixture.amount);

    await fillHostedCard(page, config.cancelCard);
    await page.getByRole("button", { name: "Save payment" }).click();
    await clickStripeChallengeAction(page, /cancel/i);

    await expect(page).toHaveURL(/\/desktop\/finance\/receive-payments/);
    await expect(page.getByLabel("Total amount received")).toHaveValue(
      config.cancelFixture.amount,
    );
    await expect(page.getByLabel("Payment method")).toHaveValue("card");
    expect(await readInvoiceBalance(page, config, config.cancelFixture)).toBe(
      balanceBefore,
    );
  });

  test("returns from successful authentication and records only the confirmed payment", async ({
    page,
  }) => {
    if (!config) return;
    await openDraft(page, config.successFixture, config);
    const balanceBefore = await readInvoiceBalance(
      page,
      config,
      config.successFixture,
    );
    expect(balanceBefore).toBe(config.successFixture.amount);

    await fillHostedCard(page, config.successCard);
    const confirmResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/billing/payment-sessions/card/confirm") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save payment" }).click();
    await clickStripeChallengeAction(page, /complete|authenticate|authorize/i);
    const confirmed = await confirmResponse;
    expect(confirmed.ok()).toBe(true);

    await expect(
      page.getByRole("dialog", { name: "Email payment receipt" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("Payment recorded");
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Skip" }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Skip" })
      .click();
    await expect(page).toHaveURL(/\/finance\/make-deposits$/);
    expect(await readInvoiceBalance(page, config, config.successFixture)).toBe(
      "0.00",
    );
  });
});
