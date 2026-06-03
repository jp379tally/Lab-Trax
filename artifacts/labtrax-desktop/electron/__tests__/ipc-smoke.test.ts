import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Module from "node:module";
import { installElectronMock, uninstallElectronMock, type ElectronMock } from "./_mock-electron";

/**
 * Smoke-tests the Electron main-process startup: loads `electron/main.cjs`
 * with stubbed Electron, electron-updater, and electron-log modules, lets
 * `app.whenReady().then(...)` run, and asserts that:
 *   1. Loading + the whenReady chain do not throw.
 *   2. Every expected IPC channel was registered exactly once.
 *
 * If a future change accidentally drops or duplicates a channel, or throws
 * during init, this catches it before the change ships.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "labtrax-ipc-smoke-"));

const EXPECTED_CHANNELS = [
  // itero
  "itero:get-status",
  "itero:set-credentials",
  "itero:clear-credentials",
  "itero:set-api-config",
  "itero:set-enabled",
  "itero:test-login",
  "itero:poll-now",
  "itero:set-auth-state",
  // platform-admin
  "platformAdmin:get-status",
  "platformAdmin:get-secret",
  "platformAdmin:set-secret",
  "platformAdmin:clear-secret",
  "platformAdmin:test-secret",
  // auth tokens
  "auth:get-tokens",
  "auth:get-tokens-status",
  "auth:set-tokens",
  "auth:clear-tokens",
  "auth:is-available",
  // app-level
  "get-app-version",
  "install-update",
  "check-for-updates",
  "download-update",
  "get-update-state",
  "messenger:notify",
  "preview:open-file",
  "backup:save-to-folder",
  "dialog:show-folder",
  "dialog:showOpenDialog",
  "dialog:read-file",
  "shell:open-external",
];

let electronMock: ElectronMock;
const handleCalls: string[] = [];

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
  const orig = M._resolveFilename;
  M._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === name) return filename;
    return orig.call(this, request, ...rest);
  };
}

beforeAll(async () => {
  process.env.ELECTRON_DEV = "0";
  delete process.env.UPDATE_FEED_URL;

  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  electronMock = installElectronMock({
    app: {
      getPath: () => tmpDir,
      whenReady: () => Promise.resolve(),
      on: () => {},
      quit: () => {},
      getVersion: () => "0.0.0-smoke",
    },
    ipcMain: {
      handlers,
      listeners: new Map(),
      handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
        handleCalls.push(channel);
        handlers.set(channel, fn);
      },
      on: () => {},
    },
  });

  injectModule("electron-updater", {
    autoUpdater: {
      logger: undefined,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      setFeedURL: vi.fn(),
      on: vi.fn(),
      checkForUpdatesAndNotify: vi.fn(() => Promise.resolve()),
      quitAndInstall: vi.fn(),
    },
  });
  injectModule("electron-log", {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    transports: { file: { level: "info" } },
  });

  expect(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../main.cjs");
  }).not.toThrow();

  // Drain microtasks so app.whenReady().then(...) runs to completion.
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
});

afterAll(() => {
  uninstallElectronMock();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("Electron main-process IPC startup", () => {
  it("registers every expected IPC channel", () => {
    for (const channel of EXPECTED_CHANNELS) {
      expect(electronMock.ipcMain.handlers.has(channel)).toBe(true);
    }
  });

  it("does not register the same channel twice (would throw at runtime)", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const channel of handleCalls) {
      if (seen.has(channel)) dupes.push(channel);
      seen.add(channel);
    }
    expect(dupes).toEqual([]);
  });

  it("does not register any unexpected channels (catches accidental additions)", () => {
    const expected = new Set(EXPECTED_CHANNELS);
    const unexpected = [...electronMock.ipcMain.handlers.keys()].filter(
      (c) => !expected.has(c),
    );
    expect(unexpected).toEqual([]);
  });
});
