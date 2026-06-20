import { describe, it, expect } from "vitest";
import {
  CANONICAL_LITHIUM_DISILICATE,
  CANONICAL_PFM,
  CANONICAL_ZIRCONIA,
  DEFAULT_TIER_ITEMS,
  DEFAULT_TIER_KEYS,
  isKnownPriceKey,
  materialToPriceKey,
  normalizeMaterialName,
} from "./material-mapping.js";

describe("materialToPriceKey", () => {
  it("returns null for empty input", () => {
    expect(materialToPriceKey(null, null)).toBeNull();
    expect(materialToPriceKey("", "")).toBeNull();
    expect(materialToPriceKey("widget", "thingy")).toBeNull();
  });

  it("maps zirconia variants to zirconia_crown", () => {
    expect(materialToPriceKey("Zirconia", "Crown")).toBe("zirconia_crown");
    expect(materialToPriceKey("BruxZir Solid Zirconia", null)).toBe(
      "zirconia_crown",
    );
  });

  it("maps PFZ (porcelain fused to zirconia) to zirconia_crown", () => {
    // Regression: previously returned the orphan key 'pfz_crown' that
    // wasn't part of DEFAULT_TIER_KEYS, so resolution silently failed.
    expect(materialToPriceKey("PFZ", "Crown")).toBe("zirconia_crown");
    expect(materialToPriceKey("Porcelain Fused to Zirconia (PFZ)", null)).toBe(
      "zirconia_crown",
    );
  });

  it("maps E.max variants to emax_crown", () => {
    expect(materialToPriceKey("EMax", null)).toBe("emax_crown");
    expect(materialToPriceKey("E.max", null)).toBe("emax_crown");
    expect(materialToPriceKey("E Max", null)).toBe("emax_crown");
  });

  it("maps PFM and metal alloys to pfm_crown", () => {
    expect(materialToPriceKey("PFM", null)).toBe("pfm_crown");
    expect(materialToPriceKey("Full Cast Gold", null)).toBe("pfm_crown");
    expect(materialToPriceKey("Cast Metal", null)).toBe("pfm_crown");
  });

  it("maps acrylic and denture restoration types to denture", () => {
    expect(materialToPriceKey("Acrylic", null)).toBe("denture");
    expect(materialToPriceKey(null, "Full Denture")).toBe("denture");
  });

  it("maps flexible/partial to partial", () => {
    expect(materialToPriceKey("Flexible Nylon", null)).toBe("partial");
    expect(materialToPriceKey(null, "Partial Denture")).toBe("partial");
  });

  it("maps night guard variants in priority order", () => {
    expect(materialToPriceKey(null, "Night Guard - Hard/Soft")).toBe(
      "night_guard_hard_soft",
    );
    expect(materialToPriceKey(null, "Night Guard - Soft")).toBe(
      "night_guard_soft",
    );
    expect(materialToPriceKey(null, "Night Guard")).toBe("night_guard_hard");
    expect(materialToPriceKey("Night Guard Soft", null)).toBe(
      "night_guard_soft",
    );
  });

  it("maps retainer variants", () => {
    expect(materialToPriceKey(null, "Hawley Retainer")).toBe("retainer_hawley");
    expect(materialToPriceKey(null, "Lingual Retainer")).toBe(
      "retainer_lingual",
    );
    expect(materialToPriceKey(null, "Retainer")).toBe("retainer_hard");
  });

  it("maps implant, snore, sports", () => {
    expect(materialToPriceKey(null, "Implant Crown")).toBe("implant");
    expect(materialToPriceKey(null, "Snore Appliance")).toBe("snore_guard");
    expect(materialToPriceKey(null, "Sports Guard")).toBe("sports_guard");
  });

  it("only returns keys that exist in DEFAULT_TIER_KEYS", () => {
    // Sweep a bunch of plausible inputs and verify every non-null result
    // is a real tier key, so a future mapping bug can't reintroduce an
    // orphan key like the old `pfz_crown`.
    const samples: Array<[string | null, string | null]> = [
      ["Zirconia", "Crown"],
      ["PFZ", "Crown"],
      ["E.max", "Crown"],
      ["PFM", "Crown"],
      ["Gold", "Crown"],
      ["Acrylic", null],
      [null, "Denture"],
      ["Flexible", null],
      [null, "Partial"],
      [null, "Implant"],
      [null, "Night Guard - Hard/Soft"],
      [null, "Night Guard - Soft"],
      [null, "Night Guard"],
      [null, "Hawley"],
      [null, "Lingual"],
      [null, "Retainer"],
      [null, "Snore Guard"],
      [null, "Sports Guard"],
    ];
    for (const [m, rt] of samples) {
      const k = materialToPriceKey(m, rt);
      if (k !== null) {
        expect(
          isKnownPriceKey(k),
          `materialToPriceKey(${m!}, ${rt!}) returned orphan key ${k}`,
        ).toBe(true);
      }
    }
  });

  it("DEFAULT_TIER_ITEMS and DEFAULT_TIER_KEYS stay in sync", () => {
    expect(DEFAULT_TIER_KEYS).toEqual(DEFAULT_TIER_ITEMS.map((i) => i.key));
    expect(new Set(DEFAULT_TIER_KEYS).size).toBe(DEFAULT_TIER_KEYS.length);
  });
});

describe("normalizeMaterialName", () => {
  it("passes through null/undefined/empty unchanged", () => {
    expect(normalizeMaterialName(null)).toBeNull();
    expect(normalizeMaterialName(undefined)).toBeUndefined();
    expect(normalizeMaterialName("")).toBe("");
    expect(normalizeMaterialName("   ")).toBe("");
  });

  it("maps all zirconia synonyms to canonical Zirconia", () => {
    for (const v of [
      "Zirconia",
      "Zirc",
      "Zr",
      "Brux",
      "BruxZ",
      "Bruxzir",
      "BZR",
      "PFZ",
      "BruxZir Solid Zirconia",
      "Ceramic: Zirconia",
    ]) {
      expect(normalizeMaterialName(v)).toBe(CANONICAL_ZIRCONIA);
    }
  });

  it("maps all lithium disilicate synonyms to canonical Lithium Disilicate", () => {
    for (const v of [
      "Emax",
      "E.max",
      "E max",
      "lithium disilicate",
      "Lithium Silicate",
      "Ceramic: E.max",
      "Lithium Disilicate (Emax)",
    ]) {
      expect(normalizeMaterialName(v)).toBe(CANONICAL_LITHIUM_DISILICATE);
    }
  });

  it("maps PFM synonyms to canonical PFM", () => {
    expect(normalizeMaterialName("PFM")).toBe(CANONICAL_PFM);
    expect(normalizeMaterialName("porcelain fused to metal")).toBe(
      CANONICAL_PFM,
    );
  });

  it("leaves unmatched materials untouched (trimmed)", () => {
    expect(normalizeMaterialName("Gold")).toBe("Gold");
    expect(normalizeMaterialName("  Acrylic  ")).toBe("Acrylic");
    expect(normalizeMaterialName("Composite")).toBe("Composite");
  });

  it("does not fire on substrings inside larger words", () => {
    // "zr" / "zirc" must be word-boundary matched, not substring matched.
    expect(normalizeMaterialName("Bizarre")).toBe("Bizarre");
  });

  it("the renamed vocab entry still resolves to the emax price key", () => {
    // The user-facing vocab entry was renamed to "Lithium Disilicate (Emax)";
    // it must still normalize and price as the (internal) emax_crown key.
    const normalized = normalizeMaterialName("Lithium Disilicate (Emax)");
    expect(normalized).toBe(CANONICAL_LITHIUM_DISILICATE);
    expect(materialToPriceKey(normalized, "Crown")).toBe("emax_crown");
  });

  it("normalized names resolve to the expected price keys", () => {
    expect(materialToPriceKey(normalizeMaterialName("BruxZ"), "Crown")).toBe(
      "zirconia_crown",
    );
    expect(
      materialToPriceKey(normalizeMaterialName("lithium silicate"), "Crown"),
    ).toBe("emax_crown");
    expect(materialToPriceKey(normalizeMaterialName("PFM"), "Crown")).toBe(
      "pfm_crown",
    );
  });
});
