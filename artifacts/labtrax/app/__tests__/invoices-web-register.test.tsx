import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
import { Platform } from "react-native";
import InvoicesScreen, { resetInvoiceRegisterSnapshotsForTests } from "@/app/finance/invoices";
import { resetMockAppState, setMockAppState, setMockSearchParams } from "../../vitest.setup";

const original = Platform.OS;
function seed() {
  setMockAppState({
    invoices: [{ id: "open", invoiceNumber: "INV-OPEN", status: "open", total: 100, balanceDue: 100, labOrganizationId: "lab-1", providerOrganization: { name: "Zenith" } }],
    meMemberships: [{ organizationId: "lab-1", role: "admin", status: "active", organization: { type: "lab" } }],
  });
}
afterEach(() => {
  cleanup(); resetMockAppState(); resetInvoiceRegisterSnapshotsForTests();
  setMockSearchParams({});
  Object.defineProperty(Platform, "OS", { value: original, configurable: true });
  vi.clearAllMocks();
});

describe("invoice register presentation split", () => {
  it("native keeps column totals, no summary cards, row press opens the editor", async () => {
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    seed();
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-summary-cards")).toBeNull();
    expect(screen.queryByTestId("column-total-total")).not.toBeNull();
    await fireEvent.press(screen.getByTestId("invoice-open"));
    expect(router.push).toHaveBeenCalledWith("/invoice-editor/open");
  });

  it("web shows server summary cards and selects a row without navigating", async () => {
    Object.defineProperty(Platform, "OS", { value: "web", configurable: true });
    seed();
    const screen = await render(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-summary-cards")).not.toBeNull();
    expect(screen.queryByTestId("column-total-total")).toBeNull();
    await fireEvent.press(screen.getByTestId("invoice-open"));
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByTestId("invoice-detail-panel")).not.toBeNull();
    await fireEvent.press(screen.getByTestId("invoice-detail-close"));
    expect(screen.queryByTestId("invoice-detail-panel")).toBeNull();
  });

  it("panel shows edit/payment for lab editors and routes to existing screens", async () => {
    Object.defineProperty(Platform, "OS", { value: "web", configurable: true });
    seed();
    setMockAppState({
      invoices: [{ id: "open", invoiceNumber: "INV-OPEN", status: "open", total: 100, balanceDue: 100, caseId: "case-9", labOrganizationId: "lab-1", providerOrganization: { name: "Zenith" } }],
      meMemberships: [{ organizationId: "lab-1", role: "admin", status: "active", organization: { type: "lab" } }],
    });
    const screen = await render(<InvoicesScreen />);
    await fireEvent.press(screen.getByTestId("invoice-open"));
    await fireEvent.press(screen.getByTestId("invoice-detail-edit"));
    expect(router.push).toHaveBeenCalledWith("/invoice-editor/open");
    await fireEvent.press(screen.getByTestId("invoice-detail-payment"));
    expect(router.push).toHaveBeenCalledWith("/case/case-9?recordPaymentInvoiceId=open");
  });

  it("opens the read-only finance detail from a sales report route and returns to the report", async () => {
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    seed();
    setMockSearchParams({ invoiceId: "open", fromSalesReport: "1" });
    const screen = await render(<InvoicesScreen />);
    expect(screen.getByTestId("invoice-detail-screen")).not.toBeNull();
    expect(screen.getByTestId("invoice-detail-panel")).not.toBeNull();

    await fireEvent.press(screen.getByTestId("invoice-detail-close"));

    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("panel hides write actions for non-lab (provider) users", async () => {
    Object.defineProperty(Platform, "OS", { value: "web", configurable: true });
    setMockAppState({
      invoices: [{ id: "open", invoiceNumber: "INV-OPEN", status: "open", total: 100, balanceDue: 100, caseId: "case-9", providerOrganizationId: "p1", labOrganizationId: "lab-1" }],
      meMemberships: [{ organizationId: "p1", role: "admin", status: "active", organization: { type: "provider" } }],
    });
    const screen = await render(<InvoicesScreen />);
    await fireEvent.press(screen.getByTestId("invoice-open"));
    expect(screen.queryByTestId("invoice-detail-panel")).not.toBeNull();
    expect(screen.queryByTestId("invoice-detail-edit")).toBeNull();
    expect(screen.queryByTestId("invoice-detail-payment")).toBeNull();
  });

  it("closes the selected preview when the active billing scope changes", async () => {
    Object.defineProperty(Platform, "OS", { value: "web", configurable: true });
    seed();
    const screen = await render(<InvoicesScreen />);
    await fireEvent.press(screen.getByTestId("invoice-open"));
    expect(screen.queryByTestId("invoice-detail-panel")).not.toBeNull();
    setMockAppState({
      meMemberships: [{ organizationId: "lab-2", role: "admin", status: "active", organization: { type: "lab" } }],
    });
    await screen.rerender(<InvoicesScreen />);
    expect(screen.queryByTestId("invoice-detail-panel")).toBeNull();
  });
});
