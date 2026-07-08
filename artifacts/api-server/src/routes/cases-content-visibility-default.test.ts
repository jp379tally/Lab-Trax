/**
 * Regression tests pinning the privacy-first "Lab Only" default for NEW case
 * content (notes + attachments).
 *
 * As of the lab-only-default change:
 *   - POST /api/cases/:caseId/notes with visibility omitted → internal_lab_only
 *   - POST /api/cases/:caseId/attachments (canonical) with visibility omitted
 *     → internal_lab_only
 *   - POST /api/cases/:caseId/attachments (legacy lab_cases branch) with
 *     visibility omitted → internal_lab_only
 *   - POST /api/cases with an inline `notes` string → the created case note is
 *     internal_lab_only
 *   - Explicit `visibility: "shared_with_provider"` still works everywhere —
 *     the default changed, not the capability.
 *
 * Existing content is untouched: these tests only exercise creation paths.
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

maybe("New case content defaults to Lab Only (internal_lab_only)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("org");
  const providerOrgId = rid("porg");
  const memberUserId = rid("umem");
  const caseId = rid("case");
  const legacyCaseId = `legacycase_${randomBytes(8).toString("hex")}`;
  const createdCaseIds: string[] = [];

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
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-visibility-default";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships, cases, labCases } =
      dbMod as any;

    await db.insert(users).values([
      { id: memberUserId, username: `mem_${memberUserId}`, password: "x" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Visibility Default Test Lab" },
      { id: providerOrgId, type: "provider", name: "Visibility Default Test Practice" },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("mbr"),
        labId: labOrgId,
        userId: memberUserId,
        role: "admin",
        status: "active",
      },
    ]);

    await db.insert(cases).values({
      id: caseId,
      caseNumber: `CN-${caseId.slice(-8)}`,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Test",
      patientLastName: "Patient",
      doctorName: "Dr. Test",
      createdByUserId: memberUserId,
      status: "received",
    });

    // Legacy mobile case for the lab_cases attachments branch.
    await db.insert(labCases).values({
      id: legacyCaseId,
      ownerId: memberUserId,
      organizationId: labOrgId,
      caseData: "{}",
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
      caseNotes,
      caseAttachments,
      caseEvents,
      labCases,
      auditLogs,
      invoices,
      invoiceLineItems,
      userSessions,
    } = dbMod as any;
    const allCaseIds = [caseId, ...createdCaseIds];
    const invoiceRows = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(inArray(invoices.caseId, allCaseIds));
    const invoiceIds = invoiceRows.map((r: { id: string }) => r.id);
    if (invoiceIds.length > 0) {
      await db
        .delete(invoiceLineItems)
        .where(inArray(invoiceLineItems.invoiceId, invoiceIds));
      await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
    }
    await db.delete(caseEvents).where(inArray(caseEvents.caseId, allCaseIds));
    await db.delete(caseNotes).where(inArray(caseNotes.caseId, allCaseIds));
    await db
      .delete(caseAttachments)
      .where(inArray(caseAttachments.caseId, [...allCaseIds, legacyCaseId]));
    await db.delete(labCases).where(eq(labCases.id, legacyCaseId));
    await db.delete(cases).where(inArray(cases.id, allCaseIds));
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, memberUserId));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, providerOrgId]));
    await db.delete(userSessions).where(eq(userSessions.userId, memberUserId));
    await db.delete(users).where(eq(users.id, memberUserId));
  });

  it("note with visibility omitted defaults to internal_lab_only", async () => {
    const res = await request(appMod.default)
      .post(`/api/cases/${caseId}/notes`)
      .set("Authorization", `Bearer ${tokens.member}`)
      .send({ noteText: "Default-visibility note" });

    expect(res.status).toBe(201);
    expect(res.body.data.visibility).toBe("internal_lab_only");

    const { db, caseNotes } = dbMod as any;
    const row = await db.query.caseNotes.findFirst({
      where: eq(caseNotes.id, res.body.data.id),
    });
    expect(row?.visibility).toBe("internal_lab_only");
  });

  it("note with explicit shared_with_provider is still shared", async () => {
    const res = await request(appMod.default)
      .post(`/api/cases/${caseId}/notes`)
      .set("Authorization", `Bearer ${tokens.member}`)
      .send({ noteText: "Explicitly shared note", visibility: "shared_with_provider" });

    expect(res.status).toBe(201);
    expect(res.body.data.visibility).toBe("shared_with_provider");
  });

  it("canonical attachment with visibility omitted defaults to internal_lab_only", async () => {
    const res = await request(appMod.default)
      .post(`/api/cases/${caseId}/attachments`)
      .set("Authorization", `Bearer ${tokens.member}`)
      .send({
        storageKey: `/uploads/case-media/${rid("file")}.pdf`,
        fileName: "default-visibility.pdf",
        fileType: "application/pdf",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.visibility).toBe("internal_lab_only");

    const { db, caseAttachments } = dbMod as any;
    const row = await db.query.caseAttachments.findFirst({
      where: eq(caseAttachments.id, res.body.data.id),
    });
    expect(row?.visibility).toBe("internal_lab_only");
  });

  it("canonical attachment with explicit shared_with_provider is still shared", async () => {
    const res = await request(appMod.default)
      .post(`/api/cases/${caseId}/attachments`)
      .set("Authorization", `Bearer ${tokens.member}`)
      .send({
        storageKey: `/uploads/case-media/${rid("file")}.pdf`,
        fileName: "explicitly-shared.pdf",
        fileType: "application/pdf",
        visibility: "shared_with_provider",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.visibility).toBe("shared_with_provider");
  });

  it("legacy lab_cases attachment with visibility omitted defaults to internal_lab_only", async () => {
    const res = await request(appMod.default)
      .post(`/api/cases/${legacyCaseId}/attachments`)
      .set("Authorization", `Bearer ${tokens.member}`)
      .send({
        storageKey: `/uploads/case-media/${rid("file")}.jpg`,
        fileName: "legacy-default.jpg",
        fileType: "image/jpeg",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.visibility).toBe("internal_lab_only");
  });

  it("inline notes on case create produce an internal_lab_only case note", async () => {
    const caseNumber = `CN-${rid("inline").slice(-10)}`;
    const res = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${tokens.member}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Inline",
        patientLastName: "Note",
        doctorName: "Dr. Inline",
        notes: "Inline creation note",
      });

    expect(res.status).toBe(201);
    const createdId = res.body.data?.id as string;
    expect(createdId).toBeTruthy();
    createdCaseIds.push(createdId);

    const { db, caseNotes } = dbMod as any;
    const row = await db.query.caseNotes.findFirst({
      where: eq(caseNotes.caseId, createdId),
    });
    expect(row?.noteText).toBe("Inline creation note");
    expect(row?.visibility).toBe("internal_lab_only");
  });
});
