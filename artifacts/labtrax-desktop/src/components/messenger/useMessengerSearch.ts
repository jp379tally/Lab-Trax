import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { MessengerMessage } from "./MessengerBubble";

interface UseMessengerSearchOptions {
  threadId: string | undefined;
  /** Currently loaded/visible messages (any order); used for instant client-side filtering. */
  loadedMessages: MessengerMessage[];
}

interface UseMessengerSearchResult {
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  isSearching: boolean;
  trimmedQuery: string;
  /** Messages to render: full conversation when not searching, matches (loaded + server) when searching. */
  displayedMessages: MessengerMessage[];
  isSearchLoading: boolean;
  searchHasNoResults: boolean;
}

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Powers the conversation search box: instantly filters whatever messages are
 * already loaded on the client, and — once the query settles — also queries
 * the server (`?q=`) so matches from older history not yet paged in are
 * surfaced too. Results are merged by message id and re-sorted chronologically.
 */
export function useMessengerSearch({
  threadId,
  loadedMessages,
}: UseMessengerSearchOptions): UseMessengerSearchResult {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const trimmed = searchQuery.trim();
    const timer = setTimeout(() => setDebouncedQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 0;

  const searchResultsQuery = useQuery<MessengerMessage[]>({
    queryKey: ["provider-messenger", "messages-search", threadId, debouncedQuery],
    queryFn: () =>
      apiFetch<MessengerMessage[]>(
        `/provider-messenger/thread/${threadId}/messages?q=${encodeURIComponent(debouncedQuery)}&limit=200`
      ),
    enabled: !!threadId && debouncedQuery.length > 0,
    staleTime: 0,
  });

  const displayedMessages = useMemo(() => {
    if (!isSearching) return loadedMessages;
    const q = trimmedQuery.toLowerCase();
    const merged = new Map<string, MessengerMessage>();
    for (const msg of loadedMessages) {
      if (msg.body.toLowerCase().includes(q)) merged.set(msg.id, msg);
    }
    for (const msg of searchResultsQuery.data ?? []) {
      merged.set(msg.id, msg);
    }
    return [...merged.values()].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, [loadedMessages, isSearching, trimmedQuery, searchResultsQuery.data]);

  const isSearchLoading =
    isSearching && debouncedQuery === trimmedQuery && searchResultsQuery.isFetching;
  const searchHasNoResults =
    isSearching && !isSearchLoading && displayedMessages.length === 0;

  return {
    searchQuery,
    setSearchQuery,
    isSearching,
    trimmedQuery,
    displayedMessages,
    isSearchLoading,
    searchHasNoResults,
  };
}
