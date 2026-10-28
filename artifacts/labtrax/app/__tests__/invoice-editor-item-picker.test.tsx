/**
 * Tests for the mobile invoice editor item picker.
 *
 * Invariants protected:
 *  - Selecting a catalog item from the picker updates the line's description
 *    AND unit price to the item's configured price.
 *  - Choosing "Custom item" switches the description field to a free-text
 *    TextInput without wiping the existing description.
 */

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor, within } from "@testing-library/react-native";
import { Alert, StyleSheet } from "react-native";
import { router } from "expo-router";
import { queryClient } from "@/lib/query-client";
import {
  mockUpdateInvoiceMutateAsync,
  mockInvalidateQueries,
  resetMockAppState,
  setMockAppState,
  setMockSearchParams,
  setMockFetchHandler,
  resetMockFetchHandler,
} from "../../vitest.setup";

import InvoiceEditorScreen from "@/app/invoice-editor/[id]";

// Two catalog billable items the lab has configured.
const BILLABLE_ITEMS = [
  { id: "item-crown", name: "PFM Crown", unitPrice: "150" },
  { id: "item-veneer", name: "Porcelain Veneer", unitPrice: "200" },
  {
    id: "legacy-discount",
    name: "Courtesy discount",
    unitPrice: "400",
    priceKey: "discount-key",
  },
];

function seedInvoiceWithLine() {
  setMockAppState({
    invoices: [
      {
        id: "inv-editor-001",
        invoiceNumber: "INV-001",
        status: "open",
        labOrganizationId: "lab-1",
        items: [
          {
            id: "line-a",
            description: "My custom description",
            quantity: 1,
            unitPrice: "99",
            subItems: [],
          },
        ],
        lineItems: null,
      },
    ],
  });
  setMockSearchParams({ id: "inv-editor-001" });
  // Return billable items for the vendors endpoint, pass everything else through.
  setMockFetchHandler((url) => {
    if (url.includes("/api/finance/vendors")) {
      return new Response(JSON.stringify(BILLABLE_ITEMS), { status: 200 });
    }
    if (url.includes("/api/pricing/discount-items")) {
      return new Response(
        JSON.stringify({
          data: {
            items: [
              {
                key: "discount-key",
                label: "Courtesy discount",
                unitPrice: 400,
                isDiscount: true,
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  });
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("InvoiceEditorScreen — item picker", () => {
  it("keeps status and line-item actions large enough for touch", async () => {
    seedInvoiceWithLine();
    const screen = await render(<InvoiceEditorScreen />);

    const statusStyle = StyleSheet.flatten(
      screen.getByTestId("invoice-editor-status-open").props.style,
    );
    const addStyle = StyleSheet.flatten(
      screen.getByTestId("invoice-editor-add-line").props.style,
    );
    const removeStyle = StyleSheet.flatten(
      screen.getByTestId("invoice-editor-remove-line-0").props.style,
    );
    expect(statusStyle.minHeight).toBe(44);
    expect(addStyle.minHeight).toBe(44);
    expect(removeStyle.width).toBe(44);
    expect(removeStyle.height).toBe(44);
  });

  it("selecting a catalog item updates the line description and unit price", async () => {
    seedInvoiceWithLine();
    const screen = await render(<InvoiceEditorScreen />);

    // The description field renders as a Pressable trigger (not a TextInput)
    // once billable items have loaded. Wait for the async fetch to complete.
    await waitFor(() => {
      // When loaded, the Pressable trigger is rendered; it has no `value` prop.
      const trigger = screen.getByTestId("invoice-editor-line-desc-0");
      expect(trigger.props.value).toBeUndefined();
    });

    // Tap the trigger to open the item picker sheet.
    await fireEvent.press(screen.getByTestId("invoice-editor-line-desc-0"));

    // Select the "PFM Crown" catalog item.
    await fireEvent.press(screen.getByTestId("item-picker-item-crown"));

    // The picker closes and the line's description should update to the item name.
    await waitFor(() => {
      const lineCard = screen.getByTestId("invoice-editor-line-0");
      within(lineCard).getByText("PFM Crown");
    });

    // The unit price field should be updated to the item's configured price.
    const priceInput = screen.getByTestId("invoice-editor-line-price-0");
    expect(priceInput.props.value).toBe("150");
  });

  it("choosing 'Custom item' switches to free-text mode without changing the description", async () => {
    seedInvoiceWithLine();
    const screen = await render(<InvoiceEditorScreen />);

    // Wait for billable items to load (field renders as a Pressable trigger).
    await waitFor(() => {
      const trigger = screen.getByTestId("invoice-editor-line-desc-0");
      expect(trigger.props.value).toBeUndefined();
    });

    // Tap the trigger to open the item picker sheet.
    await fireEvent.press(screen.getByTestId("invoice-editor-line-desc-0"));

    // Choose "Custom item" to switch to free-text mode.
    await fireEvent.press(screen.getByTestId("item-picker-custom"));

    // The field at the same testID should now be a TextInput (has a `value`
    // prop) and the original description must be preserved unchanged.
    await waitFor(() => {
      const descField = screen.getByTestId("invoice-editor-line-desc-0");
      expect(descField.props.value).toBe("My custom description");
    });
  });

  it("adds a catalog discount as a negative invoice line and updates mobile totals", async () => {
    seedInvoiceWithLine();
    setMockAppState({
      invoices: [
        {
          id: "inv-editor-001",
          invoiceNumber: "INV-001",
          status: "open",
          labOrganizationId: "lab-1",
          total: "500",
          balanceDue: "500",
          items: [
            {
              id: "line-a",
              description: "Crown",
              quantity: 1,
              unitPrice: "500",
              subItems: [],
            },
          ],
          lineItems: null,
        },
      ],
    });
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() =>
      expect(screen.getByTestId("invoice-editor-line-price-0").props.value).toBe("500"),
    );

    await fireEvent.press(screen.getByTestId("invoice-editor-add-line"));
    expect(screen.queryByTestId("item-picker-legacy-discount")).toBeNull();
    await fireEvent.press(screen.getByTestId("item-picker-discount:discount-key"));

    await waitFor(() => {
      expect(screen.getByTestId("invoice-editor-line-price-1").props.value).toBe("400");
      expect(screen.getByText("DISCOUNT")).toBeTruthy();
      expect(screen.getAllByText("$100.00").length).toBeGreaterThan(0);
    });
    await fireEvent.press(screen.getByTestId("invoice-editor-save"));
    await waitFor(() =>
      expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({
                description: "Courtesy discount",
                unitPrice: -400,
                isDiscount: true,
              }),
            ]),
          }),
        }),
      ),
    );
  });
});

describe("InvoiceEditorScreen — committed invoice edits", () => {
  it("keeps the corrected price and nested charge in the write and refreshes sales views", async () => {
    seedInvoiceWithLine();
    setMockAppState({
      invoices: [{
        id: "inv-editor-001",
        invoiceNumber: "INV-001",
        status: "open",
        labOrganizationId: "lab-1",
        items: [{
          id: "line-a", description: "Crown", quantity: 1, unitPrice: "5",
          subItems: [{ id: "child-a", description: "Layered Porcelain", quantity: 1, unitPrice: "37" }],
        }],
      }],
    });
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() => expect(screen.getByTestId("invoice-editor-line-price-0").props.value).toBe("5"));
    await fireEvent.changeText(screen.getByTestId("invoice-editor-line-price-0"), "10");
    await fireEvent.press(screen.getByTestId("invoice-editor-save"));

    await waitFor(() => {
      expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: "inv-editor-001",
          data: expect.objectContaining({
            items: [expect.objectContaining({
              id: "line-a",
              unitPrice: 10,
              subItems: [expect.objectContaining({ id: "child-a", unitPrice: 37 })],
            })],
          }),
        }),
      );
      expect(router.back).toHaveBeenCalled();
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["invoices"] });
      const predicate = mockInvalidateQueries.mock.calls
        .map(([filter]) => (filter as { predicate?: (query: { queryKey: unknown[] }) => boolean })?.predicate)
        .find((value) => value !== undefined);
      expect(predicate).toBeDefined();
      expect(predicate!({ queryKey: ["reports", "sales-forecast", "lab-1"] } as never)).toBe(true);
      expect(predicate!({ queryKey: ["stats", "summary", "lab-1"] } as never)).toBe(true);
    });
  });

  it("leaves the editor open and does not refresh sales when the write fails", async () => {
    seedInvoiceWithLine();
    mockUpdateInvoiceMutateAsync.mockRejectedValueOnce(new Error("Server refused update"));
    const alert = vi.spyOn(Alert, "alert");
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() => expect(screen.getByTestId("invoice-editor-line-price-0").props.value).toBe("99"));
    await fireEvent.changeText(screen.getByTestId("invoice-editor-line-price-0"), "10");
    await fireEvent.press(screen.getByTestId("invoice-editor-save"));
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Couldn't save invoice", "Server refused update"));
    expect(router.back).not.toHaveBeenCalled();
    expect(screen.getByTestId("invoice-editor-line-price-0").props.value).toBe("10");
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it("does not present a committed edit as a failed save if report refresh fails", async () => {
    seedInvoiceWithLine();
    mockInvalidateQueries.mockRejectedValueOnce(new Error("Offline during refresh"));
    const alert = vi.spyOn(Alert, "alert");
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() => expect(screen.getByTestId("invoice-editor-save")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("invoice-editor-save"));
    await waitFor(() => {
      expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledTimes(1);
      expect(router.back).toHaveBeenCalled();
      expect(alert).toHaveBeenCalledWith("Invoice saved", expect.stringContaining("refresh"));
    });
    expect(alert).not.toHaveBeenCalledWith("Couldn't save invoice", expect.anything());
  });
});

describe("InvoiceEditorScreen — fitting line items and totals", () => {
  it("uses vertical scrolling and wrapping fields instead of a fixed-width table", async () => {
    seedInvoiceWithLine();
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() => expect(screen.getByTestId("invoice-editor-line-fields-0")).toBeTruthy());

    expect(screen.getByTestId("invoice-editor-scroll").props.horizontal).toBe(false);
    expect(StyleSheet.flatten(screen.getByTestId("invoice-editor-line-fields-0").props.style))
      .toMatchObject({ flexDirection: "row", flexWrap: "wrap" });
    expect(StyleSheet.flatten(screen.getByTestId("invoice-editor-line-price-field-0").props.style))
      .toMatchObject({ flexGrow: 1, flexBasis: 132, minWidth: 132 });
    expect(screen.getByTestId("invoice-editor-line-qty-0")).toBeTruthy();
    expect(screen.getByTestId("invoice-editor-line-price-0")).toBeTruthy();
    expect(screen.getByTestId("invoice-editor-line-total-0").props.children).toBe("$99.00");
    expect(screen.getByTestId("invoice-editor-tax")).toBeTruthy();
    expect(screen.getByTestId("invoice-editor-discount")).toBeTruthy();
    expect(screen.getByTestId("invoice-editor-total")).toBeTruthy();
  });

  it("includes nested charges, tax, discount and existing credits in live totals and saves them", async () => {
    seedInvoiceWithLine();
    setMockAppState({
      invoices: [{
        id: "inv-editor-001",
        invoiceNumber: "INV-001",
        status: "open",
        labOrganizationId: "lab-1",
        tax: "8",
        discount: "3",
        displayMetadata: { credits: 5, lineItems: [{ item: "CROWN" }] },
        items: [{
          id: "line-a", description: "Crown", quantity: 1, unitPrice: "99",
          subItems: [{ id: "child-a", description: "Layered Porcelain", quantity: 1, unitPrice: "37" }],
        }],
      }],
    });
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() => expect(screen.getByTestId("invoice-editor-tax").props.value).toBe("8"));
    expect(screen.getByText("Item: CROWN")).toBeTruthy();
    expect(screen.getByTestId("invoice-editor-subtotal").props.children).toBe("$136.00");
    expect(screen.getByTestId("invoice-editor-total").props.children).toBe("$136.00");

    await fireEvent.changeText(screen.getByTestId("invoice-editor-line-qty-0"), "2");
    await fireEvent.changeText(screen.getByTestId("invoice-editor-line-price-0"), "100");
    await fireEvent.changeText(screen.getByTestId("invoice-editor-tax"), "10");
    await fireEvent.changeText(screen.getByTestId("invoice-editor-discount"), "20");
    expect(screen.getByTestId("invoice-editor-line-total-0").props.children).toBe("$237.00");
    expect(screen.getByTestId("invoice-editor-total").props.children).toBe("$222.00");

    await fireEvent.press(screen.getByTestId("invoice-editor-save"));
    await waitFor(() => expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tax: 10,
          discount: 20,
          displayMetadata: expect.objectContaining({ credits: 5 }),
          items: [expect.objectContaining({
            quantity: 2,
            unitPrice: 100,
            subItems: [expect.objectContaining({ id: "child-a", unitPrice: 37 })],
          })],
        }),
      }),
    ));
  });

  it.each(["-1", "not a number"])("refuses an invalid tax amount of %s without saving", async (amount) => {
    seedInvoiceWithLine();
    const alert = vi.spyOn(Alert, "alert");
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() => expect(screen.getByTestId("invoice-editor-tax").props.value).toBe("0"));
    await fireEvent.changeText(screen.getByTestId("invoice-editor-tax"), amount);
    await fireEvent.press(screen.getByTestId("invoice-editor-save"));
    expect(alert).toHaveBeenCalledWith(
      "Valid amount required",
      "Tax and discount must be valid, non-negative amounts.",
    );
    expect(mockUpdateInvoiceMutateAsync).not.toHaveBeenCalled();
  });
});
