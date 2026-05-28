const { app, BrowserWindow, protocol, net, dialog, ipcMain, Notification, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");
const iteroPoller = require("./itero-poller.cjs");
const platformAdmin = require("./platform-admin.cjs");
const authStore = require("./auth-store.cjs");

const isDev = process.env.ELECTRON_DEV === "1";

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

  const feedUrl = process.env.UPDATE_FEED_URL;
  if (feedUrl) {
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    updateState.feedUrl = feedUrl;
  }

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
  if (isDev || process.env.LABTRAX_SKIP_AUTOUPDATER === "1") return null;
  try {
    return require("electron-updater").autoUpdater;
  } catch {
    return null;
  }
}

function snapshotUpdateState() {
  return {
    ...updateState,
    currentVersion: app.getVersion(),
    autoUpdaterEnabled: getAutoUpdaterOrNull() !== null,
  };
}

// Stable reference to the primary application window used for IPC routing,
// focus-on-click, and notification delivery. Avoids relying on getAllWindows()[0]
// which may return a preview window or be ordered non-deterministically.
let mainWindow = null;

app.whenReady().then(() => {
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
  createWindow();

  if (!isDev && process.env.LABTRAX_SKIP_AUTOUPDATER !== "1") {
    setupAutoUpdater();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    title: "LabTrax",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
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
  app.relaunch();
  app.exit(0);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
