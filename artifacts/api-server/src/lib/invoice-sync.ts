import { and, eq, sum } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  caseRestorations,
  cases,
  invoiceLineItems,
  invoices,
  payments,
} from "@workspace/db";
import { sumMoney } from "./case";
import { materialToPriceKey, resolveItemLabelFromMap } from "./pricing";
import {
  buildBridgeAwareLineItems,
  parseToothInt,
} from "./invoice-line-grouping";

/**
 * Re-sync the invoice attached to a case from its current restoration rows.
 *
 * Use this whenever the restoration set on a case changes (add / delete /
 * price edit) so the user doesn't have to also open the Invoice tab and
 * regenerate by hand. Mirrors the auto-invoice logic that runs on case
 * creation, but for the post-creation lifecycle.
 *
 * Safety rules:
 *   - Only touches invoices in "draft" or "open" status. Paid / void /
 *     cancelled invoices are left alone — they're closed books.
 *   - Skips invoices that already have a recorded payment, even if their
 *     status is still "open" (partial-pay safety).
 *   - Preserves the invoice's no-charge-remake intent: if every existing
 *     line item on the invoice is at $0 and the invoice carries a
 *     "no-charge remake" note, the rebuilt line items are also forced
 *     to $0 so we don't silently start charging for a no-charge remake.
 *   - If the case has no invoice yet, this function is a no-op (cases
 *     auto-create their invoice on POST /cases). Callers that need to
 *     guarantee an invoice exists should use the existing
 *     `/invoices/cases/:caseId/generate-invoice` endpoint.
 *   - When the case has `bridgeConnectors`, adjacent pontic+crown spans
 *     are collapsed into a single bridge line item with a combined
 *     description (e.g. "#13-15 Zirconia Bridge – 3 units").
 *
 * Returns the rebuilt invoice id (or null if nothing was synced).
 */
export async function syncInvoiceFromRestorations(args: {
  caseId: string;
  actorUserId: string | null;
}): Promise<string | null> {
  const { caseId, actorUserId } = args;

  const caseRow = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
  });
  if (!caseRow) return null;

  const invoice = await db.query.invoices.findFirst({
    where: eq(invoices.caseId, caseId),
  });
  if (!invoice) return null;

  // Closed-book statuses are off-limits.
  if (invoice.status !== "draft" && invoice.status !== "open") return null;

  // Bail if any payment has already been applied to the invoice — at that
  // point the line items are part of the financial record and shouldn't
  // be silently rewritten.
  const [paidAgg] = await db
    .select({ value: sum(payments.amount) })
    .from(payments)
    .where(eq(payments.invoiceId, invoice.id));
  const paidSoFar = Number(paidAgg?.value ?? 0);
  if (paidSoFar > 0) return null;

  // Detect "no-charge remake" intent on the existing invoice so we don't
  // silently start charging for one. Two signals must both be true:
  //   1. The case is flagged as a remake with remakeCharged = false.
  //   2. The current invoice notes mention "no-charge".
  const noChargeRemake =
    !!caseRow.remakeOfCaseId &&
    caseRow.remakeCharged === false &&
    !!invoice.notes &&
    /no-?charge/i.test(invoice.notes);

  // Replace the invoice's line items + header in one transaction so
  // we never leave the invoice with new line items but a stale total
  // (or vice versa). Read restorations inside the transaction so we
  // see a consistent snapshot under concurrent restoration writes.
  await db.transaction(async (tx) => {
    const allRestorations = await tx.query.caseRestorations.findMany({
      where: eq(caseRestorations.caseId, caseId),
    });
    // Missing-tooth markers are visual-only; exclude them from invoice line items.
    const restorations = allRestorations.filter(
      (r) => r.restorationType !== "missing",
    );

    await tx
      .delete(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));

    // Build bridge-aware line items. When the case has `bridgeConnectors`,
    // connected spans of adjacent teeth that include a pontic are merged
    // into a single bridge line item with a combined description.
    const itemsToInsert = buildBridgeAwareLineItems(
      restorations,
      (caseRow as any).bridgeConnectors ?? null,
      noChargeRemake,
    );

    if (itemsToInsert.length > 0) {
      await tx.insert(invoiceLineItems).values(
        itemsToInsert.map((item, idx) => ({
          invoiceId: invoice.id,
          caseRestorationId: item.caseRestorationId,
          toothNumber: item.toothNumber,
          toothLabel: item.toothLabel ?? null,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          sortOrder: idx,
        })),
      );
    }

    const subtotal = sumMoney(itemsToInsert.map((i) => i.lineTotal));

    // Refresh the invoice's display metadata (teeth, shade, line-item
    // labels) so the Invoice tab UI shows current restoration data
    // without the user having to manually re-enter anything.
    const teethList = Array.from(
      new Set(
        restorations.map((r) => (r.toothNumber || "").trim()).filter(Boolean),
      ),
    ).join(", ");
    const shadeList = Array.from(
      new Set(
        restorations.map((r) => (r.shade || "").trim()).filter(Boolean),
      ),
    ).join(", ");
    const existingMeta =
      (invoice.displayMetadataJson as Record<string, unknown> | null) ?? {};
    const nextMeta: Record<string, unknown> = {
      ...existingMeta,
      teeth: teethList,
      shade: shadeList,
      lineItems: itemsToInsert.map((i) => ({
        item: i.description,
        description: i.description,
      })),
    };

    await tx
      .update(invoices)
      .set({
        subtotal,
        total: subtotal,
        // Recompute balance from scratch — paidSoFar is 0 here per the
        // guard above, so balance equals the new total.
        balanceDue: subtotal,
        displayMetadataJson: nextMeta,
        updatedByUserId: actorUserId,
        // A draft invoice that now has line items should automatically
        // become "open" so it shows up on the receivables worklist.
        ...(invoice.status === "draft" && restorations.length > 0
          ? { status: "open" as const, issuedAt: new Date() }
          : {}),
      })
      .where(and(eq(invoices.id, invoice.id)));
  });

  return invoice.id;
}

// ── Grouped line items for AI-import invoice builders ─────────────────────

export interface GroupedLineItemInsert {
  invoiceId: string;
  caseRestorationId: string | null;
  toothNumber: number | null;
  toothLabel: string | null;
  description: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  sortOrder: number;
  /**
   * The price key (e.g. "pfm_crown") that was resolved for this line item.
   * Null when the material/type is not in the standard price key catalog.
   * Stored in displayMetadataJson.lineItems — NOT a DB column.
   */
  catalogItemKey?: string | null;
  /**
   * The human-readable tier label for the catalog item (e.g. "PFM High Noble").
   * Stored in displayMetadataJson.lineItems so the Item picker pre-selects it.
   * NOT a DB column.
   */
  catalogItemLabel?: string | null;
  /**
   * True when the price key was recognized but no pricing-tier entry (or doctor
   * tier) has a price > 0 for it. Frontend renders an amber warning prompting
   * the user to add the item to the tier. NOT a DB column.
   */
  missingCatalogItem?: boolean;
}

/**
 * Strip the catalog-metadata-only fields from a GroupedLineItemInsert array
 * before passing to Drizzle's `.values()`. Those fields are not DB columns and
 * must not appear in the INSERT payload.
 */
export function toInvoiceLineItemValues(
  items: GroupedLineItemInsert[],
): Array<Omit<GroupedLineItemInsert, "catalogItemKey" | "catalogItemLabel" | "missingCatalogItem">> {
  return items.map(
    ({ catalogItemKey: _ck, catalogItemLabel: _cl, missingCatalogItem: _mc, ...rest }) => rest,
  );
}

type AiRestoration = {
  teeth: string;
  material: string | null;
  type: string;
  isBridge: boolean;
};

type RestorationRow = {
  id: string;
  toothNumber: string | null;
  restorationType: string;
  material: string | null;
  quantity: number;
  unitPrice: string;
};

/**
 * Count teeth represented by an AI restoration `teeth` string.
 *  - Comma list "3, 4, 5" → 3
 *  - Dash range "8-10"    → 3 (10 - 8 + 1)
 *  - Single "3"           → 1
 */
function countAiTeeth(teeth: string): number {
  const t = teeth.trim();
  if (t.includes(",")) {
    return t.split(",").filter((s) => s.trim()).length;
  }
  const dashMatch = t.match(/^(\d+)-(\d+)$/);
  if (dashMatch) {
    const lo = parseInt(dashMatch[1]!, 10);
    const hi = parseInt(dashMatch[2]!, 10);
    return Math.abs(hi - lo) + 1;
  }
  return 1;
}

/**
 * Loose match between a DB restoration row and an AI restorations element.
 * Checks material (case-insensitive, null-tolerant) and that the
 * restorationType / AI type share a meaningful substring.
 */
function rowMatchesAiRestoration(r: RestorationRow, ai: AiRestoration): boolean {
  const rMat = (r.material ?? "").toLowerCase().trim();
  const aiMat = (ai.material ?? "").toLowerCase().trim();
  const matMatch = rMat === aiMat;
  const rType = r.restorationType.toLowerCase().trim();
  const aiType = ai.type.toLowerCase().trim();
  const typeMatch =
    rType.includes(aiType) ||
    aiType.includes(rType) ||
    rType.split(/\s+/).some((word) => aiType.includes(word)) ||
    aiType.split(/\s+/).some((word) => rType.includes(word));
  return matMatch && typeMatch;
}

/**
 * Build ready-to-insert invoice line items from DB restoration rows, grouping
 * same-material/same-type restorations into a single row with a combined
 * `toothLabel`. Called by the three AI-import invoice-creation blocks in
 * `cases.ts`.
 *
 * When `aiRestorations` is provided and non-empty it is used as the primary
 * grouping source (preserving bridge dash notation such as "8-10"). Each AI
 * element is matched against the DB rows to obtain the unit price.
 *
 * When `aiRestorations` is absent/empty the function falls back to grouping
 * `restorations` by `(restorationType, material)`.
 *
 * Single-tooth groups preserve the existing `toothNumber` integer column so
 * they are unaffected by this change.
 */
export function buildGroupedLineItemsForInvoice(
  restorations: RestorationRow[],
  labelCache: Record<string, string>,
  invoiceId: string,
  aiRestorations?: AiRestoration[] | null,
): GroupedLineItemInsert[] {
  // Missing-tooth markers are visual-only; exclude them from invoice line items.
  const billableRestorations = restorations.filter(
    (r) => r.restorationType !== "missing",
  );
  if (billableRestorations.length === 0) return [];
  restorations = billableRestorations;

  if (aiRestorations && aiRestorations.length > 0) {
    // AI-guided grouping: each AI element becomes one line item.
    // We limit consumption to countAiTeeth(ai.teeth) rows per element so that
    // two AI groups with the same material/type (e.g. two separate bridge spans)
    // each claim their own distinct DB rows rather than the first element
    // greedily consuming all matching rows.
    const used = new Set<string>();
    const items: GroupedLineItemInsert[] = [];

    for (let i = 0; i < aiRestorations.length; i++) {
      const ai = aiRestorations[i]!;
      const qty = countAiTeeth(ai.teeth);
      // Take only as many matching rows as this AI element's tooth count.
      const allMatched = restorations.filter(
        (r) => !used.has(r.id) && rowMatchesAiRestoration(r, ai),
      );
      const toUse = allMatched.slice(0, qty);

      if (toUse.length === 0) continue;

      const catalogItemKey = materialToPriceKey(toUse[0]!.material, toUse[0]!.restorationType);
      const pk = catalogItemKey ?? toUse[0]!.restorationType;
      const label = resolveItemLabelFromMap(labelCache, pk);
      const unitPrice = toUse[0]!.unitPrice;
      const lineTotal = (qty * Number(unitPrice)).toFixed(2);
      const isSingle = qty === 1;
      const missingCatalogItem = !!catalogItemKey && Number(unitPrice) <= 0;

      items.push({
        invoiceId,
        caseRestorationId: toUse[0]!.id,
        toothNumber: isSingle ? parseToothInt(ai.teeth.trim()) : null,
        toothLabel: isSingle ? null : ai.teeth.trim(),
        description: isSingle
          ? buildLabelWithTooth(ai.teeth.trim(), label)
          : label,
        quantity: qty,
        unitPrice,
        lineTotal,
        sortOrder: i,
        catalogItemKey,
        catalogItemLabel: label,
        missingCatalogItem,
      });

      for (const r of toUse) used.add(r.id);
    }

    // Any DB rows not consumed by the AI array fall back to per-row items.
    const unconsumed = restorations.filter((r) => !used.has(r.id));
    const fallback = buildGroupedFromRows(unconsumed, labelCache, items.length)
      .map((it) => ({ ...it, invoiceId }));
    return [...items, ...fallback];
  }

  // Fallback: group DB rows by (restorationType, material).
  return buildGroupedFromRows(restorations, labelCache, 0)
    .map((it) => ({ ...it, invoiceId }));
}

/**
 * Group an array of restoration rows by (restorationType, material) and
 * produce one line item per group, with a comma-joined `toothLabel` for
 * multi-tooth groups. `invoiceId` is set to an empty string placeholder;
 * callers set the real value on each item after calling.
 */
function buildGroupedFromRows(
  restorations: RestorationRow[],
  labelCache: Record<string, string>,
  sortOffset: number,
): GroupedLineItemInsert[] {
  if (restorations.length === 0) return [];

  type Group = { rows: RestorationRow[] };
  const groupMap = new Map<string, Group>();
  const order: string[] = [];

  for (const r of restorations) {
    const key = `${(r.material ?? "").toLowerCase()}::${r.restorationType.toLowerCase()}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, { rows: [] });
      order.push(key);
    }
    groupMap.get(key)!.rows.push(r);
  }

  const items: GroupedLineItemInsert[] = [];
  let idx = sortOffset;

  for (const key of order) {
    const { rows } = groupMap.get(key)!;
    const first = rows[0]!;
    const catalogItemKey = materialToPriceKey(first.material, first.restorationType);
    const pk = catalogItemKey ?? first.restorationType;
    const label = resolveItemLabelFromMap(labelCache, pk);
    const unitPrice = first.unitPrice;
    const missingCatalogItem = !!catalogItemKey && Number(unitPrice) <= 0;

    if (rows.length === 1) {
      const qty = Number(first.quantity ?? 1);
      items.push({
        invoiceId: "",
        caseRestorationId: first.id,
        toothNumber: parseToothInt(first.toothNumber ?? ""),
        toothLabel: null,
        description: buildLabelWithTooth(first.toothNumber ?? "", label),
        quantity: qty,
        unitPrice,
        lineTotal: (qty * Number(unitPrice)).toFixed(2),
        sortOrder: idx++,
        catalogItemKey,
        catalogItemLabel: label,
        missingCatalogItem,
      });
    } else {
      const qty = rows.reduce((s, r) => s + Number(r.quantity ?? 1), 0);
      const teeth = rows
        .map((r) => parseInt(r.toothNumber ?? "", 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 32)
        .sort((a, b) => a - b);
      const toothLabel = teeth.length > 0 ? teeth.join(", ") : null;
      items.push({
        invoiceId: "",
        caseRestorationId: first.id,
        toothNumber: null,
        toothLabel,
        description: label,
        quantity: qty,
        unitPrice,
        lineTotal: (qty * Number(unitPrice)).toFixed(2),
        sortOrder: idx++,
        catalogItemKey,
        catalogItemLabel: label,
        missingCatalogItem,
      });
    }
  }

  return items;
}

function buildLabelWithTooth(toothStr: string, label: string): string {
  const t = (toothStr ?? "").trim();
  if (!t) return label;
  if (/^\d+$/.test(t)) return `#${t} ${label}`;
  return `${t} ${label}`;
}
