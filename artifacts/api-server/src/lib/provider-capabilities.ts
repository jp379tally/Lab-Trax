import type { RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { cases, db } from "@workspace/db";
import { HttpError } from "./http";
import { getEntitlement, getSubjectForUser } from "./entitlement";
import { getProviderOrgIdsForUserAndLinks } from "./cross-lab-doctor";

/**
 * Provider portal features deliberately have a separate gate from billing
 * lockout.  In particular, a waived subscription can be read-only/full for
 * billing purposes while retaining the plan it was assigned.
 */
export type ProviderCapability =
  | "case_read"
  | "billing"
  | "communication"
  | "provider_portal";

type ProviderPlan = "free" | "basic" | "standard" | "premium";

function normalizePlan(value: unknown): ProviderPlan | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "free") return "free";
  if (text.includes("premium")) return "premium";
  if (text.includes("standard")) return "standard";
  if (text.includes("basic")) return "basic";
  return null;
}

function hasCapability(plan: ProviderPlan, capability: ProviderCapability) {
  if (plan === "premium") return true;
  if (capability === "case_read") return true;
  return plan === "standard" && capability === "billing";
}

/**
 * Applies a provider plan only when the authenticated user's billing subject
 * is a provider org. Lab memberships (including users that can access a
 * provider-facing resource through their lab role) intentionally pass through.
 *
 * Entitlement fields are read defensively because old subscriptions and
 * different billing providers have not always populated the same plan field.
 * Existing accounts are transitioned to an explicit Premium plan and waiver
 * by the idempotent provider-subscription backfill.
 */
export async function assertProviderCapability(
  userId: string,
  capability: ProviderCapability,
): Promise<void> {
  const subject = await getSubjectForUser(userId);
  if (subject.subjectType === "lab_org") return;
  if (subject.subjectType !== "provider_org") {
    const entitlement = await getEntitlement(subject);
    if (!entitlement?.providerPlan) return;
  }
  await assertProviderSubjectCapability(subject, capability);
}

/** Evaluate the subscription owned by an exact provider organization. */
export async function assertProviderOrganizationCapability(
  providerOrganizationId: string,
  capability: ProviderCapability,
): Promise<void> {
  await assertProviderSubjectCapability(
    { subjectType: "provider_org", subjectId: providerOrganizationId },
    capability,
  );
}

async function assertProviderSubjectCapability(
  subject: { subjectType: string; subjectId: string },
  capability: ProviderCapability,
): Promise<void> {

  const entitlement = await getEntitlement(subject);
  if ((entitlement.status === "free" || entitlement.status === "onboarding_pending") && capability !== "case_read") {
    throw new HttpError(403, "This provider account has case-viewing access only.");
  }
  const raw = entitlement as typeof entitlement & Record<string, unknown>;
  // Missing/unrecognized entitlements remain locked. Subscription read-only
  // state is enforced for unsafe HTTP methods by requireAuth, so capability
  // checks must continue allowing authorized retained-data reads.
  if (entitlement.accessLevel === "locked" && !entitlement.hasActiveWaiver) {
    throw new HttpError(403, "Your provider subscription is locked.");
  }
  const declaredCapabilities =
    raw.capabilities && typeof raw.capabilities === "object"
      ? raw.capabilities as Record<string, unknown>
      : null;
  const entitlementCapability =
    capability === "case_read"
      ? "active_case_view"
      : capability === "billing"
        ? "billing_view_pay"
        : capability === "communication"
          ? "lab_communication"
          : null;
  // Prefer the centrally calculated entitlement when it is available. This
  // keeps plan enforcement correct for waived subscriptions and for future
  // billing providers that do not expose a recognizable plan string.
  if (
    entitlementCapability &&
    typeof declaredCapabilities?.[entitlementCapability] === "boolean"
  ) {
    if (declaredCapabilities[entitlementCapability]) return;
    throw new HttpError(403, "Your provider plan does not include this feature.");
  }
  const plan =
    normalizePlan(raw.providerPlan) ??
    normalizePlan(raw.plan) ??
    normalizePlan(raw.planName) ??
    normalizePlan(raw.planType) ??
    normalizePlan(raw.stripePriceId) ??
    // Defensive compatibility for an older entitlement response during a
    // rolling deployment. Current responses always carry providerPlan.
    "premium";

  if (!hasCapability(plan, capability)) {
    throw new HttpError(
      403,
      `Your ${plan[0]!.toUpperCase()}${plan.slice(1)} provider plan does not include this feature.`,
    );
  }
}

/**
 * Unlike the user-preferred-subject check, this resolves every provider org
 * through which a mixed-identity user could act. This prevents a lab_org
 * preferred subject from bypassing a provider portal plan. No provider orgs
 * means the caller is using a lab-only path and is left to that route's
 * existing authorization.
 */
export async function assertLinkedProviderCapability(
  userId: string,
  capability: ProviderCapability,
): Promise<string[]> {
  await assertProviderCapability(userId, capability);
  const { providerOrgIds } = await getProviderOrgIdsForUserAndLinks(userId);
  await Promise.all(
    providerOrgIds.map((id) => assertProviderOrganizationCapability(id, capability)),
  );
  return providerOrgIds;
}

/** Returns false only for a provider subject explicitly assigned below Premium. */
export async function providerHasCapability(
  userId: string,
  capability: ProviderCapability,
): Promise<boolean> {
  try {
    await assertProviderCapability(userId, capability);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 403) return false;
    throw error;
  }
}

export async function linkedProviderHasCapability(
  userId: string,
  capability: ProviderCapability,
): Promise<boolean> {
  try {
    await assertLinkedProviderCapability(userId, capability);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 403) return false;
    throw error;
  }
}

export function requireProviderCapability(
  capability: ProviderCapability,
): RequestHandler {
  return async (req, _res, next) => {
    try {
      await assertProviderCapability((req as any).auth.userId as string, capability);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireLinkedProviderCapability(
  capability: ProviderCapability,
): RequestHandler {
  return async (req, _res, next) => {
    try {
      const selected = (req as any).providerOrganizationId as string | undefined;
      await assertProviderCapability((req as any).auth.userId as string, capability);
      if (selected && (req as any).user?.userType === "provider") {
        await assertProviderOrganizationCapability(selected, capability);
      } else {
        await assertLinkedProviderCapability((req as any).auth.userId as string, capability);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Restricts provider accounts to case reads unless they have Premium. */
export const requireProviderCasePortalAccess: RequestHandler = async (
  req,
  _res,
  next,
) => {
  try {
    const path = req.path;
    const caseIdMatch =
      path.match(/^\/provider\/([0-9a-f-]{16,})$/) ??
      path.match(/^\/([0-9a-f-]{16,})(?:\/attachments(?:\/[0-9a-f-]{16,}\/file)?)?$/);
    const isCaseRead =
      req.method === "GET" &&
      (path === "/provider" ||
        /^\/provider\/[0-9a-f-]{16,}$/.test(path) ||
        /^\/[0-9a-f-]{16,}$/.test(path) ||
        /^\/[0-9a-f-]{16,}\/attachments$/.test(path) ||
        /^\/[0-9a-f-]{16,}\/attachments\/[0-9a-f-]{16,}\/file$/.test(path));
    const userId = (req as any).auth.userId as string;
    await assertLinkedProviderCapability(
      userId,
      isCaseRead ? "case_read" : "provider_portal",
    );

    // A non-Premium provider may read only an active case. Do this before the
    // route's existing provider-org authorization; it never grants access and
    // the route remains the source of truth for case ownership.
    if (
      isCaseRead &&
      caseIdMatch &&
      !(await linkedProviderHasCapability(userId, "provider_portal"))
    ) {
      const [caseRow] = await db
        .select({ status: cases.status })
        .from(cases)
        .where(and(eq(cases.id, caseIdMatch[1]!), isNull(cases.deletedAt)))
        .limit(1);
      if (caseRow && ["complete", "completed", "delivered", "done", "closed", "cancelled"].includes(
        String(caseRow.status).toLowerCase(),
      )) {
        throw new HttpError(403, "Your provider plan only includes active cases.");
      }
    }
    next();
  } catch (error) {
    next(error);
  }
};