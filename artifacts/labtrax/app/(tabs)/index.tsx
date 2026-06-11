import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useCases, type CanonicalCase } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";

function patientName(c: CanonicalCase): string {
  const name = `${c.patientFirstName ?? ""} ${c.patientLastName ?? ""}`.trim();
  return name || "Unnamed patient";
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function statusVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("remake")) return "remake";
  if (s.includes("complete") || s.includes("delivered") || s.includes("done")) return "complete";
  if (s.includes("ship") || s.includes("ready") || s.includes("delivery")) return "ship";
  if (s.includes("hold") || s.includes("cancel") || s.includes("void")) return "draft";
  if (s.includes("intake") || s.includes("new") || s.includes("received") || s.includes("pending"))
    return "intake";
  return "progress";
}

export default function CasesListScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [query, setQuery] = useState("");

  const casesQuery = useCases();
  const cases = casesQuery.data ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cases;
    return cases.filter((c) => {
      const haystack = [
        patientName(c),
        c.doctorName ?? "",
        c.caseNumber ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [cases, query]);

  function renderItem({ item }: { item: CanonicalCase }) {
    return (
      <Pressable onPress={() => router.push(`/case/${item.id}` as never)} testID={`case-row-${item.id}`}>
        <Card style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowName} numberOfLines={1}>
              {patientName(item)}
            </Text>
            <Text style={styles.rowMeta} numberOfLines={1}>
              {item.caseNumber ? `#${item.caseNumber}` : "No case #"}
              {item.doctorName ? `  ·  ${item.doctorName}` : ""}
            </Text>
            <Text style={styles.rowDue}>Due {formatDate(item.dueDate)}</Text>
          </View>
          <View style={styles.rowRight}>
            <StatusBadge label={titleCase(item.status ?? "—")} variant={statusVariant(item.status)} />
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          </View>
        </Card>
      </Pressable>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Cases</Text>
        <Text style={styles.subtitle}>
          {casesQuery.isLoading ? "Loading…" : `${filtered.length} case${filtered.length === 1 ? "" : "s"}`}
        </Text>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textTertiary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search patient, doctor, or case #"
          placeholderTextColor={colors.textTertiary}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          testID="cases-search"
        />
        {query.length > 0 ? (
          <Pressable onPress={() => setQuery("")} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
          </Pressable>
        ) : null}
      </View>

      {casesQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : casesQuery.isError ? (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>Couldn’t load cases</Text>
          <Pressable style={styles.retryBtn} onPress={() => casesQuery.refetch()}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(c) => c.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={casesQuery.isFetching}
              onRefresh={() => casesQuery.refetch()}
              tintColor={colors.tint}
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="file-tray-outline" size={40} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>
                {query ? "No matching cases" : "No cases yet"}
              </Text>
              <Text style={styles.emptyBody}>
                {query ? "Try a different search." : "Cases will appear here once created."}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: Spacing.xs },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      marginHorizontal: Spacing.lg,
      marginVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.md,
      backgroundColor: c.surfaceAlt,
    },
    searchInput: { flex: 1, ...Typography.body, color: c.text, paddingVertical: 0 },
    listContent: { padding: Spacing.lg, paddingTop: Spacing.xs, gap: Spacing.sm },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    rowMain: { flex: 1, gap: 2 },
    rowName: { ...Typography.bodySemibold, color: c.text },
    rowMeta: { ...Typography.caption, color: c.textSecondary },
    rowDue: { ...Typography.caption, color: c.textTertiary, marginTop: 2 },
    rowRight: { alignItems: "flex-end", gap: Spacing.xs },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl, gap: Spacing.sm, minHeight: 280 },
    emptyTitle: { ...Typography.h3, color: c.text },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    retryBtn: {
      marginTop: Spacing.sm,
      paddingHorizontal: Spacing.xl,
      paddingVertical: Spacing.sm,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
    },
    retryText: { ...Typography.bodySemibold, color: c.textInverse },
  });
}
