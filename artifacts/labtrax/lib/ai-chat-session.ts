// Persists the mobile AI assistant conversations to AsyncStorage so chats
// survive navigation and app restarts, mirroring the desktop session-storage
// pattern (`artifacts/labtrax-desktop/src/lib/chat-session-storage.ts`).
//
// The mobile assistant is a single general-purpose chat (no pinned cases or
// per-case session keys like the desktop panel), so sessions are stored as a
// flat list per user. Up to MAX_SESSIONS most-recent conversations are kept so
// users can browse and reopen a past chat. Sessions older than the TTL are
// dropped on read.

import AsyncStorage from "@react-native-async-storage/async-storage";

/** Storage key for the multi-session list. */
export const STORAGE_KEY = "labtrax_ai_chat_sessions_v1";
/**
 * Legacy single-session key (pre-multi-session). The first read migrates any
 * stored single session into the new list, then removes the legacy entry.
 */
export const LEGACY_STORAGE_KEY = "labtrax_ai_chat_session_v1";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Max conversations kept per user — mirrors desktop's MAX_SESSIONS_PER_KEY. */
export const MAX_SESSIONS = 10;

/**
 * Storage key for a given user. History is keyed per user so switching accounts
 * on the same device never mixes one user's conversations into another's. Falls
 * back to the bare key when the user id is unknown.
 */
function keyFor(userId?: string | null): string {
  return userId ? `${STORAGE_KEY}_${userId}` : STORAGE_KEY;
}

function legacyKeyFor(userId?: string | null): string {
  return userId ? `${LEGACY_STORAGE_KEY}_${userId}` : LEGACY_STORAGE_KEY;
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

export interface StoredChatSession<T> {
  id: string;
  messages: T[];
  createdAt: number;
  lastActive: number;
}

interface StoredSessionsFile<T> {
  sessions: StoredChatSession<T>[];
}

/** Generate a reasonably unique session id (mirrors desktop's generateId). */
export function generateSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
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

/** Drop expired sessions and sort newest-first by lastActive. */
function pruneAndSort<T>(sessions: StoredChatSession<T>[]): StoredChatSession<T>[] {
  const now = Date.now();
  return sessions
    .filter(
      (s) =>
        s &&
        Array.isArray(s.messages) &&
        s.messages.length > 0 &&
        typeof s.lastActive === "number" &&
        now - s.lastActive < SESSION_TTL_MS,
    )
    .sort((a, b) => b.lastActive - a.lastActive);
}

/**
 * Migrate a legacy single-session entry (if present) into a list session.
 * Returns the migrated session or null, and removes the legacy key.
 */
async function migrateLegacySession<T>(
  userId?: string | null,
): Promise<StoredChatSession<T> | null> {
  const legacyKey = legacyKeyFor(userId);
  try {
    const raw = await AsyncStorage.getItem(legacyKey);
    if (!raw) return null;
    await AsyncStorage.removeItem(legacyKey).catch(() => {});
    const parsed = JSON.parse(raw) as Partial<StoredChatSession<T>> & {
      messages?: T[];
    };
    if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      return null;
    }
    const now = Date.now();
    return {
      id: generateSessionId(),
      messages: parsed.messages,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : now,
      lastActive: typeof parsed.lastActive === "number" ? parsed.lastActive : now,
    };
  } catch {
    return null;
  }
}

/**
 * Load all stored chat sessions for a user, newest-first. Expired sessions are
 * dropped (and the cleaned list is written back). Any legacy single-session
 * entry is migrated into the list on first read. Returns `[]` when there are
 * none.
 */
export async function loadChatSessions<T extends PersistableMessage>(
  userId?: string | null,
): Promise<StoredChatSession<T>[]> {
  const key = keyFor(userId);
  let sessions: StoredChatSession<T>[] = [];
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredSessionsFile<T>>;
      if (parsed && Array.isArray(parsed.sessions)) {
        sessions = parsed.sessions;
      }
    }
  } catch {
    sessions = [];
  }

  const legacy = await migrateLegacySession<T>(userId);
  if (legacy) sessions = [legacy, ...sessions];

  const pruned = pruneAndSort(sessions).slice(0, MAX_SESSIONS);

  // Best-effort: persist the cleaned/migrated list so we don't repeat the work.
  if (pruned.length !== sessions.length || legacy) {
    try {
      await AsyncStorage.setItem(key, JSON.stringify({ sessions: pruned }));
    } catch {
      // ignore
    }
  }

  return pruned;
}

/**
 * Upsert a session's messages into the stored list and return the updated list
 * (newest-first). Welcome-only conversations are skipped so an empty chat never
 * creates or overwrites a stored session — in that case the existing list is
 * returned unchanged. `createdAt` is preserved across updates; `lastActive` is
 * refreshed on each save. New sessions beyond MAX_SESSIONS drop the oldest.
 */
export async function saveChatSession<T extends PersistableMessage>(
  msgs: T[],
  sessionId: string,
  userId?: string | null,
): Promise<StoredChatSession<T>[]> {
  const key = keyFor(userId);
  const userMsgs = sanitizeMessagesForStorage(msgs);

  let existing: StoredChatSession<T>[] = [];
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredSessionsFile<T>>;
      if (parsed && Array.isArray(parsed.sessions)) existing = parsed.sessions;
    }
  } catch {
    existing = [];
  }

  // Nothing meaningful to persist — return the current list untouched.
  if (userMsgs.length === 0) {
    return pruneAndSort(existing).slice(0, MAX_SESSIONS);
  }

  const now = Date.now();
  const prior = existing.find((s) => s.id === sessionId);
  let updated: StoredChatSession<T>[];
  if (prior) {
    updated = existing.map((s) =>
      s.id === sessionId ? { ...s, messages: userMsgs, lastActive: now } : s,
    );
  } else {
    const newSession: StoredChatSession<T> = {
      id: sessionId,
      messages: userMsgs,
      createdAt: now,
      lastActive: now,
    };
    updated = [newSession, ...existing];
  }

  const pruned = pruneAndSort(updated).slice(0, MAX_SESSIONS);
  try {
    await AsyncStorage.setItem(key, JSON.stringify({ sessions: pruned }));
  } catch {
    // best-effort; persistence failures must never break the chat
  }
  return pruned;
}

/** Delete a single stored session and return the remaining list (newest-first). */
export async function deleteChatSession<T extends PersistableMessage>(
  sessionId: string,
  userId?: string | null,
): Promise<StoredChatSession<T>[]> {
  const key = keyFor(userId);
  let existing: StoredChatSession<T>[] = [];
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredSessionsFile<T>>;
      if (parsed && Array.isArray(parsed.sessions)) existing = parsed.sessions;
    }
  } catch {
    existing = [];
  }
  const remaining = pruneAndSort(existing.filter((s) => s.id !== sessionId)).slice(
    0,
    MAX_SESSIONS,
  );
  try {
    await AsyncStorage.setItem(key, JSON.stringify({ sessions: remaining }));
  } catch {
    // ignore
  }
  return remaining;
}

/** Remove all stored sessions for a user (and any legacy single-session entry). */
export async function clearChatSessions(userId?: string | null): Promise<void> {
  try {
    await AsyncStorage.multiRemove([keyFor(userId), legacyKeyFor(userId)]);
  } catch {
    // ignore
  }
}
