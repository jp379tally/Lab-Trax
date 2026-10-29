import React, { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { CatalogTreeResult } from "@workspace/api-client-react";
import {
  CASE_TYPES, CASE_TAXONOMY, encodeRestorationSubtype, parseCustomToken,
  type CaseHierarchy, type CaseType, type CaseSubtype, type MaterialSubtype,
} from "@workspace/case-taxonomy";
import { useTheme } from "@/lib/theme-context";
import { saveClinicalDetails, clinicalSaveMessage } from "@/lib/case-clinical-edit";
import { caseHierarchyLabels, type SavedHierarchyValues } from "@/lib/case-hierarchy-display";
import { CaseDetailSelect, CaseDetailOptions, caseDetailFieldStyles } from "@/components/case-detail/CaseDetailField";
import { Spacing, Typography } from "@/constants/tokens";

type Field = "type" | "subtype" | "material";
type Selection = { ct: CaseType; st: string | null; mat: string | null };

/** View-mode saves only. The full Lab Slip editor owns a separate draft. */
export function CaseHierarchyQuickPicker({
  caseId, hierarchy, catalog, arch, refresh, empty, mixed = false, savedValues = {}, canEdit = true,
}: {
  caseId: string;
  hierarchy: CaseHierarchy | null;
  catalog?: CatalogTreeResult["data"];
  arch: "" | "upper" | "lower" | "both";
  refresh: () => Promise<void>;
  empty: boolean;
  mixed?: boolean;
  savedValues?: SavedHierarchyValues;
  canEdit?: boolean;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState<Field | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Selection | null>(null);
  const serverIdentity = JSON.stringify([caseId, hierarchy, savedValues, empty, mixed]);
  const [observedServer, setObservedServer] = useState(serverIdentity);
  const [confirmed, setConfirmed] = useState<{
    hierarchy: CaseHierarchy; values: SavedHierarchyValues; arch: typeof arch;
  } | null>(null);
  if (!saving && serverIdentity !== observedServer) {
    setObservedServer(serverIdentity);
    setConfirmed(null);
  }
  const currentHierarchy = confirmed?.hierarchy ?? hierarchy;
  const currentMixed = confirmed ? false : mixed;
  const labels = caseHierarchyLabels(currentHierarchy, confirmed?.values ?? savedValues, catalog, currentMixed);
  const ct = currentHierarchy?.caseType ?? null;
  const st = currentHierarchy?.subtype ?? (currentHierarchy?.customSubtypeId ? `custom:${currentHierarchy.customSubtypeId}` : null);
  const mat = currentHierarchy?.materialSubtype ?? (currentHierarchy?.customMaterialSubtypeId ? `custom:${currentHierarchy.customMaterialSubtypeId}` : null);
  const ctNode = catalog?.caseTypes.find((node) => node.key === ct);
  const stNode = ctNode?.subtypes.find((node) => node.key === st);

  async function save(selection: Selection, selectedArch = confirmed?.arch ?? arch) {
    if (!canEdit || inFlight.current) return;
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
      const nextHierarchy: CaseHierarchy = {
        caseType: selection.ct,
        subtype: customSubtypeId ? null : selection.st as CaseSubtype | null,
        materialSubtype: customMaterialSubtypeId ? null : selection.mat as MaterialSubtype | null,
        ...(customSubtypeId ? { customSubtypeId } : {}),
        ...(customMaterialSubtypeId ? { customMaterialSubtypeId } : {}),
      };
      const values = {
        restorationType: subtype?.label ?? ({ restorative: "Crown", removable: "Full Denture", ortho: "Night Guard" }[selection.ct]),
        restorationSubtype: selection.st ? encodeRestorationSubtype(nextHierarchy) : null,
        material: material?.label ?? null,
      };
      const outcome = await saveClinicalDetails(caseId, {
        ...values,
        ...(empty && !confirmed ? { toothNumbers: [] } : {}),
        ...((selection.ct === "removable" || selection.ct === "ortho")
          ? { arch: selectedArch === "both" ? "upper_lower" : selectedArch as "upper" | "lower" }
          : {}),
      });
      setConfirmed({ hierarchy: nextHierarchy, values, arch: selectedArch });
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

  function field(label: string, key: Field, value: string, valueID: string, buttonID: string, options: Array<{ key: string; label: string }>, selected: string | null, select: (key: string) => void) {
    return <View style={{ width: "100%", gap: Spacing.xs }}>
      <CaseDetailSelect label={label} valueLabel={value} valueTestID={valueID} testID={buttonID}
        disabled={saving || pending !== null || options.length === 0}
        expanded={open === key} busy={saving}
        onPress={canEdit ? () => { if (!inFlight.current && !pending) setOpen(open === key ? null : key); } : undefined} />
      {canEdit && open === key ? <CaseDetailOptions label={label} options={options}
        selected={currentMixed ? null : selected} disabled={saving || pending !== null}
        optionTestID={(value) => `quick-${key}-${value || "none"}`}
        onSelect={(value) => {
          if (inFlight.current) return;
          setOpen(null);
          if (!currentMixed && value === selected) return;
          select(value);
        }} /> : null}
    </View>;
  }

  return <View style={{ width: "100%", minWidth: 0, gap: Spacing.lg }} testID="view-hierarchy-picker">
    {field("Restoration Type", "type", labels.type, "hierarchy-casetype-value", "hierarchy-edit-btn",
      CASE_TYPES.map((key) => ({ key, label: CASE_TAXONOMY[key].label })), ct, (key) => void save({ ct: key as CaseType, st: null, mat: null }))}
    {field("Restoration Sub Type", "subtype", labels.subtype, "hierarchy-subtype-value", "hierarchy-edit-subtype-btn",
      ctNode?.subtypes ?? [], st, (key) => { if (ct) void save({ ct, st: key, mat: null }); })}
    {field("Material", "material", labels.material, "hierarchy-material-value", "hierarchy-edit-material-btn",
      stNode?.materials.length ? [{ key: "", label: "None" }, ...stNode.materials] : [], mat ?? (labels.material === "—" ? "" : null), (key) => { if (ct) void save({ ct, st, mat: key || null }); })}
    {canEdit && !catalog ? <Text style={[Typography.caption, { color: colors.textSecondary }]}>
      Lab catalog options are unavailable. Saved values are shown.
    </Text> : null}
    {pending && <View style={{ gap: 8 }}>
      <Text style={{ color: colors.textSecondary }}>Choose an arch to switch to {CASE_TAXONOMY[pending.ct].label}.</Text>
      {(["upper", "lower", "both"] as const).map((value) => <Pressable key={value} disabled={saving}
        accessibilityRole="button" accessibilityLabel={`Arch: ${value === "both" ? "Upper + Lower" : value}`}
        accessibilityState={{ disabled: saving }} style={[caseDetailFieldStyles.control, { borderColor: colors.border }]}
        testID={`quick-arch-${value}`} onPress={() => void save(pending, value)}>
        <Text style={{ color: colors.tint }}>{value === "both" ? "Upper + Lower" : value === "upper" ? "Upper" : "Lower"}</Text>
      </Pressable>)}
      <Pressable testID="quick-arch-cancel" accessibilityRole="button" disabled={saving}
        style={caseDetailFieldStyles.option} onPress={() => setPending(null)}><Text style={{ color: colors.tint }}>Cancel</Text></Pressable>
    </View>}
    {saving && <ActivityIndicator accessibilityLabel="Saving case hierarchy" color={colors.tint} />}
    {notice && <Text accessibilityRole="text" style={{ color: colors.textSecondary }}>{notice}</Text>}
    {error && <Text accessibilityRole="alert" style={{ color: colors.text }}>{error}</Text>}
  </View>;
}
