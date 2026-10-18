import { useId, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  EffectiveCatalogTree,
  EffectiveMaterialNode,
  EffectiveSubtypeNode,
} from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import {
  CASE_TAXONOMY,
  deriveCaseHierarchy,
  encodeRestorationSubtype,
  parseCustomToken,
} from "@workspace/case-taxonomy";
import { FieldCombobox } from "@/components/FieldCombobox";
import { ImplantDetailsControls } from "./ImplantDetailsControls";
import { isImplantRestoration, type ImplantDetails } from "@workspace/case-taxonomy";

export interface CatalogRestorationValue extends ImplantDetails {
  restorationType: string;
  material: string;
  restorationSubtype?: string | null;
  caseTypeKey?: string;
  subtypeKey?: string;
  materialSubtypeKey?: string;
}

export interface CatalogMaterialOption {
  key: string;
  label: string;
}

const LEGACY_MATERIAL_PREFIX = "legacy:";

function legacyMaterialKey(label: string) {
  return `${LEGACY_MATERIAL_PREFIX}${label}`;
}

export function useEffectiveCatalog(labOrganizationId?: string) {
  return useQuery({
    queryKey: ["catalog-tree", labOrganizationId],
    queryFn: () =>
      apiFetch<EffectiveCatalogTree>(
        `/catalog/tree?labOrganizationId=${encodeURIComponent(labOrganizationId!)}`,
      ),
    enabled: !!labOrganizationId,
    staleTime: 120_000,
  });
}

function nodeKey(id: string | null, key: string) {
  return id ? `id:${id}` : `key:${key}`;
}

function findNodeByKey<T extends { id: string | null; key: string }>(
  nodes: T[],
  key?: string,
) {
  if (!key) return undefined;
  return nodes.find((node) => node.key === key || (node.id && `custom:${node.id}` === key));
}

function findByLabel<T extends { label: string }>(nodes: T[], value?: string) {
  if (!value) return undefined;
  return nodes.find((node) => node.label.trim().toLowerCase() === value.trim().toLowerCase());
}

export function encodeCatalogSelection(
  caseTypeKey: string | undefined,
  subtypeKey: string | undefined,
  materialSubtypeKey: string | undefined,
) {
  if (!caseTypeKey || !subtypeKey) return null;
  if (materialSubtypeKey?.startsWith(LEGACY_MATERIAL_PREFIX)) return null;
  const subtypeCustomId = parseCustomToken(subtypeKey);
  const materialCustomId = materialSubtypeKey
    ? parseCustomToken(materialSubtypeKey)
    : null;
  return encodeRestorationSubtype({
    caseType: caseTypeKey as never,
    subtype: subtypeCustomId ? null : (subtypeKey as never),
    materialSubtype: materialCustomId ? null : (materialSubtypeKey as never),
    ...(subtypeCustomId ? { customSubtypeId: subtypeCustomId } : {}),
    ...(materialCustomId ? { customMaterialSubtypeId: materialCustomId } : {}),
  });
}

function catalogValues(
  catalog: EffectiveCatalogTree | undefined,
  restorationType: string,
  restorationSubtype: string | null | undefined,
  material: string | null | undefined,
) {
  const hierarchy = deriveCaseHierarchy(restorationType, restorationSubtype, material);
  const caseTypes = catalog?.caseTypes ?? [];
  const caseType = caseTypes.find((node) => node.key === hierarchy.caseType);
  const subtypes = caseType?.subtypes ?? [];
  const subtype =
    findNodeByKey(subtypes, hierarchy.subtype ?? undefined) ??
    (hierarchy.customSubtypeId
      ? subtypes.find((node) => node.id === hierarchy.customSubtypeId)
      : undefined) ??
    findByLabel(subtypes, restorationType);
  const materials = subtype?.materials ?? [];
  const materialNode =
    findNodeByKey(materials, hierarchy.materialSubtype ?? undefined) ??
    (hierarchy.customMaterialSubtypeId
      ? materials.find((node) => node.id === hierarchy.customMaterialSubtypeId)
      : undefined) ??
    findByLabel(materials, material ?? undefined);

  return {
    caseType,
    subtype,
    materialNode,
    caseTypeKey: caseType?.key ?? hierarchy.caseType ?? undefined,
    subtypeKey: subtype?.key,
    materialSubtypeKey: materialNode?.key,
  };
}

export function getCatalogMaterialsForCrown(
  catalog: EffectiveCatalogTree | undefined,
): CatalogMaterialOption[] {
  if (!Array.isArray(catalog?.caseTypes)) {
    const builtInMaterials =
      CASE_TAXONOMY.restorative.subtypes.crown_and_bridge?.materialSubtypes ?? {};
    return Object.entries(builtInMaterials).map(([key, entry]) => ({
      key,
      label: entry.label,
    }));
  }
  const restorative = (catalog?.caseTypes ?? []).find(
    (node) => node.key === "restorative",
  );
  const subtype =
    restorative?.subtypes.find((node) => node.key === "crown") ??
    restorative?.subtypes.find((node) => node.key === "crown_and_bridge") ??
    restorative?.subtypes.find((node) => /crown|bridge/i.test(node.label));
  const catalogMaterials = (subtype?.materials ?? []).map((material) => ({
    key: material.key,
    label: material.label,
  }));
  return catalogMaterials;
}

export function getCatalogMaterialsForRestoration(
  catalog: EffectiveCatalogTree | undefined,
  restoration: {
    restorationType: string;
    restorationSubtype?: string | null;
    material?: string | null;
  } | undefined,
): CatalogMaterialOption[] {
  if (!restoration) return getCatalogMaterialsForCrown(catalog);
  const hierarchy = deriveCaseHierarchy(
    restoration.restorationType,
    restoration.restorationSubtype,
    restoration.material,
  );
  const caseType = (catalog?.caseTypes ?? []).find(
    (node) => node.key === hierarchy.caseType,
  );
  const subtype =
    findNodeByKey(caseType?.subtypes ?? [], hierarchy.subtype ?? undefined) ??
    (hierarchy.customSubtypeId
      ? caseType?.subtypes.find((node) => node.id === hierarchy.customSubtypeId)
      : undefined);
  const catalogMaterials = (subtype?.materials ?? []).map((material) => ({
    key: material.key,
    label: material.label,
  }));
  if (catalogMaterials.length > 0) return catalogMaterials;

  const fallbackMaterials = getCatalogMaterialsForCrown(undefined);
  const currentMaterial = restoration.material?.trim();
  if (
    currentMaterial &&
    !fallbackMaterials.some(
      (option) => option.label.toLowerCase() === currentMaterial.toLowerCase(),
    )
  ) {
    fallbackMaterials.push({
      key: legacyMaterialKey(currentMaterial),
      label: currentMaterial,
    });
  }
  return fallbackMaterials;
}

interface CatalogRestorationPickerProps {
  subtypeDetails?: ReactNode;
  implantDetails?: ImplantDetails;
  onImplantChange?: (details: ImplantDetails) => void;
  labOrganizationId?: string;
  restorationType: string;
  material: string;
  restorationSubtype?: string | null;
  fallbackMaterialSuggestions?: string[];
  onChange: (value: CatalogRestorationValue) => void;
  inputClassName?: string;
  compact?: boolean;
  showFieldLabels?: boolean;
}

export function CatalogRestorationPicker({
  subtypeDetails,
  implantDetails,
  onImplantChange,
  labOrganizationId,
  restorationType,
  material,
  restorationSubtype,
  fallbackMaterialSuggestions = [],
  onChange,
  inputClassName,
  compact = false,
  showFieldLabels = false,
}: CatalogRestorationPickerProps) {
  const inputId = useId();
  const catalogQuery = useEffectiveCatalog(labOrganizationId);
  const catalog = catalogQuery.data;
  const resolved = useMemo(
    () => catalogValues(catalog, restorationType, restorationSubtype, material),
    [catalog, restorationType, restorationSubtype, material],
  );
  const caseTypes = catalog?.caseTypes ?? [];
  const subtypes = resolved.caseType?.subtypes ?? [];
  const materials = resolved.subtype?.materials ?? [];
  const catalogReady = Array.isArray(catalog?.caseTypes);
  const materialSuggestions = catalogReady
    ? materials.map((node) => node.label)
    : fallbackMaterialSuggestions;
  const fieldClass = inputClassName ?? (compact ? "h-7 text-xs" : "h-8 text-sm");

  const emit = (
    nextType: string,
    nextMaterial: string,
    caseTypeKey?: string,
    subtypeKey?: string,
    materialSubtypeKey?: string,
  ) => {
    const encoded = encodeCatalogSelection(
      caseTypeKey,
      subtypeKey,
      materialSubtypeKey,
    );
    onChange({
      restorationType: nextType,
      material: nextMaterial,
      restorationSubtype: encoded,
      caseTypeKey,
      subtypeKey,
      materialSubtypeKey,
    });
  };

  return (
    <div className={onImplantChange && isImplantRestoration({ restorationType, restorationSubtype, material }) ? "grid grid-cols-1 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2" : "grid grid-cols-1 sm:grid-cols-3 gap-2"}>
      <div className="min-w-0">
        {showFieldLabels && (
          <label htmlFor={`${inputId}-case-type`} className="mb-1 block text-xs font-medium text-muted-foreground">
            Case Type
          </label>
        )}
        <FieldCombobox
          inputId={`${inputId}-case-type`}
          value={resolved.caseType?.label ?? (resolved.caseTypeKey ? "" : restorationType)}
          suggestions={caseTypes.map((node) => node.label)}
          onChange={(label) => {
            const selected = findByLabel(caseTypes, label);
            emit(selected ? "" : label, "", selected?.key, undefined, undefined);
          }}
          placeholder="Case Type…"
          inputClassName={fieldClass}
        />
      </div>
      {resolved.caseTypeKey ? (
        <div className="min-w-0">
          {showFieldLabels && (
            <label htmlFor={`${inputId}-subtype`} className="mb-1 block text-xs font-medium text-muted-foreground">
              Subtype
            </label>
          )}
          <FieldCombobox
            inputId={`${inputId}-subtype`}
            value={resolved.subtype?.label ?? restorationType}
            suggestions={subtypes.map((node) => node.label)}
            onChange={(label) => {
              const selected = findByLabel(subtypes, label);
              if (!selected) {
                emit(label, material, resolved.caseTypeKey, undefined, undefined);
                return;
              }
              const retainedMaterial = findByLabel(selected.materials, material);
              emit(selected.label, retainedMaterial?.label ?? "", resolved.caseTypeKey, selected.key, retainedMaterial?.key);
            }}
            placeholder="Subtype…"
            inputClassName={fieldClass}
          />
        </div>
      ) : null}
      {subtypeDetails ? <div className="col-span-full min-w-0">{subtypeDetails}</div> : null}
      {onImplantChange && isImplantRestoration({ restorationType, restorationSubtype, material }) && <ImplantDetailsControls value={implantDetails ?? {}} onChange={onImplantChange} />}
      <div className="min-w-0">
        {showFieldLabels && (
          <label htmlFor={`${inputId}-case-material`} className="mb-1 block text-xs font-medium text-muted-foreground">
            Case Material
          </label>
        )}
        <FieldCombobox
          inputId={`${inputId}-case-material`}
          value={resolved.materialNode?.label ?? material}
          suggestions={materialSuggestions}
          onChange={(label) => {
            const selected = findByLabel(materials, label);
            emit(
              restorationType,
              label,
              resolved.caseTypeKey,
              resolved.subtype?.key,
              selected?.key,
            );
          }}
          placeholder={
            !catalogReady && fallbackMaterialSuggestions.length > 0
              ? "e.g. Zirconia"
              : materials.length > 0
                ? "Material…"
                : "Legacy/free text material"
          }
          inputClassName={fieldClass}
        />
      </div>
    </div>
  );
}

export function catalogMaterialLabels(
  materials: EffectiveMaterialNode[] | undefined,
): string[] {
  return (materials ?? []).map((material) => material.label);
}

export function catalogSubtypeMaterials(
  subtype: EffectiveSubtypeNode | undefined,
): CatalogMaterialOption[] {
  return (subtype?.materials ?? []).map((material) => ({
    key: nodeKey(material.id, material.key),
    label: material.label,
  }));
}
