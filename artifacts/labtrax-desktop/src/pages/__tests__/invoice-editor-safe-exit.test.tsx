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
  items: [],
  displayMetadata: { patientName: "Jane Doe", billTo: "Dr. Smith" },
} as unknown as Invoice;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // Invoice detail drives the dirty-check baseline.
      if (url.includes(`/invoices/${INVOICE_ID}`)) {
        return new Response(JSON.stringify(baseInvoice), {
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

function renderEditor() {
  const onClose = vi.fn();
  const Wrapper = makeAuthWrapper("/invoices");
  render(
    <Wrapper>
      <InvoiceEditor invoice={baseInvoice} onClose={onClose} />
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
});
