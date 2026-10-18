import { Platform } from "react-native";
import {
  getAccessToken,
  getApiUrl,
  getCsrfToken,
  loadTokens,
  refreshAndGetAccessToken,
} from "@/lib/query-client";

export const SUPPORT_REPORT_MAX_FILES = 5;
export const SUPPORT_REPORT_MAX_FILE_SIZE = 5 * 1024 * 1024;
export const SUPPORT_REPORT_MAX_TOTAL_SIZE = 10 * 1024 * 1024;

export const SUPPORT_REPORT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
]);

export const SUPPORT_REPORT_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export type SupportReportAttachment = {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
};

export type SupportReportContext =
  | { portal: "lab" }
  | { portal: "provider"; providerOrganizationId: string };

export function validateSupportReportAttachment(
  current: SupportReportAttachment[],
  candidate: SupportReportAttachment,
): string | null {
  if (current.length >= SUPPORT_REPORT_MAX_FILES) return "You can attach up to 5 files.";
  if (!SUPPORT_REPORT_TYPES.has(candidate.mimeType.toLowerCase())) {
    return `${candidate.name} is not a supported file type.`;
  }
  if (candidate.size > SUPPORT_REPORT_MAX_FILE_SIZE) return `${candidate.name} is larger than 5 MiB.`;
  const total = current.reduce((sum, file) => sum + file.size, 0) + candidate.size;
  if (total > SUPPORT_REPORT_MAX_TOTAL_SIZE) return "Attachments must be 10 MiB or smaller in total.";
  return null;
}

async function buildForm(
  description: string,
  attachments: SupportReportAttachment[],
): Promise<FormData> {
  const form = new FormData();
  form.append("description", description.trim());
  for (const attachment of attachments) {
    if (Platform.OS === "web") {
      const blob = await globalThis.fetch(attachment.uri).then((response) => response.blob());
      form.append("attachments", blob, attachment.name);
    } else {
      form.append("attachments", {
        uri: attachment.uri,
        name: attachment.name,
        type: attachment.mimeType,
      } as unknown as Blob);
    }
  }
  return form;
}

export async function submitSupportReport(
  description: string,
  attachments: SupportReportAttachment[],
  context: SupportReportContext,
  kind: "issue" | "feedback" = "issue",
): Promise<{ ok: true; copySent: boolean }> {
  await loadTokens();
  const url = new URL(`/api/support-reports?portal=${context.portal}${kind === "feedback" ? "&kind=feedback" : ""}`, getApiUrl()).toString();

  const send = async (token: string | null) => {
    const form = await buildForm(description, attachments);
    return new Promise<{ ok: true; copySent: boolean }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.onload = () => {
        let body: { ok?: boolean; copySent?: boolean; error?: string } = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status < 300 && body.ok) {
          resolve({ ok: true, copySent: body.copySent === true });
          return;
        }
        const error = new Error(body.error || `Could not submit report (${xhr.status}).`) as Error & {
          status?: number;
        };
        error.status = xhr.status;
        reject(error);
      };
      xhr.onerror = () => reject(new Error("Network error. Please check your connection and try again."));
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      if (context.portal === "provider") {
        xhr.setRequestHeader("x-provider-organization-id", context.providerOrganizationId);
      }
      xhr.setRequestHeader("x-labtrax-client", "mobile/2");
      if (Platform.OS === "web") {
        xhr.withCredentials = true;
        const csrf = getCsrfToken();
        if (csrf) xhr.setRequestHeader("x-csrf-token", csrf);
      }
      xhr.send(form as any);
    });
  };

  try {
    return await send(getAccessToken());
  } catch (error: any) {
    if (error?.status === 401) return send(await refreshAndGetAccessToken());
    throw error;
  }
}