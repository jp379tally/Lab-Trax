// Isolated browser fixture: uses the real drawer and shared editing surface,
// with no production data, notifications, or processor side effects.
import React from "react";
import { createRoot } from "react-dom/client";
import { CaseDrawer } from "@/pages/cases";
import { makeAuthWrapper } from "@/__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";
import type { LabCase, Invoice } from "@/lib/types";
import "@/index.css";

const params = new URLSearchParams(window.location.search);
const labCase = {
  id: "browser-case", caseNumber: "26-99", patientFirstName: "Jane", patientLastName: "Doe",
  doctorName: "Dr. Smith", status: "received", priority: "normal", totalPrice: "110",
  labOrganizationId: "browser-lab", viewerIsLabMember: true,
  restorations: [], notes: [], events: [], attachments: [],
} as unknown as LabCase;
let invoice = {
  id: "browser-invoice", caseId: labCase.id, invoiceNumber: "INV-BROWSER",
  labOrganizationId: "browser-lab", providerOrganizationId: "browser-practice",
  status: "open", issuedAt: "2026-10-01T00:00:00.000Z", dueAt: "2026-10-15T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z", tax: 0, discount: 0, total: 110, subtotal: 110, balanceDue: 110,
  notes: "Confirmed note", payments: [], displayMetadata: { patientName: "Jane Doe", billTo: "Dr. Smith", lineItems: [{ item: "Crown", subItems: [{ item: "Alloy" }] }] },
  items: [{ id: "parent", description: "Crown", quantity: 1, unitPrice: 100, lineTotal: 100, toothLabel: "Upper",
    subItems: [{ id: "child", description: "Alloy", quantity: 1, unitPrice: 10, lineTotal: 10, toothLabel: "Lower" }] }],
} as unknown as Invoice;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const testState = { writes: [] as unknown[], failNext: false, invoice: () => invoice };
Object.assign(window, { inlineInvoiceTest: testState });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith(`/invoices/${invoice.id}`)) {
    if (init?.method === "PATCH") {
      if (testState.failNext) { testState.failNext = false; return json({ error: "Invoice is frozen — the linked case was deleted." }, 409); }
      const payload = JSON.parse(String(init.body));
      testState.writes.push(payload);
      const items = payload.items.map((line: any, index: number) => ({
        ...line, id: line.id ?? `manual-${index}`, lineTotal: line.quantity * line.unitPrice,
        subItems: line.subItems.map((sub: any, j: number) => ({ ...sub, id: sub.id ?? `child-${index}-${j}`, lineTotal: sub.quantity * sub.unitPrice })),
      }));
      const subtotal = items.reduce((sum: number, line: any) => sum + line.lineTotal + line.subItems.reduce((s: number, sub: any) => s + sub.lineTotal, 0), 0);
      const total = subtotal + payload.tax - payload.discount - payload.displayMetadata.credits;
      invoice = { ...invoice, ...payload, displayMetadata: payload.displayMetadata, items, subtotal, total, balanceDue: total };
      return json({ ...invoice, items: undefined });
    }
    return json(invoice);
  }
  if (url.includes("/invoices?caseId=")) return json([invoice]);
  if (url.includes("/invoice-template/presets")) return json({ presets: [{ id: "compact", name: "Compact layout" }] });
  if (url.includes("/organizations?")) return json([{ id: "browser-practice", name: "Practice One", type: "practice", parentLabOrganizationId: "browser-lab" }]);
  if (url.includes("/pricing/")) return json({ items: [{ key: "crown", label: "Crown", unitPrice: 100 }] });
  if (url.includes("/attachments")) return json({ attachments: [] });
  if (url.endsWith(`/cases/${labCase.id}`)) return json(labCase);
  return json([]);
}) as typeof fetch;
const Wrapper = makeAuthWrapper("/cases", {
  user: { id: "browser-billing", username: "browser-billing", role: "billing", userType: "lab" },
  status: "authed", restoreStatus: "ok", restoreNoticeDismissed: true,
});
createRoot(document.getElementById("root")!).render(
  <Wrapper><AiPanelContext.Provider value={{ openPanel: () => {} }}>
    <CaseDrawer labCase={labCase} docked={!params.has("undocked")} onClose={() => { document.getElementById("root")!.textContent = "Drawer closed"; }} />
  </AiPanelContext.Provider></Wrapper>,
);
