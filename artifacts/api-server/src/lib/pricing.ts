import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  labItemLabels,
  organizationConnections,
  pricingOverrides,
  pricingTiers,
} from "@workspace/db";
import {
  DEFAULT_TIER_ITEMS,
  DEFAULT_TIER_KEYS,
  materialToPriceKey,
} from "./material-mapping.js";

export {
  DEFAULT_TIER_ITEMS,
  DEFAULT_TIER_KEYS,
  materialToPriceKey,
} from "./material-mapping.js";

/**
 * Resolve the admin-configured display label for a price key in a given lab.
 * Falls back to the static default label from DEFAULT_TIER_ITEMS when no
 * custom row exists for that (labOrganizationId, priceKey) pair.
 */
export async function resolveItemLabel(
  labOrganizationId: string,
  priceKey: string,
): Promise<string> {
  const row = await db.query.labItemLabels.findFirst({
    where: and(
      eq(labItemLabels.labOrganizationId, labOrganizationId),
      eq(labItemLabels.priceKey, priceKey),
    ),
  });
  if (row?.label) return row.label;
  // Fall back to static default
  const defaultItem = DEFAULT_TIER_ITEMS.find((i) => i.key === priceKey);
  return defaultItem?.label ?? priceKey.replace(/_/g, " ").replace(/\b\w/g, (s) => s.toUpperCase());
}

/**
 * Fetch all configured labels for a lab as a map. Keys present in the map
 * are admin-set; keys absent should still resolve via static defaults.
 */
export async function fetchLabItemLabels(
  labOrganizationId: string,
): Promise<Record<string, string>> {
  const rows = await db.query.labItemLabels.findMany({
    where: eq(labItemLabels.labOrganizationId, labOrganizationId),
  });
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.priceKey] = row.label;
  }
  return out;
}

/**
 * Upsert a complete label map for a lab. Each entry in `labels` becomes a
 * row in `lab_item_labels` (insert or update). Entries not present in the
 * map are left untouched (partial updates are allowed).
 */
export async function saveLabItemLabels(
  labOrganizationId: string,
  labels: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(labels).filter(([, v]) => v.trim().length > 0);
  if (entries.length === 0) return;
  for (const [priceKey, label] of entries) {
    await db
      .insert(labItemLabels)
      .values({ labOrganizationId, priceKey, label: label.trim() })
      .onConflictDoUpdate({
        target: [labItemLabels.labOrganizationId, labItemLabels.priceKey],
        set: { label: label.trim(), updatedAt: new Date() },
      });
  }
}

/**
 * Format an invoice line-item description using the admin-configured label.
 *
 * - Numeric tooth (e.g. "30")  → `#30 Zirconia Crown`
 * - Non-numeric location token  → `Upper Denture` (arch-level)
 * - Empty / null                → `Zirconia Crown`
 */
export function buildLineItemDescription(
  toothNumber: string | null | undefined,
  label: string,
): string {
  const tooth = (toothNumber ?? "").trim();
  if (!tooth) return label;
  if (/^\d+$/.test(tooth)) return `#${tooth} ${label}`;
  return `${tooth} ${label}`;
}

/**
 * Strip a leading "Dr." (any casing, optional period/whitespace) and
 * lowercase. Mirrored in SQL by `normalizedDoctorSql` below so the
 * override lookup can filter in the database instead of pulling every
 * lab's overrides into Node.
 */
export function normalizeDoctor(name?: string | null) {
  return (name || "")
    .trim()
    .toLowerCase()
    .replace(/^dr\.?\s*/i, "");
}

/**
 * Pure-JS simulation of `normalizedDoctorSql` (regexp_replace +
 * lower(trim(...))) — used by unit tests to lock the SQL behavior to JS
 * without needing a live database.
 */
export function __simulateNormalizedDoctorSql(name?: string | null) {
  const trimmed = (name ?? "").trim().toLowerCase();
  return trimmed.replace(/^dr\.?\s*/, "");
}

// Mirrors JS `normalizeDoctor`: trim → lowercase → strip leading "dr"/"dr."
// (any casing) and following whitespace. We lowercase BEFORE the regex so a
// single lowercase pattern handles "Dr", "DR", "dr.", "  Dr  Smith", etc.
const normalizedDoctorSql = sql`regexp_replace(lower(trim(${pricingOverrides.doctorName})), '^dr\\.?\\s*', '')`;

async function findDoctorOverride(
  labOrganizationId: string,
  doctorName: string | null | undefined,
) {
  const normalized = normalizeDoctor(doctorName);
  if (!normalized) return null;
  // Filter in SQL so we don't materialize every override on the lab
  // every time a single restoration's price needs resolving.
  const rows = await db
    .select({
      id: pricingOverrides.id,
      doctorName: pricingOverrides.doctorName,
      tierName: pricingOverrides.tierName,
      pricesJson: pricingOverrides.pricesJson,
    })
    .from(pricingOverrides)
    .where(
      and(
        eq(pricingOverrides.labOrganizationId, labOrganizationId),
        sql`${normalizedDoctorSql} = ${normalized}`,
        sql`${pricingOverrides.deletedAt} is null`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface ResolvedPriceContext {
  labOrganizationId: string;
  doctorName?: string | null;
  providerOrganizationId?: string | null;
  tierName?: string | null;
}

export type PriceSource = "default" | "tier" | "override" | "manual";

export interface ResolvedPriceDetails {
  amount: number;
  source: Exclude<PriceSource, "manual">;
  sourceId: string | null;
  sourceName: string | null;
  key: string;
}

export async function resolveServerPrice(
  ctx: ResolvedPriceContext,
  material?: string | null,
  restorationType?: string | null,
): Promise<number | null> {
  const details = await resolveServerPriceWithSource(
    ctx,
    material,
    restorationType,
  );
  return details ? details.amount : null;
}

export async function resolveServerPriceWithSource(
  ctx: ResolvedPriceContext,
  material?: string | null,
  restorationType?: string | null,
): Promise<ResolvedPriceDetails | null> {
  const key = materialToPriceKey(material, restorationType);
  if (!key) return null;

  let doctorTierName: string | null = null;

  // Per-doctor override beats tier
  const match = await findDoctorOverride(
    ctx.labOrganizationId,
    ctx.doctorName,
  );
  if (match) {
    const prices = (match.pricesJson ?? {}) as Record<string, unknown>;
    const value = Number(prices[key]);
    if (Number.isFinite(value) && value > 0) {
      return {
        amount: value,
        source: "override",
        sourceId: match.id,
        sourceName: match.doctorName,
        key,
      };
    }
    if (match.tierName) doctorTierName = match.tierName;
  }

  // Practice-level tier from the lab/provider connection.
  let connectionTierName: string | null = null;
  if (ctx.providerOrganizationId) {
    const connection = await db.query.organizationConnections.findFirst({
      where: and(
        eq(
          organizationConnections.labOrganizationId,
          ctx.labOrganizationId,
        ),
        eq(
          organizationConnections.providerOrganizationId,
          ctx.providerOrganizationId,
        ),
      ),
    });
    if (connection?.tierName) connectionTierName = connection.tierName;
  }

  // Tier lookup priority:
  //   1. doctor's assigned tier (from override.tierName)
  //   2. practice's assigned tier (from organization_connections.tierName)
  //   3. caller-provided ctx.tierName (legacy)
  //   4. first tier on the lab (legacy fallback so unconfigured labs still
  //      resolve a price exactly as before this feature)
  const tiers = await db.query.pricingTiers.findMany({
    where: eq(pricingTiers.labOrganizationId, ctx.labOrganizationId),
  });
  const sortedTiers = [...tiers].sort((a, b) => {
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return at - bt;
  });

  const candidateNames = [
    doctorTierName,
    connectionTierName,
    ctx.tierName ?? null,
  ].filter((n): n is string => !!n);

  const findByName = (name: string) =>
    sortedTiers.find(
      (t) => t.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );

  const tryTier = (
    tier: typeof sortedTiers[number] | undefined,
    source: Exclude<PriceSource, "manual">,
  ): ResolvedPriceDetails | null => {
    if (!tier) return null;
    const prices = (tier.pricesJson ?? {}) as Record<string, unknown>;
    const value = Number(prices[key]);
    if (!Number.isFinite(value) || value <= 0) return null;
    return {
      amount: value,
      source,
      sourceId: tier.id,
      sourceName: tier.name,
      key,
    };
  };

  for (const name of candidateNames) {
    const v = tryTier(findByName(name), "tier");
    if (v !== null) return v;
  }

  // Legacy fallback: first tier on the lab.
  return tryTier(sortedTiers[0], "default");
}

/**
 * Resolve the per-doctor effective unit price for every standard item
 * key in one pass. Returns one row per `DEFAULT_TIER_ITEMS` entry, with
 * `unitPrice = 0` and `source = null` when no priced row applies.
 *
 * Used by the invoice editor's "Item" dropdown so it can show every
 * available item and auto-fill the unit price the moment a user picks
 * one — without N+1 calls to {@link resolveServerPriceWithSource}.
 */
export interface ResolvedItemRow {
  key: string;
  label: string;
  unitPrice: number;
  source: PriceSource | null;
  sourceId: string | null;
  sourceName: string | null;
}

export async function resolveAllPricesForContext(
  ctx: ResolvedPriceContext,
): Promise<ResolvedItemRow[]> {
  // 1. Per-doctor override (single SQL-filtered match).
  const overrideRow = await findDoctorOverride(
    ctx.labOrganizationId,
    ctx.doctorName,
  );
  const doctorTierName = overrideRow?.tierName ?? null;

  // 2. Practice-level tier from the lab/provider connection.
  let connectionTierName: string | null = null;
  if (ctx.providerOrganizationId) {
    const connection = await db.query.organizationConnections.findFirst({
      where: and(
        eq(
          organizationConnections.labOrganizationId,
          ctx.labOrganizationId,
        ),
        eq(
          organizationConnections.providerOrganizationId,
          ctx.providerOrganizationId,
        ),
      ),
    });
    if (connection?.tierName) connectionTierName = connection.tierName;
  }

  // 3. All tiers on the lab, sorted oldest-first to match the legacy
  //    "first tier wins" fallback in resolveServerPriceWithSource.
  const tiers = await db.query.pricingTiers.findMany({
    where: eq(pricingTiers.labOrganizationId, ctx.labOrganizationId),
  });
  const sortedTiers = [...tiers].sort((a, b) => {
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return at - bt;
  });
  const findTierByName = (name: string) =>
    sortedTiers.find(
      (t) => t.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
  const candidateTiers: Array<{
    tier: (typeof sortedTiers)[number];
    source: Exclude<PriceSource, "manual">;
  }> = [];
  for (const name of [
    doctorTierName,
    connectionTierName,
    ctx.tierName ?? null,
  ].filter((n): n is string => !!n)) {
    const t = findTierByName(name);
    if (t) candidateTiers.push({ tier: t, source: "tier" });
  }
  if (sortedTiers[0]) {
    candidateTiers.push({ tier: sortedTiers[0], source: "default" });
  }

  // 4. Resolve each known item key against the same priority chain
  //    used by resolveServerPriceWithSource.
  return DEFAULT_TIER_ITEMS.map((item) => {
    const key = item.key;
    if (overrideRow) {
      const prices = (overrideRow.pricesJson ?? {}) as Record<
        string,
        unknown
      >;
      const value = Number(prices[key]);
      if (Number.isFinite(value) && value > 0) {
        return {
          key,
          label: item.label,
          unitPrice: value,
          source: "override" as const,
          sourceId: overrideRow.id,
          sourceName: overrideRow.doctorName,
        };
      }
    }
    for (const { tier, source } of candidateTiers) {
      const prices = (tier.pricesJson ?? {}) as Record<string, unknown>;
      const value = Number(prices[key]);
      if (Number.isFinite(value) && value > 0) {
        return {
          key,
          label: item.label,
          unitPrice: value,
          source,
          sourceId: tier.id,
          sourceName: tier.name,
        };
      }
    }
    return {
      key,
      label: item.label,
      unitPrice: 0,
      source: null,
      sourceId: null,
      sourceName: null,
    };
  });
}
