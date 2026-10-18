import { describe, expect, it } from "vitest";
import {
  deriveDoctorInitials,
  parseAccountNumbers,
  standaloneAccountNumberBase,
} from "./provider-account-number";

describe("standalone provider account numbers", () => {
  it("builds a stable P-prefixed base from address and practice", () => {
    expect(standaloneAccountNumberBase({
      addressLine1: "123 Main Street",
      practiceName: "Bright Care",
    })).toBe("P-123-BC");
  });

  it("supports suffix allocation without treating an existing suffix as available", () => {
    const used = new Set(parseAccountNumbers("P-123-BC-1; P-123-BC-3"));
    const next = [1, 2, 3, 4].find((suffix) => !used.has(`P-123-BC-${suffix}`));
    expect(next).toBe(2);
    expect(deriveDoctorInitials("Dr. Jane Smith")).toBe("JS");
  });
});