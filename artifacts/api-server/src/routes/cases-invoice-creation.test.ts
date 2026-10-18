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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import request from "supertest";
import { repairRecentCaseInvoices } from "../lib/ai-intake-invoice-repair";
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
  const createdLabCaseIds: string[] = [];

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
      invoiceLineItems,
      invoices,
      caseRestorations,
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
      await db.delete(caseRestorations).where(inArray(caseRestorations.caseId, createdCaseIds));
      await db.delete(casesTable).where(inArray(casesTable.id, createdCaseIds));
    }

    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db.delete(invoices).where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db.delete(casesTable).where(inArray(casesTable.labOrganizationId, [labOrgId]));
    // Clean up lab_cases rows created by mobile-idempotency tests
    if (createdLabCaseIds.length) {
      const { labCases: labCasesTable } = dbMod as any;
      if (labCasesTable) {
        await db.delete(labCasesTable).where(inArray(labCasesTable.id, createdLabCaseIds));
      }
    }
    await db.delete(userSessions).where(inArray(userSessions.userId, [labOwnerId]));
    await db.delete(organizationMemberships).where(
      inArray(organizationMemberships.userId, [labOwnerId]),
    );
    await db.delete(organizations).where(eq(organizations.id, providerOrgId));
    await db.delete(organizations).where(eq(organizations.id, labOrgId));
    await db.delete(users).where(inArray(users.id, [labOwnerId]));
  });

  // ── (1) Auto-invoice caseId matches the newly created case ───────────────

  for (const [choice, expectedArches] of [
    ["upper", ["upper"]],
    ["lower", ["lower"]],
    ["both", ["upper", "lower"]],
  ] as const) {
    it(`saves ${choice} removable appliances as individually labeled draft invoice charges`, async () => {
      const { access } = await makeSession(labOwnerId);
      const restorations = expectedArches.map((arch) => ({
        toothNumber: "",
        restorationType: "Full Denture",
        arch,
        quantity: 1,
        unitPrice: 125,
        priceOverridden: true,
      }));
      const response = await request(appMod.default).post("/api/cases")
        .set("Authorization", `Bearer ${access}`).send({
          caseNumber: rid("ARCH"), labOrganizationId: labOrgId,
          providerOrganizationId: providerOrgId,
          patientFirstName: "Arch", patientLastName: "Patient",
          doctorName: "Dr. Arch", confirmNewDoctor: true, restorations,
        });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const caseId = response.body.data.id;
      createdCaseIds.push(caseId);
      const { db, caseRestorations, invoices, invoiceLineItems } = dbMod as any;
      const saved = await db.select().from(caseRestorations).where(eq(caseRestorations.caseId, caseId));
      expect(saved.map((row: any) => row.arch).sort()).toEqual([...expectedArches].sort());
      expect(saved.map((row: any) => row.quantity)).toEqual(expectedArches.map(() => 1));

      const [invoice] = await db.select().from(invoices).where(eq(invoices.caseId, caseId));
      expect(invoice).toBeDefined();
      const lines = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id));
      expect(lines).toHaveLength(expectedArches.length);
      expect(lines.map((line: any) => line.description).sort()).toEqual(
        [...expectedArches].sort().map((arch) =>
          expect.stringContaining(arch === "upper" ? "Upper" : "Lower")),
      );
      expect(lines.map((line: any) => Number(line.quantity))).toEqual(expectedArches.map(() => 1));
      expect(lines.map((line: any) => Number(line.lineTotal))).toEqual(expectedArches.map(() => 125));
    });
  }

  it("still rejects a removable case without an arch", async () => {
    const { access } = await makeSession(labOwnerId);
    const response = await request(appMod.default).post("/api/cases")
      .set("Authorization", `Bearer ${access}`).send({
        caseNumber: rid("MISSINGARCH"), labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Arch", patientLastName: "Missing",
        doctorName: "Dr. Arch",
        restorations: [{ toothNumber: "", restorationType: "Full Denture", quantity: 1 }],
      });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("Arch is required");
  });

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
        doctorName: "Dr. Synthetic050",
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
    const listed = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${access}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: invoice.id, caseId, invoiceNumber: `INV-${caseNumber}` }),
    ]));
  });

  it("refuses a pre-used invoice number and does not leave a case without an invoice", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: caseTable, invoices: invoiceTable } = dbMod as any;
    const caseNumber = rid("TAKEN");
    const [owner] = await db.insert(invoiceTable).values({
      invoiceNumber: `INV-${caseNumber}`, labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId, caseId: null, status: "open",
      createdByUserId: labOwnerId,
      displayMetadataJson: { patientName: "Unrelated Patient" },
    }).returning();
    try {
      const response = await request(appMod.default).post("/api/cases")
        .set("Authorization", `Bearer ${access}`).send({
          caseNumber, labOrganizationId: labOrgId, providerOrganizationId: providerOrgId,
          patientFirstName: "New", patientLastName: "Patient",
          doctorName: "Dr. Synthetic050", status: "received",
        });
      expect(response.status).toBe(409);
      const caseRows = await db.select().from(caseTable)
        .where(eq(caseTable.caseNumber, caseNumber));
      expect(caseRows).toHaveLength(0);
      const [unchanged] = await db.select().from(invoiceTable)
        .where(eq(invoiceTable.id, owner.id));
      expect(unchanged.caseId).toBeNull();
      expect(unchanged.displayMetadataJson.patientName).toBe("Unrelated Patient");
    } finally {
      await db.delete(invoiceTable).where(eq(invoiceTable.id, owner.id));
    }
  });

  it("shows a repaired manual case invoice in the same API list used by both clients", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: caseTable, invoices: invoiceTable } = dbMod as any;
    const caseId = rid("missing_invoice");
    const caseNumber = rid("REPAIR-LIST");
    createdCaseIds.push(caseId);
    await db.insert(caseTable).values({
      id: caseId, caseNumber, labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
       patientFirstName: "Synthetic070", patientLastName: "Patient070",
      doctorName: "Dr. Synthetic050", status: "received", priority: "normal",
      receivedAt: new Date().toISOString().slice(0, 10),
      createdByUserId: labOwnerId,
    });
    const summary = await repairRecentCaseInvoices();
    expect(summary.repaired).toBeGreaterThanOrEqual(1);
    const [invoice] = await db.select().from(invoiceTable)
      .where(eq(invoiceTable.caseId, caseId));
    expect(invoice.displayMetadataJson.patientName).toBe("Synthetic070 Patient070");
    const listed = await request(appMod.default).get("/api/invoices")
      .set("Authorization", `Bearer ${access}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: invoice.id, caseId, invoiceNumber: `INV-${caseNumber}` }),
    ]));
  });

  it("creates invoice lines exactly from an owner's pre-create overrides", async () => {
    const { access } = await makeSession(labOwnerId);
    const caseNumber = rid("OVERRIDE");
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Exact",
        patientLastName: "Preview",
        doctorName: "Dr. Tier",
        status: "received",
        invoiceOverrideLines: [
          {
            description: "PFM Crown",
            quantity: 2,
            unitPrice: 75.5,
            catalogItemKey: "pfm_crown",
          },
          {
            description: "Custom characterization",
            quantity: 1,
            unitPrice: 25,
          },
        ],
      });
    expect(r.status).toBe(201);
    const caseId = r.body.data.id;
    createdCaseIds.push(caseId);

    const { db, invoices, invoiceLineItems } = dbMod as any;
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(invoice).toBeDefined();
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
        description: "PFM Crown",
        quantity: 2,
        unitPrice: "75.50",
        lineTotal: "151.00",
      },
      {
        description: "Custom characterization",
        quantity: 1,
        unitPrice: "25.00",
        lineTotal: "25.00",
      },
    ]);
    expect(invoice.subtotal).toBe("176.00");
    expect(invoice.total).toBe("176.00");
    expect(invoice.displayMetadataJson.lineItems).toEqual([
      expect.objectContaining({
        item: "PFM Crown",
        catalogItemKey: "pfm_crown",
      }),
      expect.objectContaining({
        item: "Custom characterization",
        catalogItemKey: null,
      }),
    ]);
  });

  it("honors an owner's intentionally empty invoice preview", async () => {
    const { access } = await makeSession(labOwnerId);
    const r = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("EMPTY"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Empty",
        patientLastName: "Preview",
        doctorName: "Dr. Empty",
        status: "received",
        restorations: [
          {
            toothNumber: "14",
            restorationType: "Crown",
            material: "Zirconia",
            quantity: 1,
          },
        ],
        invoiceOverrideLines: [],
      });
    expect(r.status).toBe(201);
    const caseId = r.body.data.id;
    createdCaseIds.push(caseId);

    const { db, invoices, invoiceLineItems } = dbMod as any;
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    const lines = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    expect(lines).toEqual([]);
    expect(invoice.total).toBe("0.00");
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
        doctorName: "Dr. Quartz Lantern",
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
        doctorName: "Dr. Synthetic066",
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

  it("keeps linked invoice Issued dates synchronized with the case received date", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable, caseEvents, invoices } = dbMod as any;
    const originalReceivedAt = "2026-01-10";
    const updatedReceivedAt = "2026-02-15";

    const createResponse = await request(appMod.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${access}`)
      .send({
        caseNumber: rid("DATE-SYNC"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Date",
        patientLastName: "Sync",
        doctorName: "Dr. Calendar",
        status: "received",
        receivedAt: originalReceivedAt,
      });

    expect(createResponse.status).toBe(201);
    const caseId = createResponse.body.data.id;
    createdCaseIds.push(caseId);

    const [createdCase] = await db
      .select()
      .from(casesTable)
      .where(eq(casesTable.id, caseId));
    const [createdInvoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));

    expect(createdInvoice).toBeDefined();
    expect(createdCase.receivedAt).toBe("2026-01-10");
    expect(createdInvoice.issuedAt.toISOString()).toBe(
      "2026-01-10T12:00:00.000Z",
    );

    const preservedDueAt = new Date("2026-03-10T12:00:00.000Z");
    const manualIssuedAt = new Date("2026-01-25T12:00:00.000Z");
    await db
      .update(invoices)
      .set({ issuedAt: manualIssuedAt, dueAt: preservedDueAt })
      .where(eq(invoices.id, createdInvoice.id));

    const updateResponse = await request(appMod.default)
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ receivedAt: updatedReceivedAt });

    expect(updateResponse.status).toBe(200);

    const [updatedCase] = await db
      .select()
      .from(casesTable)
      .where(eq(casesTable.id, caseId));
    const [updatedInvoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, createdInvoice.id));
    const events = await db
      .select()
      .from(caseEvents)
      .where(eq(caseEvents.caseId, caseId));
    const syncEvent = events.find(
      (event: any) =>
        event.eventType === "invoice_updated" &&
        event.metadataJson?.reason === "case_received_date_changed",
    );

    expect(updatedCase.receivedAt).toBe("2026-02-15");
    expect(updatedInvoice.issuedAt.toISOString()).toBe(
      "2026-02-15T12:00:00.000Z",
    );
    expect(updatedInvoice.dueAt.toISOString()).toBe(
      preservedDueAt.toISOString(),
    );
    expect(syncEvent?.metadataJson).toEqual(
      expect.objectContaining({
        invoiceId: createdInvoice.id,
        previousIssuedAt: manualIssuedAt.toISOString(),
        issuedAt: "2026-02-15T12:00:00.000Z",
      }),
    );
  });

  // ── (5) 409 when invoice number is already used by a different case ─────────

  it("(5) POST generate-invoice returns 409 when invoice number is already taken by another case", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, cases: casesTable, invoices } = dbMod as any;

    // Case A — will own the pre-existing invoice
    const caseAId = rid("caseA");
    const caseANumber = rid("COLCN");
    await db.insert(casesTable).values({
      id: caseAId,
      caseNumber: caseANumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Alice",
      patientLastName: "Collision",
      doctorName: "Dr. Synthetic002",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(caseAId);

    // Case B — will try to generate an invoice with the same number as A
    const caseBId = rid("caseB");
    const caseBNumber = rid("COLCN");
    await db.insert(casesTable).values({
      id: caseBId,
      caseNumber: caseBNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Bob",
      patientLastName: "Collision",
      doctorName: "Dr. Synthetic012",
      createdByUserId: labOwnerId,
    });
    createdCaseIds.push(caseBId);

    // Pre-insert an invoice using case B's invoice number but linked to case A
    const collisionInvoiceNumber = `INV-${caseBNumber}`;
    const [collisionInvoice] = await db
      .insert(invoices)
      .values({
        invoiceNumber: collisionInvoiceNumber,
        caseId: caseAId,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        status: "open",
        displayMetadataJson: { patientName: "", billTo: "", teeth: "", shade: "", caseNotes: "" },
        createdByUserId: labOwnerId,
        updatedByUserId: labOwnerId,
      })
      .returning();

    // Now try to generate an invoice for case B — it should 409
    const r = await request(appMod.default)
      .post(`/api/invoices/cases/${caseBId}/generate-invoice`)
      .set("Authorization", `Bearer ${access}`)
      .send({});

    expect(r.status).toBe(409);
    expect(r.body.error ?? r.body.message ?? "").toMatch(/collision/i);
    expect(r.body.error ?? r.body.message ?? "").toContain(collisionInvoice.id);
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
        doctorName: "Dr. Marble Meadow",
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

  // ── (6) Mobile-created case: generate-invoice is idempotent ──────────────
  //
  // Calling generate-invoice multiple times for the same mobile lab_cases row
  // must produce exactly ONE invoice in the DB, not one per call.

  it("(6) generate-invoice for mobile lab_cases row is idempotent — repeated calls return the same invoice", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, invoices: invoicesTable, labCases: labCasesTable } = dbMod as any;

    const labCaseId = rid("lc");
    const caseNumber = rid("MCN");
    createdLabCaseIds.push(labCaseId);

    await db.insert(labCasesTable).values({
      id: labCaseId,
      ownerId: labOwnerId,
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber,
        patientName: "Mary West",
        invoiceId: rid("local-inv"),
        price: 350,
      }),
    });

    // Call generate-invoice twice — must be idempotent
    const r1 = await request(appMod.default)
      .post(`/api/invoices/cases/${labCaseId}/generate-invoice`)
      .set("Authorization", `Bearer ${access}`)
      .send({});
    expect(r1.status).toBe(201);

    const r2 = await request(appMod.default)
      .post(`/api/invoices/cases/${labCaseId}/generate-invoice`)
      .set("Authorization", `Bearer ${access}`)
      .send({});
    expect(r2.status).toBe(200);

    // Exactly one invoice row with this invoice number
    const allInvoices = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.invoiceNumber, `INV-${caseNumber}`));
    expect(allInvoices).toHaveLength(1);
    // Both responses must reference the same invoice id
    expect(r1.body.data.id).toBe(r2.body.data.id);
  });

  // ── (7) Mobile blob + real DB invoice → GET list shows exactly one ────────
  //
  // When a mobile lab_cases row has invoiceId in its blob AND a real DB
  // invoice with the same INV-<caseNumber> exists (caseId=null, legacy path),
  // GET /api/invoices must NOT synthesize a duplicate M- row.

  it("(7) GET /api/invoices suppresses synthesized M- invoice when INV- already exists in DB", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, invoices: invoicesTable, labCases: labCasesTable } = dbMod as any;

    const labCaseId = rid("lc");
    const caseNumber = rid("MCN");
    createdLabCaseIds.push(labCaseId);

    // Insert a mobile lab_cases row with invoiceId in the blob
    await db.insert(labCasesTable).values({
      id: labCaseId,
      ownerId: labOwnerId,
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber,
        patientName: "Holly Simms",
        invoiceId: rid("local-inv"),
        price: 350,
      }),
    });

    // Insert a real DB invoice for the same case number (legacy path sets caseId=null)
    await db.insert(invoicesTable).values({
      invoiceNumber: `INV-${caseNumber}`,
      caseId: null,
      labOrganizationId: labOrgId,
      providerOrganizationId: null,
      status: "open",
      displayMetadataJson: { patientName: "Holly Simms", billTo: "", teeth: "", shade: "", caseNotes: "" },
      createdByUserId: labOwnerId,
      updatedByUserId: labOwnerId,
    });

    const r = await request(appMod.default)
      .get("/api/invoices")
      .set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);

    const list: any[] = r.body.data ?? r.body;
    const forThisCase = list.filter(
      (inv: any) => inv.invoiceNumber === `INV-${caseNumber}`
    );

    expect(
      forThisCase,
      "expected exactly one invoice (INV-) for the mobile case, no duplicate or M- row"
    ).toHaveLength(1);
    expect(forThisCase[0].invoiceNumber).toBe(`INV-${caseNumber}`);
  });

  // ── (8) Legacy invoice linked to canonical case after promotion ───────────
  //
  // When generate-invoice was called before case promotion (creating an
  // INV- with caseId=null), then the lab_cases row is promoted to canonical,
  // calling generate-invoice again must link the existing invoice to the
  // canonical case (caseId updated) instead of returning 409.

  it("(8) generate-invoice links legacy caseId=null invoice to canonical case after promotion", async () => {
    const { access } = await makeSession(labOwnerId);
    const { db, invoices: invoicesTable, labCases: labCasesTable, cases: casesTable } = dbMod as any;

    const labCaseId = rid("lc");
    const caseNumber = rid("MCN");
    createdLabCaseIds.push(labCaseId);
    createdCaseIds.push(labCaseId); // same id used for promoted canonical row

    // Step 1: insert mobile lab_cases row
    await db.insert(labCasesTable).values({
      id: labCaseId,
      ownerId: labOwnerId,
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber,
        patientName: "Jane Promo",
        invoiceId: rid("local-inv"),
        price: 200,
      }),
    });

    // Step 2: generate-invoice for the lab_cases row → creates INV- with caseId=null
    const r1 = await request(appMod.default)
      .post(`/api/invoices/cases/${labCaseId}/generate-invoice`)
      .set("Authorization", `Bearer ${access}`)
      .send({});
    expect(r1.status).toBe(201);
    expect(r1.body.data.caseId).toBeNull();

    // Step 3: promote case to canonical (same id as labCaseId)
    await db.insert(casesTable).values({
      id: labCaseId,
      caseNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: labOrgId,
      status: "received",
      patientFirstName: "Jane",
      patientLastName: "Promo",
      doctorName: "Dr. Promo",
      createdByUserId: labOwnerId,
    });

    // Step 4: call generate-invoice for the canonical case — must NOT 409
    const r2 = await request(appMod.default)
      .post(`/api/invoices/cases/${labCaseId}/generate-invoice`)
      .set("Authorization", `Bearer ${access}`)
      .send({});
    expect(r2.status, `expected 200, got ${r2.status}: ${JSON.stringify(r2.body)}`).toBe(200);

    // Same invoice id — no duplicate was created
    expect(r2.body.data.id).toBe(r1.body.data.id);

    // caseId is now linked to the canonical case
    expect(r2.body.data.caseId).toBe(labCaseId);

    // Exactly one invoice row for this case number
    const allInvoices = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.invoiceNumber, `INV-${caseNumber}`));
    expect(allInvoices).toHaveLength(1);
    expect(allInvoices[0].caseId).toBe(labCaseId);
  });
});
