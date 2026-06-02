import { describe, it, expect, beforeEach } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  enqueuePhoto,
  enqueueNote,
  enqueueStatus,
  drainQueue,
  getPendingCount,
  getQueueSummary,
  retryItem,
  retryAllStuck,
  discardItem,
  subscribeToQueueSummary,
  MAX_SYNC_ATTEMPTS,
  categorizeSyncStatus,
  syncFailureFromStatus,
  isSyncSuccess,
  messageForCategory,
  type PendingUploadItem,
} from "../offline-queue";

const PENDING_UPLOADS_KEY = "@labtrax_pending_uploads_v1";

// Read the queue straight from storage WITHOUT going through the module's
// mutex. drainQueue holds the lock for its whole while-loop, so any helper
// that funnels through withQueueLock (e.g. getPendingCount) would deadlock if
// called from inside a drain executor. The executors in these tests use this
// raw reader to inspect mid-drain persistence state instead.
async function readRawQueue(): Promise<PendingUploadItem[]> {
  const raw = await AsyncStorage.getItem(PENDING_UPLOADS_KEY);
  return raw ? (JSON.parse(raw) as PendingUploadItem[]) : [];
}

// Executors that always succeed. Override per-test as needed.
const okPhoto = async () => true;
const okNote = async () => true;
const okStatus = async () => true;

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("offline-queue enqueue idempotency", () => {
  it("collapses repeated enqueuePhoto calls with the same id", async () => {
    await enqueuePhoto("photo-1", "case-1", "uri://a", "a.jpg", "image/jpeg");
    await enqueuePhoto("photo-1", "case-1", "uri://a", "a.jpg", "image/jpeg");

    expect(await getPendingCount()).toBe(1);
    const queue = await readRawQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe("photo-1");
  });

  it("collapses repeated enqueueNote calls with the same id", async () => {
    await enqueueNote("note-1", "case-1", "hello");
    await enqueueNote("note-1", "case-1", "hello again");

    const queue = await readRawQueue();
    expect(queue).toHaveLength(1);
    // First write wins — the second (idempotent) call is a no-op.
    expect(queue[0]).toMatchObject({ type: "note", noteText: "hello" });
  });

  it("keeps distinct ids as separate entries", async () => {
    await enqueuePhoto("photo-1", "case-1", "uri://a", "a.jpg", "image/jpeg");
    await enqueuePhoto("photo-2", "case-1", "uri://b", "b.jpg", "image/jpeg");
    await enqueueNote("note-1", "case-1", "hi");

    expect(await getPendingCount()).toBe(3);
  });

  it("collapses repeated status changes per case via status-${caseId}", async () => {
    await enqueueStatus("case-1");
    await enqueueStatus("case-1");
    await enqueueStatus("case-1");

    const queue = await readRawQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: "status-case-1", type: "status", caseId: "case-1" });
  });

  it("keeps status entries for different cases separate", async () => {
    await enqueueStatus("case-1");
    await enqueueStatus("case-2");

    const queue = await readRawQueue();
    expect(queue.map((i) => i.id).sort()).toEqual(["status-case-1", "status-case-2"]);
  });

  it("survives concurrent enqueues of the same id (mutex collapses them)", async () => {
    await Promise.all([
      enqueuePhoto("photo-1", "case-1", "uri://a", "a.jpg", "image/jpeg"),
      enqueuePhoto("photo-1", "case-1", "uri://a", "a.jpg", "image/jpeg"),
      enqueuePhoto("photo-1", "case-1", "uri://a", "a.jpg", "image/jpeg"),
    ]);

    expect(await getPendingCount()).toBe(1);
  });
});

describe("offline-queue ordered draining", () => {
  it("processes items in insertion order and empties the queue on full success", async () => {
    await enqueuePhoto("photo-1", "case-1", "uri://a", "a.jpg", "image/jpeg");
    await enqueueNote("note-1", "case-2", "n1");
    await enqueueStatus("case-3");

    const processed: string[] = [];
    await drainQueue(
      async (caseId) => {
        processed.push(`photo:${caseId}`);
        return true;
      },
      async (caseId) => {
        processed.push(`note:${caseId}`);
        return true;
      },
      async (caseId) => {
        processed.push(`status:${caseId}`);
        return true;
      }
    );

    expect(processed).toEqual(["photo:case-1", "note:case-2", "status:case-3"]);
    expect(await getPendingCount()).toBe(0);
  });

  it("routes each item to the correct executor with its payload", async () => {
    await enqueuePhoto("photo-1", "case-1", "uri://x", "x.jpg", "image/png");
    await enqueueNote("note-1", "case-2", "the note");

    const photoArgs: unknown[] = [];
    const noteArgs: unknown[] = [];
    await drainQueue(
      async (...args) => {
        photoArgs.push(args);
        return true;
      },
      async (...args) => {
        noteArgs.push(args);
        return true;
      },
      okStatus
    );

    expect(photoArgs).toEqual([["case-1", "uri://x", "x.jpg", "image/png"]]);
    expect(noteArgs).toEqual([["case-2", "the note"]]);
  });
});

describe("offline-queue stop-on-first-failure", () => {
  it("stops at the first failing item and preserves the remainder in order", async () => {
    await enqueueNote("note-1", "case-1", "first");
    await enqueueNote("note-2", "case-2", "second");
    await enqueueNote("note-3", "case-3", "third");

    const attempted: string[] = [];
    await drainQueue(okPhoto, async (caseId) => {
      attempted.push(caseId);
      // Fail on the second item.
      return caseId !== "case-2";
    }, okStatus);

    // First succeeded and was removed; the drain stopped at the failure, so
    // the executor was never called for the third item.
    expect(attempted).toEqual(["case-1", "case-2"]);

    const queue = await readRawQueue();
    expect(queue.map((i) => i.id)).toEqual(["note-2", "note-3"]);
  });

  it("treats a thrown executor error as a failure and stops", async () => {
    await enqueueNote("note-1", "case-1", "first");
    await enqueueNote("note-2", "case-2", "second");

    await drainQueue(okPhoto, async (caseId) => {
      if (caseId === "case-1") throw new Error("network down");
      return true;
    }, okStatus);

    // Nothing drained — the throw on the head item halts the drain.
    const queue = await readRawQueue();
    expect(queue.map((i) => i.id)).toEqual(["note-1", "note-2"]);
  });

  it("resumes from the failure point on a subsequent drain", async () => {
    await enqueueNote("note-1", "case-1", "first");
    await enqueueNote("note-2", "case-2", "second");

    let online = false;
    const noteExec = async (caseId: string) => {
      if (caseId === "case-1") return online;
      return true;
    };

    await drainQueue(okPhoto, noteExec, okStatus);
    expect((await readRawQueue()).map((i) => i.id)).toEqual(["note-1", "note-2"]);

    // "Reconnect" and drain again — it should finish from where it stopped.
    online = true;
    await drainQueue(okPhoto, noteExec, okStatus);
    expect(await getPendingCount()).toBe(0);
  });
});

describe("offline-queue crash-safe removal-after-success", () => {
  it("persists each removal before attempting the next item", async () => {
    await enqueueNote("note-1", "case-1", "first");
    await enqueueNote("note-2", "case-2", "second");
    await enqueueNote("note-3", "case-3", "third");

    // Each executor call snapshots what is still persisted at the moment it
    // runs. A successful item must be gone from storage before the next item's
    // executor fires, so a force-close mid-drain can't replay a sent op.
    const persistedHeadsAtStart: string[][] = [];
    await drainQueue(okPhoto, async (caseId) => {
      const ids = (await readRawQueue()).map((i) => i.id);
      persistedHeadsAtStart.push(ids);
      return true;
    }, okStatus);

    expect(persistedHeadsAtStart).toEqual([
      ["note-1", "note-2", "note-3"],
      ["note-2", "note-3"],
      ["note-3"],
    ]);
    expect(await getPendingCount()).toBe(0);
  });

  it("a crash after a success (next item fails) leaves the sent item removed", async () => {
    await enqueueNote("note-1", "case-1", "first");
    await enqueueNote("note-2", "case-2", "second");

    // Simulate force-close: first item is sent successfully, then the process
    // dies before the second can complete (modelled as a failure that stops
    // the drain). On relaunch the first item must NOT replay.
    await drainQueue(okPhoto, async (caseId) => caseId === "case-1", okStatus);

    const queue = await readRawQueue();
    expect(queue.map((i) => i.id)).toEqual(["note-2"]);
  });
});

describe("offline-queue stuck-item tracking", () => {
  it("records attempt count and lastError on each failed drain", async () => {
    await enqueueNote("note-1", "case-1", "first");

    await drainQueue(okPhoto, async () => false, okStatus);

    const queue = await readRawQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].attempts).toBe(1);
    expect(queue[0].lastError).toBeTruthy();
    expect(queue[0].lastAttemptAt).toBeTypeOf("number");
  });

  it("captures a thrown error message as lastError", async () => {
    await enqueueNote("note-1", "case-1", "first");

    await drainQueue(okPhoto, async () => {
      throw new Error("boom-network");
    }, okStatus);

    const queue = await readRawQueue();
    expect(queue[0].lastError).toContain("boom-network");
  });

  it("marks an item stuck after MAX_SYNC_ATTEMPTS failed drains", async () => {
    await enqueueNote("note-1", "case-1", "first");

    for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
      await drainQueue(okPhoto, async () => false, okStatus);
    }

    const summary = await getQueueSummary();
    expect(summary.total).toBe(1);
    expect(summary.stuckCount).toBe(1);
    expect(summary.stuckItems[0]).toMatchObject({ id: "note-1", attempts: MAX_SYNC_ATTEMPTS });
  });

  it("skips a stuck head item so it no longer blocks items behind it", async () => {
    await enqueueNote("note-1", "case-1", "stuck");
    await enqueueNote("note-2", "case-2", "behind");

    // Drive note-1 to stuck; note-2 keeps getting blocked until then.
    const noteExec = async (caseId: string) => caseId !== "case-1";
    for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
      await drainQueue(okPhoto, noteExec, okStatus);
    }

    // note-1 is now stuck; the drain that pushed it over the threshold also
    // continued on to drain note-2.
    const queue = await readRawQueue();
    expect(queue.map((i) => i.id)).toEqual(["note-1"]);
    const summary = await getQueueSummary();
    expect(summary.stuckCount).toBe(1);
  });

  it("does not block when a stuck item sits ahead of a healthy one", async () => {
    await enqueueNote("note-1", "case-1", "stuck");
    await enqueueNote("note-2", "case-2", "healthy");

    const failHead = async (caseId: string) => caseId !== "case-1";
    for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
      await drainQueue(okPhoto, failHead, okStatus);
    }
    // note-2 already drained above; only the stuck note-1 remains.
    expect((await readRawQueue()).map((i) => i.id)).toEqual(["note-1"]);
  });
});

describe("offline-queue categorized failures", () => {
  it("categorizeSyncStatus maps statuses to the right category", () => {
    expect(categorizeSyncStatus(500)).toBe("server");
    expect(categorizeSyncStatus(503)).toBe("server");
    expect(categorizeSyncStatus(408)).toBe("server");
    expect(categorizeSyncStatus(429)).toBe("server");
    expect(categorizeSyncStatus(400)).toBe("validation");
    expect(categorizeSyncStatus(422)).toBe("validation");
    expect(categorizeSyncStatus(403)).toBe("rejected");
    expect(categorizeSyncStatus(404)).toBe("rejected");
    expect(categorizeSyncStatus(0)).toBe("network");
  });

  it("isSyncSuccess only treats `true` as success", () => {
    expect(isSyncSuccess(true)).toBe(true);
    expect(isSyncSuccess(false)).toBe(false);
    expect(isSyncSuccess({ ok: false, category: "rejected" })).toBe(false);
  });

  it("a bare false failure is recorded as a transient network reason", async () => {
    await enqueueNote("note-1", "case-1", "first");
    await drainQueue(okPhoto, async () => false, okStatus);

    const queue = await readRawQueue();
    expect(queue[0].attempts).toBe(1);
    expect(queue[0].lastErrorCategory).toBe("network");
    expect(queue[0].lastError).toBe(messageForCategory("network"));
  });

  it("a permanent rejection (4xx) wedges the item immediately", async () => {
    await enqueueNote("note-1", "case-1", "first");

    // One drain with a 403 should mark it stuck without burning all retries.
    await drainQueue(okPhoto, async () => syncFailureFromStatus(403), okStatus);

    const summary = await getQueueSummary();
    expect(summary.stuckCount).toBe(1);
    expect(summary.stuckItems[0]).toMatchObject({
      attempts: MAX_SYNC_ATTEMPTS,
      lastErrorCategory: "rejected",
      lastError: messageForCategory("rejected"),
    });
  });

  it("a validation failure (422) wedges the item immediately", async () => {
    await enqueueNote("note-1", "case-1", "first");
    await drainQueue(okPhoto, async () => syncFailureFromStatus(422), okStatus);

    const summary = await getQueueSummary();
    expect(summary.stuckCount).toBe(1);
    expect(summary.stuckItems[0].lastErrorCategory).toBe("validation");
  });

  it("a transient server error (5xx) keeps retrying instead of wedging", async () => {
    await enqueueNote("note-1", "case-1", "first");
    await drainQueue(okPhoto, async () => syncFailureFromStatus(503), okStatus);

    const queue = await readRawQueue();
    // Only one attempt burned — still has retry budget left, not stuck yet.
    expect(queue[0].attempts).toBe(1);
    expect(queue[0].lastErrorCategory).toBe("server");
    expect((await getQueueSummary()).stuckCount).toBe(0);
  });

  it("a permanent rejection at the head does not block items behind it", async () => {
    await enqueueNote("note-1", "case-1", "rejected");
    await enqueueNote("note-2", "case-2", "healthy");

    // note-1 is permanently rejected (wedged immediately); the same drain then
    // continues on to drain the healthy note-2.
    await drainQueue(
      okPhoto,
      async (caseId) => (caseId === "case-1" ? syncFailureFromStatus(404) : true),
      okStatus
    );

    expect((await readRawQueue()).map((i) => i.id)).toEqual(["note-1"]);
    expect((await getQueueSummary()).stuckCount).toBe(1);
  });
});

describe("offline-queue manual retry / discard", () => {
  it("retryItem resets a stuck item so the next drain retries it", async () => {
    await enqueueNote("note-1", "case-1", "first");
    for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
      await drainQueue(okPhoto, async () => false, okStatus);
    }
    expect((await getQueueSummary()).stuckCount).toBe(1);

    await retryItem("note-1");
    const afterReset = await readRawQueue();
    expect(afterReset[0].attempts ?? 0).toBe(0);
    expect(afterReset[0].lastError).toBeUndefined();

    // Now succeed — the reset item drains.
    await drainQueue(okPhoto, okNote, okStatus);
    expect(await getPendingCount()).toBe(0);
  });

  it("retryAllStuck resets every stuck item", async () => {
    await enqueueNote("note-1", "case-1", "a");
    await enqueueNote("note-2", "case-2", "b");
    // An item only accrues attempts once it reaches the drain head, so it
    // takes MAX attempts to wedge note-1, then MAX more to wedge note-2.
    for (let i = 0; i < MAX_SYNC_ATTEMPTS * 2; i++) {
      await drainQueue(okPhoto, async () => false, okStatus);
    }
    expect((await getQueueSummary()).stuckCount).toBe(2);

    await retryAllStuck();
    expect((await getQueueSummary()).stuckCount).toBe(0);
    expect(await getPendingCount()).toBe(2);
  });

  it("discardItem permanently removes a stuck item and unblocks the queue", async () => {
    await enqueueNote("note-1", "case-1", "stuck");
    await enqueueNote("note-2", "case-2", "behind");
    const failHead = async (caseId: string) => caseId !== "case-1";
    for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
      await drainQueue(okPhoto, failHead, okStatus);
    }
    // note-2 drained; note-1 stuck.
    expect((await readRawQueue()).map((i) => i.id)).toEqual(["note-1"]);

    await discardItem("note-1");
    expect(await getPendingCount()).toBe(0);
  });
});

describe("offline-queue summary subscription", () => {
  it("notifies subscribers with total and stuck counts on mutation", async () => {
    const summaries: { total: number; stuckCount: number }[] = [];
    const unsubscribe = subscribeToQueueSummary((s) =>
      summaries.push({ total: s.total, stuckCount: s.stuckCount })
    );
    // Allow the immediate-on-subscribe async notification to land.
    await getQueueSummary();

    await enqueueNote("note-1", "case-1", "first");
    for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
      await drainQueue(okPhoto, async () => false, okStatus);
    }

    unsubscribe();
    const last = summaries[summaries.length - 1];
    expect(last).toEqual({ total: 1, stuckCount: 1 });
  });
});

describe("offline-queue status executor (rawSyncCaseStatus contract)", () => {
  // Mirrors rawSyncCaseStatus in app-context.tsx: the executor re-reads the
  // case's latest local state from a live ref (so a collapsed status entry
  // always syncs the most recent station), and treats a missing case as done
  // (returns true) so a deleted case can't wedge the queue.
  type LocalCase = { id: string; status: string };

  function makeStatusExecutor(casesRef: { current: LocalCase[] }, synced: LocalCase[]) {
    return async (caseId: string): Promise<boolean> => {
      const labCase = casesRef.current.find((c) => c.id === caseId);
      if (!labCase) return true; // missing case → done
      synced.push({ ...labCase });
      return true;
    };
  }

  it("syncs the latest case state, not the state at enqueue time", async () => {
    const casesRef = { current: [{ id: "case-1", status: "IN_PROGRESS" }] as LocalCase[] };
    const synced: LocalCase[] = [];

    // Enqueue while the case is IN_PROGRESS, then the user keeps moving it
    // offline; the collapsed entry stays single but state advances.
    await enqueueStatus("case-1");
    await enqueueStatus("case-1");
    casesRef.current = [{ id: "case-1", status: "COMPLETE" }];

    await drainQueue(okPhoto, okNote, makeStatusExecutor(casesRef, synced));

    expect(synced).toEqual([{ id: "case-1", status: "COMPLETE" }]);
    expect(await getPendingCount()).toBe(0);
  });

  it("treats a missing case as done and drains the entry", async () => {
    const casesRef = { current: [] as LocalCase[] };
    const synced: LocalCase[] = [];

    await enqueueStatus("ghost-case");
    await drainQueue(okPhoto, okNote, makeStatusExecutor(casesRef, synced));

    expect(synced).toEqual([]);
    expect(await getPendingCount()).toBe(0);
  });

  it("a missing case at the head does not wedge later items", async () => {
    const casesRef = { current: [{ id: "case-2", status: "COMPLETE" }] as LocalCase[] };
    const synced: LocalCase[] = [];

    await enqueueStatus("ghost-case"); // head: deleted → done
    await enqueueStatus("case-2"); // should still sync after the ghost is cleared

    await drainQueue(okPhoto, okNote, makeStatusExecutor(casesRef, synced));

    expect(synced).toEqual([{ id: "case-2", status: "COMPLETE" }]);
    expect(await getPendingCount()).toBe(0);
  });
});
