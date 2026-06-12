import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
import {
  resetMockAppState,
  setMockAppState,
  setMockSearchParams,
} from "../../../vitest.setup";

import InvoicesScreen from "@/app/finance/invoices";
import InvoiceEditorScreen from "@/app/invoice-editor/[id]";

// A synthetic legacy invoice as it arrives in the list: id is `mobile:`-prefixed,
// fields sourced from the lab_cases blob rather than the relational invoices table.
const legacyMobileInvoice = {
  id: "mobile:local-abc-123",
  invoiceNumber: "M-5042",
  status: "open",
  issuedAt: "2025-01-10T00:00:00.000Z",
  dueAt: "2025-01-24T00:00:00.000Z",
  total: "420.00",
  balanceDue: "420.00",
};

// A canonical invoice (would be returned by the server when it resolves the
// mobile: id to a real invoices row created later on desktop).
const canonicalInvoiceResolvedFromLegacy = {
  id: "inv-resolved-999",
  invoiceNumber: "INV-0042",
  status: "open",
  issuedAt: "2025-01-11T00:00:00.000Z",
  dueAt: "2025-01-25T00:00:00.000Z",
  total: "420.00",
  balanceDue: "420.00",
  items: [
    {
      id: "li-99",
      description: "Zirconia Crown",
      quantity: 1,
      unitPrice: 420,
      subItems: [],
    },
  ],
  displayMetadata: { teeth: "9", shade: "A3" },
};

afterEach(() => {
  cleanup();
  setMockSearchParams({});
  resetMockAppState();
  vi.clearAllMocks();
});

// ── 1. List navigation ────────────────────────────────────────────────────────

describe("InvoicesScreen — legacy mobile invoice row", () => {
  it("renders a legacy mobile invoice row and navigates to the editor on tap", () => {
    setMockAppState({ invoices: [legacyMobileInvoice] });
    const { getByTestId } = render(<InvoicesScreen />);

    const row = getByTestId(`invoice-${legacyMobileInvoice.id}`);
    expect(row).toBeTruthy();

    fireEvent.press(row);

    expect(router.push).toHaveBeenCalledWith(
      `/invoice-editor/${legacyMobileInvoice.id}`,
    );
  });

  it("shows the invoice number in the list row", () => {
    setMockAppState({ invoices: [legacyMobileInvoice] });
    const { getByText } = render(<InvoicesScreen />);
    expect(getByText("M-5042")).toBeTruthy();
  });
});

// ── 2. Editor — resolved to canonical invoice ─────────────────────────────────

describe("InvoiceEditorScreen — legacy mobile id resolved to canonical invoice", () => {
  // The mock useInvoice looks up by id; seed the invoices array with the
  // resolved canonical invoice keyed under the mobile: id so the hook returns
  // it when the editor calls useInvoice("mobile:local-abc-123").  This mirrors
  // the server behaviour: GET /api/invoices/mobile:<id> returns the canonical
  // row that now exists for the same case.
  function renderResolvedEditor() {
    const resolvedAsEntry = {
      ...canonicalInvoiceResolvedFromLegacy,
      id: legacyMobileInvoice.id, // mock lookup key must match the search param
    };
    setMockSearchParams({ id: legacyMobileInvoice.id });
    setMockAppState({ invoices: [resolvedAsEntry] });
    return render(<InvoiceEditorScreen />);
  }

  it("opens the full editor form (not the error state) when the legacy id resolves", () => {
    const { getByTestId, queryByTestId } = renderResolvedEditor();

    // The form body is the ScrollView path; the error container must be absent.
    expect(queryByTestId("invoice-editor-error")).toBeNull();
    expect(queryByTestId("invoice-editor-loading")).toBeNull();

    // Core editable fields must be present.
    expect(getByTestId("invoice-editor-number")).toBeTruthy();
    expect(getByTestId("invoice-editor-save")).toBeTruthy();
  });

  it("hydrates the invoice number field from the resolved canonical data", () => {
    const { getByTestId } = renderResolvedEditor();
    const field = getByTestId("invoice-editor-number");
    // RNTL exposes the value prop on TextInput as `value` in the instance.
    expect(field.props.value).toBe("INV-0042");
  });
});

// ── 3. Editor — loading state for a legacy mobile id ─────────────────────────

describe("InvoiceEditorScreen — loading state for a mobile: id", () => {
  it("shows the 'Setting up your invoice…' hint while loading a mobile: id", () => {
    setMockSearchParams({ id: legacyMobileInvoice.id });
    setMockAppState({ invoices: [], invoiceIsLoading: true });
    const { getByTestId, getByText } = render(<InvoiceEditorScreen />);

    expect(getByTestId("invoice-editor-loading")).toBeTruthy();
    expect(getByText("Setting up your invoice…")).toBeTruthy();
  });

  it("does not show the hint while loading a non-mobile invoice", () => {
    setMockSearchParams({ id: "inv-regular-123" });
    setMockAppState({ invoices: [], invoiceIsLoading: true });
    const { getByTestId, queryByText } = render(<InvoiceEditorScreen />);

    expect(getByTestId("invoice-editor-loading")).toBeTruthy();
    expect(queryByText("Setting up your invoice…")).toBeNull();
  });
});

// ── 4. Editor — unresolved legacy id (no canonical invoice exists yet) ────────

describe("InvoiceEditorScreen — legacy mobile id with no canonical invoice", () => {
  function renderUnresolvedEditor() {
    // Seed invoices without any entry matching the mobile: id so useInvoice
    // returns null — this is what happens when the server can't resolve the id.
    setMockSearchParams({ id: legacyMobileInvoice.id });
    setMockAppState({ invoices: [] });
    return render(<InvoiceEditorScreen />);
  }

  it("renders the error state (not the editor form) for an unresolved legacy id", () => {
    const { getByTestId, queryByTestId } = renderUnresolvedEditor();

    expect(getByTestId("invoice-editor-error")).toBeTruthy();
    expect(queryByTestId("invoice-editor-number")).toBeNull();
  });

  it("displays the friendly older-version message for a mobile: id", () => {
    const { getByText } = renderUnresolvedEditor();

    // The tailored message from [id].tsx when isLegacyMobileInvoice is true.
    expect(
      getByText(
        /Open the case to try generating an editable invoice/i,
      ),
    ).toBeTruthy();
  });

  it("does not show the short generic 'couldn't be loaded' copy for a legacy id", () => {
    const { queryByText } = renderUnresolvedEditor();
    // The legacy path shows a longer tailored message; the short generic form
    // ("This invoice couldn't be loaded." with nothing after) must not appear.
    expect(queryByText(/^This invoice couldn't be loaded\.$/)).toBeNull();
  });
});
