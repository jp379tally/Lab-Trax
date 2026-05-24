import { z } from "zod/v4";

/**
 * Visual statement-layout template (Task #906).
 *
 * All coordinates are expressed in PDF points on a US Letter page
 * (612 × 792 pt). Mirror of
 * `artifacts/labtrax-desktop/src/lib/statement-template.ts`; keep in sync.
 *
 * `null` on `organizations.statement_template` means "use DEFAULT_STATEMENT_TEMPLATE".
 */

export const PAGE_W = 612;
export const PAGE_H = 792;

const boxSchema = z.object({
  x: z.number().min(0).max(PAGE_W),
  y: z.number().min(0).max(PAGE_H),
  w: z.number().min(20).max(PAGE_W),
  h: z.number().min(10).max(PAGE_H),
});

export const stmtTextBlockSchema = z.object({
  id: z.string().min(1).max(64),
  x: z.number().min(0).max(PAGE_W),
  y: z.number().min(0).max(PAGE_H),
  w: z.number().min(10).max(PAGE_W),
  h: z.number().min(10).max(PAGE_H),
  text: z.string().max(2000).default(""),
  fontSize: z.number().min(6).max(72).default(10),
  align: z.enum(["left", "center", "right"]).default("left"),
  bold: z.boolean().default(false),
  sourceId: z.string().max(64).optional(),
});

export const stmtDefaultTextBlockSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(2000).default(""),
  fontSize: z.number().min(6).max(72).default(10),
  align: z.enum(["left", "center", "right"]).default("left"),
  bold: z.boolean().default(false),
});

export const stmtExtraImageSchema = z.object({
  id: z.string().min(1).max(64),
  storageKey: z.string().min(1).max(256),
  url: z.string().min(1).max(1024),
  x: z.number().min(0).max(PAGE_W),
  y: z.number().min(0).max(PAGE_H),
  w: z.number().min(10).max(PAGE_W),
  h: z.number().min(10).max(PAGE_H),
  opacity: z.number().min(0).max(1).default(1),
});

export const statementTemplateSchema = z.object({
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
    stmtHeader: boxSchema,
    practiceInfo: boxSchema,
    balanceSummary: boxSchema,
    transactions: boxSchema,
    aging: boxSchema,
    totals: boxSchema,
    footer: boxSchema,
  }),
  extraImages: z.array(stmtExtraImageSchema).max(12).default([]),
  customTexts: z.array(stmtTextBlockSchema).max(20).default([]),
  defaultTextBlocks: z.array(stmtDefaultTextBlockSchema).max(20).default([]),
});

export type StatementTemplate = z.infer<typeof statementTemplateSchema>;
export type StatementTemplateBox = z.infer<typeof boxSchema>;
export type StatementTemplateTextBlock = z.infer<typeof stmtTextBlockSchema>;
export type StatementDefaultTextBlock = z.infer<typeof stmtDefaultTextBlockSchema>;
export type StatementExtraImage = z.infer<typeof stmtExtraImageSchema>;

export const DEFAULT_STATEMENT_TEMPLATE: StatementTemplate = {
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
    stmtHeader: { x: 40, y: 30, w: 300, h: 50 },
    practiceInfo: { x: 40, y: 90, w: 300, h: 50 },
    balanceSummary: { x: 40, y: 150, w: 532, h: 60 },
    transactions: { x: 40, y: 220, w: 532, h: 340 },
    aging: { x: 40, y: 570, w: 532, h: 60 },
    totals: { x: 380, y: 640, w: 192, h: 80 },
    footer: { x: 40, y: 730, w: 532, h: 40 },
  },
  extraImages: [],
  customTexts: [],
  defaultTextBlocks: [],
};

export function coerceStatementTemplate(value: unknown): StatementTemplate {
  if (value == null) return DEFAULT_STATEMENT_TEMPLATE;
  const parsed = statementTemplateSchema.safeParse(value);
  if (!parsed.success) return DEFAULT_STATEMENT_TEMPLATE;
  return parsed.data;
}

export function stmtDefaultTextBlockPosition(index: number): {
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
