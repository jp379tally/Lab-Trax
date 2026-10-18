import { and, eq } from "drizzle-orm";
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
import { resolveRestorationPriceKey } from "./restoration-pricing.js";
import { HttpError } from "./http.js";
import { syncInvoiceFromRestorations } from "./invoice-sync";
import { isPfmOrFcmMaterial } from "./material-mapping.js";

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
 * invoice). Idempotent: if the case already carries alloy line(s), this is
 * a no-op and returns `{ added: false, alreadyPresent: true }`.
 *
 * **Per-tooth path (preferred):** when the case has PFM or full-contour-metal
 * (FCM) restorations, one alloy row is inserted **per tooth** at $0 with no
 * price source. The invoice sync then renders each row as a child sub-item
 * beneath its matching PFM/FCM parent line, clearly showing which teeth need
 * alloy pricing. Per-tooth rows always start unpriced; `requirePriced` is
 * ignored for this path.
 *
 * **Legacy path (fallback):** when no PFM/FCM restorations exist (e.g. the
 * manual one-click add on a case whose material wasn't detected as PFM), a
 * single alloy row with `toothNumber: "N/A"` is inserted at the price resolved
 * from the tier/override cascade. `requirePriced: true` refuses a $0 insert on
 * this path (manual reminder add backstop).
 */
export async function addAlloyChargeToCase(args: {
  caseRow: AlloyCaseRow;
  actorUserId: string | null;
  actorInitials?: string | null;
  /** Refuse to add a $0 line when no alloy price is configured (legacy path only). */
  requirePriced?: boolean;
  /**
   * When true, only run the per-tooth PFM/FCM path and return a no-op when
   * there are no PFM/FCM restorations. Prevents the legacy single-N/A-row path
   * from firing when called automatically from case-creation routes.
   */
  pfmOnly?: boolean;
}): Promise<AddAlloyChargeResult> {
  const { caseRow, actorUserId, requirePriced = false } = args;

  const existing = await db.query.caseRestorations.findMany({
    where: eq(caseRestorations.caseId, caseRow.id),
  });

  const existingAlloy = existing.filter((r) => isAlloyRestoration(r));

  // ── Per-tooth path ───────────────────────────────────────────────────────
  // Find PFM/FCM restorations: these need one alloy row per tooth.
  const pfmFcmRestorations = existing.filter(
    (r) => !isAlloyRestoration(r) && isPfmOrFcmMaterial(r.material),
  );

  if (pfmFcmRestorations.length > 0) {
    // Find which PFM/FCM teeth already have a per-tooth alloy row.
    const existingAlloyTeeth = new Set(
      existingAlloy
        .map((r) => (r.toothNumber ?? "").trim())
        .filter((t) => t && t !== "N/A" && /^\d+$/.test(t)),
    );
    const teethNeedingAlloy = pfmFcmRestorations
      .map((r) => (r.toothNumber ?? "").trim())
      .filter((t) => t && /^\d+$/.test(t) && !existingAlloyTeeth.has(t));

    if (teethNeedingAlloy.length === 0) {
      // All PFM/FCM teeth are already covered.
      return {
        added: false,
        alreadyPresent: true,
        priced: false,
        skippedUnpriced: false,
        restorationId: existingAlloy[0]?.id ?? null,
      };
    }

    // Insert one alloy restoration per uncovered PFM/FCM tooth, always at $0.
    // The lab prices these from the case detail after case creation.
    const insertedIds: string[] = [];
    for (const tooth of teethNeedingAlloy) {
      const [restoration] = await db
        .insert(caseRestorations)
        .values({
          caseId: caseRow.id,
          toothNumber: tooth,
          restorationType: ALLOY_RESTORATION_TYPE,
          material: null,
          shade: null,
          notes: null,
          quantity: 1,
          unitPrice: "0.00",
          priceSource: null,
          priceSourceId: null,
          priceSourceName: null,
          priceKey: ALLOY_PRICE_KEY,
        })
        .returning();
      insertedIds.push(restoration.id);

      await db.insert(caseEvents).values({
        caseId: caseRow.id,
        eventType: "restoration_added",
        actorUserId,
        actorOrganizationId: caseRow.labOrganizationId,
        actorInitials: args.actorInitials || "SYS",
        metadataJson: {
          restorationId: restoration.id,
          restorationType: ALLOY_RESTORATION_TYPE,
          toothNumber: tooth,
          material: null,
          quantity: 1,
          unitPrice: "0.00",
          alloySurcharge: true,
          perToothAlloy: true,
        },
      });
    }

    await syncInvoiceFromRestorations({ caseId: caseRow.id, actorUserId });

    return {
      added: true,
      alreadyPresent: false,
      priced: false,
      skippedUnpriced: false,
      restorationId: insertedIds[0] ?? null,
    };
  }

  // ── Legacy path: no PFM/FCM restorations — single N/A alloy row ──────────
  // When pfmOnly is set (called from case-creation routes), skip this path
  // entirely so we don't auto-insert a N/A alloy row for non-PFM cases.
  if (args.pfmOnly) {
    return {
      added: false,
      alreadyPresent: false,
      priced: false,
      skippedUnpriced: false,
      restorationId: null,
    };
  }

  if (existingAlloy.length > 0) {
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
 * Write a price under `priceKey` into the tier/override a case resolves to.
 *
 * The destination is chosen by {@link resolveAlloyPriceTarget} (despite the
 * name it is price-key agnostic — it only picks the target the case's pricing
 * resolves to) so the price is written exactly where pricing resolution will
 * read it back. When the lab has no tier or override at all, a "Standard" tier
 * is created to hold the price. Shared by the alloy flow and the generic
 * per-restoration "set price" flow.
 */
async function writePriceKeyToResolvedTarget(args: {
  caseRow: AlloyCaseRow;
  priceKey: string;
  price: number;
  actorUserId: string | null;
}): Promise<{
  target: AlloyPriceTarget;
  beforePrices: Record<string, number>;
  afterPrices: Record<string, number>;
}> {
  const { caseRow, priceKey, price, actorUserId } = args;
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
    afterPrices = { [priceKey]: price };
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
    afterPrices = { ...beforePrices, [priceKey]: price };
    await db
      .update(pricingTiers)
      .set({ pricesJson: afterPrices, updatedAt: new Date() })
      .where(eq(pricingTiers.id, target.id));
  } else {
    const override = await db.query.pricingOverrides.findFirst({
      where: eq(pricingOverrides.id, target.id),
    });
    beforePrices = toPricesMap(override?.pricesJson);
    afterPrices = { ...beforePrices, [priceKey]: price };
    await db
      .update(pricingOverrides)
      .set({ pricesJson: afterPrices, updatedAt: new Date() })
      .where(eq(pricingOverrides.id, target.id));
  }

  return { target, beforePrices, afterPrices };
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

  const { target, beforePrices, afterPrices } =
    await writePriceKeyToResolvedTarget({
      caseRow,
      priceKey: ALLOY_PRICE_KEY,
      price,
      actorUserId,
    });

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

/** Result of {@link setRestorationPriceForCase}. */
export interface SetRestorationPriceResult {
  /** Where the price was written. */
  target: AlloyPriceTarget;
  /** The resolved unit price after writing (what the line now reflects). */
  amount: number;
  /** The fee-schedule key the price was written under. */
  priceKey: string;
  /** The restoration that was re-priced. */
  restorationId: string;
  /** Prices map before the edit, for audit logging. */
  beforePrices: Record<string, number>;
  /** Prices map after the edit, for audit logging. */
  afterPrices: Record<string, number>;
}

/**
 * Generalization of {@link setAlloyPriceForCase} (Task #2084) to ANY
 * restoration line that shows $0/unpriced because its material/type has no
 * configured price in the tier/override the case resolves to.
 *
 * Derives the fee-schedule price key from the restoration
 * (`priceKey` ?? {@link materialToPriceKey}(material, restorationType)),
 * writes the price into the resolved tier/override via
 * {@link writePriceKeyToResolvedTarget}, re-resolves the line's price/source,
 * records a `case_restoration_price_updated` event, and re-syncs the invoice.
 *
 * Throws {@link HttpError} 404 if the restoration doesn't belong to the case,
 * or 400 if the restoration's material isn't mapped to a fee-schedule item
 * (so there is no key to write under).
 */
export async function setRestorationPriceForCase(args: {
  caseRow: AlloyCaseRow;
  restorationId: string;
  price: number;
  actorUserId: string | null;
  actorInitials?: string | null;
}): Promise<SetRestorationPriceResult> {
  const { caseRow, restorationId, actorUserId } = args;
  const price = Math.round(args.price * 100) / 100;

  const restoration = await db.query.caseRestorations.findFirst({
    where: and(
      eq(caseRestorations.id, restorationId),
      eq(caseRestorations.caseId, caseRow.id),
    ),
  });
  if (!restoration) {
    throw new HttpError(404, "Restoration not found on this case.");
  }

  const priceKey =
    restoration.priceKey && restoration.priceKey.trim()
      ? restoration.priceKey.trim()
      : await resolveRestorationPriceKey({
          labOrganizationId: caseRow.labOrganizationId,
          material: restoration.material,
          restorationType: restoration.restorationType,
          restorationSubtype: restoration.restorationSubtype,
        });
  if (!priceKey) {
    throw new HttpError(
      400,
      "This restoration's material isn't mapped to a fee-schedule item, so its price can't be set from the case. Edit the fee schedule directly.",
    );
  }

  const ctx = {
    labOrganizationId: caseRow.labOrganizationId,
    doctorName: caseRow.doctorName,
    providerOrganizationId: caseRow.providerOrganizationId,
  };

  const { target, beforePrices, afterPrices } =
    await writePriceKeyToResolvedTarget({
      caseRow,
      priceKey,
      price,
      actorUserId,
    });

  // Re-resolve so the line reflects the price we just set, carrying the
  // proper price source (tier/override) for traceability.
  const resolved = await resolveServerPriceWithSource(
    ctx,
    restoration.material,
    restoration.restorationType,
    restoration.restorationSubtype,
  );
  const unit = resolved?.amount ?? price;

  await db
    .update(caseRestorations)
    .set({
      unitPrice: unit.toFixed(2),
      priceSource: resolved?.source ?? null,
      priceSourceId: resolved?.sourceId ?? null,
      priceSourceName: resolved?.sourceName ?? null,
      priceKey,
    })
    .where(eq(caseRestorations.id, restoration.id));

  await db.insert(caseEvents).values({
    caseId: caseRow.id,
    eventType: "case_restoration_price_updated",
    actorUserId,
    actorOrganizationId: caseRow.labOrganizationId,
    actorInitials: args.actorInitials || "SYS",
    metadataJson: {
      restorationId: restoration.id,
      toothNumber: restoration.toothNumber,
      restorationType: restoration.restorationType,
      material: restoration.material,
      priceKey,
      unitPrice: unit.toFixed(2),
      feeSchedulePriceSet: true,
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
    priceKey,
    restorationId: restoration.id,
    beforePrices,
    afterPrices,
  };
}
