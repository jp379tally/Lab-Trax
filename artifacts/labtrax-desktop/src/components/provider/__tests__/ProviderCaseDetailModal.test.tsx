/** @vitest-environment jsdom */
/**
 * Unit tests for ProviderCaseDetailModal — file-attachment XHR auth path.
 *
 * Invariants protected:
 *  1. When a file is selected, the XHR Authorization header is set from
 *     getAccessToken(), NOT from localStorage.
 *  2. "File attached successfully." appears after the server returns 200.
 *  3. "Authentication required." is NOT shown when getAccessToken() returns a
 *     valid token (guards against a regression where the token lookup was broken
 *     and the component silently sent an unauthenticated request).
 */

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProviderCaseDetailModal } from "../ProviderCaseDetailModal";
import { makeWrapper } from "../../../__tests__/test-utils";

// ── API mock ─────────────────────────────────────────────────────────────────
const apiFetchMock = vi.fn();
const getAccessTokenMock = vi.fn();

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status = 500, body: unknown = null) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
  apiUrl: (path: string) => `/api${path}`,
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getAccessToken: () => getAccessTokenMock(),
}));

// ── Stub AuthedImage / MediaLightbox (require canvas in jsdom) ───────────────
vi.mock("@/components/AuthedMedia", () => ({
  AuthedImage: ({ alt }: { alt?: string }) => <img alt={alt ?? "photo"} />,
  MediaLightbox: () => null,
}));

// ── XHR mock helpers ─────────────────────────────────────────────────────────

/** Headers set via setRequestHeader, keyed by lowercased name. */
type XhrHeaders = Record<string, string>;

/** Subset of XHR state exposed to assertions. */
type XhrInstance = {
  open: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  status: number;
  responseText: string;
  headers: XhrHeaders;
};

/** Reference to the most-recently constructed mock XHR, captured in beforeEach. */
let lastXhr: XhrInstance | null = null;

/**
 * Returns a real ES6 class (not a vi.fn()) that the component can `new`.
 * Captures the instance in `lastXhr` so tests can inspect headers and
 * trigger onload/onerror callbacks.
 */
function makeMockXHRClass() {
  lastXhr = null;

  class MockXMLHttpRequest {
    open = vi.fn();
    send = vi.fn();
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    status = 200;
    responseText = "";
    headers: XhrHeaders = {};

    setRequestHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    }

    constructor() {
      lastXhr = this as unknown as XhrInstance;
    }
  }

  return MockXMLHttpRequest;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const CASE_DETAIL = {
  id: "case-123",
  caseNumber: "1001",
  patientFirstName: "John",
  patientLastName: "Smith",
  caseType: "Crown",
  notes: [
    {
      id: "shared-note-1",
      noteText: "Handle with care.",
      visibility: "shared_with_provider",
    },
  ],
  timeline: [],
  invoiceLines: [],
  invoiceTotal: null,
  invoiceStatus: null,
  viewerCanPostNotes: true,
  viewerQuickReferenceOrganizationId: "provider-org-1",
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function renderModal(caseId = "case-123", onClose = vi.fn()) {
  const Wrapper = makeWrapper("/");
  return render(
    <ProviderCaseDetailModal caseId={caseId} onClose={onClose} />,
    { wrapper: Wrapper },
  );
}

/**
 * Simulate the user picking a file via the hidden <input type="file">.
 *
 * JSDOM does not implement the real FileList / DataTransfer APIs, so we set
 * `files` directly on the element via Object.defineProperty and fire a
 * synthetic change event whose target IS that element.
 */
function pickFile(file = new File(["data"], "test.pdf", { type: "application/pdf" })) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  if (!input) throw new Error("file input not found in document");

  Object.defineProperty(input, "files", {
    value: { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) },
    configurable: true,
    writable: false,
  });

  fireEvent.change(input);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
beforeEach(() => {
  vi.resetAllMocks();

  // Install fresh XHR mock for this test
  vi.stubGlobal("XMLHttpRequest", makeMockXHRClass());

  // Default: getAccessToken returns a valid token
  getAccessTokenMock.mockReturnValue("test-access-token-xyz");

  // apiFetch resolves with case detail by default
  apiFetchMock.mockImplementation((path: unknown) =>
    Promise.resolve(
      String(path).includes("quick-reference-notes")
        ? {
            notes: [
              {
                id: "template-1",
                label: "Rush request",
                body: "Please prioritize this case.",
                isActive: true,
              },
            ],
          }
        : CASE_DETAIL,
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ProviderCaseDetailModal — clinical summary and invoice", () => {
  it("renders only explicitly shared lab notes and keeps prescription notes in the Rx view", async () => {
    apiFetchMock.mockImplementation((path: unknown) =>
      Promise.resolve(
        String(path).includes("quick-reference-notes")
          ? { notes: [] }
          : {
              ...CASE_DETAIL,
              rxNotes: "Prescription instructions only.",
              notes: [
                {
                  id: "shared",
                  noteText: "Shared lab update.",
                  visibility: "shared_with_provider",
                },
                {
                  id: "internal",
                  noteText: "INTERNAL SECRET",
                  visibility: "internal_lab_only",
                },
              ],
            },
      ),
    );

    renderModal();
    expect(await screen.findByText("Shared lab update.")).toBeInTheDocument();
    expect(screen.queryByText("INTERNAL SECRET")).not.toBeInTheDocument();
    expect(screen.queryByText("Prescription instructions only.")).not.toBeInTheDocument();
  });

  it("shows provider-safe restoration details and a readable removable step, with prices behind View Invoice", async () => {
    const detail = {
      ...CASE_DETAIL,
      caseType: "Removable",
      step: "wax_setup",
      invoiceId: "invoice-1",
      invoiceNumber: "INV-1001",
      invoiceStatus: "open",
      invoiceTotal: "250.00",
      restorations: [
        {
          id: "restoration-1",
          toothNumber: "Upper",
          restorationType: "Removable",
          restorationSubtype: "Full Denture",
          material: "Acrylic",
          shade: "A2",
        },
      ],
      invoiceLines: [
        {
          description: "Full denture",
          quantity: 2,
          unitPrice: "125.00",
          totalPrice: "250.00",
        },
      ],
    };
    apiFetchMock.mockImplementation((path: unknown) =>
      Promise.resolve(
        String(path).includes("quick-reference-notes") ? { notes: [] } : detail,
      ),
    );

    renderModal();

    expect(await screen.findByText("Upper")).toBeInTheDocument();
    expect(screen.getByText("Removable · Full Denture")).toBeInTheDocument();
    expect(screen.getByText("Acrylic")).toBeInTheDocument();
    expect(screen.getByText("Wax Setup")).toBeInTheDocument();
    expect(screen.queryByText("$125.00")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /view invoice/i }));

    expect(screen.getByText("$125.00")).toBeInTheDocument();
    expect(screen.getAllByText("$250.00")).toHaveLength(2);
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("uses a neutral placeholder when a removable step is unavailable", async () => {
    apiFetchMock.mockImplementation((path: unknown) =>
      Promise.resolve(
        String(path).includes("quick-reference-notes")
          ? { notes: [] }
          : { ...CASE_DETAIL, caseType: "Full Denture", step: null },
      ),
    );

    renderModal();

    expect(await screen.findByText("Current Step")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("ProviderCaseDetailModal — file attachment XHR auth", () => {
  it("offers the provider organization's quick-reference templates in the note composer", async () => {
    renderModal();
    const toggle = await screen.findByTestId("provider-quick-reference-toggle");
    fireEvent.click(toggle);
    const template = await screen.findByText("Rush request");
    fireEvent.click(template);
    expect(screen.getByPlaceholderText("Type your message here…")).toHaveValue(
      "Please prioritize this case.",
    );
  });

  it("sets Authorization header from getAccessToken(), not from localStorage", async () => {
    // Ensure localStorage has no token so we confirm getAccessToken() is the source
    localStorage.removeItem("labtrax_desktop_tokens_v1");

    renderModal();

    // Wait for the case detail to load (file input becomes available)
    await screen.findByText("Case #1001");

    pickFile();

    // XHR must have been created and opened
    expect(lastXhr).not.toBeNull();
    expect(lastXhr!.open).toHaveBeenCalledWith(
      "POST",
      expect.stringContaining("/cases/provider/case-123/attachments"),
    );

    // Authorization header must carry the token returned by getAccessToken()
    expect(lastXhr!.headers["authorization"]).toBe("Bearer test-access-token-xyz");

    // getAccessToken must have been called (not localStorage)
    expect(getAccessTokenMock).toHaveBeenCalled();
  });

  it("shows 'File attached successfully.' after the server returns 200", async () => {
    renderModal();
    await screen.findByText("Case #1001");

    pickFile();

    expect(lastXhr).not.toBeNull();

    // Simulate a successful server response
    lastXhr!.status = 200;
    lastXhr!.onload?.();

    await waitFor(() =>
      expect(screen.getByText("File attached successfully.")).toBeInTheDocument(),
    );
  });

  it("does NOT show 'Authentication required.' when getAccessToken() returns a valid token", async () => {
    renderModal();
    await screen.findByText("Case #1001");

    pickFile();

    expect(lastXhr).not.toBeNull();

    // Simulate a successful server response
    lastXhr!.status = 200;
    lastXhr!.onload?.();

    await waitFor(() =>
      expect(screen.getByText("File attached successfully.")).toBeInTheDocument(),
    );

    // The auth-error message must never appear
    expect(screen.queryByText("Authentication required.")).not.toBeInTheDocument();
  });

  it("shows the server error message when the upload fails with a non-2xx status", async () => {
    renderModal();
    await screen.findByText("Case #1001");

    pickFile();

    expect(lastXhr).not.toBeNull();

    lastXhr!.status = 401;
    lastXhr!.responseText = JSON.stringify({ message: "Authentication required." });
    lastXhr!.onload?.();

    await waitFor(() =>
      expect(screen.getByText("Authentication required.")).toBeInTheDocument(),
    );

    // Success message must NOT appear
    expect(screen.queryByText("File attached successfully.")).not.toBeInTheDocument();
  });

  it("refreshes the timeline in place after a successful upload, showing the new file without a reload", async () => {
    const CASE_DETAIL_WITH_FILE = {
      ...CASE_DETAIL,
      timeline: [
        {
          type: "file",
          id: "att-1",
          label: "test.pdf",
          timestamp: "2026-01-01T00:00:00.000Z",
          attachmentId: "att-1",
          fileName: "test.pdf",
          fileType: "application/pdf",
        },
      ],
    };

    let caseDetailCalls = 0;
    apiFetchMock.mockImplementation((path: unknown) => {
      if (String(path).includes("quick-reference-notes")) {
        return Promise.resolve({ notes: [] });
      }
      caseDetailCalls += 1;
      // First call (on mount) has no attachments yet; every call after the
      // upload succeeds returns the file now present on the case.
      return Promise.resolve(caseDetailCalls === 1 ? CASE_DETAIL : CASE_DETAIL_WITH_FILE);
    });

    renderModal();
    await screen.findByText("Case #1001");

    // No file in the timeline yet
    expect(screen.queryByText("test.pdf")).not.toBeInTheDocument();

    pickFile();
    expect(lastXhr).not.toBeNull();

    lastXhr!.status = 200;
    lastXhr!.onload?.();

    // The provider sees their uploaded file appear in the timeline without
    // reloading the page or the modal.
    await waitFor(() => expect(screen.getByText("test.pdf")).toBeInTheDocument());
  });

  // ── Returned-case "View Rx" ────────────────────────────────────────────────
  //
  // The server flags the timeline entry where a case came back into the lab.
  // Only that entry gets a "View Rx" button, and the prescription it opens is
  // built entirely from provider-safe detail fields.

  describe("returned-case View Rx", () => {
    const RETURN_TIMELINE = [
      {
        type: "status",
        id: "ev-complete",
        label: "complete",
        timestamp: "2026-01-01T00:00:00.000Z",
        fromStatus: "in_progress",
        isCaseReturn: false,
      },
      {
        type: "status",
        id: "ev-return",
        label: "received",
        timestamp: "2026-01-02T00:00:00.000Z",
        fromStatus: "complete",
        isCaseReturn: true,
      },
    ];

    const CASE_DETAIL_RETURNED = {
      ...CASE_DETAIL,
      doctorName: "Dr. Synthetic058",
      practiceName: "Bright Smiles Dental",
      rxNotes: "Match the adjacent central.",
      restorations: [
        {
          id: "res-1",
          toothNumber: "14",
          restorationType: "Crown",
          material: "Zirconia",
          shade: "A2",
        },
      ],
      timeline: RETURN_TIMELINE,
    };

    function mockReturnedCase(detail: Record<string, unknown> = CASE_DETAIL_RETURNED) {
      apiFetchMock.mockImplementation((path: unknown) =>
        Promise.resolve(
          String(path).includes("quick-reference-notes") ? { notes: [] } : detail,
        ),
      );
    }

    it("shows View Rx only on the entry where the case returned", async () => {
      mockReturnedCase();
      renderModal();
      await screen.findByText("Case #1001");

      expect(await screen.findByTestId("provider-timeline-view-rx-ev-return")).
        toBeInTheDocument();
      expect(
        screen.queryByTestId("provider-timeline-view-rx-ev-complete"),
      ).not.toBeInTheDocument();
      expect(screen.getAllByText("View Rx")).toHaveLength(1);
    });

    it("opens a prescription view with the case, patient, doctor, practice, restorations and Rx notes", async () => {
      mockReturnedCase();
      renderModal();
      await screen.findByText("Case #1001");

      expect(screen.queryByTestId("provider-rx-dialog")).not.toBeInTheDocument();
      fireEvent.click(await screen.findByTestId("provider-timeline-view-rx-ev-return"));

      const dialog = await screen.findByTestId("provider-rx-dialog");
      expect(dialog).toHaveTextContent("Prescription");
      expect(dialog).toHaveTextContent("1001");
      expect(dialog).toHaveTextContent("John Smith");
      expect(dialog).toHaveTextContent("Dr. Synthetic058");
      expect(dialog).toHaveTextContent("Bright Smiles Dental");
      expect(dialog).toHaveTextContent("14");
      expect(dialog).toHaveTextContent("Crown");
      expect(dialog).toHaveTextContent("Zirconia");
      expect(dialog).toHaveTextContent("A2");
      expect(dialog).toHaveTextContent("Match the adjacent central.");
    });

    it("does not show View Rx when no timeline entry is flagged as a return", async () => {
      mockReturnedCase({
        ...CASE_DETAIL_RETURNED,
        timeline: [{ ...RETURN_TIMELINE[1], isCaseReturn: false }],
      });
      renderModal();
      await screen.findByText("Case #1001");

      expect(screen.queryByText("View Rx")).not.toBeInTheDocument();
    });
  });

  it("skips the Authorization header when getAccessToken() returns null", async () => {
    // Simulate a missing / expired token
    getAccessTokenMock.mockReturnValue(null);

    renderModal();
    await screen.findByText("Case #1001");

    pickFile();

    expect(lastXhr).not.toBeNull();

    // Authorization header must not have been set
    expect(lastXhr!.headers["authorization"]).toBeUndefined();
  });
});
