/**
 * Repair invoices whose `display_metadata_json` patient/billing identity has
 * drifted away from their linked case.
 *
 * Background: POST /api/invoices/cases/:caseId/generate-invoice derives an
 * invoice number from the case number (`INV-<caseNumber>`). Case numbers are
 * reused across the legacy-mobile (`lab_cases`) and canonical (`cases`)
 * spaces, so the generate-invoice endpoint could (before the relink guard was
 * added) adopt a pre-existing *orphaned* invoice (caseId=null) that actually
 * belonged to a DIFFERENT patient, setting only `caseId` and leaving the other
 * patient's `display_metadata_json` (patientName / billTo) and
 * `providerOrganizationId` in place. The invoice editor then shows a correct
 * "Rx Summary" (read from the linked case) but a WRONG "Patient & billing
 * details" (read from the stale snapshot).
 *
 * This script finds every case-linked invoice whose stored `patientName`
 * disagrees with its linked case's patient, and realigns the identity/billing
 * fields — `patientName`, `billTo`, and `providerOrganizationId` — to the
 * linked case. All other metadata keys (teeth, shade, caseNotes, lineItems,
 * layout, …) are preserved. It only touches rows where the patient name is
 * non-blank AND mismatched (the corruption signal); rows whose snapshot is
 * blank or already matches are left untouched.
 *
 * Financial review: the dry-run report prints each invoice's status so an
 * operator can review paid / voided / statemented invoices before applying.
 * The script does NOT rebuild line items or touch payments/deposits — if a
 * drifted invoice's line items reflect the wrong case, resolve that manually
 * (void + regenerate) after reviewing the report.
 *
 * Required env:
 *   DATABASE_URL — Postgres connection string (same one the API uses)
 *
 * Optional flags:
 *   --apply       Perform writes. Default is a dry-run (no writes).
 *   --limit <n>   Cap how many drifted invoices are processed in this run.
 *   --batch <n>   Update batch size (default: 200).
 *
 * Safe to re-run: realigned rows no longer drift and are skipped next time.
 */

import { eq, isNotNull } from "drizzle-orm";
import { db, pool, invoices, cases } from "@workspace/db";

function parseFlags() {
  const args = process.argv.slice(2);
  let apply = false;
  let limit: number | null = null;
  let batch = 200;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
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
  return { apply, limit, batch };
}

function normalizeName(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

type Planned = {
  id: string;
  invoiceNumber: string;
  status: string;
  meta: Record<string, unknown>;
  fromPatient: string;
  toPatient: string;
  fromBillTo: string;
  toBillTo: string;
  fromProvider: string | null;
  toProvider: string | null;
};

async function main() {
  const { apply, limit, batch } = parseFlags();

  console.log(
    `[repair-invoice-display-metadata-drift] mode=${apply ? "APPLY (writes)" : "DRY-RUN"} ` +
      `limit=${limit ?? "none"} batch=${batch}`,
  );

  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      caseId: invoices.caseId,
      displayMetadataJson: invoices.displayMetadataJson,
      providerOrganizationId: invoices.providerOrganizationId,
    })
    .from(invoices)
    .where(isNotNull(invoices.caseId));
  // NOTE: --limit caps the number of *drifted* invoices repaired (see the
  // break below), not the scan. We always scan every case-linked invoice so a
  // limited run can never silently skip drift hiding past an arbitrary cutoff.

  let scanned = 0;
  let skippedBlank = 0;
  let skippedMatch = 0;
  let skippedNoCase = 0;
  const planned: Planned[] = [];

  for (const inv of rows) {
    if (planned.length >= (limit ?? Infinity)) break;
    scanned++;
    if (!inv.caseId) continue;

    const meta = (
      inv.displayMetadataJson && typeof inv.displayMetadataJson === "object"
        ? inv.displayMetadataJson
        : {}
    ) as Record<string, unknown>;

    const storedPatient = normalizeName(meta.patientName);
    // A blank snapshot is not "drifted" — it's just unpopulated.
    if (storedPatient.length === 0) {
      skippedBlank++;
      continue;
    }

    const caseRow = await db.query.cases.findFirst({
      where: eq(cases.id, inv.caseId),
    });
    if (!caseRow) {
      skippedNoCase++;
      continue;
    }

    const casePatient = normalizeName(
      `${caseRow.patientFirstName ?? ""} ${caseRow.patientLastName ?? ""}`,
    );
    if (
      casePatient.length === 0 ||
      storedPatient.toLowerCase() === casePatient.toLowerCase()
    ) {
      skippedMatch++;
      continue;
    }

    // Drift confirmed: realign the identity/billing fields to the linked case.
    const caseDoctor = normalizeName(caseRow.doctorName);
    planned.push({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      meta,
      fromPatient: storedPatient,
      toPatient: casePatient,
      fromBillTo: normalizeName(meta.billTo),
      toBillTo: caseDoctor,
      fromProvider: inv.providerOrganizationId ?? null,
      toProvider: caseRow.providerOrganizationId ?? null,
    });
  }

  console.log(
    `[repair-invoice-display-metadata-drift] scanned ${scanned} case-linked invoices`,
  );
  console.log(`  skip (blank snapshot patient): ${skippedBlank}`);
  console.log(`  skip (already matches case):   ${skippedMatch}`);
  console.log(`  skip (linked case missing):    ${skippedNoCase}`);
  console.log(`  drifted invoices to repair:    ${planned.length}`);
  console.log("");

  for (const p of planned) {
    const provChange =
      p.fromProvider !== p.toProvider
        ? ` | provider: ${p.fromProvider ?? "null"} -> ${p.toProvider ?? "null"}`
        : "";
    console.log(
      `  ${p.invoiceNumber} [${p.status}] patient: "${p.fromPatient}" -> "${p.toPatient}"` +
        ` | billTo: "${p.fromBillTo}" -> "${p.toBillTo}"${provChange}`,
    );
    if (p.status === "paid" || p.status === "statemented") {
      console.log(
        `    ⚠ status="${p.status}" — review payments/statements before relying on the repaired header.`,
      );
    }
  }
  console.log("");

  if (!apply) {
    console.log(
      "[repair-invoice-display-metadata-drift] dry-run — no writes performed. Re-run with --apply to repair.",
    );
    await pool.end();
    return;
  }

  let updated = 0;
  for (let i = 0; i < planned.length; i += batch) {
    const slice = planned.slice(i, i + batch);
    await db.transaction(async (tx) => {
      for (const p of slice) {
        const nextMeta: Record<string, unknown> = {
          ...p.meta,
          patientName: p.toPatient,
          billTo: p.toBillTo,
        };
        await tx
          .update(invoices)
          .set({
            displayMetadataJson: nextMeta,
            providerOrganizationId: p.toProvider,
          })
          .where(eq(invoices.id, p.id));
      }
    });
    updated += slice.length;
    console.log(
      `[repair-invoice-display-metadata-drift] updated ${updated} / ${planned.length}`,
    );
  }

  console.log(
    `[repair-invoice-display-metadata-drift] done — ${updated} invoices repaired`,
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
