import { createHash, randomUUID } from "node:crypto";
import type { Request } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  auditLogs, caseEvents, cases, db, labCases, organizations, organizationMemberships, users,
} from "@workspace/db";
import {
  GetCaseDoctorCandidates200Response, ReassignCaseDoctor200Response, ReassignCaseDoctorBody,
} from "@workspace/api-zod";
import type { z } from "zod";
import { HttpError } from "./http";
import { ADMIN_ROLES, requireAnyRole } from "./rbac";
import { readDoctorUndoWindowMs } from "./doctor-undo-window";
import { loadCaseDoctorRoster, parseCaseObject, type CaseDoctorTransaction } from "./case-doctor-roster";

type Assignment = z.infer<typeof GetCaseDoctorCandidates200Response>["data"]["assignment"];
type Input = z.infer<typeof ReassignCaseDoctorBody>;
type Result = z.infer<typeof ReassignCaseDoctor200Response>["data"];
type LoadedCase = {
  assignment: Assignment;
  legacyData?: Record<string, unknown>;
};
const CHANGE_ACTION = "case_doctor_reassigned";
const UNDO_ACTION = "case_doctor_reassignment_undone";

/**
 * Resolves exact persisted identity. Legacy practice association must be
 * explicit in that row; neither shared names nor remembered mappings qualify.
 */
async function loadCase(tx: CaseDoctorTransaction, caseId: string, lock: "share" | "update"): Promise<LoadedCase> {
  const [canonical] = await tx.select({
    caseId: cases.id, caseNumber: cases.caseNumber, labOrganizationId: cases.labOrganizationId,
    providerOrganizationId: cases.providerOrganizationId, doctorName: cases.doctorName,
    updatedAt: cases.updatedAt, stamp: sql<string>`${cases.updatedAt}::text`, deletedAt: cases.deletedAt,
  }).from(cases).where(eq(cases.id, caseId)).for(lock);
  let recordType: Assignment["recordType"] = "canonical";
  let row = canonical;
  let legacyData: Record<string, unknown> | undefined;
  let rawLegacy = "";
  if (!row) {
    const [legacy] = await tx.select({
      id: labCases.id, organizationId: labCases.organizationId, caseData: labCases.caseData,
      updatedAt: labCases.updatedAt, stamp: sql<string>`${labCases.updatedAt}::text`, deletedAt: labCases.deletedAt,
    }).from(labCases).where(eq(labCases.id, caseId)).for(lock);
    if (!legacy || legacy.deletedAt) throw new HttpError(404, "Case not found.");
    const parsed = parseCaseObject(legacy.caseData);
    if (!parsed) throw new HttpError(409, "This legacy case cannot be safely read. Its doctor was not changed.");
    legacyData = parsed;
    rawLegacy = legacy.caseData;
    recordType = "legacy";
    row = {
      caseId, caseNumber: String(parsed.caseNumber ?? caseId),
      labOrganizationId: legacy.organizationId ?? "",
      providerOrganizationId: typeof parsed.providerOrganizationId === "string" ? parsed.providerOrganizationId : "",
      doctorName: typeof parsed.doctorName === "string" ? parsed.doctorName : "",
      updatedAt: legacy.updatedAt!, stamp: legacy.stamp, deletedAt: legacy.deletedAt,
    };
  }
  if (row.deletedAt) throw new HttpError(404, "Case not found.");
  const revision = createHash("sha256").update(JSON.stringify([
    recordType, row.caseId, row.labOrganizationId, row.providerOrganizationId,
    row.doctorName, row.stamp, rawLegacy,
  ])).digest("hex");
  return {
    assignment: {
      caseId, recordType, caseNumber: row.caseNumber, labOrganizationId: row.labOrganizationId,
      providerOrganizationId: row.providerOrganizationId, doctorName: row.doctorName,
      revision, updatedAt: row.updatedAt?.toISOString() ?? null, practiceName: "",
    },
    legacyData,
  };
}

async function authorize(tx: CaseDoctorTransaction, userId: string, loaded: LoadedCase) {
  const a = loaded.assignment;
  // Keep existing entitlement checks and all unrelated case-edit permissions.
  await requireAnyRole(userId, a.labOrganizationId, ADMIN_ROLES);
  // Recheck under a shared row lock so a role revocation cannot race the write.
  const [member] = await tx.select({ id: organizationMemberships.id })
    .from(organizationMemberships).innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(and(
      eq(organizationMemberships.userId, userId), eq(organizationMemberships.labId, a.labOrganizationId),
      eq(organizationMemberships.status, "active"), isNull(organizationMemberships.deletedAt),
      inArray(organizationMemberships.role, ADMIN_ROLES), eq(users.isActive, true), isNull(users.deletedAt),
    )).for("share");
  const [lab] = await tx.select({ id: organizations.id }).from(organizations).where(and(
    eq(organizations.id, a.labOrganizationId), eq(organizations.type, "lab"),
    eq(organizations.isActive, true), isNull(organizations.deletedAt),
  )).for("share");
  if (!member || !lab) throw new HttpError(403, "Only active admins and owners of this case's lab can reassign its doctor.");
  const [practice] = await tx.select({ name: organizations.name, displayName: organizations.displayName })
    .from(organizations).where(and(
      eq(organizations.id, a.providerOrganizationId), eq(organizations.type, "provider"),
      eq(organizations.isActive, true), isNull(organizations.deletedAt),
    )).for("share");
  if (!practice) throw new HttpError(409, "This case has no active saved practice. A doctor cannot be reassigned by guessing a practice from their name.");
  a.practiceName = practice.displayName || practice.name;
  // These invoices derive their doctor directly from the legacy blob. Refuse
  // rather than silently changing billing attribution or creating a snapshot.
  if (loaded.legacyData?.invoiceId) {
    throw new HttpError(409, "This legacy case has an embedded invoice. Its doctor cannot be changed here without changing invoice attribution.");
  }
  if (loaded.legacyData?.activityLog != null && !Array.isArray(loaded.legacyData.activityLog)) {
    throw new HttpError(409, "This legacy case's history cannot be safely extended. Its doctor and existing history were not changed.");
  }
}

export async function getCaseDoctorCandidates(
  userId: string, caseId: string, query: { q?: string; offset: number; limit: number },
) {
  return db.transaction(async (tx) => {
    const loaded = await loadCase(tx, caseId, "share");
    await authorize(tx, userId, loaded);
    const all = await loadCaseDoctorRoster(tx, loaded.assignment.labOrganizationId, loaded.assignment.providerOrganizationId);
    const q = query.q?.trim().toLocaleLowerCase() ?? "";
    const matches = q ? all.filter((entry) =>
      entry.doctorName.toLocaleLowerCase().includes(q) ||
      entry.platformAccountNumber?.toLocaleLowerCase().includes(q),
    ) : all;
    const entries = matches.slice(query.offset, query.offset + query.limit);
    const next = query.offset + entries.length;
    return {
      assignment: loaded.assignment, entries, total: matches.length,
      nextOffset: next < matches.length ? next : null,
    };
  });
}

async function writeAssignment(
  tx: CaseDoctorTransaction, req: Request, loaded: LoadedCase, doctorName: string,
  action: typeof CHANGE_ACTION | typeof UNDO_ACTION, metadata: Record<string, unknown>,
): Promise<Result> {
  const before = loaded.assignment;
  const auditLogId = randomUUID();
  const occurredAt = new Date();
  const now = new Date(Math.max(occurredAt.getTime(), new Date(before.updatedAt ?? 0).getTime() + 1));
  const description = action === UNDO_ACTION
    ? `Doctor reassignment undone for case ${before.caseNumber}: ${before.doctorName} → ${doctorName}. This case only.`
    : `Doctor changed for case ${before.caseNumber}: ${before.doctorName} → ${doctorName}. This case only.`;
  const userId = (req as any).auth.userId as string;
  if (before.recordType === "canonical") {
    await tx.update(cases).set({ doctorName, updatedAt: now }).where(eq(cases.id, before.caseId));
    await tx.insert(caseEvents).values({
      caseId: before.caseId, eventType: action, actorUserId: userId,
      actorOrganizationId: before.labOrganizationId, actorInitials: (req as any).user?.initials ?? null,
      occurredAt,
      metadataJson: { description, beforeDoctorName: before.doctorName, doctorName, auditLogId },
    });
  } else {
    const data = loaded.legacyData!;
    await tx.update(labCases).set({
      caseData: JSON.stringify({
        ...data, doctorName,
        activityLog: [
          ...(Array.isArray(data.activityLog) ? data.activityLog : []),
          { id: auditLogId, type: action, timestamp: occurredAt.getTime(), description, user: (req as any).user?.initials ?? "" },
        ],
      }),
      updatedAt: now,
    }).where(eq(labCases.id, before.caseId));
  }
  const after = (await loadCase(tx, before.caseId, "update")).assignment;
  after.practiceName = before.practiceName;
  const undoExpiresAt = action === CHANGE_ACTION
    ? new Date(occurredAt.getTime() + readDoctorUndoWindowMs()).toISOString() : null;
  await tx.insert(auditLogs).values({
    id: auditLogId, userId, organizationId: before.labOrganizationId,
    action, entityType: before.recordType === "canonical" ? "case" : "legacy_case",
    entityId: before.caseId, beforeJson: before, afterJson: after,
    metadataJson: { ...metadata, undoExpiresAt }, createdAt: occurredAt,
    ipAddress: req.ip, userAgent: req.get("user-agent") ?? null,
  });
  return { assignment: after, previousDoctorName: before.doctorName, auditLogId, undoExpiresAt };
}

export async function reassignCaseDoctor(req: Request, caseId: string, input: Input): Promise<Result> {
  return db.transaction(async (tx) => {
    // Same legacy lock order as the other single-case blob mutations/promotion.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${caseId}))`);
    const loaded = await loadCase(tx, caseId, "update");
    await authorize(tx, (req as any).auth.userId, loaded);
    const a = loaded.assignment;
    if (input.recordType !== a.recordType || input.expectedRevision !== a.revision ||
        input.expectedDoctorName !== a.doctorName || input.expectedPracticeId !== a.providerOrganizationId) {
      throw new HttpError(409, "This case changed since you opened reassignment. Close and reopen it to review the saved doctor and practice.");
    }
    const roster = await loadCaseDoctorRoster(tx, a.labOrganizationId, a.providerOrganizationId);
    const target = roster.find((entry) => entry.key === input.candidateKey);
    if (!target) throw new HttpError(409, "That doctor is not currently associated with this practice or is no longer available. No case, practice, or account was changed.");
    if (target.doctorName === a.doctorName) throw new HttpError(400, "This case already has that doctor. Nothing was changed.");
    return writeAssignment(tx, req, loaded, target.doctorName, CHANGE_ACTION, { target });
  });
}

export async function undoCaseDoctorReassignment(req: Request, caseId: string, auditLogId: string): Promise<Result> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${caseId}))`);
    const loaded = await loadCase(tx, caseId, "update");
    await authorize(tx, (req as any).auth.userId, loaded);
    const a = loaded.assignment;
    const [audit] = await tx.select().from(auditLogs).where(and(
      eq(auditLogs.id, auditLogId), eq(auditLogs.action, CHANGE_ACTION), eq(auditLogs.entityId, caseId),
      eq(auditLogs.organizationId, a.labOrganizationId),
      eq(auditLogs.entityType, a.recordType === "canonical" ? "case" : "legacy_case"),
    ));
    if (!audit) throw new HttpError(404, "Case-only reassignment record not found.");
    const assignmentSchema = GetCaseDoctorCandidates200Response.shape.data.shape.assignment;
    const before = assignmentSchema.safeParse(audit.beforeJson);
    const after = assignmentSchema.safeParse(audit.afterJson);
    const expires = (audit.metadataJson as { undoExpiresAt?: unknown })?.undoExpiresAt;
    if (typeof expires !== "string" || !Number.isFinite(Date.parse(expires)) || Date.now() >= Date.parse(expires)) {
      throw new HttpError(409, "The doctor reassignment undo window has expired.");
    }
    if (!before.success || !after.success ||
        before.data.caseId !== caseId || before.data.recordType !== a.recordType ||
        before.data.labOrganizationId !== a.labOrganizationId ||
        before.data.providerOrganizationId !== a.providerOrganizationId ||
        after.data.revision !== a.revision || after.data.doctorName !== a.doctorName) {
      throw new HttpError(409, "This case has changed since the reassignment, or it was already undone. Undo will not overwrite a later change.");
    }
    return writeAssignment(tx, req, loaded, before.data.doctorName, UNDO_ACTION, { undoOf: audit.id });
  });
}
