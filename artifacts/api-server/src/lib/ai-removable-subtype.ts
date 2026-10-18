/**
 * Helpers for mapping the AI-extracted `removableSubtype` field to the
 * LabTrax taxonomy CaseSubtype and detecting ambiguous repair cases that
 * require admin review.
 *
 * The AI returns a 7-value enum for removable cases:
 *   "flipper" | "partial" | "denture" |
 *   "repair_partial" | "repair_denture" | "repair" | null
 *
 * The first five map 1-to-1 to taxonomy CaseSubtype keys (with a
 * pluralisation fix for flipper/partial/denture). "repair" is an
 * ambiguous sentinel meaning "repair work, but couldn't tell whether
 * the appliance is a partial or a denture" — it has no taxonomy key and
 * triggers an aiPricingWarning so the admin can pick the correct subtype.
 */

import type { CaseSubtype } from "@workspace/case-taxonomy";

/** String-enum values the AI may return for `removableSubtype`. */
export type AiRemovableSubtype =
  | "flipper"
  | "partial"
  | "denture"
  | "repair_partial"
  | "repair_denture"
  | "repair"
  | null;

const AI_SUBTYPE_TO_TAXONOMY: Record<string, CaseSubtype> = {
  flipper: "flippers",
  partial: "partials",
  denture: "dentures",
  repair_partial: "repair_partial",
  repair_denture: "repair_denture",
};

/**
 * Map an AI-extracted `removableSubtype` value to the taxonomy CaseSubtype
 * key that should be stored on the restoration row.
 *
 * Returns null for the ambiguous "repair" sentinel and for any unrecognised
 * value (both cases fall through to regex inference in `normalizeCaseHierarchy`).
 */
export function mapAiRemovableSubtype(
  removableSubtype: string | null | undefined,
): CaseSubtype | null {
  if (!removableSubtype) return null;
  return (AI_SUBTYPE_TO_TAXONOMY[removableSubtype] as CaseSubtype | undefined) ?? null;
}

/**
 * True when the AI's removableSubtype is the ambiguous "repair" sentinel —
 * the case needs admin review to choose repair_partial vs repair_denture.
 */
export function isAmbiguousRemovableSubtype(
  removableSubtype: string | null | undefined,
): boolean {
  return removableSubtype === "repair";
}
