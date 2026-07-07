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
 *   - `lab_cases` (legacy mobile rows) carry the doctor name inside the
 *     `case_data` JSON blob rather than a column. The role-agnostic
 *     doctor-name picker (`/cases/doctor-names`) unions canonical names
 *     with names parsed from these blobs, so a merge rewrites the blob's
 *     `doctorName` to the target (preserving every other key) — otherwise
 *     merged-away spellings keep resurfacing in the picker. Reversible via
 *     the `legacyMoves` snapshot in the audit metadata. Practice-less legacy
 *     rows are left untouched when the source name already equals the target
 *     (a same-name/different-practice merge has no blob to disambiguate).
 *
 * The following are intentionally NOT touched by a merge:
 *   - `users.doctorName` (provider user accounts) — out of scope per
 *     task #382. Account merging stays on the cross-lab linking flow.
 *   - `invoices.doctorName` is a snapshot value computed from the case
 *     at issuance — moving cases re-derives it on the next quote/edit.
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
  doctorDupDismissals,
  labCases,
  organizations,
  organizationMemberships,
  pricingOverrides,
  users,
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

// Doctor-name fuzzy-matching helpers now live in a shared module so the
// pre-create duplicate check, the duplicate-clusters panel, and the cases
// route all use identical normalization, scoring, and thresholds.
import {
  normalizeDoctorForCompare as normalizeForCompare,
  doctorNameBigrams as bigrams,
  bigramJaccard,
  doctorNameSimilarity as similarity,
  resolveLabDupThreshold,
} from "../lib/doctor-similarity.js";

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
      s.doctorName.trim() === input.targetDoctorName.trim();
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

  // Dedupe sources case-insensitively (same provider + same name after
  // lowercasing). This prevents double-counting when two capitalization
  // variants are sent as separate sources, because the database WHERE clause
  // matches case-insensitively. The self-merge guard above already rejects
  // exact same source/target; dedupe here is only about redundant sources.
  const seen = new Set<string>();
  const dedupedSources: typeof input.sources = [];
  for (const s of input.sources) {
    const key = `${s.doctorName.trim().toLowerCase()}|${s.providerOrganizationId ?? ""}`;
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

// ---------------------------------------------------------------------------
// Legacy mobile cases (`lab_cases`) store the doctor name inside a TEXT JSON
// blob rather than a column. The doctor-name picker unions canonical
// `cases.doctorName` with names parsed out of these blobs, so a merge that
// only rewrites canonical rows leaves the merged-away spellings resurfacing
// in the picker. The helpers below let merge/preview/undo rewrite the blob's
// `doctorName` safely: parsing is defensive (malformed/non-object blobs are
// skipped, never thrown on) and every other key is preserved untouched.
// ---------------------------------------------------------------------------
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function parseLegacyDoctorName(
  caseData: string | null
): { obj: Record<string, unknown>; name: string } | null {
  if (typeof caseData !== "string") return null;
  try {
    const obj = JSON.parse(caseData);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const name = String((obj as Record<string, unknown>).doctorName ?? "").trim();
    if (!name) return null;
    return { obj: obj as Record<string, unknown>, name };
  } catch {
    return null;
  }
}

// WHERE clause selecting legacy rows that *might* carry this doctor name.
// The ilike on the raw blob text is only a cheap prefilter; the authoritative
// match is the parsed `doctorName` (see matchLegacyRows).
function legacyCaseSourceWhere(
  labId: string,
  doctorName: string,
  includeSoftDeleted: boolean
) {
  const conds = [
    eq(labCases.organizationId, labId),
    ilike(labCases.caseData, `%${escapeLike(doctorName)}%`),
  ];
  if (!includeSoftDeleted) conds.push(isNull(labCases.deletedAt));
  return and(...conds);
}

// Narrow prefiltered rows to exact (case-insensitive, trimmed) matches on the
// parsed `doctorName`, skipping malformed/non-object blobs.
function matchLegacyRows(
  rows: Array<{ id: string; caseData: string }>,
  doctorName: string
): Array<{ id: string; before: string; obj: Record<string, unknown> }> {
  const want = doctorName.trim().toLowerCase();
  const out: Array<{ id: string; before: string; obj: Record<string, unknown> }> =
    [];
  for (const r of rows) {
    const parsed = parseLegacyDoctorName(r.caseData);
    if (!parsed) continue;
    if (parsed.name.toLowerCase() !== want) continue;
    out.push({ id: r.id, before: parsed.name, obj: parsed.obj });
  }
  return out;
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
      legacyCases: number;
    }> = [];
    let totalCases = 0;
    let totalOverrides = 0;
    let totalLegacyCases = 0;
    // Track legacy rows already attributed to an earlier source so the
    // preview's claim-once order mirrors the merge (no double counting when
    // two sources share a doctor name but differ by practice).
    const seenLegacyIds = new Set<string>();

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

      // Legacy mobile cases store the doctor name in the JSON blob. Count the
      // ones this merge would rewrite so legacy-only sources don't preview as
      // "0 cases". Skip when the source name already equals the target — the
      // merge leaves practice-less legacy rows untouched in that case.
      let legacyCases = 0;
      if (
        s.doctorName.trim().toLowerCase() !==
        input.targetDoctorName.trim().toLowerCase()
      ) {
        const legacyRows = await db
          .select({ id: labCases.id, caseData: labCases.caseData })
          .from(labCases)
          .where(
            legacyCaseSourceWhere(labId, s.doctorName, input.includeSoftDeleted)
          );
        for (const m of matchLegacyRows(legacyRows, s.doctorName)) {
          if (seenLegacyIds.has(m.id)) continue;
          seenLegacyIds.add(m.id);
          legacyCases++;
        }
      }

      const practice = s.providerOrganizationId
        ? practices.get(s.providerOrganizationId)
        : null;

      sourceRows.push({
        doctorName: s.doctorName,
        providerOrganizationId: s.providerOrganizationId,
        practiceName:
          practice?.displayName || practice?.name || (s.providerOrganizationId ? null : "(no practice)"),
        totalCases: exactTotal + legacyCases,
        firstCaseAt: first,
        lastCaseAt: last,
        recentCaseNumbers: recent.slice(0, 5).map((r) => r.caseNumber),
        overridesCount,
        legacyCases,
      });
      totalCases += exactTotal + legacyCases;
      totalOverrides += overridesCount;
      totalLegacyCases += legacyCases;
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
      totalLegacyCases,
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
      let legacyCasesMoved = 0;
      // A legacy row is rewritten by at most one source so undo can attribute
      // it back correctly (two sources may share a name but differ by practice).
      const claimedLegacyIds = new Set<string>();
      const entries: Array<{
        auditLogId: string;
        sourceDoctorName: string;
        sourceProviderOrganizationId: string | null;
        casesMoved: number;
        overridesMoved: number;
        overridesCollapsed: number;
        legacyCasesMoved: number;
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

        // 3. Legacy mobile cases store the doctor name inside the JSON blob.
        // Rewrite matching blobs to the target so merged-away spellings stop
        // resurfacing in the role-agnostic doctor-name picker. A source that
        // differs from the target only by practice (same name) must not drag
        // practice-less legacy rows around, so skip those.
        const legacyMoves: Array<{ id: string; before: string }> = [];
        if (
          s.doctorName.trim().toLowerCase() !==
          input.targetDoctorName.trim().toLowerCase()
        ) {
          const legacyRows = await tx
            .select({ id: labCases.id, caseData: labCases.caseData })
            .from(labCases)
            .where(
              legacyCaseSourceWhere(labId, s.doctorName, input.includeSoftDeleted)
            );
          for (const m of matchLegacyRows(legacyRows, s.doctorName)) {
            if (claimedLegacyIds.has(m.id)) continue;
            await tx
              .update(labCases)
              .set({
                caseData: JSON.stringify({
                  ...m.obj,
                  doctorName: input.targetDoctorName,
                }),
              })
              .where(eq(labCases.id, m.id));
            claimedLegacyIds.add(m.id);
            legacyMoves.push({ id: m.id, before: m.before });
          }
        }
        legacyCasesMoved += legacyMoves.length;

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
              legacyCasesMoved: legacyMoves.length,
              includeSoftDeleted: input.includeSoftDeleted,
              movedCaseIds: movedIds,
              movedOverrideIds,
              collapsedOverrideIds,
              legacyMoves,
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
          legacyCasesMoved: legacyMoves.length,
        });
      }

      return {
        casesMoved,
        overridesMoved,
        overridesCollapsed,
        legacyCasesMoved,
        entries,
      };
    });

    // The merge changed doctor rows, so any cached badge count is now stale.
    invalidateDuplicateClusterCache();

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
    const legacyMoves: Array<{ id: string; before: string }> = Array.isArray(
      meta.legacyMoves
    )
      ? meta.legacyMoves.filter(
          (m: unknown): m is { id: string; before: string } =>
            !!m &&
            typeof (m as any).id === "string" &&
            typeof (m as any).before === "string"
        )
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

      // Restore legacy lab_cases blobs. All-or-nothing: verify every blob
      // still holds the merge target name before touching any of them, so a
      // post-merge edit can't be clobbered (mirrors the canonical path).
      let legacyReverted = 0;
      if (legacyMoves.length > 0) {
        const ids = legacyMoves.map((m) => m.id);
        const currentLegacy = await tx
          .select({ id: labCases.id, caseData: labCases.caseData })
          .from(labCases)
          .where(inArray(labCases.id, ids));
        if (currentLegacy.length !== ids.length) {
          throw new HttpError(
            409,
            "A merged legacy case has been removed since — undo refused."
          );
        }
        const byId = new Map(currentLegacy.map((r) => [r.id, r] as const));
        const targetLc = String(after.doctorName).trim().toLowerCase();
        const restore: Array<{
          id: string;
          obj: Record<string, unknown>;
          before: string;
        }> = [];
        for (const mv of legacyMoves) {
          const row = byId.get(mv.id);
          if (!row) {
            throw new HttpError(
              409,
              "A merged legacy case has been removed since — undo refused."
            );
          }
          const parsed = parseLegacyDoctorName(row.caseData);
          if (!parsed) {
            throw new HttpError(
              409,
              "A merged legacy case is malformed — undo refused."
            );
          }
          if (parsed.name.toLowerCase() !== targetLc) {
            throw new HttpError(
              409,
              "A merged legacy case was renamed after the merge — undo refused."
            );
          }
          restore.push({ id: mv.id, obj: parsed.obj, before: mv.before });
        }
        for (const r of restore) {
          await tx
            .update(labCases)
            .set({
              caseData: JSON.stringify({ ...r.obj, doctorName: r.before }),
            })
            .where(eq(labCases.id, r.id));
        }
        legacyReverted = restore.length;
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
          legacyReverted,
        },
      });

      return { casesReverted, overridesReverted, legacyReverted };
    });

    // The undo restored doctor rows, so any cached badge count is now stale.
    invalidateDuplicateClusterCache();

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
            phone: organizations.phone,
          })
          .from(organizations)
          .where(inArray(organizations.id, orgIds))
      : [];
    const orgNames = new Map(
      orgs.map((o) => [o.id, o.displayName || o.name] as const)
    );
    const orgPhones = new Map(
      orgs.map((o) => [o.id, o.phone ?? null] as const)
    );

    // Batch-look up doctor user phones: only fetch phones for users who are
    // active members of the provider orgs we already resolved for this lab
    // (orgIds is lab-scoped via the cases groupBy). This prevents cross-tenant
    // phone leakage — a user named "Dr. Smith" at an unrelated lab is never
    // returned here because their membership org is not in orgIds.
    // Doctors whose cases have no providerOrganizationId are excluded from
    // this lookup since we cannot safely scope them to this lab.
    const doctorNames = Array.from(new Set(groups.map((g) => g.doctorName)));
    const doctorUserRows: Array<{ doctorName: string | null; phone: string | null; practicePhone: string | null }> =
      doctorNames.length && orgIds.length
        ? await db
            .selectDistinct({
              doctorName: users.doctorName,
              phone: users.phone,
              practicePhone: users.practicePhone,
            })
            .from(users)
            .innerJoin(
              organizationMemberships,
              and(
                eq(organizationMemberships.userId, users.id),
                inArray(organizationMemberships.labId, orgIds),
                eq(organizationMemberships.status, "active"),
                isNull(organizationMemberships.deletedAt)
              )
            )
            .where(
              and(
                inArray(
                  sql`lower(${users.doctorName})`,
                  doctorNames.map((n) => n.toLowerCase())
                ),
                notDeleted(users)
              )
            )
        : [];
    // Map normalized doctorName → best available phone (prefer practicePhone over phone).
    const doctorPhones = new Map<string, string>();
    for (const u of doctorUserRows) {
      if (!u.doctorName) continue;
      const key = u.doctorName.toLowerCase();
      if (!doctorPhones.has(key)) {
        const phone = u.practicePhone || u.phone || null;
        if (phone) doctorPhones.set(key, phone);
      }
    }

    const enriched = groups.map((g) => {
      const practiceName = g.providerOrganizationId
        ? orgNames.get(g.providerOrganizationId) ?? null
        : null;
      const practicePhone = g.providerOrganizationId
        ? orgPhones.get(g.providerOrganizationId) ?? null
        : null;
      const doctorPhone = doctorPhones.get(g.doctorName.toLowerCase()) ?? null;
      const sim = like ? similarity(like, g.doctorName) : 0;
      return {
        doctorName: g.doctorName,
        providerOrganizationId: g.providerOrganizationId,
        practiceName,
        practicePhone,
        doctorPhone,
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

// ---------------------------------------------------------------------------
// GET /doctors/duplicate-clusters
// POST /doctors/duplicate-clusters/dismiss
// POST /doctors/duplicate-clusters/restore
//
// Centralized possible-duplicate detection that powers the navigation
// duplicate-count badge on both desktop and mobile. Computes likely-duplicate
// doctor clusters across every lab the caller owns/administers, honoring each
// lab's configured `duplicateSuggestionThreshold`. Reuses the same
// `normalizeForCompare` + `similarity` (bigram jaccard) helpers as the merge
// tooling, so the badge count matches what the merge UI would surface.
//
// `totalGroups` is the badge count and decreases as merges collapse clusters.
// Dismissed clusters are excluded from `clusters` and `totalGroups`, and are
// returned separately in `dismissedClusters`.
// ---------------------------------------------------------------------------

interface DupDoctorNode {
  doctorName: string;
  providerOrganizationId: string | null;
  practiceName: string | null;
  totalCases: number;
}

interface DupClusterResult {
  totalGroups: number;
  totalDoctors: number;
  clusters: Array<{
    labOrganizationId: string;
    labName: string | null;
    topScore: number;
    clusterKey: string;
    doctors: DupDoctorNode[];
  }>;
  dismissedClusters: Array<{
    labOrganizationId: string;
    clusterKey: string;
    doctors: DupDoctorNode[];
    dismissedAt: string;
  }>;
}

// Stable cluster key that mirrors duplicateClusterKey() on the desktop client.
// Row id format: `${doctorName.toLowerCase()}|${providerOrganizationId ?? ""}`
// Key format: `${labId}::${sorted_row_ids.join("||")}`
function computeClusterKey(labId: string, nodes: DupDoctorNode[]): string {
  const ids = nodes.map((n) => `${n.doctorName.toLowerCase()}|${n.providerOrganizationId ?? ""}`);
  ids.sort();
  return `${labId}::${ids.join("||")}`;
}

// Short-TTL response cache for /duplicate-clusters.
//
// The badge polls this endpoint every 60s from both desktop and mobile, and
// the handler runs an O(n²) bigram-similarity scan over every distinct
// (doctor, practice) group per lab. For a high-volume lab that scan is the
// expensive part, so we cache the fully-built response per caller for a short
// window to collapse the near-simultaneous desktop+mobile polls (and rapid
// re-polls) into a single computation.
//
// Correctness: the cache is keyed by userId (which labs the caller administers)
// and is fully invalidated whenever a merge/undo changes the underlying doctor
// data (see invalidateDuplicateClusterCache). A stale entry can therefore only
// linger for at most the TTL after some *other* mutation path changes case
// rows, which is acceptable for a count badge.
//
// Disabled under VITEST so the integration suite — which mutates case rows
// directly and re-polls with the same token — stays deterministic. A test that
// specifically exercises the cache can opt back in with
// DOCTOR_DUP_CLUSTER_CACHE_FORCE=1. Config is read at call time (not module
// load) so those env toggles take effect without reimporting the module.
const DEFAULT_DUP_CLUSTER_CACHE_TTL_MS = 30_000;

function dupClusterCacheConfig(): { enabled: boolean; ttlMs: number } {
  const enabled =
    process.env["DOCTOR_DUP_CLUSTER_CACHE_FORCE"] === "1" ||
    !process.env["VITEST"];
  const raw = process.env["DOCTOR_DUP_CLUSTER_CACHE_TTL_MS"];
  const n = raw == null ? NaN : Number(raw);
  const ttlMs =
    !Number.isFinite(n) || n < 0
      ? DEFAULT_DUP_CLUSTER_CACHE_TTL_MS
      : Math.floor(n);
  return { enabled, ttlMs };
}

const dupClusterCache = new Map<
  string,
  { expires: number; payload: DupClusterResult }
>();

function readDupClusterCache(userId: string): DupClusterResult | null {
  const { enabled, ttlMs } = dupClusterCacheConfig();
  if (!enabled || ttlMs <= 0) return null;
  const entry = dupClusterCache.get(userId);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    dupClusterCache.delete(userId);
    return null;
  }
  return entry.payload;
}

function writeDupClusterCache(userId: string, payload: DupClusterResult): void {
  const { enabled, ttlMs } = dupClusterCacheConfig();
  if (!enabled || ttlMs <= 0) return;
  const now = Date.now();
  // Opportunistically prune expired entries so the map can't grow unbounded
  // across many distinct callers between invalidations.
  for (const [key, val] of dupClusterCache) {
    if (val.expires <= now) dupClusterCache.delete(key);
  }
  dupClusterCache.set(userId, {
    expires: now + ttlMs,
    payload,
  });
}

// Drop every cached badge response. Called after any merge/undo so the next
// poll recomputes from fresh case data instead of serving a pre-merge count.
function invalidateDuplicateClusterCache(): void {
  dupClusterCache.clear();
}

// Union-find clustering over pairs whose similarity(a, b) >= threshold.
// Mirrors buildDuplicateClusters on the desktop, scoped to a single lab.
function buildDoctorClusters(
  labId: string,
  nodes: DupDoctorNode[],
  threshold: number
): Array<{ topScore: number; clusterKey: string; doctors: DupDoctorNode[] }> {
  const out: Array<{ topScore: number; clusterKey: string; doctors: DupDoctorNode[] }> = [];
  if (nodes.length < 2) return out;
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => {
    let cur = i;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]];
      cur = parent[cur];
    }
    return cur;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  // Precompute each node's normalized name + bigram set once, so the O(n²)
  // pair loop below does set-intersection only instead of re-normalizing and
  // re-gramming both names on every comparison. For a lab with ~2k distinct
  // doctor groups this is roughly a 9× speedup and produces identical scores.
  const norm = nodes.map((n) => normalizeForCompare(n.doctorName));
  const grams = norm.map((s) => bigrams(s));
  const pairScores = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i].doctorName) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      if (!nodes[j].doctorName) continue;
      const s = bigramJaccard(norm[i], grams[i], norm[j], grams[j]);
      if (s >= threshold) {
        union(i, j);
        pairScores.set(`${i}|${j}`, s);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const root = find(i);
    const arr = groups.get(root) ?? [];
    arr.push(i);
    groups.set(root, arr);
  }
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    let topScore = 0;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const lo = Math.min(idxs[a], idxs[b]);
        const hi = Math.max(idxs[a], idxs[b]);
        const sc = pairScores.get(`${lo}|${hi}`) ?? 0;
        if (sc > topScore) topScore = sc;
      }
    }
    const clusterDoctors = idxs.map((i) => nodes[i]);
    out.push({
      topScore,
      clusterKey: computeClusterKey(labId, clusterDoctors),
      doctors: clusterDoctors,
    });
  }
  out.sort((a, b) => b.topScore - a.topScore);
  return out;
}

// POST /doctors/duplicate-clusters/dismiss
// Permanently dismisses a suggested duplicate cluster on the server so it
// stops showing up across all devices for this lab. Lab-admin only.
const dismissClusterSchema = z.object({
  labOrganizationId: z.string().min(1),
  clusterKey: z.string().min(1),
  doctors: z
    .array(
      z.object({
        doctorName: z.string(),
        providerOrganizationId: z.string().nullable().optional(),
        practiceName: z.string().nullable().optional(),
        totalCases: z.number().optional().default(0),
      })
    )
    .min(1),
});

router.post(
  "/duplicate-clusters/dismiss",
  asyncHandler(async (req, res) => {
    const input = dismissClusterSchema.parse(req.body);
    const userId = (req as any).auth.userId as string;
    await requireAnyRole(userId, input.labOrganizationId, ADMIN_ROLES);

    await db
      .insert(doctorDupDismissals)
      .values({
        labOrganizationId: input.labOrganizationId,
        clusterKey: input.clusterKey,
        doctorsJson: input.doctors as any,
        dismissedByUserId: userId,
      })
      .onConflictDoUpdate({
        target: [
          doctorDupDismissals.labOrganizationId,
          doctorDupDismissals.clusterKey,
        ],
        set: {
          doctorsJson: input.doctors as any,
          dismissedByUserId: userId,
          dismissedAt: new Date(),
        },
      });

    invalidateDuplicateClusterCache();
    return ok(res, { dismissed: true });
  })
);

// POST /doctors/duplicate-clusters/restore
// Restores (un-dismisses) a previously dismissed duplicate cluster. Lab-admin only.
const restoreClusterSchema = z.object({
  labOrganizationId: z.string().min(1),
  clusterKey: z.string().min(1),
});

router.post(
  "/duplicate-clusters/restore",
  asyncHandler(async (req, res) => {
    const input = restoreClusterSchema.parse(req.body);
    const userId = (req as any).auth.userId as string;
    await requireAnyRole(userId, input.labOrganizationId, ADMIN_ROLES);

    await db
      .delete(doctorDupDismissals)
      .where(
        and(
          eq(doctorDupDismissals.labOrganizationId, input.labOrganizationId),
          eq(doctorDupDismissals.clusterKey, input.clusterKey)
        )
      );

    invalidateDuplicateClusterCache();
    return ok(res, { restored: true });
  })
);

router.get(
  "/duplicate-clusters",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;

    const cached = readDupClusterCache(userId);
    if (cached) {
      return ok(res, cached);
    }

    // Labs the caller owns/administers. Only lab-type orgs carry a doctor
    // directory + a duplicateSuggestionThreshold, so scope to those. Detection
    // is admin-only to match the merge tooling that resolves the clusters.
    const memberLabs = await db
      .select({
        labId: organizationMemberships.labId,
        role: organizationMemberships.role,
        name: organizations.name,
        displayName: organizations.displayName,
        threshold: organizations.duplicateSuggestionThreshold,
      })
      .from(organizationMemberships)
      .innerJoin(
        organizations,
        eq(organizations.id, organizationMemberships.labId)
      )
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt),
          eq(organizations.type, "lab"),
          isNull(organizations.deletedAt)
        )
      );

    const labs = memberLabs.filter((l) =>
      (ADMIN_ROLES as string[]).includes(l.role)
    );
    const labIds = labs.map((l) => l.labId);
    if (labIds.length === 0) {
      const empty: DupClusterResult = {
        totalGroups: 0,
        totalDoctors: 0,
        clusters: [],
        dismissedClusters: [],
      };
      writeDupClusterCache(userId, empty);
      return ok(res, empty);
    }

    // Load dismissed cluster keys for these labs so we can filter them out.
    const dismissedRows = await db
      .select({
        labOrganizationId: doctorDupDismissals.labOrganizationId,
        clusterKey: doctorDupDismissals.clusterKey,
        doctorsJson: doctorDupDismissals.doctorsJson,
        dismissedAt: doctorDupDismissals.dismissedAt,
      })
      .from(doctorDupDismissals)
      .where(inArray(doctorDupDismissals.labOrganizationId, labIds));

    const dismissedKeySet = new Set(
      dismissedRows.map((r) => `${r.labOrganizationId}::${r.clusterKey}`)
    );

    // Distinct (doctor, practice) groups per lab, mirroring the desktop's
    // DoctorRow keying. Only non-deleted canonical cases with a real name.
    const groups = await db
      .select({
        labOrganizationId: cases.labOrganizationId,
        doctorName: cases.doctorName,
        providerOrganizationId: cases.providerOrganizationId,
        totalCases: sql<number>`count(*)::int`.as("total_cases"),
      })
      .from(cases)
      .where(
        and(
          inArray(cases.labOrganizationId, labIds),
          notDeleted(cases),
          sql`${cases.doctorName} is not null and trim(${cases.doctorName}) <> ''`
        )
      )
      .groupBy(
        cases.labOrganizationId,
        cases.doctorName,
        cases.providerOrganizationId
      );

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
    const orgName = new Map(
      orgs.map((o) => [o.id, o.displayName || o.name] as const)
    );

    const labMeta = new Map(
      labs.map(
        (l) =>
          [
            l.labId,
            {
              name: l.displayName || l.name,
              threshold: resolveLabDupThreshold(l.threshold),
            },
          ] as const
      )
    );

    const byLab = new Map<string, DupDoctorNode[]>();
    for (const g of groups) {
      if (!g.doctorName) continue;
      const arr = byLab.get(g.labOrganizationId) ?? [];
      arr.push({
        doctorName: g.doctorName,
        providerOrganizationId: g.providerOrganizationId,
        practiceName: g.providerOrganizationId
          ? orgName.get(g.providerOrganizationId) ?? null
          : null,
        totalCases: g.totalCases,
      });
      byLab.set(g.labOrganizationId, arr);
    }

    const clusters: DupClusterResult["clusters"] = [];
    for (const [labId, nodes] of byLab) {
      const meta = labMeta.get(labId);
      if (!meta) continue;
      for (const c of buildDoctorClusters(labId, nodes, meta.threshold)) {
        const dismissed = dismissedKeySet.has(`${labId}::${c.clusterKey}`);
        if (dismissed) continue;
        clusters.push({
          labOrganizationId: labId,
          labName: meta.name,
          topScore: c.topScore,
          clusterKey: c.clusterKey,
          doctors: c.doctors,
        });
      }
    }
    clusters.sort((a, b) => b.topScore - a.topScore);

    // Build dismissed clusters list from the stored dismissal rows.
    const dismissedClusters: DupClusterResult["dismissedClusters"] =
      dismissedRows.map((r) => ({
        labOrganizationId: r.labOrganizationId,
        clusterKey: r.clusterKey,
        doctors: Array.isArray(r.doctorsJson) ? (r.doctorsJson as DupDoctorNode[]) : [],
        dismissedAt:
          r.dismissedAt instanceof Date
            ? r.dismissedAt.toISOString()
            : String(r.dismissedAt),
      }));

    const totalDoctors = clusters.reduce((n, c) => n + c.doctors.length, 0);
    const payload: DupClusterResult = {
      totalGroups: clusters.length,
      totalDoctors,
      clusters,
      dismissedClusters,
    };
    writeDupClusterCache(userId, payload);
    return ok(res, payload);
  })
);

export default router;
