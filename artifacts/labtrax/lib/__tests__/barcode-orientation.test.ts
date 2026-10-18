/**
 * Barcode reticle behaviour across a device rotation — pure geometry.
 *
 * ── The contract these tests are anchored to ────────────────────────────────
 *
 * Read out of the installed react-native-vision-camera 4.7.3 source, not
 * assumed. On BOTH platforms the code scanner's coordinate space is pinned to
 * the *preview* orientation, never the device orientation:
 *
 *   iOS — ios/Core/CameraSession+Configuration.swift:
 *       // Code Scanner coordinates are relative to Preview Orientation
 *       codeScannerOutput.orientation = previewOrientation
 *     ios/Core/CameraSession+CodeScanner.swift then scales those normalized,
 *     preview-relative bounds by `device.activeFormat.videoDimensions` (the
 *     landscape *sensor* dimensions) and reports those same sensor dimensions
 *     as the CodeScannerFrame.
 *
 *   Android — core/CameraSession.kt configureOrientation():
 *       codeScannerOutput?.targetRotation = previewRotation
 *
 *   ios/Core/OrientationManager.swift:
 *       previewOrientation = sensorOrientation.relativeTo(interfaceOrientation)
 *
 * LabTrax is orientation-locked to portrait (app.json "orientation": "portrait"),
 * so `interfaceOrientation` never changes. Therefore **physically rotating the
 * phone does not change the code-scanner coordinate space at all** — the frame
 * stays the landscape sensor size and the coordinates stay preview-relative.
 * That invariance is the property this task is really about.
 *
 * Because `codesToBarcodeCandidates` divides the reported coordinates by the
 * reported frame, it exactly cancels iOS's multiply: candidates reach the
 * guide-box helpers already normalized **to the preview**. Fixtures below are
 * therefore written in preview-relative fractions, which is what the native
 * layer actually provides.
 *
 * ── What is deliberately NOT asserted here ──────────────────────────────────
 *
 * `mapFramePointToPreview` currently rotates unconditionally whenever the frame
 * is landscape and the preview is portrait. Under the contract above that
 * rotation looks unnecessary on iOS, and Android's ML Kit reports rotated
 * bounding boxes while `InputImage.getWidth()/getHeight()` may report the
 * unrotated buffer — a discrepancy that cannot be resolved without hardware.
 * That open question is tracked in docs/mobile-barcode-orientation-matrix.md.
 *
 * So the behavioural fixtures here are chosen to hold **either way** (they are
 * inside/outside the reticle under both the rotating and the non-rotating
 * model), and the mapping itself is covered separately by clearly-labelled
 * characterization tests that pin today's behaviour rather than bless it.
 */

import { describe, it, expect } from "vitest";
import {
  barcodeCenter,
  barcodeCenterInPreview,
  mapFramePointToPreview,
  filterBarcodesInBox,
  pickBestBarcode,
  guideBoxFromFractions,
  type BarcodeCandidate,
} from "../barcode-guide-box";
import { codesToBarcodeCandidates } from "../vision-camera-codes";
import type { Code } from "react-native-vision-camera";

// ── Contract fixtures ─────────────────────────────────────────────────────────

/** The preview never rotates: the app is portrait-locked. */
const PREVIEW = { width: 400, height: 600 };

/**
 * The CodeScannerFrame iOS reports: `activeFormat.videoDimensions`, i.e. the
 * landscape sensor size. Per the contract above this is the SAME whichever way
 * the phone is physically held.
 */
const SENSOR_FRAME = { width: 1920, height: 1080 };

/** The three shipped reticles, all centered on (0.5, 0.5). */
const RETICLES = [
  { name: "Dashboard Scan", box: guideBoxFromFractions(0.12, 0.28, 0.12, 0.44) },
  { name: "Batch Locate", box: guideBoxFromFractions(0.2, 0.2, 0.2, 0.6) },
  { name: "AI-reader", box: guideBoxFromFractions(0.15, 0.3, 0.15, 0.4) },
] as const;

/**
 * Build a native `Code` the way the iOS scanner does: preview-relative
 * normalized bounds multiplied by the reported (sensor) frame dimensions.
 */
function nativeCode(
  value: string,
  previewX: number,
  previewY: number,
  sizeFrac = 0.06,
): Code {
  const w = sizeFrac * SENSOR_FRAME.width;
  const h = sizeFrac * SENSOR_FRAME.height;
  return {
    type: "code-128",
    value,
    frame: {
      x: previewX * SENSOR_FRAME.width - w / 2,
      y: previewY * SENSOR_FRAME.height - h / 2,
      width: w,
      height: h,
    },
  };
}

function candidates(...codes: Code[]): BarcodeCandidate[] {
  return codesToBarcodeCandidates(codes, SENSOR_FRAME);
}

/**
 * Fixtures picked to sit inside/outside every reticle under BOTH the current
 * rotating mapping and the non-rotating one the contract implies, so these
 * assertions survive whichever way the open question is resolved.
 */
const CENTERED = { x: 0.5, y: 0.5 };
/** In-reticle but clearly off-center under both models. */
const OFF_CENTER = { x: 0.5, y: 0.62 };
/** Outside every reticle under both models. */
const OUTSIDE_HIGH = { x: 0.05, y: 0.5 };
const OUTSIDE_LOW = { x: 0.95, y: 0.5 };

// ── 1. The frame does not change when the phone rotates ───────────────────────

describe("code-scanner frame is pinned to the preview, not the device", () => {
  it("reports the same landscape sensor frame however the phone is held", async () => {
    // Both callbacks below are what the native layer emits for the same scene
    // before and after a 90° physical rotation, per the contract above.
    const upright = candidates(nativeCode("PAN-1", CENTERED.x, CENTERED.y));
    const rotated = candidates(nativeCode("PAN-1", CENTERED.x, CENTERED.y));

    expect(upright[0]!.sourceFrame).toEqual(SENSOR_FRAME);
    expect(rotated[0]!.sourceFrame).toEqual(SENSOR_FRAME);
    expect(rotated).toEqual(upright);
  });

  it("normalizing cancels the sensor-dimension scaling exactly", async () => {
    // iOS multiplies preview-relative bounds by the sensor dims; the adapter
    // divides by the same dims. The round trip must be lossless, or every
    // downstream reticle decision is skewed.
    const [candidate] = candidates(nativeCode("PAN-1", 0.25, 0.75));
    const center = barcodeCenter(candidate!);
    expect(center!.x).toBeCloseTo(0.25, 10);
    expect(center!.y).toBeCloseTo(0.75, 10);
  });

  it("keeps a decision stable when the same scene is re-reported after rotation", async () => {
    const before = candidates(
      nativeCode("CENTERED", CENTERED.x, CENTERED.y),
      nativeCode("OFF-CENTER", OFF_CENTER.x, OFF_CENTER.y),
    );
    const after = candidates(
      nativeCode("CENTERED", CENTERED.x, CENTERED.y),
      nativeCode("OFF-CENTER", OFF_CENTER.x, OFF_CENTER.y),
    );

    for (const { name, box } of RETICLES) {
      const a = pickBestBarcode(before, box, PREVIEW)?.data;
      const b = pickBestBarcode(after, box, PREVIEW)?.data;
      expect(a, name).toBe("CENTERED");
      expect(b, name).toBe(a);
    }
  });
});

// ── 2. Reticle invariants, per screen ─────────────────────────────────────────

describe.each(RETICLES)("$name reticle", ({ box }) => {
  it("accepts a barcode centered in the reticle", async () => {
    const found = pickBestBarcode(
      candidates(nativeCode("CENTERED", CENTERED.x, CENTERED.y)),
      box,
      PREVIEW,
    );
    expect(found?.data).toBe("CENTERED");
  });

  it("prefers the centered barcode over an off-center one", async () => {
    // Model-independent: a centered code maps to the box center under both
    // mappings, so its distance is 0 and nothing can beat it.
    const found = pickBestBarcode(
      candidates(
        nativeCode("OFF-CENTER", OFF_CENTER.x, OFF_CENTER.y),
        nativeCode("CENTERED", CENTERED.x, CENTERED.y),
      ),
      box,
      PREVIEW,
    );
    expect(found?.data).toBe("CENTERED");
  });

  it("prefers the centered barcode regardless of the order codes arrive in", async () => {
    const found = pickBestBarcode(
      candidates(
        nativeCode("CENTERED", CENTERED.x, CENTERED.y),
        nativeCode("OFF-CENTER", OFF_CENTER.x, OFF_CENTER.y),
      ),
      box,
      PREVIEW,
    );
    expect(found?.data).toBe("CENTERED");
  });

  it("excludes a barcode outside the reticle when a valid one is present", async () => {
    for (const outside of [OUTSIDE_HIGH, OUTSIDE_LOW]) {
      const kept = filterBarcodesInBox(
        candidates(
          nativeCode("OUTSIDE", outside.x, outside.y, 0.01),
          nativeCode("CENTERED", CENTERED.x, CENTERED.y),
        ),
        box,
        PREVIEW,
      ).map((c) => c.data);
      expect(kept).toEqual(["CENTERED"]);
    }
  });

  it("keeps every in-reticle barcode, not just the most centered one", async () => {
    // Batch Locate depends on this: its reticle is a boundary, not a tiebreak.
    const kept = filterBarcodesInBox(
      candidates(
        nativeCode("CENTERED", CENTERED.x, CENTERED.y),
        nativeCode("OFF-CENTER", OFF_CENTER.x, OFF_CENTER.y),
        nativeCode("OUTSIDE", OUTSIDE_LOW.x, OUTSIDE_LOW.y, 0.01),
      ),
      box,
      PREVIEW,
    ).map((c) => c.data);
    expect(kept.sort()).toEqual(["CENTERED", "OFF-CENTER"]);
  });
});

// ── 3. Nothing is silently discarded ──────────────────────────────────────────

describe("no decoded scan is silently discarded", () => {
  const box = RETICLES[0].box;

  it("falls back to the full list when every barcode is outside the reticle", async () => {
    const list = candidates(
      nativeCode("OUT-A", OUTSIDE_HIGH.x, OUTSIDE_HIGH.y, 0.01),
      nativeCode("OUT-B", OUTSIDE_LOW.x, OUTSIDE_LOW.y, 0.01),
    );
    expect(filterBarcodesInBox(list, box, PREVIEW).map((c) => c.data)).toEqual([
      "OUT-A",
      "OUT-B",
    ]);
    expect(pickBestBarcode(list, box, PREVIEW)).not.toBeNull();
  });

  it("passes everything through while the preview size is unmeasured", async () => {
    // A rotation re-runs layout; for a beat there is no measured preview.
    const list = candidates(nativeCode("NO-PREVIEW", OUTSIDE_LOW.x, OUTSIDE_LOW.y, 0.01));
    for (const previewSize of [null, undefined, { width: 0, height: 0 }]) {
      expect(filterBarcodesInBox(list, box, previewSize).map((c) => c.data)).toEqual([
        "NO-PREVIEW",
      ]);
    }
  });

  it("passes everything through when the native layer reports no frame", async () => {
    const list = codesToBarcodeCandidates(
      [nativeCode("NO-FRAME", OUTSIDE_LOW.x, OUTSIDE_LOW.y, 0.01)],
      null,
    );
    expect(list[0]!.sourceFrame).toBeNull();
    expect(barcodeCenterInPreview(list[0]!, PREVIEW)).toBeNull();
    expect(filterBarcodesInBox(list, box, PREVIEW).map((c) => c.data)).toEqual([
      "NO-FRAME",
    ]);
  });

  it("still resolves a winner when position data is missing entirely", async () => {
    const list: BarcodeCandidate[] = [
      { data: "NO-POSITION", bounds: null, cornerPoints: null, sourceFrame: null },
      ...candidates(nativeCode("OUTSIDE", OUTSIDE_LOW.x, OUTSIDE_LOW.y, 0.01)),
    ];
    expect(pickBestBarcode(list, box, PREVIEW)).not.toBeNull();
  });

  it("drops codes with no decoded value but keeps the rest", async () => {
    const list = codesToBarcodeCandidates(
      [
        { type: "code-128", value: undefined, frame: undefined },
        { type: "code-128", value: "   ", frame: undefined },
        nativeCode("REAL", CENTERED.x, CENTERED.y),
      ] as Code[],
      SENSOR_FRAME,
    );
    expect(list.map((c) => c.data)).toEqual(["REAL"]);
  });
});

// ── 4. Characterization of the current mapping (NOT a blessing) ───────────────

describe("mapFramePointToPreview — current behaviour, pending device verification", () => {
  /**
   * These pin what the helper does TODAY so any change is visible in review.
   * They are characterization tests: per the contract at the top of this file
   * the rotation branch looks unnecessary on iOS. Do not treat a failure here
   * as proof of a regression — check
   * docs/mobile-barcode-orientation-matrix.md first.
   */

  it("maps the center to the center, which is why a mis-set rotation can hide", async () => {
    const mapped = mapFramePointToPreview(CENTERED, SENSOR_FRAME, PREVIEW);
    expect(mapped!.x).toBeCloseTo(0.5, 10);
    expect(mapped!.y).toBeCloseTo(0.5, 10);
  });

  it("currently rotates a landscape frame into a portrait preview", async () => {
    // preview.x = 1 - y ; preview.y = x * (1920/1080 * 400/600 ... ) - crop
    const mapped = mapFramePointToPreview({ x: 0.25, y: 0.75 }, SENSOR_FRAME, PREVIEW);
    expect(mapped!.x).toBeCloseTo(0.25, 6); // 1 - 0.75
    expect(mapped!.y).toBeCloseTo(0.25 * (1920 / 1080) * (400 / 600) - 0.0925926, 6);
  });

  it("does not rotate when the frame is already portrait-shaped", async () => {
    const mapped = mapFramePointToPreview(
      { x: 0.25, y: 0.75 },
      { width: 1080, height: 1920 },
      PREVIEW,
    );
    expect(mapped!.x).toBeCloseTo(0.25, 6);
  });

  it("returns null instead of guessing when either size is unusable", async () => {
    expect(mapFramePointToPreview(CENTERED, null, PREVIEW)).toBeNull();
    expect(mapFramePointToPreview(CENTERED, SENSOR_FRAME, null)).toBeNull();
    expect(mapFramePointToPreview(CENTERED, { width: 0, height: 0 }, PREVIEW)).toBeNull();
    expect(
      mapFramePointToPreview(CENTERED, SENSOR_FRAME, { width: NaN, height: 600 }),
    ).toBeNull();
  });
});
