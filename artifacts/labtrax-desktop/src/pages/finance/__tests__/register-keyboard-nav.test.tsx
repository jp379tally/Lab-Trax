/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import RegisterPage from "@/pages/finance/register";
import type { BankAccount, BankTransaction } from "@/lib/types";
import { makeAuthWrapper } from "../../../__tests__/test-utils";

// FinanceShell makes its own auth/account/org network calls on mount. Stub it
// out so the keyboard-nav test drives RegisterTable directly with fixed props.
const ACCOUNT: BankAccount = {
  id: "acct-1",
  name: "Operating",
  accountType: "checking",
  bookBalance: "100",
  clearedBalance: "100",
  unreconciledBalance: "0",
} as unknown as BankAccount;

vi.mock("@/components/finance/FinanceShell", () => ({
  FinanceShell: ({
    children,
  }: {
    children: (ctx: {
      organizationId: string;
      accountId: string | null;
      accounts: BankAccount[];
    }) => ReactNode;
  }) => <>{children({ organizationId: "org-1", accountId: "acct-1", accounts: [ACCOUNT] })}</>,
}));

function txn(id: string, payee: string): BankTransaction {
  return {
    id,
    labOrganizationId: "org-1",
    bankAccountId: "acct-1",
    txnDate: "2026-06-01T00:00:00.000Z",
    type: "other",
    checkNumber: null,
    payee,
    vendorId: null,
    memo: null,
    categoryId: null,
    debitAmount: "10",
    creditAmount: "0",
    netAmount: "-10",
    cleared: false,
    reconciled: false,
    status: "posted",
    source: "manual",
    runningBalance: "90",
    invoices: [],
  } as BankTransaction;
}

const TXNS = [txn("t1", "Alpha"), txn("t2", "Bravo"), txn("t3", "Charlie")];

function rowFor(payee: string): HTMLTableRowElement {
  const cell = screen.getByText(payee);
  const row = cell.closest("tr");
  if (!row) throw new Error(`row not found for ${payee}`);
  return row as HTMLTableRowElement;
}

const SELECTED_CLASS = "bg-sky-100";

beforeEach(() => {
  // jsdom lacks these — the register relies on both.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = url.includes("/finance/transactions") ? TXNS : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("register keyboard navigation", () => {
  it("moves the selection with Up/Down, opens the editor with Enter, and clears with Esc", async () => {
    const Wrapper = makeAuthWrapper("/finance/register");
    render(<RegisterPage />, { wrapper: Wrapper });

    // Rows arrive from the stubbed transactions query.
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());

    // Nothing selected initially.
    expect(rowFor("Alpha").className).not.toContain(SELECTED_CLASS);

    // ArrowDown selects the first row.
    fireEvent.keyDown(document, { key: "ArrowDown" });
    await waitFor(() => expect(rowFor("Alpha").className).toContain(SELECTED_CLASS));
    expect(rowFor("Bravo").className).not.toContain(SELECTED_CLASS);

    // ArrowDown again moves to the second row.
    fireEvent.keyDown(document, { key: "ArrowDown" });
    await waitFor(() => expect(rowFor("Bravo").className).toContain(SELECTED_CLASS));
    expect(rowFor("Alpha").className).not.toContain(SELECTED_CLASS);

    // ArrowUp moves back to the first row.
    fireEvent.keyDown(document, { key: "ArrowUp" });
    await waitFor(() => expect(rowFor("Alpha").className).toContain(SELECTED_CLASS));

    // Enter opens the inline edit panel for the selected row.
    fireEvent.keyDown(document, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());

    // Esc clears the selection and closes the editor.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Save")).toBeNull());
    expect(rowFor("Alpha").className).not.toContain(SELECTED_CLASS);
  });

  it("does not move the selection when typing in a form field", async () => {
    const Wrapper = makeAuthWrapper("/finance/register");
    render(<RegisterPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());

    const searchBox = screen.getByPlaceholderText("Search payee, memo, check #…");
    fireEvent.keyDown(searchBox, { key: "ArrowDown" });

    // Selection must stay empty — the keystroke belongs to the search input.
    expect(rowFor("Alpha").className).not.toContain(SELECTED_CLASS);
  });
});
