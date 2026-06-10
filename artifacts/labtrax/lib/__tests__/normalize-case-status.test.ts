import { describe, it, expect } from "vitest";
import {
  normalizeCaseStatus,
  normalizeCaseStatuses,
  type CaseStatus,
} from "../data";

describe("normalizeCaseStatus", () => {
  it("returns canonical lowercase statuses unchanged (identity)", () => {
    const canonical: CaseStatus[] = [
      "received",
      "in_design",
      "scan",
      "in_milling",
      "post_mill",
      "sintering_furnace",
      "model_room",
      "in_porcelain",
      "qc",
      "shipped",
      "on_hold",
      "complete",
    ];
    for (const status of canonical) {
      expect(normalizeCaseStatus(status)).toBe(status);
    }
  });

  it("maps legacy uppercase mobile tokens to canonical statuses", () => {
    expect(normalizeCaseStatus("INTAKE")).toBe("received");
    expect(normalizeCaseStatus("DESIGN")).toBe("in_design");
    expect(normalizeCaseStatus("SCAN")).toBe("scan");
    expect(normalizeCaseStatus("MILL")).toBe("in_milling");
    expect(normalizeCaseStatus("MILLING")).toBe("in_milling");
    expect(normalizeCaseStatus("POST_MILL")).toBe("post_mill");
    expect(normalizeCaseStatus("MODEL_ROOM")).toBe("model_room");
    expect(normalizeCaseStatus("PORCELAIN")).toBe("in_porcelain");
    expect(normalizeCaseStatus("QC")).toBe("qc");
    expect(normalizeCaseStatus("COMPLETE")).toBe("complete");
    expect(normalizeCaseStatus("SHIP")).toBe("shipped");
    expect(normalizeCaseStatus("REMAKE")).toBe("received");
  });

  it("maps desktop-bridge tokens to canonical statuses (the shipped/on-hold fix)", () => {
    expect(normalizeCaseStatus("DELIVERY")).toBe("shipped");
    expect(normalizeCaseStatus("QC_CHECK")).toBe("qc");
    expect(normalizeCaseStatus("ON_HOLD")).toBe("on_hold");
    expect(normalizeCaseStatus("HOLD")).toBe("on_hold");
    expect(normalizeCaseStatus("SINTERING_FURNACE")).toBe("sintering_furnace");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(normalizeCaseStatus("  ON_HOLD  ")).toBe("on_hold");
    expect(normalizeCaseStatus(" shipped ")).toBe("shipped");
  });

  it("falls back to 'received' for unknown or non-string input", () => {
    expect(normalizeCaseStatus("totally-unknown")).toBe("received");
    expect(normalizeCaseStatus("")).toBe("received");
    expect(normalizeCaseStatus(undefined)).toBe("received");
    expect(normalizeCaseStatus(null)).toBe("received");
    expect(normalizeCaseStatus(42)).toBe("received");
    expect(normalizeCaseStatus({})).toBe("received");
  });
});

describe("normalizeCaseStatuses", () => {
  it("rewrites status + routeHistory[].station + activityLog[].station", () => {
    const input = {
      status: "DELIVERY",
      routeHistory: [
        { station: "INTAKE", timestamp: 1 },
        { station: "ON_HOLD", timestamp: 2 },
      ],
      activityLog: [
        { station: "QC_CHECK", description: "checked" },
        { station: "SHIP", description: "shipped out" },
      ],
    };

    const result = normalizeCaseStatuses(input as any);

    expect(result.status).toBe("shipped");
    expect((result.routeHistory as any[]).map((r) => r.station)).toEqual([
      "received",
      "on_hold",
    ]);
    expect((result.activityLog as any[]).map((e) => e.station)).toEqual([
      "qc",
      "shipped",
    ]);
  });

  it("preserves non-station fields and leaves entries without a station untouched", () => {
    const input = {
      status: "ON_HOLD",
      routeHistory: [{ station: "DELIVERY", timestamp: 99 }],
      activityLog: [
        { description: "note only", timestamp: 5 },
        { station: null, description: "null station" },
      ],
    };

    const result = normalizeCaseStatuses(input as any);

    expect(result.status).toBe("on_hold");
    expect((result.routeHistory as any[])[0]).toEqual({
      station: "shipped",
      timestamp: 99,
    });
    expect((result.activityLog as any[])[0]).toEqual({
      description: "note only",
      timestamp: 5,
    });
    expect((result.activityLog as any[])[1]).toEqual({
      station: null,
      description: "null station",
    });
  });

  it("returns a copy without mutating the original input", () => {
    const input = { status: "INTAKE", routeHistory: [{ station: "SHIP" }] };
    const result = normalizeCaseStatuses(input as any);

    expect(input.status).toBe("INTAKE");
    expect(input.routeHistory[0].station).toBe("SHIP");
    expect(result).not.toBe(input);
  });
});
