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
 *   (iTero subtype) POST /api/cases/import-from-itero-rx with Zirconia Crown & Bridge
 *       hints writes restorationSubtype="restorative/crown_and_bridge/zirconia" to
 *       case_restorations in the DB (guards the hint→normalise→DB-write path end-to-end).
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
import AdmZip from "adm-zip";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  // Keep the owned synthetic workspace while using the real durable namespace.
  // The production writer correctly refuses arbitrary unregistered folders.
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-ai-intake", "case-media"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));
vi.mock("../lib/case-media-object-storage.js", () => ({
  openCaseMediaObjectStream: vi.fn().mockResolvedValue(null),
  writeCaseMediaToObjectStorage: vi.fn().mockResolvedValue(undefined),
}));

// Per-file timeouts must stay at or above the global hookTimeout (90 s) so
// the beforeAll (which imports app.js + seeds DB rows) doesn't time out
// when running with the global vitest config.
vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 });

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
      caseAttachments,
      caseEvents,
      caseNotes,
      caseRestorations,
      invoiceLineItems,
      invoices,
      iteroImportedOrders,
      iteroImportSessions,
      cases: casesTable,
      userSessions,
      organizationMemberships,
      organizations,
      users,
      notifications,
    } = dbMod as any;

    if (createdCaseIds.length) {
      if (notifications) {
        const notificationRows = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.userId, labOwnerId));
        if (notificationRows.length) {
          await db
            .delete(notifications)
            .where(eq(notifications.userId, labOwnerId));
        }
      }
      if (caseAttachments)
        await db.delete(caseAttachments).where(inArray(caseAttachments.caseId, createdCaseIds));
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

    // Clean up iTero-specific rows (keyed by lab org so we catch any that
    // slipped past the case-id list, e.g. when the route errored mid-way).
    if (iteroImportedOrders)
      await db
        .delete(iteroImportedOrders)
        .where(eq(iteroImportedOrders.labOrganizationId, labOrgId));
    if (iteroImportSessions)
      await db
        .delete(iteroImportSessions)
        .where(eq(iteroImportSessions.labOrganizationId, labOrgId));

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
        rxNotes: "Patient has allergy to nickel.",
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
    // Clinical Rx text and general internal notes are separate fields.
    expect(c.caseNotes ?? c.notes, "notes must survive").toContain("allergy");
    expect(c.notes.map((note: { noteText: string }) => note.noteText)).toContain("Patient has allergy to nickel.");
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
        rxNotes: "Old shade A2, patient grinds at night.",
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

  // ── (iTero subtype) restorationSubtype written to DB for Zirconia Crown & Bridge ──
  //
  // The three iTero import paths (Rx file, ZIP batch, poller) all call
  // normalizeCaseHierarchy() to derive restorationSubtype before inserting
  // case_restorations rows. This DB-level integration test confirms the value
  // actually reaches the database column — a schema-column rename or missed
  // insert field would silently drop it and be invisible to the unit-level
  // smoke test in analyze-prescription.test.ts.
  //
  // Strategy: suppress the OpenAI client by clearing AI_INTEGRATIONS_OPENAI_API_KEY
  // before the first request hits the route (the cached client is undefined at
  // this point since no prior test in this file calls the iTero import endpoint).
  // With no client, the AI block is skipped and the route falls through to the
  // client-provided hint fields. The hint→normalise→DB-write path is what we
  // want to exercise.

  it("(iTero subtype) restorationSubtype 'restorative/crown_and_bridge/zirconia' is written to case_restorations", async () => {
    // Temporarily suppress the AI key so getIteroOpenAIClient() returns null
    // and the route uses caseTypeHint/materialHint as the sole data source.
    // The cache is still undefined at this point — no prior test in this file
    // has hit /import-from-itero-rx — so this deletion takes effect on the
    // very first call.
    const origAiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

    try {
      const { access } = await makeSession(labOwnerId);
      const iteroOrderId = rid("iord");

      // A minimal non-empty buffer is enough; the file is only read when the
      // OpenAI client is present (which we've suppressed above).
      const fakeRxBuffer = Buffer.from("fake-rx-content-for-subtype-test");

      const resp = await request(appMod.default)
        .post("/api/cases/import-from-itero-rx")
        .set("Authorization", `Bearer ${access}`)
        .attach("file", fakeRxBuffer, {
          filename: "test-rx.pdf",
          contentType: "application/pdf",
        })
        .field("iteroOrderId", iteroOrderId)
        .field("labOrganizationId", labOrgId)
        .field("providerOrganizationId", providerOrgId)
        .field("doctorNameHint", "Dr. ZircTest")
        .field("patientFirstNameHint", "Zirc")
        .field("patientLastNameHint", "Patient")
        // These hints are the key inputs: they drive normalizeCaseHierarchy()
        // which must produce restorationSubtype = "restorative/crown_and_bridge/zirconia".
        .field("caseTypeHint", "Crown & Bridge")
        .field("materialHint", "Zirconia")
        // confirmNewDoctor bypasses the strict doctor-not-on-file gate so
        // we don't need to pre-create the doctor in the DB.
        .field("confirmNewDoctor", "true");

      expect(
        resp.status,
        `iTero Rx import must return 200 or 201 (got ${resp.status}): ${JSON.stringify(resp.body)}`,
      ).toSatisfy((s: number) => s === 200 || s === 201);

      const caseId = resp.body.data?.caseId;
      expect(caseId, "response must include caseId").toBeTruthy();
      createdCaseIds.push(caseId);

      // Query the DB directly — this is what the test exists to verify.
      const {
        db,
        caseRestorations: caseRestorationsTable,
        notifications,
      } = dbMod as any;
      const rows = await db
        .select()
        .from(caseRestorationsTable)
        .where(eq(caseRestorationsTable.caseId, caseId));

      expect(
        rows.length,
        "at least one case_restorations row must be written for a Crown & Bridge import",
      ).toBeGreaterThan(0);
      expect(
        rows[0].restorationSubtype,
        "restorationSubtype in the DB must be the encoded Zirconia crown taxonomy key",
      ).toBe("restorative/crown_and_bridge/zirconia");
    } finally {
      // Always restore the env var so subsequent tests (and the cached client
      // for any unrelated code) are not affected.
      if (origAiKey !== undefined) {
        process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = origAiKey;
      }
    }
  });

  it("persists reviewed iTero lines, received date, searchable patient, sales total, and live duplicate case number", async () => {
    const origAiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

    try {
      const { access } = await makeSession(labOwnerId);
      const iteroOrderId = rid("iord_reviewed");
      const reviewedLines = [
        {
          description: "Edited zirconia crown",
          quantity: 1,
          unitPrice: 100,
          catalogItemKey: "zirconia_crown",
        },
        {
          description: "Courtesy adjustment",
          quantity: 1,
          unitPrice: 0,
        },
      ];
      const providerContactSnapshot = {
        doctorName: "Dr. Reviewed",
        providerOrganizationId: providerOrgId,
        practiceName: "Reviewed Practice",
        primaryAddress: "50 Intake Avenue, Springfield, IL 62701",
        billingAddress: "PO Box 20, Springfield, IL 62702",
        phone: "555-0188",
        primaryEmail: "office@example.test",
        billingEmail: "billing@example.test",
      };
      const reviewedRestorations = [{
        toothNumber: "14",
        restorationType: "Crown",
        restorationSubtype: "restorative/crown_and_bridge/zirconia",
        material: "Zirconia",
        shade: "A2",
        quantity: 1,
      }];
      const submit = () =>
        request(appMod.default)
          .post("/api/cases/import-from-itero-rx")
          .set("Authorization", `Bearer ${access}`)
          .attach("file", Buffer.from("fake-reviewed-rx"), {
            filename: "reviewed-rx.pdf",
            contentType: "application/pdf",
          })
          .field("iteroOrderId", iteroOrderId)
          .field("labOrganizationId", labOrgId)
          .field("providerOrganizationId", providerOrgId)
          .field("doctorNameHint", "Dr. Reviewed")
          .field("patientFirstNameHint", "Michael")
          .field("patientLastNameHint", "Hatcher")
          .field("caseTypeHint", "Crown")
          .field("materialHint", "Zirconia")
          .field("shadeHint", "A2")
          .field("toothIndicesHint", "14")
          .field("receivedAt", "2026-08-19")
          .field("scanDateHint", "2026-08-18")
          .field("rxDueDateHint", "2026-08-29")
          .field("labDueDateHint", "2026-09-03")
          .field("externalPatientIdHint", "itero-reviewed-identity")
          .field("casePanBarcodeHint", "PAN-REVIEWED-1")
          .field("providerContactSnapshot", JSON.stringify(providerContactSnapshot))
          .field("invoiceNotesHint", "Please call when ready.")
          .field("reviewedRestorationsHint", JSON.stringify(reviewedRestorations))
          .field("invoiceOverrideLines", JSON.stringify(reviewedLines))
          .field("confirmNewDoctor", "true");

      const created = await submit();
      expect(created.status).toSatisfy((status: number) => status === 200 || status === 201);
      const caseId = created.body.data?.caseId;
      const caseNumber = created.body.data?.caseNumber;
      expect(caseId).toBeTruthy();
      expect(caseNumber).toBeTruthy();
      createdCaseIds.push(caseId);

      const { db, cases: casesTable, caseRestorations, invoices, invoiceLineItems } = dbMod as any;
      const [caseRow] = await db.select().from(casesTable).where(eq(casesTable.id, caseId));
      expect(caseRow.receivedAt).toBe("2026-08-19");
      expect(caseRow.scanDate).toBe("2026-08-18");
      expect(caseRow.prescriptionDueDate).toBe("2026-08-29");
      expect(caseRow.externalPatientId).toBe("itero-reviewed-identity");
      expect(caseRow.casePanBarcode).toBe("PAN-REVIEWED-1");
      expect(caseRow.providerContactSnapshot).toEqual(providerContactSnapshot);
      expect(new Date(caseRow.dueDate).toISOString()).toContain("2026-09-03");
      const restorationRows = await db.select().from(caseRestorations)
        .where(eq(caseRestorations.caseId, caseId));
      expect(restorationRows).toHaveLength(1);
      expect(restorationRows[0]).toMatchObject({
        toothNumber: "14",
        restorationType: "Crown",
        restorationSubtype: "restorative/crown_and_bridge/zirconia",
        material: "Zirconia",
        shade: "A2",
      });

      const [invoice] = await db.select().from(invoices).where(eq(invoices.caseId, caseId));
      expect(invoice.total).toBe("100.00");
      expect(invoice.notes).toContain("Please call when ready.");
      const lines = await db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoice.id));
      expect(lines.map((line: any) => ({
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      }))).toEqual([
        {
          description: "Edited zirconia crown",
          quantity: 1,
          unitPrice: "100.00",
          lineTotal: "100.00",
        },
        {
          description: "Courtesy adjustment",
          quantity: 1,
          unitPrice: "0.00",
          lineTotal: "0.00",
        },
      ]);
      expect(invoice.displayMetadataJson.lineItems).toEqual([
        expect.objectContaining({
          description: "Edited zirconia crown",
          catalogItemKey: "zirconia_crown",
        }),
        expect.objectContaining({
          description: "Courtesy adjustment",
          catalogItemKey: null,
        }),
      ]);

      const search = await request(appMod.default)
        .get("/api/cases/worklist")
        .set("Authorization", `Bearer ${access}`)
        .query({ organizationId: labOrgId, search: "Michael Hatcher" });
      expect(search.status).toBe(200);
      expect(search.body.data.rows.some((row: any) => row.id === caseId)).toBe(true);

      // The sales report buckets by the invoice's issued date (falling back to
      // createdAt), so the received day has to carry onto the invoice for the
      // window below to find it. Pin that derivation first: if it ever drifts,
      // this fails naming the actual date instead of leaving an unexplained
      // $0 total to diagnose.
      expect(new Date(invoice.issuedAt).toISOString()).toBe("2026-08-19T12:00:00.000Z");

      const sales = await request(appMod.default)
        .get("/api/invoices/reports/sales")
        .set("Authorization", `Bearer ${access}`)
        .query({
          organizationId: labOrgId,
          dateFrom: "2026-08-19T00:00:00.000Z",
          dateTo: "2026-08-20T00:00:00.000Z",
        });
      expect(sales.status).toBe(200);
      const salesContext = `invoice ${invoice.invoiceNumber} issued ${new Date(invoice.issuedAt).toISOString()}, status ${invoice.status}, total ${invoice.total}; report ${JSON.stringify(sales.body.data)}`;
      expect(Number(sales.body.data.totalSales), salesContext).toBeGreaterThanOrEqual(100);
      expect(sales.body.data.invoices, salesContext).toBeGreaterThanOrEqual(1);

      const duplicate = await submit();
      expect(duplicate.status).toBe(200);
      expect(duplicate.body.data).toMatchObject({
        deduped: true,
        caseId,
        caseNumber,
        iteroOrderId,
      });
    } finally {
      if (origAiKey !== undefined) {
        process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = origAiKey;
      }
    }
  });

  // ── (iTero ZIP-batch poller subtype) poller-batch path writes correct restorationSubtype ──
  //
  // The poller-batch importer (/import-from-itero-zip-batch) has its own
  // separate case_restorations insert inside processOneIteroZipFile. This test
  // confirms that caseTypeHint + materialHint flow through the hint→normalise→
  // DB-write path and that the taxonomy key actually lands in the DB column.
  //
  // Strategy: suppress the OpenAI client (same approach as the Rx and ZIP tests)
  // so AI extraction is skipped and only the hint fields drive the subtype.

  it("(iTero ZIP-batch poller subtype) restorationSubtype 'restorative/crown_and_bridge/zirconia' is written via the ZIP-batch poller path", async () => {
    const origAiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

    try {
      const { access } = await makeSession(labOwnerId);

      // Build a minimal in-memory ZIP matching the iTero Rx filename pattern.
      const fakeBatchOrderId = "77776666";
      const zip = new AdmZip();
      zip.addFile(
        `iTero_Rx_${fakeBatchOrderId}.pdf`,
        Buffer.from("fake-rx-content-for-batch-subtype-test"),
      );
      const zipBuffer = zip.toBuffer();

      const resp = await request(appMod.default)
        .post("/api/cases/import-from-itero-zip-batch")
        .set("Authorization", `Bearer ${access}`)
        .attach("files[]", zipBuffer, {
          filename: `OrthoCAD_Batch_${fakeBatchOrderId}.zip`,
          contentType: "application/zip",
        })
        .field("labOrganizationId", labOrgId)
        .field("providerOrganizationId", providerOrgId)
        .field("doctorNameHint", "Dr. ZircBatchTest")
        .field("patientFirstNameHint", "BatchZirc")
        .field("patientLastNameHint", "Patient")
        // These hints drive normalizeCaseHierarchy() → restorationSubtype
        .field("caseTypeHint", "Crown & Bridge")
        .field("materialHint", "Zirconia");

      expect(
        resp.status,
        `iTero ZIP-batch import must return 207 (got ${resp.status}): ${JSON.stringify(resp.body)}`,
      ).toBe(207);

      const results: any[] = resp.body.data?.results ?? [];
      expect(results.length, "response must contain one result").toBe(1);
      expect(
        results[0].status,
        `first result must be 'created', got '${results[0].status}' (error: ${results[0].error})`,
      ).toBe("created");

      const caseId = results[0].caseId;
      expect(caseId, "result must include caseId").toBeTruthy();
      createdCaseIds.push(caseId);

      // Query the DB directly — this is the core assertion this test exists to protect.
      const {
        db,
        caseRestorations: caseRestorationsTable,
        notifications,
      } = dbMod as any;
      const rows = await db
        .select()
        .from(caseRestorationsTable)
        .where(eq(caseRestorationsTable.caseId, caseId));

      expect(
        rows.length,
        "at least one case_restorations row must be written for a ZIP-batch Crown & Bridge import",
      ).toBeGreaterThan(0);
      expect(
        rows[0].restorationSubtype,
        "restorationSubtype in the DB must be the encoded Zirconia crown taxonomy key (poller-batch path)",
      ).toBe("restorative/crown_and_bridge/zirconia");
      const notificationRows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, labOwnerId));
      expect(
        notificationRows.filter((row: any) => row.dataJson?.caseId === caseId),
        "batch ZIP must create exactly one notification for the imported case",
      ).toHaveLength(1);
    } finally {
      if (origAiKey !== undefined) {
        process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = origAiKey;
      }
    }
  });

  // ── (iTero ZIP subtype) ZIP-batch path writes the correct restorationSubtype ──
  //
  // The ZIP-batch importer (/import-from-itero-zip) shares the same
  // normalizeCaseHierarchy() derivation as the single-file Rx path, but has
  // its own separate DB insert for case_restorations. This test confirms the
  // subtype value actually reaches the database column on that path — a
  // schema-column rename or missed insert field would be invisible until a
  // production ZIP import produced blank subtypes.
  //
  // Strategy: suppress the OpenAI client by clearing AI_INTEGRATIONS_OPENAI_API_KEY
  // (same approach as the iTero Rx subtype test above). With no AI client the
  // route skips extraction and falls through to the hint fields, exercising the
  // hint→normalise→DB-write path end-to-end.

  it("(iTero ZIP subtype) restorationSubtype 'restorative/crown_and_bridge/zirconia' is written via the ZIP-batch path", async () => {
    const origAiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

    try {
      const { access } = await makeSession(labOwnerId);

      // Build a minimal in-memory ZIP containing a file that matches the
      // iTero Rx pattern so the route's entry-finder accepts it.
      const fakeOrderId = "88887777";
      const zip = new AdmZip();
      zip.addFile(
        `iTero_Rx_${fakeOrderId}.pdf`,
        Buffer.from("fake-rx-content-for-zip-subtype-test"),
      );
      const zipBuffer = zip.toBuffer();

      const resp = await request(appMod.default)
        .post("/api/cases/import-from-itero-zip")
        .set("Authorization", `Bearer ${access}`)
        .attach("file", zipBuffer, {
          filename: `OrthoCAD_Export_${fakeOrderId}.zip`,
          contentType: "application/zip",
        })
        .field("labOrganizationId", labOrgId)
        .field("providerOrganizationId", providerOrgId)
        .field("doctorNameHint", "Dr. ZircZipTest")
        .field("patientFirstNameHint", "ZipZirc")
        .field("patientLastNameHint", "Patient")
        // These hints drive normalizeCaseHierarchy() → restorationSubtype
        .field("caseTypeHint", "Crown & Bridge")
        .field("materialHint", "Zirconia");

      expect(
        resp.status,
        `iTero ZIP import must return 200 or 201 (got ${resp.status}): ${JSON.stringify(resp.body)}`,
      ).toSatisfy((s: number) => s === 200 || s === 201);

      const caseId = resp.body.data?.caseId;
      expect(caseId, "response must include caseId").toBeTruthy();
      createdCaseIds.push(caseId);

      // Query the DB directly — this is the core assertion this test exists to protect.
      const {
        db,
        caseRestorations: caseRestorationsTable,
        notifications,
      } = dbMod as any;
      const rows = await db
        .select()
        .from(caseRestorationsTable)
        .where(eq(caseRestorationsTable.caseId, caseId));

      expect(
        rows.length,
        "at least one case_restorations row must be written for a ZIP Crown & Bridge import",
      ).toBeGreaterThan(0);
      expect(
        rows[0].restorationSubtype,
        "restorationSubtype in the DB must be the encoded Zirconia crown taxonomy key (ZIP path)",
      ).toBe("restorative/crown_and_bridge/zirconia");
      const notificationRows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, labOwnerId));
      expect(
        notificationRows.filter((row: any) => row.dataJson?.caseId === caseId),
        "individual ZIP must create exactly one notification for the imported case",
      ).toHaveLength(1);
    } finally {
      if (origAiKey !== undefined) {
        process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = origAiKey;
      }
    }
  });
});
