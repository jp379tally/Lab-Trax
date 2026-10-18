import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native/pure";
import { Alert, Keyboard } from "react-native";
import {
  mockCreateCaseMutateAsync,
  mockPreCreateItemParams,
  resetMockAppState,
  resetMockFetchHandler,
  setMockAppState,
  setMockFetchHandler,
} from "../../vitest.setup";
import { clearAiReaderSession, setAiReaderSession, type AiReaderUserOverrides } from "@/lib/ai-reader-store";
import AiReaderExtractedScreen from "@/app/ai-reader/extracted";

const lineKey = "0-Zirconia Crown";
const crown = { id: "pfm", priceKey: "pfm_crown", name: "PFM Crown", unitPrice: 80 };

function seed(
  role = "owner",
  emptyPreview = false,
  failedPreview = false,
  options: { toothAssignments?: unknown; userOverrides?: AiReaderUserOverrides } = {},
) {
  const previewState: { failed: boolean; calls: number; restorations: unknown[] | null } = {
    failed: failedPreview,
    calls: 0,
    restorations: null,
  };
  setMockAppState({
    meMemberships: [{
      id: "membership", role, status: "active", organizationId: "lab-1",
      organization: { id: "lab-1", name: "Lab One", type: "lab" },
    }],
    labProviders: [
      { id: "practice-1", name: "First Practice" },
      { id: "practice-2", name: "Second Practice" },
    ],
  });
  setAiReaderSession({
    pages: [],
    extracted: {
      doctorName: "Dr. Synthetic063", patientName: "Jane Doe", patientInitials: null,
      caseType: "Crown & Bridge", toothIndices: "14", shade: "A2", material: "Zirconia",
      toothAssignments: options.toothAssignments ?? [{ toothNumber: "14", role: "prepared_crown", roleEvidence: "Prepared crown #14", material: "Zirconia", shade: "A2", requiresReview: false }],
      dueDate: null, isRush: null, notes: null, practiceName: "First Practice",
      practiceAddress: null, practicePhone: null, confidence: null, step: null,
      gingivialShade: null,
    },
    userOverrides: options.userOverrides ?? {},
  });
  setMockFetchHandler((url, init) => {
    if (url.includes("/api/invoices/preview-draft")) {
      previewState.calls += 1;
      previewState.restorations = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ).restorations ?? null;
      if (previewState.failed) return new Response(null, { status: 503 });
      return new Response(JSON.stringify({ data: {
        lineItems: emptyPreview ? [] : [{
          description: "Zirconia Crown", toothLabel: "#14", quantity: 1,
          unitPrice: "120.00", lineTotal: "120.00", priced: true, restorationIndices: [0],
        }],
        subtotal: "120.00", total: "120.00",
      } }), { status: 200 });
    }
    if (url.includes("/api/rx-practice-aliases") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ data: {
        found: true, providerOrganizationId: url.includes("lab-2") ? "practice-2" : "practice-1",
      } }), { status: 200 });
    }
    if (url.includes("/api/cases/patient-similarity")) {
      return new Response(JSON.stringify({ data: { matches: [] } }), { status: 200 });
    }
    if (url.includes("/api/doctors/resolve-name")) {
      return new Response(JSON.stringify({ data: {
        exactMatch: "Dr. Synthetic063", similarMatches: [], canAddNew: true,
      } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  });
  return previewState;
}

async function ready(admin = true) {
  const screen = await render(<AiReaderExtractedScreen />);
  await waitFor(() => expect(admin
    ? screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`)
    : screen.getAllByText("$120.00")[0]).toBeTruthy(), { timeout: 2500 });
  await waitFor(() => expect(mockPreCreateItemParams.calls.some((p) =>
    p.providerOrganizationId === "practice-1" && p.doctorName === "Dr. Synthetic063")).toBe(true));
  return screen;
}

afterEach(async () => {
  await cleanup();
  clearAiReaderSession();
  resetMockAppState();
  resetMockFetchHandler();
  vi.clearAllMocks();
});

describe("AI Reader invoice item picker", () => {
  it("previews and creates from the extracted prescription with no chart assignments", async () => {
    const previewState = seed("owner", false, false, { toothAssignments: [] });
    const screen = await ready();
    expect(previewState.restorations).toEqual([
      expect.objectContaining({
        toothNumber: "14",
        restorationType: "Crown & Bridge",
        material: "Zirconia",
        shade: "A2",
      }),
    ]);

    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-NO-CHART");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1));
    const payload = (mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: { restorations: Array<Record<string, unknown>> };
    }).data;
    expect(payload.restorations).toEqual([
      expect.objectContaining({
        toothNumber: "14",
        restorationType: "Crown & Bridge",
        material: "Zirconia",
        shade: "A2",
      }),
    ]);
  });

  it("keeps an empty preview visible when the extraction has no billable details", async () => {
    const previewState = seed("owner", true, false, {
      toothAssignments: [],
      userOverrides: { toothIndices: "", caseType: "", material: "", shade: "" },
    });
    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() => expect(
      screen.getByText("No billable line items were found in the prescription."),
    ).toBeTruthy(), { timeout: 5000 });
    expect(previewState.restorations).toEqual([]);
  });

  it("uses an explicit chart correction in preview and case data without requiring connector completion", async () => {
    const previewState = seed("owner", false, false, {
      userOverrides: {
        assignmentRoles: { "14": "Pontic" },
        assignmentValues: { "14": { material: "Zirconia", shade: "A2" } },
        assignmentOverridesManual: true,
      },
    });
    const screen = await ready();
    expect(previewState.restorations).toEqual([
      expect.objectContaining({ toothNumber: "14", restorationType: "Pontic", material: "Zirconia" }),
    ]);
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-CHART-CORRECTION");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1));
    const payload = (mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: { restorations: Array<Record<string, unknown>>; bridgeConnectors?: string };
    }).data;
    expect(payload.restorations[0]).toEqual(expect.objectContaining({
      toothNumber: "14",
      restorationType: "Pontic",
      material: "Zirconia",
    }));
    expect(payload).not.toHaveProperty("bridgeConnectors");
  });

  it("still requires the arch for appliance cases when chart assignments are absent", async () => {
    seed("owner", false, false, {
      toothAssignments: [],
      userOverrides: { caseType: "Night Guard", material: "Acrylic", arch: null },
    });
    const screen = await ready();
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-ARCH-REQUIRED");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    expect(Alert.alert).toHaveBeenCalledWith(
      "Arch required",
      "Select Upper, Lower, or Upper + Lower before creating this case.",
    );
    expect(mockCreateCaseMutateAsync).not.toHaveBeenCalled();
  });

  it("searches for a context-priced item, updates the total, and submits catalog identity and edited values", async () => {
    seed();
    setMockAppState({ preCreateInvoiceItems: [crown] });
    const screen = await ready();
    expect(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`).props.accessibilityLabel).toContain("#14 Zirconia Crown");

    await fireEvent.press(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`));
    expect(Keyboard.dismiss).toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId("billable-item-picker-search"), "pfm");
    await fireEvent.press(screen.getByTestId("billable-item-picker-item-billable:pfm"));
    expect(screen.getByTestId(`ai-reader-invoice-line-price-${lineKey}`).props.value).toBe("80.00");
    await fireEvent.changeText(screen.getByTestId(`ai-reader-invoice-line-qty-${lineKey}`), "2");
    expect(screen.getAllByText("$160.00").length).toBeGreaterThan(0);
    await fireEvent.changeText(screen.getByTestId(`ai-reader-invoice-line-price-${lineKey}`), "75.50");
    expect(screen.getAllByText("$151.00").length).toBeGreaterThan(0);

    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-1");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    expect((mockCreateCaseMutateAsync.mock.calls[0][0] as { data: { invoiceOverrideLines: unknown } }).data.invoiceOverrideLines).toEqual([{
      description: "PFM Crown", quantity: 2, unitPrice: 75.5, catalogItemKey: "pfm_crown",
    }]);
  });

  it("offers a catalog-only context-priced entry and submits its pricing key", async () => {
    seed();
    setMockAppState({
      preCreateInvoiceItems: [],
      preCreateCatalogItems: [
        { key: "emax_crown", label: "E.max Crown", unitPrice: 135 },
      ],
    });
    const screen = await ready();
    await fireEvent.press(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`));
    await fireEvent.changeText(screen.getByTestId("billable-item-picker-search"), "e.max");
    expect(screen.getByTestId("billable-item-picker-item-catalog:emax_crown")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("billable-item-picker-item-catalog:emax_crown"));
    expect(screen.getByTestId(`ai-reader-invoice-line-price-${lineKey}`).props.value).toBe("135.00");
    expect(screen.getAllByText("$135.00").length).toBeGreaterThan(0);
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-CATALOG");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    expect((mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: { invoiceOverrideLines: unknown };
    }).data.invoiceOverrideLines).toEqual([
      { description: "E.max Crown", quantity: 1, unitPrice: 135, catalogItemKey: "emax_crown" },
    ]);
  });

  it("deduplicates catalog and billable labels case-insensitively, keeping the catalog price", async () => {
    seed();
    setMockAppState({
      preCreateInvoiceItems: [{ id: "duplicate", priceKey: "other_key", name: "  e.MAX CROWN  ", unitPrice: 999 }],
      preCreateCatalogItems: [{ key: "emax_crown", label: "E.max Crown", unitPrice: 135 }],
    });
    const screen = await ready();
    await fireEvent.press(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`));
    await fireEvent.changeText(screen.getByTestId("billable-item-picker-search"), "e.max");
    expect(screen.getByTestId("billable-item-picker-item-catalog:emax_crown")).toBeTruthy();
    expect(screen.queryByTestId("billable-item-picker-item-billable:duplicate")).toBeNull();
  });

  it("allows a manual correction with an empty catalog and a new line during a failed catalog request", async () => {
    seed();
    setMockAppState({ preCreateInvoiceItems: [] });
    const screen = await ready();
    await fireEvent.press(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`));
    expect(screen.getByTestId("billable-item-picker-empty")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("billable-item-picker-custom"));
    await fireEvent.changeText(screen.getByTestId(`ai-reader-invoice-line-custom-description-${lineKey}`), "Custom characterization");
    setMockAppState({ preCreateInvoiceItemsIsError: true });
    await fireEvent.press(screen.getByTestId("ai-reader-invoice-add-line"));
    const addedPicker = screen.getAllByTestId(/^ai-reader-invoice-line-picker-custom-/)[0];
    await fireEvent.press(addedPicker);
    expect(screen.getByTestId("billable-item-picker-error")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("billable-item-picker-custom"));
    const addedDescription = screen.getAllByTestId(/^ai-reader-invoice-line-custom-description-custom-/)[0];
    await fireEvent.changeText(addedDescription, "Manual fee");
    const addedPrice = screen.getAllByTestId(/^ai-reader-invoice-line-price-custom-/)[0];
    await fireEvent.changeText(addedPrice, "25");
    expect(screen.getAllByText("$145.00").length).toBeGreaterThan(0);
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-2");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    expect((mockCreateCaseMutateAsync.mock.calls[0][0] as { data: { invoiceOverrideLines: unknown } }).data.invoiceOverrideLines).toEqual([
      { description: "Custom characterization", quantity: 1, unitPrice: 120 },
      { description: "Manual fee", quantity: 1, unitPrice: 25 },
    ]);
  });

  it("keeps Custom / manual available while the item list is loading", async () => {
    seed();
    setMockAppState({ preCreateInvoiceItemsIsLoading: true });
    const screen = await ready();
    await fireEvent.press(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`));
    expect(screen.getByTestId("billable-item-picker-loading")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("billable-item-picker-custom"));
    expect(screen.getByTestId(`ai-reader-invoice-line-custom-description-${lineKey}`)).toBeTruthy();
  });

  it("lets an owner choose a catalog item for a newly added line", async () => {
    seed();
    setMockAppState({ preCreateInvoiceItems: [crown] });
    const screen = await ready();
    await fireEvent.press(screen.getByTestId("ai-reader-invoice-add-line"));
    await fireEvent.press(screen.getAllByTestId(/^ai-reader-invoice-line-picker-custom-/)[0]);
    await fireEvent.press(screen.getByTestId("billable-item-picker-item-billable:pfm"));
    expect(screen.getAllByTestId(/^ai-reader-invoice-line-price-custom-/)[0].props.value).toBe("80.00");
    expect(screen.getAllByText("$200.00").length).toBeGreaterThan(0);
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-3");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    expect((mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: { invoiceOverrideLines: unknown };
    }).data.invoiceOverrideLines).toEqual([
      { description: "#14 Zirconia Crown", quantity: 1, unitPrice: 120 },
      { description: "PFM Crown", quantity: 1, unitPrice: 80, catalogItemKey: "pfm_crown" },
    ]);
  });

  it("allows adding a manual invoice line when extraction produced no billable preview lines", async () => {
    seed("owner", true);
    setMockAppState({ preCreateInvoiceItems: [] });
    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() => expect(screen.getByTestId("ai-reader-invoice-add-line")).toBeTruthy(), { timeout: 2500 });
    await fireEvent.press(screen.getByTestId("ai-reader-invoice-add-line"));
    await fireEvent.press(screen.getAllByTestId(/^ai-reader-invoice-line-picker-custom-/)[0]);
    await fireEvent.press(screen.getByTestId("billable-item-picker-custom"));
    await fireEvent.changeText(screen.getAllByTestId(/^ai-reader-invoice-line-custom-description-custom-/)[0], "Hand-finished glaze");
    await fireEvent.changeText(screen.getAllByTestId(/^ai-reader-invoice-line-price-custom-/)[0], "35");
    expect(screen.getAllByText("$35.00").length).toBeGreaterThan(0);
  });

  it.each(["owner", "admin"])("lets a %s add and submit reviewed invoice lines when the preview request fails", async (role) => {
    seed(role, false, true);
    setMockAppState({ preCreateInvoiceItems: [] });
    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() => expect(screen.getByText(/Couldn't load the invoice preview/)).toBeTruthy(), { timeout: 2500 });
    await waitFor(() => expect(screen.getByTestId("ai-reader-invoice-add-line")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("ai-reader-invoice-add-line"));
    await fireEvent.press(screen.getAllByTestId(/^ai-reader-invoice-line-picker-custom-/)[0]);
    await fireEvent.press(screen.getByTestId("billable-item-picker-custom"));
    await fireEvent.changeText(screen.getAllByTestId(/^ai-reader-invoice-line-custom-description-custom-/)[0], "Hand-finished glaze");
    await fireEvent.changeText(screen.getAllByTestId(/^ai-reader-invoice-line-qty-custom-/)[0], "2");
    await fireEvent.changeText(screen.getAllByTestId(/^ai-reader-invoice-line-price-custom-/)[0], "35");
    expect(screen.getAllByText("$70.00").length).toBeGreaterThan(0);
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-PREVIEW-FAIL");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    expect(Alert.alert).not.toHaveBeenCalled();
    expect((mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: { invoiceOverrideLines: unknown };
    }).data.invoiceOverrideLines).toEqual([
      { description: "Hand-finished glaze", quantity: 2, unitPrice: 35 },
    ]);
  });

  it.each(["owner", "admin"])("requires confirmation before a %s creates without lines after preview failure", async (role) => {
    seed(role, false, true);
    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() => expect(screen.getByTestId("ai-reader-invoice-add-line")).toBeTruthy(), { timeout: 2500 });
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-NO-REVIEW");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith(
      "Create without reviewed invoice lines?",
      expect.stringContaining("invoice with no charges"),
      expect.arrayContaining([
        expect.objectContaining({ text: "Go back", style: "cancel" }),
        expect.objectContaining({ text: "Create anyway" }),
      ]),
      expect.objectContaining({ cancelable: true }),
    ));
    expect(mockCreateCaseMutateAsync).not.toHaveBeenCalled();
    const buttons = vi.mocked(Alert.alert).mock.calls[0][2];
    await act(async () => { buttons?.find((button) => button.text === "Create anyway")?.onPress?.(); });
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1));
    expect((mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: { invoiceOverrideLines?: unknown };
    }).data.invoiceOverrideLines).toEqual([]);
  });

  it("still warns when an owner adds a blank manual line after preview failure", async () => {
    seed("owner", false, true);
    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() => expect(screen.getByTestId("ai-reader-invoice-add-line")).toBeTruthy(), { timeout: 2500 });
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-BLANK-LINE");
    await fireEvent.press(screen.getByTestId("ai-reader-invoice-add-line"));
    expect(screen.getAllByTestId(/^ai-reader-invoice-line-picker-custom-/)).toHaveLength(1);
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith(
      "Create without reviewed invoice lines?",
      expect.stringContaining("invoice with no charges"),
      expect.any(Array),
      expect.any(Object),
    ));
    expect(mockCreateCaseMutateAsync).not.toHaveBeenCalled();
    await act(async () => {
      vi.mocked(Alert.alert).mock.calls[0][2]?.find((button) => button.text === "Go back")?.onPress?.();
    });
    expect(mockCreateCaseMutateAsync).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("lets a %s cancel and return to the manual editor after preview failure", async (role) => {
    seed(role, false, true);
    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() => expect(screen.getByTestId("ai-reader-invoice-add-line")).toBeTruthy(), { timeout: 2500 });
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-CANCEL-REVIEW");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    const buttons = vi.mocked(Alert.alert).mock.calls[0][2];
    await act(async () => { buttons?.find((button) => button.text === "Go back")?.onPress?.(); });
    expect(mockCreateCaseMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("e.g. 26-42").props.value).toBe("CASE-CANCEL-REVIEW");
    await fireEvent.press(screen.getByTestId("ai-reader-invoice-add-line"));
    await fireEvent.press(screen.getAllByTestId(/^ai-reader-invoice-line-picker-custom-/)[0]);
    await fireEvent.press(screen.getByTestId("billable-item-picker-custom"));
    await fireEvent.changeText(screen.getAllByTestId(/^ai-reader-invoice-line-custom-description-custom-/)[0], "Reviewed fee");
    await fireEvent.changeText(screen.getAllByTestId(/^ai-reader-invoice-line-price-custom-/)[0], "35");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalledTimes(1));
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect((mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: { invoiceOverrideLines: unknown };
    }).data.invoiceOverrideLines).toEqual([
      { description: "Reviewed fee", quantity: 1, unitPrice: 35 },
    ]);
  });

  it("retries a failed preview after manual edits and keeps those lines with the refreshed preview", async () => {
    const previewState = seed("owner", false, true);
    setMockAppState({ preCreateInvoiceItems: [] });
    const screen = await render(<AiReaderExtractedScreen />);

    await waitFor(() => expect(screen.getByTestId("ai-reader-invoice-preview-retry")).toBeTruthy(), { timeout: 2500 });
    await waitFor(() => expect(screen.getByTestId("ai-reader-invoice-add-line")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("ai-reader-invoice-add-line"));
    await fireEvent.press(screen.getAllByTestId(/^ai-reader-invoice-line-picker-custom-/)[0]);
    await fireEvent.press(screen.getByTestId("billable-item-picker-custom"));
    await fireEvent.changeText(
      screen.getAllByTestId(/^ai-reader-invoice-line-custom-description-custom-/)[0],
      "Hand-finished glaze",
    );
    const manualDescription = screen.getAllByTestId(/^ai-reader-invoice-line-custom-description-custom-/)[0];
    const manualKey = manualDescription.props.testID.replace("ai-reader-invoice-line-custom-description-", "");
    await fireEvent.changeText(screen.getByTestId(`ai-reader-invoice-line-qty-${manualKey}`), "2");
    await fireEvent.changeText(screen.getByTestId(`ai-reader-invoice-line-price-${manualKey}`), "35");

    previewState.failed = false;
    await fireEvent.press(screen.getByTestId("ai-reader-invoice-preview-retry"));
    await waitFor(() => expect(
      screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`),
    ).toBeTruthy(), { timeout: 3500 });

    expect(previewState.calls).toBe(2);
    expect(screen.getByTestId(`ai-reader-invoice-line-custom-description-${manualKey}`).props.value)
      .toBe("Hand-finished glaze");
    expect(screen.getByTestId(`ai-reader-invoice-line-qty-${manualKey}`).props.value).toBe("2");
    expect(screen.getByTestId(`ai-reader-invoice-line-price-${manualKey}`).props.value).toBe("35");
    expect(screen.getByText("Kept 1 manually reviewed line and added the new preview lines.")).toBeTruthy();
    expect(screen.getAllByText("$190.00").length).toBeGreaterThan(0);

    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-PREVIEW-RETRY");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    expect((mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: { invoiceOverrideLines: unknown };
    }).data.invoiceOverrideLines).toEqual([
      { description: "#14 Zirconia Crown", quantity: 1, unitPrice: 120 },
      { description: "Hand-finished glaze", quantity: 2, unitPrice: 35 },
    ]);
  });
  it("does not offer the line editor or override lines to non-admins when preview fails", async () => {
    seed("billing", false, true);
    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() => expect(screen.getByText(/Couldn't load the invoice preview/)).toBeTruthy(), { timeout: 2500 });
    expect(screen.queryByTestId("ai-reader-invoice-add-line")).toBeNull();
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-NON-ADMIN");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    expect(Alert.alert).not.toHaveBeenCalled();
    expect((mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: { invoiceOverrideLines?: unknown };
    }).data.invoiceOverrideLines).toBeUndefined();
  });

  it("restores the manual editor after another failed preview in a new practice", async () => {
    seed("owner", false, true);
    const screen = await render(<AiReaderExtractedScreen />);
    await waitFor(() => expect(screen.getByTestId("ai-reader-invoice-add-line")).toBeTruthy(), { timeout: 2500 });
    await fireEvent.press(screen.getByLabelText("Change practice"));
    await fireEvent.press(screen.getByText("Second Practice"));
    await waitFor(() => expect(screen.getByText("Calculating…")).toBeTruthy());
    expect(screen.queryByTestId("ai-reader-invoice-add-line")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("ai-reader-invoice-add-line")).toBeTruthy(), { timeout: 2500 });
    await fireEvent.press(screen.getByTestId("ai-reader-invoice-add-line"));
    await fireEvent.press(screen.getAllByTestId(/^ai-reader-invoice-line-picker-custom-/)[0]);
    await fireEvent.press(screen.getByTestId("billable-item-picker-custom"));
    await fireEvent.changeText(screen.getAllByTestId(/^ai-reader-invoice-line-custom-description-custom-/)[0], "Repriced custom line");
    await fireEvent.changeText(screen.getAllByTestId(/^ai-reader-invoice-line-price-custom-/)[0], "45");
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-RETRY-FAIL");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    expect((mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: { invoiceOverrideLines: unknown };
    }).data.invoiceOverrideLines).toEqual([
      { description: "Repriced custom line", quantity: 1, unitPrice: 45 },
    ]);
  });

  it("refreshes choices and clears old selections when the doctor or practice changes", async () => {
    seed();
    setMockAppState({ preCreateInvoiceItemsByContext: {
      "lab-1|practice-1|Dr. Synthetic063": [crown],
      "lab-1|practice-1|Dr. Synthetic047": [{ id: "jones", priceKey: "jones_key", name: "Jones Crown", unitPrice: 50 }],
      "lab-1|practice-2|Dr. Synthetic047": [{ id: "other", priceKey: "other_key", name: "Other Crown", unitPrice: 30 }],
    } });
    const screen = await ready();
    await fireEvent.press(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`));
    await fireEvent.press(screen.getByTestId("billable-item-picker-item-billable:pfm"));
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. Dr. Jane Smith"), "Dr. Synthetic047");
    await waitFor(() => expect(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`)).toBeTruthy(), { timeout: 2500 });
    expect(screen.getByTestId(`ai-reader-invoice-line-price-${lineKey}`).props.value).toBe("120.00");
    await fireEvent.press(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`));
    expect(screen.queryByTestId("billable-item-picker-item-billable:pfm")).toBeNull();
    expect(screen.getByTestId("billable-item-picker-item-billable:jones")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("billable-item-picker-backdrop"));
    await fireEvent.press(screen.getByLabelText("Change practice"));
    await fireEvent.press(screen.getByText("Second Practice"));
    await waitFor(() => expect(mockPreCreateItemParams.calls.some((p) =>
      p.providerOrganizationId === "practice-2" && p.doctorName === "Dr. Synthetic047")).toBe(true));
    await waitFor(() => expect(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`)).toBeTruthy(), { timeout: 2500 });
    await fireEvent.press(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`));
    expect(screen.queryByTestId("billable-item-picker-item-billable:jones")).toBeNull();
    expect(screen.getByTestId("billable-item-picker-item-billable:other")).toBeTruthy();
  });

  it("drops the old lab's practice and item prices when switching labs", async () => {
    seed();
    setMockAppState({
      meMemberships: [
        { id: "m1", role: "owner", status: "active", organizationId: "lab-1",
          organization: { id: "lab-1", name: "Lab One", type: "lab" } },
        { id: "m2", role: "owner", status: "active", organizationId: "lab-2",
          organization: { id: "lab-2", name: "Lab Two", type: "lab" } },
      ],
      preCreateInvoiceItemsByContext: {
        "lab-1|practice-1|Dr. Synthetic063": [crown],
        "lab-2|practice-2|Dr. Synthetic063": [{ id: "lab-two", priceKey: "lab_two", name: "Lab Two Crown", unitPrice: 60 }],
      },
    });
    const screen = await ready();
    await fireEvent.press(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`));
    await fireEvent.press(screen.getByTestId("billable-item-picker-item-billable:pfm"));
    await fireEvent.press(screen.getByText("Lab Two"));
    await waitFor(() => expect(mockPreCreateItemParams.calls.some((p) =>
      p.labOrganizationId === "lab-2" && p.providerOrganizationId === "practice-2")).toBe(true));
    await waitFor(() => expect(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`)).toBeTruthy(), { timeout: 2500 });
    expect(screen.getByTestId(`ai-reader-invoice-line-price-${lineKey}`).props.value).toBe("120.00");
    await fireEvent.press(screen.getByTestId(`ai-reader-invoice-line-picker-${lineKey}`));
    expect(screen.queryByTestId("billable-item-picker-item-billable:pfm")).toBeNull();
    expect(screen.getByTestId("billable-item-picker-item-billable:lab-two")).toBeTruthy();
  });

  it("keeps the non-admin price-only review and does not offer an item picker", async () => {
    seed("billing");
    const screen = await ready(false);
    expect(screen.queryByTestId(`ai-reader-invoice-line-picker-${lineKey}`)).toBeNull();
    expect(screen.getAllByText("$120.00").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("ai-reader-invoice-add-line")).toBeNull();
    await fireEvent.changeText(screen.getByPlaceholderText("0.00"), "95");
    expect(screen.getAllByText("$95.00").length).toBeGreaterThan(0);
    await fireEvent.changeText(screen.getByPlaceholderText("e.g. 26-42"), "CASE-4");
    await fireEvent.press(screen.getByTestId("ai-reader-create-btn"));
    await waitFor(() => expect(mockCreateCaseMutateAsync).toHaveBeenCalled());
    const payload = (mockCreateCaseMutateAsync.mock.calls[0][0] as {
      data: { invoiceOverrideLines?: unknown; restorations?: Array<{ unitPrice?: number; priceOverridden?: boolean }> };
    }).data;
    expect(payload.invoiceOverrideLines).toBeUndefined();
    expect(payload.restorations?.[0]).toEqual(expect.objectContaining({ unitPrice: 95, priceOverridden: true }));
  });
});