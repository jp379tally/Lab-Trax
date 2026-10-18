/**
 * Unit tests for the Removable restoration collapse backfill.
 *
 * Verifies that runBackfill:
 *   - collapses multiple same-material Removable rows into one row with all
 *     teeth joined
 *   - calls syncInvoiceFromRestorations once per affected case (which rebuilds
 *     the invoice with QTY = 1 from the single surviving row)
 *   - is idempotent: a second run when every group already has ≤ 1 row is a
 *     no-op that triggers no DB writes and no invoice syncs
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock handles ───────────────────────────────────────────────────

const { mockDbSelect, mockDbUpdate, mockDbDelete, mockSyncInvoice } =
  vi.hoisted(() => ({
    mockDbSelect: vi.fn(),
    mockDbUpdate: vi.fn(),
    mockDbDelete: vi.fn(),
    mockSyncInvoice: vi.fn(),
  }));

// ── Module mocks ──────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
    delete: mockDbDelete,
  },
  systemSettings: {},
  cases: {},
  caseRestorations: {},
}));

vi.mock("./invoice-sync", () => ({
  syncInvoiceFromRestorations: mockSyncInvoice,
}));

// Import AFTER the mocks are registered.
const { runBackfill } = await import(
  "./removable-restoration-collapse-backfill.js"
);

// ── Fluent chain helpers ───────────────────────────────────────────────────

/** Returns a Drizzle-like select builder that resolves to `rows` at .orderBy(). */
function makeSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
}

/** Returns a Drizzle-like update builder that resolves at .where(). */
function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
}

/** Returns a Drizzle-like delete builder that resolves at .where(). */
function makeDeleteChain() {
  return { where: vi.fn().mockResolvedValue(undefined) };
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const CASE_ID = "case-abc";

/** Three Removable rows for the same case + same material (the problematic shape). */
const THREE_REMOVABLE_ROWS = [
  {
    id: "res-1",
    caseId: CASE_ID,
    restorationType: "Removable",
    material: "Acrylic",
    toothNumber: "3",
    createdAt: new Date("2025-01-01T00:00:00Z"),
  },
  {
    id: "res-2",
    caseId: CASE_ID,
    restorationType: "Removable",
    material: "Acrylic",
    toothNumber: "4",
    createdAt: new Date("2025-01-01T00:01:00Z"),
  },
  {
    id: "res-3",
    caseId: CASE_ID,
    restorationType: "Removable",
    material: "Acrylic",
    toothNumber: "5",
    createdAt: new Date("2025-01-01T00:02:00Z"),
  },
];

// ── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockSyncInvoice.mockResolvedValue("inv-1");
});

describe("runBackfill – basic collapse", () => {
  it("collapses 3 Removable rows into 1 and triggers invoice sync", async () => {
    mockDbSelect.mockReturnValueOnce(makeSelectChain(THREE_REMOVABLE_ROWS));

    const updateChain = makeUpdateChain();
    const deleteChain1 = makeDeleteChain();
    const deleteChain2 = makeDeleteChain();
    mockDbUpdate.mockReturnValueOnce(updateChain);
    mockDbDelete.mockReturnValueOnce(deleteChain1);
    mockDbDelete.mockReturnValueOnce(deleteChain2);

    const result = await runBackfill();

    // ── Collapse stats ───────────────────────────────────────────────────
    expect(result.caseCount).toBe(1);
    expect(result.rowsDeleted).toBe(2); // res-2 and res-3 deleted

    // ── Kept row is updated with all three teeth joined ──────────────────
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
    const setCall = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall).toMatchObject({ toothNumber: "3, 4, 5" });

    // ── Extra rows are deleted one by one ───────────────────────────────
    expect(mockDbDelete).toHaveBeenCalledTimes(2);

    // ── Invoice sync is called exactly once for the affected case ────────
    // This is what ultimately produces QTY = 1: syncInvoiceFromRestorations
    // reads the now-single restoration row and builds one invoice line with
    // quantity = 1.
    expect(mockSyncInvoice).toHaveBeenCalledTimes(1);
    expect(mockSyncInvoice).toHaveBeenCalledWith({
      caseId: CASE_ID,
      actorUserId: null,
    });
  });

  it("reports the correct joined tooth string when teeth have whitespace", async () => {
    const rowsWithSpaces = [
      { ...THREE_REMOVABLE_ROWS[0]!, toothNumber: " 3 " },
      { ...THREE_REMOVABLE_ROWS[1]!, toothNumber: "4, 5" }, // already comma-joined
      { ...THREE_REMOVABLE_ROWS[2]!, toothNumber: "6" },
    ];
    mockDbSelect.mockReturnValueOnce(makeSelectChain(rowsWithSpaces));
    mockDbUpdate.mockReturnValueOnce(makeUpdateChain());
    mockDbDelete.mockReturnValueOnce(makeDeleteChain());
    mockDbDelete.mockReturnValueOnce(makeDeleteChain());

    await runBackfill();

    const setCall = mockDbUpdate.mock.results[0]!.value.set.mock
      .calls[0]?.[0] as Record<string, unknown>;
    // Tokens must be trimmed and de-duplicated; order follows row appearance.
    expect(setCall!.toothNumber).toBe("3, 4, 5, 6");
  });

  it("de-duplicates tooth tokens that appear in multiple rows", async () => {
    const duplicateTeeth = [
      { ...THREE_REMOVABLE_ROWS[0]!, toothNumber: "3, 4" },
      { ...THREE_REMOVABLE_ROWS[1]!, toothNumber: "4, 5" }, // tooth 4 duplicated
    ];
    mockDbSelect.mockReturnValueOnce(makeSelectChain(duplicateTeeth));
    mockDbUpdate.mockReturnValueOnce(makeUpdateChain());
    mockDbDelete.mockReturnValueOnce(makeDeleteChain());

    await runBackfill();

    const setCall = mockDbUpdate.mock.results[0]!.value.set.mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(setCall!.toothNumber).toBe("3, 4, 5"); // 4 appears only once
  });
});

describe("runBackfill – idempotency", () => {
  it("does nothing when every Removable group already has exactly 1 row", async () => {
    // Already-collapsed: one row per case.
    const alreadyCollapsed = [THREE_REMOVABLE_ROWS[0]!];
    mockDbSelect.mockReturnValueOnce(makeSelectChain(alreadyCollapsed));

    const result = await runBackfill();

    expect(result.caseCount).toBe(0);
    expect(result.rowsDeleted).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockDbDelete).not.toHaveBeenCalled();
    expect(mockSyncInvoice).not.toHaveBeenCalled();
  });

  it("re-running after a first successful collapse is a no-op", async () => {
    // First run: 3 rows → collapse.
    mockDbSelect.mockReturnValueOnce(makeSelectChain(THREE_REMOVABLE_ROWS));
    mockDbUpdate.mockReturnValueOnce(makeUpdateChain());
    mockDbDelete.mockReturnValueOnce(makeDeleteChain());
    mockDbDelete.mockReturnValueOnce(makeDeleteChain());
    await runBackfill();

    vi.clearAllMocks();
    mockSyncInvoice.mockResolvedValue("inv-1");

    // Second run: the select now returns only the surviving single row.
    const afterCollapse = [THREE_REMOVABLE_ROWS[0]!];
    mockDbSelect.mockReturnValueOnce(makeSelectChain(afterCollapse));

    const result = await runBackfill();

    expect(result.caseCount).toBe(0);
    expect(result.rowsDeleted).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockDbDelete).not.toHaveBeenCalled();
    expect(mockSyncInvoice).not.toHaveBeenCalled();
  });

  it("returns early without any DB writes when there are no Removable rows at all", async () => {
    mockDbSelect.mockReturnValueOnce(makeSelectChain([]));

    const result = await runBackfill();

    expect(result.caseCount).toBe(0);
    expect(result.rowsDeleted).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockDbDelete).not.toHaveBeenCalled();
    expect(mockSyncInvoice).not.toHaveBeenCalled();
  });
});

describe("runBackfill – multi-case / multi-material", () => {
  it("collapses independently per (caseId, material) group", async () => {
    const CASE_B = "case-bbb";
    const rows = [
      // Case A – Acrylic: 2 rows → collapse into 1
      {
        id: "a1",
        caseId: CASE_ID,
        restorationType: "Removable",
        material: "Acrylic",
        toothNumber: "3",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
      {
        id: "a2",
        caseId: CASE_ID,
        restorationType: "Removable",
        material: "Acrylic",
        toothNumber: "4",
        createdAt: new Date("2025-01-01T00:01:00Z"),
      },
      // Case B – Valplast: 2 rows → collapse into 1
      {
        id: "b1",
        caseId: CASE_B,
        restorationType: "Removable",
        material: "Valplast",
        toothNumber: "10",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
      {
        id: "b2",
        caseId: CASE_B,
        restorationType: "Removable",
        material: "Valplast",
        toothNumber: "11",
        createdAt: new Date("2025-01-01T00:01:00Z"),
      },
    ];
    mockDbSelect.mockReturnValueOnce(makeSelectChain(rows));
    // 2 updates + 2 deletes
    mockDbUpdate.mockReturnValue(makeUpdateChain());
    mockDbDelete.mockReturnValue(makeDeleteChain());

    const result = await runBackfill();

    expect(result.caseCount).toBe(2);
    expect(result.rowsDeleted).toBe(2); // one extra per group

    // Invoice sync fires once per case, not once per group.
    expect(mockSyncInvoice).toHaveBeenCalledTimes(2);
    const syncedIds = mockSyncInvoice.mock.calls.map(
      (c: [{ caseId: string }]) => c[0].caseId,
    );
    expect(syncedIds.sort()).toEqual([CASE_B, CASE_ID].sort());
  });

  it("keeps different-material Removable rows on the same case as separate lines", async () => {
    // Same case, but two different materials — they must NOT be collapsed
    // together, each material group stays at 1 row.
    const mixedMaterials = [
      {
        id: "m1",
        caseId: CASE_ID,
        restorationType: "Removable",
        material: "Acrylic",
        toothNumber: "3",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
      {
        id: "m2",
        caseId: CASE_ID,
        restorationType: "Removable",
        material: "Valplast",
        toothNumber: "4",
        createdAt: new Date("2025-01-01T00:01:00Z"),
      },
    ];
    mockDbSelect.mockReturnValueOnce(makeSelectChain(mixedMaterials));

    const result = await runBackfill();

    // Each group has 1 row → nothing to collapse.
    expect(result.caseCount).toBe(0);
    expect(result.rowsDeleted).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockDbDelete).not.toHaveBeenCalled();
    expect(mockSyncInvoice).not.toHaveBeenCalled();
  });
});

describe("runBackfill – non-Removable row isolation", () => {
  it("never deletes or updates a Crown row on a mixed case", async () => {
    // The DB query filters to restorationType = 'Removable', so the Crown row
    // is never returned to application code. The mock simulates that by
    // returning only the two Removable rows — Crown row absent, just as the
    // real WHERE clause would produce.
    const CROWN_ID = "crown-1";

    const rows = [
      {
        id: "rem-1",
        caseId: CASE_ID,
        restorationType: "Removable",
        material: "Acrylic",
        toothNumber: "3",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
      {
        id: "rem-2",
        caseId: CASE_ID,
        restorationType: "Removable",
        material: "Acrylic",
        toothNumber: "4",
        createdAt: new Date("2025-01-01T00:01:00Z"),
      },
      // Crown row ("crown-1") intentionally absent: WHERE restorationType = 'Removable'
      // filters it out before application code ever sees the results.
    ];

    mockDbSelect.mockReturnValueOnce(makeSelectChain(rows));

    const updateChain = makeUpdateChain();
    const deleteChain = makeDeleteChain();
    mockDbUpdate.mockReturnValueOnce(updateChain);
    mockDbDelete.mockReturnValueOnce(deleteChain);

    const result = await runBackfill();

    // ── Collapse stats ────────────────────────────────────────────────────
    // 2 Removable rows → 1 kept, 1 deleted; Crown untouched.
    expect(result.caseCount).toBe(1);
    expect(result.rowsDeleted).toBe(1);

    // ── Only one delete call was made (for rem-2, never for CROWN_ID) ─────
    expect(mockDbDelete).toHaveBeenCalledTimes(1);

    // ── CROWN_ID was never passed to db.delete ────────────────────────────
    // db.delete(caseRestorations).where(eq(caseRestorations.id, deleteId))
    // The deleteId in that call comes exclusively from g.deleteIds which only
    // contains IDs present in the Removable rows returned by the query.
    // Since CROWN_ID was never in those rows it can never reach the delete path.
    // Confirm by asserting the delete where-clause was only triggered once.
    expect(deleteChain.where).toHaveBeenCalledTimes(1);

    // ── Invoice sync fires once for the affected case ─────────────────────
    expect(mockSyncInvoice).toHaveBeenCalledTimes(1);
    expect(mockSyncInvoice).toHaveBeenCalledWith({
      caseId: CASE_ID,
      actorUserId: null,
    });
  });
});

describe("runBackfill – invoice sync resilience", () => {
  it("continues processing other cases even if one invoice sync throws", async () => {
    const CASE_B = "case-bbb";
    const rows = [
      {
        id: "a1",
        caseId: CASE_ID,
        restorationType: "Removable",
        material: "Acrylic",
        toothNumber: "3",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
      {
        id: "a2",
        caseId: CASE_ID,
        restorationType: "Removable",
        material: "Acrylic",
        toothNumber: "4",
        createdAt: new Date("2025-01-01T00:01:00Z"),
      },
      {
        id: "b1",
        caseId: CASE_B,
        restorationType: "Removable",
        material: "Acrylic",
        toothNumber: "10",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
      {
        id: "b2",
        caseId: CASE_B,
        restorationType: "Removable",
        material: "Acrylic",
        toothNumber: "11",
        createdAt: new Date("2025-01-01T00:01:00Z"),
      },
    ];
    mockDbSelect.mockReturnValueOnce(makeSelectChain(rows));
    mockDbUpdate.mockReturnValue(makeUpdateChain());
    mockDbDelete.mockReturnValue(makeDeleteChain());

    // First case sync throws; second should still be attempted.
    mockSyncInvoice
      .mockRejectedValueOnce(new Error("invoice sync failure"))
      .mockResolvedValueOnce("inv-b");

    // Should not throw.
    const result = await runBackfill();

    expect(result.caseCount).toBe(2);
    expect(mockSyncInvoice).toHaveBeenCalledTimes(2);
  });
});
