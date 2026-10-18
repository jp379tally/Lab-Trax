const { createReadStream, existsSync, mkdtempSync, rmSync, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { extname, join, normalize } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require("@playwright/test");
const { caseHeaderResponse, verifyCaseHeader } = require("./case-header-web-checks");

const outputDir = mkdtempSync(join(tmpdir(), "labtrax-web-smoke-"));

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveExport() {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const appPath = pathname === "/app" ? "/" : pathname.replace(/^\/app\//, "/");
      const relativePath = normalize(appPath).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^[/\\]+/, "");
      let filePath = join(outputDir, relativePath);
      if (!relativePath || !existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = join(outputDir, "index.html");
      }
      response.writeHead(200, {
        "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
      });
      createReadStream(filePath).pipe(response);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/app`,
      });
    });
  });
}

async function verifyReceivePaymentsRoute() {
  const { server, url } = await serveExport();
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    spawnSync("which", ["chromium"], { encoding: "utf8" }).stdout.trim() ||
    undefined;
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 720 } });
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") runtimeErrors.push(message.text());
    });
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      let body = process.env.LABTRAX_WEB_SMOKE_CASE_HEADER_ONLY ? caseHeaderResponse(route.request()) : {};
      if (pathname === "/api/auth/login") {
        body = {
          success: true,
          accessToken: "browser-smoke-access",
          refreshToken: "browser-smoke-refresh",
          user: { id: "browser-smoke-user", username: "browser-smoke", userType: "lab" },
        };
      } else if (pathname === "/api/auth/me") {
        body = {
          success: true,
          user: { id: "browser-smoke-user", username: "browser-smoke", userType: "lab" },
          memberships: [{
            id: "browser-smoke-membership",
            role: "admin",
            status: "active",
            organizationId: "browser-smoke-lab",
            organization: { id: "browser-smoke-lab", type: "lab", name: "Browser Smoke Lab" },
          }],
        };
      } else if (pathname === "/api/auth/users") {
        body = { users: [] };
      } else if (pathname === "/api/notifications") {
        body = [];
      } else if (pathname === "/api/billing/subscription") {
        body = { entitlement: { status: "active", accessLevel: "full" } };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    await page.goto(url);
    await page.getByTestId("login-username").fill("browser-smoke");
    await page.getByTestId("login-password").fill("browser-smoke-password");
    await page.getByTestId("login-submit").click();
    await page.waitForURL((current) => current.pathname === "/app/");

    if (process.env.LABTRAX_WEB_SMOKE_CASE_HEADER_ONLY) {
      try {
        await verifyCaseHeader(page, url);
      } catch (error) {
        console.error(`Case header browser failure at ${page.url()}:\n${await page.locator("body").innerText()}\nRuntime errors:\n${runtimeErrors.join("\n")}`);
        throw error;
      }
      if (runtimeErrors.length) throw new Error(`Expo web runtime errors:\n${runtimeErrors.join("\n")}`);
      return;
    }

    await page.locator('a[href$="/financial"]').evaluate((element) => element.click());
    await page.waitForURL((current) => current.pathname.endsWith("/financial"));
    try {
      await page.getByText("Receive Payments", { exact: true }).last().click();
    } catch (error) {
      const body = await page.locator("body").innerText().catch(() => "<body unavailable>");
      throw new Error(
        `Financial hub did not expose Receive Payments at ${page.url()}.\n` +
        `Visible text:\n${body.slice(0, 2000)}\n` +
        `Runtime errors:\n${runtimeErrors.join("\n") || "<none>"}`,
        { cause: error },
      );
    }
    await page.waitForURL((current) => current.pathname === "/app/finance/receive-payments");
    try {
      await page.getByText("Open Receive Payments on mobile or desktop", { exact: true }).waitFor();
    } catch (error) {
      const body = await page.locator("body").innerText().catch(() => "<body unavailable>");
      throw new Error(
        `Receive Payments guidance did not render at ${page.url()}.\n` +
        `Visible text:\n${body.slice(0, 2000)}\n` +
        `Runtime errors:\n${runtimeErrors.join("\n") || "<none>"}`,
        { cause: error },
      );
    }
    await page.getByText(
      "Secure payment entry is available in the LabTrax iOS and Android apps. In a browser, use Receive Payments in the desktop Financial workspace.",
      { exact: true },
    ).waitFor();
    await page.getByTestId("receive-back").click();
    await page.waitForURL((current) => current.pathname.endsWith("/financial"));

    if (runtimeErrors.length) {
      throw new Error(`Expo web runtime errors:\n${runtimeErrors.join("\n")}`);
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function verifyProductionServerRoutes() {
  const port = await reservePort();
  const child = spawn(process.execPath, [join(__dirname, "..", "server", "serve.js")], {
    cwd: join(__dirname, ".."),
    env: {
      ...process.env,
      BASE_PATH: "/",
      LABTRAX_STATIC_ROOT: outputDir,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    let appResponse;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        appResponse = await fetch(`http://127.0.0.1:${port}/app`);
        if (appResponse.ok) break;
      } catch {
        // The server may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!appResponse?.ok) {
      throw new Error(`Production web server did not start:\n${stderr}`);
    }

    const html = await appResponse.text();
    const scriptPath = html.match(/src=["']([^"']+entry-[^"']+\.js)["']/)?.[1];
    if (!scriptPath) {
      throw new Error("Production /app response did not reference the Expo web bundle");
    }

    for (const pathname of [
      scriptPath,
      "/app/favicon.ico",
      "/app/finance/receive-payments",
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
      if (!response.ok) {
        throw new Error(`Production web route ${pathname} returned ${response.status}`);
      }
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  }
}

async function main() {
  const result = spawnSync(
    "pnpm",
    ["exec", "expo", "export", "--platform", "web", "--output-dir", outputDir],
    {
      cwd: join(__dirname, ".."),
      env: {
        ...process.env,
        EXPO_PUBLIC_DOMAIN: process.env.EXPO_PUBLIC_DOMAIN || "lab-trax.replit.app",
        NODE_OPTIONS: process.env.NODE_OPTIONS || "--max-old-space-size=3072",
      },
      stdio: "inherit",
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
  await verifyProductionServerRoutes();
  await verifyReceivePaymentsRoute();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  rmSync(outputDir, { recursive: true, force: true });
});