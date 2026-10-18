import { describe, it, expect } from "vitest";
import {
  barcodeCenter,
  filterBarcodesInBox,
  pickClosestToCenter,
  pickBestBarcode,
  guideBoxFromFractions,
  mapFramePointToPreview,
  type BarcodeCandidate,
  type GuideBox,
} from "@/lib/barcode-guide-box";
import { codesToBarcodeCandidates } from "@/lib/vision-camera-codes";

const STANDARD_BOX: GuideBox = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
const PORTRAIT_PREVIEW = { width: 400, height: 600 };
const LANDSCAPE_FRAME = { width: 1920, height: 1080 };

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
    sourceFrame: LANDSCAPE_FRAME,
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
    sourceFrame: LANDSCAPE_FRAME,
  };
}

function noBounds(data: string): BarcodeCandidate {
  return { data };
}

// ── barcodeCenter ─────────────────────────────────────────────────────────────

describe("barcodeCenter", () => {
  it("computes center from bounds", async () => {
    const b = makeBarcode("A", 0.5, 0.5, 0.1);
    const c = barcodeCenter(b);
    expect(c).toEqual({ x: 0.5, y: 0.5 });
  });

  it("computes center from cornerPoints", async () => {
    const b = makeBarcodeCorners("B", 0.4, 0.6, 0.05);
    const c = barcodeCenter(b);
    expect(c).toEqual({ x: 0.4, y: 0.6 });
  });

  it("prefers bounds over cornerPoints when both are present", async () => {
    const b: BarcodeCandidate = {
      data: "C",
      bounds: { origin: { x: 0.1, y: 0.1 }, size: { width: 0.2, height: 0.2 } },
      cornerPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    };
    const c = barcodeCenter(b);
    expect(c).toEqual({ x: 0.2, y: 0.2 });
  });

  it("returns null when no usable position data", async () => {
    expect(barcodeCenter(noBounds("X"))).toBeNull();
    expect(barcodeCenter({ data: "X", bounds: null })).toBeNull();
    expect(barcodeCenter({ data: "X", cornerPoints: [] })).toBeNull();
    expect(barcodeCenter({ data: "X", cornerPoints: [{ x: 0, y: 0 }] })).toBeNull();
  });

  it("handles a zero-size bounds object by falling back to cornerPoints", async () => {
    const b: BarcodeCandidate = {
      data: "Z",
      bounds: { origin: { x: 0.5, y: 0.5 }, size: { width: 0, height: 0 } },
      cornerPoints: [
        { x: 0.4, y: 0.4 },
        { x: 0.6, y: 0.4 },
        { x: 0.6, y: 0.6 },
        { x: 0.4, y: 0.6 },
      ],
    };
    const c = barcodeCenter(b);
    expect(c).toEqual({ x: 0.5, y: 0.5 });
  });
});

// ── filterBarcodesInBox ───────────────────────────────────────────────────────

describe("filterBarcodesInBox", () => {
  it("keeps a barcode whose center is inside the box", async () => {
    const b = makeBarcode("IN", 0.5, 0.5, 0.1);
    expect(filterBarcodesInBox([b], STANDARD_BOX, PORTRAIT_PREVIEW)).toHaveLength(1);
  });

  it("removes a barcode whose center is outside the box", async () => {
    const inside = makeBarcode("IN", 0.5, 0.5, 0.1);
    const outside = makeBarcode("OUT", 0.02, 0.02, 0.01);
    expect(
      filterBarcodesInBox([inside, outside], STANDARD_BOX, PORTRAIT_PREVIEW),
    ).toEqual([inside]);
  });

  it("keeps a barcode sitting exactly on the box edge", async () => {
    const b = makeBarcode("EDGE", 0.5, 0.2, 0.01);
    expect(filterBarcodesInBox([b], STANDARD_BOX, PORTRAIT_PREVIEW)).toHaveLength(1);
  });

  it("passes through a barcode with no bounds (graceful fallback)", async () => {
    const b = noBounds("NO_POS");
    expect(filterBarcodesInBox([b], STANDARD_BOX, PORTRAIT_PREVIEW)).toHaveLength(1);
  });

  it("correctly splits a mixed list", async () => {
    const barcodes: BarcodeCandidate[] = [
      makeBarcode("IN1", 0.5, 0.45, 0.05),
      makeBarcode("OUT1", 0.02, 0.02, 0.01),
      makeBarcode("IN2", 0.5, 0.55, 0.05),
      makeBarcode("OUT2", 0.98, 0.98, 0.01),
    ];
    const result = filterBarcodesInBox(barcodes, STANDARD_BOX, PORTRAIT_PREVIEW);
    expect(result.map((b) => b.data)).toEqual(["IN1", "IN2"]);
  });

  it("keeps decoded barcodes when every position is outside the box", async () => {
    const barcodes = [
      makeBarcode("A", 0.02, 0.02, 0.01),
      makeBarcode("B", 0.98, 0.98, 0.01),
    ];
    expect(
      filterBarcodesInBox(barcodes, STANDARD_BOX, PORTRAIT_PREVIEW),
    ).toEqual(barcodes);
  });
});

// ── pickClosestToCenter ───────────────────────────────────────────────────────

describe("pickClosestToCenter", () => {
  const box = STANDARD_BOX; // center at (200, 300)

  it("returns null for an empty list", async () => {
    expect(pickClosestToCenter([], box)).toBeNull();
  });

  it("returns the only element immediately", async () => {
    const b = makeBarcode("SOLO", 0.5, 0.5);
    expect(pickClosestToCenter([b], box, PORTRAIT_PREVIEW)).toBe(b);
  });

  it("picks the barcode closest to the box center", async () => {
    const near = makeBarcode("NEAR", 0.5, 0.5);
    const far = makeBarcode("FAR", 0.35, 0.35);
    expect(pickClosestToCenter([near, far], box, PORTRAIT_PREVIEW)?.data).toBe("NEAR");
    expect(pickClosestToCenter([far, near], box, PORTRAIT_PREVIEW)?.data).toBe("NEAR");
  });

  it("picks the closest among three candidates", async () => {
    const a = makeBarcode("A", 0.5, 0.5);
    const b = makeBarcode("B", 0.52, 0.52);
    const c = makeBarcode("C", 0.35, 0.35);
    expect(pickClosestToCenter([b, c, a], box, PORTRAIT_PREVIEW)?.data).toBe("A");
  });

  it("falls back to the first no-position barcode when none have a center", async () => {
    const b1 = noBounds("X");
    const b2 = noBounds("Y");
    const result = pickClosestToCenter([b1, b2], box);
    expect(result?.data).toBe("X");
  });

  it("prefers a positioned barcode over a no-position barcode", async () => {
    const noPos = noBounds("NO_POS");
    const positioned = makeBarcode("POS", 0.5, 0.5);
    expect(pickClosestToCenter([noPos, positioned], box, PORTRAIT_PREVIEW)?.data).toBe("POS");
  });
});

// ── pickBestBarcode ───────────────────────────────────────────────────────────

describe("pickBestBarcode", () => {
  it("returns null when no barcodes are provided", async () => {
    expect(pickBestBarcode([], STANDARD_BOX)).toBeNull();
  });

  it("falls back to the closest barcode when all are outside the box", async () => {
    const barcodes = [makeBarcode("A", 5, 5), makeBarcode("B", 395, 595)];
    expect(pickBestBarcode(barcodes, STANDARD_BOX, PORTRAIT_PREVIEW)).not.toBeNull();
  });

  it("returns the only in-box barcode directly", async () => {
    const inBox = makeBarcode("IN", 0.5, 0.5);
    const outBox = makeBarcode("OUT", 0.02, 0.02);
    expect(pickBestBarcode([inBox, outBox], STANDARD_BOX, PORTRAIT_PREVIEW)?.data).toBe("IN");
  });

  it("picks the closest in-box barcode when multiple are present", async () => {
    const near = makeBarcode("NEAR", 0.5, 0.5);
    const further = makeBarcode("FAR", 0.4, 0.4);
    const outside = makeBarcode("OUT", 0.02, 0.02);
    expect(pickBestBarcode([further, near, outside], STANDARD_BOX, PORTRAIT_PREVIEW)?.data).toBe("NEAR");
  });

  it("passes through a no-position barcode that falls inside by fallback", async () => {
    const b = noBounds("FALLBACK");
    const result = pickBestBarcode([b], STANDARD_BOX);
    expect(result?.data).toBe("FALLBACK");
  });
});

describe("realistic VisionCamera coordinates", () => {
  it("accepts a centered buffer-scale barcode and deprioritizes an off-frame one", async () => {
    const candidates = codesToBarcodeCandidates(
      [
        {
          type: "code-128",
          value: "OFF",
          frame: { x: 10, y: 10, width: 180, height: 90 },
        },
        {
          type: "code-128",
          value: "CENTERED",
          frame: { x: 864, y: 486, width: 192, height: 108 },
        },
      ],
      LANDSCAPE_FRAME,
    );
    expect(
      pickBestBarcode(candidates, STANDARD_BOX, PORTRAIT_PREVIEW)?.data,
    ).toBe("CENTERED");
  });

  it("rotates and cover-crops landscape frame points into portrait preview space", async () => {
    expect(
      mapFramePointToPreview(
        { x: 0.5, y: 0.5 },
        LANDSCAPE_FRAME,
        PORTRAIT_PREVIEW,
      ),
    ).toEqual({ x: 0.5, y: 0.5 });
  });
});

// ── guideBoxFromFractions ─────────────────────────────────────────────────────

describe("guideBoxFromFractions", () => {
  it("computes the single-locate reticle box (12%/28%/12%/44%)", async () => {
    const box = guideBoxFromFractions(0.12, 0.28, 0.12, 0.44);
    expect(box).toEqual({ x: 0.12, y: 0.28, width: 0.76, height: 0.44 });
  });

  it("computes the batch-locate reticle box (20%/20%/20%/60%)", async () => {
    const box = guideBoxFromFractions(0.2, 0.2, 0.2, 0.6);
    expect(box.x).toBeCloseTo(0.2);
    expect(box.y).toBeCloseTo(0.2);
    expect(box.width).toBeCloseTo(0.6);
    expect(box.height).toBeCloseTo(0.6);
  });

  it("handles no insets (0/0/0/1)", async () => {
    const box = guideBoxFromFractions(0, 0, 0, 1);
    expect(box).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});
