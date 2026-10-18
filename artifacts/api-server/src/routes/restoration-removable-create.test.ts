/**
 * Regression guard: POST /api/cases — removable restoration types accept
 * toothNumber "N/A" and survive the round-trip to GET /api/cases/:id.
 *
 * This was the original regression: the desktop/mobile UI hid the Tooth #
 * field for removable types (Full Denture, Partial Denture, …) and sent
 * toothNumber:"N/A". The route must accept the value, create the case (201),
 * and persist the restoration row with toothNumber:"N/A".
 *
 * Skipped when DATABASE_URL is not configured — same convention as other
 * api-server DB integration tests (cases-ai-intake-carry-through.test.ts,
 * billing-revenuecat.test.ts).  All rows are deleted in afterAll so the suite
 * is safe against a shared dev DB.
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-rm-create"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("POST /api/cases — removable restoration types (db integration)", () => {
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
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-rm-create";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `rmowner_${labOwnerId.slice(-8)}`,
      password: "doesnotmatter",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("RemovableLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("RemovablePractice"),
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
      caseRestorations,
      invoiceLineItems,
      invoices,
      cases: casesTable,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    if (createdCaseIds.length) {
      if (caseEvents)
        await db
          .delete(caseEvents)
          .where(inArray(caseEvents.caseId, createdCaseIds));
      if (caseNotes)
        await db
          .delete(caseNotes)
          .where(inArray(caseNotes.caseId, createdCaseIds));
      if (caseRestorations)
        await db
          .delete(caseRestorations)
          .where(inArray(caseRestorations.caseId, createdCaseIds));
      const invRows = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.caseId, createdCaseIds));
      const invIds = invRows.map((r: any) => r.id);
      if (invoiceLineItems && invIds.length) {
        await db
          .delete(invoiceLineItems)
          .where(inArray(invoiceLineItems.invoiceId, invIds));
      }
      await db
        .delete(invoices)
        .where(inArray(invoices.caseId, createdCaseIds));
      await db
        .delete(casesTable)
        .where(inArray(casesTable.id, createdCaseIds));
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
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  // ── Core regression: toothNumber "N/A" accepted for removable types ─────────

  it('POST /api/cases returns 201 when a Full Denture restoration has toothNumber "N/A"', async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("RMD");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Jane",
        patientLastName: "Removable",
        doctorName: "Dr. Denture",
        status: "received",
        restorations: [
          {
            toothNumber: "N/A",
            restorationType: "Full Denture",
            material: "Acrylic",
            quantity: 1,
            unitPrice: 0,
            arch: "upper",
          },
        ],
      });

    expect(createResp.status).toBe(201);
    const caseId = createResp.body.data.id;
    createdCaseIds.push(caseId);

    // Verify the restoration row persists with toothNumber "N/A".
    const getResp = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);

    expect(getResp.status).toBe(200);
    const rests: any[] = (getResp.body.data ?? getResp.body).restorations ?? [];
    expect(rests.length).toBeGreaterThan(0);
    expect(rests[0].toothNumber).toBe("N/A");
    expect(rests[0].restorationType).toBe("Full Denture");
  });

  it('POST /api/cases returns 201 for Partial Denture with toothNumber "N/A"', async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("RMP");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Pat",
        patientLastName: "Partial",
        doctorName: "Dr. Partial",
        status: "received",
        restorations: [
          {
            toothNumber: "N/A",
            restorationType: "Partial Denture",
            quantity: 1,
            unitPrice: 0,
            arch: "upper",
          },
        ],
      });

    expect(createResp.status).toBe(201);
    createdCaseIds.push(createResp.body.data.id);
  });

  it('POST /api/cases returns 201 for Night Guard with toothNumber "N/A"', async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("RMNG");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Night",
        patientLastName: "Guard",
        doctorName: "Dr. Guard",
        status: "received",
        restorations: [
          {
            toothNumber: "N/A",
            restorationType: "Night Guard",
            quantity: 1,
            unitPrice: 0,
            arch: "upper",
          },
        ],
      });

    expect(createResp.status).toBe(201);
    createdCaseIds.push(createResp.body.data.id);
  });

  it('POST /api/cases returns 201 for Retainer with toothNumber "N/A"', async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("RMR");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Rex",
        patientLastName: "Retainer",
        doctorName: "Dr. Retainer",
        status: "received",
        restorations: [
          {
            toothNumber: "N/A",
            restorationType: "Retainer",
            quantity: 1,
            unitPrice: 0,
            arch: "upper",
          },
        ],
      });

    expect(createResp.status).toBe(201);
    createdCaseIds.push(createResp.body.data.id);
  });

  // ── Fixed types still require a real tooth number (regression boundary) ─────

  it('POST /api/cases returns 201 for Crown with a numeric toothNumber — confirming fixed types still work', async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("RMFIX");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Fix",
        patientLastName: "Crown",
        doctorName: "Dr. Crown",
        status: "received",
        restorations: [
          {
            toothNumber: "14",
            restorationType: "Crown",
            material: "Zirconia",
            quantity: 1,
            unitPrice: 0,
          },
        ],
      });

    expect(createResp.status).toBe(201);
    createdCaseIds.push(createResp.body.data.id);
  });

  // ── Mixed restoration row: removable + fixed in the same case ──────────────

  it('POST /api/cases returns 201 with mixed restorations (removable N/A + fixed tooth#)', async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("RMMIX");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Mix",
        patientLastName: "Case",
        doctorName: "Dr. Mix",
        status: "received",
        restorations: [
          {
            toothNumber: "N/A",
            restorationType: "Full Denture",
            quantity: 1,
            unitPrice: 0,
            arch: "upper",
          },
          {
            toothNumber: "3",
            restorationType: "Crown",
            material: "Zirconia",
            quantity: 1,
            unitPrice: 0,
          },
        ],
      });

    expect(createResp.status).toBe(201);
    const caseId = createResp.body.data.id;
    createdCaseIds.push(caseId);

    const getResp = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);

    const rests: any[] = (getResp.body.data ?? getResp.body).restorations ?? [];
    expect(rests.length).toBe(2);
    const removable = rests.find((r: any) => r.restorationType === "Full Denture");
    const fixed = rests.find((r: any) => r.restorationType === "Crown");
    expect(removable?.toothNumber).toBe("N/A");
    expect(fixed?.toothNumber).toBe("3");
  });
});
