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
}).superRefine((box, ctx) => {
  if (box.x + box.w > PAGE_W) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["w"], message: "Section extends past the right edge of the page." });
  }
  if (box.y + box.h > PAGE_H) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["h"], message: "Section extends past the bottom edge of the page." });
  }
});

const DEFAULT_LAB_INFO_BOX = { x: 40, y: 90, w: 260, h: 90 };
const statementBoxesSchema = z.object({
  stmtHeader: boxSchema,
  /** Added after the first statement-template version shipped. */
  labInfo: boxSchema.optional(),
  practiceInfo: boxSchema,
  balanceSummary: boxSchema,
  transactions: boxSchema,
  aging: boxSchema,
  totals: boxSchema,
  footer: boxSchema,
}).transform((boxes) => ({
  ...boxes,
  labInfo: boxes.labInfo ?? DEFAULT_LAB_INFO_BOX,
}));

export const STATEMENT_SECTION_KEYS = [
  "stmtHeader",
  "labInfo",
  "practiceInfo",
  "balanceSummary",
  "transactions",
  "aging",
  "totals",
  "footer",
] as const;
export type StatementGeneratedSectionType = (typeof STATEMENT_SECTION_KEYS)[number];
export const STATEMENT_SECTION_LABELS: Record<StatementGeneratedSectionType, string> = {
  stmtHeader: "Statement Header",
  labInfo: "Lab Information",
  practiceInfo: "Practice Info",
  balanceSummary: "Balance Summary",
  transactions: "Transaction Table",
  aging: "Aging Summary",
  totals: "Totals",
  footer: "Footer / Notes",
};
export const STATEMENT_SECTION_DEFAULT_TITLES: Record<StatementGeneratedSectionType, string> = {
  ...STATEMENT_SECTION_LABELS,
  stmtHeader: "Statement",
  transactions: "Invoices",
};

const statementSectionSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["generated", "custom"]),
  generatedType: z.enum(STATEMENT_SECTION_KEYS).optional(),
  title: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  contentMode: z.enum(["generated", "custom"]).default("generated"),
  customText: z.string().max(4000).optional(),
  box: boxSchema,
}).superRefine((section, ctx) => {
  if (section.type === "generated" && !section.generatedType) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["generatedType"], message: "Generated sections require a generatedType." });
  }
  if (section.type === "custom" && section.contentMode !== "custom") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contentMode"], message: "Custom sections must use custom content." });
  }
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
  boxes: statementBoxesSchema,
  sections: z.array(statementSectionSchema).max(40).optional(),
  extraImages: z.array(stmtExtraImageSchema).max(12).default([]),
  customTexts: z.array(stmtTextBlockSchema).max(20).default([]),
  defaultTextBlocks: z.array(stmtDefaultTextBlockSchema).max(20).default([]),
}).transform((template) => ({
  ...template,
  sections: template.sections ?? STATEMENT_SECTION_KEYS.map((generatedType) => ({
    id: generatedType,
    type: "generated" as const,
    generatedType,
    title: STATEMENT_SECTION_DEFAULT_TITLES[generatedType],
    enabled: true,
    contentMode: "generated" as const,
    box: { ...template.boxes[generatedType] },
  })),
}));

export type StatementTemplate = z.infer<typeof statementTemplateSchema>;
export type StatementTemplateBox = z.infer<typeof boxSchema>;
export type StatementTemplateTextBlock = z.infer<typeof stmtTextBlockSchema>;
export type StatementDefaultTextBlock = z.infer<typeof stmtDefaultTextBlockSchema>;
export type StatementExtraImage = z.infer<typeof stmtExtraImageSchema>;
export type StatementTemplateSection = z.infer<typeof statementSectionSchema>;

function defaultStatementSections(
  boxes: StatementTemplate["boxes"] = DEFAULT_STATEMENT_TEMPLATE.boxes,
): StatementTemplateSection[] {
  return STATEMENT_SECTION_KEYS.map((generatedType) => ({
    id: generatedType,
    type: "generated" as const,
    generatedType,
    title: STATEMENT_SECTION_DEFAULT_TITLES[generatedType],
    enabled: true,
    contentMode: "generated" as const,
    box: { ...boxes[generatedType] },
  }));
}

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
    labInfo: DEFAULT_LAB_INFO_BOX,
    practiceInfo: { x: 312, y: 90, w: 260, h: 90 },
    balanceSummary: { x: 40, y: 190, w: 532, h: 60 },
    transactions: { x: 40, y: 260, w: 532, h: 280 },
    aging: { x: 40, y: 550, w: 532, h: 60 },
    totals: { x: 380, y: 620, w: 192, h: 80 },
    footer: { x: 40, y: 730, w: 532, h: 40 },
  },
  sections: [],
  extraImages: [],
  customTexts: [],
  defaultTextBlocks: [],
};
DEFAULT_STATEMENT_TEMPLATE.sections = defaultStatementSections();

export function coerceStatementTemplate(value: unknown): StatementTemplate {
  if (value == null) return { ...DEFAULT_STATEMENT_TEMPLATE, sections: defaultStatementSections() };
  const parsed = statementTemplateSchema.safeParse(value);
  if (!parsed.success) return { ...DEFAULT_STATEMENT_TEMPLATE, sections: defaultStatementSections() };
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
