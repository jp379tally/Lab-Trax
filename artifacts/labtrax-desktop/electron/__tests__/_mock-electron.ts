"use strict";

/**
 * Shared helper for `.cjs` Electron-main tests.
 *
 * Vitest's `vi.mock("electron", ...)` does NOT intercept `require("electron")`
 * inside our `.cjs` source files (those are loaded by Node's CJS loader, not
 * by Vitest's transform pipeline), and outside the Electron runtime
 * `require("electron")` resolves to the path string of the prebuilt Electron
 * binary. Pre-populating `require.cache` is the only thing that reliably
 * intercepts the real require call from inside `auth-store.cjs`,
 * `main.cjs`, etc.
 */
import { createRequire } from "node:module";

const localRequire = createRequire(__filename);

export type ElectronMock = {
  app: {
    getPath: (name: string) => string;
    whenReady: () => Promise<void>;
    on: (event: string, fn: (...args: unknown[]) => void) => void;
    quit: () => void;
    getVersion: () => string;
  };
  safeStorage: {
    isEncryptionAvailable: () => boolean;
    encryptString: (s: string) => Buffer;
    decryptString: (b: Buffer) => string;
  };
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => void;
    handlers: Map<string, (...args: unknown[]) => unknown>;
  };
  BrowserWindow: {
    new (...args: unknown[]): unknown;
    getAllWindows: () => unknown[];
  };
  protocol: {
    registerSchemesAsPrivileged: (...args: unknown[]) => void;
    handle: (...args: unknown[]) => void;
  };
  net: { fetch: (...args: unknown[]) => unknown };
  dialog: Record<string, unknown>;
  Notification: unknown;
  session: { fromPartition: (p: string) => unknown };
};

export function installElectronMock(overrides: Partial<ElectronMock> = {}): ElectronMock {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const mock: ElectronMock = {
    app: {
      getPath: () => "/tmp",
      whenReady: () => Promise.resolve(),
      on: () => {},
      quit: () => {},
      getVersion: () => "0.0.0-test",
      ...(overrides.app ?? {}),
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from("ENC::" + s, "utf8"),
      decryptString: (buf: Buffer) => {
        const s = buf.toString("utf8");
        if (!s.startsWith("ENC::")) throw new Error("bad blob");
        return s.slice(5);
      },
      ...(overrides.safeStorage ?? {}),
    },
    ipcMain: {
      handlers,
      handle: (channel, fn) => {
        handlers.set(channel, fn);
      },
      ...(overrides.ipcMain ?? {}),
    },
    BrowserWindow: Object.assign(
      function BrowserWindow() {
        return {
          loadURL: () => {},
          webContents: { send: () => {}, openDevTools: () => {} },
          setMenuBarVisibility: () => {},
          isDestroyed: () => false,
        };
      } as unknown as ElectronMock["BrowserWindow"],
      { getAllWindows: () => [] as unknown[] },
    ),
    protocol: {
      registerSchemesAsPrivileged: () => {},
      handle: () => {},
      ...(overrides.protocol ?? {}),
    },
    net: { fetch: () => Promise.resolve(new Response("")) },
    dialog: {},
    Notification: function () {},
    session: { fromPartition: () => ({}) },
    ...overrides,
  } as ElectronMock;

  const electronPath = localRequire.resolve("electron");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (require.cache as any)[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: mock,
    children: [],
    paths: [],
    path: "",
    parent: null,
  };
  return mock;
}

export function uninstallElectronMock(): void {
  const electronPath = localRequire.resolve("electron");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (require.cache as any)[electronPath];
}
