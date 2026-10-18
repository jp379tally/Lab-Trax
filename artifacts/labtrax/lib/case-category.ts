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

// Re-export taxonomy helpers — callers can import everything from here.
export {
  deriveCaseHierarchy,
  encodeRestorationSubtype,
  normalizeCaseHierarchy,
  isValidCaseType,
  isValidSubtype,
  isValidMaterialSubtype,
  caseTypeForSubtype,
  getSubtypes,
  getMaterialSubtypes,
  getCaseTypeLabel,
  getSubtypeLabel,
  getMaterialSubtypeLabel,
  getTaxonomyVocab,
  hierarchyToCaseCategory,
  CASE_TAXONOMY,
  CASE_TYPES,
  type CaseType,
  type CaseSubtype,
  type MaterialSubtype,
  type CaseHierarchy,
  type TaxonomyVocabEntry,
} from "@workspace/case-taxonomy";

import { deriveCaseHierarchy, hierarchyToCaseCategory } from "@workspace/case-taxonomy";
import type { CanonicalCase } from "@workspace/api-client-react";

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
const REMOVABLE_RE = /\bremovable|\bdenture|\bpartial|\bflipper|\bflexible|\bvalplast/i;
/**
 * Ortho / appliance free-text signals. Deliberately excludes "essix", which is
 * ambiguous (`removable/essix_with_teeth` vs `ortho/essix_without_teeth`) —
 * those cases are classified from their structured subtype instead.
 *
 * Mirrors `_ORTHO_RE` in the desktop app's case-date-filter classifier.
 */
const ORTHO_RE =
  /night\s*guard|nightguard|occlusal\s*guard|bite\s*guard|sports?\s*guard|snore\s*guard|mouth\s*guard|mouthguard|\bretainer|\bsplint|bleach\s*tray|\bhawley|space\s*maintainer|\bortho|\bappliance/i;
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
 * Classify a case from a stored `restorationSubtype` column key of the form
 * `"<caseType>/<subtype>"` or `"<caseType>/<subtype>/<materialSubtype>"` (the
 * format encoded by `encodeRestorationSubtype`).
 *
 * Uses the shared taxonomy decoder so the mapping stays in sync with the
 * server — any key that `deriveCaseHierarchy` cannot recognise falls back to
 * `"uncategorized"` rather than crashing.  This guards the Stats drill-down
 * against silent empty results when a canonical case carries a structured
 * subtype key but empty free-text `restorationTypes`/`restorationMaterials`.
 *
 * Priority mirrors `hierarchyToCaseCategory`:
 *   implants > zirconia > crown_bridge > removable > other > uncategorized
 */
export function classifyCaseCategoryFromSubtype(
  restorationSubtype: string | null | undefined,
): CaseCategory {
  if (!restorationSubtype) return "uncategorized";
  const hierarchy = deriveCaseHierarchy(null, restorationSubtype, null);
  if (!hierarchy.caseType) return "uncategorized";
  const mapped = hierarchyToCaseCategory(hierarchy);
  return mapped ?? "uncategorized";
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

function firstListValue(value: string | null | undefined): string | null {
  const first = value?.split(",")[0]?.trim();
  return first || null;
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

export interface CompactWorkDetails {
  /** "C" (restorative), "D" (removable), "O" (ortho / appliances), the raw
   * restoration type as a fallback, or null when there's nothing to show. */
  typeLabel: string | null;
  material: string | null;
  detail: string | null;
}

/**
 * Cases arrive as compact list rows, not full restoration objects. Build the
 * short work summary from that list contract so canonical and legacy-projected
 * cases use the same card treatment.
 *
 * Shared by the Cases tab and the Dashboard tab so both case-preview cards
 * render identical type/material/detail text — do not fork this per screen.
 */
export function getCompactWorkDetails(c: CanonicalCase): CompactWorkDetails {
  const restorationType = firstListValue(c.restorationTypes);
  const material = firstListValue(c.restorationMaterials);
  const hierarchy = deriveCaseHierarchy(
    restorationType,
    c.firstRestorationSubtype,
    material,
  );
  const typeText = `${restorationType ?? ""} ${c.firstRestorationSubtype ?? ""}`.toLowerCase();
  let caseType =
    hierarchy.caseType ??
    (/removable|denture|partial|flipper|nesbit/.test(typeText)
      ? "removable"
      : // Keep this ortho keyword set aligned with the dashboard's
        // deriveCaseTypeIndicator (and the desktop classifier) so the sort
        // order can never disagree with the letter shown on the row.
        ORTHO_RE.test(typeText)
        ? "ortho"
        : /crown|bridge|implant|veneer|restorative|temporary/.test(typeText)
          ? "restorative"
          : null);

  // Everything above sees only the FIRST comma-separated restoration, while
  // the Case Type sort classifies the whole comma-joined string with
  // restorative-then-removable precedence. Re-check a mixed row here so an
  // appliance listed alongside crown or denture work can't display "O" while
  // sorting into the C or D group. A structured ortho subtype is
  // authoritative (the sort honors it too), so it skips this.
  if (caseType === "ortho" && c.firstRestorationSubtype?.split("/")[0] !== "ortho") {
    const allTypes = c.restorationTypes ?? "";
    if (IMPLANT_RE.test(allTypes) || CROWN_BRIDGE_RE.test(allTypes)) {
      caseType = "restorative";
    } else if (REMOVABLE_RE.test(allTypes)) {
      caseType = "removable";
    }
  }

  if (caseType === "restorative") {
    return {
      typeLabel: "C",
      material,
      detail: c.teeth?.trim() ? `Teeth ${c.teeth.trim()}` : null,
    };
  }
  if (caseType === "removable") {
    return {
      typeLabel: "D",
      material,
      detail: c.step?.trim() ? titleCase(c.step) : null,
    };
  }
  if (caseType === "ortho") {
    return {
      typeLabel: "O",
      material,
      detail: null,
    };
  }

  return {
    typeLabel: restorationType,
    material,
    detail: null,
  };
}
