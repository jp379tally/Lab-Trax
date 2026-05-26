import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { useTheme } from "@/lib/theme-context";
import { useAuth } from "@/lib/auth-context";
import { useMessenger, MMessage } from "@/lib/messenger-context";

const AVATAR_COLORS = [
  "#145DA0",
  "#0F766E",
  "#7C3AED",
  "#059669",
  "#DC2626",
  "#D97706",
  "#EC4899",
  "#8B5CF6",
  "#06B6D4",
  "#F97316",
];

function getAvatarColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const color = getAvatarColor(name);
  const initial = (name || "?").charAt(0).toUpperCase();
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: size * 0.44 }]}>
        {initial}
      </Text>
    </View>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / 86400000
  );
  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } else if (diffDays === 1) {
    return (
      "Yesterday " +
      date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    );
  } else if (diffDays < 7) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return (
      days[date.getDay()] +
      " " +
      date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    );
  }
  return (
    date.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " +
    date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  );
}

function shouldShowTimestamp(current: MMessage, prev: MMessage | null): boolean {
  if (!prev) return true;
  return (
    new Date(current.createdAt).getTime() -
      new Date(prev.createdAt).getTime() >
    3600000
  );
}

export default function MessengerChatScreen() {
  const { id: convId } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { currentUserId } = useAuth();
  const {
    conversations,
    loadMessages,
    sendMessage,
    markRead,
    onNewMessage,
    setActiveConversationId,
  } = useMessenger();

  const [messages, setMessages] = useState<MMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);

  const conv = conversations.find((c) => c.id === convId);
  const otherUser = conv?.otherUser;
  const title = otherUser?.displayName ?? otherUser?.username ?? "Conversation";

  useEffect(() => {
    if (convId) setActiveConversationId(convId);
    return () => setActiveConversationId(null);
  }, [convId, setActiveConversationId]);

  const fetchMessages = useCallback(async () => {
    if (!convId) return;
    setLoading(true);
    const msgs = await loadMessages(convId);
    setMessages(msgs);
    setHasMore(msgs.length === 40);
    setLoading(false);
    await markRead(convId);
  }, [convId, loadMessages, markRead]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  useEffect(() => {
    const unsub = onNewMessage((payload) => {
      if (payload.conversationId !== convId) return;
      const newMsg: MMessage = {
        id: payload.id,
        conversationId: payload.conversationId,
        senderId: payload.senderId,
        body: payload.body,
        createdAt: payload.createdAt,
        sender: {
          id: payload.senderId,
          username: payload.senderName,
          firstName: null,
          lastName: null,
          initials: payload.senderName.charAt(0).toUpperCase(),
          displayName: payload.senderName,
        },
      };
      setMessages((prev) => {
        if (prev.find((m) => m.id === payload.id)) return prev;
        return [...prev, newMsg];
      });
      if (convId) markRead(convId).catch(() => {});
    });
    return unsub;
  }, [convId, onNewMessage, markRead]);

  async function loadMore() {
    if (loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    const oldest = messages[0];
    const older = await loadMessages(convId!, oldest.id);
    setMessages((prev) => {
      const ids = new Set(prev.map((m) => m.id));
      return [...older.filter((m) => !ids.has(m.id)), ...prev];
    });
    setHasMore(older.length === 40);
    setLoadingMore(false);
  }

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || sending || !convId) return;
    setInput("");
    setSending(true);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    const msg = await sendMessage(convId, trimmed);
    if (msg) {
      setMessages((prev) => {
        if (prev.find((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    }
    setSending(false);
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }

  const renderItem = ({
    item,
    index,
  }: {
    item: MMessage;
    index: number;
  }) => {
    const isMine = item.senderId === currentUserId;
    const prev = index > 0 ? messages[index - 1] : null;
    const showTs = shouldShowTimestamp(item, prev);
    const showAvatar =
      !isMine && (index === 0 || messages[index - 1]?.senderId !== item.senderId);

    return (
      <View>
        {showTs && (
          <View style={styles.timestampRow}>
            <Text
              style={[styles.timestampText, { color: colors.textTertiary }]}
            >
              {formatTime(item.createdAt)}
            </Text>
          </View>
        )}
        <View
          style={[
            styles.messageRow,
            isMine ? styles.messageRowMine : styles.messageRowOther,
          ]}
        >
          {!isMine && (
            <View style={{ width: 32, marginRight: 8 }}>
              {showAvatar && (
                <Avatar name={item.sender.displayName} size={32} />
              )}
            </View>
          )}
          <View
            style={[
              styles.bubble,
              isMine
                ? [styles.bubbleMine, { backgroundColor: colors.tint }]
                : [
                    styles.bubbleOther,
                    {
                      backgroundColor: isDark
                        ? colors.surface
                        : "#E9EEF5",
                    },
                  ],
            ]}
          >
            <Text
              style={[
                styles.bubbleText,
                { color: isMine ? "#fff" : colors.text },
              ]}
            >
              {item.body}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  return (
    <View
      style={[styles.container, { backgroundColor: colors.backgroundSolid }]}
    >
      <View
        style={[
          styles.header,
          {
            paddingTop:
              Platform.OS === "web" ? 20 : insets.top + 8,
            backgroundColor: colors.surface,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [
            styles.backBtn,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Ionicons name="chevron-back" size={26} color={colors.tint} />
        </Pressable>
        <View style={styles.headerCenter}>
          {otherUser && <Avatar name={title} size={36} />}
          <Text
            style={[styles.headerTitle, { color: colors.text }]}
            numberOfLines={1}
          >
            {title}
          </Text>
        </View>
        <View style={{ width: 44 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
      >
        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.tint} />
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            contentContainerStyle={[
              styles.listContent,
              { paddingBottom: 8 },
            ]}
            onContentSizeChange={() => {
              if (!loadingMore) {
                flatListRef.current?.scrollToEnd({ animated: false });
              }
            }}
            onLayout={() => {
              if (!loadingMore) {
                flatListRef.current?.scrollToEnd({ animated: false });
              }
            }}
            ListHeaderComponent={
              loadingMore ? (
                <ActivityIndicator
                  style={{ marginVertical: 12 }}
                  color={colors.tint}
                />
              ) : hasMore ? (
                <Pressable
                  onPress={loadMore}
                  style={({ pressed }) => [
                    styles.loadMoreBtn,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text
                    style={{
                      color: colors.tint,
                      fontFamily: "Inter_500Medium",
                      fontSize: 13,
                    }}
                  >
                    Load older messages
                  </Text>
                </Pressable>
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Ionicons
                  name="chatbubble-outline"
                  size={36}
                  color={colors.textTertiary}
                />
                <Text
                  style={[styles.emptyText, { color: colors.textSecondary }]}
                >
                  No messages yet. Say hello!
                </Text>
              </View>
            }
          />
        )}

        <View
          style={[
            styles.inputBar,
            {
              backgroundColor: colors.surface,
              borderTopColor: colors.border,
              paddingBottom:
                Platform.OS === "ios"
                  ? insets.bottom + 4
                  : 12,
            },
          ]}
        >
          <TextInput
            ref={inputRef}
            style={[
              styles.textInput,
              {
                color: colors.text,
                backgroundColor: isDark
                  ? "rgba(255,255,255,0.08)"
                  : "rgba(0,0,0,0.06)",
              },
            ]}
            placeholder="Message..."
            placeholderTextColor={colors.textSecondary}
            value={input}
            onChangeText={setInput}
            multiline
            maxLength={4000}
            onSubmitEditing={Platform.OS === "web" ? handleSend : undefined}
          />
          <Pressable
            onPress={handleSend}
            disabled={!input.trim() || sending}
            style={({ pressed }) => [
              styles.sendBtn,
              {
                backgroundColor:
                  input.trim() && !sending ? colors.tint : colors.border,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            {sending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Ionicons name="arrow-up" size={18} color="#fff" />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  backBtn: {
    padding: 8,
  },
  headerCenter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  avatar: {
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
  },
  loadingWrap: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  listContent: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexGrow: 1,
    justifyContent: "flex-end",
  },
  timestampRow: {
    alignItems: "center",
    marginVertical: 8,
  },
  timestampText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  messageRow: {
    flexDirection: "row",
    marginVertical: 2,
    alignItems: "flex-end",
  },
  messageRowMine: {
    justifyContent: "flex-end",
  },
  messageRowOther: {
    justifyContent: "flex-start",
  },
  bubble: {
    maxWidth: "75%",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 18,
  },
  bubbleMine: {
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 8,
    borderTopWidth: 1,
  },
  textInput: {
    flex: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    maxHeight: 120,
    lineHeight: 20,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 48,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  loadMoreBtn: {
    alignItems: "center",
    padding: 12,
  },
});
