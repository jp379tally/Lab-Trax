// One-on-one provider↔lab conversation. Polls GET .../messages every 5s
// (mirroring the desktop ProviderMessengerChat poll cadence), sends text +
// optional single image via sendMessengerMessage, and advances the read
// watermark whenever a newer message is seen.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { AuthedImage } from "@/components/ui/AuthedImage";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
} from "@/components/ui/DismissKeyboardView";
import { useAuth } from "@/lib/auth-context";
import {
  useMessengerMessages,
  useMarkThreadRead,
  sendMessengerMessage,
  messengerMediaUrl,
  messagesQueryKey,
  type MessengerMessage,
} from "@/lib/messenger";

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

interface PendingAttachment {
  uri: string;
  name: string;
  mimeType: string;
}

export default function MessageThreadScreen() {
  const { threadId, name } = useLocalSearchParams<{ threadId: string; name?: string }>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { currentUserId } = useAuth();
  const queryClient = useQueryClient();
  const scrollRef = useRef<ScrollView>(null);

  const messagesQuery = useMessengerMessages(threadId);
  const markRead = useMarkThreadRead(threadId);

  const [draftText, setDraftText] = useState("");
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const [isSending, setIsSending] = useState(false);

  // Messages arrive newest-first; reverse for a top-to-bottom timeline.
  const messages: MessengerMessage[] = useMemo(
    () => [...(messagesQuery.data ?? [])].reverse(),
    [messagesQuery.data],
  );

  useEffect(() => {
    const latest = messages[messages.length - 1];
    markRead(latest?.id ?? null);
  }, [messages, markRead]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  async function pickImage() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission required", "Allow access to your photo library to attach an image.");
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
      queryClient.invalidateQueries({ queryKey: messagesQueryKey(threadId) });
    } catch (err: any) {
      Alert.alert("Message not sent", err?.message ?? "Please try again.");
    } finally {
      setIsSending(false);
    }
  }

  const canSend = (!!draftText.trim() || !!attachment) && !isSending;

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <DismissKeyboardView style={styles.header} testID="thread-keyboard-dismiss">
        <Pressable style={styles.backBtn} onPress={() => router.back()} testID="thread-back">
          <Ionicons name="chevron-back" size={20} color={colors.tint} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{name || "Conversation"}</Text>
        <View style={styles.backBtn} />
      </DismissKeyboardView>

      <ScrollView
        ref={scrollRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={scrollKeyboardDismissMode}
        testID="thread-messages"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {messagesQuery.isLoading && (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.tint} />
          </View>
        )}

        {!messagesQuery.isLoading && messages.length === 0 && (
          <View style={styles.emptyContainer}>
            <Ionicons name="chatbubble-ellipses-outline" size={40} color={colors.textTertiary} />
            <Text style={styles.emptyText}>No messages yet</Text>
            <Text style={styles.emptySubtext}>Send a message to start the conversation.</Text>
          </View>
        )}

        {messages.map((msg) => {
          const isMine = msg.senderUserId === currentUserId;
          const isImage = !!msg.mediaKey && (msg.mimeType ?? "").startsWith("image/");
          const isOtherMedia = !!msg.mediaKey && !isImage;
          return (
            <View key={msg.id} style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
              <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
                {isImage && threadId && (
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

      {/* The composer's own padding and attachment strip dismiss too, so the
          keyboard can be closed without leaving the area being typed in. */}
      <DismissKeyboardView
        style={[styles.composer, { paddingBottom: insets.bottom + Spacing.sm }]}
        testID="thread-composer-keyboard-dismiss"
      >
        {attachment && (
          <View style={styles.attachmentPreviewRow}>
            <AuthedImage url={attachment.uri} style={styles.attachmentPreview} contentFit="cover" />
            <Pressable
              style={styles.removeAttachmentBtn}
              onPress={() => setAttachment(null)}
              testID="remove-attachment"
            >
              <Ionicons name="close-circle" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>
        )}
        <View style={styles.composerRow}>
          <Pressable style={styles.attachBtn} onPress={pickImage} testID="attach-image">
            <Ionicons name="image-outline" size={22} color={colors.tint} />
          </Pressable>
          <TextInput
            value={draftText}
            onChangeText={setDraftText}
            autoCorrect={true}
            spellCheck={true}
            autoCapitalize="sentences"
            placeholder="Type a message…"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            multiline
            testID="message-input"
          />
          <Pressable
            style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!canSend}
            testID="send-message"
          >
            {isSending ? (
              <ActivityIndicator size="small" color={colors.textInverse} />
            ) : (
              <Ionicons name="send" size={16} color={colors.textInverse} />
            )}
          </Pressable>
        </View>
      </DismissKeyboardView>
    </KeyboardAvoidingView>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.backgroundSolid },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.sm,
      paddingBottom: Spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      backgroundColor: c.surface,
    },
    backBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    title: { ...Typography.h3, color: c.text, flex: 1, textAlign: "center" },
    list: { flex: 1 },
    listContent: { padding: Spacing.lg, gap: Spacing.sm, flexGrow: 1 },
    centered: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: Spacing.huge },
    emptyContainer: { flex: 1, alignItems: "center", justifyContent: "center", gap: Spacing.xs, paddingTop: Spacing.huge },
    emptyText: { ...Typography.bodyMedium, color: c.text, marginTop: Spacing.sm },
    emptySubtext: { ...Typography.caption, color: c.textSecondary },
    bubbleRow: { flexDirection: "row" },
    bubbleRowMine: { justifyContent: "flex-end" },
    bubbleRowTheirs: { justifyContent: "flex-start" },
    bubble: { maxWidth: "78%", borderRadius: Radius.lg, padding: Spacing.md, gap: Spacing.xs },
    bubbleMine: { backgroundColor: c.tint, borderBottomRightRadius: Radius.xs },
    bubbleTheirs: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderBottomLeftRadius: Radius.xs },
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
      paddingTop: Spacing.sm,
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
    attachmentPreviewRow: { flexDirection: "row", alignItems: "flex-start" },
    attachmentPreview: { width: 64, height: 64, borderRadius: Radius.sm },
    removeAttachmentBtn: { marginLeft: -10, marginTop: -6 },
  });
}
