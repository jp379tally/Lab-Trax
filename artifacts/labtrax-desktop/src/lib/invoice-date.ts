const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const INVOICE_DATE_DRIFT_FIX_AT = "2026-09-11T14:41:49.000Z";

/** Convert a persisted invoice timestamp to its UTC calendar date for a date input. */
export function invoiceTimestampToDateInput(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Serialize an invoice calendar date as canonical UTC midnight. */
export function invoiceDateInputToTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return date.toISOString();
}

/** Display a persisted invoice timestamp as its stable UTC calendar date. */
export function formatInvoiceDate(value?: string | null): string {
  const input = invoiceTimestampToDateInput(value);
  if (!input) return "—";
  const [year, month, day] = input.split("-");
  return `${month}/${day}/${year}`;
}

/** Identify legacy timestamps that were not persisted as canonical UTC-midnight dates. */
export function isLikelyLegacyShiftedInvoiceDate(
  value?: string | null,
  invoiceCreatedAt?: string | null,
): boolean {
  if (!value || !invoiceCreatedAt) return false;
  const date = new Date(value);
  const createdAt = new Date(invoiceCreatedAt);
  if (
    Number.isNaN(date.getTime()) ||
    Number.isNaN(createdAt.getTime()) ||
    createdAt.getTime() >= new Date(INVOICE_DATE_DRIFT_FIX_AT).getTime()
  ) {
    return false;
  }
  return (
    date.getUTCHours() !== 0 ||
    date.getUTCMinutes() !== 0 ||
    date.getUTCSeconds() !== 0 ||
    date.getUTCMilliseconds() !== 0
  );
}

export function hasInvoiceDateRepairChanges({
  issuedAt,
  dueAt,
  createdAt,
  repairedIssuedAt,
  repairedDueAt,
}: {
  issuedAt?: string | null;
  dueAt?: string | null;
  createdAt?: string | null;
  repairedIssuedAt: string;
  repairedDueAt: string;
}): boolean {
  return (
    (isLikelyLegacyShiftedInvoiceDate(issuedAt, createdAt) &&
      invoiceDateInputToTimestamp(repairedIssuedAt) !== issuedAt) ||
    (isLikelyLegacyShiftedInvoiceDate(dueAt, createdAt) &&
      invoiceDateInputToTimestamp(repairedDueAt) !== dueAt)
  );
}