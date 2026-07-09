/**
 * Shared shift-click range-selection helpers for bulk-selection lists.
 *
 * Semantics (established on the Cases page, Task #2796):
 * - A normal checkbox click toggles the single row and moves the anchor.
 * - A shift-click with a valid anchor selects every row between the anchor
 *   and the clicked row in the currently visible (filtered/sorted) order,
 *   keeping prior selections outside the range.
 * - If the anchor is no longer visible (filter changed), the caller should
 *   fall back to a normal single toggle and reset the anchor to the clicked
 *   row.
 */

/**
 * Compute the inclusive range of ids between the anchor and the clicked row
 * in the visible order. Returns `null` when a range cannot be computed —
 * no anchor, anchor === clicked, or either endpoint is not currently
 * visible — in which case the caller should treat the click as a normal
 * single toggle and reset the anchor.
 */
export function computeShiftClickRange(
  visibleIds: readonly string[],
  anchorId: string | null,
  clickedId: string,
): string[] | null {
  if (!anchorId || anchorId === clickedId) return null;
  const anchorIdx = visibleIds.indexOf(anchorId);
  const clickedIdx = visibleIds.indexOf(clickedId);
  if (anchorIdx === -1 || clickedIdx === -1) return null;
  const start = Math.min(anchorIdx, clickedIdx);
  const end = Math.max(anchorIdx, clickedIdx);
  return visibleIds.slice(start, end + 1);
}

/**
 * Read the shift-key state from a checkbox change event. React's checkbox
 * onChange is backed by the click event, so the native event carries
 * `shiftKey`.
 */
export function shiftKeyFromChangeEvent(
  e: React.ChangeEvent<HTMLInputElement>,
): boolean {
  return "shiftKey" in e.nativeEvent
    ? Boolean((e.nativeEvent as MouseEvent).shiftKey)
    : false;
}

/**
 * onMouseDown handler for selection checkboxes: shift-clicking would
 * otherwise start a native text selection across the range of rows.
 */
export function suppressShiftClickTextSelection(e: React.MouseEvent): void {
  if (e.shiftKey) e.preventDefault();
}
