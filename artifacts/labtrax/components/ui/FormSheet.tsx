import React, { useMemo } from "react";
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";

interface FormSheetProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  submitting?: boolean;
  submitLabel?: string;
  submitDisabled?: boolean;
  /** When provided, renders a destructive action in the footer. */
  onDelete?: () => void;
  deleteLabel?: string;
  children: React.ReactNode;
}

/**
 * FormSheet — the canonical bottom-sheet editor used by the editable management
 * screens. Provides a backdrop, a draggable-looking sheet, a scrollable body,
 * and a footer with Cancel / Save (and an optional destructive action). Keeps
 * the add/edit UX consistent across Lists and Pricing.
 */
export function FormSheet({
  visible,
  title,
  onClose,
  onSubmit,
  submitting = false,
  submitLabel = "Save",
  submitDisabled = false,
  onDelete,
  deleteLabel = "Delete",
  children,
}: FormSheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.backdrop} onPress={submitting ? undefined : onClose}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.md }]} onPress={() => undefined}>
            <View style={styles.grabber} />
            <Text style={styles.title}>{title}</Text>
            <ScrollView
              style={styles.body}
              contentContainerStyle={styles.bodyContent}
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>
            <View style={styles.footer}>
              {onDelete ? (
                <Pressable
                  style={styles.deleteBtn}
                  onPress={onDelete}
                  disabled={submitting}
                  testID="form-delete"
                >
                  <Text style={styles.deleteText}>{deleteLabel}</Text>
                </Pressable>
              ) : (
                <Pressable style={styles.cancelBtn} onPress={onClose} disabled={submitting} testID="form-cancel">
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
              )}
              <Pressable
                style={[styles.saveBtn, (submitting || submitDisabled) && styles.saveBtnDisabled]}
                onPress={onSubmit}
                disabled={submitting || submitDisabled}
                testID="form-save"
              >
                {submitting ? (
                  <ActivityIndicator size="small" color={colors.textInverse} />
                ) : (
                  <Text style={styles.saveText}>{submitLabel}</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1 },
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
    title: { ...Typography.h2, color: c.text, marginBottom: Spacing.md },
    body: { flexGrow: 0 },
    bodyContent: { gap: Spacing.md, paddingBottom: Spacing.md },
    footer: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.md,
      paddingTop: Spacing.sm,
    },
    cancelBtn: { paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md },
    cancelText: { ...Typography.bodySemibold, color: c.textSecondary },
    deleteBtn: { paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md },
    deleteText: { ...Typography.bodySemibold, color: c.error },
    saveBtn: {
      flex: 1,
      paddingVertical: Spacing.md,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
      alignItems: "center",
    },
    saveBtnDisabled: { opacity: 0.6 },
    saveText: { ...Typography.bodySemibold, color: c.textInverse },
  });
}
