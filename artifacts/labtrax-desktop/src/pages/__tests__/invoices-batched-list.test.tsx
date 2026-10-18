/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import InvoicesPage from "@/pages/invoices";
import type { Invoice } from "@/lib/types";
import type { SessionUser } from "@/lib/api";
import { makeAuthWrapper } from "../../__tests__/test-utils";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const USER = { id: "user-1", username: "billing", role: "billing" } as unknown as SessionUser;
const summary = {
  openBalance: 4321,
  openCount: 18,
  overdueBalance: 1234,
  overdueCount: 7,
  sumTotal: 9999,
  sumBalance: 8765,
  paidThisMonth: 2222,
  paidCount: 4,
};

function invoice(index: number): Invoice {
  return {
    id: `invoice-${index}`,
    invoiceNumber: `INV-${String(index).padStart(3, "0")}`,
    status: "open",
    total: 1,
    balanceDue: 1,
    labOrganizationId: "lab-1",
    providerOrganizationId: "practice-1",
    caseId: null,
    createdAt: new Date(2025, 0, 31 - index).toISOString(),
    items: [],
  } as unknown as Invoice;
}

describe("Invoices batched list", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/invoices");
  });

  it("pages, resets on filtering, and uses full-set summary values", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/invoices?")) {
        requests.push(url);
        const params = new URL(url).searchParams;
        const searched = params.get("search");
        const view = params.get("view");
        const status = params.get("status");
        const statuses = params.get("statuses");
        const sort = params.get("sort");
        // The fake server pages by keyset: the cursor names the last row the
        // client already has, and the next batch starts after it.
        const all = Array.from({ length: 60 }, (_, i) => invoice(i));
        const limit = Number(params.get("limit"));
        const start = Number(params.get("offset") ?? 0);
        const rows = searched
          ? [{ ...invoice(99), invoiceNumber: "INV-NEEDLE" }]
          : status === "open"
            ? [invoice(70), invoice(71)]
            : statuses === "paid"
              ? [{ ...invoice(80), status: "paid", invoiceNumber: "INV-PAID" }]
              : sort === "practice"
                ? [invoice(90), invoice(91)]
          : all.slice(start, start + limit);
        const filteredTotal = searched ? 1 : status === "open" ? 2 : statuses === "paid" ? 1 : sort === "practice" ? 2 : all.length;
        return new Response(JSON.stringify({
          rows,
          total: filteredTotal,
          limit,
          offset: start,
          hasMore: !searched && !view && !status && !statuses && sort !== "practice" && start + rows.length < all.length,
          summary,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/cases/doctor-names") || url.includes("/organizations")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const Wrapper = makeAuthWrapper("/invoices", { user: USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    await screen.findByText("INV-000");
    expect(requests[0]).toContain("limit=25");
    expect(requests[0]).toContain("offset=0");
    expect(screen.getByTestId("invoices-loaded-count")).toHaveTextContent("Showing 1-25 of 60");
    expect(screen.getByTestId("column-total-total")).toHaveTextContent("$9,999.00");
    expect(screen.getByTestId("column-total-balance")).toHaveTextContent("$8,765.00");
    expect(screen.getByText("$4,321.00")).toBeInTheDocument();
    expect(screen.getByText("$2,222.00")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("invoices-page-3"));
    await screen.findByText("INV-050");
    expect(requests.some((url) => url.includes("offset=50"))).toBe(true);
    expect(screen.getByTestId("invoices-loaded-count")).toHaveTextContent("Showing 51-60 of 60");
    expect(screen.queryByText("INV-000")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search invoice #, patient, doctor, or practice..."), {
      target: { value: "needle" },
    });
    await screen.findByText("INV-NEEDLE");
    await waitFor(() => {
      const last = requests.at(-1) ?? "";
      expect(last).toContain("search=needle");
      expect(last).toContain("offset=0");
    });
    expect(screen.queryByText("INV-000")).not.toBeInTheDocument();
    expect(screen.getByTestId("invoices-loaded-count")).toHaveTextContent("Showing 1-1 of 1");

    fireEvent.change(screen.getByPlaceholderText("Search invoice #, patient, doctor, or practice..."), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("invoices-status-filter"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Open" }));
    await screen.findByText("INV-070");
    await waitFor(() => expect(requests.at(-1)).toContain("status=open"));
    expect(requests.at(-1)).toContain("offset=0");
    expect(screen.queryByText("INV-NEEDLE")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Paid" }));
    await screen.findByText("INV-PAID");
    expect(requests.at(-1)).toContain("offset=0");

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Paid" }));
    fireEvent.click(screen.getByRole("button", { name: "Practice / Patient" }));
    await screen.findByText("INV-090");
    await waitFor(() => expect(requests.at(-1)).toContain("sort=practice"));
    expect(requests.at(-1)).toContain("offset=0");
  });
});