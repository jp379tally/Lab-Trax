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
      .field("providerOrganizationId", providerOrgId);

    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();

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
      })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(caseRow.shade).toBe("A2");
    expect(caseRow.rxNotes).toContain("Match adjacent shade");
    expect(caseRow.dueDate).toBeTruthy();
    expect(caseRow.patientFirstName).toBe("Ada");
    expect(caseRow.doctorName).toBe("Dr. Babbage");
    expect(caseRow.needsAiReview).toBe(true);

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
    expect(invoice.status).toBe("draft");
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
});
