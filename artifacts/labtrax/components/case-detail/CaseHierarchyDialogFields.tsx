import React, { useState } from "react";
import { View } from "react-native";
import type { CatalogTreeResult } from "@workspace/api-client-react";
import { CASE_TYPES, CASE_TAXONOMY, parseCustomToken, type CaseType, type CaseSubtype, type MaterialSubtype } from "@workspace/case-taxonomy";
import { ARCH_OPTIONS, isArchRequired, type ArchSelection } from "@/lib/arch";
import { caseHierarchyLabels, type SavedHierarchyValues } from "@/lib/case-hierarchy-display";
import { Spacing } from "@/constants/tokens";
import { CaseDetailSelect, CaseDetailOptions, type CaseDetailOption } from "./CaseDetailField";

/** The existing arch/hierarchy dialog still stages its choices until Save. */
export function CaseHierarchyDialogFields({
  type, subtype, material, arch, catalog, savedValues, disabled,
  onType, onSubtype, onMaterial, onArch,
}: {
  type: CaseType | null;
  subtype: string | null;
  material: string | null;
  arch: ArchSelection | null;
  catalog?: CatalogTreeResult["data"];
  savedValues: SavedHierarchyValues;
  disabled: boolean;
  onType: (value: CaseType) => void;
  onSubtype: (value: string) => void;
  onMaterial: (value: string | null) => void;
  onArch: (value: ArchSelection) => void;
}) {
  const [open, setOpen] = useState<string | null>("arch");
  const ctNode = catalog?.caseTypes.find((node) => node.key === type);
  const stNode = ctNode?.subtypes.find((node) => node.key === subtype);
  const customSubtypeId = subtype ? parseCustomToken(subtype) : null;
  const customMaterialSubtypeId = material ? parseCustomToken(material) : null;
  const labels = caseHierarchyLabels({
    caseType: type,
    subtype: customSubtypeId ? null : subtype as CaseSubtype | null,
    materialSubtype: customMaterialSubtypeId ? null : material as MaterialSubtype | null,
    ...(customSubtypeId ? { customSubtypeId } : {}),
    ...(customMaterialSubtypeId ? { customMaterialSubtypeId } : {}),
  }, savedValues, catalog);
  const field = (label: string, id: string, valueLabel: string, selected: string | null,
    options: CaseDetailOption[], onSelect: (key: string) => void) => <View style={{ gap: Spacing.xs, width: "100%" }}>
    <CaseDetailSelect label={label} valueLabel={valueLabel} testID={`hierarchy-${id}-select`}
      disabled={disabled || options.length === 0} expanded={open === id}
      onPress={() => setOpen(open === id ? null : id)} />
    {open === id ? <CaseDetailOptions label={label} options={options} selected={selected} disabled={disabled}
      optionTestID={(key) => `hierarchy-${id}-${key || "none"}`}
      onSelect={(key) => { setOpen(null); if (key !== selected) onSelect(key); }} /> : null}
  </View>;
  return <View style={{ gap: Spacing.lg, width: "100%", marginBottom: Spacing.lg }}>
    {field("Restoration Type", "ct", labels.type, type, CASE_TYPES.map((key) => ({ key, label: CASE_TAXONOMY[key].label })), (key) => onType(key as CaseType))}
    {field("Restoration Sub Type", "st", labels.subtype, subtype, ctNode?.subtypes ?? [], onSubtype)}
    {field("Material", "mat", labels.material, material ?? (labels.material === "—" ? "" : null), stNode?.materials.length ? [{ key: "", label: "None" }, ...stNode.materials] : [], (key) => onMaterial(key || null))}
    {type && isArchRequired(type) ? field("Arch", "arch", ARCH_OPTIONS.find((option) => option.value === arch)?.label ?? "Required", arch,
      ARCH_OPTIONS.map((option) => ({ key: option.value, label: option.label })), (key) => onArch(key as ArchSelection)) : null}
  </View>;
}
