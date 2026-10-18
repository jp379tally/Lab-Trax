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
export const CANONICAL_WAX = "Wax";
/**
 * Porcelain-fused-to-zirconia: distinct from plain zirconia so that invoice
 * sync can attach the $37 layered-porcelain surcharge as a child sub-item.
 * Maps to the same `zirconia_crown` pricing key as plain Zirconia.
 */
export const CANONICAL_PFZ = "Porcelain Fused to Zirconia";

/**
 * The per-tooth layered-porcelain surcharge added beneath every PFZ crown
 * line item. Hardcoded by design; make it configurable per-lab in a future task.
 */
export const LAYERED_PORCELAIN_DESCRIPTION = "Layered Porcelain";
export const LAYERED_PORCELAIN_SURCHARGE = "37.00";

/**
 * Synonym tables encoding the material-naming rules. Short abbreviations
 * (zr, zirc, brux, bzr) are matched on word boundaries by
 * `normalizeMaterialName` so they never accidentally fire inside a larger
 * alphanumeric run.
 *
 * PFZ synonyms are kept separate from plain-zirconia synonyms so that "PFZ"
 * and "porcelain fused to zirconia" normalize to `CANONICAL_PFZ` rather than
 * `CANONICAL_ZIRCONIA`, preserving the PFZ signal for the surcharge logic.
 */
const WAX_SYNONYMS = [
  "wax",
  "wax setup",
  "wax try-in",
  "wax tryin",
  "in wax",
];

/** PFZ must be checked BEFORE plain zirconia so "pfz" doesn't fall through. */
const PFZ_SYNONYMS = [
  "pfz",
  "porcelain fused to zirconia",
];

const ZIRCONIA_SYNONYMS = [
  "zirconia",
  "zirc",
  "zr",
  "brux",
  "bruxz",
  "bruxzir",
  "bzr",
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
 * vocabulary, encoding the four reader rules:
 *   - PFZ / "porcelain fused to zirconia" → "Porcelain Fused to Zirconia" (distinct!)
 *   - zirconia + brand names (BruxZir/Brux/Zirc/Zr/BZR) → "Zirconia"
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
  // PFZ before plain zirconia: "pfz" must NOT fall through to CANONICAL_ZIRCONIA.
  if (matchesSynonym(s, PFZ_SYNONYMS)) return CANONICAL_PFZ;
  if (matchesSynonym(s, ZIRCONIA_SYNONYMS)) return CANONICAL_ZIRCONIA;
  if (matchesSynonym(s, PFM_SYNONYMS)) return CANONICAL_PFM;
  if (matchesSynonym(s, WAX_SYNONYMS)) return CANONICAL_WAX;
  return original;
}

/**
 * Returns true when the material string normalizes to `CANONICAL_PFZ`
 * ("Porcelain Fused to Zirconia"). Used by invoice-grouping helpers to
 * identify restorations that need a Layered Porcelain child sub-item.
 */
export function isPfzMaterial(material: string | null | undefined): boolean {
  return normalizeMaterialName(material) === CANONICAL_PFZ;
}

/**
 * Returns true when the material string corresponds to PFM
 * (porcelain-fused-to-metal) or full contour metal (FCM / full cast metal /
 * full metal crown). Used by invoice-grouping helpers to identify restorations
 * that need a per-tooth Alloy child sub-item, and by the autoAddAlloyOnPfm
 * trigger to detect which new restorations need alloy coverage.
 */
export function isPfmOrFcmMaterial(material: string | null | undefined): boolean {
  const m = (material ?? "").toLowerCase().trim();
  if (!m) return false;
  // PFM synonyms (e.g. "PFM", "porcelain fused to metal")
  if (matchesSynonym(m, PFM_SYNONYMS) || m.includes("pfm")) return true;
  // Full cast metal synonyms (FCM, full contour metal, full metal crown,
  // full cast — already in materialToPriceKey → pfm_crown)
  if (
    m.includes("fcm") ||
    m.includes("full cast") ||
    m.includes("full contour metal") ||
    m.includes("full metal crown")
  )
    return true;
  return false;
}

export function materialToPriceKey(
  material?: string | null,
  restorationType?: string | null,
): PriceKey | null {
  const m = (material || "").toLowerCase().trim();
  const rt = (restorationType || "").toLowerCase().trim();

  // PFZ ("Porcelain Fused to Zirconia") and plain zirconia synonyms both
  // resolve to zirconia_crown for pricing. CANONICAL_PFZ contains "zirconia"
  // as a substring, so `m.includes("zirconia")` handles it automatically.
  // The explicit `m.includes("pfz")` is a safety net for un-normalized inputs.
  // Brand synonyms (BruxZir/Brux/Zirc/Zr/BZR) are also safety nets.
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
    m.includes("cast metal") ||
    m.includes("fcm") ||
    m.includes("full metal crown") ||
    m.includes("full contour metal")
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

/**
 * Allowed values for the AI-extracted `step` field on a denture/removable
 * case scan. Any value outside this set — including null — must be dropped
 * before the data reaches the client, so an AI hallucination (e.g.
 * "wax_setup" inferred from a wax-note on a crown case) never silently
 * corrupts a non-removable case record.
 */
export const VALID_STEPS = [
  "custom_tray",
  "rims_and_plates",
  "wax_setup",
  "process",
] as const;

export type ValidStep = (typeof VALID_STEPS)[number];

const VALID_STEP_SET = new Set<string>(VALID_STEPS);

/**
 * Return the step value if it is a recognized enum member, or `undefined`
 * if it should be silently dropped (unrecognized string, null, or undefined).
 */
export function cleanStepValue(value: unknown): ValidStep | undefined {
  if (typeof value === "string" && VALID_STEP_SET.has(value)) {
    return value as ValidStep;
  }
  return undefined;
}
