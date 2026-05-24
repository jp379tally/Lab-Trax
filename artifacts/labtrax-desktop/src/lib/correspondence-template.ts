/**
 * Visual correspondence-layout template (Task #906). Mirror of
 * `artifacts/api-server/src/lib/correspondence-template.ts` — keep the two in sync.
 *
 * Coordinates are PDF points on a US Letter page (612 × 792 pt).
 */

export const PAGE_W = 612;
export const PAGE_H = 792;

export interface CorrespondenceTemplateBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CorrespondenceExtraImage {
  id: string;
  storageKey: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
}

export type TextAlign = "left" | "center" | "right";

export interface CorrespondenceTextBlock {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  align: TextAlign;
  bold: boolean;
  sourceId?: string;
}

export interface CorrespondenceDefaultTextBlock {
  id: string;
  text: string;
  fontSize: number;
  align: TextAlign;
  bold: boolean;
}

export interface CorrespondenceTemplate {
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
    letterHeader: CorrespondenceTemplateBox;
    dateBlock: CorrespondenceTemplateBox;
    recipientBlock: CorrespondenceTemplateBox;
    bodyBlock: CorrespondenceTemplateBox;
    closingBlock: CorrespondenceTemplateBox;
  };
  /** Body text with merge-field placeholders (e.g. {{practiceName}}). */
  bodyText: string;
  /** Closing/signature text. */
  closingText: string;
  extraImages: CorrespondenceExtraImage[];
  customTexts: CorrespondenceTextBlock[];
  defaultTextBlocks: CorrespondenceDefaultTextBlock[];
}

export type CorrSectionKey = keyof CorrespondenceTemplate["boxes"];

export const CORR_SECTION_KEYS: CorrSectionKey[] = [
  "letterHeader",
  "dateBlock",
  "recipientBlock",
  "bodyBlock",
  "closingBlock",
];

export const CORR_SECTION_LABELS: Record<CorrSectionKey, string> = {
  letterHeader: "Letter Header",
  dateBlock: "Date / Reference",
  recipientBlock: "Recipient Address",
  bodyBlock: "Body Text",
  closingBlock: "Closing / Signature",
};

export const CORR_SECTION_COLORS: Record<CorrSectionKey, string> = {
  letterHeader: "rgba(59,130,246,0.18)",
  dateBlock: "rgba(16,185,129,0.18)",
  recipientBlock: "rgba(234,179,8,0.18)",
  bodyBlock: "rgba(168,85,247,0.18)",
  closingBlock: "rgba(244,63,94,0.18)",
};

export const CORRESPONDENCE_MERGE_FIELDS = [
  { key: "{{practiceName}}", label: "Practice name" },
  { key: "{{patientName}}", label: "Patient name" },
  { key: "{{balance}}", label: "Balance due" },
  { key: "{{dueDate}}", label: "Due date" },
  { key: "{{labName}}", label: "Lab name" },
  { key: "{{date}}", label: "Today's date" },
  { key: "{{invoiceNumber}}", label: "Invoice #" },
] as const;

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
  if (!value || typeof value !== "object") return DEFAULT_CORRESPONDENCE_TEMPLATE;
  const v = value as Partial<CorrespondenceTemplate>;
  if (v.version !== 1 || !v.logo || !v.boxes) return DEFAULT_CORRESPONDENCE_TEMPLATE;
  const db = DEFAULT_CORRESPONDENCE_TEMPLATE.boxes;
  return {
    version: 1,
    logo: { ...DEFAULT_CORRESPONDENCE_TEMPLATE.logo, ...v.logo },
    boxes: {
      letterHeader: { ...db.letterHeader, ...v.boxes.letterHeader },
      dateBlock: { ...db.dateBlock, ...v.boxes.dateBlock },
      recipientBlock: { ...db.recipientBlock, ...v.boxes.recipientBlock },
      bodyBlock: { ...db.bodyBlock, ...v.boxes.bodyBlock },
      closingBlock: { ...db.closingBlock, ...v.boxes.closingBlock },
    },
    bodyText: typeof v.bodyText === "string" ? v.bodyText : DEFAULT_BODY_TEXT,
    closingText: typeof v.closingText === "string" ? v.closingText : DEFAULT_CLOSING_TEXT,
    extraImages: Array.isArray(v.extraImages)
      ? v.extraImages.map((img) => ({ ...img, opacity: img.opacity ?? 1 }))
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
      ? v.defaultTextBlocks.map((d) => ({
          id: d.id ?? crypto.randomUUID(),
          text: d.text ?? "",
          fontSize: d.fontSize ?? 10,
          align: (d.align as TextAlign) ?? "left",
          bold: d.bold ?? false,
        }))
      : [],
  };
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

/** Resolve merge fields in a template body string. */
export function resolveMergeFields(
  text: string,
  fields: {
    practiceName?: string;
    patientName?: string;
    balance?: string;
    dueDate?: string;
    labName?: string;
    date?: string;
    invoiceNumber?: string;
  }
): string {
  return text
    .replace(/\{\{practiceName\}\}/g, fields.practiceName ?? "")
    .replace(/\{\{patientName\}\}/g, fields.patientName ?? "")
    .replace(/\{\{balance\}\}/g, fields.balance ?? "")
    .replace(/\{\{dueDate\}\}/g, fields.dueDate ?? "")
    .replace(/\{\{labName\}\}/g, fields.labName ?? "")
    .replace(/\{\{date\}\}/g, fields.date ?? "")
    .replace(/\{\{invoiceNumber\}\}/g, fields.invoiceNumber ?? "");
}
