import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  labMemberPermissions,
  labPermissionDefinitions,
  organizationMemberships,
} from "@workspace/db";
import { HttpError } from "./http";
import { logger } from "./logger";
import type { CapabilityKey } from "./capabilities";
import { assertOrganizationMutationAllowed } from "./entitlement-write-guard";

export type MembershipRole =
  | "owner"
  | "admin"
  | "user"
  | "billing"
  | "read_only";

/**
 * Every permission check in this module funnels through here, so this is the
 * single choke point that guards the database driver from ever seeing a
 * non-string `userId`. A caller that accidentally passes something else
 * (e.g. the whole Express `req` object instead of `req.auth.userId`) used to
 * reach `db.query.organizationMemberships.findFirst` with that value bound
 * as a query parameter, which throws deep inside the pg driver while trying
 * to serialize it ("Converting circular structure to JSON") and poisons the
 * pooled connection — breaking the *next*, unrelated request too. Rejecting
 * synchronously here keeps a bad call site's blast radius to its own request.
 */
export async function getActiveMembership(
  userId: string,
  organizationId: string
) {
  if (typeof userId !== "string" || userId.length === 0) {
    logger.error(
      { userIdType: typeof userId, organizationId },
      "getActiveMembership called with a non-string userId; refusing to query the database."
    );
    throw new HttpError(500, "Invalid user context for permission check.");
  }
  const membership = await db.query.organizationMemberships.findFirst({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.labId, organizationId),
      eq(organizationMemberships.status, "active"),
      isNull(organizationMemberships.deletedAt),
    ),
  });
  if (!membership) return null;
  await assertOrganizationMutationAllowed(organizationId);
  return membership;
}

export async function requireMembership(
  userId: string,
  organizationId: string
) {
  const membership = await getActiveMembership(userId, organizationId);
  if (!membership) {
    throw new HttpError(403, "You do not belong to this organization.");
  }
  return membership;
}

export async function requireAnyRole(
  userId: string,
  organizationId: string,
  roles: MembershipRole[]
) {
  const membership = await requireMembership(userId, organizationId);
  if (!roles.includes(membership.role as MembershipRole)) {
    throw new HttpError(403, "You do not have permission for this action.");
  }
  return membership;
}

export const OWNER_ROLES: MembershipRole[] = ["owner"];
export const ADMIN_ROLES: MembershipRole[] = ["owner", "admin"];
export const BILLING_ROLES: MembershipRole[] = ["owner", "admin", "billing"];

/**
 * Require that `userId` has a specific capability in `organizationId`.
 * Throws HttpError(403) if the user has no active membership or lacks the
 * capability (either via their base role or an explicit permission grant).
 * Owners and admins implicitly hold every capability.
 */
export async function requireCapability(
  userId: string,
  organizationId: string,
  capabilityKey: CapabilityKey
): Promise<void> {
  const allowed = await hasCapability(userId, organizationId, capabilityKey);
  if (!allowed) {
    throw new HttpError(403, "You do not have permission for this action.");
  }
}

/**
 * Check whether `userId` has a specific capability in `organizationId`.
 *
 * Returns true if:
 *  - The member's base role inherently covers the capability (owners and
 *    admins are considered to have all capabilities), OR
 *  - The member has an explicit custom-permission grant for a definition
 *    whose capabilityKey matches.
 *
 * Returns false if the user has no active membership or no matching grant.
 * Never throws — callers may use this for conditional UI logic.
 */
export async function hasCapability(
  userId: string,
  organizationId: string,
  capabilityKey: CapabilityKey
): Promise<boolean> {
  const membership = await getActiveMembership(userId, organizationId);
  if (!membership) return false;

  // Owners and admins implicitly hold all capabilities.
  const role = membership.role as MembershipRole;
  if (role === "owner" || role === "admin") return true;

  // For other roles, check explicit custom-permission grants.
  const matchingDefs = await db.query.labPermissionDefinitions.findMany({
    where: and(
      eq(labPermissionDefinitions.labId, organizationId),
      eq(labPermissionDefinitions.capabilityKey, capabilityKey)
    ),
  });
  if (matchingDefs.length === 0) return false;

  const defIds = matchingDefs.map((d) => d.id);
  const grant = await db.query.labMemberPermissions.findFirst({
    where: and(
      eq(labMemberPermissions.membershipId, membership.id),
      inArray(labMemberPermissions.permissionDefinitionId, defIds)
    ),
  });
  return grant !== undefined;
}
