/**
 * Startup backfill: links existing bank_transactions rows to vendor records
 * by matching the free-text payee field against each lab's vendor names
 * (exact, case-insensitive).
 *
 * Runs once automatically on first server start after the feature was introduced.
 * Guarded by the `vendor_link_backfill_done` key in system_settings so it fires
 * at most once across all deployments.
 *
 * Rules (same as scripts/src/backfill-vendor-links.ts):
 *  - Only rows with a non-null payee and a null vendor_id are considered.
 *  - Soft-deleted transactions (deleted_at IS NOT NULL) are skipped.
 *  - Matching is case-insensitive against the vendor name after trimming whitespace.
 *  - Ambiguous names (two or more active vendors share the same normalised name)
 *    are left alone.
 *  - Safe to re-run: rows already linked (vendor_id IS NOT NULL) are skipped.
 */

import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { db, systemSettings, bankTransactions, vendors } from "@workspace/db";
import { logger } from "./logger";

const SETTING_KEY = "vendor_link_backfill_done";

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
  const summary: LabSummary = { labId, linked: 0, ambiguous: 0, noMatch: 0 };

  const rows = await db
    .select({ id: bankTransactions.id, payee: bankTransactions.payee })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.labOrganizationId, labId),
        isNotNull(bankTransactions.payee),
        isNull(bankTransactions.vendorId),
        isNull(bankTransactions.deletedAt)
      )
    );

  if (rows.length === 0) return summary;

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
    summary.noMatch = rows.length;
    return summary;
  }

  const nameMap = new Map<string, string | null>();
  for (const v of labVendors) {
    const key = normalise(v.name);
    nameMap.set(key, nameMap.has(key) ? null : v.id);
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
      summary.ambiguous++;
      logger.warn(
        { txnId: row.id, payee: row.payee, labId },
        "vendor-link backfill: ambiguous payee matches multiple vendors — skipped"
      );
      continue;
    }

    await db
      .update(bankTransactions)
      .set({ vendorId, updatedAt: sql`now()` })
      .where(
        and(eq(bankTransactions.id, row.id), isNull(bankTransactions.vendorId))
      );
    summary.linked++;
  }

  return summary;
}

async function runBackfill(): Promise<void> {
  const labRows: { labOrganizationId: string }[] = await db
    .selectDistinct({ labOrganizationId: bankTransactions.labOrganizationId })
    .from(bankTransactions)
    .where(isNull(bankTransactions.deletedAt));

  const labIds = labRows.map((r) => r.labOrganizationId);

  logger.info(
    { labCount: labIds.length },
    "vendor-link backfill: starting"
  );

  let totalLinked = 0;
  let totalAmbiguous = 0;
  let totalNoMatch = 0;

  for (const labId of labIds) {
    const s = await processLab(labId);
    totalLinked += s.linked;
    totalAmbiguous += s.ambiguous;
    totalNoMatch += s.noMatch;
    logger.debug(
      { labId, linked: s.linked, ambiguous: s.ambiguous, noMatch: s.noMatch },
      "vendor-link backfill: lab processed"
    );
  }

  logger.info(
    { labsProcessed: labIds.length, linked: totalLinked, ambiguous: totalAmbiguous, noMatch: totalNoMatch },
    "vendor-link backfill: complete"
  );
}

/**
 * Called once from index.ts after the server starts listening.
 * Checks the system_settings flag and, if absent, runs the backfill in the
 * background without blocking the event loop or startup.
 */
export function scheduleVendorLinkBackfillIfNeeded(): void {
  setImmediate(() => {
    void (async () => {
      try {
        const existing = await db
          .select({ value: systemSettings.value })
          .from(systemSettings)
          .where(eq(systemSettings.key, SETTING_KEY));

        if (existing.length > 0 && existing[0]?.value === "true") {
          logger.debug("vendor-link backfill: already done, skipping");
          return;
        }

        await runBackfill();

        await db
          .insert(systemSettings)
          .values({ key: SETTING_KEY, value: "true" })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: "true", updatedAt: new Date() },
          });

        logger.info("vendor-link backfill: flag set — will not run again");
      } catch (err) {
        logger.error({ err }, "vendor-link backfill: failed");
      }
    })();
  });
}
