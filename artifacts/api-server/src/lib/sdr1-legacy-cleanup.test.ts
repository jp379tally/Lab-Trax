import { describe, expect, it } from "vitest";
import {
  classifySdr1LegacyRows,
  findMatchingTarget,
  namesMatch,
  parseLegacyTimestampMs,
  type Sdr1CleanupConfiguration,
} from "./sdr1-legacy-cleanup";

const start = Date.parse("2026-03-01T00:00:00.000Z");
const end = Date.parse("2026-07-01T00:00:00.000Z");
const inside = Date.parse("2026-05-01T00:00:00.000Z");
const targets = ["Sample/Patient", "Alex Fixture"];
const cleanup: Sdr1CleanupConfiguration = {
  eraStartMs: start,
  eraEndMs: end,
  targetPatients: targets,
};

function legacyRow(id: string, blob: Record<string, unknown> | string) {
  return {
    id,
    organizationId: "synthetic-organization",
    caseData: typeof blob === "string" ? blob : JSON.stringify(blob),
  };
}

describe("legacy cleanup name matching", () => {
  it("matches exact tokens across case, order, and punctuation", () => {
    expect(namesMatch("Patient, Sample", "Sample/Patient")).toBe(true);
    expect(namesMatch("SAMPLE PATIENT", "Patient/Sample")).toBe(true);
    expect(namesMatch("Sample Patient Jr", "Patient/Sample")).toBe(true);
  });

  it("rejects shared-surname and substring matches", () => {
    expect(namesMatch("Other Sample", "Sample/Patient")).toBe(false);
    expect(namesMatch("Sample Patient Extra Token", "Sample/Patient")).toBe(false);
    expect(namesMatch("Sample Patientson", "Sample/Patient")).toBe(false);
  });

  it("finds only a supplied synthetic target", () => {
    expect(findMatchingTarget("Patient, Sample", targets)).toBe("Sample/Patient");
    expect(findMatchingTarget("Unlisted Person", targets)).toBeNull();
    expect(findMatchingTarget(null, targets)).toBeNull();
  });
});

describe("legacy cleanup timestamp parsing", () => {
  it("accepts epoch milliseconds, numeric strings, and ISO dates", () => {
    expect(parseLegacyTimestampMs(1780000000000)).toBe(1780000000000);
    expect(parseLegacyTimestampMs("1780000000000")).toBe(1780000000000);
    expect(parseLegacyTimestampMs("2026-05-01T00:00:00.000Z")).toBe(inside);
  });

  it("rejects malformed, empty, and epoch-seconds values", () => {
    expect(parseLegacyTimestampMs("not-a-date")).toBeNull();
    expect(parseLegacyTimestampMs("")).toBeNull();
    expect(parseLegacyTimestampMs(null)).toBeNull();
    expect(parseLegacyTimestampMs(undefined)).toBeNull();
    expect(parseLegacyTimestampMs(1780000000)).toBeNull();
  });
});

describe("legacy cleanup classification", () => {
  it("matches configured target names only inside the configured era", () => {
    const rows = [
      legacyRow("a", { patientName: "Patient, Sample", caseNumber: "SYNTH-001", invoiceId: "SYNTH-INV-1", createdAt: inside }),
      legacyRow("b", { patientName: "Alex Fixture", caseNumber: "SYNTH-002", createdAt: String(inside) }),
    ];
    const result = classifySdr1LegacyRows(rows, cleanup);
    expect(result.matched.map((row) => row.id).sort()).toEqual(["a", "b"]);
    expect(result.matched.find((row) => row.id === "a")?.matchedTarget).toBe("Sample/Patient");
    expect(result.matched.find((row) => row.id === "a")?.invoiceRef).toBe("SYNTH-INV-1");
    expect(result.ambiguous).toHaveLength(0);
    expect(result.nonTarget).toHaveLength(0);
  });

  it("keeps non-targets and malformed or out-of-window rows out of the matched set", () => {
    const result = classifySdr1LegacyRows([
      legacyRow("non-target", { patientName: "Unlisted Person", createdAt: inside }),
      legacyRow("missing-date", { patientName: "Sample Patient" }),
      legacyRow("bad-date", { patientName: "Sample Patient", createdAt: "not-a-date" }),
      legacyRow("too-early", { patientName: "Sample Patient", createdAt: start - 1 }),
      legacyRow("too-late", { patientName: "Sample Patient", createdAt: end }),
      legacyRow("in-window", { patientName: "Sample Patient", createdAt: start }),
    ], cleanup);
    expect(result.matched.map((row) => row.id)).toEqual(["in-window"]);
    expect(result.nonTarget.map((row) => row.id)).toEqual(["non-target"]);
    expect(result.ambiguous.map((row) => row.id).sort()).toEqual([
      "bad-date", "missing-date", "too-early", "too-late",
    ]);
    expect(result.ambiguous.every((row) => row.matchedTarget === "Sample/Patient")).toBe(true);
  });

  it("fails closed on unparseable blobs and reports unmatched configured targets", () => {
    const result = classifySdr1LegacyRows([
      legacyRow("malformed", "{not json"),
      legacyRow("sample", { patientName: "Sample Patient", createdAt: inside }),
    ], cleanup);
    expect(result.ambiguous).toMatchObject([{ id: "malformed", reason: "unparseable_blob" }]);
    expect(result.unmatchedTargets).toEqual(["Alex Fixture"]);
  });
});
