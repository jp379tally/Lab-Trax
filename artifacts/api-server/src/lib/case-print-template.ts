import { z } from "zod/v4";

/**
 * Visual case-print-label template (advanced layout editor) — v2.
 *
 * v2 is an **element-based** model: every piece of case info (case number,
 * patient, doctor, due date, priority, restorative type, teeth, material,
 * shade, prescription notes, tooth chart, barcode) is its own independently
 * positionable / resizable box with Word-style typography (font family,
 * numeric font size, bold, italic, alignment). Uploaded images are elements
 * too (`kind: "image"`).
 *
 * All coordinates are expressed in CSS pixels on a US Letter page rendered
 * at 96 DPI (816 × 1056 px). The same shape is mirrored on the desktop
 * client (`artifacts/labtrax-desktop/src/lib/case-print-template.ts`).
 *
 * `null` on `organizations.case_print_template` means "no advanced template"
 * — the case drawer falls back to the legacy field-list editor stored in
 * each user's browser local storage. Stored v1 templates are migrated to v2
 * on read (see `coerceCasePrintTemplate`).
 */

export const PAGE_W = 816;
export const PAGE_H = 1056;

// ── Element model ────────────────────────────────────────────────────────

/** Built-in text fields (carry typography). Order = default stacking order. */
export const TEXT_ELEMENT_KINDS = [
  "caseNumber",
  "patient",
  "doctor",
  "dueDate",
  "priority",
  "restorativeType",
  "teeth",
  "material",
  "shade",
  "rxNotes",
] as const;
export type TextElementKind = (typeof TEXT_ELEMENT_KINDS)[number];

/** Non-text built-in graphical elements. */
export const GRAPHIC_ELEMENT_KINDS = ["toothChart", "barcode"] as const;
export type GraphicElementKind = (typeof GRAPHIC_ELEMENT_KINDS)[number];

/** All built-in element kinds (text + graphic), in default layout order. */
export const BUILTIN_ELEMENT_KINDS = [
  ...TEXT_ELEMENT_KINDS,
  ...GRAPHIC_ELEMENT_KINDS,
] as const;
export type BuiltinElementKind = (typeof BUILTIN_ELEMENT_KINDS)[number];

export const ELEMENT_KINDS = [...BUILTIN_ELEMENT_KINDS, "image"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

export const ELEMENT_ALIGN_VALUES = ["left", "center", "right"] as const;
export type ElementAlign = (typeof ELEMENT_ALIGN_VALUES)[number];

const elementSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(ELEMENT_KINDS),
  x: z.number().min(0).max(PAGE_W),
  y: z.number().min(0).max(PAGE_H),
  w: z.number().min(10).max(PAGE_W),
  h: z.number().min(10).max(PAGE_H),
  visible: z.boolean().default(true),
  // Typography (text elements). Optional so graphic/image elements omit them.
  fontFamily: z.string().min(1).max(120).optional(),
  fontSize: z.number().min(5).max(200).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  align: z.enum(ELEMENT_ALIGN_VALUES).optional(),
  // Image elements only.
  storageKey: z.string().min(1).max(256).optional(),
  url: z.string().min(1).max(1024).optional(),
  opacity: z.number().min(0).max(1).optional(),
});

export const casePrintTemplateSchema = z.object({
  version: z.literal(2),
  elements: z.array(elementSchema).max(40).default([]),
});

export type CasePrintTemplate = z.infer<typeof casePrintTemplateSchema>;
export type CasePrintElement = z.infer<typeof elementSchema>;

const DEFAULT_FONT_FAMILY = "Helvetica, Arial, sans-serif";

function textEl(
  kind: TextElementKind,
  x: number,
  y: number,
  w: number,
  h: number,
  fontSize: number,
  bold: boolean,
): CasePrintElement {
  return {
    id: kind,
    kind,
    x,
    y,
    w,
    h,
    visible: true,
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize,
    bold,
    italic: false,
    align: "left",
  };
}

function graphicEl(
  kind: GraphicElementKind,
  x: number,
  y: number,
  w: number,
  h: number,
): CasePrintElement {
  return { id: kind, kind, x, y, w, h, visible: true };
}

/**
 * Default template — a clean two-column field layout with the anatomical
 * tooth chart, prescription notes, and barcode beneath it. Case status and
 * "created" intentionally do NOT appear.
 */
export const DEFAULT_CASE_PRINT_TEMPLATE: CasePrintTemplate = {
  version: 2,
  elements: [
    textEl("caseNumber", 48, 44, 720, 52, 26, true),
    textEl("patient", 48, 120, 350, 46, 13, false),
    textEl("doctor", 418, 120, 350, 46, 13, false),
    textEl("dueDate", 48, 176, 350, 46, 13, false),
    textEl("priority", 418, 176, 350, 46, 13, false),
    textEl("restorativeType", 48, 232, 350, 46, 13, false),
    textEl("teeth", 418, 232, 350, 46, 13, false),
    textEl("material", 48, 288, 350, 46, 13, false),
    textEl("shade", 418, 288, 350, 46, 13, false),
    graphicEl("toothChart", 48, 352, 720, 300),
    textEl("rxNotes", 48, 672, 720, 220, 12, false),
    graphicEl("barcode", 48, 912, 720, 90),
  ],
};

// ── v1 → v2 migration ─────────────────────────────────────────────────────

const V1_SECTION_KEYS = [
  "header",
  "caseDetails",
  "rxSummary",
  "toothChart",
  "notes",
  "barcode",
] as const;

interface V1Box {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

function clampNum(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function asV1Box(raw: unknown, def: V1Box): V1Box {
  if (!raw || typeof raw !== "object") return def;
  const o = raw as Record<string, unknown>;
  return {
    x: clampNum(o.x, 0, PAGE_W, def.x),
    y: clampNum(o.y, 0, PAGE_H, def.y),
    w: clampNum(o.w, 10, PAGE_W, def.w),
    h: clampNum(o.h, 10, PAGE_H, def.h),
    visible: typeof o.visible === "boolean" ? o.visible : def.visible,
  };
}

const V1_FIELD_SIZE_TO_PX: Record<string, number> = {
  normal: 13,
  large: 16,
  xl: 20,
};

function v1FontSize(sizes: unknown, field: string, fallback: number): number {
  if (!sizes || typeof sizes !== "object") return fallback;
  const v = (sizes as Record<string, unknown>)[field];
  if (typeof v === "string" && v in V1_FIELD_SIZE_TO_PX) {
    return V1_FIELD_SIZE_TO_PX[v];
  }
  return fallback;
}

/** Stack `kinds` vertically inside the given v1 box, preserving its width. */
function stackInBox(
  box: V1Box,
  specs: Array<{ kind: TextElementKind; fontSize: number }>,
): CasePrintElement[] {
  const n = specs.length;
  const cellH = Math.max(20, Math.floor(box.h / n));
  return specs.map((spec, i) => {
    const y = clampNum(box.y + i * cellH, 0, PAGE_H - 20, box.y);
    const h = clampNum(cellH, 10, PAGE_H - y, cellH);
    return textEl(spec.kind, box.x, y, box.w, h, spec.fontSize, false);
  });
}

/**
 * Migrate a legacy v1 (section-based) template object into v2 elements.
 * Best-effort: preserves each section's region + visibility, splits the
 * grouped caseDetails / rxSummary boxes into per-field elements, maps
 * fieldSizes to numeric font sizes, and drops case status / created.
 * Returns null if the input is not recognizably a v1 template.
 */
function migrateV1(value: unknown): CasePrintTemplate | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const boxesRaw = o.boxes;
  if (!boxesRaw || typeof boxesRaw !== "object") return null;
  const boxes = boxesRaw as Record<string, unknown>;
  // Require at least one recognizable v1 section box.
  if (!V1_SECTION_KEYS.some((k) => boxes[k] && typeof boxes[k] === "object")) {
    return null;
  }

  const def = legacyDefaultBoxes();
  const header = asV1Box(boxes.header, def.header);
  const caseDetails = asV1Box(boxes.caseDetails, def.caseDetails);
  const rxSummary = asV1Box(boxes.rxSummary, def.rxSummary);
  const toothChart = asV1Box(boxes.toothChart, def.toothChart);
  const notes = asV1Box(boxes.notes, def.notes);
  const barcode = asV1Box(boxes.barcode, def.barcode);

  const fieldSizes = o.fieldSizes as Record<string, unknown> | undefined;
  const cdSizes = fieldSizes?.caseDetails;
  const rxSizes = fieldSizes?.rxSummary;

  const elements: CasePrintElement[] = [];

  // header → caseNumber (drop status badge)
  const caseNumber = textEl(
    "caseNumber",
    header.x,
    header.y,
    header.w,
    header.h,
    26,
    true,
  );
  caseNumber.visible = header.visible;
  elements.push(caseNumber);

  // caseDetails → patient / doctor / dueDate / priority (drop status, created)
  const cdEls = stackInBox(caseDetails, [
    { kind: "patient", fontSize: v1FontSize(cdSizes, "patient", 13) },
    { kind: "doctor", fontSize: v1FontSize(cdSizes, "doctor", 13) },
    { kind: "dueDate", fontSize: v1FontSize(cdSizes, "dueDate", 13) },
    { kind: "priority", fontSize: v1FontSize(cdSizes, "priority", 13) },
  ]);
  for (const el of cdEls) el.visible = caseDetails.visible;
  elements.push(...cdEls);

  // rxSummary → restorativeType / teeth / material / shade
  const rxEls = stackInBox(rxSummary, [
    {
      kind: "restorativeType",
      fontSize: v1FontSize(rxSizes, "restorativeType", 13),
    },
    { kind: "teeth", fontSize: v1FontSize(rxSizes, "teeth", 13) },
    { kind: "material", fontSize: v1FontSize(rxSizes, "material", 13) },
    { kind: "shade", fontSize: v1FontSize(rxSizes, "shade", 13) },
  ]);
  for (const el of rxEls) el.visible = rxSummary.visible;
  elements.push(...rxEls);

  // notes → rxNotes
  const rxNotes = textEl(
    "rxNotes",
    notes.x,
    notes.y,
    notes.w,
    notes.h,
    12,
    false,
  );
  rxNotes.visible = notes.visible;
  elements.push(rxNotes);

  // toothChart, barcode
  const chartEl = graphicEl(
    "toothChart",
    toothChart.x,
    toothChart.y,
    toothChart.w,
    toothChart.h,
  );
  chartEl.visible = toothChart.visible;
  elements.push(chartEl);

  const barcodeEl = graphicEl(
    "barcode",
    barcode.x,
    barcode.y,
    barcode.w,
    barcode.h,
  );
  barcodeEl.visible = barcode.visible;
  elements.push(barcodeEl);

  // extraImages → image elements
  const imgs = Array.isArray(o.extraImages) ? o.extraImages : [];
  for (const raw of imgs.slice(0, 8)) {
    const img = coerceImageElement(raw);
    if (img) elements.push(img);
  }

  return { version: 2, elements };
}

function legacyDefaultBoxes(): Record<(typeof V1_SECTION_KEYS)[number], V1Box> {
  return {
    header: { x: 48, y: 48, w: 720, h: 64, visible: true },
    caseDetails: { x: 48, y: 132, w: 720, h: 170, visible: true },
    rxSummary: { x: 48, y: 320, w: 720, h: 160, visible: true },
    toothChart: { x: 48, y: 500, w: 720, h: 200, visible: true },
    notes: { x: 48, y: 720, w: 720, h: 200, visible: true },
    barcode: { x: 48, y: 940, w: 720, h: 70, visible: true },
  };
}

function coerceImageElement(raw: unknown): CasePrintElement | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id ? o.id : null;
  const url = typeof o.url === "string" && o.url ? o.url : null;
  const storageKey =
    typeof o.storageKey === "string" && o.storageKey ? o.storageKey : null;
  if (!id || !url || !storageKey) return null;
  return {
    id,
    kind: "image",
    x: clampNum(o.x, 0, PAGE_W, 60),
    y: clampNum(o.y, 0, PAGE_H, 60),
    w: clampNum(o.w, 10, PAGE_W, 120),
    h: clampNum(o.h, 10, PAGE_H, 60),
    visible: true,
    storageKey,
    url,
    opacity: clampNum(o.opacity, 0, 1, 1),
  };
}

/**
 * Coerce a JSON value loaded from `organizations.case_print_template`
 * into a valid v2 template. Returns DEFAULT_CASE_PRINT_TEMPLATE when the
 * value is null/undefined or fails to parse; migrates recognizable v1
 * templates to v2. Never throws.
 */
export function coerceCasePrintTemplate(value: unknown): CasePrintTemplate {
  if (value == null) return DEFAULT_CASE_PRINT_TEMPLATE;
  const parsed = casePrintTemplateSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const migrated = migrateV1(value);
  if (migrated) {
    const reparsed = casePrintTemplateSchema.safeParse(migrated);
    if (reparsed.success) return reparsed.data;
  }
  return DEFAULT_CASE_PRINT_TEMPLATE;
}
