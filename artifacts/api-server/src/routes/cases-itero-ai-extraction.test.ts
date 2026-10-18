/**
 * Regression guard: server-side iTero Rx AI extraction must persist to the
 * created case, restoration rows, AND the auto-generated draft invoice — even
 * when the client sends NO clinical hints (the background poller and stale
 * Electron clients always hit this path).
 *
 * Root cause this guards against: server PDF extraction previously used the
 * OpenAI Files API (`openai.files.create()` / `responses.create()`), which the
 * Replit AI Integrations proxy rejects with `400 "POST /files is not supported"`.
 * Every iTero import then fell back to client hints; the hint-less poller path
 * produced blank Lab Slips (no tooth/material/shade/dueDate/rxNotes) and $0.00
 * draft invoices. The fix rasterizes the PDF to images (pdftoppm) and uses the
 * vision chat.completions API instead.
 *
 * This test:
 *  - Mocks the OpenAI SDK so chat.completions.create returns extracted Rx
 *    fields, and asserts files.create is NEVER called (the unsupported path).
 *  - Mocks the PDF→image rasterizer so the suite is deterministic and does not
 *    depend on a real PDF / pdftoppm.
 *  - Seeds a "Standard" pricing tier so the resolved restoration price (and
 *    therefore the invoice total) is non-zero.
 *  - Asserts the created case + restorations + invoice all carry the extracted
 *    clinical data with a non-zero invoice total.
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import AdmZip from "adm-zip";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const TEST_MEDIA_DIR = path.join(os.tmpdir(), "labtrax-test-media-itero-ai");

// Hoisted spies so the vi.mock factories below can reference them.
const {
  mockChatCreate,
  mockFilesCreate,
  mockResponsesCreate,
  mockConvertPdf,
  mockWriteCaseMediaToObjectStorage,
} = vi.hoisted(() => ({
  mockChatCreate: vi.fn(),
  mockFilesCreate: vi.fn(() => {
    throw new Error("400 Endpoint: 'POST /files' is not supported.");
  }),
  mockResponsesCreate: vi.fn(() => {
    throw new Error("responses.create must not be used (unsupported on proxy)");
  }),
  mockConvertPdf: vi.fn(async () => ["data:image/jpeg;base64,ZmFrZS1yeC1pbWFnZQ=="]),
  mockWriteCaseMediaToObjectStorage: vi.fn().mockResolvedValue(true),
}));

// Fully mock the OpenAI SDK so the suite is deterministic and makes no network
// calls. files.create / responses.create throw to PROVE the route never uses
// the unsupported Files/Responses APIs — if it did, this test would fail.
vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: mockChatCreate } };
    files = { create: mockFilesCreate };
    responses = { create: mockResponsesCreate };
    constructor(_opts?: unknown) {}
  }
  return { default: FakeOpenAI, toFile: vi.fn() };
});

// Mock the shared PDF→image rasterizer so we don't depend on a real PDF binary
// or pdftoppm being present; the vision path receives a stand-in image.
vi.mock("../lib/pdf-to-images.js", () => ({
  convertPdfBufferToImageDataUrls: mockConvertPdf,
}));

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-itero-ai"),
  extractMediaFileName: () => null,
}));
vi.mock("../lib/case-media-object-storage.js", () => ({
  writeCaseMediaToObjectStorage: mockWriteCaseMediaToObjectStorage,
  openCaseMediaObjectStream: vi.fn().mockResolvedValue(null),
  caseMediaObjectStorageAvailable: vi.fn().mockReturnValue(true),
  deleteCaseMediaFromObjectStorage: vi.fn().mockResolvedValue(false),
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Build the JSON the mocked vision model "extracts" from the Rx PDF. */
function aiExtractedRx(overrides: Record<string, unknown> = {}) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            patientFirstName: "Ada",
            patientLastName: "Lovelace",
            doctorName: "Dr. Babbage",
            caseType: "Crown",
            material: "Zirconia",
            shade: "A2",
            teeth: "8, 9",
            arch: "upper",
            dueDate: "2026-07-01",
            isRush: false,
            notes: "Match adjacent shade carefully; high translucency.",
            ...overrides,
          }),
        },
      },
    ],
  };
}

/**
 * Build a minimal valid iTero export ZIP containing a single Rx PDF whose
 * filename encodes the order id (`iTero_Rx_<digits>.pdf`), which is how the
 * ZIP route derives the dedup key.
 */
function makeIteroZipBuffer(orderDigits: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    `iTero_Rx_${orderDigits}.pdf`,
    Buffer.from("%PDF-1.4 fake rx content for testing"),
  );
  return zip.toBuffer();
}

maybe("iTero Rx AI extraction persistence (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const adminUserId = rid("uadmin");
  let savedOpenAIKey: string | undefined;

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  function makeTempRxFile(): string {
    const tmpDir = path.join(os.tmpdir(), "labtrax-test-rx-itero-ai");
    fs.mkdirSync(tmpDir, { recursive: true });
    const p = path.join(tmpDir, `rx-${rid("f")}.pdf`);
    fs.writeFileSync(p, "%PDF-1.4 fake rx content for testing");
    return p;
  }

  beforeAll(async () => {
    fs.mkdirSync(TEST_MEDIA_DIR, { recursive: true });
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-itero-ai";
    // The AI client is gated on this key. The mocked SDK makes no real calls,
    // so a placeholder value is enough to take the AI-extraction branch.
    savedOpenAIKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key-itero-ai";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships, pricingTiers } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "testpass" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "iTero AI Test Lab" },
      {
        id: providerOrgId,
        type: "provider",
        name: "Test Practice",
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: adminUserId, role: "admin", status: "active" },
    ]);

    // Seed a "Standard" pricing tier so a Zirconia crown resolves to a
    // non-zero price (zirconia_crown is the key materialToPriceKey returns
    // for material "Zirconia"). Without this the invoice would be $0 because
    // unconfigured labs have no fee schedule.
    await db.insert(pricingTiers).values({
      id: rid("tier"),
      labOrganizationId: labOrgId,
      name: "Standard",
      pricesJson: { zirconia_crown: 150 },
    });
  });

  beforeEach(() => {
    mockChatCreate.mockReset();
    mockChatCreate.mockResolvedValue(aiExtractedRx());
    mockFilesCreate.mockClear();
    mockResponsesCreate.mockClear();
    mockConvertPdf.mockClear();
  });

  afterAll(async () => {
    if (savedOpenAIKey !== undefined) {
      process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = savedOpenAIKey;
    } else {
      delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    }
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      cases,
      caseEvents,
      iteroImportedOrders,
      iteroImportSessions,
      organizationMemberships,
      userSessions,
      auditLogs,
      invoices,
      pricingTiers,
    } = dbMod as any;
    // Dependency order: invoices (labOrgId onDelete:restrict) before orgs;
    // cases cascade-delete restorations/attachments/notes; invoices cascade
    // their line items.
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db.delete(caseEvents).where(eq(caseEvents.actorOrganizationId, labOrgId));
    await db.delete(iteroImportedOrders).where(eq(iteroImportedOrders.labOrganizationId, labOrgId));
    await db.delete(iteroImportSessions).where(eq(iteroImportSessions.labOrganizationId, labOrgId));
    await db.delete(invoices).where(
      inArray(invoices.labOrganizationId, [labOrgId, providerOrgId])
    );
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db.delete(pricingTiers).where(eq(pricingTiers.labOrganizationId, labOrgId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, adminUserId));
    await db.delete(userSessions).where(eq(userSessions.userId, adminUserId));
    await db.delete(organizations).where(inArray(organizations.id, [labOrgId, providerOrgId]));
    await db.delete(users).where(eq(users.id, adminUserId));
  });

  it("persists reviewed multipart invoice lines with their child charges instead of extracted prices", async () => {
    const adminToken = await makeSession(adminUserId);
    const reviewed = [
      { description: "Corrected crown", quantity: 1, unitPrice: 10, subItems: [
        { description: "Layered Porcelain", quantity: 1, unitPrice: 37 },
      ] },
      { description: "Rush fee", quantity: 1, unitPrice: 15 },
    ];
    const result = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", makeTempRxFile(), "iTero_Rx_reviewed.pdf")
      .field("iteroOrderId", rid("order"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("confirmNewDoctor", "true")
      .field("invoiceOverrideLines", JSON.stringify(reviewed));
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const { db, invoices, invoiceLineItems } = dbMod as any;
    const [invoice] = await db.select().from(invoices).where(eq(invoices.caseId, result.body.data.caseId));
    expect(Number(invoice.total)).toBe(62);
    const rows = await db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id));
    expect(rows).toHaveLength(3);
    const parent = rows.find((row: any) => row.description === "Corrected crown");
    const child = rows.find((row: any) => row.description === "Layered Porcelain");
    expect(child.parentLineItemId).toBe(parent.id);
    expect(rows.every((row: any) => row.sourceType === "manual")).toBe(true);
  }, 60_000);

  it("persists AI-extracted Rx fields to the case, restorations, and a non-zero invoice (no client hints)", async () => {
    const adminToken = await makeSession(adminUserId);
    const orderId = rid("order");
    const rxFile = makeTempRxFile();

    // NOTE: no *Hint fields are sent — this is the poller / stale-client path.
    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "iTero_Rx_123.pdf")
      .field("iteroOrderId", orderId)
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      // "Dr. Babbage" is not on file for this fresh practice, so the strict
      // doctor-not-on-file gate would otherwise 409. This test is about AI
      // extraction persistence, not doctor gating, so confirm the new doctor.
      .field("confirmNewDoctor", "true");

    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();
    expect(r.body.data.needsAiReview).toBe(false);

    // The route used the supported vision path and NOT the unsupported Files
    // API (the exact regression that produced blank cases in production).
    expect(mockChatCreate).toHaveBeenCalled();
    expect(mockFilesCreate).not.toHaveBeenCalled();
    expect(mockResponsesCreate).not.toHaveBeenCalled();
    expect(mockConvertPdf).toHaveBeenCalled();

    const {
      db,
      cases,
      caseRestorations,
      invoices,
      invoiceLineItems,
    } = dbMod as any;

    // ── Case fields (Lab Slip) ──
    const [caseRow] = await db
      .select({
        shade: cases.shade,
        rxNotes: cases.rxNotes,
        dueDate: cases.dueDate,
        priority: cases.priority,
        patientFirstName: cases.patientFirstName,
        doctorName: cases.doctorName,
        needsAiReview: cases.needsAiReview,
        aiImportSource: cases.aiImportSource,
      })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(caseRow.shade).toBe("A2");
    expect(caseRow.rxNotes).toContain("Match adjacent shade");
    expect(caseRow.dueDate).toBeTruthy();
    expect(caseRow.patientFirstName).toBe("Ada");
    expect(caseRow.doctorName).toBe("Dr. Babbage");
    expect(caseRow.needsAiReview).toBe(false);
    expect(caseRow.aiImportSource).toBe("itero");

    // ── Restoration rows (one per tooth) ──
    const restorations = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(restorations).toHaveLength(2);
    const teeth = restorations.map((x: any) => x.toothNumber).sort();
    expect(teeth).toEqual(["8", "9"]);
    for (const rest of restorations) {
      expect(rest.restorationType).toBe("Crown & Bridge");
      expect(rest.material).toBe("Zirconia");
      expect(rest.shade).toBe("A2");
      expect(Number(rest.unitPrice)).toBe(150);
    }

    // ── Auto-generated draft invoice (non-zero) ──
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(invoice, "auto-invoice must be created").toBeDefined();
    expect(invoice.status).toBe("open");
    expect(Number(invoice.total)).toBe(300);
    expect(Number(invoice.subtotal)).toBe(300);
    expect(Number(invoice.balanceDue)).toBe(300);

    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    expect(lineItems.length).toBeGreaterThan(0);
    const lineTotalSum = lineItems.reduce(
      (acc: number, li: any) => acc + Number(li.lineTotal),
      0
    );
    expect(lineTotalSum).toBe(300);

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  it("persists AI-extracted Rx fields via the ZIP import path (no client hints)", async () => {
    const adminToken = await makeSession(adminUserId);
    const zipBuf = makeIteroZipBuffer(`90${Math.floor(Math.random() * 1e6)}`);

    // NOTE: no *Hint fields — the ZIP route must populate everything from the
    // server-side vision extraction alone, same as the poller/stale-client path.
    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-zip")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", zipBuf, "iTero_Export.zip")
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);

    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();
    expect(r.body.data.needsAiReview).toBe(false);

    // Supported vision path used; unsupported Files/Responses APIs untouched.
    expect(mockChatCreate).toHaveBeenCalled();
    expect(mockFilesCreate).not.toHaveBeenCalled();
    expect(mockResponsesCreate).not.toHaveBeenCalled();
    expect(mockConvertPdf).toHaveBeenCalled();

    const { db, cases, caseRestorations, invoices, invoiceLineItems } =
      dbMod as any;

    const [caseRow] = await db
      .select({
        shade: cases.shade,
        rxNotes: cases.rxNotes,
        dueDate: cases.dueDate,
        patientFirstName: cases.patientFirstName,
        doctorName: cases.doctorName,
        needsAiReview: cases.needsAiReview,
        aiImportSource: cases.aiImportSource,
      })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(caseRow.shade).toBe("A2");
    expect(caseRow.rxNotes).toContain("Match adjacent shade");
    expect(caseRow.dueDate).toBeTruthy();
    expect(caseRow.patientFirstName).toBe("Ada");
    expect(caseRow.doctorName).toBe("Dr. Babbage");
    expect(caseRow.needsAiReview).toBe(false);
    expect(caseRow.aiImportSource).toBe("itero");

    const restorations = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(restorations).toHaveLength(2);
    expect(restorations.map((x: any) => x.toothNumber).sort()).toEqual(["8", "9"]);
    for (const rest of restorations) {
      expect(rest.restorationType).toBe("Crown & Bridge");
      expect(rest.material).toBe("Zirconia");
      expect(rest.shade).toBe("A2");
      expect(Number(rest.unitPrice)).toBe(150);
    }

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(invoice, "auto-invoice must be created").toBeDefined();
    expect(invoice.status).toBe("open");
    expect(Number(invoice.total)).toBe(300);
    expect(Number(invoice.subtotal)).toBe(300);
    expect(Number(invoice.balanceDue)).toBe(300);

    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    const lineTotalSum = lineItems.reduce(
      (acc: number, li: any) => acc + Number(li.lineTotal),
      0
    );
    expect(lineTotalSum).toBe(300);
  });

  it("ZIP import with dueDateHint sets expectedDeliveryDate to null (dueDate precedence guard)", async () => {
    // Regression guard: when the iTero ZIP import has a due date — either from
    // the AI extraction or from the client dueDateHint field — expectedDeliveryDate
    // must be stored as null.  This is the guard that would have caught the bug
    // where expectedDeliveryDate overrode an explicit dueDate on the ZIP path.
    const adminToken = await makeSession(adminUserId);
    const zipBuf = makeIteroZipBuffer(`95${Math.floor(Math.random() * 1e6)}`);
    const explicitDue = "2026-10-15";

    // Override the AI mock so it returns NO dueDate — the dueDateHint from the
    // client is then the sole source of truth for iteroZipSuppliedDate.
    mockChatCreate.mockResolvedValue(aiExtractedRx({ dueDate: null }));

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-zip")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", zipBuf, "iTero_Export.zip")
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("dueDateHint", explicitDue);

    expect(r.status).toBe(201);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();

    const { db, cases } = dbMod as any;
    const [row] = await db
      .select({
        dueDate: cases.dueDate,
        expectedDeliveryDate: cases.expectedDeliveryDate,
      })
      .from(cases)
      .where(eq(cases.id, caseId));

    expect(
      row.expectedDeliveryDate,
      "expectedDeliveryDate must be null when dueDateHint is supplied on the ZIP path",
    ).toBeNull();
    const dueDateIso =
      row.dueDate instanceof Date ? row.dueDate.toISOString() : String(row.dueDate);
    expect(dueDateIso).toMatch(/^2026-10-15/);
  });

  it("falls back to notesHint for cases.rxNotes when AI extracts no notes (ZIP path)", async () => {
    const adminToken = await makeSession(adminUserId);
    const zipBuf = makeIteroZipBuffer(`91${Math.floor(Math.random() * 1e6)}`);

    // AI extraction succeeds for everything EXCEPT notes — the exact partial
    // failure where the client-supplied notesHint must still reach rxNotes.
    mockChatCreate.mockResolvedValue(aiExtractedRx({ notes: undefined }));
    const hintNote = "Patient prefers a brighter shade; confirm before milling.";

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-zip")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", zipBuf, "iTero_Export.zip")
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("notesHint", hintNote);

    expect(r.status).toBe(201);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();

    const { db, cases } = dbMod as any;
    const [caseRow] = await db
      .select({ rxNotes: cases.rxNotes, shade: cases.shade })
      .from(cases)
      .where(eq(cases.id, caseId));
    // rxNotes (the Lab Slip field, not just the case-note row) carries the hint.
    expect(caseRow.rxNotes).toBe(hintNote);
    // Other AI-extracted fields are unaffected.
    expect(caseRow.shade).toBe("A2");
  });

  it("Removable case with 4 teeth creates 1 restoration row (QTY = 1), not 4", async () => {
    // Regression guard: a Nesbit partial / any Removable appliance is one
    // billable unit regardless of how many teeth it covers. Before the fix,
    // each tooth produced its own restoration row and the invoice showed QTY 4.
    const adminToken = await makeSession(adminUserId);
    const rxFile = makeTempRxFile();

    mockChatCreate.mockResolvedValue(
      aiExtractedRx({
        caseType: "Removable",
        removableSubtype: "partial",
        material: "Acrylic",
        teeth: "28, 29, 30, 31",
        shade: null,
      }),
    );

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "iTero_Rx_removable.pdf")
      .field("iteroOrderId", rid("order"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("confirmNewDoctor", "true");

    expect(r.status).toBe(201);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();

    const { db, cases: casesTable, caseRestorations, invoices, invoiceLineItems } = dbMod as any;

    // ── 1 restoration row, toothNumber carries all 4 teeth ──
    const restorations = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(restorations).toHaveLength(1);
    expect(restorations[0].restorationType).toBe("Removable");
    // All four teeth must be joined in the single row's toothNumber field.
    expect(restorations[0].toothNumber).toContain("28");
    expect(restorations[0].toothNumber).toContain("29");
    expect(restorations[0].toothNumber).toContain("30");
    expect(restorations[0].toothNumber).toContain("31");
    // quantity defaults to 1 — one appliance.
    expect(restorations[0].quantity).toBe(1);

    // ── Invoice line items: exactly 1 line, QTY = 1 ──
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(invoice, "auto-invoice must be created").toBeDefined();

    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    const billableLines = lineItems.filter((li: any) => li.quantity > 0);
    expect(billableLines).toHaveLength(1);
    expect(billableLines[0].quantity).toBe(1);

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  it("Crown & Bridge case with 4 teeth still creates 4 restoration rows (unaffected)", async () => {
    // Sanity guard: the Removable collapse must not touch Crown & Bridge cases.
    const adminToken = await makeSession(adminUserId);
    const rxFile = makeTempRxFile();

    mockChatCreate.mockResolvedValue(
      aiExtractedRx({
        caseType: "Crown",
        material: "Zirconia",
        teeth: "5, 6, 7, 8",
        shade: "A1",
      }),
    );

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "iTero_Rx_cnb4teeth.pdf")
      .field("iteroOrderId", rid("order"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("confirmNewDoctor", "true");

    expect(r.status).toBe(201);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();

    const { db, cases, caseRestorations, invoices, invoiceLineItems } = dbMod as any;
    const [importedCase] = await db
      .select({
        needsAiReview: cases.needsAiReview,
        aiImportSource: cases.aiImportSource,
      })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(importedCase.needsAiReview).toBe(false);
    expect(importedCase.aiImportSource).toBe("itero");

    // 4 separate restoration rows — one per tooth — as before.
    const restorations = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(restorations).toHaveLength(4);
    for (const rest of restorations) {
      expect(rest.restorationType).toBe("Crown & Bridge");
      expect(rest.quantity).toBe(1);
    }

    // Invoice total = 4 × $150 = $600.
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(Number(invoice.total)).toBe(600);

    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    const totalQty = lineItems.reduce((s: number, li: any) => s + li.quantity, 0);
    expect(totalQty).toBe(4);

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  it("Flipper case with 2 teeth and per-tooth shades creates 2 restoration rows with correct shades", async () => {
    // A flipper for tooth 3 and a flipper for tooth 29 are two separate physical
    // appliances (upper vs lower arch). The import must produce one restoration row
    // per tooth — each QTY 1 — with the per-tooth shade from the prescription.
    const adminToken = await makeSession(adminUserId);
    const rxFile = makeTempRxFile();

    mockChatCreate.mockResolvedValue(
      aiExtractedRx({
        caseType: "Removable",
        removableSubtype: "flipper",
        material: "Flexible",
        teeth: "3, 29",
        shade: null,
        perToothShades: { "3": "A4", "29": "C2" },
      }),
    );

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "iTero_Rx_flipper.pdf")
      .field("iteroOrderId", rid("order"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("confirmNewDoctor", "true");

    expect(r.status).toBe(201);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();

    const { db, caseRestorations, invoices, invoiceLineItems } = dbMod as any;

    // ── 2 restoration rows, one per tooth ──
    const restorations = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(restorations).toHaveLength(2);

    const byTooth = Object.fromEntries(
      restorations.map((row: any) => [row.toothNumber, row]),
    );
    expect(byTooth["3"], "tooth 3 restoration must exist").toBeDefined();
    expect(byTooth["29"], "tooth 29 restoration must exist").toBeDefined();

    // Each row must be QTY 1 with the correct per-tooth shade.
    expect(byTooth["3"].quantity).toBe(1);
    expect(byTooth["3"].shade).toBe("A4");
    expect(byTooth["29"].quantity).toBe(1);
    expect(byTooth["29"].shade).toBe("C2");

    // Both rows carry the Flexible material and Removable type.
    expect(byTooth["3"].material).toBe("Flexible");
    expect(byTooth["29"].material).toBe("Flexible");
    expect(byTooth["3"].restorationType).toBe("Removable");
    expect(byTooth["29"].restorationType).toBe("Removable");

    // ── Invoice must have 2 billable line items, one per flipper ──
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(invoice, "auto-invoice must be created").toBeDefined();

    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    const billableLines = lineItems.filter((li: any) => li.quantity > 0);
    expect(billableLines).toHaveLength(2);
    billableLines.forEach((li: any) => expect(li.quantity).toBe(1));

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  it("ZIP batch import: Removable case with 4 teeth creates 1 restoration row (QTY = 1), not 4", async () => {
    // Regression guard: processOneIteroZipFile (the shared ZIP processor used by
    // both the single-ZIP and batch routes) has its own prebuiltRestorations
    // Removable-collapse block. This test exercises the batch route
    // (POST /api/cases/import-from-itero-zip-batch) specifically so that path
    // is covered — previously only the single-file Rx path had a guard.
    const adminToken = await makeSession(adminUserId);
    const zipBuf = makeIteroZipBuffer(`92${Math.floor(Math.random() * 1e6)}`);

    mockChatCreate.mockResolvedValue(
      aiExtractedRx({
        caseType: "Removable",
        material: "Acrylic",
        teeth: "3, 4, 5, 6",
        shade: null,
      }),
    );

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-zip-batch")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("files[]", zipBuf, "iTero_Export_batch.zip")
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);

    expect(r.status).toBe(207);
    expect(r.body.ok).toBe(true);
    const results = r.body.data.results as Array<{
      status: string;
      caseId?: string;
      error?: string;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("created");
    const caseId = results[0].caseId as string;
    expect(caseId).toBeTruthy();

    const { db, cases, caseRestorations, invoices, invoiceLineItems } = dbMod as any;
    const [importedCase] = await db
      .select({
        needsAiReview: cases.needsAiReview,
        aiImportSource: cases.aiImportSource,
      })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(importedCase.needsAiReview).toBe(false);
    expect(importedCase.aiImportSource).toBe("itero");

    // ── 1 restoration row; toothNumber carries all 4 teeth ──
    const restorations = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(restorations).toHaveLength(1);
    expect(restorations[0].restorationType).toBe("Removable");
    expect(restorations[0].toothNumber).toContain("3");
    expect(restorations[0].toothNumber).toContain("4");
    expect(restorations[0].toothNumber).toContain("5");
    expect(restorations[0].toothNumber).toContain("6");
    expect(restorations[0].quantity).toBe(1);

    // ── Invoice: exactly 1 billable line with QTY = 1 ──
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(invoice, "auto-invoice must be created").toBeDefined();

    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    const billableLines = lineItems.filter((li: any) => li.quantity > 0);
    expect(billableLines).toHaveLength(1);
    expect(billableLines[0].quantity).toBe(1);
  });
});
