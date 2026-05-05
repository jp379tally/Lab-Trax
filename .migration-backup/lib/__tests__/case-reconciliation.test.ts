import { describe, it, expect } from "vitest";
import { reconcileCases } from "../case-reconciliation";
import type { LabCase } from "../data";

function makeCase(
  id: string,
  overrides: Partial<LabCase> = {}
): LabCase {
  return {
    id,
    caseNumber: "C-" + id,
    patientName: "Patient " + id,
    patientInitials: "P." + id.charAt(0).toUpperCase(),
    caseType: "Crown & Bridge",
    doctorName: "Dr. Test",
    practiceName: "Test Practice",
    teeth: [],
    shade: null,
    notes: "",
    photos: [],
    documents: [],
    voiceMemos: [],
    workQueue: [],
    timeline: [],
    pendingTasks: [],
    materials: [],
    status: "in_progress",
    rush: false,
    qcChecklist: null,
    pickupAddress: "",
    deliveryAddress: "",
    invoiceId: null,
    affiliationKey: null,
    affiliationName: null,
    ownerId: "user-1",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  } as LabCase;
}

describe("reconcileCases", () => {
  it("adopts the server's copy when the same id exists in both", () => {
    const local = makeCase("a", { patientName: "Old", updatedAt: 1 });
    const server = makeCase("a", { patientName: "New", updatedAt: 2 });
    const { next, changed } = reconcileCases([local], [server]);
    expect(next).toHaveLength(1);
    expect(next[0].patientName).toBe("New");
    expect(changed).toBe(true);
  });

  it("adopts the server's copy even when timestamps are identical", () => {
    // Critical: the server normalizes affiliationKey from organization_id
    // on every read. After a backfill, server's updatedAt may equal local's
    // but the server copy is still the canonical one.
    const local = makeCase("a", { affiliationKey: null, updatedAt: 5 });
    const server = makeCase("a", { affiliationKey: "org:lab-1", updatedAt: 5 });
    const { next } = reconcileCases([local], [server]);
    expect(next[0].affiliationKey).toBe("org:lab-1");
  });

  it("drops a local lab-tagged case the server did not return (lost access)", () => {
    const ghost = makeCase("ghost", { affiliationKey: "org:lab-removed" });
    const { next, changed } = reconcileCases([ghost], []);
    expect(next).toEqual([]);
    expect(changed).toBe(true);
  });

  it("keeps a local private (no-tag) case the server did not return (offline pending)", () => {
    const pending = makeCase("p", { affiliationKey: null });
    const { next, changed } = reconcileCases([pending], []);
    expect(next).toEqual([pending]);
    expect(changed).toBe(false);
  });

  it("adds new server cases the local cache has never seen", () => {
    const fresh = makeCase("new-on-server", { affiliationKey: "org:lab-1" });
    const { next, changed } = reconcileCases([], [fresh]);
    expect(next).toEqual([fresh]);
    expect(changed).toBe(true);
  });

  it("handles the multi-device sync case end-to-end", () => {
    // Device 2 just signed in as a user who is a member of lab-1.
    // Local cache is empty. Server returns 3 cases for lab-1.
    const c1 = makeCase("1", { affiliationKey: "org:lab-1" });
    const c2 = makeCase("2", { affiliationKey: "org:lab-1" });
    const c3 = makeCase("3", { affiliationKey: "org:lab-1" });
    const { next, changed } = reconcileCases([], [c1, c2, c3]);
    expect(next).toHaveLength(3);
    expect(changed).toBe(true);
  });

  it("handles the lab-leave scenario", () => {
    // User was in lab-1, scanned 2 cases, then left lab-1.
    // Server now returns nothing (private cache only had lab cases).
    const a = makeCase("a", { affiliationKey: "org:lab-1" });
    const b = makeCase("b", { affiliationKey: "org:lab-1" });
    const c = makeCase("c", { affiliationKey: null }); // a private one
    const { next } = reconcileCases([a, b, c], []);
    expect(next).toEqual([c]); // both lab cases dropped, private kept
  });

  it("keeps an offline-pending private case while merging server cases", () => {
    const pending = makeCase("offline", { affiliationKey: null });
    const fromServer = makeCase("synced", { affiliationKey: "org:lab-1" });
    const { next } = reconcileCases([pending], [fromServer]);
    const ids = next.map((c) => c.id).sort();
    expect(ids).toEqual(["offline", "synced"]);
  });

  it("returns changed=false when server response exactly matches local", () => {
    const a = makeCase("a", { affiliationKey: "org:lab-1" });
    const b = makeCase("b", { affiliationKey: null });
    const { next, changed } = reconcileCases([a, b], [a]);
    // a is replaced by server-a (identical reference → no change), b is kept (private).
    expect(next).toEqual([a, b]);
    expect(changed).toBe(false);
  });
});
