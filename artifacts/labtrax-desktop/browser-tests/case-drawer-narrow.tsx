import React from "react";
import { createRoot } from "react-dom/client";
import { CaseDrawer } from "@/pages/cases";
import { makeAuthWrapper } from "@/__tests__/test-utils";
import type { SessionUser } from "@/lib/api";
import { AiPanelContext } from "@/lib/ai-panel-context";
import type { LabCase } from "@/lib/types";
import "@/index.css";

const caseId = "narrow-drawer-browser-case";
let priority: "normal" | "rush" = "normal";
const params = new URLSearchParams(window.location.search);

const detail: LabCase = {
  id: caseId,
  caseNumber: "26-99",
  patientFirstName: params.has("longName") ? "Alexandria-Catherine" : "Victoria",
  patientLastName: params.has("longName") ? "Montgomery-Worthington-Smythe" : "Dobosenski",
  doctorName: "Dr. Byrne",
  status: "received",
  priority,
  dueDate: "2026-01-19",
  dueTime: "13:30",
  receivedAt: "2026-01-16",
  createdAt: "2026-01-15T10:00:00.000Z",
  updatedAt: "2026-01-15T10:00:00.000Z",
  totalPrice: "0",
  labOrganizationId: "browser-lab",
  viewerIsLabMember: true,
  viewerCanManageAttachments: true,
  viewerCanUploadAttachments: params.has("accessibility"),
  viewerCanPostNotes: params.has("accessibility"),
  activeException: params.has("exception") ? { id: "browser-exception" } : null,
  restorations: params.has("accessibility")
    ? [{
        id: "browser-restoration",
        toothNumber: "8",
        restorationType: "Crown",
        restorationSubtype: null,
        arch: null,
        material: "Zirconia",
        shade: "A2",
        quantity: 1,
        unitPrice: "125.00",
        priceSource: null,
        priceSourceId: null,
        priceKey: null,
        createdAt: "2026-01-15T10:00:00.000Z",
      }]
    : [],
  notes: [],
  events: [],
  attachments: params.has("accessibility")
    ? [{
        id: "browser-attachment",
        fileName: "case-note.pdf",
        fileType: "application/pdf",
        visibility: "internal_lab_only",
        category: "document",
        note: null,
        createdAt: "2026-01-15T10:00:00.000Z",
        uploaderName: "Browser Test",
      }]
    : [],
} as unknown as LabCase;

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes(`/cases/${caseId}`)) {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as { priority?: "normal" | "rush" };
      if (patch.priority) priority = patch.priority;
    }
    return json({ ...detail, priority });
  }
  if (url.includes("/locations") || url.includes("/organizations")) {
    return json([]);
  }
  return json([]);
}) as typeof fetch;

const user: SessionUser = {
  id: "browser-admin",
  username: "browser-admin",
  role: "admin",
  userType: "lab",
};
const Wrapper = makeAuthWrapper("/cases", {
  user,
  status: "authed",
  restoreStatus: "ok",
  restoreNoticeDismissed: true,
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Wrapper>
      <AiPanelContext.Provider value={{ openPanel: () => {} }}>
        <CaseDrawer labCase={detail} onClose={() => {}} docked={params.has("docked")} />
      </AiPanelContext.Provider>
    </Wrapper>
  </React.StrictMode>,
);
