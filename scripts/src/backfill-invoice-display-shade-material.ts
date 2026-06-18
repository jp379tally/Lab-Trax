/**
 * Backfill `invoices.display_metadata_json.shade` and `.material` for
 * invoices created before those values were snapshotted into the invoice
 * presentation metadata.
 *
 * Background: the invoice PDF reads shade/material from the invoice's
 * `display_metadata_json` snapshot, which is written once at invoice-creation
 * time from the linked case's `case_restorations` rows. Older invoices were
 * created before shade/material flowed into that snapshot (and before the AI
 * prescription intake reliably wrote those columns), so their snapshot has an
 * empty shade/material even though the case now carries restoration rows with
 * real values.
 *
 * This script finds every invoice with a linked case, derives the distinct
 * shade and material values from that case's restoration rows, and fills them
 * into the snapshot ONLY when the snapshot's value is currently empty. It never
 * overwrites a non-empty snapshot value (admins may have edited it by hand),
 * and it never touches invoices that have no derivable shade/material.
 *
 * Required env:
 *   DATABASE_URL — Postgres connection string (same one the API uses)
 *
 * Optional flags:
 *   --dry-run     Report what would change without writing (default: false)
 *   --limit <n>   Cap how many invoices are processed in this invocation.
 *   --batch <n>   Update batch size (default: 500).
 *
 * Safe to re-run: already-populated snapshots are skipped.
 */

import { eq, isNotNull } from "drizzle-orm";
import { db, pool, invoices, caseRestorations } from "@workspace/db";

function parseFlags() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let limit: number | null = null;
  let batch = 500;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
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
  return { dryRun, limit, batch };
}

/** Distinct, order-preserving, trimmed join of a column across rows. */
function distinctJoin(values: Array<string | null>): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of values) {
    const v = (raw ?? "").trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      ordered.push(v);
    }
  }
  return ordered.join(", ");
}

function isEmptyMetaValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  );
}

async function main() {
  const { dryRun, limit, batch } = parseFlags();

  console.log(
    `[backfill-invoice-display-shade-material] mode=${dryRun ? "DRY-RUN" : "WRITE"} ` +
      `limit=${limit ?? "none"} batch=${batch}`,
  );

  // Only invoices linked to a case can derive shade/material from
  // restoration rows.
  const rows = await db
    .select({
      id: invoices.id,
      caseId: invoices.caseId,
      displayMetadataJson: invoices.displayMetadataJson,
    })
    .from(invoices)
    .where(isNotNull(invoices.caseId))
    .limit(limit ?? 1_000_000);

  let scanned = 0;
  let skippedAlreadyPopulated = 0;
  let skippedNoDerivable = 0;
  const planned: Array<{
    id: string;
    meta: Record<string, unknown>;
    setShade: string | null;
    setMaterial: string | null;
  }> = [];

  for (const inv of rows) {
    scanned++;
    if (!inv.caseId) continue;

    const meta = (
      inv.displayMetadataJson && typeof inv.displayMetadataJson === "object"
        ? inv.displayMetadataJson
        : {}
    ) as Record<string, unknown>;

    const shadeEmpty = isEmptyMetaValue(meta.shade);
    const materialEmpty = isEmptyMetaValue(meta.material);

    // Nothing to do if both are already populated.
    if (!shadeEmpty && !materialEmpty) {
      skippedAlreadyPopulated++;
      continue;
    }

    const restorations = await db
      .select({
        shade: caseRestorations.shade,
        material: caseRestorations.material,
        restorationType: caseRestorations.restorationType,
      })
      .from(caseRestorations)
      .where(eq(caseRestorations.caseId, inv.caseId));

    // "missing" markers are clinical annotations, not billable restorations —
    // mirror the invoice-generation filter so we don't pull their (empty)
    // shade/material into the snapshot.
    const billable = restorations.filter(
      (r) => !/^missing$/i.test(r.restorationType ?? ""),
    );

    const derivedShade = distinctJoin(billable.map((r) => r.shade));
    const derivedMaterial = distinctJoin(billable.map((r) => r.material));

    const setShade = shadeEmpty && derivedShade ? derivedShade : null;
    const setMaterial =
      materialEmpty && derivedMaterial ? derivedMaterial : null;

    if (!setShade && !setMaterial) {
      skippedNoDerivable++;
      continue;
    }

    planned.push({ id: inv.id, meta, setShade, setMaterial });
  }

  console.log(
    `[backfill-invoice-display-shade-material] scanned ${scanned} case-linked invoices`,
  );
  console.log(`  skip (already populated): ${skippedAlreadyPopulated}`);
  console.log(`  skip (nothing derivable): ${skippedNoDerivable}`);
  console.log(`  invoices to update:       ${planned.length}`);

  if (dryRun) {
    console.log(
      "[backfill-invoice-display-shade-material] dry-run — no writes performed",
    );
    await pool.end();
    return;
  }

  let updated = 0;
  for (let i = 0; i < planned.length; i += batch) {
    const slice = planned.slice(i, i + batch);
    await db.transaction(async (tx) => {
      for (const p of slice) {
        const nextMeta: Record<string, unknown> = { ...p.meta };
        if (p.setShade) nextMeta.shade = p.setShade;
        if (p.setMaterial) nextMeta.material = p.setMaterial;
        await tx
          .update(invoices)
          .set({ displayMetadataJson: nextMeta })
          .where(eq(invoices.id, p.id));
      }
    });
    updated += slice.length;
    console.log(
      `[backfill-invoice-display-shade-material] updated ${updated} / ${planned.length}`,
    );
  }

  console.log(
    `[backfill-invoice-display-shade-material] done — ${updated} invoices updated`,
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
