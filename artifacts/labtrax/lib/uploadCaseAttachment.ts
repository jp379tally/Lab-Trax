// Shared upload pipeline for case attachments on mobile.
//
// Two steps, mirroring the desktop flow:
//   1. Chunked binary upload to /api/media/upload-session (resumable, XHR-based
//      via chunkedUploadCaseMedia — never resilientFetch, whose expo/fetch
//      FormData impl rejects native file descriptors).
//   2. Register a caseAttachments row via POST /api/cases/:caseId/attachments.
//      A bare media URL 404s on the auth-gated serving routes until this row
//      exists, so persisted media MUST be backed by an attachment record.
import { chunkedUploadCaseMedia, resilientFetch } from "@/lib/query-client";

export type AttachmentVisibility = "internal_lab_only" | "shared_with_provider";

export interface UploadCaseAttachmentParams {
  caseId: string;
  fileUri: string;
  fileName: string;
  mimeType: string;
  visibility?: AttachmentVisibility;
  /** Reports overall progress (0..1) across both upload + register steps. */
  onProgress?: (fraction: number) => void;
}

export interface UploadedAttachment {
  id?: string;
  fileName?: string;
  fileType?: string;
  storageKey?: string;
  visibility?: string;
  [key: string]: unknown;
}

export type UploadCaseAttachmentResult =
  | { ok: true; attachment: UploadedAttachment | null }
  | { ok: false; error: string };

export async function uploadCaseAttachment(
  params: UploadCaseAttachmentParams,
): Promise<UploadCaseAttachmentResult> {
  const { caseId, fileUri, fileName, mimeType, visibility, onProgress } = params;

  // Step 1 — binary upload. Reserve the final 5% of the bar for the register
  // call so a row never reads 100% before the case actually references it.
  // chunkedUploadCaseMedia can throw (auth missing, network failure) in addition
  // to returning { ok: false } — wrap so callers always get a clean result.
  let uploadResult: Awaited<ReturnType<typeof chunkedUploadCaseMedia>>;
  try {
    uploadResult = await chunkedUploadCaseMedia(
      fileUri,
      fileName,
      mimeType,
      (fraction) => onProgress?.(Math.min(fraction * 0.95, 0.95)),
    );
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "File upload failed.",
    };
  }

  if (!uploadResult.ok) {
    return { ok: false, error: uploadResult.error || "File upload failed." };
  }

  // Step 2 — register the attachment row (JSON body → resilientFetch is fine).
  try {
    const res = await resilientFetch(
      `/api/cases/${encodeURIComponent(caseId)}/attachments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageKey: uploadResult.url,
          fileName,
          fileType: mimeType,
          ...(visibility ? { visibility } : {}),
        }),
      },
    );

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()) || "";
      } catch {}
      return {
        ok: false,
        error: `Could not attach file (${res.status})${detail ? `: ${detail}` : ""}`,
      };
    }

    let attachment: UploadedAttachment | null = null;
    try {
      const body = await res.json();
      attachment = (body?.data ?? body) as UploadedAttachment;
    } catch {
      // Non-JSON success body — treat as a successful attach with no payload.
    }
    onProgress?.(1);
    return { ok: true, attachment };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not register attachment.",
    };
  }
}
