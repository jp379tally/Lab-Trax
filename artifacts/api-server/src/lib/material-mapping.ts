/**
 * Restoration → standard price-key mapping.
 *
 * This is the single source of truth for how a free-form (material,
 * restorationType) pair on a `case_restorations` row maps to one of the
 * `DEFAULT_TIER_ITEMS` keys used by pricing tiers and per-doctor
 * overrides. Both the server's price resolver and the desktop UI's
 * "unmapped restoration" warning depend on this mapping staying aligned.
 *
 * Invariants enforced by `material-mapping.test.ts`:
 *   - every value returned by `materialToPriceKey` is either `null` or a
 *     member of `DEFAULT_TIER_KEYS` (no orphan keys like the old
 *     `pfz_crown` bug, which never appeared in any tier and so silently
 *     broke price resolution for porcelain-fused-to-zirconia crowns).
 */

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

export type PriceKey = (typeof DEFAULT_TIER_ITEMS)[number]["key"];

export const DEFAULT_TIER_KEYS: PriceKey[] = DEFAULT_TIER_ITEMS.map(
  (i) => i.key,
);

const VALID_KEYS = new Set<string>(DEFAULT_TIER_KEYS);

export function materialToPriceKey(
  material?: string | null,
  restorationType?: string | null,
): PriceKey | null {
  const m = (material || "").toLowerCase().trim();
  const rt = (restorationType || "").toLowerCase().trim();

  // PFZ (porcelain fused to zirconia) historically returned a key that
  // wasn't in DEFAULT_TIER_KEYS, so resolution silently failed. Treat
  // PFZ as a zirconia crown for pricing purposes.
  if (m.includes("zirconia") || m.includes("pfz")) return "zirconia_crown";
  if (m.includes("emax") || m.includes("e.max") || m.includes("e max"))
    return "emax_crown";
  if (m.includes("pfm")) return "pfm_crown";
  if (
    m.includes("gold") ||
    m.includes("full cast") ||
    m.includes("semi precious") ||
    m.includes("cast metal")
  )
    return "pfm_crown";
  if (m.includes("flexible") || rt.includes("partial")) return "partial";
  if (m === "acrylic" || rt.includes("denture")) return "denture";
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

export function isKnownPriceKey(key: string | null | undefined): boolean {
  return !!key && VALID_KEYS.has(key);
}
