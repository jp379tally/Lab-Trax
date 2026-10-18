/**
 * Startup backfill: collapses multi-row Removable appliance restorations into a
 * single restoration row per (caseId, restorationType, material) group.
 *
 * Background — before task #3425, the AI import paths created one
 * case_restorations row per tooth for Removable cases (dentures, partials,
 * flippers, overdentures).  Because Removable appliances are always ONE
 * billable unit regardless of how many teeth are listed, those multi-row
 * cases show an inflated QTY on their open invoices.
 *
 * This migration:
 *   1. Finds every case that has more than one case_restorations row with
 *      restorationType = 'Removable' sharing the same material value.
 *   2. For each such group, keeps the oldest row, sets its toothNumber to all
 *      unique teeth joined with ", ", and deletes the extra rows.
 *   3. Calls syncInvoiceFromRestorations on every affected case so that open
 *      invoices are rebuilt with QTY = 1.
 *
 * Safety rules:
 *   - Guarded by the `removable_restoration_collapse_backfill_done` key in
 *     system_settings so it fires at most once per deployment.
 *   - The collapse is idempotent: groups with exactly one row are untouched.
 *   - Only open invoices are affected by syncInvoiceFromRestorations (paid /
 *     void / cancelled invoices are left alone by that function).
 *   - Soft-deleted cases are skipped via the cases join.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, systemSettings, cases, caseRestorations } from "@workspace/db";
import { logger } from "./logger";
import { syncInvoiceFromRestorations } from "./invoice-sync";
import { historicalStartupMaintenanceEnabled } from "./startup-maintenance";

const SETTING_KEY = "removable_restoration_collapse_backfill_done";

interface CollapseGroup {
  caseId: string;
  restorationType: string;
  material: string | null;
  keepId: string;
  toothNumbers: string[];
  deleteIds: string[];
}

/** Exported for unit tests only. Use scheduleRemovableRestorationCollapseBackfillIfNeeded in production. */
export async function runBackfill(): Promise<{ caseCount: number; rowsDeleted: number }> {
  // Find all case IDs that have at least one Removable restoration on a
  // non-deleted case. We'll do the per-group analysis in application code.
  const rows = await db
    .select({
      id: caseRestorations.id,
      caseId: caseRestorations.caseId,
      restorationType: caseRestorations.restorationType,
      material: caseRestorations.material,
      toothNumber: caseRestorations.toothNumber,
      createdAt: caseRestorations.createdAt,
    })
    .from(caseRestorations)
    .innerJoin(cases, and(eq(caseRestorations.caseId, cases.id), isNull(cases.deletedAt)))
    .where(eq(caseRestorations.restorationType, "Removable"))
    .orderBy(caseRestorations.caseId, caseRestorations.createdAt);

  if (rows.length === 0) {
    logger.info("removable-collapse backfill: no Removable restoration rows found, nothing to do");
    return { caseCount: 0, rowsDeleted: 0 };
  }

  // Group by (caseId, restorationType, material). Material is nullable so we
  // normalise null → "" for the map key.
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.caseId}||${row.restorationType}||${row.material ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const collapseGroups: CollapseGroup[] = [];
  for (const [, group] of groups) {
    if (group.length <= 1) continue;

    // Keep the first (oldest) row; delete the rest.
    const [keep, ...extras] = group;

    // Collect unique tooth tokens while preserving order.
    const seen = new Set<string>();
    const uniqueTeeth: string[] = [];
    for (const r of group) {
      for (const token of r.toothNumber.split(",")) {
        const t = token.trim();
        if (t && !seen.has(t)) {
          seen.add(t);
          uniqueTeeth.push(t);
        }
      }
    }

    collapseGroups.push({
      caseId: keep.caseId,
      restorationType: keep.restorationType,
      material: keep.material,
      keepId: keep.id,
      toothNumbers: uniqueTeeth,
      deleteIds: extras.map((e) => e.id),
    });
  }

  if (collapseGroups.length === 0) {
    logger.info("removable-collapse backfill: all Removable groups already have 1 row, nothing to do");
    return { caseCount: 0, rowsDeleted: 0 };
  }

  const affectedCaseIds = new Set<string>();
  let totalRowsDeleted = 0;

  for (const g of collapseGroups) {
    const joinedTeeth = g.toothNumbers.join(", ");

    // Update the kept row with the collapsed tooth string.
    await db
      .update(caseRestorations)
      .set({ toothNumber: joinedTeeth, updatedAt: sql`now()` })
      .where(eq(caseRestorations.id, g.keepId));

    // Delete the extra rows one-by-one (avoids needing inArray import churn
    // and keeps each delete auditable in logs if needed).
    for (const deleteId of g.deleteIds) {
      await db
        .delete(caseRestorations)
        .where(eq(caseRestorations.id, deleteId));
      totalRowsDeleted++;
    }

    affectedCaseIds.add(g.caseId);

    logger.debug(
      {
        caseId: g.caseId,
        restorationType: g.restorationType,
        material: g.material,
        kept: g.keepId,
        deleted: g.deleteIds.length,
        teeth: joinedTeeth,
      },
      "removable-collapse backfill: collapsed group",
    );
  }

  // Rebuild invoices for every affected case. syncInvoiceFromRestorations
  // skips paid / void / cancelled invoices automatically.
  let invoiceSyncErrors = 0;
  for (const caseId of affectedCaseIds) {
    try {
      await syncInvoiceFromRestorations({ caseId, actorUserId: null });
    } catch (err) {
      invoiceSyncErrors++;
      logger.warn(
        { err, caseId },
        "removable-collapse backfill: invoice sync failed for case (non-fatal)",
      );
    }
  }

  logger.info(
    {
      casesAffected: affectedCaseIds.size,
      rowsDeleted: totalRowsDeleted,
      invoiceSyncErrors,
    },
    "removable-collapse backfill: complete",
  );

  return { caseCount: affectedCaseIds.size, rowsDeleted: totalRowsDeleted };
}

/**
 * Called once from index.ts after the server starts listening.
 * Runs the backfill in the background without blocking startup.
 */
export function scheduleRemovableRestorationCollapseBackfillIfNeeded(): void {
  if (!historicalStartupMaintenanceEnabled()) {
    logger.warn("removable-collapse backfill: deferred outside explicit development startup");
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
          logger.debug("removable-collapse backfill: already done, skipping");
          return;
        }

        const result = await runBackfill();

        await db
          .insert(systemSettings)
          .values({ key: SETTING_KEY, value: "true" })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: "true", updatedAt: new Date() },
          });

        logger.info(
          result,
          "removable-collapse backfill: flag set — will not run again",
        );
      } catch (err) {
        logger.error({ err }, "removable-collapse backfill: failed");
      }
    })();
  });
}
