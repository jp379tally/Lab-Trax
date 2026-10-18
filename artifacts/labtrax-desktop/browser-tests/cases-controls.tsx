import React from "react";
import { createRoot } from "react-dom/client";
import CasesPage from "@/pages/cases";
import { makeAuthWrapper } from "@/__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";
import "@/index.css";

const rows = ["preview-case-a", "preview-case-b"].map((id, index) => ({
  id, caseNumber: `CASE-${index + 1}`, patientFirstName: "Preview", patientLastName: index ? "Second" : "First",
  doctorName: "Dr. Test", status: "received", priority: "normal", createdAt: "2026-01-15T10:00:00Z",
  receivedAt: "2026-01-16", dueDate: "2026-01-19", updatedAt: "2026-01-15T10:00:00Z",
  totalPrice: "110", labOrganizationId: "controls-lab", viewerIsLabMember: true,
  restorations: [], notes: [], events: [], attachments: [],
}));
const invoice = {
  id: "preview-invoice", invoiceNumber: "INV-PREVIEW", labOrganizationId: "controls-lab", caseId: rows[0].id,
  status: "open", issuedAt: "2026-01-15T12:00:00Z", dueAt: "2026-01-30T12:00:00Z", createdAt: "2026-01-15T12:00:00Z",
  tax: 0, discount: 0, total: 110, balanceDue: 110, subtotal: 110, amountPaid: 0, notes: "Saved invoice note", payments: [],
  displayMetadata: { patientName: "Preview First", billTo: "Dr. Test", lineItems: [{ item: "Crown", quantity: 1, unitPrice: 110, lineTotal: 110 }] },
  items: [{ id: "line-1", description: "Crown", quantity: 1, unitPrice: 110, lineTotal: 110, restorationId: null }],
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
// The real renderer and editors, isolated from clinical data and all writes.
const requests: string[] = [];
Object.assign(window, { casesControlRequests: requests });
globalThis.fetch = async (input) => {
  const url = new URL(String(input), window.location.origin);
  requests.push(url.pathname + url.search);
  if (url.pathname.endsWith("/cases/worklist")) return json({ rows, total: 2, page: 1, pageSize: 10, hasMore: false, salesTotal: "220" });
  if (url.pathname.endsWith("/cases/overview")) return json({ data: {
    totalCases: 2, dueToday: 0, conflicts: 0, rushCases: 0,
    processingCases: 0, inTransitCases: 0, completedCases: 0, overdueCases: 0,
    receivedCases: 2, inDesignCases: 0, modelRoomCases: 0, shippedCases: 0,
    scanCases: 0, millingCases: 0, postMillCases: 0, sinteringFurnaceCases: 0,
    porcelainCases: 0, qualityCheckCases: 0, onHoldCases: 0, remakeCases: 0,
  } });
  const row = rows.find(r => url.pathname.endsWith(`/cases/${r.id}`));
  if (row) return json(row);
  if (url.pathname.endsWith(`/invoices/${invoice.id}`)) return json(invoice);
  if (url.pathname.endsWith("/invoices")) return json([invoice]);
  if (url.pathname.endsWith("/attachments")) return json({ attachments: [] });
  if (url.pathname.endsWith("/organizations")) return json([{ id: "controls-lab", type: "lab", name: "Controls Lab" }]);
  return json([]);
};
const Wrapper = makeAuthWrapper("/cases", {
  user: { id: "controls-admin", username: "controls-admin", role: "admin", userType: "lab" },
  status: "authed", restoreStatus: "ok", restoreNoticeDismissed: true,
});
createRoot(document.getElementById("root")!).render(<Wrapper><AiPanelContext.Provider value={{ openPanel: () => {} }}><CasesPage /></AiPanelContext.Provider></Wrapper>);
