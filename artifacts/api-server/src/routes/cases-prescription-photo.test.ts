/**
 * End-to-end regression: Mobile AI Reader prescription image → web/desktop visibility.
 *
 * Protected workflow: "Mobile Prescription Image Cross-Platform Visibility"
 *
 * Verifies the full chain in one focused suite:
 *
 *   (1) Case creation  — POST /api/legacy/cases stores a mobile case in lab_cases
 *                        and is retrievable via GET /api/cases (_source:"mobile").
 *   (2) Photo upload   — POST /api/cases/:caseId/attachments (simulating
 *                        uploadPhotoAndCreateAttachment) creates a caseAttachments
 *                        row with labCaseId referencing the mobile case.
 *   (3) DB integrity   — attachment row has correct labCaseId + image/jpeg fileType.
 *   (4) List endpoint  — GET /api/cases/:caseId/attachments returns the image
 *                        (this is what the web/desktop Files tab queries).
 *   (5) File serving   — GET /api/cases/:caseId/attachments/:attachmentId/file
 *                        passes auth and returns 404 (file not on test disk, not
 *                        in object storage) — NOT 401 or 403. A 401/403 here would
 *                        mean the attachment is invisible to the web/desktop client.
 *   (6) Invoice        — POST /api/invoices/cases/:caseId/generate-invoice creates
 *                        an invoice for the same case (zero regression on invoice).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import request from "supertest";
import { vi } from "vitest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/case-media.js")>();
  return {
    ...actual,
    startDailyOrphanedMediaCleanup: vi.fn(),
    caseMediaDir: path.join(os.tmpdir(), "labtrax-test-rx-photo"),
  };
});

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

maybe(
  "Mobile prescription photo → web/desktop visibility (end-to-end)",
  () => {
    let dbMod: typeof import("@workspace/db");
    let appMod: { default: import("express").Express };
    let auth: typeof import("../lib/auth.js");

    const labOrgId = rid("lab");
    const userId = rid("upx");
    let token = "";

    const caseId = rid("rxcase");
    const caseNumber = `26-RX-${randomBytes(4).toString("hex")}`;

    const photoFileName = `rx-photo-${randomBytes(6).toString("hex")}.jpg`;
    const photoStorageKey = `/uploads/case-media/${photoFileName}`;
    const photoFileType = "image/jpeg";

    let attachmentId = "";

    async function makeSession(uid: string): Promise<string> {
      const { db, userSessions } = dbMod as any;
      const sessionId = rid("sess");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const t = auth.signAccessToken(uid, sessionId);
      const hash = createHash("sha256").update(t).digest("hex");
      await db
        .insert(userSessions)
        .values({ id: sessionId, userId: uid, tokenHash: hash, expiresAt });
      return t;
    }

    beforeAll(async () => {
      fs.mkdirSync(
        path.join(os.tmpdir(), "labtrax-test-rx-photo"),
        { recursive: true }
      );
      process.env["JWT_SECRET"] =
        process.env["JWT_SECRET"] ?? "labtrax-test-secret-rxphoto";

      dbMod = await import("@workspace/db");
      appMod = await import("../app.js");
      auth = await import("../lib/auth.js");

      const { db, users, organizations, organizationMemberships } =
        dbMod as any;

      await db
        .insert(users)
        .values([{ id: userId, username: `rxpx_${userId}`, password: "x" }]);
      await db
        .insert(organizations)
        .values([{ id: labOrgId, type: "lab", name: "Rx Photo Test Lab" }]);
      await db.insert(organizationMemberships).values([
        {
          id: rid("m"),
          labId: labOrgId,
          userId,
          role: "admin",
          status: "active",
        },
      ]);

      token = await makeSession(userId);
    });

    afterAll(async () => {
      if (!SHOULD_RUN) return;
      const {
        db,
        users,
        organizations,
        organizationMemberships,
        labCases,
        caseAttachments,
        legacyCaseMedia,
        invoices,
        userSessions,
        auditLogs,
      } = dbMod as any;

      await db
        .delete(auditLogs)
        .where(eq(auditLogs.organizationId, labOrgId));
      await db
        .delete(invoices)
        .where(eq(invoices.labOrganizationId, labOrgId));
      await db
        .delete(caseAttachments)
        .where(eq(caseAttachments.labCaseId, caseId));
      await db
        .delete(legacyCaseMedia)
        .where(eq(legacyCaseMedia.labCaseId, caseId));
      await db.delete(labCases).where(eq(labCases.id, caseId));
      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.userId, userId));
      await db.delete(userSessions).where(eq(userSessions.userId, userId));
      await db.delete(organizations).where(eq(organizations.id, labOrgId));
      await db.delete(users).where(eq(users.id, userId));
    });

    // ── (1) Case creation ────────────────────────────────────────────────────
    it("(1) POST /api/legacy/cases stores the mobile case in lab_cases", async () => {
      const caseBlob = {
        id: caseId,
        caseNumber,
        patientName: "Yasmin Newsom",
        doctorName: "Dr. Chinara Garraway",
        toothIndices: "#8, #9",
        shade: "A1",
        material: "Zirconia",
        caseType: "crown",
        status: "INTAKE",
        affiliationKey: `org:${labOrgId}`,
      };

      const res = await request(appMod.default)
        .post("/api/legacy/cases")
        .set("Authorization", `Bearer ${token}`)
        .send({ id: caseId, ownerId: userId, caseData: JSON.stringify(caseBlob) });

      expect(res.status).toBe(200);

      const { db, labCases } = dbMod as any;
      const row = await db.query.labCases.findFirst({
        where: eq(labCases.id, caseId),
      });
      expect(row, "lab_cases row must exist after sync").toBeDefined();
      expect(row.organizationId).toBe(labOrgId);
      const parsed = JSON.parse(row.caseData as string);
      expect(parsed.patientName).toBe("Yasmin Newsom");
    });

    it("(1b) GET /api/cases includes the mobile case with _source:'mobile'", async () => {
      const res = await request(appMod.default)
        .get("/api/cases")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const cases: any[] = res.body.data ?? res.body;
      const found = cases.find((c: any) => c.id === caseId);
      expect(found, "mobile case must appear in GET /api/cases").toBeDefined();
      expect(found._source).toBe("mobile");
      expect(found.labOrganizationId).toBe(labOrgId);
    });

    // ── (2) Photo upload ─────────────────────────────────────────────────────
    it("(2) POST /api/cases/:caseId/attachments creates an image/jpeg attachment for the legacy case", async () => {
      const res = await request(appMod.default)
        .post(`/api/cases/${caseId}/attachments`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          storageKey: photoStorageKey,
          fileName: photoFileName,
          fileType: photoFileType,
          visibility: "shared_with_provider",
        });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      attachmentId = res.body.data?.id;
      expect(attachmentId, "attachment id must be present in response").toBeTruthy();
      expect(res.body.data.fileType).toBe(photoFileType);
      expect(res.body.data.labCaseId).toBe(caseId);
    });

    // ── (3) DB integrity ─────────────────────────────────────────────────────
    it("(3) caseAttachments row has labCaseId matching the mobile Case ID and correct fileType", async () => {
      expect(attachmentId, "depends on test (2)").toBeTruthy();

      const { db, caseAttachments } = dbMod as any;
      const row = await db.query.caseAttachments.findFirst({
        where: eq(caseAttachments.id, attachmentId),
      });

      expect(row, "caseAttachments row must exist in DB").toBeDefined();
      expect(row.labCaseId).toBe(caseId);
      expect(row.fileType).toBe(photoFileType);
      expect(row.storageKey).toBe(photoStorageKey);
      // caseId FK must be null — this is a legacy mobile attachment, not canonical.
      expect(row.caseId).toBeNull();
    });

    // ── (4) List endpoint (web/desktop Files tab) ────────────────────────────
    it("(4) GET /api/cases/:caseId/attachments returns the image attachment (web/desktop Files tab)", async () => {
      expect(attachmentId, "depends on test (2)").toBeTruthy();

      const res = await request(appMod.default)
        .get(`/api/cases/${caseId}/attachments`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const list: any[] = res.body.data ?? res.body ?? [];
      const found = (Array.isArray(list) ? list : []).find(
        (a: any) => a.id === attachmentId
      );
      expect(found, "uploaded photo must appear in GET /api/cases/:caseId/attachments").toBeDefined();
      expect(found.fileType).toBe(photoFileType);
      expect(found.fileName).toBe(photoFileName);
    });

    // ── (5) File-serving endpoint ────────────────────────────────────────────
    it("(5) GET /api/cases/:caseId/attachments/:attachmentId/file passes auth (returns 404 for missing file, NOT 401 or 403)", async () => {
      expect(attachmentId, "depends on test (2)").toBeTruthy();

      const res = await request(appMod.default)
        .get(`/api/cases/${caseId}/attachments/${attachmentId}/file`)
        .set("Authorization", `Bearer ${token}`);

      // 404 means the route found the attachment, authorized the request, but
      // the file does not exist on the test-environment disk or in object
      // storage. Any 401 or 403 would mean the image is invisible on web/desktop.
      expect([404, 200]).toContain(res.status);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("(5b) GET /api/cases/:caseId/attachments/:attachmentId/file returns 401 when unauthenticated", async () => {
      expect(attachmentId, "depends on test (2)").toBeTruthy();

      const res = await request(appMod.default)
        .get(`/api/cases/${caseId}/attachments/${attachmentId}/file`);

      expect(res.status).toBe(401);
    });

    // ── (6) Invoice generation ───────────────────────────────────────────────
    it("(6) POST /api/invoices/cases/:caseId/generate-invoice creates an invoice for the same case", async () => {
      const res = await request(appMod.default)
        .post(`/api/invoices/cases/${caseId}/generate-invoice`)
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect([200, 201]).toContain(res.status);

      const invoiceData = res.body.data ?? res.body;
      expect(invoiceData).toBeDefined();
      expect(invoiceData.labOrganizationId).toBe(labOrgId);
      expect(typeof invoiceData.invoiceNumber).toBe("string");

      const { db, invoices } = dbMod as any;
      const row = await db.query.invoices.findFirst({
        where: eq(invoices.id, invoiceData.id),
      });
      expect(row, "invoice row must exist in DB").toBeDefined();
      expect(row.labOrganizationId).toBe(labOrgId);
    });
  }
);
