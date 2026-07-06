import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMessengerSocket, type WsEnvelope } from "@/hooks/useMessengerSocket";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export interface OtherUser {
  id: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  initials: string;
  displayName: string;
  workStatus?: string | null;
}

export interface ConversationSummary {
  id: string;
  updatedAt?: string;
  lastMessage: {
    id: string;
    body: string;
    senderId: string;
    createdAt: string | Date;
  } | null;
  unreadCount: number;
  otherUser: OtherUser | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  attachmentUrl?: string;
  attachmentName?: string;
  attachmentMimeType?: string;
  createdAt: string | Date;
  sender: {
    id: string;
    username: string;
    firstName?: string | null;
    lastName?: string | null;
    initials: string;
    displayName: string;
  };
}

export interface OpenPanel {
  conversationId: string;
  minimized: boolean;
}

export interface MessengerState {
  conversations: ConversationSummary[];
  openPanels: OpenPanel[];
  onlineUserIds: Set<string>;
  typingMap: Map<string, Set<string>>;
  seenMap: Map<string, string>;
  inboxOpen: boolean;
  totalUnread: number;
  openConversation: (conversationId: string) => void;
  closePanel: (conversationId: string) => void;
  toggleMinimize: (conversationId: string) => void;
  toggleInbox: () => void;
  closeInbox: () => void;
  findOrCreateConversation: (otherUserId: string) => Promise<string>;
  markRead: (conversationId: string, lastMessageId: string) => void;
  sendTypingStart: (conversationId: string) => void;
  sendTypingStop: (conversationId: string) => void;
  refreshConversations: () => Promise<void>;
  socketSend: (envelope: WsEnvelope) => void;
}

const MessengerContext = createContext<MessengerState | null>(null);

export function useMessenger() {
  const ctx = useContext(MessengerContext);
  if (!ctx) throw new Error("useMessenger must be used within MessengerProvider");
  return ctx;
}

const MAX_OPEN_PANELS = 3;

export function MessengerProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [openPanels, setOpenPanels] = useState<OpenPanel[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [typingMap, setTypingMap] = useState<Map<string, Set<string>>>(new Map());
  const [seenMap, setSeenMap] = useState<Map<string, string>>(new Map());
  const [inboxOpen, setInboxOpen] = useState(false);
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Stable ref so the notification-click subscription (registered once) always
  // calls the current version of openConversation without needing to re-subscribe.
  const openConversationRef = useRef<(id: string) => void>(() => {});
  // Mirror of the latest conversations so openConversation can read current
  // unread/last-message state without taking a reactive dependency on it.
  const conversationsRef = useRef<ConversationSummary[]>([]);
  conversationsRef.current = conversations;
  // Tracks the id of the latest message the user has actually viewed in each
  // conversation *this session*. Used by refreshConversations to reconcile a
  // server row that is still unread for a conversation the user already read
  // (a previous mark-read that failed to persist) — but only when the latest
  // message still matches what the user saw, so a genuinely new message that
  // arrived after the last view is left as unread.
  const viewedLastMessageRef = useRef<Map<string, string>>(new Map());
  // Per-conversation guard so concurrent open + post-fetch markRead don't fire
  // duplicate read POSTs while one is still retrying.
  const readInflightRef = useRef<Set<string>>(new Set());

  // Durably persist the server read state for a conversation. apiFetch already
  // refreshes the access token and retries once on a 401, so an expired token
  // at this moment self-corrects. For other transient failures we retry with
  // backoff instead of swallowing the error — previously a dropped failure left
  // the server unread while the local badge optimistically cleared, so the
  // count reappeared on the next login. A final failure is surfaced (logged);
  // the next refreshConversations reconcile retries it if still needed.
  const persistRead = useCallback(
    async (
      conversationId: string,
      lastMessageId?: string,
      attempt = 0
    ): Promise<void> => {
      if (attempt === 0) {
        if (readInflightRef.current.has(conversationId)) return;
        readInflightRef.current.add(conversationId);
      }
      // Bind the durable read to the message the user actually saw so the
      // server never advances last_read_at past a newer message that arrived
      // after the last view. Fall back to the latest tracked viewed id when a
      // caller does not pass one explicitly. When neither is known, the server
      // defaults to the latest message for backward compatibility.
      const viewedId =
        lastMessageId ?? viewedLastMessageRef.current.get(conversationId);
      const MAX_ATTEMPTS = 4;
      try {
        await apiFetch(`/messenger/conversations/${conversationId}/read`, {
          method: "POST",
          ...(viewedId
            ? { body: JSON.stringify({ lastMessageId: viewedId }) }
            : {}),
        });
        readInflightRef.current.delete(conversationId);
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          const delay = Math.min(1000 * 2 ** attempt, 8000);
          setTimeout(() => {
            void persistRead(conversationId, lastMessageId, attempt + 1);
          }, delay);
        } else {
          readInflightRef.current.delete(conversationId);
          console.warn(
            `[messenger] failed to persist read state for conversation ${conversationId} after ${MAX_ATTEMPTS + 1} attempts`,
            err
          );
        }
      }
    },
    []
  );

  const refreshConversations = useCallback(async () => {
    try {
      const data = await apiFetch<ConversationSummary[]>("/messenger/conversations");
      setConversations(data);
      // Reconcile: a conversation the user already viewed this session that
      // the server still reports as unread means an earlier mark-read never
      // persisted. Re-fire the read call (and optimistically clear the badge)
      // — but only when the latest message is the one the user actually saw,
      // so a new message that arrived after the last view stays unread.
      const toReconcile = data
        .filter((c) => {
          if ((c.unreadCount ?? 0) <= 0) return false;
          const viewedId = viewedLastMessageRef.current.get(c.id);
          return !!viewedId && !!c.lastMessage && c.lastMessage.id === viewedId;
        })
        .map((c) => c.id);
      if (toReconcile.length > 0) {
        const reconcileSet = new Set(toReconcile);
        setConversations((prev) =>
          prev.map((c) =>
            reconcileSet.has(c.id) ? { ...c, unreadCount: 0 } : c
          )
        );
        for (const id of toReconcile) void persistRead(id);
      }
    } catch {
      // ignore
    }
  }, [persistRead]);

  useEffect(() => {
    if (!user) return;
    refreshConversations();
    const id = setInterval(refreshConversations, 60_000);
    return () => clearInterval(id);
  }, [user, refreshConversations]);

  const handleWsMessage = useCallback((envelope: WsEnvelope) => {
    const { type, payload } = envelope;

    if (type === "presence_pong") {
      const p = payload as { onlineUserIds?: string[] };
      setOnlineUserIds(new Set(p.onlineUserIds ?? []));
      return;
    }

    if (type === "chat_message") {
      const msg = payload as {
        id: string;
        conversationId: string;
        senderId: string;
        senderName: string;
        body: string;
        attachmentUrl?: string;
        attachmentName?: string;
        attachmentMimeType?: string;
        createdAt: string;
      };

      window.dispatchEvent(
        new CustomEvent(`messenger:message:${msg.conversationId}`, { detail: {
          id: msg.id,
          conversationId: msg.conversationId,
          senderId: msg.senderId,
          body: msg.body,
          attachmentUrl: msg.attachmentUrl,
          attachmentName: msg.attachmentName,
          attachmentMimeType: msg.attachmentMimeType,
          createdAt: msg.createdAt,
          sender: {
            id: msg.senderId,
            username: msg.senderName,
            firstName: null,
            lastName: null,
            initials: msg.senderName.slice(0, 2).toUpperCase(),
            displayName: msg.senderName,
          },
        }})
      );

      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === msg.conversationId);
        if (idx === -1) {
          refreshConversations();
          return prev;
        }
        const updated = [...prev];
        const conv = { ...updated[idx]! };
        conv.lastMessage = {
          id: msg.id,
          body: msg.body || (msg.attachmentName ? `📎 ${msg.attachmentName}` : ""),
          senderId: msg.senderId,
          createdAt: msg.createdAt,
        };
        // only increment unread and notify for messages from others
        if (msg.senderId !== (user?.id ?? "")) {
          // Fire an OS desktop notification whenever the window is not focused,
          // regardless of whether the conversation panel is open. This covers the
          // case where the panel is open but the user has switched to another app.
          if (!document.hasFocus()) {
            const api = (window as { electronAPI?: { messenger?: { notify: (p: unknown) => void } } }).electronAPI;
            api?.messenger?.notify({
              conversationId: msg.conversationId,
              senderName: msg.senderName,
              body: msg.body,
            });
          }
          setOpenPanels((panels) => {
            const isOpen = panels.some(
              (p) => p.conversationId === msg.conversationId && !p.minimized
            );
            if (!isOpen) {
              conv.unreadCount = (conv.unreadCount ?? 0) + 1;
            }
            return panels;
          });
        }
        updated[idx] = conv;
        updated.sort((a, b) => {
          const ta = a.lastMessage?.createdAt
            ? new Date(a.lastMessage.createdAt).getTime()
            : 0;
          const tb = b.lastMessage?.createdAt
            ? new Date(b.lastMessage.createdAt).getTime()
            : 0;
          return tb - ta;
        });
        return updated;
      });
      return;
    }

    if (type === "typing_start" || type === "typing_stop") {
      const p = payload as { conversationId: string; userId: string };
      setTypingMap((prev) => {
        const next = new Map(prev);
        const set = new Set(next.get(p.conversationId) ?? []);
        if (type === "typing_start") {
          set.add(p.userId);
          const key = `${p.conversationId}:${p.userId}`;
          const existing = typingTimers.current.get(key);
          if (existing) clearTimeout(existing);
          typingTimers.current.set(
            key,
            setTimeout(() => {
              setTypingMap((m) => {
                const n = new Map(m);
                const s = new Set(n.get(p.conversationId) ?? []);
                s.delete(p.userId);
                if (s.size === 0) n.delete(p.conversationId);
                else n.set(p.conversationId, s);
                return n;
              });
              typingTimers.current.delete(key);
            }, 5_000)
          );
        } else {
          set.delete(p.userId);
          const key = `${p.conversationId}:${p.userId}`;
          const existing = typingTimers.current.get(key);
          if (existing) {
            clearTimeout(existing);
            typingTimers.current.delete(key);
          }
        }
        if (set.size === 0) next.delete(p.conversationId);
        else next.set(p.conversationId, set);
        return next;
      });
      return;
    }

    if (type === "message_seen") {
      const p = payload as {
        conversationId: string;
        seenByUserId: string;
        lastMessageId: string;
      };
      setSeenMap((prev) => {
        const next = new Map(prev);
        next.set(`${p.conversationId}:${p.seenByUserId}`, p.lastMessageId);
        return next;
      });
      return;
    }
  }, [user, refreshConversations]);

  const { send: socketSend } = useMessengerSocket(handleWsMessage, !!user);

  // Listen for notification-click events sent from the Electron main process.
  // When the user clicks an OS desktop notification, main brings the window to
  // front and fires this so we open the right conversation panel.
  useEffect(() => {
    const api = (window as { electronAPI?: { messenger?: { onOpenConversation?: (cb: (id: string) => void) => (() => void) } } }).electronAPI;
    if (!api?.messenger?.onOpenConversation) return;
    const unsub = api.messenger.onOpenConversation((conversationId) => {
      openConversationRef.current(conversationId);
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openConversation = useCallback((conversationId: string) => {
    setOpenPanels((prev) => {
      if (prev.some((p) => p.conversationId === conversationId)) {
        return prev.map((p) =>
          p.conversationId === conversationId ? { ...p, minimized: false } : p
        );
      }
      const next = [
        { conversationId, minimized: false },
        ...prev,
      ].slice(0, MAX_OPEN_PANELS);
      return next;
    });
    // Durably persist the read state on the server the moment the conversation
    // is opened, decoupled from the chat panel's later post-fetch markRead. The
    // panel's fetch can be skipped (MAX_OPEN_PANELS cap, opened minimized) or
    // fail, which previously left the server unread and made the badge/
    // notification reappear on the next login. We always fire the read call
    // (no "already read" skip): local unreadCount may have been optimistically
    // zeroed by an *earlier failed* attempt, in which case skipping here would
    // permanently strand the server as unread. persistRead is idempotent and
    // de-duped, so re-firing on an already-read conversation is cheap.
    const conv = conversationsRef.current.find((c) => c.id === conversationId);
    if (conv?.lastMessage) {
      viewedLastMessageRef.current.set(conversationId, conv.lastMessage.id);
    }
    void persistRead(conversationId, conv?.lastMessage?.id);
    // Also drive the other user's "Seen" indicator over the socket if we know
    // the last message; the REST call above is the durable source of truth.
    if (conv?.lastMessage) {
      socketSend({
        type: "mark_read",
        payload: {
          conversationId,
          lastMessageId: conv.lastMessage.id,
        },
      });
    }
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId ? { ...c, unreadCount: 0 } : c
      )
    );
    setInboxOpen(false);
  }, [socketSend, persistRead]);
  // Keep the ref current on every render so the notification-click handler
  // (registered once on mount) always delegates to the latest callback.
  openConversationRef.current = openConversation;

  const closePanel = useCallback((conversationId: string) => {
    setOpenPanels((prev) =>
      prev.filter((p) => p.conversationId !== conversationId)
    );
  }, []);

  const toggleMinimize = useCallback((conversationId: string) => {
    setOpenPanels((prev) =>
      prev.map((p) =>
        p.conversationId === conversationId
          ? { ...p, minimized: !p.minimized }
          : p
      )
    );
  }, []);

  const toggleInbox = useCallback(() => setInboxOpen((v) => !v), []);
  const closeInbox = useCallback(() => setInboxOpen(false), []);

  const findOrCreateConversation = useCallback(
    async (otherUserId: string): Promise<string> => {
      const data = await apiFetch<{ conversationId: string }>(
        "/messenger/conversations",
        { method: "POST", body: JSON.stringify({ otherUserId }) }
      );
      await refreshConversations();
      return data.conversationId;
    },
    [refreshConversations]
  );

  const markRead = useCallback(
    (conversationId: string, lastMessageId: string) => {
      // Record what the user has actually seen so a later refresh can reconcile
      // a server row that wrongly stays unread (failed persist) without ever
      // marking a newer, unseen message as read.
      viewedLastMessageRef.current.set(conversationId, lastMessageId);
      // Send WS mark_read for real-time notification to the other user
      socketSend({
        type: "mark_read",
        payload: { conversationId, lastMessageId },
      });
      // Also persist the read state over REST so it survives even if the
      // WebSocket is not connected. persistRead retries on transient failure
      // and surfaces (rather than swallows) a final error, so the badge no
      // longer reappears on the next login because a single attempt was lost.
      void persistRead(conversationId, lastMessageId);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId ? { ...c, unreadCount: 0 } : c
        )
      );
    },
    [socketSend, persistRead]
  );

  const sendTypingStart = useCallback(
    (conversationId: string) => {
      socketSend({
        type: "typing_start",
        payload: { conversationId },
      });
    },
    [socketSend]
  );

  const sendTypingStop = useCallback(
    (conversationId: string) => {
      socketSend({
        type: "typing_stop",
        payload: { conversationId },
      });
    },
    [socketSend]
  );

  const totalUnread = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0),
    [conversations]
  );

  const value = useMemo<MessengerState>(
    () => ({
      conversations,
      openPanels,
      onlineUserIds,
      typingMap,
      seenMap,
      inboxOpen,
      totalUnread,
      openConversation,
      closePanel,
      toggleMinimize,
      toggleInbox,
      closeInbox,
      findOrCreateConversation,
      markRead,
      sendTypingStart,
      sendTypingStop,
      refreshConversations,
      socketSend,
    }),
    [
      conversations,
      openPanels,
      onlineUserIds,
      typingMap,
      seenMap,
      inboxOpen,
      totalUnread,
      openConversation,
      closePanel,
      toggleMinimize,
      toggleInbox,
      closeInbox,
      findOrCreateConversation,
      markRead,
      sendTypingStart,
      sendTypingStop,
      refreshConversations,
      socketSend,
    ]
  );

  return (
    <MessengerContext.Provider value={value}>
      {children}
    </MessengerContext.Provider>
  );
}
