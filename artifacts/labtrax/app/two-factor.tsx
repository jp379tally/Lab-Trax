import React, { useState, useEffect, useCallback } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  TextInput,
  ActivityIndicator,
  ScrollView,
  Alert,
  Platform,
  Image,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { apiRequest } from "@/lib/query-client";
import Colors from "@/constants/colors";

interface TrustedDevice {
  id: string;
  deviceName: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
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

type Phase = "loading" | "status" | "setup-start" | "setup-confirm" | "backup-codes" | "disable-confirm" | "regen-confirm" | "regen-codes";

export default function TwoFactorScreen() {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>("loading");
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [secretKey, setSecretKey] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [regenCode, setRegenCode] = useState("");

  // Trusted devices (Task #863)
  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[]>([]);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const fetchTrustedDevices = useCallback(async () => {
    try {
      const res = await apiRequest("GET", "/api/auth/2fa/trusted-devices");
      const data = await res.json();
      // API envelope: { ok: true, data: { devices: [...] } }
      setTrustedDevices(data?.data?.devices ?? []);
    } catch {
      setTrustedDevices([]);
    }
  }, []);

  async function handleRevokeDevice(id: string) {
    Alert.alert(
      "Revoke trusted device",
      "This device will need to pass the 2FA challenge on next sign-in. Continue?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revoke",
          style: "destructive",
          onPress: async () => {
            setRevokingId(id);
            try {
              await apiRequest("DELETE", `/api/auth/2fa/trusted-devices/${id}`);
              setTrustedDevices((prev) => prev.filter((d) => d.id !== id));
            } catch {
              Alert.alert("Error", "Could not revoke that device. Please try again.");
            } finally {
              setRevokingId(null);
            }
          },
        },
      ],
    );
  }

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiRequest("GET", "/api/auth/2fa/status");
      const data = await res.json();
      if (data?.data) {
        setTwoFactorEnabled(data.data.twoFactorEnabled ?? false);
        if (data.data.twoFactorEnabled) {
          fetchTrustedDevices();
        }
      }
      setPhase("status");
    } catch {
      setPhase("status");
    }
  }, [fetchTrustedDevices]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  async function handleStartSetup() {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiRequest("POST", "/api/auth/2fa/setup");
      const data = await res.json();
      if (!res.ok || !data?.data) {
        setError(data?.error || "Failed to start setup.");
        setIsLoading(false);
        return;
      }
      setQrCodeDataUrl(data.data.qrCodeDataUrl ?? null);
      setSecretKey(data.data.secret ?? null);
      setConfirmCode("");
      setPhase("setup-start");
    } catch (e: any) {
      setError(e?.message || "Failed to start setup.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleConfirmSetup() {
    if (!confirmCode.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiRequest("POST", "/api/auth/2fa/confirm", { code: confirmCode.trim() });
      const data = await res.json();
      if (!res.ok || !data?.data?.success) {
        setError(data?.error || "Invalid code. Please try again.");
        setIsLoading(false);
        return;
      }
      setBackupCodes(data.data.backupCodes ?? []);
      setTwoFactorEnabled(true);
      setPhase("backup-codes");
    } catch (e: any) {
      setError(e?.message || "Verification failed.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDisable() {
    if (!disableCode.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiRequest("DELETE", "/api/auth/2fa", { code: disableCode.trim() });
      const data = await res.json();
      if (!res.ok || !data?.data?.success) {
        setError(data?.error || "Invalid code. Please try again.");
        setIsLoading(false);
        return;
      }
      setTwoFactorEnabled(false);
      setDisableCode("");
      setPhase("status");
    } catch (e: any) {
      setError(e?.message || "Failed to disable 2FA.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRegenerate() {
    if (!regenCode.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiRequest("POST", "/api/auth/2fa/backup-codes", { code: regenCode.trim() });
      const data = await res.json();
      if (!res.ok || !data?.data?.backupCodes) {
        setError(data?.error || "Invalid code. Please try again.");
        setIsLoading(false);
        return;
      }
      setBackupCodes(data.data.backupCodes ?? []);
      setRegenCode("");
      setPhase("regen-codes");
    } catch (e: any) {
      setError(e?.message || "Failed to regenerate backup codes.");
    } finally {
      setIsLoading(false);
    }
  }

  async function copySecret() {
    if (!secretKey) return;
    await Clipboard.setStringAsync(secretKey);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 2000);
  }

  async function copyBackupCodes() {
    await Clipboard.setStringAsync(backupCodes.join("\n"));
    Alert.alert("Copied", "Backup codes copied to clipboard.");
  }

  if (phase === "loading") {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}>
            <Ionicons name="chevron-back" size={24} color={Colors.light.text} />
          </Pressable>
          <Text style={styles.title}>Two-Factor Auth</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" color={Colors.light.tint} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => {
            if (phase === "setup-start" || phase === "setup-confirm" || phase === "disable-confirm" || phase === "regen-confirm") {
              setPhase("status");
              setError(null);
            } else {
              router.back();
            }
          }}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
        >
          <Ionicons name="chevron-back" size={24} color={Colors.light.text} />
        </Pressable>
        <Text style={styles.title}>Two-Factor Auth</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* STATUS PHASE */}
        {phase === "status" && (
          <View style={{ gap: 16 }}>
            <View style={styles.statusCard}>
              <View style={[styles.statusIconWrap, { backgroundColor: twoFactorEnabled ? "#D1FAE5" : "#F3F4F6" }]}>
                <Ionicons
                  name={twoFactorEnabled ? "shield-checkmark" : "shield-outline"}
                  size={32}
                  color={twoFactorEnabled ? "#059669" : "#6B7280"}
                />
              </View>
              <Text style={styles.statusTitle}>
                {twoFactorEnabled ? "2FA is enabled" : "2FA is not enabled"}
              </Text>
              <Text style={styles.statusSub}>
                {twoFactorEnabled
                  ? "Your account is protected with an authenticator app. You'll need to enter a code each time you sign in."
                  : "Add an extra layer of security to your account. You'll need an authenticator app like Google Authenticator or Authy."}
              </Text>
            </View>

            {twoFactorEnabled ? (
              <>
                <Pressable
                  onPress={() => { setRegenCode(""); setError(null); setPhase("regen-confirm"); }}
                  style={({ pressed }) => [styles.outlineBtn, pressed && { opacity: 0.85 }]}
                >
                  <Ionicons name="refresh-outline" size={16} color={Colors.light.tint} />
                  <Text style={styles.outlineBtnText}>Regenerate Backup Codes</Text>
                </Pressable>
                <Pressable
                  onPress={() => { setDisableCode(""); setError(null); setPhase("disable-confirm"); }}
                  style={({ pressed }) => [styles.dangerBtn, pressed && { opacity: 0.85 }]}
                >
                  <Ionicons name="shield-outline" size={18} color="#DC2626" />
                  <Text style={styles.dangerBtnText}>Disable Two-Factor Auth</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                onPress={handleStartSetup}
                disabled={isLoading}
                style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }, isLoading && { opacity: 0.6 }]}
              >
                {isLoading ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <>
                    <Ionicons name="shield-checkmark-outline" size={18} color="#FFF" />
                    <Text style={styles.primaryBtnText}>Enable Two-Factor Auth</Text>
                  </>
                )}
              </Pressable>
            )}

            {/* Trusted devices list */}
            {twoFactorEnabled && trustedDevices.length > 0 && (
              <View style={{ marginTop: 4, gap: 10 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: Colors.light.text }}>
                  Trusted devices
                </Text>
                <Text style={{ fontSize: 12, color: Colors.light.tabIconDefault, marginTop: -6 }}>
                  These devices skip the 2FA challenge for 30 days. Revoke any you don't recognise.
                </Text>
                {trustedDevices.map((d) => (
                  <View
                    key={d.id}
                    style={{
                      backgroundColor: "#F9FAFB",
                      borderRadius: 10,
                      borderWidth: 1,
                      borderColor: "#E5E7EB",
                      padding: 12,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: "600", color: Colors.light.text }}>
                        {d.deviceName || (d.userAgent?.includes("Mobile") ? "Mobile app" : "Desktop / Browser")}
                      </Text>
                      {d.ipAddress ? (
                        <Text style={{ fontSize: 11, color: Colors.light.tabIconDefault, marginTop: 1 }}>
                          {d.ipAddress}
                        </Text>
                      ) : null}
                      <Text style={{ fontSize: 11, color: Colors.light.tabIconDefault, marginTop: 1 }}>
                        Trusted {formatRelativeDate(d.createdAt)}
                        {d.lastUsedAt ? ` · used ${formatRelativeDate(d.lastUsedAt)}` : ""}
                        {" · "}expires {formatRelativeDate(d.expiresAt)}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => handleRevokeDevice(d.id)}
                      disabled={revokingId === d.id}
                      style={({ pressed }) => ({
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: 6,
                        backgroundColor: pressed ? "#FEE2E2" : "#FEF2F2",
                        borderWidth: 1,
                        borderColor: "#FECACA",
                        opacity: revokingId === d.id ? 0.5 : 1,
                      })}
                    >
                      {revokingId === d.id ? (
                        <ActivityIndicator size="small" color="#DC2626" />
                      ) : (
                        <Text style={{ fontSize: 12, fontWeight: "600", color: "#DC2626" }}>Revoke</Text>
                      )}
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* SETUP-START PHASE: show QR code */}
        {phase === "setup-start" && (
          <View style={{ gap: 16 }}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Scan QR code</Text>
              <Text style={styles.cardSub}>
                Open your authenticator app (Google Authenticator, Authy, etc.) and scan the QR code below.
              </Text>
              {qrCodeDataUrl && (
                <View style={{ alignItems: "center", marginVertical: 16 }}>
                  <Image
                    source={{ uri: qrCodeDataUrl }}
                    style={{ width: 200, height: 200, borderRadius: 8 }}
                    resizeMode="contain"
                  />
                </View>
              )}
              {secretKey && (
                <View style={styles.secretRow}>
                  <Text style={styles.secretLabel}>Or enter manually:</Text>
                  <Pressable onPress={copySecret} style={styles.secretCopyRow}>
                    <Text style={styles.secretText} selectable>{secretKey}</Text>
                    <Ionicons name={copiedSecret ? "checkmark" : "copy-outline"} size={16} color={Colors.light.tint} />
                  </Pressable>
                </View>
              )}
            </View>

            <Pressable
              onPress={() => { setConfirmCode(""); setError(null); setPhase("setup-confirm"); }}
              style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.primaryBtnText}>I've scanned the code →</Text>
            </Pressable>
          </View>
        )}

        {/* SETUP-CONFIRM PHASE: enter TOTP code to confirm */}
        {phase === "setup-confirm" && (
          <View style={{ gap: 16 }}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Verify your setup</Text>
              <Text style={styles.cardSub}>
                Enter the 6-digit code from your authenticator app to confirm setup.
              </Text>
              {error && (
                <View style={styles.errorBox}>
                  <Ionicons name="alert-circle-outline" size={15} color="#DC2626" />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}
              <TextInput
                style={styles.codeInput}
                value={confirmCode}
                onChangeText={(t) => { setConfirmCode(t.replace(/\D/g, "").slice(0, 6)); setError(null); }}
                placeholder="000000"
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
                textAlign="center"
              />
            </View>

            <Pressable
              onPress={handleConfirmSetup}
              disabled={isLoading || confirmCode.length < 6}
              style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }, (isLoading || confirmCode.length < 6) && { opacity: 0.6 }]}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <Text style={styles.primaryBtnText}>Confirm and enable</Text>
              )}
            </Pressable>
            <Pressable onPress={() => { setPhase("setup-start"); setError(null); }} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
              <Text style={{ textAlign: "center", color: Colors.light.tint, fontFamily: "Inter_500Medium", fontSize: 14 }}>
                ← Back to QR code
              </Text>
            </Pressable>
          </View>
        )}

        {/* BACKUP CODES PHASE */}
        {phase === "backup-codes" && (
          <View style={{ gap: 16 }}>
            <View style={[styles.card, { borderColor: "#6EE7B7", borderWidth: 1.5 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <Ionicons name="checkmark-circle" size={20} color="#059669" />
                <Text style={[styles.cardTitle, { color: "#059669" }]}>2FA enabled!</Text>
              </View>
              <Text style={styles.cardSub}>
                Save these backup codes somewhere safe. Each code can only be used once, if you lose access to your authenticator app.
              </Text>
              <View style={styles.backupCodesGrid}>
                {backupCodes.map((code, i) => (
                  <View key={i} style={styles.backupCodeItem}>
                    <Text style={styles.backupCodeText}>{code}</Text>
                  </View>
                ))}
              </View>
              <Pressable onPress={copyBackupCodes} style={({ pressed }) => [styles.outlineBtn, pressed && { opacity: 0.7 }, { marginTop: 8 }]}>
                <Ionicons name="copy-outline" size={16} color={Colors.light.tint} />
                <Text style={styles.outlineBtnText}>Copy all codes</Text>
              </Pressable>
            </View>

            <Pressable
              onPress={() => router.back()}
              style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.primaryBtnText}>Done</Text>
            </Pressable>
          </View>
        )}

        {/* REGEN-CONFIRM PHASE */}
        {phase === "regen-confirm" && (
          <View style={{ gap: 16 }}>
            <View style={[styles.card, { borderColor: "#BAE6FD", borderWidth: 1.5 }]}>
              <Text style={styles.cardTitle}>Regenerate backup codes</Text>
              <Text style={styles.cardSub}>
                Enter the 6-digit code from your authenticator app to confirm. Your existing backup codes will be permanently invalidated.
              </Text>
              {error && (
                <View style={styles.errorBox}>
                  <Ionicons name="alert-circle-outline" size={15} color="#DC2626" />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}
              <TextInput
                style={styles.codeInput}
                value={regenCode}
                onChangeText={(t) => { setRegenCode(t.replace(/\D/g, "").slice(0, 6)); setError(null); }}
                placeholder="000000"
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
                textAlign="center"
              />
            </View>

            <Pressable
              onPress={handleRegenerate}
              disabled={isLoading || regenCode.length < 6}
              style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }, (isLoading || regenCode.length < 6) && { opacity: 0.6 }]}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons name="refresh-outline" size={18} color="#FFF" />
                  <Text style={styles.primaryBtnText}>Generate new codes</Text>
                </>
              )}
            </Pressable>
          </View>
        )}

        {/* REGEN-CODES PHASE */}
        {phase === "regen-codes" && (
          <View style={{ gap: 16 }}>
            <View style={[styles.card, { borderColor: "#BAE6FD", borderWidth: 1.5 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <Ionicons name="checkmark-circle" size={20} color="#0284C7" />
                <Text style={[styles.cardTitle, { color: "#0284C7" }]}>New codes generated!</Text>
              </View>
              <Text style={styles.cardSub}>
                Your old backup codes are no longer valid. Save these new codes somewhere safe — each can only be used once.
              </Text>
              <View style={styles.backupCodesGrid}>
                {backupCodes.map((code, i) => (
                  <View key={i} style={styles.backupCodeItem}>
                    <Text style={styles.backupCodeText}>{code}</Text>
                  </View>
                ))}
              </View>
              <Pressable onPress={copyBackupCodes} style={({ pressed }) => [styles.outlineBtn, pressed && { opacity: 0.7 }, { marginTop: 8 }]}>
                <Ionicons name="copy-outline" size={16} color={Colors.light.tint} />
                <Text style={styles.outlineBtnText}>Copy all codes</Text>
              </Pressable>
            </View>

            <Pressable
              onPress={() => setPhase("status")}
              style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.primaryBtnText}>Done</Text>
            </Pressable>
          </View>
        )}

        {/* DISABLE-CONFIRM PHASE */}
        {phase === "disable-confirm" && (
          <View style={{ gap: 16 }}>
            <View style={[styles.card, { borderColor: "#FCA5A5", borderWidth: 1.5 }]}>
              <Text style={styles.cardTitle}>Disable 2FA</Text>
              <Text style={styles.cardSub}>
                Enter the 6-digit code from your authenticator app (or a backup code) to confirm you want to disable two-factor authentication.
              </Text>
              {error && (
                <View style={styles.errorBox}>
                  <Ionicons name="alert-circle-outline" size={15} color="#DC2626" />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}
              <TextInput
                style={styles.codeInput}
                value={disableCode}
                onChangeText={(t) => { setDisableCode(t.replace(/\D/g, "").slice(0, 6)); setError(null); }}
                placeholder="000000"
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
                textAlign="center"
              />
            </View>

            <Pressable
              onPress={handleDisable}
              disabled={isLoading || !disableCode.trim()}
              style={({ pressed }) => [styles.dangerBtn, { backgroundColor: "#FEE2E2" }, pressed && { opacity: 0.85 }, (isLoading || !disableCode.trim()) && { opacity: 0.6 }]}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color="#DC2626" />
              ) : (
                <>
                  <Ionicons name="shield-outline" size={18} color="#DC2626" />
                  <Text style={styles.dangerBtnText}>Disable Two-Factor Auth</Text>
                </>
              )}
            </Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.border,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  statusCard: {
    backgroundColor: Colors.light.surface,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  statusIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  statusTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    textAlign: "center",
  },
  statusSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    textAlign: "center",
    lineHeight: 20,
  },
  card: {
    backgroundColor: Colors.light.surface,
    borderRadius: 16,
    padding: 20,
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  cardSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    lineHeight: 20,
  },
  secretRow: {
    marginTop: 8,
    gap: 4,
  },
  secretLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
  },
  secretCopyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.light.backgroundSolid,
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  secretText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
    letterSpacing: 1,
  },
  codeInput: {
    height: 52,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.backgroundSolid,
    fontSize: 24,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 8,
    color: Colors.light.text,
    marginTop: 8,
  },
  backupCodesGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 12,
  },
  backupCodeItem: {
    backgroundColor: Colors.light.backgroundSolid,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: Colors.light.border,
    width: "47%",
    alignItems: "center",
  },
  backupCodeText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.text,
    letterSpacing: 1,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FEF2F2",
    borderRadius: 8,
    padding: 10,
    marginTop: 4,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#DC2626",
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.light.tint,
    borderRadius: 12,
    height: 50,
    paddingHorizontal: 20,
  },
  primaryBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#FFF",
  },
  outlineBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
    height: 44,
    paddingHorizontal: 20,
    borderWidth: 1.5,
    borderColor: Colors.light.tint,
  },
  outlineBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
  dangerBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
    height: 50,
    paddingHorizontal: 20,
    borderWidth: 1.5,
    borderColor: "#FCA5A5",
  },
  dangerBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#DC2626",
  },
});
