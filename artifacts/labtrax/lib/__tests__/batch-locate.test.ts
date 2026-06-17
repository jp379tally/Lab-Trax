import { describe, it, expect, vi } from "vitest";
import {
  isDuplicateScan,
  prependScannedCase,
  splitBatchResults,
  runBatchMove,
  type ScannedCase,
} from "@/app/batch-locate/index";

function makeCase(barcode: string, overrides: Partial<ScannedCase> = {}): ScannedCase {
  return {
    barcode,
    caseId: `case-${barcode}`,
    patientName: `Patient ${barcode}`,
    caseNumber: `CN-${barcode}`,
    currentLocation: "received",
    ...overrides,
  };
}

// ── isDuplicateScan ───────────────────────────────────────────────────────────

describe("isDuplicateScan", () => {
  it("returns false for a barcode not yet in the seen set", () => {
    const seen = new Set<string>();
    expect(isDuplicateScan(seen, "ABC123")).toBe(false);
  });

  it("returns true for a barcode already in the seen set", () => {
    const seen = new Set(["ABC123"]);
    expect(isDuplicateScan(seen, "ABC123")).toBe(true);
  });

  it("is case-sensitive", () => {
    const seen = new Set(["abc123"]);
    expect(isDuplicateScan(seen, "ABC123")).toBe(false);
  });

  it("scanning the same barcode 3× → count stays 1", () => {
    const seen = new Set<string>();
    const barcode = "REPEAT";
    let addCount = 0;

    for (let i = 0; i < 3; i++) {
      if (!isDuplicateScan(seen, barcode)) {
        seen.add(barcode);
        addCount++;
      }
    }

    expect(addCount).toBe(1);
    expect(seen.size).toBe(1);
  });
});

// ── prependScannedCase ────────────────────────────────────────────────────────

describe("prependScannedCase", () => {
  it("adds the first case to an empty list", () => {
    const c = makeCase("A");
    const result = prependScannedCase([], c);
    expect(result).toHaveLength(1);
    expect(result[0]?.barcode).toBe("A");
  });

  it("puts the newest case at index 0 (newest-on-top)", () => {
    const first = makeCase("FIRST");
    const second = makeCase("SECOND");
    let list = prependScannedCase([], first);
    list = prependScannedCase(list, second);
    expect(list[0]?.barcode).toBe("SECOND");
    expect(list[1]?.barcode).toBe("FIRST");
  });

  it("multi-scan count reflects total distinct barcodes", () => {
    const barcodes = ["A", "B", "C", "D"];
    let list: ScannedCase[] = [];
    for (const b of barcodes) {
      list = prependScannedCase(list, makeCase(b));
    }
    expect(list).toHaveLength(barcodes.length);
  });

  it("does not mutate the original list", () => {
    const original = [makeCase("X")];
    const result = prependScannedCase(original, makeCase("Y"));
    expect(original).toHaveLength(1);
    expect(result).toHaveLength(2);
  });
});

// ── splitBatchResults ─────────────────────────────────────────────────────────

describe("splitBatchResults", () => {
  it("puts fulfilled results in succeededIds", () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: "fulfilled", value: {} },
      { status: "fulfilled", value: {} },
    ];
    const { succeededIds, failedIds } = splitBatchResults(results, ["c1", "c2"]);
    expect(succeededIds).toEqual(["c1", "c2"]);
    expect(failedIds).toEqual([]);
  });

  it("puts rejected results in failedIds", () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: "rejected", reason: new Error("network") },
      { status: "rejected", reason: new Error("server error") },
    ];
    const { succeededIds, failedIds } = splitBatchResults(results, ["c1", "c2"]);
    expect(succeededIds).toEqual([]);
    expect(failedIds).toEqual(["c1", "c2"]);
  });

  it("correctly splits a partial failure", () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: "fulfilled", value: {} },
      { status: "rejected", reason: new Error("timeout") },
      { status: "fulfilled", value: {} },
    ];
    const { succeededIds, failedIds } = splitBatchResults(results, ["c1", "c2", "c3"]);
    expect(succeededIds).toEqual(["c1", "c3"]);
    expect(failedIds).toEqual(["c2"]);
  });

  it("handles an empty batch", () => {
    const { succeededIds, failedIds } = splitBatchResults([], []);
    expect(succeededIds).toEqual([]);
    expect(failedIds).toEqual([]);
  });
});

// ── runBatchMove ──────────────────────────────────────────────────────────────

describe("runBatchMove", () => {
  it("calls mutateFn exactly once per scanned case", async () => {
    const cases = [makeCase("A"), makeCase("B"), makeCase("C")];
    const mutateFn = vi.fn().mockResolvedValue({});

    await runBatchMove(cases, "post_mill", mutateFn, () => {});

    expect(mutateFn).toHaveBeenCalledTimes(3);
  });

  it("passes the correct caseId and status to each call", async () => {
    const cases = [makeCase("X"), makeCase("Y")];
    const mutateFn = vi.fn().mockResolvedValue({});

    await runBatchMove(cases, "qc", mutateFn, () => {});

    expect(mutateFn).toHaveBeenCalledWith({
      caseId: "case-X",
      data: { status: "qc" },
    });
    expect(mutateFn).toHaveBeenCalledWith({
      caseId: "case-Y",
      data: { status: "qc" },
    });
  });

  it("reports progress for every case — success and failure both increment", async () => {
    const cases = [makeCase("A"), makeCase("B"), makeCase("C")];
    const mutateFn = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({});

    let progressCount = 0;
    await runBatchMove(cases, "received", mutateFn, () => { progressCount++; });

    // Progress must fire for all 3 cases (success + failure + success)
    expect(progressCount).toBe(3);
  });

  it("returns the correct succeeded/failed split", async () => {
    const cases = [makeCase("A"), makeCase("B"), makeCase("C")];
    const mutateFn = vi
      .fn()
      .mockResolvedValueOnce({})          // A succeeds
      .mockRejectedValueOnce(new Error()) // B fails
      .mockResolvedValueOnce({});         // C succeeds

    const { succeededIds, failedIds } = await runBatchMove(
      cases, "scan", mutateFn, () => {},
    );

    expect(succeededIds).toEqual(["case-A", "case-C"]);
    expect(failedIds).toEqual(["case-B"]);
  });

  it("retry calls mutateFn only for failed cases, not already-succeeded ones", async () => {
    const allCases = [makeCase("A"), makeCase("B"), makeCase("C"), makeCase("D")];

    // First pass: A, C succeed; B, D fail
    const firstMutateFn = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error())
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error());

    const { failedIds } = await runBatchMove(
      allCases, "in_milling", firstMutateFn, () => {},
    );
    expect(failedIds).toEqual(["case-B", "case-D"]);

    // Retry: only the 2 failed cases
    const failedCases = allCases.filter((c) => failedIds.includes(c.caseId));
    const retryMutateFn = vi.fn().mockResolvedValue({});

    const { succeededIds: retrySucceeded, failedIds: retryFailed } =
      await runBatchMove(failedCases, "in_milling", retryMutateFn, () => {});

    // Retry only touches the 2 failed cases
    expect(retryMutateFn).toHaveBeenCalledTimes(2);
    expect(retrySucceeded).toEqual(["case-B", "case-D"]);
    expect(retryFailed).toEqual([]);
  });

  it("invalid barcode is not added — scanned count unchanged", () => {
    const seen = new Set<string>();
    let list: ScannedCase[] = [];

    const scanResults: Array<{ barcode: string; found: boolean }> = [
      { barcode: "GOOD1", found: true },
      { barcode: "INVALID", found: false },
      { barcode: "GOOD2", found: true },
    ];

    for (const { barcode, found } of scanResults) {
      if (!isDuplicateScan(seen, barcode)) {
        if (found) {
          seen.add(barcode);
          list = prependScannedCase(list, makeCase(barcode));
        }
        // not-found: show notice and keep scanning; no list update
      }
    }

    expect(list).toHaveLength(2);
    expect(list.map((c) => c.barcode)).not.toContain("INVALID");
  });

  it("handles an all-failed batch without throwing", async () => {
    const cases = [makeCase("A"), makeCase("B")];
    const mutateFn = vi.fn().mockRejectedValue(new Error("server down"));

    const { succeededIds, failedIds } = await runBatchMove(
      cases, "qc", mutateFn, () => {},
    );

    expect(succeededIds).toEqual([]);
    expect(failedIds).toEqual(["case-A", "case-B"]);
  });
});
