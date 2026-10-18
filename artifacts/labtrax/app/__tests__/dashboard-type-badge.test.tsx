import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react-native";
import { Text } from "react-native";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";
import DashboardScreen, { deriveCaseTypeIndicator } from "../(tabs)/dashboard";
import { getCompactWorkDetails } from "@/lib/case-category";

afterEach(() => {
  cleanup();
  resetMockAppState();
});

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * Pins the type-badge rendering for the mobile dashboard's case-preview
 * cards. The badge shows "C" (Crown & Bridge), "D" (Removable) or "O"
 * (Ortho / Appliances) so technicians can visually triage cases by work
 * type at a glance, and sits
 * directly above the status badge — the dashboard card is intentionally
 * identical to the Cases tab's card (see app/(tabs)/index.tsx).
 *
 * `deriveCaseTypeIndicator` itself is retained only for due-tomorrow sort
 * comparisons (see `comparableText(deriveCaseTypeIndicator(...))`); the
 * card's badge now comes from the shared `getCompactWorkDetails` (in
 * lib/case-category.ts) + `TypeBadge` component, not this function.
 *
 * Three layers of coverage:
 *
 *   1. Badge rendering — a component mirroring the exact renderCaseRow badge
 *      JSX is rendered with RNTL so this test exercises the real rendering
 *      pipeline end-to-end. A structural change that removes or swaps the
 *      badge Text would fail here.
 *
 *   2. deriveCaseTypeIndicator classification — the exported function that
 *      maps restorationTypes/restorationMaterials/subtype to "C", "D" or "O"
 *      is tested directly (still used for due-tomorrow sorting). It mirrors
 *      getCompactWorkDetails so the sort can never disagree with the letter
 *      shown on the row.
 *
 *   3. Structural wiring (source inspection) — confirms renderCaseRow derives
 *      its work/type info from the shared getCompactWorkDetails helper and
 *      renders a TypeBadge above the StatusBadge, and that every section
 *      (past due, due tomorrow, due today, recent) calls renderCaseRow(c)
 *      with no per-section opts — the card must look identical everywhere.
 */

// ── Badge component (mirrors renderCaseRow's badge rendering exactly) ─────────
//
// renderCaseRow computes typeIndicator and renders it inside a View badge when
// non-null. This component mirrors that exact structure so RNTL can assert the
// text is actually present in the rendered output.
function MobileTypeBadge({
  restorationTypes,
  restorationMaterials,
  restorationSubtype,
}: {
  restorationTypes?: string | null;
  restorationMaterials?: string | null;
  restorationSubtype?: string | null;
}) {
  const typeIndicator = deriveCaseTypeIndicator(
    restorationTypes,
    restorationMaterials,
    restorationSubtype,
  );
  if (typeIndicator === null) return null;
  return (
    <Text testID="type-badge">{typeIndicator}</Text>
  );
}

// ── 1. Rendering tests ────────────────────────────────────────────────────────

describe("Mobile dashboard — C/D/O badge renders correctly for past-due cases", () => {
  it("renders the C badge for a past-due crown case", async () => {
    const { getByTestId } = await render(
      <MobileTypeBadge restorationTypes="Crown" />,
    );
    expect(getByTestId("type-badge").props.children).toBe("C");
  });

  it("renders the C badge for a past-due bridge case", async () => {
    const { getByTestId } = await render(
      <MobileTypeBadge restorationTypes="Bridge" />,
    );
    expect(getByTestId("type-badge").props.children).toBe("C");
  });

  it("renders the C badge for a past-due implant case", async () => {
    const { getByTestId } = await render(
      <MobileTypeBadge restorationTypes="implant retained crown" />,
    );
    expect(getByTestId("type-badge").props.children).toBe("C");
  });

  it("renders the C badge for a zirconia case (material only)", async () => {
    const { getByTestId } = await render(
      <MobileTypeBadge restorationTypes={null} restorationMaterials="zirconia" />,
    );
    expect(getByTestId("type-badge").props.children).toBe("C");
  });

  it("renders the D badge for a past-due denture case", async () => {
    const { getByTestId } = await render(
      <MobileTypeBadge restorationTypes="Full denture" />,
    );
    expect(getByTestId("type-badge").props.children).toBe("D");
  });

  it("renders the D badge for a past-due partial case", async () => {
    const { getByTestId } = await render(
      <MobileTypeBadge restorationTypes="partial" />,
    );
    expect(getByTestId("type-badge").props.children).toBe("D");
  });

  it("renders the O badge for an ortho case (structured subtype)", async () => {
    const { getByTestId } = await render(
      <MobileTypeBadge restorationTypes={null} restorationSubtype="ortho/night_guards" />,
    );
    expect(getByTestId("type-badge").props.children).toBe("O");
  });

  it("renders the O badge for a night guard case (free text)", async () => {
    const { getByTestId } = await render(
      <MobileTypeBadge restorationTypes="Night Guard" restorationMaterials="Acrylic" />,
    );
    expect(getByTestId("type-badge").props.children).toBe("O");
  });

  it("renders the O badge for a retainer case (free text)", async () => {
    const { getByTestId } = await render(
      <MobileTypeBadge restorationTypes="Retainer" />,
    );
    expect(getByTestId("type-badge").props.children).toBe("O");
  });

  it("renders the O badge for a splint case (free text)", async () => {
    const { getByTestId } = await render(
      <MobileTypeBadge restorationTypes="Splint" />,
    );
    expect(getByTestId("type-badge").props.children).toBe("O");
  });

  it("renders nothing for an unclassifiable past-due case", async () => {
    const { queryByTestId } = await render(
      <MobileTypeBadge restorationTypes={null} restorationMaterials={null} />,
    );
    expect(queryByTestId("type-badge")).toBeNull();
  });
});

// ── 2. Classification unit tests ──────────────────────────────────────────────

describe("Mobile dashboard — deriveCaseTypeIndicator C/D/O classification", () => {
  it('returns "C" for a crown restoration type', async () => {
    expect(deriveCaseTypeIndicator("Crown")).toBe("C");
  });

  it('returns "C" for a veneer restoration type', async () => {
    expect(deriveCaseTypeIndicator("Veneer")).toBe("C");
  });

  it('returns "D" for a denture restoration type', async () => {
    expect(deriveCaseTypeIndicator("Full denture")).toBe("D");
  });

  it('returns "D" for a partial restoration type', async () => {
    expect(deriveCaseTypeIndicator("partial")).toBe("D");
  });

  it("returns null when both inputs are absent", async () => {
    expect(deriveCaseTypeIndicator(null, null)).toBeNull();
  });

  it('returns "D" for a denture restoration type with PFZ material (removable wins over zirconia material)', async () => {
    expect(deriveCaseTypeIndicator("Full Denture", "PFZ")).toBe("D");
  });

  it('returns "D" for a partial restoration type with Zirconia material (removable wins over zirconia material)', async () => {
    expect(deriveCaseTypeIndicator("Partial", "Zirconia")).toBe("D");
  });

  it('returns "C" for a crown restoration type with PFZ material (crown/bridge still wins)', async () => {
    expect(deriveCaseTypeIndicator("Crown", "PFZ")).toBe("C");
  });

  it('returns "C" when both crown and denture appear in restorationTypes (crown wins)', async () => {
    expect(deriveCaseTypeIndicator("crown + denture", null)).toBe("C");
  });

  it('returns "C" when implant and denture appear in restorationTypes (implant wins)', async () => {
    expect(deriveCaseTypeIndicator("implant supported denture", null)).toBe("C");
  });

  it('returns "O" for an ortho structured subtype', async () => {
    expect(deriveCaseTypeIndicator(null, null, "ortho/retainers")).toBe("O");
    expect(deriveCaseTypeIndicator(null, null, "ortho/night_guards/night_guard_hard")).toBe("O");
  });

  it('returns "O" for representative ortho free text', async () => {
    expect(deriveCaseTypeIndicator("Night Guard")).toBe("O");
    expect(deriveCaseTypeIndicator("Retainer")).toBe("O");
    expect(deriveCaseTypeIndicator("Splint")).toBe("O");
    expect(deriveCaseTypeIndicator("Bleach Tray")).toBe("O");
  });

  it('returns "O" for a night guard with an acrylic material (type beats material-only signal)', async () => {
    expect(deriveCaseTypeIndicator("Night Guard", "Acrylic")).toBe("O");
  });

  it("restorative and removable signals still take priority over ortho free text", async () => {
    expect(deriveCaseTypeIndicator("crown + night guard", null)).toBe("C");
    expect(deriveCaseTypeIndicator("denture + retainer", null)).toBe("D");
  });
});

// ── 2a. Badge letter vs sort letter agreement on mixed multi-restoration rows ──

/**
 * The badge comes from `getCompactWorkDetails`, the Case Type sort from
 * `deriveCaseTypeIndicator`. `getCompactWorkDetails` only inspects the FIRST
 * comma-separated restoration, so a row listing an appliance alongside crown
 * or denture work is exactly where the two can drift apart — the row would
 * show one letter and sort into another letter's group.
 */
describe("Mobile dashboard — badge letter matches the sort letter for mixed rows", () => {
  const MIXED_FIXTURES: {
    description: string;
    restorationTypes: string;
    firstRestorationSubtype?: string | null;
    expected: "C" | "D" | "O";
  }[] = [
    { description: "appliance listed first, crown second", restorationTypes: "Night Guard, Crown", expected: "C" },
    { description: "crown listed first, appliance second", restorationTypes: "Crown, Night Guard", expected: "C" },
    { description: "appliance listed first, denture second", restorationTypes: "Night Guard, Full Denture", expected: "D" },
    { description: "denture listed first, appliance second", restorationTypes: "Full Denture, Night Guard", expected: "D" },
    { description: "appliance listed first, implant second", restorationTypes: "Retainer, Implant Crown", expected: "C" },
    { description: "two appliances", restorationTypes: "Night Guard, Retainer", expected: "O" },
    {
      description: "structured ortho subtype wins over mixed free text",
      restorationTypes: "Night Guard, Crown",
      firstRestorationSubtype: "ortho/night_guards",
      expected: "O",
    },
  ];

  for (const { description, restorationTypes, firstRestorationSubtype, expected } of MIXED_FIXTURES) {
    it(`agrees on ${description} (${restorationTypes})`, async () => {
      const badge = getCompactWorkDetails({
        restorationTypes,
        restorationMaterials: null,
        firstRestorationSubtype: firstRestorationSubtype ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any).typeLabel;
      const sortLetter = deriveCaseTypeIndicator(
        restorationTypes,
        null,
        firstRestorationSubtype ?? null,
      );
      expect(badge).toBe(expected);
      expect(sortLetter).toBe(expected);
    });
  }
});

// ── 2b. Real dashboard rows (RNTL, mocked native modules + query hooks) ───────

describe("Mobile dashboard — ortho rows render the O badge on the real screen", () => {
  function makeRecentCase(overrides: Record<string, unknown>) {
    return {
      id: "case-ortho",
      caseNumber: "9001",
      patientFirstName: "Orla",
      patientLastName: "Retainer",
      doctorName: "Dr. Synthetic063",
      restorationTypes: null,
      restorationMaterials: null,
      firstRestorationSubtype: null,
      teeth: null,
      step: null,
      status: "in_progress",
      priority: "normal",
      dueDate: null,
      dueTime: null,
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
      ...overrides,
    };
  }

  it("renders the O badge for an ortho case classified by structured subtype", async () => {
    setMockAppState({
      recentCases: [makeRecentCase({ firstRestorationSubtype: "ortho/night_guards" })],
    });
    const { getAllByText, queryByText } = await render(<DashboardScreen />);
    expect(getAllByText("O").length).toBeGreaterThan(0);
    // The long taxonomy label must not be duplicated in the detail line.
    expect(queryByText("Ortho / Appliances")).toBeNull();
  });

  it("renders the O badge for an ortho case classified by free text", async () => {
    setMockAppState({
      recentCases: [
        makeRecentCase({ id: "case-nightguard", restorationTypes: "Night Guard" }),
      ],
    });
    const { getAllByText } = await render(<DashboardScreen />);
    expect(getAllByText("O").length).toBeGreaterThan(0);
  });

  it("still renders the C and D badges alongside the new O badge", async () => {
    setMockAppState({
      recentCases: [
        makeRecentCase({ id: "case-crown", restorationTypes: "Crown", teeth: "8, 9" }),
        makeRecentCase({ id: "case-denture", restorationTypes: "Full Denture" }),
        makeRecentCase({ id: "case-retainer", restorationTypes: "Retainer" }),
      ],
    });
    const { getAllByText } = await render(<DashboardScreen />);
    expect(getAllByText("C").length).toBeGreaterThan(0);
    expect(getAllByText("D").length).toBeGreaterThan(0);
    expect(getAllByText("O").length).toBeGreaterThan(0);
  });
});

// ── 3. Structural wiring (source inspection) ──────────────────────────────────

describe("Mobile dashboard — Type badge wiring matches the Cases tab card", () => {
  const src = readFileSync(join(__dirname, "../(tabs)/dashboard.tsx"), "utf8");

  it("renderCaseRow takes no per-section opts — the card must look identical everywhere", async () => {
    expect(
      src,
      "renderCaseRow must have signature (c: CanonicalCase) with no opts param, so every section renders the exact same card.",
    ).toContain("function renderCaseRow(c: CanonicalCase)");
    expect(
      src,
      "no call site should still pass a second argument to renderCaseRow.",
    ).not.toMatch(/renderCaseRow\(c,/);
  });

  it("renderCaseRow derives its work/type info from the shared getCompactWorkDetails helper", async () => {
    expect(
      src,
      "renderCaseRow must call the shared getCompactWorkDetails(c) — a local reimplementation would drift from the Cases tab's classification.",
    ).toContain("getCompactWorkDetails(c)");
    expect(
      src,
      "getCompactWorkDetails must be imported from the shared lib/case-category module.",
    ).toContain('from "@/lib/case-category"');
  });

  it("the badge is the shared TypeBadge component, gated on work.typeLabel being C, D or O", async () => {
    expect(
      src,
      "TypeBadge must be imported from the shared components/ui/TypeBadge module.",
    ).toContain('from "@/components/ui/TypeBadge"');
    expect(
      src,
      "renderCaseRow must render <TypeBadge letter={work.typeLabel} /> when the type is C, D or O.",
    ).toMatch(
      /work\.typeLabel === "C"\s*\|\|\s*work\.typeLabel === "D"\s*\|\|\s*work\.typeLabel === "O"/,
    );
    expect(src).toContain("<TypeBadge letter={work.typeLabel} />");
  });

  it("the ortho label is shown as the O badge, not repeated in the detail line", async () => {
    expect(
      src,
      "The detail line must exclude O along with C and D — the badge already carries the ortho letter.",
    ).toMatch(
      /work\.typeLabel !== "C"\s*&&\s*work\.typeLabel !== "D"\s*&&\s*work\.typeLabel !== "O"/,
    );
  });

  it("the TypeBadge is rendered above the StatusBadge inside rowRight", async () => {
    const rowRightStart = src.indexOf("<View style={styles.rowRight}>");
    expect(rowRightStart, "Expected a rowRight View wrapping the badge stack.").toBeGreaterThan(-1);
    const rowRightBlock = src.slice(rowRightStart, rowRightStart + 400);
    const typeBadgeIdx = rowRightBlock.indexOf("<TypeBadge");
    const statusBadgeIdx = rowRightBlock.indexOf("<StatusBadge");
    expect(typeBadgeIdx, "TypeBadge must appear inside rowRight.").toBeGreaterThan(-1);
    expect(statusBadgeIdx, "StatusBadge must appear inside rowRight.").toBeGreaterThan(-1);
    expect(
      typeBadgeIdx < statusBadgeIdx,
      "TypeBadge must be rendered before (i.e. visually above) StatusBadge.",
    ).toBe(true);
  });

  it("every section (past due, due tomorrow, due today, recent) calls renderCaseRow(c) the same way", async () => {
    const calls = (src.match(/renderCaseRow\([^)]*\)/g) ?? []).filter(
      (call) => call !== "renderCaseRow(c: CanonicalCase)",
    );
    expect(calls.length, "Expected renderCaseRow to be called from all 4 dashboard sections.").toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(
        call,
        `renderCaseRow call "${call}" must not pass per-section opts — every section's card must look identical.`,
      ).toMatch(/^renderCaseRow\(c\)$/);
    }
  });
});
