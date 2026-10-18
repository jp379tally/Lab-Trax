import { useEffect, useRef, useCallback, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Loader2, MessageSquare } from "lucide-react";
import { MessengerBubble, type MessengerMessage } from "@/components/messenger/MessengerBubble";
import { MessengerComposer, type FormattingJson } from "@/components/messenger/MessengerComposer";
import { MessengerSearchBar } from "@/components/messenger/MessengerSearchBar";
import { useMessengerSearch } from "@/components/messenger/useMessengerSearch";

// Provider org names are embedded directly in the enriched thread response from
// the server (providerOrganizationName field) so no separate admin-gated
// /organizations lookup is needed. This works for all lab roles.
function resolveProviderName(thread: EnrichedThread): string {
  return thread.providerOrganizationName ?? `Practice ${thread.providerOrganizationId.slice(0, 6)}…`;
}

const POLL_INTERVAL_MS = 4_000;

interface EnrichedThread {
  id: string;
  providerOrganizationId: string;
  labOrganizationId: string;
  providerOrganizationName: string | null;
  labOrganizationName: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  latestMessagePreview: {
    id: string;
    body: string;
    senderUserId: string;
    createdAt: string;
  } | null;
}

function formatPreviewTime(isoStr: string | null | undefined): string {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const now = new Date();
  const diffMins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function OrgAvatar({ name }: { name: string }) {
  const initial = name.trim()[0]?.toUpperCase() ?? "?";
  return (
    <div className="h-10 w-10 shrink-0 rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm font-semibold">
      {initial}
    </div>
  );
}

interface ConversationPanelProps {
  thread: EnrichedThread;
  providerName: string;
  currentUserId: string;
  onRead: () => void;
  /** Called when a mark-read POST fails so the parent can roll back any
   *  optimistic unread-badge suppression it applied on thread selection. */
  onReadError?: () => void;
}

function ConversationPanel({
  thread,
  providerName,
  currentUserId,
  onRead,
  onReadError,
}: ConversationPanelProps) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<MessengerMessage[]>([]);

  const messagesQuery = useQuery<MessengerMessage[]>({
    queryKey: ["provider-messenger", "messages", thread.id],
    queryFn: () =>
      apiFetch<MessengerMessage[]>(
        `/provider-messenger/thread/${thread.id}/messages?limit=100`
      ),
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 0,
  });

  const messages = [...(messagesQuery.data ?? [])].reverse();

  // Poll the provider side's furthest read watermark for the sender's Seen receipt.
  const readWatermarkQuery = useQuery<{
    lastReadMessageId: string | null;
    lastReadMessageCreatedAt: string | null;
  }>({
    queryKey: ["provider-messenger", "read-watermark", thread.id],
    queryFn: () =>
      apiFetch(`/provider-messenger/thread/${thread.id}/read-watermark`),
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 0,
  });

  let lastMineMessageId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].senderUserId === currentUserId) {
      lastMineMessageId = messages[i].id;
      break;
    }
  }
  const otherReadAt = readWatermarkQuery.data?.lastReadMessageCreatedAt
    ? new Date(readWatermarkQuery.data.lastReadMessageCreatedAt).getTime()
    : null;
  const lastMineMessage = messages.find((m) => m.id === lastMineMessageId);
  const lastMineSeen =
    !!lastMineMessage &&
    otherReadAt !== null &&
    otherReadAt >= new Date(lastMineMessage.createdAt).getTime();

  // lastMarkedMessageIdRef: server-confirmed message ID (advanced only on success).
  // pendingMarkReadIdRef:   the message ID currently in-flight.
  //
  // The message ID is passed as the mutation variable so each callback can verify
  // it is handling its own request and not a stale earlier one.  Race to guard:
  //   1. msg-1 → call A starts (pending = msg-1)
  //   2. msg-2 arrives → call B starts (pending = msg-2)
  //   3. B fails → onError resets pending to null (B's ID matches current pending)
  //   4. A succeeds (stale) → A's ID (msg-1) ≠ pending (null) → skip advance
  //      Without this check, A's onSuccess would set lastMarked = pending = null
  //      (previously = msg-2), permanently suppressing the retry for msg-2.
  const lastMarkedMessageIdRef = useRef<string | null>(null);
  const pendingMarkReadIdRef = useRef<string | null>(null);

  const markReadMutation = useMutation({
    mutationFn: (latestMsgId: string | null) =>
      apiFetch(`/provider-messenger/thread/${thread.id}/read`, { method: "POST" }),
    onSuccess: (_data, latestMsgId) => {
      // Only advance the confirmed ref if this success belongs to the currently
      // pending request. A stale earlier success must not mark a newer ID as read.
      if (latestMsgId === pendingMarkReadIdRef.current) {
        lastMarkedMessageIdRef.current = latestMsgId;
        pendingMarkReadIdRef.current = null;
      }
      queryClient.invalidateQueries({ queryKey: ["provider-messenger", "threads"] });
      queryClient.invalidateQueries({ queryKey: ["provider-messenger", "unread-count"] });
      onRead();
    },
    onError: (_err, latestMsgId) => {
      // Reset pending only if this error is for the currently pending ID so a
      // concurrent newer request's pending state is not accidentally cleared.
      if (latestMsgId === pendingMarkReadIdRef.current) {
        pendingMarkReadIdRef.current = null;
      }
      onReadError?.();
    },
  });

  useEffect(() => {
    // messages is oldest-first (reversed from API); newest is at the end
    const latestMsg = messages[messages.length - 1];
    const latestId = latestMsg?.id ?? null;
    // Skip if already confirmed by the server, or if a POST is already in-flight
    if (latestId === lastMarkedMessageIdRef.current) return;
    if (latestId === pendingMarkReadIdRef.current) return;
    pendingMarkReadIdRef.current = latestId;
    markReadMutation.mutate(latestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id, messagesQuery.data]);

  // Clear matched optimistic messages
  useEffect(() => {
    if (optimisticMessages.length > 0 && messagesQuery.data) {
      setOptimisticMessages((prev) =>
        prev.filter(
          (opt) =>
            !messagesQuery.data!.some(
              (real) =>
                real.senderUserId === opt.senderUserId && real.body === opt.body
            )
        )
      );
    }
  }, [messagesQuery.data]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, optimisticMessages.length, scrollToBottom]);

  const sendMutation = useMutation({
    mutationFn: async ({
      text,
      formatting,
      file,
    }: {
      text: string;
      formatting: FormattingJson;
      file: File | null;
    }) => {
      const formData = new FormData();
      if (text) formData.append("text", text);
      if (Object.keys(formatting).length > 0) {
        formData.append("formattingJson", JSON.stringify(formatting));
      }
      if (file) formData.append("file", file);
      return apiFetch<MessengerMessage>(
        `/provider-messenger/thread/${thread.id}/messages`,
        { method: "POST", body: formData }
      );
    },
    onSuccess: () => {
      // Invalidate both queries so the refetch brings back the new message and
      // the thread list updates the preview/timestamp. Do NOT call
      // markReadMutation here — the watermark effect fires after the messages
      // refetch sees the new latestId, giving exactly one POST per send.
      queryClient.invalidateQueries({
        queryKey: ["provider-messenger", "messages", thread.id],
      });
      queryClient.invalidateQueries({ queryKey: ["provider-messenger", "threads"] });
    },
  });

  async function handleSend(text: string, formatting: FormattingJson, file: File | null) {
    const tempId = `opt-${Date.now()}`;
    const optimistic: MessengerMessage = {
      id: tempId,
      threadId: thread.id,
      senderUserId: currentUserId,
      body: text,
      formattingJson: Object.keys(formatting).length > 0 ? formatting : null,
      mediaKey: file ? file.name : null,
      mimeType: file ? file.type : null,
      createdAt: new Date().toISOString(),
    };
    setOptimisticMessages((prev) => [...prev, optimistic]);

    try {
      await sendMutation.mutateAsync({ text, formatting, file });
    } catch (err) {
      // Remove the failed optimistic bubble then re-throw so the composer
      // can restore the draft and surface an error banner to the user.
      setOptimisticMessages((prev) => prev.filter((m) => m.id !== tempId));
      throw err;
    }
  }

  const allMessages = [...messages, ...optimisticMessages];

  const {
    searchQuery,
    setSearchQuery,
    isSearching,
    trimmedQuery,
    displayedMessages,
    isSearchLoading,
    searchHasNoResults,
  } = useMessengerSearch({ threadId: thread.id, loadedMessages: allMessages });

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2.5">
          <OrgAvatar name={providerName} />
          <div>
            <h3 className="text-sm font-semibold leading-tight">{providerName}</h3>
            <p className="text-xs text-muted-foreground">Provider</p>
          </div>
        </div>
      </div>

      <MessengerSearchBar value={searchQuery} onChange={setSearchQuery} />

      {/* Message list */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0"
      >
        {messagesQuery.isLoading && (
          <div className="flex justify-center py-4">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        )}

        {!messagesQuery.isLoading && !isSearching && allMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <div className="text-3xl">💬</div>
            <p className="text-sm">No messages yet</p>
            <p className="text-xs">This provider hasn't sent a message yet.</p>
          </div>
        )}

        {isSearchLoading && (
          <div className="flex justify-center py-4">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        )}

        {searchHasNoResults && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <div className="text-3xl">🔍</div>
            <p className="text-sm">No messages match "{trimmedQuery}"</p>
          </div>
        )}

        {displayedMessages.map((msg) => (
          <MessengerBubble
            key={msg.id}
            message={msg}
            // Lab side: messages from this user are "mine" (right-aligned)
            isMine={msg.senderUserId === currentUserId}
            isPending={msg.id.startsWith("opt-")}
            highlightQuery={isSearching ? trimmedQuery : undefined}
            seen={msg.id === lastMineMessageId && lastMineSeen}
          />
        ))}
      </div>

      {/* Composer */}
      <div className="shrink-0">
        <MessengerComposer
          onSend={handleSend}
          placeholder={`Reply to ${providerName}…`}
        />
      </div>
    </div>
  );
}

export { ConversationPanel };

export default function MessagesPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  // Load threads (polling for live updates)
  const threadsQuery = useQuery<EnrichedThread[]>({
    queryKey: ["provider-messenger", "threads"],
    queryFn: () => apiFetch<EnrichedThread[]>("/provider-messenger/threads"),
    refetchInterval: 10_000,
    staleTime: 0,
  });

  const threads = threadsQuery.data ?? [];

  // Auto-select first thread on load if none selected
  useEffect(() => {
    if (!selectedThreadId && threads.length > 0) {
      setSelectedThreadId(threads[0].id);
    }
  }, [threads, selectedThreadId]);

  const selectedThread = threads.find((t) => t.id === selectedThreadId) ?? null;

  // Optimistic local read state: maps threadId → epoch ms when we "read" it.
  // We overlay unreadCount=0 immediately on selection so the badge clears
  // without waiting for the server watermark round-trip. When the threads
  // query refetches and the server reports unreadCount > 0 with a lastMessageAt
  // AFTER our readAt timestamp, a new message has arrived — we lift the
  // override so the badge reappears. This prevents the "sticky zero" problem
  // where a permanently-growing Set hides badges for subsequent messages.
  const [localReadAt, setLocalReadAt] = useState<Record<string, number>>({});

  // Reconcile: if a new server message arrived after we read a thread, show badge again.
  useEffect(() => {
    if (!threads.length) return;
    setLocalReadAt((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [tid, readAt] of Object.entries(next)) {
        const thread = threads.find((t) => t.id === tid);
        if (!thread) continue;
        if (thread.unreadCount > 0 && thread.lastMessageAt) {
          const serverLastMsgMs = new Date(thread.lastMessageAt).getTime();
          if (serverLastMsgMs > readAt) {
            // A message arrived after we read → remove the optimistic override
            delete next[tid];
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [threads]);

  function handleSelectThread(threadId: string) {
    setSelectedThreadId(threadId);
    setLocalReadAt((prev) => ({ ...prev, [threadId]: Date.now() }));
    queryClient.invalidateQueries({ queryKey: ["provider-messenger", "unread-count"] });
  }

  function handleReadCallback() {
    queryClient.invalidateQueries({ queryKey: ["provider-messenger", "threads"] });
  }

  function handleReadErrorCallback() {
    // Roll back the optimistic badge suppression for the selected thread so
    // the unread count reappears rather than being stuck at 0 after a failed
    // mark-read POST.
    if (selectedThreadId) {
      setLocalReadAt((prev) => {
        const next = { ...prev };
        delete next[selectedThreadId];
        return next;
      });
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Thread list — left column */}
      <div className="w-72 shrink-0 border-r border-border flex flex-col min-h-0 bg-card">
        <div className="shrink-0 px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Messages</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Provider conversations
          </p>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {threadsQuery.isLoading && (
            <div className="flex justify-center py-6">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          )}

          {!threadsQuery.isLoading && threads.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 px-4 gap-2 text-muted-foreground">
              <MessageSquare size={28} strokeWidth={1.5} />
              <p className="text-sm text-center">No conversations yet</p>
              <p className="text-xs text-center">
                Provider messages will appear here.
              </p>
            </div>
          )}

          {threads.map((thread) => {
            const providerName = resolveProviderName(thread);
            const isSelected = thread.id === selectedThreadId;
            const isRead = localReadAt[thread.id] !== undefined;
            const unread = isRead ? 0 : (thread.unreadCount ?? 0);

            return (
              <button
                key={thread.id}
                type="button"
                onClick={() => handleSelectThread(thread.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-border/50 last:border-b-0 ${
                  isSelected
                    ? "bg-primary/8 border-l-2 border-l-primary"
                    : "hover:bg-muted/50"
                }`}
              >
                <div className="relative shrink-0">
                  <OrgAvatar name={providerName} />
                  {unread > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center px-1 leading-none">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span
                      className={`text-sm truncate ${unread > 0 ? "font-semibold" : "font-medium"}`}
                    >
                      {providerName}
                    </span>
                    {thread.latestMessagePreview && (
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {formatPreviewTime(thread.latestMessagePreview.createdAt)}
                      </span>
                    )}
                  </div>

                  {thread.latestMessagePreview && (
                    <p
                      className={`text-xs truncate mt-0.5 ${
                        unread > 0
                          ? "text-foreground/80 font-medium"
                          : "text-muted-foreground"
                      }`}
                    >
                      {thread.latestMessagePreview.senderUserId === user?.id
                        ? "You: "
                        : ""}
                      {thread.latestMessagePreview.body || "📎 Attachment"}
                    </p>
                  )}

                  {!thread.latestMessagePreview && (
                    <p className="text-xs text-muted-foreground mt-0.5">No messages yet</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Conversation area — right column */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {selectedThread ? (
          <ConversationPanel
            key={selectedThread.id}
            thread={selectedThread}
            providerName={resolveProviderName(selectedThread)}
            currentUserId={user?.id ?? ""}
            onRead={handleReadCallback}
            onReadError={handleReadErrorCallback}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <MessageSquare size={36} strokeWidth={1.5} />
            <p className="text-sm">Select a conversation to view messages</p>
          </div>
        )}
      </div>
    </div>
  );
}
