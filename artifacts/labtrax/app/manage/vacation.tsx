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
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import { getJson, sendJson, isForbiddenError } from "@/lib/read-api";
import { useMe, adminLabMemberships } from "@/lib/auth-me";

interface VacationBalance {
  id?: string | null;
  labId: string;
  userId: string;
  year: number;
  annualVacationHours: string;
  usedVacationHours: string;
  pendingVacationHours: string;
  employeeName?: string | null;
  employeeInitials?: string | null;
  membershipRole?: string | null;
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
  userId: string;
  totalRequestedHours: string;
  reason?: string | null;
  status: "pending" | "approved" | "denied" | "cancelled";
  adminDecisionNote?: string | null;
  createdAt: string;
  days: VacationRequestDay[];
  employeeName?: string | null;
}

function fmtHours(h: string | number) {
  const n = Number(h);
  return Number.isNaN(n) ? "—" : `${n.toFixed(1)} h`;
}

function formatDate(d: string) {
  try {
    const dt = new Date(d + "T00:00:00");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    return `${mm}/${dd}/${dt.getFullYear()}`;
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
    section: { paddingHorizontal: Spacing.md, paddingTop: Spacing.md },
    sectionTitle: { ...Typography.bodySemibold, color: colors.textSecondary, marginBottom: Spacing.sm },
    card: {
      backgroundColor: colors.backgroundSolid,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: Spacing.sm,
      overflow: "hidden",
    },
    cardRow: {
      flexDirection: "row",
      alignItems: "center",
      padding: Spacing.md,
    },
    avatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.tint,
      alignItems: "center",
      justifyContent: "center",
      marginRight: Spacing.sm,
    },
    avatarText: { color: "#fff", fontWeight: "700", fontSize: 14 },
    name: { ...Typography.body, color: colors.text, fontWeight: "600", flex: 1 },
    metaText: { ...Typography.caption, color: colors.textSecondary },
    statusBadge: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 99,
      alignSelf: "flex-start",
    },
    statusText: { fontSize: 11, fontWeight: "700", color: "#fff" },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.sm,
      padding: Spacing.sm,
      color: colors.text,
      backgroundColor: colors.background,
      ...Typography.body,
    },
    actionRow: { flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.sm },
    btn: {
      flex: 1,
      padding: Spacing.sm,
      borderRadius: Radius.sm,
      alignItems: "center",
    },
    btnPrimary: { backgroundColor: colors.tint },
    btnDestructive: { backgroundColor: "#ef4444" },
    btnText: { color: "#fff", fontWeight: "600", ...Typography.body },
    emptyText: { ...Typography.body, color: colors.textSecondary, textAlign: "center", padding: Spacing.lg },
    divider: { height: 1, backgroundColor: colors.border },
    tabRow: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.backgroundSolid,
    },
    tab: {
      flex: 1,
      paddingVertical: Spacing.sm,
      alignItems: "center",
    },
    tabActive: { borderBottomWidth: 2, borderBottomColor: colors.tint },
    tabText: { ...Typography.bodyMedium, color: colors.textSecondary },
    tabTextActive: { color: colors.tint, fontWeight: "700" },
    hoursRow: { flexDirection: "row", gap: Spacing.xs },
    hoursChip: {
      flex: 1,
      alignItems: "center",
      padding: Spacing.sm,
      borderRadius: Radius.sm,
      backgroundColor: colors.background,
    },
    hoursLabel: { ...Typography.caption, color: colors.textTertiary },
    hoursValue: { ...Typography.bodyMedium, color: colors.text, fontWeight: "700" },
  });
}

type Tab = "requests" | "balances";

export default function VacationManageScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const meQuery = useMe();
  const me = meQuery.data;
  const adminLabs = useMemo(() => adminLabMemberships(me), [me]);
  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const labId = selectedLabId ?? adminLabs[0]?.organizationId ?? null;
  const isBlocked = !meQuery.isLoading && adminLabs.length === 0;

  const [activeTab, setActiveTab] = useState<Tab>("requests");
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [denyNote, setDenyNote] = useState<Record<string, string>>({});
  const [showDenyInput, setShowDenyInput] = useState<string | null>(null);
  const [editingBalance, setEditingBalance] = useState<string | null>(null);
  const [balanceInput, setBalanceInput] = useState<Record<string, string>>({});

  const requestsQuery = useQuery<VacationRequest[]>({
    enabled: !!labId && activeTab === "requests",
    queryKey: ["vacation-requests-admin", labId, statusFilter],
    queryFn: () =>
      getJson(
        `/api/vacation/requests?organizationId=${encodeURIComponent(labId!)}&status=${statusFilter}`
      ),
    staleTime: 30_000,
  });

  const balancesQuery = useQuery<VacationBalance[]>({
    enabled: !!labId && activeTab === "balances",
    queryKey: ["vacation-balances-admin", labId],
    queryFn: () =>
      getJson(`/api/vacation/balances?organizationId=${encodeURIComponent(labId!)}`),
    staleTime: 30_000,
  });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) =>
      sendJson("POST", `/api/vacation/requests/${requestId}/approve`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["vacation-requests-admin", labId] });
    },
    onError: (err: Error) => {
      Alert.alert("Error", err.message || "Could not approve request.");
    },
  });

  const denyMutation = useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note: string }) =>
      sendJson("POST", `/api/vacation/requests/${requestId}/deny`, {
        adminDecisionNote: note || null,
      }),
    onSuccess: (_data, vars) => {
      setShowDenyInput(null);
      setDenyNote((prev) => ({ ...prev, [vars.requestId]: "" }));
      void qc.invalidateQueries({ queryKey: ["vacation-requests-admin", labId] });
    },
    onError: (err: Error) => {
      Alert.alert("Error", err.message || "Could not deny request.");
    },
  });

  const updateBalanceMutation = useMutation({
    mutationFn: ({ userId, hours }: { userId: string; hours: number }) =>
      sendJson(
        "PATCH",
        `/api/vacation/balances/${userId}?organizationId=${encodeURIComponent(labId!)}`,
        { annualVacationHours: hours }
      ),
    onSuccess: (_data, vars) => {
      setEditingBalance(null);
      setBalanceInput((prev) => ({ ...prev, [vars.userId]: "" }));
      void qc.invalidateQueries({ queryKey: ["vacation-balances-admin", labId] });
    },
    onError: (err: Error) => {
      Alert.alert("Error", err.message || "Could not update balance.");
    },
  });

  function confirmApprove(req: VacationRequest) {
    Alert.alert(
      "Approve request",
      `Approve ${fmtHours(req.totalRequestedHours)} for ${req.employeeName ?? "this employee"}?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Approve", onPress: () => approveMutation.mutate(req.id) },
      ]
    );
  }

  if (isBlocked) {
    return (
      <DismissKeyboardView
        style={[styles.container, { paddingTop: insets.top }]}
        testID="manage-vacation-keyboard-dismiss"
      >
        <View style={styles.header}>
          <Pressable style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={24} color={colors.tint} />
          </Pressable>
          <Text style={styles.headerTitle}>Employee Hours</Text>
        </View>
        <Text style={styles.emptyText}>
          Managing employee hours requires an admin or owner role.
        </Text>
      </DismissKeyboardView>
    );
  }

  const requests = requestsQuery.data ?? [];
  const balances = balancesQuery.data ?? [];

  return (
    <DismissKeyboardView
      style={[styles.container, { paddingTop: insets.top }]}
      testID="manage-vacation-keyboard-dismiss"
    >
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.tint} />
        </Pressable>
        <Text style={styles.headerTitle}>Employee Hours</Text>
      </View>

      <View style={styles.tabRow}>
        {(["requests", "balances"] as Tab[]).map((t) => (
          <Pressable
            key={t}
            style={[styles.tab, activeTab === t && styles.tabActive]}
            onPress={() => setActiveTab(t)}
          >
            <Text style={[styles.tabText, activeTab === t && styles.tabTextActive]}>
              {t === "requests" ? "Requests" : "Balances"}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: insets.bottom + Spacing.xl }}
        keyboardDismissMode={scrollKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
      >
        {activeTab === "requests" && (
          <>
            {/* Status filter */}
            <View style={[styles.tabRow, { borderRadius: Radius.sm, overflow: "hidden", marginBottom: Spacing.md }]}>
              {(["pending", "approved", "denied", "all"] as const).map((s) => (
                <Pressable
                  key={s}
                  style={[styles.tab, statusFilter === s && styles.tabActive]}
                  onPress={() => setStatusFilter(s)}
                >
                  <Text style={[styles.tabText, statusFilter === s && styles.tabTextActive]}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>

            {requestsQuery.isLoading && (
              <ActivityIndicator color={colors.tint} style={{ marginTop: Spacing.lg }} />
            )}

            {!requestsQuery.isLoading && requests.length === 0 && (
              <Text style={styles.emptyText}>No {statusFilter} requests.</Text>
            )}

            {requests.map((req) => (
              <View key={req.id} style={styles.card}>
                <View style={styles.cardRow}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>
                      {(req.employeeName ?? "?").slice(0, 2).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{req.employeeName ?? "Employee"}</Text>
                    <Text style={styles.metaText}>
                      {fmtHours(req.totalRequestedHours)} ·{" "}
                      {req.days.length} day{req.days.length !== 1 ? "s" : ""}
                    </Text>
                    {req.days.slice(0, 3).map((d) => (
                      <Text key={d.id} style={styles.metaText}>
                        {formatDate(d.date)}{d.isAllDay ? " (all day)" : ` ${d.startTime}–${d.endTime}`}
                      </Text>
                    ))}
                    {req.days.length > 3 && (
                      <Text style={styles.metaText}>+{req.days.length - 3} more days</Text>
                    )}
                    {req.reason ? (
                      <Text style={[styles.metaText, { marginTop: 2 }]}>{req.reason}</Text>
                    ) : null}
                  </View>
                  <View
                    style={[
                      styles.statusBadge,
                      { backgroundColor: STATUS_COLORS[req.status] ?? "#6b7280" },
                    ]}
                  >
                    <Text style={styles.statusText}>{req.status.toUpperCase()}</Text>
                  </View>
                </View>

                {req.status === "pending" && (
                  <>
                    <View style={styles.divider} />
                    {showDenyInput === req.id ? (
                      <View style={{ padding: Spacing.md }}>
                        <TextInput
                          style={styles.input}
                          placeholder="Optional note to employee…"
                          placeholderTextColor={colors.textTertiary}
                          value={denyNote[req.id] ?? ""}
                          onChangeText={(v) => setDenyNote((p) => ({ ...p, [req.id]: v }))}
                          multiline
                          autoCorrect={true}
                          spellCheck={true}
                          autoCapitalize="sentences"
                        />
                        <View style={styles.actionRow}>
                          <Pressable
                            style={[styles.btn, { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border }]}
                            onPress={() => setShowDenyInput(null)}
                          >
                            <Text style={[styles.btnText, { color: colors.text }]}>Cancel</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.btn, styles.btnDestructive]}
                            onPress={() =>
                              denyMutation.mutate({
                                requestId: req.id,
                                note: denyNote[req.id] ?? "",
                              })
                            }
                            disabled={denyMutation.isPending}
                          >
                            <Text style={styles.btnText}>Confirm deny</Text>
                          </Pressable>
                        </View>
                      </View>
                    ) : (
                      <View style={{ padding: Spacing.md }}>
                        <View style={styles.actionRow}>
                          <Pressable
                            style={[styles.btn, styles.btnDestructive]}
                            onPress={() => setShowDenyInput(req.id)}
                          >
                            <Text style={styles.btnText}>Deny</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.btn, styles.btnPrimary]}
                            onPress={() => confirmApprove(req)}
                            disabled={approveMutation.isPending}
                          >
                            <Text style={styles.btnText}>Approve</Text>
                          </Pressable>
                        </View>
                      </View>
                    )}
                  </>
                )}

                {req.adminDecisionNote ? (
                  <View style={{ paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm }}>
                    <Text style={styles.metaText}>Note: {req.adminDecisionNote}</Text>
                  </View>
                ) : null}
              </View>
            ))}
          </>
        )}

        {activeTab === "balances" && (
          <>
            {balancesQuery.isLoading && (
              <ActivityIndicator color={colors.tint} style={{ marginTop: Spacing.lg }} />
            )}

            {!balancesQuery.isLoading && balances.length === 0 && (
              <Text style={styles.emptyText}>No team members found.</Text>
            )}

            {balances.map((b) => (
              <View key={b.userId} style={styles.card}>
                <View style={styles.cardRow}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>
                      {(b.employeeName ?? "?").slice(0, 2).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{b.employeeName ?? b.userId}</Text>
                    <Text style={styles.metaText}>{b.membershipRole ?? "member"} · {b.year}</Text>
                  </View>
                </View>
                <View style={[styles.hoursRow, { paddingHorizontal: Spacing.md, paddingBottom: Spacing.md }]}>
                  <View style={styles.hoursChip}>
                    <Text style={styles.hoursLabel}>Annual</Text>
                    <Text style={styles.hoursValue}>{fmtHours(b.annualVacationHours)}</Text>
                  </View>
                  <View style={styles.hoursChip}>
                    <Text style={styles.hoursLabel}>Used</Text>
                    <Text style={styles.hoursValue}>{fmtHours(b.usedVacationHours)}</Text>
                  </View>
                  <View style={styles.hoursChip}>
                    <Text style={styles.hoursLabel}>Pending</Text>
                    <Text style={styles.hoursValue}>{fmtHours(b.pendingVacationHours)}</Text>
                  </View>
                  <View style={[styles.hoursChip, { backgroundColor: colors.tint + "22" }]}>
                    <Text style={styles.hoursLabel}>Remaining</Text>
                    <Text style={[styles.hoursValue, { color: colors.tint }]}>
                      {fmtHours(
                        Math.max(
                          0,
                          Number(b.annualVacationHours) -
                            Number(b.usedVacationHours) -
                            Number(b.pendingVacationHours)
                        )
                      )}
                    </Text>
                  </View>
                </View>
                <View style={styles.divider} />
                <View style={{ padding: Spacing.md }}>
                  {editingBalance === b.userId ? (
                    <View style={styles.actionRow}>
                      <TextInput
                        style={[styles.input, { flex: 1 }]}
                        placeholder="Annual hours (e.g. 80)"
                        placeholderTextColor={colors.textTertiary}
                        keyboardType="numeric"
                        value={balanceInput[b.userId] ?? ""}
                        onChangeText={(v) => setBalanceInput((p) => ({ ...p, [b.userId]: v }))}
                      />
                      <Pressable
                        style={[styles.btn, { flex: 0, paddingHorizontal: Spacing.md }, styles.btnPrimary]}
                        onPress={() => {
                          const hours = Number(balanceInput[b.userId] ?? "");
                          if (Number.isNaN(hours) || hours < 0) {
                            Alert.alert("Invalid", "Enter a valid number of hours.");
                            return;
                          }
                          updateBalanceMutation.mutate({ userId: b.userId, hours });
                        }}
                        disabled={updateBalanceMutation.isPending}
                      >
                        <Text style={styles.btnText}>Save</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.btn, { flex: 0, paddingHorizontal: Spacing.md, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border }]}
                        onPress={() => setEditingBalance(null)}
                      >
                        <Text style={[styles.btnText, { color: colors.text }]}>✕</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <Pressable
                      style={[styles.btn, { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, flex: 0, alignSelf: "flex-start", paddingHorizontal: Spacing.md }]}
                      onPress={() => {
                        setBalanceInput((p) => ({
                          ...p,
                          [b.userId]: b.annualVacationHours,
                        }));
                        setEditingBalance(b.userId);
                      }}
                    >
                      <Text style={[styles.btnText, { color: colors.text }]}>
                        <Ionicons name="pencil-outline" size={14} /> Edit annual hours
                      </Text>
                    </Pressable>
                  )}
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </DismissKeyboardView>
  );
}
