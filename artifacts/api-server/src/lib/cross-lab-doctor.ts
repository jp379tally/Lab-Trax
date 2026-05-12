/**
 * Helpers for the cross-lab doctor identity / Link Labs feature (Task #320).
 *
 * The "linked doctor" set for a user is the transitive closure over
 * `doctor_account_links`. The two design constraints:
 *  - Lab-side endpoints (cases / invoices listed for a lab user) must NOT
 *    expand membership; a lab only ever sees its own data.
 *  - Provider-side endpoints (cases / invoices listed for a provider user)
 *    MUST include data from every linked-doctor copy so the doctor sees one
 *    unified worklist across all their labs.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  doctorAccountLinks,
  organizationMemberships,
  organizations,
} from "@workspace/db";

/**
 * Return the set of user ids transitively linked to `userId` (including
 * `userId` itself). Bounded BFS so a corrupted graph cannot loop forever.
 */
export async function getLinkedDoctorUserIds(
  userId: string
): Promise<string[]> {
  const visited = new Set<string>([userId]);
  let frontier: string[] = [userId];
  // 6 hops is plenty — each provider doctor has at most a handful of labs.
  for (let depth = 0; depth < 6 && frontier.length > 0; depth++) {
    const links = await db
      .select()
      .from(doctorAccountLinks)
      .where(
        or(
          inArray(doctorAccountLinks.userIdLow, frontier),
          inArray(doctorAccountLinks.userIdHigh, frontier)
        )
      );
    const next: string[] = [];
    for (const link of links) {
      for (const id of [link.userIdLow, link.userIdHigh]) {
        if (!visited.has(id)) {
          visited.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }
  return Array.from(visited);
}

/**
 * Return the active organization-membership lab ids that the supplied user
 * (and any linked-doctor copies) belong to. Used by provider-side list
 * endpoints to expand `membershipOrgIds` across all linked doctor accounts.
 *
 * Only provider-type organizations are included — a lab membership held by a
 * doctor's account does not bleed cross-lab data into the lab side.
 */
export async function getProviderOrgIdsForUserAndLinks(
  userId: string,
  options: { includeLabMemberships?: boolean } = {}
): Promise<{
  allOrgIds: string[];
  providerOrgIds: string[];
  linkedUserIds: string[];
}> {
  const userIds = await getLinkedDoctorUserIds(userId);
  const memberships = await db.query.organizationMemberships.findMany({
    where: and(
      inArray(organizationMemberships.userId, userIds),
      eq(organizationMemberships.status, "active")
    ),
  });
  const orgIds = Array.from(
    new Set(memberships.map((m: any) => m.labId as string))
  );
  if (orgIds.length === 0) {
    return { allOrgIds: [], providerOrgIds: [], linkedUserIds: userIds };
  }
  const orgRows = await db
    .select()
    .from(organizations)
    .where(inArray(organizations.id, orgIds));
  const providerOrgIds = orgRows
    .filter((o: any) => o.type === "provider")
    .map((o: any) => o.id);
  const allOrgIds = options.includeLabMemberships ? orgIds : providerOrgIds;
  return { allOrgIds, providerOrgIds, linkedUserIds: userIds };
}

/**
 * Order a user-id pair canonically (low, high) so the unique index on
 * `doctor_account_links` covers the unordered pair.
 */
export function canonicalLinkPair(
  a: string,
  b: string
): { low: string; high: string } | null {
  if (a === b) return null;
  return a < b ? { low: a, high: b } : { low: b, high: a };
}
