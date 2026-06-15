/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateInvoiceDialog } from "@/pages/invoices";
import type { Organization } from "@/lib/types";
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

const orgs: Organization[] = [
  { id: "lab-1", name: "Test Lab", type: "lab" } as unknown as Organization,
  {
    id: "prov-1",
    name: "Dr. Smith Practice",
    type: "provider",
  } as unknown as Organization,
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/organizations")) {
        return new Response(JSON.stringify(orgs), {
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

function renderDialog() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const Wrapper = makeAuthWrapper("/invoices");
  render(
    <Wrapper>
      <CreateInvoiceDialog
        knownLabOrgId="lab-1"
        onClose={onClose}
        onCreated={onCreated}
      />
    </Wrapper>,
  );
  return { onClose, onCreated };
}

// Wait until the org list has loaded so the practice select is populated and
// the form is interactive.
async function waitForLoaded() {
  await waitFor(() =>
    expect(screen.getByText("Dr. Smith Practice")).toBeInTheDocument(),
  );
}

describe("CreateInvoiceDialog safe-exit", () => {
  it("closes immediately on Close when there is no input", async () => {
    const { onClose } = renderDialog();
    await waitForLoaded();

    fireEvent.click(screen.getByLabelText("Close without saving"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
  });

  it("closes immediately on Escape when there is no input", async () => {
    const { onClose } = renderDialog();
    await waitForLoaded();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
  });

  it("prompts to discard on Close when there is unsaved input", async () => {
    const { onClose } = renderDialog();
    await waitForLoaded();

    fireEvent.change(screen.getByPlaceholderText("e.g. INV-2026-001"), {
      target: { value: "INV-NEW" },
    });
    fireEvent.click(screen.getByLabelText("Close without saving"));

    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("prompts to discard on Escape when there is unsaved input", async () => {
    const { onClose } = renderDialog();
    await waitForLoaded();

    fireEvent.change(screen.getByPlaceholderText("e.g. INV-2026-001"), {
      target: { value: "INV-NEW" },
    });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("'Keep editing' cancels the prompt and leaves the dialog open", async () => {
    const { onClose } = renderDialog();
    await waitForLoaded();

    fireEvent.change(screen.getByPlaceholderText("e.g. INV-2026-001"), {
      target: { value: "INV-NEW" },
    });
    fireEvent.click(screen.getByLabelText("Close without saving"));
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Keep editing"));

    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // The typed value is still present — nothing was lost.
    expect(screen.getByDisplayValue("INV-NEW")).toBeInTheDocument();
  });

  it("'Discard changes' closes without saving", async () => {
    const { onClose } = renderDialog();
    await waitForLoaded();

    fireEvent.change(screen.getByPlaceholderText("e.g. INV-2026-001"), {
      target: { value: "INV-NEW" },
    });
    fireEvent.click(screen.getByLabelText("Close without saving"));
    fireEvent.click(screen.getByText("Discard changes"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
  });

  it("treats input typed then cleared back to empty as clean", async () => {
    const { onClose } = renderDialog();
    await waitForLoaded();

    const input = screen.getByPlaceholderText("e.g. INV-2026-001");
    fireEvent.change(input, { target: { value: "INV-NEW" } });
    fireEvent.change(input, { target: { value: "" } });

    fireEvent.click(screen.getByLabelText("Close without saving"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
  });
});
