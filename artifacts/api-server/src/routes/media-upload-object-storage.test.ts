/**
 * Regression test for the blank-photo-in-production bug, durability layer.
 *
 * Production runs on an autoscale deployment: the local filesystem is
 * ephemeral and NOT shared across instances, so a case-media file written
 * only to `uploads/case-media/` by one instance 404s when the serving GET
 * lands on a different instance, and is wiped entirely on every redeploy.
 *
 * The fix mirrors every uploaded file to App Storage (object storage) before
 * reporting success, so the bytes are durable and reachable from any instance.
 * These tests assert both upload paths call `writeCaseMediaToObjectStorage`:
 *   1. Single-shot  POST /api/media/upload
 *   2. Resumable    POST/PATCH /api/media/upload-session
 *
 * The object-storage layer is mocked so the test is deterministic and does
 * not require a provisioned bucket. Skipped when DATABASE_URL is unset
 * (same convention as sibling route tests).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/case-media.js")>();
  return { ...actual, startDailyOrphanedMediaCleanup: vi.fn() };
});

const writeSpy = vi.fn().mockResolvedValue(true);
let storageAvailable = true;
vi.mock("../lib/case-media-object-storage.js", () => ({
  caseMediaObjectStorageAvailable: () => storageAvailable,
  writeCaseMediaToObjectStorage: (
    name: string,
    data: Buffer,
    contentType: string,
  ) => writeSpy(name, data, contentType),
  openCaseMediaObjectStream: vi.fn().mockResolvedValue(null),
  deleteCaseMediaFromObjectStorage: vi.fn().mockResolvedValue(false),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("case-media uploads persist to object storage (autoscale durability)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const userId = rid("uupload");
  let token = "";

  async function makeSession(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const t = auth.signAccessToken(uid, sessionId);
    const hash = createHash("sha256").update(t).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId: uid,
      tokenHash: hash,
      expiresAt,
    });
    return t;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-media-upload";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users } = dbMod as any;
    await db.insert(users).values([
      { id: userId, username: `up_${userId}`, password: "x" },
    ]);
    token = await makeSession(userId);
  });

  // Refresh session token before every test so a concurrent user_sessions
  // wipe does not invalidate the shared token mid-suite.
  beforeEach(async () => {
    token = await makeSession(userId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, users, userSessions } = dbMod as any;
    await db.delete(userSessions).where(inArray(userSessions.userId, [userId]));
    await db.delete(users).where(inArray(users.id, [userId]));
  });

  it("single-shot /media/upload mirrors the file to object storage", async () => {
    writeSpy.mockClear();
    const app = appMod.default;
    const bytes = randomBytes(1024);

    const res = await request(app)
      .post("/api/media/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", bytes, { filename: "photo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(typeof res.body.filename).toBe("string");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [name, data, contentType] = writeSpy.mock.calls[0];
    expect(name).toBe(res.body.filename);
    expect(Buffer.isBuffer(data)).toBe(true);
    expect((data as Buffer).equals(bytes)).toBe(true);
    expect(contentType).toBe("image/jpeg");
  });

  it("fails the upload (500) when object storage write fails", async () => {
    const app = appMod.default;
    writeSpy.mockClear();
    writeSpy.mockResolvedValueOnce(false);

    const res = await request(app)
      .post("/api/media/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", randomBytes(512), {
        filename: "fail.jpg",
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(500);
  });

  it("resumable /media/upload-session mirrors the file to object storage", async () => {
    writeSpy.mockClear();
    const app = appMod.default;
    const bytes = randomBytes(4096);

    const startRes = await request(app)
      .post("/api/media/upload-session")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "scan.jpg",
        fileSize: bytes.length,
        mimeType: "image/jpeg",
      });
    expect([200, 201]).toContain(startRes.status);
    const sessionId = startRes.body.sessionId as string;
    expect(typeof sessionId).toBe("string");

    const patchRes = await request(app)
      .patch(`/api/media/upload-session/${sessionId}`)
      .set("Authorization", `Bearer ${token}`)
      .set("Upload-Offset", "0")
      .set("Content-Type", "application/octet-stream")
      .send(bytes);

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.complete).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [name, data, contentType] = writeSpy.mock.calls[0];
    expect(name).toBe(patchRes.body.filename);
    expect(Buffer.isBuffer(data)).toBe(true);
    expect((data as Buffer).equals(bytes)).toBe(true);
    expect(contentType).toBe("image/jpeg");
  });

  it("single-shot /media/upload fails loudly (500) when object storage is unavailable", async () => {
    writeSpy.mockClear();
    storageAvailable = false;
    try {
      const app = appMod.default;

      const res = await request(app)
        .post("/api/media/upload")
        .set("Authorization", `Bearer ${token}`)
        .attach("file", randomBytes(1024), {
          filename: "ephemeral.jpg",
          contentType: "image/jpeg",
        });

      // Must NOT return 200 with a disk-only URL that 404s after a redeploy.
      expect(res.status).toBe(500);
      expect(res.body.url).toBeUndefined();
      expect(res.body.filename).toBeUndefined();
      // The fail-loud guard runs before any object-storage write is attempted.
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      storageAvailable = true;
    }
  });

  it("resumable /media/upload-session finalize fails loudly (500) when object storage is unavailable", async () => {
    writeSpy.mockClear();
    const app = appMod.default;
    const bytes = randomBytes(4096);

    const startRes = await request(app)
      .post("/api/media/upload-session")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fileName: "ephemeral-scan.jpg",
        fileSize: bytes.length,
        mimeType: "image/jpeg",
      });
    expect([200, 201]).toContain(startRes.status);
    const sessionId = startRes.body.sessionId as string;
    expect(typeof sessionId).toBe("string");

    storageAvailable = false;
    try {
      const patchRes = await request(app)
        .patch(`/api/media/upload-session/${sessionId}`)
        .set("Authorization", `Bearer ${token}`)
        .set("Upload-Offset", "0")
        .set("Content-Type", "application/octet-stream")
        .send(bytes);

      // The finalize step must reject instead of reporting a phantom URL.
      expect(patchRes.status).toBe(500);
      expect(patchRes.body.url).toBeUndefined();
      expect(patchRes.body.complete).not.toBe(true);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      storageAvailable = true;
    }
  });
});
