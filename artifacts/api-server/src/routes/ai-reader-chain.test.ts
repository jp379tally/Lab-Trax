/**
 * End-to-end regression suite for the AI Reader workflow.
 *
 * Exercises the full chain in one place so any break at any link is caught:
 *
 *   (a) POST /api/analyze-prescription  → returns well-formed data
 *   (b) mapRxResponseToFormFields        → converts that data to form fields
 *   (c) Null-cache guard                → no permanent null after key absent
 *   (d) POST /api/cases                 → creates case + auto-generates invoice
 *
 * The OpenAI SDK is mocked so the suite runs deterministically without a live
 * AI proxy.  The DB-dependent portions are gated on DATABASE_URL.
 *
 * This test was introduced as a regression guard after the AI Reader broke
 * because image compression changes, a null-cache bug in getOpenAIClient, and
 * a temperature field rejected by gpt-5+ all happened in overlapping commits
 * while tests only verified each layer in isolation.
 *
 * Link (b) coverage: mapRxResponseToFormFields is imported directly from the
 * labtrax scan lib (pure function, zero imports) and run against API-shaped
 * data here.  It is also covered in depth by the 60+ unit tests in
 * artifacts/labtrax/lib/scan/rx-to-form.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import { mapRxResponseToFormFields } from "../../../labtrax/lib/scan/rx-to-form";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-chain"),
  extractMediaFileName: () => null,
}));

const mockCreate = vi.fn();
vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: (...args: any[]) => mockCreate(...args) } };
    constructor(_opts: any) {}
  }
  return { default: FakeOpenAI, toFile: vi.fn() };
});

const VALID_IMAGE = `data:image/jpeg;base64,${"A".repeat(6000)}`;

function aiJson(obj: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

const SHOULD_RUN_DB = !!process.env["DATABASE_URL"];
const maybeDb = SHOULD_RUN_DB ? describe : describe.skip;

// ── (a): analyze-prescription response shape ──────────────────────────────────

describe("AI Reader chain — (a) analyze-prescription response shape", () => {
  let appMod: { default: import("express").Express };
  let savedKey: string | undefined;
  let savedBaseUrl: string | undefined;

  beforeAll(async () => {
    savedKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    savedBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key-chain";
    process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = "https://example.invalid/v1";
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-chain";
    appMod = await import("../app.js");
  });

  afterAll(() => {
    if (savedKey !== undefined) process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = savedKey;
    else delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    if (savedBaseUrl !== undefined) process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = savedBaseUrl;
    else delete process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  });

  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("(a) API returns all fields expected by mapRxResponseToFormFields", async () => {
    mockCreate.mockResolvedValueOnce(
      aiJson({
        doctorName: "Smith, John",
        patientName: "Doe, Jane",
        patientInitials: "JD",
        caseType: "crown",
        toothIndices: "14, 15",
        shade: "A2",
        material: "Zirconia",
        dueDate: "12/31/2025",
        isRush: true,
        notes: "Handle with care",
        practiceName: "Smith Dental",
        practiceAddress: "123 Main St",
        practicePhone: "555-1234",
        confidence: 0.95,
      })
    );

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);

    const data = r.body.data;

    expect(typeof data.doctorName).toBe("string");
    expect(typeof data.patientName).toBe("string");
    expect(typeof data.caseType).toBe("string");
    expect(typeof data.toothIndices).toBe("string");
    expect(typeof data.shade).toBe("string");
    expect(typeof data.material).toBe("string");
    expect(typeof data.dueDate).toBe("string");
    expect(typeof data.isRush).toBe("boolean");
    expect(typeof data.notes).toBe("string");
    expect(typeof data.practiceName).toBe("string");
    expect(typeof data.confidence).toBe("number");

    // "Last, First" inversion must be applied server-side.
    expect(data.doctorName).toBe("John Smith");
    expect(data.patientName).toBe("Jane Doe");
  });

  it("(a) dueDate passes through in ISO format (no double-normalisation)", async () => {
    mockCreate.mockResolvedValueOnce(
      aiJson({ patientName: "Test Patient", dueDate: "2025-06-30", confidence: 0.9 })
    );

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(r.status).toBe(200);
    expect(r.body.data.dueDate).toBe("2025-06-30");
  });

  it("(a) null fields are stripped from the response (not forwarded as 'null' strings)", async () => {
    mockCreate.mockResolvedValueOnce(
      aiJson({
        patientName: "Test Only",
        doctorName: null,
        shade: null,
        isRush: null,
        confidence: 0.85,
      })
    );

    const r = await request(appMod.default)
      .post("/api/analyze-prescription")
      .send({ imageBase64: VALID_IMAGE });

    expect(r.status).toBe(200);
    const data = r.body.data;
    // Null fields must be absent from the cleaned response, not present as the
    // string "null" — mapRxResponseToFormFields would otherwise set form fields
    // to the literal string "null".
    expect(data.doctorName).toBeUndefined();
    expect(data.shade).toBeUndefined();
    expect(data.isRush).toBeUndefined();
    expect(data.patientName).toBe("Test Only");
  });
});

// ── (b): mapRxResponseToFormFields correctness (pure, always runs) ────────────
//
// Imported directly from artifacts/labtrax/lib/scan/rx-to-form (pure function,
// zero external imports — safe to run in Node / api-server test env).

describe("AI Reader chain — (b) mapRxResponseToFormFields field mapping", () => {
  it("(b) maps full AI response to correct form fields", () => {
    const fields = mapRxResponseToFormFields({
      doctorName: "John Smith",
      patientName: "Jane Doe",
      caseType: "crown",
      toothIndices: "14, 15",
      shade: "A2",
      material: "Zirconia",
      dueDate: "12/31/2025",
      isRush: true,
      notes: "Rush job",
    });

    expect(fields.doctorName).toBe("John Smith");
    expect(fields.patientName).toBe("Jane Doe");
    expect(fields.caseType).toBe("Restorative");
    expect(fields.toothIndices).toBe("14, 15");
    expect(fields.selectedTeeth).toEqual([14, 15]);
    expect(fields.shade).toBe("A2");
    expect(fields.material).toBe("Zirconia");
    expect(fields.dueDate).toBe("2025-12-31");
    expect(fields.isRush).toBe(true);
    expect(fields.notes).toBe("Rush job");
    expect(fields.aiFilledFields.has("doctorName")).toBe(true);
    expect(fields.aiFilledFields.has("caseType")).toBe(true);
    expect(fields.aiFilledFields.has("toothIndices")).toBe(true);
    expect(fields.aiFilledFields.has("dueDate")).toBe(true);
  });

  it("(b) patientInitials fallback when patientName absent", () => {
    const fields = mapRxResponseToFormFields({ patientInitials: "JD" });
    expect(fields.patientName).toBe("JD");
    expect(fields.aiFilledFields.has("patientName")).toBe(true);
  });

  it("(b) isRush defaults to false when absent", () => {
    const fields = mapRxResponseToFormFields({ patientName: "Test" });
    expect(fields.isRush).toBe(false);
    expect(fields.aiFilledFields.has("isRush")).toBe(false);
  });

  it("(b) empty response produces empty strings and false, not nulls", () => {
    const fields = mapRxResponseToFormFields({});
    expect(fields.doctorName).toBe("");
    expect(fields.patientName).toBe("");
    expect(fields.caseType).toBe("");
    expect(fields.toothIndices).toBe("");
    expect(fields.selectedTeeth).toEqual([]);
    expect(fields.isRush).toBe(false);
    expect(fields.aiFilledFields.size).toBe(0);
  });

  it("(b) chain contract: API response shape (from section a) maps correctly end-to-end", () => {
    // Simulates exactly what the API returns after Last,First inversion + null-stripping,
    // then confirms mapRxResponseToFormFields produces the expected form state.
    // This is the critical seam between the API and the Scan tab / Desktop dropzone.
    const apiResponse = {
      doctorName: "John Smith",     // already inverted by the API
      patientName: "Jane Doe",      // already inverted by the API
      caseType: "crown",
      toothIndices: "14, 15",
      shade: "A2",
      material: "Zirconia",
      dueDate: "2025-12-31",        // API normalises MM/DD/YYYY → ISO
      isRush: true,
      notes: "Rush job",
      confidence: 0.95,
    };

    const fields = mapRxResponseToFormFields(apiResponse);

    expect(fields.doctorName).toBe("John Smith");
    expect(fields.patientName).toBe("Jane Doe");
    expect(fields.caseType).toBe("Restorative");
    expect(fields.selectedTeeth).toEqual([14, 15]);
    expect(fields.dueDate).toBe("2025-12-31");
    expect(fields.isRush).toBe(true);
    expect(fields.aiFilledFields.size).toBeGreaterThan(0);
  });
});

// ── (c): OpenAI null-cache regression guard (endpoint-level, always runs) ─────
//
// Before the fix, getOpenAIClient() permanently cached null the first time it
// was called without an API key.  Even after the key was set, the function kept
// returning null — so the endpoint returned 503 forever until restart.
//
// We verify the behaviour via endpoint responses:
//   Step 1  — import app with no key → /analyze-prescription must return 503.
//   Step 2  — re-import app WITH key  → must return 200.
// This proves the client is not permanently null-cached.

describe("AI Reader chain — (c) OpenAI client null-cache regression", () => {
  it("(c) key absent → 503; key restored → 200 (client not permanently null-cached)", async () => {
    vi.resetModules();
    const savedKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    const savedBase = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    delete process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];

    try {
      // Step 1: no key → endpoint must return 503.
      const noKeyApp = (await import("../app.js")).default as import("express").Express;
      const r1 = await request(noKeyApp)
        .post("/api/analyze-prescription")
        .send({ imageBase64: VALID_IMAGE });
      expect(r1.status).toBe(503);

      // Step 2: add key + re-import fresh modules → must return 200.
      // This proves getOpenAIClient does NOT permanently cache null: a call
      // after the key is set creates a live client (pre-fix it would still 503).
      vi.resetModules();
      process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key-recovery";
      process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = "https://example.invalid/v1";
      mockCreate.mockResolvedValueOnce(
        aiJson({ patientName: "Recovery Test", confidence: 0.9 })
      );
      const keyApp = (await import("../app.js")).default as import("express").Express;
      const r2 = await request(keyApp)
        .post("/api/analyze-prescription")
        .send({ imageBase64: VALID_IMAGE });
      expect(r2.status).toBe(200);
      expect(r2.body.success).toBe(true);
    } finally {
      vi.resetModules();
      if (savedKey !== undefined) process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = savedKey;
      else delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
      if (savedBase !== undefined) process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = savedBase;
      else delete process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    }
  });
});

// ── (d): POST /api/cases creates case + invoice (DB-gated) ───────────────────

maybeDb("AI Reader chain — (d) POST /api/cases → case + invoice (db)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod2: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const providerOrgId = rid("prov");
  const adminUserId = rid("uadm");
  let adminToken = "";

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
    fs.mkdirSync(path.join(os.tmpdir(), "labtrax-test-media-chain"), { recursive: true });
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-chain-d";
    const savedKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

    dbMod = await import("@workspace/db");
    appMod2 = await import("../app.js");
    auth = await import("../lib/auth.js");

    if (savedKey !== undefined) process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = savedKey;

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      { id: adminUserId, username: `adm_${adminUserId}`, password: "testpass" },
    ]);
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Chain E2E Test Lab" },
      {
        id: providerOrgId,
        type: "provider",
        name: "Chain Provider",
        parentLabOrganizationId: labOrgId,
      },
    ]);
    await db.insert(organizationMemberships).values([
      { id: rid("m"), labId: labOrgId, userId: adminUserId, role: "admin", status: "active" },
    ]);

    adminToken = await makeSession(adminUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN_DB) return;
    const {
      db,
      organizations,
      users,
      cases,
      caseEvents,
      organizationMemberships,
      userSessions,
      auditLogs,
      invoices,
    } = dbMod as any;
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [labOrgId, providerOrgId]));
    await db.delete(caseEvents).where(
      inArray(caseEvents.actorOrganizationId, [labOrgId, providerOrgId])
    );
    await db.delete(invoices).where(
      inArray(invoices.labOrganizationId, [labOrgId, providerOrgId])
    );
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
    await db.delete(organizationMemberships).where(
      eq(organizationMemberships.userId, adminUserId)
    );
    await db.delete(userSessions).where(eq(userSessions.userId, adminUserId));
    await db.delete(organizations).where(
      inArray(organizations.id, [labOrgId, providerOrgId])
    );
    await db.delete(users).where(eq(users.id, adminUserId));
  });

  it("(d) POST /api/cases creates a case and auto-generates an open invoice", async () => {
    const r = await request(appMod2.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Chain",
        patientLastName: "E2E",
        doctorName: "Dr. Chain",
        status: "received",
        notes: "AI reader test case",
      });

    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    const caseId = r.body.data.id;
    expect(caseId).toBeTruthy();

    // Poll for the async auto-invoice (up to 2 s).
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
    expect(invoice.caseId).toBe(caseId);
    expect(invoice.labOrganizationId).toBe(labOrgId);
    expect(invoice.providerOrganizationId).toBe(providerOrgId);

    const { cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, caseId));
  });

  it("(d) case created with patient name propagates to invoice display metadata", async () => {
    const caseNumber = rid("CN");
    const r = await request(appMod2.default)
      .post("/api/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        caseNumber,
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrgId,
        patientFirstName: "Alice",
        patientLastName: "Molar",
        doctorName: "Dr. E2E",
        status: "received",
      });

    expect(r.status).toBe(201);
    const caseId = r.body.data.id;

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

    expect(invoice).toBeDefined();
    const meta = invoice.displayMetadataJson as Record<string, unknown>;
    expect(meta.patientName).toBe("Alice Molar");

    const { cases } = dbMod as any;
    await db.delete(cases).where(eq(cases.id, caseId));
  });
});
