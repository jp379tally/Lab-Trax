/**
 * Client-side restoration type classifier — mirrors the server's patterns in
 * `artifacts/api-server/src/lib/case-category.ts`.
 *
 * Both desktop and mobile use this so the "hide tooth chart for removable
 * types" rule is applied consistently with the same keyword set.
 */

const IMPLANT_RE = /\bimplant|\babutment|screw[- ]?retained|all[- ]?on[- ]?(4|6|x)/i;
const CROWN_BRIDGE_RE =
  /\bcrown|\bbridge|\bveneer|\binlay|\bonlay|\bmaryland|\bpontic|\bcoping/i;
const REMOVABLE_RE = /\bdenture|\bpartial|\bflipper|\bflexible|\bvalplast/i;

/**
 * Classify a restoration type as "removable", "crown_bridge", or "other".
 *
 * - "removable"    — denture, partial, flipper, flexible / Valplast; tooth
 *                    chart and tooth-number input are hidden for these.
 * - "crown_bridge" — crown, bridge, veneer, inlay, onlay, pontic, coping,
 *                    Maryland bridge, and implant / abutment work; tooth
 *                    chart is the primary UI for these (mirrors the server's
 *                    priority order: implants → crown_bridge → removable).
 * - "other"        — everything else (night guard, retainer, sports guard…);
 *                    tooth chart is still shown since position can matter.
 *
 * Priority: crown_bridge (incl. implants) > removable > other.
 */
export function classifyRestorationType(
  restorationType: string | null | undefined,
): "crown_bridge" | "removable" | "other" {
  if (!restorationType) return "other";
  if (IMPLANT_RE.test(restorationType) || CROWN_BRIDGE_RE.test(restorationType))
    return "crown_bridge";
  if (REMOVABLE_RE.test(restorationType)) return "removable";
  return "other";
}

/**
 * Convenience wrapper — returns true for removable appliance types (denture,
 * partial, flipper, flexible / Valplast). Tooth number and the interactive
 * tooth chart are not clinically meaningful for these types and should be
 * hidden in the intake UI.
 */
export function isRemovableRestorationType(
  restorationType: string | null | undefined,
): boolean {
  return classifyRestorationType(restorationType) === "removable";
}
