import React, { useMemo, useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell } from "@/components/settings/SettingsRow";
import { scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { resilientFetch } from "@/lib/query-client";
import { useMe, primaryOwnerLabOrgId } from "@/lib/auth-me";

interface LabProfile {
  id: string;
  name: string;
  displayName: string | null;
  billingEmail: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  licenseNumber: string | null;
}

export default function OwnerLabProfileScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const me = useMe();
  const orgId = primaryOwnerLabOrgId(me.data);

  const [form, setForm] = useState<Partial<LabProfile>>({});
  const [saved, setSaved] = useState(false);

  const query = useQuery<LabProfile>({
    queryKey: ["owner", "lab-profile", orgId],
    queryFn: async () => {
      const res = await resilientFetch(`/api/owner/lab-profile?organizationId=${orgId}`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      return body.data ?? body;
    },
    enabled: !!orgId,
  });

  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: async (data: Partial<LabProfile> & { organizationId: string }) => {
      const res = await resilientFetch("/api/owner/lab-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message ?? `Failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["owner", "lab-profile", orgId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e: Error) => {
      Alert.alert("Error", e.message);
    },
  });

  function setField(key: keyof LabProfile, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  if (!orgId) {
    return (
      <ScreenShell title="Lab Profile" onBack={() => router.back()}>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={32} color={colors.textTertiary} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            Owner access required.
          </Text>
        </View>
      </ScreenShell>
    );
  }

  if (query.isLoading) {
    return (
      <ScreenShell title="Lab Profile" onBack={() => router.back()}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.tint} />
        </View>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell title="Lab Profile" onBack={() => router.back()}>
      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode={scrollKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {renderField("Lab Name", "name", form.name, setField, colors)}
          {renderField("Display Name", "displayName", form.displayName, setField, colors, "Overrides name in PDFs")}
          {renderField("Billing Email", "billingEmail", form.billingEmail, setField, colors, "", "email-address")}
          {renderField("Phone", "phone", form.phone, setField, colors, "", "phone-pad")}
          {renderField("Address Line 1", "addressLine1", form.addressLine1, setField, colors)}
          {renderField("Address Line 2", "addressLine2", form.addressLine2, setField, colors)}
          <View style={styles.row}>
            <View style={styles.flex1}>
              {renderField("City", "city", form.city, setField, colors)}
            </View>
            <View style={styles.flex1}>
              {renderField("State", "state", form.state, setField, colors)}
            </View>
            <View style={styles.flex1}>
              {renderField("ZIP", "zip", form.zip, setField, colors)}
            </View>
          </View>
          {renderField("License Number", "licenseNumber", form.licenseNumber, setField, colors)}
        </View>

        {saved && (
          <View style={[styles.savedBanner, { backgroundColor: colors.success + "20", borderColor: colors.success }]}>
            <Ionicons name="checkmark-circle-outline" size={16} color={colors.success} />
            <Text style={[styles.savedText, { color: colors.success }]}>Saved successfully.</Text>
          </View>
        )}

        <Pressable
          style={[styles.saveBtn, { backgroundColor: colors.tint }, mutation.isPending && styles.disabledBtn]}
          disabled={mutation.isPending}
          onPress={() => mutation.mutate({ ...form, organizationId: orgId } as any)}
        >
          {mutation.isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>Save Changes</Text>
          )}
        </Pressable>
      </ScrollView>
    </ScreenShell>
  );
}

function renderField(
  label: string,
  key: string,
  value: string | null | undefined,
  setField: (k: any, v: string) => void,
  colors: ThemeColors,
  placeholder?: string,
  keyboardType?: any
) {
  return (
    <View style={{ marginBottom: Spacing.md }}>
      <Text style={{ ...Typography.caption, color: colors.textSecondary, marginBottom: 4 }}>
        {label}
      </Text>
      <TextInput
        value={value ?? ""}
        onChangeText={(v) => setField(key, v)}
        placeholder={placeholder ?? ""}
        placeholderTextColor={colors.textTertiary}
        keyboardType={keyboardType ?? "default"}
        style={{
          ...Typography.body,
          color: colors.text,
          backgroundColor: colors.backgroundSolid,
          borderColor: colors.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: Radius.sm,
          paddingHorizontal: Spacing.md,
          paddingVertical: Spacing.sm,
          height: 40,
        }}
      />
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl },
    section: {
      borderRadius: Radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      padding: Spacing.lg,
    },
    row: { flexDirection: "row", gap: Spacing.sm },
    flex1: { flex: 1 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 80, gap: Spacing.md },
    emptyText: { ...Typography.body, textAlign: "center" },
    savedBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      padding: Spacing.sm,
    },
    savedText: { ...Typography.caption },
    saveBtn: {
      height: 44,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
      marginTop: Spacing.sm,
    },
    disabledBtn: { opacity: 0.6 },
    saveBtnText: { ...Typography.bodySemibold, color: "#fff" },
  });
}
