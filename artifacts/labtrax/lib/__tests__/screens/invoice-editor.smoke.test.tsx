import React from "react";
import { Alert } from "react-native";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  resetMockAppState,
  setMockAppState,
  setMockSearchParams,
  mockUpdateInvoiceMutateAsync,
  setMockFetchHandler,
  resetMockFetchHandler,
} from "../../../vitest.setup";

import InvoiceEditorScreen from "@/app/invoice-editor/[id]";

// An invoice that carries both nested sub-items and a populated displayMetadata
// blob (credits / patientName the mobile editor never edits). The PATCH replaces
// ALL line items and the whole displayMetadata, so the editor MUST round-trip
// these untouched or it silently hard-deletes the sub-items and wipes the
// metadata desktop relies on.
const invoiceWithSubItems = {
  id: "inv-1",
  invoiceNumber: "INV-0007",
  status: "open",
  displayMetadata: {
    teeth: "8-10",
    shade: "A2",
    credits: 50,
    patientName: "Jane Doe",
    billTo: "Dr. Casey",
    doctorName: "Dr. Casey",
    caseNumber: "28625",
    caseType: "Implant Planning · Surgical Guide",
    material: "Zirconia",
    caseNotes: "Use the distal scan.",
    lineItems: [{ item: "Crown", subItems: [{ item: "Custom shade" }] }],
  },
  items: [
    {
      id: "li-1",
      toothNumber: 8,
      toothLabel: "8-10",
      description: "Zirconia Crown",
      quantity: 1,
      unitPrice: 450,
      subItems: [
        {
          id: "si-1",
          toothNumber: 8,
          description: "Custom staining",
          quantity: 1,
          unitPrice: 30,
          sortOrder: 0,
        },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  setMockSearchParams({});
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

async function renderEditor() {
  setMockSearchParams({ id: invoiceWithSubItems.id });
  setMockAppState({ invoices: [invoiceWithSubItems] });
  return await render(<InvoiceEditorScreen />);
}

describe("InvoiceEditorScreen (full-screen editor, desktop parity)", () => {
  it("shows ambiguous legacy charge review guidance and acknowledges it with an explicit save", async () => {
    setMockSearchParams({ id: invoiceWithSubItems.id });
    setMockAppState({ invoices: [{
      ...invoiceWithSubItems,
      displayMetadata: {
        ...invoiceWithSubItems.displayMetadata,
        legacyChargesNeedsReview: true,
        reviewedCharges: true,
        reviewedChargesNeedsReview: true,
      },
    }] });
    const { getByTestId } = await render(<InvoiceEditorScreen />);
    expect(getByTestId("invoice-editor-legacy-review-warning")).toBeTruthy();
    expect(mockUpdateInvoiceMutateAsync).not.toHaveBeenCalled();
    await fireEvent.press(getByTestId("invoice-editor-save"));
    await waitFor(() => expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({
        displayMetadata: expect.objectContaining({
          reviewedCharges: true, reviewedChargesNeedsReview: false, legacyChargesNeedsReview: false,
        }),
      }) }),
    ));
  });
  it("shows case-change review warnings and clears them only on explicit save", async () => {
    setMockSearchParams({ id: invoiceWithSubItems.id });
    setMockAppState({ invoices: [{
      ...invoiceWithSubItems,
      displayMetadata: {
        ...invoiceWithSubItems.displayMetadata,
        reviewedChargesNeedsReview: true,
      },
    }] });
    const { getByTestId } = await render(<InvoiceEditorScreen />);
    expect(getByTestId("invoice-editor-legacy-review-warning")).toBeTruthy();
    await fireEvent.press(getByTestId("invoice-editor-save"));
    await waitFor(() => expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({
        displayMetadata: expect.objectContaining({
          reviewedCharges: true,
          reviewedChargesNeedsReview: false,
        }),
      }) }),
    ));
  });
  it("keeps patient and prescription context visible in the stacked editor", async () => {
    const screen = await renderEditor();
    expect(screen.getByTestId("invoice-editor-patient-name").props.value).toBe("Jane Doe");
    expect(screen.getByTestId("invoice-editor-prescription-reference")).toBeTruthy();
    expect(screen.getByText("28625")).toBeTruthy();
    expect(screen.getByText("Use the distal scan.")).toBeTruthy();
    expect(screen.getByTestId("invoice-editor-scroll").props.horizontal).toBe(false);

    await fireEvent.changeText(screen.getByTestId("invoice-editor-patient-name"), "Jane Updated");
    await fireEvent.press(screen.getByTestId("invoice-editor-save"));
    await waitFor(() => expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({
        displayMetadata: expect.objectContaining({ patientName: "Jane Updated" }),
      }) }),
    ));
  });
  it("keeps the AI-import review notice visible and retryable after acknowledgment fails", async () => {
    setMockSearchParams({ id: invoiceWithSubItems.id });
    const importedInvoice = {
      ...invoiceWithSubItems,
      aiGenerated: true,
      aiPricingWarning: "Confirm the extracted unit prices.",
    };
    const reviewedInvoice = {
      ...importedInvoice,
      aiReviewedAt: "2026-10-25T18:30:00.000Z",
      aiReviewedByUserId: "reviewer-1",
      aiReviewedByName: "Jamie Reviewer",
    };
    setMockAppState({ invoices: [importedInvoice], liveInvoiceQueries: true });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let reviewRequestCount = 0;
    setMockFetchHandler((url, init) => {
      requests.push({ url, init });
      if (url.includes("/ai-review")) {
        reviewRequestCount += 1;
        if (reviewRequestCount === 1) {
          return new Response(JSON.stringify({ message: "Review service unavailable." }), {
            status: 503,
          });
        }
        // A subsequent GET must reflect the committed acknowledgment, just
        // like the real server. Otherwise invalidation refetches this fixture's
        // old unreviewed row and erases the correctly updated query cache.
        setMockAppState({ invoices: [reviewedInvoice], liveInvoiceQueries: true });
        return new Response(
          JSON.stringify({
            ok: true,
            data: reviewedInvoice,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <InvoiceEditorScreen />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("invoice-editor-ai-review-warning")).toBeTruthy();
    expect(await screen.findByText("Confirm the extracted unit prices.")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("invoice-editor-mark-ai-reviewed"));

    await waitFor(() => expect(alert).toHaveBeenCalledWith(
      "Could not mark reviewed",
      "Could not confirm this invoice was marked reviewed. Please try again. You can retry from the review notice.",
    ));
    expect(screen.getByTestId("invoice-editor-ai-review-warning")).toBeTruthy();
    expect(screen.getByTestId("invoice-editor-mark-ai-reviewed").props.disabled).toBe(false);

    await fireEvent.press(screen.getByTestId("invoice-editor-mark-ai-reviewed"));
    await waitFor(() => expect(screen.queryByTestId("invoice-editor-ai-review-warning")).toBeNull());
    expect(await screen.findByTestId("invoice-ai-review-record")).toBeTruthy();
    expect(screen.getByText(/Reviewed by Jamie Reviewer/)).toBeTruthy();
    await waitFor(() => {
      expect(queryClient.getQueryState(["invoices", invoiceWithSubItems.id])).toMatchObject({
        fetchStatus: "idle",
        isInvalidated: false,
        data: reviewedInvoice,
      });
    });
    expect(reviewRequestCount).toBe(2);
    expect(requests.filter((request) => request.url.includes("/ai-review"))).toEqual([
      expect.objectContaining({
        url: expect.stringContaining(`/invoices/${invoiceWithSubItems.id}/ai-review`),
        init: expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ acknowledged: true }),
        }),
      }),
      expect.objectContaining({
        url: expect.stringContaining(`/invoices/${invoiceWithSubItems.id}/ai-review`),
        init: expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ acknowledged: true }),
        }),
      }),
    ]);
  });
  it("shows the saved reviewer and acknowledgment time after review", async () => {
    setMockSearchParams({ id: invoiceWithSubItems.id });
    setMockAppState({ invoices: [{
      ...invoiceWithSubItems,
      aiGenerated: true,
      aiReviewedAt: "2026-10-25T18:30:00.000Z",
      aiReviewedByUserId: "reviewer-1",
      aiReviewedByName: "Jamie Reviewer",
    }] });

    const screen = await render(<InvoiceEditorScreen />);
    const reviewRecord = screen.getByTestId("invoice-ai-review-record");
    expect(reviewRecord).toBeTruthy();
    expect(screen.getByText(/Reviewed by Jamie Reviewer/)).toBeTruthy();
    expect(screen.getByText(/10\/25\/2026/)).toBeTruthy();
    expect(screen.getByText(/(?:AM|PM)/)).toBeTruthy();
  });
  it.each([
    { ok: true },
    { data: { id: "different-invoice", aiReviewedAt: "2026-10-25T18:30:00.000Z" } },
    { data: { id: invoiceWithSubItems.id, aiReviewedAt: "not-a-timestamp" } },
  ])("keeps the notice retryable without a matching persisted receipt: %j", async (payload) => {
    setMockSearchParams({ id: invoiceWithSubItems.id });
    setMockAppState({ invoices: [{ ...invoiceWithSubItems, aiGenerated: true }] });
    setMockFetchHandler(() => new Response(JSON.stringify(payload), { status: 200 }));
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    const screen = await render(<InvoiceEditorScreen />);
    await fireEvent.press(screen.getByTestId("invoice-editor-mark-ai-reviewed"));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(
      "Could not mark reviewed",
      expect.stringContaining("Could not confirm this invoice was marked reviewed"),
    ));
    expect(screen.getByTestId("invoice-editor-ai-review-warning")).toBeTruthy();
    expect(screen.queryByTestId("invoice-ai-review-record")).toBeNull();
    expect(screen.getByTestId("invoice-editor-mark-ai-reviewed").props.disabled).toBe(false);
  });
  it("renders without throwing and surfaces carried-through sub-items", async () => {
    const { getByText } = await renderEditor();
    expect(getByText(/1 sub-item \(edit on desktop\)/)).toBeTruthy();
  });

  it("saves the hydrated fields untouched, round-tripping displayMetadata + sub-items", async () => {
    const { getByTestId } = await renderEditor();

    // Save immediately, without editing anything: this proves the prefill flows
    // straight into the payload (invoiceNumber/status/teeth/shade) and that the
    // sub-items and non-edited metadata are preserved verbatim.
    await fireEvent.press(getByTestId("invoice-editor-save"));

    await waitFor(() =>
      expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: "inv-1",
          data: expect.objectContaining({
            invoiceNumber: "INV-0007",
            status: "open",
            displayMetadata: expect.objectContaining({
              teeth: "8-10",
              shade: "A2",
              credits: 50,
              patientName: "Jane Doe",
            }),
            items: expect.arrayContaining([
              expect.objectContaining({
                id: "li-1",
                sortOrder: 0,
                toothLabel: "8-10",
                description: "Zirconia Crown",
                subItems: expect.arrayContaining([
                  expect.objectContaining({
                    id: "si-1",
                    description: "Custom staining",
                    sortOrder: 0,
                  }),
                ]),
              }),
            ]),
          }),
        }),
      ),
    );
  });

  it("defaults provider note sharing to private and saves the choice in the docked editor", async () => {
    const screen = await renderEditor();
    const shareSwitch = screen.getByTestId("invoice-editor-share-notes");
    expect(shareSwitch.props.value).toBe(false);
    expect(screen.getByTestId("invoice-editor-save-dock")).toBeTruthy();
    expect(screen.getByTestId("invoice-editor-dock-balance")).toBeTruthy();

    await fireEvent(shareSwitch, "valueChange", true);
    await fireEvent.press(screen.getByTestId("invoice-editor-save"));
    await waitFor(() => expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shareNotesWithProvider: true,
          displayMetadata: expect.objectContaining({
            shareNotesWithProvider: true,
            credits: 50,
          }),
        }),
      }),
    ));
  });

  it("restores a previously enabled provider note-sharing choice", async () => {
    setMockSearchParams({ id: invoiceWithSubItems.id });
    setMockAppState({
      invoices: [{
        ...invoiceWithSubItems,
        displayMetadata: {
          ...invoiceWithSubItems.displayMetadata,
          shareNotesWithProvider: true,
        },
      }],
    });
    const screen = await render(<InvoiceEditorScreen />);
    expect(screen.getByTestId("invoice-editor-share-notes").props.value).toBe(true);
  });

  it("flows edited number / status / teeth / shade into the update payload", async () => {
    const { getByTestId } = await renderEditor();

    await fireEvent.changeText(getByTestId("invoice-editor-number"), "INV-9999");
    await fireEvent.changeText(getByTestId("invoice-editor-teeth"), "6-11");
    await fireEvent.changeText(getByTestId("invoice-editor-shade"), "B1");
    await fireEvent.press(getByTestId("invoice-editor-status-paid"));
    await fireEvent.press(getByTestId("invoice-editor-save"));

    await waitFor(() =>
      expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: "inv-1",
          data: expect.objectContaining({
            invoiceNumber: "INV-9999",
            status: "paid",
            displayMetadata: expect.objectContaining({
              teeth: "6-11",
              shade: "B1",
              // Untouched metadata still survives an edit.
              credits: 50,
              patientName: "Jane Doe",
            }),
          }),
        }),
      ),
    );
  });

  it("blocks saving when the invoice number is cleared", async () => {
    const { getByTestId } = await renderEditor();

    await fireEvent.changeText(getByTestId("invoice-editor-number"), "   ");
    await fireEvent.press(getByTestId("invoice-editor-save"));

    // Validation short-circuits before the mutation fires.
    await waitFor(() => expect(mockUpdateInvoiceMutateAsync).not.toHaveBeenCalled());
  });

  it("rejects a blank price instead of converting it to zero", async () => {
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    const { getByTestId } = await renderEditor();
    await fireEvent.changeText(getByTestId("invoice-editor-line-price-0"), "");
    await fireEvent.press(getByTestId("invoice-editor-save"));

    await waitFor(() => {
      expect(mockUpdateInvoiceMutateAsync).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledWith(
        "Valid price required",
        expect.stringContaining("Enter 0"),
      );
    });
  });

  it("saves an explicitly entered zero price", async () => {
    const { getByTestId } = await renderEditor();
    await fireEvent.changeText(getByTestId("invoice-editor-line-price-0"), "0");
    await fireEvent.press(getByTestId("invoice-editor-save"));

    await waitFor(() =>
      expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({ id: "li-1", unitPrice: 0 }),
            ]),
          }),
        }),
      ),
    );
  });
});
