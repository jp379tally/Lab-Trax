/**
 * Regression test for the blank legacy-mobile-case photo bug.
 *
 * Legacy mobile cases live in `lab_cases` and CANNOT have a `case_attachments`
 * row (its caseId FKs canonical `cases.id`). The media-upload endpoint still
 * hands back an `/api/cases/attachment-file/<f>` URL, but the serving route
 * historically 404'd anything without a `case_attachments` row — so every
 * photo on a legacy case rendered as a blank gray thumbnail. The nightly
 * orphan cleanup also trashed these files (no attachment reference).
 *
 * The fix binds each legacy file to its case in the `legacy_case_media` ledger
 * (first-writer-wins) on POST /legacy/cases, authorizes the serving route
 * against that ledger, and teaches the cleanup to treat ledger + live
 * lab_cases files as in-use. These tests assert:
 *   1. An owner can fetch a legacy case's media (200 + bytes).
 *   2. A cross-tenant user cannot (403).
 *   3. The orphan cleanup never trashes a ledger-bound file.
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
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

// Match the global hookTimeout so the orphan-cleanup test doesn't time out
// when api-server-tests and regression-tests run concurrently at merge time.
vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 });

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("GET /api/cases/attachment-file/:filename — legacy case media", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let caseMediaMod: typeof import("../lib/case-media.js");

  const ownerUserId = rid("uowner");
  const strangerUserId = rid("ustranger");
  const caseId = `${Date.now()}${randomBytes(4).toString("hex")}`;
  const crafterCaseId = `${Date.now()}${randomBytes(4).toString("hex")}c`;
  const fileName = `${rid("legacyphoto")}.jpg`;
  const fileBytes = randomBytes(2048);
  let filePath = "";
  let ownerToken = "";
  let strangerToken = "";

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const t = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(t).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt,
    });
    return t;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-media-serving";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");
    caseMediaMod = await import("../lib/case-media.js");

    const { db, users } = dbMod as any;
    await db.insert(users).values([
      { id: ownerUserId, username: `own_${ownerUserId}`, password: "x" },
      { id: strangerUserId, username: `str_${strangerUserId}`, password: "x" },
    ]);
    ownerToken = await makeSession(ownerUserId);
    strangerToken = await makeSession(strangerUserId);

    // Place a real file on disk where the upload endpoint would have stored it.
    await fsp.mkdir(caseMediaMod.caseMediaDir, { recursive: true });
    filePath = path.join(caseMediaMod.caseMediaDir, fileName);
    await fsp.writeFile(filePath, fileBytes);
  });

  // Refresh session tokens before every test so a concurrent user_sessions
  // wipe does not invalidate shared tokens mid-suite.
  beforeEach(async () => {
    ownerToken = await makeSession(ownerUserId);
    strangerToken = await makeSession(strangerUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, users, labCases, userSessions, legacyCaseMedia } = dbMod as any;
    await db.delete(legacyCaseMedia).where(eq(legacyCaseMedia.fileName, fileName));
    await db.delete(labCases).where(inArray(labCases.id, [caseId, crafterCaseId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [ownerUserId, strangerUserId]));
    await db.delete(users).where(inArray(users.id, [ownerUserId, strangerUserId]));
    try {
      await fsp.rm(filePath, { force: true });
    } catch {
      // ignore
    }
  });

  it("binds the file and serves it to the case owner (200 + bytes)", async () => {
    const app = appMod.default;

    // Create a legacy case whose caseData references the file via the
    // attachment-file URL form the upload endpoint returns.
    const caseData = {
      id: caseId,
      ownerId: ownerUserId,
      caseNumber: "26-MEDIA",
      patientName: "Media Test",
      status: "INTAKE",
      photos: [`/api/cases/attachment-file/${fileName}`],
      activityLog: [
        {
          id: "evt-photo",
          type: "photo",
          timestamp: 1000,
          description: "Photo added",
          imageUri: `/api/cases/attachment-file/${fileName}`,
        },
      ],
    };

    const createRes = await request(app)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ id: caseId, ownerId: ownerUserId, caseData });
    expect(createRes.status).toBe(200);

    // Ledger binding must exist (first-writer-wins).
    const { db, legacyCaseMedia } = dbMod as any;
    const [binding] = await db
      .select()
      .from(legacyCaseMedia)
      .where(eq(legacyCaseMedia.fileName, fileName));
    expect(binding).toBeTruthy();
    expect(binding.ownerId).toBe(ownerUserId);

    // Owner can fetch the bytes.
    const getRes = await request(app)
      .get(`/api/cases/attachment-file/${fileName}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(getRes.status).toBe(200);
    expect(Buffer.isBuffer(getRes.body)).toBe(true);
    expect((getRes.body as Buffer).equals(fileBytes)).toBe(true);
  });

  it("denies a cross-tenant user (403)", async () => {
    const app = appMod.default;
    const getRes = await request(app)
      .get(`/api/cases/attachment-file/${fileName}`)
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(getRes.status).toBe(403);
  });

  // The desktop/web client renders legacy photos via the id-based route using
  // the SYNTHETIC attachment id projected by the case-detail transform
  // (`legacy-photo-<caseId>-<idx>`). That id has no case_attachments row, so the
  // route must resolve it from the legacy case's own photos[] array. This was
  // the root cause of "can't see mobile pics on desktop/web".
  it("serves a synthetic legacy-photo id to the owner via the id-based route", async () => {
    const app = appMod.default;
    const getRes = await request(app)
      .get(`/api/cases/${caseId}/attachments/legacy-photo-${caseId}-0/file`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(getRes.status).toBe(200);
    expect(Buffer.isBuffer(getRes.body)).toBe(true);
    expect((getRes.body as Buffer).equals(fileBytes)).toBe(true);
  });

  it("denies a cross-tenant user on the synthetic id route (403)", async () => {
    const app = appMod.default;
    const getRes = await request(app)
      .get(`/api/cases/${caseId}/attachments/legacy-photo-${caseId}-0/file`)
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(getRes.status).toBe(403);
  });

  it("404s a synthetic id whose index is out of range", async () => {
    const app = appMod.default;
    const getRes = await request(app)
      .get(`/api/cases/${caseId}/attachments/legacy-photo-${caseId}-9/file`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(404);
  });

  // Confused-deputy guard: a stranger crafts THEIR OWN legacy case whose
  // photos[] references another tenant's filename, then requests it via the
  // synthetic id route. Case-level auth passes (they own the crafted case), so
  // the serving path MUST additionally enforce the legacy_case_media ledger
  // (which bound the file to the original owner) and deny — never serve.
  it("denies a crafted caseData referencing another tenant's file (403)", async () => {
    const app = appMod.default;
    const craftedData = {
      id: crafterCaseId,
      ownerId: strangerUserId,
      caseNumber: "26-CRAFT",
      patientName: "Crafted",
      status: "INTAKE",
      photos: [`/api/cases/attachment-file/${fileName}`],
    };
    const createRes = await request(app)
      .post("/api/legacy/cases")
      .set("Authorization", `Bearer ${strangerToken}`)
      .send({ id: crafterCaseId, ownerId: strangerUserId, caseData: craftedData });
    expect(createRes.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/cases/${crafterCaseId}/attachments/legacy-photo-${crafterCaseId}-0/file`)
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(getRes.status).toBe(403);
  });

  it("orphan cleanup never trashes a ledger-bound legacy file", async () => {
    // Re-write the file before running cleanup. When both the standalone
    // api-server-tests and the regression-tests workflows run concurrently
    // they share the same uploads/case-media directory — one suite's
    // cleanupOrphanedCaseMedia call can delete the other suite's file
    // before the ledger binding is persisted, so we can't rely on beforeAll
    // alone. Re-writing here is safe: the ledger row is already in the DB
    // (committed by the previous test in this suite).
    await fsp.mkdir(caseMediaMod.caseMediaDir, { recursive: true });
    await fsp.writeFile(filePath, fileBytes);

    const report = await caseMediaMod.cleanupOrphanedCaseMedia({ dryRun: false });
    expect(report.mediaDirExists).toBe(true);

    // File must still be present (protected by the ledger reference).
    await expect(fsp.access(filePath)).resolves.toBeUndefined();
  });

  it("fail-safe: skips deletion when a reference scan errors", async () => {
    // Root cause of the cross-suite flake: when a reference-gathering query
    // throws (e.g. transient DB pressure while two full-suite workflows hit
    // the same DB + uploads/case-media dir), the cleanup must NOT trash on an
    // incomplete reference set — doing so removed ledger-bound legacy media.
    // Force the first reference query to throw and assert the cleanup skips
    // the deletion phase entirely instead of trashing.
    const { db } = dbMod as any;
    const spy = vi.spyOn(db, "select").mockImplementation(() => {
      throw new Error("simulated reference scan failure");
    });
    try {
      const report = await caseMediaMod.cleanupOrphanedCaseMedia({
        dryRun: false,
      });
      expect(report.removedCount).toBe(0);
      expect(report.orphanCount).toBe(0);
      expect(
        report.errors.some((e: { error: string }) =>
          /reference scan incomplete/i.test(e.error),
        ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
