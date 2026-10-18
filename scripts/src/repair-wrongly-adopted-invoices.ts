/**
 * Repair invoices that were WRONGLY ADOPTED by a foreign canonical case.
 *
 * Background: POST /api/invoices/cases/:caseId/generate-invoice derives an
 * invoice number from the case number ("INV-<caseNumber>"). Case numbers are
 * reused across the legacy-mobile (`lab_cases`) and canonical (`cases`) spaces,
 * so — before the relink guard was added — generate-invoice could adopt a
 * pre-existing *orphaned* invoice (caseId=null) that actually belonged to a
 * DIFFERENT patient, setting `caseId` (+ stealing the case's
 * `providerOrganizationId`) while leaving the real owner's
 * `display_metadata_json` (patientName / billTo) in place.
 *
 * IMPORTANT — repair direction: the invoice's `display_metadata_json` is the
 * TRUE identity of the invoice. The foreign `caseId` and the
 * `providerOrganizationId` it dragged in are the corruption. This script
 * UN-ADOPTS each wrongly-adopted invoice:
 *   - detaches the foreign case        (caseId -> null)
 *   - restores the true provider org   (providerOrganizationId -> target/null)
 *   - PRESERVES display_metadata_json  (patientName / billTo left untouched)
 *
 * It operates on an explicit, audited whitelist — NO fuzzy matching on
 * financial records. Each entry declares the expected current state; the script
 * verifies identity (invoice number, lab) and the true patient before writing,
 * and refuses to touch any row whose state does not match (already repaired,
 * unexpected link, etc.). It is idempotent: a repaired row is reported and
 * skipped.
 *
 * Required env:
 *   DATABASE_URL — Postgres connection string (same one the API uses). Run this
 *   against the environment that holds the drifted rows (production).
 *
 * Flags:
 *   --apply   Perform writes. Default is a dry-run (no writes).
 *
 * NOTE: output includes patient / provider names (PHI). Do not run this in
 * public CI logs — retain the console output as the operational audit record.
 */

import { and, eq, isNull, or } from "drizzle-orm";
import { db, pool, invoices } from "@workspace/db";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type Repair = {
  invoiceNumber: string;
  labOrganizationId: string;
  invoiceId: string;
  /** The foreign canonical case this invoice was wrongly adopted by. */
  expectedCaseId: string;
  /** The invoice's TRUE patient (from display_metadata_json) — must be preserved. */
  expectedMetaPatient: string;
  /** Restore the invoice's true provider org. `null` clears the stolen attribution. */
  targetProviderOrganizationId: string | null;
  /** Human-readable provider name for the report. */
  targetProviderLabel: string;
};

const PRIVATE_REPAIRS_URL = new URL(
  "../../support/private-repair-wrongly-adopted-invoices.json",
  import.meta.url,
);

function isRepair(value: unknown): value is Repair {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const uuid = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      candidate,
    );
  const nonEmpty = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && candidate.trim().length > 0;
  return (
    nonEmpty(item.invoiceNumber) &&
    /^INV-[A-Z0-9-]+$/i.test(item.invoiceNumber) &&
    uuid(item.labOrganizationId) &&
    uuid(item.invoiceId) &&
    uuid(item.expectedCaseId) &&
    nonEmpty(item.expectedMetaPatient) &&
    (item.targetProviderOrganizationId === null ||
      uuid(item.targetProviderOrganizationId)) &&
    nonEmpty(item.targetProviderLabel)
  );
}

async function loadRepairs(): Promise<Repair[]> {
  const configPath = fileURLToPath(PRIVATE_REPAIRS_URL);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    throw new Error("Private invoice-repair configuration is unavailable.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Private invoice-repair configuration is invalid.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { repairs?: unknown }).repairs) ||
    !(parsed as { repairs: unknown[] }).repairs.length ||
    !(parsed as { repairs: unknown[] }).repairs.every(isRepair)
  ) {
    throw new Error("Private invoice-repair configuration is invalid.");
  }
  return (parsed as { repairs: Repair[] }).repairs;
}

function parseFlags() {
  const args = process.argv.slice(2);
  let apply = false;
  for (const a of args) {
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { apply };
}

function norm(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function main() {
  const { apply } = parseFlags();
  const repairs = await loadRepairs();
  console.log(
    `[repair-wrongly-adopted-invoices] mode=${apply ? "APPLY (writes)" : "DRY-RUN"}`,
  );
  console.log(
    "  NOTE: output includes patient/provider names (PHI) — do not run in public CI logs.\n",
  );

  const toApply: Repair[] = [];
  let alreadyRepaired = 0;
  let refused = 0;

  for (const r of repairs) {
    const inv = await db.query.invoices.findFirst({
      where: eq(invoices.id, r.invoiceId),
    });
    if (!inv) {
      console.warn(`  ✗ ${r.invoiceNumber}: invoice id ${r.invoiceId} not found — SKIPPED`);
      refused++;
      continue;
    }

    // Identity guard — never touch the wrong row.
    if (
      inv.invoiceNumber !== r.invoiceNumber ||
      inv.labOrganizationId !== r.labOrganizationId
    ) {
      console.warn(
        `  ✗ ${r.invoiceNumber}: identity mismatch (got number="${inv.invoiceNumber}", ` +
          `lab="${inv.labOrganizationId}") — SKIPPED`,
      );
      refused++;
      continue;
    }

    const meta = (
      inv.displayMetadataJson && typeof inv.displayMetadataJson === "object"
        ? inv.displayMetadataJson
        : {}
    ) as Record<string, unknown>;
    const metaPatient = norm(meta.patientName);
    if (metaPatient.toLowerCase() !== r.expectedMetaPatient.toLowerCase()) {
      console.warn(
        `  ✗ ${r.invoiceNumber}: stored patient "${metaPatient}" != expected ` +
          `"${r.expectedMetaPatient}" — SKIPPED (re-verify before editing the whitelist)`,
      );
      refused++;
      continue;
    }

    const fullyRepaired =
      inv.caseId === null &&
      (inv.providerOrganizationId ?? null) === r.targetProviderOrganizationId;
    if (fullyRepaired) {
      console.log(
        `  • ${r.invoiceNumber}: already repaired (caseId=null, provider correct) — SKIPPED`,
      );
      alreadyRepaired++;
      continue;
    }

    // If still linked, it must be linked to the EXPECTED foreign case. A
    // different link means the data moved on — refuse rather than guess.
    if (inv.caseId !== null && inv.caseId !== r.expectedCaseId) {
      console.warn(
        `  ✗ ${r.invoiceNumber}: linked caseId "${inv.caseId}" != expected foreign case ` +
          `"${r.expectedCaseId}" — SKIPPED (state changed; re-verify)`,
      );
      refused++;
      continue;
    }

    console.log(
      `  ✓ ${r.invoiceNumber} [${inv.status}] patient="${metaPatient}" (preserved)\n` +
        `      caseId:   ${inv.caseId ?? "null"} -> null (detach foreign case)\n` +
        `      provider: ${inv.providerOrganizationId ?? "null"} -> ` +
        `${r.targetProviderOrganizationId ?? "null"}  [${r.targetProviderLabel}]`,
    );
    toApply.push(r);
  }

  console.log("");
  console.log(
    `[repair-wrongly-adopted-invoices] to repair: ${toApply.length} | ` +
      `already repaired: ${alreadyRepaired} | refused: ${refused}`,
  );

  if (!apply) {
    console.log(
      "\n[repair-wrongly-adopted-invoices] dry-run — no writes performed. " +
        "Re-run with --apply to repair.",
    );
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const r of toApply) {
      // Guarded UPDATE: re-assert identity + that the row is still in the
      // expected (or already-detached) state inside the same write, so a state
      // change between the read above and this write cannot silently mis-edit.
      const updated = await tx
        .update(invoices)
        .set({
          caseId: null,
          providerOrganizationId: r.targetProviderOrganizationId,
          // display_metadata_json intentionally NOT modified — it is the true identity.
        })
        .where(
          and(
            eq(invoices.id, r.invoiceId),
            eq(invoices.invoiceNumber, r.invoiceNumber),
            eq(invoices.labOrganizationId, r.labOrganizationId),
            or(eq(invoices.caseId, r.expectedCaseId), isNull(invoices.caseId)),
          ),
        )
        .returning({ id: invoices.id });
      if (updated.length !== 1) {
        throw new Error(
          `[repair-wrongly-adopted-invoices] guarded UPDATE for ${r.invoiceNumber} ` +
            `affected ${updated.length} rows (expected 1) — rolling back all changes.`,
        );
      }
    }
  });

  console.log(
    `\n[repair-wrongly-adopted-invoices] done — ${toApply.length} invoice(s) repaired.`,
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
