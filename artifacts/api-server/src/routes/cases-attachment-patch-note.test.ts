/**
 * Integration tests for PATCH /api/cases/:caseId/attachments/:attachmentId —
 * editing and clearing an attachment's note after upload.
 *
 * The PATCH route previously only accepted a `visibility` change. It now also
 * accepts an optional `note` (a string to set/replace, or "" / null to clear).
 * These tests exercise the canonical-case branch:
 *   - editing a note replaces the stored value and returns it,
 *   - clearing a note (null or blank string) sets it to NULL,
 *   - the edited/cleared note is reflected in the case history
 *     (case_attachment_added event metadata) without a stored-metadata rewrite,
 *   - visibility-only PATCH still works and leaves the note untouched,
 *   - non-lab callers are rejected.
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash, randomUUID } from "node:crypto";
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
  "PATCH /api/cases/:caseId/attachments/:attachmentId — note editing",
  () => {
    let dbMod: typeof import("@workspace/db");
    let appMod: { default: import("express").Express };
    let auth: typeof import("../lib/auth.js");

    const orgId = rid("org");
    const memberUserId = rid("umem");
    const outsiderUserId = rid("uout");
    const caseId = rid("case");

    const tokens = { member: "", outsider: "" };
    const attachmentIds: string[] = [];

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

    async function seedAttachment(note: string | null): Promise<string> {
      const { db, caseAttachments } = dbMod as any;
      const attId = randomUUID();
      attachmentIds.push(attId);
      await db.insert(caseAttachments).values({
        id: attId,
        caseId,
        uploadedByUserId: memberUserId,
        uploadedByOrganizationId: orgId,
        fileName: "spec.pdf",
        storageKey: `/uploads/case-media/${attId}.pdf`,
        fileType: "application/pdf",
        visibility: "shared_with_provider",
        note,
      });
      // Mirror the case_attachment_added timeline event the upload route writes,
      // including the note in metadata so we can assert it gets refreshed.
      await db.insert((dbMod as any).caseEvents).values({
        caseId,
        eventType: "case_attachment_added",
        actorUserId: memberUserId,
        actorOrganizationId: orgId,
        actorInitials: "TT",
        metadataJson: {
          attachmentId: attId,
          fileName: "spec.pdf",
          fileType: "application/pdf",
          visibility: "shared_with_provider",
          ...(note ? { note } : {}),
        },
      });
      return attId;
    }

    beforeAll(async () => {
      process.env["JWT_SECRET"] =
        process.env["JWT_SECRET"] ?? "labtrax-test-secret-patch-note";
      dbMod = await import("@workspace/db");
      appMod = await import("../app.js");
      auth = await import("../lib/auth.js");

      const { db, users, organizations, organizationMemberships, cases } =
        dbMod as any;

      await db.insert(users).values([
        { id: memberUserId, username: `mem_${memberUserId}`, password: "x" },
        { id: outsiderUserId, username: `out_${outsiderUserId}`, password: "x" },
      ]);

      await db.insert(organizations).values([
        { id: orgId, type: "lab", name: "Patch Note Test Lab" },
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
        status: "received",
      });

      tokens.member = await makeSession(memberUserId);
      tokens.outsider = await makeSession(outsiderUserId);
    });

    beforeEach(async () => {
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
        cases,
        caseEvents,
        caseAttachments,
        userSessions,
        auditLogs,
      } = dbMod as any;

      await db.delete(auditLogs).where(eq(auditLogs.organizationId, orgId));
      await db.delete(caseEvents).where(eq(caseEvents.caseId, caseId));
      await db.delete(caseAttachments).where(eq(caseAttachments.caseId, caseId));
      await db.delete(cases).where(eq(cases.id, caseId));
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
        .where(inArray(userSessions.userId, [memberUserId, outsiderUserId]));
      await db.delete(organizations).where(eq(organizations.id, orgId));
      await db
        .delete(users)
        .where(inArray(users.id, [memberUserId, outsiderUserId]));
    });

    it("edits an existing note and returns the new value", async () => {
      const app = appMod.default;
      const { db, caseAttachments } = dbMod as any;
      const attId = await seedAttachment("original typo notte");

      const res = await request(app)
        .patch(`/api/cases/${caseId}/attachments/${attId}`)
        .set("Authorization", `Bearer ${tokens.member}`)
        .send({ note: "  corrected note  " });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // Note is trimmed on the server.
      expect(res.body.data.note).toBe("corrected note");

      const row = await db.query.caseAttachments.findFirst({
        where: eq(caseAttachments.id, attId),
      });
      expect(row.note).toBe("corrected note");
    });

    it("clears a note when null is sent", async () => {
      const app = appMod.default;
      const { db, caseAttachments } = dbMod as any;
      const attId = await seedAttachment("remove me");

      const res = await request(app)
        .patch(`/api/cases/${caseId}/attachments/${attId}`)
        .set("Authorization", `Bearer ${tokens.member}`)
        .send({ note: null });

      expect(res.status).toBe(200);
      expect(res.body.data.note).toBeNull();

      const row = await db.query.caseAttachments.findFirst({
        where: eq(caseAttachments.id, attId),
      });
      expect(row.note).toBeNull();
    });

    it("clears a note when a blank string is sent", async () => {
      const app = appMod.default;
      const { db, caseAttachments } = dbMod as any;
      const attId = await seedAttachment("blank me");

      const res = await request(app)
        .patch(`/api/cases/${caseId}/attachments/${attId}`)
        .set("Authorization", `Bearer ${tokens.member}`)
        .send({ note: "   " });

      expect(res.status).toBe(200);
      expect(res.body.data.note).toBeNull();

      const row = await db.query.caseAttachments.findFirst({
        where: eq(caseAttachments.id, attId),
      });
      expect(row.note).toBeNull();
    });

    it("reflects the edited note in the case history without a metadata rewrite", async () => {
      const app = appMod.default;
      const attId = await seedAttachment("stale history note");

      await request(app)
        .patch(`/api/cases/${caseId}/attachments/${attId}`)
        .set("Authorization", `Bearer ${tokens.member}`)
        .send({ note: "fresh history note" })
        .expect(200);

      const detail = await request(app)
        .get(`/api/cases/${caseId}`)
        .set("Authorization", `Bearer ${tokens.member}`);

      expect(detail.status).toBe(200);
      const events: any[] =
        detail.body.data?.history ??
        detail.body.data?.events ??
        detail.body.data?.caseHistory ??
        [];
      const ev = events.find(
        (e) =>
          e.eventType === "case_attachment_added" &&
          e.metadataJson?.attachmentId === attId
      );
      expect(ev, "attachment_added event should be present").toBeDefined();
      expect(ev.metadataJson.note).toBe("fresh history note");
    });

    it("removes the note from case history when cleared", async () => {
      const app = appMod.default;
      const attId = await seedAttachment("note to be cleared");

      await request(app)
        .patch(`/api/cases/${caseId}/attachments/${attId}`)
        .set("Authorization", `Bearer ${tokens.member}`)
        .send({ note: null })
        .expect(200);

      const detail = await request(app)
        .get(`/api/cases/${caseId}`)
        .set("Authorization", `Bearer ${tokens.member}`);

      expect(detail.status).toBe(200);
      const events: any[] =
        detail.body.data?.history ??
        detail.body.data?.events ??
        detail.body.data?.caseHistory ??
        [];
      const ev = events.find(
        (e) =>
          e.eventType === "case_attachment_added" &&
          e.metadataJson?.attachmentId === attId
      );
      expect(ev, "attachment_added event should be present").toBeDefined();
      expect(ev.metadataJson.note).toBeUndefined();
    });

    it("updates visibility only and leaves the note untouched", async () => {
      const app = appMod.default;
      const { db, caseAttachments } = dbMod as any;
      const attId = await seedAttachment("keep this note");

      const res = await request(app)
        .patch(`/api/cases/${caseId}/attachments/${attId}`)
        .set("Authorization", `Bearer ${tokens.member}`)
        .send({ visibility: "internal_lab_only" });

      expect(res.status).toBe(200);
      expect(res.body.data.visibility).toBe("internal_lab_only");
      expect(res.body.data.note).toBe("keep this note");

      const row = await db.query.caseAttachments.findFirst({
        where: eq(caseAttachments.id, attId),
      });
      expect(row.visibility).toBe("internal_lab_only");
      expect(row.note).toBe("keep this note");
    });

    it("rejects a note edit from a non-lab caller", async () => {
      const app = appMod.default;
      const attId = await seedAttachment("private note");

      const res = await request(app)
        .patch(`/api/cases/${caseId}/attachments/${attId}`)
        .set("Authorization", `Bearer ${tokens.outsider}`)
        .send({ note: "hijacked" });

      expect([403, 404]).toContain(res.status);
    });
  }
);
