import { describe, expect, it } from "vitest";
import {
  CASE_CATEGORY_KEYS,
  CASE_CATEGORY_LABELS,
  classifyCase,
  classifyLegacyCase,
  classifyRestoration,
} from "./case-category.js";

describe("classifyRestoration", () => {
  it("returns uncategorized only when both fields are blank", () => {
    expect(classifyRestoration(null, null)).toBe("uncategorized");
    expect(classifyRestoration("", "   ")).toBe("uncategorized");
    expect(classifyRestoration(undefined, undefined)).toBe("uncategorized");
  });

  it("classifies implant work regardless of material", () => {
    expect(classifyRestoration("Implant Crown", "Zirconia")).toBe("implants");
    expect(classifyRestoration("Custom Abutment", null)).toBe("implants");
    expect(classifyRestoration("Screw-retained crown", "Emax")).toBe(
      "implants",
    );
    expect(classifyRestoration("All-on-4 hybrid", null)).toBe("implants");
  });

  it("classifies zirconia by normalized material, including brand names", () => {
    expect(classifyRestoration("Crown", "Zirconia")).toBe("zirconia");
    expect(classifyRestoration("Crown", "BruxZir")).toBe("zirconia");
    expect(classifyRestoration("Crown", "zirc")).toBe("zirconia");
    expect(classifyRestoration(null, "Zirconia")).toBe("zirconia");
  });

  it("classifies non-zirconia fixed work as crown_bridge", () => {
    expect(classifyRestoration("Crown", "PFM")).toBe("crown_bridge");
    expect(classifyRestoration("Bridge", null)).toBe("crown_bridge");
    expect(classifyRestoration("Veneer", "Emax")).toBe("crown_bridge");
    expect(classifyRestoration("Onlay", null)).toBe("crown_bridge");
    expect(classifyRestoration(null, "Full Cast Gold")).toBe("crown_bridge");
  });

  it("classifies removable appliances", () => {
    expect(classifyRestoration("Full Denture", null)).toBe("removable");
    expect(classifyRestoration("Partial", "Valplast")).toBe("removable");
    expect(classifyRestoration("Flipper", null)).toBe("removable");
  });

  it("falls back to other for unmatched non-blank text", () => {
    expect(classifyRestoration("Night Guard", null)).toBe("other");
    expect(classifyRestoration("Retainer", null)).toBe("other");
    expect(classifyRestoration("Alloy surcharge", null)).toBe("other");
  });
});

describe("classifyCase", () => {
  it("returns uncategorized for no rows or only blank rows", () => {
    expect(classifyCase([])).toBe("uncategorized");
    expect(classifyCase([{ restorationType: "", material: null }])).toBe(
      "uncategorized",
    );
  });

  it("picks the highest-priority category across restorations", () => {
    expect(
      classifyCase([
        { restorationType: "Crown", material: "Zirconia" },
        { restorationType: "Implant crown", material: "Emax" },
      ]),
    ).toBe("implants");
    expect(
      classifyCase([
        { restorationType: "Crown", material: "PFM" },
        { restorationType: "Crown", material: "BruxZir" },
      ]),
    ).toBe("zirconia");
    expect(
      classifyCase([
        { restorationType: "Night Guard", material: null },
        { restorationType: "Full Denture", material: null },
      ]),
    ).toBe("removable");
  });

  it("ignores blank rows when a categorizable row exists", () => {
    expect(
      classifyCase([
        { restorationType: "", material: "" },
        { restorationType: "Crown", material: "PFM" },
      ]),
    ).toBe("crown_bridge");
  });
});

describe("classifyLegacyCase", () => {
  it("handles null / non-object blobs", () => {
    expect(classifyLegacyCase(null)).toBe("uncategorized");
    expect(classifyLegacyCase("string")).toBe("uncategorized");
    expect(classifyLegacyCase(42)).toBe("uncategorized");
  });

  it("classifies from blob restorationType / caseType / material", () => {
    expect(classifyLegacyCase({ restorationType: "Implant crown" })).toBe(
      "implants",
    );
    expect(classifyLegacyCase({ caseType: "Crown", material: "BruxZir" })).toBe(
      "zirconia",
    );
    expect(classifyLegacyCase({ caseType: "Denture" })).toBe("removable");
    expect(classifyLegacyCase({ caseType: "Crown" })).toBe("crown_bridge");
    expect(classifyLegacyCase({ caseType: "Sports guard" })).toBe("other");
  });

  it("returns uncategorized when the blob has no usable text", () => {
    expect(classifyLegacyCase({})).toBe("uncategorized");
    expect(classifyLegacyCase({ patientName: "X", caseType: "  " })).toBe(
      "uncategorized",
    );
  });
});

describe("category constants", () => {
  it("labels cover every key", () => {
    for (const key of CASE_CATEGORY_KEYS) {
      expect(CASE_CATEGORY_LABELS[key]).toBeTruthy();
    }
  });
});
