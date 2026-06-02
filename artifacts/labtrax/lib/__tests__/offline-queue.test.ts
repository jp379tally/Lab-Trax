import { describe, it, expect, beforeEach } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  enqueuePhoto,
  enqueueNote,
  enqueueStatus,
  drainQueue,
  getPendingCount,
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
