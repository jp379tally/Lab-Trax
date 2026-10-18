/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceEditor } from "@/pages/invoices";
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
  tax: 0,
  discount: 0,
  notes: null,
  issuedAt: null,
  dueAt: null,
  items: [],
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

    const section = screen.getByRole("heading", { name: "Line items" }).closest("section");
    expect(section).not.toBeNull();
    const table = within(section as HTMLElement).getByRole("table");
    expect(table.style.width).toBe("718px");
    expect(table.querySelectorAll("thead th")).toHaveLength(7);
    expect(table.querySelectorAll("tfoot tr")).toHaveLength(4);

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
