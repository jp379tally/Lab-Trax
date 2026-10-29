import type PDFKit from "pdfkit";
import type { StatementTemplateBox } from "./statement-template";

export interface StatementTransactionRow {
  group: string;
  cells: string[];
  detail?: boolean;
  bold?: boolean;
  color?: string;
  groupEnd?: boolean;
}

const FONT_SIZE = 7.5;
const LINE_HEIGHT = 10;
const PADDING = 5;
const HEADER_HEIGHT = 32;
const HEADERS = ["Invoice #", "Patient", "Issued", "Due", "Status", "Amount", "Running Balance"];
const WEIGHTS = [0.145, 0.225, 0.115, 0.115, 0.10, 0.14, 0.16];

export function statementTransactionColumns(box: StatementTemplateBox) {
  let x = box.x;
  return WEIGHTS.map((weight, index) => {
    const width = index === WEIGHTS.length - 1 ? box.x + box.w - x : box.w * weight;
    const column = { x, width, label: HEADERS[index]! };
    x += width;
    return column;
  });
}

/** Old templates can contain arbitrarily small boxes. Never clip their ledger. */
export function statementTableNeedsContinuation(box: StatementTemplateBox): boolean {
  return box.w < 440 || box.h < 18 + HEADER_HEIGHT + LINE_HEIGHT + PADDING * 2;
}

/** Explicit line breaking makes measurement, pagination and drawing identical. */
function wrap(doc: PDFKit.PDFDocument, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && doc.widthOfString(line + word) > width) {
        lines.push(line.trimEnd());
        line = "";
      }
      // PDFKit's automatic wrapping is disabled: split even unbroken identifiers.
      for (const character of word) {
        if (line && doc.widthOfString(line + character) > width) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
      line += " ";
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export function prepareStatementTable(
  doc: PDFKit.PDFDocument,
  box: StatementTemplateBox,
  rows: StatementTransactionRow[],
) {
  const columns = statementTransactionColumns(box);
  const prepared = rows.map((row) => {
    doc.font(row.bold ? "Helvetica-Bold" : "Helvetica").fontSize(FONT_SIZE);
    const cells = row.cells.map((text, index) => {
      const width = row.detail && index === 0
        ? columns[5]!.x - box.x
        : columns[index]!.width;
      return wrap(doc, text, width - PADDING * 2);
    });
    return { ...row, lines: cells, lineCount: Math.max(1, ...cells.map((cell) => cell.length)) };
  });
  return { columns, rows: prepared };
}

export type StatementTableCursor = { row: number; line: number };

export function drawStatementTable(
  doc: PDFKit.PDFDocument,
  box: StatementTemplateBox,
  title: string,
  table: ReturnType<typeof prepareStatementTable>,
  start: StatementTableCursor,
): StatementTableCursor {
  const { columns, rows } = table;
  const right = box.x + box.w;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(0.5).strokeColor("#999").stroke();
  };
  const rules = (top: number, bottom: number, detail = false) => {
    for (let index = 0; index < columns.length; index++) {
      if (!detail || index === 0 || index >= 5) line(columns[index]!.x, top, columns[index]!.x, bottom);
    }
    line(right, top, right, bottom);
  };
  doc.save();
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
  doc.text(title, box.x + PADDING, box.y + 4, { width: box.w - PADDING * 2, lineBreak: false });
  const headerTop = box.y + 18;
  doc.font("Helvetica-Bold").fontSize(7).fillColor("#333");
  columns.forEach((column, index) => {
    const lines = wrap(doc, column.label, column.width - PADDING * 2);
    lines.forEach((text, i) => doc.text(text, column.x + PADDING, headerTop + 5 + i * 9, {
      width: column.width - PADDING * 2, align: index >= 5 ? "right" : "left", lineBreak: false,
    }));
  });
  let y = headerTop + HEADER_HEIGHT;
  line(box.x, headerTop, right, headerTop);
  line(box.x, y, right, y);
  rules(headerTop, y);
  const bottom = box.y + box.h;
  const contentTop = y;
  let { row: index, line: offset } = start;
  while (index < rows.length) {
    const row = rows[index]!;
    const height = (row.lineCount - offset) * LINE_HEIGHT + PADDING * 2;
    if (offset === 0 && height <= bottom - contentTop && height > bottom - y) break;
    if (offset === 0 && (index === 0 || rows[index - 1]!.group !== row.group)) {
      let groupHeight = 0;
      for (let i = index; i < rows.length && rows[i]!.group === row.group; i++) {
        groupHeight += rows[i]!.lineCount * LINE_HEIGHT + PADDING * 2;
      }
      if (groupHeight <= bottom - contentTop && groupHeight > bottom - y) break;
    }
    const count = Math.min(row.lineCount - offset, Math.floor((bottom - y - PADDING * 2) / LINE_HEIGHT));
    if (count <= 0) break;
    const drawnHeight = Math.min(height, count * LINE_HEIGHT + PADDING * 2);
    doc.font(row.bold ? "Helvetica-Bold" : "Helvetica").fontSize(FONT_SIZE).fillColor(row.color ?? "#000");
    row.lines.forEach((cell, columnIndex) => {
      const column = columns[columnIndex]!;
      const width = row.detail && columnIndex === 0 ? columns[5]!.x - box.x : column.width;
      cell.slice(offset, offset + count).forEach((text, i) => {
        doc.text(text, column.x + PADDING, y + PADDING + i * LINE_HEIGHT, {
          width: width - PADDING * 2, align: columnIndex >= 5 ? "right" : "left", lineBreak: false,
        });
      });
    });
    rules(y, y + drawnHeight, row.detail);
    y += drawnHeight;
    offset += count;
    if (offset < row.lineCount) break;
    if (row.groupEnd) line(box.x, y, right, y);
    index++;
    offset = 0;
  }
  // Close every page fragment, including fragments within a single long row.
  line(box.x, y, right, y);
  doc.restore();
  return { row: index, line: offset };
}
