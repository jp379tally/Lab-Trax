import { z } from "zod/v4";

/**
 * Visual invoice-layout template (Task #751).
 *
 * All coordinates are expressed in PDF points on a US Letter page
 * (612 × 792 pt). The same shape is shared with the desktop client
 * (`artifacts/labtrax-desktop/src/lib/invoice-template.ts`); keep the
 * two files in sync.
 *
 * `null` on `organizations.invoice_template` means "use DEFAULT_INVOICE_TEMPLATE"
 * — that preserves the historical hard-coded layout for labs that have
 * never opened the editor.
 */

export const PAGE_W = 612;
export const PAGE_H = 792;

const boxSchema = z.object({
  x: z.number().min(0).max(PAGE_W),
  y: z.number().min(0).max(PAGE_H),
  w: z.number().min(20).max(PAGE_W),
  h: z.number().min(10).max(PAGE_H),
});

export const extraImageSchema = z.object({
  id: z.string().min(1).max(64),
  storageKey: z.string().min(1).max(256),
  url: z.string().min(1).max(1024),
  x: z.number().min(0).max(PAGE_W),
  y: z.number().min(0).max(PAGE_H),
  w: z.number().min(10).max(PAGE_W),
  h: z.number().min(10).max(PAGE_H),
  opacity: z.number().min(0).max(1).default(1),
});

export const textBlockSchema = z.object({
  id: z.string().min(1).max(64),
  x: z.number().min(0).max(PAGE_W),
  y: z.number().min(0).max(PAGE_H),
  w: z.number().min(10).max(PAGE_W),
  h: z.number().min(10).max(PAGE_H),
  text: z.string().max(2000).default(""),
  fontSize: z.number().min(6).max(72).default(10),
  align: z.enum(["left", "center", "right"]).default("left"),
  bold: z.boolean().default(false),
  /** When set, this block was injected from a default text block with this id. */
  sourceId: z.string().max(64).optional(),
});

/**
 * A saved reusable text snippet (Task #827). Defines content and formatting
 * but not position — position is assigned when the block is injected into
 * the canvas `customTexts` array.
 */
export const defaultTextBlockSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(2000).default(""),
  fontSize: z.number().min(6).max(72).default(10),
  align: z.enum(["left", "center", "right"]).default("left"),
  bold: z.boolean().default(false),
});

export const invoiceTemplateSchema = z.object({
  version: z.literal(1),
  logo: z.object({
    mode: z.enum(["header", "watermark"]),
    x: z.number().min(0).max(PAGE_W),
    y: z.number().min(0).max(PAGE_H),
    w: z.number().min(20).max(PAGE_W),
    h: z.number().min(10).max(PAGE_H),
    opacity: z.number().min(0).max(1).default(1),
  }),
  boxes: z.object({
    header: boxSchema,
    billTo: boxSchema,
    meta: boxSchema,
    items: boxSchema,
    totals: boxSchema,
  }),
  extraImages: z.array(extraImageSchema).max(12).default([]),
  customTexts: z.array(textBlockSchema).max(20).default([]),
  /** Saved reusable text snippets (e.g. payment instructions). */
  defaultTextBlocks: z.array(defaultTextBlockSchema).max(20).default([]),
});

export type InvoiceTemplate = z.infer<typeof invoiceTemplateSchema>;
export type InvoiceTemplateBox = z.infer<typeof boxSchema>;
export type InvoiceTemplateExtraImage = z.infer<typeof extraImageSchema>;
export type InvoiceTemplateTextBlock = z.infer<typeof textBlockSchema>;
export type DefaultTextBlock = z.infer<typeof defaultTextBlockSchema>;

/**
 * Default template — coordinates match the original hard-coded jsPDF
 * layout (Letter, 40 pt margin) so existing labs see no visual change
 * until they actively edit the template.
 */
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

/**
 * Coerce a JSON value loaded from `organizations.invoice_template` into
 * a valid template. Returns DEFAULT_INVOICE_TEMPLATE when the value is
 * null/undefined or fails to parse — never throws.
 */
export function coerceInvoiceTemplate(value: unknown): InvoiceTemplate {
  if (value == null) return DEFAULT_INVOICE_TEMPLATE;
  const parsed = invoiceTemplateSchema.safeParse(value);
  if (!parsed.success) return DEFAULT_INVOICE_TEMPLATE;
  return parsed.data;
}

/**
 * Build the canvas position for the nth default text block injection.
 * Stacked at the bottom of the page; wraps after 8 blocks.
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
