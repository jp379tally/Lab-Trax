// Shared accessor for the signed-in user's organization memberships.
//
// GET /api/auth/me returns { success, user, memberships:[{ id, role, status,
// organizationId, organization }] }. resilientFetch resolves to a Response, so
// the body MUST be awaited/parsed here — reading `.memberships` straight off the
// Response (an easy mistake) silently yields undefined and makes every
// permission check fall back to "no access".
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { resilientFetch } from "@/lib/query-client";
import { useCallback, useEffect } from "react";
import { AppState, Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import { useAuth } from "./auth-context";
import { normalizeProfilePhotoUrl } from "./normalize-profile-photo-url";

export interface MeOrganization {
  id?: string;
  type?: string | null;
  name?: string | null;
  [key: string]: unknown;
}

export interface MeMembership {
  id?: string;
  role: string;
  status: string;
  organizationId: string;
  organization?: MeOrganization | null;
}

export interface MeResponse {
  success?: boolean;
  user?: unknown;
  memberships: MeMembership[];
}

// Roles permitted to edit cases (create, attach files, change status). Mirrors
// the desktop client's BILLING_ROLES.
export const EDIT_ROLES = ["owner", "admin", "billing"] as const;

export function roleCanEdit(role: string | null | undefined): boolean {
  return (EDIT_ROLES as readonly string[]).includes(role ?? "");
}

export const ME_QUERY_KEY = ["auth-me"] as const;

export function useMe(syncPhoto = false): UseQueryResult<MeResponse> {
  const { currentUserId, isAuthenticated, setProfilePicUri, userType } = useAuth();
  const result = useQuery<MeResponse>({
    queryKey: [...ME_QUERY_KEY, currentUserId],
    enabled: isAuthenticated,
    queryFn: async () => {
      const controller = new AbortController();
      const timer = userType === "provider" ? setTimeout(() => controller.abort(), 20_000) : null;
      try {
        const res = await resilientFetch("/api/auth/me", userType === "provider" ? { signal: controller.signal } : undefined);
        if (!res.ok) throw new Error(`Could not load your profile (${res.status}).`);
        const body = (await res.json()) as Partial<MeResponse>;
        if (currentUserId && (body.user as { id?: string } | undefined)?.id !== currentUserId) {
          throw new Error("Profile account changed. Please try again.");
        }
        return {
          success: body.success,
          user: body.user,
          memberships: Array.isArray(body.memberships) ? body.memberships : [],
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    staleTime: 60_000,
    refetchOnMount: syncPhoto ? "always" : true,
  });
  const refetch = result.refetch;
  useFocusEffect(useCallback(() => {
    if (syncPhoto && isAuthenticated) void refetch();
  }, [syncPhoto, isAuthenticated, refetch]));
  useEffect(() => {
    if (!syncPhoto || !isAuthenticated) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refetch();
    });
    const onFocus = () => { void refetch(); };
    // Native defines window = global, but it is not a browser EventTarget.
    // Keep native resume refresh on AppState and browser focus refresh on web.
    const browserWindow = Platform.OS === "web" &&
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function" &&
      typeof window.removeEventListener === "function" ? window : null;
    browserWindow?.addEventListener("focus", onFocus);
    return () => {
      subscription.remove();
      browserWindow?.removeEventListener("focus", onFocus);
    };
  }, [syncPhoto, isAuthenticated, refetch]);
  const serverUser = result.data?.user as { id?: string; profilePhotoUrl?: string | null } | undefined;
  useEffect(() => {
    if (syncPhoto && serverUser?.id && serverUser.id === currentUserId) {
      void Promise.resolve(setProfilePicUri(normalizeProfilePhotoUrl(serverUser.profilePhotoUrl), currentUserId)).catch(() => {});
    }
  }, [syncPhoto, serverUser?.id, serverUser?.profilePhotoUrl, currentUserId, setProfilePicUri]);
  return result;
}

// Active lab memberships the user can create/edit cases in (editing role only).
export function editableLabMemberships(me: MeResponse | undefined): MeMembership[] {
  return (me?.memberships ?? []).filter(
    (m) =>
      m.status === "active" &&
      (m.organization?.type ?? "").toLowerCase() === "lab" &&
      roleCanEdit(m.role),
  );
}

// Whether the user can edit the case belonging to `caseOrgId`.
export function canEditOrg(me: MeResponse | undefined, caseOrgId: string | null | undefined): boolean {
  if (!caseOrgId) return false;
  const membership = (me?.memberships ?? []).find(
    (m) => m.status === "active" && m.organizationId === caseOrgId,
  );
  return roleCanEdit(membership?.role);
}

// Whether the user is an ACTIVE member of `orgId` in any role.
//
// Deliberately weaker than `canEditOrg`: features the server opens to every
// internal lab member (the exception workflow) must not be gated on an edit
// role, or `user`/`read_only` members see no affordance for something the API
// would happily let them do.
export function isActiveMemberOfOrg(
  me: MeResponse | undefined,
  orgId: string | null | undefined,
): boolean {
  if (!orgId) return false;
  return (me?.memberships ?? []).some(
    (m) => m.status === "active" && m.organizationId === orgId,
  );
}

// All active memberships, regardless of org type or role.
export function activeMemberships(me: MeResponse | undefined): MeMembership[] {
  return (me?.memberships ?? []).filter((m) => m.status === "active");
}

// The user's primary lab organization id — the org that scopes the lab-centric
// financial/management read screens. Prefers a lab where the user has an editing
// role (matching the data they can actually act on), then falls back to any
// active lab membership. Returns null for pure provider/practice users.
export function primaryLabOrgId(me: MeResponse | undefined): string | null {
  const editable = editableLabMemberships(me)[0]?.organizationId;
  if (editable) return editable;
  const anyLab = activeMemberships(me).find(
    (m) => (m.organization?.type ?? "").toLowerCase() === "lab",
  );
  return anyLab?.organizationId ?? null;
}

// The user's primary provider/practice organization id (first active non-lab
// membership), or null. Used to scope invoices a provider receives.
export function primaryProviderOrgId(me: MeResponse | undefined): string | null {
  const provider = activeMemberships(me).find(
    (m) => (m.organization?.type ?? "").toLowerCase() !== "lab",
  );
  return provider?.organizationId ?? null;
}

// Active provider/practice memberships where the user is an owner/admin.
export function adminProviderMemberships(me: MeResponse | undefined): MeMembership[] {
  return activeMemberships(me).filter(
    (m) =>
      (m.organization?.type ?? "").toLowerCase() !== "lab" &&
      roleIsAdmin(m.role),
  );
}

export function canAdminAnyProvider(me: MeResponse | undefined): boolean {
  return adminProviderMemberships(me).length > 0;
}

export function primaryAdminProviderOrgId(me: MeResponse | undefined): string | null {
  return adminProviderMemberships(me)[0]?.organizationId ?? null;
}

// Mobile equivalent of the desktop `billingOnly` gate: the user owns/admins or
// has billing access to at least one active lab. Gates the Lists area (vendors
// and categories are BILLING_ROLES on the server).
export function canEditAnyLab(me: MeResponse | undefined): boolean {
  return editableLabMemberships(me).length > 0;
}

// Roles permitted to administer a lab. Mirrors the desktop/server ADMIN_ROLES
// (owner/admin) — stricter than EDIT_ROLES, which also includes billing. The
// server gates pricing tiers/overrides, the billed report, and item-label
// writes on these roles (see resolveLabId / ADMIN_ROLES in api-server), so the
// mobile edit affordances for those features must match — gating on billing
// would surface edit UI that 403s, or load screens whose data the server
// refuses to return.
export const ADMIN_ROLES = ["owner", "admin"] as const;

export function roleIsAdmin(role: string | null | undefined): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role ?? "");
}

// Active lab memberships where the user is an owner/admin.
export function adminLabMemberships(me: MeResponse | undefined): MeMembership[] {
  return (me?.memberships ?? []).filter(
    (m) =>
      m.status === "active" &&
      (m.organization?.type ?? "").toLowerCase() === "lab" &&
      roleIsAdmin(m.role),
  );
}

// Whether the user owns/admins at least one active lab. Gates Pricing, the
// billed Report, and item-label editing.
export function canAdminAnyLab(me: MeResponse | undefined): boolean {
  return adminLabMemberships(me).length > 0;
}

// The user's primary lab organization id where they are an owner/admin — the
// org that scopes the admin-only Pricing/Reports screens. Returns null for
// billing-only, read-only, or provider users.
export function primaryAdminLabOrgId(me: MeResponse | undefined): string | null {
  return adminLabMemberships(me)[0]?.organizationId ?? null;
}

// Roles permitted to see the owner-only Sales Forecaster. Stricter than both
// EDIT_ROLES and ADMIN_ROLES — the server gates GET /stats/sales-forecast on
// OWNER_ROLES, so the mobile affordance must match exactly or it would surface
// a screen the server refuses to serve (403).
export const OWNER_ROLES = ["owner"] as const;

export function roleIsOwner(role: string | null | undefined): boolean {
  return (OWNER_ROLES as readonly string[]).includes(role ?? "");
}

// Active lab memberships where the user is the owner.
export function ownerLabMemberships(me: MeResponse | undefined): MeMembership[] {
  return (me?.memberships ?? []).filter(
    (m) =>
      m.status === "active" &&
      (m.organization?.type ?? "").toLowerCase() === "lab" &&
      roleIsOwner(m.role),
  );
}

// Whether the user owns at least one active lab. Gates the Sales Forecaster.
export function canOwnAnyLab(me: MeResponse | undefined): boolean {
  return ownerLabMemberships(me).length > 0;
}

// The user's primary lab organization id where they are the owner — scopes the
// owner-only Sales Forecaster screen. Returns null for non-owner users.
export function primaryOwnerLabOrgId(me: MeResponse | undefined): string | null {
  return ownerLabMemberships(me)[0]?.organizationId ?? null;
}
