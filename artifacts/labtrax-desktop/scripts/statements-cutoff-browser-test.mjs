import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { findChromium } from "./find-chromium.mjs";

const executablePath = findChromium();
assert(executablePath, "Chromium is required for cutoff browser coverage");
const screenshotDir = join(
  process.env["LABTRAX_BROWSER_ARTIFACT_DIR"] || "/tmp",
  "statements-cutoff",
);
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const url = `http://127.0.0.1:${port}/desktop/browser-tests/statements-cutoff.html`;
const vite = spawn("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, BASE_PATH: "/desktop/" }, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
vite.stdout.on("data", (chunk) => { output += chunk; });
vite.stderr.on("data", (chunk) => { output += chunk; });
let browser;
try {
  const deadline = Date.now() + 60_000;
  while (true) {
    assert(vite.exitCode === null && Date.now() < deadline, `Vite failed to start: ${output}`);
    try { if ((await fetch(url)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  mkdirSync(screenshotDir, { recursive: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1000, height: 440 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width < 500 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByRole("button", { name: /Generate Statements/i }).click();
    // The modal calendar correctly hides the wizard from the accessibility tree
    // while open; retain a DOM locator to measure the background scroll position.
    const scope = page.locator('input[type="radio"][value="open_as_of"]');
    if (viewport.width < 500) await scope.tap(); else await scope.click();
    const calendar = page.getByRole("dialog", { name: "Invoice cutoff date" });
    await calendar.waitFor();
    await page.evaluate(() => document.fonts.ready);
    const before = await scope.evaluate((el) => el.closest(".overflow-y-auto").scrollTop);
    const geometry = await calendar.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return {
        left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width,
        inScroll: !!element.parentElement?.closest(".overflow-y-auto"),
        months: element.querySelectorAll(".rdp-month").length,
        reachable: [...element.querySelectorAll("button")].every((button) => {
          const rect = button.getBoundingClientRect();
          if (!rect.width || getComputedStyle(button).visibility === "hidden") return true;
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return button === hit || button.contains(hit);
        }),
      };
    });
    assert(geometry.left >= 0 && geometry.right <= viewport.width && geometry.top >= 0 && geometry.bottom <= viewport.height, "Calendar is clipped");
    assert(!geometry.inScroll && geometry.months === 1 && geometry.reachable, `Calendar must be a reachable one-month portal: ${JSON.stringify(geometry)}`);
    assert(Math.abs(geometry.width - Math.min(380, viewport.width - 24)) < 2, "Calendar width is not responsive");
    await page.screenshot({ path: join(screenshotDir, `${viewport.width}-${viewport.height}.png`) });
    await page.keyboard.press("Escape");
    await calendar.waitFor({ state: "hidden" });
    assert(await page.getByText("Generate statements", { exact: true }).isVisible(), "Escape closed wizard");
    assert(await page.getByRole("button", { name: "Next", exact: true }).isDisabled(), "Dismissal chose a date");
    await scope.focus();
    await page.keyboard.press("Space");
    await calendar.getByRole("combobox", { name: "Choose the Year" }).selectOption("2020");
    await calendar.getByRole("combobox", { name: "Choose the Month" }).selectOption("1");
    const day = calendar.getByRole("button", { name: /February 29th, 2020/ });
    if (viewport.width < 500) await day.tap(); else await day.click();
    await calendar.waitFor({ state: "hidden" });
    assert(await page.getByText("February 29, 2020", { exact: true }).isVisible());
    assert.equal(await scope.evaluate((el) => el.closest(".overflow-y-auto").scrollTop), before, "Picking date scrolled wizard");
    await page.getByRole("button", { name: "Change date" }).click();
    await calendar.getByRole("button", { name: /February 29th, 2020, selected/ }).waitFor();
    await calendar.getByRole("button", { name: /Go to the next month/i }).click();
    assert.equal(await calendar.getByRole("combobox", { name: "Choose the Month" }).inputValue(), "2");
    await calendar.getByRole("button", { name: /Go to the previous month/i }).click();
    await calendar.getByRole("button", { name: /February 29th, 2020, selected/ }).waitFor();
    await calendar.getByRole("button", { name: /February 29th, 2020, selected/ }).click();
    await calendar.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Change date" }).click();
    await calendar.getByRole("button", { name: /February 29th, 2020, selected/ }).waitFor();
    // Outside click closes only the calendar and leaves the saved date untouched.
    await page.mouse.click(2, 2);
    await calendar.waitFor({ state: "hidden" });
    assert(await page.getByText("Generate statements", { exact: true }).isVisible(), "Outside click closed wizard");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByLabel("Select practice Browser Practice").last().waitFor();
    await page.getByRole("button", { name: /Setup/ }).click();
    assert(await page.getByText("February 29, 2020", { exact: true }).isVisible(), "Navigation lost cutoff");
    await scope.focus();
    await page.keyboard.press("Enter");
    await calendar.getByRole("button", { name: /February 29th, 2020, selected/ }).waitFor();
    await page.keyboard.press("ArrowLeft");
    assert.match(await page.locator(":focus").getAttribute("aria-label"), /February 28th, 2020/);
    await page.keyboard.press("Enter");
    await calendar.waitFor({ state: "hidden" });
    assert(await page.getByText("February 28, 2020", { exact: true }).isVisible());
    assert.deepEqual(errors, []);
    console.log(`✓ Cutoff calendar mouse/touch/keyboard, dismissal, retention and portal geometry ${viewport.width}×${viewport.height}`);
    await context.close();
  }
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
