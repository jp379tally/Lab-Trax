/**
 * Case / restoration → analytics category mapping.
 *
 * Single source of truth for how a case (via its `case_restorations` rows)
 * or a legacy `lab_cases` blob is classified into the major analytics
 * groups shown on the desktop Stats dashboard:
 *
 *   - implants      — restorationType mentions implant/abutment work.
 *   - zirconia      — material normalizes to "Zirconia" via
 *                     `normalizeMaterialName` (material-driven, NOT the
 *                     product name — a "BruxZir crown" is zirconia, not
 *                     crown & bridge).
 *   - crown_bridge  — non-zirconia fixed work: crowns, bridges, veneers,
 *                     inlays/onlays, Maryland bridges, or materials that
 *                     normalize to Lithium Disilicate / PFM / gold /
 *                     full-cast metal.
 *   - removable     — dentures, partials, flippers, flexible (Valplast)
 *                     appliances.
 *   - other         — anything with usable text that matches none of the
 *                     above (night guards, retainers, snore/sports guards,
 *                     alloy surcharges, unknown free-form types).
 *   - uncategorized — no usable restoration/type/material data at all
 *                     (mostly legacy `lab_cases` blobs; surfaced on the
 *                     dashboard as "Uncategorized / Legacy" so nothing is
 *                     silently dropped).
 *
 * Case-level classification picks the highest-priority category present
 * across the case's restorations, in the order:
 *   implants > zirconia > crown_bridge > removable > other
 * (an implant case with a zirconia crown counts as "implants"; a case with
 * a zirconia crown and a PFM crown counts as "zirconia").
 *
 * Adding a new category: add the key to CASE_CATEGORY_KEYS (before "other"
 * in CATEGORY_PRIORITY if it should win ties), a label, and a branch in
 * `classifyRestoration`.
 */

import { normalizeMaterialName, CANONICAL_ZIRCONIA } from "./material-mapping";
import { deriveCaseHierarchy, hierarchyToCaseCategory } from "@workspace/case-taxonomy";

// Re-export taxonomy helpers so consumers only need one import.
export {
  deriveCaseHierarchy,
  encodeRestorationSubtype,
  encodeCustomToken,
  isCustomToken,
  parseCustomToken,
  normalizeCaseHierarchy,
  hierarchyToCaseCategory,
  isValidCaseType,
  isValidSubtype,
  isValidMaterialSubtype,
  caseTypeForSubtype,
  getSubtypes,
  getMaterialSubtypes,
  getTaxonomyTree,
  getTaxonomyVocab,
  CASE_TAXONOMY,
  CASE_TYPES,
  type CaseType,
  type CaseSubtype,
  type MaterialSubtype,
  type CaseHierarchy,
  type TaxonomyVocabEntry,
  type TaxonomyTree,
} from "@workspace/case-taxonomy";

export const CASE_CATEGORY_KEYS = [
  "implants",
  "zirconia",
  "crown_bridge",
  "removable",
  "other",
  "uncategorized",
] as const;

export type CaseCategory = (typeof CASE_CATEGORY_KEYS)[number];

export const CASE_CATEGORY_LABELS: Record<CaseCategory, string> = {
  implants: "Implants",
  zirconia: "Zirconia",
  crown_bridge: "Crown & Bridge",
  removable: "Removable",
  other: "Other",
  uncategorized: "Uncategorized / Legacy",
};

/** Priority order for case-level classification (first match wins). */
const CATEGORY_PRIORITY: Exclude<CaseCategory, "uncategorized">[] = [
  "implants",
  "zirconia",
  "crown_bridge",
  "removable",
  "other",
];

const IMPLANT_RE = /\bimplant|\babutment|screw[- ]?retained|all[- ]?on[- ]?(4|6|x)/i;
const CROWN_BRIDGE_RE =
  /\bcrown|\bbridge|\bveneer|\binlay|\bonlay|\bmaryland|\bpontic|\bcoping/i;
const REMOVABLE_RE = /\bdenture|\bpartial|\bflipper|\bflexible|\bvalplast|\bremovable/i;
const CROWN_BRIDGE_MATERIAL_RE =
  /lithium disilicate|\bpfm\b|\bgold\b|full cast|cast metal|semi precious/i;

/**
 * Classify a single restoration row. Returns "uncategorized" only when both
 * fields are blank; any non-empty text that matches no rule is "other".
 *
 * When `restorationSubtype` is present (the structured column value stored by
 * new pickers), the hierarchy is decoded via `deriveCaseHierarchy` and
 * bridged through `hierarchyToCaseCategory` before falling back to regex.
 */
export function classifyRestoration(
  restorationType?: string | null,
  material?: string | null,
  restorationSubtype?: string | null,
): CaseCategory {
  // Prefer the explicit taxonomy hierarchy when a structured subtype key exists.
  if (restorationSubtype) {
    const hierarchy = deriveCaseHierarchy(restorationType, restorationSubtype, material);
    const bridged = hierarchyToCaseCategory(hierarchy);
    if (bridged) return bridged;
  }

  const rt = (restorationType ?? "").trim();
  const rawMaterial = (material ?? "").trim();
  if (!rt && !rawMaterial) return "uncategorized";

  const normalizedMaterial = normalizeMaterialName(rawMaterial) ?? "";
  const haystack = `${rt} ${rawMaterial}`;

  if (IMPLANT_RE.test(haystack)) return "implants";
  // Zirconia is material-driven: normalizeMaterialName collapses BruxZir /
  // Brux / Zirc / Zr / BZR / PFZ brand names to the canonical "Zirconia".
  if (normalizedMaterial === CANONICAL_ZIRCONIA) return "zirconia";
  if (
    CROWN_BRIDGE_RE.test(haystack) ||
    CROWN_BRIDGE_MATERIAL_RE.test(normalizedMaterial) ||
    CROWN_BRIDGE_MATERIAL_RE.test(rawMaterial)
  ) {
    return "crown_bridge";
  }
  if (REMOVABLE_RE.test(haystack)) return "removable";
  return "other";
}

/**
 * Classify a whole case from its restoration rows. Highest-priority
 * category present wins; a case with no rows (or only fully blank rows)
 * is "uncategorized".
 *
 * Pass `restorationSubtype` per restoration to enable hierarchy-first
 * classification for rows that have the structured column populated.
 */
export function classifyCase(
  restorations: Array<{
    restorationType?: string | null;
    material?: string | null;
    restorationSubtype?: string | null;
  }>,
): CaseCategory {
  const present = new Set<CaseCategory>();
  for (const r of restorations) {
    present.add(classifyRestoration(r.restorationType, r.material, r.restorationSubtype));
  }
  for (const cat of CATEGORY_PRIORITY) {
    if (present.has(cat)) return cat;
  }
  return "uncategorized";
}

/**
 * Classify a legacy `lab_cases` JSON blob. Legacy mobile cases have no
 * `case_restorations` rows; the blob carries free-form `caseType`,
 * `material`, and sometimes `restorationType` strings. When none of those
 * carry usable text the case lands in "uncategorized" (shown as
 * "Uncategorized / Legacy") rather than being dropped.
 */
export function classifyLegacyCase(caseData: unknown): CaseCategory {
  if (!caseData || typeof caseData !== "object") return "uncategorized";
  const blob = caseData as Record<string, unknown>;
  const rt = [blob["restorationType"], blob["caseType"]]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .join(" ");
  const material = typeof blob["material"] === "string" ? blob["material"] : "";
  return classifyRestoration(rt, material);
}
