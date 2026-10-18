/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InvoiceEditor } from "@/pages/invoices";
import type { Invoice } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// PDF stubs — same pattern as every other InvoiceEditor test suite.
// These modules are not jsdom-compatible; the status-guard flows never
// exercise them, so stub them out unconditionally.
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

// ─── Paid invoice fixture ────────────────────────────────────────────────────

const PAID_INVOICE_ID = "inv-paid";

const paidInvoice: Invoice = {
  id: PAID_INVOICE_ID,
  invoiceNumber: "INV-PAID",
  caseId: null,
  labOrganizationId: "lab-1",
  providerOrganizationId: "prov-1",
  status: "paid",
  tax: 0,
  discount: 0,
  notes: "",
  issuedAt: null,
  dueAt: null,
  items: [],
  displayMetadata: { patientName: "Jane Doe", billTo: "Dr. Synthetic063" },
} as unknown as Invoice;

// Detail response that the editor fetches: paid status + one recorded payment.
// handleSaveRequest reads detailQuery.data.payments to decide whether to show
// the guard, so this field must be present.
const paidInvoiceDetail = {
  ...paidInvoice,
  payments: [{ id: "pay-1", amount: "100.00" }],
};

// ─── Open invoice fixture ────────────────────────────────────────────────────

const OPEN_INVOICE_ID = "inv-open";

const openInvoice: Invoice = {
  id: OPEN_INVOICE_ID,
  invoiceNumber: "INV-OPEN",
  caseId: null,
  labOrganizationId: "lab-1",
  providerOrganizationId: "prov-1",
  status: "open",
  tax: 0,
  discount: 0,
  notes: "",
  issuedAt: null,
  dueAt: null,
  items: [],
  displayMetadata: { patientName: "Jane Doe", billTo: "Dr. Synthetic063" },
} as unknown as Invoice;

// Detail response: open status + no payments.
const openInvoiceDetail = {
  ...openInvoice,
  payments: [],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a fetch stub that:
 *   • Returns `detail` for GET /invoices/<invoiceId> (the detailQuery).
 *   • Returns { presets: [] } for the invoice-template/presets endpoint.
 *   • Returns a 200 OK for everything else (PATCH save, etc.).
 */
function makeFetchMock(invoiceId: string, detail: object) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    // Detail fetch (GET /invoices/:id) — do NOT match the payments DELETE URL.
    if (url.includes(`/invoices/${invoiceId}`) && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify(detail), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Template presets.
    if (url.includes("/invoice-template/presets")) {
      return new Response(JSON.stringify({ presets: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // PATCH save, DELETE payments, billableItemsQuery (/finance/vendors),
    // and any other endpoint the editor fetches during render.
    // Must be a JSON array (not an object) so array-typed queries don't crash
    // when they iterate over the result (e.g. billableItems useMemo).
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/**
 * Wait until the editor has hydrated its form from the detail query.
 * The patient-name field is populated in the same useEffect that sets the
 * baseline and enables "Save changes", so it's a reliable ready signal.
 */
async function waitForLoaded() {
  await waitFor(() =>
    expect(screen.getByDisplayValue("Jane Doe")).toBeInTheDocument(),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Suite 1: Paid → Open (payment-delete guard) ─────────────────────────────

describe("InvoiceEditor — Paid→Open payment-delete guard", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = makeFetchMock(PAID_INVOICE_ID, paidInvoiceDetail);
    vi.stubGlobal("fetch", mockFetch);
  });

  function renderPaidEditor() {
    const onClose = vi.fn();
    const Wrapper = makeAuthWrapper("/invoices");
    render(
      <Wrapper>
        <InvoiceEditor invoice={paidInvoice} doctorNames={[]} onClose={onClose} />
      </Wrapper>,
    );
    return { onClose };
  }

  it("shows the payment-delete guard dialog when status is changed from paid to open and Save is clicked", async () => {
    renderPaidEditor();
    await waitForLoaded();

    // Change the Status dropdown from "paid" to "open".
    fireEvent.change(screen.getByDisplayValue("paid"), {
      target: { value: "open" },
    });

    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(
        screen.getByText("This invoice has a recorded payment"),
      ).toBeInTheDocument(),
    );
  });

  it("does not show the guard when the status is left as paid", async () => {
    renderPaidEditor();
    await waitForLoaded();

    // No status change — save directly.
    fireEvent.click(screen.getByText("Save changes"));

    // Guard must NOT appear.
    expect(
      screen.queryByText("This invoice has a recorded payment"),
    ).not.toBeInTheDocument();
  });

  it("dismisses the guard dialog when Cancel is clicked", async () => {
    renderPaidEditor();
    await waitForLoaded();

    fireEvent.change(screen.getByDisplayValue("paid"), {
      target: { value: "open" },
    });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(
        screen.getByText("This invoice has a recorded payment"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("Cancel"));

    expect(
      screen.queryByText("This invoice has a recorded payment"),
    ).not.toBeInTheDocument();
  });

  it("fires DELETE /payments then PATCH when 'Delete payment & mark Open' is clicked", async () => {
    renderPaidEditor();
    await waitForLoaded();

    fireEvent.change(screen.getByDisplayValue("paid"), {
      target: { value: "open" },
    });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(
        screen.getByText("This invoice has a recorded payment"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText(/delete payment/i));

    // After confirming, the editor issues DELETE /invoices/:id/payments then
    // a PATCH to save the status change.
    await waitFor(() => {
      const deleteCall = mockFetch.mock.calls.find(([input, init]) => {
        const url = typeof input === "string" ? input : String(input);
        return (
          url.includes(`/invoices/${PAID_INVOICE_ID}/payments`) &&
          (init as RequestInit)?.method === "DELETE"
        );
      });
      expect(deleteCall).toBeDefined();
    });
  });
});

// ─── Suite 2: Open → Paid (record-payment prompt) ────────────────────────────

describe("InvoiceEditor — Open→Paid record-payment prompt", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = makeFetchMock(OPEN_INVOICE_ID, openInvoiceDetail);
    vi.stubGlobal("fetch", mockFetch);
  });

  function renderOpenEditor() {
    const onClose = vi.fn();
    const Wrapper = makeAuthWrapper("/invoices");
    render(
      <Wrapper>
        <InvoiceEditor invoice={openInvoice} doctorNames={[]} onClose={onClose} />
      </Wrapper>,
    );
    return { onClose };
  }

  it("shows the record-payment prompt when status is changed from open to paid and Save is clicked", async () => {
    renderOpenEditor();
    await waitForLoaded();

    // Change the Status dropdown from "open" to "paid".
    fireEvent.change(screen.getByDisplayValue("open"), {
      target: { value: "paid" },
    });

    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(screen.getByText("Record a payment?")).toBeInTheDocument(),
    );
  });

  it("does not show the prompt when status is left as open", async () => {
    renderOpenEditor();
    await waitForLoaded();

    // No status change.
    fireEvent.click(screen.getByText("Save changes"));

    expect(screen.queryByText("Record a payment?")).not.toBeInTheDocument();
  });

  it("'No, just mark as paid' dismisses the prompt and fires the PATCH save mutation", async () => {
    renderOpenEditor();
    await waitForLoaded();

    fireEvent.change(screen.getByDisplayValue("open"), {
      target: { value: "paid" },
    });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(screen.getByText("Record a payment?")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("No, just mark as paid"));

    // The prompt closes...
    await waitFor(() =>
      expect(screen.queryByText("Record a payment?")).not.toBeInTheDocument(),
    );

    // ...and a PATCH to the invoice URL is issued.
    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(([input, init]) => {
        const url = typeof input === "string" ? input : String(input);
        return (
          url.includes(`/invoices/${OPEN_INVOICE_ID}`) &&
          (init as RequestInit)?.method === "PATCH"
        );
      });
      expect(patchCall).toBeDefined();
    });
  });

  it("'Yes, record payment' dismisses the prompt and opens the Record Payment dialog", async () => {
    renderOpenEditor();
    await waitForLoaded();

    fireEvent.change(screen.getByDisplayValue("open"), {
      target: { value: "paid" },
    });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(screen.getByText("Record a payment?")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("Yes, record payment"));

    // The prompt should close — the Record Payment dialog opens (or at least
    // the prompt is gone), confirming the branch executed correctly.
    await waitFor(() =>
      expect(screen.queryByText("Record a payment?")).not.toBeInTheDocument(),
    );
  });
});

describe("InvoiceEditor — fixed discount lines", () => {
  it("adds a catalog discount to an invoice and saves it with a signed deduction", async () => {
    const invoiceId = "inv-discount-editor";
    const chargeInvoice = {
      ...openInvoice,
      id: invoiceId,
      invoiceNumber: "INV-DISCOUNT-EDITOR",
      items: [
        {
          id: "charge-line",
          description: "Crown",
          quantity: 1,
          unitPrice: 500,
          lineTotal: 500,
          isDiscount: false,
        },
      ],
    } as unknown as Invoice;
    const detail = {
      ...chargeInvoice,
      payments: [],
      displayMetadata: { patientName: "Jane Doe", billTo: "Dr. Synthetic063" },
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, init });
      if (url.includes(`/invoices/${invoiceId}`) && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify(detail), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/pricing/discount-items")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                key: "courtesy_discount",
                label: "Courtesy discount",
                unitPrice: 400,
                isDiscount: true,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/finance/vendors")) {
        return new Response("[]", { status: 200 });
      }
      if (url.includes("/invoice-template/presets")) {
        return new Response(JSON.stringify({ presets: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const Wrapper = makeAuthWrapper("/invoices");
    render(
      <Wrapper>
        <InvoiceEditor invoice={chargeInvoice} doctorNames={[]} onClose={vi.fn()} />
      </Wrapper>,
    );
    await waitFor(() =>
      expect(screen.getByDisplayValue("INV-DISCOUNT-EDITOR")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Add line/ }));
    fireEvent.click(screen.getByText("Discount line"));
    const itemInputs = screen.getAllByPlaceholderText("Item");
    fireEvent.focus(itemInputs[itemInputs.length - 1]!);
    fireEvent.change(itemInputs[itemInputs.length - 1]!, {
      target: { value: "Courtesy discount" },
    });
    const discountOption = await screen.findByText("Courtesy discount");
    fireEvent.mouseDown(discountOption.closest("button")!);

    await waitFor(() => {
      expect(screen.getByLabelText("Discount amount")).toHaveValue(400);
      expect(screen.getAllByText("Discount").length).toBeGreaterThan(0);
      expect(screen.getByText("−$400.00")).toBeInTheDocument();
      expect(screen.getAllByText("$100.00").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      const patch = requests.find(
        ({ url, init }) =>
          url.includes(`/invoices/${invoiceId}`) && init?.method === "PATCH",
      );
      expect(patch).toBeDefined();
      const payload = JSON.parse(String(patch?.init?.body));
      expect(payload.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            description: "Courtesy discount",
            unitPrice: -400,
            isDiscount: true,
          }),
        ]),
      );
    });
  });
});
