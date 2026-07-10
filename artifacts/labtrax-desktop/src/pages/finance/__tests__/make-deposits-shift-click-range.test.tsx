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
import { render, screen, fireEvent } from "@testing-library/react";
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
  invoiceLinks: [],
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
      if (path.endsWith("/finance/undeposited-funds")) return json(TXNS);
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
}

function checkbox(id: string): HTMLInputElement {
  return screen.getByLabelText(`Select payment ${id}`) as HTMLInputElement;
}

function selectedIds(): string[] {
  return ["txn-1", "txn-2", "txn-3", "txn-4", "txn-5"].filter(
    (id) => checkbox(id).checked,
  );
}

describe("Make Deposits shift-click range selection", () => {
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
});
