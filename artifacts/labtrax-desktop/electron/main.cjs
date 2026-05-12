const { app, BrowserWindow, protocol, net, dialog, ipcMain, Notification } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const iteroPoller = require("./itero-poller.cjs");
const platformAdmin = require("./platform-admin.cjs");
const authStore = require("./auth-store.cjs");

const isDev = process.env.ELECTRON_DEV === "1";

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
  }

  autoUpdater.on("checking-for-update", () => {
    log.info("Checking for updates…");
  });

  autoUpdater.on("update-available", (info) => {
    log.info(`Update available: v${info.version} — downloading in background`);
  });

  autoUpdater.on("update-not-available", () => {
    log.info("App is up to date.");
  });

  autoUpdater.on("download-progress", (progress) => {
    log.info(`Download progress: ${Math.round(progress.percent)}%`);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("update-download-progress", Math.round(progress.percent));
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

    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("update-downloaded", { version: info.version, releaseNotes });
    }
  });

  autoUpdater.on("error", (err) => {
    log.error("Auto-updater error:", err);
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

  if (!isDev) {
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

  win.setMenuBarVisibility(false);

  if (isDev) {
    const devPort = process.env.ELECTRON_DEV_PORT || "5173";
    win.loadURL(`http://localhost:${devPort}`);
    win.webContents.openDevTools();
  } else {
    win.loadURL("app://labtrax/index.html");
  }
}

ipcMain.handle("get-app-version", () => app.getVersion());

ipcMain.handle("install-update", () => {
  const { autoUpdater } = require("electron-updater");
  autoUpdater.quitAndInstall();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
