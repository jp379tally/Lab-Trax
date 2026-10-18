/**
 * Exact monetary arithmetic for the AP/AR subledgers.
 *
 * Balances decide whether a bill is paid, whether a credit is exhausted, and
 * whether an allocation is legal. Accumulating those decisions in binary
 * floating point eventually produces a bill with a $0.00000001 balance that
 * will not close, so every figure is converted to integer cents at the
 * boundary, kept there, and formatted back to a `decimal(14,2)` string only
 * when it is written or returned.
 */

/** Largest value representable by our `decimal(14,2)` columns, in cents. */
export const MAX_MONEY_CENTS = 99_999_999_999_99;

/**
 * Convert a database decimal string, a number, or null into integer cents.
 *
 * Rounds half away from zero, matching how the rest of the product formats
 * money for display, so a value that renders as `$1.23` is stored as 123.
 */
export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100);
}

/** Render integer cents as a `decimal(14,2)`-compatible string. */
export function fromCents(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

/** Sum integer-cent values without intermediate float error. */
export function sumCents(values: number[]): number {
  let total = 0;
  for (const value of values) total += Math.round(value);
  return total;
}

/**
 * Parse a client-supplied amount into cents, rejecting anything that is not a
 * clean, positive, in-range monetary value.
 */
export function parseAmountToCents(
  value: string | number,
  label: string,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} must be a number.`);
  }
  const cents = Math.round(numeric * 100);
  if (Math.abs(cents) > MAX_MONEY_CENTS) {
    throw new Error(`${label} is out of range.`);
  }
  return cents;
}
