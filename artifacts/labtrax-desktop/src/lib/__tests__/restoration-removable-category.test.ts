/**
 * Unit tests for the desktop restoration-category classifier.
 *
 * Invariants protected:
 *  - isRemovableRestorationType returns true for all five removable keyword
 *    families (denture, partial, flipper, flexible, Valplast) regardless of
 *    surrounding words or letter case.
 *  - Crown/bridge and implant types are NOT classified as removable (priority
 *    rule: crown_bridge > removable > other).
 *  - null / undefined / empty string are not removable.
 *
 * If a future refactor changes the REMOVABLE_RE regex or the priority order,
 * these tests will fail and block the regression before it ships.
 */
import { describe, it, expect } from "vitest";
import {
  classifyRestorationType,
  isRemovableRestorationType,
} from "@/lib/restoration-category";

describe("classifyRestorationType — removable family", () => {
  it("classifies 'denture' keyword variants as removable", () => {
    expect(classifyRestorationType("Full Denture")).toBe("removable");
    expect(classifyRestorationType("Partial Denture")).toBe("removable");
    expect(classifyRestorationType("Immediate Denture")).toBe("removable");
  });

  it("classifies 'partial' keyword as removable", () => {
    expect(classifyRestorationType("Partial")).toBe("removable");
    expect(classifyRestorationType("RPD Partial")).toBe("removable");
  });

  it("classifies 'flipper' keyword as removable", () => {
    expect(classifyRestorationType("Flipper")).toBe("removable");
    expect(classifyRestorationType("Acrylic Flipper")).toBe("removable");
  });

  it("classifies 'flexible' keyword as removable", () => {
    expect(classifyRestorationType("Flexible")).toBe("removable");
    expect(classifyRestorationType("Flexible Partial")).toBe("removable");
  });

  it("classifies 'Valplast' keyword as removable", () => {
    expect(classifyRestorationType("Valplast")).toBe("removable");
    expect(classifyRestorationType("Valplast Partial")).toBe("removable");
  });

  it("is case-insensitive for all five keyword families", () => {
    expect(classifyRestorationType("full denture")).toBe("removable");
    expect(classifyRestorationType("PARTIAL")).toBe("removable");
    expect(classifyRestorationType("FLIPPER")).toBe("removable");
    expect(classifyRestorationType("FLEXIBLE")).toBe("removable");
    expect(classifyRestorationType("VALPLAST")).toBe("removable");
  });
});

describe("classifyRestorationType — priority: crown_bridge wins over removable", () => {
  it("treats implant + denture as crown_bridge (implant keyword wins)", () => {
    expect(classifyRestorationType("Implant Denture")).toBe("crown_bridge");
  });

  it("treats bridge + partial as crown_bridge (bridge keyword wins)", () => {
    expect(classifyRestorationType("Bridge Partial")).toBe("crown_bridge");
  });

  it("treats crown keyword alone as crown_bridge, not removable", () => {
    expect(classifyRestorationType("Crown")).toBe("crown_bridge");
    expect(classifyRestorationType("PFM Crown")).toBe("crown_bridge");
  });
});

describe("classifyRestorationType — non-removable", () => {
  it("classifies night guard and retainer as other", () => {
    expect(classifyRestorationType("Night Guard")).toBe("other");
    expect(classifyRestorationType("Retainer")).toBe("other");
    expect(classifyRestorationType("Sports Guard")).toBe("other");
  });

  it("returns other for null, undefined, and empty string", () => {
    expect(classifyRestorationType(null)).toBe("other");
    expect(classifyRestorationType(undefined)).toBe("other");
    expect(classifyRestorationType("")).toBe("other");
  });
});

describe("isRemovableRestorationType — all five keyword variants", () => {
  it("returns true for denture", () => {
    expect(isRemovableRestorationType("Full Denture")).toBe(true);
    expect(isRemovableRestorationType("Partial Denture")).toBe(true);
  });

  it("returns true for partial", () => {
    expect(isRemovableRestorationType("Partial")).toBe(true);
  });

  it("returns true for flipper", () => {
    expect(isRemovableRestorationType("Flipper")).toBe(true);
  });

  it("returns true for flexible", () => {
    expect(isRemovableRestorationType("Flexible Partial")).toBe(true);
  });

  it("returns true for Valplast", () => {
    expect(isRemovableRestorationType("Valplast")).toBe(true);
  });

  it("returns false for fixed/crown-bridge types", () => {
    expect(isRemovableRestorationType("Crown")).toBe(false);
    expect(isRemovableRestorationType("Bridge")).toBe(false);
    expect(isRemovableRestorationType("Veneer")).toBe(false);
    expect(isRemovableRestorationType("Implant Crown")).toBe(false);
  });

  it("returns false for null, undefined, and empty string", () => {
    expect(isRemovableRestorationType(null)).toBe(false);
    expect(isRemovableRestorationType(undefined)).toBe(false);
    expect(isRemovableRestorationType("")).toBe(false);
  });

  it("crown_bridge priority prevents removable keyword from winning", () => {
    expect(isRemovableRestorationType("Implant Denture")).toBe(false);
  });
});
