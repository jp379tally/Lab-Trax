// Mobile client for the provider's one-way lab-inbox drop box
// (artifacts/api-server/src/routes/lab-inbox.ts: GET /provider-sent,
// POST /provider-upload) — what the portal's "Sent" view is built on.
//
// This is a separate feature from the live messenger (lib/messenger.ts): a
// note/file dropped here lands in the lab's inbox, not in the conversation.
// Desktop keeps the same split (ProviderSentNotes vs ProviderMessengerChat),
// and this module mirrors its contract exactly — same endpoints, same query
// key, same accepted file types — so the two clients cannot drift.
//
// The send is an XHR rather than resilientFetch for the same reason
// sendMessengerMessage is: expo/fetch rejects React Native's FormData file
// descriptor, so a multipart upload has to go through XMLHttpRequest.
import { Platform } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { providerRequest } from "@/lib/provider-api";
import {
  getAccessToken,
  getApiUrl,
  getCsrfToken,
  getProviderOrganizationId,
  loadTokens,
  refreshAndGetAccessToken,
} from "@/lib/query-client";

/** One previous submission by the signed-in provider to one lab's inbox. */
export interface ProviderSentItem {
  id: string;
  note: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  linkedCaseIds: string | null;
  createdAt: string;
}

// The server rejects anything else (providerInboxFileMatchesDeclaration also
// sniffs the bytes), and desktop's file input advertises exactly this list.
export const PROVIDER_INBOX_ACCEPTED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

export const PROVIDER_INBOX_UNSUPPORTED_FILE_MESSAGE =
  "That file type is not supported. Please attach a PDF or image (JPEG, PNG, GIF, WebP, or HEIC).";

export function isAcceptedProviderInboxMimeType(
  mimeType: string | null | undefined,
): boolean {
  if (!mimeType) return false;
  const normalized = mimeType.split(";")[0]!.trim().toLowerCase();
  return (PROVIDER_INBOX_ACCEPTED_MIME_TYPES as readonly string[]).includes(normalized);
}

/** Same key desktop uses, so the two stay describable as one cache entry. */
export function providerSentQueryKey(labOrganizationId: string) {
  return ["lab-inbox", "provider-sent", labOrganizationId] as const;
}

export function fetchProviderSentItems(
  labOrganizationId: string,
): Promise<ProviderSentItem[]> {
  return providerRequest<ProviderSentItem[]>(
    `/api/lab-inbox/provider-sent?labOrganizationId=${encodeURIComponent(labOrganizationId)}`,
  );
}

export function useProviderSentItems(labOrganizationId: string) {
  return useQuery({
    queryKey: providerSentQueryKey(labOrganizationId),
    queryFn: () => fetchProviderSentItems(labOrganizationId),
    staleTime: 5_000,
  });
}

export interface ProviderInboxAttachment {
  uri: string;
  name: string;
  mimeType: string;
}

export interface SendProviderInboxItemParams {
  labOrganizationId: string;
  note: string;
  file?: ProviderInboxAttachment | null;
}

// Mirrors buildSendForm in lib/messenger.ts: on web the picked uri may be a
// blob:/data: URL, which must be materialized into a real Blob because the
// browser's FormData silently ignores the RN `{uri,name,type}` descriptor.
async function buildInboxForm(params: SendProviderInboxItemParams): Promise<FormData> {
  const fd = new FormData();
  if (params.note) fd.append("note", params.note);
  const file = params.file;
  if (file) {
    if (Platform.OS === "web") {
      const blob = await globalThis.fetch(file.uri).then((r) => r.blob());
      fd.append("file", blob, file.name);
    } else {
      fd.append("file", {
        uri: file.uri,
        name: file.name,
        type: file.mimeType,
      } as unknown as Blob);
    }
  }
  return fd;
}

export async function sendProviderInboxItem(
  params: SendProviderInboxItemParams,
): Promise<void> {
  await loadTokens();

  const url = new URL(
    `/api/lab-inbox/provider-upload?labOrganizationId=${encodeURIComponent(params.labOrganizationId)}`,
    getApiUrl(),
  ).toString();

  const doSend = (token: string | null) =>
    buildInboxForm(params).then(
      (form) =>
        new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", url);
          xhr.onload = () => {
            if (xhr.status < 300) {
              resolve();
              return;
            }
            let message = "";
            try {
              const body = JSON.parse(xhr.responseText) as {
                error?: string | { message?: string };
                message?: string;
              };
              message =
                typeof body?.error === "string"
                  ? body.error
                  : body?.error?.message ?? body?.message ?? "";
            } catch {
              // Non-JSON error body — fall through to the generic message.
            }
            const err = new Error(message || `Could not send (${xhr.status})`) as Error & {
              status?: number;
            };
            err.status = xhr.status;
            reject(err);
          };
          xhr.onerror = () => reject(new Error("Network error"));
          if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
          xhr.setRequestHeader("x-labtrax-client", "mobile/2");
          // Provider requests are tenant-scoped; the shared request layer
          // stamps this header on every fetch, so a hand-built XHR has to too.
          const providerOrgId = getProviderOrganizationId();
          if (providerOrgId) {
            xhr.setRequestHeader("x-provider-organization-id", providerOrgId);
          }
          // On web the cookie jar is still active alongside the bearer token,
          // so the server's CSRF guard requires the double-submit header.
          // Native has no cookie jar and is exempt.
          if (Platform.OS === "web") {
            xhr.withCredentials = true;
            const csrf = getCsrfToken();
            if (csrf) xhr.setRequestHeader("x-csrf-token", csrf);
          }
          xhr.send(form as unknown as XMLHttpRequestBodyInit);
        }),
    );

  try {
    return await doSend(getAccessToken());
  } catch (err: unknown) {
    if ((err as { status?: number })?.status === 401) {
      const newToken = await refreshAndGetAccessToken();
      return await doSend(newToken);
    }
    throw err;
  }
}

/**
 * Send a note and/or file, then refresh the sent list so the new entry shows
 * without the provider reloading anything.
 */
export function useSendProviderInboxItem(labOrganizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { note: string; file: ProviderInboxAttachment | null }) =>
      sendProviderInboxItem({ labOrganizationId, note: vars.note, file: vars.file }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: providerSentQueryKey(labOrganizationId) }),
  });
}
