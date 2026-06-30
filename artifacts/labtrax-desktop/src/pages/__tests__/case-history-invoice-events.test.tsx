/** @vitest-environment jsdom */
/**
 * Case History tab — invoice lifecycle events (bulk status changes)
 *
 * The server mirrors invoice bulk-status changes onto the case timeline by
 * inserting `invoice_updated` / `invoice_voided` `caseEvents` (see the
 * bulk-status handler in `artifacts/api-server/src/routes/invoices.ts`). Backend
 * tests prove those rows are persisted, but nothing on the desktop side proved
 * the History tab actually renders them — a rendering regression could silently
 * hide bulk status changes from users.
 *
 * Guards:
 * - An `invoice_updated` event renders as a timeline row reading "Invoice
 *   Updated" (the wording produced by `formatEventType`).
 * - An `invoice_voided` event renders as a timeline row reading "Invoice
 *   Voided".
 * - The row surfaces the metadata it depends on: the `invoiceNumber` and the
 *   `previousStatus → newStatus` transition.
 */

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CaseDrawer } from "@/pages/cases";
import type { LabCase } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { AiPanelContext } from "@/lib/ai-panel-context";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

function withAiPanel(children: React.ReactNode) {
  return (
    <AiPanelContext.Provider value={{ openPanel: () => {} }}>
      {children}
    </AiPanelContext.Provider>
  );
}

const LAB_ID = "lab-hist";

const BASE_CASE: LabCase = {
  id: "case-hist-1",
  caseNumber: "5001",
  patientFirstName: "Pat",
  patientLastName: "History",
  doctorName: "Dr. Time",
  status: "received",
  priority: "normal",
  dueDate: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  totalPrice: "0",
  labOrganizationId: LAB_ID,
} as unknown as LabCase;

/**
 * Two case timeline events shaped exactly like the bulk-status caseEvents the
 * server writes (eventType + metadataJson with invoiceNumber / previousStatus /
 * newStatus).
 */
const INVOICE_UPDATED_EVENT = {
  id: "evt-updated",
  caseId: BASE_CASE.id,
  eventType: "invoice_updated",
  actorInitials: "BK",
  occurredAt: "2026-02-02T10:00:00Z",
  createdAt: "2026-02-02T10:00:00Z",
  metadataJson: {
    invoiceId: "inv-1",
    invoiceNumber: "INV-9001",
    previousStatus: "draft",
    newStatus: "open",
  },
};

const INVOICE_VOIDED_EVENT = {
  id: "evt-voided",
  caseId: BASE_CASE.id,
  eventType: "invoice_voided",
  actorInitials: "BK",
  occurredAt: "2026-02-03T10:00:00Z",
  createdAt: "2026-02-03T10:00:00Z",
  metadataJson: {
    invoiceId: "inv-2",
    invoiceNumber: "INV-9002",
    previousStatus: "open",
    newStatus: "void",
  },
};

const DETAILED_CASE = {
  ...BASE_CASE,
  restorations: [],
  notes: [],
  attachments: [],
  events: [INVOICE_UPDATED_EVENT, INVOICE_VOIDED_EVENT],
  viewerIsLabMember: true,
};

/**
 * Serves the case detail (`/cases/:id`) with the two invoice events; every
 * other endpoint returns a safe empty array.
 */
function makeFetchStub(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes(`/cases/${BASE_CASE.id}`) && !url.includes("?barcode=")) {
      return new Response(JSON.stringify(DETAILED_CASE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

async function renderHistoryTab() {
  const Wrapper = makeAuthWrapper("/cases");
  render(
    <Wrapper>
      {withAiPanel(<CaseDrawer labCase={BASE_CASE} onClose={() => {}} />)}
    </Wrapper>,
  );

  // Wait for the case detail query to resolve, then open the History tab.
  const historyTab = await screen.findByRole("button", { name: /History/i });
  fireEvent.click(historyTab);
}

describe("Case History tab — invoice lifecycle events", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchStub());
  });

  it("renders an invoice_updated event as an 'Invoice Updated' timeline row", async () => {
    await renderHistoryTab();

    await waitFor(() => {
      expect(screen.getByText("Invoice Updated")).toBeInTheDocument();
    });
  });

  it("renders an invoice_voided event as an 'Invoice Voided' timeline row", async () => {
    await renderHistoryTab();

    await waitFor(() => {
      expect(screen.getByText("Invoice Voided")).toBeInTheDocument();
    });
  });

  it("surfaces the invoice number metadata on the timeline row", async () => {
    await renderHistoryTab();

    await waitFor(() => {
      expect(screen.getByText("INV-9001")).toBeInTheDocument();
    });
    expect(screen.getByText("INV-9002")).toBeInTheDocument();
  });

  it("renders the previousStatus → newStatus transition for each invoice event", async () => {
    await renderHistoryTab();

    // invoice_updated: draft → open
    await waitFor(() => {
      expect(screen.getByText("draft")).toBeInTheDocument();
    });
    // "open" is both the updated event's newStatus and the voided event's
    // previousStatus, so it appears twice.
    expect(screen.getAllByText("open").length).toBe(2);

    // invoice_voided: open → void
    expect(screen.getByText("void")).toBeInTheDocument();
  });
});
