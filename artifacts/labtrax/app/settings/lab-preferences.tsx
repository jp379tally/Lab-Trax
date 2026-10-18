import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TextInput,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
  Switch,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { ScreenShell } from "@/components/settings/SettingsRow";
import { scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { resilientFetch } from "@/lib/query-client";
import { useMe } from "@/lib/auth-me";
import { ME_QUERY_KEY } from "@/lib/auth-me";

interface OrgMembershipWithOrg {
  id: string;
  role: string;
  organizationId: string;
  organization?: {
    id?: string;
    type?: string;
    defaultCaseDueDays?: number | null;
  } | null;
}

interface QRNote {
  id: string;
  organizationId: string;
  body: string;
  label: string | null;
  isActive: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface QRNListResponse {
  ok: boolean;
  data: { notes: QRNote[] };
}

/**
 * Reads the server's actual error message off a failed Quick Reference
 * Notes response (the shared `{ ok: false, message }` envelope) instead of
 * showing a fixed generic string, so create/edit/delete/reorder failures are
 * diagnosable instead of a dead-end alert.
 */
async function qrnErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message || body.error || fallback;
  } catch {
    return fallback;
  }
}

export default function LabPreferencesScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const meQuery = useMe();
  const qc = useQueryClient();

  const labMembership = (meQuery.data?.memberships as OrgMembershipWithOrg[] | undefined)?.find(
    (m) =>
      (m.organization?.type === "lab" || m.organization?.type === "dental_lab") &&
      (m.role === "owner" || m.role === "admin" || m.role === "billing" || m.role === "user"),
  );
  const providerAdminMembership = (meQuery.data?.memberships as OrgMembershipWithOrg[] | undefined)?.find(
    (m) =>
      m.organization?.type === "provider" &&
      (m.role === "owner" || m.role === "admin"),
  );
  // Providers keep a separate library in their own organization.
  const templateMembership = labMembership ?? providerAdminMembership;
  const orgId = templateMembership?.organizationId ?? null;
  const labOrgId = labMembership?.organizationId ?? null;

  // ── Provider-preferences printing (labs only) ───────────────────────────
  const labSettingsQuery = useQuery<{ printProviderPreferencesOnLabSlips: boolean }>({
    queryKey: ["organization", labOrgId, "lab-preferences"],
    enabled: !!labOrgId,
    queryFn: async () => {
      const res = await resilientFetch(`/api/organizations/${encodeURIComponent(labOrgId!)}`);
      if (!res.ok) throw new Error(`Failed to load lab preferences (${res.status})`);
      const body = (await res.json()) as {
        data?: { printProviderPreferencesOnLabSlips?: boolean };
        printProviderPreferencesOnLabSlips?: boolean;
      };
      const organization = body.data ?? body;
      return { printProviderPreferencesOnLabSlips: organization.printProviderPreferencesOnLabSlips === true };
    },
  });
  const printProviderPreferencesMutation = useMutation({
    mutationFn: async (printProviderPreferencesOnLabSlips: boolean) => {
      if (!labOrgId) throw new Error("Unknown lab ID.");
      const res = await resilientFetch(`/api/organizations/${encodeURIComponent(labOrgId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printProviderPreferencesOnLabSlips }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string; message?: string }).error ?? (body as { message?: string }).message ?? `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["organization", labOrgId, "lab-preferences"] });
      void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    onError: (err: Error) => Alert.alert("Could not save print preference", err.message),
  });

  // ── Default turnaround days ────────────────────────────────────────────
  const [dueDays, setDueDays] = useState(
    labMembership?.organization?.defaultCaseDueDays != null
      ? String(labMembership.organization.defaultCaseDueDays)
      : "",
  );
  const [dueDaysSaved, setDueDaysSaved] = useState(false);

  useEffect(() => {
    const val = labMembership?.organization?.defaultCaseDueDays;
    setDueDays(val != null ? String(val) : "");
  }, [labMembership?.organization?.defaultCaseDueDays]);

  const dueDaysMutation = useMutation({
    mutationFn: async (value: number | null) => {
      if (!orgId) throw new Error("Unknown org ID.");
      const res = await resilientFetch(`/api/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultCaseDueDays: value }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || `Failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setDueDaysSaved(true);
      void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      setTimeout(() => setDueDaysSaved(false), 2500);
    },
    onError: (err: Error) => Alert.alert("Could not save turnaround days", err.message),
  });

  const handleSaveDueDays = () => {
    const val = dueDays.trim();
    const num = val === "" ? null : parseInt(val, 10);
    if (num !== null && (isNaN(num) || num < 1 || num > 365)) {
      Alert.alert("Invalid value", "Enter a number between 1 and 365.");
      return;
    }
    dueDaysMutation.mutate(num);
  };

  // ── Quick Reference Notes ──────────────────────────────────────────────
  const qrnQuery = useQuery<QRNote[]>({
    queryKey: ["quick-reference-notes", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const res = await resilientFetch(`/api/organizations/${orgId}/quick-reference-notes`);
      if (!res.ok) {
        throw new Error(await qrnErrorMessage(res, `Failed to load templates (${res.status})`));
      }
      const body = (await res.json()) as QRNListResponse;
      return body.data?.notes ?? [];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["quick-reference-notes", orgId] });

  const [addingNew, setAddingNew] = useState(false);
  const [newBody, setNewBody] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [seedLoading, setSeedLoading] = useState(false);

  const createMutation = useMutation({
    mutationFn: async () => {
      const notes = qrnQuery.data ?? [];
      const res = await resilientFetch(`/api/organizations/${orgId}/quick-reference-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: newBody.trim(), label: newLabel.trim() || null, displayOrder: notes.length }),
      });
      if (!res.ok) throw new Error(await qrnErrorMessage(res, "Failed to create template"));
    },
    onSuccess: () => { setNewBody(""); setNewLabel(""); setAddingNew(false); invalidate(); },
    onError: (err: Error) => Alert.alert("Error creating template", err.message),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, body, label }: { id: string; body: string; label: string | null }) => {
      const res = await resilientFetch(`/api/organizations/${orgId}/quick-reference-notes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, label }),
      });
      if (!res.ok) throw new Error(await qrnErrorMessage(res, "Failed to update template"));
    },
    onSuccess: () => { setEditingId(null); invalidate(); },
    onError: (err: Error) => Alert.alert("Error saving template", err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await resilientFetch(`/api/organizations/${orgId}/quick-reference-notes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) throw new Error(await qrnErrorMessage(res, "Failed to update template"));
    },
    onSuccess: () => invalidate(),
    onError: (err: Error) => Alert.alert("Error updating template", err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await resilientFetch(`/api/organizations/${orgId}/quick-reference-notes/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await qrnErrorMessage(res, "Failed to delete template"));
    },
    onSuccess: () => invalidate(),
    onError: (err: Error) => Alert.alert("Error deleting template", err.message),
  });

  const handleReorder = async (note: QRNote, direction: "up" | "down", sorted: QRNote[]) => {
    if (!orgId) return;
    const idx = sorted.findIndex((n) => n.id === note.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    const o1 = other.displayOrder === note.displayOrder
      ? note.displayOrder + (direction === "up" ? -1 : 1)
      : other.displayOrder;
    try {
      const results = await Promise.all([
        resilientFetch(`/api/organizations/${orgId}/quick-reference-notes/${note.id}/order`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayOrder: o1 }),
        }),
        resilientFetch(`/api/organizations/${orgId}/quick-reference-notes/${other.id}/order`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayOrder: note.displayOrder }),
        }),
      ]);
      const failed = results.find((r) => !r.ok);
      if (failed) throw new Error(await qrnErrorMessage(failed, "Could not reorder templates"));
      invalidate();
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Could not reorder templates");
    }
  };

  const handleSeed = async () => {
    if (!orgId) return;
    setSeedLoading(true);
    try {
      const res = await resilientFetch(`/api/organizations/${orgId}/quick-reference-notes/seed-defaults`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await qrnErrorMessage(res, "Could not load default templates"));
      const d = (await res.json()) as { ok: boolean; data: { seeded: boolean; message?: string } };
      if (!d.data.seeded) {
        Alert.alert("Already seeded", "Your lab already has note templates.");
      } else {
        invalidate();
      }
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Could not load default templates");
    } finally {
      setSeedLoading(false);
    }
  };

  const allNotes = qrnQuery.data ?? [];
  const activeNotes = [...allNotes].filter((n) => n.isActive).sort((a, b) => a.displayOrder - b.displayOrder);
  const inactiveNotes = allNotes.filter((n) => !n.isActive);

  return (
    <ScreenShell title={labMembership ? "Lab Preferences" : "Note Templates"} onBack={() => router.back()}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 24 }]}
        keyboardDismissMode={scrollKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Default turnaround section (labs only) ── */}
        {labMembership ? (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Default case turnaround (days)</Text>
              <Text style={styles.cardSubtitle}>
                New cases will default to this many days from the created date. Leave blank for manual entry.
              </Text>
              <View style={styles.rowBtns}>
              <TextInput
                style={[styles.input, styles.inputCompact]}
                placeholder="—"
                placeholderTextColor={colors.textTertiary}
                keyboardType="number-pad"
                value={dueDays}
                onChangeText={setDueDays}
                returnKeyType="done"
                onSubmitEditing={handleSaveDueDays}
              />
              <Pressable
                style={[styles.btnPrimary, dueDaysMutation.isPending && styles.btnDisabled]}
                onPress={handleSaveDueDays}
                disabled={dueDaysMutation.isPending}
              >
                <Text style={styles.btnPrimaryText}>
                  {dueDaysMutation.isPending ? "Saving…" : dueDaysSaved ? "✓ Saved" : "Save"}
                </Text>
              </Pressable>
              {dueDays.trim() ? (
                <Pressable
                  style={styles.btnSecondary}
                  onPress={() => { setDueDays(""); dueDaysMutation.mutate(null); }}
                >
                  <Text style={styles.btnSecondaryText}>Clear</Text>
                </Pressable>
              ) : null}
              </View>
            </View>
            <View style={styles.card}>
              <View style={styles.toggleRow}>
                <View style={styles.toggleCopy}>
                  <Text style={styles.cardTitle}>Print provider preferences on lab slips</Text>
                  <Text style={styles.cardSubtitle}>Include saved provider instructions on work-order printouts.</Text>
                </View>
                <Switch
                  testID="print-provider-preferences-toggle"
                  value={labSettingsQuery.data?.printProviderPreferencesOnLabSlips === true}
                  onValueChange={(value) => printProviderPreferencesMutation.mutate(value)}
                  disabled={labSettingsQuery.isLoading || printProviderPreferencesMutation.isPending}
                  trackColor={{ false: colors.border, true: colors.tint }}
                />
              </View>
              {labSettingsQuery.isError ? (
                <Text style={styles.preferenceError}>
                  {labSettingsQuery.error instanceof Error ? labSettingsQuery.error.message : "Couldn't load this preference."}
                </Text>
              ) : null}
            </View>
          </>
        ) : null}

        {/* ── Quick Reference Notes section ── */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Quick Reference Notes</Text>
          <Text style={styles.sectionSubtitle}>
            Users can insert these templates into the Add Note field while working a case.
          </Text>
        </View>

        {qrnQuery.isError && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>
              {qrnQuery.error instanceof Error ? qrnQuery.error.message : "Couldn't load your note templates."}
            </Text>
            <Pressable style={styles.retryBtn} onPress={() => qrnQuery.refetch()}>
              <Text style={styles.retryBtnText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {!qrnQuery.isLoading && !qrnQuery.isError && allNotes.length === 0 && (
          <Pressable
            style={[styles.seedBtn, seedLoading && styles.btnDisabled]}
            onPress={handleSeed}
            disabled={seedLoading}
          >
            {seedLoading ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <Text style={styles.seedBtnText}>Load default templates</Text>
            )}
          </Pressable>
        )}

        {!addingNew ? (
          <Pressable style={styles.addBtn} onPress={() => setAddingNew(true)}>
            <Text style={styles.addBtnText}>+ New template</Text>
          </Pressable>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>New template</Text>
            <TextInput
              style={styles.input}
              placeholder="Short label (optional)"
              placeholderTextColor={colors.textTertiary}
              value={newLabel}
              onChangeText={setNewLabel}
            />
            <TextInput
              style={[styles.input, styles.inputMulti]}
              placeholder="Template body (required)"
              placeholderTextColor={colors.textTertiary}
              value={newBody}
              onChangeText={setNewBody}
              multiline
              autoCorrect={true}
              spellCheck={true}
              autoCapitalize="sentences"
              textAlignVertical="top"
            />
            <View style={styles.rowBtns}>
              <Pressable
                style={[styles.btnPrimary, (!newBody.trim() || createMutation.isPending) && styles.btnDisabled]}
                onPress={() => createMutation.mutate()}
                disabled={!newBody.trim() || createMutation.isPending}
              >
                <Text style={styles.btnPrimaryText}>Save</Text>
              </Pressable>
              <Pressable
                style={styles.btnSecondary}
                onPress={() => { setAddingNew(false); setNewBody(""); setNewLabel(""); }}
              >
                <Text style={styles.btnSecondaryText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        )}

        {qrnQuery.isLoading && (
          <ActivityIndicator style={{ marginTop: 24 }} color={colors.tint} />
        )}

        {!qrnQuery.isLoading && !qrnQuery.isError && allNotes.length === 0 && (
          <Text style={styles.emptyText}>No templates yet. Add one above or load the default set.</Text>
        )}

        {/* Active templates */}
        {activeNotes.map((note, idx) => (
          <View key={note.id} style={styles.card}>
            {editingId === note.id ? (
              <View>
                <TextInput
                  style={styles.input}
                  placeholder="Short label (optional)"
                  placeholderTextColor={colors.textTertiary}
                  value={editLabel}
                  onChangeText={setEditLabel}
                />
                <TextInput
                  style={[styles.input, styles.inputMulti]}
                  value={editBody}
                  onChangeText={setEditBody}
                  multiline
                  autoCorrect={true}
                  spellCheck={true}
                  autoCapitalize="sentences"
                  textAlignVertical="top"
                />
                <View style={styles.rowBtns}>
                  <Pressable
                    style={[styles.btnPrimary, (!editBody.trim() || updateMutation.isPending) && styles.btnDisabled]}
                    onPress={() => updateMutation.mutate({ id: note.id, body: editBody.trim(), label: editLabel.trim() || null })}
                    disabled={!editBody.trim() || updateMutation.isPending}
                  >
                    <Text style={styles.btnPrimaryText}>Save</Text>
                  </Pressable>
                  <Pressable style={styles.btnSecondary} onPress={() => setEditingId(null)}>
                    <Text style={styles.btnSecondaryText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View>
                {note.label ? <Text style={styles.noteLabel}>{note.label}</Text> : null}
                <Text style={styles.noteBody}>{note.body}</Text>
                <View style={styles.rowBtns}>
                  <Pressable
                    style={[styles.btnSecondary, idx === 0 && styles.btnDisabled]}
                    onPress={() => handleReorder(note, "up", activeNotes)}
                    disabled={idx === 0}
                  >
                    <Text style={styles.btnSecondaryText}>▲</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.btnSecondary, idx === activeNotes.length - 1 && styles.btnDisabled]}
                    onPress={() => handleReorder(note, "down", activeNotes)}
                    disabled={idx === activeNotes.length - 1}
                  >
                    <Text style={styles.btnSecondaryText}>▼</Text>
                  </Pressable>
                  <Pressable
                    style={styles.btnSecondary}
                    onPress={() => { setEditingId(note.id); setEditBody(note.body); setEditLabel(note.label ?? ""); }}
                  >
                    <Text style={styles.btnSecondaryText}>Edit</Text>
                  </Pressable>
                  <Pressable
                    style={styles.btnSecondary}
                    onPress={() => toggleMutation.mutate({ id: note.id, isActive: false })}
                  >
                    <Text style={styles.btnSecondaryText}>Hide</Text>
                  </Pressable>
                  <Pressable
                    style={styles.btnDanger}
                    onPress={() =>
                      Alert.alert("Delete template?", "This template will be removed.", [
                        { text: "Cancel", style: "cancel" },
                        { text: "Delete", style: "destructive", onPress: () => deleteMutation.mutate(note.id) },
                      ])
                    }
                  >
                    <Text style={styles.btnDangerText}>✕</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </View>
        ))}

        {/* Inactive templates */}
        {inactiveNotes.length > 0 && (
          <View>
            <Text style={styles.inactiveHeading}>Hidden templates ({inactiveNotes.length})</Text>
            {inactiveNotes.map((note) => (
              <View key={note.id} style={[styles.card, styles.inactiveCard]}>
                {note.label ? <Text style={styles.noteLabel}>{note.label}</Text> : null}
                <Text style={[styles.noteBody, styles.inactiveBody]}>{note.body}</Text>
                <View style={styles.rowBtns}>
                  <Pressable
                    style={styles.btnSecondary}
                    onPress={() => toggleMutation.mutate({ id: note.id, isActive: true })}
                  >
                    <Text style={styles.btnSecondaryText}>Restore</Text>
                  </Pressable>
                  <Pressable
                    style={styles.btnDanger}
                    onPress={() =>
                      Alert.alert("Delete template?", "This template will be permanently removed.", [
                        { text: "Cancel", style: "cancel" },
                        { text: "Delete", style: "destructive", onPress: () => deleteMutation.mutate(note.id) },
                      ])
                    }
                  >
                    <Text style={styles.btnDangerText}>✕</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </ScreenShell>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    scroll: { flex: 1, backgroundColor: colors.backgroundSolid },
    container: { padding: Spacing.md, gap: Spacing.sm },
    sectionHeader: { marginTop: Spacing.sm, marginBottom: Spacing.xs },
    sectionTitle: {
      ...Typography.h3,
      color: colors.text,
      marginBottom: 4,
    },
    sectionSubtitle: {
      ...Typography.caption,
      color: colors.textSecondary,
    },
    seedBtn: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.md,
      paddingVertical: 10,
      paddingHorizontal: 16,
      alignItems: "center",
    },
    seedBtnText: { ...Typography.body, color: colors.textSecondary },
    addBtn: {
      borderWidth: 1,
      borderColor: colors.tint,
      borderRadius: Radius.md,
      paddingVertical: 10,
      paddingHorizontal: 16,
      alignItems: "center",
    },
    addBtnText: { ...Typography.body, color: colors.tint, fontWeight: "600" },
    card: {
      backgroundColor: colors.surface,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: Spacing.md,
      gap: Spacing.sm,
    },
    inactiveCard: { opacity: 0.6 },
    cardTitle: { ...Typography.bodySemibold, color: colors.text },
    cardSubtitle: { ...Typography.caption, color: colors.textSecondary },
    toggleRow: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    toggleCopy: { flex: 1, gap: 2 },
    preferenceError: { ...Typography.caption, color: colors.errorText },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.sm,
      paddingHorizontal: 12,
      paddingVertical: 8,
      ...Typography.body,
      color: colors.text,
      backgroundColor: colors.backgroundSolid,
    },
    inputCompact: { width: 80 },
    inputMulti: { minHeight: 70 },
    rowBtns: { flexDirection: "row", gap: Spacing.xs, flexWrap: "wrap", alignItems: "center" },
    btnPrimary: {
      backgroundColor: colors.tint,
      borderRadius: Radius.sm,
      paddingVertical: 8,
      paddingHorizontal: 16,
    },
    btnPrimaryText: { ...Typography.bodySemibold, color: colors.textInverse },
    btnSecondary: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: Radius.sm,
      paddingVertical: 7,
      paddingHorizontal: 14,
    },
    btnSecondaryText: { ...Typography.body, color: colors.textSecondary },
    btnDanger: {
      borderWidth: 1,
      borderColor: "#ef4444",
      borderRadius: Radius.sm,
      paddingVertical: 7,
      paddingHorizontal: 12,
    },
    btnDangerText: { ...Typography.body, color: "#ef4444" },
    btnDisabled: { opacity: 0.4 },
    noteLabel: { ...Typography.captionSemibold, color: colors.tint, marginBottom: 2 },
    noteBody: { ...Typography.body, color: colors.text },
    inactiveBody: { color: colors.textSecondary },
    emptyText: { ...Typography.body, color: colors.textSecondary, textAlign: "center", paddingVertical: 24 },
    inactiveHeading: { ...Typography.bodySemibold, color: colors.textSecondary, marginTop: Spacing.sm, marginBottom: Spacing.xs },
    errorCard: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.sm,
      backgroundColor: colors.errorSurface,
      borderWidth: 1,
      borderColor: colors.errorLight,
      borderRadius: Radius.md,
      padding: Spacing.md,
    },
    errorText: { ...Typography.body, color: colors.errorText, flex: 1 },
    retryBtn: {
      borderWidth: 1,
      borderColor: colors.error,
      borderRadius: Radius.sm,
      paddingVertical: 6,
      paddingHorizontal: 14,
    },
    retryBtnText: { ...Typography.captionSemibold, color: colors.error },
  });
}
