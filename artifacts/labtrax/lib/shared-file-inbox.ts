// Lightweight inbox for files shared to LabTrax via the iOS/Android share sheet.
// Root layout writes incoming file URLs here. Consumers (the case-detail share
// prompt and the cases-list banner) either attach these files to a case or —
// via saveSharedFilesToUnassignedDocuments below — save them straight to the
// lab's Unassigned Documents inbox.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { chunkedUploadCaseMedia, mediaFileNameFromUrl, resilientFetch } from "@/lib/query-client";

const KEY = "@labtrax_shared_file_inbox";

export interface InboxEntry {
  url: string;
  receivedAt: number;
}

// Lightweight pub/sub kept for the future Phase 2 share-target consumer, so it
// can react to new inbox entries even when its focus state hasn't changed —
// e.g. a share intent arriving while the user is already in the app.
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeSharedFileInbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyInboxChanged(): void {
  for (const l of listeners) {
    try { l(); } catch {}
  }
}

export async function pushSharedFile(url: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const list: InboxEntry[] = raw ? JSON.parse(raw) : [];
    list.push({ url, receivedAt: Date.now() });
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
    notifyInboxChanged();
  } catch {}
}

export async function popSharedFiles(): Promise<InboxEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const list: InboxEntry[] = JSON.parse(raw);
    await AsyncStorage.removeItem(KEY);
    return list;
  } catch {
    return [];
  }
}

// Non-destructive read of pending shared files — used to render the "files
// waiting to attach" banner without consuming the inbox. Consumers must still
// call popSharedFiles() (or removeSharedFiles() for a partial batch) once they
// have actually handled the files.
export async function peekSharedFiles(): Promise<InboxEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    return JSON.parse(raw) as InboxEntry[];
  } catch {
    return [];
  }
}

// Removes only the given entries from the inbox, leaving any others (e.g.
// files that failed to save, or new files that arrived meanwhile) in place.
// Used by the save-to-Unassigned-Documents flows below so a failed save never
// silently loses the file — only entries that were actually saved successfully
// are consumed.
export async function removeSharedFiles(entriesToRemove: InboxEntry[]): Promise<void> {
  if (entriesToRemove.length === 0) return;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return;
    const list: InboxEntry[] = JSON.parse(raw);
    const removeKeys = new Set(entriesToRemove.map((e) => `${e.url}::${e.receivedAt}`));
    const remaining = list.filter((e) => !removeKeys.has(`${e.url}::${e.receivedAt}`));
    if (remaining.length === list.length) return;
    if (remaining.length === 0) {
      await AsyncStorage.removeItem(KEY);
    } else {
      await AsyncStorage.setItem(KEY, JSON.stringify(remaining));
    }
    notifyInboxChanged();
  } catch {}
}

// ── Filename/MIME-type derivation ───────────────────────────────────────────
// Shared files only carry a local file URI (e.g. from expo-share-intent); this
// derives a display filename and a MIME type from the URI's extension so both
// the case-attach pipeline and the Unassigned Documents save pipeline below
// agree on what to call the file and how to upload it.
const SHARED_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  "3gp": "video/3gpp",
};

export function deriveSharedFileMeta(url: string): { name: string; mimeType: string } {
  let path = url;
  try {
    path = decodeURIComponent(url.split("?")[0].split("#")[0]);
  } catch {
    path = url.split("?")[0];
  }
  const seg = path.split("/").filter(Boolean).pop() || `shared-${Date.now()}`;
  const ext = seg.includes(".") ? seg.split(".").pop()!.toLowerCase() : "";
  const mimeType = SHARED_MIME_BY_EXT[ext] ?? "application/octet-stream";
  return { name: seg, mimeType };
}

// ── Save-to-Unassigned-Documents pipeline ───────────────────────────────────
// Reusable chunked-upload + finalize-session pipeline, factored out of
// UnassignedDocumentsCard so any screen (the case-detail share prompt, the
// cases-list banner, and the card itself) can save a local file URI straight
// to the lab's Unassigned Documents inbox without duplicating the upload code.
export type SaveToUnassignedResult = { ok: true } | { ok: false; error: string };

export async function saveFileToUnassignedDocuments(params: {
  fileUri: string;
  fileName: string;
  mimeType: string;
  labOrganizationId: string;
  note?: string;
  onProgress?: (fraction: number) => void;
}): Promise<SaveToUnassignedResult> {
  const { fileUri, fileName, mimeType, labOrganizationId, note, onProgress } = params;

  if (!labOrganizationId) {
    return { ok: false, error: "No lab organization found for your account." };
  }

  let uploadResult: Awaited<ReturnType<typeof chunkedUploadCaseMedia>>;
  try {
    uploadResult = await chunkedUploadCaseMedia(fileUri, fileName, mimeType, onProgress);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "File upload failed." };
  }
  if (!uploadResult.ok) {
    return { ok: false, error: uploadResult.error || "File upload failed." };
  }

  // chunkedUploadCaseMedia already validates the file size (it refuses to
  // upload an unreadable/empty file), so `fileSize` here is always a known
  // positive number — the server's finalize-session schema requires exactly
  // that (a positive integer), so we must never substitute a 0/guessed value.
  try {
    const finalizeRes = await resilientFetch("/api/lab-inbox/finalize-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storagePath:
          uploadResult.filename ?? mediaFileNameFromUrl(uploadResult.url) ?? uploadResult.url,
        originalFilename: fileName,
        mimeType,
        sizeBytes: uploadResult.fileSize,
        labOrganizationId,
         ...(note?.trim() ? { note: note.trim() } : {}),
      }),
    });
    if (!finalizeRes.ok) {
      let detail = "";
      try {
        detail = await finalizeRes.text();
      } catch {}
      return {
        ok: false,
        error: `Could not save ${fileName} (${finalizeRes.status})${detail ? `: ${detail}` : ""}`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save file." };
  }
}

export interface SaveSharedFilesSummary {
  savedCount: number;
  // Entries that were saved successfully — callers should remove exactly
  // these from the shared-file inbox (via removeSharedFiles) so a failed
  // entry is never silently lost; it stays in the inbox for a retry.
  succeeded: InboxEntry[];
  failures: { entry: InboxEntry; name: string; error: string }[];
}

// Saves a batch of pending shared-file inbox entries to Unassigned Documents,
// one at a time (mirrors the serial case-attachment upload queue so several
// large photos don't contend for mobile network/CPU at once). Callers pass
// `onProgress(completed, total)` for lightweight progress feedback and must
// inspect `failures`/`succeeded` afterward to decide what to remove from the
// inbox — this function never mutates the inbox itself.
export async function saveSharedFilesToUnassignedDocuments(
  entries: InboxEntry[],
  labOrganizationId: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<SaveSharedFilesSummary> {
  const succeeded: InboxEntry[] = [];
  const failures: SaveSharedFilesSummary["failures"] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const meta = deriveSharedFileMeta(entry.url);
    const result = await saveFileToUnassignedDocuments({
      fileUri: entry.url,
      fileName: meta.name,
      mimeType: meta.mimeType,
      labOrganizationId,
    });
    if (result.ok) {
      succeeded.push(entry);
    } else {
      failures.push({ entry, name: meta.name, error: result.error });
    }
    onProgress?.(i + 1, entries.length);
  }
  return { savedCount: succeeded.length, succeeded, failures };
}
