import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  TextInput,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell, SettingsSection } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";

type Platform = "ios" | "android";
type Profile = "production" | "preview" | "development";

interface VersionHistoryEntry {
  version: string;
  changedByUsername: string;
  changedAt: string;
}

interface LastTrigger {
  platform: string;
  profile: string;
  triggeredAt: string;
  triggeredByUsername: string;
}

interface MobileBuildInfo {
  expoVersion?: string | null;
  iosBuildNumber?: string | null;
  androidVersionCode?: number | null;
  appJsonError?: string | null;
  repoUrl?: string | null;
  tokenConfigured?: boolean;
  versionHistory?: VersionHistoryEntry[];
  lastTrigger?: LastTrigger | null;
}

function formatDate(s: string | null | undefined) {
  if (!s) return "—";
  try { return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return s; }
}

export default function MobileAppScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const [platform, setPlatform] = useState<Platform>("ios");
  const [profile, setProfile] = useState<Profile>("production");
  const [editingVersion, setEditingVersion] = useState(false);
  const [versionDraft, setVersionDraft] = useState("");

  const infoQuery = useQuery<MobileBuildInfo>({
    queryKey: ["admin", "mobile-build-info"],
    queryFn: async () => {
      const res = await resilientFetch("/api/admin/mobile-build/info");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      return (body?.data ?? body) as MobileBuildInfo;
    },
    staleTime: 30_000,
  });

  const triggerMutation = useMutation({
    mutationFn: async () => {
      const res = await resilientFetch("/api/admin/mobile-build/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, profile }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      Alert.alert("Build triggered", `EAS build started for ${platform} (${profile}).`);
      qc.invalidateQueries({ queryKey: ["admin", "mobile-build-info"] });
    },
    onError: (err: Error) => Alert.alert("Build failed to trigger", err.message),
  });

  const versionMutation = useMutation({
    mutationFn: async (version: string) => {
      const res = await resilientFetch("/api/admin/mobile-build/app-version", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setEditingVersion(false);
      qc.invalidateQueries({ queryKey: ["admin", "mobile-build-info"] });
    },
    onError: (err: Error) => Alert.alert("Could not update version", err.message),
  });

  function confirmTrigger() {
    Alert.alert(
      "Trigger EAS build",
      `Build LabTrax for ${platform.toUpperCase()} using the ${profile} profile?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Build", onPress: () => triggerMutation.mutate() },
      ],
    );
  }

  const info = infoQuery.data;
  const versionHistory = info?.versionHistory ?? [];

  return (
    <ScreenShell title="Mobile App" subtitle="EAS builds and app version" onBack={() => router.back()} insetTop={insets.top}>
      <ScrollView contentContainerStyle={styles.body}>
        {infoQuery.isLoading && <ActivityIndicator color={colors.tint} />}

        <SettingsSection title="Version">
          <View style={styles.versionRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.versionLabel, { color: colors.textSecondary }]}>Expo version</Text>
              {editingVersion ? (
                <TextInput
                  value={versionDraft}
                  onChangeText={setVersionDraft}
                  style={[styles.versionInput, { color: colors.text, borderColor: colors.border }]}
                  autoFocus
                  placeholder="e.g. 1.2.3"
                  placeholderTextColor={colors.textTertiary}
                />
              ) : (
                <Text style={[styles.versionValue, { color: colors.text }]}>
                  {info?.expoVersion || "—"}
                </Text>
              )}
            </View>
            {editingVersion ? (
              <View style={styles.versionActions}>
                <Pressable
                  style={[styles.smallBtn, { backgroundColor: colors.tint }]}
                  onPress={() => versionMutation.mutate(versionDraft)}
                  disabled={!versionDraft.trim() || versionMutation.isPending}
                >
                  <Text style={[styles.smallBtnText, { color: "#fff" }]}>Save</Text>
                </Pressable>
                <Pressable
                  style={[styles.smallBtn, { borderColor: colors.border, borderWidth: 1 }]}
                  onPress={() => setEditingVersion(false)}
                >
                  <Text style={[styles.smallBtnText, { color: colors.textSecondary }]}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                style={[styles.editBtn, { borderColor: colors.border }]}
                onPress={() => {
                  setVersionDraft(info?.expoVersion ?? "");
                  setEditingVersion(true);
                }}
              >
                <Ionicons name="pencil-outline" size={14} color={colors.textSecondary} />
                <Text style={[styles.editBtnText, { color: colors.textSecondary }]}>Edit</Text>
              </Pressable>
            )}
          </View>

          {(info?.iosBuildNumber != null || info?.androidVersionCode != null) && (
            <View style={[styles.buildNumberRow, { borderTopColor: colors.border }]}>
              {info?.iosBuildNumber != null && (
                <View style={styles.buildNumberItem}>
                  <Ionicons name="logo-apple" size={13} color={colors.textSecondary} />
                  <Text style={[styles.buildNumberText, { color: colors.textSecondary }]}>
                    Build {info.iosBuildNumber}
                  </Text>
                </View>
              )}
              {info?.androidVersionCode != null && (
                <View style={styles.buildNumberItem}>
                  <Ionicons name="logo-android" size={13} color={colors.textSecondary} />
                  <Text style={[styles.buildNumberText, { color: colors.textSecondary }]}>
                    Code {info.androidVersionCode}
                  </Text>
                </View>
              )}
            </View>
          )}

          {info?.appJsonError && (
            <View style={[styles.errorRow, { borderTopColor: colors.border }]}>
              <Text style={[styles.errorRowText, { color: colors.error }]}>
                Could not read app.json: {info.appJsonError}
              </Text>
            </View>
          )}
        </SettingsSection>

        {info?.lastTrigger && (
          <SettingsSection title="Last build triggered">
            <View style={styles.lastTriggerWrap}>
              <View style={styles.lastTriggerRow}>
                <Ionicons name="hammer-outline" size={14} color={colors.textSecondary} />
                <Text style={[styles.lastTriggerText, { color: colors.text }]}>
                  {info.lastTrigger.platform.toUpperCase()} · {info.lastTrigger.profile}
                </Text>
              </View>
              <Text style={[styles.lastTriggerMeta, { color: colors.textSecondary }]}>
                By {info.lastTrigger.triggeredByUsername} on {formatDate(info.lastTrigger.triggeredAt)}
              </Text>
            </View>
          </SettingsSection>
        )}

        <SettingsSection title="Trigger build" footer="EAS must be configured and the server must have access to trigger builds.">
          <View style={styles.pickerWrap}>
            <Text style={[styles.pickerLabel, { color: colors.textSecondary }]}>Platform</Text>
            <View style={styles.segment}>
              {(["ios", "android"] as Platform[]).map((p) => (
                <Pressable
                  key={p}
                  style={[styles.segBtn, platform === p && { backgroundColor: colors.tint }]}
                  onPress={() => setPlatform(p)}
                >
                  <Ionicons
                    name={p === "ios" ? "logo-apple" : "logo-android"}
                    size={14}
                    color={platform === p ? "#fff" : colors.textSecondary}
                  />
                  <Text style={[styles.segBtnText, { color: platform === p ? "#fff" : colors.textSecondary }]}>
                    {p.toUpperCase()}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={[styles.pickerWrap, styles.sep, { borderTopColor: colors.border }]}>
            <Text style={[styles.pickerLabel, { color: colors.textSecondary }]}>Profile</Text>
            <View style={styles.segment}>
              {(["production", "preview", "development"] as Profile[]).map((p) => (
                <Pressable
                  key={p}
                  style={[styles.segBtn, profile === p && { backgroundColor: colors.tint }]}
                  onPress={() => setProfile(p)}
                >
                  <Text style={[styles.segBtnText, { color: profile === p ? "#fff" : colors.textSecondary }]}>
                    {p}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={[styles.triggerWrap, styles.sep, { borderTopColor: colors.border }]}>
            <Pressable
              style={[styles.triggerBtn, { backgroundColor: colors.tint }, triggerMutation.isPending && { opacity: 0.6 }]}
              onPress={confirmTrigger}
              disabled={triggerMutation.isPending}
            >
              <Ionicons name="hammer-outline" size={16} color="#fff" />
              <Text style={styles.triggerBtnText}>
                {triggerMutation.isPending ? "Triggering…" : `Build for ${platform.toUpperCase()}`}
              </Text>
            </Pressable>
          </View>
        </SettingsSection>

        {versionHistory.length > 0 && (
          <SettingsSection title={`Version history (${versionHistory.length})`}>
            {versionHistory.slice(0, 10).map((entry, idx) => (
              <View key={`${entry.version}-${idx}`} style={[styles.historyRow, idx > 0 && styles.sep, idx > 0 && { borderTopColor: colors.border }]}>
                <View style={[styles.historyDot, { backgroundColor: colors.tint }]} />
                <View style={styles.historyInfo}>
                  <Text style={[styles.historyTitle, { color: colors.text }]}>
                    v{entry.version}
                  </Text>
                  <Text style={[styles.historyMeta, { color: colors.textSecondary }]}>
                    {entry.changedByUsername} · {formatDate(entry.changedAt)}
                  </Text>
                </View>
              </View>
            ))}
          </SettingsSection>
        )}
      </ScrollView>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl },
    versionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: Spacing.lg,
    },
    versionLabel: { ...Typography.caption },
    versionValue: { ...Typography.h3, marginTop: 2 },
    versionInput: {
      ...Typography.h3,
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      marginTop: 2,
      minWidth: 100,
    },
    versionActions: { flexDirection: "row", gap: Spacing.sm },
    smallBtn: { borderRadius: Radius.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs },
    smallBtnText: { ...Typography.captionMedium },
    editBtn: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs },
    editBtnText: { ...Typography.captionMedium },
    buildNumberRow: {
      flexDirection: "row",
      gap: Spacing.xl,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    buildNumberItem: { flexDirection: "row", alignItems: "center", gap: 4 },
    buildNumberText: { ...Typography.caption },
    errorRow: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    errorRowText: { ...Typography.caption },
    lastTriggerWrap: { padding: Spacing.lg, gap: 4 },
    lastTriggerRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    lastTriggerText: { ...Typography.bodyMedium },
    lastTriggerMeta: { ...Typography.caption },
    pickerWrap: { padding: Spacing.lg, gap: Spacing.sm },
    pickerLabel: { ...Typography.captionSemibold },
    segment: { flexDirection: "row", gap: Spacing.xs },
    segBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.sm,
      backgroundColor: "transparent",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: "transparent",
    },
    segBtnText: { ...Typography.captionMedium },
    sep: { borderTopWidth: StyleSheet.hairlineWidth },
    triggerWrap: { padding: Spacing.lg },
    triggerBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      borderRadius: Radius.md,
      paddingVertical: Spacing.md,
    },
    triggerBtnText: { ...Typography.bodySemibold, color: "#fff" },
    historyRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.md,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
    },
    historyDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, flexShrink: 0 },
    historyInfo: { flex: 1 },
    historyTitle: { ...Typography.bodyMedium },
    historyMeta: { ...Typography.caption, marginTop: 2 },
  });
}
