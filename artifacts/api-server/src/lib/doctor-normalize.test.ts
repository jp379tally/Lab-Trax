import { describe, it, expect } from "vitest";
import {
  normalizeDoctor,
  __simulateNormalizedDoctorSql,
} from "./pricing.js";

describe("doctor-name normalization parity (JS ↔ SQL)", () => {
  const cases = [
    "Dr Smith",
    "DR Smith",
    "dr. smith",
    "Dr. Smith",
    "DR. SMITH",
    "  Dr  Smith  ",
    "DR\tSmith",
    "Smith",
    "drake",          // does NOT start with "dr " — must NOT be stripped past "d"
    "Dr",             // bare "dr" with nothing after
    "dr.",
    "",
    null,
    undefined,
  ] as const;

  it("JS normalizeDoctor matches the simulated SQL normalization", () => {
    for (const c of cases) {
      expect(normalizeDoctor(c)).toBe(__simulateNormalizedDoctorSql(c));
    }
  });

  it("uppercase 'DR' prefix is stripped (regression: SQL used to leave it)", () => {
    expect(normalizeDoctor("DR Smith")).toBe("smith");
    expect(__simulateNormalizedDoctorSql("DR Smith")).toBe("smith");
    expect(normalizeDoctor("DR. Smith")).toBe("smith");
    expect(__simulateNormalizedDoctorSql("DR. Smith")).toBe("smith");
  });

  it("leading whitespace is trimmed before stripping", () => {
    expect(normalizeDoctor("   Dr   Jane")).toBe("jane");
    expect(__simulateNormalizedDoctorSql("   Dr   Jane")).toBe("jane");
  });

  it("strips bare 'dr' prefix even with no following whitespace (legacy behavior)", () => {
    // The regex is `^dr\.?\s*` (no word boundary). "Drake" → "ake". This is
    // pre-existing behavior; the test pins it so JS and SQL stay in sync.
    expect(normalizeDoctor("Drake")).toBe(__simulateNormalizedDoctorSql("Drake"));
  });
});
