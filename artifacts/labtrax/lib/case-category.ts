/**
 * Case → analytics category classification (mobile).
 *
 * A self-contained mirror of the server's `case-category.ts` +
 * `material-mapping.ts` zirconia normalization, adapted to the data the
 * mobile cases list actually carries: each list row exposes
 * `restorationTypes` and `restorationMaterials` as comma-joined strings
 * (see the list route's `enriched` builder), not per-restoration rows.
 *
 * The five real categories mirror the Stats screen's CATEGORY_OPTIONS, in
 * the same priority order the server uses (implants > zirconia >
 * crown_bridge > removable > other). A case with no usable
 * type/material text lands in "uncategorized".
 *
 * Keep this aligned with `artifacts/api-server/src/lib/case-category.ts`.
 * Because the mobile list only has combined strings, classification is a
 * close approximation of the server's per-restoration result, sufficient
 * for the tap-a-bar → filtered-cases investigation flow.
 */

export const CASE_CATEGORY_KEYS = [
  "implants",
  "zirconia",
  "crown_bridge",
  "removable",
  "other",
  "uncategorized",
] as const;

export type CaseCategory = (typeof CASE_CATEGORY_KEYS)[number];

const IMPLANT_RE = /\bimplant|\babutment|screw[- ]?retained|all[- ]?on[- ]?(4|6|x)/i;
const CROWN_BRIDGE_RE =
  /\bcrown|\bbridge|\bveneer|\binlay|\bonlay|\bmaryland|\bpontic|\bcoping/i;
const REMOVABLE_RE = /\bdenture|\bpartial|\bflipper|\bflexible|\bvalplast/i;
const CROWN_BRIDGE_MATERIAL_RE =
  /lithium disilicate|\bpfm\b|\bgold\b|full cast|cast metal|semi precious/i;

// Mirror of material-mapping.ts's normalization for the two categories that
// are material-driven (zirconia detection, and the lithium-disilicate / PFM
// canonicalization the crown_bridge material regex expects).
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

/** Normalize one free-form material string to the canonical vocabulary. */
function normalizeMaterial(raw: string): string {
  const original = raw.trim();
  if (!original) return original;
  const s = original.toLowerCase().replace(/^ceramic\s*:\s*/, "").trim();
  if (matchesSynonym(s, LITHIUM_DISILICATE_SYNONYMS)) return "Lithium Disilicate";
  if (matchesSynonym(s, ZIRCONIA_SYNONYMS)) return "Zirconia";
  if (matchesSynonym(s, PFM_SYNONYMS)) return "PFM";
  return original;
}

/**
 * Classify a case from its comma-joined restoration type/material strings.
 * Highest-priority category wins; blank type + material → "uncategorized".
 */
export function classifyCaseCategory(
  restorationTypes?: string | null,
  restorationMaterials?: string | null,
): CaseCategory {
  const types = (restorationTypes ?? "").trim();
  const materials = (restorationMaterials ?? "").trim();
  if (!types && !materials) return "uncategorized";

  const normalizedMaterials = materials
    .split(",")
    .map((m) => normalizeMaterial(m))
    .filter(Boolean);
  const normalizedMaterialsStr = normalizedMaterials.join(", ");
  const haystack = `${types} ${materials}`;

  if (IMPLANT_RE.test(haystack)) return "implants";
  if (normalizedMaterials.some((m) => m === "Zirconia")) return "zirconia";
  if (
    CROWN_BRIDGE_RE.test(haystack) ||
    CROWN_BRIDGE_MATERIAL_RE.test(normalizedMaterialsStr) ||
    CROWN_BRIDGE_MATERIAL_RE.test(materials)
  ) {
    return "crown_bridge";
  }
  if (REMOVABLE_RE.test(haystack)) return "removable";
  return "other";
}
