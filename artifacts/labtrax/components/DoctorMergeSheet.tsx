import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  usePreviewDoctorMerge,
  useMergeDoctors,
  undoDoctorMerge,
  getGetDoctorDuplicateClustersQueryKey,
  type DoctorDuplicateCluster,
  type DoctorMergeRequest,
} from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { resilientFetch } from "@/lib/query-client";
import { FormSheet } from "@/components/ui/FormSheet";

type ClusterDoctor = NonNullable<DoctorDuplicateCluster["doctors"]>[number];

function doctorKey(d: { doctorName?: string | null; providerOrganizationId?: string | null }) {
  return `${(d.doctorName ?? "").toLowerCase()}|${d.providerOrganizationId ?? ""}`;
}

interface LabPractice {
  id: string;
  name?: string | null;
  displayName?: string | null;
}

/**
 * DoctorMergeSheet — mobile counterpart to the desktop MergeDialog. Lets a lab
 * admin pick one doctor in a duplicate cluster as the merge TARGET; every other
 * doctor in the cluster becomes a source whose cases + pricing overrides fold
 * onto the target. Reuses the shared POST /api/doctors/merge preview + merge +
 * undo endpoints. After a successful merge the duplicate-clusters query is
 * invalidated so the nav badge and suspects list refresh, and a 10-minute undo
 * is offered via an alert.
 */
export function DoctorMergeSheet({
  cluster,
  onClose,
}: {
  cluster: DoctorDuplicateCluster | null;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const queryClient = useQueryClient();

  const labId = cluster?.labOrganizationId ?? "";
  const doctors = useMemo<ClusterDoctor[]>(() => cluster?.doctors ?? [], [cluster]);

  // Smart default target: prefer a doctor that already has a practice (folding
  // the practice-less "ghost" entries into the real one is the common intent),
  // breaking ties by most cases. Falls back to the first doctor.
  const defaultTargetKey = useMemo(() => {
    if (doctors.length === 0) return "";
    const withPractice = doctors.filter((d) => !!d.providerOrganizationId);
    const pool = withPractice.length > 0 ? withPractice : doctors;
    const best = [...pool].sort(
      (a, b) => (b.totalCases ?? 0) - (a.totalCases ?? 0),
    )[0];
    return doctorKey(best);
  }, [doctors]);

  const [targetKey, setTargetKey] = useState<string>(defaultTargetKey);
  const [targetPracticeId, setTargetPracticeId] = useState<string | null>(null);
  const [includeSoftDeleted, setIncludeSoftDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewMutation = usePreviewDoctorMerge();

  // Reset local state whenever a new cluster is opened. Also clear the previous
  // preview result so the sheet never flashes a stale count from the last cluster.
  const previewReset = previewMutation.reset;
  useEffect(() => {
    setTargetKey(defaultTargetKey);
    setTargetPracticeId(null);
    setIncludeSoftDeleted(false);
    setError(null);
    previewReset();
  }, [defaultTargetKey, cluster, previewReset]);

  const target = useMemo(
    () => doctors.find((d) => doctorKey(d) === targetKey) ?? null,
    [doctors, targetKey],
  );
  const sources = useMemo(
    () => doctors.filter((d) => doctorKey(d) !== targetKey),
    [doctors, targetKey],
  );

  const targetProviderId =
    target?.providerOrganizationId ?? targetPracticeId ?? null;
  const needsPractice = !!target && !target.providerOrganizationId;

  // Only fetch the lab's practices when the chosen target has no practice on
  // file and the admin must assign one before the merge can run.
  const practicesQuery = useQuery<LabPractice[]>({
    queryKey: ["organizations", "lab-practices", labId],
    enabled: !!labId && needsPractice,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await resilientFetch(
        "/api/organizations?includeLabPractices=true",
      );
      if (!res.ok) throw new Error("Failed to load practices");
      const body = await res.json();
      const all: LabPractice[] = Array.isArray(body?.data)
        ? body.data
        : Array.isArray(body)
          ? body
          : [];
      return all.filter(
        (o: any) =>
          o?.type === "provider" && o?.parentLabOrganizationId === labId,
      );
    },
  });
  const labPractices = practicesQuery.data ?? [];

  const previewBody = useMemo<DoctorMergeRequest>(
    () => ({
      labOrganizationId: labId,
      sources: sources.map((s) => ({
        doctorName: s.doctorName ?? "",
        providerOrganizationId: s.providerOrganizationId ?? null,
      })),
      targetDoctorName: target?.doctorName ?? "",
      targetProviderOrganizationId: targetProviderId,
      includeSoftDeleted,
    }),
    [labId, sources, target, targetProviderId, includeSoftDeleted],
  );

  const previewMutate = previewMutation.mutate;
  useEffect(() => {
    if (!cluster) return;
    if (!target?.doctorName || sources.length === 0) return;
    previewMutate({ data: previewBody });
    // Mutation handle is stable; re-run only when the request body changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewBody, cluster]);
  const preview = previewMutation.data?.data;

  const mergeMutation = useMergeDoctors({
    mutation: {
      onSuccess: (res) => {
        const data = res.data;
        queryClient.invalidateQueries({
          queryKey: getGetDoctorDuplicateClustersQueryKey(),
        });
        const auditLogIds = (data?.entries ?? [])
          .map((e) => e.auditLogId)
          .filter((x): x is string => !!x);
        const moved = data?.casesMoved ?? 0;
        const targetName = data?.targetDoctorName ?? target?.doctorName ?? "";
        onClose();
        Alert.alert(
          "Doctors merged",
          `${moved} case${moved === 1 ? "" : "s"} moved into ${targetName}.`,
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
        setError((err as { message?: string })?.message ?? "Merge failed.");
      },
    },
  });

  async function runUndo(auditLogIds: string[]) {
    try {
      // Each source produced its own audit row; reverse them all.
      for (const id of auditLogIds) {
        await undoDoctorMerge(id);
      }
      queryClient.invalidateQueries({
        queryKey: getGetDoctorDuplicateClustersQueryKey(),
      });
      Alert.alert("Merge undone", "The doctors were restored.");
    } catch (err) {
      Alert.alert(
        "Couldn't undo",
        (err as { message?: string })?.message ??
          "The undo window may have passed.",
      );
    }
  }

  const canMerge =
    !!target?.doctorName &&
    !!targetProviderId &&
    sources.length > 0 &&
    !mergeMutation.isPending;

  function handleMerge() {
    setError(null);
    if (!canMerge) return;
    mergeMutation.mutate({ data: previewBody });
  }

  return (
    <FormSheet
      visible={!!cluster}
      title="Merge duplicate doctors"
      onClose={onClose}
      onSubmit={handleMerge}
      submitting={mergeMutation.isPending}
      submitLabel="Merge"
      submitDisabled={!canMerge}
    >
      <Text style={styles.intro}>
        Pick the name to keep. Every other doctor in this group will be merged
        into it — their cases and pricing move over. You&apos;ll have a few
        minutes to undo.
      </Text>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Keep this doctor</Text>
        {doctors.map((d) => {
          const key = doctorKey(d);
          const selected = key === targetKey;
          return (
            <Pressable
              key={key}
              style={[styles.optionRow, selected && styles.optionRowSelected]}
              onPress={() => {
                setTargetKey(key);
                setTargetPracticeId(null);
              }}
            >
              <Ionicons
                name={selected ? "radio-button-on" : "radio-button-off"}
                size={20}
                color={selected ? colors.tint : colors.textTertiary}
              />
              <View style={styles.optionMain}>
                <Text style={styles.optionName}>{d.doctorName}</Text>
                <Text style={styles.optionMeta} numberOfLines={1}>
                  {(d.practiceName || "No practice") +
                    ` · ${d.totalCases ?? 0} ${(d.totalCases ?? 0) === 1 ? "case" : "cases"}`}
                </Text>
              </View>
              {selected ? (
                <Text style={styles.keepBadge}>Keep</Text>
              ) : (
                <Text style={styles.mergeBadge}>Merge in</Text>
              )}
            </Pressable>
          );
        })}
      </View>

      {needsPractice ? (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            Assign a practice for the kept doctor
          </Text>
          {practicesQuery.isLoading ? (
            <ActivityIndicator color={colors.tint} style={{ marginTop: Spacing.sm }} />
          ) : labPractices.length === 0 ? (
            <Text style={styles.helpText}>
              No practices available — keep a doctor that already has a practice.
            </Text>
          ) : (
            labPractices.map((p) => {
              const selected = p.id === targetPracticeId;
              return (
                <Pressable
                  key={p.id}
                  style={[styles.optionRow, selected && styles.optionRowSelected]}
                  onPress={() => setTargetPracticeId(p.id)}
                >
                  <Ionicons
                    name={selected ? "radio-button-on" : "radio-button-off"}
                    size={20}
                    color={selected ? colors.tint : colors.textTertiary}
                  />
                  <View style={styles.optionMain}>
                    <Text style={styles.optionName}>
                      {p.displayName || p.name}
                    </Text>
                  </View>
                </Pressable>
              );
            })
          )}
        </View>
      ) : null}

      <Pressable
        style={styles.toggleRow}
        onPress={() => setIncludeSoftDeleted((v) => !v)}
      >
        <Ionicons
          name={includeSoftDeleted ? "checkbox" : "square-outline"}
          size={20}
          color={includeSoftDeleted ? colors.tint : colors.textTertiary}
        />
        <Text style={styles.toggleText}>Also move deleted cases</Text>
      </Pressable>

      <View style={styles.previewBox}>
        <Text style={styles.sectionLabel}>Preview</Text>
        {previewMutation.isPending && !preview ? (
          <ActivityIndicator color={colors.tint} style={{ marginTop: Spacing.xs }} />
        ) : preview ? (
          <Text style={styles.previewText}>
            <Text style={styles.previewStrong}>{preview.totalCases ?? 0}</Text>
            {` case${(preview.totalCases ?? 0) === 1 ? "" : "s"} and `}
            <Text style={styles.previewStrong}>
              {preview.totalOverrides ?? 0}
            </Text>
            {` pricing override${(preview.totalOverrides ?? 0) === 1 ? "" : "s"} will move to `}
            <Text style={styles.previewStrong}>{target?.doctorName}</Text>
            {"."}
            {preview.targetExists
              ? ` Target already has ${preview.targetCases ?? 0} case${(preview.targetCases ?? 0) === 1 ? "" : "s"}.`
              : ""}
          </Text>
        ) : (
          <Text style={styles.helpText}>
            Pick a doctor to keep to see what will move.
          </Text>
        )}
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </FormSheet>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    intro: { ...Typography.caption, color: c.textSecondary },
    section: { gap: Spacing.xs },
    sectionLabel: { ...Typography.captionSemibold, color: c.textSecondary },
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
    keepBadge: { ...Typography.captionSemibold, color: c.tint },
    mergeBadge: { ...Typography.caption, color: c.textTertiary },
    toggleRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingVertical: Spacing.xs },
    toggleText: { ...Typography.body, color: c.text },
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
