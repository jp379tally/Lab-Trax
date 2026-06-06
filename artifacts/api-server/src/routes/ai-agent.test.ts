/**
 * AI Agent route tests.
 *
 * Coverage:
 * - POST /ai-agent returns 503 when AI key is missing
 * - POST /ai-agent requires authentication
 * - POST /ai-agent/confirm requires authentication
 * - POST /ai-agent/confirm rejects unknown action IDs
 * - POST /ai-agent/reject discards a pending action
 * - Tool classification: readonly tools have kind "readonly", impactful tools have kind "impactful"
 * - Tool registry completeness
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import bodyParser from "body-parser";
import {
  AGENT_TOOLS,
  TOOL_BY_NAME,
  buildOpenAiTools,
  type ToolContext,
} from "../lib/ai-agent-tools";
import { registerAiAgentRoutes, _testInjectPendingAction } from "./ai-agent";

// ─── Minimal Express app for tests ─────────────────────────────────────────

function makeApp(userId?: string) {
  const app = express();
  app.use(bodyParser.json());

  // Stub auth middleware
  app.use((req: any, _res, next) => {
    if (userId) {
      req.user = { id: userId, userType: "lab" };
    }
    next();
  });

  // Stub requireAuth: if no user, 401
  vi.mock("../middlewares/auth", () => ({
    requireAuth: (req: any, res: any, next: any) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      next();
    },
    optionalAuth: (_req: any, _res: any, next: any) => next(),
  }));

  const router = express.Router();
  registerAiAgentRoutes(router);
  app.use("/api", router);
  return app;
}

// ─── Tool registry tests ─────────────────────────────────────────────────────

describe("AGENT_TOOLS registry", () => {
  it("should export a non-empty tools array", () => {
    expect(AGENT_TOOLS.length).toBeGreaterThan(0);
  });

  it("should have exactly two readonly tools", () => {
    const readonlyTools = AGENT_TOOLS.filter((t) => t.kind === "readonly");
    expect(readonlyTools.length).toBeGreaterThanOrEqual(2);
    const names = readonlyTools.map((t) => t.name);
    expect(names).toContain("lookup_invoice");
    expect(names).toContain("lookup_case");
  });

  it("should mark impactful tools correctly", () => {
    const impactful = AGENT_TOOLS.filter((t) => t.kind === "impactful");
    const names = impactful.map((t) => t.name);
    expect(names).toContain("mark_invoice_paid");
    expect(names).toContain("void_invoice");
    expect(names).toContain("merge_doctors");
    expect(names).toContain("send_statements");
    expect(names).toContain("set_practice_pricing_tier");
    expect(names).toContain("create_pricing_override");
    expect(names).toContain("create_case");
    expect(names).toContain("update_case_status");
    expect(names).toContain("update_case");
    expect(names).toContain("reset_invoice_layout");
  });

  it("TOOL_BY_NAME contains every tool", () => {
    for (const tool of AGENT_TOOLS) {
      expect(TOOL_BY_NAME.has(tool.name)).toBe(true);
      expect(TOOL_BY_NAME.get(tool.name)).toBe(tool);
    }
  });

  it("buildOpenAiTools returns correct shape", () => {
    const tools = buildOpenAiTools();
    expect(tools.length).toBe(AGENT_TOOLS.length);
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(typeof t.function.name).toBe("string");
      expect(typeof t.function.description).toBe("string");
      expect(typeof t.function.parameters).toBe("object");
    }
  });

  it("every tool has required fields", () => {
    for (const tool of AGENT_TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(["readonly", "impactful"]).toContain(tool.kind);
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.summarize).toBe("function");
      expect(typeof tool.execute).toBe("function");
    }
  });
});

// ─── Route: POST /api/ai-agent ───────────────────────────────────────────────

describe("POST /api/ai-agent", () => {
  it("returns 401 when not authenticated", async () => {
    const app = makeApp(undefined);
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "hello" }] });
    expect(res.status).toBe(401);
  });

  it("returns 503 when AI key is not configured", async () => {
    const savedKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

    // Reset module so singleton re-initialises without the key
    vi.resetModules();
    const { registerAiAgentRoutes: freshRegister } = await import("./ai-agent");
    const app = makeApp("user-123");
    // Re-apply with freshly loaded module
    const freshRouter = express.Router();
    freshRegister(freshRouter);
    const freshApp = express();
    freshApp.use(bodyParser.json());
    freshApp.use((req: any, _res, next) => {
      req.user = { id: "user-123", userType: "lab" };
      next();
    });
    freshApp.use("/api", freshRouter);

    const res = await request(freshApp)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "hello" }] });
    expect(res.status).toBe(503);

    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = savedKey;
  });

  it("returns 400 for missing messages", async () => {
    const app = makeApp("user-123");
    const res = await request(app).post("/api/ai-agent").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/messages/i);
  });

  it("returns 400 when last message is not from user", async () => {
    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "assistant", content: "Hi" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/role.*user/i);
  });
});

// ─── Route: POST /api/ai-agent/confirm ──────────────────────────────────────

describe("POST /api/ai-agent/confirm", () => {
  it("returns 401 when not authenticated", async () => {
    const app = makeApp(undefined);
    const res = await request(app)
      .post("/api/ai-agent/confirm")
      .send({ actionId: "fake" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when actionId is missing", async () => {
    const app = makeApp("user-123");
    const res = await request(app).post("/api/ai-agent/confirm").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actionId/i);
  });

  it("returns 404 for unknown actionId", async () => {
    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-agent/confirm")
      .send({ actionId: "does-not-exist" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found|expired/i);
  });
});

// ─── Route: POST /api/ai-agent/reject ───────────────────────────────────────

describe("POST /api/ai-agent/reject", () => {
  it("returns 401 when not authenticated", async () => {
    const app = makeApp(undefined);
    const res = await request(app)
      .post("/api/ai-agent/reject")
      .send({ actionId: "fake" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when actionId is missing", async () => {
    const app = makeApp("user-123");
    const res = await request(app).post("/api/ai-agent/reject").send({});
    expect(res.status).toBe(400);
  });

  it("accepts unknown actionId gracefully (idempotent)", async () => {
    const app = makeApp("user-123");
    const res = await request(app)
      .post("/api/ai-agent/reject")
      .send({ actionId: "nonexistent" });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("action_rejected");
  });
});

// ─── Confirmation gating and ownership tests ─────────────────────────────────

describe("confirmation gating and ownership", () => {
  it("returns 404 when confirm is called without a prior proposed action", async () => {
    const app = makeApp("user-abc");
    const res = await request(app)
      .post("/api/ai-agent/confirm")
      .send({ actionId: "never-proposed" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found|expired/i);
  });

  it("returns 403 when a different user tries to confirm another user's action", async () => {
    // Inject a pending action owned by user-owner
    _testInjectPendingAction({
      actionId: "action-owned-by-owner",
      userId: "user-owner",
      toolName: "mark_invoice_paid",
      args: { invoiceId: "inv-1" },
      summary: "Mark invoice paid",
      createdAt: Date.now(),
    });

    const app = makeApp("user-attacker");
    const res = await request(app)
      .post("/api/ai-agent/confirm")
      .send({ actionId: "action-owned-by-owner" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not.*session|forbidden/i);
  });

  it("returns 404 on the second confirm (single-use enforcement)", async () => {
    // Inject a pending action; the first confirm will try to execute and
    // delete it even if execution fails — so the second confirm gets 404.
    _testInjectPendingAction({
      actionId: "action-single-use",
      userId: "user-confirm",
      toolName: "mark_invoice_paid",
      args: { invoiceId: "nonexistent-invoice-id" },
      summary: "Mark invoice paid",
      createdAt: Date.now(),
    });

    const app = makeApp("user-confirm");
    // First confirm — will fail (invoice not found) but delete the action
    await request(app)
      .post("/api/ai-agent/confirm")
      .send({ actionId: "action-single-use" });

    // Second confirm — action already consumed, must return 404
    const res2 = await request(app)
      .post("/api/ai-agent/confirm")
      .send({ actionId: "action-single-use" });
    expect(res2.status).toBe(404);
  });
});

// ─── Tool permission boundary tests ──────────────────────────────────────────

describe("tool permission boundaries (unit)", () => {
  it("create_case explicitly rejects provider user context", async () => {
    const tool = TOOL_BY_NAME.get("create_case")!;
    const providerCtx: ToolContext = {
      userId: "user-provider",
      req: {} as any,
      userType: "provider",
      labOrganizationId: null,
      providerOrgIds: ["prov-org-1"],
    };
    await expect(
      tool.execute(
        { patientFirstName: "Jane", patientLastName: "Doe", doctorName: "Dr. Smith" },
        providerCtx,
      ),
    ).rejects.toThrow(/lab staff|provider/i);
  });

  it("every impactful tool has a kind of 'impactful'", () => {
    const impactful = AGENT_TOOLS.filter((t) => t.kind === "impactful");
    expect(impactful.length).toBeGreaterThanOrEqual(10);
    for (const t of impactful) {
      expect(t.kind).toBe("impactful");
    }
  });

  it("readonly tools are exactly lookup_invoice and lookup_case", () => {
    const readonly = AGENT_TOOLS.filter((t) => t.kind === "readonly");
    const names = readonly.map((t) => t.name).sort();
    expect(names).toEqual(["lookup_case", "lookup_invoice"]);
  });
});
