import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
  FlatList,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell } from "@/components/settings/SettingsRow";
import { resilientFetch } from "@/lib/query-client";
import { getPlatformAdminSessionHeaders } from "@/lib/platform-admin-session";

interface AdminUser {
  id: string;
  username: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  role?: string | null;
  isActive?: boolean;
  practiceName?: string | null;
  lastLoginAt?: string | null;
}

const ROLE_OPTIONS = ["user", "admin", "billing", "owner"] as const;

function formatDate(s: string | null | undefined) {
  if (!s) return "Never";
  try { return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return s; }
}

export default function UsersScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<AdminUser | null>(null);

  const query = useQuery<AdminUser[]>({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const adminHeaders = await getPlatformAdminSessionHeaders();
      const res = await resilientFetch("/api/admin/users", { headers: adminHeaders });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const body = await res.json();
      const data = body?.data ?? body?.users ?? body;
      return Array.isArray(data) ? data : [];
    },
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    const users = query.data ?? [];
    if (!search.trim()) return users;
    const q = search.trim().toLowerCase();
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        (u.email || "").toLowerCase().includes(q) ||
        ([u.firstName, u.lastName].filter(Boolean).join(" ")).toLowerCase().includes(q) ||
        (u.role || "").toLowerCase().includes(q),
    );
  }, [query.data, search]);

  const patchMutation = useMutation({
    mutationFn: async ({ id, changes }: { id: string; changes: Partial<AdminUser> }) => {
      const adminHeaders = await getPlatformAdminSessionHeaders();
      const res = await resilientFetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify(changes),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as any)?.error || `Failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      const updated = data?.data ?? data;
      if (updated?.id && selected?.id === updated.id) {
        setSelected((prev) => prev ? { ...prev, ...updated } : prev);
      }
    },
    onError: (err: Error) => Alert.alert("Could not update user", err.message),
  });

  function toggleActive(user: AdminUser) {
    const action = user.isActive ? "Deactivate" : "Reactivate";
    Alert.alert(`${action} user`, `${action} ${user.username}?`, [
      { text: "Cancel", style: "cancel" },
      { text: action, style: user.isActive ? "destructive" : "default", onPress: () => patchMutation.mutate({ id: user.id, changes: { isActive: !user.isActive } }) },
    ]);
  }

  return (
    <ScreenShell title="Users" subtitle="All platform accounts" onBack={() => router.back()} insetTop={insets.top}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textSecondary} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          style={[styles.searchInput, { color: colors.text }]}
          placeholderTextColor={colors.textTertiary}
          placeholder="Search by name, email, or role…"
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")} hitSlop={8}>
            <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>

      {query.isLoading && <ActivityIndicator color={colors.tint} style={{ marginTop: Spacing.xxl }} />}

      <FlatList
        data={filtered}
        keyExtractor={(u) => u.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          !query.isLoading ? (
            <Text style={[styles.empty, { color: colors.textSecondary }]}>
              {search ? `No users match "${search}".` : "No users found."}
            </Text>
          ) : null
        }
        renderItem={({ item: user }) => (
          <Pressable
            style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => setSelected(user)}
          >
            <View style={[styles.avatar, { backgroundColor: colors.tint + "1A" }]}>
              <Text style={[styles.avatarText, { color: colors.tint }]}>
                {user.username.charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={styles.rowInfo}>
              <Text style={[styles.rowName, { color: colors.text }]}>
                {[user.firstName, user.lastName].filter(Boolean).join(" ") || user.username}
              </Text>
              <Text style={[styles.rowMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                {user.email || user.username} · {user.role || "user"}
              </Text>
            </View>
            <View style={styles.rowRight}>
              <View style={[styles.badge, { backgroundColor: user.isActive !== false ? "#10B98120" : colors.error + "20" }]}>
                <Text style={[styles.badgeText, { color: user.isActive !== false ? "#10B981" : colors.error }]}>
                  {user.isActive !== false ? "active" : "inactive"}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
            </View>
          </Pressable>
        )}
      />

      <Modal visible={selected !== null} animationType="slide" presentationStyle="formSheet" onRequestClose={() => setSelected(null)}>
        {selected && (
          <View style={[styles.sheet, { backgroundColor: colors.backgroundSolid }]}>
            <View style={[styles.sheetHeader, { borderBottomColor: colors.border }]}>
              <Pressable onPress={() => setSelected(null)} style={styles.closeBtn}>
                <Ionicons name="close" size={22} color={colors.text} />
              </Pressable>
              <Text style={[styles.sheetTitle, { color: colors.text }]}>
                {[selected.firstName, selected.lastName].filter(Boolean).join(" ") || selected.username}
              </Text>
              <View style={{ width: 36 }} />
            </View>
            <ScrollView contentContainerStyle={styles.sheetBody}>
              <View style={[styles.infoCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                {[
                  ["Username", selected.username],
                  ["Email", selected.email || "—"],
                  ["Practice", selected.practiceName || "—"],
                  ["Last login", formatDate(selected.lastLoginAt)],
                ].map(([label, value]) => (
                  <View key={label} style={[styles.infoRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.infoLabel, { color: colors.textSecondary }]}>{label}</Text>
                    <Text style={[styles.infoValue, { color: colors.text }]}>{value}</Text>
                  </View>
                ))}
              </View>

              <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>ROLE</Text>
              <View style={[styles.segmentWrap, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
                {ROLE_OPTIONS.map((r) => (
                  <Pressable
                    key={r}
                    style={[styles.segment, selected.role === r && { backgroundColor: colors.tint }]}
                    onPress={() => {
                      setSelected((p) => p ? { ...p, role: r } : p);
                      patchMutation.mutate({ id: selected.id, changes: { role: r } });
                    }}
                    disabled={patchMutation.isPending}
                  >
                    <Text style={[styles.segmentText, { color: selected.role === r ? "#fff" : colors.textSecondary }]}>
                      {r}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Pressable
                style={[styles.toggleBtn, { borderColor: selected.isActive !== false ? colors.error + "60" : colors.tint }]}
                onPress={() => toggleActive(selected)}
                disabled={patchMutation.isPending}
              >
                <Text style={[styles.toggleBtnText, { color: selected.isActive !== false ? colors.error : colors.tint }]}>
                  {selected.isActive !== false ? "Deactivate account" : "Reactivate account"}
                </Text>
              </Pressable>
            </ScrollView>
          </View>
        )}
      </Modal>
    </ScreenShell>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      margin: Spacing.lg,
      paddingHorizontal: Spacing.md,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    searchInput: { flex: 1, ...Typography.body, paddingVertical: Spacing.md },
    list: { paddingHorizontal: Spacing.lg, gap: Spacing.sm, paddingBottom: Spacing.xxxl },
    empty: { ...Typography.body, textAlign: "center", marginTop: Spacing.xxl },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      padding: Spacing.md,
      borderRadius: Radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
    },
    avatar: { width: 36, height: 36, borderRadius: Radius.full, alignItems: "center", justifyContent: "center" },
    avatarText: { ...Typography.bodySemibold },
    rowInfo: { flex: 1 },
    rowName: { ...Typography.bodyMedium },
    rowMeta: { ...Typography.caption, marginTop: 2 },
    rowRight: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    badge: { borderRadius: Radius.full, paddingHorizontal: 8, paddingVertical: 2 },
    badgeText: { ...Typography.tiny },
    sheet: { flex: 1 },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: Spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    closeBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    sheetTitle: { ...Typography.h3, textAlign: "center", flex: 1 },
    sheetBody: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxxl },
    infoCard: { borderRadius: Radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
    infoRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    infoLabel: { ...Typography.captionMedium },
    infoValue: { ...Typography.body },
    sectionTitle: { ...Typography.label, paddingHorizontal: 2 },
    segmentWrap: {
      flexDirection: "row",
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      padding: 3,
      gap: 3,
    },
    segment: { flex: 1, alignItems: "center", paddingVertical: Spacing.sm, borderRadius: Radius.sm },
    segmentText: { ...Typography.captionMedium, textTransform: "capitalize" },
    toggleBtn: {
      borderWidth: 1,
      borderRadius: Radius.md,
      padding: Spacing.md,
      alignItems: "center",
    },
    toggleBtnText: { ...Typography.bodySemibold },
  });
}
