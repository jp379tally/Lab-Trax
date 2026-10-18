/**
 * Lightweight lab-catalog price-key lookup used by pricing resolution.
 *
 * A lab admin can set `priceKeyOverride` on a catalog entry (custom or
 * built-in subtype/material — see `lab-catalog.ts`). When a restoration's
 * `restorationSubtype` column references such an entry, the override must
 * be used in place of the static `materialToPriceKey` mapping so the lab's
 * custom pricing actually applies to invoices.
 *
 * Kept in its own module (rather than `lab-catalog.ts`) so `pricing.ts`
 * can import it without creating a circular dependency
 * (`lab-catalog.ts` already imports from `pricing.ts`).
 *
 * Resolution precedence for a `"<caseType>/<subtype>[/<material>]"` value:
 *   1. the material node's `priceKeyOverride` (exact 3-segment match)
 *   2. the parent subtype node's `priceKeyOverride` (2-segment match)
 *   3. null — caller falls back to today's static mapping unchanged.
 *
 * Only rows with a non-null `priceKeyOverride` participate; an entry with
 * no override never shadows the static default behavior.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { labCatalogEntries } from "@workspace/db";

/** Map of `"<caseType>/<key>"` (subtype) and `"<caseType>/<parentKey>/<key>"`
 * (material) → the entry's non-null `priceKeyOverride`. */
export type CatalogPriceKeyMap = Map<string, string>;

/**
 * Fetch every catalog entry with a price-key override for a lab, keyed by
 * the `restorationSubtype` path segments that reference it. One cheap query
 * per lab — use this in batch/loop contexts to avoid N+1 lookups.
 */
export async function fetchCatalogPriceKeyOverrides(
  labOrganizationId: string,
): Promise<CatalogPriceKeyMap> {
  const rows = await db.query.labCatalogEntries.findMany({
    where: and(
      eq(labCatalogEntries.labOrganizationId, labOrganizationId),
      isNotNull(labCatalogEntries.priceKeyOverride),
    ),
  });
  const map: CatalogPriceKeyMap = new Map();
  for (const row of rows) {
    const override = row.priceKeyOverride;
    if (!override) continue;
    if (row.entryType === "subtype") {
      map.set(`${row.caseType}/${row.key}`, override);
    } else if (row.entryType === "material") {
      map.set(`${row.caseType}/${row.parentKey}/${row.key}`, override);
    }
  }
  return map;
}

/**
 * Resolve the effective catalog price key for a stored `restorationSubtype`
 * value from an already-fetched override map. Material-level override wins
 * over the parent subtype's; returns null when neither has one (caller then
 * falls back to the static mapping, matching pre-catalog behavior).
 */
export function catalogPriceKeyFromMap(
  map: CatalogPriceKeyMap,
  restorationSubtype: string | null | undefined,
): string | null {
  if (!restorationSubtype || map.size === 0) return null;
  const direct = map.get(restorationSubtype);
  if (direct) return direct;
  const parts = restorationSubtype.split("/");
  if (parts.length === 3) {
    const parentOverride = map.get(`${parts[0]}/${parts[1]}`);
    if (parentOverride) return parentOverride;
  }
  return null;
}

/**
 * One-shot convenience: fetch + resolve for a single restoration. Fast-paths
 * to null (no query) when there is no `restorationSubtype` to look up.
 */
export async function resolveCatalogPriceKey(
  labOrganizationId: string,
  restorationSubtype: string | null | undefined,
): Promise<string | null> {
  if (!restorationSubtype) return null;
  const map = await fetchCatalogPriceKeyOverrides(labOrganizationId);
  return catalogPriceKeyFromMap(map, restorationSubtype);
}
