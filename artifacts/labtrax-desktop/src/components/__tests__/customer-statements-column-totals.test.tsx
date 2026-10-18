/** @vitest-environment jsdom */
// Top-of-column totals on the customer window's Statements tab: the Billed /
// Paid / Balance Due headers each show the sum of the displayed rows and
// re-scope when the Open/Paid filter changes.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StatementsTab } from "@/components/customer-detail-tabs";
import type { Organization } from "@/lib/types";
import { makeAuthWrapper } from "../../__tests__/test-utils";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const practice = {
  id: "prov-1",
  name: "Dr. Smith Practice",
  type: "provider",
  billingEmail: "billing@smith.example",
} as unknown as Organization;

// One partially paid statement and one fully paid statement. Both were
// generated before any payment landed, so their issued snapshot still reads
// "nothing paid"; the tab has to report the live figures instead or a paid
// statement never looks paid.
const statements = [
  {
    id: "st-1",
    labOrganizationId: "lab-1",
    providerOrganizationId: "prov-1",
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-06-30T23:59:59.000Z",
    invoiceCount: 3,
    totalBilled: "450.00",
    totalPaid: "100.00",
    balanceDue: "350.00",
    currentTotalPaid: "100.00",
    currentBalanceDue: "350.00",
    snapshotTotalPaid: "0.00",
    snapshotBalanceDue: "450.00",
    pdfFileName: "st-1.pdf",
    pdfStorageKey: "st-1.pdf",
    createdAt: "2026-07-01T12:00:00.000Z",
    lastEmailedAt: null,
    lastEmailedTo: null,
  },
  {
    id: "st-2",
    labOrganizationId: "lab-1",
    providerOrganizationId: "prov-1",
    periodStart: "2026-05-01T00:00:00.000Z",
    periodEnd: "2026-05-31T23:59:59.000Z",
    invoiceCount: 2,
    totalBilled: "200.00",
    totalPaid: "200.00",
    balanceDue: "0.00",
    currentTotalPaid: "200.00",
    currentBalanceDue: "0.00",
    snapshotTotalPaid: "0.00",
    snapshotBalanceDue: "200.00",
    pdfFileName: "st-2.pdf",
    pdfStorageKey: "st-2.pdf",
    createdAt: "2026-06-01T12:00:00.000Z",
    lastEmailedAt: null,
    lastEmailedTo: null,
  },
];

let served: unknown[] = statements;

beforeEach(() => {
  served = statements;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/invoices/practice-statements")) {
        return new Response(JSON.stringify({ ok: true, data: served }), {
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

function renderTab() {
  const Wrapper = makeAuthWrapper("/accounts");
  render(
    <Wrapper>
      <StatementsTab selected={practice} labOrgId="lab-1" />
    </Wrapper>,
  );
}

describe("Statements tab column totals", () => {
  it("shows Billed / Paid / Balance Due totals for all displayed rows", async () => {
    renderTab();
    await waitFor(() =>
      expect(screen.getByTestId("column-total-billed")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("column-total-billed").textContent).toBe("$650.00");
    expect(screen.getByTestId("column-total-paid").textContent).toBe("$300.00");
    expect(screen.getByTestId("column-total-balance-due").textContent).toBe(
      "$350.00",
    );
  });

  it("re-scopes totals to the filtered rows when the filter changes", async () => {
    renderTab();
    await waitFor(() =>
      expect(screen.getByTestId("column-total-billed")).toBeInTheDocument(),
    );

    // "Open" keeps only st-1 (balance due > 0).
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "open" } });
    await waitFor(() =>
      expect(screen.getByTestId("column-total-billed").textContent).toBe(
        "$450.00",
      ),
    );
    expect(screen.getByTestId("column-total-paid").textContent).toBe("$100.00");
    expect(screen.getByTestId("column-total-balance-due").textContent).toBe(
      "$350.00",
    );

    // "Paid" keeps only st-2.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "paid" } });
    await waitFor(() =>
      expect(screen.getByTestId("column-total-billed").textContent).toBe(
        "$200.00",
      ),
    );
    expect(screen.getByTestId("column-total-paid").textContent).toBe("$200.00");
    expect(screen.getByTestId("column-total-balance-due").textContent).toBe(
      "$0.00",
    );
  });

  it("reads a settled statement from its live figures, not the issued snapshot", async () => {
    // Regression: the tab used to render the totals frozen into the statement
    // record at generation, so a statement that had since been paid in full
    // still read $0.00 paid with the whole amount outstanding.
    served = [
      {
        ...statements[1],
        id: "st-3",
        invoiceCount: 2,
        totalBilled: "300.00",
        totalPaid: "0.00",
        balanceDue: "300.00",
        currentTotalPaid: "300.00",
        currentBalanceDue: "0.00",
        snapshotTotalPaid: "0.00",
        snapshotBalanceDue: "300.00",
      },
    ];
    renderTab();
    await waitFor(() =>
      expect(screen.getByTestId("column-total-billed")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("column-total-paid").textContent).toBe("$300.00");
    expect(screen.getByTestId("column-total-balance-due").textContent).toBe(
      "$0.00",
    );

    // …and it is a Paid statement, not an Open one.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "open" } });
    await waitFor(() =>
      expect(screen.queryByTestId("column-total-billed")).not.toBeInTheDocument(),
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "paid" } });
    await waitFor(() =>
      expect(screen.getByTestId("column-total-billed").textContent).toBe(
        "$300.00",
      ),
    );
    expect(screen.getByTestId("column-total-paid").textContent).toBe("$300.00");
  });
});
