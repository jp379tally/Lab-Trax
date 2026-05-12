import { describe, it, expect } from "vitest";
import {
  deriveAccountNameParts,
  formatPlatformAccountNumber,
} from "./platform-account-number.js";

describe("deriveAccountNameParts", () => {
  it("uses firstName + lastName when present", () => {
    expect(
      deriveAccountNameParts({ firstName: "John", lastName: "Watson" })
    ).toEqual({ first: "J", last: "W" });
  });

  it("falls back to X for missing pieces", () => {
    expect(deriveAccountNameParts({ firstName: "John" })).toEqual({
      first: "J",
      last: "X",
    });
    expect(deriveAccountNameParts({})).toEqual({ first: "X", last: "X" });
  });

  it("strips Dr. prefix and non-letter chars", () => {
    expect(
      deriveAccountNameParts({ doctorName: "Dr. John A. Watson, DDS" })
    ).toEqual({ first: "J", last: "D" });
  });

  it("uses first+last word of doctorName", () => {
    expect(
      deriveAccountNameParts({ doctorName: "John Quincy Watson" })
    ).toEqual({ first: "J", last: "W" });
  });

  it("falls back to practiceName when doctorName missing", () => {
    expect(
      deriveAccountNameParts({ practiceName: "Pearl Dental Group" })
    ).toEqual({ first: "P", last: "G" });
  });

  it("handles single-token names by repeating the only initial", () => {
    expect(deriveAccountNameParts({ doctorName: "Cher" })).toEqual({
      first: "C",
      last: "H",
    });
  });

  it("handles single-letter token without crashing", () => {
    expect(deriveAccountNameParts({ doctorName: "Q" })).toEqual({
      first: "Q",
      last: "Q",
    });
  });

  it("uppercases lowercase initials", () => {
    expect(
      deriveAccountNameParts({ firstName: "john", lastName: "watson" })
    ).toEqual({ first: "J", last: "W" });
  });
});

describe("formatPlatformAccountNumber", () => {
  it("matches the spec example", () => {
    expect(
      formatPlatformAccountNumber(29, 2026, { first: "J", last: "W" })
    ).toBe("2926JW");
  });

  it("does not pad the sequence", () => {
    expect(
      formatPlatformAccountNumber(1, 2026, { first: "A", last: "B" })
    ).toBe("126AB");
    expect(
      formatPlatformAccountNumber(1234, 2026, { first: "A", last: "B" })
    ).toBe("123426AB");
  });

  it("uses the last two digits of the year", () => {
    expect(
      formatPlatformAccountNumber(7, 2099, { first: "X", last: "Y" })
    ).toBe("799XY");
    expect(
      formatPlatformAccountNumber(7, 2000, { first: "X", last: "Y" })
    ).toBe("700XY");
  });
});
