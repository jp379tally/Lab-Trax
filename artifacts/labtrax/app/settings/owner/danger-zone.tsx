import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  TextInput,
  Modal,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell } from "@/components/settings/SettingsRow";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import { resilientFetch } from "@/lib/query-client";
import { useMe, primaryOwnerLabOrgId } from "@/lib/auth-me";
import { useAuth } from "@/lib/auth-context";

interface LabProfile {
  id: string;
  name: string;
  displayName: string | null;
}

interface TeamMember {
  membershipId: string;
  userId: string;
  role: string;
  status: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  username: string | null;
}

function fmtCurrency(amount: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
      parseFloat(amount)
    );
  } catch {
    return `$${amount}`;
  }
}

export default function OwnerDangerZoneScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const me = useMe();
  const { refreshUsers } = useAuth();
  const params = useLocalSearchParams<{ organizationId?: string; newOwnerUserId?: string; transferOnly?: string }>();
  // Explicit handoffs must resolve direct ownership, never parent-lab access.
  const orgId = params.organizationId
    ? me.data?.memberships.find((m) => m.organizationId === params.organizationId && m.role === "owner" && m.status === "active")?.organizationId ?? null
    : primaryOwnerLabOrgId(me.data);
  const transferOnly = params.transferOnly === "1";
  const myUserId = (me.data?.user as any)?.id ?? "";

  const labQuery = useQuery<LabProfile>({
    queryKey: ["owner", "lab-profile", orgId],
    queryFn: async () => {
      const res = await resilientFetch(`/api/owner/lab-profile?organizationId=${orgId}`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      return body.data ?? body;
    },
    enabled: !!orgId,
  });

  const teamQuery = useQuery<TeamMember[]>({
    queryKey: ["owner", "team", orgId],
    queryFn: async () => {
      const res = await resilientFetch(`/api/owner/team?organizationId=${orgId}`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      return Array.isArray(body.data) ? body.data : body;
    },
    enabled: !!orgId,
  });

  const labName = labQuery.data
    ? (labQuery.data.displayName || labQuery.data.name)
    : "";

  const otherMembers = useMemo(
    () => (teamQuery.data ?? []).filter((m) => m.userId !== myUserId && m.status === "active"),
    [teamQuery.data, myUserId]
  );

  // ── Transfer Ownership ────────────────────────────────────────────────────
  const [showTransfer, setShowTransfer] = useState(transferOnly);
  const [transferTarget, setTransferTarget] = useState(params.newOwnerUserId ?? "");
  const [transferPhrase, setTransferPhrase] = useState("");

  const transferMutation = useMutation({
    mutationFn: async (data: {
      organizationId: string;
      newOwnerUserId: string;
      confirmationPhrase: string;
    }) => {
      const res = await resilientFetch("/api/owner/transfer-ownership", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message ?? body?.error ?? `Failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setShowTransfer(false);
      void qc.invalidateQueries({ queryKey: ["auth-me"] });
      void qc.invalidateQueries({ queryKey: ["lab-team"] });
      void qc.invalidateQueries({ queryKey: ["owner"] });
      void refreshUsers().catch(() => {});
      Alert.alert("Transferred", "Ownership has been transferred.", [
        { text: "OK", onPress: () => router.replace("/(tabs)/account" as never) },
      ]);
    },
    onError: (e: Error) => Alert.alert("Error", e.message),
  });

  // ── Delete Lab ────────────────────────────────────────────────────────────
  const [showDelete, setShowDelete] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");

  interface DeleteLabSummary {
    activeMembers: number;
    memberNames: string[];
    memberNamesOverflow: number;
    openCases: number;
    unpaidInvoices: number;
    unpaidInvoicesTotal: string;
  }

  const deleteSummaryQuery = useQuery<DeleteLabSummary>({
    queryKey: ["owner", "delete-lab-summary", orgId],
    queryFn: async () => {
      const res = await resilientFetch(`/api/owner/delete-lab-summary?organizationId=${orgId}`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      return body.data ?? body;
    },
    enabled: showDelete && !!orgId,
  });

  const deleteMutation = useMutation({
    mutationFn: async (data: { organizationId: string; confirmationPhrase: string }) => {
      const res = await resilientFetch("/api/owner/delete-lab", {
        method: "POST",
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
      qc.invalidateQueries({ queryKey: ["auth-me"] });
      Alert.alert("Lab deleted", "The lab has been deactivated.", [
        { text: "OK", onPress: () => router.replace("/(tabs)/account" as never) },
      ]);
    },
    onError: (e: Error) => Alert.alert("Error", e.message),
  });

  if (!orgId) {
    return (
      <ScreenShell title="Danger Zone" onBack={() => router.back()}>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={32} color={colors.textTertiary} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            Owner access required.
          </Text>
        </View>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell title={transferOnly ? "Transfer Ownership" : "Danger Zone"} onBack={() => router.back()}>
      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode={scrollKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          These actions are irreversible. Proceed with caution.
        </Text>

        {/* Transfer Ownership */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBox, { backgroundColor: "#F59E0B20" }]}>
              <Ionicons name="swap-horizontal-outline" size={20} color="#F59E0B" />
            </View>
            <View style={styles.cardInfo}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>Transfer Ownership</Text>
              <Text style={[styles.cardDesc, { color: colors.textSecondary }]}>
                Transfer ownership to another active member. You will remain Administrator.
              </Text>
            </View>
          </View>
          <Pressable
            style={[styles.warnBtn, { borderColor: "#F59E0B40" }]}
            onPress={() => setShowTransfer(true)}
          >
            <Text style={styles.warnBtnText}>Transfer Ownership…</Text>
          </Pressable>
        </View>

        {/* Delete Lab */}
        {!transferOnly && <View style={[styles.card, styles.dangerCard, { backgroundColor: colors.surface, borderColor: colors.error + "40" }]}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBox, { backgroundColor: colors.error + "20" }]}>
              <Ionicons name="trash-outline" size={20} color={colors.error} />
            </View>
            <View style={styles.cardInfo}>
              <Text style={[styles.cardTitle, { color: colors.error }]}>Delete Lab</Text>
              <Text style={[styles.cardDesc, { color: colors.textSecondary }]}>
                Permanently deactivate this lab. All members lose access. Data is preserved.
              </Text>
            </View>
          </View>
          <Pressable
            style={[styles.dangerBtn, { borderColor: colors.error + "40", backgroundColor: colors.error + "10" }]}
            onPress={() => setShowDelete(true)}
          >
            <Text style={[styles.dangerBtnText, { color: colors.error }]}>Delete Lab…</Text>
          </Pressable>
        </View>}
      </ScrollView>

      {/* Transfer Ownership Sheet */}
      <Modal
        visible={showTransfer}
        transparent
        animationType="slide"
        onRequestClose={() => setShowTransfer(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setShowTransfer(false)} />
        <DismissKeyboardView
          style={[styles.sheet, { backgroundColor: colors.surface }]}
          testID="transfer-ownership-keyboard-dismiss"
        >
          <Text style={[styles.sheetTitle, { color: colors.text }]}>Transfer Ownership</Text>
          <Text style={[styles.sheetSub, { color: colors.textSecondary }]}>
            Select an active member and type the organization name to confirm. You will remain Administrator.
          </Text>
          <Text style={[styles.label, { color: colors.textSecondary }]}>New Owner</Text>
          {otherMembers.map((m) => {
            const name =
              [m.firstName, m.lastName].filter(Boolean).join(" ") ||
              m.username ||
              m.userId;
            const selected = transferTarget === m.userId;
            return (
              <Pressable
                key={m.userId}
                style={[
                  styles.memberOption,
                  { borderColor: selected ? colors.tint : colors.border, backgroundColor: selected ? colors.tint + "10" : colors.backgroundSolid },
                ]}
                onPress={() => setTransferTarget(m.userId)}
                disabled={transferMutation.isPending}
              >
                <Text style={[styles.memberOptionText, { color: colors.text }]}>{name}</Text>
                {selected && <Ionicons name="checkmark-circle" size={16} color={colors.tint} />}
              </Pressable>
            );
          })}
          {otherMembers.length === 0 && (
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No other team members.</Text>
          )}
          <Text style={[styles.label, { color: colors.textSecondary, marginTop: Spacing.md }]}>
            Type <Text style={{ fontWeight: "700" }}>{labName}</Text> to confirm
          </Text>
          <TextInput
            accessibilityLabel="Organization name confirmation"
            editable={!transferMutation.isPending}
            value={transferPhrase}
            onChangeText={setTransferPhrase}
            placeholder={labName}
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.backgroundSolid }]}
          />
          <View style={styles.sheetBtns}>
            <Pressable
              style={[styles.btn, { backgroundColor: "#F59E0B" }, (!transferTarget || !transferPhrase || transferMutation.isPending) && styles.disabledBtn]}
              disabled={!otherMembers.some((m) => m.userId === transferTarget) || !transferPhrase || transferMutation.isPending}
              onPress={() => {
                transferMutation.mutate({
                  organizationId: orgId,
                  newOwnerUserId: transferTarget,
                  confirmationPhrase: transferPhrase,
                });
              }}
            >
              {transferMutation.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.btnText}>Confirm Transfer</Text>
              )}
            </Pressable>
            <Pressable
              style={[styles.btn, styles.cancelBtn, { borderColor: colors.border }]}
              onPress={() => setShowTransfer(false)}
            >
              <Text style={[styles.cancelBtnText, { color: colors.textSecondary }]}>Cancel</Text>
            </Pressable>
          </View>
        </DismissKeyboardView>
      </Modal>

      {/* Delete Lab Sheet */}
      <Modal
        visible={showDelete}
        transparent
        animationType="slide"
        onRequestClose={() => setShowDelete(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setShowDelete(false)} />
        <DismissKeyboardView
          style={[styles.sheet, { backgroundColor: colors.surface }]}
          testID="delete-lab-keyboard-dismiss"
        >
          <Text style={[styles.sheetTitle, { color: colors.error }]}>Delete Lab</Text>
          <Text style={[styles.sheetSub, { color: colors.textSecondary }]}>
            This will deactivate the lab and remove all member access. Type the lab name to confirm.
          </Text>

          {/* Summary card */}
          <View style={[styles.summaryCard, { borderColor: colors.error + "30", backgroundColor: colors.error + "08" }]}>
            <Text style={[styles.summaryHeading, { color: colors.error }]}>
              The following will be soft-deleted:
            </Text>
            {deleteSummaryQuery.isLoading ? (
              <ActivityIndicator size="small" color={colors.error} style={{ marginTop: 6 }} />
            ) : deleteSummaryQuery.data ? (
              <>
                <View style={styles.summaryRow}>
                  <View style={[styles.summaryCell, { borderColor: colors.border, backgroundColor: colors.backgroundSolid }]}>
                    <Ionicons name="people-outline" size={16} color={colors.error} />
                    <Text style={[styles.summaryCount, { color: colors.text }]}>
                      {deleteSummaryQuery.data.activeMembers}
                    </Text>
                    <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
                      Members
                    </Text>
                  </View>
                  <View style={[styles.summaryCell, { borderColor: colors.border, backgroundColor: colors.backgroundSolid }]}>
                    <Ionicons name="warning-outline" size={16} color={colors.error} />
                    <Text style={[styles.summaryCount, { color: colors.text }]}>
                      {deleteSummaryQuery.data.openCases}
                    </Text>
                    <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
                      Open Cases
                    </Text>
                  </View>
                  <View style={[styles.summaryCell, { borderColor: colors.border, backgroundColor: colors.backgroundSolid }]}>
                    <Ionicons name="document-text-outline" size={16} color={colors.error} />
                    <Text style={[styles.summaryCount, { color: colors.text }]}>
                      {deleteSummaryQuery.data.unpaidInvoices}
                    </Text>
                    <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
                      Unpaid Inv.
                    </Text>
                    {parseFloat(deleteSummaryQuery.data.unpaidInvoicesTotal) > 0 && (
                      <Text style={[styles.summaryTotal, { color: colors.error }]}>
                        {fmtCurrency(deleteSummaryQuery.data.unpaidInvoicesTotal)}
                      </Text>
                    )}
                  </View>
                </View>
                {deleteSummaryQuery.data.memberNames.length > 0 && (
                  <View style={[styles.memberNamesBanner, { borderColor: colors.border, backgroundColor: colors.backgroundSolid }]}>
                    <Text style={[styles.memberNamesLabel, { color: colors.textSecondary }]}>
                      {"Members losing access: "}
                      <Text style={{ color: colors.text }}>
                        {deleteSummaryQuery.data.memberNames.join(", ")}
                        {deleteSummaryQuery.data.memberNamesOverflow > 0
                          ? ` +${deleteSummaryQuery.data.memberNamesOverflow} more`
                          : ""}
                      </Text>
                    </Text>
                  </View>
                )}
              </>
            ) : null}
          </View>

          <Text style={[styles.label, { color: colors.textSecondary }]}>
            Type <Text style={{ fontWeight: "700" }}>{labName}</Text> to confirm
          </Text>
          <TextInput
            value={deletePhrase}
            onChangeText={setDeletePhrase}
            placeholder={labName}
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, { color: colors.text, borderColor: colors.error + "50", backgroundColor: colors.backgroundSolid }]}
          />
          <View style={styles.sheetBtns}>
            <Pressable
              style={[styles.btn, { backgroundColor: colors.error }, (!deletePhrase || deleteMutation.isPending) && styles.disabledBtn]}
              disabled={!deletePhrase || deleteMutation.isPending}
              onPress={() => {
                deleteMutation.mutate({
                  organizationId: orgId,
                  confirmationPhrase: deletePhrase,
                });
              }}
            >
              {deleteMutation.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.btnText}>Delete Lab</Text>
              )}
            </Pressable>
            <Pressable
              style={[styles.btn, styles.cancelBtn, { borderColor: colors.border }]}
              onPress={() => setShowDelete(false)}
            >
              <Text style={[styles.cancelBtnText, { color: colors.textSecondary }]}>Cancel</Text>
            </Pressable>
          </View>
        </DismissKeyboardView>
      </Modal>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl },
    subtitle: { ...Typography.caption },
    center: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 80, gap: Spacing.md },
    emptyText: { ...Typography.body, textAlign: "center" },
    card: {
      borderRadius: Radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      padding: Spacing.lg,
      gap: Spacing.md,
    },
    dangerCard: {},
    cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.md },
    iconBox: { width: 38, height: 38, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" },
    cardInfo: { flex: 1 },
    cardTitle: { ...Typography.bodyMedium, fontWeight: "600" },
    cardDesc: { ...Typography.caption, marginTop: 2 },
    warnBtn: {
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.md,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
      alignItems: "center",
      backgroundColor: "#F59E0B10",
    },
    warnBtnText: { ...Typography.caption, fontWeight: "600", color: "#F59E0B" },
    dangerBtn: {
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.md,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
      alignItems: "center",
    },
    dangerBtnText: { ...Typography.caption, fontWeight: "600" },
    overlay: {
      position: "absolute",
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: "rgba(0,0,0,0.5)",
    },
    sheet: {
      position: "absolute",
      bottom: 0, left: 0, right: 0,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      padding: Spacing.xl,
      paddingBottom: 34,
      gap: Spacing.sm,
    },
    sheetTitle: { ...Typography.h3, marginBottom: 2 },
    sheetSub: { ...Typography.caption, marginBottom: Spacing.sm },
    label: { ...Typography.caption, fontWeight: "600" },
    memberOption: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      marginTop: Spacing.xs,
    },
    memberOptionText: { ...Typography.body },
    input: {
      height: 40,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.md,
      paddingHorizontal: Spacing.md,
      ...Typography.body,
      marginTop: Spacing.xs,
    },
    summaryCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.md,
      padding: Spacing.md,
      gap: Spacing.sm,
    },
    summaryHeading: { ...Typography.caption, fontWeight: "600" },
    summaryRow: { flexDirection: "row", gap: Spacing.sm },
    summaryCell: {
      flex: 1,
      alignItems: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.sm,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.xs,
      gap: 2,
    },
    summaryCount: { ...Typography.h3, lineHeight: 22 },
    summaryLabel: { ...Typography.caption, textAlign: "center", lineHeight: 14 },
    summaryTotal: { ...Typography.caption, fontWeight: "700", textAlign: "center", lineHeight: 14 },
    memberNamesBanner: {
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: Radius.sm,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
    },
    memberNamesLabel: { ...Typography.caption, lineHeight: 16 },
    sheetBtns: { flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.sm },
    btn: {
      flex: 1,
      height: 42,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    btnText: { ...Typography.bodySemibold, color: "#fff" },
    cancelBtn: { borderWidth: StyleSheet.hairlineWidth, backgroundColor: "transparent" },
    cancelBtnText: { ...Typography.bodyMedium },
    disabledBtn: { opacity: 0.6 },
  });
}
