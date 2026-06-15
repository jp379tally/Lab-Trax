/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InvoiceEditor } from "@/pages/invoices";
import { guardNavigation } from "@/lib/nav-guard";
import type { Invoice } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";

// Same PDF stubs as the safe-exit suite — the nav-guard flow never touches PDF
// code, but the imports load at module time and are not jsdom-friendly.
vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const INVOICE_ID = "inv-1";

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
      if (url.includes(`/invoices/${INVOICE_ID}`)) {
        return new Response(JSON.stringify(baseInvoice), {
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

function renderEditor() {
  const onClose = vi.fn();
  const Wrapper = makeAuthWrapper("/invoices");
  const view = render(
    <Wrapper>
      <InvoiceEditor invoice={baseInvoice} doctorNames={[]} onClose={onClose} />
    </Wrapper>,
  );
  return { onClose, view };
}

async function waitForLoaded() {
  await waitFor(() =>
    expect(screen.getByDisplayValue("Jane Doe")).toBeInTheDocument(),
  );
}

function makeDirty() {
  fireEvent.change(screen.getByDisplayValue("INV-1"), {
    target: { value: "INV-EDITED" },
  });
}

describe("InvoiceEditor navigation guard", () => {
  it("does not block navigation when the form is clean", async () => {
    renderEditor();
    await waitForLoaded();

    const proceed = vi.fn();
    // No blocker registered → guardNavigation lets the navigation proceed.
    expect(guardNavigation(proceed)).toBe(false);
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
  });

  it("intercepts navigation and prompts to discard when there are unsaved edits", async () => {
    renderEditor();
    await waitForLoaded();
    makeDirty();

    const proceed = vi.fn();
    // A dirty editor registers a blocker → navigation is deferred.
    let blocked = false;
    await waitFor(() => {
      blocked = guardNavigation(proceed);
      expect(blocked).toBe(true);
    });
    expect(proceed).not.toHaveBeenCalled();
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
  });

  it("'Keep editing' cancels the deferred navigation", async () => {
    renderEditor();
    await waitForLoaded();
    makeDirty();

    const proceed = vi.fn();
    await waitFor(() => expect(guardNavigation(proceed)).toBe(true));
    fireEvent.click(screen.getByText("Keep editing"));

    expect(proceed).not.toHaveBeenCalled();
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
    // Edits are intact.
    expect(screen.getByDisplayValue("INV-EDITED")).toBeInTheDocument();
  });

  it("'Discard changes' proceeds with the deferred navigation", async () => {
    renderEditor();
    await waitForLoaded();
    makeDirty();

    const proceed = vi.fn();
    await waitFor(() => expect(guardNavigation(proceed)).toBe(true));
    fireEvent.click(screen.getByText("Discard changes"));

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
  });

  it("warns via beforeunload only while the form is dirty", async () => {
    renderEditor();
    await waitForLoaded();

    // Clean form: beforeunload is not cancelled.
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    makeDirty();
    // Dirty form: the handler cancels the unload to trigger the native warning.
    await waitFor(() => {
      const dirtyEvent = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(dirtyEvent);
      expect(dirtyEvent.defaultPrevented).toBe(true);
    });
  });

  it("stops blocking navigation once the editor unmounts", async () => {
    const { view } = renderEditor();
    await waitForLoaded();
    makeDirty();

    await waitFor(() => expect(guardNavigation(vi.fn())).toBe(true));
    fireEvent.click(screen.getByText("Keep editing"));

    view.unmount();

    // With the editor gone, the blocker is cleared and navigation proceeds.
    expect(guardNavigation(vi.fn())).toBe(false);
  });
});
