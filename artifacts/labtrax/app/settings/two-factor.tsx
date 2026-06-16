import React, { useState, useEffect, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Image,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Ionicons } from "@expo/vector-icons";
import { ScreenShell, SettingsSection } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";

type Phase = "loading" | "status" | "setup" | "confirm" | "backup-codes" | "disable" | "regen-confirm" | "regen-codes";

interface TrustedDevice {
  id: string;
  deviceName: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

function describeDevice(d: TrustedDevice): string {
  if (d.deviceName) return d.deviceName;
  const ua = d.userAgent ?? "";
  if (/iphone|ipad|ios/i.test(ua)) return "iPhone / iPad";
  if (/android/i.test(ua)) return "Android device";
  if (/mobile/i.test(ua)) return "Mobile app";
  if (/electron/i.test(ua)) return "Desktop app";
  return "Desktop / Browser";
}

function formatRelativeDate(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = t - Date.now();
  const future = diff > 0;
  const absMs = Math.abs(diff);
  const min = Math.round(absMs / 60000);
  const suffix = (label: string) => (future ? `in ${label}` : `${label} ago`);
  if (min < 1) return future ? "in a moment" : "just now";
  if (min < 60) return suffix(`${min} min`);
  const hr = Math.round(min / 60);
  if (hr < 24) return suffix(`${hr} hr`);
  const day = Math.round(hr / 24);
  if (day < 30) return suffix(`${day} day${day === 1 ? "" : "s"}`);
  return new Date(iso).toLocaleDateString();
}

async function apiCall(path: string, method = "GET", body?: unknown) {
  const res = await resilientFetch(path, {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error((e as any)?.error || (e as any)?.message || `Request failed (${res.status})`);
  }
  const json = await res.json();
  return (json?.data ?? json) as unknown;
}

export default function TwoFactorScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [phase, setPhase] = useState<Phase>("loading");
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrUri, setQrUri] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [disableCode, setDisableCode] = useState("");
  const [regenCode, setRegenCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [devices, setDevices] = useState<TrustedDevice[]>([]);
  const [devicesError, setDevicesError] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function fetchDevices() {
    try {
      const r = (await apiCall("/api/auth/2fa/trusted-devices")) as {
        devices?: TrustedDevice[];
      };
      setDevices(r?.devices ?? []);
      setDevicesError(false);
    } catch {
      setDevicesError(true);
    }
  }

  useEffect(() => {
    apiCall("/api/auth/2fa/status")
      .then((r) => {
        const isEnabled = (r as { twoFactorEnabled?: boolean })?.twoFactorEnabled ?? false;
        setEnabled(isEnabled);
        setPhase("status");
        if (isEnabled) fetchDevices();
      })
      .catch(() => setPhase("status"));
  }, []);

  function confirmRevoke(d: TrustedDevice) {
    Alert.alert(
      "Sign out this device?",
      `${describeDevice(d)} will need to pass the 2FA challenge the next time it signs in.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: async () => {
            setRevokingId(d.id);
            try {
              await apiCall(`/api/auth/2fa/trusted-devices/${d.id}`, "DELETE");
              setDevices((prev) => prev.filter((x) => x.id !== d.id));
            } catch (e: any) {
              Alert.alert("Error", e?.message || "Could not sign out that device.");
            } finally {
              setRevokingId(null);
            }
          },
        },
      ],
    );
  }

  async function startSetup() {
    setError(null); setBusy(true);
    try {
      const r = await apiCall("/api/auth/2fa/setup", "POST") as any;
      setQrUri(r?.qrCodeDataUrl ?? null);
      setSecret(r?.secret ?? null);
      setVerifyCode("");
      setPhase("setup");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function confirmSetup() {
    if (!verifyCode.trim()) { setError("Enter the 6-digit code."); return; }
    setError(null); setBusy(true);
    try {
      const r = await apiCall("/api/auth/2fa/confirm", "POST", { code: verifyCode.trim() }) as any;
      setBackupCodes(r?.backupCodes ?? []);
      setEnabled(true);
      setPhase("backup-codes");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function disable2fa() {
    if (!disableCode.trim()) { setError("Enter your authenticator code."); return; }
    setError(null); setBusy(true);
    try {
      await apiCall("/api/auth/2fa", "DELETE", { code: disableCode.trim() });
      setEnabled(false); setDisableCode(""); setPhase("status");
      setSuccessMsg("Two-factor authentication disabled.");
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function regenCodes() {
    if (!regenCode.trim()) { setError("Enter your authenticator code."); return; }
    setError(null); setBusy(true);
    try {
      const r = await apiCall("/api/auth/2fa/backup-codes", "POST", { code: regenCode.trim() }) as any;
      setBackupCodes(r?.backupCodes ?? []);
      setRegenCode(""); setPhase("regen-codes");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (phase === "loading") {
    return (
      <ScreenShell title="Two-Factor Auth" onBack={() => router.back()} insetTop={insets.top}>
        <ActivityIndicator color={colors.tint} style={{ marginTop: Spacing.xxl }} />
      </ScreenShell>
    );
  }

  if (phase === "setup") {
    return (
      <ScreenShell title="Set up 2FA" subtitle="Scan QR code then enter the code" onBack={() => { setPhase("status"); setError(null); }} insetTop={insets.top}>
        <ScrollView contentContainerStyle={styles.body}>
          {error && <Text style={[styles.error, { color: colors.error }]}>{error}</Text>}
          {qrUri && <Image source={{ uri: qrUri }} style={styles.qr} resizeMode="contain" />}
          {secret && (
            <View style={[styles.secretBox, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <Text style={[styles.secretLabel, { color: colors.textSecondary }]}>Or enter key manually:</Text>
              <Text style={[styles.secretKey, { color: colors.text }]} selectable>{secret}</Text>
            </View>
          )}
          <SettingsSection title="Verify">
            <View style={styles.fieldWrap}>
              <Text style={[styles.label, { color: colors.textSecondary }]}>Verification code</Text>
              <TextInput
                value={verifyCode}
                onChangeText={(t) => setVerifyCode(t.replace(/\D/g, ""))}
                keyboardType="number-pad"
                maxLength={6}
                style={[styles.codeInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                placeholder="000000"
                placeholderTextColor={colors.textTertiary}
                autoFocus
              />
            </View>
          </SettingsSection>
          <Pressable
            style={[styles.btn, { backgroundColor: colors.tint }, (busy || verifyCode.length !== 6) && { opacity: 0.5 }]}
            onPress={confirmSetup}
            disabled={busy || verifyCode.length !== 6}
          >
            <Text style={styles.btnText}>{busy ? "Verifying…" : "Verify and enable"}</Text>
          </Pressable>
        </ScrollView>
      </ScreenShell>
    );
  }

  if (phase === "backup-codes" || phase === "regen-codes") {
    const title = phase === "backup-codes" ? "2FA is now enabled" : "New backup codes generated";
    return (
      <ScreenShell title="Backup codes" onBack={() => setPhase("status")} insetTop={insets.top}>
        <ScrollView contentContainerStyle={styles.body}>
          <View style={[styles.successBanner, { backgroundColor: colors.success + "20", borderColor: colors.success + "40" }]}>
            <Text style={[styles.successText, { color: colors.success }]}>{title}</Text>
          </View>
          <Text style={[styles.codesNote, { color: colors.textSecondary }]}>
            Each code can be used once in place of your authenticator code. Store them somewhere safe.
          </Text>
          <View style={[styles.codesGrid, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}>
            {backupCodes.map((c) => (
              <View key={c} style={[styles.codeChip, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                <Text style={[styles.codeChipText, { color: colors.text }]}>{c}</Text>
              </View>
            ))}
          </View>
          <Pressable style={[styles.btn, { backgroundColor: colors.tint }]} onPress={() => setPhase("status")}>
            <Text style={styles.btnText}>Done</Text>
          </Pressable>
        </ScrollView>
      </ScreenShell>
    );
  }

  if (phase === "disable") {
    return (
      <ScreenShell title="Disable 2FA" onBack={() => { setPhase("status"); setError(null); setDisableCode(""); }} insetTop={insets.top}>
        <ScrollView contentContainerStyle={styles.body}>
          {error && <Text style={[styles.error, { color: colors.error }]}>{error}</Text>}
          <SettingsSection title="Confirm with authenticator code">
            <View style={styles.fieldWrap}>
              <TextInput
                value={disableCode}
                onChangeText={(t) => { setDisableCode(t.replace(/\D/g, "")); setError(null); }}
                keyboardType="number-pad"
                maxLength={6}
                style={[styles.codeInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                placeholder="000000"
                placeholderTextColor={colors.textTertiary}
                autoFocus
              />
            </View>
          </SettingsSection>
          <Pressable
            style={[styles.btn, { backgroundColor: colors.error }, (busy || !disableCode.trim()) && { opacity: 0.5 }]}
            onPress={disable2fa}
            disabled={busy || !disableCode.trim()}
          >
            <Text style={styles.btnText}>{busy ? "Disabling…" : "Disable 2FA"}</Text>
          </Pressable>
        </ScrollView>
      </ScreenShell>
    );
  }

  if (phase === "regen-confirm") {
    return (
      <ScreenShell title="Regenerate backup codes" onBack={() => { setPhase("status"); setError(null); setRegenCode(""); }} insetTop={insets.top}>
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={[styles.note, { color: colors.textSecondary }]}>
            Your existing backup codes will be invalidated. Confirm with your authenticator code.
          </Text>
          {error && <Text style={[styles.error, { color: colors.error }]}>{error}</Text>}
          <SettingsSection title="Authenticator code">
            <View style={styles.fieldWrap}>
              <TextInput
                value={regenCode}
                onChangeText={(t) => { setRegenCode(t.replace(/\D/g, "")); setError(null); }}
                keyboardType="number-pad"
                maxLength={6}
                style={[styles.codeInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                placeholder="000000"
                placeholderTextColor={colors.textTertiary}
                autoFocus
              />
            </View>
          </SettingsSection>
          <Pressable
            style={[styles.btn, { backgroundColor: colors.tint }, (busy || regenCode.length !== 6) && { opacity: 0.5 }]}
            onPress={regenCodes}
            disabled={busy || regenCode.length !== 6}
          >
            <Text style={styles.btnText}>{busy ? "Generating…" : "Generate new codes"}</Text>
          </Pressable>
        </ScrollView>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell title="Two-Factor Auth" subtitle="Secure your account" onBack={() => router.back()} insetTop={insets.top}>
      <ScrollView contentContainerStyle={styles.body}>
        {successMsg && (
          <View style={[styles.successBanner, { backgroundColor: colors.success + "20", borderColor: colors.success + "40" }]}>
            <Text style={[styles.successText, { color: colors.success }]}>{successMsg}</Text>
          </View>
        )}
        <SettingsSection>
          <View style={styles.statusRow}>
            <View style={styles.statusInfo}>
              <View style={styles.statusIcon}>
                <Ionicons name="shield-checkmark" size={18} color={enabled ? "#10B981" : colors.textTertiary} />
              </View>
              <View>
                <Text style={[styles.statusTitle, { color: colors.text }]}>{enabled ? "Enabled" : "Not enabled"}</Text>
                <Text style={[styles.statusDesc, { color: colors.textSecondary }]}>
                  {enabled ? "Your account is protected with an authenticator app." : "Use an authenticator app as a second sign-in step."}
                </Text>
              </View>
            </View>
            {enabled ? (
              <Pressable
                style={[styles.smallBtn, { borderColor: colors.error }]}
                onPress={() => { setPhase("disable"); setError(null); }}
              >
                <Text style={[styles.smallBtnText, { color: colors.error }]}>Disable</Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.smallBtn, { backgroundColor: colors.tint, borderColor: colors.tint }]}
                onPress={startSetup}
                disabled={busy}
              >
                <Text style={[styles.smallBtnText, { color: "#fff" }]}>{busy ? "…" : "Set up"}</Text>
              </Pressable>
            )}
          </View>
        </SettingsSection>

        {enabled && (
          <SettingsSection>
            <View style={styles.statusRow}>
              <View>
                <Text style={[styles.statusTitle, { color: colors.text }]}>Backup codes</Text>
                <Text style={[styles.statusDesc, { color: colors.textSecondary }]}>Generate a new set of backup codes.</Text>
              </View>
              <Pressable
                style={[styles.smallBtn, { borderColor: colors.border }]}
                onPress={() => { setRegenCode(""); setError(null); setPhase("regen-confirm"); }}
              >
                <Text style={[styles.smallBtnText, { color: colors.text }]}>Regenerate</Text>
              </Pressable>
            </View>
          </SettingsSection>
        )}

        {enabled && (
          <SettingsSection title="Remembered devices">
            <View style={styles.devicesIntro}>
              <Text style={[styles.statusDesc, { color: colors.textSecondary }]}>
                These devices can skip the 2FA challenge until they expire. Sign out any you don't recognise.
              </Text>
            </View>
            {devicesError ? (
              <View style={styles.deviceEmpty}>
                <Text style={[styles.statusDesc, { color: colors.error }]}>
                  Couldn't load your remembered devices. Pull to refresh or try again later.
                </Text>
              </View>
            ) : devices.length === 0 ? (
              <View style={styles.deviceEmpty}>
                <Text style={[styles.statusDesc, { color: colors.textSecondary }]}>
                  No remembered devices. Devices appear here when you choose "remember this device" during sign-in.
                </Text>
              </View>
            ) : (
              devices.map((d) => (
                <View key={d.id} style={[styles.deviceRow, { borderTopColor: colors.border }]}>
                  <View style={styles.deviceInfo}>
                    <Text style={[styles.statusTitle, { color: colors.text }]} numberOfLines={1}>
                      {describeDevice(d)}
                    </Text>
                    <Text style={[styles.deviceMeta, { color: colors.textSecondary }]}>
                      {d.ipAddress || "Unknown IP"}
                    </Text>
                    <Text style={[styles.deviceMeta, { color: colors.textTertiary }]}>
                      {`Last used ${formatRelativeDate(d.lastUsedAt ?? d.createdAt)} · expires ${formatRelativeDate(d.expiresAt)}`}
                    </Text>
                  </View>
                  <Pressable
                    style={[styles.smallBtn, { borderColor: colors.error }, revokingId === d.id && { opacity: 0.5 }]}
                    onPress={() => confirmRevoke(d)}
                    disabled={revokingId === d.id}
                  >
                    {revokingId === d.id ? (
                      <ActivityIndicator size="small" color={colors.error} />
                    ) : (
                      <Text style={[styles.smallBtnText, { color: colors.error }]}>Sign out</Text>
                    )}
                  </Pressable>
                </View>
              ))
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
    error: { ...Typography.caption, paddingHorizontal: Spacing.xs },
    note: { ...Typography.body },
    successBanner: { borderRadius: Radius.md, borderWidth: 1, padding: Spacing.md },
    successText: { ...Typography.bodyMedium, textAlign: "center" },
    qr: { width: 200, height: 200, alignSelf: "center", borderRadius: Radius.md },
    secretBox: { borderRadius: Radius.md, borderWidth: 1, padding: Spacing.md, gap: 4 },
    secretLabel: { ...Typography.caption },
    secretKey: { fontFamily: "monospace", fontSize: 13, letterSpacing: 2, flexWrap: "wrap" },
    fieldWrap: { padding: Spacing.lg, gap: Spacing.xs },
    label: { ...Typography.captionSemibold },
    codeInput: {
      borderWidth: 1,
      borderRadius: Radius.sm,
      padding: Spacing.md,
      ...Typography.h2,
      textAlign: "center",
      letterSpacing: 8,
    },
    codesNote: { ...Typography.body },
    codesGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: 1,
      padding: Spacing.md,
    },
    codeChip: {
      borderWidth: 1,
      borderRadius: Radius.xs,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
    },
    codeChipText: { fontFamily: "monospace", fontSize: 13 },
    statusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      padding: Spacing.lg,
    },
    statusInfo: { flex: 1, flexDirection: "row", gap: Spacing.md, alignItems: "flex-start" },
    statusIcon: { paddingTop: 2 },
    statusTitle: { ...Typography.bodyMedium },
    statusDesc: { ...Typography.caption, marginTop: 2, flex: 1 },
    smallBtn: {
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      flexShrink: 0,
    },
    smallBtnText: { ...Typography.captionMedium },
    btn: { borderRadius: Radius.md, padding: Spacing.md, alignItems: "center" },
    btnText: { ...Typography.bodySemibold, color: "#fff" },
    devicesIntro: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, paddingBottom: Spacing.xs },
    deviceEmpty: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.lg },
    deviceRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      padding: Spacing.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    deviceInfo: { flex: 1, gap: 2 },
    deviceMeta: { ...Typography.caption },
  });
}
