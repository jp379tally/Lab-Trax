import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import {
  useDuplicateDoctorClusters,
  type DoctorDuplicateCluster,
} from "@/lib/duplicate-doctors";
import { DoctorMergeSheet } from "@/components/DoctorMergeSheet";

export default function DuplicateDoctorsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const { query, clusters, totalGroups } = useDuplicateDoctorClusters();
  const isRefreshing = query.isFetching && !query.isLoading;
  const [activeCluster, setActiveCluster] = useState<DoctorDuplicateCluster | null>(
    null,
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={20} color={colors.tint} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title}>Possible duplicates</Text>
          <Text style={styles.subtitle}>
            {totalGroups > 0
              ? `${totalGroups} doctor ${totalGroups === 1 ? "group" : "groups"} look like duplicates`
              : "Doctor names that may be the same person"}
          </Text>
        </View>
      </View>

      {query.isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.tint} />
        </View>
      ) : query.isError ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>Could not load possible duplicates.</Text>
          <Pressable style={styles.retryBtn} onPress={() => query.refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : clusters.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyContainer}
          refreshControl={
            <RefreshControl refreshing={isRefreshing} onRefresh={() => query.refetch()} tintColor={colors.tint} />
          }
        >
          <Ionicons name="checkmark-circle-outline" size={48} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>No duplicates found</Text>
          <Text style={styles.emptySubtitle}>
            We didn&apos;t spot any doctor names that look like duplicates. New matches will appear here automatically.
          </Text>
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={isRefreshing} onRefresh={() => query.refetch()} tintColor={colors.tint} />
          }
        >
          <Text style={styles.note}>
            These doctor names look similar enough to be the same person. Tap a group to merge them.
          </Text>
          {clusters.map((cluster, ci) => {
            const doctors = cluster.doctors ?? [];
            const score =
              typeof cluster.topScore === "number"
                ? `${Math.round(cluster.topScore * 100)}% similar`
                : null;
            return (
              <Card
                key={`${cluster.labOrganizationId}-${ci}`}
                style={styles.clusterCard}
                onPress={() => setActiveCluster(cluster)}
              >
                <View style={styles.clusterHeader}>
                  <View style={styles.clusterHeaderMain}>
                    <Ionicons name="git-merge-outline" size={18} color={colors.tint} />
                    <Text style={styles.clusterLab} numberOfLines={1}>
                      {cluster.labName || "Your lab"}
                    </Text>
                  </View>
                  {score ? <Text style={styles.score}>{score}</Text> : null}
                </View>
                <View style={styles.doctorList}>
                  {doctors.map((d, di) => (
                    <View key={di} style={styles.doctorRow}>
                      <Ionicons name="person-outline" size={15} color={colors.textSecondary} />
                      <View style={styles.doctorMain}>
                        <Text style={styles.doctorName}>{d.doctorName}</Text>
                        <Text style={styles.doctorMeta} numberOfLines={1}>
                          {(d.practiceName || "No practice") +
                            ` · ${d.totalCases ?? 0} ${(d.totalCases ?? 0) === 1 ? "case" : "cases"}`}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
                <View style={styles.mergeHint}>
                  <Ionicons name="git-merge-outline" size={14} color={colors.tint} />
                  <Text style={styles.mergeHintText}>Tap to merge</Text>
                  <Ionicons name="chevron-forward" size={14} color={colors.textTertiary} />
                </View>
              </Card>
            );
          })}
        </ScrollView>
      )}

      <DoctorMergeSheet
        cluster={activeCluster}
        onClose={() => setActiveCluster(null)}
      />
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
    },
    backBtn: { padding: Spacing.xs },
    headerText: { flex: 1 },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: Spacing.md, padding: Spacing.lg },
    errorText: { ...Typography.body, color: c.error },
    retryBtn: {
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      backgroundColor: c.tint,
      borderRadius: Radius.md,
    },
    retryText: { ...Typography.bodyMedium, color: c.textInverse },
    content: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.sm },
    note: { ...Typography.caption, color: c.textSecondary, marginBottom: Spacing.xs },
    emptyContainer: { alignItems: "center", paddingTop: 60, gap: Spacing.sm, padding: Spacing.lg },
    emptyTitle: { ...Typography.h2, color: c.text, marginTop: Spacing.sm },
    emptySubtitle: { ...Typography.body, color: c.textSecondary, textAlign: "center", maxWidth: 280 },
    clusterCard: { gap: Spacing.sm },
    clusterHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm },
    clusterHeaderMain: { flexDirection: "row", alignItems: "center", gap: Spacing.xs, flex: 1 },
    clusterLab: { ...Typography.bodyMedium, color: c.text, flex: 1 },
    score: { ...Typography.captionSemibold, color: c.tint },
    doctorList: { gap: Spacing.sm },
    doctorRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    doctorMain: { flex: 1 },
    doctorName: { ...Typography.bodyMedium, color: c.text },
    doctorMeta: { ...Typography.caption, color: c.textSecondary },
    mergeHint: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      marginTop: Spacing.xs,
      paddingTop: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    mergeHintText: { ...Typography.captionSemibold, color: c.tint, flex: 1 },
  });
}
