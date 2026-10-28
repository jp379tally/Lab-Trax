import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet } from "react-native";
import type { CatalogTreeResult } from "@workspace/api-client-react";
import {
  CASE_TYPES, CASE_TAXONOMY, deriveCaseHierarchy, encodeRestorationSubtype,
  parseCustomToken, type CaseType, type CaseSubtype, type MaterialSubtype,
} from "@workspace/case-taxonomy";
import { useTheme } from "@/lib/theme-context";
import { RETURN_STEP_OPTIONS } from "@/lib/returned-case-wizard";
import type { ClinicalDraft } from "@/lib/case-clinical-edit";
import { caseHierarchyLabels } from "@/lib/case-hierarchy-display";
import { CaseDetailField, CaseDetailSelect, CaseDetailOptions, caseDetailFieldStyles } from "@/components/case-detail/CaseDetailField";
import { Spacing, Typography } from "@/constants/tokens";

interface Props {
  value: ClinicalDraft;
  onChange: (value: ClinicalDraft) => void;
  catalog?: CatalogTreeResult["data"];
  canEditHierarchy: boolean;
  canEditStep: boolean;
  disabled: boolean;
  empty?: boolean;
  mixed?: boolean;
}

/** Inline clinical controls share the Lab Slip's Save/Cancel actions. */
export function CaseClinicalEditor({ value, onChange, catalog, canEditHierarchy, canEditStep, disabled, empty = false, mixed = false }: Props) {
  const { colors } = useTheme();
  const [open, setOpen] = useState<string | null>(null);
  const [hierarchySelected, setHierarchySelected] = useState(false);
  const hierarchy = deriveCaseHierarchy(value.restorationType, value.restorationSubtype, value.material);
  const ct = hierarchy.caseType;
  const st = hierarchy.subtype ?? (hierarchy.customSubtypeId ? `custom:${hierarchy.customSubtypeId}` : null);
  const mat = hierarchy.materialSubtype ?? (hierarchy.customMaterialSubtypeId ? `custom:${hierarchy.customMaterialSubtypeId}` : null);
  const caseTypes = catalog?.caseTypes ?? CASE_TYPES.map((key) => ({
    key,
    label: CASE_TAXONOMY[key].label,
    subtypes: Object.entries(CASE_TAXONOMY[key].subtypes).map(([key, node]) => ({
      key,
      label: node.label,
      materials: Object.entries(node.materialSubtypes).map(([key, material]) => ({
        key,
        label: material.label,
      })),
    })),
  }));
  const ctNode = caseTypes.find((node) => node.key === ct);
  const stNode = ctNode?.subtypes.find((node) => node.key === st);
  const showMixed = mixed && !hierarchySelected;
  const labels = empty && !hierarchySelected
    ? { type: "—", subtype: "—", material: "—" }
    : caseHierarchyLabels(hierarchy, value, catalog, showMixed);
  function select(nextCt: CaseType, nextSt: string | null, nextMat: string | null) {
    setHierarchySelected(true);
    const node = caseTypes.find((node) => node.key === nextCt);
    const subtype = node?.subtypes.find((node) => node.key === nextSt);
    const material = subtype?.materials.find((node) => node.key === nextMat);
    const customSubtypeId = nextSt ? parseCustomToken(nextSt) : null;
    const customMaterialSubtypeId = nextMat ? parseCustomToken(nextMat) : null;
    onChange({
      ...value,
      restorationType: subtype?.label ?? (nextCt === ct && nextSt === st ? value.restorationType :
        { restorative: "Crown", removable: "Full Denture", ortho: "Night Guard" }[nextCt]),
      restorationSubtype: encodeRestorationSubtype({
        caseType: nextCt,
        subtype: customSubtypeId ? null : nextSt as CaseSubtype | null,
        materialSubtype: customMaterialSubtypeId ? null : nextMat as MaterialSubtype | null,
        ...(customSubtypeId ? { customSubtypeId } : {}),
        ...(customMaterialSubtypeId ? { customMaterialSubtypeId } : {}),
      }),
      material: material?.label ?? (nextMat && nextCt === ct && nextSt === st && nextMat === mat ? value.material : ""),
    });
  }
  function choices(label: string, id: string, options: Array<{ value: string; label: string }>, selected: string | null, valueLabel: string, action: (key: string) => void, allowed = canEditHierarchy) {
    return <View style={styles.field}>
      <CaseDetailSelect label={label} valueLabel={valueLabel}
        testID={`clinical-${id}-select`} valueTestID={`clinical-${id}-value`}
        expanded={open === id} disabled={disabled || options.length === 0}
        onPress={allowed ? () => setOpen(open === id ? null : id) : undefined} />
      {allowed && open === id ? <CaseDetailOptions label={label}
        options={options.map((option) => ({ key: option.value, label: option.label }))}
        selected={selected} disabled={disabled}
        optionTestID={(key) => `clinical-${id}-${key}`}
        onSelect={(key) => {
          setOpen(null);
          if (!disabled && key !== selected) action(key);
        }} /> : null}
    </View>;
  }
  function input(label: string, key: "shade" | "teeth" | "stepShade", allowed = true) {
    return <CaseDetailField label={label}>
      {allowed ? <TextInput accessibilityLabel={label} testID={`clinical-${key}`} value={value[key]}
        editable={!disabled} onChangeText={(text) => onChange({ ...value, [key]: text })}
        style={[caseDetailFieldStyles.input, { color: colors.text, borderColor: colors.border }]}
        placeholderTextColor={colors.textTertiary} /> :
        <Text testID={`clinical-${key}`} style={[Typography.body, { color: colors.text }]}>{value[key] || "—"}</Text>}
    </CaseDetailField>;
  }
  return <View testID="clinical-details-editor" style={styles.container}>
    {choices("Restoration Type", "case-type", CASE_TYPES.map((key) => ({ value: key, label: CASE_TAXONOMY[key].label })), showMixed ? null : ct, labels.type, (key) => select(key as CaseType, null, null))}
    {choices("Restoration Sub Type", "subtype", ct ? [{ value: "", label: "None" }, ...(ctNode?.subtypes ?? []).map((node) => ({ value: node.key, label: node.label }))] : [], showMixed ? null : st ?? "", labels.subtype, (key) => {
      if (ct) select(ct, key || null, ctNode?.subtypes.find((node) => node.key === key)?.materials.some((node) => node.key === mat) ? mat : null);
    })}
    {choices("Material", "case-material", ct ? [{ value: "", label: "None" }, ...(stNode?.materials ?? []).map((node) => ({ value: node.key, label: node.label }))] : [], showMixed ? null : mat ?? (value.material.trim() ? null : ""), labels.material, (key) => { if (ct) select(ct, st, key || null); })}
    {!catalog && <Text style={[Typography.caption, { color: colors.textSecondary }]}>Lab-specific catalog options have not loaded yet. Saved values and built-in choices are available.</Text>}
    {(ct === "removable" || ct === "ortho" || value.arch) && choices("Arch", "arch", [{ value: "upper", label: "Upper" }, { value: "lower", label: "Lower" }, { value: "both", label: "Upper + Lower" }], value.arch, value.arch === "both" ? "Upper + Lower" : value.arch === "upper" ? "Upper" : value.arch === "lower" ? "Lower" : "Required", (key) => onChange({ ...value, arch: key as ClinicalDraft["arch"] }))}
    {(ct === "removable" || ct === "ortho" || value.step) && choices("Step", "step", [{ value: "", label: "None" }, ...RETURN_STEP_OPTIONS], value.step, RETURN_STEP_OPTIONS.find((option) => option.value === value.step)?.label || value.step || "—", (key) => onChange({ ...value, step: key }), canEditStep)}
    {value.step === "wax_setup" && input("Wax Setup Shade", "stepShade", canEditStep)}
    {input("Shade", "shade")}
    {input("Tooth Numbers", "teeth")}
  </View>;
}

const styles = StyleSheet.create({
  container: { width: "100%", minWidth: 0, gap: Spacing.lg },
  field: { width: "100%", minWidth: 0, gap: Spacing.xs },
});
