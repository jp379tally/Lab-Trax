/**
 * Unit tests for the shared item typeahead matcher.
 *
 * Invariants protected:
 *  - Punctuation and spacing in the option name are ignored, so "ema" finds
 *    "E.max Crown" (the regression this exists for).
 *  - Punctuation the user types is ignored too ("e.ma", "3 unit").
 *  - Exact, then prefix, then word-prefix matches rank above incidental
 *    substring matches, so short queries do not bury the obvious answer.
 *  - Options that do not match are dropped; an empty/punctuation-only query
 *    keeps the caller's list and order intact.
 *  - Exact-name helpers treat a differently punctuated spelling of an existing
 *    item as the same item (no duplicate "add new" offer).
 */

import { describe, expect, it } from "vitest";
import {
  filterItemsByName,
  filterNamesByQuery,
  findExactNameMatch,
  hasExactItemNameMatch,
  normalizeItemName,
} from "./index";

const OPTIONS = [
  { name: "Zirconia Crown" },
  { name: "E.max Crown" },
  { name: "3-Unit Bridge" },
  { name: "Custom Emax Inlay" },
  { name: "Full Cast Gold" },
];

const names = (list: { name: string }[]) => list.map((o) => o.name);

describe("normalizeItemName", () => {
  it("lowercases and strips punctuation and spacing", () => {
    expect(normalizeItemName("E.max Crown")).toBe("emaxcrown");
    expect(normalizeItemName("3-Unit Bridge")).toBe("3unitbridge");
    expect(normalizeItemName("  PFM / Metal  ")).toBe("pfmmetal");
  });

  it("reduces a punctuation-only string to empty", () => {
    expect(normalizeItemName(" . - / ")).toBe("");
  });
});

describe("filterItemsByName — punctuation-insensitive matching", () => {
  it('finds "E.max Crown" when the user types "ema"', () => {
    expect(names(filterItemsByName(OPTIONS, "ema"))).toContain("E.max Crown");
  });

  it("ignores punctuation the user types", () => {
    expect(names(filterItemsByName(OPTIONS, "e.ma"))).toContain("E.max Crown");
    expect(names(filterItemsByName(OPTIONS, "3 unit"))).toEqual([
      "3-Unit Bridge",
    ]);
  });

  it("finds names when apostrophes and periods are omitted", () => {
    const peopleAndPractices = [
      { name: "O'Brien, DDS" },
      { name: "St. Mary's Dental" },
    ];

    expect(names(filterItemsByName(peopleAndPractices, "OBrien"))).toEqual([
      "O'Brien, DDS",
    ]);
    expect(names(filterItemsByName(peopleAndPractices, "st marys"))).toEqual([
      "St. Mary's Dental",
    ]);
  });

  it("still matches the plain-substring cases that already worked", () => {
    expect(names(filterItemsByName(OPTIONS, "crown"))).toEqual([
      "Zirconia Crown",
      "E.max Crown",
    ]);
  });

  it("drops options that do not match at all", () => {
    expect(filterItemsByName(OPTIONS, "veneer")).toEqual([]);
  });

  it("returns every option, in order, for an empty or punctuation-only query", () => {
    expect(filterItemsByName(OPTIONS, "")).toEqual(OPTIONS);
    expect(filterItemsByName(OPTIONS, " - ")).toEqual(OPTIONS);
  });
});

describe("filterItemsByName — ranking", () => {
  it("ranks an exact name first even when it was listed last", () => {
    const opts = [{ name: "Emax Crown Prep" }, { name: "E.max" }];
    expect(names(filterItemsByName(opts, "emax"))).toEqual([
      "E.max",
      "Emax Crown Prep",
    ]);
  });

  it("ranks a name starting with the query above a mid-name match", () => {
    // "E.max Crown" → prefix; "Custom Emax Inlay" → word-prefix.
    expect(names(filterItemsByName(OPTIONS, "ema"))).toEqual([
      "E.max Crown",
      "Custom Emax Inlay",
    ]);
  });

  it("ranks a word-prefix match above a bare substring match", () => {
    const opts = [{ name: "Rebridge Repair" }, { name: "Metal Bridge" }];
    expect(names(filterItemsByName(opts, "bri"))).toEqual([
      "Metal Bridge",
      "Rebridge Repair",
    ]);
  });

  it("keeps the caller's order inside a rank (catalog before custom)", () => {
    const opts = [{ name: "Crown A" }, { name: "Crown B" }, { name: "Crown C" }];
    expect(names(filterItemsByName(opts, "crown"))).toEqual([
      "Crown A",
      "Crown B",
      "Crown C",
    ]);
  });
});

describe("filterNamesByQuery — string suggestions", () => {
  const SUGGESTIONS = [
    "Zirconia",
    "E.max",
    "3-Unit Bridge",
    "Custom Emax Inlay",
  ];

  it('finds "E.max" when the user types "ema"', () => {
    expect(filterNamesByQuery(SUGGESTIONS, "ema")).toEqual([
      "E.max",
      "Custom Emax Inlay",
    ]);
  });

  it("ignores punctuation the user types", () => {
    expect(filterNamesByQuery(SUGGESTIONS, "e.ma")).toContain("E.max");
    expect(filterNamesByQuery(SUGGESTIONS, "3 unit")).toEqual([
      "3-Unit Bridge",
    ]);
  });

  it("returns the untouched list for an empty or punctuation-only query", () => {
    expect(filterNamesByQuery(SUGGESTIONS, "")).toEqual(SUGGESTIONS);
    expect(filterNamesByQuery(SUGGESTIONS, " . ")).toEqual(SUGGESTIONS);
  });
});

describe("hasExactItemNameMatch", () => {
  it("matches a differently punctuated spelling of an existing item", () => {
    expect(hasExactItemNameMatch(OPTIONS, "emax crown")).toBe(true);
    expect(hasExactItemNameMatch(OPTIONS, "E.max Crown")).toBe(true);
    expect(hasExactItemNameMatch(OPTIONS, "3 unit bridge")).toBe(true);
  });

  it("is false for a partial query or an unknown item", () => {
    expect(hasExactItemNameMatch(OPTIONS, "ema")).toBe(false);
    expect(hasExactItemNameMatch(OPTIONS, "Veneer")).toBe(false);
  });

  it("is false for an empty or punctuation-only query", () => {
    expect(hasExactItemNameMatch(OPTIONS, "")).toBe(false);
    expect(hasExactItemNameMatch(OPTIONS, " . ")).toBe(false);
  });
});

describe("findExactNameMatch", () => {
  const SUGGESTIONS = ["Zirconia", "E.max", "3-Unit Bridge"];

  it("returns the canonical spelling for a punctuation-only difference", () => {
    expect(findExactNameMatch(SUGGESTIONS, "emax")).toBe("E.max");
    expect(findExactNameMatch(SUGGESTIONS, "3 unit bridge")).toBe(
      "3-Unit Bridge",
    );
  });

  it("returns undefined for a genuinely new value", () => {
    expect(findExactNameMatch(SUGGESTIONS, "Veneer")).toBeUndefined();
    expect(findExactNameMatch(SUGGESTIONS, "ema")).toBeUndefined();
    expect(findExactNameMatch(SUGGESTIONS, " . ")).toBeUndefined();
  });
});