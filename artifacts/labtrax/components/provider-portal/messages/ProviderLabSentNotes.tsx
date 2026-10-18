// Provider portal → Message My Lab → Sent.
//
// The one-way drop box: a note and/or file goes to the lab's inbox, and the
// list underneath is the provider's own submission history for that lab.
// Mirrors the desktop ProviderSentNotes (same copy, same states, same
// endpoints via lib/provider-lab-inbox.ts).
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { openAttachment } from "@/lib/open-attachment";
import {
  PROVIDER_INBOX_ACCEPTED_MIME_TYPES,
  PROVIDER_INBOX_UNSUPPORTED_FILE_MESSAGE,
  isAcceptedProviderInboxMimeType,
  useProviderSentItems,
  useSendProviderInboxItem,
  type ProviderInboxAttachment,
  type ProviderSentItem,
} from "@/lib/provider-lab-inbox";

function formatSentAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export interface ProviderLabSentNotesProps {
  labOrganizationId: string;
  labName?: string;
}

export function ProviderLabSentNotes({
  labOrganizationId,
  labName,
}: ProviderLabSentNotesProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const sentQuery = useProviderSentItems(labOrganizationId);
  const sendMutation = useSendProviderInboxItem(labOrganizationId);

  const [note, setNote] = useState("");
  const [file, setFile] = useState<ProviderInboxAttachment | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [openingEntryId, setOpeningEntryId] = useState<string | null>(null);

  const entries = sentQuery.data ?? [];
  const canSend = (note.trim().length > 0 || file !== null) && !sendMutation.isPending;

  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({
      type: [...PROVIDER_INBOX_ACCEPTED_MIME_TYPES],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return;
    const asset = result.assets?.[0];
    if (!asset) return;
    // The picker's `type` filter is advisory on some platforms, so the choice
    // is re-checked here against the same allowlist the server enforces.
    if (!isAcceptedProviderInboxMimeType(asset.mimeType)) {
      setFile(null);
      setSendError(PROVIDER_INBOX_UNSUPPORTED_FILE_MESSAGE);
      return;
    }
    setFile({
      uri: asset.uri,
      name: asset.name ?? "attachment",
      mimeType: asset.mimeType as string,
    });
    setSendError(null);
  }

  /**
   * Re-open a file this provider already sent. The bytes come back through
   * the same protected media path the lab uses (GET /lab-inbox/:id/file),
   * which now also answers the provider who submitted the row.
   */
  async function handleOpen(entry: ProviderSentItem) {
    if (!entry.originalFilename || openingEntryId) return;
    setOpeningEntryId(entry.id);
    try {
      const result = await openAttachment({
        url: `/api/lab-inbox/${entry.id}/file`,
        fileName: entry.originalFilename,
        fileType: entry.mimeType,
      });
      if (result === "unavailable") {
        Alert.alert("Can't open file", "Opening files isn't supported on this device.");
      } else if (result === "error") {
        Alert.alert(
          "Couldn't open file",
          "This file could not be downloaded or opened. Please try again.",
        );
      }
    } catch {
      Alert.alert("Couldn't open file", "Please try again.");
    } finally {
      setOpeningEntryId(null);
    }
  }

  async function handleSubmit() {
    if (!canSend) return;
    try {
      await sendMutation.mutateAsync({ note: note.trim(), file });
      setNote("");
      setFile(null);
      setSendError(null);
    } catch (err: unknown) {
      setSendError(
        err instanceof Error && err.message ? err.message : "Failed to send. Please try again.",
      );
    }
  }

  return (
    <View style={styles.root} testID="provider-messages-sent">
      {/* Compose */}
      <View style={styles.compose}>
        <Text style={styles.composeTitle}>
          Send a note or file to {labName ?? "the lab"}
        </Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="Type a note for the lab…"
          placeholderTextColor={colors.textTertiary}
          style={styles.input}
          multiline
          autoCorrect={true}
          spellCheck={true}
          autoCapitalize="sentences"
          editable={!sendMutation.isPending}
          testID="provider-sent-note-input"
        />
        {file && (
          <View style={styles.attachmentRow} testID="provider-sent-attachment">
            <Ionicons name="attach-outline" size={14} color={colors.textSecondary} />
            <Text style={styles.attachmentName} numberOfLines={1}>
              {file.name}
            </Text>
            <Pressable
              onPress={() => setFile(null)}
              accessibilityRole="button"
              accessibilityLabel="Remove attachment"
              testID="provider-sent-remove-attachment"
            >
              <Ionicons name="close" size={14} color={colors.textSecondary} />
            </Pressable>
          </View>
        )}
        {!!sendError && (
          <Text style={styles.errorText} testID="provider-sent-send-error">
            {sendError}
          </Text>
        )}
        <View style={styles.composeActions}>
          <Pressable
            onPress={pickFile}
            disabled={sendMutation.isPending}
            style={[styles.attachBtn, sendMutation.isPending && styles.disabled]}
            accessibilityRole="button"
            testID="provider-sent-attach"
          >
            <Ionicons name="attach-outline" size={15} color={colors.textSecondary} />
            <Text style={styles.attachLabel}>Attach file</Text>
          </Pressable>
          <Pressable
            onPress={handleSubmit}
            disabled={!canSend}
            style={[styles.sendBtn, !canSend && styles.disabled]}
            accessibilityRole="button"
            testID="provider-sent-send"
          >
            {sendMutation.isPending ? (
              <ActivityIndicator size="small" color={colors.textInverse} />
            ) : (
              <Ionicons name="send" size={13} color={colors.textInverse} />
            )}
            <Text style={styles.sendLabel}>Send</Text>
          </Pressable>
        </View>
      </View>

      {/* Sent history */}
      <Text style={styles.sectionLabel}>SENT</Text>
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={scrollKeyboardDismissMode}
      >
        {sentQuery.isLoading && (
          <View style={styles.centered} testID="provider-sent-loading">
            <ActivityIndicator color={colors.tint} />
          </View>
        )}

        {sentQuery.isError && (
          <Text style={styles.errorText} testID="provider-sent-error">
            Could not load your sent history. Please try again.
          </Text>
        )}

        {!sentQuery.isLoading && !sentQuery.isError && entries.length === 0 && (
          <Text style={styles.emptyText} testID="provider-sent-empty">
            You haven’t sent any notes yet.
          </Text>
        )}

        {entries.map((entry) => (
          <View key={entry.id} style={styles.entry} testID={`provider-sent-item-${entry.id}`}>
            <Text style={styles.entryTime}>{formatSentAt(entry.createdAt)}</Text>
            {!!entry.note && (
              <Text style={styles.entryNote} numberOfLines={3}>
                {entry.note}
              </Text>
            )}
            {!!entry.originalFilename && (
              <Pressable
                style={styles.entryFileRow}
                onPress={() => void handleOpen(entry)}
                disabled={openingEntryId === entry.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${entry.originalFilename}`}
                hitSlop={6}
                testID={`provider-sent-open-${entry.id}`}
              >
                {openingEntryId === entry.id ? (
                  <ActivityIndicator size={12} color={colors.tint} />
                ) : (
                  <Ionicons name="document-text-outline" size={12} color={colors.tint} />
                )}
                <Text style={styles.entryFile} numberOfLines={1}>
                  {entry.originalFilename}
                </Text>
              </Pressable>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.backgroundSolid },
    compose: {
      gap: Spacing.sm,
      padding: Spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      backgroundColor: c.surface,
    },
    composeTitle: { ...Typography.bodySemibold, color: c.text },
    input: {
      minHeight: 64,
      maxHeight: 140,
      backgroundColor: c.backgroundSolid,
      borderRadius: Radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      ...Typography.body,
      color: c.text,
    },
    attachmentRow: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    attachmentName: { ...Typography.caption, color: c.textSecondary, flexShrink: 1 },
    composeActions: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    attachBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.xs,
      borderRadius: Radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    attachLabel: { ...Typography.caption, color: c.textSecondary },
    sendBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.xs + 2,
      borderRadius: Radius.sm,
      backgroundColor: c.tint,
    },
    sendLabel: { ...Typography.captionSemibold, color: c.textInverse },
    disabled: { opacity: 0.4 },
    sectionLabel: {
      ...Typography.label,
      color: c.textSecondary,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.md,
      paddingBottom: Spacing.xs,
    },
    list: { flex: 1 },
    listContent: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.lg },
    centered: { alignItems: "center", paddingVertical: Spacing.xl },
    errorText: { ...Typography.caption, color: c.error, paddingVertical: Spacing.xs },
    emptyText: { ...Typography.caption, color: c.textSecondary, paddingVertical: Spacing.xs },
    entry: {
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      gap: 2,
    },
    entryTime: { ...Typography.tiny, color: c.textSecondary },
    entryNote: { ...Typography.caption, color: c.text },
    entryFileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingVertical: 2,
    },
    // Tinted so the file reads as something you can open, unlike the plain
    // note text above it. Note-only entries never render this row.
    entryFile: { ...Typography.caption, color: c.tint, flexShrink: 1 },
  });
}
