/** @vitest-environment jsdom */
/**
 * "Select all" asks the server which payments match the current filters, so a
 * slow response can land after the user has already moved to another practice.
 * The returning ids belong to the filters they were requested under: applying
 * them would leave the table showing one practice while a deposit carries the
 * other, so a stale result has to be dropped.
 *
 * FinanceShell is stubbed so the list renders with a fixed organization and a
 * depositable account, without the shell's own account/org resolution queries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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

const PRACTICES = [
  { id: "practice-alpha", name: "Alpha Dental" },
  { id: "practice-beta", name: "Beta Dental" },
];

function row(practiceId: string, index: number, amount: string) {
  const practiceName = PRACTICES.find((p) => p.id === practiceId)!.name;
  return {
    id: `${practiceId}-${index}`,
    txnDate: "2026-06-01",
    payee: `${practiceName} payer ${index}`,
    memo: null,
    creditAmount: amount,
    staleDays: 1,
    ageWarning: false,
    providerOrganizationId: practiceId,
    providerName: practiceName,
    practiceId,
    practiceName,
    doctorName: null,
    statementDate: null,
    invoiceLinks: [],
    paymentSession: null,
  };
}

// Alpha has more payments than one batch; Beta fits in a single batch.
const ALPHA = Array.from({ length: 12 }, (_, index) => row("practice-alpha", index + 1, "25.00"));
const BETA = Array.from({ length: 3 }, (_, index) => row("practice-beta", index + 1, "10.00"));
const ALL = [...ALPHA, ...BETA];

/** Resolves the in-flight selection request when the test chooses to. */
let releaseSelection: (() => void) | null = null;

const depositRequests = vi.fn();

beforeEach(() => {
  releaseSelection = null;
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
        return json({ moved: body.transactionIds.length, totalAmount: "0.00" });
      }
      if (parsed.pathname.endsWith("/finance/undeposited-funds")) {
        const practiceId = parsed.searchParams.get("practiceId");
        const matches = practiceId ? ALL.filter((r) => r.practiceId === practiceId) : ALL;
        const amountTotal = matches
          .reduce((sum, r) => sum + Number(r.creditAmount), 0)
          .toFixed(2);
        if (parsed.searchParams.get("selection") === "ids") {
          // Hold the response open so the test can change filters first.
          await new Promise<void>((resolve) => {
            releaseSelection = resolve;
          });
          return json({
            selection: matches.map((r) => ({ id: r.id, creditAmount: r.creditAmount })),
            total: matches.length,
            amountTotal,
          });
        }
        const limit = Number(parsed.searchParams.get("limit") ?? matches.length);
        const offset = Number(parsed.searchParams.get("offset") ?? 0);
        const rows = matches.slice(offset, offset + limit);
        return json({
          rows,
          total: matches.length,
          limit,
          offset,
          hasMore: offset + rows.length < matches.length,
          amountTotal,
          staleCount: 0,
          filterOptions: { practices: PRACTICES, doctors: [] },
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

describe("Make Deposits select-all against a filter change", () => {
  it("drops a selection that returns after the practice filter moved on", async () => {
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
    await screen.findByLabelText("Select payment practice-alpha-1");

    // Select all under "All practices" — the request is held open.
    fireEvent.click(screen.getByTestId("make-deposits-select-all"));
    await waitFor(() => expect(releaseSelection).not.toBeNull());

    // The user moves to Beta while those ids are still in flight.
    fireEvent.change(screen.getByLabelText("Practice"), {
      target: { value: "practice-beta" },
    });
    await screen.findByLabelText("Select payment practice-beta-1");
    expect(screen.queryByLabelText("Select payment practice-alpha-1")).toBeNull();

    await act(async () => {
      releaseSelection?.();
      await Promise.resolve();
    });

    // The stale ids are ignored: nothing from the previous filter is selected,
    // and the visible Beta payments stay untouched.
    await waitFor(() =>
      expect(screen.getByText("No payments selected")).toBeInTheDocument(),
    );
    expect(
      (screen.getByLabelText("Select payment practice-beta-1") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByLabelText("Select all payments") as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.getByTestId("make-deposits-select-all")).toHaveTextContent("Select all");

    // Selecting again under Beta covers Beta's payments only.
    fireEvent.click(screen.getByTestId("make-deposits-select-all"));
    await waitFor(() =>
      expect(screen.getByText("3 payments selected — $30.00")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Make Deposits/i }));
    await waitFor(() => expect(depositRequests).toHaveBeenCalledTimes(1));
    expect([...depositRequests.mock.calls[0][0].transactionIds].sort()).toEqual(
      BETA.map((r) => r.id).sort(),
    );
  });
});
