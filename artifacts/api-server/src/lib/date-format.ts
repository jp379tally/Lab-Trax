/**
 * Shared date formatting for server-generated, human-facing text — outbound
 * emails, statement PDFs, statement SMS, in-app notifications, and the AI
 * assistant's date context. The desktop and mobile apps standardized on
 * numeric two-digit month / two-digit day / four-digit year (e.g.
 * "07/30/2026"), and these helpers give the server the same convention.
 *
 * Do NOT use these for:
 *  - the HTTP `Last-Modified` response header (must stay HTTP-date via
 *    `toUTCString()`)
 *  - ISO timestamps used for storage, comparison, filenames, or logging
 *  - API payload fields (clients render their own display dates)
 *
 * All formatting is anchored to the UTC calendar date/time of the input so
 * results are deterministic regardless of the server process's local
 * timezone (date-only values such as due dates and invoice dates are stored
 * at UTC midnight elsewhere in the codebase, e.g. `invoice-due-date.ts`).
 */

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Format a date as numeric MM/DD/YYYY using its UTC calendar date, e.g.
 * "07/30/2026". Falls back to the stringified input if it cannot be parsed.
 */
export function formatNumericDate(value: Date | string | number): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

/**
 * Format a date as numeric MM/YYYY using its UTC calendar month, e.g.
 * "07/2026". For period labels that intentionally have no day (a monthly
 * billing period). Falls back to the stringified input if it cannot be
 * parsed.
 */
export function formatNumericMonthYear(value: Date | string | number): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${mm}/${d.getUTCFullYear()}`;
}

/**
 * Format a date as numeric MM/DD/YYYY plus UTC time-of-day, e.g.
 * "07/30/2026, 3:04:05 PM UTC". Used for admin alert emails where the exact
 * time of an event (not just the date) matters. Falls back to the
 * stringified input if it cannot be parsed.
 */
export function formatNumericDateTime(value: Date | string | number): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const timePart = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  });
  return `${formatNumericDate(d)}, ${timePart} UTC`;
}
