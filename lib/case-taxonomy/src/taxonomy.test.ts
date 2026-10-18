import { describe, it, expect } from "vitest";
import {
  CASE_TYPES,
  CASE_TAXONOMY,
  getSubtypes,
  getMaterialSubtypes,
  getCaseTypeLabel,
  getSubtypeLabel,
  deriveCaseHierarchy,
  encodeRestorationSubtype,
  encodeCustomToken,
  isCustomToken,
  parseCustomToken,
  normalizeCaseHierarchy,
  hierarchyToCaseCategory,
  isValidCaseType,
  isValidSubtype,
  isValidMaterialSubtype,
  caseTypeForSubtype,
  getTaxonomyVocab,
  getTaxonomyTree,
  type CaseHierarchy,
} from "./taxonomy";

// ── Tree integrity ──────────────────────────────────────────────────────────

describe("CASE_TAXONOMY tree integrity", () => {
  it("has exactly 3 caseTypes", () => {
    expect(CASE_TYPES).toEqual(["restorative", "removable", "ortho"]);
  });

  it("every caseType has at least one subtype", () => {
    for (const ct of CASE_TYPES) {
      expect(Object.keys(CASE_TAXONOMY[ct].subtypes).length).toBeGreaterThan(0);
    }
  });

  it("getTaxonomyVocab returns all entries with non-empty keys", () => {
    const vocab = getTaxonomyVocab();
    expect(vocab.length).toBeGreaterThan(0);
    for (const e of vocab) {
      expect(e.key).toMatch(/^[a-z_]+\/[a-z_]+(\/[a-z_]+)?$/);
    }
  });
});

// ── getTaxonomyVocab round-trip ──────────────────────────────────────────────

describe("getTaxonomyVocab round-trip", () => {
  const vocab = getTaxonomyVocab();

  it("every entry key decodes back to a matching CaseHierarchy via deriveCaseHierarchy", () => {
    for (const entry of vocab) {
      const decoded = deriveCaseHierarchy(null, entry.key, null);
      expect(decoded.caseType, `key=${entry.key} caseType`).toBe(entry.caseType);
      expect(decoded.subtype, `key=${entry.key} subtype`).toBe(entry.subtype);
      expect(decoded.materialSubtype, `key=${entry.key} materialSubtype`).toBe(
        entry.materialSubtype,
      );
    }
  });

  it("encode→decode is lossless for every vocab entry", () => {
    for (const entry of vocab) {
      const hierarchy: CaseHierarchy = {
        caseType: entry.caseType,
        subtype: entry.subtype,
        materialSubtype: entry.materialSubtype,
      };
      const encoded = encodeRestorationSubtype(hierarchy);
      expect(encoded, `encode for key=${entry.key}`).toBe(entry.key);
      const decoded = deriveCaseHierarchy(null, encoded!, null);
      expect(decoded, `round-trip for key=${entry.key}`).toEqual(hierarchy);
    }
  });

  it("every entry key in the vocab is parseable by deriveCaseHierarchy (no null caseType)", () => {
    for (const entry of vocab) {
      const decoded = deriveCaseHierarchy(null, entry.key, null);
      expect(decoded.caseType, `key=${entry.key} must have caseType`).not.toBeNull();
      expect(decoded.subtype, `key=${entry.key} must have subtype`).not.toBeNull();
    }
  });
});

// ── getTaxonomyTree round-trip ───────────────────────────────────────────────

describe("getTaxonomyTree round-trip", () => {
  const tree = getTaxonomyTree();

  it("every caseType key in the tree is a valid CaseType", () => {
    for (const ctEntry of tree.caseTypes) {
      expect(isValidCaseType(ctEntry.key), `caseType key=${ctEntry.key}`).toBe(true);
    }
  });

  it("every subtype key in the tree is valid under its parent caseType", () => {
    for (const ctEntry of tree.caseTypes) {
      const validSubs: string[] = getSubtypes(ctEntry.key);
      for (const stEntry of ctEntry.subtypes) {
        expect(
          validSubs.includes(stEntry.key),
          `subtype key=${stEntry.key} under caseType=${ctEntry.key}`,
        ).toBe(true);
      }
    }
  });

  it("every materialSubtype key in the tree round-trips via encode→decode", () => {
    for (const ctEntry of tree.caseTypes) {
      for (const stEntry of ctEntry.subtypes) {
        for (const msEntry of stEntry.materialSubtypes) {
          const hierarchy: CaseHierarchy = {
            caseType: ctEntry.key,
            subtype: stEntry.key,
            materialSubtype: msEntry.key,
          };
          const encoded = encodeRestorationSubtype(hierarchy);
          expect(encoded, `encode ct=${ctEntry.key} st=${stEntry.key} ms=${msEntry.key}`).not.toBeNull();
          const decoded = deriveCaseHierarchy(null, encoded!, null);
          expect(decoded, `round-trip ct=${ctEntry.key} st=${stEntry.key} ms=${msEntry.key}`).toEqual(
            hierarchy,
          );
        }
      }
    }
  });

  it("subtypes with no materialSubtypes produce a 2-part key that round-trips", () => {
    for (const ctEntry of tree.caseTypes) {
      for (const stEntry of ctEntry.subtypes) {
        if (stEntry.materialSubtypes.length === 0) {
          const hierarchy: CaseHierarchy = {
            caseType: ctEntry.key,
            subtype: stEntry.key,
            materialSubtype: null,
          };
          const encoded = encodeRestorationSubtype(hierarchy);
          expect(encoded, `2-part key ct=${ctEntry.key} st=${stEntry.key}`).toBe(
            `${ctEntry.key}/${stEntry.key}`,
          );
          const decoded = deriveCaseHierarchy(null, encoded!, null);
          expect(decoded, `round-trip 2-part ct=${ctEntry.key} st=${stEntry.key}`).toEqual(
            hierarchy,
          );
        }
      }
    }
  });
});

// ── getSubtypes / getMaterialSubtypes ───────────────────────────────────────

describe("getSubtypes / getMaterialSubtypes", () => {
  it("restorative subtypes include crown_and_bridge and implant", () => {
    const subs = getSubtypes("restorative");
    expect(subs).toContain("crown_and_bridge");
    expect(subs).toContain("implant");
    expect(subs).toContain("temporaries");
  });

  it("ortho subtypes include night_guards and retainers", () => {
    const subs = getSubtypes("ortho");
    expect(subs).toContain("night_guards");
    expect(subs).toContain("retainers");
  });

  it("crown_and_bridge material subtypes include zirconia, emax, pfm", () => {
    const mats = getMaterialSubtypes("restorative", "crown_and_bridge");
    expect(mats).toContain("zirconia");
    expect(mats).toContain("emax");
    expect(mats).toContain("pfm");
    expect(mats).toContain("pfz");
  });

  it("night_guards material subtypes include all 3 guard types", () => {
    const mats = getMaterialSubtypes("ortho", "night_guards");
    expect(mats).toContain("night_guard_hard");
    expect(mats).toContain("night_guard_hard_soft");
    expect(mats).toContain("night_guard_soft");
  });

  it("ortho/retainers has no material subtypes", () => {
    const mats = getMaterialSubtypes("ortho", "retainers");
    expect(mats).toHaveLength(0);
  });
});

// ── deriveCaseHierarchy ─────────────────────────────────────────────────────

describe("deriveCaseHierarchy", () => {
  it("infers crown case from restorationType=Crown material=Zirconia", () => {
    const h = deriveCaseHierarchy("Crown", null, "Zirconia");
    expect(h.caseType).toBe("restorative");
    expect(h.subtype).toBe("crown_and_bridge");
    expect(h.materialSubtype).toBe("zirconia");
  });

  it("infers implant from restorationType=Implant Crown", () => {
    const h = deriveCaseHierarchy("Implant Crown", null, "Zirconia");
    expect(h.caseType).toBe("restorative");
    expect(h.subtype).toBe("implant");
    expect(h.materialSubtype).toBe("zirconia");
  });

  it("infers PFM from material=PFM Porcelain Fused to Metal", () => {
    const h = deriveCaseHierarchy("Crown", null, "PFM Porcelain Fused to Metal");
    expect(h.materialSubtype).toBe("pfm");
  });

  it("infers PFZ from material=PFZ", () => {
    const h = deriveCaseHierarchy("Crown", null, "PFZ");
    expect(h.materialSubtype).toBe("pfz");
  });

  it("infers emax from material=Lithium Disilicate", () => {
    const h = deriveCaseHierarchy("Crown", null, "Lithium Disilicate");
    expect(h.materialSubtype).toBe("emax");
  });

  it("infers emax from material=E.max", () => {
    const h = deriveCaseHierarchy("Crown", null, "E.max");
    expect(h.materialSubtype).toBe("emax");
  });

  it("infers denture removable from restorationType=Denture", () => {
    const h = deriveCaseHierarchy("Denture", null, null);
    expect(h.caseType).toBe("removable");
    expect(h.subtype).toBe("dentures");
  });

  it("infers partial from restorationType=Partial", () => {
    const h = deriveCaseHierarchy("Partial Denture", null, null);
    expect(h.caseType).toBe("removable");
    expect(h.subtype).toBe("partials");
  });

  it("infers night guard from restorationType=Night Guard", () => {
    const h = deriveCaseHierarchy("Night Guard", null, null);
    expect(h.caseType).toBe("ortho");
    expect(h.subtype).toBe("night_guards");
  });

  it("infers night guard hard-soft from material=hard-soft", () => {
    const h = deriveCaseHierarchy("Night Guard", null, "Hard-Soft");
    expect(h.materialSubtype).toBe("night_guard_hard_soft");
  });

  it("infers retainer from restorationType=Retainer", () => {
    const h = deriveCaseHierarchy("Retainer", null, null);
    expect(h.caseType).toBe("ortho");
    expect(h.subtype).toBe("retainers");
  });

  it("returns all-null for completely unknown input", () => {
    const h = deriveCaseHierarchy(null, null, null);
    expect(h).toEqual({ caseType: null, subtype: null, materialSubtype: null });
  });

  it("decodes stored restorationSubtype column value", () => {
    const h = deriveCaseHierarchy(null, "restorative/crown_and_bridge/zirconia", null);
    expect(h.caseType).toBe("restorative");
    expect(h.subtype).toBe("crown_and_bridge");
    expect(h.materialSubtype).toBe("zirconia");
  });

  it("decodes restorationSubtype without materialSubtype", () => {
    const h = deriveCaseHierarchy(null, "ortho/retainers", null);
    expect(h.caseType).toBe("ortho");
    expect(h.subtype).toBe("retainers");
    expect(h.materialSubtype).toBeNull();
  });
});

// ── encodeRestorationSubtype ─────────────────────────────────────────────────

describe("encodeRestorationSubtype", () => {
  it("encodes full hierarchy", () => {
    expect(
      encodeRestorationSubtype({
        caseType: "restorative",
        subtype: "crown_and_bridge",
        materialSubtype: "zirconia",
      }),
    ).toBe("restorative/crown_and_bridge/zirconia");
  });

  it("encodes hierarchy without materialSubtype", () => {
    expect(
      encodeRestorationSubtype({
        caseType: "ortho",
        subtype: "retainers",
        materialSubtype: null,
      }),
    ).toBe("ortho/retainers");
  });

  it("returns null when caseType is missing", () => {
    expect(
      encodeRestorationSubtype({ caseType: null, subtype: null, materialSubtype: null }),
    ).toBeNull();
  });
});

// ── normalizeCaseHierarchy ───────────────────────────────────────────────────

describe("normalizeCaseHierarchy", () => {
  it("normalizes from AI free-text Crown + Zirconia", () => {
    const { hierarchy, restorationSubtype } = normalizeCaseHierarchy({
      caseType: "Crown",
      material: "Zirconia",
    });
    expect(hierarchy.caseType).toBe("restorative");
    expect(hierarchy.subtype).toBe("crown_and_bridge");
    expect(hierarchy.materialSubtype).toBe("zirconia");
    expect(restorationSubtype).toBe("restorative/crown_and_bridge/zirconia");
  });

  it("normalizes from explicit picker keys", () => {
    const { hierarchy } = normalizeCaseHierarchy({
      subtype: "night_guards",
      materialSubtype: "night_guard_hard",
    });
    expect(hierarchy.caseType).toBe("ortho");
    expect(hierarchy.subtype).toBe("night_guards");
    expect(hierarchy.materialSubtype).toBe("night_guard_hard");
  });

  it("returns null restorationSubtype when caseType cannot be resolved", () => {
    const { restorationSubtype } = normalizeCaseHierarchy({ caseType: "???", material: null });
    expect(restorationSubtype).toBeNull();
  });

  // ── Removable catch-all (AI import guard) ─────────────────────────────────
  // Prevents AI-imported "Removable / Acrylic" cases from losing the D badge
  // on re-sync by ensuring a structured restorationSubtype is always stored.

  it("bare 'Removable' AI string produces a non-null restorationSubtype", () => {
    const { hierarchy, restorationSubtype } = normalizeCaseHierarchy({
      caseType: "Removable",
      material: null,
    });
    expect(hierarchy.caseType).toBe("removable");
    expect(hierarchy.subtype).not.toBeNull();
    expect(restorationSubtype).not.toBeNull();
    expect(restorationSubtype).toMatch(/^removable\//);
  });

  it("'Removable / Acrylic' AI string → removable/removable_other/acrylic (structured subtype path)", () => {
    const { hierarchy, restorationSubtype } = normalizeCaseHierarchy({
      caseType: "Removable",
      material: "Acrylic",
    });
    expect(hierarchy.caseType).toBe("removable");
    expect(hierarchy.subtype).toBe("removable_other");
    expect(hierarchy.materialSubtype).toBe("acrylic");
    expect(restorationSubtype).toBe("removable/removable_other/acrylic");
  });

  it("'Removable / Acrylic' round-trip: stored key decodes and classifies as D badge", () => {
    const { restorationSubtype } = normalizeCaseHierarchy({
      caseType: "Removable",
      material: "Acrylic",
    });
    // Stored key must be decodable without regex fallback
    const decoded = deriveCaseHierarchy(null, restorationSubtype!, null);
    expect(decoded.caseType).toBe("removable");
    // hierarchyToCaseCategory maps all removable/* → "removable" (the D badge)
    expect(hierarchyToCaseCategory(decoded)).toBe("removable");
  });

  it("'Removable / Flexible' AI string → removable/removable_other/flexible", () => {
    const { hierarchy, restorationSubtype } = normalizeCaseHierarchy({
      caseType: "Removable",
      material: "Flexible",
    });
    expect(hierarchy.subtype).toBe("removable_other");
    expect(hierarchy.materialSubtype).toBe("flexible");
    expect(restorationSubtype).toBe("removable/removable_other/flexible");
  });
});

// ── hierarchyToCaseCategory ──────────────────────────────────────────────────

describe("hierarchyToCaseCategory", () => {
  const h = (
    caseType: CaseHierarchy["caseType"],
    subtype: CaseHierarchy["subtype"],
    materialSubtype: CaseHierarchy["materialSubtype"],
  ): CaseHierarchy => ({ caseType, subtype, materialSubtype });

  it("restorative/implant → implants", () => {
    expect(hierarchyToCaseCategory(h("restorative", "implant", "zirconia"))).toBe("implants");
  });

  it("restorative/crown_and_bridge/zirconia → zirconia", () => {
    expect(hierarchyToCaseCategory(h("restorative", "crown_and_bridge", "zirconia"))).toBe(
      "zirconia",
    );
  });

  it("restorative/crown_and_bridge/pfz → zirconia", () => {
    expect(hierarchyToCaseCategory(h("restorative", "crown_and_bridge", "pfz"))).toBe("zirconia");
  });

  it("restorative/crown_and_bridge/emax → crown_bridge", () => {
    expect(hierarchyToCaseCategory(h("restorative", "crown_and_bridge", "emax"))).toBe(
      "crown_bridge",
    );
  });

  it("restorative/crown_and_bridge/pfm → crown_bridge", () => {
    expect(hierarchyToCaseCategory(h("restorative", "crown_and_bridge", "pfm"))).toBe(
      "crown_bridge",
    );
  });

  it("removable/dentures → removable", () => {
    expect(hierarchyToCaseCategory(h("removable", "dentures", "acrylic"))).toBe("removable");
  });

  it("ortho/night_guards → other", () => {
    expect(hierarchyToCaseCategory(h("ortho", "night_guards", "night_guard_hard"))).toBe("other");
  });

  it("null caseType → null", () => {
    expect(hierarchyToCaseCategory(h(null, null, null))).toBeNull();
  });

  // ── Crown / Bridge split subtypes ───────────────────────────────────────────

  it("restorative/crown subtype (encoded) → crown_bridge", () => {
    // Cases created with the new Crown subtype store restorationSubtype as
    // "restorative/crown". deriveCaseHierarchy decodes it; the result must
    // land in crown_bridge, not fall through to a wrong bucket.
    const hierarchy = deriveCaseHierarchy(null, "restorative/crown", null);
    expect(hierarchyToCaseCategory(hierarchy)).toBe("crown_bridge");
  });

  it("restorative/bridge subtype (encoded) → crown_bridge", () => {
    const hierarchy = deriveCaseHierarchy(null, "restorative/bridge", null);
    expect(hierarchyToCaseCategory(hierarchy)).toBe("crown_bridge");
  });

  it("restorative/crown_and_bridge subtype (encoded) → crown_bridge", () => {
    // Legacy encoded subtype still resolves correctly.
    const hierarchy = deriveCaseHierarchy(null, "restorative/crown_and_bridge", null);
    expect(hierarchyToCaseCategory(hierarchy)).toBe("crown_bridge");
  });

  it("Crown free-text (no subtype) → crown_bridge via inference", () => {
    // Older cases have no restorationSubtype; free-text inference must still
    // land in crown_bridge.
    const hierarchy = deriveCaseHierarchy("Crown", null, null);
    expect(hierarchyToCaseCategory(hierarchy)).toBe("crown_bridge");
  });

  it("Bridge free-text (no subtype) → crown_bridge via inference", () => {
    const hierarchy = deriveCaseHierarchy("Bridge", null, null);
    expect(hierarchyToCaseCategory(hierarchy)).toBe("crown_bridge");
  });
});

// ── Validators ───────────────────────────────────────────────────────────────

describe("validators", () => {
  it("isValidCaseType", () => {
    expect(isValidCaseType("restorative")).toBe(true);
    expect(isValidCaseType("crown")).toBe(false);
  });

  it("isValidSubtype", () => {
    expect(isValidSubtype("crown_and_bridge")).toBe(true);
    expect(isValidSubtype("Crown")).toBe(false);
  });

  it("isValidMaterialSubtype", () => {
    expect(isValidMaterialSubtype("zirconia")).toBe(true);
    expect(isValidMaterialSubtype("Zirconia")).toBe(false);
  });

  it("caseTypeForSubtype", () => {
    expect(caseTypeForSubtype("crown_and_bridge")).toBe("restorative");
    expect(caseTypeForSubtype("dentures")).toBe("removable");
    expect(caseTypeForSubtype("night_guards")).toBe("ortho");
  });
});

// ── getCaseTypeLabel / getSubtypeLabel ────────────────────────────────────────

describe("label helpers", () => {
  it("getCaseTypeLabel returns non-empty string", () => {
    for (const ct of CASE_TYPES) {
      expect(getCaseTypeLabel(ct)).toBeTruthy();
    }
  });

  it("getSubtypeLabel returns non-empty string", () => {
    expect(getSubtypeLabel("restorative", "crown_and_bridge")).toBeTruthy();
    expect(getSubtypeLabel("ortho", "night_guards")).toBeTruthy();
  });
});

// ── Custom (lab-catalog) entry tokens ────────────────────────────────────────

describe("custom entry tokens", () => {
  it("encodeCustomToken prefixes the id", () => {
    expect(encodeCustomToken("abc-123")).toBe("custom:abc-123");
  });

  it("isCustomToken recognises well-formed tokens only", () => {
    expect(isCustomToken("custom:abc-123")).toBe(true);
    expect(isCustomToken("custom:")).toBe(false); // empty id
    expect(isCustomToken("crown_and_bridge")).toBe(false);
    expect(isCustomToken(null)).toBe(false);
    expect(isCustomToken(undefined)).toBe(false);
  });

  it("parseCustomToken extracts the id or returns null", () => {
    expect(parseCustomToken("custom:abc-123")).toBe("abc-123");
    expect(parseCustomToken("crown_and_bridge")).toBeNull();
    expect(parseCustomToken("custom:")).toBeNull();
    expect(parseCustomToken(null)).toBeNull();
  });

  it("decodes a custom subtype under a built-in caseType", () => {
    const h = deriveCaseHierarchy(null, "restorative/custom:sub-1", null);
    expect(h.caseType).toBe("restorative");
    expect(h.subtype).toBeNull();
    expect(h.materialSubtype).toBeNull();
    expect(h.customSubtypeId).toBe("sub-1");
    expect(h.customMaterialSubtypeId).toBeUndefined();
  });

  it("decodes a custom material under a built-in subtype", () => {
    const h = deriveCaseHierarchy(null, "restorative/crown_and_bridge/custom:mat-1", null);
    expect(h.caseType).toBe("restorative");
    expect(h.subtype).toBe("crown_and_bridge");
    expect(h.materialSubtype).toBeNull();
    expect(h.customSubtypeId).toBeUndefined();
    expect(h.customMaterialSubtypeId).toBe("mat-1");
  });

  it("decodes a custom material under a custom subtype", () => {
    const h = deriveCaseHierarchy(null, "removable/custom:sub-1/custom:mat-1", null);
    expect(h.caseType).toBe("removable");
    expect(h.subtype).toBeNull();
    expect(h.materialSubtype).toBeNull();
    expect(h.customSubtypeId).toBe("sub-1");
    expect(h.customMaterialSubtypeId).toBe("mat-1");
  });

  it("still fails on a genuinely unrecognised subtype segment (not custom, not a literal key)", () => {
    const h = deriveCaseHierarchy(null, "restorative/not-a-real-subtype", null);
    // decodeRestorationSubtype rejects it, so deriveCaseHierarchy falls back
    // to free-text inference on the (empty) restorationType/material — both
    // null here, so the whole hierarchy is null.
    expect(h).toEqual({ caseType: null, subtype: null, materialSubtype: null });
  });

  it("encode→decode round-trips a custom subtype (no material)", () => {
    const hierarchy: CaseHierarchy = {
      caseType: "restorative",
      subtype: null,
      materialSubtype: null,
      customSubtypeId: "sub-1",
    };
    const encoded = encodeRestorationSubtype(hierarchy);
    expect(encoded).toBe("restorative/custom:sub-1");
    const decoded = deriveCaseHierarchy(null, encoded!, null);
    expect(decoded).toEqual(hierarchy);
  });

  it("encode→decode round-trips a custom material under a built-in subtype", () => {
    const hierarchy: CaseHierarchy = {
      caseType: "ortho",
      subtype: "night_guards",
      materialSubtype: null,
      customMaterialSubtypeId: "mat-1",
    };
    const encoded = encodeRestorationSubtype(hierarchy);
    expect(encoded).toBe("ortho/night_guards/custom:mat-1");
    const decoded = deriveCaseHierarchy(null, encoded!, null);
    expect(decoded).toEqual(hierarchy);
  });

  it("encode→decode round-trips a custom subtype + custom material", () => {
    const hierarchy: CaseHierarchy = {
      caseType: "removable",
      subtype: null,
      materialSubtype: null,
      customSubtypeId: "sub-1",
      customMaterialSubtypeId: "mat-1",
    };
    const encoded = encodeRestorationSubtype(hierarchy);
    expect(encoded).toBe("removable/custom:sub-1/custom:mat-1");
    const decoded = deriveCaseHierarchy(null, encoded!, null);
    expect(decoded).toEqual(hierarchy);
  });

  it("literal subtype still takes priority over customSubtypeId when encoding", () => {
    const encoded = encodeRestorationSubtype({
      caseType: "restorative",
      subtype: "implant",
      materialSubtype: null,
      customSubtypeId: "should-be-ignored",
    });
    expect(encoded).toBe("restorative/implant");
  });

  it("plain built-in hierarchies (no custom fields set) are unaffected by the new optional keys", () => {
    const h = deriveCaseHierarchy(null, "restorative/crown_and_bridge/zirconia", null);
    expect(h.customSubtypeId).toBeUndefined();
    expect(h.customMaterialSubtypeId).toBeUndefined();
    expect(h).toEqual({
      caseType: "restorative",
      subtype: "crown_and_bridge",
      materialSubtype: "zirconia",
    });
  });
});

// ── hierarchyToCaseCategory: custom-subtype fallback ─────────────────────────

describe("hierarchyToCaseCategory custom-subtype fallback", () => {
  it("restorative custom subtype with no material match falls back to crown_bridge (not null)", () => {
    const h: CaseHierarchy = {
      caseType: "restorative",
      subtype: null,
      materialSubtype: null,
      customSubtypeId: "sub-1",
    };
    expect(hierarchyToCaseCategory(h)).toBe("crown_bridge");
  });

  it("restorative custom subtype still detects a zirconia custom material as zirconia", () => {
    const h: CaseHierarchy = {
      caseType: "restorative",
      subtype: null,
      materialSubtype: "zirconia",
      customSubtypeId: "sub-1",
    };
    expect(hierarchyToCaseCategory(h)).toBe("zirconia");
  });

  it("removable custom subtype still classifies as removable", () => {
    const h: CaseHierarchy = {
      caseType: "removable",
      subtype: null,
      materialSubtype: null,
      customSubtypeId: "sub-1",
    };
    expect(hierarchyToCaseCategory(h)).toBe("removable");
  });

  it("ortho custom subtype still classifies as other", () => {
    const h: CaseHierarchy = {
      caseType: "ortho",
      subtype: null,
      materialSubtype: null,
      customSubtypeId: "sub-1",
    };
    expect(hierarchyToCaseCategory(h)).toBe("other");
  });
});

// ── SUBTYPE_ALIASES — add tooth / repair aliases (Task #3460) ──────────────────

describe("SUBTYPE_ALIASES — add tooth and replace tooth aliases", () => {
  // These tests verify that the new "add tooth to ..." and "replace tooth ..."
  // patterns in SUBTYPE_ALIASES route to the correct repair subtype before the
  // bare "partial" / "denture" catch-alls can fire.

  it('"add tooth to partial" → repair_partial', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "add tooth to partial" });
    expect(hierarchy.subtype).toBe("repair_partial");
    expect(hierarchy.caseType).toBe("removable");
  });

  it('"add tooth to lower partial" → repair_partial', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "add tooth to lower partial" });
    expect(hierarchy.subtype).toBe("repair_partial");
  });

  it('"add tooth to upper partial" → repair_partial', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "add tooth to upper partial" });
    expect(hierarchy.subtype).toBe("repair_partial");
  });

  it('"replace tooth on partial" → repair_partial', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "replace tooth on partial" });
    expect(hierarchy.subtype).toBe("repair_partial");
  });

  it('"replace tooth on lower partial" → repair_partial', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "replace tooth on lower partial" });
    expect(hierarchy.subtype).toBe("repair_partial");
  });

  it('"add tooth to denture" → repair_denture', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "add tooth to denture" });
    expect(hierarchy.subtype).toBe("repair_denture");
    expect(hierarchy.caseType).toBe("removable");
  });

  it('"add tooth to upper denture" → repair_denture', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "add tooth to upper denture" });
    expect(hierarchy.subtype).toBe("repair_denture");
  });

  it('"add tooth to lower denture" → repair_denture', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "add tooth to lower denture" });
    expect(hierarchy.subtype).toBe("repair_denture");
  });

  it('"replace tooth on denture" → repair_denture', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "replace tooth on denture" });
    expect(hierarchy.subtype).toBe("repair_denture");
  });

  it('"replace tooth on upper denture" → repair_denture', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "replace tooth on upper denture" });
    expect(hierarchy.subtype).toBe("repair_denture");
  });

  it('bare "add tooth" with no partial/denture context → repair_partial (most likely)', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "add tooth" });
    expect(hierarchy.subtype).toBe("repair_partial");
    expect(hierarchy.caseType).toBe("removable");
  });

  it('bare "replace tooth" with no partial/denture context → repair_partial (most likely)', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "replace tooth" });
    expect(hierarchy.subtype).toBe("repair_partial");
  });

  // Verify ordering: "add tooth to partial" should NOT fall through to bare "partial" → partials.
  it('"add tooth to partial" must NOT map to partials (wrong subtype)', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "add tooth to partial" });
    expect(hierarchy.subtype).not.toBe("partials");
  });

  // Verify ordering: "add tooth to denture" should NOT fall through to bare "denture" → dentures.
  it('"add tooth to denture" must NOT map to dentures (wrong subtype)', () => {
    const { hierarchy } = normalizeCaseHierarchy({ caseType: "add tooth to denture" });
    expect(hierarchy.subtype).not.toBe("dentures");
  });
});

describe("SUBTYPE_ALIASES — explicit removable subtype fast-path via normalizeCaseHierarchy", () => {
  // When an explicit subtype key is supplied (as the AI extraction does via
  // mapAiRemovableSubtype), normalizeCaseHierarchy should use it directly
  // without regex inference.

  it('"flippers" explicit subtype resolves correctly', () => {
    const { hierarchy, restorationSubtype } = normalizeCaseHierarchy({
      caseType: "Removable",
      subtype: "flippers",
    });
    expect(hierarchy.caseType).toBe("removable");
    expect(hierarchy.subtype).toBe("flippers");
    expect(restorationSubtype).toBe("removable/flippers");
  });

  it('"partials" explicit subtype resolves correctly', () => {
    const { hierarchy, restorationSubtype } = normalizeCaseHierarchy({
      caseType: "Removable",
      subtype: "partials",
    });
    expect(hierarchy.subtype).toBe("partials");
    expect(restorationSubtype).toBe("removable/partials");
  });

  it('"dentures" explicit subtype resolves correctly', () => {
    const { hierarchy, restorationSubtype } = normalizeCaseHierarchy({
      caseType: "Removable",
      subtype: "dentures",
    });
    expect(hierarchy.subtype).toBe("dentures");
    expect(restorationSubtype).toBe("removable/dentures");
  });

  it('"repair_partial" explicit subtype resolves correctly', () => {
    const { hierarchy, restorationSubtype } = normalizeCaseHierarchy({
      caseType: "Removable",
      subtype: "repair_partial",
    });
    expect(hierarchy.caseType).toBe("removable");
    expect(hierarchy.subtype).toBe("repair_partial");
    expect(restorationSubtype).toBe("removable/repair_partial");
  });

  it('"repair_denture" explicit subtype resolves correctly', () => {
    const { hierarchy, restorationSubtype } = normalizeCaseHierarchy({
      caseType: "Removable",
      subtype: "repair_denture",
    });
    expect(hierarchy.caseType).toBe("removable");
    expect(hierarchy.subtype).toBe("repair_denture");
    expect(restorationSubtype).toBe("removable/repair_denture");
  });

  it('"repair_partial" with material includes materialSubtype in encoded key', () => {
    const { restorationSubtype } = normalizeCaseHierarchy({
      caseType: "Removable",
      subtype: "repair_partial",
      material: "Acrylic",
    });
    expect(restorationSubtype).toBe("removable/repair_partial/acrylic");
  });
});
