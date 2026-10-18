import type { LabCase } from "@/lib/types";

const _IMPLANT_RE = /\bimplant|\babutment|screw[- ]?retained|all[- ]?on[- ]?(4|6|x)/i;
const _CROWN_BRIDGE_RE =
  /\bcrown|\bbridge|\bveneer|\binlay|\bonlay|\bmaryland|\bpontic|\bcoping/i;
const _REMOVABLE_RE = /\bdenture|\bpartial|\bflipper|\bflexible|\bvalplast|\bremovable/i;
const _ZIRCONIA_RE = /\bzirconia|\bbruxzir|\bbrux\b|\bzirc\b|\b(pfz)\b/i;
/**
 * Ortho / appliance free-text signals. Deliberately excludes "essix", which is
 * ambiguous (`removable/essix_with_teeth` vs `ortho/essix_without_teeth`) —
 * those cases are classified from their structured subtype instead.
 */
const _ORTHO_RE =
  /night\s*guard|nightguard|occlusal\s*guard|bite\s*guard|sports?\s*guard|snore\s*guard|mouth\s*guard|mouthguard|\bretainer|\bsplint|bleach\s*tray|\bhawley|space\s*maintainer|\bortho|\bappliance/i;

/**
 * Classify a case into a display indicator for the Due Today / Due Soon sections.
 * "C" = Crown & Bridge (crowns, bridges, implants, zirconia, veneers, etc.)
 * "D" = Removable (dentures, partials, flipper, flexible/Valplast)
 * "O" = Ortho / Appliances (night guards, retainers, splints, bleach trays, …)
 * null = cannot classify
 *
 * When `restorationSubtype` is provided (the encoded taxonomy key, e.g.
 * `"removable/dentures/acrylic"`), its first path segment is used first so
 * that cases with a structured subtype are never mis-classified by free-text
 * heuristics alone.
 */
export function deriveCaseTypeIndicator(
  restorationTypes?: string | null,
  restorationMaterials?: string | null,
  restorationSubtype?: string | null,
): "C" | "D" | "O" | null {
  // Prefer the encoded taxonomy subtype when available — it is authoritative.
  if (restorationSubtype) {
    const topSegment = restorationSubtype.split("/")[0];
    if (topSegment === "removable") return "D";
    if (topSegment === "restorative") return "C";
    if (topSegment === "ortho") return "O";
  }

  const rt = (restorationTypes ?? "").trim();
  const mat = (restorationMaterials ?? "").trim();
  if (!rt && !mat) return null;
  // Explicit removable restoration type wins over any material-only signal
  // (e.g. a PFZ/zirconia material on a denture case). Crown/bridge/implant
  // keywords in the same restoration-type string still take precedence.
  if (_REMOVABLE_RE.test(rt) && !_IMPLANT_RE.test(rt) && !_CROWN_BRIDGE_RE.test(rt)) return "D";
  // Same rule for an explicit ortho/appliance restoration type: it beats a
  // material-only signal (e.g. an acrylic night guard), but never a
  // crown/bridge/implant or removable keyword in the same type string.
  if (
    _ORTHO_RE.test(rt) &&
    !_IMPLANT_RE.test(rt) &&
    !_CROWN_BRIDGE_RE.test(rt) &&
    !_REMOVABLE_RE.test(rt)
  ) {
    return "O";
  }
  const haystack = `${rt} ${mat}`;
  if (_IMPLANT_RE.test(haystack) || _CROWN_BRIDGE_RE.test(haystack) || _ZIRCONIA_RE.test(mat)) {
    return "C";
  }
  if (_REMOVABLE_RE.test(haystack)) return "D";
  if (_ORTHO_RE.test(haystack)) return "O";
  return null;
}

/**
 * The Cases page date-range filter selection. Mirrors the dropdown options on
 * the Cases page: a fixed preset, a rolling N-day window, a custom range, or
 * "all" (no date filtering).
 */
export type DateRangeFilter = "all" | "today" | "yesterday" | "30" | "60" | "90" | "custom";

/**
 * Resolve a date-range filter selection into a concrete [startDate, endDate)
 * half-open interval.
 *
 * Returns `null` for either bound when that bound is unconstrained. `endDate`
 * is always exclusive (the day *after* the last included day) so that a
 * same-day "today → today" custom range still includes the entire current day.
 *
 * `now` is injectable so tests are not wall-clock dependent.
 */
export function computeCaseDateRange(
  dateRangeFilter: DateRangeFilter,
  customStartDate: string,
  customEndDate: string,
  now: Date = new Date(),
): { startDate: Date | null; endDate: Date | null } {
  let startDate: Date | null = null;
  let endDate: Date | null = null;

  if (dateRangeFilter === "yesterday") {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (dateRangeFilter === "today") {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  } else if (
    dateRangeFilter === "30" ||
    dateRangeFilter === "60" ||
    dateRangeFilter === "90"
  ) {
    const days = Number(dateRangeFilter);
    startDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - days + 1,
    );
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  } else if (dateRangeFilter === "custom") {
    if (customStartDate) {
      const [y, m, d] = customStartDate.split("-").map(Number);
      startDate = new Date(y, m - 1, d);
    }
    if (customEndDate) {
      const [y, m, d] = customEndDate.split("-").map(Number);
      endDate = new Date(y, m - 1, d + 1);
    } else {
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    }
  }

  return { startDate, endDate };
}

/**
 * Decide whether a case falls inside a resolved [startDate, endDate) range.
 *
 * The case is matched on its **created date** (`createdAt`). A row with no
 * created timestamp, or an unparseable one, is excluded while any date
 * constraint is active.
 *
 * When both bounds are `null` (filter is "all"), every case matches.
 */
export function caseWithinDateRange(
  c: Pick<LabCase, "createdAt">,
  startDate: Date | null,
  endDate: Date | null,
): boolean {
  if (startDate === null && endDate === null) return true;
  const dateSource = c.createdAt;
  if (!dateSource) return false;
  const d = new Date(dateSource);
  if (Number.isNaN(d.getTime())) return false;
  if (startDate !== null && d < startDate) return false;
  if (endDate !== null && d >= endDate) return false;
  return true;
}
