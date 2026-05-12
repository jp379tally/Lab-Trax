/**
 * Backfill `case_restorations.restoration_type` so historical rows match the
 * coarse buckets the Overview Rx summary uses ("Crown & Bridge", "Removable",
 * "Appliance", "Other"). The original granular value (e.g. "Full Denture",
 * "Night Guard", "Custom milled tray") is preserved in
 * `restoration_subtype` so labs don't lose the detail they already entered.
 *
 * Bucketing rules are ported verbatim from
 * `artifacts/labtrax-desktop/src/lib/rx-summary.ts` so the server-side backfill
 * matches the client-side fallback exactly.
 *
 * Required env:
 *   DATABASE_URL — Postgres connection string (same one the API uses)
 *
 * Optional env / flags:
 *   --dry-run             Report bucket counts without writing (default: false)
 *   --include-bucketed    Re-process rows whose restoration_type is already a
 *                         bucket name (default: skip — those rows were either
 *                         backfilled previously or written by the new iTero
 *                         AI importer and have nothing to preserve).
 *   --limit <n>           Cap how many rows are processed in this invocation.
 *   --batch <n>           Update batch size (default: 500).
 */

import { eq, isNull, and, sql } from "drizzle-orm";
import { db, pool, caseRestorations } from "@workspace/db";

type RestorativeBucket =
  | "Crown & Bridge"
  | "Removable"
  | "Appliance"
  | "Other";

const BUCKETS: ReadonlySet<string> = new Set<RestorativeBucket>([
  "Crown & Bridge",
  "Removable",
  "Appliance",
  "Other",
]);

const CROWN_BRIDGE = new Set([
  "crown",
  "bridge",
  "veneer",
  "veneers",
  "implant crown",
  "inlay",
  "onlay",
  "crown & bridge",
  "crown and bridge",
  "c&b",
]);
const REMOVABLE = new Set([
  "removable",
  "denture",
  "full denture",
  "partial denture",
  "partial",
  "immediate denture",
  "overdenture",
  "flipper",
]);
const APPLIANCE = new Set([
  "appliance",
  "night guard",
  "nightguard",
  "occlusal guard",
  "retainer",
  "sports guard",
  "snore guard",
  "splint",
  "bleach tray",
  "mouthguard",
]);

function bucketRestorativeType(
  raw: string | null | undefined,
): RestorativeBucket {
  if (!raw) return "Other";
  const v = raw.trim().toLowerCase();
  if (!v) return "Other";
  if (CROWN_BRIDGE.has(v)) return "Crown & Bridge";
  if (REMOVABLE.has(v)) return "Removable";
  if (APPLIANCE.has(v)) return "Appliance";
  if (/(crown|bridge|veneer|inlay|onlay)/.test(v)) return "Crown & Bridge";
  if (/(denture|partial|removable|flipper)/.test(v)) return "Removable";
  if (/(guard|retainer|splint|appliance|tray)/.test(v)) return "Appliance";
  return "Other";
}

function parseFlags() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let includeBucketed = false;
  let limit: number | null = null;
  let batch = 500;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--include-bucketed") includeBucketed = true;
    else if (a === "--limit") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`Invalid --limit value: ${args[i]}`);
        process.exit(1);
      }
      limit = n;
    } else if (a === "--batch") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`Invalid --batch value: ${args[i]}`);
        process.exit(1);
      }
      batch = n;
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { dryRun, includeBucketed, limit, batch };
}

async function main() {
  const { dryRun, includeBucketed, limit, batch } = parseFlags();

  console.log(
    `[backfill-restoration-buckets] mode=${dryRun ? "DRY-RUN" : "WRITE"} ` +
      `includeBucketed=${includeBucketed} limit=${limit ?? "none"} batch=${batch}`,
  );

  const whereClause = includeBucketed
    ? isNull(caseRestorations.restorationSubtype)
    : and(
        isNull(caseRestorations.restorationSubtype),
        sql`${caseRestorations.restorationType} NOT IN ('Crown & Bridge', 'Removable', 'Appliance', 'Other')`,
      );

  const rows = await db
    .select({
      id: caseRestorations.id,
      restorationType: caseRestorations.restorationType,
    })
    .from(caseRestorations)
    .where(whereClause)
    .limit(limit ?? 1_000_000);

  const counts: Record<RestorativeBucket, number> = {
    "Crown & Bridge": 0,
    Removable: 0,
    Appliance: 0,
    Other: 0,
  };
  const noChange: { alreadyBucket: number; emptyOriginal: number } = {
    alreadyBucket: 0,
    emptyOriginal: 0,
  };
  const planned: Array<{
    id: string;
    bucket: RestorativeBucket;
    original: string;
  }> = [];

  for (const r of rows) {
    const original = r.restorationType ?? "";
    const bucket = bucketRestorativeType(original);
    counts[bucket]++;
    const trimmed = original.trim();
    if (!trimmed) {
      // Nothing to preserve — leave the row alone so we don't overwrite a
      // (technically NOT NULL but possibly empty) value with "Other" and lose
      // future information.
      noChange.emptyOriginal++;
      continue;
    }
    if (BUCKETS.has(trimmed) && trimmed === bucket) {
      noChange.alreadyBucket++;
      continue;
    }
    planned.push({ id: r.id, bucket, original: trimmed });
  }

  console.log(`[backfill-restoration-buckets] scanned ${rows.length} rows`);
  console.log(`  Crown & Bridge: ${counts["Crown & Bridge"]}`);
  console.log(`  Removable:      ${counts["Removable"]}`);
  console.log(`  Appliance:      ${counts["Appliance"]}`);
  console.log(`  Other:          ${counts["Other"]}`);
  console.log(`  skip (already bucket): ${noChange.alreadyBucket}`);
  console.log(`  skip (empty original): ${noChange.emptyOriginal}`);
  console.log(`  rows to update: ${planned.length}`);

  if (dryRun) {
    console.log("[backfill-restoration-buckets] dry-run — no writes performed");
    await pool.end();
    return;
  }

  let updated = 0;
  for (let i = 0; i < planned.length; i += batch) {
    const slice = planned.slice(i, i + batch);
    await db.transaction(async (tx) => {
      for (const p of slice) {
        await tx
          .update(caseRestorations)
          .set({
            restorationType: p.bucket,
            restorationSubtype: p.original,
          })
          .where(eq(caseRestorations.id, p.id));
      }
    });
    updated += slice.length;
    console.log(
      `[backfill-restoration-buckets] updated ${updated} / ${planned.length}`,
    );
  }

  console.log(
    `[backfill-restoration-buckets] done — ${updated} rows rewritten`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
