import { describe, it, expect } from "vitest";
import {
  mapAiRemovableSubtype,
  isAmbiguousRemovableSubtype,
} from "./ai-removable-subtype.js";

describe("mapAiRemovableSubtype", () => {
  it('maps "flipper" → "flippers"', () => {
    expect(mapAiRemovableSubtype("flipper")).toBe("flippers");
  });

  it('maps "partial" → "partials"', () => {
    expect(mapAiRemovableSubtype("partial")).toBe("partials");
  });

  it('maps "denture" → "dentures"', () => {
    expect(mapAiRemovableSubtype("denture")).toBe("dentures");
  });

  it('maps "repair_partial" → "repair_partial"', () => {
    expect(mapAiRemovableSubtype("repair_partial")).toBe("repair_partial");
  });

  it('maps "repair_denture" → "repair_denture"', () => {
    expect(mapAiRemovableSubtype("repair_denture")).toBe("repair_denture");
  });

  it('maps "repair" (ambiguous) → null', () => {
    // "repair" has no direct taxonomy key; triggers aiPricingWarning instead.
    expect(mapAiRemovableSubtype("repair")).toBeNull();
  });

  it("maps null → null", () => {
    expect(mapAiRemovableSubtype(null)).toBeNull();
  });

  it("maps undefined → null", () => {
    expect(mapAiRemovableSubtype(undefined)).toBeNull();
  });

  it("maps unrecognised string → null", () => {
    expect(mapAiRemovableSubtype("overdenture")).toBeNull();
  });
});

describe("isAmbiguousRemovableSubtype", () => {
  it('returns true for "repair"', () => {
    expect(isAmbiguousRemovableSubtype("repair")).toBe(true);
  });

  it('returns false for "repair_partial"', () => {
    expect(isAmbiguousRemovableSubtype("repair_partial")).toBe(false);
  });

  it('returns false for "repair_denture"', () => {
    expect(isAmbiguousRemovableSubtype("repair_denture")).toBe(false);
  });

  it('returns false for "flipper"', () => {
    expect(isAmbiguousRemovableSubtype("flipper")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAmbiguousRemovableSubtype(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAmbiguousRemovableSubtype(undefined)).toBe(false);
  });
});

// ── Step field suppression for repair cases ─────────────────────────────────

describe("repair case step suppression contract", () => {
  // The AI prompt instructs: for any repair subtype, leave `step` null.
  // The extraction code never reads a `step` field from the AI JSON output,
  // so step is always null on AI-imported cases regardless of subtype.
  // These tests assert that mapAiRemovableSubtype never returns a value that
  // would trigger wax_setup / custom_tray step inference elsewhere.

  it("repair_partial is a valid taxonomy subtype (no step logic applies)", () => {
    // repair_partial is a recognized removable subtype with no multi-stage
    // workflow steps — it should not be confused with fabrication subtypes.
    const mapped = mapAiRemovableSubtype("repair_partial");
    expect(mapped).toBe("repair_partial");
    // Repair subtypes are never "flippers", "partials", "dentures" (fabrication),
    // so any step inference gated on those keys won't fire for repair cases.
    expect(mapped).not.toBe("flippers");
    expect(mapped).not.toBe("partials");
    expect(mapped).not.toBe("dentures");
  });

  it("repair_denture is a valid taxonomy subtype (no step logic applies)", () => {
    const mapped = mapAiRemovableSubtype("repair_denture");
    expect(mapped).toBe("repair_denture");
    expect(mapped).not.toBe("dentures");
  });
});
