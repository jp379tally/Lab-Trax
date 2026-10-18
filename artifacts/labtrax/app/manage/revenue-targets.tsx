// Revenue Targets — mobile screen for admins to set monthly low/high revenue
// thresholds that drive the green/yellow/red colour bands in Stats and Reports.
//
// Saves via PATCH /api/organizations/:id (revenueTargetLow / revenueTargetHigh).
// On success invalidates the ["org-settings", orgId] key so Stats and Reports
// recolour immediately without a manual refresh.
import React, { useMemo, useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import { getJson, sendJson, isForbiddenError } from "@/lib/read-api";
import { useMe, adminLabMemberships } from "@/lib/auth-me";
import { formatMoney } from "@/lib/format";

interface OrgSettings {
  revenueTargetLow?: number | null;
  revenueTargetHigh?: number | null;
}

function parseDollarInput(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  if (!cleaned || Number.isNaN(n) || n < 0) return null;
  return Math.round(n);
}

function formatDollarInput(v: number | null | undefined): string {
  if (v == null) return "";
  return String(v);
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    outer: { flex: 1, backgroundColor: colors.background },
    screen: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.backgroundSolid,
    },
    backBtn: { padding: 4 },
    headerText: { flex: 1, marginLeft: Spacing.sm },
    headerTitle: { ...Typography.h3, color: colors.text },
    headerSubtitle: { ...Typography.caption, color: colors.textSecondary, marginTop: 2 },
    content: { padding: Spacing.md, paddingBottom: 40 },
    section: { marginBottom: Spacing.lg },
    sectionTitle: {
      ...Typography.bodySemibold,
      color: colors.textSecondary,
      marginBottom: Spacing.sm,
      textTransform: "uppercase",
      fontSize: 11,
      letterSpacing: 0.5,
    },
    card: {
      backgroundColor: colors.backgroundSolid,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: Spacing.md,
      marginBottom: Spacing.sm,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: Spacing.md,
    },
    labelBlock: { flex: 1, marginRight: Spacing.md },
    labelText: { ...Typography.body, color: colors.text },
    labelHint: { ...Typography.caption, color: colors.textSecondary, marginTop: 2 },
    inputWrap: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.background,
      borderRadius: Radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: Spacing.sm,
      height: 40,
      minWidth: 110,
    },
    inputPrefix: { ...Typography.body, color: colors.textSecondary, marginRight: 2 },
    input: {
      ...Typography.body,
      color: colors.text,
      flex: 1,
      padding: 0,
    },
    divider: {
      height: 1,
      backgroundColor: colors.border,
      marginBottom: Spacing.md,
    },
    saveBtn: {
      backgroundColor: colors.tint,
      borderRadius: Radius.md,
      paddingVertical: 13,
      alignItems: "center",
      marginTop: Spacing.sm,
    },
    saveBtnDisabled: { opacity: 0.5 },
    saveBtnText: { ...Typography.bodySemibold, color: "#fff" },
    infoCard: {
      backgroundColor: colors.backgroundSolid,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: Spacing.md,
      marginBottom: Spacing.sm,
    },
    infoText: { ...Typography.caption, color: colors.textSecondary, lineHeight: 18 },
    errorText: { ...Typography.caption, color: "#ef4444", marginTop: Spacing.sm },
    blockedText: { ...Typography.body, color: colors.textSecondary, textAlign: "center", marginTop: 40 },
    previewRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      marginTop: Spacing.xs,
    },
    dot: { width: 10, height: 10, borderRadius: 5 },
    previewLabel: { ...Typography.caption, color: colors.textSecondary },
  });
}

export default function RevenueTargetsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const meQuery = useMe();
  const me = meQuery.data;

  const adminLabs = useMemo(() => adminLabMemberships(me), [me]);
  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const labId = selectedLabId ?? adminLabs[0]?.organizationId ?? null;
  const isAdmin = adminLabs.length > 0;

  const orgQuery = useQuery<OrgSettings>({
    queryKey: ["org-settings", labId ?? ""],
    queryFn: async () => {
      const data = await getJson<{ data: OrgSettings }>(`/api/organizations/${labId!}`);
      return data.data ?? data;
    },
    staleTime: 60_000,
    enabled: !!labId && isAdmin,
  });

  const [lowInput, setLowInput] = useState("");
  const [highInput, setHighInput] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (orgQuery.data && !dirty) {
      setLowInput(formatDollarInput(orgQuery.data.revenueTargetLow ?? 85_000));
      setHighInput(formatDollarInput(orgQuery.data.revenueTargetHigh ?? 95_000));
    }
  }, [orgQuery.data, dirty]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!labId) throw new Error("No lab selected.");
      const low = parseDollarInput(lowInput);
      const high = parseDollarInput(highInput);
      if (low === null) throw new Error("Low target must be a valid dollar amount.");
      if (high === null) throw new Error("High target must be a valid dollar amount.");
      if (high < low) throw new Error("High target must be greater than or equal to the low target.");
      return sendJson("PATCH", `/api/organizations/${encodeURIComponent(labId)}`, {
        revenueTargetLow: low,
        revenueTargetHigh: high,
      });
    },
    onSuccess: () => {
      setSaveError(null);
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ["org-settings", labId] });
    },
    onError: (err: Error) => {
      setSaveError(err.message || "Could not save revenue targets.");
    },
  });

  function handleSave() {
    setSaveError(null);
    saveMutation.mutate();
  }

  const isForbidden = isForbiddenError(orgQuery.error);
  const isBlocked = !meQuery.isLoading && !isAdmin;

  const lowParsed = parseDollarInput(lowInput);
  const highParsed = parseDollarInput(highInput);
  const isValidRange =
    lowParsed !== null && highParsed !== null && highParsed >= lowParsed;

  const hasMultipleLabs = adminLabs.length > 1;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <DismissKeyboardView
        style={[styles.outer, { paddingTop: insets.top }]}
        testID="revenue-targets-keyboard-dismiss"
      >
        <View style={styles.header}>
          <Pressable
            style={styles.backBtn}
            onPress={() => router.back()}
            hitSlop={8}
            testID="revenue-targets-back"
          >
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </Pressable>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Revenue Targets</Text>
            <Text style={styles.headerSubtitle}>Monthly low / high thresholds</Text>
          </View>
          {orgQuery.isFetching && <ActivityIndicator size="small" color={colors.tint} />}
        </View>

        {isBlocked || isForbidden ? (
          <Text style={styles.blockedText}>Admin access required.</Text>
        ) : (
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={scrollKeyboardDismissMode}
          >
            {hasMultipleLabs && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Lab</Text>
                {adminLabs.map((m) => (
                  <Card
                    key={m.organizationId}
                    style={[
                      styles.card,
                      m.organizationId === labId && { borderColor: colors.tint },
                    ]}
                    onPress={() => {
                      setSelectedLabId(m.organizationId ?? null);
                      setDirty(false);
                    }}
                  >
                    <Text style={styles.labelText}>
                      {((m as unknown as Record<string, unknown>).organizationName as string | undefined) ?? m.organizationId}
                    </Text>
                  </Card>
                ))}
              </View>
            )}

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Monthly targets</Text>
              <View style={styles.card}>
                <View style={styles.row}>
                  <View style={styles.labelBlock}>
                    <Text style={styles.labelText}>Low threshold</Text>
                    <Text style={styles.labelHint}>Yellow band starts here</Text>
                  </View>
                  <View style={styles.inputWrap}>
                    <Text style={styles.inputPrefix}>$</Text>
                    <TextInput
                      style={styles.input}
                      value={lowInput}
                      onChangeText={(t) => { setLowInput(t); setDirty(true); setSaveError(null); }}
                      keyboardType="numeric"
                      placeholder="85000"
                      placeholderTextColor={colors.textSecondary}
                      testID="revenue-target-low-input"
                      selectTextOnFocus
                    />
                  </View>
                </View>

                <View style={styles.divider} />

                <View style={styles.row}>
                  <View style={styles.labelBlock}>
                    <Text style={styles.labelText}>High threshold</Text>
                    <Text style={styles.labelHint}>Green band starts here</Text>
                  </View>
                  <View style={styles.inputWrap}>
                    <Text style={styles.inputPrefix}>$</Text>
                    <TextInput
                      style={styles.input}
                      value={highInput}
                      onChangeText={(t) => { setHighInput(t); setDirty(true); setSaveError(null); }}
                      keyboardType="numeric"
                      placeholder="95000"
                      placeholderTextColor={colors.textSecondary}
                      testID="revenue-target-high-input"
                      selectTextOnFocus
                    />
                  </View>
                </View>

                {lowParsed !== null && highParsed !== null && isValidRange && (
                  <View style={{ marginTop: Spacing.xs }}>
                    <View style={styles.previewRow}>
                      <View style={[styles.dot, { backgroundColor: "#ef4444" }]} />
                      <Text style={styles.previewLabel}>
                        Below {formatMoney(lowParsed)} — behind target
                      </Text>
                    </View>
                    <View style={styles.previewRow}>
                      <View style={[styles.dot, { backgroundColor: "#eab308" }]} />
                      <Text style={styles.previewLabel}>
                        {formatMoney(lowParsed)} – {formatMoney(highParsed)} — on track
                      </Text>
                    </View>
                    <View style={styles.previewRow}>
                      <View style={[styles.dot, { backgroundColor: "#22c55e" }]} />
                      <Text style={styles.previewLabel}>
                        Above {formatMoney(highParsed)} — exceeding target
                      </Text>
                    </View>
                  </View>
                )}

                {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}

                <Pressable
                  style={[
                    styles.saveBtn,
                    (!isValidRange || saveMutation.isPending) && styles.saveBtnDisabled,
                    { marginTop: Spacing.md },
                  ]}
                  onPress={handleSave}
                  disabled={!isValidRange || saveMutation.isPending}
                  testID="revenue-targets-save"
                >
                  {saveMutation.isPending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.saveBtnText}>
                      {saveMutation.isSuccess && !dirty ? "Saved" : "Save targets"}
                    </Text>
                  )}
                </Pressable>
              </View>
            </View>

            <View style={styles.infoCard}>
              <Text style={styles.infoText}>
                These monthly targets set the colour bands on the Stats and Reports
                revenue charts. Day and week bands are scaled automatically from the
                monthly value. Changes take effect immediately after saving.
              </Text>
            </View>
          </ScrollView>
        )}
      </DismissKeyboardView>
    </KeyboardAvoidingView>
  );
}
