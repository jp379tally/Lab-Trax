// Provider portal → Message My Lab → Chat.
//
// The live conversation with one lab, mirroring the desktop
// ProviderMessengerChat: resolve (or create) the provider↔lab thread, poll it,
// advance the read watermark as newer messages are seen, and send text with an
// optional image.
//
// Every request here goes through lib/messenger.ts — the same client the
// lab-side thread screen uses — so mobile keeps one messenger data path rather
// than growing a second one for the portal.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Radius, Spacing, Typography } from "@/constants/tokens";
import { AuthedImage } from "@/components/ui/AuthedImage";
import { scrollKeyboardDismissMode } from "@/components/ui/DismissKeyboardView";
import { useAuth } from "@/lib/auth-context";
import {
  getOrCreateProviderThread,
  messagesQueryKey,
  messengerMediaUrl,
  sendMessengerMessage,
  threadQueryKey,
  useMarkThreadRead,
  useMessengerMessages,
  type MessengerMessage,
} from "@/lib/messenger";

interface PendingAttachment {
  uri: string;
  name: string;
  mimeType: string;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export interface ProviderLabChatProps {
  labOrganizationId: string;
  labName?: string;
}

export function ProviderLabChat({ labOrganizationId, labName }: ProviderLabChatProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { currentUserId } = useAuth();
  const queryClient = useQueryClient();
  const scrollRef = useRef<ScrollView>(null);

  const threadQuery = useQuery({
    queryKey: threadQueryKey(labOrganizationId),
    queryFn: () => getOrCreateProviderThread(labOrganizationId),
    staleTime: 60_000,
  });
  const threadId = threadQuery.data?.id;

  const messagesQuery = useMessengerMessages(threadId);
  const markRead = useMarkThreadRead(threadId);

  const [draftText, setDraftText] = useState("");
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Messages arrive newest-first; reverse for a top-to-bottom timeline.
  const messages: MessengerMessage[] = useMemo(
    () => [...(messagesQuery.data ?? [])].reverse(),
    [messagesQuery.data],
  );

  useEffect(() => {
    const latest = messages[messages.length - 1];
    markRead(latest?.id ?? null);
  }, [messages, markRead]);

  async function pickImage() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setSendError("Allow access to your photo library to attach an image.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
    });
    if (result.canceled || !result.assets[0]) return;
    const resized = await ImageManipulator.manipulateAsync(
      result.assets[0].uri,
      [{ resize: { width: 1600 } }],
      { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
    );
    setSendError(null);
    setAttachment({ uri: resized.uri, name: "attachment.jpg", mimeType: "image/jpeg" });
  }

  async function handleSend() {
    if (!threadId) return;
    const text = draftText.trim();
    if (!text && !attachment) return;

    setIsSending(true);
    try {
      await sendMessengerMessage({
        threadId,
        text,
        imageUri: attachment?.uri ?? null,
        imageName: attachment?.name ?? null,
        imageMimeType: attachment?.mimeType ?? null,
      });
      setDraftText("");
      setAttachment(null);
      setSendError(null);
      // The message is already committed server-side; refreshing the thread is
      // what puts it on screen without the provider reloading anything.
      await queryClient.invalidateQueries({ queryKey: messagesQueryKey(threadId) });
    } catch (err: unknown) {
      setSendError(err instanceof Error && err.message ? err.message : "Message not sent. Please try again.");
    } finally {
      setIsSending(false);
    }
  }

  const canSend = (!!draftText.trim() || !!attachment) && !isSending && !!threadId;

  if (threadQuery.isLoading) {
    return (
      <View style={styles.centered} testID="provider-chat-connecting">
        <ActivityIndicator color={colors.tint} />
      </View>
    );
  }

  if (threadQuery.isError || !threadId) {
    return (
      <View style={styles.centered} testID="provider-chat-error">
        <Text style={styles.errorTitle}>Could not connect to {labName ?? "the lab"}.</Text>
        <Text style={styles.errorBody}>You may not be linked to this lab yet.</Text>
      </View>
    );
  }

  return (
    <View style={styles.root} testID="provider-messages-chat">
      <View style={styles.header}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {labName ?? "Lab"}
        </Text>
        <Text style={styles.headerSubtitle}>Direct message</Text>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={scrollKeyboardDismissMode}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {messagesQuery.isLoading && (
          <View style={styles.centered} testID="provider-chat-loading">
            <ActivityIndicator color={colors.tint} />
          </View>
        )}

        {!messagesQuery.isLoading && messages.length === 0 && (
          <View style={styles.emptyContainer} testID="provider-chat-empty">
            <Ionicons name="chatbubble-ellipses-outline" size={36} color={colors.textTertiary} />
            <Text style={styles.emptyText}>No messages yet</Text>
            <Text style={styles.emptySubtext}>Send a message to start the conversation.</Text>
          </View>
        )}

        {messages.map((msg) => {
          const isMine = msg.senderUserId === currentUserId;
          const isImage = !!msg.mediaKey && (msg.mimeType ?? "").startsWith("image/");
          const isOtherMedia = !!msg.mediaKey && !isImage;
          return (
            <View
              key={msg.id}
              style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}
              testID={`provider-chat-message-${msg.id}`}
            >
              <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
                {isImage && (
                  <AuthedImage
                    url={messengerMediaUrl(threadId, msg.id)}
                    style={styles.bubbleImage}
                    contentFit="cover"
                  />
                )}
                {isOtherMedia && (
                  <View style={styles.attachmentRow}>
                    <Ionicons
                      name="document-attach-outline"
                      size={16}
                      color={isMine ? colors.textInverse : colors.textSecondary}
                    />
                    <Text style={[styles.attachmentText, isMine && { color: colors.textInverse }]}>
                      Attachment
                    </Text>
                  </View>
                )}
                {!!msg.body && (
                  <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>{msg.body}</Text>
                )}
                <Text style={[styles.bubbleTime, isMine && styles.bubbleTimeMine]}>
                  {formatTimestamp(msg.createdAt)}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.composer}>
        {attachment && (
          <View style={styles.attachmentPreviewRow}>
            <AuthedImage url={attachment.uri} style={styles.attachmentPreview} contentFit="cover" />
            <Pressable
              style={styles.removeAttachmentBtn}
              onPress={() => setAttachment(null)}
              accessibilityRole="button"
              accessibilityLabel="Remove attachment"
              testID="provider-chat-remove-attachment"
            >
              <Ionicons name="close-circle" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>
        )}
        {!!sendError && (
          <Text style={styles.sendError} testID="provider-chat-send-error">
            {sendError}
          </Text>
        )}
        <View style={styles.composerRow}>
          <Pressable
            style={styles.attachBtn}
            onPress={pickImage}
            accessibilityRole="button"
            accessibilityLabel="Attach an image"
            testID="provider-chat-attach"
          >
            <Ionicons name="image-outline" size={22} color={colors.tint} />
          </Pressable>
          <TextInput
            value={draftText}
            onChangeText={setDraftText}
            placeholder={`Message ${labName ?? "the lab"}…`}
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            multiline
            autoCorrect={true}
            spellCheck={true}
            autoCapitalize="sentences"
            testID="provider-chat-input"
          />
          <Pressable
            style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            testID="provider-chat-send"
          >
            {isSending ? (
              <ActivityIndicator size="small" color={colors.textInverse} />
            ) : (
              <Ionicons name="send" size={16} color={colors.textInverse} />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      backgroundColor: c.surface,
    },
    headerTitle: { ...Typography.bodySemibold, color: c.text },
    headerSubtitle: { ...Typography.caption, color: c.textSecondary },
    list: { flex: 1 },
    listContent: { padding: Spacing.lg, gap: Spacing.sm, flexGrow: 1 },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      padding: Spacing.xxl,
    },
    errorTitle: { ...Typography.bodyMedium, color: c.text, textAlign: "center" },
    errorBody: { ...Typography.caption, color: c.textSecondary, textAlign: "center" },
    emptyContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      paddingTop: Spacing.huge,
    },
    emptyText: { ...Typography.bodyMedium, color: c.text, marginTop: Spacing.sm },
    emptySubtext: { ...Typography.caption, color: c.textSecondary },
    bubbleRow: { flexDirection: "row" },
    bubbleRowMine: { justifyContent: "flex-end" },
    bubbleRowTheirs: { justifyContent: "flex-start" },
    bubble: { maxWidth: "78%", borderRadius: Radius.lg, padding: Spacing.md, gap: Spacing.xs },
    bubbleMine: { backgroundColor: c.tint, borderBottomRightRadius: Radius.xs },
    bubbleTheirs: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderBottomLeftRadius: Radius.xs,
    },
    bubbleImage: { width: 200, height: 160, borderRadius: Radius.sm },
    attachmentRow: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    attachmentText: { ...Typography.caption, color: c.textSecondary },
    bubbleText: { ...Typography.body, color: c.text },
    bubbleTextMine: { color: c.textInverse },
    bubbleTime: { ...Typography.tiny, color: c.textTertiary },
    bubbleTimeMine: { color: c.textInverse, opacity: 0.8 },
    composer: {
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      gap: Spacing.sm,
    },
    composerRow: { flexDirection: "row", alignItems: "flex-end", gap: Spacing.sm },
    attachBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    input: {
      flex: 1,
      maxHeight: 100,
      backgroundColor: c.backgroundSolid,
      borderRadius: Radius.lg,
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      ...Typography.body,
      color: c.text,
    },
    sendBtn: {
      width: 36,
      height: 36,
      borderRadius: Radius.full,
      backgroundColor: c.tint,
      alignItems: "center",
      justifyContent: "center",
    },
    sendBtnDisabled: { opacity: 0.4 },
    sendError: { ...Typography.caption, color: c.error },
    attachmentPreviewRow: { flexDirection: "row", alignItems: "flex-start" },
    attachmentPreview: { width: 64, height: 64, borderRadius: Radius.sm },
    removeAttachmentBtn: { marginLeft: -10, marginTop: -6 },
  });
}
