/** @vitest-environment jsdom */
/**
 * Regression tests: the "Outstanding" invoice view must show only open /
 * partially-paid invoices whose due date is in the past, must take precedence
 * over any previously-selected status (including "Zero balance"), and must
 * not send overdue-bucket query params to the server.
 *
 * Also verifies that ?view=outstanding in the URL correctly initialises the
 * view on first mount (deep-link / reload).
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

// Yesterday — reliably in the past regardless of timezone
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
// Tomorrow — reliably in the future
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

const INVOICES: Invoice[] = [
  // ✅ should appear in Outstanding: open + past due
  {
    id: "inv-open-past",
    invoiceNumber: "INV-OPEN-PAST",
    status: "open",
    total: 100,
    balanceDue: 100,
    dueAt: YESTERDAY,
    displayMetadata: { patientName: "Open Past Due" },
  },
  // ✅ should appear in Outstanding: partially_paid + past due
  {
    id: "inv-partial-past",
    invoiceNumber: "INV-PARTIAL-PAST",
    status: "partially_paid",
    total: 100,
    balanceDue: 40,
    dueAt: YESTERDAY,
    displayMetadata: { patientName: "Partial Past Due" },
  },
  // ❌ open but due tomorrow — should NOT appear in Outstanding
  {
    id: "inv-open-future",
    invoiceNumber: "INV-OPEN-FUTURE",
    status: "open",
    total: 100,
    balanceDue: 100,
    dueAt: TOMORROW,
    displayMetadata: { patientName: "Open Future Due" },
  },
  // ❌ paid + past due — should NOT appear in Outstanding (wrong status)
  {
    id: "inv-paid-past",
    invoiceNumber: "INV-PAID-PAST",
    status: "paid",
    total: 100,
    balanceDue: 0,
    dueAt: YESTERDAY,
    displayMetadata: { patientName: "Paid Past Due" },
  },
  // ❌ open + no due date — should NOT appear in Outstanding
  {
    id: "inv-open-nodue",
    invoiceNumber: "INV-OPEN-NODUE",
    status: "open",
    total: 100,
    balanceDue: 100,
    dueAt: null,
    displayMetadata: { patientName: "Open No Due" },
  },
  // zero-balance open (past due) — to test zero_balance↔outstanding interaction
  {
    id: "inv-open-zero",
    invoiceNumber: "INV-OPEN-ZERO",
    status: "open",
    total: 0,
    balanceDue: 0,
    dueAt: YESTERDAY,
    displayMetadata: { patientName: "Open Zero Balance" },
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

async function selectOutstanding() {
  const trigger = screen.getByTestId("invoices-status-filter");
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /^outstanding$/i }));
}

describe("Invoices Outstanding filter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/invoices");
  });

  it("shows only open/partially_paid + past-due invoices", async () => {
    installFetch(INVOICES);
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    await screen.findByText("INV-OPEN-PAST");
    await selectOutstanding();

    expect(await screen.findByText("INV-OPEN-PAST")).toBeInTheDocument();
    expect(screen.getByText("INV-PARTIAL-PAST")).toBeInTheDocument();

    // Future due date, wrong status, or no due date — must all be excluded
    expect(screen.queryByText("INV-OPEN-FUTURE")).not.toBeInTheDocument();
    expect(screen.queryByText("INV-PAID-PAST")).not.toBeInTheDocument();
    expect(screen.queryByText("INV-OPEN-NODUE")).not.toBeInTheDocument();
  });

  it("takes precedence over a previously-selected Zero balance status", async () => {
    installFetch(INVOICES);
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    // Wait for initial load.
    await screen.findByText("INV-OPEN-PAST");

    // Check "$0 balance" in the multi-select Status dropdown
    fireEvent.click(await screen.findByTestId("invoices-status-filter"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^\$0 balance$/ }));

    // Confirm zero-balance row is visible before switching
    await screen.findByText("INV-OPEN-ZERO");

    // Now switch to Outstanding — should override the zero_balance status
    await selectOutstanding();

    // Open past-due invoices should appear (INV-OPEN-PAST has positive balance so shows)
    expect(await screen.findByText("INV-OPEN-PAST")).toBeInTheDocument();
    expect(screen.getByText("INV-PARTIAL-PAST")).toBeInTheDocument();
    // Zero-balance open past-due invoices are not outstanding.
    expect(screen.queryByText("INV-OPEN-ZERO")).not.toBeInTheDocument();
    // Paid past-due must stay hidden even though it passed zero_balance before
    expect(screen.queryByText("INV-PAID-PAST")).not.toBeInTheDocument();
  });

  it("does not include overdue-bucket params in the API request when Outstanding is active", async () => {
    const invoiceUrls: string[] = [];
    installFetch(INVOICES, (url) => invoiceUrls.push(url));
    const Wrapper = makeAuthWrapper("/invoices", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    await screen.findByText("INV-OPEN-PAST");
    await selectOutstanding();

    await waitFor(() => {
      const last = invoiceUrls[invoiceUrls.length - 1];
      expect(last).not.toMatch(/overdueBucket/);
      expect(last).not.toMatch(/dueDateFrom/);
      expect(last).not.toMatch(/dueDateTo/);
    });
  });

  it("initialises to the Outstanding view when ?view=outstanding is in the URL", async () => {
    window.history.replaceState({}, "", "/invoices?view=outstanding");
    installFetch(INVOICES);
    const Wrapper = makeAuthWrapper("/invoices?view=outstanding", { user: BILLING_USER, status: "authed" });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    // Only past-due open/partially_paid rows should be visible on first render
    expect(await screen.findByText("INV-OPEN-PAST")).toBeInTheDocument();
    expect(screen.getByText("INV-PARTIAL-PAST")).toBeInTheDocument();

    expect(screen.queryByText("INV-OPEN-FUTURE")).not.toBeInTheDocument();
    expect(screen.queryByText("INV-PAID-PAST")).not.toBeInTheDocument();
    expect(screen.queryByText("INV-OPEN-NODUE")).not.toBeInTheDocument();

    expect(screen.getByTestId("invoices-status-filter")).toHaveTextContent("Status: Outstanding");
    expect(screen.queryByRole("button", { name: /^all$/i })).not.toBeInTheDocument();
  });
});
