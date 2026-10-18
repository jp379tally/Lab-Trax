import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { findChromium } from "./find-chromium.mjs";

const appRoot = new URL("..", import.meta.url).pathname;
const port = 41739;
const baseUrl = `http://127.0.0.1:${port}`;
const testUrl = `${baseUrl}/desktop/browser-tests/register-long.html`;
const timeout = 60_000;
const errors = [];

const vite = spawn(
  "pnpm",
  ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: appRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);

async function waitForVite() {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) {
      throw new Error(`Vite exited before the browser test started (${vite.exitCode})`);
    }
    try {
      const response = await fetch(testUrl);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Vite");
}

let browser;
try {
  await waitForVite();
  const executablePath = findChromium();
  if (!executablePath) {
    throw new Error(
      "Chromium is required. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or install Chromium.",
    );
  }
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
    timeout,
  });

  const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(testUrl);

  await page.getByText("Overflow transaction 80").waitFor();
  const viewport = page.getByTestId("register-scroll-viewport");
  if ((await viewport.evaluate((element) => element.scrollHeight <= element.clientHeight))) {
    throw new Error("Fixture did not overflow the register viewport");
  }
  if ((await viewport.evaluate((element) => element.scrollWidth <= element.clientWidth))) {
    throw new Error("Fixture did not overflow the register viewport horizontally");
  }
  await viewport.evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth;
  });
  if ((await viewport.evaluate((element) => element.scrollLeft)) === 0) {
    throw new Error("Register did not scroll away from the first columns");
  }

  const addEntry = page.getByRole("button", { name: /add entry/i });
  await addEntry.click();
  const numInput = page.getByPlaceholder("Num");
  await numInput.waitFor();

  await numInput.fill("2001");
  await page.getByRole("textbox", { name: "Payee" }).fill("Saved overflow entry");
  // Scope to the entry row: the filter bar's collapsed "Amount filters" inputs
  // are also number inputs and come first in the page.
  await page.getByTestId("register-blank-entry-row").locator('input[type="number"]').first().fill("25");
  await page.getByRole("button", { name: "Save row" }).click();

  await page.waitForFunction(() => {
    const payload = window.__registerSavePayload;
    return payload?.payee === "Saved overflow entry" && payload?.payment === 25;
  });

  await page.waitForFunction(() => {
    const viewportElement = document.querySelector('[data-testid="register-scroll-viewport"]');
    const row = document.querySelector('[data-testid="register-blank-entry-row"]');
    if (!(viewportElement instanceof HTMLElement) || !(row instanceof HTMLElement)) return false;
    const viewportRect = viewportElement.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return rowRect.bottom > viewportRect.top && rowRect.top < viewportRect.bottom;
  });
  try {
    await page.waitForFunction(() => {
      const viewportElement = document.querySelector('[data-testid="register-scroll-viewport"]');
      const num = document.querySelector('input[placeholder="Num"]');
      if (!(viewportElement instanceof HTMLElement) || !(num instanceof HTMLInputElement)) return false;
      const viewportRect = viewportElement.getBoundingClientRect();
      const numRect = num.getBoundingClientRect();
      return numRect.left >= viewportRect.left && numRect.right <= viewportRect.right;
    }, undefined, { timeout: 5_000 });
  } catch (error) {
    const geometry = await viewport.evaluate((element) => {
      const input = element.querySelector('input[placeholder="Num"]');
      if (!(input instanceof HTMLInputElement)) return { missingInput: true };
      const viewportRect = element.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      const row = input.closest("tr");
      const rowRect = row?.getBoundingClientRect();
      return {
        scrollLeft: element.scrollLeft,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollBehavior: getComputedStyle(element).scrollBehavior,
        viewportLeft: viewportRect.left,
        viewportRight: viewportRect.right,
        inputLeft: inputRect.left,
        inputRight: inputRect.right,
        inputFocused: document.activeElement === input,
        rowLeft: rowRect?.left,
        rowRight: rowRect?.right,
      };
    });
    throw new Error(
      `Replacement Num field did not become horizontally visible: ${JSON.stringify({ ...geometry, rendererErrors: errors })}; ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!(await numInput.evaluate((element) => element === document.activeElement))) {
    throw new Error("Replacement Num field did not receive keyboard focus after save");
  }

  if ((await page.getByTestId("register-blank-entry-row").count()) !== 1) {
    throw new Error("Saving created more than one blank row");
  }
  if (errors.length) throw new Error(`Renderer errors: ${errors.join("; ")}`);

  await addEntry.click();
  await addEntry.click();
  if ((await page.getByTestId("register-blank-entry-row").count()) !== 1) {
    throw new Error("Repeated Add entry clicks created more than one blank row");
  }
  if (!(await page.getByPlaceholder("Num").evaluate((element) => element === document.activeElement))) {
    throw new Error("Repeated Add entry clicks did not keep focus on Num");
  }

  console.log("✓ Long register keeps one horizontally visible focused replacement row after save");
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}