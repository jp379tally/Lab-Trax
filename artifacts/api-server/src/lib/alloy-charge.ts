import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { caseEvents, caseRestorations } from "@workspace/db";
import { resolveServerPriceWithSource } from "./pricing";
import { syncInvoiceFromRestorations } from "./invoice-sync";

/**
 * Alloy surcharge support for PFM cases (Task #2067).
 *
 * PFM (porcelain-fused-to-metal) restorations incur an alloy/metal cost
 * that labs bill as a separate line. Task #2066 added a "don't forget to
 * charge for alloy" reminder; this module lets the alloy line actually be
 * added — either one-click from that reminder or automatically when a lab
 * opts into `organizations.autoAddAlloyOnPfm`.
 *
 * The alloy line is modelled as a `case_restorations` row (restorationType
 * "Alloy", no tooth) rather than a manual invoice line so it survives the
 * invoice re-sync that runs on every restoration change. Its price resolves
 * through the standard override → tier → default cascade via the `alloy`
 * price key (see `material-mapping.ts`).
 */

export const ALLOY_PRICE_KEY = "alloy";
export const ALLOY_RESTORATION_TYPE = "Alloy";

/** A restoration that represents the alloy surcharge (not a tooth). */
export function isAlloyRestoration(r: {
  priceKey?: string | null;
  restorationType?: string | null;
  material?: string | null;
}): boolean {
  if ((r.priceKey ?? "").toLowerCase() === ALLOY_PRICE_KEY) return true;
  return (r.restorationType ?? "").trim().toLowerCase() === "alloy";
}

interface AlloyCaseRow {
  id: string;
  labOrganizationId: string;
  doctorName: string | null;
  providerOrganizationId: string | null;
}

export interface AddAlloyChargeResult {
  added: boolean;
  alreadyPresent: boolean;
  /** True when a non-zero price resolved from the tier/override cascade. */
  priced: boolean;
  restorationId: string | null;
}

/**
 * Add an alloy surcharge line to a case's restorations (and re-sync its
 * invoice). Idempotent: if the case already carries an alloy line, this is
 * a no-op and returns `{ added: false, alreadyPresent: true }`.
 *
 * The unit price is resolved through {@link resolveServerPriceWithSource}
 * using the `alloy` price key. When the lab hasn't configured an alloy
 * price in any tier/override the line is still added at $0 (so the reminder
 * is satisfied and the lab can fill in the price), with `priced: false`.
 */
export async function addAlloyChargeToCase(args: {
  caseRow: AlloyCaseRow;
  actorUserId: string | null;
  actorInitials?: string | null;
}): Promise<AddAlloyChargeResult> {
  const { caseRow, actorUserId } = args;

  const existing = await db.query.caseRestorations.findMany({
    where: eq(caseRestorations.caseId, caseRow.id),
  });
  if (existing.some((r) => isAlloyRestoration(r))) {
    return {
      added: false,
      alreadyPresent: true,
      priced: false,
      restorationId: null,
    };
  }

  const resolved = await resolveServerPriceWithSource(
    {
      labOrganizationId: caseRow.labOrganizationId,
      doctorName: caseRow.doctorName,
      providerOrganizationId: caseRow.providerOrganizationId,
    },
    ALLOY_RESTORATION_TYPE,
    ALLOY_RESTORATION_TYPE,
  );

  const unit = resolved?.amount ?? 0;

  const [restoration] = await db
    .insert(caseRestorations)
    .values({
      caseId: caseRow.id,
      toothNumber: "N/A",
      restorationType: ALLOY_RESTORATION_TYPE,
      material: null,
      shade: null,
      notes: null,
      quantity: 1,
      unitPrice: unit.toFixed(2),
      priceSource: resolved?.source ?? null,
      priceSourceId: resolved?.sourceId ?? null,
      priceSourceName: resolved?.sourceName ?? null,
      priceKey: ALLOY_PRICE_KEY,
    })
    .returning();

  await db.insert(caseEvents).values({
    caseId: caseRow.id,
    eventType: "restoration_added",
    actorUserId,
    actorOrganizationId: caseRow.labOrganizationId,
    actorInitials: args.actorInitials || "SYS",
    metadataJson: {
      restorationId: restoration.id,
      restorationType: restoration.restorationType,
      toothNumber: restoration.toothNumber,
      material: restoration.material,
      quantity: restoration.quantity,
      unitPrice: restoration.unitPrice,
      alloySurcharge: true,
    },
  });

  await syncInvoiceFromRestorations({
    caseId: caseRow.id,
    actorUserId,
  });

  return {
    added: true,
    alreadyPresent: false,
    priced: unit > 0,
    restorationId: restoration.id,
  };
}

export interface RemoveAlloyChargeResult {
  removed: boolean;
  alreadyAbsent: boolean;
  /** IDs of the alloy restoration rows that were deleted. */
  removedRestorationIds: string[];
}

/**
 * Remove the alloy surcharge line(s) from a case's restorations (and re-sync
 * its invoice). This is the dedicated "remove alloy charge" affordance for
 * correcting a wrongly added (manual or auto-added) alloy line.
 *
 * Idempotent: if the case carries no alloy line this is a no-op and returns
 * `{ removed: false, alreadyAbsent: true, removedRestorationIds: [] }`.
 *
 * Defensive against the (unexpected) presence of more than one alloy row — it
 * removes every alloy restoration so the case is left in a clean state. A
 * `restoration_deleted` case event carrying the `alloySurcharge` marker is
 * written for each removed row before the invoice is re-synced.
 */
export async function removeAlloyChargeFromCase(args: {
  caseRow: AlloyCaseRow;
  actorUserId: string | null;
  actorInitials?: string | null;
}): Promise<RemoveAlloyChargeResult> {
  const { caseRow, actorUserId } = args;

  const existing = await db.query.caseRestorations.findMany({
    where: eq(caseRestorations.caseId, caseRow.id),
  });
  const alloyRows = existing.filter((r) => isAlloyRestoration(r));

  if (alloyRows.length === 0) {
    return {
      removed: false,
      alreadyAbsent: true,
      removedRestorationIds: [],
    };
  }

  const removedRestorationIds: string[] = [];
  for (const row of alloyRows) {
    await db.delete(caseRestorations).where(eq(caseRestorations.id, row.id));
    removedRestorationIds.push(row.id);

    await db.insert(caseEvents).values({
      caseId: caseRow.id,
      eventType: "restoration_deleted",
      actorUserId,
      actorOrganizationId: caseRow.labOrganizationId,
      actorInitials: args.actorInitials || "SYS",
      metadataJson: {
        restorationId: row.id,
        restorationType: row.restorationType,
        toothNumber: row.toothNumber,
        material: row.material,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        alloySurcharge: true,
      },
    });
  }

  await syncInvoiceFromRestorations({
    caseId: caseRow.id,
    actorUserId,
  });

  return {
    removed: true,
    alreadyAbsent: false,
    removedRestorationIds,
  };
}
