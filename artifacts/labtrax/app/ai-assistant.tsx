import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { resilientFetch } from "@/lib/query-client";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ToolOutput {
  name: string;
  result: unknown;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolOutputs?: ToolOutput[];
  isError?: boolean;
}

interface ApiReply {
  type: "reply" | "proposed_action";
  content?: string;
  summary?: string;
  toolName?: string;
  toolOutputs?: ToolOutput[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _msgCounter = 0;
function genId() {
  _msgCounter += 1;
  return `msg-${Date.now()}-${_msgCounter}`;
}

const WELCOME_MSG: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "Hi! I'm your LabTrax AI assistant. I can help you look up cases and invoices, check due dates, draft messages, and more. What can I help you with?",
};

const SUGGESTED_PROMPTS = [
  "Cases due today",
  "What's my AR balance?",
  "Remake rate this month",
  "Draft a delay message for Dr. Smith",
];

// ─── Message bubble ───────────────────────────────────────────────────────────

interface BubbleProps {
  msg: ChatMessage;
  colors: ThemeColors;
}

function MessageBubble({ msg, colors }: BubbleProps) {
  const isUser = msg.role === "user";
  const draftTool = msg.toolOutputs?.find((t) => t.name === "draft_message")?.result as
    | { draft?: string }
    | undefined;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (text: string) => {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — silently ignore, no state change
    }
  }, []);

  return (
    <View
      style={[
        styles.bubbleRow,
        isUser ? styles.bubbleRowUser : styles.bubbleRowAssistant,
      ]}
    >
      {!isUser && (
        <View style={[styles.avatar, { backgroundColor: colors.tint + "1A" }]}>
          <Ionicons name="sparkles" size={12} color={colors.tint} />
        </View>
      )}
      <View style={[styles.bubbleGroup, isUser ? styles.bubbleGroupUser : styles.bubbleGroupAssistant]}>
        <View
          style={[
            styles.bubble,
            isUser
              ? [styles.bubbleUser, { backgroundColor: colors.tint }]
              : [
                  styles.bubbleAssistant,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.border,
                  },
                ],
            msg.isError && styles.bubbleError,
          ]}
        >
          <Text
            style={[
              styles.bubbleText,
              { color: isUser ? "#fff" : colors.text },
              msg.isError && { color: "#9b2c2c" },
            ]}
          >
            {msg.content}
          </Text>
        </View>
        {draftTool?.draft && (
          <View style={[styles.draftBox, { borderColor: colors.tint + "40", backgroundColor: colors.tint + "0D" }]}>
            <View style={styles.draftHeader}>
              <Text style={[styles.draftLabel, { color: colors.tint }]}>Drafted message</Text>
              <Pressable
                onPress={() => handleCopy(draftTool.draft!)}
                hitSlop={8}
                style={[styles.copyBtn, { borderColor: colors.tint + "40", backgroundColor: copied ? colors.tint + "1A" : "transparent" }]}
                accessibilityLabel="Copy drafted message"
              >
                <Ionicons name={copied ? "checkmark" : "copy-outline"} size={12} color={colors.tint} />
                <Text style={[styles.copyBtnText, { color: colors.tint }]}>{copied ? "Copied!" : "Copy"}</Text>
              </Pressable>
            </View>
            <Text style={[styles.draftText, { color: colors.text }]}>{draftTool.draft}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function AiAssistantScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);

  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MSG]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const showPrompts = messages.length === 1;

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 80);
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      const userMsg: ChatMessage = { id: genId(), role: "user", content: trimmed };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      setInput("");
      setSending(true);
      scrollToBottom();

      try {
        // Build conversation history (skip welcome)
        const history = nextMessages
          .filter((m) => m.id !== "welcome")
          .map((m) => ({ role: m.role, content: m.content }));

        const res = await resilientFetch("/api/ai-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history }),
        });

        if (!res.ok) {
          const status = res.status;
          const errText =
            status === 503
              ? "AI assistant is not set up on this server. Contact your administrator."
              : status === 429
              ? "Please slow down — try again in a moment."
              : "Something went wrong. Please try again.";
          setMessages((prev) => [
            ...prev,
            { id: genId(), role: "assistant", content: errText, isError: true },
          ]);
          scrollToBottom();
          return;
        }

        const data = (await res.json()) as ApiReply;

        let assistantMsg: ChatMessage;
        if (data.type === "proposed_action" && data.summary) {
          assistantMsg = {
            id: genId(),
            role: "assistant",
            content: `I'd like to: ${data.summary}\n\nThis action requires confirmation and can only be approved in the desktop app. Please open the AI assistant on desktop to proceed.`,
          };
        } else {
          assistantMsg = {
            id: genId(),
            role: "assistant",
            content: data.content ?? "I couldn't generate a response. Please try again.",
            ...(data.toolOutputs && data.toolOutputs.length > 0
              ? { toolOutputs: data.toolOutputs }
              : {}),
          };
        }

        setMessages((prev) => [...prev, assistantMsg]);
        scrollToBottom();
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: genId(),
            role: "assistant",
            content: "Sorry, I'm having trouble connecting right now. Please try again.",
            isError: true,
          },
        ]);
        scrollToBottom();
      } finally {
        setSending(false);
      }
    },
    [messages, sending, scrollToBottom],
  );

  const handleSend = useCallback(() => {
    sendMessage(input);
  }, [input, sendMessage]);

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => <MessageBubble msg={item} colors={colors} />,
    [colors],
  );

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </Pressable>
        <View style={s.headerCenter}>
          <View style={[s.headerIcon, { backgroundColor: colors.tint + "1A" }]}>
            <Ionicons name="sparkles" size={14} color={colors.tint} />
          </View>
          <View>
            <Text style={[s.headerTitle, { color: colors.text }]}>AI Assistant</Text>
            <Text style={[s.headerSubtitle, { color: colors.textSecondary }]}>
              Ask anything about your lab
            </Text>
          </View>
        </View>
        <Pressable
          onPress={() => setMessages([WELCOME_MSG])}
          hitSlop={10}
          style={s.clearBtn}
          accessibilityLabel="Clear chat"
        >
          <Ionicons name="refresh-outline" size={20} color={colors.textSecondary} />
        </Pressable>
      </View>

      {/* Messages */}
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={s.messageList}
          onLayout={scrollToBottom}
          ListFooterComponent={
            <>
              {showPrompts && (
                <View style={s.promptsContainer}>
                  <Text style={[s.promptsLabel, { color: colors.textSecondary }]}>
                    Try asking:
                  </Text>
                  <View style={s.promptsRow}>
                    {SUGGESTED_PROMPTS.map((p) => (
                      <Pressable
                        key={p}
                        style={[s.promptChip, { borderColor: colors.tint + "33", backgroundColor: colors.tint + "0D" }]}
                        onPress={() => sendMessage(p)}
                      >
                        <Text style={[s.promptChipText, { color: colors.tint }]}>{p}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}
              {sending && (
                <View style={[styles.bubbleRow, styles.bubbleRowAssistant]}>
                  <View style={[styles.avatar, { backgroundColor: colors.tint + "1A" }]}>
                    <Ionicons name="sparkles" size={12} color={colors.tint} />
                  </View>
                  <View style={[styles.bubble, styles.bubbleAssistant, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                    <ActivityIndicator size="small" color={colors.tint} />
                  </View>
                </View>
              )}
            </>
          }
        />

        {/* Input bar */}
        <View style={[s.inputBar, { borderTopColor: colors.border, backgroundColor: colors.backgroundSolid, paddingBottom: insets.bottom + 8 }]}>
          <TextInput
            style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceSecondary }]}
            value={input}
            onChangeText={setInput}
            placeholder="Ask me anything…"
            placeholderTextColor={colors.textSecondary}
            multiline
            maxLength={800}
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={handleSend}
            editable={!sending}
          />
          <Pressable
            style={[s.sendBtn, { backgroundColor: colors.tint, opacity: (!input.trim() || sending) ? 0.45 : 1 }]}
            onPress={handleSend}
            disabled={!input.trim() || sending}
            accessibilityLabel="Send message"
          >
            <Ionicons name="send" size={16} color="#fff" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  bubbleRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginVertical: 4,
    paddingHorizontal: Spacing.md,
    gap: 8,
  },
  bubbleRowUser: {
    justifyContent: "flex-end",
  },
  bubbleRowAssistant: {
    justifyContent: "flex-start",
  },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginBottom: 2,
  },
  bubbleGroup: {
    gap: 6,
    maxWidth: "80%",
  },
  bubbleGroupUser: {
    alignItems: "flex-end",
  },
  bubbleGroupAssistant: {
    alignItems: "flex-start",
  },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.lg,
  },
  bubbleUser: {
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    borderBottomLeftRadius: 4,
    borderWidth: 1,
  },
  bubbleError: {
    backgroundColor: "#fed7d7",
  },
  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
  },
  draftBox: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: 10,
    gap: 4,
  },
  draftHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  draftLabel: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  draftText: {
    fontSize: 13,
    lineHeight: 19,
  },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: Radius.sm,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  copyBtnText: {
    fontSize: 11,
    fontWeight: "500",
  },
});

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.backgroundSolid ?? colors.background,
    },
    flex: {
      flex: 1,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: 10,
    },
    backBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    headerCenter: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    headerIcon: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: {
      fontSize: Typography.bodyMedium.fontSize,
      fontWeight: "600",
    },
    headerSubtitle: {
      fontSize: Typography.tiny.fontSize,
    },
    clearBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    messageList: {
      paddingVertical: Spacing.sm,
      paddingBottom: Spacing.xl,
    },
    promptsContainer: {
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.md,
      gap: 8,
    },
    promptsLabel: {
      fontSize: Typography.tiny.fontSize,
      marginBottom: 4,
    },
    promptsRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    promptChip: {
      borderWidth: 1,
      borderRadius: Radius.full,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    promptChipText: {
      fontSize: Typography.tiny.fontSize,
      fontWeight: "500",
    },
    inputBar: {
      flexDirection: "row",
      alignItems: "flex-end",
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: 8,
    },
    input: {
      flex: 1,
      borderWidth: 1,
      borderRadius: Radius.lg,
      paddingHorizontal: 14,
      paddingVertical: Platform.OS === "ios" ? 10 : 8,
      fontSize: Typography.caption.fontSize,
      maxHeight: 120,
      minHeight: 42,
    },
    sendBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
  });
}
