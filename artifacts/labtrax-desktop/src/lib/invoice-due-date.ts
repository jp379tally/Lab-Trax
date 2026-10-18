/**
 * Invoice due-date helpers — mirrors artifacts/api-server/src/lib/invoice-due-date.ts.
 *
 * Business rule: invoices are due on a configurable day of the month
 * following the month they were issued in (UTC midnight). The default day
 * is 10; labs can override it via `invoiceDueDayOfMonth` on their org row.
 *
 * Examples (default day = 10):
 *   issued 2025-01-03 → due 2025-02-10T00:00:00Z
 *   issued 2025-12-31 → due 2026-01-10T00:00:00Z
 */

/**
 * Returns the configured day of the month following `issuedAt`, at UTC midnight.
 *
 * @param issuedAt  The invoice issue date.
 * @param dayOfMonth  Day of month (1–28). Defaults to 10 when null/undefined.
 *                    Values outside 1–28 are clamped.
 */
export function invoiceDueDate(issuedAt: Date, dayOfMonth?: number | null): Date {
  const day = Math.min(28, Math.max(1, Math.round(dayOfMonth ?? 10)));
  const y = issuedAt.getUTCFullYear();
  const m = issuedAt.getUTCMonth(); // 0-based
  const nextYear = m === 11 ? y + 1 : y;
  const nextMonth = m === 11 ? 0 : m + 1;
  return new Date(Date.UTC(nextYear, nextMonth, day, 0, 0, 0));
}

/**
 * Returns the human-readable statement period for an invoice issued at
 * `issuedAt`. The statement covers the month the invoice was issued in.
 *
 * E.g. issued in January 2025 → "01/2025"
 */
export function statementPeriodLabel(issuedAt: Date | string): string {
  const d = typeof issuedAt === "string" ? new Date(issuedAt) : issuedAt;
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${mm}/${yyyy}`;
}
