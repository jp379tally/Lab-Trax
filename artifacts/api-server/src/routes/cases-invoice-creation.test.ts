/**
 * Regression suite: Case creation → invoice auto-generation invariants.
 *
 * Protected behaviors:
 *   (1) Creating a case via POST /api/cases results in an invoice row whose
 *       caseId matches the newly created case ("auto-invoice on case creation").
 *   (2) The invoice's labOrganizationId and providerOrganizationId match the
 *       case ("invoice must link to the correct Case ID").
 *   (3) The invoice is given status "open" (not "draft") on auto-generation.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are cleaned
 * up in afterAll so this suite is safe against a shared dev DB.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-casinv"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Case creation → invoice invariants (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  const createdCaseIds: string[] = [];

  async function makeSession(userId: string): Promise<{ access: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-casinv";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `casinvowner_${labOwnerId}`,
      password: "doesnotmatter",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("CasInvTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("CasInvTestPractice"),
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
      if (caseEvents) await db.delete(caseEvents).where(inArray(caseEvents.caseId, createdCaseIds));
      if (caseNotes) await db.delete(caseNotes).where(inArray(caseNotes.caseId, createdCaseIds));
      const invRows = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.caseId, createdCaseIds));
      const invIds = invRows.map((r: any) => r.id);
      if (invoiceLineItems && invIds.length) {
        await db.delete(invoiceLineItems).where(inArray(invoiceLineItems.invoiceId, invIds));
      }
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds));
      await db.delete(casesTable).where(inArray(casesTable.id, createdCaseIds));
    }

    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db.delete(invoices).where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db.delete(casesTable).where(inArray(casesTable.labOrganizationId, [labOrgId]));
    await db.delete(userSessions).where(inArray(userSessions.userId, [labOwnerId]));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labOwnerId]),
    );
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  // ── (1) Auto-invoice caseId matches the newly created case ───────────────

  it("(1) POST /api/cases: auto-generated invoice has caseId matching the new case", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("CN");

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Invoice",
        patientLastName: "CaseLink",
        doctorName: "Dr. Link",
        status: "received",
      });

    expect(r.status).toBe(201);
    const caseId = r.body.data.id;
    createdCaseIds.push(caseId);

    const { db, invoices } = dbMod as any;
    let invoice: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 100));
      [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.caseId, caseId));
      if (invoice) break;
    }

    expect(invoice, "auto-invoice must be created within 2 s of case creation").toBeDefined();
    expect(invoice.caseId).toBe(caseId);
  });

  // ── (2) Invoice links correct org IDs ────────────────────────────────────

  it("(2) Auto-generated invoice carries correct labOrganizationId and providerOrganizationId", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("CN");

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "OrgLink",
        patientLastName: "Test",
        doctorName: "Dr. OrgLink",
        status: "received",
      });

    expect(r.status).toBe(201);
    const caseId = r.body.data.id;
    createdCaseIds.push(caseId);

    const { db, invoices } = dbMod as any;
    let invoice: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 100));
      [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.caseId, caseId));
      if (invoice) break;
    }

    expect(invoice, "auto-invoice must be created within 2 s").toBeDefined();
    expect(invoice.labOrganizationId).toBe(labOrgId);
    expect(invoice.providerOrganizationId).toBe(providerOrgId);
  });

  // ── (3) Auto-generated invoice is "open" ─────────────────────────────────

  it("(3) Auto-generated invoice has status 'open'", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("CN");

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "StatusCheck",
        patientLastName: "Test",
        doctorName: "Dr. Status",
        status: "received",
      });

    expect(r.status).toBe(201);
    const caseId = r.body.data.id;
    createdCaseIds.push(caseId);

    const { db, invoices } = dbMod as any;
    let invoice: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 100));
      [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.caseId, caseId));
      if (invoice) break;
    }

    expect(invoice, "auto-invoice must be created within 2 s").toBeDefined();
    expect(invoice.status).toBe("open");
  });

  // ── (4) GET /api/invoices/:id returns caseId matching the created case ────

  it("(4) GET /api/invoices/:id returns invoice with caseId matching the new case", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("CN");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "ApiGet",
        patientLastName: "Test",
        doctorName: "Dr. ApiGet",
        status: "received",
      });

    expect(createResp.status).toBe(201);
    const caseId = createResp.body.data.id;
    createdCaseIds.push(caseId);

    const { db, invoices } = dbMod as any;
    let invoice: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 100));
      [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.caseId, caseId));
      if (invoice) break;
    }
    expect(invoice, "auto-invoice must exist before API fetch").toBeDefined();

    const getResp = await request(appMod.default)
      .get(`/api/invoices/${invoice.id}`)
      .set("Authorization", `Bearer ${access}`);

    expect(getResp.status).toBe(200);
    expect(getResp.body.data.caseId).toBe(caseId);
  });
});
