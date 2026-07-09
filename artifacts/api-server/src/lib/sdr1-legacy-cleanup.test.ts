/**
 * Unit tests for the SDR1 legacy cleanup matching logic (pure, no DB).
 *
 * The dangerous failure modes this guards against:
 *  - matching by invoice/case number alone (numbers 26-1…26-51 were re-used
 *    by legitimate canonical cases with different patients);
 *  - matching a different patient who shares a surname;
 *  - deleting rows whose blob is unparseable or dated outside the legacy era.
 */
import { describe, expect, it } from "vitest";
import {
  SDR1_ERA_END_MS,
  SDR1_ERA_START_MS,
  SDR1_TARGET_PATIENTS,
  classifySdr1LegacyRows,
  findMatchingTarget,
  namesMatch,
  parseLegacyTimestampMs,
} from "./sdr1-legacy-cleanup";

const ERA_MS = Date.parse("2026-05-01T00:00:00.000Z"); // inside the window

function legacyRow(id: string, blob: Record<string, unknown> | string) {
  return {
    id,
    organizationId: "org-sdr1",
    caseData: typeof blob === "string" ? blob : JSON.stringify(blob),
  };
}

describe("namesMatch", () => {
  it("matches identical names and ignores case/order/punctuation", () => {
    expect(namesMatch("Fred Fisher", "Fisher/Fred")).toBe(true);
    expect(namesMatch("Fisher, Fred", "Fisher/Fred")).toBe(true);
    expect(namesMatch("MCNEIL, NORMA", "Mcneil/Norma")).toBe(true);
    expect(namesMatch("Stephanie Sunderman- Barnes", "Stephanie Sunderman-Barnes")).toBe(true);
  });

  it("allows at most one extra token (nickname annotations)", () => {
    expect(namesMatch("Zapata, Yilder (Mark)", "Zapata/Yilder")).toBe(true);
    expect(namesMatch("Zapata, Yilder Mark Extra", "Zapata/Yilder")).toBe(false);
  });

  it("never matches a different patient sharing a surname", () => {
    expect(namesMatch("Stuart Strickland", "Corinne Strickland")).toBe(false);
    expect(namesMatch("Kevin Smith", "Mike Smith")).toBe(false);
    // "Jane Doe" must not match "John David Doe" (both are real targets).
    expect(namesMatch("John David Doe", "Jane Doe")).toBe(false);
  });

  it("requires whole-token matches, not substrings", () => {
    expect(namesMatch("Mike Smithson", "Mike Smith")).toBe(false);
  });
});

describe("findMatchingTarget", () => {
  it("resolves blob-format variants to the target entry", () => {
    expect(findMatchingTarget("Fred Fisher")).toBe("Fisher/Fred");
    expect(findMatchingTarget("Zurko, Cindee")).toBe("Zurko/Cindee");
    expect(findMatchingTarget("Erica Luggery")).toBe("Erica Luggery");
  });

  it("returns null for names not on the list", () => {
    expect(findMatchingTarget("Susan Bryant")).toBeNull();
    expect(findMatchingTarget("Wil Humes")).toBeNull();
    expect(findMatchingTarget("")).toBeNull();
    expect(findMatchingTarget(null)).toBeNull();
  });

  it("every target-list entry matches itself", () => {
    for (const target of SDR1_TARGET_PATIENTS) {
      expect(findMatchingTarget(target)).not.toBeNull();
    }
  });
});

describe("parseLegacyTimestampMs", () => {
  it("accepts epoch-ms numbers and numeric strings", () => {
    expect(parseLegacyTimestampMs(1776191569140)).toBe(1776191569140);
    expect(parseLegacyTimestampMs("1776191569140")).toBe(1776191569140);
  });
  it("rejects garbage, empty, and epoch-seconds-scale values", () => {
    expect(parseLegacyTimestampMs("not-a-date")).toBeNull();
    expect(parseLegacyTimestampMs("")).toBeNull();
    expect(parseLegacyTimestampMs(null)).toBeNull();
    expect(parseLegacyTimestampMs(undefined)).toBeNull();
    expect(parseLegacyTimestampMs(1776191569)).toBeNull(); // epoch-seconds
    expect(parseLegacyTimestampMs(0)).toBeNull();
  });
});

describe("classifySdr1LegacyRows", () => {
  it("matches target names in the era window, in real blob formats", () => {
    const rows = [
      legacyRow("a", { patientName: "Hiram Dodd", caseNumber: "26-2", invoiceId: "17785063x", createdAt: ERA_MS }),
      legacyRow("b", { patientName: "Fred Fisher", caseNumber: "26-31", createdAt: String(ERA_MS) }),
      legacyRow("c", { patientName: "Zapata, Yilder (Mark)", caseNumber: "26-13", createdAt: ERA_MS }),
    ];
    const out = classifySdr1LegacyRows(rows);
    expect(out.matched.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    expect(out.matched.find((r) => r.id === "a")?.invoiceRef).toBe("17785063x");
    expect(out.matched.find((r) => r.id === "b")?.matchedTarget).toBe("Fisher/Fred");
    expect(out.ambiguous).toHaveLength(0);
    expect(out.nonTarget).toHaveLength(0);
  });

  it("classifies non-target names as nonTarget (never matched)", () => {
    const out = classifySdr1LegacyRows([
      legacyRow("x", { patientName: "Susan Bryant", caseNumber: "26-1", createdAt: ERA_MS }),
      legacyRow("y", { patientName: "Wil Humes", caseNumber: "26-44", createdAt: ERA_MS }),
    ]);
    expect(out.matched).toHaveLength(0);
    expect(out.nonTarget.map((r) => r.id).sort()).toEqual(["x", "y"]);
  });

  it("fails closed on missing/unparseable dates and out-of-window dates", () => {
    const out = classifySdr1LegacyRows([
      legacyRow("no-date", { patientName: "Jane Doe", caseNumber: "26-9" }),
      legacyRow("bad-date", { patientName: "Jane Doe", caseNumber: "26-9", createdAt: "garbage" }),
      legacyRow("too-early", { patientName: "Jane Doe", caseNumber: "26-9", createdAt: SDR1_ERA_START_MS - 1 }),
      legacyRow("too-late", { patientName: "Jane Doe", caseNumber: "26-9", createdAt: SDR1_ERA_END_MS }),
      legacyRow("in-window", { patientName: "Jane Doe", caseNumber: "26-9", createdAt: SDR1_ERA_START_MS }),
    ]);
    expect(out.matched.map((r) => r.id)).toEqual(["in-window"]);
    expect(out.ambiguous.map((r) => r.id).sort()).toEqual([
      "bad-date",
      "no-date",
      "too-early",
      "too-late",
    ]);
    expect(out.ambiguous.every((r) => r.matchedTarget === "Jane Doe")).toBe(true);
  });

  it("fails closed on unparseable blobs", () => {
    const out = classifySdr1LegacyRows([legacyRow("junk", "{not json")]);
    expect(out.matched).toHaveLength(0);
    expect(out.ambiguous).toHaveLength(1);
    expect(out.ambiguous[0]!.reason).toBe("unparseable_blob");
  });

  it("reports target names with no active rows as unmatchedTargets", () => {
    const out = classifySdr1LegacyRows([
      legacyRow("a", { patientName: "Sally Test", caseNumber: "26-40", createdAt: ERA_MS }),
    ]);
    expect(out.unmatchedTargets).toContain("Jane Doe");
    expect(out.unmatchedTargets).not.toContain("Sally Test");
    expect(out.unmatchedTargets).toHaveLength(SDR1_TARGET_PATIENTS.length - 1);
  });

  it("matches duplicate rows for the same patient (Debra Hudson had 3 rows)", () => {
    const out = classifySdr1LegacyRows([
      legacyRow("d1", { patientName: "Debra Hudson", caseNumber: "26-1", createdAt: ERA_MS }),
      legacyRow("d2", { patientName: "Debra Hudson", caseNumber: "26-45", createdAt: ERA_MS }),
      legacyRow("d3", { patientName: "Debra Hudson", caseNumber: "26-48", invoiceId: "abc", createdAt: ERA_MS }),
    ]);
    expect(out.matched).toHaveLength(3);
  });
});
