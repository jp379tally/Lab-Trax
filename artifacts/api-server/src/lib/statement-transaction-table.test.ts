import PDFDocument from "pdfkit";
import { describe, expect, it, vi } from "vitest";
import {
  drawStatementTable,
  prepareStatementTable,
  statementTableNeedsContinuation,
  statementTransactionColumns,
  type StatementTransactionRow,
} from "./statement-transaction-table";

const box = { x: 40, y: 260, w: 532, h: 280 };
const invoice: StatementTransactionRow = {
  group: "invoice",
  cells: ["INV-26-1041", "Robert Scanlan", "09/01/2026", "10/10/2026", "open", "$99.00", "$198.00"],
};

function instrument() {
  const doc = new PDFDocument({ margin: 0, size: "LETTER" });
  doc.resume();
  return {
    doc,
    text: vi.spyOn(doc, "text") as unknown as {
      mock: { calls: [string, number, number, PDFKit.Mixins.TextOptions][] };
    },
    move: vi.spyOn(doc, "moveTo"),
    to: vi.spyOn(doc, "lineTo"),
    font: vi.spyOn(doc, "fontSize"),
  };
}

describe("statement transaction table geometry", () => {
  it("uses identical padded column geometry for headers, values and vertical rules", () => {
    const { doc, text, move, to } = instrument();
    const columns = statementTransactionColumns(box);
    const table = prepareStatementTable(doc, box, [{ ...invoice, groupEnd: true }]);
    expect(drawStatementTable(doc, box, "Invoices", table, { row: 0, line: 0 })).toEqual({ row: 1, line: 0 });
    columns.forEach((column, index) => {
      const value = text.mock.calls.find(([value]) => value === invoice.cells[index])!;
      expect(value[1]).toBeCloseTo(column.x + 5);
      expect(value[3]).toMatchObject({ width: column.width - 10, lineBreak: false, align: index >= 5 ? "right" : "left" });
      expect(move.mock.calls).toContainEqual([column.x, 278]);
      expect(to.mock.calls).toContainEqual([column.x, 310]);
    });
    expect(columns[6]!.x + columns[6]!.width).toBeCloseTo(572);
    expect(text.mock.calls.some(([value]) => value === "$99.00$198.00")).toBe(false);
    expect(text.mock.calls.some(([value]) => value === "Running Balance")).toBe(true);
    doc.end();
  });

  it("spans details through Status, retaining money rules, and closes only the complete group", () => {
    const { doc, move, to } = instrument();
    const rows: StatementTransactionRow[] = [
      invoice,
      { group: "invoice", detail: true, cells: ["Bill to: Dr. Adams", "", "", "", "", "", ""] },
      { group: "invoice", detail: true, cells: ["Crown", "", "", "", "", "$90.00", ""] },
      { group: "invoice", detail: true, cells: ["- Child", "", "", "", "", "$9.00", ""] },
      { group: "invoice", detail: true, cells: ["Subtotal", "", "", "", "", "$99.00", ""], groupEnd: true },
    ];
    const table = prepareStatementTable(doc, box, rows);
    drawStatementTable(doc, box, "Invoices", table, { row: 0, line: 0 });
    const columns = statementTransactionColumns(box);
    expect(move.mock.calls).not.toContainEqual([columns[1]!.x, 330]);
    expect(move.mock.calls).toContainEqual([columns[5]!.x, 330]);
    expect(to.mock.calls).toContainEqual([columns[6]!.x, 350]);
    const fullWidthLines = move.mock.calls.flatMap(([x, y], index) =>
      x === box.x && to.mock.calls[index]?.[0] === 572 && to.mock.calls[index]?.[1] === y ? [y] : [],
    );
    expect(fullWidthLines).toContain(410);
    expect(fullWidthLines).not.toContain(350);
    doc.end();
  });

  it("wraps long and unbroken cells without losing text, overlapping rows or changing font size", () => {
    const { doc, text, font } = instrument();
    const patient = "Very Long Patient Name ".repeat(8) + "Z".repeat(80);
    const description = "Ceramic crown and detailed prescription ".repeat(160);
    const rows: StatementTransactionRow[] = [
      { ...invoice, cells: [invoice.cells[0]!, patient, ...invoice.cells.slice(2)] },
      { group: "invoice", detail: true, cells: [description, "", "", "", "", "$99.00", ""], groupEnd: true },
    ];
    const table = prepareStatementTable(doc, box, rows);
    let cursor = { row: 0, line: 0 };
    let pages = 0;
    while (cursor.row < rows.length) {
      const before = { ...cursor };
      if (pages) doc.addPage();
      const firstCall = text.mock.calls.length;
      cursor = drawStatementTable(doc, box, "Invoices", table, cursor);
      expect(cursor).not.toEqual(before);
      for (const [value, x, y, options] of text.mock.calls.slice(firstCall).filter((call) => call[2] >= box.y + 50)) {
        expect(x).toBeGreaterThanOrEqual(box.x + 5);
        expect((y as number) + 7.5).toBeLessThanOrEqual(box.y + box.h);
        doc.fontSize(7.5);
        expect(doc.widthOfString(value as string)).toBeLessThanOrEqual((options as { width: number }).width + 0.001);
      }
      expect(++pages).toBeLessThan(20);
    }
    expect(pages).toBeGreaterThan(2);
    expect(table.rows[0]!.lines[1]!.join("").replace(/\s/g, "")).toBe(patient.replace(/\s/g, ""));
    expect(table.rows[1]!.lines[0]!.join("").replace(/\s/g, "")).toBe(description.replace(/\s/g, ""));
    expect(font.mock.calls.every(([size]) => size >= 7)).toBe(true);
    const rendered = text.mock.calls
      .filter(([value, x, y]) => x === box.x + 5 && y >= box.y + 50 && value !== "INV-26-1041")
      .map(([text]) => text).join("").replace(/\s/g, "");
    expect(rendered).toBe(description.replace(/\s/g, ""));
    doc.end();
  });

  it("moves groups intact when they fit a fresh page, without repeating their values", () => {
    const { doc, text } = instrument();
    const small = { ...box, h: 110 };
    const rows: StatementTransactionRow[] = [
      { ...invoice, groupEnd: true },
      { ...invoice, group: "second", cells: ["INV-SECOND", ...invoice.cells.slice(1)] },
      { group: "second", detail: true, cells: ["Bill to: Another doctor", "", "", "", "", "", ""] },
      { group: "second", detail: true, cells: ["Crown", "", "", "", "", "$99.00", ""], groupEnd: true },
    ];
    const table = prepareStatementTable(doc, small, rows);
    const cursor = drawStatementTable(doc, small, "Invoices", table, { row: 0, line: 0 });
    expect(cursor).toEqual({ row: 1, line: 0 });
    expect(text.mock.calls.some(([text]) => text === "INV-SECOND")).toBe(false);
    doc.addPage();
    expect(drawStatementTable(doc, small, "Invoices", table, cursor)).toEqual({ row: 4, line: 0 });
    expect(text.mock.calls.filter(([text]) => text === "INV-SECOND")).toHaveLength(1);
    doc.end();
  });

  it("routes narrow and undersized saved boxes to readable continuation pages", () => {
    expect(statementTableNeedsContinuation(box)).toBe(false);
    expect(statementTableNeedsContinuation({ ...box, w: 250 })).toBe(true);
    expect(statementTableNeedsContinuation({ ...box, h: 10 })).toBe(true);
    expect(statementTableNeedsContinuation({ ...box, h: 69 })).toBe(true);
    expect(statementTableNeedsContinuation({ ...box, h: 70 })).toBe(false);
  });
});
