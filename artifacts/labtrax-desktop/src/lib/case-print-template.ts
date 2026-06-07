// Mirror of artifacts/api-server/src/lib/case-print-template.ts — keep
// the two in sync. v2 element-based model. Coordinates are CSS pixels on a
// US Letter page rendered at 96 DPI (816 × 1056 px).

export const PAGE_W = 816;
export const PAGE_H = 1056;

// ── Element model ────────────────────────────────────────────────────────

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

export const GRAPHIC_ELEMENT_KINDS = ["toothChart", "barcode"] as const;
export type GraphicElementKind = (typeof GRAPHIC_ELEMENT_KINDS)[number];

export const BUILTIN_ELEMENT_KINDS = [
  ...TEXT_ELEMENT_KINDS,
  ...GRAPHIC_ELEMENT_KINDS,
] as const;
export type BuiltinElementKind = (typeof BUILTIN_ELEMENT_KINDS)[number];

export const ELEMENT_KINDS = [...BUILTIN_ELEMENT_KINDS, "image"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

export const ELEMENT_ALIGN_VALUES = ["left", "center", "right"] as const;
export type ElementAlign = (typeof ELEMENT_ALIGN_VALUES)[number];

export interface CasePrintElement {
  id: string;
  kind: ElementKind;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  // Typography (text elements)
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  align?: ElementAlign;
  // Image elements only
  storageKey?: string;
  url?: string;
  opacity?: number;
}

export interface CasePrintTemplate {
  version: 2;
  elements: CasePrintElement[];
}

// ── UI metadata ────────────────────────────────────────────────────────

export const ELEMENT_LABELS: Record<ElementKind, string> = {
  caseNumber: "Case #",
  patient: "Patient",
  doctor: "Doctor",
  dueDate: "Due Date",
  priority: "Priority",
  restorativeType: "Restorative Type",
  teeth: "Tooth Number(s)",
  material: "Material",
  shade: "Shade",
  rxNotes: "Prescription Notes",
  toothChart: "Tooth Chart",
  barcode: "Case Pan Barcode",
  image: "Image",
};

export const ELEMENT_COLORS: Record<ElementKind, string> = {
  caseNumber: "rgba(59,130,246,0.16)",
  patient: "rgba(16,185,129,0.16)",
  doctor: "rgba(16,185,129,0.16)",
  dueDate: "rgba(20,184,166,0.16)",
  priority: "rgba(20,184,166,0.16)",
  restorativeType: "rgba(168,85,247,0.16)",
  teeth: "rgba(168,85,247,0.16)",
  material: "rgba(168,85,247,0.16)",
  shade: "rgba(168,85,247,0.16)",
  rxNotes: "rgba(244,63,94,0.16)",
  toothChart: "rgba(234,179,8,0.18)",
  barcode: "rgba(100,116,139,0.18)",
  image: "rgba(0,0,0,0)",
};

export interface FontFamilyOption {
  label: string;
  value: string;
}

export const FONT_FAMILIES: FontFamilyOption[] = [
  { label: "Helvetica / Arial", value: "Helvetica, Arial, sans-serif" },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Georgia", value: "Georgia, 'Times New Roman', serif" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Tahoma", value: "Tahoma, Geneva, sans-serif" },
  { label: "Trebuchet MS", value: "'Trebuchet MS', Helvetica, sans-serif" },
  { label: "Courier (mono)", value: "'Courier New', Courier, monospace" },
];

export const DEFAULT_FONT_FAMILY = "Helvetica, Arial, sans-serif";

export function isTextKind(kind: ElementKind): kind is TextElementKind {
  return (TEXT_ELEMENT_KINDS as readonly string[]).includes(kind);
}

// ── Element constructors ───────────────────────────────────────────────

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

export function makeImageElement(
  id: string,
  storageKey: string,
  url: string,
  box: { x: number; y: number; w: number; h: number },
): CasePrintElement {
  return {
    id,
    kind: "image",
    x: clampNum(box.x, 0, PAGE_W, 60),
    y: clampNum(box.y, 0, PAGE_H, 60),
    w: clampNum(box.w, 10, PAGE_W, 120),
    h: clampNum(box.h, 10, PAGE_H, 60),
    visible: true,
    storageKey,
    url,
    opacity: 1,
  };
}

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

// ── Coercion helpers ───────────────────────────────────────────────────

function clampNum(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function coerceAlign(v: unknown): ElementAlign {
  return v === "center" || v === "right" || v === "left" ? v : "left";
}

function defaultForKind(kind: BuiltinElementKind): CasePrintElement {
  const found = DEFAULT_CASE_PRINT_TEMPLATE.elements.find(
    (e) => e.kind === kind,
  );
  // every builtin kind is present in DEFAULT
  return found ?? graphicEl("barcode", 48, 912, 720, 90);
}

function coerceElement(raw: unknown): CasePrintElement | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (typeof kind !== "string" || !(ELEMENT_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  const k = kind as ElementKind;
  const id = typeof o.id === "string" && o.id ? o.id : k;
  const x = clampNum(o.x, 0, PAGE_W, 48);
  const y = clampNum(o.y, 0, PAGE_H, 48);
  const w = clampNum(o.w, 10, PAGE_W, 200);
  const h = clampNum(o.h, 10, PAGE_H, 40);
  const visible = typeof o.visible === "boolean" ? o.visible : true;

  if (k === "image") {
    const url = typeof o.url === "string" && o.url ? o.url : null;
    const storageKey =
      typeof o.storageKey === "string" && o.storageKey ? o.storageKey : null;
    if (!url || !storageKey) return null;
    return {
      id,
      kind: "image",
      x,
      y,
      w,
      h,
      visible,
      storageKey,
      url,
      opacity: clampNum(o.opacity, 0, 1, 1),
    };
  }

  if (isTextKind(k)) {
    const fontFamily =
      typeof o.fontFamily === "string" && o.fontFamily
        ? o.fontFamily
        : DEFAULT_FONT_FAMILY;
    const fontSize = clampNum(o.fontSize, 5, 200, 13);
    const bold = typeof o.bold === "boolean" ? o.bold : false;
    const italic = typeof o.italic === "boolean" ? o.italic : false;
    const align = coerceAlign(o.align);
    return { id, kind: k, x, y, w, h, visible, fontFamily, fontSize, bold, italic, align };
  }

  // graphic builtin (toothChart, barcode)
  return { id, kind: k, x, y, w, h, visible };
}

// ── v1 → v2 migration ─────────────────────────────────────────────────────

interface V1Box {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

const V1_FIELD_SIZE_TO_PX: Record<string, number> = {
  normal: 13,
  large: 16,
  xl: 20,
};

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

function v1FontSize(sizes: unknown, field: string, fallback: number): number {
  if (!sizes || typeof sizes !== "object") return fallback;
  const v = (sizes as Record<string, unknown>)[field];
  if (typeof v === "string" && v in V1_FIELD_SIZE_TO_PX) {
    return V1_FIELD_SIZE_TO_PX[v];
  }
  return fallback;
}

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

const LEGACY_DEFAULT_BOXES: Record<string, V1Box> = {
  header: { x: 48, y: 48, w: 720, h: 64, visible: true },
  caseDetails: { x: 48, y: 132, w: 720, h: 170, visible: true },
  rxSummary: { x: 48, y: 320, w: 720, h: 160, visible: true },
  toothChart: { x: 48, y: 500, w: 720, h: 200, visible: true },
  notes: { x: 48, y: 720, w: 720, h: 200, visible: true },
  barcode: { x: 48, y: 940, w: 720, h: 70, visible: true },
};

function migrateV1(value: Record<string, unknown>): CasePrintTemplate | null {
  const boxesRaw = value.boxes;
  if (!boxesRaw || typeof boxesRaw !== "object") return null;
  const boxes = boxesRaw as Record<string, unknown>;
  const sectionKeys = Object.keys(LEGACY_DEFAULT_BOXES);
  if (!sectionKeys.some((k) => boxes[k] && typeof boxes[k] === "object")) {
    return null;
  }

  const header = asV1Box(boxes.header, LEGACY_DEFAULT_BOXES.header);
  const caseDetails = asV1Box(boxes.caseDetails, LEGACY_DEFAULT_BOXES.caseDetails);
  const rxSummary = asV1Box(boxes.rxSummary, LEGACY_DEFAULT_BOXES.rxSummary);
  const toothChart = asV1Box(boxes.toothChart, LEGACY_DEFAULT_BOXES.toothChart);
  const notes = asV1Box(boxes.notes, LEGACY_DEFAULT_BOXES.notes);
  const barcode = asV1Box(boxes.barcode, LEGACY_DEFAULT_BOXES.barcode);

  const fieldSizes = value.fieldSizes as Record<string, unknown> | undefined;
  const cdSizes = fieldSizes?.caseDetails;
  const rxSizes = fieldSizes?.rxSummary;

  const elements: CasePrintElement[] = [];

  const caseNumber = textEl("caseNumber", header.x, header.y, header.w, header.h, 26, true);
  caseNumber.visible = header.visible;
  elements.push(caseNumber);

  const cdEls = stackInBox(caseDetails, [
    { kind: "patient", fontSize: v1FontSize(cdSizes, "patient", 13) },
    { kind: "doctor", fontSize: v1FontSize(cdSizes, "doctor", 13) },
    { kind: "dueDate", fontSize: v1FontSize(cdSizes, "dueDate", 13) },
    { kind: "priority", fontSize: v1FontSize(cdSizes, "priority", 13) },
  ]);
  for (const el of cdEls) el.visible = caseDetails.visible;
  elements.push(...cdEls);

  const rxEls = stackInBox(rxSummary, [
    { kind: "restorativeType", fontSize: v1FontSize(rxSizes, "restorativeType", 13) },
    { kind: "teeth", fontSize: v1FontSize(rxSizes, "teeth", 13) },
    { kind: "material", fontSize: v1FontSize(rxSizes, "material", 13) },
    { kind: "shade", fontSize: v1FontSize(rxSizes, "shade", 13) },
  ]);
  for (const el of rxEls) el.visible = rxSummary.visible;
  elements.push(...rxEls);

  const rxNotes = textEl("rxNotes", notes.x, notes.y, notes.w, notes.h, 12, false);
  rxNotes.visible = notes.visible;
  elements.push(rxNotes);

  const chartEl = graphicEl("toothChart", toothChart.x, toothChart.y, toothChart.w, toothChart.h);
  chartEl.visible = toothChart.visible;
  elements.push(chartEl);

  const barcodeEl = graphicEl("barcode", barcode.x, barcode.y, barcode.w, barcode.h);
  barcodeEl.visible = barcode.visible;
  elements.push(barcodeEl);

  const imgs = Array.isArray(value.extraImages) ? value.extraImages : [];
  for (const raw of imgs.slice(0, 8)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id ? o.id : null;
    const url = typeof o.url === "string" && o.url ? o.url : null;
    const storageKey = typeof o.storageKey === "string" && o.storageKey ? o.storageKey : null;
    if (!id || !url || !storageKey) continue;
    const img = makeImageElement(id, storageKey, url, {
      x: clampNum(o.x, 0, PAGE_W, 60),
      y: clampNum(o.y, 0, PAGE_H, 60),
      w: clampNum(o.w, 10, PAGE_W, 120),
      h: clampNum(o.h, 10, PAGE_H, 60),
    });
    img.opacity = clampNum(o.opacity, 0, 1, 1);
    elements.push(img);
  }

  return { version: 2, elements };
}

/**
 * Ensure every built-in element kind is present (filling any missing one
 * from the default), preserving the canonical built-in order followed by
 * image elements. Keeps the editor robust against partial saved data.
 */
export function ensureBuiltinElements(
  elements: CasePrintElement[],
): CasePrintElement[] {
  const byKind = new Map<string, CasePrintElement>();
  const images: CasePrintElement[] = [];
  for (const el of elements) {
    if (el.kind === "image") images.push(el);
    else if (!byKind.has(el.kind)) byKind.set(el.kind, el);
  }
  const ordered: CasePrintElement[] = BUILTIN_ELEMENT_KINDS.map((kind) => {
    return byKind.get(kind) ?? defaultForKind(kind);
  });
  return [...ordered, ...images];
}

export function coerceCasePrintTemplate(value: unknown): CasePrintTemplate {
  if (!value || typeof value !== "object") return DEFAULT_CASE_PRINT_TEMPLATE;
  const o = value as Record<string, unknown>;

  // v2
  if (o.version === 2 && Array.isArray(o.elements)) {
    const elements = o.elements
      .map(coerceElement)
      .filter((e): e is CasePrintElement => e !== null)
      .slice(0, 40);
    return { version: 2, elements: ensureBuiltinElements(elements) };
  }

  // v1 → v2
  const migrated = migrateV1(o);
  if (migrated) {
    return { version: 2, elements: ensureBuiltinElements(migrated.elements) };
  }

  return DEFAULT_CASE_PRINT_TEMPLATE;
}

export function isSameTemplate(
  a: CasePrintTemplate,
  b: CasePrintTemplate,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
