/**
 * Regression tests: lab-inbox storagePath normalization.
 *
 * Bug: the mobile client finalized inbox uploads with the full public media
 * URL (e.g. `https://host/api/cases/attachment-file/<file>`) as storagePath,
 * and /finalize-session stored that raw value as BOTH storagePath and
 * objectStorageKey.  The serving route then resolved
 * `path.resolve(caseMediaDir, <url>)` and opened object storage with the raw
 * URL, so those rows could never be opened ("Could not open file" on desktop).
 *
 * Fixes under test:
 *   1. POST /finalize-session normalizes URL-shaped storagePath to the bare
 *      stored filename before the existence check AND before the DB insert.
 *   2. POST /finalize-session rejects values that cannot be reduced to a safe
 *      bare filename (external URLs, empty basenames) with 400.
 *   3. GET /:fileId/file applies read-time normalization so legacy rows whose
 *      storagePath/objectStorageKey are URL-shaped still open when the
 *      underlying object exists (no migration required).
 *   4. POST /:fileId/assign applies the same read-time normalization, so
 *      assignment still works for legacy URL-shaped rows.
 *
 * Object-storage layer is mocked; DB rows are real (skipped without
 * DATABASE_URL, same convention as sibling route tests).
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
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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

const keyExistsSpy = vi.fn();
const openStreamSpy = vi.fn();
const writeSpy = vi.fn().mockResolvedValue(true);

vi.mock("../lib/case-media-object-storage.js", () => ({
  caseMediaObjectStorageAvailable: () => true,
  caseMediaObjectStorageKeyExists: (key: string) => keyExistsSpy(key),
  writeCaseMediaToObjectStorage: (name: string, data: Buffer, ct: string) =>
    writeSpy(name, data, ct),
  openCaseMediaObjectStream: (key: string, mimeType?: string) =>
    openStreamSpy(key, mimeType),
  deleteCaseMediaFromObjectStorage: vi.fn().mockResolvedValue(false),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("lab-inbox storagePath normalization", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const userId = rid("unorm");
  const labOrgId = rid("labnorm");
  const providerOrgId = rid("provnorm");
  const caseId = rid("casenorm");

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
    mimeType?: string;
  }) {
    const { db, labInboxFiles } = dbMod as any;
    const [row] = await db
      .insert(labInboxFiles)
      .values({
        labOrganizationId: labOrgId,
        uploadedByUserId: userId,
        originalFilename: "legacy-scan.pdf",
        mimeType: opts.mimeType ?? "application/pdf",
        sizeBytes: 2048,
        storagePath: opts.storagePath,
        objectStorageKey: opts.objectStorageKey,
      })
      .returning();
    createdInboxFileIds.push(row.id);
    return row as { id: string };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-inbox-normalize";
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
      username: `inbox_norm_${userId}`,
      password: "x",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("InboxNormLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("InboxNormPractice"),
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
      patientFirstName: "Norm",
      patientLastName: "Patient",
      doctorName: "Dr. Norm",
      status: "received",
      createdByUserId: userId,
    });
  });

  let token = "";
  beforeEach(async () => {
    token = await makeSession(userId);
    keyExistsSpy.mockReset();
    keyExistsSpy.mockResolvedValue(true);
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
    await db
      .delete(labInboxFiles)
      .where(eq(labInboxFiles.labOrganizationId, labOrgId));
    await db.delete(caseEvents).where(eq(caseEvents.caseId, caseId));
    await db.delete(casesTable).where(eq(casesTable.id, caseId));
    await db.delete(userSessions).where(eq(userSessions.userId, userId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId));
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  // ── POST /finalize-session ────────────────────────────────────────────────

  describe("POST /finalize-session", () => {
    it("stores the normalized bare filename when the client sends a full public URL", async () => {
      const bare = `173-abcd1234-mobile-scan.pdf`;
      const url = `https://lab.example.com/api/cases/attachment-file/${bare}`;

      const res = await request(appMod.default)
        .post("/api/lab-inbox/finalize-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          storagePath: url,
          originalFilename: "mobile-scan.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          labOrganizationId: labOrgId,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.storagePath).toBe(bare);
      expect(res.body.data.objectStorageKey).toBe(bare);
      createdInboxFileIds.push(res.body.data.id);

      // Existence check must run against the normalized name, not the URL.
      expect(keyExistsSpy).toHaveBeenCalledWith(bare);
    });

    it("also normalizes /uploads/case-media/-shaped URLs", async () => {
      const bare = `173-ef567890-scan.jpg`;
      const url = `https://lab.example.com/uploads/case-media/${bare}`;

      const res = await request(appMod.default)
        .post("/api/lab-inbox/finalize-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          storagePath: url,
          originalFilename: "scan.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 512,
          labOrganizationId: labOrgId,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.storagePath).toBe(bare);
      expect(res.body.data.objectStorageKey).toBe(bare);
      createdInboxFileIds.push(res.body.data.id);
    });

    it("keeps a bare filename as-is (desktop/web path unchanged)", async () => {
      const bare = `173-99aa88bb-desktop-upload.pdf`;

      const res = await request(appMod.default)
        .post("/api/lab-inbox/finalize-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          storagePath: bare,
          originalFilename: "desktop-upload.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4096,
          labOrganizationId: labOrgId,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.storagePath).toBe(bare);
      expect(res.body.data.objectStorageKey).toBe(bare);
      createdInboxFileIds.push(res.body.data.id);
    });

    it("returns 400 for an external URL that has no media marker", async () => {
      const res = await request(appMod.default)
        .post("/api/lab-inbox/finalize-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          storagePath: "https://evil.example.com/some/other/file.pdf",
          originalFilename: "file.pdf",
          mimeType: "application/pdf",
          sizeBytes: 128,
          labOrganizationId: labOrgId,
        });

      expect(res.status).toBe(400);
      expect(keyExistsSpy).not.toHaveBeenCalled();
    });

    it("returns 400 when the URL normalizes to an empty filename", async () => {
      const res = await request(appMod.default)
        .post("/api/lab-inbox/finalize-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          storagePath: "https://lab.example.com/uploads/case-media/",
          originalFilename: "x.pdf",
          mimeType: "application/pdf",
          sizeBytes: 128,
          labOrganizationId: labOrgId,
        });

      expect(res.status).toBe(400);
      expect(keyExistsSpy).not.toHaveBeenCalled();
    });

    it("still 409s when the normalized object is missing from storage", async () => {
      keyExistsSpy.mockResolvedValue(false);

      const res = await request(appMod.default)
        .post("/api/lab-inbox/finalize-session")
        .set("Authorization", `Bearer ${token}`)
        .send({
          storagePath:
            "https://lab.example.com/api/cases/attachment-file/never-uploaded.pdf",
          originalFilename: "never-uploaded.pdf",
          mimeType: "application/pdf",
          sizeBytes: 128,
          labOrganizationId: labOrgId,
        });

      expect(res.status).toBe(409);
      expect(keyExistsSpy).toHaveBeenCalledWith("never-uploaded.pdf");
    });
  });

  // ── GET /:fileId/file — legacy URL-shaped rows ────────────────────────────

  describe("GET /:fileId/file (legacy URL-shaped rows)", () => {
    it("serves a legacy row whose storagePath and objectStorageKey are full URLs", async () => {
      const bare = `legacy-${rid("f")}.pdf`;
      const url = `https://lab.example.com/api/cases/attachment-file/${bare}`;
      const fileContent = randomBytes(256);
      openStreamSpy.mockResolvedValue({
        stream: Readable.from(fileContent),
        contentType: "application/pdf",
      });

      const inboxFile = await insertInboxFile({
        storagePath: url,
        objectStorageKey: url,
      });

      const res = await request(appMod.default)
        .get(`/api/lab-inbox/${inboxFile.id}/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/pdf/);
      expect(res.headers["content-disposition"]).toMatch(/^inline/);
      // Object storage must be opened with the NORMALIZED key.
      expect(openStreamSpy).toHaveBeenCalledWith(bare, "application/pdf");
      expect(Buffer.from(res.body).equals(fileContent)).toBe(true);
    });

    it("falls back to normalized storagePath when objectStorageKey is null", async () => {
      const bare = `legacy-null-key-${rid("f")}.jpg`;
      const url = `https://lab.example.com/uploads/case-media/${bare}`;
      const fileContent = randomBytes(128);
      openStreamSpy.mockResolvedValue({
        stream: Readable.from(fileContent),
        contentType: "image/jpeg",
      });

      const inboxFile = await insertInboxFile({
        storagePath: url,
        objectStorageKey: null,
        mimeType: "image/jpeg",
      });

      const res = await request(appMod.default)
        .get(`/api/lab-inbox/${inboxFile.id}/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(openStreamSpy).toHaveBeenCalledWith(bare, "image/jpeg");
    });

    it("returns a clean 404 when the normalized object does not exist in storage", async () => {
      openStreamSpy.mockResolvedValue(null);

      const inboxFile = await insertInboxFile({
        storagePath: `https://lab.example.com/api/cases/attachment-file/gone-${rid("f")}.pdf`,
        objectStorageKey: null,
      });

      const res = await request(appMod.default)
        .get(`/api/lab-inbox/${inboxFile.id}/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it("returns 404 without touching storage when nothing normalizes (external URL row)", async () => {
      const inboxFile = await insertInboxFile({
        storagePath: "https://evil.example.com/x/y.pdf",
        objectStorageKey: "https://evil.example.com/x/y.pdf",
      });

      const res = await request(appMod.default)
        .get(`/api/lab-inbox/${inboxFile.id}/file`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(openStreamSpy).not.toHaveBeenCalled();
    });
  });

  // ── POST /:fileId/assign — legacy URL-shaped rows ─────────────────────────

  describe("POST /:fileId/assign (legacy URL-shaped rows)", () => {
    it("assigns a legacy URL-shaped row via the normalized object-storage key", async () => {
      const bare = `legacy-assign-${rid("f")}.pdf`;
      const url = `https://lab.example.com/api/cases/attachment-file/${bare}`;
      const fileContent = randomBytes(64);
      openStreamSpy.mockResolvedValue({
        stream: Readable.from(fileContent),
        contentType: "application/pdf",
      });

      const inboxFile = await insertInboxFile({
        storagePath: url,
        objectStorageKey: url,
      });

      const res = await request(appMod.default)
        .post(`/api/lab-inbox/${inboxFile.id}/assign`)
        .set("Authorization", `Bearer ${token}`)
        .send({ caseId });

      expect(res.status).toBe(200);
      expect(res.body.data.caseId).toBe(caseId);
      createdCaseAttachmentIds.push(res.body.data.attachmentId);
      expect(openStreamSpy).toHaveBeenCalledWith(bare, "application/pdf");
    });
  });
});
