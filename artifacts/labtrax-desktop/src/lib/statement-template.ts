/**
 * Visual statement-layout template (Task #906). Mirror of
 * `artifacts/api-server/src/lib/statement-template.ts` — keep the two in sync.
 *
 * Coordinates are PDF points on a US Letter page (612 × 792 pt).
 */

export const PAGE_W = 612;
export const PAGE_H = 792;

export interface StatementTemplateBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StatementExtraImage {
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

export interface StatementTemplateTextBlock {
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

export interface StatementDefaultTextBlock {
  id: string;
  text: string;
  fontSize: number;
  align: TextAlign;
  bold: boolean;
}

export interface StatementTemplate {
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
    stmtHeader: StatementTemplateBox;
    practiceInfo: StatementTemplateBox;
    balanceSummary: StatementTemplateBox;
    transactions: StatementTemplateBox;
    aging: StatementTemplateBox;
    totals: StatementTemplateBox;
    footer: StatementTemplateBox;
  };
  extraImages: StatementExtraImage[];
  customTexts: StatementTemplateTextBlock[];
  defaultTextBlocks: StatementDefaultTextBlock[];
}

export type StatementSectionKey = keyof StatementTemplate["boxes"];

export const STATEMENT_SECTION_KEYS: StatementSectionKey[] = [
  "stmtHeader",
  "practiceInfo",
  "balanceSummary",
  "transactions",
  "aging",
  "totals",
  "footer",
];

export const STATEMENT_SECTION_LABELS: Record<StatementSectionKey, string> = {
  stmtHeader: "Statement Header",
  practiceInfo: "Practice Info",
  balanceSummary: "Balance Summary",
  transactions: "Transaction Table",
  aging: "Aging Summary",
  totals: "Totals",
  footer: "Footer / Notes",
};

export const STATEMENT_SECTION_COLORS: Record<StatementSectionKey, string> = {
  stmtHeader: "rgba(59,130,246,0.18)",
  practiceInfo: "rgba(16,185,129,0.18)",
  balanceSummary: "rgba(234,179,8,0.18)",
  transactions: "rgba(168,85,247,0.18)",
  aging: "rgba(244,63,94,0.18)",
  totals: "rgba(249,115,22,0.18)",
  footer: "rgba(99,102,241,0.18)",
};

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
  if (!value || typeof value !== "object") return DEFAULT_STATEMENT_TEMPLATE;
  const v = value as Partial<StatementTemplate>;
  if (v.version !== 1 || !v.logo || !v.boxes) return DEFAULT_STATEMENT_TEMPLATE;
  const db = DEFAULT_STATEMENT_TEMPLATE.boxes;
  return {
    version: 1,
    logo: { ...DEFAULT_STATEMENT_TEMPLATE.logo, ...v.logo },
    boxes: {
      stmtHeader: { ...db.stmtHeader, ...v.boxes.stmtHeader },
      practiceInfo: { ...db.practiceInfo, ...v.boxes.practiceInfo },
      balanceSummary: { ...db.balanceSummary, ...v.boxes.balanceSummary },
      transactions: { ...db.transactions, ...v.boxes.transactions },
      aging: { ...db.aging, ...v.boxes.aging },
      totals: { ...db.totals, ...v.boxes.totals },
      footer: { ...db.footer, ...v.boxes.footer },
    },
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
      ? v.defaultTextBlocks.map((db2) => ({
          id: db2.id ?? crypto.randomUUID(),
          text: db2.text ?? "",
          fontSize: db2.fontSize ?? 10,
          align: (db2.align as TextAlign) ?? "left",
          bold: db2.bold ?? false,
        }))
      : [],
  };
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
