/**
 * Regression guard: Electron main-process authenticated media bridge.
 *
 * Protected workflow: "Desktop Case Photo Cross-Platform Visibility"
 *
 * The desktop renderer runs from the custom `app://labtrax` protocol, so every
 * protected media fetch to the hosted API is cross-origin and browser-like and
 * can render blank (CORS / dropped Authorization header). The
 * `media:fetch-authenticated` IPC handler fetches those bytes in the main
 * process (Electron `net.fetch`) with the stored bearer token instead.
 *
 * The invariants enforced here:
 *   1. A same-origin (LabTrax API) URL is fetched via `net.fetch` WITH the
 *      stored bearer token, and the bytes + mime type are returned.
 *   2. A third-party URL is REFUSED without any network call, so the bearer
 *      token can never leak to another host.
 *   3. Non-http(s) schemes (data:, file:, blob:) are refused.
 *
 * Keep this test permanently per the REGRESSION_GUARDRAILS.md policy.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Module from "node:module";
import { installElectronMock, uninstallElectronMock, type ElectronMock } from "./_mock-electron";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "labtrax-media-bridge-"));
const API_ORIGIN = "https://api.labtrax.test";
const ACCESS_TOKEN = "access-token-123";

type MediaResult = {
  ok: boolean;
  status: number;
  mimeType?: string;
  buffer?: Buffer;
  error?: string;
};

let electronMock: ElectronMock;
let handler: (...a: unknown[]) => Promise<MediaResult>;
const netFetch = vi.fn();

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
  process.env.VITE_API_BASE_URL = API_ORIGIN;
  delete process.env.UPDATE_FEED_URL;

  netFetch.mockImplementation(() =>
    Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    ),
  );

  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  electronMock = installElectronMock({
    app: {
      getPath: () => tmpDir,
      whenReady: () => Promise.resolve(),
      on: () => {},
      quit: () => {},
      getVersion: () => "0.0.0-media",
    },
    ipcMain: {
      handlers,
      listeners: new Map(),
      handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      },
      on: () => {},
    },
    net: { fetch: netFetch },
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

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("../main.cjs");
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }

  // Seed a stored bearer token the handler will read.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authStore = require("../auth-store.cjs");
  authStore.setTokens({ accessToken: ACCESS_TOKEN, refreshToken: "refresh-token-123" });

  handler = electronMock.ipcMain.handlers.get(
    "media:fetch-authenticated",
  ) as typeof handler;
  expect(typeof handler).toBe("function");
});

afterAll(() => {
  uninstallElectronMock();
  delete process.env.VITE_API_BASE_URL;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("media:fetch-authenticated — Electron main-process media bridge", () => {
  it("fetches a same-origin API URL with the stored bearer token and returns the bytes", async () => {
    netFetch.mockClear();
    const url = `${API_ORIGIN}/api/cases/abc/attachments/def/file`;
    const result = await handler({}, url);

    expect(netFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = netFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(calledUrl).toBe(url);
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.mimeType).toBe("image/jpeg");
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(Array.from(result.buffer as Buffer)).toEqual([1, 2, 3]);
  });

  it("refuses a third-party URL without making any network call (token cannot leak)", async () => {
    netFetch.mockClear();
    const result = await handler({}, "https://evil.example/steal-token");

    expect(netFetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/API origin/i);
  });

  it("refuses non-http(s) schemes (data:/file:/blob:)", async () => {
    netFetch.mockClear();
    for (const url of [
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "blob:app://labtrax/abc",
    ]) {
      const result = await handler({}, url);
      expect(result.ok).toBe(false);
    }
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("returns an error for invalid input instead of throwing", async () => {
    netFetch.mockClear();
    const result = await handler({}, "");
    expect(result.ok).toBe(false);
    expect(netFetch).not.toHaveBeenCalled();
  });
});
