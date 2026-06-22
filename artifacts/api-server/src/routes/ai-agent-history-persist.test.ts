/**
 * Integration tests: cross-device AI chat history round-trip (real DB).
 *
 * The persistence gap that lost a user's "Maynard" chat history across devices
 * was invisible because every other AI test runs against a fully-mocked
 * `@workspace/db`, so nothing exercised a real write-then-read. These tests use
 * the real database (gated on DATABASE_URL, same as the other route integration
 * suites) and OpenAI is mocked so no live model call is made.
 *
 * Coverage:
 *  - POST /api/ai-agent (terminal text reply) persists a user+assistant
 *    exchange into `ai_chat_history`, and GET /api/ai-chat/history reads it back.
 *  - POST /api/ai-agent/stream (SSE terminal text reply) persists the exchange
 *    too — the streaming path uses the same shared writer.
 *  - A `proposed_action` reply (impactful tool, no auto-execute) does NOT
 *    persist any row — only terminal text replies are stored.
 *
 * All inserted rows are removed in afterAll so the suite is safe against a
 * shared dev DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";

// ── OpenAI mock ──────────────────────────────────────────────────────────────
// The mock supports both the non-streaming completion shape and the streaming
// (async-iterable) shape, switching on `params.stream`. A module-level `mode`
// lets each test choose between a terminal text reply and an impactful tool
// call that produces a proposed_action.
const { mockCompletionsCreate, setMode, ASSISTANT_REPLY } = vi.hoisted(() => {
  const ASSISTANT_REPLY = "Maynard says: your case is on track.";
  let mode: "text" | "proposed" = "text";
  const setMode = (m: "text" | "proposed") => {
    mode = m;
  };

  const toolCall = {
    id: "call_mark_paid_1",
    type: "function" as const,
    function: {
      name: "mark_invoice_paid",
      arguments: JSON.stringify({ invoiceId: "nonexistent-invoice-id" }),
    },
  };

  const mockCompletionsCreate = vi.fn().mockImplementation(async (params: any) => {
    const isStream = params?.stream === true;

    if (mode === "proposed") {
      if (isStream) {
        return (async function* () {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, ...toolCall }],
                },
              },
            ],
          };
        })();
      }
      return {
        choices: [
          { message: { role: "assistant", content: null, tool_calls: [toolCall] } },
        ],
      };
    }

    // mode === "text": a terminal reply with no tool calls.
    if (isStream) {
      return (async function* () {
        yield { choices: [{ delta: { content: ASSISTANT_REPLY } }] };
      })();
    }
    return { choices: [{ message: { role: "assistant", content: ASSISTANT_REPLY } }] };
  });

  return { mockCompletionsCreate, setMode, ASSISTANT_REPLY };
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
  caseMediaDir: path.join(os.tmpdir(), "labtrax-test-media-ai-agent-history"),
  extractMediaFileName: () => null,
}));
// Memory auto-learn is fire-and-forget for lab users; stub it so the test does
// not depend on (or write to) ai_memory_candidates and so it never calls the
// mocked OpenAI client behind our backs.
vi.mock("../lib/ai-memory-learn.js", () => ({
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));

// ── Gate ─────────────────────────────────────────────────────────────────────
const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

maybe("AI agent chat-history persistence (db integration)", () => {
  let dbMod: typeof import("@workspace/db");
  let appMod: { default: import("express").Express };
  let auth: typeof import("../lib/auth.js");

  const labOrgId = rid("lab");
  const labUserId = rid("ulab");
  let labToken: string;

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

  async function countHistory(userId: string): Promise<number> {
    const { db, aiChatHistory } = dbMod as any;
    const rows = await db
      .select({ id: aiChatHistory.id })
      .from(aiChatHistory)
      .where(eq(aiChatHistory.userId, userId));
    return rows.length;
  }

  /** Poll until the user has at least `min` history rows, or time out. */
  async function waitForHistory(userId: string, min: number, timeoutMs = 5000): Promise<number> {
    const start = Date.now();
    let n = await countHistory(userId);
    while (n < min && Date.now() - start < timeoutMs) {
      await sleep(100);
      n = await countHistory(userId);
    }
    return n;
  }

  async function clearHistory(userId: string): Promise<void> {
    const { db, aiChatHistory } = dbMod as any;
    await db.delete(aiChatHistory).where(eq(aiChatHistory.userId, userId));
  }

  beforeAll(async () => {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key-for-mock";
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-ai-agent-history";

    dbMod = await import("@workspace/db");
    appMod = await import("../app.js");
    auth = await import("../lib/auth.js");

    const { db, organizations, users, organizationMemberships } = dbMod as any;

    await db.insert(users).values([
      {
        id: labUserId,
        username: `lab_${labUserId}`,
        password: "testpass",
        userType: "lab",
      },
    ]);

    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "AI Agent History Test Lab" },
    ]);

    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        labId: labOrgId,
        userId: labUserId,
        role: "admin",
        status: "active",
      },
    ]);

    labToken = await makeSession(labUserId);
  });

  beforeEach(async () => {
    setMode("text");
    labToken = await makeSession(labUserId);
    await clearHistory(labUserId);
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const {
      db,
      organizations,
      users,
      organizationMemberships,
      userSessions,
      aiChatHistory,
    } = dbMod as any;

    await db.delete(aiChatHistory).where(eq(aiChatHistory.userId, labUserId));
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, [labUserId]));
    await db.delete(userSessions).where(inArray(userSessions.userId, [labUserId]));
    await db.delete(organizations).where(inArray(organizations.id, [labOrgId]));
    await db.delete(users).where(inArray(users.id, [labUserId]));
  });

  it("POST /ai-agent persists the exchange and GET /ai-chat/history reads it back", async () => {
    setMode("text");
    const userMessage = "How is my case doing?";

    const r = await request(appMod.default)
      .post("/api/ai-agent")
      .set("Authorization", `Bearer ${labToken}`)
      .send({ messages: [{ role: "user", content: userMessage }] });

    expect(r.status).toBe(200);
    expect(r.body.type).toBe("reply");
    expect(r.body.content).toBe(ASSISTANT_REPLY);

    // Persistence is fire-and-forget, so poll for the two rows (user+assistant).
    const n = await waitForHistory(labUserId, 2);
    expect(n).toBe(2);

    // The same store is what GET /ai-chat/history reads from — verify the
    // exchange comes back over the wire, oldest-first.
    const hist = await request(appMod.default)
      .get("/api/ai-chat/history")
      .set("Authorization", `Bearer ${labToken}`);

    expect(hist.status).toBe(200);
    const messages = hist.body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: userMessage });
    expect(messages[1]).toMatchObject({ role: "assistant", content: ASSISTANT_REPLY });
  });

  it("POST /ai-agent/stream (SSE) persists the exchange too", async () => {
    setMode("text");
    const userMessage = "Streaming: any updates?";

    const r = await request(appMod.default)
      .post("/api/ai-agent/stream")
      .set("Authorization", `Bearer ${labToken}`)
      .send({ messages: [{ role: "user", content: userMessage }] });

    expect(r.status).toBe(200);
    // SSE body should contain the streamed token and a done event.
    expect(r.text).toContain(ASSISTANT_REPLY);
    expect(r.text).toContain('"done":true');

    const n = await waitForHistory(labUserId, 2);
    expect(n).toBe(2);

    const hist = await request(appMod.default)
      .get("/api/ai-chat/history")
      .set("Authorization", `Bearer ${labToken}`);

    expect(hist.status).toBe(200);
    const messages = hist.body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: userMessage });
    expect(messages[1]).toMatchObject({ role: "assistant", content: ASSISTANT_REPLY });
  });

  it("a proposed_action reply does NOT persist a history row", async () => {
    setMode("proposed");

    const r = await request(appMod.default)
      .post("/api/ai-agent")
      .set("Authorization", `Bearer ${labToken}`)
      .send({ messages: [{ role: "user", content: "Mark invoice 123 as paid" }] });

    expect(r.status).toBe(200);
    expect(r.body.type).toBe("proposed_action");
    expect(r.body.toolName).toBe("mark_invoice_paid");

    // No terminal text reply was produced, so firePersist is never called.
    // Give any stray async write a brief window, then assert nothing landed.
    await sleep(300);
    const n = await countHistory(labUserId);
    expect(n).toBe(0);

    const hist = await request(appMod.default)
      .get("/api/ai-chat/history")
      .set("Authorization", `Bearer ${labToken}`);
    expect(hist.status).toBe(200);
    expect(hist.body.messages).toHaveLength(0);
  });
});
