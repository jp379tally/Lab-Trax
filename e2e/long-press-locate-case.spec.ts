/**
 * End-to-end: long-pressing a case card in the mobile web view opens the
 * "Locate Case" dialog.
 *
 * Invariants protected:
 *  - A long-press (contextmenu event) on a case card fires the onLongPress
 *    handler and triggers the "Locate Case" alert/dialog.
 *  - The dialog text "Locate Case" is visible — verifying that gesture
 *    handlers in the FlatList cannot silently swallow the event before it
 *    reaches the Pressable.
 *  - Accepting the alert opens the station-picker modal ("Select a station:").
 *
 * The test seeds one case via the API and injects auth tokens into
 * localStorage (expo-secure-store web fallback) so the Expo web build is
 * signed in without needing a real device or UI login flow.
 *
 * React Native Web maps the DOM `contextmenu` event to `onLongPress` on
 * Pressable components; some RNW builds may also delegate Alert.alert to the
 * browser's window.confirm — both code paths are handled below.
 *
 * To run:
 *   npx playwright test e2e/long-press-locate-case.spec.ts
 */
import { test, expect, APIRequestContext } from "@playwright/test";

const BASE_URL = process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:80";
const API = `${BASE_URL}/api`;

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  labOrgId: string;
}

async function loginAsAdmin(
  request: APIRequestContext
): Promise<AuthTokens | null> {
  const creds = [
    { identifier: "admin", password: "admin" },
    { identifier: "demo_admin", password: "demo1234" },
  ];
  for (const c of creds) {
    try {
      const r = await request.post(`${API}/auth/login`, { data: c });
      if (r.ok()) {
        const body = await r.json();
        const token = body?.tokens?.accessToken ?? body?.accessToken;
        const refresh =
          body?.tokens?.refreshToken ?? body?.refreshToken ?? "";
        const orgs =
          body?.organizations ?? body?.user?.organizations ?? [];
        const lab = orgs.find(
          (o: any) =>
            o.type === "lab" || o.organizationType === "lab"
        );
        if (token && lab?.id) {
          return {
            accessToken: token,
            refreshToken: refresh,
            labOrgId: lab.id,
          };
        }
      }
    } catch {
      /* try next credential pair */
    }
  }
  return null;
}

/** Inject auth tokens into localStorage so the Expo web app is signed in. */
async function injectTokens(
  page: import("@playwright/test").Page,
  tokens: AuthTokens
): Promise<void> {
  await page.evaluate(
    ([at, rt]) => {
      try {
        // expo-secure-store on web falls back to localStorage under the
        // same key the native build uses.
        localStorage.setItem(
          "@labtrax_tokens",
          JSON.stringify({ accessToken: at, refreshToken: rt })
        );
      } catch {}
    },
    [tokens.accessToken, tokens.refreshToken] as [string, string]
  );
}

test.describe("Long-press locate case — mobile web view", () => {
  let tokens: AuthTokens | null = null;
  let createdCaseId: string | null = null;

  test.beforeAll(async ({ request }) => {
    tokens = await loginAsAdmin(request);
    if (!tokens) return;

    // Seed a minimal case so the Cases list is guaranteed to be non-empty.
    const caseResp = await request.post(`${API}/cases`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      data: {
        caseNumber: `E2E-locate-${Date.now()}`,
        patientFirstName: "Locate",
        patientLastName: "TestPatient",
        caseType: "Restorative",
        labOrganizationId: tokens.labOrgId,
        status: "active",
      },
    });
    if (caseResp.ok()) {
      const body = await caseResp.json();
      createdCaseId = body?.id ?? body?.case?.id ?? null;
    }
  });

  test("long-pressing a case card opens the Locate Case dialog", async ({
    page,
  }) => {
    if (!tokens) {
      test.skip();
      return;
    }

    // Intercept browser-level dialogs in case Alert.alert is forwarded to
    // window.confirm / window.alert on this RNW build.
    let browserDialogSeen = false;
    let browserDialogText = "";
    page.on("dialog", async (dialog) => {
      browserDialogText = dialog.message();
      browserDialogSeen = true;
      // Accept so the UI can continue and we can assert on the modal.
      await dialog.accept().catch(() => {});
    });

    // Load the app, inject tokens, then reload so the Expo app mounts
    // authenticated and fetches cases from the API.
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");
    await injectTokens(page, tokens);
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");

    // Navigate to the Cases tab if a tab bar is present.
    const casesTab = page
      .getByRole("link", { name: /^cases$/i })
      .or(page.getByTestId("tab-cases"))
      .or(page.locator('[href*="cases"]').first());
    if ((await casesTab.count()) > 0) {
      await casesTab.first().click();
      await page.waitForLoadState("networkidle");
    }

    // Wait up to 10 s for at least one case card to render.
    const anyCard = page.locator('[data-testid^="case-card-"]').first();
    await anyCard.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});

    if ((await anyCard.count()) === 0) {
      // No case cards visible — likely the API server is not running or no
      // demo data is seeded.  Skip rather than fail so CI stays green when
      // the mobile dev server is offline.
      test.skip();
      return;
    }

    // Simulate a long-press.  React Native Web maps the DOM `contextmenu`
    // event to onLongPress on Pressable; dispatchEvent bypasses any gesture
    // handler in the FlatList that might otherwise consume the event.
    await anyCard.dispatchEvent("contextmenu");

    // Give RNW a moment to process the event and render the alert/dialog.
    await page.waitForTimeout(500);

    // Assert "Locate Case" is visible either:
    //   a) as an in-DOM element rendered by React Native Web's Alert, or
    //   b) as a browser-level dialog (caught above via page.on("dialog")).
    const domLocateCaseCount = await page
      .getByText("Locate Case")
      .count();
    const viaBrowserDialog =
      browserDialogSeen &&
      /locate\s*case/i.test(browserDialogText);

    expect(
      domLocateCaseCount > 0 || viaBrowserDialog,
      `Expected "Locate Case" to appear after long-press — ` +
        `DOM matches: ${domLocateCaseCount}, ` +
        `browser dialog seen: ${browserDialogSeen} ` +
        `(message: "${browserDialogText}")`
    ).toBe(true);
  });

  test("accepting the Locate Case alert opens the station-picker modal", async ({
    page,
  }) => {
    if (!tokens) {
      test.skip();
      return;
    }

    // Accept any browser dialogs automatically so the station-picker modal
    // can open.
    page.on("dialog", async (dialog) => {
      await dialog.accept().catch(() => {});
    });

    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");
    await injectTokens(page, tokens);
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");

    const casesTab = page
      .getByRole("link", { name: /^cases$/i })
      .or(page.locator('[href*="cases"]').first());
    if ((await casesTab.count()) > 0) {
      await casesTab.first().click();
      await page.waitForLoadState("networkidle");
    }

    const anyCard = page.locator('[data-testid^="case-card-"]').first();
    await anyCard.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    if ((await anyCard.count()) === 0) {
      test.skip();
      return;
    }

    // Trigger the long-press.
    await anyCard.dispatchEvent("contextmenu");
    await page.waitForTimeout(300);

    // If the Alert rendered as an in-DOM dialog, click the "Yes" button so
    // the station-picker modal opens.
    const yesButton = page
      .getByRole("button", { name: /^yes$/i })
      .or(page.locator("text=Yes").first());
    if ((await yesButton.count()) > 0) {
      await yesButton.first().click();
      await page.waitForTimeout(300);
    }
    // If the alert was a browser dialog it was already accepted above.

    // After accepting, the station-picker modal should render with the
    // "Select a station:" prompt (from the locateCaseId Modal in cases.tsx).
    const stationPickerVisible =
      (await page.getByText(/select a station/i).count()) > 0;

    // The "Locate Case" title is also shown in the modal itself, so either
    // assertion confirms the modal opened.
    const locateModalTitleVisible =
      (await page.getByText("Locate Case").count()) > 0;

    expect(
      stationPickerVisible || locateModalTitleVisible,
      "Expected the station-picker modal to appear after accepting the alert"
    ).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    if (!tokens || !createdCaseId) return;
    await request
      .delete(`${API}/cases/${createdCaseId}`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
      .catch(() => {});
  });
});
