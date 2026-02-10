import React, { useState } from "react";
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
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { useApp } from "@/lib/app-context";
import Colors from "@/constants/colors";
import type { ChatMessage, Conversation } from "@/lib/data";

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

function ChatThreadModal({
  visible,
  activeConversationId,
  conversations,
  chatMessages,
  sendChatMessage,
  chatInput,
  setChatInput,
  chatImageUri,
  setChatImageUri,
  onClose,
}: {
  visible: boolean;
  activeConversationId: string | null;
  conversations: Conversation[];
  chatMessages: ChatMessage[];
  sendChatMessage: (conversationId: string, content: string, imageUri?: string) => void;
  chatInput: string;
  setChatInput: (v: string) => void;
  chatImageUri: string | null;
  setChatImageUri: (v: string | null) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const conv = conversations.find(c => c.id === activeConversationId);
  const msgs = chatMessages
    .filter(m => m.conversationId === activeConversationId)
    .sort((a, b) => b.timestamp - a.timestamp);

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

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={[chatStyles.container, { paddingTop: insets.top }]}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={90}
      >
        <View style={chatStyles.header}>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1, marginRight: 12 }]}
          >
            <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
          </Pressable>
          <Text style={chatStyles.headerTitle} numberOfLines={1}>{conv?.clientName ?? "Chat"}</Text>
          <View style={{ width: 36 }} />
        </View>
        <FlatList
          data={msgs}
          keyExtractor={(item) => item.id}
          inverted
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          renderItem={({ item }: { item: ChatMessage }) => {
            const isLab = item.senderType === "lab";
            return (
              <View style={[chatStyles.bubbleRow, isLab && chatStyles.bubbleRowRight]}>
                <View style={[chatStyles.bubble, isLab ? chatStyles.bubbleLab : chatStyles.bubbleOffice]}>
                  {item.imageUri ? (
                    <View style={chatStyles.imageThumb}>
                      {item.imageUri.length > 0 ? (
                        <Image source={{ uri: item.imageUri }} style={chatStyles.chatImage} contentFit="cover" />
                      ) : (
                        <View style={chatStyles.imagePlaceholder}>
                          <Ionicons name="image-outline" size={32} color={Colors.light.textTertiary} />
                        </View>
                      )}
                      {item.content.length > 0 && (
                        <Text style={[chatStyles.bubbleText, isLab ? chatStyles.bubbleTextLab : chatStyles.bubbleTextOffice]}>
                          {item.content}
                        </Text>
                      )}
                    </View>
                  ) : (
                    <Text style={[chatStyles.bubbleText, isLab ? chatStyles.bubbleTextLab : chatStyles.bubbleTextOffice]}>
                      {item.content}
                    </Text>
                  )}
                  <Text style={[chatStyles.bubbleTime, isLab ? chatStyles.bubbleTimeLab : chatStyles.bubbleTimeOffice]}>
                    {formatRelativeTime(item.timestamp)}
                  </Text>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={chatStyles.emptyWrap}>
              <Text style={chatStyles.emptyText}>No messages yet</Text>
            </View>
          }
        />
        {chatImageUri && (
          <View style={chatStyles.imagePreviewRow}>
            <Image source={{ uri: chatImageUri }} style={chatStyles.imagePreview} contentFit="cover" />
            <Pressable onPress={() => setChatImageUri(null)} style={chatStyles.imagePreviewRemove}>
              <Ionicons name="close-circle" size={22} color="#EF4444" />
            </Pressable>
          </View>
        )}
        <View style={[chatStyles.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <Pressable
            onPress={handleChatPickImage}
            style={({ pressed }) => [chatStyles.inputIconBtn, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Ionicons name="camera" size={22} color={Colors.light.tint} />
          </Pressable>
          <TextInput
            style={chatStyles.chatTextInput}
            value={chatInput}
            onChangeText={setChatInput}
            placeholder="Type a message..."
            placeholderTextColor={Colors.light.textTertiary}
            multiline
            maxLength={1000}
          />
          <Pressable
            onPress={() => {
              if (!activeConversationId) return;
              const trimmed = chatInput.trim();
              if (!trimmed && !chatImageUri) return;
              sendChatMessage(activeConversationId, trimmed || (chatImageUri ? "" : ""), chatImageUri ?? undefined);
              setChatInput("");
              setChatImageUri(null);
              if (Platform.OS !== "web") {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            }}
            style={({ pressed }) => [chatStyles.sendBtn, { opacity: (chatInput.trim() || chatImageUri) ? (pressed ? 0.7 : 1) : 0.4 }]}
            disabled={!chatInput.trim() && !chatImageUri}
          >
            <Ionicons name="send" size={20} color="#FFF" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function ChatButton() {
  const { conversations, chatMessages, sendChatMessage, markConversationRead, totalUnreadMessages } = useApp();
  const insets = useSafeAreaInsets();
  const [showConversations, setShowConversations] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatImageUri, setChatImageUri] = useState<string | null>(null);

  return (
    <>
      <Pressable onPress={() => setShowConversations(true)} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}>
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
        visible={showConversations}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowConversations(false)}
      >
        <View style={[chatStyles.container, { paddingTop: insets.top }]}>
          <View style={chatStyles.header}>
            <Text style={chatStyles.headerTitle}>Messages</Text>
            <Pressable
              onPress={() => setShowConversations(false)}
              style={({ pressed }) => [chatStyles.headerClose, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Ionicons name="close" size={22} color={Colors.light.text} />
            </Pressable>
          </View>
          <FlatList
            data={[...conversations].sort((a, b) => b.lastMessageTime - a.lastMessageTime)}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
            renderItem={({ item }: { item: Conversation }) => {
              const initials = item.clientName.charAt(0).toUpperCase();
              const avatarColors = ["#2563EB", "#7C3AED", "#059669", "#DC2626", "#D97706"];
              const colorIndex = item.clientName.charCodeAt(0) % avatarColors.length;
              return (
                <Pressable
                  onPress={() => {
                    setActiveConversationId(item.id);
                    markConversationRead(item.id);
                  }}
                  style={({ pressed }) => [chatStyles.convRow, pressed && { backgroundColor: Colors.light.surfaceAlt }]}
                >
                  <View style={[chatStyles.avatar, { backgroundColor: avatarColors[colorIndex] }]}>
                    <Text style={chatStyles.avatarText}>{initials}</Text>
                  </View>
                  <View style={chatStyles.convInfo}>
                    <View style={chatStyles.convTop}>
                      <Text style={chatStyles.convName} numberOfLines={1}>{item.clientName}</Text>
                      <Text style={chatStyles.convTime}>{formatRelativeTime(item.lastMessageTime)}</Text>
                    </View>
                    <View style={chatStyles.convBottom}>
                      <Text style={[chatStyles.convPreview, item.unreadCount > 0 && chatStyles.convPreviewBold]} numberOfLines={1}>
                        {item.lastMessage}
                      </Text>
                      {item.unreadCount > 0 && (
                        <View style={chatStyles.unreadBadge}>
                          <Text style={chatStyles.unreadBadgeText}>{item.unreadCount}</Text>
                        </View>
                      )}
                    </View>
                  </View>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <View style={chatStyles.emptyWrap}>
                <Ionicons name="chatbubbles-outline" size={48} color={Colors.light.textTertiary} />
                <Text style={chatStyles.emptyText}>No conversations yet</Text>
              </View>
            }
          />
        </View>
      </Modal>

      <ChatThreadModal
        visible={activeConversationId !== null}
        activeConversationId={activeConversationId}
        conversations={conversations}
        chatMessages={chatMessages}
        sendChatMessage={sendChatMessage}
        chatInput={chatInput}
        setChatInput={setChatInput}
        chatImageUri={chatImageUri}
        setChatImageUri={setChatImageUri}
        onClose={() => {
          setActiveConversationId(null);
          setChatInput("");
          setChatImageUri(null);
        }}
      />
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

const chatStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.border,
    backgroundColor: Colors.light.surface,
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    flex: 1,
  },
  headerClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.light.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  convRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.border,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  avatarText: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  convInfo: {
    flex: 1,
  },
  convTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  convName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
    flex: 1,
    marginRight: 8,
  },
  convTime: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
  },
  convBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  convPreview: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    flex: 1,
    marginRight: 8,
  },
  convPreviewBold: {
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  unreadBadge: {
    backgroundColor: Colors.light.tint,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  unreadBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  emptyWrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textTertiary,
  },
  bubbleRow: {
    flexDirection: "row",
    marginBottom: 10,
  },
  bubbleRowRight: {
    justifyContent: "flex-end",
  },
  bubble: {
    maxWidth: "78%",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleLab: {
    backgroundColor: Colors.light.tint,
    borderBottomRightRadius: 4,
  },
  bubbleOffice: {
    backgroundColor: Colors.light.surfaceSecondary,
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 21,
  },
  bubbleTextLab: {
    color: "#FFF",
  },
  bubbleTextOffice: {
    color: Colors.light.text,
  },
  bubbleTime: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    marginTop: 4,
  },
  bubbleTimeLab: {
    color: "rgba(255,255,255,0.6)",
  },
  bubbleTimeOffice: {
    color: Colors.light.textTertiary,
  },
  imageThumb: {
    gap: 6,
  },
  chatImage: {
    width: 180,
    height: 140,
    borderRadius: 12,
  },
  imagePlaceholder: {
    width: 180,
    height: 140,
    borderRadius: 12,
    backgroundColor: Colors.light.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.light.border,
    backgroundColor: Colors.light.surface,
    gap: 8,
  },
  inputIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.light.tintLight,
    alignItems: "center",
    justifyContent: "center",
  },
  chatTextInput: {
    flex: 1,
    backgroundColor: Colors.light.surfaceAlt,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    maxHeight: 100,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.light.tint,
    alignItems: "center",
    justifyContent: "center",
  },
  imagePreviewRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: Colors.light.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.light.border,
  },
  imagePreview: {
    width: 60,
    height: 60,
    borderRadius: 10,
  },
  imagePreviewRemove: {
    marginLeft: 8,
  },
  aiChatCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.light.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
    gap: 14,
    marginBottom: 20,
    marginHorizontal: 20,
    marginTop: 16,
  },
  aiChatIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center",
    alignItems: "center",
  },
  aiChatTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  aiChatSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    marginTop: 2,
  },
  aiChatInfo: {
    flex: 1,
  },
});
