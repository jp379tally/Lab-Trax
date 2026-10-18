/** @vitest-environment jsdom */
/**
 * The desktop finance lists open with the 10 most recent rows and accumulate
 * further pages through Load more. That accumulator is only safe if a mutation
 * restarts it: refetching whichever page the user happens to be sitting on
 * would merge fresh rows into rows captured before the change, so a record the
 * mutation created (which belongs at the top) would never appear and a record
 * it removed (on page 1) would stay visible.
 *
 * These tests drive each list past its first batch and then perform a real
 * mutation, asserting the list restarts unanchored (no cursor) and shows the
 * post-mutation truth.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Invoice } from "@/lib/types";
import type { SessionUser } from "@/lib/api";
import { makeAuthWrapper } from "../../__tests__/test-utils";
import { formatDate } from "@/lib/format";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));
vi.mock("react-pdf", () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

import InvoicesPage from "@/pages/invoices";
import StatementsPage from "@/pages/statements";

const BILLING_USER = {
  id: "u-bill",
  username: "billing",
  role: "billing",
} as unknown as SessionUser;

const summary = {
  openBalance: 100,
  openCount: 21,
  overdueBalance: 0,
  overdueCount: 0,
  sumTotal: 210,
  sumBalance: 210,
  paidThisMonth: 0,
  paidCount: 0,
};

function invoice(index: number): Invoice {
  return {
    id: `invoice-${index}`,
    invoiceNumber: `INV-${String(index).padStart(3, "0")}`,
    status: "open",
    total: 10,
    balanceDue: 10,
    labOrganizationId: "lab-1",
    providerOrganizationId: "practice-1",
    caseId: null,
    createdAt: new Date(2025, 0, 31 - index).toISOString(),
    items: [],
  } as unknown as Invoice;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Invoices list after a bulk delete", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/invoices");
    localStorage.setItem("labtrax_selected_org_v1", "lab-1");
  });

  it("restarts at the newest invoices so a deleted page-1 row disappears", async () => {
    // Every invoice except the deleted one; the server always answers from
    // this list, so a stale page-1 batch is the only way INV-000 could remain.
    let deleted: string[] = [];
    const requests: string[] = [];
    let deleteBody: unknown = null;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("/api/invoices/bulk") && init?.method === "DELETE") {
        deleteBody = JSON.parse(String(init.body));
        deleted = (deleteBody as { invoiceIds: string[] }).invoiceIds;
        return json({ deletedCount: deleted.length });
      }
      if (url.includes("/api/invoices?")) {
        requests.push(url);
        const params = new URL(url, "http://localhost").searchParams;
        const all = Array.from({ length: 60 }, (_, i) => invoice(i)).filter(
          (row) => !deleted.includes(row.id),
        );
        const limit = Number(params.get("limit"));
        const start = Number(params.get("offset") ?? 0);
        const rows = all.slice(start, start + limit);
        return json({
          rows,
          total: all.length,
          limit,
          offset: start,
          hasMore: start + rows.length < all.length,
          summary,
        });
      }
      if (url.includes("/organizations")) {
        return json([{ id: "lab-1", name: "Lab One", type: "lab" }]);
      }
      return json([]);
    }));

    const Wrapper = makeAuthWrapper("/invoices", {
      user: BILLING_USER,
      status: "authed",
      restoreStatus: "ok",
      restoreNoticeDismissed: true,
    });
    render(<Wrapper><InvoicesPage /></Wrapper>);

    await screen.findByText("INV-000");
    fireEvent.click(screen.getByTestId("invoices-page-2"));
    await screen.findByText("INV-025");
    expect(screen.getByTestId("invoices-loaded-count")).toHaveTextContent("Showing 26-50 of 60");

    // Delete a row while sitting on page 2: the list must return to page 1.
    fireEvent.click(screen.getByLabelText("Select invoice INV-025"));
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete invoices" }));

    await waitFor(() => {
      expect(deleteBody).toMatchObject({ invoiceIds: ["invoice-25"] });
    });
    await waitFor(() => {
      expect(screen.getByTestId("invoices-loaded-count")).toHaveTextContent("Showing 1-25 of 59");
    });
    expect(requests.at(-1)).toContain("offset=0");
    expect(screen.getByText("INV-000")).toBeInTheDocument();
  });
});

describe("Reconciliation history after finishing a reconciliation", () => {
  it("restarts at the newest entries so the new reconciliation is visible", async () => {
    const apiFetchMock = vi.fn();
    vi.doMock("@/lib/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/api")>()),
      apiFetch: (...args: unknown[]) => apiFetchMock(...args),
    }));
    vi.resetModules();
    const { Reconcile } = await import("@/pages/finance/reconcile");

    const entry = (id: string, date: string) => ({
      id,
      statementDate: date,
      endingBalance: "10.00",
      clearedTotal: "10.00",
      difference: "0.00",
    });
    let finished = false;
    const historyUrls: string[] = [];
    apiFetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/candidates")) {
        return Promise.resolve({ startingBalance: "0", candidates: [] });
      }
      if (String(url).includes("/reconciliation/finish")) {
        finished = true;
        return Promise.resolve(entry("recon-new", "2026-06-01"));
      }
      if (String(url).includes("/reconciliation/history")) {
        historyUrls.push(String(url));
        const rows = finished
          ? [entry("recon-new", "2026-06-01"), entry("recon-1", "2026-01-01")]
          : [entry("recon-1", "2026-01-01")];
        const total = finished ? 12 : 11;
        if (String(url).includes("cursor=cursor-recon-1")) {
          return Promise.resolve({
            rows: [entry("recon-old", "2025-01-01")],
            total,
            limit: 10,
            offset: 1,
            hasMore: false,
            nextCursor: "cursor-recon-old",
          });
        }
        return Promise.resolve({
          rows,
          total,
          limit: 10,
          offset: 0,
          hasMore: true,
          nextCursor: "cursor-recon-1",
        });
      }
      return Promise.resolve([]);
    });

    render(<Reconcile accountId="acct" />, { wrapper: makeAuthWrapper() });
    await waitFor(() =>
      expect(screen.getByTestId("reconcile-history-loaded-count")).toHaveTextContent(
        "Showing 1 of 11",
      ),
    );
    fireEvent.click(screen.getByTestId("reconcile-history-load-more"));
    await waitFor(() =>
      expect(screen.getByTestId("reconcile-history-loaded-count")).toHaveTextContent(
        "Showing 2 of 11",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /Finish reconciliation/ }));

    // The freshly created reconciliation belongs at the head of the list;
    // merging an anchored refetch into the old rows would hide it entirely.
    await waitFor(() =>
      expect(screen.getByTestId("reconcile-history-loaded-count")).toHaveTextContent(
        "Showing 2 of 12",
      ),
    );
    expect(screen.getByText(formatDate("2026-06-01"))).toBeInTheDocument();
    expect(historyUrls.at(-1)).not.toContain("cursor=");
    vi.doUnmock("@/lib/api");
    vi.resetModules();
  });
});

describe("Statements account summaries after recording a payment", () => {
  it("restarts at the newest summaries and shows the new balances", async () => {
    let paymentRecorded = false;
    const summaryUrls: URL[] = [];
    const practices = Array.from({ length: 21 }, (_, index) => ({
      id: `practice-${index + 1}`,
      name: `Practice ${String(index + 1).padStart(2, "0")}`,
    }));
    const summaryRow = (index: number) => {
      const paid = paymentRecorded && index === 0;
      return {
        practiceId: practices[index].id,
        practiceName: practices[index].name,
        billingEmail: "billing@alpha.test",
        phone: null,
        openInvoiceCount: 1,
        openInvoiceTotal: paid ? 150 : 200,
        unpaidStatements: [],
        totalOpenBalance: paid ? 150 : 200,
        overdueBalance: 0,
        invoiceCount: 1,
        totalBilled: 200,
        totalPaid: paid ? 50 : 0,
        openBalance: paid ? 150 : 200,
        oldestOpen: null,
      };
    };

    localStorage.setItem("labtrax_finance_org_v1", "lab-1");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
        "http://localhost",
      );
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname.endsWith("/statements/account-summaries")) {
        summaryUrls.push(url);
        const limit = Number(url.searchParams.get("limit") ?? 10);
        const all = practices.map((_, index) => summaryRow(index));
        const cursor = url.searchParams.get("cursor");
        const start = cursor
          ? all.findIndex((row) => row.practiceId === cursor) + 1
          : 0;
        const rows = all.slice(start, start + limit);
        return json({
          rows,
          total: all.length,
          limit,
          offset: start,
          hasMore: start + rows.length < all.length,
          nextCursor: rows.length ? rows[rows.length - 1].practiceId : null,
          totals: { billed: 4200, paid: paymentRecorded ? 50 : 0, open: 4200, overdue: 0 },
        });
      }
      if (url.pathname.endsWith("/invoices/receive-payments") && init?.method === "POST") {
        paymentRecorded = true;
        return json({ totalApplied: "50.00" });
      }
      if (url.pathname.endsWith("/invoices/payments/recent")) return json([]);
      if (url.pathname.endsWith("/invoices")) {
        return json([
          {
            id: "invoice-1",
            labOrganizationId: "lab-1",
            providerOrganizationId: practices[0].id,
            providerOrganization: { name: practices[0].name },
            status: "open",
            total: "200.00",
            balanceDue: paymentRecorded ? "150.00" : "200.00",
            issuedAt: "2026-07-01T12:00:00.000Z",
            createdAt: "2026-07-01T12:00:00.000Z",
          },
        ]);
      }
      if (url.pathname.endsWith("/organizations")) {
        return json([
          { id: "lab-1", name: "Lab One", type: "lab" },
          ...practices.map((p) => ({
            id: p.id,
            name: p.name,
            type: "practice",
            parentLabOrganizationId: "lab-1",
          })),
        ]);
      }
      if (url.pathname.endsWith("/statement-schedule")) return json({});
      if (url.pathname.endsWith("/statement-runs")) return json([]);
      if (url.pathname.endsWith("/admin/templates/statement-email")) return json({});
      return json([]);
    }));

    const Wrapper = makeAuthWrapper("/statements", {
      user: {
        id: "user-1",
        username: "admin",
        role: "admin",
        userType: "lab",
      } as never,
      status: "authed",
      restoreStatus: "ok",
      restoreNoticeDismissed: true,
    });
    render(<Wrapper><StatementsPage /></Wrapper>);

    await screen.findByText("Practice 01");
    fireEvent.click(screen.getByTestId("statements-load-more"));
    await screen.findByText("Practice 20");
    expect(screen.getByTestId("statements-loaded-count")).toHaveTextContent(
      "Showing 20 of 21",
    );

    // Record a payment for a practice in the first batch while the list is
    // sitting on the second one.
    fireEvent.click(screen.getByLabelText("Select practice Practice 01"));
    fireEvent.click(screen.getByRole("button", { name: "Receive Payment" }));
    fireEvent.change(await screen.findByDisplayValue("200.00"), {
      target: { value: "50.00" },
    });
    await screen.findByDisplayValue("50.00");
    const saveButton = screen.getByRole("button", { name: "Save payment" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(screen.getByTestId("statements-loaded-count")).toHaveTextContent(
        "Showing 10 of 21",
      ),
    );
    expect(summaryUrls.at(-1)?.searchParams.get("cursor")).toBeNull();
    const refreshedRow = screen
      .getByLabelText("Select practice Practice 01")
      .closest("tr");
    expect(refreshedRow).not.toBeNull();
    expect(within(refreshedRow!).getAllByText("$150.00").length).toBeGreaterThan(0);
  });
});
