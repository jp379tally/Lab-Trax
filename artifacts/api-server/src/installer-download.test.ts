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
import http from "node:http";
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
// Stream-retry tests
//
// These tests exercise the transparent single-retry path in serveInstaller
// (app.ts ~line 179-196): when GCS drops the connection mid-transfer the
// server opens a new range stream from the last confirmed byte and continues
// piping to the client without changing the response status.
// ---------------------------------------------------------------------------

describe("GET /downloads/LabTrax-Windows-Portable.zip — stream retry", () => {
  let server: Server;

  beforeAll(() => {
    vi.mocked(getDesktopInstallerHandle).mockResolvedValue({ ...FAKE_HANDLE });
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    // Each retry test installs its own per-call mocks via mockImplementationOnce.
    // Reset first so leftover implementations from previous tests don't bleed in.
    vi.mocked(openDesktopInstallerStream).mockReset();
  });

  it("completes with the correct full byte count when the first stream errors mid-transfer and the retry succeeds", async () => {
    // The first stream delivers the first half of FAKE_CONTENT then errors.
    // The retry should be opened from that offset and deliver the remainder.
    const splitAt = 32; // bytes 0-31 from first stream, 32-63 from retry
    const streamError = new Error("GCS upstream dropped connection");

    vi.mocked(openDesktopInstallerStream)
      // First call — partial data then broken stream
      .mockImplementationOnce(async () => {
        const s = new Readable({ read() {} });
        // Schedule the push+destroy so they fire after the stream is piped to
        // res (pipe is synchronous; nextTick fires in the following turn).
        process.nextTick(() => {
          s.push(FAKE_CONTENT.slice(0, splitAt));
          s.destroy(streamError);
        });
        return {
          size: FAKE_CONTENT.length,
          stream: s,
          contentType: "application/zip",
          fileName: "LabTrax-Windows-Portable.zip",
        };
      })
      // Second call (retry from offset 32) — serves the remaining bytes
      .mockImplementationOnce(async (_kind, range?: { start?: number; end?: number }) => {
        const start = range?.start ?? 0;
        const end = range?.end ?? FAKE_CONTENT.length - 1;
        return {
          size: FAKE_CONTENT.length,
          stream: makeStream(FAKE_CONTENT.slice(start, end + 1)),
          contentType: "application/zip",
          fileName: "LabTrax-Windows-Portable.zip",
        };
      });

    const res = await request(server)
      .get("/downloads/LabTrax-Windows-Portable.zip")
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    // Response headers were sent before the stream started, so status is 200.
    expect(res.status).toBe(200);

    // The retry path opened a second stream — verify both calls happened.
    expect(vi.mocked(openDesktopInstallerStream)).toHaveBeenCalledTimes(2);

    // The second call must resume from exactly where the first stream left off.
    const retryRange = vi.mocked(openDesktopInstallerStream).mock.calls[1][1];
    expect(retryRange).toMatchObject({ start: splitAt });

    // The client received every byte of FAKE_CONTENT despite the mid-stream error.
    const body = res.body as Buffer;
    expect(body.length).toBe(FAKE_CONTENT.length);
    expect(body).toEqual(FAKE_CONTENT);
  });

  it("completes with the correct partial bytes when the first stream errors mid-range and the retry succeeds", async () => {
    // Scenario: client requests bytes=10-39 (a mid-file range, N=10, M=39).
    // The first stream delivers 5 bytes of that range (file offsets 10-14) then
    // drops.  The retry must resume from absoluteOffset = N + bytesSentSoFar =
    // 10 + 5 = 15 with end=39 — not from 0 — and the response body must equal
    // FAKE_CONTENT[10..39].
    const rangeStart = 10;
    const rangeEnd = 39;
    const bytesFromFirstStream = 5; // deliver offsets 10-14 then error
    const expectedAbsoluteOffset = rangeStart + bytesFromFirstStream; // 15
    const streamError = new Error("GCS upstream dropped connection mid-range");

    vi.mocked(openDesktopInstallerStream)
      // First call — open with { start:10, end:39 }, emit 5 bytes then error
      .mockImplementationOnce(async () => {
        const s = new Readable({ read() {} });
        process.nextTick(() => {
          s.push(FAKE_CONTENT.slice(rangeStart, rangeStart + bytesFromFirstStream));
          s.destroy(streamError);
        });
        return {
          size: FAKE_CONTENT.length,
          stream: s,
          contentType: "application/zip",
          fileName: "LabTrax-Windows-Portable.zip",
        };
      })
      // Second call (retry from offset 15) — serves the remaining range bytes
      .mockImplementationOnce(async (_kind, range?: { start?: number; end?: number }) => {
        const start = range?.start ?? 0;
        const end = range?.end ?? FAKE_CONTENT.length - 1;
        return {
          size: FAKE_CONTENT.length,
          stream: makeStream(FAKE_CONTENT.slice(start, end + 1)),
          contentType: "application/zip",
          fileName: "LabTrax-Windows-Portable.zip",
        };
      });

    const res = await request(server)
      .get("/downloads/LabTrax-Windows-Portable.zip")
      .set("Range", `bytes=${rangeStart}-${rangeEnd}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    // Headers were already sent, so status reflects the original 206.
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(
      `bytes ${rangeStart}-${rangeEnd}/${FAKE_CONTENT.length}`,
    );

    // Both streams were opened.
    expect(vi.mocked(openDesktopInstallerStream)).toHaveBeenCalledTimes(2);

    // The retry must resume from N + bytesSentSoFar with the original end,
    // not from file offset 0.
    const retryRange = vi.mocked(openDesktopInstallerStream).mock.calls[1][1];
    expect(retryRange).toMatchObject({ start: expectedAbsoluteOffset, end: rangeEnd });

    // The client received exactly the bytes for the requested range.
    const body = res.body as Buffer;
    expect(body.length).toBe(rangeEnd - rangeStart + 1);
    expect(body).toEqual(FAKE_CONTENT.slice(rangeStart, rangeEnd + 1));
  });

  it("tears down the response socket when both the original stream and the retry stream error", async () => {
    // First stream delivers a few bytes then errors.  The retry mock throws at
    // the open level (simulating a GCS open failure) — this hits the catch
    // block in the error handler and falls through to res.destroy(), which
    // tears down the socket.  Using a throw rather than a mid-stream error
    // avoids nextTick/microtask ordering hazards while still exercising the
    // same res.destroy() code path.  We use raw http.get so the socket close
    // is visible as a connection error instead of being silently absorbed by
    // supertest's response buffer.
    const splitAt = 10;
    const streamError = new Error("GCS upstream dropped connection");

    vi.mocked(openDesktopInstallerStream)
      // First call — partial data then error
      .mockImplementationOnce(async () => {
        const s = new Readable({ read() {} });
        process.nextTick(() => {
          s.push(FAKE_CONTENT.slice(0, splitAt));
          s.destroy(streamError);
        });
        return {
          size: FAKE_CONTENT.length,
          stream: s,
          contentType: "application/zip",
          fileName: "LabTrax-Windows-Portable.zip",
        };
      })
      // Second call (retry) — throws at the open level, hitting the catch
      // block in attachStreamHandlers which falls through to res.destroy(err).
      .mockImplementationOnce(async () => {
        throw new Error("GCS retry open also failed");
      });

    const port = (server.address() as { port: number }).port;

    const { receivedBytes, hadConnectionError } = await new Promise<{
      receivedBytes: number;
      hadConnectionError: boolean;
    }>((resolve) => {
      let bytes = 0;
      let settled = false;
      const settle = (hadConnectionError: boolean) => {
        if (!settled) {
          settled = true;
          resolve({ receivedBytes: bytes, hadConnectionError });
        }
      };

      const req = http.get(
        {
          hostname: "127.0.0.1",
          port,
          path: "/downloads/LabTrax-Windows-Portable.zip",
        },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
          });
          res.on("end", () => settle(false));
          res.on("error", () => settle(true));
        },
      );
      req.on("error", () => settle(true));
      // Safety net — should not be reached if res.destroy() works correctly.
      req.setTimeout(4000, () => {
        req.destroy();
        settle(false);
      });
    });

    // Both the initial stream and the retry open were attempted.
    expect(vi.mocked(openDesktopInstallerStream)).toHaveBeenCalledTimes(2);

    // The retry was requested starting from the byte the first stream left off.
    const retryRange = vi.mocked(openDesktopInstallerStream).mock.calls[1][1];
    expect(retryRange).toMatchObject({ start: splitAt });

    // The server destroyed the socket — the client saw a connection error, not
    // a clean stream end that would silently hide the truncation.
    expect(hadConnectionError).toBe(true);

    // Only the partial bytes from the first stream were delivered.
    expect(receivedBytes).toBeLessThan(FAKE_CONTENT.length);
  }, 8000);

  it("tears down the response socket when both streams error on a mid-range request (N > 0)", async () => {
    // Scenario: client requests bytes=10-39 (N=10, M=39, range length=30).
    // The first stream delivers a few bytes then errors.  The retry open throws.
    // Even though headers (206) were already sent, res.destroy() must be called
    // so the client sees a connection error rather than a silently short body.
    const rangeStart = 10;
    const rangeEnd = 39;
    const splitAt = 5; // bytes delivered by the first stream before it errors
    const streamError = new Error("GCS upstream dropped connection mid-range");

    vi.mocked(openDesktopInstallerStream)
      // First call — open with { start:10, end:39 }, emit 5 bytes then error
      .mockImplementationOnce(async () => {
        const s = new Readable({ read() {} });
        process.nextTick(() => {
          s.push(FAKE_CONTENT.slice(rangeStart, rangeStart + splitAt));
          s.destroy(streamError);
        });
        return {
          size: FAKE_CONTENT.length,
          stream: s,
          contentType: "application/zip",
          fileName: "LabTrax-Windows-Portable.zip",
        };
      })
      // Second call (retry) — throws at the open level, hitting the catch
      // block in attachStreamHandlers which falls through to res.destroy(err).
      .mockImplementationOnce(async () => {
        throw new Error("GCS retry open also failed (mid-range)");
      });

    const port = (server.address() as { port: number }).port;

    const { receivedBytes, hadConnectionError } = await new Promise<{
      receivedBytes: number;
      hadConnectionError: boolean;
    }>((resolve) => {
      let bytes = 0;
      let settled = false;
      const settle = (hadConnectionError: boolean) => {
        if (!settled) {
          settled = true;
          resolve({ receivedBytes: bytes, hadConnectionError });
        }
      };

      const req = http.get(
        {
          hostname: "127.0.0.1",
          port,
          path: "/downloads/LabTrax-Windows-Portable.zip",
          headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
        },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
          });
          res.on("end", () => settle(false));
          res.on("error", () => settle(true));
        },
      );
      req.on("error", () => settle(true));
      // Safety net — should not be reached if res.destroy() works correctly.
      req.setTimeout(4000, () => {
        req.destroy();
        settle(false);
      });
    });

    // Both the initial stream and the retry open were attempted.
    expect(vi.mocked(openDesktopInstallerStream)).toHaveBeenCalledTimes(2);

    // The retry was requested starting from rangeStart + bytesSentSoFar,
    // not from file offset 0.
    const retryRange = vi.mocked(openDesktopInstallerStream).mock.calls[1][1];
    expect(retryRange).toMatchObject({ start: rangeStart + splitAt, end: rangeEnd });

    // The server destroyed the socket — the client saw a connection error, not
    // a clean stream end that would silently hide the truncation.
    expect(hadConnectionError).toBe(true);

    // Only the partial bytes from the first stream were delivered — fewer than
    // the requested range length (30 bytes).
    expect(receivedBytes).toBeLessThan(rangeEnd - rangeStart + 1);
  }, 8000);
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

