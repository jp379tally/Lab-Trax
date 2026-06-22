// Persists the mobile AI assistant conversation to AsyncStorage so the chat
// survives navigation and app restarts, mirroring the desktop session-storage
// pattern (`artifacts/labtrax-desktop/src/lib/chat-session-storage.ts`).
//
// The mobile assistant is a single general-purpose chat (no pinned cases or
// per-case session keys like the desktop panel), so this stores exactly one
// "last session". On mount the screen restores it; the header refresh button
// clears it. Sessions older than the TTL are dropped on read.

import AsyncStorage from "@react-native-async-storage/async-storage";

export const STORAGE_KEY = "labtrax_ai_chat_session_v1";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Storage key for a given user. History is keyed per user so switching accounts
 * on the same device never mixes one user's conversation into another's. Falls
 * back to the bare key when the user id is unknown.
 */
function keyFor(userId?: string | null): string {
  return userId ? `${STORAGE_KEY}_${userId}` : STORAGE_KEY;
}

/**
 * Minimal shape this module needs to persist/sanitize a chat message. The
 * screen's full `ChatMessage` type is a superset of this, so it satisfies the
 * generic without this module having to depend on the screen.
 */
export interface PersistableMessage {
  id: string;
  proposedAction?: {
    state: "pending" | "confirmed" | "done" | "rejected";
    expiresAt?: number;
  };
}

interface StoredChatSession<T> {
  messages: T[];
  createdAt: number;
  lastActive: number;
}

/**
 * Prepare messages for persistence.
 *
 * - Strips the synthetic "welcome" message (it is rebuilt on restore).
 * - Collapses any proposedAction still "pending" to "rejected" so a restored
 *   session never shows an interactive confirmation card for an action whose
 *   server-side TTL has already expired.
 */
export function sanitizeMessagesForStorage<T extends PersistableMessage>(msgs: T[]): T[] {
  return msgs
    .filter((m) => m.id !== "welcome")
    .map((m) => {
      const state = m.proposedAction?.state;
      if (state !== "pending" && state !== "confirmed") return m;
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

/**
 * Load the last stored chat session. Returns the persisted (non-welcome)
 * messages, or `null` when there is no session or it has expired.
 */
export async function loadChatSession<T extends PersistableMessage>(
  userId?: string | null,
): Promise<T[] | null> {
  const key = keyFor(userId);
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredChatSession<T>>;
    if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      return null;
    }
    if (
      typeof parsed.lastActive === "number" &&
      Date.now() - parsed.lastActive >= SESSION_TTL_MS
    ) {
      await AsyncStorage.removeItem(key).catch(() => {});
      return null;
    }
    return parsed.messages;
  } catch {
    return null;
  }
}

/**
 * Persist the current chat session. Welcome-only conversations are skipped so
 * an empty chat never overwrites a real stored session. `createdAt` is
 * preserved across updates; `lastActive` is refreshed each save.
 */
export async function saveChatSession<T extends PersistableMessage>(
  msgs: T[],
  userId?: string | null,
): Promise<void> {
  const key = keyFor(userId);
  try {
    const userMsgs = sanitizeMessagesForStorage(msgs);
    if (userMsgs.length === 0) return;
    const now = Date.now();
    let createdAt = now;
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        const prev = JSON.parse(raw) as Partial<StoredChatSession<T>>;
        if (typeof prev.createdAt === "number") createdAt = prev.createdAt;
      }
    } catch {
      // ignore — fall back to a fresh createdAt
    }
    const session: StoredChatSession<T> = { messages: userMsgs, createdAt, lastActive: now };
    await AsyncStorage.setItem(key, JSON.stringify(session));
  } catch {
    // best-effort; persistence failures must never break the chat
  }
}

/** Remove the stored chat session (used by the "new chat" / clear button). */
export async function clearChatSession(userId?: string | null): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(userId));
  } catch {
    // ignore
  }
}
