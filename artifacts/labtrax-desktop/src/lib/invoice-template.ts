/**
 * Visual invoice-layout template (Task #751). Mirror of
 * `artifacts/api-server/src/lib/invoice-template.ts` — keep the two in sync.
 *
 * Coordinates are PDF points on a US Letter page (612 × 792 pt).
 */

export const PAGE_W = 612;
export const PAGE_H = 792;

export interface InvoiceTemplateBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InvoiceTemplateExtraImage {
  id: string;
  storageKey: string;
  /** URL the desktop can fetch the image bytes from (relative to API base). */
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
}

export type TextAlign = "left" | "center" | "right";

export interface InvoiceTemplateTextBlock {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** PDF points (8 | 10 | 12 | 14 | 18). */
  fontSize: number;
  align: TextAlign;
  bold: boolean;
  /** When set, this block was injected from a default text block with this id (Task #827). */
  sourceId?: string;
}

/**
 * A saved reusable text snippet (Task #827). Defines content and formatting
 * but not position — position is assigned when the block is injected into
 * the canvas `customTexts` array.
 */
export interface DefaultTextBlock {
  id: string;
  text: string;
  fontSize: number;
  align: TextAlign;
  bold: boolean;
}

export interface InvoiceTemplate {
  version: 1;
  logo: {
    mode: "header" | "watermark";
    x: number;
    y: number;
    w: number;
    h: number;
    opacity: number;
  };
  boxes: {
    header: InvoiceTemplateBox;
    billTo: InvoiceTemplateBox;
    meta: InvoiceTemplateBox;
    items: InvoiceTemplateBox;
    totals: InvoiceTemplateBox;
  };
  extraImages: InvoiceTemplateExtraImage[];
  customTexts: InvoiceTemplateTextBlock[];
  /** Saved reusable text snippets (e.g. payment instructions). */
  defaultTextBlocks: DefaultTextBlock[];
}

export const DEFAULT_INVOICE_TEMPLATE: InvoiceTemplate = {
  version: 1,
  logo: {
    mode: "header",
    x: 402,
    y: 30,
    w: 170,
    h: 50,
    opacity: 1,
  },
  boxes: {
    header: { x: 40, y: 30, w: 300, h: 50 },
    billTo: { x: 40, y: 100, w: 440, h: 50 },
    meta: { x: 40, y: 160, w: 532, h: 40 },
    items: { x: 40, y: 210, w: 532, h: 280 },
    totals: { x: 372, y: 500, w: 200, h: 120 },
  },
  extraImages: [],
  customTexts: [],
  defaultTextBlocks: [],
};

export const SECTION_KEYS = [
  "header",
  "billTo",
  "meta",
  "items",
  "totals",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_LABELS: Record<SectionKey, string> = {
  header: "Header (Invoice #)",
  billTo: "Bill-To / Patient",
  meta: "Issued / Due / Status",
  items: "Line items",
  totals: "Totals",
};

export function coerceInvoiceTemplate(value: unknown): InvoiceTemplate {
  if (!value || typeof value !== "object") return DEFAULT_INVOICE_TEMPLATE;
  const v = value as Partial<InvoiceTemplate>;
  if (v.version !== 1 || !v.logo || !v.boxes) return DEFAULT_INVOICE_TEMPLATE;
  return {
    version: 1,
    logo: { ...DEFAULT_INVOICE_TEMPLATE.logo, ...v.logo },
    boxes: {
      header: { ...DEFAULT_INVOICE_TEMPLATE.boxes.header, ...v.boxes.header },
      billTo: { ...DEFAULT_INVOICE_TEMPLATE.boxes.billTo, ...v.boxes.billTo },
      meta: { ...DEFAULT_INVOICE_TEMPLATE.boxes.meta, ...v.boxes.meta },
      items: { ...DEFAULT_INVOICE_TEMPLATE.boxes.items, ...v.boxes.items },
      totals: { ...DEFAULT_INVOICE_TEMPLATE.boxes.totals, ...v.boxes.totals },
    },
    extraImages: Array.isArray(v.extraImages)
      ? v.extraImages.map((img) => ({
          ...img,
          opacity: img.opacity ?? 1,
        }))
      : [],
    customTexts: Array.isArray(v.customTexts)
      ? v.customTexts.map((tb) => ({
          id: tb.id ?? crypto.randomUUID(),
          x: tb.x ?? 40,
          y: tb.y ?? 700,
          w: tb.w ?? 200,
          h: tb.h ?? 40,
          text: tb.text ?? "",
          fontSize: tb.fontSize ?? 10,
          align: tb.align ?? "left",
          bold: tb.bold ?? false,
          sourceId: tb.sourceId,
        }))
      : [],
    defaultTextBlocks: Array.isArray(v.defaultTextBlocks)
      ? v.defaultTextBlocks.map((db) => ({
          id: db.id ?? crypto.randomUUID(),
          text: db.text ?? "",
          fontSize: db.fontSize ?? 10,
          align: (db.align as TextAlign) ?? "left",
          bold: db.bold ?? false,
        }))
      : [],
  };
}

/**
 * Build the canvas position for the nth default text block injection.
 * Stacked in two columns at the bottom of the page.
 */
export function defaultTextBlockPosition(index: number): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const col = index % 2;
  const row = Math.floor(index / 2);
  return {
    x: col === 0 ? 40 : 330,
    y: 650 + row * 40,
    w: 260,
    h: 35,
  };
}

/**
 * Inject all enabled default text blocks into the template's customTexts.
 * Blocks already present (matched by sourceId) keep their existing position.
 * New blocks are placed at default positions.
 */
export function injectDefaultTextBlocks(
  template: InvoiceTemplate,
  enabledIds?: Set<string>,
): InvoiceTemplate {
  const defaults = template.defaultTextBlocks;
  if (defaults.length === 0) return template;

  const existingBySourceId = new Map<string, InvoiceTemplateTextBlock>();
  for (const ct of template.customTexts) {
    if (ct.sourceId) existingBySourceId.set(ct.sourceId, ct);
  }

  const nonDefault = template.customTexts.filter((ct) => !ct.sourceId);
  const injected: InvoiceTemplateTextBlock[] = [];

  defaults.forEach((def, i) => {
    if (enabledIds && !enabledIds.has(def.id)) return;
    const existing = existingBySourceId.get(def.id);
    if (existing) {
      injected.push({ ...existing, text: def.text, fontSize: def.fontSize, align: def.align, bold: def.bold });
    } else {
      injected.push({
        ...defaultTextBlockPosition(i),
        id: crypto.randomUUID(),
        sourceId: def.id,
        text: def.text,
        fontSize: def.fontSize,
        align: def.align,
        bold: def.bold,
      });
    }
  });

  return { ...template, customTexts: [...nonDefault, ...injected] };
}
