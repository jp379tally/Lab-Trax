/**
 * Cross-platform parity test: server classifyCase vs mobile classifyCaseCategory.
 *
 * The desktop Stats dashboard uses the server's `classifyCase` (per-restoration
 * rows), while the mobile Stats bars use `classifyCaseCategory` (comma-joined
 * strings built by the list route's `enriched` builder). A shape change or new
 * AI-import quirk can silently produce a different bucket on one platform without
 * any test catching it.
 *
 * This suite runs BOTH classifiers against the same representative inputs and
 * asserts they agree. Each fixture mirrors how the same case appears in both
 * contexts:
 *
 *   server  — classifyCase([{ restorationType, material, restorationSubtype }])
 *   mobile  — classifyCaseCategory(commaJoinedTypes, commaJoinedMaterials)
 *
 * For the structured-subtype path the server uses classifyRestoration with a
 * decoded taxonomy key while mobile exposes a parallel
 * classifyCaseCategoryFromSubtype helper; both paths are covered here.
 *
 * The server classifier is imported via a direct relative path — both
 * artifacts/api-server/src/lib/case-category.ts and its only dependency
 * (material-mapping.ts) are pure TypeScript with no React Native or Expo deps,
 * and @workspace/case-taxonomy is already a shared dep of this package.
 *
 * Keep these fixtures in sync with the known divergence risk documented in
 * .agents/memory/mobile-stat-bar-drilldown-classifier.md.
 */

import { describe, expect, it } from "vitest";

// Mobile classifiers — normal in-package import.
import {
  classifyCaseCategory,
  classifyCaseCategoryFromSubtype,
} from "@/lib/case-category";

// Server classifiers — cross-package relative import.
// artifacts/labtrax/lib/__tests__/ → artifacts/api-server/src/lib/
// Both case-category.ts and its dependency material-mapping.ts are pure TS;
// @workspace/case-taxonomy is already a shared dependency of this package.
import {
  classifyCase,
  classifyRestoration,
  classifyLegacyCase,
} from "../../../api-server/src/lib/case-category";

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

interface ParityFixture {
  label: string;
  /** Server format: array of restoration rows. */
  rows: Array<{
    restorationType?: string | null;
    material?: string | null;
    restorationSubtype?: string | null;
  }>;
  /** Mobile format: comma-joined restorationType values. */
  types: string;
  /** Mobile format: comma-joined material values. */
  materials: string;
  expected: string;
}

// ---------------------------------------------------------------------------
// Free-text fixtures (restorationSubtype = null)
//
// Primary divergence-risk zone: AI imports set restorationType from free-form
// OCR/scan text without populating the structured subtype column. The server
// regex path and the mobile regex path must agree.
// ---------------------------------------------------------------------------

const FREE_TEXT_FIXTURES: ParityFixture[] = [
  // ── Removable ─────────────────────────────────────────────────────────────
  {
    label: "AI-imported removable — type 'Removable', material 'Acrylic'",
    rows: [{ restorationType: "Removable", material: "Acrylic", restorationSubtype: null }],
    types: "Removable",
    materials: "Acrylic",
    expected: "removable",
  },
  {
    label: "AI-imported removable — type 'Removable', no material",
    rows: [{ restorationType: "Removable", material: null, restorationSubtype: null }],
    types: "Removable",
    materials: "",
    expected: "removable",
  },
  {
    label: "Full Denture — type only",
    rows: [{ restorationType: "Full Denture", material: null, restorationSubtype: null }],
    types: "Full Denture",
    materials: "",
    expected: "removable",
  },
  {
    label: "Partial — Valplast material",
    rows: [{ restorationType: "Partial", material: "Valplast", restorationSubtype: null }],
    types: "Partial",
    materials: "Valplast",
    expected: "removable",
  },
  {
    label: "Flipper — type only",
    rows: [{ restorationType: "Flipper", material: null, restorationSubtype: null }],
    types: "Flipper",
    materials: "",
    expected: "removable",
  },

  // ── Implants ──────────────────────────────────────────────────────────────
  {
    label: "Implant Crown — type 'Implant Crown', material 'Zirconia'",
    rows: [{ restorationType: "Implant Crown", material: "Zirconia", restorationSubtype: null }],
    types: "Implant Crown",
    materials: "Zirconia",
    expected: "implants",
  },
  {
    label: "Custom Abutment — no material",
    rows: [{ restorationType: "Custom Abutment", material: null, restorationSubtype: null }],
    types: "Custom Abutment",
    materials: "",
    expected: "implants",
  },
  {
    label: "Screw-retained crown — material Emax",
    rows: [{ restorationType: "Screw-retained crown", material: "Emax", restorationSubtype: null }],
    types: "Screw-retained crown",
    materials: "Emax",
    expected: "implants",
  },
  {
    label: "All-on-4 hybrid — no material",
    rows: [{ restorationType: "All-on-4 hybrid", material: null, restorationSubtype: null }],
    types: "All-on-4 hybrid",
    materials: "",
    expected: "implants",
  },

  // ── Zirconia ──────────────────────────────────────────────────────────────
  {
    label: "Crown — Zirconia material",
    rows: [{ restorationType: "Crown", material: "Zirconia", restorationSubtype: null }],
    types: "Crown",
    materials: "Zirconia",
    expected: "zirconia",
  },
  {
    label: "Crown — BruxZir brand name",
    rows: [{ restorationType: "Crown", material: "BruxZir", restorationSubtype: null }],
    types: "Crown",
    materials: "BruxZir",
    expected: "zirconia",
  },
  {
    label: "Crown — 'zirc' abbreviation",
    rows: [{ restorationType: "Crown", material: "zirc", restorationSubtype: null }],
    types: "Crown",
    materials: "zirc",
    expected: "zirconia",
  },

  // ── Crown & Bridge ────────────────────────────────────────────────────────
  {
    label: "Crown — PFM material",
    rows: [{ restorationType: "Crown", material: "PFM", restorationSubtype: null }],
    types: "Crown",
    materials: "PFM",
    expected: "crown_bridge",
  },
  {
    label: "Bridge — no material",
    rows: [{ restorationType: "Bridge", material: null, restorationSubtype: null }],
    types: "Bridge",
    materials: "",
    expected: "crown_bridge",
  },
  {
    label: "Veneer — Emax material",
    rows: [{ restorationType: "Veneer", material: "Emax", restorationSubtype: null }],
    types: "Veneer",
    materials: "Emax",
    expected: "crown_bridge",
  },
  {
    label: "Onlay — no material",
    rows: [{ restorationType: "Onlay", material: null, restorationSubtype: null }],
    types: "Onlay",
    materials: "",
    expected: "crown_bridge",
  },
  {
    label: "Full Cast Gold — no type",
    rows: [{ restorationType: null, material: "Full Cast Gold", restorationSubtype: null }],
    types: "",
    materials: "Full Cast Gold",
    expected: "crown_bridge",
  },

  // ── Other ─────────────────────────────────────────────────────────────────
  {
    label: "Night Guard — Acrylic material",
    rows: [{ restorationType: "Night Guard", material: "Acrylic", restorationSubtype: null }],
    types: "Night Guard",
    materials: "Acrylic",
    expected: "other",
  },
  {
    label: "Retainer — no material",
    rows: [{ restorationType: "Retainer", material: null, restorationSubtype: null }],
    types: "Retainer",
    materials: "",
    expected: "other",
  },
  {
    label: "Alloy surcharge — no type",
    rows: [{ restorationType: "Alloy surcharge", material: null, restorationSubtype: null }],
    types: "Alloy surcharge",
    materials: "",
    expected: "other",
  },

  // ── Uncategorized ─────────────────────────────────────────────────────────
  {
    label: "No rows at all → uncategorized",
    rows: [],
    types: "",
    materials: "",
    expected: "uncategorized",
  },
  {
    label: "Blank type and material → uncategorized",
    rows: [{ restorationType: "", material: "", restorationSubtype: null }],
    types: "",
    materials: "",
    expected: "uncategorized",
  },

  // ── Priority edge cases ───────────────────────────────────────────────────
  {
    label: "Multi-restoration: implant wins over zirconia",
    rows: [
      { restorationType: "Crown", material: "Zirconia", restorationSubtype: null },
      { restorationType: "Implant Crown", material: "Emax", restorationSubtype: null },
    ],
    types: "Crown, Implant Crown",
    materials: "Zirconia, Emax",
    expected: "implants",
  },
  {
    label: "Multi-restoration: zirconia wins over crown_bridge",
    rows: [
      { restorationType: "Crown", material: "PFM", restorationSubtype: null },
      { restorationType: "Crown", material: "BruxZir", restorationSubtype: null },
    ],
    types: "Crown, Crown",
    materials: "PFM, BruxZir",
    expected: "zirconia",
  },
  {
    label: "Multi-restoration: removable wins over other",
    rows: [
      { restorationType: "Night Guard", material: null, restorationSubtype: null },
      { restorationType: "Full Denture", material: null, restorationSubtype: null },
    ],
    types: "Night Guard, Full Denture",
    materials: "",
    expected: "removable",
  },
];

// ---------------------------------------------------------------------------
// Structured-subtype fixtures
//
// When restorationSubtype is populated, the server calls deriveCaseHierarchy /
// hierarchyToCaseCategory. The mobile Stats drill-down calls
// classifyCaseCategoryFromSubtype for the same key. Both must agree.
// ---------------------------------------------------------------------------

interface SubtypeParityFixture {
  label: string;
  /** Encoded subtype key, e.g. "restorative/crown_and_bridge/zirconia". */
  subtype: string;
  expected: string;
}

const SUBTYPE_FIXTURES: SubtypeParityFixture[] = [
  { label: "restorative/implant → implants", subtype: "restorative/implant", expected: "implants" },
  {
    label: "restorative/implant/zirconia → implants (implant wins over material)",
    subtype: "restorative/implant/zirconia",
    expected: "implants",
  },
  {
    label: "restorative/crown_and_bridge/zirconia → zirconia",
    subtype: "restorative/crown_and_bridge/zirconia",
    expected: "zirconia",
  },
  { label: "restorative/crown_and_bridge/pfz → zirconia", subtype: "restorative/crown_and_bridge/pfz", expected: "zirconia" },
  { label: "restorative/crown_and_bridge/pfm → crown_bridge", subtype: "restorative/crown_and_bridge/pfm", expected: "crown_bridge" },
  {
    label: "restorative/crown_and_bridge (no material) → crown_bridge",
    subtype: "restorative/crown_and_bridge",
    expected: "crown_bridge",
  },
  { label: "restorative/temporaries → crown_bridge", subtype: "restorative/temporaries", expected: "crown_bridge" },
  { label: "removable/dentures → removable", subtype: "removable/dentures", expected: "removable" },
  { label: "removable/partials/acrylic → removable", subtype: "removable/partials/acrylic", expected: "removable" },
  { label: "removable/flippers → removable", subtype: "removable/flippers", expected: "removable" },
  { label: "ortho/night_guards → other", subtype: "ortho/night_guards", expected: "other" },
  { label: "ortho/retainers → other", subtype: "ortho/retainers", expected: "other" },
];

// ---------------------------------------------------------------------------
// Legacy blob fixtures
//
// Legacy lab_cases blobs surface only on the server (classifyLegacyCase).
// The mobile list never exposes raw blobs — it always has comma-joined strings.
// These fixtures confirm that the server's blob path and the mobile's string
// path agree for the same underlying field values.
// ---------------------------------------------------------------------------

interface LegacyParityFixture {
  label: string;
  blob: Record<string, unknown>;
  types: string;
  materials: string;
  expected: string;
}

const LEGACY_FIXTURES: LegacyParityFixture[] = [
  { label: "implant blob", blob: { restorationType: "Implant crown" }, types: "Implant crown", materials: "", expected: "implants" },
  {
    label: "zirconia blob — BruxZir material",
    blob: { caseType: "Crown", material: "BruxZir" },
    types: "Crown",
    materials: "BruxZir",
    expected: "zirconia",
  },
  { label: "denture blob", blob: { caseType: "Denture" }, types: "Denture", materials: "", expected: "removable" },
  { label: "crown blob", blob: { caseType: "Crown" }, types: "Crown", materials: "", expected: "crown_bridge" },
  { label: "sports guard blob", blob: { caseType: "Sports guard" }, types: "Sports guard", materials: "", expected: "other" },
];

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("Stats classifier parity: free-text path (restorationSubtype = null)", () => {
  for (const fixture of FREE_TEXT_FIXTURES) {
    it(fixture.label, async () => {
      // Server: classifyCase over per-row array.
      const serverResult = classifyCase(fixture.rows);

      // Mobile: classifyCaseCategory over comma-joined strings (the format the
      // list route's `enriched` builder produces).
      const mobileResult = classifyCaseCategory(fixture.types, fixture.materials);

      expect(serverResult).toBe(fixture.expected);
      expect(mobileResult).toBe(fixture.expected);

      // Explicit parity assertion: the two classifiers MUST agree regardless
      // of which one matches the expected value.
      expect(serverResult).toBe(mobileResult);
    });
  }
});

describe("Stats classifier parity: structured-subtype path", () => {
  for (const fixture of SUBTYPE_FIXTURES) {
    it(fixture.label, async () => {
      // Server: classifyRestoration with the subtype key set; pass empty
      // free-text so the taxonomy decoder is the only active route.
      const serverResult = classifyRestoration(null, null, fixture.subtype);

      // Mobile: classifyCaseCategoryFromSubtype.
      const mobileResult = classifyCaseCategoryFromSubtype(fixture.subtype);

      expect(serverResult).toBe(fixture.expected);
      expect(mobileResult).toBe(fixture.expected);
      expect(serverResult).toBe(mobileResult);
    });
  }
});

describe("Stats classifier parity: legacy blob vs free-text strings", () => {
  for (const fixture of LEGACY_FIXTURES) {
    it(fixture.label, async () => {
      const serverResult = classifyLegacyCase(fixture.blob);
      const mobileResult = classifyCaseCategory(fixture.types, fixture.materials);

      expect(serverResult).toBe(fixture.expected);
      expect(mobileResult).toBe(fixture.expected);
      expect(serverResult).toBe(mobileResult);
    });
  }
});
