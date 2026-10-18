/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  fitInvoiceLineItemColumns,
  INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH,
  INVOICE_LINE_ITEM_COLUMN_DEFAULTS,
  INVOICE_LINE_ITEM_COLUMN_MINIMUMS,
  resizeInvoiceLineItemColumns,
} from "@/lib/invoice-line-item-layout";

const labels = ["Item", "Tooth #", "Description", "Qty", "Unit price", "Total"];

function FittedInvoiceTable({ availableWidth, preferences }: {
  availableWidth: number;
  preferences: readonly number[];
}) {
  const widths = fitInvoiceLineItemColumns(preferences, availableWidth);
  const tableWidth = widths.reduce((total, width) => total + width, 0) +
    INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH;
  return (
    <div data-testid="container" style={{ width: availableWidth }}>
      <table data-testid="table" style={{ width: tableWidth }}>
        <colgroup>
          {widths.map((width, index) => <col key={index} style={{ width }} />)}
          <col style={{ width: INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH }} />
        </colgroup>
        <thead><tr>{labels.map((label) => <th key={label}>{label}</th>)}<th /></tr></thead>
        <tbody><tr>{labels.map((label) => <td key={label}>{label}</td>)}<td /></tr></tbody>
        <tfoot>
          {["Subtotal", "Tax", "Discount", "Total"].map((label) => (
            <tr key={label}><td colSpan={5}>{label}</td><td>0.00</td><td /></tr>
          ))}
        </tfoot>
      </table>
    </div>
  );
}

describe("invoice line-item column fitting", () => {
  it("keeps every line-item and totals column inside a narrow panel table", () => {
    const availableWidth = 718;
    render(
      <FittedInvoiceTable
        availableWidth={availableWidth}
        preferences={[176, 112, 220, 64, 112, 96]}
      />,
    );

    const table = screen.getByTestId("table");
    expect(Number.parseFloat(table.style.width)).toBeLessThanOrEqual(availableWidth);
    expect(table.querySelectorAll("thead th")).toHaveLength(7);
    expect(table.querySelectorAll("tfoot tr")).toHaveLength(4);
    const fittedWidths = Array.from(table.querySelectorAll("col")).slice(0, 6).map((col) =>
      Number.parseFloat((col as HTMLElement).style.width),
    );
    expect(fittedWidths.every((width, index) =>
      width >= INVOICE_LINE_ITEM_COLUMN_MINIMUMS[index],
    )).toBe(true);
  });

  it("gives spare wide-panel space to Description", () => {
    const wideWidth = 1240;
    const fitted = fitInvoiceLineItemColumns(
      [...INVOICE_LINE_ITEM_COLUMN_DEFAULTS],
      wideWidth,
    );

    expect(fitted.reduce((total, width) => total + width, 0) +
      INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH).toBe(wideWidth);
    expect(fitted[2]).toBeGreaterThan(INVOICE_LINE_ITEM_COLUMN_DEFAULTS[2]);
    expect(fitted[0]).toBe(INVOICE_LINE_ITEM_COLUMN_DEFAULTS[0]);
  });

  it("keeps a squeezed minimum-width panel scrollable only when minimums cannot fit", () => {
    const veryNarrowWidth = 430;
    const fitted = fitInvoiceLineItemColumns(
      [...INVOICE_LINE_ITEM_COLUMN_DEFAULTS],
      veryNarrowWidth,
    );

    expect(fitted).toEqual([...INVOICE_LINE_ITEM_COLUMN_MINIMUMS]);
    expect(fitted.reduce((total, width) => total + width, 0) +
      INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH).toBeGreaterThan(veryNarrowWidth);
  });

  it("returns reset defaults to a fitting layout and redistributes divider drags", () => {
    const availableWidth = 718;
    const custom = [260, 180, 320, 96, 220, 160];
    const customFit = fitInvoiceLineItemColumns(custom, availableWidth);
    const resetFit = fitInvoiceLineItemColumns(
      [...INVOICE_LINE_ITEM_COLUMN_DEFAULTS],
      availableWidth,
    );
    const dragged = resizeInvoiceLineItemColumns(
      resetFit,
      4,
      30,
      INVOICE_LINE_ITEM_COLUMN_MINIMUMS,
      2,
    );

    expect(customFit.reduce((total, width) => total + width, 0) +
      INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH).toBe(availableWidth);
    expect(resetFit.reduce((total, width) => total + width, 0) +
      INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH).toBe(availableWidth);
    expect(dragged.reduce((total, width) => total + width, 0)).toBe(
      resetFit.reduce((total, width) => total + width, 0),
    );
    expect(dragged[4]).toBe(resetFit[4] + 30);
    expect(dragged[2]).toBe(resetFit[2] - 30);
  });
});
