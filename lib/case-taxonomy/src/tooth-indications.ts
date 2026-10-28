/** The visible indication menu is intentionally narrower than historical stored values. */
export const TOOTH_INDICATION_GROUPS = [
  { label: "Crowns and copings", choices: ["Crown", "Coping", "Overlay"] },
  { label: "Pontics and Diagnostic", choices: ["Pontic", "Diagnostic"] },
  { label: "Inlays, onlays and veneers", choices: ["Inlay/Onlay", "Offset inlay", "Veneer"] },
  { label: "Removables and appliances", choices: ["Denture", "Partial denture", "Bite splint", "Primary telescopic crown", "Secondary telescopic crown", "Attachment"] },
] as const;
export const TOOTH_INDICATIONS = TOOTH_INDICATION_GROUPS.flatMap((group) => [...group.choices]);
export type ToothIndication = typeof TOOTH_INDICATION_GROUPS[number]["choices"][number];
export type ToothArch = "upper" | "lower";
export function isToothIndication(value: string): value is ToothIndication {
  return TOOTH_INDICATIONS.some((choice) => choice === value);
}
export function indicationCatalogContext(indication: string) {
  if (indication === "Denture") return { caseType: "removable", subtype: "dentures", archBased: true } as const;
  if (indication === "Partial denture") return { caseType: "removable", subtype: "partials", archBased: true } as const;
  if (indication === "Bite splint") return { caseType: "ortho", subtype: "night_guards", archBased: true } as const;
  if (indication === "Attachment") return { caseType: "removable", subtype: "removable_other", archBased: false } as const;
  if (indication === "Diagnostic") return { caseType: "restorative", subtype: "temporaries", archBased: false } as const;
  return { caseType: "restorative", subtype: "crown", archBased: false } as const;
}
export function archSelectionTeeth(arch: ToothArch): string[] {
  return Array.from({ length: 16 }, (_, i) => String(i + (arch === "upper" ? 1 : 17)));
}
export function selectedToothArch(teeth: readonly string[]): ToothArch | undefined {
  if (!teeth.length || teeth.some((tooth) => !/^(?:[1-9]|[12]\d|3[0-2])$/.test(tooth))) return undefined;
  const upper = teeth.every((tooth) => Number(tooth) <= 16);
  const lower = teeth.every((tooth) => Number(tooth) >= 17);
  return upper ? "upper" : lower ? "lower" : undefined;
}

export function toothIndicationShapeError(row: {
  restorationType: string; toothNumber: string; quantity?: number | null; arch?: string | null;
}): string | null {
  if (!isToothIndication(row.restorationType) && !/^missing$/i.test(row.restorationType)) return null;
  const archBased = isToothIndication(row.restorationType) && indicationCatalogContext(row.restorationType).archBased;
  if (archBased) {
    return (row.arch === "upper" || row.arch === "lower") && !row.toothNumber.trim() && (row.quantity ?? 1) === 1
      ? null : "An arch restoration requires Upper or Lower, no individual tooth numbers, and exactly one billable unit.";
  }
  return /^(?:[1-9]|[12]\d|3[0-2]|[A-T])$/.test(row.toothNumber) && (row.quantity ?? 1) === 1 && !row.arch
    ? null : "Each tooth indication must identify one tooth and one unit, without an arch charge.";
}
