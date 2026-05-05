import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { organizationMemberships } from "@workspace/db";
import { HttpError } from "./http";

export type MembershipRole = "owner" | "admin" | "user" | "billing" | "read_only";

export async function getActiveMembership(userId: string, organizationId: string) {
  const membership = await db.query.organizationMemberships.findFirst({
    where: and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.labId, organizationId),
      eq(organizationMemberships.status, "active")
    ),
  });
  return membership ?? null;
}

export async function requireMembership(userId: string, organizationId: string) {
  const membership = await getActiveMembership(userId, organizationId);
  if (!membership) {
    throw new HttpError(403, "You do not belong to this organization.");
  }
  return membership;
}

export async function requireAnyRole(userId: string, organizationId: string, roles: MembershipRole[]) {
  const membership = await requireMembership(userId, organizationId);
  if (!roles.includes(membership.role as MembershipRole)) {
    throw new HttpError(403, "You do not have permission for this action.");
  }
  return membership;
}

export const ADMIN_ROLES: MembershipRole[] = ["owner", "admin"];
export const BILLING_ROLES: MembershipRole[] = ["owner", "admin", "billing"];
