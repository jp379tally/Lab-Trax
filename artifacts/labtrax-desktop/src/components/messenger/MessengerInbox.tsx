import { useEffect, useRef, useState } from "react";
import { Pencil, Search, X } from "lucide-react";
import { useMessenger, type OtherUser } from "@/context/MessengerContext";
import { apiFetch } from "@/lib/api";

function relativeTime(dateStr: string | Date): string {
  const d = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

interface SearchResult extends OtherUser {}

export function MessengerInbox() {
  const {
    conversations,
    onlineUserIds,
    closeInbox,
    openConversation,
    findOrCreateConversation,
  } = useMessenger();

  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const results = await apiFetch<SearchResult[]>(
          `/messenger/users/search?q=${encodeURIComponent(query)}`
        );
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeInbox();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closeInbox]);

  async function handleUserClick(userId: string) {
    const convId = await findOrCreateConversation(userId);
    openConversation(convId);
  }

  return (
    <div
      ref={containerRef}
      className="w-[360px] max-h-[520px] bg-[#1c2433] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-white"
    >
      <div className="px-4 py-3 flex items-center justify-between border-b border-white/10 flex-shrink-0">
        <h2 className="font-bold text-base">Chats</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            title="New chat"
            className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors"
            onClick={() => setQuery("")}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={closeInbox}
            className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="px-4 py-2 flex-shrink-0">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40"
          />
          <input
            type="text"
            placeholder="Search Messenger"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full h-9 pl-9 pr-3 rounded-full bg-white/10 text-sm placeholder:text-white/40 focus:outline-none focus:bg-white/15 transition-colors"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/20">
        {query.trim() ? (
          <div>
            {searching && (
              <div className="px-4 py-3 text-white/50 text-sm text-center">
                Searching…
              </div>
            )}
            {!searching && searchResults.length === 0 && (
              <div className="px-4 py-3 text-white/50 text-sm text-center">
                No users found
              </div>
            )}
            {searchResults.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => handleUserClick(u.id)}
                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/10 transition-colors text-left"
              >
                <div className="relative flex-shrink-0">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-xs font-bold">
                    {u.initials.slice(0, 2)}
                  </div>
                  {onlineUserIds.has(u.id) && (
                    <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-400 border-2 border-[#1c2433] rounded-full" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{u.displayName}</div>
                  <div className="text-xs text-white/50 truncate">@{u.username}</div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div>
            {conversations.length === 0 && (
              <div className="px-4 py-8 text-white/40 text-sm text-center">
                No conversations yet
              </div>
            )}
            {conversations.map((conv) => {
              if (!conv.otherUser) return null;
              const other = conv.otherUser;
              const isOnline = onlineUserIds.has(other.id);
              const preview = conv.lastMessage?.body ?? "";
              const time = conv.lastMessage?.createdAt
                ? relativeTime(conv.lastMessage.createdAt)
                : "";
              return (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => openConversation(conv.id)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/10 transition-colors text-left"
                >
                  <div className="relative flex-shrink-0">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-xs font-bold">
                      {other.initials.slice(0, 2)}
                    </div>
                    {isOnline && (
                      <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-400 border-2 border-[#1c2433] rounded-full" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-sm truncate ${
                          conv.unreadCount > 0 ? "font-bold" : "font-medium"
                        }`}
                      >
                        {other.displayName}
                      </span>
                      <span className="text-[11px] text-white/50 flex-shrink-0">
                        {time}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span
                        className={`text-xs truncate ${
                          conv.unreadCount > 0
                            ? "font-semibold text-white"
                            : "text-white/50"
                        }`}
                      >
                        {preview || "No messages yet"}
                      </span>
                      {conv.unreadCount > 0 && (
                        <span className="ml-auto flex-shrink-0 w-2 h-2 bg-blue-400 rounded-full" />
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
