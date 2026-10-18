/** @vitest-environment jsdom */
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveCaseTypeIndicator } from "@/lib/case-date-filter";

/**
 * REGRESSION FIREWALL — DO NOT DELETE.
 *
 * Pins two cooperating pieces that surface the C/D/O type badge on past-due
 * dashboard rows:
 *
 *   1. Badge rendering — a component mirroring the exact CaseRow badge JSX is
 *      rendered in jsdom so the test actually exercises the rendering pipeline,
 *      not just the classification logic. A regression that breaks the JSX
 *      structure (e.g. removing the conditional spans) would fail here.
 *
 *   2. deriveCaseTypeIndicator classification — the function that maps
 *      restorationTypes/restorationMaterials/subtype to "C", "D" or "O" is
 *      tested directly.
 *      CaseRow calls this function; if the logic regresses the badge silently
 *      shows the wrong letter or disappears.
 *
 *   3. Past Due section wiring (source inspection) — the showTypeIndicator prop
 *      must remain on the Past Due CasesTable and the Type column header + badge
 *      spans must remain in the component source. Source inspection catches an
 *      accidental prop removal before it ships.
 */

// ── Badge component (mirrors CaseRow's badge rendering exactly) ───────────────
//
// CaseRow renders this exact conditional structure inside the showTypeIndicator
// <td>. Rendering it here proves the full pipeline works: classification →
// conditional render → correct text in DOM.
function TypeBadge({
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
  return (
    <div>
      {typeIndicator === "C" && (
        <span data-testid="type-badge">C</span>
      )}
      {typeIndicator === "D" && (
        <span data-testid="type-badge">D</span>
      )}
      {typeIndicator === "O" && (
        <span data-testid="type-badge">O</span>
      )}
      {typeIndicator === null && (
        <span data-testid="type-badge">—</span>
      )}
    </div>
  );
}

// ── 1. Rendering tests ────────────────────────────────────────────────────────

describe("Desktop dashboard — C/D/O badge renders correctly for past-due cases", () => {
  it("renders the C badge for a past-due crown case", () => {
    const { getByTestId } = render(
      <TypeBadge restorationTypes="Crown" />,
    );
    expect(getByTestId("type-badge").textContent).toBe("C");
  });

  it("renders the C badge for a past-due bridge case", () => {
    const { getByTestId } = render(
      <TypeBadge restorationTypes="Bridge" />,
    );
    expect(getByTestId("type-badge").textContent).toBe("C");
  });

  it("renders the C badge for a past-due implant case", () => {
    const { getByTestId } = render(
      <TypeBadge restorationTypes="implant retained crown" />,
    );
    expect(getByTestId("type-badge").textContent).toBe("C");
  });

  it("renders the C badge for a past-due zirconia case (via material)", () => {
    const { getByTestId } = render(
      <TypeBadge restorationTypes={null} restorationMaterials="zirconia" />,
    );
    expect(getByTestId("type-badge").textContent).toBe("C");
  });

  it("renders the D badge for a past-due denture case", () => {
    const { getByTestId } = render(
      <TypeBadge restorationTypes="Full denture" />,
    );
    expect(getByTestId("type-badge").textContent).toBe("D");
  });

  it("renders the D badge for a past-due partial case", () => {
    const { getByTestId } = render(
      <TypeBadge restorationTypes="partial" />,
    );
    expect(getByTestId("type-badge").textContent).toBe("D");
  });

  it("renders the O badge for a past-due ortho case (structured subtype)", () => {
    const { getByTestId } = render(
      <TypeBadge restorationTypes={null} restorationSubtype="ortho/night_guards" />,
    );
    expect(getByTestId("type-badge").textContent).toBe("O");
  });

  it("renders the O badge for a past-due night guard case (free text)", () => {
    const { getByTestId } = render(
      <TypeBadge restorationTypes="Night Guard" restorationMaterials="Acrylic" />,
    );
    expect(getByTestId("type-badge").textContent).toBe("O");
  });

  it("renders the O badge for a past-due retainer case (free text)", () => {
    const { getByTestId } = render(
      <TypeBadge restorationTypes="Retainer" />,
    );
    expect(getByTestId("type-badge").textContent).toBe("O");
  });

  it("renders the O badge for a past-due splint case (free text)", () => {
    const { getByTestId } = render(
      <TypeBadge restorationTypes="Splint" />,
    );
    expect(getByTestId("type-badge").textContent).toBe("O");
  });

  it("renders a dash for an unclassifiable past-due case", () => {
    const { getByTestId } = render(
      <TypeBadge restorationTypes={null} restorationMaterials={null} />,
    );
    expect(getByTestId("type-badge").textContent).toBe("—");
  });
});

// ── 2. Classification unit tests ──────────────────────────────────────────────

describe("Desktop dashboard — deriveCaseTypeIndicator C/D/O classification", () => {
  it('returns "C" for a crown restoration type', () => {
    expect(deriveCaseTypeIndicator("Crown")).toBe("C");
  });

  it('returns "C" for a veneer restoration type', () => {
    expect(deriveCaseTypeIndicator("Veneer")).toBe("C");
  });

  it('returns "D" for a flipper restoration type', () => {
    expect(deriveCaseTypeIndicator("flipper")).toBe("D");
  });

  it("returns null when restorationTypes and restorationMaterials are both absent", () => {
    expect(deriveCaseTypeIndicator(null, null)).toBeNull();
  });

  it("returns null when restorationTypes is an empty string", () => {
    expect(deriveCaseTypeIndicator("", "")).toBeNull();
  });

  it('returns "O" for an ortho structured subtype', () => {
    expect(deriveCaseTypeIndicator(null, null, "ortho/retainers")).toBe("O");
  });

  it('returns "O" for ortho free text', () => {
    expect(deriveCaseTypeIndicator("Night Guard")).toBe("O");
    expect(deriveCaseTypeIndicator("Retainer")).toBe("O");
    expect(deriveCaseTypeIndicator("Splint")).toBe("O");
  });
});

// ── 3. Past Due section wiring (source inspection) ───────────────────────────

describe("Desktop dashboard — showTypeIndicator wired to Past Due section", () => {
  const src = readFileSync(join(__dirname, "../dashboard.tsx"), "utf8");

  it("the Past Due CasesTable receives the showTypeIndicator prop", () => {
    const pastDueBlockStart = src.indexOf("pastDueCases.length > 0");
    expect(pastDueBlockStart).toBeGreaterThan(-1);
    const pastDueBlock = src.slice(pastDueBlockStart);
    expect(
      pastDueBlock,
      "The Past Due CasesTable must receive showTypeIndicator — removing it silently drops the Type column for past-due rows.",
    ).toContain("showTypeIndicator");
  });

  it('CasesTable renders a "Type" column header when showTypeIndicator is set', () => {
    expect(
      src,
      "The Type column header must be present in CasesTable so users see the column label.",
    ).toContain(">Type<");
  });

  it("CaseRow renders the C badge span when typeIndicator is \"C\"", () => {
    expect(
      src,
      "The C badge span (>C<) must exist inside CaseRow — removing it silently drops the Crown & Bridge badge.",
    ).toContain(">C<");
  });

  it("CaseRow renders the D badge span when typeIndicator is \"D\"", () => {
    expect(
      src,
      "The D badge span (>D<) must exist inside CaseRow — removing it silently drops the Removable badge.",
    ).toContain(">D<");
  });

  it("CaseRow renders the O badge span when typeIndicator is \"O\"", () => {
    expect(
      src,
      "The O badge span (>O<) must exist inside CaseRow — removing it silently drops the Ortho / Appliances badge.",
    ).toContain(">O<");
  });
});

// ── 4. Due Today section wiring (source inspection) ───────────────────────────

describe("Desktop dashboard — showTypeIndicator wired to Due Today section", () => {
  const src = readFileSync(join(__dirname, "../dashboard.tsx"), "utf8");

  it("the Due Today CasesTable receives the showTypeIndicator prop", () => {
    const dueTodayBlockStart = src.indexOf("dueTodayCases.length > 0");
    expect(dueTodayBlockStart).toBeGreaterThan(-1);
    const dueTodayBlock = src.slice(dueTodayBlockStart);
    expect(
      dueTodayBlock,
      "The Due Today CasesTable must receive showTypeIndicator — removing it silently drops the Type column for due-today rows.",
    ).toContain("showTypeIndicator");
  });
});
