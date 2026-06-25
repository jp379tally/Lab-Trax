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

// Verified against the production read replica (lab fe67257e). In both rows the
// display_metadata_json holds the correct patient/billing, while caseId +
// providerOrganizationId were corrupted by a same-numbered canonical case.
const REPAIRS: Repair[] = [
  {
    invoiceNumber: "INV-26-48",
    labOrganizationId: "fe67257e-5cc5-4489-afc9-62afb5b9829c",
    invoiceId: "0d60b053-eed7-4530-b543-8840762d5f37",
    expectedCaseId: "e5b3e9fc-65ed-4c6e-bf47-ac35ec921cbb", // Michele Barber / First Care (foreign)
    expectedMetaPatient: "Debra Hudson",
    targetProviderOrganizationId: "194758c4-9ce4-435b-bab7-498a920620d1",
    targetProviderLabel: "Brittney K Craig DMD",
  },
  {
    invoiceNumber: "INV-26-38",
    labOrganizationId: "fe67257e-5cc5-4489-afc9-62afb5b9829c",
    invoiceId: "aaa001d4-f2df-4390-b8bb-a568c1cd6019",
    expectedCaseId: "c71181cc-1bc5-4f03-975c-aca8dd6b6e63", // Alba Hurtado / Heartland (foreign)
    expectedMetaPatient: "Pam Mcgoff",
    targetProviderOrganizationId: null, // no organization exists for "Dr. Dalton"
    targetProviderLabel: "(cleared — no provider org)",
  },
];

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
  console.log(
    `[repair-wrongly-adopted-invoices] mode=${apply ? "APPLY (writes)" : "DRY-RUN"}`,
  );
  console.log(
    "  NOTE: output includes patient/provider names (PHI) — do not run in public CI logs.\n",
  );

  const toApply: Repair[] = [];
  let alreadyRepaired = 0;
  let refused = 0;

  for (const r of REPAIRS) {
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
