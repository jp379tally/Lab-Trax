/** @vitest-environment jsdom */
/**
 * The Invoices Status filter is a multi-select checkbox dropdown (the same
 * MultiSelectFilter the Cases list uses), so a user can look at several
 * statuses at once and see the UNION of them. These tests pin what a
 * single-value <select> could never express and what a regression would break
 * silently: several checked statuses widening the list, the empty selection
 * meaning "All", the Clear action, the trigger summary label, combining with
 * search, rehydrating a legacy single-value `?status=` deep link, and pushing
 * the checked union to the server so the batched list restarts on it.
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

const INVOICES: Invoice[] = [
  {
    id: "inv-open",
    invoiceNumber: "INV-OPEN",
    status: "open",
    total: 100,
    balanceDue: 100,
    displayMetadata: { patientName: "Olive Open" },
  },
  {
    id: "inv-paid",
    invoiceNumber: "INV-PAID",
    status: "paid",
    total: 200,
    balanceDue: 50,
    displayMetadata: { patientName: "Pat Paid" },
  },
  {
    id: "inv-void",
    invoiceNumber: "INV-VOID",
    status: "void",
    total: 300,
    balanceDue: 300,
    displayMetadata: { patientName: "Vic Void" },
  },
  {
    id: "inv-partial",
    invoiceNumber: "INV-PARTIAL",
    status: "partially_paid",
    total: 400,
    balanceDue: 150,
    displayMetadata: { patientName: "Perry Partial" },
  },
].map((i) => ({
  ...i,
  caseId: null,
  labOrganizationId: "lab-1",
  providerOrganizationId: "prov-1",
  items: [],
})) as unknown as Invoice[];

function installFetch(onInvoiceUrl?: (url: string) => void) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/invoices") || url.includes("/api/invoices?")) {
        onInvoiceUrl?.(url);
        return new Response(JSON.stringify(INVOICES), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function statusTrigger() {
  return screen.getByTestId("invoices-status-filter");
}

function openStatusFilter() {
  const trigger = statusTrigger();
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
}

function toggleOption(name: RegExp | string) {
  openStatusFilter();
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name }));
}

async function renderInvoices() {
  const Wrapper = makeAuthWrapper("/invoices", {
    user: BILLING_USER,
    status: "authed",
  });
  render(
    <Wrapper>
      <InvoicesPage />
    </Wrapper>,
  );
  await screen.findByTestId("invoices-status-filter");
}

describe("Invoices — multi-select Status filter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/invoices");
    installFetch();
  });

  it("shows the union of several checked statuses", async () => {
    await renderInvoices();
    await screen.findByText("INV-OPEN");

    toggleOption(/^Paid$/);
    toggleOption(/^Void$/);

    await waitFor(() => {
      expect(screen.getByText("INV-PAID")).toBeInTheDocument();
      expect(screen.getByText("INV-VOID")).toBeInTheDocument();
      // Statuses that were never checked stay filtered out.
      expect(screen.queryByText("INV-OPEN")).not.toBeInTheDocument();
      expect(screen.queryByText("INV-PARTIAL")).not.toBeInTheDocument();
    });
  });

  it("summarizes the selection on the closed trigger (All / single label / N selected)", async () => {
    await renderInvoices();
    await screen.findByText("INV-OPEN");

    expect(statusTrigger()).toHaveTextContent("Status: All");

    toggleOption(/^Paid$/);
    expect(statusTrigger()).toHaveTextContent("Status: Paid");

    toggleOption(/^Void$/);
    expect(statusTrigger()).toHaveTextContent("Status: 2 selected");
  });

  it("Clear returns to All and shows every invoice again", async () => {
    await renderInvoices();
    await screen.findByText("INV-OPEN");

    toggleOption(/^Paid$/);
    toggleOption(/^Void$/);
    await waitFor(() => {
      expect(screen.queryByText("INV-OPEN")).not.toBeInTheDocument();
    });

    openStatusFilter();
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));

    await waitFor(() => {
      expect(statusTrigger()).toHaveTextContent("Status: All");
      expect(screen.getByText("INV-OPEN")).toBeInTheDocument();
      expect(screen.getByText("INV-PAID")).toBeInTheDocument();
      expect(screen.getByText("INV-VOID")).toBeInTheDocument();
      expect(screen.getByText("INV-PARTIAL")).toBeInTheDocument();
    });
  });

  it("uses Open exclusively and the explicit All choice clears it", async () => {
    await renderInvoices();
    await screen.findByText("INV-OPEN");

    toggleOption(/^Open$/);
    await waitFor(() => {
      expect(statusTrigger()).toHaveTextContent("Status: Open");
      expect(screen.getByText("INV-PARTIAL")).toBeInTheDocument();
      expect(screen.queryByText("INV-PAID")).not.toBeInTheDocument();
    });

    toggleOption(/^All$/);
    await waitFor(() => {
      expect(statusTrigger()).toHaveTextContent("Status: All");
      expect(screen.getByText("INV-PAID")).toBeInTheDocument();
      expect(screen.getByText("INV-VOID")).toBeInTheDocument();
    });
  });

  it("unchecking the last checked status also means All", async () => {
    await renderInvoices();
    await screen.findByText("INV-OPEN");

    toggleOption(/^Paid$/);
    await waitFor(() => {
      expect(screen.queryByText("INV-OPEN")).not.toBeInTheDocument();
    });

    toggleOption(/^Paid$/);

    await waitFor(() => {
      expect(statusTrigger()).toHaveTextContent("Status: All");
      expect(screen.getByText("INV-OPEN")).toBeInTheDocument();
    });
  });

  it("keeps the remaining status when one item is unchecked from a union", async () => {
    await renderInvoices();
    await screen.findByText("INV-OPEN");

    toggleOption(/^Paid$/);
    toggleOption(/^Void$/);
    toggleOption(/^Paid$/);

    await waitFor(() => {
      expect(statusTrigger()).toHaveTextContent("Status: Void");
      expect(screen.getByText("INV-VOID")).toBeInTheDocument();
      expect(screen.queryByText("INV-PAID")).not.toBeInTheDocument();
      expect(screen.queryByText("INV-OPEN")).not.toBeInTheDocument();
    });
  });

  it("combines with the search box (AND across filters)", async () => {
    await renderInvoices();
    await screen.findByText("INV-OPEN");

    toggleOption(/^Paid$/);
    toggleOption(/^Void$/);

    fireEvent.change(screen.getByPlaceholderText(/search invoice/i), {
      target: { value: "Vic" },
    });

    await waitFor(() => {
      expect(screen.getByText("INV-VOID")).toBeInTheDocument();
      // Matches the status union but not the search text.
      expect(screen.queryByText("INV-PAID")).not.toBeInTheDocument();
    });
  });

  it("pushes the whole checked union to the server", async () => {
    const invoiceUrls: string[] = [];
    vi.unstubAllGlobals();
    installFetch((url) => invoiceUrls.push(url));
    await renderInvoices();
    await screen.findByText("INV-OPEN");

    // The list is batched, so every status the user checks has to reach the
    // server: a partially downloaded set could never express the union.
    toggleOption(/^Paid$/);
    await waitFor(() => {
      expect(invoiceUrls[invoiceUrls.length - 1]).toMatch(/statuses=paid(&|$)/);
    });

    toggleOption(/^Void$/);
    await waitFor(() => {
      expect(
        decodeURIComponent(invoiceUrls[invoiceUrls.length - 1]),
      ).toMatch(/statuses=paid,void/);
    });
  });

  it("rehydrates a legacy single-value ?status= link and a comma-separated one", async () => {
    window.history.replaceState({}, "", "/invoices?status=paid");
    await renderInvoices();

    await waitFor(() => {
      expect(statusTrigger()).toHaveTextContent("Status: Paid");
      expect(screen.getByText("INV-PAID")).toBeInTheDocument();
      expect(screen.queryByText("INV-OPEN")).not.toBeInTheDocument();
    });
  });

  it("rehydrates the legacy ?status=open link as the exclusive Open view", async () => {
    window.history.replaceState({}, "", "/invoices?status=open");
    await renderInvoices();

    await waitFor(() => {
      expect(statusTrigger()).toHaveTextContent("Status: Open");
      expect(screen.getByText("INV-OPEN")).toBeInTheDocument();
      expect(screen.getByText("INV-PARTIAL")).toBeInTheDocument();
      expect(screen.queryByText("INV-PAID")).not.toBeInTheDocument();
      expect(window.location.search).toContain("view=open");
      expect(window.location.search).not.toContain("status=");
    });
  });

  it("rehydrates a multi-value ?status= link", async () => {
    window.history.replaceState({}, "", "/invoices?status=paid,void");
    await renderInvoices();

    await waitFor(() => {
      expect(statusTrigger()).toHaveTextContent("Status: 2 selected");
      expect(screen.getByText("INV-PAID")).toBeInTheDocument();
      expect(screen.getByText("INV-VOID")).toBeInTheDocument();
      expect(screen.queryByText("INV-OPEN")).not.toBeInTheDocument();
    });
  });

  it("writes the checked statuses back to the URL", async () => {
    await renderInvoices();
    await screen.findByText("INV-OPEN");

    toggleOption(/^Paid$/);
    toggleOption(/^Void$/);

    await waitFor(() => {
      expect(decodeURIComponent(window.location.search)).toContain(
        "status=paid,void",
      );
    });
  });
});
