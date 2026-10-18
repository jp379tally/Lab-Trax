/**
 * Startup backfill: clears stale expectedDeliveryDate on cases that already
 * have an explicit dueDate supplied by the user.
 *
 * Background — Task #3105 introduced logic so that a new case's
 * expectedDeliveryDate is set to null whenever the caller provides an explicit
 * dueDate.  Before that fix, BOTH fields were written simultaneously: dueDate
 * from user input and expectedDeliveryDate as the auto-calculated "now + N
 * days" value.  The cases list renders `expectedDeliveryDate ?? dueDate`, so
 * those pre-fix rows permanently show the auto-calculated date instead of the
 * user's intended date.
 *
 * This one-time migration sets expectedDeliveryDate = NULL for every
 * non-deleted case that has both columns populated.  Cases that have ONLY
 * expectedDeliveryDate (no dueDate) are intentional auto-calculated values and
 * are left untouched.
 *
 * Guarded by the `expected_delivery_date_backfill_done` key in system_settings
 * so it fires at most once across all deployments.  Safe to re-run manually if
 * the flag is cleared — the UPDATE is idempotent.
 */

import { sql, eq } from "drizzle-orm";
import { db, systemSettings } from "@workspace/db";
import { logger } from "./logger";
import { historicalStartupMaintenanceEnabled } from "./startup-maintenance";

const SETTING_KEY = "expected_delivery_date_backfill_done";

async function runBackfill(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE cases
    SET expected_delivery_date = NULL
    WHERE due_date IS NOT NULL
      AND expected_delivery_date IS NOT NULL
      AND deleted_at IS NULL
  `);
  return (result as { rowCount?: number }).rowCount ?? 0;
}

/**
 * Called once from index.ts after the server starts listening.
 * Runs the backfill in the background without blocking startup.
 */
export function scheduleExpectedDeliveryDateBackfillIfNeeded(): void {
  if (!historicalStartupMaintenanceEnabled()) {
    logger.warn("expected-delivery-date backfill: deferred outside explicit development startup");
    return;
  }
  setImmediate(() => {
    void (async () => {
      try {
        const existing = await db
          .select({ value: systemSettings.value })
          .from(systemSettings)
          .where(eq(systemSettings.key, SETTING_KEY));

        if (existing.length > 0 && existing[0]?.value === "true") {
          logger.debug(
            "expected-delivery-date backfill: already done, skipping",
          );
          return;
        }

        const updated = await runBackfill();

        await db
          .insert(systemSettings)
          .values({ key: SETTING_KEY, value: "true" })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: "true", updatedAt: new Date() },
          });

        logger.info(
          { updatedRows: updated },
          "expected-delivery-date backfill: complete — flag set, will not run again",
        );
      } catch (err) {
        logger.error({ err }, "expected-delivery-date backfill: failed");
      }
    })();
  });
}
