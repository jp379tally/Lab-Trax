const { app, BrowserWindow, protocol, net, dialog, ipcMain, Notification } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

const isDev = process.env.ELECTRON_DEV === "1";

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

    if (Notification.isSupported()) {
      const notif = new Notification({
        title: "LabTrax Update Ready",
        body: `v${info.version} has been downloaded. Click to restart and install.`,
        silent: false,
      });

      notif.on("click", () => {
        autoUpdater.quitAndInstall();
      });

      notif.show();
    } else {
      dialog
        .showMessageBox({
          type: "info",
          title: "Update Ready",
          message: `LabTrax v${info.version} has been downloaded.`,
          detail:
            "Restart the app now to apply the update, or continue and it will be applied on the next launch.",
          buttons: ["Restart Now", "Later"],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0) {
            autoUpdater.quitAndInstall();
          }
        });
    }
  });

  autoUpdater.on("error", (err) => {
    log.error("Auto-updater error:", err);
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    log.warn("Update check failed (will retry on next launch):", err.message);
  });
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
