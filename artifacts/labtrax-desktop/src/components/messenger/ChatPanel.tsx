import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Minus, Send, Smile, X } from "lucide-react";
import { useMessenger, type ChatMessage } from "@/context/MessengerContext";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

interface Props {
  conversationId: string;
  minimized: boolean;
}

const EMOJI_LIST = [
  "😀","😂","😍","🥹","😊","😎","😅","😭","😤","🥲",
  "👍","👎","❤️","🔥","🎉","👋","🙏","💯","🤔","🤦",
  "💪","🙌","😬","🤷","🫡","✅","🦷","🔬","💊","⭐",
];

type FlatItem =
  | { kind: "day-header"; label: string; dateStr: string }
  | { kind: "message"; msg: ChatMessage };

function relativeTime(dateStr: string | Date): string {
  const d = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-3 py-2">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 bg-white/60 rounded-full animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

export function ChatPanel({ conversationId, minimized }: Props) {
  const { user } = useAuth();
  const {
    conversations,
    onlineUserIds,
    typingMap,
    seenMap,
    closePanel,
    toggleMinimize,
    markRead,
    sendTypingStart,
    sendTypingStop,
  } = useMessenger();

  const conv = conversations.find((c) => c.id === conversationId);
  const other = conv?.otherUser ?? null;
  const isOnline = other ? onlineUserIds.has(other.id) : false;
  const typingUsers = typingMap.get(conversationId);
  const someoneTyping = typingUsers && typingUsers.size > 0;

  const seenMessageId = other
    ? (seenMap.get(`${conversationId}:${other.id}`) ?? null)
    : null;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  function handleScroll() {
    const el = scrollParentRef.current;
    if (!el) return;
    userScrolledUp.current = el.scrollHeight - el.scrollTop - el.clientHeight > 80;
  }

  const loadMessages = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiFetch<ChatMessage[]>(
        `/messenger/conversations/${conversationId}/messages`
      );
      setMessages(data);
      if (data.length > 0) {
        const last = data[data.length - 1];
        if (last) markRead(conversationId, last.id);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [conversationId, markRead]);

  useEffect(() => {
    if (!minimized) loadMessages();
  }, [minimized, loadMessages]);

  const flatItems = useMemo<FlatItem[]>(() => {
    const result: FlatItem[] = [];
    const seenDates = new Set<string>();
    for (const msg of messages) {
      const d =
        typeof msg.createdAt === "string"
          ? new Date(msg.createdAt)
          : msg.createdAt;
      const dateStr = d.toDateString();
      if (!seenDates.has(dateStr)) {
        seenDates.add(dateStr);
        result.push({
          kind: "day-header",
          label: d.toLocaleDateString([], {
            weekday: "short",
            month: "short",
            day: "numeric",
          }),
          dateStr,
        });
      }
      result.push({ kind: "message", msg });
    }
    return result;
  }, [messages]);

  const totalCount = flatItems.length + (someoneTyping ? 1 : 0);

  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: (index) => {
      if (someoneTyping && index === flatItems.length) return 40;
      const item = flatItems[index];
      if (!item) return 40;
      return item.kind === "day-header" ? 28 : 56;
    },
    overscan: 5,
  });

  useEffect(() => {
    if (totalCount > 0 && !loading && !userScrolledUp.current) {
      virtualizer.scrollToIndex(totalCount - 1, { behavior: "smooth" });
    }
  }, [totalCount, loading, virtualizer]);

  useEffect(() => {
    const handleIncoming = (event: Event) => {
      const e = event as CustomEvent<ChatMessage>;
      if (e.detail.conversationId !== conversationId) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === e.detail.id)) return prev;
        return [...prev, e.detail];
      });
      if (e.detail.senderId !== (user?.id ?? "") && !minimized) {
        markRead(conversationId, e.detail.id);
      }
    };
    window.addEventListener(
      `messenger:message:${conversationId}`,
      handleIncoming
    );
    return () =>
      window.removeEventListener(
        `messenger:message:${conversationId}`,
        handleIncoming
      );
  }, [conversationId, user, markRead]);

  async function sendMessage() {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setBody("");
    setEmojiOpen(false);
    if (typingTimer.current) {
      clearTimeout(typingTimer.current);
      typingTimer.current = null;
      sendTypingStop(conversationId);
    }
    const ta = textareaRef.current;
    if (ta) ta.style.height = "auto";
    try {
      const msg = await apiFetch<ChatMessage>(
        `/messenger/conversations/${conversationId}/messages`,
        { method: "POST", body: JSON.stringify({ body: trimmed }) }
      );
      setMessages((prev) =>
        prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]
      );
    } catch {
      setBody(trimmed);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function handleBodyChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setBody(e.target.value);
    if (!typingTimer.current) sendTypingStart(conversationId);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      sendTypingStop(conversationId);
      typingTimer.current = null;
    }, 3_000);
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 100)}px`;
    }
  }

  function insertEmoji(emoji: string) {
    const ta = textareaRef.current;
    if (!ta) {
      setBody((b) => b + emoji);
      setEmojiOpen(false);
      return;
    }
    const start = ta.selectionStart ?? body.length;
    const end = ta.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + emoji + body.slice(end));
    setEmojiOpen(false);
    setTimeout(() => {
      ta.focus();
      const pos = start + emoji.length;
      ta.setSelectionRange(pos, pos);
    }, 0);
  }

  const initials = other?.initials ?? "?";
  const displayName = other?.displayName ?? "Chat";

  if (minimized) {
    return (
      <div
        className="w-72 bg-[#1c2433] border border-white/10 rounded-t-2xl shadow-2xl flex items-center justify-between px-3 py-2 cursor-pointer select-none text-white"
        onClick={() => toggleMinimize(conversationId)}
      >
        <div className="flex items-center gap-2">
          <div className="relative">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-xs font-bold">
              {initials.slice(0, 2)}
            </div>
            {isOnline && (
              <span className="absolute bottom-0 right-0 w-2 h-2 bg-green-400 border border-[#1c2433] rounded-full" />
            )}
          </div>
          <span className="text-sm font-semibold truncate max-w-[140px]">
            {displayName}
          </span>
          {(conv?.unreadCount ?? 0) > 0 && (
            <span className="w-4 h-4 bg-blue-500 rounded-full text-[10px] font-bold flex items-center justify-center">
              {conv!.unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <ChevronDown size={14} className="text-white/60" />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              closePanel(conversationId);
            }}
            className="w-6 h-6 rounded-full hover:bg-white/20 flex items-center justify-center"
          >
            <X size={12} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-72 h-[420px] bg-[#1c2433] border border-white/10 rounded-t-2xl shadow-2xl flex flex-col text-white overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-white/10 flex-shrink-0 cursor-pointer"
        onClick={() => toggleMinimize(conversationId)}
      >
        <div className="relative flex-shrink-0">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-xs font-bold">
            {initials.slice(0, 2)}
          </div>
          {isOnline && (
            <span className="absolute bottom-0 right-0 w-2 h-2 bg-green-400 border border-[#1c2433] rounded-full" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">{displayName}</div>
          <div className="text-[10px] text-white/50">
            {isOnline ? "Active now" : "Offline"}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleMinimize(conversationId);
            }}
            className="w-6 h-6 rounded-full hover:bg-white/20 flex items-center justify-center"
            title="Minimize"
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              closePanel(conversationId);
            }}
            className="w-6 h-6 rounded-full hover:bg-white/20 flex items-center justify-center"
            title="Close"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div
        ref={scrollParentRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/20"
      >
        {loading && (
          <div className="text-center text-white/40 text-xs py-6">
            Loading…
          </div>
        )}
        {!loading && flatItems.length === 0 && !someoneTyping && (
          <div className="text-center text-white/40 text-xs py-8">
            No messages yet. Say hi!
          </div>
        )}
        {!loading && (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              if (someoneTyping && vItem.index === flatItems.length) {
                return (
                  <div
                    key="typing-indicator"
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vItem.start}px)`,
                    }}
                    className="px-3 py-1 flex justify-start"
                  >
                    <div className="bg-white/15 rounded-2xl rounded-bl-sm">
                      <TypingDots />
                    </div>
                  </div>
                );
              }

              const item = flatItems[vItem.index];
              if (!item) return null;

              if (item.kind === "day-header") {
                return (
                  <div
                    key={`hdr:${item.dateStr}`}
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vItem.start}px)`,
                    }}
                    className="text-center text-[10px] text-white/30 py-2 select-none"
                  >
                    {item.label}
                  </div>
                );
              }

              const { msg } = item;
              const isMe = msg.senderId === (user?.id ?? "");
              const isSeenHere = isMe && seenMessageId === msg.id;

              return (
                <div
                  key={msg.id}
                  data-index={vItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vItem.start}px)`,
                  }}
                  className={`px-3 py-0.5 flex ${isMe ? "justify-end" : "justify-start"}`}
                >
                  <div className="max-w-[80%]">
                    {isMe ? (
                      <div
                        className="px-3 py-1.5 rounded-2xl rounded-br-sm text-sm leading-snug break-words bg-blue-600 text-white"
                      >
                        {msg.body}
                      </div>
                    ) : (
                      <div className="flex items-end gap-1.5">
                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-[9px] font-bold flex-shrink-0 mb-1">
                          {msg.sender.initials.slice(0, 2)}
                        </div>
                        <div className="px-3 py-1.5 rounded-2xl rounded-bl-sm text-sm leading-snug break-words bg-white/15 text-white">
                          {msg.body}
                        </div>
                      </div>
                    )}
                    <div
                      className={`text-[10px] text-white/40 mt-0.5 flex items-center gap-1 ${isMe ? "justify-end" : "justify-start"}`}
                    >
                      {relativeTime(msg.createdAt)}
                      {isSeenHere && (
                        <span className="text-blue-400 font-medium">
                          · Seen
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex-shrink-0 px-2 py-2 border-t border-white/10 relative">
        {emojiOpen && (
          <div className="absolute bottom-full left-2 mb-1 bg-[#2a3447] border border-white/10 rounded-xl p-2 grid grid-cols-10 gap-0.5 shadow-2xl z-10">
            {EMOJI_LIST.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => insertEmoji(emoji)}
                className="text-lg w-7 h-7 flex items-center justify-center rounded hover:bg-white/20 transition-colors"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <button
            type="button"
            onClick={() => setEmojiOpen((v) => !v)}
            className="w-7 h-7 rounded-full hover:bg-white/15 flex items-center justify-center flex-shrink-0 mb-0.5 transition-colors text-white/60 hover:text-white"
            title="Emoji"
          >
            <Smile size={15} />
          </button>
          <textarea
            ref={textareaRef}
            value={body}
            onChange={handleBodyChange}
            onKeyDown={handleKeyDown}
            placeholder="Aa"
            rows={1}
            className="flex-1 resize-none bg-white/10 text-white text-sm placeholder:text-white/40 rounded-2xl px-3 py-2 focus:outline-none focus:bg-white/15 transition-colors max-h-[100px] overflow-y-auto scrollbar-thin"
          />
          <button
            type="button"
            onClick={sendMessage}
            disabled={!body.trim() || sending}
            className="w-8 h-8 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center flex-shrink-0 mb-0.5 transition-colors"
          >
            <Send size={14} className="text-white" />
          </button>
        </div>
      </div>
    </div>
  );
}
