/**
 * Canonical registry of capability keys for the custom permissions system.
 * Owners choose a capabilityKey when defining a Permission Outline entry;
 * the API checks it via hasCapability() in rbac.ts.
 *
 * Keep this list in sync with the OpenAPI spec enum and the client UIs.
 * Adding a key here is safe — existing permission grants for older keys
 * are unaffected.
 */

export const CAPABILITY_KEYS = [
  "delete_cases",
  "manage_pricing",
  "view_financial_reports",
  "export_data",
  "manage_team_members",
  "configure_integrations",
  "approve_invoices",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  delete_cases: "Can delete cases",
  manage_pricing: "Can manage pricing",
  view_financial_reports: "Can view financial reports",
  export_data: "Can export data",
  manage_team_members: "Can manage team members",
  configure_integrations: "Can configure integrations",
  approve_invoices: "Can approve invoices",
};

export function isValidCapabilityKey(key: unknown): key is CapabilityKey {
  return (
    typeof key === "string" &&
    (CAPABILITY_KEYS as readonly string[]).includes(key)
  );
}
