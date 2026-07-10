/** @vitest-environment jsdom */
/**
 * Shift-click range selection on the desktop Invoices register (same semantics
 * as the Cases list). Selecting the row checkbox toggles the invoice into the
 * bulk-selection Set; a shift-click extends the selection from the anchor to
 * the clicked row over the currently visible (filtered) order, preserving any
 * prior selection outside the range.
 *
 * jspdf / react-pdf are stubbed (heavy, non-jsdom-friendly at import time).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import InvoicesPage from "@/pages/invoices";
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

const ADMIN_USER = {
  id: "u1",
  username: "admin",
  role: "admin",
  userType: "lab",
} as unknown as SessionUser;

// Five invoices, rendered newest-first. createdAt is descending so INV-1..INV-5
// stay in that visible order.
const INVOICES = [1, 2, 3, 4, 5].map((n) => ({
  id: `inv-${n}`,
  invoiceNumber: `INV-${n}`,
  labOrganizationId: "lab-1",
  providerOrganizationId: "prov-1",
  providerOrganization: { id: "prov-1", name: "Alpha Dental" },
  status: "open",
  total: "100.00",
  balanceDue: "100.00",
  createdAt: `2026-06-${String(10 - n).padStart(2, "0")}T10:00:00.000Z`,
  items: [],
}));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url, "http://localhost").pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (path.endsWith("/cases/doctor-names")) return json([]);
      if (path.endsWith("/organizations")) return json([]);
      if (path.endsWith("/invoices")) return json(INVOICES);
      return json({});
    }),
  );
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});

async function renderPage() {
  const Wrapper = makeAuthWrapper("/invoices", {
    user: ADMIN_USER,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  render(
    <Wrapper>
      <InvoicesPage />
    </Wrapper>,
  );
  await screen.findByLabelText("Select invoice INV-1");
}

function checkbox(invoiceNumber: string): HTMLInputElement {
  return screen.getByLabelText(
    `Select invoice ${invoiceNumber}`,
  ) as HTMLInputElement;
}

function selectedNumbers(): string[] {
  return ["INV-1", "INV-2", "INV-3", "INV-4", "INV-5"].filter(
    (n) => checkbox(n).checked,
  );
}

describe("Invoices shift-click range selection", () => {
  it("selects the range downward (anchor above the shift-clicked row)", async () => {
    await renderPage();

    fireEvent.click(checkbox("INV-1"));
    fireEvent.click(checkbox("INV-4"), { shiftKey: true });

    expect(selectedNumbers()).toEqual(["INV-1", "INV-2", "INV-3", "INV-4"]);
  });

  it("selects the range upward (anchor below the shift-clicked row)", async () => {
    await renderPage();

    fireEvent.click(checkbox("INV-4"));
    fireEvent.click(checkbox("INV-2"), { shiftKey: true });

    expect(selectedNumbers()).toEqual(["INV-2", "INV-3", "INV-4"]);
  });

  it("adds the range to previously selected invoices outside it", async () => {
    await renderPage();

    fireEvent.click(checkbox("INV-5"));
    fireEvent.click(checkbox("INV-1"));
    fireEvent.click(checkbox("INV-3"), { shiftKey: true });

    expect(selectedNumbers()).toEqual(["INV-1", "INV-2", "INV-3", "INV-5"]);
  });

  it("treats a shift-click with no anchor as a single toggle and sets the anchor", async () => {
    await renderPage();

    fireEvent.click(checkbox("INV-3"), { shiftKey: true });
    expect(selectedNumbers()).toEqual(["INV-3"]);

    fireEvent.click(checkbox("INV-5"), { shiftKey: true });
    expect(selectedNumbers()).toEqual(["INV-3", "INV-4", "INV-5"]);
  });

  it("keeps normal single toggling intact", async () => {
    await renderPage();

    fireEvent.click(checkbox("INV-2"));
    expect(checkbox("INV-2").checked).toBe(true);

    fireEvent.click(checkbox("INV-2"));
    expect(checkbox("INV-2").checked).toBe(false);
  });
});
