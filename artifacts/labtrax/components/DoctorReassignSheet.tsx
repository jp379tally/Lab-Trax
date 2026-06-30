import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  usePreviewDoctorMerge,
  useMergeDoctors,
  undoDoctorMerge,
  getGetDoctorDuplicateClustersQueryKey,
  searchDoctors,
  type DoctorMergeRequest,
  type DoctorSearchEntry,
} from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { FormSheet } from "@/components/ui/FormSheet";

/**
 * DoctorReassignSheet — lets staff fix a wrong doctor choice on a case without
 * re-creating it. The case's current (wrong) doctor is locked in as the only
 * merge SOURCE, the practice is pinned, and the user picks the correct existing
 * doctor in that same practice as the TARGET. Reuses the exact same
 * POST /api/doctors/merge preview + merge + undo endpoints as the duplicate-
 * doctor flow, so the case (plus any pricing overrides) folds onto the chosen
 * doctor and a 10-minute undo is offered.
 */
export function DoctorReassignSheet({
  visible,
  labOrganizationId,
  currentDoctorName,
  currentPracticeId,
  currentPracticeName,
  onClose,
  onReassigned,
}: {
  visible: boolean;
  labOrganizationId: string;
  currentDoctorName: string;
  currentPracticeId: string;
  currentPracticeName?: string | null;
  onClose: () => void;
  onReassigned?: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [targetName, setTargetName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const previewMutation = usePreviewDoctorMerge();
  const previewReset = previewMutation.reset;

  // Reset local state every time the sheet is (re)opened.
  useEffect(() => {
    if (!visible) return;
    setSearch("");
    setDebounced("");
    setTargetName("");
    setError(null);
    previewReset();
  }, [visible, previewReset]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Surface existing doctors in the SAME practice (excluding the current,
  // wrong one). `like` floats likely-correct spellings to the top.
  const searchResult = useQuery({
    queryKey: ["doctors", "search", labOrganizationId, currentPracticeId, debounced],
    enabled: visible && !!labOrganizationId,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await searchDoctors({
        labOrganizationId,
        q: debounced || undefined,
        like: currentDoctorName || undefined,
        limit: 100,
      });
      return res.data?.entries ?? [];
    },
  });

  const candidates = useMemo<DoctorSearchEntry[]>(() => {
    const all = searchResult.data ?? [];
    const curLower = currentDoctorName.trim().toLowerCase();
    return all.filter(
      (e) =>
        (e.providerOrganizationId ?? null) === currentPracticeId &&
        (e.doctorName ?? "").trim().toLowerCase() !== curLower,
    );
  }, [searchResult.data, currentPracticeId, currentDoctorName]);

  const previewBody = useMemo<DoctorMergeRequest>(
    () => ({
      labOrganizationId,
      sources: [
        {
          doctorName: currentDoctorName,
          providerOrganizationId: currentPracticeId,
        },
      ],
      targetDoctorName: targetName,
      targetProviderOrganizationId: currentPracticeId,
    }),
    [labOrganizationId, currentDoctorName, currentPracticeId, targetName],
  );

  const previewMutate = previewMutation.mutate;
  useEffect(() => {
    if (!visible || !targetName.trim()) return;
    previewMutate({ data: previewBody });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewBody, visible]);
  const preview = previewMutation.data?.data;

  const mergeMutation = useMergeDoctors({
    mutation: {
      onSuccess: (res) => {
        const data = res.data;
        queryClient.invalidateQueries({
          queryKey: getGetDoctorDuplicateClustersQueryKey(),
        });
        queryClient.invalidateQueries({ queryKey: ["cases"] });
        const auditLogIds = (data?.entries ?? [])
          .map((e) => e.auditLogId)
          .filter((x): x is string => !!x);
        const moved = data?.casesMoved ?? 0;
        const target = data?.targetDoctorName ?? targetName;
        onReassigned?.();
        onClose();
        Alert.alert(
          "Doctor reassigned",
          `${moved} case${moved === 1 ? "" : "s"} moved to ${target}.`,
          auditLogIds.length > 0
            ? [
                {
                  text: "Undo",
                  style: "destructive",
                  onPress: () => runUndo(auditLogIds),
                },
                { text: "Done", style: "cancel" },
              ]
            : [{ text: "Done", style: "cancel" }],
        );
      },
      onError: (err: unknown) => {
        setError((err as { message?: string })?.message ?? "Reassign failed.");
      },
    },
  });

  async function runUndo(auditLogIds: string[]) {
    try {
      for (const id of auditLogIds) {
        await undoDoctorMerge(id);
      }
      queryClient.invalidateQueries({
        queryKey: getGetDoctorDuplicateClustersQueryKey(),
      });
      queryClient.invalidateQueries({ queryKey: ["cases"] });
      onReassigned?.();
      Alert.alert("Reassignment undone", "The doctor was restored.");
    } catch (err) {
      Alert.alert(
        "Couldn't undo",
        (err as { message?: string })?.message ??
          "The undo window may have passed.",
      );
    }
  }

  const canMerge = !!targetName.trim() && !mergeMutation.isPending;

  function handleMerge() {
    setError(null);
    if (!canMerge) return;
    mergeMutation.mutate({ data: previewBody });
  }

  return (
    <FormSheet
      visible={visible}
      title="Reassign doctor"
      onClose={onClose}
      onSubmit={handleMerge}
      submitting={mergeMutation.isPending}
      submitLabel="Reassign"
      submitDisabled={!canMerge}
    >
      <Text style={styles.intro}>
        Pick the correct doctor for this case. It (and any others under{" "}
        <Text style={styles.introStrong}>{currentDoctorName}</Text> in{" "}
        {currentPracticeName || "this practice"}) will move to your pick.
        You&apos;ll have a few minutes to undo.
      </Text>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Search this practice&apos;s doctors</Text>
        <View style={styles.searchRow}>
          <Ionicons name="search" size={16} color={colors.textTertiary} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Type a doctor name…"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="words"
            autoCorrect={false}
          />
        </View>
      </View>

      <View style={styles.section}>
        {searchResult.isLoading ? (
          <ActivityIndicator color={colors.tint} style={{ marginTop: Spacing.sm }} />
        ) : candidates.length === 0 ? (
          <Text style={styles.helpText}>
            No other doctors found in this practice. Type to search, or add the
            doctor first.
          </Text>
        ) : (
          candidates.map((d) => {
            const name = d.doctorName ?? "";
            const selected = name.trim().toLowerCase() === targetName.trim().toLowerCase();
            return (
              <Pressable
                key={`${name}|${d.providerOrganizationId ?? ""}`}
                style={[styles.optionRow, selected && styles.optionRowSelected]}
                onPress={() => setTargetName(name)}
              >
                <Ionicons
                  name={selected ? "radio-button-on" : "radio-button-off"}
                  size={20}
                  color={selected ? colors.tint : colors.textTertiary}
                />
                <View style={styles.optionMain}>
                  <Text style={styles.optionName}>{name}</Text>
                  <Text style={styles.optionMeta} numberOfLines={1}>
                    {`${d.totalCases ?? 0} ${(d.totalCases ?? 0) === 1 ? "case" : "cases"}`}
                    {(d.similarity ?? 0) > 0.6 ? " · likely match" : ""}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </View>

      <View style={styles.previewBox}>
        <Text style={styles.sectionLabel}>Preview</Text>
        {previewMutation.isPending && !preview ? (
          <ActivityIndicator color={colors.tint} style={{ marginTop: Spacing.xs }} />
        ) : preview && targetName.trim() ? (
          <Text style={styles.previewText}>
            <Text style={styles.previewStrong}>{preview.totalCases ?? 0}</Text>
            {` case${(preview.totalCases ?? 0) === 1 ? "" : "s"} and `}
            <Text style={styles.previewStrong}>{preview.totalOverrides ?? 0}</Text>
            {` pricing override${(preview.totalOverrides ?? 0) === 1 ? "" : "s"} will move to `}
            <Text style={styles.previewStrong}>{targetName}</Text>
            {"."}
            {preview.targetExists
              ? ` ${targetName} already has ${preview.targetCases ?? 0} case${(preview.targetCases ?? 0) === 1 ? "" : "s"}.`
              : ""}
          </Text>
        ) : (
          <Text style={styles.helpText}>Pick a doctor to see what will move.</Text>
        )}
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </FormSheet>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    intro: { ...Typography.caption, color: c.textSecondary },
    introStrong: { ...Typography.captionSemibold, color: c.text },
    section: { gap: Spacing.xs },
    sectionLabel: { ...Typography.captionSemibold, color: c.textSecondary },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingHorizontal: Spacing.sm,
      height: 44,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    searchInput: { flex: 1, ...Typography.body, color: c.text, paddingVertical: 0 },
    optionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.sm,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    optionRowSelected: { borderColor: c.tint, backgroundColor: c.surface },
    optionMain: { flex: 1 },
    optionName: { ...Typography.bodyMedium, color: c.text },
    optionMeta: { ...Typography.caption, color: c.textSecondary },
    previewBox: {
      gap: Spacing.xs,
      padding: Spacing.md,
      borderRadius: Radius.md,
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    previewText: { ...Typography.caption, color: c.textSecondary },
    previewStrong: { ...Typography.captionSemibold, color: c.text },
    helpText: { ...Typography.caption, color: c.textTertiary },
    errorText: { ...Typography.caption, color: c.error },
  });
}
