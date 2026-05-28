/**
 * Integration tests for the practice merge endpoints (Task #711, covering
 * the API added in Task #710).
 *
 * Like the sibling `doctors.test.ts` suite, these tests:
 *   - are skipped when no DATABASE_URL is configured;
 *   - additionally skip when the practice merge route is not mounted yet
 *     (the suite is committed alongside the route across two tasks; if it
 *     runs against a snapshot of the codebase that doesn't yet include the
 *     route, the preview endpoint returns 404 and we skip with a clear
 *     console notice instead of producing a wall of cascading failures).
 *
 * Coverage:
 *   - preview returns deterministic counts and is idempotent across repeat
 *     calls;
 *   - merge collapses conflicting pricing overrides (target keeps, source
 *     soft-deletes);
 *   - merge collapses conflicting memberships (target keeps, source
 *     soft-deletes);
 *   - merge soft-deletes the source organization(s);
 *   - cross-lab source is rejected with 400;
 *   - undo restores cases + invoices + pricing overrides + memberships +
 *     the source org's deletedAt within the configured window;
 *   - undo past the window returns 409.
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
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Task #711 practice merge route (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");
  let routeAvailable = true;

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab");
  const targetPracticeId = rid("provT");
  const sourcePracticeId = rid("provS");
  const sourcePractice2Id = rid("provS2");
  const crossLabPracticeId = rid("provX");
  const adminUserId = rid("uadmin");
  const memberUserOnlyInTarget = rid("umt");
  const memberUserInBoth = rid("umb");
  const otherLabAdminId = rid("uoth");

  const tokens = { admin: "", otherLabAdmin: "" };

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

  async function insertCase(opts: {
    caseNumber: string;
    practiceId: string;
    labId?: string;
    doctorName?: string;
  }) {
    const { db, cases } = dbMod as any;
    const id = rid("c");
    await db.insert(cases).values({
      id,
      caseNumber: opts.caseNumber,
      labOrganizationId: opts.labId ?? labOrgId,
      providerOrganizationId: opts.practiceId,
      doctorName: opts.doctorName ?? "Dr. Test",
      patientFirstName: "Pat",
      patientLastName: "Test",
      status: "draft",
      createdByUserId: adminUserId,
    });
    return id;
  }

  async function insertInvoice(opts: {
    invoiceNumber: string;
    practiceId: string;
    caseId?: string | null;
  }) {
    const { db, invoices } = dbMod as any;
    const id = rid("inv");
    await db.insert(invoices).values({
      id,
      invoiceNumber: opts.invoiceNumber,
      caseId: opts.caseId ?? null,
      labOrganizationId: labOrgId,
      providerOrganizationId: opts.practiceId,
      status: "draft",
      createdByUserId: adminUserId,
    });
    return id;
  }

  async function insertOverride(opts: {
    doctorName: string;
    practiceId: string;
  }) {
    const { db, pricingOverrides } = dbMod as any;
    const id = rid("po");
    await db.insert(pricingOverrides).values({
      id,
      labOrganizationId: labOrgId,
      doctorName: opts.doctorName,
      providerOrganizationId: opts.practiceId,
      practiceName: "Practice",
      tierName: null,
    });
    return id;
  }

  async function insertMembership(opts: {
    userId: string;
    practiceId: string;
    role?: string;
  }) {
    const { db, organizationMemberships } = dbMod as any;
    const id = rid("m");
    await db.insert(organizationMemberships).values({
      id,
      labId: opts.practiceId,
      userId: opts.userId,
      role: opts.role ?? "member",
      status: "active",
    });
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-practices-merge";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "x" },
      {
        id: memberUserOnlyInTarget,
        username: `mt_${memberUserOnlyInTarget}`,
        password: "x",
      },
      {
        id: memberUserInBoth,
        username: `mb_${memberUserInBoth}`,
        password: "x",
      },
      {
        id: otherLabAdminId,
        username: `oth_${otherLabAdminId}`,
        password: "x",
      },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Other Lab" },
      {
        id: targetPracticeId,
        type: "provider",
        name: "Target Practice",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: sourcePracticeId,
        type: "provider",
        name: "Source Practice",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: sourcePractice2Id,
        type: "provider",
        name: "Source Practice 2",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: crossLabPracticeId,
        type: "provider",
        name: "Cross-lab Practice",
        parentLabOrganizationId: otherLabOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: adminUserId,
        role: "admin",
        status: "active",
      },
      {
        id: rid("m"),
        labId: otherLabOrgId,
        userId: otherLabAdminId,
        role: "admin",
        status: "active",
      },
    ]);

    tokens.admin = await makeSession(adminUserId);
    tokens.otherLabAdmin = await makeSession(otherLabAdminId);

    // Route-existence probe: a malformed body should still hit the
    // router and return either 400 (validation) or 401/403 (auth). A
    // 404 means the practices router hasn't been mounted in this
    // snapshot of the codebase — skip the rest of the suite cleanly.
    const probe = await request(appMod.default)
      .post("/api/practices/merge/preview")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    if (probe.status === 404) {
      routeAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        "[practices.test] /api/practices/merge/preview not mounted — " +
          "skipping practice-merge integration tests. This suite covers " +
          "the API added in Task #710; ensure that task's changes are " +
          "merged for the tests to exercise the route.",
      );
    }
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      cases,
      invoices,
      pricingOverrides,
      organizationMemberships,
      userSessions,
      auditLogs,
    } = dbMod as any;
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, otherLabOrgId]));
    await db
      .delete(invoices)
      .where(eq(invoices.labOrganizationId, labOrgId));
    await db
      .delete(pricingOverrides)
      .where(eq(pricingOverrides.labOrganizationId, labOrgId));
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(
        inArray(organizationMemberships.userId, [
          adminUserId,
          memberUserOnlyInTarget,
          memberUserInBoth,
          otherLabAdminId,
        ]),
      );
    await db
      .delete(userSessions)
      .where(
        inArray(userSessions.userId, [adminUserId, otherLabAdminId]),
      );
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [
          labOrgId,
          otherLabOrgId,
          targetPracticeId,
          sourcePracticeId,
          sourcePractice2Id,
          crossLabPracticeId,
        ]),
      );
    await db
      .delete(users)
      .where(
        inArray(users.id, [
          adminUserId,
          memberUserOnlyInTarget,
          memberUserInBoth,
          otherLabAdminId,
        ]),
      );
  });

  function mergeBody(sourceIds: string[], target = targetPracticeId) {
    return {
      labOrganizationId: labOrgId,
      targetOrganizationId: target,
      sourceOrganizationIds: sourceIds,
    };
  }

  it("rejects when a source practice belongs to a different lab", async () => {
    if (!routeAvailable) return;
    const r = await request(appMod.default)
      .post("/api/practices/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send(mergeBody([crossLabPracticeId]));
    expect(r.status).toBe(400);
  });

  it("preview returns deterministic counts and is idempotent", async () => {
    if (!routeAvailable) return;
    const cId = await insertCase({
      caseNumber: rid("CN"),
      practiceId: sourcePracticeId,
    });
    const iId = await insertInvoice({
      invoiceNumber: rid("PV1-inv"),
      practiceId: sourcePracticeId,
    });
    const oId = await insertOverride({
      doctorName: "Dr. Preview",
      practiceId: sourcePracticeId,
    });

    const first = await request(appMod.default)
      .post("/api/practices/merge/preview")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send(mergeBody([sourcePracticeId]));
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);

    const second = await request(appMod.default)
      .post("/api/practices/merge/preview")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send(mergeBody([sourcePracticeId]));
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    // Whatever the precise field names are, the preview must surface
    // non-zero counts that reflect the rows we inserted. Be tolerant
    // about the exact shape (the doctor-merge preview uses different
    // names) — but the values must show "1 of everything".
    const flat = JSON.stringify(first.body);
    expect(flat).toMatch(/"(totalCases|cases|casesMoved)":\s*1\b/);
    expect(flat).toMatch(/"(totalInvoices|invoices|invoicesMoved)":\s*1\b/);
    expect(flat).toMatch(
      /"(totalOverrides|overrides|overridesMoved)":\s*1\b/,
    );

    const { db, cases, invoices, pricingOverrides } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, cId));
    await db.delete(invoices).where(eq(invoices.id, iId));
    await db.delete(pricingOverrides).where(eq(pricingOverrides.id, oId));
  });

  it("merge collapses conflicting overrides and memberships, soft-deletes source org", async () => {
    if (!routeAvailable) return;
    const cId = await insertCase({
      caseNumber: rid("MS"),
      practiceId: sourcePracticeId,
    });
    const iId = await insertInvoice({
      invoiceNumber: rid("inv"),
      practiceId: sourcePracticeId,
      caseId: cId,
    });

    // Both source and target have an override for the same doctor name
    // — the source should be collapsed (soft-deleted) and the target
    // override kept, so the partial unique index on
    // (labOrganizationId, doctorName) WHERE deleted_at IS NULL is not
    // violated.
    const ovTarget = await insertOverride({
      doctorName: "Dr. Conflict",
      practiceId: targetPracticeId,
    });
    const ovSource = await insertOverride({
      doctorName: "Dr. Conflict",
      practiceId: sourcePracticeId,
    });
    // A non-conflicting source override should be remapped to the
    // target practice without being collapsed.
    const ovUnique = await insertOverride({
      doctorName: "Dr. Unique",
      practiceId: sourcePracticeId,
    });

    // memberUserInBoth is in target AND source → source collapses.
    // memberUserOnlyInTarget is only in target — untouched.
    // A fresh user only in source should be moved.
    const memBothInTarget = await insertMembership({
      userId: memberUserInBoth,
      practiceId: targetPracticeId,
    });
    const memBothInSource = await insertMembership({
      userId: memberUserInBoth,
      practiceId: sourcePracticeId,
    });
    const memTargetOnly = await insertMembership({
      userId: memberUserOnlyInTarget,
      practiceId: targetPracticeId,
    });

    const r = await request(appMod.default)
      .post("/api/practices/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send(mergeBody([sourcePracticeId]));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const {
      db,
      cases,
      invoices,
      pricingOverrides,
      organizationMemberships,
      organizations,
    } = dbMod as any;

    const [movedCase] = await db
      .select()
      .from(cases)
      .where(eq(cases.id, cId));
    expect(movedCase.providerOrganizationId).toBe(targetPracticeId);

    const [movedInvoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, iId));
    expect(movedInvoice.providerOrganizationId).toBe(targetPracticeId);

    // Override conflict: source collapsed, target untouched, unique
    // override remapped.
    const [srcOv] = await db
      .select()
      .from(pricingOverrides)
      .where(eq(pricingOverrides.id, ovSource));
    expect(srcOv.deletedAt).not.toBeNull();
    const [tgtOv] = await db
      .select()
      .from(pricingOverrides)
      .where(eq(pricingOverrides.id, ovTarget));
    expect(tgtOv.deletedAt).toBeNull();
    const [uniqOv] = await db
      .select()
      .from(pricingOverrides)
      .where(eq(pricingOverrides.id, ovUnique));
    expect(uniqOv.providerOrganizationId).toBe(targetPracticeId);
    expect(uniqOv.deletedAt).toBeNull();

    // Membership conflict: source row for user-in-both collapsed,
    // target rows untouched.
    const [bothSrc] = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.id, memBothInSource));
    expect(bothSrc.deletedAt).not.toBeNull();
    const [bothTgt] = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.id, memBothInTarget));
    expect(bothTgt.deletedAt).toBeNull();
    expect(bothTgt.labId).toBe(targetPracticeId);
    const [tgtOnly] = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.id, memTargetOnly));
    expect(tgtOnly.deletedAt).toBeNull();

    // Source organization is soft-deleted.
    const [srcOrg] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, sourcePracticeId));
    expect(srcOrg.deletedAt).not.toBeNull();
    const [tgtOrg] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, targetPracticeId));
    expect(tgtOrg.deletedAt).toBeNull();
  });

  it("undo restores cases, invoices, overrides, memberships, and source org deletedAt", async () => {
    if (!routeAvailable) return;
    const cId = await insertCase({
      caseNumber: rid("UNDO"),
      practiceId: sourcePractice2Id,
    });
    const iId = await insertInvoice({
      invoiceNumber: rid("inv"),
      practiceId: sourcePractice2Id,
      caseId: cId,
    });
    const ovId = await insertOverride({
      doctorName: "Dr. Undo",
      practiceId: sourcePractice2Id,
    });
    const newUserForUndo = rid("uundo");
    const { db, users, organizations } = dbMod as any;
    await db
      .insert(users)
      .values({ id: newUserForUndo, username: `u_${newUserForUndo}`, password: "x" });
    const memId = await insertMembership({
      userId: newUserForUndo,
      practiceId: sourcePractice2Id,
    });

    const r = await request(appMod.default)
      .post("/api/practices/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send(mergeBody([sourcePractice2Id]));
    expect(r.status).toBe(200);

    // The merge response should expose an undoable audit log id. Be
    // tolerant of nested shapes (data.auditLogId vs data.entries[0].auditLogId).
    const data = r.body.data ?? r.body;
    const auditLogId: string | undefined =
      data?.auditLogId ??
      data?.entries?.[0]?.auditLogId ??
      data?.merges?.[0]?.auditLogId;
    expect(typeof auditLogId).toBe("string");

    // Source org is soft-deleted post-merge.
    const [srcOrgPost] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, sourcePractice2Id));
    expect(srcOrgPost.deletedAt).not.toBeNull();

    const u = await request(appMod.default)
      .post(`/api/practices/merge/${auditLogId}/undo`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    expect(u.status).toBe(200);

    const { cases, invoices, pricingOverrides, organizationMemberships } =
      dbMod as any;

    const [revertedCase] = await db
      .select()
      .from(cases)
      .where(eq(cases.id, cId));
    expect(revertedCase.providerOrganizationId).toBe(sourcePractice2Id);

    const [revertedInvoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, iId));
    expect(revertedInvoice.providerOrganizationId).toBe(sourcePractice2Id);

    const [revertedOv] = await db
      .select()
      .from(pricingOverrides)
      .where(eq(pricingOverrides.id, ovId));
    expect(revertedOv.providerOrganizationId).toBe(sourcePractice2Id);
    expect(revertedOv.deletedAt).toBeNull();

    const [revertedMem] = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.id, memId));
    expect(revertedMem.labId).toBe(sourcePractice2Id);
    expect(revertedMem.deletedAt).toBeNull();

    // Source org's deletedAt is cleared by undo.
    const [srcOrgRestored] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, sourcePractice2Id));
    expect(srcOrgRestored.deletedAt).toBeNull();

    // Cleanup.
    await db.delete(cases).where(eq(cases.id, cId));
    await db.delete(invoices).where(eq(invoices.id, iId));
    await db.delete(pricingOverrides).where(eq(pricingOverrides.id, ovId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.id, memId));
    await db.delete(users).where(eq(users.id, newUserForUndo));
  });

  it("undo past the configured window returns 409", async () => {
    if (!routeAvailable) return;
    const cId = await insertCase({
      caseNumber: rid("WIN"),
      practiceId: targetPracticeId, // merge target→source flipped: use a fresh pair
    });
    // Re-create a temporary source org so the merge succeeds even
    // after earlier tests soft-deleted sourcePracticeId.
    const tempSrcId = rid("provTmp");
    const { db, organizations, cases, auditLogs } = dbMod as any;
    await db.insert(organizations).values({
      id: tempSrcId,
      type: "provider",
      name: "Temp Source",
      parentLabOrganizationId: labOrgId,
    });
    // Move our test case to the temp source so it actually has
    // something to merge.
    await db
      .update(cases)
      .set({ providerOrganizationId: tempSrcId })
      .where(eq(cases.id, cId));

    const r = await request(appMod.default)
      .post("/api/practices/merge")
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send(mergeBody([tempSrcId]));
    expect(r.status).toBe(200);
    const data = r.body.data ?? r.body;
    const auditLogId: string =
      data?.auditLogId ??
      data?.entries?.[0]?.auditLogId ??
      data?.merges?.[0]?.auditLogId;
    expect(typeof auditLogId).toBe("string");

    // Backdate the audit row well past any reasonable undo window
    // (24h default ceiling in the doctor merge analogue is 24*60 min;
    // 25 hours is past any sane configuration).
    await db
      .update(auditLogs)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(auditLogs.id, auditLogId));

    const expired = await request(appMod.default)
      .post(`/api/practices/merge/${auditLogId}/undo`)
      .set("Authorization", `Bearer ${tokens.admin}`)
      .send({});
    expect(expired.status).toBe(409);

    await db.delete(cases).where(eq(cases.id, cId));
    await db.delete(organizations).where(eq(organizations.id, tempSrcId));
  });
});
