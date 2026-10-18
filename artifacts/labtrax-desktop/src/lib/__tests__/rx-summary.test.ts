import { describe, expect, it } from "vitest";
import {
  deriveRxSummary,
  formatRxTeethLabel,
  formatRxTeethWithShades,
  formatRxToothNumbers,
} from "@/lib/rx-summary";
import type { CaseRestoration } from "@/lib/types";

function restoration(
  toothNumber: string,
  shade: string | null,
  overrides: Partial<CaseRestoration> = {},
): CaseRestoration {
  return {
    id: `restoration-${toothNumber || "arch"}-${shade ?? "none"}`,
    caseId: "case-1",
    toothNumber,
    restorationType: "Crown",
    material: "Zirconia",
    shade,
    quantity: 1,
    unitPrice: 0,
    ...overrides,
  };
}

function pairedLabel(restorations: CaseRestoration[], fallback = "—") {
  return formatRxTeethWithShades(restorations, fallback);
}

describe("formatRxTeethWithShades", () => {
  it("keeps each restoration paired with its own repeated or distinct shade", () => {
    expect(
      pairedLabel([
        restoration("14", "A2"),
        restoration("15", "A2"),
        restoration("16", "B1"),
      ]),
    ).toBe("14 — A2, 15 — A2, 16 — B1");
  });

  it("keeps duplicate restoration rows instead of collapsing their shade pairing", () => {
    expect(
      pairedLabel([restoration("14", "A2"), restoration("14", "A2")]),
    ).toBe("14 — A2, 14 — A2");
  });

  it("keeps unshaded restoration rows readable beside shaded rows", () => {
    expect(
      pairedLabel([restoration("14", "A2"), restoration("15", null)]),
    ).toBe("14 — A2, 15");
  });

  it("preserves range text as the tooth portion of its matching shade", () => {
    expect(pairedLabel([restoration("14-16", "B1")])).toBe("14-16 — B1");
  });

  it("uses readable full-arch labels for shaded removable work", () => {
    expect(
      pairedLabel([
        restoration("Upper", "A3", { restorationType: "Full Denture" }),
        restoration("", "B1", { restorationType: "Full Denture" }),
      ]),
    ).toBe("Upper arch — A3, Full arch (upper & lower) — B1");
  });

  it("retains the caller fallback when no restoration rows exist", () => {
    expect(pairedLabel([], "12, 13")).toBe("12, 13");
  });

  it("retains the plain teeth fallback when every restoration is unshaded", () => {
    const restorations = [restoration("14", null), restoration("15", null)];
    expect(
      pairedLabel(restorations, formatRxTeethLabel(deriveRxSummary(restorations))),
    ).toBe("14, 15");
  });
});

describe("formatRxToothNumbers", () => {
  it("shows recorded restoration teeth without shades and preserves ranges", () => {
    expect(formatRxToothNumbers([
      restoration("14-16", "B1"),
      restoration("3", "A2"),
      restoration("3", "C1"),
    ], "8")).toBe("14-16, 3");
  });

  it("includes explicitly recorded tooth values from missing-tooth restorations", () => {
    expect(formatRxToothNumbers([
      restoration("31", null, { restorationType: "missing" }),
    ])).toBe("31");
  });

  it("falls back to saved legacy case-level tooth text", () => {
    expect(formatRxToothNumbers([], "10-12, 14")).toBe("10-12, 14");
  });

  it("shows a neutral value when neither restorations nor legacy data have teeth", () => {
    expect(formatRxToothNumbers([])).toBe("—");
    expect(formatRxToothNumbers([
      restoration("", "A2", { restorationType: "Full Denture", arch: "upper" }),
    ])).toBe("—");
  });

  it("keeps explicit full-arch shorthand readable without inferring an arch from an empty row", () => {
    expect(formatRxToothNumbers([
      restoration("U/D", null, { restorationType: "Full Denture" }),
      restoration("", null, { restorationType: "Full Denture" }),
    ])).toBe("Upper arch");
  });
});
