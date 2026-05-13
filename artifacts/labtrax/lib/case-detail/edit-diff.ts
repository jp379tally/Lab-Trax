// Pure diff helpers for the "Edit Case" form in `app/case/[id].tsx`.
// Computing the case-update payload, the human-readable change list, and
// the matching invoice patch is the exact behaviour we want to lock in
// with focused tests.

import type { Invoice, LabCase } from "../data";

export interface CaseEditFormValues {
  doctor: string;
  patient: string;
  teeth: string;
  shade: string;
  material: string;
  dueDate: string;
  notes: string;
}

export interface CaseEditDiff {
  updates: Partial<LabCase>;
  changes: string[];
  providerChanged: boolean;
}

function computePatientInitials(patient: string): string {
  return patient
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .substring(0, 2);
}

export function computeCaseEditDiff(
  caseItem: Pick<
    LabCase,
    "doctorName" | "patientName" | "patientInitials" | "toothIndices" | "shade" | "material" | "dueDate" | "notes"
  >,
  form: CaseEditFormValues,
): CaseEditDiff {
  const updates: Partial<LabCase> = {};
  const changes: string[] = [];

  const oldDoctor = caseItem.doctorName;
  const newDoctor = form.doctor.trim();
  const providerChanged =
    newDoctor.toLowerCase() !== oldDoctor.toLowerCase() && newDoctor.length > 0;

  if (newDoctor !== oldDoctor) {
    updates.doctorName = newDoctor;
    changes.push(`Provider: ${oldDoctor} → ${newDoctor}`);
  }
  const currentPatient = caseItem.patientName || caseItem.patientInitials;
  if (form.patient.trim() !== currentPatient) {
    updates.patientName = form.patient.trim();
    updates.patientInitials = computePatientInitials(form.patient.trim());
    changes.push(`Patient: ${currentPatient} → ${form.patient.trim()}`);
  }
  if (form.teeth.trim() !== caseItem.toothIndices) {
    updates.toothIndices = form.teeth.trim();
    changes.push(`Teeth: ${caseItem.toothIndices} → ${form.teeth.trim()}`);
  }
  if (form.shade.trim() !== caseItem.shade) {
    updates.shade = form.shade.trim();
    changes.push(`Shade: ${caseItem.shade} → ${form.shade.trim()}`);
  }
  if (form.material.trim() !== caseItem.material) {
    updates.material = form.material.trim();
    changes.push(`Material: ${caseItem.material} → ${form.material.trim()}`);
  }
  if (form.dueDate.trim() !== (caseItem.dueDate || "")) {
    updates.dueDate = form.dueDate.trim();
    changes.push(`Due Date: ${caseItem.dueDate || "none"} → ${form.dueDate.trim()}`);
  }
  if (form.notes.trim() !== (caseItem.notes || "")) {
    updates.notes = form.notes.trim();
    changes.push("Notes updated");
  }

  return { updates, changes, providerChanged };
}

export function buildInvoicePatchForCaseEdit(input: {
  updates: Partial<LabCase>;
  currentMaterial: string;
}): Partial<Invoice> {
  const { updates, currentMaterial } = input;
  const invUpdates: Partial<Invoice> = {};
  if (updates.doctorName) {
    invUpdates.clientName = updates.doctorName;
    invUpdates.billTo = updates.doctorName;
  }
  if (updates.patientName) invUpdates.patientName = updates.patientName;
  if (updates.toothIndices) invUpdates.teeth = updates.toothIndices;
  if (updates.shade) invUpdates.shade = updates.shade;
  if (updates.material || updates.toothIndices) {
    const mat = updates.material || currentMaterial;
    invUpdates.caseType = `${mat} Restoration`;
  }
  if (updates.dueDate) {
    invUpdates.dueAt = new Date(updates.dueDate + "T00:00:00").getTime();
  }
  return invUpdates;
}
