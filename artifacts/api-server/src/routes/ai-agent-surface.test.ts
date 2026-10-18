/**
 * Smoke tests for the appSurface boundary added to the AI agent.
 *
 * Coverage:
 *  - (a) Provider-surface context calling a lab-only tool throws HttpError(403)
 *  - (b) Lab-surface context calling the same tool proceeds past the surface guard
 *  - (c) POST /ai-agent system prompt includes the correct APP SURFACE string
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import bodyParser from "body-parser";
import { TOOL_BY_NAME, type ToolContext } from "../lib/ai-agent-tools";
import { HttpError } from "../lib/http";
import { registerAiAgentRoutes } from "./ai-agent";

// ─── OpenAI mock — captures the system message for surface-string assertion ──

const capturedSystemMessages: string[] = [];

const { mockCompletionsCreate } = vi.hoisted(() => {
  const mockCompletionsCreate = vi.fn().mockImplementation((params: any) => {
    // Capture the system message content for (c)
    const sysMsg = params?.messages?.find((m: any) => m.role === "system");
    if (sysMsg?.content) capturedSystemMessages.push(sysMsg.content);
    return Promise.resolve({
      choices: [
        {
          message: { content: "Mocked reply.", tool_calls: undefined },
          finish_reason: "stop",
        },
      ],
    });
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
}));

vi.mock("../lib/rate-limit", () => ({
  createUserRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../lib/ai-knowledge-augment", () => ({
  buildKnowledgeBlockWithMeta: () => ({ block: "", sectionIds: [], retentionDisclaimer: false, privacyDisclaimer: false }),
  buildLabMemoryBlock: async () => "",
  buildMaterialSuggestionBlock: () => "",
  RETENTION_LEGAL_DISCLAIMER: "",
}));

vi.mock("../lib/ai-chat-history", () => ({
  persistAiChatExchange: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/rbac", () => ({
  requireAnyRole: vi.fn().mockResolvedValue({ role: "admin" }),
  ADMIN_ROLES: ["owner", "admin"],
  BILLING_ROLES: ["owner", "admin", "billing"],
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProviderCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: "provider-user-1",
    req: {
      get: () => undefined,
      ip: "127.0.0.1",
      headers: {},
    } as never,
    userType: "provider",
    appSurface: "provider_portal",
    labOrganizationId: null,
    providerOrgIds: ["prov-org-1"],
    ...overrides,
  };
}

function makeLabCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: "lab-user-1",
    req: {
      get: () => undefined,
      ip: "127.0.0.1",
      headers: {},
    } as never,
    userType: "lab",
    appSurface: "labtrax",
    labOrganizationId: "lab-org-1",
    providerOrgIds: [],
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.use(bodyParser.json());
  const router = express.Router();
  registerAiAgentRoutes(router);
  app.use(router);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("appSurface boundary — tool-level guards", () => {
  const labOnlyToolNames = [
    "create_case",
    "void_invoice",
    "send_statements",
    "merge_doctors",
    "set_practice_pricing_tier",
    "create_pricing_override",
    "update_case_status",
    "update_case",
    "reset_invoice_layout",
  ] as const;

  describe("(a) provider_portal surface is blocked from lab-only tools with HttpError(403)", () => {
    for (const toolName of labOnlyToolNames) {
      it(`blocks ${toolName}`, async () => {
        const tool = TOOL_BY_NAME.get(toolName);
        expect(tool, `tool "${toolName}" not found in registry`).toBeDefined();

        const providerCtx = makeProviderCtx();
        let thrown: unknown;
        try {
          // Provide minimal args that satisfy string casts so the guard runs first.
          await tool!.execute(
            { invoiceId: "x", reason: "r", sourceDoctorName: "a", targetDoctorName: "b",
              practiceNameOrId: "p", tierName: "t", doctorName: "d",
              caseId: "c", status: "received",
              patientFirstName: "F", patientLastName: "L" },
            providerCtx,
          );
        } catch (err) {
          thrown = err;
        }

        expect(thrown, `${toolName} should throw for provider_portal surface`).toBeDefined();
        expect(thrown).toBeInstanceOf(HttpError);
        expect((thrown as HttpError).statusCode).toBe(403);
      });
    }
  });

  describe("(b) labtrax surface passes the surface guard (may fail later on DB/RBAC — that is fine)", () => {
    // We only verify that the guard itself does NOT throw HttpError(403).
    // The tool will likely throw a different error (DB mock returns empty sets)
    // but the surface guard must not block it.
    for (const toolName of labOnlyToolNames) {
      it(`does not block ${toolName} for labtrax surface`, async () => {
        const tool = TOOL_BY_NAME.get(toolName);
        expect(tool).toBeDefined();

        const labCtx = makeLabCtx();
        let thrown: unknown;
        try {
          await tool!.execute(
            { invoiceId: "x", reason: "r", sourceDoctorName: "a", targetDoctorName: "b",
              practiceNameOrId: "p", tierName: "t", doctorName: "d",
              caseId: "c", status: "received",
              patientFirstName: "F", patientLastName: "L" },
            labCtx,
          );
        } catch (err) {
          thrown = err;
        }

        // If it threw, it must NOT be a surface-boundary 403.
        if (thrown instanceof HttpError) {
          expect((thrown as HttpError).statusCode).not.toBe(403);
        }
        // (A non-HttpError error from DB mocks is expected and acceptable.)
      });
    }
  });
});

describe("(c) System prompt contains the correct APP SURFACE string", () => {
  beforeEach(() => {
    capturedSystemMessages.length = 0;
  });

  it("includes APP SURFACE: labtrax for a lab user", async () => {
    // The auth mock at the top of this file always calls next() when req.user is set.
    // We inject req.user via a pre-middleware so requireAuth passes through.
    const app = express();
    app.use(bodyParser.json());
    app.use((req: any, _res: any, next: any) => {
      req.user = { id: "u1", userType: "lab" };
      next();
    });
    const router = express.Router();
    registerAiAgentRoutes(router);
    app.use(router);

    await request(app)
      .post("/ai-agent")
      .send({ messages: [{ role: "user", content: "hello from lab" }] });

    expect(capturedSystemMessages.some((m) => m.includes("APP SURFACE: labtrax"))).toBe(true);
  });

  it("includes APP SURFACE: provider_portal for a provider user", async () => {
    const app = express();
    app.use(bodyParser.json());
    app.use((req: any, _res: any, next: any) => {
      req.user = { id: "u2", userType: "provider" };
      next();
    });
    const router = express.Router();
    registerAiAgentRoutes(router);
    app.use(router);

    capturedSystemMessages.length = 0;
    await request(app)
      .post("/ai-agent")
      .send({ messages: [{ role: "user", content: "hello from provider" }] });

    expect(capturedSystemMessages.some((m) => m.includes("APP SURFACE: provider_portal"))).toBe(true);
  });
});
