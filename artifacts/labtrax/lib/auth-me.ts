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
