import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Alert,
  ActivityIndicator,
  StyleSheet,
  Modal,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { getJson, sendJson, isForbiddenError } from "@/lib/read-api";
import { useMe, canOwnAnyLab, primaryLabOrgId } from "@/lib/auth-me";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";

interface SelfPermission {
  id: string;
  name: string;
  description?: string | null;
  capabilityKey: string;
}

interface SelfPermissionsResponse {
  membershipId: string;
  permissions: SelfPermission[];
}

function SelfPermissionsScreen({
  insets,
  colors,
  styles,
  labOrgId,
}: {
  insets: ReturnType<typeof import("react-native-safe-area-context").useSafeAreaInsets>;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  labOrgId: string | null;
}) {
  const selfQuery = useQuery<SelfPermissionsResponse>({
    queryKey: ["self-permissions", labOrgId],
    queryFn: () =>
      getJson<SelfPermissionsResponse>(`/organizations/${labOrgId}/members/self/permissions`),
    enabled: !!labOrgId,
    staleTime: 60_000,
  });

  const permissions = selfQuery.data?.permissions ?? [];

  return (
    <DismissKeyboardView
      style={[styles.container, { paddingTop: insets.top }]}
      testID="self-permissions-keyboard-dismiss"
    >
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.tint} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>My Permissions</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        keyboardDismissMode={scrollKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={[
            styles.section,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: colors.text }]}>My permissions</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
            Custom capabilities your lab owner has granted to your account.
          </Text>

          {selfQuery.isLoading && (
            <ActivityIndicator size="small" color={colors.tint} style={{ marginTop: 12 }} />
          )}
          {selfQuery.isError && (
            <Text style={[styles.errorText, { color: colors.error }]}>
              Could not load your permissions.
            </Text>
          )}
          {selfQuery.isSuccess && permissions.length === 0 && (
            <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
              No custom permissions have been granted to your account yet.
            </Text>
          )}
          {permissions.map((perm) => (
            <View
              key={perm.id}
              style={[styles.defRow, { borderTopColor: colors.border }]}
            >
              <Ionicons
                name="shield-checkmark-outline"
                size={16}
                color={colors.tint}
                style={{ marginTop: 1, marginRight: 8 }}
              />
              <View style={{ flex: 1 }}>
                <Text style={[styles.defName, { color: colors.text }]}>{perm.name}</Text>
                {!!perm.description && (
                  <Text style={[styles.defDesc, { color: colors.textTertiary }]}>
                    {perm.description}
                  </Text>
                )}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </DismissKeyboardView>
  );
}

const CAPABILITY_LABELS: Record<string, string> = {
  delete_cases: "Delete Cases",
  manage_pricing: "Manage Pricing",
  view_financial_reports: "View Financial Reports",
  export_data: "Export Data",
  manage_team_members: "Manage Team Members",
  configure_integrations: "Configure Integrations",
  approve_invoices: "Approve Invoices",
};

const CAPABILITY_KEYS = Object.keys(CAPABILITY_LABELS);

interface PermissionDef {
  id: string;
  labId: string;
  name: string;
  description?: string | null;
  capabilityKey: string;
  createdAt: string;
  updatedAt: string;
}

interface LabTeamMember {
  id: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  role?: string | null;
  membershipId?: string | null;
  isOwner?: boolean;
  isSelf: boolean;
  status: string;
}

interface MemberPermissions {
  membershipId: string;
  permissionDefinitionIds: string[];
}

export default function PermissionOutlineScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const qc = useQueryClient();
  const meQuery = useMe();
  const canOwn = canOwnAnyLab(meQuery.data);
  const labOrgId = primaryLabOrgId(meQuery.data);

  const [showCreateDef, setShowCreateDef] = useState(false);
  const [editingDef, setEditingDef] = useState<PermissionDef | null>(null);
  const [defName, setDefName] = useState("");
  const [defDesc, setDefDesc] = useState("");
  const [defCapKey, setDefCapKey] = useState(CAPABILITY_KEYS[0]);

  const [memberPermsTarget, setMemberPermsTarget] = useState<LabTeamMember | null>(null);
  const [selectedDefIds, setSelectedDefIds] = useState<string[]>([]);

  const defsQuery = useQuery<PermissionDef[]>({
    queryKey: ["permission-definitions", labOrgId],
    queryFn: () => getJson<PermissionDef[]>(`/organizations/${labOrgId}/permission-definitions`),
    enabled: !!labOrgId && canOwn,
    staleTime: 30_000,
  });

  const teamQuery = useQuery<{ team: LabTeamMember[]; callerRole: string | null }>({
    queryKey: ["lab-team"],
    queryFn: () => getJson<{ team: LabTeamMember[]; callerRole: string | null }>("/auth/lab-team"),
    enabled: !!labOrgId && canOwn,
    staleTime: 30_000,
  });

  const createDefMutation = useMutation({
    mutationFn: (input: { name: string; description?: string; capabilityKey: string }) =>
      sendJson("POST", `/organizations/${labOrgId}/permission-definitions`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["permission-definitions", labOrgId] });
      closeDefForm();
    },
    onError: (e: Error) => Alert.alert("Error", e.message),
  });

  const updateDefMutation = useMutation({
    mutationFn: ({ id, ...input }: { id: string; name: string; description?: string; capabilityKey: string }) =>
      sendJson("PATCH", `/organizations/${labOrgId}/permission-definitions/${id}`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["permission-definitions", labOrgId] });
      closeDefForm();
    },
    onError: (e: Error) => Alert.alert("Error", e.message),
  });

  const deleteDefMutation = useMutation({
    mutationFn: (id: string) => sendJson("DELETE", `/organizations/${labOrgId}/permission-definitions/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["permission-definitions", labOrgId] }),
    onError: (e: Error) => Alert.alert("Error", e.message),
  });

  const memberPermsQuery = useQuery<MemberPermissions>({
    queryKey: ["member-permissions", labOrgId, memberPermsTarget?.membershipId],
    queryFn: () =>
      getJson<MemberPermissions>(`/organizations/${labOrgId}/members/${memberPermsTarget!.membershipId}/permissions`),
    enabled: !!labOrgId && !!memberPermsTarget?.membershipId,
    staleTime: 0,
  });

  const setMemberPermsMutation = useMutation({
    mutationFn: ({ membershipId, ids }: { membershipId: string; ids: string[] }) =>
      sendJson("PUT", `/organizations/${labOrgId}/members/${membershipId}/permissions`, { permissionDefinitionIds: ids }),
    onSuccess: (_, { membershipId }) => {
      void qc.invalidateQueries({ queryKey: ["member-permissions", labOrgId, membershipId] });
      setMemberPermsTarget(null);
    },
    onError: (e: Error) => Alert.alert("Error", e.message),
  });

  const revokePermMutation = useMutation({
    mutationFn: ({ membershipId, defId }: { membershipId: string; defId: string }) =>
      sendJson("DELETE", `/organizations/${labOrgId}/members/${membershipId}/permissions/${defId}`),
    onSuccess: (_, { membershipId, defId }) => {
      void qc.invalidateQueries({ queryKey: ["member-permissions", labOrgId, membershipId] });
      setSelectedDefIds((prev) => prev.filter((id) => id !== defId));
    },
    onError: (e: Error) => Alert.alert("Error", e.message),
  });

  function openCreateDef() {
    setEditingDef(null);
    setDefName("");
    setDefDesc("");
    setDefCapKey(CAPABILITY_KEYS[0]);
    setShowCreateDef(true);
  }

  function openEditDef(def: PermissionDef) {
    setEditingDef(def);
    setDefName(def.name);
    setDefDesc(def.description ?? "");
    setDefCapKey(def.capabilityKey);
    setShowCreateDef(true);
  }

  function closeDefForm() {
    setShowCreateDef(false);
    setEditingDef(null);
    setDefName("");
    setDefDesc("");
    setDefCapKey(CAPABILITY_KEYS[0]);
  }

  function saveDefForm() {
    if (!defName.trim()) { Alert.alert("Name is required"); return; }
    const input = { name: defName.trim(), description: defDesc.trim() || undefined, capabilityKey: defCapKey };
    if (editingDef) {
      updateDefMutation.mutate({ id: editingDef.id, ...input });
    } else {
      createDefMutation.mutate(input);
    }
  }

  function openMemberPerms(member: LabTeamMember) {
    setMemberPermsTarget(member);
  }

  function closeMemberPerms() {
    setMemberPermsTarget(null);
    setSelectedDefIds([]);
  }

  function saveMemberPerms() {
    if (!memberPermsTarget?.membershipId) return;
    setMemberPermsMutation.mutate({ membershipId: memberPermsTarget.membershipId, ids: selectedDefIds });
  }

  const defs = defsQuery.data ?? [];
  const members = (teamQuery.data?.team ?? []).filter((m) => !m.isOwner && !!m.membershipId);

  if (!canOwn) {
    return <SelfPermissionsScreen insets={insets} colors={colors} styles={styles} labOrgId={labOrgId} />;
  }

  return (
    <DismissKeyboardView
      style={[styles.container, { paddingTop: insets.top }]}
      testID="permission-outline-keyboard-dismiss"
    >
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.tint} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Permission Outline</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        keyboardDismissMode={scrollKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
      >

        {/* Permission Definitions */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Permission Definitions</Text>
            <Pressable onPress={openCreateDef} style={[styles.addBtn, { backgroundColor: colors.tint }]}>
              <Ionicons name="add" size={16} color="#fff" />
              <Text style={styles.addBtnText}>New</Text>
            </Pressable>
          </View>
          <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
            Define custom permissions for your lab. Owners and admins always have full access.
          </Text>

          {defsQuery.isLoading && <ActivityIndicator size="small" color={colors.tint} style={{ marginTop: 12 }} />}
          {defsQuery.isError && (
            <Text style={[styles.errorText, { color: colors.error }]}>Could not load definitions.</Text>
          )}
          {defs.length === 0 && !defsQuery.isLoading && (
            <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
              No permission definitions yet. Create one to get started.
            </Text>
          )}
          {defs.map((def) => (
            <View key={def.id} style={[styles.defRow, { borderTopColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.defName, { color: colors.text }]}>{def.name}</Text>
                <Text style={[styles.defCap, { color: colors.textSecondary }]}>
                  {CAPABILITY_LABELS[def.capabilityKey] ?? def.capabilityKey}
                </Text>
                {!!def.description && (
                  <Text style={[styles.defDesc, { color: colors.textTertiary }]}>{def.description}</Text>
                )}
              </View>
              <View style={styles.defActions}>
                <Pressable onPress={() => openEditDef(def)} hitSlop={8} style={styles.iconBtn}>
                  <Ionicons name="pencil-outline" size={16} color={colors.textSecondary} />
                </Pressable>
                <Pressable
                  onPress={() =>
                    Alert.alert("Delete permission", `Delete "${def.name}" and remove all grants?`, [
                      { text: "Cancel", style: "cancel" },
                      { text: "Delete", style: "destructive", onPress: () => deleteDefMutation.mutate(def.id) },
                    ])
                  }
                  hitSlop={8}
                  style={styles.iconBtn}
                >
                  <Ionicons name="trash-outline" size={16} color={colors.error} />
                </Pressable>
              </View>
            </View>
          ))}
        </View>

        {/* Member Permissions */}
        {defs.length > 0 && (
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Member Permissions</Text>
            <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
              Tap a member to see and revoke the capabilities they hold.
            </Text>

            {teamQuery.isLoading && <ActivityIndicator size="small" color={colors.tint} style={{ marginTop: 12 }} />}
            {members.length === 0 && !teamQuery.isLoading && (
              <Text style={[styles.emptyText, { color: colors.textTertiary }]}>No team members found.</Text>
            )}
            {members.map((member) => {
              const name = [member.firstName, member.lastName].filter(Boolean).join(" ") || member.username;
              return (
                <MemberPermissionRow
                  key={member.id}
                  member={member}
                  name={name}
                  labOrgId={labOrgId ?? ""}
                  defs={defs}
                  colors={colors}
                  styles={styles}
                  onPress={() => openMemberPerms(member)}
                />
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Create / Edit Definition Modal */}
      <Modal visible={showCreateDef} animationType="slide" presentationStyle="pageSheet" onRequestClose={closeDefForm}>
        <DismissKeyboardView
          style={[styles.modalContainer, { backgroundColor: colors.background, paddingTop: insets.top + 12 }]}
          testID="permission-definition-keyboard-dismiss"
        >
          <View style={styles.modalHeader}>
            <Pressable onPress={closeDefForm} hitSlop={12}>
              <Text style={[styles.modalCancel, { color: colors.tint }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {editingDef ? "Edit Permission" : "New Permission"}
            </Text>
            <Pressable
              onPress={saveDefForm}
              disabled={createDefMutation.isPending || updateDefMutation.isPending}
              hitSlop={12}
            >
              <Text style={[styles.modalSave, { color: colors.tint, opacity: createDefMutation.isPending || updateDefMutation.isPending ? 0.5 : 1 }]}>
                Save
              </Text>
            </Pressable>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 20, gap: 16 }}
            keyboardDismissMode={scrollKeyboardDismissMode}
            keyboardShouldPersistTaps="handled"
          >
            <View>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Name *</Text>
              <TextInput
                value={defName}
                onChangeText={setDefName}
                placeholder="e.g. Finance Viewer"
                placeholderTextColor={colors.textTertiary}
                style={[styles.textInput, { color: colors.text, backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
                autoFocus
              />
            </View>
            <View>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Description</Text>
              <TextInput
                value={defDesc}
                onChangeText={setDefDesc}
                placeholder="Optional description"
                placeholderTextColor={colors.textTertiary}
                style={[styles.textInput, { color: colors.text, backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
                multiline
                numberOfLines={2}
                autoCorrect={true}
                spellCheck={true}
                autoCapitalize="sentences"
              />
            </View>
            <View>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Capability</Text>
              {CAPABILITY_KEYS.map((key) => (
                <Pressable
                  key={key}
                  onPress={() => setDefCapKey(key)}
                  style={[
                    styles.capRow,
                    { borderColor: colors.border, backgroundColor: defCapKey === key ? colors.tint + "18" : colors.surfaceAlt },
                  ]}
                >
                  <Ionicons
                    name={defCapKey === key ? "radio-button-on" : "radio-button-off"}
                    size={18}
                    color={defCapKey === key ? colors.tint : colors.textTertiary}
                  />
                  <Text style={[styles.capLabel, { color: defCapKey === key ? colors.tint : colors.text }]}>
                    {CAPABILITY_LABELS[key]}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </DismissKeyboardView>
      </Modal>

      {/* Member Permissions Modal */}
      <Modal
        visible={!!memberPermsTarget}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeMemberPerms}
        onShow={() => {
          setSelectedDefIds(memberPermsQuery.data?.permissionDefinitionIds ?? []);
        }}
      >
        <DismissKeyboardView
          style={[styles.modalContainer, { backgroundColor: colors.background, paddingTop: insets.top + 12 }]}
          testID="member-permissions-keyboard-dismiss"
        >
          <View style={styles.modalHeader}>
            <Pressable onPress={closeMemberPerms} hitSlop={12}>
              <Text style={[styles.modalCancel, { color: colors.tint }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { color: colors.text }]} numberOfLines={1}>
              {memberPermsTarget
                ? ([memberPermsTarget.firstName, memberPermsTarget.lastName].filter(Boolean).join(" ") || memberPermsTarget.username)
                : ""}
            </Text>
            <Pressable
              onPress={saveMemberPerms}
              disabled={setMemberPermsMutation.isPending}
              hitSlop={12}
            >
              <Text style={[styles.modalSave, { color: colors.tint, opacity: setMemberPermsMutation.isPending ? 0.5 : 1 }]}>
                Save
              </Text>
            </Pressable>
          </View>

          {memberPermsQuery.isLoading ? (
            <ActivityIndicator size="large" color={colors.tint} style={{ marginTop: 32 }} />
          ) : (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ padding: 20, gap: 4 }}
              keyboardDismissMode={scrollKeyboardDismissMode}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={[styles.sectionSubtitle, { color: colors.textSecondary, marginBottom: 12 }]}>
                Granted permissions are shown with a Revoke button. Toggle to grant new ones, then tap Save.
              </Text>
              {defs.map((def) => {
                const granted = selectedDefIds.includes(def.id);
                const isRevoking =
                  revokePermMutation.isPending &&
                  (revokePermMutation.variables as { defId: string } | undefined)?.defId === def.id;
                return (
                  <View
                    key={def.id}
                    style={[
                      styles.capRow,
                      {
                        borderColor: colors.border,
                        backgroundColor: granted ? colors.tint + "18" : colors.surfaceAlt,
                        marginBottom: 8,
                        alignItems: "center",
                      },
                    ]}
                  >
                    <Pressable
                      onPress={() =>
                        setSelectedDefIds((prev) =>
                          granted ? prev.filter((id) => id !== def.id) : [...prev, def.id]
                        )
                      }
                      style={{ flex: 1, flexDirection: "row", alignItems: "center" }}
                    >
                      <Ionicons
                        name={granted ? "checkbox" : "square-outline"}
                        size={20}
                        color={granted ? colors.tint : colors.textTertiary}
                      />
                      <View style={{ flex: 1, marginLeft: 8 }}>
                        <Text style={[styles.defName, { color: colors.text }]}>{def.name}</Text>
                        <Text style={[styles.defCap, { color: colors.textSecondary }]}>
                          {CAPABILITY_LABELS[def.capabilityKey] ?? def.capabilityKey}
                        </Text>
                      </View>
                    </Pressable>
                    {granted && memberPermsTarget?.membershipId && (
                      <Pressable
                        onPress={() => {
                          Alert.alert(
                            "Revoke permission",
                            `Remove "${def.name}" from this member immediately?`,
                            [
                              { text: "Cancel", style: "cancel" },
                              {
                                text: "Revoke",
                                style: "destructive",
                                onPress: () =>
                                  revokePermMutation.mutate({
                                    membershipId: memberPermsTarget.membershipId!,
                                    defId: def.id,
                                  }),
                              },
                            ]
                          );
                        }}
                        disabled={isRevoking}
                        hitSlop={8}
                        style={[styles.revokeBtn, { borderColor: colors.error, opacity: isRevoking ? 0.5 : 1 }]}
                      >
                        <Text style={[styles.revokeBtnText, { color: colors.error }]}>
                          {isRevoking ? "…" : "Revoke"}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </ScrollView>
          )}
        </DismissKeyboardView>
      </Modal>
    </DismissKeyboardView>
  );
}

/**
 * A single team-member row in the Member Permissions list.
 * Fetches and displays the member's granted permission count as a badge.
 */
function MemberPermissionRow({
  member,
  name,
  labOrgId,
  defs,
  colors,
  styles,
  onPress,
}: {
  member: LabTeamMember;
  name: string;
  labOrgId: string;
  defs: PermissionDef[];
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}) {
  const grantsQuery = useQuery<MemberPermissions>({
    queryKey: ["member-permissions", labOrgId, member.membershipId],
    queryFn: () =>
      getJson<MemberPermissions>(
        `/organizations/${labOrgId}/members/${member.membershipId}/permissions`
      ),
    enabled: !!labOrgId && !!member.membershipId,
    staleTime: 60_000,
  });

  const grantedCount = grantsQuery.data?.permissionDefinitionIds.length ?? 0;

  return (
    <Pressable
      onPress={onPress}
      style={[styles.memberRow, { borderTopColor: colors.border }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.memberName, { color: colors.text }]}>{name}</Text>
        <Text style={[styles.memberRole, { color: colors.textSecondary }]}>
          {(member.role ?? "user").replace("_", "-")}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {grantsQuery.isLoading ? (
          <ActivityIndicator size="small" color={colors.textTertiary} />
        ) : grantedCount > 0 ? (
          <View style={[styles.grantBadge, { backgroundColor: colors.tint }]}>
            <Text style={styles.grantBadgeText}>{grantedCount}</Text>
          </View>
        ) : (
          <Text style={[styles.noGrantsLabel, { color: colors.textTertiary }]}>None</Text>
        )}
        <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
      </View>
    </Pressable>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      gap: Spacing.sm,
    },
    backBtn: { padding: 4 },
    title: { ...Typography.h3, color: colors.text },
    scroll: { flex: 1 },
    section: {
      marginHorizontal: Spacing.md,
      marginTop: Spacing.md,
      borderRadius: Radius.md,
      borderWidth: 1,
      padding: Spacing.md,
    },
    sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
    sectionTitle: { ...Typography.bodySemibold, color: colors.text },
    sectionSubtitle: { ...Typography.caption, color: colors.textSecondary, marginBottom: 8 },
    addBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: Radius.sm,
    },
    addBtnText: { color: "#fff", ...Typography.caption, fontWeight: "600" },
    defRow: { flexDirection: "row", alignItems: "flex-start", paddingTop: 10, marginTop: 10, borderTopWidth: 1 },
    defName: { ...Typography.caption, color: colors.text, fontWeight: "600" },
    defCap: { ...Typography.label, color: colors.textSecondary, marginTop: 1 },
    defDesc: { ...Typography.label, color: colors.textTertiary, marginTop: 2 },
    defActions: { flexDirection: "row", gap: 4 },
    iconBtn: { padding: 6 },
    memberRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingTop: 10,
      marginTop: 10,
      borderTopWidth: 1,
    },
    memberName: { ...Typography.caption, color: colors.text, fontWeight: "600" },
    memberRole: { ...Typography.label, color: colors.textSecondary, marginTop: 1 },
    grantBadge: {
      minWidth: 20,
      height: 20,
      borderRadius: 10,
      paddingHorizontal: 5,
      alignItems: "center",
      justifyContent: "center",
    },
    grantBadgeText: {
      color: "#fff",
      fontSize: 11,
      fontWeight: "700",
    },
    noGrantsLabel: {
      ...Typography.label,
      color: colors.textTertiary,
    },
    errorText: { ...Typography.caption, color: colors.error, marginTop: 8 },
    emptyText: { ...Typography.caption, color: colors.textTertiary, fontStyle: "italic", marginTop: 4 },
    modalContainer: { flex: 1 },
    modalHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    modalTitle: { ...Typography.bodySemibold, color: colors.text, flex: 1, textAlign: "center" },
    modalCancel: { ...Typography.body, color: colors.tint, minWidth: 60 },
    modalSave: { ...Typography.bodySemibold, color: colors.tint, minWidth: 60, textAlign: "right" },
    fieldLabel: { ...Typography.label, color: colors.textSecondary, marginBottom: 6, fontWeight: "600" },
    textInput: {
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: 12,
      paddingVertical: 10,
      ...Typography.body,
    },
    capRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderWidth: 1,
      borderRadius: Radius.sm,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 6,
    },
    capLabel: { ...Typography.body, flex: 1 },
    revokeBtn: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: Radius.sm,
      borderWidth: 1,
      marginLeft: 6,
    },
    revokeBtnText: {
      ...Typography.label,
      fontWeight: "600",
    },
  });
}
