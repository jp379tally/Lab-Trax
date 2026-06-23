/**
 * One-shot backfill: sets lab_locations.status (the mapped workflow stage) for
 * existing station rows that were created before the `status` column existed.
 *
 * Mapping strategy, per row:
 *   1. If the station's `code` (lowercased) is already a valid case-status enum
 *      value (all built-in stations are), use it — this restores the exact
 *      prior behaviour for built-in stations.
 *   2. Otherwise, match the station's `name` (case-insensitive) against the
 *      built-in station names and use that station's status.
 *   3. Otherwise, leave it at the safe default ("received") and log the row so
 *      an admin can pick the correct stage in the UI. Custom stations that
 *      can't be mapped automatically were exactly the ones that failed before,
 *      so flagging them is the right outcome.
 *
 * Safe to re-run — only rewrites rows whose current status is the default
 * "received" but whose code maps to a different stage (idempotent for rows an
 * admin has already corrected).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-location-status
 *   pnpm --filter @workspace/scripts run backfill-location-status -- --dry-run
 */

import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { labLocations } from "@workspace/db";

const dryRun = process.argv.includes("--dry-run");

const VALID_CASE_STATUSES = new Set([
  "received",
  "in_design",
  "scan",
  "in_milling",
  "post_mill",
  "sintering_furnace",
  "model_room",
  "in_porcelain",
  "qc",
  "complete",
  "shipped",
  "delivered",
  "on_hold",
  "remake",
  "cancelled",
]);

// name (lowercased) -> mapped status, for built-in stations whose code may not
// match the enum (e.g. legacy display names).
const BUILT_IN_NAME_TO_STATUS: Record<string, string> = {
  received: "received",
  "in design": "in_design",
  scan: "scan",
  "in milling": "in_milling",
  "post mill": "post_mill",
  "sintering furnace": "sintering_furnace",
  "model room": "model_room",
  porcelain: "in_porcelain",
  "in porcelain": "in_porcelain",
  "quality check": "qc",
  qc: "qc",
  complete: "complete",
  shipping: "shipped",
  shipped: "shipped",
  "on hold": "on_hold",
  delivered: "delivered",
  remake: "remake",
};

function resolveStatus(code: string, name: string): string | null {
  const lc = code.trim().toLowerCase();
  if (VALID_CASE_STATUSES.has(lc)) return lc;
  const byName = BUILT_IN_NAME_TO_STATUS[name.trim().toLowerCase()];
  if (byName) return byName;
  return null;
}

async function main(): Promise<void> {
  console.log(
    `[backfill-location-status] starting — mode=${dryRun ? "DRY-RUN" : "WRITE"}`,
  );

  const rows = await db
    .select({
      id: labLocations.id,
      labOrganizationId: labLocations.labOrganizationId,
      name: labLocations.name,
      code: labLocations.code,
      status: labLocations.status,
    })
    .from(labLocations);

  console.log(`[backfill-location-status] scanned ${rows.length} station(s)`);

  let updated = 0;
  let unmapped = 0;

  for (const row of rows) {
    const resolved = resolveStatus(row.code, row.name);

    if (resolved === null) {
      unmapped++;
      console.warn(
        `[backfill-location-status] UNMAPPED station — lab=${row.labOrganizationId} ` +
          `name="${row.name}" code="${row.code}" left at status="${row.status}". ` +
          `An admin should set its stage in Lists → Locations.`,
      );
      continue;
    }

    if (row.status === resolved) continue;

    // Only rewrite when the row is still at the untouched default. If an admin
    // already changed it away from "received", respect their choice.
    if (row.status !== "received") {
      console.log(
        `[backfill-location-status] skip (admin-set) — name="${row.name}" ` +
          `code="${row.code}" status="${row.status}" (would-be "${resolved}")`,
      );
      continue;
    }

    if (dryRun) {
      console.log(
        `[backfill-location-status] would set name="${row.name}" code="${row.code}" ` +
          `status "received" → "${resolved}"`,
      );
      updated++;
      continue;
    }

    await db
      .update(labLocations)
      .set({ status: resolved, updatedAt: new Date() })
      .where(
        sql`${labLocations.id} = ${row.id} AND ${labLocations.status} = 'received'`,
      );
    updated++;
  }

  console.log(
    `[backfill-location-status] done — ${dryRun ? "would update" : "updated"} ` +
      `${updated} row(s), ${unmapped} unmapped (left at default for admin review)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-location-status] fatal error:", err);
    process.exit(1);
  });
