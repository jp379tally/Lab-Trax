import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router, usePathname } from "expo-router";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useVerifyAdminPin } from "@workspace/api-client-react";
import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";
import { useAuth } from "@/lib/auth-context";
import { useMe } from "@/lib/auth-me";
import {
  isAdminSettingsPath,
  setAdminSettingsPin,
  useAdminSettingsPin,
} from "@/lib/admin-settings-pin";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { useTheme } from "@/lib/theme-context";

export default function SettingsLayout() {
  const { colors } = useTheme();
  const pathname = usePathname();
  const requiresAdminPin = isAdminSettingsPath(pathname);
  return (
    <>
      {requiresAdminPin ? (
        <AdminSettingsPinGate>
          <SettingsStack />
        </AdminSettingsPinGate>
      ) : (
        <SettingsStack />
      )}
    </>
  );
}

function SettingsStack() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.backgroundSolid },
        animation: "slide_from_right",
      }}
    />
  );
}

function AdminSettingsPinGate({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const { currentUserId, isAuthenticated, isAuthLoading } = useAuth();
  const me = useMe();
  const user = me.data?.user as { role?: string } | undefined;
  const isAdmin = user?.role === "admin";
  const pinVerified = useAdminSettingsPin(currentUserId);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const requestInFlight = useRef(false);
  const verifyPin = useVerifyAdminPin();

  async function submitPin(candidate: string) {
    if (requestInFlight.current || !currentUserId) return;
    requestInFlight.current = true;
    setError("");
    try {
      await verifyPin.mutateAsync({ data: { pin: candidate } });
      setAdminSettingsPin(currentUserId, candidate);
      setPin("");
    } catch (err) {
      const status = (err as { status?: number })?.status;
      setError(
        status === 403
          ? "That PIN was not accepted. Check it and try again."
          : "Could not verify your PIN. Check your connection and try again.",
      );
      setPin("");
    } finally {
      requestInFlight.current = false;
    }
  }

  if (pinVerified) return <>{children}</>;

  const loading = isAuthLoading || (isAuthenticated && me.isLoading);
  const unavailable = !loading && (!isAuthenticated || !isAdmin);

  return (
    <DismissKeyboardView style={styles.screen} testID="admin-settings-pin-keyboard-dismiss">
      <KeyboardAvoidingView
        style={[styles.screen, { backgroundColor: colors.backgroundSolid }]}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.content}>
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text }]}>
              {loading ? "Checking access" : unavailable ? "Admin access required" : "Admin settings"}
            </Text>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
              {loading
                ? "Checking your account permissions…"
                : unavailable
                  ? "This settings area is only available to administrators."
                  : "Enter your four-digit admin PIN to continue."}
            </Text>
            {loading ? (
              <ActivityIndicator color={colors.tint} />
            ) : unavailable ? (
              <Pressable
                accessibilityRole="button"
                testID="admin-settings-back"
                style={[styles.backButton, { backgroundColor: colors.tint }]}
                onPress={() => router.replace("/account" as never)}
              >
                <Text style={styles.buttonText}>Back to account</Text>
              </Pressable>
            ) : (
              <>
                <TextInput
                  accessibilityLabel="Admin PIN"
                  testID="admin-settings-pin"
                  value={pin}
                  onChangeText={(value) => {
                    const next = value.replace(/\D/g, "").slice(0, 4);
                    setPin(next);
                    setError("");
                    if (next.length === 4) void submitPin(next);
                  }}
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={4}
                  autoFocus
                  editable={!verifyPin.isPending}
                  placeholder="••••"
                  placeholderTextColor={colors.textTertiary}
                  style={[
                    styles.input,
                    { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
                  ]}
                />
                {verifyPin.isPending && (
                  <View style={styles.pending} testID="admin-settings-pin-pending">
                    <ActivityIndicator size="small" color={colors.tint} />
                    <Text style={[styles.statusText, { color: colors.textSecondary }]}>Verifying PIN…</Text>
                  </View>
                )}
                {!!error && (
                  <Text style={[styles.error, { color: colors.error }]} testID="admin-settings-pin-error">
                    {error}
                  </Text>
                )}
                <Pressable
                  accessibilityRole="button"
                  testID="admin-settings-cancel"
                  onPress={() => router.replace("/account" as never)}
                >
                  <Text style={[styles.cancelText, { color: colors.textSecondary }]}>Cancel</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </DismissKeyboardView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flex: 1, justifyContent: "center", padding: Spacing.lg },
  card: {
    alignItems: "center",
    gap: Spacing.md,
    padding: Spacing.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.lg,
  },
  title: { ...Typography.h2, textAlign: "center" },
  subtitle: { ...Typography.body, textAlign: "center" },
  input: {
    width: 180,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    textAlign: "center",
    letterSpacing: 10,
    ...Typography.h2,
  },
  pending: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  statusText: { ...Typography.caption },
  error: { ...Typography.caption, textAlign: "center" },
  backButton: { borderRadius: Radius.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  buttonText: { ...Typography.bodyMedium, color: "#fff" },
  cancelText: { ...Typography.caption, padding: Spacing.sm },
});
