/** @vitest-environment jsdom */
/**
 * Shift-click range selection on the Make Deposits undeposited-funds list (same
 * semantics as the Cases list). A shift-click extends the deposit selection
 * from the anchor to the clicked row over the visible order, preserving any
 * prior selection outside the range.
 *
 * FinanceShell is stubbed so the list renders with a fixed organization and a
 * depositable account, without the shell's own account/org resolution queries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { useLocation, useSearch } from "wouter";
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

// Make Deposits only renders InvoiceEditor after opening an invoice link. The
// shift-click suite never takes that path, so avoid loading the entire
// invoices page (and its editor dependency graph) while the test module starts.
vi.mock("@/pages/invoices", () => ({
  InvoiceEditor: () => null,
}));

const ADMIN_USER = {
  id: "u1",
  username: "admin",
  role: "admin",
  userType: "lab",
} as unknown as SessionUser;

const TXNS = [1, 2, 3, 4, 5].map((n) => ({
  id: `txn-${n}`,
  txnDate: `2026-06-0${n}`,
  payee: `Payer ${n}`,
  memo: null,
  creditAmount: "100.00",
  staleDays: 1,
  ageWarning: false,
  providerOrganizationId: n <= 2 ? "practice-alpha" : "practice-beta",
  providerName: n <= 2 ? "Alpha Dental" : "Beta Smiles",
  practiceId: n <= 2 ? "practice-alpha" : "practice-beta",
  practiceName: n <= 2 ? "Alpha Dental" : "Beta Smiles",
  doctorName: n === 1 || n === 3 ? "Dr. Ada" : n === 2 ? "Dr. Bea" : null,
  invoiceLinks: [],
  paymentSession: n === 1 ? {
    id: "session-12345678",
    receiptNumber: "RCP-20260601-12345678",
    statementId: "statement-87654321",
    receivedAmount: "100.00",
    appliedAmount: "75.00",
    customerCreditAmount: "25.00",
    customerCreditRemaining: "25.00",
    paymentMethod: "check",
    checkNumber: "1042",
    cardLast4: null,
  } : null,
}));

const depositRequests = vi.fn();
const broadcastMessages = vi.fn();

function LocationProbe() {
  const [location] = useLocation();
  const search = useSearch();
  return <output data-testid="current-location">{location}{search ? `?${search}` : ""}</output>;
}

beforeEach(() => {
  class MockBroadcastChannel {
    postMessage = broadcastMessages;
    close = vi.fn();
  }
  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url, "http://localhost").pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (path.endsWith("/finance/make-deposits") && init?.method === "POST") {
        depositRequests(JSON.parse(String(init.body)));
        return json({ moved: 2, totalAmount: "200.00" });
      }
      if (path.endsWith("/finance/undeposited-funds")) return json(TXNS);
      return json({});
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
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
      <>
        <MakeDepositsPage />
        <LocationProbe />
      </>
    </Wrapper>,
  );
  await screen.findByLabelText("Select payment txn-1");
}

function checkbox(id: string): HTMLInputElement {
  return screen.getByLabelText(`Select payment ${id}`) as HTMLInputElement;
}

function selectedIds(): string[] {
  return ["txn-1", "txn-2", "txn-3", "txn-4", "txn-5"].filter(
    (id) => checkbox(id).checked,
  );
}

function totalRow(): HTMLElement {
  const label = screen.getByText("Total undeposited");
  return label.parentElement as HTMLElement;
}

describe("Make Deposits shift-click range selection", () => {
  it("shows statement-payment receipt details without changing selection", async () => {
    await renderPage();

    expect(screen.getByText("RCP-20260601-12345678")).toBeInTheDocument();
    expect(screen.getByText(/Received \$100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Applied \$75\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Customer credit \$25\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Check #1042/)).toBeInTheDocument();
    expect(selectedIds()).toEqual([]);
  });

  it("selects the range downward (anchor above the shift-clicked row)", async () => {
    await renderPage();

    fireEvent.click(checkbox("txn-1"));
    fireEvent.click(checkbox("txn-4"), { shiftKey: true });

    expect(selectedIds()).toEqual(["txn-1", "txn-2", "txn-3", "txn-4"]);
  });

  it("selects the range upward (anchor below the shift-clicked row)", async () => {
    await renderPage();

    fireEvent.click(checkbox("txn-4"));
    fireEvent.click(checkbox("txn-2"), { shiftKey: true });

    expect(selectedIds()).toEqual(["txn-2", "txn-3", "txn-4"]);
  });

  it("adds the range to previously selected payments outside it", async () => {
    await renderPage();

    fireEvent.click(checkbox("txn-5"));
    fireEvent.click(checkbox("txn-1"));
    fireEvent.click(checkbox("txn-3"), { shiftKey: true });

    expect(selectedIds()).toEqual(["txn-1", "txn-2", "txn-3", "txn-5"]);
  });

  it("treats a shift-click with no anchor as a single toggle and sets the anchor", async () => {
    await renderPage();

    fireEvent.click(checkbox("txn-3"), { shiftKey: true });
    expect(selectedIds()).toEqual(["txn-3"]);

    fireEvent.click(checkbox("txn-5"), { shiftKey: true });
    expect(selectedIds()).toEqual(["txn-3", "txn-4", "txn-5"]);
  });

  it("keeps normal single toggling intact", async () => {
    await renderPage();

    fireEvent.click(checkbox("txn-2"));
    expect(checkbox("txn-2").checked).toBe(true);

    fireEvent.click(checkbox("txn-2"));
    expect(checkbox("txn-2").checked).toBe(false);
  });

  it("filters by doctor, recalculates visible totals, and clears hidden selections", async () => {
    await renderPage();

    expect(totalRow()).toHaveTextContent("$500.00");
    fireEvent.click(checkbox("txn-1"));
    fireEvent.click(checkbox("txn-2"));
    expect(screen.getByText("2 payments selected — $200.00")).toBeInTheDocument();

    // Filters are applied server-side now, so the list restarts at the newest
    // matches for the filter before the visible totals settle.
    fireEvent.change(screen.getByLabelText("Practice"), {
      target: { value: "practice-alpha" },
    });
    await waitFor(() => {
      expect(totalRow()).toHaveTextContent("$200.00");
    });
    expect(checkbox("txn-1")).toBeChecked();
    expect(checkbox("txn-2")).toBeChecked();
    expect(screen.queryByLabelText("Select payment txn-3")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Doctor"), {
      target: { value: "dr. bea" },
    });
    await waitFor(() => {
      expect(totalRow()).toHaveTextContent("$100.00");
      expect(screen.queryByLabelText("Select payment txn-1")).not.toBeInTheDocument();
      expect(checkbox("txn-2")).toBeChecked();
      expect(screen.getByText("1 payment selected — $100.00")).toBeInTheDocument();
    });
  });

  it("selects and clears only the currently visible payments with Select all", async () => {
    await renderPage();

    fireEvent.change(screen.getByLabelText("Practice"), {
      target: { value: "practice-alpha" },
    });
    // Wait for the restarted, practice-filtered batch before selecting.
    await waitFor(() => {
      expect(screen.queryByLabelText("Select payment txn-3")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Select payment txn-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    expect(checkbox("txn-1")).toBeChecked();
    expect(checkbox("txn-2")).toBeChecked();
    expect(screen.queryByLabelText("Select payment txn-3")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deselect all" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(checkbox("txn-1")).not.toBeChecked();
    expect(checkbox("txn-2")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Select all" })).toBeInTheDocument();
  });

  it("confirms a completed deposit and navigates to its register", async () => {
    await renderPage();

    fireEvent.click(checkbox("txn-1"));
    fireEvent.click(checkbox("txn-2"));
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make Deposits" }));
      await vi.runAllTimersAsync();
    });

    expect(depositRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "lab-1",
        bankAccountId: "acc-1",
        transactionIds: ["txn-1", "txn-2"],
      }),
    );
    expect(screen.getByText(/Deposited \$200\.00 \(2 payments\)/)).toBeInTheDocument();
    expect(screen.getByText("No payments selected")).toBeInTheDocument();
    expect(checkbox("txn-1")).not.toBeChecked();
    expect(checkbox("txn-2")).not.toBeChecked();
    expect(broadcastMessages).toHaveBeenCalledWith("undeposited-changed");
    expect(screen.getByTestId("current-location")).toHaveTextContent(
      "/finance/register?account=acc-1",
    );
  });
});
