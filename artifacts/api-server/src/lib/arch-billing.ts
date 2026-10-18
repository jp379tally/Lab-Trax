export const ARCH_VALUES = ["upper", "lower", "upper_lower"] as const;
export type Arch = (typeof ARCH_VALUES)[number];

export function normalizeArch(value: unknown): Arch | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[+\s-]+/g, "_");
  if (normalized === "upper" || normalized === "lower") return normalized;
  if (normalized === "upper_lower" || normalized === "both") return "upper_lower";
  return null;
}

export function isArchApplicable(
  restorationType: string | null | undefined,
  restorationSubtype?: string | null,
): boolean {
  const value = `${restorationType ?? ""} ${restorationSubtype ?? ""}`;
  return /(removable|denture|partial|flipper|valplast|flexible|ortho|night guard|retainer|aligner)/i.test(
    value,
  );
}

export function archLabels(arch: Arch): Array<"Upper" | "Lower"> {
  return arch === "upper_lower"
    ? ["Upper", "Lower"]
    : [arch === "upper" ? "Upper" : "Lower"];
}

export function archLabel(arch: Arch | null | undefined): string | null {
  if (!arch) return null;
  return arch === "upper_lower" ? "Upper + Lower" : arch === "upper" ? "Upper" : "Lower";
}