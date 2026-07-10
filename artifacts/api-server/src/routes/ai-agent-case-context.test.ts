/**
 * Tests for active-case context injection into the Maynard system prompt.
 *
 * The clients pass the case the user is viewing (caseId) or the set of pinned
 * cases (caseIds). The server fetches a bounded set of safe summary fields —
 * strictly tenant-scoped — and injects them into the system prompt so "this
 * case" resolves without the user restating the case number.
 *
 * Coverage:
 * - lab user: a matching active case reaches the system prompt (number + patient)
 * - multiple pinned caseIds render the "ACTIVE CASES" multi-case block
 * - provider user: case reaches the prompt when scoped to the provider org
 * - provider with NO org scope: no case content injected (no cross-tenant leak)
 * - lab with NO membership: no case content injected
 * - no caseId/caseIds: no case block at all
 * - DB failure while fetching cases degrades gracefully (chat still replies)
 * - rx notes are truncated to keep the prompt bounded
 * - streaming route (/ai-agent/stream) injects the same block
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import bodyParser from "body-parser";
import { registerAiAgentRoutes } from "./ai-agent";

// ─── OpenAI mock (supports both non-stream and stream shapes) ────────────────

const { mockCompletionsCreate } = vi.hoisted(() => {
  const mockCompletionsCreate = vi.fn();
  return { mockCompletionsCreate };
});

vi.mock("openai", () => {
  function OpenAI(this: any) {
    this.chat = { completions: { create: mockCompletionsCreate } };
  }
  return { default: OpenAI };
});

// ─── @workspace/db mock — per-table resolution driven by mutable state ───────

const dbState = vi.hoisted(() => ({
  membershipRows: [] as any[],
  caseRows: [] as any[],
  throwOnCases: false,
  // Drives requireAnyRole (db.query.organizationMemberships.findFirst): the
  // role gate lab users must clear before any case context is injected.
  membershipFindFirst: null as any,
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const casesTable = actual.cases;
  const membershipTable = actual.organizationMemberships;

  const makeChain = (): any => {
    let table: unknown = null;
    const resolve = async (): Promise<any[]> => {
      if (table === casesTable) {
        if (dbState.throwOnCases) throw new Error("db down");
        return dbState.caseRows;
      }
      if (table === membershipTable) return dbState.membershipRows;
      return [];
    };
    const chain: any = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      offset: () => chain,
      limit: () => resolve(),
      then: (onF: any, onR: any) => resolve().then(onF, onR),
      catch: (onR: any) => resolve().catch(onR),
      finally: (onF: any) => resolve().finally(onF),
    };
    return chain;
  };

  return {
    ...actual,
    db: {
      select: () => makeChain(),
      insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
      update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
      delete: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
      query: {
        organizations: {
          findFirst: vi.fn().mockResolvedValue(undefined),
          findMany: vi.fn().mockResolvedValue([]),
        },
        organizationMemberships: {
          findFirst: vi.fn(async () => dbState.membershipFindFirst),
        },
        pricingTiers: { findMany: vi.fn().mockResolvedValue([]) },
        aiChatHistory: { findMany: vi.fn().mockResolvedValue([]) },
      },
    },
  };
});

const providerOrgIdsMock = vi.hoisted(() => ({ value: [] as string[] }));

vi.mock("../lib/cross-lab-doctor", () => ({
  getProviderOrgIdsForUserAndLinks: vi.fn(async () => ({
    providerOrgIds: providerOrgIdsMock.value,
  })),
}));

vi.mock("../lib/ai-memory-learn", () => ({
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeApp(userId: string, userType: "lab" | "provider" = "lab") {
  const app = express();
  app.use(bodyParser.json());
  app.use((req: any, _res, next) => {
    req.user = { id: userId, userType };
    next();
  });
  const router = express.Router();
  registerAiAgentRoutes(router);
  app.use("/api", router);
  return app;
}

/** The system-prompt content passed to the (first) OpenAI create call. */
function systemPromptSent(): string {
  const call = mockCompletionsCreate.mock.calls[0];
  expect(call).toBeDefined();
  const messages = call![0].messages as Array<{ role: string; content: string }>;
  const sys = messages.find((m) => m.role === "system");
  expect(sys).toBeDefined();
  return sys!.content;
}

function makeCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "case-uuid-1",
    caseNumber: "C-1001",
    labOrganizationId: "lab-1",
    providerOrganizationId: "prov-1",
    patientFirstName: "Jane",
    patientLastName: "Doe",
    doctorName: "Dr. Smith",
    status: "in_progress",
    priority: "rush",
    dueDate: new Date("2026-07-20T00:00:00Z"),
    expectedDeliveryDate: null,
    shade: "A2",
    rxNotes: "Full arch zirconia",
    deletedAt: null,
    ...overrides,
  };
}

function makeAsyncIterable(
  chunks: Array<{ choices: Array<{ delta: Record<string, unknown> }> }>,
) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function bufferRawStream(res: any, cb: (err: Error | null, body: string) => void) {
  let data = "";
  res.on("data", (c: Buffer) => {
    data += c.toString();
  });
  res.on("end", () => cb(null, data));
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ??= "test-case-ctx-key";
});

beforeEach(() => {
  dbState.membershipRows = [];
  dbState.caseRows = [];
  dbState.throwOnCases = false;
  dbState.membershipFindFirst = null;
  providerOrgIdsMock.value = [];
  mockCompletionsCreate.mockReset();
  mockCompletionsCreate.mockResolvedValue({
    choices: [{ message: { content: "ok", tool_calls: undefined }, finish_reason: "stop" }],
  });
});

// ─── Non-streaming route ─────────────────────────────────────────────────────

describe("POST /api/ai-agent — active-case context injection", () => {
  it("injects a matching active case (number + patient) for a lab user", async () => {
    dbState.membershipRows = [{ labId: "lab-1" }];
    dbState.membershipFindFirst = { role: "admin" };
    dbState.caseRows = [makeCase()];

    const app = makeApp("u-lab-1");
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "summarize this case" }], caseId: "case-uuid-1" });

    expect(res.status).toBe(200);
    const sp = systemPromptSent();
    expect(sp).toContain("ACTIVE CASE");
    expect(sp).toContain("C-1001");
    expect(sp).toContain("Jane Doe");
    expect(sp).toContain("Dr. Smith");
  });

  it("renders the multi-case block when multiple caseIds are pinned", async () => {
    dbState.membershipRows = [{ labId: "lab-1" }];
    dbState.membershipFindFirst = { role: "admin" };
    dbState.caseRows = [
      makeCase({ id: "a", caseNumber: "C-1001", patientFirstName: "Jane", patientLastName: "Doe" }),
      makeCase({ id: "b", caseNumber: "C-1002", patientFirstName: "John", patientLastName: "Roe" }),
    ];

    const app = makeApp("u-lab-2");
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "compare these cases" }], caseIds: ["a", "b"] });

    expect(res.status).toBe(200);
    const sp = systemPromptSent();
    expect(sp).toContain("ACTIVE CASES");
    expect(sp).toContain("C-1001");
    expect(sp).toContain("C-1002");
    expect(sp).toContain("these 2 cases");
  });

  it("injects a case for a provider user scoped to their provider org", async () => {
    providerOrgIdsMock.value = ["prov-1"];
    dbState.caseRows = [makeCase()];

    const app = makeApp("u-prov-1", "provider");
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "what's the status of this case?" }], caseId: "case-uuid-1" });

    expect(res.status).toBe(200);
    expect(systemPromptSent()).toContain("C-1001");
  });

  it("does NOT inject any case for a provider with no org scope (no cross-tenant leak)", async () => {
    providerOrgIdsMock.value = [];
    // Even though the DB mock would return a row, the guard returns before querying.
    dbState.caseRows = [makeCase()];

    const app = makeApp("u-prov-2", "provider");
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "this case" }], caseId: "case-uuid-1" });

    expect(res.status).toBe(200);
    const sp = systemPromptSent();
    expect(sp).not.toContain("ACTIVE CASE");
    expect(sp).not.toContain("C-1001");
  });

  it("does NOT inject any case for a lab user with no active membership", async () => {
    dbState.membershipRows = [];
    dbState.caseRows = [makeCase()];

    const app = makeApp("u-lab-3");
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "this case" }], caseId: "case-uuid-1" });

    expect(res.status).toBe(200);
    expect(systemPromptSent()).not.toContain("ACTIVE CASE");
  });

  it("injects no case block when neither caseId nor caseIds is passed", async () => {
    dbState.membershipRows = [{ labId: "lab-1" }];
    dbState.caseRows = [makeCase()];

    const app = makeApp("u-lab-4");
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "hello" }] });

    expect(res.status).toBe(200);
    expect(systemPromptSent()).not.toContain("ACTIVE CASE");
  });

  it("does NOT inject any case for a lab user lacking a billing/admin role", async () => {
    dbState.membershipRows = [{ labId: "lab-1" }];
    dbState.membershipFindFirst = { role: "read_only" };
    dbState.caseRows = [makeCase()];

    const app = makeApp("u-lab-restricted");
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "this case" }], caseId: "case-uuid-1" });

    expect(res.status).toBe(200);
    const sp = systemPromptSent();
    expect(sp).not.toContain("ACTIVE CASE");
    expect(sp).not.toContain("C-1001");
  });

  it("degrades gracefully (chat still replies) when the case lookup throws", async () => {
    dbState.membershipRows = [{ labId: "lab-1" }];
    dbState.membershipFindFirst = { role: "admin" };
    dbState.throwOnCases = true;

    const app = makeApp("u-lab-5");
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "this case" }], caseId: "case-uuid-1" });

    expect(res.status).toBe(200);
    expect(systemPromptSent()).not.toContain("ACTIVE CASE");
  });

  it("truncates long rx notes to keep the prompt bounded", async () => {
    dbState.membershipRows = [{ labId: "lab-1" }];
    dbState.membershipFindFirst = { role: "admin" };
    const longNotes = "X".repeat(1000);
    dbState.caseRows = [makeCase({ rxNotes: longNotes })];

    const app = makeApp("u-lab-6");
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "this case" }], caseId: "case-uuid-1" });

    expect(res.status).toBe(200);
    const sp = systemPromptSent();
    // 400-char cap: the block must not carry the full 1000-char note.
    expect(sp).not.toContain("X".repeat(500));
    expect(sp).toContain("X".repeat(400));
  });
});

// ─── Streaming route ─────────────────────────────────────────────────────────

describe("POST /api/ai-agent/stream — active-case context injection", () => {
  it("injects the active case into the streaming route's system prompt", async () => {
    dbState.membershipRows = [{ labId: "lab-1" }];
    dbState.membershipFindFirst = { role: "admin" };
    dbState.caseRows = [makeCase()];
    mockCompletionsCreate.mockImplementation(() =>
      makeAsyncIterable([
        { choices: [{ delta: { content: "ok" } }] },
        { choices: [{ delta: {} }] },
      ]),
    );

    const app = makeApp("u-stream-1");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse(bufferRawStream)
      .send({ messages: [{ role: "user", content: "summarize this case" }], caseId: "case-uuid-1" });

    expect(res.status).toBe(200);
    expect(systemPromptSent()).toContain("C-1001");
  });
});
