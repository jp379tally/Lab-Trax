import type { AiCaseContext } from "@/lib/ai-panel-context";

// ─── Message types (shared with AiChatPanel) ────────────────────────────────

export interface ToolOutput {
  name: string;
  result: unknown;
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content?: string;
  toolOutputs?: ToolOutput[];
  /** IDs of the curated knowledge sections included in the prompt for this reply. Admin-only audit field. */
  knowledgeSectionIds?: string[];
  /** Whether the retention legal disclaimer was injected into the prompt. Admin-only audit field. */
  retentionDisclaimer?: boolean;
  /** Whether the HIPAA/compliance disclaimer was injected into the prompt. Admin-only audit field. */
  privacyDisclaimer?: boolean;
  /** Structured disclaimer text returned by the API for retention-related queries.
   *  Rendered as an amber callout independent of whether the model echoes it. */
  disclaimer?: string;
  proposedAction?: {
    actionId: string;
    toolName: string;
    summary: string;
    state: "pending" | "confirmed" | "done" | "rejected";
    resultText?: string;
    error?: string;
    expiresAt?: number;
  };
}

export interface StoredSession {
  id: string;
  key: string;
  pinnedCases: AiCaseContext[];
  messages: ChatMsg[];
  createdAt: number;
  lastActive: number;
}

// ─── Storage constants ───────────────────────────────────────────────────────

export const STORAGE_KEY = "labtrax_chat_sessions_v1";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SESSIONS_PER_KEY = 10;

// ─── Storage helpers ─────────────────────────────────────────────────────────

export function readStoredSessions(): StoredSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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

export function writeStoredSessions(sessions: StoredSession[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions }));
  } catch {
    // ignore
  }
}

// ─── Message sanitization ────────────────────────────────────────────────────

/**
 * Prepare messages for localStorage persistence.
 *
 * - Strips the synthetic "welcome" message (it is rebuilt on restore).
 * - Collapses any proposedAction whose state is still "pending" to "rejected"
 *   so that restored sessions never show an interactive confirmation card for
 *   an action whose server-side TTL has already expired.
 */
export function sanitizeMessagesForStorage(msgs: ChatMsg[]): ChatMsg[] {
  return msgs
    .filter((m) => m.id !== "welcome")
    .map((m) => {
      if (m.proposedAction?.state !== "pending") return m;
      const now = Date.now();
      return {
        ...m,
        proposedAction: {
          ...m.proposedAction,
          state: "rejected" as const,
          expiresAt: now - 1,
        },
      };
    });
}
