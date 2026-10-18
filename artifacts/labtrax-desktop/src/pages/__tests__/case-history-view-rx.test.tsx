/** @vitest-environment jsdom */
/**
 * Case History tab — "View Rx" on returned-case entries
 *
 * When a finished case comes back into the lab the History timeline shows a
 * completion-family status followed by an intake-family status, and already
 * draws a "Case returned" divider above it. Lab staff almost always want to
 * re-read the prescription at that moment, so those rows (and only those rows)
 * carry a compact "View Rx" button that opens the existing prescription
 * preview drawer.
 *
 * Guards:
 * - The completion→intake entry renders a "View Rx" button.
 * - An ordinary location change and the very first "Received" entry of a
 *   brand-new case render nothing new.
 * - Pressing the button opens the prescription preview.
 * - On a merged remake-chain timeline the button previews the case the entry
 *   belongs to, not the case the drawer happens to be open on.
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

const LAB_ID = "lab-return";
const CASE_ID = "case-return-1";
const CHILD_CASE_ID = "case-return-child";

const BASE_CASE: LabCase = {
  id: CASE_ID,
  caseNumber: "7001",
  patientFirstName: "Rita",
  patientLastName: "Turner",
  doctorName: "Dr. Back",
  status: "received",
  priority: "normal",
  dueDate: null,
  createdAt: "2026-02-01T00:00:00Z",
  updatedAt: "2026-02-06T00:00:00Z",
  totalPrice: "0",
  labOrganizationId: LAB_ID,
} as unknown as LabCase;

function statusEvent(
  id: string,
  fromStatus: string | null,
  toStatus: string,
  occurredAt: string,
  caseId = CASE_ID,
) {
  return {
    id,
    caseId,
    eventType: "status_changed",
    actorInitials: "RT",
    occurredAt,
    createdAt: occurredAt,
    metadataJson: fromStatus ? { fromStatus, toStatus } : { toStatus },
  };
}

/** The very first "Received" entry of a brand-new case — no prior status. */
const FIRST_RECEIVED = statusEvent("evt-first-received", null, "received", "2026-02-01T10:00:00Z");
/** An ordinary location change. */
const ORDINARY_MOVE = statusEvent("evt-ordinary", "received", "in_progress", "2026-02-02T10:00:00Z");
const MARKED_COMPLETE = statusEvent("evt-complete", "in_progress", "complete", "2026-02-03T10:00:00Z");
/** The case coming back into the lab. */
const RETURN_EVENT = statusEvent("evt-return", "complete", "received", "2026-02-04T10:00:00Z");

/** A return that happened on a remake child, merged into this timeline. */
const CHILD_COMPLETE = statusEvent(
  "evt-child-complete",
  "in_progress",
  "complete",
  "2026-02-05T10:00:00Z",
  CHILD_CASE_ID,
);
const CHILD_RETURN = statusEvent(
  "evt-child-return",
  "complete",
  "received",
  "2026-02-06T10:00:00Z",
  CHILD_CASE_ID,
);

const DETAILED_CASE = {
  ...BASE_CASE,
  restorations: [],
  notes: [],
  attachments: [],
  events: [FIRST_RECEIVED, ORDINARY_MOVE, MARKED_COMPLETE, RETURN_EVENT],
  remakeChildrenEvents: [
    {
      caseId: CHILD_CASE_ID,
      caseNumber: "7001-R1",
      events: [CHILD_COMPLETE, CHILD_RETURN],
    },
  ],
  viewerIsLabMember: true,
};

const CHILD_DETAILED_CASE = {
  ...BASE_CASE,
  id: CHILD_CASE_ID,
  caseNumber: "7001-R1",
  restorations: [],
  notes: [],
  attachments: [],
  events: [],
  viewerIsLabMember: true,
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetchStub(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/remake-chain")) return json({ chain: [] });
    if (url.includes(`/cases/${CHILD_CASE_ID}`)) return json(CHILD_DETAILED_CASE);
    if (url.includes(`/cases/${CASE_ID}`) && !url.includes("?barcode=")) {
      return json(DETAILED_CASE);
    }
    return json([]);
  });
}

let fetchStub: ReturnType<typeof vi.fn>;

async function renderHistoryTab() {
  const Wrapper = makeAuthWrapper("/cases");
  render(
    <Wrapper>
      {withAiPanel(<CaseDrawer labCase={BASE_CASE} onClose={() => {}} />)}
    </Wrapper>,
  );
  const historyTab = await screen.findByRole("button", { name: /History/i });
  fireEvent.click(historyTab);
}

describe("Case History tab — View Rx on returned-case entries", () => {
  beforeEach(() => {
    fetchStub = makeFetchStub();
    vi.stubGlobal("fetch", fetchStub);
  });

  it("shows a View Rx button on the completion→intake entry", async () => {
    await renderHistoryTab();

    await waitFor(() => {
      expect(screen.getByTestId(`history-view-rx-${RETURN_EVENT.id}`)).toBeInTheDocument();
    });
    // Same wording as mobile, and reachable by its accessible label.
    expect(screen.getAllByRole("button", { name: "View Rx" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Case returned")).toHaveLength(2);
    expect(screen.getAllByTestId("history-day-header")).toHaveLength(6);
    expect(screen.queryAllByTestId("history-date-separator")).toHaveLength(5);
  });

  it("does not show View Rx on ordinary location changes or a first-ever Received entry", async () => {
    await renderHistoryTab();

    await waitFor(() => {
      expect(screen.getByTestId(`history-view-rx-${RETURN_EVENT.id}`)).toBeInTheDocument();
    });
    expect(screen.queryByTestId(`history-view-rx-${FIRST_RECEIVED.id}`)).toBeNull();
    expect(screen.queryByTestId(`history-view-rx-${ORDINARY_MOVE.id}`)).toBeNull();
    expect(screen.queryByTestId(`history-view-rx-${MARKED_COMPLETE.id}`)).toBeNull();
  });

  it("opens the prescription preview for the open case when pressed", async () => {
    await renderHistoryTab();

    const button = await screen.findByTestId(`history-view-rx-${RETURN_EVENT.id}`);
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Prescription preview")).toBeInTheDocument();
    });
    // The open case — not a remake child — was requested.
    expect(
      fetchStub.mock.calls.some((c) =>
        String(c[0]).includes(`/cases/${CHILD_CASE_ID}/remake-chain`),
      ),
    ).toBe(false);
  });

  it("previews the remake child's prescription for an entry that belongs to it", async () => {
    await renderHistoryTab();

    const button = await screen.findByTestId(`history-view-rx-${CHILD_RETURN.id}`);
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Prescription preview")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        fetchStub.mock.calls.some((c) =>
          String(c[0]).includes(`/cases/${CHILD_CASE_ID}/remake-chain`),
        ),
      ).toBe(true);
    });
  });
});
