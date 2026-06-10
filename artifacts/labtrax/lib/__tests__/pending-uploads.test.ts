import { describe, it, expect, beforeEach, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  type PendingUpload,
  pendingUploadsStorageKey,
  loadPendingUploads,
  savePendingUploads,
  upsertPendingUpload,
  processPendingUploadsList,
} from "../pending-uploads";

let idCounter = 0;
const nextId = () => `id-${++idCounter}`;

beforeEach(async () => {
  idCounter = 0;
  await AsyncStorage.clear();
});

describe("pendingUploadsStorageKey", () => {
  it("scopes the storage key per user", () => {
    expect(pendingUploadsStorageKey("user-a")).not.toBe(
      pendingUploadsStorageKey("user-b"),
    );
    expect(pendingUploadsStorageKey("user-a")).toContain("user-a");
  });
});

describe("failed upload enters retry queue", () => {
  it("upserts a parked entry for a failed photo upload", () => {
    const next = upsertPendingUpload(
      [],
      { caseId: "case-1", fileUri: "file:///photo.jpg", isVid: false },
      nextId,
      1000,
    );
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      caseId: "case-1",
      fileUri: "file:///photo.jpg",
      isVid: false,
      attempts: 0,
      createdAt: 1000,
    });
  });

  it("de-duplicates the same (caseId, fileUri) instead of queuing twice", () => {
    const first = upsertPendingUpload(
      [],
      { caseId: "case-1", fileUri: "file:///photo.jpg", isVid: false },
      nextId,
    );
    const second = upsertPendingUpload(
      first,
      { caseId: "case-1", fileUri: "file:///photo.jpg", isVid: false },
      nextId,
    );
    expect(second).toHaveLength(1);
  });
});

describe("retry resumes after app restart", () => {
  it("reloads a persisted queue for the same user on a fresh launch", async () => {
    const queue: PendingUpload[] = [
      {
        id: "id-1",
        caseId: "case-1",
        fileUri: "file:///photo.jpg",
        isVid: false,
        createdAt: 1000,
        attempts: 1,
      },
    ];
    await savePendingUploads("user-a", queue);

    // Simulate a fresh app launch: nothing in memory, read from storage.
    const reloaded = await loadPendingUploads("user-a");
    expect(reloaded).toEqual(queue);
  });

  it("returns an empty queue when nothing was persisted", async () => {
    expect(await loadPendingUploads("user-a")).toEqual([]);
  });
});

describe("successful retry removes item from queue", () => {
  it("clears recovered entries and reports them via onRecovered", async () => {
    const queue: PendingUpload[] = [
      {
        id: "id-1",
        caseId: "case-1",
        fileUri: "file:///photo.jpg",
        isVid: false,
        createdAt: 1000,
        attempts: 0,
      },
    ];
    const onRecovered = vi.fn();
    const { remaining, recovered } = await processPendingUploadsList(queue, {
      uploadOne: async () => "https://cdn.example/canonical.jpg",
      onRecovered,
    });
    expect(recovered).toBe(1);
    expect(remaining).toHaveLength(0);
    expect(onRecovered).toHaveBeenCalledWith(
      queue[0],
      "https://cdn.example/canonical.jpg",
    );
  });

  it("keeps the entry (with bumped attempts) on transient failure", async () => {
    const queue: PendingUpload[] = [
      {
        id: "id-1",
        caseId: "case-1",
        fileUri: "file:///photo.jpg",
        isVid: false,
        createdAt: 1000,
        attempts: 2,
      },
    ];
    const onRecovered = vi.fn();
    const { remaining, recovered } = await processPendingUploadsList(queue, {
      uploadOne: async () => null,
      onRecovered,
      now: () => 5000,
    });
    expect(recovered).toBe(0);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].attempts).toBe(3);
    expect(remaining[0].lastAttemptAt).toBe(5000);
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it("drops entries whose backing local file has vanished", async () => {
    const queue: PendingUpload[] = [
      {
        id: "id-1",
        caseId: "case-1",
        fileUri: "file:///gone.jpg",
        isVid: false,
        createdAt: 1000,
        attempts: 0,
      },
    ];
    const uploadOne = vi.fn(async () => "https://cdn.example/x.jpg");
    const { remaining, recovered } = await processPendingUploadsList(queue, {
      uploadOne,
      fileStillExists: async () => false,
      onRecovered: vi.fn(),
    });
    expect(recovered).toBe(0);
    expect(remaining).toHaveLength(0);
    expect(uploadOne).not.toHaveBeenCalled();
  });
});

describe("duplicate retries do not create duplicate attachments", () => {
  it("uploads each entry exactly once and never re-uploads a recovered one", async () => {
    let queue: PendingUpload[] = [
      {
        id: "id-1",
        caseId: "case-1",
        fileUri: "file:///photo.jpg",
        isVid: false,
        createdAt: 1000,
        attempts: 0,
      },
    ];
    const uploadOne = vi.fn(async () => "https://cdn.example/canonical.jpg");

    const firstPass = await processPendingUploadsList(queue, {
      uploadOne,
      onRecovered: vi.fn(),
    });
    queue = firstPass.remaining;

    // A second background pass (e.g. interval fired again) over the persisted
    // remainder must not upload the already-recovered file again.
    const secondPass = await processPendingUploadsList(queue, {
      uploadOne,
      onRecovered: vi.fn(),
    });

    expect(uploadOne).toHaveBeenCalledTimes(1);
    expect(secondPass.remaining).toHaveLength(0);
  });
});

describe("queue is scoped per user", () => {
  it("one user's parked uploads are invisible to another user", async () => {
    await savePendingUploads("user-a", [
      {
        id: "id-1",
        caseId: "case-a",
        fileUri: "file:///a.jpg",
        isVid: false,
        createdAt: 1000,
        attempts: 0,
      },
    ]);

    expect(await loadPendingUploads("user-a")).toHaveLength(1);
    expect(await loadPendingUploads("user-b")).toHaveLength(0);
  });

  it("persists under a user-scoped storage key", async () => {
    await savePendingUploads("user-a", [
      {
        id: "id-1",
        caseId: "case-a",
        fileUri: "file:///a.jpg",
        isVid: false,
        createdAt: 1000,
        attempts: 0,
      },
    ]);
    const raw = await AsyncStorage.getItem(pendingUploadsStorageKey("user-a"));
    expect(raw).toBeTruthy();
    expect(await AsyncStorage.getItem(pendingUploadsStorageKey("user-b"))).toBeNull();
  });
});
