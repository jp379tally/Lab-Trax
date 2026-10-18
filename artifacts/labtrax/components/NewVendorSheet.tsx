import React, { useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DismissKeyboardView, scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { TextField } from "@/components/ui/TextField";
import { sendJson } from "@/lib/read-api";
import type { Vendor } from "@/lib/accounts-payable";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";

/** The server's limit for a payee's default net terms. */
const MAX_TERMS_DAYS = 365;

export type NewVendorSheetHandle = {
  /** Closes the sheet, unless a save is in progress. */
  requestClose: () => void;
};

type NewVendorSheetProps = {
  organizationId: string;
  onClose: () => void;
  /** Receives the saved vendor. Only called while this sheet is still mounted. */
  onSaved: (vendor: Vendor) => void;
};

/**
 * Quick "New vendor" sheet opened from a vendor picker, such as the Enter bill
 * form. It creates a Vendor-type payee from the few details needed to keep
 * working; everything else is still edited under Lists.
 *
 * Rendered as an in-tree overlay rather than a <Modal>, the same choice
 * ReturnedCaseWizard documents: it opens from inside the bill's own native
 * modal, and stacking one native modal inside another is unreliable on iOS.
 * Mount it only while it is open, as the last child of the opening screen or
 * modal, so it covers that form and anything already typed there stays put.
 * An overlay never receives Android's back button, so while it is open the
 * opening modal's `onRequestClose` must call `requestClose` instead.
 */
export const NewVendorSheet = React.forwardRef<NewVendorSheetHandle, NewVendorSheetProps>(
  function NewVendorSheet({ organizationId, onClose, onSaved }, ref) {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const qc = useQueryClient();
    const [name, setName] = useState("");
    const [termsDays, setTermsDays] = useState("");
    const [phone, setPhone] = useState("");
    const [email, setEmail] = useState("");
    const [error, setError] = useState<string | null>(null);
    // The pending state reaches the buttons a render after the tap, so a fast
    // double tap needs this guard to avoid creating the vendor twice.
    const saving = useRef(false);

    const create = useMutation({
      mutationFn: (paymentTermsDays: number | null) =>
        sendJson<Vendor>("POST", "/api/finance/vendors", {
          organizationId,
          name: name.trim(),
          vendorType: "vendor",
          paymentTermsDays,
          phone: phone.trim() || null,
          email: email.trim() || null,
        }),
      // Refresh here rather than in `onSaved`: this also runs if the sheet
      // unmounts before the save finishes, and the vendor exists either way.
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["finance", "vendors", organizationId] });
        void qc.invalidateQueries({ queryKey: ["vendors", organizationId] });
      },
      onError: (err: Error) => setError(err.message || "Couldn't save this vendor."),
      onSettled: () => {
        saving.current = false;
      },
    });

    function submit() {
      if (saving.current || !name.trim()) return;
      const terms = termsDays === "" ? null : Number(termsDays);
      if (terms != null && terms > MAX_TERMS_DAYS) {
        setError(`Default terms can be at most ${MAX_TERMS_DAYS} days.`);
        return;
      }
      saving.current = true;
      setError(null);
      // Callbacks passed here only run while this sheet is mounted, so a save
      // that finishes after it unmounts never changes the caller's selection.
      create.mutate(terms, { onSuccess: onSaved });
    }

    // Closing is unavailable while saving, so Cancel never leaves behind a
    // vendor that the caller does not show. Every way out goes through here:
    // Cancel, the backdrop, and the opening modal's back button.
    function close() {
      if (!saving.current) onClose();
    }
    useImperativeHandle(ref, () => ({ requestClose: close }));

    const busy = create.isPending;
    const saveDisabled = busy || !name.trim();
    return (
      <View
        style={styles.overlay}
        accessibilityViewIsModal
        role="dialog"
        aria-modal
        aria-label="New vendor"
        testID="new-vendor-overlay"
      >
        <Pressable
          style={styles.backdrop}
          onPress={close}
          disabled={busy}
          accessibilityLabel="Close"
          testID="new-vendor-backdrop"
        />
        <KeyboardAvoidingView
          style={styles.kav}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          pointerEvents="box-none"
        >
          <DismissKeyboardView
            style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.md }]}
            testID="new-vendor-sheet"
          >
            <View style={styles.grabber} />
            <Text style={styles.title} accessibilityRole="header">
              New vendor
            </Text>
            <ScrollView
              style={styles.body}
              contentContainerStyle={styles.bodyContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={scrollKeyboardDismissMode}
            >
              <Text style={styles.hint}>Only the name is required. Edit other details later under Lists.</Text>
              {!!error && (
                <Text testID="new-vendor-error" accessibilityRole="alert" style={styles.error}>
                  {error}
                </Text>
              )}
              <TextField
                testID="new-vendor-name"
                label="Name"
                required
                value={name}
                onChangeText={setName}
                placeholder="Vendor name"
                maxLength={200}
                autoFocus
              />
              <TextField
                testID="new-vendor-terms"
                label="Default terms (days)"
                value={termsDays}
                onChangeText={(value) => setTermsDays(value.replace(/[^0-9]/g, ""))}
                keyboardType="number-pad"
                placeholder="e.g. 30"
                maxLength={3}
              />
              <TextField
                testID="new-vendor-phone"
                label="Phone"
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                placeholder="Optional"
                maxLength={50}
              />
              <TextField
                testID="new-vendor-email"
                label="Email"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                placeholder="Optional"
                maxLength={200}
              />
            </ScrollView>
            <View style={styles.footer}>
              <Pressable style={styles.cancelBtn} onPress={close} disabled={busy} testID="new-vendor-cancel">
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.saveBtn, saveDisabled && styles.saveBtnDisabled]}
                onPress={submit}
                disabled={saveDisabled}
                accessibilityRole="button"
                testID="new-vendor-save"
              >
                {busy ? (
                  <ActivityIndicator size="small" color={colors.textInverse} />
                ) : (
                  <Text style={styles.saveText}>Save vendor</Text>
                )}
              </Pressable>
            </View>
          </DismissKeyboardView>
        </KeyboardAvoidingView>
      </View>
    );
  },
);

// Sheet styling matches the shared FormSheet so both kinds of sheet look alike.
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, zIndex: 50 },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
    kav: { flex: 1, justifyContent: "flex-end" },
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
    hint: { ...Typography.caption, color: c.textSecondary },
    error: {
      ...Typography.caption,
      color: c.error,
      backgroundColor: c.errorSurface,
      padding: Spacing.sm,
      borderRadius: Radius.sm,
    },
    footer: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.md,
      paddingTop: Spacing.sm,
    },
    cancelBtn: { paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md },
    cancelText: { ...Typography.bodySemibold, color: c.textSecondary },
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
