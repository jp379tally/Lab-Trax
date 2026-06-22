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
import { createUserRateLimit } from "../lib/rate-limit";

// ─── Per-user rate limiter: 10 agent calls per minute ───────────────────────

const aiAgentRateLimit = createUserRateLimit({
  windowMs: 60_000,
  max: 10,
  message: "Too many requests. Please slow down.",
});

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
  router.post("/ai-agent", requireAuth, aiAgentRateLimit, async (req: any, res: any) => {
    const userId: string = req.user.id;

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

  /**
   * POST /ai-agent/stream — SSE streaming agentic endpoint.
   *
   * Runs the same tool-calling loop as POST /ai-agent but delivers output via
   * Server-Sent Events so the client can render tokens in real time:
   *   data: {"token":"…"}           — one text token
   *   data: {"proposed_action":{…}} — model wants to take an impactful action;
   *                                   client shows ConfirmCard (confirm via
   *                                   POST /ai-agent/confirm)
   *   data: {"done":true,…}         — end of text response (with optional meta)
   *   data: {"error":"…"}           — terminal error
   *
   * Confirm/reject still go to POST /ai-agent/confirm and POST /ai-agent/reject.
   */
  router.post("/ai-agent/stream", requireAuth, aiAgentRateLimit, async (req: any, res: any) => {
    const userId: string = req.user.id;

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

    // Resolve org context in parallel (identical to POST /ai-agent)
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
        req.log?.error({ err }, "[AI AGENT STREAM] memory-learn error");
      });
    };

    let systemPromptResult: Awaited<ReturnType<typeof buildSystemPrompt>>;
    try {
      systemPromptResult = await buildSystemPrompt(userId, userType, learnUserMessage);
    } catch (err: any) {
      req.log?.error({ err }, "[AI AGENT STREAM] system prompt build error");
      return res.status(500).json({ error: "Failed to assemble context. Please try again." });
    }

    const { prompt: systemPrompt, knowledgeSectionIds, retentionDisclaimer, privacyDisclaimer } = systemPromptResult;

    if (knowledgeSectionIds.length > 0 || retentionDisclaimer || privacyDisclaimer) {
      req.log?.info(
        { knowledgeSectionIds, retentionDisclaimer, privacyDisclaimer },
        "[AI AGENT STREAM] knowledge sections used in prompt",
      );
    }

    const safeMessages = body.messages.slice(-20).map((m) => ({
      role: m.role as "user" | "assistant",
      content: String(m.content ?? "").slice(0, 4000),
    }));

    const openAiTools = buildOpenAiTools();
    const loopMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...safeMessages,
    ];

    // Track readonly tool outputs to include in the done event for client rendering
    const accumulatedToolOutputs: Array<{ name: string; result: unknown }> = [];

    // ── SSE headers — set before any streaming begins ──────────────────────
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendEvent = (payload: object) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const MAX_ITERATIONS = 6;
    let iterations = 0;

    try {
      while (iterations < MAX_ITERATIONS) {
        iterations++;

        // Use stream:true so text tokens are delivered to the client in real time.
        // Tool call deltas are accumulated below and processed after the stream.
        const stream = await openai.chat.completions.create({
          model: "gpt-5-mini",
          messages: loopMessages,
          tools: openAiTools,
          tool_choice: "auto",
          max_completion_tokens: 4000,
          stream: true,
        });

        let fullContent = "";
        // Sparse array indexed by tool_call delta index
        const accToolCalls: Array<{
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }> = [];

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            fullContent += delta.content;
            sendEvent({ token: delta.content });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!accToolCalls[idx]) {
                accToolCalls[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
              }
              if (tc.id) accToolCalls[idx]!.id = tc.id;
              if (tc.function?.name) accToolCalls[idx]!.function.name += tc.function.name;
              if (tc.function?.arguments) accToolCalls[idx]!.function.arguments += tc.function.arguments;
            }
          }
        }

        const completedToolCalls = accToolCalls.filter((tc) => tc && tc.id);

        // Push reconstructed assistant message into loop history
        loopMessages.push({
          role: "assistant",
          content: fullContent || null,
          ...(completedToolCalls.length > 0 ? { tool_calls: completedToolCalls } : {}),
        } as OpenAI.ChatCompletionMessageParam);

        // No tool calls → text reply is complete
        if (completedToolCalls.length === 0) {
          if (!fullContent) {
            sendEvent({ token: "I'm not sure how to help with that." });
          }
          fireLearn(fullContent || "I'm not sure how to help with that.");
          sendEvent({
            done: true,
            ...(accumulatedToolOutputs.length > 0 ? { toolOutputs: accumulatedToolOutputs } : {}),
            ...(knowledgeSectionIds.length > 0 ? { knowledgeSectionIds } : {}),
            ...(retentionDisclaimer ? { retentionDisclaimer: true, disclaimer: RETENTION_LEGAL_DISCLAIMER } : {}),
            ...(privacyDisclaimer ? { privacyDisclaimer: true } : {}),
          });
          res.end();
          return;
        }

        // ── Process tool calls ──────────────────────────────────────────────
        const toolResults: OpenAI.ChatCompletionToolMessageParam[] = [];
        let proposedAction: {
          actionId: string;
          toolName: string;
          summary: string;
          args: Record<string, unknown>;
        } | null = null;

        for (const toolCall of completedToolCalls) {
          const toolName = toolCall.function.name;
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
            args = JSON.parse(toolCall.function.arguments || "{}");
          } catch {
            toolResults.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: "Invalid tool arguments." }),
            });
            continue;
          }

          if (tool.kind === "readonly") {
            sendEvent({ tool_call: { name: toolName } });
            const rawTimeout = Number(process.env.AI_TOOL_TIMEOUT_MS);
            const TOOL_TIMEOUT_MS = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 10_000;
            try {
              let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
              const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(
                  () => reject(new Error(`Tool "${toolName}" timed out after ${TOOL_TIMEOUT_MS / 1000} s.`)),
                  TOOL_TIMEOUT_MS,
                );
              });
              let result: Awaited<ReturnType<typeof tool.execute>>;
              try {
                result = await Promise.race([tool.execute(args, toolCtx), timeoutPromise]);
              } finally {
                clearTimeout(timeoutHandle);
              }
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
            // Impactful — propose action (first one wins)
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
            toolResults.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                status: "awaiting_confirmation",
                actionId: proposedAction.actionId,
              }),
            });
          }
        }

        // Emit proposed_action and stop — client shows ConfirmCard
        if (proposedAction) {
          sendEvent({
            proposed_action: {
              actionId: proposedAction.actionId,
              toolName: proposedAction.toolName,
              summary: proposedAction.summary,
              args: proposedAction.args,
            },
          });
          res.end();
          return;
        }

        // All tools were readonly — continue loop with their results
        loopMessages.push(...toolResults);
      }

      // Loop exhausted without a terminal reply — close cleanly
      const last = loopMessages[loopMessages.length - 1] as any;
      const exhaustedContent: string = typeof last?.content === "string" ? last.content : "";
      if (exhaustedContent) fireLearn(exhaustedContent);
      sendEvent({
        done: true,
        ...(accumulatedToolOutputs.length > 0 ? { toolOutputs: accumulatedToolOutputs } : {}),
        ...(knowledgeSectionIds.length > 0 ? { knowledgeSectionIds } : {}),
        ...(retentionDisclaimer ? { retentionDisclaimer: true, disclaimer: RETENTION_LEGAL_DISCLAIMER } : {}),
        ...(privacyDisclaimer ? { privacyDisclaimer: true } : {}),
      });
      res.end();
    } catch (err: any) {
      req.log?.error({ err }, "[AI AGENT STREAM] OpenAI error");
      sendEvent({ error: "AI request failed. Please try again." });
      res.end();
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
