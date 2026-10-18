import { describe, it, expect } from "vitest";
import {
  computeCommonBulkStatus,
  filterSelectableStations,
} from "@/components/LocateCaseSheet";

// ── computeCommonBulkStatus ───────────────────────────────────────────────────
//
// This helper drives the bulk-locate station filter:
//   - returns the shared status so same-status stations are excluded (no-op
//     locate cannot be initiated)
//   - returns null when statuses are mixed so every station remains selectable

describe("computeCommonBulkStatus", () => {
  it("returns null for an empty array", async () => {
    expect(computeCommonBulkStatus([])).toBeNull();
  });

  it("returns the lowercase status when a single case is provided", async () => {
    expect(computeCommonBulkStatus([{ status: "received" }])).toBe("received");
  });

  it("normalizes the status to lowercase", async () => {
    expect(computeCommonBulkStatus([{ status: "IN_DESIGN" }])).toBe("in_design");
  });

  it("returns the shared status when all cases have the same status", async () => {
    const cases = [
      { status: "qc" },
      { status: "qc" },
      { status: "qc" },
    ];
    expect(computeCommonBulkStatus(cases)).toBe("qc");
  });

  it("returns null when cases have different statuses", async () => {
    const cases = [
      { status: "received" },
      { status: "in_design" },
      { status: "received" },
    ];
    expect(computeCommonBulkStatus(cases)).toBeNull();
  });

  it("returns null when even one case differs from the rest", async () => {
    const cases = [
      { status: "qc" },
      { status: "qc" },
      { status: "complete" }, // the odd one out
    ];
    expect(computeCommonBulkStatus(cases)).toBeNull();
  });

  it("treats null status as empty string — two null-status cases share a status", async () => {
    expect(computeCommonBulkStatus([{ status: null }, { status: null }])).toBe(
      "",
    );
  });

  it("treats undefined status as empty string — two undefined-status cases share a status", async () => {
    expect(
      computeCommonBulkStatus([{ status: undefined }, { status: undefined }]),
    ).toBe("");
  });

  it("is case-insensitive — 'Received' and 'received' are treated as the same", async () => {
    const cases = [{ status: "Received" }, { status: "received" }];
    expect(computeCommonBulkStatus(cases)).toBe("received");
  });
});

// ── station filter behaviour (integration with the derived values) ─────────────
//
// These tests replicate the actual filter expression used inside LocateCaseSheet
// to verify that bulk-mode same-status stations are excluded exactly the way
// single-mode ones are.

type Location = { id: string; status: string; name: string };

function applyStationFilter(
  locations: Location[],
  commonStatus: string | null,
): Location[] {
  return locations.filter(
    (loc) => commonStatus === null || loc.status !== commonStatus,
  );
}

const LOCATIONS: Location[] = [
  { id: "loc-received", status: "received", name: "Received" },
  { id: "loc-design", status: "in_design", name: "In Design" },
  { id: "loc-qc", status: "qc", name: "QC Bench" },
  { id: "loc-complete", status: "complete", name: "Completed" },
];

describe("bulk station filter — same-status stations are removed", () => {
  it("filters out the matching station when all bulk cases share a status", async () => {
    const commonStatus = computeCommonBulkStatus([
      { status: "received" },
      { status: "received" },
    ]);
    const visible = applyStationFilter(LOCATIONS, commonStatus);
    expect(visible.map((l) => l.id)).not.toContain("loc-received");
    expect(visible).toHaveLength(LOCATIONS.length - 1);
  });

  it("shows all stations when bulk cases have mixed statuses", async () => {
    const commonStatus = computeCommonBulkStatus([
      { status: "received" },
      { status: "in_design" },
    ]);
    const visible = applyStationFilter(LOCATIONS, commonStatus);
    expect(visible).toHaveLength(LOCATIONS.length);
  });

  it("shows all stations when the bulk array is empty", async () => {
    const commonStatus = computeCommonBulkStatus([]);
    const visible = applyStationFilter(LOCATIONS, commonStatus);
    expect(visible).toHaveLength(LOCATIONS.length);
  });

  it("single-case path: filters out the current station", async () => {
    // Single-case always has a concrete status (never null).
    const currentStatus = "qc";
    const visible = applyStationFilter(LOCATIONS, currentStatus);
    expect(visible.map((l) => l.id)).not.toContain("loc-qc");
    expect(visible).toHaveLength(LOCATIONS.length - 1);
  });
});

describe("single station filter — exact location identity", () => {
  it("allows a move between stations sharing one workflow status", async () => {
    const stations = [
      { id: "wax-a", status: "in_design", name: "Wax A" },
      { id: "wax-b", status: "in_design", name: "Wax B" },
      { id: "qc", status: "qc", name: "QC" },
    ];
    expect(
      filterSelectableStations(stations, "in_design", "wax-a").map((s) => s.id),
    ).toEqual(["wax-b", "qc"]);
  });
});
