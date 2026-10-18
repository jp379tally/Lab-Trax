/**
 * Audit logging tests for the LabTrax Assistant agent tool-call loop.
 *
 * Coverage:
 * - A successful readonly tool call (lookup_invoice, provider user) writes an
 *   audit row with action="ai_tool_call", allowed=true, toolName set.
 * - A denied tool call (lab user, no lab membership → requireLabId throws)
 *   writes an audit row with action="ai_tool_call", allowed=false.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import bodyParser from "body-parser";
import { registerAiAgentRoutes } from "./ai-agent";

// ─── writeAuditLog spy ────────────────────────────────────────────────────────

const { mockWriteAuditLog } = vi.hoisted(() => {
  const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
  return { mockWriteAuditLog };
});

vi.mock("../lib/audit", () => ({
  writeAuditLog: mockWriteAuditLog,
}));

// ─── OpenAI mock ──────────────────────────────────────────────────────────────
// First call returns a tool_call for lookup_invoice.
// Second call returns a plain text reply so the loop terminates.

const { mockCompletionsCreate } = vi.hoisted(() => {
  const mockCompletionsCreate = vi.fn();
  return { mockCompletionsCreate };
});

vi.mock("openai", () => {
  const create = mockCompletionsCreate;
  function OpenAI(this: any) {
    this.chat = { completions: { create } };
  }
  return { default: OpenAI };
});

vi.mock("../lib/ai-openai-client", () => ({
  getAiClient: () => ({
    chat: { completions: { create: mockCompletionsCreate } },
  }),
}));

// ─── @workspace/db mock ───────────────────────────────────────────────────────

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

// ─── Supporting mocks ─────────────────────────────────────────────────────────

vi.mock("../lib/cross-lab-doctor", () => ({
  getProviderOrgIdsForUserAndLinks: vi.fn().mockResolvedValue({ providerOrgIds: ["org-provider-1"] }),
}));

vi.mock("../lib/ai-memory-learn", () => ({
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/ai-chat-history", () => ({
  persistAiChatExchange: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/ai-knowledge-augment", () => ({
  buildKnowledgeBlockWithMeta: vi.fn().mockReturnValue({ block: "", sectionIds: [], retentionDisclaimer: false, privacyDisclaimer: false }),
  buildLabMemoryBlock: vi.fn().mockResolvedValue(""),
  buildMaterialSuggestionBlock: vi.fn().mockReturnValue(""),
  RETENTION_LEGAL_DISCLAIMER: "",
}));

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toolCallReply(toolName: string, argsObj: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "call_audit_test_1",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify(argsObj),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

const textReply = {
  choices: [
    {
      message: { content: "Done.", tool_calls: undefined },
      finish_reason: "stop",
    },
  ],
};

function makeApp(userId: string, userType = "lab") {
  const app = express();
  app.use(bodyParser.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { id: userId, userType };
    next();
  });
  const router = express.Router();
  registerAiAgentRoutes(router);
  app.use("/api", router);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AI agent tool-call audit logging", () => {
  beforeEach(() => {
    mockWriteAuditLog.mockClear();
  });

  it("writes an allowed=true audit row for a successful readonly tool call", async () => {
    // Provider user so lookup_invoice takes the provider path (no RBAC gate).
    // The db mock returns [] so lookup_invoice returns {found:false} — still success (no throw).
    mockCompletionsCreate
      .mockResolvedValueOnce(toolCallReply("lookup_invoice", { invoiceNumber: "INV-001" }))
      .mockResolvedValueOnce(textReply);

    const app = makeApp("user-provider-1", "provider");
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "Find invoice INV-001" }] });

    expect(res.status).toBe(200);

    // The agent-level audit call (writeAuditLog may also be called by other
    // components; we assert that at least one call matches our audit record).
    const agentAuditCall = mockWriteAuditLog.mock.calls.find(
      ([input]: [any]) =>
        input.action === "ai_tool_call" &&
        input.entityType === "lookup_invoice" &&
        input.metadataJson?.toolName === "lookup_invoice" &&
        input.metadataJson?.allowed === true,
    );
    expect(agentAuditCall).toBeDefined();
    const auditInput = agentAuditCall![0];
    expect(auditInput.metadataJson.userType).toBe("provider");
  });

  it("writes an allowed=false audit row when a tool call is denied", async () => {
    // Lab user with NO lab membership (db mock returns [] for everything).
    // lookup_invoice.execute will call requireLabId → queries DB → gets [] →
    // throws "You are not a member of any active lab." which is caught by the
    // agent loop and should produce an allowed=false audit record.
    mockCompletionsCreate
      .mockResolvedValueOnce(toolCallReply("lookup_invoice", { invoiceNumber: "INV-999" }))
      .mockResolvedValueOnce(textReply);

    const app = makeApp("user-lab-no-membership", "lab");
    const res = await request(app)
      .post("/api/ai-agent")
      .send({ messages: [{ role: "user", content: "Find invoice INV-999" }] });

    // Route still returns 200 — the tool error is reported back to the model
    expect(res.status).toBe(200);

    const agentAuditCall = mockWriteAuditLog.mock.calls.find(
      ([input]: [any]) =>
        input.action === "ai_tool_call" &&
        input.entityType === "lookup_invoice" &&
        input.metadataJson?.toolName === "lookup_invoice" &&
        input.metadataJson?.allowed === false,
    );
    expect(agentAuditCall).toBeDefined();
    const auditInput = agentAuditCall![0];
    expect(auditInput.metadataJson.userType).toBe("lab");
  });
});
