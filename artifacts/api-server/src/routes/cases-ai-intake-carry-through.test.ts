/**
 * Regression suite: AI intake data carry-through.
 *
 * Protected behaviors:
 *   (1) POST /api/cases with restorations (teeth present) — dueDate, toothNumber,
 *       shade, material, restorationType all survive and are returned on GET /api/cases/:id.
 *   (2) POST /api/cases with a stub restoration (toothNumber:"", the no-teeth AI path)
 *       — shade, material, restorationType are NOT dropped; the empty toothNumber is
 *       accepted by the schema and the row persists.
 *   (3) Restorations from the no-teeth stub path survive GET /api/cases/:id
 *       (restorations[] is non-empty, has the right material/shade/type).
 *   (4) GET /api/cases/:id also includes casePanBarcode and caseNotes.
 *   (5) Auto-generated invoice exists (no duplicate) for both creation paths.
 *   (6) Mobile canonical GET /api/mobile/2/cases/:id returns the restoration rows
 *       so the mobile Lab Slip can display material/shade/type.
 *
 * Skipped when DATABASE_URL is not configured. All inserted rows are cleaned up
 * in afterAll so the suite is safe against a shared dev DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-ai-intake"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("AI intake data carry-through (db integration)", () => {
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
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-ai-intake";
    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    authLib = await import("../lib/auth.js");

    const { db, users, organizations, organizationMemberships } = dbMod as any;

    await db.insert(users).values({
      id: labOwnerId,
      username: `aiintakeowner_${labOwnerId}`,
      password: "doesnotmatter",
    });

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: rid("AiIntakeLab") },
      {
        id: providerOrgId,
        type: "provider",
        name: rid("AiIntakePractice"),
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
      if (caseEvents) await db.delete(caseEvents).where(inArray(caseEvents.caseId, createdCaseIds));
      if (caseNotes) await db.delete(caseNotes).where(inArray(caseNotes.caseId, createdCaseIds));
      if (caseRestorations)
        await db.delete(caseRestorations).where(inArray(caseRestorations.caseId, createdCaseIds));
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

  // ── (1) With-teeth path: restoration fields survive create→read ───────────

  it("(1) With-teeth path: dueDate, tooth#, shade, material, restorationType survive POST→GET", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("AIW");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Tooth",
        patientLastName: "Present",
        doctorName: "Dr. Teeth",
        status: "received",
        dueDate: "2026-07-01",
        casePanBarcode: "BAR-001",
        notes: "Rush Rx notes here",
        shade: "A2",
        restorations: [
          {
            toothNumber: "14",
            restorationType: "Crown",
            material: "Zirconia",
            shade: "A2",
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

    expect(getResp.status).toBe(200);
    const c = getResp.body.data ?? getResp.body;
    expect(c.dueDate, "dueDate must survive").toMatch(/2026-07-01/);
    expect(c.casePanBarcode, "barcode must survive").toBe("BAR-001");

    const rests: any[] = c.restorations ?? [];
    expect(rests.length, "restoration row must be created").toBeGreaterThan(0);
    const rest = rests[0];
    expect(rest.toothNumber).toBe("14");
    expect(rest.restorationType).toBe("Crown");
    expect(rest.material).toBe("Zirconia");
    expect(rest.shade).toBe("A2");
  });

  // ── (2) No-teeth path: stub restoration accepted (empty toothNumber) ────────

  it("(2) No-teeth path: stub restoration (toothNumber:'') is accepted — returns 201", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("AINO");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "No",
        patientLastName: "Teeth",
        doctorName: "Dr. NoTeeth",
        status: "received",
        dueDate: "2026-08-15",
        shade: "B3",
        restorations: [
          {
            toothNumber: "",
            restorationType: "Bridge",
            material: "PFM",
            shade: "B3",
            quantity: 1,
            unitPrice: 0,
          },
        ],
      });

    expect(createResp.status).toBe(201);
    const caseId = createResp.body.data.id;
    createdCaseIds.push(caseId);
  });

  // ── (3) No-teeth stub restoration survives GET /api/cases/:id ──────────────

  it("(3) No-teeth stub restoration: material, shade, restorationType on GET /api/cases/:id", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("AINO2");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Stub",
        patientLastName: "Resto",
        doctorName: "Dr. Stub",
        status: "received",
        dueDate: "2026-09-01",
        shade: "C1",
        restorations: [
          {
            toothNumber: "",
            restorationType: "Veneer",
            material: "Emax",
            shade: "C1",
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

    expect(getResp.status).toBe(200);
    const c = getResp.body.data ?? getResp.body;
    expect(c.dueDate, "dueDate must survive").toMatch(/2026-09-01/);

    const rests: any[] = c.restorations ?? [];
    expect(rests.length, "stub restoration row must be stored").toBeGreaterThan(0);
    const rest = rests[0];
    expect(rest.restorationType, "restorationType must survive").toBe("Veneer");
    expect(rest.material, "material must survive").toBe("Emax");
    expect(rest.shade, "shade must survive").toBe("C1");
  });

  // ── (4) casePanBarcode and caseNotes survive ────────────────────────────────

  it("(4) casePanBarcode and notes survive create→read", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("AIBN");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Barcode",
        patientLastName: "Notes",
        doctorName: "Dr. Barcode",
        status: "received",
        casePanBarcode: "SCAN-XYZ-789",
        notes: "Patient has allergy to nickel.",
      });

    expect(createResp.status).toBe(201);
    const caseId = createResp.body.data.id;
    createdCaseIds.push(caseId);

    const getResp = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);

    expect(getResp.status).toBe(200);
    const c = getResp.body.data ?? getResp.body;
    expect(c.casePanBarcode).toBe("SCAN-XYZ-789");
    // caseNotes is the server field name for the Rx notes sent as "notes"
    expect(c.caseNotes ?? c.notes, "notes must survive").toContain("allergy");
  });

  // ── (5) Auto-generated invoice exists and is not duplicated ────────────────

  it("(5) No-teeth path: exactly one auto-generated invoice (not duplicated)", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("AIINV");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Invoice",
        patientLastName: "NoTeeth",
        doctorName: "Dr. Invoice",
        status: "received",
        shade: "D4",
        restorations: [
          {
            toothNumber: "",
            restorationType: "Inlay",
            material: "Gold",
            shade: "D4",
            quantity: 1,
            unitPrice: 0,
          },
        ],
      });

    expect(createResp.status).toBe(201);
    const caseId = createResp.body.data.id;
    createdCaseIds.push(caseId);

    const { db, invoices } = dbMod as any;

    let invoiceRows: any[] = [];
    for (let i = 0; i < 25; i++) {
      await new Promise((res) => setTimeout(res, 100));
      invoiceRows = await db
        .select()
        .from(invoices)
        .where(eq(invoices.caseId, caseId));
      if (invoiceRows.length > 0) break;
    }

    expect(invoiceRows.length, "exactly one invoice must exist").toBe(1);
    expect(invoiceRows[0].status).toBe("open");
    expect(invoiceRows[0].labOrganizationId).toBe(labOrgId);
  });

  // ── (7) Full AI intake combination — the exact regression scenario ───────────
  // Mirrors the DashboardDropZone POST payload after AI analysis of a
  // prescription that returned shade + notes but NO tooth indices.
  //
  // Protected behaviors:
  //   - INSERT must not fail with a column/value count mismatch (5xx).
  //   - Top-level shade survives to the cases row (returned as cases.shade).
  //   - rxNotes (sent as "notes") survives and is returned as caseNotes.
  //   - casePanBarcode is null when absent from the request.
  //   - bridgeConnectors, deliveryDateProposalDate, deliveryDateProposalNote
  //     being absent from the request must not cause any error.
  //   - Stub restoration (toothNumber:"") is persisted with correct fields.

  it("(7) Full intake combo: shade + rxNotes + stub restoration, no barcode/bridge/delivery-proposal — no INSERT mismatch", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("AIFULL");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Full",
        patientLastName: "Combo",
        doctorName: "Dr. FullCombo",
        status: "received",
        dueDate: "2026-11-01",
        shade: "A2",
        notes: "Old shade A2, patient grinds at night.",
        restorations: [
          {
            toothNumber: "",
            restorationType: "Crown & Bridge",
            material: "Zirconia",
            shade: "A2",
            quantity: 1,
            unitPrice: 0,
          },
        ],
        // Explicitly absent: casePanBarcode, bridgeConnectors,
        // deliveryDateProposalDate, deliveryDateProposalNote.
        // Their absence must not produce a SQL column/value mismatch.
      });

    expect(createResp.status, "case creation must not fail with SQL mismatch").toBe(201);
    const caseId = createResp.body.data.id;
    createdCaseIds.push(caseId);

    const getResp = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);

    expect(getResp.status).toBe(200);
    const c = getResp.body.data ?? getResp.body;

    expect(c.shade, "top-level shade must survive to the cases row").toBe("A2");
    expect(c.caseNotes, "rxNotes must be returned as caseNotes").toContain("grinds at night");
    expect(c.casePanBarcode ?? null, "casePanBarcode must be null when absent").toBeNull();

    const rests: any[] = c.restorations ?? [];
    expect(rests.length, "stub restoration must be stored").toBeGreaterThan(0);
    expect(rests[0].shade, "restoration shade must survive").toBe("A2");
    expect(rests[0].material, "restoration material must survive").toBe("Zirconia");
    expect(rests[0].toothNumber, "empty toothNumber must survive").toBe("");
  });

  // ── (6) Canonical GET /api/cases/:id returns restoration rows ─────────────
  // Both desktop and mobile use this endpoint (the mobile app reads the same
  // canonical API). Restorations[] must be present so caseToRxSummary can
  // derive shade/material/type for the mobile Lab Slip.

  it("(6) GET /api/cases/:id returns restorations for mobile Lab Slip display", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("AIMOB");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Mobile",
        patientLastName: "RestCheck",
        doctorName: "Dr. Mobile",
        status: "received",
        dueDate: "2026-10-01",
        shade: "A3",
        restorations: [
          {
            toothNumber: "8",
            restorationType: "Crown",
            material: "Zirconia",
            shade: "A3",
            quantity: 1,
            unitPrice: 0,
          },
        ],
      });

    expect(createResp.status).toBe(201);
    const caseId = createResp.body.data.id;
    createdCaseIds.push(caseId);

    const detailResp = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);

    expect(detailResp.status).toBe(200);
    const mc = detailResp.body.data ?? detailResp.body;

    // restorations[] must be present so caseToRxSummary can derive
    // shade/material/type for the mobile Lab Slip.
    const rests: any[] = mc.restorations ?? [];
    expect(rests.length, "canonical endpoint must expose restorations").toBeGreaterThan(0);
    expect(rests[0].toothNumber).toBe("8");
    expect(rests[0].shade).toBe("A3");
    expect(rests[0].material).toBe("Zirconia");
  });

  // ── (8) PATCH /:id rxNotes survives ────────────────────────────────────────
  // Regression for editMutation dropping rxNotes from the PATCH body.
  // A PATCH that includes rxNotes must update the cases.rx_notes column and
  // have it returned as caseNotes on the next GET.

  it("(8) PATCH /:id rxNotes saves and is returned as caseNotes on GET", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("AIRXN");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "RxNotes",
        patientLastName: "PatchTest",
        doctorName: "Dr. RxNotes",
        status: "received",
      });

    expect(createResp.status).toBe(201);
    const caseId = createResp.body.data.id;
    createdCaseIds.push(caseId);

    const patchResp = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ rxNotes: "Patient allergic to nickel — must use BioHPP only." });

    expect(patchResp.status, "PATCH with rxNotes must succeed").toBe(200);

    const getResp = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);

    expect(getResp.status).toBe(200);
    const c = getResp.body.data ?? getResp.body;
    expect(c.caseNotes, "rxNotes must be returned as caseNotes after PATCH").toContain(
      "BioHPP only"
    );
  });

  // ── (9) casePanBarcode "0001" (leading zeros) survives without coercion ────
  // Barcodes like "0001" must be stored and returned as the string "0001",
  // never coerced to the number 1 or the string "1".

  it("(9) casePanBarcode '0001' (leading zeros) is stored and returned as string '0001'", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("AIBC0");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Barcode",
        patientLastName: "Leading",
        doctorName: "Dr. Zeroes",
        status: "received",
        casePanBarcode: "0001",
      });

    expect(createResp.status).toBe(201);
    const caseId = createResp.body.data.id;
    createdCaseIds.push(caseId);

    const getResp = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);

    expect(getResp.status).toBe(200);
    const c = getResp.body.data ?? getResp.body;
    expect(c.casePanBarcode, "barcode with leading zeros must not be coerced").toBe("0001");
  });

  // ── (10) PATCH /:id casePanBarcode updates the barcode ────────────────────
  // After case creation without a barcode, a PATCH with casePanBarcode must
  // update the cases.case_pan_barcode column so the Lab Slip shows the new value.

  it("(10) PATCH /:id casePanBarcode saves and is returned on GET", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("AIBC1");

    const createResp = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Barcode",
        patientLastName: "Patch",
        doctorName: "Dr. PatchBarcode",
        status: "received",
      });

    expect(createResp.status).toBe(201);
    const caseId = createResp.body.data.id;
    createdCaseIds.push(caseId);

    const patchResp = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ casePanBarcode: "PATCHED-BC-01" });

    expect(patchResp.status, "PATCH with casePanBarcode must succeed").toBe(200);

    const getResp = await request(appMod.default)
      .get(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`);

    expect(getResp.status).toBe(200);
    const c = getResp.body.data ?? getResp.body;
    expect(c.casePanBarcode, "patched barcode must be returned on GET").toBe("PATCHED-BC-01");
  });
});
