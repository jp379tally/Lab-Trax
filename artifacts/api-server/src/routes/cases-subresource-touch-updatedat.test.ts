/**
 * Integration tests: sub-resource mutations bump cases.updatedAt → surface in /cases/recent
 *
 * Verifies that POST /:caseId/notes and validated station moves (as
 * representative endpoints) refresh `cases.updatedAt` so the case rises to
 * the top of the Recent Cases section (GET /cases/recent).
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(
    os.tmpdir(),
    "labtrax-test-media-subresource-touch"
  ),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Sub-resource mutations bump cases.updatedAt → GET /cases/recent ordering", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const createdCaseIds: string[] = [];
  const createdInvoiceIds: string[] = [];
  const locationId = rid("loc");

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

  async function createCase(
    access: string,
    app: import("express").Express,
    label: string
  ): Promise<{ caseId: string; invoiceId: string | null }> {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("C"),
        patientFirstName: label,
        patientLastName: "TouchTest",
        doctorName: "Dr. Touch",
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "received",
      });
    expect(res.status).toBe(201);
    const caseId = res.body.data?.id ?? res.body.id;
    const invoiceId = res.body.data?.invoiceId ?? null;
    createdCaseIds.push(caseId);
    if (invoiceId) createdInvoiceIds.push(invoiceId);
    return { caseId, invoiceId };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-subresource-touch";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const {
      db,
      users,
      organizations,
      organizationMemberships,
      labLocations,
    } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `subresource_touch_${labOwnerId}`,
      password: "doesnotmatter",
      emailVerifiedAt: new Date(),
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("SubresourceTouchLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("SubresourceTouchPractice"),
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
    await db.insert(labLocations).values({
      id: locationId,
      labOrganizationId: labOrgId,
      code: "SCAN",
      name: "Scanning",
    });
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      caseEvents,
      caseNotes,
      caseLocations,
      invoiceLineItems,
      invoices,
      cases: casesTable,
      userSessions,
      organizationMemberships,
      labLocations,
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
      await db
        .delete(caseLocations)
        .where(inArray(caseLocations.caseId, createdCaseIds));
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
    await db.delete(labLocations).where(eq(labLocations.id, locationId));
    await db
      .delete(organizations)
      .where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  it("POST /:caseId/notes bumps cases.updatedAt", async () => {
    const { access } = await makeSession(labOwnerId);
    const app = appMod.default;

    const { caseId } = await createCase(access, app, "NoteTouch");

    const { db, cases: casesTable } = dbMod as any;
    const [before] = await db
      .select({ updatedAt: casesTable.updatedAt })
      .from(casesTable)
      .where(eq(casesTable.id, caseId));
    const beforeAt = (before.updatedAt as Date).getTime();

    await new Promise((r) => setTimeout(r, 15));

    const noteRes = await request(app)
      .post(`/api/cases/${caseId}/notes`)
      .set("Authorization", `Bearer ${access}`)
      .send({ noteText: "Bump test note", visibility: "internal_lab_only" });
    expect(noteRes.status).toBe(201);

    const [after] = await db
      .select({ updatedAt: casesTable.updatedAt })
      .from(casesTable)
      .where(eq(casesTable.id, caseId));
    expect((after.updatedAt as Date).getTime()).toBeGreaterThan(beforeAt);
  });

  it("POST /:caseId/notes surfaces the case first in GET /cases/recent", async () => {
    const { access } = await makeSession(labOwnerId);
    const app = appMod.default;

    // Create two cases; olderCase first.
    const { caseId: olderCaseId } = await createCase(access, app, "NoteOlder");
    await new Promise((r) => setTimeout(r, 20));
    const { caseId: newerCaseId } = await createCase(access, app, "NoteNewer");

    // newerCase should currently be at the top.
    const beforeRes = await request(app)
      .get("/api/cases/recent")
      .set("Authorization", `Bearer ${access}`);
    expect(beforeRes.status).toBe(200);
    const beforeIds: string[] = (beforeRes.body.data ?? beforeRes.body).map(
      (c: any) => c.id
    );
    expect(beforeIds.indexOf(newerCaseId)).toBeLessThan(
      beforeIds.indexOf(olderCaseId)
    );

    // Add a note to the older case so it should jump to the top.
    await new Promise((r) => setTimeout(r, 20));
    const noteRes = await request(app)
      .post(`/api/cases/${olderCaseId}/notes`)
      .set("Authorization", `Bearer ${access}`)
      .send({ noteText: "Recent ordering note", visibility: "internal_lab_only" });
    expect(noteRes.status).toBe(201);

    const afterRes = await request(app)
      .get("/api/cases/recent")
      .set("Authorization", `Bearer ${access}`);
    expect(afterRes.status).toBe(200);
    const afterIds: string[] = (afterRes.body.data ?? afterRes.body).map(
      (c: any) => c.id
    );
    expect(afterIds.indexOf(olderCaseId)).toBeGreaterThanOrEqual(0);
    expect(afterIds.indexOf(newerCaseId)).toBeGreaterThanOrEqual(0);
    // olderCase should now appear before newerCase.
    expect(afterIds.indexOf(olderCaseId)).toBeLessThan(
      afterIds.indexOf(newerCaseId)
    );
  });

  it("POST /:caseId/location-changes is retired in favor of canonical PATCH", async () => {
    const { access } = await makeSession(labOwnerId);
    const app = appMod.default;
    const { caseId } = await createCase(access, app, "RetiredLocationRoute");

    const response = await request(app)
      .post(`/api/cases/${caseId}/location-changes`)
      .set("Authorization", `Bearer ${access}`)
      .send({ labLocationId: locationId });
    expect(response.status).toBe(404);
  });
});
