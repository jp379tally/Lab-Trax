import { useEffect, useRef, useCallback, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Loader2 } from "lucide-react";
import { MessengerBubble, type MessengerMessage } from "./MessengerBubble";
import { MessengerComposer, type FormattingJson } from "./MessengerComposer";
import { MessengerSearchBar } from "./MessengerSearchBar";
import { useMessengerSearch } from "./useMessengerSearch";

const POLL_INTERVAL_MS = 4_000;

interface Thread {
  id: string;
  providerOrganizationId: string;
  labOrganizationId: string;
  lastMessageAt: string | null;
}

interface ProviderMessengerChatProps {
  labOrganizationId: string;
  labName?: string;
}

export function ProviderMessengerChat({
  labOrganizationId,
  labName,
}: ProviderMessengerChatProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<MessengerMessage[]>([]);

  // Step 1: resolve/create the thread for this provider ↔ lab pair
  const threadQuery = useQuery<Thread>({
    queryKey: ["provider-messenger", "thread", labOrganizationId],
    queryFn: () =>
      apiFetch<Thread>(
        `/provider-messenger/thread?labOrganizationId=${encodeURIComponent(labOrganizationId)}`
      ),
    staleTime: Infinity,
    retry: 1,
  });

  const threadId = threadQuery.data?.id;

  // Step 2: poll messages every 4 seconds
  const messagesQuery = useQuery<MessengerMessage[]>({
    queryKey: ["provider-messenger", "messages", threadId],
    queryFn: () =>
      apiFetch<MessengerMessage[]>(`/provider-messenger/thread/${threadId}/messages?limit=100`),
    enabled: !!threadId,
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 0,
  });

  // Messages come back newest-first; reverse for display (oldest at top)
  const messages: MessengerMessage[] = [...(messagesQuery.data ?? [])].reverse();

  // Poll the lab side's furthest read watermark for the sender's Seen receipt.
  const readWatermarkQuery = useQuery<{
    lastReadMessageId: string | null;
    lastReadMessageCreatedAt: string | null;
  }>({
    queryKey: ["provider-messenger", "read-watermark", threadId],
    queryFn: () =>
      apiFetch(`/provider-messenger/thread/${threadId}/read-watermark`),
    enabled: !!threadId,
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 0,
  });

  let lastMineMessageId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].senderUserId === user?.id) {
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

  // lastMarkedMessageIdRef: the ID successfully confirmed by the server.
  // pendingMarkReadIdRef:   the ID currently in-flight (not yet confirmed).
  //
  // The ref is advanced ONLY in onSuccess so that a failed POST does not
  // silently suppress retry. On error we reset pending, allowing the next
  // poll cycle (which sees the same latestId ≠ lastMarked) to re-fire.
  // lastMarkedMessageIdRef: server-confirmed message ID (advanced only on success).
  // pendingMarkReadIdRef:   the message ID currently in-flight.
  //
  // Both the ID being marked AND the threadId are passed as the mutation variable
  // so each callback can verify it is handling the request it started and not a
  // stale earlier one.  Scenario to guard:
  //   1. msg-1 → call A starts (pending = msg-1)
  //   2. msg-2 arrives → call B starts (pending = msg-2)
  //   3. B fails → pending reset to null
  //   4. A succeeds (stale) → if we blindly used pending.current here we'd record
  //      msg-2 as confirmed even though B failed; instead we compare the variable.
  const lastMarkedMessageIdRef = useRef<string | null>(null);
  const pendingMarkReadIdRef = useRef<string | null>(null);

  const markReadMutation = useMutation({
    mutationFn: ({ tid, latestMsgId }: { tid: string; latestMsgId: string | null }) =>
      apiFetch(`/provider-messenger/thread/${tid}/read`, { method: "POST" }),
    onSuccess: (_data, { latestMsgId }) => {
      // Only advance the confirmed ref if this success belongs to the currently
      // pending request. A stale earlier success must not mark a newer ID as read.
      if (latestMsgId === pendingMarkReadIdRef.current) {
        lastMarkedMessageIdRef.current = latestMsgId;
        pendingMarkReadIdRef.current = null;
      }
      queryClient.invalidateQueries({ queryKey: ["provider-messenger", "unread-count"] });
    },
    onError: (_err, { latestMsgId }) => {
      // Reset pending only if this error is for the currently pending ID so a
      // concurrent newer request's pending state is not accidentally cleared.
      if (latestMsgId === pendingMarkReadIdRef.current) {
        pendingMarkReadIdRef.current = null;
      }
    },
  });

  useEffect(() => {
    if (!threadId) return;
    // messages is reversed (oldest-first); the newest is at the end
    const latestMsg = messages[messages.length - 1];
    const latestId = latestMsg?.id ?? null;
    // Skip if already successfully marked, or if a POST for this ID is in-flight
    if (latestId === lastMarkedMessageIdRef.current) return;
    if (latestId === pendingMarkReadIdRef.current) return;
    pendingMarkReadIdRef.current = latestId;
    markReadMutation.mutate({ tid: threadId, latestMsgId: latestId });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, messagesQuery.data]);

  // Clear optimistic messages once real messages arrive with the same count or more
  useEffect(() => {
    if (optimisticMessages.length > 0 && messagesQuery.data) {
      // Remove optimistic messages that are now persisted (by matching body + sender)
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

  // Auto-scroll to bottom when new messages arrive
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
      if (!threadId) throw new Error("Thread not ready.");
      const formData = new FormData();
      if (text) formData.append("text", text);
      if (Object.keys(formatting).length > 0) {
        formData.append("formattingJson", JSON.stringify(formatting));
      }
      if (file) formData.append("file", file);
      return apiFetch<MessengerMessage>(`/provider-messenger/thread/${threadId}/messages`, {
        method: "POST",
        body: formData,
      });
    },
    onSuccess: () => {
      // Invalidate messages so the refetch brings the persisted message back.
      // Do NOT call markReadMutation here — the watermark effect fires after
      // the refetch sees the new latestId, giving exactly one POST per send.
      queryClient.invalidateQueries({
        queryKey: ["provider-messenger", "messages", threadId],
      });
    },
  });

  async function handleSend(text: string, formatting: FormattingJson, file: File | null) {
    if (!threadId || !user) return;

    // Optimistic bubble
    const tempId = `opt-${Date.now()}`;
    const optimistic: MessengerMessage = {
      id: tempId,
      threadId: threadId,
      senderUserId: user.id,
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

  // Must be called unconditionally, before the early returns below, so hook
  // order stays stable across the loading/error/loaded render paths.
  const {
    searchQuery,
    setSearchQuery,
    isSearching,
    trimmedQuery,
    displayedMessages,
    isSearchLoading,
    searchHasNoResults,
  } = useMessengerSearch({ threadId, loadedMessages: allMessages });

  if (threadQuery.isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (threadQuery.isError) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-sm text-muted-foreground">
          <p>Could not connect to {labName ?? "the lab"}.</p>
          <p className="text-xs mt-1">You may not be linked to this lab yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">{labName ?? "Lab"}</h3>
        <p className="text-xs text-muted-foreground">Direct message</p>
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
            <p className="text-xs">Send a message to start the conversation.</p>
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
            isMine={msg.senderUserId === user?.id}
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
          disabled={!threadId}
          placeholder={`Message ${labName ?? "the lab"}…`}
        />
      </div>
    </div>
  );
}
