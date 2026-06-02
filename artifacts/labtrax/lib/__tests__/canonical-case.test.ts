import { describe, it, expect } from "vitest";
import { generateId, isCanonicalCaseId, isCanonicalCase } from "../data";

describe("isCanonicalCaseId", () => {
  it("returns true for a gen_random_uuid()-style id", () => {
    expect(isCanonicalCaseId("fe67257e-3a1c-4b2d-9e8f-1a2b3c4d5e6f")).toBe(true);
    expect(isCanonicalCaseId("FE67257E-3A1C-4B2D-9E8F-1A2B3C4D5E6F")).toBe(true);
  });

  it("returns false for a legacy client-generated id (generateId)", () => {
    // generateId() = Date.now() + base36 random — never a UUID.
    for (let i = 0; i < 50; i++) {
      expect(isCanonicalCaseId(generateId())).toBe(false);
    }
  });

  it("returns false for non-uuid / empty / nullish ids", () => {
    expect(isCanonicalCaseId("1780412210244d72bb917")).toBe(false);
    expect(isCanonicalCaseId("c_aed8748654864614")).toBe(false);
    expect(isCanonicalCaseId("")).toBe(false);
    expect(isCanonicalCaseId(null)).toBe(false);
    expect(isCanonicalCaseId(undefined)).toBe(false);
  });
});

describe("isCanonicalCase", () => {
  it("trusts the _sourceTable flag when present", () => {
    expect(isCanonicalCase({ id: "anything", _sourceTable: "cases" })).toBe(true);
    // Explicit legacy flag wins even over a uuid-shaped id (defensive).
    expect(
      isCanonicalCase({
        id: "fe67257e-3a1c-4b2d-9e8f-1a2b3c4d5e6f",
        _sourceTable: "lab_cases",
      })
    ).toBe(false);
  });

  it("falls back to the id shape when the flag is dropped by caching", () => {
    // This is the regression the fix guards against: a canonical case whose
    // _sourceTable was lost must still be detected as canonical so its
    // status/photo/note writes go to the canonical endpoints, not legacy.
    expect(isCanonicalCase({ id: "fe67257e-3a1c-4b2d-9e8f-1a2b3c4d5e6f" })).toBe(
      true
    );
    expect(isCanonicalCase({ id: generateId() })).toBe(false);
  });

  it("returns false for nullish input", () => {
    expect(isCanonicalCase(null)).toBe(false);
    expect(isCanonicalCase(undefined)).toBe(false);
    expect(isCanonicalCase({})).toBe(false);
  });
});
