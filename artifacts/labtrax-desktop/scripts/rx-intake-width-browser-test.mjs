import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { findChromium } from "./find-chromium.mjs";
import { makeTwoPagePdf } from "./lib/synthetic-two-page-pdf.mjs";

// Real shell/dashboard/review components; isolated in the existing fetch-stubbed
// fixture. No live sign-in, API writes, model calls, cases or billing.
const output = new URL("../../../generated-artifacts/rx-intake-width/", import.meta.url).pathname;
mkdirSync(output, { recursive: true });
const listener = createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const fixtureUrl = `http://127.0.0.1:${port}/desktop/browser-tests/dashboard-reference.html?rx-review`;
const vite = spawn("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, BASE_PATH: "/desktop/" }, stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
vite.stdout.on("data", chunk => { serverOutput += chunk; });
vite.stderr.on("data", chunk => { serverOutput += chunk; });
let browser;
try {
  const deadline = Date.now() + 60_000;
  while (true) {
    assert(vite.exitCode === null && Date.now() < deadline, `Vite failed to start: ${serverOutput}`);
    try { if ((await fetch(fixtureUrl)).ok) break; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({
  executablePath: findChromium(), headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
  const page = await browser.newPage();
  const errors = [];
  const pdfWorkerUrls = [];
  const failedPdfWorkerRequests = [];
  const pdfWorkerResponses = [];
  const pdfWorkerConsoleErrors = [];
  const isPdfWorkerUrl = (url) => /pdf.*worker|worker.*pdf/i.test(url);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("worker", (worker) => {
    if (isPdfWorkerUrl(worker.url())) pdfWorkerUrls.push(worker.url());
  });
  page.on("requestfailed", (request) => {
    if (isPdfWorkerUrl(request.url())) {
      failedPdfWorkerRequests.push(`${request.url()}: ${request.failure()?.errorText ?? "request failed"}`);
    }
  });
  page.on("response", (response) => {
    if (isPdfWorkerUrl(response.url())) {
      pdfWorkerResponses.push({ url: response.url(), status: response.status() });
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error" && /pdf.*worker|worker.*pdf|fake worker/i.test(message.text())) {
      pdfWorkerConsoleErrors.push(message.text());
    }
    if (message.type() === "error" && message.text().includes("Unmapped dashboard fixture")) {
      errors.push(message.text());
    }
  });
  // Include a wide resizable sidebar: container queries must use the remaining
  // canvas, not just assume that a wide browser has room for two columns.
  await page.addInitScript(() => localStorage.setItem("labtrax_sidebar_width_v1", "320"));
  for (const width of [1690, 1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 887 });
    await page.goto(fixtureUrl);
    await page.getByTestId("summary-count-past-due").filter({ hasText: "7" }).waitFor();
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "synthetic-layout.png", mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"),
    });
    const patient = page.getByPlaceholder("Patient", { exact: true });
    await patient.waitFor();
    await patient.inputValue().then((value) => assert.equal(value, "Synthetic Review"));
    await patient.fill("Edited synthetic review");
    const panel = await page.getByTestId("rx-drop-zone-panel").boundingBox();
    const cases = await page.getByTestId("dashboard-main-column").boundingBox();
    const root = await page.getByTestId("dashboard-root").boundingBox();
    const field = await patient.boundingBox();
    assert.ok(panel && cases && root && field);
    assert.ok(Math.abs(panel.x - root.x - 16) < 1, "intake must reach the main canvas's 16px gutter");
    assert.ok(field.width > 200, "the real review input, not just the card, must expand");
    if (width >= 1440) {
      assert.ok(panel.width >= 420, "desktop intake must be wider than the former 320px limit");
      assert.ok(cases.x >= panel.x + panel.width + 15, "tables must not overlap the intake");
      assert.ok(cases.width >= 600, "neighboring case tables must retain usable room");
    } else {
      assert.ok(cases.y >= panel.y + panel.height, "narrow main canvases must stack without overlap");
    }
    assert.equal(await page.evaluate(() =>
      document.documentElement.scrollWidth > window.innerWidth + 1), false, `page overflow at ${width}px`);
    assert.equal(await page.getByTestId("dashboard-root").evaluate((root) =>
      root.scrollWidth > root.clientWidth + 1), false, `dashboard overflow at ${width}px`);
    assert.equal(await patient.inputValue(), "Edited synthetic review");
    await page.evaluate(() => document.fonts.ready);
    if (width < 1440) await patient.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}review-${width}.jpg` });
    console.log(JSON.stringify({ width, panel, fieldWidth: field.width, caseTableWidth: cases.width }));
    const requests = await page.evaluate(() => window.dashboardFixtureRequests);
    assert.equal(requests.filter((request) => request === "POST /analyze-prescription").length, 1);
    assert.equal(requests.some((request) => request === "POST /cases"), false);
  }

  // Exercise the real PDF.js worker, rasterization, and analysis handoff in a
  // Chromium page. The fixture's fetch implementation returns a local response.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(fixtureUrl);
  await page.getByTestId("summary-count-past-due").filter({ hasText: "7" }).waitFor();
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "synthetic-two-page-prescription.pdf",
    mimeType: "application/pdf",
    buffer: makeTwoPagePdf(),
  });

  await page.waitForFunction(
    () => window.dashboardFixtureAnalysisBodies?.length > 0,
    null,
    { timeout: 30_000 },
  ).catch(async (error) => {
    const workerDetails = failedPdfWorkerRequests.length
      ? ` PDF.js worker request failed: ${failedPdfWorkerRequests.join("; ")}`
      : pdfWorkerResponses.some(({ status }) => status >= 400)
        ? ` PDF.js worker returned an HTTP error: ${JSON.stringify(pdfWorkerResponses)}`
        : pdfWorkerConsoleErrors.length
          ? ` PDF.js worker error: ${pdfWorkerConsoleErrors.join("; ")}`
      : errors.length
        ? ` Browser error: ${errors.join("; ")}`
        : "";
    const visibleText = (await page.locator("body").innerText()).slice(-1200);
    throw new Error(
      `Two-page PDF intake did not reach the local analysis stub.${workerDetails} ` +
      `Visible page text: ${visibleText || "(empty)"}. ${error.message}`,
    );
  });

  const analysisBodies = await page.evaluate(() => window.dashboardFixtureAnalysisBodies);
  assert.equal(analysisBodies.length, 1, "the two-page PDF should trigger one analysis request");
  const [analysisBody] = analysisBodies;
  assert.equal(analysisBody.desktopReader, true);
  assert.match(analysisBody.imageBase64, /^data:image\/jpeg;base64,/,
    "page one must be rasterized to a JPEG data URL");
  assert.equal(analysisBody.additionalImages?.length, 1,
    "page two must be included as the additional image");
  assert.match(analysisBody.additionalImages[0], /^data:image\/jpeg;base64,/,
    "page two must be rasterized to a JPEG data URL");
  assert.notEqual(analysisBody.imageBase64, analysisBody.additionalImages[0],
    "different synthetic pages must produce separate rasterized images");

  const workerLoaded = pdfWorkerResponses.some(({ status }) => status >= 200 && status < 400);
  assert.ok(
    workerLoaded,
    `PDF.js worker did not load successfully. Worker URLs: ${pdfWorkerUrls.join(", ") || "(none)"}. ` +
    `Responses: ${JSON.stringify(pdfWorkerResponses)}. ` +
    `Failed requests: ${failedPdfWorkerRequests.join("; ") || "(none)"}`,
  );
  assert.deepEqual(
    pdfWorkerResponses.filter(({ status }) => status >= 400),
    [],
    `PDF.js worker returned an HTTP error: ${JSON.stringify(pdfWorkerResponses)}`,
  );
  assert.deepEqual(failedPdfWorkerRequests, [],
    `PDF.js worker request failed: ${failedPdfWorkerRequests.join("; ")}`);
  assert.deepEqual(pdfWorkerConsoleErrors, [],
    `PDF.js worker error: ${pdfWorkerConsoleErrors.join("; ")}`);

  const review = page.getByTestId("rx-review-container");
  await review.waitFor();
  assert.equal(await page.getByPlaceholder("Patient", { exact: true }).inputValue(), "Synthetic Review");
  await review.getByRole("button", { name: "Dr. Example", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    `RX intake layout and two-page PDF passed; both page images reached local analysis; ` +
    `PDF.js worker loaded; populated review opened (${pdfWorkerUrls.length} worker(s), ` +
    `${pdfWorkerResponses.length} worker response(s)).`,
  );
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
