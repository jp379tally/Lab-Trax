import React, { useState, useRef, useEffect } from "react";
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
  Alert,
  Modal,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { resilientFetch } from "@/lib/query-client";

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface PinnedCase {
  caseId: string;
  caseNumber: string;
  patientName: string;
}

interface CaseSearchResult {
  id: string;
  caseNumber: string;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  doctorName?: string | null;
  status?: string | null;
}

const LAB_SUGGESTED_PROMPTS = [
  "What cases are due this week?",
  "What's our average turnaround time?",
  "What's Dr. Smith's price for zirconia?",
  "Show me all rush cases",
];

const PROVIDER_SUGGESTED_PROMPTS = [
  "Which cases are overdue?",
  "How many active cases do I have?",
  "Are any of my cases rush priority?",
  "What's the status of my recent cases?",
];

function generateId() {
  return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

function buildCasePrompts(pinnedCases: PinnedCase[]): string[] {
  if (pinnedCases.length === 1) {
    const c = pinnedCases[0]!;
    return [
      `Summarize case ${c.caseNumber}`,
      c.patientName
        ? `What restorations are on ${c.patientName}'s case?`
        : `What restorations are on case ${c.caseNumber}?`,
      `When is case ${c.caseNumber} due?`,
      `What materials are on case ${c.caseNumber}?`,
    ];
  }
  if (pinnedCases.length > 1) {
    const nums = pinnedCases.map((c) => c.caseNumber).join(", ");
    return [
      `Compare the status of these cases: ${nums}`,
      "Which of these cases is most urgent?",
      "Summarize all pinned cases",
      "What are the due dates for these cases?",
    ];
  }
  return [];
}

function buildProviderCasePrompts(caseNumber: string, patientName: string): string[] {
  return [
    `When will this case be ready?`,
    patientName ? `What restorations are on ${patientName}'s case?` : `What restorations are on case ${caseNumber}?`,
    `Which lab is handling case ${caseNumber}?`,
    `What is the current status of case ${caseNumber}?`,
  ];
}

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const { userType } = useAuth();
  const isProvider = userType === "provider";
  const params = useLocalSearchParams<{ caseId?: string; caseNumber?: string; patientName?: string }>();

  // Build initial pinned case from route params
  const initialPinnedCases: PinnedCase[] = [];
  if (params.caseId && params.caseNumber) {
    initialPinnedCases.push({
      caseId: params.caseId,
      caseNumber: params.caseNumber,
      patientName: params.patientName || "",
    });
  }

  const [pinnedCases, setPinnedCases] = useState<PinnedCase[]>(initialPinnedCases);
  const hasCaseContext = pinnedCases.length > 0;

  function buildWelcomeContent(cases: PinnedCase[]): string {
    if (cases.length === 0) {
      return isProvider
        ? "Hi! I'm LabTrax's AI assistant. I can look up your cases across all your linked labs and answer pricing questions. How can I help?"
        : "Hi! I'm LabTrax's AI assistant. I can help you with case status, pricing, turnaround times, and lab info. How can I help?";
    }
    if (cases.length === 1) {
      const c = cases[0]!;
      return `Hi! I'm LabTrax's AI assistant. I'm ready to help you with case ${c.caseNumber}${c.patientName ? ` (${c.patientName})` : ""}. What would you like to know?`;
    }
    const nums = cases.map((c) => c.caseNumber).join(", ");
    return `Hi! I'm LabTrax's AI assistant. I have ${cases.length} cases pinned: ${nums}. Ask me anything about these cases or your lab.`;
  }

  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: "welcome",
      role: "assistant",
      content: buildWelcomeContent(initialPinnedCases),
      timestamp: Date.now(),
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [promptsDismissed, setPromptsDismissed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  // Case picker modal state
  const [pickerVisible, setPickerVisible] = useState(false);
  const [caseSearchQuery, setCaseSearchQuery] = useState("");
  const [caseSearchResults, setCaseSearchResults] = useState<CaseSearchResult[]>([]);
  const [caseSearchLoading, setCaseSearchLoading] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The user's lab org ID for case quick-search (fetched from /api/auth/me)
  const [labOrganizationId, setLabOrganizationId] = useState<string | null>(null);

  useEffect(() => {
    if (isProvider) return;
    resilientFetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.practiceOrganizationId) setLabOrganizationId(data.practiceOrganizationId);
      })
      .catch(() => {});
  }, [isProvider]);

  const suggestedPrompts = hasCaseContext
    ? buildCasePrompts(pinnedCases)
    : isProvider
    ? PROVIDER_SUGGESTED_PROMPTS
    : LAB_SUGGESTED_PROMPTS;

  const showPrompts = !promptsDismissed && messages.length === 1;

  // Load chat history on mount (only when no initial case context)
  useEffect(() => {
    if (initialPinnedCases.length > 0) return;
    let cancelled = false;
    async function loadHistory() {
      try {
        const response = await resilientFetch("/api/ai-chat/history");
        if (response.ok) {
          const data = await response.json();
          const historyMsgs: ChatMsg[] = (data.messages ?? []).map((m: any) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: m.createdAt ? new Date(m.createdAt).getTime() : Date.now(),
          }));
          if (!cancelled && historyMsgs.length > 0) {
            setMessages((prev) => {
              const welcomeMsg = prev.find((m) => m.id === "welcome");
              return welcomeMsg ? [welcomeMsg, ...historyMsgs] : historyMsgs;
            });
            setPromptsDismissed(true);
          }
        }
      } catch {
        // silently ignore — history is a best-effort enhancement
      }
    }
    loadHistory();
    return () => { cancelled = true; };
  }, []);

  // Debounced case search
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!caseSearchQuery.trim() || caseSearchQuery.trim().length < 2) {
      setCaseSearchResults([]);
      setCaseSearchLoading(false);
      return;
    }
    if (!labOrganizationId) return;
    setCaseSearchLoading(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const resp = await resilientFetch(
          `/api/cases/quick-search?labOrganizationId=${encodeURIComponent(labOrganizationId)}&q=${encodeURIComponent(caseSearchQuery.trim())}`,
        );
        if (resp.ok) {
          const data = await resp.json();
          setCaseSearchResults(data.cases ?? []);
        }
      } catch {
        setCaseSearchResults([]);
      } finally {
        setCaseSearchLoading(false);
      }
    }, 300);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [caseSearchQuery, labOrganizationId]);

  function pinCase(result: CaseSearchResult) {
    const alreadyPinned = pinnedCases.some((c) => c.caseId === result.id);
    if (alreadyPinned) return;
    const patientName = [result.patientFirstName, result.patientLastName]
      .filter(Boolean)
      .join(" ");
    const updated = [...pinnedCases, { caseId: result.id, caseNumber: result.caseNumber, patientName }];
    setPinnedCases(updated);
    setMessages((prev) => {
      if (prev.length === 1 && prev[0]!.id === "welcome") {
        return [{ id: "welcome", role: "assistant", content: buildWelcomeContent(updated), timestamp: Date.now() }];
      }
      return prev;
    });
    setPickerVisible(false);
    setCaseSearchQuery("");
    setCaseSearchResults([]);
  }

  function unpinCase(caseId: string) {
    const updated = pinnedCases.filter((c) => c.caseId !== caseId);
    setPinnedCases(updated);
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

      const body: Record<string, unknown> = { messages: apiMessages };
      if (pinnedCases.length === 1) {
        body.caseId = pinnedCases[0]!.caseId;
      } else if (pinnedCases.length > 1) {
        body.caseIds = pinnedCases.map((c) => c.caseId);
      }

      const response = await resilientFetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      } else if (response.status === 429) {
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: "assistant",
            content: "Please slow down — try again in a moment.",
            timestamp: Date.now(),
          },
        ]);
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

  function handleClearHistory() {
    Alert.alert(
      "Clear History",
      "This will permanently delete your AI chat history. Are you sure?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            setClearing(true);
            try {
              const resp = await resilientFetch("/api/ai-chat/history", { method: "DELETE" });
              if (resp.ok) {
                setMessages([
                  {
                    id: "welcome",
                    role: "assistant",
                    content: buildWelcomeContent(pinnedCases),
                    timestamp: Date.now(),
                  },
                ]);
                setPromptsDismissed(false);
              } else {
                Alert.alert("Error", "Failed to clear history. Please try again.");
              }
            } catch {
              Alert.alert("Error", "Failed to clear history. Please try again.");
            } finally {
              setClearing(false);
            }
          },
        },
      ],
    );
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

  const hasHistory = messages.some((m) => m.id !== "welcome");

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
          <View>
            <Text style={styles.headerTitle}>AI Assistant</Text>
            {pinnedCases.length === 1 && (
              <Text style={styles.headerSubtitle}>
                Case {pinnedCases[0]!.caseNumber}
                {pinnedCases[0]!.patientName ? ` · ${pinnedCases[0]!.patientName}` : ""}
              </Text>
            )}
            {pinnedCases.length > 1 && (
              <Text style={styles.headerSubtitle}>{pinnedCases.length} cases pinned</Text>
            )}
          </View>
        </View>
        <View style={styles.headerActions}>
          {labOrganizationId && (
            <Pressable
              onPress={() => setPickerVisible(true)}
              hitSlop={12}
              style={({ pressed }) => [{ opacity: pressed ? 0.5 : 1 }]}
            >
              <Ionicons name="add-circle-outline" size={22} color={Colors.light.tint} />
            </Pressable>
          )}
          {hasHistory ? (
            <Pressable
              onPress={handleClearHistory}
              disabled={clearing}
              hitSlop={12}
              style={({ pressed }) => [{ opacity: pressed || clearing ? 0.5 : 1 }]}
            >
              <Ionicons name="trash-outline" size={20} color={Colors.light.textSecondary} />
            </Pressable>
          ) : (
            <View style={{ width: 20 }} />
          )}
        </View>
      </View>

      {/* Pinned case chips */}
      {pinnedCases.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipsRow}
          contentContainerStyle={styles.chipsContent}
        >
          {pinnedCases.map((c) => (
            <View key={c.caseId} style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1}>
                {c.caseNumber}
                {c.patientName ? ` · ${c.patientName}` : ""}
              </Text>
              <Pressable
                onPress={() => unpinCase(c.caseId)}
                hitSlop={8}
                style={({ pressed }) => [styles.chipRemove, { opacity: pressed ? 0.5 : 1 }]}
              >
                <Ionicons name="close" size={12} color={Colors.light.tint} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

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
            showPrompts && suggestedPrompts.length > 0 ? (
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
            placeholder={
              pinnedCases.length === 1
                ? `Ask about case ${pinnedCases[0]!.caseNumber}…`
                : pinnedCases.length > 1
                ? `Ask about these ${pinnedCases.length} cases…`
                : isProvider
                ? "Ask about a case or pricing…"
                : "Ask about a case, pricing, or lab…"
            }
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

      {/* Case picker modal */}
      <Modal
        visible={pickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setPickerVisible(false);
          setCaseSearchQuery("");
          setCaseSearchResults([]);
        }}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => {
            setPickerVisible(false);
            setCaseSearchQuery("");
            setCaseSearchResults([]);
          }}
        >
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pin a Case</Text>
              <Pressable
                onPress={() => {
                  setPickerVisible(false);
                  setCaseSearchQuery("");
                  setCaseSearchResults([]);
                }}
                hitSlop={12}
              >
                <Ionicons name="close" size={22} color={Colors.light.text} />
              </Pressable>
            </View>
            <View style={styles.modalSearchBar}>
              <Ionicons name="search" size={16} color={Colors.light.textSecondary} />
              <TextInput
                style={styles.modalSearchInput}
                value={caseSearchQuery}
                onChangeText={setCaseSearchQuery}
                placeholder="Search by case # or patient name…"
                placeholderTextColor={Colors.light.textTertiary}
                autoFocus
                returnKeyType="search"
              />
              {caseSearchLoading && (
                <ActivityIndicator size="small" color={Colors.light.tint} />
              )}
            </View>
            <ScrollView style={styles.modalResults} keyboardShouldPersistTaps="handled">
              {caseSearchQuery.trim().length < 2 ? (
                <Text style={styles.modalHint}>Type at least 2 characters to search</Text>
              ) : caseSearchResults.length === 0 && !caseSearchLoading ? (
                <Text style={styles.modalHint}>No cases found</Text>
              ) : (
                caseSearchResults.map((result) => {
                  const alreadyPinned = pinnedCases.some((c) => c.caseId === result.id);
                  const patientName = [result.patientFirstName, result.patientLastName]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <Pressable
                      key={result.id}
                      onPress={() => pinCase(result)}
                      disabled={alreadyPinned}
                      style={({ pressed }) => [
                        styles.modalResultItem,
                        alreadyPinned && styles.modalResultItemDisabled,
                        pressed && !alreadyPinned && { opacity: 0.7 },
                      ]}
                    >
                      <View style={styles.modalResultInfo}>
                        <Text style={styles.modalResultCaseNum}>
                          {result.caseNumber}
                          {alreadyPinned && (
                            <Text style={styles.modalResultPinnedLabel}> (pinned)</Text>
                          )}
                        </Text>
                        {patientName ? (
                          <Text style={styles.modalResultPatient}>{patientName}</Text>
                        ) : null}
                        {result.status ? (
                          <Text style={styles.modalResultStatus}>{result.status}</Text>
                        ) : null}
                      </View>
                      {!alreadyPinned && (
                        <Ionicons name="add-circle" size={22} color={Colors.light.tint} />
                      )}
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
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
    flex: 1,
    marginHorizontal: 8,
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
  headerSubtitle: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: Colors.light.tint,
    marginTop: 1,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  chipsRow: {
    backgroundColor: Colors.light.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
    maxHeight: 44,
  },
  chipsContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    flexDirection: "row",
    alignItems: "center",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.light.tintLight,
    borderRadius: 20,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: Colors.light.tint + "33",
    gap: 4,
    maxWidth: 200,
  },
  chipText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.light.tint,
    flexShrink: 1,
  },
  chipRemove: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: Colors.light.tint + "22",
    justifyContent: "center",
    alignItems: "center",
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
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: Colors.light.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "75%",
    paddingBottom: 24,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
  },
  modalSearchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: Colors.light.surfaceSecondary,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  modalSearchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
  },
  modalResults: {
    maxHeight: 360,
  },
  modalHint: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
    textAlign: "center",
    paddingVertical: 24,
    paddingHorizontal: 20,
  },
  modalResultItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
  },
  modalResultItemDisabled: {
    opacity: 0.5,
  },
  modalResultInfo: {
    flex: 1,
    gap: 2,
  },
  modalResultCaseNum: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  modalResultPinnedLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
  },
  modalResultPatient: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
  },
  modalResultStatus: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textTertiary,
    textTransform: "capitalize",
  },
});
