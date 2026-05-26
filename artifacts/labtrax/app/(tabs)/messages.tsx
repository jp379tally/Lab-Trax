import React, { useState, useCallback, useRef } from "react";
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  ActivityIndicator,
  Platform,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import * as Haptics from "expo-haptics";
import { useTheme } from "@/lib/theme-context";
import { useAuth } from "@/lib/auth-context";
import { useMessenger, MConversation, MUser } from "@/lib/messenger-context";

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

function formatRelativeTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function Avatar({ name, size = 48 }: { name: string; size?: number }) {
  const color = getAvatarColor(name);
  const initial = (name || "?").charAt(0).toUpperCase();
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: size * 0.42 }]}>
        {initial}
      </Text>
    </View>
  );
}

function ConversationRow({
  item,
  currentUserId,
  colors,
  isDark,
  onPress,
}: {
  item: MConversation;
  currentUserId: string | null;
  colors: ReturnType<typeof import("@/lib/theme-context").useTheme>["colors"];
  isDark: boolean;
  onPress: () => void;
}) {
  const hasUnread = item.unreadCount > 0;
  const otherUser = item.otherUser;
  const displayName = otherUser?.displayName ?? otherUser?.username ?? "Unknown";
  const preview = item.lastMessage?.body ?? "No messages yet";
  const timeStr = formatRelativeTime(
    item.lastMessage?.createdAt ?? item.updatedAt
  );
  const isMine = item.lastMessage?.senderId === currentUserId;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.convRow,
        {
          backgroundColor: pressed
            ? isDark
              ? "rgba(255,255,255,0.06)"
              : "rgba(0,0,0,0.04)"
            : "transparent",
        },
      ]}
    >
      <Avatar name={displayName} size={50} />
      <View style={styles.convInfo}>
        <View style={styles.convTopRow}>
          <Text
            style={[
              styles.convName,
              {
                color: colors.text,
                fontFamily: hasUnread ? "Inter_600SemiBold" : "Inter_500Medium",
              },
            ]}
            numberOfLines={1}
          >
            {displayName}
          </Text>
          <Text
            style={[
              styles.convTime,
              {
                color: hasUnread ? colors.tint : colors.textTertiary,
                fontFamily: hasUnread ? "Inter_600SemiBold" : "Inter_400Regular",
              },
            ]}
          >
            {timeStr}
          </Text>
        </View>
        <View style={styles.convBottomRow}>
          <Text
            style={[
              styles.convPreview,
              {
                color: hasUnread ? colors.text : colors.textSecondary,
                fontFamily: hasUnread ? "Inter_500Medium" : "Inter_400Regular",
                flex: 1,
              },
            ]}
            numberOfLines={1}
          >
            {isMine ? `You: ${preview}` : preview}
          </Text>
          {hasUnread && (
            <View style={[styles.badge, { backgroundColor: colors.tint }]}>
              <Text style={styles.badgeText}>
                {item.unreadCount > 99 ? "99+" : item.unreadCount}
              </Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function UserSearchRow({
  user,
  colors,
  isDark,
  onPress,
}: {
  user: MUser;
  colors: ReturnType<typeof import("@/lib/theme-context").useTheme>["colors"];
  isDark: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.userRow,
        {
          backgroundColor: pressed
            ? isDark
              ? "rgba(255,255,255,0.06)"
              : "rgba(0,0,0,0.04)"
            : "transparent",
        },
      ]}
    >
      <Avatar name={user.displayName} size={42} />
      <View style={{ flex: 1 }}>
        <Text
          style={[
            styles.convName,
            { color: colors.text, fontFamily: "Inter_500Medium" },
          ]}
          numberOfLines={1}
        >
          {user.displayName}
        </Text>
        {user.username !== user.displayName && (
          <Text
            style={[styles.convPreview, { color: colors.textSecondary }]}
            numberOfLines={1}
          >
            @{user.username}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

export default function MessagesTab() {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { currentUserId } = useAuth();
  const {
    conversations,
    loadingConversations,
    loadConversations,
    searchUsers,
    findOrCreateConversation,
    setActiveConversationId,
  } = useMessenger();

  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [searchResults, setSearchResults] = useState<MUser[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [startingConv, setStartingConv] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadConversations();
      setActiveConversationId(null);
    }, [loadConversations, setActiveConversationId])
  );

  function handleSearchChange(text: string) {
    setSearchQuery(text);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!text.trim()) {
      setSearchResults([]);
      return;
    }
    searchDebounce.current = setTimeout(async () => {
      setSearchLoading(true);
      const results = await searchUsers(text.trim());
      setSearchResults(results);
      setSearchLoading(false);
    }, 300);
  }

  async function handleOpenConversation(convId: string) {
    setActiveConversationId(convId);
    router.push(`/messenger/${convId}` as any);
  }

  async function handleStartConversation(user: MUser) {
    if (startingConv) return;
    setStartingConv(true);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    const convId = await findOrCreateConversation(user.id);
    setStartingConv(false);
    if (convId) {
      setSearchMode(false);
      setSearchQuery("");
      setSearchResults([]);
      await loadConversations();
      handleOpenConversation(convId);
    }
  }

  const sortedConversations = [...conversations].sort((a, b) => {
    const ta = a.lastMessage?.createdAt
      ? new Date(a.lastMessage.createdAt).getTime()
      : a.updatedAt
      ? new Date(a.updatedAt).getTime()
      : 0;
    const tb = b.lastMessage?.createdAt
      ? new Date(b.lastMessage.createdAt).getTime()
      : b.updatedAt
      ? new Date(b.updatedAt).getTime()
      : 0;
    return tb - ta;
  });

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
        <View style={styles.headerTop}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            Messages
          </Text>
          <Pressable
            onPress={() => {
              setSearchMode(true);
              setSearchQuery("");
              setSearchResults([]);
            }}
            style={({ pressed }) => [
              styles.newMsgBtn,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Ionicons name="create-outline" size={24} color={colors.tint} />
          </Pressable>
        </View>

        {searchMode ? (
          <View
            style={[
              styles.searchBar,
              {
                backgroundColor: isDark
                  ? "rgba(255,255,255,0.08)"
                  : "rgba(0,0,0,0.06)",
              },
            ]}
          >
            <Ionicons name="search" size={16} color={colors.textSecondary} />
            <TextInput
              style={[styles.searchInput, { color: colors.text }]}
              placeholder="Search users to message..."
              placeholderTextColor={colors.textSecondary}
              value={searchQuery}
              onChangeText={handleSearchChange}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              onPress={() => {
                setSearchMode(false);
                setSearchQuery("");
                setSearchResults([]);
              }}
            >
              <Text
                style={{
                  color: colors.tint,
                  fontFamily: "Inter_500Medium",
                  fontSize: 14,
                }}
              >
                Cancel
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {searchMode ? (
        <View style={{ flex: 1 }}>
          {searchLoading ? (
            <ActivityIndicator
              style={{ marginTop: 32 }}
              color={colors.tint}
            />
          ) : searchResults.length > 0 ? (
            <FlatList
              data={searchResults}
              keyExtractor={(u) => u.id}
              contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
              renderItem={({ item }) => (
                <UserSearchRow
                  user={item}
                  colors={colors}
                  isDark={isDark}
                  onPress={() => handleStartConversation(item)}
                />
              )}
            />
          ) : searchQuery.trim().length > 0 ? (
            <View style={styles.emptyWrap}>
              <Ionicons name="person-outline" size={40} color={colors.textTertiary} />
              <Text
                style={[styles.emptyText, { color: colors.textSecondary }]}
              >
                No users found
              </Text>
            </View>
          ) : (
            <View style={styles.emptyWrap}>
              <Ionicons name="search" size={40} color={colors.textTertiary} />
              <Text
                style={[styles.emptyText, { color: colors.textSecondary }]}
              >
                Search by name or username
              </Text>
            </View>
          )}
          {startingConv && (
            <View style={styles.startingOverlay}>
              <ActivityIndicator color={colors.tint} />
            </View>
          )}
        </View>
      ) : loadingConversations && conversations.length === 0 ? (
        <View style={styles.emptyWrap}>
          <ActivityIndicator color={colors.tint} />
        </View>
      ) : sortedConversations.length === 0 ? (
        <View style={styles.emptyWrap}>
          <View
            style={[
              styles.emptyIconWrap,
              { backgroundColor: colors.tintLight },
            ]}
          >
            <Ionicons
              name="chatbubbles-outline"
              size={36}
              color={colors.tint}
            />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            No messages yet
          </Text>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            Tap the pencil icon to start a conversation
          </Text>
        </View>
      ) : (
        <FlatList
          data={sortedConversations}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
          refreshControl={
            <RefreshControl
              refreshing={loadingConversations}
              onRefresh={loadConversations}
              tintColor={colors.tint}
            />
          }
          renderItem={({ item }) => (
            <ConversationRow
              item={item}
              currentUserId={currentUserId}
              colors={colors}
              isDark={isDark}
              onPress={() => handleOpenConversation(item.id)}
            />
          )}
          ItemSeparatorComponent={() => (
            <View
              style={[
                styles.separator,
                { backgroundColor: colors.borderLight, marginLeft: 74 },
              ]}
            />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  headerTitle: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
  },
  newMsgBtn: {
    padding: 4,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
    marginTop: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  convRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
  },
  convInfo: {
    flex: 1,
  },
  convTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
  },
  convName: {
    fontSize: 15,
    flex: 1,
    marginRight: 8,
  },
  convTime: {
    fontSize: 12,
  },
  convBottomRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  convPreview: {
    fontSize: 13,
  },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 4,
    justifyContent: "center",
    alignItems: "center",
  },
  badgeText: {
    color: "#fff",
    fontSize: 11,
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
  separator: {
    height: StyleSheet.hairlineWidth,
  },
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 32,
  },
  emptyIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  startingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.15)",
  },
});
