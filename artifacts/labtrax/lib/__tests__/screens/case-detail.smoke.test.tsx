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

    it("changes status through the JS option picker", async () => {
      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("overview-edit"));
      fireEvent.press(getByTestId("select-status"));
      fireEvent.press(getByTestId("option-complete"));
      fireEvent.press(getByTestId("overview-save"));

      await waitFor(() => {
        expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
          caseId: inProgressCase.id,
          data: { status: "complete" },
        });
      });
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

    it("does not render status-transition chips when the user cannot edit", () => {
      const { queryByTestId } = render(<CaseDetailScreen />);
      // in_design → next pipeline step is "scan"; chips are editor-only.
      expect(queryByTestId("status-chip-scan")).toBeNull();
    });

    it("performs a one-tap status transition via useUpdateCase when editable", async () => {
      const editableCase = { ...inProgressCase, organizationId: "org-1" };
      setMockSearchParams({ id: editableCase.id });
      setMockAppState({
        cases: [editableCase],
        invoices: [],
        meMemberships: [{ organizationId: "org-1", role: "owner", status: "active" }],
      });

      const { getByTestId } = render(<CaseDetailScreen />);
      // in_design advances to "scan" as the next pipeline step.
      fireEvent.press(getByTestId("status-chip-scan"));

      await waitFor(() => {
        expect(mockUpdateCaseMutateAsync).toHaveBeenCalledWith({
          caseId: editableCase.id,
          data: { status: "scan" },
        });
      });
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

    it("opens a tapped non-PDF document through the system viewer / share sheet", async () => {
      setMockAppState({
        cases: [inProgressCase],
        invoices: [],
        attachments: [stlAttachment],
      });
      const { getByTestId } = render(<CaseDetailScreen />);
      fireEvent.press(getByTestId("section-tab-files"));
      fireEvent.press(getByTestId(`doc-open-${stlAttachment.id}`));

      await waitFor(() => {
        expect(vi.mocked(Sharing.shareAsync)).toHaveBeenCalled();
      });
      expect(vi.mocked(router.push)).not.toHaveBeenCalled();
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
});
