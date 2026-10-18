/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import RegisterPage, { DepositBatchHistory } from "@/pages/finance/register";
import type { BankAccount, BankTransaction } from "@/lib/types";
import { makeAuthWrapper } from "../../../__tests__/test-utils";

const ACCOUNT: BankAccount = {
  id: "acct-1",
  name: "Operating",
  accountType: "checking",
  bookBalance: "175",
  clearedBalance: "175",
  unreconciledBalance: "0",
} as unknown as BankAccount;
let cachedAccount: BankAccount | undefined = ACCOUNT;
const refreshState = vi.hoisted(() => ({ failed: false, retry: vi.fn() }));
vi.mock("@/lib/finance", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/finance")>(),
  useBankAccounts: () => ({ data: cachedAccount ? [cachedAccount] : [], isError: refreshState.failed, refetch: refreshState.retry }),
}));

vi.mock("@/components/finance/FinanceShell", () => ({
  FinanceShell: ({
    children,
  }: {
    children: (ctx: {
      organizationId: string;
      accountId: string | null;
      accounts: BankAccount[];
    }) => ReactNode;
  }) => <>{children({ organizationId: "org-1", accountId: "acct-1", accounts: cachedAccount ? [cachedAccount] : [] })}</>,
}));

const aggregate: BankTransaction = {
  id: "aggregate-1",
  labOrganizationId: "org-1",
  bankAccountId: "acct-1",
  txnDate: "2026-06-01T00:00:00.000Z",
  type: "deposit",
  checkNumber: null,
  payee: "Batch deposit",
  vendorId: null,
  memo: null,
  categoryId: "category-that-must-be-ignored",
  debitAmount: "0",
  creditAmount: "175.00",
  netAmount: "175.00",
  cleared: false,
  reconciled: false,
  status: "posted",
  source: "payment",
  runningBalance: "175.00",
  invoices: [],
  isAggregateDeposit: true,
  splitGroups: [
    {
      providerOrganizationId: "practice-1",
      providerName: "Bright Practice",
      subtotal: "125.00",
      payments: [
        {
          childTransactionId: "payment-1",
          amount: "50.00",
          payee: "Alice Customer",
          memo: "Front desk payment",
          checkNumber: "CHK-10",
          paymentMethod: "check",
          receiptNumber: "RCPT-10",
          statementId: "stmt-10",
          paymentSessionId: "session-10",
          invoices: [{ invoiceId: "inv-1", invoiceNumber: "INV-100" }],
        },
        {
          childTransactionId: "payment-2",
          amount: "75.00",
          payee: "Bob Customer",
          memo: null,
          checkNumber: null,
          paymentMethod: "card",
          receiptNumber: null,
          statementId: null,
          paymentSessionId: null,
          invoices: [],
        },
      ],
    },
    {
      providerOrganizationId: null,
      providerName: "Ignored provider name",
      subtotal: "50.00",
      payments: [
        {
          childTransactionId: "payment-3",
          amount: "50.00",
          payee: "Unassigned Customer",
          memo: "No practice",
          checkNumber: null,
          paymentMethod: "cash",
          receiptNumber: "RCPT-11",
          statementId: null,
          paymentSessionId: null,
          invoices: [],
        },
      ],
    },
  ],
};

const history = [
  {
    id: "batch-active",
    organizationId: "org-1",
    bankAccountId: "acct-1",
    txnDate: "2026-06-01T00:00:00.000Z",
    status: "posted",
    originalTotal: "175.00",
    releasedAt: null,
    correctionState: "active",
    members: [
      {
        childTransactionId: "payment-1",
        amount: "50.00",
        payee: "Alice Customer",
        memo: "Front desk payment",
        invoiceLinks: [{ invoiceId: "inv-1", invoiceNumber: "INV-100" }],
        releasedAt: null,
        correctionState: "active",
      },
    ],
  },
  {
    id: "batch-released",
    organizationId: "org-1",
    bankAccountId: "acct-1",
    txnDate: "2026-06-02T00:00:00.000Z",
    status: "void",
    originalTotal: "80.00",
    releasedAt: "2026-06-02T15:42:00.000Z",
    correctionState: "corrected",
    members: [
      {
        childTransactionId: "payment-released",
        amount: "80.00",
        payee: "Corrected Customer",
        memo: "Corrected payment",
        invoiceLinks: [],
        releasedAt: "2026-06-02T15:42:00.000Z",
        childStatus: "void",
        correctionState: "corrected",
      },
    ],
  },
];
let historyResponseMode = false;
const manyHistory = Array.from({ length: 11 }, (_, index) => ({
  ...history[0],
  id: `batch-page-${index}`,
  members: [{ ...history[0].members[0], payee: `Batch page ${index}` }],
  txnDate: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
}));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = url.includes("/finance/transactions")
        ? [aggregate]
        : url.includes("/finance/deposit-batches")
          ? historyResponseMode
            ? { rows: manyHistory.slice(url.includes("offset=10") ? 10 : 0, url.includes("offset=10") ? 11 : 10), total: manyHistory.length, limit: 10, offset: url.includes("offset=10") ? 10 : 0, hasMore: !url.includes("offset=10") }
            : history
          : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  historyResponseMode = false;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderRegister() {
  const Wrapper = makeAuthWrapper("/finance/register", {
    user: { id: "admin-1", username: "admin", role: "admin", userType: "lab" } as never,
    status: "authed",
    restoreStatus: "ok",
  });
  return render(<RegisterPage />, { wrapper: Wrapper });
}

describe("aggregate deposit register details", () => {
  beforeEach(() => {
    cachedAccount = ACCOUNT;
    refreshState.failed = false;
  });
  it("preserves cached Undeposited Funds identity and forbids creation after a failed balance refresh", async () => {
    cachedAccount = { ...ACCOUNT, name: "Undeposited Funds", accountType: "undeposited_funds" };
    refreshState.failed = true;
    const { container } = renderRegister();
    await screen.findByTestId("balances-error");
    const add = screen.getByRole("button", { name: /Add entry/i });
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(screen.queryByTestId("inline-blank-row-0")).toBeNull();
    expect(container.querySelectorAll("thead th")).toHaveLength(10);
    expect(screen.queryByRole("button", { name: "Reconcile" })).toBeNull();
    expect(container.querySelector('[data-testid="register-balances"]')).not.toHaveTextContent("$175.00");
  });
  it("exposes no mutation controls when selected account identity is unavailable", async () => {
    cachedAccount = undefined;
    refreshState.failed = true;
    renderRegister();
    await screen.findByText(/selected account is unavailable/i);
    for (const name of [/Add entry/i, /Import CSV/i, /New transfer/i, /Reconcile/i, /Save entry/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
  it("keeps header, data rows and spanning cells on the 11-column shape", async () => {
    const { container } = renderRegister();
    await waitFor(() => expect(screen.getByText("Batch deposit")).toBeTruthy());
    const heads = Array.from(container.querySelectorAll("thead th")).map((t) => t.textContent?.replace(/\s+/g, "").trim());
    expect(heads.slice(0, 10)).toEqual(["Date", "Num", "Payee", "Account", "Category", "Payment", "Deposit", "✓", "Balance", "Memo"]);
    expect(heads).toHaveLength(11);
    expect(container.querySelectorAll("thead th")).toHaveLength(container.querySelectorAll("tbody > tr")[0].children.length);
    expect(container.querySelectorAll("colgroup col")).toHaveLength(11);
    expect(screen.getByTestId("register-heading").textContent).toContain("Bank Register");
  });
  it("shows one total row with split account and expands read-only grouped details", async () => {
    const { container } = renderRegister();
    await waitFor(() => expect(screen.getByText("Batch deposit")).toBeTruthy());

    const parent = screen.getByText("Batch deposit").closest("tr");
    expect(parent).toBeTruthy();
    expect(container.querySelectorAll("tbody > tr")).toHaveLength(1);
    expect(parent?.querySelector('[data-col-id="col-6"]')).toHaveTextContent("$175.00");
    expect(screen.getByText("–split–")).toBeTruthy();
    expect(screen.queryByText("Bright Practice")).toBeNull();

    fireEvent.click(screen.getByText("Batch deposit"));
    expect(screen.getByText("Deposit split details · read-only")).toBeTruthy();
    expect(screen.getByText("Bright Practice")).toBeTruthy();
    expect(screen.getByText("Unassigned")).toBeTruthy();
    expect(screen.getByText("$125.00")).toBeTruthy();
    expect(screen.getByText("$50.00")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make recurring" })).toBeNull();
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("expands multiple payments and exposes identifying details, then collapses", async () => {
    renderRegister();
    await waitFor(() => expect(screen.getByText("Batch deposit")).toBeTruthy());
    fireEvent.click(screen.getByText("Batch deposit"));
    fireEvent.click(screen.getByText("Bright Practice"));

    expect(screen.getByText(/Alice Customer/)).toBeTruthy();
    expect(screen.getByText(/Bob Customer/)).toBeTruthy();
    expect(screen.getAllByText("$50.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("$75.00").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByText(/Alice Customer/));
    expect(screen.getByText("Front desk payment")).toBeTruthy();
    expect(screen.getByText("Payment method:")).toBeTruthy();
    expect(screen.getByText(/check/)).toBeTruthy();
    expect(screen.getByText("RCPT-10")).toBeTruthy();
    expect(screen.getByText("stmt-10")).toBeTruthy();
    expect(screen.getByText("session-10")).toBeTruthy();
    expect(screen.getByText(/INV-100/)).toBeTruthy();

    fireEvent.click(screen.getByText("Batch deposit"));
    await waitFor(() => expect(screen.queryByText("Bright Practice")).toBeNull());
    expect(screen.queryByText("Alice Customer")).toBeNull();
  });
});

describe("deposit batch history", () => {
  it("shows active and released batches with time, expandable members, and no mutation controls", async () => {
    renderRegister();
    await waitFor(() => expect(screen.getByText("Active")).toBeTruthy());
    const historySection = screen.getByRole("region", { name: "Deposit batch history" });
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Corrected")).toBeTruthy();
    expect(screen.getByText(/Released .*?, .*:/)).toBeTruthy();
    expect(historySection.querySelector('button[aria-label="Delete"]')).toBeNull();
    expect(historySection.querySelector('button[aria-label="Void"]')).toBeNull();
    expect(screen.queryByText("Corrected Customer")).toBeNull();

    fireEvent.click(screen.getByText("Corrected").closest("button")!);
    expect(screen.getByText("Corrected Customer")).toBeTruthy();
    expect(screen.getByText("corrected")).toBeTruthy();
    expect(screen.getAllByText("$80.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Released .*?, .*:/).length).toBeGreaterThanOrEqual(2);
    expect(historySection.querySelector('button[aria-label="Save"]')).toBeNull();
  });

  it("loads the next bounded history page and appends it", async () => {
    historyResponseMode = true;
    renderRegister();
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy());
    const historySection = screen.getByRole("region", { name: "Deposit batch history" });
    expect(historySection.querySelectorAll("button[aria-expanded]")).toHaveLength(10);
    await fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(historySection.querySelectorAll("button[aria-expanded]")).toHaveLength(11));
    const requests = vi.mocked(fetch).mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/finance/deposit-batches"));
    expect(requests.some((url) => url.includes("offset=10"))).toBe(true);
  });

  it("resets page and removes old rows when the organization changes", async () => {
    const Wrapper = makeAuthWrapper("/finance/register", {
      user: { id: "admin-1", username: "admin", role: "admin", userType: "lab" } as never,
      status: "authed", restoreStatus: "ok",
    });
    const view = render(<DepositBatchHistory organizationId="org-1" />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Deposit batch history")).toBeTruthy());
    view.rerender(<DepositBatchHistory organizationId="org-2" />);
    await waitFor(() => {
      const requests = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
      expect(requests.some((url) => url.includes("organizationId=org-2") && url.includes("offset=0"))).toBe(true);
    });
    expect(screen.queryByText("Corrected Customer")).toBeNull();
  });
});