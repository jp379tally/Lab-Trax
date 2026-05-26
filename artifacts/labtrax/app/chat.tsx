import React, { useState, useRef } from "react";
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  Platform,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { resilientFetch } from "@/lib/query-client";

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

const LAB_SUGGESTED_PROMPTS = [
  "What cases are due this week?",
  "What's our average turnaround time?",
  "What's Dr. Smith's price for zirconia?",
  "Show me all rush cases",
];

const PROVIDER_SUGGESTED_PROMPTS = [
  "Where is my patient's case?",
  "What cases are due this week?",
  "What do you charge me for PFM crowns?",
  "What's the status of my recent cases?",
];

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const { userType } = useAuth();
  const isProvider = userType === "provider";

  const welcomeMessage = isProvider
    ? "Hi! I'm LabTrax's AI assistant. I can look up your cases across all your linked labs and answer pricing questions. How can I help?"
    : "Hi! I'm LabTrax's AI assistant. I can help you with case status, pricing, turnaround times, and lab info. How can I help?";

  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: "welcome",
      role: "assistant",
      content: welcomeMessage,
      timestamp: Date.now(),
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [promptsDismissed, setPromptsDismissed] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  const suggestedPrompts = isProvider ? PROVIDER_SUGGESTED_PROMPTS : LAB_SUGGESTED_PROMPTS;
  const showPrompts = !promptsDismissed && messages.length === 1;

  function generateId() {
    return Date.now().toString() + Math.random().toString(36).substr(2, 9);
  }

  async function sendMessage(text: string) {
    if (!text.trim() || sending) return;
    setPromptsDismissed(true);

    const userMsg: ChatMsg = {
      id: generateId(),
      role: "user",
      content: text.trim(),
      timestamp: Date.now(),
    };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    setSending(true);

    try {
      const apiMessages = nextMessages
        .filter((m) => m.id !== "welcome")
        .map((m) => ({ role: m.role, content: m.content }));

      const response = await resilientFetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });

      if (response.ok) {
        const data = await response.json();
        const assistantMsg: ChatMsg = {
          id: generateId(),
          role: "assistant",
          content: data.reply || "I couldn't process that request.",
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } else if (response.status === 503) {
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: "assistant",
            content: "AI assistant is not configured on this server. Please contact your administrator.",
            timestamp: Date.now(),
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: "assistant",
            content: "Sorry, I'm having trouble connecting right now. Please try again.",
            timestamp: Date.now(),
          },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          role: "assistant",
          content: "Connection error. Please check your network and try again.",
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  function handleSend() {
    sendMessage(input);
  }

  function handleSuggestedPrompt(prompt: string) {
    sendMessage(prompt);
  }

  function renderMessage({ item }: { item: ChatMsg }) {
    const isUser = item.role === "user";
    return (
      <View style={[styles.messageBubbleWrap, isUser ? styles.userWrap : styles.assistantWrap]}>
        {!isUser && (
          <View style={styles.aiAvatar}>
            <Ionicons name="sparkles" size={14} color={Colors.light.tint} />
          </View>
        )}
        <View style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}>
          <Text style={[styles.messageText, isUser && styles.userText]}>{item.content}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={Colors.light.text} />
        </Pressable>
        <View style={styles.headerCenter}>
          <View style={styles.headerIcon}>
            <Ionicons name="sparkles" size={16} color={Colors.light.tint} />
          </View>
          <Text style={styles.headerTitle}>AI Assistant</Text>
        </View>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          contentContainerStyle={styles.messagesList}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onContentSizeChange={() =>
            flatListRef.current?.scrollToEnd({ animated: true })
          }
          ListFooterComponent={
            showPrompts ? (
              <View style={styles.promptsContainer}>
                <Text style={styles.promptsLabel}>Try asking:</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.promptsScroll}
                >
                  {suggestedPrompts.map((p) => (
                    <Pressable
                      key={p}
                      onPress={() => handleSuggestedPrompt(p)}
                      style={({ pressed }) => [styles.promptChip, pressed && { opacity: 0.7 }]}
                    >
                      <Text style={styles.promptChipText}>{p}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null
          }
        />

        {sending && (
          <View style={styles.typingIndicator}>
            <ActivityIndicator size="small" color={Colors.light.tint} />
            <Text style={styles.typingText}>AI is thinking…</Text>
          </View>
        )}

        <View
          style={[
            styles.inputBar,
            { paddingBottom: Platform.OS === "web" ? 34 + 8 : Math.max(insets.bottom, 8) + 8 },
          ]}
        >
          <TextInput
            style={styles.textInput}
            value={input}
            onChangeText={setInput}
            placeholder={isProvider ? "Ask about a case or pricing…" : "Ask about a case, pricing, or lab…"}
            placeholderTextColor={Colors.light.textTertiary}
            multiline
            maxLength={1000}
            returnKeyType="send"
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
          />
          <Pressable
            onPress={handleSend}
            disabled={!input.trim() || sending}
            style={({ pressed }) => [
              styles.sendBtn,
              (!input.trim() || sending) && styles.sendBtnDisabled,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Ionicons
              name="send"
              size={18}
              color={!input.trim() || sending ? Colors.light.textTertiary : "#FFF"}
            />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
    backgroundColor: Colors.light.surface,
  },
  headerCenter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  messagesList: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexGrow: 1,
  },
  messageBubbleWrap: {
    flexDirection: "row",
    marginBottom: 12,
    alignItems: "flex-end",
    gap: 8,
  },
  userWrap: {
    justifyContent: "flex-end",
  },
  assistantWrap: {
    justifyContent: "flex-start",
  },
  aiAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.light.tintLight,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 2,
  },
  messageBubble: {
    maxWidth: "75%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  userBubble: {
    backgroundColor: Colors.light.tint,
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: Colors.light.surfaceSecondary,
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    lineHeight: 21,
  },
  userText: {
    color: "#FFF",
  },
  promptsContainer: {
    paddingVertical: 12,
    gap: 8,
  },
  promptsLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
    paddingHorizontal: 4,
    marginBottom: 4,
  },
  promptsScroll: {
    gap: 8,
    paddingBottom: 4,
  },
  promptChip: {
    backgroundColor: Colors.light.tintLight,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: Colors.light.tint + "33",
  },
  promptChipText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.tint,
  },
  typingIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  typingText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.light.borderLight,
    backgroundColor: Colors.light.surface,
    gap: 8,
  },
  textInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    backgroundColor: Colors.light.surfaceSecondary,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.light.tint,
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnDisabled: {
    backgroundColor: Colors.light.surfaceSecondary,
  },
});
