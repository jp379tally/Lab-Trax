import { describe, it, expect } from "vitest";
import { classifyCaseCategory } from "@/lib/case-category";

describe("classifyCaseCategory", () => {
  it("returns uncategorized when both type and material are blank", () => {
    expect(classifyCaseCategory("", "")).toBe("uncategorized");
    expect(classifyCaseCategory(null, null)).toBe("uncategorized");
    expect(classifyCaseCategory(undefined, undefined)).toBe("uncategorized");
  });

  it("classifies implants with highest priority", () => {
    expect(classifyCaseCategory("Implant Crown", "Zirconia")).toBe("implants");
    expect(classifyCaseCategory("Screw-retained", "")).toBe("implants");
    expect(classifyCaseCategory("All-on-4", "")).toBe("implants");
    expect(classifyCaseCategory("Custom Abutment", "")).toBe("implants");
  });

  it("classifies zirconia from material synonyms", () => {
    expect(classifyCaseCategory("Coping", "BruxZir")).toBe("zirconia");
    expect(classifyCaseCategory("", "Zr")).toBe("zirconia");
  });

  it("zirconia wins over crown_bridge when both a crown type and zirconia material are present", () => {
    expect(classifyCaseCategory("Crown", "Zirconia")).toBe("zirconia");
  });

  it("classifies crown & bridge from type or material", () => {
    expect(classifyCaseCategory("Crown", "")).toBe("crown_bridge");
    expect(classifyCaseCategory("Bridge", "")).toBe("crown_bridge");
    expect(classifyCaseCategory("Veneer", "")).toBe("crown_bridge");
    expect(classifyCaseCategory("", "Emax")).toBe("crown_bridge");
    expect(classifyCaseCategory("", "PFM")).toBe("crown_bridge");
    expect(classifyCaseCategory("", "Lithium Disilicate")).toBe("crown_bridge");
  });

  it("classifies removable appliances", () => {
    expect(classifyCaseCategory("Full Denture", "")).toBe("removable");
    expect(classifyCaseCategory("Partial", "")).toBe("removable");
    expect(classifyCaseCategory("Flipper", "")).toBe("removable");
  });

  it("falls back to other for recognized-but-uncategorized content", () => {
    expect(classifyCaseCategory("Night Guard", "Acrylic")).toBe("other");
    expect(classifyCaseCategory("Retainer", "")).toBe("other");
  });

  it("handles comma-joined multi-restoration strings", () => {
    expect(classifyCaseCategory("Crown, Implant", "Zirconia, Titanium")).toBe(
      "implants",
    );
    expect(classifyCaseCategory("Crown, Bridge", "Zirconia, Emax")).toBe(
      "zirconia",
    );
  });
});
