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

export type PendingStatusItem = {
  id: string;
  type: "status";
  caseId: string;
  createdAt: number;
};

export type PendingUploadItem =
  | PendingPhotoItem
  | PendingNoteItem
  | PendingStatusItem;

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
  // Notify subscribers of the new pending count after every mutation. Done
  // outside the try so the indicator still updates even if persistence failed.
  notifyListeners(items.length);
}

// ─── Pending-count subscription ───────────────────────────────────────────────
// Lets the UI react to queue changes (enqueue/drain) without polling. Every
// mutation funnels through saveQueue, which notifies all listeners with the new
// length. Listeners receive the current count immediately on subscribe.

type PendingCountListener = (count: number) => void;

const _listeners = new Set<PendingCountListener>();

function notifyListeners(count: number): void {
  for (const listener of _listeners) {
    try {
      listener(count);
    } catch {}
  }
}

/**
 * Subscribe to pending-queue size changes. The listener is invoked immediately
 * with the current count, then again after every enqueue or drain. Returns an
 * unsubscribe function.
 */
export function subscribeToPendingCount(
  listener: PendingCountListener
): () => void {
  _listeners.add(listener);
  void getPendingCount()
    .then((count) => listener(count))
    .catch(() => {});
  return () => {
    _listeners.delete(listener);
  };
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

/**
 * Enqueue a case status/station change. Idempotent per case — the queue id is
 * derived purely from `caseId`, so repeated offline status changes to the same
 * case collapse to a single entry. At drain time the executor re-reads the
 * case's latest local state and syncs that, so collapsing never loses the most
 * recent station.
 */
export function enqueueStatus(caseId: string): Promise<void> {
  return withQueueLock(async () => {
    const queue = await loadQueue();
    const id = `status-${caseId}`;
    if (queue.some((item) => item.id === id)) return;
    const item: PendingStatusItem = {
      id,
      type: "status",
      caseId,
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
  postNote: (caseId: string, noteText: string) => Promise<boolean>,
  syncStatus: (caseId: string) => Promise<boolean>
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
        } else if (item.type === "note") {
          succeeded = await postNote(item.caseId, item.noteText);
        } else {
          succeeded = await syncStatus(item.caseId);
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
