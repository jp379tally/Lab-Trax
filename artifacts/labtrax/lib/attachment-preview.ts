import { Platform } from "react-native";
import { router } from "expo-router";
import { openAttachment } from "./open-attachment";

// True when an attachment is an image we can show in the in-app lightbox.
export function isImageAttachment(
  fileType?: string | null,
  fileName?: string | null,
): boolean {
  if (fileType && fileType.toLowerCase().startsWith("image")) return true;
  if (fileName && /\.(jpe?g|png|heic|heif|gif|webp)$/i.test(fileName)) return true;
  return false;
}

// True when an attachment is a PDF (iOS renders these in the in-app viewer).
export function isPdfAttachment(
  fileType?: string | null,
  fileName?: string | null,
): boolean {
  if (fileType && fileType.toLowerCase().includes("pdf")) return true;
  if (fileName && /\.pdf$/i.test(fileName.trim())) return true;
  return false;
}

// Canonical URL for an auth-gated case attachment file. Centralized so the
// case-detail Files grid and the History timeline build identical URLs.
export function attachmentFileUrl(caseId: string, attachmentId: string): string {
  return `/api/cases/${caseId}/attachments/${attachmentId}/file`;
}

export interface PreviewAttachment {
  // Resolved file URL: either an id-based API path (attachmentFileUrl) or a
  // legacy inline imageUri carried in a history event's metadata.
  url: string;
  fileName?: string | null;
  fileType?: string | null;
}

export interface OpenAttachmentPreviewOptions {
  // Open an image in the caller-owned full-screen lightbox.
  onOpenImage: (url: string) => void;
  // Surface a user-facing failure (share/open path only).
  onError?: (title: string, message: string) => void;
  // Toggle a per-attachment busy spinner around the async share/open path.
  setBusy?: (busy: boolean) => void;
}

export type AttachmentPreviewKind = "image" | "pdf-viewer" | "shared";

// Single entry point for tapping any case attachment, shared by the Files grid
// and the History timeline so they behave identically:
//   - images                    → caller's AuthedImage lightbox
//   - iOS PDFs                  → in-app /pdf-viewer (WKWebView; never share sheet)
//   - other docs / Android PDFs → OS viewer / share sheet via openAttachment
export async function openAttachmentPreview(
  att: PreviewAttachment,
  opts: OpenAttachmentPreviewOptions,
): Promise<AttachmentPreviewKind> {
  if (isImageAttachment(att.fileType, att.fileName)) {
    opts.onOpenImage(att.url);
    return "image";
  }

  if (Platform.OS === "ios" && isPdfAttachment(att.fileType, att.fileName)) {
    router.push({
      pathname: "/pdf-viewer",
      params: {
        url: att.url,
        fileName: att.fileName ?? "",
        fileType: att.fileType ?? "",
      },
    });
    return "pdf-viewer";
  }

  opts.setBusy?.(true);
  try {
    const result = await openAttachment({
      url: att.url,
      fileName: att.fileName,
      fileType: att.fileType,
    });
    if (result === "unavailable") {
      opts.onError?.("Can't open file", "Opening files isn't supported on this device.");
    } else if (result === "error") {
      opts.onError?.(
        "Couldn't open file",
        "This file could not be downloaded or opened. Please try again.",
      );
    }
  } finally {
    opts.setBusy?.(false);
  }
  return "shared";
}
