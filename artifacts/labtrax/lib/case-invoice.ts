// Match a case to its invoice (or synthesise a fallback). Pulled out of
// the cases tab + case detail screen so they're unit-testable.
import type { Client, Invoice, LabCase, PricingTier } from "./data";
import { resolvePriceForCase } from "./pricing";

// Prefer explicit case.invoiceId; otherwise legacy "same patient + same
// doctor surname" heuristic.
export function findCaseInvoice(
  caseItem: LabCase,
  invoices: readonly Invoice[]
): Invoice | null {
  if (caseItem.invoiceId) {
    const found = invoices.find((inv) => inv.id === caseItem.invoiceId);
    if (found) return found;
  }
  const patient = (caseItem.patientName || "").toLowerCase();
  const doctorSurname =
    caseItem.doctorName.split(" ").pop()?.toLowerCase() || "";
  const matched = invoices.find(
    (inv) =>
      inv.caseIds.includes(caseItem.id) ||
      (inv.patientName.toLowerCase() === patient &&
        inv.clientName.toLowerCase().includes(doctorSurname))
  );
  return matched ?? null;
}

// Synthetic invoice shown when no real invoice exists yet.
export function buildSyntheticInvoice(
  caseItem: LabCase,
  clients: readonly Client[],
  pricingTiers: readonly PricingTier[]
): Invoice {
  const toothCount =
    caseItem.toothMap?.length ||
    caseItem.toothIndices.split(",").filter(Boolean).length ||
    1;
  const rate = resolvePriceForCase(
    caseItem.material,
    caseItem.caseType,
    caseItem.doctorName,
    clients as Client[],
    pricingTiers as PricingTier[]
  );
  const lineItems = [
    {
      qty: toothCount,
      item: `${caseItem.material} ${caseItem.caseType || "Restoration"}`,
      description: `${caseItem.material} restoration - teeth ${caseItem.toothIndices}`,
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
  const invNum = `INV-${new Date(caseItem.createdAt).getFullYear()}-${caseItem.caseNumber
    .replace(/[^0-9]/g, "")
    .padStart(3, "0")}`;
  return {
    id: caseItem.id + "-inv",
    invoiceNumber: invNum,
    clientId: "",
    clientName: caseItem.doctorName,
    caseIds: [caseItem.id],
    amount: total,
    credits: caseItem.isRemake && caseItem.price === 0 ? total : 0,
    status: caseItem.status === "COMPLETE" ? "paid" : "open",
    issuedAt: caseItem.createdAt,
    dueAt: caseItem.dueDate
      ? new Date(caseItem.dueDate + "T00:00:00").getTime()
      : caseItem.createdAt + 30 * 86400000,
    billTo: caseItem.doctorName,
    patientName: caseItem.patientName || caseItem.patientInitials,
    caseType: caseItem.caseType || "Restoration",
    teeth: caseItem.toothIndices,
    shade: caseItem.shade,
    caseNotes: caseItem.notes || "",
    lineItems,
  };
}

export function getCaseInvoice(
  caseItem: LabCase,
  invoices: readonly Invoice[],
  clients: readonly Client[],
  pricingTiers: readonly PricingTier[]
): Invoice {
  const matched = findCaseInvoice(caseItem, invoices);
  if (matched) return matched;
  return buildSyntheticInvoice(caseItem, clients, pricingTiers);
}
