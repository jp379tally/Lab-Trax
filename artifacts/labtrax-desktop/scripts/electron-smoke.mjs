/**
 * Real-Electron smoke test.
 *
 * Boots the packaged renderer (`dist/electron-app/`) under an actual Electron
 * binary using Playwright's Electron driver and asserts:
 *   1. The main process loads without throwing.
 *   2. A renderer window is created.
 *   3. The renderer loads from the `app://labtrax/` custom protocol (the
 *      production code path) without unhandled exceptions.
 *   4. The preload-exposed `window.electronAPI` bridge exists with the
 *      complete set of expected groups and methods.
 *   5. `app.getVersion()` is callable from the main process.
 *
 * This complements the vitest suite (which mocks Electron). Failures here
 * indicate real-runtime breakage — preload contextIsolation issues, broken
 * `app://` protocol handler, missing IPC channels, etc.
 *
 * The smoke test fails on:
 *   * Any renderer page error (uncaught exception in the renderer).
 *   * Any renderer console.error not matched by ALLOWED_RENDERER_CONSOLE
 *     (network/API failures from the placeholder backend are expected).
 *   * Any main-process stderr line not matched by ALLOWED_MAIN_STDERR
 *     (Chromium GPU / sandbox / DBus warnings under xvfb are expected).
 *   * Missing preload bridge keys.
 *   * Wrong renderer URL (must be app://labtrax/).
 *
 * The allowlists are intentionally narrow — anything genuinely new or
 * unknown trips the build. Add patterns deliberately, with a comment
 * explaining why each line is benign.
 *
 * Run locally:
 *   pnpm --filter @workspace/labtrax-desktop run electron:smoke
 *
 * Run in CI under a virtual display:
 *   xvfb-run -a pnpm --filter @workspace/labtrax-desktop run electron:smoke
 */

import { _electron as electron } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const indexHtml = path.join(appRoot, "dist", "electron-app", "index.html");

if (!existsSync(indexHtml)) {
  console.error(
    `\nERROR: renderer build not found at ${indexHtml}\n` +
      `Run \`pnpm --filter @workspace/labtrax-desktop exec vite build --config vite.electron.config.ts\` first.\n`,
  );
  process.exit(1);
}

const errors = [];
const TIMEOUT_MS = 60_000;

// Renderer console.error messages that are expected when running the smoke
// test against a placeholder backend (VITE_API_BASE_URL=https://example.invalid)
// and therefore must not fail the build. Add patterns here only with a
// justification.
const ALLOWED_RENDERER_CONSOLE = [
  // React Query / fetch failures from API calls hitting the placeholder URL.
  /Failed to fetch/i,
  /NetworkError/i,
  /net::ERR_/i,
  /ERR_NAME_NOT_RESOLVED/i,
  /TypeError: Load failed/i,
  // React Query surfaces query failures as console errors with a "Query data"
  // / "Mutation" prefix while the network is unreachable.
  /Query data cannot be undefined/i,
  // Some React libs warn about devtools / React strict-mode noise on first
  // mount under headless Chromium.
  /Download the React DevTools/i,
];

// Main-process stderr lines that are expected when Electron runs under
// xvfb without a real GPU / dbus / sandbox. These are not crashes; they
// are well-known Chromium diagnostic noise on Linux CI runners.
const ALLOWED_MAIN_STDERR = [
  /Gtk-(WARNING|Message)/i,
  /libva error/i,
  /Failed to connect to the bus/i,
  /dbus|DBus/,
  /MESA(?:-LOADER)?:/i,
  /libEGL warning/i,
  /Vulkan|vulkan/,
  /GL ERROR/i,
  /\[GFX\d+/i,
  // Sandbox warnings from --no-sandbox (we intentionally disable it).
  /sandbox/i,
  /SUID sandbox/i,
  // Chromium feature-flag / autofill / FontConfig boot-time chatter.
  /FontConfig/i,
  /WidevineCdm/i,
  /Autofill/i,
  // ANGLE / SwiftShader bring-up under headless GPU.
  /ANGLE|SwiftShader/i,
  // Source-map / DevTools warnings.
  /DevTools listening/i,
  /Debugger ending on ws:\/\//i,
  /For help, see: https:\/\/nodejs\.org\/en\/docs\/inspector/i,
  // electron-updater logs to stderr at "info" level via electron-log when no
  // file transport is configured; we already gate the updater off in CI but
  // keep this defensive.
  /electron-updater/i,
];

function isAllowed(line, allowlist) {
  return allowlist.some((re) => re.test(line));
}

console.log("Launching Electron…");

const electronApp = await electron.launch({
  args: [".", "--no-sandbox", "--disable-gpu"],
  cwd: appRoot,
  timeout: TIMEOUT_MS,
  env: {
    ...process.env,
    ELECTRON_DEV: "0",
    LABTRAX_SKIP_AUTOUPDATER: "1",
    NODE_ENV: "production",
    ELECTRON_DISABLE_SANDBOX: "1",
  },
});

const mainProc = electronApp.process();
let mainStderrBuf = "";
mainProc.stderr?.on("data", (chunk) => {
  const text = chunk.toString();
  process.stderr.write(`[electron:stderr] ${text}`);
  mainStderrBuf += text;
  let nl;
  while ((nl = mainStderrBuf.indexOf("\n")) !== -1) {
    const line = mainStderrBuf.slice(0, nl).trim();
    mainStderrBuf = mainStderrBuf.slice(nl + 1);
    if (!line) continue;
    if (isAllowed(line, ALLOWED_MAIN_STDERR)) continue;
    errors.push(`Main-process stderr: ${line}`);
  }
});
mainProc.stdout?.on("data", (chunk) => {
  process.stdout.write(`[electron:stdout] ${chunk}`);
});

const window = await electronApp.firstWindow({ timeout: TIMEOUT_MS });

window.on("pageerror", (err) => {
  errors.push(`Renderer page error: ${err.message}`);
  console.error("[renderer:pageerror]", err);
});
window.on("console", (msg) => {
  if (msg.type() !== "error") return;
  const text = msg.text();
  console.error("[renderer:console.error]", text);
  if (!isAllowed(text, ALLOWED_RENDERER_CONSOLE)) {
    errors.push(`Renderer console.error: ${text}`);
  }
});

await window.waitForLoadState("domcontentloaded", { timeout: TIMEOUT_MS });

const url = window.url();
console.log("Renderer URL:", url);
if (!/^app:\/\/labtrax\//.test(url)) {
  errors.push(`Expected renderer URL to start with app://labtrax/, got ${url}`);
}

const bridge = await window.evaluate(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = globalThis.electronAPI;
  if (!api) return null;
  return {
    keys: Object.keys(api).sort(),
    iteroKeys: api.itero ? Object.keys(api.itero).sort() : null,
    authKeys: api.auth ? Object.keys(api.auth).sort() : null,
    platformAdminKeys: api.platformAdmin ? Object.keys(api.platformAdmin).sort() : null,
  };
});

const EXPECTED_TOP = [
  "auth",
  "getAppVersion",
  "installUpdate",
  "itero",
  "onUpdateDownloadProgress",
  "onUpdateDownloaded",
  "platformAdmin",
];
const EXPECTED_ITERO = [
  "clearCredentials",
  "getStatus",
  "onStatus",
  "pollNow",
  "setApiConfig",
  "setAuthState",
  "setCredentials",
  "setEnabled",
  "testLogin",
];
const EXPECTED_AUTH = ["clearTokens", "getTokens", "isAvailable", "setTokens"];
const EXPECTED_PLATFORM_ADMIN = [
  "clearSecret",
  "getSecret",
  "getStatus",
  "onChanged",
  "setSecret",
  "testSecret",
];

function assertSubset(actual, expected, label) {
  if (!actual) {
    errors.push(`${label} not exposed by preload`);
    return;
  }
  const missing = expected.filter((k) => !actual.includes(k));
  if (missing.length) {
    errors.push(`${label} missing keys: ${missing.join(", ")}`);
  }
}

if (!bridge) {
  errors.push("window.electronAPI is not exposed — preload script may have crashed under contextIsolation");
} else {
  console.log("Preload bridge keys:", bridge.keys.join(", "));
  assertSubset(bridge.keys, EXPECTED_TOP, "electronAPI");
  assertSubset(bridge.iteroKeys, EXPECTED_ITERO, "electronAPI.itero");
  assertSubset(bridge.authKeys, EXPECTED_AUTH, "electronAPI.auth");
  assertSubset(
    bridge.platformAdminKeys,
    EXPECTED_PLATFORM_ADMIN,
    "electronAPI.platformAdmin",
  );
}

const version = await electronApp
  .evaluate(({ app }) => app.getVersion())
  .catch((err) => {
    errors.push(`Main-process app.getVersion() failed: ${err.message}`);
    return null;
  });
console.log("App version reported by main process:", version);

await electronApp.close();

if (errors.length > 0) {
  console.error("\n✗ Electron smoke test FAILED:");
  for (const e of errors) console.error("  -", e);
  process.exit(1);
}

console.log("\n✓ Electron smoke test passed");
