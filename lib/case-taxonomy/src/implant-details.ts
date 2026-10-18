import { deriveCaseHierarchy } from "./taxonomy";

export const IMPLANT_RETENTIONS = ["Screw retained", "Cementable"] as const;
export const IMPLANT_MANUFACTURERS = ["Straumann", "BioHorizons", "Implant Direct", "Other"] as const;
export const IMPLANT_PLATFORM_PLACEHOLDER = "Platform size, RC, RN, WB, etc.";
export interface ImplantDetails {
  implantRetention?: string | null;
  implantManufacturer?: string | null;
  implantPlatformNotes?: string | null;
}
export const IMPLANT_FIELDS = ["implantRetention", "implantManufacturer", "implantPlatformNotes"] as const;
export function isImplantRestoration(row: { restorationType?: string | null; restorationSubtype?: string | null; material?: string | null }): boolean {
  return deriveCaseHierarchy(row.restorationType, row.restorationSubtype, row.material).subtype === "implant";
}
/** Always retain tooth and line context, including duplicate restorations on one tooth. */
export function implantFieldText(rows: Array<ImplantDetails & { toothNumber?: string | null; restorationType?: string | null; restorationSubtype?: string | null; material?: string | null }>, field: typeof IMPLANT_FIELDS[number]): string {
  return rows.flatMap((row, index) => {
    const value = row[field]?.trim();
    return isImplantRestoration(row) && value
      ? [`Line ${index + 1}${row.toothNumber ? ` · Tooth ${row.toothNumber}` : ""} · Implant: ${value}`]
      : [];
  }).join("\n");
}
