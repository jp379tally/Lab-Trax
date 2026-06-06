// Mirror of artifacts/api-server/src/lib/case-print-template.ts — keep
// the two in sync. Coordinates are CSS pixels on a US Letter page
// rendered at 96 DPI (816 × 1056 px).

export const PAGE_W = 816;
export const PAGE_H = 1056;

export interface CaseTemplateBox {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

export interface CasePrintExtraImage {
  id: string;
  storageKey: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
}

export type CaseTemplateSectionKey =
  | "header"
  | "caseDetails"
  | "rxSummary"
  | "toothChart"
  | "notes"
  | "barcode";

export const FIELD_SIZE_VALUES = ["normal", "large", "xl"] as const;
export type FieldSize = (typeof FIELD_SIZE_VALUES)[number];

export const CASE_DETAIL_FIELDS = [
  "patient",
  "doctor",
  "status",
  "priority",
  "dueDate",
  "created",
] as const;
export type CaseDetailField = (typeof CASE_DETAIL_FIELDS)[number];

export const RX_SUMMARY_FIELDS = [
  "restorativeType",
  "teeth",
  "material",
  "shade",
] as const;
export type RxSummaryField = (typeof RX_SUMMARY_FIELDS)[number];

export interface CasePrintFieldSizes {
  caseDetails?: Partial<Record<CaseDetailField, FieldSize>>;
  rxSummary?: Partial<Record<RxSummaryField, FieldSize>>;
}

export interface CasePrintTemplate {
  version: 1;
  boxes: Record<CaseTemplateSectionKey, CaseTemplateBox>;
  extraImages: CasePrintExtraImage[];
  fieldSizes?: CasePrintFieldSizes;
}

export const SECTION_LABELS: Record<CaseTemplateSectionKey, string> = {
  header: "Header (Case # + Status)",
  caseDetails: "Case Details",
  rxSummary: "RX Summary",
  toothChart: "Tooth Chart",
  notes: "Notes",
  barcode: "Case Pan Barcode",
};

export const CASE_DETAIL_FIELD_LABELS: Record<CaseDetailField, string> = {
  patient: "Patient",
  doctor: "Doctor",
  status: "Status",
  priority: "Priority",
  dueDate: "Due Date",
  created: "Created",
};

export const RX_SUMMARY_FIELD_LABELS: Record<RxSummaryField, string> = {
  restorativeType: "Restorative Type",
  teeth: "Tooth Number(s)",
  material: "Material",
  shade: "Shade",
};

export const SECTION_ORDER: CaseTemplateSectionKey[] = [
  "header",
  "caseDetails",
  "rxSummary",
  "toothChart",
  "notes",
  "barcode",
];

export const DEFAULT_CASE_PRINT_TEMPLATE: CasePrintTemplate = {
  version: 1,
  boxes: {
    header: { x: 48, y: 48, w: 720, h: 64, visible: true },
    caseDetails: { x: 48, y: 132, w: 720, h: 170, visible: true },
    rxSummary: { x: 48, y: 320, w: 720, h: 160, visible: true },
    toothChart: { x: 48, y: 500, w: 720, h: 200, visible: true },
    notes: { x: 48, y: 720, w: 720, h: 200, visible: true },
    barcode: { x: 48, y: 940, w: 720, h: 70, visible: true },
  },
  extraImages: [],
};

function isBox(b: unknown): b is CaseTemplateBox {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.x === "number" &&
    typeof o.y === "number" &&
    typeof o.w === "number" &&
    typeof o.h === "number"
  );
}

function coerceBox(raw: unknown, def: CaseTemplateBox): CaseTemplateBox {
  if (!isBox(raw)) return def;
  const o = raw as Partial<CaseTemplateBox>;
  return {
    x: clampNum(o.x, 0, PAGE_W, def.x),
    y: clampNum(o.y, 0, PAGE_H, def.y),
    w: clampNum(o.w, 40, PAGE_W, def.w),
    h: clampNum(o.h, 20, PAGE_H, def.h),
    visible: typeof o.visible === "boolean" ? o.visible : def.visible,
  };
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function coerceImage(raw: unknown): CasePrintExtraImage | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<CasePrintExtraImage>;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.url !== "string" || !o.url) return null;
  if (typeof o.storageKey !== "string" || !o.storageKey) return null;
  return {
    id: o.id,
    storageKey: o.storageKey,
    url: o.url,
    x: clampNum(o.x, 0, PAGE_W, 60),
    y: clampNum(o.y, 0, PAGE_H, 60),
    w: clampNum(o.w, 10, PAGE_W, 120),
    h: clampNum(o.h, 10, PAGE_H, 60),
    opacity: clampNum(o.opacity, 0, 1, 1),
  };
}

function coerceFieldSize(v: unknown): FieldSize | undefined {
  if (v === "large" || v === "xl") return v;
  if (v === "normal") return "normal";
  return undefined;
}

function coerceFieldSizes(raw: unknown): CasePrintFieldSizes | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;

  const cdRaw = o.caseDetails && typeof o.caseDetails === "object"
    ? (o.caseDetails as Record<string, unknown>)
    : null;
  const rxRaw = o.rxSummary && typeof o.rxSummary === "object"
    ? (o.rxSummary as Record<string, unknown>)
    : null;

  const caseDetails: Partial<Record<CaseDetailField, FieldSize>> = {};
  if (cdRaw) {
    for (const k of CASE_DETAIL_FIELDS) {
      const s = coerceFieldSize(cdRaw[k]);
      if (s) caseDetails[k] = s;
    }
  }

  const rxSummary: Partial<Record<RxSummaryField, FieldSize>> = {};
  if (rxRaw) {
    for (const k of RX_SUMMARY_FIELDS) {
      const s = coerceFieldSize(rxRaw[k]);
      if (s) rxSummary[k] = s;
    }
  }

  const hasCd = Object.keys(caseDetails).length > 0;
  const hasRx = Object.keys(rxSummary).length > 0;
  if (!hasCd && !hasRx) return undefined;
  return {
    ...(hasCd ? { caseDetails } : {}),
    ...(hasRx ? { rxSummary } : {}),
  };
}

export function coerceCasePrintTemplate(value: unknown): CasePrintTemplate {
  if (!value || typeof value !== "object") return DEFAULT_CASE_PRINT_TEMPLATE;
  const o = value as Partial<CasePrintTemplate>;
  const srcBoxes = (o.boxes ?? {}) as Partial<Record<CaseTemplateSectionKey, unknown>>;
  const boxes = {} as Record<CaseTemplateSectionKey, CaseTemplateBox>;
  for (const key of SECTION_ORDER) {
    boxes[key] = coerceBox(srcBoxes[key], DEFAULT_CASE_PRINT_TEMPLATE.boxes[key]);
  }
  const imgs = Array.isArray(o.extraImages) ? o.extraImages : [];
  const extraImages = imgs
    .map(coerceImage)
    .filter((x): x is CasePrintExtraImage => x !== null)
    .slice(0, 8);
  const fieldSizes = coerceFieldSizes(o.fieldSizes);
  return { version: 1, boxes, extraImages, ...(fieldSizes ? { fieldSizes } : {}) };
}

export function isSameTemplate(
  a: CasePrintTemplate,
  b: CasePrintTemplate,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
