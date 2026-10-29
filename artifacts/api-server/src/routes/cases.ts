import { productionMediaDiskStorage } from "../lib/production-media-multipart";
import { moveProductionUpload, writeProductionUpload } from "../lib/production-media-local-write";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Router, type Request, type Response } from "express";
import {
  IMPLANT_RETENTIONS,
  IMPLANT_MANUFACTURERS,
  IMPLANT_FIELDS,
  deriveCaseHierarchy,
  encodeRestorationSubtype,
  parseConnectorState,
  validateToothConnectors,
  expandToothAssignmentIdentifiers,
  withPonticConnectorSuggestions,
  serializeConnectorState,
  updateConnectorChoices,
  normalizeLegacyDesktopConnectorEcho,
} from "@workspace/case-taxonomy";
import { and, asc, count, desc, eq, getTableColumns, gte, ilike, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  UpdateCaseRestorationHierarchy200Response,
  UpdateCaseRestorationHierarchyBody,
  GetCasesOverview200Response,
  GetCasesOverviewQueryParams,
  ListCaseSavedViewsQueryParams,
  ListCaseSavedViews200Response,
  CreateCaseSavedViewBody,
  CreateCaseSavedView201Response,
  RenameCaseSavedViewParams,
  RenameCaseSavedViewBody,
  RenameCaseSavedView200Response,
  DeleteCaseSavedViewParams,
  DeleteCaseSavedViewQueryParams,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  auditLogs,
  caseAttachments,
  caseEvents,
  caseExceptions,
  caseLocations,
  caseNotes,
  caseRestorations,
  caseSubmissionQueue,
  bankTransactionInvoices,
  caseSavedViews,
  cases,
  doctorProfiles,
  invoiceLineItems,
  invoices,
  iteroImportedOrders,
  iteroImportSessions,
  labCases,
  labLocations,
  legacyCaseMedia,
  notifications,
  organizationConnections,
  organizationMemberships,
  organizations,
  systemSettings,
  scanJobs,
  users,
} from "@workspace/db";
import multer from "multer";
import { randomBytes, randomUUID } from "node:crypto";
import OpenAI from "openai";
import AdmZip from "adm-zip";
import { writeAuditLog, writeAuditLogTx } from "../lib/audit";
import {
  isValidDueTime,
  resolveAiIntakePrescriptionDueDate,
  resolveCaseDueDate,
} from "../lib/case-due-date";
import { getCasesOverview } from "../lib/cases-overview";
import caseDoctorReassignmentRouter from "./case-doctor-reassignment";
import { caseToothChartRouter } from "./case-tooth-chart";
import { calculateLineTotal, sumMoney } from "../lib/case";
import { syncInvoiceFromRestorations, syncInvoiceFromRestorationsDetailed, buildGroupedLineItemsForInvoice, toInvoiceLineItemValues, insertGroupedLineItemsWithChildren, sumGroupedLineItemsTotal, type InvoiceSyncExecutor } from "../lib/invoice-sync";
import {
  addAlloyChargeToCase,
  removeAlloyChargeFromCase,
  resolveAlloyPricePreview,
  setAlloyPriceForCase,
  setRestorationPriceForCase,
} from "../lib/alloy-charge";
import { invoiceDueDate } from "../lib/invoice-due-date";
import { formatNumericDate } from "../lib/date-format";
import {
  calendarDateToUtcNoon,
  isValidCalendarDate,
} from "@workspace/calendar-date";
import {
  REMAKE_REASON_KEYS,
  CUSTOM_REMAKE_REASON_MAX_LENGTH,
  getRemakeReason,
  type RemakeReasonKey,
} from "@workspace/case-taxonomy";
import {
  classifyMatch,
  splitDisplayName,
  type SimilarityMatchKind,
} from "../lib/patient-similarity";
import { notDeleted, restoreDeleted, softDeleteById } from "../lib/soft-delete";
import { softDeleteLegacyCases } from "../lib/legacy-case-delete.js";
import { convertPdfBufferToImageDataUrls } from "../lib/pdf-to-images";
import { boundedOperation } from "../lib/bounded-operation";
import { caseMediaDir, extractMediaFileName } from "../lib/case-media";
import {
  openCaseMediaObjectStream,
  writeCaseMediaToObjectStorage,
} from "../lib/case-media-object-storage";
import { extractPgConstraintName, HttpError, ok, wrapDbError } from "../lib/http";
import { invoiceSharesNotesWithProvider } from "../lib/invoice-note-visibility";
import { declaredPlyTexture, pairPlyTextures } from "../lib/ply-texture";
import { pageRows, parsePagination } from "../lib/pagination";
import { broadcastCaseUpdated, issueCaseWsTicket } from "../lib/case-events-ws";
import {
  canonicalStatusToLegacy,
  legacyStatusToCanonical,
} from "../lib/case-status";

function isSafeArchiveEntryName(name: string): boolean {
  if (!name || name.includes("\0") || name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(name)) {
    return false;
  }
  return !name.split(/[\\/]+/).some((part) => part === "..");
}

import {
  buildArrayLegacyRow,
  buildWorklistLegacyRow,
  buildWorklistUnreadableLegacyRow,
  legacyCaseBlobColumns,
  legacyCaseListColumns,
  legacyDoctorNameSql,
  legacyUtcCalendarDate,
  legacyWorklistCandidateSql,
  resolveLegacyProjection,
  unprojectedLegacyProbeSql,
  type LegacyCaseListRow,
} from "../lib/legacy-case-list";
import {
  acquireCaseLocationStatusLock,
  LOCATABLE_CASE_STATUSES,
  resolveLocatedCaseStatus,
} from "../lib/case-location-status";
import {
  buildLineItemDescription,
  fetchLabItemLabels,
  normalizeMaterialName,
  resolveAllPricesForContext,
  resolveItemLabelFromMap,
  resolveServerPriceWithSource,
  type ResolvedItemRow,
} from "../lib/pricing";
import { resolveRestorationPriceKey } from "../lib/restoration-pricing";
import { ARCH_VALUES, archLabel, isArchApplicable, normalizeArch, type Arch } from "../lib/arch-billing";
import { isPfmOrFcmMaterial, isPfzMaterial, LAYERED_PORCELAIN_DESCRIPTION, LAYERED_PORCELAIN_SURCHARGE } from "../lib/material-mapping";
import { classifyCase, classifyLegacyCase, normalizeCaseHierarchy } from "../lib/case-category";
import { mapAiRemovableSubtype, isAmbiguousRemovableSubtype } from "../lib/ai-removable-subtype.js";
import { ADMIN_ROLES, BILLING_ROLES, hasCapability, requireAnyRole, requireCapability, requireMembership } from "../lib/rbac";
import {
  fetchActiveExceptionForCase,
  fetchActiveExceptionsForCaseIds,
  INTERNAL_EXCEPTION_HISTORY_EVENT_TYPES,
} from "./case-exceptions";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth, requireVerifiedAccount } from "../middlewares/auth";
import {
  getProviderOrgIdsForUserAndLinks,
  getLinkedProviderOrgsForProviderOrg,
} from "../lib/cross-lab-doctor";
import { signDeleteSessionToken, verifyDeleteSessionToken } from "../lib/auth.js";
import {
  createVerificationCode,
  invalidateVerificationCode,
  normalizeEmailTarget,
  verifyCode,
} from "../lib/verification.js";
import { normalizePhoneE164 } from "../lib/account-link-sms.js";
import {
  formatDoctorPreferences,
  type DoctorPreferences,
} from "../lib/doctor-preferences";
import { getEffectiveAdminPinAsync } from "../lib/admin-pin.js";
import { deliverInAppNotification } from "../lib/in-app-notifications";
import {
  linkedProviderHasCapability,
  assertProviderOrganizationCapability,
  requireLinkedProviderCapability,
} from "../lib/provider-capabilities";
import {
  getActiveProviderOrganizations,
  requireSelectedProviderOrganization,
} from "../lib/provider-selection";

// ---------------------------------------------------------------------------
// Doctor-name fuzzy-matching helpers. Shared with the doctors route (duplicate
// clusters + merge) so the pre-create duplicate check, the duplicate-clusters
// panel, and the AI "Did you mean?" suggestion path all use identical matching.
// Aliased to the historical names to keep existing call sites unchanged.
// ---------------------------------------------------------------------------
import {
  normalizeDoctorForCompare,
  normalizeDoctorForCompare as _normalizeDoctorForSim,
  doctorNameSimilarity as _bigramSimilarity,
  resolveLabDupThreshold,
} from "../lib/doctor-similarity.js";
import { resolveDoctorName } from "../lib/doctor-resolve";
import { ensureDoctorProfileIdentity } from "../lib/doctor-profile-identity";
import { CaseInvoiceConflictError, insertOrResolveAiIntakeInvoice } from "../lib/ai-intake-invoice";
import {
  appendRxNoteEntry,
  listRxNoteEntries,
  saveActiveRxNote,
} from "../lib/rx-note-history";

// ---------------------------------------------------------------------------
// Practice-name normalization for similarity matching.
//
// iTero (and other brand-aggregator) imports produce practice names with a
// leading brand/lab prefix and a trailing bracketed code, e.g.
//   "Sample Dental Group - Riverbend Family Dental [101]"
// while the same practice created manually is just
//   "Riverbend Family Dental".
// Stripping the brand prefix (everything up to and including the first " - ")
// and any trailing bracketed code(s) before bigram scoring lets the importer
// link to the existing practice instead of spawning a duplicate. Kept in sync
// with `normalizePracticeNameForCompare` in the desktop Practices page.
// ---------------------------------------------------------------------------
export function _normalizePracticeForSim(name: string): string {
  let s = (name ?? "").toLowerCase();
  // Strip trailing bracketed import code(s) like "[565]" or "[a12]" (repeat for
  // multiples). Conservative: only strip codes that are a single
  // alphanumeric/dash token containing at least one digit, so descriptive
  // qualifiers like "[East]" / "[West]" (which distinguish real practices) are
  // preserved and do not collapse distinct names.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\s*\[[a-z0-9-]*\d[a-z0-9-]*\]\s*$/, "");
  } while (s !== prev);
  // Strip a leading brand/lab prefix terminated by " - ".
  const sepIdx = s.indexOf(" - ");
  if (sepIdx !== -1) {
    const after = s.slice(sepIdx + 3).trim();
    if (after) s = after;
  }
  return s
    .replace(
      /\b(dental|dentistry|the|of|llc|llp|pllc|pc|pa|inc|ltd|co|practice|office|associates)\b/g,
      "",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function _practiceBigramSimilarity(a: string, b: string): number {
  const an = _normalizePracticeForSim(a);
  const bn = _normalizePracticeForSim(b);
  if (!an || !bn) return 0;
  if (an === bn) return 1;
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    const p = ` ${s} `;
    for (let i = 0; i < p.length - 1; i++) set.add(p.slice(i, i + 2));
    return set;
  };
  const A = bigrams(an);
  const B = bigrams(bn);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Given a lab org ID and a practice name string extracted by AI from an Rx,
 * returns the ID of the best-matching provider organization in the lab whose
 * name has bigram similarity >= 0.5 with `practiceName`, or null if none
 * qualifies. Doctor-name matching always takes priority over this; callers
 * should only invoke this when suggestedProviderOrgId is still null.
 */
export async function _findProviderOrgByPracticeName(
  labOrganizationId: string,
  practiceName: string
): Promise<string | null> {
  const trimmed = practiceName.trim();
  if (!trimmed) return null;

  const providerOrgs = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(
      and(
        eq(organizations.type, "provider"),
        eq(organizations.parentLabOrganizationId, labOrganizationId),
        notDeleted(organizations)
      )
    );

  let bestSim = 0;
  let bestId: string | null = null;
  for (const org of providerOrgs) {
    const sim = _practiceBigramSimilarity(trimmed, org.name);
    if (sim >= 0.5 && sim > bestSim) {
      bestSim = sim;
      bestId = org.id;
    }
  }
  return bestId;
}

const router = Router();
const implantInputFields = {
  implantRetention: z.enum(IMPLANT_RETENTIONS).nullable().optional(),
  implantManufacturer: z.enum(IMPLANT_MANUFACTURERS).nullable().optional(),
  implantPlatformNotes: z.string().max(10000).nullable().optional(),
};
function implantValues(row: Record<string, any>) {
  return Object.fromEntries(IMPLANT_FIELDS.map((key) => [key, row[key] ?? null]));
}

async function expandPersistedBothArchRows(tx: any, caseId: string): Promise<void> {
  const rows = await tx.query.caseRestorations.findMany({
    where: and(eq(caseRestorations.caseId, caseId), eq(caseRestorations.arch, "upper_lower")),
  });
  for (const row of rows) {
    await tx.update(caseRestorations).set({ arch: "upper" }).where(eq(caseRestorations.id, row.id));
    await tx.insert(caseRestorations).values({
      caseId: row.caseId,
      toothNumber: row.toothNumber,
      restorationType: row.restorationType,
      restorationSubtype: row.restorationSubtype,
      ...implantValues(row),
      arch: "lower",
      material: row.material,
      shade: row.shade,
      notes: row.notes,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      priceSource: row.priceSource,
      priceSourceId: row.priceSourceId,
      priceSourceName: row.priceSourceName,
      priceKey: row.priceKey,
    });
  }
}
router.use(requireAuth);
router.use(requireVerifiedAccount);
router.use(asyncHandler(async (req, _res, next) => {
  if ((req as any).user?.userType === "provider") {
    const org = await requireSelectedProviderOrganization(
      (req as any).auth.userId as string,
      req.header("x-provider-organization-id"),
    );
    (req as any).providerOrganizationId = org.id;
  }
  next();
}));
// A provider plan gates only provider subjects; all lab/admin case routes
// preserve their existing role authorization. Basic/Standard get only reads.
router.use(caseDoctorReassignmentRouter);
router.use(caseToothChartRouter({
  access: assertCaseAccessOrPromote, broadcast: broadcastCaseUpdated,
  calendarDate: parseCalendarDate,
  applyHierarchy: async (req, body, executor) => {
    const scopedRequest = Object.assign(Object.create(req), { body }) as Request;
    const scopedResponse = { status() { return this; }, json() {} } as unknown as Response;
    await updateCaseRestorationHierarchy(scopedRequest, scopedResponse, executor, true);
  },
}));

// Derive the set of doctor names that "belong" to a given (lab, provider)
// org pair so legacy `lab_cases` rows (which only carry a free-form
// `doctorName` string and no providerOrganizationId column) can be scoped
// to the same provider when matching/linking. We pull distinct doctor
// names from the canonical `cases` table for the same provider org and
// also include the provider organization's own name + displayName as
// fallbacks. Comparison is normalized lowercase. Result set is small
// (one provider org's doctors).
export async function getDoctorNameSetForProviderOrg(
  labOrganizationId: string,
  providerOrganizationId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  const canonicalDoctorRows = await db
    .selectDistinct({ doctorName: cases.doctorName })
    .from(cases)
    .where(
      and(
        eq(cases.labOrganizationId, labOrganizationId),
        eq(cases.providerOrganizationId, providerOrganizationId),
        notDeleted(cases),
      ),
    );
  for (const r of canonicalDoctorRows as any[]) {
    const n = String(r.doctorName ?? "").trim().toLowerCase();
    if (n) out.add(n);
  }
  const orgRow = await db.query.organizations.findFirst({
    where: eq(organizations.id, providerOrganizationId),
  });
  if (orgRow) {
    const n1 = String(orgRow.name ?? "").trim().toLowerCase();
    if (n1) out.add(n1);
    const n2 = String((orgRow as any).displayName ?? "").trim().toLowerCase();
    if (n2) out.add(n2);
  }
  return out;
}

// Resolve a remake-target id against BOTH the canonical `cases` table and
// the legacy `lab_cases` table so the duplicate dialog can link a new
// canonical case to either kind of historical record. Task #331 requires
// users to be able to pick any returned candidate; legacy rows must be
// linkable too.
//
// Returns `null` when the id matches neither table (or matches but lives
// in a different lab — cross-tenant linking is forbidden).
export async function resolveRemakeOriginal(
  remakeOfCaseId: string,
  expectedLabOrgId: string,
  expectedProviderOrgId: string | null,
  /**
   * Optional doctor-name fallback for legacy `lab_cases` originals.
   * When the provider org has no canonical history yet (so
   * `getDoctorNameSetForProviderOrg` returns an empty / sparse set), we
   * still need to allow linking to legacy mobile cases that belong to
   * the same provider. The caller passes the new case's doctor name
   * here; a legacy original is accepted when its doctorName matches the
   * derived provider doctor set OR this fallback name (case-insensitive).
   */
  expectedDoctorName?: string | null,
): Promise<
  | {
      kind: "canonical";
      id: string;
      caseNumber: string;
      labOrganizationId: string;
      providerOrganizationId: string | null;
    }
  | {
      kind: "legacy";
      id: string;
      caseNumber: string;
      labOrganizationId: string;
      caseData: any;
    }
  | null
> {
  const canonical = await db.query.cases.findFirst({
    where: and(eq(cases.id, remakeOfCaseId), notDeleted(cases)),
  });
  if (canonical) {
    if (canonical.labOrganizationId !== expectedLabOrgId) return null;
    if (
      expectedProviderOrgId &&
      canonical.providerOrganizationId !== expectedProviderOrgId
    ) {
      return null;
    }
    return {
      kind: "canonical",
      id: canonical.id,
      caseNumber: canonical.caseNumber,
      labOrganizationId: canonical.labOrganizationId,
      providerOrganizationId: canonical.providerOrganizationId,
    };
  }
  const legacy = await db.query.labCases.findFirst({
    where: and(eq(labCases.id, remakeOfCaseId), isNull(labCases.deletedAt)),
  });
  if (!legacy) return null;
  if (legacy.organizationId !== expectedLabOrgId) return null;
  let parsed: any = null;
  try {
    parsed =
      typeof legacy.caseData === "string"
        ? JSON.parse(legacy.caseData)
        : legacy.caseData;
  } catch {
    parsed = null;
  }
  // Provider-org scoping for legacy originals: legacy lab_cases have no
  // providerOrganizationId column, so map provider org → known doctor
  // names and require the legacy row's doctorName to fall in that set.
  // This blocks linking a canonical case to a legacy case from a
  // different provider in the same lab.
  if (expectedProviderOrgId) {
    const doctorSet = await getDoctorNameSetForProviderOrg(
      expectedLabOrgId,
      expectedProviderOrgId,
    );
    const fallback = String(expectedDoctorName ?? "").trim().toLowerCase();
    if (fallback) doctorSet.add(fallback);
    const candidateDoctor = String(parsed?.doctorName ?? "")
      .trim()
      .toLowerCase();
    if (!candidateDoctor || !doctorSet.has(candidateDoctor)) {
      return null;
    }
  }
  return {
    kind: "legacy",
    id: legacy.id,
    caseNumber: parsed?.caseNumber ?? legacy.id,
    labOrganizationId: legacy.organizationId,
    caseData: parsed,
  };
}

/**
 * Traverse the remakeOfCaseId chain upward from directParentId until we reach
 * the root case (remake_of_case_id IS NULL). Returns {id, caseNumber} of that
 * root. If directParentId itself has no remake_of_case_id it IS the root.
 *
 * Must be called with the same db/tx that holds the advisory lock when used
 * inside a transaction, so the root read is consistent with the count.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveRemakeRootCanonical(
  directParentId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOrTx: any,
): Promise<{ id: string; caseNumber: string }> {
  const result = await dbOrTx.execute(sql`
    WITH RECURSIVE remake_chain AS (
      SELECT id, case_number, remake_of_case_id
      FROM cases
      WHERE id = ${directParentId} AND deleted_at IS NULL
      UNION ALL
      SELECT c.id, c.case_number, c.remake_of_case_id
      FROM cases c
      INNER JOIN remake_chain rc ON c.id = rc.remake_of_case_id
      WHERE c.deleted_at IS NULL
    )
    SELECT id, case_number AS "caseNumber"
    FROM remake_chain
    WHERE remake_of_case_id IS NULL
    LIMIT 1
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (result as any).rows as Array<{ id: string; caseNumber: string }>;
  if (!rows[0]) {
    throw new HttpError(
      500,
      `Could not resolve remake root for case ${directParentId}.`,
    );
  }
  return { id: rows[0].id, caseNumber: rows[0].caseNumber };
}

/**
 * Count all non-deleted cases that are descendants of rootId at any depth
 * (direct remakes + remakes-of-remakes + …). Used to compute the next suffix
 * letter for a new remake so that chains always grow from the root number.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function countAllRemakeDescendants(
  rootId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOrTx: any,
): Promise<number> {
  const result = await dbOrTx.execute(sql`
    WITH RECURSIVE remake_tree AS (
      SELECT id
      FROM cases
      WHERE remake_of_case_id = ${rootId} AND deleted_at IS NULL
      UNION ALL
      SELECT c.id
      FROM cases c
      INNER JOIN remake_tree rt ON c.remake_of_case_id = rt.id
      WHERE c.deleted_at IS NULL
    )
    SELECT count(*)::int AS cnt FROM remake_tree
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (result as any).rows as Array<{ cnt: number }>;
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Mutate a legacy case JSON blob while holding its row lock for the complete
 * read/modify/write sequence. `lab_cases.caseData` is text, so a plain
 * transaction at Read Committed does not prevent another writer from reading
 * the old blob and replacing a newly appended history item.
 */
async function mutateLegacyCaseDataWithLock(
  caseId: string,
  mutate: (data: Record<string, any>, tx: any) => void | Promise<void>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOrTx?: any,
  serializeLocationStatus = false,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apply = async (tx: any) => {
    if (serializeLocationStatus) {
      await acquireCaseLocationStatusLock(tx);
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${caseId}))`);
    const [row] = await tx
      .select({ caseData: labCases.caseData })
      .from(labCases)
      .where(eq(labCases.id, caseId))
      .for("update");
    if (!row) throw new HttpError(404, "Case not found.");

    let data: Record<string, any> = {};
    try {
      const parsed =
        typeof row.caseData === "string"
          ? JSON.parse(row.caseData)
          : row.caseData;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = { ...parsed };
      }
    } catch {
      // Keep the existing route behavior for malformed historical blobs.
    }
    await mutate(data, tx);
    await tx
      .update(labCases)
      .set({ caseData: JSON.stringify(data), updatedAt: new Date() })
      .where(eq(labCases.id, caseId));
  };

  if (dbOrTx) {
    await apply(dbOrTx);
  } else {
    await db.transaction(apply);
  }
}

type PhysicalLocationSnapshot = {
  id: string | null;
  code: string | null;
  name: string | null;
};

type LegacyLocationHistoryEntry = {
  id: string;
  previous: PhysicalLocationSnapshot;
  destination: PhysicalLocationSnapshot;
  movedAt: string;
  movedByUserId: string;
  actorInitials: string;
};

function parseLegacyLocationHistory(data: Record<string, any>): LegacyLocationHistoryEntry[] {
  if (!Array.isArray(data.locationHistory)) return [];
  return data.locationHistory
    .filter((entry: any): entry is LegacyLocationHistoryEntry => {
      return Boolean(
        entry &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          entry.previous &&
          typeof entry.previous === "object" &&
          entry.destination &&
          typeof entry.destination === "object" &&
          typeof entry.movedAt === "string" &&
          Number.isFinite(Date.parse(entry.movedAt)) &&
          typeof entry.movedByUserId === "string" &&
          typeof entry.actorInitials === "string",
      );
    })
    .sort((a, b) => Date.parse(a.movedAt) - Date.parse(b.movedAt));
}

async function updateLegacyCaseWithLocationHistory(input: {
  caseId: string;
  labOrganizationId: string;
  labLocationId?: string | null;
  actorUserId: string;
  actorInitials: string;
  mutate: (data: Record<string, any>, tx: any) => void | Promise<void>;
  canonicalUpdates?: Record<string, unknown>;
  recordCanonicalStatusChanges?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOrTx?: any;
}) {
  await mutateLegacyCaseDataWithLock(
    input.caseId,
    async (data, tx) => {
      const currentId =
        typeof data.labLocationId === "string" && data.labLocationId
          ? data.labLocationId
          : null;
      let destination: PhysicalLocationSnapshot | undefined;
      if (input.labLocationId !== undefined) {
        if (input.labLocationId === null) {
          destination = { id: null, code: null, name: null };
        } else {
          const [row] = await tx
            .select({
              id: labLocations.id,
              code: labLocations.code,
              name: labLocations.name,
            })
            .from(labLocations)
            .where(
              and(
                eq(labLocations.id, input.labLocationId),
                eq(labLocations.labOrganizationId, input.labOrganizationId),
              ),
            )
            .limit(1);
          if (!row) {
            throw new HttpError(400, "labLocationId does not belong to this lab.");
          }
          destination = row;
        }
      }

      let previous: PhysicalLocationSnapshot = {
        id: currentId,
        code: null,
        name: null,
      };
      if (currentId) {
        const [row] = await tx
          .select({
            id: labLocations.id,
            code: labLocations.code,
            name: labLocations.name,
          })
          .from(labLocations)
          .where(
            and(
              eq(labLocations.id, currentId),
              eq(labLocations.labOrganizationId, input.labOrganizationId),
            ),
          )
          .limit(1);
        if (row) previous = row;
      }

      await input.mutate(data, tx);
      const updatedId =
        typeof data.labLocationId === "string" && data.labLocationId
          ? data.labLocationId
          : null;
      if (updatedId !== currentId) {
        if (!destination || destination.id !== updatedId) {
          if (updatedId === null) {
            destination = { id: null, code: null, name: null };
          } else {
            const [row] = await tx
              .select({
                id: labLocations.id,
                code: labLocations.code,
                name: labLocations.name,
              })
              .from(labLocations)
              .where(
                and(
                  eq(labLocations.id, updatedId),
                  eq(labLocations.labOrganizationId, input.labOrganizationId),
                ),
              )
              .limit(1);
            if (!row) {
              throw new HttpError(400, "labLocationId does not belong to this lab.");
            }
            destination = row;
          }
        }
        const history = parseLegacyLocationHistory(data);
        const lastMovedAt = history.length
          ? Date.parse(history[history.length - 1]!.movedAt)
          : 0;
        const movedAt = new Date(Math.max(Date.now(), lastMovedAt + 1));
        history.push({
          id: randomUUID(),
          previous,
          destination: destination!,
          movedAt: movedAt.toISOString(),
          movedByUserId: input.actorUserId,
          actorInitials: input.actorInitials,
        });
        data.locationHistory = history;
      }

      // Promotion and legacy mutation share the advisory lock above. If this
      // request resolved the legacy route just before another request promoted
      // the case, mirror the mutation into the canonical row before releasing
      // the lock so neither representation becomes stale.
      if (input.canonicalUpdates) {
        const [canonical] = await tx
          .select({ id: cases.id })
          .from(cases)
          .where(and(eq(cases.id, input.caseId), notDeleted(cases)))
          .limit(1);
        if (canonical) {
          await updateCanonicalCasesWithLocationHistory({
            caseIds: [canonical.id],
            labOrganizationId: input.labOrganizationId,
            updates: input.canonicalUpdates,
            labLocationId: input.labLocationId,
            actorUserId: input.actorUserId,
            actorInitials: input.actorInitials,
            recordStatusChanges: input.recordCanonicalStatusChanges,
            dbOrTx: tx,
          });
        }
      }
    },
    input.dbOrTx,
    true,
  );
}

async function insertCaseLocationHistory(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  input: {
    caseId: string;
    actorUserId: string;
    actorOrganizationId: string;
    actorInitials: string;
    previous: PhysicalLocationSnapshot;
    destination: PhysicalLocationSnapshot;
    movedAt: Date;
    notes?: string | null;
  },
) {
  if (_testHooks.locationHistoryWriteHook) {
    await _testHooks.locationHistoryWriteHook();
  }
  const destinationCode = input.destination.code ?? "unassigned";
  const destinationName = input.destination.name ?? "Unassigned";
  const [location] = await tx
    .insert(caseLocations)
    .values({
      caseId: input.caseId,
      locationCode: destinationCode,
      locationName: destinationName,
      movedByUserId: input.actorUserId,
      movedAt: input.movedAt,
      notes: input.notes ?? null,
    })
    .returning();

  await tx.insert(caseEvents).values({
    caseId: input.caseId,
    eventType: "location_changed",
    actorUserId: input.actorUserId,
    actorOrganizationId: input.actorOrganizationId,
    actorInitials: input.actorInitials,
    occurredAt: input.movedAt,
    metadataJson: {
      locationId: location.id,
      labLocationId: input.destination.id,
      locationCode: destinationCode,
      locationName: destinationName,
      previousLabLocationId: input.previous.id,
      previousLocationCode: input.previous.code,
      previousLocationName: input.previous.name,
      fromLocationId: input.previous.id,
      fromLocation: input.previous.name,
      toLocationId: input.destination.id,
      toLocation: destinationName,
    },
  });

  return location;
}

async function updateCanonicalCasesWithLocationHistory(input: {
  caseIds: string[];
  labOrganizationId: string;
  updates: Record<string, unknown>;
  labLocationId?: string | null;
  actorUserId: string;
  actorInitials: string;
  locationHistoryNotes?: string | null;
  recordStatusChanges?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOrTx?: any;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apply = async (tx: any) => {
    await acquireCaseLocationStatusLock(tx);
    const orderedIds = [...input.caseIds].sort();
    const lockedCases: Array<{
      id: string;
      status: string;
      labLocationId: string | null;
    }> = await tx
      .select({
        id: cases.id,
        status: cases.status,
        labLocationId: cases.labLocationId,
      })
      .from(cases)
      .where(
        and(
          inArray(cases.id, orderedIds),
          eq(cases.labOrganizationId, input.labOrganizationId),
          notDeleted(cases),
        ),
      )
      .orderBy(asc(cases.id))
      .for("update");

    if (lockedCases.length !== orderedIds.length) {
      throw new HttpError(404, "One or more cases were not found.");
    }

    let destination: PhysicalLocationSnapshot | undefined;
    if (input.labLocationId !== undefined) {
      if (input.labLocationId === null) {
        destination = { id: null, code: null, name: null };
      } else {
        const [row] = await tx
          .select({
            id: labLocations.id,
            code: labLocations.code,
            name: labLocations.name,
          })
          .from(labLocations)
          .where(
            and(
              eq(labLocations.id, input.labLocationId),
              eq(labLocations.labOrganizationId, input.labOrganizationId),
            ),
          )
          .limit(1);
        if (!row) {
          throw new HttpError(400, "labLocationId does not belong to this lab.");
        }
        destination = row;
      }
    }

    const previousLocationIds: string[] = Array.from(
      new Set(
        lockedCases
          .map((row) => row.labLocationId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const previousRows: Array<{
      id: string;
      code: string;
      name: string;
    }> = previousLocationIds.length
      ? await tx
          .select({
            id: labLocations.id,
            code: labLocations.code,
            name: labLocations.name,
          })
          .from(labLocations)
          .where(inArray(labLocations.id, previousLocationIds))
      : [];
    const previousById = new Map(
      previousRows.map((row): [string, PhysicalLocationSnapshot] => [row.id, row]),
    );
    const movedAt = new Date();
    const updatedRows: Array<typeof cases.$inferSelect> = [];

    for (const current of lockedCases) {
      const [updated] = await tx
        .update(cases)
        .set(input.updates)
        .where(eq(cases.id, current.id))
        .returning();
      if (!updated) throw new HttpError(404, "Case not found.");
      updatedRows.push(updated);

      if (input.recordStatusChanges) {
        const nextStatus = input.updates.status;
        if (typeof nextStatus === "string" && nextStatus !== current.status) {
          await tx.insert(caseEvents).values({
            caseId: current.id,
            eventType: "status_changed",
            actorUserId: input.actorUserId,
            actorOrganizationId: input.labOrganizationId,
            actorInitials: input.actorInitials,
            occurredAt: movedAt,
            metadataJson: {
              fromStatus: current.status,
              toStatus: nextStatus,
            },
          });
        }
      }

      if (updated.labLocationId !== current.labLocationId) {
        const nextDestination =
          updated.labLocationId === null
            ? { id: null, code: null, name: null }
            : destination!;
        const previous =
          (current.labLocationId && previousById.get(current.labLocationId)) || {
            id: current.labLocationId ?? null,
            code: null,
            name: null,
          };
        await insertCaseLocationHistory(tx, {
          caseId: current.id,
          actorUserId: input.actorUserId,
          actorOrganizationId: input.labOrganizationId,
          actorInitials: input.actorInitials,
          previous,
          destination: nextDestination,
          movedAt,
          notes: input.locationHistoryNotes,
        });
      }
    }

    return updatedRows;
  };

  return input.dbOrTx ? apply(input.dbOrTx) : db.transaction(apply);
}

// Append a reciprocal "remade_by" history record on the original case
// being remade. Canonical originals get a `case_events` row; legacy
// originals get an entry pushed onto their `caseData.activityLog` JSON
// (mirroring how the legacy POST writes its own history).
async function writeReciprocalRemadeBy(
  original:
    | { kind: "canonical"; id: string; caseNumber: string }
    | { kind: "legacy"; id: string; caseNumber: string; caseData: any },
  newCase: { id: string; caseNumber: string },
  reason: string | null,
  charged: boolean | null,
  actor: { userId: string; orgId: string; initials: string },
  // Optional transaction handle so callers holding a transaction can make the
  // reciprocal write atomic with the rest of the remake side effects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOrTx?: any,
): Promise<void> {
  const note = `Case ${newCase.caseNumber} created as a remake of this case${
    reason ? ` (reason: ${reason})` : ""
  }, charged: ${charged === true ? "yes" : charged === false ? "no" : "unspecified"}`;
  const writer = dbOrTx ?? db;
  if (original.kind === "canonical") {
    await writer.insert(caseEvents).values({
      caseId: original.id,
      eventType: "remade_by",
      actorUserId: actor.userId,
      actorOrganizationId: actor.orgId,
      actorInitials: actor.initials,
      metadataJson: {
        remakeCaseId: newCase.id,
        remakeCaseNumber: newCase.caseNumber,
        remakeReason: reason,
        remakeCharged: charged,
        note,
      },
    }).catch((err: unknown): never => wrapDbError(err, {
      fallback: "Failed to record remake history event.",
    }));
    return;
  }
  // Legacy original: append to activityLog and persist under a row lock. Do
  // not use the older `original.caseData` snapshot supplied by the picker.
  await mutateLegacyCaseDataWithLock(original.id, (data) => {
    if (!Array.isArray(data.activityLog)) data.activityLog = [];
    data.activityLog.push({
      type: "remade_by",
      timestamp: Date.now(),
      user: actor.initials,
      description: note,
      metadata: {
        remakeCaseId: newCase.id,
        remakeCaseNumber: newCase.caseNumber,
        remakeReason: reason,
        remakeCharged: charged,
      },
    });
  }, dbOrTx);
}

// Structured remake-questionnaire fields accepted by `linkExistingCaseAsRemake`.
// Kept as a plain interface (rather than importing the `RemakeReasonKey` type
// alias declared later in this file) so this helper has no ordering
// dependency on where it's defined relative to its callers.
interface RemakeLinkInput {
  remakeOfCaseId: string;
  remakeReason: string;
  // Nullable: the create-flow questionnaire allows "unspecified" charged
  // state, while the link flows always send an explicit boolean.
  remakeCharged: boolean | null;
  remakeReasonKey?: string;
  remakeShadeLightness?: "light" | "dark";
  remakeShadePrescribed?: string;
  remakeShadeProvided?: string;
  remakeMaterialPrescribed?: string;
  remakeMaterialProvided?: string;
  remakeReturnedToLab?: boolean;
  remakeCategory?: "crown_bridge" | "removable";
  remakeNotes?: string;
}

/**
 * Link an existing case as a remake of another case, regardless of the
 * case's AI-import/review status. This powers
 * `PATCH /:caseId/mark-as-remake` (the Invoice Editor's "Mark as remake"
 * action, usable on any case).
 *
 * Encapsulates the full side-effect bundle:
 *  - resolves the chosen original (canonical or legacy, tenant-scoped),
 *  - atomically assigns the next remake-suffix case number (advisory lock +
 *    descendant count + UPDATE, all in one transaction, so no concurrent
 *    remake can claim the same suffix letter),
 *  - saves the questionnaire fields onto `found`,
 *  - writes forward (`remake_of`) and backward (`remade_by`) case-history
 *    events on both cases,
 *  - zeros out an existing open invoice for a no-charge remake, and
 *  - writes a `case_remake_linked` audit log entry.
 *
 */
async function linkExistingCaseAsRemake(
  req: Request,
  found: typeof cases.$inferSelect,
  input: RemakeLinkInput,
  actor: { userId: string; initials: string },
): Promise<{
  updated: typeof cases.$inferSelect;
  remakeOriginal: NonNullable<Awaited<ReturnType<typeof resolveRemakeOriginal>>>;
}> {
  const validatedReason = validateCustomRemakeReason(
    input.remakeReasonKey,
    input.remakeReason,
  );
  if (validatedReason !== null) input.remakeReason = validatedReason;
  if (input.remakeOfCaseId === found.id) {
    throw new HttpError(400, "A case cannot be a remake of itself.");
  }
  if (found.remakeOfCaseId) {
    throw new HttpError(400, "This case is already linked as a remake.");
  }
  const remakeOriginal = await resolveRemakeOriginal(
    input.remakeOfCaseId,
    found.labOrganizationId,
    found.providerOrganizationId,
    found.doctorName,
  );
  if (!remakeOriginal) {
    throw new HttpError(
      404,
      "Original case for remake not found in this lab.",
    );
  }

  // Everything with side effects — suffix assignment, case UPDATE, both
  // history events, and no-charge invoice zeroing — runs in ONE transaction
  // so a mid-flow failure can never leave a dangling `remade_by` event or
  // invoice mutation without the corresponding linked remake case.
  const updated = await db.transaction(async (tx) =>
    linkCaseAsRemakeCore(tx, found, remakeOriginal, input, actor),
  );

  // Audit log after commit: writeAuditLog never throws (it swallows and
  // logs failures), so it can't strand partially-committed state.
  await writeRemakeLinkedAudit(req, found, updated);

  return { updated, remakeOriginal };
}

/**
 * Transactional core shared by `linkExistingCaseAsRemake` (link an existing
 * case) and `createRemakeCaseAndLink` (create a new case, then link). Runs
 * entirely on the caller's transaction:
 *  - advisory lock on the remake root + descendant count + suffix-letter
 *    assignment + case UPDATE,
 *  - forward `remake_of` event on the case being linked,
 *  - backward `remade_by` event on the original (canonical row or legacy
 *    activityLog blob),
 *  - no-charge invoice zeroing (existing open invoice, if any).
 */
async function linkCaseAsRemakeCore(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  found: typeof cases.$inferSelect,
  remakeOriginal: NonNullable<Awaited<ReturnType<typeof resolveRemakeOriginal>>>,
  input: RemakeLinkInput,
  actor: { userId: string; initials: string },
): Promise<typeof cases.$inferSelect> {
  const setFields: Record<string, unknown> = {
    remakeOfCaseId: remakeOriginal.id,
    remakeReason: input.remakeReason ?? null,
    remakeCharged: input.remakeCharged ?? null,
    remakeReasonKey: input.remakeReasonKey ?? null,
    remakeShadeLightness: input.remakeShadeLightness ?? null,
    remakeShadePrescribed: input.remakeShadePrescribed ?? null,
    remakeShadeProvided: input.remakeShadeProvided ?? null,
    remakeMaterialPrescribed: input.remakeMaterialPrescribed ?? null,
    remakeMaterialProvided: input.remakeMaterialProvided ?? null,
    remakeReturnedToLab: input.remakeReturnedToLab ?? null,
    remakeCategory: input.remakeCategory ?? null,
    remakeNotes: input.remakeNotes ?? null,
    updatedAt: new Date(),
  };

  // Suffix computation + case UPDATE must be atomic: acquire the advisory
  // lock on the root, count all descendants, compute the suffix letter, and
  // UPDATE in the same transaction so no concurrent remake can claim the
  // same letter between our count and write.
  const remakeRoot =
    remakeOriginal.kind === "canonical"
      ? await resolveRemakeRootCanonical(remakeOriginal.id, tx)
      : { id: remakeOriginal.id, caseNumber: remakeOriginal.caseNumber };
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(1742068800, hashtext(${remakeRoot.id}))`,
  );
  const existingCount = await countAllRemakeDescendants(remakeRoot.id, tx);
  if (existingCount > 23) {
    throw new HttpError(
      409,
      `Too many remakes of case ${remakeRoot.caseNumber} (maximum 24).`,
    );
  }
  const suffixLetter = String.fromCharCode(66 + existingCount);
  const newCaseNumber = `${remakeRoot.caseNumber}${suffixLetter}`;
  const [updated] = await tx
    .update(cases)
    .set({ ...setFields, caseNumber: newCaseNumber })
    .where(eq(cases.id, found.id))
    .returning();

  const reason = input.remakeReason ?? null;
  const charged = input.remakeCharged ?? null;
  await tx.insert(caseEvents).values({
    caseId: found.id,
    eventType: "remake_of",
    actorUserId: actor.userId,
    actorOrganizationId: found.labOrganizationId,
    actorInitials: actor.initials,
    metadataJson: {
      originalCaseId: remakeOriginal.id,
      originalCaseNumber: remakeOriginal.caseNumber,
      originalCaseKind: remakeOriginal.kind,
      remakeReason: reason,
      remakeCharged: charged,
      note: `Marked as remake of ${remakeOriginal.kind === "legacy" ? "legacy " : ""}case ${remakeOriginal.caseNumber}${reason ? ` (reason: ${reason})` : ""}`,
    },
  }).catch((err: unknown): never => wrapDbError(err, {
    fallback: "Failed to record remake_of event.",
  }));
  await writeReciprocalRemadeBy(
    remakeOriginal,
    { id: found.id, caseNumber: updated.caseNumber },
    reason,
    charged,
    {
      userId: actor.userId,
      orgId: found.labOrganizationId,
      initials: actor.initials,
    },
    tx,
  );

  // For no-charge remakes, zero out any existing open invoice and append a
  // note. We deliberately don't void/delete it — the invoice row stays so
  // the audit trail is intact.
  if (charged === false) {
    const openInvoice = await tx.query.invoices.findFirst({
      where: and(
        eq(invoices.caseId, found.id),
        eq(invoices.status, "open"),
      ),
    });
    if (openInvoice) {
      await tx
        .update(invoiceLineItems)
        .set({ unitPrice: "0.00", lineTotal: "0.00" })
        .where(eq(invoiceLineItems.invoiceId, openInvoice.id));
      await tx
        .update(invoices)
        .set({
          subtotal: "0.00",
          total: "0.00",
          balanceDue: "0.00",
          notes: `No-charge remake of case ${remakeOriginal.caseNumber}${reason ? ` — reason: ${reason}` : ""}`,
          updatedByUserId: actor.userId,
        })
        .where(eq(invoices.id, openInvoice.id));
    }
  }

  return updated;
}

/**
 * Shared `case_remake_linked` audit entry for both link surfaces and the
 * create-then-link flow. `before` carries the pre-link snapshot values.
 */
async function writeRemakeLinkedAudit(
  req: Request,
  before: { needsAiReview: boolean | null; remakeOfCaseId: string | null },
  updated: typeof cases.$inferSelect,
): Promise<void> {
  await writeAuditLog({
    req,
    organizationId: updated.labOrganizationId,
    action: "case_remake_linked",
    entityType: "case",
    entityId: updated.id,
    beforeJson: {
      needsAiReview: before.needsAiReview,
      remakeOfCaseId: before.remakeOfCaseId,
    },
    afterJson: {
      needsAiReview: updated.needsAiReview,
      remakeOfCaseId: updated.remakeOfCaseId,
      remakeReason: updated.remakeReason,
      remakeCharged: updated.remakeCharged,
    },
  });
}

/**
 * Create a brand-new case and immediately link it as a remake of an existing
 * case, reusing `linkExistingCaseAsRemake` for the entire shared side-effect
 * bundle: transactional suffix assignment (advisory lock + descendant count),
 * forward (`remake_of`) / backward (`remade_by`) history events, no-charge
 * invoice zeroing, and the `case_remake_linked` audit-log entry. This is the
 * create-flow counterpart used by `POST /cases/:id/remake`, so all three
 * remake surfaces (New Case dialog, case-detail "Create Remake", Invoice
 * Editor "Mark as remake") share one implementation and cannot silently
 * drift apart.
 *
 * The new-case INSERT and the entire link side-effect bundle run in ONE
 * transaction (the insert uses a unique placeholder case number that
 * `linkCaseAsRemakeCore` immediately replaces with the real suffixed
 * number), so a failure at any point rolls back everything — no orphan
 * case, no dangling `remade_by` event on the original, no stray invoice
 * mutation.
 */
async function createRemakeCaseAndLink(
  req: Request,
  newCaseValues: Omit<typeof cases.$inferInsert, "caseNumber">,
  input: RemakeLinkInput,
  actor: { userId: string; initials: string },
): Promise<typeof cases.$inferSelect> {
  const remakeOriginal = await resolveRemakeOriginal(
    input.remakeOfCaseId,
    newCaseValues.labOrganizationId as string,
    (newCaseValues.providerOrganizationId as string | null) ?? null,
    (newCaseValues.doctorName as string | null) ?? null,
  );
  if (!remakeOriginal) {
    throw new HttpError(404, "Original case for remake not found in this lab.");
  }

  const placeholderNumber = `RMK-PENDING-${randomBytes(8).toString("hex")}`;
  const updated = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(cases)
      .values({
        ...newCaseValues,
        caseNumber: placeholderNumber,
      } as typeof cases.$inferInsert)
      .returning();
    return linkCaseAsRemakeCore(tx, created, remakeOriginal, input, actor);
  }).catch((err: unknown): never => {
    if (err instanceof HttpError) throw err;
    return wrapDbError(err, { fallback: "Failed to create remake case." });
  });

  // Audit after commit — writeAuditLog never throws.
  await writeRemakeLinkedAudit(
    req,
    { needsAiReview: updated.needsAiReview, remakeOfCaseId: null },
    updated,
  );
  return updated;
}

// Canonical authenticated file-download route.
// Authorizes by exact (caseId, attachmentId) identity from the DB record,
// then derives the on-disk filename from storageKey via extractMediaFileName.
// The served file path comes from the authoritative DB record, never from the
// raw URL, preventing any decoupled-authorization / confused-deputy attacks.
// Also handles legacy mobile cases (lab_cases rows) where the attachment was
// stored with labCaseId instead of caseId.
router.get(
  "/:caseId/attachments/:attachmentId/file",
  asyncHandler(async (req: Request, res: Response) => {
    const caseId = String(req.params["caseId"] ?? "");
    const attachmentId = String(req.params["attachmentId"] ?? "");
    const userId = (req as any).auth.userId as string;

    // Synthetic legacy attachment ids (`legacy-photo-<caseId>-<idx>` /
    // `legacy-video-<caseId>-<idx>`) are projected by the case-detail transform
    // for a lab_cases row's photos/videos arrays and have NO case_attachments
    // row — so the lookups below would always 404 them (the cause of blank
    // mobile photos on desktop/web). Resolve the file from the legacy case's
    // own caseData, authorize via the legacy case (owner or active lab member),
    // and serve from the durable disk → .trash → object-storage chain.
    const syntheticMatch = attachmentId.match(/^legacy-(photo|video)-(.+)-(\d+)$/);
    if (syntheticMatch && syntheticMatch[2] === caseId) {
      const kind = syntheticMatch[1];
      const mediaIdx = Number(syntheticMatch[3]);
      const legacyRow = await db.query.labCases.findFirst({
        where: and(eq(labCases.id, caseId), isNull(labCases.deletedAt)),
      });
      if (!legacyRow) throw new HttpError(404, "Case not found.");
      let authorized = legacyRow.ownerId === userId;
      if (!authorized && legacyRow.organizationId) {
        const labIds = await fetchUserActiveLabIds(userId);
        authorized = labIds.includes(legacyRow.organizationId);
      }
      if (!authorized) {
        throw new HttpError(403, "You do not have access to this file.");
      }
      let parsed: any;
      try {
        parsed =
          typeof legacyRow.caseData === "string"
            ? JSON.parse(legacyRow.caseData)
            : (legacyRow.caseData ?? {});
      } catch {
        throw new HttpError(404, "File not found.");
      }
      const arr = kind === "photo" ? parsed?.photos : parsed?.videos;
      const url = Array.isArray(arr) ? arr[mediaIdx] : undefined;
      // data: URIs are self-contained; renderers shouldn't proxy them here.
      if (typeof url !== "string" || !url || url.startsWith("data:")) {
        throw new HttpError(404, "File not found.");
      }
      // uploadPhotoAndCreateAttachment stores the id-based URL
      // (/api/cases/:id/attachments/:uuid/file) in caseData.photos.
      // extractMediaFileName can't derive a real filename from that path
      // (the last segment is always "file"), so we resolve it by looking up
      // the real caseAttachments row via the UUID embedded in the URL.
      const idBasedMatch = url.match(
        /\/api\/cases\/[^/]+\/attachments\/([0-9a-f-]{36})\/file(?:[?#].*)?$/i,
      );
      if (idBasedMatch) {
        const resolvedAttId = idBasedMatch[1]!;
        const resolvedAtt = await db.query.caseAttachments.findFirst({
          where: and(
            eq(caseAttachments.id, resolvedAttId),
            isNull(caseAttachments.deletedAt),
            or(
              eq(caseAttachments.caseId, caseId),
              eq(caseAttachments.labCaseId, caseId),
            ),
          ),
        });
        if (!resolvedAtt?.storageKey) throw new HttpError(404, "File not found.");
        const fn2 = extractMediaFileName(resolvedAtt.storageKey);
        if (!fn2) throw new HttpError(404, "File not found.");
        await serveLegacyCaseMediaFile(req, res, fn2);
        return;
      }
      const fn = extractMediaFileName(url);
      if (!fn) throw new HttpError(404, "File not found.");
      // Authorize the FILE itself via the legacy_case_media ledger
      // (first-writer-wins), not merely the requesting case. Otherwise a
      // crafted caseData referencing another tenant's filename could disclose
      // it. serveLegacyCaseMediaFile performs the authoritative ledger-based
      // owner/lab-member check before streaming from durable storage.
      await serveLegacyCaseMediaFile(req, res, fn);
      return;
    }

    let attachment: any = null;
    let isLabMember = false;

    // Try canonical case first.
    let canonicalAccess: Awaited<ReturnType<typeof assertCaseAccessWithMemberships>> | null = null;
    try {
      canonicalAccess = await assertCaseAccessWithMemberships(userId, caseId);
    } catch (e: any) {
      if (e.statusCode === 403) {
        // assertCaseAccessWithMemberships checks DIRECT membership only.
        // Linked-provider users (whose own provider org is connected to the
        // case's provider org via organizationConnections) are authorized by
        // the provider portal via getProviderOrgIdsForUserAndLinks. Try that
        // expanded check before propagating the 403.
        const selectedProvider = (req as any).user?.userType === "provider"
          ? await requireSelectedProviderOrganization(
              userId, req.header("x-provider-organization-id"))
          : null;
        const { providerOrgIds } = selectedProvider
          ? { providerOrgIds: [selectedProvider.id] }
          : await getProviderOrgIdsForUserAndLinks(userId);
        if (providerOrgIds.length > 0) {
          const linkedCase = await db.query.cases.findFirst({
            where: and(eq(cases.id, caseId), notDeleted(cases)),
          });
          if (
            linkedCase?.providerOrganizationId &&
            providerOrgIds.includes(linkedCase.providerOrganizationId)
          ) {
            // Grant read-only (non-lab) access — visibility filter below will
            // block internal_lab_only attachments exactly as for direct providers.
            canonicalAccess = {
              case: linkedCase,
              labMembership: null,
              providerMembership: null,
            };
          }
        }
        if (!canonicalAccess) throw e;
      } else if (e.statusCode !== 404) {
        throw e;
      }
    }

    if (canonicalAccess) {
      // A provider caller may have direct memberships in several practices.
      // Direct case access must still honor the server-resolved active
      // practice; otherwise selecting A could fetch B media.
      if (
        (req as any).user?.userType === "provider" &&
        canonicalAccess.case.providerOrganizationId !==
          (req as any).providerOrganizationId
      ) {
        throw new HttpError(403, "You do not have access to this file.");
      }
      isLabMember = !!canonicalAccess.labMembership;
      attachment = await db.query.caseAttachments.findFirst({
        where: and(
          eq(caseAttachments.id, attachmentId),
          eq(caseAttachments.caseId, caseId),
            isNull(caseAttachments.deletedAt),
        ),
      });
      // Fallback: case was promoted from mobile; attachment was created against
      // labCaseId before promotion and still has caseId = null.
      if (!attachment) {
        attachment = await db.query.caseAttachments.findFirst({
          where: and(
            eq(caseAttachments.id, attachmentId),
            eq(caseAttachments.labCaseId, caseId),
            isNull(caseAttachments.deletedAt),
          ),
        });
      }
    } else {
      // Legacy mobile case — look up by labCaseId, authorize via lab membership.
      const mobileRow = await db.query.labCases.findFirst({
        where: and(eq(labCases.id, caseId), isNull(labCases.deletedAt)),
      });
      if (!mobileRow) throw new HttpError(404, "Case not found.");
      if (!mobileRow.organizationId) throw new HttpError(422, "Case has no associated organization.");
      const labIds = await fetchUserActiveLabIds(userId);
      if (!labIds.includes(mobileRow.organizationId)) {
        throw new HttpError(403, "You do not have access to this case.");
      }
      isLabMember = true;
      attachment = await db.query.caseAttachments.findFirst({
        where: and(
          eq(caseAttachments.id, attachmentId),
          eq(caseAttachments.labCaseId, caseId),
          isNull(caseAttachments.deletedAt),
        ),
      });
    }

    if (!attachment) {
      throw new HttpError(404, "Attachment not found.");
    }

    if (attachment.visibility === "internal_lab_only" && !isLabMember) {
      throw new HttpError(403, "You do not have access to this file.");
    }

    const filename = extractMediaFileName(attachment.storageKey);
    if (!filename) {
      throw new HttpError(404, "File not found.");
    }

    // Legacy media has a first-writer-wins tenant binding independent of any
    // attachment rows that may reference its filename. A fabricated row on an
    // accessible case must not take precedence over that ownership record.
    const legacyBinding = await db.query.legacyCaseMedia.findFirst({
      where: eq(legacyCaseMedia.fileName, filename),
    });
    if (legacyBinding) {
      await serveLegacyCaseMediaFile(req, res, filename, legacyBinding);
      return;
    }

    const resolvedPath = path.resolve(caseMediaDir, filename);
    if (
      resolvedPath === caseMediaDir ||
      !resolvedPath.startsWith(caseMediaDir + path.sep)
    ) {
      throw new HttpError(400, "Invalid file path.");
    }

    // Determine safe Content-Type and disposition for serving. Images, PDFs,
    // and browser-native videos are served inline unless download=1 is explicit.
    // Other recognized video formats retain their real MIME type while using an
    // attachment disposition. We validate the
    // stored fileType against a safe set rather than trusting whatever the
    // client originally declared — this protects against legacy rows that may
    // have been stored before the server-side allowlist existed.
    const INLINE_MIMES = new Set([
      "image/jpeg", "image/png", "image/gif", "image/webp",
      "image/heic", "image/heif",
      "application/pdf",
      // Browser-native video types that can be previewed inline.
      // Non-streamable formats (e.g. video/quicktime MOV) are intentionally
      // excluded and will continue to force a download.
      "video/mp4", "video/webm",
    ]);
    const storedMime = (attachment.fileType ?? "application/octet-stream")
      .split(";")[0]!.trim().toLowerCase();
    const VIDEO_MIMES = new Set([
      "video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-m4v",
    ]);
    const MODEL_MIMES = new Set(["model/ply", "model/stl"]);
    const explicitDownload = req.query["download"] === "1";
    const serveInline = INLINE_MIMES.has(storedMime) && !explicitDownload;
    const safeContentType = INLINE_MIMES.has(storedMime) || VIDEO_MIMES.has(storedMime) || MODEL_MIMES.has(storedMime)
      ? storedMime
      : "application/octet-stream";
    const originalName = String(attachment.fileName ?? filename)
      .replace(/[\r\n"]/g, "_");
    const asciiName = originalName.replace(/[^\x20-\x7e]/g, "_");
    const dispositionType = serveInline ? "inline" : "attachment";
    const safeDisposition =
      `${dispositionType}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(originalName)}`;

    // X-Content-Type-Options: nosniff prevents browsers from sniffing away
    // from the declared content type even when served as octet-stream.
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (!fs.existsSync(resolvedPath)) {
      const objStream = await openCaseMediaObjectStream(filename, safeContentType);
      if (!objStream) {
        throw new HttpError(404, "File not found.");
      }
      res.setHeader("Content-Type", safeContentType);
      res.setHeader("Content-Disposition", safeDisposition);
      objStream.stream.pipe(res);
      return;
    }

    res.setHeader("Content-Type", safeContentType);
    res.setHeader("Content-Disposition", safeDisposition);
    return res.sendFile(resolvedPath);
  })
);

// Legacy compatibility route for URLs stored before the ID-based route was
// introduced (storageKeys of the form
// "https://host/uploads/case-media/<filename>" or
// "https://host/api/cases/attachment-file/<filename>").
// Strategy:
//   1. Narrow DB scan to rows whose storageKey plausibly contains the filename.
//   2. Filter in memory via extractMediaFileName for exact canonical match.
//   3. Enforce uniqueness — reject if 0 or >1 records claim the same filename
//      (>1 would indicate a crafted storageKey alongside the legitimate one).
//   4. Perform auth (case membership + visibility) against the matched record
//      BEFORE serving — no case/attachment IDs are ever exposed in redirects.
//   5. Derive the on-disk path from the record's storageKey, not the raw URL.
router.get(
  "/attachment-file/:filename",
  asyncHandler(async (req: Request, res: Response) => {
    const filename = String(req.params["filename"] ?? "");

    if (!filename || /[/\\]|\.\./.test(filename)) {
      throw new HttpError(400, "Invalid filename.");
    }

    // Narrow the SQL scan to rows whose storageKey plausibly ends with the
    // filename preceded by a slash, or equals the bare filename.
    const slashPattern = `%/${filename}`;
    const candidateRows = await db
      .select()
      .from(caseAttachments)
      .where(
        or(
          sql`${caseAttachments.storageKey} LIKE ${slashPattern}`,
          eq(caseAttachments.storageKey, filename),
        ),
      );

    // Exact canonical match — prevents suffix-based confused-deputy attacks.
    const matching = candidateRows.filter(
      (r) => extractMediaFileName(r.storageKey) === filename,
    );

    // >1 canonical record claiming the same filename is ambiguous (a crafted
    // storageKey alongside the legitimate one) — refuse.
    if (matching.length > 1) {
      throw new HttpError(404, "Attachment not found.");
    }

    // Legacy media has a first-writer-wins tenant binding independent of any
    // attachment rows that may reference its filename. Never let a fabricated
    // row take precedence over that ownership record.
    const legacyBinding = await db.query.legacyCaseMedia.findFirst({
      where: eq(legacyCaseMedia.fileName, filename),
    });
    if (legacyBinding) {
      await serveLegacyCaseMediaFile(req, res, filename, legacyBinding, true);
      return;
    }

    // No canonical attachment row: this is a legacy mobile-case file. Legacy
    // cases live in `lab_cases` and cannot have `case_attachments` rows (FK to
    // cases.id), so the only authoritative tenant binding is the
    // `legacy_case_media` ledger. Authorize against that binding (NOT against
    // any case the caller can craft), then serve from disk / .trash / storage.
    if (matching.length === 0) {
      await serveLegacyCaseMediaFile(req, res, filename, undefined, true);
      return;
    }

    const attachment = matching[0]!;

    // Auth check before any response — no case/attachment IDs exposed.
    // For legacy mobile-case attachments caseId is null; authorize via labCaseId.
    let labMembership: any = null;
    if (attachment.caseId) {
      const access = await assertCaseAccessWithMemberships(
        (req as any).auth.userId,
        attachment.caseId,
      );
      labMembership = access.labMembership;
    } else if (attachment.labCaseId) {
      const legacyRow = await db.query.labCases.findFirst({
        where: and(eq(labCases.id, attachment.labCaseId), isNull(labCases.deletedAt)),
      });
      if (!legacyRow?.organizationId) throw new HttpError(403, "You do not have access to this file.");
      const labIds = await fetchUserActiveLabIds((req as any).auth.userId);
      if (!labIds.includes(legacyRow.organizationId)) {
        throw new HttpError(403, "You do not have access to this file.");
      }
      labMembership = { labId: legacyRow.organizationId };
    } else {
      throw new HttpError(403, "You do not have access to this file.");
    }

    if (attachment.visibility === "internal_lab_only" && !labMembership) {
      throw new HttpError(403, "You do not have access to this file.");
    }

    // Derive the file path from the authoritative DB record, not the URL param.
    const resolvedFilename = extractMediaFileName(attachment.storageKey)!;
    const resolvedPath = path.resolve(caseMediaDir, resolvedFilename);
    if (
      resolvedPath === caseMediaDir ||
      !resolvedPath.startsWith(caseMediaDir + path.sep)
    ) {
      throw new HttpError(400, "Invalid file path.");
    }

    setDownloadOnlyMediaHeaders(res, attachment.fileName ?? resolvedFilename);

    if (!fs.existsSync(resolvedPath)) {
      const objStream = await openCaseMediaObjectStream(
        resolvedFilename,
        "application/octet-stream",
      );
      if (!objStream) {
        throw new HttpError(404, "File not found.");
      }
      objStream.stream.pipe(res);
      return;
    }

    return res.sendFile(resolvedPath);
  })
);

// Stream a case-media file by basename from the durable storage chain:
// live disk → .trash/ (false-positive orphan-cleanup recovery) → object
// storage (the autoscale-safe persistent copy). Returns false when the file is
// absent from every tier. Performs NO authorization — callers MUST authorize
// the requester against the file's owning case/tenant before calling this.
async function streamCaseMediaFile(
  res: Response,
  filename: string,
  fileType?: string,
  downloadOnly = false,
): Promise<boolean> {
  const resolvedPath = path.resolve(caseMediaDir, filename);
  if (
    resolvedPath === caseMediaDir ||
    !resolvedPath.startsWith(caseMediaDir + path.sep)
  ) {
    return false;
  }
  if (downloadOnly) {
    setDownloadOnlyMediaHeaders(res, filename);
  }
  if (fs.existsSync(resolvedPath)) {
    res.sendFile(resolvedPath);
    return true;
  }
  // Live copy missing — a prior orphan cleanup may have moved it to .trash/
  // (named `<stamp>__<filename>`). Serve the most recent trashed copy.
  const trashDir = path.resolve(caseMediaDir, ".trash");
  if (fs.existsSync(trashDir)) {
    const trashed = fs
      .readdirSync(trashDir)
      .filter((e) => e.endsWith(`__${filename}`))
      .sort()
      .reverse();
    for (const candidate of trashed) {
      const trashedPath = path.resolve(trashDir, candidate);
      if (
        trashedPath.startsWith(trashDir + path.sep) &&
        fs.existsSync(trashedPath)
      ) {
        res.sendFile(trashedPath);
        return true;
      }
    }
  }
  // Last resort: object storage (large files / autoscale-wiped local disk).
  const objStream = await openCaseMediaObjectStream(filename, fileType);
  if (!objStream) return false;
  if (!downloadOnly) {
    res.setHeader("Content-Type", objStream.contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(filename)}"`,
    );
  }
  objStream.stream.pipe(res);
  return true;
}

function setDownloadOnlyMediaHeaders(res: Response, filename: string): void {
  const safeName = String(filename || "download").replace(/[\r\n"]/g, "_");
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, "_");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
}

// Serve a media file referenced by a LEGACY mobile case (a row in `lab_cases`,
// which cannot have a `case_attachments` row). Authorization is derived from
// the `legacy_case_media` ledger — the first legacy case to reference a
// filename owns it (first-writer-wins), so a later crafted caseData cannot
// claim another tenant's file. The caller must be that case's owner or an
// active member of its lab — the exact predicate used by GET /legacy/cases.
async function serveLegacyCaseMediaFile(
  req: Request,
  res: Response,
  filename: string,
  knownBinding?: typeof legacyCaseMedia.$inferSelect,
  downloadOnly = false,
): Promise<void> {
  const userId = (req as any).auth.userId as string;

  const binding =
    knownBinding ??
    (await db.query.legacyCaseMedia.findFirst({
      where: eq(legacyCaseMedia.fileName, filename),
    }));
  if (!binding) {
    throw new HttpError(404, "File not found.");
  }

  const isOwner = binding.ownerId === userId;
  let isLabMember = false;
  if (!isOwner && binding.organizationId) {
    const labIds = await fetchUserActiveLabIds(userId);
    isLabMember = labIds.includes(binding.organizationId);
  }
  if (!isOwner && !isLabMember) {
    throw new HttpError(403, "You do not have access to this file.");
  }

  // The ledger key IS the validated basename. Serve from the durable storage
  // chain (disk → .trash → object storage).
  if (!(await streamCaseMediaFile(res, filename, undefined, downloadOnly))) {
    throw new HttpError(404, "File not found.");
  }
}

async function assertCaseAccess(userId: string, caseId: string) {
  const access = await assertCaseAccessWithMemberships(userId, caseId);
  return access.case;
}

/**
 * Bump `cases.updatedAt` for a canonical case so it rises to the top of
 * "Recent cases" after any meaningful sub-resource mutation (notes,
 * attachments, location changes, restorations, submissions, alloy charges,
 * pricing updates, etc.).
 */
async function touchCase(caseId: string): Promise<void> {
  await db
    .update(cases)
    .set({ updatedAt: new Date() })
    .where(eq(cases.id, caseId));
  broadcastCaseUpdated(caseId);
}

async function fetchUserActiveLabIds(userId: string): Promise<string[]> {
  const memberships = await db
    .select({ labId: organizationMemberships.labId })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.labId))
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
        eq(organizations.type, "lab"),
        isNull(organizationMemberships.deletedAt),
      ),
    );
  const ids = new Set<string>();
  for (const row of memberships) {
    if (row.labId) ids.add(row.labId);
  }
  return Array.from(ids);
}

/**
 * Auto-promote a mobile `lab_cases` row to a canonical `cases` row so that
 * desktop users can add/edit/delete restorations on mobile-originated cases.
 *
 * The same `id` is reused for the canonical row so all existing attachment
 * references (caseAttachments.labCaseId) continue to resolve correctly.
 *
 * After promotion the canonical row is the live source of truth for the
 * desktop. The original `lab_cases` row is preserved for mobile-app
 * compatibility (the mobile app still syncs through the legacy endpoint).
 *
 * `providerOrganizationId` is set to the lab's own org because mobile cases
 * have no external provider — it satisfies the NOT-NULL FK and can be
 * corrected later via the case edit form.
 */
async function promoteLabCaseToCanonicalLocked(
  userId: string,
  labCaseId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
): Promise<any> {
  // Already promoted? Return the existing canonical row.
  const existing = await tx.query.cases.findFirst({
    where: and(eq(cases.id, labCaseId), notDeleted(cases)),
  });
  if (existing) return existing;

  const [legacyRow] = await tx
    .select({
      ...getTableColumns(labCases),
      updatedAt: sql<string | null>`${labCases.updatedAt}::text`,
    })
    .from(labCases)
    .where(and(eq(labCases.id, labCaseId), isNull(labCases.deletedAt)))
    .for("update");
  if (!legacyRow) throw new HttpError(404, "Case not found.");

  const labIds = await fetchUserActiveLabIds(userId);
  const orgId = legacyRow.organizationId ?? "";
  if (!orgId || !labIds.includes(orgId)) {
    throw new HttpError(403, "You do not have access to this case.");
  }

  let parsed: any = {};
  try {
    parsed =
      typeof legacyRow.caseData === "string"
        ? JSON.parse(legacyRow.caseData)
        : (legacyRow.caseData ?? {});
  } catch {
    parsed = {};
  }

  const legacyDesktopStatus = legacyStatusToCanonical(parsed?.status);
  const legacyLabLocationId =
    typeof parsed?.labLocationId === "string" && parsed.labLocationId
      ? parsed.labLocationId
      : null;
  // A legacy JSON blob is client-controlled. Preserve its saved station only
  // when it belongs to the case's own lab; lab_locations has a global FK, so
  // copying an arbitrary id would otherwise create a cross-lab association.
  const [savedLocation] = legacyLabLocationId
    ? await tx
        .select({ id: labLocations.id, status: labLocations.status })
        .from(labLocations)
        .where(
          and(
            eq(labLocations.id, legacyLabLocationId),
            eq(labLocations.labOrganizationId, orgId),
          ),
        )
        .limit(1)
    : [];
  const desktopStatus = savedLocation?.status ?? legacyDesktopStatus;
  const split = splitDisplayName(parsed?.patientName ?? "");
  const firstName =
    ((parsed?.patientFirstName ?? split.first ?? "") as string).trim() ||
    "Unknown";
  const lastName =
    ((parsed?.patientLastName ?? split.last ?? "") as string).trim() ||
    "Patient";
  const rawCaseNumber = String(parsed?.caseNumber ?? legacyRow.id);

  // caseNumber has a global unique index; fall back to "<number>-m" or the
  // lab_cases id itself when the raw number is already taken by another case.
  let resolvedCaseNumber = rawCaseNumber;
  const numConflict = await tx.query.cases.findFirst({
    where: eq(cases.caseNumber, rawCaseNumber),
    columns: { id: true },
  });
  if (numConflict) {
    const fallback = `${rawCaseNumber}-m`;
    const fallbackConflict = await tx.query.cases.findFirst({
      where: eq(cases.caseNumber, fallback),
      columns: { id: true },
    });
    resolvedCaseNumber = fallbackConflict ? labCaseId : fallback;
  }

  const toMs = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    if (typeof v === "string") {
      const p = Date.parse(v);
      if (Number.isFinite(p)) return p;
    }
    return null;
  };
  const dueDateMs = toMs(parsed?.dueDate);
  const receivedAt =
    legacyUtcCalendarDate(legacyRow.updatedAt) ??
    new Date().toISOString().slice(0, 10);

  const teeth: Array<{ num: string; type?: string }> = [];
  if (Array.isArray(parsed?.toothMap)) {
    for (const t of parsed.toothMap) {
      if (t?.num != null) teeth.push({ num: String(t.num), type: t.type });
    }
  } else if (Array.isArray(parsed?.toothIndices)) {
    for (const n of parsed.toothIndices) {
      if (n != null) teeth.push({ num: String(n) });
    }
  }
  const legacyLocationHistory = parseLegacyLocationHistory(parsed);
  const [promoted] = await tx
    .insert(cases)
    .values({
        id: labCaseId,
        caseNumber: resolvedCaseNumber,
        labOrganizationId: orgId,
        providerOrganizationId: orgId,
        patientFirstName: firstName,
        patientLastName: lastName,
        doctorName: (parsed?.doctorName as string | undefined) ?? "",
        status: desktopStatus,
        priority: parsed?.isRush ? "rush" : "normal",
        dueDate: dueDateMs ? new Date(dueDateMs) : null,
        labLocationId: savedLocation?.id ?? null,
        receivedAt,
        createdByUserId: legacyRow.ownerId ?? userId,
        rxNotes:
          typeof parsed?.rxNotes === "string"
            ? parsed.rxNotes
            : typeof parsed?.caseNotes === "string"
              ? parsed.caseNotes
              : null,
    })
    .returning();

  // Copy blob restorations to caseRestorations so the Restorations tab shows
  // the teeth that were already entered on mobile.
  if (teeth.length > 0) {
    await tx.insert(caseRestorations).values(
      teeth.map((t) => ({
        caseId: promoted.id,
        toothNumber: t.num,
        restorationType:
          t.type ?? ((parsed?.caseType as string | undefined) ?? "restoration"),
        material: (parsed?.material as string | undefined) ?? null,
        shade: (parsed?.shade as string | undefined) ?? null,
      })),
    ).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to copy restorations from legacy case.",
    }));
  }

  // Promotion is the one-way bridge from append-only blob history into the
  // canonical timeline. It runs in the same transaction as case creation, so
  // a retry cannot duplicate a partially copied move sequence.
  for (const entry of legacyLocationHistory) {
    await insertCaseLocationHistory(tx, {
      caseId: promoted.id,
      actorUserId: entry.movedByUserId,
      actorOrganizationId: orgId,
      actorInitials: entry.actorInitials,
      previous: entry.previous,
      destination: entry.destination,
      movedAt: new Date(entry.movedAt),
    });
  }

  return promoted;
}

async function promoteLabCaseToCanonical(
  userId: string,
  labCaseId: string,
): Promise<any> {
  return db.transaction(async (tx) => {
    await acquireCaseLocationStatusLock(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${labCaseId}))`);
    if (_testHooks.promotionLockedHook) {
      await _testHooks.promotionLockedHook();
    }
    return promoteLabCaseToCanonicalLocked(userId, labCaseId, tx);
  });
}

/**
 * Wraps assertCaseAccess with a mobile-promotion fallback.
 * When the caseId belongs to a lab_cases row (not yet in cases),
 * auto-promotes it so restoration writes can proceed.
 */
async function assertCaseAccessOrPromote(
  userId: string,
  caseId: string,
): Promise<any> {
  try {
    return await assertCaseAccess(userId, caseId);
  } catch (e: any) {
    if (e.statusCode !== 404) throw e;
  }
  return promoteLabCaseToCanonical(userId, caseId);
}

/**
 * Project a mobile-app legacy `lab_cases` JSON blob into the canonical
 * DetailedCase shape used by `GET /api/cases/:id`. Returns null when the
 * case isn't found in lab_cases or the caller isn't allowed to see it.
 *
 * This is the read bridge that lets the desktop client display data for
 * cases that were created on the mobile app (where the source of truth is
 * still the legacy JSON blob, not the canonical tables).
 */
async function tryProjectLegacyCaseForDesktop(
  userId: string,
  caseId: string,
): Promise<any | null> {
  const legacyRow = await db.query.labCases.findFirst({
    where: and(eq(labCases.id, caseId), isNull(labCases.deletedAt)),
  });
  if (!legacyRow) return null;

  // Authorization: require active lab membership in the case's owning
  // organization. We intentionally do NOT fall back to ownerId-equality
  // here — former employees who still hold a session must not see lab
  // data after their membership is revoked, matching the canonical
  // assertCaseAccessWithMemberships behavior.
  const labIds = await fetchUserActiveLabIds(userId);
  const isLabMember = legacyRow.organizationId
    ? labIds.includes(legacyRow.organizationId)
    : false;
  if (!isLabMember) {
    throw new HttpError(403, "You do not have access to this case.");
  }

  let parsed: any = {};
  try {
    parsed =
      typeof legacyRow.caseData === "string"
        ? JSON.parse(legacyRow.caseData)
        : legacyRow.caseData ?? {};
  } catch {
    parsed = {};
  }

  const split = splitDisplayName(parsed?.patientName ?? "");
  const firstName =
    parsed?.patientFirstName ?? split.first ?? parsed?.patientInitials ?? "";
  const lastName = parsed?.patientLastName ?? split.last ?? "";
  const labOrgId = legacyRow.organizationId ?? parsed?.organizationId ?? "";
  const desktopStatus = legacyStatusToCanonical(parsed?.status);
  const labLocationId =
    typeof parsed?.labLocationId === "string" && parsed.labLocationId
      ? parsed.labLocationId
      : null;
  const savedLocation = labLocationId
    ? await db.query.labLocations.findFirst({
        where: and(
          eq(labLocations.id, labLocationId),
          eq(labLocations.labOrganizationId, labOrgId),
        ),
        columns: { name: true },
      })
    : null;
  const legacyLocationHistory = parseLegacyLocationHistory(parsed);
  const toMs = (v: unknown, fallback: number): number => {
    if (v === null || v === undefined || v === "") return fallback;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    if (typeof v === "string") {
      const parsedMs = Date.parse(v);
      if (Number.isFinite(parsedMs)) return parsedMs;
    }
    return fallback;
  };
  const toISO = (ms: number, fallback: string): string => {
    if (!Number.isFinite(ms)) return fallback;
    try {
      return new Date(ms).toISOString();
    } catch {
      return fallback;
    }
  };
  const rowUpdatedMs = legacyRow.updatedAt
    ? new Date(legacyRow.updatedAt).getTime()
    : Date.now();
  const nowMs = Date.now();
  const fallbackMs = Number.isFinite(rowUpdatedMs) ? rowUpdatedMs : nowMs;
  const createdMs = toMs(parsed?.createdAt, fallbackMs);
  const updatedMs = toMs(parsed?.updatedAt, createdMs);
  const nowISO = new Date(nowMs).toISOString();
  const createdISO = toISO(createdMs, nowISO);
  const updatedISO = toISO(updatedMs, createdISO);

  // Restorations: derive one row per tooth from toothMap[] (preferred) or
  // toothIndices[] (older mobile builds). Fall back to a single row using
  // the top-level material/shade when no per-tooth detail exists.
  const restorations: any[] = [];
  const teeth: Array<{ num: string | number; type?: string }> = [];
  if (Array.isArray(parsed?.toothMap)) {
    for (const t of parsed.toothMap) {
      if (t && t.num !== undefined && t.num !== null) {
        teeth.push({ num: t.num, type: t.type });
      }
    }
  } else if (Array.isArray(parsed?.toothIndices)) {
    for (const n of parsed.toothIndices) {
      teeth.push({ num: n });
    }
  }
  if (teeth.length > 0) {
    for (const t of teeth) {
      restorations.push({
        id: `legacy-rest-${legacyRow.id}-${t.num}`,
        caseId: legacyRow.id,
        toothNumber: String(t.num),
        restorationType: t.type ?? parsed?.caseType ?? "restoration",
        restorationSubtype: null,
        material: parsed?.material ?? null,
        shade: parsed?.shade ?? null,
        notes: null,
        quantity: 1,
        unitPrice: "0",
        priceSource: null,
        priceSourceId: null,
        priceSourceName: null,
        priceKey: null,
        createdAt: createdISO,
        updatedAt: updatedISO,
      });
    }
  } else if (parsed?.caseType || parsed?.material || parsed?.shade) {
    restorations.push({
      id: `legacy-rest-${legacyRow.id}-0`,
      caseId: legacyRow.id,
      toothNumber: "",
      restorationType: parsed?.caseType ?? "restoration",
      restorationSubtype: null,
      material: parsed?.material ?? null,
      shade: parsed?.shade ?? null,
      notes: null,
      quantity: 1,
      unitPrice: "0",
      priceSource: null,
      priceSourceId: null,
      priceSourceName: null,
      priceKey: null,
      createdAt: createdISO,
      updatedAt: updatedISO,
    });
  }

  // Notes: convert the single notes string (if any) into one CaseNote.
  const notesOut: any[] = [];
  const notesText = typeof parsed?.notes === "string" ? parsed.notes.trim() : "";
  if (notesText) {
    notesOut.push({
      id: `legacy-note-${legacyRow.id}`,
      caseId: legacyRow.id,
      noteText: notesText,
      visibility: "shared_with_provider",
      createdAt: createdISO,
      authorUserId: legacyRow.ownerId ?? null,
      authorName: null,
    });
  }

  // Events: project activityLog[] entries to CaseEvent shape so the
  // History tab renders the mobile timeline.
  const events: any[] = [];
  const log = Array.isArray(parsed?.activityLog) ? parsed.activityLog : [];
  for (const e of log) {
    if (!e || typeof e !== "object") continue;
    const occurredMs = Number(e.timestamp ?? createdMs);
    const occurredISO = new Date(
      Number.isFinite(occurredMs) ? occurredMs : createdMs,
    ).toISOString();
    let eventType: string;
    let mediaKind: "photo" | "video" | "document" | null = null;
    switch (e.type) {
      case "created":
        eventType = "created";
        break;
      case "station_change":
        eventType = "status_changed";
        break;
      case "photo":
        eventType = "attachment_added";
        mediaKind = "photo";
        break;
      case "video":
        eventType = "attachment_added";
        mediaKind = "video";
        break;
      case "document":
        eventType = "attachment_added";
        mediaKind = "document";
        break;
      case "note":
        eventType = "note_added";
        break;
      default:
        eventType = String(e.type ?? "event");
    }
    const metadata: Record<string, unknown> = {};
    if (e.description) {
      metadata.description = e.description;
      if (eventType === "note_added") metadata.noteText = e.description;
    }
    if (typeof e.noteText === "string" && e.noteText) {
      metadata.noteText = e.noteText;
      if (!metadata.description) metadata.description = e.noteText;
    }
    if (typeof e.authorName === "string" && e.authorName) {
      metadata.authorName = e.authorName;
    }
    if (
      e.internalException === true ||
      (INTERNAL_EXCEPTION_HISTORY_EVENT_TYPES as readonly string[]).includes(
        eventType,
      )
    ) {
      metadata.internalException = true;
      metadata.visibility = "internal_lab_only";
    }
    if (e.station) {
      metadata.toStatus =
        legacyStatusToCanonical(e.station, String(e.station));
      metadata.mobileStation = e.station;
    }
    if (e.user) metadata.user = e.user;
    if (mediaKind) metadata.mediaKind = mediaKind;
    // imageUri/fileName/fileType are written by the mobile addPhoto/addVideo/
    // addDocument flows. Surface them so the desktop History tab can render
    // an inline preview without round-tripping through the canonical
    // /:caseId/attachments/:attachmentId/file route (which doesn't know
    // about projected legacy attachment ids).
    if (typeof e.imageUri === "string" && e.imageUri) metadata.imageUri = e.imageUri;
    if (typeof e.fileName === "string" && e.fileName) metadata.fileName = e.fileName;
    // Surface the attachment category ("outgoing" case photos) so both
    // clients can label the event without a second lookup.
    if (typeof e.category === "string" && e.category) metadata.category = e.category;
    if (typeof e.attachmentId === "string" && e.attachmentId) {
      metadata.attachmentId = e.attachmentId;
    }
    if (typeof e.fileType === "string" && e.fileType) {
      metadata.fileType = e.fileType;
    } else if (mediaKind === "photo") {
      metadata.fileType = "image/jpeg";
    } else if (mediaKind === "video") {
      metadata.fileType = "video/mp4";
    }
    events.push({
      id: String(e.id ?? `legacy-evt-${legacyRow.id}-${occurredMs}`),
      caseId: legacyRow.id,
      eventType,
      actorUserId: null,
      actorOrganizationId: labOrgId || null,
      actorInitials: typeof e.user === "string" ? e.user.slice(0, 2) : null,
      actorName: typeof e.authorName === "string" ? e.authorName : null,
      metadataJson: metadata,
      occurredAt: occurredISO,
      createdAt: occurredISO,
    });
  }
  for (const entry of legacyLocationHistory) {
    const destinationCode = entry.destination.code ?? "unassigned";
    const destinationName = entry.destination.name ?? "Unassigned";
    events.push({
      id: `legacy-location-event-${entry.id}`,
      caseId: legacyRow.id,
      eventType: "location_changed",
      actorUserId: entry.movedByUserId,
      actorOrganizationId: labOrgId || null,
      actorInitials: entry.actorInitials,
      metadataJson: {
        locationId: entry.id,
        labLocationId: entry.destination.id,
        locationCode: destinationCode,
        locationName: destinationName,
        previousLabLocationId: entry.previous.id,
        previousLocationCode: entry.previous.code,
        previousLocationName: entry.previous.name,
        fromLocationId: entry.previous.id,
        fromLocation: entry.previous.name,
        toLocationId: entry.destination.id,
        toLocation: destinationName,
      },
      occurredAt: entry.movedAt,
      createdAt: entry.movedAt,
    });
  }

  // Guarantee a "Case Created" entry in the History tab regardless of which
  // platform created the case. Older mobile builds (or sync paths that
  // dropped activityLog) can leave a legacy case without a `created` entry,
  // which made the desktop History tab show only later events. Synthesize
  // one from the case's actual createdAt when none is present.
  const CREATION_EVENT_TYPES = new Set([
    "created",
    "case_created",
    "case_created_from_itero",
  ]);
  if (!events.some((e) => CREATION_EVENT_TYPES.has(String(e.eventType)))) {
    events.push({
      id: `legacy-evt-${legacyRow.id}-created`,
      caseId: legacyRow.id,
      eventType: "case_created",
      actorUserId: null,
      actorOrganizationId: labOrgId || null,
      actorInitials: null,
      metadataJson: { synthesized: true, source: "legacy_created_at" },
      occurredAt: createdISO,
      createdAt: createdISO,
    });
  }

  // Newest first to match canonical ordering.
  events.sort(
    (a, b) =>
      new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );

  // Attachments: project photos/videos arrays. URLs may be remote (http)
  // or data URIs — the desktop renders both via <img src=...>.
  const attachments: any[] = [];
  const photos = Array.isArray(parsed?.photos) ? parsed.photos : [];
  const videos = Array.isArray(parsed?.videos) ? parsed.videos : [];
  // Each mobile photo/video is added at a different time, but the legacy
  // `photos`/`videos` arrays only store URLs — not when each file was added.
  // The per-file capture time lives in the matching activityLog entry
  // (imageUri + timestamp). Map URL -> ms so the Files tab shows the real
  // "added" date for each item instead of stamping them all with the case's
  // createdAt — which made every mobile photo read "Nd ago" identically and
  // hid which one was added most recently.
  const mediaMsByUrl = new Map<string, number>();
  for (const e of log) {
    if (e && typeof e === "object" && typeof e.imageUri === "string" && e.imageUri) {
      const ms = Number(e.timestamp);
      if (Number.isFinite(ms)) mediaMsByUrl.set(e.imageUri, ms);
    }
  }
  // Resolve a file's added-time: prefer the activityLog timestamp, then a
  // timestamp embedded in the uploaded filename (e.g.
  // `…-media-1780274505902.jpg` or a leading `1780274507168-…`), then fall
  // back to the case createdAt for inline data: URIs with no stamp.
  // `msToISO` guards against malformed/out-of-range stamps so a bad value can
  // never throw a RangeError and 500 the case fetch.
  const msToISO = (ms: number): string | null => {
    if (!Number.isSafeInteger(ms) || ms <= 0) return null;
    const t = new Date(ms).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  const resolveMediaISO = (url: string): string => {
    const fromLog = mediaMsByUrl.get(url);
    if (fromLog !== undefined) {
      const iso = msToISO(fromLog);
      if (iso) return iso;
    }
    const m = url.match(/media-(\d{12,})/) || url.match(/(?:^|\/)(\d{12,})-/);
    if (m) {
      const iso = msToISO(Number(m[1]));
      if (iso) return iso;
    }
    return createdISO;
  };
  let idx = 0;
  for (const url of photos) {
    if (typeof url !== "string" || !url) continue;
    attachments.push({
      id: `legacy-photo-${legacyRow.id}-${idx}`,
      caseId: legacyRow.id,
      uploadedByUserId: legacyRow.ownerId ?? "",
      uploadedByOrganizationId: labOrgId,
      fileName: `mobile-photo-${idx + 1}`,
      storageKey: url,
      fileType: url.startsWith("data:") ? url.slice(5, url.indexOf(";")) : "image/jpeg",
      visibility: "shared_with_provider",
      createdAt: resolveMediaISO(url),
      uploaderName: null,
      // Direct URL for renderers that prefer a fully-qualified src.
      url,
    });
    idx++;
  }
  idx = 0;
  for (const url of videos) {
    if (typeof url !== "string" || !url) continue;
    attachments.push({
      id: `legacy-video-${legacyRow.id}-${idx}`,
      caseId: legacyRow.id,
      uploadedByUserId: legacyRow.ownerId ?? "",
      uploadedByOrganizationId: labOrgId,
      fileName: `mobile-video-${idx + 1}`,
      storageKey: url,
      fileType: url.startsWith("data:") ? url.slice(5, url.indexOf(";")) : "video/mp4",
      visibility: "shared_with_provider",
      createdAt: resolveMediaISO(url),
      uploaderName: null,
      url,
    });
    idx++;
  }

  // Also include any canonical case_attachments rows stored via the new
  // labCaseId FK (files attached by lab staff after the feature was enabled).
  const dbAttachments = await db.query.caseAttachments.findMany({
    where: and(
      eq(caseAttachments.labCaseId, legacyRow.id),
      isNull(caseAttachments.deletedAt),
    ),
    orderBy: [desc(caseAttachments.createdAt)],
  });
  for (const a of dbAttachments) {
    attachments.push({
      ...a,
      uploaderName: null,
    });
  }
  const legacyAttachmentNoteById = new Map(
    dbAttachments
      .filter((a) => !!a.note)
      .map((a) => [a.id, a.note as string]),
  );
  for (const event of events) {
    if (event.eventType !== "attachment_added") continue;
    const metadata = event.metadataJson as Record<string, unknown>;
    const attachmentId =
      typeof metadata.attachmentId === "string" ? metadata.attachmentId : null;
    if (!attachmentId) continue;
    const currentNote = legacyAttachmentNoteById.get(attachmentId);
    if (currentNote) metadata.note = currentNote;
    else delete metadata.note;
  }

  // Status history: synthesize from the createdAt + any station_change
  // events so the Overview timeline ribbon has content.
  const STATUS_LABELS: Record<string, string> = {
    received: "Received",
    in_design: "Design",
    scan: "Scan",
    in_milling: "Milling",
    post_mill: "Post Mill",
    sintering_furnace: "Sintering",
    model_room: "Model Room",
    in_porcelain: "Porcelain",
    qc: "QC",
    complete: "Complete",
    shipped: "Shipped",
    delivered: "Delivered",
    on_hold: "On Hold",
    remake: "Remake",
    cancelled: "Cancelled",
  };
  const statusHistory: Array<{ status: string; label: string; occurredAt: string }> = [
    { status: "received", label: STATUS_LABELS["received"]!, occurredAt: createdISO },
  ];
  for (const e of events.slice().reverse()) {
    if (e.eventType !== "status_changed") continue;
    const s = (e.metadataJson as any)?.toStatus as string | undefined;
    if (!s || !STATUS_LABELS[s]) continue;
    statusHistory.push({
      status: s,
      label: STATUS_LABELS[s] ?? s,
      occurredAt: e.occurredAt,
    });
  }

  const dueDateMs =
    parsed?.dueDate !== undefined && parsed?.dueDate !== null && parsed?.dueDate !== ""
      ? toMs(parsed.dueDate, NaN)
      : NaN;
  const dueDateISO = Number.isFinite(dueDateMs)
    ? toISO(dueDateMs, "")
    : null;

  return {
    id: legacyRow.id,
    caseNumber: String(parsed?.caseNumber ?? legacyRow.id),
    labOrganizationId: labOrgId,
    // Preserve an explicit saved association; never infer one from a name.
    providerOrganizationId: typeof parsed?.providerOrganizationId === "string" ? parsed.providerOrganizationId : "",
    patientFirstName: firstName,
    patientLastName: lastName,
    externalPatientId: null,
    doctorName: parsed?.doctorName ?? "",
    status: desktopStatus,
    priority: parsed?.isRush ? "rush" : "normal",
    dueDate: dueDateISO,
    createdAt: createdISO,
    updatedAt: updatedISO,
    restorationCount: restorations.length,
    restorationTypes: null,
    restorationMaterials: null,
    teeth: teeth.map((t) => t.num).join(","),
    totalPrice: parsed?.price ?? null,
    _source: "mobile" as const,
    needsAiReview: false,
    aiImportSource: null,
    remakeOfCaseId: parsed?.remakeOfCaseId ?? null,
    remakeReason: parsed?.remakeReason ?? null,
    remakeCharged:
      typeof parsed?.remakeCharged === "boolean"
        ? parsed.remakeCharged
        : null,
    suggestedDoctorName: null,
    suggestedProviderOrgId: null,
    suggestedPracticeName: null,
    casePanBarcode: parsed?.assignedBarcode ?? null,
    labLocationId: savedLocation ? labLocationId : null,
    labLocationName: savedLocation?.name ?? null,
    step: parsed?.step ?? null,
    stepShade: parsed?.stepShade ?? null,
    caseNotes: notesText || null,
    // Custom-shade tracking fields (Task #3631) — read from the JSON blob
    // so they round-trip correctly for cases that haven't been promoted to
    // the canonical cases table yet.
    isCustomShade: parsed?.isCustomShade === true,
    customShadeTechnician: parsed?.customShadeTechnician ?? null,
    customShadePicturesAvailable: parsed?.customShadePicturesAvailable === true,
    customShadeVideoAvailable: parsed?.customShadeVideoAvailable === true,
    restorations,
    notes: notesOut,
    attachments,
    events: sanitizeNoteEventsFor(events, isLabMember),
    originalCaseEvents: [],
    remakeChildrenEvents: [],
    locations: legacyLocationHistory.map((entry) => ({
      id: entry.id,
      caseId: legacyRow.id,
      locationCode: entry.destination.code ?? "unassigned",
      locationName: entry.destination.name ?? "Unassigned",
      movedByUserId: entry.movedByUserId,
      movedAt: entry.movedAt,
      notes: null,
    })),
    remakeOriginal: null,
    remakeChildren: [],
    viewerIsLabMember: isLabMember,
    viewerCanUploadAttachments: isLabMember,
    viewerCanPostNotes: true,
    viewerCanManageAttachments: isLabMember,
    statusHistory,
    // Legacy/mobile cases carry exceptions under their lab_cases id. Exception
    // content is lab-internal, so it is withheld from any non-lab viewer —
    // same rule as the canonical detail route.
    activeException: isLabMember
      ? await fetchActiveExceptionForCase(legacyRow.id)
      : null,
  };
}

export async function assertCaseAccessWithMemberships(userId: string, caseId: string) {
  const found = await db.query.cases.findFirst({
    where: and(eq(cases.id, caseId), notDeleted(cases)),
  });
  if (!found) throw new HttpError(404, "Case not found.");
  const labMembership = await requireMembership(
    userId,
    found.labOrganizationId
  ).catch(() => null);
  const providerMembership = await requireMembership(
    userId,
    found.providerOrganizationId
  ).catch(() => null);
  if (!labMembership && !providerMembership)
    throw new HttpError(403, "You do not have access to this case.");
  // Shared case routes retain lab-side access for mixed identities. Only an
  // access decision made solely through the case's provider org is subject to
  // that exact org's provider plan.
  if (providerMembership && !labMembership && found.providerOrganizationId) {
    await assertProviderOrganizationCapability(
      found.providerOrganizationId,
      "case_read",
    );
    if (
      CLOSED_CASE_STATUSES.includes(
        found.status as (typeof CLOSED_CASE_STATUSES)[number],
      )
    ) {
      try {
        await assertProviderOrganizationCapability(
          found.providerOrganizationId,
          "provider_portal",
        );
      } catch {
        throw new HttpError(
          403,
          "Your provider plan only includes active cases.",
        );
      }
    }
  }
  return { case: found, labMembership, providerMembership };
}

/**
 * POST /cases/:caseId/ws-ticket
 *
 * Mints a single-use, short-lived ticket that authorizes ONE WebSocket
 * connection to the real-time case-updates channel
 * (case-events-ws.ts's WS_PATH) for this case. The caller must already be
 * authenticated via the normal bearer/cookie auth on this router and have
 * case access — the same tenant check the REST case routes use. Deliberately
 * does not accept the raw access token over the WebSocket query string; see
 * case-events-ws.ts's design notes for why.
 */
router.post(
  "/:caseId/ws-ticket",
  asyncHandler(async (req: Request, res: Response) => {
    const caseId = String(req.params["caseId"] ?? "");
    const userId = (req as any).auth.userId as string;
    await assertCaseAccessWithMemberships(userId, caseId);
    const ticket = issueCaseWsTicket(userId, caseId);
    return ok(res, { ticket });
  }),
);

/**
 * Reject a barcode that is already assigned to another active (non-deleted,
 * non-complete) case in the same lab. Throws HttpError(409) with a message
 * that names the conflicting case number so the caller can surface it.
 *
 * Pass `excludeCaseId` when updating an existing case so the case does not
 * conflict with itself.
 */
async function checkBarcodeUniqueness(
  barcode: string,
  labOrganizationId: string,
  excludeCaseId?: string,
): Promise<void> {
  if (!barcode) return;
  const conflicting = await db.query.cases.findFirst({
    where: and(
      eq(cases.labOrganizationId, labOrganizationId),
      eq(cases.casePanBarcode, barcode),
      notDeleted(cases),
      ne(cases.status, "complete"),
      ...(excludeCaseId ? [ne(cases.id, excludeCaseId)] : []),
    ),
    columns: { id: true, caseNumber: true },
  });
  if (conflicting) {
    throw new HttpError(
      409,
      `Barcode "${barcode}" is already assigned to case #${conflicting.caseNumber}. Each barcode can only be assigned to one active case at a time.`,
    );
  }
}

/**
 * Translate a PG unique-violation (23505) raised by the
 * `cases_barcode_unique_per_lab` partial index into the same 409 the
 * `checkBarcodeUniqueness` pre-check returns. The DB constraint is the
 * authoritative guard that closes the TOCTOU race between the pre-check
 * SELECT and the INSERT/UPDATE; the pre-check remains as a fast-path that
 * names the conflicting case for a friendlier message. Re-throws anything
 * else (including the unrelated `cases_case_number_unique` violation).
 */
export function rethrowBarcodeConflict(err: unknown, barcode: string): never {
  // Drizzle ORM (node-postgres adapter) wraps the raw pg error in a
  // DrizzleQueryError whose `cause` holds the original pg DatabaseError.
  // Check both the top-level error and `cause` so the constraint name is
  // found regardless of the wrapper version.
  const pgLike =
    err != null && typeof err === "object"
      ? "code" in err
        ? err
        : "cause" in err &&
            err.cause != null &&
            typeof err.cause === "object" &&
            "code" in err.cause
          ? err.cause
          : null
      : null;

  if (pgLike != null && (pgLike as { code: unknown }).code === "23505") {
    const constraint = "constraint" in pgLike
      ? (pgLike as { constraint: unknown }).constraint
      : null;
    if (constraint === "cases_barcode_unique_per_lab") {
      throw new HttpError(
        409,
        `Barcode "${barcode}" is already assigned to another active case. Each barcode can only be assigned to one active case at a time.`,
      );
    }
    if (constraint === "cases_case_number_unique") {
      throw new HttpError(
        409,
        "A case with this number already exists in this lab. If you are creating a remake the server assigns the suffix letter automatically — please try again.",
      );
    }
  }
  wrapDbError(err, {
    fallback: "Failed to save case. Please try again.",
  });
}

/**
 * Test-only TOCTOU barrier. Exported as a mutable object so tests can assign
 * `barcodeWriteHook` after import (exported `let` bindings are read-only in
 * ES modules). Set `barcodeWriteHook` to an async function that blocks after
 * `checkBarcodeUniqueness` clears but before the DB write. A latch that waits
 * for N callers lets tests guarantee both requests pass the pre-check before
 * either write reaches the DB, making the unique-index race deterministic.
 *
 * Always no-op in production (`barcodeWriteHook` is `undefined`).
 * Must be reset to `undefined` in test cleanup.
 */
export const _testHooks: {
  barcodeWriteHook: (() => Promise<void>) | undefined;
  locationHistoryWriteHook: (() => Promise<void>) | undefined;
  promotionLockedHook: (() => Promise<void>) | undefined;
} = {
  barcodeWriteHook: undefined,
  locationHistoryWriteHook: undefined,
  promotionLockedHook: undefined,
};

const ATTACHMENT_VISIBILITIES = [
  "shared_with_provider",
  "internal_lab_only",
] as const;

/**
 * Validate an optional `caseExceptionId` supplied when registering an
 * attachment.
 *
 * Returns the id when it names an ACTIVE exception belonging to this exact
 * case identity (canonical or legacy) AND the uploader is an active member of
 * the exception's own lab.
 *
 * The membership check is NOT redundant with the caller's case-access check.
 * The attachment routes admit providers through a provider-organization
 * fallback, so "can attach to this case" is strictly weaker than "may take
 * part in this lab's internal exception". Without this gate a provider could
 * push arbitrary content into a lab exception it cannot even read.
 */
async function resolveAttachmentExceptionId(
  caseExceptionId: string | undefined,
  caseIdentity: string,
  userId: string,
): Promise<string | null> {
  if (!caseExceptionId) return null;
  const row = await db.query.caseExceptions.findFirst({
    where: eq(caseExceptions.id, caseExceptionId),
  });
  if (!row || row.status !== "active") {
    throw new HttpError(404, "Exception not found.");
  }
  if (row.caseId !== caseIdentity && row.labCaseId !== caseIdentity) {
    throw new HttpError(400, "Exception does not belong to this case.");
  }
  const membership = await db.query.organizationMemberships.findFirst({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.labId, row.labOrganizationId),
      eq(organizationMemberships.status, "active"),
    ),
  });
  if (!membership) {
    throw new HttpError(
      403,
      "Only members of this lab can add exception attachments.",
    );
  }
  return row.id;
}

function visibleAttachmentsFor(
  attachments: any[],
  isLabMember: boolean
): any[] {
  if (isLabMember) return attachments;
  return attachments.filter(
    (a: any) => a.visibility !== "internal_lab_only"
  );
}

const MAX_PLY_TEXTURE_HEADER_BYTES = 1024 * 1024;

/**
 * Read only the bounded PLY header from the server-owned case-media file.
 * Attachment storage keys are reduced to a case-media basename first; they
 * are never fetched as URLs.
 */
async function readPlyTextureHeader(storageKey: string): Promise<Buffer | null> {
  const filename = extractMediaFileName(storageKey);
  if (!filename) return null;
  const mediaRoot = path.resolve(caseMediaDir);
  const filePath = path.resolve(mediaRoot, filename);
  if (!filePath.startsWith(`${mediaRoot}${path.sep}`)) return null;

  try {
    const handle = await fs.promises.open(filePath, "r");
    try {
      const header = Buffer.alloc(MAX_PLY_TEXTURE_HEADER_BYTES);
      const { bytesRead } = await handle.read(
        header,
        0,
        MAX_PLY_TEXTURE_HEADER_BYTES,
        0,
      );
      return header.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") return null;
  }

  try {
    const object = await openCaseMediaObjectStream(filename);
    if (!object) return null;
    const stream = object.stream as AsyncIterable<Uint8Array> & {
      destroy?: () => void;
    };
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      const remaining = MAX_PLY_TEXTURE_HEADER_BYTES - size;
      if (remaining <= 0) break;
      const accepted = bytes.subarray(0, remaining);
      chunks.push(accepted);
      size += accepted.length;
      if (size >= MAX_PLY_TEXTURE_HEADER_BYTES) {
        stream.destroy?.();
        break;
      }
    }
    return Buffer.concat(chunks, size);
  } catch {
    return null;
  }
}

/**
 * Pair direct-upload PLYs with exactly one matching image already registered
 * on this same case. Linking is metadata-only; normal list/file authorization
 * and visibility checks continue to control whether a viewer can load it.
 */
async function linkPlyTexturesForCase(caseId: string): Promise<void> {
  const attachments = await db.query.caseAttachments.findMany({
    where: and(
      or(
        eq(caseAttachments.caseId, caseId),
        eq(caseAttachments.labCaseId, caseId),
      ),
      isNull(caseAttachments.deletedAt),
    ),
    columns: {
      id: true,
      fileName: true,
      fileType: true,
      storageKey: true,
      textureAttachmentId: true,
    },
  });
  const plyAttachments = attachments.filter((attachment: any) =>
    String(attachment.fileName ?? "").toLowerCase().endsWith(".ply"),
  );
  if (plyAttachments.length === 0) return;

  const imageAttachments = attachments.filter((attachment: any) =>
    /^image\//i.test(String(attachment.fileType ?? "")),
  );
  if (imageAttachments.length === 0) return;

  const plyEntries = await Promise.all(
    plyAttachments.map(async (attachment: any) => ({
      attachment,
      data: await readPlyTextureHeader(attachment.storageKey),
    })),
  );
  const entries = [
    ...plyEntries.map(({ attachment, data }) => ({
      name: attachment.fileName,
      data: data ?? Buffer.alloc(0),
      mimeType: attachment.fileType ?? "application/octet-stream",
    })),
    ...imageAttachments.map((attachment: any) => ({
      name: attachment.fileName,
      data: Buffer.alloc(0),
      mimeType: attachment.fileType ?? "application/octet-stream",
    })),
  ];
  const pairs = pairPlyTextures(entries);
  const plysByName = new Map<string, any[]>();
  const imagesByName = new Map<string, any[]>();
  for (const attachment of plyAttachments) {
    const rows = plysByName.get(attachment.fileName) ?? [];
    rows.push(attachment);
    plysByName.set(attachment.fileName, rows);
  }
  for (const attachment of imageAttachments) {
    const rows = imagesByName.get(attachment.fileName) ?? [];
    rows.push(attachment);
    imagesByName.set(attachment.fileName, rows);
  }

  const readableDeclaredPlys = new Set(
    plyEntries
      .filter(({ data }) => data !== null && declaredPlyTexture(data) !== null)
      .map(({ attachment }) => attachment.id),
  );
  const desiredTextureByPlyId = new Map<string, string>();
  for (const [plyName, imageName] of pairs) {
    const scans = plysByName.get(plyName) ?? [];
    const images = imagesByName.get(imageName) ?? [];
    if (scans.length !== 1 || images.length !== 1) continue;
    desiredTextureByPlyId.set(scans[0]!.id, images[0]!.id);
  }

  for (const scan of plyAttachments) {
    if (!readableDeclaredPlys.has(scan.id)) continue;
    const desiredTextureId = desiredTextureByPlyId.get(scan.id) ?? null;
    if (scan.textureAttachmentId === desiredTextureId) continue;
    await db.update(caseAttachments)
      .set({ textureAttachmentId: desiredTextureId })
      .where(and(
        eq(caseAttachments.id, scan.id),
        or(
          eq(caseAttachments.caseId, caseId),
          eq(caseAttachments.labCaseId, caseId),
        ),
        isNull(caseAttachments.deletedAt),
      ));
  }
}

/**
 * Do not trust a persisted texture pointer as an authorization grant. Lists
 * only expose a pointer when the texture is live, belongs to the same case
 * identity, and is visible to this caller.
 */
async function sanitizeTextureAttachmentLinks(
  attachments: any[],
  caseId: string,
  isLabMember: boolean,
): Promise<any[]> {
  const ids = Array.from(new Set(
    attachments.map((a) => a.textureAttachmentId).filter((id): id is string => typeof id === "string" && id.length > 0),
  ));
  if (!ids.length) return attachments;
  const textures = await db.query.caseAttachments.findMany({
    where: and(inArray(caseAttachments.id, ids), isNull(caseAttachments.deletedAt)),
  });
  const valid = new Set(textures
    .filter((texture: any) =>
      (texture.caseId === caseId || texture.labCaseId === caseId) &&
      (isLabMember || texture.visibility !== "internal_lab_only"),
    )
    .map((texture: any) => texture.id));
  return attachments.map((attachment) =>
    valid.has(attachment.textureAttachmentId)
      ? attachment
      : { ...attachment, textureAttachmentId: null },
  );
}

async function enrichScanAttachments(attachments: any[]): Promise<any[]> {
  const scanJobIds = Array.from(new Set(
    attachments
      .map((attachment) => String(attachment.id ?? "").match(/^scan-(.+)-(ply|stl)$/)?.[1])
      .filter((id): id is string => Boolean(id)),
  ));
  if (!scanJobIds.length) return attachments;
  const jobs = await db
    .select({ id: scanJobs.id, manifestJson: scanJobs.manifestJson, qualityJson: scanJobs.qualityJson })
    .from(scanJobs)
    .where(inArray(scanJobs.id, scanJobIds));
  const byId = new Map(jobs.map((job: any) => [job.id, job]));
  return attachments.map((attachment) => {
    const jobId = String(attachment.id ?? "").match(/^scan-(.+)-(ply|stl)$/)?.[1];
    const job = jobId ? byId.get(jobId) : undefined;
    if (!job) return attachment;
    const quality = job.qualityJson && typeof job.qualityJson === "object" ? job.qualityJson : {};
    const manifest = job.manifestJson && typeof job.manifestJson === "object" ? job.manifestJson : {};
    const objectCondition =
      manifest.objectCondition === "simple-matte" ||
      manifest.objectCondition === "dental-complex" ||
      manifest.objectCondition === "reflective-or-translucent"
        ? manifest.objectCondition
        : null;
    const range = quality.estimatedErrorRangeMm;
    const estimatedErrorRangeMm =
      range &&
      typeof range === "object" &&
      typeof range.min === "number" &&
      Number.isFinite(range.min) &&
      typeof range.max === "number" &&
      Number.isFinite(range.max) &&
      range.min >= 0 &&
      range.max >= range.min
        ? { min: range.min, max: range.max }
        : null;
    return {
      ...attachment,
      scanAccuracy: {
        objectCondition,
        // A range is meaningful only when the scan condition was verified.
        // Invalid or legacy values stay explicitly unmeasured rather than
        // being rendered as a fabricated measurement.
        estimatedErrorRangeMm: objectCondition ? estimatedErrorRangeMm : null,
        accuracyProfile: quality.accuracyProfile ?? null,
        disclaimer: quality.disclaimer ?? null,
      },
    };
  });
}

// Notes carry the same `internal_lab_only` / `shared_with_provider` visibility
// as attachments. Non-lab viewers (providers / read-only users) must never
// receive internal lab-only note bodies, so the notes payload is filtered the
// same way `visibleAttachmentsFor` filters attachments.
function visibleNotesFor(notes: any[], isLabMember: boolean): any[] {
  if (isLabMember) return notes;
  // Provider/practice viewers get an explicit allow-list. Historical rows with
  // a missing or future visibility value are not safe to expose by default.
  return notes.filter((n: any) => n.visibility === "shared_with_provider");
}

// `note_added` history events embed the note body (`noteText`) in their
// metadata so the History timeline can render it without a second lookup. For
// non-lab viewers we strip that body from internal lab-only note events so the
// case-detail payload can never leak an internal note's text through raw event
// metadata. The event itself (and its visibility label) is preserved; only the
// withheld body fields are removed.
// Event types that describe the lab's internal exception workflow. Providers
// have no part in it, so the events are dropped entirely rather than
// field-sanitized — that way a metadata field added later can't leak by
// default.
const INTERNAL_EXCEPTION_EVENT_TYPES = new Set<string>(
  INTERNAL_EXCEPTION_HISTORY_EVENT_TYPES,
);

// Attachment lifecycle events that name a file. Every one of them is
// provider-visible, so each must be stripped when the attachment is exception
// evidence. Kept as one list so a new attachment event type is handled here
// rather than being forgotten.
const ATTACHMENT_EVENT_TYPES = new Set([
  "case_attachment_added",
  "case_attachment_deleted",
]);

// Identifying/free-text fields that must never survive redaction on an
// exception-linked attachment event.
function stripExceptionAttachmentMetadata(
  metadataJson: unknown,
): Record<string, unknown> {
  const meta = (metadataJson ?? {}) as Record<string, unknown>;
  const {
    fileName: _fileName,
    note: _note,
    description: _description,
    storageKey: _storageKey,
    ...rest
  } = meta;
  return rest;
}

/**
 * True when an event describes an attachment that belongs to a case
 * exception. Attachment rows are soft-deleted, so a deletion event can't be
 * resolved back to its row reliably — the marker therefore travels in the
 * event metadata itself, written at every site that emits one.
 */
function isExceptionAttachmentEvent(ev: any): boolean {
  return (
    ATTACHMENT_EVENT_TYPES.has(ev?.eventType) &&
    Boolean((ev?.metadataJson as any)?.caseExceptionId)
  );
}

function isInternalExceptionEvent(ev: any): boolean {
  return (
    INTERNAL_EXCEPTION_EVENT_TYPES.has(ev?.eventType) ||
    Boolean((ev?.metadataJson as any)?.internalException)
  );
}

function sanitizeNoteEventsFor(events: any[], isLabMember: boolean): any[] {
  if (isLabMember) return events;
  return events
    .filter((ev: any) => !isInternalExceptionEvent(ev))
    .map((ev: any) => {
    // Exception evidence is lab-internal. The write paths already omit the
    // file name, but the note is re-attached downstream from the live
    // attachment row, so the strip has to happen here — after that
    // enrichment and on every attachment event type, not just "added".
    if (isExceptionAttachmentEvent(ev)) {
      return { ...ev, metadataJson: stripExceptionAttachmentMetadata(ev.metadataJson) };
    }
    if (ev?.eventType !== "note_added") return ev;
    const meta = (ev.metadataJson ?? {}) as Record<string, unknown>;
    if (meta.visibility !== "internal_lab_only") return ev;
    const { noteText: _noteText, note: _note, description: _description, ...rest } = meta;
    return { ...ev, metadataJson: rest };
  });
}

// Stable string keys for the 18 structured remake reasons.
// Keys are grouped: crown_bridge category first, then removable.
// Never rename or remove a key — existing DB rows reference them.
export type { RemakeReasonKey };

/**
 * `other` is a structured reason category, but its display value remains the
 * caller's trimmed free-text explanation so existing timelines and invoices
 * continue to show a useful human-readable reason.
 */
export function validateCustomRemakeReason(
  reasonKey: string | null | undefined,
  reason: string | null | undefined,
): string | null {
  if (reasonKey !== "other") return reason == null ? null : reason;
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (!trimmed) {
    throw new HttpError(
      400,
      'remakeReason is required and cannot be blank when remakeReasonKey is "other".',
    );
  }
  if (trimmed.length > CUSTOM_REMAKE_REASON_MAX_LENGTH) {
    throw new HttpError(
      400,
      `remakeReason must be at most ${CUSTOM_REMAKE_REASON_MAX_LENGTH} characters when remakeReasonKey is "other".`,
    );
  }
  return trimmed;
}

// ── Category sets — used for auto-inference when caller omits remakeCategory ─
/** Infer `remakeCategory` from the reason key when the caller omits it. */
function inferRemakeCategory(
  key: string | null | undefined,
): "crown_bridge" | "removable" | null {
  return getRemakeReason(key)?.category ?? null;
}

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
function normalizeDueDateForInputServer(value: string): string | null {
  const trimmed = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? trimmed
    : (() => {
        const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
        return match
          ? `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`
          : null;
      })();
  return iso && isValidCalendarDate(iso) ? iso : null;
}
function parseCalendarDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!isValidCalendarDate(value)) {
    throw new HttpError(400, "receivedAt is not a valid calendar date.");
  }
  return value;
}

const reviewedInvoiceChildSchema = z.object({
  description: z.string().min(1),
  quantity: z.coerce.number().int().positive(),
  unitPrice: z.coerce.number().min(0),
});
const reviewedInvoiceLinesSchema = z.array(z.object({
  description: z.string().min(1),
  quantity: z.coerce.number().int().positive(),
  unitPrice: z.coerce.number().min(0),
  catalogItemKey: z.string().min(1).nullable().optional(),
  subItems: z.array(reviewedInvoiceChildSchema).optional(),
})).optional();

const multipartReviewedInvoiceLines = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}, reviewedInvoiceLinesSchema);

function reviewedLinesToInvoiceItems(
  lines: Array<{ description: string; quantity: number; unitPrice: number; catalogItemKey?: string | null; subItems?: Array<{ description: string; quantity: number; unitPrice: number }> }>,
  invoiceId: string,
) {
  return lines.map((line, sortOrder) => ({
    invoiceId,
    caseRestorationId: null,
    toothNumber: null,
    toothLabel: null,
    description: line.description,
    sourceType: "manual" as const,
    sourceKey: line.catalogItemKey ? `catalog:${line.catalogItemKey}` : undefined,
    quantity: line.quantity,
    unitPrice: line.unitPrice.toFixed(2),
    lineTotal: (line.quantity * line.unitPrice).toFixed(2),
    sortOrder,
    catalogItemKey: line.catalogItemKey ?? null,
    catalogItemLabel: line.description,
    missingCatalogItem: false,
    childItems: (line.subItems ?? []).map((child) => ({
      caseRestorationId: null,
      sourceType: "manual" as const,
      description: child.description,
      quantity: child.quantity,
      unitPrice: child.unitPrice.toFixed(2),
      lineTotal: (child.quantity * child.unitPrice).toFixed(2),
    })),
  }));
}

const createCaseSchema = z.object({
  // Optional for remake cases — server assigns the suffixed number (e.g. "26-11B").
  // Required for non-remake cases. Empty strings are treated as omitted.
  caseNumber: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  labOrganizationId: z.string(),
  providerOrganizationId: z.string(),
  patientFirstName: z.string().min(1),
  patientLastName: z.string().min(1),
  externalPatientId: z.string().optional(),
  doctorName: z.string().min(1),
  status: z
    .enum([
      "received",
      "in_design",
      "in_milling",
      "in_porcelain",
      "qc",
      "shipped",
      "delivered",
      "on_hold",
      "remake",
      "cancelled",
    ])
    .default("received"),
  priority: z.enum(["normal", "rush"]).default("normal"),
  // Client-provided intake timestamp.  This is the timestamp the case was
  // received, not the database insertion time (important for imports and
  // today's sales/worklist reporting).
  receivedAt: calendarDate.optional(),
  scanDate: calendarDate.optional(),
  prescriptionDueDate: calendarDate.optional(),
  dueDate: z.string().nullable().optional(),
  // The desktop AI review explicitly supplies the dates shown to staff. Keep
  // that reviewed lab schedule authoritative instead of applying the generic
  // create route's current-date cap a second time.
  aiIntakeReviewedDates: z.literal(true).optional(),
  providerContactSnapshot: z.record(z.string(), z.unknown()).optional(),
  invoiceNotes: z.string().max(10_000).optional(),
  bridgeConnectors: z.string().max(1024).optional(),
  dueTime: z
    .union([z.string().refine(isValidDueTime, "Invalid due time"), z.null()])
    .optional(),
  restorations: z
    .array(
      z.object({
        // Empty toothNumber is allowed for stub restorations created when
        // the AI extracts material/shade/type but no specific tooth indices
        // (mirrors the iTero import fallback at ~line 6950).
        toothNumber: z.string(),
        restorationType: z.string().min(1),
        assignmentProvenance: z.object({
          origin: z.enum(["manual", "ai_explicit"]),
          roleEvidence: z.string().max(2000).optional(),
          manualFields: z.array(z.enum(["role", "product", "shade"])).max(3),
        }).optional(),
        ...implantInputFields,
        material: z.string().optional(),
        shade: z.string().optional(),
        notes: z.string().optional(),
        quantity: z.coerce.number().int().positive().default(1),
        unitPrice: z.coerce.number().min(0).default(0),
        // When true, treat unitPrice as a user-supplied manual price even when
        // it is 0 (an intentional no-charge line), so server auto-pricing does
        // NOT overwrite it. Without this flag a 0 unitPrice always auto-prices,
        // which made inline "no charge" edits in the draft-invoice preview
        // impossible to honour. Defaults to undefined → unchanged behaviour.
        priceOverridden: z.boolean().optional(),
        // Encoded taxonomy key: "<caseType>/<subtype>" or
        // "<caseType>/<subtype>/<materialSubtype>" (from @workspace/case-taxonomy).
        // Optional — old clients omit it; when present it is stored verbatim.
        restorationSubtype: z.string().optional(),
        arch: z.enum(ARCH_VALUES).nullable().optional(),
      })
    )
    .optional(),
  // Remake / duplicate-detection fields. When `remakeOfCaseId` is set the
  // server links the new case to its predecessor and writes case_events on
  // both. `remakeCharged === false` skips auto-invoice generation (a $0
  // no-charge invoice may still be added later from the UI).
  remakeOfCaseId: z.string().optional(),
  remakeReason: z.string().min(1).max(2000).optional(),
  remakeCharged: z.boolean().optional(),
  // Structured remake questionnaire fields.
  remakeReasonKey: z.enum(REMAKE_REASON_KEYS).optional(),
  remakeShadeLightness: z.enum(["light", "dark"]).optional(),
  remakeShadePrescribed: z.string().max(200).optional(),
  remakeShadeProvided: z.string().max(200).optional(),
  remakeMaterialPrescribed: z.string().max(200).optional(),
  remakeMaterialProvided: z.string().max(200).optional(),
  remakeReturnedToLab: z.boolean().optional(),
  remakeCategory: z.enum(["crown_bridge", "removable"]).optional(),
  // Free-text technician notes for the remake (admin/owner only).
  remakeNotes: z.string().max(2000).optional(),
  // Prescription text is stored in the dated Rx history, not case_notes.
  rxNotes: z.string().min(1).max(10_000).optional(),
  // Authored case notes remain in the general case-notes timeline.
  notes: z.string().min(1).max(8000).optional(),
  // Optional barcode to assign to the case pan at creation time.
  // Empty strings are treated as omitted (no barcode assigned).
  casePanBarcode: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  // Top-level shade extracted from the Rx (stored directly on the case row so
  // it's visible in the overview even when no tooth indices were identified).
  shade: z.string().optional(),
  // Gingival/tissue shade for removable cases (e.g. "Medium Pink"). Only set
  // when the AI or the user identifies it from the Rx. Omitting the field is
  // the same as passing null — no value is stored.
  gingivialShade: z.string().max(200).nullable().optional(),
  // When true, bypass the pre-create duplicate-doctor confirmation checkpoint.
  // The server normally rejects a create whose doctorName strongly resembles an
  // existing doctor in the same practice with a structured 409 listing the
  // candidate matches; the client re-submits with this flag once the user has
  // explicitly chosen "add a new doctor". Defaults to undefined → check runs.
  confirmNewDoctor: z.boolean().optional(),
  // Lab workflow step for removable cases. Carried forward from the AI Rx
  // reader when the AI infers it; users can also set it from the confirmation
  // screen before creating the case. Only the four known enum values are
  // accepted; anything else is rejected with a 400 (Zod strips unknown values
  // from the request before it reaches this schema so an unrecognized string
  // simply fails the .enum() check and returns a validation error).
  step: z
    .enum(["custom_tray", "rims_and_plates", "wax_setup", "process"])
    .nullable()
    .optional(),
  // Admin/owner only. When present and non-empty, these lines are used verbatim
  // as the invoice's initial line items in place of the auto-pricing engine.
  // The server silently ignores this field for non-admin/owner callers so an
  // inadvertent client send never causes a 400. Each line must have a non-empty
  // description, a positive integer quantity, and a non-negative unit price.
  invoiceOverrideLines: reviewedInvoiceLinesSchema,
}).refine(
  // caseNumber is required for non-remake cases; server assigns it for remakes.
  (v) => !!v.remakeOfCaseId || (typeof v.caseNumber === "string" && v.caseNumber.trim().length > 0),
  { message: "caseNumber is required for non-remake cases.", path: ["caseNumber"] },
).refine(
  (v) => !v.remakeOfCaseId || (typeof v.remakeReason === "string" && v.remakeReason.trim().length > 0),
  { message: "remakeReason is required when remakeOfCaseId is set.", path: ["remakeReason"] },
).refine(
  (v) => !v.remakeOfCaseId || typeof v.remakeCharged === "boolean",
  { message: "remakeCharged (true/false) is required when remakeOfCaseId is set.", path: ["remakeCharged"] },
);

// ---------------------------------------------------------------------------
// Pre-create duplicate-doctor detection.
//
// A "doctor" is not a standalone record — it is a distinct
// (doctorName, providerOrganizationId) pair on `cases` rows. When a user types
// a free-text doctor name that strongly resembles an existing doctor in the
// SAME practice (e.g. "Kanesha Cole" vs "Dr. Kanesha Cole"), saving silently
// would split pricing/invoicing across two effective doctors. This helper finds
// the likely existing matches above the lab's similarity threshold so the
// client (and the POST /cases enforcement) can ask the user which doctor they
// mean BEFORE the case is saved, reusing the exact same fuzzy matching that
// powers the duplicate-doctors panel.
//
// Scoping: matching is restricted to the selected practice
// (providerOrganizationId) so the same name at a different practice is not
// falsely flagged. A literal (case-insensitive, trimmed) exact name match is
// never flagged — that is the user picking an existing doctor verbatim.
// ---------------------------------------------------------------------------
export interface DoctorMatchCandidate {
  doctorName: string;
  providerOrganizationId: string | null;
  similarity: number;
  totalCases: number;
}

async function findSimilarDoctorsInPractice(
  labOrganizationId: string,
  providerOrganizationId: string,
  doctorName: string,
): Promise<DoctorMatchCandidate[]> {
  const typed = doctorName.trim();
  if (!typed) return [];

  // Resolve the lab's configured suggestion threshold (defaults to 0.7).
  const labOrg = await db.query.organizations.findFirst({
    where: eq(organizations.id, labOrganizationId),
    columns: { duplicateSuggestionThreshold: true },
  });
  const threshold = resolveLabDupThreshold(
    labOrg?.duplicateSuggestionThreshold ?? null,
  );

  // Distinct doctor-name groups for this (lab, practice).
  const groups = await db
    .select({
      doctorName: cases.doctorName,
      totalCases: sql<number>`count(*)::int`.as("total"),
    })
    .from(cases)
    .where(
      and(
        eq(cases.labOrganizationId, labOrganizationId),
        eq(cases.providerOrganizationId, providerOrganizationId),
        notDeleted(cases),
        sql`${cases.doctorName} is not null and trim(${cases.doctorName}) <> ''`,
      ),
    )
    .groupBy(cases.doctorName);

  const typedLower = typed.toLowerCase();
  const matches: DoctorMatchCandidate[] = [];
  for (const g of groups) {
    const existing = (g.doctorName ?? "").trim();
    if (!existing) continue;
    // Literal exact match → the user is reusing an existing doctor; never flag.
    if (existing.toLowerCase() === typedLower) continue;
    const sim = _bigramSimilarity(typed, existing);
    if (sim >= threshold) {
      matches.push({
        doctorName: existing,
        providerOrganizationId,
        similarity: sim,
        totalCases: g.totalCases,
      });
    }
  }
  matches.sort((a, b) => b.similarity - a.similarity);
  return matches;
}

/**
 * iTero auto-import duplicate-doctor guard.
 *
 * The manual "create a case" flow rejects near-duplicate doctor names with a
 * 409 so a human can confirm. The iTero auto-import paths have no human typing
 * a name at create time, so instead of rejecting we auto-merge: when the parsed
 * doctor name is a near-duplicate (>= the lab's similarity threshold) of an
 * existing doctor in the SAME practice, we adopt the existing spelling rather
 * than silently creating a new doctor (e.g. "Dr. Jane Smith" → "Jane Smith").
 *
 * Safety: this reuses `findSimilarDoctorsInPractice`, which honors the per-lab
 * threshold and NEVER returns a literal-exact match, so we never merge below
 * the lab threshold and never rewrite a name that already matches exactly. The
 * "Unknown Doctor" placeholder is left untouched. When no match clears the
 * threshold the parsed name is kept verbatim and surfaced for review via the
 * existing `suggestedDoctorName` banner.
 */
async function resolveIteroDoctorAutoMerge(
  labOrganizationId: string,
  providerOrganizationId: string,
  parsedDoctorName: string,
): Promise<{
  doctorName: string;
  autoMergedFrom: string | null;
  similarity: number | null;
}> {
  const trimmed = (parsedDoctorName ?? "").trim();
  if (!trimmed || trimmed === "Unknown Doctor") {
    return { doctorName: parsedDoctorName, autoMergedFrom: null, similarity: null };
  }
  const matches = await findSimilarDoctorsInPractice(
    labOrganizationId,
    providerOrganizationId,
    trimmed,
  );
  if (matches.length === 0) {
    return { doctorName: parsedDoctorName, autoMergedFrom: null, similarity: null };
  }
  // findSimilarDoctorsInPractice returns matches sorted by descending
  // similarity, so the first entry is the closest existing doctor.
  const best = matches[0]!;
  return {
    doctorName: best.doctorName,
    autoMergedFrom: trimmed,
    similarity: best.similarity,
  };
}

export interface PatientSimilarityHit {
  id: string;
  source: "canonical" | "legacy";
  labOrganizationId: string;
  caseNumber: string;
  patientFirstName: string;
  patientLastName: string;
  doctorName: string;
  status: string;
  matchKind: SimilarityMatchKind;
  createdAt: string | null;
  dueDate: string | null;
  toothNumbers: string;
  restorationTypes: string;
  shade: string;
  material: string;
  hasInvoice: boolean;
  invoiceTotal: string | null;
  invoiceStatus: string | null;
}

const patientSimilarityQuerySchema = z.object({
  patientFirstName: z.string().min(1),
  patientLastName: z.string().min(1),
  // The lab the caller is searching within. Required: every search is
  // scoped to a single lab the caller is a member of, so the endpoint
  // cannot be used to enumerate patient names across tenants.
  labOrganizationId: z.string().min(1),
  // Optional further-narrow to a specific provider org. Must also be
  // tied to the same lab via existing cases (verified at query time).
  providerOrganizationId: z.string().optional(),
  doctorName: z.string().optional(),
});

const doctorSimilarityQuerySchema = z.object({
  labOrganizationId: z.string().min(1),
  providerOrganizationId: z.string().min(1),
  doctorName: z.string().min(1),
});

// GET /cases/doctor-similarity
// Pre-submit checkpoint: returns existing doctors in the same practice whose
// name strongly resembles the typed name (above the lab threshold), excluding a
// literal exact match. Clients call this before saving so they can ask the user
// which doctor they mean; POST /cases enforces the same check as a fallback.
router.get(
  "/doctor-similarity",
  asyncHandler(async (req, res) => {
    const params = doctorSimilarityQuerySchema.parse({
      labOrganizationId: String(req.query.labOrganizationId ?? ""),
      providerOrganizationId: String(req.query.providerOrganizationId ?? ""),
      doctorName: String(req.query.doctorName ?? ""),
    });

    const userId = (req as any).auth.userId as string;
    // Authorization: caller MUST be an active member of the lab they're
    // searching. Results are scoped to that lab + practice only.
    await requireMembership(userId, params.labOrganizationId);

    const matches = await findSimilarDoctorsInPractice(
      params.labOrganizationId,
      params.providerOrganizationId,
      params.doctorName,
    );
    ok(res, { matches });
  }),
);

router.get(
  "/patient-similarity",
  asyncHandler(async (req, res) => {
    const params = patientSimilarityQuerySchema.parse({
      patientFirstName: String(req.query.patientFirstName ?? ""),
      patientLastName: String(req.query.patientLastName ?? ""),
      providerOrganizationId: req.query.providerOrganizationId
        ? String(req.query.providerOrganizationId)
        : undefined,
      labOrganizationId: String(req.query.labOrganizationId ?? ""),
      doctorName: req.query.doctorName ? String(req.query.doctorName) : undefined,
    });

    const userId = (req as any).auth.userId as string;

    // Authorization: caller MUST be an active member of the lab they're
    // searching. Every result is scoped to that lab — there is no path
    // to read patient names from another tenant by passing a different
    // providerOrganizationId.
    await requireMembership(userId, params.labOrganizationId);

    // Pull a bounded candidate set (filtered by lastName ILIKE prefix to
    // keep the scan tight) and classify in memory. We deliberately do the
    // fuzzy / nickname work in JS rather than SQL because the rules need
    // to match the mobile client's behavior exactly.
    const lastNamePrefix = params.patientLastName.trim().slice(0, 3);

    // Provider scoping rules — same-provider-organization is the spec:
    //   * If `providerOrganizationId` is supplied (canonical/desktop path),
    //     filter strictly by it.
    //   * Otherwise (legacy mobile path, where the client only knows the
    //     doctor name) fall back to a doctor-name ILIKE match on canonical
    //     rows so we don't surface every other provider's patients in
    //     the lab. Without this fallback a mobile user could see prior
    //     case names from unrelated providers in the same lab.
    // No row caps on either query: Task #331 explicitly requires
    // remakes from years ago to still be detected, so we MUST NOT
    // truncate the candidate set before classification. The lastName
    // ILIKE prefix + lab/provider/doctor scope keeps this bounded to
    // patients with a similar surname inside a single tenant, which
    // is small enough in practice to scan in full.
    const canonicalRows = await db.query.cases.findMany({
      where: and(
        eq(cases.labOrganizationId, params.labOrganizationId),
        params.providerOrganizationId
          ? eq(cases.providerOrganizationId, params.providerOrganizationId)
          : params.doctorName
            ? sql`lower(${cases.doctorName}) = ${params.doctorName.trim().toLowerCase()}`
            : undefined,
        notDeleted(cases),
        sql`lower(${cases.patientLastName}) like ${`${lastNamePrefix.toLowerCase()}%`}`,
      ),
      orderBy: [desc(cases.createdAt)],
    });

    const legacyRows = await db
      .select()
      .from(labCases)
      .where(
        and(
          eq(labCases.organizationId, params.labOrganizationId),
          isNull(labCases.deletedAt),
        ),
      );

    const candidateIds = canonicalRows.map((r: any) => r.id);
    const restorations = candidateIds.length
      ? await db.query.caseRestorations.findMany({
          where: inArray(caseRestorations.caseId, candidateIds),
        })
      : [];
    const invoiceRows = candidateIds.length
      ? await db
          .select({
            caseId: invoices.caseId,
            total: invoices.total,
            status: invoices.status,
          })
          .from(invoices)
          .where(
            and(
              inArray(invoices.caseId, candidateIds),
              isNull(invoices.voidedAt),
            ),
          )
      : [];
    // Build a per-case invoice map.
    const invoiceMap = new Map<string, { total: string; status: string }>();
    for (const row of invoiceRows) {
      if (!row.caseId) continue;
      if (!invoiceMap.has(row.caseId)) {
        invoiceMap.set(row.caseId, { total: row.total ?? "0.00", status: row.status });
      }
    }
    const restByCase = new Map<string, typeof restorations>();
    for (const r of restorations) {
      const list = restByCase.get(r.caseId) ?? [];
      list.push(r);
      restByCase.set(r.caseId, list);
    }

    const hits: PatientSimilarityHit[] = [];

    for (const row of canonicalRows as any[]) {
      const kind = classifyMatch(
        params.patientFirstName,
        params.patientLastName,
        { firstName: row.patientFirstName, lastName: row.patientLastName },
      );
      if (!kind) continue;
      const items = restByCase.get(row.id) ?? [];
      const inv = invoiceMap.get(row.id);
      hits.push({
        id: row.id,
        source: "canonical",
        labOrganizationId: params.labOrganizationId,
        caseNumber: row.caseNumber,
        patientFirstName: row.patientFirstName,
        patientLastName: row.patientLastName,
        doctorName: row.doctorName,
        status: row.status,
        matchKind: kind,
        createdAt: row.createdAt
          ? new Date(row.createdAt).toISOString()
          : null,
        dueDate: row.dueDate ? new Date(row.dueDate).toISOString() : null,
        toothNumbers: items
          .map((i: any) => i.toothNumber)
          .filter(Boolean)
          .join(", "),
        restorationTypes: Array.from(
          new Set(items.map((i: any) => i.restorationType).filter(Boolean)),
        ).join(", "),
        shade: Array.from(
          new Set(items.map((i: any) => i.shade).filter(Boolean)),
        ).join(", "),
        material: Array.from(
          new Set(items.map((i: any) => i.material).filter(Boolean)),
        ).join(", "),
        hasInvoice: !!inv,
        invoiceTotal: inv?.total ?? null,
        invoiceStatus: inv?.status ?? null,
      });
    }

    const wantDoctor = params.doctorName?.trim().toLowerCase() ?? "";
    // Provider-org scoping for legacy candidates: when the caller passed
    // a providerOrganizationId, derive the set of doctor names known to
    // belong to that provider org from canonical cases (legacy lab_cases
    // have no providerOrganizationId column). A legacy candidate is only
    // returned if its doctorName matches that set OR matches the
    // explicit doctorName param. This honors the spec requirement that
    // matching is scoped to the same provider organization.
    const providerDoctorSet = params.providerOrganizationId
      ? await getDoctorNameSetForProviderOrg(
          params.labOrganizationId,
          params.providerOrganizationId,
        )
      : null;
    // Fallback: when the provider has no canonical history (so the
    // derived set is empty), still allow legacy candidates whose
    // doctorName matches the explicit `doctorName` param. This keeps
    // legacy-only providers from being silently ignored.
    if (providerDoctorSet && wantDoctor) {
      providerDoctorSet.add(wantDoctor);
    }
    for (const lr of legacyRows as any[]) {
      try {
        const parsed =
          typeof lr.caseData === "string" ? JSON.parse(lr.caseData) : lr.caseData;
        if (!parsed || typeof parsed !== "object") continue;
        const split = splitDisplayName(parsed.patientName);
        const kind = classifyMatch(
          params.patientFirstName,
          params.patientLastName,
          { firstName: split.first, lastName: split.last },
        );
        if (!kind) continue;
        const candidateDoctor = String(parsed.doctorName ?? "")
          .trim()
          .toLowerCase();
        if (providerDoctorSet) {
          if (!candidateDoctor || !providerDoctorSet.has(candidateDoctor)) {
            continue;
          }
        } else if (wantDoctor && candidateDoctor !== wantDoctor) {
          // No providerOrganizationId — fall back to explicit doctorName
          // scope so legacy mobile path still respects the same-provider
          // boundary.
          continue;
        }
        hits.push({
          id: lr.id,
          source: "legacy",
          labOrganizationId: params.labOrganizationId,
          caseNumber: String(parsed.caseNumber ?? ""),
          patientFirstName: split.first,
          patientLastName: split.last,
          doctorName: String(parsed.doctorName ?? ""),
          status: String(parsed.status ?? ""),
          matchKind: kind,
          createdAt: parsed.createdAt
            ? new Date(parsed.createdAt).toISOString()
            : null,
          dueDate: parsed.dueDate ? String(parsed.dueDate) : null,
          toothNumbers: String(parsed.toothIndices ?? ""),
          restorationTypes: String(parsed.caseType ?? parsed.material ?? ""),
          shade: String(parsed.shade ?? ""),
          material: String(parsed.material ?? ""),
          hasInvoice: !!parsed.invoiceId,
          invoiceTotal: null,
          invoiceStatus: null,
        });
      } catch {
        // ignore malformed legacy payloads
      }
    }

    // ── Cross-lab expansion ─────────────────────────────────────────────────
    // When the caller identifies a provider org (or a doctorName that resolves
    // to one), look up linked doctor accounts at other labs and include their
    // patient history in the result.
    //
    // Authorization model:
    //  1. `requireMembership` already verified the caller can read
    //     `labOrganizationId`.
    //  2. Before expanding, we verify each provider org belongs to the caller's
    //     lab (`parentLabOrganizationId` match). This prevents a caller from
    //     supplying a foreign `providerOrganizationId` to pivot into unrelated
    //     tenants.
    //  3. Cross-lab results are scoped to the specific linked doctor's provider
    //     org, further narrowed by patient-name similarity — no full lab read.

    // Collect candidate provider org IDs to expand from.
    //   Desktop path: the explicit providerOrganizationId.
    //   Mobile / doctorName-only path: resolve from canonical cases in this lab.
    const providerOrgIdsToExpand: string[] = [];
    if (params.providerOrganizationId) {
      providerOrgIdsToExpand.push(params.providerOrganizationId);
    } else if (params.doctorName) {
      const doctorResolved = await db
        .selectDistinct({ providerOrgId: cases.providerOrganizationId })
        .from(cases)
        .where(
          and(
            eq(cases.labOrganizationId, params.labOrganizationId),
            sql`lower(${cases.doctorName}) = ${params.doctorName.trim().toLowerCase()}`,
            notDeleted(cases),
          ),
        );
      for (const r of doctorResolved as any[]) {
        if (r.providerOrgId) providerOrgIdsToExpand.push(r.providerOrgId as string);
      }
    }

    for (const provOrgId of providerOrgIdsToExpand) {
      // Authorization gate: the provider org must be owned by the caller's lab.
      const provOrgRow = await db.query.organizations.findFirst({
        where: eq(organizations.id, provOrgId),
      });
      if (
        !provOrgRow ||
        (provOrgRow as any).parentLabOrganizationId !== params.labOrganizationId
      ) {
        continue;
      }

      const linkedProviderOrgs = await getLinkedProviderOrgsForProviderOrg(
        provOrgId,
        params.labOrganizationId,
      );

      for (const { providerOrgId: linkedProvOrgId, labOrgId: linkedLabId } of linkedProviderOrgs) {
        // Authorization: the caller must have an active membership in the linked lab.
        // This mirrors the primary-lab requireMembership check — only labs the caller
        // can directly read are searched. Without this, any lab admin could pivot to
        // cross-tenant patient data via doctor links without a read grant on those labs.
        const linkedLabMembership = await db.query.organizationMemberships.findFirst({
          where: and(
            eq(organizationMemberships.userId, userId),
            eq(organizationMemberships.labId, linkedLabId),
            eq(organizationMemberships.status, "active"),
          ),
        });
        if (!linkedLabMembership) continue;

        // Query canonical cases from the linked lab, scoped to the linked
        // provider org and the same last-name prefix.
        const crossLabCanonical = await db.query.cases.findMany({
          where: and(
            eq(cases.labOrganizationId, linkedLabId),
            eq(cases.providerOrganizationId, linkedProvOrgId),
            notDeleted(cases),
            sql`lower(${cases.patientLastName}) like ${`${lastNamePrefix.toLowerCase()}%`}`,
          ),
          orderBy: [desc(cases.createdAt)],
        });

        const crossIds = crossLabCanonical.map((r: any) => r.id);
        const crossRestorations = crossIds.length
          ? await db.query.caseRestorations.findMany({
              where: inArray(caseRestorations.caseId, crossIds),
            })
          : [];
        const crossInvoiceRows = crossIds.length
          ? await db
              .select({ caseId: invoices.caseId })
              .from(invoices)
              .where(inArray(invoices.caseId, crossIds))
          : [];
        const crossInvoicedSet = new Set(
          crossInvoiceRows.map((r: any) => r.caseId).filter(Boolean) as string[],
        );
        const crossRestByCase = new Map<string, typeof crossRestorations>();
        for (const r of crossRestorations) {
          const list = crossRestByCase.get(r.caseId) ?? [];
          list.push(r);
          crossRestByCase.set(r.caseId, list);
        }

        for (const row of crossLabCanonical as any[]) {
          const kind = classifyMatch(
            params.patientFirstName,
            params.patientLastName,
            { firstName: row.patientFirstName, lastName: row.patientLastName },
          );
          if (!kind) continue;
          const items = crossRestByCase.get(row.id) ?? [];
          hits.push({
            id: row.id,
            source: "canonical",
            labOrganizationId: linkedLabId,
            caseNumber: row.caseNumber,
            patientFirstName: row.patientFirstName,
            patientLastName: row.patientLastName,
            doctorName: row.doctorName,
            status: row.status,
            matchKind: kind,
            createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
            dueDate: row.dueDate ? new Date(row.dueDate).toISOString() : null,
            toothNumbers: items
              .map((i: any) => i.toothNumber)
              .filter(Boolean)
              .join(", "),
            restorationTypes: Array.from(
              new Set(items.map((i: any) => i.restorationType).filter(Boolean)),
            ).join(", "),
            shade: Array.from(
              new Set(items.map((i: any) => i.shade).filter(Boolean)),
            ).join(", "),
            material: Array.from(
              new Set(items.map((i: any) => i.material).filter(Boolean)),
            ).join(", "),
            hasInvoice: crossInvoicedSet.has(row.id),
            invoiceTotal: null,
            invoiceStatus: null,
          });
        }

        // Also include legacy cases from the linked lab, scoped to the same
        // doctor-name set derived from the linked provider org.
        const crossLabLegacy = await db
          .select()
          .from(labCases)
          .where(
            and(
              eq(labCases.organizationId, linkedLabId),
              isNull(labCases.deletedAt),
            ),
          );

        const crossLinkedDoctorSet = await getDoctorNameSetForProviderOrg(
          linkedLabId,
          linkedProvOrgId,
        );

        for (const lr of crossLabLegacy as any[]) {
          try {
            const parsed =
              typeof lr.caseData === "string" ? JSON.parse(lr.caseData) : lr.caseData;
            if (!parsed || typeof parsed !== "object") continue;
            const split = splitDisplayName(parsed.patientName);
            const kind = classifyMatch(
              params.patientFirstName,
              params.patientLastName,
              { firstName: split.first, lastName: split.last },
            );
            if (!kind) continue;
            const candidateDoctor = String(parsed.doctorName ?? "").trim().toLowerCase();
            if (!candidateDoctor || !crossLinkedDoctorSet.has(candidateDoctor)) continue;
            hits.push({
              id: lr.id,
              source: "legacy",
              labOrganizationId: linkedLabId,
              caseNumber: String(parsed.caseNumber ?? ""),
              patientFirstName: split.first,
              patientLastName: split.last,
              doctorName: String(parsed.doctorName ?? ""),
              status: String(parsed.status ?? ""),
              matchKind: kind,
              createdAt: parsed.createdAt
                ? new Date(parsed.createdAt).toISOString()
                : null,
              dueDate: parsed.dueDate ? String(parsed.dueDate) : null,
              toothNumbers: String(parsed.toothIndices ?? ""),
              restorationTypes: String(parsed.caseType ?? parsed.material ?? ""),
              shade: String(parsed.shade ?? ""),
              material: String(parsed.material ?? ""),
              hasInvoice: !!parsed.invoiceId,
              invoiceTotal: null,
              invoiceStatus: null,
            });
          } catch {
            // ignore malformed legacy payloads
          }
        }
      }
    }

    // Sort: exact > nickname > fuzzy, then most-recent first.
    const rank: Record<SimilarityMatchKind, number> = {
      exact: 0,
      nickname: 1,
      fuzzy: 2,
    };
    hits.sort((a, b) => {
      if (rank[a.matchKind] !== rank[b.matchKind]) {
        return rank[a.matchKind] - rank[b.matchKind];
      }
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return tb - ta;
    });

    // Deduplicate: when a canonical and legacy hit share the same lab + normalized
    // patient name + doctor, keep only the canonical row. Include labOrganizationId
    // in the key so cross-lab canonical hits are never incorrectly suppressed
    // against legacy hits from a different lab.
    const canonicalKeys = new Set(
      hits
        .filter((h) => h.source === "canonical")
        .map(
          (h) =>
            `${h.labOrganizationId}|${h.patientFirstName.trim().toLowerCase()}|${h.patientLastName.trim().toLowerCase()}|${h.doctorName.trim().toLowerCase()}`,
        ),
    );
    const dedupedHits = hits.filter(
      (h) =>
        h.source === "canonical" ||
        !canonicalKeys.has(
          `${h.labOrganizationId}|${h.patientFirstName.trim().toLowerCase()}|${h.patientLastName.trim().toLowerCase()}|${h.doctorName.trim().toLowerCase()}`,
        ),
    );

    // Apply a configurable cap (default 50, max 200) to prevent large-lab
    // slowdowns on common surnames. When truncated, totalFound is included so
    // the caller knows more results exist. Remakes from years ago are still
    // detected because hits are sorted by relevance before slicing.
    const DEFAULT_LIMIT = 50;
    const MAX_LIMIT = 200;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const totalFound = dedupedHits.length;
    const truncated = totalFound > limit;
    const page = truncated ? dedupedHits.slice(0, limit) : dedupedHits;

    if (truncated) {
      return ok(res, { matches: page, truncated: true, totalFound });
    }
    return ok(res, { matches: page });
  }),
);

router.get(
  "/next-case-number",
  asyncHandler(async (req, res) => {
    const labOrganizationId = String(req.query.labOrganizationId ?? "").trim();
    if (!labOrganizationId) {
      throw new HttpError(400, "labOrganizationId is required.");
    }
    await requireMembership((req as any).auth.userId, labOrganizationId);
    const year = String(new Date().getFullYear()).slice(2);
    const [row] = await db
      .select({
        maxCaseNumber: sql<string | null>`max(
          case
            when ${cases.caseNumber} ~ ${`^${year}-(\\d+)$`}
            then regexp_replace(${cases.caseNumber}, ${`^${year}-(\\d+)$`}, '\\1')::int
            else null
          end
        )`,
      })
      .from(cases)
      .where(eq(cases.labOrganizationId, labOrganizationId));
    const next = (Number(row?.maxCaseNumber ?? 0) || 0) + 1;
    return ok(res, { caseNumber: `${year}-${next}` });
  })
);

// Read-only peek endpoint used by mobile before creating a remake case locally.
// Returns the next suffix case number (e.g. "26-11B") without inserting
// anything — the server create (or legacy sync) is the authoritative step.
router.get(
  "/next-remake-suffix",
  asyncHandler(async (req, res) => {
    const remakeOfCaseId = String(req.query.remakeOfCaseId ?? "").trim();
    if (!remakeOfCaseId) {
      throw new HttpError(400, "remakeOfCaseId is required.");
    }
    const [original] = await db
      .select({
        id: cases.id,
        caseNumber: cases.caseNumber,
        labOrganizationId: cases.labOrganizationId,
      })
      .from(cases)
      .where(and(eq(cases.id, remakeOfCaseId), notDeleted(cases)));
    if (!original) {
      throw new HttpError(404, "Original case not found.");
    }
    await requireMembership((req as any).auth.userId, original.labOrganizationId);
    // Resolve the chain root so remakes-of-remakes produce the correct suffix
    // (e.g. remaking "26-334B" yields "26-334C", not "26-334BB").
    // Advisory lock on root serialises concurrent preview + create requests so
    // the returned preview matches what the actual create will assign.
    const previewResult = await db.transaction(async (tx) => {
      const root = await resolveRemakeRootCanonical(original.id, tx);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(1742068800, hashtext(${root.id}))`,
      );
      const existingCount = await countAllRemakeDescendants(root.id, tx);
      if (existingCount > 23) {
        throw new HttpError(
          409,
          `Too many remakes of case ${root.caseNumber} (maximum 24).`,
        );
      }
      const suffixLetter = String.fromCharCode(66 + existingCount);
      return { caseNumber: `${root.caseNumber}${suffixLetter}` };
    });
    return ok(res, previewResult);
  })
);

const bulkReassignSchema = z.object({
  caseIds: z.array(z.string().min(1)).min(1).max(500),
  providerOrganizationId: z.string().min(1),
});

router.post(
  "/bulk-reassign",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const input = bulkReassignSchema.parse(req.body);

    // Deduplicate submitted IDs so count checks and updates are not skewed.
    const uniqueCaseIds = Array.from(new Set(input.caseIds));

    // The desktop case list merges canonical `cases` rows with legacy mobile
    // `lab_cases` rows. Query both tables across the full id set so a lab
    // whose cases were all created in the mobile app does not 404.
    const [canonicalMatches, legacyMatches] = await Promise.all([
      db
        .select({
          id: cases.id,
          labOrganizationId: cases.labOrganizationId,
          caseNumber: cases.caseNumber,
        })
        .from(cases)
        .where(and(inArray(cases.id, uniqueCaseIds), notDeleted(cases))),
      db
        .select({ id: labCases.id, organizationId: labCases.organizationId })
        .from(labCases)
        .where(and(inArray(labCases.id, uniqueCaseIds), isNull(labCases.deletedAt))),
    ]);

    if (canonicalMatches.length === 0 && legacyMatches.length === 0) {
      throw new HttpError(404, "No matching cases found.");
    }

    // Derive lab org from whichever table matched first.
    const labOrganizationId =
      canonicalMatches[0]?.labOrganizationId ??
      legacyMatches[0]?.organizationId ??
      null;
    if (!labOrganizationId) {
      throw new HttpError(422, "Case has no associated organization.");
    }

    // Require admin/owner role — reassigning cases is a privileged action.
    const membership = await requireAnyRole(userId, labOrganizationId, ADMIN_ROLES);
    const actorInitials = String((membership as any).initials ?? (membership as any).role ?? "?");

    // Validate the target provider org exists, is a provider type, and
    // belongs to the same lab as the cases being reassigned.
    // This prevents cross-tenant reassignment (tenant-boundary enforcement).
    const targetProvider = await db.query.organizations.findFirst({
      where: and(
        eq(organizations.id, input.providerOrganizationId),
        notDeleted(organizations),
      ),
    });
    if (!targetProvider) {
      throw new HttpError(400, "Target practice not found.");
    }
    if ((targetProvider as any).type !== "provider") {
      throw new HttpError(400, "Target organization is not a provider practice.");
    }
    if ((targetProvider as any).parentLabOrganizationId !== labOrganizationId) {
      throw new HttpError(403, "Target practice does not belong to your lab.");
    }

    // Refuse the whole batch if any matched case belongs to another lab.
    const unauthorizedIds = [
      ...canonicalMatches
        .filter((c) => c.labOrganizationId !== labOrganizationId)
        .map((c) => c.id),
      ...legacyMatches
        .filter((c) => c.organizationId !== labOrganizationId)
        .map((c) => c.id),
    ];
    if (unauthorizedIds.length > 0) {
      throw new HttpError(403, "Some cases do not belong to your lab.");
    }

    // Legacy cases do not carry a providerOrganizationId column — skip them
    // with a count rather than erroring. Only canonical cases are updated.
    const skippedLegacyCount = legacyMatches.length;

    if (canonicalMatches.length === 0) {
      return ok(res, { updatedCount: 0, skippedLegacyCount });
    }

    const ids = canonicalMatches.map((c) => c.id);

    // Chunk the IDs into bounded batches so each SQL IN clause is bounded and
    // avoids long-running transactions on large batches (up to 500 IDs).
    const BULK_REASSIGN_CHUNK_SIZE = 100;
    const idChunks: string[][] = [];
    for (let i = 0; i < ids.length; i += BULK_REASSIGN_CHUNK_SIZE) {
      idChunks.push(ids.slice(i, i + BULK_REASSIGN_CHUNK_SIZE));
    }

    await db.transaction(async (tx) => {
      for (const idChunk of idChunks) {
        await tx
          .update(cases)
          .set({ providerOrganizationId: input.providerOrganizationId, updatedAt: new Date() })
          .where(inArray(cases.id, idChunk));
      }
    });
    for (const id of ids) broadcastCaseUpdated(id);

    await writeAuditLog({
      userId,
      organizationId: labOrganizationId,
      action: "cases_bulk_reassigned",
      entityType: "case",
      entityId: labOrganizationId,
      metadataJson: {
        caseIds: ids,
        caseNumbers: canonicalMatches.map((c) => c.caseNumber),
        targetProviderOrganizationId: input.providerOrganizationId,
        targetProviderName: (targetProvider as any).displayName || targetProvider.name,
        count: ids.length,
        skippedLegacyCount,
      },
    });

    return ok(res, { updatedCount: ids.length, skippedLegacyCount });
  })
);

const bulkStatusSchema = z.object({
  caseIds: z.array(z.string().min(1)).min(1).max(500),
  status: z.enum(LOCATABLE_CASE_STATUSES),
  /** Optional station id (lab_locations.id) to persist alongside the status. */
  labLocationId: z.string().nullable().optional(),
});

router.post(
  "/bulk-status",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const input = bulkStatusSchema.parse(req.body);

    const uniqueCaseIds = Array.from(new Set(input.caseIds));

    // Query both canonical and legacy tables across the full id set so that
    // labs whose cases were all created in the mobile app do not 404.
    const [canonicalMatches, legacyMatches] = await Promise.all([
      db
        .select({
          id: cases.id,
          labOrganizationId: cases.labOrganizationId,
          caseNumber: cases.caseNumber,
          labLocationId: cases.labLocationId,
        })
        .from(cases)
        .where(and(inArray(cases.id, uniqueCaseIds), notDeleted(cases))),
      db
        .select({ id: labCases.id, organizationId: labCases.organizationId, caseData: labCases.caseData })
        .from(labCases)
        .where(and(inArray(labCases.id, uniqueCaseIds), isNull(labCases.deletedAt))),
    ]);

    if (canonicalMatches.length === 0 && legacyMatches.length === 0) {
      throw new HttpError(404, "No matching cases found.");
    }

    // Derive lab org from whichever table matched first.
    const labOrganizationId =
      canonicalMatches[0]?.labOrganizationId ??
      legacyMatches[0]?.organizationId ??
      null;
    if (!labOrganizationId) {
      throw new HttpError(422, "Case has no associated organization.");
    }

    await requireMembership(userId, labOrganizationId);

    // Refuse the whole batch if any matched case belongs to another lab.
    const unauthorizedIds = [
      ...canonicalMatches
        .filter((c) => c.labOrganizationId !== labOrganizationId)
        .map((c) => c.id),
      ...legacyMatches
        .filter((c) => c.organizationId !== labOrganizationId)
        .map((c) => c.id),
    ];
    if (unauthorizedIds.length > 0) {
      throw new HttpError(403, "Some cases do not belong to your lab.");
    }

    // Validate the saved station before either canonical or legacy updates so
    // a batch cannot partially write a status before rejecting a foreign
    // location id.
    let effectiveStatus = input.status;
    if (input.labLocationId !== undefined && input.labLocationId !== null) {
      const locRow = await db.query.labLocations.findFirst({
        where: and(
          eq(labLocations.id, input.labLocationId),
          eq(labLocations.labOrganizationId, labOrganizationId),
        ),
      });
      effectiveStatus = resolveLocatedCaseStatus({
        labOrganizationId,
        labLocationId: input.labLocationId,
        location: locRow,
      });
    }
    const updatedLegacyIds: string[] = [];
    const canonicalIds = canonicalMatches.map((c) => c.id);
    await db.transaction(async (tx) => {
      await acquireCaseLocationStatusLock(tx);
      if (input.labLocationId !== undefined && input.labLocationId !== null) {
        const [lockedLocation] = await tx
          .select()
          .from(labLocations)
          .where(
            and(
              eq(labLocations.id, input.labLocationId),
              eq(labLocations.labOrganizationId, labOrganizationId),
            ),
          )
          .for("update");
        effectiveStatus = resolveLocatedCaseStatus({
          labOrganizationId,
          labLocationId: input.labLocationId,
          location: lockedLocation,
        });
      }
      const legacyMobileStatus = canonicalStatusToLegacy(effectiveStatus);
      const canonicalSet: Record<string, unknown> = {
        status: effectiveStatus,
        updatedAt: new Date(),
        ...(input.labLocationId !== undefined
          ? { labLocationId: input.labLocationId }
          : {
              labLocationId: sql`case
                when ${cases.labLocationId} is null then null
                when exists (
                  select 1 from ${labLocations}
                  where ${labLocations.id} = ${cases.labLocationId}
                    and ${labLocations.labOrganizationId} = ${labOrganizationId}
                    and ${labLocations.status} = ${effectiveStatus}
                ) then ${cases.labLocationId}
                else null
              end`,
            }),
      };
      if (effectiveStatus === "complete") canonicalSet.casePanBarcode = null;
      for (const row of [...legacyMatches].sort((a, b) => a.id.localeCompare(b.id))) {
        await updateLegacyCaseWithLocationHistory({
          caseId: row.id,
          labOrganizationId,
          labLocationId: input.labLocationId,
          actorUserId: userId,
          actorInitials: (req as any).user?.initials || "SYS",
          mutate: async (parsed, lockedTx) => {
            parsed.status = legacyMobileStatus;
            if (effectiveStatus === "complete") parsed.assignedBarcode = null;
            if (input.labLocationId !== undefined) {
              parsed.labLocationId = input.labLocationId;
            } else if (typeof parsed.labLocationId === "string") {
              const currentLocation = await lockedTx.query.labLocations.findFirst({
                where: and(
                  eq(labLocations.id, parsed.labLocationId),
                  eq(labLocations.labOrganizationId, labOrganizationId),
                ),
              });
              if (currentLocation?.status !== effectiveStatus) {
                parsed.labLocationId = null;
              }
            }
          },
          canonicalUpdates: canonicalSet,
          dbOrTx: tx,
        });
        updatedLegacyIds.push(row.id);
      }

      if (canonicalIds.length > 0) {
        await updateCanonicalCasesWithLocationHistory({
          caseIds: canonicalIds,
          labOrganizationId,
          updates: canonicalSet,
          labLocationId: input.labLocationId,
          actorUserId: userId,
          actorInitials: (req as any).user?.initials || "SYS",
          dbOrTx: tx,
        });
      }
    });

    const allUpdatedIds = Array.from(new Set([...canonicalIds, ...updatedLegacyIds]));
    for (const id of allUpdatedIds) broadcastCaseUpdated(id);

    await writeAuditLog({
      userId,
      organizationId: labOrganizationId,
      action: "cases_bulk_status_changed",
      entityType: "case",
      entityId: labOrganizationId,
      metadataJson: {
        caseIds: allUpdatedIds,
        caseNumbers: canonicalMatches.map((c) => c.caseNumber),
        status: effectiveStatus,
        count: allUpdatedIds.length,
        legacyCount: updatedLegacyIds.length,
      },
    });

    return ok(res, {
      updatedIds: allUpdatedIds,
      skippedLegacyIds: [],
      updatedCount: allUpdatedIds.length,
      skippedLegacyCount: 0,
    });
  })
);

// ─── List deleted cases (admin only) ────────────────────────────────────────

router.get(
  "/deleted",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const labOrganizationId = String(req.query.labOrganizationId ?? "").trim();
    if (!labOrganizationId) {
      throw new HttpError(400, "labOrganizationId is required.");
    }
    await requireAnyRole(userId, labOrganizationId, ADMIN_ROLES);

    const deleted = await db
      .select({
        id: cases.id,
        caseNumber: cases.caseNumber,
        patientFirstName: cases.patientFirstName,
        patientLastName: cases.patientLastName,
        doctorName: cases.doctorName,
        labOrganizationId: cases.labOrganizationId,
        deletedAt: cases.deletedAt,
        deletedByUserId: cases.deletedByUserId,
        createdAt: cases.createdAt,
      })
      .from(cases)
      .where(
        and(
          eq(cases.labOrganizationId, labOrganizationId),
          isNotNull(cases.deletedAt),
        ),
      )
      .orderBy(desc(cases.deletedAt));

    return ok(res, { cases: deleted });
  })
);

// ─── Deletion audit log (admin only) ─────────────────────────────────────────
// Returns audit log entries for case-deletion-related actions so admins can
// see who deleted what, when, and whether failed PIN attempts occurred.

const DELETION_AUDIT_ACTIONS = [
  "case_delete_initiated",
  "case_delete_wrong_pin",
  "case_delete_initiate_rate_limited",
  "case_soft_deleted",
  "cases_bulk_deleted",
] as const;

router.get(
  "/deletion-audit-log",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const labOrganizationId = String(req.query.labOrganizationId ?? "").trim();
    if (!labOrganizationId) {
      throw new HttpError(400, "labOrganizationId is required.");
    }
    await requireAnyRole(userId, labOrganizationId, ADMIN_ROLES);

    const limit = Math.min(Number(req.query.limit ?? 100), 500);

    const fromParam = String(req.query.from ?? "").trim();
    const toParam = String(req.query.to ?? "").trim();
    const fromDate = fromParam ? new Date(fromParam) : null;
    const toDate = toParam ? new Date(toParam) : null;

    const entries = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        entityId: auditLogs.entityId,
        actorUserId: auditLogs.userId,
        actorUsername: users.username,
        actorFirstName: users.firstName,
        actorLastName: users.lastName,
        metadataJson: auditLogs.metadataJson,
        beforeJson: auditLogs.beforeJson,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(
        and(
          eq(auditLogs.organizationId, labOrganizationId),
          inArray(auditLogs.action, [...DELETION_AUDIT_ACTIONS]),
          fromDate && !isNaN(fromDate.getTime()) ? gte(auditLogs.createdAt, fromDate) : undefined,
          toDate && !isNaN(toDate.getTime()) ? lte(auditLogs.createdAt, toDate) : undefined,
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);

    // Build a list of bulk-operation time windows so de-dup is scoped to
    // the specific operation rather than global. Individual case_soft_deleted
    // entries from the same request share a timestamp with the bulk summary
    // (within a 60-second window). Scoping prevents a restore+re-delete from
    // having its new individual entry incorrectly suppressed by an old summary.
    type BulkWindow = { caseIds: Set<string>; ts: number };
    const bulkWindows: BulkWindow[] = [];
    for (const e of entries) {
      if (e.action === "cases_bulk_deleted") {
        const meta = (e.metadataJson ?? {}) as Record<string, unknown>;
        const ids = Array.isArray(meta["caseIds"]) ? (meta["caseIds"] as string[]) : [];
        const ts = e.createdAt ? new Date(e.createdAt).getTime() : 0;
        bulkWindows.push({ caseIds: new Set(ids), ts });
      }
    }

    function isCoveredByBulk(caseId: string, entryCreatedAt: Date | string | null): boolean {
      const ts = entryCreatedAt ? new Date(entryCreatedAt as string).getTime() : 0;
      return bulkWindows.some(
        (w) => w.caseIds.has(caseId) && Math.abs(w.ts - ts) <= 60_000,
      );
    }

    // For bulk entries that pre-date the caseDetails field (no caseDetails in
    // metadata), do a batch lookup so we can still show case identity. Also
    // collect IDs for case_soft_deleted entries missing caseNumber in metadata
    // and no usable beforeJson, so we can resolve them in one query.
    const needsLookupIds = new Set<string>();
    for (const e of entries) {
      if (e.action === "cases_bulk_deleted") {
        const meta = (e.metadataJson ?? {}) as Record<string, unknown>;
        if (!Array.isArray(meta["caseDetails"])) {
          const ids = Array.isArray(meta["caseIds"]) ? (meta["caseIds"] as string[]) : [];
          for (const id of ids) needsLookupIds.add(id);
        }
      } else if (e.action === "case_soft_deleted") {
        const meta = (e.metadataJson ?? {}) as Record<string, unknown>;
        if (typeof meta["caseNumber"] !== "string" && e.entityId && !e.beforeJson) {
          needsLookupIds.add(e.entityId);
        }
      }
    }

    // Batch-resolve all IDs that need fallback lookup (includes soft-deleted rows).
    const fallbackIdentityMap = new Map<string, { caseNumber: string; patientName: string }>();
    if (needsLookupIds.size > 0) {
      const idList = Array.from(needsLookupIds);
      const [canonicalRows, legacyRows] = await Promise.all([
        db
          .select({
            id: cases.id,
            caseNumber: cases.caseNumber,
            patientFirstName: cases.patientFirstName,
            patientLastName: cases.patientLastName,
          })
          .from(cases)
          .where(inArray(cases.id, idList)),
        db
          .select({ id: labCases.id, caseData: labCases.caseData })
          .from(labCases)
          .where(inArray(labCases.id, idList)),
      ]);
      for (const c of canonicalRows) {
        fallbackIdentityMap.set(c.id, {
          caseNumber: c.caseNumber,
          patientName: [c.patientFirstName, c.patientLastName].filter(Boolean).join(" "),
        });
      }
      for (const c of legacyRows) {
        try {
          const data = typeof c.caseData === "string" ? JSON.parse(c.caseData) : (c.caseData ?? {});
          fallbackIdentityMap.set(c.id, {
            caseNumber: String(data?.caseNumber ?? c.id),
            patientName: String(data?.patientName ?? ""),
          });
        } catch { /* ignore */ }
      }
    }

    function resolveIdentity(caseId: string): { caseNumber: string; patientName: string } {
      return fallbackIdentityMap.get(caseId) ?? { caseNumber: "", patientName: "" };
    }

    const mapped = entries
      .filter((e) => {
        // Drop individual case_soft_deleted rows that are already represented
        // by a cases_bulk_deleted summary from the same operation (same case,
        // same time window) to avoid double-counting.
        if (e.action === "case_soft_deleted" && e.entityId) {
          return !isCoveredByBulk(e.entityId, e.createdAt);
        }
        return true;
      })
      .map((e) => {
        const meta = (e.metadataJson ?? {}) as Record<string, unknown>;
        const actorName =
          [e.actorFirstName, e.actorLastName].filter(Boolean).join(" ").trim() ||
          e.actorUsername ||
          e.actorUserId ||
          "Unknown";
        const actorAccount = e.actorUsername || e.actorUserId || null;

        // Build the array of case identity objects for this entry.
        let casesResult: Array<{ caseId: string; caseNumber: string; patientName: string }> = [];

        if (e.action === "cases_bulk_deleted") {
          if (Array.isArray(meta["caseDetails"])) {
            // New format: caseDetails array written at delete time.
            casesResult = (meta["caseDetails"] as any[]).map((d: any) => ({
              caseId: String(d.caseId ?? ""),
              caseNumber: String(d.caseNumber ?? ""),
              patientName: String(d.patientName ?? ""),
            }));
          } else {
            // Old format: fall back to batch DB lookup by caseIds.
            const ids = Array.isArray(meta["caseIds"]) ? (meta["caseIds"] as string[]) : [];
            casesResult = ids.map((id) => ({ caseId: id, ...resolveIdentity(id) }));
          }
        } else if (e.action === "case_soft_deleted") {
          const metaCaseNumber = typeof meta["caseNumber"] === "string" ? meta["caseNumber"] : null;
          const metaPatientName = typeof meta["patientName"] === "string" ? meta["patientName"] : null;

          if (metaCaseNumber !== null && e.entityId) {
            // New format: metadata has case identity.
            casesResult = [{ caseId: e.entityId, caseNumber: metaCaseNumber, patientName: metaPatientName ?? "" }];
          } else if (e.entityId) {
            // Old format: try beforeJson snapshot first, then DB fallback.
            let caseNumber = "";
            let patientName = "";
            if (e.beforeJson) {
              const before = e.beforeJson as Record<string, unknown>;
              caseNumber = typeof before["caseNumber"] === "string" ? before["caseNumber"] : "";
              patientName = [before["patientFirstName"], before["patientLastName"]].filter(Boolean).join(" ");
            }
            if (!caseNumber) {
              const fallback = resolveIdentity(e.entityId);
              caseNumber = fallback.caseNumber;
              patientName = patientName || fallback.patientName;
            }
            casesResult = [{ caseId: e.entityId, caseNumber, patientName }];
          }
        }

        return {
          id: e.id,
          action: e.action,
          actorName,
          actorAccount,
          cases: casesResult,
          createdAt: e.createdAt,
        };
      });

    return ok(res, { entries: mapped });
  })
);

// ─── Case delete security flow ────────────────────────────────────────────────
// Step 1: POST /cases/delete-initiate — validates admin PIN, finds lab owner,
//   sends a 6-digit OTP via SMS, and returns a signed 10-min session token.
// Step 2: POST /cases/bulk-delete   — verifies the session token + OTP, then
//   soft-deletes the cases. Without a valid token+OTP the endpoint returns 403.

// Rate-limiter: max 3 initiate attempts per 15 min per org (in-process, keyed by orgId).
const _deleteInitiateStore = new Map<string, { count: number; resetAt: number }>();

function _checkDeleteInitiateRateLimit(orgId: string): boolean {
  // Bypass rate-limit in test runs so multiple tests against the same org
  // don't exhaust the 3-attempt window and cause cascading 429s.
  if (process.env["VITEST"]) return true;
  const now = Date.now();
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX = 3;
  const entry = _deleteInitiateStore.get(orgId) ?? { count: 0, resetAt: now + WINDOW_MS };
  if (entry.resetAt < now) {
    entry.count = 0;
    entry.resetAt = now + WINDOW_MS;
  }
  entry.count++;
  _deleteInitiateStore.set(orgId, entry);
  return entry.count <= MAX;
}

function _maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

async function _sendCaseDeleteEmail(
  toEmail: string,
  code: string,
  log?: Pick<import("pino").Logger, "info" | "warn" | "error">,
): Promise<void> {
  const { sendMail } = await import("../lib/mail.js");
  const maskedEmail = _maskEmail(toEmail);
  let result: { sent: boolean; reason?: string };
  try {
    result = await sendMail({
      to: toEmail,
      subject: "LabTrax security code — confirm case deletion",
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #4A6CF7; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2 style="margin: 0;">LabTrax</h2>
            <p style="margin: 4px 0 0; opacity: 0.85;">Case Deletion Confirmation</p>
          </div>
          <div style="padding: 20px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
            <p>Your LabTrax security code is:</p>
            <p style="text-align: center; margin: 24px 0;">
              <span style="display: inline-block; background: #F0F4FF; padding: 16px 40px; border-radius: 8px; font-size: 28px; font-weight: bold; color: #4A6CF7; letter-spacing: 6px;">${code}</span>
            </p>
            <p style="color: #666; font-size: 13px;">This code is used to confirm case deletion. It expires in 10 minutes.</p>
            <p style="color: #666; font-size: 13px;">If you did not request this, contact your lab immediately.</p>
          </div>
        </div>`,
      text: `LabTrax security code: ${code}. Used to confirm case deletion. Expires in 10 minutes. If you did not request this, contact your lab immediately.`,
    });
  } catch {
    log?.warn?.(
      { email: maskedEmail, reason: "send_failed" },
      "case-delete OTP email send failed",
    );
    throw new HttpError(
      502,
      "We could not send the email code. Check the lab owner's email address and email server settings, then try again.",
    );
  }

  if (result.sent) {
    log?.info?.({ email: maskedEmail }, "case-delete OTP email dispatched");
    return;
  }

  const failureMessages: Record<string, string> = {
    smtp_not_configured:
      "Email delivery is not configured. Ask a platform administrator to set SMTP_HOST, SMTP_USER, and SMTP_PASS in server secrets, then try again.",
    reserved_domain:
      "The lab owner's email address uses a reserved test domain and cannot receive mail. Update the owner's email address in their profile, then try again.",
    undeliverable_domain:
      "The lab owner's email domain cannot receive mail. Update the owner's email address in their profile, then try again.",
    disabled_in_test:
      "Email delivery is disabled in this test environment. Use an environment with email delivery configured to request a code.",
    auth_failed:
      "The email provider rejected its login. Ask a platform administrator to check the SMTP credentials in server secrets, then try again.",
    recipient_rejected:
      "The email provider rejected the lab owner's address. Update the owner's email address in their profile, then try again.",
    send_failed:
      "We could not send the email code. Ask a platform administrator to check the email server settings, then try again.",
  };
  const safeReason = result.reason && failureMessages[result.reason]
    ? result.reason
    : "send_failed";
  log?.warn?.(
    { email: maskedEmail, reason: safeReason },
    "case-delete OTP email send failed",
  );
  throw new HttpError(502, failureMessages[safeReason]);
}

const deleteInitiateSchema = z.object({
  adminPin: z.string().min(1),
  caseIds: z.array(z.string().min(1)).min(1).max(200),
});

router.post(
  "/delete-initiate",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    // Pre-validate caseIds before Zod so callers get a specific error instead
    // of the generic "Invalid request." that ZodError produces.
    const rawIds: unknown = (req.body as Record<string, unknown>)?.caseIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw new HttpError(400, "No cases selected. Please select at least one case before deleting.");
    }
    const input = deleteInitiateSchema.parse(req.body);
    const uniqueCaseIds = Array.from(new Set(input.caseIds));

    // Resolve lab org from the case IDs (mirrors bulk-delete logic).
    const [canonicalMatches, legacyMatches] = await Promise.all([
      db
        .select({ id: cases.id, labOrganizationId: cases.labOrganizationId })
        .from(cases)
        .where(and(inArray(cases.id, uniqueCaseIds), notDeleted(cases))),
      db
        .select({ id: labCases.id, organizationId: labCases.organizationId })
        .from(labCases)
        .where(and(inArray(labCases.id, uniqueCaseIds), isNull(labCases.deletedAt))),
    ]);

    if (canonicalMatches.length === 0 && legacyMatches.length === 0) {
      throw new HttpError(404, "No matching cases found.");
    }

    const labOrganizationId =
      canonicalMatches[0]?.labOrganizationId ??
      legacyMatches[0]?.organizationId ??
      null;
    if (!labOrganizationId) {
      throw new HttpError(422, "Case has no associated organization.");
    }

    // Admin-only gate.
    await requireAnyRole(userId, labOrganizationId, ADMIN_ROLES);

    // Rate limit: max 3 initiate attempts per 15 min per org.
    if (!_checkDeleteInitiateRateLimit(labOrganizationId)) {
      await writeAuditLog({
        req,
        userId,
        organizationId: labOrganizationId,
        action: "case_delete_initiate_rate_limited",
        entityType: "case",
        entityId: labOrganizationId,
        metadataJson: { caseIds: uniqueCaseIds },
      });
      throw new HttpError(429, "Too many deletion attempts. Please wait 15 minutes before trying again.");
    }

    // Validate admin PIN (trimmed, case-insensitive).
    // Uses the shared resolver: DB-stored PIN → env var → dev fallback "0000".
    let effectivePin: string;
    try {
      effectivePin = await getEffectiveAdminPinAsync();
    } catch {
      throw new HttpError(
        503,
        "Admin PIN is not configured. Set PLATFORM_ADMIN_PIN in Replit environment secrets and redeploy.",
      );
    }
    if (input.adminPin.trim().toLowerCase() !== effectivePin.toLowerCase()) {
      await writeAuditLog({
        req,
        userId,
        organizationId: labOrganizationId,
        action: "case_delete_wrong_pin",
        entityType: "case",
        entityId: labOrganizationId,
        metadataJson: { caseIds: uniqueCaseIds },
      });
      return res.status(401).json({ ok: false, error: "Incorrect admin PIN." });
    }

    // Find lab owner: prefer "owner" role, fall back to "admin".
    const ownerMembership = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.labId, labOrganizationId),
        inArray(organizationMemberships.role, ["owner", "admin"]),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt),
      ),
      orderBy: sql`CASE ${organizationMemberships.role} WHEN 'owner' THEN 0 ELSE 1 END`,
    });
    if (!ownerMembership) {
      throw new HttpError(400, "No owner or admin found for this lab.");
    }

    const ownerUser = await db.query.users.findFirst({
      where: eq(users.id, ownerMembership.userId),
    });
    if (!ownerUser?.email) {
      return res.status(400).json({
        ok: false,
        error: "The lab owner has no email address on file. Please add the owner's email in their profile before deleting cases.",
      });
    }

    const ownerEmail = ownerUser.email.trim();

    // Prefixed target keeps case-delete OTPs isolated from regular email
    // verification codes so an in-flight signup/login flow is never interrupted.
    const ownerEmailTarget = `case-delete:${normalizeEmailTarget(ownerEmail)}`;

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const verificationCodeId = await createVerificationCode({
      channel: "email",
      target: ownerEmailTarget,
      code,
      userId: ownerUser.id,
    });
    req.log?.info?.(
      {
        labOrgId: labOrganizationId,
        actorId: userId,
        ownerUserId: ownerUser.id,
        email: _maskEmail(ownerEmail),
      },
      "case-delete OTP: sending email",
    );
    try {
      await _sendCaseDeleteEmail(ownerEmail, code, req.log as any);
    } catch (error) {
      try {
        await invalidateVerificationCode(verificationCodeId);
      } catch {
        req.log?.error?.(
          { labOrgId: labOrganizationId, actorId: userId },
          "case-delete OTP could not be invalidated after delivery failure",
        );
        throw new HttpError(
          500,
          "We could not safely complete email verification. Please try again.",
        );
      }
      throw error;
    }

    const deleteSessionToken = signDeleteSessionToken({
      caseIds: uniqueCaseIds,
      labOrgId: labOrganizationId,
      actorId: userId,
      ownerEmailTarget,
    });

    await writeAuditLog({
      req,
      userId,
      organizationId: labOrganizationId,
      action: "case_delete_initiated",
      entityType: "case",
      entityId: labOrganizationId,
      metadataJson: { caseIds: uniqueCaseIds, ownerUserId: ownerUser.id },
    });

    return ok(res, {
      deleteSessionToken,
      maskedRecipient: _maskEmail(ownerEmail),
    });
  })
);

/**
 * Cascade-freeze every invoice linked to the given (now soft-deleted) cases.
 *
 * Invoices are NEVER deleted when their case is deleted — the billing record is
 * preserved permanently. Instead each linked invoice is frozen and its
 * balanceDue is zeroed so it stops contributing to open/overdue balances while
 * remaining fully visible in the invoice list. Restoring the case
 * (POST /:caseId/restore) reverses this.
 *
 * Used by BOTH the single-case delete (DELETE /:caseId) and the bulk delete
 * (POST /bulk-delete) so the two paths can never drift. Also exported for the
 * platform-admin pre-cutoff cleanup (labtrax-routes.ts), whose CI-secret path
 * has no real user row — hence `deletingUserId` may be null there. Returns
 * the number of invoices frozen.
 */
export async function freezeInvoicesForDeletedCases(params: {
  req: Request;
  caseIds: string[];
  labOrganizationId: string;
  deletingUserId: string | null;
  caseNumberById?: Map<string, string | null | undefined>;
  tx?: any;
}): Promise<number> {
  const { req, caseIds, labOrganizationId, deletingUserId, caseNumberById, tx } =
    params;
  if (caseIds.length === 0) return 0;

  const executor = tx ?? db;
  const linkedInvoices = (await executor
    .select()
    .from(invoices)
    .where(
      and(
        inArray(invoices.caseId, caseIds),
        // Tenant scoping: only ever touch invoices owned by the deleting lab.
        // There is no composite FK tying invoices.labOrganizationId to the
        // case's lab, so a cross-lab/imported row that happens to reference one
        // of these case ids must not be frozen under the wrong tenant.
        eq(invoices.labOrganizationId, labOrganizationId),
        // Idempotency: skip invoices already frozen by a prior case deletion so
        // we never re-zero a balance or emit a duplicate audit entry. (frozen
        // is set exclusively by this helper.)
        eq(invoices.frozen, false),
        isNull(invoices.deletedAt),
      ),
    )
    // Keep the read order deliberately opposite the advisory-lock order below.
    // Besides making the lock discipline explicit, this ensures concurrency
    // regressions cannot pass accidentally because PostgreSQL happened to
    // return rows in ascending id order.
    .orderBy(desc(invoices.id))) as (typeof invoices.$inferSelect)[];

  if (linkedInvoices.length === 0) return 0;

  // Derive initials from the deleting user's profile. Fall back to the initials
  // field stored on the user row, then to "?" when nothing is set. The
  // platform-admin secret path has no user row (deletingUserId === null), so
  // skip the lookup entirely there.
  const actorUser = deletingUserId
    ? (
        await executor
          .select()
          .from(users)
          .where(eq(users.id, deletingUserId))
          .limit(1)
      )[0]
    : undefined;
  const derivedInitials = (() => {
    const first = String(actorUser?.firstName ?? "").trim();
    const last = String(actorUser?.lastName ?? "").trim();
    if (first && last) return `${first[0]}${last[0]}`.toUpperCase();
    if (actorUser?.initials) return actorUser.initials.toUpperCase();
    return "?";
  })();
  const freezeNote = `Case Deleted by ${derivedInitials}`;
  const freezeAt = new Date();

  const freezeInTransaction = async (freezeTx: any) => {
    // Date repair uses this same per-invoice advisory lock. Lock in stable order
    // so a concurrent repair either completes before freezing or observes the
    // frozen row and aborts.
    for (const invoiceId of linkedInvoices.map((inv) => inv.id).sort()) {
      await freezeTx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoiceId}))`);
    }
    const updatedInvoices = await freezeTx
      .update(invoices)
      .set({
        frozen: true,
        balanceDue: "0.00",
        caseDeletedAt: freezeAt,
        caseDeletedByUserId: deletingUserId,
        caseDeletedNote: freezeNote,
        updatedByUserId: deletingUserId,
      } as any)
      .where(
        and(
          inArray(
            invoices.id,
            linkedInvoices.map((inv) => inv.id),
          ),
          // Re-assert tenant scoping on the write itself (defense-in-depth).
          eq(invoices.labOrganizationId, labOrganizationId),
          eq(invoices.frozen, false),
          isNull(invoices.deletedAt),
        ),
      )
      .returning({ id: invoices.id });

    const updatedInvoiceIds = new Set(
      updatedInvoices.map((inv: { id: string }) => inv.id),
    );
    const actuallyFrozenInvoices = linkedInvoices.filter((inv) =>
      updatedInvoiceIds.has(inv.id),
    );

    // The freeze and its audit history are one state change: if any audit insert
    // fails, roll back every invoice update rather than committing an
    // unaudited frozen invoice.
    for (const inv of actuallyFrozenInvoices) {
      await writeAuditLogTx(freezeTx, {
        req,
        userId: deletingUserId,
        organizationId: labOrganizationId,
        action: "invoice_frozen_case_deleted",
        entityType: "invoice",
        entityId: inv.id,
        beforeJson: inv,
        metadataJson: {
          caseId: inv.caseId,
          caseNumber: inv.caseId
            ? (caseNumberById?.get(inv.caseId) ?? null)
            : null,
          frozenNote: freezeNote,
        },
      });
    }

    return actuallyFrozenInvoices.length;
  };

  return tx
    ? await freezeInTransaction(tx)
    : await db.transaction(freezeInTransaction);
}

// ─── Bulk delete (admin only, soft-delete) ────────────────────────────────────

const bulkDeleteSchema = z.object({
  caseIds: z.array(z.string().min(1)).min(1).max(200),
  deleteSessionToken: z.string().optional(),
  // Wire name kept as `smsOtpCode` for compatibility with already-deployed
  // desktop/mobile clients; since the email migration this field carries the
  // 6-digit code that was EMAILED to the lab owner.
  smsOtpCode: z.string().optional(),
});

router.post(
  "/bulk-delete",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const input = bulkDeleteSchema.parse(req.body);

    const uniqueCaseIds = Array.from(new Set(input.caseIds));

    // The desktop case list (GET /cases) merges canonical `cases` rows with
    // legacy mobile `lab_cases` rows, whose ids are NOT present in the
    // canonical table. A "select all" therefore yields a mix of both kinds.
    // Resolve matches from BOTH tables across the full id set — never from a
    // single id, which 404s the entire batch the moment the first selected
    // case happens to be a legacy mobile case (the common failure for labs
    // whose cases were all created in the mobile app).
    const [canonicalMatches, legacyMatches] = await Promise.all([
      db
        .select({
          id: cases.id,
          labOrganizationId: cases.labOrganizationId,
          caseNumber: cases.caseNumber,
          patientFirstName: cases.patientFirstName,
          patientLastName: cases.patientLastName,
        })
        .from(cases)
        .where(and(inArray(cases.id, uniqueCaseIds), notDeleted(cases))),
      db
        .select({ id: labCases.id, organizationId: labCases.organizationId, caseData: labCases.caseData })
        .from(labCases)
        .where(and(inArray(labCases.id, uniqueCaseIds), isNull(labCases.deletedAt))),
    ]);

    if (canonicalMatches.length === 0 && legacyMatches.length === 0) {
      throw new HttpError(404, "No matching cases found.");
    }

    // Resolve the lab org from whichever table matched first. Every case in
    // the batch must belong to this single lab (tenant-boundary enforcement).
    const labOrganizationId =
      canonicalMatches[0]?.labOrganizationId ??
      legacyMatches[0]?.organizationId ??
      null;
    if (!labOrganizationId) {
      throw new HttpError(422, "Case has no associated organization.");
    }

    // delete_cases capability: owners and admins pass implicitly; non-admin
    // team members may also bulk-delete if they hold an explicit capability grant.
    await requireCapability(userId, labOrganizationId, "delete_cases");

    // ── Security gate: require delete-session token + emailed OTP ──────────
    // Callers must first complete POST /cases/delete-initiate (validates
    // admin PIN and emails an OTP to the lab owner). Without a valid
    // token + OTP we refuse the deletion regardless of admin status.
    if (!input.deleteSessionToken || !input.smsOtpCode) {
      throw new HttpError(
        403,
        "Case deletion requires admin PIN verification and email confirmation. Please use the case deletion flow.",
      );
    }

    let tokenPayload: import("../lib/auth.js").DeleteSessionPayload;
    try {
      tokenPayload = verifyDeleteSessionToken(input.deleteSessionToken);
    } catch {
      throw new HttpError(
        401,
        "Deletion session has expired or is invalid. Please start the deletion flow again.",
      );
    }

    if (tokenPayload.labOrgId !== labOrganizationId) {
      throw new HttpError(403, "Deletion session does not match this organization.");
    }

    // Token id scoping: the OTP was issued (and email-confirmed) for a specific
    // set of case ids in delete-initiate. Require every requested id to be
    // covered by that set so a token issued for one selection cannot be
    // replayed to delete a different or larger batch. The desktop and mobile
    // flows pass the identical id set to both steps, so a mixed
    // canonical+legacy selection is authorized as one unit and never trips
    // this guard — it only fires on a genuine token/id mismatch.
    const tokenCaseIds = new Set(tokenPayload.caseIds ?? []);
    const uncoveredIds = uniqueCaseIds.filter((id) => !tokenCaseIds.has(id));
    if (uncoveredIds.length > 0) {
      throw new HttpError(
        403,
        "Deletion session does not cover all selected cases. Please restart the deletion flow.",
      );
    }

    const otpResult = await verifyCode({
      channel: "email",
      target: tokenPayload.ownerEmailTarget,
      code: input.smsOtpCode,
    });
    if (!otpResult.verified) {
      throw new HttpError(400, otpResult.error ?? "Invalid or expired code.");
    }
    // ── End security gate ──────────────────────────────────────────────────

    // Refuse the whole batch if any matched case belongs to another lab.
    const unauthorizedIds = [
      ...canonicalMatches
        .filter((c) => c.labOrganizationId !== labOrganizationId)
        .map((c) => c.id),
      ...legacyMatches
        .filter((c) => c.organizationId !== labOrganizationId)
        .map((c) => c.id),
    ];
    if (unauthorizedIds.length > 0) {
      throw new HttpError(403, "Some cases do not belong to your lab.");
    }

    await db.transaction(async (tx) => {
      // Canonical case deletion and linked invoice freezing are one state
      // transition. A failed freeze audit must roll back the case deletion too.
      for (const c of canonicalMatches) {
        await softDeleteById({
          table: cases,
          id: c.id,
          actorUserId: userId,
          req,
          organizationId: labOrganizationId,
          entityType: "case",
          beforeJson: c,
          metadataJson: {
            caseNumber: c.caseNumber,
            patientName: [c.patientFirstName, c.patientLastName].filter(Boolean).join(" "),
          },
          tx,
        });
      }

      await freezeInvoicesForDeletedCases({
        req,
        caseIds: canonicalMatches.map((c) => c.id),
        labOrganizationId,
        deletingUserId: userId,
        caseNumberById: new Map(
          canonicalMatches.map((c) => [c.id, c.caseNumber]),
        ),
        tx,
      });
    });

    // Soft-delete legacy mobile cases (lab_cases). They store their payload in
    // a JSON blob and are recoverable from Settings → admin case trash. Route
    // through the shared helper so the legacy path gets the same soft-delete +
    // per-case audit-log guarantees as canonical cases (and an accurate count
    // of rows actually deleted, skipping any already-deleted between the match
    // and the write). Mirrors the single-case legacy delete in labtrax-routes.
    let legacyDeletedCount = 0;
    if (legacyMatches.length > 0) {
      const actor = (req as any).user;
      const deletedBy = actor?.username || actor?.id || userId || "unknown";
      const { deletedIds } = await softDeleteLegacyCases({
        ids: legacyMatches.map((c) => c.id),
        deletedBy,
        actorUserId: userId,
        organizationId: labOrganizationId,
        req,
      });
      legacyDeletedCount = deletedIds.length;
    }

    const deletedCount = canonicalMatches.length + legacyDeletedCount;
    for (const c of canonicalMatches) broadcastCaseUpdated(c.id, "deleted");

    await writeAuditLog({
      userId,
      organizationId: labOrganizationId,
      action: "cases_bulk_deleted",
      entityType: "case",
      entityId: labOrganizationId,
      metadataJson: {
        caseIds: [
          ...canonicalMatches.map((c) => c.id),
          ...legacyMatches.map((c) => c.id),
        ],
        caseDetails: [
          ...canonicalMatches.map((c) => ({
            caseId: c.id,
            caseNumber: c.caseNumber,
            patientName: [c.patientFirstName, c.patientLastName].filter(Boolean).join(" "),
          })),
          ...legacyMatches.map((c) => {
            try {
              const data = typeof c.caseData === "string" ? JSON.parse(c.caseData) : (c.caseData ?? {});
              return {
                caseId: c.id,
                caseNumber: String(data?.caseNumber ?? c.id),
                patientName: String(data?.patientName ?? ""),
              };
            } catch {
              return { caseId: c.id, caseNumber: c.id, patientName: "" };
            }
          }),
        ],
        caseNumbers: canonicalMatches.map((c) => c.caseNumber),
        canonicalCount: canonicalMatches.length,
        legacyCount: legacyDeletedCount,
        count: deletedCount,
      },
    });

    return ok(res, { deletedCount });
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    // Race the entire handler against a hard 15 s ceiling so a saturated DB
    // pool returns a retry-able 503 instead of hanging indefinitely.
    // HttpError(503) is handled by the global error handler → 503 JSON response.
    // The pg pool's own connectionTimeoutMillis (10 s) provides a deeper
    // safety net; this guard catches any other long-running path.
    const TIMEOUT_MS = 15_000;
    const timeoutSignal = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new HttpError(
              503,
              "Case creation timed out — server is busy, please retry."
            )
          ),
        TIMEOUT_MS
      )
    );

    return Promise.race([
      (async () => {
    const input = createCaseSchema.parse(req.body);
    const assignedTeeth = new Set<string>();
    for (const row of input.restorations ?? []) {
      if (!/^(crown|pontic)$/i.test(row.restorationType)) continue;
      if (!/^(?:[1-9]|[12]\d|3[0-2]|[A-T])$/i.test(row.toothNumber.trim()) ||
          row.quantity !== 1 || !row.material?.trim()) {
        throw new HttpError(400, "Each crown or pontic needs one tooth, one unit, and a catalog material.");
      }
      const tooth = row.toothNumber.trim().toUpperCase();
      if (assignedTeeth.has(tooth)) throw new HttpError(400, `Tooth #${tooth} is assigned more than once.`);
      assignedTeeth.add(tooth);
    }
    if (input.bridgeConnectors !== undefined) {
      const connectorCheck = validateToothConnectors(input.bridgeConnectors, input.restorations ?? []);
      if (!connectorCheck.valid) throw new HttpError(400, connectorCheck.errors.join(" "));
    }
    input.bridgeConnectors = serializeConnectorState(withPonticConnectorSuggestions(input.bridgeConnectors, input.restorations ?? []));
    for (const restoration of input.restorations ?? []) {
      if (isArchApplicable(restoration.restorationType, restoration.restorationSubtype) &&
          !normalizeArch(restoration.arch)) {
        throw new HttpError(
          400,
          "Arch is required for Removable and Ortho restorations (Upper, Lower, or Upper + Lower).",
        );
      }
    }
    validateCustomRemakeReason(input.remakeReasonKey, input.remakeReason);
    if (input.remakeReasonKey === "other") {
      input.remakeReason = input.remakeReason!.trim();
    }
    const membership = await requireMembership(
      (req as any).auth.userId,
      input.labOrganizationId
    );
    const callerIsAdminOrOwner = ["owner", "admin"].includes(membership.role as string);

    // Barcode uniqueness check — reject duplicate barcodes across active cases
    // in the same lab. Barcodes are strictly unique per lab for active cases;
    // the cases_barcode_unique_per_lab partial index is the atomic guard, and
    // this pre-check is a fast-path that names the conflicting case.
    if (input.casePanBarcode) {
      await checkBarcodeUniqueness(input.casePanBarcode, input.labOrganizationId);
    }

    // Pre-create duplicate-doctor checkpoint. If the typed doctor name strongly
    // resembles an existing doctor in the SAME practice (above the lab
    // threshold) and the client has not yet confirmed, reject with a structured
    // 409 listing the candidate matches so the client can ask the user which
    // doctor they mean. Skipped for remakes (the doctor name is inherited from
    // the original case, not freshly typed) and when the client re-submits with
    // confirmNewDoctor=true after the user explicitly chose "add new doctor".
    if (!input.remakeOfCaseId && !input.confirmNewDoctor) {
      const doctorMatches = await findSimilarDoctorsInPractice(
        input.labOrganizationId,
        input.providerOrganizationId,
        input.doctorName,
      );
      if (doctorMatches.length > 0) {
        throw new HttpError(
          409,
          "This doctor name closely matches an existing doctor in this practice. Please confirm which doctor you mean.",
          {
            code: "DOCTOR_CONFIRMATION_REQUIRED",
            doctorName: input.doctorName.trim(),
            providerOrganizationId: input.providerOrganizationId,
            candidates: doctorMatches,
          },
        );
      }
    }

    // Validate remake link target. The original may live in either the
    // canonical `cases` table or the legacy `lab_cases` table — Task #331
    // requires linking to either kind. Cross-tenant linking is blocked
    // by the resolver.
    const remakeOriginal = input.remakeOfCaseId
      ? await resolveRemakeOriginal(
          input.remakeOfCaseId,
          input.labOrganizationId,
          input.providerOrganizationId,
          input.doctorName,
        )
      : null;
    if (input.remakeOfCaseId && !remakeOriginal) {
      throw new HttpError(
        404,
        "Original case for remake not found in this lab.",
      );
    }

    // Resolve case due date. When the cap toggle is on, any supplied date
    // beyond (today + defaultCaseDueDays) is trimmed to the turnaround.
    // When no date is supplied the turnaround is used as a fallback (existing
    // behaviour). This is also the enforcement path for iTero auto-imports.
    const suppliedDueDate: Date | null = input.dueDate ? new Date(input.dueDate) : null;
    if (input.dueTime != null && !input.dueDate) {
      throw new HttpError(400, "Cannot set a due time without a due date.");
    }
    const dueDateLabOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, input.labOrganizationId),
      columns: { defaultCaseDueDays: true, capCaseDueToDefault: true },
    });
    if (
      input.aiIntakeReviewedDates &&
      input.dueDate &&
      !isValidCalendarDate(input.dueDate)
    ) {
      throw new HttpError(400, "Reviewed lab due date is not a valid calendar date.");
    }
    const resolvedDueDate = input.aiIntakeReviewedDates
      ? suppliedDueDate
      : resolveCaseDueDate(
          suppliedDueDate,
          new Date(),
          dueDateLabOrg?.defaultCaseDueDays,
          dueDateLabOrg?.capCaseDueToDefault,
        );
    const resolvedPrescriptionDueDate = input.aiIntakeReviewedDates
      ? resolveAiIntakePrescriptionDueDate(
          input.prescriptionDueDate,
          input.receivedAt ?? new Date().toISOString().slice(0, 10),
          dueDateLabOrg?.defaultCaseDueDays,
        )
      : input.prescriptionDueDate ?? null;

    // Test-only TOCTOU barrier: lets concurrent requests that both cleared the
    // pre-check rendezvous here before either write reaches the DB, making the
    // unique-index race deterministic in tests. No-op in production (undefined).
    if (input.casePanBarcode && _testHooks.barcodeWriteHook) {
      await _testHooks.barcodeWriteHook();
    }

    // For remake cases, compute the next letter suffix (B, C, D, …) inside
    // a transaction so the count + insert are atomic. The UNIQUE constraint
    // on cases.caseNumber is the ultimate guard against collisions even
    // under concurrent creates of the same remake target.
    const createdCase = await db.transaction(async (tx) => {
      try {
      let resolvedCaseNumber: string;
      if (remakeOriginal) {
        // Resolve the chain root so that remakes-of-remakes produce the
        // correct suffix letter and case-number base. E.g. remaking "26-334B"
        // yields "26-334C", not "26-334BB". Legacy originals are always the
        // root (they have no remakeOfCaseId), so no traversal is needed.
        const remakeRoot =
          remakeOriginal.kind === "canonical"
            ? await resolveRemakeRootCanonical(remakeOriginal.id, tx)
            : { id: remakeOriginal.id, caseNumber: remakeOriginal.caseNumber };

        // Acquire a transaction-scoped advisory lock keyed on the ROOT case
        // ID.  pg_advisory_xact_lock blocks until any other holder releases at
        // transaction end, so two concurrent remake creates for any node in
        // the same tree serialise here instead of colliding on the suffix
        // letter. hashtext() folds the UUID string into the int4 space
        // expected by the two-arg form; the constant first arg namespaces it
        // away from any other advisory lock usage in the app.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(1742068800, hashtext(${remakeRoot.id}))`,
        );

        // Count ALL non-deleted descendants of the root at any depth so the
        // suffix increments correctly even when remaking a non-root node.
        const existingCount = await countAllRemakeDescendants(remakeRoot.id, tx);
        // 0 → 'B', 1 → 'C', 2 → 'D', … up to 'Z' (24 remakes, charCode 90).
        // Reject gracefully if the limit is exceeded rather than silently
        // producing a non-letter character.
        if (existingCount > 23) {
          throw new HttpError(
            409,
            `Too many remakes of case ${remakeRoot.caseNumber} (maximum 24).`,
          );
        }
        const suffixLetter = String.fromCharCode(66 + existingCount);
        resolvedCaseNumber = `${remakeRoot.caseNumber}${suffixLetter}`;
      } else {
        // Non-remake: client supplies the case number (validated above).
        resolvedCaseNumber = input.caseNumber!;
      }

      const [created] = await tx
        .insert(cases)
        .values({
          caseNumber: resolvedCaseNumber,
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId: input.providerOrganizationId,
          patientFirstName: input.patientFirstName,
          patientLastName: input.patientLastName,
          externalPatientId: input.externalPatientId ?? null,
          doctorName: input.doctorName,
          status: input.status,
          priority: input.priority,
          receivedAt: parseCalendarDate(input.receivedAt),
          scanDate: input.scanDate ?? null,
          prescriptionDueDate: resolvedPrescriptionDueDate,
          providerContactSnapshot: input.providerContactSnapshot ?? null,
          dueDate: resolvedDueDate,
          dueTime: input.dueDate ? input.dueTime ?? null : null,
          expectedDeliveryDate: suppliedDueDate
            ? null
            : (() => {
                const d = new Date();
                d.setDate(d.getDate() + (dueDateLabOrg?.defaultCaseDueDays ?? 7));
                return d;
              })(),
          createdByUserId: (req as any).auth.userId,
          remakeOfCaseId: remakeOriginal?.id ?? null,
          remakeReason: remakeOriginal ? input.remakeReason ?? null : null,
          remakeCharged: remakeOriginal ? input.remakeCharged ?? null : null,
          remakeReasonKey: remakeOriginal ? input.remakeReasonKey ?? null : null,
          remakeShadeLightness: remakeOriginal ? input.remakeShadeLightness ?? null : null,
          remakeShadePrescribed: remakeOriginal ? input.remakeShadePrescribed ?? null : null,
          remakeShadeProvided: remakeOriginal ? input.remakeShadeProvided ?? null : null,
          remakeMaterialPrescribed: remakeOriginal ? input.remakeMaterialPrescribed ?? null : null,
          remakeMaterialProvided: remakeOriginal ? input.remakeMaterialProvided ?? null : null,
          remakeReturnedToLab: remakeOriginal ? input.remakeReturnedToLab ?? null : null,
          remakeCategory: remakeOriginal
            ? (input.remakeCategory ?? inferRemakeCategory(input.remakeReasonKey) ?? null)
            : null,
          remakeNotes: remakeOriginal ? input.remakeNotes ?? null : null,
          casePanBarcode: input.casePanBarcode ?? null,
          shade: input.shade ?? null,
          gingivialShade: input.gingivialShade?.trim() || null,
          step: input.step ?? null,
          rxNotes: input.rxNotes?.trim() ? input.rxNotes : null,
          bridgeConnectors: input.bridgeConnectors || null,
        })
        .returning();

      if (input.rxNotes?.trim()) {
        await appendRxNoteEntry(tx, {
          caseId: created.id,
          submissionId: `case-intake:${created.id}`,
          noteText: input.rxNotes,
          provenance: "case_intake",
          scannedAt: created.createdAt,
          preserveCurrentAsLegacy: false,
        });
      }

      // Write remake cross-link events INSIDE the transaction so they are
      // atomic with case creation.
      //
      // Canonical originals: both the forward "remake_of" event (on the new
      // case) and the backward "remade_by" event (on the original) are written
      // here using tx. If either insert fails, the entire transaction rolls
      // back — no orphan case, no silent partial success.
      //
      // Legacy originals: only the forward "remake_of" event is written here.
      // The reciprocal blob update on the legacy lab_cases row is a JSON patch
      // on a separate table that can't participate in this Drizzle transaction;
      // it runs after the transaction commits and surfaces as a user-visible
      // warning field in the 201 response if it fails.
      if (remakeOriginal) {
        const txReason = input.remakeReason ?? null;
        const txCharged = input.remakeCharged ?? null;
        const txActorUserId = (req as any).auth.userId as string;
        const txActorInitials = (req as any).user?.initials || "SYS";

        await tx.insert(caseEvents).values({
          caseId: created.id,
          eventType: "remake_of",
          actorUserId: txActorUserId,
          actorOrganizationId: input.labOrganizationId,
          actorInitials: txActorInitials,
          metadataJson: {
            originalCaseId: remakeOriginal.id,
            originalCaseNumber: remakeOriginal.caseNumber,
            originalCaseKind: remakeOriginal.kind,
            remakeReason: txReason,
            remakeCharged: txCharged,
            note: `Marked as remake of ${remakeOriginal.kind === "legacy" ? "legacy " : ""}case ${remakeOriginal.caseNumber}${txReason ? ` (reason: ${txReason})` : ""}`,
          },
        });

        if (remakeOriginal.kind === "canonical") {
          // Canonical original: write the reciprocal event inside the same
          // transaction. Both events commit or both roll back.
          await tx.insert(caseEvents).values({
            caseId: remakeOriginal.id,
            eventType: "remade_by",
            actorUserId: txActorUserId,
            actorOrganizationId: input.labOrganizationId,
            actorInitials: txActorInitials,
            metadataJson: {
              remakeCaseId: created.id,
              remakeCaseNumber: created.caseNumber,
              remakeReason: txReason,
              remakeCharged: txCharged,
              note: `Case ${created.caseNumber} created as a remake of this case${txReason ? ` (reason: ${txReason})` : ""}, charged: ${txCharged === true ? "yes" : txCharged === false ? "no" : "unspecified"}`,
            },
          });
        }
      }

      return created;
      } catch (err) {
        // The cases_barcode_unique_per_lab partial index is the atomic guard
        // that closes the race between the checkBarcodeUniqueness pre-check and
        // this INSERT. Translate its 23505 into the same 409 the pre-check
        // returns; re-throw anything else (incl. the case-number unique index).
        rethrowBarcodeConflict(err, input.casePanBarcode ?? "");
      }
    });

    if (input.restorations && input.restorations.length > 0) {
      // Resolve all prices in a single batch (3 DB round-trips total) instead
      // of one call per restoration, cutting O(N) pool pressure to O(1).
      // For any price key not covered by the batch (non-standard keys), fall
      // back to the individual resolver so pricing accuracy is preserved.
      const needsAutoPrice = input.restorations.some(
        (r) =>
          r.priceOverridden !== true &&
          !(Number.isFinite(r.unitPrice) && r.unitPrice > 0)
      );
      // Batch-resolve all standard-key prices once (3 DB round-trips total).
      // Store every key the batch returns — including zero-price / no-source
      // entries — so the map is authoritative for the entire standard-key set.
      // Only fall back to the individual resolver for genuinely non-standard
      // keys (i.e. keys not present in the batch at all), keeping pricing O(1).
      const batchPriceMap = new Map<string, ResolvedItemRow>();
      if (needsAutoPrice) {
        const allPrices = await resolveAllPricesForContext({
          labOrganizationId: input.labOrganizationId,
          doctorName: input.doctorName,
          providerOrganizationId: input.providerOrganizationId,
        });
        for (const p of allPrices) {
          batchPriceMap.set(p.key, p);
        }
      }

      const resolved = await Promise.all(
        input.restorations.map(async (r) => {
          let unit = r.unitPrice;
          // An explicit override (priceOverridden) counts as user-supplied even
          // when 0, so a deliberate no-charge line is preserved rather than
          // auto-priced. Otherwise any positive price is treated as manual.
          const userSupplied =
            r.priceOverridden === true || (Number.isFinite(unit) && unit > 0);
          let priceSource: string | null = userSupplied ? "manual" : null;
          let priceSourceId: string | null = null;
          let priceSourceName: string | null = null;
          let priceKey: string | null = null;
          if (!userSupplied) {
            const key = await resolveRestorationPriceKey({
              labOrganizationId: input.labOrganizationId,
              material: r.material,
              restorationType: r.restorationType,
              restorationSubtype: r.restorationSubtype,
            });
            if (key !== null && batchPriceMap.has(key)) {
              // Standard key — use the batch result as authoritative.
              // batchHit.unitPrice may be 0 (no price configured), which is correct.
              const batchHit = batchPriceMap.get(key)!;
              if (batchHit.source !== null && batchHit.unitPrice > 0) {
                unit = batchHit.unitPrice;
                priceSource = batchHit.source;
                priceSourceId = batchHit.sourceId;
                priceSourceName = batchHit.sourceName;
                priceKey = batchHit.key;
              }
              // else: no price configured — leave unit as-is (0 or user value)
            } else {
              // Non-standard key not covered by DEFAULT_TIER_ITEMS — fall back.
              const fallback = await resolveServerPriceWithSource(
                {
                  labOrganizationId: input.labOrganizationId,
                  doctorName: input.doctorName,
                  providerOrganizationId: input.providerOrganizationId,
                },
                r.material,
                r.restorationType,
                r.restorationSubtype,
              );
              if (fallback) {
                unit = fallback.amount;
                priceSource = fallback.source;
                priceSourceId = fallback.sourceId;
                priceSourceName = fallback.sourceName;
                priceKey = fallback.key;
              }
            }
          }
          const normalizedArch = normalizeArch(r.arch);
          const base = {
            caseId: createdCase.id,
            toothNumber: r.toothNumber,
            ...implantValues(r),
            restorationType: r.restorationType,
            restorationSubtype: r.restorationSubtype ?? null,
            arch: normalizedArch,
            material: r.material ?? null,
            shade: r.shade ?? null,
            notes: r.notes ?? null,
            quantity: r.quantity,
            assignmentProvenance: /^(crown|pontic)$/i.test(r.restorationType)
              ? r.assignmentProvenance ?? { origin: "manual", manualFields: ["role", "product", "shade"] } : null,
            unitPrice: unit.toFixed(2),
            priceSource,
            priceSourceId,
            priceSourceName,
            priceKey,
          };
          if (normalizedArch === "upper_lower") {
            return [
              { ...base, arch: "upper" as Arch },
              { ...base, arch: "lower" as Arch },
            ];
          }
          return [base];
        })
      ).then((rows) => rows.flat());
      await db.insert(caseRestorations).values(resolved)
        .catch((err: unknown): never => wrapDbError(err, {
          fallback: "Failed to save case restorations.",
        }));
    }

    const user = (req as any).user;

    // Persist any AI-extracted (or user-entered) case-level note FIRST so
    // the auto-invoice block (which reads caseNotes) sees it when it runs.
    if (input.notes && input.notes.trim()) {
      await db.insert(caseNotes).values({
        caseId: createdCase.id,
        authorUserId: (req as any).auth.userId,
        authorOrganizationId: input.labOrganizationId,
        noteText: input.notes.trim(),
        visibility: "internal_lab_only",
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to save case note.",
      }));
    }

    // For legacy originals, run the reciprocal blob update (activityLog
    // append on the lab_cases row) synchronously BEFORE the auto-invoice
    // Promise.all so any failure is surfaced as a user-visible warning in
    // the 201 response rather than being silently swallowed.
    //
    // The forward "remake_of" and — for canonical originals — the backward
    // "remade_by" case_events rows were already written inside the main
    // transaction (atomic with case creation). Only the legacy JSON blob
    // patch cannot participate in that transaction, so it runs here.
    let remakeLegacyHistoryWarning: string | null = null;
    if (remakeOriginal?.kind === "legacy") {
      const legacyReason = input.remakeReason ?? null;
      const legacyCharged = input.remakeCharged ?? null;
      await writeReciprocalRemadeBy(
        remakeOriginal,
        { id: createdCase.id, caseNumber: createdCase.caseNumber },
        legacyReason,
        legacyCharged,
        {
          userId: (req as any).auth.userId,
          orgId: input.labOrganizationId,
          initials: user?.initials || "SYS",
        },
      ).catch((err: unknown) => {
        req.log.warn(
          { err, newCaseId: createdCase.id, originalId: remakeOriginal!.id },
          "writeReciprocalRemadeBy (legacy blob) failed — forward case_events row is committed, but lab_cases activityLog may be incomplete",
        );
        remakeLegacyHistoryWarning =
          "The original case's history (a legacy mobile case) could not be updated. The remake link is recorded and the new case is fully created, but the original's timeline may not show this remake. Please check the original case manually.";
      });
    }

    // No-charge remake exception: when the user explicitly marked the
    // remake as "no charge" we still create the invoice so it's visible
    // in the Invoice tab, but force it to $0 with all restoration line
    // items zeroed and a "no-charge remake" note attached. This keeps
    // the existing invoice flow consistent (every case has an invoice)
    // while making the no-charge intent explicit and auditable.
    const noChargeRemake =
      !!remakeOriginal && input.remakeCharged === false;

    // Persist the invoice before any independent post-create work. On an
    // invoice failure compensation cannot race a timeline/audit writer.
      // Auto-generate an invoice for every new case so the History tab
      // shows the invoice and the Invoice tab is immediately editable.
      // The invoice is created in "open" status (not "draft") so it shows
      // up as an active, open balance from day one — even for AI-imported
      // / drag-and-dropped cases that may not have priced restorations yet.
      //
      // We also pre-populate displayMetadataJson with the patient name,
      // tooth list, shade, and case notes pulled from the case + its
      // restorations so the Invoice tab doesn't show empty fields the
      // user has to copy over by hand.
      await (async () => {
        try {
          await db.transaction(async (tx) => {
          // The case is already committed; the invoice header, lines and
          // totals must commit together or not at all.
          const [alreadyLinked] = await tx.select().from(invoices).where(
            and(eq(invoices.caseId, createdCase.id), eq(invoices.labOrganizationId, createdCase.labOrganizationId), isNull(invoices.deletedAt)),
          ).for("update");
          if (alreadyLinked) return;
          // Fetch restorations, provider org, and case notes in parallel —
          // all three are independent reads against different tables.
          const [restorationsForInvoice, providerOrgRow, caseLevelNotes] =
            await Promise.all([
               tx.query.caseRestorations.findMany({
                where: eq(caseRestorations.caseId, createdCase.id),
              }),
               tx.query.organizations.findFirst({
                where: eq(organizations.id, createdCase.providerOrganizationId),
              }),
               tx.query.caseNotes.findMany({
                 where: and(eq(caseNotes.caseId, createdCase.id), eq(caseNotes.visibility, "shared_with_provider")),
              }),
            ]);

          // "missing" markers are clinical annotations, not billable items —
          // exclude them from invoice line items and display metadata.
          const billableRestorations = restorationsForInvoice.filter(
            (r) => !/^missing$/i.test(r.restorationType ?? ""),
          );
          const hasLines = billableRestorations.length > 0;
          const invoiceNumber = `INV-${createdCase.caseNumber}`;
          const noChargeNote = noChargeRemake
            ? `No-charge remake of case ${remakeOriginal!.caseNumber}${input.remakeReason ? ` — reason: ${input.remakeReason}` : ""}`
            : null;

          // Build the display metadata so the Invoice tab shows patient,
          // teeth, shade, and case notes without the user having to retype
          // anything. Sources:
          //   • patientName  — case.patientFirstName + patientLastName
          //   • teeth        — distinct tooth numbers across restorations
          //   • shade        — distinct shades across restorations
          //   • caseNotes    — restoration-level notes joined; the case-
          //                    level notes table is populated separately
          //                    (e.g. iTero AI import) and we read those too
          const billToName =
            providerOrgRow?.displayName || providerOrgRow?.name || "";
          const teethList = Array.from(
            new Set(
              billableRestorations
                .map((r) => (r.toothNumber || "").trim())
                .filter(Boolean),
            ),
          ).join(", ");
          const shadeList = Array.from(
            new Set(
              billableRestorations
                .map((r) => (r.shade || "").trim())
                .filter(Boolean),
            ),
          ).join(", ");
          // material — distinct materials across restorations, populated by
          // the AI prescription intake / iTero importer the same way shade is.
          const materialList = Array.from(
            new Set(
              billableRestorations
                .map((r) => (r.material || "").trim())
                .filter(Boolean),
            ),
          ).join(", ");
          const caseNotesText = [
            ...caseLevelNotes.map((n) => (n.noteText || "").trim()),
            ...billableRestorations.map((r) => (r.notes || "").trim()),
          ]
            .filter(Boolean)
            .join("\n");
          const displayMetadata: Record<string, unknown> = {
            patientName: `${input.patientFirstName} ${input.patientLastName}`.trim(),
            billTo: billToName,
            teeth: teethList,
            shade: shadeList,
            material: materialList,
            caseNotes: caseNotesText,
            credits: 0,
          };
           const doctorIdentity = await ensureDoctorProfileIdentity(tx, {
            labOrganizationId: createdCase.labOrganizationId,
            providerOrganizationId: createdCase.providerOrganizationId ?? null,
            doctorName: billToName,
          });

           const newInvoice = await insertOrResolveAiIntakeInvoice(tx, {
              invoiceNumber,
              caseId: createdCase.id,
              labOrganizationId: createdCase.labOrganizationId,
              providerOrganizationId: createdCase.providerOrganizationId,
              doctorIdentity,
              // Always create the invoice as "open" (active, awaiting
              // payment) — never "draft". Even an empty / unpriced auto-
              // invoice should appear on the open-balance worklist so the
              // lab knows it needs to be filled in and sent.
              status: "open",
              issuedAt: calendarDateToUtcNoon(createdCase.receivedAt),
              dueAt: invoiceDueDate(new Date()),
              displayMetadataJson: displayMetadata,
              createdByUserId: (req as any).auth.userId,
              updatedByUserId: (req as any).auth.userId,
              ...((noChargeNote || input.invoiceNotes?.trim())
                ? { notes: [noChargeNote, input.invoiceNotes?.trim()].filter(Boolean).join("\n\n") }
                : {}),
             }, createdCase.id, createdCase.labOrganizationId);
           if (!newInvoice.newlyCreated) return;
          if (newInvoice) {
            const lineItemsMeta: Array<{
              item: string;
              description: string;
              catalogItemKey: string | null;
              missingCatalogItem: boolean;
            }> = [];
            // Admin/owner callers may supply explicit line items that bypass
            // the auto-pricing engine entirely. We honour them only when the
            // caller is admin/owner AND the field is present AND it is NOT a
            // no-charge remake (those must be zeroed by the server for
            // auditability — we cannot trust client-supplied $0 lines).
            const useOverrideLines =
              callerIsAdminOrOwner &&
              Array.isArray(input.invoiceOverrideLines) &&
              !noChargeRemake;
            if (useOverrideLines) {
              const explicitLines = input.invoiceOverrideLines!;
              const reviewedItems = reviewedLinesToInvoiceItems(explicitLines, newInvoice.id);
              lineItemsMeta.push(...reviewedItems.map((line) => ({
                item: line.catalogItemLabel,
                description: line.description,
                catalogItemKey: line.catalogItemKey,
                missingCatalogItem: false,
                subItems: line.childItems.map((child) => ({ item: child.description, description: child.description })),
              })));
              await insertGroupedLineItemsWithChildren(tx, reviewedItems);
            } else if (hasLines) {
              // Batch-fetch all custom labels for this lab in one query so
              // the per-restoration label resolution below is N×0 DB calls
              // instead of the previous N×1 pattern.
              const labLabelMap = await fetchLabItemLabels(
                createdCase.labOrganizationId,
              );
               const parentLineRowsA = await tx.insert(invoiceLineItems).values(
                await Promise.all(billableRestorations.map(async (r, idx) => {
                  const catalogItemKey = await resolveRestorationPriceKey({
                    labOrganizationId: createdCase.labOrganizationId,
                    material: r.material,
                    restorationType: r.restorationType,
                    restorationSubtype: r.restorationSubtype,
                  });
                  const pk = catalogItemKey ?? r.restorationType;
                  const baseLabel = resolveItemLabelFromMap(labLabelMap, pk);
                   const baseDesc = `${buildLineItemDescription(r.toothNumber, baseLabel)}${r.arch ? ` - ${archLabel(r.arch as Arch)}` : ""}`;
                  const effectiveUnitPrice = noChargeRemake ? "0.00" : r.unitPrice;
                  lineItemsMeta.push({
                    item: baseLabel,
                    description: baseDesc,
                    catalogItemKey,
                    missingCatalogItem: !!catalogItemKey && Number(effectiveUnitPrice) <= 0,
                  });
                  return {
                    invoiceId: newInvoice.id,
                    caseRestorationId: r.id,
                    sourceType: "restoration",
                    sourceKey: `restoration:${r.id}`,
                    sourceRestorationIdsJson: [r.id],
                    description: noChargeRemake
                      ? `${baseDesc} (no-charge remake)`
                      : baseDesc,
                     quantity: r.arch ? 1 : r.quantity,
                    unitPrice: effectiveUnitPrice,
                    lineTotal: noChargeRemake
                      ? "0.00"
                       : calculateLineTotal(r.arch ? 1 : r.quantity, r.unitPrice),
                    sortOrder: idx,
                  };
                })),
              ).returning({ id: invoiceLineItems.id, sortOrder: invoiceLineItems.sortOrder });
              // Insert Layered Porcelain ($37) child sub-items for PFZ restorations.
              const pfzChildRowsA = [];
              for (const [idx, r] of billableRestorations.entries()) {
                if (!isPfzMaterial(r.material) || noChargeRemake) continue;
                const parent = parentLineRowsA.find((p) => p.sortOrder === idx);
                if (!parent) continue;
                pfzChildRowsA.push({
                  invoiceId: newInvoice.id,
                  parentLineItemId: parent.id,
                  sourceType: "restoration",
                  sourceKey: `synthetic:restoration:${r.id}:${LAYERED_PORCELAIN_DESCRIPTION.toLowerCase()}`,
                  sourceRestorationIdsJson: [],
                  description: LAYERED_PORCELAIN_DESCRIPTION,
                  quantity: 1,
                  unitPrice: LAYERED_PORCELAIN_SURCHARGE,
                  lineTotal: LAYERED_PORCELAIN_SURCHARGE,
                  sortOrder: 0,
                });
              }
              if (pfzChildRowsA.length > 0) {
                 await tx.insert(invoiceLineItems).values(pfzChildRowsA);
              }
            }
             const items = await tx.query.invoiceLineItems.findMany({
              where: eq(invoiceLineItems.invoiceId, newInvoice.id),
            });
            const subtotal = sumMoney(items.map((it) => it.lineTotal));
             const [finalized] = await tx
              .update(invoices)
              .set({
                subtotal,
                total: subtotal,
                balanceDue: subtotal,
                updatedByUserId: (req as any).auth.userId,
                displayMetadataJson: { ...displayMetadata, lineItems: lineItemsMeta, ...(useOverrideLines ? { reviewedCharges: true } : {}) },
              })
              .where(eq(invoices.id, newInvoice.id))
              .returning();
             if (!finalized) throw new Error("Invoice finalization returned no row.");
             await tx.insert(caseEvents).values({
              caseId: createdCase.id,
              eventType: "invoice_generated",
              actorUserId: (req as any).auth.userId,
              actorOrganizationId: createdCase.labOrganizationId,
              actorInitials: user?.initials || "SYS",
              metadataJson: {
                invoiceId: finalized.id,
                invoiceNumber: finalized.invoiceNumber,
                empty: !hasLines,
              },
            });
          }
          });
        } catch (err) {
          req.log?.error?.(
            { err, caseId: createdCase.id },
            "auto invoice generation on case create failed",
          );
           // The invoice transaction rolled back. Never delete a concurrently
           // linked invoice or a case that another writer has since completed.
          try {
            await db.transaction(async (cleanupTx) => {
               const [linked] = await cleanupTx.select({ id: invoices.id }).from(invoices)
                 .where(eq(invoices.caseId, createdCase.id)).for("update");
               if (linked) throw new Error("Case gained a linked invoice during cleanup.");
              await cleanupTx
                .delete(cases)
                .where(eq(cases.id, createdCase.id));
            });
          } catch (cleanupErr) {
            req.log?.error?.(
               { err: cleanupErr, caseId: createdCase.id },
              "failed to compensate incomplete case invoice creation",
            );
            throw new HttpError(
              500,
              "Case invoice creation failed and automatic cleanup could not complete; contact support before retrying.",
            );
          }
           throw new HttpError(err instanceof CaseInvoiceConflictError ? 409 : 500,
             err instanceof CaseInvoiceConflictError ? err.message : "Case invoice could not be persisted; please retry.");
        }
      })();
    await Promise.all([
      db.insert(caseEvents).values({
        caseId: createdCase.id,
        eventType: "case_created",
        actorUserId: (req as any).auth.userId,
        actorOrganizationId: input.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          patientFirstName: input.patientFirstName,
          patientLastName: input.patientLastName,
          restorations: input.restorations?.length || 0,
        },
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to record case_created timeline event.",
      })),
      writeAuditLog({
        req,
        organizationId: input.labOrganizationId,
        action: "case_created",
        entityType: "case",
        entityId: createdCase.id,
        afterJson: createdCase,
      }),
    ]);

    await deliverInAppNotification({
      labOrganizationId: createdCase.labOrganizationId,
      category: input.priority === "rush" ? "rush_case" : "new_case",
      type: input.priority === "rush" ? "rush_case_created" : "case_created",
      title:
        input.priority === "rush"
          ? `Rush case: ${createdCase.caseNumber}`
          : `New case: ${createdCase.caseNumber}`,
      body: `Case ${createdCase.caseNumber} for ${[
        createdCase.patientFirstName,
        createdCase.patientLastName,
      ]
        .filter(Boolean)
        .join(" ") || "a patient"} was created.`,
      dataJson: {
        caseId: createdCase.id,
        caseNumber: createdCase.caseNumber,
      },
    });

    return ok(
      res,
      remakeLegacyHistoryWarning
        ? { ...createdCase, remakeWarning: remakeLegacyHistoryWarning }
        : createdCase,
      201,
    );
      })(),
      timeoutSignal,
    ]);
  })
);

// ---------------------------------------------------------------------------
// POST /cases/:id/remake
// Creates a new case that is a remake of an existing case. Pre-populates
// patient, doctor, practice, and restoration fields from the original and
// writes reciprocal history events (remake_of on the new case, remade_by on
// the original). Accepts the structured remake questionnaire payload.
// Admin/owner only.
// ---------------------------------------------------------------------------
router.post(
  "/:id/remake",
  asyncHandler(async (req, res) => {
    const caseId = String(req.params["id"] ?? "");
    const userId = (req as any).auth.userId as string;
    const user = (req as any).user;
    const actorInitials: string = user?.initials || "SYS";

    // Verify the case exists
    const originalCase = await db.query.cases.findFirst({
      where: and(eq(cases.id, caseId), notDeleted(cases)),
    });
    if (!originalCase) throw new HttpError(404, "Case not found.");

    // Admin/owner gate: only lab members with admin or owner role may create remakes
    await requireAnyRole(userId, originalCase.labOrganizationId, ADMIN_ROLES);

    // Validate the remake questionnaire body
    const remakeBodySchema = z.object({
      remakeReasonKey: z.enum(REMAKE_REASON_KEYS),
      remakeReason: z.string().min(1).max(2000),
      remakeCharged: z.boolean().nullable().default(null),
      remakeShadeLightness: z.enum(["light", "dark"]).optional(),
      remakeShadePrescribed: z.string().max(200).optional(),
      remakeShadeProvided: z.string().max(200).optional(),
      remakeMaterialPrescribed: z.string().max(200).optional(),
      remakeMaterialProvided: z.string().max(200).optional(),
      remakeReturnedToLab: z.boolean().optional(),
      remakeCategory: z.enum(["crown_bridge", "removable"]).optional(),
      remakeNotes: z.string().max(2000).optional(),
      dueDate: z.string().optional(),
      dueTime: z
        .union([z.string().refine(isValidDueTime, "Invalid due time"), z.null()])
        .optional(),
    });
    const input = remakeBodySchema.parse(req.body);

    // dueTime is only valid when dueDate is also supplied
    if (input.dueTime != null && !input.dueDate) {
      throw new HttpError(400, "Cannot set a due time without a due date.");
    }

    // Resolve due date — use caller-supplied date when provided, otherwise
    // inherit from the original case; always apply the lab-level cap.
    const dueDateOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, originalCase.labOrganizationId),
      columns: { defaultCaseDueDays: true, capCaseDueToDefault: true },
    });
    const suppliedDueDate: Date | null = input.dueDate ? new Date(input.dueDate) : null;
    const resolvedDueDate = resolveCaseDueDate(
      suppliedDueDate ?? (originalCase.dueDate ? new Date(originalCase.dueDate) : null),
      new Date(),
      dueDateOrg?.defaultCaseDueDays,
      dueDateOrg?.capCaseDueToDefault,
    );

    // Create the remake case and link it via the same shared function that
    // powers PATCH /:caseId/mark-as-remake
    // (`linkExistingCaseAsRemake`), so suffix assignment, history events,
    // invoice zeroing, and audit logging cannot drift between the three
    // remake surfaces. Root resolution ensures remaking a non-root node
    // (e.g. "26-334B") yields "26-334C" rather than "26-334BB".
    const resolvedCategory =
      input.remakeCategory ?? inferRemakeCategory(input.remakeReasonKey) ?? null;
    const createdCase = await createRemakeCaseAndLink(
      req,
      {
        labOrganizationId: originalCase.labOrganizationId,
        providerOrganizationId: originalCase.providerOrganizationId,
        patientFirstName: originalCase.patientFirstName,
        patientLastName: originalCase.patientLastName,
        doctorName: originalCase.doctorName,
        status: "received",
        priority: "normal",
        dueDate: resolvedDueDate,
        dueTime: input.dueDate ? (input.dueTime ?? null) : null,
        createdByUserId: userId,
      },
      {
        remakeOfCaseId: caseId,
        remakeReason: input.remakeReason,
        remakeCharged: input.remakeCharged ?? null,
        remakeReasonKey: input.remakeReasonKey,
        remakeShadeLightness: input.remakeShadeLightness,
        remakeShadePrescribed: input.remakeShadePrescribed,
        remakeShadeProvided: input.remakeShadeProvided,
        remakeMaterialPrescribed: input.remakeMaterialPrescribed,
        remakeMaterialProvided: input.remakeMaterialProvided,
        remakeReturnedToLab: input.remakeReturnedToLab,
        remakeCategory: resolvedCategory ?? undefined,
        remakeNotes: input.remakeNotes,
      },
      { userId, initials: actorInitials },
    );

    await deliverInAppNotification({
      labOrganizationId: createdCase.labOrganizationId,
      category: createdCase.priority === "rush" ? "rush_case" : "new_case",
      type: createdCase.priority === "rush" ? "rush_case_created" : "case_created",
      title:
        createdCase.priority === "rush"
          ? `Rush case: ${createdCase.caseNumber}`
          : `New case: ${createdCase.caseNumber}`,
      body: `Remake case ${createdCase.caseNumber} was created.`,
      dataJson: {
        caseId: createdCase.id,
        caseNumber: createdCase.caseNumber,
      },
    });

    // Clone restorations from the original, re-pricing any with zero unit price
    const originalRestorations = await db.query.caseRestorations.findMany({
      where: eq(caseRestorations.caseId, caseId),
    });

    if (originalRestorations.length > 0) {
      const needsAutoPrice = originalRestorations.some(
        (r) => Number(r.unitPrice ?? 0) <= 0,
      );
      const batchPriceMap = new Map<string, ResolvedItemRow>();
      if (needsAutoPrice) {
        const allPrices = await resolveAllPricesForContext({
          labOrganizationId: originalCase.labOrganizationId,
          doctorName: originalCase.doctorName,
          providerOrganizationId: originalCase.providerOrganizationId,
        });
        for (const p of allPrices) batchPriceMap.set(p.key, p);
      }

      const restorationRows = await Promise.all(originalRestorations.map(async (r) => {
        let unit = Number(r.unitPrice ?? 0);
        let priceSource: string | null = null;
        let priceSourceId: string | null = null;
        let priceSourceName: string | null = null;
        let priceKey: string | null = null;

        if (unit <= 0 && needsAutoPrice) {
          const key = await resolveRestorationPriceKey({
            labOrganizationId: originalCase.labOrganizationId,
            material: r.material,
            restorationType: r.restorationType,
            restorationSubtype: r.restorationSubtype,
          });
          if (key !== null && batchPriceMap.has(key)) {
            const hit = batchPriceMap.get(key)!;
            if (hit.source !== null && hit.unitPrice > 0) {
              unit = hit.unitPrice;
              priceSource = hit.source;
              priceSourceId = hit.sourceId;
              priceSourceName = hit.sourceName;
              priceKey = hit.key;
            }
          }
        } else if (unit > 0) {
          priceSource = "manual";
        }

        return {
          caseId: createdCase.id,
          toothNumber: r.toothNumber,
          ...implantValues(r),
          restorationSubtype: r.restorationSubtype,
          restorationType: r.restorationType,
          material: r.material ?? null,
          shade: r.shade ?? null,
          notes: r.notes ?? null,
          quantity: r.quantity,
          unitPrice: unit.toFixed(2),
          priceSource,
          priceSourceId,
          priceSourceName,
          priceKey,
        };
      }));

      await db
        .insert(caseRestorations)
        .values(restorationRows)
        .catch((err: unknown): never =>
          wrapDbError(err, { fallback: "Failed to clone restorations for remake." }),
        );
    }

    // Best-effort background tasks: case_created event, audit log, auto-invoice
    void (async () => {
      try {
        await Promise.all([
          db.insert(caseEvents).values({
            caseId: createdCase.id,
            eventType: "case_created",
            actorUserId: userId,
            actorOrganizationId: originalCase.labOrganizationId,
            actorInitials,
            metadataJson: { via: "remake_from_detail", originalCaseId: caseId },
          }),
          writeAuditLog({
            userId,
            organizationId: originalCase.labOrganizationId,
            action: "case.remake_created",
            entityType: "case",
            entityId: createdCase.id,
            metadataJson: {
              originalCaseId: caseId,
              originalCaseNumber: originalCase.caseNumber,
              newCaseNumber: createdCase.caseNumber,
            },
          }),
        ]);
      } catch (err) {
        req.log.warn(
          { err, caseId: createdCase.id },
          "remake case_created event/audit failed",
        );
      }

      // Auto-invoice (best-effort, mirrors POST /cases pattern)
      try {
        const noChargeRemake = input.remakeCharged === false;
        const [providerOrgRow, remakeRestorations] = await Promise.all([
          db.query.organizations.findFirst({
            where: eq(organizations.id, originalCase.providerOrganizationId ?? ""),
          }),
          db.query.caseRestorations.findMany({
            where: eq(caseRestorations.caseId, createdCase.id),
          }),
        ]);

        const billableRestorations = remakeRestorations.filter(
          (r) => !/^missing$/i.test(r.restorationType ?? ""),
        );
        const hasLines = billableRestorations.length > 0;
        const invoiceNumber = `INV-${createdCase.caseNumber}`;
        const noChargeNote = noChargeRemake
          ? `No-charge remake of case ${originalCase.caseNumber}${input.remakeReason ? ` — reason: ${input.remakeReason}` : ""}`
          : null;

        const patientDisplayName =
          `${originalCase.patientFirstName ?? ""} ${originalCase.patientLastName ?? ""}`.trim();
        const billToName = providerOrgRow?.displayName || providerOrgRow?.name || "";
        const teethList = Array.from(
          new Set(
            billableRestorations.map((r) => (r.toothNumber || "").trim()).filter(Boolean),
          ),
        ).join(", ");
        const shadeList = Array.from(
          new Set(
            billableRestorations.map((r) => (r.shade || "").trim()).filter(Boolean),
          ),
        ).join(", ");
        const materialList = Array.from(
          new Set(
            billableRestorations.map((r) => (r.material || "").trim()).filter(Boolean),
          ),
        ).join(", ");

        const displayMetadata = {
          patientName: patientDisplayName,
          billTo: billToName,
          teeth: teethList,
          shade: shadeList,
          material: materialList,
          caseNotes: "",
          credits: 0,
        };
        const doctorIdentity = await ensureDoctorProfileIdentity(db, {
          labOrganizationId: createdCase.labOrganizationId,
          providerOrganizationId: createdCase.providerOrganizationId ?? null,
          doctorName: billToName,
        });

        const [newInvoice] = await db
          .insert(invoices)
          .values({
            invoiceNumber,
            caseId: createdCase.id,
            labOrganizationId: createdCase.labOrganizationId,
            providerOrganizationId: createdCase.providerOrganizationId,
            doctorIdentity,
            status: "open",
            issuedAt: calendarDateToUtcNoon(createdCase.receivedAt),
            dueAt: invoiceDueDate(new Date()),
            displayMetadataJson: displayMetadata,
            createdByUserId: userId,
            updatedByUserId: userId,
            ...(noChargeNote ? { notes: noChargeNote } : {}),
          })
          .onConflictDoNothing()
          .returning();

        if (newInvoice && hasLines) {
          const labLabelMap = await fetchLabItemLabels(createdCase.labOrganizationId);
          const parentLineRowsB = await db.insert(invoiceLineItems).values(
            await Promise.all(billableRestorations.map(async (r, idx) => {
              const catalogItemKey = await resolveRestorationPriceKey({
                labOrganizationId: createdCase.labOrganizationId,
                material: r.material,
                restorationType: r.restorationType,
                restorationSubtype: r.restorationSubtype,
              });
              const pk = catalogItemKey ?? r.restorationType;
              const baseLabel = resolveItemLabelFromMap(labLabelMap, pk);
              const baseDesc = buildLineItemDescription(r.toothNumber, baseLabel);
              const effectiveUnitPrice = noChargeRemake ? "0.00" : r.unitPrice;
              return {
                invoiceId: newInvoice.id,
                caseRestorationId: r.id,
                sourceType: "restoration",
                sourceKey: `restoration:${r.id}`,
                sourceRestorationIdsJson: [r.id],
                description: noChargeRemake
                  ? `${baseDesc} (no-charge remake)`
                  : baseDesc,
                quantity: r.quantity,
                unitPrice: effectiveUnitPrice,
                lineTotal: noChargeRemake
                  ? "0.00"
                  : calculateLineTotal(r.quantity, r.unitPrice),
                sortOrder: idx,
              };
            })),
          ).returning({ id: invoiceLineItems.id, sortOrder: invoiceLineItems.sortOrder });
          // Insert Layered Porcelain ($37) child sub-items for PFZ restorations.
          const pfzChildRowsB = [];
          for (const [idx, r] of billableRestorations.entries()) {
            if (!isPfzMaterial(r.material) || noChargeRemake) continue;
            const parent = parentLineRowsB.find((p) => p.sortOrder === idx);
            if (!parent) continue;
            pfzChildRowsB.push({
              invoiceId: newInvoice.id,
              parentLineItemId: parent.id,
              sourceType: "restoration",
              sourceKey: `synthetic:restoration:${r.id}:${LAYERED_PORCELAIN_DESCRIPTION.toLowerCase()}`,
              sourceRestorationIdsJson: [],
              description: LAYERED_PORCELAIN_DESCRIPTION,
              quantity: 1,
              unitPrice: LAYERED_PORCELAIN_SURCHARGE,
              lineTotal: LAYERED_PORCELAIN_SURCHARGE,
              sortOrder: 0,
            });
          }
          if (pfzChildRowsB.length > 0) {
            await db.insert(invoiceLineItems).values(pfzChildRowsB);
          }

          const lineItems = await db.query.invoiceLineItems.findMany({
            where: eq(invoiceLineItems.invoiceId, newInvoice.id),
          });
          const subtotal = sumMoney(lineItems.map((it) => it.lineTotal));
          await db
            .update(invoices)
            .set({ subtotal, total: subtotal, balanceDue: subtotal, updatedByUserId: userId })
            .where(eq(invoices.id, newInvoice.id));
        }

        if (newInvoice) {
          await db.insert(caseEvents).values({
            caseId: createdCase.id,
            eventType: "invoice_generated",
            actorUserId: userId,
            actorOrganizationId: createdCase.labOrganizationId,
            actorInitials,
            metadataJson: {
              invoiceId: newInvoice.id,
              invoiceNumber: newInvoice.invoiceNumber,
              empty: !hasLines,
            },
          });
        }
      } catch (err) {
        req.log.warn(
          { err, caseId: createdCase.id },
          "auto-invoice for remake case failed (best-effort)",
        );
      }
    })();

    broadcastCaseUpdated(originalCase.id, "remade");
    broadcastCaseUpdated(createdCase.id);
    return ok(res, { id: createdCase.id, caseNumber: createdCase.caseNumber }, 201);
  }),
);

// ---------------------------------------------------------------------------
// GET /cases/doctor-names
// Returns a sorted list of distinct non-empty doctor names visible to the
// caller. Scoped to the caller's authorized orgs. Lightweight — no full
// case join needed — so the DoctorNamePicker can populate immediately.
// ---------------------------------------------------------------------------
router.get(
  "/doctor-names",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;

    const directMembershipOrgIds = (
      await db.query.organizationMemberships.findMany({
        where: and(
          eq(organizationMemberships.userId, callerId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt)
        ),
      })
    ).map((m: any) => m.labId as string);
    const authorizedOrgIds = new Set<string>(directMembershipOrgIds);
    const callerUser = await db.query.users.findFirst({
      where: eq(users.id, callerId),
      columns: { userType: true },
    });
    if (callerUser?.userType === "provider") {
      const { providerOrgIds } =
        await getProviderOrgIdsForUserAndLinks(callerId);
      for (const id of providerOrgIds) authorizedOrgIds.add(id);
    }

    const membershipOrgIds = Array.from(authorizedOrgIds);
    if (!membershipOrgIds.length) return ok(res, []);

    // Legacy (mobile) names come from the projection the `lab_cases` trigger
    // keeps in step with `case_data`, so the common path reads short columns
    // instead of every blob in the caller's labs. Only the rows the
    // projection cannot answer arrive as blobs to parse here, and both kinds
    // come back from one statement so a row crossing between them cannot be
    // missed — see legacyDoctorNameSql, and the parity, shape and
    // single-snapshot guards in cases-doctor-names-projection.test.ts.
    const [canonicalRows, legacyResult] = await Promise.all([
      db
        .selectDistinct({ doctorName: cases.doctorName })
        .from(cases)
        .where(
          and(
            or(
              inArray(cases.labOrganizationId, membershipOrgIds),
              inArray(cases.providerOrganizationId, membershipOrgIds)
            ),
            notDeleted(cases),
            isNotNull(cases.doctorName),
            ne(cases.doctorName, "")
          )
        ),
      db.execute(legacyDoctorNameSql({ organizationIds: membershipOrgIds })),
    ]);
    const legacyRows = (((legacyResult as { rows?: unknown[] }).rows ??
      legacyResult) ?? []) as Array<{
      kind: "name" | "blob";
      value: string | null;
    }>;

    const nameSet = new Set<string>();
    for (const row of canonicalRows) {
      const n = (row.doctorName ?? "").trim();
      if (n) nameSet.add(n);
    }
    for (const row of legacyRows) {
      if (row.kind === "name") {
        const n = String(row.value ?? "").trim();
        if (n) nameSet.add(n);
        continue;
      }
      try {
        const parsed =
          typeof row.value === "string" ? JSON.parse(row.value) : row.value;
        const n = String((parsed as any)?.doctorName ?? "").trim();
        if (n) nameSet.add(n);
      } catch {
        // skip malformed rows
      }
    }

    const sorted = Array.from(nameSet).sort((a, b) => a.localeCompare(b));
    return ok(res, sorted);
  })
);

// ---------------------------------------------------------------------------
// GET /cases/doctor-directory
// Returns doctor name -> provider org (practice) associations derived from
// canonical cases, so the dashboard Rx import can auto-fill the practice when
// a known doctor is picked. Each row is a (doctorName, providerOrganizationId)
// pair with a case count, letting the client pick the doctor's primary
// practice. Scoped to the caller's authorized orgs (mirrors /doctor-names).
// Legacy `lab_cases` rows are intentionally excluded: they carry no
// providerOrganizationId, so they cannot map a doctor to a practice.
// ---------------------------------------------------------------------------
router.get(
  "/doctor-directory",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;

    const directMembershipOrgIds = (
      await db.query.organizationMemberships.findMany({
        where: and(
          eq(organizationMemberships.userId, callerId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt)
        ),
      })
    ).map((m: any) => m.labId as string);
    const authorizedOrgIds = new Set<string>(directMembershipOrgIds);
    const callerUser = await db.query.users.findFirst({
      where: eq(users.id, callerId),
      columns: { userType: true },
    });
    if (callerUser?.userType === "provider") {
      const { providerOrgIds } =
        await getProviderOrgIdsForUserAndLinks(callerId);
      for (const id of providerOrgIds) authorizedOrgIds.add(id);
    }

    const membershipOrgIds = Array.from(authorizedOrgIds);
    if (!membershipOrgIds.length) return ok(res, []);

    const rows = await db
      .select({
        doctorName: cases.doctorName,
        providerOrganizationId: cases.providerOrganizationId,
        caseCount: sql<number>`count(*)::int`,
      })
      .from(cases)
      .where(
        and(
          or(
            inArray(cases.labOrganizationId, membershipOrgIds),
            inArray(cases.providerOrganizationId, membershipOrgIds)
          ),
          notDeleted(cases),
          isNotNull(cases.doctorName),
          ne(cases.doctorName, ""),
          isNotNull(cases.providerOrganizationId)
        )
      )
      .groupBy(cases.doctorName, cases.providerOrganizationId)
      // Deterministic ordering so the client's "highest case count wins" pick is
      // stable: most cases first, then a fixed tie-break on provider org id. The
      // client keeps the first row seen per doctor (strict `>`), so ties always
      // resolve to the same practice instead of arbitrary DB row order.
      .orderBy(sql`count(*) DESC`, cases.providerOrganizationId);

    const out = rows
      .map((r) => ({
        doctorName: String(r.doctorName ?? "").trim(),
        providerOrganizationId: String(r.providerOrganizationId ?? ""),
        caseCount: Number(r.caseCount ?? 0),
      }))
      .filter((r) => r.doctorName && r.providerOrganizationId);

    return ok(res, out);
  })
);

// ---------------------------------------------------------------------------
// GET /cases/legacy-doctor-directory
// Returns doctor names that exist ONLY as legacy / providerless data — i.e.
// legacy `lab_cases` blobs (which carry no providerOrganizationId) and
// canonical `cases` with a NULL providerOrganizationId. These names surface in
// the dashboard doctor-name picker (via /doctor-names) but never in Customer
// Center, which builds its rows from provider-attached canonical cases only.
// Grouping them per lab lets Customer Center show an "Unassigned / legacy
// doctor names" bucket and merge each typo/orphan into a real canonical doctor.
//
// Scoped to the caller's authorized orgs (mirrors /doctor-names). Unlike
// /doctor-directory, this endpoint is *specifically* the providerless set, so
// it must never be used for the picker's practice auto-fill.
// ---------------------------------------------------------------------------
router.get(
  "/legacy-doctor-directory",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;

    const directMembershipOrgIds = (
      await db.query.organizationMemberships.findMany({
        where: and(
          eq(organizationMemberships.userId, callerId),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt)
        ),
      })
    ).map((m: any) => m.labId as string);
    const authorizedOrgIds = new Set<string>(directMembershipOrgIds);
    const callerUser = await db.query.users.findFirst({
      where: eq(users.id, callerId),
      columns: { userType: true },
    });
    if (callerUser?.userType === "provider") {
      const { providerOrgIds } =
        await getProviderOrgIdsForUserAndLinks(callerId);
      for (const id of providerOrgIds) authorizedOrgIds.add(id);
    }

    const membershipOrgIds = Array.from(authorizedOrgIds);
    if (!membershipOrgIds.length) return ok(res, []);

    const [canonicalRows, mobileRows] = await Promise.all([
      // Canonical cases that were never attached to a practice.
      db
        .select({
          doctorName: cases.doctorName,
          labOrganizationId: cases.labOrganizationId,
          caseCount: sql<number>`count(*)::int`,
        })
        .from(cases)
        .where(
          and(
            inArray(cases.labOrganizationId, membershipOrgIds),
            notDeleted(cases),
            isNotNull(cases.doctorName),
            ne(cases.doctorName, ""),
            isNull(cases.providerOrganizationId)
          )
        )
        .groupBy(cases.doctorName, cases.labOrganizationId),
      // Legacy mobile cases store the doctor name inside a JSON blob and never
      // carry a providerOrganizationId, so every one of them is providerless.
      db
        .select({
          caseData: labCases.caseData,
          labOrganizationId: labCases.organizationId,
        })
        .from(labCases)
        .where(
          and(
            isNull(labCases.deletedAt),
            inArray(labCases.organizationId, membershipOrgIds)
          )
        ),
    ]);

    // Aggregate per (labOrganizationId, doctorName). Group case-insensitively
    // but keep the first-seen display spelling so the merge dialog sends a name
    // the case-insensitive merge WHERE clause still matches.
    const agg = new Map<
      string,
      { doctorName: string; labOrganizationId: string; totalCases: number }
    >();
    const add = (name: string, labId: string, count: number) => {
      const trimmed = name.trim();
      if (!trimmed || !labId) return;
      const key = `${labId}|${trimmed.toLowerCase()}`;
      const existing = agg.get(key);
      if (existing) {
        existing.totalCases += count;
      } else {
        agg.set(key, {
          doctorName: trimmed,
          labOrganizationId: labId,
          totalCases: count,
        });
      }
    };

    for (const row of canonicalRows) {
      add(
        String(row.doctorName ?? ""),
        String(row.labOrganizationId ?? ""),
        Number(row.caseCount ?? 0)
      );
    }
    for (const mr of mobileRows) {
      try {
        const parsed =
          typeof mr.caseData === "string"
            ? JSON.parse(mr.caseData)
            : mr.caseData;
        const n = String(parsed?.doctorName ?? "").trim();
        if (n) add(n, String(mr.labOrganizationId ?? ""), 1);
      } catch {
        // skip malformed rows
      }
    }

    const out = Array.from(agg.values()).sort((a, b) => {
      if (b.totalCases !== a.totalCases) return b.totalCases - a.totalCases;
      return a.doctorName.localeCompare(b.doctorName);
    });

    return ok(res, out);
  })
);

/**
 * Statuses that take a case out of the lab's active workload. These make up the
 * large historical tail of a lab's `cases` table, so list endpoints keep them
 * bounded to the most-recent window. Every other status counts as "open" and is
 * always returned in full (see OPEN_CASE_SAFETY_LIMIT).
 */
const CLOSED_CASE_STATUSES = ["complete", "delivered", "cancelled"] as const;

/** Bound on the most-recent-first window of cases regardless of status. */
const RECENT_CASE_LIMIT = 500;

/**
 * Generous safety bound on the always-included open-case query. Labs carry far
 * fewer open cases than total cases (hundreds, not thousands), so this exists
 * only so a pathological tenant cannot produce an unbounded response.
 */
const OPEN_CASE_SAFETY_LIMIT = 5000;

const caseListColumns = {
  id: true,
  caseNumber: true,
  labOrganizationId: true,
  providerOrganizationId: true,
  patientFirstName: true,
  patientLastName: true,
  externalPatientId: true,
  doctorName: true,
  status: true,
  priority: true,
  dueDate: true,
  dueTime: true,
  expectedDeliveryDate: true,
  receivedAt: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  deletedByUserId: true,
  needsAiReview: true,
  aiImportSource: true,
  remakeOfCaseId: true,
  remakeReason: true,
  remakeCharged: true,
  remakeReasonKey: true,
  remakeShadeLightness: true,
  remakeShadePrescribed: true,
  remakeShadeProvided: true,
  remakeMaterialPrescribed: true,
  remakeMaterialProvided: true,
  remakeReturnedToLab: true,
  remakeCategory: true,
  remakeNotes: true,
  suggestedDoctorName: true,
  suggestedProviderOrgId: true,
  casePanBarcode: true,
  bridgeConnectors: true,
  deliveryDateProposalDate: true,
  deliveryDateProposalNote: true,
  rxNotes: true,
  shade: true,
  step: true,
  stepShade: true,
  gingivialShade: true,
  isCustomShade: true,
  customShadeTechnician: true,
  customShadePicturesAvailable: true,
  customShadeVideoAvailable: true,
  labLocationId: true,
} as const;

const caseListRestorationColumns = {
  implantRetention: true,
  implantManufacturer: true,
  implantPlatformNotes: true,
  id: true,
  caseId: true,
  toothNumber: true,
  restorationType: true,
  restorationSubtype: true,
  material: true,
  shade: true,
  notes: true,
  quantity: true,
  unitPrice: true,
  priceSource: true,
  priceSourceId: true,
  priceSourceName: true,
  priceKey: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** SQL predicate matching cases that are still part of the active workload. */
const openCaseStatusFilter = notInArray(cases.status, [...CLOSED_CASE_STATUSES]);

/**
 * Merges the bounded most-recent window with the always-included open-case
 * window, de-duplicating by case id (the two queries overlap for recent open
 * cases) and restoring the newest-first ordering clients expect.
 *
 * Runs before enrichment so merged-in older rows get identical treatment
 * (restorations, invoice totals, provider account numbers, station names).
 */
function mergeCaseRowsNewestFirst<T extends { id: string; createdAt?: unknown }>(
  ...groups: T[][]
): T[] {
  const byId = new Map<string, T>();
  for (const group of groups) {
    for (const row of group) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  const createdAtMs = (row: T) => {
    const value = row.createdAt;
    if (!value) return 0;
    const ms = new Date(value as string | Date).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  };
  return Array.from(byId.values()).sort((a, b) => createdAtMs(b) - createdAtMs(a));
}

type WorklistContext = {
  membershipOrgIds: string[];
  billingLabOrgIds: string[];
  callerLabOrgSet: Set<string>;
  includeRestorations: boolean;
};

/**
 * The desktop worklist has a deliberately separate read path from the legacy
 * array endpoint.  Its first query projects only sortable/filterable candidate
 * fields, unifies both storage generations, de-duplicates them, and applies
 * LIMIT/OFFSET before any object restoration or display enrichment.
 */
async function getCasesWorklist(req: Request, context: WorklistContext) {
  const values = (name: string) =>
    (Array.isArray(req.query[name]) ? req.query[name] : String(req.query[name] ?? "").split(","))
      .flatMap((value) => String(value).split(","))
      .map((value) => value.trim())
      .filter(Boolean);
  const search = String(req.query.search ?? "").trim().toLowerCase();
  const barcode = String(req.query.barcode ?? "").trim();
  const statuses = values("status").map((value) => value.toLowerCase());
  const priorities = values("priority").map((value) => value.toLowerCase());
  const categories = values("caseType").concat(values("category")).map((value) => value.toLowerCase());
  const taxonomyTypes = values("taxonomyType").map((value) => value.toLowerCase());
  const caseIds = values("caseId").concat(values("caseIds"));
  const conflictsOnly = ["true", "1"].includes(String(req.query.conflictsOnly ?? "").toLowerCase());
  const doctorName = String(req.query.doctorName ?? "").trim().toLowerCase();
  const providerOrganizationId = String(req.query.providerOrganizationId ?? "").trim();
  const openOnly = ["true", "1"].includes(String(req.query.openOnly ?? "").toLowerCase());
  const overdueOnly = ["true", "1"].includes(String(req.query.overdueOnly ?? "").toLowerCase());
  const overdueLocalDate = String(req.query.localDate ?? "").trim();
  const overdueDate = new Date(`${overdueLocalDate}T00:00:00.000Z`);
  const validOverdueDate =
    /^\d{4}-\d{2}-\d{2}$/.test(overdueLocalDate) &&
    Number.isFinite(overdueDate.getTime()) &&
    overdueDate.toISOString().slice(0, 10) === overdueLocalDate;
  if (overdueOnly && !validOverdueDate) {
    throw new HttpError(400, "A valid local date is required for the overdue filter.");
  }
  // New worklist calendar ranges are based on receipt. Keep the explicit
  // created-date range for older clients; Today uses receivedStart/End.
  const createdStart = String(req.query.createdStart ?? "").trim();
  const createdEnd = String(req.query.createdEnd ?? "").trim();
  const receivedStart = String(req.query.receivedStart ?? "").trim();
  const receivedEnd = String(req.query.receivedEnd ?? "").trim();
  const dueStart = String(req.query.dueStart ?? "").trim();
  const dueEnd = String(req.query.dueEnd ?? "").trim();

  if ((createdStart && !createdEnd) || (!createdStart && createdEnd) ||
    (receivedStart && !receivedEnd) || (!receivedStart && receivedEnd) ||
    (dueStart && !dueEnd) || (!dueStart && dueEnd)) {
    throw new HttpError(400, "Both start and end are required for a bounded date range.");
  }
  if (
    (createdStart && !/^\d{4}-\d{2}-\d{2}$/.test(createdStart)) ||
    (createdEnd && !/^\d{4}-\d{2}-\d{2}$/.test(createdEnd)) ||
    (receivedStart && !/^\d{4}-\d{2}-\d{2}$/.test(receivedStart)) ||
    (receivedEnd && !/^\d{4}-\d{2}-\d{2}$/.test(receivedEnd)) ||
    (dueStart && !/^\d{4}-\d{2}-\d{2}$/.test(dueStart)) ||
    (dueEnd && !/^\d{4}-\d{2}-\d{2}$/.test(dueEnd))
  ) {
    throw new HttpError(400, "Invalid received date.");
  }
  const createdStartDate = createdStart ? new Date(`${createdStart}T00:00:00`) : null;
  const createdEndExclusive = createdEnd ? new Date(`${createdEnd}T00:00:00`) : null;
  const dueStartDate = dueStart ? new Date(`${dueStart}T00:00:00`) : null;
  const dueEndExclusive = dueEnd ? new Date(`${dueEnd}T00:00:00`) : null;
  if (createdEndExclusive) createdEndExclusive.setDate(createdEndExclusive.getDate() + 1);
  if (dueEndExclusive) dueEndExclusive.setDate(dueEndExclusive.getDate() + 1);
  if ((receivedStart && receivedEnd && receivedStart > receivedEnd) ||
    (createdStartDate && createdEndExclusive && createdStartDate >= createdEndExclusive) ||
    (dueStartDate && dueEndExclusive && dueStartDate >= dueEndExclusive)) {
    throw new HttpError(400, "Date range end must not be before the start date.");
  }

  const parsedPage = Number.parseInt(String(req.query.page ?? "1"), 10) || 1;
  if (parsedPage < 1 || parsedPage > 200) throw new HttpError(400, "Page must be between 1 and 200.");
  const page = parsedPage;
  const pageSize = Math.max(1, Math.min(Number.parseInt(String(req.query.pageSize ?? "50"), 10) || 50, 100));
  const offset = (page - 1) * pageSize;
  const requestedSort = String(req.query.sortKey ?? "createdAt");
  const sortKey = ["createdAt", "caseNumber", "doctorName", "status", "dueDate", "totalPrice"].includes(requestedSort)
    ? requestedSort
    : "createdAt";
  const sortDir = String(req.query.sortDir ?? "desc").toLowerCase() === "asc" ? "asc" : "desc";
  if (!context.membershipOrgIds.length) {
    return { rows: [], total: 0, salesTotal: "0.00", page, pageSize, hasMore: false };
  }

  const list = (items: string[]) => sql.join(items.map((item) => sql`${item}`), sql`, `);
  const canonicalSearchDocument = sql`lower(
    coalesce(c.case_number, '') || ' ' ||
    coalesce(c.patient_first_name, '') || ' ' ||
    coalesce(c.patient_last_name, '') || ' ' ||
    coalesce(c.doctor_name, '') || ' ' ||
    coalesce(c.case_pan_barcode, '')
  )`;
  const filters = [
    ...(search ? [sql`(
      lower(coalesce(case_number, '')) like ${`%${search}%`} or
      lower(coalesce(patient_first_name, '')) like ${`%${search}%`} or
      lower(coalesce(patient_last_name, '')) like ${`%${search}%`} or
      lower(coalesce(patient_first_name, '') || ' ' || coalesce(patient_last_name, '')) like ${`%${search}%`} or
      lower(coalesce(doctor_name, '')) like ${`%${search}%`} or
      lower(coalesce(barcode, '')) like ${`%${search}%`}
    )`] : []),
    ...(barcode ? [sql`barcode = ${barcode}`] : []),
    ...(statuses.length ? [sql`lower(status) in (${list(statuses)})`] : []),
    ...(priorities.length ? [sql`lower(priority) in (${list(priorities)})`] : []),
    ...(categories.length ? [sql`category in (${list(categories)})`] : []),
    ...(taxonomyTypes.length ? [sql`taxonomy_type in (${list(taxonomyTypes)})`] : []),
    ...(caseIds.length ? [sql`id in (${list(caseIds)})`] : []),
    ...(doctorName ? [sql`lower(trim(doctor_name)) = ${doctorName}`] : []),
    ...(providerOrganizationId ? [sql`provider_organization_id = ${providerOrganizationId}`] : []),
    ...(openOnly ? [sql`lower(status) not in ('complete','delivered','cancelled')`] : []),
    ...(overdueOnly ? [sql`lower(status) not in ('complete','delivered','cancelled') and due_day < ${overdueLocalDate}::date`] : []),
    ...(receivedStart ? [sql`received_at >= ${receivedStart}`] : []),
    ...(receivedEnd ? [sql`received_at <= ${receivedEnd}`] : []),
    ...(createdStartDate ? [sql`created_at >= ${createdStartDate}`] : []),
    ...(createdEndExclusive ? [sql`created_at < ${createdEndExclusive}`] : []),
    ...(dueStartDate ? [sql`due_date >= ${dueStartDate}`] : []),
    ...(dueEndExclusive ? [sql`due_date < ${dueEndExclusive}`] : []),
    ...(conflictsOnly ? [sql`conflict_count > 1 and lower(status) not in ('complete','delivered','cancelled')`] : []),
  ];
  const whereSql = filters.length ? sql`where ${sql.join(filters, sql` and `)}` : sql``;
  // Push cheap canonical predicates into the source scan as well as retaining
  // the identical post-union predicate below. This avoids enriching rows that
  // can be rejected using indexed columns.
  const canonicalPushdown = conflictsOnly ? [] : [
    ...(search ? [sql`${canonicalSearchDocument} like ${`%${search}%`}`] : []),
    ...(barcode ? [sql`c.case_pan_barcode = ${barcode}`] : []),
    ...(statuses.length ? [sql`lower(c.status) in (${list(statuses)})`] : []),
    ...(priorities.length ? [sql`lower(c.priority) in (${list(priorities)})`] : []),
    ...(caseIds.length ? [sql`c.id in (${list(caseIds)})`] : []),
    ...(doctorName ? [sql`lower(trim(c.doctor_name)) = ${doctorName}`] : []),
    ...(providerOrganizationId ? [sql`c.provider_organization_id = ${providerOrganizationId}`] : []),
    ...(openOnly ? [sql`lower(c.status) not in ('complete','delivered','cancelled')`] : []),
    ...(overdueOnly ? [sql`lower(c.status) not in ('complete','delivered','cancelled') and (coalesce(c.due_date, c.expected_delivery_date) at time zone 'UTC')::date < ${overdueLocalDate}::date`] : []),
    ...(receivedStart ? [sql`c.received_at >= ${receivedStart}`] : []),
    ...(receivedEnd ? [sql`c.received_at <= ${receivedEnd}`] : []),
    ...(createdStartDate ? [sql`c.created_at >= ${createdStartDate}`] : []),
    ...(createdEndExclusive ? [sql`c.created_at < ${createdEndExclusive}`] : []),
    ...(dueStartDate ? [sql`c.due_date >= ${dueStartDate}`] : []),
    ...(dueEndExclusive ? [sql`c.due_date < ${dueEndExclusive}`] : []),
  ];
  const canonicalPushdownSql = canonicalPushdown.length
    ? sql`and ${sql.join(canonicalPushdown, sql` and `)}`
    : sql``;
  // Legacy projected rows use their compact trigram-indexed identity document
  // for source pushdown. The post-union predicate remains authoritative and
  // preserves the established per-field matching semantics.
  const sortColumn: Record<string, ReturnType<typeof sql>> = {
    createdAt: sql`created_at`,
    caseNumber: sql`lower(case_number)`,
    doctorName: sql`lower(doctor_name)`,
    status: sql`lower(status)`,
    dueDate: sql`due_date`,
    totalPrice: sql`total_price`,
  };
  const direction = sortDir === "asc" ? sql`asc` : sql`desc`;
  const invoicePrice = context.billingLabOrgIds.length
    ? sql`case when c.lab_organization_id in (${list(context.billingLabOrgIds)}) then coalesce((
        select i.total from invoices i
        where i.case_id = c.id
          and i.lab_organization_id = c.lab_organization_id
          and i.status <> 'void'
          and i.deleted_at is null
        order by i.created_at desc
        limit 1
      ), rs.total_price, 0) else coalesce(rs.total_price, 0) end`
    : sql`coalesce(rs.total_price, 0)`;

  // Legacy candidates come from the projected columns the `lab_cases` trigger
  // maintains, so this query never touches `case_data`. Rows the trigger has
  // not reached yet are still read the old way, but only when such a row
  // actually exists in the caller's labs — one indexed probe decides, and in
  // the normal case the statement below contains no reference to the blob at
  // all (asserted by cases-worklist-projection.test.ts).
  const unprojectedProbe = await db.execute(
    unprojectedLegacyProbeSql(context.membershipOrgIds),
  );
  const hasUnprojectedLegacy =
    (((unprojectedProbe as unknown as { rows?: unknown[] }).rows ??
      (unprojectedProbe as unknown as unknown[])) as unknown[]).length > 0;
  const legacyCandidateSql = hasUnprojectedLegacy
    ? sql`${legacyWorklistCandidateSql({
        organizationIds: context.membershipOrgIds,
        mode: "projected",
        search: conflictsOnly ? undefined : search,
      })}
      union all
      ${legacyWorklistCandidateSql({ organizationIds: context.membershipOrgIds, mode: "unprojected" })}`
    : legacyWorklistCandidateSql({
        organizationIds: context.membershipOrgIds,
        mode: "projected",
        search: conflictsOnly ? undefined : search,
      });
  const legacyConflictSourceSql = hasUnprojectedLegacy
    ? sql`${legacyWorklistCandidateSql({
        organizationIds: context.membershipOrgIds,
        mode: "projected",
      })}
      union all
      ${legacyWorklistCandidateSql({
        organizationIds: context.membershipOrgIds,
        mode: "unprojected",
      })}`
    : legacyWorklistCandidateSql({
        organizationIds: context.membershipOrgIds,
        mode: "projected",
      });

  const result = await db.execute(sql`
    with restoration_summary as (
      select cr.case_id,
        coalesce(sum(case when lower(coalesce(cr.restoration_type, '')) = 'missing' then 0
          else cr.quantity * cr.unit_price end), 0) as total_price,
        case
          when bool_or(lower(coalesce(cr.restoration_type, '') || ' ' || coalesce(cr.material, '') || ' ' || coalesce(cr.restoration_subtype, ''))
            ~ '(implant|abutment|screw[- ]?retained|all[- ]?on[- ]?(4|6|x))') then 'implants'
          when bool_or(lower(coalesce(cr.material, '')) ~ '(zirconia|bruxzir|brux|zirc|(^|[^a-z])zr([^a-z]|$)|bzr|pfz)') then 'zirconia'
          when bool_or(lower(coalesce(cr.restoration_type, '') || ' ' || coalesce(cr.material, '') || ' ' || coalesce(cr.restoration_subtype, ''))
            ~ '(crown|bridge|veneer|inlay|onlay|maryland|pontic|coping|lithium disilicate|(^|[^a-z])pfm([^a-z]|$)|gold|full cast|cast metal|semi precious)') then 'crown_bridge'
          when bool_or(lower(coalesce(cr.restoration_type, '') || ' ' || coalesce(cr.material, '') || ' ' || coalesce(cr.restoration_subtype, ''))
            ~ '(denture|partial|flipper|flexible|valplast|removable)') then 'removable'
          when bool_or(trim(coalesce(cr.restoration_type, '') || coalesce(cr.material, '') || coalesce(cr.restoration_subtype, '')) <> '') then 'other'
          else 'uncategorized'
        end as category,
        case
          when split_part(coalesce((array_agg(cr.restoration_subtype order by cr.created_at, cr.id))[1], ''), '/', 1)
            in ('restorative', 'removable', 'ortho')
            then split_part((array_agg(cr.restoration_subtype order by cr.created_at, cr.id))[1], '/', 1)
          when lower(coalesce((array_agg(cr.restoration_type order by cr.created_at, cr.id))[1], ''))
            ~ '(denture|partial|flipper|flexible|valplast|removable)' then 'removable'
          when lower(coalesce((array_agg(cr.restoration_type order by cr.created_at, cr.id))[1], ''))
            ~ '(night.?guard|retainer|splint|bleach.?tray|hawley|space.?maintainer|ortho|appliance)' then 'ortho'
          else 'restorative'
        end as taxonomy_type
      from case_restorations cr
      join cases c_scope on c_scope.id = cr.case_id
      where c_scope.deleted_at is null
        and (c_scope.lab_organization_id in (${list(context.membershipOrgIds)})
          or c_scope.provider_organization_id in (${list(context.membershipOrgIds)}))
      group by cr.case_id
    ),
    canonical as (
      select c.id, 0 as source_rank, 'canonical'::text as source,
        c.lab_organization_id, c.provider_organization_id, c.case_number,
        c.patient_first_name, c.patient_last_name, c.doctor_name,
        lower(c.status) as status, lower(c.priority) as priority,
         c.case_pan_barcode as barcode, c.created_at, c.received_at, c.due_date,
        case when c.remake_of_case_id is not null and c.remake_charged is false
          then 0 else ${invoicePrice}::numeric end as total_price,
        coalesce(rs.category, 'uncategorized') as category,
        rs.taxonomy_type as taxonomy_type,
        (coalesce(c.due_date, c.expected_delivery_date) at time zone 'UTC')::date as due_day
      from cases c left join restoration_summary rs on rs.case_id = c.id
      where c.deleted_at is null
        and (c.lab_organization_id in (${list(context.membershipOrgIds)})
          or c.provider_organization_id in (${list(context.membershipOrgIds)}))
         ${canonicalPushdownSql}
    ),
    legacy as (
      select legacy_source.*,
        (legacy_source.due_date at time zone 'UTC')::date as due_day
      from (${legacyCandidateSql}) legacy_source
    ),
    deduplicated as (
      select * from (
        select u.*, row_number() over (partition by id order by source_rank) as id_rank
        from (select * from canonical union all select * from legacy) u
      ) ranked where id_rank = 1
    ),
    conflict_keys as (
      select distinct lab_organization_id, barcode
      from deduplicated
      where barcode is not null and trim(barcode) <> ''
    ),
    barcode_conflict_counts as (
      select conflict_rows.lab_organization_id, conflict_rows.barcode,
        count(*)::integer as conflict_count
      from (
        select c.lab_organization_id, c.case_pan_barcode as barcode
        from cases c
        join conflict_keys keys
          on keys.lab_organization_id = c.lab_organization_id
          and keys.barcode = c.case_pan_barcode
        where c.deleted_at is null
          and (c.lab_organization_id in (${list(context.membershipOrgIds)})
            or c.provider_organization_id in (${list(context.membershipOrgIds)}))
          and lower(c.status) not in ('complete','delivered','cancelled')
        union all
        select legacy_conflict_source.lab_organization_id, legacy_conflict_source.barcode
        from (${legacyConflictSourceSql}) legacy_conflict_source
        join conflict_keys keys
          on keys.lab_organization_id = legacy_conflict_source.lab_organization_id
          and keys.barcode = legacy_conflict_source.barcode
        where legacy_conflict_source.barcode is not null
          and trim(legacy_conflict_source.barcode) <> ''
          and lower(legacy_conflict_source.status) not in ('complete','delivered','cancelled')
      ) conflict_rows
      group by conflict_rows.lab_organization_id, conflict_rows.barcode
    ),
    with_conflicts as (
      select d.*, coalesce(conflicts.conflict_count, 0) as conflict_count
      from deduplicated d
      left join barcode_conflict_counts conflicts
        on conflicts.lab_organization_id = d.lab_organization_id
        and conflicts.barcode = d.barcode
    ),
    filtered as (select * from with_conflicts ${whereSql}),
    page_rows as (
      select id, source, source_rank, total_price, conflict_count,
        row_number() over (order by ${sortColumn[sortKey]!} ${direction} nulls last, id asc) as page_order
      from filtered
      order by ${sortColumn[sortKey]!} ${direction} nulls last, id asc
      limit ${pageSize} offset ${offset}
    ),
    totals as (
      select count(*)::integer as total,
        coalesce(sum(total_price), 0)::numeric as sales_total
      from filtered
    )
    select p.id, p.source, p.total_price, p.conflict_count, t.total, t.sales_total
    from totals t left join page_rows p on true
    order by p.page_order
  `);
  const queryRows = ((result as unknown as { rows?: any[] }).rows ?? result) as any[];
  const total = Number(queryRows[0]?.total ?? 0);
  const salesTotal = Number(queryRows[0]?.sales_total ?? 0).toFixed(2);
  const pageCandidates = queryRows.filter((row) => row.id);
  const projectedPriceById = new Map(
    pageCandidates.map((row) => [String(row.id), Number(row.total_price ?? 0).toFixed(2)]),
  );
  const canonicalIds = pageCandidates.filter((row) => row.source === "canonical").map((row) => String(row.id));
  const legacyIds = pageCandidates.filter((row) => row.source === "legacy").map((row) => String(row.id));
  const [canonicalRows, legacyRows, restorations] = await Promise.all([
    canonicalIds.length ? db.query.cases.findMany({ where: inArray(cases.id, canonicalIds), columns: caseListColumns }) : [],
    legacyIds.length ? db.select(legacyCaseListColumns).from(labCases).where(inArray(labCases.id, legacyIds)) : [],
    canonicalIds.length ? db.query.caseRestorations.findMany({
      where: inArray(caseRestorations.caseId, canonicalIds),
      columns: caseListRestorationColumns,
    }) : [],
  ]);
  const restorationMap = new Map<string, any[]>();
  for (const restoration of restorations) {
    const items = restorationMap.get(restoration.caseId) ?? [];
    items.push(restoration);
    restorationMap.set(restoration.caseId, items);
  }
  const rowsById = new Map<string, any>();
  for (const row of canonicalRows as any[]) {
    const items = restorationMap.get(row.id) ?? [];
    const billable = items.filter((item) => !/^missing$/i.test(item.restorationType ?? ""));
    const restorationPrice = billable.reduce((sum, item) => sum + Number(item.quantity ?? 0) * Number(item.unitPrice ?? 0), 0);
    rowsById.set(row.id, {
      ...row,
      remakeNotes: context.callerLabOrgSet.has(row.labOrganizationId) ? row.remakeNotes ?? null : null,
      caseNotes: row.rxNotes ?? null,
      restorationCount: billable.length,
      restorationTypes: Array.from(new Set(billable.map((item) => item.restorationType).filter(Boolean))).join(", ") || null,
      restorationMaterials: Array.from(new Set(billable.map((item) => item.material).filter(Boolean))).join(", ") || null,
      firstRestorationSubtype: billable[0]?.restorationSubtype ?? null,
      teeth: billable.map((item) => item.toothNumber).filter(Boolean).join(", ") || null,
      totalPrice: projectedPriceById.get(row.id) ?? restorationPrice.toFixed(2),
      ...(context.includeRestorations ? { restorations: items } : {}),
    });
  }
  // Legacy rows are built from the projected summary the trigger keeps in
  // step with `case_data`. Only rows whose projection is missing or outdated
  // still have their blob fetched and parsed here.
  const legacyProjections = (legacyRows as LegacyCaseListRow[]).map((row) => ({
    row,
    resolved: resolveLegacyProjection(row),
  }));
  const unprojectedLegacyIds = legacyProjections
    .filter((entry) => entry.resolved.status === "unprojected")
    .map((entry) => String(entry.row.id));
  const legacyBlobRows = unprojectedLegacyIds.length
    ? await db.select(legacyCaseBlobColumns).from(labCases).where(inArray(labCases.id, unprojectedLegacyIds))
    : [];
  const legacyBlobById = new Map(
    (legacyBlobRows as { id: string; caseData: string }[]).map((row) => [String(row.id), row.caseData]),
  );
  for (const { row, resolved } of legacyProjections) {
    const price = projectedPriceById.get(String(row.id));
    if (resolved.status === "ready") {
      rowsById.set(row.id, buildWorklistLegacyRow(row, resolved.parsed, price));
      continue;
    }
    // A blob that parses to JSON null threw on property access before, and
    // still resolves to the same unreadable-row shape.
    if (resolved.status === "json-null") {
      rowsById.set(row.id, buildWorklistUnreadableLegacyRow(row));
      continue;
    }
    try {
      const parsed = JSON.parse(legacyBlobById.get(String(row.id)) ?? "");
      rowsById.set(row.id, buildWorklistLegacyRow(row, parsed, price));
    } catch {
      rowsById.set(row.id, buildWorklistUnreadableLegacyRow(row));
    }
  }
  const orderedRows = pageCandidates
    .map((candidate) => {
      const row = rowsById.get(String(candidate.id));
      return row
        ? { ...row, hasBarcodeConflict: Number(candidate.conflict_count ?? 0) > 1 }
        : null;
    })
    .filter(Boolean);

  // All remaining lookups are strictly page-ID bounded.
  const providerIds = Array.from(new Set(orderedRows.map((row) => row.providerOrganizationId).filter(Boolean))) as string[];
  const locationIds = Array.from(new Set(orderedRows.map((row) => row.labLocationId).filter(Boolean))) as string[];
  const labVisibleIds = orderedRows.filter((row) => context.callerLabOrgSet.has(row.labOrganizationId)).map((row) => String(row.id));
  const [providerRows, locationRows, exceptions] = await Promise.all([
    providerIds.length
      ? db.select({ id: organizations.id, accountNumber: organizations.accountNumber }).from(organizations).where(inArray(organizations.id, providerIds))
      : [],
    locationIds.length
      ? db.select({ id: labLocations.id, name: labLocations.name, labOrganizationId: labLocations.labOrganizationId })
          .from(labLocations).where(inArray(labLocations.id, locationIds))
      : [],
    labVisibleIds.length ? fetchActiveExceptionsForCaseIds(labVisibleIds) : new Map(),
  ]);
  const providerMap = new Map((providerRows as any[]).map((row) => [row.id, row.accountNumber ?? null]));
  const locationMap = new Map((locationRows as any[]).map((row) => [`${row.labOrganizationId}:${row.id}`, row.name]));
  for (const row of orderedRows) {
    row.providerAccountNumber = providerMap.get(row.providerOrganizationId) ?? null;
    const locationName = row.labLocationId ? locationMap.get(`${row.labOrganizationId}:${row.labLocationId}`) : null;
    row.labLocationId = locationName ? row.labLocationId : null;
    row.labLocationName = locationName ?? null;
    row.activeException = context.callerLabOrgSet.has(row.labOrganizationId) ? exceptions.get(String(row.id)) ?? null : null;
    row.hasActiveException = row.activeException !== null;
  }
  return { rows: orderedRows, total, salesTotal, page, pageSize, hasMore: offset + orderedRows.length < total };
}

router.get(
  "/customer-center-summary",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const memberships = await db.query.organizationMemberships.findMany({
      where: and(
        eq(organizationMemberships.userId, callerId),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt),
      ),
      columns: { labId: true },
    });
    const authorizedIds = new Set(memberships.map((membership) => membership.labId));
    const caller = await db.query.users.findFirst({
      where: eq(users.id, callerId),
      columns: { userType: true },
    });
    if (caller?.userType === "provider") {
      const linked = await getProviderOrgIdsForUserAndLinks(callerId);
      linked.providerOrgIds.forEach((id) => authorizedIds.add(id));
    }
    const scope = Array.from(authorizedIds);
    if (scope.length === 0) return ok(res, []);

    const [caseRows, invoiceRows] = await Promise.all([
      db
        .select({ providerOrganizationId: cases.providerOrganizationId })
        .from(cases)
        .where(and(
          isNull(cases.deletedAt),
          or(
            inArray(cases.labOrganizationId, scope),
            inArray(cases.providerOrganizationId, scope),
          ),
        )),
      db
        .select({
          id: invoices.id,
          providerOrganizationId: invoices.providerOrganizationId,
          total: invoices.total,
          balanceDue: invoices.balanceDue,
          status: invoices.status,
        })
        .from(invoices)
        .where(and(
          isNull(invoices.deletedAt),
          or(
            inArray(invoices.labOrganizationId, scope),
            inArray(invoices.providerOrganizationId, scope),
          ),
        )),
    ]);
    const depositedRows = invoiceRows.length
      ? await db
          .select({ invoiceId: bankTransactionInvoices.invoiceId })
          .from(bankTransactionInvoices)
          .where(inArray(
            bankTransactionInvoices.invoiceId,
            invoiceRows.map((invoice) => invoice.id),
          ))
      : [];
    const depositedIds = new Set(depositedRows.map((row) => row.invoiceId));
    type Summary = {
      caseCount: number;
      openBalance: number;
      totalBilled: number;
      invoiceCount: number;
      allPaid: boolean;
      allDeposited: boolean;
      anyOverdue: boolean;
    };
    const empty = (): Summary => ({
      caseCount: 0,
      openBalance: 0,
      totalBilled: 0,
      invoiceCount: 0,
      allPaid: true,
      allDeposited: true,
      anyOverdue: false,
    });
    const byPractice = new Map<string, Summary>();
    for (const row of caseRows) {
      if (!row.providerOrganizationId) continue;
      const stats = byPractice.get(row.providerOrganizationId) ?? empty();
      stats.caseCount += 1;
      byPractice.set(row.providerOrganizationId, stats);
    }
    for (const invoice of invoiceRows) {
      if (!invoice.providerOrganizationId) continue;
      const stats = byPractice.get(invoice.providerOrganizationId) ?? empty();
      stats.totalBilled += Number(invoice.total ?? 0);
      stats.openBalance += Number(invoice.balanceDue ?? 0);
      if (invoice.status !== "void") {
        stats.invoiceCount += 1;
        if (invoice.status !== "paid") stats.allPaid = false;
        if (!depositedIds.has(invoice.id)) stats.allDeposited = false;
        if (invoice.status === "overdue") stats.anyOverdue = true;
      }
      byPractice.set(invoice.providerOrganizationId, stats);
    }
    return ok(res, Array.from(byPractice, ([providerOrganizationId, stats]) => ({
      providerOrganizationId,
      ...stats,
    })));
  }),
);

router.get(
  ["/", "/worklist", "/overview"],
  asyncHandler(async (req, res) => {
    const organizationId = req.query.organizationId as string | undefined;
    const isWorklistRequest = req.path.endsWith("/worklist");
    const include = String(req.query.include ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const includeRestorations = include.includes("restorations");
    const callerId = (req as any).auth.userId as string;

    // Compute the caller's authoritative set of authorized organization ids:
    // direct active memberships plus, for provider users, every cross-lab
    // linked-doctor provider org (Task #320). This is the isolation boundary —
    // a case is only ever returned when its lab or provider org is in this set.
    const directMemberships = await db.query.organizationMemberships.findMany({
      where: and(
        eq(organizationMemberships.userId, callerId),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt)
      ),
      columns: {
        labId: true,
        role: true,
      },
    });
    const directMembershipOrgIds = directMemberships.map((m: any) => m.labId as string);
    // Invoice totals are visible only for labs where the caller has a billing
    // role. Provider-linked access to another lab's cases is not billing access.
    const billingLabOrgIds = directMemberships
      .filter((m: any) => BILLING_ROLES.includes(m.role))
      .map((m: any) => m.labId as string);
    const billingLabOrgSet = new Set(billingLabOrgIds);
    // Lab org IDs the caller has direct membership in — used to decide whether
    // to surface lab-internal fields (e.g. remakeNotes) vs redact for providers.
    const callerLabOrgSet = new Set<string>(directMembershipOrgIds);
    const authorizedOrgIds = new Set<string>(directMembershipOrgIds);
    const callerUser = await db.query.users.findFirst({
      where: eq(users.id, callerId),
      columns: { userType: true },
    });
    if (callerUser?.userType === "provider") {
      const { providerOrgIds } =
        await getProviderOrgIdsForUserAndLinks(callerId);
      for (const id of providerOrgIds) authorizedOrgIds.add(id);
    }

    // When the caller narrows to a single org it MUST be one they are
    // authorized for. Without this check any authenticated user could read
    // another tenant's cases by passing a foreign `organizationId`
    // (cross-tenant IDOR). Previously the supplied id was trusted verbatim.
    let membershipOrgIds: string[];
    if (organizationId) {
      if (!authorizedOrgIds.has(organizationId)) {
        throw new HttpError(403, "You do not have access to this organization.");
      }
      membershipOrgIds = [organizationId];
    } else {
      membershipOrgIds = Array.from(authorizedOrgIds);
    }

    if (req.path.endsWith("/overview")) {
      const parsed = GetCasesOverviewQueryParams.safeParse(req.query);
      if (!parsed.success || !isValidCalendarDate(parsed.data.localDate)) {
        throw new HttpError(400, "A valid localDate (YYYY-MM-DD) and localTime (HH:mm) are required.");
      }
      const counts = await getCasesOverview(membershipOrgIds, parsed.data.localDate, parsed.data.localTime);
      return ok(res, GetCasesOverview200Response.parse({ data: counts }).data);
    }

    if (isWorklistRequest) {
      return ok(res, await getCasesWorklist(req, {
        membershipOrgIds,
        billingLabOrgIds,
        callerLabOrgSet,
        includeRestorations,
      }));
    }

    // Keep the legacy array endpoint's historical response by default. The
    // shared parser makes limit/offset opt-in and rejects malformed values
    // instead of silently falling back to an unpaged response.
    const pagination = parsePagination(req.query);

    const queryValues = (name: string) =>
      (Array.isArray(req.query[name]) ? req.query[name] : String(req.query[name] ?? "").split(","))
        .flatMap((value) => String(value).split(","))
        .map((value) => value.trim())
        .filter(Boolean);
    // A list is deliberately an on-demand worklist.  Do this after auth/org
    // validation so a broad request cannot be used to probe tenant membership.
    const rawSearch = String(req.query.search ?? "").trim().toLowerCase();
    const rawBarcode = String(req.query.barcode ?? "").trim();
    const statuses = queryValues("status").map((value) => value.toLowerCase());
    const priorities = queryValues("priority").map((value) => value.toLowerCase());
    const categories = queryValues("caseType").concat(queryValues("category")).map((value) => value.toLowerCase());
    const importedCaseIds = queryValues("caseId").concat(queryValues("caseIds"));
    const conflictsOnly = ["true", "1"].includes(String(req.query.conflictsOnly ?? "").toLowerCase());
    const createdStart = String(req.query.createdStart ?? "").trim();
    const createdEnd = String(req.query.createdEnd ?? "").trim();
    const rawDoctorName = String(req.query.doctorName ?? "").trim().toLowerCase();
    const rawProviderOrgId = String(req.query.providerOrganizationId ?? "").trim();
    const rawOpenOnly = String(req.query.openOnly ?? "").trim().toLowerCase();
    if (isWorklistRequest && ((createdStart && !createdEnd) || (!createdStart && createdEnd))) {
      throw new HttpError(400, "Both createdStart and createdEnd are required for a bounded created-date range.");
    }
    if (isWorklistRequest &&
      (createdStart && !/^\d{4}-\d{2}-\d{2}$/.test(createdStart)) ||
      (createdEnd && !/^\d{4}-\d{2}-\d{2}$/.test(createdEnd))
    ) {
      throw new HttpError(400, "Invalid created date.");
    }
    const requestedPage = Number.parseInt(String(req.query.page ?? "1"), 10) || 1;
    if (isWorklistRequest && (requestedPage < 1 || requestedPage > 200)) {
      throw new HttpError(400, "Page must be between 1 and 200.");
    }
    const page = Math.max(1, Math.min(requestedPage, 200));
    const pageSize = Math.max(1, Math.min(Number.parseInt(String(req.query.pageSize ?? "50"), 10) || 50, 100));
    // Candidate retrieval is bounded even for a high requested page. This is a
    // deliberate offset-pagination ceiling; clients needing deeper history must
    // refine criteria instead of turning the list into an unbounded export.
    const candidateLimit = Math.min(page * pageSize, 20_000);
    const sortKey = String(req.query.sortKey ?? "createdAt");
    const sortDir = String(req.query.sortDir ?? "desc").toLowerCase() === "asc" ? "asc" : "desc";

    // Tenant + not-deleted scoping shared by every canonical branch below, so
    // the always-open query can never widen the isolation boundary.
    const canonicalScope = and(
      or(
        inArray(cases.labOrganizationId, membershipOrgIds),
        inArray(cases.providerOrganizationId, membershipOrgIds)
      ),
      notDeleted(cases)
    );
    // The dedicated worklist must narrow canonical rows in SQL before any
    // projection/enrichment.  Legacy blobs are handled below after projection,
    // but their candidate query remains tenant-scoped and bounded by paging.
    const canonicalWorklistPredicates = isWorklistRequest
      ? [
          ...(rawBarcode ? [eq(cases.casePanBarcode, rawBarcode)] : []),
          ...(statuses.length ? [inArray(cases.status, statuses)] : []),
          ...(priorities.length ? [inArray(cases.priority, priorities)] : []),
          ...(importedCaseIds.length ? [inArray(cases.id, importedCaseIds)] : []),
          ...(createdStart ? [gte(cases.createdAt, new Date(`${createdStart}T00:00:00`))] : []),
          ...(createdEnd ? [lte(cases.createdAt, new Date(`${createdEnd}T23:59:59.999`))] : []),
          ...(categories.length
            ? [sql`exists (select 1 from case_restorations worklist_cr
                 where worklist_cr.case_id = ${cases.id}
                 and (${sql.raw(categories.map((category) => {
                   if (category === "implants") return "(lower(coalesce(worklist_cr.restoration_type, '')) like '%implant%' or lower(coalesce(worklist_cr.restoration_type, '')) like '%abutment%')";
                   if (category === "removable") return "lower(coalesce(worklist_cr.restoration_type, '')) ~ '(denture|partial|flipper|flexible|valplast|removable)'";
                   if (category === "zirconia") return "lower(coalesce(worklist_cr.material, '')) ~ '(zirconia|bruxzir|brux|zirc|pfz)'";
                   if (category === "crown_bridge") return "lower(coalesce(worklist_cr.restoration_type, '') || ' ' || coalesce(worklist_cr.material, '')) ~ '(crown|bridge|veneer|inlay|onlay|maryland|pontic|coping|pfm|lithium)'";
                   return "(coalesce(worklist_cr.restoration_type, '') <> '' or coalesce(worklist_cr.material, '') <> '')";
                 }).join(" or "))}) )`]
            : []),
          ...(conflictsOnly
            ? [sql`exists (select 1 from cases worklist_conflict
                 where worklist_conflict.lab_organization_id = ${cases.labOrganizationId}
                   and worklist_conflict.case_pan_barcode = ${cases.casePanBarcode}
                   and worklist_conflict.id <> ${cases.id}
                   and worklist_conflict.deleted_at is null
                   and lower(worklist_conflict.status) not in ('complete', 'delivered', 'cancelled'))`]
            : []),
        ]
      : [];
    // Counts are scalar DB queries, separate from bounded candidate retrieval.
    // They deliberately run before enrichment, which is reserved for rows that
    // actually reach the page response.
    const worklistCounts = isWorklistRequest
      ? await Promise.all([
          db.select({ total: count() }).from(cases).where(and(
            canonicalScope,
            ...canonicalWorklistPredicates,
            ...(rawSearch ? [or(
              ilike(cases.caseNumber, `%${rawSearch}%`),
              ilike(cases.patientFirstName, `%${rawSearch}%`),
              ilike(cases.patientLastName, `%${rawSearch}%`),
              ilike(cases.doctorName, `%${rawSearch}%`),
              ilike(cases.casePanBarcode, `%${rawSearch}%`),
            )] : []),
          )),
          db.select({ total: count() }).from(labCases).where(and(
            isNull(labCases.deletedAt),
            inArray(labCases.organizationId, membershipOrgIds),
            ...(rawSearch ? [ilike(labCases.caseData, `%${rawSearch}%`)] : []),
            ...(rawBarcode ? [ilike(labCases.caseData, `%"assignedBarcode":"${rawBarcode}"%`)] : []),
            ...(importedCaseIds.length ? [inArray(labCases.id, importedCaseIds)] : []),
          )),
        ])
      : null;

    const [recentRows, openRows, mobileRows] = await Promise.all([
      membershipOrgIds.length
        ? pagination.active
          ? db.query.cases.findMany({
              where: canonicalScope,
              orderBy: [desc(cases.createdAt)],
              columns: caseListColumns,
            })
          : rawSearch
          ? db.query.cases.findMany({
              where: and(
                canonicalScope,
                or(
                  ilike(cases.caseNumber, `%${rawSearch}%`),
                  ilike(cases.patientFirstName, `%${rawSearch}%`),
                  ilike(cases.patientLastName, `%${rawSearch}%`),
                  sql`lower(${cases.patientFirstName} || ' ' || ${cases.patientLastName}) like ${'%' + rawSearch + '%'}`,
                  ilike(cases.doctorName, `%${rawSearch}%`),
                  ilike(cases.casePanBarcode, `%${rawSearch}%`),
                )
              ),
              orderBy: [desc(cases.createdAt)],
              columns: caseListColumns,
            })
          : db.query.cases.findMany({
              where: canonicalScope,
              orderBy: [desc(cases.createdAt)],
              limit: RECENT_CASE_LIMIT,
              columns: caseListColumns,
            })
        : Promise.resolve([]),
      // Every OPEN case, however old. The most-recent window above silently
      // hid open cases for high-volume labs (a case due today could sit past
      // the 500th row by recency and never reach the dashboard). Completed /
      // delivered / cancelled cases stay bounded by the window above.
      membershipOrgIds.length && !rawSearch && !pagination.active
        ? db.query.cases.findMany({
            where: and(canonicalScope, openCaseStatusFilter),
            orderBy: [desc(cases.createdAt)],
            limit: OPEN_CASE_SAFETY_LIMIT,
            columns: caseListColumns,
          })
        : Promise.resolve([]),
      membershipOrgIds.length
        ? db
            .select(legacyCaseListColumns)
            .from(labCases)
            .where(
              and(
                isNull(labCases.deletedAt),
                inArray(labCases.organizationId, membershipOrgIds)
              )
            )
        : Promise.resolve([]),
    ]);

    const rows = mergeCaseRowsNewestFirst(recentRows as any[], openRows as any[]);

    const caseIds = rows.map((r: any) => r.id);
    const [restorations, invoiceRows] = await Promise.all([
      caseIds.length
        ? db.query.caseRestorations.findMany({
            where: inArray(caseRestorations.caseId, caseIds),
            columns: caseListRestorationColumns,
          })
        : Promise.resolve([]),
      // Batch-fetch invoice totals only for billing callers so the Price
      // column reflects manually-edited invoice line items rather than the
      // restoration-sum (which may lag after an invoice is edited in the editor).
      billingLabOrgIds.length && caseIds.length
        ? db
            .select({ caseId: invoices.caseId, total: invoices.total })
            .from(invoices)
            .where(and(
              inArray(invoices.caseId, caseIds),
              inArray(invoices.labOrganizationId, billingLabOrgIds),
              isNull(invoices.deletedAt),
              sql`${invoices.status} <> 'void'`,
            ))
            .orderBy(desc(invoices.createdAt))
        : Promise.resolve([]),
    ]);
    const byCase = new Map<string, typeof restorations>();
    for (const r of restorations) {
      const list = byCase.get(r.caseId) ?? [];
      list.push(r);
      byCase.set(r.caseId, list);
    }
    // Keep the newest non-void invoice per case, matching the worklist query.
    const invoiceTotalMap = new Map<string, string>();
    for (const inv of invoiceRows as { caseId: string | null; total: string | null }[]) {
      if (inv.caseId && inv.total != null && !invoiceTotalMap.has(inv.caseId)) {
        invoiceTotalMap.set(inv.caseId, inv.total);
      }
    }
    // Batch-fetch provider org account numbers so clients can display them
    // next to doctor names without an extra round-trip per case.
    const uniqueProvOrgIds = Array.from(
      new Set(rows.map((r: any) => r.providerOrganizationId).filter(Boolean))
    ) as string[];
    const provOrgAccountRows = uniqueProvOrgIds.length
      ? await db
          .select({ id: organizations.id, accountNumber: organizations.accountNumber })
          .from(organizations)
          .where(inArray(organizations.id, uniqueProvOrgIds))
      : [];
    const orgAccountMap = new Map(
      provOrgAccountRows.map((o) => [o.id, o.accountNumber ?? null])
    );

    const enriched: any[] = rows.map((row: any) => {
      const items = byCase.get(row.id) ?? [];
      // Exclude "missing" markers from display metadata — they are clinical
      // annotations, not billable restorations, and should not inflate counts
      // or pollute the type list shown in the case grid.
      const billableItems = items.filter((i: any) => !/^missing$/i.test(i.restorationType ?? ""));
      const teeth = billableItems.map((i: any) => i.toothNumber).join(", ");
      const types = Array.from(
        new Set(billableItems.map((i: any) => i.restorationType).filter(Boolean))
      ).join(", ");
      const materials = Array.from(
        new Set(billableItems.map((i: any) => i.material).filter(Boolean))
      ).join(", ");
      const restorationPrice = billableItems.reduce(
        (sum: number, i: any) =>
          sum + Number(i.quantity ?? 0) * Number(i.unitPrice ?? 0),
        0
      );
      // For lab billing callers: use the live invoice total so manually-edited
      // invoice lines are reflected immediately. Fall back to restoration-sum
      // if no invoice has been created yet.
      const invoiceTotal = invoiceTotalMap.get(row.id);
      const totalPrice =
        billingLabOrgSet.has(row.labOrganizationId) && invoiceTotal != null
          ? Number(invoiceTotal).toFixed(2)
          : restorationPrice.toFixed(2);
      return {
        ...row,
        // remakeNotes is lab-member-only — redact for provider/practice callers.
        remakeNotes: callerLabOrgSet.has(row.labOrganizationId) ? (row.remakeNotes ?? null) : null,
        caseNotes: (row as any).rxNotes ?? null,
        restorationCount: billableItems.length,
        restorationTypes: types || null,
        restorationMaterials: materials || null,
        // The encoded subtype of the first restoration — used by the desktop
        // case-list type filter to categorise the case via deriveCaseHierarchy.
        firstRestorationSubtype: billableItems[0]?.restorationSubtype ?? null,
        teeth: teeth || null,
        totalPrice,
        providerAccountNumber: orgAccountMap.get(row.providerOrganizationId) ?? null,
        ...(includeRestorations ? { restorations: items } : {}),
      };
    });

    // Bridge mobile cases into the desktop list so users see everything
    // regardless of which platform they used to create the case. Their
    // display values come from the projection the `lab_cases` trigger keeps
    // in step with `case_data`; only rows it has not reached yet have their
    // blob fetched and parsed here, so the common path never loads a blob.
    const desktopIdSet = new Set(rows.map((r: any) => r.id));
    const bridgeRows = (mobileRows as LegacyCaseListRow[])
      .filter((mr) => !desktopIdSet.has(mr.id))
      .map((mr) => ({ mr, resolved: resolveLegacyProjection(mr) }));
    const unprojectedBridgeIds = bridgeRows
      .filter((entry) => entry.resolved.status === "unprojected")
      .map((entry) => String(entry.mr.id));
    const bridgeBlobRows = unprojectedBridgeIds.length
      ? await db.select(legacyCaseBlobColumns).from(labCases).where(inArray(labCases.id, unprojectedBridgeIds))
      : [];
    const bridgeBlobById = new Map(
      (bridgeBlobRows as { id: string; caseData: string }[]).map((row) => [String(row.id), row.caseData]),
    );
    for (const { mr, resolved } of bridgeRows) {
      // Anything that is not a JSON object or array was skipped before
      // (`!parsed || typeof parsed !== "object"`) and still is.
      if (resolved.status === "json-null") continue;
      if (resolved.status === "ready") {
        if (!resolved.objectLike) continue;
        enriched.push(buildArrayLegacyRow(mr, resolved.parsed, { paginationActive: pagination.active }));
        continue;
      }
      try {
        const raw = bridgeBlobById.get(String(mr.id));
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== "object") continue;
        enriched.push(buildArrayLegacyRow(mr, parsed, { paginationActive: pagination.active }));
      } catch {
        // skip malformed rows
      }
    }

    // Batch-resolve station names for any case that has a labLocationId set.
    // Runs after the mobile row bridge so legacy rows with a stored labLocationId
    // are included in the lookup alongside canonical rows.
    const uniqueLocationIds = Array.from(
      new Set(
        enriched
          .map((r: any) => r.labLocationId)
          .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
      )
    );
    if (uniqueLocationIds.length > 0) {
      const locationNameRows = await db
        .select({
          id: labLocations.id,
          name: labLocations.name,
          labOrganizationId: labLocations.labOrganizationId,
        })
        .from(labLocations)
        .where(inArray(labLocations.id, uniqueLocationIds));
      const locationNameMap = new Map(
        locationNameRows.map((l) => [
          `${l.labOrganizationId}:${l.id}`,
          l.name,
        ]),
      );
      for (const row of enriched) {
        const savedLocationName = row.labLocationId
          ? locationNameMap.get(
              `${row.labOrganizationId}:${row.labLocationId}`,
            )
          : null;
        // Never expose a station ID from another lab. This also keeps malformed
        // historical blobs from making the list and detail disagree.
        row.labLocationId = savedLocationName ? row.labLocationId : null;
        row.labLocationName = savedLocationName ?? null;
      }
    }

    // Decorate rows with their active exception so list surfaces can show the
    // flag without a second call. Exception content (issue text, who flagged
    // it, when) is LAB-INTERNAL: a provider can be authorized to see a case
    // through its provider organization, so gate per row on direct active
    // membership in that row's own lab — the same rule `remakeNotes` uses
    // above and the canonical detail route uses below. Provider-visible rows
    // get an explicit `null` / `false` rather than an omitted field, so the
    // clients can't mistake redaction for "not loaded yet".
    {
      const labVisibleIds = enriched
        .filter((r: any) => callerLabOrgSet.has(r.labOrganizationId))
        .map((r: any) => String(r.id));
      const activeExceptions =
        labVisibleIds.length > 0
          ? await fetchActiveExceptionsForCaseIds(labVisibleIds)
          : new Map();
      for (const row of enriched) {
        const summary = callerLabOrgSet.has(row.labOrganizationId)
          ? (activeExceptions.get(String(row.id)) ?? null)
          : null;
        row.activeException = summary;
        row.hasActiveException = summary !== null;
      }
    }

    // Every filter is evaluated over the complete authorized canonical + legacy
    // set before the page slice. This is intentionally after legacy projection:
    // mobile blobs do not have SQL columns for all worklist predicates.
    const parseCalendarBound = (value: string, end: boolean) => {
      if (!value) return null;
      const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? new Date(`${value}T00:00:00`)
        : new Date(value);
      if (Number.isNaN(date.getTime())) throw new HttpError(400, "Invalid created date.");
      if (end && /^\d{4}-\d{2}-\d{2}$/.test(value)) date.setDate(date.getDate() + 1);
      return date;
    };
    const createdStartDate = isWorklistRequest ? parseCalendarBound(createdStart, false) : null;
    const createdEndDate = isWorklistRequest ? parseCalendarBound(createdEnd, true) : null;
    if (createdStartDate && createdEndDate && createdStartDate >= createdEndDate) {
      throw new HttpError(400, "Created end date must not be before the start date.");
    }
    const conflictCounts = new Map<string, number>();
    for (const c of enriched) {
      const barcode = String(c.casePanBarcode ?? "").trim();
      if (barcode && !CLOSED_CASE_STATUSES.includes(String(c.status ?? "").toLowerCase() as any)) {
        const key = `${c.labOrganizationId ?? ""}:${barcode}`;
        conflictCounts.set(key, (conflictCounts.get(key) ?? 0) + 1);
      }
    }
    const hasConflict = (c: any) => {
      const barcode = String(c.casePanBarcode ?? "").trim();
      return !!barcode && (conflictCounts.get(`${c.labOrganizationId ?? ""}:${barcode}`) ?? 0) > 1;
    };
    let filtered = enriched;
    if (rawSearch) {
      filtered = filtered.filter((c) => {
        const fn = String(c.patientFirstName ?? "").toLowerCase();
        const ln = String(c.patientLastName ?? "").toLowerCase();
        const dr = String(c.doctorName ?? "").toLowerCase();
        const cn = String(c.caseNumber ?? "").toLowerCase();
        const pb = String(c.casePanBarcode ?? "").toLowerCase();
        // Also match "First Last" as a combined string so full-name searches
        // like "John Smith" are consistent with the SQL predicate above.
        const fullName = `${fn} ${ln}`;
        return fn.includes(rawSearch) || ln.includes(rawSearch) || fullName.includes(rawSearch) || dr.includes(rawSearch) || cn.includes(rawSearch) || pb.includes(rawSearch);
      });
    }
    if (statuses.length) {
      filtered = filtered.filter((c) => statuses.includes(String(c.status ?? "").toLowerCase()));
    }
    if (rawBarcode) {
      filtered = filtered.filter((c) => String(c.casePanBarcode ?? "") === rawBarcode);
    }
    if (rawDoctorName) {
      filtered = filtered.filter((c) => String(c.doctorName ?? "").trim().toLowerCase() === rawDoctorName);
    }
    if (rawProviderOrgId) {
      filtered = filtered.filter((c) => String(c.providerOrganizationId ?? "") === rawProviderOrgId);
    }
    if (rawOpenOnly === "true" || rawOpenOnly === "1") {
      filtered = filtered.filter(
        (c) =>
          !CLOSED_CASE_STATUSES.includes(
            String(c.status ?? "").toLowerCase() as (typeof CLOSED_CASE_STATUSES)[number],
          ),
      );
    }
    if (isWorklistRequest && priorities.length) {
      filtered = filtered.filter((c) => priorities.includes(String(c.priority ?? "").toLowerCase()));
    }
    if (isWorklistRequest && importedCaseIds.length) {
      const wanted = new Set(importedCaseIds);
      filtered = filtered.filter((c) => wanted.has(String(c.id)));
    }
    if (isWorklistRequest && categories.length) {
      filtered = filtered.filter((c) => {
        const category = c._source === "mobile"
          ? classifyLegacyCase({
              caseType: c.restorationTypes,
              material: c.restorationMaterials,
              restorationSubtype: c.firstRestorationSubtype,
            })
          : classifyCase(byCase.get(c.id) ?? []);
        return categories.includes(category);
      });
    }
    if (isWorklistRequest && (createdStartDate || createdEndDate)) {
      filtered = filtered.filter((c) => {
        const date = new Date(c.createdAt);
        return !Number.isNaN(date.getTime()) &&
          (!createdStartDate || date >= createdStartDate) &&
          (!createdEndDate || date < createdEndDate);
      });
    }
    if (isWorklistRequest && conflictsOnly) filtered = filtered.filter(hasConflict);
    const compare = (a: any, b: any) => {
      let av: any;
      let bv: any;
      if (sortKey === "totalPrice") { av = Number(a.totalPrice ?? 0); bv = Number(b.totalPrice ?? 0); }
      else if (sortKey === "dueDate") { av = `${a.dueDate ?? "9999-99-99"} ${a.dueTime ?? ""}`; bv = `${b.dueDate ?? "9999-99-99"} ${b.dueTime ?? ""}`; }
      else { av = String(a[sortKey] ?? ""); bv = String(b[sortKey] ?? ""); }
      const primary = typeof av === "number" ? av - bv : String(av).localeCompare(String(b));
      if (primary) return sortDir === "asc" ? primary : -primary;
      return String(a.id).localeCompare(String(b.id));
    };
    if (isWorklistRequest) filtered.sort(compare);
    // `/cases` is a long-standing shared/mobile endpoint and deliberately
    // retains its array contract unless pagination is explicitly requested.
    // Pagination is applied only after filtering and all row enrichment.
    if (!pagination.active) return ok(res, filtered);
    const newestFirst = [...filtered].sort((a: any, b: any) => {
      const aTime = new Date(a.createdAt ?? 0).getTime();
      const bTime = new Date(b.createdAt ?? 0).getTime();
      const normalizedA = Number.isNaN(aTime) ? 0 : aTime;
      const normalizedB = Number.isNaN(bTime) ? 0 : bTime;
      if (normalizedB !== normalizedA) return normalizedB - normalizedA;
      return String(a.id).localeCompare(String(b.id));
    });
    return ok(res, pageRows(newestFirst, pagination));
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper: render a short human-readable summary from a caseEvent row.
// Used by GET /cases/recent so the dashboard can display "Moved to Scanning",
// "Status → Delivered", etc. without a separate lookup per card.
// ─────────────────────────────────────────────────────────────────────────────
function formatRecentEventSummary(
  eventType: string,
  meta: Record<string, unknown>,
): string {
  switch (eventType) {
    case "status_changed":
      return `Status → ${meta["to"] ?? "?"}`;
    case "location_changed":
      return `Moved to ${(meta["locationName"] ?? meta["to"] ?? "new location")}`;
    case "case_created":
      return "Case created";
    case "note_added":
      return "Note added";
    case "invoice_generated":
      return "Invoice generated";
    case "invoice_voided": {
      const num = meta["invoiceNumber"] ? ` ${meta["invoiceNumber"]}` : "";
      return `Invoice${num} voided`;
    }
    case "restoration_added":
      return "Restoration added";
    case "restoration_removed":
      return "Restoration removed";
    case "remade_by":
      return meta["remakeCaseNumber"]
        ? `Remade by case ${meta["remakeCaseNumber"]}`
        : "Remade";
    case "remake_of":
      return meta["originalCaseNumber"]
        ? `Remake of case ${meta["originalCaseNumber"]}`
        : "Remake";
    case "case_imported_from_itero":
      return "Imported from iTero";
    default:
      return eventType
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /cases/recent
//
// Returns up to 6 most recently active non-completed canonical cases for the
// caller's labs, sorted by updatedAt DESC. Each case is enriched with a
// latestEvent: { eventType, summary } | null derived from the case_events
// table (batch-fetched — one extra query for all 6 cases, not N+1).
//
// NOTE: declared before "/:caseId" so Express does not shadow the literal path.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/recent",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const labIds = await fetchUserActiveLabIds(callerId);
    if (labIds.length === 0) return ok(res, []);

    // Top 6 non-completed canonical cases, most recently updated first.
    const recentRows = await db
      .select()
      .from(cases)
      .where(
        and(
          inArray(cases.labOrganizationId, labIds),
          notDeleted(cases),
          sql`${cases.status} NOT IN ('delivered', 'cancelled', 'complete')`,
        ),
      )
      .orderBy(desc(cases.updatedAt), desc(cases.createdAt))
      .limit(6);

    if (recentRows.length === 0) return ok(res, []);

    // Batch-fetch all events for these 6 cases, ordered newest-first.
    // Reducing in JS (first occurrence per case = latest event) avoids a
    // DISTINCT ON subquery and keeps the Drizzle ORM call simple.
    const caseIds = recentRows.map((r: any) => r.id as string);
    const allEvents = await db
      .select({
        caseId: caseEvents.caseId,
        eventType: caseEvents.eventType,
        metadataJson: caseEvents.metadataJson,
        occurredAt: caseEvents.occurredAt,
      })
      .from(caseEvents)
      .where(inArray(caseEvents.caseId, caseIds))
      .orderBy(desc(caseEvents.occurredAt));

    const eventByCaseId = new Map<
      string,
      { eventType: string; metadataJson: Record<string, unknown> }
    >();
    for (const row of allEvents) {
      if (row.caseId && !eventByCaseId.has(row.caseId)) {
        eventByCaseId.set(row.caseId, {
          eventType: row.eventType,
          metadataJson: (row.metadataJson as Record<string, unknown>) ?? {},
        });
      }
    }

    const result = recentRows.map((c: any) => {
      const event = eventByCaseId.get(c.id) ?? null;
      const latestEvent = event
        ? {
            eventType: event.eventType,
            summary: formatRecentEventSummary(
              event.eventType,
              event.metadataJson,
            ),
          }
        : null;
      return { ...c, latestEvent };
    });

    return ok(res, result);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cases/provider
//
// Provider-portal foundation (Account epic Phase 5). A minimal, strictly
// provider-scoped case list: returns ONLY canonical cases whose
// providerOrganizationId belongs to the caller's own provider organization(s),
// expanded across cross-lab linked-doctor identities (Task #320).
//
// Isolation guarantees (enforced server-side, not just hidden in the UI):
//   * Never returns lab-only cases (cases where the caller is a lab member but
//     not the assigned provider) — only provider-assigned rows.
//   * Never returns another provider's cases — scoping is by the caller's
//     provider org id set, derived from their own memberships + links, and is
//     not influenced by any client-supplied org id.
//   * A non-provider (no provider org membership) gets an empty list.
//
// NOTE: declared before "/:caseId" so Express does not shadow the literal path.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/provider",
  requireLinkedProviderCapability("case_read"),
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const activeProviderOrganizations =
      await getActiveProviderOrganizations(callerId);
    if (activeProviderOrganizations.length === 0) return ok(res, []);
    const selectedProvider = await requireSelectedProviderOrganization(
      callerId,
      typeof req.header("x-provider-organization-id") === "string"
        ? req.header("x-provider-organization-id")
        : null,
    );

    // The provider org set is derived entirely from the caller's identity and
    // cannot be widened by request input. Empty set ⇒ empty list (a lab user
    // or an unaffiliated provider sees nothing here).
    const { providerOrgIds } =
      await getProviderOrgIdsForUserAndLinks(callerId);
    if (providerOrgIds.length === 0) return ok(res, []);

    const providerScope = and(
      eq(cases.providerOrganizationId, selectedProvider.id),
      notDeleted(cases)
    );

    // Same guarantee as the lab-scoped list: the bounded most-recent window
    // plus every open case, so an old open case is never invisible to the
    // practice it belongs to.
    const [providerRecentRows, providerOpenRows] = await Promise.all([
      db.query.cases.findMany({
        where: providerScope,
        orderBy: [desc(cases.createdAt)],
        limit: RECENT_CASE_LIMIT,
      }),
      db.query.cases.findMany({
        where: and(providerScope, openCaseStatusFilter),
        orderBy: [desc(cases.createdAt)],
        limit: OPEN_CASE_SAFETY_LIMIT,
      }),
    ]);
    const rows = mergeCaseRowsNewestFirst(
      providerRecentRows as any[],
      providerOpenRows as any[]
    );

    const caseIds = rows.map((r: any) => r.id);
    const [restorations, openInvoiceRows] = caseIds.length
      ? await Promise.all([
          db.query.caseRestorations.findMany({
            where: inArray(caseRestorations.caseId, caseIds),
          }),
          db
            .select({
              caseId: invoices.caseId,
              balanceDue: invoices.balanceDue,
            })
            .from(invoices)
            .where(
              and(
                inArray(invoices.caseId, caseIds),
                // Canonical open-invoice statuses — matches /invoices/open definition
                inArray(invoices.status, ["open", "partially_paid", "overdue"]),
                isNull(invoices.deletedAt),
              )
            ),
        ])
      : [[], [] as { caseId: string | null; balanceDue: string }[]];

    // Sum open invoice balance per case
    const openInvoiceAmountByCaseId = new Map<string, number>();
    for (const inv of openInvoiceRows) {
      if (!inv.caseId) continue;
      const current = openInvoiceAmountByCaseId.get(inv.caseId) ?? 0;
      openInvoiceAmountByCaseId.set(inv.caseId, current + parseFloat(inv.balanceDue ?? "0"));
    }

    const byCase = new Map<string, typeof restorations>();
    for (const r of restorations) {
      const list = byCase.get(r.caseId) ?? [];
      list.push(r);
      byCase.set(r.caseId, list);
    }

    // Fetch provider org data (account numbers, parent lab names) so the
    // portal can display the lab-specific account number per case and in the
    // header — without requiring an extra round-trip.
    const providerOrgRows = await db
      .select({
        id: organizations.id,
        accountNumber: organizations.accountNumber,
        parentLabOrganizationId: organizations.parentLabOrganizationId,
      })
      .from(organizations)
      .where(inArray(organizations.id, providerOrgIds));

    const parentLabIds = Array.from(
      new Set(
        providerOrgRows
          .map((o) => o.parentLabOrganizationId)
          .filter((id): id is string => !!id)
      )
    );
    const labOrgRows = parentLabIds.length
      ? await db
          .select({ id: organizations.id, name: organizations.name, displayName: organizations.displayName })
          .from(organizations)
          .where(inArray(organizations.id, parentLabIds))
      : [];
    const labById = new Map(labOrgRows.map((l) => [l.id, l]));
    const providerOrgById = new Map(providerOrgRows.map((o) => [o.id, o]));

    const enriched = rows.map((row: any) => {
      const items = byCase.get(row.id) ?? [];
      // "missing" markers are clinical annotations, not billable restorations.
      const billableItems = items.filter(
        (i: any) => !/^missing$/i.test(i.restorationType ?? "")
      );
      const teeth = billableItems.map((i: any) => i.toothNumber).join(", ");
      const types = Array.from(
        new Set(
          billableItems.map((i: any) => i.restorationType).filter(Boolean)
        )
      ).join(", ");
      const materials = Array.from(
        new Set(billableItems.map((i: any) => i.material).filter(Boolean))
      ).join(", ");
      const provOrg = providerOrgById.get(row.providerOrganizationId);
      const lab = provOrg?.parentLabOrganizationId
        ? labById.get(provOrg.parentLabOrganizationId)
        : null;
      return {
        ...row,
        // remakeNotes must never reach provider-portal viewers.
        remakeNotes: null,
        caseNotes: (row as any).rxNotes ?? null,
        restorationCount: billableItems.length,
        restorationTypes: types || null,
        restorationMaterials: materials || null,
        teeth: teeth || null,
        // Lab-specific account number for this case's provider org.
        // Used by the portal header (single lab) and per-row lab column
        // (multi-lab providers).
        providerAccountNumber: provOrg?.accountNumber ?? null,
        labName: lab ? (lab.displayName || lab.name) : null,
        openInvoiceAmount: openInvoiceAmountByCaseId.get(row.id) ?? 0,
      };
    });

    // Basic and Standard retain only the active provider workload. Premium
    // keeps the complete portal history.
    const canViewClosedCases = await assertProviderOrganizationCapability(
      selectedProvider.id,
      "provider_portal",
    ).then(() => true).catch(() => false);
    return ok(
      res,
      canViewClosedCases
        ? enriched
        : enriched.filter(
            (row) =>
              !CLOSED_CASE_STATUSES.includes(
                row.status as (typeof CLOSED_CASE_STATUSES)[number],
              ),
          ),
    );
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Case-return detection (provider timeline)
//
// A case "returns" to the lab when a completion-family status change is
// directly followed by an intake-family status change. These two families are
// the exact sets the lab-side case history uses for its "Case returned"
// divider (labtrax-desktop cases.tsx / labtrax app/case/[id].tsx), so the
// provider portal flags precisely the same moments the lab does.
// ─────────────────────────────────────────────────────────────────────────────
const PROVIDER_RETURN_COMPLETE_STATUSES = new Set(["complete", "delivered", "done"]);
const PROVIDER_RETURN_INTAKE_STATUSES = new Set(["received", "intake", "new", "pending"]);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cases/provider/:caseId
//
// Provider-portal single-case detail. Returns patient name,
// caseType / restorationTypes, and notes shared with the provider.
// Internal lab-only notes are always omitted. The caller must be linked
// to the case's providerOrganizationId via their own provider org membership.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/provider/:caseId",
  requireLinkedProviderCapability("case_read"),
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const caseId = req.params.caseId;

    const selectedProvider = await requireSelectedProviderOrganization(
      callerId, req.header("x-provider-organization-id"),
    );

    const found = await db.query.cases.findFirst({
      where: and(eq(cases.id, caseId), notDeleted(cases)),
    });
    if (!found) throw new HttpError(404, "Case not found.");

    // Verify the caller's provider orgs include this case's assigned provider
    if (
      !found.providerOrganizationId ||
      found.providerOrganizationId !== selectedProvider.id
    ) {
      throw new HttpError(403, "Access denied.");
    }
    if (
      CLOSED_CASE_STATUSES.includes(
        found.status as (typeof CLOSED_CASE_STATUSES)[number],
      ) &&
      !(await assertProviderOrganizationCapability(
        selectedProvider.id,
        "provider_portal",
      ).then(() => true).catch(() => false))
    ) {
      throw new HttpError(403, "Your provider plan only includes active cases.");
    }

    // Remake event types to surface on the provider timeline
    const PROVIDER_REMAKE_EVENT_TYPES = [
      "remake_of",
      "remade_by",
      "remake_created",
      "remake_updated",
      "case_sent_back",
    ];

    const [restorationRows, noteRows, locationRows, locationEventRows, remakeEventRows, sharedAttachmentRows, noteEventRows, statusEventRows, paymentEventRows, invoiceRow, providerOrgRow] =
      await Promise.all([
        db.query.caseRestorations.findMany({
          where: eq(caseRestorations.caseId, found.id),
        }),
        db.query.caseNotes.findMany({
          where: eq(caseNotes.caseId, found.id),
          orderBy: [desc(caseNotes.createdAt)],
        }),
        // Location history — oldest first, no user columns surfaced to provider
        db
          .select({
            id: caseLocations.id,
            locationCode: caseLocations.locationCode,
            locationName: caseLocations.locationName,
            movedAt: caseLocations.movedAt,
          })
          .from(caseLocations)
          .where(eq(caseLocations.caseId, found.id))
          .orderBy(asc(caseLocations.movedAt)),
        // Some older/imported flows recorded a physical move only as a
        // location_changed event. Newer location-change writes have both a
        // case_locations row and an event, so the builder below deduplicates
        // those paired records.
        db
          .select({
            id: caseEvents.id,
            occurredAt: caseEvents.occurredAt,
            metadataJson: caseEvents.metadataJson,
          })
          .from(caseEvents)
          .where(
            and(
              eq(caseEvents.caseId, found.id),
              eq(caseEvents.eventType, "location_changed"),
            ),
          )
          .orderBy(asc(caseEvents.occurredAt)),
        // Remake-related events — oldest first
        db
          .select({
            id: caseEvents.id,
            eventType: caseEvents.eventType,
            occurredAt: caseEvents.occurredAt,
            metadataJson: caseEvents.metadataJson,
          })
          .from(caseEvents)
          .where(
            and(
              eq(caseEvents.caseId, found.id),
              inArray(caseEvents.eventType, PROVIDER_REMAKE_EVENT_TYPES)
            )
          )
          .orderBy(asc(caseEvents.occurredAt)),
        // All shared_with_provider attachments (images + files), not deleted
        db.query.caseAttachments.findMany({
          where: and(
            eq(caseAttachments.caseId, found.id),
            eq(caseAttachments.visibility, "shared_with_provider"),
            isNull(caseAttachments.deletedAt)
          ),
          orderBy: [asc(caseAttachments.createdAt)],
        }),
        // note_added events — for shared notes in the provider timeline
        db
          .select({
            id: caseEvents.id,
            occurredAt: caseEvents.occurredAt,
            metadataJson: caseEvents.metadataJson,
            actorInitials: caseEvents.actorInitials,
          })
          .from(caseEvents)
          .where(
            and(
              eq(caseEvents.caseId, found.id),
              eq(caseEvents.eventType, "note_added")
            )
          )
          .orderBy(asc(caseEvents.occurredAt)),
        // status_changed events — lab workflow progress
        db
          .select({
            id: caseEvents.id,
            occurredAt: caseEvents.occurredAt,
            metadataJson: caseEvents.metadataJson,
          })
          .from(caseEvents)
          .where(
            and(
              eq(caseEvents.caseId, found.id),
              eq(caseEvents.eventType, "status_changed")
            )
          )
          .orderBy(asc(caseEvents.occurredAt)),
        // payment_received events — invoice payments
        db
          .select({
            id: caseEvents.id,
            occurredAt: caseEvents.occurredAt,
            metadataJson: caseEvents.metadataJson,
          })
          .from(caseEvents)
          .where(
            and(
              eq(caseEvents.caseId, found.id),
              eq(caseEvents.eventType, "payment_received")
            )
          )
          .orderBy(asc(caseEvents.occurredAt)),
        // Active invoice for this case: not deleted, not void, most recent first.
        // Multiple invoices can exist for a case (e.g. a replacement after voiding
        // the original); we take the most-recently-created one that is still active.
        db
          .select()
          .from(invoices)
          .where(
            and(
              eq(invoices.caseId, found.id),
              eq(invoices.providerOrganizationId, found.providerOrganizationId!),
              eq(invoices.labOrganizationId, found.labOrganizationId),
              ne(invoices.status, "void"),
              isNull(invoices.deletedAt)
            )
          )
          .orderBy(desc(invoices.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        // The caller's own practice — used as the "Practice" line on the
        // provider prescription view. Access is already gated above.
        db
          .select({
            id: organizations.id,
            name: organizations.name,
            displayName: organizations.displayName,
          })
          .from(organizations)
          .where(eq(organizations.id, found.providerOrganizationId))
          .limit(1)
          .then((rows) => rows[0] ?? null),
      ]);

    // Provider-facing "Lab Notes" must be both explicitly shared and authored
    // by this case's lab. Provider-authored portal messages use the same
    // visibility value, but must not be relabeled as lab-authored notes.
    const providerVisibleNotes = noteRows.filter(
      (note: any) =>
        note.visibility === "shared_with_provider" &&
        note.authorOrganizationId === found.labOrganizationId,
    );
    // Do not pass author ids, organization ids, or any other staff identity
    // fields through the provider response. The note body and timestamp are
    // the only provider-visible note fields needed by this view.
    const providerSafeNotes = providerVisibleNotes.map((note: any) => ({
      id: note.id,
      noteText: note.noteText,
      visibility: "shared_with_provider",
      createdAt: note.createdAt,
    }));

    const billableItems = restorationRows.filter(
      (i: any) => !/^missing$/i.test(i.restorationType ?? "")
    );
    const restorationTypes = Array.from(
      new Set(billableItems.map((i: any) => i.restorationType).filter(Boolean))
    ).join(", ");

    // Provider-safe prescription rows. Only the clinical fields a practice
    // prescribed are surfaced — pricing columns (unitPrice / priceSource /
    // priceKey…) and lab-internal restoration notes are deliberately dropped.
    const providerRestorations = billableItems.map((i: any) => ({
      id: i.id,
      toothNumber: i.toothNumber ?? null,
      restorationType: i.restorationType ?? null,
      restorationSubtype: i.restorationSubtype ?? null,
      ...implantValues(i),
      material: i.material ?? null,
      shade: i.shade ?? null,
    }));

    // Build the timeline (locations + remake events + shared photos), sorted oldest → newest
    function remakeEventLabel(eventType: string, meta: any): string {
      switch (eventType) {
        case "remake_of":
          return meta?.remakeCaseNumber
            ? `Remake of case ${meta.remakeCaseNumber}`
            : "Remake created";
        case "remade_by":
          return meta?.remakeCaseNumber
            ? `Remade by case ${meta.remakeCaseNumber}`
            : "Remade";
        case "remake_created":
          return "Remake initiated";
        case "remake_updated":
          return "Remake updated";
        case "case_sent_back":
          return "Case sent back";
        default:
          return String(eventType).replace(/_/g, " ");
      }
    }

    const timelineEntries: Array<{
      type: "location" | "remake" | "photo" | "note" | "file" | "status" | "payment";
      id: string;
      label: string;
      timestamp: string;
      attachmentId?: string;
      fileName?: string;
      fileType?: string;
      author?: string | null;
      // Status entries only — the status the case moved away from, and
      // whether that move means the case came back into the lab. Both are
      // additive: clients that don't know about them keep working.
      fromStatus?: string | null;
      isCaseReturn?: boolean;
    }> = [];

    const pairedLocationEventIds = new Set<string>();
    const pairedLocationRowIds = new Set<string>();
    const locationRowsById = new Map(
      locationRows.map((location: any) => [String(location.id), location]),
    );

    // New events carry the authoritative location-row id.
    for (const event of locationEventRows) {
      const locationId = String((event.metadataJson as any)?.locationId ?? "");
      if (locationId && locationRowsById.has(locationId)) {
        pairedLocationEventIds.add(event.id);
        pairedLocationRowIds.add(locationId);
      }
    }

    const legacyEventMatchesLocation = (event: any, location: any): boolean => {
      const meta = (event.metadataJson ?? {}) as Record<string, unknown>;
      if (meta.locationId) return false;
      const eventName = String(meta.locationName ?? meta.to ?? "").trim();
      const eventCode = String(meta.locationCode ?? "").trim();
      const sameLocation =
        (Boolean(eventCode) &&
          eventCode === String(location.locationCode ?? "").trim()) ||
        (Boolean(eventName) &&
          eventName === String(location.locationName ?? "").trim());
      const eventTime = new Date(event.occurredAt as Date).getTime();
      const locationTime = new Date(location.movedAt as Date).getTime();
      return sameLocation && Math.abs(eventTime - locationTime) <= 60_000;
    };

    // Legacy events have no row id. Only collapse an unambiguous one-to-one
    // pair; preserving an extra event is safer than deleting real history.
    for (const location of locationRows) {
      if (pairedLocationRowIds.has(String(location.id))) continue;
      const candidateEvents = locationEventRows.filter(
        (event: any) =>
          !pairedLocationEventIds.has(event.id) &&
          legacyEventMatchesLocation(event, location),
      );
      if (candidateEvents.length !== 1) continue;
      const [candidate] = candidateEvents;
      const candidateRows = locationRows.filter(
        (row: any) =>
          !pairedLocationRowIds.has(String(row.id)) &&
          legacyEventMatchesLocation(candidate, row),
      );
      if (candidateRows.length === 1) {
        pairedLocationEventIds.add(candidate.id);
        pairedLocationRowIds.add(String(location.id));
      }
    }

    for (const loc of locationRows) {
      timelineEntries.push({
        type: "location",
        id: loc.id,
        label: loc.locationName,
        timestamp: (loc.movedAt as Date).toISOString(),
      });
    }

    // Preserve location_changed history that has no case_locations row.
    for (const event of locationEventRows) {
      if (pairedLocationEventIds.has(event.id)) continue;
      const meta = (event.metadataJson ?? {}) as Record<string, unknown>;
      const locationName = String(
        meta.locationName ?? meta.to ?? "Location changed",
      ).trim();
      timelineEntries.push({
        type: "location",
        id: event.id,
        label: locationName || "Location changed",
        timestamp: (event.occurredAt as Date).toISOString(),
      });
    }

    for (const ev of remakeEventRows) {
      timelineEntries.push({
        type: "remake",
        id: ev.id,
        label: remakeEventLabel(ev.eventType, ev.metadataJson as any),
        timestamp: (ev.occurredAt as Date).toISOString(),
      });
    }

    for (const att of sharedAttachmentRows) {
      if (String(att.fileType ?? "").startsWith("image/")) {
        // Image attachments — rendered as inline photo thumbnails
        timelineEntries.push({
          type: "photo",
          id: att.id,
          label: att.fileName,
          timestamp: (att.createdAt as Date).toISOString(),
          attachmentId: att.id,
          fileName: att.fileName,
          fileType: att.fileType,
        });
      } else {
        // Non-image file attachments (PDFs, docs, etc.)
        timelineEntries.push({
          type: "file",
          id: att.id,
          label: att.fileName,
          timestamp: (att.createdAt as Date).toISOString(),
          attachmentId: att.id,
          fileName: att.fileName,
          fileType: att.fileType,
        });
      }
    }

    // note_added events — only include shared_with_provider ones.
    // Deny by default: notes whose visibility field is absent, null, or any
    // value other than "shared_with_provider" (e.g. "internal_lab_only" or a
    // future type) are silently skipped. This ensures historical/imported events
    // with missing metadata never inadvertently leak internal text to providers.
    //
    // The event's metadataJson is written once, at note-create time, and is
    // never updated afterward. The backing live row is therefore required and
    // authoritative; an event without one cannot prove that the note has not
    // since been deleted or redacted.
    const liveNoteById = new Map(noteRows.map((n: any) => [n.id, n]));
    const includedTimelineNoteIds = new Set<string>();
    for (const ev of noteEventRows) {
      const meta = (ev.metadataJson ?? {}) as Record<string, unknown>;
      const noteId = typeof meta.noteId === "string" ? meta.noteId : null;
      if (!noteId) continue;
      const liveNote = liveNoteById.get(noteId);
      // Deleted note, or its visibility no longer shared: withhold the
      // text regardless of what the event metadata still says.
      if (
        !liveNote ||
        liveNote.visibility !== "shared_with_provider" ||
        liveNote.authorOrganizationId !== found.labOrganizationId
      ) {
        continue;
      }
      const noteText = String(liveNote.noteText ?? "").trim();
      if (!noteText) continue;
      timelineEntries.push({
        type: "note",
        id: ev.id,
        label: noteText,
        timestamp: (ev.occurredAt as Date).toISOString(),
      });
      includedTimelineNoteIds.add(noteId);
    }

    // A note can be created by an older path without a corresponding
    // note_added event. Include the live shared row so the provider still sees
    // the current lab-shared note exactly once.
    for (const note of providerSafeNotes) {
      if (includedTimelineNoteIds.has(note.id) || !note.createdAt) continue;
      const noteTime = new Date(note.createdAt as Date).toISOString();
      timelineEntries.push({
        type: "note",
        id: note.id,
        label: note.noteText,
        timestamp: noteTime,
      });
    }

    // status_changed events — lab workflow progress.
    //
    // statusEventRows is already ordered oldest → newest, so the previous
    // row's destination status is the status this entry moved away from.
    // That chronological pairing is exactly how the lab-side case history
    // decides a case "returned", so both surfaces flag the same entries.
    const statusChrono = statusEventRows.map((ev) => {
      const meta = (ev.metadataJson ?? {}) as Record<string, unknown>;
      return {
        ev,
        meta,
        toStatus: String(meta.toStatus ?? "").trim(),
      };
    });
    for (let i = 0; i < statusChrono.length; i++) {
      const { ev, meta, toStatus } = statusChrono[i]!;
      const prevToStatus = i > 0 ? statusChrono[i - 1]!.toStatus : "";
      const metaFromStatus = String(meta.fromStatus ?? "").trim();
      const fromStatus = metaFromStatus || prevToStatus || null;
      const isCaseReturn =
        !!prevToStatus &&
        !!toStatus &&
        PROVIDER_RETURN_COMPLETE_STATUSES.has(prevToStatus.toLowerCase()) &&
        PROVIDER_RETURN_INTAKE_STATUSES.has(toStatus.toLowerCase());
      timelineEntries.push({
        type: "status",
        id: ev.id,
        label: toStatus || "Status changed",
        timestamp: (ev.occurredAt as Date).toISOString(),
        fromStatus,
        isCaseReturn,
      });
    }

    // payment_received events
    for (const ev of paymentEventRows) {
      const meta = (ev.metadataJson ?? {}) as Record<string, unknown>;
      const rawAmount = Number(meta.amount);
      const formattedAmount = !isNaN(rawAmount)
        ? new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
            minimumFractionDigits: 2,
          }).format(rawAmount)
        : null;
      timelineEntries.push({
        type: "payment",
        id: ev.id,
        label: formattedAmount ?? "Payment received",
        timestamp: (ev.occurredAt as Date).toISOString(),
      });
    }

    timelineEntries.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Build invoice lines
    let invoiceLines: Array<{
      description: string;
      quantity: number;
      unitPrice: string;
      totalPrice: string;
    }> = [];
    let invoiceTotal: string | null = null;
    let invoiceStatus: string | null = null;

    if (invoiceRow) {
      invoiceTotal = invoiceRow.total ?? null;
      invoiceStatus = invoiceRow.status ?? null;
      const lineRows = await db
        .select({
          description: invoiceLineItems.description,
          quantity: invoiceLineItems.quantity,
          unitPrice: invoiceLineItems.unitPrice,
          lineTotal: invoiceLineItems.lineTotal,
        })
        .from(invoiceLineItems)
        .where(
          and(
            eq(invoiceLineItems.invoiceId, invoiceRow.id),
            isNull(invoiceLineItems.parentLineItemId)
          )
        )
        .orderBy(asc(invoiceLineItems.sortOrder));

      invoiceLines = lineRows.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice ?? "0.00",
        totalPrice: l.lineTotal ?? "0.00",
      }));
    }

    return ok(res, {
      id: found.id,
      caseNumber: (found as any).caseNumber,
      patientFirstName: (found as any).patientFirstName,
      patientLastName: (found as any).patientLastName,
      caseType: (found as any).caseType,
      status: found.status,
       // Current removable workflow step. This is a clinical workflow value,
       // not pricing metadata; clients map the stable key to a readable label.
       step: (found as any).step ?? null,
      dueDate: (found as any).dueDate,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt,
      labOrganizationId: found.labOrganizationId,
      providerOrganizationId: found.providerOrganizationId,
      viewerCanPostNotes: true,
      viewerQuickReferenceOrganizationId: found.providerOrganizationId,
      // Prescription header fields for the provider Rx view.
      doctorName: (found as any).doctorName ?? null,
      practiceName: providerOrgRow
        ? providerOrgRow.displayName || providerOrgRow.name || null
        : null,
      // Prescription notes remain a separate clinical field. They must never
      // be relabeled or duplicated as lab-authored shared notes.
      rxNotes: (found as any).rxNotes ?? null,
      restorationTypes: restorationTypes || null,
      restorations: providerRestorations,
      notes: providerSafeNotes,
      // remakeNotes are always redacted from provider-portal viewers
      remakeNotes: null,
      timeline: timelineEntries,
      invoiceId: invoiceRow?.id ?? null,
      invoiceNumber: invoiceRow?.invoiceNumber ?? null,
      invoiceLines,
      invoiceNotes:
        invoiceRow && invoiceSharesNotesWithProvider(invoiceRow.displayMetadataJson)
          ? invoiceRow.notes ?? null
          : null,
      invoiceTotal,
      invoiceBalanceDue: invoiceRow?.balanceDue ?? null,
      invoiceStatus,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Notification helpers — fire-and-forget, never throw into the response path.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notify every active lab member about provider activity (note or attachment)
 * on a case, and send one email to the lab's billing address.
 *
 * @param caseRow   - the canonical cases row (must have id, caseNumber, labOrganizationId,
 *                    patientFirstName, patientLastName)
 * @param type      - notification type: "provider_note_added" | "provider_attachment_added"
 * @param providerOrgName - display name of the provider practice
 */
async function notifyLabMembersOfProviderActivity(
  caseRow: {
    id: string;
    caseNumber: string;
    labOrganizationId: string;
    patientFirstName: string | null;
    patientLastName: string | null;
  },
  type: "provider_note_added" | "provider_attachment_added",
  providerOrgName: string
): Promise<void> {
  try {
    const patientName =
      [caseRow.patientFirstName, caseRow.patientLastName].filter(Boolean).join(" ") ||
      "Unknown";
    const isAttachment = type === "provider_attachment_added";
    const title = isAttachment
      ? `New file from ${providerOrgName} on Case #${caseRow.caseNumber}`
      : `New note from ${providerOrgName} on Case #${caseRow.caseNumber}`;
    const body = isAttachment
      ? `${providerOrgName} attached a file to ${patientName}'s case.`
      : `${providerOrgName} added a note to ${patientName}'s case.`;

    await deliverInAppNotification({
      labOrganizationId: caseRow.labOrganizationId,
      category: "doctor_practice_message",
      type,
      title,
      body,
      dataJson: { caseId: caseRow.id, caseNumber: caseRow.caseNumber },
    });

    // Email the lab's billing address (gated on providerNoteNotifications preference)
    const labOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, caseRow.labOrganizationId),
    });
    const labBillingEmail = (labOrg as any)?.billingEmail as string | null | undefined;
    if (labBillingEmail) {
      const { checkEmailPref } = await import("../lib/email-prefs.js");
      const allowed = await checkEmailPref(labBillingEmail, "providerNoteNotifications");
      if (!allowed) return;
      const { sendMail } = await import("../lib/mail.js");
      const subject = isAttachment
        ? `LabTrax: New file from ${providerOrgName} on Case #${caseRow.caseNumber}`
        : `LabTrax: New note from ${providerOrgName} on Case #${caseRow.caseNumber}`;
      const action = isAttachment
        ? `attached a file to`
        : `added a note to`;
      await sendMail({
        to: labBillingEmail,
        subject,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
  <div style="background:#4A6CF7;color:white;padding:20px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;">LabTrax</h2>
    <p style="margin:4px 0 0;opacity:.85;">Provider activity on a case</p>
  </div>
  <div style="padding:20px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;">
    <p><strong>${providerOrgName}</strong> ${action} case <strong>#${caseRow.caseNumber}</strong> (patient: ${patientName}).</p>
    <p style="color:#888;font-size:13px;">Log in to LabTrax to view the full case details.</p>
  </div>
</div>`,
        text: `LabTrax: ${providerOrgName} ${action} case #${caseRow.caseNumber} (${patientName}).`,
      });
    }
  } catch {
    // Best-effort — never surface into the response.
  }
}

/**
 * Notify every active member of the provider organization about lab activity
 * (shared note or shared attachment) on a case, and send one email to the
 * provider's billing address (respecting the caseNoteNotifications preference).
 *
 * @param caseRow        - the canonical cases row
 * @param type           - "shared_note_added" | "shared_attachment_added"
 * @param labOrgName     - display name of the laboratory
 */
async function notifyProviderMembersOfLabActivity(
  caseRow: {
    id: string;
    caseNumber: string;
    labOrganizationId: string;
    providerOrganizationId: string;
    patientFirstName: string | null;
    patientLastName: string | null;
  },
  type: "shared_note_added" | "shared_attachment_added",
  labOrgName: string
): Promise<void> {
  try {
    const providerMembers = await db
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.labId, caseRow.providerOrganizationId),
          eq(organizationMemberships.status, "active")
        )
      );

    const patientName =
      [caseRow.patientFirstName, caseRow.patientLastName].filter(Boolean).join(" ") ||
      "Unknown";
    const isAttachment = type === "shared_attachment_added";
    const title = isAttachment
      ? `New file on Case #${caseRow.caseNumber}`
      : `New note on Case #${caseRow.caseNumber}`;
    const body = isAttachment
      ? `${labOrgName} shared a file on ${patientName}'s case.`
      : `${labOrgName} shared a note on ${patientName}'s case.`;

    if (providerMembers.length > 0) {
      const { filterUserIdsByInAppPref } = await import("../lib/in-app-prefs.js");
      const recipientIds = await filterUserIdsByInAppPref(
        providerMembers.map((m) => m.userId),
        "caseNoteNotifications"
      );
      if (recipientIds.length > 0) {
        await db.insert(notifications).values(
          recipientIds.map((userId) => ({
            userId,
            type,
            title,
            body,
            dataJson: { caseId: caseRow.id },
          }))
        );
      }
    }

    // Email the provider's billing address (respects caseNoteNotifications pref)
    const providerOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, caseRow.providerOrganizationId),
    });
    const providerBillingEmail = (providerOrg as any)?.billingEmail as string | null | undefined;
    if (providerBillingEmail) {
      const { checkEmailPref } = await import("../lib/email-prefs.js");
      const allowed = await checkEmailPref(providerBillingEmail, "caseNoteNotifications");
      if (allowed) {
        const { sendMail } = await import("../lib/mail.js");
        const subject = isAttachment
          ? `LabTrax: New file on case #${caseRow.caseNumber}`
          : `LabTrax: New note on case #${caseRow.caseNumber}`;
        const action = isAttachment ? `shared a file on` : `added a note to`;
        await sendMail({
          to: providerBillingEmail,
          subject,
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
  <div style="background:#4A6CF7;color:white;padding:20px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;">LabTrax</h2>
    <p style="margin:4px 0 0;opacity:.85;">Case update from your lab</p>
  </div>
  <div style="padding:20px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;">
    <p>Your laboratory <strong>${labOrgName}</strong> ${action} case <strong>#${caseRow.caseNumber}</strong> (patient: ${patientName}).</p>
    <p style="color:#888;font-size:13px;">Log in to LabTrax to view the full case details.</p>
  </div>
</div>`,
          text: `LabTrax: ${labOrgName} ${action} case #${caseRow.caseNumber} (${patientName}).`,
        });
      }
    }
  } catch {
    // Best-effort — never surface into the response.
  }
}

// POST /cases/provider/:caseId/notes
//
// Provider-portal note creation. Forces visibility to "shared_with_provider"
// so providers can only post notes visible to the lab (never internal ones).
// The caller must be linked to the case's providerOrganizationId.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/provider/:caseId/notes",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const caseId = req.params.caseId;

    const selectedProvider = await requireSelectedProviderOrganization(
      callerId, req.header("x-provider-organization-id"),
    );
    await assertProviderOrganizationCapability(
      selectedProvider.id,
      "provider_portal",
    );

    const found = await db.query.cases.findFirst({
      where: and(eq(cases.id, caseId), notDeleted(cases)),
    });
    if (!found) throw new HttpError(404, "Case not found.");

    if (
      !found.providerOrganizationId ||
      found.providerOrganizationId !== selectedProvider.id
    ) {
      throw new HttpError(403, "Access denied.");
    }

    const input = z
      .object({ noteText: z.string().min(1).max(5000) })
      .parse(req.body);
    const [note] = await db
      .insert(caseNotes)
      .values({
        caseId: found.id,
        authorUserId: callerId,
        authorOrganizationId: found.providerOrganizationId,
        noteText: input.noteText,
        // Provider notes are always visible to the lab (shared_with_provider)
        visibility: "shared_with_provider",
      })
      .returning()
      .catch((err: unknown): never =>
        wrapDbError(err, { fallback: "Failed to save note." })
      );

    await db
      .insert(caseEvents)
      .values({
        caseId: found.id,
        eventType: "note_added",
        actorUserId: callerId,
        actorOrganizationId: found.providerOrganizationId,
        actorInitials: (req as any).user?.initials || "PRV",
        metadataJson: {
          visibility: "shared_with_provider",
          noteId: note.id,
          noteText: input.noteText,
        },
      })
      .catch(() => {
        /* non-fatal */
      });

    await touchCase(found.id);

    // Auto-notify all active lab members that the provider added a note.
    // Fire-and-forget — failure must not affect the 201 response.
    const providerOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, found.providerOrganizationId),
    }).catch(() => null);
    void notifyLabMembersOfProviderActivity(
      found,
      "provider_note_added",
      (providerOrg as any)?.name ?? "Provider"
    );

    return ok(res, note, 201);
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /cases/provider/:caseId/attachments
//
// Provider-portal file attachment endpoint. Accepts a multipart/form-data
// upload with a single file field named "file". The attachment is written
// to the case-media directory, mirrored to object storage, and recorded
// with visibility = "shared_with_provider". The caller must be linked to
// the case's providerOrganizationId.
// ─────────────────────────────────────────────────────────────────────────────
const providerAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 /* 20 MB */ },
});

/**
 * Pre-auth gate: validates provider ↔ case authorization BEFORE Multer
 * buffers any bytes into memory. Without this gate an authenticated-but-
 * unauthorised caller could repeatedly force 20 MB allocations per request.
 * The verified case row is stashed on `req._verifiedProviderCase` so the main
 * handler can reuse it without a second DB round-trip.
 */
async function providerAttachmentAuthGate(
  req: any,
  res: any,
  next: any
): Promise<void> {
  try {
    const callerId = req.auth?.userId as string | undefined;
    if (!callerId) {
      res.status(401).json({ ok: false, error: "Unauthorized." });
      return;
    }
    const caseId = req.params.caseId as string;
    const selectedProvider = await requireSelectedProviderOrganization(
      callerId, req.header("x-provider-organization-id"),
    );
    await assertProviderOrganizationCapability(
      selectedProvider.id,
      "provider_portal",
    );
    const found = await db.query.cases.findFirst({
      where: and(eq(cases.id, caseId), notDeleted(cases)),
    });
    if (!found) {
      res.status(404).json({ ok: false, error: "Case not found." });
      return;
    }
    if (
      !found.providerOrganizationId ||
      found.providerOrganizationId !== selectedProvider.id
    ) {
      res.status(403).json({ ok: false, error: "Access denied." });
      return;
    }
    // Stash for the main handler to avoid a duplicate DB fetch
    req._verifiedProviderCase = found;
    next();
  } catch (err: unknown) {
    next(err);
  }
}

router.post(
  "/provider/:caseId/attachments",
  // Auth gate runs BEFORE Multer: unauthorized callers are rejected before any
  // bytes are buffered into memory.
  providerAttachmentAuthGate,
  providerAttachmentUpload.single("file"),
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const caseId = req.params.caseId;

    // Reuse the pre-verified case from the gate; fall back to a DB fetch only
    // if somehow the gate did not attach it (e.g. test environments).
    const found =
      (req as any)._verifiedProviderCase ??
      (await db.query.cases.findFirst({
        where: and(eq(cases.id, caseId), notDeleted(cases)),
      }));
    if (!found) throw new HttpError(404, "Case not found.");

    const file = req.file;
    if (!file) throw new HttpError(400, "No file uploaded.");

    // Server-side MIME allowlist. The client-supplied mimetype is NEVER
    // trusted as a serving content-type — this list defines the only types
    // we accept. Anything that can execute as script (text/html, image/svg+xml,
    // application/javascript, …) is rejected here regardless of the extension
    // or Accept header the browser sent.
    const ALLOWED_PROVIDER_MIMES: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/heic": ".heic",
      "image/heif": ".heif",
      "application/pdf": ".pdf",
      "application/msword": ".doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      "application/vnd.ms-excel": ".xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
      "text/plain": ".txt",
      "text/csv": ".csv",
    };
    // Normalise: strip parameters (e.g. "image/jpeg; name=x") and lowercase
    const declaredMime = (file.mimetype ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (!ALLOWED_PROVIDER_MIMES[declaredMime]) {
      throw new HttpError(
        415,
        `File type "${declaredMime}" is not allowed. Please upload an image, PDF, or common document format.`
      );
    }
    // Use the allowlisted MIME (not the raw client value) for both storage and
    // the DB record so the serve path always uses a known-safe content type.
    const safeMime = declaredMime;

    // Generate a safe storage filename: canonical extension from allowlist
    const safeExt = ALLOWED_PROVIDER_MIMES[safeMime]!;
    const storageFilename = `prv-${randomBytes(16).toString("hex")}${safeExt}`;
    const diskPath = path.resolve(caseMediaDir, storageFilename);

    // Write to disk
    await writeProductionUpload(diskPath, file.buffer, "case-upload");

    // Mirror to object storage (best-effort)
    writeCaseMediaToObjectStorage(storageFilename, file.buffer, safeMime).catch(
      (err: unknown) => {
        req.log?.warn({ err }, "Provider attachment: failed to mirror to object storage");
      }
    );

    const [attachment] = await db
      .insert(caseAttachments)
      .values({
        caseId: found.id,
        uploadedByUserId: callerId,
        uploadedByOrganizationId: found.providerOrganizationId,
        fileName: file.originalname || storageFilename,
        storageKey: storageFilename,
        fileType: safeMime,
        visibility: "shared_with_provider",
      })
      .returning()
      .catch((err: unknown): never =>
        wrapDbError(err, { fallback: "Failed to save attachment." })
      );

    await db
      .insert(caseEvents)
      .values({
        caseId: found.id,
        eventType: "case_attachment_added",
        actorUserId: callerId,
        actorOrganizationId: found.providerOrganizationId,
        actorInitials: (req as any).user?.initials || "PRV",
        metadataJson: {
          attachmentId: attachment.id,
          fileName: attachment.fileName,
          fileType: attachment.fileType,
          visibility: "shared_with_provider",
        },
      })
      .catch(() => {
        /* non-fatal */
      });

    await touchCase(found.id);

    // Auto-notify all active lab members that the provider attached a file.
    // Fire-and-forget — failure must not affect the 201 response.
    const providerAttachOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, found.providerOrganizationId!),
    }).catch(() => null);
    void notifyLabMembersOfProviderActivity(
      found,
      "provider_attachment_added",
      (providerAttachOrg as any)?.name ?? "Provider"
    );

    return ok(res, attachment, 201);
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cases/quick-search
//
// Lightweight case search for the desktop file-drop zone case picker.
// Returns at most 20 cases matching the query (case number prefix, patient
// first/last name prefix) for a given lab. Searches both canonical cases
// and legacy mobile cases (lab_cases). Requires lab membership.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/quick-search",
  asyncHandler(async (req, res) => {
    const labOrganizationId = String(req.query.labOrganizationId ?? "").trim();
    const q = String(req.query.q ?? "").trim();
    if (!labOrganizationId) throw new HttpError(400, "labOrganizationId is required.");
    await requireMembership((req as any).auth.userId, labOrganizationId);

    if (q.length < 2) return ok(res, { cases: [] });

    const ql = q.toLowerCase();

    const [canonicalResults, mobileRows] = await Promise.all([
      db
        .select({
          id: cases.id,
          caseNumber: cases.caseNumber,
          patientFirstName: cases.patientFirstName,
          patientLastName: cases.patientLastName,
          doctorName: cases.doctorName,
          status: cases.status,
        })
        .from(cases)
        .where(
          and(
            eq(cases.labOrganizationId, labOrganizationId),
            notDeleted(cases),
            or(
              sql`lower(${cases.caseNumber}) like ${`${ql}%`}`,
              sql`lower(${cases.patientLastName}) like ${`${ql}%`}`,
              sql`lower(${cases.patientFirstName}) like ${`${ql}%`}`,
              sql`lower(${cases.doctorName}) like ${'%' + ql + '%'}`,
            ),
          ),
        )
        .orderBy(desc(cases.createdAt))
        .limit(20),
      db
        .select({ id: labCases.id, caseData: labCases.caseData })
        .from(labCases)
        .where(
          and(
            eq(labCases.organizationId, labOrganizationId),
            isNull(labCases.deletedAt),
          ),
        )
        .orderBy(desc(labCases.updatedAt))
        .limit(200),
    ]);

    const canonicalIds = new Set(canonicalResults.map((r) => r.id));
    const mobileMerged: Array<{
      id: string;
      caseNumber: string;
      patientFirstName: string;
      patientLastName: string;
      doctorName: string;
      status: string;
    }> = [];

    for (const mr of mobileRows) {
      if (canonicalIds.has(mr.id)) continue;
      if (canonicalResults.length + mobileMerged.length >= 20) break;
      try {
        const parsed =
          typeof mr.caseData === "string" ? JSON.parse(mr.caseData) : mr.caseData;
        if (!parsed || typeof parsed !== "object") continue;
        const cn = String(parsed.caseNumber ?? "").toLowerCase();
        const patientName = String(parsed.patientName ?? "");
        const spaceIdx = patientName.indexOf(" ");
        const fn = (spaceIdx >= 0 ? patientName.slice(0, spaceIdx) : patientName).toLowerCase();
        const ln = (spaceIdx >= 0 ? patientName.slice(spaceIdx + 1) : "").toLowerCase();
        const dn = String(parsed.doctorName ?? "").toLowerCase();
        if (!cn.startsWith(ql) && !fn.startsWith(ql) && !ln.startsWith(ql) && !dn.includes(ql)) continue;
        mobileMerged.push({
          id: mr.id,
          caseNumber: String(parsed.caseNumber ?? ""),
          patientFirstName: spaceIdx >= 0 ? patientName.slice(0, spaceIdx) : patientName,
          patientLastName: spaceIdx >= 0 ? patientName.slice(spaceIdx + 1) : "",
          doctorName: String(parsed.doctorName ?? ""),
          status: "received",
        });
      } catch {
        // skip malformed rows
      }
    }

    return ok(res, { cases: [...canonicalResults, ...mobileMerged] });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cases/barcode/:code
//
// Precise barcode lookup: returns the single case whose casePanBarcode equals
// the given code for the specified lab, or 404 if none exists.
// Requires lab membership. Intended for physical barcode scanner workflows.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/barcode/:code",
  asyncHandler(async (req, res) => {
    const code = String(req.params["code"] ?? "").trim();
    const labOrganizationId = String(req.query["labOrganizationId"] ?? "").trim();
    if (!labOrganizationId) throw new HttpError(400, "labOrganizationId is required.");
    if (!code) throw new HttpError(400, "Barcode code is required.");

    await requireMembership((req as any).auth.userId, labOrganizationId);

    const found = await db.query.cases.findFirst({
      where: and(
        eq(cases.labOrganizationId, labOrganizationId),
        eq(cases.casePanBarcode, code),
        notDeleted(cases),
      ),
    });

    if (found) return ok(res, { case: found });

    // Fall back to legacy mobile cases (`lab_cases`). Their barcode lives in
    // `case_data.assignedBarcode`, which the cases list surfaces as
    // `casePanBarcode` — but this precise-lookup route previously only checked
    // canonical `cases`, so scanning (or manually entering) a barcode that
    // belongs to a mobile-created case always 404'd even though the case is
    // plainly visible in the list.
    //
    // The `LIKE` clause is only a prefilter to avoid loading every legacy blob
    // for the org; the authoritative match is the exact-string comparison in
    // JS below. (Over-matching from any stray LIKE wildcard in `code` is
    // harmless — the exact compare filters it out — and the prefilter can never
    // under-match an app-written JSON blob.)
    const barcodeNeedle = `%"assignedBarcode":${JSON.stringify(code)}%`;
    const legacyCandidates = await db
      .select()
      .from(labCases)
      .where(
        and(
          isNull(labCases.deletedAt),
          eq(labCases.organizationId, labOrganizationId),
          sql`${labCases.caseData} LIKE ${barcodeNeedle}`,
        ),
      );

    for (const mr of legacyCandidates) {
      let parsed: any;
      try {
        parsed = typeof mr.caseData === "string" ? JSON.parse(mr.caseData) : mr.caseData;
      } catch {
        continue; // skip malformed rows
      }
      if (!parsed || typeof parsed !== "object") continue;
      if (String(parsed.assignedBarcode ?? "") !== code) continue;

      // Mirror the legacy → unified mapping used by the cases list so all
      // callers (mobile scan/batch-locate, desktop scanner) get a consistent
      // shape with a navigable `id`.
      const patientName = String(parsed.patientName ?? "");
      const spaceIdx = patientName.indexOf(" ");
      const firstName = spaceIdx >= 0 ? patientName.slice(0, spaceIdx) : patientName;
      const lastName = spaceIdx >= 0 ? patientName.slice(spaceIdx + 1) : "";
      const desktopStatus = legacyStatusToCanonical(parsed.status);
      const createdAt = parsed.createdAt
        ? new Date(Number(parsed.createdAt)).toISOString()
        : new Date().toISOString();
      const updatedAt = parsed.updatedAt
        ? new Date(Number(parsed.updatedAt)).toISOString()
        : createdAt;

      return ok(res, {
        case: {
          id: mr.id,
          caseNumber: String(parsed.caseNumber ?? ""),
          labOrganizationId: mr.organizationId ?? null,
          providerOrganizationId: null,
          patientFirstName: firstName,
          patientLastName: lastName,
          doctorName: String(parsed.doctorName ?? ""),
          status: desktopStatus,
          priority: parsed.isRush ? "rush" : "normal",
          dueDate: parsed.dueDate ?? null,
          createdByUserId: mr.ownerId,
          createdAt,
          updatedAt,
          restorationCount: 0,
          restorationTypes: parsed.caseType ?? null,
          restorationMaterials: parsed.material ?? null,
          teeth: parsed.toothIndices ?? null,
          totalPrice: parsed.price != null ? String(parsed.price) : "0.00",
          casePanBarcode: parsed.assignedBarcode ?? null,
          _source: "mobile",
        },
      });
    }

    throw new HttpError(404, "No case found with that barcode.");
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cases/by-number/:caseNumber
//
// Resolves a case number (as encoded in QR codes and labels) to its record ID
// and lab. Searches across all labs the authenticated caller belongs to.
// Returns 404 when no matching case is found.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/by-number/:caseNumber",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const caseNumber = String(req.params["caseNumber"] ?? "").trim();
    if (!caseNumber) throw new HttpError(400, "caseNumber is required.");

    const memberships = await db.query.organizationMemberships.findMany({
      where: and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
      ),
    });
    const orgIds = memberships
      .map((m: any) => m.labId)
      .filter(Boolean) as string[];
    if (orgIds.length === 0) throw new HttpError(404, "Case not found.");

    const rows = await db
      .select({
        id: cases.id,
        caseNumber: cases.caseNumber,
        labOrganizationId: cases.labOrganizationId,
      })
      .from(cases)
      .where(
        and(
          inArray(cases.labOrganizationId, orgIds),
          sql`lower(${cases.caseNumber}) = lower(${caseNumber})`,
          notDeleted(cases),
        ),
      )
      .limit(1);

    if (!rows.length) throw new HttpError(404, "Case not found.");
    return ok(res, {
      id: rows[0].id,
      caseNumber: rows[0].caseNumber,
      labOrganizationId: rows[0].labOrganizationId,
    });
  }),
);

// /cases/saved-views
//
// Named Cases search/status/date filters shared by every member of one lab.
// Desktop and mobile date snapshots are stored separately because they filter
// different case date fields.
//
// NOTE: must be declared before "/:caseId" so Express does not shadow it.
const caseSavedViewConflictName = "case_saved_views_lab_name_unique";

function normalizeCaseSavedViewName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new HttpError(400, "View name cannot be blank.");
  return normalized;
}

function validateCaseSavedViewCalendarDates(
  filters: z.infer<typeof CreateCaseSavedViewBody>["filters"],
): void {
  const dates = [
    filters.desktop?.customStartDate,
    filters.desktop?.customEndDate,
    filters.mobile?.createdCustomFrom,
    filters.mobile?.createdCustomTo,
    filters.mobile?.dueCustomFrom,
    filters.mobile?.dueCustomTo,
  ];
  if (dates.some((value) => value !== undefined && value !== "" && !isValidCalendarDate(value))) {
    throw new HttpError(400, "Saved view dates must be valid calendar dates.");
  }
}

async function assertCaseSavedViewNameAvailable(
  labOrganizationId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  const predicates = [
    eq(caseSavedViews.labOrganizationId, labOrganizationId),
    sql`lower(${caseSavedViews.name}) = lower(${name})`,
  ];
  if (exceptId) predicates.push(ne(caseSavedViews.id, exceptId));
  const [existing] = await db
    .select({ id: caseSavedViews.id })
    .from(caseSavedViews)
    .where(and(...predicates))
    .limit(1);
  if (existing) throw new HttpError(409, "A Cases view with this name already exists.");
}

async function requireCaseSavedViewLab(
  userId: string,
  labOrganizationId: string,
): Promise<void> {
  await requireMembership(userId, labOrganizationId);
  const [lab] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(
      eq(organizations.id, labOrganizationId),
      eq(organizations.type, "lab"),
      notDeleted(organizations),
    ))
    .limit(1);
  if (!lab) throw new HttpError(403, "Saved Cases views are shared within a lab.");
}

router.get(
  "/saved-views",
  asyncHandler(async (req, res) => {
    const query = ListCaseSavedViewsQueryParams.parse(req.query);
    await requireCaseSavedViewLab((req as any).auth.userId as string, query.labOrganizationId);
    const rows = await db
      .select()
      .from(caseSavedViews)
      .where(eq(caseSavedViews.labOrganizationId, query.labOrganizationId))
      .orderBy(asc(sql`lower(${caseSavedViews.name})`), asc(caseSavedViews.id));
    return res.json(ListCaseSavedViews200Response.parse({ ok: true, data: rows }));
  }),
);

router.post(
  "/saved-views",
  asyncHandler(async (req, res) => {
    const body = CreateCaseSavedViewBody.parse(req.body);
    validateCaseSavedViewCalendarDates(body.filters);
    const userId = (req as any).auth.userId as string;
    await requireCaseSavedViewLab(userId, body.labOrganizationId);
    const name = normalizeCaseSavedViewName(body.name);
    await assertCaseSavedViewNameAvailable(body.labOrganizationId, name);
    try {
      const [savedView] = await db
        .insert(caseSavedViews)
        .values({
          labOrganizationId: body.labOrganizationId,
          name,
          filters: body.filters,
          createdByUserId: userId,
        })
        .returning();
      if (!savedView) throw new HttpError(500, "The Cases view could not be saved.");
      return res.status(201).json(
        CreateCaseSavedView201Response.parse({ ok: true, data: savedView }),
      );
    } catch (error) {
      if (extractPgConstraintName(error) === caseSavedViewConflictName) {
        throw new HttpError(409, "A Cases view with this name already exists.");
      }
      throw error;
    }
  }),
);

router.patch(
  "/saved-views/:id",
  asyncHandler(async (req, res) => {
    const params = RenameCaseSavedViewParams.parse(req.params);
    const body = RenameCaseSavedViewBody.parse(req.body);
    if (body.name === undefined && body.filters === undefined) {
      throw new HttpError(400, "Provide a view name or filters to update.");
    }
    if (body.filters) validateCaseSavedViewCalendarDates(body.filters);
    await requireCaseSavedViewLab(
      (req as any).auth.userId as string,
      body.labOrganizationId,
    );
    const name = body.name === undefined ? undefined : normalizeCaseSavedViewName(body.name);
    const [existing] = await db
      .select({ id: caseSavedViews.id })
      .from(caseSavedViews)
      .where(and(
        eq(caseSavedViews.id, params.id),
        eq(caseSavedViews.labOrganizationId, body.labOrganizationId),
      ))
      .limit(1);
    if (!existing) throw new HttpError(404, "Cases view not found.");
    if (name !== undefined) {
      await assertCaseSavedViewNameAvailable(body.labOrganizationId, name, params.id);
    }
    try {
      const [savedView] = await db
        .update(caseSavedViews)
        .set({
          ...(name === undefined ? {} : { name }),
          ...(body.filters === undefined ? {} : { filters: body.filters }),
          updatedAt: new Date(),
        })
        .where(and(
          eq(caseSavedViews.id, params.id),
          eq(caseSavedViews.labOrganizationId, body.labOrganizationId),
        ))
        .returning();
      if (!savedView) throw new HttpError(404, "Cases view not found.");
      return res.json(
        RenameCaseSavedView200Response.parse({ ok: true, data: savedView }),
      );
    } catch (error) {
      if (extractPgConstraintName(error) === caseSavedViewConflictName) {
        throw new HttpError(409, "A Cases view with this name already exists.");
      }
      throw error;
    }
  }),
);

router.delete(
  "/saved-views/:id",
  asyncHandler(async (req, res) => {
    const params = DeleteCaseSavedViewParams.parse(req.params);
    const query = DeleteCaseSavedViewQueryParams.parse(req.query);
    await requireCaseSavedViewLab(
      (req as any).auth.userId as string,
      query.labOrganizationId,
    );
    const [deleted] = await db
      .delete(caseSavedViews)
      .where(and(
        eq(caseSavedViews.id, params.id),
        eq(caseSavedViews.labOrganizationId, query.labOrganizationId),
      ))
      .returning({ id: caseSavedViews.id });
    if (!deleted) throw new HttpError(404, "Cases view not found.");
    return res.sendStatus(204);
  }),
);

// GET /cases/itero-import-history
//
// Returns iTero batch-import sessions for a lab (newest first). Each session
// shows when it ran, who ran it, accurate created/deduped/errored counts, and
// the resulting case IDs so the client can deep-link to a filtered case list.
//
// NOTE: must be declared before "/:caseId" so Express does not shadow it.
const iteroHistoryQuerySchema = z.object({
  labOrganizationId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  "/itero-import-history",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const query = iteroHistoryQuerySchema.parse(req.query ?? {});

    await requireMembership(userId, query.labOrganizationId);

    // Fetch total count for correct pagination (independent of limit/offset)
    const [{ totalCount }] = await db
      .select({ totalCount: sql<number>`count(*)` })
      .from(iteroImportSessions)
      .where(eq(iteroImportSessions.labOrganizationId, query.labOrganizationId));

    const rows = await db
      .select({
        id: iteroImportSessions.id,
        importedAt: iteroImportSessions.importedAt,
        importedByUserId: iteroImportSessions.importedByUserId,
        createdCount: iteroImportSessions.createdCount,
        dedupedCount: iteroImportSessions.dedupedCount,
        erroredCount: iteroImportSessions.erroredCount,
        caseIds: iteroImportSessions.caseIds,
        batchId: iteroImportSessions.batchId,
      })
      .from(iteroImportSessions)
      .where(eq(iteroImportSessions.labOrganizationId, query.labOrganizationId))
      .orderBy(desc(iteroImportSessions.importedAt))
      .limit(query.limit)
      .offset(query.offset);

    const userIds = [...new Set(rows.map((r) => r.importedByUserId).filter(Boolean) as string[])];
    const userRows = userIds.length > 0
      ? await db
          .select({ id: users.id, username: users.username, firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const userMap = Object.fromEntries(userRows.map((u) => [u.id, u]));

    const sessions = rows.map((r) => {
      const u = r.importedByUserId ? userMap[r.importedByUserId] : undefined;
      const created = Number(r.createdCount);
      const deduped = Number(r.dedupedCount);
      const errored = Number(r.erroredCount);
      return {
        batchId: r.batchId ?? r.id,
        importedAt: r.importedAt,
        importedByUserId: r.importedByUserId ?? null,
        importedByUsername: u?.username ?? null,
        importedByName: u ? [u.firstName, u.lastName].filter(Boolean).join(" ") || null : null,
        createdCount: created,
        dedupedCount: deduped,
        erroredCount: errored,
        totalCount: created + deduped + errored,
        caseIds: (r.caseIds ?? []).filter(Boolean),
      };
    });

    return ok(res, { sessions, total: Number(totalCount), limit: query.limit, offset: query.offset });
  }),
);

router.get(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const caseId = req.params.caseId;
    let access;
    try {
      access = await assertCaseAccessWithMemberships(userId, caseId);
    } catch (err) {
      // Bridge: when the id isn't in the canonical cases table, try the
      // mobile-app legacy lab_cases JSON blob and project it into the
      // DetailedCase shape. Lets desktop view mobile-created cases.
      if (err instanceof HttpError && err.statusCode === 404) {
        const projected = await tryProjectLegacyCaseForDesktop(userId, caseId);
        if (projected) return ok(res, projected);
      }
      throw err;
    }
    const found = access.case;
    const isLabMember = !!access.labMembership;
    const [restorations, notes, attachments, events, locations] =
      await Promise.all([
        db.query.caseRestorations.findMany({
          where: eq(caseRestorations.caseId, found.id),
        }),
        db.query.caseNotes.findMany({
          where: eq(caseNotes.caseId, found.id),
          orderBy: [desc(caseNotes.createdAt)],
        }),
        db.query.caseAttachments.findMany({
          where: and(
            or(
              eq(caseAttachments.caseId, found.id),
              eq(caseAttachments.labCaseId, found.id),
            ),
            isNull(caseAttachments.deletedAt),
          ),
          orderBy: [desc(caseAttachments.createdAt)],
        }),
        db.query.caseEvents.findMany({
          where: eq(caseEvents.caseId, found.id),
          orderBy: [desc(caseEvents.occurredAt)],
        }),
        db.query.caseLocations.findMany({
          where: eq(caseLocations.caseId, found.id),
          orderBy: [asc(caseLocations.movedAt)],
        }),
      ]);

    // Guarantee a "Case Created" entry in the History tab regardless of which
    // platform created the case. Canonical case creation (POST /cases) writes
    // a case_created event, but any case from an older path that skipped that
    // insert would have a Created-less History tab. Synthesize one from
    // `found.createdAt` when no creation-type event already exists.
    const CANONICAL_CREATION_EVENT_TYPES = new Set([
      "created",
      "case_created",
      "case_created_from_itero",
    ]);
    if (
      found.createdAt &&
      !events.some((e: any) =>
        CANONICAL_CREATION_EVENT_TYPES.has(String(e.eventType)),
      )
    ) {
      const createdAtIso =
        found.createdAt instanceof Date
          ? found.createdAt.toISOString()
          : new Date(found.createdAt as any).toISOString();
      events.push({
        id: `synth-created-${found.id}`,
        caseId: found.id,
        eventType: "case_created",
        actorUserId: found.createdByUserId ?? null,
        actorOrganizationId: found.labOrganizationId,
        actorInitials: null,
        metadataJson: { synthesized: true, source: "case_created_at" },
        occurredAt: createdAtIso,
        createdAt: createdAtIso,
      } as any);
      // Keep newest-first ordering used by the rest of the handler.
      events.sort(
        (a: any, b: any) =>
          new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
      );
    }

    // Fetch original case events when this is a remake so the history tab can
    // display the full timeline (original case history + remake history) in one view.
    const originalCaseEvents: typeof events = found.remakeOfCaseId
      ? await db.query.caseEvents.findMany({
          where: eq(caseEvents.caseId, found.remakeOfCaseId),
          orderBy: [desc(caseEvents.occurredAt)],
        })
      : [];

    // Resolve display names for both attachment uploaders and note
    // authors in a single users lookup so the Overview Rx Summary can
    // show "<author> · <relative time>" alongside each note.
    const uploaderIds = attachments
      .map((a: any) => a.uploadedByUserId)
      .filter(Boolean);
    const noteAuthorIds = notes
      .map((n: any) => n.authorUserId)
      .filter(Boolean);
    const userIds = Array.from(new Set([...uploaderIds, ...noteAuthorIds]));
    const userRows = userIds.length
      ? await db.query.users.findMany({ where: inArray(users.id, userIds) })
      : [];
    const userById = new Map(userRows.map((u: any) => [u.id, u]));
    const displayNameFor = (id: string | null | undefined): string | null => {
      if (!id) return null;
      const u = userById.get(id) as any | undefined;
      if (!u) return null;
      return (
        [u.firstName, u.lastName].filter(Boolean).join(" ") ||
        u.username ||
        u.email ||
        null
      );
    };
    const attachmentsWithScanAccuracy = await enrichScanAttachments(attachments);
    const enrichedAttachments = attachmentsWithScanAccuracy.map((a: any) => ({
      ...a,
      uploaderName: displayNameFor(a.uploadedByUserId),
    }));
    const enrichedNotes = notes.map((n: any) => ({
      ...n,
      authorName: displayNameFor(n.authorUserId),
    }));

    const labRole = access.labMembership?.role as string | undefined;
    const viewerCanUploadAttachments = isLabMember;
    // Notes have a broader authorization path than uploads: either a lab
    // member or the case's linked provider may post one. Keep this explicit so
    // clients never infer note permission from attachment permission.
    const viewerCanPostNotes = !!(access.labMembership || access.providerMembership);
    const viewerQuickReferenceOrganizationId = isLabMember
      ? found.labOrganizationId
      : access.providerMembership
        ? found.providerOrganizationId
        : null;
    const viewerCanManageAttachments =
      isLabMember && !!labRole && (ADMIN_ROLES as string[]).includes(labRole);

    // Look up the original case (if this is a remake) and any later cases
    // that mark THIS case as their remake target. Both ends of the link are
    // surfaced in the detail payload so the UI can render banners on either
    // side without an extra round-trip.
    const [
      remakeOriginalRow,
      remakeOriginalLegacyRow,
      remakeChildrenRows,
      remakeChildrenLegacyRows,
    ] = await Promise.all([
      found.remakeOfCaseId
        ? db.query.cases.findFirst({
            where: and(
              eq(cases.id, found.remakeOfCaseId),
              notDeleted(cases),
            ),
          })
        : Promise.resolve(null),
      found.remakeOfCaseId
        ? db.query.labCases.findFirst({
            where: and(
              eq(labCases.id, found.remakeOfCaseId),
              isNull(labCases.deletedAt),
            ),
          })
        : Promise.resolve(null),
      db.query.cases.findMany({
        where: and(eq(cases.remakeOfCaseId, found.id), notDeleted(cases)),
        orderBy: [desc(cases.createdAt)],
      }),
      // Legacy mobile cases that mark THIS canonical case as their
      // remake target. The legacy row stores it inside the JSON
      // `case_data.remakeOfCaseId` field, so we cast text → jsonb on
      // the fly. Same lab only.
      db
        .select()
        .from(labCases)
        .where(
          and(
            eq(labCases.organizationId, found.labOrganizationId),
            isNull(labCases.deletedAt),
            sql`(${labCases.caseData}::jsonb->>'remakeOfCaseId') = ${found.id}`,
          ),
        ),
    ]);

    // Resolve remake locations in one tenant-scoped lookup. Never trust a
    // location id stored in a legacy blob (or a stale canonical row) without
    // confirming that it belongs to this case's lab.
    const remakeLocationIds = Array.from(
      new Set(
        [
          remakeOriginalRow && (remakeOriginalRow as any).labLocationId,
          ...remakeChildrenRows.map((r: any) => r.labLocationId),
          ...remakeChildrenLegacyRows.map((r: any) => {
            try {
              const parsed = typeof r.caseData === "string" ? JSON.parse(r.caseData) : r.caseData;
              return parsed?.labLocationId;
            } catch {
              return null;
            }
          }),
        ].filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    );
    const remakeLocationRows = remakeLocationIds.length
      ? await db
          .select({ id: labLocations.id, name: labLocations.name })
          .from(labLocations)
          .where(
            and(
              inArray(labLocations.id, remakeLocationIds),
              eq(labLocations.labOrganizationId, found.labOrganizationId),
            ),
          )
      : [];
    const remakeLocationById = new Map(remakeLocationRows.map((r) => [r.id, r]));

    // Fetch events from all canonical remake children so the original case
    // view can show a unified timeline with each child's entries labeled by
    // case number (e.g. "26-22B" badge next to the event).
    const remakeChildrenEvents: Array<{
      caseId: string;
      caseNumber: string;
      events: (typeof events);
    }> =
      remakeChildrenRows.length > 0
        ? await Promise.all(
            remakeChildrenRows.map(async (child) => ({
              caseId: child.id,
              caseNumber: child.caseNumber,
              events: await db.query.caseEvents.findMany({
                where: eq(caseEvents.caseId, child.id),
                orderBy: [desc(caseEvents.occurredAt)],
              }),
            }))
          )
        : [];

    // Some invoice corrections live only in the immutable invoice audit log,
    // while newer payment deletions may also have a case_event. Project the
    // authoritative audits into every canonical timeline included in the
    // unified history export (current, original, and remake children), replacing
    // duplicate payment-deletion case events. Billing audit details remain
    // lab-only, matching the invoice detail endpoint.
    if (isLabMember) {
      const timelines = new Map<string, typeof events>([[found.id, events]]);
      if (found.remakeOfCaseId) {
        timelines.set(found.remakeOfCaseId, originalCaseEvents);
      }
      for (const child of remakeChildrenEvents) {
        timelines.set(child.caseId, child.events);
      }
      const caseIds = [...timelines.keys()];
      const correctionRows = await db
        .select({
          auditLogId: auditLogs.id,
          caseId: invoices.caseId,
          invoiceId: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          userId: auditLogs.userId,
          beforeJson: auditLogs.beforeJson,
          afterJson: auditLogs.afterJson,
          metadataJson: auditLogs.metadataJson,
          action: auditLogs.action,
          createdAt: auditLogs.createdAt,
          actorUsername: users.username,
          actorFirstName: users.firstName,
          actorLastName: users.lastName,
          actorInitials: users.initials,
        })
        .from(auditLogs)
        .innerJoin(invoices, eq(invoices.id, auditLogs.entityId))
        .leftJoin(users, eq(users.id, auditLogs.userId))
        .where(
          and(
            inArray(invoices.caseId, caseIds),
            eq(invoices.labOrganizationId, found.labOrganizationId),
            eq(auditLogs.entityType, "invoice"),
            inArray(auditLogs.action, [
              "invoice_dates_repaired",
              "invoice_payments_deleted",
              "invoice_doctor_identity_repaired",
            ]),
          ),
        );
      const paymentAuditInvoiceIds = new Set(
        correctionRows
          .filter((row) => row.action === "invoice_payments_deleted")
          .map((row) => row.invoiceId),
      );
      for (const timeline of timelines.values()) {
        for (let index = timeline.length - 1; index >= 0; index -= 1) {
          const event = timeline[index] as any;
          if (
            event.eventType === "invoice_payments_deleted" &&
            paymentAuditInvoiceIds.has(event.metadataJson?.invoiceId)
          ) {
            timeline.splice(index, 1);
          }
        }
      }
      for (const correction of correctionRows) {
        if (!correction.caseId) continue;
        const target = timelines.get(correction.caseId);
        if (!target) continue;
        const before = (correction.beforeJson ?? {}) as Record<string, unknown>;
        const after = (correction.afterJson ?? {}) as Record<string, unknown>;
        const metadata = (correction.metadataJson ?? {}) as Record<string, unknown>;
        const authorName =
          [correction.actorFirstName, correction.actorLastName]
            .filter(Boolean)
            .join(" ")
            .trim() ||
          correction.actorUsername ||
          correction.actorInitials ||
          "System";
        const occurredAt =
          correction.createdAt instanceof Date
            ? correction.createdAt.toISOString()
            : new Date(correction.createdAt as any).toISOString();
        const isPaymentDeletion =
          correction.action === "invoice_payments_deleted";
        const isDoctorIdentityRepair =
          correction.action === "invoice_doctor_identity_repaired";
        target.push({
          id: isPaymentDeletion
            ? `invoice-payment-deletion-${correction.auditLogId}`
            : isDoctorIdentityRepair
              ? `invoice-doctor-identity-repair-${correction.auditLogId}`
            : `invoice-date-repair-${correction.auditLogId}`,
          caseId: correction.caseId,
          eventType: correction.action,
          actorUserId: correction.userId,
          actorOrganizationId: found.labOrganizationId,
          actorInitials: correction.actorInitials ?? "SYS",
          metadataJson: isPaymentDeletion
            ? {
                auditLogId: correction.auditLogId,
                invoiceId: correction.invoiceId,
                invoiceNumber:
                  metadata.invoiceNumber ?? correction.invoiceNumber,
                authorName,
                deletedCount: metadata.deletedCount ?? null,
                reversedDepositCount: metadata.reversedDepositCount ?? null,
                previousStatus: metadata.previousStatus ?? null,
                synthesized: true,
                source: "invoice_audit_log",
              }
            : isDoctorIdentityRepair
              ? {
                  auditLogId: correction.auditLogId,
                  invoiceId: correction.invoiceId,
                  invoiceNumber: correction.invoiceNumber,
                  authorName,
                  previousDoctorIdentity: before.doctorIdentity ?? null,
                  previousDoctorDisplayName: before.doctorDisplayName ?? null,
                  correctedDoctorIdentity: after.doctorIdentity ?? null,
                  correctedDoctorDisplayName: after.doctorDisplayName ?? null,
                  synthesized: true,
                  source: "invoice_audit_log",
                }
              : {
                auditLogId: correction.auditLogId,
                invoiceId: correction.invoiceId,
                invoiceNumber: correction.invoiceNumber,
                authorName,
                previousIssuedAt: before.issuedAt ?? null,
                previousDueAt: before.dueAt ?? null,
                correctedIssuedAt: after.issuedAt ?? null,
                correctedDueAt: after.dueAt ?? null,
                synthesized: true,
                source: "invoice_audit_log",
              },
          occurredAt,
          createdAt: occurredAt,
        } as any);
      }
      for (const timeline of timelines.values()) {
        timeline.sort(
          (a: any, b: any) =>
            new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
        );
      }
    }

    let remakeOriginal: {
      id: string;
      caseNumber: string;
      patientFirstName: string | null;
      patientLastName: string | null;
      status: string | null;
      createdAt: Date | string | null;
      labLocationId: string | null;
      labLocationName: string | null;
      kind: "canonical" | "legacy";
    } | null = null;
    if (remakeOriginalRow) {
      remakeOriginal = {
        id: remakeOriginalRow.id,
        caseNumber: remakeOriginalRow.caseNumber,
        patientFirstName: remakeOriginalRow.patientFirstName,
        patientLastName: remakeOriginalRow.patientLastName,
        status: remakeOriginalRow.status,
        createdAt: remakeOriginalRow.createdAt,
        labLocationId: remakeLocationById.has((remakeOriginalRow as any).labLocationId)
          ? (remakeOriginalRow as any).labLocationId
          : null,
        labLocationName:
          remakeLocationById.get((remakeOriginalRow as any).labLocationId)?.name ?? null,
        kind: "canonical",
      };
    } else if (
      remakeOriginalLegacyRow &&
      remakeOriginalLegacyRow.organizationId === found.labOrganizationId
    ) {
      let parsed: any = {};
      try {
        parsed = JSON.parse(remakeOriginalLegacyRow.caseData);
      } catch {
        parsed = {};
      }
      const locationId =
        typeof parsed?.labLocationId === "string" && parsed.labLocationId
          ? parsed.labLocationId
          : null;
      remakeOriginal = {
        id: remakeOriginalLegacyRow.id,
        caseNumber: parsed?.caseNumber ?? remakeOriginalLegacyRow.id,
        patientFirstName: parsed?.patientFirstName ?? parsed?.patientName ?? null,
        patientLastName: parsed?.patientLastName ?? null,
        status: parsed?.status ?? null,
        createdAt: parsed?.createdAt ?? remakeOriginalLegacyRow.updatedAt ?? null,
        labLocationId: locationId && remakeLocationById.has(locationId) ? locationId : null,
        labLocationName: locationId ? remakeLocationById.get(locationId)?.name ?? null : null,
        kind: "legacy",
      };
    }
    const remakeChildren: Array<{
      id: string;
      caseNumber: string;
      patientFirstName: string | null;
      patientLastName: string | null;
      status: string | null;
      createdAt: Date | string | null;
      labLocationId: string | null;
      labLocationName: string | null;
      remakeReason: string | null;
      remakeCharged: boolean | null;
      kind: "canonical" | "legacy";
    }> = remakeChildrenRows.map((r: any) => ({
      id: r.id,
      caseNumber: r.caseNumber,
      patientFirstName: r.patientFirstName,
      patientLastName: r.patientLastName,
      status: r.status,
      createdAt: r.createdAt,
      labLocationId: remakeLocationById.has(r.labLocationId) ? r.labLocationId : null,
      labLocationName: remakeLocationById.get(r.labLocationId)?.name ?? null,
      remakeReason: r.remakeReason,
      remakeCharged: r.remakeCharged,
      kind: "canonical",
    }));
    // Append legacy mobile remakes-of-this-case so the desktop UI sees
    // the full set of children, not just canonical ones.
    for (const lr of remakeChildrenLegacyRows as any[]) {
      let parsed: any = {};
      try {
        parsed =
          typeof lr.caseData === "string" ? JSON.parse(lr.caseData) : lr.caseData;
      } catch {
        parsed = {};
      }
      const split = splitDisplayName(parsed?.patientName);
      const locationId =
        typeof parsed?.labLocationId === "string" && parsed.labLocationId
          ? parsed.labLocationId
          : null;
      remakeChildren.push({
        id: lr.id,
        caseNumber: String(parsed?.caseNumber ?? lr.id),
        patientFirstName: parsed?.patientFirstName ?? split.first ?? null,
        patientLastName: parsed?.patientLastName ?? split.last ?? null,
        status: parsed?.status ?? null,
        createdAt: parsed?.createdAt ?? lr.updatedAt ?? null,
        labLocationId: locationId && remakeLocationById.has(locationId) ? locationId : null,
        labLocationName: locationId ? remakeLocationById.get(locationId)?.name ?? null : null,
        remakeReason:
          typeof parsed?.remakeReason === "string" ? parsed.remakeReason : null,
        remakeCharged:
          typeof parsed?.remakeCharged === "boolean"
            ? parsed.remakeCharged
            : null,
        kind: "legacy",
      });
    }

    // Resolve the suggested practice name so the desktop banner can display it
    // without a second round-trip.
    let suggestedPracticeName: string | null = null;
    let labLocationName: string | null = null;
    const foundLabLocationId = (found as any).labLocationId ?? null;
    const [suggestedOrgResult, labLocationResult, labOrgForSlip, providerOrg] =
      await Promise.all([
        found.suggestedProviderOrgId
          ? db.query.organizations.findFirst({
              where: eq(organizations.id, found.suggestedProviderOrgId),
            })
          : Promise.resolve(null),
        foundLabLocationId
          ? db.query.labLocations.findFirst({
              where: and(
                eq(labLocations.id, foundLabLocationId),
                eq(labLocations.labOrganizationId, found.labOrganizationId),
              ),
            })
          : Promise.resolve(null),
        db.query.organizations.findFirst({
          where: eq(organizations.id, found.labOrganizationId),
          columns: { printProviderPreferencesOnLabSlips: true },
        }),
        found.providerOrganizationId
          ? db.query.organizations.findFirst({
              where: eq(organizations.id, found.providerOrganizationId),
            })
          : Promise.resolve(null),
      ]);
    suggestedPracticeName = suggestedOrgResult?.name ?? null;
    labLocationName = labLocationResult?.name ?? null;

    // Point-lookup for doctor preferences from the doctor_profiles table.
    // This hits the partial unique index on (labOrganizationId, doctorName,
    // providerOrganizationId) so it is O(1) regardless of profile count.
    // Returns null when no profile has been created for this doctor yet.
    const doctorProfileRow = await db.query.doctorProfiles.findFirst({
      where: and(
        eq(doctorProfiles.labOrganizationId, found.labOrganizationId),
        sql`lower(${doctorProfiles.doctorName}) = lower(${found.doctorName ?? ""})`,
        found.providerOrganizationId
          ? eq(doctorProfiles.providerOrganizationId, found.providerOrganizationId)
          : isNull(doctorProfiles.providerOrganizationId)
      ),
      columns: { preferences: true },
    });
    const doctorPreferences: string | null = doctorProfileRow?.preferences ?? null;

    // Provider-authored preferences are deliberately resolved from the current
    // active provider membership for this case's provider organization. They
    // are not the lab-authored doctor_profiles.preferences above. We use the
    // existing canonical doctor-name normalization only after scoping the
    // candidates to this exact provider organization, never another practice.
    const normalizedCaseDoctorName = normalizeDoctorForCompare(found.doctorName);
    const providerPreferenceUsers =
      found.providerOrganizationId && normalizedCaseDoctorName
        ? await db
            .select({
              doctorName: users.doctorName,
              doctorPreferences: users.doctorPreferences,
            })
            .from(organizationMemberships)
            .innerJoin(users, eq(users.id, organizationMemberships.userId))
            .where(
              and(
                eq(organizationMemberships.labId, found.providerOrganizationId),
                eq(organizationMemberships.status, "active"),
                isNull(organizationMemberships.deletedAt),
                eq(users.isActive, true),
                eq(users.userType, "provider"),
              ),
            )
        : [];
    const matchingProviderPreferenceUsers = providerPreferenceUsers.filter(
      (user) =>
        normalizeDoctorForCompare(user.doctorName) === normalizedCaseDoctorName,
    );
    // Do not leak or arbitrarily select one user's preferences when duplicate
    // provider-user identities exist in the same practice.
    const providerPreferenceUser =
      matchingProviderPreferenceUsers.length === 1
        ? matchingProviderPreferenceUsers[0]
        : null;
    const providerDoctorPreferences: DoctorPreferences | null =
      providerPreferenceUser
        ? formatDoctorPreferences(providerPreferenceUser.doctorPreferences)
        : null;

    // Fetch provider org contact details so the desktop print renderer can
    // populate the Doctor Info label block without an extra round-trip.
    // Also expose the lab-scoped account number so clients can display it
    // next to the doctor name without an additional lookup.
    let providerOrganizationContact: {
      name?: string | null;
      addressLine1?: string | null;
      addressLine2?: string | null;
      city?: string | null;
      state?: string | null;
      zip?: string | null;
      phone?: string | null;
      billingEmail?: string | null;
    } | null = null;
    let providerAccountNumber: string | null = null;
    if (providerOrg) {
      providerOrganizationContact = {
        name: (providerOrg as any).name ?? null,
        addressLine1: (providerOrg as any).addressLine1 ?? null,
        addressLine2: (providerOrg as any).addressLine2 ?? null,
        city: (providerOrg as any).city ?? null,
        state: (providerOrg as any).state ?? null,
        zip: (providerOrg as any).zip ?? null,
        phone: (providerOrg as any).phone ?? null,
        billingEmail: (providerOrg as any).billingEmail ?? null,
      };
      providerAccountNumber = (providerOrg as any).accountNumber ?? null;
    }

    const STATUS_LABELS: Record<string, string> = {
      received: "Received",
      in_design: "Design",
      scan: "Scan",
      in_milling: "Milling",
      post_mill: "Post Mill",
      sintering_furnace: "Sintering",
      model_room: "Model Room",
      in_porcelain: "Porcelain",
      qc: "QC",
      complete: "Complete",
      shipped: "Shipped",
      delivered: "Delivered",
      on_hold: "On Hold",
      remake: "Remake",
      cancelled: "Cancelled",
    };
    const statusHistory: Array<{ status: string; label: string; occurredAt: Date }> = [
      {
        status: "received",
        label: STATUS_LABELS["received"] ?? "Received",
        occurredAt: calendarDateToUtcNoon(found.receivedAt),
      },
      ...(events as any[])
        .filter((e: any) => e.eventType === "status_changed")
        .sort(
          (a: any, b: any) =>
            new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()
        )
        .map((e: any) => {
          const s = (e.metadataJson as any)?.toStatus ?? null;
          if (!s) return null;
          return { status: s as string, label: (STATUS_LABELS[s] ?? s) as string, occurredAt: e.occurredAt as Date };
        })
        .filter((e): e is { status: string; label: string; occurredAt: Date } => e !== null),
    ];

    const historyCaseIds = Array.from(
      new Set([
        found.id,
        ...(found.remakeOfCaseId ? [found.remakeOfCaseId] : []),
        ...remakeChildrenRows.map((row) => row.id),
      ]),
    );
    const relatedHistoryAttachments = await db.query.caseAttachments.findMany({
      where: or(
        inArray(caseAttachments.caseId, historyCaseIds),
        inArray(caseAttachments.labCaseId, historyCaseIds),
      ),
    });

    // Backfill note into case_attachment_added events whose metadataJson
    // predates the note field being stored there. Look up the note from the
    // already-fetched attachments list by attachmentId so we never do extra
    // DB queries and existing history entries gain their notes automatically.
    const historyAttachmentById = new Map<string, any>(
      relatedHistoryAttachments.map((attachment: any) => [attachment.id, attachment]),
    );
    const enrichEventsWithNote = (evList: any[]) =>
      evList.map((ev: any) => {
        if (ev.eventType !== "case_attachment_added") return ev;
        const meta = (ev.metadataJson ?? {}) as Record<string, unknown>;
        const attachmentId = typeof meta.attachmentId === "string" ? meta.attachmentId : null;
        if (!attachmentId) return ev;
        const liveAttachment = historyAttachmentById.get(attachmentId);
        if (!liveAttachment) {
          return isLabMember
            ? ev
            : {
                ...ev,
                metadataJson: stripExceptionAttachmentMetadata(meta),
              };
        }
        if (
          !isLabMember &&
          liveAttachment.visibility !== "shared_with_provider"
        ) {
          return {
            ...ev,
            metadataJson: stripExceptionAttachmentMetadata(meta),
          };
        }
        // Always reflect the attachment's current note so edits and clears
        // made after upload show up in history without a stored-metadata
        // rewrite. `attachmentNoteById` only holds attachments that still
        // have a note, so a cleared note resolves to null and is removed.
        const liveNote =
          typeof liveAttachment.note === "string" && liveAttachment.note
            ? liveAttachment.note
            : null;
        if ((meta.note ?? null) === liveNote) return ev;
        const nextMeta: Record<string, unknown> = { ...meta };
        if (liveNote) nextMeta.note = liveNote;
        else delete nextMeta.note;
        return { ...ev, metadataJson: nextMeta };
      });

    // Surface restorations whose material couldn't be mapped to a standard
    // price key. These resolve to a $0 line on the auto-draft invoice and
    // are otherwise silent — the "needs AI review" banner calls them out by
    // name so an admin can fix pricing before billing. We skip rows a human
    // already priced manually (priceSource === "manual"), since those are
    // intentional, and rows without any material (nothing to recognize).
    const unrecognizedMaterials = Array.from(
      new Set(
        (
          await Promise.all(
            (restorations as any[]).map(async (r) => {
              const mat = (r.material ?? "").trim();
              if (!mat || r.priceSource === "manual") return null;
              const key = await resolveRestorationPriceKey({
                labOrganizationId: found.labOrganizationId,
                material: r.material,
                restorationType: r.restorationType,
                restorationSubtype: r.restorationSubtype,
              });
              return key === null ? mat : null;
            }),
          )
        ).filter((material): material is string => material !== null),
      ),
    );

    // Notes/note bodies are visibility-scoped: non-lab viewers never receive
    // internal lab-only note text — neither through the `notes` array, the
    // `caseNotes` Rx-fallback summary, nor raw `note_added` event metadata.
    const visibleNotes = visibleNotesFor(enrichedNotes, isLabMember);

    // Prescription history follows this case's direct remakeOfCaseId chain
    // only. Siblings and descendants are deliberately excluded.
    const rxChainNewestFirst: Array<{
      id: string;
      rxNotes: string | null;
      remakeOfCaseId: string | null;
      labOrganizationId: string;
      providerOrganizationId: string | null;
      legacy?: boolean;
    }> = [];
    const visitedRxCaseIds = new Set<string>();
    let rxCursor: any = found;
    for (let depth = 0; rxCursor && depth < 25; depth += 1) {
      if (visitedRxCaseIds.has(rxCursor.id)) break;
      visitedRxCaseIds.add(rxCursor.id);
      rxChainNewestFirst.push(rxCursor);
      const parentId = rxCursor.remakeOfCaseId;
      if (!parentId) break;

      const parent = await db.query.cases.findFirst({
        where: and(
          eq(cases.id, parentId),
          eq(cases.labOrganizationId, found.labOrganizationId),
          notDeleted(cases),
        ),
      });
      if (parent) {
        if (
          parent.providerOrganizationId !== found.providerOrganizationId &&
          !isLabMember
        ) {
          break;
        }
        rxCursor = parent;
        continue;
      }

      const legacyParent = await db.query.labCases.findFirst({
        where: and(
          eq(labCases.id, parentId),
          eq(labCases.organizationId, found.labOrganizationId),
          isNull(labCases.deletedAt),
        ),
      });
      if (!legacyParent || !isLabMember) break;
      let legacyData: any = {};
      try {
        legacyData =
          typeof legacyParent.caseData === "string"
            ? JSON.parse(legacyParent.caseData)
            : legacyParent.caseData ?? {};
      } catch {
        legacyData = {};
      }
      rxCursor = {
        id: legacyParent.id,
        rxNotes:
          typeof legacyData.rxNotes === "string"
            ? legacyData.rxNotes
            : typeof legacyData.caseNotes === "string"
              ? legacyData.caseNotes
              : null,
        remakeOfCaseId:
          typeof legacyData.remakeOfCaseId === "string"
            ? legacyData.remakeOfCaseId
            : null,
        labOrganizationId: found.labOrganizationId,
        providerOrganizationId: found.providerOrganizationId,
        legacy: true,
      };
    }
    const rxChainOldestFirst = rxChainNewestFirst.reverse();
    const canonicalRxCaseIds = rxChainOldestFirst
      .filter((row) => !row.legacy)
      .map((row) => row.id);
    const persistedRxEntries = await listRxNoteEntries(db, canonicalRxCaseIds);
    const rxEntriesByCaseId = new Map<string, any[]>();
    for (const entry of persistedRxEntries) {
      const group = rxEntriesByCaseId.get(entry.caseId) ?? [];
      group.push(entry);
      rxEntriesByCaseId.set(entry.caseId, group);
    }
    const rxNoteEntries = rxChainOldestFirst.flatMap((row) => {
      const persisted = rxEntriesByCaseId.get(row.id);
      if (persisted?.length) return persisted;
      const text = (row.rxNotes ?? "").trim();
      return text
        ? [{
            id: `legacy-${row.id}`,
            caseId: row.id,
            noteText: text,
            scannedAt: null,
            provenance: "legacy",
          }]
        : [];
    });

    return ok(res, {
      ...found,
      // remakeNotes is visible to all lab members; redact only for provider/practice viewers.
      remakeNotes: isLabMember ? ((found as any).remakeNotes ?? null) : null,
      caseNotes: (found as any).rxNotes ?? null,
      rxNoteEntries,
      suggestedPracticeName,
      labLocationId: labLocationResult ? foundLabLocationId : null,
      labLocationName,
      providerOrganizationContact,
      providerAccountNumber,
      /** Doctor preferences from the matching doctor_profiles row. Null when
       *  no profile has been created for this doctor yet. Used by the print
       *  renderer so it does not need a second round-trip. */
      doctorPreferences,
      /** Current, provider-authored structured preferences. Null when the
       * case's practice has no active provider user. This is intentionally
       * distinct from the lab-authored `doctorPreferences` above. */
      providerDoctorPreferences,
      /** Lab-controlled lab-slip setting. */
      printProviderPreferencesOnLabSlips:
        labOrgForSlip?.printProviderPreferencesOnLabSlips ?? false,
      restorations,
      unrecognizedMaterials,
      notes: visibleNotes,
      attachments: visibleAttachmentsFor(
        await sanitizeTextureAttachmentLinks(enrichedAttachments, found.id, isLabMember),
        isLabMember,
      ),
      events: sanitizeNoteEventsFor(enrichEventsWithNote(events), isLabMember),
      originalCaseEvents: sanitizeNoteEventsFor(enrichEventsWithNote(originalCaseEvents), isLabMember),
      remakeChildrenEvents: remakeChildrenEvents.map((rc) => ({
        ...rc,
        events: sanitizeNoteEventsFor(enrichEventsWithNote(rc.events), isLabMember),
      })),
      locations,
      remakeOriginal,
      remakeChildren,
      viewerIsLabMember: isLabMember,
      viewerCanUploadAttachments,
      viewerCanPostNotes,
      viewerQuickReferenceOrganizationId,
      viewerCanManageAttachments,
      statusHistory,
      // Exception content is lab-internal: providers/practices never see it.
      activeException: isLabMember
        ? await fetchActiveExceptionForCase(found.id)
        : null,
    });
  })
);

// ---------------------------------------------------------------------------
// GET /:caseId/remake-chain
// Walk up to the root ancestor then BFS down to collect the full remake
// chain for the given case.  Returns entries in chronological order (root
// first) so the UI can render a numbered timeline without any extra sorting.
// ---------------------------------------------------------------------------
router.get(
  "/:caseId/remake-chain",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const caseId = req.params.caseId;

    const access = await assertCaseAccessWithMemberships(userId, caseId);
    const labOrgId = access.case.labOrganizationId;
    const isLabMemberForChain = !!access.labMembership;

    const MAX_DEPTH = 30;

    // 1. Walk up to find the root (original case with no parent in this lab).
    let rootId = caseId;
    {
      let currentId = caseId;
      const seen = new Set<string>([currentId]);
      for (let i = 0; i < MAX_DEPTH; i++) {
        const row = await db.query.cases.findFirst({
          where: and(eq(cases.id, currentId), notDeleted(cases), eq(cases.labOrganizationId, labOrgId)),
          columns: { id: true, remakeOfCaseId: true },
        });
        if (!row?.remakeOfCaseId || seen.has(row.remakeOfCaseId)) break;
        const parentExists = await db.query.cases.findFirst({
          where: and(eq(cases.id, row.remakeOfCaseId), notDeleted(cases), eq(cases.labOrganizationId, labOrgId)),
          columns: { id: true },
        });
        if (!parentExists) break;
        seen.add(row.remakeOfCaseId);
        currentId = row.remakeOfCaseId;
      }
      rootId = currentId;
    }

    // 2. BFS from root — collect every node in chain order.
    type ChainEntry = {
      id: string;
      caseNumber: string;
      status: string | null;
      remakeReason: string | null;
      remakeCharged: boolean | null;
      remakeNotes: string | null;
      remakeShadeLightness: string | null;
      remakeShadePrescribed: string | null;
      remakeShadeProvided: string | null;
      remakeMaterialPrescribed: string | null;
      remakeMaterialProvided: string | null;
      remakeReturnedToLab: boolean | null;
      createdAt: Date | string | null;
      labLocationId: string | null;
      labLocationName: string | null;
    };
    const chain: ChainEntry[] = [];
    const queue: string[] = [rootId];
    const visited = new Set<string>();

    while (queue.length > 0 && chain.length < MAX_DEPTH) {
      const nextId = queue.shift()!;
      if (visited.has(nextId)) continue;
      visited.add(nextId);

      const row = await db.query.cases.findFirst({
        where: and(eq(cases.id, nextId), notDeleted(cases), eq(cases.labOrganizationId, labOrgId)),
        columns: { id: true, caseNumber: true, status: true, remakeReason: true, remakeCharged: true, remakeNotes: true, remakeShadeLightness: true, remakeShadePrescribed: true, remakeShadeProvided: true, remakeMaterialPrescribed: true, remakeMaterialProvided: true, remakeReturnedToLab: true, createdAt: true, labLocationId: true },
      });
      if (!row) continue;

      chain.push({
        id: row.id,
        caseNumber: row.caseNumber,
        status: row.status ?? null,
        remakeReason: row.remakeReason ?? null,
        remakeCharged: row.remakeCharged ?? null,
        // remakeNotes and structured questionnaire fields are lab-member-only —
        // redact for provider/practice viewers.
        remakeNotes: isLabMemberForChain ? (row.remakeNotes ?? null) : null,
        remakeShadeLightness: isLabMemberForChain ? (row.remakeShadeLightness ?? null) : null,
        remakeShadePrescribed: isLabMemberForChain ? (row.remakeShadePrescribed ?? null) : null,
        remakeShadeProvided: isLabMemberForChain ? (row.remakeShadeProvided ?? null) : null,
        remakeMaterialPrescribed: isLabMemberForChain ? (row.remakeMaterialPrescribed ?? null) : null,
        remakeMaterialProvided: isLabMemberForChain ? (row.remakeMaterialProvided ?? null) : null,
        remakeReturnedToLab: isLabMemberForChain ? (row.remakeReturnedToLab ?? null) : null,
        createdAt: row.createdAt,
        labLocationId: row.labLocationId ?? null,
        labLocationName: null,
      });

      const children = await db.query.cases.findMany({
        where: and(eq(cases.remakeOfCaseId, nextId), notDeleted(cases), eq(cases.labOrganizationId, labOrgId)),
        columns: { id: true },
        orderBy: [cases.createdAt],
      });
      for (const child of children) {
        if (!visited.has(child.id)) queue.push(child.id);
      }
    }

    const locationIds = Array.from(
      new Set(chain.map((entry) => entry.labLocationId).filter((id): id is string => Boolean(id))),
    );
    if (locationIds.length > 0) {
      const locationRows = await db
        .select({ id: labLocations.id, name: labLocations.name })
        .from(labLocations)
        .where(
          and(
            inArray(labLocations.id, locationIds),
            eq(labLocations.labOrganizationId, labOrgId),
          ),
        );
      const locationById = new Map(locationRows.map((row) => [row.id, row]));
      for (const entry of chain) {
        if (!entry.labLocationId || !locationById.has(entry.labLocationId)) {
          entry.labLocationId = null;
          entry.labLocationName = null;
        } else {
          entry.labLocationName = locationById.get(entry.labLocationId)?.name ?? null;
        }
      }
    }

    return ok(res, { chain });
  })
);

router.get(
  "/:caseId/attachments",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;

    let isLabMember = false;
    let attachments: any[];

    // Try canonical case first; fall through to legacy on 404.
    let canonicalAccess: Awaited<ReturnType<typeof assertCaseAccessWithMemberships>> | null = null;
    try {
      canonicalAccess = await assertCaseAccessWithMemberships(userId, req.params.caseId);
    } catch (e: any) {
      if (e.statusCode !== 404) throw e;
    }

    if (canonicalAccess) {
      isLabMember = !!canonicalAccess.labMembership;
      const byCanonicalId = await db.query.caseAttachments.findMany({
        where: and(
          eq(caseAttachments.caseId, canonicalAccess.case.id),
          isNull(caseAttachments.deletedAt)
        ),
        orderBy: [desc(caseAttachments.createdAt)],
      });
      // Also include attachments created before promotion (stored with labCaseId).
      const byLabCaseId = await db.query.caseAttachments.findMany({
        where: and(
          eq(caseAttachments.labCaseId, canonicalAccess.case.id),
          isNull(caseAttachments.deletedAt)
        ),
        orderBy: [desc(caseAttachments.createdAt)],
      });
      const seenIds = new Set(byCanonicalId.map((a: any) => a.id));
      attachments = [
        ...byCanonicalId,
        ...byLabCaseId.filter((a: any) => !seenIds.has(a.id)),
      ];
    } else {
      // Legacy mobile case — look up attachments by labCaseId.
      const mobileRow = await db.query.labCases.findFirst({
        where: and(eq(labCases.id, req.params.caseId), isNull(labCases.deletedAt)),
      });
      if (!mobileRow) throw new HttpError(404, "Case not found.");
      if (!mobileRow.organizationId) throw new HttpError(422, "Case has no associated organization.");
      const labIds = await fetchUserActiveLabIds(userId);
      if (!labIds.includes(mobileRow.organizationId)) {
        throw new HttpError(403, "You do not have access to this case.");
      }
      isLabMember = true;
      attachments = await db.query.caseAttachments.findMany({
        where: and(
          eq(caseAttachments.labCaseId, req.params.caseId),
          isNull(caseAttachments.deletedAt)
        ),
        orderBy: [desc(caseAttachments.createdAt)],
      });
    }

    attachments = await sanitizeTextureAttachmentLinks(
      await enrichScanAttachments(attachments),
      req.params.caseId,
      isLabMember,
    );
    const uploaderIds = Array.from(
      new Set(attachments.map((a: any) => a.uploadedByUserId).filter(Boolean))
    );
    const uploaderRows = uploaderIds.length
      ? await db.query.users.findMany({ where: inArray(users.id, uploaderIds) })
      : [];
    const uploaderById = new Map(uploaderRows.map((u: any) => [u.id, u]));
    const enriched = attachments.map((a: any) => {
      const u = uploaderById.get(a.uploadedByUserId) as any | undefined;
      const name = u
        ? [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          u.username ||
          u.email ||
          null
        : null;
      return { ...a, uploaderName: name };
    });
    return ok(res, visibleAttachmentsFor(enriched, isLabMember));
  })
);

const updateAttachmentSchema = z
  .object({
    visibility: z.enum(ATTACHMENT_VISIBILITIES).optional(),
    // `note` accepts a string to set/replace, an empty string or `null` to
    // clear. It is normalized below (trimmed; blank → null).
    note: z.string().max(1000).nullable().optional(),
  })
  .refine((v) => v.visibility !== undefined || v.note !== undefined, {
    message: "No attachment fields to update.",
  });

router.patch(
  "/:caseId/attachments/:attachmentId",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const input = updateAttachmentSchema.parse(req.body);
    let labOrganizationId: string;
    let canonicalCaseId: string | null = null;
    let attachmentCaseFilter;
    try {
      const access = await assertCaseAccessWithMemberships(userId, req.params.caseId);
      if (!access.labMembership) {
        throw new HttpError(403, "You do not have access to change this attachment.");
      }
      labOrganizationId = access.case.labOrganizationId;
      canonicalCaseId = access.case.id;
      attachmentCaseFilter = or(
        eq(caseAttachments.caseId, access.case.id),
        eq(caseAttachments.labCaseId, access.case.id),
      );
    } catch (error: any) {
      if (error.statusCode !== 404) throw error;
      const legacyCase = await db.query.labCases.findFirst({
        where: and(eq(labCases.id, req.params.caseId), isNull(labCases.deletedAt)),
      });
      if (!legacyCase?.organizationId) throw new HttpError(404, "Case not found.");
      await requireMembership(userId, legacyCase.organizationId);
      labOrganizationId = legacyCase.organizationId;
      attachmentCaseFilter = eq(caseAttachments.labCaseId, legacyCase.id);
    }

    if (input.visibility !== undefined) {
      await requireAnyRole(userId, labOrganizationId, ADMIN_ROLES);
    }
    const attachment = await db.query.caseAttachments.findFirst({
      where: and(
        eq(caseAttachments.id, req.params.attachmentId),
        attachmentCaseFilter,
        isNull(caseAttachments.deletedAt),
      ),
    });
    if (!attachment) throw new HttpError(404, "Attachment not found.");
    if (input.note !== undefined && attachment.caseExceptionId) {
      throw new HttpError(400, "Exception attachment notes cannot be changed.");
    }

    const updates: Partial<typeof caseAttachments.$inferInsert> = {};

    if (
      input.visibility !== undefined &&
      input.visibility !== attachment.visibility
    ) {
      // Exception evidence is permanently internal. Without this an admin
      // could flip a forced-internal exception photo to shared and hand the
      // provider its file, name and note.
      if (
        attachment.caseExceptionId &&
        input.visibility !== "internal_lab_only"
      ) {
        throw new HttpError(
          400,
          "Exception attachments stay internal to the lab and cannot be shared with the provider.",
        );
      }
      updates.visibility = input.visibility;
    }

    let noteChanged = false;
    if (input.note !== undefined) {
      const normalizedNote =
        input.note != null && input.note.trim() ? input.note.trim() : null;
      if (normalizedNote !== (attachment.note ?? null)) {
        updates.note = normalizedNote;
        noteChanged = true;
      }
    }

    if (Object.keys(updates).length === 0) {
      return ok(res, attachment);
    }

    const [updated] = await db
      .update(caseAttachments)
      .set(updates)
      .where(eq(caseAttachments.id, attachment.id))
      .returning();

    if (updates.visibility !== undefined) {
      await writeAuditLog({
        req,
        organizationId: labOrganizationId,
        action: "case_attachment_visibility_changed",
        entityType: "case_attachment",
        entityId: attachment.id,
        beforeJson: attachment,
        afterJson: updated,
      });
    }

    if (noteChanged) {
      await writeAuditLog({
        req,
        organizationId: labOrganizationId,
        action: "case_attachment_note_changed",
        entityType: "case_attachment",
        entityId: attachment.id,
        beforeJson: attachment,
        afterJson: updated,
      });
    }

    if (canonicalCaseId) broadcastCaseUpdated(canonicalCaseId);
    return ok(res, updated);
  })
);

// Best-effort move of the underlying file backing a case attachment into the
// trash folder (`uploads/case-media/.trash/`) so it can be recovered if the
// deletion was accidental. Uses the same naming convention as the orphan-
// cleanup job: `<iso-stamp>__<filename>`.
async function trashAttachmentFile(
  req: any,
  storageKey: string | null | undefined
): Promise<void> {
  if (!storageKey) return;
  try {
    const fileName = extractMediaFileName(storageKey);
    if (!fileName) return;
    const resolved = path.resolve(caseMediaDir, fileName);
    if (
      resolved === caseMediaDir ||
      !(resolved + path.sep).startsWith(caseMediaDir + path.sep)
    ) {
      return;
    }
    const trashDir = path.resolve(caseMediaDir, ".trash");
    fs.mkdirSync(trashDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const trashedName = `${stamp}__${fileName}`;
    await moveProductionUpload(resolved, path.resolve(trashDir, trashedName), "case-upload");
  } catch (err: any) {
    req.log?.warn?.(
      { err: err?.message || String(err), storageKey },
      "Failed to trash underlying attachment file"
    );
  }
}

const appendRxScanSchema = z.object({
  submissionId: z.string().min(8).max(200),
  notes: z.string().min(1).max(10_000).refine((value) => value.trim().length > 0),
});

router.post(
  "/:caseId/rx-note-scans",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const input = appendRxScanSchema.parse(req.body);
    const access = await assertCaseAccessOrPromote(userId, req.params.caseId);
    await requireMembership(userId, access.labOrganizationId);
    const entry = await db.transaction((tx) =>
      appendRxNoteEntry(tx, {
        caseId: access.id,
        submissionId: input.submissionId,
        noteText: input.notes,
        provenance: "ai_reader",
      }),
    );
    broadcastCaseUpdated(access.id);
    return ok(res, entry);
  }),
);

router.post(
  "/:caseId/attachments",
  asyncHandler(async (req, res) => {
    let found: Awaited<ReturnType<typeof assertCaseAccess>> | null = null;

    try {
      found = await assertCaseAccess(
        (req as any).auth.userId,
        req.params.caseId
      );
    } catch (e: any) {
      if (e.statusCode !== 404) throw e;
    }

    if (!found) {
      // Legacy mobile case — store the attachment with labCaseId instead of
      // caseId. The caseAttachments table now has a nullable labCaseId FK so
      // attachments can be recorded for lab_cases rows without touching caseId.
      const mobileRow = await db.query.labCases.findFirst({
        where: and(
          eq(labCases.id, req.params.caseId),
          isNull(labCases.deletedAt)
        ),
      });
      if (!mobileRow) throw new HttpError(404, "Case not found.");
      if (!mobileRow.organizationId) {
        throw new HttpError(422, "Case has no associated organization.");
      }
      await requireMembership(
        (req as any).auth.userId,
        mobileRow.organizationId
      );

      const legacyInput = z
        .object({
          storageKey: z.string().min(1),
          fileName: z.string().min(1),
          fileType: z.string().default("application/octet-stream"),
          visibility: z
            .enum(["internal_lab_only", "shared_with_provider"] as const)
            .default("internal_lab_only"),
          note: z.string().max(1000).optional(),
          submissionId: z.string().min(8).max(200).optional(),
        category: z.enum(["outgoing", "prescription"] as const).optional(),
          caseExceptionId: z.string().min(1).optional(),
        })
        .parse(req.body);

      const legacyExceptionId = await resolveAttachmentExceptionId(
        legacyInput.caseExceptionId,
        mobileRow.id,
        (req as any).auth.userId,
      );
      const legacyOrganizationId = mobileRow.organizationId;

      const registered = await db.transaction(async (tx) => {
        if (legacyInput.submissionId) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`legacy-case-attachment:${mobileRow.id}:${legacyInput.submissionId}`}))`);
          const existing = await tx.query.caseAttachments.findFirst({
            where: and(eq(caseAttachments.labCaseId, mobileRow.id), eq(caseAttachments.submissionId, legacyInput.submissionId)),
          });
          if (existing) return { attachment: existing, replayed: true };
        }
      const [legacyAttachment] = await tx
        .insert(caseAttachments)
        .values({
          labCaseId: mobileRow.id,
          uploadedByUserId: (req as any).auth.userId,
          uploadedByOrganizationId: legacyOrganizationId,
          fileName: legacyInput.fileName,
          storageKey: legacyInput.storageKey,
          fileType: legacyInput.fileType,
          // Exception evidence is always lab-internal, regardless of what the
          // client asked for.
          visibility: legacyExceptionId
            ? "internal_lab_only"
            : legacyInput.visibility,
          note: legacyInput.note ?? null,
          submissionId: legacyInput.submissionId ?? null,
          category: legacyInput.category ?? null,
          caseExceptionId: legacyExceptionId,
        })
        .onConflictDoNothing()
        .returning();
      if (!legacyAttachment) {
        if (legacyInput.submissionId) {
          const replay = await tx.query.caseAttachments.findFirst({
            where: and(
              eq(caseAttachments.labCaseId, mobileRow.id),
              eq(caseAttachments.submissionId, legacyInput.submissionId),
            ),
          });
          if (replay) return { attachment: replay, replayed: true };
        }
        throw new HttpError(409, "This attachment submission conflicts with an existing file.");
      }
        return { attachment: legacyAttachment, replayed: false };
      });
      const legacyAttachment = registered.attachment;
      if (registered.replayed) {
        await linkPlyTexturesForCase(mobileRow.id);
        return ok(res, legacyAttachment);
      }

      // Register in legacy_case_media ledger so the file-serving route can
      // authorize the download (first-writer-wins, safe to re-insert).
      const legacyFileName = extractMediaFileName(legacyInput.storageKey);
      if (legacyFileName) {
        await db
          .insert(legacyCaseMedia)
          .values({
            fileName: legacyFileName,
            labCaseId: mobileRow.id,
            organizationId: mobileRow.organizationId,
            ownerId: mobileRow.ownerId,
          })
          .onConflictDoNothing();
      }

      // Append an attachment event under the same row lock used by exception
      // history writes so it cannot replace a concurrently added note.
      await mutateLegacyCaseDataWithLock(mobileRow.id, (legacyCaseData) => {
        if (!Array.isArray(legacyCaseData.activityLog)) {
          legacyCaseData.activityLog = [];
        }
        legacyCaseData.activityLog.push({
          id: legacyAttachment.id,
          // Outgoing case photos render as photos (not documents) in the mobile
          // History tab; keep "document" for every other attachment type.
          type: legacyInput.category === "outgoing" ? "photo" : "document",
          timestamp: Date.now(),
          user: (req as any).user?.initials || "",
          description: legacyInput.fileName,
          attachmentId: legacyAttachment.id,
          fileType: legacyInput.fileType,
          imageUri: legacyInput.storageKey,
          ...(legacyInput.category ? { category: legacyInput.category } : {}),
        });
      });

      await linkPlyTexturesForCase(mobileRow.id);

      await writeAuditLog({
        req,
        organizationId: mobileRow.organizationId,
        action: "case_attachment_created",
        entityType: "case_attachment",
        entityId: legacyAttachment.id,
        afterJson: legacyAttachment,
      });

      return ok(res, legacyAttachment, 201);
    }

    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );

    const orgId = found.labOrganizationId;

    const input = z
      .object({
        storageKey: z.string().min(1),
        fileName: z.string().min(1),
        fileType: z.string().default("application/octet-stream"),
        visibility: z
          .enum(["internal_lab_only", "shared_with_provider"] as const)
          .default("internal_lab_only"),
        note: z.string().max(1000).optional(),
        submissionId: z.string().min(8).max(200).optional(),
          category: z.enum(["outgoing", "prescription"] as const).optional(),
        caseExceptionId: z.string().min(1).optional(),
      })
      .parse(req.body);

    const attachmentExceptionId = await resolveAttachmentExceptionId(
      input.caseExceptionId,
      found.id,
      (req as any).auth.userId,
    );

    const registered = await db.transaction(async (tx) => {
      if (input.submissionId) {
        // Serialize retries even on older databases where schema push did not
        // install the submission uniqueness index. Never mint duplicate rows.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`case-attachment:${found.id}:${input.submissionId}`}))`);
        const existing = await tx.query.caseAttachments.findFirst({
          where: and(eq(caseAttachments.caseId, found.id), eq(caseAttachments.submissionId, input.submissionId)),
        });
        if (existing) return { attachment: existing, replayed: true };
      }
    const [attachment] = await tx
      .insert(caseAttachments)
      .values({
        caseId: req.params.caseId,
        uploadedByUserId: (req as any).auth.userId,
        uploadedByOrganizationId: orgId,
        fileName: input.fileName,
        storageKey: input.storageKey,
        fileType: input.fileType,
        // Exception evidence is always lab-internal, regardless of what the
        // client asked for.
        visibility: attachmentExceptionId
          ? "internal_lab_only"
          : input.visibility,
        note: input.note ?? null,
        submissionId: input.submissionId ?? null,
        category: input.category ?? null,
        caseExceptionId: attachmentExceptionId,
      })
      .onConflictDoNothing()
      .returning();
    if (!attachment) {
      if (input.submissionId) {
        const replay = await tx.query.caseAttachments.findFirst({
          where: and(
            eq(caseAttachments.caseId, found.id),
            eq(caseAttachments.submissionId, input.submissionId),
          ),
        });
        if (replay) return { attachment: replay, replayed: true };
      }
      throw new HttpError(409, "This attachment submission conflicts with an existing file.");
    }
      return { attachment, replayed: false };
    });
    const { attachment } = registered;
    if (registered.replayed) {
      await linkPlyTexturesForCase(found.id);
      return ok(res, attachment);
    }

    await linkPlyTexturesForCase(found.id);

    const attachmentActor = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: req.params.caseId,
      eventType: "case_attachment_added",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: orgId,
      actorInitials: attachmentActor?.initials || "SYS",
      // `case_events` is provider-visible. An exception attachment's file name
      // and note are lab-internal evidence, so they are withheld here and live
      // only on the attachment row (forced `internal_lab_only`) and in the
      // lab-gated exception history.
      metadataJson: attachmentExceptionId
        ? {
            attachmentId: attachment.id,
            caseExceptionId: attachmentExceptionId,
            visibility: attachment.visibility,
          }
        : {
            attachmentId: attachment.id,
            fileName: attachment.fileName,
            fileType: attachment.fileType,
            visibility: attachment.visibility,
            ...(attachment.note ? { note: attachment.note } : {}),
            ...(attachment.category ? { category: attachment.category } : {}),
          },
    }).catch((err: unknown): never => wrapDbError(err, {
      fallback: "Failed to record attachment timeline event.",
    }));

    await writeAuditLog({
      req,
      organizationId: orgId,
      action: "case_attachment_created",
      entityType: "case_attachment",
      entityId: attachment.id,
      afterJson: attachment,
    });

    await touchCase(found.id);

    // Auto-notify provider members when a shared attachment is added by the lab.
    // Fire-and-forget — failure must not affect the 201 response.
    if (input.visibility === "shared_with_provider" && found.providerOrganizationId) {
      const labOrg = await db.query.organizations.findFirst({
        where: eq(organizations.id, found.labOrganizationId),
      }).catch(() => null);
      void notifyProviderMembersOfLabActivity(
        found as typeof found & { providerOrganizationId: string },
        "shared_attachment_added",
        (labOrg as any)?.name ?? "Your lab"
      );
    }

    return ok(res, attachment, 201);
  })
);

router.delete(
  "/:caseId/attachments/:attachmentId",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;

    // Try canonical case first; fall through to legacy on 404.
    let canonicalFound: Awaited<ReturnType<typeof assertCaseAccess>> | null = null;
    try {
      canonicalFound = await assertCaseAccess(userId, req.params.caseId);
    } catch (e: any) {
      if (e.statusCode !== 404) throw e;
    }

    if (canonicalFound) {
      await requireMembership(userId, canonicalFound.labOrganizationId);
      const attachment = await db.query.caseAttachments.findFirst({
        where: and(
          eq(caseAttachments.id, req.params.attachmentId),
          eq(caseAttachments.caseId, canonicalFound.id),
          isNull(caseAttachments.deletedAt)
        ),
      });
      if (!attachment) throw new HttpError(404, "Attachment not found.");

      await softDeleteById({
        table: caseAttachments,
        id: attachment.id,
        actorUserId: userId,
        req,
        organizationId: canonicalFound.labOrganizationId,
        entityType: "case_attachment",
        beforeJson: attachment,
      });
      await trashAttachmentFile(req, attachment.storageKey);

      const attachmentDeleter = (req as any).user;
      await db.insert(caseEvents).values({
        caseId: canonicalFound.id,
        eventType: "case_attachment_deleted",
        actorUserId: userId,
        actorOrganizationId: canonicalFound.labOrganizationId,
        actorInitials: attachmentDeleter?.initials || "SYS",
        // An exception attachment's file name is lab-internal, and this event
        // is provider-visible. Carry the exception marker so the response
        // sanitizer can recognise the event after the row is soft-deleted.
        metadataJson: attachment.caseExceptionId
          ? {
              attachmentId: attachment.id,
              caseExceptionId: attachment.caseExceptionId,
            }
          : {
              attachmentId: attachment.id,
              fileName: attachment.fileName,
              fileType: attachment.fileType,
            },
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to record attachment deletion event.",
      }));

    } else {
      // Legacy mobile case — look up attachment by labCaseId, require lab membership.
      const mobileRow = await db.query.labCases.findFirst({
        where: and(eq(labCases.id, req.params.caseId), isNull(labCases.deletedAt)),
      });
      if (!mobileRow) throw new HttpError(404, "Case not found.");
      if (!mobileRow.organizationId) throw new HttpError(422, "Case has no associated organization.");
      await requireMembership(userId, mobileRow.organizationId);

      const attachment = await db.query.caseAttachments.findFirst({
        where: and(
          eq(caseAttachments.id, req.params.attachmentId),
          eq(caseAttachments.labCaseId, mobileRow.id),
          isNull(caseAttachments.deletedAt)
        ),
      });
      if (!attachment) throw new HttpError(404, "Attachment not found.");

      await softDeleteById({
        table: caseAttachments,
        id: attachment.id,
        actorUserId: userId,
        req,
        organizationId: mobileRow.organizationId,
        entityType: "case_attachment",
        beforeJson: attachment,
      });
      await trashAttachmentFile(req, attachment.storageKey);
    }

    broadcastCaseUpdated(canonicalFound ? canonicalFound.id : req.params.caseId);
    return ok(res, { deleted: true });
  })
);

const updateCaseSchema = z.object({
  status: z
    .enum([
      "received",
      "in_design",
      "scan",
      "in_milling",
      "post_mill",
      "sintering_furnace",
      "model_room",
      "in_porcelain",
      "qc",
      "complete",
      "shipped",
      "delivered",
      "on_hold",
      "remake",
      "cancelled",
    ])
    .optional(),
  priority: z.enum(["normal", "rush"]).optional(),
  receivedAt: calendarDate.optional(),
  dueDate: z.union([z.string(), z.null()]).optional(),
  dueTime: z
    .union([z.string().refine(isValidDueTime, "Invalid due time"), z.null()])
    .optional(),
  doctorName: z.string().optional(),
  patientFirstName: z.string().optional(),
  patientLastName: z.string().optional(),
  /** Pass null or "" to unlink the current practice from the case. */
  providerOrganizationId: z.union([z.string(), z.null()]).optional(),
  /** When true, clears suggestedDoctorName + suggestedProviderOrgId on the case. */
  clearSuggestion: z.boolean().optional(),
  /**
   * Marks the source of a providerOrganizationId change so the audit log can
   * distinguish AI-suggestion accepts from manual edits. Used by the desktop
   * batch importer, the desktop case drawer "Use this doctor" button, and
   * the mobile case detail "Use suggestion" / auto-fill flow. Defaults to
   * "manual" when omitted.
   */
  providerLinkSource: z.enum(["ai_suggestion", "manual"]).optional(),
  bridgeConnectors: z.string().optional(),
  expectedDeliveryDate: z.union([z.string(), z.null()]).optional(),
  clearDeliveryDateProposal: z.boolean().optional(),
  casePanBarcode: z
    .union([z.string(), z.null()])
    .transform((v) => (v === null ? null : v.trim()))
    .optional(),
  rxNotes: z.union([z.string(), z.null()]).optional(),
  /**
   * New case number for the case. Admin/owner only. Must be non-empty and
   * unique across all cases (cases_case_number_unique index enforces this).
   * Returns 409 if the number is already in use.
   */
  caseNumber: z.string().min(1, "Case number cannot be blank.").optional(),
  // ── Structured remake fields — allow admin/owner corrections after creation ─
  remakeReasonKey: z.enum(REMAKE_REASON_KEYS).optional(),
  remakeReason: z.string().max(2000).optional(),
  remakeCharged: z.boolean().optional().nullable(),
  remakeShadeLightness: z.enum(["light", "dark"]).optional().nullable(),
  remakeShadePrescribed: z.string().optional().nullable(),
  remakeShadeProvided: z.string().optional().nullable(),
  remakeMaterialPrescribed: z.string().optional().nullable(),
  remakeMaterialProvided: z.string().optional().nullable(),
  remakeReturnedToLab: z.boolean().optional().nullable(),
  remakeCategory: z.enum(["crown_bridge", "removable"]).optional().nullable(),
  /** Lab workflow step for removable cases. */
  step: z
    .enum(["custom_tray", "rims_and_plates", "wax_setup", "process"])
    .nullable()
    .optional(),
  /** Shade for wax_setup step. Cleared server-side when step !== 'wax_setup'. */
  stepShade: z.string().max(200).nullable().optional(),
  /** Gingival/base tissue shade for removable cases (AI-extracted; correctable by lab staff). */
  gingivialShade: z.string().max(200).nullable().optional(),
  /**
   * The specific lab_locations row id where the case is physically located.
   * Written alongside `status` when a locate action is performed so the
   * station name is authoritative across all platforms. Null clears the
   * stored station without changing status.
   */
  labLocationId: z.string().nullable().optional(),
  // ── Custom-shade tracking fields (Task #3631) ────────────────────────────
  /** When true, the shade was taken by a technician (not a standard guide). */
  isCustomShade: z.boolean().nullable().optional(),
  /** Name of the technician who recorded the custom shade. */
  customShadeTechnician: z.string().max(500).nullable().optional(),
  /** Whether photos of the custom shade are available. */
  customShadePicturesAvailable: z.boolean().nullable().optional(),
  /** Whether a video of the custom shade is available. */
  customShadeVideoAvailable: z.boolean().nullable().optional(),
});

router.patch(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const input = updateCaseSchema.parse(req.body);
    validateCustomRemakeReason(input.remakeReasonKey, input.remakeReason);
    if (input.remakeReasonKey === "other" && input.remakeReason !== undefined) {
      input.remakeReason = input.remakeReason.trim();
    }

    // Try the canonical cases table first. If not found, fall back to the
    // mobile lab_cases table so desktop users can locate mobile-originated cases.
    let found: any = null;
    try {
      found = await assertCaseAccess(
        (req as any).auth.userId,
        req.params.caseId
      );
    } catch (e: any) {
      if (e.statusCode !== 404) throw e;
    }

    if (!found) {
      // Mobile case path: look up the lab_cases row and update its JSON blob.
      const mobileRow = await db.query.labCases.findFirst({
        where: and(
          eq(labCases.id, req.params.caseId),
          isNull(labCases.deletedAt)
        ),
      });
      if (!mobileRow) throw new HttpError(404, "Case not found.");
      if (input.receivedAt !== undefined) {
        throw new HttpError(
          400,
          "Date received can only be edited after this legacy case is promoted.",
        );
      }

      let mobileMembership: Awaited<ReturnType<typeof requireMembership>> | null = null;
      if (mobileRow.organizationId) {
        mobileMembership = await requireMembership(
          (req as any).auth.userId,
          mobileRow.organizationId
        );
      }

      let effectiveLegacyStatus = input.status;
      if (input.labLocationId !== undefined && input.labLocationId !== null && mobileRow.organizationId) {
        const locRow = await db.query.labLocations.findFirst({
          where: and(
            eq(labLocations.id, input.labLocationId),
            eq(labLocations.labOrganizationId, mobileRow.organizationId)
          ),
        });
        effectiveLegacyStatus = resolveLocatedCaseStatus({
          labOrganizationId: mobileRow.organizationId,
          labLocationId: input.labLocationId,
          location: locRow,
        });
      }
      // Step/stepShade are admin/owner only — enforce the same role guard as
      // the canonical branch before touching these fields.
      if (
        (input.step !== undefined || input.stepShade !== undefined) &&
        mobileMembership &&
        !ADMIN_ROLES.includes(mobileMembership.role as any)
      ) {
        throw new HttpError(403, "Only admin or owner members can update the case step.");
      }

      const hasLegacyMutation =
        input.status !== undefined ||
        input.casePanBarcode !== undefined ||
        input.doctorName !== undefined ||
        input.patientFirstName !== undefined ||
        input.patientLastName !== undefined ||
        input.priority !== undefined ||
        input.dueDate !== undefined ||
        input.step !== undefined ||
        input.stepShade !== undefined ||
        input.labLocationId !== undefined ||
        input.isCustomShade !== undefined ||
        input.customShadeTechnician !== undefined ||
        input.customShadePicturesAvailable !== undefined ||
        input.customShadeVideoAvailable !== undefined;
      let responseData: Record<string, any> = {};

      if (hasLegacyMutation) {
        const canonicalRaceUpdates: Record<string, unknown> = {
          updatedAt: new Date(),
        };
        if (input.labLocationId !== undefined) {
          canonicalRaceUpdates.labLocationId = input.labLocationId;
        }
        await updateLegacyCaseWithLocationHistory({
          caseId: mobileRow.id,
          labOrganizationId: mobileRow.organizationId ?? "",
          labLocationId: input.labLocationId,
          actorUserId: (req as any).auth.userId,
          actorInitials: (req as any).user?.initials || "SYS",
          mutate: async (parsed, tx) => {
            if (
              input.labLocationId !== undefined &&
              input.labLocationId !== null &&
              mobileRow.organizationId
            ) {
              const currentLocation = await tx.query.labLocations.findFirst({
                where: and(
                  eq(labLocations.id, input.labLocationId),
                  eq(labLocations.labOrganizationId, mobileRow.organizationId),
                ),
              });
              effectiveLegacyStatus = resolveLocatedCaseStatus({
                labOrganizationId: mobileRow.organizationId,
                labLocationId: input.labLocationId,
                location: currentLocation,
              });
            }
            if (effectiveLegacyStatus !== undefined) {
              canonicalRaceUpdates.status = effectiveLegacyStatus;
              if (effectiveLegacyStatus === "complete") {
                canonicalRaceUpdates.casePanBarcode = null;
              }
            }

          if (effectiveLegacyStatus !== undefined) {
            parsed.status = canonicalStatusToLegacy(effectiveLegacyStatus);
            if (effectiveLegacyStatus === "complete") {
              parsed.assignedBarcode = null;
            }
          }
          if (input.casePanBarcode !== undefined) {
            parsed.assignedBarcode =
              effectiveLegacyStatus === "complete" ? null : input.casePanBarcode;
          }
          if (input.doctorName !== undefined) {
            parsed.doctorName = input.doctorName;
          }
          if (input.patientFirstName !== undefined || input.patientLastName !== undefined) {
            const existingName = String(parsed.patientName ?? "");
            const spaceIdx = existingName.indexOf(" ");
            const existingFirst = spaceIdx >= 0 ? existingName.slice(0, spaceIdx) : existingName;
            const existingLast = spaceIdx >= 0 ? existingName.slice(spaceIdx + 1) : "";
            const newFirst = input.patientFirstName !== undefined ? input.patientFirstName : existingFirst;
            const newLast = input.patientLastName !== undefined ? input.patientLastName : existingLast;
            parsed.patientName = newLast ? `${newFirst} ${newLast}` : newFirst;
          }
          if (input.priority !== undefined) {
            parsed.isRush = input.priority === "rush";
          }
          if (input.dueDate !== undefined) {
            parsed.dueDate = input.dueDate;
          }
          if (input.step !== undefined) {
            parsed.step = input.step ?? null;
            if (input.step !== "wax_setup") {
              parsed.stepShade = null;
            }
          }
          if (input.stepShade !== undefined) {
            const effectiveStep = input.step !== undefined ? input.step : (parsed.step ?? null);
            parsed.stepShade = effectiveStep === "wax_setup" ? (input.stepShade ?? null) : null;
          }
          if (input.labLocationId !== undefined) {
            parsed.labLocationId = input.labLocationId ?? null;
          } else if (
            effectiveLegacyStatus !== undefined &&
            typeof parsed.labLocationId === "string"
          ) {
            const currentLocation = mobileRow.organizationId
              ? await tx.query.labLocations.findFirst({
                  where: and(
                    eq(labLocations.id, parsed.labLocationId),
                    eq(labLocations.labOrganizationId, mobileRow.organizationId),
                  ),
                })
              : null;
            if (currentLocation?.status !== effectiveLegacyStatus) {
              parsed.labLocationId = null;
            }
          }

          // Apply custom-shade sub-fields, then clear them whenever the
          // effective flag is false.
          const touchedCustomShade =
            input.isCustomShade !== undefined ||
            input.customShadeTechnician !== undefined ||
            input.customShadePicturesAvailable !== undefined ||
            input.customShadeVideoAvailable !== undefined;
          if (input.isCustomShade !== undefined) {
            parsed.isCustomShade = input.isCustomShade ?? false;
          }
          if (input.customShadeTechnician !== undefined) {
            parsed.customShadeTechnician = input.customShadeTechnician ?? null;
          }
          if (input.customShadePicturesAvailable !== undefined) {
            parsed.customShadePicturesAvailable = input.customShadePicturesAvailable ?? false;
          }
          if (input.customShadeVideoAvailable !== undefined) {
            parsed.customShadeVideoAvailable = input.customShadeVideoAvailable ?? false;
          }
          if (touchedCustomShade && parsed.isCustomShade !== true) {
            parsed.customShadeTechnician = null;
            parsed.customShadePicturesAvailable = false;
            parsed.customShadeVideoAvailable = false;
          }
            responseData = parsed;
          },
          canonicalUpdates: canonicalRaceUpdates,
          recordCanonicalStatusChanges: true,
        });
      } else {
        try {
          const parsed = JSON.parse(mobileRow.caseData);
          if (parsed && typeof parsed === "object") responseData = parsed;
        } catch {
          // Keep the current response behavior for malformed historical blobs.
        }
      }
      return ok(res, {
        id: mobileRow.id,
        status:
          effectiveLegacyStatus === undefined
            ? legacyStatusToCanonical(responseData.status)
            : effectiveLegacyStatus,
        casePanBarcode: responseData.assignedBarcode ?? null,
        _source: "mobile",
      });
    }

    // Canonical cases table path.
    const membership = await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );

    const updates: any = {};

    // Case number changes are admin/owner only.
    if (input.caseNumber !== undefined) {
      if (!ADMIN_ROLES.includes(membership.role as any)) {
        throw new HttpError(403, "Only admin or owner members can change the case number.");
      }
      const trimmed = input.caseNumber.trim();
      if (!trimmed) throw new HttpError(400, "Case number cannot be blank.");
      if (trimmed !== found.caseNumber) {
        const existing = await db.query.cases.findFirst({
          where: and(eq(cases.caseNumber, trimmed), notDeleted(cases)),
        });
        if (existing) {
          throw new HttpError(409, `Case number "${trimmed}" is already in use.`);
        }
        updates.caseNumber = trimmed;
      }
    }

    let effectiveCanonicalStatus = input.status;
    if (input.status !== undefined && input.labLocationId === undefined) {
      updates.labLocationId = sql`case
        when ${cases.labLocationId} is null then null
        when exists (
          select 1 from ${labLocations}
          where ${labLocations.id} = ${cases.labLocationId}
            and ${labLocations.labOrganizationId} = ${found.labOrganizationId}
            and ${labLocations.status} = ${input.status}
        ) then ${cases.labLocationId}
        else null
      end`;
    }
    if (input.labLocationId !== undefined) {
      // Validate the location belongs to this lab before persisting.
      if (input.labLocationId !== null) {
        const locRow = await db.query.labLocations.findFirst({
          where: and(
            eq(labLocations.id, input.labLocationId),
            eq(labLocations.labOrganizationId, found.labOrganizationId)
          ),
        });
        effectiveCanonicalStatus = resolveLocatedCaseStatus({
          labOrganizationId: found.labOrganizationId,
          labLocationId: input.labLocationId,
          location: locRow,
        });
      }
      updates.labLocationId = input.labLocationId;
    }
    if (effectiveCanonicalStatus !== undefined) updates.status = effectiveCanonicalStatus;
    // When locating to Complete, free the pan barcode atomically.
    if (effectiveCanonicalStatus === "complete") updates.casePanBarcode = null;
    if (input.priority !== undefined) updates.priority = input.priority;
    if (input.receivedAt !== undefined) {
      updates.receivedAt = parseCalendarDate(input.receivedAt);
    }
    if (input.dueDate !== undefined) {
      updates.dueDate = input.dueDate === null ? null : new Date(input.dueDate);
      updates.dueTime =
        input.dueDate === null
          ? null
          : input.dueTime !== undefined
            ? input.dueTime
            : found.dueTime;
      updates.expectedDeliveryDate = null;
    } else if (input.dueTime !== undefined) {
      if (input.dueTime !== null && !found.dueDate) {
        throw new HttpError(400, "Cannot set a due time without a due date.");
      }
      updates.dueTime = input.dueTime;
    }
    if (input.doctorName !== undefined) updates.doctorName = input.doctorName;
    if (input.patientFirstName !== undefined)
      updates.patientFirstName = input.patientFirstName;
    if (input.patientLastName !== undefined)
      updates.patientLastName = input.patientLastName;
    if (input.providerOrganizationId !== undefined) {
      // null or empty string means "unlink the practice from this case"
      if (input.providerOrganizationId === null || input.providerOrganizationId === "") {
        updates.providerOrganizationId = null;
      } else {
        // Validate that the requested provider org exists, is not deleted, and
        // belongs to the same lab as the case. This prevents a lab member from
        // re-pointing a case to an unrelated provider org via a crafted payload.
        const targetOrg = await db.query.organizations.findFirst({
          where: and(
            eq(organizations.id, input.providerOrganizationId),
            isNull(organizations.deletedAt)
          ),
        });
        if (
          !targetOrg ||
          targetOrg.type !== "provider" ||
          targetOrg.parentLabOrganizationId !== found.labOrganizationId
        ) {
          throw new HttpError(
            400,
            "providerOrganizationId must be an active provider organization belonging to this lab."
          );
        }
        updates.providerOrganizationId = input.providerOrganizationId;
      }
    }
    if (input.clearSuggestion) {
      updates.suggestedDoctorName = null;
      updates.suggestedProviderOrgId = null;
    }
    if (input.bridgeConnectors !== undefined) {
      const restorationsForConnectors = await db.query.caseRestorations.findMany({
        where: eq(caseRestorations.caseId, found.id),
      });
      const connectorValue = normalizeLegacyDesktopConnectorEcho(
        found.bridgeConnectors,
        input.bridgeConnectors,
      );
      const validation = validateToothConnectors(
        connectorValue,
        restorationsForConnectors,
      );
      const priorErrors = new Set(validateToothConnectors(found.bridgeConnectors, restorationsForConnectors).errors);
      const newErrors = validation.errors.filter((error) => !priorErrors.has(error));
      if (newErrors.length) {
        throw new HttpError(
          400,
          `Cannot save tooth connectors: ${newErrors.join(" ")}`,
        );
      }
      updates.bridgeConnectors = connectorValue || null;
    }
    if (input.casePanBarcode !== undefined) {
      // Non-empty barcode being set or changed — enforce strict uniqueness
      // across active cases in the lab. The cases_barcode_unique_per_lab
      // partial index is the atomic guard; this pre-check is a fast-path that
      // names the conflicting case for a friendlier error.
      const newBarcode = input.casePanBarcode || null;
      if (newBarcode && newBarcode !== found.casePanBarcode) {
        await checkBarcodeUniqueness(newBarcode, found.labOrganizationId, found.id);
      }
      updates.casePanBarcode = newBarcode;
    }
    // A Complete locate/status is authoritative over a contradictory barcode
    // field included in the same PATCH.
    if (effectiveCanonicalStatus === "complete") updates.casePanBarcode = null;
    // Skip expectedDeliveryDate from input when dueDate is also being set —
    // an explicit due-date edit must always clear the auto-calculated field.
    if (input.dueDate === undefined && input.expectedDeliveryDate !== undefined)
      updates.expectedDeliveryDate = input.expectedDeliveryDate
        ? new Date(input.expectedDeliveryDate)
        : null;
    if (input.clearDeliveryDateProposal) {
      updates.deliveryDateProposalDate = null;
      updates.deliveryDateProposalNote = null;
    }

    // ── Custom-shade tracking fields (Task #3631) ────────────────────────────
    const touchedCanonicalCustomShade =
      input.isCustomShade !== undefined ||
      input.customShadeTechnician !== undefined ||
      input.customShadePicturesAvailable !== undefined ||
      input.customShadeVideoAvailable !== undefined;
    if (input.isCustomShade !== undefined)
      updates.isCustomShade = input.isCustomShade ?? false;
    // Sub-fields: process from the payload first …
    if (input.customShadeTechnician !== undefined)
      updates.customShadeTechnician = input.customShadeTechnician ?? null;
    if (input.customShadePicturesAvailable !== undefined)
      updates.customShadePicturesAvailable = input.customShadePicturesAvailable ?? false;
    if (input.customShadeVideoAvailable !== undefined)
      updates.customShadeVideoAvailable = input.customShadeVideoAvailable ?? false;
    // … then enforce the gating invariant. The effective flag after this PATCH
    // is: the input value (null→false) when the caller supplied it, otherwise
    // the existing DB value. Whenever any custom-shade field was touched and
    // the effective flag is not strictly true, sub-fields must be cleared —
    // this prevents a stale/racing sub-field PATCH from persisting data on a
    // case whose flag is already false, and keeps canonical & legacy paths
    // consistent.
    if (touchedCanonicalCustomShade) {
      const effectiveFlag =
        input.isCustomShade !== undefined
          ? (input.isCustomShade ?? false)
          : (found.isCustomShade ?? false);
      if (effectiveFlag !== true) {
        updates.customShadeTechnician = null;
        updates.customShadePicturesAvailable = false;
        updates.customShadeVideoAvailable = false;
      }
    }

    // ── Step / wax-setup shade fields (admin/owner only) ─────────────────────
    const hasStepUpdate = input.step !== undefined || input.stepShade !== undefined;
    if (hasStepUpdate && !ADMIN_ROLES.includes(membership.role as any)) {
      throw new HttpError(403, "Only admin or owner members can update the case step.");
    }
    if (input.step !== undefined) {
      updates.step = input.step ?? null;
      // Server-side invariant: stepShade is only valid for wax_setup.
      // Whenever step changes away from wax_setup (or is cleared), wipe shade.
      if (input.step !== "wax_setup") {
        updates.stepShade = null;
      }
    }
    if (input.stepShade !== undefined) {
      // Only persist a stepShade value when the resulting step is wax_setup.
      const effectiveStep =
        input.step !== undefined ? input.step : (found.step ?? null);
      if (effectiveStep === "wax_setup") {
        updates.stepShade = input.stepShade ?? null;
      } else {
        updates.stepShade = null;
      }
    }
    if (input.gingivialShade !== undefined) {
      updates.gingivialShade = input.gingivialShade?.trim() || null;
    }

    // ── Structured remake fields (admin/owner corrections only) ──────────────
    const hasRemakeFieldUpdate =
      input.remakeReasonKey !== undefined ||
      input.remakeReason !== undefined ||
      input.remakeCharged !== undefined ||
      input.remakeShadeLightness !== undefined ||
      input.remakeShadePrescribed !== undefined ||
      input.remakeShadeProvided !== undefined ||
      input.remakeMaterialPrescribed !== undefined ||
      input.remakeMaterialProvided !== undefined ||
      input.remakeReturnedToLab !== undefined ||
      input.remakeCategory !== undefined;
    if (hasRemakeFieldUpdate) {
      if (!ADMIN_ROLES.includes(membership.role as any)) {
        throw new HttpError(
          403,
          "Only admin or owner members can update remake reason details."
        );
      }
      if (input.remakeReasonKey !== undefined)
        updates.remakeReasonKey = input.remakeReasonKey ?? null;
      if (input.remakeReason !== undefined)
        updates.remakeReason = input.remakeReason ?? null;
      if (input.remakeCharged !== undefined)
        updates.remakeCharged = input.remakeCharged ?? null;
      if (input.remakeShadeLightness !== undefined)
        updates.remakeShadeLightness = input.remakeShadeLightness ?? null;
      if (input.remakeShadePrescribed !== undefined)
        updates.remakeShadePrescribed = input.remakeShadePrescribed ?? null;
      if (input.remakeShadeProvided !== undefined)
        updates.remakeShadeProvided = input.remakeShadeProvided ?? null;
      if (input.remakeMaterialPrescribed !== undefined)
        updates.remakeMaterialPrescribed = input.remakeMaterialPrescribed ?? null;
      if (input.remakeMaterialProvided !== undefined)
        updates.remakeMaterialProvided = input.remakeMaterialProvided ?? null;
      if (input.remakeReturnedToLab !== undefined)
        updates.remakeReturnedToLab = input.remakeReturnedToLab ?? null;
      if (input.remakeCategory !== undefined)
        updates.remakeCategory = input.remakeCategory ?? null;
      // Auto-infer category when a key update omits an explicit category.
      if (input.remakeReasonKey !== undefined && input.remakeCategory === undefined) {
        const inferred = inferRemakeCategory(input.remakeReasonKey);
        if (inferred) updates.remakeCategory = inferred;
      }
    }

    // Always bump updatedAt so Recent Cases ordering reflects the latest edit.
    updates.updatedAt = new Date();

    // Test-only TOCTOU barrier: lets concurrent requests that both cleared the
    // pre-check rendezvous here before either write reaches the DB, making the
    // unique-index race deterministic in tests. No-op in production (undefined).
    if (updates.casePanBarcode !== undefined && _testHooks.barcodeWriteHook) {
      await _testHooks.barcodeWriteHook();
    }
    let updated: typeof cases.$inferSelect | undefined;
    try {
      updated = await db.transaction(async (tx) => {
        await acquireCaseLocationStatusLock(tx);
        if (input.bridgeConnectors !== undefined) {
          const [locked] = await tx.select({ id: cases.id, bridgeConnectors: cases.bridgeConnectors }).from(cases).where(eq(cases.id, found.id)).for("update");
          const units = await tx.select().from(caseRestorations).where(eq(caseRestorations.caseId, found.id));
          const connectorValue = normalizeLegacyDesktopConnectorEcho(
            locked?.bridgeConnectors,
            input.bridgeConnectors,
          );
          const validation = validateToothConnectors(connectorValue, units);
          const previousErrors = new Set(validateToothConnectors(locked?.bridgeConnectors, units).errors);
          const newErrors = validation.errors.filter((error) => !previousErrors.has(error));
          if (newErrors.length) throw new HttpError(400, `Cannot save tooth connectors: ${newErrors.join(" ")}`);
          updates.bridgeConnectors = connectorValue || null;
        }
        if (input.rxNotes !== undefined) {
          await saveActiveRxNote(tx, found.id, input.rxNotes ?? null);
        }
        if (input.labLocationId !== undefined && input.labLocationId !== null) {
          const [currentLocation] = await tx
            .select()
            .from(labLocations)
            .where(
              and(
                eq(labLocations.id, input.labLocationId),
                eq(labLocations.labOrganizationId, found.labOrganizationId),
              ),
            )
            .for("update");
          effectiveCanonicalStatus = resolveLocatedCaseStatus({
            labOrganizationId: found.labOrganizationId,
            labLocationId: input.labLocationId,
            location: currentLocation,
          });
          updates.status = effectiveCanonicalStatus;
          if (effectiveCanonicalStatus === "complete") updates.casePanBarcode = null;
        }
         const [row] = await updateCanonicalCasesWithLocationHistory({
           caseIds: [found.id],
           labOrganizationId: found.labOrganizationId,
           updates,
           labLocationId: input.labLocationId,
           actorUserId: (req as any).auth.userId,
           actorInitials: (req as any).user?.initials || "SYS",
           recordStatusChanges: true,
           dbOrTx: tx,
         });
        if (input.receivedAt !== undefined && updates.receivedAt) {
          const synchronizedInvoices = await tx
            .select({
              id: invoices.id,
              invoiceNumber: invoices.invoiceNumber,
              previousIssuedAt: invoices.issuedAt,
            })
            .from(invoices)
            .where(
              and(
                eq(invoices.caseId, found.id),
                isNull(invoices.deletedAt),
              ),
            )
            .for("update");

          if (synchronizedInvoices.length > 0) {
            await tx
              .update(invoices)
              .set({
                issuedAt: calendarDateToUtcNoon(updates.receivedAt),
                updatedByUserId: (req as any).auth.userId,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(invoices.caseId, found.id),
                  isNull(invoices.deletedAt),
                ),
              );

            const user = (req as any).user;
            await tx.insert(caseEvents).values(
              synchronizedInvoices.map((invoice) => ({
                caseId: found.id,
                eventType: "invoice_updated",
                actorUserId: (req as any).auth.userId,
                actorOrganizationId: found.labOrganizationId,
                actorInitials: user?.initials || "SYS",
                metadataJson: {
                  invoiceId: invoice.id,
                  invoiceNumber: invoice.invoiceNumber,
                  reason: "case_received_date_changed",
                  previousIssuedAt:
                    invoice.previousIssuedAt?.toISOString() ?? null,
                  issuedAt: calendarDateToUtcNoon(updates.receivedAt).toISOString(),
                },
              })),
            );
          }
        }
        return row;
      });
    } catch (err) {
      // The cases_barcode_unique_per_lab partial index atomically closes the
      // race between the checkBarcodeUniqueness pre-check above and this UPDATE.
      // Translate its 23505 into the same 409 the pre-check returns; re-throw
      // anything else.
      rethrowBarcodeConflict(err, (updates.casePanBarcode as string | null) ?? "");
    }

    // ── Step change event ────────────────────────────────────────────────────
    if (input.step !== undefined && input.step !== (found.step ?? null)) {
      const user = (req as any).user;
      await db.insert(caseEvents).values({
        caseId: found.id,
        eventType: "step_changed",
        actorUserId: (req as any).auth.userId,
        actorOrganizationId: found.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          fromStep: found.step ?? null,
          toStep: input.step ?? null,
        },
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to record step change event.",
      }));
    }

    // ── Wax-setup shade change event ─────────────────────────────────────────
    {
      const newShade = updates.stepShade !== undefined ? updates.stepShade : undefined;
      const oldShade = found.stepShade ?? null;
      if (newShade !== undefined && newShade !== oldShade) {
        const user = (req as any).user;
        await db.insert(caseEvents).values({
          caseId: found.id,
          eventType: "step_shade_changed",
          actorUserId: (req as any).auth.userId,
          actorOrganizationId: found.labOrganizationId,
          actorInitials: user?.initials || "SYS",
          metadataJson: {
            fromShade: oldShade,
            toShade: newShade,
          },
        }).catch((err: unknown): never => wrapDbError(err, {
          fallback: "Failed to record step shade change event.",
        }));
      }
    }

    if (updates.caseNumber && updates.caseNumber !== found.caseNumber) {
      const user = (req as any).user;
      await db.insert(caseEvents).values({
        caseId: found.id,
        eventType: "case_number_changed",
        actorUserId: (req as any).auth.userId,
        actorOrganizationId: found.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          fromCaseNumber: found.caseNumber,
          toCaseNumber: updates.caseNumber,
        },
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to record case number change event.",
      }));
    }

    // When a provider org change is marked as originating from an AI
    // suggestion (mobile auto-fill, mobile "Use suggestion", desktop "Use
    // this doctor", or desktop batch importer accept), emit a distinct
    // case event + audit-log action so reverts are easy to find later.
    const aiAutoLinkedProvider =
      input.providerLinkSource === "ai_suggestion" &&
      input.providerOrganizationId !== undefined &&
      input.providerOrganizationId !== null &&
      input.providerOrganizationId !== "" &&
      input.providerOrganizationId !== found.providerOrganizationId;
    if (aiAutoLinkedProvider) {
      const user = (req as any).user;
      await db.insert(caseEvents).values({
        caseId: found.id,
        eventType: "provider_auto_linked_from_ai",
        actorUserId: (req as any).auth.userId,
        actorOrganizationId: found.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          fromProviderOrgId: found.providerOrganizationId,
          toProviderOrgId: input.providerOrganizationId,
          suggestedProviderOrgId: found.suggestedProviderOrgId,
          suggestedPracticeName: (found as any).suggestedPracticeName ?? null,
        },
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to record provider auto-link event.",
      }));
    }

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: aiAutoLinkedProvider
        ? "case_provider_auto_linked_from_ai"
        : "case_updated",
      entityType: "case",
      entityId: found.id,
      beforeJson: found,
      afterJson: updated,
      metadataJson: aiAutoLinkedProvider
        ? {
            providerLinkSource: "ai_suggestion",
            fromProviderOrgId: found.providerOrganizationId,
            toProviderOrgId: input.providerOrganizationId,
          }
        : undefined,
    });

    // Topology changes affect descriptions/grouping, never the clinical role,
    // material, or catalog rate of an already-priced unit.
    if (input.bridgeConnectors !== undefined) {
      await syncInvoiceFromRestorations({
        caseId: found.id,
        actorUserId: (req as any).auth.userId,
      });
    }

    // Broadcast last, after every case_events/audit-log write above has
    // completed. Pushing earlier let a mobile client refetch the new case
    // fields (e.g. status) while the accompanying timeline event was not
    // yet committed, so the case detail screen briefly showed a new status
    // with a stale timeline until the next poll caught up.
    broadcastCaseUpdated(found.id);

    return ok(res, updated);
  })
);

const deliveryDateRequestSchema = z.object({
  proposedDate: z.string(),
  note: z.string().max(500).optional(),
});

router.post(
  "/:caseId/delivery-date-request",
  asyncHandler(async (req, res) => {
    const input = deliveryDateRequestSchema.parse(req.body);

    const access = await assertCaseAccessWithMemberships(
      (req as any).auth.userId,
      req.params.caseId
    );
    const found = access.case;

    if (!access.providerMembership) {
      throw new HttpError(403, "Only provider members can request a delivery date change.");
    }

    const proposalDate = input.proposedDate ? new Date(input.proposedDate) : null;

    const [updated] = await db
      .update(cases)
      .set({
        deliveryDateProposalDate: proposalDate,
        deliveryDateProposalNote: input.note ?? null,
        updatedAt: new Date(),
      })
      .where(eq(cases.id, found.id))
      .returning();
    broadcastCaseUpdated(found.id);

    try {
      const adminMembers = await db
        .select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.labId, found.labOrganizationId),
            eq(organizationMemberships.status, "active"),
            inArray(organizationMemberships.role, ["owner", "admin"])
          )
        );

      if (adminMembers.length > 0) {
        const dateStr = proposalDate ? formatNumericDate(proposalDate) : null;
        const patientName = `${found.patientFirstName} ${found.patientLastName}`.trim();
        await deliverInAppNotification({
          labOrganizationId: found.labOrganizationId,
          recipientUserIds: adminMembers.map((member) => member.userId),
          category: "doctor_practice_message",
          type: "delivery_date_request",
          title: "Delivery Date Change Requested",
          body: dateStr
            ? `Provider requested ${dateStr} for ${patientName} (Case ${found.caseNumber})`
            : `Provider requested a delivery date change for ${patientName} (Case ${found.caseNumber})`,
          dataJson: { caseId: found.id, caseNumber: found.caseNumber },
        });
      }
    } catch {
      // Best-effort — do not fail the response if notification insert fails.
    }

    return ok(res, updated);
  })
);

router.delete(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    // delete_cases capability: owners and admins pass implicitly; non-admin
    // team members may also delete if they hold an explicit capability grant.
    await requireCapability(
      (req as any).auth.userId,
      found.labOrganizationId,
      "delete_cases"
    );

    const deletingUserId = (req as any).auth.userId as string;

    await db.transaction(async (tx) => {
      await softDeleteById({
        table: cases,
        id: found.id,
        actorUserId: deletingUserId,
        req,
        organizationId: found.labOrganizationId,
        entityType: "case",
        beforeJson: found,
        metadataJson: {
          caseNumber: found.caseNumber,
          patientName: [found.patientFirstName, found.patientLastName].filter(Boolean).join(" "),
        },
        tx,
      });

      // Keep the case deletion, invoice freeze, and both audit trails atomic.
      await freezeInvoicesForDeletedCases({
        req,
        caseIds: [found.id],
        labOrganizationId: found.labOrganizationId,
        deletingUserId,
        caseNumberById: new Map([[found.id, found.caseNumber]]),
        tx,
      });
    });

    broadcastCaseUpdated(found.id, "deleted");
    return ok(res, { deleted: true });
  })
);

router.post(
  "/bulk-restore",
  asyncHandler(async (req, res) => {
    const restoringUserId = (req as any).auth.userId as string;

    const { caseIds, labOrganizationId } = z
      .object({
        caseIds: z.array(z.string().min(1)).min(1).max(200),
        labOrganizationId: z.string().min(1),
      })
      .parse(req.body);

    await requireAnyRole(restoringUserId, labOrganizationId, ADMIN_ROLES);

    const restored: string[] = [];
    const failed: { id: string; reason: string }[] = [];

    for (const caseId of caseIds) {
      try {
        const found = await db.query.cases.findFirst({
          where: eq(cases.id, caseId),
        });
        if (!found) {
          failed.push({ id: caseId, reason: "Case not found." });
          continue;
        }
        if (found.labOrganizationId !== labOrganizationId) {
          failed.push({ id: caseId, reason: "Case does not belong to this lab." });
          continue;
        }
        if (!found.deletedAt) {
          failed.push({ id: caseId, reason: "Case is not deleted." });
          continue;
        }

        await restoreDeleted({
          table: cases,
          where: eq(cases.id, found.id),
          actorUserId: restoringUserId,
          req,
          organizationId: found.labOrganizationId,
          entityType: "case",
          entityId: found.id,
        });

        const frozenInvoices = await db
          .select()
          .from(invoices)
          .where(
            and(
              eq(invoices.caseId, found.id),
              eq(invoices.frozen, true),
              isNotNull(invoices.caseDeletedAt),
              isNull(invoices.deletedAt),
            ),
          );

        if (frozenInvoices.length > 0) {
          await db
            .update(invoices)
            .set({
              frozen: false,
              balanceDue: sql`${invoices.total}`,
              caseDeletedAt: null,
              caseDeletedByUserId: null,
              caseDeletedNote: null,
              updatedByUserId: restoringUserId,
            } as any)
            .where(
              and(
                inArray(
                  invoices.id,
                  frozenInvoices.map((inv) => inv.id),
                ),
                eq(invoices.frozen, true),
                isNull(invoices.deletedAt),
              ),
            );

          for (const inv of frozenInvoices) {
            await writeAuditLog({
              req,
              userId: restoringUserId,
              organizationId: found.labOrganizationId,
              action: "invoice_unfrozen_case_restored",
              entityType: "invoice",
              entityId: inv.id,
              beforeJson: inv,
              metadataJson: {
                caseId: found.id,
                caseNumber: found.caseNumber,
              },
            });
          }
        }

        restored.push(caseId);
        broadcastCaseUpdated(caseId, "restored");
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : "Unexpected error.";
        failed.push({ id: caseId, reason });
      }
    }

    return ok(res, { restored, failed });
  })
);

router.post(
  "/:caseId/restore",
  asyncHandler(async (req, res) => {
    const restoringUserId = (req as any).auth.userId as string;

    // Look up the case including soft-deleted rows; standard assertCaseAccess
    // excludes them, so query directly here.
    const found = await db.query.cases.findFirst({
      where: eq(cases.id, req.params.caseId),
    });
    if (!found) throw new HttpError(404, "Case not found.");
    if (!found.deletedAt) {
      throw new HttpError(409, "Case is not deleted.");
    }

    await requireAnyRole(restoringUserId, found.labOrganizationId, ADMIN_ROLES);

    // Restore the soft-deleted case row.
    await restoreDeleted({
      table: cases,
      where: eq(cases.id, found.id),
      actorUserId: restoringUserId,
      req,
      organizationId: found.labOrganizationId,
      entityType: "case",
      entityId: found.id,
    });

    // Unfreeze every linked invoice that was frozen specifically because this case
    // was deleted (caseDeletedAt IS NOT NULL distinguishes case-delete freezes from
    // any other freeze reasons that may be added in the future).
    const frozenInvoices = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.caseId, found.id),
          eq(invoices.frozen, true),
          isNotNull(invoices.caseDeletedAt),
          isNull(invoices.deletedAt),
        ),
      );

    if (frozenInvoices.length > 0) {
      // Restore balanceDue to the invoice total — the original balanceDue was
      // zeroed out at freeze time and is not recoverable here. Using total is
      // the correct business default: billing resumes as if the invoice is
      // fully outstanding.
      await db
        .update(invoices)
        .set({
          frozen: false,
          balanceDue: sql`${invoices.total}`,
          caseDeletedAt: null,
          caseDeletedByUserId: null,
          caseDeletedNote: null,
          updatedByUserId: restoringUserId,
        } as any)
        .where(
          and(
            inArray(
              invoices.id,
              frozenInvoices.map((inv) => inv.id),
            ),
            eq(invoices.frozen, true),
            isNull(invoices.deletedAt),
          ),
        );

      for (const inv of frozenInvoices) {
        await writeAuditLog({
          req,
          userId: restoringUserId,
          organizationId: found.labOrganizationId,
          action: "invoice_unfrozen_case_restored",
          entityType: "invoice",
          entityId: inv.id,
          beforeJson: inv,
          metadataJson: {
            caseId: found.id,
            caseNumber: found.caseNumber,
          },
        });
      }
    }

    broadcastCaseUpdated(found.id, "restored");
    return ok(res, { restored: true, unfrozenInvoices: frozenInvoices.length });
  })
);

router.post(
  "/:caseId/notes",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    const input = z
      .object({
        noteText: z.string().min(1),
        visibility: z
          .enum(["internal_lab_only", "shared_with_provider"])
          .default("internal_lab_only"),
      })
      .parse(req.body);

    const labMember = await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    ).catch(() => null);
    const authorOrgId = labMember
      ? found.labOrganizationId
      : found.providerOrganizationId;

    const [note] = await db
      .insert(caseNotes)
      .values({
        caseId: found.id,
        authorUserId: (req as any).auth.userId,
        authorOrganizationId: authorOrgId,
        noteText: input.noteText,
        visibility: input.visibility,
      })
      .returning()
      .catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to save note. Please try again.",
      }));

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "note_added",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: authorOrgId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        visibility: input.visibility,
        noteId: note.id,
        noteText: input.noteText,
      },
    }).catch((err: unknown): never => wrapDbError(err, {
      fallback: "Failed to record note_added event.",
    }));

    await touchCase(found.id);

    // Auto-notify provider members when a shared note is added by the lab.
    // Fire-and-forget — failure must not affect the 201 response.
    if (input.visibility === "shared_with_provider" && found.providerOrganizationId) {
      const labOrg = await db.query.organizations.findFirst({
        where: eq(organizations.id, found.labOrganizationId),
      }).catch(() => null);
      void notifyProviderMembersOfLabActivity(
        found as typeof found & { providerOrganizationId: string },
        "shared_note_added",
        (labOrg as any)?.name ?? "Your lab"
      );
    }

    return ok(res, note, 201);
  })
);

router.post(
  "/:caseId/notes/:noteId/notify",
  asyncHandler(async (req, res) => {
    const caseId = String(req.params["caseId"] ?? "");
    const noteId = String(req.params["noteId"] ?? "");

    const found = await assertCaseAccess((req as any).auth.userId, caseId);

    const labMember = await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId,
    ).catch(() => null);
    if (!labMember) {
      throw new HttpError(403, "Only lab members can send provider notifications.");
    }

    const input = z
      .object({ method: z.enum(["email", "sms", "labtrax_only"]) })
      .parse(req.body);

    const note = await db.query.caseNotes.findFirst({
      where: and(eq(caseNotes.id, noteId), eq(caseNotes.caseId, caseId)),
    });
    if (!note) throw new HttpError(404, "Note not found.");
    if (note.visibility !== "shared_with_provider") {
      throw new HttpError(422, "Only notes shared with the provider can be notified.");
    }

    if (!found.providerOrganizationId) {
      throw new HttpError(422, "This case has no provider organization.");
    }
    const providerOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, found.providerOrganizationId),
    });
    if (!providerOrg) throw new HttpError(404, "Provider organization not found.");

    if (input.method === "labtrax_only") {
      // Resolve all active members of the provider organization and insert a
      // notification row for each so the provider sees the bell badge.
      const providerMembers = await db
        .select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.labId, found.providerOrganizationId),
            eq(organizationMemberships.status, "active"),
          ),
        );

      if (providerMembers.length > 0) {
        const { filterUserIdsByInAppPref } = await import("../lib/in-app-prefs.js");
        const recipientIds = await filterUserIdsByInAppPref(
          providerMembers.map((m) => m.userId),
          "caseNoteNotifications",
        );
        if (recipientIds.length > 0) {
          const patientName =
            [found.patientFirstName, found.patientLastName].filter(Boolean).join(" ") ||
            "Unknown";
          const noteSnippet = note.noteText.slice(0, 200);
          await db
            .insert(notifications)
            .values(
              recipientIds.map((userId) => ({
                userId,
                type: "shared_note",
                title: `New note on ${patientName}'s case`,
                body: noteSnippet,
                dataJson: { caseId, noteId },
              })),
            );
        }
      }
      return ok(res, { ok: true });
    }

    if (input.method === "email") {
      if (!providerOrg.billingEmail) {
        throw new HttpError(
          422,
          "The provider organization has no email address on file. Please add a billing email to the provider's profile.",
        );
      }
      const { checkEmailPref } = await import("../lib/email-prefs.js");
      const allowed = await checkEmailPref(providerOrg.billingEmail, "caseNoteNotifications");
      if (!allowed) {
        return ok(res, { sent: false, reason: "recipient_opted_out" });
      }
      const { sendMail } = await import("../lib/mail.js");
      const snippet =
        note.noteText.length > 500
          ? note.noteText.slice(0, 500) + "…"
          : note.noteText;
      await sendMail({
        to: providerOrg.billingEmail,
        subject: `LabTrax: New note on case ${found.caseNumber}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
  <div style="background:#4A6CF7;color:white;padding:20px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;">LabTrax</h2>
    <p style="margin:4px 0 0;opacity:.85;">Case update from your lab</p>
  </div>
  <div style="padding:20px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;">
    <p>A new note has been added to case <strong>${found.caseNumber}</strong>
      (patient: ${found.patientFirstName} ${found.patientLastName}):</p>
    <blockquote style="border-left:3px solid #4A6CF7;margin:16px 0;padding:12px 16px;background:#f5f7ff;border-radius:0 4px 4px 0;">
      <p style="margin:0;white-space:pre-wrap;">${snippet}</p>
    </blockquote>
    <p style="color:#888;font-size:13px;">This note was shared with your practice by the dental laboratory. Please log in to LabTrax to view the full case details.</p>
  </div>
</div>`,
        text: `LabTrax: New note on case ${found.caseNumber} (${found.patientFirstName} ${found.patientLastName})\n\n${snippet}`,
      });
    } else {
      if (!providerOrg.phone) {
        throw new HttpError(
          422,
          "The provider organization has no phone number on file. Please add a phone number to the provider's profile.",
        );
      }
      const phoneE164 = normalizePhoneE164(providerOrg.phone);
      if (!phoneE164) {
        throw new HttpError(
          422,
          "The provider organization's phone number is not a valid format.",
        );
      }
      const truncated =
        note.noteText.length > 120
          ? note.noteText.slice(0, 117) + "…"
          : note.noteText;
      const body = `LabTrax case ${found.caseNumber}: ${truncated}`;
      const { sendSms } = await import("../lib/sms.js");
      const result = await sendSms({ to: phoneE164, body });
      if (!result.ok && !result.skipped) {
        throw new HttpError(502, result.errorMessage ?? "SMS delivery failed.");
      }
    }

    return ok(res, { ok: true });
  })
);

router.patch(
  "/restorations/pricing",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        restorationType: z.string().min(1),
        material: z.string().nullable().optional(),
        unitPrice: z.coerce.number().min(0),
      })
      .parse(req.body);

    const memberships = await db.query.organizationMemberships.findMany({
      where: eq(organizationMemberships.userId, (req as any).auth.userId),
    });
    const labOrgIds = memberships
      .filter(
        (m: any) =>
          m.status === "active" &&
          (m.role === "owner" || m.role === "admin" || m.role === "billing")
      )
      .map((m: any) => m.labId);

    if (labOrgIds.length === 0) {
      throw new HttpError(403, "You don't have permission to update pricing.");
    }

    const accessibleCases = await db.query.cases.findMany({
      where: and(
        inArray(cases.labOrganizationId, labOrgIds),
        notDeleted(cases)
      ),
    });
    const accessibleCaseIds = accessibleCases.map((c) => c.id);
    if (accessibleCaseIds.length === 0) {
      return ok(res, { updated: 0 });
    }

    const candidates = await db.query.caseRestorations.findMany({
      where: and(
        inArray(caseRestorations.caseId, accessibleCaseIds),
        eq(caseRestorations.restorationType, input.restorationType)
      ),
    });
    const matchMaterial = (input.material ?? "").trim();
    const matching = candidates.filter((r) => {
      const m = (r.material ?? "").trim();
      if (!matchMaterial) return !m;
      return m === matchMaterial;
    });

    if (matching.length === 0) {
      return ok(res, { updated: 0 });
    }

    await db
      .update(caseRestorations)
      .set({
        unitPrice: input.unitPrice.toFixed(2),
        priceSource: "manual",
        priceSourceId: null,
        priceSourceName: null,
        priceKey: null,
      })
      .where(
        inArray(
          caseRestorations.id,
          matching.map((r) => r.id)
        )
      )
      .catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to update restoration pricing.",
      }));

    await writeAuditLog({
      req,
      action: "restoration_pricing_updated",
      entityType: "case_restoration",
      entityId: input.restorationType,
      metadataJson: {
        restorationType: input.restorationType,
        material: input.material ?? null,
        unitPrice: input.unitPrice.toFixed(2),
        updated: matching.length,
      },
    });

    // Each affected case's invoice now references stale unit prices.
    // Re-sync the invoice line items + totals on each one so the
    // Invoice tab reflects the new pricing immediately. Sync errors
    // on a single case must not block the others — log and continue.
    const affectedCaseIds = Array.from(
      new Set(matching.map((r) => r.caseId)),
    );
    // Broadcast AFTER each case's own invoice sync settles (success or
    // failure), not before — a socket recipient that refetches the instant
    // it's notified must see the resynced invoice totals, not the pre-sync
    // stale ones. Still broadcast on a sync failure: the restoration price
    // itself already changed even if the invoice resync didn't complete.
    for (const cId of affectedCaseIds) {
      try {
        await syncInvoiceFromRestorations({
          caseId: cId,
          actorUserId: (req as any).auth.userId,
        });
      } catch (err) {
        req.log?.error(
          { err, caseId: cId },
          "Failed to sync invoice after bulk restoration pricing update",
        );
      } finally {
        broadcastCaseUpdated(cId);
      }
    }

    return ok(res, { updated: matching.length });
  })
);

// ---------------------------------------------------------------------------
// Bridge-span helpers used by the restoration POST handler.
// These mirror the connector parsing in invoice-sync.ts but are kept local
// to avoid a circular import between the routes and the sync lib.
// ---------------------------------------------------------------------------

/** Parse "13-14,14-15" → Set of normalised "lo-hi" pair keys. */
function _parseBridgeConnectorStr(value: string | null | undefined): Set<string> {
  return parseConnectorState(value).active;
}

/** BFS: return all tooth numbers reachable from toothNum via connectors. */
function _findBridgeSpan(toothNum: number, connectors: Set<string>): Set<number> {
  const span = new Set<number>();
  const toVisit: number[] = [toothNum];
  while (toVisit.length > 0) {
    const curr = toVisit.pop()!;
    if (span.has(curr)) continue;
    span.add(curr);
    for (const pair of connectors) {
      const [as, bs] = pair.split("-");
      const a = Number(as);
      const b = Number(bs);
      if (a === curr && !span.has(b)) toVisit.push(b);
      if (b === curr && !span.has(a)) toVisit.push(a);
    }
  }
  return span;
}

/**
 * Re-price every non-manually-priced pontic in `restorations`.
 *
 * Material resolution priority:
 *   1. Bridge-connector span membership (when `bridgeConnectorStr` is non-null).
 *   2. Adjacency fallback: nearest non-pontic restoration within ±3 tooth
 *      numbers (handles cases where bridge connectors haven't been drawn yet).
 *
 * Manually-priced pontics (`priceSource = "manual"`) are never touched.
 * The function is idempotent and safe to call with any restoration list.
 */
async function _repricePonticsInSpans(
  caseCtx: {
    id: string;
    labOrganizationId: string;
    doctorName?: string | null;
    providerOrganizationId?: string | null;
  },
  restorations: Array<{
    id: string;
    toothNumber: string;
    restorationType: string;
    restorationSubtype?: string | null;
    material: string | null;
    priceSource: string | null;
  }>,
  _bridgeConnectorStr: string | null,
): Promise<void> {
  const pontics = restorations.filter(
    (r) => /pontic/i.test(r.restorationType) && !r.priceSource && !!r.material?.trim(),
  );
  if (pontics.length === 0) return;

  for (const pontic of pontics) {
    const ponticTooth = Number(pontic.toothNumber.trim());
    if (!Number.isInteger(ponticTooth) || ponticTooth < 1 || ponticTooth > 32) continue;

    const repriced = await resolveServerPriceWithSource(
      {
        labOrganizationId: caseCtx.labOrganizationId,
        doctorName: caseCtx.doctorName,
        providerOrganizationId: caseCtx.providerOrganizationId,
      },
      pontic.material,
      pontic.restorationType,
      pontic.restorationSubtype,
    );

    if (repriced) {
      await db
        .update(caseRestorations)
        .set({
          unitPrice: repriced.amount.toFixed(2),
          priceSource: repriced.source,
          priceSourceId: repriced.sourceId,
          priceSourceName: repriced.sourceName,
          priceKey: repriced.key,
        })
        .where(eq(caseRestorations.id, pontic.id))
        .catch((err: unknown): never => wrapDbError(err, {
          fallback: "Failed to update pontic restoration pricing.",
        }));
    }
  }
}

router.post(
  "/:caseId/restorations",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccessOrPromote(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const input = z
      .object({
        // Empty toothNumber is allowed for removable restoration types
        // (denture, partial, flipper, flexible/Valplast) where tooth position
        // is not clinically meaningful. Non-removable types should always
        // supply a non-empty tooth number, but that constraint is enforced on
        // the client rather than here to keep server and iTero-import paths
        // consistent (both already accept empty toothNumber per case-create).
        toothNumber: z.string(),
        restorationType: z.string().min(1),
        material: z.string().optional(),
        shade: z.string().optional(),
        notes: z.string().optional(),
        quantity: z.coerce.number().int().positive().default(1),
        unitPrice: z.coerce.number().min(0).default(0),
        restorationSubtype: z.string().optional(),
        ...implantInputFields,
        arch: z.enum(ARCH_VALUES).nullable().optional(),
      })
      .parse(req.body);
    if (isArchApplicable(input.restorationType, input.restorationSubtype) &&
        !normalizeArch(input.arch)) {
      throw new HttpError(400, "Arch is required for Removable and Ortho restorations.");
    }

    // A connector or neighboring tooth is never evidence of a unit's material.
    // Legacy rows remain untouched; new explicit crown/pontic units need a
    // material selected by the operator.
    const effectiveMaterial = input.material?.trim() || null;
    const isExplicitToothUnit = /^(?:crown|pontic)$/i.test(input.restorationType);
    if (isExplicitToothUnit) {
      input.toothNumber = input.toothNumber.trim().toUpperCase();
      if (!/^(?:[1-9]|[12]\d|3[0-2]|[A-T])$/.test(input.toothNumber) || input.quantity !== 1) {
        throw new HttpError(400, "Assign each crown or pontic to one tooth with one billable unit.");
      }
    }
    if (/^(?:crown|pontic)$/i.test(input.restorationType) && !effectiveMaterial) {
      throw new HttpError(400, "Select a catalog material for this crown or pontic.");
    }

    let unit = input.unitPrice;
    const userSupplied = Number.isFinite(unit) && unit > 0;
    let priceSource: string | null = userSupplied ? "manual" : null;
    let priceSourceId: string | null = null;
    let priceSourceName: string | null = null;
    let priceKey: string | null = null;
    if (!userSupplied) {
      const fallback = await resolveServerPriceWithSource(
        {
          labOrganizationId: found.labOrganizationId,
          doctorName: found.doctorName,
          providerOrganizationId: found.providerOrganizationId,
        },
        effectiveMaterial,
        input.restorationType,
        input.restorationSubtype ?? null,
      );
      if (fallback) {
        unit = fallback.amount;
        priceSource = fallback.source;
        priceSourceId = fallback.sourceId;
        priceSourceName = fallback.sourceName;
        priceKey = fallback.key;
      }
    }

    const normalizedArch = normalizeArch(input.arch);
    const { restoration, replayed } = await db.transaction(async (tx) => {
      const [lockedCase] = await tx.select().from(cases).where(eq(cases.id, found.id)).for("update");
      const existing = await tx.select().from(caseRestorations).where(eq(caseRestorations.caseId, found.id));
      if (isExplicitToothUnit) {
        const duplicate = existing.find((row) => /^(Crown(?:\s*(?:&|and)\s*Bridge)?|Pontic|Bridge|Implant|Veneer|Inlay|Onlay)$/i.test(row.restorationType) && row.priceKey !== "alloy" &&
          expandToothAssignmentIdentifiers(row.toothNumber).includes(input.toothNumber));
        if (duplicate) {
          if (duplicate.toothNumber === input.toothNumber && duplicate.quantity === 1 &&
              duplicate.restorationType === input.restorationType &&
              duplicate.material === effectiveMaterial &&
              (duplicate.shade ?? "") === (input.shade ?? "") &&
              (duplicate.restorationSubtype ?? "") === (input.restorationSubtype ?? "") &&
              (!userSupplied || Number(duplicate.unitPrice) === unit)) {
            return { restoration: duplicate, replayed: true };
          }
          throw new HttpError(409, `Tooth #${input.toothNumber} already has an assignment. Edit that assignment rather than adding a second unit.`);
        }
        await tx.delete(caseRestorations).where(and(eq(caseRestorations.caseId, found.id),
          eq(caseRestorations.toothNumber, input.toothNumber), sql`lower(${caseRestorations.restorationType}) = 'missing'`));
      }
      const [created] = await tx.insert(caseRestorations)
      .values({
        caseId: found.id,
        toothNumber: input.toothNumber,
        ...implantValues(input),
        restorationType: input.restorationType,
        assignmentProvenance: isExplicitToothUnit ? { origin: "manual", manualFields: ["role", "product", "shade"] } : null,
        restorationSubtype: input.restorationSubtype ?? null,
        arch: normalizedArch,
        material: effectiveMaterial,
        shade: input.shade ?? null,
        notes: input.notes ?? null,
        quantity: input.quantity,
        unitPrice: unit.toFixed(2),
        priceSource,
        priceSourceId,
        priceSourceName,
        priceKey,
      })
      .returning()
      .catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to save restoration. Please try again.",
      }));
      if (isExplicitToothUnit) {
        const state = withPonticConnectorSuggestions(lockedCase.bridgeConnectors, [...existing, created], new Set([input.toothNumber]));
        await tx.update(cases).set({ bridgeConnectors: serializeConnectorState(state) || null }).where(eq(cases.id, found.id));
      }
      return { restoration: created, replayed: false };
    });

    const restorationActor = (req as any).user;
    if (!replayed) await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "restoration_added",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: restorationActor?.initials || "SYS",
      metadataJson: {
        restorationId: restoration.id,
        restorationType: restoration.restorationType,
        toothNumber: restoration.toothNumber,
        material: restoration.material,
        shade: restoration.shade,
        quantity: restoration.quantity,
        unitPrice: restoration.unitPrice,
      },
    }).catch((err: unknown): never => wrapDbError(err, {
      fallback: "Failed to record restoration_added event.",
    }));

    // Connections never copy neighboring material or reprice other sources.

    // Keep the case's invoice in sync with the restoration set so the
    // user doesn't have to also open the Invoice tab and regenerate by
    // hand — adding a Night Guard line should immediately appear on
    // the invoice with the right unit price + total.
    await syncInvoiceFromRestorations({
      caseId: found.id,
      actorUserId: (req as any).auth.userId,
    });

    // ── Auto-add alloy surcharge on PFM ──────────────────────────────────
    // When the lab has opted into `autoAddAlloyOnPfm`, a newly added PFM
    // restoration automatically appends an "Alloy" line (idempotent) so the
    // alloy charge is never forgotten. Best-effort: a failure here must not
    // fail the restoration write the user just made.
    if (
      priceKey === "pfm_crown" ||
      /pfm/i.test(effectiveMaterial ?? "") ||
      isPfmOrFcmMaterial(effectiveMaterial)
    ) {
      try {
        const labOrg = await db.query.organizations.findFirst({
          where: eq(organizations.id, found.labOrganizationId),
        });
        if (labOrg?.autoAddAlloyOnPfm) {
          await addAlloyChargeToCase({
            caseRow: {
              id: found.id,
              labOrganizationId: found.labOrganizationId,
              doctorName: found.doctorName,
              providerOrganizationId: found.providerOrganizationId,
            },
            actorUserId: (req as any).auth.userId,
            actorInitials: restorationActor?.initials,
          });
        }
      } catch (err) {
        req.log.error(
          { err, caseId: found.id },
          "auto-add alloy charge failed",
        );
      }
    }

    await touchCase(found.id);

    return ok(res, restoration, 201);
  })
);

// One-click "add alloy charge" from the PFM reminder (Task #2067). Adds an
// alloy surcharge line to the case (idempotent) priced through the lab's
// tier/override cascade, and re-syncs the invoice.
router.post(
  "/:caseId/alloy-charge",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccessOrPromote(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );

    const result = await addAlloyChargeToCase({
      caseRow: {
        id: found.id,
        labOrganizationId: found.labOrganizationId,
        doctorName: found.doctorName,
        providerOrganizationId: found.providerOrganizationId,
      },
      actorUserId: (req as any).auth.userId,
      actorInitials: (req as any).user?.initials,
      // Manual reminder add must never silently create a $0 line — reject
      // when no alloy price is configured so the UI can point at pricing.
      requirePriced: true,
    });

    if (result.skippedUnpriced) {
      throw new HttpError(
        422,
        "No alloy price is configured for this case. Set an alloy price in your fee schedule first."
      );
    }

    await touchCase(found.id);

    return ok(res, result, result.added ? 201 : 200);
  })
);

// One-click "remove alloy charge" (Task #2078). Deletes the alloy surcharge
// restoration line(s) from a case (idempotent), re-syncs the invoice, and
// records a restoration_deleted case event + an audit log entry. Removing
// when no alloy line is present is a no-op.
router.delete(
  "/:caseId/alloy-charge",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccessOrPromote(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );

    const result = await removeAlloyChargeFromCase({
      caseRow: {
        id: found.id,
        labOrganizationId: found.labOrganizationId,
        doctorName: found.doctorName,
        providerOrganizationId: found.providerOrganizationId,
      },
      actorUserId: (req as any).auth.userId,
      actorInitials: (req as any).user?.initials,
    });

    if (result.removed) {
      await writeAuditLog({
        req,
        organizationId: found.labOrganizationId,
        action: "alloy_charge_removed",
        entityType: "case",
        entityId: found.id,
        metadataJson: {
          caseId: found.id,
          removedRestorationIds: result.removedRestorationIds,
        },
      });
    }

    await touchCase(found.id);

    return ok(res, result);
  })
);

// Preview the alloy surcharge price for a case without adding it (Task #2075).
// Powers the PFM reminder banner so the user sees the resolved amount (or a
// "no alloy price set" warning) before clicking "Add alloy charge".
router.get(
  "/:caseId/alloy-charge/preview",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccessOrPromote(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );

    const preview = await resolveAlloyPricePreview({
      labOrganizationId: found.labOrganizationId,
      doctorName: found.doctorName,
      providerOrganizationId: found.providerOrganizationId,
    });

    return ok(res, preview);
  })
);

// Inline "set alloy price" from the PFM reminder (Task #2077). When the alloy
// line was added at $0 (no tier/override has an alloy price), a lab admin can
// set the price right from the case drawer. We write it to the tier/override
// the case resolves to and re-price the line + invoice. Admin-only.
router.post(
  "/:caseId/alloy-price",
  asyncHandler(async (req, res) => {
    const input = z
      .object({ price: z.coerce.number().min(0.01).max(1_000_000) })
      .parse(req.body);

    const found = await assertCaseAccessOrPromote(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );

    const result = await setAlloyPriceForCase({
      caseRow: {
        id: found.id,
        labOrganizationId: found.labOrganizationId,
        doctorName: found.doctorName,
        providerOrganizationId: found.providerOrganizationId,
      },
      price: input.price,
      actorUserId: (req as any).auth.userId,
      actorInitials: (req as any).user?.initials,
    });

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action:
        result.target.kind === "tier"
          ? "pricing_tier_updated"
          : "pricing_override_updated",
      entityType:
        result.target.kind === "tier" ? "pricing_tier" : "pricing_override",
      entityId: result.target.id,
      beforeJson: { prices: result.beforePrices },
      afterJson: {
        prices: result.afterPrices,
        alloyPriceSetFromCaseId: found.id,
      },
    });

    await touchCase(found.id);

    return ok(res, {
      ok: true,
      target: result.target,
      amount: result.amount,
      restorationId: result.restorationId,
    });
  })
);

// Generic per-restoration "set price" (Task #2084). Writes a price for the
// restoration's resolved fee-schedule key into the tier/override the case
// resolves to, then re-prices the line + invoice. Admin-only, audit-logged
// like the alloy flow. Distinct from PATCH /restorations/:id/price, which sets
// a one-off manual unitPrice on a single line without touching the fee schedule.
router.post(
  "/:caseId/restorations/:restorationId/fee-schedule-price",
  asyncHandler(async (req, res) => {
    const input = z
      .object({ price: z.coerce.number().min(0.01).max(1_000_000) })
      .parse(req.body);

    const found = await assertCaseAccessOrPromote(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );

    const result = await setRestorationPriceForCase({
      caseRow: {
        id: found.id,
        labOrganizationId: found.labOrganizationId,
        doctorName: found.doctorName,
        providerOrganizationId: found.providerOrganizationId,
      },
      restorationId: req.params.restorationId,
      price: input.price,
      actorUserId: (req as any).auth.userId,
      actorInitials: (req as any).user?.initials,
    });

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action:
        result.target.kind === "tier"
          ? "pricing_tier_updated"
          : "pricing_override_updated",
      entityType:
        result.target.kind === "tier" ? "pricing_tier" : "pricing_override",
      entityId: result.target.id,
      beforeJson: { prices: result.beforePrices },
      afterJson: {
        prices: result.afterPrices,
        priceSetFromCaseId: found.id,
        priceKey: result.priceKey,
      },
    });

    await touchCase(found.id);

    return ok(res, {
      ok: true,
      target: result.target,
      amount: result.amount,
      priceKey: result.priceKey,
      restorationId: result.restorationId,
    });
  })
);


router.delete(
  "/:caseId/restorations/:restorationId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccessOrPromote(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const restoration = await db.query.caseRestorations.findFirst({
      where: and(
        eq(caseRestorations.id, req.params.restorationId),
        eq(caseRestorations.caseId, found.id)
      ),
    });
    if (!restoration) {
      const deleted = await db.query.caseEvents.findFirst({ where: and(eq(caseEvents.caseId, found.id),
        eq(caseEvents.eventType, "restoration_deleted"), sql`${caseEvents.metadataJson}->>'restorationId' = ${req.params.restorationId}`) });
      if (!deleted) throw new HttpError(404, "Restoration not found.");
      await syncInvoiceFromRestorations({ caseId: found.id, actorUserId: (req as any).auth.userId });
      broadcastCaseUpdated(found.id);
      return ok(res, { deleted: true });
    }
    const restorationDeleter = (req as any).user;
    await db.transaction(async (tx) => {
      const [lockedCase] = await tx.select().from(cases).where(eq(cases.id, found.id)).for("update");
      const state = parseConnectorState(lockedCase.bridgeConnectors);
      const removedTeeth = new Set(expandToothAssignmentIdentifiers(restoration.toothNumber));
      const remaining = new Set([...state.active].filter((pair) => !pair.split("-").some((tooth) => removedTeeth.has(tooth))));
      await tx.delete(caseRestorations).where(eq(caseRestorations.id, restoration.id));
      await tx.update(cases).set({ bridgeConnectors: updateConnectorChoices(state, remaining) || null }).where(eq(cases.id, found.id));
      await tx.insert(caseEvents).values({
      caseId: found.id,
      eventType: "restoration_deleted",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: restorationDeleter?.initials || "SYS",
      metadataJson: {
        restorationId: restoration.id,
        restorationType: restoration.restorationType,
        toothNumber: restoration.toothNumber,
        material: restoration.material,
      },
    }).catch((err: unknown): never => wrapDbError(err, {
      fallback: "Failed to record restoration_deleted event.",
    }));
    });
    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "restoration_deleted",
      entityType: "case_restoration",
      entityId: restoration.id,
      beforeJson: restoration,
    });

    // Mirror the add-side behavior: keep the invoice in sync so a
    // removed restoration is also pulled off the invoice (and the
    // total drops accordingly).
    await syncInvoiceFromRestorations({
      caseId: found.id,
      actorUserId: (req as any).auth.userId,
    });

    broadcastCaseUpdated(found.id);
    return ok(res, { deleted: true });
  })
);

async function updateCaseRestorationHierarchy(
  req: Request, res: Response, executor: InvoiceSyncExecutor = db, deferInvoice = false,
) {
    const found = await assertCaseAccessOrPromote(
      (req as any).auth.userId,
      String(req.params.caseId)
    );
    const membership = await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );

    const input = UpdateCaseRestorationHierarchyBody.parse(req.body);
    if (
      (input.step !== undefined || input.stepShade !== undefined) &&
      !ADMIN_ROLES.includes(membership.role as any)
    ) {
      throw new HttpError(403, "Only admin or owner members can update the case step.");
    }
    const actor = (req as any).user;
    const result = await executor.transaction(async (tx) => {
      const beforeRows = await tx
        .select()
        .from(caseRestorations)
        .where(eq(caseRestorations.caseId, found.id))
        .for("update");

      const requestedArch =
        input.arch === undefined ? undefined : normalizeArch(input.arch);
      if (input.arch != null && !requestedArch) {
        throw new HttpError(400, "Choose a valid arch.");
      }

      const allBillableRows = beforeRows.filter(
        (row) => row.restorationType !== "missing",
      );
      const rowSku = (row: typeof allBillableRows[number]) => encodeRestorationSubtype(deriveCaseHierarchy(
        /^(Crown|Pontic)$/i.test(row.restorationType) ? found.caseType : row.restorationType,
        row.restorationSubtype, row.material));
      const unitSkus = new Set(allBillableRows.filter((row) => /^(Crown|Pontic)$/i.test(row.restorationType)).map(rowSku).filter(Boolean));
      const defaultSku = !found.material && !found.restorationSubtypeOverride && unitSkus.size === 1
        ? [...unitSkus][0] : encodeRestorationSubtype(deriveCaseHierarchy(
          found.caseType, found.restorationSubtypeOverride, found.material));
      const productChanged = encodeRestorationSubtype(deriveCaseHierarchy(
        input.restorationType, input.restorationSubtype, input.material)) !== defaultSku;
      const billableRows = allBillableRows.filter((row) => {
        const sku = rowSku(row);
        return (!productChanged && /^(Crown|Pontic)$/i.test(row.restorationType)) || !defaultSku || sku === defaultSku ||
          (!row.restorationSubtype && !row.material && /^(Crown|Pontic)$/i.test(row.restorationType));
      });
      const unrelatedRows = allBillableRows.filter((row) => !billableRows.includes(row));
      const unrelatedTeeth = new Set(unrelatedRows.filter((row) => /^(Crown|Pontic)$/i.test(row.restorationType))
        .flatMap((row) => expandToothAssignmentIdentifiers(row.toothNumber)));
      const requestedTeeth =
        input.toothNumbers === undefined
          ? null
          : Array.from(new Set(input.toothNumbers.map((tooth) => tooth.trim())));
      const targetIsRestorative = deriveCaseHierarchy(input.restorationType, input.restorationSubtype, input.material).caseType === "restorative";
      if (targetIsRestorative && productChanged && allBillableRows.some((row) => /^(Crown|Pontic)$/i.test(row.restorationType)) &&
          !billableRows.some((row) => /^(Crown|Pontic)$/i.test(row.restorationType))) {
        throw new HttpError(400, "These teeth have independent catalog products. Use the tooth chart to change their assignments explicitly.");
      }
      if (targetIsRestorative && requestedArch === "upper_lower" && billableRows.some((row) => /^(Crown|Pontic)$/i.test(row.restorationType))) {
        throw new HttpError(400, "Tooth numbers define the arch of each assignment. A tooth cannot be billed on both arches.");
      }
      if (targetIsRestorative && requestedTeeth) {
        const assigned = new Set(allBillableRows.map((row) => row.toothNumber));
        if (requestedTeeth.some((tooth) => expandToothAssignmentIdentifiers(tooth).length && !assigned.has(tooth))) {
          throw new HttpError(400, "Assign an explicit crown or pontic role to new teeth in Restorations before changing their shared product.");
        }
      }
      if (requestedTeeth === null && billableRows.length === 0) {
        throw new HttpError(400, "Add at least one tooth or arch-level restoration.");
      }
      const desiredTeeth =
        requestedTeeth === null
          ? null
          : requestedTeeth.length > 0
            ? requestedTeeth
            : [""];

      const pricingCase = await tx.query.cases.findFirst({
        where: eq(cases.id, found.id),
      });
      if (!pricingCase) throw new HttpError(404, "Case not found.");
      const existingByTooth = new Map<string, typeof billableRows>();
      for (const row of billableRows) {
        const group = existingByTooth.get(row.toothNumber) ?? [];
        group.push(row);
        existingByTooth.set(row.toothNumber, group);
      }
      const retainedIds = new Set<string>(unrelatedRows.map((row) => row.id));
      const nextEvents: Array<Record<string, unknown>> = [];
      const priceCache = new Map<string, Awaited<ReturnType<typeof resolveServerPriceWithSource>>>();
      let updatedCount = 0;
      let createdCount = 0;
      let deletedCount = 0;
      let repricedCount = 0;
      let manualPriceCount = 0;
      let unpricedCount = 0;

      const persistLine = async (
        existing: (typeof billableRows)[number] | null,
        seed: (typeof billableRows)[number] | null,
        toothNumber: string,
        arch: string | null,
      ) => {
        const source = existing ?? seed;
        const preserveProduct = source && !productChanged && /^(Crown|Pontic)$/i.test(source.restorationType);
        const restorationSubtype = preserveProduct ? source.restorationSubtype : input.restorationSubtype || null;
        const material = preserveProduct ? source.material : input.material || null;
        const restorationType = targetIsRestorative && source && expandToothAssignmentIdentifiers(source.toothNumber).length
          ? source.restorationType : input.restorationType;
        const hierarchyChanged =
          !source ||
          source.restorationType !== restorationType ||
          (source.restorationSubtype ?? null) !== restorationSubtype ||
          (source.material ?? null) !== material;
        const manual = source?.priceSource === "manual";
        const rowValues: Record<string, unknown> = {
          caseId: found.id,
          toothNumber,
          restorationType,
          restorationSubtype,
          material,
          shade:
            input.shade === undefined
              ? source?.shade ?? null
              : input.shade?.trim() || null,
          notes: source?.notes ?? null,
          assignmentProvenance: /^(Crown|Pontic)$/i.test(restorationType)
            ? { ...source?.assignmentProvenance, origin: source?.assignmentProvenance?.origin ?? "manual",
                manualFields: Array.from(new Set([...(source?.assignmentProvenance?.manualFields ?? []), "product", ...(input.shade !== undefined ? ["shade"] : [])])) }
            : null,
          ...implantValues(source ?? {}),
          quantity: source?.quantity ?? 1,
          arch:
            input.arch === undefined
              ? source?.arch ?? null
              : arch,
          unitPrice: source?.unitPrice ?? "0.00",
          priceSource: source?.priceSource ?? null,
          priceSourceId: source?.priceSourceId ?? null,
          priceSourceName: source?.priceSourceName ?? null,
          priceKey: source?.priceKey ?? null,
          updatedAt: new Date(),
        };

        if (manual && source) {
          manualPriceCount++;
        } else if (hierarchyChanged) {
          const cacheKey = [
            input.restorationType,
            input.restorationSubtype || "",
            input.material || "",
          ].join("\u0000");
          let quote = priceCache.get(cacheKey);
          if (quote === undefined) {
            quote = await resolveServerPriceWithSource(
              {
                labOrganizationId: pricingCase.labOrganizationId,
                doctorName: pricingCase.doctorName,
                providerOrganizationId: pricingCase.providerOrganizationId,
              },
              input.material || null,
              input.restorationType,
              input.restorationSubtype || null,
            );
            priceCache.set(cacheKey, quote);
          }
          if (quote) {
            rowValues.unitPrice = quote.amount.toFixed(2);
            rowValues.priceSource = quote.source;
            rowValues.priceSourceId = quote.sourceId;
            rowValues.priceSourceName = quote.sourceName;
            rowValues.priceKey = quote.key;
            repricedCount++;
          } else {
            rowValues.unitPrice = "0.00";
            rowValues.priceSource = null;
            rowValues.priceSourceId = null;
            rowValues.priceSourceName = null;
            rowValues.priceKey = null;
            unpricedCount++;
          }
        } else if (
          !existing &&
          source &&
          !source.priceSource &&
          Number(source.unitPrice) <= 0
        ) {
          unpricedCount++;
        }

        const saved = existing
          ? (
              await tx
                .update(caseRestorations)
                .set(rowValues)
                .where(eq(caseRestorations.id, existing.id))
                .returning()
            )[0]
          : (
              await tx.insert(caseRestorations).values(rowValues as any).returning()
            )[0];
        if (!saved) {
          throw new HttpError(409, "Case restorations changed during this save. Refresh the case and try again.");
        }
        if (existing) {
          retainedIds.add(existing.id);
          updatedCount++;
          nextEvents.push({
            caseId: found.id,
            eventType: "restoration_updated",
            actorUserId: (req as any).auth.userId,
            actorOrganizationId: found.labOrganizationId,
            actorInitials: actor?.initials || "SYS",
            metadataJson: { restorationId: existing.id, before: existing, after: saved },
          });
        } else {
          createdCount++;
          nextEvents.push({
            caseId: found.id,
            eventType: "restoration_added",
            actorUserId: (req as any).auth.userId,
            actorOrganizationId: found.labOrganizationId,
            actorInitials: actor?.initials || "SYS",
            metadataJson: { restorationId: saved.id, after: saved },
          });
        }
        return saved;
      };

      const checkArch = (arch: string | null) => {
        if (
          isArchApplicable(input.restorationType, input.restorationSubtype) &&
          !normalizeArch(arch)
        ) {
          throw new HttpError(400, "Arch is required for Removable and Ortho restorations.");
        }
      };

      if (desiredTeeth === null) {
        for (const old of billableRows) {
          const nextArch =
            input.arch === undefined
              ? normalizeArch(old.arch) ?? null
              : requestedArch === "upper_lower"
                ? "upper"
                : requestedArch ?? null;
          checkArch(nextArch);
          const saved = await persistLine(old, old, old.toothNumber, nextArch);
          if (requestedArch === "upper_lower") {
            await persistLine(null, saved, old.toothNumber, "lower");
          }
        }
      } else {
        for (const toothNumber of desiredTeeth) {
          if (unrelatedTeeth.has(toothNumber)) continue;
          const oldRows = existingByTooth.get(toothNumber) ?? [];
          if (requestedArch === "upper_lower") {
            for (const targetArch of ["upper", "lower"] as const) {
              const exact = oldRows.find(
                (row) => row.arch === targetArch && !retainedIds.has(row.id),
              );
              const unassigned = oldRows.find(
                (row) => !row.arch && !retainedIds.has(row.id),
              );
              const other = oldRows.find((row) => !retainedIds.has(row.id));
              const match = exact ?? (targetArch === "upper" ? unassigned : null) ?? null;
              const seed = match ?? other ?? oldRows[0] ?? null;
              checkArch(targetArch);
              await persistLine(match, seed, toothNumber, targetArch);
            }
          } else {
            const targetArch =
              input.arch === undefined
                ? undefined
                : requestedArch;
            const candidates =
              targetArch === undefined
                ? oldRows.filter((row) => !retainedIds.has(row.id))
                : [
                    oldRows.find(
                      (row) => row.arch === targetArch && !retainedIds.has(row.id),
                    ) ??
                      oldRows.find((row) => !retainedIds.has(row.id)),
                  ].filter(Boolean) as typeof oldRows;
            if (candidates.length === 0) {
              const archToSave = targetArch ?? null;
              checkArch(archToSave);
              await persistLine(null, null, toothNumber, archToSave);
            } else {
              for (const old of candidates) {
                const archToSave =
                  targetArch === undefined ? normalizeArch(old.arch) : targetArch;
                checkArch(archToSave);
                await persistLine(old, old, toothNumber, archToSave);
              }
            }
          }
        }
      }

      const droppedRows = billableRows.filter((row) => !retainedIds.has(row.id));
      if (droppedRows.length > 0) {
        await tx.delete(caseRestorations).where(
          inArray(caseRestorations.id, droppedRows.map((row) => row.id)),
        );
        deletedCount = droppedRows.length;
        nextEvents.push(
          ...droppedRows.map((row) => ({
            caseId: found.id,
            eventType: "restoration_deleted",
            actorUserId: (req as any).auth.userId,
            actorOrganizationId: found.labOrganizationId,
            actorInitials: actor?.initials || "SYS",
            metadataJson: { restorationId: row.id, before: row },
          })),
        );
      }
      if (nextEvents.length > 0) await tx.insert(caseEvents).values(nextEvents as any);

      if (input.step !== undefined || input.stepShade !== undefined) {
        const currentCase = await tx.query.cases.findFirst({
          where: eq(cases.id, found.id),
        });
        const nextStep =
          input.step === undefined ? currentCase?.step ?? null : input.step;
        await tx
          .update(cases)
          .set({
            step: nextStep,
            stepShade:
              nextStep === "wax_setup"
                ? input.stepShade === undefined
                  ? currentCase?.stepShade ?? null
                  : input.stepShade?.trim() || null
                : null,
            updatedAt: new Date(),
          })
          .where(eq(cases.id, found.id));
      }

      return {
        updatedCount,
        createdCount,
        deletedCount,
        repricedCount,
        manualPriceCount,
        unpricedCount,
      };
    });

    if (deferInvoice) return res.json(result);
    let invoiceResult;
    try {
      invoiceResult = await syncInvoiceFromRestorationsDetailed({
        caseId: found.id,
        actorUserId: (req as any).auth.userId,
        createIfMissing: true,
      });
    } catch {
      // The hierarchy transaction has committed. Let the client distinguish
      // this from a rolled-back save and refresh both case and invoice views.
      broadcastCaseUpdated(found.id);
      throw new HttpError(
        500,
        "Clinical details were saved, but the invoice could not be synchronized. Review the refreshed case and invoice before retrying."
      );
    }

    broadcastCaseUpdated(found.id);
    return res
      .status(200)
      .json(
        UpdateCaseRestorationHierarchy200Response.parse({
          ok: true,
          data: {
            ...result,
            invoiceAction: invoiceResult.action,
            invoiceId: invoiceResult.invoiceId,
          },
        })
      );
}
router.patch(
  "/:caseId/restorations/hierarchy",
  asyncHandler((req, res) => updateCaseRestorationHierarchy(req, res))
);

router.patch(
  "/:caseId/restorations/:restorationId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccessOrPromote(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const restoration = await db.query.caseRestorations.findFirst({
      where: and(
        eq(caseRestorations.id, req.params.restorationId),
        eq(caseRestorations.caseId, found.id)
      ),
    });
    if (!restoration) throw new HttpError(404, "Restoration not found.");

    const input = z
      .object({
        toothNumber: z.string().min(1).optional(),
        restorationType: z.string().optional(),
        ...implantInputFields,
        material: z.string().nullable().optional(),
        shade: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        quantity: z.coerce.number().int().positive().optional(),
        unitPrice: z.coerce.number().min(0).optional(),
        restorationSubtype: z.string().nullable().optional(),
        arch: z.enum(ARCH_VALUES).nullable().optional(),
        // Opt out of mirroring this edit onto a linked upper/lower sibling.
        // Row-scoped editors (the Lab Slip's per-restoration shade control)
        // send false so they change exactly the row the user touched.
        syncLinkedArch: z.boolean().optional(),
      })
      .parse(req.body);

    const patchFields: any = {};
    for (const field of IMPLANT_FIELDS) {
      if (input[field] !== undefined) patchFields[field] = input[field]?.trim() || null;
    }
    if (input.toothNumber !== undefined) patchFields.toothNumber = input.toothNumber;
    if (input.restorationType !== undefined) patchFields.restorationType = input.restorationType || null;
    if (input.material !== undefined) patchFields.material = input.material || null;
    if (input.shade !== undefined) patchFields.shade = input.shade || null;
    if (input.notes !== undefined) patchFields.notes = input.notes || null;
    if (input.quantity !== undefined) patchFields.quantity = input.quantity;
    if (input.restorationSubtype !== undefined) patchFields.restorationSubtype = input.restorationSubtype || null;
    if (input.arch !== undefined) patchFields.arch = normalizeArch(input.arch);
    const resultingType = input.restorationType ?? restoration.restorationType;
    const resultingSubtype = input.restorationSubtype !== undefined
      ? input.restorationSubtype
      : restoration.restorationSubtype;
    if (isArchApplicable(resultingType, resultingSubtype) &&
        !normalizeArch(input.arch !== undefined ? input.arch : restoration.arch)) {
      throw new HttpError(400, "Arch is required for Removable and Ortho restorations.");
    }
    if (input.unitPrice !== undefined) {
      patchFields.unitPrice = input.unitPrice.toFixed(2);
      patchFields.priceSource = "manual";
      patchFields.priceSourceId = null;
      patchFields.priceSourceName = null;
    }
    if (input.unitPrice === undefined && restoration.priceSource !== "manual" &&
        ((input.material !== undefined && (input.material || null) !== restoration.material) ||
         (input.restorationSubtype !== undefined && (input.restorationSubtype || null) !== restoration.restorationSubtype) ||
         (input.restorationType !== undefined && input.restorationType !== restoration.restorationType))) {
      const price = await resolveServerPriceWithSource({
        labOrganizationId: found.labOrganizationId,
        doctorName: found.doctorName,
        providerOrganizationId: found.providerOrganizationId,
      }, input.material !== undefined ? input.material || null : restoration.material,
      resultingType, resultingSubtype);
      if (!price && /^(crown|pontic)$/i.test(resultingType)) {
        throw new HttpError(422, "This material needs a catalog price. Choose a priced product or have an authorized user set its price.");
      }
      if (price) {
        patchFields.unitPrice = price.amount.toFixed(2);
        patchFields.priceSource = price.source;
        patchFields.priceSourceId = price.sourceId;
        patchFields.priceSourceName = price.sourceName;
        patchFields.priceKey = price.key;
      }
    }

    if (Object.keys(patchFields).length === 0) {
      return ok(res, restoration);
    }
    if (/^(crown|pontic)$/i.test(resultingType)) {
      const manualFields = new Set(restoration.assignmentProvenance?.manualFields ?? []);
      if (input.restorationType !== undefined || input.toothNumber !== undefined) manualFields.add("role");
      if (input.material !== undefined || input.restorationSubtype !== undefined) manualFields.add("product");
      if (input.shade !== undefined) manualFields.add("shade");
      patchFields.assignmentProvenance = {
        ...restoration.assignmentProvenance,
        origin: restoration.assignmentProvenance?.origin ?? "manual",
        manualFields: [...manualFields],
      };
    }

    const [updated] = await db.transaction(async (tx) => {
      const [lockedCase] = await tx.select().from(cases).where(eq(cases.id, found.id)).for("update");
      const rows = await tx.select().from(caseRestorations).where(eq(caseRestorations.caseId, found.id));
      const current = rows.find((row) => row.id === restoration.id);
      if (!current) throw new HttpError(404, "Restoration not found.");
      if (patchFields.assignmentProvenance) {
        patchFields.assignmentProvenance = { ...current.assignmentProvenance, ...patchFields.assignmentProvenance,
          origin: current.assignmentProvenance?.origin ?? patchFields.assignmentProvenance.origin,
          manualFields: [...new Set([...(current.assignmentProvenance?.manualFields ?? []), ...patchFields.assignmentProvenance.manualFields])],
        };
      }
      const next = { ...current, ...patchFields };
      if (/^(crown|pontic)$/i.test(next.restorationType)) {
        const shapeChanged = input.toothNumber !== undefined || input.restorationType !== undefined || input.quantity !== undefined;
        const legacyShape = !/^(?:[1-9]|[12]\d|3[0-2]|[A-T])$/i.test(current.toothNumber) || current.quantity !== 1;
        if ((!legacyShape || shapeChanged) && (!/^(?:[1-9]|[12]\d|3[0-2]|[A-T])$/i.test(next.toothNumber) || next.quantity !== 1 || !next.material?.trim())) {
          throw new HttpError(400, "Each crown or pontic needs one tooth, one unit, and a catalog material.");
        }
        if (rows.some((row) => row.id !== next.id && !/^missing$/i.test(row.restorationType) && row.priceKey !== "alloy" &&
          expandToothAssignmentIdentifiers(row.toothNumber).includes(next.toothNumber))) {
          throw new HttpError(409, `Tooth #${next.toothNumber} already has an assignment.`);
        }
      }
      const nextRows = rows.map((row) => row.id === next.id ? next : row);
      const connectorText = serializeConnectorState(withPonticConnectorSuggestions(lockedCase.bridgeConnectors, nextRows, new Set()));
      const validation = validateToothConnectors(connectorText, nextRows);
      const priorErrors = new Set(validateToothConnectors(lockedCase.bridgeConnectors, rows).errors);
      const newErrors = validation.errors.filter((error) => !priorErrors.has(error));
      if (newErrors.length) throw new HttpError(400, `${newErrors.join(" ")} Disconnect incompatible units before changing their product.`);
      await tx.update(cases).set({ bridgeConnectors: connectorText || null }).where(eq(cases.id, found.id));
      return tx.update(caseRestorations)
      .set(patchFields)
      .where(eq(caseRestorations.id, restoration.id))
      .returning()
      .catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to update restoration. Please try again.",
      }));
    });

    // Upper + Lower is represented by two durable sources. The server owns the
    // transition so clients update one logical appliance instead of racing two
    // restoration PATCH requests.
    const requestedArch =
      input.arch !== undefined ? normalizeArch(input.arch) : undefined;
    const sibling = await db.query.caseRestorations.findFirst({
      where: and(
        eq(caseRestorations.caseId, found.id),
        ne(caseRestorations.id, restoration.id),
        eq(caseRestorations.restorationType, restoration.restorationType),
        or(
          eq(caseRestorations.arch, "upper"),
          eq(caseRestorations.arch, "lower"),
        ),
      ),
    });
    if (requestedArch === "upper" || requestedArch === "lower") {
      if (sibling) {
        await db
          .delete(caseRestorations)
          .where(eq(caseRestorations.id, sibling.id));
      }
    } else if (requestedArch === "upper_lower") {
      await db.update(caseRestorations).set({ arch: "upper" }).where(eq(caseRestorations.id, restoration.id));
      if (sibling) {
        const shared = {
          toothNumber: updated.toothNumber,
          restorationType: updated.restorationType,
          restorationSubtype: updated.restorationSubtype,
          arch: "lower" as const,
          material: updated.material,
          shade: updated.shade,
          notes: updated.notes,
          quantity: 1,
          unitPrice: updated.unitPrice,
          priceSource: updated.priceSource,
          priceSourceId: updated.priceSourceId,
          priceSourceName: updated.priceSourceName,
          priceKey: updated.priceKey,
        };
        await db
          .update(caseRestorations)
          .set(shared)
          .where(eq(caseRestorations.id, sibling.id));
      } else {
        await db.insert(caseRestorations).values({
          caseId: found.id,
          toothNumber: updated.toothNumber,
          ...implantValues(updated),
          restorationType: updated.restorationType,
          restorationSubtype: updated.restorationSubtype,
          arch: "lower",
          material: updated.material,
          shade: updated.shade,
          notes: updated.notes,
          quantity: 1,
          unitPrice: updated.unitPrice,
          priceSource: updated.priceSource,
          priceSourceId: updated.priceSourceId,
          priceSourceName: updated.priceSourceName,
          priceKey: updated.priceKey,
        });
      }
    } else if (sibling && input.syncLinkedArch !== false) {
      const sharedFields = ["restorationType", "restorationSubtype", "material", "shade", "notes", "unitPrice"];
      const siblingPatch: Record<string, unknown> = {};
      for (const field of sharedFields) {
        if (field in patchFields) siblingPatch[field] = patchFields[field];
      }
      if (Object.keys(siblingPatch).length) {
        await db
          .update(caseRestorations)
          .set(siblingPatch)
          .where(eq(caseRestorations.id, sibling.id));
      }
    }

    const actor = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "restoration_updated",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: actor?.initials || "SYS",
      metadataJson: {
        restorationId: restoration.id,
        before: restoration,
        after: patchFields,
      },
    }).catch((err: unknown): never => wrapDbError(err, {
      fallback: "Failed to record restoration_updated event.",
    }));

    // Clinical annotations are independent of charges; don't rebuild an invoice
    // (or re-quote an old rate) for a metadata-only edit.
    if (Object.keys(patchFields).some((key) => !(IMPLANT_FIELDS as readonly string[]).includes(key))) {
      await syncInvoiceFromRestorations({
        caseId: found.id,
        actorUserId: (req as any).auth.userId,
      });
    }

    broadcastCaseUpdated(found.id);
    return ok(res, updated);
  })
);

router.patch(
  "/:caseId/restorations/:restorationId/price",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccessOrPromote(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );

    const restoration = await db.query.caseRestorations.findFirst({
      where: and(
        eq(caseRestorations.id, req.params.restorationId),
        eq(caseRestorations.caseId, found.id)
      ),
    });
    if (!restoration) throw new HttpError(404, "Restoration not found.");

    const input = z
      .object({
        unitPrice: z.coerce.number().min(0),
        reason: z.string().max(500).optional(),
      })
      .parse(req.body);

    const beforeUnitPrice = restoration.unitPrice;
    const beforePriceSource = restoration.priceSource;

    const [updated] = await db
      .update(caseRestorations)
      .set({
        unitPrice: input.unitPrice.toFixed(2),
        priceSource: "manual",
        priceSourceId: null,
        priceSourceName: input.reason ?? null,
      })
      .where(eq(caseRestorations.id, restoration.id))
      .returning()
      .catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to update restoration price. Please try again.",
      }));

    const actor = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "case_restoration_price_updated",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: actor?.initials || "SYS",
      metadataJson: {
        restorationId: restoration.id,
        toothNumber: restoration.toothNumber,
        restorationType: restoration.restorationType,
        beforeUnitPrice,
        beforePriceSource,
        afterUnitPrice: input.unitPrice.toFixed(2),
        reason: input.reason ?? null,
      },
    }).catch((err: unknown): never => wrapDbError(err, {
      fallback: "Failed to record case_restoration_price_updated event.",
    }));

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "case_restoration_price_updated",
      entityType: "case",
      entityId: found.id,
      beforeJson: { unitPrice: beforeUnitPrice, priceSource: beforePriceSource },
      afterJson: {
        unitPrice: input.unitPrice.toFixed(2),
        priceSource: "manual",
        reason: input.reason ?? null,
      },
    });

    await syncInvoiceFromRestorations({
      caseId: found.id,
      actorUserId: (req as any).auth.userId,
    });

    await touchCase(found.id);

    return ok(res, updated);
  })
);

router.post(
  "/:caseId/submissions",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.providerOrganizationId
    );
    const input = z
      .object({
        submissionType: z.enum(["note", "photo", "video", "document"]),
        payloadJson: z.record(z.string(), z.any()),
      })
      .parse(req.body);

    const [submission] = await db
      .insert(caseSubmissionQueue)
      .values({
        caseId: found.id,
        submittedByUserId: (req as any).auth.userId,
        submittedByOrganizationId: found.providerOrganizationId,
        submissionType: input.submissionType,
        payloadJson: input.payloadJson,
      })
      .returning();

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "provider_submission_received",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.providerOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        submissionId: submission.id,
        submissionType: submission.submissionType,
      },
    }).catch((err: unknown): never => wrapDbError(err, {
      fallback: "Failed to record provider_submission_received event.",
    }));

    await touchCase(found.id);

    return ok(res, submission, 201);
  })
);

router.get(
  "/:caseId/submissions",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );
    const submissions =
      await db.query.caseSubmissionQueue.findMany({
        where: eq(caseSubmissionQueue.caseId, found.id),
        orderBy: [desc(caseSubmissionQueue.createdAt)],
      });
    return ok(res, submissions);
  })
);

router.post(
  "/submissions/:submissionId/approve",
  asyncHandler(async (req, res) => {
    const submission =
      await db.query.caseSubmissionQueue.findFirst({
        where: eq(caseSubmissionQueue.id, req.params.submissionId),
      });
    if (!submission) throw new HttpError(404, "Submission not found.");
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      submission.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );

    const [approved] = await db
      .update(caseSubmissionQueue)
      .set({
        status: "approved",
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(caseSubmissionQueue.id, submission.id))
      .returning();

    if (
      submission.submissionType === "note" &&
      typeof (submission.payloadJson as any)?.noteText === "string"
    ) {
      await db.insert(caseNotes).values({
        caseId: submission.caseId,
        authorUserId: submission.submittedByUserId,
        authorOrganizationId: submission.submittedByOrganizationId,
        noteText: (submission.payloadJson as any).noteText,
        visibility: "shared_with_provider",
      }).catch((err: unknown): never => wrapDbError(err, {
        fallback: "Failed to save approved submission note.",
      }));
    }

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: submission.caseId,
      eventType: "provider_submission_approved",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        submissionId: submission.id,
        submissionType: submission.submissionType,
      },
    }).catch((err: unknown): never => wrapDbError(err, {
      fallback: "Failed to record provider_submission_approved event.",
    }));

    broadcastCaseUpdated(submission.caseId);
    return ok(res, approved);
  })
);

router.post(
  "/submissions/:submissionId/reject",
  asyncHandler(async (req, res) => {
    const submission =
      await db.query.caseSubmissionQueue.findFirst({
        where: eq(caseSubmissionQueue.id, req.params.submissionId),
      });
    if (!submission) throw new HttpError(404, "Submission not found.");
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      submission.caseId
    );
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );
    const input = z
      .object({ reviewNotes: z.string().max(1000).optional() })
      .parse(req.body ?? {});

    const [rejected] = await db
      .update(caseSubmissionQueue)
      .set({
        status: "rejected",
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
        reviewNotes: input.reviewNotes ?? null,
      })
      .where(eq(caseSubmissionQueue.id, submission.id))
      .returning();

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: submission.caseId,
      eventType: "provider_submission_rejected",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: { submissionId: submission.id },
    }).catch((err: unknown): never => wrapDbError(err, {
      fallback: "Failed to record provider_submission_rejected event.",
    }));

    broadcastCaseUpdated(submission.caseId);
    return ok(res, rejected);
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// iTero Lab-Review auto-import
// ─────────────────────────────────────────────────────────────────────────────

const iteroImportUpload = multer({
  storage: productionMediaDiskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(caseMediaDir, { recursive: true });
      } catch {
        /* ignore */
      }
      cb(null, caseMediaDir);
    },
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname || "") || "").toLowerCase();
      const safe =
        path
          .basename(file.originalname || "rx", ext)
          .replace(/[^a-zA-Z0-9\-_]+/g, "-")
          .slice(0, 60) || "rx";
      cb(null, `${Date.now()}-${randomBytes(4).toString("hex")}-${safe}${ext}`);
    },
  }, "case-import"),
  limits: { fileSize: 50 * 1024 * 1024 },
});

let cachedIteroOpenAIClient: OpenAI | null | undefined;
function getIteroOpenAIClient(): OpenAI | null {
  if (cachedIteroOpenAIClient !== undefined) return cachedIteroOpenAIClient;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) {
    cachedIteroOpenAIClient = null;
    return null;
  }
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  cachedIteroOpenAIClient = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
  return cachedIteroOpenAIClient;
}

const ITERO_RX_SYSTEM_PROMPT = `You are a dental laboratory prescription reader. Analyze the iTero Lab-Review prescription and extract every available field. Return ONLY valid JSON with this exact shape (use null for any field you cannot determine — never guess):

{
  "doctorName": "Dr. Full Name",
  "patientFirstName": "First",
  "patientLastName": "Last",
  "caseType": "one of EXACTLY: Crown & Bridge, Removable, Appliance, Other",
  "arch": "for Removable or Ortho/full-arch Appliance only: exactly Upper, Lower, or Upper + Lower; null when absent or ambiguous",
  "removableSubtype": "for Removable caseType only — one of EXACTLY: flipper | partial | denture | repair_partial | repair_denture | repair | null. Use null for all non-Removable cases and when the Rx is unclear about the specific type.",
  "material": "one of: Zirconia, Porcelain Fused to Zirconia, PFM, Lithium Disilicate, Full Cast, Composite, Acrylic, Resin, Valplast, Flexible, Metal, PMMA, Other",
  "shade": "global shade value like A2 or BL2 (use when all teeth share the same shade)",
  "perToothShades": "for flippers only — when individual teeth have different shades in the notes (e.g. \\"shade #3-A4; shade #29-C2\\"), emit { \\"3\\": \\"A4\\", \\"29\\": \\"C2\\" }; null when all teeth share a single shade or the case is not a flipper",
  "teeth": "see rules below — comma-separated Universal numbers (e.g. \\"29,30,31\\") OR an arch token for full-arch removables (\\"Upper\\", \\"Lower\\", \\"U/D\\", \\"U/P\\", \\"L/D\\", \\"L/P\\")",
  "dueDate": "YYYY-MM-DD or null",
  "isRush": false,
  "notes": "ONLY the free-text content the doctor actually typed in the 'Notes' section of the document (typically on page 2, labeled 'Notes'). Do NOT include Order number, Procedure, Type, Stage, Gingival shade, or any other structured field here — those are captured in separate fields. If there is no Notes section or it is blank, use null.",
  "gingivialShade": "for Removable cases only — the gingival/base tissue shade color listed under 'Gingival' in the Denture details (e.g. 'Light Pink', 'Medium Pink', 'Dark Pink'). Use null for all non-Removable cases and when not present.",
  "stage": "the stage from the 'Denture details' section (e.g. 'Finish Final', 'Wax Setup', 'Custom Tray', 'Rims and Plates'). Use null if not present.",
  "practiceName": "dental practice or office name",
  "restorations": [
    {
      "teeth": "comma-separated tooth numbers for individual crowns of the same material (e.g. \\"3, 4, 5\\") OR a dash range for a bridge (e.g. \\"8-10\\")",
      "material": "same material values as above, or null",
      "type": "Crown, Bridge, Pontic, Veneer, Inlay, Onlay, Implant Crown, etc.",
      "isBridge": false
    }
  ]
}

iTero-specific field mappings (IMPORTANT — iTero uses different field names than a paper Rx):
- The "Procedure" field on iTero Rxs maps to caseType. Mappings:
    "Fixed Restorative" → "Crown & Bridge"
    "Removable Prosthetics" or "Removable" → "Removable"
    "Orthodontics" or "Appliance" → "Appliance"
- The "Treatment Information" table is the authoritative source for teeth, treatment type, and material. Read every row. The "Tooth No." column gives the Universal tooth number. The "Treatment" column (Crown, Bridge, Veneer, Inlay, Onlay, etc.) determines caseType. The "Material" column gives the material — strip the "Ceramic:" prefix if present (e.g. "Ceramic: Zirconia" → "Zirconia", "Ceramic: E.max" → "Lithium Disilicate", "Ceramic: Lithium Disilicate" → "Lithium Disilicate").

MATERIAL NAMING RULES (apply consistently — output the canonical name on the right):
- "PFZ", "porcelain fused to zirconia", "Ceramic: PFZ" → "Porcelain Fused to Zirconia" (IMPORTANT: this is DISTINCT from "Zirconia" — always emit "Porcelain Fused to Zirconia" so the lab can charge the layered-porcelain surcharge)
- "Zirconia", "Zirc", "Zr", "Brux", "BruxZ", "Bruxzir", "BZR", "Ceramic: Zirconia" → "Zirconia"
- "Emax", "E.max", "lithium disilicate", "lithium silicate" → "Lithium Disilicate" (NEVER output "E.max" — always use "Lithium Disilicate")
- "PFM", "porcelain fused to metal" → "PFM"
- Shade columns may be split into Incisal/Body/Gingival (e.g. "-/A2/-"). Extract the first non-dash segment as the shade (e.g. "-/A2/-" → "A2", "BL2/BL2/-" → "BL2").

caseType bucketing rules — pick exactly one:
- "Crown & Bridge" — single crowns, bridges (any span), veneers, implant crowns, inlays, onlays, anything in the "Fixed Restorative" iTero procedure category.
  Examples: "#3 PFM" → Crown & Bridge + PFM on tooth 3. "#29-31 Zirc" → Crown & Bridge + Zirconia on teeth 29,30,31. Treatment table rows of "Crown" on teeth 30,31 → Crown & Bridge + teeth "30,31".
- "Removable" — full dentures, partial dentures, immediates, overdentures, flippers.
  Examples: "Upper acrylic denture" or "U/D" → Removable + Acrylic + teeth "Upper". "Upper partial / U/P" → Removable + (Acrylic | Resin | Valplast | Flexible) + teeth "Upper".
- "Appliance" — night guards, retainers, sports guards, snore guards, bleach trays, splints.
- "Other" — anything that doesn't cleanly fit the buckets above.

teeth field rules:
- PRIMARY source: if a "Treatment Information" or "Tooth Diagram" table is visible, read every tooth number listed there. Emit all of them as a comma-separated list.
- For Crown & Bridge / Appliance with specific teeth: comma-separated Universal numbers (1–32). Expand spans like "#29-31" into "29,30,31".
- For full-arch Removable cases: emit ONE of the literal arch tokens "Upper", "Lower", "U/D", "U/P", "L/D", "L/P" (NOT a numeric range).
- For partial dentures listing specific teeth being replaced, emit the arch token (e.g. "U/P").
- Convert FDI to Universal if needed.

restorations array rules:
- Populate this array for Crown & Bridge cases to describe each restoration group.
- Group same-material, same-type individual restorations (e.g. all PFM Crowns) into one element using a comma-separated teeth list: "3, 4, 5, 6, 7, 8".
- For a connected bridge span (abutments + pontics), use a dash range: "8-10" and set isBridge: true.
- Mixed materials produce separate elements: one per (material, type) combination.
- For Removable / Appliance / Other cases, omit this field or emit an empty array.

Removable subtype classification rules (populate removableSubtype for ALL Removable cases):
- flipper: notes mention "flipper", OR 1–3 specific teeth are being replaced. IMPORTANT: for flippers, each listed tooth is a SEPARATE physical appliance (a flipper for tooth 3 is a different item from a flipper for tooth 29). Populate perToothShades when the prescription specifies individual shades per tooth (e.g. "shade #3-A4; shade #29-C2" → { "3": "A4", "29": "C2" }). Set shade to null when all shades are captured in perToothShades.
- partial: notes mention "partial" without full-arch indication, OR 4+ teeth on one arch are listed without "denture".
- denture: full arch is specified ("Upper", "Lower", or arch token U/D / L/D / U/P / L/P), OR notes say "denture" without "partial".
- repair_partial: any of — "repair partial", "add tooth to partial", "add tooth to lower/upper partial", "replace tooth on partial", or "repair" + tooth number in a partial context.
- repair_denture: any of — "repair denture", "add tooth to denture", "repair full denture", "replace tooth on denture", or "repair" + full-arch context.
- repair: any of "repair", "fix", "add tooth", "replace tooth" with NO indication of whether the appliance is a partial or a full denture (ambiguous — admin must choose).
- For any repair subtype (repair_partial, repair_denture, repair), set step: null explicitly.

Material-from-notes override rule (CRITICAL):
- The doctor's typed Notes section is authoritative for material when it specifies one. If the Notes say "flex base", "flexible", or "valplast", set material to "Flexible" or "Valplast" respectively — even if the iTero Type field says "Partial Denture Acrylic". The doctor's written instructions always override the structured Type field for material.
- Examples: Type="Partial Denture Acrylic" but Notes="flipper #3 and #29 flex base" → material="Flexible". Type="Denture Acrylic" but Notes="valplast partial" → material="Valplast".

Notes field restriction (CRITICAL):
- The "notes" field must contain ONLY text the doctor personally typed in the "Notes" section (page 2 of the iTero document, labeled "Notes"). This typically includes clinical instructions, special requests, shade callouts per tooth, and material clarifications.
- Do NOT put any of the following into "notes": Order number, Procedure, Type/material from the Type field, Stage, Gingival shade, Mould, Shade system name, or any other pre-filled iTero structured field. Those are captured in their own JSON fields.
- If the Notes section is blank or absent, set notes to null.

Stage / step mapping rules:
- "Finish Final", "Finish", "Final", "Finished", "Process", "Processed", "Complete" → stage = "Finish Final" (use the exact text from the document).
- "Wax Setup", "Wax Try-In", "Wax Try In", "Wax" → stage = "Wax Setup".
- "Custom Tray", "Tray" → stage = "Custom Tray".
- "Rims and Plates", "Rims", "Rim", "Base Plate", "Bite Rim" → stage = "Rims and Plates".
- If no Stage/Denture details section is visible, set stage to null.

Other rules:
- If a name appears in "Last, First" form, swap to "First Last" and remove the comma.
- Only set isRush=true when the Rx is explicitly marked rush/urgent/STAT.
- Return ONLY the JSON object — no commentary, no markdown fences.`;

/**
 * Normalize the AI-extracted caseType into one of the four buckets the
 * Overview tab's Rx summary recognizes. Defensive against the model
 * occasionally returning legacy values (e.g. "Crown", "Full Denture",
 * "Night Guard") instead of the bucketed name.
 */
function normalizeIteroCaseType(
  raw: string | null | undefined,
): "Crown & Bridge" | "Removable" | "Appliance" | "Other" {
  if (!raw) return "Other";
  const v = raw.trim().toLowerCase();
  if (!v) return "Other";
  if (
    v === "crown & bridge" ||
    v === "crown and bridge" ||
    v === "c&b" ||
    v === "fixed restorative" ||
    v === "fixed" ||
    /\b(crown|bridge|veneer|inlay|onlay|implant|fixed)\b/.test(v)
  ) {
    return "Crown & Bridge";
  }
  if (/\b(denture|partial|removable|flipper|overdenture|immediate|prosthetic)\b/.test(v)) {
    return "Removable";
  }
  if (/\b(guard|retainer|splint|appliance|tray|nightguard|orthodontic)\b/.test(v)) {
    return "Appliance";
  }
  return "Other";
}

/**
 * Normalize iTero shade strings. iTero encodes shade as three slash-separated
 * segments for Incisal / Body / Gingival (e.g. "-/A2/-" or "BL2/BL2/-").
 * Extract the first non-dash, non-empty segment as the representative shade.
 */
function normalizeIteroShade(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "-") return null;
  // Handle slash-separated format: "-/A2/-", "BL2/BL2/-", "A2/A2/A3"
  if (trimmed.includes("/")) {
    const segments = trimmed.split("/").map((s) => s.trim()).filter((s) => s && s !== "-");
    return segments[0] ?? null;
  }
  return trimmed;
}

/**
 * Map an iTero Rx stage string to one of the valid case step keys.
 * Stage and step are the same concept — "Finish Final" means the case
 * has been processed/finished.
 *
 * Valid step values: custom_tray | rims_and_plates | wax_setup | process
 */
function normalizeIteroStage(
  raw: string | null | undefined,
): "custom_tray" | "rims_and_plates" | "wax_setup" | "process" | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (/\b(finish|final|finished|process|processed|complete|completed)\b/.test(v)) return "process";
  if (/\b(wax|try.?in)\b/.test(v)) return "wax_setup";
  if (/\b(custom.?tray|tray)\b/.test(v)) return "custom_tray";
  if (/\b(rim|plate|bite)\b/.test(v)) return "rims_and_plates";
  return null;
}

function buildIteroAttachmentUrl(
  req: Request,
  filename: string
): string {
  const forwardedHost = req.header("x-forwarded-host");
  const host = forwardedHost || req.get("host") || "localhost";
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto
    ? forwardedProto.split(",")[0]!.trim()
    : (req.protocol || "https");
  return `${protocol}://${host}/api/cases/attachment-file/${filename}`;
}

async function generateIteroCaseNumber(
  _labOrganizationId: string
): Promise<string> {
  // case_number has a GLOBAL unique constraint, so we must find the global max
  // for this year — not just within one lab — to avoid cross-lab collisions.
  const year = String(new Date().getFullYear()).slice(2);
  const [row] = await db
    .select({
      maxCaseNumber: sql<string | null>`max(
        case
          when ${cases.caseNumber} ~ ${`^${year}-(\\d+)$`}
          then regexp_replace(${cases.caseNumber}, ${`^${year}-(\\d+)$`}, '\\1')::int
          else null
        end
      )`,
    })
    .from(cases);
  const next = (Number(row?.maxCaseNumber ?? 0) || 0) + 1;
  return `${year}-${next}`;
}

// `case_number` carries a GLOBAL unique constraint and is generated as
// `max(case_number) + 1`, so two concurrent imports (multiple poller orders, or
// parallel test forks sharing one DB) can read the same max and collide on
// INSERT. Detect that specific duplicate-key error so the caller can regenerate
// the number and retry instead of surfacing a 500.
function isCaseNumberUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur != null && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    const code = e.code;
    const constraint = typeof e.constraint === "string" ? e.constraint : "";
    const message = typeof e.message === "string" ? e.message : "";
    if (
      code === "23505" &&
      (constraint.includes("case_number") || message.includes("case_number"))
    ) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

function isBarcodeConflict(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur != null && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (
      e.code === "23505" &&
      typeof e.constraint === "string" &&
      e.constraint === "cases_barcode_unique_per_lab"
    ) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

export interface ExtractedRxFields {
  doctorName?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  caseType?: string | null;
  arch?: string | null;
  /** AI-classified removable subtype for Removable cases. */
  removableSubtype?: "flipper" | "partial" | "denture" | "repair_partial" | "repair_denture" | "repair" | null;
  material?: string | null;
  shade?: string | null;
  teeth?: string | null;
  dueDate?: string | null;
  scanDate?: string | null;
  platformCaseIdentifier?: string | null;
  isRush?: boolean | null;
  /** ONLY doctor-typed Notes section text — no structured fields. */
  notes?: string | null;
  practiceName?: string | null;
  /** Per-tooth shade map for flippers (e.g. { "3": "A4", "29": "C2" }). */
  perToothShades?: Record<string, string> | null;
  restorations?: Array<{
    teeth: string;
    material: string | null;
    type: string;
    isBridge: boolean;
  }> | null;
  /** Gingival/base tissue shade for Removable cases (e.g. "Light Pink"). */
  gingivialShade?: string | null;
  /** Stage from Denture details (e.g. "Finish Final", "Wax Setup"). Maps to case step. */
  stage?: string | null;
}

export async function extractRxFieldsFromBuffer(
  openai: OpenAI,
  buf: Buffer,
  mimeType: string,
  originalName: string
): Promise<ExtractedRxFields> {
  // Detect PDFs by mime type, filename, OR magic bytes ("%PDF-" → 0x25 0x50
  // 0x44 0x46). iTero Rx files always arrive as PDFs, and some clients send a
  // generic octet-stream mime, so the magic-byte check is the reliable signal.
  const isPdf =
    mimeType.toLowerCase().includes("pdf") ||
    originalName.toLowerCase().endsWith(".pdf") ||
    (buf.length >= 5 &&
      buf[0] === 0x25 &&
      buf[1] === 0x50 &&
      buf[2] === 0x44 &&
      buf[3] === 0x46);

  // Build the vision image set. The Replit AI Integrations proxy does NOT
  // support the OpenAI Files API (`POST /files` → 400 "not supported"), so we
  // CANNOT use openai.files.create() / responses.create() with a file_id for
  // native PDF understanding. Instead we rasterize the PDF to JPEG page images
  // with pdftoppm and feed them to the vision (chat.completions image_url) API
  // — the same proven path the /analyze-prescription endpoint uses. This makes
  // server-side extraction work for ALL callers (the background poller and any
  // client) without depending on client-sent hints.
  const imageDataUrls: string[] = [];
  if (isPdf) {
    const pages = await convertPdfBufferToImageDataUrls(buf);
    if (pages.length === 0) return {};
    imageDataUrls.push(...pages);
  } else {
    imageDataUrls.push(
      `data:${mimeType || "image/jpeg"};base64,${buf.toString("base64")}`
    );
  }

  const extractionSignal = AbortSignal.timeout(75_000);
  const resp = await boundedOperation(openai.chat.completions.create({
    model: "gpt-5.4",
    messages: [
      { role: "system", content: ITERO_RX_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this iTero Lab-Review prescription." },
          ...imageDataUrls.map(
            (url) =>
              ({
                type: "image_url" as const,
                image_url: { url, detail: "high" as const },
              })
          ),
        ],
      },
    ],
    max_completion_tokens: 1500,
  }, { timeout: 75_000, maxRetries: 0, signal: extractionSignal }), extractionSignal);
  const text = resp.choices?.[0]?.message?.content || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    return JSON.parse(m[0]) as ExtractedRxFields;
  } catch {
    return {};
  }
}

// ── Per-lab iTero auto-link-suggested-practice setting ───────────────────────
//
// Stored in the global `system_settings` key/value table, keyed per lab so
// each lab can independently opt in/out of letting the iTero auto-poller
// override the desktop poller's default provider with the AI-suggested one.
// Default = OFF (caller must explicitly enable it per-lab in Settings →
// iTero auto-import).
const ITERO_AUTO_LINK_SETTING_PREFIX = "itero_auto_link_practice:";
function iteroAutoLinkSettingKey(labOrgId: string): string {
  return `${ITERO_AUTO_LINK_SETTING_PREFIX}${labOrgId}`;
}
async function getIteroAutoLinkSuggestedPractice(
  labOrgId: string,
): Promise<boolean> {
  if (!labOrgId) return false;
  const row = await db.query.systemSettings.findFirst({
    where: eq(systemSettings.key, iteroAutoLinkSettingKey(labOrgId)),
  });
  return row?.value === "true";
}
async function setIteroAutoLinkSuggestedPractice(
  labOrgId: string,
  enabled: boolean,
  _updatedByUserId: string | null,
): Promise<void> {
  const key = iteroAutoLinkSettingKey(labOrgId);
  const value = enabled ? "true" : "false";
  // systemSettings only persists key/value/updatedAt — the actor identity is
  // captured in the audit log entry written by the PUT handler instead.
  await db
    .insert(systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

const iteroImportBodySchema = z.object({
  toothAssignments: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { throw new HttpError(400, "Invalid tooth assignment JSON."); }
  }, z.array(z.object({
    toothNumber: z.string().regex(/^(?:[1-9]|[12]\d|3[0-2]|[A-T])$/),
    restorationType: z.enum(["Crown", "Pontic"]),
    material: z.string().trim().min(1), shade: z.string().optional(),
    restorationSubtype: z.string().optional(), quantity: z.literal(1).default(1),
    unitPrice: z.coerce.number().min(0).optional(),
    priceOverridden: z.boolean().optional(),
  })).max(32).optional()),
  bridgeConnectors: z.string().max(1024).optional(),
  reviewedRestorationsHint: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { throw new HttpError(400, "Invalid reviewed restoration JSON."); }
  }, z.array(z.object({
    toothNumber: z.string().max(100),
    restorationType: z.string().trim().min(1).max(100),
    restorationSubtype: z.string().max(200).nullable().optional(),
    arch: z.enum(["upper", "lower", "both"]).nullable().optional(),
    material: z.string().max(200).nullable().optional(),
    shade: z.string().max(100).nullable().optional(),
    quantity: z.coerce.number().int().positive().default(1),
  })).max(100).optional()),
  iteroOrderId: z.string().min(1, "iteroOrderId is required"),
  labOrganizationId: z.string().min(1, "labOrganizationId is required"),
  providerOrganizationId: z
    .string()
    .min(1, "providerOrganizationId is required"),
  receivedAt: calendarDate.optional(),
  scanDateHint: z.union([calendarDate, z.literal("")]).optional(),
  rxDueDateHint: z.string().optional(),
  labDueDateHint: z.union([calendarDate, z.literal("")]).optional(),
  externalPatientIdHint: z.string().max(500).optional(),
  providerContactSnapshot: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { throw new HttpError(400, "Invalid provider contact snapshot JSON."); }
  }, z.record(z.string(), z.unknown()).optional()),
  invoiceNotesHint: z.string().max(10_000).optional(),
  // Optional client hints — used as fallbacks when AI fails to extract them.
  // The drop zone pre-extracts these via analyze-prescription (vision API) and
  // sends them so the case is always fully populated even when the server-side
  // openai.files.create() PDF extraction is unavailable.
  doctorNameHint: z.string().optional(),
  patientFirstNameHint: z.string().optional(),
  patientLastNameHint: z.string().optional(),
  casePanBarcodeHint: z.string().optional(),
  dueDateHint: z.string().optional(),
  shadeHint: z.string().optional(),
  toothIndicesHint: z.string().optional(),
  materialHint: z.string().optional(),
  caseTypeHint: z.string().optional(),
  removableSubtypeHint: z.union([
    z.enum(["partial", "denture", "flipper", "repair_partial", "repair_denture", "repair"]),
    z.literal(""),
  ]).optional(),
  archHint: z.string().optional(),
  notesHint: z.string().optional(),
  invoiceOverrideLines: multipartReviewedInvoiceLines,
  isRushHint: z.string().optional(),
  // Remake metadata. When a user drops an iTero ZIP and chooses "Link as
  // remake" in the duplicate prompt, the desktop client forwards these so the
  // imported case is linked to the original (suffixed number + cross-link
  // events) exactly like the generic ZIP-import path. `remakeCharged` arrives
  // as a FormData string ("true"/"false") and is coerced server-side.
  remakeOfCaseId: z.string().optional(),
  remakeReason: z.string().optional(),
  remakeCharged: z.enum(["true", "false"]).optional(),
  // Structured remake fields forwarded when the user fills the questionnaire
  // in the desktop duplicate-detection prompt. FormData coercions below.
  remakeReasonKey: z.enum(REMAKE_REASON_KEYS).optional(),
  remakeShadeLightness: z.enum(["light", "dark"]).optional(),
  remakeShadePrescribed: z.string().optional(),
  remakeShadeProvided: z.string().optional(),
  remakeMaterialPrescribed: z.string().optional(),
  remakeMaterialProvided: z.string().optional(),
  /** Arrives as FormData string "true"/"false" — coerced in the handler. */
  remakeReturnedToLab: z.enum(["true", "false"]).optional(),
  remakeCategory: z.enum(["crown_bridge", "removable"]).optional(),
  remakeNotes: z.string().max(2000).optional(),
  // Strict doctor-not-on-file gate (Task #2853). Arrives as a FormData string.
  // When the scanned doctor is not an exact match and the user explicitly chose
  // "add new doctor" in the resolution step, the client re-submits with this set
  // so the server creates the case verbatim instead of re-blocking.
  confirmNewDoctor: z.enum(["true", "false"]).optional(),
});

// ── ZIP import config ────────────────────────────────────────────────────────

const iteroZipUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const tmpDir = path.join(os.tmpdir(), "labtrax-itero-zip");
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
      cb(null, tmpDir);
    },
    filename: (_req, _file, cb) => {
      cb(null, `${Date.now()}-${randomBytes(4).toString("hex")}.zip`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});

const iteroZipImportBodySchema = z.object({
  labOrganizationId: z.string().min(1, "labOrganizationId is required"),
  providerOrganizationId: z
    .string()
    .min(1, "providerOrganizationId is required"),
  receivedAt: calendarDate.optional(),
  doctorNameHint: z.string().optional(),
  patientFirstNameHint: z.string().optional(),
  patientLastNameHint: z.string().optional(),
  toothIndicesHint: z.string().optional(),
  shadeHint: z.string().optional(),
  materialHint: z.string().optional(),
  caseTypeHint: z.string().optional(),
  archHint: z.string().optional(),
  dueDateHint: z.string().optional(),
  notesHint: z.string().optional(),
  invoiceOverrideLines: multipartReviewedInvoiceLines,
});

const EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ply": "application/octet-stream",
  ".stl": "application/octet-stream",
  ".obj": "application/octet-stream",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".txt": "text/plain",
  ".zip": "application/zip",
};

router.post(
  "/import-from-itero-rx",
  iteroImportUpload.single("file"),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const body = iteroImportBodySchema.parse(req.body ?? {});
    validateCustomRemakeReason(body.remakeReasonKey, body.remakeReason);
    if (body.remakeReasonKey === "other" && body.remakeReason !== undefined) {
      body.remakeReason = body.remakeReason.trim();
    }
    const batchId = randomBytes(8).toString("hex");

    if (!req.file) {
      throw new HttpError(400, "Rx file is required (field name 'file').");
    }

    // Lab membership is required to create cases for this organization.
    await requireMembership(userId, body.labOrganizationId);
    if (body.invoiceOverrideLines !== undefined) {
      await requireAnyRole(userId, body.labOrganizationId, ADMIN_ROLES);
    }

    // Cheap optimistic dedup check so we skip OpenAI calls for already-imported
    // orders. The authoritative dedup is the unique-index claim INSIDE the
    // transaction below; this check is purely an optimization.
    const preExisting = await db.query.iteroImportedOrders.findFirst({
      where: and(
        eq(iteroImportedOrders.labOrganizationId, body.labOrganizationId),
        eq(iteroImportedOrders.iteroOrderId, body.iteroOrderId)
      ),
    });
    if (preExisting && preExisting.createdCaseId) {
      // Verify the referenced case still exists and hasn't been soft-deleted.
      // If it's gone (failed import, soft-delete, or cross-environment ID), the
      // dedup record is stale — wipe it so this import can proceed fresh.
      const liveCase = await db.query.cases.findFirst({
        where: and(
          eq(cases.id, preExisting.createdCaseId),
          notDeleted(cases)
        ),
        columns: { id: true, caseNumber: true },
      });
      if (liveCase) {
        try {
          if (req.file?.path) fs.unlinkSync(req.file.path);
        } catch {
          /* ignore */
        }
        await db
          .update(iteroImportedOrders)
          .set({ lastSeenAt: new Date() })
          .where(eq(iteroImportedOrders.id, preExisting.id));
        return ok(res, {
          deduped: true,
          caseId: preExisting.createdCaseId,
          caseNumber: liveCase.caseNumber,
          iteroOrderId: preExisting.iteroOrderId,
        });
      }
      // Stale dedup record — delete it so the transaction can claim a fresh slot.
      req.log?.warn?.(
        { iteroOrderId: body.iteroOrderId, staleCreatedCaseId: preExisting.createdCaseId },
        "iTero dedup: stale record found (case missing or deleted) — clearing and re-importing"
      );
      await db
        .delete(iteroImportedOrders)
        .where(eq(iteroImportedOrders.id, preExisting.id));
    } else if (preExisting && !preExisting.createdCaseId) {
      // A previous import started but its transaction rolled back leaving a
      // null-caseId sentinel. Clear it so this request can proceed.
      req.log?.warn?.(
        { iteroOrderId: body.iteroOrderId },
        "iTero dedup: stuck null-caseId slot found — clearing and re-importing"
      );
      await db
        .delete(iteroImportedOrders)
        .where(eq(iteroImportedOrders.id, preExisting.id));
    }

    // AI extraction (best-effort — if AI is unconfigured or fails, we still
    // create a stub case so the user can fix the extracted fields as needed).
    let extracted: ExtractedRxFields = {};
    const openai = getIteroOpenAIClient();
    if (openai) {
      try {
        const buf = await fs.promises.readFile(req.file.path);
        extracted = await extractRxFieldsFromBuffer(
          openai,
          buf,
          req.file.mimetype || "application/octet-stream",
          req.file.originalname || "rx"
        );
      } catch (err) {
        req.log?.warn?.(
          { err: (err as Error)?.message },
          "iTero Rx AI extraction failed; creating case with hints only"
        );
      }
    }

    // Client fields are the reviewed values, not fallback guesses. When
    // present they take precedence over the server's independent AI extraction,
    // including empty values that intentionally clear a field.
    // Older clients supplied one dueDateHint for both fields. Preserve that
    // contract while explicit new prescription/lab fields, including clears,
    // remain authoritative and the AI's requested date stays separate.
    const reviewedPrescriptionDueDate = body.rxDueDateHint !== undefined
      ? body.rxDueDateHint : body.dueDateHint;
    if (reviewedPrescriptionDueDate !== undefined) extracted.dueDate = reviewedPrescriptionDueDate;
    if (body.scanDateHint !== undefined) extracted.scanDate = body.scanDateHint || null;
    if (body.externalPatientIdHint !== undefined) extracted.platformCaseIdentifier = body.externalPatientIdHint;
    if (body.shadeHint !== undefined) extracted.shade = body.shadeHint;
    if (body.toothIndicesHint !== undefined) extracted.teeth = body.toothIndicesHint;
    if (body.materialHint !== undefined) extracted.material = body.materialHint;
    if (body.caseTypeHint !== undefined) extracted.caseType = body.caseTypeHint;
    if (body.removableSubtypeHint !== undefined) extracted.removableSubtype = body.removableSubtypeHint || null;
    if (body.archHint !== undefined) extracted.arch = body.archHint || null;
    if (body.notesHint !== undefined) extracted.notes = body.notesHint;
    // Canonicalize the material name (zirconia / Emax→Lithium Disilicate / PFM
    // rules) BEFORE it is stored and before price resolution, so the lab-slip
    // material and the invoice price always agree.
    extracted.material = normalizeMaterialName(extracted.material) ?? extracted.material;
    if (body.isRushHint !== undefined) extracted.isRush = body.isRushHint === "true";

    const patientFirstName =
      (extracted.patientFirstName?.trim() || body.patientFirstNameHint?.trim() ||
        "Unknown");
    const patientLastName =
      (extracted.patientLastName?.trim() || body.patientLastNameHint?.trim() ||
        "Patient");
    // The desktop "doctor not on file" resolution step (Task #2853) only sends
    // confirmNewDoctor="true" AFTER the user explicitly picked an existing
    // doctor or chose "add new" — and forwards that decision as doctorNameHint.
    // In that case the human-confirmed identity is authoritative and MUST win
    // over fresh server-side AI re-extraction of the PDF; otherwise picking an
    // existing doctor could be silently overridden by the near-miss the re-parse
    // produced (and then bypass the gate as a brand-new doctor). Outside that
    // flow, server AI extraction stays authoritative with the hint as fallback.
    const doctorResolvedByUser =
      body.confirmNewDoctor === "true" && !!body.doctorNameHint?.trim();
    const doctorName = doctorResolvedByUser
      ? body.doctorNameHint!.trim()
      : (extracted.doctorName?.trim() || body.doctorNameHint?.trim() ||
        "Unknown Doctor");

    // ── Suggest an existing doctor when AI name is similar but not exact ──
    // Query distinct (doctorName, providerOrganizationId) groups for this lab,
    // compute bigram similarity, and surface the closest match above 0.4 as a
    // "Did you mean?" prompt in the desktop review banner.
    let suggestedDoctorName: string | null = null;
    let suggestedProviderOrgId: string | null = null;
    if (doctorName !== "Unknown Doctor") {
      const existingGroups = await db
        .selectDistinct({
          doctorName: cases.doctorName,
          providerOrganizationId: cases.providerOrganizationId,
        })
        .from(cases)
        .where(
          and(
            eq(cases.labOrganizationId, body.labOrganizationId),
            notDeleted(cases)
          )
        );

      let bestSim = 0;
      let bestMatch: { doctorName: string; providerOrganizationId: string } | null = null;
      const normExtracted = _normalizeDoctorForSim(doctorName);
      for (const g of existingGroups) {
        if (_normalizeDoctorForSim(g.doctorName) === normExtracted) continue;
        const sim = _bigramSimilarity(doctorName, g.doctorName);
        if (sim >= 0.4 && sim > bestSim) {
          bestSim = sim;
          bestMatch = g;
        }
      }
      if (bestMatch) {
        suggestedDoctorName = bestMatch.doctorName;
        suggestedProviderOrgId = bestMatch.providerOrganizationId;
      }
    }

    // ── Practice-name fallback: match extracted practiceName to a provider org ──
    // When doctor-name similarity produced no org suggestion, try matching the
    // AI-extracted practice name directly against provider organizations.
    if (!suggestedProviderOrgId && extracted.practiceName?.trim()) {
      suggestedProviderOrgId = await _findProviderOrgByPracticeName(
        body.labOrganizationId,
        extracted.practiceName
      );
    }

    // ── Per-lab opt-in: auto-link the AI-suggested practice on creation ──
    // When the lab has enabled the "auto-link AI-suggested practice" toggle
    // AND the similarity match returned a non-empty suggestion that differs
    // from the poller's default provider, prefer the AI's choice. The
    // suggestion field is cleared because it has now been applied; a
    // dedicated case event records the auto-link so reverts are easy.
    let effectiveProviderOrgId: string = body.providerOrganizationId;
    let autoLinkedFromAi = false;
    if (
      suggestedProviderOrgId &&
      suggestedProviderOrgId !== body.providerOrganizationId &&
      (await getIteroAutoLinkSuggestedPractice(body.labOrganizationId))
    ) {
      effectiveProviderOrgId = suggestedProviderOrgId;
      autoLinkedFromAi = true;
    }

    // ── Strict "doctor not on file" gate (Task #2853) ────────────────────────
    // iTero auto-import previously auto-merged/auto-created doctors. That let a
    // mis-scanned name silently spawn or absorb a doctor with no human check.
    // Instead we now apply the SAME strict exact-match rule the mobile AI reader
    // uses via GET /doctors/resolve-name (both call the shared resolveDoctorName
    // helper): unless the scanned name EXACTLY matches an existing doctor in the
    // effective practice — trim + collapse internal whitespace + case-insensitive,
    // with NO title/name stripping — block creation with a structured 409 so the
    // client can surface similar doctors + "Add new doctor". Runs AFTER the
    // practice is finalized so "same practice" reflects any AI auto-link above.
    //
    // Skipped for remakes (the doctor is inherited from the original case, not
    // freshly scanned) and for the "Unknown Doctor" placeholder (already flagged
    // needsAiReview; there is no real name to confirm). Auto-merge is removed, so
    // the former auto-merge audit fields stay null.
    let effectiveDoctorName = doctorName;
    const doctorAutoMergedFrom: string | null = null;
    const doctorAutoMergeSimilarity: number | null = null;
    if (!body.remakeOfCaseId && doctorName !== "Unknown Doctor") {
      const resolution = await resolveDoctorName(
        body.labOrganizationId,
        effectiveProviderOrgId,
        doctorName,
      );
      if (resolution.exactMatch) {
        // Adopt the stored canonical spelling so pricing/invoice lookups key off
        // the existing doctor identity.
        effectiveDoctorName = resolution.exactMatch;
      } else if (body.confirmNewDoctor !== "true") {
        throw new HttpError(
          409,
          "This scanned doctor is not on file for this practice. Please confirm which doctor this is or add a new doctor.",
          {
            code: "DOCTOR_CONFIRMATION_REQUIRED",
            doctorName: doctorName.trim(),
            providerOrganizationId: effectiveProviderOrgId,
            candidates: resolution.similarMatches,
          },
        );
      }
      // else confirmNewDoctor="true" → create verbatim (effectiveDoctorName
      // stays the scanned name).
    }
    // The suggestion banner is redundant once we've adopted an exact name.
    if (
      suggestedDoctorName &&
      suggestedDoctorName.trim().toLowerCase() ===
        effectiveDoctorName.trim().toLowerCase()
    ) {
      suggestedDoctorName = null;
    }

    // ── Remake link resolution ───────────────────────────────────────────────
    // When the desktop "Link as remake" flow forwarded a remake target, resolve
    // it against BOTH the canonical `cases` table and the legacy `lab_cases`
    // table (same resolver the generic /cases create path uses). The new case
    // gets a suffixed number, remakeOfCaseId/Reason/Charged, and cross-link
    // events — mirroring the generic ZIP-import remake path. Cross-tenant
    // linking is blocked by the resolver.
    const remakeChargedFlag =
      body.remakeCharged === "true"
        ? true
        : body.remakeCharged === "false"
          ? false
          : null;
    const remakeOriginal = body.remakeOfCaseId
      ? await resolveRemakeOriginal(
          body.remakeOfCaseId,
          body.labOrganizationId,
          effectiveProviderOrgId,
          effectiveDoctorName,
        )
      : null;
    if (body.remakeOfCaseId && !remakeOriginal) {
      throw new HttpError(404, "Original case for remake not found in this lab.");
    }
    const noChargeRemake = !!remakeOriginal && remakeChargedFlag === false;

    const reviewedLabDueDate = body.labDueDateHint !== undefined
      ? body.labDueDateHint
      : body.rxDueDateHint === undefined ? body.dueDateHint : undefined;
    const labDueDateText = reviewedLabDueDate?.trim();
    const normalizedReviewedLabDate = labDueDateText
      ? normalizeDueDateForInputServer(labDueDateText)
      : null;
    const iteroReviewedLabDate = normalizedReviewedLabDate
      ? calendarDateToUtcNoon(normalizedReviewedLabDate)
      : null;
    const iteroAutoLabOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, body.labOrganizationId),
      columns: { defaultCaseDueDays: true, capCaseDueToDefault: true },
    });
    const iteroReviewedPrescriptionDate = normalizeDueDateForInputServer(
      extracted.dueDate ?? "",
    );
    const iteroPrescriptionDueDate = resolveAiIntakePrescriptionDueDate(
      iteroReviewedPrescriptionDate,
      body.receivedAt ?? new Date().toISOString().slice(0, 10),
      iteroAutoLabOrg?.defaultCaseDueDays,
    );
    const dueDate = reviewedLabDueDate !== undefined
      ? iteroReviewedLabDate
      : resolveCaseDueDate(
          null,
          new Date(),
          iteroAutoLabOrg?.defaultCaseDueDays,
          iteroAutoLabOrg?.capCaseDueToDefault,
        );

    // Resolve any AI-derived restoration rows BEFORE the transaction so the
    // pricing lookups don't hold open the dedup-claim transaction.

    // Build tooth list from the top-level teeth string first, then fall back
    // to aggregating tooth numbers from the per-group restorations array. The
    // AI sometimes populates restorations[].teeth but leaves the top-level
    // teeth field empty, especially for Crown & Bridge cases.
    let teethList = (extracted.teeth || "")
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    if (teethList.length === 0 && extracted.restorations && extracted.restorations.length > 0) {
      const fromRest: string[] = [];
      for (const r of extracted.restorations) {
        for (const seg of (r.teeth || "").split(",")) {
          const trimmed = seg.trim();
          // Expand bridge spans like "8-10" → "8","9","10"
          const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
          if (rangeMatch) {
            const lo = parseInt(rangeMatch[1], 10);
            const hi = parseInt(rangeMatch[2], 10);
            for (let i = lo; i <= hi && i - lo <= 32; i++) fromRest.push(String(i));
          } else if (/^\d+$/.test(trimmed)) {
            fromRest.push(trimmed);
          }
        }
      }
      teethList = [...new Set(fromRest)];
    }

    let prebuiltRestorations: Array<{
      toothNumber: string;
      restorationType: string;
      restorationSubtype: string | null;
      arch?: Arch | null;
      material: string | null;
      shade: string | null;
      unitPrice: string;
      priceSource: string | null;
      priceSourceId: string | null;
      priceSourceName: string | null;
      priceKey: string | null;
      quantity?: number;
    }> = [];

    // Bucket the AI-extracted caseType into one of the four restorative
    // categories the Overview Rx summary recognizes (Crown & Bridge /
    // Removable / Appliance / Other). This guards against the model
    // returning legacy granular values like "Crown" or "Full Denture".
    // Fall back to "Other" when caseType is absent but clinical data exists,
    // so the Lab Slip Rx Summary always shows something useful.
    const normalizedCaseType = extracted.caseType
      ? normalizeIteroCaseType(extracted.caseType)
      : (teethList.length > 0 || extracted.material || extracted.shade ? "Other" : null);
    if (normalizedCaseType) {
      extracted.caseType = normalizedCaseType;
    }

    // Derive restorationSubtype from the normalised caseType + material so each
    // restoration row carries the encoded taxonomy key without a later re-derive.
    // When the AI returned an explicit removableSubtype, use it as the fast-path
    // subtype so we store "removable/flippers" etc. instead of guessing from text.
    const iteroAiRemovableSubtype = mapAiRemovableSubtype(extracted.removableSubtype);
    const iteroIsAmbiguousRepair = isAmbiguousRemovableSubtype(extracted.removableSubtype);
    const { restorationSubtype: iteroRestorationSubtype } = normalizeCaseHierarchy({
      caseType: normalizedCaseType ?? null,
      material: extracted.material ?? null,
      subtype: iteroAiRemovableSubtype ?? undefined,
    });
    const iteroArchMissing =
      isArchApplicable(normalizedCaseType, iteroRestorationSubtype) &&
      !normalizeArch(extracted.arch);
    const iteroArch = normalizeArch(extracted.arch);

    if (teethList.length > 0 && normalizedCaseType) {
      if (normalizedCaseType === "Removable") {
        // Flippers: each tooth is a separate physical appliance — one row per tooth.
        // All other removables (partials, dentures, repairs): collapse to one row.
        if (iteroAiRemovableSubtype === "flippers") {
          prebuiltRestorations = await Promise.all(
            teethList.map(async (toothNumber) => {
              const toothShade = extracted.perToothShades?.[toothNumber] ?? extracted.shade;
              const fallback = await resolveServerPriceWithSource(
                {
                  labOrganizationId: body.labOrganizationId,
                  doctorName: effectiveDoctorName,
                  providerOrganizationId: effectiveProviderOrgId,
                },
                extracted.material ?? null,
                normalizedCaseType
              );
              return {
                toothNumber,
                restorationType: iteroIsAmbiguousRepair ? "Removable Repair" : normalizedCaseType,
                restorationSubtype: iteroRestorationSubtype ?? null,
                material: extracted.material ?? null,
                shade: normalizeIteroShade(toothShade),
                unitPrice: (fallback?.amount ?? 0).toFixed(2),
                priceSource: fallback?.source ?? null,
                priceSourceId: fallback?.sourceId ?? null,
                priceSourceName: fallback?.sourceName ?? null,
                priceKey: fallback?.key ?? null,
              };
            })
          );
        } else {
          const fallback = await resolveServerPriceWithSource(
            {
              labOrganizationId: body.labOrganizationId,
              doctorName: effectiveDoctorName,
              providerOrganizationId: effectiveProviderOrgId,
            },
            extracted.material ?? null,
            normalizedCaseType
          );
          prebuiltRestorations = [{
            toothNumber: teethList.join(", "),
            restorationType: iteroIsAmbiguousRepair ? "Removable Repair" : normalizedCaseType,
            restorationSubtype: iteroRestorationSubtype ?? null,
            material: extracted.material ?? null,
            shade: normalizeIteroShade(extracted.shade),
            unitPrice: (fallback?.amount ?? 0).toFixed(2),
            priceSource: fallback?.source ?? null,
            priceSourceId: fallback?.sourceId ?? null,
            priceSourceName: fallback?.sourceName ?? null,
            priceKey: fallback?.key ?? null,
          }];
        }
      } else {
        prebuiltRestorations = await Promise.all(
          teethList.map(async (toothNumber) => {
            const fallback = await resolveServerPriceWithSource(
              {
                labOrganizationId: body.labOrganizationId,
                doctorName: effectiveDoctorName,
                providerOrganizationId: effectiveProviderOrgId,
              },
              extracted.material ?? null,
              normalizedCaseType
            );
            return {
              toothNumber,
              restorationType: iteroIsAmbiguousRepair ? "Removable Repair" : normalizedCaseType,
              restorationSubtype: iteroRestorationSubtype ?? null,
              material: extracted.material ?? null,
              shade: normalizeIteroShade(extracted.shade),
              unitPrice: (fallback?.amount ?? 0).toFixed(2),
              priceSource: fallback?.source ?? null,
              priceSourceId: fallback?.sourceId ?? null,
              priceSourceName: fallback?.sourceName ?? null,
              priceKey: fallback?.key ?? null,
            };
          })
        );
      }
    } else if (normalizedCaseType || extracted.material || extracted.shade) {
      // No specific teeth identified but we have Rx clinical info — create a
      // single summary restoration so the Lab Slip shows type/material/shade.
      // Matches the fallback behaviour in the general Rx-analysis path.
      prebuiltRestorations = [{
        toothNumber: "",
        restorationType: iteroIsAmbiguousRepair ? "Removable Repair" : (normalizedCaseType ?? "Other"),
        restorationSubtype: iteroRestorationSubtype ?? null,
        material: extracted.material ?? null,
        shade: normalizeIteroShade(extracted.shade),
        unitPrice: "0.00",
        priceSource: null,
        priceSourceId: null,
        priceSourceName: null,
        priceKey: null,
      }];
    }

    if (body.toothAssignments) {
      if (new Set(body.toothAssignments.map((unit) => unit.toothNumber)).size !== body.toothAssignments.length) {
        throw new HttpError(400, "A tooth cannot have two assignments.");
      }
      const validation = validateToothConnectors(body.bridgeConnectors, body.toothAssignments);
      if (!validation.valid) throw new HttpError(400, validation.errors.join(" "));
      const assignedRestorations = await Promise.all(body.toothAssignments.map(async (unit) => {
        const price = await resolveServerPriceWithSource({
          labOrganizationId: body.labOrganizationId, doctorName: effectiveDoctorName,
          providerOrganizationId: effectiveProviderOrgId,
        }, unit.material, unit.restorationType, unit.restorationSubtype ?? null);
        const manualPrice = unit.priceOverridden === true || (unit.unitPrice ?? 0) > 0;
        return { ...unit, restorationSubtype: unit.restorationSubtype ?? null,
          shade: unit.shade ?? null, unitPrice: (manualPrice ? unit.unitPrice ?? 0 : price?.amount ?? 0).toFixed(2),
          priceSource: manualPrice ? "manual" : price?.source ?? null,
          priceSourceId: manualPrice ? null : price?.sourceId ?? null,
          priceSourceName: manualPrice ? null : price?.sourceName ?? null,
          priceKey: price?.key ?? null };
      }));
      const assignmentKey = (toothNumber: string | null | undefined) =>
        (toothNumber ?? "").trim().replace(/^#/, "").toUpperCase();
      const assignedByTooth = new Map(
        assignedRestorations.map((restoration) => [
          assignmentKey(restoration.toothNumber),
          restoration,
        ]),
      );
      const appliedAssignments = new Set<string>();
      const mergedRestorations = prebuiltRestorations.flatMap((restoration) => {
        const toothNumber = assignmentKey(restoration.toothNumber);
        // A toothless extraction summary is only a fallback. Once explicit
        // chart rows exist, retain the extracted rows with tooth identities
        // and let the chart supply the more precise billable rows.
        if (!toothNumber && assignedByTooth.size > 0) return [];
        const assigned = assignedByTooth.get(toothNumber);
        if (!assigned) return [restoration];
        appliedAssignments.add(toothNumber);
        return [assigned];
      });
      for (const [toothNumber, restoration] of assignedByTooth) {
        if (!appliedAssignments.has(toothNumber)) mergedRestorations.push(restoration);
      }
      prebuiltRestorations = mergedRestorations;
    }
    if (body.reviewedRestorationsHint) {
      prebuiltRestorations = await Promise.all(body.reviewedRestorationsHint.map(async (restoration) => {
        const price = await resolveServerPriceWithSource({
          labOrganizationId: body.labOrganizationId,
          doctorName: effectiveDoctorName,
          providerOrganizationId: effectiveProviderOrgId,
        }, restoration.material ?? null, restoration.restorationType, restoration.restorationSubtype ?? null);
        return {
          toothNumber: restoration.toothNumber,
          restorationType: restoration.restorationType,
          restorationSubtype: restoration.restorationSubtype ?? null,
          arch: restoration.arch === "both"
            ? normalizeArch("both")
            : restoration.arch ?? iteroArch,
          material: restoration.material ?? null,
          shade: restoration.shade ?? null,
          unitPrice: (price?.amount ?? 0).toFixed(2),
          priceSource: price?.source ?? null,
          priceSourceId: price?.sourceId ?? null,
          priceSourceName: price?.sourceName ?? null,
          priceKey: price?.key ?? null,
          quantity: restoration.quantity,
        };
      }));
    }
    const connectorRestorations = body.toothAssignments ??
      body.reviewedRestorationsHint?.filter((restoration) => /^(Crown|Pontic)$/.test(restoration.restorationType));
    if (body.bridgeConnectors && connectorRestorations) {
      const validation = validateToothConnectors(body.bridgeConnectors, connectorRestorations as any);
      if (!validation.valid) throw new HttpError(400, validation.errors.join(" "));
    }
    const user = (req as any).user;
    const storageKey = buildIteroAttachmentUrl(req, req.file.filename);

    // Atomic write: dedup claim + case + restorations + notes + attachment +
    // back-fill + event all happen in one transaction. If ANY step fails,
    // Postgres rolls back the dedup-claim row too, freeing the iTero order
    // for retry on the next poll cycle. The only success path commits the
    // claim with createdCaseId set, so future requests see the existing case.
    const runImportTx = (caseNumber: string, barcode: string | null) =>
      db.transaction(async (tx) => {
      const [claim] = await tx
        .insert(iteroImportedOrders)
        .values({
          labOrganizationId: body.labOrganizationId,
          iteroOrderId: body.iteroOrderId,
          createdCaseId: null,
          importedByUserId: userId,
          batchId,
        })
        .onConflictDoNothing({
          target: [
            iteroImportedOrders.labOrganizationId,
            iteroImportedOrders.iteroOrderId,
          ],
        })
        .returning();

      if (!claim) {
        const existing = await tx.query.iteroImportedOrders.findFirst({
          where: and(
            eq(iteroImportedOrders.labOrganizationId, body.labOrganizationId),
            eq(iteroImportedOrders.iteroOrderId, body.iteroOrderId)
          ),
        });
        // Only return deduped when the referenced case is alive.
        // A null createdCaseId means another concurrent request's transaction is
        // still in-flight (or rolled back leaving a stuck slot that the pre-check
        // should have cleaned up). Throw so the client can retry.
        if (existing?.createdCaseId) {
          const liveCase = await tx.query.cases.findFirst({
            where: and(eq(cases.id, existing.createdCaseId), notDeleted(cases)),
            columns: { id: true, caseNumber: true },
          });
          if (liveCase) {
            await tx
              .update(iteroImportedOrders)
              .set({ lastSeenAt: new Date() })
              .where(eq(iteroImportedOrders.id, existing.id));
            return {
              kind: "deduped" as const,
              existing: { ...existing, caseNumber: liveCase.caseNumber },
            };
          }
        }
        throw new HttpError(
          409,
          "A previous import for this order is still in progress or failed to complete. Please retry in a moment."
        );
      }

      // For remake imports, compute the next letter suffix (B, C, D, …)
      // against the ROOT of the chain under a transaction-scoped advisory lock
      // so the count + insert are atomic — mirrors the generic /cases create
      // path. The suffixed number replaces the generated iTero number entirely.
      // Remaking a non-root node (e.g. "26-334B") yields "26-334C", not "BB".
      let effectiveCaseNumber = caseNumber;
      if (remakeOriginal) {
        const remakeRoot =
          remakeOriginal.kind === "canonical"
            ? await resolveRemakeRootCanonical(remakeOriginal.id, tx)
            : { id: remakeOriginal.id, caseNumber: remakeOriginal.caseNumber };

        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(1742068800, hashtext(${remakeRoot.id}))`,
        );

        const existingCount = await countAllRemakeDescendants(remakeRoot.id, tx);
        if (existingCount > 23) {
          throw new HttpError(
            409,
            `Too many remakes of case ${remakeRoot.caseNumber} (maximum 24).`,
          );
        }
        const suffixLetter = String.fromCharCode(66 + existingCount);
        effectiveCaseNumber = `${remakeRoot.caseNumber}${suffixLetter}`;
      }

      const [createdCase] = await tx
        .insert(cases)
        .values({
          caseNumber: effectiveCaseNumber,
          labOrganizationId: body.labOrganizationId,
          providerOrganizationId: effectiveProviderOrgId,
          patientFirstName,
          patientLastName,
          doctorName: effectiveDoctorName,
          status: "received",
          priority: extracted.isRush ? "rush" : "normal",
          receivedAt: parseCalendarDate(body.receivedAt),
          scanDate: body.scanDateHint !== undefined
            ? body.scanDateHint || null
            : (extracted.scanDate ? normalizeDueDateForInputServer(extracted.scanDate) : null),
          prescriptionDueDate: iteroPrescriptionDueDate,
          dueDate,
          expectedDeliveryDate: iteroReviewedLabDate
            ? null
            : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          createdByUserId: userId,
          aiImportSource: "itero",
          bridgeConnectors: connectorRestorations
            ? serializeConnectorState(withPonticConnectorSuggestions(body.bridgeConnectors, connectorRestorations as any)) || null
            : null,
          externalPatientId: body.externalPatientIdHint !== undefined
            ? body.externalPatientIdHint.trim() || null
            : body.iteroOrderId,
          providerContactSnapshot: body.providerContactSnapshot ?? null,
          rxNotes: extracted.notes?.trim() || null,
          shade: normalizeIteroShade(extracted.shade),
          step: normalizeIteroStage(extracted.stage) ?? null,
          gingivialShade: extracted.gingivialShade?.trim() || null,
          casePanBarcode: barcode,
          suggestedDoctorName,
          // When the per-lab "auto-link suggested practice" setting fired,
          // the suggestion has been applied — null it out so the review
          // banner doesn't re-prompt the reviewer with a now-stale choice.
          suggestedProviderOrgId: autoLinkedFromAi ? null : suggestedProviderOrgId,
          // Remake link metadata (only set when this import was marked as a
          // remake in the desktop duplicate prompt).
          remakeOfCaseId: remakeOriginal?.id ?? null,
          remakeReason: remakeOriginal ? body.remakeReason ?? null : null,
          remakeCharged: remakeOriginal ? remakeChargedFlag : null,
          remakeReasonKey: remakeOriginal ? body.remakeReasonKey ?? null : null,
          remakeShadeLightness: remakeOriginal ? body.remakeShadeLightness ?? null : null,
          remakeShadePrescribed: remakeOriginal ? body.remakeShadePrescribed ?? null : null,
          remakeShadeProvided: remakeOriginal ? body.remakeShadeProvided ?? null : null,
          remakeMaterialPrescribed: remakeOriginal ? body.remakeMaterialPrescribed ?? null : null,
          remakeMaterialProvided: remakeOriginal ? body.remakeMaterialProvided ?? null : null,
          remakeReturnedToLab: remakeOriginal
            ? body.remakeReturnedToLab === "true"
              ? true
              : body.remakeReturnedToLab === "false"
              ? false
              : null
            : null,
          remakeCategory: remakeOriginal
            ? (body.remakeCategory ?? inferRemakeCategory(body.remakeReasonKey) ?? null)
            : null,
          remakeNotes: remakeOriginal ? body.remakeNotes ?? null : null,
        })
        .returning();

      // Write remake cross-link events INSIDE the transaction so they are
      // atomic with case creation. The forward "remake_of" event always
      // goes on the new case; the reciprocal "remade_by" event goes on the
      if (extracted.notes?.trim()) {
        await appendRxNoteEntry(tx, {
          caseId: createdCase.id,
          submissionId: `itero-import:${createdCase.id}`,
          noteText: extracted.notes,
          provenance: "itero_import",
          scannedAt: createdCase.createdAt,
          preserveCurrentAsLegacy: false,
        });
      }

      // original only when it is a canonical case (legacy lab_cases originals
      // get their JSON-blob activityLog patched AFTER commit, since that table
      // can't participate in this Drizzle transaction).
      if (remakeOriginal) {
        await tx.insert(caseEvents).values({
          caseId: createdCase.id,
          eventType: "remake_of",
          actorUserId: userId,
          actorOrganizationId: body.labOrganizationId,
          actorInitials: user?.initials || "SYS",
          metadataJson: {
            originalCaseId: remakeOriginal.id,
            originalCaseNumber: remakeOriginal.caseNumber,
            originalCaseKind: remakeOriginal.kind,
            remakeReason: body.remakeReason ?? null,
            remakeCharged: remakeChargedFlag,
            note: `Marked as remake of ${remakeOriginal.kind === "legacy" ? "legacy " : ""}case ${remakeOriginal.caseNumber}${body.remakeReason ? ` (reason: ${body.remakeReason})` : ""}`,
          },
        });

        if (remakeOriginal.kind === "canonical") {
          await tx.insert(caseEvents).values({
            caseId: remakeOriginal.id,
            eventType: "remade_by",
            actorUserId: userId,
            actorOrganizationId: body.labOrganizationId,
            actorInitials: user?.initials || "SYS",
            metadataJson: {
              remakeCaseId: createdCase.id,
              remakeCaseNumber: createdCase.caseNumber,
              remakeReason: body.remakeReason ?? null,
              remakeCharged: remakeChargedFlag,
              note: `Case ${createdCase.caseNumber} created as a remake of this case${body.remakeReason ? ` (reason: ${body.remakeReason})` : ""}, charged: ${remakeChargedFlag === true ? "yes" : remakeChargedFlag === false ? "no" : "unspecified"}`,
            },
          });
        }
      }

      if (prebuiltRestorations.length > 0) {
        await tx.insert(caseRestorations).values(
          prebuiltRestorations.map((r) => ({
            caseId: createdCase.id,
            toothNumber: r.toothNumber,
            restorationType: r.restorationType,
            restorationSubtype: r.restorationSubtype ?? null,
            assignmentProvenance: body.toothAssignments && /^(Crown|Pontic)$/.test(r.restorationType)
              ? { origin: "manual" as const, manualFields: ["role" as const, "product" as const, "shade" as const] } : null,
            arch: r.arch ?? iteroArch,
            material: r.material,
            shade: r.shade,
            notes: null,
            quantity: r.quantity ?? 1,
            unitPrice: r.unitPrice,
            priceSource: r.priceSource,
            priceSourceId: r.priceSourceId,
            priceSourceName: r.priceSourceName,
            priceKey: r.priceKey,
          }))
        );
        await expandPersistedBothArchRows(tx, createdCase.id);
      }

      const [attachment] = await tx
        .insert(caseAttachments)
        .values({
          caseId: createdCase.id,
          uploadedByUserId: userId,
          uploadedByOrganizationId: body.labOrganizationId,
          fileName: req.file!.originalname || "iTero-Rx",
          storageKey,
          fileType: req.file!.mimetype || "application/octet-stream",
          visibility: "internal_lab_only",
        })
        .returning();

      await tx
        .update(iteroImportedOrders)
        .set({ createdCaseId: createdCase.id, lastSeenAt: new Date() })
        .where(eq(iteroImportedOrders.id, claim.id));

      await tx.insert(caseEvents).values({
        caseId: createdCase.id,
        eventType: "case_created_from_itero",
        actorUserId: userId,
        actorOrganizationId: body.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          iteroOrderId: body.iteroOrderId,
          aiExtracted: Object.keys(extracted ?? {}),
          attachmentId: attachment?.id,
        },
      });

      if (autoLinkedFromAi) {
        await tx.insert(caseEvents).values({
          caseId: createdCase.id,
          eventType: "provider_auto_linked_from_ai",
          actorUserId: userId,
          actorOrganizationId: body.labOrganizationId,
          actorInitials: user?.initials || "SYS",
          metadataJson: {
            source: "itero_auto_poller",
            fromProviderOrgId: body.providerOrganizationId,
            toProviderOrgId: effectiveProviderOrgId,
            suggestedDoctorName,
          },
        });
      }

      // Record the duplicate-doctor auto-merge so reviewers can see (and undo)
      // that the parsed name was reused as an existing doctor in this practice.
      if (doctorAutoMergedFrom && doctorAutoMergedFrom !== effectiveDoctorName) {
        await tx.insert(caseEvents).values({
          caseId: createdCase.id,
          eventType: "doctor_auto_merged_from_itero",
          actorUserId: userId,
          actorOrganizationId: body.labOrganizationId,
          actorInitials: user?.initials || "SYS",
          metadataJson: {
            source: "itero_auto_poller",
            parsedDoctorName: doctorAutoMergedFrom,
            mergedToDoctorName: effectiveDoctorName,
            similarity: doctorAutoMergeSimilarity,
            note: `Auto-import reused existing doctor "${effectiveDoctorName}" instead of creating "${doctorAutoMergedFrom}" (near-duplicate in this practice).`,
          },
        });
      }

      // ── Auto-create invoice from the AI-extracted restorations ──
      // Marked aiGenerated=true so the desktop UI shows a sparkle badge and
      // an "AI-imported — please review" banner that the billing user must
      // acknowledge via PATCH /api/invoices/:id/ai-review. If pricing for
      // any restoration fell back to a default, surface that warning so the
      // reviewer knows to double-check.
      let autoInvoiceId: string | null = null;
      try {
        const restorationRowsForInvoice = await tx.query.caseRestorations.findMany({
          where: eq(caseRestorations.caseId, createdCase.id),
          orderBy: [caseRestorations.createdAt],
        });
        const noteRowsForInvoice = extracted.notes && extracted.notes.trim()
          ? [{ noteText: `[iTero AI import] ${extracted.notes.trim()}` }]
          : [];
        const patientName = `${createdCase.patientFirstName ?? ""} ${createdCase.patientLastName ?? ""}`
          .replace(/\s+/g, " ")
          .trim();
        const teethList = restorationRowsForInvoice
          .map((r: any) => (r.toothNumber ?? "").trim())
          .filter(Boolean);
        const shadeList = Array.from(
          new Set(
            restorationRowsForInvoice
              .map((r: any) => (r.shade ?? "").trim())
              .filter(Boolean),
          ),
        );
        const displayMetadataJson = {
          patientName,
          billTo: (createdCase.doctorName ?? "").trim(),
          teeth: teethList.join(", "),
          shade: shadeList.join(", "),
          caseNotes: noteRowsForInvoice.map((n) => n.noteText).join("\n\n"),
        };

        const hasRestorations = prebuiltRestorations.length > 0;
        const fallbackPriced =
          hasRestorations &&
          prebuiltRestorations.some(
            (r) => r.priceSource === "fallback" || r.priceSource === null,
          );
        const aiPricingWarning = !hasRestorations
          ? "AI could not extract restorations from this Rx — please add line items and pricing before sending."
          : iteroIsAmbiguousRepair
            ? "Removable repair type is unclear — please select the correct subtype and verify pricing before sending."
            : fallbackPriced
              ? "Some line items use default/fallback pricing — please verify before sending."
              : null;

        // No-charge remake: still create the invoice so it shows in the
        // Invoice tab, but force every line to $0 and attach a note — same
        // intent as the generic /cases create path.
        const noChargeNote = noChargeRemake
          ? `No-charge remake of case ${remakeOriginal!.caseNumber}${body.remakeReason ? ` — reason: ${body.remakeReason}` : ""}`
          : null;
        const doctorIdentity = await ensureDoctorProfileIdentity(tx, {
          labOrganizationId: createdCase.labOrganizationId,
          providerOrganizationId: createdCase.providerOrganizationId ?? null,
          doctorName: createdCase.doctorName,
        });

        const autoInvoice = await insertOrResolveAiIntakeInvoice(tx, {
            invoiceNumber: `INV-${createdCase.caseNumber}`,
            caseId: createdCase.id,
            labOrganizationId: createdCase.labOrganizationId,
            providerOrganizationId: createdCase.providerOrganizationId,
            doctorIdentity,
            status: "open",
            displayMetadataJson,
            aiGenerated: true,
            aiPricingWarning: iteroArchMissing
              ? `${aiPricingWarning ? `${aiPricingWarning} ` : ""}Arch is missing — select an arch and verify clinical completeness before sending.`
              : aiPricingWarning,
            issuedAt: calendarDateToUtcNoon(createdCase.receivedAt),
            dueAt: invoiceDueDate(new Date()),
            createdByUserId: userId,
            updatedByUserId: userId,
            ...((noChargeNote || body.invoiceNotesHint?.trim())
              ? { notes: [noChargeNote, body.invoiceNotesHint?.trim()].filter(Boolean).join("\n\n") }
              : {}),
          }, createdCase.id, createdCase.labOrganizationId);

        if (autoInvoice.newlyCreated) {
          // Batch-fetch all custom labels for this lab in one query so
          // the per-restoration label resolution below is zero DB calls.
          const iteroLabelCache = hasRestorations
            ? await fetchLabItemLabels(createdCase.labOrganizationId)
            : ({} as Record<string, string>);
          const itemsToInsert: any[] = body.invoiceOverrideLines
            ? reviewedLinesToInvoiceItems(body.invoiceOverrideLines, autoInvoice.id)
            : hasRestorations
            ? await buildGroupedLineItemsForInvoice(
                restorationRowsForInvoice as any[],
                iteroLabelCache,
                autoInvoice.id,
                createdCase.labOrganizationId,
                extracted.restorations,
              )
            : [
                {
                  invoiceId: autoInvoice.id,
                  caseRestorationId: null,
                  toothNumber: null,
                  toothLabel: null,
                  description:
                    "[AI placeholder] Restorations could not be extracted — replace with actual line items.",
                  quantity: 1,
                  unitPrice: "0.00",
                  lineTotal: "0.00",
                  sortOrder: 0,
                },
              ];
          // No-charge remake: zero out every line item (price, total, and a
          // "(no-charge remake)" description suffix) so the invoice rings up
          // to $0 while the line detail stays visible. Also clear any child
          // sub-items (e.g. Layered Porcelain) so the whole invoice is $0.
          if (noChargeRemake) {
            for (const it of itemsToInsert) {
              it.description = `${it.description} (no-charge remake)`;
              it.unitPrice = "0.00";
              it.lineTotal = "0.00";
              it.childItems = [];
            }
          }
          const lineItemsMeta = itemsToInsert.map((it) => ({
            item: it.catalogItemLabel ?? it.description,
            description: it.description,
            catalogItemKey: it.catalogItemKey ?? null,
            missingCatalogItem: it.missingCatalogItem ?? false,
            subItems: (it.childItems ?? []).map((child: any) => ({ item: child.description, description: child.description })),
          }));
          await insertGroupedLineItemsWithChildren(tx, itemsToInsert);
          const subtotal = sumGroupedLineItemsTotal(itemsToInsert);
          await tx
            .update(invoices)
            .set({
              subtotal,
              total: subtotal,
              balanceDue: subtotal,
              displayMetadataJson: { ...displayMetadataJson, lineItems: lineItemsMeta, ...(body.invoiceOverrideLines ? { reviewedCharges: true } : {}) },
            })
            .where(eq(invoices.id, autoInvoice.id));
        }
        autoInvoiceId = autoInvoice.id;
      } catch (autoErr) {
        // Don't block case creation on a draft-invoice problem; the user
        // can still mint an invoice manually from the case drawer.
        req.log?.error(
          { err: autoErr, caseId: createdCase.id },
          "iTero auto-invoice creation failed",
        );
        throw new HttpError(500, "iTero case invoice could not be persisted.");
      }

      return { kind: "created" as const, createdCase, attachment, autoInvoiceId };
    });

    // Generate the case number INSIDE a retry loop: it is `max + 1` against a
    // globally-unique column, so a concurrent import can claim the same number
    // between our read and INSERT. On that specific collision we regenerate and
    // retry rather than 500 the caller.
    const MAX_CASE_NUMBER_ATTEMPTS = 5;
    let txResult: Awaited<ReturnType<typeof runImportTx>>;
    // The barcode hint is optional metadata — if it conflicts with an existing
    // case, strip it and proceed without it rather than failing the import.
    let barcodeForImport: string | null = body.casePanBarcodeHint?.trim() || null;
    for (let attempt = 1; ; attempt++) {
      const caseNumber = await generateIteroCaseNumber(body.labOrganizationId);
      try {
        txResult = await runImportTx(caseNumber, barcodeForImport);
        break;
      } catch (err) {
        if (isCaseNumberUniqueViolation(err) && attempt < MAX_CASE_NUMBER_ATTEMPTS) {
          req.log?.warn?.(
            { attempt, err: (err as Error)?.message },
            "iTero import: case number collision; regenerating and retrying"
          );
          continue;
        }
        // Barcode hint conflicts with an existing case — strip it and retry.
        // The casePanBarcodeHint is a convenience field from the iTero poller;
        // case creation must not fail permanently because of a barcode collision.
        if (isBarcodeConflict(err) && barcodeForImport !== null) {
          req.log?.warn?.(
            { barcode: barcodeForImport },
            "iTero import: barcode conflict; retrying without barcode hint"
          );
          barcodeForImport = null;
          // The transaction rolled back so the case number slot is available again.
          txResult = await runImportTx(caseNumber, null);
          break;
        }
        rethrowBarcodeConflict(err, barcodeForImport ?? "");
      }
    }

    if (txResult.kind === "deduped") {
      try {
        if (req.file?.path) fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
      const existing = txResult.existing;
      if (existing && existing.createdCaseId) {
        // Best-effort session record for the deduped import
        db.insert(iteroImportSessions).values({
          labOrganizationId: body.labOrganizationId,
          importedByUserId: userId,
          createdCount: 0,
          dedupedCount: 1,
          erroredCount: 0,
          caseIds: [],
          batchId,
        }).catch((err: unknown) => {
          req.log?.warn({ err }, "iTero rx: failed to write deduped session record (non-fatal)");
        });
        return ok(res, {
          deduped: true,
          caseId: existing.createdCaseId,
          caseNumber: existing.caseNumber,
          iteroOrderId: existing.iteroOrderId,
        });
      }
      // The order is being concurrently imported by another request that
      // hasn't committed yet — surface a 409 so the poller retries on the
      // next cycle. We never return deduped:true with a null caseId.
      throw new HttpError(409, "iTero order is already being imported; retry shortly.");
    }

    const { createdCase, attachment } = txResult;

    // Auto-add per-tooth alloy rows for PFM/FCM restorations when the lab
    // has opted in. Runs after the transaction so syncInvoiceFromRestorations
    // can rebuild the invoice with the alloy sub-items attached.
    // pfmOnly prevents a stray N/A alloy row on non-PFM cases.
    try {
      const labOrgForAlloy = await db.query.organizations.findFirst({
        where: eq(organizations.id, createdCase.labOrganizationId),
        columns: { autoAddAlloyOnPfm: true },
      });
      if (labOrgForAlloy?.autoAddAlloyOnPfm) {
        await addAlloyChargeToCase({
          caseRow: {
            id: createdCase.id,
            labOrganizationId: createdCase.labOrganizationId,
            providerOrganizationId: createdCase.providerOrganizationId ?? null,
            doctorName: createdCase.doctorName,
          },
          actorUserId: userId,
          actorInitials: "SYS",
          pfmOnly: true,
        });
      }
    } catch (alloyErr) {
      req.log?.warn({ err: alloyErr, caseId: createdCase.id }, "iTero single import: per-tooth alloy auto-add failed (non-fatal)");
    }

    await writeAuditLog({
      req,
      organizationId: body.labOrganizationId,
      action: "case_created_from_itero",
      entityType: "case",
      entityId: createdCase.id,
      afterJson: {
        case: createdCase,
        iteroOrderId: body.iteroOrderId,
        attachmentId: attachment?.id,
      },
    });

    // Legacy remake original: the reciprocal "remade_by" history lives in the
    // legacy lab_cases JSON blob, which can't join the Drizzle transaction
    // above. Write it after commit. (Canonical reciprocal events are already
    // written inside the transaction.)
    if (remakeOriginal && remakeOriginal.kind === "legacy") {
      await writeReciprocalRemadeBy(
        remakeOriginal,
        { id: createdCase.id, caseNumber: createdCase.caseNumber },
        body.remakeReason ?? null,
        remakeChargedFlag,
        {
          userId,
          orgId: body.labOrganizationId,
          initials: (req as any).user?.initials || "SYS",
        },
      );
    }

    // Mirror the uploaded Rx file to object storage so it survives server
    // restarts and re-deployments. Best-effort — never blocks the response.
    if (req.file?.path && req.file?.filename) {
      fs.promises.readFile(req.file.path)
        .then((buf) =>
          writeCaseMediaToObjectStorage(
            req.file!.filename,
            buf,
            req.file!.mimetype || "application/pdf",
          )
        )
        .catch((err: unknown) => {
          req.log?.warn({ err }, "iTero Rx: failed to mirror file to object storage");
        });
    }

    // Write notifications to lab admin(s) about the new iTero-imported case.
    // This is best-effort — never blocks the response.
    try {
      const adminMembers = await db
        .select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.labId, body.labOrganizationId),
            eq(organizationMemberships.status, "active"),
            inArray(organizationMemberships.role, ["owner", "admin"])
          )
        );

      if (adminMembers.length > 0) {
        // Classify the alert type for this import:
        //   "unknown doctor"   — AI couldn't extract a doctor name at all
        //   "stand-in doctor"  — a doctor name was extracted but it isn't in
        //                        the set of known doctors for this provider org
        //   "unknown practice" — provider org has NO prior cases in this lab
        //                        (brand-new / unrecognised practice relationship)
        //   normal             — everything resolved as expected
        const isUnknownDoctor =
          !doctorName?.trim() || doctorName.trim() === "Unknown Doctor";

        let isStandInDoctor = false;
        let isUnknownPractice = false;

        // Query prior-case history for this (lab, provider) pair, explicitly
        // excluding the case we just created so the baseline reflects
        // pre-import history only.
        const priorCaseDoctorRows = await db
          .selectDistinct({ doctorName: cases.doctorName })
          .from(cases)
          .where(
            and(
              eq(cases.labOrganizationId, body.labOrganizationId),
              eq(cases.providerOrganizationId, body.providerOrganizationId),
              ne(cases.id, createdCase.id),
              notDeleted(cases),
            )
          );

        const hasPriorCases = priorCaseDoctorRows.length > 0;

        if (!hasPriorCases) {
          // First-ever case from this practice at this lab — unknown practice.
          isUnknownPractice = true;
        } else if (!isUnknownDoctor) {
          // Practice is known; check whether the extracted doctor is familiar.
          const knownDoctors = new Set(
            priorCaseDoctorRows
              .map((r) => String(r.doctorName ?? "").trim().toLowerCase())
              .filter(Boolean)
          );
          const normName = doctorName.trim().toLowerCase();
          isStandInDoctor = knownDoctors.size > 0 && !knownDoctors.has(normName);
        }

        const isAlert = isUnknownDoctor || isStandInDoctor || isUnknownPractice;

        const notifType = isAlert ? "alert" : "case_imported_from_itero";

        let notifTitle: string;
        let notifBody: string;
        if (isUnknownDoctor) {
          notifTitle = `iTero case imported — unknown doctor`;
          notifBody = `Case ${createdCase.caseNumber} was auto-imported from iTero but the doctor name could not be identified. Please review and assign the correct provider.`;
        } else if (isUnknownPractice) {
          notifTitle = `iTero case imported — unknown practice`;
          notifBody = `Case ${createdCase.caseNumber} for ${patientFirstName} ${patientLastName} was imported from iTero for a practice with no prior case history. Please verify the provider assignment.`;
        } else if (isStandInDoctor) {
          notifTitle = `iTero case imported — unrecognised doctor`;
          notifBody = `Case ${createdCase.caseNumber} was imported from iTero with doctor "${doctorName}", who is not in the known provider list. This may be a stand-in — please review before sending.`;
        } else {
          notifTitle = `New iTero case: ${createdCase.caseNumber}`;
          notifBody = `Case ${createdCase.caseNumber} for ${patientFirstName} ${patientLastName} was imported from iTero.`;
        }

        await deliverInAppNotification({
          labOrganizationId: body.labOrganizationId,
          recipientUserIds: adminMembers.map((member) => member.userId),
          category: createdCase.priority === "rush" ? "rush_case" : "new_case",
          dedupeKey: `itero_case:${createdCase.id}`,
          type: notifType,
          title: notifTitle,
          body: notifBody,
          dataJson: {
            caseId: createdCase.id,
            caseNumber: createdCase.caseNumber,
            iteroOrderId: body.iteroOrderId,
            alertReason: isUnknownDoctor
              ? "unknown_doctor"
              : isUnknownPractice
                ? "unknown_practice"
                : isStandInDoctor
                  ? "stand_in_doctor"
                  : null,
          },
        });
      }
    } catch (notifErr) {
      req.log?.warn?.(
        { err: (notifErr as Error)?.message, caseId: createdCase.id },
        "iTero import: failed to write admin notifications (non-fatal)"
      );
    }

    // After commit, run a duplicate-name check and stash any hits in
    // the new case's history. The reviewer can then decide on the AI-
    // review screen whether to link this case as a remake of one of
    // them. Failures here are non-fatal — they only mean the reviewer
    // won't see suggested duplicates ahead of time.
    try {
      const lastNamePrefix = patientLastName.trim().slice(0, 3).toLowerCase();
      // No row cap — Task #331 requires that remakes from years ago are
      // still surfaced, even on the iTero auto-import path.
      const candidateRows = await db.query.cases.findMany({
        where: and(
          eq(cases.providerOrganizationId, body.providerOrganizationId),
          notDeleted(cases),
          sql`lower(${cases.patientLastName}) like ${`${lastNamePrefix}%`}`,
        ),
        orderBy: [desc(cases.createdAt)],
      });
      const dupes: Array<{
        id: string;
        source: "canonical" | "legacy";
        caseNumber: string;
        matchKind: SimilarityMatchKind;
      }> = [];
      for (const r of candidateRows as any[]) {
        if (r.id === createdCase.id) continue;
        const kind = classifyMatch(patientFirstName, patientLastName, {
          firstName: r.patientFirstName,
          lastName: r.patientLastName,
        });
        if (kind) {
          dupes.push({
            id: r.id,
            source: "canonical",
            caseNumber: r.caseNumber,
            matchKind: kind,
          });
        }
      }
      // Also scan legacy lab_cases for the same lab, scoped to doctor
      // names known to belong to this provider org so cross-provider
      // legacy data isn't surfaced.
      const legacyCandidates = await db
        .select()
        .from(labCases)
        .where(
          and(
            eq(labCases.organizationId, body.labOrganizationId),
            isNull(labCases.deletedAt),
          ),
        );
      const providerDoctorSet = await getDoctorNameSetForProviderOrg(
        body.labOrganizationId,
        body.providerOrganizationId,
      );
      // Fallback for legacy-only providers (no canonical history yet):
      // also include the extracted Rx doctor name so legacy mobile cases
      // for the same doctor still surface as duplicates.
      const fallbackDoctor = String(extracted?.doctorName ?? "")
        .trim()
        .toLowerCase();
      if (fallbackDoctor) providerDoctorSet.add(fallbackDoctor);
      for (const lr of legacyCandidates as any[]) {
        try {
          const parsed =
            typeof lr.caseData === "string"
              ? JSON.parse(lr.caseData)
              : lr.caseData;
          if (!parsed || typeof parsed !== "object") continue;
          const candidateDoctor = String(parsed.doctorName ?? "")
            .trim()
            .toLowerCase();
          if (!candidateDoctor || !providerDoctorSet.has(candidateDoctor)) {
            continue;
          }
          const split = splitDisplayName(parsed.patientName);
          const kind = classifyMatch(patientFirstName, patientLastName, {
            firstName: split.first,
            lastName: split.last,
          });
          if (kind) {
            dupes.push({
              id: lr.id,
              source: "legacy",
              caseNumber: String(parsed.caseNumber ?? lr.id),
              matchKind: kind,
            });
          }
        } catch {
          // ignore malformed legacy payloads
        }
      }
      if (dupes.length > 0) {
        await db.insert(caseEvents).values({
          caseId: createdCase.id,
          eventType: "possible_duplicates_detected",
          actorUserId: userId,
          actorOrganizationId: body.labOrganizationId,
          actorInitials: "SYS",
          metadataJson: {
            source: "itero",
            patientFirstName,
            patientLastName,
            candidates: dupes.slice(0, 10),
            note: `iTero auto-import detected ${dupes.length} possible duplicate case(s) for this patient. Review and link as remake if appropriate.`,
          },
        });
      }
    } catch (err) {
      req.log?.warn?.(
        { err: (err as Error)?.message, caseId: createdCase.id },
        "iTero duplicate-name check failed",
      );
    }

    // Best-effort session record for the newly created case
    db.insert(iteroImportSessions).values({
      labOrganizationId: body.labOrganizationId,
      importedByUserId: userId,
      createdCount: 1,
      dedupedCount: 0,
      erroredCount: 0,
      caseIds: [createdCase.id],
      batchId,
    }).catch((err: unknown) => {
      req.log?.warn({ err }, "iTero rx: failed to write created session record (non-fatal)");
    });

    return ok(
      res,
      {
        deduped: false,
        caseId: createdCase.id,
        caseNumber: createdCase.caseNumber,
        needsAiReview: false,
        attachmentId: attachment?.id,
        extracted,
      },
      201
    );
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// iTero export ZIP import
// POST /cases/import-from-itero-zip
//
// Accepts a full iTero export ZIP (e.g. OrthoCAD_Export_306682066.zip). The
// server extracts the archive, finds the iTero_Rx_*.pdf, uses AI to create
// the case (same flow as /import-from-itero-rx), then attaches only the Rx
// PDF and any .ply scan files to the new case — all other files in the ZIP
// are silently discarded. The iTero order ID is derived from the Rx filename;
// the ZIP filename is used as a fallback.
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/import-from-itero-zip",
  iteroZipUpload.single("file"),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const body = iteroZipImportBodySchema.parse(req.body ?? {});
    const batchId = randomBytes(8).toString("hex");

    if (!req.file) {
      throw new HttpError(400, "ZIP file is required (field name 'file').");
    }

    await requireMembership(userId, body.labOrganizationId);
    if (body.invoiceOverrideLines !== undefined) {
      await requireAnyRole(userId, body.labOrganizationId, ADMIN_ROLES);
    }

    if (req.file.filename) {
      const result = await processOneIteroZipFile(
        req,
        req.file,
        body,
        userId,
        (req as any).user,
        batchId,
      "single",
      );

      db.insert(iteroImportSessions).values({
        labOrganizationId: body.labOrganizationId,
        importedByUserId: userId,
        createdCount: result.deduped ? 0 : 1,
        dedupedCount: result.deduped ? 1 : 0,
        erroredCount: 0,
        caseIds: result.deduped ? [] : [result.caseId],
        batchId,
      }).catch((err: unknown) => {
        req.log?.warn({ err }, "iTero zip: failed to write session record (non-fatal)");
      });

      return ok(
        res,
        result.deduped
          ? {
              deduped: true,
              caseId: result.caseId,
              iteroOrderId: result.iteroOrderId,
               textureRepair: result.textureRepair,
            }
          : {
              deduped: false,
              caseId: result.caseId,
              caseNumber: result.caseNumber,
              needsAiReview: false,
              attachmentId: result.attachmentId,
              iteroOrderId: result.iteroOrderId,
              extraFilesAttached: result.extraFilesAttached,
              extraFilesFailed: result.extraFilesFailed,
            },
        result.deduped ? 200 : 201,
      );
    }

    // ── Extract ZIP in memory ────────────────────────────────────────────────
    let rxBuffer: Buffer;
    let rxOriginalName: string;
    let rxMimeType: string;
    let iteroOrderId: string;
    let otherEntries: Array<{ name: string; data: Buffer; mimeType: string }> =
      [];

    const ZIP_MAX_ENTRIES = 100;
    const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;  // 200 MB uncompressed
    const ZIP_MAX_ENTRY_BYTES = 50 * 1024 * 1024;   // 50 MB per file

    try {
      const zip = new AdmZip(req.file.path);
      const entries = zip
        .getEntries()
        .filter((e) => !e.isDirectory && e.header.size > 0);
      if (entries.some((entry) => !isSafeArchiveEntryName(entry.entryName))) {
        throw new HttpError(400, "ZIP contains an unsafe archive path.");
      }

      if (entries.length > ZIP_MAX_ENTRIES) {
        throw new HttpError(
          400,
          `ZIP contains too many files (${entries.length}). Maximum is ${ZIP_MAX_ENTRIES}.`
        );
      }

      const totalUncompressed = entries.reduce(
        (sum, e) => sum + (e.header.size ?? 0),
        0
      );
      if (totalUncompressed > ZIP_MAX_TOTAL_BYTES) {
        throw new HttpError(
          400,
          `ZIP uncompressed size (${Math.round(totalUncompressed / 1024 / 1024)} MB) exceeds the ${ZIP_MAX_TOTAL_BYTES / 1024 / 1024} MB limit.`
        );
      }

      const ITERO_RX_EXTENSIONS = /^itero_rx_.*\.(pdf|png|jpg|jpeg|webp|tif|tiff|bmp)$/i;
      const rxEntry = entries.find((e) =>
        ITERO_RX_EXTENSIONS.test(path.basename(e.entryName))
      );

      if (!rxEntry) {
        throw new HttpError(
          400,
          "No iTero Rx file found in this ZIP. Expected a file matching iTero_Rx_*.(pdf|png|jpg|jpeg|webp|tif|tiff) inside the archive."
        );
      }

      if ((rxEntry.header.size ?? 0) > ZIP_MAX_ENTRY_BYTES) {
        throw new HttpError(
          400,
          `Rx file is too large (${Math.round((rxEntry.header.size ?? 0) / 1024 / 1024)} MB). Maximum per-file size is ${ZIP_MAX_ENTRY_BYTES / 1024 / 1024} MB.`
        );
      }

      rxOriginalName = path.basename(rxEntry.entryName);
      const rxExtSingle = path.extname(rxOriginalName).toLowerCase();
      rxMimeType = EXT_TO_MIME[rxExtSingle] ?? "application/octet-stream";
      const orderIdMatch = rxOriginalName.match(/iTero_Rx_(\d+)\./i);
      if (orderIdMatch) {
        iteroOrderId = orderIdMatch[1];
      } else {
        const zipBasename = path.basename(req.file.originalname || "");
        const zipDigits = zipBasename.match(/\d+/g);
        iteroOrderId = zipDigits
          ? zipDigits[zipDigits.length - 1]!
          : randomBytes(4).toString("hex");
      }

      rxBuffer = rxEntry.getData();

      for (const entry of entries) {
        if (entry === rxEntry) continue;
        const entryName = path.basename(entry.entryName);
        if (!isSafeArchiveEntryName(entry.entryName)) {
          throw new HttpError(400, "ZIP contains an unsafe archive path.");
        }
        if (!entryName) continue;
        // Keep PLYs and candidate image companions; exact pairing is decided
        // from the PLY's TextureFile comment after extraction.
        const ext = path.extname(entryName).toLowerCase();
        if (ext !== ".ply" && ![".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"].includes(ext)) continue;
        const entrySize = entry.header.size ?? 0;
        if (entrySize > ZIP_MAX_ENTRY_BYTES) {
          req.log?.warn(
            { name: entryName, size: entrySize },
            "iTero ZIP: skipping oversized .ply entry"
          );
          continue;
        }
        const mimeType = EXT_TO_MIME[ext] ?? "application/octet-stream";
        otherEntries.push({ name: entryName, data: entry.getData(), mimeType });
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        400,
        `Could not read ZIP file: ${(err as Error).message}`
      );
    } finally {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }

    // ── Optimistic dedup check ───────────────────────────────────────────────
    const preExisting = await db.query.iteroImportedOrders.findFirst({
      where: and(
        eq(iteroImportedOrders.labOrganizationId, body.labOrganizationId),
        eq(iteroImportedOrders.iteroOrderId, iteroOrderId)
      ),
    });
    if (preExisting && preExisting.createdCaseId) {
      // Verify the referenced case still exists and hasn't been soft-deleted.
      // If it's gone (failed import, soft-delete, or cross-environment ID), the
      // dedup record is stale — wipe it so this import can proceed fresh.
      const liveCase = await db.query.cases.findFirst({
        where: and(
          eq(cases.id, preExisting.createdCaseId),
          notDeleted(cases)
        ),
        columns: { id: true },
      });
      if (liveCase) {
        let textureRepair: { repaired: number; attempted: number; reason?: string };
        try {
          textureRepair = await repairIteroTextures(req, liveCase.id, otherEntries, userId, body.labOrganizationId);
        } catch (err) {
          req.log?.warn({ err, caseId: liveCase.id }, "iTero texture repair failed");
          textureRepair = { repaired: 0, attempted: 0, reason: "repair_failed" };
        }
        await db
          .update(iteroImportedOrders)
          .set({ lastSeenAt: new Date() })
          .where(eq(iteroImportedOrders.id, preExisting.id));
        return ok(res, {
          deduped: true,
          caseId: preExisting.createdCaseId,
          iteroOrderId: preExisting.iteroOrderId,
          extraFilesAttached: 0,
          textureRepair,
        });
      }
      // Stale dedup record — delete it so the transaction can claim a fresh slot.
      req.log?.warn?.(
        { iteroOrderId, staleCreatedCaseId: preExisting.createdCaseId },
        "iTero ZIP dedup: stale record found (case missing or deleted) — clearing and re-importing"
      );
      await db
        .delete(iteroImportedOrders)
        .where(eq(iteroImportedOrders.id, preExisting.id));
    } else if (preExisting && !preExisting.createdCaseId) {
      // A previous import started but its transaction rolled back leaving a
      // null-caseId sentinel. Clear it so this request can proceed.
      req.log?.warn?.(
        { iteroOrderId },
        "iTero ZIP dedup: stuck null-caseId slot found — clearing and re-importing"
      );
      await db
        .delete(iteroImportedOrders)
        .where(eq(iteroImportedOrders.id, preExisting.id));
    }

    // ── Save Rx PDF to caseMediaDir before the transaction ──────────────────
    try {
      fs.mkdirSync(caseMediaDir, { recursive: true });
    } catch { /* ignore */ }
    const rxExt = path.extname(rxOriginalName).toLowerCase() || ".pdf";
    const rxSafe = path
      .basename(rxOriginalName, rxExt)
      .replace(/[^a-zA-Z0-9\-_]+/g, "-")
      .slice(0, 60) || "rx";
    const rxDiskName = `${Date.now()}-${randomBytes(4).toString("hex")}-${rxSafe}${rxExt}`;
    const rxDiskPath = path.join(caseMediaDir, rxDiskName);
    await writeProductionUpload(rxDiskPath, rxBuffer, "case-import");
    // Mirror to persistent object storage so the file survives server restarts
    // and re-deployments (best-effort — a failure here does not abort the import).
    writeCaseMediaToObjectStorage(rxDiskName, rxBuffer, rxMimeType).catch(
      (err: unknown) => {
        req.log?.warn({ err }, "iTero ZIP: failed to mirror Rx file to object storage");
      },
    );
    const rxStorageKey = buildIteroAttachmentUrl(req, rxDiskName);

    // ── AI extraction ────────────────────────────────────────────────────────
    let extracted: ExtractedRxFields = {};
    const openai = getIteroOpenAIClient();
    if (openai) {
      try {
        extracted = await extractRxFieldsFromBuffer(
          openai,
          rxBuffer,
          rxMimeType,
          rxOriginalName
        );
      } catch (err) {
        req.log?.warn?.(
          { err: (err as Error)?.message },
          "iTero ZIP Rx AI extraction failed; creating case with hints only"
        );
      }
    }

    const patientFirstName =
      extracted.patientFirstName?.trim() ||
      body.patientFirstNameHint?.trim() ||
      "Unknown";
    const patientLastName =
      extracted.patientLastName?.trim() ||
      body.patientLastNameHint?.trim() ||
      "Patient";
    const doctorName =
      extracted.doctorName?.trim() ||
      body.doctorNameHint?.trim() ||
      "Unknown Doctor";

    // Doctor similarity suggestion
    let suggestedDoctorName: string | null = null;
    let suggestedProviderOrgId: string | null = null;
    if (doctorName !== "Unknown Doctor") {
      const existingGroups = await db
        .selectDistinct({
          doctorName: cases.doctorName,
          providerOrganizationId: cases.providerOrganizationId,
        })
        .from(cases)
        .where(
          and(
            eq(cases.labOrganizationId, body.labOrganizationId),
            notDeleted(cases)
          )
        );
      let bestSim = 0;
      let bestMatch: { doctorName: string; providerOrganizationId: string } | null =
        null;
      const normExtracted = _normalizeDoctorForSim(doctorName);
      for (const g of existingGroups) {
        if (_normalizeDoctorForSim(g.doctorName) === normExtracted) continue;
        const sim = _bigramSimilarity(doctorName, g.doctorName);
        if (sim >= 0.4 && sim > bestSim) {
          bestSim = sim;
          bestMatch = g;
        }
      }
      if (bestMatch) {
        suggestedDoctorName = bestMatch.doctorName;
        suggestedProviderOrgId = bestMatch.providerOrganizationId;
      }
    }

    // ── Practice-name fallback: match extracted practiceName to a provider org ──
    // When doctor-name similarity produced no org suggestion, try matching the
    // AI-extracted practice name directly against provider organizations.
    if (!suggestedProviderOrgId && extracted.practiceName?.trim()) {
      suggestedProviderOrgId = await _findProviderOrgByPracticeName(
        body.labOrganizationId,
        extracted.practiceName
      );
    }

    // ── Duplicate-doctor auto-merge ──────────────────────────────────────────
    // Adopt an existing near-duplicate doctor name in this practice rather than
    // silently creating a new one (same guard as the iTero Rx import path).
    const {
      doctorName: effectiveDoctorName,
      autoMergedFrom: doctorAutoMergedFrom,
      similarity: doctorAutoMergeSimilarity,
    } = await resolveIteroDoctorAutoMerge(
      body.labOrganizationId,
      body.providerOrganizationId,
      doctorName,
    );
    if (
      suggestedDoctorName &&
      suggestedDoctorName.trim().toLowerCase() ===
        effectiveDoctorName.trim().toLowerCase()
    ) {
      suggestedDoctorName = null;
    }

    let iteroZipSuppliedDate: Date | null = null;
    if (extracted.dueDate) {
      const parsed = new Date(extracted.dueDate);
      if (!Number.isNaN(parsed.getTime())) iteroZipSuppliedDate = parsed;
    }
    if (!iteroZipSuppliedDate && body.dueDateHint) {
      // Parse MM/DD/YYYY (from client AI) or ISO formats.
      const hint = body.dueDateHint.trim();
      const mmddyyyy = hint.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      const parsedHint = mmddyyyy
        ? new Date(`${mmddyyyy[3]}-${mmddyyyy[1]!.padStart(2, "0")}-${mmddyyyy[2]!.padStart(2, "0")}`)
        : new Date(hint);
      if (!Number.isNaN(parsedHint.getTime())) iteroZipSuppliedDate = parsedHint;
    }
    const iteroZipLabOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, body.labOrganizationId),
      columns: { defaultCaseDueDays: true, capCaseDueToDefault: true },
    });
    const dueDate = resolveCaseDueDate(
      iteroZipSuppliedDate,
      new Date(),
      iteroZipLabOrg?.defaultCaseDueDays,
      iteroZipLabOrg?.capCaseDueToDefault,
    );

    const caseNumber = await generateIteroCaseNumber(body.labOrganizationId);

    // Fall back to hint values when AI didn't extract them.
    if (!extracted.shade && body.shadeHint) extracted.shade = body.shadeHint;
    if (!extracted.material && body.materialHint) extracted.material = body.materialHint;
    if (!extracted.arch && body.archHint) extracted.arch = body.archHint;
    // Canonicalize the material name (zirconia / Emax→Lithium Disilicate / PFM
    // rules) before it is stored and before price resolution.
    extracted.material = normalizeMaterialName(extracted.material) ?? extracted.material;
    // Route notesHint into extracted.notes so it persists to cases.rxNotes (not
    // just the case-note row) when server-side AI extraction is unavailable.
    if (!extracted.notes && body.notesHint) extracted.notes = body.notesHint;

    // Build tooth list from top-level teeth, fall back to restorations array.
    const teethStr = extracted.teeth?.trim() || body.toothIndicesHint?.trim() || "";
    let teethList = teethStr
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    if (teethList.length === 0 && extracted.restorations && extracted.restorations.length > 0) {
      const fromRest: string[] = [];
      for (const r of extracted.restorations) {
        for (const seg of (r.teeth || "").split(",")) {
          const trimmed = seg.trim();
          const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
          if (rangeMatch) {
            const lo = parseInt(rangeMatch[1], 10);
            const hi = parseInt(rangeMatch[2], 10);
            for (let i = lo; i <= hi && i - lo <= 32; i++) fromRest.push(String(i));
          } else if (/^\d+$/.test(trimmed)) {
            fromRest.push(trimmed);
          }
        }
      }
      teethList = [...new Set(fromRest)];
    }

    // Bucket caseType; fall back to "Other" when clinical data exists but
    // no caseType was extracted (and no hint was provided).
    const normalizedCaseType = extracted.caseType
      ? normalizeIteroCaseType(extracted.caseType)
      : (body.caseTypeHint
          ? normalizeIteroCaseType(body.caseTypeHint)
          : (teethList.length > 0 || extracted.material || extracted.shade ? "Other" : null));
    if (normalizedCaseType) {
      extracted.caseType = normalizedCaseType;
    }

    // Derive restorationSubtype from the normalised caseType + material so each
    // restoration row carries the encoded taxonomy key without a later re-derive.
    // When the AI returned an explicit removableSubtype, use it as the fast-path
    // subtype so we store "removable/flippers" etc. instead of guessing from text.
    const zipAiRemovableSubtype = mapAiRemovableSubtype(extracted.removableSubtype);
    const zipIsAmbiguousRepair = isAmbiguousRemovableSubtype(extracted.removableSubtype);
    const { restorationSubtype: zipRestorationSubtype } = normalizeCaseHierarchy({
      caseType: normalizedCaseType ?? null,
      material: extracted.material ?? null,
      subtype: zipAiRemovableSubtype ?? undefined,
    });
    const zipArchMissing =
      isArchApplicable(normalizedCaseType, zipRestorationSubtype) &&
      !normalizeArch(extracted.arch);
    const zipArch = normalizeArch(extracted.arch);

    let prebuiltRestorations: Array<{
      toothNumber: string;
      restorationType: string;
      restorationSubtype: string | null;
      arch?: Arch | null;
      material: string | null;
      shade: string | null;
      unitPrice: string;
      priceSource: string | null;
      priceSourceId: string | null;
      priceSourceName: string | null;
      priceKey: string | null;
    }> = [];
    if (teethList.length > 0 && normalizedCaseType) {
      if (normalizedCaseType === "Removable") {
        // Flippers: each tooth is a separate physical appliance — one row per tooth.
        // All other removables (partials, dentures, repairs): collapse to one row.
        if (zipAiRemovableSubtype === "flippers") {
          prebuiltRestorations = await Promise.all(
            teethList.map(async (toothNumber) => {
              const toothShade = extracted.perToothShades?.[toothNumber] ?? extracted.shade;
              const fallback = await resolveServerPriceWithSource(
                {
                  labOrganizationId: body.labOrganizationId,
                  doctorName: effectiveDoctorName,
                  providerOrganizationId: body.providerOrganizationId,
                },
                extracted.material ?? null,
                normalizedCaseType
              );
              return {
                toothNumber,
                restorationType: zipIsAmbiguousRepair ? "Removable Repair" : normalizedCaseType,
                restorationSubtype: zipRestorationSubtype ?? null,
                material: extracted.material ?? null,
                shade: normalizeIteroShade(toothShade),
                unitPrice: (fallback?.amount ?? 0).toFixed(2),
                priceSource: fallback?.source ?? null,
                priceSourceId: fallback?.sourceId ?? null,
                priceSourceName: fallback?.sourceName ?? null,
                priceKey: fallback?.key ?? null,
              };
            })
          );
        } else {
          const fallback = await resolveServerPriceWithSource(
            {
              labOrganizationId: body.labOrganizationId,
              doctorName: effectiveDoctorName,
              providerOrganizationId: body.providerOrganizationId,
            },
            extracted.material ?? null,
            normalizedCaseType
          );
          prebuiltRestorations = [{
            toothNumber: teethList.join(", "),
            restorationType: zipIsAmbiguousRepair ? "Removable Repair" : normalizedCaseType,
            restorationSubtype: zipRestorationSubtype ?? null,
            material: extracted.material ?? null,
            shade: normalizeIteroShade(extracted.shade),
            unitPrice: (fallback?.amount ?? 0).toFixed(2),
            priceSource: fallback?.source ?? null,
            priceSourceId: fallback?.sourceId ?? null,
            priceSourceName: fallback?.sourceName ?? null,
            priceKey: fallback?.key ?? null,
          }];
        }
      } else {
        prebuiltRestorations = await Promise.all(
          teethList.map(async (toothNumber) => {
            const fallback = await resolveServerPriceWithSource(
              {
                labOrganizationId: body.labOrganizationId,
                doctorName: effectiveDoctorName,
                providerOrganizationId: body.providerOrganizationId,
              },
              extracted.material ?? null,
              normalizedCaseType
            );
            return {
              toothNumber,
              restorationType: zipIsAmbiguousRepair ? "Removable Repair" : normalizedCaseType,
              restorationSubtype: zipRestorationSubtype ?? null,
              material: extracted.material ?? null,
              shade: normalizeIteroShade(extracted.shade),
              unitPrice: (fallback?.amount ?? 0).toFixed(2),
              priceSource: fallback?.source ?? null,
              priceSourceId: fallback?.sourceId ?? null,
              priceSourceName: fallback?.sourceName ?? null,
              priceKey: fallback?.key ?? null,
            };
          })
        );
      }
    } else if (normalizedCaseType || extracted.material || extracted.shade) {
      prebuiltRestorations = [{
        toothNumber: "",
        restorationType: zipIsAmbiguousRepair ? "Removable Repair" : (normalizedCaseType ?? "Other"),
        restorationSubtype: zipRestorationSubtype ?? null,
        material: extracted.material ?? null,
        shade: normalizeIteroShade(extracted.shade),
        unitPrice: "0.00",
        priceSource: null,
        priceSourceId: null,
        priceSourceName: null,
        priceKey: null,
      }];
    }

    const user = (req as any).user;

    // ── Atomic transaction ───────────────────────────────────────────────────
    const txResult = await db.transaction(async (tx) => {
      const [claim] = await tx
        .insert(iteroImportedOrders)
        .values({
          labOrganizationId: body.labOrganizationId,
          iteroOrderId,
          createdCaseId: null,
          importedByUserId: userId,
          batchId,
        })
        .onConflictDoNothing({
          target: [
            iteroImportedOrders.labOrganizationId,
            iteroImportedOrders.iteroOrderId,
          ],
        })
        .returning();

      if (!claim) {
        const existing = await tx.query.iteroImportedOrders.findFirst({
          where: and(
            eq(iteroImportedOrders.labOrganizationId, body.labOrganizationId),
            eq(iteroImportedOrders.iteroOrderId, iteroOrderId)
          ),
        });
        if (existing?.createdCaseId) {
          const liveCase = await tx.query.cases.findFirst({
            where: and(eq(cases.id, existing.createdCaseId), notDeleted(cases)),
            columns: { id: true, caseNumber: true },
          });
          if (liveCase) {
            await tx
              .update(iteroImportedOrders)
              .set({ lastSeenAt: new Date() })
              .where(eq(iteroImportedOrders.id, existing.id));
            return {
              kind: "deduped" as const,
              existing: { ...existing, caseNumber: liveCase.caseNumber },
            };
          }
        }
        throw new HttpError(
          409,
          "A previous import for this order is still in progress or failed to complete. Please retry in a moment."
        );
      }

      const [createdCase] = await tx
        .insert(cases)
        .values({
          caseNumber,
          labOrganizationId: body.labOrganizationId,
          providerOrganizationId: body.providerOrganizationId,
          patientFirstName,
          patientLastName,
          doctorName: effectiveDoctorName,
          status: "received",
          priority: extracted.isRush ? "rush" : "normal",
          receivedAt: parseCalendarDate(body.receivedAt),
          dueDate,
          expectedDeliveryDate: iteroZipSuppliedDate
            ? null
            : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          createdByUserId: userId,
          aiImportSource: "itero",
          externalPatientId: iteroOrderId,
          rxNotes: extracted.notes?.trim() || null,
          shade: normalizeIteroShade(extracted.shade),
          step: normalizeIteroStage(extracted.stage) ?? null,
          gingivialShade: extracted.gingivialShade?.trim() || null,
          ...({ suggestedDoctorName, suggestedProviderOrgId } as any),
        })
        .returning();

      if (prebuiltRestorations.length > 0) {
        await tx.insert(caseRestorations).values(
          prebuiltRestorations.map((r) => ({
            caseId: createdCase.id,
            toothNumber: r.toothNumber,
            restorationType: r.restorationType,
            restorationSubtype: r.restorationSubtype ?? null,
            arch: r.arch ?? zipArch,
            material: r.material,
            shade: r.shade,
            notes: null,
            quantity: 1,
            unitPrice: r.unitPrice,
            priceSource: r.priceSource,
            priceSourceId: r.priceSourceId,
            priceSourceName: r.priceSourceName,
            priceKey: r.priceKey,
          }))
        );
        await expandPersistedBothArchRows(tx, createdCase.id);
      }

      const zipNoteText = (extracted.notes?.trim() || body.notesHint?.trim()) ?? null;
      if (zipNoteText) {
        await appendRxNoteEntry(tx, {
          caseId: createdCase.id,
          submissionId: `itero-import:${createdCase.id}`,
          noteText: zipNoteText,
          provenance: "itero_import",
          scannedAt: createdCase.createdAt,
          preserveCurrentAsLegacy: false,
        });
      }
      const [attachment] = await tx
        .insert(caseAttachments)
        .values({
          caseId: createdCase.id,
          uploadedByUserId: userId,
          uploadedByOrganizationId: body.labOrganizationId,
          fileName: rxOriginalName,
          storageKey: rxStorageKey,
          fileType: rxMimeType,
          visibility: "internal_lab_only",
        })
        .returning();

      await tx
        .update(iteroImportedOrders)
        .set({ createdCaseId: createdCase.id, lastSeenAt: new Date() })
        .where(eq(iteroImportedOrders.id, claim.id));

      await tx.insert(caseEvents).values({
        caseId: createdCase.id,
        eventType: "case_created_from_itero",
        actorUserId: userId,
        actorOrganizationId: body.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          iteroOrderId,
          source: "zip",
          aiExtracted: Object.keys(extracted ?? {}),
          attachmentId: attachment?.id,
          extraFileCount: otherEntries.length,
        },
      });

      // Record the duplicate-doctor auto-merge so reviewers can see (and undo)
      // that the parsed name was reused as an existing doctor in this practice.
      if (doctorAutoMergedFrom && doctorAutoMergedFrom !== effectiveDoctorName) {
        await tx.insert(caseEvents).values({
          caseId: createdCase.id,
          eventType: "doctor_auto_merged_from_itero",
          actorUserId: userId,
          actorOrganizationId: body.labOrganizationId,
          actorInitials: user?.initials || "SYS",
          metadataJson: {
            source: "zip",
            parsedDoctorName: doctorAutoMergedFrom,
            mergedToDoctorName: effectiveDoctorName,
            similarity: doctorAutoMergeSimilarity,
            note: `Auto-import reused existing doctor "${effectiveDoctorName}" instead of creating "${doctorAutoMergedFrom}" (near-duplicate in this practice).`,
          },
        });
      }

      // ── Auto-create invoice ────────────────────────────────────────────────
      let autoInvoiceId: string | null = null;
      try {
        const restorationRowsForInvoice =
          await tx.query.caseRestorations.findMany({
            where: eq(caseRestorations.caseId, createdCase.id),
            orderBy: [caseRestorations.createdAt],
          });
        const patientName = `${createdCase.patientFirstName ?? ""} ${createdCase.patientLastName ?? ""}`
          .replace(/\s+/g, " ")
          .trim();
        const teethListForInv = restorationRowsForInvoice
          .map((r: any) => (r.toothNumber ?? "").trim())
          .filter(Boolean);
        const shadeListForInv = Array.from(
          new Set(
            restorationRowsForInvoice
              .map((r: any) => (r.shade ?? "").trim())
              .filter(Boolean)
          )
        );
        const noteText = zipNoteText ? `[iTero AI import] ${zipNoteText}` : null;
        const displayMetadataJson = {
          patientName,
          billTo: (createdCase.doctorName ?? "").trim(),
          teeth: teethListForInv.join(", "),
          shade: shadeListForInv.join(", "),
          caseNotes: noteText ?? "",
        };

        const hasRestorations = prebuiltRestorations.length > 0;
        const fallbackPriced =
          hasRestorations &&
          prebuiltRestorations.some(
            (r) => r.priceSource === "fallback" || r.priceSource === null
          );
        const aiPricingWarning = !hasRestorations
          ? "AI could not extract restorations from this Rx — please add line items and pricing before sending."
          : zipIsAmbiguousRepair
            ? "Removable repair type is unclear — please select the correct subtype and verify pricing before sending."
            : fallbackPriced
              ? "Some line items use default/fallback pricing — please verify before sending."
              : null;
        const doctorIdentity = await ensureDoctorProfileIdentity(tx, {
          labOrganizationId: createdCase.labOrganizationId,
          providerOrganizationId: createdCase.providerOrganizationId ?? null,
          doctorName: createdCase.doctorName,
        });

        const autoInvoice = await insertOrResolveAiIntakeInvoice(tx, {
            invoiceNumber: `INV-${createdCase.caseNumber}`,
            caseId: createdCase.id,
            labOrganizationId: createdCase.labOrganizationId,
            providerOrganizationId: createdCase.providerOrganizationId,
            doctorIdentity,
            status: "open",
            displayMetadataJson,
            aiGenerated: true,
            aiPricingWarning: zipArchMissing
              ? `${aiPricingWarning ? `${aiPricingWarning} ` : ""}Arch is missing — select an arch and verify clinical completeness before sending.`
              : aiPricingWarning,
            issuedAt: calendarDateToUtcNoon(createdCase.receivedAt),
            dueAt: invoiceDueDate(new Date()),
            createdByUserId: userId,
            updatedByUserId: userId,
          }, createdCase.id, createdCase.labOrganizationId);

        if (autoInvoice.newlyCreated) {
          const labelCache = hasRestorations
            ? await fetchLabItemLabels(createdCase.labOrganizationId)
            : ({} as Record<string, string>);
          const itemsToInsert: any[] = body.invoiceOverrideLines
            ? reviewedLinesToInvoiceItems(body.invoiceOverrideLines, autoInvoice.id)
            : hasRestorations
            ? await buildGroupedLineItemsForInvoice(
                restorationRowsForInvoice as any[],
                labelCache,
                autoInvoice.id,
                createdCase.labOrganizationId,
                extracted.restorations,
              )
            : [
                {
                  invoiceId: autoInvoice.id,
                  caseRestorationId: null,
                  toothNumber: null,
                  toothLabel: null,
                  description:
                    "[AI placeholder] Restorations could not be extracted — replace with actual line items.",
                  quantity: 1,
                  unitPrice: "0.00",
                  lineTotal: "0.00",
                  sortOrder: 0,
                },
              ];
          const lineItemsMeta = itemsToInsert.map((it) => ({
            item: it.catalogItemLabel ?? it.description,
            description: it.description,
            catalogItemKey: it.catalogItemKey ?? null,
            missingCatalogItem: it.missingCatalogItem ?? false,
            subItems: (it.childItems ?? []).map((child: any) => ({ item: child.description, description: child.description })),
          }));
          await insertGroupedLineItemsWithChildren(tx, itemsToInsert);
          const subtotal = sumGroupedLineItemsTotal(itemsToInsert);
          await tx
            .update(invoices)
            .set({
              subtotal,
              total: subtotal,
              balanceDue: subtotal,
              displayMetadataJson: { ...displayMetadataJson, lineItems: lineItemsMeta, ...(body.invoiceOverrideLines ? { reviewedCharges: true } : {}) },
            })
            .where(eq(invoices.id, autoInvoice.id));
        }
        autoInvoiceId = autoInvoice.id;
      } catch (invoiceErr) {
        req.log?.error(
          { err: invoiceErr, caseId: createdCase.id },
          "iTero ZIP auto-invoice creation failed"
        );
        throw new HttpError(500, "iTero ZIP case invoice could not be persisted.");
      }

      return {
        kind: "created" as const,
        createdCase,
        attachment,
        autoInvoiceId,
      };
    });

    if (txResult.kind === "deduped") {
      // Clean up the RX file we pre-saved since the case already exists.
      try { fs.unlinkSync(rxDiskPath); } catch { /* ignore */ }
      const existing = txResult.existing;
      if (existing && existing.createdCaseId) {
        // Best-effort session record for the deduped ZIP import
        db.insert(iteroImportSessions).values({
          labOrganizationId: body.labOrganizationId,
          importedByUserId: userId,
          createdCount: 0,
          dedupedCount: 1,
          erroredCount: 0,
          caseIds: [],
          batchId,
        }).catch((err: unknown) => {
          req.log?.warn({ err }, "iTero zip: failed to write deduped session record (non-fatal)");
        });
        return ok(res, {
          deduped: true,
          caseId: existing.createdCaseId,
          caseNumber: existing.caseNumber,
          iteroOrderId: existing.iteroOrderId,
          extraFilesAttached: 0,
        });
      }
      throw new HttpError(
        409,
        "iTero order is already being imported; retry shortly."
      );
    }

    const { createdCase, attachment } = txResult;

    // Auto-add per-tooth alloy rows for PFM/FCM restorations when the lab
    // has opted in. Runs after the transaction so syncInvoiceFromRestorations
    // can rebuild the invoice with the alloy sub-items attached.
    try {
      const labOrgForAlloy = await db.query.organizations.findFirst({
        where: eq(organizations.id, createdCase.labOrganizationId),
        columns: { autoAddAlloyOnPfm: true },
      });
      if (labOrgForAlloy?.autoAddAlloyOnPfm) {
        await addAlloyChargeToCase({
          caseRow: {
            id: createdCase.id,
            labOrganizationId: createdCase.labOrganizationId,
            providerOrganizationId: createdCase.providerOrganizationId ?? null,
            doctorName: createdCase.doctorName,
          },
          actorUserId: userId,
          actorInitials: "SYS",
          pfmOnly: true,
        });
      }
    } catch (alloyErr) {
      req.log?.warn({ err: alloyErr, caseId: createdCase.id }, "iTero ZIP import: per-tooth alloy auto-add failed (non-fatal)");
    }

    // ── Attach remaining ZIP files (best-effort, outside transaction) ────────
    let extraFilesAttached = 0;
    let extraFilesFailed = 0;
    const texturePairs = pairPlyTextures(otherEntries);
    const pairedTextureNames = new Set(texturePairs.values());
    const entriesToAttach = otherEntries.filter((entry) =>
      entry.name.toLowerCase().endsWith(".ply") || pairedTextureNames.has(entry.name),
    );
    const attachmentIds = new Map<string, string>();
    for (const entry of entriesToAttach) {
      try {
        const ext = path.extname(entry.name) || "";
        const safe = path
          .basename(entry.name, ext)
          .replace(/[^a-zA-Z0-9\-_]+/g, "-")
          .slice(0, 60) || "file";
        const diskName = `${Date.now()}-${randomBytes(4).toString("hex")}-${safe}${ext}`;
        const diskPath = path.join(caseMediaDir, diskName);
        await writeProductionUpload(diskPath, entry.data, "case-import");
        // Mirror to persistent object storage (best-effort).
        writeCaseMediaToObjectStorage(diskName, entry.data, entry.mimeType).catch(
          (err: unknown) => {
            req.log?.warn({ err, name: entry.name }, "iTero ZIP: failed to mirror attachment to object storage");
          },
        );
        const storageKey = buildIteroAttachmentUrl(req, diskName);
        const [saved] = await db.insert(caseAttachments).values({
          caseId: createdCase.id,
          uploadedByUserId: userId,
          uploadedByOrganizationId: body.labOrganizationId,
          fileName: entry.name,
          storageKey,
          fileType: entry.mimeType,
          visibility: "internal_lab_only",
        }).returning({ id: caseAttachments.id });
        attachmentIds.set(entry.name, saved!.id);
        extraFilesAttached++;
      } catch (attachErr) {
        extraFilesFailed++;
        req.log?.warn(
          { err: attachErr, name: entry.name, caseId: createdCase.id },
          "iTero ZIP: failed to save extra attachment"
        );
      }
    }
    for (const [plyName, textureName] of texturePairs) {
      const plyId = attachmentIds.get(plyName);
      const textureId = attachmentIds.get(textureName);
      if (plyId && textureId) {
        await db.update(caseAttachments)
          .set({ textureAttachmentId: textureId })
          .where(and(eq(caseAttachments.id, plyId), eq(caseAttachments.caseId, createdCase.id)));
      }
    }

    // ── Audit log ────────────────────────────────────────────────────────────
    await writeAuditLog({
      req,
      organizationId: body.labOrganizationId,
      action: "case_created_from_itero",
      entityType: "case",
      entityId: createdCase.id,
      afterJson: {
        case: createdCase,
        iteroOrderId,
        attachmentId: attachment?.id,
        extraFilesAttached,
      },
    });

    // ── Admin notifications (best-effort) ────────────────────────────────────
    try {
      const adminMembers = await db
        .select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.labId, body.labOrganizationId),
            eq(organizationMemberships.status, "active"),
            inArray(organizationMemberships.role, ["owner", "admin"])
          )
        );

      if (adminMembers.length > 0) {
        const isUnknownDoctor =
          !doctorName?.trim() || doctorName.trim() === "Unknown Doctor";
        let isStandInDoctor = false;
        let isUnknownPractice = false;

        const priorCaseDoctorRows = await db
          .selectDistinct({ doctorName: cases.doctorName })
          .from(cases)
          .where(
            and(
              eq(cases.labOrganizationId, body.labOrganizationId),
              eq(cases.providerOrganizationId, body.providerOrganizationId),
              ne(cases.id, createdCase.id),
              notDeleted(cases)
            )
          );

        const hasPriorCases = priorCaseDoctorRows.length > 0;
        if (!hasPriorCases) {
          isUnknownPractice = true;
        } else if (!isUnknownDoctor) {
          const knownDoctors = new Set(
            priorCaseDoctorRows
              .map((r) => String(r.doctorName ?? "").trim().toLowerCase())
              .filter(Boolean)
          );
          isStandInDoctor =
            knownDoctors.size > 0 &&
            !knownDoctors.has(doctorName.trim().toLowerCase());
        }

        const notifType =
          isUnknownDoctor || isStandInDoctor || isUnknownPractice
            ? "alert"
            : "case_imported_from_itero";
        let notifTitle: string;
        let notifBody: string;
        if (isUnknownDoctor) {
          notifTitle = `iTero ZIP case imported — unknown doctor`;
          notifBody = `Case ${createdCase.caseNumber} was imported from an iTero ZIP but the doctor name could not be identified. Please review.`;
        } else if (isUnknownPractice) {
          notifTitle = `iTero ZIP case imported — unknown practice`;
          notifBody = `Case ${createdCase.caseNumber} for ${patientFirstName} ${patientLastName} was imported from an iTero ZIP for a practice with no prior case history.`;
        } else if (isStandInDoctor) {
          notifTitle = `iTero ZIP case imported — unrecognised doctor`;
          notifBody = `Case ${createdCase.caseNumber} was imported from an iTero ZIP with doctor "${doctorName}", who is not in the known provider list.`;
        } else {
          notifTitle = `New iTero ZIP case: ${createdCase.caseNumber}`;
          notifBody = `Case ${createdCase.caseNumber} for ${patientFirstName} ${patientLastName} was imported from an iTero ZIP. ${extraFilesAttached} additional file(s) were attached.`;
        }

        await deliverInAppNotification({
          labOrganizationId: body.labOrganizationId,
          recipientUserIds: adminMembers.map((member) => member.userId),
          category: createdCase.priority === "rush" ? "rush_case" : "new_case",
          dedupeKey: `itero_case:${createdCase.id}`,
          type: notifType,
          title: notifTitle,
          body: notifBody,
          dataJson: {
            caseId: createdCase.id,
            caseNumber: createdCase.caseNumber,
            iteroOrderId,
            extraFilesAttached,
          },
        });
      }
    } catch (notifErr) {
      req.log?.warn?.(
        { err: (notifErr as Error)?.message, caseId: createdCase.id },
        "iTero ZIP import: failed to write admin notifications (non-fatal)"
      );
    }

    // Best-effort session record for the newly created case
    db.insert(iteroImportSessions).values({
      labOrganizationId: body.labOrganizationId,
      importedByUserId: userId,
      createdCount: 1,
      dedupedCount: 0,
      erroredCount: 0,
      caseIds: [createdCase.id],
      batchId,
    }).catch((err: unknown) => {
      req.log?.warn({ err }, "iTero zip: failed to write created session record (non-fatal)");
    });

    return ok(
      res,
      {
        deduped: false,
        caseId: createdCase.id,
        caseNumber: createdCase.caseNumber,
        needsAiReview: false,
        attachmentId: attachment?.id,
        iteroOrderId,
        extraFilesAttached,
        extraFilesFailed,
      },
      201
    );
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper: process one iTero ZIP file into a case.
// Used by both the single-ZIP endpoint and the batch endpoint.
// The caller is responsible for providing a temp file on disk; this function
// deletes it (in a finally block) before returning or throwing.
// ─────────────────────────────────────────────────────────────────────────────

interface OneZipResult {
  caseId: string;
  caseNumber: string;
  deduped: boolean;
  iteroOrderId: string;
  attachmentId?: string;
  extraFilesAttached: number;
  extraFilesFailed: number;
  /** AI-extracted doctor name from the Rx (may be undefined for deduped cases) */
  aiDoctorName?: string | null;
  /** Best-matched existing provider org id for the extracted doctor name */
  suggestedProviderOrgId?: string | null;
  /** Best-matched existing doctor name for the suggestion */
  suggestedDoctorName?: string | null;
  /** The providerOrganizationId actually saved on the created case */
  linkedProviderOrgId?: string | null;
  textureRepair?: { repaired: number; attempted: number; reason?: string };
}

/** Re-import repair: fill only missing, same-case texture links. */
async function repairIteroTextures(
  req: Request,
  caseId: string,
  entries: Array<{ name: string; data: Buffer; mimeType: string }>,
  userId: string,
  labOrganizationId: string,
): Promise<{ repaired: number; attempted: number; reason?: string }> {
  const pairs = pairPlyTextures(entries);
  let repaired = 0;
  let attempted = 0;
  let sawScan = false;
  for (const [plyName, textureName] of pairs) {
    const scan = await db.query.caseAttachments.findFirst({
      where: and(eq(caseAttachments.caseId, caseId), eq(caseAttachments.fileName, plyName), isNull(caseAttachments.deletedAt)),
    });
    if (!scan) continue;
    sawScan = true;
    if (scan.textureAttachmentId) {
      const linkedTexture = await db.query.caseAttachments.findFirst({
        where: and(eq(caseAttachments.id, scan.textureAttachmentId), isNull(caseAttachments.deletedAt)),
        columns: { id: true },
      });
      if (linkedTexture) continue;
    }
    const image = entries.find((entry) => entry.name === textureName);
    if (!image) continue;
    attempted++;
    const ext = path.extname(image.name) || ".jpg";
    const safe = path.basename(image.name, ext).replace(/[^a-zA-Z0-9\-_]+/g, "-").slice(0, 60) || "texture";
    const diskName = `${Date.now()}-${randomBytes(4).toString("hex")}-${safe}${ext}`;
    await fs.promises.mkdir(caseMediaDir, { recursive: true });
        await writeProductionUpload(path.join(caseMediaDir, diskName), image.data, "case-import");
    writeCaseMediaToObjectStorage(diskName, image.data, image.mimeType).catch((err: unknown) => {
      req.log?.warn({ err, caseId }, "iTero texture repair: object storage mirror failed");
    });
    // Keep the attachment insert and link atomic: a concurrent delete or
    // relation update must not leave an orphan texture row in the case.
    await db.transaction(async (tx) => {
      const [texture] = await tx.insert(caseAttachments).values({
        caseId, uploadedByUserId: userId, uploadedByOrganizationId: labOrganizationId,
        fileName: image.name, storageKey: buildIteroAttachmentUrl(req, diskName),
        fileType: image.mimeType, visibility: "internal_lab_only",
      }).returning({ id: caseAttachments.id });
      if (!texture) return;
      const linked = await tx.update(caseAttachments).set({ textureAttachmentId: texture.id })
        .where(and(eq(caseAttachments.id, scan.id), eq(caseAttachments.caseId, caseId), isNull(caseAttachments.deletedAt)))
        .returning({ id: caseAttachments.id });
      if (linked.length === 0) {
        throw new HttpError(409, "Scan changed while repairing its texture.");
      }
      repaired++;
    });
  }
  return {
    repaired,
    attempted,
    reason: repaired === 0
      ? (pairs.size === 0 ? "no_matching_texture_reference" : sawScan ? "texture_not_repaired" : "scan_not_found")
      : undefined,
  };
}

async function processOneIteroZipFile(
  req: Request,
  file: Express.Multer.File,
  body: {
    labOrganizationId: string;
    providerOrganizationId: string;
    receivedAt?: string;
    invoiceOverrideLines?: Array<{ description: string; quantity: number; unitPrice: number; catalogItemKey?: string | null; subItems?: Array<{ description: string; quantity: number; unitPrice: number }> }>;
    doctorNameHint?: string;
    patientFirstNameHint?: string;
    patientLastNameHint?: string;
    caseTypeHint?: string;
    materialHint?: string;
    shadeHint?: string;
    toothIndicesHint?: string;
    dueDateHint?: string;
    notesHint?: string;
  },
  userId: string,
  user: any,
  batchId?: string,
  notificationStyle: "single" | "batch" = "batch",
): Promise<OneZipResult> {
  const ZIP_MAX_ENTRIES = 100;
  const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
  const ZIP_MAX_ENTRY_BYTES = 50 * 1024 * 1024;

  let rxBuffer: Buffer;
  let rxOriginalName: string;
  let rxMimeType: string;
  let iteroOrderId: string;
  let otherEntries: Array<{ name: string; data: Buffer; mimeType: string }> = [];

  const ITERO_RX_EXTENSIONS = /^itero_rx_.*\.(pdf|png|jpg|jpeg|webp|tif|tiff|bmp)$/i;

  try {
    const zip = new AdmZip(file.path);
    const entries = zip.getEntries().filter((e) => !e.isDirectory && e.header.size > 0);
    if (entries.some((entry) => !isSafeArchiveEntryName(entry.entryName))) {
      throw new HttpError(400, "ZIP contains an unsafe archive path.");
    }

    if (entries.length > ZIP_MAX_ENTRIES) {
      throw new HttpError(400, `ZIP contains too many files (${entries.length}). Maximum is ${ZIP_MAX_ENTRIES}.`);
    }
    const totalUncompressed = entries.reduce((sum, e) => sum + (e.header.size ?? 0), 0);
    if (totalUncompressed > ZIP_MAX_TOTAL_BYTES) {
      throw new HttpError(400, `ZIP uncompressed size (${Math.round(totalUncompressed / 1024 / 1024)} MB) exceeds the ${ZIP_MAX_TOTAL_BYTES / 1024 / 1024} MB limit.`);
    }

    const rxEntry = entries.find((e) => ITERO_RX_EXTENSIONS.test(path.basename(e.entryName)));
    if (!rxEntry) {
      throw new HttpError(400, "No iTero Rx file found in this ZIP. Expected a file matching iTero_Rx_*.(pdf|png|jpg|jpeg|webp|tif|tiff) inside the archive.");
    }
    if ((rxEntry.header.size ?? 0) > ZIP_MAX_ENTRY_BYTES) {
      throw new HttpError(400, `Rx file is too large (${Math.round((rxEntry.header.size ?? 0) / 1024 / 1024)} MB). Maximum per-file size is ${ZIP_MAX_ENTRY_BYTES / 1024 / 1024} MB.`);
    }

    rxOriginalName = path.basename(rxEntry.entryName);
    const rxExtHelper = path.extname(rxOriginalName).toLowerCase();
    rxMimeType = EXT_TO_MIME[rxExtHelper] ?? "application/octet-stream";
    const orderIdMatch = rxOriginalName.match(/iTero_Rx_(\d+)\./i);
    if (orderIdMatch) {
      iteroOrderId = orderIdMatch[1];
    } else {
      const zipBasename = path.basename(file.originalname || "");
      const zipDigits = zipBasename.match(/\d+/g);
      iteroOrderId = zipDigits ? zipDigits[zipDigits.length - 1]! : randomBytes(4).toString("hex");
    }

    rxBuffer = rxEntry.getData();

    for (const entry of entries) {
      if (entry === rxEntry) continue;
      const entryName = path.basename(entry.entryName);
      if (!isSafeArchiveEntryName(entry.entryName)) {
        throw new HttpError(400, "ZIP contains an unsafe archive path.");
      }
      if (!entryName) continue;
      const ext = path.extname(entryName).toLowerCase();
      // Keep companion images as well; pairPlyTextures below only accepts an
      // exact TextureFile basename declared by a PLY.
      if (ext !== ".ply" && ![".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"].includes(ext)) continue;
      const entrySize = entry.header.size ?? 0;
      if (entrySize > ZIP_MAX_ENTRY_BYTES) {
        req.log?.warn({ name: entryName, size: entrySize }, "iTero ZIP batch: skipping oversized .ply entry");
        continue;
      }
      const mimeType = EXT_TO_MIME[ext] ?? "application/octet-stream";
      otherEntries.push({ name: entryName, data: entry.getData(), mimeType });
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, `Could not read ZIP file: ${(err as Error).message}`);
  } finally {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
  }

  // Optimistic dedup check
  const preExisting = await db.query.iteroImportedOrders.findFirst({
    where: and(
      eq(iteroImportedOrders.labOrganizationId, body.labOrganizationId),
      eq(iteroImportedOrders.iteroOrderId, iteroOrderId),
    ),
  });
  if (preExisting && preExisting.createdCaseId) {
    const liveCase = await db.query.cases.findFirst({
      where: and(eq(cases.id, preExisting.createdCaseId), notDeleted(cases)),
      columns: { id: true, caseNumber: true },
    });
    if (liveCase) {
      // A deduped original ZIP is also allowed to repair a missing texture,
      // without adding a duplicate case or unrelated files.
      let textureRepair: { repaired: number; attempted: number; reason?: string };
      try {
        textureRepair = await repairIteroTextures(req, liveCase.id, otherEntries, userId, body.labOrganizationId);
      } catch (err) {
        req.log?.warn({ err, caseId: liveCase.id }, "iTero texture repair failed");
        textureRepair = { repaired: 0, attempted: 0, reason: "repair_failed" };
      }
      await db.update(iteroImportedOrders).set({ lastSeenAt: new Date() }).where(eq(iteroImportedOrders.id, preExisting.id))
        .catch((err: unknown): never => wrapDbError(err, { fallback: "Failed to update iTero import record." }));
      return { caseId: liveCase.id, caseNumber: liveCase.caseNumber, deduped: true, iteroOrderId: preExisting.iteroOrderId, attachmentId: undefined, extraFilesAttached: 0, extraFilesFailed: 0, aiDoctorName: null, suggestedProviderOrgId: null, suggestedDoctorName: null, linkedProviderOrgId: null, textureRepair };
    }
    await db.delete(iteroImportedOrders).where(eq(iteroImportedOrders.id, preExisting.id));
  } else if (preExisting) {
    await db.delete(iteroImportedOrders).where(eq(iteroImportedOrders.id, preExisting.id));
  }

  // Save Rx file to disk
  try { fs.mkdirSync(caseMediaDir, { recursive: true }); } catch { /* ignore */ }
  const rxExt = path.extname(rxOriginalName).toLowerCase() || ".pdf";
  const rxSafe = path.basename(rxOriginalName, rxExt).replace(/[^a-zA-Z0-9\-_]+/g, "-").slice(0, 60) || "rx";
  const rxDiskName = `${Date.now()}-${randomBytes(4).toString("hex")}-${rxSafe}${rxExt}`;
  const rxDiskPath = path.join(caseMediaDir, rxDiskName);
    await writeProductionUpload(rxDiskPath, rxBuffer, "case-import");
  writeCaseMediaToObjectStorage(rxDiskName, rxBuffer, rxMimeType).catch((err: unknown) => {
    req.log?.warn({ err }, "iTero ZIP batch: failed to mirror Rx file to object storage");
  });
  const rxStorageKey = buildIteroAttachmentUrl(req, rxDiskName);

  // AI extraction
  let extracted: ExtractedRxFields = {};
  const openai = getIteroOpenAIClient();
  if (openai) {
    try {
      extracted = await extractRxFieldsFromBuffer(openai, rxBuffer, rxMimeType, rxOriginalName);
    } catch (err) {
      req.log?.warn?.({ err: (err as Error)?.message }, "iTero ZIP batch: Rx AI extraction failed; creating stub case");
    }
  }

  // Fall back to hint values when AI didn't extract them.
  if (!extracted.material && body.materialHint) extracted.material = body.materialHint;
  if (!extracted.shade && body.shadeHint) extracted.shade = body.shadeHint;
  if (!extracted.teeth && body.toothIndicesHint) extracted.teeth = body.toothIndicesHint;
  if (!extracted.caseType && body.caseTypeHint) extracted.caseType = body.caseTypeHint;
  if (!extracted.arch && (body as any).archHint) extracted.arch = (body as any).archHint;
  if (!extracted.dueDate && body.dueDateHint) extracted.dueDate = body.dueDateHint;
  if (!extracted.notes && body.notesHint) extracted.notes = body.notesHint;
  // Canonicalize the material name (zirconia / Emax→Lithium Disilicate / PFM
  // rules) before it is stored and before price resolution.
  extracted.material = normalizeMaterialName(extracted.material) ?? extracted.material;

  const patientFirstName = extracted.patientFirstName?.trim() || body.patientFirstNameHint?.trim() || "Unknown";
  const patientLastName  = extracted.patientLastName?.trim()  || body.patientLastNameHint?.trim()  || "Patient";
  const doctorName       = extracted.doctorName?.trim()       || body.doctorNameHint?.trim()       || "Unknown Doctor";

  // Doctor similarity suggestion
  let suggestedDoctorName: string | null = null;
  let suggestedProviderOrgId: string | null = null;
  if (doctorName !== "Unknown Doctor") {
    const existingGroups = await db.selectDistinct({ doctorName: cases.doctorName, providerOrganizationId: cases.providerOrganizationId })
      .from(cases)
      .where(and(eq(cases.labOrganizationId, body.labOrganizationId), notDeleted(cases)));
    let bestSim = 0;
    let bestMatch: { doctorName: string; providerOrganizationId: string } | null = null;
    const normExtracted = _normalizeDoctorForSim(doctorName);
    for (const g of existingGroups) {
      if (_normalizeDoctorForSim(g.doctorName) === normExtracted) continue;
      const sim = _bigramSimilarity(doctorName, g.doctorName);
      if (sim >= 0.4 && sim > bestSim) { bestSim = sim; bestMatch = g; }
    }
    if (bestMatch) { suggestedDoctorName = bestMatch.doctorName; suggestedProviderOrgId = bestMatch.providerOrganizationId; }
  }
  if (!suggestedProviderOrgId && extracted.practiceName?.trim()) {
    suggestedProviderOrgId = await _findProviderOrgByPracticeName(
      body.labOrganizationId,
      extracted.practiceName,
    );
  }

  // Per-lab opt-in: prefer AI-suggested practice over the poller's default
  // when the per-lab "auto-link suggested practice" setting is enabled.
  // Mirrors the same gating used in processOneIteroRxPdf above.
  let effectiveProviderOrgId: string | null = body.providerOrganizationId || null;
  let autoLinkedFromAi = false;
  if (
    suggestedProviderOrgId &&
    suggestedProviderOrgId !== effectiveProviderOrgId &&
    (await getIteroAutoLinkSuggestedPractice(body.labOrganizationId))
  ) {
    effectiveProviderOrgId = suggestedProviderOrgId;
    autoLinkedFromAi = true;
  }

  // ── Duplicate-doctor auto-merge ────────────────────────────────────────────
  // Adopt an existing near-duplicate doctor name in the effective practice
  // rather than silently creating a new one (same guard as the iTero Rx import
  // path). Skipped when no practice is resolved, since "same practice" is the
  // scope of the dedup.
  let effectiveDoctorName = doctorName;
  let doctorAutoMergedFrom: string | null = null;
  let doctorAutoMergeSimilarity: number | null = null;
  if (effectiveProviderOrgId) {
    const merged = await resolveIteroDoctorAutoMerge(
      body.labOrganizationId,
      effectiveProviderOrgId,
      doctorName,
    );
    effectiveDoctorName = merged.doctorName;
    doctorAutoMergedFrom = merged.autoMergedFrom;
    doctorAutoMergeSimilarity = merged.similarity;
  }
  if (
    suggestedDoctorName &&
    suggestedDoctorName.trim().toLowerCase() ===
      effectiveDoctorName.trim().toLowerCase()
  ) {
    suggestedDoctorName = null;
  }

  const suppliedDueDate = extracted.dueDate
    ? new Date(extracted.dueDate)
    : null;
  const validSuppliedDueDate =
    suppliedDueDate && !Number.isNaN(suppliedDueDate.getTime())
      ? suppliedDueDate
      : null;
  const labOrg = await db.query.organizations.findFirst({
    where: eq(organizations.id, body.labOrganizationId),
    columns: { defaultCaseDueDays: true, capCaseDueToDefault: true },
  });
  const dueDate = resolveCaseDueDate(
    validSuppliedDueDate,
    new Date(),
    labOrg?.defaultCaseDueDays,
    labOrg?.capCaseDueToDefault,
  );

  const caseNumber = await generateIteroCaseNumber(body.labOrganizationId);

  // Build tooth list; fall back to aggregating from the restorations array.
  let teethList = (extracted.teeth || "").split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  if (teethList.length === 0 && extracted.restorations && extracted.restorations.length > 0) {
    const fromRest: string[] = [];
    for (const r of extracted.restorations) {
      for (const seg of (r.teeth || "").split(",")) {
        const trimmed = seg.trim();
        const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          const lo = parseInt(rangeMatch[1], 10);
          const hi = parseInt(rangeMatch[2], 10);
          for (let i = lo; i <= hi && i - lo <= 32; i++) fromRest.push(String(i));
        } else if (/^\d+$/.test(trimmed)) {
          fromRest.push(trimmed);
        }
      }
    }
    teethList = [...new Set(fromRest)];
  }

  const normalizedCaseType = extracted.caseType
    ? normalizeIteroCaseType(extracted.caseType)
    : (body.caseTypeHint
        ? normalizeIteroCaseType(body.caseTypeHint)
        : (teethList.length > 0 || extracted.material || extracted.shade ? "Other" : null));
  if (normalizedCaseType) extracted.caseType = normalizedCaseType;
  const importArch = normalizeArch(extracted.arch);

  // Derive restorationSubtype from the normalised caseType + material so each
  // restoration row carries the encoded taxonomy key without a later re-derive.
  // When the AI returned an explicit removableSubtype, use it as the fast-path
  // subtype so we store "removable/flippers" etc. instead of guessing from text.
  const autoAiRemovableSubtype = mapAiRemovableSubtype(extracted.removableSubtype);
  const autoIsAmbiguousRepair = isAmbiguousRemovableSubtype(extracted.removableSubtype);
  const { restorationSubtype: autoRestorationSubtype } = normalizeCaseHierarchy({
    caseType: normalizedCaseType ?? null,
    material: extracted.material ?? null,
    subtype: autoAiRemovableSubtype ?? undefined,
  });
  const importArchMissing =
    isArchApplicable(normalizedCaseType, autoRestorationSubtype) && !importArch;

  let prebuiltRestorations: Array<{
    toothNumber: string; restorationType: string; restorationSubtype: string | null; arch?: Arch | null;
    material: string | null; shade: string | null;
    unitPrice: string; priceSource: string | null; priceSourceId: string | null; priceSourceName: string | null; priceKey: string | null;
  }> = [];
  if (teethList.length > 0 && normalizedCaseType) {
    if (normalizedCaseType === "Removable") {
      // Flippers: each tooth is a separate physical appliance — one row per tooth.
      // All other removables (partials, dentures, repairs): collapse to one row.
      if (autoAiRemovableSubtype === "flippers") {
        prebuiltRestorations = await Promise.all(teethList.map(async (toothNumber) => {
          const toothShade = extracted.perToothShades?.[toothNumber] ?? extracted.shade;
          const fallback = await resolveServerPriceWithSource(
            { labOrganizationId: body.labOrganizationId, doctorName: effectiveDoctorName, providerOrganizationId: effectiveProviderOrgId ?? body.providerOrganizationId },
            extracted.material ?? null, normalizedCaseType,
          );
          return {
            toothNumber, restorationType: autoIsAmbiguousRepair ? "Removable Repair" : normalizedCaseType, restorationSubtype: autoRestorationSubtype ?? null,
            material: extracted.material ?? null, shade: normalizeIteroShade(toothShade),
            unitPrice: (fallback?.amount ?? 0).toFixed(2), priceSource: fallback?.source ?? null,
            priceSourceId: fallback?.sourceId ?? null, priceSourceName: fallback?.sourceName ?? null, priceKey: fallback?.key ?? null,
          };
        }));
      } else {
        const fallback = await resolveServerPriceWithSource(
          { labOrganizationId: body.labOrganizationId, doctorName: effectiveDoctorName, providerOrganizationId: effectiveProviderOrgId ?? body.providerOrganizationId },
          extracted.material ?? null, normalizedCaseType,
        );
        prebuiltRestorations = [{
          toothNumber: teethList.join(", "), restorationType: autoIsAmbiguousRepair ? "Removable Repair" : normalizedCaseType, restorationSubtype: autoRestorationSubtype ?? null,
          material: extracted.material ?? null, shade: normalizeIteroShade(extracted.shade),
          unitPrice: (fallback?.amount ?? 0).toFixed(2), priceSource: fallback?.source ?? null,
          priceSourceId: fallback?.sourceId ?? null, priceSourceName: fallback?.sourceName ?? null, priceKey: fallback?.key ?? null,
        }];
      }
    } else {
      prebuiltRestorations = await Promise.all(teethList.map(async (toothNumber) => {
        const fallback = await resolveServerPriceWithSource(
          { labOrganizationId: body.labOrganizationId, doctorName: effectiveDoctorName, providerOrganizationId: effectiveProviderOrgId ?? body.providerOrganizationId },
          extracted.material ?? null, normalizedCaseType,
        );
        return {
          toothNumber, restorationType: autoIsAmbiguousRepair ? "Removable Repair" : normalizedCaseType, restorationSubtype: autoRestorationSubtype ?? null,
          material: extracted.material ?? null, shade: normalizeIteroShade(extracted.shade),
          unitPrice: (fallback?.amount ?? 0).toFixed(2), priceSource: fallback?.source ?? null,
          priceSourceId: fallback?.sourceId ?? null, priceSourceName: fallback?.sourceName ?? null, priceKey: fallback?.key ?? null,
        };
      }));
    }
  } else if (normalizedCaseType || extracted.material || extracted.shade) {
    prebuiltRestorations = [{
      toothNumber: "",
      restorationType: autoIsAmbiguousRepair ? "Removable Repair" : (normalizedCaseType ?? "Other"),
      restorationSubtype: autoRestorationSubtype ?? null,
      material: extracted.material ?? null,
      shade: normalizeIteroShade(extracted.shade),
      unitPrice: "0.00", priceSource: null, priceSourceId: null, priceSourceName: null, priceKey: null,
    }];
  }

  // Atomic transaction
  const txResult = await db.transaction(async (tx) => {
    const [claim] = await tx.insert(iteroImportedOrders).values({
      labOrganizationId: body.labOrganizationId, iteroOrderId, createdCaseId: null,
      importedByUserId: userId, batchId: batchId ?? null,
    }).onConflictDoNothing({ target: [iteroImportedOrders.labOrganizationId, iteroImportedOrders.iteroOrderId] }).returning();

    if (!claim) {
      const existing = await tx.query.iteroImportedOrders.findFirst({
        where: and(eq(iteroImportedOrders.labOrganizationId, body.labOrganizationId), eq(iteroImportedOrders.iteroOrderId, iteroOrderId)),
      });
      if (existing?.createdCaseId) {
        const liveCase = await tx.query.cases.findFirst({
          where: and(eq(cases.id, existing.createdCaseId), notDeleted(cases)),
          columns: { id: true, caseNumber: true },
        });
        if (liveCase) {
          await tx.update(iteroImportedOrders).set({ lastSeenAt: new Date() }).where(eq(iteroImportedOrders.id, existing.id));
          return {
            kind: "deduped" as const,
            existing: { ...existing, caseNumber: liveCase.caseNumber },
          };
        }
      }
      throw new HttpError(
        409,
        "A previous import for this order is still in progress or failed to complete. Please retry in a moment."
      );
    }

    const [createdCase] = await tx.insert(cases).values({
      caseNumber,
      labOrganizationId: body.labOrganizationId,
      providerOrganizationId: effectiveProviderOrgId,
      patientFirstName, patientLastName, doctorName: effectiveDoctorName,
      status: "received",
      priority: extracted.isRush ? "rush" : "normal",
      dueDate, expectedDeliveryDate: validSuppliedDueDate ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdByUserId: userId, aiImportSource: "itero",
      receivedAt: parseCalendarDate(body.receivedAt),
      externalPatientId: iteroOrderId,
      rxNotes: extracted.notes?.trim() || null,
      shade: normalizeIteroShade(extracted.shade),
      step: normalizeIteroStage(extracted.stage) ?? null,
      gingivialShade: extracted.gingivialShade?.trim() || null,
      ...({
        suggestedDoctorName,
        // Clear the suggestion field once it's been auto-applied so the
        // review banner doesn't keep re-prompting for a now-stale choice.
        suggestedProviderOrgId: autoLinkedFromAi ? null : suggestedProviderOrgId,
      } as any),
    }).returning();

    if (prebuiltRestorations.length > 0) {
      await tx.insert(caseRestorations).values(prebuiltRestorations.map((r) => ({
        caseId: createdCase.id, toothNumber: r.toothNumber, restorationType: r.restorationType,
        restorationSubtype: r.restorationSubtype ?? null,
        arch: r.arch ?? importArch,
        material: r.material, shade: r.shade, notes: null, quantity: 1,
        unitPrice: r.unitPrice, priceSource: r.priceSource, priceSourceId: r.priceSourceId,
        priceSourceName: r.priceSourceName, priceKey: r.priceKey,
      })));
      await expandPersistedBothArchRows(tx, createdCase.id);
    }

    if (extracted.notes && extracted.notes.trim()) {
      await appendRxNoteEntry(tx, {
        caseId: createdCase.id,
        submissionId: `itero-import:${createdCase.id}`,
        noteText: extracted.notes,
        provenance: "itero_import",
        scannedAt: createdCase.createdAt,
        preserveCurrentAsLegacy: false,
      });
    }

    const [attachment] = await tx.insert(caseAttachments).values({
      caseId: createdCase.id, uploadedByUserId: userId, uploadedByOrganizationId: body.labOrganizationId,
      fileName: rxOriginalName, storageKey: rxStorageKey, fileType: rxMimeType, visibility: "internal_lab_only",
    }).returning();

    await tx.update(iteroImportedOrders).set({ createdCaseId: createdCase.id, lastSeenAt: new Date() }).where(eq(iteroImportedOrders.id, claim.id));

    await tx.insert(caseEvents).values({
      caseId: createdCase.id, eventType: "case_created_from_itero",
      actorUserId: userId, actorOrganizationId: body.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: { iteroOrderId, source: "zip_batch", aiExtracted: Object.keys(extracted ?? {}), attachmentId: attachment?.id, extraFileCount: otherEntries.length },
    });

    if (autoLinkedFromAi) {
      await tx.insert(caseEvents).values({
        caseId: createdCase.id,
        eventType: "provider_auto_linked_from_ai",
        actorUserId: userId,
        actorOrganizationId: body.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          source: "itero_zip_batch",
          fromProviderOrgId: body.providerOrganizationId || null,
          toProviderOrgId: effectiveProviderOrgId,
          suggestedDoctorName,
        },
      });
    }

    // Record the duplicate-doctor auto-merge so reviewers can see (and undo)
    // that the parsed name was reused as an existing doctor in this practice.
    if (doctorAutoMergedFrom && doctorAutoMergedFrom !== effectiveDoctorName) {
      await tx.insert(caseEvents).values({
        caseId: createdCase.id,
        eventType: "doctor_auto_merged_from_itero",
        actorUserId: userId,
        actorOrganizationId: body.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          source: "itero_zip_batch",
          parsedDoctorName: doctorAutoMergedFrom,
          mergedToDoctorName: effectiveDoctorName,
          similarity: doctorAutoMergeSimilarity,
          note: `Auto-import reused existing doctor "${effectiveDoctorName}" instead of creating "${doctorAutoMergedFrom}" (near-duplicate in this practice).`,
        },
      });
    }

    // Auto-create invoice
    let autoInvoiceId: string | null = null;
    try {
      const restorationRowsForInvoice = await tx.query.caseRestorations.findMany({
        where: eq(caseRestorations.caseId, createdCase.id), orderBy: [caseRestorations.createdAt],
      });
      const patientName = `${createdCase.patientFirstName ?? ""} ${createdCase.patientLastName ?? ""}`.replace(/\s+/g, " ").trim();
      const teethListForInv = restorationRowsForInvoice.map((r: any) => (r.toothNumber ?? "").trim()).filter(Boolean);
      const shadeListForInv = Array.from(new Set(restorationRowsForInvoice.map((r: any) => (r.shade ?? "").trim()).filter(Boolean)));
      const noteText = extracted.notes && extracted.notes.trim() ? `[iTero AI import] ${extracted.notes.trim()}` : null;
      const displayMetadataJson = { patientName, billTo: (createdCase.doctorName ?? "").trim(), teeth: teethListForInv.join(", "), shade: shadeListForInv.join(", "), caseNotes: noteText ?? "" };
      const hasRestorations = prebuiltRestorations.length > 0;
      const fallbackPriced = hasRestorations && prebuiltRestorations.some((r) => r.priceSource === "fallback" || r.priceSource === null);
      const aiPricingWarning = !hasRestorations
        ? "AI could not extract restorations from this Rx — please add line items and pricing before sending."
        : autoIsAmbiguousRepair
          ? "Removable repair type is unclear — please select the correct subtype and verify pricing before sending."
          : fallbackPriced ? "Some line items use default/fallback pricing — please verify before sending." : null;
      const doctorIdentity = await ensureDoctorProfileIdentity(tx, {
        labOrganizationId: createdCase.labOrganizationId,
        providerOrganizationId: createdCase.providerOrganizationId ?? null,
        doctorName: createdCase.doctorName,
      });

      const autoInvoice = await insertOrResolveAiIntakeInvoice(tx, {
        invoiceNumber: `INV-${createdCase.caseNumber}`, caseId: createdCase.id,
        labOrganizationId: createdCase.labOrganizationId, providerOrganizationId: createdCase.providerOrganizationId,
        doctorIdentity,
        status: "open", displayMetadataJson, aiGenerated: true,
        aiPricingWarning: importArchMissing
          ? `${aiPricingWarning ? `${aiPricingWarning} ` : ""}Arch is missing — select an arch and verify clinical completeness before sending.`
          : aiPricingWarning,
        issuedAt: calendarDateToUtcNoon(createdCase.receivedAt),
        dueAt: invoiceDueDate(new Date()),
        createdByUserId: userId, updatedByUserId: userId,
      }, createdCase.id, createdCase.labOrganizationId);

      if (autoInvoice.newlyCreated) {
        const labelCache = hasRestorations
          ? await fetchLabItemLabels(createdCase.labOrganizationId)
          : ({} as Record<string, string>);
        const itemsToInsert: any[] = body.invoiceOverrideLines
          ? reviewedLinesToInvoiceItems(body.invoiceOverrideLines, autoInvoice.id)
          : hasRestorations
          ? await buildGroupedLineItemsForInvoice(
              restorationRowsForInvoice as any[],
              labelCache,
              autoInvoice.id,
              createdCase.labOrganizationId,
              extracted.restorations,
            )
          : [{ invoiceId: autoInvoice.id, caseRestorationId: null, toothNumber: null, toothLabel: null, description: "[AI placeholder] Restorations could not be extracted — replace with actual line items.", quantity: 1, unitPrice: "0.00", lineTotal: "0.00", sortOrder: 0 }];
        const lineItemsMeta = itemsToInsert.map((it) => ({
          item: it.catalogItemLabel ?? it.description,
          description: it.description,
          catalogItemKey: it.catalogItemKey ?? null,
          missingCatalogItem: it.missingCatalogItem ?? false,
          subItems: (it.childItems ?? []).map((child: any) => ({ item: child.description, description: child.description })),
        }));
        await insertGroupedLineItemsWithChildren(tx, itemsToInsert);
        const subtotal = sumGroupedLineItemsTotal(itemsToInsert);
        await tx.update(invoices).set({ subtotal, total: subtotal, balanceDue: subtotal, displayMetadataJson: { ...displayMetadataJson, lineItems: lineItemsMeta, ...(body.invoiceOverrideLines ? { reviewedCharges: true } : {}) } }).where(eq(invoices.id, autoInvoice.id));
      }
      autoInvoiceId = autoInvoice.id;
    } catch (invoiceErr) {
      req.log?.error({ err: invoiceErr, caseId: createdCase.id }, "iTero ZIP batch: auto-invoice creation failed");
      throw new HttpError(500, "iTero ZIP case invoice could not be persisted.");
    }

    return { kind: "created" as const, createdCase, attachment, autoInvoiceId };
  });

  if (txResult.kind === "deduped") {
    try { fs.unlinkSync(rxDiskPath); } catch { /* ignore */ }
    const existing = txResult.existing;
    if (existing && existing.createdCaseId) {
      let textureRepair: { repaired: number; attempted: number; reason?: string };
      try {
        textureRepair = await repairIteroTextures(req, existing.createdCaseId, otherEntries, userId, body.labOrganizationId);
      } catch (err) {
        req.log?.warn({ err, caseId: existing.createdCaseId }, "iTero texture repair failed");
        textureRepair = { repaired: 0, attempted: 0, reason: "repair_failed" };
      }
      return { caseId: existing.createdCaseId, caseNumber: existing.caseNumber, deduped: true, iteroOrderId: existing.iteroOrderId, attachmentId: undefined, extraFilesAttached: 0, extraFilesFailed: 0, aiDoctorName: null, suggestedProviderOrgId: null, suggestedDoctorName: null, linkedProviderOrgId: null, textureRepair };
    }
    throw new HttpError(409, "iTero order is already being imported; retry shortly.");
  }

  const { createdCase, attachment } = txResult;

  // Auto-add per-tooth alloy rows for PFM/FCM restorations when the lab
  // has opted in. Runs after the transaction so syncInvoiceFromRestorations
  // can rebuild the invoice with alloy sub-items attached.
  try {
    const labOrgForAlloy = await db.query.organizations.findFirst({
      where: eq(organizations.id, createdCase.labOrganizationId),
      columns: { autoAddAlloyOnPfm: true },
    });
    if (labOrgForAlloy?.autoAddAlloyOnPfm) {
      await addAlloyChargeToCase({
        caseRow: {
          id: createdCase.id,
          labOrganizationId: createdCase.labOrganizationId,
          providerOrganizationId: createdCase.providerOrganizationId ?? null,
          doctorName: createdCase.doctorName,
        },
        actorUserId: userId,
        actorInitials: "SYS",
        pfmOnly: true,
      });
    }
  } catch (alloyErr) {
    req.log?.warn({ err: alloyErr, caseId: createdCase.id }, "iTero ZIP batch: per-tooth alloy auto-add failed (non-fatal)");
  }

  // Attach scans and their declared companion textures outside the case
  // transaction. A texture is never attached unless a PLY in this same ZIP
  // references it exactly.
  let extraFilesAttached = 0;
  let extraFilesFailed = 0;
  const texturePairs = pairPlyTextures(otherEntries);
  const pairedTextureNames = new Set(texturePairs.values());
  const entriesToAttach = otherEntries.filter((entry) =>
    entry.name.toLowerCase().endsWith(".ply") || pairedTextureNames.has(entry.name),
  );
  const attachmentIds = new Map<string, string>();
  for (const entry of entriesToAttach) {
    try {
      const ext = path.extname(entry.name) || "";
      const safe = path.basename(entry.name, ext).replace(/[^a-zA-Z0-9\-_]+/g, "-").slice(0, 60) || "file";
      const diskName = `${Date.now()}-${randomBytes(4).toString("hex")}-${safe}${ext}`;
      const diskPath = path.join(caseMediaDir, diskName);
        await writeProductionUpload(diskPath, entry.data, "case-import");
      writeCaseMediaToObjectStorage(diskName, entry.data, entry.mimeType).catch((err: unknown) => {
        req.log?.warn({ err, name: entry.name }, "iTero ZIP batch: failed to mirror .ply to object storage");
      });
      const storageKey = buildIteroAttachmentUrl(req, diskName);
      const [saved] = await db.insert(caseAttachments).values({
        caseId: createdCase.id, uploadedByUserId: userId, uploadedByOrganizationId: body.labOrganizationId,
        fileName: entry.name, storageKey, fileType: entry.mimeType, visibility: "internal_lab_only",
      }).returning({ id: caseAttachments.id });
      attachmentIds.set(entry.name, saved!.id);
      extraFilesAttached++;
    } catch (attachErr) {
      extraFilesFailed++;
      req.log?.warn({ err: attachErr, name: entry.name, caseId: createdCase.id }, "iTero ZIP batch: failed to save .ply attachment");
    }
  }
  // Link only after both attachment rows exist, and guard the update by caseId.
  for (const [plyName, textureName] of texturePairs) {
    const plyId = attachmentIds.get(plyName);
    const textureId = attachmentIds.get(textureName);
    if (plyId && textureId) {
      await db.update(caseAttachments)
        .set({ textureAttachmentId: textureId })
        .where(and(eq(caseAttachments.id, plyId), eq(caseAttachments.caseId, createdCase.id)));
    }
  }

  // Audit log
  await writeAuditLog({
    req, organizationId: body.labOrganizationId, action: "case_created_from_itero",
    entityType: "case", entityId: createdCase.id,
    afterJson: { case: createdCase, iteroOrderId, attachmentId: attachment?.id, extraFilesAttached, source: "zip_batch" },
  });

  if (notificationStyle === "single") {
    try {
      const adminMembers = await db
        .select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.labId, body.labOrganizationId),
            eq(organizationMemberships.status, "active"),
            inArray(organizationMemberships.role, ["owner", "admin"]),
          ),
        );
      if (adminMembers.length > 0) {
        const isUnknownDoctor =
          !doctorName.trim() || doctorName === "Unknown Doctor";
        const priorCaseDoctorRows = await db
          .selectDistinct({ doctorName: cases.doctorName })
          .from(cases)
          .where(
            and(
              eq(cases.labOrganizationId, body.labOrganizationId),
              eq(cases.providerOrganizationId, body.providerOrganizationId),
              ne(cases.id, createdCase.id),
              notDeleted(cases),
            ),
          );
        const isUnknownPractice = priorCaseDoctorRows.length === 0;
        const knownDoctors = new Set(
          priorCaseDoctorRows
            .map((row) => row.doctorName.trim().toLowerCase())
            .filter(Boolean),
        );
        const isStandInDoctor =
          !isUnknownPractice &&
          !isUnknownDoctor &&
          knownDoctors.size > 0 &&
          !knownDoctors.has(doctorName.trim().toLowerCase());
        const isAlert =
          isUnknownDoctor || isUnknownPractice || isStandInDoctor;
        const title = isUnknownDoctor
          ? "iTero case imported — unknown doctor"
          : isUnknownPractice
            ? "iTero case imported — unknown practice"
            : isStandInDoctor
              ? "iTero case imported — unrecognised doctor"
              : `New iTero case: ${createdCase.caseNumber}`;
        const notificationBody = isUnknownDoctor
          ? `Case ${createdCase.caseNumber} was auto-imported from iTero but the doctor name could not be identified. Please review and assign the correct provider.`
          : isUnknownPractice
            ? `Case ${createdCase.caseNumber} for ${patientFirstName} ${patientLastName} was imported from iTero for a practice with no prior case history. Please verify the provider assignment.`
            : isStandInDoctor
              ? `Case ${createdCase.caseNumber} was imported from iTero with doctor "${doctorName}", who is not in the known provider list. This may be a stand-in — please review before sending.`
              : `Case ${createdCase.caseNumber} for ${patientFirstName} ${patientLastName} was imported from iTero.`;
        await deliverInAppNotification({
          labOrganizationId: body.labOrganizationId,
          recipientUserIds: adminMembers.map((member) => member.userId),
          category: createdCase.priority === "rush" ? "rush_case" : "new_case",
          dedupeKey: `itero_case:${createdCase.id}`,
          type: isAlert ? "alert" : "case_imported_from_itero",
          title,
          body: notificationBody,
          dataJson: {
            caseId: createdCase.id,
            caseNumber: createdCase.caseNumber,
            iteroOrderId,
            alertReason: isUnknownDoctor
              ? "unknown_doctor"
              : isUnknownPractice
                ? "unknown_practice"
                : isStandInDoctor
                  ? "stand_in_doctor"
                  : null,
          },
        });
      }
    } catch (notifErr) {
      req.log?.warn?.(
        { err: (notifErr as Error)?.message, caseId: createdCase.id },
        "iTero import: failed to write admin notifications (non-fatal)",
      );
    }
  } else {
    await deliverInAppNotification({
      labOrganizationId: body.labOrganizationId,
      category: createdCase.priority === "rush" ? "rush_case" : "new_case",
      dedupeKey: `itero_case:${createdCase.id}`,
      type: "case_imported_from_itero",
      title: `New iTero ZIP case: ${createdCase.caseNumber}`,
      body: `Case ${createdCase.caseNumber} was imported from an iTero ZIP.`,
      dataJson: {
        caseId: createdCase.id,
        caseNumber: createdCase.caseNumber,
        iteroOrderId,
        extraFilesAttached,
      },
    });
  }

  return {
    caseId: createdCase.id,
    caseNumber: createdCase.caseNumber,
    deduped: false,
    iteroOrderId,
    attachmentId: attachment?.id,
    extraFilesAttached,
    extraFilesFailed,
    aiDoctorName: doctorName !== "Unknown Doctor" ? doctorName : null,
    suggestedProviderOrgId,
    suggestedDoctorName,
    linkedProviderOrgId: effectiveProviderOrgId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /cases/import-from-itero-zip-batch
//
// Accepts up to 20 iTero export ZIPs in a single multipart request (field name
// `files[]`). Each ZIP is processed independently — one case per ZIP, with its
// own AI extraction and PLY attachment. Returns a per-file result array so the
// client can show granular per-ZIP status.
// ─────────────────────────────────────────────────────────────────────────────

const iteroZipBatchUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const tmpDir = path.join(os.tmpdir(), "labtrax-itero-zip");
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
      cb(null, tmpDir);
    },
    filename: (_req, _file, cb) => {
      cb(null, `${Date.now()}-${randomBytes(4).toString("hex")}.zip`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024, files: 20 },
});

const iteroZipBatchBodySchema = z.object({
  labOrganizationId: z.string().min(1, "labOrganizationId is required"),
  providerOrganizationId: z.string().default(""),
  doctorNameHint: z.string().optional(),
  patientFirstNameHint: z.string().optional(),
  patientLastNameHint: z.string().optional(),
  caseTypeHint: z.string().optional(),
  archHint: z.string().optional(),
  materialHint: z.string().optional(),
  receivedAt: calendarDate.optional(),
  invoiceOverrideLines: multipartReviewedInvoiceLines,
});

router.post(
  "/import-from-itero-zip-batch",
  iteroZipBatchUpload.array("files[]", 20),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const body = iteroZipBatchBodySchema.parse(req.body ?? {});
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const batchId = randomBytes(8).toString("hex");

    if (files.length === 0) {
      throw new HttpError(400, "At least one ZIP file is required (field name 'files[]').");
    }
    if (files.length > 20) {
      throw new HttpError(400, "Maximum 20 ZIP files per batch request.");
    }

    await requireMembership(userId, body.labOrganizationId);
    if (body.invoiceOverrideLines !== undefined) {
      await requireAnyRole(userId, body.labOrganizationId, ADMIN_ROLES);
    }

    const user = (req as any).user;

    const results: Array<{
      filename: string;
      status: "created" | "deduped" | "error";
      caseId?: string;
      caseNumber?: string;
      iteroOrderId?: string;
      extraFilesAttached?: number;
      error?: string;
      aiDoctorName?: string | null;
      suggestedProviderOrgId?: string | null;
      suggestedDoctorName?: string | null;
      linkedProviderOrgId?: string | null;
      textureRepair?: { repaired: number; attempted: number; reason?: string };
    }> = [];

    for (const file of files) {
      try {
        const result = await processOneIteroZipFile(req, file, body, userId, user, batchId);
        results.push({
          filename: file.originalname,
          status: result.deduped ? "deduped" : "created",
          caseId: result.caseId,
          caseNumber: result.caseNumber,
          iteroOrderId: result.iteroOrderId,
          extraFilesAttached: result.extraFilesAttached,
          aiDoctorName: result.aiDoctorName,
          suggestedProviderOrgId: result.suggestedProviderOrgId,
          suggestedDoctorName: result.suggestedDoctorName,
          linkedProviderOrgId: result.linkedProviderOrgId,
          textureRepair: result.textureRepair,
        });
      } catch (err) {
        // Best-effort cleanup if the helper threw before deleting the temp file.
        try { fs.unlinkSync(file.path); } catch { /* ignore */ }
        results.push({
          filename: file.originalname,
          status: "error",
          error: err instanceof HttpError ? err.message : (err as Error)?.message ?? "Unknown error",
        });
      }
    }

    // Best-effort session record aggregating all processed ZIPs in this batch
    const createdResults = results.filter((r) => r.status === "created");
    db.insert(iteroImportSessions).values({
      labOrganizationId: body.labOrganizationId,
      importedByUserId: userId,
      createdCount: createdResults.length,
      dedupedCount: results.filter((r) => r.status === "deduped").length,
      erroredCount: results.filter((r) => r.status === "error").length,
      caseIds: createdResults.map((r) => r.caseId).filter(Boolean) as string[],
      batchId,
    }).catch((err: unknown) => {
      req.log?.warn({ err }, "iTero zip-batch: failed to write session record (non-fatal)");
    });

    return ok(res, { results }, 207);
  }),
);

// Shared shape for the structured remake questionnaire used by
// PATCH /:caseId/mark-as-remake.
const remakeLinkBodySchema = z.object({
  remakeOfCaseId: z.string().min(1),
  remakeReason: z.string().min(1).max(2000),
  remakeCharged: z.boolean(),
  // Structured questionnaire fields (optional for backward compat)
  remakeReasonKey: z.enum(REMAKE_REASON_KEYS).optional(),
  remakeShadeLightness: z.enum(["light", "dark"]).optional(),
  remakeShadePrescribed: z.string().max(200).optional(),
  remakeShadeProvided: z.string().max(200).optional(),
  remakeMaterialPrescribed: z.string().max(200).optional(),
  remakeMaterialProvided: z.string().max(200).optional(),
  remakeReturnedToLab: z.boolean().optional(),
  remakeCategory: z.enum(["crown_bridge", "removable"]).optional(),
  remakeNotes: z.string().max(2000).optional(),
});

// Link ANY case (regardless of AI-import/review status) as a remake of an
// earlier case. This powers the Invoice Editor's "Mark as remake" action and
// reuses the shared linking capability (suffix assignment, questionnaire
// fields, history events, no-charge invoice zeroing, audit log).
router.patch(
  "/:caseId/mark-as-remake",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const found = await assertCaseAccess(userId, String(req.params.caseId ?? ""));
    await requireMembership(userId, found.labOrganizationId);
    const user = (req as any).user;

    const input = remakeLinkBodySchema.parse(req.body ?? {});
    const { updated, remakeOriginal } = await linkExistingCaseAsRemake(
      req,
      found,
      input,
      { userId, initials: user?.initials || "SYS" },
    );

    broadcastCaseUpdated(updated.id);
    broadcastCaseUpdated(remakeOriginal.id, "remade");
    return ok(res, {
      caseId: updated.id,
      caseNumber: updated.caseNumber,
      remakeOfCaseId: updated.remakeOfCaseId ?? null,
      remakeReason: updated.remakeReason ?? null,
      remakeCharged: updated.remakeCharged ?? null,
      originalCaseId: remakeOriginal.id,
      originalCaseNumber: remakeOriginal.caseNumber,
    });
  })
);

// ───────── Reports: Production by restoration type (Task #381) ─────────
//
// Counts and revenue for each restorationType across cases received in
// the given window for one lab. Cases are scoped by `cases.receivedAt`
// and exclude soft-deleted rows. A synthetic "Crowns" rollup row sums
// any restoration type whose label contains "crown" (case-insensitive)
// so admins can see total crown production at a glance without losing
// the per-subtype breakdown.
router.get(
  "/reports/production-by-type",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        organizationId: z.string().min(1),
        dateFrom: z.string().min(1),
        dateTo: z.string().min(1),
      })
      .parse(req.query);
    await requireAnyRole(
      (req as any).auth.userId,
      q.organizationId,
      BILLING_ROLES,
    );
    if (!isValidCalendarDate(q.dateFrom) || !isValidCalendarDate(q.dateTo)) {
      throw new HttpError(400, "Invalid dateFrom/dateTo.");
    }

    const rows = (await db
      .select({
        caseId: caseRestorations.caseId,
        restorationType: caseRestorations.restorationType,
        quantity: caseRestorations.quantity,
        unitPrice: caseRestorations.unitPrice,
      })
      .from(caseRestorations)
      .innerJoin(cases, eq(cases.id, caseRestorations.caseId))
      .where(
        and(
          eq(cases.labOrganizationId, q.organizationId),
          notDeleted(cases),
          sql`${cases.receivedAt} >= ${q.dateFrom}`,
          sql`${cases.receivedAt} <= ${q.dateTo}`,
        ),
      )) as Array<{
      caseId: string;
      restorationType: string;
      quantity: number;
      unitPrice: string;
    }>;

    const byType = new Map<
      string,
      { count: number; units: number; cases: Set<string>; revenue: number }
    >();
    let totalCount = 0;
    let totalUnits = 0;
    let totalRevenue = 0;
    const totalCases = new Set<string>();
    let crownCount = 0;
    let crownUnits = 0;
    let crownRevenue = 0;
    const crownCases = new Set<string>();

    for (const r of rows) {
      const type = (r.restorationType || "Unspecified").trim() || "Unspecified";
      const qty = Number(r.quantity || 0);
      const rev = qty * Number(r.unitPrice || 0);
      const cur =
        byType.get(type) ?? {
          count: 0,
          units: 0,
          cases: new Set<string>(),
          revenue: 0,
        };
      cur.count += 1;
      cur.units += qty;
      cur.revenue += rev;
      cur.cases.add(r.caseId);
      byType.set(type, cur);
      totalCount += 1;
      totalUnits += qty;
      totalRevenue += rev;
      totalCases.add(r.caseId);
      if (/crown/i.test(type)) {
        crownCount += 1;
        crownUnits += qty;
        crownRevenue += rev;
        crownCases.add(r.caseId);
      }
    }

    const items = Array.from(byType.entries())
      .map(([restorationType, v]) => ({
        restorationType,
        count: v.count,
        units: v.units,
        cases: v.cases.size,
        revenue: v.revenue.toFixed(2),
      }))
      .sort((a, b) => Number(b.revenue) - Number(a.revenue));

    return ok(res, {
      from: q.dateFrom,
      to: q.dateTo,
      items,
      crownsRollup:
        crownCount > 0
          ? {
              count: crownCount,
              units: crownUnits,
              cases: crownCases.size,
              revenue: crownRevenue.toFixed(2),
            }
          : null,
      totals: {
        count: totalCount,
        units: totalUnits,
        cases: totalCases.size,
        revenue: totalRevenue.toFixed(2),
      },
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /cases/import-generic-zip-bundle
//
// Accepts up to 20 ZIP files (field name `files[]`) and attaches all supported
// file types found inside each ZIP to an existing case specified by `caseId`.
// Unlike the iTero ZIP import this path does NOT create a new case — it only
// adds attachments to a case that already exists.
//
// Supported types extracted from each ZIP:
//   images: .png .jpg .jpeg .gif .webp .tif .tiff .bmp
//   scans:  .ply .stl .obj .dcm .3ds .dae
//   docs:   .pdf .txt .xml
//
// Returns 207 with a per-file result array.
// ─────────────────────────────────────────────────────────────────────────────

const GENERIC_BUNDLE_EXTENSIONS = new Set([
  ".pdf", ".txt", ".xml",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".tif", ".tiff", ".bmp",
  ".ply", ".stl", ".obj", ".dcm", ".3ds", ".dae",
]);

const GENERIC_BUNDLE_EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
  ".ply": "application/octet-stream",
  ".stl": "application/octet-stream",
  ".obj": "application/octet-stream",
  ".dcm": "application/dicom",
  ".3ds": "application/octet-stream",
  ".dae": "model/vnd.collada+xml",
};

const genericBundleUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const tmpDir = path.join(os.tmpdir(), "labtrax-generic-zip");
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
      cb(null, tmpDir);
    },
    filename: (_req, _file, cb) => {
      cb(null, `${Date.now()}-${randomBytes(4).toString("hex")}.zip`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024, files: 20 },
});

const genericBundleBodySchema = z.object({
  labOrganizationId: z.string().min(1, "labOrganizationId is required"),
  caseId: z.string().min(1, "caseId is required"),
});

router.post(
  "/import-generic-zip-bundle",
  genericBundleUpload.array("files[]", 20),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const body = genericBundleBodySchema.parse(req.body ?? {});
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    if (files.length === 0) {
      throw new HttpError(400, "At least one ZIP file is required (field name 'files[]').");
    }

    await requireMembership(userId, body.labOrganizationId);

    const targetCase = await db.query.cases.findFirst({
      where: and(eq(cases.id, body.caseId), notDeleted(cases)),
    });
    if (!targetCase) throw new HttpError(404, "Case not found.");
    if (targetCase.labOrganizationId !== body.labOrganizationId) {
      throw new HttpError(403, "Case does not belong to the specified lab organization.");
    }

    const user = (req as any).user;
    const ZIP_MAX_ENTRIES = 100;
    const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
    const ZIP_MAX_ENTRY_BYTES = 50 * 1024 * 1024;

    const results: Array<{
      filename: string;
      status: "attached" | "error";
      attachedCount: number;
      failedCount: number;
      error?: string;
    }> = [];

    for (const file of files) {
      let extractedEntries: Array<{ name: string; data: Buffer; mimeType: string }> = [];
      let attachedCount = 0;
      let failedCount = 0;

      try {
        try {
          const zip = new AdmZip(file.path);
          const zipEntries = zip.getEntries().filter((e) => !e.isDirectory && e.header.size > 0);
          if (zipEntries.some((entry) => !isSafeArchiveEntryName(entry.entryName))) {
            throw new HttpError(400, "ZIP contains an unsafe archive path.");
          }

          if (zipEntries.length > ZIP_MAX_ENTRIES) {
            throw new HttpError(400, `ZIP contains too many files (${zipEntries.length}). Maximum is ${ZIP_MAX_ENTRIES}.`);
          }
          const totalUncompressed = zipEntries.reduce((sum, e) => sum + (e.header.size ?? 0), 0);
          if (totalUncompressed > ZIP_MAX_TOTAL_BYTES) {
            throw new HttpError(400, `ZIP uncompressed size (${Math.round(totalUncompressed / 1024 / 1024)} MB) exceeds the ${ZIP_MAX_TOTAL_BYTES / 1024 / 1024} MB limit.`);
          }

          for (const entry of zipEntries) {
            const entryName = path.basename(entry.entryName);
            if (!isSafeArchiveEntryName(entry.entryName)) {
              throw new HttpError(400, "ZIP contains an unsafe archive path.");
            }
            if (!entryName) continue;
            const ext = path.extname(entryName).toLowerCase();
            if (!GENERIC_BUNDLE_EXTENSIONS.has(ext)) continue;
            const entrySize = entry.header.size ?? 0;
            if (entrySize > ZIP_MAX_ENTRY_BYTES) {
              req.log?.warn({ name: entryName, size: entrySize }, "Generic ZIP bundle: skipping oversized entry");
              failedCount++;
              continue;
            }
            const mimeType = GENERIC_BUNDLE_EXT_TO_MIME[ext] ?? "application/octet-stream";
            extractedEntries.push({ name: entryName, data: entry.getData(), mimeType });
          }
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, `Could not read ZIP file: ${(err as Error).message}`);
        } finally {
          try { fs.unlinkSync(file.path); } catch { /* ignore */ }
        }

        if (extractedEntries.length === 0 && failedCount === 0) {
          results.push({
            filename: file.originalname,
            status: "error",
            attachedCount: 0,
            failedCount: 0,
            error: "No supported files found in ZIP (.pdf, images, .ply, .stl, .obj, etc.).",
          });
          continue;
        }

        try { fs.mkdirSync(caseMediaDir, { recursive: true }); } catch { /* ignore */ }

        const texturePairs = pairPlyTextures(extractedEntries);
        const attachmentIds = new Map<string, string>();
        for (const entry of extractedEntries) {
          try {
            const ext = path.extname(entry.name) || "";
            const safe = path.basename(entry.name, ext).replace(/[^a-zA-Z0-9\-_]+/g, "-").slice(0, 60) || "file";
            const diskName = `${Date.now()}-${randomBytes(4).toString("hex")}-${safe}${ext}`;
            const diskPath = path.join(caseMediaDir, diskName);
      await writeProductionUpload(diskPath, entry.data, "case-import");
            writeCaseMediaToObjectStorage(diskName, entry.data, entry.mimeType).catch((err: unknown) => {
              req.log?.warn({ err, name: entry.name }, "Generic ZIP bundle: failed to mirror to object storage");
            });
            const storageKey = buildIteroAttachmentUrl(req, diskName);
            const [saved] = await db.insert(caseAttachments).values({
              caseId: body.caseId,
              uploadedByUserId: userId,
              uploadedByOrganizationId: body.labOrganizationId,
              fileName: entry.name,
              storageKey,
              fileType: entry.mimeType,
              visibility: "internal_lab_only",
            }).returning({ id: caseAttachments.id });
            attachmentIds.set(entry.name, saved!.id);
            attachedCount++;
          } catch (attachErr) {
            failedCount++;
            req.log?.warn({ err: attachErr, name: entry.name, caseId: body.caseId }, "Generic ZIP bundle: failed to save attachment");
          }
        }
        for (const [plyName, textureName] of texturePairs) {
          const plyId = attachmentIds.get(plyName);
          const textureId = attachmentIds.get(textureName);
          if (plyId && textureId) {
            await db.update(caseAttachments)
              .set({ textureAttachmentId: textureId })
              .where(and(eq(caseAttachments.id, plyId), eq(caseAttachments.caseId, body.caseId)));
          }
        }

        if (attachedCount > 0) {
          await db.insert(caseEvents).values({
            caseId: body.caseId,
            eventType: "files_attached_from_zip",
            actorUserId: userId,
            actorOrganizationId: body.labOrganizationId,
            actorInitials: user?.initials || "SYS",
            metadataJson: { zipFilename: file.originalname, attachedCount, failedCount, source: "generic_bundle" },
          }).catch((err: unknown): never => wrapDbError(err, {
            fallback: "Failed to record files_attached_from_zip event.",
          }));

          await writeAuditLog({
            req,
            organizationId: body.labOrganizationId,
            action: "generic_zip_bundle_attached",
            entityType: "case",
            entityId: body.caseId,
            afterJson: { caseId: body.caseId, zipFilename: file.originalname, attachedCount, failedCount },
          });
        }

        results.push({ filename: file.originalname, status: "attached", attachedCount, failedCount });
      } catch (err) {
        try { fs.unlinkSync(file.path); } catch { /* ignore */ }
        results.push({
          filename: file.originalname,
          status: "error",
          attachedCount: 0,
          failedCount: 0,
          error: err instanceof HttpError ? err.message : (err as Error)?.message ?? "Unknown error",
        });
      }
    }

    if (results.some((r) => r.status === "attached" && r.attachedCount > 0)) {
      broadcastCaseUpdated(body.caseId);
    }
    return ok(res, { results }, 207);
  }),
);

// ── iTero per-lab auto-link setting endpoints ────────────────────────────────
//
// Read/write the per-lab toggle that gates whether the iTero auto-poller
// (`/cases/import-from-itero-rx`) and the desktop ZIP batch importer
// (`/cases/import-itero-zip-batch`) override the poller's default
// providerOrganizationId with the AI-suggested one when the similarity
// match returns a different practice. Lab membership required for GET,
// admin role for PUT.

router.get(
  "/itero-settings/:labOrganizationId",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const labOrganizationId = req.params.labOrganizationId as string;
    await requireMembership(userId, labOrganizationId);
    const autoLinkSuggestedPractice =
      await getIteroAutoLinkSuggestedPractice(labOrganizationId);
    return ok(res, { labOrganizationId, autoLinkSuggestedPractice });
  })
);

router.put(
  "/itero-settings/:labOrganizationId",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const labOrganizationId = req.params.labOrganizationId as string;
    await requireAnyRole(userId, labOrganizationId, ADMIN_ROLES);
    const input = z
      .object({ autoLinkSuggestedPractice: z.boolean() })
      .parse(req.body ?? {});
    await setIteroAutoLinkSuggestedPractice(
      labOrganizationId,
      input.autoLinkSuggestedPractice,
      userId,
    );
    await writeAuditLog({
      req,
      organizationId: labOrganizationId,
      action: "itero_auto_link_setting_updated",
      entityType: "organization",
      entityId: labOrganizationId,
      afterJson: { autoLinkSuggestedPractice: input.autoLinkSuggestedPractice },
    });
    return ok(res, {
      labOrganizationId,
      autoLinkSuggestedPractice: input.autoLinkSuggestedPractice,
    });
  })
);

export default router;
