import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getToolCallLabel } from "@workspace/api-client-react";
import { useTheme, type ThemeColors } from "@/lib/theme-context";
import { Spacing, Radius, Typography } from "@/constants/tokens";
import { resilientFetch, getApiUrl, refreshAndGetAccessToken, getCsrfToken } from "@/lib/query-client";
import {
  loadChatSessions,
  saveChatSession,
  deleteChatSession,
  generateSessionId,
  type StoredChatSession,
} from "@/lib/ai-chat-session";

const AI_VOICE_MODE_KEY = "labtrax_ai_voice_mode_v1";

/** Decode the payload of a JWT (no signature check — just for reading claims). */
function getJwtUserId(token: string | null): string | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // JWT uses base64url (RFC 4648 §5): replace - → + and _ → / then add padding.
    // atob only handles standard base64, so normalization is required.
    const b64 = (parts[1]! as string)
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1]!.length / 4) * 4, "=");
    const payload = JSON.parse(atob(b64)) as { sub?: string; id?: string; userId?: string };
    return payload.sub ?? payload.id ?? payload.userId ?? null;
  } catch {
    return null;
  }
}

/**
 * Sanitize messages when loading from storage.
 * Pending/confirmed proposed actions expire server-side after 5 min, so any
 * that survived a navigation round-trip must be shown as expired.
 */
function sanitizeRestoredMessages(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.map((m) => {
    if (
      m.proposedAction &&
      (m.proposedAction.state === "pending" || m.proposedAction.state === "confirmed")
    ) {
      return {
        ...m,
        proposedAction: {
          ...m.proposedAction,
          state: "done" as const,
          error: "This action expired before it could be confirmed.",
        },
      };
    }
    return m;
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ToolOutput {
  name: string;
  result: unknown;
}

interface ProposedActionState {
  actionId: string;
  toolName: string;
  summary: string;
  /** pending → awaiting user; confirmed → executing; done → result shown; rejected */
  state: "pending" | "confirmed" | "done" | "rejected";
  resultText?: string;
  error?: string;
  /** Unix ms timestamp when the server-side action expires (5-min TTL) */
  expiresAt?: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolOutputs?: ToolOutput[];
  isError?: boolean;
  proposedAction?: ProposedActionState;
  /** Structured disclaimer text from the API for retention-related queries.
   *  Shown as an amber callout regardless of whether the model echoes it. */
  disclaimer?: string;
}

interface ApiReply {
  type: "reply" | "proposed_action";
  content?: string;
  summary?: string;
  toolName?: string;
  actionId?: string;
  toolOutputs?: ToolOutput[];
  /** Structured disclaimer text for retention-related queries. */
  disclaimer?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _msgCounter = 0;
function genId() {
  _msgCounter += 1;
  return `msg-${Date.now()}-${_msgCounter}`;
}

// ─── Session list helpers ──────────────────────────────────────────────────────

/** "Just now" / "5m ago" / "3h ago" / "2d ago" relative-time label. */
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

/** First user message (truncated) as a one-line preview of a stored session. */
function getSessionPreview(session: StoredChatSession<ChatMessage>): string {
  const first = session.messages.find((m) => m.role === "user");
  const text = first?.content ?? "";
  if (!text) return "Empty conversation";
  return text.length > 60 ? text.slice(0, 57) + "…" : text;
}

/** Count of user-authored messages in a stored session. */
function countUserMessages(session: StoredChatSession<ChatMessage>): number {
  return session.messages.filter((m) => m.role === "user").length;
}

/**
 * Fetch the server-side chat history (`GET /api/ai-chat/history`) and map it
 * into the screen's ChatMessage shape. Returns the persisted messages
 * (oldest-first, no welcome message), or `[]` when the server has nothing or
 * the request fails. Used as a fallback when no local session survives so a
 * conversation outlives the 7-day local TTL and crosses devices.
 *
 * The route replies with `{ messages }` directly (not the `{ ok, data }`
 * envelope), so the body is read as `{ messages }`.
 */
async function loadServerHistory(
  before?: string,
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  try {
    const qs = before ? `?before=${encodeURIComponent(before)}&limit=50` : "";
    const resp = await resilientFetch(`/api/ai-chat/history${qs}`);
    if (!resp.ok) return { messages: [], hasMore: false };
    const body = (await resp.json()) as {
      messages?: Array<{ id?: string; role?: string; content?: string }>;
      hasMore?: boolean;
    };
    const rows = body?.messages ?? [];
    const messages = rows
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({
        id: m.id ?? genId(),
        role: m.role as "user" | "assistant",
        content: m.content as string,
      }));
    return { messages, hasMore: !!body?.hasMore };
  } catch {
    return { messages: [], hasMore: false };
  }
}

// ─── Voice helpers ────────────────────────────────────────────────────────────

function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`{1,3}([\s\S]*?)`{1,3}/g, "$1")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^[\-\*•]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .trim()
    .slice(0, 2000);
}

/** Upload audio blob/URI to /api/ai-stt via XHR (supports native file descriptors). */
async function uploadAudioForTranscript(fileUri: string, mimeType: string): Promise<string> {
  const token = await refreshAndGetAccessToken();
  const baseUrl = getApiUrl();
  const url = new URL("api/ai-stt", baseUrl).toString();

  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (Platform.OS === "web") {
    const csrf = getCsrfToken();
    if (csrf) headers["x-csrf-token"] = csrf;
  }

  const formData = new FormData();
  if (Platform.OS === "web") {
    const blob = await globalThis.fetch(fileUri).then((r) => r.blob());
    formData.append("audio", blob, "audio.webm");
  } else {
    (formData as any).append("audio", { uri: fileUri, name: "audio.m4a", type: mimeType });
  }

  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    if (Platform.OS === "web") xhr.withCredentials = true;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { ok?: boolean; transcript?: string; error?: string };
        if (xhr.status >= 200 && xhr.status < 300 && body.transcript != null) {
          resolve(body.transcript);
        } else {
          reject(new Error(body.error || "STT failed"));
        }
      } catch {
        reject(new Error("STT parse error"));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(formData as any);
  });
}

// ─── Waveform animation ───────────────────────────────────────────────────────

/**
 * Animated 4-bar waveform for React Native. Each bar pulses its scaleY
 * with a staggered delay so the bars appear to ripple.
 */
function VoiceWaveformNative({ color }: { color: string }) {
  const anims = useRef([
    new Animated.Value(0.25),
    new Animated.Value(0.25),
    new Animated.Value(0.25),
    new Animated.Value(0.25),
  ]).current;

  useEffect(() => {
    const delays = [0, 150, 75, 225];
    const loops = anims.map((anim, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delays[i]!),
          Animated.timing(anim, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0.25, duration: 400, useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [anims]);

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, height: 18 }}>
      {anims.map((anim, i) => (
        <Animated.View
          key={i}
          style={{
            width: 3,
            height: 14,
            borderRadius: 1.5,
            backgroundColor: color,
            transform: [{ scaleY: anim }],
          }}
        />
      ))}
    </View>
  );
}

const WELCOME_MSG: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "Hi! I'm Maynard. I can help you look up cases and invoices, check due dates, draft messages, and more. What can I help you with?",
};

const SUGGESTED_PROMPTS = [
  "Cases due today",
  "What's my AR balance?",
  "Remake rate this month",
  "Draft a delay message for Dr. Smith",
];

// ─── Confirm card ─────────────────────────────────────────────────────────────

interface ConfirmCardProps {
  action: ProposedActionState;
  colors: ThemeColors;
  onConfirm: (actionId: string) => void;
  onReject: (actionId: string) => void;
  onTryAgain?: () => void;
  sending?: boolean;
}

const PENDING_TTL_MS = 5 * 60 * 1000;

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ConfirmCard({ action, colors, onConfirm, onReject, onTryAgain, sending }: ConfirmCardProps) {
  const [msLeft, setMsLeft] = useState<number>(() => {
    if (!action.expiresAt) return PENDING_TTL_MS;
    return Math.max(0, action.expiresAt - Date.now());
  });

  useEffect(() => {
    if (action.state !== "pending") return;
    const tick = () => {
      const remaining = action.expiresAt ? Math.max(0, action.expiresAt - Date.now()) : 0;
      setMsLeft(remaining);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [action.state, action.expiresAt]);

  const isExpired = action.state === "pending" && msLeft <= 0;

  if (action.state === "rejected") {
    return (
      <View
        style={[
          confirmStyles.card,
          {
            backgroundColor: colors.surfaceSecondary,
            borderColor: colors.border,
          },
        ]}
      >
        <View style={confirmStyles.row}>
          <Ionicons name="close-circle-outline" size={14} color={colors.textSecondary} />
          <Text style={[confirmStyles.statusText, { color: colors.textSecondary }]}>
            Action cancelled
          </Text>
        </View>
      </View>
    );
  }

  if (action.state === "done" && action.error) {
    return (
      <View
        style={[
          confirmStyles.card,
          { backgroundColor: "#fff5f5", borderColor: "#fed7d7" },
        ]}
      >
        <View style={[confirmStyles.row, { marginBottom: 4 }]}>
          <Ionicons name="alert-circle-outline" size={14} color="#c53030" />
          <Text style={[confirmStyles.label, { color: "#c53030" }]}>Action failed</Text>
        </View>
        <Text style={[confirmStyles.summaryText, { color: "#742a2a" }]}>{action.error}</Text>
      </View>
    );
  }

  if (action.state === "done") {
    return (
      <View
        style={[
          confirmStyles.card,
          { backgroundColor: "#f0fff4", borderColor: "#9ae6b4" },
        ]}
      >
        <View style={[confirmStyles.row, { marginBottom: 4 }]}>
          <Ionicons name="checkmark-circle-outline" size={14} color="#276749" />
          <Text style={[confirmStyles.label, { color: "#276749" }]}>Done</Text>
        </View>
        <Text style={[confirmStyles.summaryText, { color: "#22543d" }]}>
          {action.resultText ?? action.summary}
        </Text>
      </View>
    );
  }

  if (action.state === "confirmed") {
    return (
      <View
        style={[
          confirmStyles.card,
          { backgroundColor: "#fffbeb", borderColor: "#f6e05e" },
        ]}
      >
        <View style={[confirmStyles.row, { marginBottom: 4 }]}>
          <Ionicons name="flash-outline" size={14} color="#b7791f" />
          <Text style={[confirmStyles.label, { color: "#b7791f" }]}>Proposed action</Text>
        </View>
        <Text style={[confirmStyles.summaryText, { color: "#744210" }]}>{action.summary}</Text>
        <View style={[confirmStyles.row, { marginTop: 8 }]}>
          <ActivityIndicator size="small" color="#b7791f" />
          <Text style={[confirmStyles.statusText, { color: "#b7791f", marginLeft: 6 }]}>
            Executing…
          </Text>
        </View>
      </View>
    );
  }

  // expired
  if (isExpired) {
    return (
      <View
        style={[
          confirmStyles.card,
          { backgroundColor: colors.surfaceSecondary, borderColor: colors.border },
        ]}
      >
        <View style={[confirmStyles.row, { marginBottom: 4 }]}>
          <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
          <Text style={[confirmStyles.label, { color: colors.textSecondary }]}>Expired</Text>
        </View>
        <Text style={[confirmStyles.summaryText, { color: colors.textSecondary, marginBottom: onTryAgain ? 10 : 0 }]}>
          This action expired — send your request again.
        </Text>
        {onTryAgain && (
          <Pressable
            style={[confirmStyles.tryAgainBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
            onPress={onTryAgain}
            disabled={sending}
            accessibilityLabel="Try again"
          >
            <Ionicons name="refresh-outline" size={13} color={colors.text} />
            <Text style={[confirmStyles.tryAgainBtnText, { color: colors.text }]}>Try again</Text>
          </Pressable>
        )}
      </View>
    );
  }

  // pending
  return (
    <View
      style={[
        confirmStyles.card,
        { backgroundColor: "#fffbeb", borderColor: "#f6e05e" },
      ]}
    >
      <View style={[confirmStyles.row, { marginBottom: 4, justifyContent: "space-between" }]}>
        <View style={confirmStyles.row}>
          <Ionicons name="flash-outline" size={14} color="#b7791f" />
          <Text style={[confirmStyles.label, { color: "#b7791f" }]}>Proposed action</Text>
        </View>
        <View style={confirmStyles.row}>
          <Ionicons name="time-outline" size={11} color="#b7791f" />
          <Text style={[confirmStyles.countdownText, { color: "#b7791f" }]}>
            Expires in {formatCountdown(msLeft)}
          </Text>
        </View>
      </View>
      <Text style={[confirmStyles.summaryText, { color: "#744210", marginBottom: 12 }]}>
        {action.summary}
      </Text>
      <View style={confirmStyles.buttonRow}>
        <Pressable
          style={[confirmStyles.confirmBtn, { backgroundColor: colors.tint, opacity: sending ? 0.45 : 1 }]}
          onPress={() => onConfirm(action.actionId)}
          disabled={sending}
          accessibilityLabel="Confirm action"
        >
          <Ionicons name="checkmark" size={13} color="#fff" />
          <Text style={confirmStyles.confirmBtnText}>Confirm</Text>
        </Pressable>
        <Pressable
          style={[
            confirmStyles.cancelBtn,
            { borderColor: colors.border, backgroundColor: colors.surface, opacity: sending ? 0.45 : 1 },
          ]}
          onPress={() => onReject(action.actionId)}
          disabled={sending}
          accessibilityLabel="Cancel action"
        >
          <Ionicons name="close" size={13} color={colors.text} />
          <Text style={[confirmStyles.cancelBtnText, { color: colors.text }]}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const confirmStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    padding: 12,
    maxWidth: "85%",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  summaryText: {
    fontSize: 14,
    lineHeight: 20,
  },
  statusText: {
    fontSize: 12,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 8,
  },
  confirmBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.md,
  },
  confirmBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  cancelBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  cancelBtnText: {
    fontSize: 13,
    fontWeight: "500",
  },
  countdownText: {
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  tryAgainBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  tryAgainBtnText: {
    fontSize: 13,
    fontWeight: "500",
  },
});

// ─── Disclaimer parser ───────────────────────────────────────────────────────

/**
 * Splits a message into disclaimer callouts and the remaining prose.
 * Detects two independent markers:
 *   - "NOT LEGAL ADVICE" → retention legal disclaimer callout
 *   - "NOT COMPLIANCE ADVICE" → HIPAA/privacy disclaimer callout
 * Returns `null` for each callout when no matching marker is present.
 */
function parseDisclaimerContent(content: string): {
  retentionCallout: string | null;
  privacyCallout: string | null;
  rest: string;
} {
  let paragraphs = content.split(/\n\n+/);
  let retentionCallout: string | null = null;
  let privacyCallout: string | null = null;

  const retentionIdx = paragraphs.findIndex((p) => p.includes("NOT LEGAL ADVICE"));
  if (retentionIdx !== -1) {
    retentionCallout = paragraphs[retentionIdx].trim();
    paragraphs = [
      ...paragraphs.slice(0, retentionIdx),
      ...paragraphs.slice(retentionIdx + 1),
    ];
  }

  const privacyIdx = paragraphs.findIndex((p) => p.includes("NOT COMPLIANCE ADVICE"));
  if (privacyIdx !== -1) {
    privacyCallout = paragraphs[privacyIdx].trim();
    paragraphs = [
      ...paragraphs.slice(0, privacyIdx),
      ...paragraphs.slice(privacyIdx + 1),
    ];
  }

  const rest = paragraphs.join("\n\n").trim();
  return { retentionCallout, privacyCallout, rest };
}

// ─── Message bubble ───────────────────────────────────────────────────────────

interface BubbleProps {
  msg: ChatMessage;
  colors: ThemeColors;
  onConfirm: (actionId: string) => void;
  onReject: (actionId: string) => void;
  onTryAgain: (msgId: string) => void;
  sending?: boolean;
  /** True when this bubble is the active streaming one and a tool call is in flight. */
  isStreamingBubble?: boolean;
  /** Name of the in-flight tool call, used to show a friendly "what" label. */
  streamingToolCall?: string | null;
}

function MessageBubble({ msg, colors, onConfirm, onReject, onTryAgain, sending, isStreamingBubble, streamingToolCall }: BubbleProps) {
  const isUser = msg.role === "user";
  const draftTool = msg.toolOutputs?.find((t) => t.name === "draft_message")?.result as
    | { draft?: string }
    | undefined;
  const [copied, setCopied] = useState(false);

  // Determine disclaimer callouts for assistant messages.
  // For the retention disclaimer: prefer the structured field from the API (reliable,
  // model-independent). Fall back to text-scanning for old stored messages.
  // For the privacy disclaimer: use text-scanning (no structured field yet).
  let retentionCallout: string | null = null;
  let privacyCallout: string | null = null;
  let disclaimerRest: string = msg.content;
  if (!isUser) {
    if (msg.disclaimer) {
      retentionCallout = msg.disclaimer;
      const parsed = parseDisclaimerContent(msg.content);
      privacyCallout = parsed.privacyCallout;
      disclaimerRest = privacyCallout ? parsed.rest : msg.content;
    } else {
      const parsed = parseDisclaimerContent(msg.content);
      retentionCallout = parsed.retentionCallout;
      privacyCallout = parsed.privacyCallout;
      disclaimerRest = parsed.rest;
    }
  }
  const anyCallout = retentionCallout || privacyCallout;
  const bubbleContent = anyCallout ? disclaimerRest : msg.content;
  const showBubble = isUser || !anyCallout || !!disclaimerRest;

  const handleCopy = useCallback(async (text: string) => {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — silently ignore, no state change
    }
  }, []);

  if (msg.proposedAction) {
    return (
      <View style={[styles.bubbleRow, styles.bubbleRowAssistant]}>
        <View style={[styles.avatar, { backgroundColor: colors.tint + "1A" }]}>
          <Ionicons name="sparkles" size={12} color={colors.tint} />
        </View>
        <ConfirmCard
          action={msg.proposedAction}
          colors={colors}
          onConfirm={onConfirm}
          onReject={onReject}
          onTryAgain={() => onTryAgain(msg.id)}
          sending={sending}
        />
      </View>
    );
  }

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
        {retentionCallout && (
          <View style={styles.disclaimerCallout}>
            <Ionicons name="warning" size={14} color="#92400e" style={styles.disclaimerIcon} />
            <Text style={styles.disclaimerText}>
              {retentionCallout.replace(/^⚠️\s*/, "")}
            </Text>
          </View>
        )}
        {privacyCallout && (
          <View style={styles.disclaimerCallout}>
            <Ionicons name="warning" size={14} color="#92400e" style={styles.disclaimerIcon} />
            <Text style={styles.disclaimerText}>
              {privacyCallout.replace(/^⚠️\s*/, "")}
            </Text>
          </View>
        )}
        {showBubble && (
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
          {!isUser && isStreamingBubble && !bubbleContent ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
              <Text style={[styles.bubbleText, { color: colors.textSecondary }]}>
                {getToolCallLabel(streamingToolCall)}
              </Text>
            </View>
          ) : (
            <Text
              style={[
                styles.bubbleText,
                { color: isUser ? "#fff" : colors.text },
                msg.isError && { color: "#9b2c2c" },
              ]}
            >
              {bubbleContent}
            </Text>
          )}
        </View>
        )}
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

interface CaseContextInfo {
  caseNumber: string | null;
  patientName: string | null;
}

export default function AiAssistantScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);

  const { caseId } = useLocalSearchParams<{ caseId?: string }>();

  const [caseContext, setCaseContext] = useState<CaseContextInfo | null>(null);
  const caseIdRef = useRef<string | undefined>(caseId);
  caseIdRef.current = caseId;

  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MSG]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [autoExecute, setAutoExecute] = useState(false);

  // ─── Session list state ──────────────────────────────────────────────────────
  const [allSessions, setAllSessions] = useState<StoredChatSession<ChatMessage>[]>([]);
  const [showSessions, setShowSessions] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  // The active conversation id. Generated lazily on mount; a session row is only
  // written once it has at least one real (non-welcome) message.
  const currentSessionIdRef = useRef<string | null>(null);
  const [streamingToolCall, setStreamingToolCall] = useState<string | null>(null);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const messagesRef = useRef<ChatMessage[]>([WELCOME_MSG]);

  // ─── Older-history pagination ("load earlier messages") ──────────────────────
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Oldest server message id currently held — the cursor for the next page.
  const historyCursorRef = useRef<string | null>(null);

  // ─── Voice state ───────────────────────────────────────────────────────────
  type MicState = "idle" | "listening" | "processing" | "error";
  const [voiceMode, setVoiceMode] = useState(false);
  const [micState, setMicState] = useState<MicState>("idle");
  const [micErrorMsg, setMicErrorMsg] = useState<string | null>(null);
  const [micErrorKind, setMicErrorKind] = useState<"permission" | "other">("other");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const recordingIntentRef = useRef<"dictation" | "conversation">("dictation");
  const soundRef = useRef<Audio.Sound | null>(null);
  const webAudioRef = useRef<HTMLAudioElement | null>(null);
  // Ref so stopRecording (defined before sendMessage) can call it.
  const sendMessageRef = useRef<((text: string) => Promise<void>) | null>(null);
  // Tracks whether the AsyncStorage load has completed so we don't write false on mount.
  const voiceModeLoadedRef = useRef(false);
  // Tracks whether the saved chat session has finished loading so the persist
  // effect doesn't write before we've had a chance to restore.
  const sessionLoadedRef = useRef(false);
  // Tracks isSpeaking transition for auto-listen in voice mode.
  const prevIsSpeakingRef = useRef(false);

  // ─── Chat history persistence ───────────────────────────────────────────────
  // The signed-in user id, resolved on mount and used to scope the stored
  // session per user so switching accounts on one device never mixes history.
  const chatHistoryUserIdRef = useRef<string | null>(null);

  const showPrompts = messages.length === 1;

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Restore past chat sessions on mount and reopen the most recent one (or leave
  // the welcome message when there are none). History is keyed per user so
  // switching accounts on the same device never mixes one user's chats into
  // another's. A fresh session id is generated when there is nothing to resume.
  //
  // The server (`/ai-chat/history`) is the source of truth for cross-device
  // sync; the local cache is only a fast-load layer. So: show the local copy
  // instantly to avoid a blank screen, then always fetch the server copy and
  // adopt it when it holds a longer (newer) conversation than the local cache —
  // e.g. a second device or reinstall with a stale/empty cache. The local copy
  // is kept when it is ahead (an exchange just sent that has not synced yet).
  // Adopting via setMessages write-throughs to the local cache (persist effect),
  // so the cache stays a fast-load mirror of the server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let userId: string | null = null;
      try {
        const token = await refreshAndGetAccessToken();
        userId = getJwtUserId(token);
      } catch {
        // Non-fatal: fall back to the unkeyed sessions.
      }
      chatHistoryUserIdRef.current = userId;
      try {
        const stored = await loadChatSessions<ChatMessage>(userId);
        if (cancelled) return;
        setAllSessions(stored);
        const latest = stored[0];
        let localMsgs: ChatMessage[] = [];
        if (latest && latest.messages.length > 0) {
          currentSessionIdRef.current = latest.id;
          localMsgs = sanitizeRestoredMessages(latest.messages);
          // Fast-load: render the cached conversation immediately.
          setMessages([WELCOME_MSG, ...localMsgs]);
        } else {
          currentSessionIdRef.current = generateSessionId();
        }
        // Reconcile with the server so history follows the user across devices.
        const { messages: serverMsgs, hasMore } = await loadServerHistory();
        if (cancelled || serverMsgs.length === 0) return;
        historyCursorRef.current = serverMsgs[0]?.id ?? null;
        setHasMoreHistory(hasMore);
        if (serverMsgs.length > localMsgs.length) {
          setMessages([WELCOME_MSG, ...serverMsgs]);
        }
      } finally {
        if (!cancelled) sessionLoadedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the active conversation after it settles (i.e. once a reply finishes
  // or a proposed action resolves). Skipped while sending and before the initial
  // load completes; welcome-only conversations are a no-op inside saveChatSession.
  useEffect(() => {
    if (!sessionLoadedRef.current) return;
    if (sending) return;
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return;
    void saveChatSession(messages, sessionId, chatHistoryUserIdRef.current).then(
      (updated) => setAllSessions(updated),
    );
  }, [messages, sending]);

  // Fetch minimal case info when caseId is provided so we can display the context pill.
  useEffect(() => {
    if (!caseId) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await refreshAndGetAccessToken();
        const baseUrl = getApiUrl();
        const url = new URL(`api/cases/${caseId}`, baseUrl).toString();
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch(url, { headers });
        if (!res.ok || cancelled) return;
        const body = await res.json() as {
          data?: {
            caseNumber?: string | null;
            patientFirstName?: string | null;
            patientLastName?: string | null;
          };
        };
        if (cancelled) return;
        const d = body?.data;
        const pName = [d?.patientFirstName, d?.patientLastName].filter(Boolean).join(" ") || null;
        setCaseContext({
          caseNumber: d?.caseNumber ?? null,
          patientName: pName,
        });
      } catch {
        // non-fatal — context pill just won't show case details
      }
    })();
    return () => { cancelled = true; };
  }, [caseId]);

  // ─── Session actions ───────────────────────────────────────────────────────

  /** Start a fresh conversation, keeping past ones saved. */
  const startNewChat = useCallback(() => {
    currentSessionIdRef.current = generateSessionId();
    setMessages([WELCOME_MSG]);
    setInput("");
    setDeletingSessionId(null);
    setShowSessions(false);
  }, []);

  /** Reopen a stored conversation, restoring its messages. */
  const loadSession = useCallback((session: StoredChatSession<ChatMessage>) => {
    currentSessionIdRef.current = session.id;
    setMessages([WELCOME_MSG, ...sanitizeRestoredMessages(session.messages)]);
    setInput("");
    setDeletingSessionId(null);
    setShowSessions(false);
  }, []);

  /** Two-tap delete: first tap arms, second tap removes the session. */
  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      if (deletingSessionId !== sessionId) {
        setDeletingSessionId(sessionId);
        return;
      }
      setDeletingSessionId(null);
      void deleteChatSession<ChatMessage>(sessionId, chatHistoryUserIdRef.current).then(
        (remaining) => setAllSessions(remaining),
      );
      if (sessionId === currentSessionIdRef.current) {
        currentSessionIdRef.current = generateSessionId();
        setMessages([WELCOME_MSG]);
        setInput("");
      }
    },
    [deletingSessionId],
  );

  // Load voice mode preference from AsyncStorage on mount.
  useEffect(() => {
    AsyncStorage.getItem(AI_VOICE_MODE_KEY)
      .then((val) => {
        voiceModeLoadedRef.current = true;
        if (val === "true") setVoiceMode(true);
      })
      .catch(() => {
        voiceModeLoadedRef.current = true;
      });
  }, []);

  // Persist voice mode preference whenever it changes (skip writes before load completes).
  useEffect(() => {
    if (!voiceModeLoadedRef.current) return;
    AsyncStorage.setItem(AI_VOICE_MODE_KEY, voiceMode ? "true" : "false").catch(() => {});
  }, [voiceMode]);

  // Auto-listen after Maynard finishes speaking (voice mode only, idle mic only).
  useEffect(() => {
    if (prevIsSpeakingRef.current && !isSpeaking && voiceMode && !sending && micState === "idle") {
      recordingIntentRef.current = "conversation";
      startRecording();
    }
    prevIsSpeakingRef.current = isSpeaking;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpeaking, sending, micState, voiceMode]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 80);
  }, []);

  // Fetch the page of messages immediately older than those already shown and
  // prepend them, keeping the welcome message pinned at the top.
  const loadEarlierMessages = useCallback(async () => {
    if (loadingEarlier) return;
    const cursor = historyCursorRef.current;
    if (!cursor) return;
    setLoadingEarlier(true);
    try {
      const { messages: older, hasMore } = await loadServerHistory(cursor);
      setHasMoreHistory(hasMore);
      if (older.length === 0) return;
      historyCursorRef.current = older[0]?.id ?? cursor;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const dedup = older.filter((m) => !seen.has(m.id));
        if (dedup.length === 0) return prev;
        const [first, ...rest] = prev;
        if (first && first.id === WELCOME_MSG.id) {
          return [first, ...dedup, ...rest];
        }
        return [...dedup, ...prev];
      });
    } finally {
      setLoadingEarlier(false);
    }
  }, [loadingEarlier]);

  // ─── Voice helpers ─────────────────────────────────────────────────────────

  const stopSpeaking = useCallback(() => {
    if (Platform.OS === "web") {
      if (webAudioRef.current) {
        webAudioRef.current.pause();
        webAudioRef.current.src = "";
        webAudioRef.current = null;
      }
    } else {
      if (soundRef.current) {
        soundRef.current.stopAsync().catch(() => {});
        soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
    }
    setIsSpeaking(false);
  }, []);

  const speakText = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      stopSpeaking();
      const stripped = stripMarkdownForSpeech(text);
      try {
        setIsSpeaking(true);
        const res = await resilientFetch("/api/ai-tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: stripped, voice: "alloy" }),
        });
        if (!res.ok) { setIsSpeaking(false); return; }

        if (Platform.OS === "web") {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const audio = new (globalThis as any).Audio(url) as HTMLAudioElement;
          webAudioRef.current = audio;
          audio.onended = () => { URL.revokeObjectURL(url); webAudioRef.current = null; setIsSpeaking(false); };
          audio.onerror = () => { URL.revokeObjectURL(url); webAudioRef.current = null; setIsSpeaking(false); };
          await audio.play();
        } else {
          const blob = await res.blob();
          const reader = new FileReader();
          const base64 = await new Promise<string>((resolve, reject) => {
            reader.onloadend = () => {
              const result = reader.result as string;
              resolve(result.split(",")[1] ?? "");
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          const tmpUri = `${FileSystem.cacheDirectory}tts-${Date.now()}.mp3`;
          await FileSystem.writeAsStringAsync(tmpUri, base64, { encoding: FileSystem.EncodingType.Base64 });
          await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: false });
          const { sound } = await Audio.Sound.createAsync({ uri: tmpUri });
          soundRef.current = sound;
          sound.setOnPlaybackStatusUpdate((status) => {
            if (!status.isLoaded) return;
            if (status.didJustFinish) {
              sound.unloadAsync().catch(() => {});
              if (soundRef.current === sound) { soundRef.current = null; setIsSpeaking(false); }
            }
          });
          await sound.playAsync();
        }
      } catch {
        setIsSpeaking(false);
      }
    },
    [stopSpeaking],
  );

  const startRecording = useCallback(async () => {
    setMicErrorMsg(null);
    try {
      if (Platform.OS !== "web") {
        const { status } = await Audio.requestPermissionsAsync();
        if (status !== "granted") {
          setMicState("error");
          setMicErrorMsg("Microphone permission is required. Please grant access in Settings and try again.");
          return;
        }
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        const { recording } = await Audio.Recording.createAsync(
          Audio.RecordingOptionsPresets.HIGH_QUALITY,
        );
        recordingRef.current = recording;
        setMicState("listening");
      } else {
        // Web — use MediaRecorder
        const stream = await (navigator as any).mediaDevices.getUserMedia({ audio: true });
        const mr = new (globalThis as any).MediaRecorder(stream);
        const chunks: BlobPart[] = [];
        mr.ondataavailable = (e: any) => { if (e.data.size > 0) chunks.push(e.data); };
        mr.onstop = async () => {
          stream.getTracks().forEach((t: any) => t.stop());
          const blob = new Blob(chunks, { type: "audio/webm" });
          const uri = URL.createObjectURL(blob);
          setMicState("processing");
          const intent = recordingIntentRef.current;
          recordingIntentRef.current = "dictation";
          try {
            const transcript = await uploadAudioForTranscript(uri, "audio/webm");
            URL.revokeObjectURL(uri);
            if (transcript.trim()) {
              if (intent === "conversation") {
                sendMessageRef.current?.(transcript.trim());
              } else {
                setInput(transcript.trim());
              }
              setMicState("idle");
            } else {
              setMicState("idle");
            }
          } catch (err: any) {
            setMicState("error");
            setMicErrorKind("other");
            setMicErrorMsg(err?.message || "Could not transcribe audio. Please try again or type your message.");
            return;
          }
        };
        (recordingRef.current as any) = mr;
        mr.start();
        setMicState("listening");
      }
    } catch (e: any) {
      const msg = e?.message ?? "";
      if (msg.includes("Permission") || msg.includes("permission") || msg.includes("NotAllowed")) {
        setMicState("error");
        setMicErrorKind("permission");
        setMicErrorMsg("Microphone permission is required. Please grant access in Settings and try again.");
      } else {
        setMicState("error");
        setMicErrorKind("other");
        setMicErrorMsg("Could not start recording. Please try again.");
      }
    }
  }, []);

  const stopRecording = useCallback(async () => {
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (!rec) { setMicState("idle"); return; }

    if (Platform.OS !== "web") {
      try {
        await (rec as Audio.Recording).stopAndUnloadAsync();
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
        const uri = (rec as Audio.Recording).getURI();
        if (!uri) { setMicState("idle"); return; }
        setMicState("processing");
        const intent = recordingIntentRef.current;
        recordingIntentRef.current = "dictation";
        try {
          const transcript = await uploadAudioForTranscript(uri, "audio/m4a");
          if (transcript.trim()) {
            if (intent === "conversation") {
              sendMessageRef.current?.(transcript.trim());
            } else {
              setInput(transcript.trim());
            }
          }
        } catch (err: any) {
          setMicState("error");
          setMicErrorKind("other");
          setMicErrorMsg(err?.message || "Could not transcribe audio. Please try again or type your message.");
          return;
        }
        setMicState("idle");
      } catch {
        setMicState("idle");
      }
    } else {
      // Web — stop fires onstop which handles processing
      try { (rec as any).stop(); } catch { setMicState("idle"); }
    }
  }, []);

  const buildHistory = useCallback(
    (msgs: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> =>
      msgs
        .filter((m) => m.id !== "welcome")
        .flatMap((m): Array<{ role: "user" | "assistant"; content: string }> => {
          if (m.proposedAction) {
            const pa = m.proposedAction;
            if (pa.state === "done" && !pa.error) {
              return [{ role: "assistant", content: pa.resultText ?? `Action completed: ${pa.summary}` }];
            }
            if (pa.state === "rejected") {
              return [{ role: "assistant", content: `Action cancelled by user: ${pa.summary}` }];
            }
            return [];
          }
          if (!m.content) return [];
          return [{ role: m.role, content: m.content }];
        }),
    [],
  );

  /** Stream a reply from /ai-agent/stream (SSE) and update the UI token-by-token. */
  const dispatchAiStream = useCallback(
    async (currentMessages: ChatMessage[]) => {
      setSending(true);
      setStreamingToolCall(null);
      scrollToBottom();

      const streamingId = genId();
      const streamingMsg: ChatMessage = { id: streamingId, role: "assistant", content: "" };
      setMessages([...currentMessages, streamingMsg]);
      setStreamingMsgId(streamingId);
      scrollToBottom();

      try {
        const token = await refreshAndGetAccessToken();
        const baseUrl = getApiUrl();
        const url = new URL("api/ai-agent/stream", baseUrl).toString();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const activeCaseId = caseIdRef.current;
        const streamBody: Record<string, unknown> = { messages: buildHistory(currentMessages), auto_execute: autoExecute };
        if (activeCaseId) streamBody.caseId = activeCaseId;

        let resp: Response;
        try {
          resp = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(streamBody),
          });
        } catch {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamingId
                ? { ...m, content: "Sorry, I'm having trouble connecting right now. Please try again.", isError: true }
                : m,
            ),
          );
          scrollToBottom();
          return;
        }

        if (!resp.ok || !resp.body) {
          const errText =
            resp.status === 503
              ? "AI assistant is not set up on this server. Contact your administrator."
              : resp.status === 429
              ? "Please slow down — try again in a moment."
              : "Something went wrong. Please try again.";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamingId ? { ...m, content: errText, isError: true } : m,
            ),
          );
          scrollToBottom();
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let fullContent = "";
        let finalDisclaimer: string | undefined;
        let proposedActionHandled = false;

        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop()!;
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let evt: Record<string, unknown>;
            try { evt = JSON.parse(line.slice(6)) as Record<string, unknown>; } catch { continue; }

            if (evt.tool_call && typeof evt.tool_call === "object") {
              const tc = evt.tool_call as { name?: string };
              setStreamingToolCall(tc.name ?? null);
            }

            if (typeof evt.token === "string") {
              if (!fullContent) setStreamingToolCall(null);
              fullContent += evt.token;
              setMessages((prev) =>
                prev.map((m) => m.id === streamingId ? { ...m, content: fullContent } : m),
              );
              scrollToBottom();
            } else if (evt.error) {
              const errMsg = typeof evt.error === "string" ? evt.error : "Something went wrong. Please try again.";
              setMessages((prev) =>
                prev.map((m) => m.id === streamingId ? { ...m, content: errMsg, isError: true } : m),
              );
              scrollToBottom();
              break outer;
            } else if (evt.done) {
              if (typeof evt.disclaimer === "string") finalDisclaimer = evt.disclaimer;
            } else if (evt.auto_executed && typeof evt.auto_executed === "object") {
              const ae = evt.auto_executed as { toolName?: string; summary?: string; result?: unknown };
              const indicator = `\n✅ *Auto-executed: ${ae.summary || ae.toolName || "action"}*\n`;
              fullContent += indicator;
              setMessages((prev) =>
                prev.map((m) => m.id === streamingId ? { ...m, content: fullContent } : m),
              );
              scrollToBottom();
            } else if (evt.proposed_action && typeof evt.proposed_action === "object") {
              const pa = evt.proposed_action as { actionId?: string; toolName?: string; summary?: string };
              if (pa.actionId && pa.summary) {
                proposedActionHandled = true;
                const actionMsg: ChatMessage = {
                  id: streamingId,
                  role: "assistant",
                  content: fullContent || "",
                  proposedAction: {
                    actionId: pa.actionId,
                    toolName: pa.toolName ?? "",
                    summary: pa.summary,
                    state: "pending",
                    expiresAt: Date.now() + PENDING_TTL_MS,
                  },
                };
                setMessages((prev) =>
                  prev.map((m) => m.id === streamingId ? actionMsg : m),
                );
                scrollToBottom();
                break outer;
              }
            }
          }
        }

        if (proposedActionHandled) return;

        if (!fullContent) fullContent = "I couldn't generate a response. Please try again.";
        const finalMsg: ChatMessage = {
          id: streamingId,
          role: "assistant",
          content: fullContent,
          ...(finalDisclaimer ? { disclaimer: finalDisclaimer } : {}),
        };
        setMessages((prev) => prev.map((m) => m.id === streamingId ? finalMsg : m));
        scrollToBottom();

        if (voiceMode && fullContent) {
          void speakText(fullContent);
        }
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamingId
              ? { ...m, content: "Sorry, I'm having trouble connecting right now. Please try again.", isError: true }
              : m,
          ),
        );
        scrollToBottom();
      } finally {
        setSending(false);
        setStreamingToolCall(null);
        setStreamingMsgId(null);
      }
    },
    [buildHistory, scrollToBottom, voiceMode, speakText],
  );

  const confirmAction = useCallback(async (actionId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.proposedAction?.actionId === actionId
          ? { ...m, proposedAction: { ...m.proposedAction!, state: "confirmed" as const } }
          : m,
      ),
    );

    try {
      const res = await resilientFetch("/api/ai-agent/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId }),
      });

      const data = (await res.json()) as {
        type: string;
        success: boolean;
        summary: string;
        error?: string;
      };

      const resultText = data.success
        ? `✓ ${data.summary ?? "Action completed successfully."}`
        : undefined;
      const errorText = data.success ? undefined : data.error ?? "Action failed.";

      const updatedMessages = messagesRef.current.map((m) =>
        m.proposedAction?.actionId === actionId
          ? {
              ...m,
              proposedAction: {
                ...m.proposedAction!,
                state: "done" as const,
                resultText,
                error: errorText,
              },
            }
          : m,
      );
      setMessages(updatedMessages);

      if (data.success) {
        await dispatchAiStream(updatedMessages);
      }
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.proposedAction?.actionId === actionId
            ? {
                ...m,
                proposedAction: {
                  ...m.proposedAction!,
                  state: "done" as const,
                  error: "Action failed. Please try again.",
                },
              }
            : m,
        ),
      );
    }
  }, [dispatchAiStream]);

  const rejectAction = useCallback(async (actionId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.proposedAction?.actionId === actionId
          ? { ...m, proposedAction: { ...m.proposedAction!, state: "rejected" as const } }
          : m,
      ),
    );
    try {
      await resilientFetch("/api/ai-agent/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId }),
      });
    } catch {
      // best-effort
    }
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      const userMsg: ChatMessage = { id: genId(), role: "user", content: trimmed };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      setInput("");
      scrollToBottom();
      await dispatchAiStream(nextMessages);
    },
    [messages, sending, dispatchAiStream, scrollToBottom],
  );

  // Keep the ref current so stopRecording (defined earlier) can always call
  // the latest sendMessage without needing it in its dependency array.
  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  const handleSend = useCallback(() => {
    sendMessage(input);
  }, [input, sendMessage]);

  const handleTryAgain = useCallback(
    (msgId: string) => {
      const msgs = messagesRef.current;
      const idx = msgs.findIndex((m) => m.id === msgId);
      if (idx === -1) return;
      for (let i = idx - 1; i >= 0; i--) {
        if (msgs[i].role === "user" && msgs[i].content) {
          sendMessage(msgs[i].content);
          return;
        }
      }
    },
    [sendMessage],
  );

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => (
      <MessageBubble
        msg={item}
        colors={colors}
        onConfirm={confirmAction}
        onReject={rejectAction}
        onTryAgain={handleTryAgain}
        sending={sending}
        isStreamingBubble={item.id === streamingMsgId && !!streamingToolCall}
        streamingToolCall={item.id === streamingMsgId ? streamingToolCall : null}
      />
    ),
    [colors, confirmAction, rejectAction, handleTryAgain, sending, streamingMsgId, streamingToolCall],
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
          <View style={{ flex: 1 }}>
            <Text style={[s.headerTitle, { color: colors.text }]}>AI Assistant</Text>
            {caseId ? (
              <View style={s.contextPill}>
                <Ionicons name="document-text-outline" size={10} color={colors.tint} />
                <Text style={[s.contextPillText, { color: colors.tint }]} numberOfLines={1}>
                  {caseContext
                    ? [
                        caseContext.caseNumber ? `#${caseContext.caseNumber}` : null,
                        caseContext.patientName,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Case context active"
                    : "Loading case…"}
                </Text>
              </View>
            ) : (
              <Text style={[s.headerSubtitle, { color: colors.textSecondary }]}>
                Ask anything about your lab
              </Text>
            )}
          </View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          {allSessions.length > 0 && (
            <Pressable
              onPress={() => { setShowSessions(true); setDeletingSessionId(null); }}
              hitSlop={10}
              style={s.clearBtn}
              accessibilityLabel="Past conversations"
            >
              <Ionicons name="time-outline" size={20} color={colors.textSecondary} />
            </Pressable>
          )}
          <Pressable
            onPress={startNewChat}
            hitSlop={10}
            style={s.clearBtn}
            accessibilityLabel="New chat"
          >
            <Ionicons name="create-outline" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>

      {/* Past conversations picker */}
      <Modal
        visible={showSessions}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSessions(false)}
      >
        <Pressable style={s.sessionsBackdrop} onPress={() => setShowSessions(false)}>
          <Pressable
            style={[s.sessionsSheet, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: insets.top + 56 }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={[s.sessionsHeader, { borderBottomColor: colors.border }]}>
              <Text style={[s.sessionsTitle, { color: colors.text }]}>Past Conversations</Text>
              <Pressable
                onPress={startNewChat}
                hitSlop={8}
                style={s.sessionsNewBtn}
                accessibilityLabel="New chat"
              >
                <Ionicons name="create-outline" size={14} color={colors.tint} />
                <Text style={[s.sessionsNewBtnText, { color: colors.tint }]}>New chat</Text>
              </Pressable>
            </View>
            <FlatList
              data={allSessions}
              keyExtractor={(item) => item.id}
              style={{ maxHeight: 360 }}
              ListEmptyComponent={
                <Text style={[s.sessionsEmpty, { color: colors.textSecondary }]}>
                  No past conversations yet.
                </Text>
              }
              renderItem={({ item }) => {
                const isActive = item.id === currentSessionIdRef.current;
                const isDeleting = item.id === deletingSessionId;
                const count = countUserMessages(item);
                return (
                  <Pressable
                    onPress={() => loadSession(item)}
                    style={[
                      s.sessionRow,
                      { borderBottomColor: colors.border },
                      isActive && { backgroundColor: colors.tint + "0D" },
                    ]}
                    accessibilityLabel={`Open conversation: ${getSessionPreview(item)}`}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        numberOfLines={1}
                        style={[s.sessionPreview, { color: isActive ? colors.tint : colors.text }]}
                      >
                        {getSessionPreview(item)}
                      </Text>
                      <Text style={[s.sessionMeta, { color: colors.textSecondary }]}>
                        {formatRelativeTime(item.lastActive)} · {count} message{count !== 1 ? "s" : ""}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => handleDeleteSession(item.id)}
                      hitSlop={8}
                      style={[
                        s.sessionDeleteBtn,
                        isDeleting && { backgroundColor: "#fde8e8" },
                      ]}
                      accessibilityLabel={isDeleting ? "Confirm delete conversation" : "Delete conversation"}
                    >
                      <Ionicons name="trash-outline" size={15} color={isDeleting ? "#c53030" : colors.textSecondary} />
                      {isDeleting && <Text style={s.sessionDeleteText}>Sure?</Text>}
                    </Pressable>
                  </Pressable>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>

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
          maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
          ListHeaderComponent={
            hasMoreHistory ? (
              <View style={s.loadEarlierContainer}>
                <Pressable
                  style={[s.loadEarlierBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
                  onPress={loadEarlierMessages}
                  disabled={loadingEarlier}
                >
                  {loadingEarlier ? (
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                  ) : (
                    <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
                  )}
                  <Text style={[s.loadEarlierText, { color: colors.textSecondary }]}>
                    {loadingEarlier ? "Loading…" : "Load earlier messages"}
                  </Text>
                </Pressable>
              </View>
            ) : null
          }
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
              {sending && !streamingMsgId && (
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
          {micErrorMsg ? (
            <View style={[s.micErrorBanner, { backgroundColor: "#fff5f5", borderColor: "#fed7d7" }]}>
              <Ionicons name="mic-off-outline" size={13} color="#c53030" style={{ marginTop: 1 }} />
              <Text style={[s.micErrorText, { color: "#742a2a", flex: 1 }]}>{micErrorMsg}</Text>
              <Pressable onPress={() => { setMicErrorMsg(null); setMicState("idle"); }} hitSlop={6}>
                <Ionicons name="close" size={13} color="#c53030" />
              </Pressable>
            </View>
          ) : null}
          {/* Auto-execute toggle */}
          <View style={s.autoExecuteRow}>
            <Pressable
              onPress={() => setAutoExecute((prev) => !prev)}
              style={[s.autoExecuteChip, { borderColor: autoExecute ? "#d97706" : colors.border, backgroundColor: autoExecute ? "#fef3c7" : colors.surfaceSecondary }]}
            >
              <Ionicons name={autoExecute ? "flash" : "flash-outline"} size={10} color={autoExecute ? "#b45309" : colors.textSecondary} />
              <Text style={[s.autoExecuteText, { color: autoExecute ? "#b45309" : colors.textSecondary }]}>Auto-execute</Text>
            </Pressable>
            <Text style={[s.autoExecuteHint, { color: colors.textSecondary }]}>
              {autoExecute ? "Maynard will run actions without asking" : "Maynard will ask before changing data"}
            </Text>
          </View>
          <View style={s.inputRow}>
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
              onPress={() => {
                if (micState === "listening") {
                  void stopRecording();
                } else if (micState === "error") {
                  setMicErrorMsg(null);
                  setMicState("idle");
                } else if (micState === "processing") {
                  // no-op
                } else {
                  recordingIntentRef.current = "dictation";
                  if (isSpeaking) stopSpeaking();
                  void startRecording();
                }
              }}
              disabled={sending || micState === "processing"}
              style={[
                s.micBtn,
                micState === "listening" && recordingIntentRef.current === "dictation" && { backgroundColor: "#fed7d7", borderColor: "#fc8181" },
                micState === "processing" && { backgroundColor: colors.surfaceSecondary, borderColor: colors.border },
                micState === "error" && { backgroundColor: "#fff5f5", borderColor: "#fed7d7" },
              ]}
              accessibilityLabel={
                micState === "listening"
                  ? "Stop recording"
                  : micState === "processing"
                  ? "Processing…"
                  : micState === "error"
                  ? micErrorKind === "permission" ? "Microphone blocked — tap to dismiss" : "Microphone error — tap to dismiss"
                  : "Dictate message"
              }
            >
              {micState === "listening" && recordingIntentRef.current === "dictation" ? (
                <VoiceWaveformNative color="#c53030" />
              ) : micState === "processing" ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : micState === "error" ? (
                <Ionicons name="mic-off-outline" size={18} color="#c53030" />
              ) : (
                <Ionicons name="mic-outline" size={18} color={colors.textSecondary} />
              )}
            </Pressable>
            {/* Voice conversation push-to-talk */}
            {(() => {
              const convListening = micState === "listening" && recordingIntentRef.current === "conversation";
              return (
                <Pressable
                  onPress={() => {
                    if (micState === "listening") {
                      void stopRecording();
                    } else if (micState !== "processing") {
                      recordingIntentRef.current = "conversation";
                      if (!voiceMode) setVoiceMode(true);
                      if (isSpeaking) stopSpeaking();
                      void startRecording();
                    }
                  }}
                  disabled={sending || micState === "processing"}
                  style={[
                    s.micBtn,
                    convListening && { backgroundColor: colors.tint + "1A", borderColor: colors.tint + "66" },
                    !convListening && voiceMode && { backgroundColor: colors.tint + "0D", borderColor: colors.tint + "33" },
                  ]}
                  accessibilityLabel="Talk with Maynard"
                >
                  <Ionicons
                    name={convListening ? "radio-outline" : "headset-outline"}
                    size={18}
                    color={convListening || voiceMode ? colors.tint : colors.textSecondary}
                  />
                </Pressable>
              );
            })()}
            <Pressable
              style={[s.sendBtn, { backgroundColor: colors.tint, opacity: (!input.trim() || sending) ? 0.45 : 1 }]}
              onPress={handleSend}
              disabled={!input.trim() || sending}
              accessibilityLabel="Send message"
            >
              <Ionicons name="send" size={16} color="#fff" />
            </Pressable>
          </View>
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
  disclaimerCallout: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderWidth: 1.5,
    borderColor: "#fbbf24",
    borderRadius: Radius.md,
    backgroundColor: "#fffbeb",
    paddingHorizontal: 12,
    paddingVertical: 10,
    maxWidth: "100%",
  },
  disclaimerIcon: {
    marginTop: 1,
    flexShrink: 0,
  },
  disclaimerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: "600",
    color: "#92400e",
    lineHeight: 18,
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
    contextPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: 1,
    },
    contextPillText: {
      fontSize: 11,
      fontWeight: "500",
      flexShrink: 1,
    },
    sessionsBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.25)",
      alignItems: "flex-end",
    },
    sessionsSheet: {
      width: 300,
      marginRight: Spacing.md,
      borderRadius: Radius.lg,
      borderWidth: 1,
      overflow: "hidden",
    },
    sessionsHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.md,
      paddingVertical: 12,
      borderBottomWidth: 1,
    },
    sessionsTitle: {
      fontSize: Typography.bodyMedium.fontSize,
      fontWeight: "600",
    },
    sessionsNewBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    sessionsNewBtnText: {
      fontSize: Typography.caption.fontSize,
      fontWeight: "600",
    },
    sessionsEmpty: {
      textAlign: "center",
      paddingVertical: Spacing.lg,
      fontSize: Typography.caption.fontSize,
    },
    sessionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: Spacing.md,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    sessionPreview: {
      fontSize: Typography.caption.fontSize,
      fontWeight: "500",
    },
    sessionMeta: {
      fontSize: Typography.tiny.fontSize,
      marginTop: 2,
    },
    sessionDeleteBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 6,
      paddingVertical: 4,
      borderRadius: Radius.sm,
    },
    sessionDeleteText: {
      fontSize: Typography.tiny.fontSize,
      color: "#c53030",
      fontWeight: "600",
    },
    messageList: {
      paddingVertical: Spacing.sm,
      paddingBottom: Spacing.xl,
    },
    loadEarlierContainer: {
      alignItems: "center",
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.xs,
    },
    loadEarlierBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderWidth: 1,
      borderRadius: Radius.full,
      paddingHorizontal: 14,
      paddingVertical: 6,
    },
    loadEarlierText: {
      fontSize: Typography.tiny.fontSize,
      fontWeight: "500",
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
      flexDirection: "column",
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: 4,
    },
    inputRow: {
      flexDirection: "row",
      alignItems: "flex-end",
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
    micBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      borderWidth: 1,
      borderColor: "transparent",
      backgroundColor: "transparent",
    },
    sendBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    autoExecuteRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    autoExecuteChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: Radius.full,
      borderWidth: 1,
    },
    autoExecuteText: {
      fontSize: 10,
      fontWeight: "500",
    },
    autoExecuteHint: {
      fontSize: 10,
    },
    micErrorBanner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
      padding: 8,
      borderRadius: Radius.md,
      borderWidth: 1,
      marginBottom: 2,
    },
    micErrorText: {
      fontSize: Typography.tiny.fontSize,
      lineHeight: 16,
    },
  });
}
