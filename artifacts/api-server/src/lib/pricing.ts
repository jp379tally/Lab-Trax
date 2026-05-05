import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { pricingOverrides, pricingTiers } from "@workspace/db";

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
  tierName?: string | null;
}

export async function resolveServerPrice(
  ctx: ResolvedPriceContext,
  material?: string | null,
  restorationType?: string | null
): Promise<number | null> {
  const key = materialToPriceKey(material, restorationType);
  if (!key) return null;

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
      if (Number.isFinite(value) && value > 0) return value;
    }
  }

  // Tier lookup (by tier name on the override row, else first tier)
  const tiers = await db.query.pricingTiers.findMany({
    where: eq(pricingTiers.labOrganizationId, ctx.labOrganizationId),
  });
  const tier = ctx.tierName
    ? tiers.find(
        (t) => t.name.trim().toLowerCase() === ctx.tierName!.trim().toLowerCase()
      )
    : null;
  if (tier) {
    const prices = (tier.pricesJson ?? {}) as Record<string, unknown>;
    const value = Number(prices[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}
