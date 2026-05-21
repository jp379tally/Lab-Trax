/**
 * Integration tests for the desktop-installer download endpoints.
 *
 * These tests verify that /downloads/LabTrax-Windows-Portable.zip (and friends)
 * correctly implement HTTP range requests, conditional GET, and resumable
 * download semantics — without touching real App Storage.
 *
 * All external dependencies of app.ts are mocked so no DB connection or
 * cloud credentials are needed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Readable } from "node:stream";
import type { Server } from "node:http";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mock all app.ts side-effect dependencies before any module is imported.
// vi.mock calls are hoisted to the top by vitest, so this runs before imports.
// ---------------------------------------------------------------------------

vi.mock("./routes/index.js", () => {
  const { Router } = require("express");
  return { default: Router() };
});
vi.mock("./lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("./lib/case-media.js", () => ({ startDailyOrphanedMediaCleanup: vi.fn() }));
vi.mock("./lib/backup.js", () => ({ startDailyOneDriveBackup: vi.fn(), start15MinRollingBackup: vi.fn(), restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./middlewares/csrf.js", () => ({
  requireCsrf: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("./lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));
vi.mock("pino-http", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// The storage mock is the key one — we provide a controlled fake installer.
vi.mock("./lib/desktop-installer-storage.js", () => ({
  getDesktopInstallerHandle: vi.fn(),
  openDesktopInstallerStream: vi.fn(),
  installerKindFromUrl: vi.fn(),
  getDesktopInstallerMetadata: vi.fn(),
  uploadDesktopInstaller: vi.fn(),
  DesktopInstallerNotConfiguredError: class DesktopInstallerNotConfiguredError extends Error {},
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered.
// ---------------------------------------------------------------------------
import app from "./app.js";
import {
  getDesktopInstallerHandle,
  openDesktopInstallerStream,
} from "./lib/desktop-installer-storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_CONTENT = Buffer.from(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz!@",
);
// 64 bytes — small enough to reason about exactly

const FAKE_UPLOADED_AT = "2026-01-01T00:00:00.000Z";
const FAKE_UPLOADED_AT_MS = Date.parse(FAKE_UPLOADED_AT);
const FAKE_ETAG = `"${FAKE_CONTENT.length.toString(16)}-${FAKE_UPLOADED_AT_MS.toString(16)}"`;

const FAKE_HANDLE = {
  size: FAKE_CONTENT.length,
  uploadedAt: FAKE_UPLOADED_AT,
  contentType: "application/zip",
  fileName: "LabTrax-Windows-Portable.zip",
  etag: FAKE_ETAG,
};

/** Create a Readable stream that emits the given buffer slice. */
function makeStream(buf: Buffer): NodeJS.ReadableStream {
  return Readable.from([buf]);
}

interface InstallerFixture {
  fileName: string;
  contentType: string;
}

/**
 * Set up the storage mocks to serve `FAKE_CONTENT` for a given installer fixture.
 * `openDesktopInstallerStream` respects `range` like the real implementation.
 */
function setupInstallerMocks(fixture: InstallerFixture = {
  fileName: "LabTrax-Windows-Portable.zip",
  contentType: "application/zip",
}) {
  vi.mocked(getDesktopInstallerHandle).mockResolvedValue({
    ...FAKE_HANDLE,
    fileName: fixture.fileName,
    contentType: fixture.contentType,
  });
  vi.mocked(openDesktopInstallerStream).mockImplementation(
    async (_kind, range?: { start?: number; end?: number }) => {
      const start = range?.start ?? 0;
      const end = range?.end ?? FAKE_CONTENT.length - 1;
      const slice = FAKE_CONTENT.slice(start, end + 1);
      return {
        size: FAKE_CONTENT.length,
        stream: makeStream(slice),
        contentType: fixture.contentType,
        fileName: fixture.fileName,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /downloads/LabTrax-Windows-Portable.zip", () => {
  let server: Server;

  beforeAll(() => {
    setupInstallerMocks();
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  it("returns 200 with full content and correct headers for a plain GET", async () => {
    const res = await request(server)
      .get("/downloads/LabTrax-Windows-Portable.zip")
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-type"]).toMatch(/application\/zip/);
    expect(res.headers["etag"]).toBe(FAKE_ETAG);
    expect(res.headers["content-disposition"]).toContain("LabTrax-Windows-Portable.zip");
    expect(res.headers["content-length"]).toBe(String(FAKE_CONTENT.length));
    expect(res.body as Buffer).toEqual(FAKE_CONTENT);
  });

  it("returns 206 with correct Content-Range and bytes for a single-range GET", async () => {
    const res = await request(server)
      .get("/downloads/LabTrax-Windows-Portable.zip")
      .set("Range", "bytes=0-9")
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-9/${FAKE_CONTENT.length}`);
    expect(res.headers["content-length"]).toBe("10");
    const body = res.body as Buffer;
    expect(body).toEqual(FAKE_CONTENT.slice(0, 10));
  });

  it("returns 206 for a mid-file range with correct bytes", async () => {
    const res = await request(server)
      .get("/downloads/LabTrax-Windows-Portable.zip")
      .set("Range", "bytes=10-19")
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 10-19/${FAKE_CONTENT.length}`);
    const body = res.body as Buffer;
    expect(body).toEqual(FAKE_CONTENT.slice(10, 20));
  });

  it("concatenating two adjacent ranges yields the same bytes as one combined range", async () => {
    const [resA, resB, resFull] = await Promise.all([
      request(server)
        .get("/downloads/LabTrax-Windows-Portable.zip")
        .set("Range", "bytes=0-19")
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (d: Buffer) => chunks.push(d));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        }),
      request(server)
        .get("/downloads/LabTrax-Windows-Portable.zip")
        .set("Range", "bytes=20-39")
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (d: Buffer) => chunks.push(d));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        }),
      request(server)
        .get("/downloads/LabTrax-Windows-Portable.zip")
        .set("Range", "bytes=0-39")
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (d: Buffer) => chunks.push(d));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        }),
    ]);

    expect(resA.status).toBe(206);
    expect(resB.status).toBe(206);
    expect(resFull.status).toBe(206);

    const bodyA = resA.body as Buffer;
    const bodyB = resB.body as Buffer;
    const bodyFull = resFull.body as Buffer;

    const concatenated = Buffer.concat([bodyA, bodyB]);
    expect(concatenated).toEqual(bodyFull);
    expect(concatenated).toEqual(FAKE_CONTENT.slice(0, 40));
  });

  it("returns 206 for a suffix range (bytes=-N) — last N bytes", async () => {
    const suffixN = 8;
    const res = await request(server)
      .get("/downloads/LabTrax-Windows-Portable.zip")
      .set("Range", `bytes=-${suffixN}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    const expectedStart = FAKE_CONTENT.length - suffixN;
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(
      `bytes ${expectedStart}-${FAKE_CONTENT.length - 1}/${FAKE_CONTENT.length}`,
    );
    const body = res.body as Buffer;
    expect(body).toEqual(FAKE_CONTENT.slice(expectedStart));
  });

  it("returns 206 for an open-ended range (bytes=N-)", async () => {
    const startAt = 50;
    const res = await request(server)
      .get("/downloads/LabTrax-Windows-Portable.zip")
      .set("Range", `bytes=${startAt}-`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(
      `bytes ${startAt}-${FAKE_CONTENT.length - 1}/${FAKE_CONTENT.length}`,
    );
    const body = res.body as Buffer;
    expect(body).toEqual(FAKE_CONTENT.slice(startAt));
  });

  it("returns 416 with Content-Range: */size for an invalid range", async () => {
    const res = await request(server)
      .get("/downloads/LabTrax-Windows-Portable.zip")
      .set("Range", "bytes=9999-99999");

    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${FAKE_CONTENT.length}`);
  });

  it("returns 416 for a malformed range header", async () => {
    const res = await request(server)
      .get("/downloads/LabTrax-Windows-Portable.zip")
      .set("Range", "not-a-range");

    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${FAKE_CONTENT.length}`);
  });

  it("returns 304 when If-None-Match matches the ETag", async () => {
    const res = await request(server)
      .get("/downloads/LabTrax-Windows-Portable.zip")
      .set("If-None-Match", FAKE_ETAG);

    expect(res.status).toBe(304);
  });

  it("serves full 200 body when If-Range ETag does not match (stale client)", async () => {
    const staleEtag = '"deadbeef-0"';
    const res = await request(server)
      .get("/downloads/LabTrax-Windows-Portable.zip")
      .set("Range", "bytes=0-9")
      .set("If-Range", staleEtag)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(body).toEqual(FAKE_CONTENT);
  });

  it("returns 206 and honours the Range header when If-Range ETag matches", async () => {
    const res = await request(server)
      .get("/downloads/LabTrax-Windows-Portable.zip")
      .set("Range", "bytes=0-9")
      .set("If-Range", FAKE_ETAG)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    const body = res.body as Buffer;
    expect(body).toEqual(FAKE_CONTENT.slice(0, 10));
  });

  it("returns 404 when no installer has been uploaded", async () => {
    vi.mocked(getDesktopInstallerHandle).mockResolvedValueOnce(null);

    const res = await request(server).get("/downloads/LabTrax-Windows-Portable.zip");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false });
  });

  it("returns 200 for HEAD request with headers but no body", async () => {
    const res = await request(server)
      .head("/downloads/LabTrax-Windows-Portable.zip");

    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe(String(FAKE_CONTENT.length));
    expect(res.headers["etag"]).toBe(FAKE_ETAG);
    // HEAD responses have no body — supertest gives an empty object
    expect(Object.keys(res.body as object)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Parameterized smoke tests for the .exe and .dmg installer endpoints.
// The serveInstaller handler is shared, so these tests guard against future
// route-registration bugs rather than re-testing all edge cases.
// ---------------------------------------------------------------------------

const OTHER_INSTALLERS: Array<{ url: string; fixture: InstallerFixture }> = [
  {
    url: "/downloads/LabTrax-Setup.exe",
    fixture: {
      fileName: "LabTrax-Setup.exe",
      contentType: "application/vnd.microsoft.portable-executable",
    },
  },
  {
    url: "/downloads/LabTrax.dmg",
    fixture: {
      fileName: "LabTrax.dmg",
      contentType: "application/x-apple-diskimage",
    },
  },
];

describe.each(OTHER_INSTALLERS)("GET $url", ({ url, fixture }) => {
  let server: Server;

  beforeAll(() => {
    setupInstallerMocks(fixture);
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  it("returns 200 with full content and correct headers for a plain GET", async () => {
    const res = await request(server)
      .get(url)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-type"]).toMatch(fixture.contentType);
    expect(res.headers["etag"]).toBe(FAKE_ETAG);
    expect(res.headers["content-disposition"]).toContain(fixture.fileName);
    expect(res.headers["content-length"]).toBe(String(FAKE_CONTENT.length));
    expect(res.body as Buffer).toEqual(FAKE_CONTENT);
  });

  it("returns 206 with correct Content-Range and bytes for a single-range GET", async () => {
    const res = await request(server)
      .get(url)
      .set("Range", "bytes=0-9")
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-9/${FAKE_CONTENT.length}`);
    expect(res.headers["content-length"]).toBe("10");
    const body = res.body as Buffer;
    expect(body).toEqual(FAKE_CONTENT.slice(0, 10));
  });

  it("returns 304 when If-None-Match matches the ETag", async () => {
    const res = await request(server)
      .get(url)
      .set("If-None-Match", FAKE_ETAG);

    expect(res.status).toBe(304);
  });

  it("returns 404 when no installer has been uploaded", async () => {
    vi.mocked(getDesktopInstallerHandle).mockResolvedValueOnce(null);

    const res = await request(server).get(url);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false });
  });
});

