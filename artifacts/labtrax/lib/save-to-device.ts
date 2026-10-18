import * as MediaLibrary from "expo-media-library";
import { acquireAuthedMediaUri } from "./authed-media-cache";
import { downloadAttachmentToLocalFile, openAttachment, type OpenAttachmentResult } from "./open-attachment";

export type SaveImageResult = "saved" | "permission-denied" | "error";

// Download an auth-gated case/provider photo attachment and save a copy into
// the device's photo library.
//
// Uses the "add-only" photo library permission (requestPermissionsAsync(true))
// rather than the full read/pick permission requested elsewhere in the app —
// LabTrax only ever writes new photos here, it never needs to read the user's
// existing library, so we ask for the narrower grant.
export async function saveImageToDevice(
  url: string,
  file?: { fileName: string; fileType?: string | null },
): Promise<SaveImageResult> {
  let perm: MediaLibrary.PermissionResponse;
  try {
    perm = await MediaLibrary.requestPermissionsAsync(true);
  } catch {
    return "error";
  }
  if (!(perm.granted || perm.status === "granted")) {
    return "permission-denied";
  }

  try {
    // Id-based attachment routes end in /file. Native photo libraries need
    // the original extension, using the same leased, authenticated download
    // pipeline as the in-app attachment viewer.
    const acquired = file
      ? await downloadAttachmentToLocalFile({ url, ...file })
      : await acquireAuthedMediaUri(url);
    if (!acquired) return "error";
    try {
      await MediaLibrary.saveToLibraryAsync(acquired.uri);
      return "saved";
    } finally {
      acquired.release();
    }
  } catch {
    return "error";
  }
}

// Save/export a document attachment via the OS share/save flow. This reuses
// the exact download-and-share pipeline already used to open documents
// (openAttachment) — the resulting share sheet includes "Save to Files" on
// iOS and a save/share target on Android, so it doubles as the document
// "Save" action for long-press.
export async function saveDocumentToDevice(opts: {
  url: string;
  fileName?: string | null;
  fileType?: string | null;
}): Promise<OpenAttachmentResult> {
  return openAttachment(opts);
}
