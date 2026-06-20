import { and, eq, isNull, isNotNull, sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  cases,
  caseAttachments,
  invoices,
  invoiceAttachments,
  bankTransactions,
  pricingTiers,
  pricingOverrides,
  organizations,
  organizationMemberships,
  users,
  subscriptions,
  vendorTypes,
  aiMemory,
} from "@workspace/db";
import { writeAuditLog } from "./audit";
import type { Request } from "express";

/**
 * Tables protected by the soft-delete guarantee. Hard `db.delete()` against
 * any of these is forbidden — use `softDelete()` / `restoreDeleted()` instead.
 *
 * Watch list: see replit.md "Lab data protection" and threat_model.md
 * "Information Disclosure / Tampering" sections. Adding a new protected
 * table requires:
 *   1. `deleted_at` + `deleted_by_user_id` columns on the table.
 *   2. Reading routes filtered with `notDeleted(table)`.
 *   3. Adding the table to PROTECTED_TABLES below so the lint/CI guard
 *      flags any future hard-delete regressions.
 */
export const PROTECTED_TABLES = {
  cases,
  case_attachments: caseAttachments,
  invoices,
  invoice_attachments: invoiceAttachments,
  bank_transactions: bankTransactions,
  pricing_tiers: pricingTiers,
  pricing_overrides: pricingOverrides,
  organizations,
  lab_memberships: organizationMemberships,
  users,
  subscriptions,
  vendor_types: vendorTypes,
  ai_memory: aiMemory,
} as const;

export type ProtectedTableName = keyof typeof PROTECTED_TABLES;

/**
 * Names of protected tables (DB names) used by the lint script.
 * Keep this list in sync with PROTECTED_TABLES above.
 */
export const PROTECTED_TABLE_NAMES: ReadonlyArray<string> = Object.keys(
  PROTECTED_TABLES
);

/**
 * Drizzle variable names exported from `@workspace/db` that the lint
 * script should flag if it sees `db.delete(<name>)` against them.
 */
export const PROTECTED_DRIZZLE_EXPORTS: ReadonlyArray<string> = [
  "cases",
  "caseAttachments",
  "invoices",
  "invoiceAttachments",
  "bankTransactions",
  "pricingTiers",
  "pricingOverrides",
  "organizations",
  "organizationMemberships",
  "users",
  "subscriptions",
  "vendorTypes",
  "aiMemory",
];

type SoftDeletableTable = (typeof PROTECTED_TABLES)[ProtectedTableName];

interface SoftDeleteArgs {
  /** A protected table (must be one of PROTECTED_TABLES values). */
  table: SoftDeletableTable;
  /** Drizzle WHERE clause selecting the row(s) to soft-delete. */
  where: SQL;
  /** UUID of the user performing the deletion (for audit trail). */
  actorUserId: string | null;
  /** Express request, used to enrich the audit log entry with IP/UA. */
  req?: Request;
  /** Audit metadata: organization the row belongs to (when known). */
  organizationId?: string | null;
  /** Audit metadata: human-readable entity type for the audit log. */
  entityType: string;
  /** Audit metadata: id of the deleted entity, when known. */
  entityId?: string | null;
  /** Audit metadata: optional "before" snapshot of the row. */
  beforeJson?: unknown;
  /**
   * Extra metadata to merge into the audit log entry alongside the
   * automatically computed `rowsAffected`. Callers use this to attach
   * entity-specific details (e.g. caseNumber, patientName for cases).
   */
  metadataJson?: Record<string, unknown>;
}

/**
 * Soft-delete one or more rows on a protected table by setting deleted_at
 * and deleted_by_user_id. Always writes an audit log entry. Rows already
 * soft-deleted are not touched again.
 *
 * Returns the array of rows that were actually marked deleted.
 */
export async function softDelete(args: SoftDeleteArgs): Promise<unknown[]> {
  const now = new Date();
  const result = await (db as any)
    .update(args.table)
    .set({ deletedAt: now, deletedByUserId: args.actorUserId ?? null })
    .where(and(args.where, isNull((args.table as any).deletedAt)))
    .returning();

  await writeAuditLog({
    req: args.req,
    userId: args.actorUserId,
    organizationId: args.organizationId ?? null,
    action: `${args.entityType}_soft_deleted`,
    entityType: args.entityType,
    entityId: args.entityId ?? null,
    beforeJson: args.beforeJson,
    metadataJson: { rowsAffected: result.length, ...(args.metadataJson ?? {}) },
  });

  return result;
}

interface RestoreArgs {
  table: SoftDeletableTable;
  where: SQL;
  actorUserId: string | null;
  req?: Request;
  organizationId?: string | null;
  entityType: string;
  entityId?: string | null;
}

/**
 * Restore previously soft-deleted rows by clearing deleted_at and
 * deleted_by_user_id. Writes an audit log entry.
 */
export async function restoreDeleted(args: RestoreArgs): Promise<unknown[]> {
  const result = await (db as any)
    .update(args.table)
    .set({ deletedAt: null, deletedByUserId: null })
    .where(and(args.where, isNotNull((args.table as any).deletedAt)))
    .returning();

  await writeAuditLog({
    req: args.req,
    userId: args.actorUserId,
    organizationId: args.organizationId ?? null,
    action: `${args.entityType}_restored`,
    entityType: args.entityType,
    entityId: args.entityId ?? null,
    metadataJson: { rowsAffected: result.length },
  });

  return result;
}

/**
 * Helper for use in WHERE clauses that should hide soft-deleted rows.
 *
 * Example:
 *   db.select().from(cases).where(and(eq(cases.id, id), notDeleted(cases)))
 */
export function notDeleted(table: { deletedAt: any }): SQL {
  return isNull(table.deletedAt);
}

/**
 * Convenience helper used by routes that previously hard-deleted rows by id.
 */
export async function softDeleteById(args: {
  table: SoftDeletableTable;
  id: string;
  actorUserId: string | null;
  req?: Request;
  organizationId?: string | null;
  entityType: string;
  beforeJson?: unknown;
  metadataJson?: Record<string, unknown>;
}): Promise<unknown[]> {
  return softDelete({
    table: args.table,
    where: eq((args.table as any).id, args.id),
    actorUserId: args.actorUserId,
    req: args.req,
    organizationId: args.organizationId,
    entityType: args.entityType,
    entityId: args.id,
    beforeJson: args.beforeJson,
    metadataJson: args.metadataJson,
  });
}

// re-export sql so consumers can build custom predicates without an extra import
export { sql };
