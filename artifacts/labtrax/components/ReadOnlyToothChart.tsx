import React from "react";
import { ToothChart } from "@/components/ToothChart";
import type { ToothId } from "@/lib/rx-summary";

/**
 * Read-only mobile mirror of the desktop ToothChart — anatomical arch layout.
 *
 * Thin wrapper around the interactive {@link ToothChart} that locks it into
 * read-only mode. Kept as a named export so existing call sites and the vitest
 * mock continue to work unchanged.
 */

interface Props {
  /** Teeth with a crown/restoration — rendered blue. */
  crownTeeth?: Set<ToothId>;
  /** Teeth marked as pontic — rendered purple. */
  ponticTeeth?: Set<ToothId>;
  /** Teeth marked as missing — rendered with ✕ glyph. */
  missingTeeth?: Set<ToothId>;
  /** Teeth already billed on this case, shown with a green dashed halo. */
  billedTeeth?: Set<ToothId>;
  selected?: Set<ToothId>;
  /** Legacy fallback: all highlighted teeth rendered in the brand tint. */
  highlighted?: Set<ToothId>;
  connectedPairs?: Set<string>;
  connectorSuggestions?: Set<string>;
  connectorIssue?: string | null;
  summaryText?: string;
}

export function ReadOnlyToothChart(props: Props) {
  return <ToothChart {...props} readOnly />;
}
