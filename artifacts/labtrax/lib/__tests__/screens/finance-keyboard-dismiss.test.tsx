import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Keyboard } from "react-native";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import {
  resetMockAppState,
  setMockAppState,
  setMockSearchParams,
  showMockKeyboard,
  isMockKeyboardVisible,
} from "../../../vitest.setup";

import { resilientFetch } from "@/lib/query-client";
import InvoicesScreen from "@/app/finance/invoices";
import InvoiceEditorScreen from "@/app/invoice-editor/[id]";

// Regression cover for the keyboard rollout across the finance, invoice and
// case screens. Each screen here stands in for one shape of the change: a
// search list, a form, and a read-mostly detail screen with a composer. The
// invariants are the same everywhere — tapping dead space closes the keyboard
// without losing what was typed, and every control still fires on the first
// tap while the keyboard is up.

const yesterday = new Date(Date.now() - 86_400_000).toISOString();

const seededInvoices = [
  {
    id: "open",
    invoiceNumber: "INV-OPEN",
    status: "open",
    total: 100,
    balanceDue: 100,
    issuedAt: new Date().toISOString(),
    dueAt: yesterday,
    providerOrganizationId: "p1",
    providerOrganization: { name: "Acme" },
    displayMetadataJson: { patientName: "Amy", billTo: "Dr A" },
  },
  {
    id: "paid",
    invoiceNumber: "INV-PAID",
    status: "paid",
    total: 300,
    balanceDue: 0,
    issuedAt: yesterday,
    dueAt: yesterday,
    providerOrganizationId: "p1",
    providerOrganization: { name: "Acme" },
    displayMetadataJson: { patientName: "Ben", billTo: "Dr A" },
  },
];

// The dismissal layer only arms while a keyboard is actually on screen, so
// every case opens one first.
async function openKeyboard(): Promise<void> {
  await act(() => {
    showMockKeyboard();
  });
  expect(isMockKeyboardVisible()).toBe(true);
}

afterEach(() => {
  cleanup();
  setMockSearchParams({});
  resetMockAppState();
  vi.clearAllMocks();
});

describe("InvoicesScreen — keyboard dismissal", () => {
  it("closes the keyboard when the screen chrome is tapped, keeping the search and its results", async () => {
    setMockAppState({ invoices: seededInvoices });
    const screen = await render(<InvoicesScreen />);

    await fireEvent.changeText(screen.getByTestId("invoice-search"), "Amy");
    await waitFor(() => {
      expect(screen.queryAllByTestId(/^invoice-(open|paid)$/)).toHaveLength(1);
    });
    await openKeyboard();

    await fireEvent.press(screen.getByTestId("list-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).toHaveBeenCalled();
    expect(isMockKeyboardVisible()).toBe(false);
    // The typed term and the list it filters both survive the dismissal.
    expect(screen.getByTestId("invoice-search").props.value).toBe("Amy");
    expect(screen.queryAllByTestId(/^invoice-(open|paid)$/)).toHaveLength(1);
  });

  it("closes the keyboard from the Search key without dropping the search", async () => {
    setMockAppState({ invoices: seededInvoices });
    const screen = await render(<InvoicesScreen />);

    await fireEvent.changeText(screen.getByTestId("invoice-search"), "Amy");
    await waitFor(() => {
      expect(screen.queryAllByTestId(/^invoice-(open|paid)$/)).toHaveLength(1);
    });
    await openKeyboard();

    await fireEvent(screen.getByTestId("invoice-search"), "submitEditing");

    expect(isMockKeyboardVisible()).toBe(false);
    expect(screen.getByTestId("invoice-search").props.value).toBe("Amy");
    expect(screen.queryAllByTestId(/^invoice-(open|paid)$/)).toHaveLength(1);
  });

  it("still switches the view and opens an invoice on the first tap while the keyboard is up", async () => {
    setMockAppState({ invoices: seededInvoices });
    const screen = await render(<InvoicesScreen />);
    await openKeyboard();

    await fireEvent.press(screen.getByTestId("view-open"));
    expect(screen.queryAllByTestId(/^invoice-(open|paid)$/).map((n) => n.props.testID)).toEqual([
      "invoice-open",
    ]);

    await fireEvent.press(screen.getByTestId("invoice-open"));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith("/invoice-editor/open");
  });
});

describe("InvoiceEditorScreen — keyboard dismissal", () => {
  const invoice = {
    id: "inv-1",
    invoiceNumber: "INV-0007",
    status: "open",
    displayMetadata: { teeth: "8-10", shade: "A2" },
    items: [
      {
        id: "li-1",
        toothNumber: 8,
        description: "Zirconia Crown",
        quantity: 1,
        unitPrice: 450,
      },
    ],
  };

  async function renderEditor() {
    setMockSearchParams({ id: invoice.id });
    setMockAppState({ invoices: [invoice] });
    const screen = await render(<InvoiceEditorScreen />);
    await waitFor(() =>
      expect(screen.getByTestId("invoice-editor-number")).toBeTruthy(),
    );
    return screen;
  }

  it("closes the keyboard when the form background is tapped, keeping the edited fields", async () => {
    const screen = await renderEditor();

    await fireEvent.changeText(screen.getByTestId("invoice-editor-shade"), "B1");
    await fireEvent.changeText(screen.getByTestId("invoice-editor-notes"), "Rush this\ncase");
    await openKeyboard();

    await fireEvent.press(screen.getByTestId("invoice-editor-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).toHaveBeenCalled();
    expect(isMockKeyboardVisible()).toBe(false);
    expect(screen.getByTestId("invoice-editor-shade").props.value).toBe("B1");
    // The multi-line notes field keeps its newline: nothing submitted it.
    expect(screen.getByTestId("invoice-editor-notes").props.value).toBe("Rush this\ncase");
    expect(screen.getByTestId("invoice-editor-notes").props.multiline).toBe(true);
  });

  it("still adds a line on the first tap while the keyboard is up", async () => {
    const screen = await renderEditor();
    await openKeyboard();

    await fireEvent.press(screen.getByTestId("invoice-editor-add-line"));

    expect(screen.getByTestId("invoice-editor-line-1")).toBeTruthy();
  });
});

describe("ProviderCaseDetailScreen — keyboard dismissal", () => {
  async function renderProviderCase() {
    setMockSearchParams({ id: "case-abc" });
    setMockAppState({
      providerCase: {
        id: "case-abc",
        caseNumber: "1001",
        patientFirstName: "Jane",
        patientLastName: "Doe",
        caseType: "Crown/Bridge",
        invoiceLines: [],
        timeline: [],
      },
    });
    const { default: Screen } = await import("@/app/case/provider/[id]");
    const screen = await render(<Screen />);
    await waitFor(() => {
      expect(screen.getByTestId("provider-note-input")).toBeTruthy();
    });
    return screen;
  }

  it("closes the keyboard when the screen chrome is tapped, keeping the drafted note", async () => {
    const screen = await renderProviderCase();

    await fireEvent.changeText(screen.getByTestId("provider-note-input"), "Please\nremake");
    await openKeyboard();

    await fireEvent.press(screen.getByTestId("provider-case-keyboard-dismiss"));

    expect(vi.mocked(Keyboard.dismiss)).toHaveBeenCalled();
    expect(isMockKeyboardVisible()).toBe(false);
    // A multi-line composer keeps its newline and its draft.
    expect(screen.getByTestId("provider-note-input").props.value).toBe("Please\nremake");
    expect(screen.getByTestId("provider-note-input").props.multiline).toBe(true);
  });

  it("still sends the note on the first tap while the keyboard is up", async () => {
    const screen = await renderProviderCase();

    await fireEvent.changeText(screen.getByTestId("provider-note-input"), "Ready for pickup");
    await openKeyboard();

    await fireEvent.press(screen.getByTestId("provider-note-send"));

    await waitFor(() => {
      expect(vi.mocked(resilientFetch)).toHaveBeenCalledWith(
        expect.stringContaining("/api/cases/provider/case-abc/notes"),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});
