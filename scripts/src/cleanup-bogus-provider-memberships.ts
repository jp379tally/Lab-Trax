/**
 * One-shot cleanup: soft-deletes lab_memberships rows where a lab-type user
 * was incorrectly made an "owner" of a provider (practice) org when the lab
 * admin created that practice through POST /api/organizations.
 *
 * A lab-type user should never have a genuine membership in a provider org.
 * Provider orgs are client records linked to a lab via parentLabOrganizationId,
 * not orgs the lab user belongs to.
 *
 * organizationMemberships is in PROTECTED_TABLES, so this script uses
 * soft-delete (sets deleted_at / deleted_by_user_id) rather than a hard
 * db.delete().
 *
 * Idempotent: already-soft-deleted rows are skipped on re-runs (the WHERE
 * clause requires deleted_at IS NULL).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run cleanup-bogus-provider-memberships
 */

import { and, eq, isNull } from "drizzle-orm";
import { db, organizationMemberships, organizations, users } from "@workspace/db";

async function main() {
  console.log("Scanning for bogus lab-user → provider-org memberships...\n");

  // Find all active memberships where the org is a provider AND the user has
  // userType "lab". These were created by the create-org handler before the
  // fix was applied and represent the bug to clean up.
  const bogus = await db
    .select({
      membershipId: organizationMemberships.id,
      userId: organizationMemberships.userId,
      orgId: organizationMemberships.labId,
      role: organizationMemberships.role,
      userType: users.userType,
      orgName: organizations.name,
      orgType: organizations.type,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizationMemberships.labId, organizations.id))
    .innerJoin(users, eq(organizationMemberships.userId, users.id))
    .where(
      and(
        eq(organizations.type, "provider"),
        eq(users.userType, "lab"),
        isNull(organizationMemberships.deletedAt),
        isNull(organizations.deletedAt),
        isNull(users.deletedAt)
      )
    );

  if (bogus.length === 0) {
    console.log("No bogus memberships found. Nothing to do.");
    return;
  }

  console.log(`Found ${bogus.length} bogus membership(s) to remove:\n`);
  for (const row of bogus) {
    console.log(
      `  membership ${row.membershipId} — user ${row.userId} (userType=${row.userType}) ` +
        `is "${row.role}" of org "${row.orgName}" (${row.orgId}, type=${row.orgType})`
    );
  }

  console.log("\nSoft-deleting...\n");

  const now = new Date();
  let removed = 0;

  for (const row of bogus) {
    const updated = await db
      .update(organizationMemberships)
      .set({ deletedAt: now, deletedByUserId: null })
      .where(
        and(
          eq(organizationMemberships.id, row.membershipId),
          isNull(organizationMemberships.deletedAt)
        )
      )
      .returning();

    if (updated.length > 0) {
      console.log(`  [REMOVED] membership ${row.membershipId}`);
      removed++;
    } else {
      console.log(
        `  [SKIPPED] membership ${row.membershipId} — already deleted or not found`
      );
    }
  }

  console.log(
    `\nDone. ${removed} of ${bogus.length} bogus membership(s) soft-deleted.`
  );
  console.log(
    "Re-running this script is safe — already-deleted rows will be skipped."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
