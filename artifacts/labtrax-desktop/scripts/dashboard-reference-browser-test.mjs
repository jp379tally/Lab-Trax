import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { findChromium } from "./find-chromium.mjs";

// The managed web workflow must be running; never start a duplicate server.
const origin = process.env.DASHBOARD_TEST_ORIGIN || "http://localhost";
const url = process.env.DASHBOARD_TEST_URL || `${origin}/desktop/browser-tests/dashboard-reference.html`;
const variant = process.env.DASHBOARD_TEST_URL ? "packaged-renderer" : "desktop";
const output = new URL("../../../generated-artifacts/dashboard/", import.meta.url).pathname;
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: findChromium(), headless: true,
  args: ["--no-sandbox", "--disable-gpu", ...(url.startsWith("file:") ? ["--allow-file-access-from-files"] : [])],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && message.text().includes("Unmapped dashboard fixture")) {
    errors.push(message.text());
  }
});
try {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url);
    await page.getByTestId("summary-count-past-due").filter({ hasText: "7" }).waitFor();
    assert.equal(await page.getByTestId("summary-count-due-today").textContent(), "4");
    assert.equal(await page.getByTestId("summary-count-unassigned").textContent(), "1");
    // StrictMode can cancel/restart the initial request; interactions must not
    // add a second data owner/request once both consumers have mounted.
    const inboxRequestsBefore = await page.evaluate(() =>
      window.dashboardFixtureRequests.filter((r) => r === "GET /lab-inbox").length);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `page overflow at ${width}px`);
    await page.screenshot({ path: `${output}${variant}-${width}.jpg`, fullPage: true });
    await page.getByRole("button", { name: "Collapse past due", exact: true }).click();
    await page.getByTestId("summary-card-past-due").click();
    await page.getByRole("button", { name: "Collapse past due", exact: true }).waitFor();
    await page.getByRole("button", { name: "Collapse due today", exact: true }).click();
    await page.getByTestId("summary-card-due-today").click();
    await page.getByRole("button", { name: "Collapse due today", exact: true }).waitFor();
    const collapseDocuments = page.getByRole("button", { name: /Collapse.*[Uu]nassigned/ });
    if (await collapseDocuments.count()) {
      await collapseDocuments.click();
      await page.getByTestId("summary-card-unassigned").click();
      await collapseDocuments.waitFor();
    }
    const requests = await page.evaluate(() => window.dashboardFixtureRequests);
    assert.equal(requests.filter((r) => r === "GET /lab-inbox").length, inboxRequestsBefore, "summary navigation must reuse inbox data");
    await page.getByTestId("button-add-case").click();
    await page.getByRole("heading", { name: /[Nn]ew case|[Aa]dd case/ }).waitFor();
    console.log(`Dashboard layout and queue navigation verified at ${width}px`);
  }
  for (const state of ["loading", "error", "empty", "readonly", "profile-error"]) {
    await page.goto(`${url}?${state}`);
    const pastDue = page.getByTestId("summary-count-past-due");
    await pastDue.waitFor();
    if (state === "loading" || state === "error") {
      await page.waitForFunction((s) =>
        document.querySelector('[data-testid="summary-count-past-due"]')?.getAttribute("data-state") === s, state);
      assert.notEqual(await pastDue.textContent(), "0");
    }
    if (state === "empty") {
      await page.waitForFunction(() => document.querySelector('[data-testid="summary-count-past-due"]')?.textContent === "0");
    }
    if (state === "readonly") {
      assert.equal(await page.getByText("Today's sales", { exact: true }).count(), 0);
      assert.equal(await page.getByText("Creator", { exact: true }).count(), 0);
    }
    if (state === "profile-error") {
      const documents = page.getByTestId("summary-count-unassigned");
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="summary-count-unassigned"]')?.getAttribute("data-state") === "error");
      assert.equal(await documents.textContent(), "—", "failed lab identity is not a zero document count");
    }
    console.log(`Dashboard ${state} state verified`);
  }
  assert.deepEqual(errors, [], "unexpected browser errors");
} finally {
  await browser.close();
}
