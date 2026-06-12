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

// Download an auth-gated case attachment and hand it to the OS viewer
// (iOS Quick Look / Android "open with") via expo-sharing.
//
// The media endpoints are Bearer-protected, so we cannot point an external
// viewer at the remote URL directly — it would 401. getAuthedMediaUri()
// downloads the file (refreshing the token on 401) and returns a local
// file:// URI. That cached name is derived from the API path (".../file") and
// carries no extension, so we copy it to a name with the real extension first:
// iOS infers the type from the extension and Android from the mime type.
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

  let shareUri = localUri;
  const ext = extFromName(opts.fileName);
  if (ext && !localUri.toLowerCase().endsWith(ext)) {
    try {
      const info = await FileSystem.getInfoAsync(SHARE_DIR);
      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(SHARE_DIR, { intermediates: true });
      }
      const safeBase = (opts.fileName || "attachment")
        .replace(/[^a-zA-Z0-9_\-.]/g, "_")
        .slice(-120);
      const dest = `${SHARE_DIR}${
        safeBase.toLowerCase().endsWith(ext) ? safeBase : safeBase + ext
      }`;
      await FileSystem.copyAsync({ from: localUri, to: dest });
      shareUri = dest;
    } catch {
      // Copy is a best-effort nicety — fall back to the extensionless cache
      // file and rely on the mime type / UTI passed to shareAsync below.
      shareUri = localUri;
    }
  }

  try {
    await Sharing.shareAsync(shareUri, {
      mimeType: opts.fileType || undefined,
      UTI: utiForExt(ext),
      dialogTitle: opts.fileName || "Open file",
    });
    return "opened";
  } catch {
    return "error";
  }
}
