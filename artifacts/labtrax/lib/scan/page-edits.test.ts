import { describe, expect, it } from "vitest";
import {
  clampNormalizedPoint,
  colorMatrixForFilter,
  FILTER_LABELS,
  makePageEdit,
  pageNeedsBake,
  reorderArray,
  rotateBy90,
} from "./page-edits";

describe("page-edits", () => {
  describe("makePageEdit", () => {
    it("creates a default page edit with no transforms", () => {
      const p = makePageEdit("file://foo.jpg");
      expect(p).toEqual({
        uri: "file://foo.jpg",
        rotation: 0,
        filter: "none",
        inkPaths: [],
        texts: [],
      });
    });
  });

  describe("rotateBy90", () => {
    it("cycles 0 -> 90 -> 180 -> 270 -> 0", () => {
      expect(rotateBy90(0)).toBe(90);
      expect(rotateBy90(90)).toBe(180);
      expect(rotateBy90(180)).toBe(270);
      expect(rotateBy90(270)).toBe(0);
    });

    it("normalises out-of-range and negative inputs", () => {
      expect(rotateBy90(360)).toBe(90);
      expect(rotateBy90(-90)).toBe(0);
      expect(rotateBy90(450)).toBe(180);
    });
  });

  describe("reorderArray", () => {
    it("moves an item from one index to another", () => {
      expect(reorderArray(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
      expect(reorderArray(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    });

    it("returns the original array when from===to or out-of-bounds", () => {
      const a = ["a", "b", "c"];
      expect(reorderArray(a, 1, 1)).toBe(a);
      expect(reorderArray(a, -1, 1)).toBe(a);
      expect(reorderArray(a, 1, 5)).toBe(a);
    });
  });

  describe("pageNeedsBake", () => {
    it("is false for a fresh page edit", () => {
      expect(pageNeedsBake(makePageEdit("u"))).toBe(false);
    });
    it("is true when filter is non-default", () => {
      expect(pageNeedsBake({ ...makePageEdit("u"), filter: "bw" })).toBe(true);
    });
    it("is true when there are ink paths or texts", () => {
      expect(pageNeedsBake({
        ...makePageEdit("u"),
        inkPaths: [{ d: "M0 0 L1 1", color: "#000", width: 4 }],
      })).toBe(true);
      expect(pageNeedsBake({
        ...makePageEdit("u"),
        texts: [{ id: "1", x: 0, y: 0, text: "hi", fontSize: 24, color: "#000" }],
      })).toBe(true);
    });
  });

  describe("clampNormalizedPoint", () => {
    it("clamps x and y to [0,1]", () => {
      expect(clampNormalizedPoint(-0.5, 1.5)).toEqual({ x: 0, y: 1 });
      expect(clampNormalizedPoint(0.3, 0.4)).toEqual({ x: 0.3, y: 0.4 });
    });
  });

  describe("colorMatrixForFilter", () => {
    it("returns null for none", () => {
      expect(colorMatrixForFilter("none")).toBeNull();
    });
    it("returns a 20-entry matrix for bw, enhance, color", () => {
      for (const f of ["bw", "enhance", "color"] as const) {
        const m = colorMatrixForFilter(f);
        expect(m).not.toBeNull();
        expect(m!.length).toBe(20);
      }
    });
  });

  describe("FILTER_LABELS", () => {
    it("has labels for every filter value", () => {
      expect(FILTER_LABELS.none).toBeTruthy();
      expect(FILTER_LABELS.bw).toBeTruthy();
      expect(FILTER_LABELS.enhance).toBeTruthy();
      expect(FILTER_LABELS.color).toBeTruthy();
    });
  });
});
