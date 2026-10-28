import { describe, expect, it } from "vitest";
import { buildPrescriptionRestorations } from "@/lib/prescription-restorations";
import { deriveCaseHierarchy, encodeRestorationSubtype } from "@workspace/case-taxonomy";

describe("drop-zone shared prescription restoration serialization", () => {
  it.each(["upper", "lower", "both"] as const)(
    "keeps one toothless source per %s appliance with quantity one",
    (arch) => {
      const rows = buildPrescriptionRestorations({
        caseType: "Night Guard",
        material: "Acrylic",
        shade: "Clear",
        arch,
      });
      expect(rows.map((row) => row.arch)).toEqual(
        arch === "both" ? ["upper", "lower"] : [arch],
      );
      for (const row of rows) {
        expect(row).toEqual({
          toothNumber: "",
          restorationType: "Night Guard",
          restorationSubtype: encodeRestorationSubtype(
            deriveCaseHierarchy("Night Guard", null, "Acrylic"),
          ),
          material: "Acrylic",
          shade: "Clear",
          quantity: 1,
          arch: row.arch,
        });
        expect(row).not.toHaveProperty("unitPrice");
        expect(row).not.toHaveProperty("priceOverridden");
      }
      if (rows.length === 2) expect(rows[0]).not.toBe(rows[1]);
    },
  );

  it("preserves Universal tooth order without duplicating fixed work across both arches", () => {
    const rows = buildPrescriptionRestorations({
      toothIndices: " 14, 3 \n 8, ",
      caseType: " Crown ",
      material: "Zirconia",
      arch: "both",
    });
    expect(rows.map(({ toothNumber, arch }) => [toothNumber, arch])).toEqual([
      ["14", undefined], ["3", undefined], ["8", undefined],
    ]);
    expect(rows.every((row) => row.restorationType === "Crown" && row.quantity === 1)).toBe(true);
  });

  it("keeps an unspecified arch absent rather than inferring it from teeth", () => {
    const rows = buildPrescriptionRestorations({ toothIndices: "14 30" });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.toothNumber)).toEqual(["14", "30"]);
    expect(rows.every((row) => row.restorationType === "Other")).toBe(true);
    expect(rows.every((row) => !("arch" in row))).toBe(true);
  });

  it.each([{ caseType: "Crown" }, { material: "Zirconia" }, { shade: "A2" }])(
    "retains toothless extracted details: %j",
    (rx) => {
      expect(buildPrescriptionRestorations(rx)).toEqual([
        expect.objectContaining({ toothNumber: "", quantity: 1 }),
      ]);
    },
  );

  it("does not create an empty source from arch alone", () => {
    expect(buildPrescriptionRestorations({})).toEqual([]);
    expect(buildPrescriptionRestorations({ toothIndices: " , \n ", arch: "both" })).toEqual([]);
  });
});
