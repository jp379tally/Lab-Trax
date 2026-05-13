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
const whenReadyPromise = new Promise<void>((r) => {
  whenReadyResolve = r;
});

function injectModule(name: string, exports: unknown) {
  const filename = path.join(tmpDir, `__virt_${name.replace(/[^a-z0-9]/gi, "_")}.cjs`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  const fakeWindow = {
    webContents: fakeWebContents,
    isDestroyed: () => false,
    loadURL: () => {},
    setMenuBarVisibility: () => {},
  };

  electronMock = installElectronMock({
    app: {
      getPath: () => tmpDir,
      whenReady: () => whenReadyPromise,
      on: () => {},
      quit: () => {},
      getVersion: () => "1.2.3",
    },
    BrowserWindow: Object.assign(
      function BrowserWindow() {
        return fakeWindow;
      } as unknown as ElectronMock["BrowserWindow"],
      { getAllWindows: () => [fakeWindow] },
    ),
  });

  injectModule("electron-updater", { autoUpdater: updater });
  injectModule("electron-log", log);

  // Force-bypass dev mode so setupAutoUpdater() actually runs.
  process.env.ELECTRON_DEV = "0";
  delete process.env.UPDATE_FEED_URL;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
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

  it("kicks off an initial update check", () => {
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalled();
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
});
