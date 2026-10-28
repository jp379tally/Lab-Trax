import { sql } from "drizzle-orm";
import { invoices } from "@workspace/db";
import { HttpError } from "./http";

/** Persisted status used by historical reconstructed invoices that were never released. */
export const HISTORICAL_HELD_INVOICE_STATUS = "recovery_draft";

export function isHistoricalInvoiceHeld(invoice: {
  status?: string | null;
  displayMetadataJson?: unknown;
}): boolean {
  const metadata = invoice.displayMetadataJson as {
    recoveryBilling?: { state?: string };
  } | null;
  return invoice.status === HISTORICAL_HELD_INVOICE_STATUS ||
    metadata?.recoveryBilling?.state === "held";
}

/** Prevent historical held invoices from being edited, distributed, or collected. */
export function assertHistoricalInvoiceNotHeld(
  invoice: Parameters<typeof isHistoricalInvoiceHeld>[0],
): void {
  if (isHistoricalInvoiceHeld(invoice)) {
    throw new HttpError(
      409,
      "This historical reconstructed invoice remains held and cannot be edited, sent, or collected.",
    );
  }
}

/** Exclude unreleased historical drafts from every financial/statement query. */
export function finalizedInvoiceSql() {
  return sql`(${invoices.status} <> ${HISTORICAL_HELD_INVOICE_STATUS}
    AND COALESCE(${invoices.displayMetadataJson}->'recoveryBilling'->>'state', '') <> 'held')`;
}
