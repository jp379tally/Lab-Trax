/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineInvoiceEditor, InvoiceEditor } from "@/pages/invoices";
import type { Invoice } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const invoice: Invoice = {
  id: "layout-invoice",
  invoiceNumber: "INV-LAYOUT",
  caseId: "layout-case",
  labOrganizationId: "lab-1",
  providerOrganizationId: "prov-1",
  status: "open",
  tax: 10,
  discount: 0,
  notes: null,
  issuedAt: null,
  dueAt: null,
  items: [],
  payments: [{ amount: 7 }],
  displayMetadata: { patientName: "Jane Doe", billTo: "Dr. Synthetic063" },
} as unknown as Invoice;

const widthKey = "labtrax_invoice_panel_width_v1";
const maximizedKey = "labtrax_invoice_panel_maximized_v1";

beforeEach(() => {
  localStorage.removeItem(widthKey);
  localStorage.removeItem(maximizedKey);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(`/invoices/${invoice.id}`)) {
        return new Response(JSON.stringify(invoice), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/invoice-template/presets")) {
        return new Response(JSON.stringify({ presets: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/attachments")) {
        return new Response(JSON.stringify({ attachments: [] }), {
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InvoiceEditor fitted line-item layout", () => {
  it("uses the reference invoice-information heading and keeps inline desktop rows in the table", async () => {
    const Wrapper = makeAuthWrapper("/cases");
    const view = render(
      <Wrapper>
        <InlineInvoiceEditor
          invoice={invoice}
          doctorNames={[]}
          onClose={vi.fn()}
          onOpenEditor={vi.fn()}
        />
      </Wrapper>,
    );

    expect(
      await screen.findByRole("heading", { name: "Invoice information" }),
    ).toBeInTheDocument();
    const table = view.container.querySelector(".inline-invoice .invoice-lines");
    expect(table).not.toBeNull();
    expect(
      view.container.querySelector(".inline-invoice .invoice-lines-container"),
    ).not.toBeNull();
    expect(table?.querySelectorAll("thead th")).toHaveLength(8);
    expect(
      view.container.querySelector(".invoice-editor-action-bar button")?.textContent,
    ).toContain("Save invoice");
  });

  it("keeps the AI-import review notice visible and retryable after acknowledgment fails", async () => {
    const importedInvoice = {
      ...invoice,
      id: "layout-ai-invoice",
      aiGenerated: true,
      aiReviewedAt: null,
      aiPricingWarning: "Confirm the extracted prices.",
    } as unknown as Invoice;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let reviewRequestCount = 0;
    let persistedInvoice = importedInvoice;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        requests.push({ url, init });
        if (url.includes("/ai-review")) {
          reviewRequestCount += 1;
          if (reviewRequestCount === 1) {
            return new Response(JSON.stringify({ message: "Review service unavailable." }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }
          persistedInvoice = {
            ...importedInvoice,
            aiReviewedAt: "2026-10-25T18:30:00.000Z",
            aiReviewedByUserId: "reviewer-1",
            aiReviewedByName: "Jamie Reviewer",
          } as unknown as Invoice;
          return new Response(JSON.stringify(persistedInvoice), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes(`/invoices/${importedInvoice.id}`)) {
          return new Response(JSON.stringify(persistedInvoice), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/invoice-template/presets")) {
          return new Response(JSON.stringify({ presets: [] }), { status: 200 });
        }
        if (url.includes("/attachments")) {
          return new Response(JSON.stringify({ attachments: [] }), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }),
    );

    const Wrapper = makeAuthWrapper("/invoices");
    render(
      <Wrapper>
        <InvoiceEditor invoice={importedInvoice} doctorNames={[]} onClose={vi.fn()} />
      </Wrapper>,
    );
    expect(await screen.findByText("AI-imported invoice — please review")).toBeInTheDocument();
    expect(screen.getByText("Confirm the extracted prices.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Review service unavailable. You can try again from this notice.",
    );
    expect(screen.getByText("AI-imported invoice — please review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() =>
      expect(screen.queryByText("AI-imported invoice — please review")).not.toBeInTheDocument(),
    );
    expect(await screen.findByTestId("invoice-ai-review-record")).toHaveTextContent(
      "Reviewed by Jamie Reviewer",
    );
    expect(screen.queryByText(/You can try again from this notice/)).not.toBeInTheDocument();
    expect(reviewRequestCount).toBe(2);
    expect(requests.filter((request) => request.url.includes("/ai-review"))).toEqual([
      expect.objectContaining({
        url: expect.stringContaining(`/invoices/${importedInvoice.id}/ai-review`),
        init: expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ acknowledged: true }),
        }),
      }),
      expect.objectContaining({
        url: expect.stringContaining(`/invoices/${importedInvoice.id}/ai-review`),
        init: expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ acknowledged: true }),
        }),
      }),
    ]);
  });

  it("shows who reviewed an AI-imported invoice and when", async () => {
    const reviewedInvoice = {
      ...invoice,
      id: "layout-reviewed-ai-invoice",
      aiGenerated: true,
      aiReviewedAt: "2026-10-25T18:30:00.000Z",
      aiReviewedByUserId: "reviewer-1",
      aiReviewedByName: "Jamie Reviewer",
    } as unknown as Invoice;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes(`/invoices/${reviewedInvoice.id}`)) {
          return new Response(JSON.stringify(reviewedInvoice), { status: 200 });
        }
        if (url.includes("/invoice-template/presets")) {
          return new Response(JSON.stringify({ presets: [] }), { status: 200 });
        }
        if (url.includes("/attachments")) {
          return new Response(JSON.stringify({ attachments: [] }), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }),
    );

    const Wrapper = makeAuthWrapper("/invoices");
    render(
      <Wrapper>
        <InvoiceEditor invoice={reviewedInvoice} doctorNames={[]} onClose={vi.fn()} />
      </Wrapper>,
    );

    const reviewRecord = await screen.findByTestId("invoice-ai-review-record");
    expect(reviewRecord).toHaveTextContent("Reviewed by Jamie Reviewer");
    expect(reviewRecord).toHaveTextContent(/10\/25\/2026/);
    expect(reviewRecord).toHaveTextContent(/(?:AM|PM)/);
  });

  it("fits the real table and totals at narrow and wide widths, with a working maximize toggle", async () => {
    let containerWidth = 718;
    let resizeObserverCallback: ResizeObserverCallback | null = null;
    let observedElement: Element | null = null;
    class ResizeObserverMock {
      constructor(private readonly callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
      }
      observe(target: Element) {
        observedElement = target;
        Object.defineProperty(target, "clientWidth", {
          configurable: true,
          get: () => containerWidth,
        });
        this.callback(
          [{ target, contentRect: { width: containerWidth } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    const Wrapper = makeAuthWrapper("/invoices");
    const view = render(
      <Wrapper>
        <InvoiceEditor invoice={invoice} doctorNames={[]} onClose={vi.fn()} />
      </Wrapper>,
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Line items" })).toBeInTheDocument(),
    );
    const shareNotesSwitch = screen.getByRole("switch", {
      name: "Share with Provider",
    });
    expect(shareNotesSwitch).not.toBeChecked();
    expect(view.container.querySelector(".invoice-editor-action-bar")).not.toBeNull();
    await waitFor(() =>
      expect(screen.queryByText("Loading invoice…")).not.toBeInTheDocument(),
    );
    fireEvent.click(shareNotesSwitch);
    expect(shareNotesSwitch).toBeChecked();

    const section = screen.getByRole("heading", { name: "Line items" }).closest("section");
    expect(section).not.toBeNull();
    const table = within(section as HTMLElement).getByRole("table");
    expect(table.style.width).toBe("718px");
    expect(table.querySelectorAll("thead th")).toHaveLength(7);
    expect(table.querySelectorAll("tfoot tr")).toHaveLength(0);
    const columns = view.container.querySelector(".invoice-editor-columns");
    const summary = columns?.querySelector(".invoice-editor-summary");
    expect(columns?.querySelector(".invoice-editor-main")).not.toBeNull();
    expect(columns?.querySelector(".invoice-editor-sidebar")).not.toBeNull();
    expect(within(summary as HTMLElement).getByText("Invoice summary")).toBeInTheDocument();
    expect(within(summary as HTMLElement).getByText("Balance due")).toBeInTheDocument();
    expect(within(columns as HTMLElement).getByText("Prescription reference")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Loading invoice…")).not.toBeInTheDocument());
    fireEvent.change(screen.getByRole("spinbutton", { name: "Tax" }), {
      target: { value: "12" },
    });
    await waitFor(() =>
      expect(summary?.querySelector(".invoice-editor-summary-total")?.textContent)
        .toContain("$12.00"),
    );
    expect(summary?.querySelector(".invoice-editor-summary-balance")?.textContent)
      .toContain("$5.00");

    const maximize = screen.getByRole("button", {
      name: "Expand invoice panel to full width",
    });
    fireEvent.click(maximize);
    const panel = view.container.querySelector(".fixed.inset-0.z-50 > div") as HTMLElement;
    expect(panel.style.width).toBe("100vw");

    const observerTarget = section?.querySelector("div.border.border-border") as Element;
    expect(observedElement).toBe(observerTarget);
    containerWidth = 1240;
    act(() => {
      Object.defineProperty(observerTarget, "clientWidth", {
        configurable: true,
        get: () => containerWidth,
      });
      resizeObserverCallback?.(
        [{ target: observerTarget, contentRect: { width: containerWidth } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    expect(table.style.width).toBe("1240px");
    expect(table.querySelectorAll("col")).toHaveLength(7);
    expect(panel.querySelector("header")?.className).toContain("sticky");

    fireEvent.click(screen.getByRole("button", { name: "Restore invoice panel width" }));
    expect(panel.style.width).toBe("768px");
  });
});
