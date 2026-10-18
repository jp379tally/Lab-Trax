import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { historicalStartupMaintenanceEnabled } from "./startup-maintenance";

/**
 * One-time idempotent backfill: convert any legacy `draft` invoice rows to
 * `open`. The `draft` status was removed from the schema; every invoice now
 * starts as `open`. This runs at startup so that existing databases are
 * cleaned up automatically on first deploy without a manual migration step.
 *
 * Safe to run on every startup — the WHERE clause is a no-op once the backfill
 * is complete.
 */
export async function migrateDraftInvoicesToOpen(): Promise<void> {
  if (!historicalStartupMaintenanceEnabled()) {
    logger.warn("migrate-draft-invoices: deferred outside explicit development maintenance");
    return;
  }
  const result = await db.execute(
    sql`UPDATE invoices SET status = 'open' WHERE status = 'draft'`,
  );
  const count = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  if (count > 0) {
    logger.info(
      { count },
      "migrate-draft-invoices: converted legacy draft invoices to open",
    );
  }
}
