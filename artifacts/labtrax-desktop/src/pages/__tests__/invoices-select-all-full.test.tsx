/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function inv(i: number, status = "open"): Invoice {
  return {
    id: `invoice-${i}`, invoiceNumber: `INV-${String(i).padStart(3, "0")}`, status, total: 10,
    balanceDue: status === "paid" ? 0 : 10, labOrganizationId: "lab-1", providerOrganizationId: "practice-1",
    caseId: null, createdAt: new Date(2025, 0, 31 - i).toISOString(), items: [],
  } as unknown as Invoice;
}

type Hooks = { onList?: (url: string, init?: RequestInit) => Promise<Response> | null; writes: string[] };
function install(all: Invoice[], hooks: Hooks) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (init?.method && init.method !== "GET" && url.includes("/invoices")) { hooks.writes.push(`${init.method} ${url} ${String(init.body ?? "")}`); return json({ updatedCount: 0 }); }
    if (url.includes("/api/invoices?")) {
      const held = hooks.onList?.(url, init);
      if (held) return held;
      const p = new URL(url, "http://localhost").searchParams;
      const limit = Number(p.get("limit")); const off = Number(p.get("offset") ?? 0);
      const rows = all.slice(off, off + limit);
      return json({ rows, total: all.length, limit, offset: off, hasMore: off + rows.length < all.length, summary });
    }
    if (url.includes("/organizations")) return json([{ id: "lab-1", name: "Lab One", type: "lab" }]);
    return json([]);
  }));
}
function mount() {
  const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed", restoreStatus: "ok", restoreNoticeDismissed: true });
  render(<Wrapper><InvoicesPage /></Wrapper>);
}
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe("full-set Select all", () => {
  it("fetches every matching invoice in bounded requests and Send captures all 31", async () => {
    const urls: string[] = [];
    install(Array.from({ length: 31 }, (_, i) => inv(i)), { writes: [], onList: (u) => { urls.push(u); return null; } });
    mount();
    await screen.findByText("INV-000");
    fireEvent.click(screen.getByTestId("invoice-select-all"));
    await waitFor(() => expect(screen.getByText("31 invoices selected")).toBeInTheDocument());
    expect(urls.filter((u) => u.includes("limit=100")).length).toBeGreaterThan(0);
    expect(urls.every((u) => Number(new URL(u, "http://x").searchParams.get("limit")) <= 100)).toBe(true);
    expect(screen.getByTestId("invoice-select-all")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /Send 31 invoices/ }));
    expect(await screen.findByText(/and 26 more/)).toBeInTheDocument();
  });

  it("status change guard counts Paid invoices that are off the visible page", async () => {
    const all = Array.from({ length: 31 }, (_, i) => inv(i, i >= 28 ? "paid" : "open"));
    install(all, { writes: [] });
    mount();
    await screen.findByText("INV-000");
    fireEvent.click(screen.getByTestId("invoice-select-all"));
    await screen.findByText("31 invoices selected");
    fireEvent.change(screen.getByLabelText("Change status"), { target: { value: "open" } });
    expect(await screen.findByText(/3 of the 31 selected invoices/)).toBeInTheDocument();
  });

  it("draft and recovery_draft rows are read-only and never selected or written", async () => {
    const writes: string[] = [];
    install([inv(0, "draft"), inv(1, "recovery_draft"), inv(2), inv(3)], { writes });
    mount();
    await screen.findByText("INV-002");
    expect(screen.getByLabelText("Select invoice INV-000")).toBeDisabled();
    expect(screen.getByLabelText("Select invoice INV-001")).toBeDisabled();
    expect(screen.queryByTestId("invoice-edit-invoice-0")).toBeNull();
    expect(screen.queryByTestId("invoice-edit-invoice-1")).toBeNull();
    expect(screen.queryByTestId("invoice-edit-invoice-2")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("Select invoice INV-000"));
    expect(screen.queryByTestId("invoice-bulk-controls")).toBeNull();
    fireEvent.click(screen.getByTestId("invoice-select-all"));
    await screen.findByText("2 invoices selected");
    expect(screen.getByTestId("invoice-select-all-excluded")).toHaveTextContent(/2 draft invoices were not selected/);
    expect(writes).toEqual([]);
  });

  it("changing filters mid-selection aborts the fetch and applies no stale selection", async () => {
    let release: () => void = () => {};
    let aborted = false;
    install(Array.from({ length: 150 }, (_, i) => inv(i)), {
      writes: [],
      onList: (u, init) => {
        const p = new URL(u, "http://x").searchParams;
        if (p.get("limit") !== "100" || p.get("offset") !== "100") return null;
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
          release = () => resolve(new Response(JSON.stringify({ rows: [], total: 150, limit: 100, offset: 100, hasMore: false }), { status: 200 }));
        });
      },
    });
    mount();
    await screen.findByText("INV-000");
    fireEvent.click(screen.getByTestId("invoice-select-all"));
    await screen.findByTestId("invoice-select-all-status");
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "zzz" } });
    await waitFor(() => expect(aborted).toBe(true));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("invoice-bulk-controls")).toBeNull();
    expect(screen.queryByTestId("invoice-select-all-excluded")).toBeNull();
  });
});
