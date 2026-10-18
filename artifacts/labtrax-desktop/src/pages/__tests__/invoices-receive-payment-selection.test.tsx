/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

import InvoicesPage from "@/pages/invoices";

const BILLING_USER = { id: "u-bill", username: "billing", role: "billing" } as unknown as SessionUser;
const summary = { openBalance: 0, openCount: 0, overdueBalance: 0, overdueCount: 0, sumTotal: 0, sumBalance: 0, paidThisMonth: 0, paidCount: 0 };

function inv(i: number, status = "open", practice = "practice-1"): Invoice {
  return {
    id: `invoice-${i}`, invoiceNumber: `INV-${String(i).padStart(3, "0")}`, status, total: 10,
    balanceDue: status === "paid" ? 0 : 10, labOrganizationId: "lab-1", providerOrganizationId: practice, providerOrganization: { id: practice, name: `Practice ${practice}` },
    caseId: null, createdAt: new Date(2025, 0, 31 - i).toISOString(), items: [],
  } as unknown as Invoice;
}


function install(all: Invoice[]) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/api/invoices?")) {
      const p = new URL(url, "http://localhost").searchParams;
      const limit = Number(p.get("limit")); const off = Number(p.get("offset") ?? 0);
      const rows = all.slice(off, off + limit);
      return json({ rows, total: all.length, limit, offset: off, hasMore: off + rows.length < all.length, summary });
    }
    const one = url.match(/\/api\/invoices\/([^/?]+)$/);
    if (one) return json(all.find((i) => i.id === one[1]) ?? {});
    if (url.includes("/organizations")) return json([{ id: "lab-1", name: "Lab One", type: "lab" }]);
    return json([]);
  }));
}
function mount(path = "/invoices") {
  const Wrapper = makeAuthWrapper(path, { user: BILLING_USER, status: "authed", restoreStatus: "ok", restoreNoticeDismissed: true });
  render(<Wrapper><InvoicesPage /></Wrapper>);
}
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); window.history.replaceState({}, "", "/invoices"); });

describe("bulk Receive Payment uses the whole selection", () => {
  it("31 selected across pages: modal gets all 31 ids and the full total", async () => {
    install(Array.from({ length: 31 }, (_, i) => inv(i)));
    mount();
    await screen.findByText("INV-000");
    fireEvent.click(screen.getByTestId("invoice-select-all"));
    await screen.findByText("31 invoices selected");
    fireEvent.click(screen.getByRole("button", { name: /Receive Payment/ }));
    expect(await screen.findByText(/\(31 selected\)/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("310.00")).toBeInTheDocument();
  });

  it("mixed practices: shows the practice choice and names the excluded invoices", async () => {
    install([inv(0, "open", "p-a"), inv(1, "open", "p-a"), inv(2, "open", "p-b")]);
    mount();
    await screen.findByText("INV-000");
    fireEvent.click(screen.getByTestId("invoice-select-all"));
    await screen.findByText("3 invoices selected");
    fireEvent.click(screen.getByRole("button", { name: /Receive Payment/ }));
    const choice = await screen.findByTestId("payment-practice-choice");
    expect(choice).toHaveTextContent("Excludes 1: INV-002");
    expect(choice).toHaveTextContent("Excludes 2: INV-000, INV-001");
    fireEvent.click(screen.getByTestId("payment-choice-p-b"));
    expect(await screen.findByText(/\(1 selected\)/)).toBeInTheDocument();
  });
});

describe("editor entry guard", () => {
  it.each(["draft", "recovery_draft"])("?invoiceId deep link to an unfrozen %s opens the read-only preview", async (status) => {
    window.history.replaceState({}, "", "/invoices?invoiceId=invoice-0");
    install([inv(0, status), inv(1)]);
    mount("/invoices?invoiceId=invoice-0");
    await screen.findByTestId("invoice-preview");
    expect(await screen.findByText(/read-only here/)).toBeInTheDocument();
    expect(screen.queryByTestId("invoice-preview-edit")).toBeNull();
    expect(screen.queryByTestId("invoice-preview-record-payment")).toBeNull();
    expect(screen.queryByRole("button", { name: /Create Invoice|Save/ })).toBeNull();
  });
});
