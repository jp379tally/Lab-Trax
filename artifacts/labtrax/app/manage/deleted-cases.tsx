import React, { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { getJson, sendJson } from "@/lib/read-api";
import { useMe, primaryAdminLabOrgId } from "@/lib/auth-me";

interface DeletedCase {
  id: string;
  caseNumber: string;
  patientFirstName: string;
  patientLastName: string;
  doctorName: string;
  labOrganizationId: string;
  deletedAt: string;
  deletedByUserId?: string | null;
  createdAt: string;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

export default function DeletedCasesScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const meQuery = useMe();
  const labOrgId = primaryAdminLabOrgId(meQuery.data);

  const deletedQuery = useQuery<{ cases: DeletedCase[] }>({
    enabled: !!labOrgId,
    queryKey: ["cases", "deleted", labOrgId],
    queryFn: () =>
      getJson(`/api/cases/deleted?labOrganizationId=${encodeURIComponent(labOrgId!)}`),
    staleTime: 30_000,
  });

  const cases = useMemo(() => {
    const raw = deletedQuery.data;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw as DeletedCase[];
    return (raw as { cases?: DeletedCase[] }).cases ?? [];
  }, [deletedQuery.data]);

  const restoreMutation = useMutation({
    mutationFn: (caseId: string) =>
      sendJson("POST", `/api/cases/${caseId}/restore`),
    onSuccess: (_data, caseId) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["cases", "deleted", labOrgId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      router.push(`/case/${caseId}`);
    },
  });

  const handleRestore = useCallback(
    (item: DeletedCase) => {
      Alert.alert(
        "Restore Case",
        `Restore case ${item.caseNumber} for ${item.patientFirstName} ${item.patientLastName}? Any linked frozen invoices will also be unfrozen.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Restore",
            onPress: () => {
              restoreMutation.mutate(item.id, {
                onError: (err: unknown) => {
                  const msg =
                    err instanceof Error ? err.message : "Could not restore case.";
                  Alert.alert("Restore failed", msg);
                },
              });
            },
          },
        ],
      );
    },
    [restoreMutation],
  );

  const isRefreshing = deletedQuery.isFetching && !deletedQuery.isLoading;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={20} color={colors.tint} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title}>Deleted Cases</Text>
          <Text style={styles.subtitle}>Restore soft-deleted cases</Text>
        </View>
      </View>

      {deletedQuery.isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.tint} />
        </View>
      ) : deletedQuery.isError ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>Failed to load deleted cases.</Text>
          <Pressable
            style={styles.retryBtn}
            onPress={() => deletedQuery.refetch()}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => deletedQuery.refetch()}
              tintColor={colors.tint}
            />
          }
        >
          {cases.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="trash-outline" size={40} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>No deleted cases</Text>
              <Text style={styles.emptySubtitle}>
                Cases you delete will appear here and can be restored.
              </Text>
            </View>
          ) : (
            cases.map((item) => (
              <Card key={item.id} style={styles.caseCard}>
                <View style={styles.caseHeader}>
                  <Text style={styles.caseNumber}>{item.caseNumber}</Text>
                  <Text style={styles.deletedDate}>
                    Deleted {formatDate(item.deletedAt)}
                  </Text>
                </View>
                <Text style={styles.patientName}>
                  {item.patientFirstName} {item.patientLastName}
                </Text>
                <Text style={styles.doctorName}>{item.doctorName}</Text>
                <Pressable
                  style={[
                    styles.restoreBtn,
                    restoreMutation.isPending && styles.btnDisabled,
                  ]}
                  onPress={() => handleRestore(item)}
                  disabled={restoreMutation.isPending}
                  testID={`restore-case-${item.id}`}
                >
                  {restoreMutation.isPending ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Ionicons name="refresh-outline" size={15} color="#fff" /* hex-allow: white icon on colored button */ />
                  )}
                  <Text style={styles.restoreBtnText}>Restore Case</Text>
                </Pressable>
              </Card>
            ))
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
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.sm,
      gap: Spacing.sm,
    },
    backBtn: {
      width: 36,
      height: 36,
      borderRadius: Radius.md,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
    },
    headerText: { flex: 1 },
    title: { ...Typography.h1, color: c.text },
    subtitle: { ...Typography.caption, color: c.textSecondary, marginTop: 2 },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.md,
    },
    errorText: { ...Typography.body, color: c.error },
    retryBtn: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      backgroundColor: c.tint,
      borderRadius: Radius.md,
    },
    retryText: { ...Typography.bodyMedium, color: "#fff" /* hex-allow: white text on tint button */ },
    content: {
      padding: Spacing.lg,
      paddingTop: Spacing.sm,
      gap: Spacing.sm,
    },
    emptyContainer: {
      alignItems: "center",
      paddingTop: 60,
      gap: Spacing.sm,
    },
    emptyTitle: { ...Typography.h2, color: c.text, marginTop: Spacing.sm },
    emptySubtitle: {
      ...Typography.body,
      color: c.textSecondary,
      textAlign: "center",
      maxWidth: 260,
    },
    caseCard: { gap: Spacing.xs },
    caseHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    caseNumber: { ...Typography.bodyLgMedium, color: c.text },
    deletedDate: { ...Typography.caption, color: c.textTertiary },
    patientName: { ...Typography.body, color: c.text },
    doctorName: { ...Typography.caption, color: c.textSecondary },
    restoreBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      marginTop: Spacing.sm,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.lg,
      backgroundColor: c.tint,
      borderRadius: Radius.md,
    },
    btnDisabled: { opacity: 0.6 },
    restoreBtnText: {
      ...Typography.bodyMedium,
      color: "#fff", /* hex-allow: white text on tint button */
    },
  });
}
