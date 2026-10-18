import { describe, expect, it } from "vitest";
import { csvCell, pagerItems } from "../invoices";

describe("invoice pager helpers", () => {
  it("lists every page when few", () => {
    expect(pagerItems(2, 4)).toEqual([1, 2, 3, 4]);
  });
  it("condenses long ranges around the current page", () => {
    expect(pagerItems(1, 57)).toEqual([1, 2, "gap", 57]);
    expect(pagerItems(30, 57)).toEqual([1, "gap", 29, 30, 31, "gap", 57]);
    expect(pagerItems(57, 57)).toEqual([1, "gap", 56, 57]);
  });
  it("neutralises spreadsheet formulas and escapes quotes", () => {
    expect(csvCell("=SUM(A1)")).toBe(`"'=SUM(A1)"`);
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell(null)).toBe('""');
  });
});
