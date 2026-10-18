import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { historicalStartupMaintenanceEnabled } from "./startup-maintenance";

/**
 * One-time idempotent backfill: set `issued_at = created_at` for any invoice
 * rows where `issued_at` is NULL. Several historical invoice-creation paths
 * omitted `issuedAt`, leaving the column NULL and causing the bank-register
 * and invoice editor to show "—" for the issue date on those rows.
 *
 * Safe to run on every startup — the WHERE clause is a no-op once the backfill
 * is complete.
 */
export async function migrateInvoiceIssuedAt(): Promise<void> {
  if (!historicalStartupMaintenanceEnabled()) {
    logger.warn("migrate-invoice-issued-at: deferred outside explicit development maintenance");
    return;
  }
  const result = await db.execute(
    sql`UPDATE invoices SET issued_at = created_at WHERE issued_at IS NULL AND created_at IS NOT NULL`,
  );
  const count = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  if (count > 0) {
    logger.info(
      { count },
      "migrate-invoice-issued-at: backfilled issued_at from created_at on historical invoices",
    );
  }
}
