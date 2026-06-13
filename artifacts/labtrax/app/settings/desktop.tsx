import React, { useMemo, useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Linking,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell, SettingsSection, SettingsRow } from "@/components/settings/SettingsRow";
import { resilientFetch, getApiUrl } from "@/lib/query-client";
import { ME_QUERY_KEY } from "@/lib/auth-me";

interface InstallerInfo {
  version?: string;
  downloadUrl?: string;
  fileName?: string | null;
  releaseNotes?: string | null;
  available?: boolean;
}

interface AdminInstallerInfo {
  version?: string;
  downloadUrl?: string;
  fileName?: string | null;
  releaseNotes?: string | null;
  installerStatus?: string | null;
  installerStatusMessage?: string | null;
  installerSlots?: Record<string, { available: boolean; size: number | null; uploadedAt: string | null; error: string | null }>;
  buildCounterWarning?: string | null;
}

type UpdatePhase = "idle" | "checking" | "available" | "up_to_date" | "error";

function formatDate(s: string | null | undefined) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch { return s; }
}

function formatBytes(n: number | null | undefined) {
  if (!n) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function semverGt(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [a1 = 0, a2 = 0, a3 = 0] = parse(a);
  const [b1 = 0, b2 = 0, b3 = 0] = parse(b);
  return a1 > b1 || (a1 === b1 && a2 > b2) || (a1 === b1 && a2 === b2 && a3 > b3);
}

export default function DesktopAppScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>("idle");
  const [latestInfo, setLatestInfo] = useState<InstallerInfo | null>(null);

  const [adminPin, setAdminPin] = useState("");
  const [pinUnlocked, setPinUnlocked] = useState(false);
  const [editVersion, setEditVersion] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [versionSaved, setVersionSaved] = useState(false);

  const meQuery = useQuery<{ user?: { role?: string } }>({
    queryKey: ME_QUERY_KEY,
    queryFn: async () => {
      const res = await resilientFetch("/api/auth/me");
      if (!res.ok) throw new Error("Could not load user");
      return res.json();
    },
    staleTime: 60_000,
  });
  const isAdmin = meQuery.data?.user?.role === "admin";

  const query = useQuery<InstallerInfo>({
    queryKey: ["desktop-installer-info"],
    queryFn: async () => {
      const res = await resilientFetch("/api/desktop-installer");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      return body as InstallerInfo;
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const adminQuery = useQuery<AdminInstallerInfo>({
    queryKey: ["admin-desktop-installer", adminPin],
    queryFn: async () => {
      const res = await resilientFetch("/api/admin/settings/desktop-installer", {
        headers: { "X-Platform-Admin-Pin": adminPin },
      });
      if (res.status === 403) throw new Error("Incorrect PIN or insufficient permissions.");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      return body as AdminInstallerInfo;
    },
    enabled: pinUnlocked && !!adminPin,
    staleTime: 30_000,
    retry: false,
  });

  const saveVersionMutation = useMutation({
    mutationFn: async () => {
      const res = await resilientFetch("/api/admin/settings/desktop-installer", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Platform-Admin-Pin": adminPin,
        },
        body: JSON.stringify({ downloadUrl: editUrl, version: editVersion, releaseNotes: editNotes }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setVersionSaved(true);
      qc.invalidateQueries({ queryKey: ["admin-desktop-installer"] });
      qc.invalidateQueries({ queryKey: ["desktop-installer-info"] });
      setTimeout(() => setVersionSaved(false), 2500);
    },
    onError: (err: Error) => Alert.alert("Could not save", err.message),
  });

  function handleUnlockPin() {
    if (adminPin.length < 2) {
      Alert.alert("PIN required", "Enter your platform admin PIN.");
      return;
    }
    setPinUnlocked(true);
  }

  // Auto-check on mount once the current installer info is loaded.
  useEffect(() => {
    if (query.isSuccess && updatePhase === "idle") {
      checkForUpdates();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.isSuccess]);

  const info = latestInfo ?? query.data;
  const statusOk = info?.available !== false;
  const statusColor = statusOk ? colors.success : colors.warning;

  async function handleDownload() {
    const url = info?.downloadUrl;
    if (!url) return;
    const base = getApiUrl().replace(/\/api\/?$/, "");
    const full = url.startsWith("http") ? url : `${base}${url}`;
    await Linking.openURL(full).catch(() => {});
  }

  const checkForUpdates = useCallback(async () => {
    setUpdatePhase("checking");
    try {
      const res = await resilientFetch("/api/desktop-installer");
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      const fresh: InstallerInfo = body;
      setLatestInfo(fresh);

      const currentVer = info?.version ?? "0.0.0";
      const newVer = fresh.version ?? "0.0.0";
      if (semverGt(newVer, currentVer)) {
        setUpdatePhase("available");
      } else {
        setUpdatePhase("up_to_date");
      }
    } catch {
      setUpdatePhase("error");
    }
  }, [info?.version]);

  const updateState = (() => {
    switch (updatePhase) {
      case "checking":
        return { icon: "sync-outline" as const, color: colors.tint, label: "Checking for updates…" };
      case "available":
        return { icon: "cloud-download-outline" as const, color: colors.success, label: `Update available — v${latestInfo?.version ?? "?"}` };
      case "up_to_date":
        return { icon: "checkmark-circle-outline" as const, color: colors.success, label: "LabTrax Desktop is up to date." };
      case "error":
        return { icon: "alert-circle-outline" as const, color: colors.error, label: "Could not check for updates." };
      default:
        return null;
    }
  })();

  const adminInfo = adminQuery.data;
  const adminStatusOk = !adminInfo?.installerStatus || adminInfo.installerStatus === "ok" || adminInfo.installerStatus === "external";

  return (
    <ScreenShell
      title="Desktop App"
      subtitle="LabTrax for Windows and macOS"
      onBack={() => router.back()}
      insetTop={insets.top}
    >
      <ScrollView contentContainerStyle={styles.body}>
        {query.isLoading && <ActivityIndicator color={colors.tint} />}
        {query.error && !query.isLoading && (
          <Text style={[styles.errorText, { color: colors.error }]}>
            Could not load installer info.
          </Text>
        )}

        {!query.isLoading && info && (
          <>
            {/* Installer card */}
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.cardHeader}>
                <View style={[styles.iconWrap, { backgroundColor: colors.tint + "1A" }]}>
                  <Ionicons name="desktop-outline" size={22} color={colors.tint} />
                </View>
                <View style={styles.cardInfo}>
                  <Text style={[styles.appTitle, { color: colors.text }]}>LabTrax Desktop</Text>
                  <Text style={[styles.version, { color: colors.textSecondary }]}>
                    Current version: {info.version || "—"}
                  </Text>
                </View>
                <View style={[styles.statusPill, { backgroundColor: statusColor + "20" }]}>
                  <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                  <Text style={[styles.statusText, { color: statusColor }]}>
                    {statusOk ? "Available" : "Unavailable"}
                  </Text>
                </View>
              </View>

              {info.releaseNotes && (
                <Text style={[styles.statusMsg, { color: colors.textSecondary }]}>
                  {info.releaseNotes}
                </Text>
              )}

              {/* Update-state card */}
              {updateState && (
                <View
                  style={[
                    styles.updateState,
                    {
                      backgroundColor: updateState.color + "15",
                      borderColor: updateState.color + "40",
                    },
                  ]}
                >
                  {updatePhase === "checking" ? (
                    <ActivityIndicator size={16} color={updateState.color} />
                  ) : (
                    <Ionicons name={updateState.icon} size={16} color={updateState.color} />
                  )}
                  <Text style={[styles.updateStateText, { color: updateState.color }]}>
                    {updateState.label}
                  </Text>
                </View>
              )}

              <View style={styles.actionRow}>
                {/* Check for updates */}
                <Pressable
                  style={[
                    styles.checkBtn,
                    { borderColor: colors.border, backgroundColor: colors.surfaceAlt },
                    updatePhase === "checking" && { opacity: 0.6 },
                  ]}
                  onPress={checkForUpdates}
                  disabled={updatePhase === "checking"}
                >
                  <Ionicons name="refresh-outline" size={15} color={colors.textSecondary} />
                  <Text style={[styles.checkBtnText, { color: colors.textSecondary }]}>
                    Check for updates
                  </Text>
                </Pressable>

                {/* Download button */}
                {info.downloadUrl && (
                  <Pressable
                    style={[
                      styles.downloadBtn,
                      {
                        backgroundColor:
                          updatePhase === "available" ? colors.success : colors.tint,
                      },
                    ]}
                    onPress={handleDownload}
                  >
                    <Ionicons name="download-outline" size={15} color="#fff" />
                    <Text style={styles.downloadBtnText}>
                      {updatePhase === "available" ? "Download update" : "Download"}
                    </Text>
                  </Pressable>
                )}
              </View>
            </View>

            <SettingsSection footer="Download LabTrax Desktop to use full case management on your Windows or macOS computer.">
              <SettingsRow
                icon="information-circle-outline"
                title="About Desktop App"
                subtitle="The desktop app connects to this API server. Configure iTero auto-import and local settings from within the desktop app."
                showChevron={false}
              />
            </SettingsSection>
          </>
        )}

        {/* Administration — admin only */}
        {isAdmin && (
          <SettingsSection title="Administration" footer="Manage the installer pipeline and version settings. Requires platform admin PIN.">
            {!pinUnlocked ? (
              <View style={styles.pinSection}>
                <Text style={[styles.pinLabel, { color: colors.textSecondary }]}>
                  Enter your platform admin PIN to access installer management:
                </Text>
                <View style={styles.pinRow}>
                  <TextInput
                    value={adminPin}
                    onChangeText={setAdminPin}
                    placeholder="PIN"
                    keyboardType="number-pad"
                    secureTextEntry
                    style={[styles.pinInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                    placeholderTextColor={colors.textTertiary}
                  />
                  <Pressable
                    style={[styles.pinUnlockBtn, { backgroundColor: colors.tint }]}
                    onPress={handleUnlockPin}
                  >
                    <Ionicons name="lock-open-outline" size={15} color="#fff" />
                    <Text style={styles.pinUnlockText}>Unlock</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <>
                {adminQuery.isLoading && <ActivityIndicator color={colors.tint} style={{ margin: Spacing.lg }} />}
                {adminQuery.error && (
                  <View style={[styles.adminError, { backgroundColor: colors.error + "15" }]}>
                    <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
                    <Text style={[styles.adminErrorText, { color: colors.error }]}>
                      {(adminQuery.error as Error)?.message ?? "Failed to load admin info."}
                    </Text>
                    <Pressable onPress={() => setPinUnlocked(false)} hitSlop={8}>
                      <Text style={[styles.pinResetText, { color: colors.tint }]}>Reset PIN</Text>
                    </Pressable>
                  </View>
                )}

                {adminInfo && (
                  <>
                    {/* Status overview */}
                    {adminInfo.buildCounterWarning && (
                      <View style={[styles.warnBanner, { backgroundColor: colors.warning + "18", borderColor: colors.warning + "40" }]}>
                        <Ionicons name="warning-outline" size={15} color={colors.warning} />
                        <Text style={[styles.warnText, { color: colors.warning }]}>{adminInfo.buildCounterWarning}</Text>
                      </View>
                    )}

                    {/* Per-platform slot status */}
                    {adminInfo.installerSlots && (
                      <View style={[styles.slotsCard, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
                        <Text style={[styles.slotCardTitle, { color: colors.textSecondary }]}>Installer slots</Text>
                        {(["zip", "exe", "dmg"] as const).map((kind) => {
                          const slot = adminInfo.installerSlots?.[kind];
                          if (!slot) return null;
                          const kindLabel = kind === "zip" ? "Windows Portable (.zip)" : kind === "exe" ? "Windows Setup (.exe)" : "macOS (.dmg)";
                          return (
                            <View key={kind} style={[styles.slotRow, { borderTopColor: colors.border }]}>
                              <Ionicons
                                name={slot.available ? "checkmark-circle-outline" : "ellipse-outline"}
                                size={14}
                                color={slot.available ? colors.success : colors.textTertiary}
                              />
                              <View style={{ flex: 1 }}>
                                <Text style={[styles.slotLabel, { color: colors.text }]}>{kindLabel}</Text>
                                {slot.available && (
                                  <Text style={[styles.slotMeta, { color: colors.textTertiary }]}>
                                    {formatBytes(slot.size)} · {formatDate(slot.uploadedAt)}
                                  </Text>
                                )}
                              </View>
                              <Text style={[styles.slotStatus, { color: slot.available ? colors.success : colors.textTertiary }]}>
                                {slot.available ? "Ready" : "Not uploaded"}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    )}

                    {/* Overall status */}
                    {adminInfo.installerStatus && (
                      <View style={[styles.statusCard, { backgroundColor: (adminStatusOk ? colors.success : colors.warning) + "15", borderColor: (adminStatusOk ? colors.success : colors.warning) + "40" }]}>
                        <Ionicons
                          name={adminStatusOk ? "checkmark-circle-outline" : "alert-circle-outline"}
                          size={16}
                          color={adminStatusOk ? colors.success : colors.warning}
                        />
                        <Text style={[styles.statusCardText, { color: adminStatusOk ? colors.success : colors.warning }]}>
                          Pipeline: {adminInfo.installerStatus}
                          {adminInfo.installerStatusMessage ? ` — ${adminInfo.installerStatusMessage}` : ""}
                        </Text>
                      </View>
                    )}

                    {/* Version editor */}
                    <View style={[styles.versionEditor, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                      <Text style={[styles.versionEditorTitle, { color: colors.text }]}>Override version & URL</Text>
                      <Text style={[styles.versionEditorSub, { color: colors.textTertiary }]}>
                        Current: v{adminInfo.version ?? "—"} · {adminInfo.fileName ?? "—"}
                      </Text>

                      <View style={styles.versionFieldWrap}>
                        <Text style={[styles.versionFieldLabel, { color: colors.textSecondary }]}>Version</Text>
                        <TextInput
                          value={editVersion}
                          onChangeText={setEditVersion}
                          placeholder={adminInfo.version ?? "1.0.0"}
                          style={[styles.versionInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
                          placeholderTextColor={colors.textTertiary}
                          autoCapitalize="none"
                        />
                      </View>
                      <View style={styles.versionFieldWrap}>
                        <Text style={[styles.versionFieldLabel, { color: colors.textSecondary }]}>Download URL</Text>
                        <TextInput
                          value={editUrl}
                          onChangeText={setEditUrl}
                          placeholder={adminInfo.downloadUrl ?? "/downloads/LabTrax-Windows-Portable.zip"}
                          style={[styles.versionInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
                          placeholderTextColor={colors.textTertiary}
                          autoCapitalize="none"
                          autoCorrect={false}
                        />
                      </View>
                      <View style={styles.versionFieldWrap}>
                        <Text style={[styles.versionFieldLabel, { color: colors.textSecondary }]}>Release notes</Text>
                        <TextInput
                          value={editNotes}
                          onChangeText={setEditNotes}
                          placeholder={adminInfo.releaseNotes ?? "What's new in this version…"}
                          multiline
                          numberOfLines={3}
                          style={[styles.versionInput, styles.versionInputMulti, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
                          placeholderTextColor={colors.textTertiary}
                        />
                      </View>

                      <Pressable
                        style={[styles.versionSaveBtn, { backgroundColor: colors.tint }, saveVersionMutation.isPending && { opacity: 0.6 }]}
                        onPress={() => saveVersionMutation.mutate()}
                        disabled={saveVersionMutation.isPending || (!editVersion && !editUrl)}
                      >
                        {versionSaved
                          ? <Ionicons name="checkmark-circle" size={15} color="#fff" />
                          : <Ionicons name="save-outline" size={15} color="#fff" />}
                        <Text style={styles.versionSaveBtnText}>
                          {saveVersionMutation.isPending ? "Saving…" : versionSaved ? "Saved!" : "Apply override"}
                        </Text>
                      </Pressable>
                    </View>
                  </>
                )}
              </>
            )}
          </SettingsSection>
        )}
      </ScrollView>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl },
    errorText: { ...Typography.body, textAlign: "center" },
    card: {
      borderRadius: Radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      padding: Spacing.lg,
      gap: Spacing.md,
    },
    cardHeader: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    iconWrap: {
      width: 44,
      height: 44,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    cardInfo: { flex: 1 },
    appTitle: { ...Typography.h3 },
    version: { ...Typography.caption, marginTop: 2 },
    statusPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderRadius: Radius.full,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    statusText: { ...Typography.tiny },
    statusMsg: { ...Typography.caption },
    updateState: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      borderRadius: Radius.sm,
      borderWidth: 1,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    updateStateText: { ...Typography.captionMedium, flex: 1 },
    actionRow: { flexDirection: "row", gap: Spacing.sm, flexWrap: "wrap" },
    checkBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.sm,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
      minWidth: 140,
    },
    checkBtnText: { ...Typography.captionMedium },
    downloadBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderRadius: Radius.sm,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
      minWidth: 120,
    },
    downloadBtnText: { ...Typography.captionMedium, color: "#fff" },

    pinSection: { padding: Spacing.lg, gap: Spacing.md },
    pinLabel: { ...Typography.caption },
    pinRow: { flexDirection: "row", gap: Spacing.sm },
    pinInput: {
      flex: 1,
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      ...Typography.body,
    },
    pinUnlockBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    pinUnlockText: { ...Typography.captionMedium, color: "#fff" },
    pinResetText: { ...Typography.captionMedium },

    adminError: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      margin: Spacing.lg,
      borderRadius: Radius.sm,
      padding: Spacing.md,
    },
    adminErrorText: { ...Typography.caption, flex: 1 },

    warnBanner: {
      flexDirection: "row",
      gap: Spacing.sm,
      borderWidth: 1,
      borderRadius: Radius.sm,
      padding: Spacing.md,
      margin: Spacing.lg,
      marginBottom: 0,
    },
    warnText: { ...Typography.caption, flex: 1 },

    slotsCard: {
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      margin: Spacing.lg,
      marginTop: Spacing.md,
    },
    slotCardTitle: { ...Typography.captionSemibold, padding: Spacing.md },
    slotRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      padding: Spacing.md,
    },
    slotLabel: { ...Typography.captionMedium },
    slotMeta: { ...Typography.tiny, marginTop: 1 },
    slotStatus: { ...Typography.tiny },

    statusCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      borderWidth: 1,
      borderRadius: Radius.sm,
      padding: Spacing.md,
      margin: Spacing.lg,
      marginTop: 0,
    },
    statusCardText: { ...Typography.caption, flex: 1 },

    versionEditor: {
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      margin: Spacing.lg,
      marginTop: 0,
      padding: Spacing.lg,
      gap: Spacing.md,
    },
    versionEditorTitle: { ...Typography.bodyMedium },
    versionEditorSub: { ...Typography.caption },
    versionFieldWrap: { gap: Spacing.xs },
    versionFieldLabel: { ...Typography.captionSemibold },
    versionInput: {
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      ...Typography.caption,
    },
    versionInputMulti: { minHeight: 64, textAlignVertical: "top" },
    versionSaveBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderRadius: Radius.sm,
      paddingVertical: Spacing.sm,
    },
    versionSaveBtnText: { ...Typography.captionMedium, color: "#fff" },
  });
}
