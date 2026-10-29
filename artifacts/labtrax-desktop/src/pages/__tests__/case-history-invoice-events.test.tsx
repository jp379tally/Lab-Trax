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

const INTERNAL_EXCEPTION_EVENTS = [
  {
    id: "evt-exception-issue",
    caseId: BASE_CASE.id,
    eventType: "internal_exception_opened_note",
    actorInitials: "OO",
    occurredAt: "2026-02-04T10:00:00Z",
    createdAt: "2026-02-04T10:00:00Z",
    metadataJson: {
      authorName: "Olive Owner",
      noteText: "The margin needs an internal review.",
      visibility: "internal_lab_only",
      internalException: true,
    },
  },
  {
    id: "evt-exception-note",
    caseId: BASE_CASE.id,
    eventType: "internal_exception_note_added",
    actorInitials: "TT",
    occurredAt: "2026-02-05T10:00:00Z",
    createdAt: "2026-02-05T10:00:00Z",
    metadataJson: {
      authorName: "Tina Tech",
      noteText: "The model was checked and re-articulated.",
      visibility: "internal_lab_only",
      internalException: true,
    },
  },
  {
    id: "evt-exception-resolution",
    caseId: BASE_CASE.id,
    eventType: "internal_exception_resolution_note_added",
    actorInitials: "OO",
    occurredAt: "2026-02-06T10:00:00Z",
    createdAt: "2026-02-06T10:00:00Z",
    metadataJson: {
      authorName: "Olive Owner",
      noteText: "The margin was corrected before release.",
      visibility: "internal_lab_only",
      internalException: true,
    },
  },
];

const DETAILED_CASE = {
  ...BASE_CASE,
  restorations: [],
  notes: [],
  attachments: [],
  events: [INVOICE_UPDATED_EVENT, INVOICE_VOIDED_EVENT, ...INTERNAL_EXCEPTION_EVENTS],
  viewerIsLabMember: true,
};

/**
 * Serves the case detail (`/cases/:id`) with the given events; every other
 * endpoint returns a safe empty array.
 */
function makeFetchStub(detail: unknown = DETAILED_CASE): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes(`/cases/${BASE_CASE.id}`) && !url.includes("?barcode=")) {
      return new Response(JSON.stringify(detail), {
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

/**
 * Builds an ISO timestamp for a LOCAL calendar day/time, so the day the row
 * renders ("MM/DD/YYYY", formatted in local time) is deterministic no matter
 * which timezone the test container runs in.
 */
function localIso(year: number, month: number, day: number, hour: number): string {
  return new Date(year, month - 1, day, hour, 0, 0).toISOString();
}

/**
 * Five status events: three on Aug 12, two on Aug 14. Exactly one calendar-day
 * boundary sits inside the run, so the timeline must show exactly one date
 * separator regardless of sort direction.
 */
const DATE_GROUPED_EVENTS = [
  { id: "evt-d1-a", hour: 9, day: 12 },
  { id: "evt-d1-b", hour: 11, day: 12 },
  { id: "evt-d1-c", hour: 15, day: 12 },
  { id: "evt-d2-a", hour: 9, day: 14 },
  { id: "evt-d2-b", hour: 13, day: 14 },
].map(({ id, hour, day }) => ({
  id,
  caseId: BASE_CASE.id,
  eventType: "note_added",
  actorInitials: "BK",
  occurredAt: localIso(2026, 8, day, hour),
  createdAt: localIso(2026, 8, day, hour),
  metadataJson: { authorName: "Bea Keeper", noteText: `Note ${id}` },
}));

const DATE_GROUPED_CASE = {
  ...BASE_CASE,
  restorations: [],
  notes: [],
  attachments: [],
  events: DATE_GROUPED_EVENTS,
  viewerIsLabMember: true,
};

async function renderHistoryTab() {
  const Wrapper = makeAuthWrapper("/cases");
  render(
    <Wrapper>
      {withAiPanel(<CaseDrawer labCase={BASE_CASE} onClose={() => {}} />)}
    </Wrapper>,
  );

  // Wait for the case detail query to resolve, then open the History tab.
  const historyTab = await screen.findByRole("tab", { name: /History/i });
  fireEvent.click(historyTab);
}

describe("Case History tab — invoice lifecycle events", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchStub());
  });

  it("renders an invoice_updated event as a plain-language one-line summary", async () => {
    await renderHistoryTab();

    // The row reads as a sentence instead of a stacked "Invoice Updated" title +
    // number + "draft → open" transition, matching the mobile History wording.
    await waitFor(() => {
      expect(screen.getByText("Invoice INV-9001 marked Open")).toBeInTheDocument();
    });
  });

  it("renders an invoice_voided event as a plain-language one-line summary", async () => {
    await renderHistoryTab();

    await waitFor(() => {
      expect(screen.getByText("Invoice INV-9002 voided")).toBeInTheDocument();
    });
  });

  it("surfaces the invoice number + status change within each summary", async () => {
    await renderHistoryTab();

    // The one-line summary still names WHICH invoice changed and its new status.
    await waitFor(() => {
      expect(screen.getByText("Invoice INV-9001 marked Open")).toBeInTheDocument();
    });
    expect(screen.getByText("Invoice INV-9002 voided")).toBeInTheDocument();
  });

  it("renders internal exception issue, follow-up, and resolution notes with their authors", async () => {
    await renderHistoryTab();

    await waitFor(() => {
      expect(screen.getByText("Internal Exception — Issue")).toBeInTheDocument();
    });
    expect(screen.getByText("Internal Exception Note")).toBeInTheDocument();
    expect(
      screen.getByText("Internal Exception — Resolution Note"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The margin needs an internal review."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The model was checked and re-articulated."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The margin was corrected before release."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("history-event-meta-evt-exception-issue")).toHaveTextContent(
      /Olive Owner · \d{1,2}:\d{2} (AM|PM)/,
    );
    expect(screen.getByTestId("history-event-meta-evt-exception-resolution")).toHaveTextContent(
      /Olive Owner · \d{1,2}:\d{2} (AM|PM)/,
    );
    expect(screen.getByTestId("history-event-meta-evt-exception-note")).toHaveTextContent(
      /Tina Tech · \d{1,2}:\d{2} (AM|PM)/,
    );
  });
});

describe("Case History tab — calendar-day headers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeFetchStub(DATE_GROUPED_CASE));
  });

  it("draws one bold header per date group and one rule per transition", async () => {
    await renderHistoryTab();

    // All five rows render...
    await waitFor(() => {
      expect(screen.getAllByText("Note Added")).toHaveLength(5);
    });

    // ...and 3 Aug-12 entries + 2 Aug-14 entries produce exactly two headers
    // with one transition rule and no leading or same-day rule.
    const headers = screen.getAllByTestId("history-day-header");
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent(/08\/14\/2026/);
    expect(headers[1]).toHaveTextContent(/08\/12\/2026/);
    const separators = screen.getAllByTestId("history-date-separator");
    expect(separators).toHaveLength(1);
    expect(separators[0]).toHaveClass("border-t-2");
    expect(headers[0]).toHaveClass("text-base", "font-semibold");
  });

  it("keeps one header per date group after toggling the sort direction", async () => {
    await renderHistoryTab();

    await waitFor(() => {
      expect(screen.getAllByTestId("history-day-header")).toHaveLength(2);
    });

    // Default is "Newest first"; flip to "Oldest first" and back.
    fireEvent.click(screen.getByRole("button", { name: /Newest first/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Oldest first/i })).toBeInTheDocument();
    });
    expect(screen.getAllByTestId("history-day-header")).toHaveLength(2);
    expect(screen.getAllByTestId("history-date-separator")).toHaveLength(1);
    expect(screen.getAllByTestId("history-day-header")[0]).toHaveTextContent(/08\/12\/2026/);
    expect(screen.getAllByTestId("history-day-header")[1]).toHaveTextContent(/08\/14\/2026/);

    fireEvent.click(screen.getByRole("button", { name: /Oldest first/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Newest first/i })).toBeInTheDocument();
    });
    expect(screen.getAllByTestId("history-day-header")).toHaveLength(2);
    expect(screen.getAllByTestId("history-date-separator")).toHaveLength(1);
    expect(screen.getAllByTestId("history-day-header")[0]).toHaveTextContent(/08\/14\/2026/);
    expect(screen.getAllByTestId("history-day-header")[1]).toHaveTextContent(/08\/12\/2026/);
  });

  it("keeps time-only metadata and groups events by the viewer's local day", async () => {
    const events = [
      {
        ...DATE_GROUPED_EVENTS[0],
        id: "evt-before-midnight",
        occurredAt: localIso(2026, 8, 12, 23),
        createdAt: localIso(2026, 8, 12, 23),
      },
      {
        ...DATE_GROUPED_EVENTS[1],
        id: "evt-after-midnight",
        occurredAt: localIso(2026, 8, 13, 0),
        createdAt: localIso(2026, 8, 13, 0),
      },
    ];
    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        ...DATE_GROUPED_CASE,
        events,
      }),
    );
    await renderHistoryTab();

    await waitFor(() => {
      expect(screen.getAllByTestId("history-day-header")).toHaveLength(2);
    });
    expect(screen.getByTestId("history-event-meta-evt-before-midnight")).toHaveTextContent(
      /Bea Keeper · (11:00 PM|12:00 AM)/,
    );
    expect(screen.getByTestId("history-event-meta-evt-before-midnight")).not.toHaveTextContent(
      /08\/12\/2026/,
    );
  });

  it("keeps one day rule alongside the merged-remake divider without duplicating it", async () => {
    const originalEvent = {
      ...DATE_GROUPED_EVENTS[0],
      id: "evt-original",
      occurredAt: localIso(2026, 8, 12, 9),
      createdAt: localIso(2026, 8, 12, 9),
    };
    const remakeEvent = {
      ...DATE_GROUPED_EVENTS[1],
      id: "evt-remake",
      occurredAt: localIso(2026, 8, 14, 9),
      createdAt: localIso(2026, 8, 14, 9),
    };
    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        ...DATE_GROUPED_CASE,
        events: [remakeEvent],
        originalCaseEvents: [originalEvent],
        remakeOriginal: { id: "case-original", caseNumber: "4999", kind: "canonical" },
      }),
    );
    await renderHistoryTab();

    await waitFor(() => {
      expect(screen.getAllByTestId("history-day-header")).toHaveLength(2);
    });
    expect(screen.getByText(`Case ${BASE_CASE.caseNumber}`)).toBeInTheDocument();
    expect(screen.getAllByTestId("history-date-separator")).toHaveLength(1);
  });
});
