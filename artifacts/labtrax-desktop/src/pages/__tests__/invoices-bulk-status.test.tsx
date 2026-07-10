/** @vitest-environment jsdom */
/**
 * Tests for the bulk "Change status" action on the desktop Invoices register.
 *
 * Verified here (client side):
 * - The "Change status…" control only appears once invoices are selected (and
 *   only for a billing user).
 * - Picking a non-financial status (e.g. Draft) applies immediately, POSTing
 *   the whole selection + target status to /invoices/bulk-status.
 * - Picking a financially meaningful status (Void / Paid) opens a confirmation
 *   modal first; the request only fires after confirming.
 * - When the server reports 0 updated, the modal stays open with a warning.
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
      labOrganizationId: "lab-1",
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

function installFetch(bulkResult: Record<string, unknown>, calls: BulkCall[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.includes("/invoices/bulk-status")) {
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

async function selectAll() {
  await screen.findByText("INV-A");
  await screen.findByText("INV-B");
  fireEvent.click(screen.getByTitle(/select all/i));
  await screen.findByText(/2 invoices selected/i);
}

describe("Invoices bulk change-status", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides the Change status control until invoices are selected", async () => {
    installFetch({ updatedCount: 0 }, []);
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    await screen.findByText("INV-A");
    expect(screen.queryByLabelText(/change status/i)).not.toBeInTheDocument();

    await selectAll();
    expect(screen.getByLabelText(/change status/i)).toBeInTheDocument();
  });

  it("applies open status immediately without confirmation", async () => {
    const calls: BulkCall[] = [];
    installFetch({ updatedCount: 2, skippedFrozenCount: 0, status: "open" }, calls);
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    await selectAll();
    fireEvent.change(screen.getByLabelText(/change status/i), { target: { value: "open" } });

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/invoices/bulk-status");
    const body = calls[0]!.body as { invoiceIds?: string[]; status?: string };
    expect(new Set(body.invoiceIds)).toEqual(new Set(["inv-a", "inv-b"]));
    expect(body.status).toBe("open");
  });

  it("requires confirmation before applying a financial status (void)", async () => {
    const calls: BulkCall[] = [];
    installFetch({ updatedCount: 2, skippedFrozenCount: 0, status: "void" }, calls);
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    await selectAll();
    fireEvent.change(screen.getByLabelText(/change status/i), { target: { value: "void" } });

    // No request yet — a confirmation modal must appear first.
    expect(calls.length).toBe(0);
    const confirmBtn = await screen.findByRole("button", { name: /^Mark as/i });

    fireEvent.click(confirmBtn);

    await waitFor(() => expect(calls.length).toBe(1));
    const body = calls[0]!.body as { invoiceIds?: string[]; status?: string };
    expect(body.status).toBe("void");
    expect(new Set(body.invoiceIds)).toEqual(new Set(["inv-a", "inv-b"]));
  });

  it("keeps the confirm modal open with a warning when 0 invoices are updated", async () => {
    installFetch({ updatedCount: 0, skippedFrozenCount: 2, status: "void" }, []);
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    await selectAll();
    fireEvent.change(screen.getByLabelText(/change status/i), { target: { value: "void" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Mark as/i }));

    const feedback = await screen.findByTestId("bulk-invoice-feedback");
    expect(feedback.textContent).toMatch(/No invoices were updated/i);
    expect(screen.getByRole("button", { name: /^Close$/ })).toBeInTheDocument();
  });
});
