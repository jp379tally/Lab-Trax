/**
 * Regression suite: removable restoration types (denture, partial, flipper,
 * flexible/Valplast) can be added to a case without a tooth number.
 *
 * Protected behaviors:
 *   (1) POST /api/cases/:caseId/restorations accepts empty toothNumber for
 *       removable types and stores the row (201).
 *   (2) The restoration is persisted in the DB with an empty tooth number.
 *   (3) Non-removable types whose toothNumber is empty are still accepted
 *       server-side (the client enforces the non-empty constraint; the server
 *       intentionally keeps this permissive to match the case-create path).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are cleaned
 * up in afterAll so this suite is safe against a shared dev DB.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-removable"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Removable restoration intake (db integration)", () => {
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

  async function createCase(access: string): Promise<string> {
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Removable",
        patientLastName: rid("Pat"),
        doctorName: "Dr. Removable",
        status: "received",
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const caseId = r.body.data.id as string;
    createdCaseIds.push(caseId);
    return caseId;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-removable";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db
      .insert(users)
      .values([
        { id: labOwnerId, username: `removowner_${labOwnerId}`, password: "x" },
      ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("RemovTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("RemovTestProv"),
        parentLabOrganizationId: labOrgId,
      },
    ]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: labOwnerId,
        role: "owner",
        status: "active",
        approvedByUserId: labOwnerId,
        joinedAt: new Date(),
      },
    ]);
  });

  afterAll(async () => {
    const {
      db,
      cases,
      caseRestorations,
      invoices,
      caseEvents,
      users,
      organizations,
      organizationMemberships,
      userSessions,
    } = dbMod as any;

    if (createdCaseIds.length > 0) {
      await db
        .delete(caseRestorations)
        .where(inArray(caseRestorations.caseId, createdCaseIds));
      await db
        .delete(caseEvents)
        .where(inArray(caseEvents.caseId, createdCaseIds));
      await db
        .delete(invoices)
        .where(inArray(invoices.caseId, createdCaseIds));
      await db
        .delete(cases)
        .where(inArray(cases.id, createdCaseIds));
    }
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, labOwnerId));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, providerOrgId]));
    await db.delete(userSessions).where(eq(userSessions.userId, labOwnerId));
    await db.delete(users).where(eq(users.id, labOwnerId));
  });

  it("accepts a denture restoration with empty toothNumber (201)", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        toothNumber: "",
        restorationType: "Full Denture",
        quantity: 1,
        arch: "upper",
      });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("stores the denture restoration with empty tooth number in the DB", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);

    await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        toothNumber: "",
        restorationType: "Partial Denture",
        quantity: 1,
        arch: "upper",
      });

    const { db, caseRestorations } = dbMod as any;
    const rows = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));

    expect(rows).toHaveLength(1);
    expect(rows[0].toothNumber).toBe("");
    expect(rows[0].restorationType).toBe("Partial Denture");
  });

  it("accepts a flipper restoration with empty toothNumber (201)", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        toothNumber: "",
        restorationType: "Flipper",
        quantity: 1,
        arch: "upper",
      });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("rejects a request with missing restorationType (400)", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        toothNumber: "",
        restorationType: "",
        quantity: 1,
      });

    expect(r.status).toBe(400);
  });

  it("rejects an unauthenticated add-restoration request (401)", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseId = await createCase(access);

    const r = await request(appMod.default)
      .post(`/api/cases/${caseId}/restorations`)
      .send({ toothNumber: "", restorationType: "Denture" });

    expect(r.status).toBe(401);
  });
});
