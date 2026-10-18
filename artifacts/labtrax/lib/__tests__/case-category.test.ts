import { describe, it, expect } from "vitest";
import type { CanonicalCase } from "@workspace/api-client-react";
import {
  classifyCaseCategory,
  classifyCaseCategoryFromSubtype,
  getCompactWorkDetails,
} from "@/lib/case-category";

describe("classifyCaseCategory", () => {
  it("returns uncategorized when both type and material are blank", async () => {
    expect(classifyCaseCategory("", "")).toBe("uncategorized");
    expect(classifyCaseCategory(null, null)).toBe("uncategorized");
    expect(classifyCaseCategory(undefined, undefined)).toBe("uncategorized");
  });

  it("classifies implants with highest priority", async () => {
    expect(classifyCaseCategory("Implant Crown", "Zirconia")).toBe("implants");
    expect(classifyCaseCategory("Screw-retained", "")).toBe("implants");
    expect(classifyCaseCategory("All-on-4", "")).toBe("implants");
    expect(classifyCaseCategory("Custom Abutment", "")).toBe("implants");
  });

  it("classifies zirconia from material synonyms", async () => {
    expect(classifyCaseCategory("Coping", "BruxZir")).toBe("zirconia");
    expect(classifyCaseCategory("", "Zr")).toBe("zirconia");
  });

  it("zirconia wins over crown_bridge when both a crown type and zirconia material are present", async () => {
    expect(classifyCaseCategory("Crown", "Zirconia")).toBe("zirconia");
  });

  it("classifies crown & bridge from type or material", async () => {
    expect(classifyCaseCategory("Crown", "")).toBe("crown_bridge");
    expect(classifyCaseCategory("Bridge", "")).toBe("crown_bridge");
    expect(classifyCaseCategory("Veneer", "")).toBe("crown_bridge");
    expect(classifyCaseCategory("", "Emax")).toBe("crown_bridge");
    expect(classifyCaseCategory("", "PFM")).toBe("crown_bridge");
    expect(classifyCaseCategory("", "Lithium Disilicate")).toBe("crown_bridge");
  });

  it("classifies removable appliances", async () => {
    expect(classifyCaseCategory("Full Denture", "")).toBe("removable");
    expect(classifyCaseCategory("Partial", "")).toBe("removable");
    expect(classifyCaseCategory("Flipper", "")).toBe("removable");
  });

  describe("AI-imported removable cases (restorationSubtype is null)", () => {
    it("'Removable' restorationType with 'Acrylic' material returns 'removable'", async () => {
      expect(classifyCaseCategory("Removable", "Acrylic")).toBe("removable");
    });

    it("'Removable' restorationType with no material returns 'removable'", async () => {
      expect(classifyCaseCategory("Removable", null)).toBe("removable");
    });

    it("'Removable' restorationType alone (empty material string) returns 'removable'", async () => {
      expect(classifyCaseCategory("Removable", "")).toBe("removable");
    });
  });

  it("falls back to other for recognized-but-uncategorized content", async () => {
    expect(classifyCaseCategory("Night Guard", "Acrylic")).toBe("other");
    expect(classifyCaseCategory("Retainer", "")).toBe("other");
  });

  it("handles comma-joined multi-restoration strings", async () => {
    expect(classifyCaseCategory("Crown, Implant", "Zirconia, Titanium")).toBe(
      "implants",
    );
    expect(classifyCaseCategory("Crown, Bridge", "Zirconia, Emax")).toBe(
      "zirconia",
    );
  });
});

describe("classifyCaseCategoryFromSubtype", () => {
  it("maps restorative/crown_and_bridge/zirconia → zirconia", async () => {
    expect(
      classifyCaseCategoryFromSubtype("restorative/crown_and_bridge/zirconia"),
    ).toBe("zirconia");
  });

  it("maps restorative/crown_and_bridge/pfz → zirconia", async () => {
    expect(
      classifyCaseCategoryFromSubtype("restorative/crown_and_bridge/pfz"),
    ).toBe("zirconia");
  });

  it("maps restorative/implant → implants (highest priority)", async () => {
    expect(classifyCaseCategoryFromSubtype("restorative/implant")).toBe(
      "implants",
    );
  });

  it("maps restorative/implant/zirconia → implants (subtype wins over material)", async () => {
    expect(
      classifyCaseCategoryFromSubtype("restorative/implant/zirconia"),
    ).toBe("implants");
  });

  it("maps restorative/crown_and_bridge/pfm → crown_bridge", async () => {
    expect(
      classifyCaseCategoryFromSubtype("restorative/crown_and_bridge/pfm"),
    ).toBe("crown_bridge");
  });

  it("maps restorative/crown_and_bridge (no material) → crown_bridge", async () => {
    expect(
      classifyCaseCategoryFromSubtype("restorative/crown_and_bridge"),
    ).toBe("crown_bridge");
  });

  it("maps restorative/temporaries → crown_bridge", async () => {
    expect(classifyCaseCategoryFromSubtype("restorative/temporaries")).toBe(
      "crown_bridge",
    );
  });

  it("maps removable/* → removable", async () => {
    expect(classifyCaseCategoryFromSubtype("removable/dentures")).toBe(
      "removable",
    );
    expect(classifyCaseCategoryFromSubtype("removable/partials/acrylic")).toBe(
      "removable",
    );
    expect(classifyCaseCategoryFromSubtype("removable/flippers")).toBe(
      "removable",
    );
  });

  it("maps ortho/* → other", async () => {
    expect(classifyCaseCategoryFromSubtype("ortho/night_guards")).toBe("other");
    expect(classifyCaseCategoryFromSubtype("ortho/retainers")).toBe("other");
    expect(
      classifyCaseCategoryFromSubtype("ortho/night_guards/night_guard_hard"),
    ).toBe("other");
  });

  it("returns uncategorized for null/undefined", async () => {
    expect(classifyCaseCategoryFromSubtype(null)).toBe("uncategorized");
    expect(classifyCaseCategoryFromSubtype(undefined)).toBe("uncategorized");
    expect(classifyCaseCategoryFromSubtype("")).toBe("uncategorized");
  });

  it("returns uncategorized for a completely unrecognized key (does not crash)", async () => {
    expect(classifyCaseCategoryFromSubtype("bogus_type/unknown_subtype")).toBe(
      "uncategorized",
    );
  });

  it("returns uncategorized for a partially valid key with wrong caseType", async () => {
    expect(
      classifyCaseCategoryFromSubtype("RESTORATIVE/crown_and_bridge/zirconia"),
    ).toBe("uncategorized");
  });

  it("returns uncategorized for a key with an unknown subtype", async () => {
    expect(
      classifyCaseCategoryFromSubtype("restorative/unknown_subtype/zirconia"),
    ).toBe("uncategorized");
  });

  it("returns uncategorized for a malformed slash-only key", async () => {
    expect(classifyCaseCategoryFromSubtype("/")).toBe("uncategorized");
    expect(classifyCaseCategoryFromSubtype("restorative")).toBe("uncategorized");
  });

  it("ignores an unrecognized materialSubtype but still classifies via caseType/subtype", async () => {
    expect(
      classifyCaseCategoryFromSubtype("restorative/crown_and_bridge/not_a_material"),
    ).toBe("crown_bridge");
  });
});

describe("getCompactWorkDetails — compact case-type letter", () => {
  function makeCase(overrides: Partial<CanonicalCase> = {}): CanonicalCase {
    return {
      id: "case-1",
      restorationTypes: null,
      restorationMaterials: null,
      firstRestorationSubtype: null,
      teeth: null,
      step: null,
      ...overrides,
    } as CanonicalCase;
  }

  it('returns "C" for restorative cases and keeps the teeth detail', async () => {
    expect(
      getCompactWorkDetails(makeCase({ restorationTypes: "Crown", teeth: "8, 9" })),
    ).toEqual({ typeLabel: "C", material: null, detail: "Teeth 8, 9" });
  });

  it('returns "D" for removable cases and keeps the step detail', async () => {
    expect(
      getCompactWorkDetails(makeCase({ restorationTypes: "Partial", step: "wax_setup" })),
    ).toEqual({ typeLabel: "D", material: null, detail: "Wax Setup" });
  });

  it('returns "O" for an ortho case identified by its structured subtype', async () => {
    expect(
      getCompactWorkDetails(
        makeCase({ firstRestorationSubtype: "ortho/night_guards", restorationMaterials: "Acrylic" }),
      ),
    ).toEqual({ typeLabel: "O", material: "Acrylic", detail: null });
  });

  it('returns "O" for ortho cases identified by free text', async () => {
    for (const restorationTypes of ["Night Guard", "Retainer", "Splint", "Bleach Tray"]) {
      expect(getCompactWorkDetails(makeCase({ restorationTypes })).typeLabel).toBe("O");
    }
  });

  it("never surfaces the long Ortho / Appliances label as the compact type", async () => {
    expect(
      getCompactWorkDetails(makeCase({ firstRestorationSubtype: "ortho/retainers" })).typeLabel,
    ).not.toBe("Ortho / Appliances");
  });

  it("falls back to the raw restoration type when nothing classifies", async () => {
    expect(getCompactWorkDetails(makeCase({ restorationTypes: "Model Only" }))).toEqual({
      typeLabel: "Model Only",
      material: null,
      detail: null,
    });
  });
});
