/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Invoice, Organization } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";

const apiFetchMock = vi.fn();
const apiFetchArrayBufferMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
    apiFetchArrayBuffer: (...args: unknown[]) =>
      apiFetchArrayBufferMock(...args),
  };
});

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

import { InvoicesTab } from "@/components/customer-detail-tabs";

const practice = {
  id: "provider-1",
  name: "Bright Smiles",
  displayName: "Bright Smiles Dental",
} as Organization;

const invoice: Invoice = {
  id: "invoice-1",
  invoiceNumber: "INV-001",
  labOrganizationId: "lab-1",
  providerOrganizationId: practice.id,
  status: "open",
  total: "125.00",
  balanceDue: "125.00",
  createdAt: "2026-09-14T12:00:00.000Z",
  issuedAt: "2026-10-03T12:00:00.000Z",
};

function parsePath(path: string) {
  return new URL(path, "https://labtrax.test");
}

function renderWithClient(element: React.ReactElement) {
  const Wrapper = makeAuthWrapper("/accounts");
  return render(<Wrapper>{element}</Wrapper>);
}

function invoiceRequests() {
  return apiFetchMock.mock.calls
    .map(([path]) => String(path))
    .filter((path) => parsePath(path).pathname === "/invoices");
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchArrayBufferMock.mockReset();
  apiFetchArrayBufferMock.mockResolvedValue({
    buffer: new ArrayBuffer(0),
    headers: new Headers(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Customer Center entered invoice date", () => {
  it("shows createdAt and preserves the Customer Center date scope for filtering and statement export", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      const { searchParams } = parsePath(path);
      if (searchParams.has("limit")) {
        return {
          rows: [invoice],
          total: 1,
          limit: Number(searchParams.get("limit")),
          offset: Number(searchParams.get("offset")),
          hasMore: false,
        };
      }
      return [invoice];
    });

    renderWithClient(<InvoicesTab practice={practice} labOrgId="lab-1" />);

    expect(await screen.findByText("INV-001")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Entered Date" }),
    ).toBeInTheDocument();
    expect(screen.getByText("09/14/2026")).toBeInTheDocument();
    expect(screen.queryByText("10/03/2026")).not.toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("All Dates"), {
      target: { value: "custom" },
    });
    const dateInputs = document.querySelectorAll<HTMLInputElement>(
      'input[type="date"]',
    );
    fireEvent.change(dateInputs[0]!, {
      target: { value: "2026-09-01" },
    });
    fireEvent.change(dateInputs[1]!, {
      target: { value: "2026-09-30" },
    });

    await waitFor(() => {
      expect(
        invoiceRequests().some((path) => {
          const { searchParams } = parsePath(path);
          return (
            searchParams.get("practiceId") === practice.id &&
            searchParams.get("customerCenter") === "true" &&
            searchParams.get("dateFrom") === "2026-09-01T00:00:00.000Z" &&
            searchParams.get("dateTo") === "2026-09-30T00:00:00.000Z" &&
            searchParams.get("limit") === "10"
          );
        }),
      ).toBe(true);
    });

    const exportButton = screen.getByRole("button", { name: "Export PDF" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await waitFor(() => expect(apiFetchArrayBufferMock).toHaveBeenCalled());

    await waitFor(() => {
      expect(
        invoiceRequests().some((path) => {
          const { searchParams } = parsePath(path);
          return (
            searchParams.get("practiceId") === practice.id &&
            searchParams.get("customerCenter") === "true" &&
            searchParams.get("dateFrom") === "2026-09-01T00:00:00.000Z" &&
            searchParams.get("dateTo") === "2026-09-30T00:00:00.000Z" &&
            !searchParams.has("limit") &&
            !searchParams.has("offset")
          );
        }),
      ).toBe(true);
    });
  });
});
