import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";

// ─── What this file covers ──────────────────────────────────────────────────
// The sibling offline-queue.test.ts exercises the queue module in isolation and
// only *mirrors* the real status executor's logic. These tests instead drive the
// REAL provider wiring end-to-end:
//
//   updateCaseStatus → (failing) syncCaseToServer → enqueueStatus
//        … reconnect (AppState "active") → drainQueue → rawSyncCaseStatus
//        → syncCaseToServer actually hits the API with the latest case state.
//
// plus the photo/note hot-paths (addCasePhotosWithNote → enqueuePhoto, and the
// note it spawns → addNoteToCanonicalCase → enqueueNote) enqueue-on-failure.
//
// The only seam we control is the network boundary in `query-client`
// (`resilientFetch` for JSON writes, `uploadCaseMedia` for multipart uploads);
// everything else — the provider, the offline queue, the reconnect trigger — is
// the real code path.

const PENDING_UPLOADS_KEY = "@labtrax_pending_uploads_v1";
const CASES_KEY = "@drivesync_cases";

type ServerCall = { path: string; method?: string; body?: string };

// Flip to false to simulate "offline": case-write endpoints fail; flip back to
// true to simulate reconnect.
let online = true;
const serverCalls: ServerCall[] = [];

function isCaseWrite(path: string, method?: string): boolean {
  const m = method ?? "GET";
  if (path.startsWith("/api/legacy/cases") && m === "POST") return true; // legacy status sync
  if (/^\/api\/cases\/[^/]+$/.test(path) && m === "PATCH") return true; // canonical status sync
  if (/\/notes$/.test(path) && m === "POST") return true; // note post
  if (/\/attachments$/.test(path) && m === "POST") return true; // attachment create
  return false;
}

const resilientFetchMock = vi.fn(async (path: string, init?: RequestInit) => {
  serverCalls.push({
    path,
    method: init?.method,
    body: typeof init?.body === "string" ? init.body : undefined,
  });
  if (!online && isCaseWrite(path, init?.method)) {
    throw new Error("simulated offline");
  }
  // Default OK JSON for mount fetches and successful writes. Keep the shape
  // broad enough to satisfy every boot fetch (memberships/invites/cases) so no
  // effect thrashes into a refetch loop.
  return new Response(
    JSON.stringify({ data: { id: "att-1" }, cases: [], memberships: [], groups: [] }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
});

const uploadCaseMediaMock = vi.fn(async () => ({
  ok: online,
  status: online ? 200 : 0,
  json: async () => ({ url: "https://storage.example/upload.jpg" }),
}));

// Keep query-client real except the two network primitives the offline wiring
// depends on.
vi.mock("@/lib/query-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query-client")>();
  return {
    ...actual,
    resilientFetch: (...args: unknown[]) =>
      (resilientFetchMock as unknown as (...a: unknown[]) => unknown)(...args),
    uploadCaseMedia: (...args: unknown[]) =>
      (uploadCaseMediaMock as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

// Drive the REAL provider, not the smoke-test stub installed in vitest.setup.ts.
vi.unmock("@/lib/app-context");

// A signed-in user so the provider's sync + offline-drain effects are active.
// IMPORTANT: return STABLE references from useAuth. Several provider effects key
// off `registeredUsers` (and the auth object) in their dependency arrays — a
// fresh `[]` per render would retrigger them every commit and spin the
// membership/invite fetches into an infinite loop, hanging the test.
vi.mock("@/lib/auth-context", () => {
  const registeredUsers: unknown[] = [];
  const refreshUsers = () => {};
  const value = {
    currentUserId: "user-1",
    currentUser: "user-1",
    userType: "lab",
    registeredUsers,
    refreshUsers,
  };
  return {
    useAuth: () => value,
    AuthProvider: ({ children }: { children?: React.ReactNode }) => children ?? null,
  };
});

import { AppProvider, useApp } from "@/lib/app-context";

type AppCtx = ReturnType<typeof useApp>;
let ctx: AppCtx | null = null;
function CaptureContext() {
  ctx = useApp();
  return null;
}

async function renderProvider() {
  // NOTE: render() already wraps its work in act(); nesting it inside an outer
  // act() trips "Can't access .root on unmounted test renderer" on
  // react-test-renderer 19. Call it directly and drive async effects with
  // waitFor instead.
  render(React.createElement(AppProvider, null, React.createElement(CaptureContext)));
  // Wait for loadData() to hydrate the seeded case from the cache.
  await waitFor(() => {
    expect(ctx?.cases.length).toBeGreaterThan(0);
  });
}

async function readQueue() {
  const raw = await AsyncStorage.getItem(PENDING_UPLOADS_KEY);
  return raw ? (JSON.parse(raw) as Array<{ id: string; type: string; caseId: string }>) : [];
}

// Fire the production reconnect trigger: every AppState "change" listener the
// provider registered (the offline drain is one of them) invoked with "active".
async function simulateReconnect() {
  const calls = (AppState.addEventListener as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  const handlers = calls
    .filter((c) => c[0] === "change")
    .map((c) => c[1] as (state: string) => void);
  await act(async () => {
    for (const h of handlers) h("active");
    // let the async drain settle
    await new Promise((r) => setTimeout(r, 0));
  });
}

const baseLegacyCase = {
  // Non-UUID id → treated as a legacy lab_cases case (syncs via POST /legacy/cases).
  id: "1700000000000abc123",
  ownerId: "user-1",
  caseNumber: "5001",
  patientName: "Pat Ient",
  doctorName: "Dr Test",
  status: "INTAKE",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  activityLog: [] as unknown[],
  routeHistory: [] as unknown[],
  photos: [] as string[],
};

const baseCanonicalCase = {
  // UUID id → treated as a canonical case (photo upload + /notes endpoints).
  id: "fe67257e-3a1c-4b2d-9e8f-1a2b3c4d5e6f",
  ownerId: "user-1",
  caseNumber: "6001",
  patientName: "Can Onical",
  doctorName: "Dr Test",
  status: "INTAKE",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  activityLog: [] as unknown[],
  routeHistory: [] as unknown[],
  photos: [] as string[],
  _sourceTable: "cases",
};

beforeEach(async () => {
  online = true;
  serverCalls.length = 0;
  resilientFetchMock.mockClear();
  uploadCaseMediaMock.mockClear();
  (AppState.addEventListener as unknown as { mockClear: () => void }).mockClear();
  ctx = null;
  await AsyncStorage.clear();
});

describe("offline status change reaches the server on reconnect (integration)", () => {
  it("queues a failed status sync, then pushes the latest state to the API on reconnect", async () => {
    await AsyncStorage.setItem(CASES_KEY, JSON.stringify([{ ...baseLegacyCase }]));
    await renderProvider();

    // Go offline and move the case through two stations. The queue collapses
    // these to a single status entry keyed by case id.
    online = false;
    await act(async () => {
      ctx!.updateCaseStatus(baseLegacyCase.id, "DESIGN" as any, "user-1");
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      ctx!.updateCaseStatus(baseLegacyCase.id, "MILLING" as any, "user-1");
      await new Promise((r) => setTimeout(r, 0));
    });

    // The change was enqueued (offline), not silently dropped.
    await waitFor(async () => {
      const q = await readQueue();
      expect(q).toHaveLength(1);
      expect(q[0]).toMatchObject({ id: `status-${baseLegacyCase.id}`, type: "status" });
    });

    // Reconnect and let the real drain run.
    serverCalls.length = 0;
    online = true;
    await simulateReconnect();

    // The drain actually hit the legacy-cases write endpoint…
    const writes = serverCalls.filter(
      (c) => c.path.startsWith("/api/legacy/cases") && c.method === "POST",
    );
    expect(writes.length).toBeGreaterThan(0);

    // …and it synced the LATEST station (MILLING), not the state at enqueue time.
    const syncedStatuses = writes.map((w) => {
      const outer = JSON.parse(w.body ?? "{}");
      const inner = JSON.parse(outer.caseData ?? "{}");
      return inner.status as string;
    });
    expect(syncedStatuses).toContain("MILLING");

    // Queue fully drained.
    await waitFor(async () => {
      expect(await readQueue()).toHaveLength(0);
    });
  });

  it("drains nothing extra when the status sync succeeds immediately (online)", async () => {
    await AsyncStorage.setItem(CASES_KEY, JSON.stringify([{ ...baseLegacyCase }]));
    await renderProvider();

    online = true;
    await act(async () => {
      ctx!.updateCaseStatus(baseLegacyCase.id, "DESIGN" as any, "user-1");
      await new Promise((r) => setTimeout(r, 0));
    });

    // Nothing was queued because the inline sync succeeded.
    expect(await readQueue()).toHaveLength(0);
  });
});

describe("photo & note hot-paths enqueue on failure (integration)", () => {
  it("enqueues a photo upload and the spawned note when offline", async () => {
    await AsyncStorage.setItem(CASES_KEY, JSON.stringify([{ ...baseCanonicalCase }]));
    await renderProvider();

    online = false;
    await act(async () => {
      await ctx!.addCasePhotosWithNote(
        baseCanonicalCase.id,
        ["file:///tmp/photo.jpg"],
        "needs a remake",
        "user-1",
      );
    });

    const q = await readQueue();
    const types = q.map((i) => i.type).sort();
    // The failed multipart upload is queued as a photo, and the note that
    // addCasePhotosWithNote spawned (addNoteToCanonicalCase) is queued too.
    expect(types).toEqual(["note", "photo"]);
    expect(q.every((i) => i.caseId === baseCanonicalCase.id)).toBe(true);
  });

  it("does not enqueue when the photo upload and note both succeed (online)", async () => {
    await AsyncStorage.setItem(CASES_KEY, JSON.stringify([{ ...baseCanonicalCase }]));
    await renderProvider();

    online = true;
    await act(async () => {
      await ctx!.addCasePhotosWithNote(
        baseCanonicalCase.id,
        ["file:///tmp/photo.jpg"],
        "looks good",
        "user-1",
      );
    });

    expect(await readQueue()).toHaveLength(0);
  });

  it("queued photo/note are pushed to the server on reconnect", async () => {
    await AsyncStorage.setItem(CASES_KEY, JSON.stringify([{ ...baseCanonicalCase }]));
    await renderProvider();

    online = false;
    await act(async () => {
      await ctx!.addCasePhotosWithNote(
        baseCanonicalCase.id,
        ["file:///tmp/photo.jpg"],
        "remake please",
        "user-1",
      );
    });
    expect((await readQueue()).length).toBe(2);

    serverCalls.length = 0;
    online = true;
    await simulateReconnect();

    // The note drain hit the canonical notes endpoint and the photo drain
    // re-attempted the upload (uploadCaseMedia) + attachment create.
    const notePosts = serverCalls.filter(
      (c) => /\/notes$/.test(c.path) && c.method === "POST",
    );
    expect(notePosts.length).toBeGreaterThan(0);
    expect(uploadCaseMediaMock).toHaveBeenCalled();

    await waitFor(async () => {
      expect(await readQueue()).toHaveLength(0);
    });
  });
});
