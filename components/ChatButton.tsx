import React, { useState, useRef, useCallback } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Platform,
  TextInput,
  Alert,
  FlatList,
  Modal,
  KeyboardAvoidingView,
  Dimensions,
  Animated as RNAnimated,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { useApp } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import type { ChatMessage, Conversation } from "@/lib/data";

const MESSENGER_BLUE = "#0084FF";
const MESSENGER_BG = "#FFFFFF";
const MESSENGER_GRAY = "#F0F0F0";
const MESSENGER_DARK = "#050505";
const MESSENGER_SECONDARY = "#65676B";
const MESSENGER_BORDER = "#E4E6EB";
const MESSENGER_HOVER = "#F2F2F2";

const AVATAR_COLORS = ["#0084FF", "#00C6FF", "#7C3AED", "#059669", "#DC2626", "#D97706", "#EC4899", "#8B5CF6", "#06B6D4", "#F97316"];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "1d";
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } else if (diffDays === 1) {
    return "Yesterday " + date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } else if (diffDays < 7) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return days[date.getDay()] + " " + date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } else {
    return date.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
}

function shouldShowTimestamp(currentMsg: ChatMessage, prevMsg: ChatMessage | null): boolean {
  if (!prevMsg) return true;
  return (currentMsg.timestamp - prevMsg.timestamp) > 3600000;
}

export function ChatButton() {
  const { conversations, chatMessages, sendChatMessage, markConversationRead, totalUnreadMessages, getUserGroups, groups, clients, addConversation } = useApp();
  const { currentUser, registeredUsers } = useAuth();
  const insets = useSafeAreaInsets();
  const [showChat, setShowChat] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatImageUri, setChatImageUri] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showNewMessage, setShowNewMessage] = useState(false);
  const [newMessageSearch, setNewMessageSearch] = useState("");
  const inputRef = useRef<TextInput>(null);

  const myGroups = getUserGroups(currentUser || "");

  const allContacts = React.useMemo(() => {
    const contactMap = new Map<string, { username: string; groupName: string; role: string; type: string }>();
    for (const g of myGroups) {
      for (const m of g.members) {
        if (m.username.toLowerCase() !== (currentUser || "").toLowerCase() && !contactMap.has(m.username.toLowerCase())) {
          contactMap.set(m.username.toLowerCase(), { username: m.username, groupName: g.name, role: m.role, type: g.type });
        }
      }
    }
    for (const g of myGroups) {
      if (!contactMap.has(g.name.toLowerCase())) {
        contactMap.set(g.name.toLowerCase(), { username: g.name, groupName: g.name, role: "group", type: g.type });
      }
    }
    for (const u of registeredUsers) {
      if (u.username.toLowerCase() !== (currentUser || "").toLowerCase() && !contactMap.has(u.username.toLowerCase())) {
        contactMap.set(u.username.toLowerCase(), { username: u.username, groupName: "", role: "user", type: "other" });
      }
    }
    return Array.from(contactMap.values());
  }, [myGroups, currentUser, registeredUsers]);

  const sortedConversations = React.useMemo(() => {
    return [...conversations].sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  }, [conversations]);

  const filteredConversations = React.useMemo(() => {
    if (!searchQuery.trim()) return sortedConversations;
    const q = searchQuery.toLowerCase().trim();
    return sortedConversations.filter(c => c.clientName.toLowerCase().includes(q));
  }, [sortedConversations, searchQuery]);

  const newMessageContacts = React.useMemo(() => {
    const q = newMessageSearch.toLowerCase().trim();
    if (!q) return allContacts.slice(0, 20);
    return allContacts.filter(c =>
      c.username.toLowerCase().includes(q) || c.groupName.toLowerCase().includes(q)
    );
  }, [newMessageSearch, allContacts]);

  function openConversation(contactName: string) {
    const existingConv = conversations.find(c =>
      c.clientName.toLowerCase() === contactName.toLowerCase()
    );
    if (existingConv) {
      setActiveConversationId(existingConv.id);
      markConversationRead(existingConv.id);
    } else {
      const newId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      const newConv: Conversation = {
        id: newId,
        clientId: newId,
        clientName: contactName,
        lastMessage: "",
        lastMessageTime: Date.now(),
        unreadCount: 0,
      };
      addConversation(newConv);
      setActiveConversationId(newId);
    }
    setShowNewMessage(false);
    setNewMessageSearch("");
  }

  function closeChat() {
    setShowChat(false);
    setActiveConversationId(null);
    setChatInput("");
    setChatImageUri(null);
    setSearchQuery("");
    setShowNewMessage(false);
    setNewMessageSearch("");
  }

  function goBackToList() {
    setActiveConversationId(null);
    setChatInput("");
    setChatImageUri(null);
    setShowNewMessage(false);
  }

  async function handleChatPickImage() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Photo library access is required.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setChatImageUri(result.assets[0].uri);
    }
  }

  function handleSend() {
    if (!activeConversationId) return;
    const trimmed = chatInput.trim();
    if (!trimmed && !chatImageUri) return;
    sendChatMessage(activeConversationId, trimmed || "", chatImageUri ?? undefined);
    setChatInput("");
    setChatImageUri(null);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }

  function handleThumbsUp() {
    if (!activeConversationId) return;
    sendChatMessage(activeConversationId, "\u{1F44D}");
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }

  const activeConv = activeConversationId ? conversations.find(c => c.id === activeConversationId) : null;
  const activeMsgs = activeConversationId
    ? chatMessages.filter(m => m.conversationId === activeConversationId).sort((a, b) => b.timestamp - a.timestamp)
    : [];

  const chronologicalMsgs = [...activeMsgs].reverse();

  function renderAvatar(name: string, size: number = 40) {
    const color = getAvatarColor(name);
    const initial = name.charAt(0).toUpperCase();
    return (
      <View style={[s.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]}>
        <Text style={[s.avatarText, { fontSize: size * 0.42 }]}>{initial}</Text>
      </View>
    );
  }

  function renderConversationList() {
    return (
      <>
        <View style={[s.listHeader, { paddingTop: Platform.OS === "web" ? 67 : insets.top + 8 }]}>
          <View style={s.listHeaderTop}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              {renderAvatar(currentUser || "U", 36)}
              <Text style={s.listTitle}>Chats</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Pressable
                onPress={() => setShowNewMessage(true)}
                style={({ pressed }) => [s.headerIconBtn, pressed && { opacity: 0.7 }]}
              >
                <Feather name="edit" size={18} color={MESSENGER_DARK} />
              </Pressable>
              <Pressable
                onPress={closeChat}
                style={({ pressed }) => [s.headerIconBtn, pressed && { opacity: 0.7 }]}
              >
                <Ionicons name="close" size={18} color={MESSENGER_DARK} />
              </Pressable>
            </View>
          </View>
          <View style={s.searchBar}>
            <Ionicons name="search" size={16} color={MESSENGER_SECONDARY} />
            <TextInput
              style={s.searchInput}
              placeholder="Search Messenger"
              placeholderTextColor={MESSENGER_SECONDARY}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {searchQuery.length > 0 && (
              <Pressable onPress={() => setSearchQuery("")}>
                <Ionicons name="close-circle" size={16} color={MESSENGER_SECONDARY} />
              </Pressable>
            )}
          </View>
        </View>

        {showNewMessage && renderNewMessageOverlay()}

        <FlatList
          data={filteredConversations}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }: { item: Conversation }) => {
            const hasUnread = item.unreadCount > 0;
            const lastMsgPreview = item.lastMessage || "Tap to start chatting";
            return (
              <Pressable
                onPress={() => {
                  setActiveConversationId(item.id);
                  markConversationRead(item.id);
                }}
                style={({ pressed }) => [s.convRow, pressed && { backgroundColor: MESSENGER_HOVER }]}
              >
                <View style={s.convAvatarWrap}>
                  {renderAvatar(item.clientName, 56)}
                  <View style={s.onlineDot} />
                </View>
                <View style={s.convInfo}>
                  <Text style={[s.convName, hasUnread && s.convNameBold]} numberOfLines={1}>{item.clientName}</Text>
                  <View style={s.convPreviewRow}>
                    <Text style={[s.convPreview, hasUnread && s.convPreviewBold]} numberOfLines={1}>
                      {lastMsgPreview}
                    </Text>
                    <Text style={s.convDot}> · </Text>
                    <Text style={[s.convTime, hasUnread && { color: MESSENGER_DARK }]}>{formatRelativeTime(item.lastMessageTime)}</Text>
                  </View>
                </View>
                {hasUnread && (
                  <View style={s.unreadDot} />
                )}
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={s.emptyState}>
              <View style={s.emptyIconWrap}>
                <Ionicons name="chatbubbles" size={48} color={MESSENGER_BLUE} />
              </View>
              <Text style={s.emptyTitle}>No messages yet</Text>
              <Text style={s.emptySubtitle}>Tap the edit icon to start a new conversation</Text>
            </View>
          }
        />
      </>
    );
  }

  function renderNewMessageOverlay() {
    return (
      <View style={s.newMsgOverlay}>
        <View style={s.newMsgHeader}>
          <Text style={s.newMsgTitle}>New Message</Text>
          <Pressable onPress={() => { setShowNewMessage(false); setNewMessageSearch(""); }}>
            <Ionicons name="close" size={22} color={MESSENGER_DARK} />
          </Pressable>
        </View>
        <View style={s.newMsgSearchRow}>
          <Text style={s.newMsgToLabel}>To:</Text>
          <TextInput
            style={s.newMsgSearchInput}
            placeholder="Type a name"
            placeholderTextColor={MESSENGER_SECONDARY}
            value={newMessageSearch}
            onChangeText={setNewMessageSearch}
            autoFocus
            autoCapitalize="words"
            autoCorrect={false}
          />
        </View>
        <FlatList
          data={newMessageContacts}
          keyExtractor={(item, idx) => item.username + idx}
          keyboardShouldPersistTaps="handled"
          style={{ maxHeight: 320 }}
          renderItem={({ item }) => {
            const isGroup = item.role === "group";
            return (
              <Pressable
                onPress={() => openConversation(item.username)}
                style={({ pressed }) => [s.contactRow, pressed && { backgroundColor: MESSENGER_HOVER }]}
              >
                <View style={s.contactAvatarWrap}>
                  {isGroup ? (
                    <View style={[s.avatar, { width: 44, height: 44, borderRadius: 22, backgroundColor: "#E4E6EB" }]}>
                      <Ionicons name="people" size={20} color={MESSENGER_SECONDARY} />
                    </View>
                  ) : (
                    renderAvatar(item.username, 44)
                  )}
                  {!isGroup && <View style={[s.onlineDot, { bottom: 0, right: 0, width: 10, height: 10, borderWidth: 1.5 }]} />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.contactName}>{item.username}</Text>
                  {item.groupName && item.groupName !== item.username && (
                    <Text style={s.contactSub}>{item.groupName}</Text>
                  )}
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={{ padding: 24, alignItems: "center" }}>
              <Text style={s.contactSub}>No contacts found</Text>
            </View>
          }
        />
      </View>
    );
  }

  function renderMessageThread() {
    if (!activeConv) return null;

    return (
      <>
        <View style={[s.threadHeader, { paddingTop: Platform.OS === "web" ? 67 : insets.top + 4 }]}>
          <Pressable
            onPress={goBackToList}
            style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1, padding: 4 }]}
          >
            <Ionicons name="arrow-back" size={24} color={MESSENGER_BLUE} />
          </Pressable>
          <Pressable style={[s.threadHeaderCenter, { flex: 1 }]} onPress={() => {}}>
            <View style={s.threadAvatarWrap}>
              {renderAvatar(activeConv.clientName, 36)}
              <View style={[s.onlineDot, { width: 10, height: 10, borderWidth: 1.5, bottom: -1, right: -1 }]} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.threadName} numberOfLines={1}>{activeConv.clientName}</Text>
              <Text style={s.threadStatus}>Active now</Text>
            </View>
          </Pressable>
          <Pressable
            onPress={closeChat}
            style={({ pressed }) => [s.headerIconBtn, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Ionicons name="close" size={18} color={MESSENGER_DARK} />
          </Pressable>
        </View>

        <FlatList
          data={activeMsgs}
          keyExtractor={(item) => item.id}
          inverted
          contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          renderItem={({ item, index }: { item: ChatMessage; index: number }) => {
            const isMe = item.senderType === "lab";
            const prevItem = index < activeMsgs.length - 1 ? activeMsgs[index + 1] : null;
            const nextItem = index > 0 ? activeMsgs[index - 1] : null;

            const showTime = shouldShowTimestamp(item, prevItem);
            const isFirstInGroup = !prevItem || prevItem.senderType !== item.senderType || showTime;
            const isLastInGroup = !nextItem || nextItem.senderType !== item.senderType || (nextItem && shouldShowTimestamp(nextItem, item));

            const showSenderAvatar = !isMe && isLastInGroup;
            const isLastMessage = index === 0;
            const showSeen = isMe && isLastMessage && item.read;

            return (
              <View>
                {showTime && (
                  <View style={s.timestampRow}>
                    <Text style={s.timestampText}>{formatMessageTime(item.timestamp)}</Text>
                  </View>
                )}
                <View style={[s.msgRow, isMe && s.msgRowRight]}>
                  {!isMe && (
                    <View style={{ width: 28, marginRight: 8, alignSelf: "flex-end" }}>
                      {showSenderAvatar && renderAvatar(activeConv?.clientName || "?", 28)}
                    </View>
                  )}
                  <View style={{ maxWidth: "75%", alignItems: isMe ? "flex-end" : "flex-start" }}>
                    {item.imageUri ? (
                      <View style={s.imageMsgWrap}>
                        <Image source={{ uri: item.imageUri }} style={s.msgImage} contentFit="cover" />
                        {item.content.length > 0 && (
                          <View style={[s.msgBubble, isMe ? s.msgBubbleMe : s.msgBubbleThem, { marginTop: 4 }]}>
                            <Text style={[s.msgText, isMe && s.msgTextMe]}>{item.content}</Text>
                          </View>
                        )}
                      </View>
                    ) : item.content === "\u{1F44D}" ? (
                      <Text style={{ fontSize: 32, lineHeight: 40, marginVertical: 2 }}>{"\u{1F44D}"}</Text>
                    ) : (
                      <View style={[
                        s.msgBubble,
                        isMe ? s.msgBubbleMe : s.msgBubbleThem,
                        isFirstInGroup && isLastInGroup && (isMe ? s.bubbleSingleMe : s.bubbleSingleThem),
                        isFirstInGroup && !isLastInGroup && (isMe ? s.bubbleTopMe : s.bubbleTopThem),
                        !isFirstInGroup && isLastInGroup && (isMe ? s.bubbleBottomMe : s.bubbleBottomThem),
                        !isFirstInGroup && !isLastInGroup && (isMe ? s.bubbleMiddleMe : s.bubbleMiddleThem),
                      ]}>
                        <Text style={[s.msgText, isMe && s.msgTextMe]}>{item.content}</Text>
                      </View>
                    )}
                    {showSeen && (
                      <View style={s.seenRow}>
                        {renderAvatar(activeConv?.clientName || "?", 12)}
                      </View>
                    )}
                  </View>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={s.threadEmptyState}>
              <View style={{ marginBottom: 12 }}>
                {renderAvatar(activeConv.clientName, 64)}
              </View>
              <Text style={s.threadEmptyName}>{activeConv.clientName}</Text>
              <Text style={s.threadEmptySub}>Start a conversation</Text>
            </View>
          }
        />

        {chatImageUri && (
          <View style={s.imagePreviewBar}>
            <Image source={{ uri: chatImageUri }} style={s.imagePreviewThumb} contentFit="cover" />
            <Pressable onPress={() => setChatImageUri(null)} style={s.imagePreviewRemove}>
              <Ionicons name="close-circle" size={20} color="#EF4444" />
            </Pressable>
          </View>
        )}

        <View style={[s.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <Pressable
            onPress={handleChatPickImage}
            style={({ pressed }) => [s.inputCircleBtn, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Ionicons name="add-circle" size={28} color={MESSENGER_BLUE} />
          </Pressable>
          <Pressable
            onPress={handleChatPickImage}
            style={({ pressed }) => [s.inputCircleBtn, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Ionicons name="camera" size={22} color={MESSENGER_BLUE} />
          </Pressable>
          <View style={s.inputBubble}>
            <TextInput
              ref={inputRef}
              style={s.inputText}
              value={chatInput}
              onChangeText={setChatInput}
              placeholder="Aa"
              placeholderTextColor={MESSENGER_SECONDARY}
              multiline
              maxLength={2000}
            />
            <Pressable style={{ padding: 4 }}>
              <Ionicons name="happy-outline" size={22} color={MESSENGER_BLUE} />
            </Pressable>
          </View>
          {chatInput.trim() || chatImageUri ? (
            <Pressable
              onPress={handleSend}
              style={({ pressed }) => [s.inputCircleBtn, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Ionicons name="send" size={22} color={MESSENGER_BLUE} />
            </Pressable>
          ) : (
            <Pressable
              onPress={handleThumbsUp}
              style={({ pressed }) => [s.inputCircleBtn, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Ionicons name="thumbs-up" size={24} color={MESSENGER_BLUE} />
            </Pressable>
          )}
        </View>
      </>
    );
  }

  return (
    <>
      <Pressable onPress={() => setShowChat(true)} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}>
        <View style={styles.chatIconWrap}>
          <Ionicons name="chatbubbles" size={24} color={Colors.light.tint} />
          {totalUnreadMessages > 0 && (
            <View style={styles.chatBadge}>
              <Text style={styles.chatBadgeText}>
                {totalUnreadMessages > 9 ? "9+" : totalUnreadMessages}
              </Text>
            </View>
          )}
        </View>
      </Pressable>

      <Modal
        visible={showChat}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={closeChat}
      >
        <KeyboardAvoidingView
          style={s.container}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={0}
        >
          {activeConversationId ? renderMessageThread() : renderConversationList()}
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  chatIconWrap: {
    position: "relative",
  },
  chatBadge: {
    position: "absolute",
    top: -4,
    right: -6,
    backgroundColor: "#EF4444",
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
    borderWidth: 1.5,
    borderColor: "#FFF",
  },
  chatBadgeText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
});

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: MESSENGER_BG,
  },

  avatar: {
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },

  listHeader: {
    backgroundColor: MESSENGER_BG,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  listHeaderTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  listTitle: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: MESSENGER_DARK,
  },
  headerIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: MESSENGER_GRAY,
    alignItems: "center",
    justifyContent: "center",
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: MESSENGER_GRAY,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 8 : 4,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_DARK,
    padding: 0,
  },

  convRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  convAvatarWrap: {
    position: "relative",
    marginRight: 12,
  },
  onlineDot: {
    position: "absolute",
    bottom: 1,
    right: 1,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#31A24C",
    borderWidth: 2,
    borderColor: MESSENGER_BG,
  },
  convInfo: {
    flex: 1,
    marginRight: 8,
  },
  convName: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_DARK,
    marginBottom: 2,
  },
  convNameBold: {
    fontFamily: "Inter_700Bold",
  },
  convPreviewRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  convPreview: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_SECONDARY,
    flexShrink: 1,
  },
  convPreviewBold: {
    fontFamily: "Inter_600SemiBold",
    color: MESSENGER_DARK,
  },
  convDot: {
    fontSize: 13,
    color: MESSENGER_SECONDARY,
  },
  convTime: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_SECONDARY,
    flexShrink: 0,
  },
  unreadDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: MESSENGER_BLUE,
  },

  emptyState: {
    alignItems: "center",
    paddingTop: 80,
    paddingHorizontal: 40,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#E7F3FF",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: MESSENGER_DARK,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_SECONDARY,
    textAlign: "center",
  },

  newMsgOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: MESSENGER_BG,
    zIndex: 10,
    paddingTop: Platform.OS === "web" ? 67 : 0,
  },
  newMsgHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: MESSENGER_BORDER,
  },
  newMsgTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: MESSENGER_DARK,
  },
  newMsgSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: MESSENGER_BORDER,
    gap: 8,
  },
  newMsgToLabel: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_SECONDARY,
  },
  newMsgSearchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_DARK,
    padding: 0,
  },
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
  },
  contactAvatarWrap: {
    position: "relative",
  },
  contactName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: MESSENGER_DARK,
  },
  contactSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_SECONDARY,
    marginTop: 1,
  },

  threadHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: MESSENGER_BORDER,
    backgroundColor: MESSENGER_BG,
    gap: 4,
  },
  threadHeaderCenter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginLeft: 4,
  },
  threadAvatarWrap: {
    position: "relative",
  },
  threadName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: MESSENGER_DARK,
  },
  threadStatus: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_SECONDARY,
  },

  timestampRow: {
    alignItems: "center",
    marginVertical: 16,
  },
  timestampText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_SECONDARY,
  },

  msgRow: {
    flexDirection: "row",
    marginBottom: 2,
    alignItems: "flex-end",
  },
  msgRowRight: {
    justifyContent: "flex-end",
  },
  msgBubble: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
  },
  msgBubbleMe: {
    backgroundColor: MESSENGER_BLUE,
  },
  msgBubbleThem: {
    backgroundColor: MESSENGER_GRAY,
  },

  bubbleSingleMe: { borderRadius: 18 },
  bubbleSingleThem: { borderRadius: 18 },
  bubbleTopMe: { borderBottomRightRadius: 4 },
  bubbleTopThem: { borderBottomLeftRadius: 4 },
  bubbleMiddleMe: { borderTopRightRadius: 4, borderBottomRightRadius: 4 },
  bubbleMiddleThem: { borderTopLeftRadius: 4, borderBottomLeftRadius: 4 },
  bubbleBottomMe: { borderTopRightRadius: 4 },
  bubbleBottomThem: { borderTopLeftRadius: 4 },

  msgText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_DARK,
    lineHeight: 20,
  },
  msgTextMe: {
    color: "#FFFFFF",
  },

  imageMsgWrap: {
    borderRadius: 18,
    overflow: "hidden",
  },
  msgImage: {
    width: 200,
    height: 160,
    borderRadius: 18,
  },

  seenRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 4,
    marginRight: 2,
  },

  threadEmptyState: {
    alignItems: "center",
    paddingTop: 40,
    transform: [{ scaleY: -1 }],
  },
  threadEmptyName: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: MESSENGER_DARK,
    marginBottom: 4,
  },
  threadEmptySub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_SECONDARY,
  },

  imagePreviewBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: MESSENGER_BG,
    borderTopWidth: 0.5,
    borderTopColor: MESSENGER_BORDER,
  },
  imagePreviewThumb: {
    width: 60,
    height: 60,
    borderRadius: 12,
  },
  imagePreviewRemove: {
    marginLeft: 8,
  },

  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 8,
    paddingTop: 8,
    backgroundColor: MESSENGER_BG,
    borderTopWidth: 0.5,
    borderTopColor: MESSENGER_BORDER,
    gap: 2,
  },
  inputCircleBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  inputBubble: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    backgroundColor: MESSENGER_GRAY,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 8 : 4,
    maxHeight: 100,
  },
  inputText: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: MESSENGER_DARK,
    padding: 0,
    maxHeight: 80,
  },
});
