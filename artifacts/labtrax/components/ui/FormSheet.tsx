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
import {
  scrollKeyboardDismissMode,
  useDismissKeyboardOnTap,
} from "@/components/ui/DismissKeyboardView";

interface FormSheetProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  submitting?: boolean;
  /**
   * Controls only the footer submit spinner. Keep the footer disabled while
   * another in-sheet action is saving without implying that the footer action
   * itself is running.
   */
  submitLoading?: boolean;
  submitLabel?: string;
  cancelLabel?: string;
  submitDisabled?: boolean;
  /** When provided, renders a destructive action in the footer. */
  onDelete?: () => void;
  deleteLabel?: string;
  /**
   * Namespaces the footer button testIDs (`${testIDPrefix}-save` /
   * `-cancel` / `-delete`). Defaults to "form". Use a distinct prefix when
   * two FormSheets can be mounted at once (e.g. the mobile test Modal stub
   * renders children regardless of `visible`) so their buttons don't collide.
   */
  testIDPrefix?: string;
  /**
   * Gives long forms a finite body viewport while leaving the default
   * content-sized sheet behavior unchanged for existing consumers.
   */
  boundedBody?: boolean;
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
  submitLoading = submitting,
  submitLabel = "Save",
  cancelLabel = "Cancel",
  submitDisabled = false,
  onDelete,
  deleteLabel = "Delete",
  testIDPrefix = "form",
  boundedBody = false,
  children,
}: FormSheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const dismissKeyboardOnSheetTap = useDismissKeyboardOnTap();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable
          style={styles.backdrop}
          onPress={submitting ? undefined : onClose}
          testID={`${testIDPrefix}-backdrop`}
        >
          <Pressable
            style={[
              styles.sheet,
              boundedBody && styles.boundedSheet,
              { paddingBottom: insets.bottom + Spacing.md },
            ]}
            // The sheet must always claim the tap so it never reaches the
            // closing backdrop; while the keyboard is up it also closes it.
            onPress={dismissKeyboardOnSheetTap}
            testID={`${testIDPrefix}-sheet`}
          >
            <View style={styles.grabber} />
            <Text style={styles.title}>{title}</Text>
            <ScrollView
              testID={`${testIDPrefix}-body-scroll`}
              style={[styles.body, boundedBody && styles.boundedBody]}
              contentContainerStyle={styles.bodyContent}
              keyboardShouldPersistTaps="handled"
              // Match the nested horizontal-scroller's axis lock so a vertical
              // drag that starts over media stays with the bounded body.
              directionalLockEnabled={boundedBody}
              // Dragging the body closes the keyboard. "handled" above keeps
              // suggestion lists and buttons single-tap.
              keyboardDismissMode={scrollKeyboardDismissMode}
              nestedScrollEnabled={boundedBody}
            >
              {children}
            </ScrollView>
            <View style={styles.footer}>
              {onDelete ? (
                <Pressable
                  style={styles.deleteBtn}
                  onPress={onDelete}
                  disabled={submitting}
                  testID={`${testIDPrefix}-delete`}
                >
                  <Text style={styles.deleteText}>{deleteLabel}</Text>
                </Pressable>
              ) : (
                <Pressable
                  style={styles.cancelBtn}
                  onPress={onClose}
                  disabled={submitting}
                  testID={`${testIDPrefix}-cancel`}
                >
                  <Text style={styles.cancelText}>{cancelLabel}</Text>
                </Pressable>
              )}
              <Pressable
                style={[
                  styles.saveBtn,
                  (submitting || submitDisabled) && styles.saveBtnDisabled,
                ]}
                onPress={onSubmit}
                disabled={submitting || submitDisabled}
                testID={`${testIDPrefix}-save`}
              >
                {submitLoading ? (
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
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.45)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: c.backgroundSolid,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      maxHeight: "88%",
    },
    boundedSheet: { height: "88%" },
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
    boundedBody: { flex: 1, flexGrow: 1, minHeight: 0 },
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
