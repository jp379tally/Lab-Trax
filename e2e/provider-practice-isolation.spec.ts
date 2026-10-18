import { test, expect, type Page, type Route } from "@playwright/test";

const BASE_URL = process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:80";
const TOKEN = "e2e-provider-token";
const A = "provider-practice-a";
const B = "provider-practice-b";
const C = "provider-practice-c";
type SelectionMode = "normal" | "fail-next" | "hold-next";

const cases = {
  [A]: [{
    id: "case-a", caseNumber: "A-100", patientFirstName: "Alice", patientLastName: "Alpha",
    status: "active", labOrganizationId: "lab-a", labName: "Lab A", restorationTypes: "Crown",
  }],
  [B]: [{
    id: "case-b", caseNumber: "B-200", patientFirstName: "Bob", patientLastName: "Beta",
    status: "active", labOrganizationId: "lab-b", labName: "Lab B", restorationTypes: "Bridge",
  }],
  [C]: [],
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installFixtures(page: Page) {
  let selected = A;
  let practiceACaseRequests = 0;
  let practiceAUnreadRequests = 0;
  let releaseOldCases: (() => void) | null = null;
  let releaseOldUnread: (() => void) | null = null;
  let oldCasesHeld: Promise<void> | null = null;
  let oldUnreadHeld: Promise<void> | null = null;
  let holdOldScopedResponses = false;
  const selectionModes: SelectionMode[] = [];
  let releaseHeldSelection: (() => void) | null = null;
  let heldSelectionStarted: Promise<void> | null = null;
  const mediaHeaders: Array<{ id: string; organization: string | undefined }> = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method();
    const organization = request.headers()["x-provider-organization-id"];
    const scopedOrganization = organization ?? selected;

    if (path === "/auth/me") {
      return json(route, {
        success: true,
        user: { id: "provider-user", username: "provider", firstName: "Pat", lastName: "Provider",
          email: "pat@example.test", userType: "provider", role: "provider",
          practiceName: "Shared Provider", practiceAccountNumber: "P-001" },
        memberships: [],
      });
    }
    if (path === "/provider/organizations") {
      return json(route, [
        { id: A, name: "Practice Alpha" },
        { id: B, name: "Practice Beta" },
        { id: C, name: "Practice Gamma" },
      ]);
    }
    if (path === "/provider/selection" && method === "POST") {
      const body = request.postDataJSON() as { providerOrganizationId?: string };
      const selectionMode = selectionModes.shift() ?? "normal";
      if (selectionMode === "fail-next") {
        return json(route, { error: "Practice switch rejected" }, 409);
      }
      if (selectionMode === "hold-next") {
        heldSelectionStarted = new Promise<void>((resolve) => {
          releaseHeldSelection = resolve;
        });
        await heldSelectionStarted;
      }
      selected = body.providerOrganizationId ?? selected;
      return json(route, { ok: true });
    }
    if (path === "/billing/subscription") {
      return json(route, { ok: true, entitlement: { status: "active", planType: "provider" } });
    }
    if (path === "/cases/provider") {
      if (scopedOrganization === A) practiceACaseRequests += 1;
      if (holdOldScopedResponses && scopedOrganization === A && practiceACaseRequests > 1 && !oldCasesHeld) {
        oldCasesHeld = new Promise<void>((resolve) => { releaseOldCases = resolve; });
        await oldCasesHeld;
        return json(route, cases[A]);
      }
      return json(route, cases[scopedOrganization]);
    }
    if (path === "/provider-messenger/unread-count") {
      if (scopedOrganization === A) practiceAUnreadRequests += 1;
      if (holdOldScopedResponses && scopedOrganization === A && practiceAUnreadRequests > 1 && !oldUnreadHeld) {
        oldUnreadHeld = new Promise<void>((resolve) => { releaseOldUnread = resolve; });
        await oldUnreadHeld;
        return json(route, { total: 99 });
      }
      return json(route, { total: scopedOrganization === A ? 2 : 7 });
    }
    if (path === "/provider/stats") {
      return json(route, scopedOrganization === A
        ? { totalCases: 11, remakeCount: 1, remakePct: 9, reasonCounts: [{ reason: "Shade", count: 1 }] }
        : { totalCases: 22, remakeCount: 4, remakePct: 18, reasonCounts: [{ reason: "Fit", count: 4 }] });
    }
    if (path === "/provider/statements") {
      return json(route, [{
        id: `statement-${scopedOrganization}`, labOrganizationId: `lab-${scopedOrganization.slice(-1)}`,
        providerOrganizationId: scopedOrganization, labName: scopedOrganization === A ? "Lab A" : "Lab B",
        statementDate: "2025-01-01", invoiceCount: 1, totalAmount: scopedOrganization === A ? "101.00" : "202.00",
        balanceDue: scopedOrganization === A ? "101.00" : "202.00", invoiceIds: [],
      }]);
    }
    if (path.includes("/billing/") && path.endsWith("/balance")) {
      return json(route, { currentBalance: scopedOrganization === A ? "101.00" : "202.00", openInvoiceCount: 1 });
    }
    if (path === "/provider/payment-history") return json(route, []);
    if (path === "/provider/invoice-autopay") return json(route, { labs: [] });
    if (path === "/provider/payment-method") return json(route, { card: null });
    if (path === "/provider/billing-preferences") {
      return json(route, { subscription: { enabled: false, chargeDay: 1 }, labs: [{
        providerOrganizationId: scopedOrganization, labOrganizationId: `lab-${scopedOrganization.slice(-1)}`,
        labName: scopedOrganization === A ? "Lab A" : "Lab B", providerName: scopedOrganization === A ? "Practice Alpha" : "Practice Beta",
        enabled: false, chargeDay: 1,
      }] });
    }
    if (path === "/organizations/shared-accounts") {
      return json(route, { contact: { name: scopedOrganization === A ? "Alpha Contact" : "Beta Contact",
        displayName: scopedOrganization === A ? "Alpha Dental" : "Beta Dental", billingEmail: `${scopedOrganization}@example.test`,
        phone: "555-0100", addressLine1: scopedOrganization === A ? "1 Alpha Way" : "2 Beta Way",
        addressLine2: null, city: "Testville", state: "TS", zip: "00001" }, card: null, profileChangeRequests: [] });
    }
    if (path === "/provider-messenger/thread") {
      return json(route, { id: `thread-${scopedOrganization}`, providerOrganizationId: scopedOrganization,
        labOrganizationId: `lab-${scopedOrganization.slice(-1)}`, lastMessageAt: null });
    }
    if (/\/provider-messenger\/thread\/[^/]+\/messages/.test(path)) {
      const isAlpha = path.includes(`thread-${A}`);
      return json(route, [{
        id: isAlpha ? "message-a" : "message-b",
        threadId: isAlpha ? `thread-${A}` : `thread-${B}`,
        senderUserId: "lab-user",
        body: isAlpha ? "Alpha-only message" : "Beta-only message",
        createdAt: "2025-01-01T00:00:00Z",
      }]);
    }
    if (/\/provider-messenger\/thread\/[^/]+\/read-watermark/.test(path)) {
      return json(route, { lastReadMessageId: null, lastReadMessageCreatedAt: null });
    }
    if (path.startsWith("/cases/provider/")) {
      const id = path.split("/")[3];
      return json(route, { id, caseNumber: id === "case-a" ? "A-100" : "B-200",
        patientFirstName: id === "case-a" ? "Alice" : "Bob", patientLastName: id === "case-a" ? "Alpha" : "Beta",
        caseType: "General", timeline: [{ type: "photo", id: `photo-${id}`, label: "Photo",
          timestamp: "2025-01-01T00:00:00Z", attachmentId: `media-${id}` }] });
    }
    if (path.includes("/attachments/") && path.endsWith("/file")) {
      const id = path.split("/").at(-2) ?? "";
      mediaHeaders.push({ id, organization });
      if (id === "media-case-a" && scopedOrganization === B) return json(route, { error: "forbidden" }, 403);
      return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from([137, 80, 78, 71]) });
    }
    return json(route, {});
  });

  await page.addInitScript((token) => {
    localStorage.setItem("labtrax_desktop_tokens_v1", JSON.stringify({ accessToken: token, refreshToken: "" }));
  }, TOKEN);
  return {
    releaseOldResponses: () => { releaseOldCases?.(); releaseOldUnread?.(); },
    holdNextScopedResponses: () => { holdOldScopedResponses = true; },
    failNextSelection: () => { selectionModes.push("fail-next"); },
    holdNextSelection: () => { selectionModes.push("hold-next"); },
    releaseHeldSelection: () => { releaseHeldSelection?.(); },
    mediaHeaders,
    get oldCasesHeld() { return oldCasesHeld; },
    get oldUnreadHeld() { return oldUnreadHeld; },
    get heldSelectionStarted() { return heldSelectionStarted; },
    get selectedPractice() { return selected; },
  };
}

async function expectPracticeSurfaces(
  page: Page,
  practice: typeof A | typeof B,
  fixtures: Awaited<ReturnType<typeof installFixtures>>,
) {
  const isAlpha = practice === A;
  const current = isAlpha
    ? { caseNumber: "A-100", otherCase: "B-200", unread: 2, otherUnread: 7, contact: "Alpha Contact", otherContact: "Beta Contact", lab: "Lab A", otherLab: "Lab B", message: "Alpha-only message", otherMessage: "Beta-only message", balance: "$101.00", otherBalance: "$202.00", stat: "11", otherStat: "22", caseId: "case-a" }
    : { caseNumber: "B-200", otherCase: "A-100", unread: 7, otherUnread: 2, contact: "Beta Contact", otherContact: "Alpha Contact", lab: "Lab B", otherLab: "Lab A", message: "Beta-only message", otherMessage: "Alpha-only message", balance: "$202.00", otherBalance: "$101.00", stat: "22", otherStat: "11", caseId: "case-b" };

  await page.getByRole("button", { name: "Dashboard" }).click();
  await expect(page.getByText(current.caseNumber)).toBeVisible();
  await expect(page.getByText(current.otherCase)).not.toBeVisible();
  await expect(page.getByLabel(`${current.unread} unread messages`)).toBeVisible();
  await expect(page.getByLabel(`${current.otherUnread} unread messages`)).not.toBeVisible();
  await page.getByRole("button", { name: "My Account" }).click();
  await expect(page.getByRole("textbox", { name: `Legal practice name for ${current.lab}` })).toHaveValue(current.contact);
  await expect(page.getByText(current.otherContact)).not.toBeVisible();
  await page.getByRole("button", { name: "View and Pay My Bill" }).click();
  await expect(page.getByText(current.balance, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(current.otherBalance, { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Message My Lab" }).click();
  await expect(page.getByText(current.lab)).toBeVisible();
  await expect(page.getByText(current.otherLab)).not.toBeVisible();
  await expect(page.getByText(current.message)).toBeVisible();
  await expect(page.getByText(current.otherMessage)).not.toBeVisible();
  await page.getByRole("button", { name: "Stats" }).click();
  await expect(page.getByText(current.stat)).toBeVisible();
  await expect(page.getByText(current.otherStat)).not.toBeVisible();
  await page.getByRole("button", { name: "Dashboard" }).click();
  await page.getByText(current.caseNumber).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTitle("Photo").click();
  await expect.poll(() => fixtures.mediaHeaders.some((header) => header.id === `media-${current.caseId}`)).toBe(true);
  expect(fixtures.mediaHeaders.findLast((header) => header.id === `media-${current.caseId}`)?.organization).toBe(practice);
  await page.keyboard.press("Escape");
}

test("provider practice switching isolates every portal surface", async ({ page }) => {
  const fixtures = await installFixtures(page);
  await page.goto(`${BASE_URL}/desktop/`);
  const practicePicker = page.getByRole("combobox", { name: "Active practice" });
  await expect(practicePicker).toHaveValue("");
  await practicePicker.selectOption(A);
  await expect(page.getByText("A-100")).toBeVisible();
  await expect(page.getByLabel("2 unread messages")).toBeVisible();

  await page.getByRole("button", { name: "My Account" }).click();
  await expect(page.getByRole("textbox", { name: "Legal practice name for Lab A" })).toHaveValue("Alpha Contact");
  await page.getByRole("button", { name: "View and Pay My Bill" }).click();
  await expect(page.getByText("$101.00", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Message My Lab" }).click();
  await expect(page.getByText("Lab A")).toBeVisible();
  await expect(page.getByText("Alpha-only message")).toBeVisible();
  await page.getByRole("button", { name: "Stats" }).click();
  await expect(page.getByText("11")).toBeVisible();

  fixtures.holdNextScopedResponses();
  await practicePicker.evaluate((element) => {
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(() => fixtures.oldCasesHeld !== null).toBe(true);
  await expect.poll(() => fixtures.oldUnreadHeld !== null).toBe(true);
  await practicePicker.selectOption(B);
  await expect(practicePicker).toHaveValue(B);
  await fixtures.releaseOldResponses();
  await expect(page.getByLabel("7 unread messages")).toBeVisible();
  await expect(page.getByLabel("99 unread messages")).not.toBeVisible();
  await page.getByRole("button", { name: "Dashboard" }).click();
  await expect(page.getByText("B-200")).toBeVisible();
  await expect(page.getByText("A-100")).not.toBeVisible();

  await page.getByRole("button", { name: "My Account" }).click();
  await expect(page.getByRole("textbox", { name: "Legal practice name for Lab B" })).toHaveValue("Beta Contact");
  await expect(page.getByRole("textbox", { name: "Legal practice name for Lab A" })).not.toBeVisible();
  await page.getByRole("button", { name: "View and Pay My Bill" }).click();
  await expect(page.getByText("$202.00", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("$101.00", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Message My Lab" }).click();
  await expect(page.getByText("Lab B")).toBeVisible();
  await expect(page.getByText("Lab A")).not.toBeVisible();
  await expect(page.getByText("Beta-only message")).toBeVisible();
  await expect(page.getByText("Alpha-only message")).not.toBeVisible();
  await page.getByRole("button", { name: "Stats" }).click();
  await expect(page.getByText("22")).toBeVisible();
  await expect(page.getByText("11")).not.toBeVisible();

  await page.getByRole("button", { name: "Dashboard" }).click();
  await page.getByText("B-200").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTitle("Photo").click();
  await expect.poll(() => fixtures.mediaHeaders.some((h) => h.id === "media-case-b")).toBe(true);
  expect(fixtures.mediaHeaders.find((h) => h.id === "media-case-b")?.organization).toBe(B);

  const denied = await page.evaluate(async () => {
    const response = await fetch("/api/cases/case-a/attachments/media-case-a/file", {
      headers: { "x-provider-organization-id": "provider-practice-b" },
    });
    return response.status;
  });
  expect(denied).toBe(403);
  expect(fixtures.mediaHeaders.find((h) => h.id === "media-case-a")?.organization).toBe(B);
});

test("a rejected practice switch restores the previous practice without mixed data", async ({ page }) => {
  const fixtures = await installFixtures(page);
  await page.goto(`${BASE_URL}/desktop/`);
  const practicePicker = page.getByRole("combobox", { name: "Active practice" });
  await practicePicker.selectOption(A);
  await expect(page.getByText("A-100")).toBeVisible();

  fixtures.failNextSelection();
  await practicePicker.selectOption(B);
  await expect(page.getByText("Practice switch rejected")).toBeVisible();
  await expect(practicePicker).toHaveValue(A);
  await expectPracticeSurfaces(page, A, fixtures);
});

test("rapid overlapping practice selections keep the final practice and its data", async ({ page }) => {
  const fixtures = await installFixtures(page);
  await page.goto(`${BASE_URL}/desktop/`);
  const practicePicker = page.getByRole("combobox", { name: "Active practice" });
  await practicePicker.selectOption(A);
  await expect(page.getByText("A-100")).toBeVisible();

  fixtures.holdNextSelection();
  await practicePicker.selectOption(B);
  await expect.poll(() => fixtures.heldSelectionStarted !== null).toBe(true);
  await practicePicker.selectOption(A);
  fixtures.releaseHeldSelection();
  await expect(practicePicker).toHaveValue(A);
  await expect.poll(() => fixtures.selectedPractice).toBe(A);
  await expectPracticeSurfaces(page, A, fixtures);
});

test("a failed final selection cannot be replaced by an older late success", async ({ page }) => {
  const fixtures = await installFixtures(page);
  await page.goto(`${BASE_URL}/desktop/`);
  const practicePicker = page.getByRole("combobox", { name: "Active practice" });
  await practicePicker.selectOption(A);
  await expect(page.getByText("A-100")).toBeVisible();

  fixtures.holdNextSelection();
  await practicePicker.selectOption(B);
  await expect.poll(() => fixtures.heldSelectionStarted !== null).toBe(true);
  fixtures.failNextSelection();
  await practicePicker.selectOption(C);
  fixtures.releaseHeldSelection();
  await expect(page.getByText("Practice switch rejected")).toBeVisible();
  await expect.poll(() => fixtures.selectedPractice).toBe(A);
  await expect(practicePicker).toHaveValue(A);
  await expectPracticeSurfaces(page, A, fixtures);
});

test("a delayed rollback converges to a newer practice choice", async ({ page }) => {
  const fixtures = await installFixtures(page);
  await page.goto(`${BASE_URL}/desktop/`);
  const practicePicker = page.getByRole("combobox", { name: "Active practice" });
  await practicePicker.selectOption(A);
  await expect(page.getByText("A-100")).toBeVisible();

  fixtures.failNextSelection();
  fixtures.holdNextSelection();
  await practicePicker.selectOption(C);
  await expect.poll(() => fixtures.heldSelectionStarted !== null).toBe(true);
  await practicePicker.selectOption(B);
  fixtures.releaseHeldSelection();

  await expect.poll(() => fixtures.selectedPractice).toBe(B);
  await expect(practicePicker).toHaveValue(B);
  await expectPracticeSurfaces(page, B, fixtures);
});

test("a failed rollback leaves practice data hidden and surfaces the error", async ({ page }) => {
  const fixtures = await installFixtures(page);
  await page.goto(`${BASE_URL}/desktop/`);
  const practicePicker = page.getByRole("combobox", { name: "Active practice" });
  await practicePicker.selectOption(A);
  await expect(page.getByText("A-100")).toBeVisible();

  fixtures.failNextSelection();
  fixtures.failNextSelection();
  await practicePicker.selectOption(C);

  await expect(page.getByText(/Could not restore the previous practice/)).toBeVisible();
  await expect(practicePicker).toHaveValue("");
  await expect(page.getByText("A-100")).not.toBeVisible();
  await expect(page.getByText("B-200")).not.toBeVisible();
});