export const CASE_STATIONS: { value: string; label: string }[] = [
  { value: "received", label: "Received" },
  { value: "in_design", label: "In Design" },
  { value: "scan", label: "Scan" },
  { value: "in_milling", label: "In Milling" },
  { value: "post_mill", label: "Post Mill" },
  { value: "sintering_furnace", label: "Sintering Furnace" },
  { value: "model_room", label: "Model Room" },
  { value: "in_porcelain", label: "Porcelain" },
  { value: "qc", label: "Quality Check" },
  { value: "complete", label: "Complete" },
  { value: "shipped", label: "Shipping" },
  { value: "on_hold", label: "On Hold" },
  { value: "delivered", label: "Delivered" },
  { value: "remake", label: "Remake" },
];

/**
 * Legacy uppercase status tokens — still emitted by the legacy mobile
 * endpoints and stored in historical `lab_cases` blobs — mapped onto the
 * canonical lowercase status that `CASE_STATIONS` is keyed by. Mirrors the
 * server's LEGACY_TO_CANONICAL_CASE_STATUS bridge.
 *
 * Deliberately NOT `normalizeCaseStatus()` from lib/data.ts: that one collapses
 * every token onto one of the twelve mobile *stations* (delivered → complete,
 * remake → received). The cases list reads canonical cases straight from
 * GET /api/cases, where `delivered` / `remake` / `cancelled` are distinct
 * statuses that must stay filterable in their own right.
 */
const LEGACY_STATUS_ALIASES: Record<string, string> = {
  intake: "received",
  design: "in_design",
  mill: "in_milling",
  milling: "in_milling",
  sintering: "sintering_furnace",
  porcelain: "in_porcelain",
  qc_check: "qc",
  delivery: "shipped",
  ship: "shipped",
  hold: "on_hold",
};

/**
 * Coerces any status token (canonical lowercase, legacy UPPERCASE, or a
 * historical alias) to the canonical lowercase status used by the filters.
 * Unknown tokens are returned lowercased rather than defaulted, so a status the
 * app doesn't know about is simply never matched instead of silently counting
 * as "Received".
 */
export function canonicalCaseStatus(raw: string | null | undefined): string {
  const token = (raw ?? "").trim().toLowerCase();
  if (!token) return "";
  return LEGACY_STATUS_ALIASES[token] ?? token;
}

export function stationLabelFor(value: string | null | undefined): string {
  if (!value) return "—";
  return (
    CASE_STATIONS.find((s) => s.value === value)?.label ??
    value
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase())
      .trim()
  );
}
