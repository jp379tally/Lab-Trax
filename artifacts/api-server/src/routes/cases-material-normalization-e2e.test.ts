/**
 * End-to-end verification that the material-naming rules
 * (`normalizeMaterialName`) are actually applied on every AI Rx ingest path,
 * not just unit-tested in isolation (material-mapping.test.ts).
 *
 * The unit tests prove normalizeMaterialName() maps synonyms correctly, but
 * they cannot catch a regression where a prompt change or refactor silently
 * DROPS the normalize call from an ingest handler — the unit test still passes
 * while production stores raw "BruxZ" / "Ceramic: Zirconia" / "Emax" and the
 * invoice price diverges from the lab-slip material.
 *
 * This suite feeds representative *un-canonicalized* Rx text through the real
 * route handlers (OpenAI fully mocked) and asserts that the STORED material is
 * canonical AND that the resolved price key is correct. It deliberately covers
 * all FOUR ingest call sites so removing any single normalize call fails the
 * build:
 *   1. POST /api/cases/import-from-itero-rx        (single Rx PDF, cases.ts)
 *   2. POST /api/cases/import-from-itero-zip        (single ZIP, cases.ts)
 *   3. POST /api/cases/import-from-itero-zip-batch  (processOneIteroZipFile, cases.ts)
 *   4. POST /api/analyze-prescription               (manual/camera, labtrax-routes.ts)
 *
 * Call sites 1–3 are DB-backed and gated on DATABASE_URL. Call site 4 is
 * stateless and always runs.
 *
 * The price key is verified indirectly but precisely: the seeded "Standard"
 * tier gives each crown key a DISTINCT price, so the stored unitPrice uniquely
 * identifies which price key resolveServerPriceWithSource() picked — proving
 * the normalized material drove materialToPriceKey() to the right key.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import AdmZip from "adm-zip";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const TEST_MEDIA_DIR = path.join(os.tmpdir(), "labtrax-test-media-material-norm");

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

vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: mockChatCreate } };
    files = { create: mockFilesCreate };
    responses = { create: mockResponsesCreate };
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
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-media-material-norm"),
  extractMediaFileName: () => null,
}));
vi.mock("../lib/case-media-object-storage.js", () => ({
  writeCaseMediaToObjectStorage: mockWriteCaseMediaToObjectStorage,
  openCaseMediaObjectStream: vi.fn().mockResolvedValue(null),
  caseMediaObjectStorageAvailable: vi.fn().mockReturnValue(true),
  deleteCaseMediaFromObjectStorage: vi.fn().mockResolvedValue(false),
}));

// Distinct per-key prices so the stored unitPrice uniquely identifies which
// price key resolved — i.e. proves the normalized material drove pricing.
const ZIRCONIA_PRICE = 150;
const EMAX_PRICE = 222;
const PFM_PRICE = 333;

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Build the JSON the mocked vision model "extracts" from the Rx — caller
 *  supplies the raw (un-canonicalized) material under test. One tooth keeps
 *  the assertions on a single restoration. */
function aiExtractedRx(material: string, overrides: Record<string, unknown> = {}) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            patientFirstName: "Ada",
            patientLastName: "Lovelace",
            doctorName: "Dr. Babbage",
            caseType: "Crown",
            material,
            shade: "A2",
            teeth: "8",
            dueDate: "2026-07-01",
            isRush: false,
            notes: "Match adjacent shade carefully.",
            ...overrides,
          }),
        },
      },
    ],
  };
}

function makeIteroZipBuffer(orderDigits: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    `iTero_Rx_${orderDigits}.pdf`,
    Buffer.from("%PDF-1.4 fake rx content for testing"),
  );
  return zip.toBuffer();
}

// ─────────────────────────────────────────────────────────────────────────
// Call sites 1–3: DB-backed iTero ingest paths.
// ─────────────────────────────────────────────────────────────────────────
maybe("material normalization on iTero ingest paths (db integration)", () => {
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
    const tmpDir = path.join(os.tmpdir(), "labtrax-test-rx-material-norm");
    fs.mkdirSync(tmpDir, { recursive: true });
    const p = path.join(tmpDir, `rx-${rid("f")}.pdf`);
    fs.writeFileSync(p, "%PDF-1.4 fake rx content for testing");
    return p;
  }

  async function readCaseRestoration(caseId: string) {
    const { db, cases, caseRestorations } = dbMod as any;
    const [caseRow] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(caseRow).toBeDefined();
    const [rest] = await db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId));
    return rest;
  }

  beforeAll(async () => {
    fs.mkdirSync(TEST_MEDIA_DIR, { recursive: true });
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-material-norm";
    savedOpenAIKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key-material-norm";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships, pricingTiers } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "testpass" },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Material Norm Test Lab" },
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

    // Distinct price per crown key so unitPrice uniquely identifies the key.
    await db.insert(pricingTiers).values({
      id: rid("tier"),
      labOrganizationId: labOrgId,
      name: "Standard",
      pricesJson: {
        zirconia_crown: ZIRCONIA_PRICE,
        emax_crown: EMAX_PRICE,
        pfm_crown: PFM_PRICE,
      },
    });
  });

  beforeEach(() => {
    mockChatCreate.mockReset();
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

  // ── Call site 1: single Rx PDF import ──────────────────────────────────
  it("canonicalizes the material on /import-from-itero-rx (Ceramic: Zirconia → Zirconia, zirconia_crown)", async () => {
    const adminToken = await makeSession(adminUserId);
    const orderId = rid("order");
    const rxFile = makeTempRxFile();
    mockChatCreate.mockResolvedValue(aiExtractedRx("Ceramic: Zirconia"));

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-rx")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", rxFile, "iTero_Rx_555.pdf")
      .field("iteroOrderId", orderId)
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);

    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();

    const rest = await readCaseRestoration(caseId);
    expect(rest.material).toBe("Zirconia");
    expect(rest.priceKey).toBe("zirconia_crown");
    expect(Number(rest.unitPrice)).toBe(ZIRCONIA_PRICE);

    try { fs.unlinkSync(rxFile); } catch { /* ignore */ }
  });

  // ── Call site 2: single ZIP import ─────────────────────────────────────
  it("canonicalizes the material on /import-from-itero-zip (Emax → Lithium Disilicate, emax_crown)", async () => {
    const adminToken = await makeSession(adminUserId);
    const zipBuf = makeIteroZipBuffer(`80${Math.floor(Math.random() * 1e6)}`);
    mockChatCreate.mockResolvedValue(aiExtractedRx("Emax"));

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

    const rest = await readCaseRestoration(caseId);
    expect(rest.material).toBe("Lithium Disilicate");
    expect(rest.priceKey).toBe("emax_crown");
    expect(Number(rest.unitPrice)).toBe(EMAX_PRICE);
  });

  // ── Call site 3: batch ZIP import (processOneIteroZipFile) ──────────────
  it("canonicalizes the material on /import-from-itero-zip-batch (BruxZ → Zirconia, PFM → PFM)", async () => {
    const adminToken = await makeSession(adminUserId);
    const zipBrux = makeIteroZipBuffer(`81${Math.floor(Math.random() * 1e6)}`);
    const zipPfm = makeIteroZipBuffer(`82${Math.floor(Math.random() * 1e6)}`);

    // Each ZIP is processed independently; return the matching material per
    // call so both batch entries are normalized.
    mockChatCreate
      .mockResolvedValueOnce(aiExtractedRx("BruxZ"))
      .mockResolvedValueOnce(aiExtractedRx("PFM"));

    const r = await request(appMod.default)
      .post("/api/cases/import-from-itero-zip-batch")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("files[]", zipBrux, "iTero_Export_brux.zip")
      .attach("files[]", zipPfm, "iTero_Export_pfm.zip")
      .field("labOrganizationId", labOrgId)
      .field("providerOrganizationId", providerOrgId);

    expect(r.status).toBe(207);
    expect(r.body.ok).toBe(true);
    const results = r.body.data.results as Array<{
      filename: string;
      status: string;
      caseId?: string;
    }>;
    expect(results).toHaveLength(2);
    for (const res of results) expect(res.status).toBe("created");

    const bruxResult = results.find((x) => x.filename === "iTero_Export_brux.zip");
    const pfmResult = results.find((x) => x.filename === "iTero_Export_pfm.zip");
    expect(bruxResult?.caseId).toBeTruthy();
    expect(pfmResult?.caseId).toBeTruthy();

    const bruxRest = await readCaseRestoration(bruxResult!.caseId!);
    expect(bruxRest.material).toBe("Zirconia");
    expect(bruxRest.priceKey).toBe("zirconia_crown");
    expect(Number(bruxRest.unitPrice)).toBe(ZIRCONIA_PRICE);

    const pfmRest = await readCaseRestoration(pfmResult!.caseId!);
    expect(pfmRest.material).toBe("PFM");
    expect(pfmRest.priceKey).toBe("pfm_crown");
    expect(Number(pfmRest.unitPrice)).toBe(PFM_PRICE);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Call site 4: stateless manual/camera analyze-prescription path.
// Runs unconditionally (no database needed).
// ─────────────────────────────────────────────────────────────────────────
describe("material normalization on POST /api/analyze-prescription", () => {
  let appMod: { default: import("express").Express };
  let savedKey: string | undefined;
  let savedBaseUrl: string | undefined;

  // A non-HEIC, non-PDF JPEG data URI whose raw base64 clears the size floor.
  const VALID_IMAGE = `data:image/jpeg;base64,${"A".repeat(6000)}`;

  function aiJson(obj: Record<string, unknown>) {
    return { choices: [{ message: { content: JSON.stringify(obj) } }] };
  }

  beforeAll(async () => {
    savedKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    savedBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key-material-norm";
    process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = "https://example.invalid/v1";
    process.env["JWT_SECRET"] = process.env["JWT_SECRET"] ?? "labtrax-test-secret-material-norm";
    appMod = await import("../app.js");
  });

  afterAll(() => {
    if (savedKey !== undefined) process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = savedKey;
    else delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    if (savedBaseUrl !== undefined) process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = savedBaseUrl;
    else delete process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  });

  beforeEach(() => {
    mockChatCreate.mockReset();
  });

  it.each([
    ["Ceramic: Zirconia", "Zirconia"],
    ["BruxZ", "Zirconia"],
    ["Emax", "Lithium Disilicate"],
    ["porcelain fused to metal", "PFM"],
  ])("normalizes %s → %s in the returned data", async (raw, canonical) => {
    mockChatCreate.mockResolvedValueOnce(
      aiJson({ patientName: "Jane Doe", caseType: "Crown", material: raw, confidence: 0.9 })
    );

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.material).toBe(canonical);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it("leaves a non-synonym material unchanged (Gold)", async () => {
    mockChatCreate.mockResolvedValueOnce(
      aiJson({ patientName: "Jane Doe", caseType: "Crown", material: "Gold", confidence: 0.9 })
    );

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(r.status).toBe(200);
    expect(r.body.data.material).toBe("Gold");
  });
});
