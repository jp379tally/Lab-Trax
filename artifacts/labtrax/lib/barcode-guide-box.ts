/**
 * Guide-box hit-testing helpers for the case-pan barcode scanners.
 *
 * expo-camera reports barcode position in the coordinate space of the
 * CameraView layout (pixels). The caller computes the guide-box rectangle
 * in those same coordinates (from the reticle overlay percentages × the
 * view's measured width/height) and passes it here.
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
}

/** A rectangle in the camera-view coordinate space (pixels). */
export interface GuideBox {
  x: number;
  y: number;
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

/**
 * Filter `barcodes` to only those whose center falls inside `box`.
 *
 * Barcodes with no usable position data (null center) pass through
 * unconditionally as a graceful fallback so a missing-bounds edge case
 * never silently drops a valid scan.
 */
export function filterBarcodesInBox<T extends BarcodeCandidate>(
  barcodes: T[],
  box: GuideBox,
): T[] {
  return barcodes.filter((b) => {
    const c = barcodeCenter(b);
    if (!c) return true;
    return (
      c.x >= box.x &&
      c.x <= box.x + box.width &&
      c.y >= box.y &&
      c.y <= box.y + box.height
    );
  });
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
): T | null {
  if (barcodes.length === 0) return null;
  if (barcodes.length === 1) return barcodes[0]!;

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  let best: T | null = null;
  let bestDist = Infinity;

  for (const b of barcodes) {
    const center = barcodeCenter(b);
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
): T | null {
  return pickClosestToCenter(filterBarcodesInBox(barcodes, box), box);
}

/**
 * Compute a GuideBox from the camera-view layout dimensions and the
 * fractional insets used in the reticle overlay style.
 *
 * @param viewWidth  Measured width of the CameraView in layout pixels.
 * @param viewHeight Measured height of the CameraView in layout pixels.
 * @param leftFrac   Fraction from the left edge (e.g. 0.12 for "left: 12%").
 * @param topFrac    Fraction from the top edge.
 * @param rightFrac  Fraction from the right edge (e.g. 0.12 for "right: 12%").
 * @param heightFrac Fraction of the view height (e.g. 0.44 for "height: 44%").
 */
export function guideBoxFromLayout(
  viewWidth: number,
  viewHeight: number,
  leftFrac: number,
  topFrac: number,
  rightFrac: number,
  heightFrac: number,
): GuideBox {
  const x = viewWidth * leftFrac;
  const y = viewHeight * topFrac;
  const width = viewWidth * (1 - leftFrac - rightFrac);
  const height = viewHeight * heightFrac;
  return { x, y, width, height };
}
