import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAddCaseNote,
  useUpdateCase,
  type UpdateCaseInput,
} from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { DateField } from "@/components/DateField";
import {
  RETURN_STEP_OPTIONS,
  nextReturnedWizardStage,
  type ReturnedWizardStage,
} from "@/lib/returned-case-wizard";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";

const QUESTIONS: Record<
  ReturnedWizardStage,
  { title: string; body: string; yes?: string; no?: string }
> = {
  dueDate: {
    title: "Set a new due date?",
    body: "This case has come back to the lab. Would you like to set a new due date?",
  },
  rxScan: {
    title: "Scan a new prescription?",
    body: "Capture the new Rx with the AI reader and attach it to this case.",
  },
  remake: {
    title: "Is this case a remake?",
    body: "Record the remake reason and link it back to the original case.",
  },
  removable: {
    title: "Is this a removable case?",
    body: "Removable cases return to a specific workflow step.",
  },
  notes: {
    title: "Would you like to add any notes?",
    body: "Notes are saved to this case and stay internal to the lab.",
  },
  printLabSlip: {
    title: "Print a new lab slip?",
    body: "Prints the case work order with the updated details.",
  },
  printCaseLabel: {
    title: "Print a new case label?",
    body: "Prints the work-order label for this case.",
  },
};

export interface ReturnedCaseWizardProps {
  caseId: string;
  /** Current question, or null when the wizard is closed. Fully controlled. */
  stage: ReturnedWizardStage | null;
  /**
   * Whether the viewer may change the case's workflow step. When false the
   * removable question is skipped entirely.
   */
  canChangeStep: boolean;
  /** The case's current workflow step, pre-selected in the step list. */
  currentStep?: string | null;
  onStageChange: (stage: ReturnedWizardStage | null) => void;
  /** Opens the AI reader in attach-to-this-case mode. Host handles resuming. */
  onScanPrescription: () => void;
  /** Opens the existing remake protocol. Host handles resuming. */
  onStartRemake: () => void;
  onPrintLabSlip: () => void | Promise<void>;
  onPrintCaseLabel: () => void | Promise<void>;
  /** Refreshes the case after a stage writes to it. */
  onSaved?: () => void | Promise<unknown>;
}

/**
 * ReturnedCaseWizard — one ordered sequence of Yes/No questions asked after a
 * case is located from complete back to intake.
 *
 * Rendered as an in-tree overlay rather than a <Modal> so the stages that need
 * their own modal (the date calendar, the remake protocol) can layer above it
 * without nesting native modals.
 */
export function ReturnedCaseWizard({
  caseId,
  stage,
  canChangeStep,
  currentStep,
  onStageChange,
  onScanPrescription,
  onStartRemake,
  onPrintLabSlip,
  onPrintCaseLabel,
  onSaved,
}: ReturnedCaseWizardProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const update = useUpdateCase();
  const addNote = useAddCaseNote();

  // "ask" shows the Yes/No question; "answer" shows the stage's input panel.
  const [panel, setPanel] = useState<"ask" | "answer">("ask");
  const [dueDate, setDueDate] = useState("");
  const [noteText, setNoteText] = useState("");
  const [busy, setBusy] = useState(false);

  function resetPanel() {
    setPanel("ask");
    setDueDate("");
    setNoteText("");
  }

  function advance() {
    if (!stage) return;
    resetPanel();
    onStageChange(nextReturnedWizardStage(stage, { canChangeStep }));
  }

  function dismiss() {
    if (busy) return;
    resetPanel();
    onStageChange(null);
  }

  async function refresh() {
    await Promise.all([
      onSaved?.(),
      qc.invalidateQueries({ queryKey: ["cases", caseId] }),
      qc.invalidateQueries({ queryKey: ["cases"] }),
    ]);
  }

  function handleYes() {
    if (!stage || busy) return;
    switch (stage) {
      case "dueDate":
      case "removable":
      case "notes":
        setPanel("answer");
        return;
      case "rxScan":
        resetPanel();
        onScanPrescription();
        return;
      case "remake":
        resetPanel();
        onStartRemake();
        return;
      case "printLabSlip":
        void runPrint(onPrintLabSlip);
        return;
      case "printCaseLabel":
        void runPrint(onPrintCaseLabel);
        return;
    }
  }

  async function runPrint(action: () => void | Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
      advance();
    }
  }

  async function saveDueDate() {
    if (!dueDate) return;
    setBusy(true);
    try {
      await update.mutateAsync({ caseId, data: { dueDate } as UpdateCaseInput });
      await refresh();
      advance();
    } catch (e) {
      Alert.alert("Couldn't update due date", errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveStep(step: string) {
    setBusy(true);
    try {
      if (step !== (currentStep ?? "")) {
        await update.mutateAsync({ caseId, data: { step } as UpdateCaseInput });
        await refresh();
      }
      advance();
    } catch (e) {
      Alert.alert("Couldn't update step", errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveNote() {
    const trimmed = noteText.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await addNote.mutateAsync({
        caseId,
        data: { noteText: trimmed, visibility: "internal_lab_only" },
      });
      await refresh();
      advance();
    } catch (e) {
      Alert.alert("Couldn't add note", errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!stage) return null;

  const q = QUESTIONS[stage];

  return (
    <View style={styles.overlay} testID="returned-case-wizard">
      <Pressable style={styles.backdrop} onPress={dismiss} accessibilityLabel="Dismiss" />
      <KeyboardAvoidingView
        style={styles.kav}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        pointerEvents="box-none"
      >
        <DismissKeyboardView
          style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.lg }]}
          testID="returned-case-wizard-keyboard-dismiss"
        >
          <View style={styles.grabber} />

          <View style={styles.headerRow}>
            <Text style={styles.eyebrow}>Case returned to the lab</Text>
            <Pressable
              onPress={dismiss}
              hitSlop={8}
              testID="returned-wizard-dismiss"
              accessibilityLabel="Skip the remaining questions"
            >
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>

          <Text style={styles.title} testID="returned-wizard-title">
            {q.title}
          </Text>
          <Text style={styles.body}>{q.body}</Text>

          {panel === "ask" ? (
            <View style={styles.answerRow}>
              <Pressable
                style={[styles.btnSecondary, busy && styles.btnDisabled]}
                onPress={advance}
                disabled={busy}
                testID="returned-wizard-no"
              >
                <Text style={styles.btnSecondaryText}>{q.no ?? "No"}</Text>
              </Pressable>
              <Pressable
                style={[styles.btnPrimary, busy && styles.btnDisabled]}
                onPress={handleYes}
                disabled={busy}
                testID="returned-wizard-yes"
              >
                {busy ? (
                  <ActivityIndicator size="small" color={colors.textInverse} />
                ) : (
                  <Text style={styles.btnPrimaryText}>{q.yes ?? "Yes"}</Text>
                )}
              </Pressable>
            </View>
          ) : null}

          {panel === "answer" && stage === "dueDate" ? (
            <View style={styles.panel}>
              <Text style={styles.panelLabel}>New due date</Text>
              <DateField
                value={dueDate || null}
                allowTyping
                onChange={setDueDate}
                title="New due date"
                placeholder="Pick a date"
                testID="returned-wizard-due-date"
              />
              <Pressable
                style={[styles.btnPrimary, (!dueDate || busy) && styles.btnDisabled]}
                onPress={() => void saveDueDate()}
                disabled={!dueDate || busy}
                testID="returned-wizard-due-date-save"
              >
                {busy ? (
                  <ActivityIndicator size="small" color={colors.textInverse} />
                ) : (
                  <Text style={styles.btnPrimaryText}>Save due date</Text>
                )}
              </Pressable>
            </View>
          ) : null}

          {panel === "answer" && stage === "removable" ? (
            <View style={styles.panel}>
              <Text style={styles.panelLabel}>Workflow step</Text>
              <ScrollView
                style={styles.stepList}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={scrollKeyboardDismissMode}
                testID="returned-wizard-step-list"
              >
                {RETURN_STEP_OPTIONS.map((opt) => {
                  const on = opt.value === (currentStep ?? "");
                  return (
                    <Pressable
                      key={opt.value}
                      style={styles.stepRow}
                      onPress={() => void saveStep(opt.value)}
                      disabled={busy}
                      testID={`returned-wizard-step-${opt.value}`}
                    >
                      <Text style={[styles.stepText, on && styles.stepTextActive]}>
                        {opt.label}
                      </Text>
                      {on ? <Ionicons name="checkmark" size={18} color={colors.tint} /> : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}

          {panel === "answer" && stage === "notes" ? (
            <View style={styles.panel}>
              <Text style={styles.panelLabel}>Note (internal to the lab)</Text>
              <TextInput
                style={styles.noteInput}
                value={noteText}
                onChangeText={setNoteText}
                autoCorrect={true}
                spellCheck={true}
                autoCapitalize="sentences"
                placeholder="Write a note…"
                placeholderTextColor={colors.textTertiary}
                multiline
                textAlignVertical="top"
                testID="returned-wizard-note-input"
              />
              <Pressable
                style={[styles.btnPrimary, (!noteText.trim() || busy) && styles.btnDisabled]}
                onPress={() => void saveNote()}
                disabled={!noteText.trim() || busy}
                testID="returned-wizard-note-save"
              >
                {busy ? (
                  <ActivityIndicator size="small" color={colors.textInverse} />
                ) : (
                  <Text style={styles.btnPrimaryText}>Save note</Text>
                )}
              </Pressable>
            </View>
          ) : null}
        </DismissKeyboardView>
      </KeyboardAvoidingView>
    </View>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "Please try again.";
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end", zIndex: 50 },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
    kav: { justifyContent: "flex-end" },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      gap: Spacing.sm,
    },
    grabber: {
      width: 36,
      height: 4,
      borderRadius: 2,
      alignSelf: "center",
      backgroundColor: c.border,
      marginBottom: Spacing.xs,
    },
    headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    eyebrow: { ...Typography.captionSemibold, color: c.tint, textTransform: "uppercase" },
    title: { ...Typography.h2, color: c.text },
    body: { ...Typography.body, color: c.textSecondary },
    answerRow: { flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.sm },
    panel: { gap: Spacing.sm, marginTop: Spacing.sm },
    panelLabel: { ...Typography.label, color: c.textSecondary },
    stepList: { maxHeight: 240 },
    stepRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: Spacing.md,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      marginBottom: Spacing.xs,
    },
    stepText: { ...Typography.bodySemibold, color: c.text },
    stepTextActive: { color: c.tint },
    noteInput: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: Radius.sm,
      backgroundColor: c.surfaceSecondary,
      color: c.text,
      padding: Spacing.sm,
      minHeight: 90,
      ...Typography.body,
    },
    btnPrimary: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
      backgroundColor: c.tint,
    },
    btnPrimaryText: { ...Typography.bodySemibold, color: c.textInverse },
    btnSecondary: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
    },
    btnSecondaryText: { ...Typography.bodySemibold, color: c.textSecondary },
    btnDisabled: { opacity: 0.5 },
  });
}
