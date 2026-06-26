/**
 * Task #2479 — Verify iTero imports link to the right practice END TO END.
 *
 * Unlike `cases-itero-practice-link.test.ts` (which exercises the matcher
 * `_findProviderOrgByPracticeName` in isolation), this suite drives a real
 * iTero Rx import through the HTTP route
 * `POST /api/cases/import-from-itero-rx` and asserts the *created case*
 * links to the existing brand-prefixed practice instead of staying on the
 * poller's default provider or spawning a duplicate provider org.
 *
 * The OpenAI SDK and PDF rasterizer are mocked so the suite is
 * deterministic and makes no network calls (same approach as
 * `cases-itero-ai-extraction.test.ts`). The mocked vision model returns a
 * brand-prefixed practice name exactly like a real iTero Lab-Review Rx
 * ("<brand> - <practice> [<code>]"); `doctorName` is intentionally omitted
 * so the route falls back to "Unknown Doctor" and SKIPS doctor-name
 * matching, isolating the practice-name linking path under test.
 *
 * Behaviour locked in:
 *  - Auto-link ON  + matching practice name  → case.providerOrganizationId
 *    becomes the existing practice (not the default), suggestion cleared,
 *    and NO new provider org is created.
 *  - Auto-link ON  + unrelated practice name → case stays on the default
 *    provider and records no suggestion (no mislink).
 *  - Auto-link OFF + matching practice name  → case stays on the default
 *    provider but records the existing practice as `suggestedProviderOrgId`
 *    for the desktop review banner (suggest, don't apply).
 *
 * Skipped when DATABASE_URL is not configured (matches the gated-integration
 * convention used across api-server).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const TEST_MEDIA_DIR = path.join(os.tmpdir(), "labtrax-test-media-itero-link");

// Hoisted spies so the vi.mock factories below can reference them.
const { mockChatCreate, mockConvertPdf, mockWriteCaseMediaToObjectStorage } =
  vi.hoisted(() => ({
    mockChatCreate: vi.fn(),
    mockConvertPdf: vi.fn(async () => [
      "data:image/jpeg;base64,ZmFrZS1yeC1pbWFnZQ==",
    ]),
    mockWriteCaseMediaToObjectStorage: vi.fn().mockResolvedValue(true),
  }));

// Deterministic, network-free OpenAI SDK. Only chat.completions.create is used
// by the iTero vision-extraction path.
vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: mockChatCreate } };
    files = {
      create: vi.fn(() => {
        throw new Error("files.create must not be used");
      }),
    };
    responses = {
      create: vi.fn(() => {
        throw new Error("responses.create must not be used");
      }),
    };
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-itero-link"),
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
const ITERO_AUTO_LINK_SETTING_PREFIX = "itero_auto_link_practice:";

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
            // doctorName intentionally omitted → "Unknown Doctor" →
            // doctor-name matching is skipped so the practice-name path runs.
            caseType: "Crown & Bridge",
            material: "Zirconia",
            shade: "A2",
            teeth: "8,9",
            isRush: false,
            notes: "Imported via iTero Lab Review.",
            ...overrides,
          }),
        },
      },
    ],
  };
}

maybe("Task #2479 iTero practice linking via import route (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  // The poller's default destination provider (what `providerOrganizationId`
  // is set to on every import) — the case should move OFF this when the
  // practice name matches a different existing practice.
  const defaultOrgId = rid("provDefault");
  // The existing, manually-created practice. iTero will extract a
  // brand-prefixed variant of this name.
  const southwoodOrgId = rid("provSouthwood");
  const adminUserId = rid("uadmin");
  let savedOpenAIKey: string | undefined;

  async function makeSession(userId: string): Promise<string> {
    const { db, userSessions } = dbMod as any;
    const sessionId = rid("sess");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = auth.signAccessToken(userId, sessionId);
    const hash = createHash("sha256").update(token).digest("hex");
    await db
      .insert(userSessions)
      .values({ id: sessionId, userId, tokenHash: hash, expiresAt });
    return token;
  }

  function makeTempRxFile(): string {
    const tmpDir = path.join(os.tmpdir(), "labtrax-test-rx-itero-link");
    fs.mkdirSync(tmpDir, { recursive: true });
    const p = path.join(tmpDir, `rx-${rid("f")}.pdf`);
    fs.writeFileSync(p, "%PDF-1.4 fake rx content for testing");
    return p;
  }

  async function setAutoLink(enabled: boolean): Promise<void> {
    const { db, systemSettings } = dbMod as any;
    const key = `${ITERO_AUTO_LINK_SETTING_PREFIX}${labOrgId}`;
    await db
      .insert(systemSettings)
      .values({ key, value: enabled ? "true" : "false" })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: enabled ? "true" : "false", updatedAt: new Date() },
      });
  }

  async function providerOrgCount(): Promise<number> {
    const { db, organizations } = dbMod as any;
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.parentLabOrganizationId, labOrgId));
    return rows.length;
  }

  async function importRx(opts: {
    token: string;
    practiceName?: string;
  }): Promise<request.Response> {
    const orderId = rid("order");
    const rxFile = makeTempRxFile();
    mockChatCreate.mockResolvedValue(
      aiExtractedRx(
        opts.practiceName === undefined
          ? {}
          : { practiceName: opts.practiceName },
      ),
    );
    try {
      return await request(appMod.default)
        .post("/api/cases/import-from-itero-rx")
        .set("Authorization", `Bearer ${opts.token}`)
        .attach("file", rxFile, "iTero_Rx_123.pdf")
        .field("iteroOrderId", orderId)
        .field("labOrganizationId", labOrgId)
        .field("providerOrganizationId", defaultOrgId);
    } finally {
      try {
        fs.unlinkSync(rxFile);
      } catch {
        /* ignore */
      }
    }
  }

  beforeAll(async () => {
    fs.mkdirSync(TEST_MEDIA_DIR, { recursive: true });
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-itero-link";
    // The AI client is gated on this key. The mocked SDK makes no real calls,
    // so a placeholder is enough to take the AI-extraction branch.
    savedOpenAIKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key-itero-link";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db
      .insert(users)
      .values([{ id: adminUserId, username: `adm_${adminUserId}`, password: "testpass" }]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "iTero Link Test Lab" },
      {
        id: defaultOrgId,
        type: "provider",
        name: "Unassigned iTero Imports",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: southwoodOrgId,
        type: "provider",
        name: "Family Dentistry at SouthWood",
        parentLabOrganizationId: labOrgId,
      },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: adminUserId,
        role: "admin",
        status: "active",
      },
    ]);
  });

  beforeEach(() => {
    mockChatCreate.mockReset();
    mockChatCreate.mockResolvedValue(aiExtractedRx());
    mockConvertPdf.mockClear();
  });

  afterEach(async () => {
    if (!SHOULD_RUN) return;
    // Wipe per-test case rows so each test starts clean. Provider orgs and
    // the lab/user/membership survive across tests (set up once in beforeAll).
    const {
      db,
      cases,
      caseEvents,
      iteroImportedOrders,
      invoices,
      auditLogs,
    } = dbMod as any;
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, labOrgId));
    await db
      .delete(caseEvents)
      .where(eq(caseEvents.actorOrganizationId, labOrgId));
    await db
      .delete(iteroImportedOrders)
      .where(eq(iteroImportedOrders.labOrganizationId, labOrgId));
    await db
      .delete(invoices)
      .where(inArray(invoices.labOrganizationId, [labOrgId, defaultOrgId, southwoodOrgId]));
    await db.delete(cases).where(eq(cases.labOrganizationId, labOrgId));
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
      organizationMemberships,
      userSessions,
      systemSettings,
    } = dbMod as any;
    await db
      .delete(systemSettings)
      .where(eq(systemSettings.key, `${ITERO_AUTO_LINK_SETTING_PREFIX}${labOrgId}`));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, adminUserId));
    await db.delete(userSessions).where(eq(userSessions.userId, adminUserId));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [labOrgId, defaultOrgId, southwoodOrgId]));
    await db.delete(users).where(eq(users.id, adminUserId));
  });

  it("auto-links a brand-prefixed iTero practice name to the existing practice (not the default, no duplicate)", async () => {
    await setAutoLink(true);
    const before = await providerOrgCount();
    const token = await makeSession(adminUserId);

    const r = await importRx({
      token,
      practiceName: "Heartland Dental - Family Dentistry at SouthWood [565]",
    });

    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    const caseId = r.body.data.caseId as string;
    expect(caseId).toBeTruthy();
    expect(mockChatCreate).toHaveBeenCalled();

    const { db, cases } = dbMod as any;
    const [caseRow] = await db
      .select({
        providerOrganizationId: cases.providerOrganizationId,
        suggestedProviderOrgId: cases.suggestedProviderOrgId,
        doctorName: cases.doctorName,
        aiImportSource: cases.aiImportSource,
      })
      .from(cases)
      .where(eq(cases.id, caseId));

    // The case linked to the EXISTING practice, not the poller default.
    expect(caseRow.providerOrganizationId).toBe(southwoodOrgId);
    expect(caseRow.providerOrganizationId).not.toBe(defaultOrgId);
    // Suggestion is cleared once auto-applied (no stale review prompt).
    expect(caseRow.suggestedProviderOrgId).toBeNull();
    // Confirms the doctor path was skipped (isolating the practice path).
    expect(caseRow.doctorName).toBe("Unknown Doctor");
    expect(caseRow.aiImportSource).toBe("itero");

    // No duplicate provider org was spawned by the import.
    expect(await providerOrgCount()).toBe(before);
  });

  it("does not mislink an unrelated extracted practice name (stays on the default provider)", async () => {
    await setAutoLink(true);
    const before = await providerOrgCount();
    const token = await makeSession(adminUserId);

    const r = await importRx({
      token,
      practiceName: "Bright Valley Pediatric Dental [902]",
    });

    expect(r.status).toBe(201);
    const caseId = r.body.data.caseId as string;

    const { db, cases } = dbMod as any;
    const [caseRow] = await db
      .select({
        providerOrganizationId: cases.providerOrganizationId,
        suggestedProviderOrgId: cases.suggestedProviderOrgId,
      })
      .from(cases)
      .where(eq(cases.id, caseId));

    // No match → the case keeps the poller's default provider and records
    // no practice suggestion. It must NOT be linked to SouthWood.
    expect(caseRow.providerOrganizationId).toBe(defaultOrgId);
    expect(caseRow.providerOrganizationId).not.toBe(southwoodOrgId);
    expect(caseRow.suggestedProviderOrgId).toBeNull();

    expect(await providerOrgCount()).toBe(before);
  });

  it("suggests (does not apply) the matched practice when the lab has auto-link OFF", async () => {
    await setAutoLink(false);
    const token = await makeSession(adminUserId);

    const r = await importRx({
      token,
      practiceName: "Heartland Dental - Family Dentistry at SouthWood [565]",
    });

    expect(r.status).toBe(201);
    const caseId = r.body.data.caseId as string;

    const { db, cases } = dbMod as any;
    const [caseRow] = await db
      .select({
        providerOrganizationId: cases.providerOrganizationId,
        suggestedProviderOrgId: cases.suggestedProviderOrgId,
      })
      .from(cases)
      .where(eq(cases.id, caseId));

    // Toggle off → the effective provider stays the default, but the match is
    // surfaced as a suggestion for the desktop review banner.
    expect(caseRow.providerOrganizationId).toBe(defaultOrgId);
    expect(caseRow.suggestedProviderOrgId).toBe(southwoodOrgId);
  });
});
