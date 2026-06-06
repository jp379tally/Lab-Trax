/**
 * Pure function: maps an analyzeRx API response to the case-form field state
 * used by the Scan tab (app/(tabs)/scan.tsx).
 *
 * Extracted here so the mapping can be unit-tested without standing up the
 * full screen or any RN/Expo surface.
 *
 * INVARIANTS (do not break):
 *  - Null / undefined fields produce empty strings (""), never "null" or undefined.
 *  - caseType is normalised via AI_CASE_TYPE_MAP before assignment.
 *  - toothIndices is kept as the raw string AND parsed to a numeric selectedTeeth
 *    array (valid range 1–32, sorted ascending).
 *  - dueDate in MM/DD/YYYY is normalised to YYYY-MM-DD; ISO dates pass through.
 *  - isRush is always a boolean (false when absent).
 *  - patientName falls back to patientInitials when patientName is missing.
 *  - aiFilledFields is a Set<string> of every field that was populated.
 */

export interface RxApiResponse {
  doctorName?: string | null;
  patientName?: string | null;
  patientInitials?: string | null;
  caseType?: string | null;
  toothIndices?: string | null;
  shade?: string | null;
  material?: string | null;
  dueDate?: string | null;
  isRush?: boolean | null;
  notes?: string | null;
  practiceName?: string | null;
  practiceAddress?: string | null;
  practicePhone?: string | null;
}

export interface RxFormFields {
  doctorName: string;
  patientName: string;
  caseType: string;
  toothIndices: string;
  selectedTeeth: number[];
  shade: string;
  material: string;
  dueDate: string;
  isRush: boolean;
  notes: string;
  aiFilledFields: Set<string>;
}

export const AI_CASE_TYPE_MAP: Record<string, string> = {
  "crown & bridge": "Restorative",
  "crown and bridge": "Restorative",
  "crown": "Restorative",
  "bridge": "Restorative",
  "implant": "Restorative",
  "implants": "Restorative",
  "veneers": "Restorative",
  "veneer": "Restorative",
  "inlay": "Restorative",
  "onlay": "Restorative",
  "inlay/onlay": "Restorative",
  "fixed": "Restorative",
  "fixed prosthetics": "Restorative",
  "denture": "Removable",
  "dentures": "Removable",
  "partial": "Removable",
  "partial denture": "Removable",
  "full denture": "Removable",
  "complete denture": "Removable",
  "flipper": "Removable",
  "night guard": "Appliance",
  "nightguard": "Appliance",
  "mouth guard": "Appliance",
  "mouthguard": "Appliance",
  "retainer": "Appliance",
  "sports guard": "Appliance",
  "sportsguard": "Appliance",
  "bleaching tray": "Appliance",
  "bite splint": "Appliance",
  "temporary": "Temporary",
  "temporaries": "Temporary",
  "temp": "Temporary",
  "provisional": "Temporary",
};

export function mapRxResponseToFormFields(d: RxApiResponse): RxFormFields {
  const filled = new Set<string>();

  const doctorName = d.doctorName || "";
  if (d.doctorName) filled.add("doctorName");

  const patientName = d.patientName
    ? d.patientName
    : d.patientInitials
      ? d.patientInitials
      : "";
  if (d.patientName || d.patientInitials) filled.add("patientName");

  let caseType = "";
  if (d.caseType) {
    const normalized = AI_CASE_TYPE_MAP[d.caseType.trim().toLowerCase()];
    caseType = normalized ?? d.caseType;
    filled.add("caseType");
  }

  const toothIndices = d.toothIndices || "";
  let selectedTeeth: number[] = [];
  if (d.toothIndices) {
    const nums = d.toothIndices.match(/\d+/g);
    if (nums) {
      selectedTeeth = nums
        .map(Number)
        .filter((n: number) => n >= 1 && n <= 32)
        .sort((a: number, b: number) => a - b);
    }
    filled.add("toothIndices");
  }

  const shade = d.shade || "";
  if (d.shade) filled.add("shade");

  const material = d.material || "";
  if (d.material) filled.add("material");

  let dueDate = "";
  if (d.dueDate) {
    dueDate = d.dueDate;
    const slashMatch = d.dueDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
      dueDate = `${slashMatch[3]}-${slashMatch[1].padStart(2, "0")}-${slashMatch[2].padStart(2, "0")}`;
    }
    filled.add("dueDate");
  }

  const isRush = d.isRush !== undefined && d.isRush !== null ? !!d.isRush : false;
  if (d.isRush !== undefined && d.isRush !== null) filled.add("isRush");

  const notes = d.notes || "";
  if (d.notes) filled.add("notes");

  return {
    doctorName,
    patientName,
    caseType,
    toothIndices,
    selectedTeeth,
    shade,
    material,
    dueDate,
    isRush,
    notes,
    aiFilledFields: filled,
  };
}
