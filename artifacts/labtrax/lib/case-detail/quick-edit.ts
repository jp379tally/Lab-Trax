export type QuickEditFormValues = {
  doctor: string;
  patient: string;
  teeth: string;
  shade: string;
  material: string;
  dueDate: string;
  notes: string;
};

export type QuickEditCaseSnapshot = {
  doctorName?: string | null;
  patientName?: string | null;
  patientInitials?: string | null;
  toothIndices?: string | null;
  shade?: string | null;
  material?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  caseType?: string | null;
  isRush?: boolean | null;
  invoiceId?: string | null;
};

export type QuickEditCaseUpdates = {
  doctorName?: string;
  patientName?: string;
  toothIndices?: string;
  shade?: string;
  material?: string;
  dueDate?: string;
  notes?: string;
};

export type QuickEditInvoiceLineItem = {
  qty: number;
  item: string;
  description: string;
  rate: number;
  amount: number;
};

export type QuickEditInvoicePatch = {
  lineItems?: QuickEditInvoiceLineItem[];
  amount?: number;
  billTo?: string;
  patientName?: string;
  teeth?: string;
  shade?: string;
  caseNotes?: string;
};

export type QuickEditPlan = {
  changes: string[];
  caseUpdates: QuickEditCaseUpdates;
  newPrice?: number;
  invoicePatch?: QuickEditInvoicePatch;
};

export function computeQuickEditPlan(
  caseItem: QuickEditCaseSnapshot,
  form: QuickEditFormValues,
  resolveRate: (
    material: string,
    caseType: string | null | undefined,
    doctorName: string,
  ) => number,
): QuickEditPlan {
  const changes: string[] = [];
  const updates: QuickEditCaseUpdates = {};

  const doctor = form.doctor.trim();
  const patient = form.patient.trim();
  const teeth = form.teeth.trim();
  const shade = form.shade.trim();
  const material = form.material.trim();
  const dueDate = form.dueDate.trim();
  const notes = form.notes.trim();

  const currentPatient = caseItem.patientName || caseItem.patientInitials || "";

  if (doctor && doctor !== caseItem.doctorName) {
    updates.doctorName = doctor;
    changes.push(`Doctor: ${doctor}`);
  }
  if (patient && patient !== currentPatient) {
    updates.patientName = patient;
    changes.push(`Patient: ${patient}`);
  }
  if (teeth && teeth !== caseItem.toothIndices) {
    updates.toothIndices = teeth;
    changes.push(`Teeth: ${teeth}`);
  }
  if (shade && shade !== caseItem.shade) {
    updates.shade = shade;
    changes.push(`Shade: ${shade}`);
  }
  if (material && material !== caseItem.material) {
    updates.material = material;
    changes.push(`Material: ${material}`);
  }
  if (dueDate && dueDate !== caseItem.dueDate) {
    updates.dueDate = dueDate;
    changes.push(`Due: ${dueDate}`);
  }
  if (notes !== (caseItem.notes || "")) {
    updates.notes = notes;
    changes.push("Notes updated");
  }

  if (changes.length === 0) {
    return { changes, caseUpdates: updates };
  }

  const triggersRebuild =
    Boolean(updates.material) || Boolean(updates.toothIndices) || Boolean(updates.doctorName);

  if (triggersRebuild) {
    const newTeeth = updates.toothIndices ?? caseItem.toothIndices ?? "";
    const toothCount = newTeeth.split(",").filter(Boolean).length || 1;
    const mat = updates.material ?? caseItem.material ?? "";
    const drName = updates.doctorName ?? caseItem.doctorName ?? "";
    const rate = resolveRate(mat, caseItem.caseType ?? null, drName);
    const newTotal = toothCount * rate + (caseItem.isRush ? 500 : 0);

    let invoicePatch: QuickEditInvoicePatch | undefined;
    if (caseItem.invoiceId) {
      const lineItems: QuickEditInvoiceLineItem[] = [
        {
          qty: toothCount,
          item: `${mat} ${caseItem.caseType || "Restoration"}`,
          description: `${mat} restoration - teeth ${newTeeth}`,
          rate,
          amount: toothCount * rate,
        },
      ];
      if (caseItem.isRush) {
        lineItems.push({
          qty: 1,
          item: "Rush Fee",
          description: "Expedited turnaround",
          rate: 500,
          amount: 500,
        });
      }
      invoicePatch = {
        lineItems,
        amount: newTotal,
        billTo: drName,
        patientName: updates.patientName ?? currentPatient,
        teeth: newTeeth,
        shade: updates.shade ?? caseItem.shade ?? "",
        caseNotes: updates.notes ?? caseItem.notes ?? "",
      };
    }

    return { changes, caseUpdates: updates, newPrice: newTotal, invoicePatch };
  }

  if (caseItem.invoiceId) {
    const fields: QuickEditInvoicePatch = {};
    if (updates.doctorName) fields.billTo = updates.doctorName;
    if (updates.patientName) fields.patientName = updates.patientName;
    if (updates.shade) fields.shade = updates.shade;
    if (updates.toothIndices) fields.teeth = updates.toothIndices;
    if (updates.notes !== undefined) fields.caseNotes = updates.notes;
    if (Object.keys(fields).length > 0) {
      return { changes, caseUpdates: updates, invoicePatch: fields };
    }
  }

  return { changes, caseUpdates: updates };
}
