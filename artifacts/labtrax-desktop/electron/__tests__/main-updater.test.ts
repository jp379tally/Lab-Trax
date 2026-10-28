import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Module from "node:module";
import { installElectronMock, uninstallElectronMock, type ElectronMock } from "./_mock-electron";

/**
 * Loads `electron/main.cjs` with `electron`, `electron-updater`, and
 * `electron-log` swapped out via `require.cache`. Captures the auto-updater
 * event handlers and the renderer messages broadcast through
 * `webContents.send` so the test can drive each handler with the various
 * `releaseNotes` shapes that `electron-updater` may emit.
 */

type Listener = (...args: unknown[]) => void;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "labtrax-main-test-"));

const updaterListeners = new Map<string, Listener[]>();
const updater = {
  logger: undefined as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  setFeedURL: vi.fn(),
  on: (event: string, fn: Listener) => {
    const arr = updaterListeners.get(event) ?? [];
    arr.push(fn);
    updaterListeners.set(event, arr);
  },
  checkForUpdatesAndNotify: vi.fn(() => Promise.resolve()),
  checkForUpdates: vi.fn(() => Promise.resolve()),
  downloadUpdate: vi.fn(() => Promise.resolve()),
  quitAndInstall: vi.fn(),
};

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  transports: { file: { level: "info" } },
};

const sentMessages: Array<{ channel: string; payload: unknown }> = [];
let electronMock: ElectronMock;
let whenReadyResolve: () => void;
const appListeners = new Map<string, Listener>();
const windowListeners = new Map<string, Listener>();
const trayListeners = new Map<string, Listener>();
let fakeWindow: Record<string, any>;
let trayMenu: Array<Record<string, unknown>> = [];
let trayClick: (() => void) | undefined;
let trayDestroyed = false;
let trayTooltip = "";
let windowHidden = false;
let windowShown = false;
let windowFocused = false;
const whenReadyPromise = new Promise<void>((r) => {
  whenReadyResolve = r;
});

function injectModule(name: string, exports: unknown) {
  const filename = path.join(tmpDir, `__virt_${name.replace(/[^a-z0-9]/gi, "_")}.cjs`);
  (require.cache as any)[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
    children: [],
    paths: [],
    path: tmpDir,
    parent: null,
  };
  const M = Module as any;
  const origResolve = M._resolveFilename;
  M._resolveFilename = function patched(request: string, ...rest: unknown[]) {
    if (request === name) return filename;
    return origResolve.call(this, request, ...rest);
  };
}

beforeAll(async () => {
  // Use a fake window so broadcast() captures the messages.
  const fakeWebContents = {
    send: (channel: string, payload: unknown) => {
      sentMessages.push({ channel, payload });
    },
    openDevTools: () => {},
  };
  let visible = true;
  fakeWindow = {
    webContents: fakeWebContents,
    isDestroyed: () => false,
    isVisible: () => visible,
    loadURL: () => {},
    setMenuBarVisibility: () => {},
    on: (event: string, listener: Listener) => { windowListeners.set(event, listener); },
    once: () => {},
    show: () => { visible = true; windowShown = true; windowHidden = false; },
    focus: () => { windowFocused = true; },
    hide: () => { visible = false; windowHidden = true; },
    isMinimized: () => false,
    close: () => {},
  };

  electronMock = installElectronMock({
    app: {
      getPath: () => tmpDir,
      whenReady: () => whenReadyPromise,
      on: (event: string, fn: Listener) => { appListeners.set(event, fn); },
      quit: vi.fn(),
      getVersion: () => "1.2.3",
      getLoginItemSettings: () => ({ openAtLogin: false, wasOpenedAtLogin: false }),
      setLoginItemSettings: vi.fn(),
    },
    BrowserWindow: Object.assign(
      function BrowserWindow() {
        return fakeWindow;
      } as unknown as ElectronMock["BrowserWindow"],
      { getAllWindows: () => [fakeWindow] },
    ),
    Tray: class {
      on(event: string, listener: Listener) {
        trayListeners.set(event, listener);
        if (event === "click") trayClick = listener as () => void;
      }
      setToolTip(text: string) { trayTooltip = text; }
      setContextMenu(menu: unknown) { trayMenu = menu as Array<Record<string, unknown>>; }
      destroy() { trayDestroyed = true; }
    },
    Menu: {
      buildFromTemplate: (items: Array<Record<string, unknown>>) => {
        trayMenu = items;
        return items;
      },
    },
    nativeImage: { createFromPath: () => ({}) },
  });

  injectModule("electron-updater", { autoUpdater: updater });
  injectModule("electron-log", log);

  // Force-bypass dev mode so setupAutoUpdater() actually runs.
  process.env.ELECTRON_DEV = "0";
  delete process.env.UPDATE_FEED_URL;

  require("../main.cjs");
  whenReadyResolve();
  // Let the whenReady().then(...) chain run.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
});

afterAll(() => {
  uninstallElectronMock();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function emit(event: string, ...args: unknown[]) {
  const arr = updaterListeners.get(event) ?? [];
  for (const fn of arr) fn(...args);
}

function lastDownloaded() {
  for (let i = sentMessages.length - 1; i >= 0; i--) {
    if (sentMessages[i].channel === "update-downloaded") return sentMessages[i].payload as {
      version: string;
      releaseNotes: string | null;
    };
  }
  return null;
}

describe("auto-updater wiring in main.cjs", () => {
  it("registers the expected lifecycle handlers", () => {
    expect(updaterListeners.has("checking-for-update")).toBe(true);
    expect(updaterListeners.has("update-available")).toBe(true);
    expect(updaterListeners.has("update-not-available")).toBe(true);
    expect(updaterListeners.has("download-progress")).toBe(true);
    expect(updaterListeners.has("update-downloaded")).toBe(true);
    expect(updaterListeners.has("error")).toBe(true);
  });

  it("keeps the signed-in backup companion running when the window is closed", () => {
    expect(trayTooltip).toMatch(/backup companion/i);
    const close = windowListeners.get("close");
    expect(close).toBeTypeOf("function");
    const closeEvent = { preventDefault: vi.fn() };
    close?.(closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(windowHidden).toBe(true);

    trayListeners.get("click")?.();
    expect(windowShown).toBe(true);
    expect(windowFocused).toBe(true);

    const quit = trayMenu.find((item) => item.label === "Quit LabTrax")?.click as (() => void) | undefined;
    expect(quit).toBeTypeOf("function");
    quit?.();
    expect(electronMock.app.quit).toHaveBeenCalledOnce();
    appListeners.get("before-quit")?.();
    const finalCloseEvent = { preventDefault: vi.fn() };
    close?.(finalCloseEvent);
    expect(finalCloseEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("kicks off an initial update check", () => {
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalled();
  });

  it("uses the stable API generic feed when no packaged feed URL is available", () => {
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://lab-trax.replit.app/downloads/",
    });
  });

  it("forwards rounded download-progress percentages to the renderer", () => {
    sentMessages.length = 0;
    emit("download-progress", { percent: 42.6 });
    const msgs = sentMessages.filter((m) => m.channel === "update-download-progress");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload).toBe(43);
  });

  it("does not crash on a string releaseNotes value and forwards it trimmed", () => {
    sentMessages.length = 0;
    emit("update-downloaded", { version: "1.2.4", releaseNotes: "   Fixed a bug.   " });
    expect(lastDownloaded()).toEqual({ version: "1.2.4", releaseNotes: "Fixed a bug." });
  });

  it("treats an empty/whitespace string releaseNotes as null", () => {
    sentMessages.length = 0;
    emit("update-downloaded", { version: "1.2.4", releaseNotes: "   " });
    expect(lastDownloaded()).toEqual({ version: "1.2.4", releaseNotes: null });
  });

  it("treats null/undefined releaseNotes as null", () => {
    sentMessages.length = 0;
    emit("update-downloaded", { version: "1.2.4", releaseNotes: null });
    expect(lastDownloaded()).toEqual({ version: "1.2.4", releaseNotes: null });

    sentMessages.length = 0;
    emit("update-downloaded", { version: "1.2.4" });
    expect(lastDownloaded()).toEqual({ version: "1.2.4", releaseNotes: null });
  });

  it("picks the array entry whose version matches the downloaded build", () => {
    sentMessages.length = 0;
    emit("update-downloaded", {
      version: "1.2.4",
      releaseNotes: [
        { version: "1.2.3", note: "Old notes" },
        { version: "1.2.4", note: "  Matching notes  " },
        { version: "1.2.5", note: "Future notes" },
      ],
    });
    expect(lastDownloaded()).toEqual({ version: "1.2.4", releaseNotes: "Matching notes" });
  });

  it("falls back to the first array entry when no version matches", () => {
    sentMessages.length = 0;
    emit("update-downloaded", {
      version: "9.9.9",
      releaseNotes: [
        { version: "1.2.3", note: "First entry" },
        { version: "1.2.4", note: "Second entry" },
      ],
    });
    expect(lastDownloaded()).toEqual({ version: "9.9.9", releaseNotes: "First entry" });
  });

  it("handles an empty array of release notes by sending null", () => {
    sentMessages.length = 0;
    emit("update-downloaded", { version: "1.2.4", releaseNotes: [] });
    expect(lastDownloaded()).toEqual({ version: "1.2.4", releaseNotes: null });
  });

  it("handles array entries with missing/empty notes by sending null", () => {
    sentMessages.length = 0;
    emit("update-downloaded", {
      version: "1.2.4",
      releaseNotes: [{ version: "1.2.4", note: "   " }],
    });
    expect(lastDownloaded()).toEqual({ version: "1.2.4", releaseNotes: null });

    sentMessages.length = 0;
    emit("update-downloaded", {
      version: "1.2.4",
      releaseNotes: [{ version: "1.2.4" } as unknown],
    });
    expect(lastDownloaded()).toEqual({ version: "1.2.4", releaseNotes: null });
  });

  it("handles object-shaped releaseNotes (which we currently coerce to null) without throwing", () => {
    sentMessages.length = 0;
    expect(() =>
      emit("update-downloaded", {
        version: "1.2.4",
        releaseNotes: { html: "<p>hi</p>" } as unknown,
      }),
    ).not.toThrow();
    expect(lastDownloaded()).toEqual({ version: "1.2.4", releaseNotes: null });
  });

  it("logs (but does not throw) when the auto-updater emits an error", () => {
    log.error.mockClear();
    expect(() => emit("error", new Error("network down"))).not.toThrow();
    expect(log.error).toHaveBeenCalled();
  });

  it("install-update IPC handler triggers quitAndInstall", () => {
    const handler = electronMock.ipcMain.handlers.get("install-update");
    expect(handler).toBeTypeOf("function");
    handler?.();
    expect(updater.quitAndInstall).toHaveBeenCalled();
  });

  it("get-app-version IPC handler returns the mocked app version", () => {
    const handler = electronMock.ipcMain.handlers.get("get-app-version");
    expect(handler).toBeTypeOf("function");
    expect(handler?.()).toBe("1.2.3");
  });

  it("returns only the safe build metadata fields through IPC", () => {
    const handler = electronMock.ipcMain.handlers.get("get-build-metadata");
    expect(handler).toBeTypeOf("function");
    const metadata = handler?.() as Record<string, unknown>;
    expect(metadata.version).toBe("1.2.3");
    expect(Object.keys(metadata).sort()).toEqual(["buildNumber", "updateChannel", "version"]);
    expect(JSON.stringify(metadata)).not.toContain("feed");
  });

  it("get-update-state IPC handler returns a snapshot with the current version", () => {
    const handler = electronMock.ipcMain.handlers.get("get-update-state");
    expect(handler).toBeTypeOf("function");
    const snapshot = handler?.() as { currentVersion: string; status: string; autoUpdaterEnabled: boolean };
    expect(snapshot.currentVersion).toBe("1.2.3");
    expect(typeof snapshot.status).toBe("string");
    expect(snapshot.autoUpdaterEnabled).toBe(true);
    expect(snapshot.isWindowsStore).toBe(false);
    expect(snapshot.feedUrl).toBe("https://lab-trax.replit.app/downloads/");
  });

  it("check-for-updates IPC handler invokes autoUpdater.checkForUpdates and returns state", async () => {
    updater.checkForUpdates.mockClear();
    const handler = electronMock.ipcMain.handlers.get("check-for-updates");
    expect(handler).toBeTypeOf("function");
    const result = (await handler?.()) as { currentVersion: string };
    expect(updater.checkForUpdates).toHaveBeenCalled();
    expect(result.currentVersion).toBe("1.2.3");
  });

  it("download-update IPC handler invokes autoUpdater.downloadUpdate", async () => {
    updater.downloadUpdate.mockClear();
    const handler = electronMock.ipcMain.handlers.get("download-update");
    expect(handler).toBeTypeOf("function");
    await handler?.();
    expect(updater.downloadUpdate).toHaveBeenCalled();
  });

  it("broadcasts update-state on lifecycle events", () => {
    sentMessages.length = 0;
    emit("update-available", { version: "2.0.0" });
    const stateMsg = sentMessages.find((m) => m.channel === "update-state");
    expect(stateMsg).toBeDefined();
    expect((stateMsg!.payload as { status: string }).status).toBe("available");
    expect((stateMsg!.payload as { latestVersion: string }).latestVersion).toBe("2.0.0");
  });

  it("configures and disables the user-scoped backup schedule through IPC", () => {
    const setActive = electronMock.ipcMain.handlers.get("backup:set-local-schedule-active");
    expect(setActive).toBeTypeOf("function");
    const result = setActive?.(
      { sender: fakeWindow.webContents },
      true,
    ) as { active: boolean; backgroundAvailable: boolean };

    expect(result).toEqual({ active: true, backgroundAvailable: true });
    expect(trayMenu.map((item) => item.label)).toContain("Open LabTrax");
    expect(trayMenu.map((item) => item.label)).toContain("Quit LabTrax");

    trayClick?.();
    expect(fakeWindow.isVisible()).toBe(true);

    const disabled = setActive?.(
      { sender: fakeWindow.webContents },
      false,
    ) as { active: boolean; backgroundAvailable: boolean };
    expect(disabled).toEqual({ active: false, backgroundAvailable: true });
    expect(trayDestroyed).toBe(false);
  });

  it("rejects schedule companion control from a non-main renderer", () => {
    const setActive = electronMock.ipcMain.handlers.get("backup:set-local-schedule-active");
    expect(setActive?.({ sender: {} }, true)).toEqual({
      active: false,
      backgroundAvailable: false,
    });
  });

  it("checks local scheduled-backup destinations without creating missing folders", () => {
    const check = electronMock.ipcMain.handlers.get("backup:is-folder-accessible");
    expect(check).toBeTypeOf("function");
    const event = { sender: fakeWindow.webContents };
    expect(check?.(event, tmpDir)).toBe(true);
    expect(check?.(event, path.join(tmpDir, "not-created"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "not-created"))).toBe(false);
    expect(check?.({ sender: {} }, tmpDir)).toBe(false);
  });
});
