import { and, inArray, isNull } from "drizzle-orm";
import { db, labCases } from "@workspace/db";
import { writeAuditLog } from "./audit";
import type { Request } from "express";

/**
 * Soft-delete one or more legacy mobile cases (`lab_cases`) and write a
 * per-case audit entry, mirroring the soft-delete + audit guarantees that
 * `softDeleteById` gives canonical `cases`.
 *
 * `lab_cases` is NOT in PROTECTED_TABLES (it predates the protected-table
 * machinery and stores its payload in a JSON `case_data` blob, with a
 * `deleted_by` varchar instead of the `deleted_by_user_id` FK the shared
 * helper expects), so it cannot go through `softDeleteById` directly. This
 * dedicated helper is the "equivalent" path: it sets `deleted_at` +
 * `deleted_by`, never hard-deletes, and emits one audit log entry per case so
 * the legacy path matches the canonical path for auditing and recoverability.
 *
 * The UPDATE filters on `isNull(deletedAt)` and uses `.returning()` so the
 * caller gets an accurate count of the rows that were *actually* deleted
 * (already-deleted rows are skipped, so retries are idempotent and the
 * reported deletedCount never overstates what changed).
 */
export async function softDeleteLegacyCases(args: {
  ids: string[];
  /** Human-readable actor identifier stored in `lab_cases.deleted_by`. */
  deletedBy: string;
  /** Acting user's UUID for the audit trail (when known). */
  actorUserId?: string | null;
  /** Lab org the cases belong to, for audit scoping (falls back to row's org). */
  organizationId?: string | null;
  /** Express request, used to enrich the audit log with IP / user-agent. */
  req?: Request;
}): Promise<{ deletedIds: string[] }> {
  const ids = Array.from(new Set(args.ids));
  if (ids.length === 0) return { deletedIds: [] };

  const deletedRows = await db
    .update(labCases)
    .set({ deletedAt: new Date(), deletedBy: args.deletedBy })
    .where(and(inArray(labCases.id, ids), isNull(labCases.deletedAt)))
    .returning({
      id: labCases.id,
      organizationId: labCases.organizationId,
      caseData: labCases.caseData,
    });

  for (const row of deletedRows) {
    let caseNumber: string | null = null;
    let patientName: string | null = null;
    try {
      const data =
        typeof row.caseData === "string"
          ? JSON.parse(row.caseData)
          : (row.caseData ?? {});
      caseNumber = data?.caseNumber != null ? String(data.caseNumber) : null;
      patientName = data?.patientName != null ? String(data.patientName) : null;
    } catch {
      // A malformed blob must not block the soft-delete or its audit entry.
    }

    await writeAuditLog({
      req: args.req,
      userId: args.actorUserId ?? null,
      organizationId: args.organizationId ?? row.organizationId ?? null,
      // Same action as the canonical path (`<entityType>_soft_deleted`) so a
      // single audit query surfaces both kinds; `legacy:true` distinguishes them.
      action: "case_soft_deleted",
      entityType: "case",
      entityId: row.id,
      metadataJson: {
        legacy: true,
        deletedBy: args.deletedBy,
        caseNumber,
        patientName,
      },
    });
  }

  return { deletedIds: deletedRows.map((r) => r.id) };
}
