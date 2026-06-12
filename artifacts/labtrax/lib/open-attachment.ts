import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import { getAuthedMediaUri } from "./authed-media-cache";

export type OpenAttachmentResult = "opened" | "unavailable" | "error";

const SHARE_DIR = `${FileSystem.cacheDirectory ?? ""}labtrax-share/`;

// Extract a lowercase extension (with dot) from a file name, e.g. ".pdf".
function extFromName(name?: string | null): string {
  if (!name) return "";
  const match = /\.([a-zA-Z0-9]{1,8})$/.exec(name.trim());
  return match ? `.${match[1].toLowerCase()}` : "";
}

// iOS Quick Look keys off the Uniform Type Identifier when present. Map the
// types we know; otherwise let iOS infer from the file extension.
function utiForExt(ext: string): string | undefined {
  switch (ext) {
    case ".pdf":
      return "com.adobe.pdf";
    default:
      return undefined;
  }
}

// Copy the (usually extensionless) cached media file to a sibling path whose
// name carries the real extension. The cache name is derived from the API path
// (".../file") and has no extension; both iOS Quick Look / WKWebView and
// Android infer the type from that extension, so we must add it.
//
// On iOS, FileSystem.copyAsync rejects if the destination already exists, so we
// delete any prior copy first (idempotent) — otherwise re-opening the same
// attachment would fail.
//
// `strict` controls the failure mode:
//   - true  (in-app viewer): a missing extension or a failed copy returns null
//     so the caller shows an error. Handing an extensionless file to WKWebView
//     renders a blank screen, which is worse than an explicit error.
//   - false (share sheet): fall back to the original cached URI and rely on the
//     mimeType / UTI we pass to shareAsync.
async function copyToExtensioned(
  localUri: string,
  fileName: string | null | undefined,
  strict: boolean,
): Promise<string | null> {
  const ext = extFromName(fileName);
  if (!ext) return strict ? null : localUri;
  if (localUri.toLowerCase().endsWith(ext)) return localUri;

  try {
    const info = await FileSystem.getInfoAsync(SHARE_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(SHARE_DIR, { intermediates: true });
    }
    const safeBase = (fileName || "attachment")
      .replace(/[^a-zA-Z0-9_\-.]/g, "_")
      .slice(-120);
    const dest = `${SHARE_DIR}${
      safeBase.toLowerCase().endsWith(ext) ? safeBase : safeBase + ext
    }`;
    // copyAsync fails on iOS if the file already exists — clear it first.
    await FileSystem.deleteAsync(dest, { idempotent: true });
    await FileSystem.copyAsync({ from: localUri, to: dest });
    return dest;
  } catch {
    return strict ? null : localUri;
  }
}

// Download an auth-gated case attachment and return a local file:// URI whose
// name carries the real extension. Returns null on download or copy failure.
//
// The media endpoints are Bearer-protected, so we cannot point a viewer at the
// remote URL directly — it would 401. getAuthedMediaUri() downloads the file
// (refreshing the token on 401) and returns a local file:// URI.
//
// Used by the in-app document viewer (app/pdf-viewer.tsx): WKWebView needs a
// real .pdf extension to infer the MIME type and render inline.
export async function downloadAttachmentToLocalFile(opts: {
  url: string;
  fileName?: string | null;
  fileType?: string | null;
}): Promise<string | null> {
  const localUri = await getAuthedMediaUri(opts.url);
  if (!localUri) return null;
  return copyToExtensioned(localUri, opts.fileName, true);
}

// Share an already-downloaded local file through the OS share sheet. Powers the
// explicit Share action in the in-app viewer — the only place the share sheet
// should appear for a PDF.
export async function shareLocalFile(
  uri: string,
  opts: { fileName?: string | null; fileType?: string | null },
): Promise<OpenAttachmentResult> {
  let available = false;
  try {
    available = await Sharing.isAvailableAsync();
  } catch {
    available = false;
  }
  if (!available) return "unavailable";

  try {
    await Sharing.shareAsync(uri, {
      mimeType: opts.fileType || undefined,
      UTI: utiForExt(extFromName(opts.fileName)),
      dialogTitle: opts.fileName || "Share file",
    });
    return "opened";
  } catch {
    return "error";
  }
}

// Download an auth-gated case attachment and hand it to the OS viewer / share
// sheet (iOS Quick Look / Android "open with") via expo-sharing. Used for
// non-PDF documents, and as the Android fallback for PDFs (in-app WKWebView PDF
// rendering is iOS-only).
export async function openAttachment(opts: {
  url: string;
  fileName?: string | null;
  fileType?: string | null;
}): Promise<OpenAttachmentResult> {
  const localUri = await getAuthedMediaUri(opts.url);
  if (!localUri) return "error";

  let available = false;
  try {
    available = await Sharing.isAvailableAsync();
  } catch {
    available = false;
  }
  if (!available) return "unavailable";

  const shareUri = (await copyToExtensioned(localUri, opts.fileName, false)) ?? localUri;

  try {
    await Sharing.shareAsync(shareUri, {
      mimeType: opts.fileType || undefined,
      UTI: utiForExt(extFromName(opts.fileName)),
      dialogTitle: opts.fileName || "Open file",
    });
    return "opened";
  } catch {
    return "error";
  }
}
