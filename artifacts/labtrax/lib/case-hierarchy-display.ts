import type { CatalogTreeResult } from "@workspace/api-client-react";
import {
  getCaseTypeLabel, getMaterialSubtypeLabel, getSubtypeLabel,
  deriveCaseHierarchy, type CaseHierarchy,
} from "@workspace/case-taxonomy";

export interface SavedHierarchyValues {
  restorationType?: string | null;
  restorationSubtype?: string | null;
  material?: string | null;
}

/** Display labels must not depend on whether the selectable catalog has arrived. */
export function caseHierarchyLabels(
  hierarchy: CaseHierarchy | null,
  saved: SavedHierarchyValues = {},
  catalog?: CatalogTreeResult["data"],
  mixed = false,
) {
  if (mixed) return { type: "Multiple", subtype: "Multiple", material: "Multiple" };
  const ct = hierarchy?.caseType;
  const st = hierarchy?.subtype;
  const mat = hierarchy?.materialSubtype;
  const stKey = st ?? (hierarchy?.customSubtypeId ? `custom:${hierarchy.customSubtypeId}` : null);
  const matKey = mat ?? (hierarchy?.customMaterialSubtypeId ? `custom:${hierarchy.customMaterialSubtypeId}` : null);
  const subtype = catalog?.caseTypes.find((node) => node.key === ct)?.subtypes.find((node) => node.key === stKey);
  return {
    type: ct ? getCaseTypeLabel(ct) : saved.restorationType?.trim() || "—",
    subtype: subtype?.label || (ct && st ? getSubtypeLabel(ct, st) :
      hierarchy?.customSubtypeId ? saved.restorationType?.trim() || `Custom subtype (${hierarchy.customSubtypeId})` :
        saved.restorationSubtype?.trim() || "—"),
    material: subtype?.materials.find((node) => node.key === matKey)?.label ||
      saved.material?.trim() ||
      (ct && st && mat ? getMaterialSubtypeLabel(ct, st, mat) :
        hierarchy?.customMaterialSubtypeId ? `Custom material (${hierarchy.customMaterialSubtypeId})` : "—"),
  };
}

export function hasMixedCaseHierarchy(rows: ReadonlyArray<SavedHierarchyValues>) {
  const identity = (row: SavedHierarchyValues) => {
    const hierarchy = deriveCaseHierarchy(row.restorationType, row.restorationSubtype, row.material);
    // Unmapped legacy values must not collapse to the same all-null hierarchy.
    return JSON.stringify([
      hierarchy,
      hierarchy.caseType ? null : row.restorationType?.trim() || null,
      hierarchy.subtype || hierarchy.customSubtypeId ? null : row.restorationSubtype?.trim() || null,
      hierarchy.materialSubtype || hierarchy.customMaterialSubtypeId ? null : row.material?.trim() || null,
    ]);
  };
  return rows.length > 1 && rows.slice(1).some((row) => identity(row) !== identity(rows[0]));
}
