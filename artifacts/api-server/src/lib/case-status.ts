/**
 * Legacy mobile status tokens have existed in more than one spelling. Keep
 * every read and write bridge on these tables so a legacy case cannot appear
 * in a different workflow stage between route surfaces.
 */
const LEGACY_TO_CANONICAL_CASE_STATUS: Record<string, string> = {
  INTAKE: "received",
  DESIGN: "in_design",
  SCAN: "scan",
  MILLING: "in_milling",
  POST_MILL: "post_mill",
  SINTERING_FURNACE: "sintering_furnace",
  MODEL_ROOM: "model_room",
  PORCELAIN: "in_porcelain",
  QC_CHECK: "qc",
  QC: "qc",
  COMPLETE: "complete",
  DELIVERY: "shipped",
  SHIP: "shipped",
  DELIVERED: "delivered",
  ON_HOLD: "on_hold",
  HOLD: "on_hold",
  REMAKE: "remake",
  CANCELLED: "cancelled",
};

/**
 * Canonical status values are written back to legacy blobs by several
 * workflows. Use one durable representation so the next legacy read is
 * unambiguous; historical aliases remain supported on reads only.
 */
const CANONICAL_TO_LEGACY_CASE_STATUS: Record<string, string> = {
  received: "INTAKE",
  in_design: "DESIGN",
  scan: "SCAN",
  in_milling: "MILLING",
  post_mill: "POST_MILL",
  sintering_furnace: "SINTERING_FURNACE",
  model_room: "MODEL_ROOM",
  in_porcelain: "PORCELAIN",
  qc: "QC",
  complete: "COMPLETE",
  shipped: "SHIP",
  delivered: "DELIVERED",
  on_hold: "ON_HOLD",
  remake: "REMAKE",
  cancelled: "CANCELLED",
};

export function legacyStatusToCanonical(status: unknown): string;
export function legacyStatusToCanonical<TFallback extends string | null>(
  status: unknown,
  fallback: TFallback,
): string | TFallback;
export function legacyStatusToCanonical(
  status: unknown,
  fallback: string | null = "received",
): string | null {
  const token = String(status ?? "").trim().toUpperCase();
  return LEGACY_TO_CANONICAL_CASE_STATUS[token] ?? fallback;
}

export function canonicalStatusToLegacy(status: unknown): string {
  const canonical = String(status ?? "").trim().toLowerCase();
  return (
    CANONICAL_TO_LEGACY_CASE_STATUS[canonical] ??
    String(status ?? "").trim().toUpperCase()
  );
}