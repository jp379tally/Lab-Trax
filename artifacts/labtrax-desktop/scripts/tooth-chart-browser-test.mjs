import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { findChromium } from "./find-chromium.mjs";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const timeout = 60_000;

async function findFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a Vite port");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function startVite(config, basePath = "/") {
  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}${basePath}`;
  const args = [
    "exec",
    "vite",
    "--config",
    config,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ];
  const vite = spawn("pnpm", args, {
    cwd: desktopRoot,
    env: { ...process.env, BASE_PATH: basePath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  vite.stdout.on("data", (chunk) => output.push(String(chunk)));
  vite.stderr.on("data", (chunk) => output.push(String(chunk)));

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) {
      throw new Error(`Vite exited before the browser test started:\n${output.join("")}`);
    }
    try {
      await fetch(url);
      return { vite, url, output };
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  vite.kill("SIGTERM");
  throw new Error(`Vite did not serve ${url} within ${timeout}ms:\n${output.join("")}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function verifyVisibleChart(page, { panelTestId, legends, mobile }) {
  const panel = page.getByTestId(panelTestId);
  const svg = panel.locator("svg[viewBox='0 0 520 520']").first();
  await svg.waitFor({ state: "visible" });

  const geometry = await panel.evaluate((element, isMobile) => {
    const panelRect = element.getBoundingClientRect();
    const svg = element.querySelector("svg[viewBox='0 0 520 520']");
    if (!(svg instanceof SVGSVGElement)) return null;
    const svgRect = svg.getBoundingClientRect();
    const textBoxes = Array.from(svg.querySelectorAll("text")).map((text) => {
      const rect = text.getBoundingClientRect();
      return {
        text: text.textContent?.trim() ?? "",
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    });
    const toothElements = isMobile
      ? Array.from(svg.querySelectorAll("text")).filter((text) => /^(?:[1-9]|[12][0-9]|3[0-2])$/.test(text.textContent?.trim() ?? ""))
      : Array.from(element.querySelectorAll("[data-tooth-id]"));
    const toothRects = toothElements.map((tooth) => {
      const rect = tooth.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    });
    return {
      panel: { left: panelRect.left, right: panelRect.right, width: panelRect.width },
      svg: { left: svgRect.left, right: svgRect.right, top: svgRect.top, bottom: svgRect.bottom, width: svgRect.width, height: svgRect.height },
      panelScrollWidth: element.scrollWidth,
      panelClientWidth: element.clientWidth,
      textBoxes,
      toothRects,
    };
  }, mobile);

  assert(geometry, `${panelTestId}: chart SVG was not rendered`);
  assert(geometry.toothRects.length === 32, `${panelTestId}: expected all 32 adult teeth, got ${geometry.toothRects.length}`);
  assert(geometry.svg.width >= 250, `${panelTestId}: chart is too small (${geometry.svg.width}px wide)`);
  assert(geometry.svg.left >= geometry.panel.left - 1 && geometry.svg.right <= geometry.panel.right + 1,
    `${panelTestId}: chart overflows its case panel`);
  assert(geometry.panelScrollWidth <= geometry.panelClientWidth + 1,
    `${panelTestId}: panel has horizontal overflow`);

  const requiredSvgLabels = ["UPPER", "LOWER", "PATIENT RIGHT", "PATIENT LEFT"];
  for (const label of requiredSvgLabels) {
    const box = geometry.textBoxes.find((candidate) => candidate.text === label);
    assert(box && box.width > 0 && box.height > 0, `${panelTestId}: ${label} label is not visible`);
    assert(
      box.left >= geometry.svg.left - 1 &&
        box.right <= geometry.svg.right + 1 &&
        box.top >= geometry.svg.top - 1 &&
        box.bottom <= geometry.svg.bottom + 1,
      `${panelTestId}: ${label} label is clipped by the chart`,
    );
  }
  for (const box of geometry.textBoxes) {
    assert(
      box.width > 0 &&
        box.height > 0 &&
        box.left >= geometry.svg.left - 1 &&
        box.right <= geometry.svg.right + 1 &&
        box.top >= geometry.svg.top - 1 &&
        box.bottom <= geometry.svg.bottom + 1,
      `${panelTestId}: chart text "${box.text}" is clipped or has no visible bounds`,
    );
  }
  for (const label of legends) {
    const ariaLegend = label === "Bridge" ? "Bridge connector" : `${label} tooth`;
    const legend = mobile
      ? panel.getByText(label, { exact: true })
      : panel.locator(`[aria-label="${ariaLegend}"]`);
    await legend.waitFor({ state: "visible" });
    const visible = await legend.evaluate((element, expectedPanelId) => {
      const bounds = element.getBoundingClientRect();
      const parent = document.querySelector(`[data-testid="${expectedPanelId}"]`)?.getBoundingClientRect();
      return Boolean(parent && bounds.width > 0 && bounds.height > 0 &&
        bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1 &&
        bounds.top >= parent.top - 1 && bounds.bottom <= parent.bottom + 1);
    }, panelTestId);
    assert(visible, `${panelTestId}: legend "${label}" is clipped`);
  }

  for (const [index, rect] of geometry.toothRects.entries()) {
    assert(rect.width > 0 && rect.height > 0,
      `${panelTestId}: tooth ${index + 1} has no visible bounds (${JSON.stringify(rect)})`);
    assert(rect.left >= geometry.svg.left - 1 && rect.right <= geometry.svg.right + 1 &&
      rect.top >= geometry.svg.top - 1 && rect.bottom <= geometry.svg.bottom + 1,
    `${panelTestId}: tooth ${index + 1} is clipped by the chart`);
  }

  return geometry.svg.width;
}

const errors = [];
let browser;
let desktop;
let mobile;

try {
  const executablePath = findChromium();
  if (!executablePath) {
    throw new Error("Chromium is required. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or install Chromium.");
  }
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
    timeout,
  });
  desktop = await startVite("vite.config.ts", "/desktop/");
  mobile = await startVite(
    "browser-tests/tooth-chart-mobile.vite.config.mjs",
    "/",
  );

  const viewports = [
    { panelWidth: 320, viewportWidth: 360, label: "narrow" },
    { panelWidth: 720, viewportWidth: 900, label: "wide" },
  ];
  let screenshotCount = 0;

  for (const target of [
    { name: "desktop", base: desktop.url, panelTestId: "tooth-chart-panel", legends: ["Selected", "Crown", "Pontic", "Missing", "Billed", "Bridge"], mobile: false },
    { name: "mobile-read-only", base: mobile.url, panelTestId: "mobile-read-only-panel", legends: ["Selected", "Crown", "Pontic", "Missing", "Billed", "Bridge"], mobile: true },
  ]) {
    const page = await browser.newPage({ viewport: { width: 360, height: 1000 } });
    page.on("pageerror", (error) => errors.push(`${target.name}: ${error.message}`));
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "unknown";
      if (!request.url().includes("/favicon.ico") && failure !== "net::ERR_ABORTED") {
        errors.push(`${target.name} request failed: ${request.url()} (${failure})`);
      }
    });
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !message.text().includes("responded with a status of 404") &&
        !message.text().includes("504 (Outdated Optimize Dep)")
      ) {
        errors.push(`${target.name} console: ${message.text()}`);
      }
    });
    for (const size of viewports) {
      await page.setViewportSize({ width: size.viewportWidth, height: 1000 });
      await page.goto(`${target.base}${target.name === "desktop" ? "browser-tests/tooth-chart.html" : "tooth-chart-mobile.html"}?panelWidth=${size.panelWidth}`);
      try {
        await page.getByTestId(target.panelTestId).waitFor({ timeout: 5_000 });
      } catch (error) {
        await page.waitForTimeout(750);
        await page.reload();
        try {
          await page.getByTestId(target.panelTestId).waitFor({ timeout: 15_000 });
        } catch {
          const body = await page.locator("body").innerText().catch(() => "<body unavailable>");
          const markup = await page
            .locator("body")
            .evaluate((element) => element.innerHTML)
            .catch(() => "<body unavailable>");
          const viteOutput = target.name.startsWith("mobile")
            ? mobile.output.join("")
            : desktop.output.join("");
          throw new Error(
            `${target.name} fixture did not render at ${size.label} width. URL: ${page.url()}\n` +
              `Body: ${body}\nMarkup: ${markup}\nBrowser errors: ${errors.join("\n")}\nVite output: ${viteOutput}`,
            { cause: error },
          );
        }
      }
      await page.evaluate(() => document.fonts.ready);
      await verifyVisibleChart(page, target);

      if (target.name === "desktop") {
        const details = page.getByText("Large tooth and connector controls", { exact: true });
        await details.click();
        const controls = page.locator(`${target.panelTestId === "tooth-chart-panel" ? '[data-testid="tooth-chart-panel"]' : ""} button[aria-label^="Edit tooth"]`);
        assert(await controls.count() === 32, "Desktop: all 32 accessible tooth controls must be present");
        const controlsFit = await controls.evaluateAll((buttons, panelTestId) => {
          const panelElement = document.querySelector(`[data-testid="${panelTestId}"]`);
          if (!panelElement) return false;
          const panel = panelElement.getBoundingClientRect();
          return buttons.every((button) => {
            const rect = button.getBoundingClientRect();
            return rect.width >= 44 && rect.height >= 44 &&
              rect.left >= panel.left - 1 && rect.right <= panel.right + 1;
          });
        }, target.panelTestId);
        assert(controlsFit, `Desktop: tooth controls are clipped at ${size.label} width`);
      }

      await page.screenshot({
        path: join(tmpdir(), `labtrax-tooth-chart-${target.name}-${size.label}.png`),
        fullPage: true,
      });
      screenshotCount += 1;
    }
    await page.close();
  }

  const controlsPage = await browser.newPage({ viewport: { width: 360, height: 1000 } });
  controlsPage.on("pageerror", (error) => errors.push(`mobile-editable: ${error.message}`));
  controlsPage.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("responded with a status of 404") &&
      !message.text().includes("504 (Outdated Optimize Dep)")
    ) {
      errors.push(`mobile-editable console: ${message.text()}`);
    }
  });
  for (const size of viewports) {
    await controlsPage.setViewportSize({ width: size.viewportWidth, height: 1000 });
    await controlsPage.goto(`${mobile.url}tooth-chart-mobile.html?panelWidth=${size.panelWidth}`);
    const panel = controlsPage.getByTestId("mobile-editable-panel");
    await panel.waitFor();
    const buttons = panel.locator('[role="button"][aria-label^="Edit tooth"]');
    await buttons.first().waitFor({ state: "visible" });
    assert(await buttons.count() === 32, "Mobile: all 32 accessible tooth controls must be present");
    const controlsFit = await buttons.evaluateAll((elements, panelTestId) => {
      const parentElement = document.querySelector(`[data-testid="${panelTestId}"]`);
      if (!parentElement) return false;
      const parent = parentElement.getBoundingClientRect();
      return elements.every((element) => {
        const rect = element.getBoundingClientRect();
        const textRange = document.createRange();
        textRange.selectNodeContents(element);
        const textRect = textRange.getBoundingClientRect();
        return rect.width >= 44 && rect.height >= 44 &&
          rect.left >= parent.left - 1 && rect.right <= parent.right + 1 &&
          Boolean(textRect && textRect.width > 0 && textRect.height > 0 &&
            textRect.left >= rect.left - 1 && textRect.right <= rect.right + 1);
      });
    }, "mobile-editable-panel");
    assert(controlsFit, `Mobile: tooth controls or their labels are clipped at ${size.label} width`);
    await controlsPage.screenshot({
      path: join(tmpdir(), `labtrax-tooth-chart-mobile-controls-${size.label}.png`),
      fullPage: true,
    });
    screenshotCount += 1;
  }
  await controlsPage.close();

  if (errors.length) throw new Error(`Browser renderer errors: ${errors.join("; ")}`);
  console.log(`✓ Desktop and mobile tooth charts fit narrow and wide case panels (${screenshotCount} screenshots captured)`);
} finally {
  await browser?.close();
  desktop?.vite.kill("SIGTERM");
  mobile?.vite.kill("SIGTERM");
}
