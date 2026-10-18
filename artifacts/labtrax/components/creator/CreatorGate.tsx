import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import {
  CREATOR_ACCESS_KEY, CREATOR_PIN_LENGTH, CREATOR_SETUP_MESSAGE, creatorAccessKey, type CreatorAccess, creatorErrorMessage, creatorJson, useCreatorAccess,
} from "@/lib/creator";
import { useAuth } from "@/lib/auth-context";
import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";

/** Digits-only PIN field: fires onComplete exactly once per completed value. */
export function PinInput({ onComplete, busy, error, testID = "creator-pin-input" }: {
  onComplete: (pin: string) => void; busy?: boolean; error?: string | null; testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [value, setValue] = useState("");
  const sent = useRef<string | null>(null);
  const cb = useRef(onComplete);
  cb.current = onComplete;
  function change(raw: string) {
    if (busy) return;
    const digits = raw.replace(/\D/g, "").slice(0, CREATOR_PIN_LENGTH);
    setValue(digits);
    if (digits.length < CREATOR_PIN_LENGTH) { sent.current = null; return; }
    if (sent.current === digits) return;
    sent.current = digits;
    cb.current(digits);
  }
  return (
    <View>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={change}
        editable={!busy}
        keyboardType="number-pad"
        secureTextEntry
        autoComplete="off"
        textContentType="none"
        autoCorrect={false}
        autoFocus
        maxLength={CREATOR_PIN_LENGTH * 2}
        placeholder="•••••••"
        placeholderTextColor={colors.textTertiary}
        style={styles.pin}
      />
      {error ? <Text testID="creator-pin-error" style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function CreatorGate({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const access = useCreatorAccess();
  const { currentUserId } = useAuth();
  const accessKey = creatorAccessKey(currentUserId);
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  const expiresAt = access.data?.unlocked ? access.data.expiresAt : null;
  // Idle expiry: re-lock visibly at the deadline and re-read capability.
  useEffect(() => {
    if (!expiresAt) return;
    const fire = () => { setExpiredFor(expiresAt); void qc.invalidateQueries({ queryKey: CREATOR_ACCESS_KEY }); };
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) { fire(); return; }
    const t = setTimeout(fire, Math.min(ms, 2_147_000_000));
    return () => clearTimeout(t);
  }, [expiresAt, qc]);
  const [err, setErr] = useState<string | null>(null);
  const submitting = useRef(false);
  const unlock = useMutation({
    mutationFn: (pin: string) => creatorJson<{ expiresAt?: string }>("POST", "/creator/unlock", { pin }),
    onSuccess: (r) => {
      setErr(null);
      qc.setQueryData<CreatorAccess>(accessKey, (old) => old ? { ...old, unlocked: true, expiresAt: r?.expiresAt ?? old.expiresAt } : old);
      void qc.invalidateQueries({ queryKey: CREATOR_ACCESS_KEY });
    },
    onError: (e) => setErr(creatorErrorMessage(e)),
    onSettled: () => { submitting.current = false; },
  });
  const denied = access.isSuccess && !access.data.isCreator;
  useEffect(() => { if (denied) router.replace("/settings" as never); }, [denied]);

  if (access.isLoading || denied) {
    return <View style={styles.center}><ActivityIndicator color={colors.tint} /></View>;
  }
  if (access.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Could not verify access.</Text>
        <Pressable onPress={() => void access.refetch()} style={styles.btn} testID="creator-retry"><Text style={styles.btnText}>Retry</Text></Pressable>
      </View>
    );
  }
  if (access.data?.unlocked && !(expiredFor && expiredFor === access.data.expiresAt)) return <>{children}</>;
  return (
    <DismissKeyboardView style={[styles.center, { paddingTop: insets.top }]} testID="creator-gate">
      <Text style={styles.title}>Creator console</Text>
      <Text style={styles.sub} testID={access.data?.pinConfigured ? undefined : "creator-pin-unprovisioned"}>
        {access.data?.pinConfigured ? "Enter your 7-digit PIN. It verifies automatically." : CREATOR_SETUP_MESSAGE}
      </Text>
      {access.data?.pinConfigured && (
        <View style={styles.box}><PinInput busy={unlock.isPending} error={err} onComplete={(p) => {
          if (submitting.current) return;
          submitting.current = true;
          unlock.mutate(p);
        }} /></View>
      )}
      <Pressable onPress={() => router.back()} style={styles.link} testID="creator-gate-back"><Text style={styles.linkText}>Go back</Text></Pressable>
    </DismissKeyboardView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl, backgroundColor: c.backgroundSolid },
  title: { ...Typography.h1, color: c.text, marginBottom: 6 },
  sub: { color: c.textSecondary, textAlign: "center", marginBottom: Spacing.lg },
  box: { width: "100%", maxWidth: 280 },
  pin: { height: 56, borderRadius: Radius.md, borderWidth: 1, borderColor: c.border, color: c.text, textAlign: "center", fontSize: 26, letterSpacing: 8 },
  error: { color: "#EF4444", marginTop: 8, textAlign: "center" },
  btn: { marginTop: 12, paddingHorizontal: 18, paddingVertical: 10, borderRadius: Radius.md, backgroundColor: c.tint },
  btnText: { color: "#fff", fontWeight: "600" },
  link: { marginTop: Spacing.lg },
  linkText: { color: c.tint },
});
