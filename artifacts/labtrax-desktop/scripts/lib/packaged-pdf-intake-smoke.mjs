import assert from "node:assert/strict";
import { makeTwoPagePdf } from "./synthetic-two-page-pdf.mjs";

// Uses the built dashboard fixture, not Vite or a substitute PDF implementation.
// Only fetch/analysis is stubbed; PDF.js, its emitted worker and canvas are real.
export async function verifyPackagedPdfIntake(page) {
  const workers = [];
  const responses = [];
  const failed = [];
  const messages = [];
  const pageErrors = [];
  const isPdfWorker = (url) => /pdf.*worker|worker.*pdf/i.test(url);
  const onWorker = (worker) => workers.push(worker.url());
  const onResponse = (response) => {
    if (isPdfWorker(response.url())) responses.push({
      url: response.url(),
      status: response.status(),
      contentType: response.headers()["content-type"] ?? "(missing)",
    });
  };
  const onFailed = (request) => {
    if (isPdfWorker(request.url())) {
      failed.push(`${request.url()}: ${request.failure()?.errorText ?? "request failed"}`);
    }
  };
  const onConsole = (message) => {
    // PDF.js warns (not errors) when it falls back to a fake worker. That
    // fallback could otherwise make rasterization pass with a broken worker.
    if (/worker|Unmapped dashboard fixture/i.test(message.text())) messages.push(message.text());
  };
  const onPageError = (error) => pageErrors.push(error.message);
  page.on("worker", onWorker);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  try {
    await page.goto("app://labtrax/browser-tests/dashboard-reference.html?rx-review");
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
    );
    const bodies = await page.evaluate(() => window.dashboardFixtureAnalysisBodies);
    assert.equal(bodies.length, 1, "PDF must trigger exactly one local analysis request");
    const [body] = bodies;
    assert.equal(body.desktopReader, true);
    assert.match(body.imageBase64, /^data:image\/jpeg;base64,/, "page one must be rasterized");
    assert.equal(body.additionalImages?.length, 1, "page two must reach analysis");
    assert.match(body.additionalImages[0], /^data:image\/jpeg;base64,/, "page two must be rasterized");
    assert.notEqual(body.imageBase64, body.additionalImages[0], "pages must produce distinct images");
    assert.ok(workers.some(isPdfWorker), "a real dedicated PDF.js worker must start");
    assert.ok(responses.some(({ url, status, contentType }) =>
      workers.includes(url) &&
      url.startsWith("app://labtrax/assets/") && status === 200 &&
      /javascript/i.test(contentType)), "bundled worker must return JavaScript over app:// (not SPA fallback HTML)");
    assert.deepEqual(failed, [], "PDF.js worker requests must succeed");
    assert.deepEqual(responses.filter(({ status }) => status >= 400), []);
    assert.deepEqual(messages, [], "PDF.js must not fall back to a fake worker or report worker errors");
    assert.deepEqual(pageErrors, []);
    await page.getByTestId("rx-review-container").waitFor();
    assert.equal(await page.getByPlaceholder("Patient", { exact: true }).inputValue(), "Synthetic Review");
    const requests = await page.evaluate(() => window.dashboardFixtureRequests);
    assert.equal(requests.filter((request) => request === "POST /analyze-prescription").length, 1);
    assert.equal(requests.some((request) => request === "POST /cases"), false);
    console.log(`Packaged PDF intake passed: both pages reached local analysis; worker assets: ${JSON.stringify(responses)}`);
  } catch (error) {
    const text = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "(unavailable)");
    throw new Error(
      `Packaged two-page PDF intake failed: ${error.message}\n` +
      `Worker URLs: ${JSON.stringify(workers)}\nWorker asset responses: ${JSON.stringify(responses)}\n` +
      `Failed worker requests: ${JSON.stringify(failed)}\nWorker/fixture messages: ${JSON.stringify(messages)}\n` +
      `Page errors: ${JSON.stringify(pageErrors)}\nVisible text: ${text.slice(-1200)}`,
      { cause: error },
    );
  } finally {
    page.off("worker", onWorker);
    page.off("response", onResponse);
    page.off("requestfailed", onFailed);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}
