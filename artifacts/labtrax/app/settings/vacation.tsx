import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Alert,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { getJson, sendJson } from "@/lib/read-api";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";

interface VacationBalance {
  id?: string | null;
  labId: string;
  userId: string;
  year: number;
  annualVacationHours: string;
  usedVacationHours: string;
  pendingVacationHours: string;
}

interface VacationRequestDay {
  id: string;
  date: string;
  isAllDay: boolean;
  startTime?: string | null;
  endTime?: string | null;
}

interface VacationRequest {
  id: string;
  totalRequestedHours: string;
  reason?: string | null;
  status: "pending" | "approved" | "denied" | "cancelled";
  adminDecisionNote?: string | null;
  createdAt: string;
  days: VacationRequestDay[];
}

function fmtHours(h: string | number) {
  const n = Number(h);
  return Number.isNaN(n) ? "—" : `${n.toFixed(1)} h`;
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateShort(d: string) {
  try {
    const dt = new Date(d + "T00:00:00");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    return `${mm}/${dd}`;
  } catch {
    return d;
  }
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#f59e0b",
  approved: "#10b981",
  denied: "#ef4444",
  cancelled: "#6b7280",
};

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.backgroundSolid,
    },
    headerTitle: { ...Typography.h3, color: colors.text, marginLeft: Spacing.sm, flex: 1 },
    backBtn: { padding: 4 },
    balanceRow: { flexDirection: "row", gap: Spacing.xs, marginBottom: Spacing.md },
    balanceChip: {
      flex: 1,
      alignItems: "center",
      padding: Spacing.md,
      borderRadius: Radius.md,
      backgroundColor: colors.backgroundSolid,
      borderWidth: 1,
      borderColor: colors.border,
    },
    balanceLabel: { ...Typography.caption, color: colors.textTertiary },
    balanceValue: { ...Typography.h3, color: colors.text, fontWeight: "700" },
    section: { marginBottom: Spacing.md },
    sectionTitle: { ...Typography.bodySemibold, color: colors.textSecondary, marginBottom: Spacing.sm },
    card: {
      backgroundColor: colors.backgroundSolid,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: Spacing.sm,
      padding: Spacing.md,
    },
    statusBadge: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 99,
      alignSelf: "flex-start",
      marginBottom: Spacing.xs,
    },
    statusText: { fontSize: 11, fontWeight: "700", color: "#fff" },
    metaText: { ...Typography.caption, color: colors.textSecondary },
    bodyText: { ...Typography.body, color: colors.text },
    addCard: {
      backgroundColor: colors.backgroundSolid,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: Spacing.md,
      marginBottom: Spacing.md,
    },
    addTitle: { ...Typography.bodySemibold, color: colors.text, marginBottom: Spacing.sm },
    label: { ...Typography.caption, color: colors.textSecondary, marginBottom: 4 },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.sm,
      padding: Spacing.sm,
      color: colors.text,
      backgroundColor: colors.background,
      ...Typography.body,
      marginBottom: Spacing.sm,
    },
    dayRow: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: Spacing.sm,
      gap: Spacing.sm,
    },
    toggleBtn: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: 6,
      borderRadius: Radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
    },
    submitBtn: {
      backgroundColor: colors.tint,
      borderRadius: Radius.sm,
      padding: Spacing.sm,
      alignItems: "center",
      marginTop: Spacing.sm,
    },
    submitBtnText: { color: "#fff", fontWeight: "700", ...Typography.body },
    cancelBtn: { marginTop: Spacing.sm, alignItems: "center" },
    cancelBtnText: { color: "#ef4444", ...Typography.bodyMedium },
    addDayBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
    addDayText: { color: colors.tint, ...Typography.bodyMedium },
    emptyText: { ...Typography.body, color: colors.textSecondary, textAlign: "center", padding: Spacing.lg },
    divider: { height: 1, backgroundColor: colors.border, marginVertical: Spacing.xs },
  });
}

interface DayEntry {
  date: string;
  isAllDay: boolean;
  startTime: string;
  endTime: string;
}

export default function VacationEmployeeScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const meQuery = useMe();
  const me = meQuery.data;
  const orgId = useMemo(() => primaryLabOrgId(me), [me]);

  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [days, setDays] = useState<DayEntry[]>([
    { date: todayYmd(), isAllDay: true, startTime: "09:00", endTime: "17:00" },
  ]);
  const [formError, setFormError] = useState<string | null>(null);

  const balanceQuery = useQuery<VacationBalance>({
    enabled: !!orgId,
    queryKey: ["vacation-balance-mine", orgId],
    queryFn: () =>
      getJson(`/api/vacation/balances/mine?organizationId=${encodeURIComponent(orgId!)}`),
    staleTime: 30_000,
  });

  const requestsQuery = useQuery<VacationRequest[]>({
    enabled: !!orgId,
    queryKey: ["vacation-requests-mine", orgId],
    queryFn: () =>
      getJson(`/api/vacation/requests/mine?organizationId=${encodeURIComponent(orgId!)}`),
    staleTime: 30_000,
  });

  const submitMutation = useMutation({
    mutationFn: () => {
      if (!orgId) throw new Error("No lab membership found.");
      return sendJson("POST", "/api/vacation/requests", {
        organizationId: orgId,
        reason: reason.trim() || null,
        notes: notes.trim() || null,
        days: days.map((d) => ({
          date: d.date,
          isAllDay: d.isAllDay,
          startTime: d.isAllDay ? null : d.startTime,
          endTime: d.isAllDay ? null : d.endTime,
        })),
      });
    },
    onSuccess: () => {
      setShowForm(false);
      setReason("");
      setNotes("");
      setDays([{ date: todayYmd(), isAllDay: true, startTime: "09:00", endTime: "17:00" }]);
      setFormError(null);
      void qc.invalidateQueries({ queryKey: ["vacation-requests-mine", orgId] });
      void qc.invalidateQueries({ queryKey: ["vacation-balance-mine", orgId] });
    },
    onError: (err: Error) => {
      setFormError(err.message || "Could not submit request.");
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => sendJson("DELETE", `/api/vacation/requests/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["vacation-requests-mine", orgId] });
      void qc.invalidateQueries({ queryKey: ["vacation-balance-mine", orgId] });
    },
    onError: (err: Error) => {
      Alert.alert("Error", err.message || "Could not cancel request.");
    },
  });

  function confirmCancel(req: VacationRequest) {
    Alert.alert(
      "Cancel request",
      `Cancel this vacation request for ${fmtHours(req.totalRequestedHours)}?`,
      [
        { text: "Keep", style: "cancel" },
        { text: "Cancel request", style: "destructive", onPress: () => cancelMutation.mutate(req.id) },
      ]
    );
  }

  function updateDay(index: number, patch: Partial<DayEntry>) {
    setDays((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function addDay() {
    const last = days[days.length - 1];
    const nextDate = last
      ? (() => {
          const d = new Date(last.date + "T00:00:00");
          d.setDate(d.getDate() + 1);
          return d.toISOString().slice(0, 10);
        })()
      : todayYmd();
    setDays((prev) => [...prev, { date: nextDate, isAllDay: true, startTime: "09:00", endTime: "17:00" }]);
  }

  function removeDay(index: number) {
    setDays((prev) => prev.filter((_, i) => i !== index));
  }

  const balance = balanceQuery.data;
  const requests = requestsQuery.data ?? [];
  const remaining = balance
    ? Math.max(
        0,
        Number(balance.annualVacationHours) -
          Number(balance.usedVacationHours) -
          Number(balance.pendingVacationHours)
      )
    : null;

  return (
    <DismissKeyboardView
      style={[styles.container, { paddingTop: insets.top }]}
      testID="vacation-keyboard-dismiss"
    >
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.tint} />
        </Pressable>
        <Text style={styles.headerTitle}>Vacation & Time Off</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: insets.bottom + Spacing.xl }}
        keyboardDismissMode={scrollKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
      >
        {/* Balance summary */}
        {balance && (
          <View style={styles.balanceRow}>
            <View style={styles.balanceChip}>
              <Text style={styles.balanceLabel}>Annual</Text>
              <Text style={styles.balanceValue}>{fmtHours(balance.annualVacationHours)}</Text>
            </View>
            <View style={styles.balanceChip}>
              <Text style={styles.balanceLabel}>Used</Text>
              <Text style={styles.balanceValue}>{fmtHours(balance.usedVacationHours)}</Text>
            </View>
            <View style={styles.balanceChip}>
              <Text style={styles.balanceLabel}>Pending</Text>
              <Text style={styles.balanceValue}>{fmtHours(balance.pendingVacationHours)}</Text>
            </View>
            <View style={[styles.balanceChip, { borderColor: colors.tint }]}>
              <Text style={styles.balanceLabel}>Left</Text>
              <Text style={[styles.balanceValue, { color: colors.tint }]}>
                {fmtHours(remaining ?? 0)}
              </Text>
            </View>
          </View>
        )}

        {/* Request form */}
        {showForm ? (
          <View style={styles.addCard}>
            <Text style={styles.addTitle}>New Request</Text>

            <Text style={styles.label}>Reason (optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Family vacation"
              placeholderTextColor={colors.textTertiary}
              value={reason}
              onChangeText={setReason}
            />

            <Text style={styles.label}>Days</Text>
            {days.map((d, i) => (
              <View key={i}>
                <View style={styles.dayRow}>
                  <TextInput
                    style={[styles.input, { flex: 1, marginBottom: 0 }]}
                    value={d.date}
                    onChangeText={(v) => updateDay(i, { date: v })}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.textTertiary}
                  />
                  <Pressable
                    style={[
                      styles.toggleBtn,
                      d.isAllDay && { backgroundColor: colors.tint, borderColor: colors.tint },
                    ]}
                    onPress={() => updateDay(i, { isAllDay: !d.isAllDay })}
                  >
                    <Text style={{ color: d.isAllDay ? "#fff" : colors.text, fontSize: 12 }}>
                      All day
                    </Text>
                  </Pressable>
                  {days.length > 1 && (
                    <Pressable onPress={() => removeDay(i)}>
                      <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
                    </Pressable>
                  )}
                </View>
                {!d.isAllDay && (
                  <View style={[styles.dayRow, { marginLeft: 0 }]}>
                    <TextInput
                      style={[styles.input, { flex: 1, marginBottom: 0 }]}
                      value={d.startTime}
                      onChangeText={(v) => updateDay(i, { startTime: v })}
                      placeholder="09:00"
                      placeholderTextColor={colors.textTertiary}
                    />
                    <Text style={styles.metaText}>–</Text>
                    <TextInput
                      style={[styles.input, { flex: 1, marginBottom: 0 }]}
                      value={d.endTime}
                      onChangeText={(v) => updateDay(i, { endTime: v })}
                      placeholder="17:00"
                      placeholderTextColor={colors.textTertiary}
                    />
                  </View>
                )}
              </View>
            ))}

            <Pressable style={styles.addDayBtn} onPress={addDay}>
              <Ionicons name="add-circle-outline" size={18} color={colors.tint} />
              <Text style={styles.addDayText}>Add another day</Text>
            </Pressable>

            {formError && (
              <Text style={{ color: "#ef4444", marginTop: Spacing.sm }}>{formError}</Text>
            )}

            <Pressable
              style={[styles.submitBtn, submitMutation.isPending && { opacity: 0.6 }]}
              onPress={() => submitMutation.mutate()}
              disabled={submitMutation.isPending}
            >
              <Text style={styles.submitBtnText}>
                {submitMutation.isPending ? "Submitting…" : "Submit request"}
              </Text>
            </Pressable>
            <Pressable style={styles.cancelBtn} onPress={() => setShowForm(false)}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            style={[styles.submitBtn, { marginBottom: Spacing.md }]}
            onPress={() => setShowForm(true)}
          >
            <Text style={styles.submitBtnText}>+ Request time off</Text>
          </Pressable>
        )}

        {/* Request history */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>My requests</Text>

          {requestsQuery.isLoading && (
            <ActivityIndicator color={colors.tint} />
          )}

          {!requestsQuery.isLoading && requests.length === 0 && (
            <Text style={styles.emptyText}>No requests yet.</Text>
          )}

          {requests.map((req) => (
            <View key={req.id} style={styles.card}>
              <View
                style={[
                  styles.statusBadge,
                  { backgroundColor: STATUS_COLORS[req.status] ?? "#6b7280" },
                ]}
              >
                <Text style={styles.statusText}>{req.status.toUpperCase()}</Text>
              </View>
              <Text style={styles.bodyText}>{fmtHours(req.totalRequestedHours)}</Text>
              <Text style={styles.metaText}>
                {req.days.map((d) => formatDateShort(d.date)).join(", ")}
              </Text>
              {req.reason ? (
                <Text style={styles.metaText}>{req.reason}</Text>
              ) : null}
              {req.adminDecisionNote ? (
                <Text style={[styles.metaText, { marginTop: 4 }]}>
                  Note: {req.adminDecisionNote}
                </Text>
              ) : null}
              {req.status === "pending" && (
                <>
                  <View style={styles.divider} />
                  <Pressable
                    onPress={() => confirmCancel(req)}
                    disabled={cancelMutation.isPending}
                  >
                    <Text style={[styles.cancelBtnText, { marginTop: 4 }]}>Cancel request</Text>
                  </Pressable>
                </>
              )}
            </View>
          ))}
        </View>
      </ScrollView>
    </DismissKeyboardView>
  );
}
