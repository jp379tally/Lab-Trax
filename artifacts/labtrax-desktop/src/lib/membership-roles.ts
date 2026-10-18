import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { MeResponse } from "@/lib/types";

/** Lab membership roles, named exactly as Team settings names them. */
export const MEMBERSHIP_ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  billing: "Billing",
  user: "User",
  read_only: "Read Only",
};

/** Lab roles the server accepts for receiving customer payments and making deposits. */
export const LAB_ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Lab roles the server accepts for the receivable and payable aging reports. */
export const LAB_BILLING_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "billing"]);

export function membershipRoleLabel(role: string | null | undefined): string | null {
  if (!role) return null;
  return MEMBERSHIP_ROLE_LABELS[role] ?? null;
}

/**
 * The role shown in the app header. `membershipRole` is the raw role of the
 * user's primary lab membership; `role` collapses owner/admin to "admin" and
 * every other membership to "user", so it is only a fallback for accounts
 * without an active membership.
 */
export function headerRoleLabel(
  user: { membershipRole?: string | null; role?: string | null } | null | undefined,
): string {
  return membershipRoleLabel(user?.membershipRole) ?? membershipRoleLabel(user?.role) ?? "Member";
}

export type LabMembershipRole =
  | { status: "loading"; role: null; label: null; retry: () => void }
  | { status: "error"; role: null; label: null; error: Error; retry: () => void }
  | { status: "ready"; role: string | null; label: string | null; retry: () => void };

/**
 * The signed-in user's active membership role in one lab, read from the same
 * `/auth/me` record the app header uses. The server authorizes lab finance
 * routes by this per-lab membership, not by the primary-lab role on the
 * session, so screens that a lab's owners and admins alone may use must gate
 * on it.
 */
export function useLabMembershipRole(
  organizationId: string | null | undefined,
  enabled = true,
): LabMembershipRole {
  const { user } = useAuth();
  const me = useQuery({
    queryKey: ["auth", "me", user?.id],
    queryFn: () => apiFetch<MeResponse>("/auth/me"),
    enabled: enabled && !!user && !!organizationId,
  });
  const retry = () => {
    void me.refetch();
  };
  if (!organizationId || !user) return { status: "ready", role: null, label: null, retry };
  if (me.isError && !me.data) {
    return {
      status: "error",
      role: null,
      label: null,
      error: me.error instanceof Error ? me.error : new Error("Your lab role could not be loaded."),
      retry,
    };
  }
  if (!me.data) return { status: "loading", role: null, label: null, retry };
  const memberships = Array.isArray(me.data.memberships) ? me.data.memberships : [];
  const membership = memberships.find(
    (row) =>
      row.status === "active" &&
      (row.organizationId === organizationId || row.organization?.id === organizationId),
  );
  const role = membership?.role ?? null;
  return { status: "ready", role, label: membershipRoleLabel(role) ?? role, retry };
}
