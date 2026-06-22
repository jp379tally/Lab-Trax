import React, { useState, useEffect, useMemo, useRef } from "react";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell, SettingsSection } from "@/components/settings/SettingsRow";
import { resilientFetch, getApiUrl, getAccessToken } from "@/lib/query-client";
import { ME_QUERY_KEY } from "@/lib/auth-me";

interface MeUser {
  id?: string;
  username?: string;
  platformAccountNumber?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  phoneVerifiedAt?: string | null;
  practiceName?: string | null;
  role?: string | null;
  workStatus?: string | null;
  profilePhotoUrl?: string | null;
  practiceOrganizationId?: string | null;
  practiceLogoUrl?: string | null;
  practiceLogoplacements?: string[] | null;
  practiceLogoSize?: string | null;
}

const WORK_STATUS_OPTIONS = [
  { value: "available", label: "At work", color: "#10B981" },
  { value: "break", label: "On break", color: "#F59E0B" },
  { value: "lunch", label: "On lunch", color: "#F97316" },
  { value: "out_of_office", label: "Out of office", color: "#94A3B8" },
] as const;

const LOGO_PLACEMENTS = [
  { key: "invoices", label: "Invoices" },
  { key: "statements", label: "Statements" },
  { key: "lab_reports", label: "Lab reports" },
  { key: "welcome_emails", label: "Welcome emails" },
] as const;

const LOGO_SIZES = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
] as const;

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const meQuery = useQuery<{ user?: MeUser; memberships?: unknown[] }>({
    queryKey: ME_QUERY_KEY,
    queryFn: async () => {
      const res = await resilientFetch("/api/auth/me");
      if (!res.ok) throw new Error("Could not load profile");
      return res.json();
    },
    staleTime: 60_000,
  });

  const user = meQuery.data?.user as MeUser | undefined;
  const isAdmin = user?.role === "admin";

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [practiceName, setPracticeName] = useState("");
  const [username, setUsername] = useState("");
  const [saved, setSaved] = useState(false);

  const [logoPlacements, setLogoPlacements] = useState<string[]>([]);
  const [logoSize, setLogoSize] = useState<string>("medium");
  const [logoSaved, setLogoSaved] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const logoXhrRef = useRef<XMLHttpRequest | null>(null);

  // Phone verification state
  const [phoneVerifyStep, setPhoneVerifyStep] = useState<"idle" | "sending" | "otp">("idle");
  const [otpCode, setOtpCode] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [resendCountdown, setResendCountdown] = useState(0);
  const [resending, setResending] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const resendTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (resendTimerRef.current) clearInterval(resendTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (user) {
      setFirstName(user.firstName ?? "");
      setLastName(user.lastName ?? "");
      setEmail(user.email ?? "");
      setPhone(user.phone ?? "");
      setPracticeName(user.practiceName ?? "");
      setUsername(user.username ?? "");
      setLogoPlacements(user.practiceLogoplacements ?? ["invoices", "statements", "lab_reports"]);
      setLogoSize(user.practiceLogoSize ?? "medium");
      setPhoneVerifyStep("idle");
      setOtpCode("");
      setOtpError(null);
    }
  }, [user?.id]);

  // A phone is considered verified only when the stored verifiedAt is set AND
  // the field hasn't been edited away from the server-confirmed value.
  const isPhoneVerified = !!(
    user?.phoneVerifiedAt &&
    user?.phone &&
    phone.trim() !== "" &&
    phone === user.phone
  );

  function startResendTimer(seconds = 60) {
    setResendCountdown(seconds);
    if (resendTimerRef.current) clearInterval(resendTimerRef.current);
    resendTimerRef.current = setInterval(() => {
      setResendCountdown((c) => {
        if (c <= 1) {
          clearInterval(resendTimerRef.current!);
          resendTimerRef.current = null;
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  async function handleSendVerificationCode() {
    const phoneToVerify = phone.trim();
    if (!phoneToVerify || !user?.id) return;
    // When called as a resend (OTP panel already open), keep the panel visible
    // throughout the request so errors surface inline and Cancel still works.
    const isResend = phoneVerifyStep === "otp";
    if (isResend) {
      setResending(true);
    } else {
      setPhoneVerifyStep("sending");
    }
    setOtpError(null);
    try {
      // If phone was edited, save it first so the server can bind the code to the user's account.
      if (phone !== (user?.phone ?? "")) {
        const saveRes = await resilientFetch(`/api/auth/users/${user.id}/profile`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstName, lastName, email, phone, practiceName, username }),
        });
        if (!saveRes.ok) {
          const e = await saveRes.json().catch(() => ({}));
          throw new Error((e as any)?.error || `Save failed (${saveRes.status})`);
        }
        qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }
      const codeRes = await resilientFetch("/api/send-phone-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phoneToVerify }),
      });
      if (codeRes.status === 429) {
        // Server throttled the request — start a countdown so the user knows
        // when they can retry. Use the Retry-After header if present, otherwise
        // default to 30 s (the server's cooldown window).
        const ra = codeRes.headers.get("Retry-After");
        const waitSecs = ra ? (parseInt(ra, 10) || 30) : 30;
        startResendTimer(waitSecs);
        const e = await codeRes.json().catch(() => ({}));
        setOtpError((e as any)?.error || "Please wait before requesting another verification code.");
        if (!isResend) setPhoneVerifyStep("idle");
        return;
      }
      if (!codeRes.ok) {
        const e = await codeRes.json().catch(() => ({}));
        throw new Error((e as any)?.error || "Failed to send verification code.");
      }
      setPhoneVerifyStep("otp");
      setOtpCode("");
      startResendTimer();
    } catch (err: unknown) {
      setOtpError((err as Error).message || "Failed to send verification code.");
      // For a resend, stay in the OTP panel so the user sees the error inline
      // and can retry or cancel. Only drop back to idle for the initial send.
      if (!isResend) {
        setPhoneVerifyStep("idle");
      }
    } finally {
      setResending(false);
    }
  }

  async function handleVerifyOtp() {
    if (!otpCode.trim() || isVerifying) return;
    setOtpError(null);
    setIsVerifying(true);
    try {
      const res = await resilientFetch("/api/verify-phone-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim(), code: otpCode.trim() }),
      });
      const result = await res.json() as { verified: boolean; error?: string };
      if (!result.verified) {
        setOtpError(result.error || "Incorrect code. Please try again.");
        return;
      }
      setPhoneVerifyStep("idle");
      setOtpCode("");
      if (resendTimerRef.current) {
        clearInterval(resendTimerRef.current);
        resendTimerRef.current = null;
      }
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    } catch (err: unknown) {
      setOtpError((err as Error).message || "Verification failed. Please try again.");
    } finally {
      setIsVerifying(false);
    }
  }

  function cancelPhoneVerify() {
    setPhoneVerifyStep("idle");
    setResending(false);
    setOtpCode("");
    setOtpError(null);
    if (resendTimerRef.current) {
      clearInterval(resendTimerRef.current);
      resendTimerRef.current = null;
    }
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("Not signed in.");
      const res = await resilientFetch(`/api/auth/users/${user.id}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName, lastName, email, phone, practiceName, username }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Save failed (${res.status})`);
      }
    },
    onSuccess: async () => {
      const phoneChanged = phone !== (user?.phone ?? "");
      setSaved(true);
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      setTimeout(() => setSaved(false), 2500);
      // Auto-start SMS verification when the phone number changes on save.
      if (phoneChanged && phone.trim()) {
        setPhoneVerifyStep("sending");
        setOtpError(null);
        try {
          const codeRes = await resilientFetch("/api/send-phone-code", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: phone.trim() }),
          });
          if (!codeRes.ok) {
            const e = await codeRes.json().catch(() => ({}));
            throw new Error((e as any)?.error || "Failed to send verification code.");
          }
          setPhoneVerifyStep("otp");
          setOtpCode("");
          startResendTimer();
        } catch (err: unknown) {
          setOtpError((err as Error).message || "Failed to send verification code.");
          setPhoneVerifyStep("idle");
        }
      }
    },
    onError: (err: Error) => Alert.alert("Could not save profile", err.message),
  });

  const statusMutation = useMutation({
    mutationFn: async (workStatus: string) => {
      const res = await resilientFetch("/api/auth/me/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workStatus }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_QUERY_KEY }),
  });

  const photoMutation = useMutation({
    mutationFn: async (uri: string) => {
      if (!user?.id) throw new Error("Not signed in.");
      return new Promise<void>((resolve, reject) => {
        const filename = uri.split("/").pop() ?? "photo.jpg";
        const ext = filename.split(".").pop()?.toLowerCase() ?? "jpeg";
        const mime = ext === "png" ? "image/png" : "image/jpeg";
        const base = getApiUrl().replace(/\/api\/?$/, "");
        const url = `${base}/api/auth/users/${user.id}/profile-photo`;
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
        xhr.onerror = () => reject(new Error("Network error"));
        const token = getAccessToken();
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        const fd = new FormData();
        fd.append("photo", { uri, name: filename, type: mime } as unknown as Blob);
        xhr.send(fd);
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_QUERY_KEY }),
    onError: (err: Error) => Alert.alert("Photo upload failed", err.message),
  });

  const logoPlacementsMutation = useMutation({
    mutationFn: async (opts: { placements: string[]; logoPdfSize: string }) => {
      const orgId = user?.practiceOrganizationId;
      if (!orgId) throw new Error("No lab organization found.");
      const res = await resilientFetch(`/api/organizations/${orgId}/logo-placements`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placements: opts.placements, logoPdfSize: opts.logoPdfSize }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setLogoSaved(true);
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      setTimeout(() => setLogoSaved(false), 2000);
    },
    onError: (err: Error) => Alert.alert("Could not save logo settings", err.message),
  });

  async function pickPhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission required", "Allow access to your photo library to upload a profile photo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });
    if (!result.canceled && result.assets[0]) {
      const resized = await ImageManipulator.manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 600, height: 600 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
      );
      photoMutation.mutate(resized.uri);
    }
  }

  async function pickLogo() {
    const orgId = user?.practiceOrganizationId;
    if (!orgId) {
      Alert.alert("No lab found", "You must be an admin of a lab to upload a logo.");
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission required", "Allow access to your photo library to upload a logo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [3, 1],
      quality: 0.9,
    });
    if (result.canceled || !result.assets[0]) return;
    const uri = result.assets[0].uri;
    const filename = uri.split("/").pop() ?? "logo.png";
    const ext = filename.split(".").pop()?.toLowerCase() ?? "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : ext === "webp" ? "image/webp" : "image/png";

    setLogoUploading(true);
    const base = getApiUrl().replace(/\/api\/?$/, "");
    const url = `${base}/api/organizations/${orgId}/logo`;
    const xhr = new XMLHttpRequest();
    logoXhrRef.current = xhr;
    xhr.open("POST", url);
    xhr.onload = () => {
      setLogoUploading(false);
      if (xhr.status < 300) {
        qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      } else {
        try {
          const e = JSON.parse(xhr.responseText);
          Alert.alert("Logo upload failed", e?.error || `Status ${xhr.status}`);
        } catch {
          Alert.alert("Logo upload failed", `Status ${xhr.status}`);
        }
      }
    };
    xhr.onerror = () => {
      setLogoUploading(false);
      Alert.alert("Logo upload failed", "Network error.");
    };
    const logoToken = getAccessToken();
    if (logoToken) xhr.setRequestHeader("Authorization", `Bearer ${logoToken}`);
    const fd = new FormData();
    fd.append("file", { uri, name: filename, type: mime } as unknown as Blob);
    xhr.send(fd);
  }

  function togglePlacement(key: string) {
    setLogoPlacements((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  const currentStatus = WORK_STATUS_OPTIONS.find((s) => s.value === user?.workStatus) ?? WORK_STATUS_OPTIONS[0];
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  const avatarLetter = (fullName || user?.username || "A").charAt(0).toUpperCase();
  const photoUrl = user?.profilePhotoUrl
    ? `${getApiUrl().replace(/\/api\/?$/, "")}${user.profilePhotoUrl}`
    : null;
  const logoUrl = user?.practiceLogoUrl
    ? `${getApiUrl().replace(/\/api\/?$/, "")}${user.practiceLogoUrl}`
    : null;

  return (
    <ScreenShell title="Profile" subtitle="Your personal info" onBack={() => router.back()} insetTop={insets.top}>
      <ScrollView contentContainerStyle={styles.body}>
        {meQuery.isLoading ? (
          <ActivityIndicator color={colors.tint} style={{ marginTop: Spacing.xxl }} />
        ) : (
          <>
            {saved && (
              <View style={[styles.banner, { backgroundColor: colors.success + "20", borderColor: colors.success + "40" }]}>
                <Text style={[styles.bannerText, { color: colors.success }]}>Profile saved.</Text>
              </View>
            )}

            {/* Avatar / photo section */}
            <SettingsSection title="Profile photo">
              <View style={styles.avatarSection}>
                <Pressable onPress={pickPhoto} disabled={photoMutation.isPending} style={styles.avatarWrap}>
                  {photoUrl ? (
                    <Image source={{ uri: photoUrl }} style={styles.avatarImg} />
                  ) : (
                    <View style={[styles.avatarFallback, { backgroundColor: colors.tint + "20" }]}>
                      <Text style={[styles.avatarLetter, { color: colors.tint }]}>{avatarLetter}</Text>
                    </View>
                  )}
                  <View style={[styles.avatarBadge, { backgroundColor: colors.tint }]}>
                    {photoMutation.isPending
                      ? <ActivityIndicator size={10} color="#fff" />
                      : <Ionicons name="camera" size={12} color="#fff" />}
                  </View>
                </Pressable>
                <View style={styles.avatarInfo}>
                  <Text style={[styles.avatarName, { color: colors.text }]}>{fullName || user?.username || "—"}</Text>
                  <Text style={[styles.avatarSub, { color: colors.textSecondary }]}>{user?.email ?? ""}</Text>
                  <Pressable onPress={pickPhoto} disabled={photoMutation.isPending}>
                    <Text style={[styles.avatarLink, { color: colors.tint }]}>
                      {photoMutation.isPending ? "Uploading…" : photoUrl ? "Change photo" : "Upload photo"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </SettingsSection>

            <SettingsSection title="Work status">
              <View style={styles.statusRow}>
                {WORK_STATUS_OPTIONS.map((opt) => {
                  const active = currentStatus.value === opt.value;
                  return (
                    <Pressable
                      key={opt.value}
                      onPress={() => statusMutation.mutate(opt.value)}
                      style={[
                        styles.statusBtn,
                        {
                          backgroundColor: active ? opt.color : colors.surfaceAlt,
                          borderColor: active ? opt.color : colors.border,
                        },
                      ]}
                    >
                      <View style={[styles.statusDot, { backgroundColor: active ? "#fff" : opt.color }]} />
                      <Text style={[styles.statusLabel, { color: active ? "#fff" : colors.textSecondary }]}>
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </SettingsSection>

            <SettingsSection title="Personal info">
              <View style={styles.fieldWrap}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>First name</Text>
                <TextInput
                  value={firstName}
                  onChangeText={setFirstName}
                  style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  placeholderTextColor={colors.textTertiary}
                  placeholder="First name"
                />
              </View>
              <View style={[styles.fieldWrap, styles.fieldDivider, { borderTopColor: colors.border }]}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Last name</Text>
                <TextInput
                  value={lastName}
                  onChangeText={setLastName}
                  style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  placeholderTextColor={colors.textTertiary}
                  placeholder="Last name"
                />
              </View>
              <View style={[styles.fieldWrap, styles.fieldDivider, { borderTopColor: colors.border }]}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Email</Text>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  placeholderTextColor={colors.textTertiary}
                  placeholder="you@example.com"
                />
              </View>

              {/* Phone field with verification */}
              <View style={[styles.fieldWrap, styles.fieldDivider, { borderTopColor: colors.border }]}>
                <View style={styles.phoneRow}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Phone</Text>
                  {isPhoneVerified ? (
                    <View style={[styles.verifiedBadge, { backgroundColor: colors.success + "18", borderColor: colors.success + "40" }]}>
                      <Ionicons name="checkmark-circle" size={12} color={colors.success} />
                      <Text style={[styles.verifiedText, { color: colors.success }]}>Verified</Text>
                    </View>
                  ) : phone.trim() !== "" && phoneVerifyStep === "idle" ? (
                    <View style={[styles.verifiedBadge, { backgroundColor: "#F59E0B18", borderColor: "#F59E0B40" }]}>
                      <Ionicons name="alert-circle-outline" size={12} color="#F59E0B" />
                      <Text style={[styles.verifiedText, { color: "#F59E0B" }]}>Not verified</Text>
                    </View>
                  ) : null}
                </View>
                <TextInput
                  value={phone}
                  onChangeText={(v) => {
                    setPhone(v);
                    if (phoneVerifyStep !== "idle") cancelPhoneVerify();
                  }}
                  keyboardType="phone-pad"
                  editable={phoneVerifyStep === "idle"}
                  style={[
                    styles.input,
                    { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface },
                    phoneVerifyStep !== "idle" && { opacity: 0.6 },
                  ]}
                  placeholderTextColor={colors.textTertiary}
                  placeholder="000-000-0000"
                />

                {/* Verify button — shown when phone is set and not yet verified (or edited) */}
                {phoneVerifyStep === "idle" && phone.trim() !== "" && !isPhoneVerified && (
                  <Pressable
                    style={[
                      styles.verifyBtn,
                      { borderColor: colors.tint, backgroundColor: colors.tint + "12" },
                      resendCountdown > 0 && { opacity: 0.5 },
                    ]}
                    onPress={resendCountdown > 0 ? undefined : handleSendVerificationCode}
                    disabled={resendCountdown > 0}
                  >
                    <Ionicons name="shield-checkmark-outline" size={14} color={colors.tint} />
                    <Text style={[styles.verifyBtnText, { color: colors.tint }]}>
                      {resendCountdown > 0 ? `Try again in ${resendCountdown}s` : "Verify phone number"}
                    </Text>
                  </Pressable>
                )}

                {/* Sending spinner */}
                {phoneVerifyStep === "sending" && (
                  <View style={styles.verifyRow}>
                    <ActivityIndicator size={14} color={colors.tint} />
                    <Text style={[styles.verifyHint, { color: colors.textSecondary }]}>Sending code…</Text>
                  </View>
                )}

                {otpError && phoneVerifyStep === "idle" && (
                  <Text style={[styles.otpError, { color: colors.error }]}>{otpError}</Text>
                )}
              </View>

              {/* OTP entry — rendered below the phone row */}
              {phoneVerifyStep === "otp" && (
                <View style={[styles.otpSection, { borderTopColor: colors.border, backgroundColor: colors.surfaceAlt }]}>
                  <Text style={[styles.otpTitle, { color: colors.text }]}>Enter verification code</Text>
                  <Text style={[styles.otpSubtitle, { color: colors.textSecondary }]}>
                    We sent a 6-digit code to {phone}. Enter it below to verify your number.
                  </Text>
                  <TextInput
                    value={otpCode}
                    onChangeText={setOtpCode}
                    keyboardType="number-pad"
                    maxLength={6}
                    placeholder="000000"
                    placeholderTextColor={colors.textTertiary}
                    style={[styles.otpInput, { color: colors.text, borderColor: colors.tint, backgroundColor: colors.surface }]}
                    autoFocus
                  />
                  {otpError && (
                    <Text style={[styles.otpError, { color: colors.error }]}>{otpError}</Text>
                  )}
                  <View style={styles.otpActions}>
                    <Pressable
                      testID="confirm-otp-btn"
                      style={[styles.otpConfirmBtn, { backgroundColor: colors.tint }]}
                      onPress={otpCode.trim().length !== 6 || isVerifying ? undefined : handleVerifyOtp}
                      disabled={otpCode.trim().length !== 6 || isVerifying}
                    >
                      <Text style={styles.otpConfirmText}>{isVerifying ? "Verifying…" : "Confirm"}</Text>
                    </Pressable>
                    <Pressable
                      testID="resend-otp-btn"
                      style={[styles.otpSecondaryBtn, { borderColor: colors.border }]}
                      onPress={resendCountdown > 0 || resending ? undefined : handleSendVerificationCode}
                      disabled={resendCountdown > 0 || resending}
                    >
                      <Text style={[styles.otpSecondaryText, { color: resendCountdown > 0 || resending ? colors.textTertiary : colors.tint }]}>
                        {resending ? "Sending…" : resendCountdown > 0 ? `Resend (${resendCountdown}s)` : "Resend"}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[styles.otpSecondaryBtn, { borderColor: colors.border }]}
                      onPress={cancelPhoneVerify}
                    >
                      <Text style={[styles.otpSecondaryText, { color: colors.textSecondary }]}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              <View style={[styles.fieldWrap, styles.fieldDivider, { borderTopColor: colors.border }]}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Practice / lab name</Text>
                <TextInput
                  value={practiceName}
                  onChangeText={setPracticeName}
                  style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  placeholderTextColor={colors.textTertiary}
                  placeholder="Lab name"
                />
              </View>
            </SettingsSection>

            <SettingsSection title="Account">
              <View style={styles.fieldWrap}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Username</Text>
                <TextInput
                  value={username}
                  onChangeText={setUsername}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  placeholderTextColor={colors.textTertiary}
                  placeholder="username"
                />
                <Text style={[styles.fieldHint, { color: colors.textTertiary }]}>
                  Minimum 3 characters · used to log in
                </Text>
              </View>
              <View style={[styles.fieldWrap, styles.fieldDivider, { borderTopColor: colors.border }]}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Role</Text>
                <Text style={[styles.readOnly, { color: colors.textSecondary }]}>{user?.role ?? "—"}</Text>
              </View>
              {user?.platformAccountNumber ? (
                <View style={[styles.fieldWrap, styles.fieldDivider, { borderTopColor: colors.border }]}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Account number</Text>
                  <Text style={[styles.readOnly, { color: colors.textSecondary }]}>{user.platformAccountNumber}</Text>
                </View>
              ) : null}
            </SettingsSection>

            {/* Lab branding — admin only */}
            {isAdmin && user?.practiceOrganizationId && (
              <SettingsSection
                title="Lab branding"
                footer="Your lab logo appears on invoices, statements, lab reports, and welcome emails sent to providers."
              >
                {/* Logo preview + upload */}
                <View style={styles.logoRow}>
                  <View style={[styles.logoPreview, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
                    {logoUrl ? (
                      <Image source={{ uri: logoUrl }} style={styles.logoImg} resizeMode="contain" />
                    ) : (
                      <Ionicons name="image-outline" size={28} color={colors.textTertiary} />
                    )}
                  </View>
                  <View style={styles.logoActions}>
                    <Pressable
                      style={[styles.logoUploadBtn, { borderColor: colors.tint, backgroundColor: colors.tint + "15" }]}
                      onPress={pickLogo}
                      disabled={logoUploading}
                    >
                      {logoUploading
                        ? <ActivityIndicator size={14} color={colors.tint} />
                        : <Ionicons name="cloud-upload-outline" size={14} color={colors.tint} />}
                      <Text style={[styles.logoUploadText, { color: colors.tint }]}>
                        {logoUploading ? "Uploading…" : logoUrl ? "Replace logo" : "Upload logo"}
                      </Text>
                    </Pressable>
                    <Text style={[styles.logoHint, { color: colors.textTertiary }]}>
                      PNG, JPG, SVG, WebP · max 5 MB · recommended 3:1 ratio
                    </Text>
                  </View>
                </View>

                {/* Logo size */}
                <View style={[styles.fieldWrap, styles.fieldDivider, { borderTopColor: colors.border }]}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Logo size on documents</Text>
                  <View style={styles.sizeRow}>
                    {LOGO_SIZES.map((s) => {
                      const active = logoSize === s.value;
                      return (
                        <Pressable
                          key={s.value}
                          onPress={() => setLogoSize(s.value)}
                          style={[
                            styles.sizeBtn,
                            {
                              backgroundColor: active ? colors.tint : colors.surfaceAlt,
                              borderColor: active ? colors.tint : colors.border,
                            },
                          ]}
                        >
                          <Text style={[styles.sizeBtnText, { color: active ? "#fff" : colors.textSecondary }]}>
                            {s.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/* Logo placements */}
                <View style={[styles.fieldWrap, styles.fieldDivider, { borderTopColor: colors.border }]}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Show logo on</Text>
                  <View style={styles.placementsGrid}>
                    {LOGO_PLACEMENTS.map((p) => {
                      const active = logoPlacements.includes(p.key);
                      return (
                        <Pressable
                          key={p.key}
                          onPress={() => togglePlacement(p.key)}
                          style={[
                            styles.placementChip,
                            {
                              backgroundColor: active ? colors.tint + "18" : colors.surfaceAlt,
                              borderColor: active ? colors.tint : colors.border,
                            },
                          ]}
                        >
                          <Ionicons
                            name={active ? "checkmark-circle" : "ellipse-outline"}
                            size={14}
                            color={active ? colors.tint : colors.textTertiary}
                          />
                          <Text style={[styles.placementChipText, { color: active ? colors.tint : colors.textSecondary }]}>
                            {p.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                <Pressable
                  style={[styles.logoSaveBtn, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }, logoPlacementsMutation.isPending && { opacity: 0.6 }]}
                  onPress={() => logoPlacementsMutation.mutate({ placements: logoPlacements, logoPdfSize: logoSize })}
                  disabled={logoPlacementsMutation.isPending}
                >
                  {logoSaved
                    ? <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                    : <Ionicons name="save-outline" size={16} color={colors.textSecondary} />}
                  <Text style={[styles.logoSaveBtnText, { color: logoSaved ? colors.success : colors.textSecondary }]}>
                    {logoPlacementsMutation.isPending ? "Saving…" : logoSaved ? "Saved!" : "Save branding"}
                  </Text>
                </Pressable>
              </SettingsSection>
            )}

            <Pressable
              testID="save-profile-btn"
              style={[
                styles.saveBtn,
                { backgroundColor: colors.tint },
                (saveMutation.isPending || phoneVerifyStep === "otp") && { opacity: 0.6 },
              ]}
              onPress={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || phoneVerifyStep === "otp"}
            >
              <Text style={styles.saveBtnText}>
                {saveMutation.isPending ? "Saving…" : "Save profile"}
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl },
    banner: {
      borderRadius: Radius.md,
      borderWidth: 1,
      padding: Spacing.md,
    },
    bannerText: { ...Typography.bodyMedium, textAlign: "center" },

    avatarSection: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.lg,
      padding: Spacing.lg,
    },
    avatarWrap: { position: "relative" },
    avatarImg: { width: 72, height: 72, borderRadius: Radius.full },
    avatarFallback: {
      width: 72,
      height: 72,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarLetter: { ...Typography.display, fontSize: 28 },
    avatarBadge: {
      position: "absolute",
      bottom: 0,
      right: 0,
      width: 24,
      height: 24,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: c.backgroundSolid,
    },
    avatarInfo: { flex: 1, gap: 2 },
    avatarName: { ...Typography.h3 },
    avatarSub: { ...Typography.caption },
    avatarLink: { ...Typography.captionMedium, marginTop: Spacing.xs },

    statusRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: Spacing.sm,
      padding: Spacing.lg,
    },
    statusBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.full,
      borderWidth: 1,
    },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    statusLabel: { ...Typography.captionMedium },
    fieldWrap: { padding: Spacing.lg, gap: Spacing.xs },
    fieldDivider: { borderTopWidth: StyleSheet.hairlineWidth },
    fieldLabel: { ...Typography.captionSemibold },
    fieldHint: { ...Typography.tiny, marginTop: 2 },
    input: {
      borderWidth: 1,
      borderRadius: Radius.sm,
      padding: Spacing.md,
      ...Typography.body,
    },
    readOnly: { ...Typography.body, paddingTop: 2 },

    // Phone verification styles
    phoneRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    verifiedBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: Radius.full,
      borderWidth: 1,
    },
    verifiedText: { ...Typography.tiny, fontWeight: "600" },
    verifyBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      marginTop: Spacing.xs,
    },
    verifyBtnText: { ...Typography.captionMedium },
    verifyRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    verifyHint: { ...Typography.caption },

    otpSection: {
      padding: Spacing.lg,
      gap: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    otpTitle: { ...Typography.bodyMedium },
    otpSubtitle: { ...Typography.caption },
    otpInput: {
      borderWidth: 2,
      borderRadius: Radius.sm,
      padding: Spacing.md,
      ...Typography.h2,
      textAlign: "center",
      letterSpacing: 6,
    },
    otpError: { ...Typography.caption },
    otpActions: {
      flexDirection: "row",
      gap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    otpConfirmBtn: {
      flex: 1,
      borderRadius: Radius.sm,
      padding: Spacing.sm,
      alignItems: "center",
    },
    otpConfirmText: { ...Typography.captionSemibold, color: "#fff" },
    otpSecondaryBtn: {
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      alignItems: "center",
    },
    otpSecondaryText: { ...Typography.captionMedium },

    logoRow: {
      flexDirection: "row",
      gap: Spacing.md,
      padding: Spacing.lg,
      alignItems: "flex-start",
    },
    logoPreview: {
      width: 80,
      height: 40,
      borderRadius: Radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    logoImg: { width: 76, height: 36, borderRadius: Radius.sm },
    logoActions: { flex: 1, gap: Spacing.xs },
    logoUploadBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
    },
    logoUploadText: { ...Typography.captionMedium },
    logoHint: { ...Typography.tiny },
    sizeRow: { flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.xs },
    sizeBtn: {
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.sm,
      borderWidth: 1,
    },
    sizeBtnText: { ...Typography.captionMedium },
    placementsGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    placementChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      borderWidth: 1,
      borderRadius: Radius.full,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 4,
    },
    placementChipText: { ...Typography.tiny },
    logoSaveBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      margin: Spacing.lg,
      marginTop: 0,
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingVertical: Spacing.sm,
    },
    logoSaveBtnText: { ...Typography.captionMedium },

    saveBtn: {
      borderRadius: Radius.md,
      padding: Spacing.md,
      alignItems: "center",
    },
    saveBtnText: { ...Typography.bodySemibold, color: "#fff" },
  });
}
