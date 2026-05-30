import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
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
import AsyncStorage from "@react-native-async-storage/async-storage";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
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

interface StoredSession {
  id: string;
  key: string;
  pinnedCases: PinnedCase[];
  messages: ChatMsg[];
  createdAt: number;
  lastActive: number;
}

const STORAGE_KEY = "labtrax_chat_sessions_v1";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_KEY = 10;

async function readStoredSessions(): Promise<StoredSession[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const now = Date.now();
    return (parsed.sessions ?? []).filter(
      (s: StoredSession) => now - s.lastActive < SESSION_TTL_MS,
    );
  } catch {
    return [];
  }
}

async function writeStoredSessions(sessions: StoredSession[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions }));
  } catch {
    // ignore — storage errors are non-fatal
  }
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
    patientName
      ? `What restorations are on ${patientName}'s case?`
      : `What restorations are on case ${caseNumber}?`,
    `Which lab is handling case ${caseNumber}?`,
    `What is the current status of case ${caseNumber}?`,
  ];
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function getSessionPreview(session: StoredSession): string {
  const first = session.messages.find((m) => m.role === "user");
  if (!first) {
    if (session.pinnedCases.length > 0) {
      return `Cases: ${session.pinnedCases.map((c) => c.caseNumber).join(", ")}`;
    }
    return "Empty session";
  }
  return first.content.length > 55
    ? first.content.slice(0, 52) + "…"
    : first.content;
}

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { userType } = useAuth();
  const isProvider = userType === "provider";
  const params = useLocalSearchParams<{
    caseId?: string;
    caseNumber?: string;
    patientName?: string;
  }>();

  // Build initial pinned case from route params
  const initialPinnedCases: PinnedCase[] = [];
  if (params.caseId && params.caseNumber) {
    initialPinnedCases.push({
      caseId: params.caseId,
      caseNumber: params.caseNumber,
      patientName: params.patientName || "",
    });
  }

  // sessionKey is stable for the lifetime of this screen instance
  const sessionKey =
    initialPinnedCases.length > 0
      ? [...initialPinnedCases]
          .map((c) => c.caseId)
          .sort()
          .join("_")
      : "general";

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

  const [allSessions, setAllSessions] = useState<StoredSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showSessionsModal, setShowSessionsModal] = useState(false);

  // Case picker modal state
  const [pickerVisible, setPickerVisible] = useState(false);
  const [caseSearchQuery, setCaseSearchQuery] = useState("");
  const [caseSearchResults, setCaseSearchResults] = useState<CaseSearchResult[]>([]);
  const [caseSearchLoading, setCaseSearchLoading] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The user's lab org ID for case quick-search
  const [labOrganizationId, setLabOrganizationId] = useState<string | null>(null);

  const currentSessionIdRef = useRef<string | null>(null);
  const flatListRef = useRef<FlatList>(null);

  const sessionsForKey = allSessions
    .filter((s) => s.key === sessionKey)
    .sort((a, b) => b.lastActive - a.lastActive);

  const suggestedPrompts = hasCaseContext
    ? buildCasePrompts(pinnedCases)
    : isProvider
    ? PROVIDER_SUGGESTED_PROMPTS
    : LAB_SUGGESTED_PROMPTS;

  const showPrompts = !promptsDismissed && messages.length === 1;
  const hasHistory = messages.some((m) => m.id !== "welcome");

  // Fetch lab org ID for case search (lab users only)
  useEffect(() => {
    if (isProvider) return;
    resilientFetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.practiceOrganizationId) setLabOrganizationId(data.practiceOrganizationId);
      })
      .catch(() => {});
  }, [isProvider]);

  // Uses the functional-update form of setAllSessions so it always reads the
  // latest state — safe even if called before the initial load resolves.
  const persistSession = useCallback(
    async (msgs: ChatMsg[], sessionId: string, currentPinnedCases: PinnedCase[]) => {
      const userMsgs = msgs.filter((m) => m.id !== "welcome");
      if (userMsgs.length === 0) return;

      const now = Date.now();
      let persisted: StoredSession[] = [];

      setAllSessions((prev) => {
        const existing = prev.find((s) => s.id === sessionId);
        let updated: StoredSession[];
        if (existing) {
          updated = prev.map((s) =>
            s.id === sessionId
              ? { ...s, messages: userMsgs, lastActive: now }
              : s,
          );
        } else {
          const newSession: StoredSession = {
            id: sessionId,
            key: sessionKey,
            pinnedCases: currentPinnedCases,
            messages: userMsgs,
            createdAt: now,
            lastActive: now,
          };
          const keyedSessions = prev.filter((s) => s.key === sessionKey);
          const otherSessions = prev.filter((s) => s.key !== sessionKey);
          const trimmed = [newSession, ...keyedSessions].slice(0, MAX_SESSIONS_PER_KEY);
          updated = [...otherSessions, ...trimmed];
        }
        persisted = updated;
        return updated;
      });

      // Write outside the updater to avoid async inside setState
      await writeStoredSessions(persisted);
    },
    [sessionKey],
  );

  // Load sessions from storage on mount
  useEffect(() => {
    let cancelled = false;
    async function init() {
      const sessions = await readStoredSessions();
      if (cancelled) return;
      setAllSessions(sessions);
      const forKey = sessions
        .filter((s) => s.key === sessionKey)
        .sort((a, b) => b.lastActive - a.lastActive);
      if (forKey.length > 0) {
        const latest = forKey[0]!;
        setCurrentSessionId(latest.id);
        currentSessionIdRef.current = latest.id;
        const cases = latest.pinnedCases.length > 0 ? latest.pinnedCases : initialPinnedCases;
        setPinnedCases(cases);
        setMessages([
          {
            id: "welcome",
            role: "assistant",
            content: buildWelcomeContent(cases),
            timestamp: Date.now(),
          },
          ...latest.messages,
        ]);
        setPromptsDismissed(latest.messages.some((m) => m.role === "user"));
      }
    }
    init();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const updated = [
      ...pinnedCases,
      { caseId: result.id, caseNumber: result.caseNumber, patientName },
    ];
    setPinnedCases(updated);
    setMessages((prev) => {
      if (prev.length === 1 && prev[0]!.id === "welcome") {
        return [
          {
            id: "welcome",
            role: "assistant",
            content: buildWelcomeContent(updated),
            timestamp: Date.now(),
          },
        ];
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

  function startNewChat() {
    const newId = generateId();
    setCurrentSessionId(newId);
    currentSessionIdRef.current = newId;
    setPinnedCases(initialPinnedCases);
    setMessages([
      {
        id: "welcome",
        role: "assistant",
        content: buildWelcomeContent(initialPinnedCases),
        timestamp: Date.now(),
      },
    ]);
    setPromptsDismissed(false);
    setInput("");
  }

  function loadSession(session: StoredSession) {
    const cases = session.pinnedCases.length > 0 ? session.pinnedCases : initialPinnedCases;
    setCurrentSessionId(session.id);
    currentSessionIdRef.current = session.id;
    setPinnedCases(cases);
    setMessages([
      {
        id: "welcome",
        role: "assistant",
        content: buildWelcomeContent(cases),
        timestamp: Date.now(),
      },
      ...session.messages,
    ]);
    setPromptsDismissed(session.messages.some((m) => m.role === "user"));
    setShowSessionsModal(false);
  }

  async function sendMessage(text: string) {
    if (!text.trim() || sending) return;
    setPromptsDismissed(true);

    let sessionId = currentSessionIdRef.current;
    if (!sessionId) {
      sessionId = generateId();
      setCurrentSessionId(sessionId);
      currentSessionIdRef.current = sessionId;
    }

    const snapshotPinnedCases = pinnedCases;

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
      if (snapshotPinnedCases.length === 1) {
        body.caseId = snapshotPinnedCases[0]!.caseId;
      } else if (snapshotPinnedCases.length > 1) {
        body.caseIds = snapshotPinnedCases.map((c) => c.caseId);
      }

      const response = await resilientFetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      let assistantContent = "Sorry, I'm having trouble connecting right now. Please try again.";
      if (response.ok) {
        const data = await response.json();
        assistantContent = data.reply || "I couldn't process that request.";
      } else if (response.status === 429) {
        assistantContent = "Please slow down — try again in a moment.";
      } else if (response.status === 503) {
        assistantContent =
          "AI assistant is not configured on this server. Please contact your administrator.";
      }

      const assistantMsg: ChatMsg = {
        id: generateId(),
        role: "assistant",
        content: assistantContent,
        timestamp: Date.now(),
      };
      const finalMessages = [...nextMessages, assistantMsg];
      setMessages(finalMessages);
      persistSession(finalMessages, sessionId, snapshotPinnedCases);
    } catch {
      const errMsg: ChatMsg = {
        id: generateId(),
        role: "assistant",
        content: "Connection error. Please check your network and try again.",
        timestamp: Date.now(),
      };
      const finalMessages = [...nextMessages, errMsg];
      setMessages(finalMessages);
      persistSession(finalMessages, sessionId, snapshotPinnedCases);
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

  function handleDeleteSession(sessionId: string) {
    Alert.alert(
      "Delete Session",
      "Remove this conversation from history?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            const updated = allSessions.filter((s) => s.id !== sessionId);
            setAllSessions(updated);
            await writeStoredSessions(updated);
            if (sessionId === currentSessionIdRef.current) {
              startNewChat();
            }
          },
        },
      ],
    );
  }

  function renderMessage({ item }: { item: ChatMsg }) {
    const isUser = item.role === "user";
    return (
      <View
        style={[
          styles.messageBubbleWrap,
          isUser ? styles.userWrap : styles.assistantWrap,
        ]}
      >
        {!isUser && (
          <View style={styles.aiAvatar}>
            <Ionicons name="sparkles" size={14} color={colors.tint} />
          </View>
        )}
        <View
          style={[
            styles.messageBubble,
            isUser ? styles.userBubble : styles.assistantBubble,
          ]}
        >
          <Text style={[styles.messageText, isUser && styles.userText]}>
            {item.content}
          </Text>
        </View>
      </View>
    );
  }

  function renderSessionItem({ item }: { item: StoredSession }) {
    const isActive = item.id === currentSessionId;
    return (
      <Pressable
        onPress={() => loadSession(item)}
        style={({ pressed }) => [
          styles.sessionItem,
          isActive && styles.sessionItemActive,
          pressed && { opacity: 0.7 },
        ]}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.sessionPreview} numberOfLines={2}>
            {getSessionPreview(item)}
          </Text>
          <Text style={styles.sessionTime}>
            {formatRelativeTime(item.lastActive)} ·{" "}
            {item.messages.filter((m) => m.role === "user").length} message
            {item.messages.filter((m) => m.role === "user").length !== 1 ? "s" : ""}
          </Text>
        </View>
        <Pressable
          onPress={() => handleDeleteSession(item.id)}
          hitSlop={12}
          style={({ pressed }) => [{ opacity: pressed ? 0.5 : 1, padding: 4 }]}
        >
          <Ionicons name="trash-outline" size={16} color={colors.textTertiary} />
        </Pressable>
      </Pressable>
    );
  }

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.header,
          { paddingTop: Platform.OS === "web" ? 67 + 12 : insets.top + 12 },
        ]}
      >
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <View style={styles.headerCenter}>
          <View style={styles.headerIcon}>
            <Ionicons name="sparkles" size={16} color={colors.tint} />
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
              <Ionicons name="add-circle-outline" size={22} color={colors.tint} />
            </Pressable>
          )}
          {sessionsForKey.length > 0 && (
            <Pressable
              onPress={() => setShowSessionsModal(true)}
              hitSlop={12}
              style={({ pressed }) => [{ opacity: pressed ? 0.5 : 1 }]}
            >
              <Ionicons name="time-outline" size={20} color={colors.textSecondary} />
            </Pressable>
          )}
          <Pressable
            onPress={startNewChat}
            hitSlop={12}
            style={({ pressed }) => [{ opacity: pressed ? 0.5 : 1 }]}
          >
            <Ionicons
              name="create-outline"
              size={20}
              color={hasHistory ? colors.tint : colors.textSecondary}
            />
          </Pressable>
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
                <Ionicons name="close" size={12} color={colors.tint} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Past sessions modal */}
      <Modal
        visible={showSessionsModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowSessionsModal(false)}
      >
        <View style={[styles.sessionsModalContainer, { paddingTop: insets.top + 16 }]}>
          <View style={styles.sessionsModalHeader}>
            <Text style={styles.sessionsModalTitle}>Past Conversations</Text>
            <Pressable onPress={() => setShowSessionsModal(false)} hitSlop={12}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>
          {pinnedCases.length > 0 && (
            <Text style={styles.sessionsModalSubtitle}>
              {pinnedCases.length === 1
                ? `Case ${pinnedCases[0]!.caseNumber}`
                : `${pinnedCases.length} cases pinned`}
            </Text>
          )}
          <FlatList
            data={sessionsForKey}
            keyExtractor={(s) => s.id}
            renderItem={renderSessionItem}
            contentContainerStyle={styles.sessionsList}
            ItemSeparatorComponent={() => <View style={styles.sessionSeparator} />}
            ListEmptyComponent={
              <Text style={styles.emptyText}>No past conversations</Text>
            }
          />
          <View style={[styles.newChatFooter, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <Pressable
              onPress={() => {
                setShowSessionsModal(false);
                startNewChat();
              }}
              style={({ pressed }) => [styles.newChatBtn, pressed && { opacity: 0.8 }]}
            >
              <Ionicons name="create-outline" size={16} color={colors.textInverse} />
              <Text style={styles.newChatBtnText}>New Chat</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

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
                      style={({ pressed }) => [
                        styles.promptChip,
                        pressed && { opacity: 0.7 },
                      ]}
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
            <ActivityIndicator size="small" color={colors.tint} />
            <Text style={styles.typingText}>AI is thinking…</Text>
          </View>
        )}

        <View
          style={[
            styles.inputBar,
            {
              paddingBottom:
                Platform.OS === "web" ? 34 + 8 : Math.max(insets.bottom, 8) + 8,
            },
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
            placeholderTextColor={colors.textTertiary}
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
              color={!input.trim() || sending ? colors.textTertiary : colors.textInverse}
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
                <Ionicons name="close" size={22} color={colors.text} />
              </Pressable>
            </View>
            <View style={styles.modalSearchBar}>
              <Ionicons name="search" size={16} color={colors.textSecondary} />
              <TextInput
                style={styles.modalSearchInput}
                value={caseSearchQuery}
                onChangeText={setCaseSearchQuery}
                placeholder="Search by case # or patient name…"
                placeholderTextColor={colors.textTertiary}
                autoFocus
                returnKeyType="search"
              />
              {caseSearchLoading && (
                <ActivityIndicator size="small" color={colors.tint} />
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
                        <Ionicons name="add-circle" size={22} color={colors.tint} />
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

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    backgroundColor: colors.surface,
  },
  headerCenter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    marginHorizontal: 8,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.tintLight,
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: colors.text,
  },
  headerSubtitle: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: colors.tint,
    marginTop: 1,
  },
  chipsRow: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
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
    backgroundColor: colors.tintLight,
    borderRadius: 20,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.tint + "33",
    gap: 4,
    maxWidth: 200,
  },
  chipText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: colors.tint,
    flexShrink: 1,
  },
  chipRemove: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.tint + "22",
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
    backgroundColor: colors.tintLight,
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
    backgroundColor: colors.tint,
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: colors.surfaceSecondary,
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.text,
    lineHeight: 21,
  },
  userText: {
    color: colors.textInverse,
  },
  promptsContainer: {
    paddingVertical: 12,
    gap: 8,
  },
  promptsLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: colors.textSecondary,
    paddingHorizontal: 4,
    marginBottom: 4,
  },
  promptsScroll: {
    gap: 8,
    paddingBottom: 4,
  },
  promptChip: {
    backgroundColor: colors.tintLight,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.tint + "33",
  },
  promptChipText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.tint,
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
    color: colors.textSecondary,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    backgroundColor: colors.surface,
    gap: 8,
  },
  textInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.tint,
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnDisabled: {
    backgroundColor: colors.surfaceSecondary,
  },
  // Sessions modal (full-screen page sheet)
  sessionsModalContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  sessionsModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 4,
  },
  sessionsModalTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.text,
  },
  sessionsModalSubtitle: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.tint,
    paddingHorizontal: 20,
    marginBottom: 12,
    marginTop: 2,
  },
  sessionsList: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sessionItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: colors.surface,
    borderRadius: 12,
    gap: 12,
  },
  sessionItemActive: {
    borderWidth: 1.5,
    borderColor: colors.tint,
  },
  sessionPreview: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.text,
    lineHeight: 20,
    marginBottom: 4,
  },
  sessionTime: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.textSecondary,
  },
  sessionSeparator: {
    height: 8,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: 40,
  },
  newChatFooter: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
  },
  newChatBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.tint,
    borderRadius: 12,
    paddingVertical: 14,
  },
  newChatBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.textInverse,
  },
  // Case picker modal (bottom sheet)
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: colors.surface,
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
    color: colors.text,
  },
  modalSearchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalSearchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.text,
  },
  modalResults: {
    maxHeight: 360,
  },
  modalHint: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.textSecondary,
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
    borderBottomColor: colors.borderLight,
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
    color: colors.text,
  },
  modalResultPinnedLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.textSecondary,
  },
  modalResultPatient: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.textSecondary,
  },
  modalResultStatus: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.textTertiary,
    textTransform: "capitalize",
  },
});
