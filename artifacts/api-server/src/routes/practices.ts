/**
 * Practice merge endpoints (Task #710 / #717).
 *
 * Mirrors the doctor-merge flow in `doctors.ts` but works at the
 * provider-organization (practice) level. When an admin merges one or
 * more source practices into a target practice, these rows are moved
 * inside the same lab:
 *
 *   - `cases.providerOrganizationId` → target practice
 *   - `invoices.providerOrganizationId` → target practice
 *   - `pricing_overrides` for that lab: practice + practiceName remap to
 *     the target. If the target lab already has an active override for
 *     the same `doctorName` (the partial unique index on
 *     `(labOrganizationId, doctorName) WHERE deleted_at IS NULL`), the
 *     source override is collapsed (soft-deleted) so the index isn't
 *     violated.
 *   - `lab_memberships` rows where `labId = sourcePractice` are moved
 *     to `labId = targetPractice`. The unique partial index on
 *     `(labId, userId) WHERE deleted_at IS NULL` is respected by
 *     collapsing source rows whose user is already a member of the
 *     target.
 *
 * After the moves, each source practice is soft-deleted via
 * `softDelete()` (organizations is in PROTECTED_TABLES — hard
 * `db.delete()` is forbidden and the CI guard flags any regression).
 *
 * Audit + undo: each source gets its own `practice_merged` audit row
 * with enough before/after state for the undo endpoint to reverse it
 * within the configured undo window (default 10 minutes, overridable
 * via the PRACTICE_MERGE_UNDO_WINDOW_MINUTES env var, capped at 24h).
 *
 * Other practice-keyed tables (invoiceCredits, practiceStatements,
 * rxPracticeNameAliases, organizationConnections) are intentionally
 * left alone — they're rare admin-only data and not part of the
 * tested merge surface (Task #711). They can be added in a future
 * task without changing the audit-entry shape.
 */
import { Router } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  auditLogs,
  cases,
  invoices,
  organizations,
  organizationMemberships,
  pricingOverrides,
} from "@workspace/db";
import { HttpError, ok, wrapDbError } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole } from "../lib/rbac";
import { notDeleted } from "../lib/soft-delete";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

function readUndoWindowMs(): number {
  const raw = process.env["PRACTICE_MERGE_UNDO_WINDOW_MINUTES"];
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) return 10 * 60 * 1000;
  return Math.floor(n * 60 * 1000);
}

const mergeSchema = z.object({
  labOrganizationId: z.string().min(1),
  targetOrganizationId: z.string().min(1),
  sourceOrganizationIds: z.array(z.string().min(1)).min(1).max(50),
});

type ParsedMerge = z.infer<typeof mergeSchema>;

async function loadAndAuthorize(userId: string, input: ParsedMerge) {
  const labId = input.labOrganizationId;
  await requireAnyRole(userId, labId, ADMIN_ROLES);

  // Dedupe & reject self-merge.
  const sourceIds = Array.from(new Set(input.sourceOrganizationIds)).filter(
    (id) => id !== input.targetOrganizationId,
  );
  if (sourceIds.length === 0) {
    throw new HttpError(
      400,
      "Source and target are the same — nothing to merge.",
    );
  }

  const allIds = Array.from(new Set([input.targetOrganizationId, ...sourceIds]));
  const rows = await db
    .select()
    .from(organizations)
    .where(inArray(organizations.id, allIds));
  const byId = new Map(rows.map((r) => [r.id, r] as const));

  const target = byId.get(input.targetOrganizationId);
  if (!target) throw new HttpError(404, "Target practice not found.");
  if (target.deletedAt) {
    throw new HttpError(400, "Target practice is archived.");
  }
  if (target.parentLabOrganizationId !== labId) {
    throw new HttpError(400, "Target practice does not belong to this lab.");
  }

  const sources: typeof rows = [];
  for (const id of sourceIds) {
    const r = byId.get(id);
    if (!r) throw new HttpError(404, `Source practice not found: ${id}`);
    if (r.parentLabOrganizationId !== labId) {
      throw new HttpError(400, "Source practice does not belong to this lab.");
    }
    if (r.deletedAt) {
      throw new HttpError(400, `Source practice is already archived: ${id}`);
    }
    sources.push(r);
  }

  return { labId, target, sources };
}

router.post(
  "/merge/preview",
  asyncHandler(async (req, res) => {
    const input = mergeSchema.parse(req.body);
    const userId = (req as any).auth.userId as string;
    const { labId, target, sources } = await loadAndAuthorize(userId, input);

    const sourceIds = sources.map((s) => s.id);

    const [caseCountRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(cases)
      .where(
        and(
          eq(cases.labOrganizationId, labId),
          inArray(cases.providerOrganizationId, sourceIds),
          notDeleted(cases),
        ),
      );
    const [invoiceCountRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(
        and(
          eq(invoices.labOrganizationId, labId),
          inArray(invoices.providerOrganizationId, sourceIds),
          notDeleted(invoices),
        ),
      );
    const [overrideCountRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pricingOverrides)
      .where(
        and(
          eq(pricingOverrides.labOrganizationId, labId),
          inArray(pricingOverrides.providerOrganizationId, sourceIds),
          notDeleted(pricingOverrides),
        ),
      );
    const [memberCountRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(organizationMemberships)
      .where(
        and(
          inArray(organizationMemberships.labId, sourceIds),
          notDeleted(organizationMemberships),
        ),
      );

    const totalCases = Number(caseCountRow?.n ?? 0);
    const totalInvoices = Number(invoiceCountRow?.n ?? 0);
    const totalOverrides = Number(overrideCountRow?.n ?? 0);
    const totalMembers = Number(memberCountRow?.n ?? 0);

    const sourcesPreview: Array<{
      id: string;
      name: string;
      cases: number;
      invoices: number;
      overrides: number;
      members: number;
    }> = [];
    for (const s of sources) {
      const [cR] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(cases)
        .where(
          and(
            eq(cases.labOrganizationId, labId),
            eq(cases.providerOrganizationId, s.id),
            notDeleted(cases),
          ),
        );
      const [iR] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(invoices)
        .where(
          and(
            eq(invoices.labOrganizationId, labId),
            eq(invoices.providerOrganizationId, s.id),
            notDeleted(invoices),
          ),
        );
      const [oR] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pricingOverrides)
        .where(
          and(
            eq(pricingOverrides.labOrganizationId, labId),
            eq(pricingOverrides.providerOrganizationId, s.id),
            notDeleted(pricingOverrides),
          ),
        );
      const [mR] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.labId, s.id),
            notDeleted(organizationMemberships),
          ),
        );
      sourcesPreview.push({
        id: s.id,
        name: s.displayName || s.name,
        cases: Number(cR?.n ?? 0),
        invoices: Number(iR?.n ?? 0),
        overrides: Number(oR?.n ?? 0),
        members: Number(mR?.n ?? 0),
      });
    }

    return ok(res, {
      totalCases,
      totalInvoices,
      totalOverrides,
      totalMembers,
      sources: sourcesPreview,
      target: {
        id: target.id,
        name: target.displayName || target.name,
      },
    });
  }),
);

router.post(
  "/merge",
  asyncHandler(async (req, res) => {
    const input = mergeSchema.parse(req.body);
    const userId = (req as any).auth.userId as string;
    const { labId, target, sources } = await loadAndAuthorize(userId, input);
    const targetId = target.id;
    const targetName = target.displayName || target.name;

    const result = await db.transaction(async (tx) => {
      let totalCasesMoved = 0;
      let totalInvoicesMoved = 0;
      let totalOverridesMoved = 0;
      let totalOverridesCollapsed = 0;
      let totalMembershipsMoved = 0;
      let totalMembershipsCollapsed = 0;
      const entries: Array<{
        auditLogId: string;
        sourceOrganizationId: string;
        casesMoved: number;
        invoicesMoved: number;
        overridesMoved: number;
        overridesCollapsed: number;
        membershipsMoved: number;
        membershipsCollapsed: number;
      }> = [];

      for (const src of sources) {
        // 1. Cases.
        const matchedCases = await tx
          .select({ id: cases.id })
          .from(cases)
          .where(
            and(
              eq(cases.labOrganizationId, labId),
              eq(cases.providerOrganizationId, src.id),
            ),
          );
        const movedCaseIds = matchedCases.map((c) => c.id);
        if (movedCaseIds.length > 0) {
          await tx
            .update(cases)
            .set({ providerOrganizationId: targetId })
            .where(inArray(cases.id, movedCaseIds));
        }

        // 2. Invoices.
        const matchedInvoices = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.labOrganizationId, labId),
              eq(invoices.providerOrganizationId, src.id),
            ),
          );
        const movedInvoiceIds = matchedInvoices.map((i) => i.id);
        if (movedInvoiceIds.length > 0) {
          await tx
            .update(invoices)
            .set({ providerOrganizationId: targetId })
            .where(inArray(invoices.id, movedInvoiceIds));
        }

        // 3. Pricing overrides. Collapse rows whose doctorName already
        // exists on an active target-side override (the partial unique
        // on (labOrganizationId, doctorName)).
        const sourceOverrides = await tx
          .select()
          .from(pricingOverrides)
          .where(
            and(
              eq(pricingOverrides.labOrganizationId, labId),
              eq(pricingOverrides.providerOrganizationId, src.id),
              isNull(pricingOverrides.deletedAt),
            ),
          );

        const movedOverrideIds: string[] = [];
        const collapsedOverrideIds: string[] = [];

        for (const ov of sourceOverrides) {
          const [conflict] = await tx
            .select({ id: pricingOverrides.id })
            .from(pricingOverrides)
            .where(
              and(
                eq(pricingOverrides.labOrganizationId, labId),
                sql`lower(${pricingOverrides.doctorName}) = lower(${ov.doctorName})`,
                eq(pricingOverrides.providerOrganizationId, targetId),
                isNull(pricingOverrides.deletedAt),
              ),
            )
            .limit(1);

          if (conflict && conflict.id !== ov.id) {
            await tx
              .update(pricingOverrides)
              .set({ deletedAt: new Date(), deletedByUserId: userId })
              .where(eq(pricingOverrides.id, ov.id));
            collapsedOverrideIds.push(ov.id);
          } else {
            await tx
              .update(pricingOverrides)
              .set({
                providerOrganizationId: targetId,
                practiceName: targetName,
              })
              .where(eq(pricingOverrides.id, ov.id));
            movedOverrideIds.push(ov.id);
          }
        }

        // 4. Memberships. Collapse rows whose user already has an
        // active membership on the target practice.
        const sourceMembers = await tx
          .select()
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.labId, src.id),
              isNull(organizationMemberships.deletedAt),
            ),
          );

        const movedMembershipIds: string[] = [];
        const collapsedMembershipIds: string[] = [];

        for (const m of sourceMembers) {
          const [conflict] = await tx
            .select({ id: organizationMemberships.id })
            .from(organizationMemberships)
            .where(
              and(
                eq(organizationMemberships.labId, targetId),
                eq(organizationMemberships.userId, m.userId),
                isNull(organizationMemberships.deletedAt),
              ),
            )
            .limit(1);

          if (conflict && conflict.id !== m.id) {
            await tx
              .update(organizationMemberships)
              .set({ deletedAt: new Date(), deletedByUserId: userId })
              .where(eq(organizationMemberships.id, m.id));
            collapsedMembershipIds.push(m.id);
          } else {
            await tx
              .update(organizationMemberships)
              .set({ labId: targetId })
              .where(eq(organizationMemberships.id, m.id));
            movedMembershipIds.push(m.id);
          }
        }

        // 5. Soft-delete the source organization itself. organizations
        // is in PROTECTED_TABLES — only hard `db.delete()` is forbidden;
        // a direct update of deleted_at / deleted_by_user_id is the
        // soft-delete contract and is what `softDelete()` does under
        // the hood. We inline it here so it shares the transaction with
        // the row reassignments above; the practice_merged audit log
        // written below covers the soft-delete event as well.
        await tx
          .update(organizations)
          .set({ deletedAt: new Date(), deletedByUserId: userId })
          .where(eq(organizations.id, src.id));

        const [audit] = await tx
          .insert(auditLogs)
          .values({
            userId,
            organizationId: labId,
            action: "practice_merged",
            entityType: "organization",
            entityId: src.id,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            beforeJson: {
              sourceOrganizationId: src.id,
              sourceName: src.displayName || src.name,
            },
            afterJson: {
              targetOrganizationId: targetId,
              targetName,
            },
            metadataJson: {
              labOrganizationId: labId,
              movedCaseIds,
              movedInvoiceIds,
              movedOverrideIds,
              collapsedOverrideIds,
              movedMembershipIds,
              collapsedMembershipIds,
              casesMoved: movedCaseIds.length,
              invoicesMoved: movedInvoiceIds.length,
              overridesMoved: movedOverrideIds.length,
              overridesCollapsed: collapsedOverrideIds.length,
              membershipsMoved: movedMembershipIds.length,
              membershipsCollapsed: collapsedMembershipIds.length,
            },
          })
          .returning({ id: auditLogs.id });

        entries.push({
          auditLogId: audit.id,
          sourceOrganizationId: src.id,
          casesMoved: movedCaseIds.length,
          invoicesMoved: movedInvoiceIds.length,
          overridesMoved: movedOverrideIds.length,
          overridesCollapsed: collapsedOverrideIds.length,
          membershipsMoved: movedMembershipIds.length,
          membershipsCollapsed: collapsedMembershipIds.length,
        });

        totalCasesMoved += movedCaseIds.length;
        totalInvoicesMoved += movedInvoiceIds.length;
        totalOverridesMoved += movedOverrideIds.length;
        totalOverridesCollapsed += collapsedOverrideIds.length;
        totalMembershipsMoved += movedMembershipIds.length;
        totalMembershipsCollapsed += collapsedMembershipIds.length;
      }

      return {
        casesMoved: totalCasesMoved,
        invoicesMoved: totalInvoicesMoved,
        overridesMoved: totalOverridesMoved,
        overridesCollapsed: totalOverridesCollapsed,
        membershipsMoved: totalMembershipsMoved,
        membershipsCollapsed: totalMembershipsCollapsed,
        entries,
      };
    });

    return ok(res, {
      ...result,
      // For convenience, also expose the first audit id at the top
      // level — clients that only merge one source at a time can read
      // `data.auditLogId` directly.
      auditLogId: result.entries[0]?.auditLogId ?? null,
      targetOrganizationId: targetId,
      undoWindowMs: readUndoWindowMs(),
    });
  }),
);

router.post(
  "/merge/:auditLogId/undo",
  asyncHandler(async (req, res) => {
    const auditLogId = String(req.params.auditLogId);
    const userId = (req as any).auth.userId as string;

    const audit = await db.query.auditLogs.findFirst({
      where: eq(auditLogs.id, auditLogId),
    });
    if (!audit) throw new HttpError(404, "Merge audit entry not found.");
    if (audit.action !== "practice_merged") {
      throw new HttpError(400, "That audit entry is not a practice merge.");
    }
    if (!audit.organizationId) {
      throw new HttpError(400, "Audit entry is missing a lab id.");
    }
    const auditLabId: string = audit.organizationId;
    await requireAnyRole(userId, auditLabId, ADMIN_ROLES);

    const undoWindowMs = readUndoWindowMs();
    const created = audit.createdAt ? new Date(audit.createdAt as any) : null;
    const ageMs = created ? Date.now() - created.getTime() : Infinity;
    if (ageMs > undoWindowMs) {
      throw new HttpError(
        409,
        `This merge is past the ${Math.round(
          undoWindowMs / 60000,
        )}-minute undo window.`,
      );
    }

    const meta = (audit.metadataJson as any) ?? {};
    const before = (audit.beforeJson as any) ?? {};
    const sourceOrganizationId: string | null =
      typeof before.sourceOrganizationId === "string"
        ? before.sourceOrganizationId
        : (typeof audit.entityId === "string" ? audit.entityId : null);
    if (!sourceOrganizationId) {
      throw new HttpError(400, "Audit entry is missing the source practice id.");
    }

    const movedCaseIds: string[] = Array.isArray(meta.movedCaseIds)
      ? meta.movedCaseIds.filter((x: unknown) => typeof x === "string")
      : [];
    const movedInvoiceIds: string[] = Array.isArray(meta.movedInvoiceIds)
      ? meta.movedInvoiceIds.filter((x: unknown) => typeof x === "string")
      : [];
    const movedOverrideIds: string[] = Array.isArray(meta.movedOverrideIds)
      ? meta.movedOverrideIds.filter((x: unknown) => typeof x === "string")
      : [];
    const collapsedOverrideIds: string[] = Array.isArray(meta.collapsedOverrideIds)
      ? meta.collapsedOverrideIds.filter((x: unknown) => typeof x === "string")
      : [];
    const movedMembershipIds: string[] = Array.isArray(meta.movedMembershipIds)
      ? meta.movedMembershipIds.filter((x: unknown) => typeof x === "string")
      : [];
    const collapsedMembershipIds: string[] = Array.isArray(
      meta.collapsedMembershipIds,
    )
      ? meta.collapsedMembershipIds.filter((x: unknown) => typeof x === "string")
      : [];

    const result = await db.transaction(async (tx) => {
      if (movedCaseIds.length > 0) {
        await tx
          .update(cases)
          .set({ providerOrganizationId: sourceOrganizationId })
          .where(inArray(cases.id, movedCaseIds));
      }
      if (movedInvoiceIds.length > 0) {
        await tx
          .update(invoices)
          .set({ providerOrganizationId: sourceOrganizationId })
          .where(inArray(invoices.id, movedInvoiceIds));
      }
      if (movedOverrideIds.length > 0) {
        await tx
          .update(pricingOverrides)
          .set({ providerOrganizationId: sourceOrganizationId })
          .where(inArray(pricingOverrides.id, movedOverrideIds));
      }
      if (collapsedOverrideIds.length > 0) {
        await tx
          .update(pricingOverrides)
          .set({ deletedAt: null, deletedByUserId: null })
          .where(inArray(pricingOverrides.id, collapsedOverrideIds));
      }
      if (movedMembershipIds.length > 0) {
        await tx
          .update(organizationMemberships)
          .set({ labId: sourceOrganizationId })
          .where(inArray(organizationMemberships.id, movedMembershipIds));
      }
      if (collapsedMembershipIds.length > 0) {
        await tx
          .update(organizationMemberships)
          .set({ deletedAt: null, deletedByUserId: null })
          .where(inArray(organizationMemberships.id, collapsedMembershipIds));
      }

      // Restore the soft-deleted source organization inside the same
      // transaction so the undo is atomic.
      await tx
        .update(organizations)
        .set({ deletedAt: null, deletedByUserId: null })
        .where(eq(organizations.id, sourceOrganizationId));

      return {
        casesReverted: movedCaseIds.length,
        invoicesReverted: movedInvoiceIds.length,
        overridesReverted:
          movedOverrideIds.length + collapsedOverrideIds.length,
        membershipsReverted:
          movedMembershipIds.length + collapsedMembershipIds.length,
      };
    });

    await db.insert(auditLogs).values({
      userId,
      organizationId: auditLabId,
      action: "practice_merge_undone",
      entityType: "organization",
      entityId: sourceOrganizationId,
      ipAddress: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      beforeJson: audit.afterJson ?? null,
      afterJson: audit.beforeJson ?? null,
      metadataJson: { undoneAuditLogId: audit.id, ...result },
    }).catch((err: unknown): never => wrapDbError(err, {
      fallback: "Failed to record merge undo in audit log.",
    }));

    return ok(res, {
      ...result,
      sourceOrganizationId,
    });
  }),
);

export default router;
