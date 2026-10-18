import { Router, type RequestHandler } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  auditLogs,
  db,
  organizationMemberships,
  organizations,
  subscriptionEvents,
  subscriptions,
  users,
} from "@workspace/db";
import { appendSubscriptionEvent, PROVIDER_PLANS } from "../lib/entitlement";
import { writeAuditLog } from "../lib/audit";
import { HttpError } from "../lib/http";
import { canonicalDirectory, subscriptionSummary } from "../lib/subscription-summary";
import {
  assertCustomAccountNumberAvailable,
  withAccountNumberLock,
} from "../lib/provider-account-number";

/** These are deliberately server-owned values; an administrator cannot invent a plan. */
export const PROVIDER_SUBSCRIPTION_PLANS = Object.keys(PROVIDER_PLANS) as Array<keyof typeof PROVIDER_PLANS>;
const PROVIDER_STATUSES = ["trialing", "active", "past_due", "grace", "locked", "canceled", "legacy_free", "deactivated"] as const;
const ORG_SUBJECT_TYPES = ["provider_org", "lab_org"] as const;

type SubscriptionRow = typeof subscriptions.$inferSelect;
const subscriptionFields: any = subscriptions;

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function publicSubscription(row: any, now = new Date()) {
  const plan = row.providerPlan && row.providerPlan in PROVIDER_PLANS
    ? row.providerPlan as keyof typeof PROVIDER_PLANS
    : null;
  const waiverActive = Boolean(
    row.waiverReason &&
    row.waiverStartsAt &&
    row.waiverStartsAt <= now &&
    (!row.waiverEndsAt || row.waiverEndsAt > now),
  );
  return {
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    provider: row.provider,
    providerPlan: row.providerPlan ?? null,
    monthlyPriceUsd: plan ? PROVIDER_PLANS[plan].monthlyPriceUsd : null,
    capabilities: plan ? PROVIDER_PLANS[plan].capabilities : [],
    status: row.status,
    waiverReason: row.waiverReason ?? null,
    waiverStartsAt: iso(row.waiverStartsAt),
    waiverEndsAt: iso(row.waiverEndsAt),
    waiverGrantedAt: iso(row.waiverGrantedAt),
    waiverGrantedByUserId: row.waiverGrantedByUserId ?? null,
    waiverActive,
    currentPeriodEnd: iso(row.currentPeriodEnd),
    trialEndAt: iso(row.trialEndAt),
    canceledAt: iso(row.canceledAt),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    paymentMethodOnFile: row.paymentMethodOnFile,
    processorState: {
      provider: row.provider,
      hasStripeCustomer: Boolean(row.stripeCustomerId),
      hasStripeSubscription: Boolean(row.stripeSubscriptionId),
      hasRevenueCatAccount: Boolean(row.revenueCatAppUserId),
    },
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function parseOptionalDate(value: unknown, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be an ISO date.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be an ISO date.`);
  return date;
}

async function findSubscription(id: string): Promise<SubscriptionRow | undefined> {
  const [row] = await db.select().from(subscriptions).where(and(eq(subscriptions.id, id), isNull(subscriptions.deletedAt)));
  return row;
}

async function recordMutation(req: any, row: any, action: string, before: unknown, after: unknown) {
  await appendSubscriptionEvent({
    subscriptionId: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    provider: row.provider,
    eventType: action,
    statusBefore: (before as any)?.status ?? null,
    statusAfter: (after as any)?.status ?? null,
    rawPayloadJson: { actorUserId: req.auth.userId, before, after },
  });
  await writeAuditLog({
    req,
    userId: req.auth.userId,
    organizationId: ORG_SUBJECT_TYPES.includes(row.subjectType) ? row.subjectId : null,
    action,
    entityType: "subscription",
    entityId: row.id,
    beforeJson: before,
    afterJson: after,
  });
}

/**
 * Routes which alter provider access.  The supplied guard must authenticate a
 * real user and verify that their platform-admin unlock belongs to that user;
 * this module never accepts a service secret as a substitute.
 */
export function createAdminProviderSubscriptionRouter(requireCreatorAdmin: RequestHandler) {
  const router = Router();
  router.use(requireCreatorAdmin);

  router.get("/", async (req, res) => {
    try {
      const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const plan = typeof req.query.plan === "string" ? req.query.plan : undefined;
      const accountType = typeof req.query.accountType === "string"
        ? req.query.accountType.toLowerCase()
        : undefined;
      const waiver = typeof req.query.waiver === "string"
        ? req.query.waiver.toLowerCase()
        : undefined;
      const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
      const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 100);
      const offset = Math.max(Number.parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
      const conditions: any[] = [isNull(subscriptions.deletedAt)];
      const where = and(...conditions);
      // Identity, account type, free-text search, and effective waiver state are
      // resolved below. Filter that enriched directory before slicing so totals
      // and pagination describe the same result set. Task 4078 tracks moving
      // this resolution into an indexed query as the directory grows.
      const rows = await db
        .select()
        .from(subscriptions)
        .where(where)
        .orderBy(desc(subscriptions.createdAt));
      const orgIds = rows.filter((r) => ORG_SUBJECT_TYPES.includes(r.subjectType as any)).map((r) => r.subjectId);
      const userIds = rows.filter((r) => !ORG_SUBJECT_TYPES.includes(r.subjectType as any)).map((r) => r.subjectId);
      const [directOrgRows, userRows] = await Promise.all([
        orgIds.length ? db.select({ id: organizations.id, name: organizations.name, type: organizations.type, accountNumber: organizations.accountNumber, addressLine1: organizations.addressLine1, addressLine2: organizations.addressLine2, city: organizations.city, state: organizations.state, zip: organizations.zip }).from(organizations).where(inArray(organizations.id, orgIds)) : [],
         userIds.length ? db.select({ id: users.id, username: users.username, email: users.email, firstName: users.firstName, lastName: users.lastName, userType: users.userType, platformAccountNumber: users.platformAccountNumber }).from(users).where(inArray(users.id, userIds)) : [],
      ]);
      const legacyMemberships = userIds.length
        ? await db
            .select({
              userId: organizationMemberships.userId,
              organizationId: organizationMemberships.labId,
            })
            .from(organizationMemberships)
            .where(
              and(
                inArray(organizationMemberships.userId, userIds),
                eq(organizationMemberships.status, "active"),
                isNull(organizationMemberships.deletedAt),
              ),
            )
        : [];
      const legacyOrgIds = [...new Set(legacyMemberships.map((row) => row.organizationId))];
      const legacyOrgRows = legacyOrgIds.length
        ? await db
            .select({
              id: organizations.id,
              name: organizations.name,
              type: organizations.type,
              accountNumber: organizations.accountNumber,
              addressLine1: organizations.addressLine1,
              addressLine2: organizations.addressLine2,
              city: organizations.city,
              state: organizations.state,
              zip: organizations.zip,
            })
            .from(organizations)
            .where(
              and(
                inArray(organizations.id, legacyOrgIds),
                 inArray(organizations.type, ["provider", "lab"]),
                isNull(organizations.deletedAt),
              ),
            )
        : [];
      const orgRows = [...directOrgRows, ...legacyOrgRows];
      const orgById = new Map(orgRows.map((row) => [row.id, row]));
      const userById = new Map(userRows.map((row) => [row.id, row]));
      const providerOrgIdsByUser = new Map<string, string[]>();
      for (const membership of legacyMemberships) {
        if (!orgById.has(membership.organizationId)) continue;
        const ids = providerOrgIdsByUser.get(membership.userId) ?? [];
        ids.push(membership.organizationId);
        providerOrgIdsByUser.set(membership.userId, ids);
      }
      const enriched = rows.map((row: any) => {
        const accountUser = userById.get(row.subjectId);
        const expectedType = row.subjectType === "provider_user" || accountUser?.userType === "provider" ? "provider" : "lab";
        const legacyProviderOrgIds = (providerOrgIdsByUser.get(row.subjectId) ?? []).filter(id => orgById.get(id)?.type === expectedType);
        const org = orgById.get(
          ORG_SUBJECT_TYPES.includes(row.subjectType)
            ? row.subjectId
            : legacyProviderOrgIds.length === 1
              ? legacyProviderOrgIds[0]!
              : "",
        );
        const user = userById.get(row.subjectId);
        const accountHolderName =
          org?.name ??
          (user
            ? [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username
            : row.subjectId);
        return {
          ...publicSubscription(row),
          organization: org
            ? {
                ...org,
                formattedAddress: [org.addressLine1, org.addressLine2, [org.city, org.state, org.zip].filter(Boolean).join(", ")]
                  .filter(Boolean)
                  .join(", "),
              }
            : null,
          formattedAddress: org
            ? [org.addressLine1, org.addressLine2, [org.city, org.state, org.zip].filter(Boolean).join(", ")]
                .filter(Boolean)
                .join(", ")
            : null,
          account: user ? { id: user.id, name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username, email: user.email } : null,
          accountHolderName,
          accountType: org?.type === "provider" ? "Provider" : org?.type === "lab" ? "Lab" : null,
          canonicalAccountNumber: org?.accountNumber ?? user?.platformAccountNumber ?? null,
           canonicalSubjectType: org ? `${org.type}_org` : row.subjectType === "provider_user" ? "user" : row.subjectType,
           canonicalSubjectId: org ? org.id : row.subjectId,
        };
      });
      const directory = canonicalDirectory(enriched).filter((item) => {
        if (provider && ["stripe", "revenuecat", "none"].includes(provider) && item.provider !== provider) return false;
        if (status && (PROVIDER_STATUSES as readonly string[]).includes(status) && item.status !== status) return false;
        if (plan && (PROVIDER_SUBSCRIPTION_PLANS as readonly string[]).includes(plan) && item.providerPlan !== plan) return false;
        if (q && !JSON.stringify(item).toLowerCase().includes(q)) return false;
        if (accountType && item.accountType?.toLowerCase() !== accountType) return false;
        if (waiver) {
          const starts = item.waiverStartsAt ? new Date(item.waiverStartsAt).getTime() : null;
          const now = Date.now();
          const state = item.waiverActive
            ? "active"
            : !item.waiverReason
              ? "none"
              : starts && starts > now
                ? "scheduled"
                : "expired";
          if (state !== waiver) return false;
        }
        return true;
      });
      const items = directory.slice(offset, offset + limit);
      const paid = await db.execute(sql`
        SELECT DISTINCT r.subscription_id AS id FROM subscription_receipts r
        WHERE r.kind = 'receipt' AND r.unavailable_reason IS NULL AND r.amount_minor > 0
          AND r.coverage_starts_at <= now() AND r.coverage_ends_at > now()
          AND r.amount_minor > COALESCE((SELECT SUM(f.amount_minor) FROM subscription_receipts f
            WHERE f.kind = 'refund' AND f.provider = r.provider AND f.parent_external_id = r.external_id
              AND f.currency = r.currency AND f.unavailable_reason IS NULL), 0)`);
      const paidIds = new Set((paid.rows as { id: string }[]).map(row => row.id));
      const paidAccounts = new Set(enriched.filter(row => paidIds.has(row.id)).map(row => `${row.canonicalSubjectType}:${row.canonicalSubjectId}`));
      for (const row of directory) {
        if (paidAccounts.has(`${row.canonicalSubjectType}:${row.canonicalSubjectId}`)) paidIds.add(row.id);
      }
      return res.json({
        ok: true,
        items,
        total: directory.length,
        summary: subscriptionSummary(directory, paidIds),
        limit,
        offset,
        plans: Object.entries(PROVIDER_PLANS).map(([id, definition]) => ({
          id,
          ...definition,
        })),
      });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message ?? "Failed to list provider subscriptions." });
    }
  });

  router.patch("/:id", async (req: any, res) => {
    const row = await findSubscription(req.params.id);
    if (!row) return res.status(404).json({ error: "Subscription not found." });
    const { providerPlan, status } = req.body ?? {};
    if (providerPlan === undefined && status === undefined) return res.status(400).json({ error: "providerPlan or status is required." });
    if (providerPlan !== undefined && !(PROVIDER_SUBSCRIPTION_PLANS as readonly string[]).includes(providerPlan)) return res.status(400).json({ error: "Invalid provider plan." });
    if (status !== undefined && !(PROVIDER_STATUSES as readonly string[]).includes(status)) return res.status(400).json({ error: "Invalid subscription status." });
    if (providerPlan !== undefined && row.subjectType !== "provider_org" && row.subjectType !== "provider_user") {
      return res.status(400).json({ error: "Provider plans can only be assigned to provider accounts." });
    }
    const before = publicSubscription(row);
    const lifecycleUpdate = status === undefined
      ? {}
      : status === "canceled"
        ? { canceledAt: (row as any).canceledAt ?? new Date(), cancelAtPeriodEnd: false }
        : { canceledAt: null, cancelAtPeriodEnd: false };
    const [updated] = await db.update(subscriptions).set({
      ...(providerPlan !== undefined ? { providerPlan } : {}),
      ...(status !== undefined ? { status } : {}),
      ...lifecycleUpdate,
      updatedAt: new Date(),
    } as any).where(eq(subscriptions.id, row.id)).returning();
    if (!updated) throw new HttpError(500, "Subscription update did not return a record.");
    const after = publicSubscription(updated);
    await recordMutation(req, row, "provider_subscription_updated", before, after);
    return res.json({ ok: true, subscription: after });
  });

  router.patch("/:id/account-number", async (req: any, res) => {
    const row = await findSubscription(req.params.id);
    if (!row || row.subjectType !== "provider_org") return res.status(404).json({ error: "Provider organization subscription not found." });
    const accountNumber = typeof req.body?.accountNumber === "string" ? req.body.accountNumber.trim() : "";
    const [organization] = await db.select().from(organizations).where(eq(organizations.id, row.subjectId));
    if (!organization || organization.type !== "provider") return res.status(404).json({ error: "Provider organization not found." });
    if (!organization.parentLabOrganizationId) return res.status(409).json({ error: "Provider organization is not linked to a parent lab." });
    try {
      const updated = await withAccountNumberLock(
        organization.parentLabOrganizationId,
        async (client) => {
          const validated = await assertCustomAccountNumberAvailable(
            organization.parentLabOrganizationId!,
            accountNumber,
            organization.id,
            client,
          );
          const [result] = await (client as typeof db)
            .update(organizations)
            .set({ accountNumber: validated })
            .where(eq(organizations.id, organization.id))
            .returning();
          if (!result) throw new HttpError(500, "Account number update did not return a record.");
          return result;
        },
      );
      await recordMutation(req, row, "provider_subscription_account_number_corrected", { organizationId: organization.id, accountNumber: organization.accountNumber }, { organizationId: updated.id, accountNumber: updated.accountNumber });
      return res.json({ ok: true, organization: { id: updated.id, accountNumber: updated.accountNumber } });
    } catch (error: any) {
      const status = error?.status === 409 || error?.statusCode === 409 ? 409 : 500;
      return res.status(status).json({ error: error?.message ?? "Failed to correct account number." });
    }
  });

  router.put("/:id/waiver", async (req: any, res) => {
    const row = await findSubscription(req.params.id);
    if (!row) return res.status(404).json({ error: "Subscription not found." });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) return res.status(400).json({ error: "A waiver reason is required." });
    try {
      const startsAt = parseOptionalDate(req.body?.startsAt, "startsAt") ?? new Date();
      const endsAt = parseOptionalDate(req.body?.endsAt, "endsAt") ?? null;
      if (endsAt && endsAt <= startsAt) return res.status(400).json({ error: "endsAt must be after startsAt." });
      const before = publicSubscription(row);
      const [updated] = await db.update(subscriptions).set({ waiverReason: reason, waiverStartsAt: startsAt, waiverEndsAt: endsAt, waiverGrantedAt: new Date(), waiverGrantedByUserId: req.auth.userId, updatedAt: new Date() } as any).where(eq(subscriptions.id, row.id)).returning();
      if (!updated) throw new HttpError(500, "Waiver update did not return a record.");
      const after = publicSubscription(updated);
      await recordMutation(req, row, (row as any).waiverReason ? "provider_subscription_waiver_replaced" : "provider_subscription_waiver_granted", before, after);
      return res.json({ ok: true, subscription: after });
    } catch (error: any) {
      return res.status(400).json({ error: error?.message ?? "Invalid waiver." });
    }
  });

  router.delete("/:id/waiver", async (req: any, res) => {
    const row = await findSubscription(req.params.id);
    if (!row) return res.status(404).json({ error: "Subscription not found." });
    if (!(row as any).waiverReason) return res.status(409).json({ error: "No active waiver to end." });
    const before = publicSubscription(row);
    const [updated] = await db.update(subscriptions).set({ waiverReason: null, waiverStartsAt: null, waiverEndsAt: new Date(), updatedAt: new Date() } as any).where(eq(subscriptions.id, row.id)).returning();
    if (!updated) throw new HttpError(500, "Waiver update did not return a record.");
    const after = publicSubscription(updated);
    await recordMutation(req, row, "provider_subscription_waiver_ended", before, after);
    return res.json({ ok: true, subscription: after });
  });

  router.get("/:id/history", async (req, res) => {
    const row = await findSubscription(req.params.id);
    if (!row) return res.status(404).json({ error: "Subscription not found." });
    const [events, audits] = await Promise.all([
      db.select().from(subscriptionEvents).where(eq(subscriptionEvents.subscriptionId, row.id)).orderBy(desc(subscriptionEvents.createdAt)).limit(200),
      db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "subscription"), eq(auditLogs.entityId, row.id))).orderBy(desc(auditLogs.createdAt)).limit(200),
    ]);
    return res.json({ ok: true, subscription: publicSubscription(row), events, audits });
  });
  return router;
}