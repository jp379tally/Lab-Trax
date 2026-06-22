/**
 * Regression tests: lab-inbox assign + file-serve with object-storage-only uploads.
 *
 * The two bugs these tests guard against:
 *   1. POST /:fileId/assign returning HTTP 500 when the inbox file has no disk
 *      copy but a valid objectStorageKey (chunked/mobile upload path).
 *   2. GET  /:fileId/file returning HTTP 404 for the same class of file.
 *
 * A mobile-chunked upload never lands on disk in the API server's
 * `uploads/case-media/` directory — it only lives in object storage.  Both
 * endpoints must fall through to `openCaseMediaObjectStream` when the disk
 * path is absent.  These tests simulate that scenario by inserting inbox-file
 * rows whose `storagePath` names a file that does NOT exist on disk, then
 * asserting the correct response for three cases:
 *
 *   A. objectStorageKey resolves → 200 (serve) / 200 (assign)
 *   B. objectStorageKey set but object storage returns null (file gone) → 404
 *   C. objectStorageKey null (no storage reference at all) → 404
 *
 * Skipped when DATABASE_URL is unset (same convention as sibling route tests).
 * All inserted rows are cleaned up in afterAll.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/case-media.js")>();
  return { ...actual, startDailyOrphanedMediaCleanup: vi.fn() };
});

const openStreamSpy = vi.fn();
const writeSpy = vi.fn().mockResolvedValue(true);

vi.mock("../lib/case-media-object-storage.js", () => ({
  caseMediaObjectStorageAvailable: () => true,
  writeCaseMediaToObjectStorage: (
    name: string,
    data: Buffer,
    contentType: string,
  ) => writeSpy(name, data, contentType),
  openCaseMediaObjectStream: (key: string, mimeType?: string) =>
    openStreamSpy(key, mimeType),
  deleteCaseMediaFromObjectStorage: vi.fn().mockResolvedValue(false),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function makeReadableStream(content: Buffer): Readable {
  return Readable.from(content);
}

maybe("lab-inbox: object-storage-only file serve and assign", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const userId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const caseId = rid("case");

  const createdInboxFileIds: string[] = [];
  const createdCaseAttachmentIds: string[] = [];

  async function makeSession(uid: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const access = authLib.signAccessToken(uid, sessionId);
    const hash = createHash("sha256").update(access).digest("hex");
    await db.insert(userSessions).values({
      id: sessionId,
      userId: uid,
      tokenHash: hash,
      expiresAt,
    });
    return access;
  }

  async function insertInboxFile(opts: {
    storagePath: string;
    objectStorageKey: string | null;
  }) {
    const { db, labInboxFiles } = dbMod as any;
    const [row] = await db
      .insert(labInboxFiles)
      .values({
        labOrganizationId: labOrgId,
        uploadedByUserId: userId,
        originalFilename: "test-scan.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1024,
        storagePath: opts.storagePath,
        objectStorageKey: opts.objectStorageKey,
      })
      .returning();
    createdInboxFileIds.push(row.id);
    return row as { id: string };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-inbox-objstorage";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const {
      db,
      users,
      organizations,
      organizationMemberships,
      cases: casesTable,
    } = dbMod as any;

    await db.insert(users).values({
      id: userId,
      username: `inbox_obj_${userId}`,
      password: "x",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("InboxObjLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("InboxObjPractice"),
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: labOrgId,
      userId,
      role: "owner",
      status: "active",
      approvedByUserId: userId,
      joinedAt: new Date(),
    });

    await db.insert(casesTable).values({
      id: caseId,
      caseNumber: rid("CN"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Test",
      patientLastName: "Patient",
      doctorName: "Dr. Test",
      status: "received",
      createdByUserId: userId,
    });
  });

  let token = "";
  beforeEach(async () => {
    token = await makeSession(userId);
    openStreamSpy.mockReset();
    writeSpy.mockReset();
    writeSpy.mockResolvedValue(true);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      caseEvents,
      caseAttachments,
      labInboxFiles,
      cases: casesTable,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    if (createdCaseAttachmentIds.length) {
      await db
        .delete(caseAttachments)
        .where(inArray(caseAttachments.id, createdCaseAttachmentIds));
    }
    if (createdInboxFileIds.length) {
      await db
        .delete(labInboxFiles)
        .where(inArray(labInboxFiles.id, createdInboxFileIds));
    }
    await db
      .delete(caseEvents)
      .where(eq(caseEvents.caseId, caseId));
    await db
      .delete(casesTable)
      .where(eq(casesTable.id, caseId));
    await db
      .delete(userSessions)
      .where(eq(userSessions.userId, userId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId));
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  // ── GET /:fileId/file ────────────────────────────────────────────────────

  describe("GET /:fileId/file", () => {
    it("returns 200 and streams content when disk is missing but objectStorageKey resolves", async () => {
      const fileContent = randomBytes(512);
      openStreamSpy.mockResolvedValue({
        stream: makeReadableStream(fileContent),
        contentType: "image/jpeg",
      });

      const inboxFile = await insertInboxFile({
        storagePath: `nonexistent-disk-${rid("f")}.jpg`,
        objectStorageKey: `obj-key-${rid("k")}.jpg`,
      });

      const res = await request(appMod.default)
        .get(`/api/lab-inbox/${inboxFile.id}/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/image\/jpeg/);
      expect(openStreamSpy).toHaveBeenCalledTimes(1);
      expect(Buffer.from(res.body).equals(fileContent)).toBe(true);
    });

    it("returns 404 when disk is missing and objectStorageKey resolves to null (file gone from storage)", async () => {
      openStreamSpy.mockResolvedValue(null);

      const inboxFile = await insertInboxFile({
        storagePath: `nonexistent-disk-${rid("f")}.jpg`,
        objectStorageKey: `obj-key-gone-${rid("k")}.jpg`,
      });

      const res = await request(appMod.default)
        .get(`/api/lab-inbox/${inboxFile.id}/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it("returns 404 when disk is missing and objectStorageKey is null", async () => {
      const inboxFile = await insertInboxFile({
        storagePath: `nonexistent-disk-${rid("f")}.jpg`,
        objectStorageKey: null,
      });

      const res = await request(appMod.default)
        .get(`/api/lab-inbox/${inboxFile.id}/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(openStreamSpy).not.toHaveBeenCalled();
    });
  });

  // ── POST /:fileId/assign ─────────────────────────────────────────────────

  describe("POST /:fileId/assign", () => {
    it("returns 200 and creates an attachment when disk is missing but objectStorageKey resolves", async () => {
      const fileContent = randomBytes(256);
      openStreamSpy.mockResolvedValue({
        stream: makeReadableStream(fileContent),
        contentType: "image/jpeg",
      });

      const inboxFile = await insertInboxFile({
        storagePath: `nonexistent-disk-${rid("f")}.jpg`,
        objectStorageKey: `obj-key-${rid("k")}.jpg`,
      });

      const res = await request(appMod.default)
        .post(`/api/lab-inbox/${inboxFile.id}/assign`)
        .set("Authorization", `Bearer ${token}`)
        .send({ caseId });

      expect(res.status).toBe(200);
      expect(res.body.data.caseId).toBe(caseId);
      expect(typeof res.body.data.attachmentId).toBe("string");
      createdCaseAttachmentIds.push(res.body.data.attachmentId);

      expect(openStreamSpy).toHaveBeenCalledTimes(1);
    });

    it("returns 404 when disk is missing and objectStorageKey resolves to null (file gone)", async () => {
      openStreamSpy.mockResolvedValue(null);

      const inboxFile = await insertInboxFile({
        storagePath: `nonexistent-disk-${rid("f")}.jpg`,
        objectStorageKey: `obj-key-gone-${rid("k")}.jpg`,
      });

      const res = await request(appMod.default)
        .post(`/api/lab-inbox/${inboxFile.id}/assign`)
        .set("Authorization", `Bearer ${token}`)
        .send({ caseId });

      expect(res.status).toBe(404);
    });

    it("returns 404 when disk is missing and objectStorageKey is null", async () => {
      const inboxFile = await insertInboxFile({
        storagePath: `nonexistent-disk-${rid("f")}.jpg`,
        objectStorageKey: null,
      });

      const res = await request(appMod.default)
        .post(`/api/lab-inbox/${inboxFile.id}/assign`)
        .set("Authorization", `Bearer ${token}`)
        .send({ caseId });

      expect(res.status).toBe(404);
      expect(openStreamSpy).not.toHaveBeenCalled();
    });

    it("returns 409 when the inbox file was already assigned", async () => {
      const fileContent = randomBytes(128);
      openStreamSpy.mockResolvedValue({
        stream: makeReadableStream(fileContent),
        contentType: "image/jpeg",
      });

      const inboxFile = await insertInboxFile({
        storagePath: `nonexistent-disk-${rid("f")}.jpg`,
        objectStorageKey: `obj-key-${rid("k")}.jpg`,
      });

      const first = await request(appMod.default)
        .post(`/api/lab-inbox/${inboxFile.id}/assign`)
        .set("Authorization", `Bearer ${token}`)
        .send({ caseId });

      expect(first.status).toBe(200);
      createdCaseAttachmentIds.push(first.body.data.attachmentId);

      openStreamSpy.mockResolvedValue({
        stream: makeReadableStream(fileContent),
        contentType: "image/jpeg",
      });
      const second = await request(appMod.default)
        .post(`/api/lab-inbox/${inboxFile.id}/assign`)
        .set("Authorization", `Bearer ${token}`)
        .send({ caseId });

      expect(second.status).toBe(409);
    });
  });
});
