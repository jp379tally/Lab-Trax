/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Invoice, Organization } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const apiFetchMock = vi.fn();
const apiFetchArrayBufferMock = vi.fn();
const downloadCsvMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
    apiFetchArrayBuffer: (...args: unknown[]) => apiFetchArrayBufferMock(...args),
  };
});

vi.mock("@/lib/export", () => ({
  downloadCsv: (...args: unknown[]) => downloadCsvMock(...args),
  safeFilename: (name: string) => name.replace(/[^a-z0-9-_]+/gi, "_"),
}));

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

import {
  CustomerStatementChargesTab,
  InvoicesTab,
} from "@/components/customer-detail-tabs";

const practice = {
  id: "provider-1",
  name: "Bright Smiles",
  displayName: "Bright Smiles Dental",
} as Organization;

const invoices: Invoice[] = Array.from({ length: 12 }, (_, index) => ({
  id: `invoice-${index + 1}`,
  invoiceNumber: `INV-${String(index + 1).padStart(3, "0")}`,
  labOrganizationId: "lab-1",
  providerOrganizationId: practice.id,
  status: index >= 10 ? "paid" : "open",
  total: String((index + 1) * 10),
  balanceDue: index >= 10 ? "0" : String((index + 1) * 10),
  issuedAt: `2026-${index >= 10 ? "09" : "08"}-${String((index % 10) + 1).padStart(2, "0")}T12:00:00.000Z`,
}));

const statementCharges = Array.from({ length: 11 }, (_, index) => ({
  id: `charge-${index + 1}`,
  date: `2026-08-${String((index % 10) + 1).padStart(2, "0")}T12:00:00.000Z`,
  type: "invoice",
  typeLabel: "Invoice",
  invoiceNumber: `INV-${String(index + 1).padStart(3, "0")}`,
  invoiceAmount: "100.00",
  balance: String(50 + index),
  openBalance: String(50 + index),
}));

function parsePath(path: string) {
  return new URL(path, "https://labtrax.test");
}

function invoiceMatches(invoice: Invoice, params: URLSearchParams) {
  const status = params.get("status");
  if (status && invoice.status !== status) return false;

  const dateValue =
    params.get("customerCenter") === "true"
      ? invoice.createdAt ?? invoice.issuedAt
      : invoice.issuedAt;
  const dateFrom = params.get("dateFrom");
  if (dateFrom && new Date(dateValue!).getTime() < new Date(dateFrom).getTime()) {
    return false;
  }
  const dateTo = params.get("dateTo");
  if (dateTo && new Date(dateValue!).getTime() > new Date(dateTo).getTime()) {
    return false;
  }
  return true;
}

function renderWithClient(element: React.ReactElement) {
  const Wrapper = makeAuthWrapper("/accounts");
  return render(<Wrapper>{element}</Wrapper>);
}

function invoiceListCalls() {
  return apiFetchMock.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.startsWith("/invoices?"));
}

function findInvoiceCall(predicate: (params: URLSearchParams) => boolean) {
  const path = invoiceListCalls().find((candidate) =>
    predicate(parsePath(candidate).searchParams),
  );
  expect(path).toBeDefined();
  return parsePath(path!).searchParams;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchArrayBufferMock.mockReset();
  downloadCsvMock.mockReset();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  apiFetchArrayBufferMock.mockResolvedValue({
    buffer: new ArrayBuffer(0),
    headers: new Headers(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Customer Center server-driven windows", () => {
  it("keeps the entered-date scope on later invoice pages", async () => {
    const enteredDateInvoices: Invoice[] = [
      ...Array.from({ length: 10 }, (_, index) => ({
        ...invoices[0]!,
        id: `entered-invoice-${index + 1}`,
        invoiceNumber: `ENTERED-${String(index + 1).padStart(3, "0")}`,
        createdAt: `2026-09-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
        issuedAt: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
      })),
      {
        ...invoices[0]!,
        id: "outside-entered-date",
        invoiceNumber: "OUTSIDE-ENTERED-DATE",
        createdAt: "2026-08-31T12:00:00.000Z",
        issuedAt: "2026-09-15T12:00:00.000Z",
      },
      {
        ...invoices[0]!,
        id: "entered-invoice-11",
        invoiceNumber: "ENTERED-011",
        createdAt: "2026-09-20T12:00:00.000Z",
        issuedAt: "2026-10-15T12:00:00.000Z",
      },
    ];

    apiFetchMock.mockImplementation(async (path: string) => {
      const url = parsePath(path);
      if (url.pathname !== "/invoices") return [];

      const matching = enteredDateInvoices.filter((invoice) =>
        invoiceMatches(invoice, url.searchParams),
      );
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      return {
        rows: matching.slice(offset, offset + limit),
        total: matching.length,
        limit,
        offset,
        hasMore: offset + limit < matching.length,
      };
    });

    renderWithClient(<InvoicesTab practice={practice} labOrgId="lab-1" />);

    fireEvent.change(screen.getByDisplayValue("All Dates"), {
      target: { value: "custom" },
    });
    const dateInputs = document.querySelectorAll<HTMLInputElement>(
      'input[type="date"]',
    );
    fireEvent.change(dateInputs[0]!, { target: { value: "2026-09-01" } });
    fireEvent.change(dateInputs[1]!, { target: { value: "2026-09-30" } });

    expect(await screen.findByText("Showing 10 of 11")).toBeInTheDocument();

    const hasEnteredDateScope = (params: URLSearchParams) =>
      params.get("customerCenter") === "true" &&
      params.get("practiceId") === practice.id &&
      params.get("dateFrom") === "2026-09-01T00:00:00.000Z" &&
      params.get("dateTo") === "2026-09-30T00:00:00.000Z";

    expect(
      findInvoiceCall(
        (params) =>
          hasEnteredDateScope(params) &&
          params.get("limit") === "10" &&
          params.get("offset") === "0",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Showing 11 of 11")).toBeInTheDocument();
    expect(screen.getByText("ENTERED-011")).toBeInTheDocument();
    expect(screen.queryByText("OUTSIDE-ENTERED-DATE")).not.toBeInTheDocument();
    expect(
      findInvoiceCall(
        (params) =>
          hasEnteredDateScope(params) &&
          params.get("limit") === "10" &&
          params.get("offset") === "10",
      ),
    ).toBeTruthy();
  });

  it("pages invoices, resets paging for status/date filters, and exports every match", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      const url = parsePath(path);
      if (url.pathname !== "/invoices") return [];

      const matching = invoices.filter((invoice) =>
        invoiceMatches(invoice, url.searchParams),
      );
      const hasPaging = url.searchParams.has("limit");
      if (!hasPaging) return matching;

      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      return {
        rows: matching.slice(offset, offset + limit),
        total: matching.length,
        limit,
        offset,
        hasMore: offset + limit < matching.length,
      };
    });

    renderWithClient(<InvoicesTab practice={practice} labOrgId="lab-1" />);

    expect(await screen.findByText("Showing 10 of 12")).toBeInTheDocument();
    expect(
      findInvoiceCall(
        (params) =>
          params.get("limit") === "10" &&
          params.get("offset") === "0" &&
          !params.has("status"),
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Showing 12 of 12")).toBeInTheDocument();
    expect(
      findInvoiceCall(
        (params) =>
          params.get("limit") === "10" &&
          params.get("offset") === "10" &&
          !params.has("status"),
      ),
    ).toBeTruthy();
    expect(screen.getByText("INV-012")).toBeInTheDocument();

    const filters = screen.getAllByRole("combobox");
    fireEvent.change(filters[0]!, { target: { value: "paid" } });
    expect(await screen.findByText("Showing 2 of 2")).toBeInTheDocument();
    const paidParams = findInvoiceCall(
      (params) =>
        params.get("status") === "paid" &&
        params.get("limit") === "10" &&
        params.get("offset") === "0",
    );
    expect(paidParams.get("offset")).toBe("0");
    expect(screen.getByText("INV-011")).toBeInTheDocument();
    expect(screen.queryByText("INV-001")).not.toBeInTheDocument();

    fireEvent.change(filters[0]!, { target: { value: "all" } });
    fireEvent.change(filters[1]!, { target: { value: "custom" } });
    const dateInputs = document.querySelectorAll<HTMLInputElement>(
      'input[type="date"]',
    );
    fireEvent.change(dateInputs[0]!, { target: { value: "2026-09-01" } });
    fireEvent.change(dateInputs[1]!, { target: { value: "2026-09-30" } });

    expect(await screen.findByText("Showing 2 of 2")).toBeInTheDocument();
    const dateParams = findInvoiceCall(
      (params) =>
        params.get("dateFrom")?.startsWith("2026-09-01") === true &&
        params.get("dateTo")?.startsWith("2026-09-30") === true &&
        params.get("limit") === "10" &&
        params.get("offset") === "0",
    );
    expect(dateParams.get("offset")).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    await waitFor(() => expect(apiFetchArrayBufferMock).toHaveBeenCalled());

    const exportParams = findInvoiceCall(
      (params) =>
        params.get("dateFrom")?.startsWith("2026-09-01") === true &&
        params.get("dateTo")?.startsWith("2026-09-30") === true &&
        !params.has("limit") &&
        !params.has("offset"),
    );
    expect(exportParams.get("practiceId")).toBe(practice.id);
    expect(apiFetchArrayBufferMock).toHaveBeenCalledWith(
      "/lab-orgs/lab-1/statements/preview-pdf",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          recipientType: "practice",
          recipientKey: practice.id,
          invoiceScope: "all",
          from: null,
          to: null,
          asOf: null,
          periodLabel: null,
          invoiceIds: ["invoice-11", "invoice-12"],
        }),
      }),
    );
  });

  it("keeps server-provided balances across charge pages and exports the complete set", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      const url = parsePath(path);
      if (!url.pathname.endsWith("/statement-charges")) return [];

      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? statementCharges.length);
      const rows = statementCharges.slice(offset, offset + limit);
      return {
        rows,
        total: statementCharges.length,
        limit,
        offset,
        hasMore: offset + limit < statementCharges.length,
      };
    });

    renderWithClient(
      <CustomerStatementChargesTab selected={practice} labOrgId="lab-1" />,
    );

    expect(await screen.findByText("Showing 10 of 11")).toBeInTheDocument();
    expect(
      apiFetchMock.mock.calls.some(
        ([path]) =>
          path ===
          "/billing/lab-1/accounts/provider-1/statement-charges?limit=10&offset=0",
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Showing 11 of 11")).toBeInTheDocument();
    expect(screen.getByText("INV-011")).toBeInTheDocument();
    expect(screen.getByText("$60.00")).toBeInTheDocument();
    expect(
      apiFetchMock.mock.calls.some(
        ([path]) =>
          path ===
          "/billing/lab-1/accounts/provider-1/statement-charges?limit=10&offset=10",
      ),
    ).toBe(true);

    fireEvent.click(screen.getByTestId("button-export-statement-charges"));
    await waitFor(() =>
      expect(downloadCsvMock).toHaveBeenCalledWith(
        expect.stringMatching(/^statement-charge-history-Bright_Smiles_Dental-/),
        expect.arrayContaining([
          expect.objectContaining({ "Invoice Number": "INV-011", Balance: "60" }),
        ]),
      ),
    );
    expect(
      apiFetchMock.mock.calls.some(
        ([path]) =>
          path ===
          "/billing/lab-1/accounts/provider-1/statement-charges",
      ),
    ).toBe(true);
    expect(downloadCsvMock.mock.calls.at(-1)?.[1]).toHaveLength(11);
  });
});