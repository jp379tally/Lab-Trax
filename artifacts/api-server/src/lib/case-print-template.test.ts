import { describe, it, expect } from "vitest";
import {
  coerceCasePrintTemplate,
  DEFAULT_CASE_PRINT_TEMPLATE,
  casePrintTemplateSchema,
  PAGE_W,
  PAGE_H,
} from "./case-print-template.js";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Minimal valid v1 template with all section boxes present. */
function makeV1(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    boxes: {
      header:      { x: 48,  y: 48,  w: 720, h: 64,  visible: true },
      caseDetails: { x: 48,  y: 132, w: 720, h: 170, visible: true },
      rxSummary:   { x: 48,  y: 320, w: 720, h: 160, visible: true },
      toothChart:  { x: 48,  y: 500, w: 720, h: 200, visible: true },
      notes:       { x: 48,  y: 720, w: 720, h: 200, visible: true },
      barcode:     { x: 48,  y: 940, w: 720, h: 70,  visible: true },
    },
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// coerceCasePrintTemplate — null / malformed input → DEFAULT
// ────────────────────────────────────────────────────────────────────────────

describe("coerceCasePrintTemplate — null / malformed → DEFAULT", () => {
  it("returns DEFAULT for null", () => {
    expect(coerceCasePrintTemplate(null)).toEqual(DEFAULT_CASE_PRINT_TEMPLATE);
  });

  it("returns DEFAULT for undefined", () => {
    expect(coerceCasePrintTemplate(undefined)).toEqual(DEFAULT_CASE_PRINT_TEMPLATE);
  });

  it("returns DEFAULT for an empty object", () => {
    expect(coerceCasePrintTemplate({})).toEqual(DEFAULT_CASE_PRINT_TEMPLATE);
  });

  it("returns DEFAULT for a plain string", () => {
    expect(coerceCasePrintTemplate("not a template")).toEqual(DEFAULT_CASE_PRINT_TEMPLATE);
  });

  it("returns DEFAULT for a number", () => {
    expect(coerceCasePrintTemplate(42)).toEqual(DEFAULT_CASE_PRINT_TEMPLATE);
  });

  it("returns DEFAULT for a v2-shaped object that fails schema (wrong version)", () => {
    expect(
      coerceCasePrintTemplate({ version: 1, elements: [] }),
    ).toEqual(DEFAULT_CASE_PRINT_TEMPLATE);
  });

  it("returns DEFAULT for an object with version 2 but elements is not an array", () => {
    expect(
      coerceCasePrintTemplate({ version: 2, elements: "bad" }),
    ).toEqual(DEFAULT_CASE_PRINT_TEMPLATE);
  });

  it("returns DEFAULT for a v1-shaped object with no recognizable section boxes", () => {
    expect(
      coerceCasePrintTemplate({ boxes: { unknownSection: { x: 0, y: 0, w: 100, h: 100 } } }),
    ).toEqual(DEFAULT_CASE_PRINT_TEMPLATE);
  });

  it("returns DEFAULT for a v1 object missing the boxes key entirely", () => {
    expect(
      coerceCasePrintTemplate({ fieldSizes: { caseDetails: { patient: "normal" } } }),
    ).toEqual(DEFAULT_CASE_PRINT_TEMPLATE);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// coerceCasePrintTemplate — v2 round-trip
// ────────────────────────────────────────────────────────────────────────────

describe("coerceCasePrintTemplate — v2 round-trip", () => {
  it("round-trips the DEFAULT template unchanged through parse+coerce", () => {
    const json = JSON.parse(JSON.stringify(DEFAULT_CASE_PRINT_TEMPLATE));
    expect(coerceCasePrintTemplate(json)).toEqual(DEFAULT_CASE_PRINT_TEMPLATE);
  });

  it("round-trips a modified v2 template unchanged through casePrintTemplateSchema", () => {
    const template = JSON.parse(JSON.stringify(DEFAULT_CASE_PRINT_TEMPLATE));
    // mutate a few fields to verify they survive the round-trip
    template.elements[0].fontSize = 30;
    template.elements[0].bold = false;
    template.elements[0].align = "center";

    const parsed = casePrintTemplateSchema.safeParse(template);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe(2);
      expect(parsed.data.elements[0].fontSize).toBe(30);
      expect(parsed.data.elements[0].bold).toBe(false);
      expect(parsed.data.elements[0].align).toBe("center");
    }
  });

  it("round-trips a v2 template with an image element unchanged", () => {
    const template = {
      version: 2 as const,
      elements: [
        ...DEFAULT_CASE_PRINT_TEMPLATE.elements,
        {
          id: "img-1",
          kind: "image" as const,
          x: 60,
          y: 60,
          w: 120,
          h: 60,
          visible: true,
          storageKey: "bucket/path/logo.png",
          url: "https://cdn.example.com/logo.png",
          opacity: 0.8,
        },
      ],
    };

    const result = coerceCasePrintTemplate(template);
    expect(result.version).toBe(2);
    const imgEl = result.elements.find((e) => e.kind === "image");
    expect(imgEl).toBeDefined();
    expect(imgEl?.id).toBe("img-1");
    expect(imgEl?.storageKey).toBe("bucket/path/logo.png");
    expect(imgEl?.opacity).toBe(0.8);
  });

  it("casePrintTemplateSchema rejects version !== 2", () => {
    const bad = { version: 1, elements: [] };
    expect(casePrintTemplateSchema.safeParse(bad).success).toBe(false);
  });

  it("casePrintTemplateSchema rejects elements exceeding 40 items", () => {
    const tooMany = {
      version: 2,
      elements: Array.from({ length: 41 }, (_, i) => ({
        id: `el-${i}`,
        kind: "caseNumber",
        x: 0,
        y: 0,
        w: 100,
        h: 40,
        visible: true,
      })),
    };
    expect(casePrintTemplateSchema.safeParse(tooMany).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// migrateV1 — via coerceCasePrintTemplate
// ────────────────────────────────────────────────────────────────────────────

describe("v1 → v2 migration via coerceCasePrintTemplate", () => {
  it("produces a v2 template from a minimal v1 object", () => {
    const result = coerceCasePrintTemplate(makeV1());
    expect(result.version).toBe(2);
    expect(Array.isArray(result.elements)).toBe(true);
  });

  // header → caseNumber -------------------------------------------------------

  it("maps the header box to a caseNumber element with fontSize 26 and bold", () => {
    const result = coerceCasePrintTemplate(makeV1());
    const el = result.elements.find((e) => e.kind === "caseNumber");
    expect(el).toBeDefined();
    expect(el?.x).toBe(48);
    expect(el?.y).toBe(48);
    expect(el?.w).toBe(720);
    expect(el?.h).toBe(64);
    expect(el?.fontSize).toBe(26);
    expect(el?.bold).toBe(true);
    expect(el?.visible).toBe(true);
  });

  it("preserves header visibility = false on the caseNumber element", () => {
    const v1 = makeV1();
    (v1.boxes as Record<string, unknown>).header = {
      x: 48, y: 48, w: 720, h: 64, visible: false,
    };
    const result = coerceCasePrintTemplate(v1);
    const el = result.elements.find((e) => e.kind === "caseNumber");
    expect(el?.visible).toBe(false);
  });

  // caseDetails → patient / doctor / dueDate / priority -----------------------

  it("splits caseDetails into patient, doctor, dueDate, priority elements", () => {
    const result = coerceCasePrintTemplate(makeV1());
    const kinds = result.elements.map((e) => e.kind);
    expect(kinds).toContain("patient");
    expect(kinds).toContain("doctor");
    expect(kinds).toContain("dueDate");
    expect(kinds).toContain("priority");
  });

  it("does NOT produce status or created elements (dropped by migration)", () => {
    const result = coerceCasePrintTemplate(makeV1());
    const kinds = result.elements.map((e) => e.kind);
    expect(kinds).not.toContain("status");
    expect(kinds).not.toContain("created");
  });

  it("stacks caseDetails children vertically within the box", () => {
    const v1 = makeV1();
    const cdBox = { x: 50, y: 200, w: 700, h: 200, visible: true };
    (v1.boxes as Record<string, unknown>).caseDetails = cdBox;
    const result = coerceCasePrintTemplate(v1);

    const patient  = result.elements.find((e) => e.kind === "patient");
    const doctor   = result.elements.find((e) => e.kind === "doctor");
    const dueDate  = result.elements.find((e) => e.kind === "dueDate");
    const priority = result.elements.find((e) => e.kind === "priority");

    expect(patient).toBeDefined();
    expect(doctor).toBeDefined();
    // Each stacked element should have x = the box x
    expect(patient?.x).toBe(50);
    expect(doctor?.x).toBe(50);
    // y values must be strictly increasing (stacked downward)
    expect(doctor!.y).toBeGreaterThan(patient!.y);
    expect(dueDate!.y).toBeGreaterThan(doctor!.y);
    expect(priority!.y).toBeGreaterThan(dueDate!.y);
    // width must equal box width
    expect(patient?.w).toBe(700);
  });

  it("propagates caseDetails visibility = false to all its children", () => {
    const v1 = makeV1();
    (v1.boxes as Record<string, unknown>).caseDetails = {
      x: 48, y: 132, w: 720, h: 170, visible: false,
    };
    const result = coerceCasePrintTemplate(v1);
    for (const kind of ["patient", "doctor", "dueDate", "priority"]) {
      const el = result.elements.find((e) => e.kind === kind);
      expect(el?.visible).toBe(false);
    }
  });

  // rxSummary → restorativeType / teeth / material / shade --------------------

  it("splits rxSummary into restorativeType, teeth, material, shade elements", () => {
    const result = coerceCasePrintTemplate(makeV1());
    const kinds = result.elements.map((e) => e.kind);
    expect(kinds).toContain("restorativeType");
    expect(kinds).toContain("teeth");
    expect(kinds).toContain("material");
    expect(kinds).toContain("shade");
  });

  it("propagates rxSummary visibility = false to its children", () => {
    const v1 = makeV1();
    (v1.boxes as Record<string, unknown>).rxSummary = {
      x: 48, y: 320, w: 720, h: 160, visible: false,
    };
    const result = coerceCasePrintTemplate(v1);
    for (const kind of ["restorativeType", "teeth", "material", "shade"]) {
      const el = result.elements.find((e) => e.kind === kind);
      expect(el?.visible).toBe(false);
    }
  });

  // fieldSizes → fontSize mapping ---------------------------------------------

  it("maps fieldSizes 'large' to fontSize 16 on caseDetails fields", () => {
    const v1 = makeV1({
      fieldSizes: {
        caseDetails: { patient: "large", doctor: "large", dueDate: "normal", priority: "xl" },
      },
    });
    const result = coerceCasePrintTemplate(v1);
    expect(result.elements.find((e) => e.kind === "patient")?.fontSize).toBe(16);
    expect(result.elements.find((e) => e.kind === "doctor")?.fontSize).toBe(16);
    expect(result.elements.find((e) => e.kind === "dueDate")?.fontSize).toBe(13);
    expect(result.elements.find((e) => e.kind === "priority")?.fontSize).toBe(20);
  });

  it("maps fieldSizes 'xl' to fontSize 20 on rxSummary fields", () => {
    const v1 = makeV1({
      fieldSizes: {
        rxSummary: { restorativeType: "xl", teeth: "normal", material: "large", shade: "xl" },
      },
    });
    const result = coerceCasePrintTemplate(v1);
    expect(result.elements.find((e) => e.kind === "restorativeType")?.fontSize).toBe(20);
    expect(result.elements.find((e) => e.kind === "teeth")?.fontSize).toBe(13);
    expect(result.elements.find((e) => e.kind === "material")?.fontSize).toBe(16);
    expect(result.elements.find((e) => e.kind === "shade")?.fontSize).toBe(20);
  });

  it("defaults fontSize to 13 when fieldSizes is absent", () => {
    const result = coerceCasePrintTemplate(makeV1()); // no fieldSizes
    for (const kind of ["patient", "doctor", "dueDate", "priority",
                        "restorativeType", "teeth", "material", "shade"]) {
      expect(result.elements.find((e) => e.kind === kind)?.fontSize).toBe(13);
    }
  });

  it("defaults fontSize to 13 for an unrecognized fieldSize string", () => {
    const v1 = makeV1({
      fieldSizes: { caseDetails: { patient: "huge" } }, // not a valid v1 size
    });
    const result = coerceCasePrintTemplate(v1);
    expect(result.elements.find((e) => e.kind === "patient")?.fontSize).toBe(13);
  });

  // notes → rxNotes -----------------------------------------------------------

  it("maps the notes box to an rxNotes element with fontSize 12", () => {
    const result = coerceCasePrintTemplate(makeV1());
    const el = result.elements.find((e) => e.kind === "rxNotes");
    expect(el).toBeDefined();
    expect(el?.x).toBe(48);
    expect(el?.y).toBe(720);
    expect(el?.w).toBe(720);
    expect(el?.h).toBe(200);
    expect(el?.fontSize).toBe(12);
    expect(el?.bold).toBe(false);
  });

  it("preserves notes visibility = false on rxNotes element", () => {
    const v1 = makeV1();
    (v1.boxes as Record<string, unknown>).notes = {
      x: 48, y: 720, w: 720, h: 200, visible: false,
    };
    const result = coerceCasePrintTemplate(v1);
    expect(result.elements.find((e) => e.kind === "rxNotes")?.visible).toBe(false);
  });

  // toothChart / barcode ──────────────────────────────────────────────────────

  it("maps the toothChart box to a toothChart element", () => {
    const result = coerceCasePrintTemplate(makeV1());
    const el = result.elements.find((e) => e.kind === "toothChart");
    expect(el).toBeDefined();
    expect(el?.x).toBe(48);
    expect(el?.y).toBe(500);
    expect(el?.w).toBe(720);
    expect(el?.h).toBe(200);
    // graphic elements carry no typography
    expect(el?.fontSize).toBeUndefined();
  });

  it("maps the barcode box to a barcode element", () => {
    const result = coerceCasePrintTemplate(makeV1());
    const el = result.elements.find((e) => e.kind === "barcode");
    expect(el).toBeDefined();
    expect(el?.x).toBe(48);
    expect(el?.y).toBe(940);
    expect(el?.w).toBe(720);
    expect(el?.h).toBe(70);
  });

  it("propagates toothChart visibility = false", () => {
    const v1 = makeV1();
    (v1.boxes as Record<string, unknown>).toothChart = {
      x: 48, y: 500, w: 720, h: 200, visible: false,
    };
    const result = coerceCasePrintTemplate(v1);
    expect(result.elements.find((e) => e.kind === "toothChart")?.visible).toBe(false);
  });

  // custom box coordinates are preserved ──────────────────────────────────────

  it("preserves custom box coordinates in migrated elements", () => {
    const v1 = makeV1();
    (v1.boxes as Record<string, unknown>).header = {
      x: 100, y: 80, w: 600, h: 50, visible: true,
    };
    const result = coerceCasePrintTemplate(v1);
    const el = result.elements.find((e) => e.kind === "caseNumber");
    expect(el?.x).toBe(100);
    expect(el?.y).toBe(80);
    expect(el?.w).toBe(600);
    expect(el?.h).toBe(50);
  });

  it("clamps out-of-range box coordinates to valid page bounds", () => {
    const v1 = makeV1();
    (v1.boxes as Record<string, unknown>).header = {
      x: -10,  // < 0  → 0
      y: PAGE_H + 100, // > PAGE_H → clamped
      w: PAGE_W + 50,  // > PAGE_W → clamped
      h: PAGE_H + 50,
      visible: true,
    };
    const result = coerceCasePrintTemplate(v1);
    const el = result.elements.find((e) => e.kind === "caseNumber");
    expect(el?.x).toBeGreaterThanOrEqual(0);
    expect(el?.y).toBeLessThanOrEqual(PAGE_H);
    expect(el?.w).toBeLessThanOrEqual(PAGE_W);
  });

  // missing boxes fall back to legacy defaults ─────────────────────────────────

  it("falls back to legacy defaults for any missing box (partial v1 template)", () => {
    const partial = {
      boxes: {
        // only caseDetails present; all others missing
        caseDetails: { x: 10, y: 200, w: 600, h: 100, visible: true },
      },
    };
    const result = coerceCasePrintTemplate(partial);
    expect(result.version).toBe(2);
    // header fallback → caseNumber should still appear
    const el = result.elements.find((e) => e.kind === "caseNumber");
    expect(el).toBeDefined();
    expect(el?.x).toBe(48); // legacy default
  });

  // extraImages → image elements ──────────────────────────────────────────────

  it("converts extraImages entries to image elements", () => {
    const v1 = makeV1({
      extraImages: [
        {
          id: "img-logo",
          url: "https://cdn.example.com/logo.png",
          storageKey: "labs/1/logo.png",
          x: 60,
          y: 80,
          w: 150,
          h: 80,
          opacity: 0.9,
        },
      ],
    });
    const result = coerceCasePrintTemplate(v1);
    const imgEl = result.elements.find((e) => e.kind === "image");
    expect(imgEl).toBeDefined();
    expect(imgEl?.id).toBe("img-logo");
    expect(imgEl?.storageKey).toBe("labs/1/logo.png");
    expect(imgEl?.url).toBe("https://cdn.example.com/logo.png");
    expect(imgEl?.x).toBe(60);
    expect(imgEl?.y).toBe(80);
    expect(imgEl?.w).toBe(150);
    expect(imgEl?.h).toBe(80);
    expect(imgEl?.opacity).toBe(0.9);
  });

  it("converts multiple extraImages entries in order", () => {
    const v1 = makeV1({
      extraImages: [
        { id: "a", url: "https://cdn.example.com/a.png", storageKey: "a.png", x: 10, y: 10, w: 100, h: 50 },
        { id: "b", url: "https://cdn.example.com/b.png", storageKey: "b.png", x: 20, y: 20, w: 100, h: 50 },
      ],
    });
    const result = coerceCasePrintTemplate(v1);
    const imgEls = result.elements.filter((e) => e.kind === "image");
    expect(imgEls).toHaveLength(2);
    expect(imgEls[0].id).toBe("a");
    expect(imgEls[1].id).toBe("b");
  });

  it("skips extraImages entries missing id, url, or storageKey", () => {
    const v1 = makeV1({
      extraImages: [
        { id: "ok", url: "https://cdn.example.com/ok.png", storageKey: "ok.png", x: 10, y: 10, w: 100, h: 50 },
        { id: "no-url",    storageKey: "x.png",  x: 10, y: 10, w: 100, h: 50 },  // missing url
        { id: "no-key",    url: "https://cdn.example.com/x.png",         x: 10, y: 10, w: 100, h: 50 },  // missing storageKey
        { url: "https://cdn.example.com/x.png", storageKey: "x.png",     x: 10, y: 10, w: 100, h: 50 },  // missing id
        null,
        42,
      ],
    });
    const result = coerceCasePrintTemplate(v1);
    const imgEls = result.elements.filter((e) => e.kind === "image");
    expect(imgEls).toHaveLength(1);
    expect(imgEls[0].id).toBe("ok");
  });

  it("caps extraImages at 8 entries", () => {
    const manyImages = Array.from({ length: 12 }, (_, i) => ({
      id: `img-${i}`,
      url: `https://cdn.example.com/img-${i}.png`,
      storageKey: `img-${i}.png`,
      x: 10, y: 10, w: 100, h: 50,
    }));
    const v1 = makeV1({ extraImages: manyImages });
    const result = coerceCasePrintTemplate(v1);
    const imgEls = result.elements.filter((e) => e.kind === "image");
    expect(imgEls.length).toBeLessThanOrEqual(8);
  });

  it("handles extraImages = [] gracefully (no image elements)", () => {
    const v1 = makeV1({ extraImages: [] });
    const result = coerceCasePrintTemplate(v1);
    const imgEls = result.elements.filter((e) => e.kind === "image");
    expect(imgEls).toHaveLength(0);
  });

  it("handles extraImages absent entirely (no image elements)", () => {
    const result = coerceCasePrintTemplate(makeV1()); // no extraImages key
    const imgEls = result.elements.filter((e) => e.kind === "image");
    expect(imgEls).toHaveLength(0);
  });

  // migrated output passes the v2 schema ──────────────────────────────────────

  it("migrated v1 output passes casePrintTemplateSchema validation", () => {
    const v1 = makeV1({
      fieldSizes: {
        caseDetails: { patient: "large", doctor: "normal", dueDate: "xl", priority: "normal" },
        rxSummary: { restorativeType: "normal", teeth: "large", material: "normal", shade: "xl" },
      },
      extraImages: [
        {
          id: "logo",
          url: "https://cdn.example.com/logo.png",
          storageKey: "logo.png",
          x: 60, y: 60, w: 120, h: 60, opacity: 1,
        },
      ],
    });
    const migrated = coerceCasePrintTemplate(v1);
    const parsed = casePrintTemplateSchema.safeParse(migrated);
    expect(parsed.success).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// DEFAULT_CASE_PRINT_TEMPLATE integrity
// ────────────────────────────────────────────────────────────────────────────

describe("DEFAULT_CASE_PRINT_TEMPLATE integrity", () => {
  it("has version 2", () => {
    expect(DEFAULT_CASE_PRINT_TEMPLATE.version).toBe(2);
  });

  it("passes casePrintTemplateSchema validation", () => {
    expect(casePrintTemplateSchema.safeParse(DEFAULT_CASE_PRINT_TEMPLATE).success).toBe(true);
  });

  it("contains all 12 expected built-in element kinds", () => {
    const kinds = DEFAULT_CASE_PRINT_TEMPLATE.elements.map((e) => e.kind);
    for (const k of [
      "caseNumber", "patient", "doctor", "dueDate", "priority",
      "restorativeType", "teeth", "material", "shade", "rxNotes",
      "toothChart", "barcode",
    ]) {
      expect(kinds).toContain(k);
    }
  });

  it("has all element coordinates within page bounds", () => {
    for (const el of DEFAULT_CASE_PRINT_TEMPLATE.elements) {
      expect(el.x).toBeGreaterThanOrEqual(0);
      expect(el.x).toBeLessThanOrEqual(PAGE_W);
      expect(el.y).toBeGreaterThanOrEqual(0);
      expect(el.y).toBeLessThanOrEqual(PAGE_H);
      expect(el.w).toBeGreaterThanOrEqual(10);
      expect(el.w).toBeLessThanOrEqual(PAGE_W);
      expect(el.h).toBeGreaterThanOrEqual(10);
      expect(el.h).toBeLessThanOrEqual(PAGE_H);
    }
  });

  it("has all elements visible by default", () => {
    for (const el of DEFAULT_CASE_PRINT_TEMPLATE.elements) {
      expect(el.visible).toBe(true);
    }
  });
});
