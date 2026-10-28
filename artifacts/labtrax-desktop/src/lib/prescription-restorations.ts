import type { PreviewDraftInvoiceInput } from "@workspace/api-client-react";
import { deriveCaseHierarchy, encodeRestorationSubtype, expandToothAssignmentIdentifiers, readExplicitAiToothAssignments, type ToothAssignmentProvenance } from "@workspace/case-taxonomy";

interface PrescriptionRestorationInput {
  toothIndices?: string | null;
  caseType?: string | null;
  material?: string | null;
  shade?: string | null;
  arch?: "upper" | "lower" | "both" | null;
  removableSubtype?: string | null;
  assignmentRoles?: Record<string, "Crown" | "Pontic" | "Veneer">;
  assignmentValues?: Record<string, { material?: string; shade?: string; restorationSubtype?: string }>;
  assignmentOverridesManual?: boolean;
  restorationSubtype?: string | null;
  toothAssignments?: unknown;
}

type PrescriptionRestoration = PreviewDraftInvoiceInput["restorations"][number] & {
  toothNumber: string;
  quantity: number;
  arch?: "upper" | "lower";
  restorationSubtype?: string;
  assignmentProvenance?: ToothAssignmentProvenance;
};

/**
 * Shared source order for preview restorationIndices and saved price overrides:
 * preserve Universal tooth order without duplicating fixed teeth/charges.
 * Only toothless both-arch appliances expand as upper then lower sources.
 * Prices belong to the save path, not this serialization.
 */
export function buildPrescriptionRestorations(
  rx: PrescriptionRestorationInput,
): PrescriptionRestoration[] {
  const category = deriveCaseHierarchy(rx.caseType, null, rx.material).caseType;
  const useAssignments = !!rx.assignmentRoles && category !== "removable" && category !== "ortho";
  const teeth = expandToothAssignmentIdentifiers(rx.toothIndices);
  if (teeth.length === 0 && !rx.material && !rx.shade && !rx.caseType) return [];

  // Preserve a toothless appliance (or other extracted details) as a source.
  const restorationType = (rx.caseType || "Other").trim() || "Other";
  const rows: PrescriptionRestoration[] = (teeth.length > 0 ? teeth : [""]).map(
    (toothNumber) => {
      const assignedRole = useAssignments && /^(Crown|Pontic|Veneer)$/.test(rx.assignmentRoles?.[toothNumber] ?? "")
        ? rx.assignmentRoles?.[toothNumber]
        : undefined;
      const assignedMaterial = assignedRole
        ? rx.assignmentValues?.[toothNumber]?.material ?? rx.material
        : rx.material;
      // An assignment without a product is not a usable chart correction.
      const hasValidAssignment = !!assignedRole && !!assignedMaterial?.trim();
      const material = hasValidAssignment ? assignedMaterial : rx.material;
      const shade = hasValidAssignment
        ? rx.assignmentValues?.[toothNumber]?.shade ?? rx.shade
        : rx.shade;
      return {
        toothNumber,
        // Keep the extracted restoration type for teeth the chart has not
        // explicitly and completely assigned.
        restorationType: hasValidAssignment ? assignedRole! : restorationType,
        restorationSubtype:
          ((hasValidAssignment ? rx.assignmentValues?.[toothNumber]?.restorationSubtype : undefined)?.trim() ||
            rx.removableSubtype?.trim() ||
            rx.restorationSubtype?.trim() ||
            encodeRestorationSubtype(deriveCaseHierarchy(restorationType, null, material ?? null))) || undefined,
        ...(material?.trim() ? { material: material.trim() } : {}),
        ...(shade?.trim() ? { shade: shade.trim() } : {}),
        quantity: 1,
        ...(rx.arch && rx.arch !== "both" && !useAssignments ? { arch: rx.arch } : {}),
      };
    },
  ).filter((row) => !!row.restorationType);
  const aiAssignments = readExplicitAiToothAssignments(rx.toothAssignments);
  for (const row of rows) {
    if (!/^(Crown|Pontic|Veneer)$/.test(row.restorationType)) continue;
    const ai = aiAssignments.find((unit) => unit.toothNumber === row.toothNumber &&
      unit.restorationType === row.restorationType && unit.material === row.material && unit.shade === row.shade);
    row.assignmentProvenance = ai?.assignmentProvenance
      ? { ...ai.assignmentProvenance, manualFields: rx.assignmentOverridesManual ? ["role", "product", "shade"] : ai.assignmentProvenance.manualFields }
      : { origin: "manual", manualFields: ["role", "product", "shade"] };
  }
  return rx.arch === "both" && !useAssignments && teeth.length === 0
    ? [
        ...rows.map((row) => ({ ...row, arch: "upper" as const })),
        ...rows.map((row) => ({ ...row, arch: "lower" as const })),
      ]
    : rows;
}
