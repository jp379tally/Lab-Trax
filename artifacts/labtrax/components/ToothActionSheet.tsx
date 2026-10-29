import React, { useEffect, useMemo, useState } from "react";
import { expandToothAssignmentIdentifiers, catalogToothMaterialOptions, deriveCaseHierarchy, encodeRestorationSubtype } from "@workspace/case-taxonomy";
import { useGetCatalogTree, getGetCatalogTreeQueryKey } from "@workspace/api-client-react";
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Alert,
  Keyboard,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import type { ToothId } from "@/lib/rx-summary";
import { resilientFetch } from "@/lib/query-client";
import {
  scrollKeyboardDismissMode,
  useDismissKeyboardOnTap,
} from "@/components/ui/DismissKeyboardView";

const DEFAULT_CROWN_MATERIALS = [
  "Zirconia",
  "PFM",
  "Lithium Disilicate (Emax)",
  "Full Cast",
  "Composite",
  "Acrylic",
  "Metal",
  "PMMA",
  "Other",
];

const DEFAULT_VITA_SHADES = [
  "A1", "A2", "A3", "A3.5", "A4",
  "B1", "B2", "B3", "B4",
  "C1", "C2", "C3", "C4",
  "D2", "D3", "D4",
  "OM1", "OM2", "OM3",
  "1M1", "1M2", "1M3",
];

export type ToothActionPayload =
  | { kind: "change_role"; toothId: string; restorationId: string; role: "Crown" | "Pontic" | "Veneer" }
  | { kind: "copy_assignment"; role: "Crown" | "Pontic" | "Veneer"; material: string; restorationSubtype?: string; shade?: string; toothNumbers: string[] }
  | {
      kind: "add_crown";
      toothId: string;
      material: string;
      restorationType: string;
      restorationSubtype?: string;
      shade?: string;
    }
  | {
      kind: "add_pontic";
      toothId: string;
      material: string;
      restorationSubtype?: string;
      shade?: string;
    }
  | { kind: "mark_missing"; toothId: string }
  | { kind: "remove_restoration"; toothId: string; restorationId?: string }
  | {
      kind: "change_restoration";
      toothId: string;
      restorationId: string;
      material: string;
      restorationSubtype?: string;
      shade?: string;
    };

type Step =
  | "choose_action"
  | "choose_kind"
  | "choose_material"
  | "choose_shade"
  | "change_material"
  | "change_shade";

interface Props {
  allowMarkMissing?: boolean;
  toothId: ToothId | null;
  /** Human-readable description(s) of any restoration already on this tooth. */
  existingLabel?: string | null;
  /** ID of the restoration on this tooth targeted by Change/Remove actions. */
  existingRestorationId?: string | null;
  existingAssignment?: { toothNumber?: string | null; restorationType?: string | null; material?: string | null; shade?: string | null; restorationSubtype?: string | null };
  groupLabel?: string;
  submitting?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (payload: ToothActionPayload) => void;
  /** Lab-specific vocabulary for materials (merged with built-in defaults). */
  vocabularyMaterials?: string[];
  /** Effective catalog materials with their encoded subtype hierarchy. */
  catalogMaterials?: Array<{
    label: string;
    restorationSubtype: string;
    isCustom?: boolean;
  }>;
  /** Effective restorative subtype choices for the tooth wizard. */
  catalogTypes?: Array<{
    label: string;
    restorationSubtype: string;
    materials: Array<{ label: string; restorationSubtype: string }>;
  }>;
  /** Lab-specific vocabulary for shades (merged with built-in defaults). */
  vocabularyShades?: string[];
  /** Lab org ID — enables saving new custom materials/shades to the lab's vocabulary. */
  labOrganizationId?: string;
}

/**
 * Mobile mirror of the desktop ToothActionDialog. A bottom-sheet that lets a
 * technician record a restoration on a tapped tooth: pick the kind (crown,
 * pontic, or missing); for a crown also pick a material and an optional shade.
 *
 * When the tooth already has a restoration the sheet opens at `choose_action`
 * which offers Remove, Change (material/shade via PATCH), or Add alongside.
 */
export function ToothActionSheet({
  toothId,
  allowMarkMissing = true,
  existingLabel,
  existingRestorationId,
  existingAssignment,
  groupLabel,
  submitting = false,
  error,
  onClose,
  onConfirm,
  vocabularyMaterials,
  catalogMaterials: providedCatalogMaterials,
  catalogTypes: providedCatalogTypes,
  vocabularyShades,
  labOrganizationId,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const dismissKeyboardOnSheetTap = useDismissKeyboardOnTap();
  const toothCatalog = useGetCatalogTree(
    { labOrganizationId: labOrganizationId ?? "" },
    { query: { queryKey: getGetCatalogTreeQueryKey({ labOrganizationId: labOrganizationId ?? "" }), enabled: !!labOrganizationId && !!toothId } },
  );
  const loadedMaterials = useMemo(() => toothCatalog.data?.data
    ? catalogToothMaterialOptions(toothCatalog.data.data) : [], [toothCatalog.data]);
  const catalogMaterials = providedCatalogMaterials?.length ? providedCatalogMaterials : loadedMaterials;
  const catalogTypes = providedCatalogTypes?.length ? providedCatalogTypes :
    [...new Set(loadedMaterials.filter((material) => material.parentIsCustom).map((material) => material.parentSubtype))]
      .map((subtype) => ({
        label: loadedMaterials.find((material) => material.parentSubtype === subtype)!.parentLabel,
        restorationSubtype: subtype,
        materials: loadedMaterials.filter((material) => material.parentSubtype === subtype),
      }));

  const [step, setStep] = useState<Step>("choose_kind");
  const [material, setMaterial] = useState("");
  const [restorationType, setRestorationType] = useState("Crown");
  const [selectedRole, setSelectedRole] = useState<"crown" | "pontic" | "veneer">("crown");
  const [shade, setShade] = useState("");
  const [customShade, setCustomShade] = useState("");
  const [isCustomShade, setIsCustomShade] = useState(false);

  // Add-new-material state
  const [isAddingNewMaterial, setIsAddingNewMaterial] = useState(false);
  const [newMaterialText, setNewMaterialText] = useState("");
  const [addingMaterialPending, setAddingMaterialPending] = useState(false);
  const [addMaterialError, setAddMaterialError] = useState<string | null>(null);

  // Add-new-shade state
  const [isAddingNewShade, setIsAddingNewShade] = useState(false);
  const [newShadeText, setNewShadeText] = useState("");
  const [addingShadePending, setAddingShadePending] = useState(false);
  const [addShadeError, setAddShadeError] = useState<string | null>(null);
  const [copyTargets, setCopyTargets] = useState("");
  const [pendingRole, setPendingRole] = useState<"Crown" | "Pontic" | "Veneer" | null>(null);
  const [draftUndo, setDraftUndo] = useState<{
    step: Step; role: "crown" | "pontic" | "veneer"; material: string; shade: string;
    copyTargets: string; pendingRole: "Crown" | "Pontic" | "Veneer" | null;
  } | null>(null);
  function captureDraftUndo() {
    setDraftUndo({ step, role: selectedRole, material, shade, copyTargets, pendingRole });
  }

  // Merge lab vocabulary with built-in defaults, deduping case-insensitively.
  const mergedMaterials = useMemo(() => {
    const base = [...DEFAULT_CROWN_MATERIALS];
    const additional = [
      ...(vocabularyMaterials ?? []),
      ...(catalogMaterials ?? []).map((m) => m.label),
    ];
    if (additional.length > 0) {
      const baseLower = new Set(base.map((m) => m.toLowerCase()));
      for (const m of additional) {
        if (!baseLower.has(m.toLowerCase())) base.push(m);
      }
    }
    return [...new Set(base)];
  }, [catalogMaterials, vocabularyMaterials]);

  const mergedShades = useMemo(() => {
    const base = [...DEFAULT_VITA_SHADES];
    if (vocabularyShades) {
      const baseLower = new Set(base.map((s) => s.toLowerCase()));
      for (const s of vocabularyShades) {
        if (!baseLower.has(s.toLowerCase())) base.push(s);
      }
    }
    return base;
  }, [vocabularyShades]);

  function resetWizard() {
    setMaterial("");
    setRestorationType("Crown");
    setSelectedRole("crown");
    setShade("");
    setCustomShade("");
    setIsCustomShade(false);
    resetAddNewMaterial();
    resetAddNewShade();
  }

  function resetAddNewMaterial() {
    setIsAddingNewMaterial(false);
    setNewMaterialText("");
    setAddMaterialError(null);
  }

  function resetAddNewShade() {
    setIsAddingNewShade(false);
    setNewShadeText("");
    setAddShadeError(null);
  }

  useEffect(() => {
    if (toothId !== null) {
      setStep(existingLabel ? "choose_action" : "choose_kind");
      setDraftUndo(null);
      setPendingRole(null);
      setCopyTargets("");
      resetWizard();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toothId, existingLabel]);

  // Reset add-new state when step changes
  useEffect(() => {
    resetAddNewMaterial();
    resetAddNewShade();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const visible = toothId !== null;

  function resolvedShade(): string | undefined {
    if (isCustomShade) return customShade.trim() || undefined;
    return shade || undefined;
  }

  function handleKind(kind: "crown" | "pontic" | "veneer" | "missing") {
    captureDraftUndo();
    if (!toothId) return;
    if (kind === "crown" || kind === "pontic" || kind === "veneer") {
      setSelectedRole(kind);
      setRestorationType(kind === "veneer" ? "Veneer" : "Crown");
      setStep("choose_material");
    } else {
      onConfirm({ kind: "mark_missing", toothId });
    }
  }

  function handleMaterialNext() {
    captureDraftUndo();
    if (!material) return;
    setShade("");
    setCustomShade("");
    setIsCustomShade(false);
    resetAddNewShade();
    setStep("choose_shade");
  }

  function handleShadeConfirm(withShade: boolean) {
    if (!toothId) return;
    const catalogMaterial = catalogMaterials?.find(
      (entry) => entry.label.toLowerCase() === material.toLowerCase() &&
        (!catalogTypes.find((type) => type.label === restorationType) ||
          entry.restorationSubtype.startsWith(catalogTypes.find((type) => type.label === restorationType)!.restorationSubtype)),
    );
    const catalogType = catalogTypes.find(
      (entry) => entry.label.toLowerCase() === restorationType.toLowerCase(),
    );
    const details = {
      toothId,
      material,
      ...(catalogMaterial
        ? { restorationSubtype: catalogMaterial.restorationSubtype }
        : catalogType?.restorationSubtype
          ? { restorationSubtype: catalogType.restorationSubtype }
          : {}),
      shade: withShade ? resolvedShade() : undefined,
    };
    if (selectedRole === "pontic") {
      onConfirm({ kind: "add_pontic", ...details });
    } else {
      onConfirm({ kind: "add_crown", ...details, restorationType: selectedRole === "veneer" ? "Veneer" : restorationType });
    }
  }

  function handleChangeMaterialNext() {
    if (!material) return;
    setShade("");
    setCustomShade("");
    setIsCustomShade(false);
    resetAddNewShade();
    setStep("change_shade");
  }

  function handleChangeShadeConfirm(withShade: boolean) {
    if (!toothId || !existingRestorationId) return;
    const parent = existingAssignment?.restorationSubtype?.split("/").slice(0, 2).join("/") ?? "restorative/crown";
    const selected = catalogMaterials?.find((entry) => entry.label.toLowerCase() === material.toLowerCase() &&
      entry.restorationSubtype?.startsWith(`${parent}/`));
    const previous = deriveCaseHierarchy("Crown", existingAssignment?.restorationSubtype, existingAssignment?.material);
    const replacement = deriveCaseHierarchy("Crown", undefined, material);
    const subtype = selected?.restorationSubtype ??
      (material === existingAssignment?.material ? existingAssignment?.restorationSubtype :
        encodeRestorationSubtype({ ...previous,
          materialSubtype: previous.customSubtypeId ? null : replacement.materialSubtype,
          customMaterialSubtypeId: undefined }));
    onConfirm({
      kind: "change_restoration",
      toothId,
      restorationId: existingRestorationId,
      material,
      ...(subtype ? { restorationSubtype: subtype } : {}),
      shade: withShade ? resolvedShade() : undefined,
    });
  }

  async function handleSaveNewMaterial() {
    const value = newMaterialText.trim();
    if (!value || !labOrganizationId) return;
    setAddingMaterialPending(true);
    setAddMaterialError(null);
    try {
      const res = await resilientFetch("/api/vocabulary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "material", value, labOrganizationId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to save");
      }
      setMaterial(value);
      resetAddNewMaterial();
      qc.invalidateQueries({ queryKey: ["vocabulary", "material", labOrganizationId] });
    } catch (e) {
      setAddMaterialError(e instanceof Error ? e.message : "Could not save. Please try again.");
    } finally {
      setAddingMaterialPending(false);
    }
  }

  async function handleSaveNewShade(onSelect: (s: string) => void) {
    const value = newShadeText.trim();
    if (!value || !labOrganizationId) return;
    setAddingShadePending(true);
    setAddShadeError(null);
    try {
      const res = await resilientFetch("/api/vocabulary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "shade", value, labOrganizationId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to save");
      }
      onSelect(value);
      resetAddNewShade();
      qc.invalidateQueries({ queryKey: ["vocabulary", "shade", labOrganizationId] });
    } catch (e) {
      setAddShadeError(e instanceof Error ? e.message : "Could not save. Please try again.");
    } finally {
      setAddingShadePending(false);
    }
  }

  const isInChangePath = step === "change_material" || step === "change_shade";

  const headerTitle =
    step === "choose_material" || step === "change_material"
      ? "Choose material"
      : step === "choose_shade" || step === "change_shade"
      ? "Choose shade"
      : `Tooth ${toothId ?? ""}`;

  function backStep(): Step {
    if (step === "choose_shade") return "choose_material";
    if (step === "change_shade") return "change_material";
    if (step === "choose_material") return "choose_kind";
    if (step === "change_material") return "choose_action";
    if (step === "choose_kind" && existingLabel) return "choose_action";
    return "choose_kind";
  }

  const showBack =
    step === "choose_material" ||
    step === "choose_shade" ||
    step === "change_material" ||
    step === "change_shade" ||
    (step === "choose_kind" && !!existingLabel);

  const canAddVocab = !!labOrganizationId;

  function renderMaterialChips(
    materials: string[],
    testIdPrefix: string,
    onMaterialSelect: (m: string) => void,
  ) {
    return (
      <View style={styles.optionWrap}>
        {materials.map((m) => {
          const on = !isAddingNewMaterial && material === m;
          return (
            <Pressable
              key={m}
              style={[styles.optionChip, on && styles.optionChipOn]}
              onPress={() => {
                resetAddNewMaterial();
                onMaterialSelect(m);
              }}
              disabled={submitting || addingMaterialPending}
              testID={`${testIdPrefix}-${m}`}
            >
              <Text style={[styles.optionText, on && styles.optionTextOn]}>{m}</Text>
            </Pressable>
          );
        })}
        {canAddVocab && (
          <Pressable
            style={[styles.optionChip, styles.optionChipAdd, isAddingNewMaterial && styles.optionChipOn]}
            onPress={() => {
              setIsAddingNewMaterial(true);
              setMaterial("");
            }}
            disabled={submitting || addingMaterialPending}
            testID={`${testIdPrefix}-add-new`}
          >
            <Text style={[styles.optionText, styles.optionTextAdd, isAddingNewMaterial && styles.optionTextOn]}>
              + Add new…
            </Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={submitting ? undefined : onClose}>
        <Pressable
          style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.md }]}
          onPress={dismissKeyboardOnSheetTap}
        >
          <View style={styles.grabber} />

          <View style={styles.headerRow}>
            {showBack ? (
              <Pressable
                onPress={() => setStep(backStep())}
                disabled={submitting}
                hitSlop={8}
                testID="tooth-action-back"
              >
                <Ionicons name="chevron-back" size={22} color={colors.textSecondary} />
              </Pressable>
            ) : (
              <View style={{ width: 22 }} />
            )}
            <Text style={styles.title}>{headerTitle}</Text>
            <Pressable onPress={onClose} disabled={submitting} hitSlop={8} testID="tooth-action-close">
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={scrollKeyboardDismissMode}
          >
            {/* choose_action — tooth already has a restoration */}
            {step === "choose_action" && existingAssignment?.toothNumber && expandToothAssignmentIdentifiers(existingAssignment.toothNumber).length > 1 && (
              <View>
                <Text style={styles.prompt}>Review legacy restoration: this row covers teeth {existingAssignment.toothNumber}. Individual roles are unconfirmed. Remove the entire row before assigning these teeth individually.</Text>
                <Pressable accessibilityRole="button" disabled={submitting} style={{ minHeight: 44, justifyContent: "center" }}
                  onPress={() => toothId && onConfirm({ kind: "remove_restoration", toothId, restorationId: existingRestorationId ?? undefined })}>
                  <Text style={{ color: colors.tint }}>Remove entire row ({existingAssignment.toothNumber})</Text>
                </Pressable>
              </View>
            )}
            {step === "choose_action" && (!existingAssignment?.toothNumber || expandToothAssignmentIdentifiers(existingAssignment.toothNumber).length <= 1) && (
              <>
                <Text style={styles.prompt}>
                  Tooth {toothId} already has {existingLabel}.
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{groupLabel ? `Connected group: ${groupLabel}` : "Not connected to another assigned unit."}</Text>
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                  {existingAssignment?.material || "Material needs review"} · Shade: {existingAssignment?.shade || "Not specified"}
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {(["Crown", "Pontic", "Veneer"] as const).map((role) => (
                    <Pressable key={role} accessibilityRole="button"
                      accessibilityState={{ selected: pendingRole === role }}
                      onPress={() => { captureDraftUndo(); setPendingRole(role); }}
                      style={{ minHeight: 44, padding: 12, borderWidth: 1, borderColor: pendingRole === role ? colors.tint : colors.border, borderRadius: 8 }}>
                      <Text style={{ color: colors.text }}>{role === "Crown" ? "Prepared crown" : role === "Pontic" ? "Pontic" : "Veneer"}</Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable accessibilityRole="button" disabled={!pendingRole || !existingRestorationId || submitting}
                  onPress={() => {
                    if (pendingRole && existingRestorationId && toothId) onConfirm({ kind: "change_role", role: pendingRole, restorationId: existingRestorationId, toothId });
                  }} style={{ minHeight: 44, justifyContent: "center" }}>
                  <Text style={{ color: colors.tint, opacity: pendingRole ? 1 : 0.4 }}>Save role</Text>
                </Pressable>
                <TextInput accessibilityLabel="Copy assignment to teeth" placeholder="Copy to teeth, e.g. 6-8"
                  value={copyTargets} onChangeText={(value) => { captureDraftUndo(); setCopyTargets(value); }}
                  returnKeyType="done" onSubmitEditing={() => Keyboard.dismiss()}
                  style={{ color: colors.text, borderColor: colors.border, borderWidth: 1, minHeight: 44, paddingHorizontal: 12, borderRadius: 8 }} />
                <Pressable accessibilityRole="button" disabled={submitting || !copyTargets.trim()}
                  onPress={() => {
                    const teeth = expandToothAssignmentIdentifiers(copyTargets).filter((target) => target !== toothId);
                    const role = /^crown$/i.test(existingAssignment?.restorationType ?? "") ? "Crown"
                      : /^pontic$/i.test(existingAssignment?.restorationType ?? "") ? "Pontic"
                      : /^veneer$/i.test(existingAssignment?.restorationType ?? "") ? "Veneer" : null;
                    if (!role || !existingAssignment?.material?.trim() || !teeth.length ||
                        teeth.some((tooth) => !/^\d+$/.test(tooth) || (Number(tooth) <= 16) !== (Number(teeth[0]) <= 16))) {
                      Alert.alert("Review copy", "Choose an explicit assigned crown, pontic or veneer with a material, and target teeth from one arch.");
                      return;
                    }
                    onConfirm({
                      kind: "copy_assignment", role, toothNumbers: teeth,
                      material: existingAssignment.material,
                      ...(existingAssignment.restorationSubtype ? { restorationSubtype: existingAssignment.restorationSubtype } : {}),
                      ...(existingAssignment.shade ? { shade: existingAssignment.shade } : {}),
                    });
                  }} style={{ minHeight: 44, justifyContent: "center" }}>
                  <Text style={{ color: colors.tint }}>Apply copied values to teeth</Text>
                </Pressable>
                <View style={styles.kindGrid}>
                  <Pressable
                    style={({ pressed }) => [styles.kindCard, pressed && styles.cardPressed]}
                    onPress={() => {
                      resetWizard();
                      setStep("change_material");
                    }}
                    disabled={submitting}
                    testID="tooth-action-change"
                  >
                    <Text style={styles.kindIcon}>✏️</Text>
                    <Text style={styles.kindLabel}>Change</Text>
                    <Text style={styles.kindDesc}>Update material or shade</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.kindCard, pressed && styles.cardPressed]}
                    onPress={() => {
                      resetWizard();
                      setStep("choose_kind");
                    }}
                    disabled={submitting}
                    testID="tooth-action-add"
                  >
                    <Text style={styles.kindIcon}>➕</Text>
                    <Text style={styles.kindLabel}>Add alongside</Text>
                    <Text style={styles.kindDesc}>New restoration on this tooth</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.kindCard, styles.kindCardDanger, pressed && styles.cardPressed]}
                    onPress={() => {
                      if (!toothId) return;
                      onConfirm({
                        kind: "remove_restoration",
                        toothId,
                        restorationId: existingRestorationId ?? undefined,
                      });
                    }}
                    disabled={submitting}
                    testID="tooth-action-remove"
                  >
                    {submitting ? (
                      <ActivityIndicator size="small" color={colors.error} />
                    ) : (
                      <>
                        <Text style={styles.kindIcon}>🗑️</Text>
                        <Text style={[styles.kindLabel, styles.dangerText]}>Remove</Text>
                        <Text style={styles.kindDesc}>Delete this restoration</Text>
                      </>
                    )}
                  </Pressable>
                </View>
              </>
            )}

            {draftUndo && (
              <Pressable accessibilityRole="button" disabled={submitting}
                onPress={() => {
                  setStep(draftUndo.step); setSelectedRole(draftUndo.role);
                  setMaterial(draftUndo.material); setShade(draftUndo.shade);
                  setCopyTargets(draftUndo.copyTargets); setPendingRole(draftUndo.pendingRole);
                  setDraftUndo(null);
                }} style={{ minHeight: 44, justifyContent: "center" }}>
                <Text style={{ color: colors.tint }}>Undo unsaved tooth edit</Text>
              </Pressable>
            )}
            {/* choose_kind — add a new restoration (alongside or on empty tooth) */}
            {step === "choose_kind" && (
              <>
                <Text style={styles.prompt}>
                  {existingLabel
                    ? `Add another restoration to tooth ${toothId}:`
                    : `What are you adding to tooth ${toothId}?`}
                </Text>
                <View style={styles.kindGrid}>
                  {([
                    { kind: "crown" as const, icon: "C", label: "Anatomical crown", desc: "Prepared tooth" },
                    { kind: "pontic" as const, icon: "P", label: "Pontic", desc: "Bridge unit" },
                    { kind: "veneer" as const, icon: "V", label: "Veneer", desc: "Facial restoration" },
                    { kind: "missing" as const, icon: "✕", label: "Missing", desc: "Visual only, no invoice" },
                  ]).filter((opt) => allowMarkMissing || opt.kind !== "missing").map((opt) => (
                    <Pressable
                      key={opt.kind}
                      style={({ pressed }) => [styles.kindCard, pressed && styles.cardPressed]}
                      onPress={() => handleKind(opt.kind)}
                      disabled={submitting}
                      testID={`tooth-kind-${opt.kind}`}
                    >
                      <Text style={styles.kindIcon}>{opt.icon}</Text>
                      <Text style={styles.kindLabel}>{opt.label}</Text>
                      <Text style={styles.kindDesc}>{opt.desc}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}

            {/* choose_material — add new crown path */}
            {step === "choose_material" && (
              <>
                <Text style={styles.prompt}>Select a material for the {selectedRole} on tooth {toothId}:</Text>
                {catalogTypes.length > 0 ? (
                  <View style={styles.optionWrap}>
                    {[
                      { label: "Crown", restorationSubtype: "", materials: [] },
                      ...catalogTypes,
                    ]
                      .filter((entry, index, entries) =>
                        entries.findIndex(
                          (candidate) =>
                            candidate.label.toLowerCase() === entry.label.toLowerCase(),
                        ) === index,
                      )
                      .map((entry) => (
                        <Pressable
                          key={entry.label}
                          style={[
                            styles.optionChip,
                            restorationType.toLowerCase() === entry.label.toLowerCase() &&
                              styles.optionChipOn,
                          ]}
                          onPress={() => {
                            setRestorationType(entry.label);
                            setMaterial("");
                          }}
                          disabled={submitting || addingMaterialPending}
                        >
                          <Text
                            style={[
                              styles.optionText,
                              restorationType.toLowerCase() === entry.label.toLowerCase() &&
                                styles.optionTextOn,
                            ]}
                          >
                            {entry.label}
                          </Text>
                        </Pressable>
                      ))}
                  </View>
                ) : null}
                {renderMaterialChips(mergedMaterials, "tooth-material", setMaterial)}
                {isAddingNewMaterial && (
                  <AddNewInput
                    value={newMaterialText}
                    placeholder="Type new material…"
                    pending={addingMaterialPending}
                    error={addMaterialError}
                    colors={colors}
                    styles={styles}
                    onChangeText={setNewMaterialText}
                    onCancel={resetAddNewMaterial}
                    onSave={handleSaveNewMaterial}
                    inputTestID="tooth-material-new-input"
                    saveTestID="tooth-material-new-save"
                    cancelTestID="tooth-material-new-cancel"
                  />
                )}
                <Pressable
                  style={[styles.primaryBtn, (!material || submitting || addingMaterialPending) && styles.btnDisabled]}
                  onPress={handleMaterialNext}
                  disabled={!material || submitting || addingMaterialPending}
                  testID="tooth-material-next"
                >
                  <Text style={styles.primaryText}>Next — Pick shade</Text>
                </Pressable>
              </>
            )}

            {/* change_material — update existing restoration path */}
            {step === "change_material" && (
              <>
                <Text style={styles.prompt}>
                  Choose a new material for tooth {toothId}:
                </Text>
                {renderMaterialChips(mergedMaterials, "tooth-change-material", setMaterial)}
                {isAddingNewMaterial && (
                  <AddNewInput
                    value={newMaterialText}
                    placeholder="Type new material…"
                    pending={addingMaterialPending}
                    error={addMaterialError}
                    colors={colors}
                    styles={styles}
                    onChangeText={setNewMaterialText}
                    onCancel={resetAddNewMaterial}
                    onSave={handleSaveNewMaterial}
                    inputTestID="tooth-change-material-new-input"
                    saveTestID="tooth-change-material-new-save"
                    cancelTestID="tooth-change-material-new-cancel"
                  />
                )}
                <Pressable
                  style={[styles.primaryBtn, (!material || submitting || addingMaterialPending) && styles.btnDisabled]}
                  onPress={handleChangeMaterialNext}
                  disabled={!material || submitting || addingMaterialPending}
                  testID="tooth-change-material-next"
                >
                  <Text style={styles.primaryText}>Next — Pick shade</Text>
                </Pressable>
              </>
            )}

            {/* choose_shade — add new crown path */}
            {step === "choose_shade" && (
              <ShadeStep
                toothId={toothId}
                shade={shade}
                isCustomShade={isCustomShade}
                customShade={customShade}
                submitting={submitting}
                colors={colors}
                styles={styles}
                shades={mergedShades}
                canAddVocab={canAddVocab}
                isAddingNewShade={isAddingNewShade}
                newShadeText={newShadeText}
                addingShadePending={addingShadePending}
                addShadeError={addShadeError}
                onShadeSelect={(s) => { setShade(s); setIsCustomShade(false); setCustomShade(""); resetAddNewShade(); }}
                onCustomShadeToggle={() => { setIsCustomShade(true); setShade(""); resetAddNewShade(); }}
                onCustomShadeChange={setCustomShade}
                onAddNewShadeToggle={() => { setIsAddingNewShade(true); setShade(""); setIsCustomShade(false); setCustomShade(""); }}
                onNewShadeTextChange={setNewShadeText}
                onCancelNewShade={resetAddNewShade}
                onSaveNewShade={() => handleSaveNewShade((s) => { setShade(s); setIsCustomShade(false); setCustomShade(""); })}
                onSkip={() => handleShadeConfirm(false)}
                onConfirm={() => handleShadeConfirm(true)}
                skipTestID="tooth-shade-skip"
                confirmTestID="tooth-shade-confirm"
              />
            )}

            {/* change_shade — update existing restoration path */}
            {step === "change_shade" && (
              <ShadeStep
                toothId={toothId}
                shade={shade}
                isCustomShade={isCustomShade}
                customShade={customShade}
                submitting={submitting}
                colors={colors}
                styles={styles}
                shades={mergedShades}
                canAddVocab={canAddVocab}
                isAddingNewShade={isAddingNewShade}
                newShadeText={newShadeText}
                addingShadePending={addingShadePending}
                addShadeError={addShadeError}
                onShadeSelect={(s) => { setShade(s); setIsCustomShade(false); setCustomShade(""); resetAddNewShade(); }}
                onCustomShadeToggle={() => { setIsCustomShade(true); setShade(""); resetAddNewShade(); }}
                onCustomShadeChange={setCustomShade}
                onAddNewShadeToggle={() => { setIsAddingNewShade(true); setShade(""); setIsCustomShade(false); setCustomShade(""); }}
                onNewShadeTextChange={setNewShadeText}
                onCancelNewShade={resetAddNewShade}
                onSaveNewShade={() => handleSaveNewShade((s) => { setShade(s); setIsCustomShade(false); setCustomShade(""); })}
                onSkip={() => handleChangeShadeConfirm(false)}
                onConfirm={() => handleChangeShadeConfirm(true)}
                skipTestID="tooth-change-shade-skip"
                confirmTestID="tooth-change-shade-confirm"
              />
            )}

            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

interface AddNewInputProps {
  value: string;
  placeholder: string;
  pending: boolean;
  error: string | null;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  onChangeText: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
  inputTestID: string;
  saveTestID: string;
  cancelTestID: string;
}

function AddNewInput({
  value,
  placeholder,
  pending,
  error,
  colors,
  styles,
  onChangeText,
  onCancel,
  onSave,
  inputTestID,
  saveTestID,
  cancelTestID,
}: AddNewInputProps) {
  return (
    <View style={styles.addNewWrap}>
      <TextInput
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        value={value}
        onChangeText={onChangeText}
        autoFocus
        editable={!pending}
        testID={inputTestID}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <View style={styles.addNewRow}>
        <Pressable
          style={[styles.secondaryBtn, pending && styles.btnDisabled]}
          onPress={onCancel}
          disabled={pending}
          testID={cancelTestID}
        >
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.primaryBtn, styles.flex1, (!value.trim() || pending) && styles.btnDisabled]}
          onPress={onSave}
          disabled={!value.trim() || pending}
          testID={saveTestID}
        >
          {pending ? (
            <ActivityIndicator size="small" color={colors.textInverse} />
          ) : (
            <Text style={styles.primaryText}>Save & use</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

interface ShadeStepProps {
  toothId: string | null;
  shade: string;
  isCustomShade: boolean;
  customShade: string;
  submitting: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  shades: string[];
  canAddVocab: boolean;
  isAddingNewShade: boolean;
  newShadeText: string;
  addingShadePending: boolean;
  addShadeError: string | null;
  onShadeSelect: (s: string) => void;
  onCustomShadeToggle: () => void;
  onCustomShadeChange: (v: string) => void;
  onAddNewShadeToggle: () => void;
  onNewShadeTextChange: (v: string) => void;
  onCancelNewShade: () => void;
  onSaveNewShade: () => void;
  onSkip: () => void;
  onConfirm: () => void;
  skipTestID: string;
  confirmTestID: string;
}

function ShadeStep({
  shade,
  isCustomShade,
  customShade,
  submitting,
  colors,
  styles,
  shades,
  canAddVocab,
  isAddingNewShade,
  newShadeText,
  addingShadePending,
  addShadeError,
  onShadeSelect,
  onCustomShadeToggle,
  onCustomShadeChange,
  onAddNewShadeToggle,
  onNewShadeTextChange,
  onCancelNewShade,
  onSaveNewShade,
  onSkip,
  onConfirm,
  skipTestID,
  confirmTestID,
}: ShadeStepProps) {
  const anyBusy = submitting || addingShadePending;
  return (
    <>
      <Text style={styles.prompt}>
        Select a shade <Text style={styles.muted}>(optional)</Text>:
      </Text>
      <View style={styles.optionWrap}>
        {shades.map((s) => {
          const on = !isCustomShade && !isAddingNewShade && shade === s;
          return (
            <Pressable
              key={s}
              style={[styles.optionChip, on && styles.optionChipOn]}
              onPress={() => onShadeSelect(s)}
              disabled={anyBusy}
              testID={`tooth-shade-${s}`}
            >
              <Text style={[styles.optionText, on && styles.optionTextOn]}>{s}</Text>
            </Pressable>
          );
        })}
        <Pressable
          style={[styles.optionChip, isCustomShade && styles.optionChipOn]}
          onPress={onCustomShadeToggle}
          disabled={anyBusy}
          testID="tooth-shade-other"
        >
          <Text style={[styles.optionText, isCustomShade && styles.optionTextOn]}>Other</Text>
        </Pressable>
        {canAddVocab && (
          <Pressable
            style={[styles.optionChip, styles.optionChipAdd, isAddingNewShade && styles.optionChipOn]}
            onPress={onAddNewShadeToggle}
            disabled={anyBusy}
            testID="tooth-shade-add-new"
          >
            <Text style={[styles.optionText, styles.optionTextAdd, isAddingNewShade && styles.optionTextOn]}>
              + Add new…
            </Text>
          </Pressable>
        )}
      </View>
      {isCustomShade && (
        <TextInput
          style={styles.input}
          placeholder="Type custom shade…"
          placeholderTextColor={colors.textTertiary}
          value={customShade}
          onChangeText={onCustomShadeChange}
          autoFocus
          testID="tooth-shade-custom"
        />
      )}
      {isAddingNewShade && (
        <AddNewInput
          value={newShadeText}
          placeholder="Type new shade…"
          pending={addingShadePending}
          error={addShadeError}
          colors={colors}
          styles={styles}
          onChangeText={onNewShadeTextChange}
          onCancel={onCancelNewShade}
          onSave={onSaveNewShade}
          inputTestID="tooth-shade-new-input"
          saveTestID="tooth-shade-new-save"
          cancelTestID="tooth-shade-new-cancel"
        />
      )}
      <View style={styles.shadeFooter}>
        <Pressable
          style={[styles.secondaryBtn, anyBusy && styles.btnDisabled]}
          onPress={onSkip}
          disabled={anyBusy}
          testID={skipTestID}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Text style={styles.secondaryText}>Skip</Text>
          )}
        </Pressable>
        <Pressable
          style={[
            styles.primaryBtn,
            styles.flex1,
            (anyBusy || isAddingNewShade || (isCustomShade ? !customShade.trim() : !shade)) && styles.btnDisabled,
          ]}
          onPress={onConfirm}
          disabled={anyBusy || isAddingNewShade || (isCustomShade ? !customShade.trim() : !shade)}
          testID={confirmTestID}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={colors.textInverse} />
          ) : (
            <Text style={styles.primaryText}>Confirm</Text>
          )}
        </Pressable>
      </View>
    </>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
    sheet: {
      backgroundColor: c.backgroundSolid,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      maxHeight: "88%",
    },
    grabber: {
      alignSelf: "center",
      width: 40,
      height: 4,
      borderRadius: Radius.full,
      backgroundColor: c.border,
      marginBottom: Spacing.sm,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: Spacing.md,
    },
    title: { ...Typography.h2, color: c.text },
    body: { flexGrow: 0 },
    bodyContent: { gap: Spacing.md, paddingBottom: Spacing.md },
    prompt: { ...Typography.body, color: c.textSecondary },
    muted: { color: c.textTertiary },
    kindGrid: { gap: Spacing.sm },
    kindCard: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.lg,
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.lg,
      backgroundColor: c.surfaceAlt,
      gap: 2,
    },
    kindCardDanger: {
      borderColor: `${c.error}55`,
      backgroundColor: `${c.error}12`,
    },
    cardPressed: { opacity: 0.6 },
    kindIcon: { fontSize: 22 },
    kindLabel: { ...Typography.bodySemibold, color: c.text },
    dangerText: { color: c.error },
    kindDesc: { ...Typography.caption, color: c.textTertiary },
    optionWrap: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    optionChip: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
      backgroundColor: c.surfaceAlt,
      minWidth: 56,
      alignItems: "center",
    },
    optionChipOn: { borderColor: c.tint, backgroundColor: c.surfaceAlt },
    optionChipAdd: { borderStyle: "dashed", borderColor: c.tint },
    optionText: { ...Typography.bodyMedium, color: c.textSecondary },
    optionTextOn: { color: c.tint },
    optionTextAdd: { color: c.tint },
    addNewWrap: { gap: Spacing.sm },
    addNewRow: { flexDirection: "row", gap: Spacing.sm },
    input: {
      ...Typography.body,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      backgroundColor: c.surfaceAlt,
    },
    primaryBtn: {
      paddingVertical: Spacing.md,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
      alignItems: "center",
    },
    primaryText: { ...Typography.bodySemibold, color: c.textInverse },
    secondaryBtn: {
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.xl,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
    },
    secondaryText: { ...Typography.bodySemibold, color: c.textSecondary },
    shadeFooter: { flexDirection: "row", gap: Spacing.sm },
    errorText: { ...Typography.caption, color: c.error, textAlign: "center" },
    flex1: { flex: 1 },
    btnDisabled: { opacity: 0.45 },
  });
}
