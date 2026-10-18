/**
 * Integration tests for the Step / Wax-Setup-Shade fields on PATCH /api/cases/:id.
 *
 * Coverage:
 *  - Canonical cases: setting step persists it and emits step_changed event
 *  - Canonical cases: setting step=wax_setup + stepShade persists both and emits events
 *  - Canonical cases: changing step away from wax_setup clears stepShade (server invariant)
 *  - Canonical cases: non-admin (role=staff) is rejected with 403
 *  - Mobile cases (lab_cases blob): step/stepShade round-trip via JSON blob
 *  - Mobile cases: changing step away from wax_setup clears stepShade in blob
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-step"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("PATCH /api/cases/:id — step and stepShade fields", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOwnerId = rid("u");
  const staffUserId = rid("u");
  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");

  const createdCaseIds: string[] = [];
  const seededMobileCaseIds: string[] = [];

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const t = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(t).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return t;
  }

  async function createCanonicalCase(access: string): Promise<string> {
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Step",
        patientLastName: "Test",
        doctorName: "Dr. Step",
        status: "received",
      });
    if (r.status !== 201) {
      throw new Error(`createCase failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
    const id: string = r.body.data.id;
    createdCaseIds.push(id);
    return id;
  }

  async function seedMobileCase(extra: Record<string, unknown> = {}): Promise<string> {
    const { db, labCases } = dbMod as any;
    const caseId = `steptest_${randomBytes(8).toString("hex")}`;
    const caseData = JSON.stringify({
      patientName: "Mobile Patient",
      doctorName: "Dr. Mobile",
      status: "INTAKE",
      isRush: false,
      dueDate: null,
      assignedBarcode: null,
      ...extra,
    });
    await db.insert(labCases).values({
      id: caseId,
      ownerId: labOwnerId,
      organizationId: labOrgId,
      caseData,
    });
    seededMobileCaseIds.push(caseId);
    return caseId;
  }

  let ownerToken = "";
  let staffToken = "";

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-step";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: labOwnerId, username: `stepowner_${labOwnerId}`, password: "x" },
      { id: staffUserId, username: `stepstaff_${staffUserId}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("StepTestLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("StepTestPractice"),
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
        labId: labOrgId,
        userId: staffUserId,
        role: "staff",
        status: "active",
        approvedByUserId: labOwnerId,
        joinedAt: new Date(),
      },
    ]);

    ownerToken = await makeSession(labOwnerId);
    staffToken = await makeSession(staffUserId);
  });

  beforeEach(async () => {
    ownerToken = await makeSession(labOwnerId);
    staffToken = await makeSession(staffUserId);
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
      labCases,
      userSessions,
      organizationMemberships,
      organizations,
      users,
    } = dbMod as any;

    if (createdCaseIds.length) {
      await db.delete(caseEvents).where(inArray(caseEvents.caseId, createdCaseIds));
      await db.delete(caseNotes).where(inArray(caseNotes.caseId, createdCaseIds));
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds));
      await db.delete(casesTable).where(inArray(casesTable.id, createdCaseIds));
    }
    if (seededMobileCaseIds.length) {
      await db.delete(labCases).where(inArray(labCases.id, seededMobileCaseIds));
    }
    await db.delete(auditLogs).where(
      inArray(auditLogs.organizationId, [labOrgId, providerOrgId])
    );
    await db.delete(invoices).where(eq(invoices.labOrganizationId, labOrgId));
    await db.delete(userSessions).where(
      inArray(userSessions.userId, [labOwnerId, staffUserId])
    );
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labOwnerId, staffUserId])
    );
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId, staffUserId]));
  });

  // ── Canonical cases ───────────────────────────────────────────────────────

  it("persists step and emits step_changed event", async () => {
    const caseId = await createCanonicalCase(ownerToken);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ step: "custom_tray" });

    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(get.status).toBe(200);
    expect(get.body?.data?.step).toBe("custom_tray");

    // step_changed event should be present in history
    const { db, caseEvents: caseEventsTable } = dbMod as any;
    const events = await db
      .select()
      .from(caseEventsTable)
      .where(eq(caseEventsTable.caseId, caseId));
    const stepEvent = events.find((e: any) => e.eventType === "step_changed");
    expect(stepEvent).toBeDefined();
    expect(stepEvent.metadataJson.fromStep).toBeNull();
    expect(stepEvent.metadataJson.toStep).toBe("custom_tray");
  });

  it("includes compact-work fields for canonical and legacy rows in the case list", async () => {
    const canonicalCaseId = await createCanonicalCase(ownerToken);
    const { db, caseRestorations } = dbMod as any;
    await db.insert(caseRestorations).values({
      id: rid("rest"),
      caseId: canonicalCaseId,
      toothNumber: "8",
      restorationType: "Crown",
      restorationSubtype: "restorative/crown/zirconia",
      material: "Zirconia",
      quantity: 1,
      unitPrice: "0.00",
    });
    await request(appMod.default)
      .patch(`/api/cases/${canonicalCaseId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ step: "process" })
      .expect(200);

    const legacyCaseId = await seedMobileCase({
      caseType: "Removable",
      material: "Acrylic",
      step: "wax_setup",
      restorations: [
        {
          toothNumber: "",
          restorationType: "Partial",
          restorationSubtype: "removable/partials/acrylic",
          material: "Acrylic",
        },
      ],
    });

    const list = await request(appMod.default)
      .get("/api/cases")
      .set("Authorization", `Bearer ${ownerToken}`)
      .query({ organizationId: labOrgId });

    expect(list.status).toBe(200);
    const canonical = list.body.data.find((row: any) => row.id === canonicalCaseId);
    expect(canonical).toMatchObject({
      firstRestorationSubtype: "restorative/crown/zirconia",
      step: "process",
      teeth: "8",
    });
    const legacy = list.body.data.find((row: any) => row.id === legacyCaseId);
    expect(legacy).toMatchObject({
      firstRestorationSubtype: "removable/partials/acrylic",
      step: "wax_setup",
      restorationMaterials: "Acrylic",
    });
  });

  it("persists step=wax_setup with shade and emits both events", async () => {
    const caseId = await createCanonicalCase(ownerToken);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ step: "wax_setup", stepShade: "A2" });

    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(get.status).toBe(200);
    expect(get.body?.data?.step).toBe("wax_setup");
    expect(get.body?.data?.stepShade).toBe("A2");

    const { db, caseEvents: caseEventsTable } = dbMod as any;
    const events = await db
      .select()
      .from(caseEventsTable)
      .where(eq(caseEventsTable.caseId, caseId));

    expect(events.find((e: any) => e.eventType === "step_changed")).toBeDefined();
    expect(events.find((e: any) => e.eventType === "step_shade_changed")).toBeDefined();
  });

  it("clears stepShade when step changes away from wax_setup", async () => {
    const caseId = await createCanonicalCase(ownerToken);

    // First set wax_setup + shade
    await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ step: "wax_setup", stepShade: "B1" });

    // Then change step away from wax_setup
    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ step: "process" });

    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(get.status).toBe(200);
    expect(get.body?.data?.step).toBe("process");
    // shade must be cleared server-side
    expect(get.body?.data?.stepShade ?? null).toBeNull();
  });

  it("clearing step also clears stepShade", async () => {
    const caseId = await createCanonicalCase(ownerToken);

    await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ step: "wax_setup", stepShade: "A3" });

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ step: null });

    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(get.status).toBe(200);
    expect(get.body?.data?.step ?? null).toBeNull();
    expect(get.body?.data?.stepShade ?? null).toBeNull();
  });

  it("returns 403 when a staff member tries to update step", async () => {
    const caseId = await createCanonicalCase(ownerToken);

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ step: "rims_and_plates" });

    expect(patch.status).toBe(403);
  });

  // ── Mobile cases (lab_cases blob) ─────────────────────────────────────────

  it("persists step in mobile case blob", async () => {
    const caseId = await seedMobileCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ step: "rims_and_plates" });

    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(get.status).toBe(200);
    expect(get.body?.data?.step).toBe("rims_and_plates");
  });

  it("persists step=wax_setup + shade in mobile case blob", async () => {
    const caseId = await seedMobileCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ step: "wax_setup", stepShade: "C2" });

    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(get.status).toBe(200);
    expect(get.body?.data?.step).toBe("wax_setup");
    expect(get.body?.data?.stepShade).toBe("C2");
  });

  it("returns 403 when a staff member tries to update step on a mobile case", async () => {
    const caseId = await seedMobileCase();

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ step: "wax_setup" });

    expect(patch.status).toBe(403);
  });

  it("returns 403 when a staff member tries to update stepShade on a mobile case", async () => {
    const caseId = await seedMobileCase({ step: "wax_setup" });

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ stepShade: "A2" });

    expect(patch.status).toBe(403);
  });

  it("clears shade in mobile case blob when step changes away from wax_setup", async () => {
    const caseId = await seedMobileCase({ step: "wax_setup", stepShade: "D3" });

    const patch = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ step: "process" });

    expect(patch.status).toBe(200);

    const get = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(get.status).toBe(200);
    expect(get.body?.data?.step).toBe("process");
    expect(get.body?.data?.stepShade ?? null).toBeNull();
  });
});
