export * from "./implant-details";
export * from "./tooth-assignment";
import { encodeRestorationSubtype, parseCustomToken, type CaseSubtype, type MaterialSubtype } from "./taxonomy";

export function catalogToothMaterialOptions(tree: { caseTypes: readonly {
  key: string; subtypes: readonly {
    key: string; label: string; isCustom?: boolean;
    materials: readonly { key: string; label: string; isCustom?: boolean }[];
  }[];
}[] }) {
  return tree.caseTypes.filter((caseType) => caseType.key === "restorative").flatMap((caseType) =>
    caseType.subtypes.flatMap((subtype) => subtype.materials.map((material) => {
      const hierarchy = {
        caseType: "restorative" as const,
        subtype: subtype.isCustom ? null : subtype.key as CaseSubtype,
        materialSubtype: material.isCustom ? null : material.key as MaterialSubtype,
        ...(subtype.isCustom ? { customSubtypeId: parseCustomToken(subtype.key) ?? undefined } : {}),
        ...(material.isCustom ? { customMaterialSubtypeId: parseCustomToken(material.key) ?? undefined } : {}),
      };
      return {
        label: material.label,
        isCustom: !!subtype.isCustom || !!material.isCustom,
        restorationSubtype: encodeRestorationSubtype(hierarchy) ?? "",
        parentLabel: subtype.label,
        parentIsCustom: !!subtype.isCustom,
        parentSubtype: encodeRestorationSubtype({ ...hierarchy, materialSubtype: null, customMaterialSubtypeId: undefined }) ?? "",
      };
    })),
  ).filter((option) => !!option.restorationSubtype);
}
export * from "./clinical-identity";
export * from "./case-slip-renderer";
export * from "./status-groups";
export type {
  CaseType,
  CaseSubtype,
  MaterialSubtype,
  RestorativeSubtype,
  RemovableSubtype,
  OrthoSubtype,
  RestorativeMaterialSubtype,
  RemovableMaterialSubtype,
  OrthoMaterialSubtype,
  CaseHierarchy,
  CaseTypeEntry,
  SubtypeEntry,
  MaterialSubtypeEntry,
  TaxonomyVocabEntry,
  TaxonomyTree,
  CaseTypeTreeEntry,
  SubtypeTreeEntry,
  MaterialSubtypeTreeEntry,
} from "./taxonomy";

export {
  CASE_TAXONOMY,
  CASE_TYPES,
  getSubtypes,
  getMaterialSubtypes,
  getCaseTypeLabel,
  getSubtypeLabel,
  getMaterialSubtypeLabel,
  getPricingKey,
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
  getTaxonomyVocab,
  getTaxonomyTree,
} from "./taxonomy";

export {
  REMAKE_REASONS,
  REMAKE_REASON_KEYS,
  CUSTOM_REMAKE_REASON_MAX_LENGTH,
  getRemakeReason,
  remakeReasonUsesField,
} from "./remake-reasons";
export type {
  RemakeReasonKey,
  RemakeReasonCategory,
  RemakeConditionalField,
} from "./remake-reasons";
export * from "./tooth-indications";
