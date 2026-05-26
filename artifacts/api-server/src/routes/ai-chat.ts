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
} from "@workspace/db";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { getProviderOrgIdsForUserAndLinks } from "../lib/cross-lab-doctor";
import { requireAuth } from "../middlewares/auth";
import { normalizeDoctor } from "../lib/pricing";

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

  // Terminal statuses: "complete", "shipped", "delivered"
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

  // Active cases = not in a terminal status
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

  // Active cases = not in a terminal status
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

  // --- Provider pricing per lab ---
  // For each lab: find the connection tier, doctor overrides for doctors
  // who appear in this provider's cases, and the lab's tier price lists.
  if (labOrgIds.length > 0) {
    ctx += `\nPRICING BY LAB:\n`;

    // Pull all relevant pricing data in bulk
    const allTiers = await db
      .select()
      .from(pricingTiers)
      .where(inArray(pricingTiers.labOrganizationId, labOrgIds));

    const tiersByLab = new Map<string, typeof allTiers>();
    for (const t of allTiers) {
      if (!tiersByLab.has(t.labOrganizationId)) tiersByLab.set(t.labOrganizationId, []);
      tiersByLab.get(t.labOrganizationId)!.push(t);
    }

    // Connection tiers: which tier is this provider assigned at each lab?
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

    // Map: labId → tierName for this provider
    const connectionTierByLab = new Map<string, string | null>();
    for (const conn of connections) {
      connectionTierByLab.set(conn.labOrganizationId, conn.tierName ?? null);
    }

    // Doctor overrides: pull per lab for any doctor names appearing in cases
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

    // Map: labId → list of overrides
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

      // Sort tiers oldest-first (mirrors resolveServerPriceWithSource)
      const sortedTiers = [...tiers].sort((a, b) => {
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return at - bt;
      });

      // Find the effective tier for this provider at this lab
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

      // Per-doctor overrides for doctors in this provider's cases
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

export function registerAiChatRoutes(router: IRouter): void {
  router.post("/ai-chat", requireAuth, async (req: any, res: any) => {
    const openai = getAiClient();
    if (!openai) {
      return res.status(503).json({
        error:
          "AI assistant is not configured on this server. Please ask your administrator to set AI_INTEGRATIONS_OPENAI_API_KEY.",
      });
    }

    const body = req.body as {
      messages?: Array<{ role: "user" | "assistant"; content: string }>;
    };
    const messages = body?.messages;

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

    const userId: string = req.user.id;
    const userType: string = req.user.userType || "lab";

    let contextBlock: string;
    let systemPrompt: string;

    try {
      if (userType === "provider") {
        contextBlock = await buildProviderContext(userId);
        systemPrompt = `You are LabTrax AI, a helpful assistant for dental providers (doctors and practices).
You have access to the provider's real-time case data and pricing from all their linked dental labs.
Answer questions about case status, estimated delivery, restorations, and what this provider is charged per item type accurately using only the data provided below.
Be concise and professional. If asked about a case or patient not in the data, say so clearly rather than guessing.
Today's date: ${new Date().toLocaleDateString()}.

${contextBlock}`;
      } else {
        const labIds = await getActiveLabIds(userId);
        if (labIds.length === 0) {
          contextBlock = "This user is not a member of any active lab organization.";
        } else {
          contextBlock = await buildLabContext(labIds[0]);
        }
        systemPrompt = `You are LabTrax AI, a helpful assistant for dental lab staff.
You have access to real-time data about this lab's cases, pricing tiers, and lab profile.
Answer questions about case status, patient cases, doctor pricing, estimated turnaround, and lab information accurately using only the data provided below.
Be concise and professional. If a case is not in the data, say so clearly rather than guessing.
Today's date: ${new Date().toLocaleDateString()}.

${contextBlock}`;
      }
    } catch (err: any) {
      req.log?.error({ err }, "AI chat context assembly error");
      return res
        .status(500)
        .json({ error: "Failed to assemble context. Please try again." });
    }

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: systemPrompt }, ...safeMessages],
        max_tokens: 800,
        temperature: 0.3,
      });

      const reply =
        completion.choices[0]?.message?.content ||
        "I couldn't generate a response. Please try again.";
      return res.json({ reply });
    } catch (err: any) {
      req.log?.error({ err }, "AI chat OpenAI error");
      return res
        .status(500)
        .json({ error: "AI assistant encountered an error. Please try again." });
    }
  });
}
