import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell, SettingsSection } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";
import { ME_QUERY_KEY } from "@/lib/auth-me";

interface MeUser { id?: string }

export default function PasswordScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const meQuery = useQuery<{ user?: MeUser }>({
    queryKey: ME_QUERY_KEY,
    queryFn: async () => {
      const res = await resilientFetch("/api/auth/me");
      if (!res.ok) throw new Error("Could not load profile");
      return res.json();
    },
    staleTime: 60_000,
  });

  const userId = (meQuery.data?.user as MeUser | undefined)?.id;

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("Not signed in.");
      if (next.length < 8) throw new Error("New password must be at least 8 characters.");
      if (next !== confirm) throw new Error("New passwords do not match.");
      const res = await resilientFetch(`/api/auth/users/${userId}/password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setSaved(true);
      setCurrent(""); setNext(""); setConfirm("");
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (err: Error) => {
      Alert.alert("Could not update password", err.message);
    },
  });

  return (
    <ScreenShell title="Password" subtitle="Change your sign-in password" onBack={() => router.back()} insetTop={insets.top}>
      <ScrollView contentContainerStyle={styles.body}>
        {saved && (
          <View style={[styles.banner, { backgroundColor: colors.success + "20", borderColor: colors.success + "40" }]}>
            <Text style={[styles.bannerText, { color: colors.success }]}>Password updated.</Text>
          </View>
        )}

        <SettingsSection title="Change password">
          <View style={styles.fieldWrap}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Current password</Text>
            <TextInput
              value={current}
              onChangeText={setCurrent}
              secureTextEntry
              autoComplete="current-password"
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              placeholderTextColor={colors.textTertiary}
              placeholder="Current password"
            />
          </View>
          <View style={[styles.fieldWrap, styles.sep, { borderTopColor: colors.border }]}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>New password</Text>
            <TextInput
              value={next}
              onChangeText={setNext}
              secureTextEntry
              autoComplete="new-password"
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              placeholderTextColor={colors.textTertiary}
              placeholder="At least 8 characters"
            />
          </View>
          <View style={[styles.fieldWrap, styles.sep, { borderTopColor: colors.border }]}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Confirm new password</Text>
            <TextInput
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              autoComplete="new-password"
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              placeholderTextColor={colors.textTertiary}
              placeholder="Repeat new password"
            />
          </View>
        </SettingsSection>

        <Pressable
          style={[styles.btn, { backgroundColor: colors.tint }, (!current || !next || mutation.isPending) && { opacity: 0.5 }]}
          onPress={() => mutation.mutate()}
          disabled={!current || !next || mutation.isPending}
        >
          <Text style={styles.btnText}>{mutation.isPending ? "Updating…" : "Update password"}</Text>
        </Pressable>
      </ScrollView>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl },
    banner: { borderRadius: Radius.md, borderWidth: 1, padding: Spacing.md },
    bannerText: { ...Typography.bodyMedium, textAlign: "center" },
    fieldWrap: { padding: Spacing.lg, gap: Spacing.xs },
    sep: { borderTopWidth: StyleSheet.hairlineWidth },
    label: { ...Typography.captionSemibold },
    input: {
      borderWidth: 1,
      borderRadius: Radius.sm,
      padding: Spacing.md,
      ...Typography.body,
    },
    btn: { borderRadius: Radius.md, padding: Spacing.md, alignItems: "center" },
    btnText: { ...Typography.bodySemibold, color: "#fff" },
  });
}
