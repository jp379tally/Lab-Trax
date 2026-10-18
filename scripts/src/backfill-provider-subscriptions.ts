/**
 * Idempotent transition to provider-organization subscription subjects.
 *
 * Existing provider organizations receive Premium plus an indefinite,
 * explicitly-audited transition waiver so enabling the plan gates cannot
 * remove portal access before payment collection is enabled. Existing explicit
 * plans and waivers are preserved. Legacy provider-user subscriptions are
 * moved to their sole active provider organization when no canonical row
 * already exists; ambiguous users are reported and left untouched.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-provider-subscriptions -- --dry-run
 *   pnpm --filter @workspace/scripts run backfill-provider-subscriptions
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  organizationMemberships,
  organizations,
  pool,
  subscriptionEvents,
  subscriptions,
} from "@workspace/db";

const dryRun = process.argv.includes("--dry-run");
const TRANSITION_PROVIDER = "internal";
const WAIVER_REASON =
  "Temporary fee waiver while provider payment collection is disabled";

async function main(): Promise<void> {
  const providerOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.type, "provider"), isNull(organizations.deletedAt)));
  const providerOrgIds = providerOrgs.map((row) => row.id);

  const memberships = providerOrgIds.length
    ? await db
        .select({
          userId: organizationMemberships.userId,
          providerOrgId: organizationMemberships.labId,
        })
        .from(organizationMemberships)
        .where(
          and(
            inArray(organizationMemberships.labId, providerOrgIds),
            eq(organizationMemberships.status, "active"),
            isNull(organizationMemberships.deletedAt),
          ),
        )
    : [];

  const orgsByUser = new Map<string, Set<string>>();
  for (const membership of memberships) {
    const ids = orgsByUser.get(membership.userId) ?? new Set<string>();
    ids.add(membership.providerOrgId);
    orgsByUser.set(membership.userId, ids);
  }

  const existing = await db
    .select()
    .from(subscriptions)
    .where(isNull(subscriptions.deletedAt));
  const canonicalByOrg = new Map(
    existing
      .filter((row) => row.subjectType === "provider_org")
      .map((row) => [row.subjectId, row] as const),
  );

  let migratedLegacy = 0;
  let created = 0;
  let transitioned = 0;
  let ambiguous = 0;

  for (const legacy of existing.filter(
    (row) => row.subjectType === "provider_user" || row.subjectType === "user",
  )) {
    const orgIds = [...(orgsByUser.get(legacy.subjectId) ?? [])];
    if (orgIds.length !== 1) {
      if (orgIds.length > 1) ambiguous++;
      continue;
    }
    const providerOrgId = orgIds[0]!;
    if (canonicalByOrg.has(providerOrgId)) continue;
    if (!dryRun) {
      await db
        .update(subscriptions)
        .set({
          subjectType: "provider_org",
          subjectId: providerOrgId,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, legacy.id));
    }
    canonicalByOrg.set(providerOrgId, {
      ...legacy,
      subjectType: "provider_org",
      subjectId: providerOrgId,
    });
    migratedLegacy++;
  }

  for (const providerOrgId of providerOrgIds) {
    let subscription = canonicalByOrg.get(providerOrgId);
    const eventId = `provider-subscription-transition-v1:${providerOrgId}`;
    const [alreadyApplied] = await db
      .select({ id: subscriptionEvents.id })
      .from(subscriptionEvents)
      .where(
        and(
          eq(subscriptionEvents.provider, TRANSITION_PROVIDER),
          eq(subscriptionEvents.externalEventId, eventId),
        ),
      )
      .limit(1);
    if (alreadyApplied) continue;

    const before = subscription
      ? {
          providerPlan: subscription.providerPlan,
          waiverReason: subscription.waiverReason,
          waiverStartsAt: subscription.waiverStartsAt,
          waiverEndsAt: subscription.waiverEndsAt,
        }
      : null;
    const now = new Date();

    if (!dryRun) {
      await db.transaction(async (tx) => {
        if (!subscription) {
          [subscription] = await tx
            .insert(subscriptions)
            .values({
              subjectType: "provider_org",
              subjectId: providerOrgId,
              provider: "none",
              status: "legacy_free",
              providerPlan: "premium",
              waiverReason: WAIVER_REASON,
              waiverStartsAt: now,
              waiverEndsAt: null,
              waiverGrantedAt: now,
            })
            .returning();
          created++;
        } else {
          const updates = {
            ...(subscription.providerPlan ? {} : { providerPlan: "premium" }),
            ...(subscription.waiverReason
              ? {}
              : {
                  waiverReason: WAIVER_REASON,
                  waiverStartsAt: now,
                  waiverEndsAt: null,
                  waiverGrantedAt: now,
                }),
            updatedAt: now,
          };
          [subscription] = await tx
            .update(subscriptions)
            .set(updates)
            .where(eq(subscriptions.id, subscription.id))
            .returning();
          transitioned++;
        }

        await tx
          .insert(subscriptionEvents)
          .values({
            subscriptionId: subscription!.id,
            subjectType: "provider_org",
            subjectId: providerOrgId,
            eventType: "provider_subscription_transitioned",
            provider: TRANSITION_PROVIDER,
            externalEventId: eventId,
            statusBefore: subscription!.status,
            statusAfter: subscription!.status,
            rawPayloadJson: {
              actorUserId: null,
              source: "provider-subscription-transition-v1",
              before,
              after: {
                providerPlan: subscription!.providerPlan,
                waiverReason: subscription!.waiverReason,
                waiverStartsAt: subscription!.waiverStartsAt,
                waiverEndsAt: subscription!.waiverEndsAt,
              },
            },
          })
          .onConflictDoNothing();
      });
    } else if (subscription) {
      transitioned++;
    } else {
      created++;
    }
  }

  console.log(
    JSON.stringify({
      mode: dryRun ? "dry-run" : "write",
      providerOrganizations: providerOrgIds.length,
      migratedLegacy,
      created,
      transitioned,
      ambiguousLegacyUsers: ambiguous,
    }),
  );
}

main()
  .catch((error) => {
    console.error("[backfill-provider-subscriptions] fatal:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });