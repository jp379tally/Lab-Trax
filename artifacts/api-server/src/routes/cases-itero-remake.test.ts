/**
 * Regression suite: iTero Rx import remake invariants (db integration).
 *
 * The desktop "Link as remake" flow forwards remake metadata
 * (remakeOfCaseId / remakeReason / remakeCharged) to the dedicated iTero
 * endpoint `POST /api/cases/import-from-itero-rx`. A client-side test
 * (DashboardDropZone.itero-remake-zip.test.tsx) proves the client SENDS
 * those fields, and cases-remake.test.ts proves the GENERIC /cases create
 * path links remakes correctly — but nothing exercised the iTero handler
 * end-to-end through the database. A refactor of the iTero handler could
 * silently drop the suffixed case number, the cross-link events, or the
 * no-charge invoice zeroing without any existing test failing.
 *
 * This suite drives the actual iTero endpoint and asserts the same
 * invariants cases-remake.test.ts guards for the generic path:
 *   (1) Canonical original: created case number is suffixed ("originalB"),
 *       remakeOfCaseId is set, a forward "remake_of" event exists on the
 *       new case, and a reciprocal "remade_by" event exists on the
 *       canonical original — all committed atomically with the case INSERT.
 *   (2) Legacy (lab_cases blob) original: created case number is suffixed,
 *       remakeOfCaseId points at the legacy id, the forward "remake_of"
 *       event records originalCaseKind="legacy", and the legacy row's
 *       caseData.activityLog is patched with a "remade_by" entry after
 *       commit.
 *   (3) No-charge remake (remakeCharged:"false"): the draft invoice is
 *       still created (not skipped) but every line item is zeroed and the
 *       invoice carries a no-charge note.
 *
 * Reuses the OpenAI/PDF rasterizer mock harness from
 * cases-itero-ai-extraction.test.ts so the suite is deterministic and makes
 * no real network or pdftoppm calls.
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const TEST_MEDIA_DIR = path.join(os.tmpdir(), "labtrax-test-media-itero-remake");

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
// the unsupported Files/Responses APIs.
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-itero-remake"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
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

function makeTempRxFile(): string {
  const tmpDir = path.join(os.tmpdir(), "labtrax-test-rx-itero-remake");
  fs.mkdirSync(tmpDir, { recursive: true });
  const p = path.join(tmpDir, `rx-${rid("f")}.pdf`);
  fs.writeFileSync(p, "%PDF-1.4 fake rx content for testing");
  return p;
}

maybe("iTero Rx import remake invariants (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const adminUserId = rid("uadmin");
  let savedOpenAIKey: string | undefined;

  const createdCaseIds: string[] = [];
  const createdLabCaseIds: string[] = [];

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db.insert(userSessions).values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  beforeAll(async () => {
    fs.mkdirSync(TEST_MEDIA_DIR, { recursive: true });
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-itero-remake";
    // The AI client is gated on this key. The mocked SDK makes no real calls,
    // so a placeholder value is enough to take the AI-extraction branch.
    savedOpenAIKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key-itero-remake";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships, pricingTiers } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "testpass" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "iTero Remake Test Lab" },
      {
        id: providerOrgId,
        type: "provider",
        name: "Remake Test Practice",
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: adminUserId, role: "admin", status: "active" },
    ]);

    // Seed a "Standard" pricing tier so a Zirconia crown resolves to a
    // non-zero price (zirconia_crown is the key materialToPriceKey returns
    // for material "Zirconia"). Lets the no-charge test prove zeroing actually
    // happened (from 150 → 0) rather than being a no-op on an already-$0 line.
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
      labCases,
      iteroImportedOrders,
      iteroImportSessions,
      notifications,
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
    await db.delete(notifications).where(inArray(notifications.userId, [adminUserId]));
    await db.delete(iteroImportedOrders).where(eq(iteroImportedOrders.labOrganizationId, labOrgId));
    await db.delete(iteroImportSessions).where(eq(iteroImportSessions.labOrganizationId, labOrgId));
    await db.delete(invoices).where(
      inArray(invoices.labOrganizationId, [labOrgId, providerOrgId])
    );
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    if (createdLabCaseIds.length) {
      await db.delete(labCases).where(inArray(labCases.id, createdLabCaseIds));
    }
    await db.delete(pricingTiers).where(eq(pricingTiers.labOrganizationId, labOrgId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, adminUserId));
    await db.delete(userSessions).where(eq(userSessions.userId, adminUserId));
    await db.delete(organizations).where(inArray(organizations.id, [labOrgId, providerOrgId]));
    await db.delete(users).where(eq(users.id, adminUserId));
  });

  // ── (1) Remake of a canonical original ───────────────────────────────────

  it("(1) canonical original: suffixed case number (B), remakeOfCaseId set, remake_of on new case + remade_by on original committed atomically", async () => {
    const adminToken = await makeSession(adminUserId);
    const { db, cases, caseEvents } = dbMod as any;

    const originalId = rid("orig");
    const originalNumber = rid("RMK");
    await db.insert(cases).values({
      id: originalId,
      caseNumber: originalNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Ada",
      patientLastName: "Lovelace",
      doctorName: "Dr. Babbage",
      createdByUserId: adminUserId,
    });
    createdCaseIds.push(originalId);

    const orderId = rid("order");
    const rxFile = makeTempRxFile();

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "iTero_Rx_111.pdf")
      .field("iteroOrderId", orderId)
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("remakeOfCaseId", originalId)
      .field("remakeReason", "Crown fracture")
      .field("remakeCharged", "true");

    expect(r.status, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(201);
    expect(r.body.ok).toBe(true);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();
    createdCaseIds.push(caseId);

    // Server used the supported vision path, never the unsupported Files API.
    expect(mockChatCreate).toHaveBeenCalled();
    expect(mockFilesCreate).not.toHaveBeenCalled();

    // ── Suffixed case number + remake link ──
    expect(r.body.data.caseNumber).toBe(`${originalNumber}B`);
    const [caseRow] = await db
      .select({
        caseNumber: cases.caseNumber,
        remakeOfCaseId: cases.remakeOfCaseId,
        remakeReason: cases.remakeReason,
        remakeCharged: cases.remakeCharged,
      })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(caseRow.caseNumber).toBe(`${originalNumber}B`);
    expect(caseRow.remakeOfCaseId).toBe(originalId);
    expect(caseRow.remakeReason).toBe("Crown fracture");
    expect(caseRow.remakeCharged).toBe(true);

    // ── Atomic cross-link events ──
    // Both "remake_of" (new case) and "remade_by" (canonical original) are
    // written inside the same DB transaction as the case INSERT. Their
    // existence proves the atomic guarantee held for the iTero path.
    const forwardEvent = await db.query.caseEvents.findFirst({
      where: and(
        eq(caseEvents.caseId, caseId),
        eq(caseEvents.eventType, "remake_of"),
      ),
    });
    expect(forwardEvent, "remake_of event must exist on the new iTero case").toBeDefined();
    expect(forwardEvent.metadataJson?.originalCaseId).toBe(originalId);
    expect(forwardEvent.metadataJson?.originalCaseKind).toBe("canonical");
    expect(forwardEvent.metadataJson?.remakeReason).toBe("Crown fracture");

    const backwardEvent = await db.query.caseEvents.findFirst({
      where: and(
        eq(caseEvents.caseId, originalId),
        eq(caseEvents.eventType, "remade_by"),
      ),
    });
    expect(backwardEvent, "remade_by event must exist on the canonical original").toBeDefined();
    expect(backwardEvent.metadataJson?.remakeCaseId).toBe(caseId);
    expect(backwardEvent.metadataJson?.remakeCaseNumber).toBe(`${originalNumber}B`);

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  // ── (2) Remake of a legacy (lab_cases blob) original ─────────────────────

  it("(2) legacy original: suffixed case number, remakeOfCaseId set, remake_of records legacy kind, lab_cases activityLog patched with remade_by", async () => {
    const adminToken = await makeSession(adminUserId);
    const { db, labCases, cases, caseEvents } = dbMod as any;

    const legacyCaseNumber = rid("LGC");
    const legacyCaseId = rid("lc");
    createdLabCaseIds.push(legacyCaseId);

    // The legacy original's doctorName must match the doctor the iTero handler
    // derives for the new case (AI mock → "Dr. Babbage") so resolveRemakeOriginal
    // accepts the legacy link for this provider org.
    await db.insert(labCases).values({
      id: legacyCaseId,
      ownerId: adminUserId,
      organizationId: labOrgId,
      caseData: JSON.stringify({
        caseNumber: legacyCaseNumber,
        doctorName: "Dr. Babbage",
        patientName: "Ada Lovelace",
      }),
    });

    const orderId = rid("order");
    const rxFile = makeTempRxFile();

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "iTero_Rx_222.pdf")
      .field("iteroOrderId", orderId)
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("remakeOfCaseId", legacyCaseId)
      .field("remakeReason", "Material failure")
      .field("remakeCharged", "true");

    expect(r.status, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(201);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();
    createdCaseIds.push(caseId);

    // ── Suffixed case number + remake link to the legacy id ──
    expect(r.body.data.caseNumber).toBe(`${legacyCaseNumber}B`);
    const [caseRow] = await db
      .select({ caseNumber: cases.caseNumber, remakeOfCaseId: cases.remakeOfCaseId })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(caseRow.caseNumber).toBe(`${legacyCaseNumber}B`);
    expect(caseRow.remakeOfCaseId).toBe(legacyCaseId);

    // ── Forward "remake_of" event records the legacy kind ──
    const forwardEvent = await db.query.caseEvents.findFirst({
      where: and(
        eq(caseEvents.caseId, caseId),
        eq(caseEvents.eventType, "remake_of"),
      ),
    });
    expect(forwardEvent, "remake_of event must exist on the new case for a legacy original").toBeDefined();
    expect(forwardEvent.metadataJson?.originalCaseId).toBe(legacyCaseId);
    expect(forwardEvent.metadataJson?.originalCaseKind).toBe("legacy");

    // ── Legacy lab_cases activityLog patched (after commit) with remade_by ──
    const [row] = await db
      .select()
      .from(labCases)
      .where(eq(labCases.id, legacyCaseId));
    const parsed = typeof row.caseData === "string" ? JSON.parse(row.caseData) : row.caseData;
    expect(Array.isArray(parsed?.activityLog), "lab_cases activityLog must be an array").toBe(true);
    const remadeByEntry = parsed.activityLog.find((e: any) => e.type === "remade_by");
    expect(remadeByEntry, "legacy activityLog must contain a remade_by entry").toBeDefined();
    expect(remadeByEntry.metadata?.remakeCaseId).toBe(caseId);
    expect(remadeByEntry.metadata?.remakeCaseNumber).toBe(`${legacyCaseNumber}B`);

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  // ── (3) No-charge remake: invoice still created but zeroed ────────────────

  it("(3) no-charge remake (remakeCharged: false): draft invoice still created, line items zeroed, no-charge note attached", async () => {
    const adminToken = await makeSession(adminUserId);
    const { db, cases, invoices, invoiceLineItems } = dbMod as any;

    const originalId = rid("origNC");
    const originalNumber = rid("NC");
    await db.insert(cases).values({
      id: originalId,
      caseNumber: originalNumber,
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Ada",
      patientLastName: "Lovelace",
      doctorName: "Dr. Babbage",
      createdByUserId: adminUserId,
    });
    createdCaseIds.push(originalId);

    const orderId = rid("order");
    const rxFile = makeTempRxFile();

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "iTero_Rx_333.pdf")
      .field("iteroOrderId", orderId)
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("remakeOfCaseId", originalId)
      .field("remakeReason", "Lab fault")
      .field("remakeCharged", "false");

    expect(r.status, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(201);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();
    createdCaseIds.push(caseId);
    expect(r.body.data.caseNumber).toBe(`${originalNumber}B`);

    // ── Draft invoice still created (NOT skipped) ──
    let invoice: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 100));
      [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.caseId, caseId));
      if (invoice) break;
    }
    expect(invoice, "no-charge remake must still create the draft invoice").toBeDefined();
    expect(invoice.status).toBe("draft");

    // ── Invoice totals zeroed ──
    expect(Number(invoice.subtotal)).toBe(0);
    expect(Number(invoice.total)).toBe(0);
    expect(Number(invoice.balanceDue)).toBe(0);

    // ── No-charge note attached ──
    expect(
      typeof invoice.notes === "string" && invoice.notes.length > 0,
      "no-charge remake invoice must carry a no-charge note",
    ).toBe(true);
    expect(invoice.notes).toContain("No-charge remake");

    // ── Line items present but zeroed (line detail stays visible) ──
    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    expect(lineItems.length, "line items must remain visible even at $0").toBeGreaterThan(0);
    for (const li of lineItems) {
      expect(Number(li.unitPrice)).toBe(0);
      expect(Number(li.lineTotal)).toBe(0);
      expect(li.description).toContain("(no-charge remake)");
    }
    const lineTotalSum = lineItems.reduce(
      (acc: number, li: any) => acc + Number(li.lineTotal),
      0,
    );
    expect(lineTotalSum).toBe(0);

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  // ── (4) Duplicate-doctor auto-merge on import ────────────────────────────
  //
  // The manual create-case flow rejects a near-duplicate doctor with a 409 so
  // a human can confirm. Auto-import has no human at create time, so instead of
  // rejecting it adopts the existing spelling when the parsed name clears the
  // lab similarity threshold within the SAME practice — and records a
  // "doctor_auto_merged_from_itero" audit event. Below threshold it must keep
  // the parsed name verbatim and emit no merge event.

  it("(4a) near-duplicate parsed doctor is merged into the existing spelling + audit event", async () => {
    const adminToken = await makeSession(adminUserId);
    const { db, cases, caseEvents } = dbMod as any;

    // Seed an existing doctor in this practice.
    const existingDoctor = "Dr. Katherine Johnson";
    const seedId = rid("seed");
    await db.insert(cases).values({
      id: seedId,
      caseNumber: rid("DUP"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Seed",
      patientLastName: "Patient",
      doctorName: existingDoctor,
      createdByUserId: adminUserId,
    });
    createdCaseIds.push(seedId);

    // The AI "extracts" a near-duplicate spelling (missing period).
    const parsedDoctor = "Dr Katherine Johnson";
    mockChatCreate.mockResolvedValue(aiExtractedRx({ doctorName: parsedDoctor }));

    const orderId = rid("order");
    const rxFile = makeTempRxFile();
    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "iTero_Rx_dup.pdf")
      .field("iteroOrderId", orderId)
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);

    expect(r.status, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(201);
    const caseId = r.body.data.caseId as string;
    createdCaseIds.push(caseId);

    // Created case adopted the existing spelling, not the parsed one.
    const [caseRow] = await db
      .select({ doctorName: cases.doctorName })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(caseRow.doctorName).toBe(existingDoctor);

    // A merge audit event was recorded with both names + similarity.
    const events = await db
      .select()
      .from(caseEvents)
      .where(
        and(
          eq(caseEvents.caseId, caseId),
          eq(caseEvents.eventType, "doctor_auto_merged_from_itero"),
        ),
      );
    expect(events.length).toBe(1);
    expect(events[0].metadataJson.parsedDoctorName).toBe(parsedDoctor);
    expect(events[0].metadataJson.mergedToDoctorName).toBe(existingDoctor);
    expect(typeof events[0].metadataJson.similarity).toBe("number");

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  it("(4b) below-threshold parsed doctor is kept verbatim with no merge event", async () => {
    const adminToken = await makeSession(adminUserId);
    const { db, cases, caseEvents } = dbMod as any;

    // Seed an unrelated doctor in this practice.
    const seedId = rid("seed");
    await db.insert(cases).values({
      id: seedId,
      caseNumber: rid("NOM"),
      labOrganizationId: labOrgId,
      providerOrganizationId: providerOrgId,
      status: "received",
      patientFirstName: "Seed",
      patientLastName: "Patient",
      doctorName: "Dr. Alan Turing",
      createdByUserId: adminUserId,
    });
    createdCaseIds.push(seedId);

    // A completely different parsed name — well below the similarity threshold.
    const parsedDoctor = "Dr. Grace Hopper";
    mockChatCreate.mockResolvedValue(aiExtractedRx({ doctorName: parsedDoctor }));

    const orderId = rid("order");
    const rxFile = makeTempRxFile();
    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "iTero_Rx_nomerge.pdf")
      .field("iteroOrderId", orderId)
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);

    expect(r.status, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`).toBe(201);
    const caseId = r.body.data.caseId as string;
    createdCaseIds.push(caseId);

    // Parsed name kept verbatim.
    const [caseRow] = await db
      .select({ doctorName: cases.doctorName })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(caseRow.doctorName).toBe(parsedDoctor);

    // No merge event.
    const events = await db
      .select()
      .from(caseEvents)
      .where(
        and(
          eq(caseEvents.caseId, caseId),
          eq(caseEvents.eventType, "doctor_auto_merged_from_itero"),
        ),
      );
    expect(events.length).toBe(0);

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });
});
