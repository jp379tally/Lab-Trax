/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InvoiceEditor } from "@/pages/invoices";
import type { Invoice } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// jspdf / jspdf-autotable are pulled in at import time via `@/lib/export`, and
// react-pdf / pdfjs are not jsdom-friendly. The safe-exit flow never exercises
// any PDF code path, so stub them out for the smoke render.
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const INVOICE_ID = "inv-1";

// Minimal invoice + matching detail payload. The editor builds its dirty-check
// baseline from the detail returned by GET /invoices/:id, so the two must agree
// on every serialized field for the form to start "clean".
const baseInvoice: Invoice = {
  id: INVOICE_ID,
  invoiceNumber: "INV-1",
  caseId: null,
  labOrganizationId: "lab-1",
  providerOrganizationId: "prov-1",
  status: "open",
  tax: 0,
  discount: 0,
  notes: "Original notes",
  issuedAt: null,
  dueAt: null,
  items: [{
    id: "line-1",
    description: "Custom charge",
    quantity: 1,
    unitPrice: 25,
    subItems: [],
  }],
  displayMetadata: { patientName: "Jane Doe", billTo: "Dr. Synthetic063" },
} as unknown as Invoice;

let invoiceDetail = baseInvoice;

beforeEach(() => {
  invoiceDetail = baseInvoice;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // Invoice detail drives the dirty-check baseline.
      if (url.includes(`/invoices/${INVOICE_ID}`)) {
        return new Response(JSON.stringify(invoiceDetail), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Template presets endpoint expects a { presets: [] } envelope.
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

function renderEditor(invoice: Invoice = baseInvoice) {
  invoiceDetail = invoice;
  const onClose = vi.fn();
  const Wrapper = makeAuthWrapper("/invoices");
  render(
    <Wrapper>
      <InvoiceEditor invoice={invoice} doctorNames={[]} onClose={onClose} />
    </Wrapper>,
  );
  return { onClose };
}

// Wait until the editor has loaded the detail payload and captured its
// baseline. Once the patient name field shows the loaded value the form is
// fully hydrated and the dirty check is live.
async function waitForLoaded() {
  await waitFor(() =>
    expect(screen.getByDisplayValue("Jane Doe")).toBeInTheDocument(),
  );
}

describe("InvoiceEditor safe-exit", () => {
  it("adds a blank line after the existing items and before totals", async () => {
    renderEditor();
    await waitForLoaded();

    fireEvent.click(screen.getByTestId("button-add-line-bottom"));

    const descriptions = await screen.findAllByPlaceholderText("Description");
    expect(descriptions).toHaveLength(2);
    expect(descriptions[1]).toHaveValue("");

    const button = screen.getByTestId("button-add-line-bottom");
    const table = button.closest("table");
    const rows = Array.from(table!.querySelectorAll("tr"));
    const addLineRow = button.closest("tr")!;
    const subtotalRow = screen.getByText("Subtotal").closest("tr")!;
    expect(addLineRow.querySelector("td")).toHaveAttribute("colspan", "7");
    expect(rows.indexOf(addLineRow)).toBeLessThan(rows.indexOf(subtotalRow));
    expect(Array.from(table!.querySelectorAll("tbody tr")).at(-1)).toBe(addLineRow);
  });

  it("shows the bottom add-line control when the invoice has no items", async () => {
    const emptyInvoice = { ...baseInvoice, items: [] } as Invoice;
    renderEditor(emptyInvoice);
    await waitForLoaded();
    expect(screen.getByText(/No line items/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-add-line-bottom"));

    const descriptions = await screen.findAllByPlaceholderText("Description");
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toHaveValue("");
    expect(screen.queryByText(/No line items/)).not.toBeInTheDocument();
  });

  it("closes immediately on Close when there are no edits", async () => {
    const { onClose } = renderEditor();
    await waitForLoaded();

    fireEvent.click(screen.getByLabelText("Close without saving"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
  });

  it("closes immediately on Escape when there are no edits", async () => {
    const { onClose } = renderEditor();
    await waitForLoaded();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
  });

  it("prompts to discard on Close when there are unsaved edits", async () => {
    const { onClose } = renderEditor();
    await waitForLoaded();

    fireEvent.change(screen.getByDisplayValue("INV-1"), {
      target: { value: "INV-EDITED" },
    });
    fireEvent.click(screen.getByLabelText("Close without saving"));

    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("prompts to discard on Escape when there are unsaved edits", async () => {
    const { onClose } = renderEditor();
    await waitForLoaded();

    fireEvent.change(screen.getByDisplayValue("INV-1"), {
      target: { value: "INV-EDITED" },
    });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("'Keep editing' cancels the prompt and leaves the editor open", async () => {
    const { onClose } = renderEditor();
    await waitForLoaded();

    fireEvent.change(screen.getByDisplayValue("INV-1"), {
      target: { value: "INV-EDITED" },
    });
    fireEvent.click(screen.getByLabelText("Close without saving"));
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Keep editing"));

    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // The edited value is still present — nothing was lost.
    expect(screen.getByDisplayValue("INV-EDITED")).toBeInTheDocument();
  });

  it("'Discard changes' closes without saving", async () => {
    const { onClose } = renderEditor();
    await waitForLoaded();

    fireEvent.change(screen.getByDisplayValue("INV-1"), {
      target: { value: "INV-EDITED" },
    });
    fireEvent.click(screen.getByLabelText("Close without saving"));
    fireEvent.click(screen.getByText("Discard changes"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
  });

  it("treats a field edited then reverted to its original value as clean", async () => {
    const { onClose } = renderEditor();
    await waitForLoaded();

    const patientInput = screen.getByDisplayValue("Jane Doe");
    // Edit away from the original...
    fireEvent.change(patientInput, { target: { value: "Jane Smith" } });
    // ...then revert back to exactly the original value.
    fireEvent.change(patientInput, { target: { value: "Jane Doe" } });

    fireEvent.click(screen.getByLabelText("Close without saving"));

    // Reverted form is clean, so Close skips the prompt and closes at once.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
  });

  it("keeps blank price text visible and rejects it on save", async () => {
    renderEditor();
    await waitForLoaded();
    const price = screen.getByDisplayValue("25");
    fireEvent.change(price, { target: { value: "" } });
    expect(price).toHaveValue(null);

    fireEvent.click(screen.getByText("Save changes"));
    expect(await screen.findByText(/Each line item needs a valid price/)).toBeInTheDocument();
  });
});
