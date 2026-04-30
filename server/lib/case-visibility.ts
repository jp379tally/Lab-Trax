// Case visibility rules — single source of truth for "what cases can a user
// see?" The server alone makes this decision so the client cannot accidentally
// hide or expose cases. Keep this file small, free of database access, and
// covered by unit tests.

export type MinimalCaseForVisibility = {
  ownerId: string | null;
  organizationId: string | null;
  deletedAt?: Date | null;
};

// A case is visible to a user when EITHER of the following is true:
//   1. It is a private case (no organization) owned by the user.
//   2. It is a lab case whose organization is one the user is an active
//      member of.
// Soft-deleted cases are never visible.
export function isCaseVisibleToUser(
  labCase: MinimalCaseForVisibility,
  userId: string,
  userLabIds: ReadonlySet<string>
): boolean {
  if (labCase.deletedAt) {
    return false;
  }
  if (!labCase.organizationId) {
    return labCase.ownerId === userId;
  }
  return userLabIds.has(labCase.organizationId);
}

// Determine the organization_id column value for a case being written, given
// what the user requested (via the legacy `affiliationKey` JSON field) and
// which labs they actually belong to. Cross-lab tagging is silently rejected
// (the case becomes private) so the client cannot leak cases into a lab the
// user does not belong to.
export function resolveOrganizationIdForWrite(
  affiliationKey: string | null | undefined,
  userLabIds: ReadonlySet<string>
): string | null {
  if (typeof affiliationKey !== "string") return null;
  const trimmed = affiliationKey.trim();
  if (!trimmed.startsWith("org:")) return null;
  const candidate = trimmed.slice(4).trim();
  if (!candidate) return null;
  return userLabIds.has(candidate) ? candidate : null;
}
