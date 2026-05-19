import crypto from "node:crypto";
import { Router } from "express";
import multer from "multer";
import {
  isAllowedLogoMime,
  openLabLogoStream,
  uploadLabLogo,
} from "../lib/lab-logo-storage";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  cases,
  labCases,
  organizationConnections,
  organizationInvites,
  organizationJoinRequests,
  organizationMemberships,
  organizations,
  users,
} from "@workspace/db";
import { generateInviteToken } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { hashPassword } from "../lib/crypto";
import { HttpError, ok } from "../lib/http";
import { notDeleted, restoreDeleted, softDeleteById } from "../lib/soft-delete";
import { getAppBaseUrl, sendInviteEmail } from "../lib/mail";
import {
  assertCustomAccountNumberAvailable,
  generateProviderAccountNumber,
} from "../lib/provider-account-number";
import {
  ADMIN_ROLES,
  getActiveMembership,
  requireAnyRole,
  requireMembership,
  type MembershipRole,
} from "../lib/rbac";
import { asyncHandler } from "../middlewares/async-handler";
import { requireAuth } from "../middlewares/auth";
import {
  allocatePlatformAccountNumber,
  deriveAccountNameParts,
} from "../lib/platform-account-number";

const router = Router();
router.use(requireAuth);

const createOrgSchema = z.object({
  type: z.enum(["lab", "provider"]),
  name: z.string().min(1),
  displayName: z.string().optional(),
  billingEmail: z.string().email().optional(),
  phone: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  isActive: z.boolean().optional(),
  // When true the automated statement-email engine skips this practice.
  statementEmailOptOut: z.boolean().optional(),
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

// PATCH does not allow changing the parent lab — that would silently move a
// practice between labs and re-key its account-number namespace.
const updateOrgSchema = createOrgSchema
  .omit({ type: true, parentLabOrganizationId: true, doctorName: true })
  .partial();

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
    const callerId = (req as any).auth.userId;

    let parentLabOrganizationId: string | null = null;
    let accountNumber: string | null = null;

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
        if (input.accountNumber && input.accountNumber.trim()) {
          accountNumber = await assertCustomAccountNumberAvailable(
            parentLabOrganizationId,
            input.accountNumber,
            null
          );
        } else {
          accountNumber = await generateProviderAccountNumber(
            parentLabOrganizationId,
            {
              addressLine1: input.addressLine1 ?? null,
              doctorName: input.doctorName ?? null,
              practiceName: input.displayName || input.name,
            }
          );
        }
      }
    }

    const {
      doctorName: _doctorName,
      accountNumber: _accountNumberInput,
      parentLabOrganizationId: _parentLabInput,
      ...persistableInput
    } = input;

    // Platform-wide account number for provider organizations (Task #320).
    // Best-effort; never blocks creation.
    let platformAccountNumber: string | null = null;
    if (input.type === "provider") {
      try {
        platformAccountNumber = await allocatePlatformAccountNumber(
          "org",
          deriveAccountNameParts({
            practiceName: input.displayName || input.name,
            doctorName: input.doctorName ?? null,
          })
        );
      } catch (err: any) {
        req.log?.warn?.(
          { err: err?.message ?? String(err) },
          "Failed to allocate platform account number for org (non-fatal)"
        );
      }
    }

    const [organization] = await db
      .insert(organizations)
      .values({
        ...persistableInput,
        parentLabOrganizationId,
        accountNumber,
        platformAccountNumber,
        createdByUserId: callerId,
      })
      .returning();

    await db.insert(organizationMemberships).values({
      labId: organization.id,
      userId: callerId,
      role: "owner",
      status: "active",
      approvedByUserId: callerId,
      joinedAt: new Date(),
    });

    await syncUserToOrganization(
      (req as any).auth.userId,
      organization.id,
      "owner"
    );

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

const addDoctorsSchema = z.object({
  doctors: z
    .array(
      z.object({
        firstName: z.string().trim().min(1),
        lastName: z.string().trim().optional().default(""),
        email: z.string().trim().email().optional().or(z.literal("")),
        phone: z.string().trim().optional(),
      })
    )
    .min(1)
    .max(50),
});

function slugifyForUsername(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "doctor";
}

async function generateUniqueDoctorUsername(
  firstName: string,
  lastName: string
): Promise<string> {
  const base = slugifyForUsername(`${firstName}-${lastName}`);
  for (let i = 0; i < 8; i++) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const candidate = `${base}-${suffix}`;
    const existing = await db.query.users.findFirst({
      where: eq(users.username, candidate),
    });
    if (!existing) return candidate;
  }
  throw new HttpError(500, "Could not allocate a unique username for doctor.");
}

// Bulk-create doctor users for a provider practice. Lab admin only. Each
// created user gets its own platform account number (Task #320) and is added
// to the practice as an active member with role "user". A random password is
// stored — the doctor must claim/reset it later via the standard flows.
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

    const created: Array<{
      id: string;
      username: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      phone: string | null;
      platformAccountNumber: string | null;
    }> = [];
    const skipped: Array<{ index: number; reason: string }> = [];

    for (let i = 0; i < input.doctors.length; i++) {
      const d = input.doctors[i];
      try {
        const email = d.email && d.email.length > 0 ? d.email.toLowerCase() : null;
        const phone = d.phone && d.phone.length > 0 ? d.phone : null;

        // Skip duplicates (by email) instead of failing the whole batch.
        if (email) {
          const allUsers = await db.select({ id: users.id, email: users.email }).from(users);
          const dup = allUsers.find((u) => u.email?.toLowerCase() === email);
          if (dup) {
            skipped.push({ index: i, reason: "An account with this email already exists." });
            continue;
          }
        }

        const username = await generateUniqueDoctorUsername(d.firstName, d.lastName);
        const randomPassword = crypto.randomUUID() + crypto.randomUUID();
        const hashed = await hashPassword(randomPassword);

        const initials =
          ((d.firstName.trim()[0] ?? "") + (d.lastName.trim()[0] ?? "")).toUpperCase() || "DR";

        let platformAccountNumber: string | null = null;
        try {
          platformAccountNumber = await allocatePlatformAccountNumber(
            "user",
            deriveAccountNameParts({
              firstName: d.firstName,
              lastName: d.lastName,
              doctorName: `${d.firstName} ${d.lastName}`.trim(),
              practiceName: practice.displayName || practice.name,
            })
          );
        } catch (err: any) {
          req.log?.warn?.(
            { err: err?.message ?? String(err) },
            "Failed to allocate platform account number for doctor (non-fatal)"
          );
        }

        // Wrap the user + membership inserts in a transaction so a failure
        // partway through doesn't leave a dangling user without membership.
        const user = await db.transaction(async (tx) => {
          const [u] = await tx
            .insert(users)
            .values({
              username,
              password: hashed,
              email,
              phone,
              firstName: d.firstName,
              lastName: d.lastName || null,
              initials,
              userType: "provider",
              doctorName: `${d.firstName} ${d.lastName}`.trim(),
              role: "user",
              platformAccountNumber,
            })
            .returning();
          await tx.insert(organizationMemberships).values({
            labId: organizationId,
            userId: u.id,
            role: "user",
            status: "active",
            approvedByUserId: callerId,
            joinedAt: new Date(),
          });
          return u;
        });

        await writeAuditLog({
          req,
          organizationId,
          action: "practice_doctor_added",
          entityType: "user",
          entityId: user.id,
          afterJson: {
            username: user.username,
            email: user.email,
            phone: user.phone,
            platformAccountNumber: user.platformAccountNumber,
          },
        });

        created.push({
          id: user.id,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          platformAccountNumber: user.platformAccountNumber,
        });
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

    return ok(res, { created, skipped }, 201);
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

    // Every provider-type user on the platform, minus current members.
    const allProviderUsers = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        phone: users.phone,
        firstName: users.firstName,
        lastName: users.lastName,
        userType: users.userType,
        platformAccountNumber: users.platformAccountNumber,
      })
      .from(users)
      .where(eq(users.userType, "provider"));
    const eligibleUsers = allProviderUsers.filter(
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
      }))
      .sort((a, b) => {
        const an = `${a.lastName ?? ""} ${a.firstName ?? ""}`.trim().toLowerCase();
        const bn = `${b.lastName ?? ""} ${b.firstName ?? ""}`.trim().toLowerCase();
        return an.localeCompare(bn);
      });

    // Virtual doctors: unique doctorName values from this lab's cases that
    // don't already have a formal provider account. Shown in the picker so
    // the lab admin can formally create an account without leaving the dialog.
    const caseDoctorRows = await db
      .selectDistinct({ doctorName: cases.doctorName })
      .from(cases)
      .where(
        and(
          eq(cases.labOrganizationId, practice.parentLabOrganizationId),
          isNotNull(cases.doctorName),
          notDeleted(cases)
        )
      );

    const existingProviderNames = new Set(
      allProviderUsers.map((u) =>
        `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim().toLowerCase()
      )
    );
    const virtualDoctors = caseDoctorRows
      .filter(
        (c) =>
          c.doctorName &&
          c.doctorName.trim() &&
          !existingProviderNames.has(c.doctorName.trim().toLowerCase())
      )
      .map((c) => ({
        id: `virtual:${c.doctorName}`,
        username: c.doctorName as string,
        email: null as string | null,
        phone: null as string | null,
        firstName: null as string | null,
        lastName: null as string | null,
        userType: "provider" as const,
        platformAccountNumber: null as string | null,
        currentPractices: [] as string[],
        virtual: true as const,
        doctorName: c.doctorName as string,
      }))
      .sort((a, b) => a.doctorName.localeCompare(b.doctorName));

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

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    const memberships =
      await db.query.organizationMemberships.findMany({
        where: eq(
          organizationMemberships.userId,
          (req as any).auth.userId
        ),
      });
    const orgIds = memberships
      .filter((m: any) => m.status === "active")
      .map((m: any) => m.labId);
    const orgs = orgIds.length
      ? await db
          .select()
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

    const invites = await db.query.organizationInvites.findMany({
      where: and(
        eq(organizationInvites.email, currentEmail),
        eq(organizationInvites.status, "pending")
      ),
    });

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
    return ok(res, organization);
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
      } else {
        nextAccountNumber = await assertCustomAccountNumberAvailable(
          existing.parentLabOrganizationId,
          trimmed,
          existing.id
        );
      }
    }

    const { accountNumber: _accountNumberInput, ...rest } = input;
    const updateValues: Record<string, unknown> = { ...rest };
    if (nextAccountNumber !== undefined) {
      updateValues.accountNumber = nextAccountNumber;
    }

    const [updated] = await db
      .update(organizations)
      .set(updateValues)
      .where(eq(organizations.id, organizationId))
      .returning();

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
    await requireMembership(
      (req as any).auth.userId,
      organizationId
    );

    const memberships =
      await db.query.organizationMemberships.findMany({
        where: eq(
          organizationMemberships.labId,
          organizationId
        ),
      });
    const userIds = memberships.map((m: any) => m.userId);
    const allUsers = userIds.length
      ? await db.query.users.findMany({
          where: inArray(users.id, userIds),
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
            }
          : null,
      }))
    );
  })
);

const inviteSchema = z.object({
  email: z.string().email(),
  phone: z.string().optional(),
  roleToAssign: z.enum(["owner", "admin", "user", "billing", "read_only"]),
  expiresInDays: z.coerce.number().int().min(1).max(30).default(7),
});

router.post(
  "/:organizationId/invites",
  asyncHandler(async (req, res) => {
    const organizationId = req.params.organizationId;
    await requireAnyRole(
      (req as any).auth.userId,
      organizationId,
      ADMIN_ROLES
    );
    const input = inviteSchema.parse(req.body);

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

    try {
      const [organization, inviter] = await Promise.all([
        db.query.organizations.findFirst({
          where: eq(organizations.id, organizationId),
        }),
        db.query.users.findFirst({
          where: eq(users.id, (req as any).auth.userId),
        }),
      ]);
      const inviterName = inviter
        ? [inviter.firstName, inviter.lastName]
            .filter((part) => !!part && String(part).trim().length > 0)
            .join(" ")
            .trim() || inviter.username || inviter.email || null
        : null;
      const invitePlacements = resolveLogoplacements(organization);
      const labLogoUrl =
        invitePlacements.has("welcome_emails") && organization?.logoUrl
          ? `${getAppBaseUrl()}${organization.logoUrl}`
          : null;
      const result = await sendInviteEmail({
        to: invite.email!,
        organizationName:
          organization?.displayName?.trim() ||
          organization?.name ||
          "your organization",
        roleToAssign: invite.roleToAssign!,
        token: invite.token!,
        inviterName,
        expiresAt: invite.expiresAt ?? null,
        labLogoUrl,
      });
      if (!result.sent) {
        req.log.warn(
          { inviteId: invite.id, reason: result.reason },
          "invite email not sent"
        );
      }
    } catch (err: any) {
      req.log.error(
        { err: err?.message || String(err), inviteId: invite.id },
        "invite email failed"
      );
    }

    return ok(res, invite, 201);
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
    const invites = await db.query.organizationInvites.findMany({
      where: eq(organizationInvites.labId, organizationId),
    });
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

    try {
      const [organization, inviter] = await Promise.all([
        db.query.organizations.findFirst({
          where: eq(organizations.id, invite.labId),
        }),
        db.query.users.findFirst({
          where: eq(users.id, (req as any).auth.userId),
        }),
      ]);
      const inviterName = inviter
        ? [inviter.firstName, inviter.lastName]
            .filter((part) => !!part && String(part).trim().length > 0)
            .join(" ")
            .trim() || inviter.username || inviter.email || null
        : null;
      const resendPlacements = resolveLogoplacements(organization);
      const labLogoUrl =
        resendPlacements.has("welcome_emails") && organization?.logoUrl
          ? `${getAppBaseUrl()}${organization.logoUrl}`
          : null;
      const result = await sendInviteEmail({
        to: updatedInvite.email!,
        organizationName:
          organization?.displayName?.trim() ||
          organization?.name ||
          "your organization",
        roleToAssign: updatedInvite.roleToAssign!,
        token: updatedInvite.token!,
        inviterName,
        expiresAt: updatedInvite.expiresAt ?? null,
        labLogoUrl,
      });
      if (!result.sent) {
        req.log.warn(
          { inviteId: updatedInvite.id, reason: result.reason },
          "invite resend email not sent"
        );
      }
    } catch (err: any) {
      req.log.error(
        { err: err?.message || String(err), inviteId: updatedInvite.id },
        "invite resend email failed"
      );
    }

    return ok(res, { ...updatedInvite, organizationId: updatedInvite.labId });
  })
);

router.post(
  "/invites/:inviteId/decline",
  asyncHandler(async (req, res) => {
    const invite = await db.query.organizationInvites.findFirst({
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

    return ok(res, updatedInvite);
  })
);

router.post(
  "/invites/:token/accept",
  asyncHandler(async (req, res) => {
    const invite = await db.query.organizationInvites.findFirst({
      where: and(
        eq(organizationInvites.token, req.params.token),
        eq(organizationInvites.status, "pending")
      ),
    });
    if (!invite) throw new HttpError(404, "Invite not found or already used.");
    if (!invite.roleToAssign || !invite.email)
      throw new HttpError(410, "Invite is invalid or incomplete.");
    if (invite.expiresAt && new Date() > invite.expiresAt)
      throw new HttpError(410, "Invite has expired.");

    const userId = (req as any).auth.userId;
    const currentEmail = (req as any).user.email?.toLowerCase?.().trim?.();

    if (!currentEmail || invite.email.toLowerCase() !== currentEmail) {
      throw new HttpError(403, "This invite does not belong to your account.");
    }

    const assignedRole = invite.roleToAssign;

    await db
      .insert(organizationMemberships)
      .values({
        labId: invite.labId,
        userId,
        role: assignedRole,
        status: "active",
        invitedByUserId: invite.invitedByUserId,
        approvedByUserId: invite.invitedByUserId,
        joinedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          organizationMemberships.labId,
          organizationMemberships.userId,
        ],
        set: {
          role: assignedRole,
          status: "active",
          invitedByUserId: invite.invitedByUserId,
          joinedAt: new Date(),
        },
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

    return ok(res, { accepted: true });
  })
);

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

    const [request] = await db
      .insert(organizationJoinRequests)
      .values({
        labId: organizationId,
        userId: (req as any).auth.userId,
        requestedRole: input.requestedRole,
        message: input.message ?? null,
      })
      .returning();

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
    const requests = await db.query.organizationJoinRequests.findMany({
      where: and(
        eq(organizationJoinRequests.userId, currentUserId),
        eq(organizationJoinRequests.status, "pending")
      ),
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
    await requireAnyRole(
      (req as any).auth.userId,
      organizationId,
      ADMIN_ROLES
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

    await requireAnyRole(
      (req as any).auth.userId,
      request.labId,
      ADMIN_ROLES
    );

    if (request.status === "approved") {
      const existingMembership =
        await db.query.organizationMemberships.findFirst({
          where: and(
            eq(organizationMemberships.labId, request.labId),
            eq(organizationMemberships.userId, request.userId)
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

    const roleToAssign = req.body.role || request.requestedRole;

    const [membership] = await db
      .insert(organizationMemberships)
      .values({
        labId: request.labId,
        userId: request.userId,
        role: roleToAssign,
        status: "active",
        approvedByUserId: (req as any).auth.userId,
        joinedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          organizationMemberships.labId,
          organizationMemberships.userId,
        ],
        set: {
          role: roleToAssign,
          status: "active",
          approvedByUserId: (req as any).auth.userId,
          joinedAt: new Date(),
        },
      })
      .returning();

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

    if (request.status !== "pending") {
      throw new HttpError(409, "Only pending join requests can be cancelled.");
    }

    const [updated] = await db
      .update(organizationJoinRequests)
      .set({
        status: "cancelled",
        reviewedByUserId: (req as any).auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(organizationJoinRequests.id, request.id))
      .returning();

    await writeAuditLog({
      req,
      labId: request.labId,
      action: "organization_join_cancelled",
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

    await requireAnyRole(
      (req as any).auth.userId,
      request.labId,
      ADMIN_ROLES
    );

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

const logoPlacementsBodySchema = z.object({
  placements: z
    .array(z.enum(LOGO_PLACEMENT_KEYS))
    .max(LOGO_PLACEMENT_KEYS.length),
});

router.patch(
  "/:organizationId/logo-placements",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.params;
    await resolveOrgAdminAccess((req as any).auth.userId, organizationId);

    const { placements } = logoPlacementsBodySchema.parse(req.body);

    const existing = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });
    if (!existing) throw new HttpError(404, "Organization not found.");

    const [updated] = await db
      .update(organizations)
      .set({ logoplacements: placements, updatedAt: new Date() })
      .where(eq(organizations.id, organizationId))
      .returning();

    await writeAuditLog({
      req,
      labId: organizationId,
      action: "organization_logo_placements_updated",
      entityType: "organization",
      entityId: organizationId,
      beforeJson: { placements: existing.logoplacements },
      afterJson: { placements },
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

export default router;
