/** @vitest-environment jsdom */
/**
 * Regression test: the "$0 balance" invoice status filter must list every
 * invoice whose remaining balance is exactly $0.00, regardless of status,
 * and must NOT be suppressed by the Open/All view toggle.
 *
 * Invariants protected:
 * - Selecting "$0 balance" shows only rows with numeric balanceDue === 0.
 * - It is distinct from "Paid": a zero-balance void/draft invoice appears,
 *   and a paid invoice with a positive balance does not.
 * - The Open toggle does not narrow the fetched dataset when "$0 balance"
 *   is selected (the fetch must request the full invoice set).
 *
 * jspdf / react-pdf are stubbed (heavy, non-jsdom-friendly at import time).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

const INVOICES: Invoice[] = [
  {
    id: "inv-open-pos",
    invoiceNumber: "INV-OPEN-POS",
    status: "open",
    total: 100,
    balanceDue: 100,
    displayMetadata: { patientName: "Open Positive" },
  },
  {
    id: "inv-paid-zero",
    invoiceNumber: "INV-PAID-ZERO",
    status: "paid",
    total: 100,
    balanceDue: 0,
    displayMetadata: { patientName: "Paid Zero" },
  },
  {
    id: "inv-void-zero",
    invoiceNumber: "INV-VOID-ZERO",
    status: "void",
    total: 100,
    balanceDue: 0,
    displayMetadata: { patientName: "Void Zero" },
  },
  {
    id: "inv-partial-pos",
    invoiceNumber: "INV-PARTIAL-POS",
    status: "partially_paid",
    total: 100,
    balanceDue: 40,
    displayMetadata: { patientName: "Partial Positive" },
  },
].map((i) => ({
  ...i,
  caseId: null,
  labOrganizationId: "lab-1",
  providerOrganizationId: "prov-1",
  items: [],
})) as unknown as Invoice[];

function installFetch(invoices: Invoice[], onInvoiceUrl?: (url: string) => void) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/invoices") || url.includes("/api/invoices?")) {
        onInvoiceUrl?.(url);
        return new Response(JSON.stringify(invoices), {
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

async function selectStatus(value: string) {
  const zeroOption = await screen.findByRole("option", { name: "$0 balance" });
  const statusSelect = zeroOption.closest("select");
  if (!statusSelect) throw new Error("status dropdown not found");
  fireEvent.change(statusSelect, { target: { value } });
}

describe("Invoices $0 balance filter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/invoices");
  });

  it("shows only zero-balance invoices regardless of status", async () => {
    installFetch(INVOICES);
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    await screen.findByText("INV-OPEN-POS");

    // Switch to the All view so the status dropdown is available.
    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    await selectStatus("zero_balance");

    // Zero-balance paid and void invoices appear.
    expect(await screen.findByText("INV-PAID-ZERO")).toBeInTheDocument();
    expect(screen.getByText("INV-VOID-ZERO")).toBeInTheDocument();
    // Positive-balance invoices (open, partial) do not.
    expect(screen.queryByText("INV-OPEN-POS")).not.toBeInTheDocument();
    expect(screen.queryByText("INV-PARTIAL-POS")).not.toBeInTheDocument();
  });

  it("is not suppressed by the Open toggle and fetches the full invoice set", async () => {
    const invoiceUrls: string[] = [];
    installFetch(INVOICES, (url) => invoiceUrls.push(url));
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    await screen.findByText("INV-OPEN-POS");

    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    await selectStatus("zero_balance");
    await screen.findByText("INV-PAID-ZERO");

    // Now toggle Open. Zero-balance non-open rows must still be visible, and
    // the fetch must not narrow to status=open.
    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));

    expect(await screen.findByText("INV-VOID-ZERO")).toBeInTheDocument();
    expect(screen.getByText("INV-PAID-ZERO")).toBeInTheDocument();
    expect(screen.queryByText("INV-OPEN-POS")).not.toBeInTheDocument();

    // No invoice request should have carried status=open while $0 balance is active.
    const lastUrl = invoiceUrls[invoiceUrls.length - 1];
    expect(lastUrl).not.toMatch(/status=open/);
  });
});
