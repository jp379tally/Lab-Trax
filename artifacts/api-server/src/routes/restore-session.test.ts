/**
 * Tests for the resumable restore upload session.
 *
 * Covers:
 *   1. POST /admin/backup/restore-session — creates session, enforces platform-admin auth
 *   2. PATCH /admin/backup/restore-session/:id — receives chunks, finalizes by triggering executeRestore
 *   3. GET  /admin/backup/restore-session/:id — returns current offset
 *   4. Concurrent-restore 409 guard is preserved on the new path
 *
 * executeRestore and getRestoreState are mocked so the test is deterministic
 * and does not require pg_restore or backup files. Skipped when DATABASE_URL
 * is unset (same convention as sibling route tests).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import request from "supertest";

const PLATFORM_ADMIN_SECRET = "restore-session-test-secret";
process.env["PLATFORM_ADMIN_SECRET"] = PLATFORM_ADMIN_SECRET;

const executeRestoreSpy = vi.fn().mockResolvedValue({ manifest: {} });
let restoreStatePhase: string = "idle";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
  getRestoreState: () => ({ phase: restoreStatePhase, message: null }),
  executeRestore: (buf: Buffer, by: string) => executeRestoreSpy(buf, by),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/case-media.js")>();
  return { ...actual, startDailyOrphanedMediaCleanup: vi.fn() };
});
vi.mock("../lib/case-media-object-storage.js", () => ({
  caseMediaObjectStorageAvailable: () => false,
  writeCaseMediaToObjectStorage: vi.fn().mockResolvedValue(true),
  openCaseMediaObjectStream: vi.fn().mockResolvedValue(null),
  deleteCaseMediaFromObjectStorage: vi.fn().mockResolvedValue(false),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

const ADMIN_HEADER = { "x-platform-admin-secret": PLATFORM_ADMIN_SECRET };

function makeBytes(size: number): Buffer {
  return randomBytes(size);
}

maybe("Resumable restore upload session", () => {
  let appMod: { default: import("express").Express };

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-restore-session";
    appMod = await import("../app.js");
  });

  afterAll(() => {
    restoreStatePhase = "idle";
  });

  describe("POST /admin/backup/restore-session", () => {
    it("rejects without platform-admin credentials (401 unauthenticated)", async () => {
      const app = appMod.default;
      const res = await request(app)
        .post("/api/admin/backup/restore-session")
        .send({ fileName: "backup.zip.enc", fileSize: 1024 });
      // No JWT and no secret → requireAuth rejects with 401.
      expect(res.status).toBe(401);
    });

    it("returns 400 when fileName is missing", async () => {
      const app = appMod.default;
      const res = await request(app)
        .post("/api/admin/backup/restore-session")
        .set(ADMIN_HEADER)
        .send({ fileSize: 1024 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/fileName/i);
    });

    it("returns 400 when fileSize is invalid", async () => {
      const app = appMod.default;
      const res = await request(app)
        .post("/api/admin/backup/restore-session")
        .set(ADMIN_HEADER)
        .send({ fileName: "backup.zip.enc", fileSize: -1 });
      expect(res.status).toBe(400);
    });

    it("creates a session and returns sessionId", async () => {
      restoreStatePhase = "idle";
      const app = appMod.default;
      const res = await request(app)
        .post("/api/admin/backup/restore-session")
        .set(ADMIN_HEADER)
        .send({ fileName: "backup.zip.enc", fileSize: 4096 });
      expect(res.status).toBe(201);
      expect(typeof res.body.sessionId).toBe("string");
      expect(res.body.uploadedBytes).toBe(0);
      expect(res.body.fileSize).toBe(4096);
    });

    it("returns 409 when a restore is already in progress", async () => {
      restoreStatePhase = "restoring_db";
      const app = appMod.default;
      const res = await request(app)
        .post("/api/admin/backup/restore-session")
        .set(ADMIN_HEADER)
        .send({ fileName: "backup.zip.enc", fileSize: 1024 });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already in progress/i);
      restoreStatePhase = "idle";
    });
  });

  describe("PATCH /admin/backup/restore-session/:id — chunked upload", () => {
    it("rejects without platform-admin credentials (401 unauthenticated)", async () => {
      const app = appMod.default;
      const res = await request(app)
        .patch("/api/admin/backup/restore-session/0000000000000000000000000000001a")
        .set("Upload-Offset", "0")
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.alloc(8));
      // No JWT and no secret → requireAuth rejects with 401.
      expect(res.status).toBe(401);
    });

    it("returns 404 for an unknown session", async () => {
      const app = appMod.default;
      const res = await request(app)
        .patch("/api/admin/backup/restore-session/0000000000000000000000000000001b")
        .set(ADMIN_HEADER)
        .set("Upload-Offset", "0")
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.alloc(8));
      expect(res.status).toBe(404);
    });

    it("assembles chunks and triggers executeRestore on the final chunk", async () => {
      restoreStatePhase = "idle";
      executeRestoreSpy.mockClear();
      const app = appMod.default;

      const fileBytes = makeBytes(3000);

      // Create session
      const createRes = await request(app)
        .post("/api/admin/backup/restore-session")
        .set(ADMIN_HEADER)
        .send({ fileName: "test.zip.enc", fileSize: fileBytes.length });
      expect(createRes.status).toBe(201);
      const { sessionId } = createRes.body as { sessionId: string };

      // Send chunk 1 (first 1500 bytes)
      const chunk1 = fileBytes.slice(0, 1500);
      const patch1 = await request(app)
        .patch(`/api/admin/backup/restore-session/${sessionId}`)
        .set(ADMIN_HEADER)
        .set("Upload-Offset", "0")
        .set("Content-Type", "application/octet-stream")
        .send(chunk1);
      expect(patch1.status).toBe(200);
      expect(patch1.body.uploadedBytes).toBe(1500);
      expect(patch1.body.complete).toBe(false);
      expect(executeRestoreSpy).not.toHaveBeenCalled();

      // Send chunk 2 (remaining 1500 bytes) — completes the file
      const chunk2 = fileBytes.slice(1500);
      const patch2 = await request(app)
        .patch(`/api/admin/backup/restore-session/${sessionId}`)
        .set(ADMIN_HEADER)
        .set("Upload-Offset", "1500")
        .set("Content-Type", "application/octet-stream")
        .send(chunk2);
      expect(patch2.status).toBe(202);
      expect(patch2.body.complete).toBe(true);

      // Give the background async pipeline a tick to run.
      await new Promise((r) => setTimeout(r, 20));
      expect(executeRestoreSpy).toHaveBeenCalledTimes(1);

      // Verify the assembled buffer matches the original file bytes.
      const [calledBuf] = executeRestoreSpy.mock.calls[0] as [Buffer, string];
      expect(Buffer.isBuffer(calledBuf)).toBe(true);
      expect(calledBuf.equals(fileBytes)).toBe(true);
    });

    it("returns 409 on the final chunk when a concurrent restore started mid-upload", async () => {
      restoreStatePhase = "idle";
      executeRestoreSpy.mockClear();
      const app = appMod.default;

      const fileBytes = makeBytes(100);
      const createRes = await request(app)
        .post("/api/admin/backup/restore-session")
        .set(ADMIN_HEADER)
        .send({ fileName: "concurrent.zip.enc", fileSize: fileBytes.length });
      expect(createRes.status).toBe(201);
      const { sessionId } = createRes.body as { sessionId: string };

      // Simulate another restore starting mid-upload
      restoreStatePhase = "restoring_db";

      const patchRes = await request(app)
        .patch(`/api/admin/backup/restore-session/${sessionId}`)
        .set(ADMIN_HEADER)
        .set("Upload-Offset", "0")
        .set("Content-Type", "application/octet-stream")
        .send(fileBytes);
      expect(patchRes.status).toBe(409);
      expect(executeRestoreSpy).not.toHaveBeenCalled();

      restoreStatePhase = "idle";
    });
  });

  describe("GET /admin/backup/restore-session/:id", () => {
    it("rejects without platform-admin credentials (401 unauthenticated)", async () => {
      const app = appMod.default;
      const res = await request(app)
        .get("/api/admin/backup/restore-session/0000000000000000000000000000001c");
      // No JWT and no secret → requireAuth rejects with 401.
      expect(res.status).toBe(401);
    });

    it("returns 404 for unknown session", async () => {
      const app = appMod.default;
      const res = await request(app)
        .get("/api/admin/backup/restore-session/0000000000000000000000000000001d")
        .set(ADMIN_HEADER);
      expect(res.status).toBe(404);
    });

    it("returns current offset for a live session", async () => {
      restoreStatePhase = "idle";
      const app = appMod.default;
      const fileBytes = makeBytes(500);

      const createRes = await request(app)
        .post("/api/admin/backup/restore-session")
        .set(ADMIN_HEADER)
        .send({ fileName: "status-check.zip.enc", fileSize: fileBytes.length });
      expect(createRes.status).toBe(201);
      const { sessionId } = createRes.body as { sessionId: string };

      // Upload first 200 bytes
      await request(app)
        .patch(`/api/admin/backup/restore-session/${sessionId}`)
        .set(ADMIN_HEADER)
        .set("Upload-Offset", "0")
        .set("Content-Type", "application/octet-stream")
        .send(fileBytes.slice(0, 200));

      const statusRes = await request(app)
        .get(`/api/admin/backup/restore-session/${sessionId}`)
        .set(ADMIN_HEADER);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.uploadedBytes).toBe(200);
      expect(statusRes.body.fileSize).toBe(500);
    });
  });
});
