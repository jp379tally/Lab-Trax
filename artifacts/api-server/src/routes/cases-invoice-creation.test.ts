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
      doctorName: "Dr. Alice",
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
      doctorName: "Dr. Bob",
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
        status: "draft",
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
      status: "draft",
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
      (inv: any) =>
        inv.invoiceNumber === `INV-${caseNumber}` ||
        inv.invoiceNumber === `M-${caseNumber}`
    );

    expect(
      forThisCase,
      "expected exactly one invoice (INV-) for the mobile case, not a duplicate M- row"
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
