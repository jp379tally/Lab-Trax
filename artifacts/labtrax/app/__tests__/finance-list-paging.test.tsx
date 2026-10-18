import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import InvoicesScreen, { resetInvoiceRegisterSnapshotsForTests } from "@/app/finance/invoices";
import StatementsScreen from "@/app/finance/statements";
import CustomersScreen from "@/app/finance/customers";
import {
  mockDoctorDirectoryParams,
  mockPagedInvoiceParams,
  resetMockAppState,
  setMockAppState,
} from "../../vitest.setup";

const labMembership = {
  organizationId: "lab-1",
  role: "admin",
  status: "active",
  organization: { id: "lab-1", type: "lab", name: "Main Lab" },
};

afterEach(() => {
  cleanup();
  resetMockAppState();
  resetInvoiceRegisterSnapshotsForTests();
  vi.clearAllMocks();
});

describe("mobile finance list paging", () => {
  it.each([
    ["invoices", <InvoicesScreen />, { invoicesHasNextPage: true }],
    ["statements", <StatementsScreen />, { statementAccountSummariesHasNextPage: true }],
    ["customers", <CustomersScreen />, { doctorDirectoryHasNextPage: true }],
  ])("renders a shared Load more footer for %s", async (_name, screen, state) => {
    setMockAppState({ meMemberships: [labMembership], ...state });
    expect((await render(screen)).getByTestId("list-load-more")).toBeTruthy();
  });

  it("sends invoice search and status filters to the paged request", async () => {
    setMockAppState({
      meMemberships: [labMembership],
      invoices: [{
        id: "inv-1",
        invoiceNumber: "INV-1",
        status: "open",
        balanceDue: 10,
        providerOrganizationId: "practice-1",
        providerOrganization: { name: "Acme" },
      }],
    });
    const screen = await render(<InvoicesScreen />);
    await fireEvent.changeText(screen.getByTestId("invoice-search"), "Acme");
    await fireEvent.press(screen.getByTestId("view-open"));
    await waitFor(() => {
      expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({
        labOrganizationId: "lab-1",
        search: "Acme",
        status: "open",
        view: "open",
      });
    });
  });

  it("resets and appends only invoices matching the active scope, filters, and sort", async () => {
    const makeInvoice = (
      id: string,
      invoiceNumber: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      id,
      invoiceNumber,
      status: "open",
      total: 10,
      balanceDue: 10,
      labOrganizationId: "lab-1",
      providerOrganizationId: "practice-1",
      providerOrganization: { name: "Acme" },
      issuedAt: "2026-01-01T00:00:00.000Z",
      dueAt: "2026-02-01T00:00:00.000Z",
      ...overrides,
    });
    setMockAppState({
      meMemberships: [labMembership],
      invoicesPageSize: 2,
      invoices: [
        makeInvoice("inv-a", "ACME-1", { total: 10, balanceDue: 8, issuedAt: "2026-01-01T00:00:00.000Z" }),
        makeInvoice("inv-b", "ACME-2", { total: 20, balanceDue: 15, issuedAt: "2026-01-02T00:00:00.000Z" }),
        makeInvoice("inv-c", "ACME-3", { total: 30, balanceDue: 25, issuedAt: "2026-01-03T00:00:00.000Z" }),
        makeInvoice("inv-paid", "ACME-PAID", { status: "paid", total: 40, balanceDue: 0 }),
        makeInvoice("inv-other-lab", "ACME-OTHER", { labOrganizationId: "lab-2", total: 500, balanceDue: 500 }),
      ],
    });

    const screen = await render(<InvoicesScreen />);
    expect(screen.getByTestId("invoice-inv-c")).toBeTruthy();
    expect(screen.getByTestId("invoice-inv-b")).toBeTruthy();
    expect(screen.queryByTestId("invoice-inv-other-lab")).toBeNull();
    expect(screen.getByTestId("column-total-total")).toHaveTextContent("$50.00");
    expect(screen.getByTestId("column-total-balance")).toHaveTextContent("$40.00");

    await fireEvent.press(screen.getByTestId("list-load-more"));
    await waitFor(() => expect(screen.getByTestId("invoice-inv-a")).toBeTruthy());
    expect(screen.getByTestId("column-total-total")).toHaveTextContent("$100.00");
    expect(screen.getByTestId("column-total-balance")).toHaveTextContent("$48.00");

    await fireEvent.changeText(screen.getByTestId("invoice-search"), "PAID");
    await waitFor(() => {
      expect(screen.getByTestId("invoice-inv-paid")).toBeTruthy();
      expect(screen.queryByTestId("invoice-inv-a")).toBeNull();
      expect(screen.getByText("1 invoice")).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId("search-clear"));
    await fireEvent.press(screen.getByTestId("view-open"));
    await waitFor(() => expect(screen.getByTestId("invoice-inv-c")).toBeTruthy());
    expect(screen.queryByTestId("invoice-inv-a")).toBeNull();
    expect(screen.queryByTestId("invoice-inv-paid")).toBeNull();

    await fireEvent.press(screen.getByTestId("view-all"));
    await fireEvent.press(screen.getByTestId("quick-zero-balance"));
    await waitFor(() => expect(screen.getByTestId("invoice-inv-paid")).toBeTruthy());
    expect(screen.queryByTestId("invoice-inv-a")).toBeNull();

    await fireEvent.press(screen.getByTestId("quick-zero-balance"));
    await fireEvent.press(screen.getByTestId("sort-open"));
    await fireEvent.press(screen.getByTestId("sort-field-issued"));
    await fireEvent.press(screen.getByTestId("sort-direction-asc"));
    await waitFor(() => expect(screen.getByTestId("invoice-inv-a")).toBeTruthy());
    expect(screen.queryByTestId("invoice-inv-c")).toBeNull();
    expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({
      labOrganizationId: "lab-1",
      sortBy: "issued",
      sortDirection: "asc",
    });
  });

  it("keeps provider paging inside the active practice", async () => {
    setMockAppState({
      meMemberships: [{
        organizationId: "practice-1",
        role: "provider",
        status: "active",
        organization: { id: "practice-1", type: "provider", name: "Acme" },
      }],
      invoicesPageSize: 1,
      invoices: [
        {
          id: "provider-1",
          invoiceNumber: "PROVIDER-1",
          status: "open",
          total: 10,
          balanceDue: 10,
          providerOrganizationId: "practice-1",
        },
        {
          id: "provider-2",
          invoiceNumber: "PROVIDER-2",
          status: "open",
          total: 20,
          balanceDue: 20,
          providerOrganizationId: "practice-1",
        },
        {
          id: "provider-other",
          invoiceNumber: "OTHER-PRACTICE",
          status: "open",
          total: 500,
          balanceDue: 500,
          providerOrganizationId: "practice-2",
        },
      ],
    });

    const screen = await render(<InvoicesScreen />);
    expect(mockPagedInvoiceParams.calls.at(-1)).toMatchObject({ practiceId: "practice-1" });
    expect(screen.queryByTestId("invoice-provider-other")).toBeNull();
    await fireEvent.press(screen.getByTestId("list-load-more"));
    await waitFor(() => expect(screen.getByTestId("invoice-provider-2")).toBeTruthy());
    expect(screen.queryByTestId("invoice-provider-other")).toBeNull();
    expect(screen.getByTestId("column-total-total")).toHaveTextContent("$30.00");
    expect(screen.getByText("2 invoices")).toBeTruthy();
  });

  it("sends customer search and open-only mode to the directory request", async () => {
    setMockAppState({ meMemberships: [labMembership] });
    const screen = await render(<CustomersScreen />);
    await fireEvent.changeText(screen.getByTestId("customer-search"), "Smith");
    expect(mockDoctorDirectoryParams.calls.at(-1)).toEqual({
      labId: "lab-1",
      params: { search: "Smith", openOnly: true },
    });
    await fireEvent.press(screen.getByText("All cases"));
    expect(mockDoctorDirectoryParams.calls.at(-1)).toEqual({
      labId: "lab-1",
      params: { search: "Smith", openOnly: false },
    });
  });

  it("renders only a short unpaid-statement preview per account", async () => {
    setMockAppState({
      meMemberships: [labMembership],
      statementAccountSummaries: [{
        practiceId: "practice-1",
        practiceName: "Acme",
        billingEmail: null,
        openInvoiceCount: 0,
        openInvoiceTotal: 0,
        totalOpenBalance: 50,
        overdueBalance: 0,
        unpaidStatements: Array.from({ length: 5 }, (_, index) => ({
          id: `statement-${index}`,
          date: `2026-0${index + 1}-01T00:00:00.000Z`,
          remainingBalance: index + 1,
        })),
      }],
    });
    const screen = await render(<StatementsScreen />);
    expect(screen.getByText("2 more unpaid statements")).toBeTruthy();
    expect(screen.queryByText("$4.00")).toBeNull();
    expect(screen.queryByText("$5.00")).toBeNull();
  });
});