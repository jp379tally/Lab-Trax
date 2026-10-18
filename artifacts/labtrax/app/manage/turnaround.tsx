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
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { useMe, adminLabMemberships, ME_QUERY_KEY } from "@/lib/auth-me";
import { resilientFetch } from "@/lib/query-client";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";

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
      minWidth: 80,
    },
    input: {
      ...Typography.body,
      color: colors.text,
      flex: 1,
      padding: 0,
      minWidth: 44,
      textAlign: "right",
    },
    inputSuffix: { ...Typography.body, color: colors.textSecondary, marginLeft: 4 },
    divider: {
      height: 1,
      backgroundColor: colors.border,
      marginVertical: Spacing.md,
    },
    toggleRow: {
      flexDirection: "row",
      alignItems: "center",
    },
    toggle: {
      width: 44,
      height: 26,
      borderRadius: 13,
      padding: 3,
      justifyContent: "center",
    },
    toggleThumb: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: "#fff",
    },
    saveBtn: {
      backgroundColor: colors.tint,
      borderRadius: Radius.md,
      paddingVertical: 13,
      alignItems: "center",
      marginTop: Spacing.md,
    },
    saveBtnDisabled: { opacity: 0.5 },
    saveBtnText: { ...Typography.bodySemibold, color: "#fff" },
    infoCard: {
      backgroundColor: colors.backgroundSolid,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: Spacing.md,
      marginTop: Spacing.sm,
    },
    infoText: { ...Typography.caption, color: colors.textSecondary, lineHeight: 18 },
    savedText: { ...Typography.caption, color: colors.success, marginTop: 4 },
    warnText: { ...Typography.caption, color: colors.warning, marginTop: 4 },
    blockedText: { ...Typography.body, color: colors.textSecondary, textAlign: "center", marginTop: 40 },
  });
}

export default function TurnaroundScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const meQuery = useMe();
  const me = meQuery.data;
  const adminLabs = useMemo(() => adminLabMemberships(me), [me]);
  const isAdmin = adminLabs.length > 0;

  const labMembership = adminLabs[0];
  const org = labMembership?.organization as Record<string, unknown> | undefined;
  const orgId: string = (org?.id as string | undefined) ?? labMembership?.organizationId ?? "";

  const [dueDays, setDueDays] = useState<string>(
    org?.defaultCaseDueDays != null ? String(org.defaultCaseDueDays) : ""
  );
  const [capEnabled, setCapEnabled] = useState<boolean>(
    !!(org as Record<string, unknown> | undefined)?.capCaseDueToDefault
  );

  useEffect(() => {
    if (org) {
      setDueDays(org.defaultCaseDueDays != null ? String(org.defaultCaseDueDays) : "");
      setCapEnabled(!!(org.capCaseDueToDefault));
    }
  }, [org?.id]);

  const [daysSaved, setDaysSaved] = useState(false);
  const [capSaved, setCapSaved] = useState(false);

  const dueDaysMutation = useMutation({
    mutationFn: async (value: number | null) => {
      if (!orgId) throw new Error("Unknown org ID.");
      const res = await resilientFetch(`/api/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultCaseDueDays: value }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setDaysSaved(true);
      void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      setTimeout(() => setDaysSaved(false), 2500);
    },
    onError: (err: Error) => Alert.alert("Could not save turnaround days", err.message),
  });

  const capMutation = useMutation({
    mutationFn: async (value: boolean) => {
      if (!orgId) throw new Error("Unknown org ID.");
      const res = await resilientFetch(`/api/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capCaseDueToDefault: value }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setCapSaved(true);
      void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      setTimeout(() => setCapSaved(false), 2500);
    },
    onError: (err: Error) => Alert.alert("Could not save cap setting", err.message),
  });

  function handleSaveDays() {
    const val = dueDays.trim();
    const num = val === "" ? null : parseInt(val, 10);
    if (num !== null && (isNaN(num) || num < 1 || num > 365)) {
      Alert.alert("Invalid value", "Enter a number between 1 and 365.");
      return;
    }
    dueDaysMutation.mutate(num);
  }

  function handleToggleCap() {
    if (!org?.defaultCaseDueDays) {
      Alert.alert("Set a turnaround first", "Save a default turnaround days value above before enabling this cap.");
      return;
    }
    const next = !capEnabled;
    setCapEnabled(next);
    capMutation.mutate(next);
  }

  if (!meQuery.isLoading && !isAdmin) {
    return (
      <DismissKeyboardView
        style={[styles.screen, { paddingTop: insets.top }]}
        testID="turnaround-keyboard-dismiss"
      >
        <View style={styles.header}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </Pressable>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Case Turnaround</Text>
          </View>
        </View>
        <Text style={styles.blockedText}>Admin access required.</Text>
      </DismissKeyboardView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <DismissKeyboardView
        style={[styles.outer, { paddingTop: insets.top }]}
        testID="turnaround-keyboard-dismiss"
      >
        <View style={styles.header}>
          <Pressable
            style={styles.backBtn}
            onPress={() => router.back()}
            hitSlop={8}
            testID="turnaround-back"
          >
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </Pressable>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Case Turnaround</Text>
            <Text style={styles.headerSubtitle}>Default due date settings for new cases</Text>
          </View>
          {(meQuery.isFetching || dueDaysMutation.isPending || capMutation.isPending) && (
            <ActivityIndicator size="small" color={colors.tint} />
          )}
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={scrollKeyboardDismissMode}
          testID="turnaround-scroll"
        >
          <Text style={styles.sectionTitle}>Default turnaround</Text>
          <View style={styles.card}>
            <View style={styles.row}>
              <View style={styles.labelBlock}>
                <Text style={styles.labelText}>Default due days</Text>
                <Text style={styles.labelHint}>
                  Days after the created date to set as due date on new cases. Leave blank for no default.
                </Text>
                {daysSaved && <Text style={styles.savedText}>Saved</Text>}
              </View>
              <View style={styles.inputWrap}>
                <TextInput
                  style={styles.input}
                  value={dueDays}
                  onChangeText={setDueDays}
                  keyboardType="number-pad"
                  placeholder="—"
                  placeholderTextColor={colors.textSecondary}
                  maxLength={3}
                  testID="turnaround-days-input"
                  selectTextOnFocus
                />
                <Text style={styles.inputSuffix}>days</Text>
              </View>
            </View>

            <Pressable
              style={[
                styles.saveBtn,
                dueDaysMutation.isPending && styles.saveBtnDisabled,
              ]}
              onPress={handleSaveDays}
              disabled={dueDaysMutation.isPending}
              testID="turnaround-days-save"
            >
              {dueDaysMutation.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.saveBtnText}>Save turnaround days</Text>
              )}
            </Pressable>
          </View>

          <Text style={[styles.sectionTitle, { marginTop: Spacing.md }]}>Due date cap</Text>
          <View style={styles.card}>
            <View style={styles.toggleRow}>
              <View style={styles.labelBlock}>
                <Text style={styles.labelText}>Never set a due date later than my turnaround</Text>
                <Text style={styles.labelHint}>
                  When enabled, a doctor-requested date further out than your turnaround is capped at the turnaround date.
                </Text>
                {!org?.defaultCaseDueDays && (
                  <Text style={styles.warnText}>Save a turnaround days value above to enable this.</Text>
                )}
                {capSaved && <Text style={styles.savedText}>Saved</Text>}
              </View>
              <Pressable
                onPress={handleToggleCap}
                disabled={capMutation.isPending}
                style={[
                  styles.toggle,
                  { backgroundColor: capEnabled ? colors.tint : colors.border },
                  capMutation.isPending && { opacity: 0.6 },
                ]}
                testID="turnaround-cap-toggle"
              >
                <View
                  style={[
                    styles.toggleThumb,
                    { alignSelf: capEnabled ? "flex-end" : "flex-start" },
                  ]}
                />
              </Pressable>
            </View>
          </View>

          <View style={styles.infoCard}>
            <Text style={styles.infoText}>
              These settings control how due dates are assigned when a new case arrives. The turnaround window starts from the date the case is created. Changes apply to new cases only — existing cases keep their current due dates.
            </Text>
          </View>
        </ScrollView>
      </DismissKeyboardView>
    </KeyboardAvoidingView>
  );
}
