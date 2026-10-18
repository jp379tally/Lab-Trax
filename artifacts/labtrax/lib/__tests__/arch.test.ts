import { describe, expect, it } from "vitest";
import { archSelectionFromRows, isArchRequired, normalizeArch } from "../arch";

describe("mobile arch billing helpers", () => {
  it("normalizes only durable arch values", () => {
    expect(normalizeArch("upper")).toBe("upper");
    expect(normalizeArch("lower")).toBe("lower");
    expect(normalizeArch("both")).toBeNull();
    expect(normalizeArch("Upper")).toBeNull();
  });

  it("infers Upper + Lower from two durable restoration rows", () => {
    expect(archSelectionFromRows([{ arch: "upper" }, { arch: "lower" }])).toBe("both");
    expect(archSelectionFromRows([{ arch: "upper" }])).toBe("upper");
    expect(archSelectionFromRows([{ arch: "lower" }])).toBe("lower");
    expect(archSelectionFromRows([{ arch: null }])).toBeNull();
  });

  it("requires an arch only for removable and ortho", () => {
    expect(isArchRequired("removable")).toBe(true);
    expect(isArchRequired("ortho")).toBe(true);
    expect(isArchRequired("restorative")).toBe(false);
  });
});