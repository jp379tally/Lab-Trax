import React, { useEffect, useMemo, useState } from "react";
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
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAiMemory,
  useCreateAiMemory,
  useUpdateAiMemory,
  useDeleteAiMemory,
  getGetAiMemoryQueryKey,
  type AiMemoryItem,
  type AiMemoryItemKind,
} from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { Card } from "@/components/ui/Card";
import { FormSheet } from "@/components/ui/FormSheet";
import { TextField } from "@/components/ui/TextField";
import { useMe, primaryLabOrgId, adminLabMemberships } from "@/lib/auth-me";

const AI_MEMORY_KINDS = ["glossary", "preference", "fact"] as const;

const KIND_META: Record<
  AiMemoryItemKind,
  { label: string; description: string; keyLabel: string; valueLabel: string }
> = {
  glossary: {
    label: "Glossary",
    description:
      "Lab-specific terms or abbreviations the AI should understand (e.g. “PFZ” → “Porcelain fused to zirconia”).",
    keyLabel: "Term",
    valueLabel: "Definition",
  },
  preference: {
    label: "Preferences",
    description:
      "How this lab likes things done — tone, defaults, or conventions the AI should follow.",
    keyLabel: "Name",
    valueLabel: "Preference",
  },
  fact: {
    label: "Facts",
    description: "Durable facts about this lab the AI should always know.",
    keyLabel: "Name",
    valueLabel: "Fact",
  },
};

function friendlyError(e: unknown, fallback: string): string {
  const status =
    e && typeof e === "object" && "status" in e ? (e as { status?: number }).status : undefined;
  if (status === 409) return "An entry with that name already exists.";
  if (status === 403 || status === 401) {
    return "Your current role can’t make this change. Lab owners and admins manage this.";
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

export default function AiKnowledgeScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const me = useMe().data;
  // Reads are available to any active lab member (matching the GET /ai-memory
  // membership check), so scope to the user's primary lab. Writes/deletes are
  // admin-only on the server, so only owners/admins of THAT lab get edit UI.
  const labOrgId = primaryLabOrgId(me);
  const canManage = useMemo(
    () => adminLabMemberships(me).some((m) => m.organizationId === labOrgId),
    [me, labOrgId],
  );

  const memQ = useGetAiMemory(
    { labOrganizationId: labOrgId ?? "" },
    {
      query: {
        queryKey: getGetAiMemoryQueryKey({ labOrganizationId: labOrgId ?? "" }),
        enabled: !!labOrgId,
        staleTime: 30_000,
      },
    },
  );

  const items = memQ.data?.data ?? [];
  const itemsByKind = useMemo(() => {
    const map: Record<AiMemoryItemKind, AiMemoryItem[]> = {
      glossary: [],
      preference: [],
      fact: [],
    };
    for (const item of items) {
      if (map[item.kind]) map[item.kind].push(item);
    }
    return map;
  }, [items]);

  // Editor target: either a new entry for a kind, or an existing item to edit.
  const [editor, setEditor] = useState<
    { mode: "new"; kind: AiMemoryItemKind } | { mode: "edit"; item: AiMemoryItem } | null
  >(null);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8} testID="ai-knowledge-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>AI Assistant</Text>
      </View>

      {!labOrgId ? (
        <View style={styles.center}>
          <Ionicons name="sparkles-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>No lab available</Text>
          <Text style={styles.emptyBody}>
            AI Assistant knowledge is managed per lab. Join a lab to view its glossary, preferences, and facts.
          </Text>
        </View>
      ) : memQ.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={memQ.isFetching} onRefresh={() => memQ.refetch()} tintColor={colors.tint} />
          }
        >
          <Text style={styles.intro}>
            Teach the LabTrax AI about your lab. Glossary terms, preferences, and facts you add here are included in
            the AI’s context so its answers match how your lab works.
          </Text>

          {memQ.isError ? <Text style={styles.loadError}>Couldn’t load knowledge. Pull to refresh.</Text> : null}

          {AI_MEMORY_KINDS.map((kind) => {
            const meta = KIND_META[kind];
            const kindItems = itemsByKind[kind];
            return (
              <View key={kind} style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>{meta.label}</Text>
                  <View style={styles.sectionHeaderRight}>
                    <Text style={styles.sectionCount}>{kindItems.length}</Text>
                    {canManage ? (
                      <Pressable
                        style={styles.addBtn}
                        onPress={() => setEditor({ mode: "new", kind })}
                        hitSlop={8}
                        testID={`add-${kind}`}
                      >
                        <Ionicons name="add" size={20} color={colors.tint} />
                      </Pressable>
                    ) : null}
                  </View>
                </View>
                <Text style={styles.sectionDesc}>{meta.description}</Text>
                {kindItems.length === 0 ? (
                  <Text style={styles.sectionEmpty}>No {meta.label.toLowerCase()} yet.</Text>
                ) : (
                  <View style={styles.list}>
                    {kindItems.map((item) => (
                      <Card
                        key={item.id}
                        style={styles.row}
                        onPress={canManage ? () => setEditor({ mode: "edit", item }) : undefined}
                        testID={`entry-${item.id}`}
                      >
                        <View style={styles.main}>
                          <Text style={styles.name} numberOfLines={1}>
                            {item.key}
                          </Text>
                          <Text style={styles.value}>{item.value}</Text>
                        </View>
                        {canManage ? <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} /> : null}
                      </Card>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      {editor && labOrgId ? (
        <EntryEditor
          labOrgId={labOrgId}
          kind={editor.mode === "new" ? editor.kind : editor.item.kind}
          item={editor.mode === "edit" ? editor.item : null}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </View>
  );
}

function EntryEditor({
  labOrgId,
  kind,
  item,
  onClose,
}: {
  labOrgId: string;
  kind: AiMemoryItemKind;
  item: AiMemoryItem | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { colors } = useTheme();
  const meta = KIND_META[kind];
  const [key, setKey] = useState(item?.key ?? "");
  const [value, setValue] = useState(item?.value ?? "");

  // Re-seed when a different item is opened so a reopened sheet reflects the
  // current server values rather than a stale snapshot.
  useEffect(() => {
    setKey(item?.key ?? "");
    setValue(item?.value ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getGetAiMemoryQueryKey({ labOrganizationId: labOrgId }) });

  const create = useCreateAiMemory();
  const update = useUpdateAiMemory();
  const remove = useDeleteAiMemory();
  const submitting = create.isPending || update.isPending || remove.isPending;

  async function save() {
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();
    if (!trimmedKey || !trimmedValue) return;
    try {
      if (item) {
        await update.mutateAsync({ id: item.id, data: { key: trimmedKey, value: trimmedValue } });
      } else {
        await create.mutateAsync({
          data: { labOrganizationId: labOrgId, kind, key: trimmedKey, value: trimmedValue },
        });
      }
      await invalidate();
      onClose();
    } catch (e) {
      Alert.alert("Couldn’t save", friendlyError(e, "Please try again."));
    }
  }

  function confirmDelete() {
    if (!item) return;
    Alert.alert("Delete entry", `Remove “${item.key}”?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await remove.mutateAsync({ id: item.id });
            await invalidate();
            onClose();
          } catch (e) {
            Alert.alert("Couldn’t delete", friendlyError(e, "Please try again."));
          }
        },
      },
    ]);
  }

  return (
    <FormSheet
      visible
      title={item ? `Edit ${meta.label.toLowerCase()} entry` : `New ${meta.label.toLowerCase()} entry`}
      onClose={onClose}
      onSubmit={() => void save()}
      submitting={submitting}
      submitDisabled={key.trim().length === 0 || value.trim().length === 0}
      onDelete={item ? confirmDelete : undefined}
    >
      <Text style={{ ...Typography.caption, color: colors.textSecondary }}>{meta.description}</Text>
      <TextField
        label={meta.keyLabel}
        required
        value={key}
        onChangeText={setKey}
        maxLength={200}
        placeholder={meta.keyLabel}
        autoFocus={!item}
      />
      <TextField
        label={meta.valueLabel}
        required
        value={value}
        onChangeText={setValue}
        maxLength={2000}
        multiline
        placeholder={meta.valueLabel}
      />
    </FormSheet>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
      gap: Spacing.xs,
    },
    backBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    title: { ...Typography.h1, color: c.text },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.xl,
      gap: Spacing.sm,
      minHeight: 280,
    },
    emptyTitle: { ...Typography.h3, color: c.text, textAlign: "center" },
    emptyBody: { ...Typography.body, color: c.textSecondary, textAlign: "center" },
    content: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.xl },
    intro: { ...Typography.body, color: c.textSecondary },
    loadError: { ...Typography.caption, color: c.error },
    section: { gap: Spacing.xs },
    sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    sectionHeaderRight: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    sectionTitle: { ...Typography.h2, color: c.text },
    sectionCount: { ...Typography.captionSemibold, color: c.textTertiary },
    addBtn: {
      width: 32,
      height: 32,
      borderRadius: Radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.tint + "1A",
    },
    sectionDesc: { ...Typography.caption, color: c.textSecondary, marginBottom: Spacing.xs },
    sectionEmpty: { ...Typography.caption, color: c.textTertiary },
    list: { gap: Spacing.sm },
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    main: { flex: 1, gap: 2 },
    name: { ...Typography.bodySemibold, color: c.text },
    value: { ...Typography.caption, color: c.textSecondary },
  });
}
