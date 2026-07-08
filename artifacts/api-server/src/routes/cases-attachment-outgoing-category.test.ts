/**
 * Integration tests for POST /api/cases/:caseId/attachments — canonical-case
 * branch, attachment `category` ("outgoing" case photos).
 *
 * Invariants protected:
 *  - `category: "outgoing"` persists on the caseAttachments row and is
 *    returned in the POST response and GET list.
 *  - The case_attachment_added caseEvents entry stamps
 *    metadataJson.category = "outgoing" so both clients can label the
 *    history event without a second lookup.
 *  - Omitting category leaves the row NULL and the event metadata unstamped.
 *  - Unknown category values are rejected by validation.
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  "POST /api/cases/:caseId/attachments — canonical branch, outgoing category",
  () => {
    let dbMod: typeof import("@workspace/db");
    let appMod: { default: import("express").Express };
    let auth: typeof import("../lib/auth.js");

    const orgId = rid("org");
    const memberUserId = rid("umem");
    const caseId = rid("case");

    const tokens = { member: "" };

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
        process.env["JWT_SECRET"] ?? "labtrax-test-secret-outgoing-category";
      dbMod = await import("@workspace/db");
      appMod = await import("../app.js");
      auth = await import("../lib/auth.js");

      const { db, users, organizations, organizationMemberships, cases } =
        dbMod as any;

      await db.insert(users).values([
        { id: memberUserId, username: `mem_${memberUserId}`, password: "x" },
      ]);

      await db.insert(organizations).values([
        { id: orgId, type: "lab", name: "Outgoing Category Test Lab" },
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

      await db.insert(cases).values({
        id: caseId,
        caseNumber: `CN-${caseId.slice(-8)}`,
        labOrganizationId: orgId,
        providerOrganizationId: orgId,
        patientFirstName: "Test",
        patientLastName: "Patient",
        doctorName: "Dr. Test",
        createdByUserId: memberUserId,
        status: "complete",
      });

      tokens.member = await makeSession(memberUserId);
    });

    beforeEach(async () => {
      tokens.member = await makeSession(memberUserId);
    });

    afterAll(async () => {
      if (!SHOULD_RUN) return;
      const {
        db,
        users,
        organizations,
        organizationMemberships,
        cases,
        caseEvents,
        caseAttachments,
        userSessions,
        auditLogs,
      } = dbMod as any;

      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await db.delete(caseEvents).where(eq(caseEvents.caseId, caseId));
      await db
        .delete(caseAttachments)
        .where(eq(caseAttachments.caseId, caseId));
      await db.delete(cases).where(eq(cases.id, caseId));
      await db
        .delete(organizationMemberships)
        .where(inArray(organizationMemberships.userId, [memberUserId]));
      await db
        .delete(userSessions)
        .where(inArray(userSessions.userId, [memberUserId]));
      await db.delete(organizations).where(eq(organizations.id, orgId));
      await db.delete(users).where(inArray(users.id, [memberUserId]));
    });

    it(
      "persists category 'outgoing' on the row, response, GET list, and event metadata",
      async () => {
        const app = appMod.default;
        const { db, caseAttachments, caseEvents } = dbMod as any;

        const fileName = "outgoing-case-CN100.jpg";
        const storageKey = `/uploads/case-media/${fileName}`;

        const res = await request(app)
          .post(`/api/cases/${caseId}/attachments`)
          .set("Authorization", `Bearer ${tokens.member}`)
          .send({
            storageKey,
            fileName,
            fileType: "image/jpeg",
            category: "outgoing",
          });

        expect(res.status).toBe(201);
        const attachmentId = res.body.data?.id;
        expect(attachmentId).toBeTruthy();
        expect(res.body.data.category).toBe("outgoing");

        const row = await db.query.caseAttachments.findFirst({
          where: eq(caseAttachments.id, attachmentId),
        });
        expect(row).toBeDefined();
        expect(row.category).toBe("outgoing");
        expect(row.caseId).toBe(caseId);

        // GET list surfaces the category for the Files tab badge.
        const getRes = await request(app)
          .get(`/api/cases/${caseId}/attachments`)
          .set("Authorization", `Bearer ${tokens.member}`);
        expect(getRes.status).toBe(200);
        const list: any[] = getRes.body.data ?? getRes.body;
        const found = (Array.isArray(list) ? list : []).find(
          (a: any) => a.id === attachmentId
        );
        expect(found).toBeDefined();
        expect(found.category).toBe("outgoing");

        // History event carries the category in metadata.
        const events = await db.query.caseEvents.findMany({
          where: eq(caseEvents.caseId, caseId),
        });
        const ev = (events as any[]).find(
          (e: any) =>
            e.eventType === "case_attachment_added" &&
            (e.metadataJson as any)?.attachmentId === attachmentId
        );
        expect(ev).toBeDefined();
        expect((ev.metadataJson as any).category).toBe("outgoing");
      }
    );

    it(
      "leaves category null and event metadata unstamped when no category is sent",
      async () => {
        const app = appMod.default;
        const { db, caseAttachments, caseEvents } = dbMod as any;

        const fileName = "regular-attachment.pdf";
        const res = await request(app)
          .post(`/api/cases/${caseId}/attachments`)
          .set("Authorization", `Bearer ${tokens.member}`)
          .send({
            storageKey: `/uploads/case-media/${fileName}`,
            fileName,
            fileType: "application/pdf",
          });

        expect(res.status).toBe(201);
        const attachmentId = res.body.data?.id;
        const row = await db.query.caseAttachments.findFirst({
          where: eq(caseAttachments.id, attachmentId),
        });
        expect(row.category).toBeNull();

        const events = await db.query.caseEvents.findMany({
          where: eq(caseEvents.caseId, caseId),
        });
        const ev = (events as any[]).find(
          (e: any) =>
            e.eventType === "case_attachment_added" &&
            (e.metadataJson as any)?.attachmentId === attachmentId
        );
        expect(ev).toBeDefined();
        expect((ev.metadataJson as any).category).toBeUndefined();
      }
    );

    it("rejects an unknown category value", async () => {
      const app = appMod.default;
      const res = await request(app)
        .post(`/api/cases/${caseId}/attachments`)
        .set("Authorization", `Bearer ${tokens.member}`)
        .send({
          storageKey: "/uploads/case-media/bad-cat.jpg",
          fileName: "bad-cat.jpg",
          fileType: "image/jpeg",
          category: "incoming",
        });

      expect([400, 422]).toContain(res.status);
    });
  }
);
