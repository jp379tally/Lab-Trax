import { describe, it, expect } from "vitest";
import { formatPriceTwoDecimals, isTierMissing } from "../pricing-keys";

// ---------------------------------------------------------------------------
// Pure-logic helpers extracted from BulkPriceTools for unit testing.
// These replicate the arithmetic in applyPct / applyPaste without requiring
// a DOM or React context, so failures are easy to isolate.
// ---------------------------------------------------------------------------

function applyPctLogic(
  keys: string[],
  prices: Record<string, string>,
  pctStr: string,
): { next: Record<string, string>; rows: { before: string; after: string }[] } | null {
  const n = Number(pctStr);
  if (!Number.isFinite(n) || n === 0) return null;
  const factor = 1 + n / 100;
  const next: Record<string, string> = { ...prices };
  const rows: { before: string; after: string }[] = [];
  for (const k of keys) {
    const cur = Number(prices[k]);
    if (Number.isFinite(cur) && cur > 0) {
      const after = (cur * factor).toFixed(2);
      next[k] = after;
      rows.push({
        before: formatPriceTwoDecimals(prices[k] || ""),
        after: formatPriceTwoDecimals(after),
      });
    }
  }
  return { next, rows };
}

function applyPasteLogic(
  keys: string[],
  prices: Record<string, string>,
  pasteText: string,
): { next: Record<string, string>; rows: { before: string; after: string }[] } {
  const next: Record<string, string> = { ...prices };
  const rows: { before: string; after: string }[] = [];
  const lines = pasteText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const m = line.match(
      /^([A-Za-z0-9_.\- ]+?)\s*[=:,\t]\s*\$?([0-9]+(?:\.[0-9]+)?)$/,
    );
    if (!m) continue;
    const rawKey = m[1].trim().toLowerCase().replace(/\s+/g, "_");
    const value = Number(m[2]);
    if (!keys.includes(rawKey) || !Number.isFinite(value) || value < 0) continue;
    const after = value.toFixed(2);
    next[rawKey] = after;
    rows.push({
      before: formatPriceTwoDecimals(prices[rawKey] || ""),
      after: formatPriceTwoDecimals(after),
    });
  }
  return { next, rows };
}

describe("isTierMissing", () => {
  const tiers = [{ name: "Standard" }, { name: "Premium" }];

  it("returns false when no tier is assigned", () => {
    expect(isTierMissing(null, tiers)).toBe(false);
    expect(isTierMissing("", tiers)).toBe(false);
    expect(isTierMissing("   ", tiers)).toBe(false);
    expect(isTierMissing(undefined, tiers)).toBe(false);
  });

  it("returns false when assigned tier exists (case-insensitive, trimmed)", () => {
    expect(isTierMissing("Standard", tiers)).toBe(false);
    expect(isTierMissing("standard", tiers)).toBe(false);
    expect(isTierMissing("  PREMIUM  ", tiers)).toBe(false);
  });

  it("returns true when assigned tier no longer exists in the lab", () => {
    expect(isTierMissing("Corporate", tiers)).toBe(true);
    expect(isTierMissing("Old Standard", tiers)).toBe(true);
  });

  it("returns false when there are no tiers loaded yet (avoid false positives mid-fetch)", () => {
    expect(isTierMissing("Standard", [])).toBe(false);
  });
});

describe("formatPriceTwoDecimals", () => {
  it("pads whole numbers to two decimals", () => {
    expect(formatPriceTwoDecimals("119")).toBe("119.00");
    expect(formatPriceTwoDecimals("99")).toBe("99.00");
  });

  it("pads a single cent digit to two", () => {
    expect(formatPriceTwoDecimals("99.5")).toBe("99.50");
  });

  it("passes through valid two-decimal values unchanged", () => {
    expect(formatPriceTwoDecimals("119.00")).toBe("119.00");
  });

  it("leaves empty (or whitespace-only) input empty", () => {
    expect(formatPriceTwoDecimals("")).toBe("");
    expect(formatPriceTwoDecimals("   ")).toBe("");
  });

  it("returns non-numeric input unchanged", () => {
    expect(formatPriceTwoDecimals("abc")).toBe("abc");
    expect(formatPriceTwoDecimals("12px")).toBe("12px");
  });
});

describe("applyPct logic — two-decimal output", () => {
  const KEYS = ["zirconia_crown", "pfm_crown", "implant"];
  const BASE = { zirconia_crown: "100.00", pfm_crown: "200.00", implant: "" };

  it("produces toFixed(2) strings in next for each affected key", () => {
    const result = applyPctLogic(KEYS, BASE, "10");
    expect(result).not.toBeNull();
    expect(result!.next.zirconia_crown).toBe("110.00");
    expect(result!.next.pfm_crown).toBe("220.00");
  });

  it("produces toFixed(2) preview rows (before and after)", () => {
    const result = applyPctLogic(KEYS, BASE, "5");
    expect(result).not.toBeNull();
    for (const row of result!.rows) {
      expect(row.before).toMatch(/^\d+\.\d{2}$/);
      expect(row.after).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("pads a whole-number before value to two decimals in preview rows", () => {
    const result = applyPctLogic(["zirconia_crown"], { zirconia_crown: "99" }, "10");
    expect(result).not.toBeNull();
    expect(result!.rows[0].before).toBe("99.00");
    expect(result!.rows[0].after).toBe("108.90");
  });

  it("returns null for a zero percent", () => {
    expect(applyPctLogic(KEYS, BASE, "0")).toBeNull();
  });

  it("returns null for an empty percent string", () => {
    expect(applyPctLogic(KEYS, BASE, "")).toBeNull();
  });

  it("skips keys with zero or empty prices", () => {
    const result = applyPctLogic(KEYS, BASE, "10");
    expect(result).not.toBeNull();
    expect(result!.next.implant).toBe("");
    expect(result!.rows.map((r) => r.after)).not.toContain(
      expect.stringContaining("implant"),
    );
  });
});

describe("applyPaste logic — two-decimal output", () => {
  const KEYS = ["zirconia_crown", "pfm_crown", "implant"];
  const BASE = { zirconia_crown: "100.00", pfm_crown: "200.00", implant: "" };

  it("produces toFixed(2) strings in next for each matched key", () => {
    const { next } = applyPasteLogic(KEYS, BASE, "zirconia_crown = 150\npfm_crown = 250");
    expect(next.zirconia_crown).toBe("150.00");
    expect(next.pfm_crown).toBe("250.00");
  });

  it("produces toFixed(2) preview rows (before and after)", () => {
    const { rows } = applyPasteLogic(KEYS, BASE, "zirconia_crown = 119\npfm_crown = 99.5");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.before).toMatch(/^(\d+\.\d{2}|)$/);
      expect(row.after).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("pads a whole-number pasted value to two decimals", () => {
    const { next, rows } = applyPasteLogic(["zirconia_crown"], { zirconia_crown: "" }, "zirconia_crown = 300");
    expect(next.zirconia_crown).toBe("300.00");
    expect(rows[0].after).toBe("300.00");
  });

  it("pads a single-cent pasted value to two decimals", () => {
    const { next } = applyPasteLogic(["zirconia_crown"], { zirconia_crown: "" }, "zirconia_crown = 99.5");
    expect(next.zirconia_crown).toBe("99.50");
  });

  it("ignores unrecognised keys", () => {
    const { next, rows } = applyPasteLogic(KEYS, BASE, "unknown_key = 500");
    expect(next).toEqual(BASE);
    expect(rows).toHaveLength(0);
  });

  it("ignores malformed lines", () => {
    const { next, rows } = applyPasteLogic(KEYS, BASE, "not a valid line");
    expect(next).toEqual(BASE);
    expect(rows).toHaveLength(0);
  });
});
