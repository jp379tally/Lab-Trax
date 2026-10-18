/**
 * One-shot backfill: sets expected_delivery_date = NULL for every case row
 * where due_date IS NOT NULL AND expected_delivery_date IS NOT NULL and the
 * two dates differ (i.e. the auto-calculated turnaround was stored even though
 * the user supplied an explicit due date).
 *
 * The fix that introduced this behaviour now writes expected_delivery_date = NULL
 * whenever a dueDate is present, so only pre-fix rows need correcting.
 *
 * Idempotent — the WHERE clause naturally selects only unfixed rows. Re-running
 * after a partial run or on an already-migrated database is safe and a no-op.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-expected-delivery-dates
 *   pnpm --filter @workspace/scripts run backfill-expected-delivery-dates -- --dry-run
 */

import { and, isNotNull, sql } from "drizzle-orm";
import { db, pool, cases } from "@workspace/db";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  console.log(
    `[backfill-expected-delivery-dates] starting — mode=${dryRun ? "DRY-RUN" : "WRITE"}`
  );

  // Select rows where:
  //   due_date IS NOT NULL           — user explicitly set a due date
  //   AND expected_delivery_date IS NOT NULL  — the stale auto-calculated value is present
  //   AND due_date <> expected_delivery_date  — they actually disagree
  //
  // The last condition excludes the unlikely edge case where a user's explicit
  // due date happened to match the auto-calculated turnaround exactly — those
  // rows are harmless either way, but clearing them would be surprising.
  const rows = await db
    .select({ id: cases.id, dueDate: cases.dueDate, expectedDeliveryDate: cases.expectedDeliveryDate })
    .from(cases)
    .where(
      and(
        isNotNull(cases.dueDate),
        isNotNull(cases.expectedDeliveryDate),
        sql`${cases.dueDate} <> ${cases.expectedDeliveryDate}`
      )
    );

  console.log(
    `[backfill-expected-delivery-dates] found ${rows.length} case(s) with stale expected_delivery_date`
  );

  if (rows.length === 0) {
    console.log("[backfill-expected-delivery-dates] nothing to do — exiting");
    await pool.end();
    return;
  }

  if (dryRun) {
    console.log(
      "[backfill-expected-delivery-dates] dry-run — no writes performed"
    );
    for (const row of rows.slice(0, 10)) {
      console.log(
        `  case ${row.id}: due_date=${row.dueDate ? new Date(row.dueDate).toISOString() : null}` +
          ` expected_delivery_date=${row.expectedDeliveryDate ? new Date(row.expectedDeliveryDate).toISOString() : null}` +
          ` → expected_delivery_date=NULL`
      );
    }
    if (rows.length > 10) {
      console.log(`  … and ${rows.length - 10} more`);
    }
    await pool.end();
    return;
  }

  const CHUNK = 100;
  let updated = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db.transaction(async (tx) => {
      for (const row of chunk) {
        await tx
          .update(cases)
          .set({ expectedDeliveryDate: null })
          .where(
            and(
              sql`${cases.id} = ${row.id}`,
              isNotNull(cases.dueDate),
              isNotNull(cases.expectedDeliveryDate),
              sql`${cases.dueDate} <> ${cases.expectedDeliveryDate}`
            )
          );
        updated++;
      }
    });
    console.log(
      `[backfill-expected-delivery-dates] progress: ${Math.min(i + CHUNK, rows.length)} / ${rows.length}`
    );
  }

  console.log(
    `[backfill-expected-delivery-dates] done — cleared expected_delivery_date on ${updated} row(s)`
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error("[backfill-expected-delivery-dates] fatal error:", err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
