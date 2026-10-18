/**
 * Integration tests: PATCH /:caseId bumps updatedAt → surfaces in /cases/recent
 *
 * Verifies that editing any field on a canonical case refreshes `updatedAt` so
 * the case rises to the top of the Recent Cases section (GET /cases/recent).
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(
    require("os").tmpdir(),
    "labtrax-test-media-updatedat-recent"
  ),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("PATCH /cases/:id bumps updatedAt → GET /cases/recent ordering", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const createdCaseIds: string[] = [];
  const createdInvoiceIds: string[] = [];

  async function makeSession(
    userId: string
  ): Promise<{ access: string; refresh: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access, refresh };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-updatedat-recent";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `updated_at_recent_${labOwnerId}`,
      password: "doesnotmatter",
      emailVerifiedAt: new Date(),
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("UpdatedAtRecentLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("UpdatedAtRecentPractice"),
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values({
      id: rid("m"),
      labId: labOrgId,
      userId: labOwnerId,
      role: "owner",
      status: "active",
      approvedByUserId: labOwnerId,
      joinedAt: new Date(),
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      caseEvents,
      caseNotes,
      invoiceLineItems,
      invoices,
      cases: casesTable,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    if (createdCaseIds.length) {
      await db
        .delete(caseEvents)
        .where(inArray(caseEvents.caseId, createdCaseIds));
      await db
        .delete(caseNotes)
        .where(inArray(caseNotes.caseId, createdCaseIds));
    }
    if (createdInvoiceIds.length) {
      await db
        .delete(invoiceLineItems)
        .where(inArray(invoiceLineItems.invoiceId, createdInvoiceIds));
      await db
        .delete(invoices)
        .where(inArray(invoices.id, createdInvoiceIds));
    }
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db
      .delete(invoices)
      .where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db
      .delete(casesTable)
      .where(inArray(casesTable.labOrganizationId, [labOrgId]));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [labOwnerId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [labOwnerId]));
    await db
      .delete(organizations)
      .where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  it("PATCH a canonical case bumps its updatedAt timestamp", async () => {
    const { access } = await makeSession(labOwnerId);
    const app = appMod.default;

    // Create a case.
    const createRes = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("C"),
        patientFirstName: "Alice",
        patientLastName: "Bumped",
        doctorName: "Dr. Bump",
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "received",
      });
    expect(createRes.status).toBe(201);
    const caseId = createRes.body.data?.id ?? createRes.body.id;
    createdCaseIds.push(caseId);
    if (createRes.body.data?.invoiceId) {
      createdInvoiceIds.push(createRes.body.data.invoiceId);
    }

    // Capture updatedAt immediately after creation.
    const { db, cases: casesTable } = dbMod as any;
    const { eq } = await import("drizzle-orm");
    const [before] = await db
      .select({ updatedAt: casesTable.updatedAt })
      .from(casesTable)
      .where(eq(casesTable.id, caseId));
    const createdUpdatedAt = before.updatedAt as Date;

    // Wait a tick to guarantee a different timestamp.
    await new Promise((r) => setTimeout(r, 10));

    // PATCH the case (change priority — a simple field edit).
    const patchRes = await request(app)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ priority: "rush" });
    expect(patchRes.status).toBe(200);

    // Fetch the row directly and confirm updatedAt advanced.
    const [after] = await db
      .select({ updatedAt: casesTable.updatedAt })
      .from(casesTable)
      .where(eq(casesTable.id, caseId));
    const patchedUpdatedAt = after.updatedAt as Date;

    expect(patchedUpdatedAt.getTime()).toBeGreaterThan(
      createdUpdatedAt.getTime()
    );
  });

  it("edited case surfaces first in GET /cases/recent", async () => {
    const { access } = await makeSession(labOwnerId);
    const app = appMod.default;

    // Create two cases — olderCase first, newerCase second.
    const olderRes = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("C"),
        patientFirstName: "Older",
        patientLastName: "Case",
        doctorName: "Dr. Older",
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "received",
      });
    expect(olderRes.status).toBe(201);
    const olderCaseId = olderRes.body.data?.id ?? olderRes.body.id;
    createdCaseIds.push(olderCaseId);
    if (olderRes.body.data?.invoiceId) {
      createdInvoiceIds.push(olderRes.body.data.invoiceId);
    }

    // Small delay to ensure olderCase.createdAt < newerCase.createdAt
    await new Promise((r) => setTimeout(r, 20));

    const newerRes = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("C"),
        patientFirstName: "Newer",
        patientLastName: "Case",
        doctorName: "Dr. Newer",
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "received",
      });
    expect(newerRes.status).toBe(201);
    const newerCaseId = newerRes.body.data?.id ?? newerRes.body.id;
    createdCaseIds.push(newerCaseId);
    if (newerRes.body.data?.invoiceId) {
      createdInvoiceIds.push(newerRes.body.data.invoiceId);
    }

    // newerCase should currently be at the top of /recent.
    const beforePatch = await request(app)
      .get("/api/cases/recent")
      .set("Authorization", `Bearer ${access}`);
    expect(beforePatch.status).toBe(200);
    const beforeIds: string[] = (beforePatch.body.data ?? beforePatch.body).map(
      (c: any) => c.id
    );
    const olderIdxBefore = beforeIds.indexOf(olderCaseId);
    const newerIdxBefore = beforeIds.indexOf(newerCaseId);
    // Both cases must appear before proceeding.
    expect(olderIdxBefore).toBeGreaterThanOrEqual(0);
    expect(newerIdxBefore).toBeGreaterThanOrEqual(0);
    // newerCase was created last → should be at a lower index (closer to top).
    expect(newerIdxBefore).toBeLessThan(olderIdxBefore);

    // Small delay so the PATCH timestamp is strictly after both createdAt values.
    await new Promise((r) => setTimeout(r, 20));

    // Now PATCH the older case — it should jump to the top of /recent.
    const patchRes = await request(app)
      .patch(`/api/cases/${olderCaseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ priority: "rush" });
    expect(patchRes.status).toBe(200);

    const afterPatch = await request(app)
      .get("/api/cases/recent")
      .set("Authorization", `Bearer ${access}`);
    expect(afterPatch.status).toBe(200);
    const afterIds: string[] = (afterPatch.body.data ?? afterPatch.body).map(
      (c: any) => c.id
    );
    const olderIdxAfter = afterIds.indexOf(olderCaseId);
    const newerIdxAfter = afterIds.indexOf(newerCaseId);
    // After the PATCH, the older case must appear before the newer one.
    expect(olderIdxAfter).toBeGreaterThanOrEqual(0);
    expect(newerIdxAfter).toBeGreaterThanOrEqual(0);
    expect(olderIdxAfter).toBeLessThan(newerIdxAfter);
  });
});
