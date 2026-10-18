/**
 * Adapter between react-native-vision-camera's native `Code` scan results and
 * the engine-agnostic `BarcodeCandidate` shape consumed by
 * `lib/barcode-guide-box.ts`.
 *
 * This is the ONLY module that should know about react-native-vision-camera's
 * result shape — every scan screen converts through `codesToBarcodeCandidates`
 * so the shared guide-box filtering/picking helpers never need to change if
 * the scan engine changes again.
 */
import type {
  Code,
  CodeScannerFrame,
  CodeType,
} from "react-native-vision-camera";
import type { BarcodeCandidate } from "./barcode-guide-box";

/**
 * Keep symbology from becoming a blocker for labels printed outside LabTrax.
 * This is the complete CodeType set supported by VisionCamera 4.7.
 */
export const SCAN_CODE_TYPES: CodeType[] = [
  "code-128",
  "code-39",
  "code-93",
  "codabar",
  "gs1-data-bar",
  "gs1-data-bar-limited",
  "gs1-data-bar-expanded",
  "ean-13",
  "ean-8",
  "itf",
  "itf-14",
  "upc-e",
  "upc-a",
  "qr",
  "pdf-417",
  "aztec",
  "data-matrix",
];

/**
 * Converts a frame's worth of scanned `Code`s into `BarcodeCandidate`s.
 * Codes with no decoded value are dropped. Native positions are normalized
 * against the scanner frame so the rest of the app never handles buffer pixels.
 *
 * If the frame is absent or invalid, position data is intentionally omitted.
 * The guide-box gate is advisory, so a decoded value still scans.
 */
export function codesToBarcodeCandidates(
  codes: Code[],
  frame?: CodeScannerFrame | null,
): BarcodeCandidate[] {
  const frameIsUsable =
    !!frame &&
    Number.isFinite(frame.width) &&
    Number.isFinite(frame.height) &&
    frame.width > 0 &&
    frame.height > 0;
  const candidates: BarcodeCandidate[] = [];

  for (const code of codes) {
    if (!code.value?.trim()) continue;

    const bounds =
      frameIsUsable && code.frame
        ? {
            origin: {
              x: code.frame.x / frame.width,
              y: code.frame.y / frame.height,
            },
            size: {
              width: code.frame.width / frame.width,
              height: code.frame.height / frame.height,
            },
          }
        : null;
    const cornerPoints =
      frameIsUsable && code.corners
        ? code.corners.map((point) => ({
            x: point.x / frame.width,
            y: point.y / frame.height,
          }))
        : null;

    candidates.push({
      data: code.value,
      bounds,
      cornerPoints,
      sourceFrame: frameIsUsable
        ? { width: frame.width, height: frame.height }
        : null,
    });
  }

  if (__DEV__ && candidates.length > 0) {
    console.debug(
      "[barcode-scanner] decoded",
      candidates.map((candidate) => ({
        value: candidate.data,
        center: candidate.bounds
          ? {
              x: candidate.bounds.origin.x + candidate.bounds.size.width / 2,
              y: candidate.bounds.origin.y + candidate.bounds.size.height / 2,
            }
          : null,
        frame: candidate.sourceFrame,
      })),
    );
  }

  return candidates;
}
