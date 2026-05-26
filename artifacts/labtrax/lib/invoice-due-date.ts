/**
 * Invoice due-date helpers — mirrors artifacts/api-server/src/lib/invoice-due-date.ts.
 *
 * Business rule: invoices are always due on the 10th of the month
 * following the month they were issued in (UTC midnight).
 *
 * Examples:
 *   issued 2025-01-03 → due 2025-02-10T00:00:00Z
 *   issued 2025-12-31 → due 2026-01-10T00:00:00Z
 */

/**
 * Returns the 10th of the month following `issuedAt`, at UTC midnight.
 * `issuedAt` may be a Date or a Unix timestamp (ms).
 */
export function invoiceDueDate(issuedAt: Date | number): Date {
  const d = typeof issuedAt === "number" ? new Date(issuedAt) : issuedAt;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-based
  const nextYear = m === 11 ? y + 1 : y;
  const nextMonth = m === 11 ? 0 : m + 1;
  return new Date(Date.UTC(nextYear, nextMonth, 10, 0, 0, 0));
}

/**
 * Returns the human-readable statement period for an invoice issued at
 * `issuedAt`. The statement covers the month the invoice was issued in.
 *
 * E.g. issued in January 2025 → "January 2025"
 */
export function statementPeriodLabel(issuedAt: Date | number): string {
  const d = typeof issuedAt === "number" ? new Date(issuedAt) : issuedAt;
  return d.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
