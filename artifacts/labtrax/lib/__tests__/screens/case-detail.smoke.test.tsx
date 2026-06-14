import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import {
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockSearchParams,
  mockUpdateCaseMutateAsync,
  mockAddCaseNoteMutateAsync,
  mockDeleteAttachmentMutateAsync,
} from "../../../vitest.setup";

import { Alert } from "react-native";
import * as Sharing from "expo-sharing";
import { router } from "expo-router";
import { getAuthedMediaUri } from "@/lib/authed-media-cache";

import CaseDetailScreen from "@/app/case/[id]";
import {
  completedCaseWithInvoice,
  inProgressCase,
  sampleInvoice,
} from "./__fixtures__/cases";

afterEach(() => {
  cleanup();
  setMockSearchParams({});
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("CaseDetailScreen (read-only viewer)", () => {
  describe("when the case id does not match anything", () => {
    beforeEach(() => {
      setMockSearchParams({ id: "nonexistent-case-id" });
    });

    it("renders without throwing", () => {
      expect(() => render(<CaseDetailScreen />)).not.toThrow();
    });

    it("renders the unable-to-load empty state", () => {
      const { getByText } = render(<CaseDetailScreen />);
      expect(getByText("Unable to load this case")).toBeTruthy();
    });
  });

  describe("with a normal in-progress case", () => {
    beforeEach(() => {
      setMockSearchParams({ id: inProgressCase.id });
      setMockAppState({ cases: [inProgressCase], invoices: [] });
    });

    it("renders without throwing", () => {
      expect(() => render(<CaseDetailScreen />)).not.toThrow();
    });

    it("renders the case header (case number + patient)", () => {
      const { getAllByText } = render(<CaseDetailScreen />);
      expect(getAllByText(/#5001/).length).toBeGreaterThan(0);
      expect(getAllByText(/Jane Doe/).length).toBeGreaterThan(0);
    });

    it("shows patient and doctor in the default overview section", () => {
      const { getAllByText } = render(<CaseDetailScreen />);
      expect(getAllByText(/Jane Doe/).length).toBeGreaterThan(0);
      expect(getAllByText(/Dr. Smith/).length).toBeGreaterThan(0);
    });

    it("shows notes when the Notes section is selected", () => {
      const { getByTestId, getAllByText } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-notes"));
      expect(getAllByText(/Initial impression looks good/).length).toBeGreaterThan(0);
    });

    it("shows restoration material when the Restorations section is selected", () => {
      const { getByTestId, getAllByText } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-restorations"));
      expect(getAllByText(/Zirconia/).length).toBeGreaterThan(0);
    });

    it("shows history events when the History section is selected", () => {
      const { getByTestId, getAllByText } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-history"));
      expect(getAllByText(/Status Change/).length).toBeGreaterThan(0);
    });
  });

  describe("overview editing (desktop parity)", () => {
    beforeEach(() => {
      setMockSearchParams({ id: inProgressCase.id });
      setMockAppState({ cases: [inProgressCase], invoices: [] });
    });

    it("enters edit mode and saves only the changed field via useUpdateCase", async () => {
      const { getByTestId, getByDisplayValue, queryByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("overview-edit"));

      fireEvent.changeText(getByDisplayValue("Dr. Smith"), "Dr. Smithson");
      fireEvent.press(getByTestId("overview-save"));

      await waitFor(() => {
        expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
          caseId: inProgressCase.id,
          data: { doctorName: "Dr. Smithson" },
        });
      });
      // Returns to read mode after a successful save.
      await waitFor(() => expect(queryByTestId("overview-edit")).toBeTruthy());
    });

    it("locates the case to a new station via useUpdateCase (canonical status write)", async () => {
      // Status/location is changed exclusively through the desktop-style
      // "Locate Case" control (editor-only), not the edit form.
      const editableCase = { ...inProgressCase, organizationId: "org-1" };
      setMockSearchParams({ id: editableCase.id });
      setMockAppState({
        cases: [editableCase],
        invoices: [],
        meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
      });

      const { getByTestId } = render(<CaseDetailScreen />);
      // Pick a destination station, then press Locate (mirrors desktop).
      fireEvent.press(getByTestId("locate-select"));
      fireEvent.press(getByTestId("option-complete"));
      fireEvent.press(getByTestId("locate-confirm"));

      await waitFor(() => {
        expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
          caseId: editableCase.id,
          data: { status: "complete" },
        });
      });
      // Confirmation mirrors desktop's "Case located successfully."
      await waitFor(() => expect(getByTestId("locate-success")).toBeTruthy());
    });

    it("adds a note via useAddCaseNote with the default internal visibility", async () => {
      // The note composer is gated to editors, so seed an editable case +
      // active billing-role membership on its org → canEdit === true.
      const editableCase = { ...inProgressCase, organizationId: "org-1" };
      setMockSearchParams({ id: editableCase.id });
      setMockAppState({
        cases: [editableCase],
        invoices: [],
        meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
      });

      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-notes"));
      fireEvent.changeText(getByTestId("note-input"), "Follow-up scheduled");
      fireEvent.press(getByTestId("note-submit"));

      await waitFor(() => {
        expect(mockAddCaseNoteMutateAsync).toHaveBeenCalledWith({
          caseId: editableCase.id,
          data: { noteText: "Follow-up scheduled", visibility: "internal_lab_only" },
        });
      });
    });

    it("hides the note composer when the user cannot edit", () => {
      // Default membership stub → canEdit === false: notes remain readable but
      // the composer input is absent.
      const { getByTestId, queryByTestId, getAllByText } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-notes"));
      expect(getAllByText(/Initial impression looks good/).length).toBeGreaterThan(0);
      expect(queryByTestId("note-input")).toBeNull();
    });

    it("does not render the Locate Case card when the user cannot edit", () => {
      // Default membership stub → canEdit === false: the Locate Case control
      // (like every editor-only affordance) is absent.
      const { queryByTestId } = render(<CaseDetailScreen />);
      expect(queryByTestId("locate-select")).toBeNull();
      expect(queryByTestId("locate-confirm")).toBeNull();
    });
  });

  describe("with a completed case that has a real invoice", () => {
    beforeEach(() => {
      setMockSearchParams({ id: completedCaseWithInvoice.id });
      setMockAppState({
        cases: [completedCaseWithInvoice],
        invoices: [sampleInvoice],
      });
    });

    it("renders without throwing for a paid invoice attached to a complete case", () => {
      expect(() => render(<CaseDetailScreen />)).not.toThrow();
    });

    it("renders the completed case number in the header", () => {
      const { getAllByText } = render(<CaseDetailScreen />);
      expect(getAllByText(/#5002/).length).toBeGreaterThan(0);
    });

    it("shows the invoice number when the Invoice section is selected", () => {
      const { getByTestId, getByText } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-invoice"));
      expect(getByText(/Invoice #INV-2024-002/)).toBeTruthy();
    });

    it("exports the invoice PDF to the OS share sheet (available to all viewers)", async () => {
      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-invoice"));
      // Export is not gated to editors — a read-only viewer can still export.
      fireEvent.press(getByTestId("invoice-export"));

      await waitFor(() => {
        expect(vi.mocked(Sharing.shareAsync)).toHaveBeenCalled();
      });
      const [, opts] = vi.mocked(Sharing.shareAsync).mock.calls[0] as [
        string,
        { mimeType?: string },
      ];
      expect(opts.mimeType).toBe("application/pdf");
    });

    it("hides the Email action for a read-only viewer", () => {
      const { getByTestId, queryByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-invoice"));
      // Export is always present; Email is editor-only.
      expect(getByTestId("invoice-export")).toBeTruthy();
      expect(queryByTestId("invoice-email")).toBeNull();
    });
  });

  describe("files (open attachment) — desktop parity", () => {
    const pdfAttachment = {
      id: "att-pdf-1",
      fileName: "iTero_Rx_309233315.pdf",
      fileType: "application/pdf",
      uploaderName: "Lab Tech",
      createdAt: "2026-06-10T12:00:00.000Z",
    };
    const stlAttachment = {
      id: "att-stl-1",
      fileName: "scan.stl",
      fileType: "model/stl",
      uploaderName: "Lab Tech",
      createdAt: "2026-06-10T12:00:00.000Z",
    };
    const imageAttachment = {
      id: "att-img-1",
      fileName: "occlusal.jpg",
      fileType: "image/jpeg",
      uploaderName: "Lab Tech",
      createdAt: "2026-06-10T12:00:00.000Z",
    };

    beforeEach(() => {
      setMockSearchParams({ id: inProgressCase.id });
    });

    it("renders a tappable thumbnail for an image attachment", () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [imageAttachment],
      });
      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-files"));
      expect(getByTestId(`img-open-${imageAttachment.id}`)).toBeTruthy();
    });

    it("opens a tapped image thumbnail in the full-screen lightbox preview", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [imageAttachment],
      });
      const { getByTestId, queryByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-files"));

      // Lightbox is closed until the thumbnail is tapped.
      expect(queryByTestId("lightbox-image")).toBeNull();

      fireEvent.press(getByTestId(`img-open-${imageAttachment.id}`));

      await waitFor(() => expect(getByTestId("lightbox-image")).toBeTruthy());
      // Opening an image preview must not invoke the OS share sheet.
      expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
    });

    it("renders a tappable card for a PDF attachment", () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [pdfAttachment],
      });
      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-files"));
      expect(getByTestId(`doc-open-${pdfAttachment.id}`)).toBeTruthy();
    });

    it("opens a tapped PDF in the in-app viewer (never the share sheet)", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [pdfAttachment],
      });
      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-files"));
      fireEvent.press(getByTestId(`doc-open-${pdfAttachment.id}`));

      await waitFor(() => {
        expect(vi.mocked(router.push)).toHaveBeenCalledWith(
          expect.objectContaining({
            pathname: "/pdf-viewer",
            params: expect.objectContaining({
              url: `/api/cases/${inProgressCase.id}/attachments/${pdfAttachment.id}/file`,
              fileName: pdfAttachment.fileName,
              fileType: pdfAttachment.fileType,
            }),
          }),
        );
      });
      // Tapping a PDF must not invoke the OS share sheet.
      expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
    });

    it("opens a tapped 3D scan (STL/PLY/OBJ) in the in-app scan viewer (never the share sheet)", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [stlAttachment],
      });
      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-files"));
      fireEvent.press(getByTestId(`doc-open-${stlAttachment.id}`));

      await waitFor(() => {
        expect(vi.mocked(router.push)).toHaveBeenCalledWith(
          expect.objectContaining({
            pathname: "/scan-viewer",
            params: expect.objectContaining({
              url: `/api/cases/${inProgressCase.id}/attachments/${stlAttachment.id}/file`,
              fileName: stlAttachment.fileName,
              fileType: stlAttachment.fileType,
              format: "stl",
            }),
          }),
        );
      });
      expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
    });

    it("hides the delete affordance when the user cannot edit", () => {
      // Default useQuery stub returns no memberships → canEdit === false.
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [imageAttachment],
      });
      const { getByTestId, queryByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-files"));

      // The thumbnail is still viewable, but the trash button must be absent.
      expect(getByTestId(`img-open-${imageAttachment.id}`)).toBeTruthy();
      expect(queryByTestId(`img-delete-${imageAttachment.id}`)).toBeNull();
    });

    it("deletes an attachment after confirmation when the user can edit", async () => {
      const editableCase = { ...inProgressCase, organizationId: "org-1" };
      setMockSearchParams({ id: editableCase.id });
      setMockAppState({
        cases: [editableCase],
        invoices: [],
        attachments: [imageAttachment],
        // Active billing-role membership on the case's org → canEdit === true.
        meMemberships: [
          { organizationId: "org-1", role: "owner", status: "active" },
        ],
      });

      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId } = render(<CaseDetailScreen />);
        fireEvent.press(getByTestId("section-tab-files"));

        // Editors see the trash affordance; pressing it asks for confirmation.
        fireEvent.press(getByTestId(`img-delete-${imageAttachment.id}`));
        expect(alertSpy).toHaveBeenCalled();
        expect(mockDeleteAttachmentMutateAsync).not.toHaveBeenCalled();

        // Invoke the destructive "Delete" action from the confirm dialog.
        const buttons = alertSpy.mock.calls[0][2];
        const deleteButton = buttons?.find((b) => b.style === "destructive");
        expect(deleteButton).toBeTruthy();
        await deleteButton?.onPress?.();

        await waitFor(() =>
          expect(mockDeleteAttachmentMutateAsync).toHaveBeenCalledWith({
            caseId: editableCase.id,
            attachmentId: imageAttachment.id,
          }),
        );
      } finally {
        alertSpy.mockRestore();
      }
    });
  });

  describe("history (interactive attachments) — desktop parity", () => {
    const historyImageEvent = {
      id: "evt-att-img",
      eventType: "attachment_added",
      actorInitials: "AB",
      metadataJson: {
        attachmentId: "att-h-img",
        fileName: "occlusal.jpg",
        fileType: "image/jpeg",
      },
      occurredAt: "2024-01-12T10:00:00.000Z",
    };
    const historyPdfEvent = {
      id: "evt-att-pdf",
      eventType: "attachment_added",
      actorInitials: "AB",
      metadataJson: {
        attachmentId: "att-h-pdf",
        fileName: "iTero_Rx.pdf",
        fileType: "application/pdf",
      },
      occurredAt: "2024-01-12T11:00:00.000Z",
    };
    const caseWithHistoryAttachments = {
      ...inProgressCase,
      id: "case-history-att",
      events: [...inProgressCase.events, historyImageEvent, historyPdfEvent],
    };

    beforeEach(() => {
      setMockSearchParams({ id: caseWithHistoryAttachments.id });
      setMockAppState({ cases: [caseWithHistoryAttachments], invoices: [] });
    });

    it("renders a tappable thumbnail for an image attachment event", () => {
      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-history"));
      expect(getByTestId(`history-attachment-${historyImageEvent.id}`)).toBeTruthy();
    });

    it("opens a history image attachment in the full-screen lightbox preview", async () => {
      const { getByTestId, queryByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-history"));

      expect(queryByTestId("lightbox-image")).toBeNull();
      fireEvent.press(getByTestId(`history-attachment-${historyImageEvent.id}`));

      await waitFor(() => expect(getByTestId("lightbox-image")).toBeTruthy());
      expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
    });

    it("renders a tappable row for a non-image attachment event", () => {
      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-history"));
      expect(getByTestId(`history-attachment-${historyPdfEvent.id}`)).toBeTruthy();
    });

    it("opens a history PDF attachment in the in-app viewer (never the share sheet)", async () => {
      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-history"));
      fireEvent.press(getByTestId(`history-attachment-${historyPdfEvent.id}`));

      await waitFor(() => {
        expect(vi.mocked(router.push)).toHaveBeenCalledWith(
          expect.objectContaining({
            pathname: "/pdf-viewer",
            params: expect.objectContaining({
              url: `/api/cases/${caseWithHistoryAttachments.id}/attachments/${historyPdfEvent.metadataJson.attachmentId}/file`,
              fileName: historyPdfEvent.metadataJson.fileName,
              fileType: historyPdfEvent.metadataJson.fileType,
            }),
          }),
        );
      });
      expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
    });

    it("prefers the legacy imageUri over the canonical /file route when present", () => {
      const legacyEvent = {
        id: "evt-att-legacy",
        eventType: "attachment_added",
        actorInitials: "AB",
        metadataJson: {
          imageUri: "data:image/png;base64,AAAA",
          fileName: "legacy.png",
          fileType: "image/png",
        },
        occurredAt: "2024-01-12T12:00:00.000Z",
      };
      const legacyCase = {
        ...inProgressCase,
        id: "case-history-legacy",
        events: [...inProgressCase.events, legacyEvent],
      };
      setMockSearchParams({ id: legacyCase.id });
      setMockAppState({ cases: [legacyCase], invoices: [] });

      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-history"));
      expect(getByTestId(`history-attachment-${legacyEvent.id}`)).toBeTruthy();
    });
  });

  // ─── Generic (non-PDF, non-scan) document attachments ────────────────────────
  // These go through `openAttachment` → `getAuthedMediaUri` → local file:// URI
  // before the OS share sheet sees them. The contract: the raw API URL must
  // NEVER be passed directly to a browser tab or Linking.openURL — doing so
  // would produce a "401 Authentication Required" page for the user.
  describe("generic document attachments — auth-download path", () => {
    // A file that is neither an image, PDF, nor 3-D scan — goes through the
    // `openAttachment` / `getAuthedMediaUri` path regardless of platform.
    const docAttachment = {
      id: "att-docx-1",
      fileName: "treatment_plan.docx",
      fileType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      uploaderName: "Lab Tech",
      createdAt: "2026-06-10T12:00:00.000Z",
    };

    beforeEach(() => {
      setMockSearchParams({ id: inProgressCase.id });
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [docAttachment],
      });
    });

    it("renders a tappable card for the generic document attachment", () => {
      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-files"));
      expect(getByTestId(`doc-open-${docAttachment.id}`)).toBeTruthy();
    });

    it("calls getAuthedMediaUri (auth-download) and shares via a local file URI — never opens a raw API URL in a browser", async () => {
      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-files"));
      fireEvent.press(getByTestId(`doc-open-${docAttachment.id}`));

      await waitFor(() => {
        // The auth-aware cache layer must be entered: verifies the code does
        // NOT skip straight to Linking.openURL / WebBrowser with the raw URL.
        expect(vi.mocked(getAuthedMediaUri)).toHaveBeenCalledWith(
          `/api/cases/${inProgressCase.id}/attachments/${docAttachment.id}/file`,
        );
        // The OS share sheet is reached only with a local file:// URI that was
        // produced by downloading (with auth) and then copying to a named path.
        expect(vi.mocked(Sharing.shareAsync)).toHaveBeenCalledWith(
          expect.stringMatching(/^file:\/\//),
          expect.any(Object),
        );
      });
    });

    it("shows a user-friendly error alert when the authenticated download fails (not a silent auth-error page)", async () => {
      // Simulate a failed download (e.g., network error or 401 after token expiry).
      vi.mocked(getAuthedMediaUri).mockResolvedValueOnce(null);

      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId } = render(<CaseDetailScreen />);
        fireEvent.press(getByTestId("section-tab-files"));
        fireEvent.press(getByTestId(`doc-open-${docAttachment.id}`));

        await waitFor(() => {
          expect(alertSpy).toHaveBeenCalledWith(
            "Couldn't open file",
            expect.stringContaining("could not be downloaded"),
          );
        });
        // The OS share sheet must not be invoked when the download fails.
        expect(vi.mocked(Sharing.shareAsync)).not.toHaveBeenCalled();
      } finally {
        alertSpy.mockRestore();
      }
    });

    it("shows a user-friendly alert when the OS share sheet is not available on the device", async () => {
      vi.mocked(Sharing.isAvailableAsync).mockResolvedValueOnce(false);

      const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
      try {
        const { getByTestId } = render(<CaseDetailScreen />);
        fireEvent.press(getByTestId("section-tab-files"));
        fireEvent.press(getByTestId(`doc-open-${docAttachment.id}`));

        await waitFor(() => {
          expect(alertSpy).toHaveBeenCalledWith(
            "Can't open file",
            expect.stringContaining("supported"),
          );
        });
      } finally {
        alertSpy.mockRestore();
      }
    });
  });
});
