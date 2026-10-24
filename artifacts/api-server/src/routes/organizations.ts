import crypto from "node:crypto";
import { assertCaseAccessWithMemberships } from "./cases";
import { enqueueJoinRequestNotification } from "../lib/join-request-notifications";
import { Router } from "express";
import multer from "multer";
import {
  deleteCasePrintTemplateImage,
  deleteInvoiceTemplateImage,
  isAllowedLogoMime,
  openCasePrintTemplateImageStream,
  openInvoiceTemplateImageStream,
  openLabLogoStream,
  readLabLogoAsset,
  uploadCasePrintTemplateImage,
  uploadInvoiceTemplateImage,
  uploadLabLogo,
} from "../lib/lab-logo-storage";
import {
  coerceInvoiceTemplate,
  DEFAULT_INVOICE_TEMPLATE,
  invoiceTemplateSchema,
} from "../lib/invoice-template";
import {
  coerceCasePrintTemplate,
  DEFAULT_CASE_PRINT_TEMPLATE,
  casePrintTemplateSchema,
} from "../lib/case-print-template";
import {
  coerceStatementTemplate,
  DEFAULT_STATEMENT_TEMPLATE,
  statementTemplateSchema,
} from "../lib/statement-template";
import {
  coerceCorrespondenceTemplate,
  DEFAULT_CORRESPONDENCE_TEMPLATE,
  correspondenceTemplateSchema,
} from "../lib/correspondence-template";
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  auditLogs,
  cases,
  doctorEmailEntries,
  doctorPhoneEntries,
  doctorProfiles,
  invoices,
  labCases,
  labClosedDays,
  labUnassignedDoctors,
  notifications,
  organizationAdditionalEmails,
  organizationConnections,
  organizationInvites,
  organizationJoinRequests,
  organizationMemberships,
  organizations,
  pricingOverrides,
  providerAccountChangeRequests,
  quickReferenceNotes,
  users,
} from "@workspace/db";
import { splitDisplayName } from "../lib/patient-similarity";
import {
  createProviderAccountThroughGate,
  findUserByEmail,
  labAffiliatedProviderAccountCondition,
  labMatchableProviderAccountCondition,
  resolveExistingProviderAccount,
  type DoctorIdentityInput,
  type ProviderAccountMatchReason,
  type ProviderAccountRow,
} from "../lib/provider-account";
import { normalizeDoctorForCompare } from "../lib/doctor-similarity";
import { generateInviteToken } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import {
  assertLabCreationFields,
  assertLabNameAvailable,
} from "../lib/lab-creation";
import { hashPassword } from "../lib/crypto";
import { HttpError, ok, wrapDbError, extractPgCode, extractPgConstraintName } from "../lib/http";
import { broadcastCaseUpdated } from "../lib/case-events-ws";
import { notDeleted, restoreDeleted, softDeleteById } from "../lib/soft-delete";
import { sendInviteEmail, sendInviteResultEmail } from "../lib/mail";
import { checkEmailPref } from "../lib/email-prefs";
import {
  assertCustomAccountNumberAvailable,
  generateProviderAccountNumber,
  generateProviderAccountNumberFallback,
  generateStandaloneProviderAccountNumber,
  parseAccountNumbers,
  withAccountNumberLock,
} from "../lib/provider-account-number";
import {
  ADMIN_ROLES,
  getActiveMembership,
  hasCapability,
  requireAnyRole,
  requireCapability,
  requireMembership,
  type MembershipRole,
} from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import {
  requireAuth,
  isAccountVerified,
  isCanonicalAccount,
} from "../middlewares/auth";
import {
  allocatePlatformAccountNumber,
} from "../lib/platform-account-number";
import { getUncachableStripeClient } from "../lib/stripeClient";
import {
  getCachedSharedCardSummary,
  refreshSharedCardSummary,
} from "../lib/provider-shared-account";
import { requireSelectedProviderOrganization } from "../lib/provider-selection";

const router = Router();

const organizationListColumns = {
  id: organizations.id,
  type: organizations.type,
  name: organizations.name,
  displayName: organizations.displayName,
  billingEmail: organizations.billingEmail,
  phone: organizations.phone,
  addressLine1: organizations.addressLine1,
  addressLine2: organizations.addressLine2,
  city: organizations.city,
  state: organizations.state,
  zip: organizations.zip,
  isActive: organizations.isActive,
  defaultBankAccountId: organizations.defaultBankAccountId,
  logoUrl: organizations.logoUrl,
  logoplacements: organizations.logoplacements,
  logoPdfSize: organizations.logoPdfSize,
  invoiceTemplate: organizations.invoiceTemplate,
  invoiceTemplatePresets: organizations.invoiceTemplatePresets,
  statementTemplate: organizations.statementTemplate,
  casePrintTemplate: organizations.casePrintTemplate,
  correspondenceTemplate: organizations.correspondenceTemplate,
  parentLabOrganizationId: organizations.parentLabOrganizationId,
  accountNumber: organizations.accountNumber,
  platformAccountNumber: organizations.platformAccountNumber,
  createdByUserId: organizations.createdByUserId,
  createdAt: organizations.createdAt,
  updatedAt: organizations.updatedAt,
  statementEmailOptOut: organizations.statementEmailOptOut,
  duplicateSuggestionThreshold: organizations.duplicateSuggestionThreshold,
  defaultCaseDueDays: organizations.defaultCaseDueDays,
  capCaseDueToDefault: organizations.capCaseDueToDefault,
  invoiceDueDayOfMonth: organizations.invoiceDueDayOfMonth,
  autoAddAlloyOnPfm: organizations.autoAddAlloyOnPfm,
  printProviderPreferencesOnLabSlips:
    organizations.printProviderPreferencesOnLabSlips,
  licenseNumber: organizations.licenseNumber,
  defaultDoctorTierName: organizations.defaultDoctorTierName,
  revenueTargetLow: organizations.revenueTargetLow,
  revenueTargetHigh: organizations.revenueTargetHigh,
  deletedAt: organizations.deletedAt,
  deletedByUserId: organizations.deletedByUserId,
};
router.use(requireAuth);

const providerPortalContactSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  displayName: z.string().trim().min(1).max(200).nullable().optional(),
  billingEmail: z.union([z.literal(""), z.string().email()]).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  addressLine1: z.string().max(200).nullable().optional(),
  addressLine2: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(50).nullable().optional(),
  zip: z.string().max(30).nullable().optional(),
});

router.patch("/provider-portal-contact", asyncHandler(async (req, res) => {
  const organization = await requireSelectedProviderOrganization(
    (req as any).auth.userId as string,
    req.header("x-provider-organization-id"),
  );
  const providerMembership = await getActiveMembership(
    (req as any).auth.userId as string,
    organization.id,
  );
  if (!providerMembership || !ADMIN_ROLES.includes(providerMembership.role as MembershipRole)) {
    throw new HttpError(403, "Only provider organization owners and admins can update contact details.");
  }
  const input = providerPortalContactSchema.parse(req.body);
  const updates: Record<string, unknown> = {};
  for (const field of [
    "name", "displayName", "billingEmail", "phone", "addressLine1",
    "addressLine2", "city", "state", "zip",
  ] as const) {
    if (input[field] !== undefined) updates[field] = input[field] || null;
  }
  if (Object.keys(updates).length === 0) throw new HttpError(400, "No contact changes supplied.");
  const [updated] = await db.update(organizations)
    .set(updates)
    .where(eq(organizations.id, organization.id))
    .returning(organizationListColumns);
  await writeAuditLog({
    req, action: "provider_organization_contact_updated",
    entityType: "organization", entityId: organization.id,
    beforeJson: sharedProviderContact(organization),
    afterJson: sharedProviderContact(updated),
  });
  return ok(res, updated);
}));

const createOrgSchema = z.object({
  type: z.enum(["lab", "provider"]),
  name: z.string().min(1),
  displayName: z.string().optional(),
  // Accept a blank string (cleared field in the edit form) and normalize it to
  // null. Editing a practice that has no billing email sends `billingEmail: ""`,
  // which would otherwise fail `.email()` and surface as a generic
  // "Invalid request." error.
  billingEmail: z
    .union([z.literal(""), z.string().email()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  phone: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  isActive: z.boolean().optional(),
  // When true the automated statement-email engine skips this practice.
  statementEmailOptOut: z.boolean().optional(),
  // Default days after received-date to set as the due date for new cases.
  // Null clears the override (no default applied). Lab orgs only.
  defaultCaseDueDays: z.number().int().min(1).max(365).nullable().optional(),
  // When true, new case due dates are capped at (received date + defaultCaseDueDays).
  // Dates sooner than the turnaround are kept as-is (treated as rush). Lab orgs only.
  capCaseDueToDefault: z.boolean().nullable().optional(),
  // Day of the month (1–28) on which invoices become due (following month from issue
  // date). Null clears the override (application default 10 applies). Lab orgs only.
  invoiceDueDayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  // When true, adding a PFM restoration auto-appends an "Alloy" surcharge line
  // (priced via tier/override logic). Lab orgs only.
  autoAddAlloyOnPfm: z.boolean().optional(),
  // When true, lab slips include the current provider user's preferences.
  // Lab orgs only.
  printProviderPreferencesOnLabSlips: z.boolean().optional(),
  // Monthly revenue target thresholds (dollars) for chart red/yellow/green
  // coloring. Null clears the override (application defaults 85 000 / 95 000
  // apply). Lab orgs only; ignored on provider orgs.
  revenueTargetLow: z.number().int().min(0).nullable().optional(),
  revenueTargetHigh: z.number().int().min(0).nullable().optional(),
  // Lab license / registration number (Account epic Phase 3). Required when
  // creating a lab environment; ignored on provider orgs.
  licenseNumber: z.string().optional(),
  // Doctor name is used (alongside the address) to derive the auto account
  // number when the lab admin doesn't supply one. It's optional and not
  // persisted on the org row directly — it just feeds the derivation.
  doctorName: z.string().optional(),
  // Optional caller-supplied account number override. When present, must be
  // unique within the parent lab.
  accountNumber: z.string().optional(),
  // Optional explicit parent lab; falls back to the caller's primary lab
  // membership if omitted. Provider orgs only.
  parentLabOrganizationId: z.string().optional(),
});

// Revenue-target cross-field guard shared by create and update schemas.
function refineRevenueCrossField<
  T extends { revenueTargetLow?: number | null; revenueTargetHigh?: number | null },
>(data: T, ctx: z.RefinementCtx) {
  const lo = data.revenueTargetLow;
  const hi = data.revenueTargetHigh;
  if (lo != null && hi != null && lo >= hi) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Low threshold must be less than the high threshold.",
      path: ["revenueTargetLow"],
    });
  }
}

// PATCH does not allow changing the parent lab — that would silently move a
// practice between labs and re-key its account-number namespace.
const updateOrgSchema = createOrgSchema
  .omit({ type: true, parentLabOrganizationId: true, doctorName: true })
  .partial()
  .superRefine(refineRevenueCrossField);

// Resolve read access for an organization. Direct active membership grants
// access; for provider orgs, an active membership of the parent lab also
// grants read access (lab admins/staff manage their providers from the
// Doctors page, etc.).
async function resolveOrgReadAccess(userId: string, organizationId: string) {
  const direct = await getActiveMembership(userId, organizationId);
  if (direct) return { membership: direct, organization: null };
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  if (!org) throw new HttpError(404, "Organization not found.");
  if (org.parentLabOrganizationId) {
    const parentMembership = await getActiveMembership(
      userId,
      org.parentLabOrganizationId
    );
    if (parentMembership) return { membership: parentMembership, organization: org };
  }
  throw new HttpError(403, "You do not belong to this organization.");
}

// A case viewer may read the lab's shared slip and its protected images without
// acquiring any organization/template write permission. Bind to that exact case.
async function resolveCasePrintReadAccess(userId: string, organizationId: string, caseId: unknown) {
  try {
    return await resolveOrgReadAccess(userId, organizationId);
  } catch (error) {
    if (typeof caseId !== "string" || !caseId) throw error;
    const access = await assertCaseAccessWithMemberships(userId, caseId);
    if (access.case.labOrganizationId !== organizationId) throw new HttpError(403, "This template does not belong to the case's lab.");
    return access;
  }
}

// Resolve admin-write access for an organization. Direct admin membership of
// the org always works; for provider orgs, admin of the parent lab also
// suffices (so lab admins can edit a linked practice's contact details from
// the doctor / practices view).
async function resolveOrgAdminAccess(
  userId: string,
  organizationId: string,
  roles: MembershipRole[] = ADMIN_ROLES
) {
  const direct = await getActiveMembership(userId, organizationId);
  if (direct && roles.includes(direct.role as MembershipRole)) {
    return { membership: direct, organization: null };
  }
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  if (!org) throw new HttpError(404, "Organization not found.");
  if (org.parentLabOrganizationId) {
    const parentMembership = await getActiveMembership(
      userId,
      org.parentLabOrganizationId
    );
    if (
      parentMembership &&
      roles.includes(parentMembership.role as MembershipRole)
    ) {
      return { membership: parentMembership, organization: org };
    }
  }
  throw new HttpError(403, "You do not have permission for this action.");
}

// Resolve who may review (list/approve/reject) join requests for an
// organization. Direct admin membership of the org always works. For provider
// orgs (practices) that have NO active admin/owner members — the common case
// for lab-created practices — an admin of the parent lab may act instead, so
// practice join requests are never stuck with nobody able to approve them.
// Once the practice has its own active admin, the parent-lab fallback closes.
async function resolveJoinRequestAdminAccess(
  userId: string,
  organizationId: string
) {
  const direct = await getActiveMembership(userId, organizationId);
  if (direct && ADMIN_ROLES.includes(direct.role as MembershipRole)) {
    return { membership: direct, organization: null };
  }
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  if (!org) throw new HttpError(404, "Organization not found.");
  if (org.type === "provider" && org.parentLabOrganizationId) {
    const practiceAdmins = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.labId, organizationId),
          eq(organizationMemberships.status, "active"),
          inArray(organizationMemberships.role, [...ADMIN_ROLES]),
          notDeleted(organizationMemberships)
        )
      );
    if (practiceAdmins.length === 0) {
      const parentMembership = await getActiveMembership(
        userId,
        org.parentLabOrganizationId
      );
      if (
        parentMembership &&
        ADMIN_ROLES.includes(parentMembership.role as MembershipRole)
      ) {
        return { membership: parentMembership, organization: org };
      }
    }
  }
  throw new HttpError(403, "You do not have permission for this action.");
}

async function findCallerPrimaryLabId(userId: string): Promise<string | null> {
  const memberships = await db.query.organizationMemberships.findMany({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.status, "active")
    ),
  });
  if (memberships.length === 0) return null;
  const orgIds = memberships.map((m) => m.labId);
  const orgs = await db
    .select()
    .from(organizations)
    .where(inArray(organizations.id, orgIds));
  const labOrg = orgs.find((o) => o.type === "lab");
  return labOrg?.id ?? null;
}

function mapMembershipRoleToUserRole(role?: string | null): "admin" | "user" {
  return role === "owner" || role === "admin" ? "admin" : "user";
}

function getOrganizationDisplayName(organization: any): string {
  return organization.displayName || organization.name;
}

function getOrganizationAddress(organization: any): string | null {
  const address = [
    organization.addressLine1,
    organization.addressLine2,
    organization.city,
    organization.state,
    organization.zip,
  ]
    .filter(Boolean)
    .join(", ");

  return address || null;
}

const SHARED_PROVIDER_CONTACT_FIELDS = [
  "name",
  "displayName",
  "billingEmail",
  "phone",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "zip",
] as const;

type SharedProviderContactField =
  (typeof SHARED_PROVIDER_CONTACT_FIELDS)[number];
type SharedProviderContact = Record<SharedProviderContactField, string | null>;

function sharedProviderContact(organization: typeof organizations.$inferSelect) {
  return Object.fromEntries(
    SHARED_PROVIDER_CONTACT_FIELDS.map((field) => [
      field,
      organization[field] ?? null,
    ]),
  ) as SharedProviderContact;
}

function sameSharedProviderContact(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return SHARED_PROVIDER_CONTACT_FIELDS.every(
    (field) => (left[field] ?? null) === (right[field] ?? null),
  );
}

async function getSharedProviderRelationship(
  userId: string,
  labOrganizationId: string,
  providerOrganizationId: string,
  requireAdmin = false,
) {
  const provider = await db.query.organizations.findFirst({
    where: and(
      eq(organizations.id, providerOrganizationId),
      eq(organizations.type, "provider"),
      isNull(organizations.deletedAt),
    ),
  });
  if (
    !provider ||
    !provider.isActive ||
    provider.parentLabOrganizationId !== labOrganizationId
  ) {
    throw new HttpError(404, "Provider relationship not found.");
  }
  const [labMembership, providerMembership] = await Promise.all([
    getActiveMembership(userId, labOrganizationId),
    getActiveMembership(userId, providerOrganizationId),
  ]);
  const allowedRoles = requireAdmin ? ADMIN_ROLES : VALID_MEMBERSHIP_ROLES;
  const labAccess =
    labMembership &&
    allowedRoles.includes(labMembership.role as MembershipRole);
  const providerAccess =
    providerMembership &&
    allowedRoles.includes(providerMembership.role as MembershipRole);
  if (!labAccess && !providerAccess) {
    throw new HttpError(403, "You do not have access to this provider relationship.");
  }
  return {
    provider,
    actingOrganizationId: labAccess
      ? labOrganizationId
      : providerOrganizationId,
    source: labAccess ? ("lab" as const) : ("provider" as const),
  };
}

async function assertProviderCallerSelection(
  req: any,
  providerOrganizationId: string,
) {
  if (req.user?.userType !== "provider") return;
  const selected = await requireSelectedProviderOrganization(
    req.auth.userId as string,
    req.header("x-provider-organization-id"),
  );
  if (selected.id !== providerOrganizationId) {
    throw new HttpError(403, "That provider organization is not selected.");
  }
}

async function notifySharedAccountCounterpart(input: {
  labOrganizationId: string;
  providerOrganizationId: string;
  recipientOrganizationId: string;
  requestId: string;
  type: "provider_account_change_requested" | "provider_account_change_decided";
  title: string;
  body: string;
}) {
  try {
    const recipients = await db
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(
            organizationMemberships.labId,
            input.recipientOrganizationId,
          ),
          eq(organizationMemberships.status, "active"),
          isNull(organizationMemberships.deletedAt),
          inArray(organizationMemberships.role, [...ADMIN_ROLES]),
        ),
      );
    if (recipients.length === 0) return;
    await db.insert(notifications).values(
      [...new Set(recipients.map((recipient) => recipient.userId))].map(
        (userId) => ({
          userId,
          type: input.type,
          title: input.title,
          body: input.body,
          dataJson: {
            requestId: input.requestId,
            labOrganizationId: input.labOrganizationId,
            providerOrganizationId: input.providerOrganizationId,
          },
        }),
      ),
    );
  } catch {
    // Counterpart notifications are best-effort and never mutate account state.
  }
}

async function repairLabCaseAffiliations(labId: string): Promise<void> {
  const [org, activeMembers] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(organizations.id, labId) }),
    db.select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.labId, labId),
          eq(organizationMemberships.status, "active")
        )
      ),
  ]);
  if (!org || activeMembers.length === 0) return;

  const memberUserIds = activeMembers.map((m) => m.userId);
  const caseRows = await db.select().from(labCases)
    .where(inArray(labCases.ownerId, memberUserIds));
  if (caseRows.length === 0) return;

  const orgAffiliationKey = `org:${labId}`;
  const orgAffiliationName = org.displayName || org.name || null;

  const repairPromises: Promise<any>[] = [];
  for (const row of caseRows) {
    if (!row.caseData) continue;
    let caseData: any;
    try {
      caseData = JSON.parse(row.caseData);
    } catch {
      continue;
    }
    const existingKey: string | undefined = caseData.affiliationKey;
    const needsRepair =
      !existingKey ||
      existingKey.startsWith("private:") ||
      (!existingKey.startsWith("org:") && !existingKey.startsWith("lab:"));
    if (!needsRepair) continue;

    const repairedData = {
      ...caseData,
      affiliationKey: orgAffiliationKey,
      affiliationName: orgAffiliationName,
    };
    repairPromises.push(
      db
        .insert(labCases)
        .values({
          id: row.id,
          ownerId: row.ownerId,
          caseData: JSON.stringify(repairedData),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: labCases.id,
          set: {
            caseData: JSON.stringify(repairedData),
            updatedAt: new Date(),
          },
        })
    );
  }
  if (repairPromises.length > 0) {
    await Promise.all(repairPromises);
  }
}

const VALID_MEMBERSHIP_ROLES: MembershipRole[] = [
  "owner",
  "admin",
  "user",
  "billing",
  "read_only",
];

/**
 * Validate an optional client-supplied membership role override. Unknown or
 * non-string values are ignored and the trusted fallback is used instead, so a
 * crafted request body can never assign an invalid/privileged role.
 */
function coerceMembershipRole(
  value: unknown,
  fallback: MembershipRole
): MembershipRole {
  return typeof value === "string" &&
    VALID_MEMBERSHIP_ROLES.includes(value as MembershipRole)
    ? (value as MembershipRole)
    : fallback;
}

/**
 * Upsert an active membership for (labId, userId).
 *
 * The unique index `memberships_org_user_unique` is PARTIAL — it only covers
 * rows WHERE deleted_at IS NULL. An `ON CONFLICT` arbiter must match a real
 * index, so the conflict target carries the same `WHERE deleted_at IS NULL`
 * predicate via `targetWhere`. Without it, Postgres rejects the upsert and the
 * caller sees a generic failure (the join-request approve / invite-accept bug).
 *
 * The `set` clause also clears `deletedAt` / `deletedByUserId` so a colliding
 * row is reactivated cleanly rather than left in an inconsistent state. A
 * historical soft-deleted row (deleted_at IS NOT NULL) is outside the partial
 * index, so it never collides — a fresh active row is inserted and the user
 * still ends up with exactly one active membership.
 *
 * Shared by both the invite-accept and join-request-approve routes so the two
 * upserts cannot drift apart.
 */
async function upsertActiveMembership(opts: {
  labId: string;
  userId: string;
  role: MembershipRole;
  invitedByUserId?: string | null;
  approvedByUserId?: string | null;
}) {
  const now = new Date();
  const invitedByUserId = opts.invitedByUserId ?? null;
  const approvedByUserId = opts.approvedByUserId ?? null;
  const [membership] = await db
    .insert(organizationMemberships)
    .values({
      labId: opts.labId,
      userId: opts.userId,
      role: opts.role,
      status: "active",
      invitedByUserId,
      approvedByUserId,
      joinedAt: now,
    })
    .onConflictDoUpdate({
      target: [organizationMemberships.labId, organizationMemberships.userId],
      targetWhere: isNull(organizationMemberships.deletedAt),
      set: {
        role: opts.role,
        status: "active",
        invitedByUserId,
        approvedByUserId,
        joinedAt: now,
        deletedAt: null,
        deletedByUserId: null,
      },
    })
    .returning();
  return membership;
}

async function syncUserToOrganization(
  userId: string,
  organizationId: string,
  membershipRole?: string | null
) {
  const organization = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });

  if (!organization) {
    return null;
  }

  await db
    .update(users)
    .set({
      practiceName: getOrganizationDisplayName(organization),
      practiceAddress: getOrganizationAddress(organization),
      practicePhone: organization.phone || null,
      role: mapMembershipRoleToUserRole(membershipRole),
    })
    .where(eq(users.id, userId));

  return organization;
}

async function syncUsersToOrganization(organizationId: string, organization?: any) {
  const resolvedOrganization =
    organization ||
    (await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    }));

  if (!resolvedOrganization) {
    return;
  }

  const memberships = await db.query.organizationMemberships.findMany({
    where: and(
      eq(organizationMemberships.labId, organizationId),
      eq(organizationMemberships.status, "active")
    ),
  });

  for (const membership of memberships) {
    await db
      .update(users)
      .set({
        practiceName: getOrganizationDisplayName(resolvedOrganization),
        practiceAddress: getOrganizationAddress(resolvedOrganization),
        practicePhone: resolvedOrganization.phone || null,
        role: mapMembershipRoleToUserRole(membership.role),
      })
      .where(eq(users.id, membership.userId));
  }
}

async function syncUserFromActiveMemberships(userId: string) {
  const memberships = await db.query.organizationMemberships.findMany({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.status, "active")
    ),
  });

  if (memberships.length === 0) {
    await db
      .update(users)
      .set({
        practiceName: null,
        practiceAddress: null,
        practicePhone: null,
        role: "user",
      })
      .where(eq(users.id, userId));
    return;
  }

  const primaryMembership = memberships[0];
  await syncUserToOrganization(
    userId,
    primaryMembership.labId,
    primaryMembership.role
  );
}

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createOrgSchema.parse(req.body);
    if (
      input.type !== "lab" &&
      input.printProviderPreferencesOnLabSlips !== undefined
    ) {
      throw new HttpError(
        400,
        "Provider preference printing can only be configured for lab organizations.",
      );
    }
    const callerId = (req as any).auth.userId;

    let parentLabOrganizationId: string | null = null;

    if (input.type === "lab") {
      // Account epic Phase 3 — only a verified account may stand up a lab
      // environment. Lazy adoption matches requireVerifiedAccount: legacy
      // (non-canonical) accounts are grandfathered.
      const caller = (req as any).user;
      if (
        process.env.DISABLE_VERIFICATION_ENFORCEMENT !== "true" &&
        isCanonicalAccount(caller) &&
        !isAccountVerified(caller)
      ) {
        throw new HttpError(
          403,
          "Please verify your email or phone before creating a lab.",
          { code: "VERIFICATION_REQUIRED" }
        );
      }
      // Only lab-type accounts may stand up a lab environment. UI gating is not
      // sufficient — a provider account could call this endpoint directly.
      // userType defaults to "lab" in the schema, so legacy/unspecified
      // accounts are grandfathered; provider accounts are blocked.
      const callerUserType = caller?.userType ?? "lab";
      if (callerUserType !== "lab") {
        throw new HttpError(
          403,
          "Only lab accounts can create a lab environment.",
          { code: "LAB_USER_REQUIRED" }
        );
      }
      assertLabCreationFields({
        name: input.name,
        addressLine1: input.addressLine1,
        licenseNumber: input.licenseNumber,
        phone: input.phone,
        billingEmail: input.billingEmail,
      });
      await assertLabNameAvailable(input.name);
    }

    if (input.type === "provider") {
      // Resolve the parent lab. Either supplied explicitly (and the caller
      // must be an admin of that lab) or inferred from the caller's primary
      // lab membership.
      if (input.parentLabOrganizationId) {
        await requireAnyRole(
          callerId,
          input.parentLabOrganizationId,
          ADMIN_ROLES
        );
        parentLabOrganizationId = input.parentLabOrganizationId;
      } else {
        parentLabOrganizationId = await findCallerPrimaryLabId(callerId);
      }

      if (parentLabOrganizationId) {
        // Guard against duplicate practice names within the same lab.
        // Only active provider orgs are checked — inactive/archived practices
        // and non-provider orgs do not block creation of a new active practice.
        // There is no DB unique index on (parentLabOrganizationId, name) so
        // this check is the only gate. Case-insensitive, soft-delete-aware.
        const existingByName = await db.query.organizations.findFirst({
          where: and(
            eq(organizations.parentLabOrganizationId, parentLabOrganizationId),
            eq(organizations.type, "provider"),
            eq(organizations.isActive, true),
            eq(
              sql`lower(${organizations.name})`,
              input.name.toLowerCase()
            ),
            notDeleted(organizations)
          ),
        });
        if (existingByName) {
          throw new HttpError(
            409,
            "A practice with this name already exists. Select existing practice instead.",
            {
              conflictingOrg: {
                id: existingByName.id,
                name: existingByName.name,
                displayName: existingByName.displayName,
                accountNumber: existingByName.accountNumber,
              },
            }
          );
        }

        // accountNumber is computed inside withAccountNumberLock below.
      }
    }

    const {
      doctorName: _doctorName,
      accountNumber: _accountNumberInput,
      parentLabOrganizationId: _parentLabInput,
      licenseNumber: _licenseNumberInput,
      ...persistableInput
    } = input;

    // License number is only meaningful for lab orgs.
    const licenseNumber =
      input.type === "lab" ? input.licenseNumber?.trim() || null : null;

    // Base insert values — accountNumber is computed inside the advisory lock.
    const baseInsertValues = {
      ...persistableInput,
      licenseNumber,
      parentLabOrganizationId,
      createdByUserId: callerId,
    };

    // Helper: acquire the per-lab advisory lock (pg_advisory_xact_lock),
    // validate/generate the account number inside the same transaction, then
    // insert — making check+write atomic and preventing concurrent races.
    //
    // `useFallback` — when true, use generateProviderAccountNumberFallback
    //                 (includes soft-deleted rows) instead of the primary
    //                 generator. Only needed while the transitional
    //                 organizations_parent_lab_account_number_unique DB index
    //                 still exists on the dev DB (before schema push).
    const insertWithAccountNumberLock = (useFallback = false) =>
      withAccountNumberLock(parentLabOrganizationId, async (client) => {
        // Platform allocation and the organization insert share this
        // transaction. It is never best-effort: a failed allocation rolls the
        // creation back rather than creating an unnumbered provider org.
        const platformAccountNumber = await allocatePlatformAccountNumber({
          tx: client,
        });
        let acctNum: string | null = null;
        if (parentLabOrganizationId) {
          if (input.accountNumber && input.accountNumber.trim()) {
            acctNum = await assertCustomAccountNumberAvailable(
              parentLabOrganizationId,
              input.accountNumber,
              null,
              client
            );
          } else if (useFallback) {
            acctNum = await generateProviderAccountNumberFallback(
              parentLabOrganizationId,
              {
                addressLine1: input.addressLine1 ?? null,
                doctorName: input.doctorName ?? null,
                practiceName: input.displayName || input.name,
              },
              client
            );
          } else {
            acctNum = await generateProviderAccountNumber(
              parentLabOrganizationId,
              {
                addressLine1: input.addressLine1 ?? null,
                doctorName: input.doctorName ?? null,
                practiceName: input.displayName || input.name,
              },
              client
            );
          }
        } else if (input.type === "provider") {
          acctNum = await generateStandaloneProviderAccountNumber(
            {
              addressLine1: input.addressLine1 ?? null,
              doctorName: input.doctorName ?? null,
              practiceName: input.displayName || input.name,
            },
            client,
          );
        }
        const [row] = await (client as any)
          .insert(organizations)
          .values({ ...baseInsertValues, accountNumber: acctNum, platformAccountNumber })
          .returning();
        return row as typeof organizations.$inferSelect;
      });

    const insertWrapErrors = {
      duplicate: "A practice with this name already exists. Select existing practice instead.",
      notNull: "Practice name, city, state, and ZIP are required.",
      checkViolation: "Practice name, city, state, and ZIP are required.",
      fallback: "Could not save this practice. Please check required fields and try again.",
    };

    let organization: (typeof organizations.$inferSelect) | undefined;
    try {
      organization = await insertWithAccountNumberLock();
    } catch (err: unknown) {
      // Re-throw application-level errors (e.g. HttpError from account number
      // validation) directly — they must not be passed through wrapDbError.
      if (err instanceof HttpError) throw err;
      if (extractPgCode(err) === "23505") {
        const constraint = extractPgConstraintName(err);
        if (constraint === "organizations_platform_account_number_unique") {
          // The allocator checks both owner tables before returning, so this
          // indicates an unexpected schema/concurrency problem. Never create
          // an unnumbered provider organization as a fallback.
          throw new HttpError(
            500,
            "Could not allocate a unique platform account number.",
          );
        } else if (constraint === "organizations_parent_lab_account_number_unique") {
          // Transitional: the dev DB may still carry the old unique index on
          // (parentLabOrganizationId, accountNumber) before schema push removes it.
          //
          // Caller supplied a CUSTOM account number: the submitted number collides
          // with a soft-deleted practice's number stored in the old index. Return
          // a clear 409 — never silently substitute a different number.
          //
          // Auto-generated number: the primary generator excluded soft-deleted
          // rows from its availability check, but the old index still covers them.
          // Retry with the fallback generator that scans ALL rows (including
          // soft-deleted) to find a slot that is genuinely unoccupied in the DB.
          if (input.accountNumber && input.accountNumber.trim()) {
            throw new HttpError(409, "That account number is already in use.");
          }
          req.log?.warn?.(
            { constraint },
            "Auto-generated account number collided with a soft-deleted row; retrying with fallback generator"
          );
          try {
            organization = await insertWithAccountNumberLock(true);
          } catch (retryErr: unknown) {
            if (retryErr instanceof HttpError) throw retryErr;
            wrapDbError(retryErr, insertWrapErrors);
          }
        } else {
          wrapDbError(err, insertWrapErrors);
        }
      } else {
        wrapDbError(err, {
          notNull: "Practice name, city, state, and ZIP are required.",
          checkViolation: "Practice name, city, state, and ZIP are required.",
          fallback: "Could not save this practice. Please check required fields and try again.",
        });
      }
    }
    if (!organization) {
      throw new HttpError(
        500,
        "Could not save this practice. Please check required fields and try again."
      );
    }

    // Only insert an owner membership when the caller is creating their own lab.
    // Provider orgs are client records managed via parentLabOrganizationId — the
    // creating lab user should not gain a membership in the practice they add.
    if (organization.type === "lab") {
      await db.insert(organizationMemberships).values({
        labId: organization.id,
        userId: callerId,
        role: "owner",
        status: "active",
        approvedByUserId: callerId,
        joinedAt: new Date(),
      }).catch((err: unknown): never => wrapDbError(err, {
        duplicate: "You are already a member of this organization.",
        fallback: "Failed to create organization membership.",
      }));

      await syncUserToOrganization(
        (req as any).auth.userId,
        organization.id,
        "owner"
      );
    }

    await writeAuditLog({
      req,
      organizationId: organization.id,
      action: "organization_created",
      entityType: "organization",
      entityId: organization.id,
      afterJson: organization,
    });

    return ok(res, organization, 201);
  })
);

/**
 * Accounts the admin was shown by the match preview and explicitly marked as
 * a different person (Task #4398). Carried per doctor row so a dismissal only
 * applies to the row it was made on.
 */
const distinctFromUserIdsSchema = z
  .array(z.string().min(1))
  .max(20)
  .optional()
  .default([]);

const addDoctorsSchema = z.object({
  doctors: z
    .array(
      z.object({
        firstName: z.string().trim().min(1),
        lastName: z.string().trim().optional().default(""),
        email: z.string().trim().email().optional().or(z.literal("")),
        phone: z.string().trim().optional(),
        distinctFromUserIds: distinctFromUserIdsSchema,
      })
    )
    .min(1)
    .max(50),
});

/**
 * Read-only "does this doctor already have an account?" preview
 * (Task #4398). Same input shape as the add call, but every field is
 * optional: the admin is still typing, and a half-filled row simply has
 * nothing to match on yet.
 */
const previewDoctorMatchesSchema = z.object({
  doctors: z
    .array(
      z.object({
        firstName: z.string().trim().optional().default(""),
        lastName: z.string().trim().optional().default(""),
        // Deliberately NOT `.email()` — a partially typed address must return
        // "no match", not a validation error that blanks the whole preview.
        email: z.string().trim().max(320).optional().default(""),
        phone: z.string().trim().max(64).optional().default(""),
        distinctFromUserIds: distinctFromUserIdsSchema,
      })
    )
    .min(1)
    .max(50),
});

// Bulk-add doctors to a provider practice. Lab admin only.
//
// A doctor who already has a provider account is ATTACHED to the practice and
// reported as reused, carrying their existing account number — adding the same
// person twice (with or without an email, with or without a "Dr." prefix or a
// middle initial) must never mint a second account or a second number
// (Task #4372). Only a genuinely new doctor is created, through the
// provider-account gate, which allocates the account number (Task #320) and
// records the sanctioned trigger that created the account. Every added doctor
// becomes an active member with role "user"; a random password is stored — the
// doctor must claim/reset it later via the standard flows.
router.post(
  "/:organizationId/doctors",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    const callerId = (req as any).auth.userId as string;

    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!practice || practice.deletedAt) {
      throw new HttpError(404, "Practice not found.");
    }
    if (practice.type !== "provider") {
      throw new HttpError(400, "Doctors can only be added to provider practices.");
    }
    if (!practice.parentLabOrganizationId) {
      throw new HttpError(400, "Practice has no parent lab.");
    }

    // Caller must be an admin of the parent lab.
    await requireAnyRole(callerId, practice.parentLabOrganizationId, ADMIN_ROLES);

    const input = addDoctorsSchema.parse(req.body);
    const labId = practice.parentLabOrganizationId;

    type AddedDoctor = {
      id: string;
      username: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      phone: string | null;
      platformAccountNumber: string | null;
    };
    const created: AddedDoctor[] = [];
    const reused: Array<
      AddedDoctor & { index: number; matchedOn: ProviderAccountMatchReason }
    > = [];
    const skipped: Array<{ index: number; reason: string }> = [];

    for (let i = 0; i < input.doctors.length; i++) {
      const d = input.doctors[i];
      try {
        const email = d.email && d.email.length > 0 ? d.email.toLowerCase() : null;
        const phone = d.phone && d.phone.length > 0 ? d.phone : null;
        const identity: DoctorIdentityInput = {
          firstName: d.firstName,
          lastName: d.lastName,
          doctorName: `${d.firstName} ${d.lastName}`.trim(),
          email,
          phone,
        };

        // The gate resolves the doctor against existing accounts first: when
        // they already have one it is attached here and reported as reused,
        // so no second account (and no second account number) is minted.
        const outcome = await db.transaction(async (tx) => {
          const gate = await createProviderAccountThroughGate({
            runner: tx,
            trigger: "lab_created_account",
            actorUserId: callerId,
            labOrganizationId: labId,
            organizationId,
            identity,
            practice: { name: practice.name, displayName: practice.displayName },
            // Accounts the admin saw in the pre-submit preview and declared a
            // different person (Task #4398). Everyone else is still matched.
            excludeUserIds: d.distinctFromUserIds,
          });
          await ensureMembership(tx, organizationId, gate.user.id, callerId);
          // Attaching a doctor to a practice takes them out of the lab's
          // Unassigned holding area.
          await clearUnassignedHolding(tx, labId, { userId: gate.user.id });
          return gate;
        });

        const user = outcome.user;
        const row: AddedDoctor = {
          id: user.id,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          platformAccountNumber: user.platformAccountNumber,
        };

        await writeAuditLog({
          req,
          organizationId,
          action:
            outcome.outcome === "reused"
              ? "practice_doctor_attached_existing"
              : "practice_doctor_added",
          entityType: "user",
          entityId: user.id,
          afterJson: {
            username: user.username,
            email: user.email,
            phone: user.phone,
            platformAccountNumber: user.platformAccountNumber,
            ...(outcome.outcome === "reused"
              ? { reusedExistingAccount: true, matchedOn: outcome.matchedOn }
              : {
                  trigger: "lab_created_account",
                  // A new account created *after* the admin dismissed a match
                  // has to be traceable back to that decision.
                  ...(d.distinctFromUserIds.length > 0
                    ? { confirmedDistinctFromUserIds: d.distinctFromUserIds }
                    : {}),
                }),
          },
        });

        if (outcome.outcome === "reused") {
          reused.push({ ...row, index: i, matchedOn: outcome.matchedOn });
        } else {
          created.push(row);
        }
      } catch (err: any) {
        // Per-row failure must not abort the whole batch — surface the row
        // as skipped so the caller can see exactly which doctors landed.
        req.log?.warn?.(
          { err: err?.message ?? String(err), index: i },
          "Failed to create doctor in bulk endpoint"
        );
        skipped.push({
          index: i,
          reason: err?.message || "Unexpected error while creating doctor.",
        });
      }
    }

    return ok(res, { created, reused, skipped }, 201);
  })
);

// Pre-submit duplicate check for the add-doctor forms (Task #4398).
//
// Adding a doctor who already has an account attaches that account instead of
// minting a second one, but before this endpoint the admin only found out
// afterwards. This is a READ-ONLY preview of that same decision: it runs the
// one shared resolver the add path runs (`resolveExistingProviderAccount`) —
// never a second matching rule — and reports what would happen, so the admin
// can attach knowingly, fix a typo, or say "different person" up front.
//
// `:organizationId` may be the provider practice the doctor is being added to
// OR the parent lab itself: matching is scoped per lab, and the "add practice"
// dialog previews its doctor rows before the practice exists. Lab-admin only.
router.post(
  "/:organizationId/doctors/match-preview",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    const callerId = (req as any).auth.userId as string;

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!org || org.deletedAt) {
      throw new HttpError(404, "Organization not found.");
    }

    let labId: string;
    let practiceId: string | null = null;
    if (org.type === "provider") {
      if (!org.parentLabOrganizationId) {
        throw new HttpError(400, "Practice has no parent lab.");
      }
      labId = org.parentLabOrganizationId;
      practiceId = org.id;
    } else if (org.type === "lab") {
      labId = org.id;
    } else {
      throw new HttpError(
        400,
        "Doctor matches can only be previewed for a lab or a provider practice."
      );
    }

    // Same gate as the add call — a preview leaks who a lab's doctors are.
    await requireAnyRole(callerId, labId, ADMIN_ROLES);

    const input = previewDoctorMatchesSchema.parse(req.body);

    type PreviewMatch = {
      index: number;
      userId: string;
      displayName: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      phone: string | null;
      platformAccountNumber: string | null;
      matchedOn: ProviderAccountMatchReason;
      similarity: number;
      practices: string[];
      alreadyMemberOfPractice: boolean;
    };

    const matches: PreviewMatch[] = [];
    // Rows whose typed email already belongs to an account the add call would
    // NOT attach to. The gate refuses those rows outright, so the preview has
    // to say "this will be rejected" rather than promise an attach. The owner
    // is never named: they may be outside this lab entirely.
    const emailConflicts: number[] = [];

    for (let i = 0; i < input.doctors.length; i++) {
      const d = input.doctors[i];
      const identity: DoctorIdentityInput = {
        firstName: d.firstName,
        lastName: d.lastName,
        doctorName: `${d.firstName} ${d.lastName}`.trim(),
        email: d.email || null,
        phone: d.phone || null,
      };
      // The resolver short-circuits an identity with nothing to match on
      // before it touches the database, so half-typed rows stay cheap.
      const match = await resolveExistingProviderAccount(db, identity, {
        labOrganizationId: labId,
        excludeUserIds: d.distinctFromUserIds,
      });

      // Mirrors the gate's ordering: email ownership is settled before the
      // resolver's answer is accepted.
      if (d.email) {
        const emailOwner = await findUserByEmail(db, d.email);
        if (emailOwner && emailOwner.id !== match?.user.id) {
          emailConflicts.push(i);
          continue;
        }
      }

      if (!match) continue;

      const u = match.user;
      matches.push({
        index: i,
        userId: u.id,
        displayName:
          (u.doctorName ?? "").trim() ||
          `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() ||
          u.username,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        phone: u.phone,
        platformAccountNumber: u.platformAccountNumber,
        matchedOn: match.matchedOn,
        similarity: match.similarity,
        practices: [],
        alreadyMemberOfPractice: false,
      });
    }

    // Annotate each match with where that account already practises. Sibling
    // practices under this lab are named; memberships elsewhere collapse to a
    // generic label so the preview never leaks another lab's practice names —
    // same rule the eligible-doctor picker follows.
    const matchedIds = Array.from(new Set(matches.map((m) => m.userId)));
    if (matchedIds.length > 0) {
      const memberships = await db
        .select({
          labId: organizationMemberships.labId,
          userId: organizationMemberships.userId,
        })
        .from(organizationMemberships)
        .where(
          and(
            inArray(organizationMemberships.userId, matchedIds),
            eq(organizationMemberships.status, "active"),
            notDeleted(organizationMemberships)
          )
        );
      const referencedIds = Array.from(
        new Set(memberships.map((m) => m.labId))
      );
      const referencedOrgs = referencedIds.length
        ? await db
            .select({
              id: organizations.id,
              name: organizations.name,
              displayName: organizations.displayName,
              type: organizations.type,
              parentLabOrganizationId: organizations.parentLabOrganizationId,
            })
            .from(organizations)
            .where(inArray(organizations.id, referencedIds))
        : [];
      const orgMap = new Map(referencedOrgs.map((o) => [o.id, o]));

      const labelsByUser = new Map<string, string[]>();
      const memberOfPractice = new Set<string>();
      for (const m of memberships) {
        if (practiceId && m.labId === practiceId) {
          memberOfPractice.add(m.userId);
        }
        const pr = orgMap.get(m.labId);
        if (!pr || pr.type !== "provider") continue;
        const label =
          pr.parentLabOrganizationId === labId
            ? pr.displayName || pr.name
            : "another lab";
        const arr = labelsByUser.get(m.userId) ?? [];
        if (!arr.includes(label)) arr.push(label);
        labelsByUser.set(m.userId, arr);
      }
      for (const m of matches) {
        m.practices = labelsByUser.get(m.userId) ?? [];
        m.alreadyMemberOfPractice = memberOfPractice.has(m.userId);
      }
    }

    return ok(res, { matches, emailConflicts });
  })
);

// List provider users who could be added to this practice as a doctor —
// every provider-type user platform-wide except those already active at
// *this* practice. (Per JP's request the picker should let a lab admin
// link a doctor regardless of whether the doctor is currently attached
// to one of the lab's sibling practices.) Lab-admin only.
router.get(
  "/:organizationId/eligible-doctors",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    const callerId = (req as any).auth.userId as string;

    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!practice || practice.deletedAt) {
      throw new HttpError(404, "Practice not found.");
    }
    if (practice.type !== "provider") {
      throw new HttpError(400, "Doctors only attach to provider practices.");
    }
    if (!practice.parentLabOrganizationId) {
      throw new HttpError(400, "Practice has no parent lab.");
    }
    await requireAnyRole(callerId, practice.parentLabOrganizationId, ADMIN_ROLES);

    // Doctors already active at THIS practice — those are the only users
    // we hide from the picker.
    const currentMembersRows = await db
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.labId, organizationId),
          eq(organizationMemberships.status, "active"),
          notDeleted(organizationMemberships)
        )
      );
    const currentMemberIds = new Set(currentMembersRows.map((m) => m.userId));

    // Provider-type accounts affiliated with THIS lab, minus current members.
    //
    // Scope (Task #4849): membership under this lab, or a place in its
    // Unassigned holding area. It is deliberately NOT every provider account
    // on the platform — this is a per-lab picker, and the database holds
    // other tenants' providers plus the automated-test accounts imported on
    // 2026-10-06. Linking a doctor's accounts across labs stays a separate
    // concern, handled by the account-link flow.
    const labProviderUsers = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        phone: users.phone,
        firstName: users.firstName,
        lastName: users.lastName,
        doctorName: users.doctorName,
        userType: users.userType,
        platformAccountNumber: users.platformAccountNumber,
      })
      .from(users)
      // Accounts retired by a duplicate consolidation (Task #4373) are
      // deactivated + soft-deleted; they must never come back through the
      // eligible-doctor picker.
      .where(
        and(
          eq(users.userType, "provider"),
          eq(users.isActive, true),
          notDeleted(users),
          labAffiliatedProviderAccountCondition(practice.parentLabOrganizationId)
        )
      );
    const eligibleUsers = labProviderUsers.filter(
      (u) => !currentMemberIds.has(u.id)
    );

    // Annotate each candidate with the practice(s) they're currently at
    // so the picker can show "Dr. Jane Smith — at Smile Dental" etc.
    // We only label sibling practices (under this lab's parent) by name;
    // memberships at other labs are surfaced as a generic
    // "another lab" badge so we don't leak unrelated practice names.
    const userToPractices = new Map<string, string[]>();
    if (eligibleUsers.length > 0) {
      const eligibleIds = eligibleUsers.map((u) => u.id);
      const allMemberships = await db
        .select({
          labId: organizationMemberships.labId,
          userId: organizationMemberships.userId,
        })
        .from(organizationMemberships)
        .where(
          and(
            inArray(organizationMemberships.userId, eligibleIds),
            eq(organizationMemberships.status, "active"),
            notDeleted(organizationMemberships)
          )
        );
      const referencedLabIds = Array.from(
        new Set(allMemberships.map((m) => m.labId))
      );
      const referencedOrgs = referencedLabIds.length
        ? await db
            .select({
              id: organizations.id,
              name: organizations.name,
              displayName: organizations.displayName,
              parentLabOrganizationId: organizations.parentLabOrganizationId,
              type: organizations.type,
            })
            .from(organizations)
            .where(inArray(organizations.id, referencedLabIds))
        : [];
      const orgMap = new Map(referencedOrgs.map((o) => [o.id, o]));
      for (const m of allMemberships) {
        if (m.labId === organizationId) continue;
        const pr = orgMap.get(m.labId);
        if (!pr) continue;
        const isSibling =
          pr.type === "provider" &&
          pr.parentLabOrganizationId === practice.parentLabOrganizationId;
        const label = isSibling
          ? pr.displayName || pr.name
          : "another lab";
        const arr = userToPractices.get(m.userId) ?? [];
        if (!arr.includes(label)) arr.push(label);
        userToPractices.set(m.userId, arr);
      }
    }

    const realDoctors = eligibleUsers
      .map((u) => ({
        ...u,
        currentPractices: userToPractices.get(u.id) ?? [],
        virtual: false as const,
        doctorName: null as string | null,
        sourceOrganizationId: null as string | null,
        sourcePracticeName: null as string | null,
        caseCount: 0,
      }))
      .sort((a, b) => {
        const an = `${a.lastName ?? ""} ${a.firstName ?? ""}`.trim().toLowerCase();
        const bn = `${b.lastName ?? ""} ${b.firstName ?? ""}`.trim().toLowerCase();
        return an.localeCompare(bn);
      });

    // Virtual doctors: doctorName values from this lab's cases that don't
    // already have a formal provider account, grouped by the source practice
    // that currently holds those cases. Shown in the picker so the lab admin
    // can formally create an account AND move the doctor's existing cases into
    // the target practice without leaving the dialog. Each source practice
    // yields its own row (carrying that practice's id, name, and case count)
    // so the add call knows exactly which cases to move. All source practices
    // live under this same lab, so naming them here leaks nothing cross-lab.
    const caseDoctorRows = await db
      .select({
        doctorName: cases.doctorName,
        providerOrganizationId: cases.providerOrganizationId,
        caseCount: sql<number>`count(*)::int`,
      })
      .from(cases)
      .where(
        and(
          eq(cases.labOrganizationId, practice.parentLabOrganizationId),
          isNotNull(cases.doctorName),
          notDeleted(cases)
        )
      )
      .groupBy(cases.doctorName, cases.providerOrganizationId);

    // A case-history name only counts as "virtual" when no provider account
    // already covers it. Compare on the shared normalized form so "Dr. Jane
    // A. Smith" and "Jane Smith" are recognised as the same doctor and the
    // picker stops offering a name that would only be adopted back onto the
    // existing account (Task #4372).
    //
    // This pool is the resolver's MATCHING scope, not the listing scope
    // above: adopting the name runs resolveExistingProviderAccount, so a
    // name it would reuse must not be offered as new even when the account
    // it would reuse is unaffiliated and therefore not itself listed.
    const matchableProviderNames = await db
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
        doctorName: users.doctorName,
      })
      .from(users)
      .where(
        and(
          eq(users.userType, "provider"),
          eq(users.isActive, true),
          notDeleted(users),
          labMatchableProviderAccountCondition(practice.parentLabOrganizationId)
        )
      );
    const existingProviderNames = new Set(
      matchableProviderNames
        .flatMap((u) => [
          `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim(),
          u.doctorName ?? "",
        ])
        .map((n) => normalizeDoctorForCompare(n))
        .filter((n) => n.length > 0)
    );

    // Resolve source practice display names for the case-history rows.
    const virtualSourceIds = Array.from(
      new Set(
        caseDoctorRows
          .map((c) => c.providerOrganizationId)
          .filter((id): id is string => !!id)
      )
    );
    const virtualSourceOrgs = virtualSourceIds.length
      ? await db
          .select({
            id: organizations.id,
            name: organizations.name,
            displayName: organizations.displayName,
          })
          .from(organizations)
          .where(inArray(organizations.id, virtualSourceIds))
      : [];
    const virtualSourceNameMap = new Map(
      virtualSourceOrgs.map((o) => [o.id, o.displayName || o.name])
    );

    const virtualDoctors = caseDoctorRows
      .filter(
        (c) =>
          c.doctorName &&
          c.doctorName.trim() &&
          !existingProviderNames.has(normalizeDoctorForCompare(c.doctorName))
      )
      .map((c) => {
        const nm = c.doctorName as string;
        const srcId = c.providerOrganizationId ?? null;
        return {
          id: srcId ? `virtual:${srcId}:${nm}` : `virtual::${nm}`,
          username: nm,
          email: null as string | null,
          phone: null as string | null,
          firstName: null as string | null,
          lastName: null as string | null,
          userType: "provider" as const,
          platformAccountNumber: null as string | null,
          currentPractices: [] as string[],
          virtual: true as const,
          doctorName: nm,
          sourceOrganizationId: srcId,
          sourcePracticeName: srcId
            ? virtualSourceNameMap.get(srcId) ?? null
            : null,
          caseCount: Number(c.caseCount ?? 0),
        };
      })
      .sort(
        (a, b) =>
          a.doctorName.localeCompare(b.doctorName) ||
          (a.sourcePracticeName ?? "").localeCompare(b.sourcePracticeName ?? "")
      );

    return ok(res, [...realDoctors, ...virtualDoctors]);
  })
);

// Link an existing provider user as an active member of this practice.
// Used by the "Add doctor → pick existing" flow so a doctor who already
// has a LabTrax account at one of the lab's other practices can be
// attached without spawning a duplicate user account. Lab-admin only.
const linkExistingDoctorSchema = z.object({
  userId: z.string().min(1),
});

router.post(
  "/:organizationId/doctors/link",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    const callerId = (req as any).auth.userId as string;

    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!practice || practice.deletedAt) {
      throw new HttpError(404, "Practice not found.");
    }
    if (practice.type !== "provider") {
      throw new HttpError(400, "Doctors only attach to provider practices.");
    }
    if (!practice.parentLabOrganizationId) {
      throw new HttpError(400, "Practice has no parent lab.");
    }
    await requireAnyRole(callerId, practice.parentLabOrganizationId, ADMIN_ROLES);

    const { userId } = linkExistingDoctorSchema.parse(req.body);

    const targetUser = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!targetUser) throw new HttpError(404, "User not found.");
    if (targetUser.userType !== "provider") {
      throw new HttpError(
        400,
        "Only provider-type users can be linked as doctors."
      );
    }

    // No sibling-practice gate — the picker (eligible-doctors) lists all
    // provider users on the platform, so a lab admin can attach any
    // existing doctor to one of their practices without first having to
    // re-create the account. The `requireAnyRole` check above already
    // ensures the caller actually administers this practice's parent lab.

    // Look up any pre-existing row (including soft-deleted) so we can
    // either 409 on a live duplicate or restore a soft-deleted row in
    // place rather than spawning a parallel one.
    const existing = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.labId, organizationId),
        eq(organizationMemberships.userId, userId)
      ),
    });
    if (existing && existing.status === "active" && !existing.deletedAt) {
      throw new HttpError(
        409,
        "Doctor is already a member of this practice."
      );
    }

    let membership;
    if (existing) {
      [membership] = await db
        .update(organizationMemberships)
        .set({
          status: "active",
          role: existing.role || "user",
          approvedByUserId: callerId,
          joinedAt: new Date(),
          deletedAt: null,
          deletedByUserId: null,
        })
        .where(eq(organizationMemberships.id, existing.id))
        .returning();
    } else {
      [membership] = await db
        .insert(organizationMemberships)
        .values({
          labId: organizationId,
          userId,
          role: "user",
          status: "active",
          approvedByUserId: callerId,
          joinedAt: new Date(),
        })
        .returning();
    }

    await writeAuditLog({
      req,
      organizationId,
      action: "practice_doctor_linked",
      entityType: "user",
      entityId: userId,
      afterJson: {
        userId,
        username: targetUser.username,
        email: targetUser.email,
        membershipId: membership.id,
      },
    });

    return ok(
      res,
      {
        userId,
        membershipId: membership.id,
        firstName: targetUser.firstName,
        lastName: targetUser.lastName,
        email: targetUser.email,
        platformAccountNumber: targetUser.platformAccountNumber,
      },
      201
    );
  })
);

// ---------------------------------------------------------------------------
// Remove a doctor from a practice (detach — never delete) + reassignment +
// the per-lab "Unassigned doctors" holding area. (Task #2359.)
//
// ---------------------------------------------------------------------------
// Provider practice assignments
//
// A provider login can belong to several provider organizations under the
// same lab. These memberships are the authorization source for the provider
// portal; account numbers remain properties of the individual practices.
// ---------------------------------------------------------------------------

const doctorPracticeAssignmentsQuerySchema = z.object({
  providerOrgId: z.string().min(1),
  userId: z.string().min(1),
});

const updateDoctorPracticeAssignmentsSchema = z.object({
  providerOrgId: z.string().min(1),
  userId: z.string().min(1),
  practiceOrganizationIds: z.array(z.string().min(1)).max(200),
});

function pickCurrentDoctorMembership<
  T extends {
    status: string;
    deletedAt: Date | null;
    updatedAt?: Date | null;
    createdAt?: Date | null;
  },
>(memberships: T[]): T | undefined {
  const active = memberships.find(
    (membership) =>
      membership.status === "active" && !membership.deletedAt,
  );
  if (active) return active;
  return [...memberships].sort((a, b) => {
    const aTime =
      a.deletedAt?.getTime() ??
      a.updatedAt?.getTime() ??
      a.createdAt?.getTime() ??
      0;
    const bTime =
      b.deletedAt?.getTime() ??
      b.updatedAt?.getTime() ??
      b.createdAt?.getTime() ??
      0;
    return bTime - aTime;
  })[0];
}

async function resolveDoctorAssignmentContext(
  labId: string,
  providerOrgId: string,
  userId: string,
  callerId: string,
) {
  const lab = await db.query.organizations.findFirst({
    where: eq(organizations.id, labId),
  });
  if (!lab || lab.deletedAt || lab.type !== "lab") {
    throw new HttpError(404, "Lab not found.");
  }
  await requireAnyRole(callerId, labId, ADMIN_ROLES);

  const sourcePractice = await db.query.organizations.findFirst({
    where: eq(organizations.id, providerOrgId),
  });
  if (!sourcePractice) throw new HttpError(404, "Practice not found.");
  if (
    sourcePractice.type !== "provider" ||
    sourcePractice.parentLabOrganizationId !== labId
  ) {
    throw new HttpError(400, "Practice must belong to this lab.");
  }

  const targetUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!targetUser) throw new HttpError(404, "Provider user not found.");
  if (targetUser.userType !== "provider") {
    throw new HttpError(400, "Only provider users can have practice assignments.");
  }

  // Include removed/soft-deleted memberships so an assignment can be restored
  // and so an admin can finish an edit after another session removed the link.
  const sourceMemberships = await db.query.organizationMemberships.findMany({
    where: and(
      eq(organizationMemberships.labId, providerOrgId),
      eq(organizationMemberships.userId, userId),
    ),
  });
  const membership = pickCurrentDoctorMembership(sourceMemberships);
  if (!membership) {
    throw new HttpError(
      404,
      "This provider login is not associated with the selected practice.",
    );
  }

  return { sourcePractice, userId: membership.userId };
}

async function loadDoctorPracticeAssignments(labId: string, userId: string) {
  const practices = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      displayName: organizations.displayName,
      accountNumber: organizations.accountNumber,
    })
    .from(organizations)
    .where(
      and(
        eq(organizations.type, "provider"),
        eq(organizations.parentLabOrganizationId, labId),
        notDeleted(organizations),
      ),
    );
  const memberships = await db.query.organizationMemberships.findMany({
    where: eq(organizationMemberships.userId, userId),
  });
  const membershipByPractice = new Map<string, (typeof memberships)[number]>();
  for (const practice of practices) {
    const current = pickCurrentDoctorMembership(
      memberships.filter(
        (membership) => membership.labId === practice.id,
      ),
    );
    if (current) membershipByPractice.set(practice.id, current);
  }

  return practices
    .map((practice) => {
      const membership = membershipByPractice.get(practice.id);
      const active =
        !!membership &&
        membership.status === "active" &&
        !membership.deletedAt;
      return {
        practiceOrganizationId: practice.id,
        practiceName: practice.displayName || practice.name,
        accountNumber: practice.accountNumber,
        membershipId: membership?.id ?? null,
        status: active ? "active" : "available",
        assigned: active,
      };
    })
    .sort((a, b) => a.practiceName.localeCompare(b.practiceName));
}

router.get(
  "/:labId/doctors/assignments",
  asyncHandler(async (req, res) => {
    const { providerOrgId, userId } = doctorPracticeAssignmentsQuerySchema.parse(
      req.query,
    );
    await resolveDoctorAssignmentContext(
      req.params.labId,
      providerOrgId,
      userId,
      (req as any).auth.userId,
    );
    return ok(res, {
      userId,
      providerOrgId,
      assignments: await loadDoctorPracticeAssignments(req.params.labId, userId),
    });
  }),
);

router.put(
  "/:labId/doctors/assignments",
  asyncHandler(async (req, res) => {
    const labId = req.params.labId;
    const callerId = (req as any).auth.userId as string;
    const input = updateDoctorPracticeAssignmentsSchema.parse(req.body);
    const selectedIds = Array.from(new Set(input.practiceOrganizationIds));
    const { sourcePractice, userId } = await resolveDoctorAssignmentContext(
      labId,
      input.providerOrgId,
      input.userId,
      callerId,
    );
    if (!selectedIds.includes(sourcePractice.id)) {
      throw new HttpError(
        400,
        "The customer’s own practice must remain assigned.",
        { code: "SOURCE_PRACTICE_REQUIRED" },
      );
    }

    const selectedPractices = selectedIds.length
      ? await db
          .select({
            id: organizations.id,
            name: organizations.name,
            displayName: organizations.displayName,
            accountNumber: organizations.accountNumber,
            deletedAt: organizations.deletedAt,
            parentLabOrganizationId: organizations.parentLabOrganizationId,
            type: organizations.type,
          })
          .from(organizations)
          .where(inArray(organizations.id, selectedIds))
      : [];
    const selectedById = new Map(
      selectedPractices.map((practice) => [practice.id, practice]),
    );
    const unknown = selectedIds.filter((id) => !selectedById.has(id));
    if (unknown.length > 0) {
      throw new HttpError(
        400,
        "One or more selected practices could not be found.",
        { code: "UNKNOWN_PRACTICE", practiceOrganizationIds: unknown },
      );
    }
    const archived = selectedPractices.filter((practice) => !!practice.deletedAt);
    if (archived.length > 0) {
      throw new HttpError(
        400,
        `Archived practices cannot be assigned: ${archived
          .map((practice) => practice.displayName || practice.name)
          .join(", ")}.`,
        { code: "ARCHIVED_PRACTICE" },
      );
    }
    if (
      selectedPractices.some(
        (practice) =>
          practice.type !== "provider" ||
          practice.parentLabOrganizationId !== labId,
      )
    ) {
      throw new HttpError(
        400,
        "Selected practices must be provider practices in this lab.",
        { code: "PRACTICE_OUTSIDE_LAB" },
      );
    }

    const accountOwners = new Map<string, string>();
    for (const practice of selectedPractices) {
      for (const segment of parseAccountNumbers(practice.accountNumber)) {
        const previous = accountOwners.get(segment);
        if (previous && previous !== practice.id) {
          throw new HttpError(
            409,
            `Account number '${segment}' belongs to more than one selected practice.`,
            { code: "DUPLICATE_ACCOUNT_NUMBER", accountNumber: segment },
          );
        }
        accountOwners.set(segment, practice.id);
      }
    }

    await db.transaction(async (tx) => {
      const labPractices = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.type, "provider"),
            eq(organizations.parentLabOrganizationId, labId),
          ),
        );
      const labPracticeIds = new Set(labPractices.map((practice) => practice.id));
      const memberships = await tx.query.organizationMemberships.findMany({
        where: and(
          eq(organizationMemberships.userId, userId),
          inArray(organizationMemberships.labId, Array.from(labPracticeIds)),
        ),
      });
      const membershipByPractice = new Map<
        string,
        (typeof memberships)[number]
      >();
      for (const practiceId of labPracticeIds) {
        const current = pickCurrentDoctorMembership(
          memberships.filter(
            (membership) => membership.labId === practiceId,
          ),
        );
        if (current) membershipByPractice.set(practiceId, current);
      }
      const now = new Date();

      for (const practiceId of labPracticeIds) {
        const existing = membershipByPractice.get(practiceId);
        if (selectedIds.includes(practiceId)) {
          if (existing) {
            await tx
              .update(organizationMemberships)
              .set({
                status: "active",
                role: existing.role || "user",
                approvedByUserId: callerId,
                joinedAt: now,
                deletedAt: null,
                deletedByUserId: null,
              })
              .where(eq(organizationMemberships.id, existing.id));
          } else {
            await tx.insert(organizationMemberships).values({
              labId: practiceId,
              userId,
              role: "user",
              status: "active",
              approvedByUserId: callerId,
              joinedAt: now,
            });
          }
        } else if (
          existing &&
          existing.status === "active" &&
          !existing.deletedAt
        ) {
          await tx
            .update(organizationMemberships)
            .set({
              status: "removed",
              deletedAt: now,
              deletedByUserId: callerId,
            })
            .where(eq(organizationMemberships.id, existing.id));
        }
      }

      const unassigned = await tx.query.labUnassignedDoctors.findFirst({
        where: and(
          eq(labUnassignedDoctors.labOrganizationId, labId),
          eq(labUnassignedDoctors.userId, userId),
        ),
      });
      if (selectedIds.length > 0) {
        await tx
          .update(labUnassignedDoctors)
          .set({ deletedAt: now })
          .where(
            and(
              eq(labUnassignedDoctors.labOrganizationId, labId),
              eq(labUnassignedDoctors.userId, userId),
              isNull(labUnassignedDoctors.deletedAt),
            ),
          );
      } else if (unassigned) {
        await tx
          .update(labUnassignedDoctors)
          .set({
            removedFromOrganizationId: sourcePractice.id,
            removedAt: now,
            removedByUserId: callerId,
            deletedAt: null,
          })
          .where(eq(labUnassignedDoctors.id, unassigned.id));
      } else {
        await tx.insert(labUnassignedDoctors).values({
          labOrganizationId: labId,
          userId,
          removedFromOrganizationId: sourcePractice.id,
          removedAt: now,
          removedByUserId: callerId,
        });
      }
    });

    await writeAuditLog({
      req,
      organizationId: labId,
      action: "provider_practice_assignments_updated",
      entityType: "user",
      entityId: userId,
      afterJson: {
        userId,
        sourcePracticeId: sourcePractice.id,
        practiceOrganizationIds: selectedIds,
      },
    });

    return ok(res, {
      userId,
      providerOrgId: input.providerOrgId,
      assignments: await loadDoctorPracticeAssignments(labId, userId),
    });
  }),
);

// Detaching a doctor drops their active membership at the source practice but
// keeps the user account. They land either in another practice (reassign) or
// in the per-lab `lab_unassigned_doctors` holding area. The caller chooses,
// every time, whether the doctor's existing cases/invoices stay with the old
// practice ("leave") or follow the doctor to the destination ("move"). Moving
// is only possible when reassigning to a destination in the same step — a
// doctor sent to Unassigned always leaves their cases behind. Virtual
// (name-only) doctors are promoted to a real provider account first. Every
// removal/reassignment writes an audit-log entry. Lab-admin only.
// ---------------------------------------------------------------------------

const removeDoctorSchema = z.object({
  // Real provider user id. Omit/null for a virtual (name-only) doctor.
  userId: z.string().min(1).nullable().optional(),
  // The doctor's display name used to match their cases/invoices. Required for
  // virtual doctors; optional override for real ones (defaults to the user's
  // own doctorName).
  doctorName: z.string().trim().min(1).optional(),
  // When supplied, the doctor is reassigned to this practice instead of being
  // sent to the Unassigned holding area. Must be a sibling practice under the
  // same lab.
  destinationOrganizationId: z.string().min(1).nullable().optional(),
  // What to do with the doctor's existing cases/invoices. "move" is only
  // honoured when a destination is supplied; sending to Unassigned forces
  // "leave".
  existingCases: z.enum(["leave", "move"]).default("leave"),
});

// Resolve the case/invoice-matching name for a provider user.
function doctorMatchName(u: {
  doctorName: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  return (
    (u.doctorName && u.doctorName.trim()) ||
    `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim()
  );
}

// Clear a per-lab "Unassigned doctors" exclusion so the doctor is no longer
// held out of the lab's active roster. Name-only holding entries are matched
// by normalized name, account-backed ones by user id.
async function clearUnassignedHolding(
  tx: any,
  labId: string,
  target: { userId?: string | null; doctorName?: string | null }
): Promise<void> {
  if (target.userId) {
    await tx
      .update(labUnassignedDoctors)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(labUnassignedDoctors.labOrganizationId, labId),
          eq(labUnassignedDoctors.userId, target.userId),
          isNull(labUnassignedDoctors.deletedAt)
        )
      );
  }
  const name = target.doctorName?.trim();
  if (name) {
    await tx
      .update(labUnassignedDoctors)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(labUnassignedDoctors.labOrganizationId, labId),
          isNull(labUnassignedDoctors.userId),
          sql`lower(${labUnassignedDoctors.doctorName}) = lower(${name})`,
          isNull(labUnassignedDoctors.deletedAt)
        )
      );
  }
}

// Move a doctor's cases + invoices from one practice to another inside a
// transaction. Returns the counts moved.
async function moveDoctorCasesAndInvoices(
  tx: any,
  labId: string,
  matchName: string,
  fromPracticeId: string,
  toPracticeId: string
): Promise<{ casesMoved: number; invoicesMoved: number; caseIds: string[] }> {
  const matchedCases = await tx
    .select({ id: cases.id })
    .from(cases)
    .where(
      and(
        eq(cases.labOrganizationId, labId),
        eq(cases.providerOrganizationId, fromPracticeId),
        sql`lower(${cases.doctorName}) = lower(${matchName})`
      )
    );
  const caseIds = matchedCases.map((c: { id: string }) => c.id);
  if (caseIds.length > 0) {
    await tx
      .update(cases)
      .set({ providerOrganizationId: toPracticeId })
      .where(inArray(cases.id, caseIds));
  }

  // Invoices have no doctorName of their own — an invoice belongs to a doctor
  // through its case. Move exactly the invoices tied to the cases we moved.
  let invoicesMoved = 0;
  if (caseIds.length > 0) {
    const matchedInvoices = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.labOrganizationId, labId),
          eq(invoices.providerOrganizationId, fromPracticeId),
          inArray(invoices.caseId, caseIds)
        )
      );
    const invoiceIds = matchedInvoices.map((i: { id: string }) => i.id);
    if (invoiceIds.length > 0) {
      await tx
        .update(invoices)
        .set({ providerOrganizationId: toPracticeId })
        .where(inArray(invoices.id, invoiceIds));
    }
    invoicesMoved = invoiceIds.length;
  }

  return { casesMoved: caseIds.length, invoicesMoved, caseIds };
}

// Create or restore an active membership for a user at a practice inside a
// transaction (mirrors the doctors/link restore-in-place behaviour).
async function ensureMembership(
  tx: any,
  practiceId: string,
  userId: string,
  callerId: string
): Promise<string> {
  const existing = await tx.query.organizationMemberships.findFirst({
    where: and(
      eq(organizationMemberships.labId, practiceId),
      eq(organizationMemberships.userId, userId)
    ),
  });
  if (existing) {
    const [m] = await tx
      .update(organizationMemberships)
      .set({
        status: "active",
        role: existing.role || "user",
        approvedByUserId: callerId,
        joinedAt: new Date(),
        deletedAt: null,
        deletedByUserId: null,
      })
      .where(eq(organizationMemberships.id, existing.id))
      .returning();
    return m.id;
  }
  const [m] = await tx
    .insert(organizationMemberships)
    .values({
      labId: practiceId,
      userId,
      role: "user",
      status: "active",
      approvedByUserId: callerId,
      joinedAt: new Date(),
    })
    .returning();
  return m.id;
}

// ---------------------------------------------------------------------------
// Adopt a case-history (virtual, name-only) doctor into a provider practice.
// (Task #2688.)
//
// When a lab admin picks a case-history doctor in the "Add doctor" dialog, this
// must make the addition actually stick: create or reuse the provider account,
// create/restore an active membership at the destination practice, MOVE that
// doctor's existing cases + invoices from the source practice into the
// destination (mirroring the remove/reassign "move" behaviour), clear any
// per-lab "Unassigned doctors" exclusion, and write an audit entry — all in one
// transaction. A matching provider account is reused rather than duplicated.
//
// If the doctor's cases span more than one source practice and the caller did
// not name one explicitly, we 409 so the caller can disambiguate. Lab-admin
// only.
// ---------------------------------------------------------------------------
const adoptCaseHistoryDoctorSchema = z.object({
  doctorName: z.string().trim().min(1),
  sourceOrganizationId: z.string().min(1).nullable().optional(),
});

router.post(
  "/:organizationId/doctors/adopt",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    const callerId = (req as any).auth.userId as string;

    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!practice || practice.deletedAt) {
      throw new HttpError(404, "Practice not found.");
    }
    if (practice.type !== "provider") {
      throw new HttpError(400, "Doctors only attach to provider practices.");
    }
    if (!practice.parentLabOrganizationId) {
      throw new HttpError(400, "Practice has no parent lab.");
    }
    const labId = practice.parentLabOrganizationId;
    await requireAnyRole(callerId, labId, ADMIN_ROLES);

    const input = adoptCaseHistoryDoctorSchema.parse(req.body);
    const name = input.doctorName.trim();

    // Discover which source practice(s) currently hold this doctor's cases in
    // this lab so we know where to move them from.
    const sourceRows = await db
      .select({
        providerOrganizationId: cases.providerOrganizationId,
        caseCount: sql<number>`count(*)::int`,
      })
      .from(cases)
      .where(
        and(
          eq(cases.labOrganizationId, labId),
          sql`lower(${cases.doctorName}) = lower(${name})`,
          isNotNull(cases.providerOrganizationId),
          notDeleted(cases)
        )
      )
      .groupBy(cases.providerOrganizationId);

    const sourceIds = sourceRows
      .map((r) => r.providerOrganizationId)
      .filter((id): id is string => !!id);

    let sourceOrganizationId: string | null = null;
    if (input.sourceOrganizationId) {
      // Caller named a source practice. If this doctor actually has cases
      // somewhere, the named source must be one of those practices — otherwise
      // the move would silently no-op (casesMoved=0) and the doctor's history
      // would fail to "stick". Reject a stale/incorrect source loudly.
      if (sourceIds.length > 0 && !sourceIds.includes(input.sourceOrganizationId)) {
        throw new HttpError(
          409,
          "This doctor has no cases at the chosen practice. Choose a practice that holds their case history.",
          { code: "INVALID_SOURCE_PRACTICE", sources: sourceIds }
        );
      }
      sourceOrganizationId = input.sourceOrganizationId;
    } else if (sourceIds.length === 1) {
      sourceOrganizationId = sourceIds[0];
    } else if (sourceIds.length > 1) {
      throw new HttpError(
        409,
        "This doctor has cases at more than one practice. Choose which practice to move them from.",
        { code: "MULTIPLE_SOURCE_PRACTICES", sources: sourceIds }
      );
    }
    // sourceIds.length === 0 → no cases to move; still create the account +
    // membership so the doctor formally belongs to the destination practice.

    const result = await db.transaction(async (tx) => {
      // The gate reuses the doctor's existing account whenever one resolves —
      // including name variants such as a "Dr." prefix or a middle initial —
      // and only promotes the name-only doctor into a fresh account (with a
      // fresh account number) when they genuinely have none.
      const gate = await createProviderAccountThroughGate({
        runner: tx,
        trigger: "lab_created_account",
        actorUserId: callerId,
        labOrganizationId: labId,
        organizationId,
        identity: { doctorName: name },
        practice: { name: practice.name, displayName: practice.displayName },
      });
      const user = gate.user;
      const createdNewAccount = gate.outcome === "created";
      const matchedOn = gate.outcome === "reused" ? gate.matchedOn : null;

      const membershipId = await ensureMembership(
        tx,
        organizationId,
        user.id,
        callerId
      );

      let casesMoved = 0;
      let invoicesMoved = 0;
      let movedCaseIds: string[] = [];
      if (sourceOrganizationId && sourceOrganizationId !== organizationId) {
        const moved = await moveDoctorCasesAndInvoices(
          tx,
          labId,
          name,
          sourceOrganizationId,
          organizationId
        );
        casesMoved = moved.casesMoved;
        invoicesMoved = moved.invoicesMoved;
        movedCaseIds = moved.caseIds;
      }

      // Clear any per-lab "Unassigned doctors" exclusion (account-backed or
      // name-only) so the doctor is no longer held out of the active roster.
      await clearUnassignedHolding(tx, labId, {
        userId: user.id,
        doctorName: name,
      });

      return {
        user,
        membershipId,
        createdNewAccount,
        matchedOn,
        casesMoved,
        invoicesMoved,
        movedCaseIds,
      };
    });

    for (const caseId of result.movedCaseIds) broadcastCaseUpdated(caseId, "doctor_adopted");

    await writeAuditLog({
      req,
      organizationId,
      action: "practice_doctor_adopted_from_history",
      entityType: "user",
      entityId: result.user.id,
      afterJson: {
        userId: result.user.id,
        doctorName: name,
        sourcePracticeId: sourceOrganizationId,
        destinationPracticeId: organizationId,
        membershipId: result.membershipId,
        createdNewAccount: result.createdNewAccount,
        reusedExistingAccount: !result.createdNewAccount,
        matchedOn: result.matchedOn,
        casesMoved: result.casesMoved,
        invoicesMoved: result.invoicesMoved,
      },
    });

    return ok(
      res,
      {
        userId: result.user.id,
        membershipId: result.membershipId,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        email: result.user.email,
        platformAccountNumber: result.user.platformAccountNumber,
        createdNewAccount: result.createdNewAccount,
        matchedOn: result.matchedOn,
        sourcePracticeId: sourceOrganizationId,
        casesMoved: result.casesMoved,
        invoicesMoved: result.invoicesMoved,
      },
      201
    );
  })
);

router.post(
  "/:organizationId/doctors/remove",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    const callerId = (req as any).auth.userId as string;

    const practice = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!practice || practice.deletedAt) {
      throw new HttpError(404, "Practice not found.");
    }
    if (practice.type !== "provider") {
      throw new HttpError(400, "Doctors only attach to provider practices.");
    }
    if (!practice.parentLabOrganizationId) {
      throw new HttpError(400, "Practice has no parent lab.");
    }
    const labId = practice.parentLabOrganizationId;
    await requireAnyRole(callerId, labId, ADMIN_ROLES);

    const input = removeDoctorSchema.parse(req.body);

    // Resolve the destination practice (if reassigning). Must be a sibling
    // provider practice under the same lab and not the source itself.
    let destination: { id: string; name: string; displayName: string | null } | null =
      null;
    if (input.destinationOrganizationId) {
      if (input.destinationOrganizationId === organizationId) {
        throw new HttpError(
          400,
          "Destination practice must differ from the current practice."
        );
      }
      const dest = await db.query.organizations.findFirst({
        where: eq(organizations.id, input.destinationOrganizationId),
      });
      if (!dest || dest.deletedAt) {
        throw new HttpError(404, "Destination practice not found.");
      }
      if (
        dest.type !== "provider" ||
        dest.parentLabOrganizationId !== labId
      ) {
        throw new HttpError(
          400,
          "Destination practice must be under the same lab."
        );
      }
      destination = {
        id: dest.id,
        name: dest.name,
        displayName: dest.displayName,
      };
    }

    // Sending to Unassigned always leaves cases behind.
    const movecases = destination !== null && input.existingCases === "move";

    const result = await db.transaction(async (tx) => {
      // 1. Resolve the doctor → an existing account when they have one.
      //    Removing a doctor must NEVER create an account or an account
      //    number (Task #4372): a name-only doctor with no existing account
      //    is recorded by name instead.
      let user: {
        id: string;
        username: string;
        firstName: string | null;
        lastName: string | null;
        email: string | null;
        phone: string | null;
        doctorName: string | null;
        platformAccountNumber: string | null;
      } | null = null;
      let matchedOn: ProviderAccountMatchReason | null = null;
      // Whether the resolved doctor is a real provider-type account. The
      // Unassigned holding area is a provider-doctor concept, so a
      // non-provider member is detached without a holding-area record.
      let isProviderUser = true;

      if (input.userId) {
        const u = await tx.query.users.findFirst({
          where: eq(users.id, input.userId),
        });
        if (!u) throw new HttpError(404, "Doctor account not found.");
        if (u.userType !== "provider") {
          // The Doctors list shows every active member of the practice, not
          // just provider-type accounts. A non-provider member can therefore
          // be offered a Remove button. Allow removing them as long as they
          // are (or were) a member of THIS practice — never an arbitrary,
          // unrelated user account.
          const membership = await tx.query.organizationMemberships.findFirst({
            where: and(
              eq(organizationMemberships.labId, organizationId),
              eq(organizationMemberships.userId, u.id)
            ),
          });
          if (!membership) {
            throw new HttpError(404, "Doctor account not found.");
          }
          isProviderUser = false;
        }
        user = u;
      } else {
        const name = input.doctorName?.trim();
        if (!name) {
          throw new HttpError(
            400,
            "A doctor name is required to remove a name-only doctor."
          );
        }
        // Reuse the doctor's account when they already have one (including
        // "Dr." prefix / middle-initial variants). Otherwise they stay
        // account-less — the removal is recorded by name.
        const match = await resolveExistingProviderAccount(
          tx,
          { doctorName: name },
          { labOrganizationId: labId }
        );
        if (match) {
          user = { ...match.user, doctorName: match.user.doctorName ?? null };
          matchedOn = match.matchedOn;
        }
      }

      const matchName =
        input.doctorName?.trim() || (user ? doctorMatchName(user) : "");

      // 2. Drop the active membership at the source practice (a name-only
      //    doctor with no account never had one).
      if (user) {
        const existing = await tx.query.organizationMemberships.findFirst({
          where: and(
            eq(organizationMemberships.labId, organizationId),
            eq(organizationMemberships.userId, user.id),
            isNull(organizationMemberships.deletedAt)
          ),
        });
        if (existing) {
          await tx
            .update(organizationMemberships)
            .set({
              status: "removed",
              deletedAt: new Date(),
              deletedByUserId: callerId,
            })
            .where(eq(organizationMemberships.id, existing.id));
        }
      }

      let casesMoved = 0;
      let invoicesMoved = 0;
      let movedCaseIds: string[] = [];

      if (destination) {
        // 3a. Reassign: optionally move cases/invoices, then attach the
        //     doctor at the destination practice. A doctor with no account
        //     can only be reassigned by moving their cases — there is no
        //     membership to create, and creating an account to carry one is
        //     exactly what this flow must not do.
        if (movecases || !user) {
          const moved = await moveDoctorCasesAndInvoices(
            tx,
            labId,
            matchName,
            organizationId,
            destination.id
          );
          casesMoved = moved.casesMoved;
          invoicesMoved = moved.invoicesMoved;
          movedCaseIds = moved.caseIds;
        }
        if (user) await ensureMembership(tx, destination.id, user.id, callerId);
        // If the doctor was previously unassigned, clear that record.
        await clearUnassignedHolding(tx, labId, {
          userId: user?.id ?? null,
          doctorName: matchName,
        });
      } else if (isProviderUser) {
        // 3b. Unassigned: upsert the holding-area record (cases stay put).
        // Only provider-type doctors land in the Unassigned holding area —
        // a non-provider member is simply detached (membership dropped above)
        // and never appears in the per-lab Unassigned list. A doctor with no
        // account is held by name.
        const existing = user
          ? await tx.query.labUnassignedDoctors.findFirst({
              where: and(
                eq(labUnassignedDoctors.labOrganizationId, labId),
                eq(labUnassignedDoctors.userId, user.id)
              ),
            })
          : await tx.query.labUnassignedDoctors.findFirst({
              where: and(
                eq(labUnassignedDoctors.labOrganizationId, labId),
                isNull(labUnassignedDoctors.userId),
                sql`lower(${labUnassignedDoctors.doctorName}) = lower(${matchName})`
              ),
            });
        if (existing) {
          await tx
            .update(labUnassignedDoctors)
            .set({
              doctorName: matchName || existing.doctorName,
              removedFromOrganizationId: organizationId,
              removedAt: new Date(),
              removedByUserId: callerId,
              deletedAt: null,
            })
            .where(eq(labUnassignedDoctors.id, existing.id));
        } else {
          await tx.insert(labUnassignedDoctors).values({
            labOrganizationId: labId,
            userId: user?.id ?? null,
            doctorName: matchName || null,
            removedFromOrganizationId: organizationId,
            removedByUserId: callerId,
          });
        }
      }

      return {
        user,
        matchedOn,
        matchName,
        casesMoved,
        invoicesMoved,
        movedCaseIds,
      };
    });

    for (const caseId of result.movedCaseIds) {
      broadcastCaseUpdated(caseId, destination ? "doctor_reassigned" : "doctor_removed");
    }

    await writeAuditLog({
      req,
      organizationId: labId,
      action: destination
        ? "practice_doctor_reassigned"
        : "practice_doctor_removed",
      entityType: "user",
      entityId: result.user?.id ?? organizationId,
      afterJson: {
        userId: result.user?.id ?? null,
        doctorName: result.matchName,
        sourcePracticeId: organizationId,
        destinationPracticeId: destination?.id ?? null,
        existingCases: movecases ? "move" : "leave",
        casesMoved: result.casesMoved,
        invoicesMoved: result.invoicesMoved,
        // Removal never creates an account. Either the doctor's existing
        // account was resolved, or the removal was recorded by name alone.
        promotedFromVirtual: false,
        reusedExistingAccount: result.matchedOn !== null,
        matchedOn: result.matchedOn,
      },
    });

    return ok(res, {
      userId: result.user?.id ?? null,
      // Retained for API compatibility; removal no longer promotes anyone.
      promotedFromVirtual: false,
      reusedExistingAccount: result.matchedOn !== null,
      matchedOn: result.matchedOn,
      platformAccountNumber: result.user?.platformAccountNumber ?? null,
      doctorName: result.matchName,
      destinationPracticeId: destination?.id ?? null,
      casesMoved: result.casesMoved,
      invoicesMoved: result.invoicesMoved,
      unassigned: destination === null,
    });
  })
);

// List the per-lab "Unassigned doctors" holding area. Lab-admin only.
router.get(
  "/:labId/unassigned-doctors",
  asyncHandler(async (req, res) => {
    const labId = req.params.labId;
    const callerId = (req as any).auth.userId as string;

    const lab = await db.query.organizations.findFirst({
      where: eq(organizations.id, labId),
    });
    if (!lab || lab.deletedAt) throw new HttpError(404, "Lab not found.");
    if (lab.type !== "lab") {
      throw new HttpError(400, "Unassigned doctors are tracked per lab.");
    }
    await requireAnyRole(callerId, labId, ADMIN_ROLES);

    // LEFT JOIN: a name-only doctor removed from a practice is held here
    // without an account (removing a doctor never creates one).
    const rows = await db
      .select({
        id: labUnassignedDoctors.id,
        userId: labUnassignedDoctors.userId,
        entryDoctorName: labUnassignedDoctors.doctorName,
        removedFromOrganizationId:
          labUnassignedDoctors.removedFromOrganizationId,
        removedAt: labUnassignedDoctors.removedAt,
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        doctorName: users.doctorName,
        email: users.email,
        phone: users.phone,
        platformAccountNumber: users.platformAccountNumber,
      })
      .from(labUnassignedDoctors)
      .leftJoin(
        users,
        and(eq(users.id, labUnassignedDoctors.userId), notDeleted(users))
      )
      .where(
        and(
          eq(labUnassignedDoctors.labOrganizationId, labId),
          isNull(labUnassignedDoctors.deletedAt),
          // Hide holding entries whose account was retired by a duplicate
          // consolidation (Task #4373) — the survivor's entry covers them.
          sql`(${labUnassignedDoctors.userId} is null or exists (
            select 1 from users u
            where u.id = ${labUnassignedDoctors.userId}
              and u.deleted_at is null
          ))`
        )
      )
      .orderBy(desc(labUnassignedDoctors.removedAt));

    const practiceIds = Array.from(
      new Set(rows.map((r) => r.removedFromOrganizationId))
    );
    const practiceRows = practiceIds.length
      ? await db
          .select({
            id: organizations.id,
            name: organizations.name,
            displayName: organizations.displayName,
          })
          .from(organizations)
          .where(inArray(organizations.id, practiceIds))
      : [];
    const practiceMap = new Map(practiceRows.map((p) => [p.id, p]));

    return ok(
      res,
      rows.map((r) => {
        const pr = practiceMap.get(r.removedFromOrganizationId);
        const { entryDoctorName, ...rest } = r;
        return {
          ...rest,
          // Name-only entries carry their name on the holding row itself.
          doctorName: r.doctorName ?? entryDoctorName ?? null,
          username: r.username ?? entryDoctorName ?? null,
          hasAccount: r.userId !== null,
          removedFromPracticeName: pr
            ? pr.displayName || pr.name
            : null,
        };
      })
    );
  })
);

// Reassign an unassigned doctor to a practice. Lab-admin only.
const reassignUnassignedSchema = z
  .object({
    labOrganizationId: z.string().min(1),
    // Account-backed entry. Omit for a name-only entry (a doctor removed
    // without an account — removal never creates one).
    userId: z.string().min(1).nullable().optional(),
    // Required for a name-only entry; identifies the holding row by name.
    doctorName: z.string().trim().min(1).optional(),
    destinationOrganizationId: z.string().min(1),
    existingCases: z.enum(["leave", "move"]).default("leave"),
  })
  .refine((v) => !!v.userId || !!v.doctorName, {
    message: "Provide the doctor's account id or their name.",
    path: ["userId"],
  });

router.post(
  "/unassigned-doctors/reassign",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const input = reassignUnassignedSchema.parse(req.body);
    const labId = input.labOrganizationId;

    const lab = await db.query.organizations.findFirst({
      where: eq(organizations.id, labId),
    });
    if (!lab || lab.deletedAt) throw new HttpError(404, "Lab not found.");
    if (lab.type !== "lab") {
      throw new HttpError(400, "Unassigned doctors are tracked per lab.");
    }
    await requireAnyRole(callerId, labId, ADMIN_ROLES);

    const dest = await db.query.organizations.findFirst({
      where: eq(organizations.id, input.destinationOrganizationId),
    });
    if (!dest || dest.deletedAt) {
      throw new HttpError(404, "Destination practice not found.");
    }
    if (dest.type !== "provider" || dest.parentLabOrganizationId !== labId) {
      throw new HttpError(
        400,
        "Destination practice must be under the same lab."
      );
    }

    const user = input.userId
      ? await db.query.users.findFirst({ where: eq(users.id, input.userId) })
      : null;
    if (input.userId && !user) {
      throw new HttpError(404, "Doctor account not found.");
    }

    const matchName = user
      ? doctorMatchName(user)
      : (input.doctorName ?? "").trim();

    const result = await db.transaction(async (tx) => {
      // Name-only entries (a doctor removed without an account) are keyed by
      // their name instead of a user id.
      const unassigned = user
        ? await tx.query.labUnassignedDoctors.findFirst({
            where: and(
              eq(labUnassignedDoctors.labOrganizationId, labId),
              eq(labUnassignedDoctors.userId, user.id),
              isNull(labUnassignedDoctors.deletedAt)
            ),
          })
        : await tx.query.labUnassignedDoctors.findFirst({
            where: and(
              eq(labUnassignedDoctors.labOrganizationId, labId),
              isNull(labUnassignedDoctors.userId),
              sql`lower(${labUnassignedDoctors.doctorName}) = lower(${matchName})`,
              isNull(labUnassignedDoctors.deletedAt)
            ),
          });
      if (!unassigned) {
        throw new HttpError(404, "Doctor is not in the Unassigned list.");
      }

      let casesMoved = 0;
      let invoicesMoved = 0;
      let movedCaseIds: string[] = [];
      // A doctor with no account has nothing but their cases to move, so a
      // reassignment moves them rather than creating an account to carry a
      // membership.
      if (input.existingCases === "move" || !user) {
        const moved = await moveDoctorCasesAndInvoices(
          tx,
          labId,
          matchName,
          unassigned.removedFromOrganizationId,
          dest.id
        );
        casesMoved = moved.casesMoved;
        invoicesMoved = moved.invoicesMoved;
        movedCaseIds = moved.caseIds;
      }

      if (user) await ensureMembership(tx, dest.id, user.id, callerId);

      await tx
        .update(labUnassignedDoctors)
        .set({ deletedAt: new Date() })
        .where(eq(labUnassignedDoctors.id, unassigned.id));

      return {
        casesMoved,
        invoicesMoved,
        movedCaseIds,
        sourcePracticeId: unassigned.removedFromOrganizationId,
      };
    });

    for (const caseId of result.movedCaseIds) broadcastCaseUpdated(caseId, "doctor_reassigned");

    await writeAuditLog({
      req,
      organizationId: labId,
      action: "unassigned_doctor_reassigned",
      entityType: "user",
      entityId: user?.id ?? labId,
      afterJson: {
        userId: user?.id ?? null,
        doctorName: matchName,
        sourcePracticeId: result.sourcePracticeId,
        destinationPracticeId: dest.id,
        existingCases: input.existingCases,
        casesMoved: result.casesMoved,
        invoicesMoved: result.invoicesMoved,
      },
    });

    return ok(res, {
      userId: user?.id ?? null,
      doctorName: matchName,
      destinationPracticeId: dest.id,
      casesMoved: result.casesMoved,
      invoicesMoved: result.invoicesMoved,
    });
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    // Opt-in mode: in addition to orgs the caller is a member of, also return
    // provider practices whose parentLabOrganizationId is one of the labs the
    // caller administers. This realigns list visibility with the duplicate-name
    // check on create (which is scoped to the parent lab, NOT to membership), so
    // a practice that can block creation is also findable/selectable. The
    // default (no flag) stays membership-only so Settings → Organizations is
    // unchanged.
    const includeLabPractices = req.query.includeLabPractices === "true";
    const memberships =
      await db.query.organizationMemberships.findMany({
        where: eq(
          organizationMemberships.userId,
          (req as any).auth.userId
        ),
        columns: {
          labId: true,
          role: true,
          status: true,
        },
      });
    const activeMemberships = memberships.filter(
      (m: any) => m.status === "active"
    );
    const orgIdSet = new Set<string>(
      activeMemberships.map((m: any) => m.labId)
    );

    if (includeLabPractices) {
      // Labs the caller administers (active admin/owner membership in a
      // type = "lab" org). Mirrors the parent-lab pattern used by
      // GET /:labId/providers.
      const adminMembershipOrgIds = activeMemberships
        .filter((m: any) => ADMIN_ROLES.includes(m.role as MembershipRole))
        .map((m: any) => m.labId);
      if (adminMembershipOrgIds.length) {
        const adminOrgs = await db
          .select({ id: organizations.id, type: organizations.type })
          .from(organizations)
          .where(inArray(organizations.id, adminMembershipOrgIds));
        const adminLabIds = adminOrgs
          .filter((o: any) => o.type === "lab")
          .map((o: any) => o.id);
        if (adminLabIds.length) {
          // Collect every provider practice under the administered labs.
          // Soft-delete filtering is deferred to the final select so the
          // includeArchived semantics apply uniformly to all ids.
          const labPractices = await db
            .select({ id: organizations.id })
            .from(organizations)
            .where(
              and(
                inArray(
                  organizations.parentLabOrganizationId,
                  adminLabIds
                ),
                eq(organizations.type, "provider")
              )
            );
          for (const p of labPractices) orgIdSet.add(p.id);
        }
      }
    }

    const orgIds = Array.from(orgIdSet);
    const orgs = orgIds.length
      ? await db
          .select(organizationListColumns)
          .from(organizations)
          .where(
            includeArchived
              ? inArray(organizations.id, orgIds)
              : and(
                  inArray(organizations.id, orgIds),
                  notDeleted(organizations)
                )
          )
      : [];
    return ok(res, orgs);
  })
);

router.get(
  "/invites/pending-for-me",
  asyncHandler(async (req, res) => {
    const currentEmail = (req as any).user.email?.toLowerCase?.().trim?.();
    if (!currentEmail) {
      return ok(res, []);
    }

    const pendingInvites = await db.query.organizationInvites.findMany({
      where: and(
        eq(organizationInvites.email, currentEmail),
        eq(organizationInvites.status, "pending")
      ),
    });

    // Lazily expire any past-TTL invites and drop them from the result so the
    // invitee never sees (or can act on) an expired invitation.
    const invites = (
      await Promise.all(
        pendingInvites.map((invite) => expireInviteIfNeeded(invite, req))
      )
    ).filter((invite) => invite.status === "pending");

    const organizationIds = [...new Set(invites.map((invite) => invite.labId))];
    const inviterIds = [...new Set(invites.map((invite) => invite.invitedByUserId))].filter(
      (id): id is string => id !== null
    );

    const inviteOrganizations = organizationIds.length
      ? await db
          .select()
          .from(organizations)
          .where(inArray(organizations.id, organizationIds))
      : [];
    const inviters = inviterIds.length
      ? await db.select().from(users).where(inArray(users.id, inviterIds))
      : [];

    const organizationsById = new Map(
      inviteOrganizations.map((organization) => [organization.id, organization])
    );
    const invitersById = new Map(inviters.map((inviter) => [inviter.id, inviter]));

    return ok(
      res,
      invites.map((invite) => ({
        ...invite,
        organizationId: invite.labId,
        organization: organizationsById.get(invite.labId) ?? null,
        invitedByUser: invitersById.get(invite.invitedByUserId as string)
          ? {
              id: invitersById.get(invite.invitedByUserId as string)!.id,
              username: invitersById.get(invite.invitedByUserId as string)!.username,
              email: invitersById.get(invite.invitedByUserId as string)!.email,
            }
          : null,
      }))
    );
  })
);

// NOTE: must be declared before the dynamic GET /:organizationId route below,
// otherwise Express will match "/connections" as an organization id.
router.get(
  "/connections",
  asyncHandler(async (req, res) => {
    const userId = (req as any).auth.userId;
    const labFilter = req.query.labOrganizationId as string | undefined;
    const providerFilter = req.query.providerOrganizationId as
      | string
      | undefined;

    const memberships = await db.query.organizationMemberships.findMany({
      where: and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active")
      ),
    });
    const memberOrgIds = memberships.map((m) => m.labId);
    if (memberOrgIds.length === 0) return ok(res, []);

    const allConnections =
      await db.query.organizationConnections.findMany({});
    let connections = allConnections.filter(
      (c) =>
        memberOrgIds.includes(c.labOrganizationId) ||
        memberOrgIds.includes(c.providerOrganizationId)
    );
    if (labFilter)
      connections = connections.filter(
        (c) => c.labOrganizationId === labFilter
      );
    if (providerFilter)
      connections = connections.filter(
        (c) => c.providerOrganizationId === providerFilter
      );

    const orgIds = [
      ...new Set(
        connections.flatMap((c) => [
          c.labOrganizationId,
          c.providerOrganizationId,
        ])
      ),
    ];
    const orgs = orgIds.length
      ? await db
          .select()
          .from(organizations)
          .where(inArray(organizations.id, orgIds))
      : [];
    const orgsById = new Map(orgs.map((o) => [o.id, o]));

    return ok(
      res,
      connections.map((c) => ({
        ...c,
        labOrganization: orgsById.get(c.labOrganizationId) ?? null,
        providerOrganization:
          orgsById.get(c.providerOrganizationId) ?? null,
      }))
    );
  })
);

const sharedAccountRelationshipSchema = z
  .object({
    labOrganizationId: z.string().uuid(),
    providerOrganizationId: z.string().uuid(),
  })
  .strict();

const nullableContactValue = z
  .union([z.string().max(500), z.null()])
  .transform((value) =>
    typeof value === "string" && value.trim() === "" ? null : value,
  );

const sharedAccountChangeSchema = sharedAccountRelationshipSchema
  .extend({
    changes: z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        displayName: nullableContactValue.optional(),
        billingEmail: z
          .union([z.string().email().max(320), z.null()])
          .optional(),
        phone: nullableContactValue.optional(),
        addressLine1: nullableContactValue.optional(),
        addressLine2: nullableContactValue.optional(),
        city: nullableContactValue.optional(),
        state: nullableContactValue.optional(),
        zip: nullableContactValue.optional(),
      })
      .strict(),
    clientRequestId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

function safeAccountChangeRequest(
  request: typeof providerAccountChangeRequests.$inferSelect,
) {
  return {
    id: request.id,
    labOrganizationId: request.labOrganizationId,
    providerOrganizationId: request.providerOrganizationId,
    requestedByOrganizationId: request.requestedByOrganizationId,
    requestedByUserId: request.requestedByUserId,
    source: request.source,
    status: request.status,
    changes: request.changesJson,
    reviewedByUserId: request.reviewedByUserId,
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

router.get(
  "/shared-accounts",
  asyncHandler(async (req, res) => {
    const input = sharedAccountRelationshipSchema.parse(req.query);
    const callerId = (req as any).auth.userId as string;
    await assertProviderCallerSelection(req, input.providerOrganizationId);
    const { provider } = await getSharedProviderRelationship(
      callerId,
      input.labOrganizationId,
      input.providerOrganizationId,
    );
    const requests = await db
      .select()
      .from(providerAccountChangeRequests)
      .where(
        and(
          eq(
            providerAccountChangeRequests.labOrganizationId,
            input.labOrganizationId,
          ),
          eq(
            providerAccountChangeRequests.providerOrganizationId,
            input.providerOrganizationId,
          ),
        ),
      )
      .orderBy(desc(providerAccountChangeRequests.createdAt));

    let card = await getCachedSharedCardSummary(input.providerOrganizationId);
    try {
      const stripe = await getUncachableStripeClient();
      if (stripe) {
        const refreshed = await refreshSharedCardSummary(
          input.providerOrganizationId,
          stripe,
        );
        card = refreshed.card;
        if (refreshed.changed) {
          await writeAuditLog({
            req,
            organizationId: input.labOrganizationId,
            action: "provider_shared_card_refreshed",
            entityType: "provider_payment_customer",
            entityId: input.providerOrganizationId,
            beforeJson: refreshed.previous,
            afterJson: refreshed.card,
            metadataJson: {
              labOrganizationId: input.labOrganizationId,
              providerOrganizationId: input.providerOrganizationId,
            },
          });
        }
      }
    } catch {
      // Stripe outages do not hide the last processor-safe summary.
    }

    return ok(res, {
      relationship: {
        labOrganizationId: input.labOrganizationId,
        providerOrganizationId: input.providerOrganizationId,
      },
      contact: {
        ...sharedProviderContact(provider),
        source: "provider_organization",
        updatedAt: provider.updatedAt.toISOString(),
      },
      card,
      profileChangeRequests: requests.map(safeAccountChangeRequest),
    });
  }),
);

router.post(
  "/shared-accounts/profile-change-requests",
  asyncHandler(async (req, res) => {
    const input = sharedAccountChangeSchema.parse(req.body);
    const callerId = (req as any).auth.userId as string;
    await assertProviderCallerSelection(req, input.providerOrganizationId);
    const relationship = await getSharedProviderRelationship(
      callerId,
      input.labOrganizationId,
      input.providerOrganizationId,
      true,
    );
    const baseline = sharedProviderContact(relationship.provider);
    const changes = Object.fromEntries(
      Object.entries(input.changes).filter(
        ([field, value]) =>
          SHARED_PROVIDER_CONTACT_FIELDS.includes(
            field as SharedProviderContactField,
          ) && baseline[field as SharedProviderContactField] !== value,
      ),
    );
    if (Object.keys(changes).length === 0) {
      throw new HttpError(400, "No profile or contact changes were provided.");
    }
    const requestFingerprint = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          labOrganizationId: input.labOrganizationId,
          providerOrganizationId: input.providerOrganizationId,
          requestedByOrganizationId: relationship.actingOrganizationId,
          baseline,
          changes,
        }),
      )
      .digest("hex");

    const [created] = await db
      .insert(providerAccountChangeRequests)
      .values({
        labOrganizationId: input.labOrganizationId,
        providerOrganizationId: input.providerOrganizationId,
        requestedByOrganizationId: relationship.actingOrganizationId,
        requestedByUserId: callerId,
        source: relationship.source,
        changesJson: changes,
        baselineJson: baseline,
        requestFingerprint,
        clientRequestId: input.clientRequestId ?? null,
      })
      .onConflictDoNothing()
      .returning();

    let request:
      | typeof providerAccountChangeRequests.$inferSelect
      | undefined = created;
    if (!request) {
      request =
        (input.clientRequestId
          ? await db.query.providerAccountChangeRequests.findFirst({
              where: and(
                eq(
                  providerAccountChangeRequests.labOrganizationId,
                  input.labOrganizationId,
                ),
                eq(
                  providerAccountChangeRequests.providerOrganizationId,
                  input.providerOrganizationId,
                ),
                eq(
                  providerAccountChangeRequests.clientRequestId,
                  input.clientRequestId,
                ),
              ),
            })
          : null) ??
        (await db.query.providerAccountChangeRequests.findFirst({
          where: and(
            eq(
              providerAccountChangeRequests.labOrganizationId,
              input.labOrganizationId,
            ),
            eq(
              providerAccountChangeRequests.providerOrganizationId,
              input.providerOrganizationId,
            ),
            eq(
              providerAccountChangeRequests.requestFingerprint,
              requestFingerprint,
            ),
            eq(providerAccountChangeRequests.status, "pending"),
          ),
        }));
      if (!request || request.requestFingerprint !== requestFingerprint) {
        throw new HttpError(
          409,
          "That request id was already used for a different change.",
        );
      }
    }

    if (created) {
      await writeAuditLog({
        req,
        organizationId: input.labOrganizationId,
        action: "provider_account_change_requested",
        entityType: "provider_account_change_request",
        entityId: request.id,
        beforeJson: baseline,
        afterJson: changes,
        metadataJson: {
          source: request.source,
          providerOrganizationId: input.providerOrganizationId,
        },
      });
      const counterpartOrganizationId =
        relationship.actingOrganizationId === input.labOrganizationId
          ? input.providerOrganizationId
          : input.labOrganizationId;
      await notifySharedAccountCounterpart({
        labOrganizationId: input.labOrganizationId,
        providerOrganizationId: input.providerOrganizationId,
        recipientOrganizationId: counterpartOrganizationId,
        requestId: request.id,
        type: "provider_account_change_requested",
        title: "Provider account update needs review",
        body: "The connected account proposed profile or contact changes for this practice.",
      });
    }
    return ok(res, safeAccountChangeRequest(request), created ? 201 : 200);
  }),
);

async function loadAccountChangeForReview(requestId: string) {
  const request = await db.query.providerAccountChangeRequests.findFirst({
    where: eq(providerAccountChangeRequests.id, requestId),
  });
  if (!request) throw new HttpError(404, "Profile change request not found.");
  return request;
}

async function requireAccountChangeReviewer(
  userId: string,
  request: typeof providerAccountChangeRequests.$inferSelect,
) {
  if (request.requestedByUserId === userId) {
    throw new HttpError(
      403,
      "A profile change must be reviewed by a different administrator.",
    );
  }
  const counterpartOrganizationId =
    request.requestedByOrganizationId === request.labOrganizationId
      ? request.providerOrganizationId
      : request.labOrganizationId;
  await requireAnyRole(userId, counterpartOrganizationId, ADMIN_ROLES);
  return counterpartOrganizationId;
}

router.post(
  "/shared-accounts/profile-change-requests/:requestId/approve",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const existing = await loadAccountChangeForReview(req.params.requestId);
    await assertProviderCallerSelection(req, existing.providerOrganizationId);
    const reviewerOrganizationId = await requireAccountChangeReviewer(
      callerId,
      existing,
    );
    if (existing.status === "approved") {
      return ok(res, safeAccountChangeRequest(existing));
    }
    if (existing.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot approve a request that is already ${existing.status}.`,
      );
    }

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM organizations WHERE id = ${existing.providerOrganizationId} FOR UPDATE`,
      );
      const [currentProvider] = await tx
        .select()
        .from(organizations)
        .where(
          and(
            eq(organizations.id, existing.providerOrganizationId),
            eq(
              organizations.parentLabOrganizationId,
              existing.labOrganizationId,
            ),
            isNull(organizations.deletedAt),
          ),
        )
        .limit(1);
      if (!currentProvider) {
        throw new HttpError(404, "Provider relationship not found.");
      }
      if (
        !sameSharedProviderContact(
          sharedProviderContact(currentProvider),
          existing.baselineJson as Record<string, unknown>,
        )
      ) {
        const [stale] = await tx
          .update(providerAccountChangeRequests)
          .set({
            status: "stale",
            reviewedByUserId: callerId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(providerAccountChangeRequests.id, existing.id),
              eq(providerAccountChangeRequests.status, "pending"),
            ),
          )
          .returning();
        return { kind: "stale" as const, request: stale ?? existing };
      }

      const [claimed] = await tx
        .update(providerAccountChangeRequests)
        .set({
          status: "approved",
          reviewedByUserId: callerId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(providerAccountChangeRequests.id, existing.id),
            eq(providerAccountChangeRequests.status, "pending"),
          ),
        )
        .returning();
      if (!claimed) {
        return { kind: "conflict" as const, request: existing };
      }
      const [provider] = await tx
        .update(organizations)
        .set({
          ...(existing.changesJson as Partial<
            typeof organizations.$inferInsert
          >),
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, existing.providerOrganizationId))
        .returning();
      return { kind: "approved" as const, request: claimed, provider };
    });

    if (outcome.kind === "conflict") {
      throw new HttpError(409, "Profile change request was already decided.");
    }
    await writeAuditLog({
      req,
      organizationId: existing.labOrganizationId,
      action:
        outcome.kind === "stale"
          ? "provider_account_change_stale"
          : "provider_account_change_approved",
      entityType: "provider_account_change_request",
      entityId: existing.id,
      beforeJson: existing.baselineJson,
      afterJson:
        outcome.kind === "approved"
          ? sharedProviderContact(outcome.provider)
          : existing.changesJson,
      metadataJson: {
        reviewerOrganizationId,
        providerOrganizationId: existing.providerOrganizationId,
      },
    });
    if (outcome.kind === "stale") {
      await notifySharedAccountCounterpart({
        labOrganizationId: existing.labOrganizationId,
        providerOrganizationId: existing.providerOrganizationId,
        recipientOrganizationId: existing.requestedByOrganizationId,
        requestId: existing.id,
        type: "provider_account_change_decided",
        title: "Provider account update is out of date",
        body: "The provider profile changed before this proposal was reviewed. Submit a new request from the current profile.",
      });
      throw new HttpError(
        409,
        "The provider profile changed after this request was created. Submit a new request.",
      );
    }
    await syncUsersToOrganization(
      existing.providerOrganizationId,
      outcome.provider,
    );
    await notifySharedAccountCounterpart({
      labOrganizationId: existing.labOrganizationId,
      providerOrganizationId: existing.providerOrganizationId,
      recipientOrganizationId: existing.requestedByOrganizationId,
      requestId: existing.id,
      type: "provider_account_change_decided",
      title: "Provider account update approved",
      body: "The connected account approved the proposed profile or contact changes.",
    });
    return ok(res, safeAccountChangeRequest(outcome.request));
  }),
);

router.post(
  "/shared-accounts/profile-change-requests/:requestId/reject",
  asyncHandler(async (req, res) => {
    const callerId = (req as any).auth.userId as string;
    const existing = await loadAccountChangeForReview(req.params.requestId);
    await assertProviderCallerSelection(req, existing.providerOrganizationId);
    const reviewerOrganizationId = await requireAccountChangeReviewer(
      callerId,
      existing,
    );
    if (existing.status === "rejected") {
      return ok(res, safeAccountChangeRequest(existing));
    }
    if (existing.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot reject a request that is already ${existing.status}.`,
      );
    }
    const [updated] = await db
      .update(providerAccountChangeRequests)
      .set({
        status: "rejected",
        reviewedByUserId: callerId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerAccountChangeRequests.id, existing.id),
          eq(providerAccountChangeRequests.status, "pending"),
        ),
      )
      .returning();
    if (!updated) {
      throw new HttpError(409, "Profile change request was already decided.");
    }
    await writeAuditLog({
      req,
      organizationId: existing.labOrganizationId,
      action: "provider_account_change_rejected",
      entityType: "provider_account_change_request",
      entityId: existing.id,
      beforeJson: existing.baselineJson,
      afterJson: existing.changesJson,
      metadataJson: {
        reviewerOrganizationId,
        providerOrganizationId: existing.providerOrganizationId,
      },
    });
    await notifySharedAccountCounterpart({
      labOrganizationId: existing.labOrganizationId,
      providerOrganizationId: existing.providerOrganizationId,
      recipientOrganizationId: existing.requestedByOrganizationId,
      requestId: existing.id,
      type: "provider_account_change_decided",
      title: "Provider account update declined",
      body: "The connected account declined the proposed profile or contact changes.",
    });
    return ok(res, safeAccountChangeRequest(updated));
  }),
);

// List provider practices for a lab. Member-level (any active member of
// the lab) so the mobile Rx review screen can show a browsable, tappable
// practice picker — no admin gate and no minimum-character search. Scoped
// to the caller's own lab via requireMembership, so it cannot disclose
// another tenant's practices. Unlike the admin-only, cases-derived
// /api/doctors/search, this reads the organizations table directly, so
// practices created inline (with no cases yet) still appear. Soft-deleted
// practices are excluded.
router.get(
  "/:labId/providers",
  asyncHandler(async (req, res) => {
    const labId = req.params.labId;
    const userId = (req as any).auth.userId as string;

    await requireMembership(userId, labId);

    const lab = await db.query.organizations.findFirst({
      where: eq(organizations.id, labId),
    });
    if (!lab || lab.deletedAt) throw new HttpError(404, "Lab not found.");

    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        displayName: organizations.displayName,
        phone: organizations.phone,
        addressLine1: organizations.addressLine1,
        city: organizations.city,
        state: organizations.state,
        zip: organizations.zip,
        accountNumber: organizations.accountNumber,
        platformAccountNumber: organizations.platformAccountNumber,
      })
      .from(organizations)
      .where(
        and(
          eq(organizations.parentLabOrganizationId, labId),
          eq(organizations.type, "provider"),
          notDeleted(organizations)
        )
      );

    rows.sort((a, b) =>
      (a.displayName || a.name).localeCompare(b.displayName || b.name)
    );

    return ok(res, { providers: rows });
  })
);

router.get(
  "/:organizationId",
  asyncHandler(async (req, res) => {
    const access = await resolveOrgReadAccess(
      (req as any).auth.userId,
      req.params.organizationId
    );
    const organization =
      access.organization ??
      (await db.query.organizations.findFirst({
        where: eq(organizations.id, req.params.organizationId),
      }));
    if (!organization) throw new HttpError(404, "Organization not found.");
    const additionalEmails = await db
      .select({
        id: organizationAdditionalEmails.id,
        email: organizationAdditionalEmails.email,
        type: organizationAdditionalEmails.type,
      })
      .from(organizationAdditionalEmails)
      .where(eq(organizationAdditionalEmails.organizationId, organization.id));
    return ok(res, { ...organization, additionalEmails });
  })
);

// ── Additional emails sub-resource ──────────────────────────────────────────

const additionalEmailSchema = z.object({
  email: z.string().email("Must be a valid email address."),
  type: z.enum(["billing", "correspondence"], {
    error: 'Type must be "billing" or "correspondence".',
  }),
});

router.post(
  "/:organizationId/additional-emails",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);
    const { email, type } = additionalEmailSchema.parse(req.body);
    const [row] = await db
      .insert(organizationAdditionalEmails)
      .values({ organizationId, email, type })
      .returning();
    return ok(res, row);
  })
);

router.delete(
  "/:organizationId/additional-emails/:emailId",
  asyncHandler(async (req, res) => {
    const { organizationId, emailId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);
    const existing = await db.query.organizationAdditionalEmails.findFirst({
      where: and(
        eq(organizationAdditionalEmails.id, emailId),
        eq(organizationAdditionalEmails.organizationId, organizationId)
      ),
    });
    if (!existing) throw new HttpError(404, "Additional email not found.");
    await db
      .delete(organizationAdditionalEmails)
      .where(
        and(
          eq(organizationAdditionalEmails.id, emailId),
          eq(organizationAdditionalEmails.organizationId, organizationId)
        )
      );
    return ok(res, { deleted: true });
  })
);

router.patch(
  "/:organizationId",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    const access = await resolveOrgAdminAccess(
      (req as any).auth.userId,
      organizationId
    );
    const input = updateOrgSchema.parse(req.body);

    const existing =
      access.organization ??
      (await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
      }));
    if (!existing) throw new HttpError(404, "Organization not found.");
    if (
      existing.type !== "lab" &&
      input.printProviderPreferencesOnLabSlips !== undefined
    ) {
      throw new HttpError(
        400,
        "Provider preference printing can only be configured for lab organizations.",
      );
    }

    const includesSharedContactChange = SHARED_PROVIDER_CONTACT_FIELDS.some(
      (field) => input[field] !== undefined,
    );
    if (
      existing.type === "provider" &&
      existing.parentLabOrganizationId &&
      includesSharedContactChange
    ) {
      throw new HttpError(
        409,
        "Provider contact changes require counterpart approval. Use the shared-account change request endpoint.",
      );
    }

    // If the caller is changing the account number, validate format and
    // lab-scoped uniqueness. We only allow this for orgs that have a parent
    // lab (i.e. provider orgs created under a lab); other orgs ignore the
    // field on PATCH.
    let nextAccountNumber: string | null | undefined = undefined;
    if (input.accountNumber !== undefined) {
      if (!existing.parentLabOrganizationId) {
        throw new HttpError(
          400,
          "Account numbers are only supported on provider practices created under a lab."
        );
      }
      const trimmed = (input.accountNumber ?? "").trim();
      if (!trimmed) {
        nextAccountNumber = null;
      } else if (trimmed === existing.accountNumber) {
        nextAccountNumber = existing.accountNumber;
      }
      // Otherwise nextAccountNumber stays undefined; resolved inside the lock.
    }

    const { accountNumber: _accountNumberInput, ...rest } = input;
    const updateValues: Record<string, unknown> = { ...rest };
    if (nextAccountNumber !== undefined) {
      updateValues.accountNumber = nextAccountNumber;
    }

    // When the account number is actually changing, wrap the uniqueness check
    // and the update in a per-lab advisory lock transaction so no concurrent
    // request can interleave and claim the same segment between check and write.
    const accountNumberIsChanging =
      input.accountNumber !== undefined &&
      existing.parentLabOrganizationId &&
      nextAccountNumber === undefined; // only unresolved cases reach here

    let updated: typeof organizations.$inferSelect;
    if (accountNumberIsChanging && existing.parentLabOrganizationId) {
      const trimmed = (input.accountNumber ?? "").trim();
      updated = await withAccountNumberLock(
        existing.parentLabOrganizationId,
        async (client) => {
          const validated = await assertCustomAccountNumberAvailable(
            existing.parentLabOrganizationId!,
            trimmed,
            existing.id,
            client
          );
          const [row] = await (client as any)
            .update(organizations)
            .set({ ...updateValues, accountNumber: validated })
            .where(eq(organizations.id, organizationId))
            .returning();
          return row as typeof organizations.$inferSelect;
        }
      );
    } else {
      const [row] = await db
        .update(organizations)
        .set(updateValues)
        .where(eq(organizations.id, organizationId))
        .returning();
      updated = row;
    }

    await syncUsersToOrganization(organizationId, updated);

    await writeAuditLog({
      req,
      organizationId,
      action: "organization_updated",
      entityType: "organization",
      entityId: organizationId,
      beforeJson: existing,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

router.post(
  "/:organizationId/archive",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    const access = await resolveOrgAdminAccess(
      (req as any).auth.userId,
      organizationId
    );
    const existing =
      access.organization ??
      (await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
      }));
    if (!existing) throw new HttpError(404, "Organization not found.");
    if (existing.type !== "provider") {
      throw new HttpError(
        400,
        "Only provider practices can be archived from this endpoint."
      );
    }
    if (existing.deletedAt) {
      return ok(res, existing);
    }

    await softDeleteById({
      table: organizations,
      id: organizationId,
      actorUserId: (req as any).auth.userId,
      req,
      organizationId,
      entityType: "organization",
      beforeJson: existing,
    });

    const [updated] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return ok(res, updated);
  })
);

router.post(
  "/:organizationId/restore",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    // Look up the org without filtering deleted rows so we can restore it.
    const existing = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!existing) throw new HttpError(404, "Organization not found.");

    // Authorize via the parent lab for provider practices, or direct admin
    // membership otherwise. resolveOrgAdminAccess already handles both, but
    // we call it on the parent for archived provider rows so the caller
    // can still authorize even if the org row is hidden by future filters.
    if (existing.parentLabOrganizationId) {
      await resolveOrgAdminAccess(
        (req as any).auth.userId,
        existing.parentLabOrganizationId
      );
    } else {
      await resolveOrgAdminAccess(
        (req as any).auth.userId,
        organizationId
      );
    }

    if (!existing.deletedAt) {
      return ok(res, existing);
    }

    await restoreDeleted({
      table: organizations,
      where: eq(organizations.id, organizationId),
      actorUserId: (req as any).auth.userId,
      req,
      organizationId,
      entityType: "organization",
      entityId: organizationId,
    });

    const [updated] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return ok(res, updated);
  })
);

router.get(
  "/:organizationId/members",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    // Allow the org's own members AND a parent-lab admin to read a provider
    // practice's roster (resolveOrgReadAccess handles both, 404s an unknown
    // org, and 403s a caller with no access).
    await resolveOrgReadAccess((req as any).auth.userId, organizationId);

    const memberships =
      await db.query.organizationMemberships.findMany({
        where: and(
          eq(organizationMemberships.labId, organizationId),
          eq(organizationMemberships.status, "active"),
          notDeleted(organizationMemberships)
        ),
      });
    const userIds = memberships.map((m: any) => m.userId);
    const allUsers = userIds.length
      ? await db.query.users.findMany({
          // Retired duplicate accounts (Task #4373) are soft-deleted; their
          // memberships must not hydrate into the members list.
          where: and(inArray(users.id, userIds), notDeleted(users)),
        })
      : [];

    return ok(
      res,
      memberships.map((membership: any) => ({
        ...membership,
        user: allUsers.find((user) => user.id === membership.userId)
          ? {
              id: allUsers.find((user) => user.id === membership.userId)!.id,
              username: allUsers.find((user) => user.id === membership.userId)!
                .username,
              email: allUsers.find((user) => user.id === membership.userId)!
                .email,
              firstName: allUsers.find((user) => user.id === membership.userId)!
                .firstName,
              lastName: allUsers.find((user) => user.id === membership.userId)!
                .lastName,
              initials: allUsers.find((user) => user.id === membership.userId)!
                .initials,
              platformAccountNumber: allUsers.find((user) => user.id === membership.userId)!
                .platformAccountNumber ?? null,
            }
          : null,
      }))
    );
  })
);

const MEMBERSHIP_ROLE_RANK: Record<string, number> = {
  owner: 0,
  admin: 1,
  billing: 2,
  user: 3,
  read_only: 4,
};

const inviteSchema = z.object({
  email: z.string().email(),
  phone: z.string().optional(),
  roleToAssign: z.enum(["owner", "admin", "user", "billing", "read_only"]),
  expiresInDays: z.coerce.number().int().min(1).max(30).default(7),
});

/**
 * Lazy expiry: when a pending invite is read after its TTL, persist the
 * "expired" status (idempotently) and audit the transition once. Returns the
 * (possibly updated) invite so callers surface the effective status. Any read
 * path — admin listing, invitee preview, accept/decline — funnels through this
 * so an expired token can never be acted upon.
 */
async function expireInviteIfNeeded<T extends typeof organizationInvites.$inferSelect>(
  invite: T,
  req?: any
): Promise<T> {
  if (
    invite.status !== "pending" ||
    !invite.expiresAt ||
    new Date() <= invite.expiresAt
  ) {
    return invite;
  }
  const [updated] = await db
    .update(organizationInvites)
    .set({ status: "expired" })
    .where(
      and(
        eq(organizationInvites.id, invite.id),
        eq(organizationInvites.status, "pending")
      )
    )
    .returning();
  if (!updated) return invite;
  await writeAuditLog({
    req,
    organizationId: invite.labId,
    action: "organization_invite_expired",
    entityType: "organization_invite",
    entityId: invite.id,
    beforeJson: invite,
    afterJson: updated,
  });
  return updated as T;
}

/**
 * Notify the inviting admin (best-effort) when an invitee accepts or declines.
 * No PHI: the email contains only the org name, assigned role, the invitee's
 * own contact email, and the outcome. Honors the inviter's email preferences.
 */
async function notifyInviterOfResult(
  invite: typeof organizationInvites.$inferSelect,
  outcome: "accepted" | "declined",
  req: any
): Promise<void> {
  try {
    if (!invite.invitedByUserId) return;
    const [organization, inviter] = await Promise.all([
      db.query.organizations.findFirst({
        where: eq(organizations.id, invite.labId),
      }),
      db.query.users.findFirst({
        where: eq(users.id, invite.invitedByUserId),
      }),
    ]);
    if (!inviter?.email) return;
    const allowed = await checkEmailPref(inviter.email, "orgInviteNotifications");
    if (!allowed) {
      req?.log?.info?.(
        { inviteId: invite.id },
        "invite result email skipped — inviter opted out"
      );
      return;
    }
    const inviterName =
      [inviter.firstName, inviter.lastName]
        .filter((part) => !!part && String(part).trim().length > 0)
        .join(" ")
        .trim() ||
      inviter.username ||
      null;
    const result = await sendInviteResultEmail({
      to: inviter.email,
      inviterName,
      organizationName:
        organization?.displayName?.trim() ||
        organization?.name ||
        "your organization",
      roleAssigned: invite.roleToAssign ?? "user",
      inviteeEmail: invite.email ?? "",
      outcome,
    });
    if (!result.sent) {
      req?.log?.warn?.(
        { inviteId: invite.id, reason: result.reason },
        "invite result email not sent"
      );
    }
  } catch (err: any) {
    req?.log?.error?.(
      { err: err?.message || String(err), inviteId: invite.id },
      "invite result email failed"
    );
  }
}

/**
 * Delivery outcome for an invite email. `status` is what gets recorded on
 * the invite row; `reason` is a short, safe machine reason — never a raw
 * SMTP/provider payload.
 */
export interface InviteEmailDelivery {
  sent: boolean;
  status: "sent" | "failed" | "skipped";
  reason?: string;
}

// sendMail reasons that are already safe to surface to clients. Anything
// else (raw transport error messages, e.g. "535 BadCredentials") collapses
// to the generic "send_failed".
const SAFE_SEND_FAILURE_REASONS = new Set([
  "disabled_in_test",
  "smtp_not_configured",
  "reserved_domain",
  "undeliverable_domain",
  // SMTP login rejected (bad username/password/app password). Set by
  // sendMail()'s classified catch path — a stable string, never raw provider
  // text. Deliberately NOT in RETRYABLE_INVITE_EMAIL_REASONS: retrying a bad
  // password just hammers the provider and risks account lockout.
  "auth_failed",
]);

function toSafeSendReason(reason?: string): string {
  return reason && SAFE_SEND_FAILURE_REASONS.has(reason)
    ? reason
    : "send_failed";
}

/**
 * Shared invite-email delivery path used by both invite create and resend so
 * they behave identically: resolves the org/inviter/logo, checks the
 * recipient's email preference, sends, and records the delivery outcome on
 * the invite row (lastEmailAttemptAt / lastEmailStatus / lastEmailError).
 *
 * Never throws — returns the delivery outcome plus the invite row updated
 * with the recorded attempt.
 *
 * Exported for the automatic retry sweep (`lib/invite-email-retry.ts`) so
 * retries go through the exact same delivery + recording path.
 */
export async function deliverInviteEmail(
  req: any,
  invite: typeof organizationInvites.$inferSelect
): Promise<{
  delivery: InviteEmailDelivery;
  invite: typeof organizationInvites.$inferSelect;
}> {
  const recipientDomain = invite.email?.split("@")[1]?.toLowerCase() ?? null;
  let delivery: InviteEmailDelivery;
  try {
    if (!invite.email || !invite.roleToAssign || !invite.token) {
      delivery = { sent: false, status: "failed", reason: "invite_incomplete" };
    } else {
      const [organization, inviter] = await Promise.all([
        db.query.organizations.findFirst({
          where: eq(organizations.id, invite.labId),
        }),
        invite.invitedByUserId
          ? db.query.users.findFirst({
              where: eq(users.id, invite.invitedByUserId),
            })
          : Promise.resolve(undefined),
      ]);
      const inviterName = inviter
        ? [inviter.firstName, inviter.lastName]
            .filter((part) => !!part && String(part).trim().length > 0)
            .join(" ")
            .trim() || inviter.username || inviter.email || null
        : null;
      const placements = resolveLogoplacements(organization);
      const labLogo = placements.has("welcome_emails")
        ? await readLabLogoAsset(invite.labId)
        : null;
      const allowed = await checkEmailPref(
        invite.email,
        "orgInviteNotifications"
      );
      if (!allowed) {
        req.log?.info?.(
          { inviteId: invite.id, recipientDomain },
          "invite email skipped — recipient opted out"
        );
        delivery = {
          sent: false,
          status: "skipped",
          reason: "recipient_opted_out",
        };
      } else {
        const result = await sendInviteEmail({
          to: invite.email,
          organizationName:
            organization?.displayName?.trim() ||
            organization?.name ||
            "your organization",
          roleToAssign: invite.roleToAssign,
          token: invite.token,
          inviterName,
          expiresAt: invite.expiresAt ?? null,
          labLogo,
        });
        if (result.sent) {
          delivery = { sent: true, status: "sent" };
        } else {
          const reason = toSafeSendReason(result.reason);
          req.log?.warn?.(
            { inviteId: invite.id, recipientDomain, reason },
            "invite email not sent"
          );
          delivery = { sent: false, status: "failed", reason };
        }
      }
    }
  } catch (err: any) {
    req.log?.error?.(
      {
        err: err?.message || String(err),
        inviteId: invite.id,
        recipientDomain,
      },
      "invite email failed"
    );
    delivery = { sent: false, status: "failed", reason: "send_failed" };
  }

  // Record the attempt on the invite row so admins can see failed deliveries.
  let updated = invite;
  try {
    const [row] = await db
      .update(organizationInvites)
      .set({
        lastEmailAttemptAt: new Date(),
        lastEmailStatus: delivery.status,
        lastEmailError: delivery.sent ? null : delivery.reason ?? null,
        // A successful send closes the retry loop — reset the budget so a
        // later manual resend that fails gets a fresh set of auto-retries.
        ...(delivery.sent ? { emailRetryCount: 0 } : {}),
      })
      .where(eq(organizationInvites.id, invite.id))
      .returning();
    if (row) updated = row;
  } catch (err: any) {
    req.log?.error?.(
      { err: err?.message || String(err), inviteId: invite.id },
      "failed to record invite email delivery status"
    );
  }
  return { delivery, invite: updated };
}

/**
 * Public (no-auth) router for invite surfaces that an invitee must reach
 * **before** authenticating — namely the accept/deny landing page preview.
 * Mounted at `/organizations` ahead of the auth-gated router so only the
 * explicitly declared routes here bypass `requireAuth`; everything else falls
 * through. The token is the only secret: it's high-entropy, one-time-use, and
 * email-scoped, so a valid token may reveal the org/role to render the page.
 */
export const publicInviteRouter = Router();

publicInviteRouter.get(
  "/invite-preview/:token",
  asyncHandler(async (req, res) => {
    let invite = await db.query.organizationInvites.findFirst({
      where: eq(organizationInvites.token, req.params.token),
    });
    if (!invite) throw new HttpError(404, "Invite not found.");
    invite = await expireInviteIfNeeded(invite, req);

    const [organization, inviter] = await Promise.all([
      db.query.organizations.findFirst({
        where: eq(organizations.id, invite.labId),
      }),
      invite.invitedByUserId
        ? db.query.users.findFirst({
            where: eq(users.id, invite.invitedByUserId),
          })
        : Promise.resolve(undefined),
    ]);
    const inviterName = inviter
      ? [inviter.firstName, inviter.lastName]
          .filter((part) => !!part && String(part).trim().length > 0)
          .join(" ")
          .trim() ||
        inviter.username ||
        null
      : null;

    return ok(res, {
      status: invite.status,
      email: invite.email,
      roleToAssign: invite.roleToAssign,
      organizationName:
        organization?.displayName?.trim() ||
        organization?.name ||
        "this organization",
      inviterName,
      expiresAt: invite.expiresAt,
    });
  })
);

router.post(
  "/:organizationId/invites",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    // manage_team_members capability: owners and admins pass implicitly; non-admin
    // team members may also invite if they hold an explicit capability grant.
    await requireCapability(
      (req as any).auth.userId,
      organizationId,
      "manage_team_members"
    );
    const input = inviteSchema.parse(req.body);

    // Capability grants allow a member to manage invitations, not to exceed
    // their own role. Keep invitation assignments within the same ceiling as
    // direct membership edits so accepting a self-invite cannot promote them.
    const callerMembership = await db.query.organizationMemberships.findFirst({
      where: and(
        eq(organizationMemberships.userId, (req as any).auth.userId),
        eq(organizationMemberships.labId, organizationId),
        eq(organizationMemberships.status, "active"),
        isNull(organizationMemberships.deletedAt),
      ),
    });
    const callerRank =
      MEMBERSHIP_ROLE_RANK[callerMembership?.role ?? "read_only"] ?? 99;
    const inviteeRank = MEMBERSHIP_ROLE_RANK[input.roleToAssign] ?? 99;
    if (inviteeRank < callerRank) {
      throw new HttpError(403, "You cannot assign a role above your own.");
    }
    if (input.roleToAssign === "owner") {
      throw new HttpError(400, "Invite an active member first, then use the confirmed ownership transfer to make them Owner.");
    }

    const existingInvite = await db.query.organizationInvites.findFirst({
      where: and(
        eq(organizationInvites.labId, organizationId),
        eq(organizationInvites.email, input.email.toLowerCase()),
        eq(organizationInvites.status, "pending")
      ),
    });

    if (existingInvite) {
      throw new HttpError(409, "A pending invite already exists for that email address.");
    }

    const [invite] = await db
      .insert(organizationInvites)
      .values({
        labId: organizationId,
        email: input.email.toLowerCase(),
        phone: input.phone ?? null,
        roleToAssign: input.roleToAssign,
        token: generateInviteToken(),
        invitedByUserId: (req as any).auth.userId,
        expiresAt: new Date(
          Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000
        ),
      })
      .returning();

    await writeAuditLog({
      req,
      organizationId,
      action: "organization_invite_created",
      entityType: "organization_invite",
      entityId: invite.id,
      afterJson: invite,
    });

    // Deliver the invite email and record the outcome on the invite row.
    // The invite itself is created either way — the response tells the
    // client truthfully whether the email actually went out.
    const { delivery, invite: inviteWithDelivery } = await deliverInviteEmail(
      req,
      invite
    );

    return ok(res, { ...inviteWithDelivery, emailDelivery: delivery }, 201);
  })
);

router.get(
  "/:organizationId/invites",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireAnyRole(
      (req as any).auth.userId,
      organizationId,
      ADMIN_ROLES
    );
    const rawInvites = await db.query.organizationInvites.findMany({
      where: eq(organizationInvites.labId, organizationId),
    });
    const invites = await Promise.all(
      rawInvites.map((inv) => expireInviteIfNeeded(inv, req))
    );
    return ok(res, invites.map((inv) => ({ ...inv, organizationId: inv.labId })));
  })
);

router.post(
  "/invites/:inviteId/cancel",
  asyncHandler(async (req, res) => {
    const invite = await db.query.organizationInvites.findFirst({
      where: eq(organizationInvites.id, req.params.inviteId),
    });

    if (!invite) {
      throw new HttpError(404, "Invite not found.");
    }
    if (invite.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot cancel an invite that is already ${invite.status}.`
      );
    }

    await requireAnyRole(
      (req as any).auth.userId,
      invite.labId,
      ADMIN_ROLES
    );

    const [updatedInvite] = await db
      .update(organizationInvites)
      .set({ status: "revoked" })
      .where(eq(organizationInvites.id, invite.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: invite.labId,
      action: "organization_invite_cancelled",
      entityType: "organization_invite",
      entityId: invite.id,
      beforeJson: invite,
      afterJson: updatedInvite,
    });

    return ok(res, { ...updatedInvite, organizationId: updatedInvite.labId });
  })
);

router.post(
  "/invites/:inviteId/resend",
  asyncHandler(async (req, res) => {
    const invite = await db.query.organizationInvites.findFirst({
      where: eq(organizationInvites.id, req.params.inviteId),
    });

    if (!invite) {
      throw new HttpError(404, "Invite not found.");
    }
    if (invite.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot resend an invite that is already ${invite.status}.`
      );
    }
    if (!invite.email || !invite.roleToAssign) {
      throw new HttpError(410, "Invite is invalid or incomplete.");
    }

    await requireAnyRole(
      (req as any).auth.userId,
      invite.labId,
      ADMIN_ROLES
    );

    const expiresInDays = 7;
    const newToken = generateInviteToken();
    const newExpiresAt = new Date(
      Date.now() + expiresInDays * 24 * 60 * 60 * 1000
    );

    const [updatedInvite] = await db
      .update(organizationInvites)
      .set({
        token: newToken,
        expiresAt: newExpiresAt,
        invitedByUserId: (req as any).auth.userId,
        // Manual resend restarts the automatic retry budget.
        emailRetryCount: 0,
      })
      .where(eq(organizationInvites.id, invite.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: invite.labId,
      action: "organization_invite_resent",
      entityType: "organization_invite",
      entityId: invite.id,
      beforeJson: invite,
      afterJson: updatedInvite,
    });

    // Deliver via the shared path so create & resend behave identically and
    // the delivery outcome is recorded on the invite row. Resend is non-fatal
    // and symmetric with create: a failed or skipped email never surfaces as a
    // server error (502/409). The token rotation already happened, and the
    // response reports the delivery outcome truthfully via `emailDelivery` so
    // the client can show "refreshed, but not sent" without a destructive
    // "server error" framing.
    const { delivery, invite: inviteWithDelivery } = await deliverInviteEmail(
      req,
      updatedInvite
    );

    return ok(res, {
      ...inviteWithDelivery,
      organizationId: inviteWithDelivery.labId,
      emailDelivery: delivery,
    });
  })
);

router.post(
  "/invites/:inviteId/decline",
  asyncHandler(async (req, res) => {
    let invite = await db.query.organizationInvites.findFirst({
      where: and(
        eq(organizationInvites.id, req.params.inviteId),
        eq(organizationInvites.status, "pending")
      ),
    });

    if (!invite) {
      throw new HttpError(404, "Invite not found or already handled.");
    }

    const currentEmail = (req as any).user.email?.toLowerCase?.().trim?.();
    if (!currentEmail || !invite.email || invite.email.toLowerCase() !== currentEmail) {
      throw new HttpError(403, "This invite does not belong to your account.");
    }

    invite = await expireInviteIfNeeded(invite, req);
    if (invite.status === "expired") {
      throw new HttpError(410, "Invite has expired.");
    }

    const [updatedInvite] = await db
      .update(organizationInvites)
      .set({
        status: "declined",
      })
      .where(eq(organizationInvites.id, invite.id))
      .returning();

    await writeAuditLog({
      req,
      labId: invite.labId,
      action: "organization_invite_declined",
      entityType: "organization_invite",
      entityId: invite.id,
      afterJson: updatedInvite,
    });

    await notifyInviterOfResult(invite, "declined", req);

    return ok(res, updatedInvite);
  })
);

router.post(
  "/invites/:token/decline",
  asyncHandler(async (req, res) => {
    let invite = await db.query.organizationInvites.findFirst({
      where: and(
        eq(organizationInvites.token, req.params.token),
        eq(organizationInvites.status, "pending")
      ),
    });

    if (!invite) {
      throw new HttpError(404, "Invite not found or already handled.");
    }

    const currentEmail = (req as any).user.email?.toLowerCase?.().trim?.();
    if (!currentEmail || !invite.email || invite.email.toLowerCase() !== currentEmail) {
      throw new HttpError(403, "This invite does not belong to your account.");
    }

    invite = await expireInviteIfNeeded(invite, req);
    if (invite.status === "expired") {
      throw new HttpError(410, "Invite has expired.");
    }

    const [updatedInvite] = await db
      .update(organizationInvites)
      .set({
        status: "declined",
      })
      .where(eq(organizationInvites.id, invite.id))
      .returning();

    await writeAuditLog({
      req,
      labId: invite.labId,
      action: "organization_invite_declined",
      entityType: "organization_invite",
      entityId: invite.id,
      afterJson: updatedInvite,
    });

    await notifyInviterOfResult(invite, "declined", req);

    return ok(res, { ...updatedInvite, organizationId: updatedInvite.labId });
  })
);

router.post(
  "/invites/:token/accept",
  asyncHandler(async (req, res) => {
    let invite = await db.query.organizationInvites.findFirst({
      where: and(
        eq(organizationInvites.token, req.params.token),
        eq(organizationInvites.status, "pending")
      ),
    });
    if (!invite) throw new HttpError(404, "Invite not found or already used.");
    invite = await expireInviteIfNeeded(invite, req);
    if (invite.status === "expired")
      throw new HttpError(410, "Invite has expired.");
    if (!invite.roleToAssign || !invite.email)
      throw new HttpError(410, "Invite is invalid or incomplete.");

    const userId = (req as any).auth.userId;
    const caller = (req as any).user;
    const currentEmail = caller.email?.toLowerCase?.().trim?.();

    if (!currentEmail || invite.email.toLowerCase() !== currentEmail) {
      throw new HttpError(403, "This invite does not belong to your account.");
    }

    // Account epic Phase 4 — only a verified account may accept an invite and
    // gain access to lab data. Lazy adoption: legacy (non-canonical) accounts
    // are grandfathered, matching requireVerifiedAccount.
    if (
      process.env.DISABLE_VERIFICATION_ENFORCEMENT !== "true" &&
      isCanonicalAccount(caller) &&
      !isAccountVerified(caller)
    ) {
      throw new HttpError(
        403,
        "Please verify your email or phone before accepting this invitation.",
        { code: "VERIFICATION_REQUIRED" }
      );
    }

    const assignedRole = coerceMembershipRole(invite.roleToAssign, "user");
    if (assignedRole === "owner") {
      throw new HttpError(400, "Ownership requires a confirmed transfer to an active member. Ask the inviter to send a non-Owner invitation.");
    }

    await upsertActiveMembership({
      labId: invite.labId,
      userId,
      role: assignedRole,
      invitedByUserId: invite.invitedByUserId,
      approvedByUserId: invite.invitedByUserId,
    });

    await db
      .update(organizationInvites)
      .set({
        status: "accepted",
        acceptedByUserId: userId,
        acceptedAt: new Date(),
      })
      .where(eq(organizationInvites.id, invite.id));

    await syncUserToOrganization(userId, invite.labId, assignedRole);

    await writeAuditLog({
      req,
      labId: invite.labId,
      action: "organization_invite_accepted",
      entityType: "organization_invite",
      entityId: invite.id,
    });

    await notifyInviterOfResult(invite, "accepted", req);

    return ok(res, { accepted: true });
  })
);

// How long a declined join request keeps surfacing on the waiting card so the
// user can see the explicit "declined" message before it drops off.
const RECENT_REJECTED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const joinRequestSchema = z.object({
  requestedRole: z
    .enum(["admin", "user", "billing", "read_only"])
    .default("user"),
  message: z.string().max(1000).optional(),
});

router.post(
  "/:organizationId/join-requests",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    const input = joinRequestSchema.parse(req.body);

    // Validate the target: it must be a real, active, non-deleted lab or
    // provider organization. Without this a request could be filed against a
    // deactivated/deleted org and sit unreviewable forever.
    const targetOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (
      !targetOrg ||
      targetOrg.deletedAt ||
      !targetOrg.isActive ||
      (targetOrg.type !== "lab" && targetOrg.type !== "provider")
    ) {
      throw new HttpError(404, "We couldn't find that organization.");
    }

    const alreadyMember =
      await db.query.organizationMemberships.findFirst({
        where: and(
          eq(organizationMemberships.labId, organizationId),
          eq(
            organizationMemberships.userId,
            (req as any).auth.userId
          )
        ),
      });
    if (alreadyMember)
      throw new HttpError(
        409,
        "You already have a membership record for this organization."
      );

    const existingPendingRequest =
      await db.query.organizationJoinRequests.findFirst({
        where: and(
          eq(organizationJoinRequests.labId, organizationId),
          eq(
            organizationJoinRequests.userId,
            (req as any).auth.userId
          ),
          eq(organizationJoinRequests.status, "pending")
        ),
      });

    if (existingPendingRequest) {
      throw new HttpError(409, "You already have a pending join request.");
    }

    const request = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(organizationJoinRequests)
        .values({
          labId: organizationId,
          userId: (req as any).auth.userId,
          requestedRole: input.requestedRole,
          message: input.message ?? null,
        })
        .returning();
      if (targetOrg.type === "lab" || targetOrg.type === "dental_lab") {
        await enqueueJoinRequestNotification(tx, created.id);
      }
      return created;
    });

    await writeAuditLog({
      req,
      organizationId,
      action: "organization_join_requested",
      entityType: "organization_join_request",
      entityId: request.id,
      afterJson: request,
    });
    return ok(res, request, 201);
  })
);

router.get(
  "/join-requests/mine/pending",
  asyncHandler(async (req, res) => {
    const currentUserId = (req as any).auth.userId;
    // Surface pending requests plus recently resolved ones (approved or
    // declined) so the waiting card can react the moment an admin acts:
    // an approval lets the client refetch membership and drop into the lab
    // dashboard, and a decline shows an explicit "your request was declined"
    // message instead of silently resetting to search. Resolved rows older
    // than the window (or dismissed via DELETE) drop off so we don't resurface
    // stale decisions.
    const resolvedCutoff = new Date(Date.now() - RECENT_REJECTED_WINDOW_MS);
    const requests = await db.query.organizationJoinRequests.findMany({
      where: and(
        eq(organizationJoinRequests.userId, currentUserId),
        or(
          eq(organizationJoinRequests.status, "pending"),
          and(
            inArray(organizationJoinRequests.status, ["approved", "rejected"]),
            gte(organizationJoinRequests.reviewedAt, resolvedCutoff)
          )
        )
      ),
    });

    // Pending first, then most recently reviewed — so an active wait always
    // takes precedence over a stale decision on the card.
    requests.sort((a, b) => {
      if ((a.status === "pending") !== (b.status === "pending")) {
        return a.status === "pending" ? -1 : 1;
      }
      const aTime = a.reviewedAt?.getTime() ?? a.createdAt?.getTime() ?? 0;
      const bTime = b.reviewedAt?.getTime() ?? b.createdAt?.getTime() ?? 0;
      return bTime - aTime;
    });

    const organizationIds = [...new Set(requests.map((request) => request.labId))];
    const requestOrganizations = organizationIds.length
      ? await db
          .select()
          .from(organizations)
          .where(inArray(organizations.id, organizationIds))
      : [];
    const organizationsById = new Map(
      requestOrganizations.map((organization) => [organization.id, organization])
    );

    return ok(
      res,
      requests.map((request) => ({
        ...request,
        organizationId: request.labId,
        requestedByUserId: request.userId,
        organization: organizationsById.get(request.labId) ?? null,
      }))
    );
  })
);

router.get(
  "/:organizationId/join-requests",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await resolveJoinRequestAdminAccess(
      (req as any).auth.userId,
      organizationId
    );
    const requests =
      await db.query.organizationJoinRequests.findMany({
        where: and(
          eq(organizationJoinRequests.labId, organizationId),
          eq(organizationJoinRequests.status, "pending")
        ),
      });
    return ok(res, requests.map((r) => ({
      ...r,
      organizationId: r.labId,
      requestedByUserId: r.userId,
    })));
  })
);

router.post(
  "/join-requests/:joinRequestId/approve",
  asyncHandler(async (req, res) => {
    const request =
      await db.query.organizationJoinRequests.findFirst({
        where: eq(
          organizationJoinRequests.id,
          req.params.joinRequestId
        ),
      });
    if (!request) throw new HttpError(404, "Join request not found.");

    const adminAccess = await resolveJoinRequestAdminAccess(
      (req as any).auth.userId,
      request.labId
    );

    if (request.status === "approved") {
      const existingMembership =
        await db.query.organizationMemberships.findFirst({
          where: and(
            eq(organizationMemberships.labId, request.labId),
            eq(organizationMemberships.userId, request.userId),
            notDeleted(organizationMemberships)
          ),
        });
      return ok(res, { membership: existingMembership ?? null, request });
    }
    if (request.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot approve a request that is already ${request.status}.`
      );
    }

    const roleToAssign = coerceMembershipRole(
      req.body?.role,
      (request.requestedRole as MembershipRole) ?? "user"
    );

    const membership = await upsertActiveMembership({
      labId: request.labId,
      userId: request.userId,
      role: roleToAssign,
      approvedByUserId: (req as any).auth.userId,
    });

    await db
      .delete(organizationJoinRequests)
      .where(
        and(
          eq(organizationJoinRequests.labId, request.labId),
          eq(organizationJoinRequests.userId, request.userId),
          eq(organizationJoinRequests.status, "approved"),
          ne(organizationJoinRequests.id, request.id)
        )
      );

    const [updatedRequest] = await db
      .update(organizationJoinRequests)
      .set({
        status: "approved",
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(organizationJoinRequests.id, request.id))
      .returning();

    await syncUserToOrganization(
      request.userId,
      request.labId,
      roleToAssign
    );

    repairLabCaseAffiliations(request.labId).catch(() => {});

    // Notify the requesting user their access was granted (closes the loop so
    // they don't have to keep watching the pending card).
    try {
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, request.labId),
      });
      const isPractice = org?.type === "provider";
      const orgLabel =
        org?.displayName || org?.name || (isPractice ? "the practice" : "the lab");

      let approvalBody: string;
      if (isPractice && adminAccess.organization !== null) {
        // Approved via parent-lab fallback — credit the acting lab by name.
        const parentLab = await db.query.organizations.findFirst({
          where: eq(organizations.id, adminAccess.membership.labId),
        });
        const labLabel =
          parentLab?.displayName || parentLab?.name || "its lab";
        approvalBody = `You've been approved to join ${orgLabel} by ${labLabel}. You now have access to the practice.`;
      } else if (isPractice) {
        approvalBody = `You've been approved to join ${orgLabel}. You now have access to the practice.`;
      } else {
        approvalBody = `You've been approved to join ${orgLabel}. You now have access to the lab.`;
      }

      await db
        .insert(notifications)
        .values({
          userId: request.userId,
          type: "join_request_approved",
          title: "Join request approved",
          body: approvalBody,
          dataJson: { organizationId: request.labId, joinRequestId: request.id },
        })
        .catch((err: unknown): never =>
          wrapDbError(err, {
            fallback: "Failed to send join approval notification.",
          })
        );
    } catch {
      // Best-effort — never fail the approval because the notification insert failed.
    }

    await writeAuditLog({
      req,
      labId: request.labId,
      action: "organization_join_approved",
      entityType: "organization_join_request",
      entityId: request.id,
      afterJson: updatedRequest,
    });
    return ok(res, { membership, request: updatedRequest });
  })
);

router.delete(
  "/join-requests/:joinRequestId",
  asyncHandler(async (req, res) => {
    const request =
      await db.query.organizationJoinRequests.findFirst({
        where: eq(
          organizationJoinRequests.id,
          req.params.joinRequestId
        ),
      });
    if (!request) throw new HttpError(404, "Join request not found.");

    if (request.userId !== (req as any).auth.userId) {
      throw new HttpError(403, "You can only cancel your own join request.");
    }

    // Pending: the user is cancelling a request still awaiting review.
    // Rejected: the user is acknowledging/dismissing a decline so the waiting
    // card stops surfacing it and returns to lab search.
    if (request.status !== "pending" && request.status !== "rejected") {
      throw new HttpError(
        409,
        "Only pending or declined join requests can be dismissed."
      );
    }

    const nextStatus =
      request.status === "rejected" ? "dismissed" : "cancelled";

    const [updated] = await db
      .update(organizationJoinRequests)
      .set({
        status: nextStatus,
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(organizationJoinRequests.id, request.id))
      .returning();

    await writeAuditLog({
      req,
      labId: request.labId,
      action:
        nextStatus === "dismissed"
          ? "organization_join_dismissed"
          : "organization_join_cancelled",
      entityType: "organization_join_request",
      entityId: request.id,
      afterJson: updated,
    });

    return ok(res, updated);
  })
);

router.post(
  "/join-requests/:joinRequestId/reject",
  asyncHandler(async (req, res) => {
    const request =
      await db.query.organizationJoinRequests.findFirst({
        where: eq(
          organizationJoinRequests.id,
          req.params.joinRequestId
        ),
      });
    if (!request) throw new HttpError(404, "Join request not found.");

    await resolveJoinRequestAdminAccess(
      (req as any).auth.userId,
      request.labId
    );
    // (return value unused for reject — we only need the access check)

    if (request.status === "rejected") {
      return ok(res, request);
    }
    if (request.status !== "pending") {
      throw new HttpError(
        409,
        `Cannot reject a request that is already ${request.status}.`
      );
    }

    const [updated] = await db
      .update(organizationJoinRequests)
      .set({
        status: "rejected",
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(organizationJoinRequests.id, request.id))
      .returning();

    // Notify the requesting user their request was declined so the waiting card
    // shows an explicit message instead of silently resetting to search.
    try {
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, request.labId),
      });
      const isPractice = org?.type === "provider";
      const orgLabel =
        org?.displayName || org?.name || (isPractice ? "the practice" : "the lab");

      const rejectionBody = isPractice
        ? `Your request to join ${orgLabel} was declined. You can search for another practice or lab to join, or wait for an invite.`
        : `Your request to join ${orgLabel} was declined. You can search for another lab to join, or wait for a lab admin to invite you.`;

      await db
        .insert(notifications)
        .values({
          userId: request.userId,
          type: "join_request_rejected",
          title: "Join request declined",
          body: rejectionBody,
          dataJson: { organizationId: request.labId, joinRequestId: request.id },
        })
        .catch((err: unknown): never =>
          wrapDbError(err, {
            fallback: "Failed to send join decline notification.",
          })
        );
    } catch {
      // Best-effort — never fail the rejection because the notification insert failed.
    }

    await writeAuditLog({
      req,
      labId: request.labId,
      action: "organization_join_rejected",
      entityType: "organization_join_request",
      entityId: request.id,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

const connectionSchema = z.object({
  labOrganizationId: z.string().uuid(),
  providerOrganizationId: z.string().uuid(),
});

router.post(
  "/connections",
  asyncHandler(async (req, res) => {
    const input = connectionSchema.parse(req.body);
    const isLabMember = await requireMembership(
      (req as any).auth.userId,
      input.labOrganizationId
    ).catch(() => null);
    const isProviderMember = await requireMembership(
      (req as any).auth.userId,
      input.providerOrganizationId
    ).catch(() => null);
    if (!isLabMember && !isProviderMember)
      throw new HttpError(
        403,
        "You must belong to one side of the connection request."
      );

    const [connection] = await db
      .insert(organizationConnections)
      .values({
        labOrganizationId: input.labOrganizationId,
        providerOrganizationId: input.providerOrganizationId,
        requestedByOrgId: isLabMember
          ? input.labOrganizationId
          : input.providerOrganizationId,
        requestedByUserId: (req as any).auth.userId,
      })
      .onConflictDoNothing()
      .returning();

    return ok(
      res,
      connection ?? { alreadyExists: true },
      connection ? 201 : 200
    );
  })
);

router.post(
  "/connections/:connectionId/approve",
  asyncHandler(async (req, res) => {
    const connection =
      await db.query.organizationConnections.findFirst({
        where: eq(
          organizationConnections.id,
          req.params.connectionId
        ),
      });
    if (!connection)
      throw new HttpError(404, "Connection not found.");

    const targetOrgId =
      connection.requestedByOrgId === connection.labOrganizationId
        ? connection.providerOrganizationId
        : connection.labOrganizationId;
    await requireAnyRole(
      (req as any).auth.userId,
      targetOrgId,
      ADMIN_ROLES
    );

    const [updated] = await db
      .update(organizationConnections)
      .set({
        status: "active",
        approvedByUserId: (req as any).auth.userId,
        approvedAt: new Date(),
      })
      .where(eq(organizationConnections.id, connection.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: targetOrgId,
      action: "organization_connection_approved",
      entityType: "organization_connection",
      entityId: connection.id,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

router.patch(
  "/connections/:connectionId",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        tierName: z.string().max(80).nullable().optional(),
        status: z
          .enum(["pending", "active", "suspended", "rejected"])
          .optional(),
      })
      .parse(req.body);

    const connection = await db.query.organizationConnections.findFirst({
      where: eq(organizationConnections.id, req.params.connectionId),
    });
    if (!connection) throw new HttpError(404, "Connection not found.");

    // Only an admin in the lab side can change the assigned tier or status.
    await requireAnyRole(
      (req as any).auth.userId,
      connection.labOrganizationId,
      ADMIN_ROLES
    );

    const update: Partial<typeof organizationConnections.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.tierName !== undefined) {
      const tn =
        typeof input.tierName === "string" ? input.tierName.trim() : null;
      update.tierName = tn && tn.length > 0 ? tn : null;
    }
    if (input.status !== undefined) update.status = input.status;

    const [updated] = await db
      .update(organizationConnections)
      .set(update)
      .where(eq(organizationConnections.id, connection.id))
      .returning();

    await writeAuditLog({
      req,
      organizationId: connection.labOrganizationId,
      action: "organization_connection_updated",
      entityType: "organization_connection",
      entityId: connection.id,
      beforeJson: connection,
      afterJson: updated,
    });

    return ok(res, updated);
  })
);

router.patch(
  "/memberships/:membershipId",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        role: z
          .enum(["owner", "admin", "user", "billing", "read_only"])
          .optional(),
        status: z
          .enum(["active", "pending", "invited", "suspended"])
          .optional(),
      })
      .parse(req.body);

    const membership =
      await db.query.organizationMemberships.findFirst({
        where: eq(
          organizationMemberships.id,
          req.params.membershipId
        ),
      });
    if (!membership) throw new HttpError(404, "Membership not found.");
    await requireAnyRole(
      (req as any).auth.userId,
      membership.labId,
      ADMIN_ROLES
    );

    // Role ceiling: prevent a caller from assigning a role above their own.
    if (input.role) {
      const callerMembership = await db.query.organizationMemberships.findFirst({
        where: and(
          eq(organizationMemberships.userId, (req as any).auth.userId),
          eq(organizationMemberships.labId, membership.labId),
        ),
      });
      const callerRank =
        MEMBERSHIP_ROLE_RANK[callerMembership?.role ?? "read_only"] ?? 99;
      const targetRank = MEMBERSHIP_ROLE_RANK[input.role] ?? 99;
      if (targetRank < callerRank) {
        throw new HttpError(403, "You cannot assign a role above your own.");
      }
    }
    if (input.role === "owner") {
      throw new HttpError(400, "Use the confirmed ownership transfer to assign Owner.");
    }

    const [updated] = await db
      .update(organizationMemberships)
      .set(input)
      .where(eq(organizationMemberships.id, membership.id))
      .returning();

    await writeAuditLog({
      req,
      labId: membership.labId,
      action: "membership_updated",
      entityType: "organization_membership",
      entityId: membership.id,
      beforeJson: membership,
      afterJson: updated,
    });
    return ok(res, updated);
  })
);

router.delete(
  "/memberships/:membershipId",
  asyncHandler(async (req, res) => {
    const membership =
      await db.query.organizationMemberships.findFirst({
        where: eq(
          organizationMemberships.id,
          req.params.membershipId
        ),
      });
    if (!membership) throw new HttpError(404, "Membership not found.");

    const isOwnMembership =
      membership.userId === (req as any).auth.userId;
    if (!isOwnMembership) {
      await requireAnyRole(
        (req as any).auth.userId,
        membership.labId,
        ADMIN_ROLES
      );
    }

    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.id, membership.id));

    await syncUserFromActiveMemberships(membership.userId);

    await writeAuditLog({
      req,
      labId: membership.labId,
      action: "membership_removed",
      entityType: "organization_membership",
      entityId: membership.id,
      beforeJson: membership,
    });
    return ok(res, { removed: true });
  })
);

// ─── Logo placement helpers ──────────────────────────────────────────────────
// Which document / email contexts can show a lab logo.
export const LOGO_PLACEMENT_KEYS = [
  "invoices",
  "statements",
  "sms",
  "emails",
  "case_exports",
  "quotes",
  "welcome_emails",
  "payment_receipts",
] as const;
export type LogoPlacement = (typeof LOGO_PLACEMENT_KEYS)[number];

/**
 * Resolve effective logo placements from a saved preference array.
 * - If `org` is null/undefined, returns an empty Set.
 * - If `logoplacements` is an array (even empty), use it as-is.
 * - If `logoplacements` is null the preference has not been configured yet;
 *   returns an empty Set so no logo appears until an admin opts in.
 *   (Existing orgs with a logo are backfilled to all-placements-enabled during
 *   the migration that introduced this column.)
 */
export function resolveLogoplacements(
  org:
    | {
        logoUrl: string | null | undefined;
        logoplacements: string[] | null | undefined;
      }
    | null
    | undefined
): Set<string> {
  if (!org) return new Set();
  if (org.logoplacements != null) {
    return new Set(org.logoplacements);
  }
  return new Set();
}

const LOGO_PDF_SIZES = ["small", "medium", "large"] as const;

const logoPlacementsBodySchema = z.object({
  placements: z
    .array(z.enum(LOGO_PLACEMENT_KEYS))
    .max(LOGO_PLACEMENT_KEYS.length),
  logoPdfSize: z.enum(LOGO_PDF_SIZES).nullable().optional(),
});

router.patch(
  "/:organizationId/logo-placements",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    const _userId = (req as any).auth.userId as string;
    // configure_integrations capability: direct admins/owners always pass.
    // Non-admin members with an explicit configure_integrations grant also pass.
    // For parent-lab delegation (lab admin editing a provider org), fall through
    // to the original resolveOrgAdminAccess check.
    const _directMembership = await getActiveMembership(_userId, organizationId);
    const _isDirectAdmin =
      _directMembership != null &&
      ADMIN_ROLES.includes(_directMembership.role as MembershipRole);
    if (!_isDirectAdmin) {
      const _hasGrant = await hasCapability(_userId, organizationId, "configure_integrations");
      if (!_hasGrant) {
        // Not a direct admin and no capability grant — try parent-lab access.
        await resolveOrgAdminAccess(_userId, organizationId);
      }
    }

    const { placements, logoPdfSize } = logoPlacementsBodySchema.parse(req.body);

    const existing = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!existing) throw new HttpError(404, "Organization not found.");

    const updateData: Record<string, unknown> = {
      logoplacements: placements,
      updatedAt: new Date(),
    };
    if (logoPdfSize !== undefined) {
      updateData.logoPdfSize = logoPdfSize ?? null;
    }

    const [updated] = await db
      .update(organizations)
      .set(updateData as any)
      .where(eq(organizations.id, organizationId))
      .returning();

    await writeAuditLog({
      req,
      labId: organizationId,
      action: "organization_logo_placements_updated",
      entityType: "organization",
      entityId: organizationId,
      beforeJson: { placements: existing.logoplacements, logoPdfSize: (existing as any).logoPdfSize },
      afterJson: { placements, logoPdfSize: updateData.logoPdfSize },
    });

    return ok(res, updated);
  })
);

// ─── Per-lab duplicate-suggestion threshold ──────────────────────────────────
//
// The "Suggested merges" (Doctors) and "Suggested duplicates" (Practices)
// banners cluster rows whose normalized-name bigram similarity is ≥ a
// threshold. The application default is 0.7, but labs with messy data may
// want 0.6 (more aggressive) or with very clean data 0.8 (less noisy).
// Stored per-lab on `organizations.duplicate_suggestion_threshold` and
// editable only by lab admins. Only valid on type="lab" rows.
const DUPLICATE_THRESHOLD_MIN = 0.5;
const DUPLICATE_THRESHOLD_MAX = 0.95;
const duplicateThresholdBodySchema = z.object({
  threshold: z
    .number()
    .min(DUPLICATE_THRESHOLD_MIN)
    .max(DUPLICATE_THRESHOLD_MAX)
    .nullable(),
});

router.patch(
  "/:organizationId/duplicate-suggestion-threshold",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);

    const { threshold } = duplicateThresholdBodySchema.parse(req.body);

    const existing = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!existing) throw new HttpError(404, "Organization not found.");
    if (existing.type !== "lab") {
      throw new HttpError(
        400,
        "Duplicate-suggestion threshold can only be set on lab organizations."
      );
    }

    const dbValue =
      threshold === null ? null : (Math.round(threshold * 1000) / 1000).toFixed(3);

    const [updated] = await db
      .update(organizations)
      .set({
        duplicateSuggestionThreshold: dbValue,
        updatedAt: new Date(),
      } as any)
      .where(eq(organizations.id, organizationId))
      .returning();

    await writeAuditLog({
      req,
      labId: organizationId,
      action: "organization_duplicate_threshold_updated",
      entityType: "organization",
      entityId: organizationId,
      beforeJson: {
        duplicateSuggestionThreshold: (existing as any).duplicateSuggestionThreshold,
      },
      afterJson: { duplicateSuggestionThreshold: dbValue },
    });

    return ok(res, updated);
  })
);

// ─── Lab logo (used on invoices, statements, the desktop header) ────────────
//
// Stored in App Storage under `<PRIVATE_OBJECT_DIR>/lab-logos/<orgId>.<ext>`
// and served back through this API so we don't depend on signed URLs or
// public buckets. Any active lab member can view; only an admin of the
// org can upload/replace.
const labLogoUpload = multer({
  storage: multer.memoryStorage(),
  // 5 MB is plenty for a logo image and keeps memory bounded.
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get(
  "/:id/logo",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    await resolveOrgReadAccess((req as any).auth.userId, id);
    const stream = await openLabLogoStream(id);
    if (!stream) {
      res.status(404).json({ error: "No logo uploaded for this lab yet." });
      return;
    }
    res.setHeader("Content-Type", stream.contentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    stream.stream.on("error", (err) => {
      req.log?.error?.({ err }, "lab logo stream error");
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.stream.pipe(res);
  })
);

router.post(
  "/:id/logo",
  (req, res, next) => {
    labLogoUpload.single("file")(req, res, (err: any) => {
      if (err) {
        const status = err?.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        res.status(status).json({ error: err?.message || "Upload failed." });
        return;
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, id);

    const file = (req as any).file as
      | { originalname: string; mimetype: string; buffer: Buffer; size: number }
      | undefined;
    if (!file || !file.buffer || file.size === 0) {
      throw new HttpError(
        400,
        "Missing 'file' field — pick a PNG, JPG, SVG, or WebP image."
      );
    }
    if (!isAllowedLogoMime(file.mimetype)) {
      throw new HttpError(
        400,
        `Unsupported image type: ${file.mimetype}. Use PNG, JPG, SVG, GIF, or WebP.`
      );
    }
    const meta = await uploadLabLogo(id, file.buffer, file.mimetype);

    // Persist the *API* URL of the logo on the org row. Stamping a cache
    // buster from the upload time forces the desktop client to re-fetch
    // immediately when the logo changes, even though the URL itself is
    // stable.
    const logoUrl = `/api/organizations/${id}/logo?v=${Date.parse(
      meta.uploadedAt
    )}`;
    const [updated] = await db
      .update(organizations)
      .set({ logoUrl, updatedAt: new Date() })
      .where(eq(organizations.id, id))
      .returning();

    await writeAuditLog({
      req,
      labId: id,
      action: "lab_logo_uploaded",
      entityType: "organization",
      entityId: id,
      details: {
        size: meta.size,
        contentType: meta.contentType,
      },
    });

    return ok(res, {
      organization: updated,
      logo: {
        url: logoUrl,
        contentType: meta.contentType,
        size: meta.size,
        uploadedAt: meta.uploadedAt,
      },
    });
  })
);

// ─── Invoice layout template (Task #751) ─────────────────────────────────────
//
// Per-lab visual invoice template that drives all generated invoice PDFs.
// Stored on `organizations.invoice_template` (jsonb). Null = use the
// built-in DEFAULT_INVOICE_TEMPLATE, so labs that never open the editor
// see the original hard-coded layout.

router.get(
  "/:organizationId/invoice-template",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgReadAccess((req as any).auth.userId, organizationId);
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!org) throw new HttpError(404, "Organization not found.");
    const template = coerceInvoiceTemplate((org as any).invoiceTemplate);
    return ok(res, {
      template,
      isCustom: (org as any).invoiceTemplate != null,
      defaultTemplate: DEFAULT_INVOICE_TEMPLATE,
    });
  })
);

router.put(
  "/:organizationId/invoice-template",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);

    // Accept `null` to reset to default.
    const body = req.body as { template?: unknown };
    let toStore: unknown = null;
    if (body && body.template !== null && body.template !== undefined) {
      const parsed = invoiceTemplateSchema.safeParse(body.template);
      if (!parsed.success) {
        throw new HttpError(
          400,
          `Invalid invoice template: ${parsed.error.message}`,
        );
      }
      toStore = parsed.data;
    }

    const existing = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!existing) throw new HttpError(404, "Organization not found.");

    const [updated] = await db
      .update(organizations)
      .set({ invoiceTemplate: toStore as any, updatedAt: new Date() } as any)
      .where(eq(organizations.id, organizationId))
      .returning();

    await writeAuditLog({
      req,
      labId: organizationId,
      action: "organization_invoice_template_updated",
      entityType: "organization",
      entityId: organizationId,
      beforeJson: { invoiceTemplate: (existing as any).invoiceTemplate ?? null },
      afterJson: { invoiceTemplate: toStore },
    });

    return ok(res, {
      template: coerceInvoiceTemplate((updated as any).invoiceTemplate),
      isCustom: (updated as any).invoiceTemplate != null,
      defaultTemplate: DEFAULT_INVOICE_TEMPLATE,
    });
  })
);

const invoiceImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.post(
  "/:organizationId/invoice-template/images",
  (req, res, next) => {
    invoiceImageUpload.single("file")(req, res, (err: any) => {
      if (err) {
        const status = err?.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        res.status(status).json({ error: err?.message || "Upload failed." });
        return;
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);

    const file = (req as any).file as
      | { mimetype: string; buffer: Buffer; size: number }
      | undefined;
    if (!file || !file.buffer || file.size === 0) {
      throw new HttpError(400, "Missing 'file' field.");
    }
    if (!isAllowedLogoMime(file.mimetype)) {
      throw new HttpError(
        400,
        `Unsupported image type: ${file.mimetype}. Use PNG, JPG, GIF, SVG, or WebP.`,
      );
    }
    const meta = await uploadInvoiceTemplateImage(
      organizationId,
      file.buffer,
      file.mimetype,
    );
    const url = `/api/organizations/${organizationId}/invoice-template/images/${meta.id}`;
    return ok(res, {
      id: meta.id,
      storageKey: meta.storageKey,
      url,
      contentType: meta.contentType,
      size: meta.size,
    });
  })
);

router.get(
  "/:organizationId/invoice-template/images/:imageId",
  asyncHandler(async (req, res) => {
    const { organizationId, imageId } = req.params;
    await resolveOrgReadAccess((req as any).auth.userId, organizationId);
    const stream = await openInvoiceTemplateImageStream(organizationId, imageId);
    if (!stream) {
      res.status(404).json({ error: "Image not found." });
      return;
    }
    res.setHeader("Content-Type", stream.contentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    stream.stream.on("error", (err) => {
      req.log?.error?.({ err }, "invoice template image stream error");
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.stream.pipe(res);
  })
);

router.delete(
  "/:organizationId/invoice-template/images/:imageId",
  asyncHandler(async (req, res) => {
    const { organizationId, imageId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);
    await deleteInvoiceTemplateImage(organizationId, imageId);
    return ok(res, { deleted: true });
  })
);

// ─── Case-print-label template (advanced layout editor) ─────────────────────
//
// Per-lab visual layout that drives the printed case label. Stored on
// `organizations.case_print_template` (jsonb). Null = no advanced layout;
// the case drawer falls back to the legacy per-user PrintLayoutConfig.

router.get(
  "/:organizationId/case-print-template",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveCasePrintReadAccess((req as any).auth.userId, organizationId, req.query.caseId);
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!org) throw new HttpError(404, "Organization not found.");
    const template = coerceCasePrintTemplate((org as any).casePrintTemplate);
    return ok(res, {
      template,
      isCustom: (org as any).casePrintTemplate != null,
      defaultTemplate: DEFAULT_CASE_PRINT_TEMPLATE,
    });
  })
);

router.put(
  "/:organizationId/case-print-template",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);

    const body = req.body as { template?: unknown };
    let toStore: unknown = null;
    if (body && body.template !== null && body.template !== undefined) {
      const parsed = casePrintTemplateSchema.safeParse(body.template);
      if (!parsed.success) {
        throw new HttpError(
          400,
          `Invalid case print template: ${parsed.error.message}`,
        );
      }
      toStore = parsed.data;
    }

    const existing = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!existing) throw new HttpError(404, "Organization not found.");

    const [updated] = await db
      .update(organizations)
      .set({ casePrintTemplate: toStore as any, updatedAt: new Date() } as any)
      .where(eq(organizations.id, organizationId))
      .returning();

    await writeAuditLog({
      req,
      labId: organizationId,
      action: "organization_case_print_template_updated",
      entityType: "organization",
      entityId: organizationId,
      beforeJson: { casePrintTemplate: (existing as any).casePrintTemplate ?? null },
      afterJson: { casePrintTemplate: toStore },
    });

    return ok(res, {
      template: coerceCasePrintTemplate((updated as any).casePrintTemplate),
      isCustom: (updated as any).casePrintTemplate != null,
      defaultTemplate: DEFAULT_CASE_PRINT_TEMPLATE,
    });
  })
);

const casePrintImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.post(
  "/:organizationId/case-print-template/images",
  (req, res, next) => {
    casePrintImageUpload.single("file")(req, res, (err: any) => {
      if (err) {
        const status = err?.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        res.status(status).json({ error: err?.message || "Upload failed." });
        return;
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);

    const file = (req as any).file as
      | { mimetype: string; buffer: Buffer; size: number }
      | undefined;
    if (!file || !file.buffer || file.size === 0) {
      throw new HttpError(400, "Missing 'file' field.");
    }
    if (!isAllowedLogoMime(file.mimetype)) {
      throw new HttpError(
        400,
        `Unsupported image type: ${file.mimetype}. Use PNG, JPG, GIF, SVG, or WebP.`,
      );
    }
    const meta = await uploadCasePrintTemplateImage(
      organizationId,
      file.buffer,
      file.mimetype,
    );
    const url = `/api/organizations/${organizationId}/case-print-template/images/${meta.id}`;
    return ok(res, {
      id: meta.id,
      storageKey: meta.storageKey,
      url,
      contentType: meta.contentType,
      size: meta.size,
    });
  })
);

router.get(
  "/:organizationId/case-print-template/images/:imageId",
  asyncHandler(async (req, res) => {
    const { organizationId, imageId } = req.params;
    await resolveCasePrintReadAccess((req as any).auth.userId, organizationId, req.query.caseId);
    const stream = await openCasePrintTemplateImageStream(organizationId, imageId);
    if (!stream) {
      res.status(404).json({ error: "Image not found." });
      return;
    }
    res.setHeader("Content-Type", stream.contentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    stream.stream.on("error", (err) => {
      req.log?.error?.({ err }, "case-print-template image stream error");
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.stream.pipe(res);
  })
);

router.delete(
  "/:organizationId/case-print-template/images/:imageId",
  asyncHandler(async (req, res) => {
    const { organizationId, imageId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);
    await deleteCasePrintTemplateImage(organizationId, imageId);
    return ok(res, { deleted: true });
  })
);

// ─── Statement template ──────────────────────────────────────────────────────

router.get(
  "/:organizationId/statement-template",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgReadAccess((req as any).auth.userId, organizationId);
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!org) throw new HttpError(404, "Organization not found.");
    const template = coerceStatementTemplate((org as any).statementTemplate);
    return ok(res, {
      template,
      isCustom: (org as any).statementTemplate != null,
      defaultTemplate: DEFAULT_STATEMENT_TEMPLATE,
    });
  })
);

router.put(
  "/:organizationId/statement-template",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);

    const body = req.body as { template?: unknown };
    let toStore: unknown = null;
    if (body && body.template !== null && body.template !== undefined) {
      const parsed = statementTemplateSchema.safeParse(body.template);
      if (!parsed.success) {
        throw new HttpError(
          400,
          `Invalid statement template: ${parsed.error.message}`,
        );
      }
      toStore = parsed.data;
    }

    const existing = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!existing) throw new HttpError(404, "Organization not found.");

    const [updated] = await db
      .update(organizations)
      .set({ statementTemplate: toStore as any, updatedAt: new Date() } as any)
      .where(eq(organizations.id, organizationId))
      .returning();

    await writeAuditLog({
      req,
      labId: organizationId,
      action: "organization_statement_template_updated",
      entityType: "organization",
      entityId: organizationId,
      beforeJson: { statementTemplate: (existing as any).statementTemplate ?? null },
      afterJson: { statementTemplate: toStore },
    });

    return ok(res, {
      template: coerceStatementTemplate((updated as any).statementTemplate),
      isCustom: (updated as any).statementTemplate != null,
      defaultTemplate: DEFAULT_STATEMENT_TEMPLATE,
    });
  })
);

// ─── Correspondence template ─────────────────────────────────────────────────

router.get(
  "/:organizationId/correspondence-template",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgReadAccess((req as any).auth.userId, organizationId);
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!org) throw new HttpError(404, "Organization not found.");
    const template = coerceCorrespondenceTemplate((org as any).correspondenceTemplate);
    return ok(res, {
      template,
      isCustom: (org as any).correspondenceTemplate != null,
      defaultTemplate: DEFAULT_CORRESPONDENCE_TEMPLATE,
    });
  })
);

router.put(
  "/:organizationId/correspondence-template",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);

    const body = req.body as { template?: unknown };
    let toStore: unknown = null;
    if (body && body.template !== null && body.template !== undefined) {
      const parsed = correspondenceTemplateSchema.safeParse(body.template);
      if (!parsed.success) {
        throw new HttpError(
          400,
          `Invalid correspondence template: ${parsed.error.message}`,
        );
      }
      toStore = parsed.data;
    }

    const existing = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!existing) throw new HttpError(404, "Organization not found.");

    const [updated] = await db
      .update(organizations)
      .set({ correspondenceTemplate: toStore as any, updatedAt: new Date() } as any)
      .where(eq(organizations.id, organizationId))
      .returning();

    await writeAuditLog({
      req,
      labId: organizationId,
      action: "organization_correspondence_template_updated",
      entityType: "organization",
      entityId: organizationId,
      beforeJson: { correspondenceTemplate: (existing as any).correspondenceTemplate ?? null },
      afterJson: { correspondenceTemplate: toStore },
    });

    return ok(res, {
      template: coerceCorrespondenceTemplate((updated as any).correspondenceTemplate),
      isCustom: (updated as any).correspondenceTemplate != null,
      defaultTemplate: DEFAULT_CORRESPONDENCE_TEMPLATE,
    });
  })
);

// ─── Statement history ───────────────────────────────────────────────────────

// Returns the most recent statement-email audit log entries for a practice org.
// The caller must have read access to the practice (direct membership OR lab
// membership when the org is a provider).
router.get(
  "/:organizationId/statement-history",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    const { organization } = await resolveOrgReadAccess(
      (req as any).auth.userId,
      organizationId,
    );

    // `organization` is populated when access was granted via the parent lab.
    // When the caller is a direct member, fetch the org ourselves to get
    // parentLabOrganizationId (needed to scope the audit log query).
    const org =
      organization ??
      (await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
      }));
    if (!org) throw new HttpError(404, "Organization not found.");

    const labOrgId = org.parentLabOrganizationId;
    if (!labOrgId) {
      // Not a provider org — no statement history applies.
      return ok(res, { history: [] });
    }

    const rawLimit = Number(req.query.limit ?? 25);
    const limit = Math.min(isNaN(rawLimit) ? 25 : rawLimit, 100);

    const rows = await db
      .select({
        id: auditLogs.id,
        createdAt: auditLogs.createdAt,
        metadataJson: auditLogs.metadataJson,
        actorFirstName: users.firstName,
        actorLastName: users.lastName,
        actorInitials: users.initials,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(
        and(
          eq(auditLogs.organizationId, labOrgId),
          eq(auditLogs.action, "statement_emailed"),
          eq(auditLogs.entityId, organizationId),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);

    const history = rows.map((r) => {
      const meta = (r.metadataJson ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        createdAt: r.createdAt,
        to: typeof meta["to"] === "string" ? meta["to"] : null,
        cc: Array.isArray(meta["cc"]) ? (meta["cc"] as string[]) : [],
        subject: typeof meta["subject"] === "string" ? meta["subject"] : null,
        invoiceIds: Array.isArray(meta["invoiceIds"])
          ? (meta["invoiceIds"] as string[])
          : [],
        invoiceNumbers: Array.isArray(meta["invoiceNumbers"])
          ? (meta["invoiceNumbers"] as string[])
          : [],
        sentAt:
          typeof meta["sentAt"] === "string" ? meta["sentAt"] : null,
        actorFirstName: r.actorFirstName ?? null,
        actorLastName: r.actorLastName ?? null,
        actorInitials: r.actorInitials ?? null,
      };
    });

    return ok(res, { history });
  }),
);

// ─── Invoice template named presets ─────────────────────────────────────────

const presetSaveSchema = z.object({
  name: z.string().min(1).max(80).trim(),
  template: z.unknown(),
});

type TemplatePreset = {
  id: string;
  name: string;
  template: unknown;
  savedAt: string;
};

function parsePresets(raw: unknown): TemplatePreset[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is TemplatePreset =>
      !!p &&
      typeof p === "object" &&
      typeof (p as Record<string, unknown>).id === "string" &&
      typeof (p as Record<string, unknown>).name === "string",
  );
}

router.get(
  "/:organizationId/invoice-template/presets",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await requireMembership((req as any).auth.userId, organizationId);
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
      columns: { invoiceTemplatePresets: true },
    });
    if (!org) throw new HttpError(404, "Organization not found.");
    return ok(res, { presets: parsePresets(org.invoiceTemplatePresets) });
  }),
);

router.post(
  "/:organizationId/invoice-template/presets",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);
    const { name, template } = presetSaveSchema.parse(req.body);
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
      columns: { invoiceTemplatePresets: true },
    });
    if (!org) throw new HttpError(404, "Organization not found.");
    const presets = parsePresets(org.invoiceTemplatePresets);
    if (presets.length >= 20) throw new HttpError(400, "Maximum 20 presets per organization.");
    const newPreset: TemplatePreset = {
      id: crypto.randomUUID(),
      name,
      template,
      savedAt: new Date().toISOString(),
    };
    await db
      .update(organizations)
      .set({ invoiceTemplatePresets: [...presets, newPreset] })
      .where(eq(organizations.id, organizationId));
    return ok(res, { preset: newPreset });
  }),
);

const presetPatchSchema = z.object({
  name: z.string().min(1).max(80).trim().optional(),
  template: z.unknown().optional(),
});

router.patch(
  "/:organizationId/invoice-template/presets/:presetId",
  asyncHandler(async (req, res) => {
    const { organizationId, presetId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);
    const body = presetPatchSchema.parse(req.body);
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
      columns: { invoiceTemplatePresets: true },
    });
    if (!org) throw new HttpError(404, "Organization not found.");
    const presets = parsePresets(org.invoiceTemplatePresets);
    const idx = presets.findIndex((p) => p.id === presetId);
    if (idx < 0) throw new HttpError(404, "Preset not found.");
    const updated: TemplatePreset = {
      ...presets[idx],
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.template !== undefined ? { template: body.template, savedAt: new Date().toISOString() } : {}),
    };
    presets[idx] = updated;
    await db
      .update(organizations)
      .set({ invoiceTemplatePresets: presets })
      .where(eq(organizations.id, organizationId));
    return ok(res, { preset: updated });
  }),
);

router.delete(
  "/:organizationId/invoice-template/presets/:presetId",
  asyncHandler(async (req, res) => {
    const { organizationId, presetId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
      columns: { invoiceTemplatePresets: true },
    });
    if (!org) throw new HttpError(404, "Organization not found.");
    const presets = parsePresets(org.invoiceTemplatePresets);
    await db
      .update(organizations)
      .set({ invoiceTemplatePresets: presets.filter((p) => p.id !== presetId) })
      .where(eq(organizations.id, organizationId));
    return ok(res, { deleted: true });
  }),
);

// ─────────────────────────── Closed-days settings ──────────────────────────
// Custom non-working days for a lab (e.g. local holidays, studio closures).
// These are excluded from the business-day denominator in Stats averages.
// Owner/admin ONLY — billing members cannot manage the calendar.

const closedDaySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .refine((v) => !Number.isNaN(new Date(v).getTime()), "date must be a valid calendar date"),
  note: z.string().max(200).optional(),
});

router.get(
  "/:organizationId/settings/closed-days",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);
    const rows = await db
      .select({
        id: labClosedDays.id,
        date: labClosedDays.date,
        note: labClosedDays.note,
        createdAt: labClosedDays.createdAt,
      })
      .from(labClosedDays)
      .where(eq(labClosedDays.labOrganizationId, organizationId))
      .orderBy(labClosedDays.date);
    return ok(res, { closedDays: rows });
  }),
);

router.post(
  "/:organizationId/settings/closed-days",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    const userId: string = (req as any).auth.userId;
    await resolveOrgAdminAccess(userId, organizationId);
    const body = closedDaySchema.parse(req.body);
    const [row] = await db
      .insert(labClosedDays)
      .values({
        labOrganizationId: organizationId,
        date: body.date,
        note: body.note ?? null,
        createdByUserId: userId,
      })
      .onConflictDoUpdate({
        target: [labClosedDays.labOrganizationId, labClosedDays.date],
        set: { note: body.note ?? null },
      })
      .returning();
    return ok(res, { closedDay: row });
  }),
);

router.delete(
  "/:organizationId/settings/closed-days/:date",
  asyncHandler(async (req, res) => {
    const { organizationId, date } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpError(400, "date must be YYYY-MM-DD");
    }
    await db
      .delete(labClosedDays)
      .where(
        and(
          eq(labClosedDays.labOrganizationId, organizationId),
          eq(labClosedDays.date, date),
        ),
      );
    return ok(res, { deleted: true });
  }),
);

// ── Quick Reference Notes ────────────────────────────────────────────────────
// Lab-scoped reusable note templates that staff can insert into the Add Note
// composer on any case without retyping common status updates.
// All roles that can access the lab can READ; only owner/admin/user (staff)
// can write (create/update/delete/reorder).

const QRN_WRITE_ROLES: MembershipRole[] = ["owner", "admin", "user"];

const createQuickRefNoteSchema = z.object({
  body: z.string().min(1, "body is required").max(2000),
  label: z.string().max(200).optional().nullable(),
  displayOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const updateQuickRefNoteSchema = createQuickRefNoteSchema.partial();

const updateQuickRefNoteOrderSchema = z.object({
  displayOrder: z.number().int(),
});

const DEFAULT_QUICK_REF_TEMPLATES: Array<{ body: string; label: string }> = [
  { label: "Due date changed", body: "Changed due date." },
  { label: "Courtesy text sent", body: "Sent courtesy text to office." },
  { label: "Called office", body: "Called office." },
  { label: "Rush case", body: "Rush case — prioritized." },
  { label: "Case on hold", body: "Case placed on hold pending further information." },
  { label: "Awaiting shade", body: "Waiting on shade confirmation from office." },
  { label: "Awaiting bite records", body: "Awaiting bite records from office." },
  { label: "Awaiting approval", body: "Awaiting doctor approval before proceeding." },
  { label: "Parts ordered", body: "Parts ordered — waiting on delivery." },
  { label: "Remake initiated", body: "Remake initiated per doctor request." },
  { label: "Shipped today", body: "Case shipped today." },
  { label: "Ready for pickup", body: "Case ready for pickup." },
  { label: "Delivered to office", body: "Delivered to office." },
  { label: "Additional visit needed", body: "Additional try-in/visit required." },
  { label: "Model issue", body: "Issue noted with model — please advise." },
  { label: "Impression issue", body: "Impression quality issue — may need retake." },
  { label: "Left voicemail", body: "Left voicemail with office." },
  { label: "Spoke with doctor", body: "Spoke with doctor directly." },
  { label: "Alloy included", body: "Alloy charge included on this case." },
  { label: "No charge", body: "Courtesy — no charge for this case." },
];

/**
 * Template libraries are organization-scoped. Lab roles may maintain the
 * shared lab library, while a provider library is deliberately restricted to
 * that provider's own admins/owners. This keeps a provider from editing a
 * laboratory's shared templates while still letting it curate its own notes.
 */
async function requireQuickReferenceWriteAccess(
  userId: string,
  organizationId: string,
) {
  const organization = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
    columns: { id: true, type: true },
  });
  if (!organization) throw new HttpError(404, "Organization not found.");
  await requireAnyRole(
    userId,
    organizationId,
    organization.type === "provider" ? ADMIN_ROLES : QRN_WRITE_ROLES,
  );
}

router.get(
  "/:organizationId/quick-reference-notes",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    const callerId = (req as any).auth.userId as string;
    await requireMembership(callerId, organizationId);
    const rows = await db
      .select()
      .from(quickReferenceNotes)
      .where(eq(quickReferenceNotes.organizationId, organizationId))
      .orderBy(quickReferenceNotes.displayOrder, quickReferenceNotes.createdAt);
    return ok(res, { notes: rows });
  }),
);

router.post(
  "/:organizationId/quick-reference-notes",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    const callerId = (req as any).auth.userId as string;
    await requireQuickReferenceWriteAccess(callerId, organizationId);
    const body = createQuickRefNoteSchema.parse(req.body);
    const [row] = await db
      .insert(quickReferenceNotes)
      .values({
        organizationId,
        body: body.body,
        label: body.label ?? null,
        displayOrder: body.displayOrder ?? 0,
        isActive: body.isActive ?? true,
      })
      .returning();
    return ok(res, { note: row });
  }),
);

router.post(
  "/:organizationId/quick-reference-notes/seed-defaults",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    const callerId = (req as any).auth.userId as string;
    await requireQuickReferenceWriteAccess(callerId, organizationId);
    const existing = await db
      .select({ id: quickReferenceNotes.id })
      .from(quickReferenceNotes)
      .where(eq(quickReferenceNotes.organizationId, organizationId))
      .limit(1);
    if (existing.length > 0) {
      return ok(res, { seeded: false, message: "Templates already exist for this lab." });
    }
    const toInsert = DEFAULT_QUICK_REF_TEMPLATES.map((t, i) => ({
      organizationId,
      body: t.body,
      label: t.label,
      displayOrder: i,
      isActive: true,
    }));
    const rows = await db.insert(quickReferenceNotes).values(toInsert).returning();
    return ok(res, { seeded: true, notes: rows });
  }),
);

router.patch(
  "/:organizationId/quick-reference-notes/:noteId",
  asyncHandler(async (req, res) => {
    const { organizationId, noteId } = req.params;
    const callerId = (req as any).auth.userId as string;
    await requireQuickReferenceWriteAccess(callerId, organizationId);
    const body = updateQuickRefNoteSchema.parse(req.body);
    const existing = await db.query.quickReferenceNotes.findFirst({
      where: and(
        eq(quickReferenceNotes.id, noteId),
        eq(quickReferenceNotes.organizationId, organizationId)
      ),
    });
    if (!existing) throw new HttpError(404, "Quick reference note not found.");
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (body.body !== undefined) set.body = body.body;
    if (body.label !== undefined) set.label = body.label ?? null;
    if (body.isActive !== undefined) set.isActive = body.isActive;
    if (body.displayOrder !== undefined) set.displayOrder = body.displayOrder;
    const [updated] = await db
      .update(quickReferenceNotes)
      .set(set)
      .where(and(eq(quickReferenceNotes.id, noteId), eq(quickReferenceNotes.organizationId, organizationId)))
      .returning();
    return ok(res, { note: updated });
  }),
);

router.delete(
  "/:organizationId/quick-reference-notes/:noteId",
  asyncHandler(async (req, res) => {
    const { organizationId, noteId } = req.params;
    const callerId = (req as any).auth.userId as string;
    await requireQuickReferenceWriteAccess(callerId, organizationId);
    const existing = await db.query.quickReferenceNotes.findFirst({
      where: and(
        eq(quickReferenceNotes.id, noteId),
        eq(quickReferenceNotes.organizationId, organizationId)
      ),
    });
    if (!existing) throw new HttpError(404, "Quick reference note not found.");
    const [updated] = await db
      .update(quickReferenceNotes)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(quickReferenceNotes.id, noteId), eq(quickReferenceNotes.organizationId, organizationId)))
      .returning();
    return ok(res, { note: updated, deleted: true });
  }),
);

router.patch(
  "/:organizationId/quick-reference-notes/:noteId/order",
  asyncHandler(async (req, res) => {
    const { organizationId, noteId } = req.params;
    const callerId = (req as any).auth.userId as string;
    await requireQuickReferenceWriteAccess(callerId, organizationId);
    const body = updateQuickRefNoteOrderSchema.parse(req.body);
    const existing = await db.query.quickReferenceNotes.findFirst({
      where: and(
        eq(quickReferenceNotes.id, noteId),
        eq(quickReferenceNotes.organizationId, organizationId)
      ),
    });
    if (!existing) throw new HttpError(404, "Quick reference note not found.");
    const [updated] = await db
      .update(quickReferenceNotes)
      .set({ displayOrder: body.displayOrder, updatedAt: new Date() })
      .where(and(eq(quickReferenceNotes.id, noteId), eq(quickReferenceNotes.organizationId, organizationId)))
      .returning();
    return ok(res, { note: updated });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Doctor profile endpoints
// ─────────────────────────────────────────────────────────────────────────────

const phoneEntrySchema = z.object({
  phoneNumber: z.string().min(1),
  label: z.enum(["main", "mobile", "other"]),
  isPrimary: z.boolean().optional().default(false),
});

const emailEntrySchema = z.object({
  email: z.string().email(),
  label: z.enum(["general", "invoicing", "other"]),
  isPrimary: z.boolean().optional().default(false),
});

const putDoctorProfileSchema = z.object({
  doctorName: z.string().trim().min(1),
  providerOrgId: z
    .union([z.string().trim().min(1), z.null()])
    .optional()
    .transform((v) => v ?? null),
  displayName: z.string().trim().nullable().optional(),
  preferences: z.string().nullable().optional(),
  phones: z.array(phoneEntrySchema).optional().default([]),
  emails: z.array(emailEntrySchema).optional().default([]),
});

const doctorRenameSchema = z.object({
  doctorName: z.string().trim().min(1),
  providerOrgId: z
    .union([z.string().trim().min(1), z.null()])
    .optional()
    .transform((v) => v ?? null),
  newName: z.string().trim().min(1),
});

/**
 * Build the WHERE clause for a doctor profile lookup, handling the NULL
 * providerOrganizationId case correctly.
 */
function doctorProfileWhere(
  orgId: string,
  doctorName: string,
  providerOrgId: string | null
) {
  const providerClause =
    providerOrgId !== null
      ? eq(doctorProfiles.providerOrganizationId, providerOrgId)
      : isNull(doctorProfiles.providerOrganizationId);
  return and(
    eq(doctorProfiles.labOrganizationId, orgId),
    sql`lower(${doctorProfiles.doctorName}) = lower(${doctorName})`,
    providerClause
  );
}

/**
 * Fetch a doctor profile with its phone and email children. Returns null when
 * no row exists.
 */
async function fetchDoctorProfileFull(
  orgId: string,
  doctorName: string,
  providerOrgId: string | null
) {
  const profile = await db.query.doctorProfiles.findFirst({
    where: doctorProfileWhere(orgId, doctorName, providerOrgId),
  });
  if (!profile) return null;

  const [phones, emails] = await Promise.all([
    db.query.doctorPhoneEntries.findMany({
      where: eq(doctorPhoneEntries.doctorProfileId, profile.id),
    }),
    db.query.doctorEmailEntries.findMany({
      where: eq(doctorEmailEntries.doctorProfileId, profile.id),
    }),
  ]);

  return { ...profile, phones, emails };
}

/** Zero-state shape returned when no profile row exists yet. */
function emptyProfileShape(
  doctorName: string,
  providerOrgId: string | null
) {
  return {
    id: null,
    doctorName,
    providerOrganizationId: providerOrgId,
    displayName: null,
    preferences: null,
    phones: [] as Array<{ phoneNumber: string; label: string; isPrimary: boolean }>,
    emails: [] as Array<{ email: string; label: string; isPrimary: boolean }>,
  };
}

/**
 * GET /organizations/:orgId/doctors/profile
 *
 * Returns the doctor profile (phones, emails, preferences, displayName) for a
 * doctor within a lab. Returns an empty/default shape when no row exists yet.
 *
 * Query params:
 *   doctorName   – required
 *   providerOrgId – optional (null-safe)
 */
router.get(
  "/:orgId/doctors/profile",
  asyncHandler(async (req, res) => {
    const orgId = req.params.orgId;
    const userId = (req as any).auth.userId as string;
    await requireMembership(userId, orgId);

    const doctorName = String(req.query.doctorName ?? "").trim();
    if (!doctorName) throw new HttpError(400, "doctorName query param is required.");

    const providerOrgIdRaw = req.query.providerOrgId;
    const providerOrgId =
      providerOrgIdRaw == null || providerOrgIdRaw === ""
        ? null
        : String(providerOrgIdRaw).trim();

    const profile = await fetchDoctorProfileFull(orgId, doctorName, providerOrgId);
    return ok(res, profile ?? emptyProfileShape(doctorName, providerOrgId));
  })
);

/**
 * PUT /organizations/:orgId/doctors/profile
 *
 * Upserts a doctor profile (displayName, preferences, phone list, email list)
 * in a single transaction. Child rows are replaced wholesale.
 */
router.put(
  "/:orgId/doctors/profile",
  asyncHandler(async (req, res) => {
    const orgId = req.params.orgId;
    const userId = (req as any).auth.userId as string;
    await requireMembership(userId, orgId);

    const body = putDoctorProfileSchema.parse(req.body);

    const result = await db.transaction(async (tx) => {
      // Upsert the profile row.
      const existing = await tx.query.doctorProfiles.findFirst({
        where: doctorProfileWhere(orgId, body.doctorName, body.providerOrgId ?? null),
      });

      let profileId: string;

      if (existing) {
        const [updated] = await tx
          .update(doctorProfiles)
          .set({
            displayName: body.displayName ?? null,
            preferences: body.preferences ?? null,
            updatedAt: new Date(),
          })
          .where(eq(doctorProfiles.id, existing.id))
          .returning({ id: doctorProfiles.id });
        profileId = updated.id;
      } else {
        const [inserted] = await tx
          .insert(doctorProfiles)
          .values({
            labOrganizationId: orgId,
            doctorName: body.doctorName,
            providerOrganizationId: body.providerOrgId ?? null,
            displayName: body.displayName ?? null,
            preferences: body.preferences ?? null,
          })
          .returning({ id: doctorProfiles.id });
        profileId = inserted.id;
      }

      // Replace child phone rows.
      await tx
        .delete(doctorPhoneEntries)
        .where(eq(doctorPhoneEntries.doctorProfileId, profileId));
      if (body.phones.length > 0) {
        await tx.insert(doctorPhoneEntries).values(
          body.phones.map((p) => ({
            doctorProfileId: profileId,
            phoneNumber: p.phoneNumber,
            label: p.label,
            isPrimary: p.isPrimary ?? false,
          }))
        );
      }

      // Replace child email rows.
      await tx
        .delete(doctorEmailEntries)
        .where(eq(doctorEmailEntries.doctorProfileId, profileId));
      if (body.emails.length > 0) {
        await tx.insert(doctorEmailEntries).values(
          body.emails.map((e) => ({
            doctorProfileId: profileId,
            email: e.email,
            label: e.label,
            isPrimary: e.isPrimary ?? false,
          }))
        );
      }

      return profileId;
    });

    // Return the full updated profile.
    const profile = await fetchDoctorProfileFull(orgId, body.doctorName, body.providerOrgId ?? null);
    return ok(res, profile ?? emptyProfileShape(body.doctorName, body.providerOrgId ?? null));
  })
);

/**
 * PATCH /organizations/:orgId/doctors/rename  (admin only)
 *
 * Renames a doctor across `cases`, `pricing_overrides`, and `doctor_profiles`
 * for the given lab in a single transaction. Returns counts of updated rows.
 *
 * `lab_unassigned_doctors` is NOT updated here — that table is keyed by
 * `userId`, not `doctorName`, so it does not hold a renameable name string.
 */
router.patch(
  "/:orgId/doctors/rename",
  asyncHandler(async (req, res) => {
    const orgId = req.params.orgId;
    const userId = (req as any).auth.userId as string;
    await requireAnyRole(userId, orgId, ADMIN_ROLES);

    const body = doctorRenameSchema.parse(req.body);
    const { doctorName, providerOrgId, newName } = body;
    const resolvedProviderOrgId = providerOrgId ?? null;

    if (doctorName.trim().toLowerCase() === newName.trim().toLowerCase()) {
      throw new HttpError(400, "New name must differ from the current name.");
    }

    const counts = await db.transaction(async (tx) => {
      const providerClause =
        resolvedProviderOrgId !== null
          ? eq(cases.providerOrganizationId, resolvedProviderOrgId)
          : isNull(cases.providerOrganizationId);

      // 1. cases.doctor_name
      const caseResult = await tx
        .update(cases)
        .set({ doctorName: newName })
        .where(
          and(
            eq(cases.labOrganizationId, orgId),
            sql`lower(${cases.doctorName}) = lower(${doctorName})`,
            providerClause
          )
        )
        .returning({ id: cases.id });
      const casesUpdated = caseResult.length;

      // 2. pricing_overrides.doctor_name
      const pricingProviderClause =
        resolvedProviderOrgId !== null
          ? eq(pricingOverrides.providerOrganizationId, resolvedProviderOrgId)
          : isNull(pricingOverrides.providerOrganizationId);
      const pricingResult = await tx
        .update(pricingOverrides)
        .set({ doctorName: newName, updatedAt: new Date() })
        .where(
          and(
            eq(pricingOverrides.labOrganizationId, orgId),
            sql`lower(${pricingOverrides.doctorName}) = lower(${doctorName})`,
            pricingProviderClause,
            isNull(pricingOverrides.deletedAt)
          )
        )
        .returning({ id: pricingOverrides.id });
      const pricingUpdated = pricingResult.length;

      // 3. doctor_profiles.doctor_name
      const profileResult = await tx
        .update(doctorProfiles)
        .set({ doctorName: newName, updatedAt: new Date() })
        .where(doctorProfileWhere(orgId, doctorName, resolvedProviderOrgId))
        .returning({ id: doctorProfiles.id });
      const profilesUpdated = profileResult.length;

      return {
        casesUpdated,
        pricingUpdated,
        profilesUpdated,
        renamedCaseIds: caseResult.map((c: { id: string }) => c.id),
      };
    });

    for (const caseId of counts.renamedCaseIds) {
      broadcastCaseUpdated(caseId, "doctor_renamed");
    }

    return ok(res, {
      oldName: doctorName,
      newName,
      providerOrganizationId: resolvedProviderOrgId,
      casesUpdated: counts.casesUpdated,
      pricingUpdated: counts.pricingUpdated,
      profilesUpdated: counts.profilesUpdated,
    });
  })
);

export default router;
