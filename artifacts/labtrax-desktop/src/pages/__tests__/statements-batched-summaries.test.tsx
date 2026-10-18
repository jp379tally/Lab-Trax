/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import StatementsPage from "@/pages/statements";
import { makeAuthWrapper } from "../../__tests__/test-utils";

vi.mock("jspdf", () => ({ default: class {} }));
vi.mock("jspdf-autotable", () => ({ default: () => {} }));

const summaries = Array.from({ length: 21 }, (_, index) => ({
  practiceId: `practice-${index + 1}`,
  practiceName: `Practice ${String(index + 1).padStart(2, "0")}`,
  billingEmail: null,
  phone: null,
  openInvoiceCount: 1,
  openInvoiceTotal: index + 1,
  unpaidStatements: [],
  totalOpenBalance: index + 1,
  overdueBalance: 0,
  invoiceCount: 1,
  totalBilled: index + 1,
  totalPaid: 0,
  openBalance: index + 1,
  oldestOpen: null,
}));

const summaryRequests: URL[] = [];
const invoiceListRequests: URL[] = [];

beforeEach(() => {
  summaryRequests.length = 0;
  invoiceListRequests.length = 0;
  localStorage.setItem("labtrax_finance_org_v1", "lab-1");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
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
      summaryRequests.push(url);
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const matching = summaries.filter((row) =>
        row.practiceName.toLowerCase().includes(search),
      );
      const limit = Number(url.searchParams.get("limit") ?? 10);
      // Keyset paging: the cursor names the last row the client already has.
      const cursor = url.searchParams.get("cursor");
      const start = cursor
        ? matching.findIndex((row) => row.practiceId === cursor) + 1
        : 0;
      const rows = matching.slice(start, start + limit);
      return json({
        rows,
        total: matching.length,
        limit,
        offset: start,
        hasMore: start + rows.length < matching.length,
        nextCursor: rows.length ? rows[rows.length - 1].practiceId : null,
        // Deliberately unrelated to the loaded row sums.
        totals: { billed: 9999, paid: 8888, open: 7777, overdue: 6666 },
      });
    }
    if (url.pathname.endsWith("/invoices")) {
      invoiceListRequests.push(url);
      return json([]);
    }
    if (url.pathname.endsWith("/organizations")) {
      return json([{ id: "lab-1", name: "Lab One", type: "lab" }]);
    }
    if (url.pathname.endsWith("/statement-schedule")) return json({});
    if (url.pathname.endsWith("/statement-runs")) return json([]);
    if (url.pathname.endsWith("/admin/templates/statement-email")) return json({});
    return json([]);
  }));
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("Statements batched account summaries", () => {
  it("pages, resets filters, and uses full-set server totals", async () => {
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

    await screen.findByText("Practice 10");
    expect(summaryRequests[0].searchParams.get("limit")).toBe("10");
    expect(summaryRequests[0].searchParams.get("cursor")).toBeNull();
    expect(screen.getByTestId("statements-loaded-count")).toHaveTextContent(
      "Showing 10 of 21",
    );
    expect(screen.getByText("$9,999.00")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("statements-load-more"));
    await screen.findByText("Practice 20");
    expect(screen.getByText("Practice 01")).toBeInTheDocument();
    expect(summaryRequests.some((url) => url.searchParams.get("cursor") === "practice-10"))
      .toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Search practice…"), {
      target: { value: "Practice 03" },
    });
    await waitFor(() => {
      const latest = summaryRequests.at(-1);
      expect(latest?.searchParams.get("search")).toBe("Practice 03");
      expect(latest?.searchParams.get("cursor")).toBeNull();
    });
    // The counter element is already on screen, so wait for its content to
    // catch up with the filtered batch rather than for the node to appear.
    await waitFor(() =>
      expect(screen.getByTestId("statements-loaded-count")).toHaveTextContent(
        "Showing 1 of 1",
      ),
    );
    expect(invoiceListRequests).toHaveLength(0);
  });
});