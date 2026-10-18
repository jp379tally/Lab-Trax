import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, organizationMemberships, organizations } from "@workspace/db";
import { HttpError } from "./http";
import { assertOrganizationMutationAllowed } from "./entitlement-write-guard";

/**
 * Resolve the provider practice selected for this request. The value is
 * client-provided only as a hint; membership, organization type, activity and
 * deletion are always checked against the database.
 */
export async function getActiveProviderOrganizations(userId: string, client: Pick<typeof db, "select"> = db) {
  const memberships = await client
    .select({ organizationId: organizationMemberships.labId })
    .from(organizationMemberships)
    .where(and(
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.status, "active"),
      isNull(organizationMemberships.deletedAt),
    ));
  const ids = [...new Set(memberships.map((m) => m.organizationId))];
  if (!ids.length) return [];
  return client.select().from(organizations).where(and(
    inArray(organizations.id, ids),
    eq(organizations.type, "provider"),
    eq(organizations.isActive, true),
    isNull(organizations.deletedAt),
  ));
}

export function chooseProviderOrganization<T extends { id: string }>(
  organizations: T[],
  requestedId?: string | null,
) {
  if (!organizations.length) throw new HttpError(403, "No active provider organization is assigned to this account.");
  const id = requestedId?.trim() || (organizations.length === 1 ? organizations[0].id : null);
  if (!id) throw new HttpError(409, "Select a practice before entering the provider portal.", { code: "PROVIDER_ORGANIZATION_REQUIRED" });
  const selected = organizations.find((organization) => organization.id === id);
  if (!selected) throw new HttpError(403, "That provider organization is not assigned to this account.");
  return selected;
}

export async function requireSelectedProviderOrganization(
  userId: string,
  requestedId?: string | null,
) {
  const selected = chooseProviderOrganization(
    await getActiveProviderOrganizations(userId),
    requestedId,
  );
  await assertOrganizationMutationAllowed(selected.id);
  return selected;
}