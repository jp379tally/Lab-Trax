import React from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import type { CatalogTreeResult } from "@workspace/api-client-react";
import {
  CASE_TYPES, CASE_TAXONOMY, deriveCaseHierarchy, encodeRestorationSubtype,
  parseCustomToken, type CaseType, type CaseSubtype, type MaterialSubtype,
} from "@workspace/case-taxonomy";
import { useTheme } from "@/lib/theme-context";
import { RETURN_STEP_OPTIONS } from "@/lib/returned-case-wizard";
import type { ClinicalDraft } from "@/lib/case-clinical-edit";

interface Props {
  value: ClinicalDraft;
  onChange: (value: ClinicalDraft) => void;
  catalog?: CatalogTreeResult["data"];
  canEditHierarchy: boolean;
  canEditStep: boolean;
  disabled: boolean;
}

/** Inline clinical controls share the Lab Slip's Save/Cancel actions. */
export function CaseClinicalEditor({ value, onChange, catalog, canEditHierarchy, canEditStep, disabled }: Props) {
  const { colors } = useTheme();
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
  function select(nextCt: CaseType, nextSt: string | null, nextMat: string | null) {
    const node = caseTypes.find((node) => node.key === nextCt);
    const subtype = node?.subtypes.find((node) => node.key === nextSt);
    const material = subtype?.materials.find((node) => node.key === nextMat);
    const customSubtypeId = nextSt ? parseCustomToken(nextSt) : null;
    const customMaterialSubtypeId = nextMat ? parseCustomToken(nextMat) : null;
    onChange({
      ...value,
      restorationType: subtype?.label ?? ({ restorative: "Crown", removable: "Full Denture", ortho: "Night Guard" }[nextCt as string] ?? CASE_TAXONOMY[nextCt].label),
      restorationSubtype: encodeRestorationSubtype({
        caseType: nextCt,
        subtype: customSubtypeId ? null : nextSt as CaseSubtype | null,
        materialSubtype: customMaterialSubtypeId ? null : nextMat as MaterialSubtype | null,
        ...(customSubtypeId ? { customSubtypeId } : {}),
        ...(customMaterialSubtypeId ? { customMaterialSubtypeId } : {}),
      }),
      material: material?.label ?? "",
    });
  }
  function choices(label: string, options: Array<{ value: string; label: string }>, selected: string | null, action: (key: string) => void, allowed = canEditHierarchy) {
    return <View style={styles.field}>
      <Text style={{ color: colors.textSecondary }}>{label}</Text>
      <View style={styles.choices}>
        {options.map((option) => <Pressable key={option.value}
          accessibilityRole="button" accessibilityLabel={`${label}: ${option.label}`}
          accessibilityState={{ selected: selected === option.value, disabled: disabled || !allowed }}
          disabled={disabled || !allowed}
          testID={`clinical-${label.toLowerCase().replaceAll(" ", "-")}-${option.value}`}
          onPress={() => { if (!disabled && allowed) action(option.value); }}
          style={[styles.choice, { borderColor: selected === option.value ? colors.tint : colors.border, backgroundColor: colors.surfaceAlt }]}>
          <Text style={{ color: selected === option.value ? colors.tint : colors.text }}>{option.label}</Text>
        </Pressable>)}
      </View>
    </View>;
  }
  function input(label: string, key: "shade" | "teeth" | "stepShade", allowed = true) {
    return <View style={styles.field}>
      <Text style={{ color: colors.textSecondary }}>{label}</Text>
      <TextInput accessibilityLabel={label} testID={`clinical-${key}`} value={value[key]}
        editable={!disabled && allowed} onChangeText={(text) => onChange({ ...value, [key]: text })}
        style={[styles.input, { color: colors.text, borderColor: colors.border }]}
        placeholderTextColor={colors.textTertiary} />
    </View>;
  }
  return <View testID="clinical-details-editor" style={styles.container}>
    <Text style={{ color: colors.text, fontWeight: "600" }}>Clinical Details</Text>
    {!catalog && <Text style={{ color: colors.textSecondary }}>Lab-specific catalog options have not loaded yet. Built-in choices are available.</Text>}
    {choices("Case Type", CASE_TYPES.map((key) => ({ value: key, label: CASE_TAXONOMY[key].label })), ct, (key) => select(key as CaseType, null, null))}
    {ct && choices("Subtype", [{ value: "", label: "None" }, ...(ctNode?.subtypes ?? []).map((node) => ({ value: node.key, label: node.label }))], st ?? "", (key) => select(ct, key || null, ctNode?.subtypes.find((node) => node.key === key)?.materials.some((node) => node.key === mat) ? mat : null))}
    {ct && choices("Case Material", [{ value: "", label: "None" }, ...(stNode?.materials ?? []).map((node) => ({ value: node.key, label: node.label }))], mat ?? "", (key) => select(ct, st, key || null))}
    {(ct === "removable" || ct === "ortho" || value.arch) && choices("Arch", [{ value: "upper", label: "Upper" }, { value: "lower", label: "Lower" }, { value: "both", label: "Upper + Lower" }], value.arch, (key) => onChange({ ...value, arch: key as ClinicalDraft["arch"] }))}
    {(ct === "removable" || ct === "ortho" || value.step) && choices("Step", [{ value: "", label: "None" }, ...RETURN_STEP_OPTIONS], value.step, (key) => onChange({ ...value, step: key }), canEditStep)}
    {value.step === "wax_setup" && input("Wax Setup Shade", "stepShade", canEditStep)}
    {input("Shade", "shade")}
    {input("Tooth Numbers", "teeth")}
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: 12, marginTop: 16 },
  field: { gap: 6 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  choice: { padding: 10, borderRadius: 8, borderWidth: 1, minHeight: 44, justifyContent: "center" },
  input: { borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 44 },
});
