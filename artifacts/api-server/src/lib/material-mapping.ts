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
  { key: "alloy", label: "Alloy" },
] as const;

export type PriceKey = (typeof DEFAULT_TIER_ITEMS)[number]["key"];

export const DEFAULT_TIER_KEYS: PriceKey[] = DEFAULT_TIER_ITEMS.map(
  (i) => i.key,
);

const VALID_KEYS = new Set<string>(DEFAULT_TIER_KEYS);

/**
 * Canonical material vocabulary the AI reader and pricing should converge on.
 * These are the *display* names stored on a restoration, not the internal
 * pricing-tier keys (which never change — see `materialToPriceKey`).
 */
export const CANONICAL_ZIRCONIA = "Zirconia";
export const CANONICAL_LITHIUM_DISILICATE = "Lithium Disilicate";
export const CANONICAL_PFM = "PFM";

/**
 * Synonym tables encoding the three material-naming rules. Short
 * abbreviations (zr, zirc, brux, bzr, pfz) are matched on word boundaries
 * by `normalizeMaterialName` so they never accidentally fire inside a
 * larger alphanumeric run.
 */
const ZIRCONIA_SYNONYMS = [
  "zirconia",
  "zirc",
  "zr",
  "brux",
  "bruxz",
  "bruxzir",
  "bzr",
  "pfz",
];
const LITHIUM_DISILICATE_SYNONYMS = [
  "emax",
  "e.max",
  "e max",
  "lithium disilicate",
  "lithium silicate",
];
const PFM_SYNONYMS = ["pfm", "porcelain fused to metal"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesSynonym(haystack: string, synonyms: string[]): boolean {
  return synonyms.some((syn) => {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(syn)}([^a-z0-9]|$)`, "i");
    return re.test(haystack);
  });
}

/**
 * Normalize a free-form material string to LabTrax's canonical material
 * vocabulary, encoding the three reader rules:
 *   - zirconia + brand names (BruxZir, Brux, Zirc, Zr, BZR, PFZ) → "Zirconia"
 *   - Emax / E.max / lithium disilicate / lithium silicate → "Lithium Disilicate"
 *   - PFM / porcelain fused to metal → "PFM"
 *
 * Anything that matches none of the rules is returned trimmed but otherwise
 * unchanged (so Gold, Acrylic, Composite, etc. keep their original wording).
 * A leading "Ceramic:" prefix (as seen on iTero Rxs) is stripped first.
 */
export function normalizeMaterialName(
  raw?: string | null,
): string | null | undefined {
  if (raw === null || raw === undefined) return raw;
  const original = raw.trim();
  if (!original) return original;
  const s = original
    .toLowerCase()
    .replace(/^ceramic\s*:\s*/, "")
    .trim();
  // Lithium disilicate first: its multi-word phrases must not be shadowed.
  if (matchesSynonym(s, LITHIUM_DISILICATE_SYNONYMS))
    return CANONICAL_LITHIUM_DISILICATE;
  if (matchesSynonym(s, ZIRCONIA_SYNONYMS)) return CANONICAL_ZIRCONIA;
  if (matchesSynonym(s, PFM_SYNONYMS)) return CANONICAL_PFM;
  return original;
}

export function materialToPriceKey(
  material?: string | null,
  restorationType?: string | null,
): PriceKey | null {
  const m = (material || "").toLowerCase().trim();
  const rt = (restorationType || "").toLowerCase().trim();

  // PFZ (porcelain fused to zirconia) historically returned a key that
  // wasn't in DEFAULT_TIER_KEYS, so resolution silently failed. Treat
  // PFZ as a zirconia crown for pricing purposes. The brand synonyms
  // (BruxZir/Brux/Zirc/Zr/BZR) are a safety net so an un-normalized string
  // still resolves to the zirconia price key.
  if (
    m.includes("zirconia") ||
    m.includes("pfz") ||
    matchesSynonym(m, ZIRCONIA_SYNONYMS)
  )
    return "zirconia_crown";
  if (
    m.includes("emax") ||
    m.includes("e.max") ||
    m.includes("e max") ||
    m.includes("lithium disilicate") ||
    m.includes("lithium silicate")
  )
    return "emax_crown";
  if (m.includes("pfm")) return "pfm_crown";
  // The alloy surcharge added to PFM cases. Checked before the
  // gold/cast-metal → pfm_crown fallthrough so an explicit "Alloy"
  // line resolves to its own price key rather than the PFM crown price.
  if (m.includes("alloy") || rt.includes("alloy")) return "alloy";
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
