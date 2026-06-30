/** @vitest-environment jsdom */
/**
 * Regression tests for the bulk invoice Delete / Reset feedback on the
 * desktop Invoices register.
 *
 * Bug: selecting invoices that span more than one lab org and clicking
 * "Delete selected" (or "Reset to $0") did nothing visible — the server
 * returned 200 with deletedCount/resetCount 0 (it only matched the single
 * labOrganizationId taken from data[0]), and the UI silently cleared the
 * selection and closed the modal, so it looked like the action just failed.
 *
 * Fixes verified here (client side):
 * - The whole selection (all selected ids, regardless of lab org) is sent to
 *   the bulk endpoint.
 * - When the server reports 0 affected, the modal STAYS OPEN and shows a
 *   warning ("No invoices were deleted/reset…") instead of silently closing.
 * - When the server reports a partial count, a "Only X of Y…" warning shows.
 * - When everything succeeds, the modal closes and selection is cleared with
 *   no feedback.
 *
 * jspdf / react-pdf are stubbed (heavy, non-jsdom-friendly at import time).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

const BILLING_USER = {
  id: "u-bill",
  username: "billing",
  role: "billing",
} as unknown as SessionUser;

// Two invoices belonging to two DIFFERENT lab orgs — this is the multi-org
// selection that triggered the silent no-op.
function makeInvoices(): Invoice[] {
  return [
    {
      id: "inv-a",
      invoiceNumber: "INV-A",
      caseId: null,
      labOrganizationId: "lab-1",
      providerOrganizationId: "prov-1",
      status: "open",
      total: 100,
      balanceDue: 100,
      items: [],
      displayMetadata: { patientName: "Alba", billTo: "Dr. Scott" },
    },
    {
      id: "inv-b",
      invoiceNumber: "INV-B",
      caseId: null,
      labOrganizationId: "lab-2",
      providerOrganizationId: "prov-2",
      status: "open",
      total: 50,
      balanceDue: 50,
      items: [],
      displayMetadata: { patientName: "Pam", billTo: "Dr. Dalton" },
    },
  ] as unknown as Invoice[];
}

type BulkCall = { url: string; method: string; body: unknown };

/**
 * Install a global fetch stub. `bulkResult` is the parsed body the bulk
 * delete/reset endpoint should return (it gets wrapped in the {ok,data}
 * envelope that apiFetch unwraps). Captured bulk calls are pushed to `calls`.
 */
function installFetch(bulkResult: Record<string, number>, calls: BulkCall[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.includes("/invoices/bulk")) {
        let body: unknown = null;
        try {
          body = init?.body ? JSON.parse(init.body as string) : null;
        } catch {
          body = init?.body;
        }
        calls.push({ url, method, body });
        return new Response(JSON.stringify({ ok: true, data: bulkResult }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/api/invoices") || url.includes("/api/invoices?")) {
        return new Response(JSON.stringify(makeInvoices()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // doctor-names, organizations, templates, everything else.
      if (url.includes("/cases/doctor-names")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/organizations")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}

async function selectAllAndOpenDelete() {
  // Wait for both invoices to render.
  await screen.findByText("INV-A");
  await screen.findByText("INV-B");

  // Header "Select all" checkbox is the first checkbox in the table head.
  const selectAll = screen.getByTitle(/select all/i);
  fireEvent.click(selectAll);

  // Bulk action bar appears.
  await screen.findByText(/2 invoices selected/i);
  fireEvent.click(screen.getByRole("button", { name: /Delete selected/i }));

  // Confirm modal.
  return await screen.findByRole("button", { name: /Delete invoices/i });
}

describe("Invoices bulk delete/reset — multi-org feedback", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the whole multi-org selection to the bulk endpoint", async () => {
    const calls: BulkCall[] = [];
    installFetch({ deletedCount: 2 }, calls);
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    const confirmBtn = await selectAllAndOpenDelete();
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/invoices/bulk");
    const body = calls[0]!.body as { invoiceIds?: string[] };
    expect(new Set(body.invoiceIds)).toEqual(new Set(["inv-a", "inv-b"]));
  });

  it("keeps the modal open with a warning when 0 invoices are deleted", async () => {
    installFetch({ deletedCount: 0 }, []);
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    const confirmBtn = await selectAllAndOpenDelete();
    fireEvent.click(confirmBtn);

    const feedback = await screen.findByTestId("bulk-invoice-feedback");
    expect(feedback.textContent).toMatch(/No invoices were deleted/i);
    // Modal stays open: the Cancel button relabels to "Close".
    expect(screen.getByRole("button", { name: /^Close$/ })).toBeInTheDocument();
  });

  it("shows a partial warning when only some invoices are deleted", async () => {
    installFetch({ deletedCount: 1 }, []);
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    const confirmBtn = await selectAllAndOpenDelete();
    fireEvent.click(confirmBtn);

    const feedback = await screen.findByTestId("bulk-invoice-feedback");
    expect(feedback.textContent).toMatch(/Only 1 of 2 selected invoices could be deleted/i);
  });

  it("closes the modal with no feedback when all invoices are deleted", async () => {
    installFetch({ deletedCount: 2 }, []);
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    const confirmBtn = await selectAllAndOpenDelete();
    fireEvent.click(confirmBtn);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Delete invoices/i })).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("bulk-invoice-feedback")).not.toBeInTheDocument();
  });
});
