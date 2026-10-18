export const INVOICE_LINE_ITEM_COLUMN_DEFAULTS = [144, 72, 194, 64, 108, 96] as const;
export const INVOICE_LINE_ITEM_COLUMN_MINIMUMS = [116, 70, 128, 64, 92, 96] as const;
export const INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH = 80;
export const INVOICE_LINE_ITEM_FLEX_COLUMN_INDEX = 2;

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Fits the user's preferred widths into the measured table container.
 * Description absorbs spare room; when space is tight, columns shrink
 * proportionally to their available room above their minimums.
 */
export function fitInvoiceLineItemColumns(
  preferredWidths: readonly number[],
  availableTableWidth: number,
  minimumWidths: readonly number[] = INVOICE_LINE_ITEM_COLUMN_MINIMUMS,
  actionColumnWidth = INVOICE_LINE_ITEM_ACTION_COLUMN_WIDTH,
  flexColumnIndex = INVOICE_LINE_ITEM_FLEX_COLUMN_INDEX,
): number[] {
  const count = Math.min(preferredWidths.length, minimumWidths.length);
  const minimums = Array.from({ length: count }, (_, index) =>
    Math.max(1, Math.ceil(minimumWidths[index] ?? 1)),
  );
  const preferred = Array.from({ length: count }, (_, index) =>
    Math.max(minimums[index], Math.floor(preferredWidths[index] ?? minimums[index])),
  );
  const targetColumnWidth = Math.floor(availableTableWidth - actionColumnWidth);
  const minimumTotal = sum(minimums);

  if (targetColumnWidth <= minimumTotal) return minimums;

  const preferredTotal = sum(preferred);
  if (preferredTotal <= targetColumnWidth) {
    const fitted = [...preferred];
    fitted[Math.min(Math.max(flexColumnIndex, 0), count - 1)] += targetColumnWidth - preferredTotal;
    return fitted;
  }

  const deficit = preferredTotal - targetColumnWidth;
  const capacity = preferred.map((width, index) => width - minimums[index]);
  const totalCapacity = sum(capacity);
  const reductions = capacity.map((available) => Math.floor((deficit * available) / totalCapacity));
  let remaining = deficit - sum(reductions);

  for (let index = 0; remaining > 0; index = (index + 1) % count) {
    if (reductions[index] < capacity[index]) {
      reductions[index] += 1;
      remaining -= 1;
    }
  }

  return preferred.map((width, index) => width - reductions[index]);
}

/**
 * Applies a divider drag by transferring width between the selected column
 * and its neighbor, never changing the table's total width.
 */
export function resizeInvoiceLineItemColumns(
  currentWidths: readonly number[],
  columnIndex: number,
  delta: number,
  minimumWidths: readonly number[] = INVOICE_LINE_ITEM_COLUMN_MINIMUMS,
  neighborIndex = columnIndex === INVOICE_LINE_ITEM_FLEX_COLUMN_INDEX ? 0 : INVOICE_LINE_ITEM_FLEX_COLUMN_INDEX,
): number[] {
  if (
    columnIndex < 0 ||
    columnIndex >= currentWidths.length ||
    neighborIndex < 0 ||
    neighborIndex >= currentWidths.length ||
    columnIndex === neighborIndex
  ) {
    return [...currentWidths];
  }

  const next = [...currentWidths];
  const selectedMinimum = minimumWidths[columnIndex] ?? 1;
  const neighborMinimum = minimumWidths[neighborIndex] ?? 1;
  const transfer = Math.min(
    next[neighborIndex] - neighborMinimum,
    Math.max(-(next[columnIndex] - selectedMinimum), Math.round(delta)),
  );
  next[columnIndex] += transfer;
  next[neighborIndex] -= transfer;
  return next;
}
