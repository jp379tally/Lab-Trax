/**
 * Unit tests for `deriveCaseTypeIndicator` and parity tests against the
 * server-side `classifyRestoration` function.
 *
 * `deriveCaseTypeIndicator` runs client-side on the `restorationTypes` and
 * `restorationMaterials` string fields returned by the cases list endpoint.
 * The parity suite confirms that the client regex rules and server regex rules
 * agree on the C/D/O/null classification for a shared set of representative
 * fixtures. Any divergence here means the badge would show the wrong letter
 * (or disappear entirely) for a real case.
 *
 * Server category → client badge mapping:
 *   "implants"      → "C"
 *   "zirconia"      → "C"
 *   "crown_bridge"  → "C"
 *   "removable"     → "D"
 *   "other"         → "O" or null
 *   "uncategorized" → null
 *
 * The client indicator is deliberately FINER-GRAINED than the server's
 * analytics buckets: ortho / appliance work (night guards, retainers,
 * splints, bleach trays) shows an "O" badge while the server still rolls it
 * up under "other". So a client "O" must map to a server "other" — never to
 * a restorative or removable bucket.
 */

import { describe, it, expect } from "vitest";
import { deriveCaseTypeIndicator } from "@/lib/case-date-filter";

// Server-side classifier — imported via relative path so the test file
// exercises the real production code without going through the build.
import { classifyRestoration } from "../../../api-server/src/lib/case-category";
import type { CaseCategory } from "../../../api-server/src/lib/case-category";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map the server's full CaseCategory to the client indicator. "other" is
 * intentionally ambiguous on the client — ortho / appliance work resolves to
 * "O" while genuinely unclassifiable work stays null — so it is returned as
 * `undefined` and checked separately by the parity assertions below.
 */
function serverToClientBadge(cat: CaseCategory): "C" | "D" | null | undefined {
  if (cat === "implants" || cat === "zirconia" || cat === "crown_bridge") return "C";
  if (cat === "removable") return "D";
  if (cat === "other") return undefined;
  return null;
}

// ---------------------------------------------------------------------------
// Unit tests — deriveCaseTypeIndicator
// ---------------------------------------------------------------------------

describe("deriveCaseTypeIndicator — null / empty guard", () => {
  it("returns null when both args are undefined", () => {
    expect(deriveCaseTypeIndicator()).toBeNull();
  });

  it("returns null when both args are null", () => {
    expect(deriveCaseTypeIndicator(null, null)).toBeNull();
  });

  it("returns null when both args are empty strings", () => {
    expect(deriveCaseTypeIndicator("", "")).toBeNull();
  });

  it("returns null when both args are whitespace-only strings", () => {
    expect(deriveCaseTypeIndicator("  ", "  ")).toBeNull();
  });

  it("returns null when restorationTypes is null but material is empty", () => {
    expect(deriveCaseTypeIndicator(null, "")).toBeNull();
  });
});

describe("deriveCaseTypeIndicator — Crown & Bridge (C) classification", () => {
  it('returns "C" for restorationType "crown"', () => {
    expect(deriveCaseTypeIndicator("crown")).toBe("C");
  });

  it('returns "C" for restorationType "bridge"', () => {
    expect(deriveCaseTypeIndicator("bridge")).toBe("C");
  });

  it('returns "C" for restorationType "veneer"', () => {
    expect(deriveCaseTypeIndicator("veneer")).toBe("C");
  });

  it('returns "C" for restorationType "inlay"', () => {
    expect(deriveCaseTypeIndicator("inlay")).toBe("C");
  });

  it('returns "C" for restorationType "onlay"', () => {
    expect(deriveCaseTypeIndicator("onlay")).toBe("C");
  });

  it('returns "C" for restorationType containing "implant"', () => {
    expect(deriveCaseTypeIndicator("implant retained crown")).toBe("C");
  });

  it('returns "C" for restorationType containing "abutment"', () => {
    expect(deriveCaseTypeIndicator("custom abutment")).toBe("C");
  });

  it('returns "C" for restorationType "screw-retained crown"', () => {
    expect(deriveCaseTypeIndicator("screw-retained crown")).toBe("C");
  });

  it('returns "C" for restorationType "all-on-4"', () => {
    expect(deriveCaseTypeIndicator("all-on-4")).toBe("C");
  });

  it('returns "C" for restorationType "pontic"', () => {
    expect(deriveCaseTypeIndicator("pontic")).toBe("C");
  });

  it('returns "C" for restorationType "maryland"', () => {
    expect(deriveCaseTypeIndicator("maryland bridge")).toBe("C");
  });

  it('returns "C" for restorationType "coping"', () => {
    expect(deriveCaseTypeIndicator("coping")).toBe("C");
  });
});

describe("deriveCaseTypeIndicator — Zirconia material (C) classification", () => {
  it('returns "C" when material contains "zirconia"', () => {
    expect(deriveCaseTypeIndicator(null, "zirconia")).toBe("C");
  });

  it('returns "C" when material is "BruxZir" (brand zirconia)', () => {
    expect(deriveCaseTypeIndicator(null, "BruxZir")).toBe("C");
  });

  it('returns "C" when material is "Brux" abbreviation', () => {
    expect(deriveCaseTypeIndicator(null, "brux")).toBe("C");
  });

  it('returns "C" when material is "zirc" abbreviation', () => {
    expect(deriveCaseTypeIndicator(null, "zirc")).toBe("C");
  });

  it('returns "C" when material is "PFZ" abbreviation', () => {
    expect(deriveCaseTypeIndicator(null, "PFZ")).toBe("C");
  });

  it('returns "C" for combined restorationType crown + zirconia material', () => {
    expect(deriveCaseTypeIndicator("crown", "zirconia")).toBe("C");
  });
});

describe("deriveCaseTypeIndicator — Removable (D) classification", () => {
  it('returns "D" for restorationType "denture"', () => {
    expect(deriveCaseTypeIndicator("denture")).toBe("D");
  });

  it('returns "D" for restorationType "partial"', () => {
    expect(deriveCaseTypeIndicator("partial")).toBe("D");
  });

  it('returns "D" for restorationType "flipper"', () => {
    expect(deriveCaseTypeIndicator("flipper")).toBe("D");
  });

  it('returns "D" for restorationType "flexible"', () => {
    expect(deriveCaseTypeIndicator("flexible partial")).toBe("D");
  });

  it('returns "D" for restorationType "valplast"', () => {
    expect(deriveCaseTypeIndicator("valplast")).toBe("D");
  });

  it('returns "D" when material matches removable and type is empty', () => {
    expect(deriveCaseTypeIndicator("", "denture acrylic")).toBe("D");
  });
});

describe("deriveCaseTypeIndicator — ortho / appliance input returns \"O\"", () => {
  it('returns "O" for an appliance restoration type like \'night guard\'', () => {
    expect(deriveCaseTypeIndicator("night guard")).toBe("O");
  });

  it('returns "O" for an appliance type like \'retainer\'', () => {
    expect(deriveCaseTypeIndicator("retainer")).toBe("O");
  });

  it('returns "O" for an ortho structured subtype', () => {
    expect(deriveCaseTypeIndicator(null, null, "ortho/night_guards")).toBe("O");
  });
});

describe("deriveCaseTypeIndicator — unrecognized input returns null", () => {
  it("returns null for an unrecognized material without a matching type", () => {
    expect(deriveCaseTypeIndicator(null, "acrylic")).toBeNull();
  });

  it("returns null when only a case number is passed (no restoration info)", () => {
    expect(deriveCaseTypeIndicator("LAB-00123")).toBeNull();
  });
});

describe("deriveCaseTypeIndicator — implant wins over removable in same haystack", () => {
  it('returns "C" when both implant and denture terms appear (implant wins)', () => {
    expect(deriveCaseTypeIndicator("implant supported denture")).toBe("C");
  });
});

describe("deriveCaseTypeIndicator — removable type wins over zirconia/PFZ material", () => {
  it('returns "D" for restorationTypes="Full Denture" + restorationMaterials="PFZ"', () => {
    expect(deriveCaseTypeIndicator("Full Denture", "PFZ")).toBe("D");
  });

  it('returns "D" for restorationTypes="Partial" + restorationMaterials="Zirconia"', () => {
    expect(deriveCaseTypeIndicator("Partial", "Zirconia")).toBe("D");
  });

  it('returns "C" for restorationTypes="Crown" + restorationMaterials="PFZ" (unchanged)', () => {
    expect(deriveCaseTypeIndicator("Crown", "PFZ")).toBe("C");
  });
});

// ---------------------------------------------------------------------------
// Parity tests — deriveCaseTypeIndicator vs classifyRestoration
//
// The client and server use independent regex implementations. These tests
// verify that the two functions agree on a representative fixture set so that
// the badge is never silently out of sync with the server's analytics bucket.
// ---------------------------------------------------------------------------

interface ParityFixture {
  restorationType: string | null;
  material: string | null;
  description: string;
}

const PARITY_FIXTURES: ParityFixture[] = [
  { restorationType: "crown", material: null, description: "plain crown" },
  { restorationType: "bridge", material: null, description: "plain bridge" },
  { restorationType: "veneer", material: null, description: "veneer" },
  { restorationType: "inlay", material: null, description: "inlay" },
  { restorationType: "onlay", material: null, description: "onlay" },
  { restorationType: "maryland bridge", material: null, description: "maryland bridge" },
  { restorationType: "pontic", material: null, description: "pontic" },
  { restorationType: "coping", material: null, description: "coping" },
  { restorationType: "implant retained crown", material: null, description: "implant retained crown" },
  { restorationType: "custom abutment", material: null, description: "abutment" },
  { restorationType: "screw-retained crown", material: null, description: "screw-retained crown" },
  { restorationType: "all-on-4", material: null, description: "all-on-4" },
  { restorationType: null, material: "Zirconia", description: "Zirconia material" },
  { restorationType: null, material: "BruxZir", description: "BruxZir material" },
  { restorationType: "crown", material: "Zirconia", description: "crown + Zirconia" },
  { restorationType: "denture", material: null, description: "denture" },
  { restorationType: "partial", material: null, description: "partial" },
  { restorationType: "flipper", material: null, description: "flipper" },
  { restorationType: "flexible partial", material: null, description: "flexible partial" },
  { restorationType: "valplast", material: null, description: "valplast" },
  { restorationType: null, material: null, description: "both null" },
  { restorationType: "", material: "", description: "both empty" },
  { restorationType: "night guard", material: null, description: "night guard (ortho → O)" },
  { restorationType: "retainer", material: null, description: "retainer (ortho → O)" },
  { restorationType: "implant supported denture", material: null, description: "implant + denture (implant wins)" },
];

describe("parity: deriveCaseTypeIndicator vs classifyRestoration", () => {
  for (const { restorationType, material, description } of PARITY_FIXTURES) {
    it(`agrees on: ${description}`, () => {
      const clientResult = deriveCaseTypeIndicator(restorationType, material);
      const serverCategory = classifyRestoration(restorationType, material);
      const expectedFromServer = serverToClientBadge(serverCategory);
      if (expectedFromServer === undefined) {
        // Server bucket is "other": the client either refines it to the ortho
        // badge or leaves the case unclassified — never C or D.
        expect(clientResult === "O" || clientResult === null).toBe(true);
      } else {
        expect(clientResult).toBe(expectedFromServer);
      }
    });
  }

  it("client 'C' always maps to a C-category server result (implants, zirconia, crown_bridge)", () => {
    const cFixtures = PARITY_FIXTURES.filter(
      ({ restorationType, material }) =>
        deriveCaseTypeIndicator(restorationType, material) === "C",
    );
    expect(cFixtures.length).toBeGreaterThan(0);
    for (const { restorationType, material } of cFixtures) {
      const serverCat = classifyRestoration(restorationType, material);
      expect(["implants", "zirconia", "crown_bridge"]).toContain(serverCat);
    }
  });

  it("client 'D' always maps to 'removable' on the server", () => {
    const dFixtures = PARITY_FIXTURES.filter(
      ({ restorationType, material }) =>
        deriveCaseTypeIndicator(restorationType, material) === "D",
    );
    expect(dFixtures.length).toBeGreaterThan(0);
    for (const { restorationType, material } of dFixtures) {
      const serverCat = classifyRestoration(restorationType, material);
      expect(serverCat).toBe("removable");
    }
  });

  it("client 'O' always maps to 'other' on the server (analytics buckets unchanged)", () => {
    const oFixtures = PARITY_FIXTURES.filter(
      ({ restorationType, material }) =>
        deriveCaseTypeIndicator(restorationType, material) === "O",
    );
    expect(oFixtures.length).toBeGreaterThan(0);
    for (const { restorationType, material } of oFixtures) {
      const serverCat = classifyRestoration(restorationType, material);
      expect(serverCat).toBe("other");
    }
  });

  it("client null always maps to other/uncategorized on the server", () => {
    const nullFixtures = PARITY_FIXTURES.filter(
      ({ restorationType, material }) =>
        deriveCaseTypeIndicator(restorationType, material) === null,
    );
    expect(nullFixtures.length).toBeGreaterThan(0);
    for (const { restorationType, material } of nullFixtures) {
      const serverCat = classifyRestoration(restorationType, material);
      expect(["other", "uncategorized"]).toContain(serverCat);
    }
  });
});
