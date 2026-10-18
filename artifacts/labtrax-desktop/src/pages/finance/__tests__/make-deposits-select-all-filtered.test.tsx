/** @vitest-environment jsdom */
/**
 * Make Deposits "Select all" covers every payment the current filters match,
 * not just the batch that has been paged in. The list loads 10 rows at a time
 * while the footer reports the full filtered set, so selecting all has to ask
 * the server which payments match and deposit exactly those.
 *
 * FinanceShell is stubbed so the list renders with a fixed organization and a
 * depositable account, without the shell's own account/org resolution queries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import MakeDepositsPage from "@/pages/finance/make-deposits";
import type { SessionUser } from "@/lib/api";
import { makeAuthWrapper } from "../../../__tests__/test-utils";

vi.mock("@/components/finance/FinanceShell", () => ({
  FinanceShell: ({
    children,
  }: {
    children: (ctx: {
      organizationId: string;
      accountId?: string;
      accounts: unknown[];
    }) => React.ReactNode;
  }) => (
    <>
      {children({
        organizationId: "lab-1",
        accountId: "acc-1",
        accounts: [
          {
            id: "acc-1",
            name: "Checking",
            accountType: "checking",
            isArchived: false,
          },
        ],
      })}
    </>
  ),
}));

vi.mock("@/pages/invoices", () => ({
  InvoiceEditor: () => null,
}));

const ADMIN_USER = {
  id: "u1",
  username: "admin",
  role: "admin",
  userType: "lab",
} as unknown as SessionUser;

// 12 matching payments of $25.00 each: two pages at the list's batch size of 10.
const MATCHES = Array.from({ length: 12 }, (_, index) => ({
  id: `txn-${index + 1}`,
  txnDate: "2026-06-01",
  payee: `Payer ${index + 1}`,
  memo: null,
  creditAmount: "25.00",
  staleDays: 1,
  ageWarning: false,
  providerOrganizationId: "practice-alpha",
  providerName: "Alpha Dental",
  practiceId: "practice-alpha",
  practiceName: "Alpha Dental",
  doctorName: null,
  statementDate: null,
  invoiceLinks: [],
  paymentSession: null,
}));

const depositRequests = vi.fn();
const selectionRequests = vi.fn();

beforeEach(() => {
  class MockBroadcastChannel {
    postMessage = vi.fn();
    close = vi.fn();
  }
  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const parsed = new URL(url, "http://localhost");
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (parsed.pathname.endsWith("/finance/make-deposits") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        depositRequests(body);
        return json({ moved: body.transactionIds.length, totalAmount: "300.00" });
      }
      if (parsed.pathname.endsWith("/finance/undeposited-funds")) {
        if (parsed.searchParams.get("selection") === "ids") {
          selectionRequests(parsed.search);
          return json({
            selection: MATCHES.map((row) => ({ id: row.id, creditAmount: row.creditAmount })),
            total: MATCHES.length,
            amountTotal: "300.00",
          });
        }
        const limit = Number(parsed.searchParams.get("limit") ?? MATCHES.length);
        const cursor = parsed.searchParams.get("cursor");
        const start = cursor
          ? MATCHES.findIndex((row) => row.id === cursor) + 1
          : 0;
        const rows = MATCHES.slice(start, start + limit);
        return json({
          rows,
          total: MATCHES.length,
          limit,
          offset: start,
          hasMore: start + rows.length < MATCHES.length,
          nextCursor: rows.length ? rows[rows.length - 1].id : null,
          amountTotal: "300.00",
          staleCount: 0,
        });
      }
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
  const Wrapper = makeAuthWrapper("/finance/make-deposits", {
    user: ADMIN_USER,
    status: "authed",
    restoreStatus: "ok",
    restoreNoticeDismissed: true,
  });
  render(
    <Wrapper>
      <MakeDepositsPage />
    </Wrapper>,
  );
  await screen.findByLabelText("Select payment txn-1");
  // Only the first batch is loaded, while the footer reports the full set.
  expect(screen.getByTestId("make-deposits-loaded-count")).toHaveTextContent(
    "Showing 10 of 12",
  );
  // The rows can appear before whole-set metadata reaches the active query.
  // Wait for that metadata before exercising the full-set selection action.
  await waitFor(() => expect(screen.getByText("Total undeposited").closest("tr")).toHaveTextContent("$300.00"));
}

function selectAllButton(): HTMLButtonElement {
  return screen.getByTestId("make-deposits-select-all") as HTMLButtonElement;
}

function checkbox(id: string): HTMLInputElement {
  return screen.getByLabelText(`Select payment ${id}`) as HTMLInputElement;
}

describe("Make Deposits select-all over the full filtered set", () => {
  it("selects every matching payment, not only the loaded batch", async () => {
    await renderPage();

    fireEvent.click(selectAllButton());

    await waitFor(() =>
      expect(screen.getByText("12 payments selected — $300.00")).toBeInTheDocument(),
    );
    expect(selectionRequests).toHaveBeenCalledTimes(1);
    // The id request carries the active filters but no page window.
    const selectionQuery = selectionRequests.mock.calls[0][0] as string;
    expect(selectionQuery).toContain("organizationId=lab-1");
    expect(selectionQuery).not.toContain("limit=");
    expect(selectionQuery).not.toContain("offset=");
    expect(selectAllButton()).toHaveTextContent("Deselect all");
    expect(
      (screen.getByLabelText("Select all payments") as HTMLInputElement).checked,
    ).toBe(true);
    expect(checkbox("txn-1").checked).toBe(true);
    expect(checkbox("txn-10").checked).toBe(true);
  });

  it("deposits exactly the payments in a full-set selection", async () => {
    await renderPage();

    fireEvent.click(selectAllButton());
    await waitFor(() =>
      expect(screen.getByText("12 payments selected — $300.00")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Make Deposits/i }));

    await waitFor(() => expect(depositRequests).toHaveBeenCalledTimes(1));
    const body = depositRequests.mock.calls[0][0] as { transactionIds: string[] };
    expect([...body.transactionIds].sort()).toEqual(
      [...MATCHES.map((row) => row.id)].sort(),
    );
  });

  it("keeps unloaded selections while a later page loads", async () => {
    await renderPage();

    fireEvent.click(selectAllButton());
    await waitFor(() =>
      expect(screen.getByText("12 payments selected — $300.00")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("make-deposits-load-more"));

    await screen.findByLabelText("Select payment txn-12");
    expect(screen.getByText("12 payments selected — $300.00")).toBeInTheDocument();
    expect(checkbox("txn-12").checked).toBe(true);
  });

  it("clears the whole selection on deselect all", async () => {
    await renderPage();

    fireEvent.click(selectAllButton());
    await waitFor(() =>
      expect(screen.getByText("12 payments selected — $300.00")).toBeInTheDocument(),
    );

    fireEvent.click(selectAllButton());

    await waitFor(() =>
      expect(screen.getByText("No payments selected")).toBeInTheDocument(),
    );
    expect(checkbox("txn-1").checked).toBe(false);
    expect(selectAllButton()).toHaveTextContent("Select all");
  });

  it("leaves shift-click range selection over loaded rows unchanged", async () => {
    await renderPage();

    fireEvent.click(checkbox("txn-2"));
    fireEvent.click(checkbox("txn-5"), { shiftKey: true });

    expect(["txn-2", "txn-3", "txn-4", "txn-5"].every((id) => checkbox(id).checked)).toBe(
      true,
    );
    expect(checkbox("txn-1").checked).toBe(false);
    expect(checkbox("txn-6").checked).toBe(false);
    expect(screen.getByText("4 payments selected — $100.00")).toBeInTheDocument();
    expect(selectionRequests).not.toHaveBeenCalled();
  });
});
