/**
 * Agentic AI assistant routes.
 *
 * POST /ai-agent          — Run the tool-calling loop; returns either a text
 *                           reply (read-only tools resolved inline) or a
 *                           proposed_action card (impactful tool ready to execute).
 * POST /ai-agent/confirm  — Execute a previously proposed action after user
 *                           confirmation.
 * POST /ai-agent/reject   — Discard a proposed action without executing it.
 *
 * Authentication: bearer token or session cookie (requireAuth).
 * Rate-limiting:  shared in-memory per-user window (same as ai-chat).
 * AI key:         AI_INTEGRATIONS_OPENAI_API_KEY (same env var as ai-chat).
 */

import { type IRouter } from "express";
import OpenAI from "openai";
import { randomBytes } from "node:crypto";
import { requireAuth } from "../middlewares/auth";
import {
  AGENT_TOOLS,
  TOOL_BY_NAME,
  buildOpenAiTools,
  type ToolContext,
} from "../lib/ai-agent-tools";
import { db } from "@workspace/db";
import { organizations, organizationMemberships, pricingTiers } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { getProviderOrgIdsForUserAndLinks } from "../lib/cross-lab-doctor";
import { buildKnowledgeBlockWithMeta, buildLabMemoryBlock, buildMaterialSuggestionBlock, RETENTION_LEGAL_DISCLAIMER } from "../lib/ai-knowledge-augment";
import { learnFromExchange } from "../lib/ai-memory-learn";

// ─── Shared rate limiter (same window as ai-chat) ───────────────────────────

const _parsedLimit = parseInt(process.env.AI_CHAT_RATE_LIMIT_PER_MINUTE ?? "", 10);
const RATE_LIMIT = Number.isFinite(_parsedLimit) && _parsedLimit > 0 ? _parsedLimit : 20;
const RATE_WINDOW_MS = 60_000;
const userTimestamps = new Map<string, number[]>();

function checkRateLimit(userId: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const ts = (userTimestamps.get(userId) ?? []).filter((t) => t > windowStart);
  if (ts.length >= RATE_LIMIT) {
    const oldest = ts[0]!;
    return { allowed: false, retryAfterSeconds: Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000) };
  }
  ts.push(now);
  userTimestamps.set(userId, ts);
  return { allowed: true, retryAfterSeconds: 0 };
}

// ─── OpenAI client (shared singleton) ──────────────────────────────────────

let _cachedOpenAI: OpenAI | null | undefined;

function getAiClient(): OpenAI | null {
  if (_cachedOpenAI !== undefined) return _cachedOpenAI;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) { _cachedOpenAI = null; return null; }
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  _cachedOpenAI = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return _cachedOpenAI;
}

// ─── Pending action store (in-memory, TTL 5 min) ───────────────────────────

interface PendingAction {
  actionId: string;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  summary: string;
  createdAt: number;
}

const pendingActions = new Map<string, PendingAction>();
const PENDING_TTL_MS = 5 * 60_000; // 5 minutes

/** Inject a pending action for testing only. Never call in production code. */
export function _testInjectPendingAction(action: PendingAction): void {
  pendingActions.set(action.actionId, action);
}

function generateActionId(): string {
  return randomBytes(12).toString("hex");
}

function cleanExpiredActions(): void {
  const now = Date.now();
  for (const [id, action] of pendingActions) {
    if (now - action.createdAt > PENDING_TTL_MS) {
      pendingActions.delete(id);
    }
  }
}

// ─── Context assembly (minimal — just lab org) ─────────────────────────────

interface SystemPromptResult {
  prompt: string;
  knowledgeSectionIds: string[];
  retentionDisclaimer: boolean;
  privacyDisclaimer: boolean;
}

async function buildSystemPrompt(
  userId: string,
  userType: string,
  userMessage = "",
): Promise<SystemPromptResult> {
  let contextBlock = "";
  // Track lab org ids in scope so we can append admin-curated per-lab memory.
  const memoryLabIds: string[] = [];

  if (userType === "provider") {
    // Provider users: give them a read-only view of their linked labs.
    // Action tools are still available but scoped to their provider org.
    try {
      const { providerOrgIds } = await getProviderOrgIdsForUserAndLinks(userId);
      if (providerOrgIds.length > 0) {
        const providerOrgs = await db.query.organizations.findMany({
          where: inArray(organizations.id, providerOrgIds),
        });
        const names = providerOrgs.map((o) => o.displayName ?? o.name).join(", ");
        contextBlock = `\nYou are assisting a PROVIDER (doctor/practice) user.
LINKED PRACTICES: ${names}
You can look up cases and invoices for this provider. Write operations (mark paid, void, etc.) are not available for provider accounts — if asked, explain politely and suggest contacting the lab directly.`;
      } else {
        contextBlock = `\nYou are assisting a PROVIDER (doctor/practice) user with no linked labs yet.`;
      }
    } catch {
      // Non-fatal: proceed without provider context
    }
  } else {
    // Lab staff: look up the lab org and available pricing tiers.
    const memberships = await db
      .select({ labId: organizationMemberships.labId })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.status, "active"),
          eq(organizations.type, "lab"),
        ),
      )
      .limit(1);

    if (memberships.length > 0) {
      const labId = memberships[0]!.labId;
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, labId),
      });
      if (org) {
        memoryLabIds.push(labId);
        const tiers = await db.query.pricingTiers.findMany({
          where: eq(pricingTiers.labOrganizationId, labId),
        });
        contextBlock = `\nLAB: ${org.displayName ?? org.name} (ID: ${labId})
PRICING TIERS: ${tiers.map((t) => t.name).join(", ") || "none"}`;
      }
    }
  }

  const isProvider = userType === "provider";

  // Additive prompt augmentation: curated reference knowledge, material/shade
  // suggestion guidance, and admin-curated per-lab memory. All resolve to empty
  // strings when nothing relevant exists, leaving the prompt unchanged.
  const knowledgeMeta = buildKnowledgeBlockWithMeta(userMessage);
  const materialBlock = buildMaterialSuggestionBlock(userMessage);
  const memoryBlock = await buildLabMemoryBlock(memoryLabIds);

  const prompt = `You are Maynard, an action-taking assistant for dental lab management.
You can answer questions AND perform real operations using the tools available to you.
Today's date: ${new Date().toLocaleDateString()}.
${contextBlock}
${knowledgeMeta.block}${materialBlock}${memoryBlock}

IMPORTANT RULES:
- For factual questions, answer directly using your tools or known context.
- For operations that change data (mark paid, void, merge, send statements, etc.) always call the appropriate tool — do NOT describe how to do it manually.${isProvider ? "\n- You are in provider mode. Limit yourself to read-only tools (lookup_case, lookup_invoice) unless the user is clearly a lab admin." : ""}
- When you call an impactful tool, the system will pause and ask the user to confirm before anything is changed. You do not need to warn the user separately.
- Handle ONE impactful action per turn. If the user asks for multiple impactful actions, propose the first one and tell the user to confirm it before you proceed with the next.
- Be concise and action-oriented. After calling tools, summarize what happened or what is proposed.
- If you cannot complete a request with the available tools, explain clearly what you can and cannot do.`;

  return { prompt, knowledgeSectionIds: knowledgeMeta.sectionIds, retentionDisclaimer: knowledgeMeta.retentionDisclaimer, privacyDisclaimer: knowledgeMeta.privacyDisclaimer };
}

// ─── Route registration ──────────────────────────────────────────────────────

export function registerAiAgentRoutes(router: IRouter): void {

  /** POST /ai-agent — main agentic endpoint */
  router.post("/ai-agent", requireAuth, async (req: any, res: any) => {
    const userId: string = req.user.id;

    const rl = checkRateLimit(userId);
    if (!rl.allowed) {
      res.set("Retry-After", String(rl.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many requests. Please slow down.",
        retryAfterSeconds: rl.retryAfterSeconds,
      });
    }

    const openai = getAiClient();
    if (!openai) {
      return res.status(503).json({
        error:
          "AI assistant is not configured on this server. Please ask your administrator to set AI_INTEGRATIONS_OPENAI_API_KEY.",
      });
    }

    const body = req.body as {
      messages?: Array<{ role: "user" | "assistant"; content: string }>;
      caseId?: string;
      caseIds?: string[];
    };

    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }
    const lastMsg = body.messages[body.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "user") {
      return res.status(400).json({ error: "Last message must have role 'user'" });
    }

    const userType: string = req.user.userType ?? "lab";

    // Resolve org context in parallel for both lab and provider users.
    const [labMemberships, providerCtx] = await Promise.all([
      userType !== "provider"
        ? db
            .select({ labId: organizationMemberships.labId })
            .from(organizationMemberships)
            .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
            .where(
              and(
                eq(organizationMemberships.userId, userId),
                eq(organizationMemberships.status, "active"),
                eq(organizations.type, "lab"),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
      userType === "provider"
        ? getProviderOrgIdsForUserAndLinks(userId).catch(() => ({ providerOrgIds: [] as string[] }))
        : Promise.resolve({ providerOrgIds: [] as string[] }),
    ]);

    const labOrganizationId = (labMemberships as any[])[0]?.labId ?? null;
    const providerOrgIds: string[] = (providerCtx as any).providerOrgIds ?? [];

    const toolCtx: ToolContext = { userId, req, userType, labOrganizationId, providerOrgIds };

    // Auto-learn candidate memory entries from the exchange (lab users only).
    // Fire-and-forget; never blocks or alters the response contract.
    const learnUserMessage = String(lastMsg.content ?? "");
    const fireLearn = (replyContent: string) => {
      if (userType === "provider" || !labOrganizationId) return;
      learnFromExchange({
        openai,
        labIds: [labOrganizationId],
        userMessage: learnUserMessage,
        assistantMessage: replyContent,
        userId,
      }).catch((err) => {
        req.log?.error({ err }, "[AI AGENT] memory-learn error");
      });
    };

    const systemPromptResult = await buildSystemPrompt(
      userId,
      userType,
      String(lastMsg.content ?? ""),
    );
    const { prompt: systemPrompt, knowledgeSectionIds, retentionDisclaimer, privacyDisclaimer } = systemPromptResult;

    // Log which knowledge sections were included for audit purposes.
    if (knowledgeSectionIds.length > 0 || retentionDisclaimer || privacyDisclaimer) {
      req.log?.info(
        { knowledgeSectionIds, retentionDisclaimer, privacyDisclaimer },
        "[AI AGENT] knowledge sections used in prompt",
      );
    }

    const safeMessages = body.messages.slice(-20).map((m) => ({
      role: m.role as "user" | "assistant",
      content: String(m.content ?? "").slice(0, 4000),
    }));

    const openAiTools = buildOpenAiTools();

    // Tool-calling loop — runs up to 6 iterations
    const loopMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...safeMessages,
    ];

    // Track readonly tool outputs to include in the final reply for client rendering
    const accumulatedToolOutputs: Array<{ name: string; result: unknown }> = [];

    const MAX_ITERATIONS = 6;
    let iterations = 0;

    try {
      while (iterations < MAX_ITERATIONS) {
        iterations++;

        const completion = await openai.chat.completions.create({
          model: "gpt-5-mini",
          messages: loopMessages,
          tools: openAiTools,
          tool_choice: "auto",
          max_completion_tokens: 4000,
        });

        const choice = completion.choices[0];
        if (!choice) break;

        const msg = choice.message;
        loopMessages.push(msg as any);

        // No tool calls → return the text reply (with any accumulated tool outputs)
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          const replyContent = msg.content ?? "I'm not sure how to help with that.";
          fireLearn(replyContent);
          return res.json({
            type: "reply",
            content: replyContent,
            ...(accumulatedToolOutputs.length > 0 ? { toolOutputs: accumulatedToolOutputs } : {}),
            ...(knowledgeSectionIds.length > 0 ? { knowledgeSectionIds } : {}),
            ...(retentionDisclaimer ? { retentionDisclaimer, disclaimer: RETENTION_LEGAL_DISCLAIMER } : {}),
            ...(privacyDisclaimer ? { privacyDisclaimer } : {}),
          });
        }

        // Process tool calls
        const toolResults: OpenAI.ChatCompletionToolMessageParam[] = [];
        let proposedAction: {
          actionId: string;
          toolName: string;
          summary: string;
          args: Record<string, unknown>;
        } | null = null;

        for (const toolCall of msg.tool_calls) {
          const fn = (toolCall as any).function as { name: string; arguments: string };
          const toolName = fn.name;
          const tool = TOOL_BY_NAME.get(toolName);

          if (!tool) {
            toolResults.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
            });
            continue;
          }

          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(fn.arguments ?? "{}");
          } catch {
            toolResults.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: "Invalid tool arguments." }),
            });
            continue;
          }

          if (tool.kind === "readonly") {
            // Execute inline
            try {
              const result = await tool.execute(args, toolCtx);
              accumulatedToolOutputs.push({ name: toolName, result });
              toolResults.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: JSON.stringify(result),
              });
            } catch (err: any) {
              toolResults.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: err?.message ?? "Tool execution failed." }),
              });
            }
          } else {
            // Impactful — return as proposed action (first one wins)
            if (!proposedAction) {
              cleanExpiredActions();
              const actionId = generateActionId();
              let summary = `${toolName} action`;
              try {
                summary = await tool.summarize(args, toolCtx);
              } catch {
                // fallback summary
              }
              pendingActions.set(actionId, {
                actionId,
                userId,
                toolName,
                args,
                summary,
                createdAt: Date.now(),
              });
              proposedAction = { actionId, toolName, summary, args };
            }
            // Put a placeholder in tool results so the loop doesn't stall
            toolResults.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ status: "awaiting_confirmation", actionId: proposedAction.actionId }),
            });
          }
        }

        // If we have a proposed action, return it immediately without looping further
        if (proposedAction) {
          return res.json({
            type: "proposed_action",
            actionId: proposedAction.actionId,
            toolName: proposedAction.toolName,
            summary: proposedAction.summary,
            args: proposedAction.args,
          });
        }

        // Add tool results and continue loop
        loopMessages.push(...toolResults);
      }

      // Loop exhausted — return final message if present
      const last = loopMessages[loopMessages.length - 1] as any;
      const content = last?.content ?? "I completed the requested lookups. Is there anything else?";
      fireLearn(content);
      return res.json({
        type: "reply",
        content,
        ...(accumulatedToolOutputs.length > 0 ? { toolOutputs: accumulatedToolOutputs } : {}),
        ...(knowledgeSectionIds.length > 0 ? { knowledgeSectionIds } : {}),
        ...(retentionDisclaimer ? { retentionDisclaimer, disclaimer: RETENTION_LEGAL_DISCLAIMER } : {}),
        ...(privacyDisclaimer ? { privacyDisclaimer } : {}),
      });
    } catch (err: any) {
      req.log?.error({ err }, "[AI AGENT] OpenAI error");
      return res.status(500).json({ error: "AI request failed. Please try again." });
    }
  });

  /** POST /ai-agent/confirm — execute a previously proposed impactful action */
  router.post("/ai-agent/confirm", requireAuth, async (req: any, res: any) => {
    const userId: string = req.user.id;
    const { actionId } = req.body as { actionId?: string };

    if (!actionId) {
      return res.status(400).json({ error: "actionId is required" });
    }

    cleanExpiredActions();
    const pending = pendingActions.get(actionId);

    if (!pending) {
      return res.status(404).json({
        error: "Proposed action not found or expired. Please send your request again.",
      });
    }

    // Verify ownership
    if (pending.userId !== userId) {
      return res.status(403).json({ error: "This action was not proposed for your session." });
    }

    // Delete before executing — single-use, prevents double-execution
    pendingActions.delete(actionId);

    const tool = TOOL_BY_NAME.get(pending.toolName);
    if (!tool) {
      return res.status(500).json({ error: "Tool not found." });
    }

    const userType: string = req.user.userType ?? "lab";
    const [labMemberships, providerCtx] = await Promise.all([
      userType !== "provider"
        ? db
            .select({ labId: organizationMemberships.labId })
            .from(organizationMemberships)
            .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
            .where(
              and(
                eq(organizationMemberships.userId, userId),
                eq(organizationMemberships.status, "active"),
                eq(organizations.type, "lab"),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
      userType === "provider"
        ? getProviderOrgIdsForUserAndLinks(userId).catch(() => ({ providerOrgIds: [] as string[] }))
        : Promise.resolve({ providerOrgIds: [] as string[] }),
    ]);
    const labOrganizationId = (labMemberships as any[])[0]?.labId ?? null;
    const providerOrgIds: string[] = (providerCtx as any).providerOrgIds ?? [];
    const toolCtx: ToolContext = { userId, req, userType, labOrganizationId, providerOrgIds };

    try {
      const result = await tool.execute(pending.args, toolCtx);
      return res.json({
        type: "action_result",
        success: true,
        toolName: pending.toolName,
        summary: pending.summary,
        result,
      });
    } catch (err: any) {
      req.log?.error({ err }, `[AI AGENT] Tool execution failed: ${pending.toolName}`);
      return res.status(400).json({
        type: "action_result",
        success: false,
        toolName: pending.toolName,
        summary: pending.summary,
        error: err?.message ?? "Action failed. Please try again.",
      });
    }
  });

  /** POST /ai-agent/reject — discard a proposed action */
  router.post("/ai-agent/reject", requireAuth, async (req: any, res: any) => {
    const userId: string = req.user.id;
    const { actionId } = req.body as { actionId?: string };

    if (!actionId) return res.status(400).json({ error: "actionId is required" });

    const pending = pendingActions.get(actionId);
    if (pending && pending.userId === userId) {
      pendingActions.delete(actionId);
    }

    return res.json({ type: "action_rejected", actionId });
  });
}
