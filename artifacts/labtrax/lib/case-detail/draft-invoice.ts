// `app/case/[id].tsx` builds an in-memory placeholder Invoice when no
// real one is linked yet, so the LabSlip / Invoice modals always have
// something to render. Extracted as a pure builder so it can be tested
// without spinning up the screen or AppContext.

import { Invoice, LabCase, Client, PricingTier } from "../data";
import { resolvePriceForCase } from "../pricing";

export function findExistingInvoice(
  caseItem: Pick<LabCase, "id" | "invoiceId" | "patientName" | "doctorName">,
  invoices: Invoice[],
): Invoice | undefined {
  if (caseItem.invoiceId) {
    const direct = invoices.find((inv) => inv.id === caseItem.invoiceId);
    if (direct) return direct;
  }
  const safeDoctorName = caseItem.doctorName || "";
  const safePatientName = caseItem.patientName || "";
  return invoices.find(
    (inv) =>
      inv.caseIds.includes(caseItem.id) ||
      ((inv.patientName || "").toLowerCase() === safePatientName.toLowerCase() &&
        (inv.clientName || "")
          .toLowerCase()
          .includes(safeDoctorName.split(" ").pop()?.toLowerCase() || "")),
  );
}

export function buildDraftInvoice(input: {
  caseItem: LabCase;
  clients: Client[];
  pricingTiers: PricingTier[];
}): Invoice {
  const { caseItem, clients, pricingTiers } = input;
  const safeDoctorName = caseItem.doctorName || "";
  const safeToothIndices = caseItem.toothIndices || "";
  const safeCaseNumber = caseItem.caseNumber || "";
  const safePatientName = caseItem.patientName || "";
  const safeMaterial = caseItem.material || "";
  const safeShade = caseItem.shade || "";

  const toothCount =
    caseItem.toothMap?.length || safeToothIndices.split(",").filter(Boolean).length || 1;
  const rate = resolvePriceForCase(safeMaterial, caseItem.caseType, safeDoctorName, clients, pricingTiers);
  const lineItems = [
    {
      qty: toothCount,
      item: `${safeMaterial} ${caseItem.caseType || "Restoration"}`,
      description: `${safeMaterial} restoration - teeth ${safeToothIndices}`,
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
  const total = lineItems.reduce((s, li) => s + li.amount, 0);
  const invNum = `INV-${new Date(caseItem.createdAt).getFullYear()}-${safeCaseNumber.replace(/[^0-9]/g, "").padStart(3, "0")}`;
  return {
    id: caseItem.id + "-inv",
    invoiceNumber: invNum,
    clientId: "",
    clientName: safeDoctorName,
    caseIds: [caseItem.id],
    amount: total,
    credits: caseItem.isRemake && caseItem.price === 0 ? total : 0,
    status: caseItem.status === "COMPLETE" ? ("paid" as const) : ("open" as const),
    issuedAt: caseItem.createdAt,
    dueAt: caseItem.dueDate
      ? new Date(caseItem.dueDate + "T00:00:00").getTime()
      : caseItem.createdAt + 30 * 86400000,
    billTo: safeDoctorName,
    patientName: safePatientName || caseItem.patientInitials,
    caseType: caseItem.caseType || "Restoration",
    teeth: safeToothIndices,
    shade: safeShade,
    caseNotes: caseItem.notes || "",
    lineItems,
  };
}

export function resolveCaseInvoice(input: {
  caseItem: LabCase;
  invoices: Invoice[];
  clients: Client[];
  pricingTiers: PricingTier[];
}): Invoice {
  const existing = findExistingInvoice(input.caseItem, input.invoices);
  if (existing) return existing;
  return buildDraftInvoice(input);
}
