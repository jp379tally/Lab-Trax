/**
 * Integration tests: provider access control in the AI chat endpoint.
 *
 * Skipped when DATABASE_URL is not configured.  All inserted rows are removed
 * in afterAll so the suite is safe to run against a shared dev DB.
 *
 * Coverage:
 *  - POST /api/ai-chat as a provider with caseId from their own practice:
 *    the focused-case context block IS included in the system prompt.
 *  - POST /api/ai-chat as a provider with caseId from a different practice:
 *    buildSingleCaseContext returns "" → the focused-case context block is
 *    absent from the system prompt; patient details do not leak.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";

// ── OpenAI mock ──────────────────────────────────────────────────────────────
// vi.hoisted lets us share a spy between the hoisted vi.mock block and the
// test body.  The spy captures every call to chat.completions.create so we
// can inspect the system prompt that was assembled by the route handler.
//
// Vitest 4 requires the factory to return a proper constructor function or
// class — plain arrow functions trigger a warning and may not work.
const { mockCompletionsCreate } = vi.hoisted(() => {
  const mockCompletionsCreate = vi.fn().mockResolvedValue({
    choices: [{ message: { content: "Test AI response from mock." } }],
  });
  return { mockCompletionsCreate };
});

vi.mock("openai", () => {
  const create = mockCompletionsCreate;
  function OpenAI(this: any) {
    this.chat = { completions: { create } };
  }
  return { default: OpenAI };
});

// ── Standard background-job mocks (same pattern as other route tests) ────────
vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-ai-chat-access"),
  extractMediaFileName: () => null,
}));

// ── Gate ─────────────────────────────────────────────────────────────────────
const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("AI chat provider access control (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  // Two independent provider orgs
  const providerOrg1Id = rid("prov1");
  const providerOrg2Id = rid("prov2");

  // A shared lab org so memberships have a valid parent (optional but
  // mirrors real data — provider orgs often reference a lab).
  const labOrgId = rid("lab");

  // Provider user who is a member of providerOrg1 only
  const providerUserId = rid("uprov");

  // IDs for the cases created in beforeAll; assigned once the cases are
  // inserted and used across tests.
  let ownedCaseId: string;
  let foreignCaseId: string;

  let providerToken: string;

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

  beforeAll(async () => {
    // Ensure the AI client won't return null — the route returns 503 when
    // AI_INTEGRATIONS_OPENAI_API_KEY is absent.  We set it here (before the
    // module is imported for the first time in this worker) so getAiClient()
    // picks it up and uses the mocked OpenAI constructor defined above.
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key-for-mock";
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-ai-chat-access";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships, cases } =
      dbMod as any;

    // Insert users
    await db.insert(users).values([
      {
        id: providerUserId,
        username: `prov_${providerUserId}`,
        password: "testpass",
        userType: "provider",
      },
    ]);

    // Insert orgs: one lab (parent) + two independent provider orgs
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "AI Chat Access Test Lab" },
      {
        id: providerOrg1Id,
        type: "provider",
        name: "Practice Alpha",
        parentLabOrganizationId: labOrgId,
      },
      {
        id: providerOrg2Id,
        type: "provider",
        name: "Practice Beta",
        parentLabOrganizationId: labOrgId,
      },
    ]);

    // Provider user is a member of providerOrg1 only (not providerOrg2)
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: providerOrg1Id,
        userId: providerUserId,
        role: "admin",
        status: "active",
      },
    ]);

    // A case the provider owns (providerOrg1)
    ownedCaseId = rid("c");
    // A case belonging to the foreign practice (providerOrg2)
    foreignCaseId = rid("c");

    await db.insert(cases).values([
      {
        id: ownedCaseId,
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrg1Id,
        patientFirstName: "OwnedPatientFirst",
        patientLastName: "OwnedPatientLast",
        doctorName: "Dr. Owned",
        status: "received",
        createdByUserId: providerUserId,
      },
      {
        id: foreignCaseId,
        caseNumber: rid("CN"),
        labOrganizationId: labOrgId,
        providerOrganizationId: providerOrg2Id,
        patientFirstName: "ForeignPatientFirst",
        patientLastName: "ForeignPatientLast",
        doctorName: "Dr. Foreign",
        status: "received",
        createdByUserId: providerUserId,
      },
    ]);

    providerToken = await makeSession(providerUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
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
      aiChatHistory,
    } = dbMod as any;

    // Clean in dependency order to avoid FK constraint violations.
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.organizationId, [labOrgId, providerOrg1Id, providerOrg2Id]));
    await db
      .delete(caseEvents)
      .where(
        inArray(caseEvents.actorOrganizationId, [
          labOrgId,
          providerOrg1Id,
          providerOrg2Id,
        ]),
      );
    await db.delete(invoices).where(
      inArray(invoices.labOrganizationId, [labOrgId, providerOrg1Id, providerOrg2Id]),
    );
    await db
      .delete(cases)
      .where(inArray(cases.id, [ownedCaseId, foreignCaseId]));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [providerUserId]));
    await db
      .delete(aiChatHistory)
      .where(eq(aiChatHistory.userId, providerUserId));
    await db
      .delete(userSessions)
      .where(inArray(userSessions.userId, [providerUserId]));
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [labOrgId, providerOrg1Id, providerOrg2Id]),
      );
    await db
      .delete(users)
      .where(inArray(users.id, [providerUserId]));
  });

  // ── Helper ───────────────────────────────────────────────────────────────

  /** POST /api/ai-chat asking about a specific case; returns the system prompt
   * that was passed to the (mocked) OpenAI completion call. */
  async function postAiChat(
    token: string,
    caseId: string,
  ): Promise<{ status: number; systemPrompt: string | null }> {
    mockCompletionsCreate.mockClear();
    const r = await request(appMod.default)
      .post("/api/ai-chat")
      .set("Authorization", `Bearer ${token}`)
      .send({
        caseId,
        messages: [{ role: "user", content: "What is the status of this case?" }],
      });

    let systemPrompt: string | null = null;
    if (mockCompletionsCreate.mock.calls.length > 0) {
      const callArgs = mockCompletionsCreate.mock.calls[0]?.[0] as any;
      const sysMsg = (callArgs?.messages ?? []).find(
        (m: any) => m.role === "system",
      );
      systemPrompt = sysMsg?.content ?? null;
    }

    return { status: r.status, systemPrompt };
  }

  // ── Tests ─────────────────────────────────────────────────────────────────

  it("provider can query their own practice's case — context is included", async () => {
    const { status, systemPrompt } = await postAiChat(providerToken, ownedCaseId);

    expect(status).toBe(200);
    expect(systemPrompt).not.toBeNull();

    // The focused case block should be present in the system prompt
    expect(systemPrompt).toContain("FOCUSED CASE CONTEXT:");
    // Patient details from the owned case should appear
    expect(systemPrompt).toContain("OwnedPatientFirst");
    expect(systemPrompt).toContain("OwnedPatientLast");
  });

  it("provider cannot query a different practice's case — context block is empty", async () => {
    const { status, systemPrompt } = await postAiChat(providerToken, foreignCaseId);

    expect(status).toBe(200);
    expect(systemPrompt).not.toBeNull();

    // buildSingleCaseContext returned "" for the foreign case, so the focused
    // case block must be absent from the system prompt entirely.
    expect(systemPrompt).not.toContain("FOCUSED CASE CONTEXT:");

    // No patient details from the foreign practice should leak
    expect(systemPrompt).not.toContain("ForeignPatientFirst");
    expect(systemPrompt).not.toContain("ForeignPatientLast");
    expect(systemPrompt).not.toContain("Dr. Foreign");
  });

  it("returns 401 when no auth token is provided", async () => {
    const r = await request(appMod.default)
      .post("/api/ai-chat")
      .send({
        caseId: ownedCaseId,
        messages: [{ role: "user", content: "hello" }],
      });
    expect(r.status).toBe(401);
  });
});
