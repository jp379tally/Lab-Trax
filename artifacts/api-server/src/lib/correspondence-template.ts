import { z } from "zod/v4";

/**
 * Visual correspondence-layout template (Task #906).
 *
 * All coordinates are expressed in PDF points on a US Letter page
 * (612 × 792 pt). Mirror of
 * `artifacts/labtrax-desktop/src/lib/correspondence-template.ts`; keep in sync.
 *
 * `null` on `organizations.correspondence_template` means "use DEFAULT_CORRESPONDENCE_TEMPLATE".
 */

export const PAGE_W = 612;
export const PAGE_H = 792;

const boxSchema = z.object({
  x: z.number().min(0).max(PAGE_W),
  y: z.number().min(0).max(PAGE_H),
  w: z.number().min(20).max(PAGE_W),
  h: z.number().min(10).max(PAGE_H),
});

export const corrTextBlockSchema = z.object({
  id: z.string().min(1).max(64),
  x: z.number().min(0).max(PAGE_W),
  y: z.number().min(0).max(PAGE_H),
  w: z.number().min(10).max(PAGE_W),
  h: z.number().min(10).max(PAGE_H),
  text: z.string().max(4000).default(""),
  fontSize: z.number().min(6).max(72).default(10),
  align: z.enum(["left", "center", "right"]).default("left"),
  bold: z.boolean().default(false),
  sourceId: z.string().max(64).optional(),
});

export const corrDefaultTextBlockSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(4000).default(""),
  fontSize: z.number().min(6).max(72).default(10),
  align: z.enum(["left", "center", "right"]).default("left"),
  bold: z.boolean().default(false),
});

export const corrExtraImageSchema = z.object({
  id: z.string().min(1).max(64),
  storageKey: z.string().min(1).max(256),
  url: z.string().min(1).max(1024),
  x: z.number().min(0).max(PAGE_W),
  y: z.number().min(0).max(PAGE_H),
  w: z.number().min(10).max(PAGE_W),
  h: z.number().min(10).max(PAGE_H),
  opacity: z.number().min(0).max(1).default(1),
});

/**
 * Supported merge fields for correspondence body text.
 * Rendered at PDF-generation time.
 */
export const CORRESPONDENCE_MERGE_FIELDS = [
  { key: "{{practiceName}}", label: "Practice name" },
  { key: "{{patientName}}", label: "Patient name" },
  { key: "{{balance}}", label: "Balance due" },
  { key: "{{dueDate}}", label: "Due date" },
  { key: "{{labName}}", label: "Lab name" },
  { key: "{{date}}", label: "Today's date" },
  { key: "{{invoiceNumber}}", label: "Invoice #" },
] as const;

export const correspondenceTemplateSchema = z.object({
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
    letterHeader: boxSchema,
    dateBlock: boxSchema,
    recipientBlock: boxSchema,
    bodyBlock: boxSchema,
    closingBlock: boxSchema,
  }),
  /** Body text with merge fields (e.g. {{practiceName}}). */
  bodyText: z.string().max(4000).default(""),
  /** Closing/signature text. */
  closingText: z.string().max(1000).default(""),
  extraImages: z.array(corrExtraImageSchema).max(12).default([]),
  customTexts: z.array(corrTextBlockSchema).max(20).default([]),
  defaultTextBlocks: z.array(corrDefaultTextBlockSchema).max(20).default([]),
});

export type CorrespondenceTemplate = z.infer<typeof correspondenceTemplateSchema>;
export type CorrespondenceTemplateBox = z.infer<typeof boxSchema>;
export type CorrespondenceTextBlock = z.infer<typeof corrTextBlockSchema>;
export type CorrespondenceDefaultTextBlock = z.infer<typeof corrDefaultTextBlockSchema>;
export type CorrespondenceExtraImage = z.infer<typeof corrExtraImageSchema>;

export const DEFAULT_BODY_TEXT =
  "Dear {{practiceName}},\n\nThis letter is regarding your account with our laboratory. As of {{date}}, your balance is {{balance}}, which is due on {{dueDate}}.\n\nPlease contact us if you have any questions about your account.\n\nThank you for your continued partnership.";

export const DEFAULT_CLOSING_TEXT = "Sincerely,\n\n{{labName}}";

export const DEFAULT_CORRESPONDENCE_TEMPLATE: CorrespondenceTemplate = {
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
    letterHeader: { x: 40, y: 30, w: 300, h: 50 },
    dateBlock: { x: 40, y: 100, w: 200, h: 30 },
    recipientBlock: { x: 40, y: 145, w: 260, h: 90 },
    bodyBlock: { x: 40, y: 250, w: 532, h: 380 },
    closingBlock: { x: 40, y: 645, w: 300, h: 100 },
  },
  bodyText: DEFAULT_BODY_TEXT,
  closingText: DEFAULT_CLOSING_TEXT,
  extraImages: [],
  customTexts: [],
  defaultTextBlocks: [],
};

export function coerceCorrespondenceTemplate(value: unknown): CorrespondenceTemplate {
  if (value == null) return DEFAULT_CORRESPONDENCE_TEMPLATE;
  const parsed = correspondenceTemplateSchema.safeParse(value);
  if (!parsed.success) return DEFAULT_CORRESPONDENCE_TEMPLATE;
  return parsed.data;
}

export function corrDefaultTextBlockPosition(index: number): {
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
