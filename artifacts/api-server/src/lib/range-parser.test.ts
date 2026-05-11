import { describe, it, expect } from "vitest";
import { parseRangeHeader } from "./range-parser.js";

const SIZE = 1000;

describe("parseRangeHeader", () => {
  it("returns null when header is undefined", () => {
    expect(parseRangeHeader(undefined, SIZE)).toBeNull();
  });

  it("returns null when header is empty string", () => {
    expect(parseRangeHeader("", SIZE)).toBeNull();
  });

  it("returns invalid for malformed header (no bytes= prefix)", () => {
    expect(parseRangeHeader("0-499", SIZE)).toBe("invalid");
  });

  it("returns invalid for multi-range header", () => {
    expect(parseRangeHeader("bytes=0-99,200-299", SIZE)).toBe("invalid");
  });

  it("returns invalid when both start and end are empty", () => {
    expect(parseRangeHeader("bytes=-", SIZE)).toBe("invalid");
  });

  it("returns invalid when size is 0", () => {
    expect(parseRangeHeader("bytes=0-0", 0)).toBe("invalid");
  });

  it("parses a simple range", () => {
    expect(parseRangeHeader("bytes=0-499", SIZE)).toEqual({ start: 0, end: 499 });
  });

  it("parses a mid-file range", () => {
    expect(parseRangeHeader("bytes=200-399", SIZE)).toEqual({ start: 200, end: 399 });
  });

  it("parses an open-ended range (bytes=N-)", () => {
    expect(parseRangeHeader("bytes=500-", SIZE)).toEqual({ start: 500, end: 999 });
  });

  it("clamps end to size - 1 when end exceeds file size", () => {
    expect(parseRangeHeader("bytes=0-9999", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("parses a suffix range (bytes=-N) — last N bytes", () => {
    expect(parseRangeHeader("bytes=-100", SIZE)).toEqual({ start: 900, end: 999 });
  });

  it("handles suffix range larger than file (clamps to whole file)", () => {
    expect(parseRangeHeader("bytes=-2000", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("returns invalid when start >= size", () => {
    expect(parseRangeHeader("bytes=1000-1099", SIZE)).toBe("invalid");
  });

  it("returns invalid when end < start", () => {
    expect(parseRangeHeader("bytes=500-200", SIZE)).toBe("invalid");
  });

  it("returns invalid for suffix range of 0 bytes", () => {
    expect(parseRangeHeader("bytes=-0", SIZE)).toBe("invalid");
  });

  it("is case-insensitive on the bytes= prefix", () => {
    expect(parseRangeHeader("Bytes=0-99", SIZE)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader("BYTES=0-99", SIZE)).toEqual({ start: 0, end: 99 });
  });

  it("ignores leading/trailing whitespace on the header", () => {
    expect(parseRangeHeader("  bytes=0-99  ", SIZE)).toEqual({ start: 0, end: 99 });
  });

  it("handles single-byte range at start", () => {
    expect(parseRangeHeader("bytes=0-0", SIZE)).toEqual({ start: 0, end: 0 });
  });

  it("handles single-byte range at end", () => {
    expect(parseRangeHeader("bytes=999-999", SIZE)).toEqual({ start: 999, end: 999 });
  });

  it("two adjacent ranges cover the same bytes as one combined range", () => {
    const first = parseRangeHeader("bytes=0-499", SIZE);
    const second = parseRangeHeader("bytes=500-999", SIZE);
    const combined = parseRangeHeader("bytes=0-999", SIZE);
    expect(first).toEqual({ start: 0, end: 499 });
    expect(second).toEqual({ start: 500, end: 999 });
    expect(combined).toEqual({ start: 0, end: 999 });
    if (
      first !== null &&
      first !== "invalid" &&
      second !== null &&
      second !== "invalid" &&
      combined !== null &&
      combined !== "invalid"
    ) {
      const adjacentLength = first.end - first.start + 1 + (second.end - second.start + 1);
      const combinedLength = combined.end - combined.start + 1;
      expect(adjacentLength).toBe(combinedLength);
    }
  });
});
