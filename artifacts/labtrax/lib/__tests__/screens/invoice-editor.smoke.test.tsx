import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import {
  resetMockAppState,
  setMockAppState,
  setMockSearchParams,
  mockUpdateInvoiceMutateAsync,
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
  vi.clearAllMocks();
});

function renderEditor() {
  setMockSearchParams({ id: invoiceWithSubItems.id });
  setMockAppState({ invoices: [invoiceWithSubItems] });
  return render(<InvoiceEditorScreen />);
}

describe("InvoiceEditorScreen (full-screen editor, desktop parity)", () => {
  it("renders without throwing and surfaces carried-through sub-items", () => {
    const { getByText } = renderEditor();
    expect(getByText(/1 sub-item \(edit on desktop\)/)).toBeTruthy();
  });

  it("saves the hydrated fields untouched, round-tripping displayMetadata + sub-items", async () => {
    const { getByTestId } = renderEditor();

    // Save immediately, without editing anything: this proves the prefill flows
    // straight into the payload (invoiceNumber/status/teeth/shade) and that the
    // sub-items and non-edited metadata are preserved verbatim.
    fireEvent.press(getByTestId("invoice-editor-save"));

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

  it("flows edited number / status / teeth / shade into the update payload", async () => {
    const { getByTestId } = renderEditor();

    fireEvent.changeText(getByTestId("invoice-editor-number"), "INV-9999");
    fireEvent.changeText(getByTestId("invoice-editor-teeth"), "6-11");
    fireEvent.changeText(getByTestId("invoice-editor-shade"), "B1");
    fireEvent.press(getByTestId("invoice-editor-status-paid"));
    fireEvent.press(getByTestId("invoice-editor-save"));

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
    const { getByTestId } = renderEditor();

    fireEvent.changeText(getByTestId("invoice-editor-number"), "   ");
    fireEvent.press(getByTestId("invoice-editor-save"));

    // Validation short-circuits before the mutation fires.
    await waitFor(() => expect(mockUpdateInvoiceMutateAsync).not.toHaveBeenCalled());
  });
});
