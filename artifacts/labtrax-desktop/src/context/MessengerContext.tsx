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

  const refreshConversations = useCallback(async () => {
    try {
      const data = await apiFetch<ConversationSummary[]>("/messenger/conversations");
      setConversations(data);
    } catch {
      // ignore
    }
  }, []);

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
        createdAt: string;
      };

      window.dispatchEvent(
        new CustomEvent(`messenger:message:${msg.conversationId}`, { detail: {
          id: msg.id,
          conversationId: msg.conversationId,
          senderId: msg.senderId,
          body: msg.body,
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
          body: msg.body,
          senderId: msg.senderId,
          createdAt: msg.createdAt,
        };
        // only increment unread for messages from others
        if (msg.senderId !== (user?.id ?? "")) {
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
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId ? { ...c, unreadCount: 0 } : c
      )
    );
    setInboxOpen(false);
  }, []);

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
      socketSend({
        type: "mark_read",
        payload: { conversationId, lastMessageId },
      });
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId ? { ...c, unreadCount: 0 } : c
        )
      );
    },
    [socketSend]
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
