import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/lib/theme-context";
import { useAuth } from "@/lib/auth-context";
import { resilientFetch } from "@/lib/query-client";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

const SUGGESTED_PROMPTS = [
  "Show me cases due today",
  "Which invoices are overdue?",
  "What is my open balance?",
  "How many active cases this week?",
  "Which practices owe the most?",
];

let msgIdCounter = 0;
function newId() { return `msg_${++msgIdCounter}_${Date.now()}`; }

function ChatMessage({ msg, colors }: { msg: Message; colors: any }) {
  const isUser = msg.role === "user";
  return (
    <View style={{ flexDirection: isUser ? "row-reverse" : "row", marginVertical: 4, paddingHorizontal: 12, gap: 8, alignItems: "flex-end" }}>
      {!isUser && (
        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.tint + "30", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Ionicons name="sparkles" size={14} color={colors.tint} />
        </View>
      )}
      <View style={{
        maxWidth: "80%",
        backgroundColor: isUser ? colors.tint : colors.surface,
        borderRadius: 16,
        borderBottomRightRadius: isUser ? 4 : 16,
        borderBottomLeftRadius: isUser ? 16 : 4,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderWidth: isUser ? 0 : StyleSheet.hairlineWidth,
        borderColor: colors.border,
      }}>
        <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: isUser ? "#fff" : colors.text, lineHeight: 20 }}>
          {msg.content}
        </Text>
      </View>
    </View>
  );
}

export function GlobalAIFAB({ hiddenPaths = [] }: { hiddenPaths?: string[] }) {
  const { colors } = useTheme();
  const { isAuthenticated } = useAuth();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 1800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1800, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  const addMessage = useCallback((role: "user" | "assistant", content: string) => {
    setMessages((prev) => [...prev, { id: newId(), role, content, timestamp: new Date() }]);
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setInput("");
    addMessage("user", trimmed);
    setLoading(true);
    try {
      const history = messages.slice(-18).map((m) => ({ role: m.role, content: m.content }));
      const apiMessages = [...history, { role: "user" as const, content: trimmed }];
      const res = await resilientFetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });
      const body = await res.json().catch(() => ({}));
      const reply = body?.reply ?? body?.message ?? body?.content ?? "I'm having trouble connecting right now. Please try again.";
      addMessage("assistant", reply);
    } catch {
      addMessage("assistant", "Sorry, I couldn't reach the AI service. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [messages, loading, addMessage]);

  if (!isAuthenticated) return null;

  return (
    <>
      <Animated.View
        style={[
          styles.fabContainer,
          { bottom: insets.bottom + 80, transform: [{ scale: pulseAnim }] },
        ]}
        pointerEvents="box-none"
      >
        <Pressable
          onPress={() => setOpen(true)}
          style={[styles.fab, { backgroundColor: colors.tint, shadowColor: colors.tint }]}
          android_ripple={{ color: "#ffffff40", borderless: true }}
        >
          <Ionicons name="sparkles" size={22} color="#fff" />
        </Pressable>
      </Animated.View>

      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: colors.backgroundSolid }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: (Platform.OS === "ios" ? 16 : 24) + insets.top * 0.4, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface }}>
            <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: colors.tint + "20", alignItems: "center", justifyContent: "center", marginRight: 10 }}>
              <Ionicons name="sparkles" size={18} color={colors.tint} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: colors.text }}>LabTrax AI</Text>
              <Text style={{ fontSize: 11, color: colors.textTertiary, fontFamily: "Inter_400Regular" }}>Ask about cases, invoices, balances & more</Text>
            </View>
            <Pressable onPress={() => setOpen(false)} hitSlop={8}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </Pressable>
          </View>

          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={{ paddingTop: 12, paddingBottom: 12, flexGrow: 1 }}
            ListEmptyComponent={
              <View style={{ flex: 1, paddingTop: 32, paddingHorizontal: 20 }}>
                <Text style={{ fontSize: 14, color: colors.textSecondary, textAlign: "center", marginBottom: 24, fontFamily: "Inter_400Regular" }}>
                  Ask me anything about your lab data — cases, invoices, balances, production stats, and more.
                </Text>
                <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.textTertiary, marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Suggested</Text>
                {SUGGESTED_PROMPTS.map((p) => (
                  <Pressable
                    key={p}
                    onPress={() => sendMessage(p)}
                    style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.surfaceSecondary : colors.surface, marginBottom: 8 }]}
                  >
                    <Ionicons name="arrow-forward-circle-outline" size={18} color={colors.tint} />
                    <Text style={{ fontSize: 14, color: colors.text, fontFamily: "Inter_400Regular", flex: 1 }}>{p}</Text>
                  </Pressable>
                ))}
              </View>
            }
            renderItem={({ item }) => <ChatMessage msg={item} colors={colors} />}
            onContentSizeChange={() => messages.length > 0 && flatListRef.current?.scrollToEnd({ animated: false })}
          />

          {loading && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingBottom: 4 }}>
              <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.tint + "30", alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="sparkles" size={14} color={colors.tint} />
              </View>
              <View style={{ backgroundColor: colors.surface, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
                <ActivityIndicator size="small" color={colors.tint} />
              </View>
            </View>
          )}

          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, paddingBottom: insets.bottom + 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface }}>
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder="Ask about your lab data…"
                placeholderTextColor={colors.textTertiary}
                style={{ flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", color: colors.text, backgroundColor: colors.canvas, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1, borderColor: colors.border, maxHeight: 100 }}
                multiline
                onSubmitEditing={() => sendMessage(input)}
                returnKeyType="send"
              />
              <Pressable
                onPress={() => sendMessage(input)}
                disabled={!input.trim() || loading}
                style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: input.trim() ? colors.tint : colors.border, alignItems: "center", justifyContent: "center" }}
              >
                <Ionicons name="send" size={18} color={input.trim() ? "#fff" : colors.textTertiary} />
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fabContainer: {
    position: "absolute",
    right: 18,
    zIndex: 900,
  },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 8,
  },
});
