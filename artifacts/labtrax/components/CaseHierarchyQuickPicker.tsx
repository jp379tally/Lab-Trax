import React, { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { CatalogTreeResult } from "@workspace/api-client-react";
import {
  CASE_TYPES, CASE_TAXONOMY, encodeRestorationSubtype, parseCustomToken,
  type CaseHierarchy, type CaseType, type CaseSubtype, type MaterialSubtype,
} from "@workspace/case-taxonomy";
import { useTheme } from "@/lib/theme-context";
import { saveClinicalDetails, clinicalSaveMessage } from "@/lib/case-clinical-edit";

type Field = "type" | "subtype" | "material";
type Selection = { ct: CaseType; st: string | null; mat: string | null };

/** View-mode saves only. The full Lab Slip editor owns a separate draft. */
export function CaseHierarchyQuickPicker({
  caseId, hierarchy, catalog, arch, refresh, empty, mixed = false,
}: {
  caseId: string;
  hierarchy: CaseHierarchy | null;
  catalog?: CatalogTreeResult["data"];
  arch: "" | "upper" | "lower" | "both";
  refresh: () => Promise<void>;
  empty: boolean;
  mixed?: boolean;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState<Field | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Selection | null>(null);
  const ct = hierarchy?.caseType ?? null;
  const st = hierarchy?.subtype ?? (hierarchy?.customSubtypeId ? `custom:${hierarchy.customSubtypeId}` : null);
  const mat = hierarchy?.materialSubtype ?? (hierarchy?.customMaterialSubtypeId ? `custom:${hierarchy.customMaterialSubtypeId}` : null);
  const ctNode = catalog?.caseTypes.find((node) => node.key === ct);
  const stNode = ctNode?.subtypes.find((node) => node.key === st);

  async function save(selection: Selection, selectedArch = arch) {
    if (inFlight.current) return;
    if ((selection.ct === "removable" || selection.ct === "ortho") && !selectedArch) {
      setPending(selection);
      setOpen(null);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    const subtype = catalog?.caseTypes.find((node) => node.key === selection.ct)?.subtypes.find((node) => node.key === selection.st);
    const material = subtype?.materials.find((node) => node.key === selection.mat);
    const customSubtypeId = selection.st ? parseCustomToken(selection.st) : null;
    const customMaterialSubtypeId = selection.mat ? parseCustomToken(selection.mat) : null;
    try {
      const outcome = await saveClinicalDetails(caseId, {
        restorationType: subtype?.label ?? ({ restorative: "Crown", removable: "Full Denture", ortho: "Night Guard" }[selection.ct]),
        restorationSubtype: selection.st ? encodeRestorationSubtype({
          caseType: selection.ct,
          subtype: customSubtypeId ? null : selection.st as CaseSubtype,
          materialSubtype: customMaterialSubtypeId ? null : selection.mat as MaterialSubtype | null,
          ...(customSubtypeId ? { customSubtypeId } : {}),
          ...(customMaterialSubtypeId ? { customMaterialSubtypeId } : {}),
        }) : null,
        material: material?.label ?? null,
        ...(empty ? { toothNumbers: [] } : {}),
        ...((selection.ct === "removable" || selection.ct === "ortho")
          ? { arch: selectedArch === "both" ? "upper_lower" : selectedArch as "upper" | "lower" }
          : {}),
      });
      setPending(null);
      setOpen(null);
      setNotice(clinicalSaveMessage(outcome));
      // A committed write must not turn a refresh failure into a retryable save.
      await Promise.allSettled([Promise.resolve().then(refresh)]);
    } catch (err) {
      setPending(null);
      setOpen(null);
      setError(err instanceof Error ? err.message : "Could not update case.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function field(label: string, key: Field, value: string, valueID: string, buttonID: string, options: Array<{ key: string; label: string }>, select: (key: string) => void) {
    return <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: colors.textSecondary }}>{label}</Text>
        <Pressable testID={buttonID} accessibilityRole="button" accessibilityLabel={`Change ${label}`}
          disabled={saving || pending !== null} accessibilityState={{ disabled: saving || pending !== null }}
          onPress={() => { if (!inFlight.current && !pending) setOpen(open === key ? null : key); }}
          style={{ padding: 8, opacity: saving ? 0.6 : 1 }}>
          <View style={{ flexDirection: "row", gap: 4 }}>
            <Text testID={valueID} style={{ color: colors.tint }}>{value}</Text>
            <Text style={{ color: colors.tint }}>▾</Text>
          </View>
        </Pressable>
      </View>
      {open === key && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {options.map((option) => <Pressable key={option.key} testID={`quick-${key}-${option.key || "none"}`}
          accessibilityRole="button" accessibilityLabel={`${label}: ${option.label}`} disabled={saving}
          onPress={() => { if (!inFlight.current) select(option.key); }}
          style={{ padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 6 }}>
          <Text style={{ color: colors.text }}>{option.label}</Text>
        </Pressable>)}
        {key !== "type" && !catalog && <Text style={{ color: colors.textSecondary }}>Loading lab catalog…</Text>}
      </View>}
    </View>;
  }

  return <View style={{ gap: 8 }} testID="view-hierarchy-picker">
    {field("Case Type", "type", mixed ? "Multiple" : ct ? CASE_TAXONOMY[ct].label : "—", "hierarchy-casetype-value", "hierarchy-edit-btn",
      CASE_TYPES.map((key) => ({ key, label: CASE_TAXONOMY[key].label })), (key) => void save({ ct: key as CaseType, st: null, mat: null }))}
    {ct ? field("Case Subtype", "subtype", mixed ? "Multiple" : stNode?.label ?? "—", "hierarchy-subtype-value", "hierarchy-edit-subtype-btn",
      ctNode?.subtypes ?? [], (key) => void save({ ct, st: key, mat: null }))
      : <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: colors.textSecondary }}>Case Subtype</Text><Text testID="hierarchy-subtype-value" style={{ color: colors.text }}>—</Text>
        </View>}
    {ct && stNode && stNode.materials.length > 0 ? field("Case Material", "material",
      mixed ? "Multiple" : stNode.materials.find((node) => node.key === mat)?.label ?? "—", "hierarchy-material-value", "hierarchy-edit-material-btn",
      [{ key: "", label: "None" }, ...stNode.materials], (key) => void save({ ct, st, mat: key || null }))
      : <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: colors.textSecondary }}>Case Material</Text><Text testID="hierarchy-material-value" style={{ color: colors.text }}>{mixed ? "Multiple" : "—"}</Text>
        </View>}
    {pending && <View style={{ gap: 8 }}>
      <Text style={{ color: colors.textSecondary }}>Choose an arch to switch to {CASE_TAXONOMY[pending.ct].label}.</Text>
      {(["upper", "lower", "both"] as const).map((value) => <Pressable key={value} disabled={saving}
        testID={`quick-arch-${value}`} onPress={() => void save(pending, value)}>
        <Text style={{ color: colors.tint }}>{value === "both" ? "Upper + Lower" : value === "upper" ? "Upper" : "Lower"}</Text>
      </Pressable>)}
      <Pressable disabled={saving} onPress={() => setPending(null)}><Text style={{ color: colors.tint }}>Cancel</Text></Pressable>
    </View>}
    {saving && <ActivityIndicator accessibilityLabel="Saving case hierarchy" color={colors.tint} />}
    {notice && <Text accessibilityRole="text" style={{ color: colors.textSecondary }}>{notice}</Text>}
    {error && <Text accessibilityRole="alert" style={{ color: colors.text }}>{error}</Text>}
  </View>;
}
