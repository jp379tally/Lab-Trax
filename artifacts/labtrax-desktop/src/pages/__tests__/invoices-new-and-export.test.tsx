/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import InvoicesPage from "@/pages/invoices";
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

const BILLING = { id: "u1", username: "billing", role: "billing" } as unknown as SessionUser;
const VIEWER = { id: "u2", username: "tech", role: "technician" } as unknown as SessionUser;
const emptyPage = { rows: [], total: 0, limit: 25, offset: 0, hasMore: false, summary: { openBalance: 0, openCount: 0, overdueBalance: 0, overdueCount: 0, sumTotal: 0, sumBalance: 0, paidThisMonth: 0, paidCount: 0 } };

function installFetch(onInvoices: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/invoices?")) return onInvoices(url, init);
    const body = url.includes("/organizations") || url.includes("doctor-names") ? [] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

beforeEach(() => { vi.unstubAllGlobals(); window.history.replaceState({}, "", "/invoices"); });
afterEach(() => vi.unstubAllGlobals());

describe("Invoices ?newInvoice=1 deep link", () => {
  it("opens Create Invoice for billing users", async () => {
    installFetch(() => new Response(JSON.stringify(emptyPage), { status: 200 }));
    const Wrapper = makeAuthWrapper("/invoices?newInvoice=1", { user: BILLING, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);
    expect(await screen.findByRole("button", { name: "Create Invoice" })).toBeInTheDocument();
  });

  it("does nothing for users who cannot create invoices", async () => {
    installFetch(() => new Response(JSON.stringify(emptyPage), { status: 200 }));
    const Wrapper = makeAuthWrapper("/invoices?newInvoice=1", { user: VIEWER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);
    await screen.findByTestId("invoices-export");
    expect(screen.queryByRole("button", { name: "Create Invoice" })).toBeNull();
    expect(screen.queryByRole("button", { name: /New Invoice/ })).toBeNull();
  });
});

describe("register metadata compatibility", () => {
  it("does not present one page's amounts as whole-set totals when metadata is missing", async () => {
    const row = { id: "metadata-missing", invoiceNumber: "META-1", status: "open", total: 42, balanceDue: 42, items: [] };
    installFetch(() => new Response(JSON.stringify({ rows: [row], total: 101, limit: 25, offset: 0, hasMore: true }), { status: 200 }));
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);
    expect(await screen.findByRole("status")).toHaveTextContent("Invoice totals are unavailable");
    expect(within(screen.getByTestId("invoice-open-card")).queryByText("$42.00")).toBeNull();
  });

  it("pages a complete legacy array while retaining full-set column totals", async () => {
    const rows = Array.from({ length: 30 }, (_, n) => ({
      id: `legacy-${n}`, invoiceNumber: `LEGACY-${String(n).padStart(2, "0")}`, status: "open",
      total: 10, balanceDue: 10, createdAt: "2026-01-01T12:00:00Z", items: [],
    }));
    installFetch(() => new Response(JSON.stringify(rows), { status: 200 }));
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);
    expect(await screen.findByText(/Showing 1.25 of 30/)).toBeInTheDocument();
    expect(screen.queryByText("LEGACY-29")).toBeNull();
    expect(screen.getByTestId("column-total-total")).toHaveTextContent("$300.00");
    fireEvent.click(screen.getByRole("button", { name: /Page 2/ }));
    expect(await screen.findByText("LEGACY-29")).toBeInTheDocument();
    expect(screen.queryByText("LEGACY-00")).toBeNull();
    expect(screen.getByTestId("column-total-total")).toHaveTextContent("$300.00");
  });
});

describe("Invoices CSV export", () => {
  it("cancel aborts the in-flight request and writes no file", async () => {
    const create = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    let exporting = false;
    installFetch((url, init) => {
      if (!url.includes("limit=100")) return new Response(JSON.stringify(emptyPage), { status: 200 });
      exporting = true;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);
    fireEvent.click(await screen.findByTestId("invoices-export"));
    await waitFor(() => expect(exporting).toBe(true));
    fireEvent.click(await screen.findByTestId("invoices-export-cancel"));
    await waitFor(() => expect(screen.getByTestId("invoices-export")).toBeInTheDocument());
    expect(create).not.toHaveBeenCalled();
  });

  it("a truncated terminal page fails the export without a download", async () => {
    const create = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    installFetch((url) => new Response(JSON.stringify(
      url.includes("limit=100") ? { rows: [], total: 5, limit: 100, offset: 0, hasMore: false } : emptyPage,
    ), { status: 200 }));
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);
    fireEvent.click(await screen.findByTestId("invoices-export"));
    await waitFor(() => expect(screen.getByTestId("invoices-export")).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(create).not.toHaveBeenCalled();
  });
});
