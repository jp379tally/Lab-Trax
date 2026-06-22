/**
 * Tests for POST /ai-agent/stream — SSE streaming agentic endpoint.
 *
 * Coverage:
 * - POST /ai-agent/stream returns 401 when not authenticated
 * - POST /ai-agent/stream returns 503 when AI key is missing
 * - POST /ai-agent/stream returns 400 for missing messages
 * - POST /ai-agent/stream returns 400 when last message is not from user
 * - Happy path: text-only response emits token events then a done event
 * - Happy path: done event carries knowledgeSectionIds for privacy-signal query
 * - Readonly tool inline: tool executed, result fed back, final text streamed in done event
 * - Action proposal: impactful tool call emits proposed_action SSE event and stores pending action
 * - Action proposal: proposed_action actionId survives to be confirmed via POST /ai-agent/confirm
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import bodyParser from "body-parser";
import { registerAiAgentRoutes } from "./ai-agent";
import { TOOL_BY_NAME } from "../lib/ai-agent-tools";

// ─── OpenAI streaming mock ───────────────────────────────────────────────────
//
// The stream endpoint calls openai.chat.completions.create({ stream: true }) and
// iterates the result with `for await`. We need the mock to return an async
// iterable. mockStreamCreate is overridden per-describe block so each set of
// tests can supply its own chunk sequence.

const { mockStreamCreate } = vi.hoisted(() => {
  const mockStreamCreate = vi.fn();
  return { mockStreamCreate };
});

vi.mock("openai", () => {
  function OpenAI(this: any) {
    this.chat = { completions: { create: mockStreamCreate } };
  }
  return { default: OpenAI };
});

// ─── @workspace/db mock ──────────────────────────────────────────────────────

const createDbChain = (): any => {
  const resolved = Promise.resolve([]);
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
    offset: () => chain,
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  return chain;
};

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      select: () => createDbChain(),
      insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
      update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
      delete: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
      query: {
        organizations: {
          findFirst: vi.fn().mockResolvedValue(undefined),
          findMany: vi.fn().mockResolvedValue([]),
        },
        pricingTiers: { findMany: vi.fn().mockResolvedValue([]) },
        aiChatHistory: { findMany: vi.fn().mockResolvedValue([]) },
      },
    },
  };
});

vi.mock("../lib/cross-lab-doctor", () => ({
  getProviderOrgIdsForUserAndLinks: vi.fn().mockResolvedValue({ providerOrgIds: [] }),
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

function makeApp(userId?: string) {
  const app = express();
  app.use(bodyParser.json());
  app.use((req: any, _res, next) => {
    if (userId) req.user = { id: userId, userType: "lab" };
    next();
  });
  const router = express.Router();
  registerAiAgentRoutes(router);
  app.use("/api", router);
  return app;
}

/**
 * Create an async iterable that yields the supplied chunks one by one —
 * simulating what the OpenAI SDK returns when stream: true.
 */
function makeAsyncIterable(
  chunks: Array<{ choices: Array<{ delta: Record<string, unknown> }> }>,
): AsyncIterable<{ choices: Array<{ delta: Record<string, unknown> }> }> {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

/**
 * Parse SSE events from a raw response body string.
 * Returns an array of parsed JSON objects (one per `data:` line).
 */
function parseSseEvents(body: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const json = trimmed.slice(5).trim();
    try {
      events.push(JSON.parse(json) as Record<string, unknown>);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

// ─── Auth and input validation ────────────────────────────────────────────────

describe("POST /api/ai-agent/stream — auth and validation", () => {
  beforeAll(() => {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ??= "test-stream-key";
  });

  it("returns 401 when not authenticated", async () => {
    const app = makeApp(undefined);
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .send({ messages: [{ role: "user", content: "hello" }] });
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing messages", async () => {
    const app = makeApp("user-s1");
    const res = await request(app).post("/api/ai-agent/stream").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/messages/i);
  });

  it("returns 400 when last message is not from user", async () => {
    const app = makeApp("user-s2");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .send({ messages: [{ role: "assistant", content: "Hi" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/role.*user/i);
  });

  it("returns 503 when AI key is not configured", async () => {
    const savedKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

    vi.resetModules();
    const { registerAiAgentRoutes: freshRegister } = await import("./ai-agent");
    const freshApp = express();
    freshApp.use(bodyParser.json());
    freshApp.use((req: any, _res, next) => {
      req.user = { id: "user-503", userType: "lab" };
      next();
    });
    const freshRouter = express.Router();
    freshRegister(freshRouter);
    freshApp.use("/api", freshRouter);

    const res = await request(freshApp)
      .post("/api/ai-agent/stream")
      .send({ messages: [{ role: "user", content: "hello" }] });
    expect(res.status).toBe(503);

    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = savedKey;
  });
});

// ─── Happy path: text-only response ──────────────────────────────────────────

describe("POST /api/ai-agent/stream — happy path: text-only response", () => {
  beforeAll(() => {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ??= "test-stream-key";
  });

  beforeEach(() => {
    // Return a stream that emits two text tokens and no tool_calls.
    mockStreamCreate.mockImplementation(() =>
      makeAsyncIterable([
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world!" } }] },
        { choices: [{ delta: {} }] }, // end-of-stream chunk
      ]),
    );
  });

  it("emits token events for each text chunk", async () => {
    const app = makeApp("user-tp1");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse((res, callback) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => callback(null, data));
      })
      .send({ messages: [{ role: "user", content: "Hello" }] });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSseEvents(res.body as string);
    const tokenEvents = events.filter((e) => typeof e.token === "string");
    expect(tokenEvents.length).toBeGreaterThanOrEqual(2);

    const tokens = tokenEvents.map((e) => e.token).join("");
    expect(tokens).toBe("Hello world!");
  });

  it("emits a done event as the final event", async () => {
    const app = makeApp("user-tp2");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse((res, callback) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => callback(null, data));
      })
      .send({ messages: [{ role: "user", content: "Hello" }] });

    const events = parseSseEvents(res.body as string);
    const doneEvent = events.find((e) => e.done === true);
    expect(doneEvent).toBeDefined();
  });

  it("done event includes knowledgeSectionIds for a privacy-signal query", async () => {
    // The query below triggers knowledge augmentation for the privacy domain.
    // Even with the stream path, knowledgeSectionIds must appear in the done event.
    const app = makeApp("user-tp3");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse((res, callback) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => callback(null, data));
      })
      .send({
        messages: [{ role: "user", content: "Can I share a patient photo with anyone?" }],
      });

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.body as string);
    const doneEvent = events.find((e) => e.done === true);
    expect(doneEvent).toBeDefined();
    expect(Array.isArray(doneEvent!.knowledgeSectionIds)).toBe(true);
    expect((doneEvent!.knowledgeSectionIds as string[]).length).toBeGreaterThan(0);
  });

  it("emits no proposed_action event when the model produces only text", async () => {
    const app = makeApp("user-tp4");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse((res, callback) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => callback(null, data));
      })
      .send({ messages: [{ role: "user", content: "Hello" }] });

    const events = parseSseEvents(res.body as string);
    expect(events.some((e) => "proposed_action" in e)).toBe(false);
  });
});

// ─── Action proposal: impactful tool call ────────────────────────────────────

describe("POST /api/ai-agent/stream — action proposal path", () => {
  beforeAll(() => {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ??= "test-stream-key";
  });

  beforeEach(() => {
    // Stub the summarize method on mark_invoice_paid so it returns a predictable
    // string without touching the DB.
    const tool = TOOL_BY_NAME.get("mark_invoice_paid");
    if (tool) {
      vi.spyOn(tool, "summarize").mockResolvedValue("Mark invoice INV-AP-001 as paid");
    }

    // Return a stream whose only delta is an impactful tool call.
    mockStreamCreate.mockImplementation(() =>
      makeAsyncIterable([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tc-ap-001",
                type: "function",
                function: { name: "mark_invoice_paid", arguments: "" },
              }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: JSON.stringify({ invoiceId: "INV-AP-001" }) },
              }],
            },
          }],
        },
        { choices: [{ delta: {} }] },
      ]),
    );
  });

  it("emits a proposed_action SSE event for an impactful tool call", async () => {
    const app = makeApp("user-ap1");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse((res, callback) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => callback(null, data));
      })
      .send({ messages: [{ role: "user", content: "Mark invoice INV-AP-001 as paid" }] });

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.body as string);
    const actionEvent = events.find((e) => e.proposed_action != null);
    expect(actionEvent).toBeDefined();

    const pa = actionEvent!.proposed_action as {
      actionId: string;
      toolName: string;
      summary: string;
      args: Record<string, unknown>;
    };
    expect(typeof pa.actionId).toBe("string");
    expect(pa.actionId.length).toBeGreaterThan(0);
    expect(pa.toolName).toBe("mark_invoice_paid");
    expect(typeof pa.summary).toBe("string");
  });

  it("does NOT emit a done event when a proposed_action is present", async () => {
    const app = makeApp("user-ap2");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse((res, callback) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => callback(null, data));
      })
      .send({ messages: [{ role: "user", content: "Mark invoice INV-AP-001 as paid" }] });

    const events = parseSseEvents(res.body as string);
    expect(events.some((e) => e.done === true)).toBe(false);
  });

  it("proposed_action stores a pending action that can be confirmed", async () => {
    const app = makeApp("user-ap3");

    // First: call the stream endpoint to get the actionId
    const streamRes = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse((res, callback) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => callback(null, data));
      })
      .send({ messages: [{ role: "user", content: "Mark invoice INV-AP-001 as paid" }] });

    const events = parseSseEvents(streamRes.body as string);
    const pa = (events.find((e) => e.proposed_action != null)?.proposed_action) as {
      actionId: string;
    } | undefined;
    expect(pa).toBeDefined();
    const actionId = pa!.actionId;

    // Stub execute so confirmation doesn't hit real DB
    const tool = TOOL_BY_NAME.get("mark_invoice_paid")!;
    const executeSpy = vi
      .spyOn(tool, "execute")
      .mockResolvedValueOnce({ invoiceId: "INV-AP-001", status: "paid" });

    // Second: confirm the action — it must succeed (not 404)
    const confirmRes = await request(app)
      .post("/api/ai-agent/confirm")
      .send({ actionId });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.type).toBe("action_result");
    expect(confirmRes.body.success).toBe(true);

    executeSpy.mockRestore();
  });

  it("proposed_action is owned by the requesting user (confirm by a different user → 403)", async () => {
    const ownerApp = makeApp("user-owner-ap");
    const attackerApp = makeApp("user-attacker-ap");

    const streamRes = await request(ownerApp)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse((res, callback) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => callback(null, data));
      })
      .send({ messages: [{ role: "user", content: "Mark invoice INV-AP-001 as paid" }] });

    const events = parseSseEvents(streamRes.body as string);
    const pa = (events.find((e) => e.proposed_action != null)?.proposed_action) as {
      actionId: string;
    } | undefined;
    expect(pa).toBeDefined();

    const confirmRes = await request(attackerApp)
      .post("/api/ai-agent/confirm")
      .send({ actionId: pa!.actionId });
    expect(confirmRes.status).toBe(403);
  });
});

// ─── Readonly tool inline ─────────────────────────────────────────────────────

describe("POST /api/ai-agent/stream — readonly tool inline execution", () => {
  beforeAll(() => {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ??= "test-stream-key";
  });

  it("executes a readonly tool inline and streams a text reply in the done event", async () => {
    // Stub the readonly tool so it returns without hitting the DB.
    const readonlyTool = TOOL_BY_NAME.get("lookup_invoice")!;
    const executeSpy = vi
      .spyOn(readonlyTool, "execute")
      .mockResolvedValueOnce({ found: false, invoiceId: "INV-RO-001" });

    // Iteration 1: model wants to call lookup_invoice (readonly)
    // Iteration 2: model returns text after seeing the tool result
    let callCount = 0;
    mockStreamCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return makeAsyncIterable([
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "tc-ro-001",
                  type: "function",
                  function: { name: "lookup_invoice", arguments: "" },
                }],
              },
            }],
          },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: JSON.stringify({ invoiceId: "INV-RO-001" }) },
                }],
              },
            }],
          },
          { choices: [{ delta: {} }] },
        ]);
      }
      // Second iteration: model returns a text reply after seeing the tool result
      return makeAsyncIterable([
        { choices: [{ delta: { content: "Invoice not found." } }] },
        { choices: [{ delta: {} }] },
      ]);
    });

    const app = makeApp("user-ro1");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse((res, callback) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => callback(null, data));
      })
      .send({ messages: [{ role: "user", content: "Look up invoice INV-RO-001" }] });

    expect(res.status).toBe(200);

    const events = parseSseEvents(res.body as string);

    // The readonly tool must have been executed
    expect(executeSpy).toHaveBeenCalledOnce();

    // Must have token events (the second iteration's text reply)
    const tokenEvents = events.filter((e) => typeof e.token === "string");
    expect(tokenEvents.length).toBeGreaterThan(0);
    const fullText = tokenEvents.map((e) => e.token as string).join("");
    expect(fullText).toContain("not found");

    // Must end with done:true (no proposed_action)
    expect(events.some((e) => e.done === true)).toBe(true);
    expect(events.some((e) => "proposed_action" in e)).toBe(false);

    executeSpy.mockRestore();
  });
});
