import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { build } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findChromium } from "./find-chromium.mjs";

// The managed web workflow must be running; never start a duplicate server.
const origin = process.env.DASHBOARD_TEST_ORIGIN || "http://localhost";
let url = process.env.DASHBOARD_TEST_URL || `${origin}/desktop/browser-tests/dashboard-reference.html`;
const packaged = process.argv.includes("--packaged");
const variant = packaged || process.env.DASHBOARD_TEST_URL ? "packaged-renderer" : "desktop";
const output = new URL("../../../generated-artifacts/dashboard/", import.meta.url).pathname;
mkdirSync(output, { recursive: true });
if (packaged) {
  const outDir = `${output}packaged-renderer`;
  await build({
    configFile: fileURLToPath(new URL("../vite.electron.config.ts", import.meta.url)),
    build: {
      outDir,
      rollupOptions: {
        input: fileURLToPath(new URL("../browser-tests/dashboard-reference.html", import.meta.url)),
      },
    },
  });
  url = pathToFileURL(`${outDir}/browser-tests/dashboard-reference.html`).href;
}
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
    assert.equal(await page.getByTestId("summary-count-due-tomorrow").textContent(), "4");
    const add = await page.getByTestId("button-add-case").boundingBox();
    const assistant = await page.getByTestId("button-ai-assistant").boundingBox();
    assert.ok(add && assistant);
    assert.equal(add.width, assistant.width, "primary action widths must match");
    assert.equal(add.height, assistant.height, "primary action heights must match");
    assert.equal(add.y, assistant.y, "Assistant must sit beside Add case");
    assert.ok(assistant.x >= add.x + add.width, "Assistant must follow Add case");
    const sales = await page.getByTestId("dashboard-today-sales").boundingBox();
    assert.ok(sales && sales.y >= add.y + add.height, "sales must be below the action pair");
    const dueToday = await page.getByTestId("summary-card-due-today").boundingBox();
    const dueTomorrow = await page.getByTestId("summary-card-due-tomorrow").boundingBox();
    assert.ok(dueToday && dueTomorrow);
    if (width >= 768) {
      assert.equal(dueTomorrow.y, dueToday.y);
      assert.ok(dueTomorrow.x >= dueToday.x + dueToday.width, "Due tomorrow must be right of Due today");
    }
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
    await page.getByRole("button", { name: "Collapse due tomorrow", exact: true }).click();
    await page.getByTestId("section-due-tomorrow").evaluate((section) => {
      window.dashboardTomorrowScrolls = [];
      const original = section.scrollIntoView.bind(section);
      section.scrollIntoView = (options) => {
        window.dashboardTomorrowScrolls.push({
          expanded: !!section.querySelector('[aria-label="Collapse due tomorrow"]'),
          rows: section.querySelectorAll("tbody tr").length,
        });
        original(options);
      };
    });
    await page.getByRole("button", { name: "Due tomorrow: 4", exact: true }).click();
    await page.waitForFunction(() => window.dashboardTomorrowScrolls?.length === 1);
    assert.deepEqual(await page.evaluate(() => window.dashboardTomorrowScrolls), [{ expanded: true, rows: 4 }],
      "Due tomorrow must expand and render its cases before scrolling");
    await page.waitForFunction(() => {
      const box = document.querySelector('[data-testid="section-due-tomorrow"]').getBoundingClientRect();
      return box.top >= 0 && box.top < window.innerHeight;
    });
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
      await page.getByRole("button", { name: "Due tomorrow: 0", exact: true }).click();
      await page.getByTestId("section-due-tomorrow").getByText("No cases due on the next business day.", { exact: true }).first().waitFor();
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
