// Mobile client for the Provider-Lab Messenger REST API
// (artifacts/api-server/src/routes/provider-messenger.ts). Mirrors the
// desktop implementation (components/messenger/*) but talks to the API
// directly via resilientFetch — these endpoints predate the OpenAPI spec and
// have no generated @workspace/api-client-react hooks.
//
// resilientFetch is a pass-through, so every body here is read as
// `body.data.X` (the server's ok() envelope), never `body.X`.
import { useCallback, useMemo, useRef } from "react";
import { Platform } from "react-native";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useListProviderCases } from "@workspace/api-client-react";
import {
  resilientFetch,
  getApiUrl,
  getAccessToken,
  loadTokens,
  refreshAndGetAccessToken,
  getCsrfToken,
  getProviderOrganizationId,
} from "@/lib/query-client";
import { useMe, activeMemberships, primaryProviderOrgId } from "@/lib/auth-me";

export interface MessengerThread {
  id: string;
  providerOrganizationId: string;
  labOrganizationId: string;
  lastMessageAt: string | null;
}

export interface MessengerThreadSummary extends MessengerThread {
  providerOrganizationName: string | null;
  labOrganizationName: string | null;
  unreadCount: number;
  latestMessagePreview: {
    id: string;
    body: string;
    senderUserId: string;
    createdAt: string;
  } | null;
}

export interface MessengerMessage {
  id: string;
  threadId: string;
  senderUserId: string;
  body: string;
  formattingJson: { fontFamily?: string; color?: string } | null;
  mediaKey: string | null;
  mimeType: string | null;
  createdAt: string;
}

const THREADS_QUERY_KEY = ["provider-messenger", "threads"] as const;
export const UNREAD_COUNT_QUERY_KEY = ["provider-messenger", "unread-count"] as const;
export function threadQueryKey(labOrganizationId: string) {
  return ["provider-messenger", "thread", labOrganizationId] as const;
}
export function messagesQueryKey(threadId: string | undefined) {
  return ["provider-messenger", "messages", threadId] as const;
}

async function readEnvelope<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    let message = "";
    try {
      const body = (await res.json()) as { error?: string | { message?: string }; message?: string };
      message =
        typeof body?.error === "string" ? body.error : body?.error?.message ?? body?.message ?? "";
    } catch {
      // Non-JSON error body — fall through to the generic message.
    }
    const err = new Error(message || `${fallback} (${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const body = (await res.json()) as { data: T };
  return body.data;
}

/** Provider: get-or-create the thread for the caller's provider org ↔ this lab. */
export async function getOrCreateProviderThread(labOrganizationId: string): Promise<MessengerThread> {
  const res = await resilientFetch(
    `/api/provider-messenger/thread?labOrganizationId=${encodeURIComponent(labOrganizationId)}`,
  );
  return readEnvelope<MessengerThread>(res, "Could not connect to this lab");
}

/** List every thread the caller participates in (provider or lab side). */
export async function fetchMessengerThreads(): Promise<MessengerThreadSummary[]> {
  const res = await resilientFetch("/api/provider-messenger/threads");
  return readEnvelope<MessengerThreadSummary[]>(res, "Could not load messages");
}

/** Newest-first message page for a thread. */
export async function fetchMessengerMessages(threadId: string, limit = 100): Promise<MessengerMessage[]> {
  const res = await resilientFetch(
    `/api/provider-messenger/thread/${encodeURIComponent(threadId)}/messages?limit=${limit}`,
  );
  return readEnvelope<MessengerMessage[]>(res, "Could not load this conversation");
}

export async function markThreadRead(threadId: string): Promise<void> {
  const res = await resilientFetch(`/api/provider-messenger/thread/${encodeURIComponent(threadId)}/read`, {
    method: "POST",
  });
  await readEnvelope(res, "Could not update read status");
}

export async function fetchMessengerUnreadCount(): Promise<number> {
  const res = await resilientFetch("/api/provider-messenger/unread-count");
  const data = await readEnvelope<{ total: number }>(res, "Could not load unread count");
  return data.total ?? 0;
}

/** URL for a message's media attachment. Must be fetched through AuthedImage
 * (or another authed-media-cache consumer) — it requires a bearer token. */
export function messengerMediaUrl(threadId: string, messageId: string): string {
  return `/api/provider-messenger/thread/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/media`;
}

// ─── Send message (XHR — expo/fetch rejects RN FormData file parts) ─────────

interface SendMessageParams {
  threadId: string;
  text: string;
  imageUri?: string | null;
  imageName?: string | null;
  imageMimeType?: string | null;
}

// Mirrors uploadCaseMedia's buildUploadBody: on web `imageUri` may be a
// blob:/data: URL, which must be materialized into a real Blob before
// FormData.append — appending the RN `{uri,name,type}` descriptor there is a
// silent no-op (the browser's FormData implementation ignores it). Native
// keeps using the RN file descriptor, which its own FormData runtime accepts.
async function buildSendForm(params: SendMessageParams): Promise<FormData> {
  const fd = new FormData();
  if (params.text) fd.append("text", params.text);
  if (params.imageUri) {
    const name = params.imageName ?? "attachment.jpg";
    const type = params.imageMimeType ?? "image/jpeg";
    if (Platform.OS === "web") {
      const blob = await globalThis.fetch(params.imageUri).then((r) => r.blob());
      fd.append("file", blob, name);
    } else {
      fd.append("file", { uri: params.imageUri, name, type } as unknown as Blob);
    }
  }
  return fd;
}

export async function sendMessengerMessage(params: SendMessageParams): Promise<MessengerMessage> {
  await loadTokens();

  const url = new URL(
    `/api/provider-messenger/thread/${encodeURIComponent(params.threadId)}/messages`,
    getApiUrl(),
  ).toString();

  const doSend = (token: string | null) =>
    buildSendForm(params).then(
      (form) =>
        new Promise<MessengerMessage>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", url);
          xhr.onload = () => {
            if (xhr.status < 300) {
              try {
                const body = JSON.parse(xhr.responseText) as { data: MessengerMessage };
                resolve(body.data);
              } catch {
                reject(new Error("Unexpected response from server."));
              }
            } else {
              let message = "";
              try {
                const body = JSON.parse(xhr.responseText) as { error?: string };
                message = body?.error ?? "";
              } catch {}
              const err = new Error(message || `Could not send message (${xhr.status})`) as Error & {
                status?: number;
              };
              err.status = xhr.status;
              reject(err);
            }
          };
          xhr.onerror = () => reject(new Error("Network error"));
          if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
          xhr.setRequestHeader("x-labtrax-client", "mobile/2");
          // Multipart sends bypass resilientFetch, so the active practice has
          // to be stamped here as well — a provider linked to more than one
          // practice is rejected by the server without it.
          const providerOrgId = getProviderOrganizationId();
          if (providerOrgId) {
            xhr.setRequestHeader("x-provider-organization-id", providerOrgId);
          }
          // On web, bearer requests aren't CSRF-exempt because the browser's
          // cookie jar is still active alongside the bearer token — the
          // server's CSRF guard rejects a cookie-bearing POST that lacks the
          // double-submit header. Native has no cookie jar, so it's exempt.
          if (Platform.OS === "web") {
            xhr.withCredentials = true;
            const csrf = getCsrfToken();
            if (csrf) xhr.setRequestHeader("x-csrf-token", csrf);
          }
          xhr.send(form as any);
        }),
    );

  try {
    return await doSend(getAccessToken());
  } catch (err: any) {
    if (err?.status === 401) {
      const newToken = await refreshAndGetAccessToken();
      return await doSend(newToken);
    }
    throw err;
  }
}

// ─── React Query hooks ────────────────────────────────────────────────────

/** Gate: only run messenger queries for users who belong to at least one org
 * (a bare/unaffiliated account can never have a thread). */
function useMessengerEnabled(): boolean {
  const meQuery = useMe();
  return activeMemberships(meQuery.data).length > 0;
}

const UNREAD_POLL_MS = 20_000;

/**
 * Unread total for the messenger badge. `ready` lets a caller hold the request
 * until its tenant context is settled — the provider portal passes "a practice
 * is selected", because a multi-practice provider's request is rejected until
 * the portal knows which practice it is asking about.
 */
export function useMessengerUnreadCount(ready = true): {
  total: number;
  query: UseQueryResult<number>;
} {
  const enabled = useMessengerEnabled() && ready;
  const query = useQuery({
    queryKey: UNREAD_COUNT_QUERY_KEY,
    queryFn: fetchMessengerUnreadCount,
    enabled,
    staleTime: 10_000,
    refetchInterval: UNREAD_POLL_MS,
  });
  return { total: enabled ? query.data ?? 0 : 0, query };
}

export function useMessengerThreads() {
  const enabled = useMessengerEnabled();
  return useQuery({
    queryKey: THREADS_QUERY_KEY,
    queryFn: fetchMessengerThreads,
    enabled,
    staleTime: 5_000,
    refetchInterval: UNREAD_POLL_MS,
  });
}

const MESSAGES_POLL_MS = 5_000;

export function useMessengerMessages(threadId: string | undefined) {
  return useQuery({
    queryKey: messagesQueryKey(threadId),
    queryFn: () => fetchMessengerMessages(threadId as string),
    enabled: !!threadId,
    staleTime: 0,
    refetchInterval: MESSAGES_POLL_MS,
  });
}

export interface ProviderLinkedLab {
  id: string;
  name: string;
}

// Deliberately NOT the generated cases key: the lab list is practice-scoped
// data, and the portal drops practice-scoped caches by prefix on a switch (see
// PRACTICE_SCOPED_QUERY_PREFIXES). Under the generated key the previous
// practice's labs would survive the switch until the entry went stale.
export const PROVIDER_LINKED_LABS_QUERY_KEY = ["provider-cases", "linked-labs"] as const;

/**
 * Labs a provider can message — derived from their assigned cases, mirroring
 * the desktop ProviderMessageLab picker. There is no dedicated
 * "linked labs" endpoint; `labOrganizationId`/`labName` are enriched onto
 * each case by GET /cases/provider specifically so the portal can show the
 * lab without a separate (often admin-gated) organizations call. A provider
 * with zero cases has no way to discover a lab id here yet — the empty state
 * mirrors desktop ("No lab linked yet").
 */
export function useProviderLinkedLabs(enabled: boolean): {
  labs: ProviderLinkedLab[];
  isLoading: boolean;
  isError: boolean;
} {
  const query = useListProviderCases({
    query: {
      queryKey: PROVIDER_LINKED_LABS_QUERY_KEY,
      enabled,
      staleTime: 30_000,
    },
  });

  const labs = useMemo<ProviderLinkedLab[]>(() => {
    const rows = (query.data as { data?: unknown[] } | undefined)?.data ?? [];
    const byId = new Map<string, ProviderLinkedLab>();
    for (const row of rows as Record<string, unknown>[]) {
      const labId = row.labOrganizationId as string | null | undefined;
      if (!labId || byId.has(labId)) continue;
      const labName = row.labName as string | null | undefined;
      byId.set(labId, { id: labId, name: labName ?? labId });
    }
    return Array.from(byId.values());
  }, [query.data]);

  return { labs, isLoading: enabled && query.isLoading, isError: enabled && query.isError };
}

// Re-exported so screens can gate the provider-labs query on "does this user
// have a provider org" without importing auth-me directly.
export { primaryProviderOrgId };

/** Advances the read watermark once per newest-message-id, de-duped across
 * poll cycles, mirroring the desktop ProviderMessengerChat guard. */
export function useMarkThreadRead(threadId: string | undefined) {
  const queryClient = useQueryClient();
  const lastMarkedRef = useRef<string | null>(null);
  const pendingRef = useRef<string | null>(null);

  const mutation = useMutation({
    mutationFn: (latestMsgId: string) => markThreadRead(threadId as string),
    onSuccess: (_data, latestMsgId) => {
      if (latestMsgId === pendingRef.current) {
        lastMarkedRef.current = latestMsgId;
        pendingRef.current = null;
      }
      queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: THREADS_QUERY_KEY });
    },
    onError: (_err, latestMsgId) => {
      if (latestMsgId === pendingRef.current) pendingRef.current = null;
    },
  });

  return useCallback(
    (latestMessageId: string | null) => {
      if (!threadId || !latestMessageId) return;
      if (latestMessageId === lastMarkedRef.current) return;
      if (latestMessageId === pendingRef.current) return;
      pendingRef.current = latestMessageId;
      mutation.mutate(latestMessageId);
    },
    [threadId, mutation],
  );
}
