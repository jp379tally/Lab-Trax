// Persistent retry queue for failed mobile photo/video uploads.
//
// Scope is deliberately narrow: this only ever holds case media (photos and
// videos) whose chunked upload exhausted its in-session retries. It does NOT
// queue case creation, invoice generation, status changes, or any other sync —
// those have their own paths. Entries persist across app restarts (AsyncStorage)
// and are keyed per user so a shared device / account switch never inherits
// another user's parked uploads.

import AsyncStorage from "@react-native-async-storage/async-storage";

const PENDING_UPLOADS_KEY = "@drivesync_pending_uploads";

// A photo/video upload that failed after in-session retries and is parked for a
// later background retry. `fileUri` is the original device-local uri (also
// stored as the case's photo + activity-log imageUri until the upload lands),
// so on success we can swap it for the canonical serving URL.
export type PendingUpload = {
  id: string;
  caseId: string;
  fileUri: string;
  isVid: boolean;
  createdAt: number;
  attempts: number;
  lastAttemptAt?: number;
};

// Per-user storage key. Falls back to the bare key when there is no signed-in
// user (the queue is only ever loaded/processed while a user is signed in, so
// this fallback is effectively unused but keeps the function total).
export function pendingUploadsStorageKey(userId?: string | null): string {
  return userId ? `${PENDING_UPLOADS_KEY}:${userId}` : PENDING_UPLOADS_KEY;
}

export async function loadPendingUploads(
  userId?: string | null,
): Promise<PendingUpload[]> {
  try {
    const raw = await AsyncStorage.getItem(pendingUploadsStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingUpload[]) : [];
  } catch {
    return [];
  }
}

export async function savePendingUploads(
  userId: string | null | undefined,
  list: PendingUpload[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      pendingUploadsStorageKey(userId),
      JSON.stringify(list),
    );
  } catch {}
}

// Append a new pending upload, de-duplicating on (caseId, fileUri) so the same
// failed photo is never queued twice (e.g. the user retries the same add). The
// existing entry is replaced so its attempt counter resets.
export function upsertPendingUpload(
  list: PendingUpload[],
  entry: { caseId: string; fileUri: string; isVid: boolean },
  idFactory: () => string,
  now: number = Date.now(),
): PendingUpload[] {
  const deduped = list.filter(
    (u) => !(u.caseId === entry.caseId && u.fileUri === entry.fileUri),
  );
  return [
    ...deduped,
    {
      id: idFactory(),
      caseId: entry.caseId,
      fileUri: entry.fileUri,
      isVid: entry.isVid,
      createdAt: now,
      attempts: 0,
    },
  ];
}

export type ProcessDeps = {
  // Upload one parked file and create its attachment, returning the canonical
  // serving URL on success or null on (transient) failure. Implemented by the
  // app via the existing chunked upload + attachment-create path, which reuses
  // the server resume session (GET /api/media/upload-session/:id) and creates
  // exactly one attachment per successful upload.
  uploadOne: (caseId: string, fileUri: string) => Promise<string | null>;
  // Optional check: drop the entry if its backing local file has vanished
  // (nothing left to upload). Return true to keep, false to drop.
  fileStillExists?: (fileUri: string) => Promise<boolean>;
  // Called once per recovered entry so the app can swap the local uri for the
  // canonical URL in case state.
  onRecovered: (item: PendingUpload, canonicalUrl: string) => void;
  now?: () => number;
};

export type ProcessResult = { remaining: PendingUpload[]; recovered: number };

// Drain a queue snapshot once. Successful entries are removed (and reported via
// onRecovered); entries whose file is gone are dropped; transient failures stay
// with a bumped attempt counter. Pure with respect to storage — the caller
// persists `remaining`. A successful upload removes the item, so a subsequent
// pass never re-uploads it (no duplicate attachments).
export async function processPendingUploadsList(
  list: PendingUpload[],
  deps: ProcessDeps,
): Promise<ProcessResult> {
  const now = deps.now ?? Date.now;
  let working = [...list];
  let recovered = 0;
  for (const item of list) {
    if (deps.fileStillExists) {
      let exists = true;
      try {
        exists = await deps.fileStillExists(item.fileUri);
      } catch {
        exists = true;
      }
      if (!exists) {
        working = working.filter((x) => x.id !== item.id);
        continue;
      }
    }
    let canonicalUrl: string | null = null;
    try {
      canonicalUrl = await deps.uploadOne(item.caseId, item.fileUri);
    } catch {
      canonicalUrl = null;
    }
    if (canonicalUrl) {
      deps.onRecovered(item, canonicalUrl);
      working = working.filter((x) => x.id !== item.id);
      recovered += 1;
    } else {
      working = working.map((x) =>
        x.id === item.id
          ? { ...x, attempts: x.attempts + 1, lastAttemptAt: now() }
          : x,
      );
    }
  }
  return { remaining: working, recovered };
}
