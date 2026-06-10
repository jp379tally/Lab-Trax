/**
 * Integration tests for POST /api/cases/:caseId/attachments — legacy branch.
 *
 * The endpoint handles two code paths:
 *   1. Desktop (canonical) cases — looks up via `cases` table.
 *   2. Legacy mobile cases — falls back to `lab_cases` when the canonical
 *      lookup returns 404.
 *
 * These tests exercise path (2): attaching a file to a legacy lab_cases row.
 * The critical invariant is that each successful POST appends a "document"
 * activityLog entry to lab_cases.caseData so the mobile History tab reflects
 * attachments added from the desktop.
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe(
  "POST /api/cases/:caseId/attachments — legacy lab_cases branch",
  () => {
    let dbMod: typeof import("@workspace/db");
    let appMod: { default: import("express").Express };
    let auth: typeof import("../lib/auth.js");

    const orgId = rid("org");
    const memberUserId = rid("umem");
    const outsiderUserId = rid("uout");
    const legacyCaseId = `legacycase_${randomBytes(8).toString("hex")}`;

    const tokens = { member: "", outsider: "" };

    async function makeSession(userId: string): Promise<string> {
      const { db, userSessions } = dbMod as any;
      const sessionId = rid("sess");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const token = auth.signAccessToken(userId, sessionId);
      const hash = createHash("sha256").update(token).digest("hex");
      await db.insert(userSessions).values({
        id: sessionId,
        userId,
        tokenHash: hash,
        expiresAt,
      });
      return token;
    }

    beforeAll(async () => {
      process.env["JWT_SECRET"] =
        process.env["JWT_SECRET"] ?? "labtrax-test-secret-attachments";
      dbMod = await import("@workspace/db");
      appMod = await import("../app.js");
      auth = await import("../lib/auth.js");

      const { db, users, organizations, organizationMemberships, labCases } =
        dbMod as any;

      await db.insert(users).values([
        { id: memberUserId, username: `mem_${memberUserId}`, password: "x" },
        { id: outsiderUserId, username: `out_${outsiderUserId}`, password: "x" },
      ]);

      await db.insert(organizations).values([
        { id: orgId, type: "lab", name: "Attachment Test Lab" },
      ]);

      await db.insert(organizationMemberships).values([
        {
          id: rid("mbr"),
          labId: orgId,
          userId: memberUserId,
          role: "admin",
          status: "active",
        },
      ]);

      // Seed a legacy case with empty caseData (plain JSON object string).
      await db.insert(labCases).values({
        id: legacyCaseId,
        ownerId: memberUserId,
        organizationId: orgId,
        caseData: "{}",
      });

      tokens.member = await makeSession(memberUserId);
      tokens.outsider = await makeSession(outsiderUserId);
    });

    afterAll(async () => {
      if (!SHOULD_RUN) return;
      const {
        db,
        users,
        organizations,
        organizationMemberships,
        labCases,
        legacyCaseMedia,
        caseAttachments,
        userSessions,
        auditLogs,
      } = dbMod as any;

      await db
        .delete(auditLogs)
        .where(eq(auditLogs.organizationId, orgId));
      await db
        .delete(caseAttachments)
        .where(eq(caseAttachments.labCaseId, legacyCaseId));
      await db
        .delete(legacyCaseMedia)
        .where(eq(legacyCaseMedia.labCaseId, legacyCaseId));
      await db.delete(labCases).where(eq(labCases.id, legacyCaseId));
      await db
        .delete(organizationMemberships)
        .where(
          inArray(organizationMemberships.userId, [
            memberUserId,
            outsiderUserId,
          ])
        );
      await db
        .delete(userSessions)
        .where(
          inArray(userSessions.userId, [memberUserId, outsiderUserId])
        );
      await db
        .delete(organizations)
        .where(eq(organizations.id, orgId));
      await db
        .delete(users)
        .where(inArray(users.id, [memberUserId, outsiderUserId]));
    });

    it(
      "happy path: returns 201 with the attachment and appends a document entry to activityLog",
      async () => {
        const app = appMod.default;
        const { db, labCases, caseAttachments } = dbMod as any;

        const fileName = "implant-spec.pdf";
        const storageKey = `/uploads/case-media/${fileName}`;
        const fileType = "application/pdf";

        const res = await request(app)
          .post(`/api/cases/${legacyCaseId}/attachments`)
          .set("Authorization", `Bearer ${tokens.member}`)
          .send({ storageKey, fileName, fileType, visibility: "internal_lab_only" });

        expect(res.status).toBe(201);
        expect(res.body.ok).toBe(true);

        const attachment = res.body.data;
        expect(attachment).toBeDefined();
        expect(attachment.fileName).toBe(fileName);
        expect(attachment.storageKey).toBe(storageKey);
        expect(attachment.fileType).toBe(fileType);
        expect(attachment.labCaseId).toBe(legacyCaseId);
        expect(attachment.id).toBeTruthy();

        // Verify the activityLog entry was appended to lab_cases.caseData.
        const row = await db.query.labCases.findFirst({
          where: eq(labCases.id, legacyCaseId),
        });
        expect(row).toBeDefined();
        const caseData = JSON.parse(row.caseData as string);
        expect(Array.isArray(caseData.activityLog)).toBe(true);

        const docEntry = (caseData.activityLog as any[]).find(
          (e: any) => e.type === "document"
        );
        expect(docEntry).toBeDefined();
        expect(docEntry.type).toBe("document");
        expect(docEntry.description).toBe(fileName);
        expect(docEntry.attachmentId).toBe(attachment.id);
        expect(docEntry.fileType).toBe(fileType);
        expect(docEntry.imageUri).toBe(storageKey);
        expect(typeof docEntry.timestamp).toBe("number");
      }
    );

    it(
      "appends a second document entry when a second file is attached (no clobber)",
      async () => {
        const app = appMod.default;
        const { db, labCases } = dbMod as any;

        const fileName2 = "shade-guide.jpg";
        const storageKey2 = `/uploads/case-media/${fileName2}`;
        const fileType2 = "image/jpeg";

        const res = await request(app)
          .post(`/api/cases/${legacyCaseId}/attachments`)
          .set("Authorization", `Bearer ${tokens.member}`)
          .send({ storageKey: storageKey2, fileName: fileName2, fileType: fileType2 });

        expect(res.status).toBe(201);

        const row = await db.query.labCases.findFirst({
          where: eq(labCases.id, legacyCaseId),
        });
        const caseData = JSON.parse(row.caseData as string);
        const docEntries = (caseData.activityLog as any[]).filter(
          (e: any) => e.type === "document"
        );
        // Both the first and second attachments must appear as document entries.
        expect(docEntries.length).toBeGreaterThanOrEqual(2);

        const second = docEntries.find(
          (e: any) => e.description === fileName2
        );
        expect(second).toBeDefined();
        expect(second.fileType).toBe(fileType2);
        expect(second.attachmentId).toBe(res.body.data.id);
      }
    );

    it("returns 401 when no Authorization header is provided", async () => {
      const app = appMod.default;
      const res = await request(app)
        .post(`/api/cases/${legacyCaseId}/attachments`)
        .send({
          storageKey: "/uploads/case-media/unauth.pdf",
          fileName: "unauth.pdf",
          fileType: "application/pdf",
        });

      expect(res.status).toBe(401);
    });

    it(
      "returns 403 when the caller is not a member of the case's organization",
      async () => {
        const app = appMod.default;
        const res = await request(app)
          .post(`/api/cases/${legacyCaseId}/attachments`)
          .set("Authorization", `Bearer ${tokens.outsider}`)
          .send({
            storageKey: "/uploads/case-media/outsider.pdf",
            fileName: "outsider.pdf",
            fileType: "application/pdf",
          });

        expect(res.status).toBe(403);
      }
    );

    it(
      "mobile prescription photo (image/jpeg) creates an attachment row visible via GET /api/cases/:caseId/attachments",
      async () => {
        const app = appMod.default;
        const { db, caseAttachments } = dbMod as any;

        const fileName = "prescription-photo.jpg";
        const storageKey = `/uploads/case-media/${fileName}`;
        const fileType = "image/jpeg";

        // POST — simulates what uploadPhotoAndCreateAttachment does on mobile.
        const postRes = await request(app)
          .post(`/api/cases/${legacyCaseId}/attachments`)
          .set("Authorization", `Bearer ${tokens.member}`)
          .send({ storageKey, fileName, fileType, visibility: "shared_with_provider" });

        expect(postRes.status).toBe(201);
        const attachmentId = postRes.body.data?.id;
        expect(attachmentId).toBeTruthy();
        expect(postRes.body.data.labCaseId).toBe(legacyCaseId);
        expect(postRes.body.data.fileType).toBe(fileType);

        // GET — confirms the same attachment surfaces via the list endpoint
        // (mirrors what the web/desktop Files tab queries).
        const getRes = await request(app)
          .get(`/api/cases/${legacyCaseId}/attachments`)
          .set("Authorization", `Bearer ${tokens.member}`);

        expect(getRes.status).toBe(200);
        const list: any[] = getRes.body.data ?? getRes.body;
        const found = (Array.isArray(list) ? list : []).find(
          (a: any) => a.id === attachmentId
        );
        expect(found).toBeDefined();
        expect(found.fileType).toBe(fileType);
        expect(found.fileName).toBe(fileName);

        // DB assertion: row exists with correct labCaseId.
        const row = await db.query.caseAttachments.findFirst({
          where: eq(caseAttachments.id, attachmentId),
        });
        expect(row).toBeDefined();
        expect(row.labCaseId).toBe(legacyCaseId);
        expect(row.fileType).toBe(fileType);
      }
    );

    it("returns 404 when the caseId does not exist in lab_cases or cases", async () => {
      const app = appMod.default;
      const res = await request(app)
        .post(`/api/cases/${rid("ghost")}/attachments`)
        .set("Authorization", `Bearer ${tokens.member}`)
        .send({
          storageKey: "/uploads/case-media/ghost.pdf",
          fileName: "ghost.pdf",
          fileType: "application/pdf",
        });

      expect(res.status).toBe(404);
    });

    it(
      "returns 422 when required fields are missing from the request body",
      async () => {
        const app = appMod.default;
        // Missing storageKey and fileName → Zod parse fails → 422 or 400
        const res = await request(app)
          .post(`/api/cases/${legacyCaseId}/attachments`)
          .set("Authorization", `Bearer ${tokens.member}`)
          .send({ fileType: "application/pdf" });

        expect([400, 422]).toContain(res.status);
      }
    );
  }
);
