/**
 * Regression guard: existing custom templates must receive newly-introduced
 * built-in elements (such as `gingivialShade` and `step`) when loaded via
 * `coerceCasePrintTemplate`, and the resulting layout must have no overlapping
 * bounding boxes — for both v2 custom templates and v1 legacy templates.
 *
 * The desktop print action always calls `coerceCasePrintTemplate` on the stored
 * template before passing it to `printCaseCardAdvanced`.
 */
import { describe, it, expect } from "vitest";
import {
  coerceCasePrintTemplate,
  DEFAULT_CASE_PRINT_TEMPLATE,
  BUILTIN_ELEMENT_KINDS,
  type CasePrintTemplate,
  type CasePrintElement,
} from "@/lib/case-print-template";

// ── helpers ───────────────────────────────────────────────────────────────

/** Build a minimal v2 template that predates the gingival shade and Step fields. */
function legacyV2Template(): CasePrintTemplate {
  return {
    version: 2,
    elements: DEFAULT_CASE_PRINT_TEMPLATE.elements.filter(
      (el) => el.kind !== "gingivialShade" && el.kind !== "step",
    ).map((element) => ({ ...element })),
  };
}

/**
 * Build a v2 template using the pre-task default positions
 * (what labs had stored before task 3626 was merged).
 */
function priorDefaultV2Template(): CasePrintTemplate {
  const priorElements: CasePrintElement[] = [
    ...DEFAULT_CASE_PRINT_TEMPLATE.elements.filter(
      (el) =>
        !["gingivialShade", "toothChart", "rxNotes", "remakeNotes", "barcode", "implantRetention", "implantManufacturer", "implantPlatformNotes"].includes(
          el.kind,
        ),
    ),
    // Old default positions before gingivialShade was added
    { ...DEFAULT_CASE_PRINT_TEMPLATE.elements.find((e) => e.kind === "toothChart")!, y: 352 },
    { ...DEFAULT_CASE_PRINT_TEMPLATE.elements.find((e) => e.kind === "rxNotes")!, y: 672, h: 220 },
    {
      ...DEFAULT_CASE_PRINT_TEMPLATE.elements.find((e) => e.kind === "remakeNotes")!,
      y: 892,
      h: 100,
    },
    { ...DEFAULT_CASE_PRINT_TEMPLATE.elements.find((e) => e.kind === "barcode")!, y: 912 },
  ];
  return { version: 2, elements: priorElements };
}

/**
 * A minimal v1-format template object (the format labs saved BEFORE the v2
 * editor existed). `migrateV1` converts the `boxes` structure into v2 elements,
 * stacking all four Rx fields vertically inside the rxSummary box.
 * With default LEGACY_DEFAULT_BOXES the shade field ends at y=480, which
 * is where gingivialShade must be placed after backfill.
 */
function v1Template(overrides: Record<string, unknown> = {}) {
  return {
    boxes: {
      header:      { x: 48, y: 48,  w: 720, h: 64,  visible: true },
      caseDetails: { x: 48, y: 132, w: 720, h: 170, visible: true },
      rxSummary:   { x: 48, y: 320, w: 720, h: 160, visible: true },
      toothChart:  { x: 48, y: 500, w: 720, h: 200, visible: true },
      notes:       { x: 48, y: 720, w: 720, h: 200, visible: true },
      barcode:     { x: 48, y: 940, w: 720, h: 70,  visible: true },
      ...overrides,
    },
  };
}

/**
 * Return pairs of visible elements whose bounding boxes overlap both on X and Y.
 * Side-by-side elements (same y, non-overlapping x) are correctly ignored.
 */
function findYOverlaps(
  elements: CasePrintElement[],
): Array<[CasePrintElement, CasePrintElement]> {
  const visible = elements.filter((e) => e.visible);
  const overlaps: Array<[CasePrintElement, CasePrintElement]> = [];
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i]!;
      const b = visible[j]!;
      if ((a.page ?? 1) !== (b.page ?? 1)) continue;
      const xOverlap = a.x < b.x + b.w && b.x < a.x + a.w;
      if (!xOverlap) continue;
      const yOverlap = a.y < b.y + b.h && b.y < a.y + a.h;
      if (yOverlap) overlaps.push([a, b]);
    }
  }
  return overlaps;
}

function overlapDesc([a, b]: [CasePrintElement, CasePrintElement]) {
  return `${a.kind}(y=${a.y},h=${a.h}) ↔ ${b.kind}(y=${b.y},h=${b.h})`;
}

// ── v2 backfill tests ─────────────────────────────────────────────────────

describe("coerceCasePrintTemplate: backward-compatible field backfill (v2)", () => {
  it("caps client templates at the server's 100-element limit", () => {
    const elements = Array.from({ length: 101 }, (_, index) => ({
      id: `provider-preferences-${index}`,
      kind: "providerPreferences" as const,
      x: 10,
      y: 10,
      w: 100,
      h: 40,
      visible: true,
    }));

    expect(
      coerceCasePrintTemplate({ version: 2, elements }).elements,
    ).toHaveLength(100);
  });

  it("preserves opt-in provider preferences without inserting it into other templates", () => {
    const withPreferences = {
      version: 2 as const,
      elements: [
        ...DEFAULT_CASE_PRINT_TEMPLATE.elements,
        {
          id: "provider-preferences-1",
          kind: "providerPreferences" as const,
          x: 418,
          y: 246,
          w: 350,
          h: 80,
          visible: true,
          fontFamily: "Helvetica, Arial, sans-serif",
          fontSize: 10,
          bold: false,
          italic: false,
          align: "left" as const,
        },
      ],
    };

    expect(coerceCasePrintTemplate(withPreferences).elements).toContainEqual(
      expect.objectContaining({ kind: "providerPreferences" }),
    );
    expect(
      coerceCasePrintTemplate(DEFAULT_CASE_PRINT_TEMPLATE).elements.some(
        (element) => element.kind === "providerPreferences",
      ),
    ).toBe(false);
  });

  it("ignores the retired doctorInfo showPreferences option in legacy templates", () => {
    const legacyDoctorInfo = {
      version: 2 as const,
      elements: [
        ...DEFAULT_CASE_PRINT_TEMPLATE.elements,
        {
          id: "doctor-info-1",
          kind: "doctorInfo" as const,
          x: 418,
          y: 166,
          w: 350,
          h: 80,
          visible: true,
          showPreferences: true,
        },
      ],
    };

    const doctorInfo = coerceCasePrintTemplate(legacyDoctorInfo).elements.find(
      (element) => element.id === "doctor-info-1",
    );
    expect(doctorInfo).not.toHaveProperty("showPreferences");
    expect(doctorInfo?.showAddress).toBe(true);
  });

  it("adds gingivialShade and Step to a v2 template that predates the fields", () => {
    const legacy = legacyV2Template();
    expect(legacy.elements.some((e) => e.kind === "gingivialShade")).toBe(false);
    expect(legacy.elements.some((e) => e.kind === "step")).toBe(false);

    const coerced = coerceCasePrintTemplate(legacy);
    expect(coerced.elements.some((e) => e.kind === "gingivialShade")).toBe(true);
    expect(coerced.elements.some((e) => e.kind === "step")).toBe(true);
  });

  it("retains existing custom positions for non-sequential elements", () => {
    const legacy = legacyV2Template();
    const customIdx = legacy.elements.findIndex((e) => e.kind === "caseNumber");
    (legacy.elements[customIdx] as CasePrintElement & { x: number }).x = 100;

    const coerced = coerceCasePrintTemplate(legacy);
    const caseNumberEl = coerced.elements.find((e) => e.kind === "caseNumber");
    expect((caseNumberEl as CasePrintElement & { x: number }).x).toBe(100);
  });

  it("produces all BUILTIN_ELEMENT_KINDS after coercing a stripped v2 template", () => {
    const bare: CasePrintTemplate = { version: 2, elements: [] };
    const coerced = coerceCasePrintTemplate(bare);
    const kinds = coerced.elements.map((e) => e.kind);
    for (const kind of BUILTIN_ELEMENT_KINDS) {
      expect(kinds).toContain(kind);
    }
  });

  it("backfilled gingivialShade element has visible:true by default", () => {
    const coerced = coerceCasePrintTemplate(legacyV2Template());
    const el = coerced.elements.find((e) => e.kind === "gingivialShade");
    expect(el?.visible).toBe(true);
  });

  it("backfilled Step element has visible:true by default", () => {
    const coerced = coerceCasePrintTemplate(legacyV2Template());
    const el = coerced.elements.find((e) => e.kind === "step");
    expect(el?.visible).toBe(true);
  });

  it("does not migrate toothChart when user placed it at a custom position", () => {
    const legacy = legacyV2Template();
    const tcIdx = legacy.elements.findIndex((e) => e.kind === "toothChart");
    (legacy.elements[tcIdx] as any).y = 450;

    const coerced = coerceCasePrintTemplate(legacy);
    const tc = coerced.elements.find((e) => e.kind === "toothChart");
    expect(tc?.y).toBe(450);
  });

  it("preserves a complete v2 layout when Rx Notes is above later fields", () => {
    const customRxNotes = {
      ...DEFAULT_CASE_PRINT_TEMPLATE.elements.find((e) => e.kind === "rxNotes")!,
      x: 418,
      y: 290,
      w: 300,
      h: 96,
    };
    const complete = {
      version: 2 as const,
      elements: DEFAULT_CASE_PRINT_TEMPLATE.elements.map((element) =>
        element.kind === "rxNotes" ? customRxNotes : { ...element },
      ),
    };

    const reopened = coerceCasePrintTemplate(complete);
    // The case Print action applies the same coercion to the cached template.
    const nextPrintTemplate = coerceCasePrintTemplate(reopened);
    const rxNotes = nextPrintTemplate.elements.find((e) => e.kind === "rxNotes");

    expect(rxNotes).toMatchObject({
      x: 418,
      y: 290,
      w: 300,
      h: 96,
    });
  });
});

// ── no-overlap tests (v2) ─────────────────────────────────────────────────

describe("coerceCasePrintTemplate: no bounding-box overlaps after backfill (v2)", () => {
  it("default template has no overlapping visible elements", () => {
    const coerced = coerceCasePrintTemplate(DEFAULT_CASE_PRINT_TEMPLATE);
    const overlaps = findYOverlaps(coerced.elements);
    expect(overlaps.map(overlapDesc)).toEqual([]);
  });

  it("prior-default v2 template has no overlapping visible elements after coercion", () => {
    const coerced = coerceCasePrintTemplate(priorDefaultV2Template());
    const overlaps = findYOverlaps(coerced.elements);
    expect(overlaps.map(overlapDesc)).toEqual([]);
  });

  it("migrates toothChart from prior y=352 to y=380", () => {
    const coerced = coerceCasePrintTemplate(priorDefaultV2Template());
    const tc = coerced.elements.find((e) => e.kind === "toothChart");
    expect(tc?.y).toBe(380);
  });

  it("migrates barcode from prior y=912 to y=940", () => {
    const coerced = coerceCasePrintTemplate(priorDefaultV2Template());
    const bc = coerced.elements.find((e) => e.kind === "barcode");
    expect(bc?.y).toBe(940);
  });

  it("gingivialShade bottom edge does not exceed toothChart top (v2 prior defaults)", () => {
    const coerced = coerceCasePrintTemplate(priorDefaultV2Template());
    const gs = coerced.elements.find((e) => e.kind === "gingivialShade")!;
    const tc = coerced.elements.find((e) => e.kind === "toothChart")!;
    expect(gs.y + gs.h).toBeLessThanOrEqual(tc.y);
  });
});

// ── v1 template tests ─────────────────────────────────────────────────────

describe("coerceCasePrintTemplate: v1 legacy template — no overlaps after backfill", () => {
  it("coerces a v1 template successfully (returns a v2 template)", () => {
    const coerced = coerceCasePrintTemplate(v1Template());
    expect(coerced.version).toBe(2);
    expect(coerced.elements.length).toBeGreaterThan(0);
  });

  it("backfills gingivialShade into a v1-migrated template", () => {
    const coerced = coerceCasePrintTemplate(v1Template());
    expect(coerced.elements.some((e) => e.kind === "gingivialShade")).toBe(true);
  });

  it("v1 template has no overlapping visible elements after coercion", () => {
    const coerced = coerceCasePrintTemplate(v1Template());
    const overlaps = findYOverlaps(coerced.elements);
    expect(overlaps.map(overlapDesc)).toEqual([]);
  });

  it("gingivialShade is placed at or after the v1 shade row bottom (y=480)", () => {
    // v1 rxSummary: y=320 h=160, 4 fields stacked → each h=40 → shade at y=440 h=40 → bottom=480
    const coerced = coerceCasePrintTemplate(v1Template());
    const gs = coerced.elements.find((e) => e.kind === "gingivialShade")!;
    expect(gs.y).toBeGreaterThanOrEqual(480);
  });

  it("gingivialShade bottom edge does not exceed toothChart top (v1)", () => {
    const coerced = coerceCasePrintTemplate(v1Template());
    const gs = coerced.elements.find((e) => e.kind === "gingivialShade")!;
    const tc = coerced.elements.find((e) => e.kind === "toothChart")!;
    expect(gs.y + gs.h).toBeLessThanOrEqual(tc.y);
  });

  it("barcode stays within page height after cascade", () => {
    const PAGE_H = 1056; // letter-size at 96 DPI
    const coerced = coerceCasePrintTemplate(v1Template());
    const bc = coerced.elements.find((e) => e.kind === "barcode")!;
    expect(bc.y + bc.h).toBeLessThanOrEqual(PAGE_H);
  });

  it("all BUILTIN_ELEMENT_KINDS are present after v1 coercion", () => {
    const coerced = coerceCasePrintTemplate(v1Template());
    const kinds = coerced.elements.map((e) => e.kind);
    for (const kind of BUILTIN_ELEMENT_KINDS) {
      expect(kinds).toContain(kind);
    }
  });
});
