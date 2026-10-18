import React, { useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, TextInput, Alert, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { formatAccountNumberForDisplay } from "@workspace/account-number";
import {
  useGetCaseDoctorCandidates, getGetCaseDoctorCandidatesQueryKey, useReassignCaseDoctor, undoCaseDoctorReassignment,
  refreshCaseDoctorQueries, type CaseDoctorCandidate, type CaseDoctorReassignmentResult,
} from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { FormSheet } from "@/components/ui/FormSheet";
import { DoctorReassignmentNotice } from "./DoctorReassignmentNotice";

interface Props {
  visible: boolean;
  caseId: string;
  caseNumber: string;
  currentDoctorName: string;
  currentPracticeId: string;
  onClose: () => void;
}

/** Case-only action. No directory-merge preview, mutation, or undo is used. */
export function DoctorReassignSheet(props: Props) {
  const [webNotice, setWebNotice] = useState<{ result: CaseDoctorReassignmentResult["data"]; refreshFailed: boolean } | null>(null);
  if (webNotice) return <DoctorReassignmentNotice
    result={webNotice.result} refreshFailed={webNotice.refreshFailed}
    onClose={() => { setWebNotice(null); props.onClose(); }}
  />;
  if (!props.visible) return null;
  return <DoctorReassignContent key={JSON.stringify([props.caseId, props.currentDoctorName, props.currentPracticeId])} {...props}
    onWebSuccess={(result, refreshFailed) => setWebNotice({ result, refreshFailed })}
  />;
}

function DoctorReassignContent({ caseId, caseNumber, currentDoctorName, currentPracticeId, onClose, onWebSuccess }: Props & {
  onWebSuccess: (result: CaseDoctorReassignmentResult["data"], refreshFailed: boolean) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<{ candidate: CaseDoctorCandidate; revision: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const params = { q: search.trim() || undefined, offset, limit: 50 };
  const roster = useGetCaseDoctorCandidates(caseId, params, {
    query: { queryKey: getGetCaseDoctorCandidatesQueryKey(caseId, params), retry: false, staleTime: 0 },
  });
  const mutation = useReassignCaseDoctor();
  const page = roster.data?.data;
  const assignment = page?.assignment;
  const assignmentMatches = assignment?.caseId === caseId && assignment.doctorName === currentDoctorName &&
    assignment.providerOrganizationId === currentPracticeId;
  const candidates = (page?.entries ?? []).filter((entry) => entry.doctorName !== currentDoctorName);
  const canSave = !!selection && assignmentMatches && selection.revision === assignment?.revision &&
    !roster.isFetching && !roster.isError && !saving;

  function close() { if (!inFlight.current) onClose(); }

  function showSuccess(result: CaseDoctorReassignmentResult["data"], refreshed: boolean) {
    let undoing = false;
    const expiresAt = Date.parse(result.undoExpiresAt ?? "");
    async function undo() {
      if (undoing) return;
      if (Date.now() >= expiresAt) {
        Alert.alert("Couldn't undo", "The doctor reassignment undo window has expired.");
        return;
      }
      undoing = true;
      let response: CaseDoctorReassignmentResult;
      try {
        response = await undoCaseDoctorReassignment(result.assignment.caseId, result.auditLogId);
      } catch (err) {
        undoing = false;
        Alert.alert("Couldn't undo", err instanceof Error ? err.message : "The case may have changed, or the undo window has passed.");
        return;
      }
      const refreshed = await refreshCaseDoctorQueries(qc, response.data.assignment);
      Alert.alert("Reassignment undone", `Case ${response.data.assignment.caseNumber}: doctor restored to ${response.data.assignment.doctorName}.${refreshed ? "" : " Saved; reload the case to refresh its history and lists."}`);
    }
    Alert.alert(
      refreshed ? "Doctor changed for this case only" : "Doctor change saved",
      `Case ${result.assignment.caseNumber}: ${result.previousDoctorName} → ${result.assignment.doctorName}. Other cases and saved invoices are unchanged.${refreshed ? "" : " Reload the case to refresh its history and lists. Do not submit the change again."}`,
      expiresAt > Date.now() ? [
        { text: "Undo", style: "destructive", onPress: () => { void undo(); } },
        { text: "Done", style: "cancel" },
      ] : [{ text: "Done", style: "cancel" }],
    );
  }

  async function save() {
    if (inFlight.current || !canSave || !assignment || !selection) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    let response: CaseDoctorReassignmentResult;
    try {
      response = await mutation.mutateAsync({
        caseId,
        data: {
          recordType: assignment.recordType, expectedDoctorName: currentDoctorName,
          expectedPracticeId: currentPracticeId, expectedRevision: selection.revision,
          candidateKey: selection.candidate.key,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the doctor. The saved assignment was not changed.");
      inFlight.current = false;
      setSaving(false);
      return;
    }
    // A refresh failure after commit must never enable a second write.
    onClose();
    const refreshed = await refreshCaseDoctorQueries(qc, response.data.assignment);
    if (Platform.OS === "web") onWebSuccess(response.data, !refreshed);
    else showSuccess(response.data, refreshed);
  }

  return (
    <FormSheet
      visible title="Reassign doctor" onClose={close} onSubmit={() => { void save(); }}
      submitting={saving} submitLabel="Change doctor" submitDisabled={!canSave}
      testIDPrefix="doctor-reassign" boundedBody
    >
      <Text style={styles.intro}>
        Change doctor for this case only. Case {caseNumber} currently has {currentDoctorName}.
        Other cases, pricing, accounts, and saved invoices stay unchanged.
      </Text>
      <Text style={styles.helpText}>
        {assignment?.practiceName ? `Practice: ${assignment.practiceName}. ` : ""}
        Only doctors already associated with this practice are available. If the intended doctor is missing, their association must be managed separately. This action cannot change practices or create accounts.
      </Text>
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Search this practice&apos;s doctors</Text>
        <View style={styles.searchRow}>
          <Ionicons name="search" size={16} color={colors.textTertiary} />
          <TextInput
            style={styles.searchInput} value={search}
            onChangeText={(value) => { setSearch(value); setOffset(0); setSelection(null); setError(null); }}
            placeholder="Type a doctor name…" accessibilityLabel="Search this practice's doctors"
            placeholderTextColor={colors.textTertiary} autoCapitalize="words" autoCorrect={false} editable={!saving}
          />
        </View>
      </View>
      <View style={styles.section}>
        {roster.isError ? (
          <>
            <Text accessibilityRole="alert" style={styles.errorText}>{roster.error instanceof Error ? roster.error.message : "Could not load this practice's doctors."}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Retry doctor search" testID="doctor-reassign-retry" disabled={saving || roster.isFetching} onPress={() => { void roster.refetch(); }} style={styles.pageButton}>
              <Text style={styles.optionName}>Retry doctor search</Text>
            </Pressable>
          </>
        ) : roster.isFetching ? (
          <ActivityIndicator accessibilityLabel="Loading doctors" color={colors.tint} />
        ) : assignment && !assignmentMatches ? (
          <Text accessibilityRole="alert" style={styles.errorText}>The saved doctor or practice changed. Close and reopen this case before reassigning.</Text>
        ) : (
          <>
            {candidates.length === 0 ? <Text style={styles.helpText}>No other eligible doctors on this page. Search or check the next page; a missing doctor must already be associated with this practice.</Text> : candidates.map((candidate) => {
              const selected = selection?.candidate.key === candidate.key;
              return (
                <Pressable
                  key={candidate.key} testID="doctor-reassign-option" accessibilityRole="radio"
                  accessibilityLabel={`${candidate.doctorName}${candidate.platformAccountNumber ? `, account ${formatAccountNumberForDisplay(candidate.platformAccountNumber)}` : ""}`}
                  accessibilityState={{ selected, disabled: saving }} disabled={saving}
                  style={[styles.optionRow, selected && styles.optionRowSelected]}
                  onPress={() => { if (assignment) setSelection({ candidate, revision: assignment.revision }); setError(null); }}
                >
                  <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={selected ? colors.tint : colors.textTertiary} />
                  <View style={styles.optionMain}>
                    <Text style={styles.optionName}>{candidate.doctorName}</Text>
                    <Text style={styles.optionMeta}>
                      {candidate.platformAccountNumber ? `Account ${formatAccountNumberForDisplay(candidate.platformAccountNumber)}` : candidate.userId ? "Registered doctor" : "Name-only practice roster entry"}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
            <View style={styles.pageRow}>
              <Pressable accessibilityRole="button" accessibilityLabel="Previous doctors" disabled={offset === 0 || saving} style={styles.pageButton} onPress={() => { setOffset(Math.max(0, offset - 50)); setSelection(null); }}>
                <Text style={[styles.optionMeta, (offset === 0 || saving) && { opacity: 0.4 }]}>Previous doctors</Text>
              </Pressable>
              <Text style={styles.helpText}>{page?.total ?? 0} doctors</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Next doctors" disabled={page?.nextOffset == null || saving} style={styles.pageButton} onPress={() => { if (page?.nextOffset != null) { setOffset(page.nextOffset); setSelection(null); } }}>
                <Text style={[styles.optionMeta, (page?.nextOffset == null || saving) && { opacity: 0.4 }]}>Next doctors</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
      <View style={styles.previewBox} accessibilityLiveRegion="polite">
        <Text style={styles.previewStrong}>Change doctor for this case only.</Text>
        <Text style={styles.previewText}>Case {caseNumber}: {currentDoctorName} → {selection?.candidate.doctorName ?? "Select a doctor"}.</Text>
        <Text style={styles.helpText}>Undo is available for a short time unless this case changes again.</Text>
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text> : null}
      {selection && assignmentMatches && selection.revision !== assignment?.revision ? (
        <Text accessibilityRole="alert" style={styles.errorText}>This case was updated while you were choosing. Select the doctor again to confirm.</Text>
      ) : null}
    </FormSheet>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    intro: { ...Typography.caption, color: c.textSecondary },
    section: { gap: Spacing.xs },
    sectionLabel: { ...Typography.captionSemibold, color: c.textSecondary },
    searchRow: {
      flexDirection: "row", alignItems: "center", gap: Spacing.sm,
      paddingHorizontal: Spacing.sm, height: 44, borderRadius: Radius.md,
      borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, backgroundColor: c.surface,
    },
    searchInput: { flex: 1, ...Typography.body, color: c.text, paddingVertical: 0 },
    optionRow: {
      flexDirection: "row", alignItems: "center", gap: Spacing.sm,
      paddingVertical: Spacing.sm, paddingHorizontal: Spacing.sm, minHeight: 44,
      borderRadius: Radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
    optionRowSelected: { borderColor: c.tint, backgroundColor: c.surface },
    optionMain: { flex: 1 },
    optionName: { ...Typography.bodyMedium, color: c.text },
    optionMeta: { ...Typography.caption, color: c.textSecondary },
    previewBox: {
      gap: Spacing.xs, padding: Spacing.md, borderRadius: Radius.md,
      backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
    previewText: { ...Typography.caption, color: c.textSecondary },
    previewStrong: { ...Typography.captionSemibold, color: c.text },
    helpText: { ...Typography.caption, color: c.textTertiary },
    errorText: { ...Typography.caption, color: c.error },
    pageRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    pageButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: Spacing.xs },
  });
}
