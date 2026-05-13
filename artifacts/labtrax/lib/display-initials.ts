// Avatar-style initials. Prefer firstName+lastName; fall back to splitting
// `label` on non-alphanumerics + camelCase boundaries; else "??".
export function deriveDisplayInitials(input?: {
  firstName?: string | null;
  lastName?: string | null;
  label?: string | null;
}): string {
  const firstInitial = input?.firstName?.trim()?.[0];
  const lastInitial = input?.lastName?.trim()?.[0];
  if (firstInitial && lastInitial) {
    return `${firstInitial}${lastInitial}`.toUpperCase();
  }

  const normalizedLabel = input?.label?.trim() || "";
  if (!normalizedLabel) {
    return "??";
  }

  const parts = normalizedLabel
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }

  const compactLabel = normalizedLabel.replace(/[^A-Za-z0-9]/g, "");
  if (compactLabel.length >= 2) {
    return `${compactLabel[0]}${compactLabel[1]}`.toUpperCase();
  }

  return compactLabel[0]?.toUpperCase() || "??";
}
