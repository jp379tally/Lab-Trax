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

// Pure parser: extract the organization UUID from an `affiliationKey`
// JSON field shaped like `org:<UUID>`. Returns null for any other shape.
// The caller is responsible for verifying the org exists in the database
// (so we never persist references to phantom orgs).
//
// NOTE: We deliberately do NOT require the writer to be a member of the
// target lab. In this product's domain (dental-lab fulfillment), a
// scanner — who may or may not be a member of the receiving lab — must
// be able to drop a case into the lab's inbox. Once tagged, the case is
// visible to every member of that lab via `isCaseVisibleToUser`.
// Membership-gating writes was the source of cases silently disappearing.
export function parseOrganizationIdFromAffiliationKey(
  affiliationKey: string | null | undefined
): string | null {
  if (typeof affiliationKey !== "string") return null;
  const trimmed = affiliationKey.trim();
  if (!trimmed.startsWith("org:")) return null;
  const candidate = trimmed.slice(4).trim();
  if (!candidate) return null;
  return candidate;
}
