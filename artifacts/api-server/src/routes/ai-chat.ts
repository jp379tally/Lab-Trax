import { type IRouter } from "express";
import OpenAI from "openai";
import { db } from "@workspace/db";
import {
  cases,
  organizations,
  organizationMemberships,
  organizationConnections,
  pricingTiers,
  pricingOverrides,
  caseRestorations,
  aiChatHistory,
  caseNotes,
  caseAttachments,
} from "@workspace/db";
import { eq, and, inArray, isNull, desc, sql } from "drizzle-orm";
import { getProviderOrgIdsForUserAndLinks } from "../lib/cross-lab-doctor";
import { requireAuth } from "../middlewares/auth";
import { normalizeDoctor } from "../lib/pricing";
import { wrapDbError } from "../lib/http";
import { buildKnowledgeBlockWithMeta, buildLabMemoryBlock, buildMaterialSuggestionBlock, RETENTION_LEGAL_DISCLAIMER } from "../lib/ai-knowledge-augment";
import { learnFromExchange } from "../lib/ai-memory-learn";
import { randomBytes } from "node:crypto";
import { createUserRateLimit } from "../lib/rate-limit";

// 20 messages per minute per user
const aiChatRateLimit = createUserRateLimit({
  windowMs: 60_000,
  max: 20,
  message: "Too many requests. Please slow down and try again in a moment.",
});

let _cachedOpenAI: OpenAI | null | undefined;

function getAiClient(): OpenAI | null {
  if (_cachedOpenAI !== undefined) return _cachedOpenAI;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) {
    _cachedOpenAI = null;
    return null;
  }
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  _cachedOpenAI = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return _cachedOpenAI;
}

/** Max stored messages per user (50 turns = 100 messages) */
const MAX_HISTORY_ROWS = 100;

/** Number of recent messages to load and send to the AI as context */
const HISTORY_LOAD_LIMIT = 50;

function generateHistoryId(): string {
  return randomBytes(16).toString("hex");
}

/** Persist a user+assistant exchange and trim old rows */
async function persistExchange(
  userId: string,
  userContent: string,
  assistantContent: string,
  knowledgeSectionIds?: string[],
  retentionDisclaimer?: boolean,
): Promise<void> {
  const now = new Date();
  await db.insert(aiChatHistory).values([
    {
      id: generateHistoryId(),
      userId,
      role: "user",
      content: userContent,
      createdAt: now,
    },
    {
      id: generateHistoryId(),
      userId,
      role: "assistant",
      content: assistantContent,
      ...(knowledgeSectionIds && knowledgeSectionIds.length > 0
        ? { knowledgeSectionIds }
        : {}),
      ...(retentionDisclaimer ? { retentionDisclaimer: true } : {}),
      createdAt: new Date(now.getTime() + 1),
    },
  ]).catch((err: unknown): never => wrapDbError(err, {
    fallback: "Failed to persist AI chat history.",
  }));

  // Keep only the most recent MAX_HISTORY_ROWS rows per user
  const subq = db
    .select({ id: aiChatHistory.id })
    .from(aiChatHistory)
    .where(eq(aiChatHistory.userId, userId))
    .orderBy(desc(aiChatHistory.createdAt))
    .limit(MAX_HISTORY_ROWS);

  await db
    .delete(aiChatHistory)
    .where(
      and(
        eq(aiChatHistory.userId, userId),
        sql`${aiChatHistory.id} NOT IN (${subq})`,
      ),
    );
}

/** Load recent history for a user, oldest-first for chat display */
async function loadHistory(
  userId: string,
): Promise<Array<{ id: string; role: string; content: string; knowledgeSectionIds: string[] | null; retentionDisclaimer: boolean | null; createdAt: Date }>> {
  const rows = await db
    .select({
      id: aiChatHistory.id,
      role: aiChatHistory.role,
      content: aiChatHistory.content,
      knowledgeSectionIds: aiChatHistory.knowledgeSectionIds,
      retentionDisclaimer: aiChatHistory.retentionDisclaimer,
      createdAt: aiChatHistory.createdAt,
    })
    .from(aiChatHistory)
    .where(eq(aiChatHistory.userId, userId))
    .orderBy(desc(aiChatHistory.createdAt))
    .limit(HISTORY_LOAD_LIMIT);

  return rows.reverse();
}

/** Canonical terminal/completed statuses in LabTrax */
const TERMINAL_STATUSES = new Set(["complete", "shipped", "delivered"]);

async function getActiveLabIds(userId: string): Promise<string[]> {
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
    );
  const ids = new Set<string>();
  for (const row of memberships) {
    if (row.labId) ids.add(row.labId);
  }
  return Array.from(ids);
}

async function buildLabContext(labId: string): Promise<string> {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, labId))
    .limit(1);
  if (!org) return "Lab organization not found.";

  const caseRows = await db
    .select()
    .from(cases)
    .where(and(eq(cases.labOrganizationId, labId), isNull(cases.deletedAt)))
    .limit(250);

  const caseIds = caseRows.map((c) => c.id);
  let restRows: any[] = [];
  if (caseIds.length > 0) {
    restRows = (await db
      .select()
      .from(caseRestorations)
      .where(inArray(caseRestorations.caseId, caseIds))) as any[];
  }

  const resByCase = new Map<string, any[]>();
  for (const r of restRows) {
    if (!resByCase.has(r.caseId)) resByCase.set(r.caseId, []);
    resByCase.get(r.caseId)!.push(r);
  }

  const tiers = await db
    .select()
    .from(pricingTiers)
    .where(eq(pricingTiers.labOrganizationId, labId));

  const overrideRows = await db
    .select()
    .from(pricingOverrides)
    .where(
      and(
        eq(pricingOverrides.labOrganizationId, labId),
        isNull(pricingOverrides.deletedAt),
      ),
    );

  const completedCases = caseRows.filter((c) =>
    TERMINAL_STATUSES.has((c.status ?? "").toLowerCase()),
  );
  let avgTurnaround: number | null = null;
  if (completedCases.length > 0) {
    const days = completedCases
      .map((c) => {
        const recv = c.receivedAt ? new Date(c.receivedAt).getTime() : null;
        const upd = c.updatedAt ? new Date(c.updatedAt).getTime() : null;
        if (!recv || !upd || upd < recv) return null;
        return (upd - recv) / 86400000;
      })
      .filter((d): d is number => d !== null);
    if (days.length > 0) {
      avgTurnaround = days.reduce((a, b) => a + b, 0) / days.length;
    }
  }

  const address = [org.addressLine1, org.city, org.state, org.zip]
    .filter(Boolean)
    .join(", ");

  const activeCases = caseRows.filter(
    (c) => !TERMINAL_STATUSES.has((c.status ?? "").toLowerCase()),
  );

  let ctx = `LAB INFORMATION:
Name: ${org.displayName || org.name}
Address: ${address || "Not set"}
Phone: ${org.phone || "Not set"}
${avgTurnaround !== null ? `Average turnaround: ${avgTurnaround.toFixed(1)} days` : ""}

CASES (${activeCases.length} active, ${caseRows.length} total shown):
`;

  for (const c of caseRows.slice(0, 150)) {
    const ress = resByCase.get(c.id) || [];
    const resStr = ress
      .map((r: any) =>
        [
          r.toothNumber ? `#${r.toothNumber}` : "",
          r.material || "",
          r.restorationType || "",
          r.shade ? `shade ${r.shade}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      )
      .filter(Boolean)
      .join("; ");
    const dueStr = c.dueDate
      ? new Date(c.dueDate).toLocaleDateString()
      : "no due date";
    ctx += `- Case ${c.caseNumber}: ${c.patientFirstName} ${c.patientLastName}, Dr. ${c.doctorName}, Status: ${c.status}, Due: ${dueStr}${c.priority === "rush" ? " (RUSH)" : ""}${resStr ? `, Restorations: ${resStr}` : ""}\n`;
  }

  ctx += `\nPRICING TIERS:\n`;
  for (const t of tiers) {
    const prices = (t.pricesJson ?? {}) as Record<string, number>;
    const priceStr = Object.entries(prices)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}: $${v}`)
      .join(", ");
    if (priceStr) ctx += `- ${t.name}: ${priceStr}\n`;
  }

  ctx += `\nDOCTOR PRICING OVERRIDES:\n`;
  for (const o of overrideRows) {
    const prices = (o.pricesJson ?? {}) as Record<string, number>;
    const priceStr = Object.entries(prices)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}: $${v}`)
      .join(", ");
    if (priceStr) {
      ctx += `- Dr. ${o.doctorName}${o.tierName ? ` (tier: ${o.tierName})` : ""}: ${priceStr}\n`;
    }
  }

  return ctx;
}

async function buildProviderContext(userId: string): Promise<string> {
  const { providerOrgIds } = await getProviderOrgIdsForUserAndLinks(userId);

  if (providerOrgIds.length === 0) {
    return "No linked provider organizations found for this user.";
  }

  const caseRows = await db
    .select()
    .from(cases)
    .where(
      and(
        inArray(cases.providerOrganizationId, providerOrgIds),
        isNull(cases.deletedAt),
      ),
    )
    .limit(200);

  const caseIds = caseRows.map((c) => c.id);
  let restRows: any[] = [];
  if (caseIds.length > 0) {
    restRows = (await db
      .select()
      .from(caseRestorations)
      .where(inArray(caseRestorations.caseId, caseIds))) as any[];
  }
  const resByCase = new Map<string, any[]>();
  for (const r of restRows) {
    if (!resByCase.has(r.caseId)) resByCase.set(r.caseId, []);
    resByCase.get(r.caseId)!.push(r);
  }

  const labOrgIds = [...new Set(caseRows.map((c) => c.labOrganizationId))];
  const labOrgs =
    labOrgIds.length > 0
      ? await db
          .select()
          .from(organizations)
          .where(inArray(organizations.id, labOrgIds))
      : [];
  const labById = new Map(labOrgs.map((o) => [o.id, o]));

  const activeCases = caseRows.filter(
    (c) => !TERMINAL_STATUSES.has((c.status ?? "").toLowerCase()),
  );

  let ctx = `YOUR CASES ACROSS ALL LINKED LABS (${activeCases.length} active, ${caseRows.length} total shown):\n`;

  for (const c of caseRows.slice(0, 150)) {
    const lab = labById.get(c.labOrganizationId);
    const ress = resByCase.get(c.id) || [];
    const resStr = ress
      .map((r: any) =>
        [
          r.toothNumber ? `#${r.toothNumber}` : "",
          r.material || "",
          r.restorationType || "",
          r.shade ? `shade ${r.shade}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      )
      .filter(Boolean)
      .join("; ");
    const dueStr = c.dueDate
      ? new Date(c.dueDate).toLocaleDateString()
      : "no due date";
    ctx += `- Case ${c.caseNumber}: ${c.patientFirstName} ${c.patientLastName}, Status: ${c.status}, Lab: ${lab?.displayName || lab?.name || "Unknown"}, Due: ${dueStr}${c.priority === "rush" ? " (RUSH)" : ""}${resStr ? `, Restorations: ${resStr}` : ""}\n`;
  }

  if (labOrgIds.length > 0) {
    ctx += `\nPRICING BY LAB:\n`;

    const allTiers = await db
      .select()
      .from(pricingTiers)
      .where(inArray(pricingTiers.labOrganizationId, labOrgIds));

    const tiersByLab = new Map<string, typeof allTiers>();
    for (const t of allTiers) {
      if (!tiersByLab.has(t.labOrganizationId)) tiersByLab.set(t.labOrganizationId, []);
      tiersByLab.get(t.labOrganizationId)!.push(t);
    }

    const connections =
      providerOrgIds.length > 0
        ? await db
            .select({
              labOrganizationId: organizationConnections.labOrganizationId,
              providerOrganizationId: organizationConnections.providerOrganizationId,
              tierName: organizationConnections.tierName,
            })
            .from(organizationConnections)
            .where(
              and(
                inArray(organizationConnections.labOrganizationId, labOrgIds),
                inArray(organizationConnections.providerOrganizationId, providerOrgIds),
              ),
            )
        : [];

    const connectionTierByLab = new Map<string, string | null>();
    for (const conn of connections) {
      connectionTierByLab.set(conn.labOrganizationId, conn.tierName ?? null);
    }

    const doctorNamesByLab = new Map<string, Set<string>>();
    for (const c of caseRows) {
      if (!c.doctorName) continue;
      if (!doctorNamesByLab.has(c.labOrganizationId)) doctorNamesByLab.set(c.labOrganizationId, new Set());
      doctorNamesByLab.get(c.labOrganizationId)!.add(c.doctorName);
    }

    const allOverrides =
      labOrgIds.length > 0
        ? await db
            .select()
            .from(pricingOverrides)
            .where(
              and(
                inArray(pricingOverrides.labOrganizationId, labOrgIds),
                isNull(pricingOverrides.deletedAt),
              ),
            )
        : [];

    const overridesByLab = new Map<string, typeof allOverrides>();
    for (const o of allOverrides) {
      if (!overridesByLab.has(o.labOrganizationId)) overridesByLab.set(o.labOrganizationId, []);
      overridesByLab.get(o.labOrganizationId)!.push(o);
    }

    for (const labId of labOrgIds) {
      const lab = labById.get(labId);
      const labName = lab?.displayName || lab?.name || labId;
      ctx += `\nLab: ${labName}\n`;

      const tiers = tiersByLab.get(labId) ?? [];
      const connectionTier = connectionTierByLab.get(labId) ?? null;
      const overrides = overridesByLab.get(labId) ?? [];
      const doctorNames = doctorNamesByLab.get(labId) ?? new Set();

      const sortedTiers = [...tiers].sort((a, b) => {
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return at - bt;
      });

      let effectiveTier = connectionTier
        ? sortedTiers.find((t) => t.name.trim().toLowerCase() === connectionTier.trim().toLowerCase())
        : null;
      if (!effectiveTier) {
        effectiveTier = sortedTiers.find((t) => t.name.trim().toLowerCase() === "standard") ?? sortedTiers[0] ?? null;
      }

      if (effectiveTier) {
        const prices = (effectiveTier.pricesJson ?? {}) as Record<string, number>;
        const priceStr = Object.entries(prices)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}: $${v}`)
          .join(", ");
        ctx += `  Your tier at this lab: ${effectiveTier.name}${connectionTier ? "" : " (default)"}\n`;
        if (priceStr) ctx += `  Prices: ${priceStr}\n`;
      } else {
        ctx += `  No pricing tiers configured at this lab.\n`;
      }

      for (const doctorName of doctorNames) {
        const normalized = normalizeDoctor(doctorName);
        const override = overrides.find(
          (o) => normalizeDoctor(o.doctorName) === normalized,
        );
        if (override) {
          const prices = (override.pricesJson ?? {}) as Record<string, number>;
          const priceStr = Object.entries(prices)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `${k}: $${v}`)
            .join(", ");
          if (priceStr) {
            ctx += `  Dr. ${doctorName} custom pricing: ${priceStr}${override.tierName ? ` (based on tier: ${override.tierName})` : ""}\n`;
          }
        }
      }
    }
  }

  return ctx;
}

/**
 * Builds a focused context block for a single case.
 *
 * When `userId` and `userType` are supplied the function enforces access
 * control before returning any case data:
 *  - provider users: the case's providerOrganizationId must belong to one
 *    of the caller's linked provider orgs — enforced here.
 *  - lab users: no additional per-case ownership check is applied here;
 *    the caller is expected to be an authenticated lab member, but the
 *    caseId is not validated against the user's active lab org(s).
 *    TODO: add lab-side ownership enforcement analogous to the provider
 *    path (require caseRow.labOrganizationId ∈ getActiveLabIds(userId)).
 *
 * Returns an empty string (instead of throwing) when access is denied so
 * the caller can silently omit the single-case block rather than fail the
 * whole request.
 */
async function buildSingleCaseContext(
  caseId: string,
  userId?: string,
  userType?: string,
): Promise<string> {
  const [caseRow] = await db
    .select()
    .from(cases)
    .where(and(eq(cases.id, caseId), isNull(cases.deletedAt)))
    .limit(1);

  if (!caseRow) return "Case not found.";

  // --- provider access check -------------------------------------------
  if (userId && userType === "provider") {
    const { providerOrgIds } = await getProviderOrgIdsForUserAndLinks(userId);
    const caseProviderOrgId = caseRow.providerOrganizationId ?? null;
    if (!caseProviderOrgId || !providerOrgIds.includes(caseProviderOrgId)) {
      return "";
    }
  }
  // ---------------------------------------------------------------------

  const [restRows, noteRows, attachmentRows] = await Promise.all([
    db
      .select()
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, caseId)),
    db
      .select()
      .from(caseNotes)
      .where(eq(caseNotes.caseId, caseId)),
    db
      .select()
      .from(caseAttachments)
      .where(eq(caseAttachments.caseId, caseId)),
  ]);

  // Resolve the lab name so providers can see which lab is handling the case
  let labName: string | null = null;
  if (caseRow.labOrganizationId) {
    const [labOrg] = await db
      .select({ displayName: organizations.displayName, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, caseRow.labOrganizationId))
      .limit(1);
    labName = labOrg?.displayName || labOrg?.name || null;
  }

  const dueStr = caseRow.dueDate
    ? new Date(caseRow.dueDate).toLocaleDateString()
    : "no due date";

  const resStr = restRows
    .map((r: any) =>
      [
        r.toothNumber ? `Tooth #${r.toothNumber}` : "",
        r.restorationType || "",
        r.material || "",
        r.shade ? `shade ${r.shade}` : "",
        r.quantity && r.quantity > 1 ? `×${r.quantity}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean)
    .join("\n  - ");

  const notesStr = noteRows
    .slice(0, 10)
    .map((n: any) => {
      const when = n.createdAt ? new Date(n.createdAt).toLocaleDateString() : "";
      const author = n.authorName ? `${n.authorName}: ` : "";
      return `  [${when}] ${author}${n.note || ""}`;
    })
    .join("\n");

  let ctx = `FOCUSED CASE CONTEXT:
Case Number: ${caseRow.caseNumber}
Patient: ${caseRow.patientFirstName || ""} ${caseRow.patientLastName || ""}
Doctor: ${caseRow.doctorName || "Unknown"}
Status: ${caseRow.status || "Unknown"}
Due Date: ${dueStr}
Priority: ${caseRow.priority || "normal"}${labName ? `\nLab: ${labName}` : ""}

RESTORATIONS (${restRows.length} total):
${restRows.length > 0 ? `  - ${resStr}` : "  None recorded."}

STAFF NOTES (${noteRows.length} total):
${noteRows.length > 0 ? notesStr : "  None recorded."}

ATTACHMENTS: ${attachmentRows.length} file(s) attached.
`;

  return ctx;
}

/**
 * Build a combined context block for multiple pinned cases.
 * Each case gets a labelled section so the AI can reference them by number.
 */
async function buildMultiCaseContext(
  caseIds: string[],
  userId?: string,
  userType?: string,
): Promise<string> {
  if (caseIds.length === 0) return "";
  if (caseIds.length === 1) return buildSingleCaseContext(caseIds[0]!, userId, userType);

  const contexts = await Promise.all(
    caseIds.map(async (id) => {
      const ctx = await buildSingleCaseContext(id, userId, userType);
      return ctx;
    }),
  );

  return `PINNED CASES (${caseIds.length} cases in context):\n\n` + contexts.join("\n---\n\n");
}

export function registerAiChatRoutes(router: IRouter): void {
  /** GET /ai-chat/history — returns the last N stored messages for this user */
  router.get("/ai-chat/history", requireAuth, async (req: any, res: any) => {
    const userId: string = req.user.id;
    try {
      const rows = await loadHistory(userId);
      return res.json({ messages: rows });
    } catch (err: any) {
      req.log?.error({ err }, "AI chat history fetch error");
      return res.status(500).json({ error: "Failed to load chat history." });
    }
  });

  /** DELETE /ai-chat/history — clears all stored messages for this user */
  router.delete("/ai-chat/history", requireAuth, async (req: any, res: any) => {
    const userId: string = req.user.id;
    try {
      await db.delete(aiChatHistory).where(eq(aiChatHistory.userId, userId));
      return res.json({ success: true });
    } catch (err: any) {
      req.log?.error({ err }, "AI chat history clear error");
      return res.status(500).json({ error: "Failed to clear chat history." });
    }
  });

  /** POST /ai-chat — send a message and get a reply; persists the exchange */
  router.post("/ai-chat", requireAuth, aiChatRateLimit, async (req: any, res: any) => {
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
    const messages = body?.messages;

    // Support both the legacy single caseId and the new caseIds array.
    // Deduplicate and sanitize the IDs.
    let requestedCaseIds: string[] = [];
    if (Array.isArray(body?.caseIds) && body.caseIds.length > 0) {
      requestedCaseIds = [
        ...new Set(
          body.caseIds
            .filter((id) => typeof id === "string" && id.trim())
            .map((id) => id.trim())
            .slice(0, 10),
        ),
      ];
    } else if (typeof body?.caseId === "string" && body.caseId.trim()) {
      requestedCaseIds = [body.caseId.trim()];
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "user") {
      return res
        .status(400)
        .json({ error: "Last message must have role 'user'" });
    }

    const safeMessages = messages.slice(-20).map((m) => ({
      role: m.role as "user" | "assistant",
      content: String(m.content || "").slice(0, 2000),
    }));

    const userType: string = req.user.userType || "lab";

    let contextBlock: string;
    let systemPrompt: string;

    // Additive prompt augmentation: curated reference knowledge selected from
    // the user's latest message, plus admin-curated per-lab memory. Both are
    // empty strings when nothing relevant exists, so the prompt is unchanged
    // in that case. This does not alter the request/response contract.
    const userMessage = String(lastMsg.content || "");
    const knowledgeMeta = buildKnowledgeBlockWithMeta(userMessage);
    const knowledgeBlock = knowledgeMeta.block;
    const materialBlock = buildMaterialSuggestionBlock(userMessage);

    // Lab orgs in scope for this turn — used to auto-learn candidate memory
    // entries from the exchange (lab users only). Captured here so it survives
    // outside the context-assembly try/catch below.
    let learnLabIds: string[] = [];

    try {
      if (userType === "provider") {
        contextBlock = await buildProviderContext(userId);
        let pinnedCaseCtx = "";
        if (requestedCaseIds.length > 0) {
          pinnedCaseCtx = await buildMultiCaseContext(requestedCaseIds, userId, userType);
        }
        systemPrompt = `You are Maynard, a helpful assistant for dental providers (doctors and practices).
You have access to the provider's real-time case data and pricing from all their linked dental labs.
Answer questions about case status, estimated delivery, restorations, and what this provider is charged per item type accurately using only the data provided below.
Be concise and professional. If asked about a case or patient not in the data, say so clearly rather than guessing.
Today's date: ${new Date().toLocaleDateString()}.
${knowledgeBlock}${materialBlock}
${pinnedCaseCtx ? `${pinnedCaseCtx}\n` : ""}${contextBlock}`;
      } else {
        const labIds = await getActiveLabIds(userId);
        learnLabIds = labIds;
        if (labIds.length === 0) {
          contextBlock = "This user is not a member of any active lab organization.";
        } else {
          contextBlock = await buildLabContext(labIds[0]);
        }
        const memoryBlock = await buildLabMemoryBlock(labIds);
        let pinnedCaseCtx = "";
        if (requestedCaseIds.length > 0) {
          pinnedCaseCtx = await buildMultiCaseContext(requestedCaseIds, userId, userType);
        }
        systemPrompt = `You are Maynard, a helpful assistant for dental lab staff.
You have access to real-time data about this lab's cases, pricing tiers, and lab profile.
Answer questions about case status, patient cases, doctor pricing, estimated turnaround, and lab information accurately using only the data provided below.
Be concise and professional. If a case is not in the data, say so clearly rather than guessing.
Today's date: ${new Date().toLocaleDateString()}.
${knowledgeBlock}${materialBlock}${memoryBlock}
${pinnedCaseCtx ? `${pinnedCaseCtx}\n` : ""}${contextBlock}`;
      }
    } catch (err: any) {
      req.log?.error({ err }, "AI chat context assembly error");
      return res
        .status(500)
        .json({ error: "Failed to assemble context. Please try again." });
    }

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-5-mini",
        messages: [{ role: "system", content: systemPrompt }, ...safeMessages],
        max_completion_tokens: 4000,
      });

      const choice = completion.choices[0];
      const rawContent = choice?.message?.content ?? null;

      // Log the full completion details when the model returns empty content so
      // the exact failure reason is visible in server logs.
      if (!rawContent) {
        req.log?.error(
          {
            finishReason: choice?.finish_reason,
            usage: completion.usage,
            knowledgeSectionIds: knowledgeMeta.sectionIds,
            systemPromptLength: systemPrompt.length,
          },
          "[AI CHAT] model returned empty content",
        );
      }

      // Fallback: if the model returned nothing but we have knowledge sections,
      // synthesise a direct answer from the retrieved sections rather than
      // returning a generic error.
      let reply: string;
      if (rawContent) {
        reply = rawContent;
      } else if (knowledgeMeta.sectionIds.length > 0 && knowledgeMeta.block) {
        // Strip the "REFERENCE KNOWLEDGE" header and render the sections directly.
        const sections = knowledgeMeta.block
          .replace(/^\nREFERENCE KNOWLEDGE \(curated;[^\n]*\):\n/, "")
          .trim();
        reply =
          `Here is the relevant information from the reference knowledge:\n\n${sections}\n\n` +
          `_(Generation failed — showing raw handbook sections. Try rephrasing your question for a more tailored answer.)_`;
      } else {
        reply = "I couldn't generate a response. Please try again.";
      }

      // Log which knowledge sections were used for audit purposes.
      if (knowledgeMeta.sectionIds.length > 0 || knowledgeMeta.retentionDisclaimer || knowledgeMeta.privacyDisclaimer) {
        req.log?.info(
          {
            knowledgeSectionIds: knowledgeMeta.sectionIds,
            retentionDisclaimer: knowledgeMeta.retentionDisclaimer,
            privacyDisclaimer: knowledgeMeta.privacyDisclaimer,
          },
          "[AI CHAT] knowledge sections used in prompt",
        );
      }

      // Persist the exchange in the background; don't block the response
      const userContent = String(lastMsg.content || "").slice(0, 2000);
      persistExchange(
        userId,
        userContent,
        reply,
        knowledgeMeta.sectionIds.length > 0 ? knowledgeMeta.sectionIds : undefined,
        knowledgeMeta.retentionDisclaimer || undefined,
      ).catch((err) => {
        req.log?.error({ err }, "AI chat history persist error");
      });

      // Auto-learn candidate memory entries from this exchange (lab users
      // only). Fire-and-forget; never blocks or alters the response.
      learnFromExchange({
        openai,
        labIds: learnLabIds,
        userMessage,
        assistantMessage: reply,
        userId,
      }).catch((err) => {
        req.log?.error({ err }, "AI chat memory-learn error");
      });

      return res.json({
        reply,
        ...(knowledgeMeta.sectionIds.length > 0
          ? { knowledgeSectionIds: knowledgeMeta.sectionIds }
          : {}),
        ...(knowledgeMeta.retentionDisclaimer
          ? { retentionDisclaimer: true, disclaimer: RETENTION_LEGAL_DISCLAIMER }
          : {}),
        ...(knowledgeMeta.privacyDisclaimer
          ? { privacyDisclaimer: true }
          : {}),
      });
    } catch (err: any) {
      req.log?.error({ err }, "AI chat OpenAI error");
      return res
        .status(500)
        .json({ error: "Failed to get AI response. Please try again." });
    }
  });
}
