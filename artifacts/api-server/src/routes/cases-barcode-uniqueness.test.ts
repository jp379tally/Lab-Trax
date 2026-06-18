/**
 * Integration tests for the barcode uniqueness enforcement on PATCH /api/cases/:id.
 *
 * These tests guard the server-side checkBarcodeUniqueness pre-check and the
 * cases_barcode_unique_per_lab partial index. A future refactor that silently
 * weakens either layer would break these tests.
 *
 * Skipped when DATABASE_URL is not configured. All rows are removed in
 * afterAll so the suite is safe against a shared dev DB.
 *
 * Coverage:
 *  - PATCH /cases/:id with a barcode already used by another active case → 409
 *  - The 409 body names the conflicting case number
 *  - PATCH with the same barcode as a *completed* case → 200 (barcode released)
 *  - POST /cases with a barcode already used by another active case → 409
 *  - allowDuplicateBarcode:true in the PATCH body is ignored — still 409
 *  - Assigning the same barcode back to the same case (no change) → 200
 *  - Assigning a barcode that belongs to a *different lab* → 200 (no cross-lab collision)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import * as path from "node:path";
import request from "supertest";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-barcode"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

maybe("Barcode uniqueness enforcement (PATCH /api/cases/:id)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab2");
  const providerOrgId = rid("prov");

  const createdCaseIds: string[] = [];

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return authLib.signAccessToken(userId, sessionId);
  }

  /** Create a canonical case via POST /api/cases; push its id into createdCaseIds. */
  async function createCase(
    access: string,
    opts: {
      caseNumber?: string;
      casePanBarcode?: string;
      labId?: string;
      practiceId?: string;
      status?: string;
    } = {}
  ): Promise<string> {
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: opts.caseNumber ?? rid("CN"),
        labOrganizationId: opts.labId ?? labOrgId,
        providerOrganizationId: opts.practiceId ?? providerOrgId,
        patientFirstName: "Pat",
        patientLastName: "Test",
        doctorName: "Dr. Test",
        status: opts.status ?? "received",
        ...(opts.casePanBarcode !== undefined ? { casePanBarcode: opts.casePanBarcode } : {}),
      });
    if (r.status !== 201) {
      throw new Error(`createCase failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
    const id: string = r.body.data.id;
    createdCaseIds.push(id);
    return id;
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-barcode";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `brcowner_${labOwnerId}`,
      password: "doesnotmatter",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("BarcodeTestLab") },
      { id: otherLabOrgId, type: "lab", name: rid("OtherBarcodeTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("BarcodeTestPractice"),
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m1"),
        labId: labOrgId,
        userId: labOwnerId,
        role: "owner",
        status: "active",
        approvedByUserId: labOwnerId,
        joinedAt: new Date(),
      },
      {
        id: rid("m2"),
        labId: otherLabOrgId,
        userId: labOwnerId,
        role: "owner",
        status: "active",
        approvedByUserId: labOwnerId,
        joinedAt: new Date(),
      },
    ]);
  });

  // Ensure a fresh session exists before each test; per-test sessions created
  // in each it() body are still the authoritative token for that test.
  beforeEach(async () => {
    await makeSession(labOwnerId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      auditLogs,
      caseEvents,
      caseNotes,
      invoices,
      cases: casesTable,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    if (createdCaseIds.length) {
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, createdCaseIds));
      await db.delete(caseNotes).where(inArray(caseNotes.caseId, createdCaseIds));
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds));
    }
    await db.delete(auditLogs).where(
      inArray(auditLogs.organizationId, [labOrgId, otherLabOrgId, providerOrgId])
    );
    await db.delete(invoices).where(
      inArray(invoices.labOrganizationId, [labOrgId, otherLabOrgId])
    );
    await db.delete(casesTable).where(
      inArray(casesTable.labOrganizationId, [labOrgId, otherLabOrgId])
    );
    await db.delete(userSessions).where(inArray(userSessions.userId, [labOwnerId]));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labOwnerId])
    );
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, otherLabOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  // ── PATCH — conflict with another active case ────────────────────────────

  it("PATCH /cases/:id returns 409 when barcode is already assigned to another active case", async () => {
    const access = await makeSession(labOwnerId);
    const barcode = `BRC${randomBytes(4).toString("hex").toUpperCase()}`;

    // Case A already holds the barcode.
    await createCase(access, { casePanBarcode: barcode });

    // Case B tries to claim the same barcode.
    const caseBId = await createCase(access);

    const r = await request(appMod.default)
      .patch(`/api/cases/${caseBId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ casePanBarcode: barcode });

    expect(r.status).toBe(409);
  });

  it("PATCH /cases/:id 409 body names the conflicting case number", async () => {
    const access = await makeSession(labOwnerId);
    const barcode = `BRC${randomBytes(4).toString("hex").toUpperCase()}`;
    const conflictingCaseNumber = rid("CONFCN");

    // Case A holds the barcode.
    await createCase(access, { caseNumber: conflictingCaseNumber, casePanBarcode: barcode });

    // Case B tries to claim the same barcode.
    const caseBId = await createCase(access);

    const r = await request(appMod.default)
      .patch(`/api/cases/${caseBId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ casePanBarcode: barcode });

    expect(r.status).toBe(409);
    // The error message must name the conflicting case number so the client can surface it.
    const body = JSON.stringify(r.body);
    expect(body).toContain(conflictingCaseNumber);
  });

  // ── PATCH — barcode released when prior case is complete ─────────────────

  it("PATCH /cases/:id succeeds when the same barcode belongs to a completed case", async () => {
    const access = await makeSession(labOwnerId);
    const barcode = `BRC${randomBytes(4).toString("hex").toUpperCase()}`;

    // Case A holds the barcode and is then completed (barcode auto-cleared).
    const caseAId = await createCase(access, { casePanBarcode: barcode });
    const complete = await request(appMod.default)
      .patch(`/api/cases/${caseAId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "complete" });
    expect(complete.status).toBe(200);

    // Case B can now claim the same barcode because it is no longer in use.
    const caseBId = await createCase(access);

    const r = await request(appMod.default)
      .patch(`/api/cases/${caseBId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ casePanBarcode: barcode });

    expect(r.status).toBe(200);
  });

  it("completing a case clears its barcode so GET /cases/:id shows null", async () => {
    const access = await makeSession(labOwnerId);
    const barcode = `BRC${randomBytes(4).toString("hex").toUpperCase()}`;
    const caseId = await createCase(access, { casePanBarcode: barcode });

    // Sanity: barcode is set.
    const before = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(before.status).toBe(200);
    expect(before.body.data.casePanBarcode).toBe(barcode);

    // Complete the case — barcode should be atomically cleared.
    const complete = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "complete" });
    expect(complete.status).toBe(200);

    const after = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(after.status).toBe(200);
    expect(after.body.data.casePanBarcode).toBeNull();
  });

  // ── POST — conflict on creation ──────────────────────────────────────────

  it("POST /cases returns 409 when barcode is already used by another active case", async () => {
    const access = await makeSession(labOwnerId);
    const barcode = `BRC${randomBytes(4).toString("hex").toUpperCase()}`;

    // Case A already holds the barcode.
    await createCase(access, { casePanBarcode: barcode });

    // Trying to create Case B with the same barcode must fail.
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("POSTDUP"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Post",
        patientLastName: "Dup",
        doctorName: "Dr. Dup",
        casePanBarcode: barcode,
      });

    expect(r.status).toBe(409);
    // Error must not expose raw Postgres / Drizzle internals.
    const barcodeMsg: string =
      r.body.message ?? r.body.error ?? JSON.stringify(r.body);
    expect(barcodeMsg).not.toMatch(/insert into|duplicate key violates|drizzle/i);
  });

  // ── allowDuplicateBarcode is not accepted ────────────────────────────────

  it("PATCH /cases/:id ignores allowDuplicateBarcode:true — still returns 409", async () => {
    const access = await makeSession(labOwnerId);
    const barcode = `BRC${randomBytes(4).toString("hex").toUpperCase()}`;

    // Case A holds the barcode.
    await createCase(access, { casePanBarcode: barcode });

    // Case B tries to claim the same barcode with the removed override flag.
    const caseBId = await createCase(access);

    const r = await request(appMod.default)
      .patch(`/api/cases/${caseBId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ casePanBarcode: barcode, allowDuplicateBarcode: true });

    // The flag is no longer honoured — uniqueness is absolute.
    expect(r.status).toBe(409);
  });

  // ── Re-assigning the same barcode to the same case is a no-op ───────────

  it("PATCH /cases/:id with the case's own barcode (unchanged) returns 200", async () => {
    const access = await makeSession(labOwnerId);
    const barcode = `BRC${randomBytes(4).toString("hex").toUpperCase()}`;
    const caseId = await createCase(access, { casePanBarcode: barcode });

    // Patching with the same barcode must not self-conflict.
    const r = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ casePanBarcode: barcode });

    expect(r.status).toBe(200);
  });

  // ── Barcode uniqueness is scoped to the lab ──────────────────────────────

  it("PATCH /cases/:id allows the same barcode in a different lab (cross-lab isolation)", async () => {
    const access = await makeSession(labOwnerId);
    const barcode = `BRC${randomBytes(4).toString("hex").toUpperCase()}`;

    // Provision a provider org for the second lab.
    const { db, organizations, cases: casesTable, invoices, caseEvents, caseNotes, auditLogs } = dbMod as any;
    const otherProvOrgId = rid("prov2");
    await db.insert(organizations).values({
      id: otherProvOrgId,
      type: "provider",
      name: rid("OtherPractice"),
      parentLabOrganizationId: otherLabOrgId,
    });

    let caseBId: string | null = null;
    try {
      // Case A lives in Lab 1 and holds the barcode.
      await createCase(access, { casePanBarcode: barcode });

      // Case B lives in Lab 2 — the same barcode should be allowed.
      caseBId = await createCase(access, {
        labId: otherLabOrgId,
        practiceId: otherProvOrgId,
        casePanBarcode: barcode,
      });

      // Confirm Case B was created with the barcode.
      const r = await request(appMod.default)
        .get(`/api/cases/${caseBId}`)
        .set("Authorization", `Bearer ${access}`);
      expect(r.status).toBe(200);
      expect(r.body.data.casePanBarcode).toBe(barcode);
    } finally {
      // Delete Case B and its dependents before dropping the org (FK order).
      if (caseBId) {
        await db.delete(caseEvents).where(eq(caseEvents.caseId, caseBId));
        await db.delete(caseNotes).where(eq(caseNotes.caseId, caseBId));
        await db.delete(invoices).where(eq(invoices.caseId, caseBId));
        await db.delete(auditLogs).where(eq(auditLogs.organizationId, otherLabOrgId));
        await db.delete(casesTable).where(eq(casesTable.id, caseBId));
        // Remove from the tracking list so afterAll doesn't try to delete it again.
        const idx = createdCaseIds.indexOf(caseBId);
        if (idx !== -1) createdCaseIds.splice(idx, 1);
      }
      await db.delete(organizations).where(eq(organizations.id, otherProvOrgId));
    }
  });
});
