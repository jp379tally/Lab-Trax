import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { labMemberships } from "../../shared/schema";
import { HttpError } from "./http";

export type MembershipRole = "owner" | "admin" | "user" | "billing" | "read_only";

export async function getActiveMembership(userId: string, labId: string) {
  const membership = await db.query.labMemberships.findFirst({
    where: and(
      eq(labMemberships.userId, userId),
      eq(labMemberships.labId, labId),
      eq(labMemberships.status, "active")
    ),
  });
  return membership ?? null;
}

export async function requireMembership(userId: string, labId: string) {
  const membership = await getActiveMembership(userId, labId);
  if (!membership) {
    throw new HttpError(403, "You do not belong to this organization.");
  }
  return membership;
}

export async function requireAnyRole(userId: string, labId: string, roles: MembershipRole[]) {
  const membership = await requireMembership(userId, labId);
  if (!roles.includes(membership.role as MembershipRole)) {
    throw new HttpError(403, "You do not have permission for this action.");
  }
  return membership;
}

export const ADMIN_ROLES: MembershipRole[] = ["owner", "admin"];
export const BILLING_ROLES: MembershipRole[] = ["owner", "admin", "billing"];
