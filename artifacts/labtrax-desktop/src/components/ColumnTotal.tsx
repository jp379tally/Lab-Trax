import { formatMoney } from "@/lib/format";

/**
 * Safely sums a list of possibly-null/undefined/string amounts.
 * Null/undefined and non-numeric strings count as 0; negatives are included.
 */
export function sumAmounts(
  values: Array<string | number | null | undefined>,
): number {
  let total = 0;
  for (const v of values) {
    const n = typeof v === "string" ? Number(v) : (v ?? 0);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

/**
 * Small top-of-column total rendered under a table column header label.
 * Shows a placeholder while the underlying data is loading so a stale or
 * partial sum is never displayed.
 */
export function ColumnTotal({
  values,
  loading = false,
  testId,
}: {
  values: Array<string | number | null | undefined>;
  loading?: boolean;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className="block text-[11px] font-semibold tabular-nums text-foreground normal-case tracking-normal whitespace-nowrap"
    >
      {loading ? "—" : formatMoney(sumAmounts(values))}
    </span>
  );
}

export function FilteredSalesTotal({
  amount,
  loading = false,
}: {
  amount?: string | number | null;
  loading?: boolean;
}) {
  return (
    <div
      data-testid="filtered-case-sales-total"
      className="flex items-center justify-end gap-2 px-5 py-3 text-sm"
    >
      <span className="font-medium text-muted-foreground">Filtered sales total</span>
      <span className="font-semibold tabular-nums">
        {loading ? "—" : formatMoney(Number(amount ?? 0))}
      </span>
    </div>
  );
}
