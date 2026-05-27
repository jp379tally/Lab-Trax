import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Router, type Request, type Response } from "express";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  caseAttachments,
  caseEvents,
  caseLocations,
  caseNotes,
  caseRestorations,
  caseSubmissionQueue,
  cases,
  invoiceLineItems,
  invoices,
  iteroImportedOrders,
  iteroImportSessions,
  labCases,
  notifications,
  organizationConnections,
  organizationMemberships,
  organizations,
  systemSettings,
  users,
} from "@workspace/db";
import multer from "multer";
import { randomBytes } from "node:crypto";
import OpenAI, { toFile } from "openai";
import AdmZip from "adm-zip";
import { writeAuditLog } from "../lib/audit";
import { calculateLineTotal, sumMoney } from "../lib/case";
import { syncInvoiceFromRestorations, buildGroupedLineItemsForInvoice } from "../lib/invoice-sync";
import {
  classifyMatch,
  splitDisplayName,
  type SimilarityMatchKind,
} from "../lib/patient-similarity";
import { notDeleted, softDeleteById } from "../lib/soft-delete";
import { caseMediaDir, extractMediaFileName } from "../lib/case-media";
import {
  openCaseMediaObjectStream,
  writeCaseMediaToObjectStorage,
} from "../lib/case-media-object-storage";
import { deleteFromOneDrive } from "../lib/onedrive";
import { HttpError, ok } from "../lib/http";
import {
  buildLineItemDescription,
  fetchLabItemLabels,
  materialToPriceKey,
  resolveAllPricesForContext,
  resolveItemLabelFromMap,
  resolveServerPriceWithSource,
  type ResolvedItemRow,
} from "../lib/pricing";
import { ADMIN_ROLES, BILLING_ROLES, requireAnyRole, requireMembership } from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import { getProviderOrgIdsForUserAndLinks } from "../lib/cross-lab-doctor";

// ---------------------------------------------------------------------------
// Bigram similarity helpers — used for AI-extracted doctor name suggestions.
// Intentionally self-contained so no dependency on the doctors route.
// ---------------------------------------------------------------------------
function _normalizeDoctorForSim(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/\bdr\.?\s*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function _bigramSimilarity(a: string, b: string): number {
  const an = _normalizeDoctorForSim(a);
  const bn = _normalizeDoctorForSim(b);
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

const router = Router();
router.use(requireAuth);

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
): Promise<void> {
  const note = `Case ${newCase.caseNumber} created as a remake of this case${
    reason ? ` (reason: ${reason})` : ""
  }, charged: ${charged === true ? "yes" : charged === false ? "no" : "unspecified"}`;
  if (original.kind === "canonical") {
    await db.insert(caseEvents).values({
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
    });
    return;
  }
  // Legacy original: append to activityLog and persist.
  const data =
    original.caseData && typeof original.caseData === "object"
      ? { ...original.caseData }
      : {};
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
  await db
    .update(labCases)
    .set({ caseData: JSON.stringify(data), updatedAt: new Date() })
    .where(eq(labCases.id, original.id));
}

// Canonical authenticated file-download route.
// Authorizes by exact (caseId, attachmentId) identity from the DB record,
// then derives the on-disk filename from storageKey via extractMediaFileName.
// The served file path comes from the authoritative DB record, never from the
// raw URL, preventing any decoupled-authorization / confused-deputy attacks.
router.get(
  "/:caseId/attachments/:attachmentId/file",
  asyncHandler(async (req: Request, res: Response) => {
    const caseId = String(req.params["caseId"] ?? "");
    const attachmentId = String(req.params["attachmentId"] ?? "");

    const { labMembership } = await assertCaseAccessWithMemberships(
      (req as any).auth.userId,
      caseId,
    );

    const attachment = await db.query.caseAttachments.findFirst({
      where: and(
        eq(caseAttachments.id, attachmentId),
        eq(caseAttachments.caseId, caseId),
      ),
    });

    if (!attachment) {
      throw new HttpError(404, "Attachment not found.");
    }

    if (attachment.visibility === "internal_lab_only" && !labMembership) {
      throw new HttpError(403, "You do not have access to this file.");
    }

    const filename = extractMediaFileName(attachment.storageKey);
    if (!filename) {
      throw new HttpError(404, "File not found.");
    }

    const resolvedPath = path.resolve(caseMediaDir, filename);
    if (
      resolvedPath === caseMediaDir ||
      !resolvedPath.startsWith(caseMediaDir + path.sep)
    ) {
      throw new HttpError(400, "Invalid file path.");
    }

    if (!fs.existsSync(resolvedPath)) {
      const objStream = await openCaseMediaObjectStream(filename, attachment.fileType ?? undefined);
      if (!objStream) {
        throw new HttpError(404, "File not found.");
      }
      res.setHeader("Content-Type", objStream.contentType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(attachment.fileName ?? filename)}"`,
      );
      objStream.stream.pipe(res);
      return;
    }

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

    // Reject ambiguous matches.
    if (matching.length !== 1) {
      throw new HttpError(404, "Attachment not found.");
    }

    const attachment = matching[0]!;

    // Auth check before any response — no case/attachment IDs exposed.
    const { labMembership } = await assertCaseAccessWithMemberships(
      (req as any).auth.userId,
      attachment.caseId,
    );

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

    if (!fs.existsSync(resolvedPath)) {
      const objStream = await openCaseMediaObjectStream(resolvedFilename, attachment.fileType ?? undefined);
      if (!objStream) {
        throw new HttpError(404, "File not found.");
      }
      res.setHeader("Content-Type", objStream.contentType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(attachment.fileName ?? resolvedFilename)}"`,
      );
      objStream.stream.pipe(res);
      return;
    }

    return res.sendFile(resolvedPath);
  })
);

async function assertCaseAccess(userId: string, caseId: string) {
  const access = await assertCaseAccessWithMemberships(userId, caseId);
  return access.case;
}

async function assertCaseAccessWithMemberships(userId: string, caseId: string) {
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
  return { case: found, labMembership, providerMembership };
}

const ATTACHMENT_VISIBILITIES = [
  "shared_with_provider",
  "internal_lab_only",
] as const;

function visibleAttachmentsFor(
  attachments: any[],
  isLabMember: boolean
): any[] {
  if (isLabMember) return attachments;
  return attachments.filter(
    (a: any) => a.visibility !== "internal_lab_only"
  );
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
  dueDate: z.string().optional(),
  restorations: z
    .array(
      z.object({
        toothNumber: z.string().min(1),
        restorationType: z.string().min(1),
        material: z.string().optional(),
        shade: z.string().optional(),
        notes: z.string().optional(),
        quantity: z.coerce.number().int().positive().default(1),
        unitPrice: z.coerce.number().min(0).default(0),
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
  // Optional case-level note inserted alongside the case. Used by the
  // dashboard drag-drop AI flow to forward the prescription's free-text
  // notes ("Old shade A2, new shade B1", "Patient grinds at night",
  // etc.) so they land in case_notes BEFORE the auto-invoice block runs
  // and pre-populates `displayMetadataJson.caseNotes` from them.
  // Visibility defaults to shared_with_provider so the doctor sees the
  // note on their end too.
  notes: z.string().min(1).max(8000).optional(),
  // Optional barcode to assign to the case pan at creation time.
  // Empty strings are treated as omitted (no barcode assigned).
  casePanBarcode: z.string().optional().transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
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

export interface PatientSimilarityHit {
  id: string;
  source: "canonical" | "legacy";
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
  hasInvoice: boolean;
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
          .select({ caseId: invoices.caseId })
          .from(invoices)
          .where(inArray(invoices.caseId, candidateIds))
      : [];
    const invoicedSet = new Set(
      invoiceRows.map((r: any) => r.caseId).filter(Boolean) as string[],
    );
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
      hits.push({
        id: row.id,
        source: "canonical",
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
        hasInvoice: invoicedSet.has(row.id),
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
          hasInvoice: !!parsed.invoiceId,
        });
      } catch {
        // ignore malformed legacy payloads
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

    // No result cap — Task #331 requires that remakes from years ago are
    // still surfaced, so we never truncate the candidate list.
    return ok(res, { matches: hits });
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
    const [countRow] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(cases)
      .where(and(eq(cases.remakeOfCaseId, original.id), notDeleted(cases)));
    const existingCount = countRow?.cnt ?? 0;
    if (existingCount > 23) {
      throw new HttpError(
        409,
        `Too many remakes of case ${original.caseNumber} (maximum 24).`,
      );
    }
    const suffixLetter = String.fromCharCode(66 + existingCount);
    return ok(res, { caseNumber: `${original.caseNumber}${suffixLetter}` });
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

    // Determine which lab org the caller belongs to by looking up the first
    // case in the batch. All cases must belong to the same lab.
    const firstCase = await db.query.cases.findFirst({
      where: and(eq(cases.id, uniqueCaseIds[0]!), notDeleted(cases)),
    });
    if (!firstCase) {
      throw new HttpError(404, "No matching cases found.");
    }
    const labOrganizationId = firstCase.labOrganizationId;

    // Require the caller to be a lab member.
    const membership = await requireMembership(userId, labOrganizationId);
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

    // Load all requested cases and verify they all belong to the same lab.
    const casesToUpdate = await db
      .select({ id: cases.id, labOrganizationId: cases.labOrganizationId, caseNumber: cases.caseNumber })
      .from(cases)
      .where(and(inArray(cases.id, uniqueCaseIds), notDeleted(cases)));

    const unauthorizedIds = casesToUpdate
      .filter((c) => c.labOrganizationId !== labOrganizationId)
      .map((c) => c.id);
    if (unauthorizedIds.length > 0) {
      throw new HttpError(403, "Some cases do not belong to your lab.");
    }

    // Missing IDs means the client passed IDs that don't exist.
    if (casesToUpdate.length !== uniqueCaseIds.length) {
      const foundIds = new Set(casesToUpdate.map((c) => c.id));
      const missing = uniqueCaseIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new HttpError(404, `Cases not found: ${missing.slice(0, 5).join(", ")}`);
      }
    }

    if (casesToUpdate.length === 0) {
      return ok(res, { updatedCount: 0 });
    }

    const ids = casesToUpdate.map((c) => c.id);

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

    await writeAuditLog({
      userId,
      organizationId: labOrganizationId,
      action: "cases_bulk_reassigned",
      entityType: "case",
      entityId: labOrganizationId,
      metadataJson: {
        caseIds: ids,
        caseNumbers: casesToUpdate.map((c) => c.caseNumber),
        targetProviderOrganizationId: input.providerOrganizationId,
        targetProviderName: (targetProvider as any).displayName || targetProvider.name,
        count: ids.length,
      },
    });

    return ok(res, { updatedCount: ids.length });
  })
);

const VALID_BULK_STATUSES = [
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
] as const;

const bulkStatusSchema = z.object({
  caseIds: z.array(z.string().min(1)).min(1).max(500),
  status: z.enum(VALID_BULK_STATUSES),
});

router.post(
  "/bulk-status",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId as string;
    const input = bulkStatusSchema.parse(req.body);

    const uniqueCaseIds = Array.from(new Set(input.caseIds));

    const firstCase = await db.query.cases.findFirst({
      where: and(eq(cases.id, uniqueCaseIds[0]!), notDeleted(cases)),
    });
    if (!firstCase) {
      throw new HttpError(404, "No matching cases found.");
    }
    const labOrganizationId = firstCase.labOrganizationId;

    await requireMembership(userId, labOrganizationId);

    const casesToUpdate = await db
      .select({ id: cases.id, labOrganizationId: cases.labOrganizationId, caseNumber: cases.caseNumber })
      .from(cases)
      .where(and(inArray(cases.id, uniqueCaseIds), notDeleted(cases)));

    const unauthorizedIds = casesToUpdate
      .filter((c) => c.labOrganizationId !== labOrganizationId)
      .map((c) => c.id);
    if (unauthorizedIds.length > 0) {
      throw new HttpError(403, "Some cases do not belong to your lab.");
    }

    if (casesToUpdate.length !== uniqueCaseIds.length) {
      const foundIds = new Set(casesToUpdate.map((c) => c.id));
      const missing = uniqueCaseIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new HttpError(404, `Cases not found: ${missing.slice(0, 5).join(", ")}`);
      }
    }

    if (casesToUpdate.length === 0) {
      return ok(res, { updatedCount: 0 });
    }

    const ids = casesToUpdate.map((c) => c.id);

    await db
      .update(cases)
      .set({ status: input.status, updatedAt: new Date() })
      .where(inArray(cases.id, ids));

    await writeAuditLog({
      userId,
      organizationId: labOrganizationId,
      action: "cases_bulk_status_changed",
      entityType: "case",
      entityId: labOrganizationId,
      metadataJson: {
        caseIds: ids,
        caseNumbers: casesToUpdate.map((c) => c.caseNumber),
        status: input.status,
        count: ids.length,
      },
    });

    return ok(res, { updatedCount: ids.length });
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
    await requireMembership(
      (req as any).auth.userId,
      input.labOrganizationId
    );

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

    // For remake cases, compute the next letter suffix (B, C, D, …) inside
    // a transaction so the count + insert are atomic. The UNIQUE constraint
    // on cases.caseNumber is the ultimate guard against collisions even
    // under concurrent creates of the same remake target.
    const createdCase = await db.transaction(async (tx) => {
      let resolvedCaseNumber: string;
      if (remakeOriginal) {
        // Acquire a transaction-scoped advisory lock keyed on the original case
        // ID.  pg_advisory_xact_lock blocks until any other holder releases at
        // transaction end, so two concurrent remake creates for the same
        // original (whether canonical or legacy lab_cases) serialise here
        // instead of both reading the same count and colliding on suffix letter.
        // hashtext() folds the UUID string into the int4 space expected by the
        // two-arg form; the constant first arg namespaces it away from any
        // other advisory lock usage in the app.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(1742068800, hashtext(${remakeOriginal.id}))`,
        );

        // Count non-deleted remakes already pointing at the same original.
        const [countRow] = await tx
          .select({ cnt: sql<number>`count(*)::int` })
          .from(cases)
          .where(
            and(
              eq(cases.remakeOfCaseId, remakeOriginal.id),
              notDeleted(cases),
            ),
          );
        const existingCount = countRow?.cnt ?? 0;
        // 0 → 'B', 1 → 'C', 2 → 'D', … up to 'Z' (24 remakes, charCode 90).
        // Reject gracefully if the limit is exceeded rather than silently
        // producing a non-letter character.
        if (existingCount > 23) {
          throw new HttpError(
            409,
            `Too many remakes of case ${remakeOriginal.caseNumber} (maximum 24).`,
          );
        }
        const suffixLetter = String.fromCharCode(66 + existingCount);
        resolvedCaseNumber = `${remakeOriginal.caseNumber}${suffixLetter}`;
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
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          expectedDeliveryDate: (() => {
            const d = new Date();
            d.setDate(d.getDate() + 7);
            return d;
          })(),
          createdByUserId: (req as any).auth.userId,
          remakeOfCaseId: remakeOriginal?.id ?? null,
          remakeReason: remakeOriginal ? input.remakeReason ?? null : null,
          remakeCharged: remakeOriginal
            ? input.remakeCharged ?? null
            : null,
          casePanBarcode: input.casePanBarcode ?? null,
        })
        .returning();

      return created;
    });

    if (input.restorations && input.restorations.length > 0) {
      // Resolve all prices in a single batch (3 DB round-trips total) instead
      // of one call per restoration, cutting O(N) pool pressure to O(1).
      // For any price key not covered by the batch (non-standard keys), fall
      // back to the individual resolver so pricing accuracy is preserved.
      const needsAutoPrice = input.restorations.some(
        (r) => !(Number.isFinite(r.unitPrice) && r.unitPrice > 0)
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
          const userSupplied = Number.isFinite(unit) && unit > 0;
          let priceSource: string | null = userSupplied ? "manual" : null;
          let priceSourceId: string | null = null;
          let priceSourceName: string | null = null;
          let priceKey: string | null = null;
          if (!userSupplied) {
            const key = materialToPriceKey(r.material, r.restorationType);
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
                r.restorationType
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
          return {
            caseId: createdCase.id,
            toothNumber: r.toothNumber,
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
        })
      );
      await db.insert(caseRestorations).values(resolved);
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
        visibility: "shared_with_provider",
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

    // Fire all independent post-insert work concurrently:
    //   • case_created timeline event
    //   • audit log write
    //   • remake cross-link events (when applicable)
    //   • auto-invoice generation
    // None of these depend on each other's result, so running them in
    // parallel cuts the perceived latency of the "Creating case…" spinner
    // roughly in half compared to the previous sequential chain.
    await Promise.all([
      // ── timeline event ────────────────────────────────────────────────
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
      }),

      // ── audit log ─────────────────────────────────────────────────────
      writeAuditLog({
        req,
        organizationId: input.labOrganizationId,
        action: "case_created",
        entityType: "case",
        entityId: createdCase.id,
        afterJson: createdCase,
      }),

      // ── remake cross-link events (no-op when not a remake) ────────────
      // Cross-link history entries on both the new (remake) case and the
      // original being remade so staff can navigate between them and see
      // the remake reason / charge decision in the timeline forever.
      remakeOriginal
        ? (async () => {
            const reason = input.remakeReason ?? null;
            const charged = input.remakeCharged ?? null;
            // Forward-side event on the new canonical case is always
            // written to case_events. Reciprocal "remade_by" goes to
            // case_events when the original is canonical, or onto the
            // legacy activityLog when the original is a legacy lab_cases
            // row (handled by helper).
            await db.insert(caseEvents).values({
              caseId: createdCase.id,
              eventType: "remake_of",
              actorUserId: (req as any).auth.userId,
              actorOrganizationId: input.labOrganizationId,
              actorInitials: user?.initials || "SYS",
              metadataJson: {
                originalCaseId: remakeOriginal.id,
                originalCaseNumber: remakeOriginal.caseNumber,
                originalCaseKind: remakeOriginal.kind,
                remakeReason: reason,
                remakeCharged: charged,
                note: `Marked as remake of ${remakeOriginal.kind === "legacy" ? "legacy " : ""}case ${remakeOriginal.caseNumber}${reason ? ` (reason: ${reason})` : ""}`,
              },
            });
            await writeReciprocalRemadeBy(
              remakeOriginal,
              { id: createdCase.id, caseNumber: createdCase.caseNumber },
              reason,
              charged,
              {
                userId: (req as any).auth.userId,
                orgId: input.labOrganizationId,
                initials: user?.initials || "SYS",
              },
            );
          })()
        : Promise.resolve(),

      // ── auto-invoice generation ────────────────────────────────────────
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
      (async () => {
        try {
          // Fetch restorations, provider org, and case notes in parallel —
          // all three are independent reads against different tables.
          const [restorationsForInvoice, providerOrgRow, caseLevelNotes] =
            await Promise.all([
              db.query.caseRestorations.findMany({
                where: eq(caseRestorations.caseId, createdCase.id),
              }),
              db.query.organizations.findFirst({
                where: eq(organizations.id, createdCase.providerOrganizationId),
              }),
              db.query.caseNotes.findMany({
                where: eq(caseNotes.caseId, createdCase.id),
              }),
            ]);

          const hasLines = restorationsForInvoice.length > 0;
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
              restorationsForInvoice
                .map((r) => (r.toothNumber || "").trim())
                .filter(Boolean),
            ),
          ).join(", ");
          const shadeList = Array.from(
            new Set(
              restorationsForInvoice
                .map((r) => (r.shade || "").trim())
                .filter(Boolean),
            ),
          ).join(", ");
          const caseNotesText = [
            ...caseLevelNotes.map((n) => (n.noteText || "").trim()),
            ...restorationsForInvoice.map((r) => (r.notes || "").trim()),
          ]
            .filter(Boolean)
            .join("\n");
          const displayMetadata: Record<string, unknown> = {
            patientName: `${input.patientFirstName} ${input.patientLastName}`.trim(),
            billTo: billToName,
            teeth: teethList,
            shade: shadeList,
            caseNotes: caseNotesText,
            credits: 0,
            lineItems: restorationsForInvoice.map((r) => ({
              item: r.restorationType,
              description: `${r.restorationType} - Tooth ${r.toothNumber}`,
            })),
          };

          const [newInvoice] = await db
            .insert(invoices)
            .values({
              invoiceNumber,
              caseId: createdCase.id,
              labOrganizationId: createdCase.labOrganizationId,
              providerOrganizationId: createdCase.providerOrganizationId,
              // Always create the invoice as "open" (active, awaiting
              // payment) — never "draft". Even an empty / unpriced auto-
              // invoice should appear on the open-balance worklist so the
              // lab knows it needs to be filled in and sent.
              status: "open",
              issuedAt: new Date(),
              displayMetadataJson: displayMetadata,
              createdByUserId: (req as any).auth.userId,
              updatedByUserId: (req as any).auth.userId,
              ...(noChargeNote ? { notes: noChargeNote } : {}),
            })
            .onConflictDoNothing()
            .returning();
          if (newInvoice) {
            if (hasLines) {
              // Batch-fetch all custom labels for this lab in one query so
              // the per-restoration label resolution below is N×0 DB calls
              // instead of the previous N×1 pattern.
              const labLabelMap = await fetchLabItemLabels(
                createdCase.labOrganizationId,
              );
              await db.insert(invoiceLineItems).values(
                restorationsForInvoice.map((r, idx) => {
                  const pk =
                    materialToPriceKey(r.material, r.restorationType) ??
                    r.restorationType;
                  const baseLabel = resolveItemLabelFromMap(labLabelMap, pk);
                  const baseDesc = buildLineItemDescription(r.toothNumber, baseLabel);
                  return {
                    invoiceId: newInvoice.id,
                    caseRestorationId: r.id,
                    description: noChargeRemake
                      ? `${baseDesc} (no-charge remake)`
                      : baseDesc,
                    quantity: r.quantity,
                    unitPrice: noChargeRemake ? "0.00" : r.unitPrice,
                    lineTotal: noChargeRemake
                      ? "0.00"
                      : calculateLineTotal(r.quantity, r.unitPrice),
                    sortOrder: idx,
                  };
                }),
              );
            }
            const items = await db.query.invoiceLineItems.findMany({
              where: eq(invoiceLineItems.invoiceId, newInvoice.id),
            });
            const subtotal = sumMoney(items.map((it) => it.lineTotal));
            const [finalized] = await db
              .update(invoices)
              .set({
                subtotal,
                total: subtotal,
                balanceDue: subtotal,
                updatedByUserId: (req as any).auth.userId,
              })
              .where(eq(invoices.id, newInvoice.id))
              .returning();
            await db.insert(caseEvents).values({
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
        } catch (err) {
          // Auto-invoice failure should not block case creation. The user
          // can hit "Generate invoice" manually from the Invoice tab.
          req.log?.warn?.(
            { err, caseId: createdCase.id },
            "auto invoice generation on case create failed",
          );
        }
      })(),
    ]);

    return ok(res, createdCase, 201);
      })(),
      timeoutSignal,
    ]);
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const organizationId = req.query.organizationId as string | undefined;
    const include = String(req.query.include ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const includeRestorations = include.includes("restorations");
    const callerId = (req as any).auth.userId as string;

    // Resolve the caller's userType so we can decide whether to expand
    // cross-lab linked-doctor memberships (Task #320). Lab users always see
    // only their own lab; provider users see every linked-doctor copy.
    let baseOrgIds: string[];
    if (organizationId) {
      baseOrgIds = [organizationId];
    } else {
      baseOrgIds = (
        await db.query.organizationMemberships.findMany({
          where: and(
            eq(organizationMemberships.userId, callerId),
            eq(organizationMemberships.status, "active")
          ),
        })
      ).map((m: any) => m.labId);
    }
    let membershipOrgIds = baseOrgIds;
    if (!organizationId) {
      const callerUser = await db.query.users.findFirst({
        where: eq(users.id, callerId),
      });
      if (callerUser?.userType === "provider") {
        const { providerOrgIds } = await getProviderOrgIdsForUserAndLinks(
          callerId
        );
        membershipOrgIds = Array.from(
          new Set([...baseOrgIds, ...providerOrgIds])
        );
      }
    }

    // Status map: mobile legacy → desktop format
    const MOBILE_TO_DESKTOP_STATUS: Record<string, string> = {
      INTAKE: "received",
      DESIGN: "in_design",
      MILLING: "in_milling",
      PORCELAIN: "in_porcelain",
      QC_CHECK: "qc",
      DELIVERY: "shipped",
      COMPLETE: "delivered",
      ON_HOLD: "on_hold",
      REMAKE: "remake",
    };

    const [rows, mobileRows] = await Promise.all([
      membershipOrgIds.length
        ? db.query.cases.findMany({
            where: and(
              or(
                inArray(cases.labOrganizationId, membershipOrgIds),
                inArray(cases.providerOrganizationId, membershipOrgIds)
              ),
              notDeleted(cases)
            ),
            orderBy: [desc(cases.createdAt)],
            // Cap at 500 most-recent cases to bound query duration and release
            // the DB connection sooner, reducing pool pressure on concurrent POSTs.
            limit: 500,
          })
        : Promise.resolve([]),
      membershipOrgIds.length
        ? db
            .select()
            .from(labCases)
            .where(
              and(
                isNull(labCases.deletedAt),
                inArray(labCases.organizationId, membershipOrgIds)
              )
            )
        : Promise.resolve([]),
    ]);

    const caseIds = rows.map((r: any) => r.id);
    const restorations = caseIds.length
      ? await db.query.caseRestorations.findMany({
          where: inArray(caseRestorations.caseId, caseIds),
        })
      : [];
    const byCase = new Map<string, typeof restorations>();
    for (const r of restorations) {
      const list = byCase.get(r.caseId) ?? [];
      list.push(r);
      byCase.set(r.caseId, list);
    }
    const enriched: any[] = rows.map((row: any) => {
      const items = byCase.get(row.id) ?? [];
      const teeth = items.map((i: any) => i.toothNumber).join(", ");
      const types = Array.from(
        new Set(items.map((i: any) => i.restorationType).filter(Boolean))
      ).join(", ");
      const materials = Array.from(
        new Set(items.map((i: any) => i.material).filter(Boolean))
      ).join(", ");
      const price = items.reduce(
        (sum: number, i: any) =>
          sum + Number(i.quantity ?? 0) * Number(i.unitPrice ?? 0),
        0
      );
      return {
        ...row,
        restorationCount: items.length,
        restorationTypes: types || null,
        restorationMaterials: materials || null,
        teeth: teeth || null,
        totalPrice: price.toFixed(2),
        ...(includeRestorations ? { restorations: items } : {}),
      };
    });

    // Bridge mobile cases into the desktop list so users see everything
    // regardless of which platform they used to create the case.
    const desktopIdSet = new Set(rows.map((r: any) => r.id));
    for (const mr of mobileRows) {
      if (desktopIdSet.has(mr.id)) continue;
      try {
        const parsed = typeof mr.caseData === "string" ? JSON.parse(mr.caseData) : mr.caseData;
        if (!parsed || typeof parsed !== "object") continue;
        const patientName = String(parsed.patientName ?? "");
        const spaceIdx = patientName.indexOf(" ");
        const firstName = spaceIdx >= 0 ? patientName.slice(0, spaceIdx) : patientName;
        const lastName = spaceIdx >= 0 ? patientName.slice(spaceIdx + 1) : "";
        const rawStatus = String(parsed.status ?? "INTAKE").toUpperCase();
        const desktopStatus = MOBILE_TO_DESKTOP_STATUS[rawStatus] ?? "received";
        const createdAt = parsed.createdAt
          ? new Date(Number(parsed.createdAt)).toISOString()
          : new Date().toISOString();
        const updatedAt = parsed.updatedAt
          ? new Date(Number(parsed.updatedAt)).toISOString()
          : createdAt;
        enriched.push({
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
        });
      } catch {
        // skip malformed rows
      }
    }

    // Apply optional query filters (search, status, barcode)
    const rawSearch = String(req.query.search ?? "").trim().toLowerCase();
    const rawStatus = String(req.query.status ?? "").trim().toLowerCase();
    const rawBarcode = String(req.query.barcode ?? "").trim();

    let filtered = enriched;
    if (rawSearch) {
      filtered = filtered.filter((c) => {
        const fn = String(c.patientFirstName ?? "").toLowerCase();
        const ln = String(c.patientLastName ?? "").toLowerCase();
        const dr = String(c.doctorName ?? "").toLowerCase();
        const cn = String(c.caseNumber ?? "").toLowerCase();
        return fn.includes(rawSearch) || ln.includes(rawSearch) || dr.includes(rawSearch) || cn.includes(rawSearch);
      });
    }
    if (rawStatus) {
      filtered = filtered.filter((c) => String(c.status ?? "").toLowerCase() === rawStatus);
    }
    if (rawBarcode) {
      filtered = filtered.filter((c) => String(c.casePanBarcode ?? "") === rawBarcode);
    }

    if (!filtered.length) return ok(res, []);
    return ok(res, filtered);
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cases/quick-search
//
// Lightweight case search for the desktop file-drop zone case picker.
// Returns at most 20 cases matching the query (case number prefix, patient
// first/last name prefix) for a given lab. Requires lab membership.
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
    const results = await db
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
          ),
        ),
      )
      .orderBy(desc(cases.createdAt))
      .limit(20);

    return ok(res, { cases: results });
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

    if (!found) throw new HttpError(404, "No case found with that barcode.");
    return ok(res, { case: found });
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
    const access = await assertCaseAccessWithMemberships(
      (req as any).auth.userId,
      req.params.caseId
    );
    const found = access.case;
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
          where: eq(caseAttachments.caseId, found.id),
          orderBy: [desc(caseAttachments.createdAt)],
        }),
        db.query.caseEvents.findMany({
          where: eq(caseEvents.caseId, found.id),
          orderBy: [desc(caseEvents.occurredAt)],
        }),
        db.query.caseLocations.findMany({
          where: eq(caseLocations.caseId, found.id),
        }),
      ]);

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
    const enrichedAttachments = attachments.map((a: any) => ({
      ...a,
      uploaderName: displayNameFor(a.uploadedByUserId),
    }));
    const enrichedNotes = notes.map((n: any) => ({
      ...n,
      authorName: displayNameFor(n.authorUserId),
    }));

    const isLabMember = !!access.labMembership;
    const labRole = access.labMembership?.role as string | undefined;
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

    let remakeOriginal: {
      id: string;
      caseNumber: string;
      patientFirstName: string | null;
      patientLastName: string | null;
      status: string | null;
      createdAt: Date | string | null;
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
      remakeOriginal = {
        id: remakeOriginalLegacyRow.id,
        caseNumber: parsed?.caseNumber ?? remakeOriginalLegacyRow.id,
        patientFirstName: parsed?.patientFirstName ?? parsed?.patientName ?? null,
        patientLastName: parsed?.patientLastName ?? null,
        status: parsed?.status ?? null,
        createdAt: parsed?.createdAt ?? remakeOriginalLegacyRow.updatedAt ?? null,
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
      remakeChildren.push({
        id: lr.id,
        caseNumber: String(parsed?.caseNumber ?? lr.id),
        patientFirstName: parsed?.patientFirstName ?? split.first ?? null,
        patientLastName: parsed?.patientLastName ?? split.last ?? null,
        status: parsed?.status ?? null,
        createdAt: parsed?.createdAt ?? lr.updatedAt ?? null,
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
    if (found.suggestedProviderOrgId) {
      const suggestedOrg = await db.query.organizations.findFirst({
        where: eq(organizations.id, found.suggestedProviderOrgId),
      });
      suggestedPracticeName = suggestedOrg?.name ?? null;
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
      draft: "Draft",
    };
    const statusHistory: Array<{ status: string; label: string; occurredAt: Date }> = [
      { status: "received", label: STATUS_LABELS["received"] ?? "Received", occurredAt: found.receivedAt },
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

    return ok(res, {
      ...found,
      suggestedPracticeName,
      restorations,
      notes: enrichedNotes,
      attachments: visibleAttachmentsFor(enrichedAttachments, isLabMember),
      events,
      originalCaseEvents,
      remakeChildrenEvents,
      locations,
      remakeOriginal,
      remakeChildren,
      viewerIsLabMember: isLabMember,
      viewerCanManageAttachments,
      statusHistory,
    });
  })
);

router.get(
  "/:caseId/attachments",
  asyncHandler(async (req, res) => {
    const access = await assertCaseAccessWithMemberships(
      (req as any).auth.userId,
      req.params.caseId
    );
    const found = access.case;
    const attachments = await db.query.caseAttachments.findMany({
      where: eq(caseAttachments.caseId, found.id),
      orderBy: [desc(caseAttachments.createdAt)],
    });
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
    const isLabMember = !!access.labMembership;
    return ok(res, visibleAttachmentsFor(enriched, isLabMember));
  })
);

const updateAttachmentSchema = z.object({
  visibility: z.enum(ATTACHMENT_VISIBILITIES),
});

router.patch(
  "/:caseId/attachments/:attachmentId",
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
    const input = updateAttachmentSchema.parse(req.body);
    const attachment = await db.query.caseAttachments.findFirst({
      where: and(
        eq(caseAttachments.id, req.params.attachmentId),
        eq(caseAttachments.caseId, found.id)
      ),
    });
    if (!attachment) throw new HttpError(404, "Attachment not found.");
    if (attachment.visibility === input.visibility) {
      return ok(res, attachment);
    }
    const [updated] = await db
      .update(caseAttachments)
      .set({ visibility: input.visibility })
      .where(eq(caseAttachments.id, attachment.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "case_attachment_visibility_changed",
      entityType: "case_attachment",
      entityId: attachment.id,
      beforeJson: attachment,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

// Best-effort removal of the underlying file backing a case attachment.
// The DB row's `storageKey` is the public URL the file was uploaded to
// (e.g. https://host/uploads/case-media/<filename>). We only ever delete
// inside `uploads/case-media/` and resolve paths defensively so a crafted
// storageKey can't escape the media directory.
function removeAttachmentFile(
  req: any,
  storageKey: string | null | undefined
): void {
  if (!storageKey) return;
  try {
    const fileName = extractMediaFileName(storageKey);
    if (!fileName) return;
    const resolved = path.resolve(caseMediaDir, fileName);
    if (
      resolved !== caseMediaDir &&
      (resolved + path.sep).startsWith(caseMediaDir + path.sep)
    ) {
      fs.rmSync(resolved, { force: true });
    }
  } catch (err: any) {
    req.log?.warn?.(
      { err: err?.message || String(err), storageKey },
      "Failed to remove underlying attachment file"
    );
  }
}

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
      // Mobile case path: verify the caller is a member of the lab that owns
      // this lab_cases row, then surface a clear error. The caseAttachments
      // table has a FK to cases.id (not lab_cases.id), so we cannot store
      // attachments for mobile cases without a schema migration.
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
      throw new HttpError(
        422,
        "File attachments cannot be added to legacy mobile cases. Open this case on the mobile app to add files."
      );
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
          .default("shared_with_provider"),
      })
      .parse(req.body);

    const [attachment] = await db
      .insert(caseAttachments)
      .values({
        caseId: req.params.caseId,
        uploadedByUserId: (req as any).auth.userId,
        uploadedByOrganizationId: orgId,
        fileName: input.fileName,
        storageKey: input.storageKey,
        fileType: input.fileType,
        visibility: input.visibility,
      })
      .returning();

    const attachmentActor = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: req.params.caseId,
      eventType: "case_attachment_added",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: orgId,
      actorInitials: attachmentActor?.initials || "SYS",
      metadataJson: {
        attachmentId: attachment.id,
        fileName: attachment.fileName,
        fileType: attachment.fileType,
        visibility: attachment.visibility,
      },
    });

    await writeAuditLog({
      req,
      organizationId: orgId,
      action: "case_attachment_created",
      entityType: "case_attachment",
      entityId: attachment.id,
      afterJson: attachment,
    });

    return ok(res, attachment, 201);
  })
);

async function removeAttachmentFromOneDrive(
  req: any,
  storageKey: string | null | undefined
): Promise<void> {
  if (!storageKey) return;
  try {
    const fileName = extractMediaFileName(storageKey);
    if (!fileName) return;
    const result = await deleteFromOneDrive(fileName);
    if (result === "deleted" || result === "missing") {
      req.log?.info?.(
        { fileName, result },
        "Removed mirrored attachment from OneDrive"
      );
    }
  } catch (err: any) {
    req.log?.warn?.(
      { err: err?.message || String(err), storageKey },
      "Failed to remove mirrored attachment from OneDrive"
    );
  }
}

router.delete(
  "/:caseId/attachments/:attachmentId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const attachment = await db.query.caseAttachments.findFirst({
      where: and(
        eq(caseAttachments.id, req.params.attachmentId),
        eq(caseAttachments.caseId, found.id)
      ),
    });
    if (!attachment) throw new HttpError(404, "Attachment not found.");

    await db
      .delete(caseAttachments)
      .where(eq(caseAttachments.id, attachment.id));

    // Remove the file from disk after the DB row is gone. Failures are
    // logged but don't surface to the caller — the DB delete already
    // succeeded and a stray file is preferable to an inconsistent state.
    removeAttachmentFile(req, attachment.storageKey);

    // If a OneDrive backup mirror is configured, also remove the
    // mirrored copy. Same best-effort policy: log and continue on any
    // failure so the DB delete is never reverted.
    void removeAttachmentFromOneDrive(req, attachment.storageKey);

    const attachmentDeleter = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "case_attachment_deleted",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: attachmentDeleter?.initials || "SYS",
      metadataJson: {
        attachmentId: attachment.id,
        fileName: attachment.fileName,
        fileType: attachment.fileType,
      },
    });

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: "case_attachment_deleted",
      entityType: "case_attachment",
      entityId: attachment.id,
      beforeJson: attachment,
    });
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
  dueDate: z.string().optional(),
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
});

router.patch(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const input = updateCaseSchema.parse(req.body);

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

      if (mobileRow.organizationId) {
        await requireMembership(
          (req as any).auth.userId,
          mobileRow.organizationId
        );
      }

      if (input.status) {
        let parsed: any = {};
        try { parsed = JSON.parse(mobileRow.caseData); } catch { /* ignore */ }

        // Map desktop station back to mobile status token.
        const DESKTOP_TO_MOBILE_STATUS: Record<string, string> = {
          received: "INTAKE",
          in_design: "DESIGN",
          scan: "SCAN",
          in_milling: "MILLING",
          post_mill: "POST_MILL",
          sintering_furnace: "SINTERING_FURNACE",
          model_room: "MODEL_ROOM",
          in_porcelain: "PORCELAIN",
          qc: "QC",
          complete: "COMPLETE",
          shipped: "SHIP",
          delivered: "COMPLETE",
          on_hold: "HOLD",
          remake: "REMAKE",
        };
        parsed.status = DESKTOP_TO_MOBILE_STATUS[input.status] ?? input.status.toUpperCase();

        if (input.status === "complete") {
          parsed.assignedBarcode = null;
        }

        await db
          .update(labCases)
          .set({ caseData: JSON.stringify(parsed), updatedAt: new Date() })
          .where(eq(labCases.id, mobileRow.id));
      }

      return ok(res, {
        id: mobileRow.id,
        status: input.status,
        _source: "mobile",
      });
    }

    // Canonical cases table path.
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );

    const updates: any = {};
    if (input.status !== undefined) updates.status = input.status;
    // When locating to Complete, free the pan barcode atomically.
    if (input.status === "complete") updates.casePanBarcode = null;
    if (input.priority !== undefined) updates.priority = input.priority;
    if (input.dueDate !== undefined)
      updates.dueDate = new Date(input.dueDate);
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
    if (input.bridgeConnectors !== undefined)
      updates.bridgeConnectors = input.bridgeConnectors || null;
    if (input.expectedDeliveryDate !== undefined)
      updates.expectedDeliveryDate = input.expectedDeliveryDate
        ? new Date(input.expectedDeliveryDate)
        : null;
    if (input.clearDeliveryDateProposal) {
      updates.deliveryDateProposalDate = null;
      updates.deliveryDateProposalNote = null;
    }

    const [updated] = await db
      .update(cases)
      .set(updates)
      .where(eq(cases.id, found.id))
      .returning();

    if (input.status && input.status !== found.status) {
      const user = (req as any).user;
      await db.insert(caseEvents).values({
        caseId: found.id,
        eventType: "status_changed",
        actorUserId: (req as any).auth.userId,
        actorOrganizationId: found.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          fromStatus: found.status,
          toStatus: input.status,
        },
      });
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
      });
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

    // ── Bridge-connector change: re-price affected pontics ──
    // When the user draws (or redraws) bridge connectors on the tooth chart,
    // pontics that were previously $0.00 / UNKNOWN SOURCE get corrected to
    // the same material and tier as their adjacent abutment crowns.
    if (input.bridgeConnectors !== undefined) {
      const newBridgeConnectorStr = (updates.bridgeConnectors as string | null) ?? null;
      const allRestorations = await db.query.caseRestorations.findMany({
        where: eq(caseRestorations.caseId, found.id),
      });
      await _repricePonticsInSpans(
        {
          id: found.id,
          labOrganizationId: found.labOrganizationId,
          doctorName: found.doctorName,
          providerOrganizationId: found.providerOrganizationId,
        },
        allRestorations,
        newBridgeConnectorStr,
      );
      await syncInvoiceFromRestorations({
        caseId: found.id,
        actorUserId: (req as any).auth.userId,
      });
    }

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
        const dateStr = proposalDate
          ? proposalDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
          : null;
        const patientName = `${found.patientFirstName} ${found.patientLastName}`.trim();
        await db.insert(notifications).values(
          adminMembers.map((m) => ({
            userId: m.userId,
            type: "delivery_date_request",
            title: "Delivery Date Change Requested",
            body: dateStr
              ? `Provider requested ${dateStr} for ${patientName} (Case ${found.caseNumber})`
              : `Provider requested a delivery date change for ${patientName} (Case ${found.caseNumber})`,
            dataJson: { caseId: found.id, caseNumber: found.caseNumber },
          }))
        );
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
    await requireAnyRole(
      (req as any).auth.userId,
      found.labOrganizationId,
      ADMIN_ROLES
    );

    await softDeleteById({
      table: cases,
      id: found.id,
      actorUserId: (req as any).auth.userId,
      req,
      organizationId: found.labOrganizationId,
      entityType: "case",
      beforeJson: found,
    });
    return ok(res, { deleted: true });
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
          .default("shared_with_provider"),
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
      .returning();

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "note_added",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: authorOrgId,
      actorInitials: user?.initials || "SYS",
      metadataJson: { visibility: input.visibility, noteId: note.id },
    });

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
      .object({ method: z.enum(["email", "sms"]) })
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
      const { normalizePhoneE164 } = await import("../lib/account-link-sms.js");
      const phoneE164 = normalizePhoneE164(providerOrg.phone);
      if (!phoneE164) {
        throw new HttpError(
          422,
          "The provider organization's phone number is not a valid format.",
        );
      }
      const sid = process.env["TWILIO_ACCOUNT_SID"];
      const token = process.env["TWILIO_AUTH_TOKEN"];
      const from = process.env["TWILIO_PHONE_NUMBER"];
      if (!sid || !token || !from) {
        throw new HttpError(503, "SMS is not configured on this server.");
      }
      const truncated =
        note.noteText.length > 120
          ? note.noteText.slice(0, 117) + "…"
          : note.noteText;
      const body = `LabTrax case ${found.caseNumber}: ${truncated}`;
      const auth = Buffer.from(`${sid}:${token}`).toString("base64");
      const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
      const params = new URLSearchParams();
      params.append("To", phoneE164);
      params.append("From", from);
      params.append("Body", body);
      const resp = await globalThis.fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
      const smsData = (await resp.json()) as any;
      if (smsData?.error_code || smsData?.code) {
        throw new HttpError(
          502,
          `SMS failed: ${smsData.message ?? "Twilio error"}`,
        );
      }
    }

    return ok(res, { ok: true });
  })
);

router.post(
  "/:caseId/location-changes",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const input = z
      .object({
        locationCode: z.string().min(1),
        locationName: z.string().min(1),
        notes: z.string().optional(),
      })
      .parse(req.body);

    const [location] = await db
      .insert(caseLocations)
      .values({
        caseId: found.id,
        locationCode: input.locationCode,
        locationName: input.locationName,
        movedByUserId: (req as any).auth.userId,
        notes: input.notes ?? null,
      })
      .returning();

    const user = (req as any).user;
    await db.insert(caseEvents).values({
      caseId: found.id,
      eventType: "location_changed",
      actorUserId: (req as any).auth.userId,
      actorOrganizationId: found.labOrganizationId,
      actorInitials: user?.initials || "SYS",
      metadataJson: {
        locationCode: input.locationCode,
        locationName: input.locationName,
      },
    });

    return ok(res, location, 201);
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
      );

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
  const out = new Set<string>();
  if (!value) return out;
  for (const part of value.split(",")) {
    const [a, b] = part.trim().split("-").map((s) => s.trim());
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na > 0 && nb > 0) {
      out.add(na < nb ? `${na}-${nb}` : `${nb}-${na}`);
    }
  }
  return out;
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
    material: string | null;
    priceSource: string | null;
  }>,
  bridgeConnectorStr: string | null,
): Promise<void> {
  const connectors = _parseBridgeConnectorStr(bridgeConnectorStr);

  const pontics = restorations.filter(
    (r) => /pontic/i.test(r.restorationType) && r.priceSource !== "manual",
  );
  if (pontics.length === 0) return;

  for (const pontic of pontics) {
    const ponticTooth = Number(pontic.toothNumber.trim());
    if (!Number.isInteger(ponticTooth) || ponticTooth < 1 || ponticTooth > 32) continue;

    let abutmentMaterial: string | null = null;

    if (connectors.size > 0) {
      const span = _findBridgeSpan(ponticTooth, connectors);
      if (span.size > 1) {
        const abutment = restorations.find(
          (r) =>
            span.has(Number(r.toothNumber.trim())) &&
            !/pontic/i.test(r.restorationType) &&
            r.material,
        );
        abutmentMaterial = abutment?.material ?? null;
      }
    }

    if (!abutmentMaterial) {
      const sorted = restorations
        .filter((r) => !/pontic/i.test(r.restorationType) && r.material)
        .map((r) => ({
          r,
          dist: Math.abs(Number(r.toothNumber.trim()) - ponticTooth),
        }))
        .filter(({ dist }) => dist > 0 && dist <= 3)
        .sort((a, b) => a.dist - b.dist);
      abutmentMaterial = sorted[0]?.r.material ?? null;
    }

    if (!abutmentMaterial) continue;

    const matForPricing = pontic.material || abutmentMaterial;
    const repriced = await resolveServerPriceWithSource(
      {
        labOrganizationId: caseCtx.labOrganizationId,
        doctorName: caseCtx.doctorName,
        providerOrganizationId: caseCtx.providerOrganizationId,
      },
      matForPricing,
      pontic.restorationType,
    );

    if (repriced) {
      await db
        .update(caseRestorations)
        .set({
          material: pontic.material ?? abutmentMaterial,
          unitPrice: repriced.amount.toFixed(2),
          priceSource: repriced.source,
          priceSourceId: repriced.sourceId,
          priceSourceName: repriced.sourceName,
          priceKey: repriced.key,
        })
        .where(eq(caseRestorations.id, pontic.id));
    }
  }
}

router.post(
  "/:caseId/restorations",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
      (req as any).auth.userId,
      req.params.caseId
    );
    await requireMembership(
      (req as any).auth.userId,
      found.labOrganizationId
    );
    const input = z
      .object({
        toothNumber: z.string().min(1),
        restorationType: z.string().min(1),
        material: z.string().optional(),
        shade: z.string().optional(),
        notes: z.string().optional(),
        quantity: z.coerce.number().int().positive().default(1),
        unitPrice: z.coerce.number().min(0).default(0),
      })
      .parse(req.body);

    // ── Step 1: Infer pontic material from existing bridge-span abutments ──
    // When a pontic is added without a material, look at the case's existing
    // restorations that share the same bridge span and use the first non-pontic
    // abutment's material so the price resolves correctly.
    // When bridge connectors are not yet drawn, fall back to a ±3-tooth
    // adjacency search so pontics self-heal even before the connector data
    // exists on the case.
    let effectiveMaterial = input.material ?? null;
    const bridgeConnectorStr = (found as any).bridgeConnectors as string | null ?? null;
    if (/pontic/i.test(input.restorationType) && !effectiveMaterial) {
      const ponticTooth = Number(input.toothNumber.trim());
      if (Number.isInteger(ponticTooth) && ponticTooth >= 1 && ponticTooth <= 32) {
        const existingRestorations = await db.query.caseRestorations.findMany({
          where: eq(caseRestorations.caseId, found.id),
        });

        if (bridgeConnectorStr) {
          // Path A: bridge connector span lookup.
          const connectors = _parseBridgeConnectorStr(bridgeConnectorStr);
          const span = _findBridgeSpan(ponticTooth, connectors);
          if (span.size > 1) {
            const abutment = existingRestorations.find((r) => {
              const rTooth = Number(r.toothNumber.trim());
              return span.has(rTooth) && !/pontic/i.test(r.restorationType) && r.material;
            });
            if (abutment?.material) effectiveMaterial = abutment.material;
          }
        }

        // Path B: adjacency fallback (±3 teeth) — runs when bridge connectors
        // are absent or the span lookup found no abutment with a material.
        if (!effectiveMaterial) {
          const candidates = existingRestorations
            .filter((r) => !/pontic/i.test(r.restorationType) && r.material)
            .map((r) => ({
              r,
              dist: Math.abs(Number(r.toothNumber.trim()) - ponticTooth),
            }))
            .filter(({ dist }) => dist > 0 && dist <= 3)
            .sort((a, b) => a.dist - b.dist);
          if (candidates[0]?.r.material) effectiveMaterial = candidates[0].r.material;
        }
      }
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
        input.restorationType
      );
      if (fallback) {
        unit = fallback.amount;
        priceSource = fallback.source;
        priceSourceId = fallback.sourceId;
        priceSourceName = fallback.sourceName;
        priceKey = fallback.key;
      }
    }

    const [restoration] = await db
      .insert(caseRestorations)
      .values({
        caseId: found.id,
        toothNumber: input.toothNumber,
        restorationType: input.restorationType,
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
      .returning();

    const restorationActor = (req as any).user;
    await db.insert(caseEvents).values({
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
    });

    // ── Step 2: Re-price existing pontics adjacent to the newly inserted
    // restoration.  Uses `_repricePonticsInSpans`, which tries bridge-connector
    // span membership first and falls back to a ±3-tooth adjacency search.
    // This corrects pontics that were added before their abutment existed, and
    // also handles the case where bridge connectors haven't been drawn yet.
    {
      const allOtherRestorations = await db.query.caseRestorations.findMany({
        where: and(
          eq(caseRestorations.caseId, found.id),
          ne(caseRestorations.id, restoration.id),
        ),
      });
      // Include the newly inserted restoration so the helper can use it as
      // the authoritative abutment material source.
      await _repricePonticsInSpans(
        {
          id: found.id,
          labOrganizationId: found.labOrganizationId,
          doctorName: found.doctorName,
          providerOrganizationId: found.providerOrganizationId,
        },
        [...allOtherRestorations, restoration],
        bridgeConnectorStr,
      );
    }

    // Keep the case's invoice in sync with the restoration set so the
    // user doesn't have to also open the Invoice tab and regenerate by
    // hand — adding a Night Guard line should immediately appear on
    // the invoice with the right unit price + total.
    await syncInvoiceFromRestorations({
      caseId: found.id,
      actorUserId: (req as any).auth.userId,
    });

    return ok(res, restoration, 201);
  })
);

router.delete(
  "/:caseId/restorations/:restorationId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
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
    await db
      .delete(caseRestorations)
      .where(eq(caseRestorations.id, restoration.id));
    const restorationDeleter = (req as any).user;
    await db.insert(caseEvents).values({
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

    return ok(res, { deleted: true });
  })
);

router.patch(
  "/:caseId/restorations/:restorationId",
  asyncHandler(async (req, res) => {
    const found = await assertCaseAccess(
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
        material: z.string().optional(),
        shade: z.string().optional(),
        notes: z.string().optional(),
        quantity: z.coerce.number().int().positive().optional(),
        unitPrice: z.coerce.number().min(0).optional(),
      })
      .parse(req.body);

    const patchFields: any = {};
    if (input.toothNumber !== undefined) patchFields.toothNumber = input.toothNumber;
    if (input.material !== undefined) patchFields.material = input.material || null;
    if (input.shade !== undefined) patchFields.shade = input.shade || null;
    if (input.notes !== undefined) patchFields.notes = input.notes || null;
    if (input.quantity !== undefined) patchFields.quantity = input.quantity;
    if (input.unitPrice !== undefined) {
      patchFields.unitPrice = input.unitPrice.toFixed(2);
      patchFields.priceSource = "manual";
      patchFields.priceSourceId = null;
      patchFields.priceSourceName = null;
    }

    if (Object.keys(patchFields).length === 0) {
      return ok(res, restoration);
    }

    const [updated] = await db
      .update(caseRestorations)
      .set(patchFields)
      .where(eq(caseRestorations.id, restoration.id))
      .returning();

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
    });

    await syncInvoiceFromRestorations({
      caseId: found.id,
      actorUserId: (req as any).auth.userId,
    });

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
        payloadJson: z.record(z.any()),
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
    });

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
      });
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
    });

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
    });

    return ok(res, rejected);
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// iTero Lab-Review auto-import
// ─────────────────────────────────────────────────────────────────────────────

const iteroImportUpload = multer({
  storage: multer.diskStorage({
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
  }),
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
  "material": "one of: Zirconia, PFM, E.max, Lithium Disilicate, Full Cast, Composite, Acrylic, Resin, Valplast, Flexible, Metal, PMMA, Other",
  "shade": "shade value like A2 or BL2",
  "teeth": "see rules below — comma-separated Universal numbers (e.g. \\"29,30,31\\") OR an arch token for full-arch removables (\\"Upper\\", \\"Lower\\", \\"U/D\\", \\"U/P\\", \\"L/D\\", \\"L/P\\")",
  "dueDate": "YYYY-MM-DD or null",
  "isRush": false,
  "notes": "free-text special instructions",
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
- The "Treatment Information" table is the authoritative source for teeth, treatment type, and material. Read every row. The "Tooth No." column gives the Universal tooth number. The "Treatment" column (Crown, Bridge, Veneer, Inlay, Onlay, etc.) determines caseType. The "Material" column gives the material — strip the "Ceramic:" prefix if present (e.g. "Ceramic: Zirconia" → "Zirconia", "Ceramic: E.max" → "E.max", "Ceramic: Lithium Disilicate" → "Lithium Disilicate").
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

interface ExtractedRxFields {
  doctorName?: string | null;
  patientFirstName?: string | null;
  patientLastName?: string | null;
  caseType?: string | null;
  material?: string | null;
  shade?: string | null;
  teeth?: string | null;
  dueDate?: string | null;
  isRush?: boolean | null;
  notes?: string | null;
  practiceName?: string | null;
  restorations?: Array<{
    teeth: string;
    material: string | null;
    type: string;
    isBridge: boolean;
  }> | null;
}

async function extractRxFieldsFromBuffer(
  openai: OpenAI,
  buf: Buffer,
  mimeType: string,
  originalName: string
): Promise<ExtractedRxFields> {
  const isPdf =
    mimeType.toLowerCase().includes("pdf") ||
    originalName.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    // Use the Responses API with file input for native PDF understanding.
    const uploaded = await openai.files.create({
      file: await toFile(buf, originalName || "rx.pdf", {
        type: "application/pdf",
      }),
      purpose: "user_data",
    });
    try {
      const r = await openai.responses.create({
        model: "gpt-5.1",
        input: [
          {
            role: "user",
            content: [
              { type: "input_file", file_id: uploaded.id },
              { type: "input_text", text: ITERO_RX_SYSTEM_PROMPT },
            ],
          },
        ],
      });
      const text = r.output_text || "";
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return {};
      try {
        return JSON.parse(m[0]) as ExtractedRxFields;
      } catch {
        return {};
      }
    } finally {
      try {
        await openai.files.delete(uploaded.id);
      } catch {
        /* ignore */
      }
    }
  }

  // Image path — use chat.completions vision (matches existing pattern).
  const dataUrl = `data:${mimeType || "image/jpeg"};base64,${buf.toString("base64")}`;
  const resp = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: ITERO_RX_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this iTero Lab-Review prescription." },
          {
            type: "image_url",
            image_url: { url: dataUrl, detail: "auto" },
          },
        ],
      },
    ],
    max_completion_tokens: 1200,
  });
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
  iteroOrderId: z.string().min(1, "iteroOrderId is required"),
  labOrganizationId: z.string().min(1, "labOrganizationId is required"),
  providerOrganizationId: z
    .string()
    .min(1, "providerOrganizationId is required"),
  // Optional client hints — used as fallbacks when AI fails to extract them.
  doctorNameHint: z.string().optional(),
  patientFirstNameHint: z.string().optional(),
  patientLastNameHint: z.string().optional(),
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
  doctorNameHint: z.string().optional(),
  patientFirstNameHint: z.string().optional(),
  patientLastNameHint: z.string().optional(),
  toothIndicesHint: z.string().optional(),
  shadeHint: z.string().optional(),
  materialHint: z.string().optional(),
  caseTypeHint: z.string().optional(),
  dueDateHint: z.string().optional(),
  notesHint: z.string().optional(),
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
    const batchId = randomBytes(8).toString("hex");

    if (!req.file) {
      throw new HttpError(400, "Rx file is required (field name 'file').");
    }

    // Lab membership is required to create cases for this organization.
    await requireMembership(userId, body.labOrganizationId);

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
    // create a stub case marked needsAiReview=true so the user can fix it).
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

    const patientFirstName =
      (extracted.patientFirstName?.trim() || body.patientFirstNameHint?.trim() ||
        "Unknown");
    const patientLastName =
      (extracted.patientLastName?.trim() || body.patientLastNameHint?.trim() ||
        "Patient");
    const doctorName =
      (extracted.doctorName?.trim() || body.doctorNameHint?.trim() ||
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

    let dueDate: Date | null = null;
    if (extracted.dueDate) {
      const parsed = new Date(extracted.dueDate);
      if (!Number.isNaN(parsed.getTime())) dueDate = parsed;
    }

    const caseNumber = await generateIteroCaseNumber(body.labOrganizationId);

    // Resolve any AI-derived restoration rows BEFORE the transaction so the
    // pricing lookups don't hold open the dedup-claim transaction.
    const teethList = (extracted.teeth || "")
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    let prebuiltRestorations: Array<{
      toothNumber: string;
      restorationType: string;
      material: string | null;
      shade: string | null;
      unitPrice: string;
      priceSource: string | null;
      priceSourceId: string | null;
      priceSourceName: string | null;
      priceKey: string | null;
    }> = [];
    // Bucket the AI-extracted caseType into one of the four restorative
    // categories the Overview Rx summary recognizes (Crown & Bridge /
    // Removable / Appliance / Other). This guards against the model
    // returning legacy granular values like "Crown" or "Full Denture".
    const normalizedCaseType = extracted.caseType
      ? normalizeIteroCaseType(extracted.caseType)
      : null;
    if (normalizedCaseType) {
      extracted.caseType = normalizedCaseType;
    }
    if (teethList.length > 0 && normalizedCaseType) {
      prebuiltRestorations = await Promise.all(
        teethList.map(async (toothNumber) => {
          const fallback = await resolveServerPriceWithSource(
            {
              labOrganizationId: body.labOrganizationId,
              doctorName,
              providerOrganizationId: body.providerOrganizationId,
            },
            extracted.material ?? null,
            normalizedCaseType
          );
          return {
            toothNumber,
            restorationType: normalizedCaseType,
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

    const user = (req as any).user;
    const storageKey = buildIteroAttachmentUrl(req, req.file.filename);

    // Atomic write: dedup claim + case + restorations + notes + attachment +
    // back-fill + event all happen in one transaction. If ANY step fails,
    // Postgres rolls back the dedup-claim row too, freeing the iTero order
    // for retry on the next poll cycle. The only success path commits the
    // claim with createdCaseId set, so future requests see the existing case.
    const txResult = await db.transaction(async (tx) => {
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
            columns: { id: true },
          });
          if (liveCase) {
            await tx
              .update(iteroImportedOrders)
              .set({ lastSeenAt: new Date() })
              .where(eq(iteroImportedOrders.id, existing.id));
            return { kind: "deduped" as const, existing };
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
          providerOrganizationId: effectiveProviderOrgId,
          patientFirstName,
          patientLastName,
          doctorName,
          status: "received",
          priority: extracted.isRush ? "rush" : "normal",
          dueDate,
          expectedDeliveryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          createdByUserId: userId,
          needsAiReview: true,
          aiImportSource: "itero",
          externalPatientId: body.iteroOrderId,
          suggestedDoctorName,
          // When the per-lab "auto-link suggested practice" setting fired,
          // the suggestion has been applied — null it out so the review
          // banner doesn't re-prompt the reviewer with a now-stale choice.
          suggestedProviderOrgId: autoLinkedFromAi ? null : suggestedProviderOrgId,
        })
        .returning();

      if (prebuiltRestorations.length > 0) {
        await tx.insert(caseRestorations).values(
          prebuiltRestorations.map((r) => ({
            caseId: createdCase.id,
            toothNumber: r.toothNumber,
            restorationType: r.restorationType,
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
      }

      if (extracted.notes && extracted.notes.trim()) {
        await tx.insert(caseNotes).values({
          caseId: createdCase.id,
          authorUserId: userId,
          authorOrganizationId: body.labOrganizationId,
          noteText: `[iTero AI import] ${extracted.notes.trim()}`,
          visibility: "internal_lab_only",
        });
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
          visibility: "shared_with_provider",
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

      // ── Auto-create draft invoice from the AI-extracted restorations ──
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
          : fallbackPriced
            ? "Some line items use default/fallback pricing — please verify before sending."
            : null;

        const [autoInvoice] = await tx
          .insert(invoices)
          .values({
            invoiceNumber: `INV-${createdCase.caseNumber}`,
            caseId: createdCase.id,
            labOrganizationId: createdCase.labOrganizationId,
            providerOrganizationId: createdCase.providerOrganizationId,
            status: "draft",
            displayMetadataJson,
            aiGenerated: true,
            aiPricingWarning,
            createdByUserId: userId,
            updatedByUserId: userId,
          })
          .onConflictDoNothing()
          .returning();

        if (autoInvoice) {
          // Batch-fetch all custom labels for this lab in one query so
          // the per-restoration label resolution below is zero DB calls.
          const iteroLabelCache = hasRestorations
            ? await fetchLabItemLabels(createdCase.labOrganizationId)
            : ({} as Record<string, string>);
          const itemsToInsert = hasRestorations
            ? buildGroupedLineItemsForInvoice(
                restorationRowsForInvoice as any[],
                iteroLabelCache,
                autoInvoice.id,
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
          await tx.insert(invoiceLineItems).values(itemsToInsert);
          const subtotal = itemsToInsert
            .reduce((acc, it) => acc + Number(it.lineTotal), 0)
            .toFixed(2);
          await tx
            .update(invoices)
            .set({
              subtotal,
              total: subtotal,
              balanceDue: subtotal,
            })
            .where(eq(invoices.id, autoInvoice.id));
          autoInvoiceId = autoInvoice.id;
        }
      } catch (autoErr) {
        // Don't block case creation on a draft-invoice problem; the user
        // can still mint an invoice manually from the case drawer.
        req.log?.warn(
          { err: autoErr, caseId: createdCase.id },
          "iTero auto-invoice creation failed",
        );
      }

      return { kind: "created" as const, createdCase, attachment, autoInvoiceId };
    });

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
          iteroOrderId: existing.iteroOrderId,
        });
      }
      // The order is being concurrently imported by another request that
      // hasn't committed yet — surface a 409 so the poller retries on the
      // next cycle. We never return deduped:true with a null caseId.
      throw new HttpError(409, "iTero order is already being imported; retry shortly.");
    }

    const { createdCase, attachment } = txResult;

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
          doctorName === "Unknown Doctor" || !extracted.doctorName?.trim();

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
          notifBody = `Case ${createdCase.caseNumber} for ${patientFirstName} ${patientLastName} was auto-imported from iTero and needs your review.`;
        }

        await db.insert(notifications).values(
          adminMembers.map((m) => ({
            userId: m.userId,
            type: notifType,
            title: notifTitle,
            body: notifBody,
            dataJson: {
              caseId: createdCase.id,
              caseNumber: createdCase.caseNumber,
              iteroOrderId: body.iteroOrderId,
              labOrganizationId: body.labOrganizationId,
              alertReason: isUnknownDoctor
                ? "unknown_doctor"
                : isUnknownPractice
                  ? "unknown_practice"
                  : isStandInDoctor
                    ? "stand_in_doctor"
                    : null,
            },
          }))
        );
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
        needsAiReview: true,
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
        if (!entryName) continue;
        // Only keep .ply scan files — all other entries are discarded.
        const ext = path.extname(entryName).toLowerCase();
        if (ext !== ".ply") continue;
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
        await db
          .update(iteroImportedOrders)
          .set({ lastSeenAt: new Date() })
          .where(eq(iteroImportedOrders.id, preExisting.id));
        return ok(res, {
          deduped: true,
          caseId: preExisting.createdCaseId,
          iteroOrderId: preExisting.iteroOrderId,
          extraFilesAttached: 0,
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
    await fs.promises.writeFile(rxDiskPath, rxBuffer);
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

    let dueDate: Date | null = null;
    if (extracted.dueDate) {
      const parsed = new Date(extracted.dueDate);
      if (!Number.isNaN(parsed.getTime())) dueDate = parsed;
    }
    if (!dueDate && body.dueDateHint) {
      // Parse MM/DD/YYYY (from client AI) or ISO formats.
      const hint = body.dueDateHint.trim();
      const mmddyyyy = hint.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      const parsedHint = mmddyyyy
        ? new Date(`${mmddyyyy[3]}-${mmddyyyy[1]!.padStart(2, "0")}-${mmddyyyy[2]!.padStart(2, "0")}`)
        : new Date(hint);
      if (!Number.isNaN(parsedHint.getTime())) dueDate = parsedHint;
    }

    const caseNumber = await generateIteroCaseNumber(body.labOrganizationId);

    const normalizedCaseType = extracted.caseType
      ? normalizeIteroCaseType(extracted.caseType)
      : (body.caseTypeHint ? normalizeIteroCaseType(body.caseTypeHint) : null);
    if (normalizedCaseType) {
      extracted.caseType = normalizedCaseType;
    }
    // Fall back to hint values when AI didn't extract them.
    if (!extracted.shade && body.shadeHint) extracted.shade = body.shadeHint;
    if (!extracted.material && body.materialHint) extracted.material = body.materialHint;

    const teethStr = extracted.teeth?.trim() || body.toothIndicesHint?.trim() || "";
    const teethList = teethStr
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    let prebuiltRestorations: Array<{
      toothNumber: string;
      restorationType: string;
      material: string | null;
      shade: string | null;
      unitPrice: string;
      priceSource: string | null;
      priceSourceId: string | null;
      priceSourceName: string | null;
      priceKey: string | null;
    }> = [];
    if (teethList.length > 0 && normalizedCaseType) {
      prebuiltRestorations = await Promise.all(
        teethList.map(async (toothNumber) => {
          const fallback = await resolveServerPriceWithSource(
            {
              labOrganizationId: body.labOrganizationId,
              doctorName,
              providerOrganizationId: body.providerOrganizationId,
            },
            extracted.material ?? null,
            normalizedCaseType
          );
          return {
            toothNumber,
            restorationType: normalizedCaseType,
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
            columns: { id: true },
          });
          if (liveCase) {
            await tx
              .update(iteroImportedOrders)
              .set({ lastSeenAt: new Date() })
              .where(eq(iteroImportedOrders.id, existing.id));
            return { kind: "deduped" as const, existing };
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
          doctorName,
          status: "received",
          priority: extracted.isRush ? "rush" : "normal",
          dueDate,
          expectedDeliveryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          createdByUserId: userId,
          needsAiReview: true,
          aiImportSource: "itero",
          externalPatientId: iteroOrderId,
          ...({ suggestedDoctorName, suggestedProviderOrgId } as any),
        })
        .returning();

      if (prebuiltRestorations.length > 0) {
        await tx.insert(caseRestorations).values(
          prebuiltRestorations.map((r) => ({
            caseId: createdCase.id,
            toothNumber: r.toothNumber,
            restorationType: r.restorationType,
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
      }

      const zipNoteText = (extracted.notes?.trim() || body.notesHint?.trim()) ?? null;
      if (zipNoteText) {
        await tx.insert(caseNotes).values({
          caseId: createdCase.id,
          authorUserId: userId,
          authorOrganizationId: body.labOrganizationId,
          noteText: `[iTero AI import] ${zipNoteText}`,
          visibility: "internal_lab_only",
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
          visibility: "shared_with_provider",
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

      // ── Auto-create draft invoice ──────────────────────────────────────────
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
          : fallbackPriced
            ? "Some line items use default/fallback pricing — please verify before sending."
            : null;

        const [autoInvoice] = await tx
          .insert(invoices)
          .values({
            invoiceNumber: `INV-${createdCase.caseNumber}`,
            caseId: createdCase.id,
            labOrganizationId: createdCase.labOrganizationId,
            providerOrganizationId: createdCase.providerOrganizationId,
            status: "draft",
            displayMetadataJson,
            aiGenerated: true,
            aiPricingWarning,
            createdByUserId: userId,
            updatedByUserId: userId,
          })
          .onConflictDoNothing()
          .returning();

        if (autoInvoice) {
          const labelCache = hasRestorations
            ? await fetchLabItemLabels(createdCase.labOrganizationId)
            : ({} as Record<string, string>);
          const itemsToInsert = hasRestorations
            ? buildGroupedLineItemsForInvoice(
                restorationRowsForInvoice as any[],
                labelCache,
                autoInvoice.id,
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
          await tx.insert(invoiceLineItems).values(itemsToInsert);
          const subtotal = itemsToInsert
            .reduce((acc, it) => acc + Number(it.lineTotal), 0)
            .toFixed(2);
          await tx
            .update(invoices)
            .set({ subtotal, total: subtotal, balanceDue: subtotal })
            .where(eq(invoices.id, autoInvoice.id));
          autoInvoiceId = autoInvoice.id;
        }
      } catch (invoiceErr) {
        req.log?.warn(
          { err: invoiceErr, caseId: createdCase.id },
          "iTero ZIP auto-invoice creation failed"
        );
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

    // ── Attach remaining ZIP files (best-effort, outside transaction) ────────
    let extraFilesAttached = 0;
    let extraFilesFailed = 0;
    for (const entry of otherEntries) {
      try {
        const ext = path.extname(entry.name) || "";
        const safe = path
          .basename(entry.name, ext)
          .replace(/[^a-zA-Z0-9\-_]+/g, "-")
          .slice(0, 60) || "file";
        const diskName = `${Date.now()}-${randomBytes(4).toString("hex")}-${safe}${ext}`;
        const diskPath = path.join(caseMediaDir, diskName);
        await fs.promises.writeFile(diskPath, entry.data);
        // Mirror to persistent object storage (best-effort).
        writeCaseMediaToObjectStorage(diskName, entry.data, entry.mimeType).catch(
          (err: unknown) => {
            req.log?.warn({ err, name: entry.name }, "iTero ZIP: failed to mirror attachment to object storage");
          },
        );
        const storageKey = buildIteroAttachmentUrl(req, diskName);
        await db.insert(caseAttachments).values({
          caseId: createdCase.id,
          uploadedByUserId: userId,
          uploadedByOrganizationId: body.labOrganizationId,
          fileName: entry.name,
          storageKey,
          fileType: entry.mimeType,
          visibility: "shared_with_provider",
        });
        extraFilesAttached++;
      } catch (attachErr) {
        extraFilesFailed++;
        req.log?.warn(
          { err: attachErr, name: entry.name, caseId: createdCase.id },
          "iTero ZIP: failed to save extra attachment"
        );
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
          doctorName === "Unknown Doctor" || !extracted.doctorName?.trim();
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
          notifBody = `Case ${createdCase.caseNumber} for ${patientFirstName} ${patientLastName} was imported from an iTero ZIP and needs your review. ${extraFilesAttached} additional file(s) were attached.`;
        }

        await db.insert(notifications).values(
          adminMembers.map((m) => ({
            userId: m.userId,
            type: notifType,
            title: notifTitle,
            body: notifBody,
            dataJson: {
              caseId: createdCase.id,
              caseNumber: createdCase.caseNumber,
              iteroOrderId,
              labOrganizationId: body.labOrganizationId,
              extraFilesAttached,
            },
          }))
        );
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
        needsAiReview: true,
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
}

async function processOneIteroZipFile(
  req: Request,
  file: Express.Multer.File,
  body: { labOrganizationId: string; providerOrganizationId: string; doctorNameHint?: string; patientFirstNameHint?: string; patientLastNameHint?: string },
  userId: string,
  user: any,
  batchId?: string,
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
      if (!entryName) continue;
      const ext = path.extname(entryName).toLowerCase();
      if (ext !== ".ply") continue;
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
    await db.update(iteroImportedOrders).set({ lastSeenAt: new Date() }).where(eq(iteroImportedOrders.id, preExisting.id));
    return { caseId: preExisting.createdCaseId, caseNumber: preExisting.iteroOrderId, deduped: true, iteroOrderId: preExisting.iteroOrderId, extraFilesAttached: 0, extraFilesFailed: 0, aiDoctorName: null, suggestedProviderOrgId: null, suggestedDoctorName: null, linkedProviderOrgId: null };
  }

  // Save Rx file to disk
  try { fs.mkdirSync(caseMediaDir, { recursive: true }); } catch { /* ignore */ }
  const rxExt = path.extname(rxOriginalName).toLowerCase() || ".pdf";
  const rxSafe = path.basename(rxOriginalName, rxExt).replace(/[^a-zA-Z0-9\-_]+/g, "-").slice(0, 60) || "rx";
  const rxDiskName = `${Date.now()}-${randomBytes(4).toString("hex")}-${rxSafe}${rxExt}`;
  const rxDiskPath = path.join(caseMediaDir, rxDiskName);
  await fs.promises.writeFile(rxDiskPath, rxBuffer);
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

  let dueDate: Date | null = null;
  if (extracted.dueDate) {
    const parsed = new Date(extracted.dueDate);
    if (!Number.isNaN(parsed.getTime())) dueDate = parsed;
  }

  const caseNumber = await generateIteroCaseNumber(body.labOrganizationId);
  const normalizedCaseType = extracted.caseType ? normalizeIteroCaseType(extracted.caseType) : null;
  if (normalizedCaseType) extracted.caseType = normalizedCaseType;

  const teethList = (extracted.teeth || "").split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  let prebuiltRestorations: Array<{
    toothNumber: string; restorationType: string; material: string | null; shade: string | null;
    unitPrice: string; priceSource: string | null; priceSourceId: string | null; priceSourceName: string | null; priceKey: string | null;
  }> = [];
  if (teethList.length > 0 && normalizedCaseType) {
    prebuiltRestorations = await Promise.all(teethList.map(async (toothNumber) => {
      const fallback = await resolveServerPriceWithSource(
        { labOrganizationId: body.labOrganizationId, doctorName, providerOrganizationId: body.providerOrganizationId },
        extracted.material ?? null, normalizedCaseType,
      );
      return {
        toothNumber, restorationType: normalizedCaseType, material: extracted.material ?? null, shade: normalizeIteroShade(extracted.shade),
        unitPrice: (fallback?.amount ?? 0).toFixed(2), priceSource: fallback?.source ?? null,
        priceSourceId: fallback?.sourceId ?? null, priceSourceName: fallback?.sourceName ?? null, priceKey: fallback?.key ?? null,
      };
    }));
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
          columns: { id: true },
        });
        if (liveCase) {
          await tx.update(iteroImportedOrders).set({ lastSeenAt: new Date() }).where(eq(iteroImportedOrders.id, existing.id));
          return { kind: "deduped" as const, existing };
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
      patientFirstName, patientLastName, doctorName,
      status: "received",
      priority: extracted.isRush ? "rush" : "normal",
      dueDate, expectedDeliveryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdByUserId: userId, needsAiReview: true, aiImportSource: "itero",
      externalPatientId: iteroOrderId,
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
        material: r.material, shade: r.shade, notes: null, quantity: 1,
        unitPrice: r.unitPrice, priceSource: r.priceSource, priceSourceId: r.priceSourceId,
        priceSourceName: r.priceSourceName, priceKey: r.priceKey,
      })));
    }

    if (extracted.notes && extracted.notes.trim()) {
      await tx.insert(caseNotes).values({
        caseId: createdCase.id, authorUserId: userId, authorOrganizationId: body.labOrganizationId,
        noteText: `[iTero AI import] ${extracted.notes.trim()}`, visibility: "internal_lab_only",
      });
    }

    const [attachment] = await tx.insert(caseAttachments).values({
      caseId: createdCase.id, uploadedByUserId: userId, uploadedByOrganizationId: body.labOrganizationId,
      fileName: rxOriginalName, storageKey: rxStorageKey, fileType: rxMimeType, visibility: "shared_with_provider",
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

    // Auto-create draft invoice
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
        : fallbackPriced ? "Some line items use default/fallback pricing — please verify before sending." : null;

      const [autoInvoice] = await tx.insert(invoices).values({
        invoiceNumber: `INV-${createdCase.caseNumber}`, caseId: createdCase.id,
        labOrganizationId: createdCase.labOrganizationId, providerOrganizationId: createdCase.providerOrganizationId,
        status: "draft", displayMetadataJson, aiGenerated: true, aiPricingWarning,
        createdByUserId: userId, updatedByUserId: userId,
      }).onConflictDoNothing().returning();

      if (autoInvoice) {
        const labelCache = hasRestorations
          ? await fetchLabItemLabels(createdCase.labOrganizationId)
          : ({} as Record<string, string>);
        const itemsToInsert = hasRestorations
          ? buildGroupedLineItemsForInvoice(
              restorationRowsForInvoice as any[],
              labelCache,
              autoInvoice.id,
              extracted.restorations,
            )
          : [{ invoiceId: autoInvoice.id, caseRestorationId: null, toothNumber: null, toothLabel: null, description: "[AI placeholder] Restorations could not be extracted — replace with actual line items.", quantity: 1, unitPrice: "0.00", lineTotal: "0.00", sortOrder: 0 }];
        await tx.insert(invoiceLineItems).values(itemsToInsert);
        const subtotal = itemsToInsert.reduce((acc, it) => acc + Number(it.lineTotal), 0).toFixed(2);
        await tx.update(invoices).set({ subtotal, total: subtotal, balanceDue: subtotal }).where(eq(invoices.id, autoInvoice.id));
        autoInvoiceId = autoInvoice.id;
      }
    } catch (invoiceErr) {
      req.log?.warn({ err: invoiceErr, caseId: createdCase.id }, "iTero ZIP batch: auto-invoice creation failed");
    }

    return { kind: "created" as const, createdCase, attachment, autoInvoiceId };
  });

  if (txResult.kind === "deduped") {
    try { fs.unlinkSync(rxDiskPath); } catch { /* ignore */ }
    const existing = txResult.existing;
    if (existing && existing.createdCaseId) {
      return { caseId: existing.createdCaseId, caseNumber: existing.iteroOrderId, deduped: true, iteroOrderId: existing.iteroOrderId, extraFilesAttached: 0, extraFilesFailed: 0, aiDoctorName: null, suggestedProviderOrgId: null, suggestedDoctorName: null, linkedProviderOrgId: null };
    }
    throw new HttpError(409, "iTero order is already being imported; retry shortly.");
  }

  const { createdCase, attachment } = txResult;

  // Attach .ply files outside transaction (best-effort)
  let extraFilesAttached = 0;
  let extraFilesFailed = 0;
  for (const entry of otherEntries) {
    try {
      const ext = path.extname(entry.name) || "";
      const safe = path.basename(entry.name, ext).replace(/[^a-zA-Z0-9\-_]+/g, "-").slice(0, 60) || "file";
      const diskName = `${Date.now()}-${randomBytes(4).toString("hex")}-${safe}${ext}`;
      const diskPath = path.join(caseMediaDir, diskName);
      await fs.promises.writeFile(diskPath, entry.data);
      writeCaseMediaToObjectStorage(diskName, entry.data, entry.mimeType).catch((err: unknown) => {
        req.log?.warn({ err, name: entry.name }, "iTero ZIP batch: failed to mirror .ply to object storage");
      });
      const storageKey = buildIteroAttachmentUrl(req, diskName);
      await db.insert(caseAttachments).values({
        caseId: createdCase.id, uploadedByUserId: userId, uploadedByOrganizationId: body.labOrganizationId,
        fileName: entry.name, storageKey, fileType: entry.mimeType, visibility: "shared_with_provider",
      });
      extraFilesAttached++;
    } catch (attachErr) {
      extraFilesFailed++;
      req.log?.warn({ err: attachErr, name: entry.name, caseId: createdCase.id }, "iTero ZIP batch: failed to save .ply attachment");
    }
  }

  // Audit log
  await writeAuditLog({
    req, organizationId: body.labOrganizationId, action: "case_created_from_itero",
    entityType: "case", entityId: createdCase.id,
    afterJson: { case: createdCase, iteroOrderId, attachmentId: attachment?.id, extraFilesAttached, source: "zip_batch" },
  });

  return {
    caseId: createdCase.id,
    caseNumber: createdCase.caseNumber,
    deduped: false,
    iteroOrderId,
    extraFilesAttached,
    extraFilesFailed,
    aiDoctorName: doctorName !== "Unknown Doctor" ? doctorName : null,
    suggestedProviderOrgId,
    suggestedDoctorName,
    linkedProviderOrgId: body.providerOrganizationId || null,
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

// Clear the "needs AI review" flag once a human has verified the imported case.
// Optionally accepts a `remake` payload so the reviewer can link this case as
// a remake of an earlier one in the same step. Linking writes events on both
// cases and (for no-charge remakes) zeros out any existing draft invoice.
const aiReviewBodySchema = z.object({
  acknowledged: z.boolean().default(true),
  remake: z
    .object({
      remakeOfCaseId: z.string().min(1),
      remakeReason: z.string().min(1).max(2000),
      remakeCharged: z.boolean(),
    })
    .optional(),
});

router.patch(
  "/:caseId/ai-review",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).auth.userId as string;
    const found = await assertCaseAccess(userId, String(req.params.caseId ?? ""));
    await requireMembership(userId, found.labOrganizationId);

    const input = aiReviewBodySchema.parse(req.body ?? {});

    if (!input.acknowledged && !input.remake) {
      return ok(res, { caseId: found.id, needsAiReview: found.needsAiReview ?? false });
    }

    const user = (req as any).user;

    // Optional remake link. The original may be either canonical or
    // legacy — same as POST /cases.
    let remakeOriginal: Awaited<ReturnType<typeof resolveRemakeOriginal>> = null;
    if (input.remake) {
      if (input.remake.remakeOfCaseId === found.id) {
        throw new HttpError(400, "A case cannot be a remake of itself.");
      }
      remakeOriginal = await resolveRemakeOriginal(
        input.remake.remakeOfCaseId,
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
    }

    const setFields: Record<string, unknown> = {};
    if (input.acknowledged) setFields.needsAiReview = false;
    if (remakeOriginal) {
      setFields.remakeOfCaseId = remakeOriginal.id;
      setFields.remakeReason = input.remake?.remakeReason ?? null;
      setFields.remakeCharged = input.remake?.remakeCharged ?? null;
    }

    const [updated] = await db
      .update(cases)
      .set(setFields)
      .where(eq(cases.id, found.id))
      .returning();

    if (input.acknowledged) {
      await db.insert(caseEvents).values({
        caseId: found.id,
        eventType: "ai_review_acknowledged",
        actorUserId: userId,
        actorOrganizationId: found.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: { aiImportSource: found.aiImportSource ?? null },
      });
    }

    if (remakeOriginal) {
      const reason = input.remake?.remakeReason ?? null;
      const charged = input.remake?.remakeCharged ?? null;
      await db.insert(caseEvents).values({
        caseId: found.id,
        eventType: "remake_of",
        actorUserId: userId,
        actorOrganizationId: found.labOrganizationId,
        actorInitials: user?.initials || "SYS",
        metadataJson: {
          originalCaseId: remakeOriginal.id,
          originalCaseNumber: remakeOriginal.caseNumber,
          originalCaseKind: remakeOriginal.kind,
          remakeReason: reason,
          remakeCharged: charged,
          note: `Marked as remake of ${remakeOriginal.kind === "legacy" ? "legacy " : ""}case ${remakeOriginal.caseNumber}${reason ? ` (reason: ${reason})` : ""} during AI review`,
        },
      });
      await writeReciprocalRemadeBy(
        remakeOriginal,
        { id: found.id, caseNumber: found.caseNumber },
        reason,
        charged,
        {
          userId,
          orgId: found.labOrganizationId,
          initials: user?.initials || "SYS",
        },
      );

      // For no-charge remakes, zero out any auto-created draft invoice
      // and append a note. We deliberately don't void/delete it — the
      // invoice row stays so the audit trail is intact.
      if (charged === false) {
        const draft = await db.query.invoices.findFirst({
          where: and(
            eq(invoices.caseId, found.id),
            eq(invoices.status, "draft"),
          ),
        });
        if (draft) {
          await db
            .update(invoiceLineItems)
            .set({ unitPrice: "0.00", lineTotal: "0.00" })
            .where(eq(invoiceLineItems.invoiceId, draft.id));
          await db
            .update(invoices)
            .set({
              subtotal: "0.00",
              total: "0.00",
              balanceDue: "0.00",
              notes: `No-charge remake of case ${remakeOriginal.caseNumber}${reason ? ` — reason: ${reason}` : ""}`,
              updatedByUserId: userId,
            })
            .where(eq(invoices.id, draft.id));
        }
      }
    }

    await writeAuditLog({
      req,
      organizationId: found.labOrganizationId,
      action: remakeOriginal ? "case_remake_linked" : "ai_review_acknowledged",
      entityType: "case",
      entityId: found.id,
      beforeJson: {
        needsAiReview: found.needsAiReview,
        remakeOfCaseId: found.remakeOfCaseId,
      },
      afterJson: {
        needsAiReview: updated.needsAiReview,
        remakeOfCaseId: updated.remakeOfCaseId,
        remakeReason: updated.remakeReason,
        remakeCharged: updated.remakeCharged,
      },
    });

    return ok(res, {
      caseId: updated.id,
      needsAiReview: updated.needsAiReview ?? false,
      remakeOfCaseId: updated.remakeOfCaseId ?? null,
      remakeReason: updated.remakeReason ?? null,
      remakeCharged: updated.remakeCharged ?? null,
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
    const from = new Date(q.dateFrom);
    const to = new Date(q.dateTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
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
          sql`${cases.receivedAt} >= ${from}`,
          sql`${cases.receivedAt} <= ${to}`,
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
      from: from.toISOString(),
      to: to.toISOString(),
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

          if (zipEntries.length > ZIP_MAX_ENTRIES) {
            throw new HttpError(400, `ZIP contains too many files (${zipEntries.length}). Maximum is ${ZIP_MAX_ENTRIES}.`);
          }
          const totalUncompressed = zipEntries.reduce((sum, e) => sum + (e.header.size ?? 0), 0);
          if (totalUncompressed > ZIP_MAX_TOTAL_BYTES) {
            throw new HttpError(400, `ZIP uncompressed size (${Math.round(totalUncompressed / 1024 / 1024)} MB) exceeds the ${ZIP_MAX_TOTAL_BYTES / 1024 / 1024} MB limit.`);
          }

          for (const entry of zipEntries) {
            const entryName = path.basename(entry.entryName);
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

        for (const entry of extractedEntries) {
          try {
            const ext = path.extname(entry.name) || "";
            const safe = path.basename(entry.name, ext).replace(/[^a-zA-Z0-9\-_]+/g, "-").slice(0, 60) || "file";
            const diskName = `${Date.now()}-${randomBytes(4).toString("hex")}-${safe}${ext}`;
            const diskPath = path.join(caseMediaDir, diskName);
            await fs.promises.writeFile(diskPath, entry.data);
            writeCaseMediaToObjectStorage(diskName, entry.data, entry.mimeType).catch((err: unknown) => {
              req.log?.warn({ err, name: entry.name }, "Generic ZIP bundle: failed to mirror to object storage");
            });
            const storageKey = buildIteroAttachmentUrl(req, diskName);
            await db.insert(caseAttachments).values({
              caseId: body.caseId,
              uploadedByUserId: userId,
              uploadedByOrganizationId: body.labOrganizationId,
              fileName: entry.name,
              storageKey,
              fileType: entry.mimeType,
              visibility: "shared_with_provider",
            });
            attachedCount++;
          } catch (attachErr) {
            failedCount++;
            req.log?.warn({ err: attachErr, name: entry.name, caseId: body.caseId }, "Generic ZIP bundle: failed to save attachment");
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
          });

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
