import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";
import { useMe, primaryOwnerLabOrgId } from "@/lib/auth-me";

interface TeamMember {
  membershipId: string;
  userId: string;
  role: string;
  status: string;
  joinedAt: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  username: string | null;
}

const ROLE_OPTIONS = ["owner", "admin", "billing", "user", "read_only"] as const;
const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  billing: "Billing",
  user: "User",
  read_only: "Read Only",
};

export default function OwnerTeamScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const me = useMe();
  const orgId = primaryOwnerLabOrgId(me.data);

  const [roleSheet, setRoleSheet] = useState<TeamMember | null>(null);

  const query = useQuery<TeamMember[]>({
    queryKey: ["owner", "team", orgId],
    queryFn: async () => {
      const res = await resilientFetch(`/api/owner/team?organizationId=${orgId}`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      return Array.isArray(body.data) ? body.data : body;
    },
    enabled: !!orgId,
  });

  const roleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: string }) => {
      const res = await resilientFetch(`/api/owner/team/${userId}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId, role }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message ?? `Failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["owner", "team", orgId] });
      setRoleSheet(null);
    },
    onError: (e: Error) => {
      Alert.alert("Error", e.message);
    },
  });

  if (!orgId) {
    return (
      <ScreenShell title="Team & Roles" onBack={() => router.back()}>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={32} color={colors.textTertiary} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            Owner access required.
          </Text>
        </View>
      </ScreenShell>
    );
  }

  const members = query.data ?? [];

  return (
    <ScreenShell title="Team & Roles" onBack={() => router.back()}>
      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Manage team members and their roles. Only owners can promote or demote other owners.
        </Text>

        {query.isLoading ? (
          <ActivityIndicator color={colors.tint} style={styles.loader} />
        ) : (
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {members.map((member, idx) => {
              const displayName =
                [member.firstName, member.lastName].filter(Boolean).join(" ") ||
                member.username ||
                member.userId;
              const isLast = idx === members.length - 1;
              return (
                <View
                  key={member.membershipId}
                  style={[
                    styles.row,
                    !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                  ]}
                >
                  <View style={styles.memberInfo}>
                    <Text style={[styles.memberName, { color: colors.text }]} numberOfLines={1}>
                      {displayName}
                    </Text>
                    {member.email && (
                      <Text style={[styles.memberEmail, { color: colors.textSecondary }]} numberOfLines={1}>
                        {member.email}
                      </Text>
                    )}
                  </View>
                  <Pressable
                    style={[styles.roleChip, { backgroundColor: colors.backgroundSolid, borderColor: colors.border }]}
                    onPress={() => setRoleSheet(member)}
                  >
                    <Text style={[styles.roleChipText, { color: colors.tint }]}>
                      {ROLE_LABELS[member.role] ?? member.role}
                    </Text>
                    <Ionicons name="chevron-down" size={12} color={colors.tint} />
                  </Pressable>
                </View>
              );
            })}
            {members.length === 0 && (
              <View style={styles.emptyRow}>
                <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                  No team members found.
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* Role Picker Modal */}
      <Modal
        visible={!!roleSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setRoleSheet(null)}
      >
        <Pressable style={styles.overlay} onPress={() => setRoleSheet(null)} />
        <View style={[styles.sheet, { backgroundColor: colors.surface }]}>
          <Text style={[styles.sheetTitle, { color: colors.text }]}>Change Role</Text>
          {ROLE_OPTIONS.map((role) => (
            <Pressable
              key={role}
              style={[
                styles.sheetRow,
                roleSheet?.role === role && { backgroundColor: colors.tint + "15" },
              ]}
              onPress={() => {
                if (roleSheet) {
                  roleMutation.mutate({ userId: roleSheet.userId, role });
                }
              }}
            >
              <Text style={[styles.sheetRowText, { color: colors.text }]}>
                {ROLE_LABELS[role] ?? role}
              </Text>
              {roleSheet?.role === role && (
                <Ionicons name="checkmark" size={16} color={colors.tint} />
              )}
            </Pressable>
          ))}
          <Pressable
            style={styles.sheetCancel}
            onPress={() => setRoleSheet(null)}
          >
            <Text style={[styles.sheetCancelText, { color: colors.textSecondary }]}>
              Cancel
            </Text>
          </Pressable>
        </View>
      </Modal>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    body: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: Spacing.xxxl },
    subtitle: { ...Typography.caption, marginBottom: Spacing.sm },
    loader: { marginTop: Spacing.xl },
    card: {
      borderRadius: Radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      gap: Spacing.md,
    },
    memberInfo: { flex: 1 },
    memberName: { ...Typography.bodyMedium },
    memberEmail: { ...Typography.caption, marginTop: 2 },
    roleChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderRadius: Radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 4,
    },
    roleChipText: { ...Typography.caption, fontWeight: "600" },
    emptyRow: { padding: Spacing.xl, alignItems: "center" },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingTop: 80,
      gap: Spacing.md,
    },
    emptyText: { ...Typography.body, textAlign: "center" },
    overlay: {
      position: "absolute",
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: "rgba(0,0,0,0.4)",
    },
    sheet: {
      position: "absolute",
      bottom: 0, left: 0, right: 0,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      paddingBottom: 34,
      paddingTop: Spacing.lg,
    },
    sheetTitle: { ...Typography.h3, paddingHorizontal: Spacing.lg, marginBottom: Spacing.sm },
    sheetRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
    },
    sheetRowText: { ...Typography.body },
    sheetCancel: { marginTop: Spacing.sm, paddingVertical: Spacing.md, alignItems: "center" },
    sheetCancelText: { ...Typography.bodyMedium },
  });
}
