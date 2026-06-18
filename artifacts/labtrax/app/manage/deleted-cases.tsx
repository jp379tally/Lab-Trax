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

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  function enterSelectionMode() {
    setSelectionMode(true);
    setSelectedIds(new Set());
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  function toggleSelection(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  const bulkRestoreMutation = useMutation({
    mutationFn: (caseIds: string[]) =>
      sendJson("POST", "/api/cases/bulk-restore", {
        caseIds,
        labOrganizationId: labOrgId!,
      }) as Promise<{ restored: string[]; failed: { id: string; reason: string }[] }>,
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: ["cases", "deleted", labOrgId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      exitSelectionMode();
      const restoredCount = result.restored?.length ?? 0;
      const failedItems = result.failed ?? [];
      if (failedItems.length > 0) {
        const caseNumberById = new Map(cases.map((c) => [c.id, c.caseNumber]));
        const lines = failedItems
          .map((f) => {
            const caseNum = caseNumberById.get(f.id) ?? f.id;
            return `• ${caseNum}: ${f.reason}`;
          })
          .join("\n");
        Alert.alert(
          `${restoredCount} case${restoredCount !== 1 ? "s" : ""} restored`,
          `${failedItems.length} could not be restored:\n${lines}`,
        );
      } else {
        Alert.alert(
          "Cases restored",
          `${restoredCount} case${restoredCount !== 1 ? "s" : ""} have been restored.`,
        );
      }
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Could not restore cases.";
      Alert.alert("Restore failed", msg);
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

  function handleBulkRestorePress() {
    const count = selectedIds.size;
    Alert.alert(
      "Restore Cases",
      `Restore ${count} case${count !== 1 ? "s" : ""}? Any linked frozen invoices will also be unfrozen.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restore",
          onPress: () => bulkRestoreMutation.mutate(Array.from(selectedIds)),
        },
      ],
    );
  }

  const isRefreshing = deletedQuery.isFetching && !deletedQuery.isLoading;
  const isBusy = restoreMutation.isPending || bulkRestoreMutation.isPending;

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
        {selectionMode ? (
          <Pressable style={styles.headerActionBtn} onPress={exitSelectionMode} disabled={isBusy}>
            <Text style={styles.headerActionText}>Cancel</Text>
          </Pressable>
        ) : (
          cases.length > 0 && (
            <Pressable style={styles.headerActionBtn} onPress={enterSelectionMode}>
              <Text style={styles.headerActionText}>Select</Text>
            </Pressable>
          )
        )}
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
          contentContainerStyle={[
            styles.content,
            selectionMode && selectedIds.size > 0 && styles.contentWithBar,
          ]}
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
              <Pressable
                key={item.id}
                onPress={selectionMode ? () => toggleSelection(item.id) : undefined}
              >
                <Card style={[styles.caseCard, selectionMode && selectedIds.has(item.id) && styles.caseCardSelected]}>
                  <View style={styles.cardRow}>
                    <View style={styles.cardContent}>
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
                      {!selectionMode && (
                        <Pressable
                          style={[
                            styles.restoreBtn,
                            isBusy && styles.btnDisabled,
                          ]}
                          onPress={() => handleRestore(item)}
                          disabled={isBusy}
                          testID={`restore-case-${item.id}`}
                        >
                          {restoreMutation.isPending ? (
                            <ActivityIndicator color="#fff" size="small" />
                          ) : (
                            <Ionicons name="refresh-outline" size={15} color="#fff" /* hex-allow: white icon on colored button */ />
                          )}
                          <Text style={styles.restoreBtnText}>Restore Case</Text>
                        </Pressable>
                      )}
                    </View>
                    {selectionMode && (
                      <View style={styles.checkboxContainer}>
                        <View style={[
                          styles.checkbox,
                          { borderColor: colors.tint },
                          selectedIds.has(item.id) && { backgroundColor: colors.tint },
                        ]}>
                          {selectedIds.has(item.id) && (
                            <Ionicons name="checkmark" size={14} color="#fff" /* hex-allow: white checkmark */ />
                          )}
                        </View>
                      </View>
                    )}
                  </View>
                </Card>
              </Pressable>
            ))
          )}
        </ScrollView>
      )}

      {selectionMode && selectedIds.size > 0 && (
        <View style={[styles.floatingBar, { paddingBottom: insets.bottom + Spacing.sm }]}>
          <Pressable
            style={[styles.bulkRestoreBtn, isBusy && styles.btnDisabled]}
            onPress={handleBulkRestorePress}
            disabled={isBusy}
          >
            {bulkRestoreMutation.isPending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Ionicons name="refresh-outline" size={16} color="#fff" /* hex-allow: white icon on colored button */ />
            )}
            <Text style={styles.bulkRestoreBtnText}>
              Restore {selectedIds.size} case{selectedIds.size !== 1 ? "s" : ""}
            </Text>
          </Pressable>
        </View>
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
    headerActionBtn: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
    },
    headerActionText: { ...Typography.bodyMedium, color: c.tint },
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
    contentWithBar: {
      paddingBottom: 80,
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
    caseCardSelected: {
      borderWidth: 2,
      borderColor: c.tint,
    },
    cardRow: {
      flexDirection: "row",
      alignItems: "center",
    },
    cardContent: { flex: 1, gap: Spacing.xs },
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
    checkboxContainer: {
      paddingLeft: Spacing.md,
      alignItems: "center",
      justifyContent: "center",
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      alignItems: "center",
      justifyContent: "center",
    },
    floatingBar: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.sm,
      backgroundColor: c.backgroundSolid,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    bulkRestoreBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.md,
      backgroundColor: c.tint,
      borderRadius: Radius.md,
    },
    bulkRestoreBtnText: {
      ...Typography.bodyMedium,
      color: "#fff", /* hex-allow: white text on tint button */
    },
  });
}
