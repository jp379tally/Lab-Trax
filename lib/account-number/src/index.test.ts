import { describe, expect, it } from "vitest";
import {
  ACCOUNT_NUMBER_AFFINE_MULTIPLIER,
  ACCOUNT_NUMBER_MODULUS,
  calculateLuhnCheckDigit,
  classifyAccountNumber,
  formatAccountNumberForDisplay,
  generateAccountNumberFromSequence,
  isValidLuhn,
  normalizeAccountNumberInput,
} from "./index";

describe("@workspace/account-number", () => {
  it("generates twelve ASCII digits in a 4-4-4 display grouping", () => {
    const account = generateAccountNumberFromSequence(1);
    expect(account).toMatch(/^7\d{11}$/);
    expect(formatAccountNumberForDisplay(account)).toMatch(/^7\d{3} \d{4} \d{4}$/);
    expect(classifyAccountNumber(account)).toBe("new-valid");
  });

  it("is unique and detects every non-identical adjacent swap", () => {
    const issued = Array.from({ length: 10_000 }, (_, sequence) =>
      generateAccountNumberFromSequence(sequence),
    );
    expect(new Set(issued).size).toBe(issued.length);
    for (const account of issued) {
      expect(account).not.toMatch(/09|90/);
      for (let index = 0; index < account.length - 1; index += 1) {
        if (account[index] === account[index + 1]) continue;
        const chars = account.split("");
        [chars[index], chars[index + 1]] = [chars[index + 1]!, chars[index]!];
        expect(isValidLuhn(chars.join(""))).toBe(false);
      }
    }
    expect(ACCOUNT_NUMBER_AFFINE_MULTIPLIER).toBeGreaterThan(0n);
    expect(ACCOUNT_NUMBER_MODULUS).toBe(2_147_483_647n);
  });

  it("classifies malformed marked numbers and preserves legacy formatting", () => {
    const valid = generateAccountNumberFromSequence(9);
    const bad = `${valid.slice(0, -1)}${(Number(valid.at(-1)) + 1) % 10}`;
    const badVersion = `6${valid.slice(1)}`;
    expect(classifyAccountNumber(bad)).toBe("new-invalid");
    expect(classifyAccountNumber(badVersion)).toBe("new-invalid");
    expect(formatAccountNumberForDisplay("ABC-123")).toBe("ABC-123");
    expect(normalizeAccountNumberInput(` ${valid.slice(0, 4)} ${valid.slice(4)} `)).toBe(
      valid,
    );
  });

  it("calculates and validates Luhn check digits", () => {
    expect(calculateLuhnCheckDigit("7992739871")).toBe(3);
    expect(isValidLuhn("79927398713")).toBe(true);
  });
});