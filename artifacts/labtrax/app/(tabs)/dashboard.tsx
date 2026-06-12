import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  LayoutAnimation,
  Platform,
  UIManager,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useCases, type CanonicalCase } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { StatusBadge, type BadgeVariant } from "@/components/ui/StatusBadge";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type IconName = React.ComponentProps<typeof Ionicons>["name"];

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

function isClosedCase(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return (
    s.includes("complete") ||
    s.includes("delivered") ||
    s.includes("done") ||
    s.includes("cancel") ||
    s.includes("void")
  );
}

function caseStatusVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? "").toLowerCase();
  if (s.includes("remake")) return "remake";
  if (s.includes("complete") || s.includes("delivered") || s.includes("done")) return "complete";
  if (s.includes("ship") || s.includes("ready") || s.includes("delivery")) return "ship";
  if (s.includes("hold") || s.includes("cancel") || s.includes("void")) return "draft";
  if (s.includes("intake") || s.includes("new") || s.includes("received") || s.includes("pending")) return "intake";
  return "progress";
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = d.getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [dueSoonOpen, setDueSoonOpen] = useState(true);

  const casesQuery = useCases();
  const cases = casesQuery.data ?? [];

  const dueSoon = useMemo(() => {
    return cases
      .filter((c) => {
        if (isClosedCase(c.status)) return false;
        const d = daysUntil(c.dueDate);
        return d != null && d <= 7;
      })
      .sort((a, b) => {
        const da = daysUntil(a.dueDate) ?? 9999;
        const dbv = daysUntil(b.dueDate) ?? 9999;
        return da - dbv;
      });
  }, [cases]);

  function toggleDueSoon() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDueSoonOpen((v) => !v);
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Dashboard</Text>
        <Text style={styles.subtitle}>Your lab at a glance</Text>
      </View>

      {casesQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={casesQuery.isFetching}
              onRefresh={() => casesQuery.refetch()}
              tintColor={colors.tint}
            />
          }
        >
          <Pressable style={styles.sectionHeader} onPress={toggleDueSoon} hitSlop={8}>
            <View style={styles.sectionTitleRow}>
              <Text style={styles.sectionTitle}>Due soon</Text>
              {dueSoon.length > 0 && (
                <View style={[styles.countBadge, { backgroundColor: colors.warningStrong + "1A" }]}>
                  <Text style={[styles.countBadgeText, { color: colors.warningStrong }]}>
                    {dueSoon.length}
                  </Text>
                </View>
              )}
            </View>
            <View style={styles.sectionActions}>
              <Pressable onPress={() => router.push("/(tabs)" as never)} hitSlop={8}>
                <Text style={styles.sectionLink}>All cases</Text>
              </Pressable>
              <Ionicons
                name={dueSoonOpen ? "chevron-up" : "chevron-down"}
                size={16}
                color={colors.textTertiary}
              />
            </View>
          </Pressable>

          {dueSoonOpen && (
            dueSoon.length === 0 ? (
              <Card style={styles.emptyCard}>
                <Ionicons name="checkmark-circle-outline" size={28} color={colors.success} />
                <Text style={styles.emptyText}>Nothing due in the next 7 days.</Text>
              </Card>
            ) : (
              <View style={styles.list}>
                {dueSoon.slice(0, 6).map((c) => {
                  const d = daysUntil(c.dueDate);
                  const overdue = d != null && d < 0;
                  return (
                    <Card
                      key={c.id}
                      style={styles.row}
                      onPress={() => router.push(`/case/${c.id}` as never)}
                    >
                      <View style={styles.rowMain}>
                        <Text style={styles.rowName} numberOfLines={1}>
                          {patientName(c)}
                        </Text>
                        <Text style={styles.rowMeta} numberOfLines={1}>
                          {c.caseNumber ? `#${c.caseNumber}` : "No case #"}
                          {c.doctorName ? `  ·  ${c.doctorName}` : ""}
                        </Text>
                        <Text style={[styles.rowDue, overdue && { color: colors.error }]}>
                          Due {formatDate(c.dueDate)}
                          {d != null
                            ? `  ·  ${overdue ? `${Math.abs(d)}d overdue` : d === 0 ? "today" : `in ${d}d`}`
                            : ""}
                        </Text>
                      </View>
                      <StatusBadge
                        label={titleCase(c.status ?? "—")}
                        variant={caseStatusVariant(c.status)}
                        size="sm"
                      />
                    </Card>
                  );
                })}
              </View>
            )
          )}
        </ScrollView>
      )}
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
    },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: Spacing.xl, minHeight: 280 },
    content: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.md },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sectionTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    sectionTitle: { ...Typography.h2, color: c.text },
    countBadge: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: Radius.full ?? 99,
    },
    countBadgeText: { ...Typography.captionSemibold },
    sectionActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
    },
    sectionLink: { ...Typography.captionSemibold, color: c.tint },
    list: { gap: Spacing.sm },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    rowMain: { flex: 1, gap: 2 },
    rowName: { ...Typography.bodySemibold, color: c.text },
    rowMeta: { ...Typography.caption, color: c.textSecondary },
    rowDue: { ...Typography.caption, color: c.textTertiary, marginTop: 2 },
    emptyCard: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    emptyText: { ...Typography.body, color: c.textSecondary, flex: 1 },
  });
}
