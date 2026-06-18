import { describe, it, expect } from "vitest";
import { buildInvoiceMetaPairs } from "../export";

// ---------------------------------------------------------------------------
// Unit tests for the invoice PDF "meta" row (Issued / Due / Status / Teeth /
// Shade / Material). These are the rules that decide whether the AI-intake
// shade and material appear on the rendered invoice PDF, extracted out of the
// jsPDF rendering so they can be asserted without producing a real document.
// ---------------------------------------------------------------------------

const base = {
  issuedAt: "2026-01-15T00:00:00.000Z",
  dueAt: "2026-02-15T00:00:00.000Z",
  status: "open",
};

function labels(pairs: Array<[string, string]>) {
  return pairs.map(([label]) => label);
}

function valueFor(pairs: Array<[string, string]>, label: string) {
  return pairs.find(([l]) => l === label)?.[1];
}

describe("buildInvoiceMetaPairs", () => {
  it("always includes Issued, Due, and Status", () => {
    const pairs = buildInvoiceMetaPairs(base);
    expect(labels(pairs)).toEqual(["Issued", "Due", "Status"]);
    expect(valueFor(pairs, "Status")).toBe("open");
  });

  it("appends Shade when the snapshot carries one", () => {
    const pairs = buildInvoiceMetaPairs({ ...base, shade: "A2" });
    expect(labels(pairs)).toContain("Shade");
    expect(valueFor(pairs, "Shade")).toBe("A2");
  });

  it("appends Material when the snapshot carries one", () => {
    const pairs = buildInvoiceMetaPairs({ ...base, material: "Zirconia" });
    expect(labels(pairs)).toContain("Material");
    expect(valueFor(pairs, "Material")).toBe("Zirconia");
  });

  it("shows both shade and material together (AI intake case)", () => {
    const pairs = buildInvoiceMetaPairs({
      ...base,
      teeth: "3, 14",
      shade: "A2, A3",
      material: "Zirconia, E.max",
    });
    expect(labels(pairs)).toEqual([
      "Issued",
      "Due",
      "Status",
      "Teeth",
      "Shade",
      "Material",
    ]);
    expect(valueFor(pairs, "Shade")).toBe("A2, A3");
    expect(valueFor(pairs, "Material")).toBe("Zirconia, E.max");
  });

  it("omits Shade/Material when empty or whitespace-only", () => {
    const pairs = buildInvoiceMetaPairs({
      ...base,
      shade: "",
      material: "   ",
    });
    expect(labels(pairs)).not.toContain("Shade");
    expect(labels(pairs)).not.toContain("Material");
  });

  it("trims surrounding whitespace from shade and material values", () => {
    const pairs = buildInvoiceMetaPairs({
      ...base,
      shade: "  A1  ",
      material: "  PFM  ",
    });
    expect(valueFor(pairs, "Shade")).toBe("A1");
    expect(valueFor(pairs, "Material")).toBe("PFM");
  });
});
