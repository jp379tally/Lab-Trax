/**
 * Per-lab vendor-type seeding & resolution helpers.
 *
 * Task #1188: vendors.vendor_type used to be a hardcoded
 * ["vendor","employee","item"] enum. It is now a foreign key into the
 * per-lab `vendor_types` table. Each lab gets three built-in rows on
 * first finance call (lazy seeding so existing labs don't need a
 * separate migration job), and admins can add/rename/remove additional
 * types.
 *
 * `ensureVendorTypesSeeded` is idempotent and cheap on the warm path
 * (one indexed SELECT). On the cold path it inserts up to three rows
 * and back-fills `vendors.vendor_type_id` from the legacy text column.
 */

import { db, vendors, vendorTypes } from "@workspace/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

export type BuiltinKind = "vendor" | "employee" | "item";

export interface VendorTypeRow {
  id: string;
  labOrganizationId: string;
  name: string;
  sortOrder: number;
  isBuiltin: boolean;
  builtinKind: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const BUILTINS: { kind: BuiltinKind; name: string; sortOrder: number }[] = [
  { kind: "vendor", name: "Vendor", sortOrder: 0 },
  { kind: "employee", name: "Employee", sortOrder: 1 },
  { kind: "item", name: "Item", sortOrder: 2 },
];

/**
 * Make sure the three built-in vendor-type rows exist for `labOrgId`
 * and that any existing `vendors` rows in this lab have their
 * `vendor_type_id` populated from the legacy `vendor_type` text column.
 *
 * Safe to call from every vendors / vendor-types request handler.
 * The two SELECTs are indexed and become no-ops once the lab has
 * been seeded once.
 */
export async function ensureVendorTypesSeeded(
  labOrgId: string,
): Promise<void> {
  const existing = await db
    .select({
      id: vendorTypes.id,
      builtinKind: vendorTypes.builtinKind,
    })
    .from(vendorTypes)
    .where(
      and(
        eq(vendorTypes.labOrganizationId, labOrgId),
        eq(vendorTypes.isBuiltin, true),
        isNull(vendorTypes.deletedAt),
      ),
    );

  const haveKinds = new Set(
    existing.map((r) => r.builtinKind).filter((k): k is string => !!k),
  );

  const toInsert = BUILTINS.filter((b) => !haveKinds.has(b.kind));
  if (toInsert.length > 0) {
    await db
      .insert(vendorTypes)
      .values(
        toInsert.map((b) => ({
          labOrganizationId: labOrgId,
          name: b.name,
          sortOrder: b.sortOrder,
          isBuiltin: true,
          builtinKind: b.kind,
        })),
      )
      .onConflictDoNothing();
  }

  // Backfill: link any vendors whose vendor_type_id is null to the
  // appropriate seeded built-in row based on their legacy text column.
  // The text column defaults to "vendor" so an unknown value still
  // lands on the Vendor row.
  const needsBackfill = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(
      and(
        eq(vendors.labOrganizationId, labOrgId),
        isNull(vendors.vendorTypeId),
      ),
    )
    .limit(1);

  if (needsBackfill.length === 0) return;

  // Map kinds -> ids (re-read so newly-inserted rows are included).
  const builtinRows = await db
    .select({
      id: vendorTypes.id,
      builtinKind: vendorTypes.builtinKind,
    })
    .from(vendorTypes)
    .where(
      and(
        eq(vendorTypes.labOrganizationId, labOrgId),
        eq(vendorTypes.isBuiltin, true),
        isNull(vendorTypes.deletedAt),
      ),
    );

  const kindToId = new Map<string, string>();
  for (const r of builtinRows) {
    if (r.builtinKind) kindToId.set(r.builtinKind, r.id);
  }
  const vendorTypeIdForVendor = kindToId.get("vendor");
  if (!vendorTypeIdForVendor) return;

  // One UPDATE per kind, all in a transaction.
  await db.transaction(async (tx) => {
    for (const kind of ["vendor", "employee", "item"] as const) {
      const typeId = kindToId.get(kind) ?? vendorTypeIdForVendor;
      await tx
        .update(vendors)
        .set({ vendorTypeId: typeId })
        .where(
          and(
            eq(vendors.labOrganizationId, labOrgId),
            eq(vendors.vendorType, kind),
            isNull(vendors.vendorTypeId),
          ),
        );
    }
    // Catch-all for unknown legacy values.
    await tx
      .update(vendors)
      .set({ vendorTypeId: vendorTypeIdForVendor })
      .where(
        and(
          eq(vendors.labOrganizationId, labOrgId),
          isNull(vendors.vendorTypeId),
        ),
      );
  });
}

/**
 * Load all non-deleted vendor types for a lab, ordered by sortOrder
 * (builtins first) then name. Caller should already have run
 * `ensureVendorTypesSeeded`.
 */
export async function listVendorTypes(
  labOrgId: string,
): Promise<VendorTypeRow[]> {
  const rows = await db
    .select()
    .from(vendorTypes)
    .where(
      and(
        eq(vendorTypes.labOrganizationId, labOrgId),
        isNull(vendorTypes.deletedAt),
      ),
    )
    .orderBy(asc(vendorTypes.sortOrder), asc(vendorTypes.name));
  return rows as VendorTypeRow[];
}

/**
 * Resolve a vendor-type identifier from a CreateVendor/UpdateVendor
 * request body. Accepts either:
 *   - vendorTypeId: explicit per-lab vendor_types.id (preferred)
 *   - vendorType:   legacy "vendor" | "employee" | "item" string,
 *                   resolved to the matching builtin row.
 * Returns null if neither field is provided (caller decides the
 * default — typically the "vendor" builtin).
 */
export async function resolveVendorTypeId(
  labOrgId: string,
  input: { vendorTypeId?: string | null; vendorType?: string | null },
): Promise<{ id: string; builtinKind: string | null } | null> {
  if (input.vendorTypeId) {
    const [row] = await db
      .select({ id: vendorTypes.id, builtinKind: vendorTypes.builtinKind })
      .from(vendorTypes)
      .where(
        and(
          eq(vendorTypes.id, input.vendorTypeId),
          eq(vendorTypes.labOrganizationId, labOrgId),
          isNull(vendorTypes.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }
  if (input.vendorType) {
    const [row] = await db
      .select({ id: vendorTypes.id, builtinKind: vendorTypes.builtinKind })
      .from(vendorTypes)
      .where(
        and(
          eq(vendorTypes.labOrganizationId, labOrgId),
          eq(vendorTypes.builtinKind, input.vendorType),
          isNull(vendorTypes.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }
  return null;
}

/** Look up the "vendor" builtin row id (default fallback). */
export async function getDefaultVendorTypeId(
  labOrgId: string,
): Promise<string> {
  const [row] = await db
    .select({ id: vendorTypes.id })
    .from(vendorTypes)
    .where(
      and(
        eq(vendorTypes.labOrganizationId, labOrgId),
        eq(vendorTypes.builtinKind, "vendor"),
        isNull(vendorTypes.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `vendor_types not seeded for lab ${labOrgId}; ` +
        `call ensureVendorTypesSeeded first`,
    );
  }
  return row.id;
}

/**
 * Lookup map kind -> vendor_types.id for the lab's builtin rows.
 * Used by import endpoints that still take a literal kind argument.
 */
export async function getBuiltinKindMap(
  labOrgId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: vendorTypes.id, builtinKind: vendorTypes.builtinKind })
    .from(vendorTypes)
    .where(
      and(
        eq(vendorTypes.labOrganizationId, labOrgId),
        eq(vendorTypes.isBuiltin, true),
        isNull(vendorTypes.deletedAt),
      ),
    );
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.builtinKind) out.set(r.builtinKind, r.id);
  }
  return out;
}

/** Strip the legacy text column from a select-all vendor row. Adds vendorTypeName for clients. */
export function enrichVendorRow<
  T extends { vendorTypeId: string | null; vendorType: string },
>(
  row: T,
  typesById: Map<string, VendorTypeRow>,
): T & { vendorTypeName: string; builtinKind: string | null } {
  const t = row.vendorTypeId ? typesById.get(row.vendorTypeId) : undefined;
  return {
    ...row,
    vendorTypeName: t?.name ?? "Vendor",
    builtinKind: t?.builtinKind ?? null,
  };
}

/** Helper: `unused` sentinel for sql tag if needed in callers. */
export const _kept = { sql };
