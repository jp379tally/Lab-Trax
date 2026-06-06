import { z } from "zod/v4";

/**
 * Visual case-print-label template (advanced layout editor).
 *
 * All coordinates are expressed in CSS pixels on a US Letter page rendered
 * at 96 DPI (816 × 1056 px). The same shape is mirrored on the desktop
 * client (`artifacts/labtrax-desktop/src/lib/case-print-template.ts`).
 *
 * `null` on `organizations.case_print_template` means "no advanced template"
 * — the case drawer falls back to the legacy field-list editor stored in
 * each user's browser local storage.
 */

export const PAGE_W = 816;
export const PAGE_H = 1056;

const boxSchema = z.object({
  x: z.number().min(0).max(PAGE_W),
  y: z.number().min(0).max(PAGE_H),
  w: z.number().min(40).max(PAGE_W),
  h: z.number().min(20).max(PAGE_H),
  visible: z.boolean().default(true),
});

export const casePrintExtraImageSchema = z.object({
  id: z.string().min(1).max(64),
  storageKey: z.string().min(1).max(256),
  url: z.string().min(1).max(1024),
  x: z.number().min(0).max(PAGE_W),
  y: z.number().min(0).max(PAGE_H),
  w: z.number().min(10).max(PAGE_W),
  h: z.number().min(10).max(PAGE_H),
  opacity: z.number().min(0).max(1).default(1),
});

const sectionKeys = [
  "header",
  "caseDetails",
  "rxSummary",
  "toothChart",
  "notes",
  "barcode",
] as const;

export type CaseTemplateSectionKey = (typeof sectionKeys)[number];

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

const fieldSizeSchema = z.enum(FIELD_SIZE_VALUES);

const caseDetailSizesSchema = z
  .object({
    patient: fieldSizeSchema.optional(),
    doctor: fieldSizeSchema.optional(),
    status: fieldSizeSchema.optional(),
    priority: fieldSizeSchema.optional(),
    dueDate: fieldSizeSchema.optional(),
    created: fieldSizeSchema.optional(),
  })
  .optional();

const rxSummarySizesSchema = z
  .object({
    restorativeType: fieldSizeSchema.optional(),
    teeth: fieldSizeSchema.optional(),
    material: fieldSizeSchema.optional(),
    shade: fieldSizeSchema.optional(),
  })
  .optional();

const fieldSizesSchema = z
  .object({
    caseDetails: caseDetailSizesSchema,
    rxSummary: rxSummarySizesSchema,
  })
  .optional();

export const casePrintTemplateSchema = z.object({
  version: z.literal(1),
  boxes: z.object({
    header: boxSchema,
    caseDetails: boxSchema,
    rxSummary: boxSchema,
    toothChart: boxSchema,
    notes: boxSchema,
    barcode: boxSchema,
  }),
  extraImages: z.array(casePrintExtraImageSchema).max(8).default([]),
  fieldSizes: fieldSizesSchema,
});

export type CasePrintTemplate = z.infer<typeof casePrintTemplateSchema>;
export type CaseTemplateBox = z.infer<typeof boxSchema>;
export type CasePrintExtraImage = z.infer<typeof casePrintExtraImageSchema>;

/**
 * Default template — values picked to match the legacy lt-card layout
 * proportions so a fresh template prints recognizably even before the
 * user moves anything.
 */
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

/**
 * Coerce a JSON value loaded from `organizations.case_print_template`
 * into a valid template. Returns DEFAULT_CASE_PRINT_TEMPLATE when the
 * value is null/undefined or fails to parse — never throws.
 */
export function coerceCasePrintTemplate(value: unknown): CasePrintTemplate {
  if (value == null) return DEFAULT_CASE_PRINT_TEMPLATE;
  const parsed = casePrintTemplateSchema.safeParse(value);
  if (!parsed.success) return DEFAULT_CASE_PRINT_TEMPLATE;
  return parsed.data;
}
