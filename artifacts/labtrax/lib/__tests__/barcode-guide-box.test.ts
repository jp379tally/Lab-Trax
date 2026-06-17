import { describe, it, expect } from "vitest";
import {
  barcodeCenter,
  filterBarcodesInBox,
  pickClosestToCenter,
  pickBestBarcode,
  guideBoxFromLayout,
  type BarcodeCandidate,
  type GuideBox,
} from "@/lib/barcode-guide-box";

// A 400×600 camera view with a box at 20%/20% left/top, 60% wide, 60% tall
const STANDARD_BOX: GuideBox = { x: 80, y: 120, width: 240, height: 360 };

function makeBarcode(
  data: string,
  cx: number,
  cy: number,
  size = 40,
): BarcodeCandidate {
  return {
    data,
    bounds: {
      origin: { x: cx - size / 2, y: cy - size / 2 },
      size: { width: size, height: size },
    },
  };
}

function makeBarcodeCorners(
  data: string,
  cx: number,
  cy: number,
  half = 20,
): BarcodeCandidate {
  return {
    data,
    cornerPoints: [
      { x: cx - half, y: cy - half },
      { x: cx + half, y: cy - half },
      { x: cx + half, y: cy + half },
      { x: cx - half, y: cy + half },
    ],
  };
}

function noBounds(data: string): BarcodeCandidate {
  return { data };
}

// ── barcodeCenter ─────────────────────────────────────────────────────────────

describe("barcodeCenter", () => {
  it("computes center from bounds", () => {
    const b = makeBarcode("A", 200, 300);
    const c = barcodeCenter(b);
    expect(c).toEqual({ x: 200, y: 300 });
  });

  it("computes center from cornerPoints", () => {
    const b = makeBarcodeCorners("B", 150, 250);
    const c = barcodeCenter(b);
    expect(c).toEqual({ x: 150, y: 250 });
  });

  it("prefers bounds over cornerPoints when both are present", () => {
    const b: BarcodeCandidate = {
      data: "C",
      bounds: { origin: { x: 100, y: 100 }, size: { width: 40, height: 40 } },
      cornerPoints: [{ x: 0, y: 0 }, { x: 500, y: 500 }],
    };
    const c = barcodeCenter(b);
    expect(c).toEqual({ x: 120, y: 120 });
  });

  it("returns null when no usable position data", () => {
    expect(barcodeCenter(noBounds("X"))).toBeNull();
    expect(barcodeCenter({ data: "X", bounds: null })).toBeNull();
    expect(barcodeCenter({ data: "X", cornerPoints: [] })).toBeNull();
    expect(barcodeCenter({ data: "X", cornerPoints: [{ x: 0, y: 0 }] })).toBeNull();
  });

  it("handles a zero-size bounds object by falling back to cornerPoints", () => {
    const b: BarcodeCandidate = {
      data: "Z",
      bounds: { origin: { x: 50, y: 50 }, size: { width: 0, height: 0 } },
      cornerPoints: [
        { x: 40, y: 40 },
        { x: 60, y: 40 },
        { x: 60, y: 60 },
        { x: 40, y: 60 },
      ],
    };
    const c = barcodeCenter(b);
    expect(c).toEqual({ x: 50, y: 50 });
  });
});

// ── filterBarcodesInBox ───────────────────────────────────────────────────────

describe("filterBarcodesInBox", () => {
  it("keeps a barcode whose center is inside the box", () => {
    const b = makeBarcode("IN", 200, 300); // center at box center (200,300)
    expect(filterBarcodesInBox([b], STANDARD_BOX)).toHaveLength(1);
  });

  it("removes a barcode whose center is outside the box", () => {
    const b = makeBarcode("OUT", 10, 10); // far top-left
    expect(filterBarcodesInBox([b], STANDARD_BOX)).toHaveLength(0);
  });

  it("keeps a barcode sitting exactly on the box edge", () => {
    const b = makeBarcode("EDGE", 80, 120); // top-left corner of box
    expect(filterBarcodesInBox([b], STANDARD_BOX)).toHaveLength(1);
  });

  it("passes through a barcode with no bounds (graceful fallback)", () => {
    const b = noBounds("NO_POS");
    expect(filterBarcodesInBox([b], STANDARD_BOX)).toHaveLength(1);
  });

  it("correctly splits a mixed list", () => {
    const barcodes: BarcodeCandidate[] = [
      makeBarcode("IN1", 150, 200),   // inside
      makeBarcode("OUT1", 5, 5),      // outside
      makeBarcode("IN2", 300, 400),   // inside
      makeBarcode("OUT2", 395, 595),  // outside
    ];
    const result = filterBarcodesInBox(barcodes, STANDARD_BOX);
    expect(result.map((b) => b.data)).toEqual(["IN1", "IN2"]);
  });

  it("returns empty list when no barcodes are in the box", () => {
    const barcodes = [makeBarcode("A", 5, 5), makeBarcode("B", 395, 595)];
    expect(filterBarcodesInBox(barcodes, STANDARD_BOX)).toHaveLength(0);
  });
});

// ── pickClosestToCenter ───────────────────────────────────────────────────────

describe("pickClosestToCenter", () => {
  const box = STANDARD_BOX; // center at (200, 300)

  it("returns null for an empty list", () => {
    expect(pickClosestToCenter([], box)).toBeNull();
  });

  it("returns the only element immediately", () => {
    const b = makeBarcode("SOLO", 150, 250);
    expect(pickClosestToCenter([b], box)).toBe(b);
  });

  it("picks the barcode closest to the box center", () => {
    const near = makeBarcode("NEAR", 200, 300);   // exactly at center
    const far = makeBarcode("FAR", 160, 200);     // further away
    expect(pickClosestToCenter([near, far], box)?.data).toBe("NEAR");
    expect(pickClosestToCenter([far, near], box)?.data).toBe("NEAR");
  });

  it("picks the closest among three candidates", () => {
    const a = makeBarcode("A", 200, 300); // center — dist 0
    const b = makeBarcode("B", 210, 310); // ~14 px away
    const c = makeBarcode("C", 160, 250); // ~63 px away
    expect(pickClosestToCenter([b, c, a], box)?.data).toBe("A");
  });

  it("falls back to the first no-position barcode when none have a center", () => {
    const b1 = noBounds("X");
    const b2 = noBounds("Y");
    const result = pickClosestToCenter([b1, b2], box);
    expect(result?.data).toBe("X");
  });

  it("prefers a positioned barcode over a no-position barcode", () => {
    const noPos = noBounds("NO_POS");
    const positioned = makeBarcode("POS", 200, 300);
    expect(pickClosestToCenter([noPos, positioned], box)?.data).toBe("POS");
  });
});

// ── pickBestBarcode ───────────────────────────────────────────────────────────

describe("pickBestBarcode", () => {
  it("returns null when no barcodes are provided", () => {
    expect(pickBestBarcode([], STANDARD_BOX)).toBeNull();
  });

  it("returns null when all barcodes are outside the box", () => {
    const barcodes = [makeBarcode("A", 5, 5), makeBarcode("B", 395, 595)];
    expect(pickBestBarcode(barcodes, STANDARD_BOX)).toBeNull();
  });

  it("returns the only in-box barcode directly", () => {
    const inBox = makeBarcode("IN", 200, 300);
    const outBox = makeBarcode("OUT", 5, 5);
    expect(pickBestBarcode([inBox, outBox], STANDARD_BOX)?.data).toBe("IN");
  });

  it("picks the closest in-box barcode when multiple are present", () => {
    const near = makeBarcode("NEAR", 200, 300); // at center
    const further = makeBarcode("FAR", 100, 150); // in box but further
    const outside = makeBarcode("OUT", 5, 5);
    expect(pickBestBarcode([further, near, outside], STANDARD_BOX)?.data).toBe("NEAR");
  });

  it("passes through a no-position barcode that falls inside by fallback", () => {
    const b = noBounds("FALLBACK");
    const result = pickBestBarcode([b], STANDARD_BOX);
    expect(result?.data).toBe("FALLBACK");
  });
});

// ── guideBoxFromLayout ────────────────────────────────────────────────────────

describe("guideBoxFromLayout", () => {
  it("computes the single-locate reticle box (12%/28%/12%/44%)", () => {
    const box = guideBoxFromLayout(400, 600, 0.12, 0.28, 0.12, 0.44);
    expect(box.x).toBeCloseTo(48);
    expect(box.y).toBeCloseTo(168);
    expect(box.width).toBeCloseTo(304);   // 400 * 0.76
    expect(box.height).toBeCloseTo(264);  // 600 * 0.44
  });

  it("computes the batch-locate reticle box (20%/20%/20%/60%)", () => {
    const box = guideBoxFromLayout(400, 200, 0.2, 0.2, 0.2, 0.6);
    expect(box.x).toBeCloseTo(80);
    expect(box.y).toBeCloseTo(40);
    expect(box.width).toBeCloseTo(240);  // 400 * 0.60
    expect(box.height).toBeCloseTo(120); // 200 * 0.60
  });

  it("handles a square view with no insets (0/0/0/1)", () => {
    const box = guideBoxFromLayout(100, 100, 0, 0, 0, 1);
    expect(box).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});
