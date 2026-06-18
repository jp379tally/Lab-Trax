/**
 * Integration tests for the legacy mobile case attachment routes.
 *
 * Legacy cases live in `lab_cases` (not the canonical `cases` table). The
 * caseAttachments table now carries a nullable `labCaseId` FK so attachments
 * can be stored for these rows without a `caseId`. These tests verify the
 * full lifecycle through that code path:
 *
 *   POST  /:caseId/attachments  — stores attachment with labCaseId, returns 201
 *   GET   /:caseId/attachments  — returns the stored attachment list
 *   GET   /:caseId/attachments/:id/file — serves the file bytes from disk
 *   DELETE /:caseId/attachments/:id    — removes the attachment
 *
 * Authorization: lab members may access; non-members get 403.
 *
 * Skipped when DATABASE_URL is not configured (same convention as siblings).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Legacy mobile case attachment routes (/:caseId/attachments)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let caseMediaMod: typeof import("../lib/case-media.js");

  const labOrgId = rid("lab");
  const memberUserId = rid("umember");
  const outsiderUserId = rid("uout");
  const labCaseId = `${Date.now()}${randomBytes(4).toString("hex")}`;
  const fileName = `${rid("legacyattach")}.pdf`;

  let filePath = "";
  let fileBytes: Buffer;

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
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-legacy-attachments";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");
    caseMediaMod = await import("../lib/case-media.js");

    const { db, users, organizations, organizationMemberships, labCases } =
      dbMod as any;

    await db.insert(users).values([
      { id: memberUserId, username: `mem_${memberUserId}`, password: "x" },
      { id: outsiderUserId, username: `out_${outsiderUserId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Legacy Attach Test Lab" },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: memberUserId,
        role: "admin",
        status: "active",
      },
    ]);

    await db.insert(labCases).values([
      {
        id: labCaseId,
        ownerId: memberUserId,
        organizationId: labOrgId,
        caseData: JSON.stringify({
          id: labCaseId,
          ownerId: memberUserId,
          caseNumber: "26-LEGATTACH",
          patientName: "Attach Patient",
          status: "INTAKE",
        }),
      },
    ]);

    fileBytes = randomBytes(1024);
    await fsp.mkdir(caseMediaMod.caseMediaDir, { recursive: true });
    filePath = path.join(caseMediaMod.caseMediaDir, fileName);
    await fsp.writeFile(filePath, fileBytes);
  });

  // Ensure a fresh session exists before each test; per-test sessions created
  // in each it() body are still the authoritative token for that test.
  beforeEach(async () => {
    await makeSession(memberUserId);
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
      userSessions,
      auditLogs,
    } = dbMod as any;

    await db
      .delete(auditLogs)
      .where(eq(auditLogs.organizationId, labOrgId));
    await db
      .delete(caseAttachments)
      .where(eq(caseAttachments.labCaseId, labCaseId));
    await db
      .delete(legacyCaseMedia)
      .where(eq(legacyCaseMedia.labCaseId, labCaseId));
    await db.delete(labCases).where(eq(labCases.id, labCaseId));
    await db
      .delete(organizationMemberships)
      .where(
        inArray(organizationMemberships.userId, [memberUserId, outsiderUserId])
      );
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [memberUserId, outsiderUserId]));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db
      .delete(users)
      .where(inArray(users.id, [memberUserId, outsiderUserId]));
    try {
      await fsp.rm(filePath, { force: true });
    } catch {
      // ignore
    }
  });

  it("POST /:caseId/attachments — stores attachment with labCaseId and returns 201", async () => {
    const app = appMod.default;
    const memberToken = await makeSession(memberUserId);
    const storageKey = `/uploads/case-media/${fileName}`;

    const res = await request(app)
      .post(`/api/cases/${encodeURIComponent(labCaseId)}/attachments`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({
        storageKey,
        fileName,
        fileType: "application/pdf",
        visibility: "shared_with_provider",
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    const attachment = res.body.data;
    expect(attachment).toBeDefined();
    expect(attachment.labCaseId).toBe(labCaseId);
    expect(attachment.caseId).toBeNull();
    expect(attachment.fileName).toBe(fileName);
    expect(attachment.storageKey).toBe(storageKey);
    expect(attachment.fileType).toBe("application/pdf");
    expect(attachment.id).toBeTruthy();

    const { db, caseAttachments } = dbMod as any;
    const [row] = await db
      .select()
      .from(caseAttachments)
      .where(eq(caseAttachments.id, attachment.id));
    expect(row).toBeDefined();
    expect(row.labCaseId).toBe(labCaseId);
    expect(row.caseId).toBeNull();
  });

  it("GET /:caseId/attachments — returns the stored attachment", async () => {
    const app = appMod.default;
    const memberToken = await makeSession(memberUserId);

    const res = await request(app)
      .get(`/api/cases/${encodeURIComponent(labCaseId)}/attachments`)
      .set("Authorization", `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const list: any[] = res.body.data;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);

    const found = list.find((a) => a.labCaseId === labCaseId && a.fileName === fileName);
    expect(found).toBeDefined();
  });

  it("GET /:caseId/attachments/:attachmentId/file — serves the file bytes", async () => {
    const app = appMod.default;
    const memberToken = await makeSession(memberUserId);

    const listRes = await request(app)
      .get(`/api/cases/${encodeURIComponent(labCaseId)}/attachments`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(listRes.status).toBe(200);
    const attachment = (listRes.body.data as any[]).find(
      (a) => a.fileName === fileName
    );
    expect(attachment).toBeDefined();

    const fileRes = await request(app)
      .get(
        `/api/cases/${encodeURIComponent(labCaseId)}/attachments/${attachment.id}/file`
      )
      .set("Authorization", `Bearer ${memberToken}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(fileRes.status).toBe(200);
    expect(Buffer.isBuffer(fileRes.body)).toBe(true);
    expect((fileRes.body as Buffer).equals(fileBytes)).toBe(true);
  });

  it("GET /:caseId/attachments — non-member gets 403", async () => {
    const app = appMod.default;
    const outsiderToken = await makeSession(outsiderUserId);

    const res = await request(app)
      .get(`/api/cases/${encodeURIComponent(labCaseId)}/attachments`)
      .set("Authorization", `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
  });

  it("POST /:caseId/attachments — non-member gets 403", async () => {
    const app = appMod.default;
    const outsiderToken = await makeSession(outsiderUserId);

    const res = await request(app)
      .post(`/api/cases/${encodeURIComponent(labCaseId)}/attachments`)
      .set("Authorization", `Bearer ${outsiderToken}`)
      .send({
        storageKey: `/uploads/case-media/some-other-file.pdf`,
        fileName: "some-other-file.pdf",
        fileType: "application/pdf",
      });

    expect(res.status).toBe(403);
  });

  it("DELETE /:caseId/attachments/:attachmentId — removes the attachment", async () => {
    const app = appMod.default;
    const memberToken = await makeSession(memberUserId);

    const listRes = await request(app)
      .get(`/api/cases/${encodeURIComponent(labCaseId)}/attachments`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(listRes.status).toBe(200);
    const attachment = (listRes.body.data as any[]).find(
      (a) => a.fileName === fileName
    );
    expect(attachment).toBeDefined();

    const delRes = await request(app)
      .delete(
        `/api/cases/${encodeURIComponent(labCaseId)}/attachments/${attachment.id}`
      )
      .set("Authorization", `Bearer ${memberToken}`);

    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    const { db, caseAttachments } = dbMod as any;
    const [row] = await db
      .select()
      .from(caseAttachments)
      .where(eq(caseAttachments.id, attachment.id));
    expect(row).toBeDefined();
    expect(row.deletedAt).not.toBeNull();

    const afterList = await request(app)
      .get(`/api/cases/${encodeURIComponent(labCaseId)}/attachments`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(afterList.status).toBe(200);
    const stillThere = (afterList.body.data as any[]).find(
      (a) => a.id === attachment.id
    );
    expect(stillThere).toBeUndefined();
  });
});
