import AsyncStorage from "@react-native-async-storage/async-storage";

const PENDING_UPLOADS_KEY = "@labtrax_pending_uploads_v1";

export type PendingPhotoItem = {
  id: string;
  type: "photo";
  caseId: string;
  photoUri: string;
  fileName: string;
  mimeType: string;
  createdAt: number;
};

export type PendingNoteItem = {
  id: string;
  type: "note";
  caseId: string;
  noteText: string;
  createdAt: number;
};

export type PendingUploadItem = PendingPhotoItem | PendingNoteItem;

// ─── Mutex ────────────────────────────────────────────────────────────────────
// All queue reads and writes are funnelled through a promise-chain mutex so
// that concurrent enqueue calls (e.g. multiple photos added simultaneously
// in addCasePhotosWithNote) never interleave their read-modify-write and
// overwrite each other on the single AsyncStorage key.

let _queueLock: Promise<void> = Promise.resolve();

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const ticket = _queueLock.then(() => fn());
  // Advance the lock chain regardless of whether `fn` resolves or rejects,
  // so subsequent callers are never stuck waiting on a failed operation.
  _queueLock = ticket.then(
    () => {},
    () => {}
  );
  return ticket;
}

// ─── Raw I/O (called only from within the lock) ───────────────────────────────

async function loadQueue(): Promise<PendingUploadItem[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_UPLOADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveQueue(items: PendingUploadItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_UPLOADS_KEY, JSON.stringify(items));
  } catch {}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue a photo upload. Idempotent by `id` — concurrent or repeated calls
 * with the same id are collapsed to a single queue entry.
 */
export function enqueuePhoto(
  id: string,
  caseId: string,
  photoUri: string,
  fileName: string,
  mimeType: string
): Promise<void> {
  return withQueueLock(async () => {
    const queue = await loadQueue();
    if (queue.some((item) => item.id === id)) return;
    const item: PendingPhotoItem = {
      id,
      type: "photo",
      caseId,
      photoUri,
      fileName,
      mimeType,
      createdAt: Date.now(),
    };
    queue.push(item);
    await saveQueue(queue);
  });
}

/**
 * Enqueue a note post. Idempotent by `id`.
 */
export function enqueueNote(
  id: string,
  caseId: string,
  noteText: string
): Promise<void> {
  return withQueueLock(async () => {
    const queue = await loadQueue();
    if (queue.some((item) => item.id === id)) return;
    const item: PendingNoteItem = {
      id,
      type: "note",
      caseId,
      noteText,
      createdAt: Date.now(),
    };
    queue.push(item);
    await saveQueue(queue);
  });
}

// Track whether a drain is already queued so additional drain triggers during
// an in-progress drain don't pile up in the mutex — one pending drain is enough.
let _drainQueued = false;

/**
 * Process queued items in insertion order via the mutex so drains and enqueues
 * never race each other.
 *
 * Crash-safety: each item is removed from AsyncStorage immediately after it
 * succeeds (before the next item is attempted), so a force-close mid-drain
 * cannot replay already-sent operations on relaunch.
 *
 * On the first failure the drain stops to preserve ordering; the next trigger
 * (foreground, AppState change, or periodic timer) retries from that point.
 */
export function drainQueue(
  uploadPhoto: (
    caseId: string,
    photoUri: string,
    fileName: string,
    mimeType: string
  ) => Promise<boolean>,
  postNote: (caseId: string, noteText: string) => Promise<boolean>
): Promise<void> {
  if (_drainQueued) return Promise.resolve();
  _drainQueued = true;

  return withQueueLock(async () => {
    _drainQueued = false;
    while (true) {
      const queue = await loadQueue();
      if (queue.length === 0) break;

      const item = queue[0];
      let succeeded = false;
      try {
        if (item.type === "photo") {
          succeeded = await uploadPhoto(
            item.caseId,
            item.photoUri,
            item.fileName,
            item.mimeType
          );
        } else {
          succeeded = await postNote(item.caseId, item.noteText);
        }
      } catch {}

      if (succeeded) {
        // Persist removal atomically before the next iteration.
        // A crash here at worst replays one already-sent item (bounded by 1).
        await saveQueue(queue.slice(1));
      } else {
        break;
      }
    }
  });
}

export function getPendingCount(): Promise<number> {
  return withQueueLock(async () => {
    const queue = await loadQueue();
    return queue.length;
  });
}
