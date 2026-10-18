/**
 * LabTrax Case Taxonomy — 3-level hierarchy
 *
 * Level 1: caseType  (restorative | removable | ortho)
 * Level 2: subtype   (crown_and_bridge | implant | … | night_guards | …)
 * Level 3: materialSubtype (zirconia | pfm | acrylic | night_guard_hard | …)
 *
 * This file is the single source of truth for lab case categorisation. Both
 * the API server and the Expo mobile app import from this package so the
 * taxonomy stays in sync across platforms.
 */

// ─────────────────────────────── Types ───────────────────────────────────────

export type CaseType = "restorative" | "removable" | "ortho";

export type RestorativeSubtype = "crown_and_bridge" | "crown" | "bridge" | "implant" | "temporaries";
export type RemovableSubtype =
  | "dentures"
  | "partials"
  | "nesbits"
  | "flippers"
  | "essix_with_teeth"
  | "repair_denture"
  | "repair_partial"
  /** Generic catch-all for AI-imported removable cases where the specific
   *  subtype cannot be inferred from the free-text input (e.g. bare
   *  "Removable" or "Removable / Acrylic"). Ensures the structured-subtype
   *  fast-path is used on re-sync instead of the regex fallback. */
  | "removable_other";
export type OrthoSubtype =
  | "retainers"
  | "hawley_retainers"
  | "essix_without_teeth"
  | "night_guards"
  | "sports_guards"
  | "retainer_lingual_bar"
  | "space_maintainer"
  | "bleach_tray";

export type CaseSubtype = RestorativeSubtype | RemovableSubtype | OrthoSubtype;

export type RestorativeMaterialSubtype = "zirconia" | "pfz" | "emax" | "pfm" | "resin" | "pmma";
export type RemovableMaterialSubtype = "acrylic" | "flexible" | "cast_metal";
export type OrthoMaterialSubtype =
  | "night_guard_hard"
  | "night_guard_hard_soft"
  | "night_guard_soft";
export type MaterialSubtype =
  | RestorativeMaterialSubtype
  | RemovableMaterialSubtype
  | OrthoMaterialSubtype;

export interface CaseHierarchy {
  caseType: CaseType | null;
  subtype: CaseSubtype | null;
  materialSubtype: MaterialSubtype | null;
  /**
   * Present only when `subtype` is null because this hierarchy references a
   * lab-added custom subtype (see @workspace/case-taxonomy `lib-catalog`
   * custom-token helpers below) rather than one of the fixed taxonomy keys.
   * Deliberately optional/undefined (never explicit null) when not
   * applicable, so plain built-in hierarchies keep round-tripping through
   * `toEqual` against 3-key literal objects unchanged.
   */
  customSubtypeId?: string;
  /**
   * Present only when `materialSubtype` is null because this hierarchy
   * references a lab-added custom material. Same optionality rule as
   * `customSubtypeId`.
   */
  customMaterialSubtypeId?: string;
}

export interface MaterialSubtypeEntry {
  label: string;
  pricingKey: string | null;
}

export interface SubtypeEntry {
  label: string;
  materialSubtypes: Partial<Record<MaterialSubtype, MaterialSubtypeEntry>>;
}

export interface CaseTypeEntry {
  label: string;
  subtypes: Partial<Record<CaseSubtype, SubtypeEntry>>;
}

// ────────────────────────── Taxonomy tree ────────────────────────────────────

export const CASE_TAXONOMY: Record<CaseType, CaseTypeEntry> = {
  restorative: {
    label: "Restorative",
    subtypes: {
      crown_and_bridge: {
        label: "Crown & Bridge",
        materialSubtypes: {
          zirconia: { label: "Zirconia", pricingKey: "zirconia_crown" },
          pfz: { label: "PFZ (Porcelain Fused to Zirconia)", pricingKey: "zirconia_crown" },
          emax: { label: "E.max / Lithium Disilicate", pricingKey: "emax_crown" },
          pfm: { label: "PFM (Porcelain Fused to Metal)", pricingKey: "pfm_crown" },
          resin: { label: "Resin / Composite", pricingKey: null },
          pmma: { label: "PMMA", pricingKey: null },
        },
      },
      implant: {
        label: "Implant",
        materialSubtypes: {
          zirconia: { label: "Zirconia", pricingKey: "zirconia_crown" },
          pfz: { label: "PFZ", pricingKey: "zirconia_crown" },
          emax: { label: "E.max / Lithium Disilicate", pricingKey: "emax_crown" },
          pfm: { label: "PFM", pricingKey: "pfm_crown" },
          resin: { label: "Resin / Composite", pricingKey: null },
          pmma: { label: "PMMA", pricingKey: null },
        },
      },
      crown: {
        label: "Crown",
        materialSubtypes: {
          zirconia: { label: "Zirconia", pricingKey: "zirconia_crown" },
          pfz: { label: "PFZ (Porcelain Fused to Zirconia)", pricingKey: "zirconia_crown" },
          emax: { label: "E.max / Lithium Disilicate", pricingKey: "emax_crown" },
          pfm: { label: "PFM (Porcelain Fused to Metal)", pricingKey: "pfm_crown" },
          resin: { label: "Resin / Composite", pricingKey: null },
          pmma: { label: "PMMA", pricingKey: null },
        },
      },
      bridge: {
        label: "Bridge",
        materialSubtypes: {
          zirconia: { label: "Zirconia", pricingKey: "zirconia_crown" },
          pfz: { label: "PFZ (Porcelain Fused to Zirconia)", pricingKey: "zirconia_crown" },
          emax: { label: "E.max / Lithium Disilicate", pricingKey: "emax_crown" },
          pfm: { label: "PFM (Porcelain Fused to Metal)", pricingKey: "pfm_crown" },
          resin: { label: "Resin / Composite", pricingKey: null },
          pmma: { label: "PMMA", pricingKey: null },
        },
      },
      temporaries: {
        label: "Temporary",
        materialSubtypes: {
          resin: { label: "Resin / Composite", pricingKey: null },
          pmma: { label: "PMMA", pricingKey: null },
        },
      },
    },
  },
  removable: {
    label: "Removable",
    subtypes: {
      dentures: {
        label: "Dentures",
        materialSubtypes: {
          acrylic: { label: "Acrylic", pricingKey: "denture" },
          flexible: { label: "Flexible (Valplast / Nylon)", pricingKey: "partial" },
          cast_metal: { label: "Cast Metal", pricingKey: "partial" },
        },
      },
      partials: {
        label: "Partials",
        materialSubtypes: {
          acrylic: { label: "Acrylic", pricingKey: "partial" },
          resin: { label: "Resin / Composite", pricingKey: null },
          flexible: { label: "Flexible (Valplast / Nylon)", pricingKey: "partial" },
          cast_metal: { label: "Cast Metal", pricingKey: "partial" },
        },
      },
      nesbits: {
        label: "Nesbits",
        materialSubtypes: {
          acrylic: { label: "Acrylic", pricingKey: "partial" },
          resin: { label: "Resin / Composite", pricingKey: null },
          flexible: { label: "Flexible (Valplast / Nylon)", pricingKey: "partial" },
          cast_metal: { label: "Cast Metal", pricingKey: "partial" },
        },
      },
      flippers: {
        label: "Flippers",
        materialSubtypes: {
          acrylic: { label: "Acrylic", pricingKey: "partial" },
          resin: { label: "Resin / Composite", pricingKey: null },
          flexible: { label: "Flexible (Valplast / Nylon)", pricingKey: "partial" },
          cast_metal: { label: "Cast Metal", pricingKey: "partial" },
        },
      },
      essix_with_teeth: {
        label: "Essix (with prosthetic teeth)",
        materialSubtypes: {
          acrylic: { label: "Acrylic", pricingKey: "retainer_hard" },
        },
      },
      repair_denture: {
        label: "Repair Denture",
        materialSubtypes: {
          acrylic: { label: "Acrylic", pricingKey: null },
        },
      },
      repair_partial: {
        label: "Repair Partial",
        materialSubtypes: {
          acrylic: { label: "Acrylic", pricingKey: null },
          flexible: { label: "Flexible (Valplast / Nylon)", pricingKey: null },
          cast_metal: { label: "Cast Metal", pricingKey: null },
        },
      },
      removable_other: {
        label: "Removable (Other / Unspecified)",
        materialSubtypes: {
          acrylic: { label: "Acrylic", pricingKey: null },
          flexible: { label: "Flexible (Valplast / Nylon)", pricingKey: null },
          cast_metal: { label: "Cast Metal", pricingKey: null },
        },
      },
    },
  },
  ortho: {
    label: "Ortho / Appliances",
    subtypes: {
      retainers: {
        label: "Retainers (Essix / clear)",
        materialSubtypes: {},
      },
      hawley_retainers: {
        label: "Hawley Retainers",
        materialSubtypes: {},
      },
      essix_without_teeth: {
        label: "Essix (without prosthetic teeth)",
        materialSubtypes: {},
      },
      night_guards: {
        label: "Night Guards",
        materialSubtypes: {
          night_guard_hard: { label: "Hard", pricingKey: "night_guard_hard" },
          night_guard_hard_soft: { label: "Hard-Soft (Dual Laminate)", pricingKey: "night_guard_hard_soft" },
          night_guard_soft: { label: "Soft", pricingKey: "night_guard_soft" },
        },
      },
      sports_guards: {
        label: "Sports Guards",
        materialSubtypes: {},
      },
      retainer_lingual_bar: {
        label: "Retainer (Lingual Bar)",
        materialSubtypes: {},
      },
      space_maintainer: {
        label: "Space Maintainer",
        materialSubtypes: {},
      },
      bleach_tray: {
        label: "Bleach Tray",
        materialSubtypes: {},
      },
    },
  },
};

// ─────────────────────── Exported lists ──────────────────────────────────────

export const CASE_TYPES: CaseType[] = Object.keys(CASE_TAXONOMY) as CaseType[];

export function getSubtypes(caseType: CaseType): CaseSubtype[] {
  return Object.keys(CASE_TAXONOMY[caseType].subtypes) as CaseSubtype[];
}

export function getMaterialSubtypes(
  caseType: CaseType,
  subtype: CaseSubtype,
): MaterialSubtype[] {
  const sub = (CASE_TAXONOMY[caseType] as CaseTypeEntry).subtypes[subtype];
  if (!sub) return [];
  return Object.keys(sub.materialSubtypes) as MaterialSubtype[];
}

export function getCaseTypeLabel(caseType: CaseType): string {
  return CASE_TAXONOMY[caseType].label;
}

export function getSubtypeLabel(caseType: CaseType, subtype: CaseSubtype): string {
  return (CASE_TAXONOMY[caseType] as CaseTypeEntry).subtypes[subtype]?.label ?? subtype;
}

export function getMaterialSubtypeLabel(
  caseType: CaseType,
  subtype: CaseSubtype,
  materialSubtype: MaterialSubtype,
): string {
  return (
    (CASE_TAXONOMY[caseType] as CaseTypeEntry).subtypes[subtype]?.materialSubtypes[
      materialSubtype
    ]?.label ?? materialSubtype
  );
}

/**
 * Given a taxonomy hierarchy, return the pricing key from the materialSubtype
 * entry (if any). Returns null when no specific pricing key is configured.
 */
export function getPricingKey(hierarchy: CaseHierarchy): string | null {
  if (!hierarchy.caseType || !hierarchy.subtype || !hierarchy.materialSubtype) return null;
  const entry = (CASE_TAXONOMY[hierarchy.caseType] as CaseTypeEntry).subtypes[
    hierarchy.subtype
  ]?.materialSubtypes[hierarchy.materialSubtype];
  return entry?.pricingKey ?? null;
}

// ──────────────────────── Alias tables ───────────────────────────────────────

/**
 * Maps legacy free-text restorationType strings → CaseType. Case-insensitive
 * prefix/substring matching against the alias list.
 */
const CASE_TYPE_ALIASES: Array<{ pattern: RegExp; caseType: CaseType }> = [
  // Removable
  { pattern: /denture|partial|flipper|nesbit|valplast|nylon|removable/i, caseType: "removable" },
  // Ortho/appliances
  { pattern: /retainer|night\s*guard|bite\s*guard|occlusal\s*guard|sports?\s*guard|bruxism|snore|mouthguard/i, caseType: "ortho" },
  // Restorative (catch-all)
  { pattern: /crown|bridge|implant|veneer|inlay|onlay|temp|provisional|restoration/i, caseType: "restorative" },
];

/**
 * Maps free-text restorationType → CaseSubtype.
 */
const SUBTYPE_ALIASES: Array<{ pattern: RegExp; subtype: CaseSubtype }> = [
  // Removable subtypes — repair patterns must come before bare "denture"/"partial"
  // so "repair denture" maps to repair_denture (not dentures).
  { pattern: /repair\s+denture/i, subtype: "repair_denture" },
  { pattern: /repair\s+partial/i, subtype: "repair_partial" },
  // "add tooth to …" and "replace tooth on …" patterns must come before the bare
  // partial/denture catch-alls so they resolve to the correct repair subtype.
  { pattern: /add\s+tooth\s+to\s+(?:(?:lower|upper)\s+)?partial|replace\s+tooth\s+on\s+(?:(?:lower|upper)\s+)?partial/i, subtype: "repair_partial" },
  { pattern: /add\s+tooth\s+to\s+(?:(?:lower|upper)\s+)?denture|replace\s+tooth\s+on\s+(?:(?:lower|upper)\s+)?denture/i, subtype: "repair_denture" },
  // Bare "add tooth" / "replace tooth" with no appliance qualifier — most
  // likely a partial repair; surfaced as repair_partial by default.
  { pattern: /\badd\s+tooth\b|\breplace\s+tooth\b/i, subtype: "repair_partial" },
  // "partial" patterns must come before bare "denture"
  // so "Partial Denture" maps to partials (not dentures).
  { pattern: /partial\s+denture|partial\s+plate|flipper\s+partial/i, subtype: "partials" },
  { pattern: /denture/i, subtype: "dentures" },
  { pattern: /partial/i, subtype: "partials" },
  { pattern: /nesbit/i, subtype: "nesbits" },
  { pattern: /flipper/i, subtype: "flippers" },
  // Catch-all: bare "Removable" (or "Removable / <material>") where no more
  // specific subtype keyword was found. Must come after all specific removable
  // patterns so "Partial Denture" still resolves to "partials".
  { pattern: /\bremovable\b/i, subtype: "removable_other" },
  // Ortho subtypes
  { pattern: /hawley/i, subtype: "hawley_retainers" },
  { pattern: /night\s*guard|bite\s*guard|occlusal\s*guard|bruxism/i, subtype: "night_guards" },
  { pattern: /sports?\s*guard|mouthguard/i, subtype: "sports_guards" },
  { pattern: /retainer/i, subtype: "retainers" },
  // Restorative subtypes
  { pattern: /implant/i, subtype: "implant" },
  { pattern: /temp|provisional/i, subtype: "temporaries" },
  { pattern: /crown|bridge|veneer|inlay|onlay/i, subtype: "crown_and_bridge" },
];

/**
 * Maps free-text material strings → MaterialSubtype.
 */
const MATERIAL_SUBTYPE_ALIASES: Array<{ pattern: RegExp; materialSubtype: MaterialSubtype }> = [
  // Ortho guard subtypes (checked before broad zirconia match)
  { pattern: /hard[\s-]soft|dual\s*lam/i, materialSubtype: "night_guard_hard_soft" },
  { pattern: /\bhard\b/i, materialSubtype: "night_guard_hard" },
  { pattern: /\bsoft\b/i, materialSubtype: "night_guard_soft" },
  // Restorative
  { pattern: /pfz|porcelain\s+fused\s+to\s+zir/i, materialSubtype: "pfz" },
  { pattern: /zircon|bruxzir|bioxn|zr\b|BruxZir/i, materialSubtype: "zirconia" },
  { pattern: /e\.?max|lithium\s+disilicate|emax/i, materialSubtype: "emax" },
  { pattern: /pfm|porcelain\s+fused\s+to\s+metal/i, materialSubtype: "pfm" },
  { pattern: /pmma/i, materialSubtype: "pmma" },
  { pattern: /resin|composite/i, materialSubtype: "resin" },
  // Removable
  { pattern: /valplast|nylon|flexible/i, materialSubtype: "flexible" },
  { pattern: /cast\s*metal|cobalt|chrome/i, materialSubtype: "cast_metal" },
  { pattern: /acrylic/i, materialSubtype: "acrylic" },
];

// ──────────────────── Custom (lab-catalog) entry tokens ───────────────────────
//
// A lab admin can add custom subtypes/materials on top of this static
// taxonomy (see the api-server `lab-catalog` feature). Those rows live in a
// per-lab table, not here, so they have no fixed taxonomy key of their own.
// To let a `case_restorations.restorationSubtype` value reference one
// unambiguously — while staying decodable by `deriveCaseHierarchy` above —
// a custom entry is encoded as `"custom:<catalogEntryId>"` in the subtype
// and/or materialSubtype segment instead of a literal taxonomy key.

const CUSTOM_TOKEN_PREFIX = "custom:";

/** Encode a lab-catalog entry id as a `restorationSubtype` segment token. */
export function encodeCustomToken(id: string): string {
  return `${CUSTOM_TOKEN_PREFIX}${id}`;
}

/** True when `value` is a `"custom:<id>"` segment token (non-empty id). */
export function isCustomToken(value: string | null | undefined): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(CUSTOM_TOKEN_PREFIX) &&
    value.length > CUSTOM_TOKEN_PREFIX.length
  );
}

/** Extract the catalog entry id from a `"custom:<id>"` token, or null. */
export function parseCustomToken(value: string | null | undefined): string | null {
  if (!isCustomToken(value)) return null;
  return (value as string).slice(CUSTOM_TOKEN_PREFIX.length);
}

// ─────────────────────── Inference helpers ───────────────────────────────────

function inferCaseType(restorationType: string | null): CaseType | null {
  if (!restorationType) return null;
  for (const { pattern, caseType } of CASE_TYPE_ALIASES) {
    if (pattern.test(restorationType)) return caseType;
  }
  return null;
}

function inferSubtype(restorationType: string | null): CaseSubtype | null {
  if (!restorationType) return null;
  for (const { pattern, subtype } of SUBTYPE_ALIASES) {
    if (pattern.test(restorationType)) return subtype;
  }
  return null;
}

function inferMaterialSubtype(
  material: string | null,
  caseType: CaseType | null,
  subtype: CaseSubtype | null,
): MaterialSubtype | null {
  if (!material) return null;
  // Restrict alias candidates to those valid for the resolved caseType/subtype
  for (const { pattern, materialSubtype } of MATERIAL_SUBTYPE_ALIASES) {
    if (!pattern.test(material)) continue;
    if (caseType && subtype) {
      const valid = getMaterialSubtypes(caseType, subtype);
      if (valid.length > 0 && !valid.includes(materialSubtype)) continue;
    }
    return materialSubtype;
  }
  return null;
}

// ─────────────────── Public normalisation functions ──────────────────────────

/**
 * Derive a CaseHierarchy from existing row data (restorationType,
 * restorationSubtype, material). Prefers the explicit `restorationSubtype`
 * column (new rows) and falls back to inferring from free-text strings.
 *
 * Non-mutating — safe to use on both canonical and legacy rows.
 */
export function deriveCaseHierarchy(
  restorationType: string | null | undefined,
  restorationSubtype: string | null | undefined,
  material: string | null | undefined,
): CaseHierarchy {
  // If the explicit subtype key is already stored, try to decode it directly.
  if (restorationSubtype) {
    const explicit = decodeRestorationSubtype(restorationSubtype);
    if (explicit) return explicit;
  }

  const rt = restorationType ?? null;
  const mat = material ?? null;

  const caseType = inferCaseType(rt);
  const subtype = inferSubtype(rt);
  const materialSubtype = inferMaterialSubtype(mat, caseType, subtype);
  return { caseType, subtype, materialSubtype };
}

/**
 * Parse a stored `restorationSubtype` column value of the form
 * `"<caseType>/<subtype>"` or `"<caseType>/<subtype>/<materialSubtype>"`.
 * Returns null when the value doesn't match the expected format.
 *
 * The subtype and/or materialSubtype segment may instead be a `"custom:<id>"`
 * token (see `isCustomToken`/`parseCustomToken` above) referencing a
 * lab-catalog entry rather than a fixed taxonomy key. Custom tokens are
 * accepted purely by format — this function never checks whether the id
 * still exists — so `caseType` always resolves for a well-formed value even
 * when the referenced custom entry has since been renamed or removed; the
 * corresponding `subtype`/`materialSubtype` literal field is left null and
 * `customSubtypeId`/`customMaterialSubtypeId` is set instead. A segment that
 * is neither a recognised literal key nor a custom token is treated as
 * genuinely malformed and fails exactly as before (whole-value null for an
 * unrecognised subtype; a lone unrecognised materialSubtype degrades to
 * null without failing the rest of the hierarchy).
 */
function decodeRestorationSubtype(value: string): CaseHierarchy | null {
  const parts = value.split("/");
  if (parts.length < 2 || parts.length > 3) return null;
  const [ct, st, ms] = parts as [string, string, string | undefined];
  if (!CASE_TYPES.includes(ct as CaseType)) return null;
  const caseType = ct as CaseType;

  let subtype: CaseSubtype | null = null;
  let customSubtypeId: string | undefined;
  const stCustomId = parseCustomToken(st);
  if (stCustomId !== null) {
    customSubtypeId = stCustomId;
  } else {
    const subtypes = getSubtypes(caseType);
    if (!subtypes.includes(st as CaseSubtype)) return null;
    subtype = st as CaseSubtype;
  }

  let materialSubtype: MaterialSubtype | null = null;
  let customMaterialSubtypeId: string | undefined;
  if (ms) {
    const msCustomId = parseCustomToken(ms);
    if (msCustomId !== null) {
      customMaterialSubtypeId = msCustomId;
    } else if (subtype) {
      const matSubtypes = getMaterialSubtypes(caseType, subtype);
      materialSubtype = matSubtypes.includes(ms as MaterialSubtype)
        ? (ms as MaterialSubtype)
        : null;
    }
    // else: literal-looking materialSubtype segment under a custom (or
    // unresolved) subtype has no taxonomy context to validate against —
    // discard gracefully rather than failing the whole decode.
  }

  return {
    caseType,
    subtype,
    materialSubtype,
    ...(customSubtypeId !== undefined ? { customSubtypeId } : {}),
    ...(customMaterialSubtypeId !== undefined ? { customMaterialSubtypeId } : {}),
  };
}

/**
 * Encode a CaseHierarchy into the `restorationSubtype` column format:
 * `"<caseType>/<subtype>"` or `"<caseType>/<subtype>/<materialSubtype>"`.
 * Returns null when caseType is missing, or when neither a literal `subtype`
 * nor a `customSubtypeId` is available to fill the second segment.
 *
 * When `subtype`/`materialSubtype` are null but `customSubtypeId`/
 * `customMaterialSubtypeId` are set, those segments are encoded as
 * `"custom:<id>"` tokens instead (see `encodeCustomToken`). Literal keys
 * always take priority, so existing callers that never set the custom
 * fields see no change in output.
 */
export function encodeRestorationSubtype(hierarchy: CaseHierarchy): string | null {
  if (!hierarchy.caseType) return null;
  const subtypeSegment =
    hierarchy.subtype ??
    (hierarchy.customSubtypeId ? encodeCustomToken(hierarchy.customSubtypeId) : null);
  if (!subtypeSegment) return null;
  const parts: string[] = [hierarchy.caseType, subtypeSegment];
  const materialSegment =
    hierarchy.materialSubtype ??
    (hierarchy.customMaterialSubtypeId ? encodeCustomToken(hierarchy.customMaterialSubtypeId) : null);
  if (materialSegment) parts.push(materialSegment);
  return parts.join("/");
}

/**
 * Normalise AI-extracted or user-supplied free-text fields into a canonical
 * CaseHierarchy, then encode it as the `restorationSubtype` column value.
 *
 * Input object mirrors what the DashboardDropZone AI parser provides:
 *   - `caseType`  — AI-extracted restoration type string (e.g. "Crown", "Night Guard")
 *   - `material`  — AI-extracted material (e.g. "Zirconia", "PFM")
 *   - `subtype`   — optional explicit subtype key (for UI picker flows)
 *   - `materialSubtype` — optional explicit materialSubtype key
 *
 * Returns `{ hierarchy, restorationSubtype }` where `restorationSubtype` is
 * the encoded column value (or null when the hierarchy is incomplete).
 */
export function normalizeCaseHierarchy(input: {
  caseType?: string | null;
  material?: string | null;
  subtype?: string | null;
  materialSubtype?: string | null;
}): { hierarchy: CaseHierarchy; restorationSubtype: string | null } {
  // Explicit picker keys take priority
  let caseType: CaseType | null = CASE_TYPES.includes(input.subtype as CaseType)
    ? null
    : (CASE_TYPES.includes(input.caseType as CaseType) ? (input.caseType as CaseType) : null);

  // Explicit subtype key
  let subtype: CaseSubtype | null = null;
  if (input.subtype && isValidSubtype(input.subtype)) {
    subtype = input.subtype as CaseSubtype;
    // Derive parent caseType from subtype if not already set
    if (!caseType) caseType = caseTypeForSubtype(input.subtype as CaseSubtype);
  }

  // Explicit materialSubtype key
  let materialSubtype: MaterialSubtype | null = null;
  if (input.materialSubtype && isValidMaterialSubtype(input.materialSubtype)) {
    materialSubtype = input.materialSubtype as MaterialSubtype;
  }

  // Fall back to inference from free-text
  if (!caseType) caseType = inferCaseType(input.caseType ?? null);
  if (!subtype) subtype = inferSubtype(input.caseType ?? null);
  // When a subtype was inferred but caseType still not set (e.g. "add tooth"
  // matches repair_partial via SUBTYPE_ALIASES but not CASE_TYPE_ALIASES),
  // derive caseType from the subtype's parent entry.
  if (!caseType && subtype) caseType = caseTypeForSubtype(subtype);
  if (!materialSubtype) {
    materialSubtype = inferMaterialSubtype(input.material ?? null, caseType, subtype);
  }

  const hierarchy: CaseHierarchy = { caseType, subtype, materialSubtype };
  return { hierarchy, restorationSubtype: encodeRestorationSubtype(hierarchy) };
}

// ───────────────────── Validation helpers ────────────────────────────────────

const ALL_SUBTYPES: CaseSubtype[] = (Object.keys(CASE_TAXONOMY) as CaseType[]).flatMap(
  (ct) => Object.keys(CASE_TAXONOMY[ct].subtypes) as CaseSubtype[],
);

const ALL_MATERIAL_SUBTYPES: MaterialSubtype[] = (
  Object.keys(CASE_TAXONOMY) as CaseType[]
).flatMap((ct) =>
  (Object.keys(CASE_TAXONOMY[ct].subtypes) as CaseSubtype[]).flatMap(
    (st) =>
      Object.keys(
        (CASE_TAXONOMY[ct] as CaseTypeEntry).subtypes[st]?.materialSubtypes ?? {},
      ) as MaterialSubtype[],
  ),
);

export function isValidCaseType(v: string): v is CaseType {
  return CASE_TYPES.includes(v as CaseType);
}

export function isValidSubtype(v: string): v is CaseSubtype {
  return ALL_SUBTYPES.includes(v as CaseSubtype);
}

export function isValidMaterialSubtype(v: string): v is MaterialSubtype {
  return ALL_MATERIAL_SUBTYPES.includes(v as MaterialSubtype);
}

/**
 * Find which CaseType owns a given subtype. Returns null if not found.
 */
export function caseTypeForSubtype(subtype: CaseSubtype): CaseType | null {
  for (const ct of CASE_TYPES) {
    if (subtype in CASE_TAXONOMY[ct].subtypes) return ct;
  }
  return null;
}

// ──────────────────── Legacy CaseCategory bridge ─────────────────────────────

/**
 * Map a CaseHierarchy to the legacy 6-value CaseCategory used by the
 * stats/case-categories analytics endpoint. This keeps the analytics
 * pipeline backward-compatible while new data accumulates.
 *
 * Mapping:
 *   restorative/implant        → "implants"
 *   restorative/crown_and_bridge or /temporaries
 *     + (zirconia|pfz) mat    → "zirconia"
 *     + other mat / unknown   → "crown_bridge"
 *   restorative/<custom subtype, no more specific match> → "crown_bridge"
 *     (this fallback is unreachable for any built-in restorative subtype —
 *     implant/crown_and_bridge/temporaries already cover every literal key —
 *     so it only ever fires for a lab-added custom subtype, giving it a
 *     sensible default bucket instead of falling through to null)
 *   removable/*               → "removable" (any subtype, built-in or custom)
 *   ortho/*                   → "other" (any subtype, built-in or custom)
 *   null                      → null (caller decides uncategorized/other)
 */
export function hierarchyToCaseCategory(
  hierarchy: CaseHierarchy,
): "implants" | "zirconia" | "crown_bridge" | "removable" | "other" | null {
  if (!hierarchy.caseType) return null;
  if (hierarchy.caseType === "removable") return "removable";
  if (hierarchy.caseType === "ortho") return "other";
  // restorative
  if (hierarchy.subtype === "implant") return "implants";
  if (
    hierarchy.materialSubtype === "zirconia" ||
    hierarchy.materialSubtype === "pfz"
  )
    return "zirconia";
  return "crown_bridge";
}

// ──── Structured taxonomy tree for GET /vocabulary?kind=case_taxonomy ─────────

export interface MaterialSubtypeTreeEntry {
  key: MaterialSubtype;
  label: string;
  pricingKey: string | null;
}

export interface SubtypeTreeEntry {
  key: CaseSubtype;
  label: string;
  materialSubtypes: MaterialSubtypeTreeEntry[];
}

export interface CaseTypeTreeEntry {
  key: CaseType;
  label: string;
  subtypes: SubtypeTreeEntry[];
}

export interface TaxonomyTree {
  caseTypes: CaseTypeTreeEntry[];
}

/**
 * Returns the full taxonomy as a 3-level nested structure
 * (caseTypes → subtypes → materialSubtypes). Used by
 * GET /vocabulary?kind=case_taxonomy so pickers can build
 * dependent cascades without flattening the hierarchy themselves.
 */
export function getTaxonomyTree(): TaxonomyTree {
  const caseTypes: CaseTypeTreeEntry[] = CASE_TYPES.map((ct) => {
    const ctEntry = CASE_TAXONOMY[ct];
    const subtypes: SubtypeTreeEntry[] = (Object.keys(ctEntry.subtypes) as CaseSubtype[]).map((st) => {
      const stEntry = ctEntry.subtypes[st]!;
      const materialSubtypes: MaterialSubtypeTreeEntry[] = (
        Object.keys(stEntry.materialSubtypes) as MaterialSubtype[]
      ).map((ms) => ({
        key: ms,
        label: stEntry.materialSubtypes[ms]!.label,
        pricingKey: stEntry.materialSubtypes[ms]!.pricingKey,
      }));
      return { key: st, label: stEntry.label, materialSubtypes };
    });
    return { key: ct, label: ctEntry.label, subtypes };
  });
  return { caseTypes };
}

// ──────────────────── Flat vocabulary for GET /vocabulary?kind=case_taxonomy ──

export interface TaxonomyVocabEntry {
  caseType: CaseType;
  caseTypeLabel: string;
  subtype: CaseSubtype | null;
  subtypeLabel: string | null;
  materialSubtype: MaterialSubtype | null;
  materialSubtypeLabel: string | null;
  pricingKey: string | null;
  /** Encoded restorationSubtype column value */
  key: string;
}

/**
 * Returns a flat list of all taxonomy leaf nodes (caseType × subtype ×
 * materialSubtype combinations) suitable for powering picker UIs.
 *
 * Each entry carries the encoded `key` (e.g. "restorative/crown_and_bridge/zirconia")
 * so callers can store it directly in the `restorationSubtype` column.
 */
export function getTaxonomyVocab(): TaxonomyVocabEntry[] {
  const entries: TaxonomyVocabEntry[] = [];
  for (const ct of CASE_TYPES) {
    const ctEntry = CASE_TAXONOMY[ct];
    const subtypes = Object.keys(ctEntry.subtypes) as CaseSubtype[];
    for (const st of subtypes) {
      const stEntry = ctEntry.subtypes[st]!;
      const matSubtypes = Object.keys(stEntry.materialSubtypes) as MaterialSubtype[];
      if (matSubtypes.length === 0) {
        entries.push({
          caseType: ct,
          caseTypeLabel: ctEntry.label,
          subtype: st,
          subtypeLabel: stEntry.label,
          materialSubtype: null,
          materialSubtypeLabel: null,
          pricingKey: null,
          key: `${ct}/${st}`,
        });
      } else {
        for (const ms of matSubtypes) {
          const msEntry = stEntry.materialSubtypes[ms]!;
          entries.push({
            caseType: ct,
            caseTypeLabel: ctEntry.label,
            subtype: st,
            subtypeLabel: stEntry.label,
            materialSubtype: ms,
            materialSubtypeLabel: msEntry.label,
            pricingKey: msEntry.pricingKey,
            key: `${ct}/${st}/${ms}`,
          });
        }
      }
    }
  }
  return entries;
}
