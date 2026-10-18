/**
 * Integration tests for core case lifecycle routes (regression guard).
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/cases — creates a case (201)
 *  - GET /api/cases/:id — returns the case detail
 *  - GET /api/cases — list filtered by labOrganizationId
 *  - DELETE /api/cases/:caseId — soft-deletes; row still present with deletedAt set
 *  - GET /api/cases/:id for unknown case returns 404
 *  - Unauthenticated requests return 401
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq, isNotNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-cases"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("Cases core lifecycle (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let authLib: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  // Track case IDs created during tests for cleanup.
  const createdCaseIds: string[] = [];

  async function makeSession(userId: string): Promise<{ access: string; refresh: string }> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refresh = authLib.signRefreshToken(userId, sessionId);
    const hash = createHash("sha256").update(refresh).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    const access = authLib.signAccessToken(userId, sessionId);
    return { access, refresh };
  }

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-cases";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `caseowner_${labOwnerId}`,
      password: "doesnotmatter",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("CasesTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("CasesTestPractice"),
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

    // Case-level dependents first.
    if (createdCaseIds.length) {
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, createdCaseIds));
      await db.delete(caseNotes).where(inArray(caseNotes.caseId, createdCaseIds));
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds));
    }
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db.delete(invoices).where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db.delete(casesTable).where(inArray(casesTable.labOrganizationId, [labOrgId]));
    await db.delete(userSessions).where(inArray(userSessions.userId, [labOwnerId]));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labOwnerId])
    );
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  // ── POST /api/cases ───────────────────────────────────────────────────────

  it("POST /api/cases creates a case and returns 201", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("CN");

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "John",
        patientLastName: "Doe",
        doctorName: "Dr. Synthetic063",
        status: "received",
      });

    expect(r.status).toBe(201);
    expect(r.body.data).toBeDefined();
    expect(r.body.data.patientFirstName).toBe("John");
    expect(r.body.data.patientLastName).toBe("Doe");
    expect(r.body.data.labOrganizationId).toBe(labOrgId);

    if (r.body.data?.id) createdCaseIds.push(r.body.data.id);
  });

  it("keeps normal Created timestamps separate from backdated Received dates across list and detail", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("DATE");
    const requestStartedAt = Date.now();
    const created = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Created",
        patientLastName: "VersusReceived",
        doctorName: "Dr. Date",
        status: "received",
        receivedAt: "2020-09-19",
      });

    expect(created.status).toBe(201);
    const caseId = created.body?.data?.id;
    expect(caseId).toBeTruthy();
    if (!caseId) return;
    createdCaseIds.push(caseId);

    const createdAt = new Date(created.body.data.createdAt).getTime();
    expect(createdAt).toBeGreaterThanOrEqual(requestStartedAt - 1_000);
    expect(createdAt).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(created.body.data.receivedAt).toContain("2020-09-19");

    const [detail, list] = await Promise.all([
      request(appMod.default)
        .get(`/api/cases/${caseId}`)
        .set("Authorization", `Bearer ${access}`),
      request(appMod.default)
        .get(`/api/cases?labOrganizationId=${encodeURIComponent(labOrgId)}`)
        .set("Authorization", `Bearer ${access}`),
    ]);
    expect(detail.status).toBe(200);
    expect(detail.body.data.createdAt).toBe(created.body.data.createdAt);
    expect(detail.body.data.receivedAt).toContain("2020-09-19");
    const listedCase = (list.body?.data ?? []).find((item: any) => item.id === caseId);
    expect(list.status).toBe(200);
    expect(listedCase?.createdAt).toBe(created.body.data.createdAt);
    expect(listedCase?.receivedAt).toContain("2020-09-19");
  });

  it("POST /api/cases missing required fields returns 400", async () => {
    const { access } = await makeSession(labOwnerId);

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({ labOrganizationId: labOrgId });

    expect(r.status).toBe(400);
  });

  it("unauthenticated POST /api/cases returns 401", async () => {
    const r = await request(appMod.default)
      .post("/api/cases")
      .send({
        caseNumber: "X-1",
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "A",
        patientLastName: "B",
        doctorName: "Dr. C",
      });
    expect(r.status).toBe(401);
  });

  // ── GET /api/cases/:id ────────────────────────────────────────────────────

  it("GET /api/cases/:id returns the full case detail", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("GC");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Jane",
        patientLastName: "Smith",
        doctorName: "Dr. Synthetic047",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(get.status).toBe(200);
    expect(get.body.data.id).toBe(caseId);
    expect(get.body.data.patientFirstName).toBe("Jane");
  });

  it("GET /api/cases/:id flags restorations with unrecognized materials", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("UM");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Unknown",
        patientLastName: "Material",
        doctorName: "Dr. Mystery",
        restorations: [
          // Maps to a known price key (zirconia_crown) — must NOT be flagged.
          { toothNumber: "14", restorationType: "Crown & Bridge", material: "Zirconia" },
          // Unmappable material — silently $0, must be flagged by name.
          { toothNumber: "15", restorationType: "Crown & Bridge", material: "Unobtanium" },
        ],
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(get.status).toBe(200);
    const unrecognized: string[] = get.body.data.unrecognizedMaterials ?? [];
    expect(unrecognized).toContain("Unobtanium");
    expect(unrecognized).not.toContain("Zirconia");
  });

  it("GET /api/cases/:id has empty unrecognizedMaterials when all map", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("KM");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Known",
        patientLastName: "Material",
        doctorName: "Dr. Known",
        restorations: [
          { toothNumber: "8", restorationType: "Crown & Bridge", material: "Zirconia" },
          { toothNumber: "9", restorationType: "Crown & Bridge", material: "E.max" },
        ],
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(get.status).toBe(200);
    expect(get.body.data.unrecognizedMaterials).toEqual([]);
  });

  it("GET /api/cases/:id for unknown case returns 404", async () => {
    const { access } = await makeSession(labOwnerId);

    const r = await request(appMod.default)
      .get("/api/cases/nonexistent-case-id-xyz-abc")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(404);
  });

  // ── GET /api/cases ────────────────────────────────────────────────────────

  it("GET /api/cases?labOrganizationId=... returns cases for that lab", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("LC");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "List",
        patientLastName: "Test",
        doctorName: "Dr. Synthetic051",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const list = await request(appMod.default)
      .get(`/api/cases?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    const ids: string[] = (list.body.data ?? []).map((c: any) => c.id);
    expect(ids).toContain(caseId);
  });

  // ── PATCH /api/cases/:caseId (status transition) ─────────────────────────

  it("PATCH /api/cases/:caseId updates status field", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("PC");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Patch",
        patientLastName: "Me",
        doctorName: "Dr. Patch",
        status: "received",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "in_design" });
    expect(patch.status).toBe(200);
    expect(patch.body.data?.status ?? patch.body.status).toBe("in_design");
  });

  // ── PATCH casePanBarcode: null regression guard ───────────────────────────

  it("PATCH /api/cases/:caseId with casePanBarcode: null returns 200 (not 400)", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("BRC");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Barcode",
        patientLastName: "Test",
        doctorName: "Dr. Barcode",
        status: "received",
        casePanBarcode: "INIT-BARCODE",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({
        patientFirstName: "Barcode",
        patientLastName: "Test",
        doctorName: "Dr. Barcode",
        priority: "normal",
        casePanBarcode: null,
      });
    expect(patch.status).toBe(200);
  });

  // ── casePanBarcode: leading-zero preservation + detail + barcode lookup ───

  it("POST /api/cases with casePanBarcode stores leading zeros exactly", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("LZ");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Barcode",
        patientLastName: "LeadingZero",
        doctorName: "Dr. Zero",
        casePanBarcode: "00125",
      });

    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    // Barcode must be returned verbatim in case detail.
    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(get.status).toBe(200);
    expect(get.body.data.casePanBarcode).toBe("00125");
  });

  it("GET /api/cases/barcode/:code returns the case with that barcode", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("BLC");
    const barcode = `00001${rid("b")}`;

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Barcode",
        patientLastName: "Lookup",
        doctorName: "Dr. Lookup",
        casePanBarcode: barcode,
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);
    // Verify the barcode was persisted during creation.
    expect(create.body.data.casePanBarcode).toBe(barcode);

    const lookup = await request(appMod.default)
      .get(`/api/cases/barcode/${encodeURIComponent(barcode)}?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    // Emit actual body to aid debugging if assertions fail.
    if (lookup.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("Barcode lookup unexpected status:", lookup.status, JSON.stringify(lookup.body));
    }
    expect(lookup.status).toBe(200);
    // Endpoint returns ok(res, { case: found }) → { ok: true, data: { case: {...} } }
    expect(lookup.body?.data?.case?.id).toBe(caseId);
    expect(lookup.body?.data?.case?.casePanBarcode).toBe(barcode);
  });

  it("GET /api/cases/barcode/:code returns 404 when no case matches", async () => {
    const { access } = await makeSession(labOwnerId);

    const r = await request(appMod.default)
      .get(`/api/cases/barcode/99999999999999?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(404);
  });

  // ── Cross-lab scoping ──────────────────────────────────────────────────────

  it("GET /api/cases/:id returns 404 for a user not in the lab", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("XLSC");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "CrossLab",
        patientLastName: "Scope",
        doctorName: "Dr. Scope",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    // A different user with no membership in this lab.
    const outsiderId = rid("xlsout");
    const { db, users, userSessions } = dbMod as any;
    await db.insert(users).values({ id: outsiderId, username: `xlsout_${outsiderId}`, password: "x" });
    try {
      const { access: outsiderAccess } = await makeSession(outsiderId);
      const r = await request(appMod.default)
        .get(`/api/cases/${caseId}`)
        .set("Authorization", `Bearer ${outsiderAccess}`);
      // assertCaseAccess checks lab membership; non-members get 403 (not a member)
      // rather than 404 (case not found), which is the correct scoping behaviour.
      expect(r.status).toBe(403);
    } finally {
      await db.delete(userSessions).where(eq(userSessions.userId, outsiderId));
      await db.delete(users).where(eq(users.id, outsiderId));
    }
  });

  // ── DELETE /api/cases/:caseId (soft-delete) ───────────────────────────────

  // ── Pre-create duplicate-doctor checkpoint ────────────────────────────────

  it("POST /api/cases blocks a near-duplicate doctor name with a 409 confirmation", async () => {
    const { access } = await makeSession(labOwnerId);

    // Seed an existing doctor in the practice.
    const seed = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("DD1"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Dup",
        patientLastName: "Seed",
        doctorName: "Dr. Kanesha Cole",
      });
    expect(seed.status).toBe(201);
    createdCaseIds.push(seed.body.data.id);

    // A normalized-equal variant ("Kanesha Cole") must be caught before saving.
    const blocked = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("DD2"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Dup",
        patientLastName: "Blocked",
        doctorName: "Kanesha Cole",
      });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details?.code).toBe("DOCTOR_CONFIRMATION_REQUIRED");
    const candidateNames: string[] = (blocked.body.details?.candidates ?? []).map(
      (c: any) => c.doctorName,
    );
    expect(candidateNames).toContain("Dr. Kanesha Cole");
  });

  it("POST /api/cases with confirmNewDoctor=true bypasses the checkpoint", async () => {
    const { access } = await makeSession(labOwnerId);

    const seed = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("DC1"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Confirm",
        patientLastName: "Seed",
        doctorName: "Dr. Marcus Webb",
      });
    expect(seed.status).toBe(201);
    createdCaseIds.push(seed.body.data.id);

    const confirmed = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("DC2"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Confirm",
        patientLastName: "New",
        doctorName: "Marcus Webb",
        confirmNewDoctor: true,
      });
    expect(confirmed.status).toBe(201);
    createdCaseIds.push(confirmed.body.data.id);
  });

  it("POST /api/cases does NOT flag a literal-exact existing doctor name", async () => {
    const { access } = await makeSession(labOwnerId);

    const seed = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("EX1"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Exact",
        patientLastName: "Seed",
        doctorName: "Dr. Olivia Pratt",
      });
    expect(seed.status).toBe(201);
    createdCaseIds.push(seed.body.data.id);

    // Reusing the exact same doctor name (case-insensitive) must save directly.
    const reuse = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("EX2"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Exact",
        patientLastName: "Reuse",
        doctorName: "dr. olivia pratt",
      });
    expect(reuse.status).toBe(201);
    createdCaseIds.push(reuse.body.data.id);
  });

  it("GET /api/cases/doctor-similarity returns matching doctors in the practice", async () => {
    const { access } = await makeSession(labOwnerId);

    const seed = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("DS1"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Sim",
        patientLastName: "Seed",
        doctorName: "Dr. Priya Nair",
      });
    expect(seed.status).toBe(201);
    createdCaseIds.push(seed.body.data.id);

    const sim = await request(appMod.default)
      .get(
        `/api/cases/doctor-similarity?labOrganizationId=${labOrgId}` +
          `&providerOrganizationId=${providerOrgId}&doctorName=${encodeURIComponent("Priya Nair")}`,
      )
      .set("Authorization", `Bearer ${access}`);
    expect(sim.status).toBe(200);
    const names: string[] = (sim.body.data?.matches ?? []).map((m: any) => m.doctorName);
    expect(names).toContain("Dr. Priya Nair");
  });

  // ── expectedDeliveryDate / dueDate precedence ─────────────────────────────

  it("POST /api/cases with explicit dueDate sets expectedDeliveryDate to null", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("EDD");
    const explicitDue = "2026-07-21";

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Jane",
        patientLastName: "Roe",
        doctorName: "Dr. Due",
        status: "received",
        dueDate: explicitDue,
      });

    expect(r.status).toBe(201);
    const created = r.body.data;
    expect(created).toBeDefined();
    if (created?.id) createdCaseIds.push(created.id);

    expect(created.expectedDeliveryDate).toBeNull();
    expect(new Date(created.dueDate).toISOString().slice(0, 10)).toBe(explicitDue);
  });

  it("POST /api/cases stores an optional dueTime and returns it in list and detail", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("DUE_TIME");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Due",
        patientLastName: "Time",
        doctorName: "Dr. Clock",
        dueDate: "2026-07-21",
        dueTime: "09:30",
      });

    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);
    expect(create.body.data.dueTime).toBe("09:30");

    const detail = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.dueTime).toBe("09:30");

    const list = await request(appMod.default)
      .get(`/api/cases?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(list.status).toBe(200);
    expect(list.body.data.find((item: any) => item.id === caseId)?.dueTime).toBe("09:30");
  });

  it("rejects a dueTime without a dueDate and invalid due times", async () => {
    const { access } = await makeSession(labOwnerId);
    const base = {
      caseNumber: rid("DUE_TIME_BAD"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      patientFirstName: "Invalid",
      patientLastName: "Time",
      doctorName: "Dr. Invalid",
    };

    const withoutDate = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({ ...base, dueTime: "09:30" });
    expect(withoutDate.status).toBe(400);

    const invalid = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({ ...base, caseNumber: rid("DUE_TIME_INVALID"), dueDate: "2026-07-21", dueTime: "25:00" });
    expect(invalid.status).toBe(400);
  });

  it("POST /api/cases without dueDate auto-populates expectedDeliveryDate", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("EDDA");

    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Auto",
        patientLastName: "Date",
        doctorName: "Dr. Auto",
        status: "received",
      });

    expect(r.status).toBe(201);
    const created = r.body.data;
    if (created?.id) createdCaseIds.push(created.id);

    expect(created.expectedDeliveryDate).not.toBeNull();
  });

  it("PATCH /api/cases/:id with dueDate clears expectedDeliveryDate", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("EDDP");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Patch",
        patientLastName: "Due",
        doctorName: "Dr. Patch",
        status: "received",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    // Sanity: auto-created case has an expectedDeliveryDate set.
    expect(create.body.data.expectedDeliveryDate).not.toBeNull();

    const newDue = "2026-08-01";
    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ dueDate: newDue });

    expect(patch.status).toBe(200);
    const updated = patch.body.data;
    expect(updated.expectedDeliveryDate).toBeNull();
    expect(new Date(updated.dueDate).toISOString().slice(0, 10)).toBe(newDue);
  });

  it("PATCH /api/cases/:id persists, preserves, and clears dueTime with dueDate", async () => {
    const { access } = await makeSession(labOwnerId);
    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("DUE_TIME_PATCH"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Patch",
        patientLastName: "Time",
        doctorName: "Dr. Clock",
        dueDate: "2026-07-21",
        dueTime: "09:30",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const dateOnly = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ dueDate: "2026-07-22" });
    expect(dateOnly.status).toBe(200);
    expect(dateOnly.body.data.dueTime).toBe("09:30");

    const clearDate = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ dueDate: null });
    expect(clearDate.status).toBe(200);
    expect(clearDate.body.data.dueDate).toBeNull();
    expect(clearDate.body.data.dueTime).toBeNull();
  });

  it("PATCH /api/cases/:id rejects setting dueTime when no dueDate exists", async () => {
    const { access } = await makeSession(labOwnerId);
    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("DUE_TIME_NO_DATE"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "No",
        patientLastName: "Date",
        doctorName: "Dr. Empty",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ dueTime: "09:30" });
    expect(patch.status).toBe(400);
  });

  it("DELETE /api/cases/:caseId soft-deletes the case (row still exists with deletedAt set)", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("DC");

    const create = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Delete",
        patientLastName: "Me",
        doctorName: "Dr. Delete",
      });
    expect(create.status).toBe(201);
    const caseId = create.body.data.id;
    createdCaseIds.push(caseId);

    const del = await request(appMod.default)
      .delete(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(del.status).toBe(200);
    expect(del.body.data?.deleted ?? del.body.deleted).toBe(true);

    // After soft-delete, GET /:id should return 404 (row hidden from normal reads).
    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);
    expect(get.status).toBe(404);

    // The row must still exist in the DB with deletedAt set (soft-delete guarantee).
    const { db, cases: casesTable } = dbMod as any;
    const [row] = await db.select().from(casesTable).where(eq(casesTable.id, caseId));
    expect(row).toBeDefined();
    expect(row.deletedAt).not.toBeNull();

    // The deleted case must NOT appear in the list endpoint.
    const { access: access2 } = await makeSession(labOwnerId);
    const list = await request(appMod.default)
      .get(`/api/cases?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${access2}`);
    expect(list.status).toBe(200);
    const ids: string[] = (list.body.data ?? []).map((c: any) => c.id);
    expect(ids).not.toContain(caseId);
  });
});
