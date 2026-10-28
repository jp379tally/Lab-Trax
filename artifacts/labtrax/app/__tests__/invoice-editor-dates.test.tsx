import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert } from "react-native";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { queryClient } from "@/lib/query-client";
import {
  mockUpdateInvoiceMutateAsync,
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockFetchHandler,
  setMockSearchParams,
} from "../../vitest.setup";
import InvoiceEditorScreen from "@/app/invoice-editor/[id]";

function seedInvoice(dates: {
  issuedAt?: string | null;
  dueAt?: string | null;
  createdAt?: string | null;
} = {}) {
  setMockAppState({
    invoices: [
      {
        id: "inv-date-editor",
        invoiceNumber: "INV-DATE",
        status: "open",
        labOrganizationId: "lab-1",
        createdAt: dates.createdAt ?? "2026-10-01T12:00:00.000Z",
        issuedAt: dates.issuedAt ?? "2026-10-02T05:30:00.000Z",
        dueAt: dates.dueAt ?? "2026-11-02T00:00:00.000Z",
        items: [
          {
            id: "line-date",
            description: "Crown",
            quantity: 1,
            unitPrice: "100",
            subItems: [],
          },
        ],
      },
    ],
  });
  setMockSearchParams({ id: "inv-date-editor" });
  setMockFetchHandler(() => new Response(JSON.stringify({ data: null }), { status: 200 }));
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("mobile invoice editor dates", () => {
  it("sends a changed issue date as UTC midnight and omits an unchanged due date", async () => {
    seedInvoice();
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() => {
      expect(screen.getByTestId("invoice-editor-issued-at").props.value).toBe("2026-10-02");
      expect(screen.getByTestId("invoice-editor-due-at").props.value).toBe("2026-11-02");
    });

    await fireEvent.changeText(screen.getByTestId("invoice-editor-issued-at"), "2026-10-04");
    await fireEvent.press(screen.getByTestId("invoice-editor-save"));

    await waitFor(() =>
      expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: "inv-date-editor",
          data: expect.objectContaining({
            issuedAt: "2026-10-04T00:00:00.000Z",
          }),
        }),
      ),
    );
    const savedData = (
      mockUpdateInvoiceMutateAsync.mock.calls as unknown as Array<
        [{ data: Record<string, unknown> }]
      >
    )[0]?.[0].data;
    expect(savedData).not.toHaveProperty("dueAt");
    expect(router.back).toHaveBeenCalled();
  });

  it("serializes a cleared optional due date as null", async () => {
    seedInvoice();
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() =>
      expect(screen.getByTestId("invoice-editor-due-at").props.value).toBe("2026-11-02"),
    );

    await fireEvent.changeText(screen.getByTestId("invoice-editor-due-at"), "");
    await fireEvent.press(screen.getByTestId("invoice-editor-save"));

    await waitFor(() =>
      expect(mockUpdateInvoiceMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ dueAt: null }),
        }),
      ),
    );
  });

  it("rejects an invalid date before calling the update API", async () => {
    seedInvoice();
    const alert = vi.spyOn(Alert, "alert");
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() =>
      expect(screen.getByTestId("invoice-editor-issued-at").props.value).toBe("2026-10-02"),
    );

    await fireEvent.changeText(screen.getByTestId("invoice-editor-issued-at"), "2026-02-30");
    await fireEvent.press(screen.getByTestId("invoice-editor-save"));

    expect(alert).toHaveBeenCalledWith(
      "Valid date required",
      "Enter dates in YYYY-MM-DD format using a real calendar date.",
    );
    expect(mockUpdateInvoiceMutateAsync).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });

  it("asks before discarding unsaved date changes from Back", async () => {
    seedInvoice();
    const alert = vi.spyOn(Alert, "alert");
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() =>
      expect(screen.getByTestId("invoice-editor-issued-at").props.value).toBe("2026-10-02"),
    );

    await fireEvent.changeText(screen.getByTestId("invoice-editor-issued-at"), "2026-10-05");
    await fireEvent.press(screen.getByTestId("invoice-editor-back"));

    expect(alert).toHaveBeenCalledWith(
      "Discard changes?",
      "Your invoice edits haven't been saved.",
      expect.any(Array),
    );
    expect(router.back).not.toHaveBeenCalled();
    const buttons = alert.mock.calls.at(-1)?.[2];
    buttons?.find((button) => button.text === "Discard")?.onPress?.();
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy shifted invoice dates read-only", async () => {
    seedInvoice({
      createdAt: "2025-04-03T10:00:00.000Z",
      issuedAt: "2025-04-02T05:00:00.000Z",
    });
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() =>
      expect(screen.getByTestId("invoice-editor-issued-at").props.editable).toBe(false),
    );
    expect(screen.getByText(/legacy invoice date needs review/i)).toBeTruthy();
  });
});
