"use strict";

/**
 * iTero "Lab Review" auto-import poller.
 *
 * Runs in the Electron main process. Maintains a hidden BrowserWindow with a
 * persistent session partition for the shared lab iTero account, periodically
 * pulls down Rx PDFs for cases in the "Lab Review" status, and POSTs each one
 * to the LabTrax API at /cases/import-from-itero-rx, where the server uses
 * OpenAI to extract patient/doctor/restoration fields and creates the case.
 *
 * Storage:
 *   userData/itero-creds.bin    — credentials encrypted with safeStorage
 *   userData/itero-config.json  — non-secret settings (enabled, intervalMin,
 *                                 apiBaseUrl, labOrganizationId,
 *                                 providerOrganizationId, lastPollAt,
 *                                 lastError, importedCount)
 *   userData/itero-seen.json    — local de-dup ledger (iTero order ids that
 *                                 have already been forwarded). The server
 *                                 also de-dups via itero_imported_orders, so
 *                                 this is just a fast local fence.
 *
 * NOTE on iTero portal specifics: us-labs.bff.cloud.myitero.com is a private
 * BFF behind a cookie session; the exact list/download endpoints are not
 * publicly documented and will need to be confirmed against a live login.
 * `pollLabReviewCases()` below is the single place that needs to know those
 * endpoints — it is written defensively so a bad selector / 404 surfaces as
 * a clear error in the Settings panel rather than crashing the app.
 */

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, session, safeStorage, net } = require("electron");

const ITERO_BASE_URL = "https://us-labs.bff.cloud.myitero.com";
const ITERO_LOGIN_URL = `${ITERO_BASE_URL}/login`;
const ITERO_PARTITION = "persist:itero";

const {
  DEFAULT_POLL_INTERVAL_MIN,
  MIN_POLL_INTERVAL_MIN,
  MAX_POLL_INTERVAL_MIN,
  LAB_REVIEW_STATUS_TOKENS,
  clampInterval,
  looksLikeLoginPage,
  normalizeStatusToken,
  isLabReviewOrder,
} = require("./itero-helpers.cjs");
const RECENT_IMPORTS_KEEP = 10;

let credsPath = null;
let configPath = null;
let seenPath = null;

let config = null;
let seenIds = new Set();
let pollTimer = null;
let pollInFlight = false;
let onStatusChange = () => {};
let iteroWindow = null;
let authActive = false;

function ensurePaths() {
  if (credsPath) return;
  const dir = app.getPath("userData");
  credsPath = path.join(dir, "itero-creds.bin");
  configPath = path.join(dir, "itero-config.json");
  seenPath = path.join(dir, "itero-seen.json");
}

function loadConfig() {
  ensurePaths();
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch {
    config = null;
  }
  if (!config || typeof config !== "object") {
    config = {};
  }
  config.enabled = !!config.enabled;
  config.intervalMin = clampInterval(config.intervalMin);
  config.apiBaseUrl = config.apiBaseUrl || "";
  config.labOrganizationId = config.labOrganizationId || "";
  config.providerOrganizationId = config.providerOrganizationId || "";
  config.lastPollAt = config.lastPollAt || null;
  config.lastError = config.lastError || null;
  config.importedCount = Number(config.importedCount) || 0;
  config.recentImports = Array.isArray(config.recentImports) ? config.recentImports.slice(-RECENT_IMPORTS_KEEP) : [];
  config.importedTodayDate = config.importedTodayDate || null;
  config.importedTodayCount = Number(config.importedTodayCount) || 0;

  try {
    if (fs.existsSync(seenPath)) {
      const arr = JSON.parse(fs.readFileSync(seenPath, "utf8"));
      seenIds = new Set(Array.isArray(arr) ? arr : []);
    }
  } catch {
    seenIds = new Set();
  }
}

function saveConfig() {
  ensurePaths();
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    console.error("[itero] failed to persist config:", err);
  }
}

function saveSeen() {
  ensurePaths();
  try {
    fs.writeFileSync(seenPath, JSON.stringify([...seenIds].slice(-1000)), "utf8");
  } catch {
    /* ignore */
  }
}

function emitStatus() {
  try {
    onStatusChange(getStatus());
  } catch {
    /* ignore */
  }
}

function setCredentials({ username, password }) {
  ensurePaths();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS keychain is unavailable — cannot safely store iTero credentials. " +
        "On Linux this requires a desktop session (gnome-keyring/kwallet).",
    );
  }
  if (!username || !password) {
    throw new Error("Username and password are required.");
  }
  const blob = safeStorage.encryptString(JSON.stringify({ username, password }));
  fs.writeFileSync(credsPath, blob);
  emitStatus();
}

function clearCredentials() {
  ensurePaths();
  if (fs.existsSync(credsPath)) fs.unlinkSync(credsPath);
  emitStatus();
}

function readCredentials() {
  ensurePaths();
  if (!fs.existsSync(credsPath)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS keychain is unavailable — cannot decrypt iTero credentials.");
  }
  const blob = fs.readFileSync(credsPath);
  try {
    const json = safeStorage.decryptString(blob);
    return JSON.parse(json);
  } catch (err) {
    throw new Error(`Failed to decrypt iTero credentials: ${err.message}`);
  }
}

function hasCredentials() {
  ensurePaths();
  return fs.existsSync(credsPath);
}

function setApiConfig({ apiBaseUrl, labOrganizationId, providerOrganizationId }) {
  if (!config) loadConfig();
  if (typeof apiBaseUrl === "string") config.apiBaseUrl = apiBaseUrl;
  if (typeof labOrganizationId === "string") config.labOrganizationId = labOrganizationId;
  if (typeof providerOrganizationId === "string") {
    config.providerOrganizationId = providerOrganizationId;
  }
  saveConfig();
  emitStatus();
}

function setEnabled(enabled, intervalMin) {
  if (!config) loadConfig();
  config.enabled = !!enabled;
  if (intervalMin != null) config.intervalMin = clampInterval(intervalMin);
  saveConfig();
  reschedule();
  emitStatus();
}

function getStatus() {
  if (!config) loadConfig();
  rolloverImportedToday();
  return {
    available: safeStorage.isEncryptionAvailable(),
    configured: hasCredentials(),
    enabled: !!config.enabled,
    intervalMin: config.intervalMin,
    apiBaseUrl: config.apiBaseUrl,
    labOrganizationId: config.labOrganizationId,
    providerOrganizationId: config.providerOrganizationId,
    lastPollAt: config.lastPollAt,
    lastError: config.lastError,
    importedCount: config.importedCount,
    importedToday: config.importedTodayCount,
    recentImports: config.recentImports,
    polling: pollInFlight,
    authActive,
  };
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rolloverImportedToday() {
  const today = todayStamp();
  if (config.importedTodayDate !== today) {
    config.importedTodayDate = today;
    config.importedTodayCount = 0;
  }
}

function recordImport(entry) {
  rolloverImportedToday();
  config.importedCount = (config.importedCount || 0) + 1;
  config.importedTodayCount = (config.importedTodayCount || 0) + 1;
  config.recentImports = [
    {
      iteroOrderId: entry.iteroOrderId,
      caseId: entry.caseId || null,
      caseNumber: entry.caseNumber || null,
      importedAt: new Date().toISOString(),
    },
    ...(config.recentImports || []),
  ].slice(0, RECENT_IMPORTS_KEEP);
}

function setAuthState(active) {
  authActive = !!active;
  if (!authActive && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  } else if (authActive && config?.enabled && !pollTimer) {
    reschedule();
  }
  emitStatus();
}

function reschedule() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!config?.enabled) return;
  if (!authActive) return; // never poll when no LabTrax user is signed in
  const ms = config.intervalMin * 60 * 1000;
  pollTimer = setInterval(() => {
    pollNow().catch((err) => console.error("[itero] scheduled poll failed:", err));
  }, ms);
}

async function readLabtraxCsrfToken() {
  try {
    const cookies = await session.defaultSession.cookies.get({ name: "lt_csrf" });
    if (cookies.length > 0) return cookies[0].value;
  } catch {
    /* ignore */
  }
  return null;
}

async function getOrCreateIteroWindow() {
  if (iteroWindow && !iteroWindow.isDestroyed()) return iteroWindow;
  iteroWindow = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      partition: ITERO_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  iteroWindow.on("closed", () => {
    iteroWindow = null;
  });
  return iteroWindow;
}

async function ensureLoggedIn() {
  const creds = readCredentials();
  if (!creds) throw new Error("iTero credentials are not set.");

  const win = await getOrCreateIteroWindow();
  const sess = session.fromPartition(ITERO_PARTITION);

  // Heuristic session check: hit a known authenticated endpoint and look for
  // a redirect-to-login. If iTero responds with the login page or 401/403,
  // we re-authenticate.
  const probe = await sess.fetch(`${ITERO_BASE_URL}/api/orders?status=labReview&limit=1`).catch(() => null);
  if (probe && probe.ok && !looksLikeLoginPage(await peekText(probe))) {
    return { window: win, session: sess };
  }

  // Drive the login form via the hidden window.
  await win.loadURL(ITERO_LOGIN_URL);
  await waitForLoad(win);

  // The exact selectors below depend on the iTero portal markup; if they
  // change, the executeJavaScript call will throw and surface as lastError
  // in the Settings panel. Replace these with the actual input selectors
  // discovered via DevTools the first time.
  const result = await win.webContents.executeJavaScript(
    `
    (async () => {
      function q(sel) { return document.querySelector(sel); }
      const userInput =
        q('input[name="username"]') ||
        q('input[name="email"]') ||
        q('input[type="email"]') ||
        q('input[autocomplete="username"]');
      const passInput =
        q('input[name="password"]') ||
        q('input[type="password"]') ||
        q('input[autocomplete="current-password"]');
      if (!userInput || !passInput) {
        return { ok: false, error: "Could not find iTero login fields" };
      }
      const setVal = (el, v) => {
        const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
        proto.set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      setVal(userInput, ${JSON.stringify(creds.username)});
      setVal(passInput, ${JSON.stringify(creds.password)});
      const submitBtn =
        q('button[type="submit"]') ||
        q('input[type="submit"]') ||
        q('button[name="signin"]') ||
        q('button[data-testid="login-submit"]');
      if (!submitBtn) return { ok: false, error: "Could not find iTero login submit button" };
      submitBtn.click();
      return { ok: true };
    })();
    `,
    true,
  );
  if (!result?.ok) {
    throw new Error(result?.error || "iTero login failed");
  }

  // Wait briefly for the login XHR / redirect to settle.
  await sleep(4000);

  const recheck = await sess.fetch(`${ITERO_BASE_URL}/api/orders?status=labReview&limit=1`).catch(() => null);
  if (!recheck || !recheck.ok || looksLikeLoginPage(await peekText(recheck))) {
    throw new Error("iTero login appears to have failed (still seeing the login page).");
  }
  return { window: win, session: sess };
}

async function peekText(response) {
  try {
    const clone = response.clone();
    return await clone.text();
  } catch {
    return "";
  }
}

async function listLabReviewOrders(sess) {
  // The exact list endpoint may differ — adjust if the operator's iTero
  // tenant exposes a different path. We accept either { orders: [...] } or
  // a bare array, and tolerate {id, orderId, caseId} naming variants.
  // Each row is then strictly re-validated locally via isLabReviewOrder()
  // so a misbehaving endpoint cannot return non-Lab-Review orders for import.
  const candidates = [
    `${ITERO_BASE_URL}/api/orders?status=labReview&limit=50`,
    `${ITERO_BASE_URL}/api/lab/orders?status=labReview&limit=50`,
    `${ITERO_BASE_URL}/api/cases?status=labReview&limit=50`,
  ];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const res = await sess.fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        lastErr = new Error(`${url} → HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      const orders = Array.isArray(json) ? json : json.orders || json.items || json.data || [];
      const totalReturned = orders.length;
      const filtered = orders
        .filter((o) => isLabReviewOrder(o))
        .map((o) => ({
          id: String(o.id ?? o.orderId ?? o.caseId ?? o.uuid ?? ""),
          rxUrl: o.rxUrl || o.rxPdfUrl || o.rxDownloadUrl || null,
          raw: o,
        }))
        .filter((o) => o.id);
      const droppedNonLabReview = totalReturned - orders.filter((o) => isLabReviewOrder(o)).length;
      // Diagnostic log — helps the operator see which endpoint succeeded
      // and how many rows were filtered out as non-Lab-Review.
      // eslint-disable-next-line no-console
      console.log(
        `[itero-poller] list endpoint OK: ${url} (returned=${totalReturned}, ` +
        `keptLabReview=${filtered.length}, droppedNonLabReview=${droppedNonLabReview})`
      );
      return filtered;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("No iTero list endpoint responded with JSON.");
}

async function downloadRx(sess, order) {
  const url = order.rxUrl || `${ITERO_BASE_URL}/api/orders/${encodeURIComponent(order.id)}/rx`;
  const res = await sess.fetch(url, { headers: { Accept: "application/pdf,application/octet-stream,*/*" } });
  if (!res.ok) throw new Error(`Rx download for order ${order.id} failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || "application/pdf";
  const ext = ct.includes("pdf") ? "pdf" : ct.includes("png") ? "png" : ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : "pdf";
  return { buffer: buf, contentType: ct, filename: `itero-rx-${order.id}.${ext}` };
}

async function uploadToLabTrax(order, file) {
  if (!authActive) throw new Error("No LabTrax user is signed in on this machine.");
  if (!config?.apiBaseUrl) throw new Error("LabTrax API base URL is not configured.");
  if (!config.labOrganizationId) throw new Error("LabTrax lab organization id is not configured.");
  if (!config.providerOrganizationId) throw new Error("LabTrax provider organization id is not configured.");

  const csrf = await readLabtraxCsrfToken();
  if (!csrf) {
    throw new Error("LabTrax CSRF token not found — please sign in to LabTrax in this window first.");
  }

  const url = `${config.apiBaseUrl.replace(/\/$/, "")}/cases/import-from-itero-rx`;
  const boundary = `----LabTraxIteroBoundary${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts = [];

  const pushField = (name, value) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
  };
  pushField("iteroOrderId", order.id);
  pushField("labOrganizationId", config.labOrganizationId);
  pushField("providerOrganizationId", config.providerOrganizationId);
  pushField("source", "itero");

  // Field name MUST be "file" — the API uses iteroImportUpload.single("file").
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      "utf8",
    ),
  );
  parts.push(file.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  const body = Buffer.concat(parts);

  // Reuse the renderer's session cookies AND its CSRF token so the import
  // call is authenticated as the currently signed-in admin user.
  const res = await net.fetch(url, {
    method: "POST",
    body,
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      Accept: "application/json",
      "X-CSRF-Token": csrf,
    },
    useSessionCookies: true,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LabTrax import failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function pollNow() {
  if (!authActive) return { ok: false, error: "No LabTrax user is signed in." };
  if (pollInFlight) return { ok: false, error: "A poll is already in progress." };
  pollInFlight = true;
  emitStatus();

  let imported = 0;
  let skipped = 0;
  try {
    const { session: sess } = await ensureLoggedIn();
    const orders = await listLabReviewOrders(sess);
    for (const order of orders) {
      if (seenIds.has(order.id)) {
        skipped++;
        continue;
      }
      try {
        const file = await downloadRx(sess, order);
        const result = await uploadToLabTrax(order, file);
        // API responses use a `{ ok, data }` envelope.
        const payload = (result && typeof result === "object" && "data" in result)
          ? result.data
          : result;
        seenIds.add(order.id);
        if (payload?.deduped) {
          skipped++;
        } else {
          imported++;
          recordImport({
            iteroOrderId: order.id,
            caseId: payload?.caseId || null,
            caseNumber: payload?.caseNumber || null,
          });
        }
      } catch (err) {
        console.error(`[itero] order ${order.id} failed:`, err);
        // keep going; do NOT add to seenIds so we retry next poll
      }
    }
    config.lastPollAt = new Date().toISOString();
    config.lastError = null;
    saveConfig();
    saveSeen();
    return { ok: true, imported, skipped, total: orders.length };
  } catch (err) {
    config.lastPollAt = new Date().toISOString();
    config.lastError = String(err?.message || err);
    saveConfig();
    return { ok: false, error: config.lastError };
  } finally {
    pollInFlight = false;
    emitStatus();
  }
}

async function testLogin() {
  try {
    await ensureLoggedIn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function waitForLoad(win) {
  return new Promise((resolve) => {
    const done = () => {
      win.webContents.removeListener("did-finish-load", done);
      win.webContents.removeListener("did-fail-load", done);
      resolve();
    };
    win.webContents.once("did-finish-load", done);
    win.webContents.once("did-fail-load", done);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function init({ onStatus } = {}) {
  if (typeof onStatus === "function") onStatusChange = onStatus;
  loadConfig();
  reschedule();
  emitStatus();
}

module.exports = {
  init,
  setCredentials,
  clearCredentials,
  hasCredentials,
  setApiConfig,
  setEnabled,
  setAuthState,
  getStatus,
  pollNow,
  testLogin,
};
