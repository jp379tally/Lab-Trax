/**
 * Regression test: POST /api/lab-inbox/finalize-session must verify that the
 * chunked-upload file actually landed in object storage before inserting a
 * DB row.  Without this guard, a failed or partial chunked upload would
 * create an inbox entry whose file is permanently missing after a server
 * restart (ephemeral disk wipe).
 *
 * Guard behaviour:
 *   - Object storage available + key exists   → 201 Created
 *   - Object storage available + key missing  → 409 Conflict (retry message)
 *   - Object storage unavailable              → 201 (guard is skipped)
 *
 * The object-storage and DB layers are mocked; no real bucket or Postgres
 * connection is required (DATABASE_URL gate is still applied so the test
 * is auto-skipped in environments without a DB).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { eq, inArray } from "drizzle-orm";
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

let storageAvailable = true;
let keyExists = true;
const writeSpy = vi.fn().mockResolvedValue(true);

vi.mock("../lib/case-media-object-storage.js", () => ({
  caseMediaObjectStorageAvailable: () => storageAvailable,
  caseMediaObjectStorageKeyExists: (_key: string) =>
    Promise.resolve(keyExists),
  writeCaseMediaToObjectStorage: (name: string, data: Buffer, ct: string) =>
    writeSpy(name, data, ct),
  openCaseMediaObjectStream: vi.fn().mockResolvedValue(null),
  deleteCaseMediaFromObjectStorage: vi.fn().mockResolvedValue(false),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;
const caseMediaDir = path.resolve(process.cwd(), "uploads", "case-media");

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("POST /api/lab-inbox/finalize-session — object storage existence guard", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authMod: typeof import("../lib/auth.js");

  const userId = rid("ufinalize");
  const labId = rid("lfinalize");
  let token = "";
  const directUploadFiles: string[] = [];

  async function makeSession(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const t = authMod.signAccessToken(uid, sessionId);
    const hash = createHash("sha256").update(t).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId: uid, tokenHash: hash, expiresAt });
    return t;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-finalize-guard";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authMod = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;
    await db.insert(users).values([{ id: userId, username: `fin_${userId}`, password: "x" }]);
    await db.insert(organizations).values([{ id: labId, name: "Finalize Test Lab", type: "lab" }]);
    await db.insert(organizationMemberships).values([{ userId, labId, status: "active", role: "admin" }]);
    token = await makeSession(userId);
  });

  beforeEach(async () => {
    token = await makeSession(userId);
    storageAvailable = true;
    keyExists = true;
    writeSpy.mockClear();
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, users, organizations, organizationMemberships, userSessions, labInboxFiles } = dbMod as any;
    await db.delete(labInboxFiles).where(eq(labInboxFiles.labOrganizationId, labId)).catch(() => {});
    for (const filename of directUploadFiles) {
      fs.rmSync(path.resolve(caseMediaDir, filename), { force: true });
    }
    await db.delete(organizationMemberships).where(eq(organizationMemberships.labId, labId)).catch(() => {});
    await db.delete(organizations).where(eq(organizations.id, labId)).catch(() => {});
    await db.delete(userSessions).where(inArray(userSessions.userId, [userId])).catch(() => {});
    await db.delete(users).where(inArray(users.id, [userId])).catch(() => {});
  });

  it("returns 201 when object storage is available and the key exists", async () => {
    storageAvailable = true;
    keyExists = true;

    const res = await request(appMod.default)
      .post("/api/lab-inbox/finalize-session")
      .set("Authorization", `Bearer ${token}`)
      .send({
        storagePath: "some-chunked-file.pdf",
        originalFilename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        labOrganizationId: labId,
        note: "  Check the occlusion  ",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.originalFilename).toBe("report.pdf");
    expect(res.body.data.objectStorageKey).toBe("some-chunked-file.pdf");
    expect(res.body.data.note).toBe("Check the occlusion");
  });

  it("rejects notes longer than 2000 characters", async () => {
    storageAvailable = false;
    const res = await request(appMod.default)
      .post("/api/lab-inbox/finalize-session")
      .set("Authorization", `Bearer ${token}`)
      .send({
        storagePath: "too-long.pdf",
        originalFilename: "too-long.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        labOrganizationId: labId,
        note: "x".repeat(2001),
      });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 409 when object storage is available but the key is missing", async () => {
    storageAvailable = true;
    keyExists = false;

    const res = await request(appMod.default)
      .post("/api/lab-inbox/finalize-session")
      .set("Authorization", `Bearer ${token}`)
      .send({
        storagePath: "missing-file.pdf",
        originalFilename: "missing.pdf",
        mimeType: "application/pdf",
        sizeBytes: 512,
        labOrganizationId: labId,
      });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/incomplete|retry/i);
  });

  it("returns 201 (no guard) when object storage is unavailable", async () => {
    storageAvailable = false;
    keyExists = false;

    const res = await request(appMod.default)
      .post("/api/lab-inbox/finalize-session")
      .set("Authorization", `Bearer ${token}`)
      .send({
        storagePath: "local-only-file.pdf",
        originalFilename: "local.pdf",
        mimeType: "application/pdf",
        sizeBytes: 256,
        labOrganizationId: labId,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.originalFilename).toBe("local.pdf");
  });

  it("trims and persists a note on direct multipart uploads", async () => {
    storageAvailable = false;
    const res = await request(appMod.default)
      .post("/api/lab-inbox/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("labOrganizationId", labId)
      .field("note", "  Photograph shows the occlusal surface.  ")
      .attach("file", Buffer.from("direct-upload"), "photo.jpg");

    expect(res.status).toBe(201);
    expect(res.body.data.note).toBe("Photograph shows the occlusal surface.");
    directUploadFiles.push(res.body.data.storagePath);
  });

  it("keeps direct uploads compatible when no note is supplied", async () => {
    storageAvailable = false;
    const res = await request(appMod.default)
      .post("/api/lab-inbox/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("labOrganizationId", labId)
      .attach("file", Buffer.from("direct-upload-without-note"), "scan.pdf");

    expect(res.status).toBe(201);
    expect(res.body.data.note).toBeNull();
    directUploadFiles.push(res.body.data.storagePath);
  });

  it("rejects an oversized direct-upload note", async () => {
    storageAvailable = false;
    const res = await request(appMod.default)
      .post("/api/lab-inbox/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("labOrganizationId", labId)
      .field("note", "x".repeat(2001))
      .attach("file", Buffer.from("oversized-note"), "too-long.pdf");

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});
