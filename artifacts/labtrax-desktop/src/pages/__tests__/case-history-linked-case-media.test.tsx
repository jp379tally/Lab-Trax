/** @vitest-environment jsdom */
/**
 * Case History tab — attachment media on a merged remake timeline
 *
 * A remake case's History also renders the linked original case's events, and
 * an original case renders its remake children's events. The protected file
 * route (`/api/cases/:caseId/attachments/:attachmentId/file`) is scoped to the
 * case in its URL — that scoping is how the server authorizes the read — so a
 * thumbnail URL built from the case on screen 404s for a linked case's
 * attachment and renders the "Unavailable" placeholder.
 *
 * Guards:
 * - An attachment entry merged in from the linked ORIGINAL case is fetched
 *   under the original case's id.
 * - An attachment entry merged in from a remake CHILD is fetched under that
 *   child's id.
 * - An attachment entry on the case actually being viewed is unchanged.
 */

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

const LAB_ID = "lab-remake-media";
/** The case the drawer is opened on — a remake. */
const VIEWED_CASE_ID = "case-remake-b";
/** The case it is a remake of. */
const ORIGINAL_CASE_ID = "case-original-a";
/** A remake child of the viewed case. */
const CHILD_CASE_ID = "case-remake-c";

const BASE_CASE: LabCase = {
  id: VIEWED_CASE_ID,
  caseNumber: "26-809B",
  patientFirstName: "Mona",
  patientLastName: "Reyes",
  doctorName: "Dr. Remake",
  status: "in_progress",
  priority: "normal",
  dueDate: null,
  createdAt: "2026-03-01T00:00:00Z",
  updatedAt: "2026-03-04T00:00:00Z",
  totalPrice: "0",
  labOrganizationId: LAB_ID,
} as unknown as LabCase;

function photoEvent(id: string, caseId: string, attachmentId: string, occurredAt: string) {
  return {
    id,
    caseId,
    eventType: "case_attachment_added",
    actorInitials: "MR",
    occurredAt,
    createdAt: occurredAt,
    metadataJson: {
      attachmentId,
      fileName: `${attachmentId}.jpg`,
      fileType: "image/jpeg",
      mediaKind: "photo",
    },
  };
}

const ORIGINAL_PHOTO = photoEvent(
  "evt-original-photo",
  ORIGINAL_CASE_ID,
  "att-original-1",
  "2026-03-01T10:00:00Z",
);
const OWN_PHOTO = photoEvent(
  "evt-own-photo",
  VIEWED_CASE_ID,
  "att-own-1",
  "2026-03-02T10:00:00Z",
);
const CHILD_PHOTO = photoEvent(
  "evt-child-photo",
  CHILD_CASE_ID,
  "att-child-1",
  "2026-03-03T10:00:00Z",
);

const DETAILED_CASE = {
  ...BASE_CASE,
  restorations: [],
  notes: [],
  attachments: [],
  events: [OWN_PHOTO],
  originalCaseEvents: [ORIGINAL_PHOTO],
  remakeOriginal: { id: ORIGINAL_CASE_ID, caseNumber: "26-809", kind: "canonical" },
  remakeChildrenEvents: [
    { caseId: CHILD_CASE_ID, caseNumber: "26-809C", events: [CHILD_PHOTO] },
  ],
  viewerIsLabMember: true,
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const BLOB_URL = "blob:labtrax/history-photo";
let origCreate: typeof URL.createObjectURL | undefined;
let origRevoke: typeof URL.revokeObjectURL | undefined;
let fetchStub: ReturnType<typeof vi.fn>;

/** Every `/attachments/:id/file` URL the drawer requested. */
function fileUrls(): string[] {
  return fetchStub.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes("/attachments/") && u.endsWith("/file"));
}

beforeEach(() => {
  fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/attachments/") && url.endsWith("/file")) {
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), {
        status: 200,
      });
    }
    if (url.includes("/remake-chain")) return json({ chain: [] });
    if (url.includes(`/cases/${VIEWED_CASE_ID}`) && !url.includes("?barcode=")) {
      return json(DETAILED_CASE);
    }
    return json([]);
  });
  vi.stubGlobal("fetch", fetchStub);
  // jsdom has no object URLs; patch onto the real URL so `new URL(...)` keeps
  // working for the same-origin check.
  origCreate = URL.createObjectURL;
  origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => BLOB_URL) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
});

afterEach(() => {
  URL.createObjectURL = origCreate as typeof URL.createObjectURL;
  URL.revokeObjectURL = origRevoke as typeof URL.revokeObjectURL;
});

async function renderHistoryTab() {
  const Wrapper = makeAuthWrapper("/cases");
  render(
    <Wrapper>
      {withAiPanel(<CaseDrawer labCase={BASE_CASE} onClose={() => {}} />)}
    </Wrapper>,
  );
  const historyTab = await screen.findByRole("button", { name: /History/i });
  fireEvent.click(historyTab);
  // All three timeline photos have started loading.
  await waitFor(() => expect(fileUrls().length).toBe(3));
}

describe("Case History tab — media URLs on a merged remake timeline", () => {
  it("fetches an original case's photo under the ORIGINAL case id, not the viewed case", async () => {
    await renderHistoryTab();

    expect(
      fileUrls().some((u) =>
        u.includes(`/cases/${ORIGINAL_CASE_ID}/attachments/att-original-1/file`),
      ),
    ).toBe(true);
    // The bug: the original's attachment requested under the remake's id 404s.
    expect(
      fileUrls().some((u) =>
        u.includes(`/cases/${VIEWED_CASE_ID}/attachments/att-original-1/file`),
      ),
    ).toBe(false);
  });

  it("fetches a remake child's photo under the CHILD case id", async () => {
    await renderHistoryTab();

    expect(
      fileUrls().some((u) =>
        u.includes(`/cases/${CHILD_CASE_ID}/attachments/att-child-1/file`),
      ),
    ).toBe(true);
    expect(
      fileUrls().some((u) =>
        u.includes(`/cases/${VIEWED_CASE_ID}/attachments/att-child-1/file`),
      ),
    ).toBe(false);
  });

  it("keeps fetching the viewed case's own photo under the viewed case id", async () => {
    await renderHistoryTab();

    expect(
      fileUrls().some((u) =>
        u.includes(`/cases/${VIEWED_CASE_ID}/attachments/att-own-1/file`),
      ),
    ).toBe(true);
  });
});
