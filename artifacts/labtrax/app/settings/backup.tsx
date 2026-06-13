import React, { useState, useEffect, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Switch,
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
import { getPlatformAdminSessionHeaders } from "@/lib/platform-admin-session";

type BackupUnit = "minutes" | "hours";
type BackupDestination = "local" | "network";

interface BackupSchedule {
  enabled: boolean;
  interval: number | null;
  unit: BackupUnit | null;
  destination: BackupDestination | null;
  path: string | null;
  lastSuccessfulBackupAt: string | null;
  staleAfterDays: number;
}

interface RetentionSettings {
  retentionDays: number;
  maxRows: number;
}

interface BackupRun {
  id: string;
  status: string;
  startedAt: string;
  completedAt?: string | null;
  sizeBytes?: number | null;
  triggeredBy?: string | null;
}

type FrequencyOption = {
  label: string;
  interval: number;
  unit: BackupUnit;
};

const FREQUENCY_OPTIONS: FrequencyOption[] = [
  { label: "15 min",  interval: 15,  unit: "minutes" },
  { label: "30 min",  interval: 30,  unit: "minutes" },
  { label: "1 hour",  interval: 1,   unit: "hours" },
  { label: "2 hours", interval: 2,   unit: "hours" },
  { label: "4 hours", interval: 4,   unit: "hours" },
  { label: "8 hours", interval: 8,   unit: "hours" },
  { label: "Daily",   interval: 24,  unit: "hours" },
];

function matchFrequency(interval: number | null, unit: BackupUnit | null): number {
  if (interval === null || unit === null) return 6;
  const idx = FREQUENCY_OPTIONS.findIndex((o) => o.interval === interval && o.unit === unit);
  return idx >= 0 ? idx : 6;
}

function formatDate(s: string | null | undefined) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch { return s; }
}

function formatBytes(n: number | null | undefined) {
  if (!n) return "";
  if (n < 1024) return ` · ${n} B`;
  if (n < 1024 * 1024) return ` · ${(n / 1024).toFixed(1)} KB`;
  return ` · ${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function isBackupOverdue(schedule: Pick<BackupSchedule, "lastSuccessfulBackupAt" | "staleAfterDays">): boolean {
  const last = schedule.lastSuccessfulBackupAt;
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > schedule.staleAfterDays * 24 * 60 * 60 * 1000;
}

export default function BackupScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const scheduleQuery = useQuery<BackupSchedule>({
    queryKey: ["admin", "backup-schedule-v3"],
    queryFn: async () => {
      const adminHeaders = await getPlatformAdminSessionHeaders();
      const res = await resilientFetch("/api/admin/backup/schedule", { headers: adminHeaders });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json() as Promise<BackupSchedule>;
    },
    staleTime: 60_000,
  });

  const historyQuery = useQuery<BackupRun[]>({
    queryKey: ["admin", "backup-history"],
    queryFn: async () => {
      const res = await resilientFetch("/api/admin/backup/history");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      const runs = body?.runs;
      return Array.isArray(runs) ? runs : [];
    },
    staleTime: 30_000,
  });

  const retentionQuery = useQuery<RetentionSettings>({
    queryKey: ["admin", "backup-retention"],
    queryFn: async () => {
      const adminHeaders = await getPlatformAdminSessionHeaders();
      const res = await resilientFetch("/api/admin/backup/history-retention", { headers: adminHeaders });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json() as Promise<RetentionSettings>;
    },
    staleTime: 60_000,
  });

  const schedule = scheduleQuery.data;
  const retention = retentionQuery.data;
  const overdue = scheduleQuery.isSuccess && schedule && isBackupOverdue(schedule);

  const [enabled, setEnabled] = useState(true);
  const [freqIdx, setFreqIdx] = useState(6);
  const [staleAfterDays, setStaleAfterDays] = useState("7");
  const [retentionDays, setRetentionDays] = useState("90");
  const [maxRows, setMaxRows] = useState("500");

  useEffect(() => {
    if (schedule) {
      setEnabled(schedule.enabled);
      setFreqIdx(matchFrequency(schedule.interval, schedule.unit));
      setStaleAfterDays(String(schedule.staleAfterDays ?? 7));
    }
  }, [schedule]);

  useEffect(() => {
    if (retention) {
      setRetentionDays(String(retention.retentionDays ?? 90));
      setMaxRows(String(retention.maxRows ?? 500));
    }
  }, [retention]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const adminHeaders = await getPlatformAdminSessionHeaders();
      const freq = FREQUENCY_OPTIONS[freqIdx];
      const staleDays = parseInt(staleAfterDays, 10);
      const res = await resilientFetch("/api/admin/backup/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify({
          interval: freq.interval,
          unit: freq.unit,
          destination: schedule?.destination ?? "local",
          path: schedule?.path ?? "/tmp/backups",
          enabled,
          staleAfterDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : 7,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "backup-schedule-v3"] }),
    onError: (err: Error) => Alert.alert("Could not save schedule", err.message),
  });

  const runMutation = useMutation({
    mutationFn: async () => {
      const adminHeaders = await getPlatformAdminSessionHeaders();
      const res = await resilientFetch("/api/admin/backup/schedule/run-now", {
        method: "POST",
        headers: adminHeaders,
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      Alert.alert("Backup complete", "The scheduled backup ran successfully.");
      qc.invalidateQueries({ queryKey: ["admin", "backup-history"] });
      qc.invalidateQueries({ queryKey: ["admin", "backup-schedule-v3"] });
    },
    onError: (err: Error) => Alert.alert("Backup failed", err.message),
  });

  const saveRetentionMutation = useMutation({
    mutationFn: async () => {
      const adminHeaders = await getPlatformAdminSessionHeaders();
      const days = parseInt(retentionDays, 10);
      const rows = parseInt(maxRows, 10);
      const res = await resilientFetch("/api/admin/backup/history-retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify({
          ...(Number.isFinite(days) && days > 0 ? { retentionDays: days } : {}),
          ...(Number.isFinite(rows) && rows > 0 ? { maxRows: rows } : {}),
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      Alert.alert("Saved", "History retention settings updated.");
      qc.invalidateQueries({ queryKey: ["admin", "backup-retention"] });
    },
    onError: (err: Error) => Alert.alert("Could not save", err.message),
  });

  function statusColor(s: string) {
    if (s === "success") return "#10B981";
    if (s === "failure") return colors.error;
    return colors.warning;
  }

  return (
    <ScreenShell title="Backup" subtitle="Data backup and restore" onBack={() => router.back()} insetTop={insets.top}>
      <ScrollView contentContainerStyle={styles.body}>
        {scheduleQuery.isLoading && <ActivityIndicator color={colors.tint} />}

        {overdue && (
          <View style={[styles.overdueCard, { backgroundColor: colors.warning + "15", borderColor: colors.warning + "40" }]}>
            <Ionicons name="warning" size={18} color={colors.warning} />
            <View style={styles.flex1}>
              <Text style={[styles.overdueTitle, { color: colors.warning }]}>Backup overdue</Text>
              <Text style={[styles.overdueSub, { color: colors.warning }]}>
                Last successful: {formatDate(schedule?.lastSuccessfulBackupAt)}
              </Text>
            </View>
          </View>
        )}

        <SettingsSection title="Status">
          <View style={styles.statusRow}>
            <View style={styles.flex1}>
              <Text style={[styles.statusTitle, { color: colors.text }]}>Last successful backup</Text>
              <Text style={[styles.statusVal, { color: colors.textSecondary }]}>
                {formatDate(schedule?.lastSuccessfulBackupAt)}
              </Text>
            </View>
            <Pressable
              style={[styles.runBtn, { backgroundColor: colors.tint }, runMutation.isPending && styles.disabled]}
              onPress={() => runMutation.mutate()}
              disabled={runMutation.isPending}
            >
              {runMutation.isPending
                ? <ActivityIndicator size="small" color="#fff" />
                : <>
                    <Ionicons name="cloud-upload-outline" size={15} color="#fff" />
                    <Text style={styles.runBtnText}>Back up now</Text>
                  </>
              }
            </Pressable>
          </View>
        </SettingsSection>

        {schedule?.destination && (
          <SettingsSection title="Storage">
            <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.infoLabel, { color: colors.textSecondary }]}>Destination</Text>
              <Text style={[styles.infoVal, { color: colors.text }]}>{schedule.destination}</Text>
            </View>
            {schedule.path && (
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: colors.textSecondary }]}>Path</Text>
                <Text style={[styles.infoVal, { color: colors.text }]} numberOfLines={1}>{schedule.path}</Text>
              </View>
            )}
          </SettingsSection>
        )}

        <SettingsSection title="Schedule">
          <View style={styles.toggleRow}>
            <Text style={[styles.toggleLabel, { color: colors.text }]}>Automatic backups</Text>
            <Switch
              value={enabled}
              onValueChange={setEnabled}
              trackColor={{ false: colors.border, true: colors.tint }}
              thumbColor="#fff"
            />
          </View>

          {enabled && (
            <>
              <View style={[styles.freqSection, { borderTopColor: colors.border }]}>
                <Text style={[styles.freqTitle, { color: colors.textSecondary }]}>Frequency</Text>
                <View style={styles.chipRow}>
                  {FREQUENCY_OPTIONS.map((opt, idx) => (
                    <Pressable
                      key={opt.label}
                      style={[
                        styles.chip,
                        {
                          backgroundColor: freqIdx === idx ? colors.tint : colors.surfaceAlt,
                          borderColor: freqIdx === idx ? colors.tint : colors.border,
                        },
                      ]}
                      onPress={() => setFreqIdx(idx)}
                    >
                      <Text style={[styles.chipText, { color: freqIdx === idx ? "#fff" : colors.textSecondary }]}>
                        {opt.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View style={[styles.fieldRow, { borderTopColor: colors.border }]}>
                <View style={styles.flex1}>
                  <Text style={[styles.fieldLabel, { color: colors.text }]}>Overdue alert after</Text>
                  <Text style={[styles.fieldSub, { color: colors.textTertiary }]}>
                    Show warning when no backup for this many days
                  </Text>
                </View>
                <View style={styles.dayInputWrap}>
                  <TextInput
                    value={staleAfterDays}
                    onChangeText={setStaleAfterDays}
                    keyboardType="number-pad"
                    style={[styles.dayInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  />
                  <Text style={[styles.dayUnit, { color: colors.textSecondary }]}>days</Text>
                </View>
              </View>
            </>
          )}
        </SettingsSection>

        <Pressable
          style={[styles.saveBtn, { backgroundColor: colors.tint }, saveMutation.isPending && styles.disabled]}
          onPress={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          <Text style={styles.saveBtnText}>{saveMutation.isPending ? "Saving…" : "Save schedule"}</Text>
        </Pressable>

        <SettingsSection title="History retention">
          <View style={[styles.fieldRow, { borderTopColor: colors.border }]}>
            <View style={styles.flex1}>
              <Text style={[styles.fieldLabel, { color: colors.text }]}>Keep history for</Text>
              <Text style={[styles.fieldSub, { color: colors.textTertiary }]}>Days of backup run history to retain</Text>
            </View>
            <View style={styles.dayInputWrap}>
              <TextInput
                value={retentionDays}
                onChangeText={setRetentionDays}
                keyboardType="number-pad"
                style={[styles.dayInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              />
              <Text style={[styles.dayUnit, { color: colors.textSecondary }]}>days</Text>
            </View>
          </View>

          <View style={[styles.fieldRow, { borderTopColor: colors.border }]}>
            <View style={styles.flex1}>
              <Text style={[styles.fieldLabel, { color: colors.text }]}>Max history rows</Text>
              <Text style={[styles.fieldSub, { color: colors.textTertiary }]}>Maximum number of run records to keep</Text>
            </View>
            <View style={styles.dayInputWrap}>
              <TextInput
                value={maxRows}
                onChangeText={setMaxRows}
                keyboardType="number-pad"
                style={[styles.dayInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface, width: 68 }]}
              />
              <Text style={[styles.dayUnit, { color: colors.textSecondary }]}>rows</Text>
            </View>
          </View>
        </SettingsSection>

        <Pressable
          style={[styles.saveBtn, { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }, saveRetentionMutation.isPending && styles.disabled]}
          onPress={() => saveRetentionMutation.mutate()}
          disabled={saveRetentionMutation.isPending}
        >
          <Text style={[styles.saveBtnText, { color: colors.text }]}>
            {saveRetentionMutation.isPending ? "Saving…" : "Save retention"}
          </Text>
        </Pressable>

        {(historyQuery.data ?? []).length > 0 && (
          <SettingsSection title={`Recent backups (${historyQuery.data!.length})`}>
            {historyQuery.data!.slice(0, 10).map((run) => (
              <View key={run.id} style={[styles.historyRow, { borderBottomColor: colors.border }]}>
                <View style={[styles.historyDot, { backgroundColor: statusColor(run.status) }]} />
                <View style={styles.flex1}>
                  <Text style={[styles.historyDate, { color: colors.text }]}>{formatDate(run.startedAt)}</Text>
                  <Text style={[styles.historyMeta, { color: colors.textSecondary }]}>
                    {run.status}{formatBytes(run.sizeBytes)}
                    {run.triggeredBy ? ` · ${run.triggeredBy}` : ""}
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
    flex1: { flex: 1 },
    disabled: { opacity: 0.6 },
    overdueCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: 1,
      padding: Spacing.lg,
    },
    overdueTitle: { ...Typography.bodyMedium },
    overdueSub: { ...Typography.caption, marginTop: 2 },
    statusRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: Spacing.lg,
      gap: Spacing.md,
    },
    statusTitle: { ...Typography.bodyMedium },
    statusVal: { ...Typography.caption, marginTop: 2 },
    runBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    runBtnText: { ...Typography.captionMedium, color: "#fff" },
    infoRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    infoLabel: { ...Typography.captionMedium },
    infoVal: { ...Typography.body },
    toggleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
    },
    toggleLabel: { ...Typography.bodyMedium },
    freqSection: { borderTopWidth: StyleSheet.hairlineWidth, padding: Spacing.lg, gap: Spacing.md },
    freqTitle: { ...Typography.captionMedium },
    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
    chip: {
      borderRadius: Radius.full,
      borderWidth: 1,
      paddingHorizontal: Spacing.md,
      paddingVertical: 5,
    },
    chipText: { ...Typography.captionMedium },
    fieldRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    fieldLabel: { ...Typography.bodyMedium },
    fieldSub: { ...Typography.caption, marginTop: 2 },
    dayInputWrap: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    dayInput: {
      width: 52,
      borderWidth: 1,
      borderRadius: Radius.sm,
      padding: Spacing.sm,
      ...Typography.bodyMedium,
      textAlign: "center",
    },
    dayUnit: { ...Typography.caption },
    saveBtn: { borderRadius: Radius.md, padding: Spacing.md, alignItems: "center" },
    saveBtnText: { ...Typography.bodySemibold, color: "#fff" },
    historyRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: Spacing.md,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    historyDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, flexShrink: 0 },
    historyDate: { ...Typography.bodyMedium },
    historyMeta: { ...Typography.caption, marginTop: 2 },
  });
}
