/**
 * One-shot backfill: links existing bank_transactions rows to vendor records
 * by matching the free-text payee field against each lab's vendor names
 * (exact, case-insensitive).
 *
 * Rules:
 *  - Only rows with a non-null payee and a null vendor_id are considered.
 *  - Soft-deleted transactions (deleted_at IS NOT NULL) are skipped.
 *  - Matching is case-insensitive against the vendor name after trimming
 *    leading/trailing whitespace.
 *  - If two (or more) active vendors in the same lab share the same
 *    normalised name the payee is considered *ambiguous* and left alone.
 *  - Safe to re-run: rows already linked (vendor_id IS NOT NULL) are skipped.
 *
 * Required env:
 *   DATABASE_URL — Postgres connection string (same one the API uses)
 *
 * Optional flags:
 *   --dry-run    Log what would change without writing (default: false)
 *   --lab <id>   Restrict to a single lab organisation
 *
 * Usage (dev):
 *   pnpm --filter @workspace/scripts run backfill-vendor-links
 *   pnpm --filter @workspace/scripts run backfill-vendor-links -- --dry-run
 *   pnpm --filter @workspace/scripts run backfill-vendor-links -- --lab <orgId>
 */

import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { db, pool, bankTransactions, vendors } from "@workspace/db";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const labFilter: string | null = (() => {
  const idx = args.indexOf("--lab");
  return idx !== -1 && args[idx + 1] ? args[idx + 1]! : null;
})();

/** Normalise a payee / vendor name for comparison */
function normalise(s: string): string {
  return s.trim().toLowerCase();
}

interface LabSummary {
  labId: string;
  linked: number;
  ambiguous: number;
  noMatch: number;
}

async function processLab(labId: string): Promise<LabSummary> {
  const summary: LabSummary = {
    labId,
    linked: 0,
    ambiguous: 0,
    noMatch: 0,
  };

  // Fetch all unlinked, non-deleted transactions with a payee for this lab.
  // Do this before the vendor lookup so labs with no vendors still report
  // their candidate rows as no-match in the summary.
  const rows = await db
    .select({
      id: bankTransactions.id,
      payee: bankTransactions.payee,
    })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.labOrganizationId, labId),
        isNotNull(bankTransactions.payee),
        isNull(bankTransactions.vendorId),
        isNull(bankTransactions.deletedAt)
      )
    );

  if (rows.length === 0) {
    return summary;
  }

  // Fetch all active (non-deleted) vendors for this lab
  const labVendors = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(
      and(
        eq(vendors.labOrganizationId, labId),
        eq(vendors.isActive, true),
        isNull(vendors.deletedAt)
      )
    );

  if (labVendors.length === 0) {
    // No vendors to match against — every candidate is a no-match
    summary.noMatch = rows.length;
    return summary;
  }

  // Build normalised-name → vendor-id map.
  // A null value means two or more vendors share that normalised name (ambiguous).
  const nameMap = new Map<string, string | null>();
  for (const v of labVendors) {
    const key = normalise(v.name);
    if (nameMap.has(key)) {
      nameMap.set(key, null);
    } else {
      nameMap.set(key, v.id);
    }
  }

  for (const row of rows) {
    if (!row.payee) continue;

    const key = normalise(row.payee);
    if (!nameMap.has(key)) {
      summary.noMatch++;
      continue;
    }

    const vendorId = nameMap.get(key)!;
    if (vendorId === null) {
      // Ambiguous — two vendors share this normalised name
      summary.ambiguous++;
      process.stdout.write(
        `  [AMBIGUOUS] txn ${row.id}  payee="${row.payee}" matches multiple vendors — skipped\n`
      );
      continue;
    }

    if (isDryRun) {
      process.stdout.write(
        `  [DRY-RUN] would link txn ${row.id}  payee="${row.payee}"  -> vendor ${vendorId}\n`
      );
    } else {
      // Guard: only write if vendor_id is still null (re-run safety)
      await db
        .update(bankTransactions)
        .set({ vendorId, updatedAt: sql`now()` })
        .where(
          and(eq(bankTransactions.id, row.id), isNull(bankTransactions.vendorId))
        );
      process.stdout.write(
        `  linked txn ${row.id}  payee="${row.payee}"  -> vendor ${vendorId}\n`
      );
    }
    summary.linked++;
  }

  return summary;
}

async function main() {
  if (isDryRun) {
    process.stdout.write("[DRY-RUN mode — no changes will be written]\n\n");
  }
  if (labFilter) {
    process.stdout.write(`[Restricted to lab: ${labFilter}]\n\n`);
  }

  // Collect distinct lab IDs from bank_transactions (or honour --lab flag)
  let labIds: string[];
  if (labFilter) {
    labIds = [labFilter];
  } else {
    const rows: { labOrganizationId: string }[] = await db
      .selectDistinct({ labOrganizationId: bankTransactions.labOrganizationId })
      .from(bankTransactions)
      .where(isNull(bankTransactions.deletedAt));
    labIds = rows.map((r) => r.labOrganizationId);
  }

  process.stdout.write(`Processing ${labIds.length} lab(s)…\n`);

  let totalLinked = 0;
  let totalAmbiguous = 0;
  let totalNoMatch = 0;

  for (const labId of labIds) {
    process.stdout.write(`\nLab ${labId}:\n`);
    const s = await processLab(labId);
    totalLinked += s.linked;
    totalAmbiguous += s.ambiguous;
    totalNoMatch += s.noMatch;
    process.stdout.write(
      `  => linked=${s.linked}  ambiguous=${s.ambiguous}  no-match=${s.noMatch}\n`
    );
  }

  process.stdout.write("\n=== Summary ===\n");
  process.stdout.write(`Labs processed : ${labIds.length}\n`);
  if (isDryRun) {
    process.stdout.write(`Would link     : ${totalLinked}\n`);
  } else {
    process.stdout.write(`Linked         : ${totalLinked}\n`);
  }
  process.stdout.write(
    `Ambiguous      : ${totalAmbiguous} (skipped — multiple vendors share the same name)\n`
  );
  process.stdout.write(`No match       : ${totalNoMatch}\n`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Backfill failed:", err);
  process.exit(1);
});
