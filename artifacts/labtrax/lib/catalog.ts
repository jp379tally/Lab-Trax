import {
  useGetCatalogTree,
  getGetCatalogTreeQueryKey,
  type EffectiveCatalogTree,
  type EffectiveCaseTypeNode,
  type EffectiveSubtypeNode,
  type EffectiveMaterialNode,
} from "@workspace/api-client-react";
import {
  CASE_TAXONOMY,
  CASE_TYPES,
  deriveCaseHierarchy,
  encodeRestorationSubtype,
  isCustomToken,
  parseCustomToken,
  type CaseType,
  type CaseHierarchy,
} from "@workspace/case-taxonomy";

export type CatalogCaseTypeNode = EffectiveCaseTypeNode;
export type CatalogSubtypeNode = EffectiveSubtypeNode;
export type CatalogMaterialNode = EffectiveMaterialNode;

/**
 * The API tree is authoritative. This static tree is only used while the
 * request is loading (and in offline/test environments), so existing entry
 * flows never render a blank cascade.
 */
function fallbackCatalog(): EffectiveCatalogTree {
  return {
    labOrganizationId: "",
    caseTypes: CASE_TYPES.map((caseType) => ({
      key: caseType,
      label: CASE_TAXONOMY[caseType].label,
      subtypes: Object.entries(CASE_TAXONOMY[caseType].subtypes).map(
        ([subtypeKey, subtype]) => ({
          id: null,
          key: subtypeKey,
          label: subtype.label,
          isCustom: false,
          isActive: true,
          sortOrder: 0,
          priceKey: null,
          materials: Object.entries(subtype.materialSubtypes).map(
            ([materialKey, material]) => ({
              id: null,
              key: materialKey,
              label: material.label,
              isCustom: false,
              isActive: true,
              sortOrder: 0,
              priceKey: material.pricingKey,
            }),
          ),
        }),
      ),
    })),
  };
}

const FALLBACK_CATALOG = fallbackCatalog();

export function useEffectiveCatalog(labOrganizationId: string | null | undefined) {
  const query = useGetCatalogTree(
    { labOrganizationId: labOrganizationId ?? "" },
    {
      query: {
        queryKey: getGetCatalogTreeQueryKey({
          labOrganizationId: labOrganizationId ?? "",
        }),
        enabled: !!labOrganizationId,
        staleTime: 120_000,
      },
    },
  );

  return {
    ...query,
    catalog: query.data?.data ?? FALLBACK_CATALOG,
  };
}

export function activeCaseTypes(catalog: EffectiveCatalogTree): CatalogCaseTypeNode[] {
  return catalog.caseTypes;
}

export function activeSubtypes(
  catalog: EffectiveCatalogTree,
  caseTypeKey: string | null | undefined,
): CatalogSubtypeNode[] {
  return (
    catalog.caseTypes.find((node) => node.key === caseTypeKey)?.subtypes ?? []
  ).filter((node) => node.isActive);
}

export function activeMaterials(
  catalog: EffectiveCatalogTree,
  caseTypeKey: string | null | undefined,
  subtypeKey: string | null | undefined,
): CatalogMaterialNode[] {
  return (
    activeSubtypes(catalog, caseTypeKey).find((node) => node.key === subtypeKey)
      ?.materials ?? []
  ).filter((node) => node.isActive);
}

export function findCaseType(
  catalog: EffectiveCatalogTree,
  labelOrKey: string | null | undefined,
): CatalogCaseTypeNode | undefined {
  const value = labelOrKey?.trim().toLowerCase();
  if (!value) return undefined;
  return catalog.caseTypes.find(
    (node) => node.key.toLowerCase() === value || node.label.toLowerCase() === value,
  );
}

export function findSubtype(
  catalog: EffectiveCatalogTree,
  caseTypeKey: string | null | undefined,
  labelOrKey: string | null | undefined,
): CatalogSubtypeNode | undefined {
  const value = labelOrKey?.trim().toLowerCase();
  if (!value) return undefined;
  return activeSubtypes(catalog, caseTypeKey).find(
    (node) => node.key.toLowerCase() === value || node.label.toLowerCase() === value,
  );
}

export function findMaterial(
  catalog: EffectiveCatalogTree,
  caseTypeKey: string | null | undefined,
  subtypeKey: string | null | undefined,
  labelOrKey: string | null | undefined,
): CatalogMaterialNode | undefined {
  const value = labelOrKey?.trim().toLowerCase();
  if (!value) return undefined;
  return activeMaterials(catalog, caseTypeKey, subtypeKey).find(
    (node) => node.key.toLowerCase() === value || node.label.toLowerCase() === value,
  );
}

function customIdForKey(key: string | null | undefined): string | undefined {
  if (!key || !isCustomToken(key)) return undefined;
  return parseCustomToken(key) ?? undefined;
}

export function encodeCatalogSelection(
  caseTypeKey: string | null | undefined,
  subtypeKey: string | null | undefined,
  materialKey?: string | null,
): string | undefined {
  if (!caseTypeKey || !subtypeKey) return undefined;
  const encoded = encodeRestorationSubtype({
    caseType: caseTypeKey as CaseType,
    subtype: isCustomToken(subtypeKey) ? null : (subtypeKey as CaseHierarchy["subtype"]),
    customSubtypeId: customIdForKey(subtypeKey),
    materialSubtype:
      materialKey && !isCustomToken(materialKey)
        ? (materialKey as CaseHierarchy["materialSubtype"])
        : null,
    customMaterialSubtypeId: customIdForKey(materialKey),
  });
  return encoded ?? undefined;
}

export interface CatalogSelection {
  caseTypeKey?: string;
  subtypeKey?: string;
  materialSubtypeKey?: string;
}

/**
 * Resolves both modern structured values and older free text against the
 * effective catalog. Unmatched text is intentionally not returned as a key,
 * allowing callers to keep displaying/editing that legacy value.
 */
export function resolveCatalogSelection(
  catalog: EffectiveCatalogTree,
  restorationType?: string | null,
  restorationSubtype?: string | null,
  material?: string | null,
): CatalogSelection {
  const hierarchy = deriveCaseHierarchy(restorationType, restorationSubtype, material);
  const caseType = hierarchy.caseType
    ? findCaseType(catalog, hierarchy.caseType)
    : findCaseType(catalog, restorationType);
  if (!caseType) return {};

  const subtypeKey =
    hierarchy.subtype ??
    (hierarchy.customSubtypeId ? `custom:${hierarchy.customSubtypeId}` : undefined);
  const subtype =
    findSubtype(catalog, caseType.key, subtypeKey) ??
    findSubtype(catalog, caseType.key, restorationType);
  if (!subtype) return { caseTypeKey: caseType.key };

  const materialKey =
    hierarchy.materialSubtype ??
    (hierarchy.customMaterialSubtypeId
      ? `custom:${hierarchy.customMaterialSubtypeId}`
      : undefined);
  const materialNode =
    findMaterial(catalog, caseType.key, subtype.key, materialKey) ??
    findMaterial(catalog, caseType.key, subtype.key, material);

  return {
    caseTypeKey: caseType.key,
    subtypeKey: subtype.key,
    ...(materialNode ? { materialSubtypeKey: materialNode.key } : {}),
  };
}

export function catalogLabelForKey(
  catalog: EffectiveCatalogTree,
  key: string | null | undefined,
): string | undefined {
  if (!key) return undefined;
  for (const caseType of catalog.caseTypes) {
    if (caseType.key === key) return caseType.label;
    const subtype = caseType.subtypes.find((node) => node.key === key);
    if (subtype) return subtype.label;
    const material = caseType.subtypes
      .flatMap((node) => node.materials)
      .find((node) => node.key === key);
    if (material) return material.label;
  }
  return undefined;
}

export function catalogSubtypeLabel(
  catalog: EffectiveCatalogTree,
  restorationType?: string | null,
  restorationSubtype?: string | null,
): string | undefined {
  const selection = resolveCatalogSelection(catalog, restorationType, restorationSubtype);
  return selection.subtypeKey
    ? catalogLabelForKey(catalog, selection.subtypeKey)
    : undefined;
}