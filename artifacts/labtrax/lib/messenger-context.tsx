import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import { getApiUrl, getAccessToken, resilientFetch } from "./query-client";
import { useAuth } from "./auth-context";

export interface MConversation {
  id: string;
  updatedAt?: string | null;
  unreadCount: number;
  lastMessage: {
    id: string;
    body: string;
    senderId: string;
    createdAt: string;
  } | null;
  otherUser: {
    id: string;
    username: string;
    firstName?: string | null;
    lastName?: string | null;
    initials: string;
    displayName: string;
    workStatus?: string | null;
  } | null;
}

export interface MMessage {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
  sender: {
    id: string;
    username: string;
    firstName?: string | null;
    lastName?: string | null;
    initials: string;
    displayName: string;
  };
}

export interface MUser {
  id: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  initials: string;
  displayName: string;
  userType?: string | null;
  role?: string | null;
  workStatus?: string | null;
}

interface MessengerContextValue {
  conversations: MConversation[];
  totalUnread: number;
  loadingConversations: boolean;
  loadConversations: () => Promise<void>;
  loadMessages: (
    convId: string,
    before?: string
  ) => Promise<MMessage[]>;
  sendMessage: (convId: string, body: string) => Promise<MMessage | null>;
  markRead: (convId: string) => Promise<void>;
  searchUsers: (q: string) => Promise<MUser[]>;
  findOrCreateConversation: (
    otherUserId: string
  ) => Promise<string | null>;
  onNewMessage: (
    handler: (msg: {
      id: string;
      conversationId: string;
      senderId: string;
      senderName: string;
      body: string;
      createdAt: string;
    }) => void
  ) => () => void;
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
}

const MessengerContext = createContext<MessengerContextValue | null>(null);

function getWsUrl(token: string): string {
  const base = getApiUrl();
  const wsBase = base
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://")
    .replace(/\/$/, "");
  return `${wsBase}/ws/messenger?token=${encodeURIComponent(token)}`;
}

type NewMessageHandler = (msg: {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: string;
}) => void;

export function MessengerProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, currentUserId } = useAuth();
  const [conversations, setConversations] = useState<MConversation[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const activeConvIdRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<string | null>(currentUserId);
  const loadConversationsRef = useRef<(() => Promise<void>) | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newMessageHandlers = useRef<Set<NewMessageHandler>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    activeConvIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);

  const totalUnread = conversations.reduce(
    (sum, c) => sum + (c.unreadCount ?? 0),
    0
  );

  const loadConversations = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoadingConversations(true);
    try {
      const res = await resilientFetch("/api/messenger/conversations");
      if (res.ok) {
        const json = await res.json();
        const data: MConversation[] = json?.data ?? json ?? [];
        if (mountedRef.current) setConversations(data);
      }
    } catch {}
    if (mountedRef.current) setLoadingConversations(false);
  }, [isAuthenticated]);

  // Keep a stable ref so the WS onmessage closure can call loadConversations
  // without capturing a stale version of it.
  useEffect(() => {
    loadConversationsRef.current = loadConversations;
  }, [loadConversations]);

  const loadMessages = useCallback(
    async (convId: string, before?: string): Promise<MMessage[]> => {
      try {
        const url =
          `/api/messenger/conversations/${convId}/messages` +
          (before ? `?before=${encodeURIComponent(before)}` : "");
        const res = await resilientFetch(url);
        if (res.ok) {
          const json = await res.json();
          return json?.data ?? json ?? [];
        }
      } catch {}
      return [];
    },
    []
  );

  const sendMessage = useCallback(
    async (convId: string, body: string): Promise<MMessage | null> => {
      try {
        const res = await resilientFetch(
          `/api/messenger/conversations/${convId}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body }),
          }
        );
        if (res.ok) {
          const json = await res.json();
          const msg: MMessage = json?.data ?? json;
          setConversations((prev) =>
            prev.map((c) =>
              c.id === convId
                ? {
                    ...c,
                    lastMessage: {
                      id: msg.id,
                      body: msg.body,
                      senderId: msg.senderId,
                      createdAt: msg.createdAt,
                    },
                    updatedAt: msg.createdAt,
                  }
                : c
            )
          );
          return msg;
        }
      } catch {}
      return null;
    },
    []
  );

  const markRead = useCallback(async (convId: string) => {
    try {
      await resilientFetch(`/api/messenger/conversations/${convId}/read`, {
        method: "POST",
      });
    } catch {}
    setConversations((prev) =>
      prev.map((c) => (c.id === convId ? { ...c, unreadCount: 0 } : c))
    );
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(
        JSON.stringify({ type: "presence_ping", payload: {} })
      );
    }
  }, []);

  const searchUsers = useCallback(async (q: string): Promise<MUser[]> => {
    if (!q.trim()) return [];
    try {
      const res = await resilientFetch(
        `/api/messenger/users/search?q=${encodeURIComponent(q)}`
      );
      if (res.ok) {
        const json = await res.json();
        return json?.data ?? json ?? [];
      }
    } catch {}
    return [];
  }, []);

  const findOrCreateConversation = useCallback(
    async (otherUserId: string): Promise<string | null> => {
      try {
        const res = await resilientFetch("/api/messenger/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ otherUserId }),
        });
        if (res.ok) {
          const json = await res.json();
          const d = json?.data ?? json;
          return d?.conversationId ?? null;
        }
      } catch {}
      return null;
    },
    []
  );

  const onNewMessage = useCallback((handler: NewMessageHandler) => {
    newMessageHandlers.current.add(handler);
    return () => {
      newMessageHandlers.current.delete(handler);
    };
  }, []);

  const connectWs = useCallback(() => {
    if (!isAuthenticated) return;
    const token = getAccessToken();
    if (!token) return;

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    try {
      const url = getWsUrl(token);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "presence_ping", payload: {} }));
      };

      ws.onmessage = (event) => {
        try {
          const envelope = JSON.parse(event.data as string) as {
            type: string;
            payload: unknown;
          };
          if (envelope.type === "chat_message") {
            const payload = envelope.payload as {
              id: string;
              conversationId: string;
              senderId: string;
              senderName: string;
              body: string;
              createdAt: string;
            };

            for (const h of newMessageHandlers.current) {
              h(payload);
            }

            setConversations((prev) => {
              const isActiveConv =
                activeConvIdRef.current === payload.conversationId;
              const isSelf = payload.senderId === currentUserIdRef.current;
              const exists = prev.some(
                (c) => c.id === payload.conversationId
              );

              if (!exists) {
                // Unknown conversation — refresh the list to pick it up
                loadConversationsRef.current?.();
                return prev;
              }

              return prev.map((c) =>
                c.id === payload.conversationId
                  ? {
                      ...c,
                      unreadCount:
                        isActiveConv || isSelf
                          ? c.unreadCount
                          : c.unreadCount + 1,
                      lastMessage: {
                        id: payload.id,
                        body: payload.body,
                        senderId: payload.senderId,
                        createdAt: payload.createdAt,
                      },
                      updatedAt: payload.createdAt,
                    }
                  : c
              );
            });
          }
        } catch {}
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current && isAuthenticated) {
            connectWs();
          }
        }, 5000);
      };

      ws.onerror = () => {};
    } catch {}
  }, [isAuthenticated]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (isAuthenticated && currentUserId) {
      loadConversations();
      connectWs();
    } else {
      setConversations([]);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
        wsRef.current = null;
      }
    }
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
        wsRef.current = null;
      }
    };
  }, [isAuthenticated, currentUserId]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        loadConversations();
        if (!wsRef.current || wsRef.current.readyState > 1) {
          connectWs();
        }
      }
    });
    return () => sub.remove();
  }, [isAuthenticated, loadConversations, connectWs]);

  return (
    <MessengerContext.Provider
      value={{
        conversations,
        totalUnread,
        loadingConversations,
        loadConversations,
        loadMessages,
        sendMessage,
        markRead,
        searchUsers,
        findOrCreateConversation,
        onNewMessage,
        activeConversationId,
        setActiveConversationId,
      }}
    >
      {children}
    </MessengerContext.Provider>
  );
}

export function useMessenger() {
  const ctx = useContext(MessengerContext);
  if (!ctx) throw new Error("useMessenger must be used within MessengerProvider");
  return ctx;
}
