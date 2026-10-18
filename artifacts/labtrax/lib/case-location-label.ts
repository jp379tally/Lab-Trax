/** Prefer the server's exact physical station name; status is the safe fallback. */
export function caseLocationLabel(
  value: {
    status?: string | null;
    labLocationName?: string | null;
    labLocationId?: string | null;
  },
): string {
  const name = value.labLocationName?.trim();
  if (name) return name;
  const status = value.status?.trim();
  if (!status) return "—";
  return status.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}