export type ArchValue = "upper" | "lower";
export type ArchSelection = ArchValue | "both";

export const ARCH_OPTIONS: ReadonlyArray<{ value: ArchSelection; label: string }> = [
  { value: "upper", label: "Upper" },
  { value: "lower", label: "Lower" },
  { value: "both", label: "Upper + Lower" },
];

export function normalizeArch(value: unknown): ArchValue | null {
  if (value === "upper" || value === "lower") return value;
  return null;
}

export function archSelectionFromRows(rows: ReadonlyArray<{ arch?: unknown }>): ArchSelection | null {
  const arches = new Set(rows.map((row) => normalizeArch(row.arch)).filter(Boolean) as ArchValue[]);
  if (arches.has("upper") && arches.has("lower")) return "both";
  if (arches.has("upper")) return "upper";
  if (arches.has("lower")) return "lower";
  return null;
}

export function isArchRequired(caseType?: string | null): boolean {
  return caseType === "removable" || caseType === "ortho";
}

export function archLabel(value: ArchSelection | null | undefined): string {
  return ARCH_OPTIONS.find((option) => option.value === value)?.label ?? "";
}