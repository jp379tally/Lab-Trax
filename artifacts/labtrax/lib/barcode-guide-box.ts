/**
 * Guide-box hit-testing helpers for the case-pan barcode scanners.
 *
 * These helpers are engine-agnostic: they operate purely on the
 * `BarcodeCandidate` shape. Candidate positions and guide boxes are normalized
 * to 0..1. Candidate positions start in the camera-buffer orientation; the pure
 * mapping helpers rotate and cover-crop them into the preview orientation.
 *
 * All helpers are pure functions so they can be unit-tested without a device.
 */

export interface BarcodeCandidate {
  data: string;
  bounds?: {
    origin: { x: number; y: number };
    size: { width: number; height: number };
  } | null;
  cornerPoints?: Array<{ x: number; y: number }> | null;
  sourceFrame?: { width: number; height: number } | null;
}

/** A rectangle normalized to the camera preview (0..1). */
export interface GuideBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewSize {
  width: number;
  height: number;
}

/**
 * Derive the center point of a barcode from its `bounds` or `cornerPoints`.
 * Returns null when neither field carries usable data.
 */
export function barcodeCenter(
  b: BarcodeCandidate,
): { x: number; y: number } | null {
  if (b.bounds && (b.bounds.size.width > 0 || b.bounds.size.height > 0)) {
    return {
      x: b.bounds.origin.x + b.bounds.size.width / 2,
      y: b.bounds.origin.y + b.bounds.size.height / 2,
    };
  }
  const pts = b.cornerPoints;
  if (pts && pts.length >= 2) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }
  return null;
}

function usableSize(size?: PreviewSize | null): size is PreviewSize {
  return (
    !!size &&
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

/**
 * Map a normalized camera-buffer point into the normalized preview.
 * A landscape sensor feeding a portrait preview is rotated clockwise first.
 * The Camera's default cover resize is then applied, including cropped edges.
 */
export function mapFramePointToPreview(
  point: { x: number; y: number },
  sourceFrame?: PreviewSize | null,
  previewSize?: PreviewSize | null,
): { x: number; y: number } | null {
  if (!usableSize(sourceFrame) || !usableSize(previewSize)) return null;

  const rotate =
    sourceFrame.width > sourceFrame.height &&
    previewSize.height > previewSize.width;
  const orientedWidth = rotate ? sourceFrame.height : sourceFrame.width;
  const orientedHeight = rotate ? sourceFrame.width : sourceFrame.height;
  const orientedPoint = rotate
    ? { x: 1 - point.y, y: point.x }
    : point;

  const scale = Math.max(
    previewSize.width / orientedWidth,
    previewSize.height / orientedHeight,
  );
  const renderedWidth = orientedWidth * scale;
  const renderedHeight = orientedHeight * scale;
  const cropX = (renderedWidth - previewSize.width) / 2;
  const cropY = (renderedHeight - previewSize.height) / 2;

  return {
    x:
      (orientedPoint.x * renderedWidth - cropX) /
      previewSize.width,
    y:
      (orientedPoint.y * renderedHeight - cropY) /
      previewSize.height,
  };
}

export function barcodeCenterInPreview(
  barcode: BarcodeCandidate,
  previewSize?: PreviewSize | null,
): { x: number; y: number } | null {
  const center = barcodeCenter(barcode);
  if (!center) return null;
  return mapFramePointToPreview(center, barcode.sourceFrame, previewSize);
}

/**
 * Filter `barcodes` to only those whose center falls inside `box`.
 *
 * This gate is advisory: unresolved positions pass through, and if every
 * positioned candidate is outside the box the original non-empty list is
 * returned. Geometry must never silently discard decoded data.
 */
export function filterBarcodesInBox<T extends BarcodeCandidate>(
  barcodes: T[],
  box: GuideBox,
  previewSize?: PreviewSize | null,
): T[] {
  const filtered = barcodes.filter((b) => {
    const c = barcodeCenterInPreview(b, previewSize);
    if (!c) return true;
    return (
      c.x >= box.x &&
      c.x <= box.x + box.width &&
      c.y >= box.y &&
      c.y <= box.y + box.height
    );
  });
  return filtered.length > 0 ? filtered : barcodes;
}

/**
 * From a list of barcodes (already in-box), return the one whose center
 * is closest to the center of `box`.
 *
 * - Returns null for an empty list.
 * - Returns the single element immediately for a 1-element list.
 * - For barcodes with no position data, the first such barcode is returned
 *   only when no positioned barcode is found.
 */
export function pickClosestToCenter<T extends BarcodeCandidate>(
  barcodes: T[],
  box: GuideBox,
  previewSize?: PreviewSize | null,
): T | null {
  if (barcodes.length === 0) return null;
  if (barcodes.length === 1) return barcodes[0]!;

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  let best: T | null = null;
  let bestDist = Infinity;

  for (const b of barcodes) {
    const center = barcodeCenterInPreview(b, previewSize);
    if (!center) {
      if (!best) best = b;
      continue;
    }
    const dist = Math.hypot(center.x - cx, center.y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }

  return best;
}

/**
 * Combined entry point: filter to in-box barcodes then pick the one
 * closest to the guide-box center.
 *
 * Returns null when no barcodes are inside the box.
 */
export function pickBestBarcode<T extends BarcodeCandidate>(
  barcodes: T[],
  box: GuideBox,
  previewSize?: PreviewSize | null,
): T | null {
  return pickClosestToCenter(
    filterBarcodesInBox(barcodes, box, previewSize),
    box,
    previewSize,
  );
}

/**
 * Compute a normalized GuideBox from the reticle overlay percentages.
 */
export function guideBoxFromFractions(
  leftFrac: number,
  topFrac: number,
  rightFrac: number,
  heightFrac: number,
): GuideBox {
  return {
    x: leftFrac,
    y: topFrac,
    width: 1 - leftFrac - rightFrac,
    height: heightFrac,
  };
}
