/**
 * One-shot backfill: fills in caseNumber + patientName in the metadata_json
 * of case_soft_deleted audit log rows that were created before the deletion
 * handler started recording case identity in metadata.
 *
 * Old rows have a full before_json snapshot of the deleted case but no
 * caseNumber/patientName fields in metadata_json.  This script reads that
 * snapshot and writes the identity back into metadata_json so the Deletion
 * Audit Log panel can show case details for historic entries.
 *
 * The update predicate re-checks that caseNumber is still absent, so the
 * script is safe to re-run (no double-updates).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-deletion-audit-metadata
 *   pnpm --filter @workspace/scripts run backfill-deletion-audit-metadata -- --dry-run
 */

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, auditLogs } from "@workspace/db";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  console.log(
    `[backfill-deletion-audit-metadata] starting — mode=${dryRun ? "DRY-RUN" : "WRITE"}`
  );

  // Find all case_soft_deleted rows that:
  //   1. have a before_json snapshot (source of truth for identity)
  //   2. do NOT already have caseNumber in metadata_json (idempotency guard)
  const rows = await db
    .select({
      id: auditLogs.id,
      beforeJson: auditLogs.beforeJson,
      metadataJson: auditLogs.metadataJson,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, "case_soft_deleted"),
        isNotNull(auditLogs.beforeJson),
        // metadata_json->>'caseNumber' IS NULL means the field is absent
        sql`${auditLogs.metadataJson}->>'caseNumber' IS NULL`
      )
    );

  console.log(
    `[backfill-deletion-audit-metadata] found ${rows.length} row(s) needing backfill`
  );

  if (rows.length === 0) {
    console.log("[backfill-deletion-audit-metadata] nothing to do — exiting");
    return;
  }

  let updated = 0;
  let skipped = 0;

  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);

    for (const row of chunk) {
      const before = (row.beforeJson ?? {}) as Record<string, unknown>;

      const caseNumber =
        typeof before["caseNumber"] === "string" ? before["caseNumber"] : "";
      const patientName = [before["patientFirstName"], before["patientLastName"]]
        .filter((v) => typeof v === "string" && v.length > 0)
        .join(" ");

      if (!caseNumber) {
        // before_json exists but has no caseNumber — nothing useful to backfill.
        if (dryRun) {
          console.log(`  [skip] ${row.id} — before_json has no caseNumber`);
        }
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(
          `  [would update] ${row.id} → caseNumber=${caseNumber} patientName=${patientName || "(none)"}`
        );
        updated++;
        continue;
      }

      // Merge the identity fields into the existing metadata_json, keeping any
      // other fields (e.g. rowsAffected) that may already be present.
      const existingMeta =
        (row.metadataJson as Record<string, unknown> | null) ?? {};
      const newMeta: Record<string, unknown> = {
        ...existingMeta,
        caseNumber,
        patientName,
      };

      await db
        .update(auditLogs)
        .set({ metadataJson: newMeta })
        .where(
          and(
            eq(auditLogs.id, row.id),
            // Re-check the idempotency guard at write time in case of
            // concurrent runs.
            sql`${auditLogs.metadataJson}->>'caseNumber' IS NULL`
          )
        );

      updated++;
    }

    if (!dryRun) {
      console.log(
        `[backfill-deletion-audit-metadata] progress: ${Math.min(i + CHUNK, rows.length)} / ${rows.length}`
      );
    }
  }

  console.log(
    `[backfill-deletion-audit-metadata] done — updated=${updated} skipped=${skipped}`
  );
}

main().catch((err) => {
  console.error("[backfill-deletion-audit-metadata] fatal error:", err);
  process.exit(1);
});
