// Shared accessor for the signed-in user's organization memberships.
//
// GET /api/auth/me returns { success, user, memberships:[{ id, role, status,
// organizationId, organization }] }. resilientFetch resolves to a Response, so
// the body MUST be awaited/parsed here — reading `.memberships` straight off the
// Response (an easy mistake) silently yields undefined and makes every
// permission check fall back to "no access".
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { resilientFetch } from "@/lib/query-client";

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

export function useMe(): UseQueryResult<MeResponse> {
  return useQuery<MeResponse>({
    queryKey: ME_QUERY_KEY,
    queryFn: async () => {
      const res = await resilientFetch("/api/auth/me");
      if (!res.ok) throw new Error(`Could not load your profile (${res.status}).`);
      const body = (await res.json()) as Partial<MeResponse>;
      return {
        success: body.success,
        user: body.user,
        memberships: Array.isArray(body.memberships) ? body.memberships : [],
      };
    },
    staleTime: 60_000,
  });
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
