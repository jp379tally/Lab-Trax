import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  caseEvents,
  caseRestorations,
  pricingOverrides,
  pricingTiers,
} from "@workspace/db";
import {
  resolveAlloyPriceTarget,
  resolveServerPriceWithSource,
  type AlloyPriceTarget,
} from "./pricing";
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
  /**
   * True when the add was refused because no alloy price is configured and
   * the caller passed `requirePriced` (manual reminder add). Prevents a
   * silent $0 line from being created.
   */
  skippedUnpriced: boolean;
  restorationId: string | null;
}

export interface AlloyPricePreview {
  /** Resolved unit price (0 when no alloy price is configured). */
  amount: number;
  /** True when a non-zero price resolved from the tier/override cascade. */
  priced: boolean;
  /** Where the price came from ("tier" | "override" | "default"), or null. */
  source: string | null;
}

/**
 * Resolve what the alloy surcharge *would* cost for a case without adding
 * it — used by the PFM reminder banner so the user sees the price (or a
 * "no alloy price set" warning) before clicking "Add alloy charge".
 */
export async function resolveAlloyPricePreview(
  caseRow: Pick<
    AlloyCaseRow,
    "labOrganizationId" | "doctorName" | "providerOrganizationId"
  >,
): Promise<AlloyPricePreview> {
  const resolved = await resolveServerPriceWithSource(
    {
      labOrganizationId: caseRow.labOrganizationId,
      doctorName: caseRow.doctorName,
      providerOrganizationId: caseRow.providerOrganizationId,
    },
    ALLOY_RESTORATION_TYPE,
    ALLOY_RESTORATION_TYPE,
  );
  const amount = resolved?.amount ?? 0;
  return {
    amount,
    priced: amount > 0,
    source: resolved?.source ?? null,
  };
}

/**
 * Add an alloy surcharge line to a case's restorations (and re-sync its
 * invoice). Idempotent: if the case already carries an alloy line, this is
 * a no-op and returns `{ added: false, alreadyPresent: true }`.
 *
 * The unit price is resolved through {@link resolveServerPriceWithSource}
 * using the `alloy` price key.
 *
 * When the lab hasn't configured an alloy price in any tier/override:
 * - with `requirePriced: true` (the manual reminder add) the line is NOT
 *   created — the call returns `{ added: false, skippedUnpriced: true }` so
 *   the caller can steer the user to the fee schedule instead of silently
 *   creating a $0 line.
 * - otherwise (e.g. the `autoAddAlloyOnPfm` path) the line is still added at
 *   $0 with `priced: false` so the reminder is satisfied and the lab can
 *   fill in the price later.
 */
export async function addAlloyChargeToCase(args: {
  caseRow: AlloyCaseRow;
  actorUserId: string | null;
  actorInitials?: string | null;
  /** Refuse to add a $0 line when no alloy price is configured. */
  requirePriced?: boolean;
}): Promise<AddAlloyChargeResult> {
  const { caseRow, actorUserId, requirePriced = false } = args;

  const existing = await db.query.caseRestorations.findMany({
    where: eq(caseRestorations.caseId, caseRow.id),
  });
  if (existing.some((r) => isAlloyRestoration(r))) {
    return {
      added: false,
      alreadyPresent: true,
      priced: false,
      skippedUnpriced: false,
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

  // Server-side backstop: never create a silent $0 alloy line from the manual
  // reminder add. UI timing (clicking before the price preview loads) can't
  // reintroduce a $0 line because the resolution happens here too.
  if (requirePriced && unit <= 0) {
    return {
      added: false,
      alreadyPresent: false,
      priced: false,
      skippedUnpriced: true,
      restorationId: null,
    };
  }

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
    skippedUnpriced: false,
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

export interface SetAlloyPriceResult {
  /** The tier/override the price was written to. */
  target: AlloyPriceTarget;
  /** The resolved unit price now applied to the case's alloy line. */
  amount: number;
  /** The alloy restoration row on the case (created if it was missing). */
  restorationId: string | null;
  /** Prices map before the edit, for audit logging. */
  beforePrices: Record<string, number>;
  /** Prices map after the edit, for audit logging. */
  afterPrices: Record<string, number>;
}

function toPricesMap(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(
    (json ?? {}) as Record<string, unknown>,
  )) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

/**
 * Set the alloy price for the tier/override a case resolves to, then re-price
 * the case's alloy line and re-sync its invoice. Powers the "set alloy price"
 * affordance on the PFM reminder when {@link addAlloyChargeToCase} added the
 * line at $0 (`priced: false`).
 *
 * The destination is chosen by {@link resolveAlloyPriceTarget} so the price is
 * written exactly where pricing resolution will read it back. When the lab has
 * no tier or override at all, a "Standard" tier is created to hold the price.
 */
export async function setAlloyPriceForCase(args: {
  caseRow: AlloyCaseRow;
  price: number;
  actorUserId: string | null;
  actorInitials?: string | null;
}): Promise<SetAlloyPriceResult> {
  const { caseRow, actorUserId } = args;
  const price = Math.round(args.price * 100) / 100;

  const ctx = {
    labOrganizationId: caseRow.labOrganizationId,
    doctorName: caseRow.doctorName,
    providerOrganizationId: caseRow.providerOrganizationId,
  };

  let target = await resolveAlloyPriceTarget(ctx);
  let beforePrices: Record<string, number>;
  let afterPrices: Record<string, number>;

  if (!target) {
    // Lab has no tier or override to hold the price — create a "Standard"
    // tier so resolution can read it back (matches the default fallback).
    beforePrices = {};
    afterPrices = { [ALLOY_PRICE_KEY]: price };
    const [created] = await db
      .insert(pricingTiers)
      .values({
        labOrganizationId: caseRow.labOrganizationId,
        name: "Standard",
        pricesJson: afterPrices,
        createdByUserId: actorUserId,
      })
      .returning();
    target = { kind: "tier", id: created.id, name: created.name };
  } else if (target.kind === "tier") {
    const tier = await db.query.pricingTiers.findFirst({
      where: eq(pricingTiers.id, target.id),
    });
    beforePrices = toPricesMap(tier?.pricesJson);
    afterPrices = { ...beforePrices, [ALLOY_PRICE_KEY]: price };
    await db
      .update(pricingTiers)
      .set({ pricesJson: afterPrices, updatedAt: new Date() })
      .where(eq(pricingTiers.id, target.id));
  } else {
    const override = await db.query.pricingOverrides.findFirst({
      where: eq(pricingOverrides.id, target.id),
    });
    beforePrices = toPricesMap(override?.pricesJson);
    afterPrices = { ...beforePrices, [ALLOY_PRICE_KEY]: price };
    await db
      .update(pricingOverrides)
      .set({ pricesJson: afterPrices, updatedAt: new Date() })
      .where(eq(pricingOverrides.id, target.id));
  }

  // Re-resolve so the case's alloy line reflects the price we just set,
  // carrying the proper price source (tier/override) for traceability.
  const resolved = await resolveServerPriceWithSource(
    ctx,
    ALLOY_RESTORATION_TYPE,
    ALLOY_RESTORATION_TYPE,
  );
  const unit = resolved?.amount ?? price;

  const existing = await db.query.caseRestorations.findMany({
    where: eq(caseRestorations.caseId, caseRow.id),
  });
  let alloyRow = existing.find((r) => isAlloyRestoration(r)) ?? null;

  if (alloyRow) {
    await db
      .update(caseRestorations)
      .set({
        unitPrice: unit.toFixed(2),
        priceSource: resolved?.source ?? null,
        priceSourceId: resolved?.sourceId ?? null,
        priceSourceName: resolved?.sourceName ?? null,
        priceKey: ALLOY_PRICE_KEY,
      })
      .where(eq(caseRestorations.id, alloyRow.id));
  } else {
    const [created] = await db
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
    alloyRow = created;
  }

  await db.insert(caseEvents).values({
    caseId: caseRow.id,
    eventType: "case_restoration_price_updated",
    actorUserId,
    actorOrganizationId: caseRow.labOrganizationId,
    actorInitials: args.actorInitials || "SYS",
    metadataJson: {
      restorationId: alloyRow.id,
      restorationType: ALLOY_RESTORATION_TYPE,
      unitPrice: unit.toFixed(2),
      alloySurcharge: true,
      alloyPriceSet: true,
      target: target.kind,
      targetName: target.name,
    },
  });

  await syncInvoiceFromRestorations({
    caseId: caseRow.id,
    actorUserId,
  });

  return {
    target,
    amount: unit,
    restorationId: alloyRow.id,
    beforePrices,
    afterPrices,
  };
}
