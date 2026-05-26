/**
 * One-shot backfill: sets expected_delivery_date = received_at + 7 days
 * for all cases where expected_delivery_date IS NULL.
 *
 * Safe to re-run — only touches rows where the column is still null.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-expected-delivery-dates
 *   pnpm --filter @workspace/scripts run backfill-expected-delivery-dates -- --dry-run
 */

import { and, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { cases } from "@workspace/db";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  console.log(
    `[backfill-expected-delivery-dates] starting — mode=${dryRun ? "DRY-RUN" : "WRITE"}`
  );

  const rows = await db
    .select({ id: cases.id, receivedAt: cases.receivedAt })
    .from(cases)
    .where(and(isNull(cases.expectedDeliveryDate)));

  console.log(
    `[backfill-expected-delivery-dates] found ${rows.length} case(s) with null expected_delivery_date`
  );

  if (rows.length === 0) {
    console.log("[backfill-expected-delivery-dates] nothing to do — exiting");
    return;
  }

  if (dryRun) {
    console.log(
      "[backfill-expected-delivery-dates] dry-run — no writes performed"
    );
    for (const row of rows.slice(0, 10)) {
      const d = new Date(row.receivedAt);
      d.setDate(d.getDate() + 7);
      console.log(
        `  case ${row.id}: received_at=${row.receivedAt.toISOString()} → expected_delivery_date=${d.toISOString()}`
      );
    }
    if (rows.length > 10) {
      console.log(`  … and ${rows.length - 10} more`);
    }
    return;
  }

  let updated = 0;
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    for (const row of chunk) {
      const expectedDeliveryDate = new Date(row.receivedAt);
      expectedDeliveryDate.setDate(expectedDeliveryDate.getDate() + 7);
      await db
        .update(cases)
        .set({ expectedDeliveryDate })
        .where(
          and(
            sql`${cases.id} = ${row.id}`,
            isNull(cases.expectedDeliveryDate)
          )
        );
      updated++;
    }
    console.log(
      `[backfill-expected-delivery-dates] progress: ${Math.min(i + CHUNK, rows.length)} / ${rows.length}`
    );
  }

  console.log(
    `[backfill-expected-delivery-dates] done — updated ${updated} row(s)`
  );
}

main().catch((err) => {
  console.error("[backfill-expected-delivery-dates] fatal error:", err);
  process.exit(1);
});
