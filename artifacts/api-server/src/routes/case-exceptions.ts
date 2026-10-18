import { Router, type Request, type Response } from "express";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  caseAttachments,
  caseEvents,
  caseExceptionNotes,
  caseExceptions,
  caseLocations,
  cases,
  legacyCaseMedia,
  labCases,
  labLocations,
  organizationMemberships,
  organizations,
  users,
} from "@workspace/db";
import { HttpError, ok, extractPgCode } from "../lib/http";
import {
  canonicalStatusToLegacy,
  legacyStatusToCanonical,
} from "../lib/case-status";
import { logger } from "../lib/logger";
import { ADMIN_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import { deliverInAppNotification } from "../lib/in-app-notifications";
import { broadcastCaseUpdated } from "../lib/case-events-ws";
import { BUILT_IN_LAB_STATIONS } from "../lib/lab-locations";
import { acquireCaseLocationStatusLock } from "../lib/case-location-status";
import { extractMediaFileName } from "../lib/case-media";

const router = Router();
router.use(requireAuth);

/**
 * Canonical status used when an exception is explicitly put on hold. Mirrors
 * the `on_hold` member of the case-status enum in `cases.ts` / `locations.ts`.
 */
export const EXCEPTION_HOLD_STATUS = "on_hold";

/**
 * Case-history event types belonging to the lab-only exception workflow.
 * `cases.ts` consumes this list when shaping case responses for providers:
 * providers must not learn that the internal workflow (or any of its text)
 * exists through the ordinary case history endpoint.
 */
export const INTERNAL_EXCEPTION_HISTORY_EVENT_TYPES = [
  "case_exception_opened",
  "case_exception_resolved",
  "exception_opened",
  "exception_resolved",
  "internal_exception_opened_note",
  "internal_exception_note_added",
  "internal_exception_resolution_note_added",
] as const;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function displayName(
  u:
    | {
        firstName?: string | null;
        lastName?: string | null;
        username?: string | null;
        email?: string | null;
      }
    | null
    | undefined,
): string | null {
  if (!u) return null;
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || u.username || u.email || null;
}

async function fetchUserActiveLabIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ labId: organizationMemberships.labId })
    .from(organizationMemberships)
    .innerJoin(
      organizations,
      eq(organizations.id, organizationMemberships.labId),
    )
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
        eq(organizations.type, "lab"),
        isNull(organizationMemberships.deletedAt),
      ),
    );
  const ids = new Set<string>();
  for (const r of rows) if (r.labId) ids.add(r.labId);
  return Array.from(ids);
}

type CaseTarget =
  | {
      kind: "canonical";
      caseId: string;
      labCaseId: null;
      labOrganizationId: string;
      caseNumber: string | null;
      patientFirstName: string | null;
      patientLastName: string | null;
      doctorName: string | null;
      status: string | null;
      labLocationId: string | null;
    }
  | {
      kind: "legacy";
      caseId: null;
      labCaseId: string;
      labOrganizationId: string;
      caseNumber: string | null;
      patientFirstName: string | null;
      patientLastName: string | null;
      doctorName: string | null;
      status: string | null;
      labLocationId: string | null;
    };

function parseLegacyBlob(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

const STATUS_LOCATION_LABELS: Record<string, string> = {
  received: "Received",
  in_design: "In Design",
  scan: "Scan",
  in_milling: "In Milling",
  post_mill: "Post Mill",
  sintering_furnace: "Sintering Furnace",
  model_room: "Model Room",
  in_porcelain: "In Porcelain",
  qc: "QC",
  complete: "Complete",
  shipped: "Shipped",
  delivered: "Delivered",
  on_hold: "On Hold",
  remake: "Remake",
  cancelled: "Cancelled",
};

function fallbackLocationName(status: string | null): string {
  return (status && STATUS_LOCATION_LABELS[status]) || "Location unavailable";
}

type CurrentCaseLocation = {
  id: string | null;
  name: string;
  status: string | null;
  code: string | null;
};

/**
 * Resolve the case's live location for the lab-only exception detail. The
 * location row is authoritative when present; older and legacy cases may only
 * have a status, so their status is deliberately rendered as a safe fallback.
 */
async function loadCurrentCaseLocation(
  row: typeof caseExceptions.$inferSelect,
  dbOrTx: any = db,
): Promise<CurrentCaseLocation> {
  if (row.caseId) {
    const currentCase = await dbOrTx.query.cases.findFirst({
      where: and(eq(cases.id, row.caseId), isNull(cases.deletedAt)),
    });
    const status =
      (currentCase?.status as string | null | undefined) ??
      row.resolutionStatus ??
      row.previousStatus ??
      null;
    const location = currentCase?.labLocationId
      ? await dbOrTx.query.labLocations.findFirst({
          where: and(
            eq(labLocations.id, currentCase.labLocationId),
            eq(labLocations.labOrganizationId, row.labOrganizationId),
          ),
        })
      : null;
    return {
      id: location?.id ?? null,
      name: location?.name ?? fallbackLocationName(status),
      status,
      code: location?.code ?? null,
    };
  }

  if (row.labCaseId) {
    const legacy = await dbOrTx.query.labCases.findFirst({
      where: and(eq(labCases.id, row.labCaseId), isNull(labCases.deletedAt)),
    });
    const blob = parseLegacyBlob(legacy?.caseData);
    const status =
      legacyStatusToCanonical(blob.status, null) ??
      row.resolutionStatus ??
      row.previousStatus ??
      null;
    const savedLocationId =
      typeof blob.labLocationId === "string" && blob.labLocationId
        ? blob.labLocationId
        : null;
    const location = savedLocationId
      ? await dbOrTx.query.labLocations.findFirst({
          where: and(
            eq(labLocations.id, savedLocationId),
            eq(labLocations.labOrganizationId, row.labOrganizationId),
          ),
        })
      : null;
    return {
      id: location?.id ?? null,
      name: location?.name ?? fallbackLocationName(status),
      status,
      code: location?.code ?? null,
    };
  }

  return {
    id: null,
    name: fallbackLocationName(
      row.resolutionStatus ?? row.previousStatus ?? null,
    ),
    status: row.resolutionStatus ?? row.previousStatus ?? null,
    code: null,
  };
}

function legacyPatientNames(blob: Record<string, any>): {
  first: string | null;
  last: string | null;
} {
  const first = blob.patientFirstName ?? null;
  const last = blob.patientLastName ?? null;
  if (first || last) return { first, last };
  const combined =
    typeof blob.patientName === "string" ? blob.patientName.trim() : "";
  if (!combined) return { first: null, last: null };
  const parts = combined.split(/\s+/);
  return {
    first: parts[0] ?? null,
    last: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

/**
 * Resolve a case id to either a canonical `cases` row or a legacy mobile
 * `lab_cases` row, and authorize the viewer as an ACTIVE LAB MEMBER of the
 * owning lab.
 *
 * Exceptions are a lab-internal workflow, so — unlike the case-detail route —
 * there is deliberately no provider/practice fallback here: a provider that
 * can read the case still gets a 403 from every exception endpoint.
 */
async function resolveCaseTargetForLabMember(
  userId: string,
  caseId: string,
): Promise<CaseTarget> {
  const canonical = await db.query.cases.findFirst({
    where: and(eq(cases.id, caseId), isNull(cases.deletedAt)),
  });
  if (canonical) {
    await requireMembership(userId, canonical.labOrganizationId);
    return {
      kind: "canonical",
      caseId: canonical.id,
      labCaseId: null,
      labOrganizationId: canonical.labOrganizationId,
      caseNumber: canonical.caseNumber ?? null,
      patientFirstName: canonical.patientFirstName ?? null,
      patientLastName: canonical.patientLastName ?? null,
      doctorName: canonical.doctorName ?? null,
      status: canonical.status ?? null,
      labLocationId: (canonical as any).labLocationId ?? null,
    };
  }

  const legacy = await db.query.labCases.findFirst({
    where: and(eq(labCases.id, caseId), isNull(labCases.deletedAt)),
  });
  if (!legacy) throw new HttpError(404, "Case not found.");
  if (!legacy.organizationId) {
    throw new HttpError(422, "Case has no associated organization.");
  }
  await requireMembership(userId, legacy.organizationId);

  const blob = parseLegacyBlob(legacy.caseData);
  const { first, last } = legacyPatientNames(blob);
  return {
    kind: "legacy",
    caseId: null,
    labCaseId: legacy.id,
    labOrganizationId: legacy.organizationId,
    caseNumber: blob.caseNumber ?? legacy.id,
    patientFirstName: first,
    patientLastName: last,
    doctorName: blob.doctorName ?? blob.doctor ?? null,
    status: legacyStatusToCanonical(blob.status, null),
    labLocationId:
      typeof blob.labLocationId === "string" && blob.labLocationId
        ? blob.labLocationId
        : null,
  };
}

/** Shape returned to the dashboard queue and the case-detail summary. */
function toSummary(row: any) {
  return {
    id: row.id,
    labOrganizationId: row.labOrganizationId,
    caseId: row.caseId ?? row.labCaseId,
    caseKind: row.caseId ? ("canonical" as const) : ("legacy" as const),
    status: row.status,
    issueText: row.issueText ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdByName: row.createdByName ?? null,
    createdAt: row.createdAt,
    resolvedByUserId: row.resolvedByUserId ?? null,
    resolvedByName: row.resolvedByName ?? null,
    resolvedAt: row.resolvedAt ?? null,
    resolutionNote: row.resolutionNote ?? null,
    resolutionLabLocationId: row.resolutionLabLocationId ?? null,
    resolutionStatus: row.resolutionStatus ?? null,
    previousStatus: row.previousStatus ?? null,
  };
}

/**
 * Load the active exception (if any) for a set of case identities.
 * Exported so `cases.ts` can decorate its detail/list payloads without
 * duplicating the "canonical id OR legacy id" lookup.
 */
export async function fetchActiveExceptionsForCaseIds(
  caseIds: string[],
): Promise<Map<string, ReturnType<typeof toSummary>>> {
  const map = new Map<string, ReturnType<typeof toSummary>>();
  const ids = Array.from(new Set(caseIds.filter(Boolean)));
  if (ids.length === 0) return map;

  const rows = await db
    .select()
    .from(caseExceptions)
    .where(
      and(
        eq(caseExceptions.status, "active"),
        or(
          inArray(caseExceptions.caseId, ids),
          inArray(caseExceptions.labCaseId, ids),
        ),
      ),
    );
  for (const row of rows) {
    const key = row.caseId ?? row.labCaseId;
    if (key) map.set(key, toSummary(row));
  }
  return map;
}

/** Convenience wrapper for the single-case detail route. */
export async function fetchActiveExceptionForCase(caseId: string) {
  const map = await fetchActiveExceptionsForCaseIds([caseId]);
  return map.get(caseId) ?? null;
}

async function loadExceptionOr404(exceptionId: string) {
  const row = await db.query.caseExceptions.findFirst({
    where: eq(caseExceptions.id, exceptionId),
  });
  if (!row) throw new HttpError(404, "Exception not found.");
  return row;
}

// ---------------------------------------------------------------------------
// GET /case-exceptions/active — dashboard queue
// ---------------------------------------------------------------------------
router.get(
  "/active",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const requestedLabId = String(req.query["labOrganizationId"] ?? "").trim();

    let labIds: string[];
    if (requestedLabId) {
      await requireMembership(userId, requestedLabId);
      labIds = [requestedLabId];
    } else {
      labIds = await fetchUserActiveLabIds(userId);
    }
    if (labIds.length === 0) return ok(res, { exceptions: [] });

    const rows = await db
      .select()
      .from(caseExceptions)
      .where(
        and(
          eq(caseExceptions.status, "active"),
          inArray(caseExceptions.labOrganizationId, labIds),
        ),
      )
      .orderBy(desc(caseExceptions.createdAt));

    if (rows.length === 0) return ok(res, { exceptions: [] });

    // Resolve case identity + media presence in bulk — one query per source
    // rather than per row.
    const canonicalIds = rows.map((r) => r.caseId).filter(Boolean) as string[];
    const legacyIds = rows.map((r) => r.labCaseId).filter(Boolean) as string[];
    const exceptionIds = rows.map((r) => r.id);

    const rankedNotes = db
      .select({
        caseExceptionId: caseExceptionNotes.caseExceptionId,
        noteText: caseExceptionNotes.noteText,
        authorName: caseExceptionNotes.authorName,
        createdAt: caseExceptionNotes.createdAt,
        noteCount:
          sql<number>`count(*) over (partition by ${caseExceptionNotes.caseExceptionId})::int`.as(
            "note_count",
          ),
        noteRank: sql<number>`row_number() over (
            partition by ${caseExceptionNotes.caseExceptionId}
            order by ${caseExceptionNotes.createdAt} desc, ${caseExceptionNotes.id} desc
          )::int`.as("note_rank"),
      })
      .from(caseExceptionNotes)
      .where(inArray(caseExceptionNotes.caseExceptionId, exceptionIds))
      .as("ranked_exception_notes");

    const [canonicalRows, legacyRows, mediaRows, noteRows] = await Promise.all([
      canonicalIds.length
        ? db.query.cases.findMany({ where: inArray(cases.id, canonicalIds) })
        : Promise.resolve([] as any[]),
      legacyIds.length
        ? db.query.labCases.findMany({ where: inArray(labCases.id, legacyIds) })
        : Promise.resolve([] as any[]),
      db
        .select({
          caseExceptionId: caseAttachments.caseExceptionId,
          count: sql<number>`count(*)::int`,
        })
        .from(caseAttachments)
        .where(
          and(
            inArray(caseAttachments.caseExceptionId, exceptionIds),
            isNull(caseAttachments.deletedAt),
          ),
        )
        .groupBy(caseAttachments.caseExceptionId),
      db
        .select({
          caseExceptionId: rankedNotes.caseExceptionId,
          noteText: rankedNotes.noteText,
          authorName: rankedNotes.authorName,
          createdAt: rankedNotes.createdAt,
          noteCount: rankedNotes.noteCount,
        })
        .from(rankedNotes)
        .where(eq(rankedNotes.noteRank, 1)),
    ]);

    const canonicalById = new Map(canonicalRows.map((c: any) => [c.id, c]));
    const legacyById = new Map(legacyRows.map((c: any) => [c.id, c]));
    // Both storage formats retain a location id, but only `lab_locations` is
    // authoritative for its name. Fetch these after both case sources so the
    // active queue always reflects later ordinary case movements.
    const liveLocationIds = Array.from(
      new Set(
        [
          ...canonicalRows.map((c: any) => c.labLocationId),
          ...legacyRows.map((c: any) => {
            const id = parseLegacyBlob(c.caseData).labLocationId;
            return typeof id === "string" ? id : null;
          }),
        ].filter(Boolean),
      ),
    ) as string[];
    const locationRows = liveLocationIds.length
      ? await db.query.labLocations.findMany({
          where: inArray(labLocations.id, liveLocationIds),
        })
      : [];
    const locationById = new Map(
      locationRows.map((location: any) => [location.id, location]),
    );
    const mediaCountById = new Map(
      mediaRows.map((r: any) => [r.caseExceptionId as string, Number(r.count)]),
    );
    const latestNoteById = new Map(
      noteRows.map((note) => [note.caseExceptionId, note]),
    );

    const exceptions = rows.map((row) => {
      let caseNumber: string | null = null;
      let patientFirstName: string | null = null;
      let patientLastName: string | null = null;
      let doctorName: string | null = null;
      let caseStatus: string | null = null;
      let currentLocationId: string | null = null;
      let currentLocationName: string | null = null;
      let currentLocationStatus: string | null = null;

      if (row.caseId) {
        const c: any = canonicalById.get(row.caseId);
        if (c) {
          caseNumber = c.caseNumber ?? null;
          patientFirstName = c.patientFirstName ?? null;
          patientLastName = c.patientLastName ?? null;
          doctorName = c.doctorName ?? null;
          caseStatus = c.status ?? null;
          const location = c.labLocationId
            ? locationById.get(c.labLocationId)
            : null;
          // A foreign/stale id must not become a location disclosure.
          if (location?.labOrganizationId === row.labOrganizationId) {
            currentLocationId = location.id;
            currentLocationName = location.name;
          }
          currentLocationStatus = caseStatus;
        }
      } else if (row.labCaseId) {
        const legacy: any = legacyById.get(row.labCaseId);
        if (legacy) {
          const blob = parseLegacyBlob(legacy.caseData);
          const names = legacyPatientNames(blob);
          caseNumber = blob.caseNumber ?? legacy.id;
          patientFirstName = names.first;
          patientLastName = names.last;
          doctorName = blob.doctorName ?? blob.doctor ?? null;
          caseStatus = legacyStatusToCanonical(blob.status, null);
          const savedLocationId =
            typeof blob.labLocationId === "string" ? blob.labLocationId : null;
          const location = savedLocationId
            ? locationById.get(savedLocationId)
            : null;
          if (location?.labOrganizationId === row.labOrganizationId) {
            currentLocationId = location.id;
            currentLocationName = location.name;
          }
          currentLocationStatus = caseStatus;
        }
      }
      currentLocationName ??= fallbackLocationName(currentLocationStatus);

      const mediaCount = mediaCountById.get(row.id) ?? 0;
      const latestNote = latestNoteById.get(row.id);
      return {
        ...toSummary(row),
        caseNumber,
        patientFirstName,
        patientLastName,
        doctorName,
        caseStatus,
        currentLocationId,
        currentLocationName,
        currentLocationStatus,
        mediaCount,
        hasMedia: mediaCount > 0,
        noteCount: latestNote?.noteCount ?? 0,
        latestNoteText: latestNote?.noteText ?? null,
        latestNoteAuthorName: latestNote?.authorName ?? null,
        latestNoteCreatedAt: latestNote?.createdAt ?? null,
      };
    });

    return ok(res, { exceptions });
  }),
);

// ---------------------------------------------------------------------------
// POST /case-exceptions — flag a case
// ---------------------------------------------------------------------------
const createSchema = z
  .object({
    caseId: z.string().min(1),
    issueText: z.string().max(4000).optional(),
    // Older clients did not send a decision and historically always held the
    // case. Keep that wire compatibility while new clients send this explicitly.
    putOnHold: z.boolean().default(true),
    labLocationId: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.putOnHold && !value.labLocationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["labLocationId"],
        message:
          "A current lab location is required when the case is not on hold.",
      });
    }
  });

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const input = createSchema.parse(req.body);

    const target = await resolveCaseTargetForLabMember(userId, input.caseId);

    const existing = await db.query.caseExceptions.findFirst({
      where: and(
        eq(caseExceptions.status, "active"),
        target.kind === "canonical"
          ? eq(caseExceptions.caseId, target.caseId)
          : eq(caseExceptions.labCaseId, target.labCaseId),
      ),
    });
    if (existing) {
      throw new HttpError(409, "This case already has an active exception.");
    }

    const actor = (req as any).user;
    const actorName = displayName(actor);
    const issueText = input.issueText?.trim() || null;

    let created: any;
    let chosenLocation: any;
    let nextStatus!: string;
    try {
      created = await db.transaction(async (tx) => {
        await acquireCaseLocationStatusLock(tx);
        // Lock the case first and derive the snapshot from that locked row.
        // A concurrent normal movement can therefore occur either before this
        // transaction (and be captured below) or after it, never in between
        // the exception snapshot and its move.
        let previousStatus: string | null;
        let previousLabLocationId: string | null;
        let legacyBlob: Record<string, any> | null = null;
        if (target.kind === "canonical") {
          const [liveCase] = await tx
            .select({
              status: cases.status,
              labLocationId: cases.labLocationId,
              labOrganizationId: cases.labOrganizationId,
            })
            .from(cases)
            .where(and(eq(cases.id, target.caseId), isNull(cases.deletedAt)))
            .for("update");
          if (!liveCase || liveCase.labOrganizationId !== target.labOrganizationId) {
            throw new HttpError(409, "This case is no longer available.");
          }
          previousStatus = liveCase.status ?? null;
          previousLabLocationId = liveCase.labLocationId ?? null;
        } else {
          const [liveLegacy] = await tx
            .select({
              caseData: labCases.caseData,
              organizationId: labCases.organizationId,
            })
            .from(labCases)
            .where(
              and(eq(labCases.id, target.labCaseId), isNull(labCases.deletedAt)),
            )
            .for("update");
          if (!liveLegacy || liveLegacy.organizationId !== target.labOrganizationId) {
            throw new HttpError(409, "This case is no longer available.");
          }
          legacyBlob = parseLegacyBlob(liveLegacy.caseData);
          previousStatus = legacyStatusToCanonical(legacyBlob.status, null);
          previousLabLocationId =
            typeof legacyBlob.labLocationId === "string" && legacyBlob.labLocationId
              ? legacyBlob.labLocationId
              : null;
        }

        // Lock and validate the station in the same transaction. This guards
        // against an administrator deactivating or moving a location between
        // request validation and the exception write.
        //
        // Locations are normally seeded by GET /locations. Preserve that lazy
        // provisioning for a legacy/default hold request, but do it here when
        // this lab has no rows so the hold move is still atomic. Never seed in
        // response to an explicit location id: that must remain a real,
        // active, tenant-owned station.
        if (input.putOnHold) {
          const existingLocations = await tx
            .select({ id: labLocations.id })
            .from(labLocations)
            .where(eq(labLocations.labOrganizationId, target.labOrganizationId))
            .limit(1);
          if (existingLocations.length === 0) {
            await tx
              .insert(labLocations)
              .values(
                BUILT_IN_LAB_STATIONS.map((station, index) => ({
                  labOrganizationId: target.labOrganizationId,
                  ...station,
                  isActive: true,
                  sortOrder: index,
                })),
              )
              .onConflictDoNothing();
          }
        }
        const [lockedLocation] = await tx
          .select()
          .from(labLocations)
          .where(
            and(
              eq(labLocations.labOrganizationId, target.labOrganizationId),
              eq(labLocations.isActive, true),
              input.putOnHold
                ? eq(labLocations.status, EXCEPTION_HOLD_STATUS)
                : eq(labLocations.id, input.labLocationId!),
            ),
          )
          .orderBy(asc(labLocations.sortOrder), asc(labLocations.createdAt))
          .for("update");
        if (!lockedLocation) {
          throw new HttpError(
            400,
            input.putOnHold
              ? "The lab does not have an active On Hold location."
              : "The selected location must be an active location in this lab.",
          );
        }
        chosenLocation = lockedLocation;
        nextStatus = input.putOnHold
          ? EXCEPTION_HOLD_STATUS
          : (lockedLocation.status as string);

        const [exceptionRow] = await tx
          .insert(caseExceptions)
          .values({
            labOrganizationId: target.labOrganizationId,
            caseId: target.caseId,
            labCaseId: target.labCaseId,
            status: "active",
            issueText,
            previousStatus,
            previousLabLocationId,
            createdByUserId: userId,
            createdByName: actorName,
          })
          .returning();

        if (target.kind === "canonical") {
          await tx
            .update(cases)
            .set({
              status: nextStatus,
              labLocationId: chosenLocation.id,
              casePanBarcode: nextStatus === "complete" ? null : undefined,
              updatedAt: new Date(),
            })
            .where(eq(cases.id, target.caseId));

          await tx.insert(caseLocations).values({
            caseId: target.caseId,
            locationCode: chosenLocation.code,
            locationName: chosenLocation.name,
            movedByUserId: userId,
            // Deliberately neutral: `case_locations` and `case_events` are
            // provider-visible, while exception text is lab-internal. The raw
            // issue lives only in `case_exceptions` behind the lab gate.
            notes: "Exception created",
          });

          await tx.insert(caseEvents).values({
            caseId: target.caseId,
            eventType: "case_exception_opened",
            actorUserId: userId,
            actorOrganizationId: target.labOrganizationId,
            actorInitials: actor?.initials || "SYS",
            // No `issueText` here — this event is served to providers.
            metadataJson: {
              exceptionId: exceptionRow.id,
              fromStatus: previousStatus,
              toStatus: nextStatus,
              locationName: chosenLocation.name,
              locationCode: chosenLocation.code,
            },
          });
          if (issueText) {
            await tx.insert(caseEvents).values({
              caseId: target.caseId,
              eventType: "internal_exception_opened_note",
              actorUserId: userId,
              actorOrganizationId: target.labOrganizationId,
              actorInitials: actor?.initials || "SYS",
              metadataJson: {
                exceptionId: exceptionRow.id,
                noteText: issueText,
                authorName: actorName,
                visibility: "internal_lab_only",
                internalException: true,
              },
            });
          }
        } else {
          const blob = legacyBlob!;
          blob.status = canonicalStatusToLegacy(nextStatus);
          blob.labLocationId = chosenLocation.id;
          if (nextStatus === "complete") blob.assignedBarcode = null;
          if (!Array.isArray(blob.activityLog)) blob.activityLog = [];
          blob.activityLog.push({
            id: exceptionRow.id,
            type: "exception_opened",
            timestamp: Date.now(),
            user: actor?.initials || "",
            note: "Exception created",
          });
          if (issueText) {
            blob.activityLog.push({
              id: `${exceptionRow.id}:opened-note`,
              type: "internal_exception_opened_note",
              timestamp: Date.now(),
              user: actor?.initials || "",
              authorName: actorName,
              noteText: issueText,
              internalException: true,
            });
          }
          await tx
            .update(labCases)
            .set({ caseData: JSON.stringify(blob), updatedAt: new Date() })
            .where(eq(labCases.id, target.labCaseId));
        }

        return exceptionRow;
      });
    } catch (err) {
      // The partial unique indexes are the real duplicate guard — the
      // pre-check above only produces a friendlier message when there is no
      // race.
      if (extractPgCode(err) === "23505") {
        throw new HttpError(409, "This case already has an active exception.");
      }
      if (err instanceof HttpError) throw err;
      logger.error({ err }, "Failed to create case exception");
      throw new HttpError(
        500,
        "Failed to create this exception case. Please try again.",
      );
    }

    if (target.kind === "canonical") {
      broadcastCaseUpdated(target.caseId, "exception_opened");
    }

    await deliverInAppNotification({
      labOrganizationId: target.labOrganizationId,
      category: "exception_case",
      type: "case_exception_created",
      title: `Case exception: ${target.caseNumber}`,
      body: input.putOnHold
        ? `Case ${target.caseNumber} was moved to On Hold for lab review.`
        : `Case ${target.caseNumber} has an exception at ${chosenLocation.name}.`,
      dataJson: {
        caseId: target.caseId ?? target.labCaseId,
        caseNumber: target.caseNumber,
        exceptionId: created.id,
      },
    });

    return ok(
      res,
      {
        ...toSummary(created),
        caseNumber: target.caseNumber,
        patientFirstName: target.patientFirstName,
        patientLastName: target.patientLastName,
        doctorName: target.doctorName,
        caseStatus: nextStatus,
        currentLocationId: chosenLocation.id,
        currentLocationName: chosenLocation.name,
        currentLocationStatus: nextStatus,
        mediaCount: 0,
        hasMedia: false,
        noteCount: 0,
      },
      201,
    );
  }),
);

// ---------------------------------------------------------------------------
// GET /case-exceptions/:exceptionId — detail (lab members only)
// ---------------------------------------------------------------------------
router.get(
  "/:exceptionId",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const row = await loadExceptionOr404(req.params.exceptionId as string);
    await requireMembership(userId, row.labOrganizationId);

    const caseIdentity = row.caseId ?? row.labCaseId ?? null;

    const [noteRows, attachmentRows] = await Promise.all([
      db.query.caseExceptionNotes.findMany({
        where: eq(caseExceptionNotes.caseExceptionId, row.id),
        orderBy: [asc(caseExceptionNotes.createdAt)],
      }),
      db.query.caseAttachments.findMany({
        where: and(
          eq(caseAttachments.caseExceptionId, row.id),
          isNull(caseAttachments.deletedAt),
        ),
        orderBy: [desc(caseAttachments.createdAt)],
      }),
    ]);

    const uploaderIds = Array.from(
      new Set(
        attachmentRows.map((a: any) => a.uploadedByUserId).filter(Boolean),
      ),
    ) as string[];
    const uploaderRows = uploaderIds.length
      ? await db.query.users.findMany({ where: inArray(users.id, uploaderIds) })
      : [];
    const uploaderById = new Map(uploaderRows.map((u: any) => [u.id, u]));

    const allAttachments = attachmentRows.map((a: any) => ({
      ...a,
      uploaderName: displayName(uploaderById.get(a.uploadedByUserId) as any),
    }));
    const noteAttachments = new Map<string, typeof allAttachments>();
    for (const attachment of allAttachments) {
      if (!attachment.caseExceptionNoteId) continue;
      const current = noteAttachments.get(attachment.caseExceptionNoteId) ?? [];
      current.push(attachment);
      noteAttachments.set(attachment.caseExceptionNoteId, current);
    }
    const notes = noteRows.map((note: any) => ({
      ...note,
      attachments: noteAttachments.get(note.id) ?? [],
    }));
    const attachments = allAttachments.filter(
      (attachment: any) => !attachment.caseExceptionNoteId,
    );

    // Lifecycle timeline, newest first. Derived from the exception row plus
    // its own notes/media so canonical and legacy cases produce an identical
    // history without depending on `case_events` (which legacy cases lack).
    const history: Array<{
      type: string;
      occurredAt: Date | string | null;
      actorName: string | null;
      detail: string | null;
    }> = [
      {
        type: "opened",
        occurredAt: row.createdAt,
        actorName: row.createdByName ?? null,
        detail: row.issueText ?? null,
      },
      ...noteRows.map((n: any) => ({
        type: "note_added" as const,
        occurredAt: n.createdAt,
        actorName: n.authorName ?? null,
        detail: n.noteText as string,
      })),
      ...attachments.map((a: any) => ({
        type: "media_added" as const,
        occurredAt: a.createdAt,
        actorName: a.uploaderName ?? null,
        detail: a.fileName as string,
      })),
    ];
    if (row.status === "resolved") {
      history.push({
        type: "resolved",
        occurredAt: row.resolvedAt,
        actorName: row.resolvedByName ?? null,
        detail: row.resolutionNote ?? null,
      });
    }
    history.sort(
      (a, b) =>
        new Date(b.occurredAt ?? 0).getTime() -
        new Date(a.occurredAt ?? 0).getTime(),
    );

    const viewerCanResolve = await isOwnerOrAdmin(
      userId,
      row.labOrganizationId,
    );
    let currentLocation = await loadCurrentCaseLocation(row);

    return ok(res, {
      ...toSummary(row),
      caseId: caseIdentity,
      currentLocationId: currentLocation.id,
      currentLocationName: currentLocation.name,
      currentLocationStatus: currentLocation.status,
      notes,
      attachments,
      history,
      viewerCanResolve,
    });
  }),
);

async function isOwnerOrAdmin(
  userId: string,
  labOrganizationId: string,
): Promise<boolean> {
  const membership = await db.query.organizationMemberships.findFirst({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.labId, labOrganizationId),
      eq(organizationMemberships.status, "active"),
      isNull(organizationMemberships.deletedAt),
    ),
  });
  return !!membership && ADMIN_ROLES.includes(membership.role as any);
}

// ---------------------------------------------------------------------------
// POST /case-exceptions/:exceptionId/notes — internal discussion
// ---------------------------------------------------------------------------
const noteSchema = z.object({
  noteText: z.string().trim().min(1).max(4000),
  attachments: z
    .array(
      z.object({
        storageKey: z.string().min(1).max(2048),
        fileName: z.string().min(1).max(255),
        fileType: z.string().min(1).max(255),
      }),
    )
    .max(20)
    .default([]),
});

router.post(
  "/:exceptionId/notes",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const row = await loadExceptionOr404(req.params.exceptionId as string);

    await requireMembership(userId, row.labOrganizationId);

    if (row.status !== "active") {
      throw new HttpError(409, "This exception has already been resolved.");
    }

    const input = noteSchema.parse(req.body);
    const actor = (req as any).user;
    const actorName = displayName(actor);

    const note = await db.transaction(async (tx) => {
      // Serialize against resolution. The preflight check above gives the
      // common path a clear early response, while this locked re-check closes
      // the race where resolution commits between that read and this insert.
      const [lockedException] = await tx
        .select({ status: caseExceptions.status })
        .from(caseExceptions)
        .where(eq(caseExceptions.id, row.id))
        .for("update");
      if (lockedException?.status !== "active") {
        throw new HttpError(409, "This exception has already been resolved.");
      }

      const [created] = await tx
        .insert(caseExceptionNotes)
        .values({
          caseExceptionId: row.id,
          authorUserId: userId,
          authorName: actorName,
          noteText: input.noteText,
        })
        .returning();

      const createdAttachments = input.attachments.length
        ? await tx
            .insert(caseAttachments)
            .values(
              input.attachments.map((attachment) => ({
                ...(row.caseId ? { caseId: row.caseId } : {}),
                ...(row.labCaseId ? { labCaseId: row.labCaseId } : {}),
                uploadedByUserId: userId,
                uploadedByOrganizationId: row.labOrganizationId,
                fileName: attachment.fileName,
                storageKey: attachment.storageKey,
                fileType: attachment.fileType,
                visibility: "internal_lab_only",
                caseExceptionId: row.id,
                caseExceptionNoteId: created.id,
              })),
            )
            .returning()
        : [];

      // Legacy case media downloads are authorized by a first-writer-wins
      // filename ledger. Register the uploaded objects in the same transaction
      // as their note and attachment rows.
      if (row.labCaseId && createdAttachments.length > 0) {
        const legacyRow = await tx.query.labCases.findFirst({
          where: eq(labCases.id, row.labCaseId),
        });
        const mediaEntries = createdAttachments.flatMap((attachment: any) => {
          const fileName = extractMediaFileName(attachment.storageKey);
          return fileName
            ? [
                {
                  fileName,
                  labCaseId: row.labCaseId!,
                  organizationId: row.labOrganizationId,
                  ownerId: legacyRow?.ownerId ?? userId,
                },
              ]
            : [];
        });
        if (mediaEntries.length > 0) {
          await tx
            .insert(legacyCaseMedia)
            .values(mediaEntries)
            .onConflictDoNothing();
        }
      }

      await tx
        .update(caseExceptions)
        .set({ updatedAt: new Date() })
        .where(eq(caseExceptions.id, row.id));

      if (row.caseId) {
        await tx.insert(caseEvents).values({
          caseId: row.caseId,
          eventType: "internal_exception_note_added",
          actorUserId: userId,
          actorOrganizationId: row.labOrganizationId,
          actorInitials: actor?.initials || "SYS",
          metadataJson: {
            exceptionId: row.id,
            exceptionNoteId: created.id,
            noteText: created.noteText,
            authorName: actorName,
            visibility: "internal_lab_only",
            internalException: true,
            attachmentIds: createdAttachments.map(
              (attachment: any) => attachment.id,
            ),
          },
        });
      } else if (row.labCaseId) {
        // This is a whole-blob read/append/write. Lock it before parsing so
        // concurrent legacy activity writers cannot overwrite this entry.
        const [legacyRow] = await tx
          .select({ caseData: labCases.caseData })
          .from(labCases)
          .where(eq(labCases.id, row.labCaseId))
          .for("update");
        const blob = parseLegacyBlob(legacyRow?.caseData);
        if (!Array.isArray(blob.activityLog)) blob.activityLog = [];
        blob.activityLog.push({
          id: `exception-note-${created.id}`,
          type: "internal_exception_note_added",
          timestamp: Date.now(),
          user: actor?.initials || "",
          authorName: actorName,
          noteText: created.noteText,
          internalException: true,
          attachments: createdAttachments.map((attachment: any) => ({
            id: attachment.id,
            fileName: attachment.fileName,
            fileType: attachment.fileType,
          })),
        });
        await tx
          .update(labCases)
          .set({ caseData: JSON.stringify(blob), updatedAt: new Date() })
          .where(eq(labCases.id, row.labCaseId));
      }

      return {
        ...created,
        attachments: createdAttachments.map((attachment: any) => ({
          ...attachment,
          uploaderName: actorName,
        })),
      };
    });

    return ok(res, note, 201);
  }),
);

// ---------------------------------------------------------------------------
// POST /case-exceptions/:exceptionId/resolve — owner/admin only
// ---------------------------------------------------------------------------
// The resolution note is mandatory: an exception may only be closed with a
// record of how it was resolved. Parsed as optional here so a missing/blank
// note produces the explicit message below rather than the generic
// "Invalid request." the ZodError handler emits.
const resolveSchema = z.object({
  labLocationId: z.string().min(1).optional(),
  resolutionNote: z.string().max(4000).optional(),
});

const RESOLUTION_NOTE_REQUIRED =
  "A resolution note is required to resolve an exception.";

router.post(
  "/:exceptionId/resolve",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const row = await loadExceptionOr404(req.params.exceptionId as string);

    // Resolution is owner/admin only — creation and review are open to every
    // active lab member.
    await requireAnyRole(userId, row.labOrganizationId, ADMIN_ROLES);

    if (row.status !== "active") {
      throw new HttpError(409, "This exception has already been resolved.");
    }

    const input = resolveSchema.parse(req.body);
    const resolutionNote = input.resolutionNote?.trim() || "";
    if (!resolutionNote) {
      throw new HttpError(400, RESOLUTION_NOTE_REQUIRED);
    }
    let destination: any = null;
    const actor = (req as any).user;
    const actorName = displayName(actor);
    let currentLocation = await loadCurrentCaseLocation(row);
    let nextStatus!: string;
    // A legacy blob can only store its durable token. Decode that exact token
    // for the exception summary too, so its displayed status matches the
    // standard legacy case list/detail (for example, legacy COMPLETE also
    // represents a selected Delivered station).
    let resolvedStatus!: string;
    const resolvedAt = new Date();

    let resolved: any;
    try {
      resolved = await db.transaction(async (tx) => {
        await acquireCaseLocationStatusLock(tx);
        if (input.labLocationId) {
          const [lockedDestination] = await tx
            .select()
            .from(labLocations)
            .where(
              and(
                eq(labLocations.id, input.labLocationId),
                eq(labLocations.labOrganizationId, row.labOrganizationId),
              ),
            )
            .for("update");
          if (!lockedDestination) {
            throw new HttpError(400, "Choose a destination location for this lab.");
          }
          destination = lockedDestination;
        } else {
          currentLocation = await loadCurrentCaseLocation(row, tx);
        }
        nextStatus = destination?.status ?? currentLocation.status;
        if (!nextStatus) {
          throw new HttpError(409, "This case has no current status to preserve.");
        }
        resolvedStatus = row.labCaseId
          ? legacyStatusToCanonical(canonicalStatusToLegacy(nextStatus), nextStatus)
          : nextStatus;

        const [updated] = await tx
          .update(caseExceptions)
          .set({
            status: "resolved",
            resolvedByUserId: userId,
            resolvedByName: actorName,
            resolvedAt,
            resolutionNote,
            resolutionLabLocationId: destination?.id ?? null,
            resolutionStatus: resolvedStatus,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(caseExceptions.id, row.id),
              eq(caseExceptions.status, "active"),
            ),
          )
          .returning();
        if (!updated) {
          throw new HttpError(409, "This exception has already been resolved.");
        }

        if (row.caseId) {
          if (destination) {
            await tx
              .update(cases)
              .set({
                status: nextStatus,
                labLocationId: destination.id,
                casePanBarcode: nextStatus === "complete" ? null : undefined,
                updatedAt: new Date(),
              })
              .where(eq(cases.id, row.caseId));

            await tx.insert(caseLocations).values({
              caseId: row.caseId,
              locationCode: destination.code,
              locationName: destination.name,
              movedByUserId: userId,
              // Neutral for the same reason as the opening move above.
              notes: "Exception resolved",
            });
          }

          await tx.insert(caseEvents).values({
            caseId: row.caseId,
            eventType: "case_exception_resolved",
            actorUserId: userId,
            actorOrganizationId: row.labOrganizationId,
            actorInitials: actor?.initials || "SYS",
            metadataJson: {
              exceptionId: row.id,
              fromStatus: EXCEPTION_HOLD_STATUS,
              toStatus: nextStatus,
              locationName: destination?.name ?? currentLocation.name,
              ...((destination?.code ?? currentLocation.code)
                ? {
                    locationCode: destination?.code ?? currentLocation.code,
                  }
                : {}),
            },
          });
          await tx.insert(caseEvents).values({
            caseId: row.caseId,
            eventType: "internal_exception_resolution_note_added",
            actorUserId: userId,
            actorOrganizationId: row.labOrganizationId,
            actorInitials: actor?.initials || "SYS",
            metadataJson: {
              exceptionId: row.id,
              noteText: resolutionNote,
              authorName: actorName,
              visibility: "internal_lab_only",
              internalException: true,
            },
          });
        } else if (row.labCaseId) {
          // This is a whole-blob read/append/write. Lock it before parsing so
          // concurrent legacy activity writers cannot overwrite this entry.
          const [legacyRow] = await tx
            .select({ caseData: labCases.caseData })
            .from(labCases)
            .where(eq(labCases.id, row.labCaseId))
            .for("update");
          const blob = parseLegacyBlob(legacyRow?.caseData);
          if (destination) {
            blob.status = canonicalStatusToLegacy(nextStatus);
            blob.labLocationId = destination.id;
            if (nextStatus === "complete") blob.assignedBarcode = null;
          }
          if (!Array.isArray(blob.activityLog)) blob.activityLog = [];
          blob.activityLog.push({
            id: row.id,
            type: "exception_resolved",
            timestamp: Date.now(),
            user: actor?.initials || "",
            note: destination
              ? `Exception resolved — moved to ${destination.name}`
              : `Exception resolved — case stayed at ${currentLocation.name}`,
          });
          blob.activityLog.push({
            id: `${row.id}:resolution-note`,
            type: "internal_exception_resolution_note_added",
            timestamp: resolvedAt.getTime(),
            user: actor?.initials || "",
            authorName: actorName,
            noteText: resolutionNote,
            internalException: true,
          });
          await tx
            .update(labCases)
            .set({ caseData: JSON.stringify(blob), updatedAt: new Date() })
            .where(eq(labCases.id, row.labCaseId));
        }

        return updated;
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      logger.error({ err }, "Failed to resolve case exception");
      throw new HttpError(
        500,
        "Failed to resolve this exception. Please try again.",
      );
    }

    if (row.caseId) {
      broadcastCaseUpdated(row.caseId, "exception_resolved");
    }

    return ok(res, {
      ...toSummary(resolved),
      destinationLocationName: destination?.name ?? null,
      destinationStatus: resolvedStatus,
    });
  }),
);

export default router;
