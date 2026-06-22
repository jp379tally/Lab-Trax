/**
 * Tests for POST /ai-agent/stream — SSE streaming agentic endpoint.
 *
 * The mobile streaming client mocks fetch entirely, so the server-side SSE
 * contract is otherwise untested. These integration tests drive the real route
 * handler with a mocked OpenAI *streaming* client (an async iterable of delta
 * chunks) and assert the wire format the client depends on.
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
 * - Action proposal: confirm by a different user → 403 (ownership)
 * - Edge cases: exactly one terminal done event (no double-done), fallback token
 *   when the model streams empty content, explicit tool_call event for readonly
 *   tools, and a terminal error event when the OpenAI call throws
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

/** supertest .parse() helper that buffers the raw SSE stream into a string. */
function bufferRawStream(res: any, callback: (err: Error | null, body: string) => void) {
  let data = "";
  res.on("data", (chunk: Buffer) => {
    data += chunk.toString();
  });
  res.on("end", () => callback(null, data));
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

  it("returns 503 (plain JSON, not SSE) when AI key is not configured", async () => {
    const savedKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

    // Fresh module so the OpenAI singleton re-initialises without a key.
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
    expect(res.body.error).toMatch(/not configured|administrator/i);
    // 503 short-circuits before SSE headers are flushed.
    expect(res.headers["content-type"]).not.toMatch(/event-stream/);

    if (savedKey !== undefined) process.env.AI_INTEGRATIONS_OPENAI_API_KEY = savedKey;
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
      .parse(bufferRawStream)
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
      .parse(bufferRawStream)
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
      .parse(bufferRawStream)
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
      .parse(bufferRawStream)
      .send({ messages: [{ role: "user", content: "Hello" }] });

    const events = parseSseEvents(res.body as string);
    expect(events.some((e) => "proposed_action" in e)).toBe(false);
  });

  it("emits exactly one terminal done event (no double-done)", async () => {
    const app = makeApp("user-tp5");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse(bufferRawStream)
      .send({ messages: [{ role: "user", content: "Hello" }] });

    const events = parseSseEvents(res.body as string);
    const doneEvents = events.filter((e) => e.done === true);
    expect(doneEvents.length).toBe(1);
    // done must be the last event — no trailing events follow it.
    expect(events[events.length - 1].done).toBe(true);
  });
});

// ─── Knowledge audit metadata in the done event ──────────────────────────────
//
// The non-streaming POST /ai-agent route has knowledge-audit tests asserting
// knowledgeSectionIds / retentionDisclaimer appear in its JSON reply. The
// streaming route emits the same metadata inside its terminal `done` event.
// These tests pin that contract so a regression that dropped the fields from
// the done event (silently removing legal/privacy disclaimers from the
// streaming client) would fail loudly.

describe("POST /api/ai-agent/stream — knowledge audit metadata in done event", () => {
  beforeAll(() => {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ??= "test-stream-key";
  });

  beforeEach(() => {
    // Text-only reply (no tool_calls) so the route exits via the terminal
    // done event that serialises the knowledge metadata.
    mockStreamCreate.mockImplementation(() =>
      makeAsyncIterable([
        { choices: [{ delta: { content: "Mocked AI reply." } }] },
        { choices: [{ delta: {} }] },
      ]),
    );
  });

  it("done event carries a non-empty knowledgeSectionIds array of strings for a privacy-signal query", async () => {
    const app = makeApp("user-ka-stream-1");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse(bufferRawStream)
      .send({ messages: [{ role: "user", content: "Can I share a patient photo with anyone?" }] });

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.body as string);
    const doneEvent = events.find((e) => e.done === true);
    expect(doneEvent).toBeDefined();
    expect(Array.isArray(doneEvent!.knowledgeSectionIds)).toBe(true);
    const ids = doneEvent!.knowledgeSectionIds as string[];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it("done event carries retentionDisclaimer:true and a disclaimer string for a retention-signal query", async () => {
    const app = makeApp("user-ka-stream-2");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse(bufferRawStream)
      .send({
        messages: [{ role: "user", content: "How long do I need to keep dental lab records?" }],
      });

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.body as string);
    const doneEvent = events.find((e) => e.done === true);
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.retentionDisclaimer).toBe(true);
    expect(typeof doneEvent!.disclaimer).toBe("string");
    expect((doneEvent!.disclaimer as string).length).toBeGreaterThan(0);
  });

  it("done event omits knowledge/disclaimer fields for an unrelated query", async () => {
    const app = makeApp("user-ka-stream-3");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse(bufferRawStream)
      .send({
        messages: [{ role: "user", content: "zzzzz qqqqq wwwww unrelated gibberish 12345" }],
      });

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.body as string);
    const doneEvent = events.find((e) => e.done === true);
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.knowledgeSectionIds).toBeUndefined();
    expect(doneEvent!.retentionDisclaimer).toBeUndefined();
    expect(doneEvent!.disclaimer).toBeUndefined();
    expect(doneEvent!.privacyDisclaimer).toBeUndefined();
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
      .parse(bufferRawStream)
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
    expect(pa.args).toEqual({ invoiceId: "INV-AP-001" });
  });

  it("does NOT emit a done event when a proposed_action is present", async () => {
    const app = makeApp("user-ap2");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse(bufferRawStream)
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
      .parse(bufferRawStream)
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
      .parse(bufferRawStream)
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
      .parse(bufferRawStream)
      .send({ messages: [{ role: "user", content: "Look up invoice INV-RO-001" }] });

    expect(res.status).toBe(200);

    const events = parseSseEvents(res.body as string);

    // The readonly tool must have been executed
    expect(executeSpy).toHaveBeenCalledOnce();

    // An explicit tool_call event is emitted for the readonly tool
    const toolCallEvent = events.find((e) => e.tool_call != null);
    expect(toolCallEvent).toBeDefined();
    expect((toolCallEvent!.tool_call as { name: string }).name).toBe("lookup_invoice");

    // Must have token events (the second iteration's text reply)
    const tokenEvents = events.filter((e) => typeof e.token === "string");
    expect(tokenEvents.length).toBeGreaterThan(0);
    const fullText = tokenEvents.map((e) => e.token as string).join("");
    expect(fullText).toContain("not found");

    // Must end with exactly one done:true (no proposed_action)
    expect(events.filter((e) => e.done === true).length).toBe(1);
    expect(events.some((e) => "proposed_action" in e)).toBe(false);

    executeSpy.mockRestore();
  });
});

// ─── Auto-execute mode ───────────────────────────────────────────────────────

describe("POST /api/ai-agent/stream — auto-execute mode", () => {
  beforeAll(() => {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ??= "test-stream-key";
  });

  beforeEach(() => {
    mockStreamCreate.mockReset();
  });

  it("executes impactful tool inline when auto_execute=true and emits auto_executed + done", async () => {
    const tool = TOOL_BY_NAME.get("mark_invoice_paid")!;
    const executeSpy = vi
      .spyOn(tool, "execute")
      .mockResolvedValueOnce({ invoiceId: "inv-ae-001", status: "paid" });
    const summarizeSpy = vi
      .spyOn(tool, "summarize")
      .mockResolvedValueOnce("Mark invoice INV-AE-001 as paid");

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
                  id: "tc-ae-001",
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
                  function: { arguments: JSON.stringify({ invoiceId: "inv-ae-001" }) },
                }],
              },
            }],
          },
          { choices: [{ delta: {} }] },
        ]);
      }
      return makeAsyncIterable([
        { choices: [{ delta: { content: "Done!" } }] },
        { choices: [{ delta: {} }] },
      ]);
    });

    const app = makeApp("user-ae1");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse(bufferRawStream)
      .send({
        messages: [{ role: "user", content: "Mark invoice INV-AE-001 as paid" }],
        auto_execute: true,
      });

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.body as string);

    // Must execute inline
    expect(executeSpy).toHaveBeenCalledOnce();

    // Must emit auto_executed event
    const autoEvent = events.find((e) => e.auto_executed != null);
    expect(autoEvent).toBeDefined();
    const ae = autoEvent!.auto_executed as { toolName?: string; summary?: string };
    expect(ae.toolName).toBe("mark_invoice_paid");
    expect(ae.summary).toBe("Mark invoice INV-AE-001 as paid");

    // Must NOT emit proposed_action
    expect(events.some((e) => "proposed_action" in e)).toBe(false);

    // Must emit a done event (loop continued)
    expect(events.filter((e) => e.done === true).length).toBe(1);

    // Must have token events (second iteration text)
    const tokens = events.filter((e) => typeof e.token === "string");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.map((e) => e.token).join("")).toBe("Done!");

    executeSpy.mockRestore();
    summarizeSpy.mockRestore();
  });

  it("still emits proposed_action when auto_execute=false (default)", async () => {
    const tool = TOOL_BY_NAME.get("mark_invoice_paid")!;
    vi.spyOn(tool, "summarize").mockResolvedValueOnce("Mark invoice INV-DF-001 as paid");

    mockStreamCreate.mockImplementation(() =>
      makeAsyncIterable([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tc-df-001",
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
                function: { arguments: JSON.stringify({ invoiceId: "INV-DF-001" }) },
              }],
            },
          }],
        },
        { choices: [{ delta: {} }] },
      ]),
    );

    const app = makeApp("user-df1");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse(bufferRawStream)
      .send({ messages: [{ role: "user", content: "Mark invoice INV-DF-001 as paid" }] });

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.body as string);
    expect(events.some((e) => "proposed_action" in e)).toBe(true);
    expect(events.some((e) => "auto_executed" in e)).toBe(false);
  });

  it("handles auto-execute failure gracefully and continues the loop", async () => {
    const tool = TOOL_BY_NAME.get("mark_invoice_paid")!;
    const executeSpy = vi
      .spyOn(tool, "execute")
      .mockRejectedValueOnce(new Error("Invoice already paid"));
    const summarizeSpy = vi
      .spyOn(tool, "summarize")
      .mockResolvedValueOnce("Mark invoice INV-ERR-001 as paid");

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
                  id: "tc-err-001",
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
                  function: { arguments: JSON.stringify({ invoiceId: "inv-err-001" }) },
                }],
              },
            }],
          },
          { choices: [{ delta: {} }] },
        ]);
      }
      return makeAsyncIterable([
        { choices: [{ delta: { content: "I couldn't complete that action." } }] },
        { choices: [{ delta: {} }] },
      ]);
    });

    const app = makeApp("user-err1");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse(bufferRawStream)
      .send({
        messages: [{ role: "user", content: "Mark invoice INV-ERR-001 as paid" }],
        auto_execute: true,
      });

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.body as string);

    // No auto_executed event on failure
    expect(events.some((e) => "auto_executed" in e)).toBe(false);

    // The loop should still continue (tool error is fed back to model)
    expect(events.filter((e) => e.done === true).length).toBe(1);

    executeSpy.mockRestore();
    summarizeSpy.mockRestore();
  });
});

// ─── Edge cases: empty content and upstream failure ──────────────────────────

describe("POST /api/ai-agent/stream — edge cases", () => {
  beforeAll(() => {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ??= "test-stream-key";
  });

  beforeEach(() => {
    mockStreamCreate.mockReset();
  });

  it("emits a fallback token when the model streams empty content", async () => {
    mockStreamCreate.mockImplementation(() => makeAsyncIterable([]));

    const app = makeApp("user-edge-empty");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse(bufferRawStream)
      .send({ messages: [{ role: "user", content: "say nothing" }] });

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.body as string);
    const tokenEvents = events.filter((e) => typeof e.token === "string");
    expect(tokenEvents.length).toBe(1);
    expect(tokenEvents[0].token as string).toMatch(/not sure how to help/i);
    expect(events.filter((e) => e.done === true).length).toBe(1);
  });

  it("emits a terminal error event (no done) when the OpenAI call throws", async () => {
    mockStreamCreate.mockRejectedValueOnce(new Error("upstream exploded"));

    const app = makeApp("user-edge-error");
    const res = await request(app)
      .post("/api/ai-agent/stream")
      .buffer(true)
      .parse(bufferRawStream)
      .send({ messages: [{ role: "user", content: "trigger failure" }] });

    // Headers were already flushed (200 + event-stream) before the failure, so
    // the error surfaces as a terminal SSE error event, not an HTTP error code.
    expect(res.status).toBe(200);
    const events = parseSseEvents(res.body as string);
    const errorEvent = events.find((e) => typeof e.error === "string");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.error as string).toMatch(/AI request failed/i);
    expect(events.some((e) => e.done === true)).toBe(false);
  });
});
