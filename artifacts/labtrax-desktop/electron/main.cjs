const {
  app,
  BrowserWindow,
  protocol,
  net,
  dialog,
  ipcMain,
  Notification,
  shell,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const {
  shouldUseAutoUpdater,
  resolveUpdateFeedUrl,
  manualInstallerDetails: getManualInstallerDetails,
} = require("./auto-updater-policy.cjs");
const { buildMetadataFromStamp } = require("./build-metadata.cjs");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");
const iteroPoller = require("./itero-poller.cjs");
const platformAdmin = require("./platform-admin.cjs");
const authStore = require("./auth-store.cjs");
const { downloadBackupToFolder } = require("./backup-download.cjs");

const isDev = process.env.ELECTRON_DEV === "1";

// --------------------------------------------------------------------------
// Authenticated media bridge origin allowlist
//
// The renderer runs from the custom `app://labtrax` protocol in production,
// so every protected media fetch to the hosted API is cross-origin and
// browser-like — it can fail on CORS, redirects, blob/object-URL creation,
// or dropped Authorization headers. The `media:fetch-authenticated` IPC
// handler below fetches those bytes from the main process instead (Electron
// `net.fetch`, which is not subject to renderer CORS) with the stored desktop
// bearer token.
//
// To make sure the bearer token can NEVER leak to a third-party host (a case
// note or attachment could carry an arbitrary URL), the main process only
// attaches the token to URLs whose origin matches the LabTrax API origin.
// We derive that origin the same way the renderer does (src/lib/api.ts):
// the build-time VITE_API_BASE_URL when present, otherwise the production
// fallback. In dev, localhost origins are also allowed.
const _MEDIA_PROD_API_FALLBACK = "https://lab-trax.replit.app";
const _MEDIA_CONFIGURED_ORIGIN = (process.env.VITE_API_BASE_URL || "").replace(
  /\/$/,
  "",
);
const _MEDIA_API_ORIGIN = _MEDIA_CONFIGURED_ORIGIN || _MEDIA_PROD_API_FALLBACK;

function isAllowedMediaUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }
  // Only http/https are ever fetched with the token. Reject file:, data:,
  // blob:, app:, etc. outright.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  try {
    if (parsed.origin === new URL(_MEDIA_API_ORIGIN).origin) return true;
  } catch {
    /* malformed configured origin — fall through */
  }
  if (isDev && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
    return true;
  }
  return false;
}

function registerMediaIpc() {
  ipcMain.handle("media:fetch-authenticated", async (_e, payload) => {
    const url = typeof payload === "string" ? payload : payload?.url;
    const selectionHeaders = payload && typeof payload === "object" && payload.headers
      ? payload.headers : {};
    if (typeof url !== "string" || !url) {
      return { ok: false, status: 0, error: "Invalid media URL." };
    }
    if (!isAllowedMediaUrl(url)) {
      // Refuse third-party / non-API origins so the bearer token stays private.
      return { ok: false, status: 0, error: "Refused: URL is not the LabTrax API origin." };
    }
    let tokens = null;
    try {
      tokens = authStore.getTokens();
    } catch {
      tokens = null;
    }
    const headers = {};
    if (tokens && tokens.accessToken) {
      headers["Authorization"] = `Bearer ${tokens.accessToken}`;
    }
    if (typeof selectionHeaders["x-provider-organization-id"] === "string") {
      headers["x-provider-organization-id"] = selectionHeaders["x-provider-organization-id"];
    }
    try {
      const res = await net.fetch(url, { headers });
      const arrayBuffer = await res.arrayBuffer();
      return {
        ok: res.ok,
        status: res.status,
        mimeType: res.headers.get("content-type") || "",
        buffer: Buffer.from(arrayBuffer),
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err && err.message ? String(err.message) : "Media fetch failed.",
      };
    }
  });
}

// Force the app's display name and dock icon as early as possible, before
// any window is created. macOS reads CFBundleName from Info.plist only for
// packaged .app bundles — when run unpackaged (dev, or our manually-staged
// portable copied to another machine), the dock label and dock icon fall
// back to "Electron" + the default atom icon. Setting app.name + dock.setIcon
// here makes the brand correct in every launch mode.
app.setName("LabTrax");
const BRAND_ICON_PATH = path.join(__dirname, "icon.png");
if (process.platform === "darwin" && app.dock) {
  try {
    app.dock.setIcon(BRAND_ICON_PATH);
  } catch {
    /* non-fatal */
  }
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function registerIteroIpc() {
  iteroPoller.init({
    onStatus: (status) => broadcast("itero:status", status),
  });

  ipcMain.handle("itero:get-status", () => iteroPoller.getStatus());
  ipcMain.handle("itero:set-credentials", (_e, payload) => {
    iteroPoller.setCredentials(payload || {});
    return iteroPoller.getStatus();
  });
  ipcMain.handle("itero:clear-credentials", () => {
    iteroPoller.clearCredentials();
    return iteroPoller.getStatus();
  });
  ipcMain.handle("itero:set-api-config", (_e, payload) => {
    iteroPoller.setApiConfig(payload || {});
    return iteroPoller.getStatus();
  });
  ipcMain.handle("itero:set-enabled", (_e, payload) => {
    const enabled = !!(payload && payload.enabled);
    const interval = payload && payload.intervalMin;
    iteroPoller.setEnabled(enabled, interval);
    return iteroPoller.getStatus();
  });
  ipcMain.handle("itero:test-login", () => iteroPoller.testLogin());
  ipcMain.handle("itero:poll-now", () => iteroPoller.pollNow());
  ipcMain.handle("itero:set-auth-state", (_e, payload) => {
    iteroPoller.setAuthState(!!(payload && payload.active));
    return iteroPoller.getStatus();
  });
}

function registerPlatformAdminIpc() {
  platformAdmin.init({
    onStatus: (status) => broadcast("platformAdmin:changed", status),
  });

  ipcMain.handle("platformAdmin:get-status", () => platformAdmin.getStatus());
  ipcMain.handle("platformAdmin:get-secret", () => platformAdmin.getSecret());
  ipcMain.handle("platformAdmin:set-secret", (_e, payload) => {
    const value = typeof payload === "string" ? payload : payload?.secret;
    platformAdmin.setSecret(value);
    return platformAdmin.getStatus();
  });
  ipcMain.handle("platformAdmin:clear-secret", () => {
    platformAdmin.clearSecret();
    return platformAdmin.getStatus();
  });
  ipcMain.handle("platformAdmin:test-secret", (_e, payload) => {
    const apiBaseUrl = typeof payload === "string" ? payload : payload?.apiBaseUrl;
    return platformAdmin.testSecret(apiBaseUrl);
  });
}

function registerAuthIpc() {
  ipcMain.handle("auth:get-tokens", () => authStore.getTokens());
  ipcMain.handle("auth:get-tokens-status", () => authStore.getTokensWithStatus());
  ipcMain.handle("auth:set-tokens", (_e, payload) => {
    authStore.setTokens(payload || {});
    return true;
  });
  ipcMain.handle("auth:clear-tokens", () => {
    authStore.clearTokens();
    return true;
  });
  ipcMain.handle("auth:is-available", () => authStore.isAvailable());
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const appDir = path.resolve(path.join(__dirname, "..", "dist", "electron-app"));
const DEFAULT_UPDATE_FEED_URL = `${_MEDIA_API_ORIGIN}/downloads/`;

function packagedBuildStamp() {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, "build-stamp.json"), "utf8"));
  } catch {
    // Older installs predate the build stamp. Preserve their existing updater
    // behavior; only a current build explicitly marked portable is fenced off.
    return null;
  }
}

function packagedUpdateChannel() {
  const stamp = packagedBuildStamp();
  return typeof stamp?.updateChannel === "string" ? stamp.updateChannel : null;
}

function resolvedUpdateFeedUrl() {
  const stamp = packagedBuildStamp();
  return resolveUpdateFeedUrl({
    runtimeOverride: process.env.UPDATE_FEED_URL,
    packagedFeed: stamp?.updateFeedUrl,
    fallback: DEFAULT_UPDATE_FEED_URL,
  });
}

function manualInstallerDetails() {
  return getManualInstallerDetails({
    isWindowsStore: process.windowsStore === true,
    platform: process.platform,
    feedUrl: resolvedUpdateFeedUrl(),
  });
}

// Live auto-updater state. Mutated by the autoUpdater event handlers,
// surfaced to the renderer through the `get-update-state` IPC handler and
// the broadcasted `update-state` channel, and read by `check-for-updates` /
// `download-update` so the UI can show check/download buttons that reflect
// reality (idle vs. checking vs. downloading vs. ready-to-install).
const updateState = {
  status: "idle", // idle | checking | available | not-available | downloading | downloaded | error
  lastCheckedAt: null, // ISO timestamp of the most recent check completion
  currentVersion: null, // populated lazily on first read so we don't depend on `app` at import time
  latestVersion: null, // version reported by `update-available` / `update-downloaded`
  downloadProgress: null, // 0..100 (rounded) during downloading; null otherwise
  releaseNotes: null, // normalised release notes for the downloaded build
  error: null, // last user-facing error string (cleared on next successful check)
  feedUrl: null, // populated when UPDATE_FEED_URL is set, for diagnostics
};

function patchUpdateState(patch) {
  Object.assign(updateState, patch);
  broadcast("update-state", { ...updateState });
}

function setupAutoUpdater() {
  const { autoUpdater } = require("electron-updater");
  const log = require("electron-log");

  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = "info";
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const feedUrl = resolvedUpdateFeedUrl();
  autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
  updateState.feedUrl = feedUrl;
  log.info(`Auto-updater using generic feed URL: ${feedUrl}`);

  autoUpdater.on("checking-for-update", () => {
    log.info("Checking for updates…");
    patchUpdateState({ status: "checking", error: null });
  });

  autoUpdater.on("update-available", (info) => {
    log.info(`Update available: v${info.version} — downloading in background`);
    patchUpdateState({
      status: "available",
      latestVersion: info.version ?? null,
      lastCheckedAt: new Date().toISOString(),
      error: null,
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    log.info("App is up to date.");
    patchUpdateState({
      status: "not-available",
      latestVersion: info?.version ?? null,
      lastCheckedAt: new Date().toISOString(),
      error: null,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    const pct = Math.round(progress.percent);
    log.info(`Download progress: ${pct}%`);
    patchUpdateState({ status: "downloading", downloadProgress: pct });
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("update-download-progress", pct);
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info(`Update downloaded: v${info.version}`);

    // Normalise releaseNotes: electron-updater may return a string, an array
    // of { version, note } objects, or null/undefined.
    let releaseNotes = null;
    if (typeof info.releaseNotes === "string" && info.releaseNotes.trim()) {
      releaseNotes = info.releaseNotes.trim();
    } else if (Array.isArray(info.releaseNotes) && info.releaseNotes.length > 0) {
      // Prefer the entry matching the downloaded version; fall back to the first.
      const match =
        info.releaseNotes.find((n) => n.version === info.version) ??
        info.releaseNotes[0];
      if (match && typeof match.note === "string" && match.note.trim()) {
        releaseNotes = match.note.trim();
      }
    }

    patchUpdateState({
      status: "downloaded",
      latestVersion: info.version ?? null,
      downloadProgress: 100,
      releaseNotes,
      error: null,
    });

    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("update-downloaded", { version: info.version, releaseNotes });
    }
  });

  autoUpdater.on("error", (err) => {
    log.error("Auto-updater error:", err);
    patchUpdateState({
      status: "error",
      error: err && err.message ? String(err.message) : String(err),
    });
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    log.warn("Update check failed (will retry):", err.message);
  });

  // Re-check every 4 hours while the app is open.
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      log.warn("Periodic update check failed:", err.message);
    });
  }, FOUR_HOURS_MS);
}

// Lazy-load autoUpdater inside the IPC handlers so dev-mode launches (which
// skip setupAutoUpdater) can still answer `get-update-state` / etc. cleanly.
function getAutoUpdaterOrNull() {
  if (
    !shouldUseAutoUpdater({
      isDev,
      isWindowsStore: process.windowsStore === true,
      skipAutoUpdater: process.env.LABTRAX_SKIP_AUTOUPDATER === "1",
      updateChannel: packagedUpdateChannel(),
    })
  ) {
    return null;
  }
  try {
    return require("electron-updater").autoUpdater;
  } catch {
    return null;
  }
}

function snapshotUpdateState() {
  const installer = manualInstallerDetails();
  return {
    ...updateState,
    currentVersion: app.getVersion(),
    autoUpdaterEnabled: getAutoUpdaterOrNull() !== null,
    isWindowsStore: process.windowsStore === true,
    isDevelopment: isDev,
    skipAutoUpdater: process.env.LABTRAX_SKIP_AUTOUPDATER === "1",
    updateChannel: packagedUpdateChannel(),
    manualInstallerUrl: installer.url,
    installerPlatform: installer.platform,
  };
}

// Stable reference to the primary application window used for IPC routing,
// focus-on-click, and notification delivery. Avoids relying on getAllWindows()[0]
// which may return a preview window or be ordered non-deterministically.
let mainWindow = null;
let localBackupScheduleActive = false;
let localBackupTray = null;
let isQuitting = false;

function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow();
}

function createLocalBackupTray() {
  if (localBackupTray) return true;
  if (typeof Tray !== "function" || !Menu?.buildFromTemplate || !nativeImage?.createFromPath) {
    return false;
  }
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png"));
    localBackupTray = new Tray(icon);
    localBackupTray.setToolTip("LabTrax backup companion");
    localBackupTray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open LabTrax", click: openMainWindow },
      { type: "separator" },
      {
        label: "Quit LabTrax",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]));
    localBackupTray.on("click", openMainWindow);
    return true;
  } catch (error) {
    localBackupTray = null;
    console.warn("[local-backup] system tray is unavailable", error);
    return false;
  }
}

function setLocalBackupLoginItem(enabled) {
  if (
    process.platform !== "win32" &&
    process.platform !== "darwin"
  ) return;
  if (typeof app.setLoginItemSettings !== "function") return;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: false,
    });
  } catch (error) {
    console.warn("[local-backup] could not update the per-user startup setting", error);
  }
}

function setLocalBackupScheduleActive(enabled) {
  localBackupScheduleActive = enabled === true;
  const trayAvailable = localBackupScheduleActive ? createLocalBackupTray() : Boolean(localBackupTray);
  if (localBackupScheduleActive && trayAvailable) {
    setLocalBackupLoginItem(true);
  } else if (!localBackupScheduleActive) {
    setLocalBackupLoginItem(false);
    // A schedule can be disabled from another signed-in session while this
    // window is hidden. Bring the app back so the user is not left without a
    // way to reopen or sign out.
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }
  return {
    active: localBackupScheduleActive,
    backgroundAvailable: !localBackupScheduleActive || trayAvailable,
  };
}

function showMainWindow() {
  openMainWindow();
}

function createTray() {
  return createLocalBackupTray();
}

app.whenReady().then(() => {
  if (process.env.LABTRAX_BACKUP_DOWNLOAD_SMOKE === "1") {
    const smokePath = path.join(
      app.getAppPath(),
      "scripts",
      "backup-download-smoke.cjs",
    );
    const { runPackagedBackupDownloadSmoke } = require(smokePath);
    runPackagedBackupDownloadSmoke({
      fetch: net.fetch.bind(net),
      downloadBackupToFolder,
      isAllowedUrl: isAllowedMediaUrl,
    }).then(
      () => {
        console.info("[backup-smoke] packaged Windows backup scenarios passed");
        app.exit(0);
      },
      (error) => {
        console.error("[backup-smoke] packaged backup scenario failed", error);
        app.exit(1);
      },
    );
    return;
  }

  if (!isDev) {
    protocol.handle("app", (req) => {
      const { pathname } = new URL(req.url);

      const decoded = decodeURIComponent(pathname);
      const normalized = path.normalize(decoded);
      const resolved = path.join(
        appDir,
        normalized === path.sep ? "index.html" : normalized,
      );

      if (!resolved.startsWith(appDir + path.sep) && resolved !== appDir) {
        return new Response("Not found", { status: 404 });
      }

      return net
        .fetch(pathToFileURL(resolved).toString())
        .catch(() =>
          net.fetch(pathToFileURL(path.join(appDir, "index.html")).toString()),
        );
    });
  }

  registerIteroIpc();
  registerPlatformAdminIpc();
  registerAuthIpc();
  registerMediaIpc();
  const loginSettings = typeof app.getLoginItemSettings === "function"
    ? app.getLoginItemSettings()
    : null;
  const startedForBackgroundBackup =
    loginSettings?.openAtLogin === true &&
    createLocalBackupTray();
  if (loginSettings?.openAtLogin === true && !startedForBackgroundBackup) {
    setLocalBackupLoginItem(false);
  }
  if (startedForBackgroundBackup) localBackupScheduleActive = true;
  createTray();
  createWindow({ hidden: startedForBackgroundBackup });

  if (
    shouldUseAutoUpdater({
      isDev,
      isWindowsStore: process.windowsStore === true,
      skipAutoUpdater: process.env.LABTRAX_SKIP_AUTOUPDATER === "1",
      updateChannel: packagedUpdateChannel(),
    })
  ) {
    setupAutoUpdater();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else openMainWindow();
  });
  app.on("before-quit", () => {
    isQuitting = true;
  });
});

function createWindow({ hidden = false } = {}) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    title: "LabTrax",
    icon: path.join(__dirname, "icon.png"),
    show: !hidden,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow = win;
  win.on("close", (event) => {
    if (localBackupTray && !isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Allow microphone access so the voice-mode recorder (getUserMedia + MediaRecorder)
  // works inside the renderer. Without this handler Electron silently denies the
  // media permission and the mic button shows "Microphone access is blocked".
  win.webContents.session?.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "microphone");
  });
  win.webContents.session?.setPermissionCheckHandler((_wc, permission) => {
    return permission === "media" || permission === "microphone";
  });

  win.setMenuBarVisibility(false);

  if (isDev) {
    const devPort = process.env.ELECTRON_DEV_PORT || "5173";
    win.loadURL(`http://localhost:${devPort}`);
    win.webContents.openDevTools();
  } else {
    // Load at the root path so window.location.pathname === "/" and the
    // wouter router matches the "/" route. Loading "/index.html" makes the
    // initial pathname "/index.html", which matches none of the configured
    // routes and falls through to NotFound (or, with stale base config,
    // renders nothing at all). The protocol handler already serves
    // index.html for the root path.
    win.loadURL("app://labtrax/");
  }
}

ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("get-build-metadata", () =>
  buildMetadataFromStamp(packagedBuildStamp(), app.getVersion()),
);

ipcMain.handle("messenger:notify", (_event, payload) => {
  const { conversationId, senderName, body } = payload ?? {};
  if (!conversationId || !Notification.isSupported()) return;

  const title = senderName ? `New message from ${senderName}` : "New message";
  const notif = new Notification({
    title,
    body: body ?? "",
    silent: false,
  });

  notif.on("click", () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("messenger:open-conversation", conversationId);
  });

  notif.show();
});

// Map from file path → BrowserWindow so we can focus instead of stacking duplicates.
const previewWindows = new Map();

ipcMain.handle("preview:open-file", async (_event, buffer, mimeType, fileKey, filename) => {
  const key = fileKey || `preview-${Date.now()}`;

  const existing = previewWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const ext = mimeType === "application/pdf" ? ".pdf"
    : mimeType.startsWith("image/") ? "." + mimeType.split("/")[1].split("+")[0]
    : ".bin";
  const tmpPath = path.join(os.tmpdir(), `labtrax-preview-${Date.now()}${ext}`);
  fs.writeFileSync(tmpPath, Buffer.from(buffer));

  const title = filename || "Document Preview";
  const win = new BrowserWindow({
    width: 750,
    height: 950,
    autoHideMenuBar: true,
    title,
  });

  previewWindows.set(key, win);

  win.on("closed", () => {
    previewWindows.delete(key);
    fs.unlink(tmpPath, () => {});
  });

  win.loadURL(pathToFileURL(tmpPath).toString());
});

ipcMain.handle("backup:save-to-folder", async (_event, { buffer, fileName, folderPath }) => {
  try {
    fs.mkdirSync(folderPath, { recursive: true });
    const dest = path.join(folderPath, fileName);
    fs.writeFileSync(dest, Buffer.from(buffer));
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

const backupDownloadWindows = new Set();
ipcMain.handle("backup:download-to-folder", async (event, request) => {
  if (backupDownloadWindows.has(event.sender.id)) {
    return { ok: false, error: "A local backup is already running in this window." };
  }
  backupDownloadWindows.add(event.sender.id);
  try {
    return await downloadBackupToFolder(request, {
      isAllowedUrl: isAllowedMediaUrl,
      fetch: net.fetch.bind(net),
      onRunId: (runId) => {
        if (!event.sender.isDestroyed()) event.sender.send("backup:run-id", runId);
      },
      log: (metrics) => console.info("[local-backup]", metrics),
    });
  } finally {
    backupDownloadWindows.delete(event.sender.id);
  }
});

ipcMain.handle("dialog:show-folder", async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win ?? undefined, {
    properties: ["openDirectory", "createDirectory"],
    title: "Select backup folder",
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("dialog:showOpenDialog", async (_event, opts) => {
  const win = BrowserWindow.getAllWindows()[0];
  const options = {
    title: opts?.title,
    filters: opts?.filters,
    properties: opts?.properties ?? ["openFile"],
  };
  const result = await dialog.showOpenDialog(win ?? undefined, options);
  return result.canceled ? null : result.filePaths;
});

ipcMain.handle("dialog:read-file", async (_event, filePath) => {
  if (typeof filePath !== "string" || !filePath) {
    return { ok: false, error: "Invalid file path." };
  }
  try {
    const buffer = fs.readFileSync(filePath);
    return { ok: true, buffer };
  } catch (err) {
    return { ok: false, error: err && err.message ? String(err.message) : "Failed to read file." };
  }
});

ipcMain.handle("shell:open-external", async (_event, url) => {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("install-update", () => {
  const { autoUpdater } = require("electron-updater");
  autoUpdater.quitAndInstall();
});

// User-initiated "Check for updates" — wraps autoUpdater.checkForUpdates()
// so the renderer can drive the same code path that runs on launch /
// every 4 h. We deliberately call checkForUpdates() (not
// checkForUpdatesAndNotify) here because the renderer is showing its own
// status UI; the system notification would be redundant.
ipcMain.handle("check-for-updates", async () => {
  const autoUpdater = getAutoUpdaterOrNull();
  if (!autoUpdater) {
    // Dev mode or autoupdater explicitly disabled — be honest about it
    // rather than silently faking a "not-available" reply.
    patchUpdateState({
      status: "error",
      error: "Auto-updates are disabled in this build (dev mode or LABTRAX_SKIP_AUTOUPDATER=1).",
    });
    return snapshotUpdateState();
  }
  try {
    patchUpdateState({ status: "checking", error: null });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    patchUpdateState({
      status: "error",
      error: err && err.message ? String(err.message) : String(err),
    });
  }
  return snapshotUpdateState();
});

// Manual "Download" trigger. With autoDownload=true the download already
// starts on `update-available`, so this is mostly a fallback for
// retry-after-error cases — but having it exposed means the UI can offer
// a "Retry download" button without reaching back to the main process for
// new IPC plumbing later.
ipcMain.handle("download-update", async () => {
  const autoUpdater = getAutoUpdaterOrNull();
  if (!autoUpdater) return snapshotUpdateState();
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    patchUpdateState({
      status: "error",
      error: err && err.message ? String(err.message) : String(err),
    });
  }
  return snapshotUpdateState();
});

ipcMain.handle("get-update-state", () => snapshotUpdateState());

ipcMain.on("app:relaunch", () => {
  isQuitting = true;
  app.relaunch();
  app.exit(0);
});

ipcMain.handle("backup:set-local-schedule-active", (event, enabled) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { active: false, backgroundAvailable: false };
  }
  return setLocalBackupScheduleActive(enabled === true);
});

ipcMain.handle("backup:is-folder-accessible", (event, folderPath) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || typeof folderPath !== "string") {
    return false;
  }
  const folder = folderPath.trim();
  if (!folder || !path.isAbsolute(folder)) return false;
  try {
    if (!fs.statSync(folder).isDirectory()) return false;
    fs.accessSync(folder, fs.constants.W_OK);
    return true;
  } catch {
    // Do not create missing directories here. In particular, a disconnected
    // USB target must not silently become a same-named folder on the system
    // disk.
    return false;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !localBackupScheduleActive && !isQuitting) {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  if (localBackupTray) {
    localBackupTray.destroy();
    localBackupTray = null;
  }
});
