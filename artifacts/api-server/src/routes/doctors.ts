/**
 * Doctor merge endpoints (Task #382).
 *
 * Doctor-keyed data this route is responsible for moving when an admin
 * merges one or more source doctors into a target:
 *
 *   - `cases.doctorName` (+ `providerOrganizationId` switched to the
 *     target practice). Soft-deleted cases follow only when the caller
 *     opts in via `includeSoftDeleted`.
 *   - `pricing_overrides` rows keyed on `(labOrganizationId, doctorName)`.
 *     Remapped to the target name; if the target already has an
 *     override row the source override is collapsed (soft-deleted) so
 *     the unique index is not violated.
 *
 * The following are intentionally NOT touched by a merge:
 *   - `users.doctorName` (provider user accounts) — out of scope per
 *     task #382. Account merging stays on the cross-lab linking flow.
 *   - `invoices.doctorName` is a snapshot value computed from the case
 *     at issuance — moving cases re-derives it on the next quote/edit.
 *   - `lab_cases` (legacy mobile rows) carry doctor name inside the
 *     JSON blob; rewriting that blob is out of scope here.
 *
 * Audit + undo: every source→target rename writes a single `doctor_merged`
 * audit row containing enough before/after state for the undo endpoint
 * to reverse it within the configured undo window (default 10 minutes,
 * overridable via the DOCTOR_MERGE_UNDO_WINDOW_MINUTES env var).
 */
import { Router } from "express";
import { and, desc, eq, ilike, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  auditLogs,
  cases,
  organizations,
  pricingOverrides,
} from "@workspace/db";
import { HttpError, ok } from "../lib/http";
import { ADMIN_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { notDeleted } from "../lib/soft-delete";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";

const router = Router();
router.use(requireAuth);

// Window during which a merge can be undone. Configurable via the
// DOCTOR_MERGE_UNDO_WINDOW_MINUTES env var (default: 10 min). Out-of-range
// or non-numeric values fall back to the default.
function readUndoWindowMs(): number {
  const raw = process.env["DOCTOR_MERGE_UNDO_WINDOW_MINUTES"];
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) return 10 * 60 * 1000;
  return Math.floor(n * 60 * 1000);
}

// `providerOrganizationId` may legitimately be null/missing — when a
// doctor's cases were created without a practice attached they show up as
// "Unknown practice" in the UI. Accept empty string OR null and normalize
// to null so we can still merge those rows.
const optionalOrgId = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined || v === null) return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  });

const sourceSchema = z.object({
  doctorName: z.string().trim().min(1),
  providerOrganizationId: optionalOrgId,
});

const mergeSchema = z.object({
  // Cap is generous (500) so a one-shot cleanup of a long-tail
  // duplicate group still goes through; the merge runs in one tx and
  // the per-source overhead is small relative to the lock window.
  sources: z.array(sourceSchema).min(1).max(500),
  targetDoctorName: z.string().trim().min(1),
  targetProviderOrganizationId: z.string().trim().min(1).nullable().optional(),
  labOrganizationId: z.string().min(1),
  includeSoftDeleted: z.boolean().optional().default(false),
});

type ParsedMerge = z.infer<typeof mergeSchema>;

function normalizeKey(name: string, providerId: string | null) {
  return `${name.trim().toLowerCase()}|${providerId ?? ""}`;
}

function normalizeForCompare(name: string | null | undefined) {
  return (name ?? "")
    .toString()
    .toLowerCase()
    .replace(/\bdr\.?\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function similarity(a: string, b: string): number {
  const an = normalizeForCompare(a);
  const bn = normalizeForCompare(b);
  if (!an || !bn) return 0;
  if (an === bn) return 1;
  // bigram jaccard — cheap and good enough for short doctor names.
  const grams = (s: string) => {
    const set = new Set<string>();
    const padded = ` ${s} `;
    for (let i = 0; i < padded.length - 1; i++) set.add(padded.slice(i, i + 2));
    return set;
  };
  const A = grams(an);
  const B = grams(bn);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

async function loadAndAuthorizeMerge(
  userId: string,
  input: ParsedMerge,
  { requireTarget }: { requireTarget: boolean }
) {
  const labId = input.labOrganizationId;
  await requireAnyRole(userId, labId, ADMIN_ROLES);

  // Validate practices and that they belong to the lab.
  const practiceIds = new Set<string>();
  for (const s of input.sources) {
    if (s.providerOrganizationId) practiceIds.add(s.providerOrganizationId);
  }
  if (input.targetProviderOrganizationId) {
    practiceIds.add(input.targetProviderOrganizationId);
  }

  const practices = practiceIds.size
    ? await db.query.organizations.findMany({
        where: inArray(organizations.id, Array.from(practiceIds)),
      })
    : [];
  const byId = new Map(practices.map((p) => [p.id, p] as const));

  for (const s of input.sources) {
    if (!s.providerOrganizationId) continue;
    const p = byId.get(s.providerOrganizationId);
    if (!p || p.deletedAt) {
      throw new HttpError(404, `Source practice not found: ${s.providerOrganizationId}`);
    }
    if (p.parentLabOrganizationId !== labId) {
      throw new HttpError(400, "Source practice does not belong to this lab.");
    }
  }

  if (requireTarget && !input.targetProviderOrganizationId) {
    throw new HttpError(
      400,
      "Target practice is required — pick one in the merge dialog."
    );
  }
  if (input.targetProviderOrganizationId) {
    const tp = byId.get(input.targetProviderOrganizationId);
    if (!tp || tp.deletedAt) {
      throw new HttpError(404, "Target practice not found.");
    }
    if (tp.parentLabOrganizationId !== labId) {
      throw new HttpError(400, "Target practice does not belong to this lab.");
    }
  }

  // Reject self-merge: every source must differ from the target.
  for (const s of input.sources) {
    const sameName =
      s.doctorName.trim().toLowerCase() ===
      input.targetDoctorName.trim().toLowerCase();
    const samePractice =
      (s.providerOrganizationId ?? null) ===
      (input.targetProviderOrganizationId ?? null);
    if (sameName && samePractice) {
      throw new HttpError(
        400,
        "Source and target are the same — nothing to merge."
      );
    }
  }

  // Dedupe sources.
  const seen = new Set<string>();
  const dedupedSources: typeof input.sources = [];
  for (const s of input.sources) {
    const key = normalizeKey(s.doctorName, s.providerOrganizationId);
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedSources.push(s);
  }

  return { labId, practices: byId, sources: dedupedSources };
}

function caseSourceWhere(
  labId: string,
  source: { doctorName: string; providerOrganizationId: string | null },
  includeSoftDeleted: boolean
) {
  const providerClause = source.providerOrganizationId
    ? eq(cases.providerOrganizationId, source.providerOrganizationId)
    : isNull(cases.providerOrganizationId);
  const conds = [
    eq(cases.labOrganizationId, labId),
    providerClause,
    sql`lower(${cases.doctorName}) = lower(${source.doctorName})`,
  ];
  if (!includeSoftDeleted) conds.push(notDeleted(cases));
  return and(...conds);
}

router.post(
  "/merge/preview",
  asyncHandler(async (req, res) => {
    const input = mergeSchema.parse(req.body);
    const userId = (req as any).auth.userId as string;
    const { labId, practices, sources } = await loadAndAuthorizeMerge(
      userId,
      input,
      { requireTarget: false }
    );

    const sourceRows: Array<{
      doctorName: string;
      providerOrganizationId: string | null;
      practiceName: string | null;
      totalCases: number;
      firstCaseAt: string | null;
      lastCaseAt: string | null;
      recentCaseNumbers: string[];
      overridesCount: number;
    }> = [];
    let totalCases = 0;
    let totalOverrides = 0;

    for (const s of sources) {
      const where = caseSourceWhere(labId, s, input.includeSoftDeleted);

      // Exact total via COUNT(*) so the preview never undercounts on
      // sources with thousands of cases.
      const countRows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(cases)
        .where(where);
      const exactTotal = Number(countRows[0]?.n ?? 0);

      // Separate small query for the recent case numbers and date range
      // shown in the UI — capped because the user only sees a handful.
      const recent = await db
        .select({
          caseNumber: cases.caseNumber,
          createdAt: cases.createdAt,
        })
        .from(cases)
        .where(where)
        .orderBy(desc(cases.createdAt))
        .limit(50);

      const rangeRows = await db
        .select({
          first: sql<Date | null>`min(${cases.createdAt})`,
          last: sql<Date | null>`max(${cases.createdAt})`,
        })
        .from(cases)
        .where(where);
      const first = rangeRows[0]?.first
        ? new Date(rangeRows[0].first as any).toISOString()
        : null;
      const last = rangeRows[0]?.last
        ? new Date(rangeRows[0].last as any).toISOString()
        : null;

      const overrideCountRows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pricingOverrides)
        .where(
          and(
            eq(pricingOverrides.labOrganizationId, labId),
            sql`lower(${pricingOverrides.doctorName}) = lower(${s.doctorName})`,
            notDeleted(pricingOverrides)
          )
        );
      const overridesCount = Number(overrideCountRows[0]?.n ?? 0);

      const practice = s.providerOrganizationId
        ? practices.get(s.providerOrganizationId)
        : null;

      sourceRows.push({
        doctorName: s.doctorName,
        providerOrganizationId: s.providerOrganizationId,
        practiceName:
          practice?.displayName || practice?.name || (s.providerOrganizationId ? null : "(no practice)"),
        totalCases: exactTotal,
        firstCaseAt: first,
        lastCaseAt: last,
        recentCaseNumbers: recent.slice(0, 5).map((r) => r.caseNumber),
        overridesCount,
      });
      totalCases += exactTotal;
      totalOverrides += overridesCount;
    }

    let targetCases = 0;
    let targetExists = false;
    if (input.targetProviderOrganizationId) {
      const targetCountRows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(cases)
        .where(
          and(
            eq(cases.labOrganizationId, labId),
            eq(cases.providerOrganizationId, input.targetProviderOrganizationId),
            sql`lower(${cases.doctorName}) = lower(${input.targetDoctorName})`,
            notDeleted(cases)
          )
        );
      targetCases = Number(targetCountRows[0]?.n ?? 0);
      targetExists = targetCases > 0;
    }

    return ok(res, {
      totalCases,
      totalOverrides,
      sources: sourceRows,
      targetExists,
      targetCases,
    });
  })
);

router.post(
  "/merge",
  asyncHandler(async (req, res) => {
    const input = mergeSchema.parse(req.body);
    const userId = (req as any).auth.userId as string;
    const { labId, practices, sources } = await loadAndAuthorizeMerge(
      userId,
      input,
      { requireTarget: true }
    );
    const targetProviderId = input.targetProviderOrganizationId!;
    const targetPractice = practices.get(targetProviderId)!;

    const result = await db.transaction(async (tx) => {
      let casesMoved = 0;
      let overridesMoved = 0;
      let overridesCollapsed = 0;
      const entries: Array<{
        auditLogId: string;
        sourceDoctorName: string;
        sourceProviderOrganizationId: string | null;
        casesMoved: number;
        overridesMoved: number;
        overridesCollapsed: number;
      }> = [];

      for (const s of sources) {
        // 1. Snapshot the cases that will be renamed (so undo can find them).
        const matchedCases = await tx
          .select({ id: cases.id, caseNumber: cases.caseNumber })
          .from(cases)
          .where(caseSourceWhere(labId, s, input.includeSoftDeleted));

        const movedIds = matchedCases.map((c) => c.id);
        if (movedIds.length > 0) {
          await tx
            .update(cases)
            .set({
              doctorName: input.targetDoctorName,
              providerOrganizationId: targetProviderId,
            })
            .where(inArray(cases.id, movedIds));
        }

        // 2. Pricing overrides keyed on doctorName.
        const sourceOverrides = await tx
          .select()
          .from(pricingOverrides)
          .where(
            and(
              eq(pricingOverrides.labOrganizationId, labId),
              sql`lower(${pricingOverrides.doctorName}) = lower(${s.doctorName})`,
              isNull(pricingOverrides.deletedAt)
            )
          );

        const movedOverrideIds: string[] = [];
        const collapsedOverrideIds: string[] = [];

        for (const ov of sourceOverrides) {
          // Does the target already have an override?
          const [existingTarget] = await tx
            .select({ id: pricingOverrides.id })
            .from(pricingOverrides)
            .where(
              and(
                eq(pricingOverrides.labOrganizationId, labId),
                sql`lower(${pricingOverrides.doctorName}) = lower(${input.targetDoctorName})`,
                isNull(pricingOverrides.deletedAt)
              )
            )
            .limit(1);

          if (existingTarget && existingTarget.id !== ov.id) {
            // Soft-delete the source so the unique index isn't violated.
            await tx
              .update(pricingOverrides)
              .set({
                deletedAt: new Date(),
                deletedByUserId: userId,
              })
              .where(eq(pricingOverrides.id, ov.id));
            collapsedOverrideIds.push(ov.id);
            overridesCollapsed++;
          } else {
            await tx
              .update(pricingOverrides)
              .set({
                doctorName: input.targetDoctorName,
                providerOrganizationId: targetProviderId,
                practiceName:
                  targetPractice.displayName || targetPractice.name,
              })
              .where(eq(pricingOverrides.id, ov.id));
            movedOverrideIds.push(ov.id);
            overridesMoved++;
          }
        }

        casesMoved += movedIds.length;

        const sourcePractice = s.providerOrganizationId
          ? practices.get(s.providerOrganizationId)
          : null;

        const [audit] = await tx
          .insert(auditLogs)
          .values({
            userId,
            organizationId: labId,
            action: "doctor_merged",
            entityType: "doctor",
            entityId: null,
            ipAddress: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
            beforeJson: {
              doctorName: s.doctorName,
              providerOrganizationId: s.providerOrganizationId,
              practiceName:
                sourcePractice?.displayName ||
                sourcePractice?.name ||
                "(no practice)",
            },
            afterJson: {
              doctorName: input.targetDoctorName,
              providerOrganizationId: targetProviderId,
              practiceName:
                targetPractice.displayName || targetPractice.name,
            },
            metadataJson: {
              casesMoved: movedIds.length,
              overridesMoved: movedOverrideIds.length,
              overridesCollapsed: collapsedOverrideIds.length,
              includeSoftDeleted: input.includeSoftDeleted,
              movedCaseIds: movedIds,
              movedOverrideIds,
              collapsedOverrideIds,
            },
          })
          .returning({ id: auditLogs.id });

        entries.push({
          auditLogId: audit.id,
          sourceDoctorName: s.doctorName,
          sourceProviderOrganizationId: s.providerOrganizationId,
          casesMoved: movedIds.length,
          overridesMoved: movedOverrideIds.length,
          overridesCollapsed: collapsedOverrideIds.length,
        });
      }

      return { casesMoved, overridesMoved, overridesCollapsed, entries };
    });

    return ok(res, {
      ...result,
      targetDoctorName: input.targetDoctorName,
      targetProviderOrganizationId: targetProviderId,
      undoWindowMs: readUndoWindowMs(),
    });
  })
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
    if (audit.action !== "doctor_merged") {
      throw new HttpError(400, "That audit entry is not a doctor merge.");
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
          undoWindowMs / 60000
        )}-minute undo window.`
      );
    }

    const meta = (audit.metadataJson as any) ?? {};
    const before = (audit.beforeJson as any) ?? {};
    const after = (audit.afterJson as any) ?? {};
    const movedCaseIds: string[] = Array.isArray(meta.movedCaseIds)
      ? meta.movedCaseIds.filter((x: unknown) => typeof x === "string")
      : [];
    const movedOverrideIds: string[] = Array.isArray(meta.movedOverrideIds)
      ? meta.movedOverrideIds.filter((x: unknown) => typeof x === "string")
      : [];
    const collapsedOverrideIds: string[] = Array.isArray(
      meta.collapsedOverrideIds
    )
      ? meta.collapsedOverrideIds.filter((x: unknown) => typeof x === "string")
      : [];

    if (typeof before.doctorName !== "string" || typeof after.doctorName !== "string") {
      throw new HttpError(400, "Audit entry is missing the rename payload.");
    }

    const result = await db.transaction(async (tx) => {
      // Verify the cases still match the post-merge state. If a user has
      // since edited any of them, refuse the undo so we don't clobber
      // newer changes.
      let casesReverted = 0;
      if (movedCaseIds.length > 0) {
        const current = await tx
          .select({
            id: cases.id,
            doctorName: cases.doctorName,
            providerOrganizationId: cases.providerOrganizationId,
          })
          .from(cases)
          .where(inArray(cases.id, movedCaseIds));
        if (current.length !== movedCaseIds.length) {
          throw new HttpError(
            409,
            "Some merged cases have been deleted since — undo refused."
          );
        }
        for (const c of current) {
          if (
            c.doctorName.trim().toLowerCase() !==
            String(after.doctorName).trim().toLowerCase()
          ) {
            throw new HttpError(
              409,
              "A merged case was renamed after the merge — undo refused."
            );
          }
          if (after.providerOrganizationId &&
              c.providerOrganizationId !== after.providerOrganizationId) {
            throw new HttpError(
              409,
              "A merged case moved to a different practice — undo refused."
            );
          }
        }
        await tx
          .update(cases)
          .set({
            doctorName: before.doctorName,
            providerOrganizationId: before.providerOrganizationId ?? null,
          })
          .where(inArray(cases.id, movedCaseIds));
        casesReverted = movedCaseIds.length;
      }

      let overridesReverted = 0;
      // Preflight: pricing_overrides has a partial unique index on
      // (labOrganizationId, doctorName) WHERE deleted_at IS NULL. If
      // someone created a *new* active override at the source doctor
      // name after the merge, the undo updates below would clobber it
      // (or violate the index when restoring a soft-deleted row). Refuse
      // cleanly with 409 instead of leaking a raw DB error.
      const restoredIds = [...movedOverrideIds, ...collapsedOverrideIds];
      if (restoredIds.length > 0) {
        const conflicts = await tx
          .select({ id: pricingOverrides.id })
          .from(pricingOverrides)
          .where(
            and(
              eq(pricingOverrides.labOrganizationId, auditLabId),
              sql`lower(${pricingOverrides.doctorName}) = lower(${before.doctorName})`,
              isNull(pricingOverrides.deletedAt),
              notInArray(pricingOverrides.id, restoredIds)
            )
          )
          .limit(1);
        if (conflicts.length > 0) {
          throw new HttpError(
            409,
            "A new pricing override already exists at the source doctor name — undo refused."
          );
        }
      }
      if (movedOverrideIds.length > 0) {
        // Refuse the undo if any moved override has been edited or
        // (re-)deleted since the merge — otherwise we'd silently clobber
        // those newer changes.
        const currentOv = await tx
          .select({
            id: pricingOverrides.id,
            doctorName: pricingOverrides.doctorName,
            providerOrganizationId: pricingOverrides.providerOrganizationId,
            deletedAt: pricingOverrides.deletedAt,
          })
          .from(pricingOverrides)
          .where(inArray(pricingOverrides.id, movedOverrideIds));
        if (currentOv.length !== movedOverrideIds.length) {
          throw new HttpError(
            409,
            "A merged pricing override has been deleted since — undo refused."
          );
        }
        for (const ov of currentOv) {
          if (ov.deletedAt) {
            throw new HttpError(
              409,
              "A merged pricing override was deleted after the merge — undo refused."
            );
          }
          if (
            ov.doctorName.trim().toLowerCase() !==
            String(after.doctorName).trim().toLowerCase()
          ) {
            throw new HttpError(
              409,
              "A merged pricing override was renamed after the merge — undo refused."
            );
          }
          if (
            after.providerOrganizationId &&
            ov.providerOrganizationId !== after.providerOrganizationId
          ) {
            throw new HttpError(
              409,
              "A merged pricing override moved to a different practice — undo refused."
            );
          }
        }
        await tx
          .update(pricingOverrides)
          .set({
            doctorName: before.doctorName,
            providerOrganizationId: before.providerOrganizationId ?? null,
            practiceName: before.practiceName ?? null,
          })
          .where(inArray(pricingOverrides.id, movedOverrideIds));
        overridesReverted += movedOverrideIds.length;
      }
      if (collapsedOverrideIds.length > 0) {
        // Collapsed source overrides were soft-deleted by the merge.
        // Refuse the undo if anyone restored or hard-deleted them since.
        const currentCollapsed = await tx
          .select({
            id: pricingOverrides.id,
            deletedAt: pricingOverrides.deletedAt,
          })
          .from(pricingOverrides)
          .where(inArray(pricingOverrides.id, collapsedOverrideIds));
        if (currentCollapsed.length !== collapsedOverrideIds.length) {
          throw new HttpError(
            409,
            "A collapsed pricing override has been removed since — undo refused."
          );
        }
        for (const ov of currentCollapsed) {
          if (!ov.deletedAt) {
            throw new HttpError(
              409,
              "A collapsed pricing override was restored after the merge — undo refused."
            );
          }
        }
        await tx
          .update(pricingOverrides)
          .set({ deletedAt: null, deletedByUserId: null })
          .where(inArray(pricingOverrides.id, collapsedOverrideIds));
        overridesReverted += collapsedOverrideIds.length;
      }

      await tx.insert(auditLogs).values({
        userId,
        organizationId: auditLabId,
        action: "doctor_merge_undone",
        entityType: "doctor",
        entityId: null,
        ipAddress: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        beforeJson: after,
        afterJson: before,
        metadataJson: {
          undoneAuditLogId: audit.id,
          casesReverted,
          overridesReverted,
        },
      });

      return { casesReverted, overridesReverted };
    });

    return ok(res, {
      ...result,
      sourceDoctorName: before.doctorName,
      sourceProviderOrganizationId: before.providerOrganizationId ?? null,
    });
  })
);

// Return distinct doctor names seen in cases for a lab, optionally filtered
// to a specific provider org. Used by mobile Review Extraction to detect
// unknown doctors. Requires active lab membership (not admin-only).
router.get(
  "/known-names",
  asyncHandler(async (req, res) => {
    const labId = String(req.query.labOrganizationId ?? "");
    if (!labId) throw new HttpError(400, "labOrganizationId is required.");
    const userId = (req as any).auth.userId as string;
    await requireMembership(userId, labId);

    const providerOrgId = req.query.providerOrganizationId
      ? String(req.query.providerOrganizationId).trim()
      : null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conds: any[] = [
      eq(cases.labOrganizationId, labId),
      notDeleted(cases),
      sql`${cases.doctorName} is not null and trim(${cases.doctorName}) <> ''`,
    ];
    if (providerOrgId) {
      conds.push(eq(cases.providerOrganizationId, providerOrgId));
    }

    const rows = await db
      .selectDistinct({ doctorName: cases.doctorName })
      .from(cases)
      .where(and(...conds))
      .limit(200);

    const names = rows
      .map((r) => r.doctorName)
      .filter((n): n is string => !!n && n.trim().length > 0);

    return ok(res, { names });
  })
);

router.get(
  "/search",
  asyncHandler(async (req, res) => {
    const labId = String(req.query.labOrganizationId ?? "");
    if (!labId) throw new HttpError(400, "labOrganizationId is required.");
    const userId = (req as any).auth.userId as string;
    // Search powers admin-only merge tooling, so gate it the same way as
    // the merge endpoints rather than allowing any active member.
    await requireAnyRole(userId, labId, ADMIN_ROLES);

    const q = String(req.query.q ?? "").trim();
    const like = String(req.query.like ?? "").trim();
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Math.min(
      500,
      Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100)
    );
    const offsetRaw = Number(req.query.offset ?? 0);
    const offset = Math.max(
      0,
      Number.isFinite(offsetRaw) ? Math.floor(offsetRaw) : 0
    );

    // Pull distinct (doctor, provider) groups for the lab. Filter at SQL
    // level when the caller provided `q`; otherwise fall back to ranking
    // every group in the lab so the picker can show the full list.
    const conds = [
      eq(cases.labOrganizationId, labId),
      notDeleted(cases),
    ];
    if (q) {
      // Pre-resolve practice org IDs whose name/displayName matches `q`
      // so the SQL filter covers practice-name matches too (not just
      // doctor names). Limited to provider orgs in this lab.
      const matchingPracticeOrgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.parentLabOrganizationId, labId),
            eq(organizations.type, "provider"),
            or(
              ilike(organizations.name, `%${q}%`),
              ilike(organizations.displayName, `%${q}%`)
            )!
          )
        );
      const practiceOrgIds = matchingPracticeOrgs.map((o) => o.id);
      conds.push(
        or(
          ilike(cases.doctorName, `%${q}%`),
          practiceOrgIds.length
            ? inArray(cases.providerOrganizationId, practiceOrgIds)
            : sql`false`
        )!
      );
    }

    // Aggregate count + provider per doctor group.
    const groups = await db
      .select({
        doctorName: cases.doctorName,
        providerOrganizationId: cases.providerOrganizationId,
        totalCases: sql<number>`count(*)::int`.as("total"),
        openCases: sql<number>`count(*) filter (where ${cases.status} in ('received','in_design','in_milling','in_porcelain','qc','on_hold','remake'))::int`.as("open_cases"),
      })
      .from(cases)
      .where(and(...conds))
      .groupBy(cases.doctorName, cases.providerOrganizationId);

    const orgIds = Array.from(
      new Set(
        groups
          .map((g) => g.providerOrganizationId)
          .filter((x): x is string => !!x)
      )
    );
    const orgs = orgIds.length
      ? await db
          .select({
            id: organizations.id,
            name: organizations.name,
            displayName: organizations.displayName,
          })
          .from(organizations)
          .where(inArray(organizations.id, orgIds))
      : [];
    const orgNames = new Map(
      orgs.map((o) => [o.id, o.displayName || o.name] as const)
    );

    const enriched = groups.map((g) => {
      const practiceName = g.providerOrganizationId
        ? orgNames.get(g.providerOrganizationId) ?? null
        : null;
      const sim = like ? similarity(like, g.doctorName) : 0;
      return {
        doctorName: g.doctorName,
        providerOrganizationId: g.providerOrganizationId,
        practiceName,
        totalCases: g.totalCases,
        openCases: g.openCases,
        similarity: sim,
      };
    });

    const filtered = q
      ? enriched.filter((e) => {
          const hay = `${e.doctorName} ${e.practiceName ?? ""}`.toLowerCase();
          return hay.includes(q.toLowerCase());
        })
      : enriched;

    filtered.sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      if (b.totalCases !== a.totalCases) return b.totalCases - a.totalCases;
      return a.doctorName.localeCompare(b.doctorName);
    });

    return ok(res, {
      entries: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
    });
  })
);

export default router;
