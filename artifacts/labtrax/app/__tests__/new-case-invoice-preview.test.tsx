/**
 * Unit tests for the draft-invoice preview on new-case.tsx.
 *
 * Invariants protected:
 *  - The read-only "Invoice preview" section renders line items, per-line
 *    amounts, "not priced" badges, and the total returned by the
 *    /invoices/preview-draft endpoint (mocked via usePreviewDraftInvoice).
 *  - The preview is hidden until at least one restoration has both a tooth
 *    number and a type (the same rows the case would be created with).
 *  - A failed preview shows a non-blocking fallback message.
 */

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react-native";
import { resetMockAppState, setMockAppState } from "../../vitest.setup";
import { mockCreateCaseMutateAsync } from "../../vitest.setup";

import NewCaseScreen from "@/app/new-case";

function seedEditableLab() {
  setMockAppState({
    meMemberships: [
      {
        id: "m1",
        role: "billing",
        status: "active",
        organizationId: "lab-1",
        organization: { id: "lab-1", name: "Acme Dental Lab", type: "lab" },
      },
    ],
  });
}

function seedAdminLab() {
  setMockAppState({
    meMemberships: [
      {
        id: "m-admin",
        role: "owner",
        status: "active",
        organizationId: "lab-1",
        organization: { id: "lab-1", name: "Acme Dental Lab", type: "lab" },
      },
    ],
    cases: [
      {
        id: "case-old",
        doctorName: "Dr. Tier",
        providerOrganizationId: "practice-1",
        providerOrganizationName: "Tier Practice",
      },
    ],
  });
}

async function confirmPreparedUnit(screen: Awaited<ReturnType<typeof render>>) {
  await fireEvent.press(screen.getByTestId("resto-role-0-crown"));
  await fireEvent.changeText(screen.getByTestId("resto-material-0"), "Zirconia");
  await fireEvent.changeText(screen.getByTestId("resto-shade-0"), "A2");
}

async function enterPricedRestoration(
  screen: Awaited<ReturnType<typeof render>>,
): Promise<void> {
  await fireEvent.changeText(screen.getByTestId("new-case-number"), "C-3909");
  await fireEvent.changeText(screen.getByTestId("new-case-patient-first"), "Jane");
  await fireEvent.changeText(screen.getByTestId("new-case-patient-last"), "Doe");
  await fireEvent(screen.getByTestId("new-case-doctor"), "focus");
  await waitFor(() => expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy());
  await fireEvent.press(screen.getByTestId("past-doctor-result-0"));
  await fireEvent.changeText(screen.getByTestId("resto-tooth-0"), "14");
  await fireEvent.changeText(screen.getByTestId("resto-category-0"), "Restorative");
  await fireEvent.changeText(screen.getByTestId("resto-type-0"), "Crown & Bridge");
  await confirmPreparedUnit(screen);
  await waitFor(
    () => expect(screen.getByTestId("invoice-preview-add-line")).toBeTruthy(),
    { timeout: 2000 },
  );
}

function seedCustomRemovableCatalog() {
  setMockAppState({
    catalogTree: {
      labOrganizationId: "lab-1",
      caseTypes: [
        {
          key: "restorative",
          label: "Restorative",
          subtypes: [],
        },
        {
          key: "removable",
          label: "Removable",
          subtypes: [
            {
              id: "custom-subtype-1",
              key: "custom:custom-subtype-1",
              label: "Digital Valplast Appliance",
              isCustom: true,
              isActive: true,
              sortOrder: 0,
              priceKey: null,
              materials: [],
            },
          ],
        },
        {
          key: "ortho",
          label: "Ortho / Appliances",
          subtypes: [],
        },
      ],
    },
  });
}

afterEach(() => {
  cleanup();
  resetMockAppState();
  vi.clearAllMocks();
});

describe("NewCaseScreen — draft-invoice preview", () => {
  it("includes Date received in the create payload", async () => {
    seedAdminLab();
    const screen = await render(<NewCaseScreen />);

    await fireEvent.changeText(screen.getByTestId("new-case-number"), "C-3910");
    await fireEvent.changeText(screen.getByTestId("new-case-patient-first"), "Jane");
    await fireEvent.changeText(screen.getByTestId("new-case-patient-last"), "Doe");
    await fireEvent(screen.getByTestId("new-case-doctor"), "focus");
    await waitFor(() =>
      expect(screen.getByTestId("past-doctor-result-0")).toBeTruthy(),
    );
    await fireEvent.press(screen.getByTestId("past-doctor-result-0"));
    await fireEvent.press(screen.getByTestId("new-case-save"));

    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    expect(mockCreateCaseMutateAsync).toHaveBeenCalledWith({
      data: expect.objectContaining({
        receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    });
  });

  it("renders line items, a not-priced badge, and the total after a restoration is entered", async () => {
    seedEditableLab();
    setMockAppState({
      previewDraftResult: {
        lineItems: [
          {
            description: "Zirconia Crown",
            toothLabel: "#14",
            quantity: 1,
            unitPrice: "120.00",
            lineTotal: "120.00",
            priced: true,
          },
          {
            description: "Custom Abutment",
            toothLabel: "#15",
            quantity: 1,
            unitPrice: "0.00",
            lineTotal: "0.00",
            priced: false,
          },
        ],
        subtotal: "120.00",
        total: "120.00",
      },
    });

    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Fill the first restoration row so the preview has something to price.
    // The cascade requires: category → type → (optional) material.
    await fireEvent.changeText(screen.getByTestId("resto-tooth-0"), "14");
    await fireEvent.changeText(screen.getByTestId("resto-category-0"), "Restorative");
    await fireEvent.changeText(screen.getByTestId("resto-type-0"), "Crown & Bridge");
    await confirmPreparedUnit(screen);

    await waitFor(
      () => {
        expect(screen.getByTestId("invoice-preview")).toBeTruthy();
        expect(screen.getByTestId("invoice-preview-line-0")).toBeTruthy();
      },
      { timeout: 2000 },
    );

    expect(screen.getByText(/Zirconia Crown/)).toBeTruthy();
    expect(screen.getByTestId("invoice-preview-notpriced-1")).toBeTruthy();
    expect(screen.getByTestId("invoice-preview-total").props.children).toEqual([
      "$",
      "120.00",
    ]);
  });

  it("does not render the preview until a restoration has a tooth and a type", async () => {
    seedEditableLab();
    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Only a tooth number, no type → row is skipped, no preview.
    await fireEvent.changeText(screen.getByTestId("resto-tooth-0"), "14");

    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    expect(screen.queryByTestId("invoice-preview")).toBeNull();
  });

  it("includes a custom removable catalog subtype without a tooth number", async () => {
    seedEditableLab();
    seedCustomRemovableCatalog();
    setMockAppState({
      previewDraftResult: {
        lineItems: [
          {
            description: "Digital Valplast Appliance",
            toothLabel: "",
            quantity: 1,
            unitPrice: "0.00",
            lineTotal: "0.00",
            priced: false,
          },
        ],
        subtotal: "0.00",
        total: "0.00",
      },
    });

    const screen = await render(<NewCaseScreen />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    await fireEvent.changeText(screen.getByTestId("resto-category-0"), "Removable");
    await fireEvent.changeText(
      screen.getByTestId("resto-type-0"),
      "Digital Valplast Appliance",
    );

    await waitFor(() => {
      expect(screen.getByTestId("invoice-preview")).toBeTruthy();
      expect(screen.getByTestId("invoice-preview-line-0")).toBeTruthy();
    });
  });

  it("shows a non-blocking fallback when the preview request fails", async () => {
    seedEditableLab();
    setMockAppState({ previewDraftResult: "error" });

    const screen = await render(<NewCaseScreen />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    await fireEvent.changeText(screen.getByTestId("resto-tooth-0"), "14");
    await fireEvent.changeText(screen.getByTestId("resto-category-0"), "Restorative");
    await fireEvent.changeText(screen.getByTestId("resto-type-0"), "Crown & Bridge");
    await confirmPreparedUnit(screen);

    await waitFor(
      () => {
        expect(
          screen.getByText(/Couldn't load the invoice preview/i),
        ).toBeTruthy();
      },
      { timeout: 2000 },
    );
  });

  it("lets an owner select a context-priced item and submits the exact edited lines", async () => {
    seedAdminLab();
    setMockAppState({
      preCreateInvoiceItems: [
        {
          id: "item-pfm",
          priceKey: "pfm_crown",
          name: "PFM Crown",
          unitPrice: 80,
          source: "override",
          sourceId: "override-1",
          sourceName: "Dr. Tier",
        },
      ],
      previewDraftResult: {
        lineItems: [
          {
            description: "Zirconia Crown",
            toothLabel: "#14",
            quantity: 1,
            unitPrice: "120.00",
            lineTotal: "120.00",
            priced: true,
          },
        ],
        subtotal: "120.00",
        total: "120.00",
      },
    });
    const screen = await render(<NewCaseScreen />);
    await enterPricedRestoration(screen);

    await fireEvent.press(screen.getByTestId("invoice-preview-line-picker-0-Zirconia Crown"));
    await fireEvent.press(screen.getByTestId("billable-item-picker-item-item-pfm"));
    await fireEvent.changeText(
      screen.getByTestId("invoice-preview-line-qty-0-Zirconia Crown"),
      "2",
    );
    await fireEvent.changeText(
      screen.getByTestId("invoice-preview-line-price-0-Zirconia Crown"),
      "75.50",
    );
    await fireEvent.press(screen.getByTestId("new-case-save"));

    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    expect(mockCreateCaseMutateAsync).toHaveBeenCalledWith({
      data: expect.objectContaining({
        labOrganizationId: "lab-1",
        providerOrganizationId: "practice-1",
        doctorName: "Dr. Tier",
        invoiceOverrideLines: [
          {
            description: "PFM Crown",
            quantity: 2,
            unitPrice: 75.5,
            catalogItemKey: "pfm_crown",
          },
        ],
      }),
    });
  });

  it("supports a custom line and shows an explicit empty catalog state", async () => {
    seedAdminLab();
    setMockAppState({
      preCreateInvoiceItems: [],
      previewDraftResult: {
        lineItems: [
          {
            description: "Zirconia Crown",
            toothLabel: "#14",
            quantity: 1,
            unitPrice: "120.00",
            lineTotal: "120.00",
            priced: true,
          },
        ],
        subtotal: "120.00",
        total: "120.00",
      },
    });
    const screen = await render(<NewCaseScreen />);
    await enterPricedRestoration(screen);

    await fireEvent.press(screen.getByTestId("invoice-preview-line-picker-0-Zirconia Crown"));
    expect(screen.getByTestId("billable-item-picker-empty")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("billable-item-picker-custom"));
    await fireEvent.changeText(
      screen.getByTestId(
        "invoice-preview-line-custom-description-0-Zirconia Crown",
      ),
      "Custom characterization",
    );
    await fireEvent.changeText(
      screen.getByTestId("invoice-preview-line-price-0-Zirconia Crown"),
      "25",
    );
    await fireEvent.press(screen.getByTestId("new-case-save"));

    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    const payload = mockCreateCaseMutateAsync.mock.calls.at(-1)?.[0] as {
      data?: { invoiceOverrideLines?: unknown[] };
    };
    expect(payload.data?.invoiceOverrideLines).toEqual([
      {
        description: "Custom characterization",
        quantity: 1,
        unitPrice: 25,
      },
    ]);
  });

  it("submits an intentional empty override after an owner removes every line", async () => {
    seedAdminLab();
    setMockAppState({
      preCreateInvoiceItems: [],
      previewDraftResult: {
        lineItems: [
          {
            description: "Zirconia Crown",
            toothLabel: "#14",
            quantity: 1,
            unitPrice: "120.00",
            lineTotal: "120.00",
            priced: true,
          },
        ],
        subtotal: "120.00",
        total: "120.00",
      },
    });
    const screen = await render(<NewCaseScreen />);
    await enterPricedRestoration(screen);
    await fireEvent.press(
      screen.getByTestId("invoice-preview-line-remove-0-Zirconia Crown"),
    );
    await fireEvent.press(screen.getByTestId("new-case-save"));

    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    expect(mockCreateCaseMutateAsync).toHaveBeenCalledWith({
      data: expect.objectContaining({ invoiceOverrideLines: [] }),
    });
  });

  it("keeps the invoice preview read-only for non-admin case creators", async () => {
    seedEditableLab();
    setMockAppState({
      previewDraftResult: {
        lineItems: [
          {
            description: "Zirconia Crown",
            toothLabel: "#14",
            quantity: 1,
            unitPrice: "120.00",
            lineTotal: "120.00",
            priced: true,
          },
        ],
        subtotal: "120.00",
        total: "120.00",
      },
    });
    const screen = await render(<NewCaseScreen />);
    await fireEvent.changeText(screen.getByTestId("resto-tooth-0"), "14");
    await fireEvent.changeText(screen.getByTestId("resto-category-0"), "Restorative");
    await fireEvent.changeText(screen.getByTestId("resto-type-0"), "Crown & Bridge");
    await confirmPreparedUnit(screen);
    await waitFor(() => expect(screen.getByTestId("invoice-preview")).toBeTruthy());
    expect(screen.queryByTestId("invoice-preview-add-line")).toBeNull();
  });
});
