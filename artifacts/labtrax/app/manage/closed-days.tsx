// Closed Days — mobile screen for admins to manage custom lab-closed days.
//
// Custom closed days are excluded from the business-day denominator used in
// Avg Daily Sales. This screen lets admins add or remove custom dates without
// leaving the mobile app. Reachable from the Stats screen's Avg Daily Sales
// info panel (admin-only path).
import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Alert,
  RefreshControl,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import { getJson, sendJson, isForbiddenError } from "@/lib/read-api";
import { useMe, adminLabMemberships } from "@/lib/auth-me";

interface ClosedDay {
  id: string;
  date: string;
  note: string | null;
  createdByUserId: string | null;
}

const DISPLAY_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "2-digit",
  day: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

function formatClosedDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return DISPLAY_FMT.format(new Date(Date.UTC(y, m - 1, d)));
}

function todayYmd(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

export default function ClosedDaysScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();

  const meQuery = useMe();
  const me = meQuery.data;

  const adminLabs = useMemo(() => adminLabMemberships(me), [me]);
  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const labId = selectedLabId ?? adminLabs[0]?.organizationId ?? null;
  const isAdmin = adminLabs.length > 0;

  const closedDaysQuery = useQuery<{ closedDays: ClosedDay[] }>({
    enabled: !!labId,
    queryKey: ["closed-days", labId],
    queryFn: () =>
      getJson(`/api/organizations/${encodeURIComponent(labId!)}/settings/closed-days`),
    staleTime: 30_000,
  });

  const days = closedDaysQuery.data?.closedDays ?? [];

  const [newDate, setNewDate] = useState(todayYmd());
  const [newNote, setNewNote] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: () => {
      if (!labId) throw new Error("No lab selected.");
      if (!newDate) throw new Error("Date is required.");
      return sendJson("POST", `/api/organizations/${encodeURIComponent(labId)}/settings/closed-days`, {
        date: newDate,
        note: newNote.trim() || undefined,
      });
    },
    onSuccess: () => {
      setNewDate(todayYmd());
      setNewNote("");
      setAddError(null);
      void qc.invalidateQueries({ queryKey: ["closed-days", labId] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (err: Error) => {
      setAddError(err.message || "Could not add closed day.");
    },
  });

  const [deletingDate, setDeletingDate] = useState<string | null>(null);

  function confirmDelete(date: string) {
    Alert.alert(
      "Remove closed day",
      `Remove ${formatClosedDate(date)} from your closed days?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => void handleDelete(date),
        },
      ],
    );
  }

  async function handleDelete(date: string) {
    if (!labId) return;
    setDeletingDate(date);
    try {
      await sendJson(
        "DELETE",
        `/api/organizations/${encodeURIComponent(labId)}/settings/closed-days/${encodeURIComponent(date)}`,
      );
      void qc.invalidateQueries({ queryKey: ["closed-days", labId] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
    } catch (err: unknown) {
      Alert.alert(
        "Error",
        err instanceof Error ? err.message : "Could not remove closed day.",
      );
    } finally {
      setDeletingDate(null);
    }
  }

  const isBlocked = !meQuery.isLoading && !isAdmin;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <DismissKeyboardView
        style={[styles.screen, { paddingTop: insets.top }]}
        testID="closed-days-keyboard-dismiss"
      >
        <View style={styles.header}>
          <Pressable
            style={styles.backBtn}
            onPress={() => router.back()}
            hitSlop={8}
            testID="closed-days-back"
          >
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </Pressable>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>
              Closed Days
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              Excluded from avg daily sales
            </Text>
          </View>
        </View>

        {meQuery.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.tint} />
          </View>
        ) : isBlocked ? (
          <View style={styles.center} testID="closed-days-blocked">
            <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
            <Text style={styles.emptyTitle}>Not available</Text>
            <Text style={styles.emptyBody}>
              Managing closed days requires an admin or owner role.
            </Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={scrollKeyboardDismissMode}
            refreshControl={
              <RefreshControl
                refreshing={closedDaysQuery.isFetching}
                onRefresh={() => void closedDaysQuery.refetch()}
                tintColor={colors.tint}
              />
            }
          >
            {adminLabs.length > 1 ? (
              <View style={styles.labPickerRow}>
                <Text style={styles.sectionLabel}>Lab</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.labChipRow}>
                    {adminLabs.map((m) => {
                      const active = (labId ?? adminLabs[0]?.organizationId) === m.organizationId;
                      return (
                        <Pressable
                          key={m.organizationId}
                          onPress={() => setSelectedLabId(m.organizationId)}
                          style={[styles.labChip, active && styles.labChipActive]}
                          testID={`closed-days-lab-${m.organizationId}`}
                        >
                          <Text style={[styles.labChipText, active && styles.labChipTextActive]}>
                            {m.organization?.name ?? m.organizationId}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </ScrollView>
              </View>
            ) : null}

            <Card style={styles.addCard}>
              <Text style={styles.sectionLabel}>Add a closed day</Text>
              <Text style={styles.addHint}>
                Custom closed days are excluded from the business-day denominator used
                in Avg Daily Sales.
              </Text>
              <View style={styles.dateRow}>
                <Text style={styles.fieldLabel}>Date</Text>
                <TextInput
                  style={styles.dateInput}
                  value={newDate}
                  onChangeText={(v) => { setNewDate(v); setAddError(null); }}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="closed-days-new-date"
                />
              </View>
              <View style={styles.noteRow}>
                <Text style={styles.fieldLabel}>Note (optional)</Text>
                <TextInput
                  style={styles.noteInput}
                  value={newNote}
                  onChangeText={setNewNote}
                  placeholder="e.g. Lab holiday"
                  placeholderTextColor={colors.textTertiary}
                  maxLength={200}
                  testID="closed-days-new-note"
                />
              </View>
              {addError ? (
                <Text style={styles.errorText} testID="closed-days-add-error">
                  {addError}
                </Text>
              ) : null}
              <Pressable
                style={[
                  styles.addBtn,
                  (!newDate || addMutation.isPending || !labId) && styles.addBtnDisabled,
                ]}
                disabled={!newDate || addMutation.isPending || !labId}
                onPress={() => addMutation.mutate()}
                testID="closed-days-add-btn"
              >
                {addMutation.isPending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="add" size={16} color="#fff" />
                    <Text style={styles.addBtnText}>Add closed day</Text>
                  </>
                )}
              </Pressable>
            </Card>

            <View style={styles.listSection}>
              <Text style={styles.sectionLabel}>Custom closed days</Text>
              {closedDaysQuery.isLoading && !closedDaysQuery.data ? (
                <ActivityIndicator color={colors.tint} style={styles.listSpinner} />
              ) : closedDaysQuery.isError ? (
                <Text style={styles.errorText} testID="closed-days-load-error">
                  {isForbiddenError(closedDaysQuery.error)
                    ? "You don't have permission to manage this lab's closed days."
                    : "Could not load closed days. Pull to refresh."}
                </Text>
              ) : days.length === 0 ? (
                <Text style={styles.emptyNote} testID="closed-days-empty">
                  No custom closed days yet. Add one above.
                </Text>
              ) : (
                days
                  .slice()
                  .sort((a, b) => a.date.localeCompare(b.date))
                  .map((day) => (
                    <View key={day.id} style={styles.dayRow} testID={`closed-day-${day.date}`}>
                      <View style={styles.dayInfo}>
                        <Text style={styles.dayDate}>{formatClosedDate(day.date)}</Text>
                        {day.note ? (
                          <Text style={styles.dayNote}>{day.note}</Text>
                        ) : null}
                      </View>
                      <Pressable
                        onPress={() => confirmDelete(day.date)}
                        disabled={deletingDate === day.date}
                        hitSlop={8}
                        style={styles.deleteBtn}
                        testID={`closed-day-delete-${day.date}`}
                      >
                        {deletingDate === day.date ? (
                          <ActivityIndicator size="small" color={colors.textTertiary} />
                        ) : (
                          <Ionicons name="trash-outline" size={18} color={colors.textTertiary} />
                        )}
                      </Pressable>
                    </View>
                  ))
              )}
            </View>
          </ScrollView>
        )}
      </DismissKeyboardView>
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    backBtn: {
      padding: 4,
      marginRight: Spacing.xs,
    },
    headerText: {
      flex: 1,
    },
    title: {
      ...Typography.h2,
      color: colors.text,
    },
    subtitle: {
      ...Typography.caption,
      color: colors.textSecondary,
      marginTop: 1,
    },
    center: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: Spacing.xl,
      gap: Spacing.sm,
    },
    emptyTitle: {
      ...Typography.bodySemibold,
      color: colors.text,
      textAlign: "center",
    },
    emptyBody: {
      ...Typography.body,
      color: colors.textSecondary,
      textAlign: "center",
    },
    content: {
      padding: Spacing.md,
      gap: Spacing.md,
    },
    labPickerRow: {
      gap: Spacing.xs,
    },
    labChipRow: {
      flexDirection: "row",
      gap: Spacing.xs,
    },
    labChip: {
      paddingHorizontal: Spacing.sm,
      paddingVertical: 6,
      borderRadius: Radius.full,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    labChipActive: {
      backgroundColor: colors.tint,
      borderColor: colors.tint,
    },
    labChipText: {
      ...Typography.body,
      color: colors.textSecondary,
    },
    labChipTextActive: {
      color: "#fff",
      fontWeight: "600" as const,
    },
    addCard: {
      padding: Spacing.md,
      gap: Spacing.sm,
    },
    sectionLabel: {
      ...Typography.label,
      color: colors.textSecondary,
    },
    addHint: {
      ...Typography.caption,
      color: colors.textTertiary,
    },
    fieldLabel: {
      ...Typography.captionSemibold,
      color: colors.textSecondary,
      marginBottom: 4,
    },
    dateRow: {
      gap: 2,
    },
    noteRow: {
      gap: 2,
    },
    dateInput: {
      height: 40,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      fontSize: 14,
      color: colors.text,
    },
    noteInput: {
      height: 40,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      fontSize: 14,
      color: colors.text,
    },
    errorText: {
      ...Typography.caption,
      color: "#DC2626",
    },
    addBtn: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: Spacing.xs,
      height: 40,
      borderRadius: Radius.md,
      backgroundColor: colors.tint,
      marginTop: Spacing.xs,
    },
    addBtnDisabled: {
      opacity: 0.5,
    },
    addBtnText: {
      ...Typography.bodySemibold,
      color: "#fff",
    },
    listSection: {
      gap: Spacing.sm,
    },
    listSpinner: {
      marginVertical: Spacing.md,
    },
    emptyNote: {
      ...Typography.body,
      color: colors.textTertiary,
      fontStyle: "italic" as const,
    },
    dayRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      gap: Spacing.sm,
    },
    dayInfo: {
      flex: 1,
    },
    dayDate: {
      ...Typography.bodySemibold,
      color: colors.text,
    },
    dayNote: {
      ...Typography.caption,
      color: colors.textSecondary,
      marginTop: 2,
    },
    deleteBtn: {
      padding: 4,
    },
  });
}
