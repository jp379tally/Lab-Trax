/**
 * Unit tests for shared new-format account-number helpers.
 *
 * These are pure-function tests (no DB) covering the new format
 * Twelve-digit allocation is exercised by the shared package tests and the
 * transactional allocator by the DB-backed registration tests.
 */
import { describe, expect, it } from "vitest";
import {
  normalizePhone10,
} from "./platform-account-number";
import {
  classifyAccountNumber,
  formatAccountNumberForDisplay,
  generateAccountNumberFromSequence,
} from "@workspace/account-number";

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

describe("new account numbers", () => {
  it("formats and classifies generated numbers", () => {
    const account = generateAccountNumberFromSequence(3);
    expect(account).toMatch(/^7\d{11}$/);
    expect(classifyAccountNumber(account)).toBe("new-valid");
    expect(formatAccountNumberForDisplay(account)).toMatch(
      /^7\d{3} \d{4} \d{4}$/,
    );
  });

  it("rejects a marked number with a bad check digit", () => {
    const account = generateAccountNumberFromSequence(3);
    const invalid = `${account.slice(0, -1)}${(Number(account.at(-1)) + 1) % 10}`;
    expect(classifyAccountNumber(invalid)).toBe("new-invalid");
  });
});
