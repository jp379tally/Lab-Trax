import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  TextInput,
} from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Typography, Radius } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { getJson } from "@/lib/read-api";
import { useMe, primaryLabOrgId } from "@/lib/auth-me";
import { formatMoney } from "@/lib/format";

const OPEN_STATUSES = new Set([
  "received",
  "in_design",
  "in_milling",
  "in_porcelain",
  "qc",
  "on_hold",
  "remake",
]);

interface OrgEntry {
  id: string;
  name: string;
  displayName?: string | null;
  type?: string | null;
  deletedAt?: string | null;
  address?: string | null;
  phone?: string | null;
}

interface CaseEntry {
  id: string;
  status?: string | null;
  providerOrganizationId?: string | null;
}

interface InvoiceEntry {
  id: string;
  providerOrganizationId?: string | null;
  total?: number | string | null;
  balanceDue?: number | string | null;
}

interface PracticeStats {
  caseCount: number;
  openCaseCount: number;
  openBalance: number;
  totalBilled: number;
}

export default function AccountsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const labOrgId = primaryLabOrgId(useMe().data);
  const [search, setSearch] = useState("");

  const orgsQuery = useQuery<OrgEntry[]>({
    queryKey: ["organizations-accounts", labOrgId ?? "", { includeLabPractices: true }],
    enabled: !!labOrgId,
    staleTime: 60_000,
    // Opt into the lab's full practice set (regardless of membership) so a
    // practice that blocks creation is still findable/selectable here. Mirrors
    // the desktop accounts screen. Settings → Organizations stays
    // membership-only (default, no flag).
    queryFn: () => getJson<OrgEntry[]>(`/api/organizations?includeLabPractices=true`),
  });

  const casesQuery = useQuery<CaseEntry[]>({
    queryKey: ["cases-for-accounts", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: () => getJson<CaseEntry[]>(`/api/cases`),
  });

  const invoicesQuery = useQuery<InvoiceEntry[]>({
    queryKey: ["invoices-for-accounts", labOrgId ?? ""],
    enabled: !!labOrgId,
    staleTime: 30_000,
    queryFn: () =>
      getJson<InvoiceEntry[]>(
        `/api/invoices?labOrganizationId=${encodeURIComponent(labOrgId!)}`,
      ),
  });

  const isLoading =
    orgsQuery.isLoading || casesQuery.isLoading || invoicesQuery.isLoading;
  const isRefetching =
    orgsQuery.isRefetching || casesQuery.isRefetching || invoicesQuery.isRefetching;

  const stats = useMemo<Map<string, PracticeStats>>(() => {
    const map = new Map<string, PracticeStats>();
    for (const c of casesQuery.data ?? []) {
      const id = c.providerOrganizationId;
      if (!id) continue;
      const cur = map.get(id) ?? {
        caseCount: 0,
        openCaseCount: 0,
        openBalance: 0,
        totalBilled: 0,
      };
      cur.caseCount += 1;
      if (OPEN_STATUSES.has((c.status ?? "").toLowerCase())) {
        cur.openCaseCount += 1;
      }
      map.set(id, cur);
    }
    for (const inv of invoicesQuery.data ?? []) {
      const id = inv.providerOrganizationId;
      if (!id) continue;
      const cur = map.get(id) ?? {
        caseCount: 0,
        openCaseCount: 0,
        openBalance: 0,
        totalBilled: 0,
      };
      cur.totalBilled += Number(inv.total ?? 0);
      cur.openBalance += Number(inv.balanceDue ?? 0);
      map.set(id, cur);
    }
    return map;
  }, [casesQuery.data, invoicesQuery.data]);

  const practices = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (orgsQuery.data ?? [])
      .filter((o) => o.type === "provider" && !o.deletedAt)
      .filter((o) => {
        if (!q) return true;
        return (o.displayName || o.name).toLowerCase().includes(q);
      })
      .sort((a, b) =>
        (a.displayName || a.name).localeCompare(b.displayName || b.name),
      );
  }, [orgsQuery.data, search]);

  function handlePress(org: OrgEntry) {
    router.push({
      pathname: "/finance/doctor-cases",
      params: {
        providerOrganizationId: org.id,
        practiceName: org.displayName || org.name,
      },
    });
  }

  function refresh() {
    orgsQuery.refetch();
    casesQuery.refetch();
    invoicesQuery.refetch();
  }

  if (!labOrgId) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + Spacing.lg }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Accounts</Text>
        </View>
        <View style={styles.blocked}>
          <Ionicons name="briefcase-outline" size={36} color={colors.textTertiary} />
          <Text style={styles.blockedTitle}>No lab selected</Text>
          <Text style={styles.blockedBody}>
            Accounts are scoped to a lab. This view is available to lab members.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Accounts</Text>
        <Text style={styles.subtitle}>
          {isLoading
            ? "Loading…"
            : `${practices.length} practice${practices.length === 1 ? "" : "s"}`}
        </Text>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons
          name="search-outline"
          size={16}
          color={colors.textTertiary}
          style={styles.searchIcon}
        />
        <TextInput
          style={styles.searchInput}
          placeholder="Search practices…"
          placeholderTextColor={colors.textTertiary}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : (
        <FlatList
          data={practices}
          keyExtractor={(o) => o.id}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + Spacing.xl },
          ]}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refresh} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons
                name="briefcase-outline"
                size={36}
                color={colors.textTertiary}
              />
              <Text style={styles.emptyTitle}>No practices</Text>
              <Text style={styles.emptyBody}>
                {search
                  ? "No practices match your search."
                  : "Provider accounts will appear here once cases have been created."}
              </Text>
            </View>
          }
          renderItem={({ item: org }) => {
            const st = stats.get(org.id) ?? {
              caseCount: 0,
              openCaseCount: 0,
              openBalance: 0,
              totalBilled: 0,
            };
            const displayName = org.displayName || org.name;
            return (
              <TouchableOpacity
                onPress={() => handlePress(org)}
                activeOpacity={0.7}
              >
                <Card style={styles.card}>
                  <View style={styles.cardHeader}>
                    <View style={styles.cardMain}>
                      <Text style={styles.orgName} numberOfLines={1}>
                        {displayName}
                      </Text>
                      <Text style={styles.orgMeta} numberOfLines={1}>
                        {st.openCaseCount > 0
                          ? `${st.openCaseCount} open case${st.openCaseCount === 1 ? "" : "s"}`
                          : st.caseCount > 0
                            ? `${st.caseCount} case${st.caseCount === 1 ? "" : "s"}`
                            : "No cases yet"}
                      </Text>
                    </View>
                    <View style={styles.cardRight}>
                      {st.openBalance > 0 && (
                        <Text style={styles.openBalance}>
                          {formatMoney(st.openBalance)}
                        </Text>
                      )}
                      <Ionicons
                        name="chevron-forward"
                        size={16}
                        color={colors.textTertiary}
                      />
                    </View>
                  </View>
                  {(st.totalBilled > 0 || st.openBalance > 0) && (
                    <View style={styles.statsRow}>
                      <Text style={styles.statLabel}>
                        Total billed{" "}
                        <Text style={styles.statValue}>
                          {formatMoney(st.totalBilled)}
                        </Text>
                      </Text>
                      <Text style={styles.statLabel}>
                        Open balance{" "}
                        <Text
                          style={[
                            styles.statValue,
                            st.openBalance > 0 ? styles.balanceAccent : undefined,
                          ]}
                        >
                          {formatMoney(st.openBalance)}
                        </Text>
                      </Text>
                    </View>
                  )}
                </Card>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      paddingHorizontal: Spacing.lg,
      paddingBottom: Spacing.xs,
      paddingTop: Spacing.md,
    },
    title: { ...Typography.h2, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      marginHorizontal: Spacing.md,
      marginBottom: Spacing.sm,
      paddingHorizontal: Spacing.sm,
      backgroundColor: c.backgroundSolid,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    searchIcon: { marginRight: Spacing.xs },
    searchInput: {
      flex: 1,
      height: 36,
      ...Typography.body,
      color: c.text,
    },
    centered: { flex: 1, alignItems: "center", justifyContent: "center" },
    list: {
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.xs,
      gap: Spacing.sm,
    },
    card: { gap: Spacing.sm },
    cardHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
    },
    cardMain: { flex: 1, gap: 2 },
    orgName: { ...Typography.bodyLgMedium, color: c.text },
    orgMeta: { ...Typography.caption, color: c.textSecondary },
    cardRight: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    openBalance: { ...Typography.bodySemibold, color: c.text },
    statsRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingTop: Spacing.sm,
    },
    statLabel: { ...Typography.caption, color: c.textTertiary },
    statValue: { ...Typography.captionSemibold, color: c.textSecondary },
    balanceAccent: { color: c.tint },
    empty: {
      alignItems: "center",
      paddingVertical: 48,
      gap: Spacing.sm,
      paddingHorizontal: Spacing.xl,
    },
    emptyTitle: { ...Typography.bodyLgMedium, color: c.textSecondary },
    emptyBody: {
      ...Typography.caption,
      color: c.textTertiary,
      textAlign: "center",
    },
    blocked: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.sm,
    },
    blockedTitle: { ...Typography.bodyLgMedium, color: c.textSecondary },
    blockedBody: {
      ...Typography.caption,
      color: c.textTertiary,
      textAlign: "center",
    },
  });
}
