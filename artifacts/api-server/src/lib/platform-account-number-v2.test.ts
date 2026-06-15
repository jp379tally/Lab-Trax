/**
 * Unit tests for the canonical (Account epic Phase 2) account-number helpers.
 *
 * These are pure-function tests (no DB) covering the new format
 * `<TYPE>-<YEAR>-<SEQUENCE>-<PHONE>` and its building blocks. The transactional
 * allocator (`allocateAccountNumberV2`) is exercised by the DB-backed
 * register tests in `account-epic-phase2.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  accountTypeFor,
  normalizePhone10,
  formatAccountNumberV2,
} from "./platform-account-number";

describe("accountTypeFor", () => {
  it("maps lab -> L and everything else -> P", () => {
    expect(accountTypeFor("lab")).toBe("L");
    expect(accountTypeFor("provider")).toBe("P");
    expect(accountTypeFor(null)).toBe("P");
    expect(accountTypeFor(undefined)).toBe("P");
    expect(accountTypeFor("anything")).toBe("P");
  });
});

describe("normalizePhone10", () => {
  it("strips formatting to 10 digits", () => {
    expect(normalizePhone10("(555) 123-4567")).toBe("5551234567");
    expect(normalizePhone10("555.123.4567")).toBe("5551234567");
  });

  it("drops a leading US country code on 11-digit numbers", () => {
    expect(normalizePhone10("1 (555) 123-4567")).toBe("5551234567");
    expect(normalizePhone10("15551234567")).toBe("5551234567");
  });

  it("returns null for non-10-digit or empty input", () => {
    expect(normalizePhone10("12345")).toBeNull();
    expect(normalizePhone10("")).toBeNull();
    expect(normalizePhone10(null)).toBeNull();
    expect(normalizePhone10(undefined)).toBeNull();
    expect(normalizePhone10("25551234567")).toBeNull(); // 11 digits, not US "1"
  });
});

describe("formatAccountNumberV2", () => {
  it("includes the phone segment when present", () => {
    expect(formatAccountNumberV2("L", 2026, 3, "5551234567")).toBe(
      "L-2026-3-5551234567"
    );
    expect(formatAccountNumberV2("P", 2026, 12, "5559876543")).toBe(
      "P-2026-12-5559876543"
    );
  });

  it("omits the phone segment when null", () => {
    expect(formatAccountNumberV2("L", 2026, 3, null)).toBe("L-2026-3");
    expect(formatAccountNumberV2("P", 2025, 1, null)).toBe("P-2025-1");
  });

  it("produces strings matching the canonical enforcement regex", () => {
    const canonical = /^[LP]-\d{4}-\d+(-\d{10})?$/;
    expect(formatAccountNumberV2("L", 2026, 3, "5551234567")).toMatch(canonical);
    expect(formatAccountNumberV2("P", 2026, 1, null)).toMatch(canonical);
  });
});
