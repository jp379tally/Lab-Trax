import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { db, organizations } from "@workspace/db";
import {
  getEntitlement,
  getSubjectForUser,
  type BillingSubject,
} from "./entitlement";
import { HttpError } from "./http";

type EntitlementRequestContext = {
  method: string;
  originalUrl: string;
};

const requestContext = new AsyncLocalStorage<EntitlementRequestContext>();

export function isMutationAllowedDuringReadOnly(
  method: string,
  originalUrl: string,
): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const path = originalUrl.split("?")[0]!.replace(/^\/api/, "");
  if (path === "/auth/logout") return true;
  if (
    path === "/billing/checkout-session" ||
    path === "/billing/provider-plan" ||
    path === "/billing/portal-session" ||
    path === "/billing/reactivate" ||
    path === "/billing/decline-renewal" ||
    path === "/provider/selection" ||
    path === "/support-reports"
    || path === "/creator/unlock"
    || path === "/creator/lock"
    || path === "/creator/pin"
    || path === "/creator/revenue/reconcile"
    || path.startsWith("/creator/feedback")
  ) {
    return true;
  }
  return false;
}

export function runWithEntitlementRequestContext<T>(
  context: EntitlementRequestContext,
  callback: () => T,
): T {
  return requestContext.run(context, callback);
}

function currentRequestNeedsWriteCheck(): boolean {
  const context = requestContext.getStore();
  return Boolean(
    context &&
      !isMutationAllowedDuringReadOnly(context.method, context.originalUrl),
  );
}

function throwReadOnly(): never {
  throw new HttpError(403, "Account is read-only until billing is recovered.", {
    code: "BILLING_READ_ONLY",
  });
}

export async function assertOrganizationMutationAllowed(
  organizationId: string,
): Promise<void> {
  if (!currentRequestNeedsWriteCheck()) return;
  const [organization] = await db
    .select({ type: organizations.type })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) return;
  const entitlement = await getEntitlement({
    subjectType:
      organization.type === "provider" ? "provider_org" : "lab_org",
    subjectId: organizationId,
  });
  if (entitlement.status === "free" || entitlement.status === "onboarding_pending" ||
      (entitlement.accessLevel === "read_only" && !entitlement.hasActiveWaiver)) {
    throwReadOnly();
  }
}

export async function assertUserMutationAllowed(userId: string): Promise<void> {
  return assertBillingSubjectMutationAllowed({
    subjectType: "user",
    subjectId: userId,
  });
}

export async function assertDefaultBillingMutationAllowed(
  userId: string,
): Promise<void> {
  return assertBillingSubjectMutationAllowed(await getSubjectForUser(userId));
}

export async function assertBillingSubjectMutationAllowed(
  subject: BillingSubject,
): Promise<void> {
  if (!currentRequestNeedsWriteCheck()) return;
  const entitlement = await getEntitlement(subject);
  if (entitlement.status === "free" || entitlement.status === "onboarding_pending" ||
      (entitlement.accessLevel === "read_only" && !entitlement.hasActiveWaiver)) {
    throwReadOnly();
  }
}
