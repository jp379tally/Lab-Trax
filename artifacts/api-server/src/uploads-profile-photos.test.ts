/**
 * Regression test for the /uploads/profile-photos static mount.
 *
 * Production logs showed an "Unhandled API error" (500) with a raw
 * `ENOENT: no such file or directory, stat '...'` message whenever a user's
 * `profilePhotoUrl` pointed at a file that no longer existed on disk. The
 * static file middleware (`express.static(..., { fallthrough: false })`)
 * correctly tags the forwarded error with `statusCode: 404`, but the app's
 * generic error handler only special-cased a few known error classes and
 * fell through to a blanket 500 + "Unhandled API error" log for everything
 * else — including this 404-flavored error.
 *
 * These tests mount the real `app.ts` (with its heavier dependencies
 * mocked out, mirroring installer-download.test.ts) and assert that:
 *  - a missing profile photo file returns a clean 404 JSON body, and
 *  - an existing profile photo file is still served normally.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mock app.ts side-effect dependencies before any module is imported (same
// pattern as installer-download.test.ts) so this suite needs no DB or cloud
// credentials.
// ---------------------------------------------------------------------------

vi.mock("./routes/index.js", () => {
  const { Router } = require("express");
  return { default: Router() };
});
vi.mock("./lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("./lib/case-media.js", () => ({ startDailyOrphanedMediaCleanup: vi.fn() }));
vi.mock("./lib/backup.js", () => ({ restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
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
vi.mock("./lib/desktop-installer-storage.js", () => ({
  getDesktopInstallerHandle: vi.fn(),
  openDesktopInstallerStream: vi.fn(),
  getSignedDownloadUrl: vi.fn().mockResolvedValue(null),
  getDirectDownloadUrl: vi.fn().mockResolvedValue(null),
  installerKindFromUrl: vi.fn(),
  getDesktopInstallerMetadata: vi.fn(),
  uploadDesktopInstaller: vi.fn(),
  DesktopInstallerNotConfiguredError: class DesktopInstallerNotConfiguredError extends Error {},
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered.
// ---------------------------------------------------------------------------
import app from "./app.js";

// app.ts resolves the profile-photos directory from process.cwd() at import
// time, which for this test file is the api-server package root.
const PROFILE_PHOTOS_DIR = path.join(process.cwd(), "uploads", "profile-photos");
const EXISTING_FILENAME = "test-fixture-existing-photo.jpg";
const MISSING_FILENAME = "test-fixture-does-not-exist-photo.jpg";

describe("GET /uploads/profile-photos/:filename", () => {
  let server: Server;

  beforeAll(() => {
    fs.mkdirSync(PROFILE_PHOTOS_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROFILE_PHOTOS_DIR, EXISTING_FILENAME), Buffer.from("fake-jpeg-bytes"));
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
    fs.rmSync(path.join(PROFILE_PHOTOS_DIR, EXISTING_FILENAME), { force: true });
  });

  it("returns a clean 404 JSON response when the referenced file is missing from disk", async () => {
    const res = await request(server).get(`/uploads/profile-photos/${MISSING_FILENAME}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, message: "Profile photo not found." });
    // Must never leak the server filesystem path back to the client.
    expect(JSON.stringify(res.body)).not.toContain(PROFILE_PHOTOS_DIR);
  });

  it("still serves an existing profile photo file normally", async () => {
    const res = await request(server).get(`/uploads/profile-photos/${EXISTING_FILENAME}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(Buffer.from("fake-jpeg-bytes"));
  });
});
