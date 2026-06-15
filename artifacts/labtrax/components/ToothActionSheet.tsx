import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import type { ToothId } from "@/lib/rx-summary";

const CROWN_MATERIALS = [
  "Zirconia",
  "PFM",
  "E.max",
  "Full Cast",
  "Composite",
  "Acrylic",
  "Metal",
  "PMMA",
  "Other",
] as const;

const VITA_SHADES = [
  "A1", "A2", "A3", "A3.5", "A4",
  "B1", "B2", "B3", "B4",
  "C1", "C2", "C3", "C4",
  "D2", "D3", "D4",
  "OM1", "OM2", "OM3",
  "1M1", "1M2", "1M3",
] as const;

export type ToothActionPayload =
  | {
      kind: "add_crown";
      toothId: string;
      material: string;
      restorationType: string;
      shade?: string;
    }
  | { kind: "add_pontic"; toothId: string }
  | { kind: "mark_missing"; toothId: string }
  | { kind: "remove_restoration"; toothId: string; restorationId?: string }
  | {
      kind: "change_restoration";
      toothId: string;
      restorationId: string;
      material: string;
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
  toothId: ToothId | null;
  /** Human-readable description(s) of any restoration already on this tooth. */
  existingLabel?: string | null;
  /** ID of the restoration on this tooth targeted by Change/Remove actions. */
  existingRestorationId?: string | null;
  submitting?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (payload: ToothActionPayload) => void;
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
  existingLabel,
  existingRestorationId,
  submitting = false,
  error,
  onClose,
  onConfirm,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [step, setStep] = useState<Step>("choose_kind");
  const [material, setMaterial] = useState("");
  const [shade, setShade] = useState("");
  const [customShade, setCustomShade] = useState("");
  const [isCustomShade, setIsCustomShade] = useState(false);

  function resetWizard() {
    setMaterial("");
    setShade("");
    setCustomShade("");
    setIsCustomShade(false);
  }

  useEffect(() => {
    if (toothId !== null) {
      setStep(existingLabel ? "choose_action" : "choose_kind");
      resetWizard();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toothId, existingLabel]);

  const visible = toothId !== null;

  function resolvedShade(): string | undefined {
    if (isCustomShade) return customShade.trim() || undefined;
    return shade || undefined;
  }

  function handleKind(kind: "crown" | "pontic" | "missing") {
    if (!toothId) return;
    if (kind === "crown") {
      setStep("choose_material");
    } else if (kind === "pontic") {
      onConfirm({ kind: "add_pontic", toothId });
    } else {
      onConfirm({ kind: "mark_missing", toothId });
    }
  }

  function handleMaterialNext() {
    if (!material) return;
    setShade("");
    setCustomShade("");
    setIsCustomShade(false);
    setStep("choose_shade");
  }

  function handleShadeConfirm(withShade: boolean) {
    if (!toothId) return;
    onConfirm({
      kind: "add_crown",
      toothId,
      material,
      restorationType: "Crown",
      shade: withShade ? resolvedShade() : undefined,
    });
  }

  function handleChangeMaterialNext() {
    if (!material) return;
    setShade("");
    setCustomShade("");
    setIsCustomShade(false);
    setStep("change_shade");
  }

  function handleChangeShadeConfirm(withShade: boolean) {
    if (!toothId || !existingRestorationId) return;
    onConfirm({
      kind: "change_restoration",
      toothId,
      restorationId: existingRestorationId,
      material,
      shade: withShade ? resolvedShade() : undefined,
    });
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

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={submitting ? undefined : onClose}>
        <Pressable
          style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.md }]}
          onPress={() => undefined}
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
          >
            {/* choose_action — tooth already has a restoration */}
            {step === "choose_action" && (
              <>
                <Text style={styles.prompt}>
                  Tooth {toothId} already has {existingLabel}.
                </Text>
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
                    { kind: "crown" as const, icon: "👑", label: "Crown / Restoration", desc: "Adds a billed line item" },
                    { kind: "pontic" as const, icon: "🔗", label: "Pontic", desc: "Bridge unit" },
                    { kind: "missing" as const, icon: "✕", label: "Missing", desc: "Visual only, no invoice" },
                  ]).map((opt) => (
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
                <Text style={styles.prompt}>Select a material for the crown on tooth {toothId}:</Text>
                <View style={styles.optionWrap}>
                  {CROWN_MATERIALS.map((m) => {
                    const on = material === m;
                    return (
                      <Pressable
                        key={m}
                        style={[styles.optionChip, on && styles.optionChipOn]}
                        onPress={() => setMaterial(m)}
                        disabled={submitting}
                        testID={`tooth-material-${m}`}
                      >
                        <Text style={[styles.optionText, on && styles.optionTextOn]}>{m}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Pressable
                  style={[styles.primaryBtn, (!material || submitting) && styles.btnDisabled]}
                  onPress={handleMaterialNext}
                  disabled={!material || submitting}
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
                <View style={styles.optionWrap}>
                  {CROWN_MATERIALS.map((m) => {
                    const on = material === m;
                    return (
                      <Pressable
                        key={m}
                        style={[styles.optionChip, on && styles.optionChipOn]}
                        onPress={() => setMaterial(m)}
                        disabled={submitting}
                        testID={`tooth-change-material-${m}`}
                      >
                        <Text style={[styles.optionText, on && styles.optionTextOn]}>{m}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Pressable
                  style={[styles.primaryBtn, (!material || submitting) && styles.btnDisabled]}
                  onPress={handleChangeMaterialNext}
                  disabled={!material || submitting}
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
                onShadeSelect={(s) => { setShade(s); setIsCustomShade(false); setCustomShade(""); }}
                onCustomShadeToggle={() => { setIsCustomShade(true); setShade(""); }}
                onCustomShadeChange={setCustomShade}
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
                onShadeSelect={(s) => { setShade(s); setIsCustomShade(false); setCustomShade(""); }}
                onCustomShadeToggle={() => { setIsCustomShade(true); setShade(""); }}
                onCustomShadeChange={setCustomShade}
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

interface ShadeStepProps {
  toothId: string | null;
  shade: string;
  isCustomShade: boolean;
  customShade: string;
  submitting: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  onShadeSelect: (s: string) => void;
  onCustomShadeToggle: () => void;
  onCustomShadeChange: (v: string) => void;
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
  onShadeSelect,
  onCustomShadeToggle,
  onCustomShadeChange,
  onSkip,
  onConfirm,
  skipTestID,
  confirmTestID,
}: ShadeStepProps) {
  return (
    <>
      <Text style={styles.prompt}>
        Select a shade <Text style={styles.muted}>(optional)</Text>:
      </Text>
      <View style={styles.optionWrap}>
        {VITA_SHADES.map((s) => {
          const on = !isCustomShade && shade === s;
          return (
            <Pressable
              key={s}
              style={[styles.optionChip, on && styles.optionChipOn]}
              onPress={() => onShadeSelect(s)}
              disabled={submitting}
              testID={`tooth-shade-${s}`}
            >
              <Text style={[styles.optionText, on && styles.optionTextOn]}>{s}</Text>
            </Pressable>
          );
        })}
        <Pressable
          style={[styles.optionChip, isCustomShade && styles.optionChipOn]}
          onPress={onCustomShadeToggle}
          disabled={submitting}
          testID="tooth-shade-other"
        >
          <Text style={[styles.optionText, isCustomShade && styles.optionTextOn]}>Other</Text>
        </Pressable>
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
      <View style={styles.shadeFooter}>
        <Pressable
          style={[styles.secondaryBtn, submitting && styles.btnDisabled]}
          onPress={onSkip}
          disabled={submitting}
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
            (submitting || (isCustomShade ? !customShade.trim() : !shade)) && styles.btnDisabled,
          ]}
          onPress={onConfirm}
          disabled={submitting || (isCustomShade ? !customShade.trim() : !shade)}
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
    optionText: { ...Typography.bodyMedium, color: c.textSecondary },
    optionTextOn: { color: c.tint },
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
    shadeFooter: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    flex1: { flex: 1 },
    btnDisabled: { opacity: 0.5 },
    errorText: {
      ...Typography.caption,
      color: c.error,
      backgroundColor: "rgba(220,38,38,0.08)",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.sm,
    },
  });
}
