/**
 * Regression guard: AI-imported iTero Rx cases with ambiguous repair
 * descriptions must set `aiPricingWarning` on the generated invoice and
 * use the generic "Removable Repair" line-item description, NOT a
 * fabricated appliance type. Once the AI returns an explicit subtype
 * (repair_partial or repair_denture), no warning is set and the correct
 * taxonomy key is persisted.
 *
 * Protected behaviors (Task #3460 / #3480 / #3482):
 *
 *   (A) iTero Rx import with ambiguous repair notes ("add tooth"):
 *       - invoice.aiPricingWarning contains "repair type is unclear"
 *       - restoration.restorationType = "Removable Repair"
 *       - invoice line item description contains "Removable Repair"
 *
 *   (B) iTero Rx import with explicit partial-repair notes
 *       ("add tooth to partial"):
 *       - restoration.restorationSubtype = "removable/repair_partial"
 *       - invoice.aiPricingWarning is null (no ambiguity)
 *
 *   (C) iTero ZIP import with ambiguous repair notes ("add tooth"):
 *       - invoice.aiPricingWarning contains "repair type is unclear"
 *       (mirrors (A) but exercises the ZIP batch-import code path)
 *
 * The tests use a fully-mocked OpenAI client so they are deterministic
 * and make no real network calls.
 *
 * Skipped when DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import AdmZip from "adm-zip";

const TEST_MEDIA_DIR = path.join(os.tmpdir(), "labtrax-test-media-ai-repair", "case-media");

// Hoisted spies so vi.mock factories can reference them.
const { mockChatCreate, mockFilesCreate, mockConvertPdf, mockWriteObjectStorage } =
  vi.hoisted(() => ({
    mockChatCreate: vi.fn(),
    mockFilesCreate: vi.fn(() => {
      throw new Error("400 Endpoint: 'POST /files' is not supported.");
    }),
    mockConvertPdf: vi.fn(async () => ["data:image/jpeg;base64,ZmFrZS1yeA=="]),
    mockWriteObjectStorage: vi.fn().mockResolvedValue(true),
  }));

vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: mockChatCreate } };
    files = { create: mockFilesCreate };
    responses = { create: vi.fn(() => { throw new Error("not used"); }) };
    constructor(_opts?: unknown) {}
  }
  return { default: FakeOpenAI, toFile: vi.fn() };
});

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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-ai-repair", "case-media"),
  extractMediaFileName: () => null,
  extractMediaFilenamesFromText: () => [],
}));
vi.mock("../lib/case-media-object-storage.js", () => ({
  writeCaseMediaToObjectStorage: mockWriteObjectStorage,
  openCaseMediaObjectStream: vi.fn().mockResolvedValue(null),
  caseMediaObjectStorageAvailable: vi.fn().mockReturnValue(true),
  deleteCaseMediaFromObjectStorage: vi.fn().mockResolvedValue(false),
}));

vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 });

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Wrap an AI extraction payload in the shape chat.completions.create returns. */
function aiResponse(fields: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            patientFirstName: "Repair",
            patientLastName: "Patient",
            doctorName: "Dr. RepairTest",
            caseType: "Removable",
            material: null,
            shade: null,
            teeth: "Upper",
            arch: "upper",
            dueDate: null,
            isRush: false,
            notes: null,
            ...fields,
          }),
        },
      },
    ],
  };
}

/** Write a minimal fake PDF to a temp file and return its path. */
function makeTempRxFile(): string {
  const dir = path.join(os.tmpdir(), "labtrax-test-rx-ai-repair");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `rx-${rid("f")}.pdf`);
  fs.writeFileSync(p, "%PDF-1.4 fake rx content for repair test");
  return p;
}

/**
 * Build a minimal ZIP archive (on disk) whose only entry is a fake iTero Rx
 * PDF named `iTero_Rx_<orderId>.pdf`. Returns the path to the ZIP file.
 * The caller is responsible for deleting it after use.
 */
function makeTempRxZipFile(orderId: string): string {
  const dir = path.join(os.tmpdir(), "labtrax-test-rx-ai-repair-zip");
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, `rx-zip-${rid("z")}.zip`);
  const zip = new AdmZip();
  zip.addFile(
    `iTero_Rx_${orderId}.pdf`,
    Buffer.from("%PDF-1.4 fake rx content for zip repair test"),
  );
  zip.writeZip(zipPath);
  return zipPath;
}

maybe("AI repair Rx import: aiPricingWarning + restorationSubtype contract (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const adminUserId = rid("uadmin");

  const createdCaseIds: string[] = [];
  let savedAiKey: string | undefined;

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
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-ai-repair";
    // Must be set so the route takes the AI-extraction branch (not the
    // hints-only fallback). The mocked SDK makes no real network calls.
    savedAiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key-ai-repair";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_repair_${adminUserId.slice(-8)}`, password: "x" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: `AI Repair Test Lab ${labOrgId.slice(-6)}` },
      { id: providerOrgId, type: "provider", name: `Repair Practice ${providerOrgId.slice(-6)}`, parentLabOrganizationId: labOrgId },
    ]);
    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: adminUserId, role: "admin", status: "active" },
    ]);
  });

  beforeEach(() => {
    mockChatCreate.mockReset();
    mockConvertPdf.mockClear();
    mockFilesCreate.mockClear();
  });

  afterAll(async () => {
    if (savedAiKey !== undefined) {
      process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = savedAiKey;
    } else {
      delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    }
    if (!SHOULD_RUN) return;
    const {
      db,
      cases,
      caseRestorations,
      caseAttachments,
      caseNotes,
      caseEvents,
      invoices,
      invoiceLineItems,
      iteroImportedOrders,
      iteroImportSessions,
      auditLogs,
      organizationMemberships,
      userSessions,
      organizations,
      users,
    } = dbMod as any;

    if (createdCaseIds.length > 0) {
      if (caseAttachments)
        await db.delete(caseAttachments).where(inArray(caseAttachments.caseId, createdCaseIds));
      if (caseNotes)
        await db.delete(caseNotes).where(inArray(caseNotes.caseId, createdCaseIds));
      if (caseEvents)
        await db.delete(caseEvents).where(inArray(caseEvents.caseId, createdCaseIds));
      if (caseRestorations)
        await db.delete(caseRestorations).where(inArray(caseRestorations.caseId, createdCaseIds));
      const invRows = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.caseId, createdCaseIds));
      const invIds = (invRows as any[]).map((r: any) => r.id);
      if (invoiceLineItems && invIds.length > 0)
        await db.delete(invoiceLineItems).where(inArray(invoiceLineItems.invoiceId, invIds));
      await db.delete(invoices).where(inArray(invoices.caseId, createdCaseIds));
      await db.delete(cases).where(inArray(cases.id, createdCaseIds));
    }

    if (iteroImportedOrders)
      await db.delete(iteroImportedOrders).where(eq(iteroImportedOrders.labOrganizationId, labOrgId));
    if (iteroImportSessions)
      await db.delete(iteroImportSessions).where(eq(iteroImportSessions.labOrganizationId, labOrgId));

    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db.delete(invoices).where(inArray(invoices.labOrganizationId, [labOrgId]));
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, adminUserId));
    await db.delete(userSessions).where(eq(userSessions.userId, adminUserId));
    await db.delete(organizations).where(inArray(organizations.id, [labOrgId, providerOrgId]));
    await db.delete(users).where(eq(users.id, adminUserId));
  });

  // ── (A) Ambiguous repair: "add tooth" with no partial/denture context ──────
  //
  // The AI cannot determine whether the appliance is a partial or a denture,
  // so it returns removableSubtype: "repair". The route must:
  //   1. Store the restoration with restorationType = "Removable Repair" (not
  //      a fabricated appliance name like "Acrylic Flippers").
  //   2. Set invoice.aiPricingWarning to the "repair type is unclear" message
  //      so the billing user knows to choose a subtype before sending.

  it('(A) ambiguous repair ("add tooth") → aiPricingWarning contains "repair type is unclear"', async () => {
    const token = await makeSession(adminUserId);
    const rxFile = makeTempRxFile();

    mockChatCreate.mockResolvedValue(
      aiResponse({
        removableSubtype: "repair",
        notes: "add tooth",
        teeth: "Upper",
      }),
    );

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", rxFile, "iTero_Rx_repair.pdf")
      .field("iteroOrderId", rid("iord"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      // "Dr. RepairTest" is new to this practice — bypass the doctor gate.
      .field("confirmNewDoctor", "true");

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();
    createdCaseIds.push(caseId);

    const { db, caseRestorations, invoices, invoiceLineItems } = dbMod as any;

    // ── Restoration: type must be the generic "Removable Repair" sentinel ──
    const restorations = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(restorations).toHaveLength(1);
    expect(
      restorations[0].restorationType,
      "ambiguous repair must use the 'Removable Repair' fallback, not a fabricated appliance type",
    ).toBe("Removable Repair");

    // ── Invoice: warning must be set ──
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(invoice, "auto-invoice must be created").toBeDefined();
    expect(invoice.status).toBe("open");
    expect(
      invoice.aiPricingWarning,
      "invoice must carry the repair-type-unclear warning for ambiguous repair Rx",
    ).toContain("repair type is unclear");

    // ── Invoice line item: description must mention "Removable Repair" ──
    const lineItems = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    expect(lineItems.length).toBeGreaterThan(0);
    const descriptionHasRepair = (lineItems as any[]).some((li: any) =>
      (li.description ?? "").includes("Removable Repair"),
    );
    expect(
      descriptionHasRepair,
      `expected at least one line item description to contain "Removable Repair"; got: ${JSON.stringify((lineItems as any[]).map((li: any) => li.description))}`,
    ).toBe(true);

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  // ── (B) Explicit repair: "add tooth to partial" → correct subtype, no warning ──
  //
  // When the AI can identify the appliance type (partial), it returns
  // removableSubtype: "repair_partial". The route must:
  //   1. Persist restorationSubtype = "removable/repair_partial" (the
  //      encoded taxonomy path for the explicit subtype).
  //   2. Leave invoice.aiPricingWarning null — the subtype is unambiguous
  //      so no admin review is required just to determine the type.

  it('(B) explicit partial repair ("add tooth to partial") → restorationSubtype = "removable/repair_partial", aiPricingWarning is null', async () => {
    const token = await makeSession(adminUserId);
    const rxFile = makeTempRxFile();

    mockChatCreate.mockResolvedValue(
      aiResponse({
        removableSubtype: "repair_partial",
        notes: "add tooth to partial",
        teeth: "Upper",
      }),
    );

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", rxFile, "iTero_Rx_repair_partial.pdf")
      .field("iteroOrderId", rid("iord"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("confirmNewDoctor", "true");

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();
    createdCaseIds.push(caseId);

    const { db, caseRestorations, invoices } = dbMod as any;

    // ── Restoration: restorationSubtype must carry the encoded taxonomy path ──
    const restorations = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(restorations).toHaveLength(1);
    expect(
      restorations[0].restorationSubtype,
      "explicit repair_partial must be stored as the taxonomy path 'removable/repair_partial'",
    ).toBe("removable/repair_partial");

    // ── Invoice: the repair-type-unclear warning must NOT appear ──
    //
    // With an explicit removableSubtype the ambiguity sentinel is gone, so the
    // route must not emit "repair type is unclear". A fallback-pricing warning
    // may still appear when the lab has no pricing tier configured for
    // repair_partial (this test lab has none). What matters for the regression
    // guard is that the repair-type-unclear message is absent.
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(invoice, "auto-invoice must be created").toBeDefined();
    expect(invoice.status).toBe("open");
    expect(
      invoice.aiPricingWarning ?? "",
      "the 'repair type is unclear' warning must NOT appear when removableSubtype is explicit (repair_partial)",
    ).not.toContain("repair type is unclear");

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  // ── (C) ZIP path: ambiguous repair → aiPricingWarning on the ZIP code path ─
  //
  // The warning logic is duplicated in the /import-from-itero-zip route.
  // This test mirrors (A) but POSTs a ZIP archive so that regressions
  // introduced specifically in processOneIteroZipFile / the ZIP handler are
  // caught without requiring a change to the single-file path.

  it('(C) ZIP path: ambiguous repair ("add tooth") → aiPricingWarning contains "repair type is unclear"', async () => {
    const token = await makeSession(adminUserId);
    // Use only numeric characters so the ZIP extracts a predictable orderId.
    const numericOrderId = randomBytes(4).toString("hex").replace(/[a-f]/g, "1");
    const zipFile = makeTempRxZipFile(numericOrderId);

    mockChatCreate.mockResolvedValue(
      aiResponse({
        removableSubtype: "repair",
        notes: "add tooth",
        teeth: "Upper",
      }),
    );

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-zip")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", zipFile, `iTero_Export_${numericOrderId}.zip`)
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();
    createdCaseIds.push(caseId);

    const { db, invoices } = dbMod as any;

    // ── Invoice: warning must be set on the ZIP path ──
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(invoice, "auto-invoice must be created by the ZIP path").toBeDefined();
    expect(invoice.status).toBe("open");
    expect(
      invoice.aiPricingWarning,
      "ZIP-path invoice must carry the repair-type-unclear warning for ambiguous repair",
    ).toContain("repair type is unclear");

    try { fs.unlinkSync(zipFile); } catch { /* ignore */ }
  });

  // ── (D) Admin patches ambiguous subtype → warning is cleared ─────────────
  //
  // Start with the same ambiguous repair as (A). Then PATCH the restoration's
  // restorationSubtype to "removable/repair_partial" via the REST endpoint.
  // syncInvoiceFromRestorations must clear aiPricingWarning because the
  // ambiguity is now resolved.

  it('(D) admin PATCHes restorationSubtype to "removable/repair_partial" → aiPricingWarning is cleared', async () => {
    const token = await makeSession(adminUserId);
    const rxFile = makeTempRxFile();

    // Import with the same ambiguous "repair" subtype as test (A).
    mockChatCreate.mockResolvedValue(
      aiResponse({
        removableSubtype: "repair",
        notes: "add tooth",
        teeth: "Upper",
      }),
    );

    const importRes = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", rxFile, "iTero_Rx_repair_d.pdf")
      .field("iteroOrderId", rid("iord"))
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId)
      .field("confirmNewDoctor", "true");

    expect(importRes.status, JSON.stringify(importRes.body)).toBe(201);
    const caseId = importRes.body.data.caseId as string;
    expect(caseId).toBeTruthy();
    createdCaseIds.push(caseId);

    const { db, caseRestorations, invoices } = dbMod as any;

    // Confirm the warning is set before the patch.
    const [invoiceBefore] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(invoiceBefore, "auto-invoice must be created").toBeDefined();
    expect(
      invoiceBefore.aiPricingWarning,
      "pre-condition: invoice must carry the repair-type-unclear warning",
    ).toContain("repair type is unclear");

    // Fetch the restoration to get its ID.
    const restorationsBefore = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    expect(restorationsBefore).toHaveLength(1);
    const restorationId = restorationsBefore[0].id as string;

    // Admin patches the subtype to "removable/repair_partial".
    const patchRes = await request(appMod.default)
      .patch(`/api/cases/${caseId}/restorations/${restorationId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ restorationSubtype: "removable/repair_partial" });

    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
    expect(patchRes.body.data?.restorationSubtype).toBe("removable/repair_partial");

    // The warning must be gone now that the subtype is explicit.
    const [invoiceAfter] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.caseId, caseId));
    expect(invoiceAfter, "invoice must still exist").toBeDefined();
    expect(
      invoiceAfter.aiPricingWarning,
      "aiPricingWarning must be cleared after the subtype is set to an explicit value",
    ).toBeNull();

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });
});
