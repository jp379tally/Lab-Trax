import AsyncStorage from "@react-native-async-storage/async-storage";

const PENDING_UPLOADS_KEY = "@labtrax_pending_uploads_v1";

// Number of failed sync attempts after which an item is considered "stuck".
// A stuck item is no longer retried automatically and stops blocking the rest
// of the queue (the drain skips past it). The user is then surfaced a clear
// "couldn't sync — tap to retry" prompt and can manually retry or discard it.
export const MAX_SYNC_ATTEMPTS = 3;

type PendingItemBase = {
  id: string;
  caseId: string;
  createdAt: number;
  // Number of consecutive failed drain attempts. Absent/0 until the first
  // failure. Reset to 0 by a manual retry.
  attempts?: number;
  // Short, human-readable reason the last attempt failed (best-effort).
  lastError?: string;
  // Timestamp of the most recent failed attempt.
  lastAttemptAt?: number;
};

export type PendingPhotoItem = PendingItemBase & {
  type: "photo";
  photoUri: string;
  fileName: string;
  mimeType: string;
};

export type PendingNoteItem = PendingItemBase & {
  type: "note";
  noteText: string;
};

export type PendingStatusItem = PendingItemBase & {
  type: "status";
};

export type PendingUploadItem =
  | PendingPhotoItem
  | PendingNoteItem
  | PendingStatusItem;

// Lightweight view of a stuck item handed to the UI so it can describe what
// couldn't sync and offer retry/discard without exposing the full payload.
export type StuckQueueItem = {
  id: string;
  type: PendingUploadItem["type"];
  caseId: string;
  attempts: number;
  lastError?: string;
  createdAt: number;
};

// Snapshot of the queue's state, broadcast to subscribers after every change.
export type QueueSummary = {
  // Total items still queued (including stuck ones).
  total: number;
  // Items that have exhausted their automatic-retry budget.
  stuckCount: number;
  stuckItems: StuckQueueItem[];
};

function attemptsOf(item: PendingUploadItem): number {
  return item.attempts ?? 0;
}

function isStuck(item: PendingUploadItem): boolean {
  return attemptsOf(item) >= MAX_SYNC_ATTEMPTS;
}

function summarize(items: PendingUploadItem[]): QueueSummary {
  const stuckItems: StuckQueueItem[] = items
    .filter(isStuck)
    .map((item) => ({
      id: item.id,
      type: item.type,
      caseId: item.caseId,
      attempts: attemptsOf(item),
      createdAt: item.createdAt,
      ...(item.lastError ? { lastError: item.lastError } : {}),
    }));
  return { total: items.length, stuckCount: stuckItems.length, stuckItems };
}

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
  // Notify subscribers of the new queue state after every mutation. Done
  // outside the try so the indicator still updates even if persistence failed.
  notifyListeners(items);
}

// ─── Queue-state subscription ─────────────────────────────────────────────────
// Lets the UI react to queue changes (enqueue/drain/retry/discard) without
// polling. Every mutation funnels through saveQueue, which notifies all
// listeners with a fresh summary. Listeners receive the current summary
// immediately on subscribe.

type QueueSummaryListener = (summary: QueueSummary) => void;

const _listeners = new Set<QueueSummaryListener>();

function notifyListeners(items: PendingUploadItem[]): void {
  const summary = summarize(items);
  for (const listener of _listeners) {
    try {
      listener(summary);
    } catch {}
  }
}

/**
 * Subscribe to queue-state changes. The listener is invoked immediately with
 * the current summary, then again after every enqueue, drain, retry, or
 * discard. Returns an unsubscribe function.
 */
export function subscribeToQueueSummary(
  listener: QueueSummaryListener
): () => void {
  _listeners.add(listener);
  void getQueueSummary()
    .then((summary) => listener(summary))
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
 * Ordering & stuck items: the drain processes the first item that still has
 * automatic-retry budget left. On a failure that item's attempt count is
 * incremented and the drain stops to preserve ordering; the next trigger
 * (foreground, AppState change, or periodic timer) retries from that point.
 * Once an item has failed `MAX_SYNC_ATTEMPTS` times it is considered "stuck":
 * it is left in the queue (so the user can retry or discard it) but is skipped
 * by the drain so it no longer blocks the items behind it.
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

      // Process the first item that still has retry budget. Stuck items are
      // skipped so a single wedged item can't block everything behind it.
      const index = queue.findIndex((item) => !isStuck(item));
      if (index === -1) break;

      const item = queue[index];
      let succeeded = false;
      let errorMessage: string | undefined;
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
      } catch (e: any) {
        errorMessage = String(e?.message || e).slice(0, 200);
      }

      if (succeeded) {
        // Persist removal atomically before the next iteration.
        // A crash here at worst replays one already-sent item (bounded by 1).
        const next = queue.slice();
        next.splice(index, 1);
        await saveQueue(next);
        continue;
      }

      // Record the failed attempt against this item.
      const attempts = attemptsOf(item) + 1;
      const next = queue.slice();
      next[index] = {
        ...item,
        attempts,
        lastError: errorMessage ?? "Couldn't reach the server",
        lastAttemptAt: Date.now(),
      };
      await saveQueue(next);

      if (attempts >= MAX_SYNC_ATTEMPTS) {
        // Now stuck — skip it on the next loop and keep draining the rest.
        continue;
      }
      // Still has budget — stop to preserve ordering; a later trigger retries.
      break;
    }
  });
}

/**
 * Reset a single stuck item's attempt count so the next drain retries it.
 * No-op if the id isn't present.
 */
export function retryItem(id: string): Promise<void> {
  return withQueueLock(async () => {
    const queue = await loadQueue();
    let changed = false;
    const next = queue.map((item) => {
      if (item.id !== id || attemptsOf(item) === 0) return item;
      changed = true;
      const { attempts, lastError, lastAttemptAt, ...rest } = item;
      return rest;
    });
    if (changed) await saveQueue(next);
  });
}

/**
 * Reset every stuck item so the next drain retries them all.
 */
export function retryAllStuck(): Promise<void> {
  return withQueueLock(async () => {
    const queue = await loadQueue();
    let changed = false;
    const next = queue.map((item) => {
      if (!isStuck(item)) return item;
      changed = true;
      const { attempts, lastError, lastAttemptAt, ...rest } = item;
      return rest;
    });
    if (changed) await saveQueue(next);
  });
}

/**
 * Permanently remove an item from the queue (discarding the offline change).
 * Used to clear a permanently-failing item so it stops blocking the queue.
 * No-op if the id isn't present.
 */
export function discardItem(id: string): Promise<void> {
  return withQueueLock(async () => {
    const queue = await loadQueue();
    const next = queue.filter((item) => item.id !== id);
    if (next.length !== queue.length) await saveQueue(next);
  });
}

export function getPendingCount(): Promise<number> {
  return withQueueLock(async () => {
    const queue = await loadQueue();
    return queue.length;
  });
}

export function getQueueSummary(): Promise<QueueSummary> {
  return withQueueLock(async () => {
    const queue = await loadQueue();
    return summarize(queue);
  });
}
