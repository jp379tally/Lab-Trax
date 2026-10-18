// Provider-portal routing decision for the mobile app.
//
// The desktop client routes purely on `user.userType === "provider"` (see the
// Gate in labtrax-desktop/src/App.tsx). Mobile is stricter by design: a user
// who also holds an active lab membership keeps the lab shell, because the lab
// tabs are the only place those memberships can be worked. This module is the
// SINGLE place that decision is made — screens and layouts must import from
// here rather than re-deriving "is a provider" from userType or memberships.
import { activeMemberships, useMe, type MeResponse } from "@/lib/auth-me";
import { useAuth } from "@/lib/auth-context";

export type ProviderPortalDecision = "lab" | "provider" | "pending";

/** Whether the user holds at least one active membership in a lab org. */
export function hasActiveLabMembership(me: MeResponse | undefined): boolean {
  return activeMemberships(me).some(
    (m) => (m.organization?.type ?? "").toLowerCase() === "lab",
  );
}

/**
 * Decide which shell the signed-in user belongs in.
 *
 * `userType` is hydrated from persisted auth before the first render, so lab
 * users resolve to "lab" without waiting on /api/auth/me — their shell must
 * not gain a loading gate it does not have today. Only accounts the server
 * classifies as providers wait for memberships, and only to rule out the
 * dual-membership case.
 *
 * A failed /api/auth/me for a provider account falls back to the portal: the
 * server already told us this is a provider account, and that matches the
 * desktop gate.
 */
export function decideProviderPortal(
  userType: string | null | undefined,
  me: MeResponse | undefined,
  meStatus: "pending" | "error" | "success",
): ProviderPortalDecision {
  if (userType !== "provider") return "lab";
  if (meStatus === "pending") return "pending";
  if (meStatus === "error") return "provider";
  return hasActiveLabMembership(me) ? "lab" : "provider";
}

/** Live version of {@link decideProviderPortal} for use in layouts. */
export function useProviderPortalDecision(): ProviderPortalDecision {
  const { userType } = useAuth();
  const isProviderAccount = userType === "provider";
  const me = useMe();
  // Lab accounts never block on the memberships round-trip.
  if (!isProviderAccount) return "lab";
  const status: "pending" | "error" | "success" = me.isError
    ? "error"
    : me.data
      ? "success"
      : "pending";
  return decideProviderPortal(userType, me.data, status);
}
