import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  organizationConnections,
  pricingOverrides,
  pricingTiers,
} from "@workspace/db";

export const DEFAULT_TIER_ITEMS = [
  { key: "zirconia_crown", label: "Zirconia Crown" },
  { key: "emax_crown", label: "E.max Crown" },
  { key: "pfm_crown", label: "PFM Crown" },
  { key: "denture", label: "Denture" },
  { key: "partial", label: "Partial" },
  { key: "implant", label: "Implant" },
  { key: "night_guard_hard", label: "Night Guard - Hard" },
  { key: "night_guard_soft", label: "Night Guard - Soft" },
  { key: "night_guard_hard_soft", label: "Night Guard - Hard/Soft" },
  { key: "retainer_hawley", label: "Retainer - Hawley" },
  { key: "retainer_hard", label: "Retainer - Hard" },
  { key: "retainer_lingual", label: "Retainer - Lingual" },
  { key: "snore_guard", label: "Snore Guard" },
  { key: "sports_guard", label: "Sports Guard" },
] as const;

export const DEFAULT_TIER_KEYS = DEFAULT_TIER_ITEMS.map((i) => i.key);

export function materialToPriceKey(
  material?: string | null,
  restorationType?: string | null
): string | null {
  const m = (material || "").toLowerCase().trim();
  const rt = (restorationType || "").toLowerCase().trim();
  if (m.includes("zirconia")) return "zirconia_crown";
  if (m.includes("emax") || m.includes("e.max") || m.includes("e max"))
    return "emax_crown";
  if (m.includes("pfz")) return "pfz_crown";
  if (m.includes("pfm")) return "pfm_crown";
  if (
    m.includes("gold") ||
    m.includes("full cast") ||
    m.includes("semi precious") ||
    m.includes("cast metal")
  )
    return "pfm_crown";
  if (m === "acrylic" || rt.includes("denture")) return "denture";
  if (m.includes("flexible") || rt.includes("partial")) return "partial";
  if (rt.includes("implant")) return "implant";
  if (m.includes("night guard hard/soft") || rt.includes("hard/soft"))
    return "night_guard_hard_soft";
  if (m.includes("night guard soft") || rt.includes("night guard - soft"))
    return "night_guard_soft";
  if (m.includes("night guard") || rt.includes("night guard"))
    return "night_guard_hard";
  if (rt.includes("retainer hawley") || rt.includes("hawley"))
    return "retainer_hawley";
  if (rt.includes("retainer lingual") || rt.includes("lingual"))
    return "retainer_lingual";
  if (m.includes("retainer") || rt.includes("retainer")) return "retainer_hard";
  if (rt.includes("snore")) return "snore_guard";
  if (rt.includes("sports")) return "sports_guard";
  return null;
}

function normalizeDoctor(name?: string | null) {
  return (name || "")
    .trim()
    .toLowerCase()
    .replace(/^dr\.?\s*/i, "");
}

export interface ResolvedPriceContext {
  labOrganizationId: string;
  doctorName?: string | null;
  providerOrganizationId?: string | null;
  tierName?: string | null;
}

export type PriceSource = "default" | "tier" | "override" | "manual";

export interface ResolvedPriceDetails {
  amount: number;
  source: Exclude<PriceSource, "manual">;
  sourceId: string | null;
  sourceName: string | null;
  key: string;
}

export async function resolveServerPrice(
  ctx: ResolvedPriceContext,
  material?: string | null,
  restorationType?: string | null
): Promise<number | null> {
  const details = await resolveServerPriceWithSource(
    ctx,
    material,
    restorationType
  );
  return details ? details.amount : null;
}

export async function resolveServerPriceWithSource(
  ctx: ResolvedPriceContext,
  material?: string | null,
  restorationType?: string | null
): Promise<ResolvedPriceDetails | null> {
  const key = materialToPriceKey(material, restorationType);
  if (!key) return null;

  let doctorTierName: string | null = null;

  // Per-doctor override beats tier
  const doctor = normalizeDoctor(ctx.doctorName);
  if (doctor) {
    const overrides = await db.query.pricingOverrides.findMany({
      where: eq(pricingOverrides.labOrganizationId, ctx.labOrganizationId),
    });
    const match = overrides.find(
      (o) => normalizeDoctor(o.doctorName) === doctor
    );
    if (match) {
      const prices = (match.pricesJson ?? {}) as Record<string, unknown>;
      const value = Number(prices[key]);
      if (Number.isFinite(value) && value > 0) {
        return {
          amount: value,
          source: "override",
          sourceId: match.id,
          sourceName: match.doctorName,
          key,
        };
      }
      if (match.tierName) doctorTierName = match.tierName;
    }
  }

  // Practice-level tier from the lab/provider connection.
  let connectionTierName: string | null = null;
  if (ctx.providerOrganizationId) {
    const connection = await db.query.organizationConnections.findFirst({
      where: and(
        eq(
          organizationConnections.labOrganizationId,
          ctx.labOrganizationId
        ),
        eq(
          organizationConnections.providerOrganizationId,
          ctx.providerOrganizationId
        )
      ),
    });
    if (connection?.tierName) connectionTierName = connection.tierName;
  }

  // Tier lookup priority:
  //   1. doctor's assigned tier (from override.tierName)
  //   2. practice's assigned tier (from organization_connections.tierName)
  //   3. caller-provided ctx.tierName (legacy)
  //   4. first tier on the lab (legacy fallback so unconfigured labs still
  //      resolve a price exactly as before this feature)
  const tiers = await db.query.pricingTiers.findMany({
    where: eq(pricingTiers.labOrganizationId, ctx.labOrganizationId),
  });
  const sortedTiers = [...tiers].sort((a, b) => {
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return at - bt;
  });

  const candidateNames = [
    doctorTierName,
    connectionTierName,
    ctx.tierName ?? null,
  ].filter((n): n is string => !!n);

  const findByName = (name: string) =>
    sortedTiers.find(
      (t) => t.name.trim().toLowerCase() === name.trim().toLowerCase()
    );

  const tryTier = (
    tier: typeof sortedTiers[number] | undefined,
    source: Exclude<PriceSource, "manual">
  ): ResolvedPriceDetails | null => {
    if (!tier) return null;
    const prices = (tier.pricesJson ?? {}) as Record<string, unknown>;
    const value = Number(prices[key]);
    if (!Number.isFinite(value) || value <= 0) return null;
    return {
      amount: value,
      source,
      sourceId: tier.id,
      sourceName: tier.name,
      key,
    };
  };

  for (const name of candidateNames) {
    const v = tryTier(findByName(name), "tier");
    if (v !== null) return v;
  }

  // Legacy fallback: first tier on the lab.
  return tryTier(sortedTiers[0], "default");
}
