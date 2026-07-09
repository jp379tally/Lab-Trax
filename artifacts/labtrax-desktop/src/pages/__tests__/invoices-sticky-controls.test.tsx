/** @vitest-environment jsdom */
/**
 * Regression test: the invoice filter row and bulk action bar must stay
 * visible while the invoice list scrolls (Task: pinned invoice controls).
 *
 * Invariants protected:
 * - The search/filter row and the bulk action bar are rendered inside a
 *   single sticky group (`position: sticky; top: 0`) with a solid background
 *   and a z-index above the table rows, so they pin to the top of the app's
 *   scroll container instead of scrolling away.
 * - No ancestor between the sticky group and the scroll container clips it
 *   with `overflow-hidden` (that silently disables stickiness).
 * - With a long list and a selection, the bulk action buttons inside the
 *   sticky group remain rendered and interactive.
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

function makeManyInvoices(count: number): Invoice[] {
  return Array.from({ length: count }, (_, n) => ({
    id: `inv-${n}`,
    invoiceNumber: `INV-${String(n).padStart(3, "0")}`,
    caseId: null,
    labOrganizationId: "lab-1",
    providerOrganizationId: "prov-1",
    status: "open",
    total: 100,
    balanceDue: 100,
    items: [],
    displayMetadata: { patientName: `Patient ${n}`, billTo: "Dr. Scott" },
  })) as unknown as Invoice[];
}

function installFetch(invoices: Invoice[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/invoices") || url.includes("/api/invoices?")) {
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

describe("Invoices sticky filter/bulk controls", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the filter row inside a sticky, solid-background group that no ancestor clips", async () => {
    installFetch(makeManyInvoices(60));
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    await screen.findByText("INV-000");

    const controls = screen.getByTestId("invoice-controls");
    // Pinned: sticky against the app's scroll container, above table rows,
    // with a solid background so rows can't bleed through.
    expect(controls.className).toMatch(/\bsticky\b/);
    expect(controls.className).toMatch(/\btop-0\b/);
    expect(controls.className).toMatch(/\bz-\d+/);
    expect(controls.className).toMatch(/\bbg-card\b/);

    // The filter row lives inside the sticky group.
    expect(controls.contains(screen.getByPlaceholderText(/search invoice/i))).toBe(true);
    expect(controls.contains(screen.getByRole("button", { name: /statements/i }))).toBe(true);

    // No ancestor may clip the sticky group with overflow-hidden, or
    // position:sticky silently stops working.
    for (let el = controls.parentElement; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/\boverflow-hidden\b/);
    }
  });

  it("keeps the bulk action bar inside the sticky group and interactive with a large selection", async () => {
    installFetch(makeManyInvoices(60));
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    await screen.findByText("INV-000");
    fireEvent.click(screen.getByTitle(/select all/i));
    await screen.findByText(/60 invoices selected/i);

    const controls = screen.getByTestId("invoice-controls");
    const sendBtn = screen.getByRole("button", { name: /send 60 invoices/i });
    expect(controls.contains(sendBtn)).toBe(true);
    expect(controls.contains(screen.getByRole("button", { name: /delete selected/i }))).toBe(true);
    expect(controls.contains(screen.getByRole("button", { name: /^Reset to \$0$/i }))).toBe(true);
    expect(controls.contains(screen.getByRole("button", { name: /reset all to \$0/i }))).toBe(true);
    expect(controls.contains(screen.getByLabelText(/change status/i))).toBe(true);
    expect(controls.contains(screen.getByRole("button", { name: /clear selection/i }))).toBe(true);

    // Buttons in the pinned bar stay interactive.
    fireEvent.click(screen.getByRole("button", { name: /clear selection/i }));
    expect(screen.queryByText(/60 invoices selected/i)).not.toBeInTheDocument();
  });
});
